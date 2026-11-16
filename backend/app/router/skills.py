"""Skills: /api/skills (Settings > Skills). See app/services/skills.py."""
import threading
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, UploadFile
from pydantic import BaseModel, Field

from app.rate_limit import rate_limit
from app.services import skills
from app.services.coding_agent.process import agent

skills_router = APIRouter(prefix="/skills")
LIMITED = [Depends(rate_limit)]


def _apply_to_agent() -> None:
    """The coding agent reads its skills at start: restart it in the background."""
    threading.Thread(target=agent.restart, daemon=True).start()


class SkillCreate(BaseModel):
    name: str = Field(..., max_length=64)
    description: str = Field(..., max_length=1024)
    instructions: str = Field(..., max_length=150_000)


class SkillToggle(BaseModel):
    enabled: bool


class SkillContent(BaseModel):
    skill_md: str = Field(..., max_length=200_000)


class SkillImport(BaseModel):
    url: str = Field(..., max_length=500)
    replace: bool = False


@skills_router.get("")
def list_skills():
    return {"skills": skills.list_skills()}


@skills_router.get("/catalog")
def catalog():
    return {"catalog": skills.catalog()}


@skills_router.post("/catalog/{catalog_id}", status_code=201, dependencies=LIMITED)
def install(catalog_id: str):
    skill = skills.install_from_catalog(catalog_id[:64])
    _apply_to_agent()
    return skill


@skills_router.post("", status_code=201, dependencies=LIMITED)
def create(request: SkillCreate):
    skill = skills.create(request.name, request.description, request.instructions)
    _apply_to_agent()
    return skill


@skills_router.post("/upload", status_code=201, dependencies=LIMITED)
async def upload(file: UploadFile = File(...), replace: Optional[bool] = Form(False)):
    data = await file.read(skills.MAX_DOWNLOAD_BYTES + 1)
    installed = skills.upload(file.filename or "", data, bool(replace))
    _apply_to_agent()
    return {"skills": installed}


@skills_router.post("/import", status_code=201, dependencies=LIMITED)
def import_github(request: SkillImport):
    installed = skills.import_github(request.url, request.replace)
    _apply_to_agent()
    return {"skills": installed}


@skills_router.get("/item/{skill_id:path}")
def get_skill(skill_id: str):
    return skills.get_skill(skill_id)


@skills_router.put("/item/{skill_id:path}")
def toggle(skill_id: str, request: SkillToggle):
    skill = skills.set_enabled(skill_id, request.enabled)
    _apply_to_agent()
    return skill


@skills_router.put("/content/{skill_id:path}")
def edit(skill_id: str, request: SkillContent):
    skill = skills.update_skill_md(skill_id, request.skill_md)
    _apply_to_agent()
    return skill


@skills_router.delete("/item/{skill_id:path}", status_code=204)
def delete(skill_id: str):
    skills.delete(skill_id)
    _apply_to_agent()
