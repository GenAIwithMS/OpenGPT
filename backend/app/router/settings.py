"""Settings routes (/api/settings)."""
import os
from typing import Any, Dict

from fastapi import APIRouter, Body, Depends, File, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from app.exceptions import ValidationError
from app.rate_limit import rate_limit
from app.router.chat import MAX_UPLOAD_BYTES, _check_file_content
from app.services import knowledge, memory
from app.services import settings as app_settings
from app.services.rag import SUPPORTED_EXTENSIONS

settings_router = APIRouter(prefix="/settings")


@settings_router.get("")
def get_settings():
    """All settings, with defaults filled in, plus the display name."""
    return app_settings.get_all()


@settings_router.put("")
def update_settings(changes: Dict[str, Dict[str, Any]] = Body(...)):
    """Save some settings, e.g. {"profile": {"nickname": "Ali"}}."""
    return app_settings.update(changes)


# ----- knowledge base (Personalization > Knowledge) -----

@settings_router.get("/knowledge")
def list_knowledge():
    """Documents in the knowledge base."""
    return {"files": knowledge.list_files(), "max_files": knowledge.MAX_FILES,
            "max_mb": MAX_UPLOAD_BYTES // (1024 * 1024)}


@settings_router.post("/knowledge", status_code=201, dependencies=[Depends(rate_limit)])
async def add_knowledge(file: UploadFile = File(...)):
    """Add a PDF, Markdown or text file to the knowledge base."""
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
    return await run_in_threadpool(knowledge.add, file_bytes, filename)


@settings_router.delete("/knowledge/{file_id}", status_code=204)
def remove_knowledge(file_id: str):
    """Remove a document from the knowledge base."""
    knowledge.remove(file_id)


# ----- memory (Personalization > Memory) -----

class MemoryText(BaseModel):
    text: str = Field(..., max_length=memory.MAX_MEMORY_CHARS)


@settings_router.get("/memories")
def list_memories():
    """Saved memories, newest first."""
    return {"memories": memory.list_memories(), "max": memory.MAX_MEMORIES,
            "max_chars": memory.MAX_MEMORY_CHARS}


@settings_router.post("/memories", status_code=201)
def add_memory(body: MemoryText):
    return memory.add(body.text)


@settings_router.put("/memories/{memory_id}")
def update_memory(memory_id: str, body: MemoryText):
    return memory.update(memory_id[:36], body.text)


@settings_router.delete("/memories/{memory_id}", status_code=204)
def delete_memory(memory_id: str):
    memory.delete(memory_id[:36])


@settings_router.delete("/memories", status_code=204)
def clear_memories():
    """Delete every saved memory."""
    memory.clear()
