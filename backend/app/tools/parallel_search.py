"""Web search through Parallel (https://parallel.ai), shared by the chatbot's
Search tool and the deep research agent.

Follows the Search API best practices: send ``objective`` together with 1-5
short keyword ``search_queries``, reuse one ``session_id`` for all calls of
the same task, and tell the API which model consumes the results.
"""

import logging
import os
from typing import List, Optional

MAX_QUERIES = 5
MAX_QUERY_CHARS = 200
MAX_OBJECTIVE_CHARS = 5000
MAX_CHARS_PER_CALL = 6000


def parallel_configured() -> bool:
    return bool(os.getenv("PARALLEL_API_KEY"))


def _request_args(queries, objective, mode, max_chars, session_id, client_model):
    queries = [q.strip()[:MAX_QUERY_CHARS] for q in queries if q and q.strip()][:MAX_QUERIES]
    if not queries:
        raise ValueError("At least one search query is required")
    return {
        "search_queries": queries,
        "objective": (objective or "").strip()[:MAX_OBJECTIVE_CHARS] or None,
        "mode": mode,
        "max_chars_total": max_chars,
        "session_id": session_id or None,
        "client_model": client_model or None,
    }


def format_results(response) -> str:
    """Render results in the ``--- SOURCE n: title ---`` layout the deep
    research agent parses for its source list."""
    for warning in response.warnings or []:
        logging.warning("Parallel search warning: %s", warning.message)
    results = response.results
    if not results:
        return "No results found."
    lines = ["Search results:", ""]
    for i, r in enumerate(results, 1):
        lines.append(f"--- SOURCE {i}: {r.title or r.url} ---")
        lines.append(f"URL: {r.url}")
        if r.publish_date:
            lines.append(f"Published: {r.publish_date}")
        lines.append("")
        lines.append("\n".join(r.excerpts))
        lines.append("")
        lines.append("-" * 80)
    return "\n".join(lines)


def search(
    queries: List[str],
    objective: Optional[str] = None,
    mode: str = "fast",
    max_chars: int = MAX_CHARS_PER_CALL,
    session_id: Optional[str] = None,
    client_model: Optional[str] = None,
) -> str:
    """Run one Parallel search over ``queries`` and return formatted results."""
    from parallel import Parallel

    client = Parallel(api_key=os.getenv("PARALLEL_API_KEY"))
    response = client.search(**_request_args(queries, objective, mode, max_chars, session_id, client_model))
    return format_results(response)


async def search_async(
    queries: List[str],
    objective: Optional[str] = None,
    mode: str = "fast",
    max_chars: int = MAX_CHARS_PER_CALL,
    session_id: Optional[str] = None,
    client_model: Optional[str] = None,
) -> str:
    from parallel import AsyncParallel

    client = AsyncParallel(api_key=os.getenv("PARALLEL_API_KEY"))
    response = await client.search(**_request_args(queries, objective, mode, max_chars, session_id, client_model))
    return format_results(response)
