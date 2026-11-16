"""Coding agent routes (/api/code/...)."""
from fastapi import APIRouter, Depends

from app.rate_limit import rate_limit
from app.schema.models import ProjectCreateRequest, ProjectListResponse, ProjectResponse
from app.services.coding_agent import projects
from app.services.coding_agent.process import agent

code_router = APIRouter(prefix="/code")


@code_router.get("/status")
def code_status():
    """Whether the coding agent is available, and which model it uses."""
    return agent.status.public()


@code_router.get("/projects", response_model=ProjectListResponse)
def list_projects():
    """Project folders the coding agent can work in."""
    return {"projects": projects.list_projects()}


@code_router.post("/projects", response_model=ProjectResponse, status_code=201,
                  dependencies=[Depends(rate_limit)])
def create_project(request: ProjectCreateRequest):
    """Create an empty project folder."""
    return projects.create_project(request.name)
