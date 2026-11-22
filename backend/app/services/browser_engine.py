"""Start the browser engine (backend/browser_engine, Node) with OpenGPT's model provider.

The engine builds website tools with two models: the **build** model and the
**review** model (Settings > Models: "Browser build" and "Browser review",
or BROWSER_BUILD_MODEL / BROWSER_REVIEW_MODEL; both default to the chat
model). Their provider is the active one, sent to the engine as JSON on a
pipe (file descriptor in BROWSER_ENGINE_CONFIG_FD), so the API key is never on
a command line, in the environment or in a file.

API per provider:
    OpenAI itself (no base URL, or api.openai.com)  -> "responses" (everything the engine uses)
    any other OpenAI-compatible endpoint            -> "chat"
    Anthropic or an Anthropic-compatible endpoint   -> "anthropic"

For developers, to try a build from the terminal:
    python -m app.services.browser_engine mint --url https://example.com \\
        --intent "Read the main heading" --out /tmp/heading --effect read
"""
import itertools
import json
import logging
import os
import queue
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Optional

from app import llm

logger = logging.getLogger(__name__)

ENGINE_DIR = Path(__file__).resolve().parents[2] / "browser_engine"
CLI = ENGINE_DIR / "dist" / "typescript" / "src" / "standalone" / "cli.js"
MCP_CLI = ENGINE_DIR / "dist" / "typescript" / "src" / "standalone" / "mcp-cli.js"
MIN_NODE_MAJOR = 24


class EngineUnavailable(RuntimeError):
    """The engine can't start here; the message says what is missing."""


def api_for(provider: str, base_url: Optional[str]) -> str:
    if provider == llm.ANTHROPIC:
        return "anthropic"
    if not base_url or "api.openai.com" in base_url:
        return "responses"
    return "chat"


def config() -> dict:
    """The engine's model configuration from the active provider (contains the API key)."""
    cfg = llm.settings()
    out = {
        "api": api_for(cfg["provider"], cfg["base_url"]),
        "buildModel": cfg["browser_build_model"],
        "reviewModel": cfg["browser_review_model"],
    }
    if cfg["api_key"] and cfg["api_key"] != "not-needed":
        out["apiKey"] = cfg["api_key"]
    if cfg["base_url"]:
        out["baseUrl"] = cfg["base_url"]
    context = llm.env("BROWSER_CONTEXT_TOKENS")
    if context:
        out["contextTokens"] = int(context)
    if (llm.env("BROWSER_REASONING_EFFORT") or "").lower() in ("1", "true", "yes", "on"):
        out["reasoningEffort"] = True
    return out


def node_path() -> str:
    """Node 24 for the engine: BROWSER_ENGINE_NODE, or node on PATH."""
    node = llm.env("BROWSER_ENGINE_NODE") or shutil.which("node")
    if not node:
        raise EngineUnavailable("Node.js 24 is needed for the browser engine. Install it, or set BROWSER_ENGINE_NODE.")
    try:
        version = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=10).stdout.strip()
        major = int(version.lstrip("v").split(".")[0])
    except (OSError, ValueError, subprocess.TimeoutExpired):
        raise EngineUnavailable(f"Couldn't run {node}. Set BROWSER_ENGINE_NODE to a Node.js 24 binary.")
    if major != MIN_NODE_MAJOR:
        raise EngineUnavailable(f"The browser engine needs Node.js 24; {node} is {version}. "
                                "Set BROWSER_ENGINE_NODE to a Node.js 24 binary.")
    return node


def check() -> None:
    """Raise EngineUnavailable with what is missing (Node 24, a built engine)."""
    node_path()
    if not CLI.exists():
        raise EngineUnavailable("The browser engine isn't built. Run: cd backend/browser_engine && "
                                "pnpm install --frozen-lockfile && pnpm build")


def start(entry: Path, args: list[str], **popen) -> subprocess.Popen:
    """Start an engine entry point with the model configuration on a pipe."""
    check()
    read_fd, write_fd = os.pipe()
    try:
        env = {**os.environ, "BROWSER_ENGINE_CONFIG_FD": str(read_fd), "BROWSER_ENGINE_LOG_MODEL_ERRORS": "1"}
        env.pop("OPENAI_API_KEY", None)  # the engine uses the configuration, nothing else
        process = subprocess.Popen([node_path(), str(entry), *args], env=env, pass_fds=(read_fd,),
                                   cwd=str(ENGINE_DIR), **popen)
    finally:
        os.close(read_fd)
    with os.fdopen(write_fd, "w") as pipe:
        json.dump(config(), pipe)
    return process


class EngineError(RuntimeError):
    """The engine process failed or answered with an error."""


class EngineClient:
    """A minimal MCP client over the engine's stdin/stdout (newline-delimited JSON-RPC).

    One client is one engine process: ``mint`` mode builds tools, ``serve`` mode runs one saved
    tool. Calls are synchronous (the agent's tools run in a worker thread).
    """

    def __init__(self, args: list[str]):
        self.process = start(MCP_CLI, args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True, bufsize=1)
        self._ids = itertools.count(1)
        self._replies: "queue.Queue[dict]" = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._log_stderr, daemon=True).start()
        self._request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                     "clientInfo": {"name": "opengpt", "version": "1"}}, timeout=60)
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def _read(self):
        for line in self.process.stdout:
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if "id" in message and ("result" in message or "error" in message):
                self._replies.put(message)
        self._replies.put({"closed": True})

    def _log_stderr(self):
        for line in self.process.stderr:
            line = line.strip()
            if line and "ExperimentalWarning" not in line and "--trace-warnings" not in line:
                logger.warning("Browser engine: %s", line[:500])

    def _send(self, message: dict):
        try:
            self.process.stdin.write(json.dumps(message) + "\n")
            self.process.stdin.flush()
        except (BrokenPipeError, OSError) as e:
            raise EngineError("The browser engine stopped.") from e

    def _request(self, method: str, params: dict, timeout: float = 120) -> dict:
        request_id = next(self._ids)
        self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        while True:
            try:
                reply = self._replies.get(timeout=timeout)
            except queue.Empty:
                raise EngineError("The browser engine didn't answer in time.")
            if reply.get("closed"):
                raise EngineError("The browser engine stopped.")
            if reply.get("id") == request_id:
                if "error" in reply:
                    raise EngineError(str(reply["error"].get("message", "engine error"))[:500])
                return reply["result"]

    def call(self, tool: str, arguments: dict, timeout: float = 120) -> dict:
        """Call a tool; returns its JSON result (a job view or a tool's output)."""
        result = self._request("tools/call", {"name": tool, "arguments": arguments}, timeout=timeout)
        text = "".join(part.get("text", "") for part in result.get("content", []) if part.get("type") == "text")
        try:
            value: Any = result.get("structuredContent") or json.loads(text)
        except ValueError:
            value = {"text": text}
        if result.get("isError") and isinstance(value, dict):
            value = {**value, "is_error": True}
        elif result.get("isError"):
            value = {"is_error": True, "text": text}
        return value

    def close(self):
        try:
            self.process.stdin.close()
        except OSError:
            pass
        try:
            self.process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.process.kill()


_available: Optional[str] = None


def unavailable_reason(refresh: bool = False) -> Optional[str]:
    """None when the engine can run here, else what is missing (checked once)."""
    global _available
    if _available is None or refresh:
        try:
            check()
            _available = ""
        except EngineUnavailable as e:
            _available = str(e)
    return _available or None


if __name__ == "__main__":  # python -m app.services.browser_engine <cli args>
    try:
        sys.exit(start(CLI, sys.argv[1:]).wait())
    except EngineUnavailable as e:
        sys.exit(str(e))
