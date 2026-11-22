"""Agent routes (/api/agent): background tasks, their events, answers and approvals."""
from typing import Literal, Optional

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from app.services import agent
from app.services.agent import schedules, store

agent_router = APIRouter()


class NewSession(BaseModel):
    task: str = Field(..., max_length=store.MAX_TASK_CHARS)


class Rename(BaseModel):
    title: str = Field(..., max_length=store.MAX_TITLE_CHARS)


class Answer(BaseModel):
    text: str = Field(..., max_length=agent.MAX_ANSWER_CHARS)


class Decision(BaseModel):
    decision: Literal["allow", "deny"]


class BrowserAnswers(BaseModel):
    request_id: str = Field(..., max_length=64)
    answers: dict


class ScheduleBody(BaseModel):
    task: Optional[str] = Field(None, max_length=store.MAX_TASK_CHARS)
    title: Optional[str] = Field(None, max_length=store.MAX_TITLE_CHARS)
    repeat: Optional[Literal["once", "daily", "weekly", "cron"]] = None
    time: Optional[str] = Field(None, max_length=5)
    date: Optional[str] = Field(None, max_length=10)
    days: Optional[list[int]] = None
    cron: Optional[str] = Field(None, max_length=100)
    timezone: Optional[str] = Field(None, max_length=64)
    enabled: Optional[bool] = None


class Continue(BaseModel):
    message: Optional[str] = Field(None, max_length=store.MAX_TASK_CHARS)


@agent_router.get("/agent/sessions")
def list_sessions():
    """All sessions, latest activity first."""
    return {"sessions": agent.list_sessions()}


@agent_router.post("/agent/sessions", status_code=201)
def create_session(body: NewSession):
    """Start a task. It runs in the background; poll the session for events."""
    return agent.create(body.task)


@agent_router.get("/agent/sessions/{session_id}")
def get_session(session_id: str, after: int = Query(0, ge=0)):
    """The session and its events after ``after`` (an event's ``seq``)."""
    return agent.get(session_id, after)


@agent_router.put("/agent/sessions/{session_id}")
def rename_session(session_id: str, body: Rename):
    return agent.rename(session_id, body.title)


@agent_router.post("/agent/sessions/{session_id}/answer")
def answer(session_id: str, body: Answer):
    """Answer the question the session is waiting on."""
    return agent.answer(session_id, body.text)


@agent_router.post("/agent/sessions/{session_id}/approval")
def approval(session_id: str, body: Decision):
    """Allow or deny the action the session is waiting to take."""
    return agent.decide(session_id, body.decision)


@agent_router.post("/agent/sessions/{session_id}/browser-input", status_code=204)
def browser_input(session_id: str, body: BrowserAnswers):
    """Answers to the browser's questions (a login, a code, a choice). They go to the browser
    engine only; nothing here is stored or logged."""
    agent.answer_browser(session_id, body.request_id, body.answers)


@agent_router.post("/agent/sessions/{session_id}/stop")
def stop(session_id: str):
    return agent.stop(session_id)


@agent_router.post("/agent/sessions/{session_id}/continue")
def continue_session(session_id: str, body: Optional[Continue] = None):
    """Go on after a stop, limit, failure or restart; ``message`` adds an instruction."""
    return agent.continue_(session_id, body.message if body else None)


@agent_router.delete("/agent/sessions/{session_id}", status_code=204)
def delete_session(session_id: str):
    agent.delete(session_id)


@agent_router.get("/agent/schedules")
def list_schedules():
    """Scheduled tasks with their next and last run."""
    return {"schedules": schedules.list_schedules()}


@agent_router.post("/agent/schedules", status_code=201)
def create_schedule(body: ScheduleBody):
    """Schedule a task: repeat once (date, time), daily (time), weekly (days, time) or cron."""
    return schedules.create(body.model_dump())


@agent_router.put("/agent/schedules/{schedule_id}")
def update_schedule(schedule_id: str, body: ScheduleBody):
    """Change any field, or pause and resume it with ``enabled``."""
    return schedules.update(schedule_id, body.model_dump())


@agent_router.delete("/agent/schedules/{schedule_id}", status_code=204)
def delete_schedule(schedule_id: str):
    schedules.delete(schedule_id)


@agent_router.post("/agent/schedules/{schedule_id}/run", status_code=201)
def run_schedule(schedule_id: str):
    """Start the scheduled task now; its times stay as they are."""
    return schedules.run_now(schedule_id)


@agent_router.get("/agent/schedules/{schedule_id}/runs")
def schedule_runs(schedule_id: str):
    """The sessions the schedule started, latest first."""
    return {"runs": schedules.runs(schedule_id)}
