import logging
import threading
import time
from collections import OrderedDict
from dotenv import load_dotenv
from langsmith import traceable
from typing import TypedDict, Annotated
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langgraph.graph.message import add_messages
from langchain_openai import ChatOpenAI
from langchain_groq import ChatGroq
from langgraph.graph import StateGraph, START, END
from langgraph.prebuilt import ToolNode, tools_condition
from langgraph.checkpoint.memory import MemorySaver
from app.tools import Search, Weather, Calculator, Stock_price
from app.services.rag import has_document, retrieve_from_document
from app.services.citations import renumber_sources
from app.database import DatabaseConfig,MySQLCheckpointSaver,ThreadMetadata
from sqlalchemy.sql import func
import os

logger = logging.getLogger(__name__)

load_dotenv()

api = os.getenv("GROQ_API_KEY")

model = ChatGroq(
    model="openai/gpt-oss-120b",
    api_key=api
    )

# Tools the chat model may call on its own. Deep research is deliberately not
# among them: it runs for minutes and has its own streaming path, so it only
# starts when the user picks it from the tools menu (see ChatService).
all_tools = [Search, Weather, Calculator, Stock_price]

# Without this the model (gpt-oss) tends to invent tools such as "Open_URL"
# after a search returns links, which the provider rejects.
SYSTEM_PROMPT = SystemMessage(
    content=(
        "You are OpenGPT, a helpful assistant. The only tools available are the ones "
        "provided in this request (Search, Weather, Calculator, Stock_price); "
        "you cannot open URLs or browse pages. When a Search result arrives, answer the "
        "user directly from it, citing sources inline as markdown links like "
        "[Site name](url); never use 【n†source】 style markers, and never put links or "
        "citations inside a table (cite below it instead). Do not call Search again "
        "unless the results did not cover the question."
    )
)


class Chatstate(TypedDict):
    """State definition for the chatbot"""
    messages: Annotated[list[BaseMessage], add_messages]
    thread_id: str
    has_document: bool
    # Document context retrieved for the current question:
    # {"for": <human message id>, "text": <context>}. Reused across the tool
    # loop so retrieval runs once per turn, not on every model call.
    doc_context: dict


CANCELLED_TOOL_RESULT = "Cancelled: the user stopped the response before this tool finished."


def close_dangling_tool_calls(messages: list) -> list:
    """Give every tool call a result, so the history is valid for the model.

    If the user presses Stop while a tool is running, the saved history can end
    with an assistant message that requested a tool but has no matching tool
    result. Model APIs reject that (HTTP 400), which would break every later
    message in the thread. This adds a "cancelled" result right after such a
    call. It only changes what is sent to the model, not the saved history.
    """
    answered = {m.tool_call_id for m in messages if isinstance(m, ToolMessage)}
    result = []
    i = 0
    while i < len(messages):
        msg = messages[i]
        result.append(msg)
        i += 1
        if not isinstance(msg, AIMessage) or not msg.tool_calls:
            continue
        # Keep the real results that follow this call, then add the missing ones.
        while i < len(messages) and isinstance(messages[i], ToolMessage):
            result.append(messages[i])
            i += 1
        for tc in msg.tool_calls:
            if tc.get("id") not in answered:
                result.append(ToolMessage(
                    content=CANCELLED_TOOL_RESULT, tool_call_id=tc["id"], name=tc.get("name"),
                ))
                answered.add(tc["id"])
    return result


def _last_human_index(messages: list) -> int:
    for i in range(len(messages) - 1, -1, -1):
        if isinstance(messages[i], HumanMessage):
            return i
    return -1


def _document_context(state: Chatstate, question: HumanMessage) -> tuple[str, dict]:
    """Document context for this question, retrieved once per turn.

    Returns the context text and the state update to cache it (empty when the
    cached context for this question is reused).
    """
    cached = state.get("doc_context") or {}
    if question.id and cached.get("for") == question.id:
        return cached.get("text", ""), {}
    text = ""
    try:
        result = retrieve_from_document(question.content, state.get("thread_id"))
        if result.get("context"):
            text = "\n\n".join(result["context"])
            logger.debug(f"Adding document context ({len(result['context'])} chunks)")
    except Exception as e:
        logger.warning(f"Error retrieving document context: {e}")
    return text, {"doc_context": {"for": question.id, "text": text}}


def _with_turn_wide_source_numbers(messages: list, start: int) -> list:
    """Renumber search sources in this turn's tool results (see renumber_sources)."""
    tool_positions = [
        i for i in range(start + 1, len(messages))
        if isinstance(messages[i], ToolMessage) and isinstance(messages[i].content, str)
    ]
    if len(tool_positions) < 2:
        return messages
    texts = renumber_sources([messages[i].content for i in tool_positions])
    messages = list(messages)
    for i, text in zip(tool_positions, texts):
        if text != messages[i].content:
            messages[i] = messages[i].model_copy(update={"content": text})
    return messages


@traceable(name="My GPT")
def chat_node(state: Chatstate):
    """Main chat node that processes messages and uses tools"""
    messages = list(state["messages"])
    # Add the system prompt first, so the document context inserted below can
    # never take its place at the start of the list.
    if not messages or not isinstance(messages[0], SystemMessage):
        messages = [SYSTEM_PROMPT] + messages
    thread_id = state.get("thread_id")
    has_doc = state.get("has_document", False)
    update = {}

    logger.debug(f"chat_node - thread_id: {thread_id}, has_document: {has_doc}")

    question_at = _last_human_index(messages)
    if thread_id and has_doc and question_at >= 0:
        context_text, update = _document_context(state, messages[question_at])
        if context_text:
            context_message = SystemMessage(
                content=f"""You have access to information from an uploaded document. Use this context to answer the user's question if relevant:

Document Context:
{context_text}

If the user's question is related to the document, base your answer on this context. If not related, answer normally using your knowledge or tools."""
            )
            # Put the context just before the question. Inserting it before the
            # last message instead could land between a tool call and its
            # result, which model APIs reject.
            messages.insert(question_at, context_message)
            question_at += 1

    if question_at >= 0:
        messages = _with_turn_wide_source_numbers(messages, question_at)

    messages = close_dangling_tool_calls(list(messages))

    # Stream for live tokens (picked up by stream_mode="messages"), but store a
    # single merged message: ``add_messages`` replaces a message that shares an
    # id, so yielding raw chunks would leave only the last (empty) chunk in the
    # state and drop the tool calls before the tool node ever ran.
    model_with_tools = model.bind_tools(all_tools)
    response = None
    for chunk in model_with_tools.stream(messages):
        response = chunk if response is None else response + chunk
    if response is not None:
        update["messages"] = [response]
    return update


# Create tool node
tool_node = ToolNode(all_tools)

# Build the state graph
graph = StateGraph(Chatstate)
graph.add_node("chat_node", chat_node)
graph.add_node("tools", tool_node)
graph.add_edge(START, "chat_node")
graph.add_conditional_edges("chat_node", tools_condition)
graph.add_edge("tools", "chat_node")

# Database checkpointer
check_pointer = MySQLCheckpointSaver()

# Compile the chatbot with checkpointer
chatbot = graph.compile(checkpointer=check_pointer)

# In-memory checkpointer for temporary chats: nothing is ever written to the
# database, so temp conversations only live in the running process and are lost
# on refresh / new chat / backend restart.
memory_checkpointer = MemorySaver()
chatbot_memory = graph.compile(checkpointer=memory_checkpointer)

# Temporary sessions held in memory, oldest first: {thread_id: last_used}.
# Sessions are removed when the client ends them, after an hour idle, or when
# there are too many, so memory doesn't grow until the next restart.
_TEMP_SESSION_TTL_SECONDS = 60 * 60
_MAX_TEMP_SESSIONS = 200
_temp_sessions: "OrderedDict[str, float]" = OrderedDict()
_temp_sessions_lock = threading.Lock()


def _forget_temp_session(thread_id: str) -> None:
    _temp_sessions.pop(thread_id, None)
    memory_checkpointer.delete_thread(thread_id)


def touch_temp_session(thread_id: str) -> None:
    """Mark a temporary session as used and evict stale ones."""
    now = time.monotonic()
    with _temp_sessions_lock:
        _temp_sessions[thread_id] = now
        _temp_sessions.move_to_end(thread_id)
        for tid, last_used in list(_temp_sessions.items()):
            expired = now - last_used > _TEMP_SESSION_TTL_SECONDS
            over_cap = len(_temp_sessions) > _MAX_TEMP_SESSIONS
            if tid != thread_id and (expired or over_cap):
                _forget_temp_session(tid)


def end_temp_session(thread_id: str) -> None:
    """Delete a temporary session's memory as soon as the client leaves it."""
    with _temp_sessions_lock:
        _forget_temp_session(thread_id)

# Database session factory
Session = DatabaseConfig.get_session_factory()


# Thread management functions

def retrieve_all_threads():
    """Retrieve all thread IDs from the checkpointer"""
    try:
        # Reads only thread ids, instead of loading every checkpoint.
        return check_pointer.list_thread_ids()
    except Exception as e:
        logger.warning(f"Error retrieving threads: {e}")
        return []


def save_thread_title(thread_id: str, title: str):
    """Save or update a thread's title in the database"""
    session = Session()
    try:
        existing = session.query(ThreadMetadata).filter_by(thread_id=thread_id).first()
        if existing:
            existing.title = title
            # updated_at will be automatically updated by onupdate trigger
        else:
            new_thread = ThreadMetadata(thread_id=thread_id, title=title)
            session.add(new_thread)
        session.commit()
    finally:
        session.close()


def touch_thread(thread_id: str):
    """Update the updated_at timestamp for a thread to mark recent activity"""
    session = Session()
    try:
        existing = session.query(ThreadMetadata).filter_by(thread_id=thread_id).first()
        if existing:
            # Setting the column explicitly; assigning title = title is seen
            # as "no change" and no UPDATE is sent.
            existing.updated_at = func.now()
            session.commit()
    finally:
        session.close()


def get_thread_title_from_db(thread_id: str) -> str | None:
    """Get a thread's title from the database"""
    session = Session()
    try:
        thread = session.query(ThreadMetadata).filter_by(thread_id=thread_id).first()
        return thread.title if thread else None
    finally:
        session.close()


def get_all_thread_metadata():
    """Get all thread IDs and their metadata as a dictionary"""
    session = Session()
    try:
        threads = session.query(ThreadMetadata).order_by(ThreadMetadata.updated_at.desc()).all()
        return {
            thread.thread_id: {
                "title": thread.title,
                "updated_at": thread.updated_at,
                "created_at": thread.created_at
            }
            for thread in threads
        }
    finally:
        session.close()
