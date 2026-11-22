"""Runs agent sessions in the background, one at a time.

One worker thread takes sessions from a queue. A run streams the graph step
by step, writing an event for each model message, tool call and result, and
checks after every step whether the user pressed Stop or a limit was reached.
When the graph pauses for the user (a question or an approval) the session
becomes ``waiting`` and the worker moves on; the answer queues it again and
the graph resumes where it paused.

At startup, sessions that were running become ``interrupted`` (Continue
resumes them from their last saved step) and queued ones are queued again.
Waiting sessions stay waiting: their pause is in the checkpoint.
"""
import logging
import os
import queue
import threading
import time
from typing import Any, Optional

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.types import Command

from app.error_handlers import log_error, public_error
from app.exceptions import NotFoundError
from app.services.agent import graph as agent_graph
from app.services.agent import store

logger = logging.getLogger(__name__)


def _int_env(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name) or default))
    except ValueError:
        return default


MAX_STEPS = _int_env("AGENT_MAX_STEPS", 50)        # model calls per run
MAX_MINUTES = _int_env("AGENT_MAX_MINUTES", 30)    # per run
RECURSION_LIMIT = 10_000                           # the step limit above is what stops a run

_queue: "queue.Queue[tuple[str, Any]]" = queue.Queue()
_stop_requests: set[str] = set()
_lock = threading.Lock()
_worker: Optional[threading.Thread] = None
_shutdown = threading.Event()

# Tests replace these: (tools, system prompt) builder, checkpointer and model.
build_tools_and_prompt = agent_graph.build_tools_and_prompt
checkpointer = None
model = None


def _checkpointer():
    if checkpointer is not None:
        return checkpointer
    from app.services.chatbot import check_pointer
    return check_pointer


def config(session_id: str) -> dict:
    return {"configurable": {"thread_id": agent_graph.thread_id(session_id), "agent_session": session_id},
            "recursion_limit": RECURSION_LIMIT}


# ---------------------------------------------------------------- queue

def recover() -> None:
    """After a restart: running sessions become interrupted, queued ones are queued again."""
    for session_id in store.with_status("running"):
        store.update(session_id, status="interrupted")
        store.add_event(session_id, "status", {"status": "interrupted",
                                               "reason": "OpenGPT stopped while this session was running."})
    # Questions from the browser can't be answered after a restart: the browser is gone.
    for session_id in store.with_status("waiting"):
        if (store.get(session_id)["waiting"] or {}).get("kind") == "browser_input":
            store.update(session_id, status="interrupted", waiting=None)
            store.add_event(session_id, "status", {"status": "interrupted",
                                                   "reason": "OpenGPT stopped while the browser was waiting for you."})
    for session_id in store.with_status("queued"):
        _queue.put((session_id, None))


def start() -> None:
    """Recover sessions from the last run and start the worker."""
    global _worker
    recover()
    with _lock:
        if _worker is None or not _worker.is_alive():
            _shutdown.clear()
            _worker = threading.Thread(target=_work, name="agent-runner", daemon=True)
            _worker.start()


def shutdown() -> None:
    _shutdown.set()
    _queue.put(("", None))


def submit(session_id: str, run_input: Any = None) -> None:
    """Queue a run. ``run_input``: None continues from the checkpoint (or
    starts the task), a Command resumes a pause, a dict adds messages."""
    _queue.put((session_id, run_input))


def request_stop(session_id: str) -> None:
    with _lock:
        _stop_requests.add(session_id)


def stop_requested(session_id: str) -> bool:
    """Whether Stop was pressed (a long tool checks this without clearing it)."""
    with _lock:
        return session_id in _stop_requests


def _take_stop(session_id: str) -> bool:
    with _lock:
        if session_id in _stop_requests:
            _stop_requests.discard(session_id)
            return True
        return False


def _work() -> None:
    while not _shutdown.is_set():
        session_id, run_input = _queue.get()
        if _shutdown.is_set() or not session_id:
            break
        try:
            run(session_id, run_input)
        except Exception:  # noqa: BLE001 - one session must not stop the worker
            logger.exception("Agent session %s failed", session_id)


# ---------------------------------------------------------------- one run

def _label(name: str) -> str:
    return name.replace("__", ": ").replace("_", " ")


def _record(session_id: str, node: str, update: dict) -> int:
    """Write events for one graph step. Returns how many model calls it was."""
    model_calls = 0
    for message in (update or {}).get("messages", []):
        if isinstance(message, AIMessage):
            model_calls += 1
            text = message.content if isinstance(message.content, str) else "".join(
                p.get("text", "") for p in message.content if isinstance(p, dict))
            if text.strip() and message.tool_calls:
                store.add_event(session_id, "message", {"text": text.strip()})
            for call in message.tool_calls or []:
                if call["name"] not in agent_graph.OWN_TOOLS:
                    store.add_event(session_id, "tool_call", {"id": call["id"], "name": call["name"],
                                                               "label": _label(call["name"]), "args": call["args"]})
        elif isinstance(message, ToolMessage) and message.name not in agent_graph.OWN_TOOLS:
            store.add_event(session_id, "tool_result", {"id": message.tool_call_id, "name": message.name,
                                                         "text": str(message.content),
                                                         "error": message.status == "error"})
    return model_calls


def _pause(state) -> Optional[dict]:
    """The pause the graph is waiting on, as {"kind": "question"|"approval", ...}."""
    for task in state.tasks or ():
        for item in task.interrupts or ():
            value = dict(item.value or {})
            kind = value.pop("type", "question")
            return {"kind": kind, "id": getattr(item, "id", None) or task.id, **value}
    return None


def _final_text(messages: list) -> str:
    for message in reversed(messages):
        if isinstance(message, AIMessage) and not message.tool_calls:
            content = message.content
            return content if isinstance(content, str) else "".join(
                p.get("text", "") for p in content if isinstance(p, dict))
    return ""


def run(session_id: str, run_input: Any = None) -> None:
    try:
        session = store.get(session_id)
    except NotFoundError:
        return  # deleted while it waited in the queue
    if session["status"] != "queued":
        return  # stopped or deleted while it waited in the queue
    _take_stop(session_id)  # a Stop pressed before this run started was handled by the caller
    cfg = config(session_id)
    thread = agent_graph.thread_id(session_id)
    tools, system_text = build_tools_and_prompt(thread)
    graph = agent_graph.build(tools, system_text, _checkpointer(), model=model)

    if run_input is None:
        existing = graph.get_state(cfg)
        if not existing.values.get("messages"):
            run_input = {"messages": [HumanMessage(content=session["task"])], "thread_id": thread}

    store.update(session_id, status="running", waiting=None, error=None)
    store.add_event(session_id, "status", {"status": "running"})
    started, steps, ended = time.monotonic(), 0, None
    try:
        for chunk in graph.stream(run_input, cfg, stream_mode="updates"):
            for node, update in chunk.items():
                if node != "__interrupt__":
                    steps += _record(session_id, node, update)
            if _take_stop(session_id):
                ended = ("stopped", "Stopped.")
                break
            if steps >= MAX_STEPS:
                ended = ("stopped", f"Reached the limit of {MAX_STEPS} steps. Continue to let it work longer.")
                break
            if time.monotonic() - started > MAX_MINUTES * 60:
                ended = ("stopped", f"Reached the limit of {MAX_MINUTES} minutes. Continue to let it work longer.")
                break
    except Exception as e:  # noqa: BLE001
        message = public_error(log_error(f"Agent session {session_id}", e), e)
        store.update(session_id, status="failed", error=message)
        store.add_event(session_id, "status", {"status": "failed", "reason": message})
        return

    if ended:
        store.update(session_id, status=ended[0])
        store.add_event(session_id, "status", {"status": ended[0], "reason": ended[1]})
        return

    state = graph.get_state(cfg)
    pause = _pause(state)
    if pause:
        store.update(session_id, status="waiting", waiting=pause)
        store.add_event(session_id, pause["kind"], pause)
        store.add_event(session_id, "status", {"status": "waiting"})
        return

    result = _final_text(state.values.get("messages", []))
    store.update(session_id, status="done", result=result)
    store.add_event(session_id, "result", {"text": result})
    store.add_event(session_id, "status", {"status": "done"})


def resume_value(answer: Any) -> Command:
    return Command(resume=answer)
