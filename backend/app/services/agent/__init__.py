"""Agent sessions: tasks the agent works on in the background (the Agent page).

* store.py   sessions and events in the database
* graph.py   the LangGraph graph: model, tools, one tool call per step
* runner.py  the background worker, limits, Stop, pauses

A session runs until it is done, fails, is stopped or reaches a limit, or
waits for the user: a question (``Ask_user``) or an approval before a
connector tool changes something. Answering queues it again.
See docs/services/agent.md.
"""
from typing import Optional

from langchain_core.messages import HumanMessage

from app.exceptions import ValidationError
from app.services.agent import graph as agent_graph
from app.services.agent import browser, runner, store

MAX_ANSWER_CHARS = 4000


def create(task: str) -> dict:
    session = store.create(task)
    runner.submit(session["id"])
    return session


def list_sessions() -> list[dict]:
    return store.list_sessions()


def get(session_id: str, after: int = 0) -> dict:
    session = store.get(session_id)
    return {**session, "events": store.events(session["id"], after)}


def rename(session_id: str, title: str) -> dict:
    return store.update(session_id, title=store.clean_title(title))


def _waiting(session_id: str, kind: str) -> dict:
    session = store.get(session_id)
    waiting = session["waiting"] or {}
    if session["status"] != "waiting" or waiting.get("kind") != kind:
        raise ValidationError("This session isn't waiting for that. Reload the page.")
    return session


def answer(session_id: str, text: str) -> dict:
    """Answer the agent's question; the session goes on."""
    text = str(text or "").strip()
    if not text:
        raise ValidationError("Answer: type a reply")
    session = _waiting(session_id, "question")
    text = text[:MAX_ANSWER_CHARS]
    store.add_event(session["id"], "answer", {"text": text})
    store.update(session["id"], status="queued", waiting=None)
    runner.submit(session["id"], runner.resume_value(text))
    return store.get(session["id"])


def decide(session_id: str, decision: str) -> dict:
    """Allow or deny the action the agent is waiting to take."""
    if decision not in ("allow", "deny"):
        raise ValidationError("Decision: allow or deny")
    session = _waiting(session_id, "approval")
    store.add_event(session["id"], "approval_done", {"decision": decision})
    store.update(session["id"], status="queued", waiting=None)
    runner.submit(session["id"], runner.resume_value(decision))
    return store.get(session["id"])


def answer_browser(session_id: str, request_id: str, answers: dict) -> None:
    """Answers to the browser's questions (logins, codes, choices): straight to the engine."""
    store.get(session_id)
    browser.answer_input(session_id, request_id, answers)


def stop(session_id: str) -> dict:
    session = store.get(session_id)
    if session["status"] == "running" or browser.waiting_for_input(session["id"]):
        # Running, or a browser tool waiting for answers inside the run: stop after it.
        runner.request_stop(session["id"])
        browser.cancel_input(session["id"])
        return session
    if session["status"] in ("queued", "waiting"):
        store.update(session["id"], status="stopped")
        store.add_event(session["id"], "status", {"status": "stopped", "reason": "Stopped."})
    return store.get(session["id"])


def continue_(session_id: str, message: Optional[str] = None) -> dict:
    """Go on after a stop, a limit, a failure or a restart; with ``message``,
    also give the agent a new instruction (also after it finished)."""
    session = store.get(session_id)
    if session["status"] in ("queued", "running"):
        raise ValidationError("The session is already working.")
    message = str(message or "").strip()[:store.MAX_TASK_CHARS]
    if session["status"] == "waiting":
        raise ValidationError("The session is waiting for you: answer it first.")

    # A pause still in the checkpoint (stopped while waiting): show it again.
    state = runner_state(session["id"])
    pause = runner._pause(state) if state is not None else None
    if pause:
        store.update(session["id"], status="waiting", waiting=pause)
        store.add_event(session["id"], pause["kind"], pause)
        return store.get(session["id"])

    if message:
        store.add_event(session["id"], "instruction", {"text": message})
        run_input = {"messages": [HumanMessage(content=message)],
                     "thread_id": agent_graph.thread_id(session["id"])}
    elif state is not None and not state.next:
        raise ValidationError("The session has finished. Add an instruction to continue.")
    else:
        run_input = None
    store.update(session["id"], status="queued", waiting=None)
    runner.submit(session["id"], run_input)
    return store.get(session["id"])


def runner_state(session_id: str):
    """The checkpointed graph state, or None when the session never ran."""
    graph = agent_graph.build([], "", runner._checkpointer(), model=_NoModel())
    state = graph.get_state(runner.config(session_id))
    return state if state.values else None


def delete(session_id: str) -> None:
    session = store.get(session_id)
    if session["status"] == "running" or browser.waiting_for_input(session["id"]):
        raise ValidationError("Stop the session before deleting it.")
    store.delete(session["id"])
    try:
        runner._checkpointer().delete_thread(agent_graph.thread_id(session["id"]))
    except Exception:  # noqa: BLE001 - the session row is gone; a stale checkpoint is harmless
        pass


class _NoModel:
    """Stand-in model for reading a session's state without building a real model."""

    def bind_tools(self, tools):
        return self


start = runner.start
shutdown = runner.shutdown
