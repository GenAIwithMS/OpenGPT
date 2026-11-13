import logging
import json
import uuid
import os
from typing import Dict, Any, Optional, Tuple
from langchain_community.document_loaders import PyPDFLoader, TextLoader
from langchain_community.vectorstores import FAISS
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_huggingface import HuggingFaceEmbeddings
from langsmith import traceable

logger = logging.getLogger(__name__)

# Document types supported for upload (RAG context).
SUPPORTED_EXTENSIONS = (".pdf", ".md", ".txt")

# Initialize HuggingFace embeddings
try:
    _DEFAULT_EMBEDDINGS = HuggingFaceEmbeddings(model_name="sentence-transformers/all-MiniLM-L6-v2")
except Exception as e:
    logger.warning(f"⚠ HuggingFaceEmbeddings initialization failed: {e}")
    _DEFAULT_EMBEDDINGS = None


_THREAD_RETRIEVERS: Dict[str, Any] = {}
_THREAD_METADATA: Dict[str, dict] = {}

_STORAGE_DIR = os.path.join(os.path.dirname(__file__), "..", "storage", "documents")
os.makedirs(_STORAGE_DIR, exist_ok=True)


def _thread_paths(thread_id: str, ext: str = ".pdf") -> Tuple[str, str]:
    # Thread ids are UUIDs. Refuse anything else so an id like "../../x" or an
    # absolute path can never point outside the storage folder.
    try:
        safe_id = str(uuid.UUID(str(thread_id)))
    except ValueError:
        raise ValueError(f"Invalid thread_id: {thread_id!r}")
    doc_path = os.path.join(_STORAGE_DIR, f"{safe_id}{ext}")
    meta_path = os.path.join(_STORAGE_DIR, f"{safe_id}.json")
    return doc_path, meta_path


def _ext_for(filename: str) -> str:
    """Return the lowercase extension (with dot) for a filename, or '' if none."""
    return os.path.splitext(filename or "")[1].lower()


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
            return json.load(handle)
    except Exception as exc:
        logger.warning(f"Failed to read metadata for thread {thread_id}: {exc}")
        return None


def _load_document(doc_path: str, ext: str):
    """Load a document into LangChain Documents based on its extension."""
    if ext == ".pdf":
        loader = PyPDFLoader(doc_path)
    else:
        # .txt and .md are plain text
        loader = TextLoader(doc_path, encoding="utf-8")
    return loader.load()


def _build_retriever_from_file(doc_path: str, embeddings: Any, ext: str) -> Tuple[Any, int, int]:
    docs = _load_document(doc_path, ext)

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=1000,
        chunk_overlap=200,
        separators=["\n\n", "\n", " ", ""]
    )
    chunks = splitter.split_documents(docs)

    vector_store = FAISS.from_documents(chunks, embeddings)
    retriever = vector_store.as_retriever(search_type="similarity", search_kwargs={"k": 4})

    return retriever, len(docs), len(chunks)


def _get_retriever(thread_id: Optional[str]):
    """Fetch the retriever for a thread if available or rehydrate from disk."""
    if not thread_id:
        return None

    thread_key = str(thread_id)
    if thread_key in _THREAD_RETRIEVERS:
        return _THREAD_RETRIEVERS[thread_key]

    metadata = _THREAD_METADATA.get(thread_key) or _read_metadata(thread_key)
    if metadata:
        _THREAD_METADATA[thread_key] = metadata
        file_path = metadata.get("file_path")
        ext = metadata.get("ext") or _ext_for(file_path or "")
        if file_path and os.path.exists(file_path):
            if _DEFAULT_EMBEDDINGS is None:
                logger.warning("Embeddings not available to rebuild retriever")
                return None
            try:
                retriever, docs_count, chunks_count = _build_retriever_from_file(file_path, _DEFAULT_EMBEDDINGS, ext)
                _THREAD_RETRIEVERS[thread_key] = retriever
                metadata.update({
                    "documents": docs_count,
                    "chunks": chunks_count
                })
                _THREAD_METADATA[thread_key] = metadata
                _write_metadata(thread_key, metadata)
                return retriever
            except Exception as exc:
                logger.warning(f"Failed to rebuild retriever for thread {thread_key}: {exc}")
                return None

    logger.debug(f"Retriever not found for thread {thread_id}")
    logger.debug(f"Available threads: {list(_THREAD_RETRIEVERS.keys())}")
    logger.debug(f"Metadata threads: {list(_THREAD_METADATA.keys())}")
    return None


@traceable(name="rag.ingest_document")
def ingest_document(file_bytes: bytes, thread_id: str, filename: Optional[str] = None, embeddings: Optional[Any] = None) -> dict:
    """
    Build a FAISS retriever for an uploaded document (.pdf, .md, .txt) and store
    it for the thread. Returns a summary dict surfaced in the UI.
    """
    if embeddings is None:
        embeddings = _DEFAULT_EMBEDDINGS

    if embeddings is None:
        raise ValueError(
            "No embeddings available. Provide an `embeddings` instance to `ingest_document` or install/configure HuggingFaceEmbeddings."
        )

    ext = _ext_for(filename) or ".pdf"
    if ext not in SUPPORTED_EXTENSIONS:
        raise ValueError(f"Unsupported file type '{ext}'. Supported: {', '.join(SUPPORTED_EXTENSIONS)}")

    doc_path, _ = _thread_paths(str(thread_id), ext)
    with open(doc_path, "wb") as handle:
        handle.write(file_bytes)

    retriever, docs_count, chunks_count = _build_retriever_from_file(doc_path, embeddings, ext)

    metadata = {
        "filename": filename or os.path.basename(doc_path),
        "documents": docs_count,
        "chunks": chunks_count,
        "file_path": doc_path,
        "ext": ext,
    }

    _THREAD_RETRIEVERS[str(thread_id)] = retriever
    _THREAD_METADATA[str(thread_id)] = metadata
    _write_metadata(str(thread_id), metadata)

    return {
        "filename": metadata["filename"],
        "documents": metadata["documents"],
        "chunks": metadata["chunks"],
    }


# Backwards-compatible alias for the old PDF-only API.
ingest_pdf = ingest_document


@traceable(name="rag.retrieve_from_document")
def retrieve_from_document(query: str, thread_id: str) -> dict:
    """
    Retrieve relevant information from the uploaded PDF for this chat thread.
    Returns context and metadata from the document.
    """
    logger.debug(f"Attempting to retrieve for thread: {thread_id}")
    retriever = _get_retriever(thread_id)
    if retriever is None:
        # Check if we have metadata but lost the retriever (server restart)
        if str(thread_id) in _THREAD_METADATA or _read_metadata(str(thread_id)):
            return {
                "error": "Document metadata exists but retriever was lost. Please re-upload the document.",
                "query": query,
            }
        return {
            "error": "No document indexed for this chat. Upload a document first.",
            "query": query,
        }

    # Use the retriever API to fetch relevant documents
    try:
        logger.debug(f"Calling retriever.invoke with query: {query[:50]}...")
        results = retriever.invoke(query)
        logger.debug(f"Successfully retrieved {len(results)} documents")
    except Exception as e:
        logger.warning(f"Exception during retrieval: {type(e).__name__}: {e}")
        return {"error": f"Retrieval failed: {e}", "query": query}

    context = [doc.page_content for doc in results]
    metadata = [getattr(doc, "metadata", {}) for doc in results]

    return {
        "query": query,
        "context": context,
        "metadata": metadata,
        "source_file": _THREAD_METADATA.get(str(thread_id), {}).get("filename"),
    }


def has_document(thread_id: str) -> bool:
    """Check if a thread has an uploaded document."""
    thread_key = str(thread_id)
    has_retriever = thread_key in _THREAD_RETRIEVERS
    metadata = _THREAD_METADATA.get(thread_key) or _read_metadata(thread_key)
    has_file = bool(metadata and metadata.get("file_path") and os.path.exists(metadata["file_path"]))
    logger.debug(f"has_document check - thread: {thread_id}, retriever: {has_retriever}, metadata: {bool(metadata)}, file: {has_file}")
    # Return True if retriever exists or stored file exists to allow rehydration
    return has_retriever or has_file


def get_document_info(thread_id: str) -> Optional[dict]:
    """Get metadata about the uploaded document for a thread."""
    thread_key = str(thread_id)
    metadata = _THREAD_METADATA.get(thread_key) or _read_metadata(thread_key)
    if metadata and metadata.get("file_path") and os.path.exists(metadata["file_path"]):
        _THREAD_METADATA[thread_key] = metadata
        return metadata
    return None
