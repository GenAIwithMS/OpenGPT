"""Coding agent routes (/api/code/...)."""
from fastapi import APIRouter, Depends, Query

from app.rate_limit import rate_limit
from app.schema.models import (
    CodeSessionCreateRequest,
    CodeSessionTitleRequest,
    ProjectCreateRequest,
    ProjectListResponse,
    ProjectResponse,
)
from app.services.coding_agent import projects, sessions
from app.services.coding_agent.process import agent

code_router = APIRouter(prefix="/code")


@code_router.get("/status")
def code_status():
    """Whether the coding agent is available, and which model it uses."""
    return agent.status.public()


# ----- projects -----

@code_router.get("/projects", response_model=ProjectListResponse)
def list_projects():
    """Project folders the coding agent can work in."""
    return {"projects": projects.list_projects()}


@code_router.post("/projects", response_model=ProjectResponse, status_code=201,
                  dependencies=[Depends(rate_limit)])
def create_project(request: ProjectCreateRequest):
    """Create an empty project folder."""
    return projects.create_project(request.name)


# ----- sessions -----

@code_router.get("/sessions")
async def list_sessions(project: str = Query(..., min_length=1, max_length=64)):
    """A project's coding sessions, newest first."""
    return {"sessions": await sessions.list_sessions(project)}


@code_router.post("/sessions", status_code=201, dependencies=[Depends(rate_limit)])
async def create_session(request: CodeSessionCreateRequest):
    """Start a coding session in a project."""
    return await sessions.create_session(request.project, request.title)


@code_router.get("/sessions/{session_id}")
async def get_session(session_id: str):
    return await sessions.get_session(session_id)


@code_router.put("/sessions/{session_id}/title")
async def rename_session(session_id: str, request: CodeSessionTitleRequest):
    return await sessions.rename_session(session_id, request.title)


@code_router.delete("/sessions/{session_id}", status_code=204)
async def delete_session(session_id: str):
    await sessions.delete_session(session_id)


@code_router.get("/sessions/{session_id}/messages")
async def session_messages(session_id: str):
    """The session and its messages, oldest first."""
    return await sessions.session_messages(session_id)
