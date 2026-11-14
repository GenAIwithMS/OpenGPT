from fastapi import APIRouter, Depends, UploadFile, File, Form
from fastapi.responses import StreamingResponse
from typing import Optional
import json
import os
import uuid
from app.schema.models import (
    ChatRequest,
    ChatStreamRequest,
    RegenerateRequest,
    EditMessageRequest,
    ChatResponse,
    ThreadListResponse,
    ThreadHistoryResponse,
    UpdateTitleRequest,
    UpdateReportRequest,
    NewThreadResponse,
    PDFUploadResponse,
    MessageResponse,
    ThreadResponse,
    DocumentQueryRequest,
    DocumentQueryResponse,
    DocumentInfoResponse
)
from app.services.chat import ChatService
from app.services.rag import ingest_document, retrieve_from_document, has_document, get_document_info, SUPPORTED_EXTENSIONS
from app.exceptions import NotFoundError, ValidationError, AppError
from app.error_handlers import log_error, public_error
from app.rate_limit import rate_limit
from app.services.run_lock import exclusive_run
from app.services.chatbot import touch_temp_session, end_temp_session, get_thread_title_from_db
from langchain_groq import ChatGroq
from langsmith import tracing_context
from dotenv import load_dotenv

load_dotenv()

chat_router = APIRouter()

# Routes that call paid LLM / search APIs are rate limited per client.
LIMITED = [Depends(rate_limit)]

MAX_UPLOAD_BYTES = int(float(os.getenv("MAX_UPLOAD_MB", "20")) * 1024 * 1024)


def _valid_thread_id(thread_id: Optional[str]) -> Optional[str]:
    """Return the thread id in canonical form, or None if none was given.

    Thread ids are server-generated UUIDs. Anything else is rejected, because
    the id is used in file paths (path traversal) and as a database key.
    Empty, "null" and "undefined" (sent by buggy clients) count as missing.
    """
    if thread_id is None or thread_id.strip() in ("", "null", "undefined"):
        return None
    try:
        return str(uuid.UUID(thread_id))
    except (ValueError, AttributeError, TypeError):
        raise ValidationError("Invalid thread_id: expected a UUID")


def _internal_error(exc: Exception) -> AppError:
    """Turn an unexpected exception into a generic 500 without internal details."""
    ref = log_error("Request failed", exc)
    return AppError(public_error(ref), details={"ref": ref})


def _stream_error(exc: Exception) -> str:
    """Generic error text for a stream; the details only go to the server log."""
    return public_error(log_error("Stream failed", exc))


def _sse(thread_id: str, make_chunks, done_event: dict):
    """Stream chunks as Server-Sent Events while holding the thread.

    Only one reply per thread runs at a time; a second request gets a clear
    "busy" error event. The thread is released when the stream ends, fails or
    the client disconnects (Stop).
    """
    try:
        with exclusive_run(thread_id):
            for chunk in make_chunks():
                yield f"data: {json.dumps(chunk)}\n\n"
            yield f"data: {json.dumps(done_event)}\n\n"
    except AppError as e:
        yield f"data: {json.dumps({'error': e.message})}\n\n"
    except Exception as e:
        yield f"data: {json.dumps({'error': _stream_error(e)})}\n\n"


def _untraced(stream):
    """Iterate a generator with LangSmith tracing off.

    Each step runs under its own tracing_context because StreamingResponse may
    pull every chunk in a different worker thread.
    """
    iterator = iter(stream)
    while True:
        with tracing_context(enabled=False):
            try:
                item = next(iterator)
            except StopIteration:
                return
        yield item


def _require_thread_id(thread_id: Optional[str]) -> str:
    valid = _valid_thread_id(thread_id)
    if valid is None:
        raise ValidationError("thread_id is required")
    return valid


@chat_router.post("/chat", response_model=ChatResponse, dependencies=LIMITED)
def chat(request: ChatRequest):
    try:
        thread_id = _valid_thread_id(request.thread_id)
        if not thread_id:
            thread_id = ChatService.create_new_thread()

        ChatService.get_or_create_thread_title(thread_id, request.message)

        with exclusive_run(thread_id):
            result = ChatService.send_message(request.message, thread_id, request.tools)

        return ChatResponse(**result)

    except AppError:
        raise
    except Exception as e:
        raise _internal_error(e) from e


@chat_router.post("/chat/regenerate", response_model=ChatResponse, dependencies=LIMITED)
def regenerate(request: RegenerateRequest):
    try:
        thread_id = _require_thread_id(request.thread_id)
        with exclusive_run(thread_id):
            result = ChatService.regenerate_message(thread_id, request.tools)
        return ChatResponse(**result)
    except AppError:
        raise
    except Exception as e:
        raise _internal_error(e) from e


@chat_router.post("/chat/edit", dependencies=LIMITED)
def edit_message(request: EditMessageRequest):
    try:
        thread_id = _require_thread_id(request.thread_id)

        stream = _sse(
            thread_id,
            lambda: ChatService.edit_message_stream(
                thread_id, request.message, request.index, request.tools
            ),
            {"thread_id": thread_id, "done": True},
        )
        return StreamingResponse(stream, media_type="text/event-stream")
    except AppError:
        raise
    except Exception as e:
        raise _internal_error(e) from e


# POST, so the prompt travels in the request body instead of the URL, where it
# would end up in access logs and browser history.
@chat_router.post("/chat/stream", dependencies=LIMITED)
def chat_stream(request: ChatStreamRequest):
    message = request.message
    thread_id = request.thread_id
    session_id = request.session_id
    temporary = request.temporary
    try:
        tools_list = request.tools or None

        if temporary:
            # Each temporary chat gets its own in-memory thread, so separate
            # temporary chats (other tabs or users) never share history. A
            # missing session id falls back to a one-off thread.
            try:
                session = str(uuid.UUID(session_id)) if session_id else str(uuid.uuid4())
            except ValueError:
                raise ValidationError("Invalid session_id: expected a UUID")
            thread_id = f"temp-{session}"
            touch_temp_session(thread_id)

            # Temporary chats are never sent to LangSmith tracing.
            stream = _sse(
                thread_id,
                lambda: _untraced(
                    ChatService.stream_message(message, thread_id, tools_list, temporary=True)
                ),
                {"done": True},
            )
            return StreamingResponse(stream, media_type="text/event-stream")

        thread_id = _valid_thread_id(thread_id)
        if not thread_id:
            thread_id = ChatService.create_new_thread()

        ChatService.get_or_create_thread_title(thread_id, message)

        stream = _sse(
            thread_id,
            lambda: ChatService.stream_message(message, thread_id, tools_list),
            {"thread_id": thread_id, "done": True},
        )
        return StreamingResponse(stream, media_type="text/event-stream")

    except AppError:
        raise
    except Exception as e:
        raise _internal_error(e) from e


@chat_router.post("/chat/temp/{session_id}/end")
def end_temporary_chat(session_id: str):
    """Forget a temporary chat's in-memory history once the client leaves it."""
    try:
        session = str(uuid.UUID(session_id))
    except ValueError:
        raise ValidationError("Invalid session_id: expected a UUID")
    end_temp_session(f"temp-{session}")
    return {"status": "success"}


@chat_router.get("/threads", response_model=ThreadListResponse)
def get_threads():
    try:
        threads = ChatService.get_all_threads()

        thread_responses = [
            ThreadResponse(thread_id=t["thread_id"], title=t["title"])
            for t in threads
        ]

        return ThreadListResponse(threads=thread_responses)

    except AppError:
        raise
    except Exception as e:
        raise _internal_error(e) from e


@chat_router.get("/threads/{thread_id}", response_model=ThreadHistoryResponse)
def get_thread_history(thread_id: str):
    try:
        thread_id = _require_thread_id(thread_id)
        messages = ChatService.load_conversation(thread_id)

        if not messages:
            from app.services.chatbot import get_thread_title_from_db
            thread_exists = get_thread_title_from_db(thread_id) is not None

            if not thread_exists:
                raise NotFoundError("Thread not found")

        message_responses = [
            MessageResponse(
                content=m["content"],
                type=m["type"],
                tools=m.get("tools"),
                tool_used=m.get("tool_used"),
                research=m.get("research"),
            )
            for m in messages
        ]

        return ThreadHistoryResponse(
            thread_id=thread_id,
            messages=message_responses
        )

    except AppError:
        raise
    except Exception as e:
        raise _internal_error(e) from e


@chat_router.post("/threads/new", response_model=NewThreadResponse)
def create_new_thread():
    try:
        thread_id = ChatService.create_new_thread()
        return NewThreadResponse(thread_id=thread_id, title="New Chat")

    except AppError:
        raise
    except Exception as e:
        raise _internal_error(e) from e


@chat_router.put("/threads/{thread_id}/title")
def update_thread_title(thread_id: str, request: UpdateTitleRequest):
    try:
        thread_id = _require_thread_id(thread_id)
        success = ChatService.update_thread_title(thread_id, request.title)

        if not success:
            raise AppError("Failed to update title")

        return {"status": "success", "thread_id": thread_id, "title": request.title}

    except AppError:
        raise
    except Exception as e:
        raise _internal_error(e) from e


@chat_router.put("/threads/{thread_id}/reports/{report_index}")
def update_research_report(thread_id: str, report_index: int, request: UpdateReportRequest):
    thread_id = _require_thread_id(thread_id)
    if not ChatService.update_research_report(thread_id, report_index, request.content):
        raise NotFoundError("Report not found")
    return {"status": "success", "thread_id": thread_id, "report_index": report_index}


@chat_router.post("/upload-pdf", response_model=PDFUploadResponse, dependencies=LIMITED)
def upload_pdf(
    file: UploadFile = File(...),
    thread_id: Optional[str] = Form(None)
):
    try:
        ext = os.path.splitext(file.filename or "")[1].lower()
        if ext not in SUPPORTED_EXTENSIONS:
            raise ValidationError(
                f"Unsupported file type '{ext}'. Supported: {', '.join(SUPPORTED_EXTENSIONS)}"
            )

        thread_id = _valid_thread_id(thread_id)
        # Documents can only be attached to threads this server created.
        if thread_id and get_thread_title_from_db(thread_id) is None:
            raise NotFoundError("Thread not found")

        # Read at most one byte past the limit, so a huge upload is rejected
        # without loading all of it into memory.
        file_bytes = file.file.read(MAX_UPLOAD_BYTES + 1)
        if len(file_bytes) > MAX_UPLOAD_BYTES:
            raise ValidationError(
                f"File is too large. The limit is {MAX_UPLOAD_BYTES // (1024 * 1024)} MB."
            )

        if not file_bytes:
            raise ValidationError("Empty file uploaded")

        # Create the thread only once the upload is known to be valid.
        if not thread_id:
            thread_id = ChatService.create_new_thread()

        result = ingest_document(
            file_bytes=file_bytes,
            thread_id=thread_id,
            filename=file.filename
        )

        result["thread_id"] = thread_id

        return PDFUploadResponse(**result)

    except AppError:
        raise
    except Exception as e:
        raise _internal_error(e) from e


@chat_router.delete("/threads/{thread_id}")
def delete_thread(thread_id: str):
    try:
        thread_id = _require_thread_id(thread_id)
        success = ChatService.delete_thread(thread_id)

        if not success:
            raise AppError("Failed to delete thread")

        return {
            "status": "success",
            "message": f"Thread {thread_id} deleted successfully",
            "thread_id": thread_id
        }

    except AppError:
        raise
    except Exception as e:
        raise _internal_error(e) from e


@chat_router.post("/query-document", response_model=DocumentQueryResponse, dependencies=LIMITED)
def query_document(request: DocumentQueryRequest):
    try:
        thread_id = _require_thread_id(request.thread_id)
        if not has_document(thread_id):
            raise NotFoundError(
                "No document found for this thread. Please upload a PDF first."
            )

        retrieval_result = retrieve_from_document(request.query, thread_id)

        if "error" in retrieval_result:
            raise AppError(retrieval_result["error"])

        context_text = "\n\n".join(retrieval_result["context"])

        api = os.getenv("GROQ_API_KEY")
        llm = ChatGroq(model="openai/gpt-oss-120b", openai_api_key=api)
        prompt = f"""Based on the following context from a document, answer the question.

Context:
{context_text}

Question: {request.query}

Provide a clear and concise answer based only on the information in the context. If the context doesn't contain relevant information, say so.

Answer:"""

        response = llm.invoke(prompt)
        answer = response.content

        return DocumentQueryResponse(
            answer=answer,
            context=retrieval_result["context"],
            source_file=retrieval_result.get("source_file"),
            thread_id=thread_id
        )

    except AppError:
        raise
    except Exception as e:
        raise _internal_error(e) from e


@chat_router.get("/threads/{thread_id}/document", response_model=DocumentInfoResponse)
def get_thread_document_info(thread_id: str):
    try:
        thread_id = _require_thread_id(thread_id)
        has_doc = has_document(thread_id)

        if has_doc:
            doc_info = get_document_info(thread_id)
            return DocumentInfoResponse(
                has_document=True,
                filename=doc_info.get("filename"),
                documents=doc_info.get("documents"),
                chunks=doc_info.get("chunks"),
                thread_id=thread_id
            )
        else:
            return DocumentInfoResponse(
                has_document=False,
                thread_id=thread_id
            )

    except AppError:
        raise
    except Exception as e:
        raise _internal_error(e) from e
