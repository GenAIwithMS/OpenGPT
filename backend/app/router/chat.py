from fastapi import APIRouter, UploadFile, File, Form, Query
from fastapi.responses import StreamingResponse
from typing import Optional
import json
import os
from app.schema.models import (
    ChatRequest,
    RegenerateRequest,
    EditMessageRequest,
    ChatResponse,
    ThreadListResponse,
    ThreadHistoryResponse,
    UpdateTitleRequest,
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


@chat_router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    try:
        if not request.thread_id:
            thread_id = ChatService.create_new_thread()
        else:
            thread_id = request.thread_id

        ChatService.get_or_create_thread_title(thread_id, request.message)

        result = ChatService.send_message(request.message, thread_id, request.tools)

        return ChatResponse(**result)

    except Exception as e:
        raise AppError(str(e)) from e


@chat_router.post("/chat/regenerate", response_model=ChatResponse)
async def regenerate(request: RegenerateRequest):
    try:
        result = ChatService.regenerate_message(request.thread_id, request.tools)
        return ChatResponse(**result)
    except Exception as e:
        raise AppError(str(e)) from e


@chat_router.post("/chat/edit", response_model=ChatResponse)
async def edit_message(request: EditMessageRequest):
    try:
        def generate_stream():
            try:
                for chunk in ChatService.edit_message_stream(
                    request.thread_id, request.message, request.index, request.tools
                ):
                    yield f"data: {json.dumps(chunk)}\n\n"

                yield f"data: {json.dumps({'thread_id': request.thread_id, 'done': True})}\n\n"
            except Exception as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"

        return StreamingResponse(
            generate_stream(),
            media_type="text/event-stream"
        )
    except Exception as e:
        raise AppError(str(e)) from e


@chat_router.get("/chat/stream")
async def chat_stream(
    message: str = Query(..., description="User message"),
    thread_id: Optional[str] = Query(None, description="Thread ID"),
    tools: Optional[str] = Query(None, description="Comma-separated list of tools"),
    temporary: bool = Query(False, description="If true, chat is session-only (never persisted)")
):
    try:
        tools_list = tools.split(',') if tools else None

        if temporary:
            thread_id = "temp-session"

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

    except Exception as e:
        raise AppError(str(e)) from e


@chat_router.get("/threads", response_model=ThreadListResponse)
async def get_threads():
    try:
        threads = ChatService.get_all_threads()

        thread_responses = [
            ThreadResponse(thread_id=t["thread_id"], title=t["title"])
            for t in threads
        ]

        return ThreadListResponse(threads=thread_responses)

    except Exception as e:
        raise AppError(str(e)) from e


@chat_router.get("/threads/{thread_id}", response_model=ThreadHistoryResponse)
async def get_thread_history(thread_id: str):
    try:
        messages = ChatService.load_conversation(thread_id)

        if not messages:
            from app.services.chatbot import get_thread_title_from_db
            thread_exists = get_thread_title_from_db(thread_id) is not None

            if not thread_exists:
                raise NotFoundError("Thread not found")

        message_responses = [
            MessageResponse(content=m["content"], type=m["type"])
            for m in messages
        ]

        return ThreadHistoryResponse(
            thread_id=thread_id,
            messages=message_responses
        )

    except Exception as e:
        raise AppError(str(e)) from e


@chat_router.post("/threads/new", response_model=NewThreadResponse)
async def create_new_thread():
    try:
        thread_id = ChatService.create_new_thread()
        return NewThreadResponse(thread_id=thread_id, title="New Chat")

    except Exception as e:
        raise AppError(str(e)) from e


@chat_router.put("/threads/{thread_id}/title")
async def update_thread_title(thread_id: str, request: UpdateTitleRequest):
    try:
        success = ChatService.update_thread_title(thread_id, request.title)

        if not success:
            raise AppError("Failed to update title")

        return {"status": "success", "thread_id": thread_id, "title": request.title}

    except Exception as e:
        raise AppError(str(e)) from e


@chat_router.post("/upload-pdf", response_model=PDFUploadResponse)
async def upload_pdf(
    file: UploadFile = File(...),
    thread_id: Optional[str] = Form(None)
):
    try:
        ext = os.path.splitext(file.filename or "")[1].lower()
        if ext not in SUPPORTED_EXTENSIONS:
            raise ValidationError(
                f"Unsupported file type '{ext}'. Supported: {', '.join(SUPPORTED_EXTENSIONS)}"
            )

        if not thread_id:
            thread_id = ChatService.create_new_thread()

        file_bytes = await file.read()

        if not file_bytes:
            raise ValidationError("Empty file uploaded")

        result = ingest_document(
            file_bytes=file_bytes,
            thread_id=thread_id,
            filename=file.filename
        )

        result["thread_id"] = thread_id

        return PDFUploadResponse(**result)

    except Exception as e:
        raise AppError(str(e)) from e


@chat_router.delete("/threads/{thread_id}")
async def delete_thread(thread_id: str):
    try:
        success = ChatService.delete_thread(thread_id)

        if not success:
            raise AppError("Failed to delete thread")

        return {
            "status": "success",
            "message": f"Thread {thread_id} deleted successfully",
            "thread_id": thread_id
        }

    except Exception as e:
        raise AppError(str(e)) from e


@chat_router.post("/query-document", response_model=DocumentQueryResponse)
async def query_document(request: DocumentQueryRequest):
    try:
        if not has_document(request.thread_id):
            raise NotFoundError(
                "No document found for this thread. Please upload a PDF first."
            )

        retrieval_result = retrieve_from_document(request.query, request.thread_id)

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
            thread_id=request.thread_id
        )

    except Exception as e:
        raise AppError(str(e)) from e


@chat_router.get("/threads/{thread_id}/document", response_model=DocumentInfoResponse)
async def get_thread_document_info(thread_id: str):
    try:
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

    except Exception as e:
        raise AppError(str(e)) from e
