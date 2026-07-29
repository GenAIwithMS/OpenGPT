"""DuckDuckGo search tool for the deep research agent."""

from typing import List, Annotated, Literal

from langchain_core.tools import InjectedToolArg, tool
from langchain_core.runnables import RunnableConfig
from duckduckgo_search import DDGS


@tool
async def duckduckgo_search_tool(
    queries: List[str],
    max_results: Annotated[int, InjectedToolArg] = 5,
    config: RunnableConfig = None,
) -> str:
    """Search the web using DuckDuckGo. Useful for answering questions about current events when no paid search API is configured."""
    all_results = []
    for query in queries:
        try:
            with DDGS() as ddgs:
                results = list(ddgs.text(query, max_results=max_results))
                for r in results:
                    all_results.append({
                        "title": r.get("title", ""),
                        "url": r.get("href", ""),
                        "content": r.get("body", ""),
                        "query": query,
                    })
        except Exception as e:
            all_results.append({
                "title": "Error",
                "url": "",
                "content": f"DuckDuckGo search failed for '{query}': {e}",
                "query": query,
            })

    if not all_results:
        return "No results found."

    formatted = "Search results:\n\n"
    for i, r in enumerate(all_results):
        formatted += f"\n--- SOURCE {i+1}: {r['title']} ---\n"
        formatted += f"URL: {r['url']}\n\n"
        formatted += f"{r['content']}\n"
        formatted += "\n" + "-" * 80 + "\n"

    return formatted
