"""Settings for the coding agent service and its model config.

The agent gets its model from the same LLM_* settings as the chat (see
app/llm.py), so there is one place to configure the model.

Settings (backend/.env):
    CODING_AGENT_ENABLED   true | false. Default: on while HOST is local, off
                           when the API is exposed (it can run commands).
    CODING_AGENT_URL       use an agent you started yourself instead of
                           letting the backend start one
    CODING_AGENT_PASSWORD  that agent's password (with CODING_AGENT_URL)
    CODING_AGENT_PORT      port for the agent the backend starts (default:
                           a free port)
    CODING_AGENT_DIR       the coding-agent folder (default: <repo>/coding-agent)
    BUN_PATH               the bun executable (default: found on PATH)
    CODING_AGENT_START_TIMEOUT  seconds to wait for the agent to start (default 90)
"""
import json
import os
from pathlib import Path
from typing import Optional

from app import llm
from app.security import is_local_host

# The agent's built-in names for the two API styles.
_PACKAGES = {
    llm.OPENAI: "@opencode/ai/providers/openai-compatible",
    llm.ANTHROPIC: "@opencode/ai/providers/anthropic-compatible",
}
# The agent needs an explicit endpoint; these are used when LLM_BASE_URL is empty.
_DEFAULT_BASE_URLS = {
    llm.OPENAI: "https://api.openai.com/v1",
    llm.ANTHROPIC: "https://api.anthropic.com/v1",
}
PROVIDER_ID = "opengpt"
AGENT_USER = "opengpt"

REPO_ROOT = Path(__file__).resolve().parents[4]


def _flag(name: str) -> Optional[bool]:
    value = os.getenv(name)
    if value is None or not value.strip():
        return None
    return value.strip().lower() in {"1", "true", "yes", "on"}


def enabled() -> bool:
    """Whether the coding agent is on. Off by default when the API is exposed."""
    flag = _flag("CODING_AGENT_ENABLED")
    if flag is not None:
        return flag
    return is_local_host(os.getenv("HOST", "127.0.0.1"))


def external_url() -> Optional[str]:
    url = (os.getenv("CODING_AGENT_URL") or "").strip().rstrip("/")
    return url or None


def external_password() -> Optional[str]:
    return llm.env("CODING_AGENT_PASSWORD")


def agent_dir() -> Path:
    custom = (os.getenv("CODING_AGENT_DIR") or "").strip()
    return Path(custom).expanduser().resolve() if custom else REPO_ROOT / "coding-agent"


def port() -> int:
    """0 means pick a free port."""
    try:
        return int(os.getenv("CODING_AGENT_PORT") or 0)
    except ValueError:
        return 0


def start_timeout() -> float:
    try:
        return float(os.getenv("CODING_AGENT_START_TIMEOUT") or 90)
    except ValueError:
        return 90.0


def model_config() -> dict:
    """The agent's config: one provider built from LLM_*, used as the default model."""
    cfg = llm.settings()
    provider = cfg["provider"]
    model = cfg["model"]
    settings = {"baseURL": cfg["base_url"] or _DEFAULT_BASE_URLS[provider]}
    # "not-needed" is app/llm.py's stand-in for a server that takes no key.
    if cfg["api_key"] and cfg["api_key"] != "not-needed":
        settings["apiKey"] = cfg["api_key"]
    return {
        "providers": {
            PROVIDER_ID: {
                "name": "OpenGPT",
                "package": _PACKAGES[provider],
                "settings": settings,
                "models": {model: {"name": model}},
            }
        },
        "model": f"{PROVIDER_ID}/{model}",
        # No session sharing links and no self-updates.
        "share": "disabled",
        "update": "disable",
    }


def model_config_json() -> str:
    return json.dumps(model_config())
