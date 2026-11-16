"""Coding agent routes (/api/code/...)."""
from typing import Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse

from app.rate_limit import rate_limit
from app.schema.models import (
    CodeApprovalReply,
    CodeMessageRequest,
    CodeSessionCreateRequest,
    CodeSessionTitleRequest,
    ProjectCreateRequest,
    ProjectListResponse,
    ProjectOpenRequest,
    ProjectResponse,
)
from app.services.coding_agent import approvals, projects, sessions, stream
from app.services.coding_agent.process import agent

code_router = APIRouter(prefix="/code")


@code_router.get("/status")
def code_status():
    """Whether the coding agent is available, and which model it uses."""
    return agent.status.public()


# ----- projects (folders on this computer) -----

@code_router.get("/projects", response_model=ProjectListResponse)
def list_projects():
    """Opened and created project folders, most recently used first."""
    return {
        "projects": projects.list_projects(),
        "projects_root": str(projects.projects_root()),
        "can_browse": projects.browsing_enabled(),
    }


@code_router.post("/projects", response_model=ProjectResponse, status_code=201,
                  dependencies=[Depends(rate_limit)])
def create_project(request: ProjectCreateRequest):
    """Create an empty project folder in CODE_PROJECTS_ROOT."""
    return projects.create_project(request.name)


@code_router.post("/projects/open", response_model=ProjectResponse, dependencies=[Depends(rate_limit)])
def open_project(request: ProjectOpenRequest):
    """Open an existing folder on this computer as a project (local API only)."""
    return projects.open_folder(request.path)


@code_router.delete("/projects/{project_id}", status_code=204)
def remove_project(project_id: str):
    """Remove a project from the list. Its folder and files are not touched."""
    projects.remove_project(project_id)


@code_router.get("/folders")
def browse_folders(path: Optional[str] = Query(None, max_length=4096)):
    """Subfolders of a folder, for the folder browser (local API only)."""
    return projects.browse(path)


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


@code_router.post("/sessions/{session_id}/stream", dependencies=[Depends(rate_limit)])
async def stream_turn(session_id: str, request: CodeMessageRequest):
    """Send a message and stream the agent's progress (Server-Sent Events)."""
    events = await stream.run_turn(session_id, request.text)
    return StreamingResponse(
        events,
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@code_router.post("/sessions/{session_id}/stop")
async def stop_turn(session_id: str):
    """Stop the agent's current work in this session."""
    return await stream.stop(session_id)


# ----- approvals -----

@code_router.get("/sessions/{session_id}/approvals")
async def pending_approvals(session_id: str):
    """Approvals this session is waiting for."""
    return {"approvals": await approvals.pending(session_id)}


@code_router.post("/sessions/{session_id}/approvals/{request_id}", status_code=204)
async def answer_approval(session_id: str, request_id: str, request: CodeApprovalReply):
    """Allow once, allow always (in this project), or reject."""
    await approvals.reply(session_id, request_id, request.decision, request.reason)


@code_router.get("/projects/{project}/approvals")
async def saved_approvals(project: str):
    """The project's saved "always" approvals."""
    return {"approvals": await approvals.list_saved(project)}


@code_router.delete("/projects/{project}/approvals/{saved_id}", status_code=204)
async def revoke_approval(project: str, saved_id: str):
    """Revoke a saved "always" approval."""
    await approvals.revoke_saved(project, saved_id)
