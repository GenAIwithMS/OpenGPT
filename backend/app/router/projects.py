"""Project routes (/api/projects): chats grouped with shared instructions and files."""
import os
from typing import Optional

from fastapi import APIRouter, Depends, File, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from app.exceptions import ValidationError
from app.rate_limit import rate_limit
from app.router.chat import MAX_UPLOAD_BYTES, _check_file_content, _require_thread_id
from app.schema.models import ID_MAX_CHARS
from app.services import projects
from app.services.rag import SUPPORTED_EXTENSIONS

projects_router = APIRouter()


class ProjectBody(BaseModel):
    name: str = Field(..., max_length=projects.MAX_NAME_CHARS)
    instructions: str = Field("", max_length=projects.MAX_INSTRUCTIONS_CHARS)


class ProjectChanges(BaseModel):
    name: Optional[str] = Field(None, max_length=projects.MAX_NAME_CHARS)
    instructions: Optional[str] = Field(None, max_length=projects.MAX_INSTRUCTIONS_CHARS)


class ProjectPin(BaseModel):
    pinned: bool


class ThreadProject(BaseModel):
    project_id: Optional[str] = Field(None, max_length=ID_MAX_CHARS, description="null takes the chat out of its project")


@projects_router.get("/projects")
def list_projects():
    """All projects, most recently used first."""
    return {"projects": projects.list_projects()}


@projects_router.post("/projects", status_code=201)
def create_project(body: ProjectBody):
    return projects.create(body.name, body.instructions)


@projects_router.get("/projects/{project_id}")
def get_project(project_id: str):
    """The project with its chats and files."""
    project = projects.get(project_id)
    return {**project, "threads": projects.chats(project_id), "files": projects.list_files(project_id),
            "max_files": projects.MAX_FILES, "max_mb": MAX_UPLOAD_BYTES // (1024 * 1024)}


@projects_router.put("/projects/{project_id}")
def update_project(project_id: str, body: ProjectChanges):
    return projects.update(project_id, name=body.name, instructions=body.instructions)


@projects_router.put("/projects/{project_id}/pin")
def pin_project(project_id: str, body: ProjectPin):
    """Pin a project to the top of the list, or unpin it."""
    return projects.set_pinned(project_id, body.pinned)


@projects_router.delete("/projects/{project_id}")
def delete_project(project_id: str):
    """Delete the project, its chats and its files."""
    return {"deleted_chats": projects.delete(project_id)}


@projects_router.post("/projects/{project_id}/files", status_code=201, dependencies=[Depends(rate_limit)])
async def add_project_file(project_id: str, file: UploadFile = File(...)):
    """Add a PDF, Markdown or text file to the project."""
    filename = os.path.basename(file.filename or "").strip()[:200]
    ext = os.path.splitext(filename)[1].lower()
    if ext not in SUPPORTED_EXTENSIONS:
        raise ValidationError(f"Unsupported file type '{ext}'. Supported: {', '.join(SUPPORTED_EXTENSIONS)}")
    file_bytes = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(file_bytes) > MAX_UPLOAD_BYTES:
        raise ValidationError(f"File is too large. The limit is {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.")
    if not file_bytes:
        raise ValidationError("Empty file uploaded")
    _check_file_content(file_bytes, ext)
    # Reading and embedding the document is slow; keep the server responsive.
    return await run_in_threadpool(projects.add_file, project_id, file_bytes, filename)


@projects_router.delete("/projects/{project_id}/files/{file_id}", status_code=204)
def remove_project_file(project_id: str, file_id: str):
    projects.remove_file(project_id, file_id)


@projects_router.put("/threads/{thread_id}/project")
def move_thread(thread_id: str, body: ThreadProject):
    """Move a chat into a project, or out of one."""
    thread_id = _require_thread_id(thread_id)
    projects.set_thread_project(thread_id, body.project_id)
    return {"thread_id": thread_id, "project_id": body.project_id}
