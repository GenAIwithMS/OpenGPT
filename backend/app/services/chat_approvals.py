"""Ask the user in chat before a connector tool may change something.

The tool runs inside the chat graph (a worker thread). It sends an
``approval`` event into the live stream and waits for the user's answer,
which arrives through ``POST /api/chat/approvals/{id}``. No answer within
the timeout, a stopped reply, or a run that can't show the question (no
live stream) all count as "no".
"""
import logging
import threading
import uuid
from typing import Optional

logger = logging.getLogger(__name__)

TIMEOUT_SECONDS = 300
DECISIONS = ("allow", "deny")

_pending: dict[str, dict] = {}
_lock = threading.Lock()


def ask(info: dict, timeout: float = TIMEOUT_SECONDS) -> str:
    """Show ``info`` to the user and wait. Returns "allow", "deny" or
    "unavailable" (this run has no live chat to ask in)."""
    from langgraph.config import get_config, get_stream_writer

    try:
        configurable = get_config().get("configurable", {})
        if not configurable.get("can_ask"):
            return "unavailable"
        writer = get_stream_writer()
    except (RuntimeError, KeyError):  # not running inside a chat graph
        return "unavailable"

    approval_id = uuid.uuid4().hex
    entry = {"event": threading.Event(), "decision": None, "thread": configurable.get("thread_id")}
    with _lock:
        _pending[approval_id] = entry
    try:
        writer({"type": "approval", "approval": {"id": approval_id, **info}})
        entry["event"].wait(timeout)
    finally:
        with _lock:
            _pending.pop(approval_id, None)
    decision = entry["decision"] or "deny"
    writer({"type": "approval_done", "id": approval_id, "decision": decision})
    return decision


def answer(approval_id: str, decision: str) -> bool:
    """Record the user's answer. False when nothing is waiting under that id."""
    if decision not in DECISIONS:
        raise ValueError("decision must be allow or deny")
    with _lock:
        entry = _pending.get(approval_id)
        if entry is None or entry["decision"] is not None:
            return False
        entry["decision"] = decision
    entry["event"].set()
    return True


def cancel_thread(thread_id: Optional[str]) -> int:
    """The reply was stopped: answer "no" to everything it is waiting on."""
    cancelled = 0
    with _lock:
        for entry in _pending.values():
            if entry["thread"] == thread_id and entry["decision"] is None:
                entry["decision"] = "deny"
                entry["event"].set()
                cancelled += 1
    return cancelled
