import logging
import functools
import json
import uuid
import os
import threading
import weakref
from collections import OrderedDict
from typing import Dict, Any, Optional, Tuple
from langsmith import traceable

# The document libraries (loaders, text splitter, FAISS, embeddings) pull in
# PyTorch and take tens of seconds to import, so they are imported inside the
# functions that use them. The server starts fast; the first document upload
# or question pays the cost once.

logger = logging.getLogger(__name__)

# Document types supported for upload (RAG context).
SUPPORTED_EXTENSIONS = (".pdf", ".md", ".txt")

EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")


@functools.lru_cache(maxsize=1)
def _default_embeddings():
    """The local embedding model, loaded on first use.

    Loading it takes several seconds, so it isn't done at import time: the
    server starts quickly and only pays the cost when a document is used.
    """
    try:
        from langchain_huggingface import HuggingFaceEmbeddings
        return HuggingFaceEmbeddings(model_name=EMBEDDING_MODEL)
    except Exception as e:
        logger.warning(f"HuggingFaceEmbeddings initialization failed: {e}")
        return None


class _LRUCache(OrderedDict):
    """Dict that keeps only the most recently used `maxsize` entries.

    Evicted retrievers are rebuilt from the stored file on next use, so the cap
    only bounds memory; it doesn't lose documents.
    """

    def __init__(self, maxsize: int):
        super().__init__()
        self.maxsize = maxsize
        self._lock = threading.RLock()

    def __getitem__(self, key):
        with self._lock:
            value = super().__getitem__(key)
            self.move_to_end(key)
            return value

    def __setitem__(self, key, value):
        with self._lock:
            super().__setitem__(key, value)
            self.move_to_end(key)
            while len(self) > self.maxsize:
                self.popitem(last=False)


# Each FAISS index holds a document's embeddings in memory.
_MAX_CACHED_RETRIEVERS = int(os.getenv("MAX_CACHED_RETRIEVERS", "32"))
_THREAD_RETRIEVERS: Dict[str, Any] = _LRUCache(_MAX_CACHED_RETRIEVERS)
_THREAD_METADATA: Dict[str, dict] = _LRUCache(_MAX_CACHED_RETRIEVERS * 8)

_STORAGE_DIR = os.path.join(os.path.dirname(__file__), "..", "storage", "documents")
os.makedirs(_STORAGE_DIR, exist_ok=True)


def _safe_thread_id(thread_id: str) -> str:
    # Thread ids are UUIDs. Refuse anything else so an id like "../../x" or an
    # absolute path can never point outside the storage folder.
    try:
        return str(uuid.UUID(str(thread_id)))
    except ValueError:
        raise ValueError(f"Invalid thread_id: {thread_id!r}")


def _thread_paths(thread_id: str, ext: str = ".pdf") -> Tuple[str, str]:
    """Path for a new document of this thread (unique name) and its metadata file."""
    safe_id = _safe_thread_id(thread_id)
    doc_path = os.path.join(_STORAGE_DIR, f"{safe_id}-{uuid.uuid4().hex[:12]}{ext}")
    meta_path = os.path.join(_STORAGE_DIR, f"{safe_id}.json")
    return doc_path, meta_path


def _stored_path(name: str) -> str:
    """Resolve a stored document name inside the storage folder.

    Only the file name is used, so a path written in a metadata file can never
    point anywhere else on disk.
    """
    return os.path.join(_STORAGE_DIR, os.path.basename(name or ""))


def _ext_for(filename: str) -> str:
    """Return the lowercase extension (with dot) for a filename, or '' if none."""
    return os.path.splitext(filename or "")[1].lower()


# One lock per thread, so two uploads to the same chat can't interleave their
# metadata and index updates. Weak values: unused locks are dropped.
_ingest_locks: "weakref.WeakValueDictionary[str, threading.Lock]" = weakref.WeakValueDictionary()
_ingest_locks_guard = threading.Lock()


def _ingest_lock(thread_id: str) -> threading.Lock:
    with _ingest_locks_guard:
        lock = _ingest_locks.get(thread_id)
        if lock is None:
            lock = threading.Lock()
            _ingest_locks[thread_id] = lock
        return lock


def _write_metadata(thread_id: str, metadata: dict) -> None:
    _, meta_path = _thread_paths(thread_id)
    with open(meta_path, "w", encoding="utf-8") as handle:
        json.dump(metadata, handle)


def _read_metadata(thread_id: str) -> Optional[dict]:
    _, meta_path = _thread_paths(thread_id)
    if not os.path.exists(meta_path):
        return None
    try:
        with open(meta_path, "r", encoding="utf-8") as handle:
            return _normalize_metadata(json.load(handle))
    except Exception as exc:
        logger.warning(f"Failed to read metadata for thread {thread_id}: {exc}")
        return None


def _normalize_metadata(metadata: dict) -> dict:
    """Return metadata as {"files": [...]}; older files held a single document."""
    if "files" not in metadata and metadata.get("file_path"):
        metadata = {"files": [{
            "filename": metadata.get("filename"),
            "stored_name": os.path.basename(metadata["file_path"]),
            "ext": metadata.get("ext") or _ext_for(metadata["file_path"]),
            "documents": metadata.get("documents", 0),
            "chunks": metadata.get("chunks", 0),
        }]}
    metadata.setdefault("files", [])
    return metadata


def _thread_metadata(thread_id: str) -> Optional[dict]:
    key = str(thread_id)
    metadata = _THREAD_METADATA.get(key) or _read_metadata(key)
    if metadata:
        _THREAD_METADATA[key] = metadata
    return metadata


def _existing_files(metadata: Optional[dict]) -> list:
    return [f for f in (metadata or {}).get("files", []) if os.path.exists(_stored_path(f.get("stored_name")))]


def _load_document(doc_path: str, ext: str):
    """Load a document into LangChain Documents based on its extension."""
    from langchain_community.document_loaders import PyPDFLoader, TextLoader

    if ext == ".pdf":
        loader = PyPDFLoader(doc_path)
    else:
        # .txt and .md are plain text
        loader = TextLoader(doc_path, encoding="utf-8")
    return loader.load()


def _chunk_file(doc_path: str, ext: str, filename: str) -> Tuple[list, int]:
    """Load and split one file. Returns (chunks, number of loaded documents)."""
    docs = _load_document(doc_path, ext)
    for doc in docs:
        doc.metadata["filename"] = filename
    from langchain_text_splitters import RecursiveCharacterTextSplitter

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=1000,
        chunk_overlap=200,
        separators=["\n\n", "\n", " ", ""]
    )
    return splitter.split_documents(docs), len(docs)


def _faiss():
    from langchain_community.vectorstores import FAISS
    return FAISS


def _retriever_for(vector_store):
    return vector_store.as_retriever(search_type="similarity", search_kwargs={"k": 4})


def _get_retriever(thread_id: Optional[str]):
    """Fetch the retriever for a thread, or rebuild it from all its stored files."""
    if not thread_id:
        return None

    thread_key = str(thread_id)
    if thread_key in _THREAD_RETRIEVERS:
        return _THREAD_RETRIEVERS[thread_key]

    files = _existing_files(_thread_metadata(thread_key))
    if not files:
        logger.debug(f"Retriever not found for thread {thread_id}")
        return None
    if _default_embeddings() is None:
        logger.warning("Embeddings not available to rebuild retriever")
        return None
    try:
        chunks = []
        for entry in files:
            file_chunks, _ = _chunk_file(_stored_path(entry["stored_name"]), entry["ext"], entry.get("filename"))
            chunks.extend(file_chunks)
        retriever = _retriever_for(_faiss().from_documents(chunks, _default_embeddings()))
        _THREAD_RETRIEVERS[thread_key] = retriever
        return retriever
    except Exception as exc:
        logger.warning(f"Failed to rebuild retriever for thread {thread_key}: {exc}")
        return None


@traceable(name="rag.ingest_document")
def ingest_document(file_bytes: bytes, thread_id: str, filename: Optional[str] = None, embeddings: Optional[Any] = None) -> dict:
    """
    Add an uploaded document (.pdf, .md, .txt) to the thread's search index.

    A thread can hold several documents: each upload is stored under its own
    name and added to the existing index, so earlier files stay searchable.
    Returns a summary of this upload for the UI.
    """
    if embeddings is None:
        embeddings = _default_embeddings()

    if embeddings is None:
        raise ValueError(
            "No embeddings available. Provide an `embeddings` instance to `ingest_document` or install/configure HuggingFaceEmbeddings."
        )

    ext = _ext_for(filename) or ".pdf"
    if ext not in SUPPORTED_EXTENSIONS:
        raise ValueError(f"Unsupported file type '{ext}'. Supported: {', '.join(SUPPORTED_EXTENSIONS)}")

    thread_key = _safe_thread_id(thread_id)
    with _ingest_lock(thread_key):
        doc_path, _ = _thread_paths(thread_key, ext)
        with open(doc_path, "wb") as handle:
            handle.write(file_bytes)
        display_name = filename or os.path.basename(doc_path)
        try:
            chunks, docs_count = _chunk_file(doc_path, ext, display_name)
            if not chunks:
                raise ValueError("No text could be extracted from this file")
            retriever = _get_retriever(thread_key)
            if retriever is not None:
                retriever.vectorstore.add_documents(chunks)
            else:
                retriever = _retriever_for(_faiss().from_documents(chunks, embeddings))
        except Exception:
            os.remove(doc_path)  # don't leave a file the index doesn't know about
            raise

        metadata = _thread_metadata(thread_key) or {"files": []}
        metadata["files"].append({
            "filename": display_name,
            "stored_name": os.path.basename(doc_path),
            "ext": ext,
            "documents": docs_count,
            "chunks": len(chunks),
        })
        _write_metadata(thread_key, metadata)
        _THREAD_METADATA[thread_key] = metadata
        _THREAD_RETRIEVERS[thread_key] = retriever

    return {
        "filename": display_name,
        "documents": docs_count,
        "chunks": len(chunks),
    }


@traceable(name="rag.retrieve_from_document")
def retrieve_from_document(query: str, thread_id: str) -> dict:
    """
    Retrieve relevant passages from the documents uploaded to this chat thread.
    Returns context and metadata from the documents.
    """
    logger.debug(f"Attempting to retrieve for thread: {thread_id}")
    retriever = _get_retriever(thread_id)
    if retriever is None:
        return {
            "error": "No document indexed for this chat. Upload a document first.",
            "query": query,
        }

    try:
        logger.debug(f"Calling retriever.invoke with query: {query[:50]}...")
        results = retriever.invoke(query)
        logger.debug(f"Successfully retrieved {len(results)} documents")
    except Exception as e:
        logger.warning(f"Exception during retrieval: {type(e).__name__}: {e}")
        return {"error": "Document retrieval failed", "query": query}

    context = [doc.page_content for doc in results]
    metadata = [getattr(doc, "metadata", {}) for doc in results]
    files = sorted({m.get("filename") for m in metadata if m.get("filename")})

    return {
        "query": query,
        "context": context,
        "metadata": metadata,
        "source_file": ", ".join(files) or None,
    }


def has_document(thread_id: str) -> bool:
    """Check if a thread has at least one uploaded document."""
    thread_key = str(thread_id)
    return thread_key in _THREAD_RETRIEVERS or bool(_existing_files(_thread_metadata(thread_key)))


def get_document_info(thread_id: str) -> Optional[dict]:
    """Summary of a thread's documents: names joined, counts added up."""
    files = _existing_files(_thread_metadata(thread_id))
    if not files:
        return None
    return {
        "filename": ", ".join(f.get("filename") or f["stored_name"] for f in files),
        "documents": sum(f.get("documents", 0) for f in files),
        "chunks": sum(f.get("chunks", 0) for f in files),
        "files": files,
    }


def delete_documents(thread_id: str) -> None:
    """Delete all of a thread's stored documents, its metadata and cached index."""
    thread_key = _safe_thread_id(thread_id)
    with _ingest_lock(thread_key):
        metadata = _thread_metadata(thread_key)
        for entry in (metadata or {}).get("files", []):
            path = _stored_path(entry.get("stored_name"))
            if os.path.exists(path):
                os.remove(path)
        _, meta_path = _thread_paths(thread_key)
        if os.path.exists(meta_path):
            os.remove(meta_path)
        _THREAD_RETRIEVERS.pop(thread_key, None)
        _THREAD_METADATA.pop(thread_key, None)
