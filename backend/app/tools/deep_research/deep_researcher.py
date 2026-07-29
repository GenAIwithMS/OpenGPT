"""Main LangGraph implementation for the Deep Research agent."""

import asyncio
from typing import Literal

from langchain.chat_models import init_chat_model
from langchain_core.messages import (
    AIMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
    filter_messages,
    get_buffer_string,
)
from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command

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
    get_model_token_limit,
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
    """Initialise the research model with a structured-output wrapper."""
    model = _init_research_model(config, tags=tags)
    return model.with_structured_output(pydantic_cls).with_retry(
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

    # Check if clarification is allowed in this configuration
    if not configurable.allow_clarification:
        return {"messages": [AIMessage(content="No clarification needed. Proceeding with research.")]}

    # Get the research model with structured output for clarification
    model = _init_research_model_structured(config, ClarifyWithUser, tags=["clarify_with_user"])

    # Format the conversation for the model
    messages_str = get_buffer_string(state["messages"])
    prompt = clarify_with_user_instructions.format(messages=messages_str, date=get_today_str())

    # Invoke the model
    response = model.invoke(
        [SystemMessage(content=prompt)]
    )

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
    model = _init_research_model_structured(config, ResearchQuestion, tags=["write_research_brief"])

    # Format the conversation for the model
    messages_str = get_buffer_string(state["messages"])
    prompt = transform_messages_into_research_topic_prompt.format(messages=messages_str, date=get_today_str())

    # Invoke the model to generate the research brief
    response = model.invoke(
        [SystemMessage(content=prompt)]
    )

    # Return the research brief
    return {"research_brief": response.research_brief}


################################################################################
# Supervisor sub-graph
################################################################################

def supervisor_node(state: SupervisorState, config: RunnableConfig):
    """Supervisor node that delegates research tasks to sub-agents."""
    configurable = Configuration.from_runnable_config(config)
    max_iterations = configurable.max_researcher_iterations

    # Check if we've exceeded the maximum iterations
    if state.get("research_iterations", 0) >= max_iterations:
        return Command(
            go_to=END,
            update={
                "supervisor_messages": [AIMessage(content="Research complete.")],
            }
        )

    # Prepare the system prompt
    brief = state.get("research_brief", "No research brief provided.")
    notes = state.get("notes", [])
    notes_str = "\n\n".join(notes) if notes else "No notes yet."

    system_prompt = lead_researcher_prompt

    # Build messages for the supervisor
    supervisor_messages = list(state.get("supervisor_messages", []))

    # Create a message with the research brief and current notes
    brief_message = HumanMessage(
        content=f"Research Brief:\n{brief}\n\nCurrent Research Notes:\n{notes_str}"
    )

    # Get the research model for the supervisor
    model = _init_research_model(config, tags=["research_supervisor"])

    # Bind tools for the supervisor (ConductResearch, ResearchComplete, think_tool)
    supervisor_tools = [ConductResearch, ResearchComplete, think_tool]
    model_with_tools = model.bind_tools(supervisor_tools)

    # Get model response
    input_messages = [SystemMessage(content=system_prompt), brief_message] + supervisor_messages
    response = model_with_tools.invoke(input_messages)

    # Check for tool calls
    if response.tool_calls:
        for tool_call in response.tool_calls:
            if tool_call["name"] == "ResearchComplete":
                return Command(
                    go_to=END,
                    update={
                        "supervisor_messages": [response],
                        "research_iterations": state.get("research_iterations", 0) + 1,
                    }
                )
            elif tool_call["name"] == "ConductResearch":
                return Command(
                    go_to="researcher",
                    update={
                        "supervisor_messages": [response],
                        "research_iterations": state.get("research_iterations", 0) + 1,
                    }
                )

    # No tool calls - just update messages
    return {
        "supervisor_messages": [response],
        "research_iterations": state.get("research_iterations", 0) + 1,
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
            "raw_notes": [f"Maximum tool calls ({max_tool_calls}) reached for research topic: {research_topic}"]
        }

    # Get the research topic from state
    research_topic = state.get("research_topic", "No research topic provided.")

    # Get all available tools
    all_tools = asyncio.run(get_all_tools(config))

    # Get the research model with tools bound
    model = _init_research_model(config, tags=["researcher"])

    # Check if the model has a token limit and if we need to trim messages
    model_token_limit = get_model_token_limit(configurable.research_model)

    # Build messages for the researcher
    researcher_messages = list(state.get("researcher_messages", []))

    # Create the system and human messages
    system_prompt = research_system_prompt.format(
        date=get_today_str(),
        research_topic=research_topic,
    )
    researcher_messages_with_system = [
        SystemMessage(content=system_prompt),
        HumanMessage(content=f"Research Topic: {research_topic}\n\nPlease conduct thorough research on this topic using the available search tools. Use the think tool between searches to reflect on your findings and plan next steps.")
    ] + researcher_messages

    # Check if we need to trim messages to fit token limit
    chat_history_length = len(get_buffer_string(researcher_messages_with_system))
    if model_token_limit and chat_history_length > model_token_limit * 0.6:  # 60% threshold
        # Remove messages to fit within token limit, keeping system prompt
        trimmed_messages = filter_messages(
            researcher_messages_with_system[2:],  # Keep system + human
            exclude_types=[ToolMessage],
            include_types=[AIMessage, HumanMessage],
        )
        # Take last N messages to fit within limits
        max_messages = max(0, len(researcher_messages_with_system) - len(trimmed_messages))
        if max_messages > 0:
            researcher_messages_with_system = (
                researcher_messages_with_system[:2] +
                trimmed_messages[-max_messages:]
            )

    # Bind tools and invoke
    model_with_tools = model.bind_tools(all_tools)
    response = model_with_tools.invoke(researcher_messages_with_system)

    # Process tool calls
    raw_notes = []
    if response.tool_calls:
        for tc in response.tool_calls:
            if tc["name"] == "ResearchComplete":
                # Research is complete
                return {
                    "researcher_messages": [response],
                }
            else:
                # Tool call was made - execute it and return result
                pass  # Will be handled by the tool execution node

    return {
        "researcher_messages": [response],
        "tool_call_iterations": state.get("tool_call_iterations", 0) + 1,
    }


def supervisor_tools_node(state: SupervisorState, config: RunnableConfig):
    """Execute tools called by the supervisor (ConductResearch)."""
    messages = state.get("supervisor_messages", [])
    last_message = messages[-1] if messages else None

    if not last_message or not last_message.tool_calls:
        return {
            "supervisor_messages": [ToolMessage(content="No tool calls to execute.", tool_call_id="noop")]
        }

    tool_messages = []
    for tc in last_message.tool_calls:
        if tc["name"] == "ConductResearch":
            # Create a research task and pass it to the researcher as a note
            research_topic = tc["args"].get("research_topic", "Research topic not specified.")
            tool_messages.append(
                ToolMessage(
                    content=f"Research task created for topic: {research_topic}",
                    tool_call_id=tc["id"],
                )
            )

    return {
        "supervisor_messages": tool_messages,
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
                ToolMessage(
                    content="Research marked as complete.",
                    tool_call_id=tool_call_id,
                )
            )
        else:
            # Execute the tool
            tool_fn = tool_dict.get(tool_name)
            if tool_fn:
                try:
                    if tool_name == "web_search":
                        # Web search requires config
                        result = tool_fn.invoke(tool_args, config={"configurable": config.get("configurable", {})})
                    else:
                        result = tool_fn.invoke(tool_args)
                    tool_messages.append(
                        ToolMessage(content=str(result), tool_call_id=tool_call_id)
                    )
                    raw_notes.append(str(result))
                except Exception as e:
                    tool_messages.append(
                        ToolMessage(content=f"Tool execution error: {str(e)}", tool_call_id=tool_call_id)
                    )

    return {
        "researcher_messages": tool_messages,
        "raw_notes": raw_notes,
        "tool_call_iterations": state.get("tool_call_iterations", 0) + 1,
    }


def should_continue_research(state: ResearcherState) -> Literal["tools", END]:
    """Determine whether to continue research or end."""
    messages = state.get("researcher_messages", [])
    if messages and isinstance(messages[-1], AIMessage) and messages[-1].tool_calls:
        return "tools"
    return END


def compress_research(state: ResearcherState, config: RunnableConfig):
    """Compress research notes into a clean format."""
    raw_notes = state.get("raw_notes", [])
    raw_notes_str = "\n\n".join(raw_notes) if raw_notes else "No research notes collected."

    compression_model = _init_compression_model(config)

    system_prompt = compress_research_system_prompt.format(raw_notes=raw_notes_str)
    compressed = compression_model.invoke([
        SystemMessage(content=system_prompt),
        HumanMessage(content=compress_research_simple_human_message),
    ])

    return {"compressed_research": compressed.content, "raw_notes": []}


def should_continue_supervisor(state: SupervisorState) -> Literal["researcher", "tools", END]:
    """Determine the next step for the supervisor."""
    messages = state.get("supervisor_messages", [])
    if messages and isinstance(messages[-1], AIMessage) and messages[-1].tool_calls:
        # Check if the tool call is ConductResearch (go to researcher) or ResearchComplete (end)
        for tc in messages[-1].tool_calls:
            if tc["name"] == "ConductResearch":
                return "researcher"
            elif tc["name"] == "ResearchComplete":
                return END
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
supervisor_builder.add_node("tools", supervisor_tools_node)
supervisor_builder.add_node("researcher", researcher_subgraph)

supervisor_builder.add_conditional_edges("supervisor", should_continue_supervisor, {"researcher": "researcher", "tools": "tools", END: END})
supervisor_builder.add_edge("tools", "supervisor")

# When researcher sub-graph finishes, go back to supervisor
def researcher_done(state: SupervisorState):
    """Determine the next step after researcher sub-graph completes."""
    notes_from_research = state.get("raw_notes", [])
    return "supervisor"

supervisor_builder.add_conditional_edges("researcher", researcher_done, {"supervisor": "supervisor"})

supervisor_builder.add_edge(START, "supervisor")

supervisor_subgraph = supervisor_builder.compile()


################################################################################
# Node: final_report_generation
################################################################################

def final_report_generation(state: AgentState, config: RunnableConfig):
    """Generate the final research report."""
    research_brief = state.get("research_brief", "No research brief provided.")
    notes = state.get("notes", [])
    notes_str = "\n\n".join(notes) if notes else "No research notes available."

    final_report_model = _init_final_report_model(config)

    system_prompt = final_report_generation_prompt.format(
        date=get_today_str(),
        research_brief=research_brief,
        notes=notes_str,
    )

    report = final_report_model.invoke([
        SystemMessage(content=system_prompt),
    ])

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
