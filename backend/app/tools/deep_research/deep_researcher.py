"""Main LangGraph implementation for the Deep Research agent."""

import asyncio
import re
import time
from typing import Literal

from langchain.chat_models import init_chat_model
from langchain_core.messages import (
    AIMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
    get_buffer_string,
)
from langchain_core.runnables import RunnableConfig
from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph

from .configuration import (
    Configuration,
)
from .prompts import (
    clarify_with_user_instructions,
    compress_research_simple_human_message,
    compress_research_system_prompt,
    final_report_generation_prompt,
    lead_researcher_prompt,
    research_system_prompt,
    transform_messages_into_research_topic_prompt,
)
from .state import (
    AgentInputState,
    AgentState,
    ClarifyWithUser,
    ConductResearch,
    ResearchComplete,
    ResearcherOutputState,
    ResearcherState,
    ResearchQuestion,
    SupervisorState,
)
from .utils import (
    anthropic_websearch_called,
    get_all_tools,
    get_api_key_for_model,
    get_notes_from_tool_calls,
    get_today_str,
    is_token_limit_exceeded,
    openai_websearch_called,
    think_tool,
)


################################################################################
# Helper
################################################################################

def remove_up_to_last_ai_message(messages):
    """Remove all messages up to and including the last AI message from the list."""
    # Find the index of the last AI message from the end
    for i in range(len(messages) - 1, -1, -1):
        if isinstance(messages[i], AIMessage):
            # Return messages after the last AI message
            return messages[i + 1:]
    return messages


################################################################################
# Live activity events
################################################################################

def emit(kind: str, **data):
    """Publish a live activity event (step, thinking, search, sources, ...).

    Events travel on LangGraph's custom stream, so the chat service can relay
    what the agent is doing while it runs. Outside a streamed run this is a
    no-op.
    """
    try:
        get_stream_writer()({"kind": kind, **data})
    except Exception:
        pass


def _emit_model_thoughts(response: AIMessage, agent: str):
    """Emit a model turn's reasoning, commentary and think-tool reflections."""
    reasoning = response.additional_kwargs.get("reasoning_content")
    if reasoning:
        emit("thinking", agent=agent, text=reasoning)
    if isinstance(response.content, str) and response.content.strip():
        emit("thinking", agent=agent, text=response.content.strip())
    for tc in response.tool_calls:
        if tc["name"] == "think_tool" and tc["args"].get("reflection"):
            emit("thinking", agent=agent, text=tc["args"]["reflection"])


_RETRY_AFTER_PATTERN = re.compile(r"try again in (?:(\d+)m)?([\d.]+)s")


def _invoke_model(model, messages, attempts: int = 6):
    """Invoke a model, waiting out provider rate limits instead of failing.

    A research run makes many calls in quick succession and easily exceeds a
    tokens-per-minute quota; the provider says how long to wait, so pause for
    that long (visible as a status event) and try again.
    """
    for attempt in range(attempts):
        try:
            return model.invoke(messages)
        except Exception as e:
            rate_limited = getattr(e, "status_code", None) == 429 or type(e).__name__ == "RateLimitError"
            if not rate_limited or attempt == attempts - 1:
                raise
            match = _RETRY_AFTER_PATTERN.search(str(e))
            wait = (int(match.group(1) or 0) * 60 + float(match.group(2))) if match else 20
            wait = min(int(wait) + 2, 90)
            emit("status", text=f"Rate limit reached, continuing in {wait}s")
            time.sleep(wait)


# Share of a research topic's findings echoed back to the supervisor
SUPERVISOR_FINDINGS_CHARS = 3000


def _fit_to_budget(texts: list[str], max_chars: int) -> list[str]:
    """Trim each text equally so that together they stay within ``max_chars``."""
    if not texts or sum(len(t) for t in texts) <= max_chars:
        return texts
    share = max_chars // len(texts)
    return [t[:share] for t in texts]


def _recent_rounds(messages: list, max_chars: int) -> list:
    """Drop the oldest tool-call rounds until the history fits ``max_chars``.

    A round is an AI message plus the tool results answering it; rounds are
    removed whole so every remaining tool call keeps its results.
    """
    rounds = []
    for message in messages:
        if isinstance(message, AIMessage) or not rounds:
            rounds.append([])
        rounds[-1].append(message)

    def size(round_):
        return sum(len(str(m.content)) + len(str(getattr(m, "tool_calls", ""))) for m in round_)

    while len(rounds) > 1 and sum(size(r) for r in rounds) > max_chars:
        rounds.pop(0)
    return [m for r in rounds for m in r]


_SOURCE_PATTERN = re.compile(r"--- SOURCE \d+: (.*?) ---\s*\nURL: (\S+)")


def _extract_sources(search_result: str) -> list[dict]:
    """Pull the (title, url) pairs out of a formatted search-tool result."""
    return [
        {"title": title.strip(), "url": url}
        for title, url in _SOURCE_PATTERN.findall(search_result)
        if url.startswith("http")
    ]


################################################################################
# Model initialisation helpers (called inside node functions, not at import)
################################################################################

def _init_research_model(config: RunnableConfig, tags: list | None = None):
    """Initialise the research model (supervisor) from config."""
    c = Configuration.from_runnable_config(config)
    model_api_key = get_api_key_for_model(c.research_model, config)
    return init_chat_model(
        model=c.research_model,
        api_key=model_api_key,
        max_tokens=c.research_model_max_tokens,
        tags=tags,
    )


def _init_research_model_structured(config: RunnableConfig, pydantic_cls, tags: list | None = None):
    """Initialise the research model with a structured-output wrapper.

    Uses json_mode to avoid forcing a tool call — some API providers (e.g. Groq
    with certain models) reject the default function_calling method when the
    model returns text instead of calling the structured-output tool.
    """
    model = _init_research_model(config, tags=tags)
    return model.with_structured_output(pydantic_cls, method="json_mode").with_retry(
        stop_after_attempt=Configuration.from_runnable_config(config).max_structured_output_retries,
    )


def _init_compression_model(config: RunnableConfig):
    """Initialise the compression model from config."""
    c = Configuration.from_runnable_config(config)
    model_api_key = get_api_key_for_model(c.compression_model, config)
    return init_chat_model(
        model=c.compression_model,
        api_key=model_api_key,
        max_tokens=c.compression_model_max_tokens,
    )


def _init_final_report_model(config: RunnableConfig):
    """Initialise the final report generation model from config."""
    c = Configuration.from_runnable_config(config)
    model_api_key = get_api_key_for_model(c.final_report_model, config)
    return init_chat_model(
        model=c.final_report_model,
        api_key=model_api_key,
        max_tokens=c.final_report_model_max_tokens,
    )


################################################################################
# Node: clarify_with_user
################################################################################

def clarify_with_user(state: AgentState, config: RunnableConfig):
    """Clarification node that asks the user questions if needed."""
    configurable = Configuration.from_runnable_config(config)
    emit("step", title="Understanding the request")

    # Check if clarification is allowed in this configuration
    if not configurable.allow_clarification:
        return {"messages": [AIMessage(content="No clarification needed. Proceeding with research.")]}

    # Get the research model with structured output for clarification
    model = _init_research_model_structured(config, ClarifyWithUser, tags=["clarify_with_user"])

    # Format the conversation for the model
    messages_str = get_buffer_string(state["messages"])
    prompt = clarify_with_user_instructions.format(messages=messages_str, date=get_today_str())

    # Invoke the model
    response = _invoke_model(model, [SystemMessage(content=prompt)])

    # If clarification is needed, return a response asking the user
    if response.need_clarification:
        return {
            "messages": [AIMessage(content=response.question)],
            "research_brief": {"type": "override", "value": None},
        }
    else:
        return {
            "messages": [AIMessage(content=response.verification)],
        }


################################################################################
# Node: write_research_brief
################################################################################

def write_research_brief(state: AgentState, config: RunnableConfig):
    """Write a detailed research brief based on the conversation."""
    emit("step", title="Planning the research")
    model = _init_research_model_structured(config, ResearchQuestion, tags=["write_research_brief"])

    # Format the conversation for the model
    messages_str = get_buffer_string(state["messages"])
    prompt = transform_messages_into_research_topic_prompt.format(messages=messages_str, date=get_today_str())

    # Invoke the model to generate the research brief
    response = _invoke_model(model, [SystemMessage(content=prompt)])

    emit("plan", title="Research brief", text=response.research_brief)

    # Return the research brief
    return {"research_brief": response.research_brief}


################################################################################
# Supervisor sub-graph
################################################################################

def supervisor_node(state: SupervisorState, config: RunnableConfig):
    """Supervisor node that delegates research tasks to sub-agents."""
    configurable = Configuration.from_runnable_config(config)
    max_iterations = configurable.max_researcher_iterations
    iterations = state.get("research_iterations", 0)

    if iterations == 0:
        emit("step", title="Researching")

    # Check if we've exceeded the maximum iterations
    if iterations >= max_iterations:
        return {"supervisor_messages": [AIMessage(content="Research complete.")]}

    brief = state.get("research_brief", "No research brief provided.")

    # Findings from earlier research tasks reach the supervisor as the tool
    # results in ``supervisor_messages``, so only the brief is restated here.
    supervisor_messages = list(state.get("supervisor_messages", []))
    brief_message = HumanMessage(content=f"Research Brief:\n{brief}")

    # Get the research model for the supervisor
    model = _init_research_model(config, tags=["research_supervisor"])

    # Bind tools for the supervisor (ConductResearch, ResearchComplete, think_tool)
    supervisor_tools = [ConductResearch, ResearchComplete, think_tool]
    model_with_tools = model.bind_tools(supervisor_tools, tool_choice="auto")

    # Get model response
    input_messages = [SystemMessage(content=lead_researcher_prompt), brief_message] + supervisor_messages
    response = _invoke_model(model_with_tools, input_messages)
    _emit_model_thoughts(response, agent="lead")

    # If the supervisor wraps up without ever delegating, research the brief
    # itself so the report is never written from empty notes.
    acts = any(tc["name"] in ("ConductResearch", "think_tool") for tc in response.tool_calls)
    if not acts and not state.get("notes"):
        response = AIMessage(
            content="",
            tool_calls=[{"name": "ConductResearch", "args": {"research_topic": brief}, "id": "fallback_research"}],
        )

    return {
        "supervisor_messages": [response],
        "research_iterations": iterations + 1,
    }


def researcher_node(state: ResearcherState, config: RunnableConfig):
    """Researcher node that conducts research on a specific topic."""
    configurable = Configuration.from_runnable_config(config)
    max_tool_calls = configurable.max_react_tool_calls

    # Check if we've exceeded the maximum tool calls
    if state.get("tool_call_iterations", 0) >= max_tool_calls:
        research_topic = state.get("research_topic", "")
        return {
            "researcher_messages": [AIMessage(content=f"Research complete for: {research_topic}")],
        }

    # Get the research topic from state
    research_topic = state.get("research_topic", "No research topic provided.")

    # Get all available tools
    all_tools = asyncio.run(get_all_tools(config))

    # Get the research model with tools bound
    model = _init_research_model(config, tags=["researcher"])

    # Build messages for the researcher
    # Keep only the most recent search rounds that fit the request budget;
    # everything gathered is still kept in ``raw_notes`` for the summary.
    researcher_messages = _recent_rounds(
        list(state.get("researcher_messages", [])), configurable.max_context_chars
    )

    # Create the system and human messages
    system_prompt = research_system_prompt.format(
        date=get_today_str(),
        research_topic=research_topic,
    )
    researcher_messages_with_system = [
        SystemMessage(content=system_prompt),
        HumanMessage(content=f"Research Topic: {research_topic}\n\nPlease conduct thorough research on this topic using the available search tools. Use the think tool between searches to reflect on your findings and plan next steps.")
    ] + researcher_messages

    # Bind tools and invoke
    model_with_tools = model.bind_tools(all_tools, tool_choice="auto")
    response = _invoke_model(model_with_tools, researcher_messages_with_system)
    _emit_model_thoughts(response, agent="researcher")

    return {
        "researcher_messages": [response],
        "tool_call_iterations": state.get("tool_call_iterations", 0) + 1,
    }


def supervisor_tools_node(state: SupervisorState, config: RunnableConfig):
    """Execute the supervisor's tool calls.

    Each ConductResearch call runs the researcher sub-graph on its topic; the
    compressed findings are returned to the supervisor as the tool result and
    collected in ``notes`` for the final report.
    """
    messages = state.get("supervisor_messages", [])
    last_message = messages[-1] if messages else None

    if not last_message or not last_message.tool_calls:
        return {
            "supervisor_messages": [ToolMessage(content="No tool calls to execute.", tool_call_id="noop")]
        }

    tool_messages = []
    notes = []
    for tc in last_message.tool_calls:
        if tc["name"] == "ConductResearch":
            research_topic = tc["args"].get("research_topic", "Research topic not specified.")
            emit("delegate", text=research_topic)
            try:
                result = researcher_subgraph.invoke({
                    "research_topic": research_topic,
                    "researcher_messages": [],
                    "tool_call_iterations": 0,
                    "raw_notes": [],
                })
                findings = result.get("compressed_research") or "No findings were produced for this topic."
            except Exception as e:
                findings = f"Research on this topic failed: {e}"
                emit("error", text=findings)
            notes.append(f"## Research topic\n{research_topic}\n\n## Findings\n{findings}")
            # The supervisor only needs the gist to plan its next step
            tool_messages.append(ToolMessage(content=findings[:SUPERVISOR_FINDINGS_CHARS], tool_call_id=tc["id"]))
        elif tc["name"] == "think_tool":
            tool_messages.append(ToolMessage(content="Reflection recorded.", tool_call_id=tc["id"]))
        elif tc["name"] == "ResearchComplete":
            tool_messages.append(ToolMessage(content="Research marked as complete.", tool_call_id=tc["id"]))
        else:
            tool_messages.append(ToolMessage(content=f"Unknown tool: {tc['name']}", tool_call_id=tc["id"]))

    return {
        "supervisor_messages": tool_messages,
        "notes": notes,
    }


def researcher_tools_node(state: ResearcherState, config: RunnableConfig):
    """Execute tools called by the researcher."""
    messages = state.get("researcher_messages", [])
    last_message = messages[-1] if messages else None

    if not last_message or not last_message.tool_calls:
        return {
            "researcher_messages": [ToolMessage(content="No tool calls to execute.", tool_call_id="noop")]
        }

    # Get all available tools
    all_tools = asyncio.run(get_all_tools(config))
    tool_dict = {t.name if hasattr(t, "name") else "web_search": t for t in all_tools}

    raw_notes = []
    tool_messages = []

    for tc in last_message.tool_calls:
        tool_name = tc["name"]
        tool_args = tc["args"]
        tool_call_id = tc["id"]

        if tool_name == "ResearchComplete":
            tool_messages.append(
                ToolMessage(content="Research marked as complete.", tool_call_id=tool_call_id)
            )
            continue
        if tool_name == "think_tool":
            tool_messages.append(
                ToolMessage(content="Reflection recorded.", tool_call_id=tool_call_id)
            )
            continue

        tool_fn = tool_dict.get(tool_name)
        if not tool_fn or not hasattr(tool_fn, "ainvoke"):
            tool_messages.append(
                ToolMessage(content=f"Unknown tool: {tool_name}", tool_call_id=tool_call_id)
            )
            continue

        queries = tool_args.get("queries") or tool_args.get("query") or []
        if isinstance(queries, str):
            queries = [queries]
        if queries:
            emit("search", queries=queries)

        try:
            # The search tools are async-only, so run them to completion here.
            result = str(asyncio.run(tool_fn.ainvoke(tool_args)))
            sources = _extract_sources(result)
            if sources:
                emit("sources", sources=sources)
            tool_messages.append(ToolMessage(content=result, tool_call_id=tool_call_id))
            raw_notes.append(result)
        except Exception as e:
            emit("error", text=f"{tool_name} failed: {e}")
            tool_messages.append(
                ToolMessage(content=f"Tool execution error: {str(e)}", tool_call_id=tool_call_id)
            )

    return {
        "researcher_messages": tool_messages,
        "raw_notes": raw_notes,
    }


def should_continue_research(state: ResearcherState) -> Literal["tools", END]:
    """Determine whether to continue research or end."""
    messages = state.get("researcher_messages", [])
    if messages and isinstance(messages[-1], AIMessage) and messages[-1].tool_calls:
        if all(tc["name"] == "ResearchComplete" for tc in messages[-1].tool_calls):
            return END
        return "tools"
    return END


def compress_research(state: ResearcherState, config: RunnableConfig):
    """Compress research notes into a clean format."""
    raw_notes = state.get("raw_notes", [])
    if not raw_notes:
        return {"compressed_research": "No information could be gathered for this topic.", "raw_notes": []}

    emit("status", text="Summarizing findings")
    compression_model = _init_compression_model(config)

    max_chars = Configuration.from_runnable_config(config).max_context_chars
    system_prompt = compress_research_system_prompt.format(
        raw_notes="\n\n".join(_fit_to_budget(raw_notes, max_chars))
    )
    compressed = _invoke_model(compression_model, [
        SystemMessage(content=system_prompt),
        HumanMessage(content=compress_research_simple_human_message),
    ])

    emit("findings", text=compressed.content)
    return {"compressed_research": compressed.content, "raw_notes": []}


def should_continue_supervisor(state: SupervisorState) -> Literal["tools", END]:
    """Run the supervisor's tool calls, or finish when it has none left to act on."""
    messages = state.get("supervisor_messages", [])
    if messages and isinstance(messages[-1], AIMessage) and messages[-1].tool_calls:
        if any(tc["name"] != "ResearchComplete" for tc in messages[-1].tool_calls):
            return "tools"
    return END


################################################################################
# Build the researcher sub-graph
################################################################################

researcher_builder = StateGraph(ResearcherState, input=ResearcherState, output=ResearcherOutputState)

researcher_builder.add_node("researcher", researcher_node)
researcher_builder.add_node("tools", researcher_tools_node)
researcher_builder.add_node("compress_research", compress_research)

researcher_builder.add_conditional_edges("researcher", should_continue_research, {"tools": "tools", END: "compress_research"})
researcher_builder.add_edge("tools", "researcher")
researcher_builder.add_edge("compress_research", END)

researcher_builder.add_edge(START, "researcher")

researcher_subgraph = researcher_builder.compile()


################################################################################
# Build the supervisor sub-graph
################################################################################

supervisor_builder = StateGraph(SupervisorState, input=SupervisorState, output=SupervisorState)

supervisor_builder.add_node("supervisor", supervisor_node)
# The tools node runs the researcher sub-graph once per ConductResearch call.
supervisor_builder.add_node("tools", supervisor_tools_node)

supervisor_builder.add_conditional_edges("supervisor", should_continue_supervisor, {"tools": "tools", END: END})
supervisor_builder.add_edge("tools", "supervisor")

supervisor_builder.add_edge(START, "supervisor")

supervisor_subgraph = supervisor_builder.compile()


################################################################################
# Node: final_report_generation
################################################################################

def final_report_generation(state: AgentState, config: RunnableConfig):
    """Generate the final research report."""
    emit("step", title="Writing the report")
    research_brief = state.get("research_brief", "No research brief provided.")
    notes = state.get("notes", [])
    max_chars = Configuration.from_runnable_config(config).max_context_chars
    notes_str = "\n\n".join(_fit_to_budget(notes, max_chars)) if notes else "No research notes available."

    final_report_model = _init_final_report_model(config)

    system_prompt = final_report_generation_prompt.format(
        date=get_today_str(),
        research_brief=research_brief,
        notes=notes_str,
    )

    report = _invoke_model(final_report_model, [SystemMessage(content=system_prompt)])

    return {"final_report": report.content}


################################################################################
# Build the main deep researcher graph
################################################################################

deep_researcher_builder = StateGraph(
    AgentState,
    input=AgentInputState,
    config_schema=Configuration
)

deep_researcher_builder.add_node("clarify_with_user", clarify_with_user)
deep_researcher_builder.add_node("write_research_brief", write_research_brief)
deep_researcher_builder.add_node("research_supervisor", supervisor_subgraph)
deep_researcher_builder.add_node("final_report_generation", final_report_generation)

deep_researcher_builder.add_edge(START, "clarify_with_user")
deep_researcher_builder.add_edge("clarify_with_user", "write_research_brief")
deep_researcher_builder.add_edge("write_research_brief", "research_supervisor")
deep_researcher_builder.add_edge("research_supervisor", "final_report_generation")
deep_researcher_builder.add_edge("final_report_generation", END)

deep_researcher = deep_researcher_builder.compile()
