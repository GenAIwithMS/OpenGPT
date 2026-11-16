"""Live coding turns: send a message to the agent and relay its progress.

`run_turn()` subscribes to the agent's event stream first (so nothing is
missed), sends the message, then turns the agent's events for this session
into a small set of events for the browser, until the turn ends:

    {"type": "start", "session": {...}}
    {"type": "text", "delta": "..."}            the reply, as it is written
    {"type": "reasoning", "delta": "..."}       the model's thinking
    {"type": "tool", "id", "name", "status": "running", "input": {...}}
    {"type": "tool", "id", "name", "status": "completed", "output": "..."}
    {"type": "tool", "id", "name", "status": "error", "error": "..."}
    {"type": "approval", "id", "action", "resources", "always", "diff"?, ...}  (see approvals.py)
    {"type": "approval_done", "id", "decision"}
    {"type": "title", "title": "..."}
    {"type": "error", "message": "..."}        safe text, details are logged
    {"type": "done", "outcome": "succeeded" | "failed" | "interrupted"}

If the browser disconnects, the agent keeps working; the session can be
reopened. `stop()` interrupts the turn.
"""
import asyncio
import json
import logging
from typing import AsyncIterator, Optional

import httpx

from app.error_handlers import log_error
from app.exceptions import ConflictError
from app.services import personalization
from app.services.coding_agent import approvals, client, sessions

logger = logging.getLogger(__name__)

# End the stream if the agent sends nothing (not even a heartbeat) for this long.
IDLE_TIMEOUT_SECONDS = 15 * 60
# Wait this long for the agent to confirm the event subscription.
CONNECT_TIMEOUT_SECONDS = 15

_FINISHED = {
    "session.execution.succeeded": "succeeded",
    "session.execution.failed": "failed",
    "session.execution.interrupted": "interrupted",
}

# Sessions with a turn streaming right now (one turn per session at a time).
_running: set[str] = set()


async def _agent_events(directory) -> AsyncIterator[Optional[dict]]:
    """The agent's events for a project folder. Yields None for heartbeats."""
    url, auth = client.require_agent()
    timeout = httpx.Timeout(connect=5.0, read=IDLE_TIMEOUT_SECONDS, write=10.0, pool=5.0)
    async with client._shared_client().stream(
        "GET", f"{url}/api/event", auth=auth, headers=client.headers_for(directory), timeout=timeout
    ) as response:
        if response.status_code != 200:
            raise RuntimeError(f"event stream answered {response.status_code}")
        data_lines: list[str] = []
        async for line in response.aiter_lines():
            if line.startswith("data:"):
                data_lines.append(line[5:].lstrip())
            elif line.startswith(":"):
                yield None  # heartbeat
            elif line == "" and data_lines:
                raw, data_lines = "\n".join(data_lines), []
                try:
                    yield json.loads(raw)
                except json.JSONDecodeError:
                    logger.warning("Coding agent sent an unreadable event")


class _Translator:
    """Agent events for one session -> browser events."""

    def __init__(self, session_id: str):
        self.session_id = session_id
        self.tool_names: dict[str, str] = {}
        self.outcome: Optional[str] = None
        self.error_sent = False

    def translate(self, event: dict) -> list[dict]:
        kind = event.get("type") or ""
        data = event.get("data") or {}
        if data.get("sessionID") != self.session_id:
            return []

        if kind == "session.text.delta":
            return [{"type": "text", "delta": data.get("delta", "")}]
        if kind == "session.reasoning.delta":
            return [{"type": "reasoning", "delta": data.get("delta", "")}]
        if kind in ("session.tool.input.started", "session.tool.called"):
            tool_id = data.get("id")
            name = data.get("name") or self.tool_names.get(tool_id)
            if name:
                self.tool_names[tool_id] = name
            if kind == "session.tool.input.started":
                return []
            return [{"type": "tool", "id": tool_id, "name": name, "status": "running",
                     "input": sessions._tool_input(data.get("input") or {})}]
        if kind == "session.tool.success":
            part = sessions._tool_part({"id": data.get("id"), "name": self.tool_names.get(data.get("id")),
                                        "state": {"status": "completed", "content": data.get("content")}})
            return [{k: part[k] for k in ("type", "id", "name", "status", "output")}]
        if kind == "session.tool.failed":
            part = sessions._tool_part({"id": data.get("id"), "name": self.tool_names.get(data.get("id")),
                                        "state": {"status": "error", "content": data.get("content"),
                                                  "error": data.get("error")}})
            return [{k: part[k] for k in ("type", "id", "name", "status", "output", "error")}]
        if kind == "permission.asked":
            return [{"type": "approval", **approvals.approval_info(data)}]
        if kind == "permission.replied":
            return [{"type": "approval_done", "id": data.get("requestID"), "decision": data.get("reply")}]
        if kind == "session.renamed":
            return [{"type": "title", "title": sessions._clip(data.get("title"), sessions.MAX_TITLE_CHARS)}]
        if kind in ("session.step.failed", "session.execution.failed") and data.get("error") \
                and not sessions.is_stop(data["error"]):
            if self.error_sent:  # the step and the turn report the same error
                return [] if kind == "session.step.failed" else self._finish(kind)
            self.error_sent = True
            message = {"type": "error", "message": sessions.public_model_error(data["error"])}
            return [message, *self._finish(kind)] if kind in _FINISHED else [message]
        if kind in _FINISHED:
            return self._finish(kind)
        return []

    def _finish(self, kind: str) -> list[dict]:
        self.outcome = _FINISHED[kind]
        return [{"type": "done", "outcome": self.outcome}]


def sse(event: dict) -> str:
    return f"data: {json.dumps(event)}\n\n"


async def run_turn(session_id: str, text: str) -> AsyncIterator[str]:
    """SSE text for one coding turn. Raises ConflictError before streaming if the session is busy."""
    raw, project, directory = await sessions._get_raw(session_id)
    info = sessions._session_info(raw, project)
    if session_id in _running or info["busy"]:
        raise ConflictError("This session is already working on something")
    return _relay(session_id, text, info, directory)


async def _relay(session_id: str, text: str, info: dict, directory) -> AsyncIterator[str]:
    # Claimed here, when streaming starts, so a stream that is never read
    # can't leave the session marked busy.
    if session_id in _running:
        yield sse({"type": "error", "message": "This session is already working on something."})
        yield sse({"type": "done", "outcome": "failed"})
        return
    _running.add(session_id)
    translator = _Translator(session_id)
    events = _agent_events(directory)
    try:
        yield sse({"type": "start", "session": info})

        # Subscribe before sending, so no event of this turn is missed.
        first = await asyncio.wait_for(anext(events), CONNECT_TIMEOUT_SECONDS)
        if first is not None and first.get("type") != "server.connected":
            for out in translator.translate(first):
                yield sse(out)

        await sync_profile(session_id, directory)
        await client.call("POST", f"/api/session/{session_id}/prompt", directory=directory,
                          json={"text": text})

        async for event in events:
            if event is None:
                yield ": keep-alive\n\n"
                continue
            for out in translator.translate(event):
                yield sse(out)
            if translator.outcome:
                break
        else:
            yield sse({"type": "error", "message": "The coding agent stopped sending updates."})
            yield sse({"type": "done", "outcome": "failed"})
    except asyncio.CancelledError:
        # The browser went away; the agent keeps working on the turn.
        logger.info("Coding stream for %s closed by the client", session_id)
        raise
    except Exception as e:
        ref = log_error(f"Coding turn failed for {session_id}", e)
        message = getattr(e, "message", None) if hasattr(e, "status_code") else None
        yield sse({"type": "error", "message": message or f"The coding agent failed. (ref {ref})"})
        yield sse({"type": "done", "outcome": "failed"})
    finally:
        _running.discard(session_id)
        await events.aclose()


PROFILE_ENTRY = "opengpt-profile"


async def sync_profile(session_id: str, directory) -> None:
    """Give the agent the current Personalization profile (or remove it when empty).

    The agent shows it to the model as session context and tells the model
    when it changed, so edits in Settings apply from the next message.
    """
    text = personalization.profile_text()
    try:
        await client.call(
            "PUT", f"/api/experimental/session/{session_id}/instructions/entries/{PROFILE_ENTRY}",
            directory=directory, json={"value": text or None},
        )
    except Exception as e:  # never block a turn on this
        logger.warning("Could not send the profile to the coding agent: %s", getattr(e, "message", e))


async def stop(session_id: str) -> dict:
    """Interrupt the session's current turn."""
    _, _, directory = await sessions._get_raw(session_id)
    body = await client.call("POST", f"/api/session/{session_id}/interrupt", directory=directory)
    return {"interrupted": bool((body or {}).get("interrupted"))}
