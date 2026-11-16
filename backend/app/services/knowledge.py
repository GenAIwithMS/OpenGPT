"""Knowledge base (Settings > Personalization > Knowledge).

Documents added here are searchable from every chat: the chat model gets a
`Knowledge` tool and calls it when a question may relate to them. They use
the same storage, file types and embeddings as documents attached to a chat,
under a reserved id that no chat uses.
"""
import logging
import os
import re

from langchain_core.tools import tool

from app.exceptions import NotFoundError, ValidationError
from app.services import rag

logger = logging.getLogger(__name__)

# Reserved document-set id for the knowledge base (chat threads use random UUIDs).
KNOWLEDGE_ID = "00000000-0000-4000-8000-00000000004b"
MAX_FILES = int(os.getenv("MAX_KNOWLEDGE_FILES", "50"))
_STORED_NAME_RE = re.compile(r"^[0-9a-f-]{36}-[0-9a-f]{12}\.(pdf|md|txt)$")


def _files() -> list:
    info = rag.get_document_info(KNOWLEDGE_ID)
    return (info or {}).get("files", [])


def list_files() -> list[dict]:
    return [
        {"id": f["stored_name"], "filename": f.get("filename") or f["stored_name"],
         "chunks": f.get("chunks", 0), "pages": f.get("documents", 0)}
        for f in _files()
    ]


def has_documents() -> bool:
    return rag.has_document(KNOWLEDGE_ID)


def titles(limit: int = 30) -> list[str]:
    return [f.get("filename") or f["stored_name"] for f in _files()][:limit]


def add(file_bytes: bytes, filename: str) -> dict:
    if len(_files()) >= MAX_FILES:
        raise ValidationError(f"The knowledge base holds at most {MAX_FILES} files. Remove one first.")
    try:
        rag.ingest_document(file_bytes, KNOWLEDGE_ID, filename)
    except ValueError as e:
        raise ValidationError(str(e)) from None
    added = [f for f in list_files() if f["filename"] == filename]
    return added[-1] if added else {"filename": filename}


def remove(file_id: str) -> None:
    if not _STORED_NAME_RE.match(file_id or ""):
        raise ValidationError("Invalid file id")
    if not rag.delete_file(KNOWLEDGE_ID, file_id):
        raise NotFoundError("File not found")


def search(query: str) -> str:
    """Relevant passages as text for the model."""
    result = rag.retrieve_from_document(query, KNOWLEDGE_ID)
    if result.get("error"):
        return "The knowledge base has no matching documents."
    passages = []
    for text, meta in zip(result.get("context", []), result.get("metadata", [])):
        source = (meta or {}).get("filename") or "document"
        page = (meta or {}).get("page")
        where = f"{source}, page {page + 1}" if isinstance(page, int) else source
        passages.append(f"[{where}]\n{text}")
    return "\n\n---\n\n".join(passages) or "Nothing relevant was found in the knowledge base."


@tool("Knowledge")
def Knowledge(query: str) -> str:
    """Search the user's knowledge base (documents they saved in settings) for
    passages relevant to the query. Use it when a question may relate to those
    documents, and mention which document an answer comes from."""
    return search(query)
