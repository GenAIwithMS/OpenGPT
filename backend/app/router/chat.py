from fastapi import APIRouter, UploadFile, File, Form, Query
from fastapi.responses import StreamingResponse
from typing import Optional
import json
import os
import uuid
from app.schema.models import (
    ChatRequest,
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
from langchain_groq import ChatGroq
from dotenv import load_dotenv

load_dotenv()

chat_router = APIRouter()


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


def _require_thread_id(thread_id: Optional[str]) -> str:
    valid = _valid_thread_id(thread_id)
    if valid is None:
        raise ValidationError("thread_id is required")
    return valid


@chat_router.post("/chat", response_model=ChatResponse)
def chat(request: ChatRequest):
    try:
        thread_id = _valid_thread_id(request.thread_id)
        if not thread_id:
            thread_id = ChatService.create_new_thread()

        ChatService.get_or_create_thread_title(thread_id, request.message)

        result = ChatService.send_message(request.message, thread_id, request.tools)

        return ChatResponse(**result)

    except AppError:
        raise
    except Exception as e:
        raise AppError(str(e)) from e


@chat_router.post("/chat/regenerate", response_model=ChatResponse)
def regenerate(request: RegenerateRequest):
    try:
        thread_id = _require_thread_id(request.thread_id)
        result = ChatService.regenerate_message(thread_id, request.tools)
        return ChatResponse(**result)
    except AppError:
        raise
    except Exception as e:
        raise AppError(str(e)) from e


@chat_router.post("/chat/edit", response_model=ChatResponse)
def edit_message(request: EditMessageRequest):
    try:
        thread_id = _require_thread_id(request.thread_id)

        def generate_stream():
            try:
                for chunk in ChatService.edit_message_stream(
                    thread_id, request.message, request.index, request.tools
                ):
                    yield f"data: {json.dumps(chunk)}\n\n"

                yield f"data: {json.dumps({'thread_id': thread_id, 'done': True})}\n\n"
            except Exception as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"

        return StreamingResponse(
            generate_stream(),
            media_type="text/event-stream"
        )
    except AppError:
        raise
    except Exception as e:
        raise AppError(str(e)) from e


@chat_router.get("/chat/stream")
def chat_stream(
    message: str = Query(..., description="User message"),
    thread_id: Optional[str] = Query(None, description="Thread ID"),
    tools: Optional[str] = Query(None, description="Comma-separated list of tools"),
    temporary: bool = Query(False, description="If true, chat is session-only (never persisted)"),
    session_id: Optional[str] = Query(None, description="Client-generated UUID for one temporary chat session")
):
    try:
        tools_list = tools.split(',') if tools else None

        if temporary:
            # Each temporary chat gets its own in-memory thread, so separate
            # temporary chats (other tabs or users) never share history. A
            # missing session id falls back to a one-off thread.
            try:
                session = str(uuid.UUID(session_id)) if session_id else str(uuid.uuid4())
            except ValueError:
                raise ValidationError("Invalid session_id: expected a UUID")
            thread_id = f"temp-{session}"

            def generate_stream():
                try:
                    for chunk in ChatService.stream_message(message, thread_id, tools_list, temporary=True):
                        yield f"data: {json.dumps(chunk)}\n\n"

                    yield f"data: {json.dumps({'done': True})}\n\n"
                except Exception as e:
                    yield f"data: {json.dumps({'error': str(e)})}\n\n"

            return StreamingResponse(
                generate_stream(),
                media_type="text/event-stream"
            )

        thread_id = _valid_thread_id(thread_id)
        if not thread_id:
            thread_id = ChatService.create_new_thread()

        ChatService.get_or_create_thread_title(thread_id, message)

        def generate_stream():
            try:
                for chunk in ChatService.stream_message(message, thread_id, tools_list):
                    yield f"data: {json.dumps(chunk)}\n\n"

                yield f"data: {json.dumps({'thread_id': thread_id, 'done': True})}\n\n"
            except Exception as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"

        return StreamingResponse(
            generate_stream(),
            media_type="text/event-stream"
        )

    except AppError:
        raise
    except Exception as e:
        raise AppError(str(e)) from e


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
        raise AppError(str(e)) from e


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
        raise AppError(str(e)) from e


@chat_router.post("/threads/new", response_model=NewThreadResponse)
def create_new_thread():
    try:
        thread_id = ChatService.create_new_thread()
        return NewThreadResponse(thread_id=thread_id, title="New Chat")

    except AppError:
        raise
    except Exception as e:
        raise AppError(str(e)) from e


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
        raise AppError(str(e)) from e


@chat_router.put("/threads/{thread_id}/reports/{report_index}")
def update_research_report(thread_id: str, report_index: int, request: UpdateReportRequest):
    thread_id = _require_thread_id(thread_id)
    if not ChatService.update_research_report(thread_id, report_index, request.content):
        raise NotFoundError("Report not found")
    return {"status": "success", "thread_id": thread_id, "report_index": report_index}


@chat_router.post("/upload-pdf", response_model=PDFUploadResponse)
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

        file_bytes = file.file.read()

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
        raise AppError(str(e)) from e


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
        raise AppError(str(e)) from e


@chat_router.post("/query-document", response_model=DocumentQueryResponse)
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
        raise AppError(str(e)) from e


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
        raise AppError(str(e)) from e
