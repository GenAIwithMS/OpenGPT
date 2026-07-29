"""Tool wrapper that exposes the deep research graph as a chatbot tool."""

import asyncio
import os

from langchain_core.messages import HumanMessage
from langchain_core.tools import tool

from .deep_research.deep_researcher import deep_researcher
from .deep_research.configuration import Configuration


@tool
def DeepResearch(query: str) -> str:
    """Conduct deep, multi-step research on a topic and return a comprehensive markdown report.

    Breaks a topic down into sub-questions, searches the web for each one,
    compresses findings, and synthesises everything into a well-structured
    final report with citations.  Use this when the user needs an in-depth,
    thoroughly researched answer rather than a quick lookup.

    Args:
        query: The research topic or question to investigate.

    Returns:
        A complete markdown research report.
    """
    config = {
        "configurable": {
            "allow_clarification": False,
            "search_api": "duckduckgo",
            "research_model": "groq:" + os.getenv("DEEP_RESEARCH_MODEL", "openai/gpt-oss-120b"),
            "summarization_model": "groq:" + os.getenv("DEEP_RESEARCH_SUMMARIZATION_MODEL", "openai/gpt-oss-120b"),
            "compression_model": "groq:" + os.getenv("DEEP_RESEARCH_COMPRESSION_MODEL", "openai/gpt-oss-120b"),
            "final_report_model": "groq:" + os.getenv("DEEP_RESEARCH_REPORT_MODEL", "openai/gpt-oss-120b"),
            "max_researcher_iterations": int(os.getenv("DEEP_RESEARCH_MAX_ITERATIONS", "3")),
            "max_react_tool_calls": int(os.getenv("DEEP_RESEARCH_MAX_TOOL_CALLS", "6")),
        }
    }

    result = deep_researcher.invoke(
        {"messages": [HumanMessage(content=query)]},
        config,
    )

    report = result.get("final_report", "")
    if not report:
        report = "Deep research completed but no report was generated."
    return report
