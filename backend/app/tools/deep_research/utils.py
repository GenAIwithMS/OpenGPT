"""Utility functions and helpers for the Deep Research agent."""

import asyncio
import logging
import os
from datetime import datetime
from typing import Annotated, List, Literal

from app.llm import chat_model, model_name, structured
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import (
    HumanMessage,
)
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import (
    InjectedToolArg,
    tool,
)
from tavily import AsyncTavilyClient

from .configuration import Configuration, SearchAPI
from .prompts import summarize_webpage_prompt
from .state import ResearchComplete, Summary


TAVILY_SEARCH_DESCRIPTION = (
    "A search engine optimized for comprehensive, accurate, and trusted results. "
    "Useful for when you need to answer questions about current events."
)
@tool(description=TAVILY_SEARCH_DESCRIPTION)
async def tavily_search(
    queries: List[str],
    max_results: Annotated[int, InjectedToolArg] = 5,
    topic: Annotated[Literal["general", "news", "finance"], InjectedToolArg] = "general",
    config: RunnableConfig = None
) -> str:
    """Fetch and summarize search results from Tavily search API."""
    search_results = await tavily_search_async(
        queries,
        max_results=max_results,
        topic=topic,
        include_raw_content=True,
        config=config
    )

    unique_results = {}
    for response in search_results:
        for result in response['results']:
            url = result['url']
            if url not in unique_results:
                unique_results[url] = {**result, "query": response['query']}

    configurable = Configuration.from_runnable_config(config)
    max_char_to_include = configurable.max_content_length
    summarization_model = structured(
        chat_model(
            configurable.summarization_model or model_name("small_model"),
            max_tokens=configurable.summarization_model_max_tokens,
            tags=["langsmith:nostream"],
        ),
        Summary,
        stop_after_attempt=configurable.max_structured_output_retries,
    )

    async def noop():
        return None

    summarization_tasks = [
        noop() if not result.get("raw_content")
        else summarize_webpage(
            summarization_model,
            result['raw_content'][:max_char_to_include]
        )
        for result in unique_results.values()
    ]

    summaries = await asyncio.gather(*summarization_tasks)

    summarized_results = {
        url: {
            'title': result['title'],
            'content': result['content'] if summary is None else summary
        }
        for url, result, summary in zip(
            unique_results.keys(),
            unique_results.values(),
            summaries
        )
    }

    if not summarized_results:
        return "No valid search results found. Please try different search queries or use a different search API."

    formatted_output = "Search results: \n\n"
    for i, (url, result) in enumerate(summarized_results.items()):
        formatted_output += f"\n\n--- SOURCE {i+1}: {result['title']} ---\n"
        formatted_output += f"URL: {url}\n\n"
        formatted_output += f"SUMMARY:\n{result['content']}\n\n"
        formatted_output += "\n\n" + "-" * 80 + "\n"

    return formatted_output


async def tavily_search_async(
    search_queries,
    max_results: int = 5,
    topic: Literal["general", "news", "finance"] = "general",
    include_raw_content: bool = True,
    config: RunnableConfig = None
):
    """Execute multiple Tavily search queries asynchronously."""
    tavily_client = AsyncTavilyClient(api_key=get_tavily_api_key(config))

    search_tasks = [
        tavily_client.search(
            query,
            max_results=max_results,
            include_raw_content=include_raw_content,
            topic=topic
        )
        for query in search_queries
    ]

    search_results = await asyncio.gather(*search_tasks)
    return search_results


async def summarize_webpage(model: BaseChatModel, webpage_content: str) -> str:
    """Summarize webpage content using AI model with timeout protection."""
    try:
        prompt_content = summarize_webpage_prompt.format(
            webpage_content=webpage_content,
            date=get_today_str()
        )

        summary = await asyncio.wait_for(
            model.ainvoke([HumanMessage(content=prompt_content)]),
            timeout=60.0
        )

        formatted_summary = (
            f"<summary>\n{summary.summary}\n</summary>\n\n"
            f"<key_excerpts>\n{summary.key_excerpts}\n</key_excerpts>"
        )

        return formatted_summary

    except asyncio.TimeoutError:
        logging.warning("Summarization timed out after 60 seconds, returning original content")
        return webpage_content
    except Exception as e:
        logging.warning(f"Summarization failed with error: {str(e)}, returning original content")
        return webpage_content


@tool(description="Strategic reflection tool for research planning")
def think_tool(reflection: str) -> str:
    """Tool for strategic reflection on research progress and decision-making.

    Use this tool after each search to analyze results and plan next steps systematically.
    This creates a deliberate pause in the research workflow for quality decision-making.

    When to use:
    - After receiving search results: What key information did I find?
    - Before deciding next steps: Do I have enough to answer comprehensively?
    - When assessing research gaps: What specific information am I still missing?
    - Before concluding research: Can I provide a complete answer now?

    Reflection should address:
    1. Analysis of current findings - What concrete information have I gathered?
    2. Gap assessment - What crucial information is still missing?
    3. Quality evaluation - Do I have sufficient evidence/examples for a good answer?
    4. Strategic decision - Should I continue searching or provide my answer?

    Args:
        reflection: Your detailed reflection on research progress, findings, gaps, and next steps

    Returns:
        Confirmation that reflection was recorded for decision-making
    """
    return f"Reflection recorded: {reflection}"


################################################################################
# Token-limit helpers
################################################################################


def _check_openai_token_limit(exception, error_str):
    """Check if an OpenAI exception is due to token limits."""
    if "rate_limit_error" in type(exception).__name__:
        return "token" in error_str or "tpm" in error_str
    return "maximum context length" in error_str


def _check_anthropic_token_limit(exception, error_str):
    """Check if an Anthropic exception is due to token limits."""
    if "rate_limit_error" in type(exception).__name__:
        return "token" in error_str or "tpm" in error_str
    return "too many input tokens" in error_str or "output too long" in error_str


def _check_gemini_token_limit(exception, error_str):
    """Check if a Gemini exception is due to token limits."""
    if "rate_limit_error" in type(exception).__name__:
        return "token" in error_str or "tpm" in error_str
    return "maximum context length" in error_str


################################################################################
# Tool assembly
################################################################################

def get_config_value(value):
    """Extract value from configuration, handling enums and None values."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    elif isinstance(value, dict):
        return value
    else:
        return value.value


async def get_search_tool(search_api: SearchAPI):
    """Configure and return search tools based on the specified API provider."""
    if search_api == SearchAPI.ANTHROPIC:
        return [{"type": "web_search_20250305", "name": "web_search", "max_uses": 5}]

    elif search_api == SearchAPI.OPENAI:
        return [{"type": "web_search_preview"}]

    elif search_api == SearchAPI.TAVILY:
        search_tool = tavily_search
        search_tool.metadata = {
            **(search_tool.metadata or {}),
            "type": "search",
            "name": "web_search"
        }
        return [search_tool]

    elif search_api == SearchAPI.PARALLEL:
        from app.tools.parallel_search import parallel_configured
        if not parallel_configured():
            logging.warning("PARALLEL_API_KEY is not set; deep research falls back to DuckDuckGo search")
            return await get_search_tool(SearchAPI.DUCKDUCKGO)
        from .parallel_search import web_search
        web_search.metadata = {
            **(web_search.metadata or {}),
            "type": "search",
            "name": "web_search"
        }
        return [web_search]

    elif search_api == SearchAPI.DUCKDUCKGO:
        from .duckduckgo_search import duckduckgo_search_tool
        search_tool = duckduckgo_search_tool
        search_tool.metadata = {
            **(search_tool.metadata or {}),
            "type": "search",
            "name": "web_search"
        }
        return [search_tool]

    elif search_api == SearchAPI.NONE:
        return []

    return []


async def get_all_tools(config: RunnableConfig):
    """Assemble complete toolkit including research and search tools."""
    tools = [tool(ResearchComplete), think_tool]

    configurable = Configuration.from_runnable_config(config)
    search_api = SearchAPI(get_config_value(configurable.search_api))
    search_tools = await get_search_tool(search_api)
    tools.extend(search_tools)

    return tools


################################################################################
# Utils for summary, date, API keys, etc.
################################################################################

DUCKDUCKGO_TAVILY_SEARCH_DESCRIPTION = (
    "A DuckDuckGo search tool. Useful for when you need to answer questions about current events."
)


def get_today_str() -> str:
    """Get current date formatted for display in prompts and outputs."""
    now = datetime.now()
    return f"{now:%a} {now:%b} {now.day}, {now:%Y}"


def get_tavily_api_key(config: RunnableConfig):
    """Get Tavily API key from environment or config."""
    should_get_from_config = os.getenv("GET_API_KEYS_FROM_CONFIG", "false")
    if should_get_from_config.lower() == "true":
        api_keys = config.get("configurable", {}).get("apiKeys", {})
        if not api_keys:
            return None
        return api_keys.get("TAVILY_API_KEY")
    else:
        return os.getenv("TAVILY_API_KEY")
