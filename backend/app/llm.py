"""Model provider configuration.

OpenGPT works with any endpoint that speaks one of two APIs:

* LLM_PROVIDER=openai     the OpenAI Chat Completions API (OpenAI itself, or any
                          OpenAI-compatible server: set LLM_BASE_URL)
* LLM_PROVIDER=anthropic  the Anthropic Messages API (Anthropic itself, or any
                          Anthropic-compatible server: set LLM_BASE_URL)

Settings (backend/.env):
    LLM_PROVIDER        openai | anthropic (default: openai)
    LLM_API_KEY         API key for the endpoint
    LLM_BASE_URL        endpoint URL; leave unset for OpenAI / Anthropic themselves
    LLM_MODEL           main chat model (required)
    LLM_SMALL_MODEL     titles and summaries (default: LLM_MODEL)
    BLOG_MODEL          blog writer (default: LLM_MODEL)
    RESEARCH_MODEL      deep research (default: LLM_MODEL)
    LLM_MAX_TOKENS      max output tokens per call (default: 8192)
"""
import functools
import os
import re
from typing import Any, Optional

from langchain_core.language_models import BaseChatModel

OPENAI = "openai"
ANTHROPIC = "anthropic"
PROVIDERS = (OPENAI, ANTHROPIC)

# Placeholder values left in .env, e.g. "your_api_key_here" or
# "google_api_key", count as not set.
_PLACEHOLDER_RE = re.compile(r"^(your[_-].*|.*_here|[a-z_]+_api_key)$", re.I)


class LLMConfigError(RuntimeError):
    """The model provider settings are missing or invalid."""


def env(name: str) -> Optional[str]:
    """An environment variable, or None if it is empty or a placeholder."""
    value = (os.getenv(name) or "").strip()
    if not value or _PLACEHOLDER_RE.match(value):
        return None
    return value


@functools.lru_cache(maxsize=1)
def settings() -> dict:
    """Resolved provider settings. Raises LLMConfigError if incomplete."""
    provider = (env("LLM_PROVIDER") or OPENAI).lower()
    api_key = env("LLM_API_KEY")
    base_url = env("LLM_BASE_URL")
    model = env("LLM_MODEL")

    if provider not in PROVIDERS:
        raise LLMConfigError(f"LLM_PROVIDER must be 'openai' or 'anthropic', not {provider!r}.")
    # A self-hosted server may need no key, but then it needs a URL.
    if not api_key and not base_url:
        raise LLMConfigError(
            "No model API key is set. In backend/.env set LLM_API_KEY and LLM_MODEL "
            "(and LLM_BASE_URL for an OpenAI- or Anthropic-compatible server)."
        )
    if not model:
        raise LLMConfigError("LLM_MODEL is not set in backend/.env (the model name to use).")

    return {
        "provider": provider,
        "api_key": api_key or "not-needed",
        "base_url": base_url,
        "model": model,
        "small_model": env("LLM_SMALL_MODEL") or model,
        "blog_model": env("BLOG_MODEL") or model,
        "research_model": env("RESEARCH_MODEL") or model,
        "max_tokens": int(env("LLM_MAX_TOKENS") or 8192),
    }


def validate() -> None:
    """Check the settings at startup, so a mistake gives a clear message."""
    settings()


def model_name(role: str = "model") -> str:
    """Configured model name for a role: model, small_model, blog_model, research_model."""
    return settings()[role]


@functools.lru_cache(maxsize=32)
def _build(model: str, max_tokens: int, temperature: Optional[float]) -> BaseChatModel:
    cfg = settings()
    common: dict[str, Any] = {"model": model, "api_key": cfg["api_key"], "max_tokens": max_tokens}
    if temperature is not None:
        common["temperature"] = temperature
    if cfg["base_url"]:
        common["base_url"] = cfg["base_url"]
    if cfg["provider"] == ANTHROPIC:
        from langchain_anthropic import ChatAnthropic
        return ChatAnthropic(**common)
    from langchain_openai import ChatOpenAI
    return ChatOpenAI(**common)


def chat_model(
    model: Optional[str] = None,
    *,
    max_tokens: Optional[int] = None,
    temperature: Optional[float] = None,
    tags: Optional[list] = None,
) -> BaseChatModel:
    """A chat model for the configured provider (cached per model and limits)."""
    llm = _build(model or model_name(), max_tokens or settings()["max_tokens"], temperature)
    return llm.with_config(tags=tags) if tags else llm


def structured(llm, schema, **retry):
    """`llm.with_structured_output(schema)` using a method the provider supports.

    OpenAI-compatible servers get JSON mode: some reject a forced tool call
    when the model answers in text. Anthropic uses tool calling.
    """
    method = "function_calling" if settings()["provider"] == ANTHROPIC else "json_mode"
    out = llm.with_structured_output(schema, method=method)
    return out.with_retry(**retry) if retry else out


class LazyChatModel:
    """Builds the chat model on first use instead of at import time, so a
    missing setting is reported at startup with a clear message rather than
    as an import traceback."""

    def __init__(self, role: str = "model"):
        self._role = role

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)

        # Return a stand-in method that builds the model only when called.
        # LangGraph inspects node functions when a graph is compiled (it reads
        # attributes such as ``model.bind_tools``); that must not build a model
        # or need the provider settings at import time.
        def method(*args, **kwargs):
            return getattr(chat_model(model_name(self._role)), name)(*args, **kwargs)

        method.__name__ = name
        return method


def split_content(chunk) -> tuple[str, str]:
    """Split a streamed message chunk into (answer text, reasoning text).

    Providers differ: OpenAI-compatible hosts send a string (reasoning, if any,
    in additional_kwargs), Anthropic sends a list of text/thinking blocks.
    """
    content = chunk.content
    reasoning = chunk.additional_kwargs.get("reasoning_content") or ""
    if isinstance(content, str):
        return content, reasoning
    text_parts = []
    for block in content or []:
        if isinstance(block, str):
            text_parts.append(block)
        elif block.get("type") == "text":
            text_parts.append(block.get("text", ""))
        elif block.get("type") in ("thinking", "reasoning"):
            reasoning += block.get("thinking") or block.get("reasoning") or ""
    return "".join(text_parts), reasoning
