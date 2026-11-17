"""Connector (MCP server) tools for chat.

Chat runs synchronously; the MCP SDK is async. One background event loop
holds a live connection per connector that is on for chat. A connection is
opened on first use and kept while the connector's settings stay the same;
when they change (or its sign-in token is refreshed) it is reopened. Tool
calls from chat run on that loop.

Tools the server marks read-only run directly. Any other tool asks the user
in chat first (see chat_approvals).
"""
import asyncio
import hashlib
import json
import logging
import re
import tempfile
import threading
import time
from typing import Any, Optional

import httpx2
from langchain_core.tools import StructuredTool
from mcp import Client, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamable_http_client
from mcp_types import Implementation

from app.services import chat_approvals, connectors

logger = logging.getLogger(__name__)

CONNECT_TIMEOUT = 30       # seconds to wait for connections before a reply goes on without them
CALL_TIMEOUT = 120         # seconds per tool call
RETRY_AFTER = 60           # a failed connection is retried after this long
MAX_TOOLS_PER_SERVER = 100
MAX_RESULT_CHARS = 20_000
MAX_ARGS_SHOWN = 2_000

_loop: Optional[asyncio.AbstractEventLoop] = None
_loop_lock = threading.Lock()
_conns: dict[str, "_Connection"] = {}   # connector id -> connection; used only on the loop
_tasks: set = set()


# ---------------------------------------------------------------- event loop

def _get_loop() -> asyncio.AbstractEventLoop:
    global _loop
    with _loop_lock:
        if _loop is None or _loop.is_closed():
            loop = asyncio.new_event_loop()
            threading.Thread(target=loop.run_forever, name="mcp-connectors", daemon=True).start()
            _loop = loop
        return _loop


def _run(coro, timeout: float):
    return asyncio.run_coroutine_threadsafe(coro, _get_loop()).result(timeout)


def _reason(exc: BaseException) -> str:
    """The innermost error, readable (task groups wrap the real one)."""
    while isinstance(exc, BaseExceptionGroup) and exc.exceptions:
        exc = exc.exceptions[0]
    text = str(exc).strip() or type(exc).__name__
    return text[:300]


# ---------------------------------------------------------------- connections

def _fingerprint(spec: dict) -> str:
    return hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()


class _Connection:
    def __init__(self, spec: dict):
        self.spec = spec
        self.key = _fingerprint(spec)
        self.client: Optional[Client] = None
        self.tools: list = []
        self.error: Optional[str] = None
        self.failed_at = 0.0
        self.ready = asyncio.Event()
        self.stop = asyncio.Event()
        self.errlog = None  # a local server's error output, to explain a failed start

    def _transport(self, http: Optional[httpx2.AsyncClient]):
        if self.spec["kind"] == "local":
            command = self.spec["command"]
            params = StdioServerParameters(command=command[0], args=command[1:], env=self.spec.get("env") or None)
            self.errlog = tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace")
            return stdio_client(params, errlog=self.errlog)
        return streamable_http_client(self.spec["url"], http_client=http)

    def _server_said(self) -> str:
        """The last line the local server printed to its error output."""
        if self.errlog is None:
            return ""
        try:
            self.errlog.seek(0)
            lines = [line.strip() for line in self.errlog.read()[-4000:].splitlines() if line.strip()]
            return lines[-1][:300] if lines else ""
        except (OSError, ValueError):
            return ""

    async def run(self):
        http = None
        if self.spec["kind"] == "remote":
            http = httpx2.AsyncClient(headers=self.spec.get("headers") or {},
                                      timeout=httpx2.Timeout(30.0, read=CALL_TIMEOUT + 30))
        try:
            client = Client(self._transport(http), read_timeout_seconds=CALL_TIMEOUT,
                            client_info=Implementation(name="OpenGPT", version="1.0"))
            async with client:
                self.tools = await _list_tools(client)
                self.client = client
                self.error = None
                self.ready.set()
                await self.stop.wait()
        except Exception as e:  # noqa: BLE001 - any failure leaves the connector unavailable
            said = self._server_said()
            self.error = f"{_reason(e)}: {said}" if said else _reason(e)
            self.failed_at = time.time()
            logger.warning("Connector %s unavailable: %s", self.spec["name"], self.error)
        finally:
            self.client = None
            self.ready.set()
            if http is not None:
                await http.aclose()
            if self.errlog is not None:
                self.errlog.close()


async def _list_tools(client: Client) -> list:
    tools, cursor = [], None
    while len(tools) < MAX_TOOLS_PER_SERVER:
        page = await client.list_tools(cursor=cursor)
        tools.extend(page.tools)
        cursor = page.next_cursor
        if not cursor:
            break
    return tools[:MAX_TOOLS_PER_SERVER]


async def _sync(specs: list[dict]) -> list[_Connection]:
    """Open, keep, reopen or close connections to match ``specs``."""
    wanted = {s["id"]: s for s in specs}
    for cid, conn in list(_conns.items()):
        spec = wanted.get(cid)
        stale = spec is None or conn.key != _fingerprint(spec)
        retry = conn.ready.is_set() and conn.client is None and time.time() - conn.failed_at > RETRY_AFTER
        if stale or retry:
            conn.stop.set()
            del _conns[cid]
    for cid, spec in wanted.items():
        if cid not in _conns:
            conn = _conns[cid] = _Connection(spec)
            task = asyncio.create_task(conn.run())
            _tasks.add(task)
            task.add_done_callback(_tasks.discard)
    waiting = [c.ready.wait() for c in _conns.values() if not c.ready.is_set()]
    if waiting:
        await asyncio.wait([asyncio.create_task(w) for w in waiting], timeout=CONNECT_TIMEOUT)
    return [_conns[cid] for cid in wanted]


async def _call(connector_id: str, tool: str, args: dict):
    conn = _conns.get(connector_id)
    if conn is None or conn.client is None:
        raise RuntimeError("this connector isn't connected right now")
    return await conn.client.call_tool(tool, args, read_timeout_seconds=CALL_TIMEOUT)


# ---------------------------------------------------------------- tools

def _tool_name(server: str, tool: str, used: set) -> str:
    """server__tool, safe for every model API (letters, digits, _ and -, 64 max)."""
    base = re.sub(r"[^A-Za-z0-9_-]", "_", f"{server}__{tool}")[:64]
    name, n = base, 2
    while name in used:
        suffix = f"_{n}"
        name, n = base[: 64 - len(suffix)] + suffix, n + 1
    used.add(name)
    return name


def _result_text(result) -> str:
    parts = []
    for block in result.content or []:
        kind = getattr(block, "type", "")
        if kind == "text":
            parts.append(block.text)
        elif kind == "resource" and getattr(block.resource, "text", None):
            parts.append(block.resource.text)
        elif kind == "resource_link":
            parts.append(f"[{getattr(block, 'name', 'resource')}]({block.uri})")
        elif kind:
            parts.append(f"[{kind} content not shown]")
    if not parts and result.structured_content is not None:
        parts.append(json.dumps(result.structured_content, ensure_ascii=False))
    text = "\n".join(parts).strip() or "(no output)"
    if len(text) > MAX_RESULT_CHARS:
        text = text[:MAX_RESULT_CHARS] + f"\n… (cut: {len(text) - MAX_RESULT_CHARS} more characters)"
    if result.is_error:
        return f"The tool reported an error: {text}"
    return text


def _arguments_preview(args: dict) -> str:
    text = json.dumps(args, ensure_ascii=False, indent=2)
    return text if len(text) <= MAX_ARGS_SHOWN else text[:MAX_ARGS_SHOWN] + "\n…"


def _wrap(conn: _Connection, tool, used: set) -> StructuredTool:
    spec = conn.spec
    annotations = tool.annotations
    read_only = bool(annotations and annotations.read_only_hint)
    label = tool.title or (annotations.title if annotations and annotations.title else None) or tool.name
    schema = dict(tool.input_schema or {})
    schema.setdefault("type", "object")
    schema.setdefault("properties", {})

    def call(**args: Any) -> str:
        if not read_only:
            decision = chat_approvals.ask({
                "connector": spec["title"],
                "connector_id": spec["catalog_id"] or spec["name"],
                "tool": label,
                "description": (tool.description or "")[:400],
                "arguments": _arguments_preview(args),
                "destructive": bool(annotations is None or annotations.destructive_hint is not False),
            })
            if decision == "unavailable":
                return ("This tool needs the user's approval, which can only be given in a live chat. "
                        "Tell the user what you would do instead.")
            if decision != "allow":
                return "The user did not allow this action. Don't try it again; ask what they would like instead."
        try:
            return _result_text(_run(_call(spec["id"], tool.name, args), CALL_TIMEOUT + 10))
        except Exception as e:  # noqa: BLE001
            return f"Couldn't use {label} on {spec['title']}: {_reason(e)}"

    return StructuredTool.from_function(
        func=call,
        name=_tool_name(spec["name"], tool.name, used),
        description=f"[{spec['title']}] {tool.description or label}"[:1024],
        args_schema=schema,
    )


def chat_tools() -> list[StructuredTool]:
    """Tools from every connector that is on for chat (connecting as needed).
    Never raises: a connector that can't be reached is left out."""
    try:
        specs = connectors.chat_servers()
        if not specs and not _conns:
            return []
        conns = _run(_sync(specs), CONNECT_TIMEOUT + 5)
    except Exception as e:  # noqa: BLE001
        logger.warning("Connector tools unavailable: %s", _reason(e))
        return []
    used: set = set()
    return [_wrap(c, t, used) for c in conns if c.client is not None for t in c.tools]


def status() -> dict:
    """{connector id: {"connected": bool, "tools": n, "error": str|None}} for open connections."""
    async def snapshot():
        return {cid: {"connected": c.client is not None, "tools": len(c.tools), "error": c.error}
                for cid, c in _conns.items() if c.ready.is_set()}
    try:
        return _run(snapshot(), 5) if _loop is not None else {}
    except Exception:  # noqa: BLE001
        return {}


def warm() -> None:
    """Connect in the background so the next chat message doesn't wait."""
    threading.Thread(target=chat_tools, name="mcp-warm", daemon=True).start()


def close_all() -> None:
    """Close every connection (stops local servers). Used at shutdown."""
    if _loop is None:
        return

    async def stop():
        for conn in _conns.values():
            conn.stop.set()
        _conns.clear()
        if _tasks:
            await asyncio.wait(list(_tasks), timeout=10)

    try:
        _run(stop(), 15)
    except Exception:  # noqa: BLE001
        pass
