"""LangSmith tracing bootstrap for OpenGPT.

This module centralises the tracing environment so the app starts with the
right LangSmith / LangChain settings before any traced nodes are imported.
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv


def configure_langsmith() -> dict[str, str | bool]:
    """Load env vars and normalise the tracing configuration.

    The app uses LangGraph/LangChain node tracing, so this should run before any
    module imports that create traced objects.
    """
    repo_root = Path(__file__).resolve().parents[1]
    load_dotenv(repo_root / ".env")
    load_dotenv(repo_root / ".env.local", override=False)

    tracing_flag = os.getenv("LANGSMITH_TRACING", os.getenv("LANGCHAIN_TRACING_V2", "false"))
    tracing_enabled = str(tracing_flag).strip().lower() in {"1", "true", "yes", "on"}
    project = os.getenv("LANGSMITH_PROJECT") or os.getenv("LANGCHAIN_PROJECT") or "OpenGPT"
    endpoint = os.getenv("LANGSMITH_ENDPOINT") or os.getenv(
        "LANGCHAIN_ENDPOINT", "https://api.smith.langchain.com"
    )
    api_key = os.getenv("LANGSMITH_API_KEY") or os.getenv("LANGCHAIN_API_KEY")

    os.environ.setdefault("LANGSMITH_TRACING", "true" if tracing_enabled else "false")
    os.environ.setdefault("LANGCHAIN_TRACING_V2", "true" if tracing_enabled else "false")
    os.environ.setdefault("LANGSMITH_PROJECT", project)
    os.environ.setdefault("LANGCHAIN_PROJECT", project)
    os.environ.setdefault("LANGSMITH_ENDPOINT", endpoint)
    os.environ.setdefault("LANGCHAIN_ENDPOINT", endpoint)
    if api_key:
        os.environ.setdefault("LANGSMITH_API_KEY", api_key)
        os.environ.setdefault("LANGCHAIN_API_KEY", api_key)

    return {
        "tracing_enabled": tracing_enabled,
        "project": project,
        "endpoint": endpoint,
    }
