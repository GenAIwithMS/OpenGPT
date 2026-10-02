from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any


class ChatRequest(BaseModel):
    """Request model for sending a chat message"""
    
    message: str = Field(..., description="User message to send to the chatbot")
    thread_id: Optional[str] = Field(None, description="Thread ID for conversation continuity")
    tools: Optional[List[str]] = Field(None, description="List of tools to use (e.g., ['search', 'blogs'])")


class RegenerateRequest(BaseModel):
    """Request model for regenerating the last AI response"""

    thread_id: str = Field(..., description="Thread ID for the conversation")
    tools: Optional[List[str]] = Field(None, description="List of tools used (e.g., ['blogs'])")


class EditMessageRequest(BaseModel):
    """Request model for editing a previously sent user message"""

    thread_id: str = Field(..., description="Thread ID for the conversation")
    message: str = Field(..., description="New (edited) content of the user message")
    index: int = Field(..., description="0-based index of the human message among human turns")
    tools: Optional[List[str]] = Field(None, description="List of tools used (e.g., ['blogs'])")


class ChatResponse(BaseModel):
    """Response model for chat messages"""

    response: str = Field(..., description="AI response message")
    thread_id: str = Field(..., description="Thread ID for the conversation")
    has_tool_calls: bool = Field(default=False, description="Whether tools were called")


class ChatStreamResponse(BaseModel):
    """Response model for streaming chat messages"""

    content: str = Field(..., description="Content chunk")
    message_type: str = Field(..., description="Type of message: ai, tool, or human")
    tool_name: Optional[str] = Field(None, description="Name of tool if it's a tool message")


class ThreadResponse(BaseModel):
    """Response model for thread information"""

    thread_id: str = Field(..., description="Unique thread identifier")
    title: str = Field(..., description="Thread title")


class ThreadListResponse(BaseModel):
    """Response model for list of threads"""

    threads: List[ThreadResponse] = Field(..., description="List of all threads")


class MessageResponse(BaseModel):
    """Response model for individual messages"""

    content: str = Field(..., description="Message content")
    type: str = Field(..., description="Message type (human, ai, tool)")
    tools: Optional[List[str]] = Field(None, description="Tools selected for a human message")
    tool_used: Optional[str] = Field(None, description="Tool that produced an AI message")
    research: Optional[List[Dict[str, Any]]] = Field(None, description="Deep research activity log")


class ThreadHistoryResponse(BaseModel):
    """Response model for thread conversation history"""

    thread_id: str = Field(..., description="Thread ID")
    messages: List[MessageResponse] = Field(..., description="List of messages in thread")


class UpdateTitleRequest(BaseModel):
    """Request model for updating thread title"""

    title: str = Field(..., min_length=1, max_length=100, description="New title for the thread")


class NewThreadResponse(BaseModel):
    """Response model for creating a new thread"""

    thread_id: str = Field(..., description="Newly created thread ID")
    title: str = Field(default="New Chat", description="Thread title")


class PDFUploadResponse(BaseModel):
    """Response model for PDF upload"""

    filename: str = Field(..., description="Name of uploaded file")
    documents: int = Field(..., description="Number of documents processed")
    chunks: int = Field(..., description="Number of text chunks created")
    thread_id: str = Field(..., description="Thread ID associated with the document")


class ErrorResponse(BaseModel):
    """Response model for errors"""

    detail: str = Field(..., description="Error message")
    error_type: Optional[str] = Field(None, description="Type of error")


class DocumentQueryRequest(BaseModel):
    """Request model for querying uploaded documents"""

    query: str = Field(..., description="Question to ask about the document")
    thread_id: str = Field(..., description="Thread ID with uploaded document")


class DocumentQueryResponse(BaseModel):
    """Response model for document queries"""

    answer: str = Field(..., description="Generated answer based on document")
    context: List[str] = Field(..., description="Relevant document excerpts")
    source_file: Optional[str] = Field(None, description="Source document filename")
    thread_id: str = Field(..., description="Thread ID")


class DocumentInfoResponse(BaseModel):
    """Response model for document information"""

    has_document: bool = Field(..., description="Whether thread has a document")
    filename: Optional[str] = Field(None, description="Document filename")
    documents: Optional[int] = Field(None, description="Number of document pages")
    chunks: Optional[int] = Field(None, description="Number of text chunks")
    thread_id: str = Field(..., description="Thread ID")
