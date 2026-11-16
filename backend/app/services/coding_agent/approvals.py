"""Approvals: answering the coding agent when it asks before acting.

The agent asks before editing files, running commands, going online or
reading secrets files (see sessions.PERMISSION_RULES). Each request can be
answered:

    once    allow this one action
    always  allow it, and actions like it, from now on in this project
    reject  refuse it (optionally telling the agent why)

"Always" approvals are saved by the agent for the project, so they can be
listed and revoked here. Actions outside the project folder are refused by a
rule that no approval can override.

An approval sent to the browser:
    {"id", "action", "resources": [...], "always": "what 'always' would allow",
     "message"?, "files"?: [{"file", "status", "additions", "deletions"}], "diff"?}
"""
import re
from typing import Any, Optional

from app.exceptions import NotFoundError, ValidationError
from app.services.coding_agent import client, projects, sessions

_REQUEST_ID_RE = re.compile(r"^per_[A-Za-z0-9]{8,64}$")
_SAVED_ID_RE = re.compile(r"^psv_[A-Za-z0-9]{8,64}$")
DECISIONS = ("once", "always", "reject")
MAX_DIFF_CHARS = 50_000
MAX_REASON_CHARS = 2000

_ACTION_NAMES = {
    "edit": "file edits",
    "shell": "commands",
    "read": "reading",
    "webfetch": "opening web pages",
    "websearch": "web searches",
    "external_directory": "access outside the project",
}


def always_summary(action: str, save: Optional[list]) -> str:
    """Plain words for what an "always" answer would allow."""
    what = _ACTION_NAMES.get(action, action)
    patterns = [p for p in (save or []) if isinstance(p, str)]
    if not patterns or patterns == ["*"]:
        return f"all {what} in this project"
    if action == "shell":
        prefixes = [p[:-2] if p.endswith(" *") else p for p in patterns]
        return "commands starting with " + ", ".join(f"`{p}`" for p in prefixes[:5])
    return f"{what} matching " + ", ".join(f"`{p}`" for p in patterns[:5])


def approval_info(raw: dict) -> dict:
    """An agent permission request in the browser's format."""
    action = str(raw.get("action") or "")
    out = {
        "id": raw.get("id"),
        "action": action,
        "resources": [sessions._clip(r, 2000) for r in (raw.get("resources") or [])[:20]],
        "always": always_summary(action, raw.get("save")),
    }
    if raw.get("message"):
        out["message"] = sessions._clip(raw["message"], 2000)
    metadata: Any = raw.get("metadata") or {}
    files = metadata.get("files") if isinstance(metadata, dict) else None
    if isinstance(files, list) and files:
        out["files"] = [
            {"file": f.get("file"), "status": f.get("status"),
             "additions": f.get("additions"), "deletions": f.get("deletions")}
            for f in files[:50] if isinstance(f, dict)
        ]
        diff = "\n".join(f.get("patch", "") for f in files if isinstance(f, dict))
        if diff.strip():
            out["diff"] = sessions._clip(diff, MAX_DIFF_CHARS)
    elif isinstance(metadata, dict) and isinstance(metadata.get("diff"), str) and metadata["diff"].strip():
        out["diff"] = sessions._clip(metadata["diff"], MAX_DIFF_CHARS)
    return out


def _check_request_id(request_id: str) -> str:
    if not _REQUEST_ID_RE.match(request_id or ""):
        raise ValidationError("Invalid approval id")
    return request_id


def _data_list(body: Any) -> list:
    data = (body or {}).get("data") if isinstance(body, dict) else body
    return data if isinstance(data, list) else []


async def pending(session_id: str) -> list[dict]:
    """Approvals the session is waiting for (e.g. after reopening a page)."""
    _, _, directory = await sessions._get_raw(session_id)
    body = await client.call("GET", f"/api/session/{session_id}/permission", directory=directory)
    return [approval_info(r) for r in _data_list(body) if r.get("sessionID", session_id) == session_id]


async def reply(session_id: str, request_id: str, decision: str, reason: Optional[str] = None) -> None:
    """Answer one approval of this session."""
    if decision not in DECISIONS:
        raise ValidationError("Decision must be once, always or reject")
    _check_request_id(request_id)
    _, _, directory = await sessions._get_raw(session_id)
    # The request must belong to this session (the agent checks too).
    waiting = await client.call("GET", f"/api/session/{session_id}/permission", directory=directory)
    if not any(r.get("id") == request_id for r in _data_list(waiting)):
        raise NotFoundError("Approval not found or already answered")
    payload: dict = {"decision": decision}
    if decision == "reject" and reason and reason.strip():
        payload["message"] = reason.strip()[:MAX_REASON_CHARS]
    await client.call("POST", f"/api/session/{session_id}/permission/{request_id}/reply",
                      directory=directory, json=payload)


# ----- saved "always" approvals -----

async def _agent_project_id(project: str):
    directory = projects.project_path(project)
    location = await client.call("GET", "/api/location", directory=directory)
    project_id = ((location or {}).get("project") or {}).get("id")
    if not project_id:
        raise NotFoundError("Project not found")
    return project_id, directory


async def list_saved(project: str) -> list[dict]:
    """The project's saved "always" approvals."""
    project_id, directory = await _agent_project_id(project)
    body = await client.call("GET", "/api/permission/saved", directory=directory,
                             params={"projectID": project_id})
    return [
        {"id": s.get("id"), "action": s.get("action"), "resource": sessions._clip(s.get("resource"), 2000),
         "allows": always_summary(str(s.get("action") or ""), [s.get("resource")]),
         "created": (s.get("time") or {}).get("created")}
        for s in _data_list(body) if s.get("projectID") == project_id
    ]


async def revoke_saved(project: str, saved_id: str) -> None:
    """Remove one saved approval of this project."""
    if not _SAVED_ID_RE.match(saved_id or ""):
        raise ValidationError("Invalid approval id")
    if not any(s["id"] == saved_id for s in await list_saved(project)):
        raise NotFoundError("Saved approval not found")
    _, directory = await _agent_project_id(project)
    await client.call("DELETE", f"/api/permission/saved/{saved_id}", directory=directory)
