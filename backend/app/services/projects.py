"""Projects: chats grouped with shared instructions and files.

A project has a name, instructions and files. Its chats (thread_metadata
.project_id) get the instructions in the system prompt, and the project's
files are searched on every message together with the chat's own files.
Files use the same storage, file types and embeddings as files attached to a
chat, under the project's id (a UUID no chat uses).

Deleting a project deletes its chats and files. Temporary chats never belong
to a project.
"""
import logging
import os
import re
import uuid
from typing import Optional

from sqlalchemy import func

from app.database.config import DatabaseConfig
from app.database.models import Project, ThreadMetadata
from app.exceptions import NotFoundError, ValidationError
from app.services import rag

logger = logging.getLogger(__name__)

MAX_NAME_CHARS = 100
MAX_INSTRUCTIONS_CHARS = 8000
MAX_FILES = int(os.getenv("MAX_PROJECT_FILES", "50"))
_STORED_NAME_RE = re.compile(r"^[0-9a-f-]{36}-[0-9a-f]{12}\.(pdf|md|txt)$")


def _session():
    return DatabaseConfig.get_session_factory()()


def _valid_id(project_id) -> str:
    try:
        return str(uuid.UUID(str(project_id)))
    except ValueError:
        raise NotFoundError("Project not found") from None


def _clean_name(name: str) -> str:
    name = " ".join((name or "").split())
    if not name:
        raise ValidationError("Name: enter a project name.")
    if len(name) > MAX_NAME_CHARS:
        raise ValidationError(f"Name: use at most {MAX_NAME_CHARS} characters.")
    return name


def _clean_instructions(text: Optional[str]) -> str:
    text = (text or "").strip()
    if len(text) > MAX_INSTRUCTIONS_CHARS:
        raise ValidationError(f"Instructions: use at most {MAX_INSTRUCTIONS_CHARS} characters.")
    return text


def _as_dict(p: Project, chats: int = 0, last_active=None) -> dict:
    updated = max(d for d in (p.updated_at, last_active) if d) if (p.updated_at or last_active) else None
    return {
        "id": p.id,
        "name": p.name,
        "instructions": p.instructions or "",
        "pinned": bool(p.pinned),
        "chats": chats,
        "updated_at": updated.isoformat() if updated else None,
    }


# ----- projects -----

def list_projects() -> list[dict]:
    """All projects: pinned ones first, then most recently used first (a
    chat's activity counts)."""
    with _session() as db:
        stats = dict(
            (row[0], (row[1], row[2]))
            for row in db.query(ThreadMetadata.project_id, func.count(), func.max(ThreadMetadata.updated_at))
            .filter(ThreadMetadata.project_id.isnot(None))
            .group_by(ThreadMetadata.project_id)
        )
        items = [_as_dict(p, *stats.get(p.id, (0, None))) for p in db.query(Project).all()]
    items.sort(key=lambda p: p["updated_at"] or "", reverse=True)
    return sorted(items, key=lambda p: not p["pinned"])  # stable: keeps recency within each group


def get(project_id: str) -> dict:
    project_id = _valid_id(project_id)
    with _session() as db:
        p = db.get(Project, project_id)
        if not p:
            raise NotFoundError("Project not found")
        chats = db.query(ThreadMetadata).filter_by(project_id=project_id).count()
        return _as_dict(p, chats)


def create(name: str, instructions: str = "") -> dict:
    project_id = str(uuid.uuid4())
    project = Project(id=project_id, name=_clean_name(name), instructions=_clean_instructions(instructions))
    with _session() as db:
        db.add(project)
        db.commit()
    return get(project_id)


def update(project_id: str, name: Optional[str] = None, instructions: Optional[str] = None) -> dict:
    project_id = _valid_id(project_id)
    with _session() as db:
        p = db.get(Project, project_id)
        if not p:
            raise NotFoundError("Project not found")
        if name is not None:
            p.name = _clean_name(name)
        if instructions is not None:
            p.instructions = _clean_instructions(instructions)
        db.commit()
    return get(project_id)


def set_pinned(project_id: str, pinned: bool) -> dict:
    """Pin or unpin a project. Doesn't count as using it (updated_at stays)."""
    project_id = _valid_id(project_id)
    with _session() as db:
        changed = (db.query(Project).filter_by(id=project_id)
                   .update({Project.pinned: bool(pinned), Project.updated_at: Project.updated_at},
                           synchronize_session=False))
        if not changed:
            raise NotFoundError("Project not found")
        db.commit()
    return get(project_id)


def delete(project_id: str) -> int:
    """Delete a project, its chats and its files. Returns the number of chats deleted."""
    from app.services.chat import ChatService  # chat imports chatbot, which imports this module

    project_id = _valid_id(project_id)
    with _session() as db:
        if not db.get(Project, project_id):
            raise NotFoundError("Project not found")
        thread_ids = [t for (t,) in db.query(ThreadMetadata.thread_id).filter_by(project_id=project_id)]
    for thread_id in thread_ids:
        ChatService.delete_thread(thread_id)
    try:
        rag.delete_documents(project_id)
    except Exception as e:
        logger.warning("Could not delete the files of project %s: %s", project_id, e)
    with _session() as db:
        db.query(ThreadMetadata).filter_by(project_id=project_id).update({"project_id": None})
        db.query(Project).filter_by(id=project_id).delete()
        db.commit()
    return len(thread_ids)


# ----- chats -----

def chats(project_id: str) -> list[dict]:
    """The project's chats that have messages, most recent first."""
    from app.services.chatbot import retrieve_all_threads

    project_id = _valid_id(project_id)
    with _session() as db:
        rows = (db.query(ThreadMetadata).filter_by(project_id=project_id)
                .order_by(ThreadMetadata.updated_at.desc()).all())
        items = [{"thread_id": t.thread_id, "title": t.title,
                  "updated_at": t.updated_at.isoformat() if t.updated_at else None} for t in rows]
    with_messages = set(retrieve_all_threads())
    return [c for c in items if c["thread_id"] in with_messages]


def set_thread_project(thread_id: str, project_id: Optional[str]) -> None:
    """Move a chat into a project, or out of one (project_id None)."""
    if project_id is not None:
        get(project_id)  # raises NotFoundError
        project_id = _valid_id(project_id)
    with _session() as db:
        thread = db.get(ThreadMetadata, thread_id)
        if not thread:
            raise NotFoundError("Chat not found")
        thread.project_id = project_id
        db.commit()


def project_for_thread(thread_id: Optional[str]) -> Optional[dict]:
    """The chat's project ({id, name, instructions}), or None."""
    if not thread_id or str(thread_id).startswith("temp-"):
        return None
    try:
        with _session() as db:
            row = (db.query(Project.id, Project.name, Project.instructions)
                   .join(ThreadMetadata, ThreadMetadata.project_id == Project.id)
                   .filter(ThreadMetadata.thread_id == thread_id).first())
    except Exception as e:  # a database hiccup must never break a reply
        logger.warning("Could not read the chat's project: %s", e)
        return None
    if not row:
        return None
    return {"id": row[0], "name": row[1], "instructions": row[2] or ""}


# ----- files -----

def _files(project_id: str) -> list:
    return (rag.get_document_info(project_id) or {}).get("files", [])


def list_files(project_id: str) -> list[dict]:
    project_id = _valid_id(project_id)
    return [
        {"id": f["stored_name"], "filename": f.get("filename") or f["stored_name"],
         "chunks": f.get("chunks", 0), "pages": f.get("documents", 0)}
        for f in _files(project_id)
    ]


def file_names(project_id: str, limit: int = 30) -> list[str]:
    return [f.get("filename") or f["stored_name"] for f in _files(project_id)][:limit]


def add_file(project_id: str, file_bytes: bytes, filename: str) -> dict:
    get(project_id)  # raises NotFoundError
    project_id = _valid_id(project_id)
    if len(_files(project_id)) >= MAX_FILES:
        raise ValidationError(f"A project holds at most {MAX_FILES} files. Remove one first.")
    try:
        rag.ingest_document(file_bytes, project_id, filename)
    except ValueError as e:
        raise ValidationError(str(e)) from None
    added = [f for f in list_files(project_id) if f["filename"] == filename]
    return added[-1] if added else {"filename": filename}


def remove_file(project_id: str, file_id: str) -> None:
    project_id = _valid_id(project_id)
    if not _STORED_NAME_RE.match(file_id or ""):
        raise ValidationError("Invalid file id")
    if not rag.delete_file(project_id, file_id):
        raise NotFoundError("File not found")


# ----- prompt -----

def prompt_text(project: Optional[dict]) -> str:
    """The project's part of the system prompt, or ""."""
    if not project:
        return ""
    parts = [f'This chat is in the user\'s project "{project["name"]}".']
    if project["instructions"]:
        parts.append(
            "Project instructions from the user (follow them in this chat; where they "
            "conflict with the user's general custom instructions, these win):\n"
            + project["instructions"]
        )
    names = file_names(project["id"])
    if names:
        parts.append(
            "The project has these files: " + ", ".join(names) + ". Passages from them that "
            "match the user's message are attached to it as document context; say which "
            "file an answer comes from."
        )
    return "\n\n".join(parts)
