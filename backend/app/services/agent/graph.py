"""The agent's LangGraph graph.

    START -> agent -> (tool calls?) -> tools -> (more calls?) -> tools ... -> agent -> ... -> END

* ``agent`` asks the model (the "agent" model in Settings > Models) what to do
  next, with the same tools chat has: search, weather, calculator, stocks,
  knowledge, skills, memory and the user's connectors, plus two of its own:
  ``Update_plan`` and ``Ask_user``.
* ``tools`` runs **one** tool call per step. Each step is checkpointed, so a
  tool that waits for the user (a question, or an approval before a connector
  changes something) pauses the graph with ``interrupt()``, and on resume only
  that call runs again: a call that already finished never runs twice.

The conversation is checkpointed in the chat checkpointer under the thread id
``agent-<session id>`` (chat lists leave those out).
"""
from typing import Annotated, TypedDict

from langchain_core.messages import AIMessage, BaseMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from langgraph.config import get_config
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode
from langgraph.types import interrupt

from app.llm import chat_model, model_name
from app.services import knowledge, mcp_tools, memory, skills
from app.services.agent import store
from app.services.knowledge import Knowledge
from app.services.personalization import profile_text
from app.tools import Calculator, Search, Stock_price, Weather

THREAD_PREFIX = "agent-"
MAX_PLAN_STEPS = 20


class AgentState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]
    thread_id: str


def thread_id(session_id: str) -> str:
    return THREAD_PREFIX + session_id


def _session_id() -> str:
    return (get_config().get("configurable") or {}).get("agent_session", "")


@tool
def Update_plan(steps: list[str], completed: int = 0) -> str:
    """Write or update your plan: the steps for the task in order, and how many
    of them are finished. Call it before you start, and again whenever a step
    finishes or the plan changes."""
    steps = [" ".join(str(s).split())[:300] for s in steps if str(s).strip()][:MAX_PLAN_STEPS]
    completed = max(0, min(int(completed or 0), len(steps)))
    session_id = _session_id()
    if session_id:
        store.add_event(session_id, "plan", {"steps": steps, "completed": completed})
    return "Plan saved."


@tool
def Ask_user(question: str) -> str:
    """Ask the user a question and wait for the answer. Use it only when you
    can't go on without information or a choice that only the user has."""
    answer = interrupt({"type": "question", "question": str(question).strip()[:2000]})
    return f"The user answered: {answer}"


# Tools whose calls the session page shows in their own way (plan, question),
# not as tool calls.
OWN_TOOLS = {"Update_plan", "Ask_user"}

INSTRUCTIONS = (
    "You are OpenGPT's agent. You work on the user's task on your own, step by step, "
    "with the tools provided; the only tools available are the ones in this request. "
    "Before you start, call Update_plan with a short plan (usually 3 to 7 steps), and "
    "call it again as steps finish. Prefer the user's connected apps (tools named "
    "server__tool) for anything in those apps. Tools that change something ask the user "
    "first; if the user declines, don't try that again: find another way or explain. "
    "Use Ask_user only when you can't go on without the user. Never invent results. "
    "When the task is finished, or can't be finished, reply with a short summary: what "
    "you did, the results (with links), and anything that failed or still needs the user."
)


def build_tools_and_prompt(thread: str) -> tuple[list, str]:
    """The tools and system prompt for one run, like chat's (see chatbot.chat_node)."""
    tools = [Update_plan, Ask_user, Search, Weather, Calculator, Stock_price]
    text = INSTRUCTIONS

    profile = profile_text()
    if profile:
        text += "\n\n" + profile

    memory_text = memory.prompt_text(thread)
    if memory_text:
        text += "\n\n" + memory_text
        if memory.saved_memories_on():
            tools += [memory.Remember, memory.Update_memory, memory.Forget]
        if memory.chat_history_on():
            tools.append(memory.Chat_history)

    if knowledge.has_documents():
        tools.append(Knowledge)
        text += ("\n\nThe user has a knowledge base with these documents: "
                 + ", ".join(knowledge.titles()) + ". Use the Knowledge tool when they may help.")

    skills_text = skills.prompt_text()
    if skills_text:
        tools.append(skills.Skill)
        text += "\n\n" + skills_text

    tools.extend(mcp_tools.chat_tools())

    # The browser engine (Node 24, built): website tools.
    from app.services import browser_engine
    from app.services.agent import browser
    reason = browser_engine.unavailable_reason()
    if reason is None:
        tools.extend(browser.TOOLS)
        text += "\n\n" + browser.PROMPT
    else:
        text += ("\n\nYou have no browser tools here: OpenGPT's browser isn't set up (" + reason + ") "
                 "If the user asks you to use a website, say that, and that Settings > Browser shows "
                 "how to turn it on. You never control the user's own browser; with the browser set "
                 "up you use OpenGPT's own and ask the user for any login.")
    return tools, text


def pending_calls(messages: list) -> list[dict]:
    """Tool calls of the latest model message that have no result yet."""
    for i in range(len(messages) - 1, -1, -1):
        if isinstance(messages[i], AIMessage):
            answered = {m.tool_call_id for m in messages[i + 1:] if isinstance(m, ToolMessage)}
            return [c for c in (messages[i].tool_calls or []) if c["id"] not in answered]
    return []


def build(tools: list, system_text: str, checkpointer, model=None):
    """Compile the graph. ``model`` (a chat model) is for tests."""
    from app.services.chatbot import close_dangling_tool_calls

    llm = (model or chat_model(model_name("agent_model"))).bind_tools(tools)
    tool_node = ToolNode(tools, handle_tool_errors=True)

    def agent(state: AgentState, config):
        messages = close_dangling_tool_calls(list(state["messages"]))
        return {"messages": [llm.invoke([SystemMessage(content=system_text)] + messages, config)]}

    def run_tool(state: AgentState, config):
        call = pending_calls(state["messages"])[0]
        single = {"messages": [AIMessage(content="", tool_calls=[call])], "thread_id": state["thread_id"]}
        return tool_node.invoke(single, config)

    def after_agent(state: AgentState):
        return "tools" if pending_calls(state["messages"]) else END

    def after_tool(state: AgentState):
        return "tools" if pending_calls(state["messages"]) else "agent"

    graph = StateGraph(AgentState)
    graph.add_node("agent", agent)
    graph.add_node("tools", run_tool)
    graph.add_edge(START, "agent")
    graph.add_conditional_edges("agent", after_agent, {"tools": "tools", END: END})
    graph.add_conditional_edges("tools", after_tool, {"tools": "tools", "agent": "agent"})
    return graph.compile(checkpointer=checkpointer)
