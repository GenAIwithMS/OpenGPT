"""Coding agent routes (/api/code/...)."""
from fastapi import APIRouter

from app.services.coding_agent.process import agent

code_router = APIRouter(prefix="/code")


@code_router.get("/status")
def code_status():
    """Whether the coding agent is available, and which model it uses."""
    return agent.status.public()
