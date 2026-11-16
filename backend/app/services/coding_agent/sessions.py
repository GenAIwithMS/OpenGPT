"""Coding sessions: create, list, rename, delete, and their message history.

The agent stores sessions and messages itself; nothing is copied into MySQL.
Every session request is checked against the project folders: a session the
agent knows about but whose folder is not a project (e.g. one made by hand
elsewhere) is treated as not found.

Messages are converted into a small format for the frontend:
    {"role": "user", "id", "text", "created"}
    {"role": "assistant", "id", "created", "parts": [...], "error"?}
        parts: {"type": "text"|"reasoning", "text"}
               {"type": "tool", "id", "name", "status", "input", "output", "error"?}
    {"role": "shell", "id", "command", "output", "exit", "created"}
    {"role": "status", "id", "outcome", "error"?, "created"}
"""
import logging
import re
from pathlib import Path
from typing import Any, Optional

from app.error_handlers import log_error
from app.exceptions import NotFoundError, ValidationError
from app.services.coding_agent import client, config, projects

logger = logging.getLogger(__name__)

# Agent session ids look like "ses_" + base62.
_SESSION_ID_RE = re.compile(r"^ses_[A-Za-z0-9]{8,64}$")

MAX_TITLE_CHARS = 100
MAX_TEXT_CHARS = 50_000      # one text part / tool output sent to the browser
MAX_INPUT_VALUE_CHARS = 5_000  # one tool input value
MAX_SESSIONS_LISTED = 100
MAX_MESSAGES = 200

# Permission rules for every session; the last matching rule wins and they
# come after the agent's defaults. "deny" can't be overridden by an approval.
PERMISSION_RULES = [
    # Look around the project freely.
    {"action": "read", "resource": "*", "effect": "allow"},
    {"action": "grep", "resource": "*", "effect": "allow"},
    {"action": "glob", "resource": "*", "effect": "allow"},
    {"action": "question", "resource": "*", "effect": "allow"},
    {"action": "skill", "resource": "*", "effect": "allow"},
    # Secrets files ask first.
    {"action": "read", "resource": "*.env", "effect": "ask"},
    {"action": "read", "resource": "*.env.*", "effect": "ask"},
    {"action": "read", "resource": "*.env.example", "effect": "allow"},
    # Changing files, running commands and going online ask first.
    {"action": "edit", "resource": "*", "effect": "ask"},
    {"action": "shell", "resource": "*", "effect": "ask"},
    {"action": "webfetch", "resource": "*", "effect": "ask"},
    {"action": "websearch", "resource": "*", "effect": "ask"},
    # Nothing outside the project folder.
    {"action": "external_directory", "resource": "*", "effect": "deny"},
]


# ----- checks -----

def validate_session_id(session_id: str) -> str:
    if not _SESSION_ID_RE.match(session_id or ""):
        raise ValidationError("Invalid session id")
    return session_id


def _project_of(directory: Optional[str]) -> Optional[str]:
    """The project name for an agent session folder, or None if it isn't a project."""
    if not directory:
        return None
    try:
        name = Path(directory).name
        return name if projects.project_path(name) == Path(directory).resolve(strict=True) else None
    except (NotFoundError, ValidationError, OSError, RuntimeError):
        return None


# ----- conversions -----

def _clip(text: Any, limit: int = MAX_TEXT_CHARS) -> str:
    text = text if isinstance(text, str) else ("" if text is None else str(text))
    return text if len(text) <= limit else text[:limit] + f"\n… ({len(text) - limit} more characters)"


def _session_info(raw: dict, project: str) -> dict:
    time = raw.get("time") or {}
    busy, idle = time.get("busy"), time.get("idle")
    return {
        "id": raw["id"],
        "project": project,
        "title": raw.get("title") or "New session",
        "created": time.get("created"),
        "updated": time.get("updated"),
        "busy": bool(busy and (not idle or busy > idle)),
        "outcome": raw.get("outcome"),
    }


def is_stop(error: Optional[dict]) -> bool:
    """The "error" the agent records when a turn is stopped on purpose."""
    return bool(error) and error.get("type") == "aborted"


def public_model_error(error: Optional[dict]) -> Optional[str]:
    """A safe, useful message for a model/agent error. Details are logged, not returned."""
    if not error or is_stop(error):
        return None
    status = error.get("status")
    text = f"{error.get('type', '')} {error.get('message', '')}".lower()
    if status in (401, 403) or "auth" in text or "api key" in text:
        message = "The model endpoint rejected the API key."
    elif status == 413 or "too large" in text or "context length" in text or "maximum context" in text:
        message = ("The request is larger than the model allows (its context size or tokens-per-minute "
                   "limit). The coding agent needs a model or plan with higher limits; see CODING_AGENT_MODEL.")
    elif status == 429 or "rate limit" in text:
        message = "The model's rate limit was reached. Try again shortly."
    elif status and status >= 500:
        message = "The model endpoint had an error. Try again shortly."
    else:
        message = "The model request failed."
    ref = log_error("Coding agent model error", RuntimeError(str(error)[:2000]))
    return f"{message} (ref {ref})"


def _tool_input(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): _tool_input(v) for k, v in list(value.items())[:50]}
    if isinstance(value, list):
        return [_tool_input(v) for v in value[:50]]
    if isinstance(value, str):
        return _clip(value, MAX_INPUT_VALUE_CHARS)
    return value


def _tool_part(part: dict) -> dict:
    state = part.get("state") or {}
    status = state.get("status") or "running"
    texts = [c.get("text", "") for c in state.get("content") or [] if c.get("type") == "text"]
    out = {
        "type": "tool",
        "id": part.get("id"),
        "name": part.get("name"),
        "status": status,
        "input": _tool_input(state.get("input")) if isinstance(state.get("input"), dict) else {},
        "output": _clip("\n".join(texts)),
    }
    if status == "error":
        # Tool errors are about the user's own code and commands (not provider
        # details), so their text is useful to show.
        err = state.get("error") or {}
        out["error"] = _clip(err.get("message") or "The tool failed.", 2000)
    return out


def convert_message(raw: dict) -> Optional[dict]:
    kind = raw.get("type")
    time = raw.get("time") or {}
    base = {"id": raw.get("id"), "created": time.get("created")}
    if kind == "user":
        return {**base, "role": "user", "text": _clip(raw.get("text"))}
    if kind == "assistant":
        parts = []
        for part in raw.get("content") or []:
            if part.get("type") in ("text", "reasoning"):
                parts.append({"type": part["type"], "text": _clip(part.get("text"))})
            elif part.get("type") == "tool":
                parts.append(_tool_part(part))
        message = {**base, "role": "assistant", "parts": parts}
        if raw.get("error") and not is_stop(raw["error"]):
            message["error"] = public_model_error(raw["error"])
        return message
    if kind == "shell":
        output = raw.get("output")
        if isinstance(output, dict):
            output = output.get("output") or ""
        return {**base, "role": "shell", "command": _clip(raw.get("command"), 5000),
                "output": _clip(output), "exit": raw.get("exit")}
    if kind == "idle":
        if raw.get("outcome") == "succeeded":
            return None  # only failed or stopped turns are worth showing
        message = {**base, "role": "status", "outcome": raw.get("outcome")}
        if raw.get("error") and not is_stop(raw["error"]):
            message["error"] = public_model_error(raw["error"])
        return message
    return None  # bookkeeping messages (model/agent switches, compaction, …)


def convert_messages(raw: list) -> list:
    """Oldest first; an idle message repeating the assistant's error is dropped."""
    messages = [m for m in (convert_message(r) for r in raw) if m is not None]
    out = []
    for m in messages:
        if (m["role"] == "status" and m.get("error") and out
                and out[-1]["role"] == "assistant" and out[-1].get("error")):
            continue
        out.append(m)
    return out


# ----- operations -----

async def _get_raw(session_id: str) -> tuple[dict, str, Path]:
    """The agent's session, its project name and folder; NotFoundError if not a project session."""
    validate_session_id(session_id)
    raw = (await client.call("GET", f"/api/session/{session_id}")).get("data") or {}
    directory = (raw.get("location") or {}).get("directory")
    project = _project_of(directory)
    if not project:
        raise NotFoundError("Session not found")
    return raw, project, projects.project_path(project)


async def get_session(session_id: str) -> dict:
    raw, project, _ = await _get_raw(session_id)
    return _session_info(raw, project)


async def list_sessions(project: str) -> list[dict]:
    directory = projects.project_path(project)
    body = await client.call(
        "GET", "/api/session", directory=directory,
        params={"directory": str(directory), "order": "desc", "limit": MAX_SESSIONS_LISTED, "parentID": "null"},
    )
    name = directory.name
    return [
        _session_info(s, name) for s in (body or {}).get("data") or []
        if (s.get("location") or {}).get("directory") == str(directory)
    ]


async def create_session(project: str, title: Optional[str] = None) -> dict:
    directory = projects.project_path(project)
    payload = {
        "location": {"directory": str(directory)},
        "model": {"providerID": config.PROVIDER_ID, "id": config.model_id()},
        "permissions": PERMISSION_RULES,
    }
    if title and title.strip():
        payload["title"] = title.strip()[:MAX_TITLE_CHARS]
    raw = (await client.call("POST", "/api/session", directory=directory, json=payload)).get("data") or {}
    return _session_info(raw, directory.name)


async def rename_session(session_id: str, title: str) -> dict:
    title = (title or "").strip()[:MAX_TITLE_CHARS]
    if not title:
        raise ValidationError("Title is required")
    _, _, directory = await _get_raw(session_id)
    # The agent answers a rename with an empty body; read the session back.
    await client.call("PATCH", f"/api/session/{session_id}", directory=directory, json={"title": title})
    return await get_session(session_id)


async def delete_session(session_id: str) -> None:
    _, _, directory = await _get_raw(session_id)
    await client.call("DELETE", f"/api/session/{session_id}", directory=directory)


async def session_messages(session_id: str) -> dict:
    raw, project, directory = await _get_raw(session_id)
    body = await client.call("GET", f"/api/session/{session_id}/message", directory=directory,
                             params={"order": "desc", "limit": MAX_MESSAGES})
    newest_first = (body or {}).get("data") or []
    return {"session": _session_info(raw, project), "messages": convert_messages(list(reversed(newest_first)))}
