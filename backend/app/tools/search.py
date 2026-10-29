import os
import requests
from dotenv import load_dotenv
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool

from app.tools.parallel_search import parallel_configured, search as parallel_search

load_dotenv()

BRAVE_API_KEY = os.getenv("BRAVE_API_KEY")
BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search"
# Model that reads the results (see app/services/chatbot.py); lets Parallel tune its output
CHAT_MODEL = "openai/gpt-oss-120b"


def _brave_search(query: str) -> str:
    """Fallback search through Brave when Parallel is not configured."""
    if not BRAVE_API_KEY:
        return "No search provider is configured (set PARALLEL_API_KEY or BRAVE_API_KEY)."

    headers = {
        "X-Subscription-Token": BRAVE_API_KEY,
        "Accept": "application/json",
    }
    params = {"q": query, "count": 5}

    try:
        resp = requests.get(BRAVE_ENDPOINT, headers=headers, params=params, timeout=15)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        return f"Brave Search request failed: {e}"

    results = data.get("web", {}).get("results", [])
    if not results:
        return "No results found."

    lines = []
    for r in results[:5]:
        title = r.get("title", "")
        url = r.get("url", "")
        desc = r.get("description", "")
        lines.append(f"{title}\n{url}\n{desc}")

    return "\n\n".join(lines)


@tool(parse_docstring=True)
def Search(query: str, objective: str, config: RunnableConfig) -> str:
    """Search the web for up-to-date information.

    Args:
        query: A concise keyword query, 3-6 words, naming the key entity or topic.
        objective: One self-contained sentence saying what you want to find out and why.
    """
    if not parallel_configured():
        return _brave_search(query)

    # The conversation thread is the task: its searches share one session
    thread_id = (config.get("configurable", {}) if config else {}).get("thread_id")
    try:
        return parallel_search(
            [query],
            objective=objective,
            mode="fast",
            max_chars=4000,
            session_id=f"thread-{thread_id}" if thread_id else None,
            client_model=CHAT_MODEL,
        )
    except Exception as e:
        return f"Web search failed: {e}"
