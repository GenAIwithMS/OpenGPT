"""Agent sessions and their events in the database.

A session row holds the task and status; events are what the session page
shows, in order (``seq`` counts from 1 per session). The agent's conversation
itself is a LangGraph checkpoint (see graph.py), not stored here.
"""
import json
import threading
import uuid
from typing import Any, Optional

from sqlalchemy.sql import func

from app.database import DatabaseConfig
from app.database.models import AgentEvent, AgentSession
from app.exceptions import NotFoundError, ValidationError

STATUSES = ("queued", "running", "waiting", "done", "failed", "stopped", "interrupted")
ACTIVE = ("queued", "running")          # the worker owns these
MAX_TITLE_CHARS = 200
MAX_TASK_CHARS = 20_000
MAX_EVENT_TEXT = 8_000                  # a tool result shown on the page is cut here

_lock = threading.Lock()                # one writer at a time for event numbers


def _session():
    return DatabaseConfig.get_session_factory()()


def valid_id(session_id: str) -> str:
    try:
        return str(uuid.UUID(str(session_id)))
    except (ValueError, AttributeError, TypeError):
        raise NotFoundError("Agent session not found")


def _info(row: AgentSession) -> dict:
    return {
        "id": row.id,
        "title": row.title,
        "task": row.task,
        "status": row.status,
        "waiting": json.loads(row.waiting) if row.waiting else None,
        "result": row.result,
        "error": row.error,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def clean_title(title: str) -> str:
    title = " ".join(str(title or "").split())
    if not title:
        raise ValidationError("Title: enter a name")
    return title[:MAX_TITLE_CHARS]


def title_from_task(task: str) -> str:
    first = " ".join(task.split())
    return first if len(first) <= 80 else first[:77].rstrip() + "..."


def create(task: str) -> dict:
    task = str(task or "").strip()
    if not task:
        raise ValidationError("Task: describe what the agent should do")
    if len(task) > MAX_TASK_CHARS:
        raise ValidationError(f"Task: at most {MAX_TASK_CHARS} characters")
    session_id = str(uuid.uuid4())
    with _session() as db:
        db.add(AgentSession(id=session_id, title=title_from_task(task), task=task, status="queued"))
        db.commit()
    add_event(session_id, "task", {"text": task})
    return get(session_id)


def get(session_id: str) -> dict:
    session_id = valid_id(session_id)
    with _session() as db:
        row = db.get(AgentSession, session_id)
        if not row:
            raise NotFoundError("Agent session not found")
        return _info(row)


def list_sessions() -> list[dict]:
    with _session() as db:
        rows = db.query(AgentSession).order_by(AgentSession.updated_at.desc(), AgentSession.created_at.desc()).all()
        return [_info(r) for r in rows]


def with_status(*statuses: str) -> list[str]:
    with _session() as db:
        return [r.id for r in db.query(AgentSession.id).filter(AgentSession.status.in_(statuses))
                .order_by(AgentSession.created_at).all()]


def update(session_id: str, **fields: Any) -> dict:
    """Change status, waiting, result, error or title."""
    session_id = valid_id(session_id)
    with _session() as db:
        row = db.get(AgentSession, session_id)
        if not row:
            raise NotFoundError("Agent session not found")
        for key, value in fields.items():
            if key == "waiting":
                value = json.dumps(value, ensure_ascii=False) if value is not None else None
            elif key == "error" and value:
                value = str(value)[:500]
            setattr(row, key, value)
        db.commit()
        return _info(row)


def delete(session_id: str) -> None:
    session_id = valid_id(session_id)
    with _session() as db:
        db.query(AgentEvent).filter_by(session_id=session_id).delete(synchronize_session=False)
        if not db.query(AgentSession).filter_by(id=session_id).delete(synchronize_session=False):
            raise NotFoundError("Agent session not found")
        db.commit()


def _short(value: Any) -> Any:
    if isinstance(value, str) and len(value) > MAX_EVENT_TEXT:
        return value[:MAX_EVENT_TEXT] + f"\n… ({len(value) - MAX_EVENT_TEXT} more characters)"
    return value


def add_event(session_id: str, kind: str, data: Optional[dict] = None) -> dict:
    data = {k: _short(v) for k, v in (data or {}).items()}
    with _lock, _session() as db:
        last = (db.query(AgentEvent.seq).filter_by(session_id=session_id)
                .order_by(AgentEvent.seq.desc()).first())
        seq = (last[0] if last else 0) + 1
        db.add(AgentEvent(session_id=session_id, seq=seq, type=kind,
                          data=json.dumps(data, ensure_ascii=False, default=str)))
        # The list shows the session with the latest activity first.
        db.query(AgentSession).filter_by(id=session_id).update(
            {AgentSession.updated_at: func.current_timestamp()}, synchronize_session=False)
        db.commit()
    return {"seq": seq, "type": kind, "data": data}


def events(session_id: str, after: int = 0, limit: int = 500) -> list[dict]:
    session_id = valid_id(session_id)
    with _session() as db:
        rows = (db.query(AgentEvent).filter(AgentEvent.session_id == session_id, AgentEvent.seq > after)
                .order_by(AgentEvent.seq).limit(limit).all())
        return [{"seq": r.seq, "type": r.type, "data": json.loads(r.data) if r.data else {},
                 "at": r.created_at.isoformat() if r.created_at else None} for r in rows]
