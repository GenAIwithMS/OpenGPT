"""Parallel web search tool for the deep research agent."""

from typing import List

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool

from app.tools.parallel_search import search_async
from .configuration import Configuration


@tool(parse_docstring=True)
async def web_search(queries: List[str], objective: str, config: RunnableConfig) -> str:
    """Search the web and get the most relevant excerpts from each result.

    Args:
        queries: 1-3 concise keyword queries, 3-6 words each, every one naming the key entity or topic.
            Vary the wording or angle between queries; do not write sentences or use site: operators.
        objective: One self-contained sentence stating what you want to find out, including any
            freshness or source requirements (e.g. "official documentation", "past 3 months").
    """
    configurable = config.get("configurable", {}) if config else {}
    research_model = Configuration.from_runnable_config(config).research_model
    try:
        return await search_async(
            queries,
            objective,
            # Research is not latency-bound, so take the highest-quality results
            mode="advanced",
            # One session per research run links its searches for better context
            session_id=configurable.get("search_session_id"),
            client_model=research_model.split(":", 1)[-1],
        )
    except Exception as e:
        return f"Web search failed: {e}"
