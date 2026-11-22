"""Model providers (Settings > Developer).

The provider in backend/.env (LLM_*) is always available as "From .env".
More providers can be added here; their API keys are stored encrypted
(app/secret_box.py) and never sent back to the browser. One provider is
active at a time, with a model for each job:

    model           chat
    small_model     chat titles and short summaries
    research_model  deep research
    blog_model      blog writer
    coding_model    the coding agent (Code page)
    agent_model     the agent (Agent page)

An empty role uses the provider's default model. Changing the active
provider or its models takes effect at once (app/llm.py is reloaded) and
restarts the coding agent.
"""
import json
import re
import uuid
from typing import Optional
from urllib.parse import urlparse

import httpx

from app import secret_box
from app.database.config import DatabaseConfig
from app.database.models import AppSetting
from app.exceptions import NotFoundError, ValidationError

SETTINGS_KEY = "providers"
ENV_ID = "env"
ROLES = ("model", "small_model", "research_model", "blog_model", "coding_model", "agent_model")
MAX_PROVIDERS = 30
KINDS = ("openai", "anthropic")
TIMEOUT = httpx.Timeout(15.0)

# Ready-made settings for common services. "openai" means the OpenAI-compatible
# Chat Completions API; most services offer it.
PRESETS = [
    {"id": "openai", "name": "OpenAI", "kind": "openai", "base_url": "https://api.openai.com/v1",
     "keys_url": "https://platform.openai.com/api-keys"},
    {"id": "anthropic", "name": "Anthropic", "kind": "anthropic", "base_url": "https://api.anthropic.com",
     "keys_url": "https://console.anthropic.com/settings/keys"},
    {"id": "gemini", "name": "Google Gemini", "kind": "openai",
     "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
     "keys_url": "https://aistudio.google.com/apikey"},
    {"id": "openrouter", "name": "OpenRouter", "kind": "openai", "base_url": "https://openrouter.ai/api/v1",
     "keys_url": "https://openrouter.ai/keys"},
    {"id": "mistral", "name": "Mistral AI", "kind": "openai", "base_url": "https://api.mistral.ai/v1",
     "keys_url": "https://console.mistral.ai/api-keys"},
    {"id": "deepseek", "name": "DeepSeek", "kind": "openai", "base_url": "https://api.deepseek.com/v1",
     "keys_url": "https://platform.deepseek.com/api_keys"},
    {"id": "xai", "name": "xAI", "kind": "openai", "base_url": "https://api.x.ai/v1",
     "keys_url": "https://console.x.ai"},
    {"id": "groq", "name": "Groq", "kind": "openai", "base_url": "https://api.groq.com/openai/v1",
     "keys_url": "https://console.groq.com/keys"},
    {"id": "together", "name": "Together AI", "kind": "openai", "base_url": "https://api.together.xyz/v1",
     "keys_url": "https://api.together.ai/settings/api-keys"},
    {"id": "fireworks", "name": "Fireworks AI", "kind": "openai", "base_url": "https://api.fireworks.ai/inference/v1",
     "keys_url": "https://fireworks.ai/account/api-keys"},
    {"id": "cerebras", "name": "Cerebras", "kind": "openai", "base_url": "https://api.cerebras.ai/v1",
     "keys_url": "https://cloud.cerebras.ai"},
    {"id": "huggingface", "name": "Hugging Face", "kind": "openai", "base_url": "https://router.huggingface.co/v1",
     "keys_url": "https://huggingface.co/settings/tokens"},
    {"id": "ollama", "name": "Ollama", "kind": "openai", "base_url": "http://localhost:11434/v1",
     "local": True, "keys_url": None},
    {"id": "lmstudio", "name": "LM Studio", "kind": "openai", "base_url": "http://localhost:1234/v1",
     "local": True, "keys_url": None},
    {"id": "llamacpp", "name": "llama.cpp", "kind": "openai", "base_url": "http://localhost:8080/v1",
     "local": True, "keys_url": None},
    {"id": "jan", "name": "Jan", "kind": "openai", "base_url": "http://localhost:1337/v1",
     "local": True, "keys_url": None},
    {"id": "custom", "name": "Custom", "kind": "openai", "base_url": "", "keys_url": None},
]
_PRESETS = {p["id"]: p for p in PRESETS}


# ---------------------------------------------------------------- storage

def _session():
    return DatabaseConfig.get_session_factory()()


def _load() -> dict:
    with _session() as db:
        row = db.get(AppSetting, SETTINGS_KEY)
        try:
            data = json.loads(row.value) if row else {}
        except (TypeError, ValueError):
            data = {}
    roles = data.get("roles") or {}
    return {
        "items": list(data.get("items") or []),
        "active": data.get("active") or ENV_ID,
        "roles": {r: str(roles.get(r) or "") for r in ROLES},
    }


def _save(data: dict) -> None:
    with _session() as db:
        row = db.get(AppSetting, SETTINGS_KEY)
        value = json.dumps(data)
        if row is None:
            db.add(AppSetting(key=SETTINGS_KEY, value=value))
        else:
            row.value = value
        db.commit()


def _changed() -> None:
    """Use the new settings now: chat at once, the coding agent after a restart."""
    import threading

    from app import llm
    from app.services.coding_agent.process import agent

    llm.reload()
    forget_models()
    threading.Thread(target=agent.restart, daemon=True).start()


# ---------------------------------------------------------------- validation

def _clean_url(url: str, required: bool) -> str:
    url = (url or "").strip().rstrip("/")
    if not url:
        if required:
            raise ValidationError("Base URL is required for this provider")
        return ""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or len(url) > 500:
        raise ValidationError("Base URL: use an http:// or https:// address")
    return url


def _clean_text(value: Optional[str], what: str, limit: int, pattern: str = r"^[^\x00-\x1f]*$") -> str:
    value = (value or "").strip()
    if len(value) > limit or not re.match(pattern, value):
        raise ValidationError(f"{what} is too long or has invalid characters")
    return value


def _public(item: dict) -> dict:
    preset = _PRESETS.get(item.get("preset") or "custom", _PRESETS["custom"])
    return {
        "id": item["id"], "preset": preset["id"], "name": item["name"], "kind": item["kind"],
        "base_url": item.get("base_url") or "", "model": item.get("model") or "",
        "has_key": bool(item.get("api_key")),
    }


def _env_info() -> dict:
    from app import llm

    try:
        cfg = llm.env_settings()
        # No address or key: the browser only needs to show "Default" and its models.
        return {"configured": True, "kind": cfg["provider"],
                "model": cfg["model"], "has_key": cfg["api_key"] != "not-needed",
                "roles": {r: cfg[r] for r in ROLES}}
    except llm.LLMConfigError as e:
        return {"configured": False, "error": str(e)}


# ---------------------------------------------------------------- public API

def overview() -> dict:
    data = _load()
    return {
        "env": _env_info(),
        "providers": [_public(i) for i in data["items"]],
        "active": data["active"],
        "roles": data["roles"],
        "presets": PRESETS,
    }


def create(preset: str, name: str = "", base_url: str = "", api_key: str = "", model: str = "",
           kind: Optional[str] = None) -> dict:
    spec = _PRESETS.get(preset)
    if spec is None:
        raise ValidationError("Unknown provider type")
    data = _load()
    if len(data["items"]) >= MAX_PROVIDERS:
        raise ValidationError(f"At most {MAX_PROVIDERS} providers")
    kind = kind if preset == "custom" else spec["kind"]
    if kind not in KINDS:
        raise ValidationError("API type must be openai or anthropic")
    url = _clean_url(base_url or spec["base_url"], required=True)
    key = _clean_text(api_key, "API key", 1000)
    if not key and not spec.get("local") and preset != "custom":
        raise ValidationError("Enter the API key")
    item = {
        "id": uuid.uuid4().hex[:12], "preset": preset, "kind": kind,
        "name": _clean_text(name, "Name", 60) or spec["name"],
        "base_url": url, "model": _clean_text(model, "Model", 200),
        "api_key": secret_box.encrypt(key) if key else "",
    }
    data["items"].append(item)
    _save(data)
    return _public(item)


def update(provider_id: str, changes: dict) -> dict:
    data = _load()
    item = next((i for i in data["items"] if i["id"] == provider_id), None)
    if item is None:
        raise NotFoundError("Provider not found")
    if "name" in changes:
        item["name"] = _clean_text(changes["name"], "Name", 60) or item["name"]
    if "base_url" in changes:
        item["base_url"] = _clean_url(changes["base_url"], required=True)
    if "model" in changes:
        item["model"] = _clean_text(changes["model"], "Model", 200)
    if changes.get("api_key"):   # empty = keep the stored key
        item["api_key"] = secret_box.encrypt(_clean_text(changes["api_key"], "API key", 1000))
    if changes.get("clear_key"):
        item["api_key"] = ""
    _save(data)
    if data["active"] == provider_id:
        _changed()
    return _public(item)


def delete(provider_id: str) -> None:
    data = _load()
    before = len(data["items"])
    data["items"] = [i for i in data["items"] if i["id"] != provider_id]
    if len(data["items"]) == before:
        raise NotFoundError("Provider not found")
    was_active = data["active"] == provider_id
    if was_active:
        data["active"] = ENV_ID
        data["roles"] = {r: "" for r in ROLES}
    _save(data)
    if was_active:
        _changed()


def set_active(active: str, roles: dict) -> dict:
    """Choose the provider and the model for each job."""
    data = _load()
    if active != ENV_ID:
        item = next((i for i in data["items"] if i["id"] == active), None)
        if item is None:
            raise NotFoundError("Provider not found")
        if not (roles.get("model") or item.get("model")):
            raise ValidationError("Choose the chat model for this provider")
    elif not _env_info()["configured"]:
        raise ValidationError("The default provider isn't set up")
    data["active"] = active
    data["roles"] = {r: _clean_text(roles.get(r), "Model", 200) for r in ROLES}
    _save(data)
    _changed()
    return overview()


def active_settings() -> Optional[dict]:
    """The saved active provider for app/llm.py, or None to use backend/.env.
    {provider, api_key, base_url, model} plus the roles chosen here."""
    data = _load()
    roles = {r: v for r, v in data["roles"].items() if v}
    if data["active"] == ENV_ID:
        return {"env": True, "roles": roles}
    item = next((i for i in data["items"] if i["id"] == data["active"]), None)
    if item is None:
        return {"env": True, "roles": {}}
    key = secret_box.decrypt(item["api_key"], default="") if item.get("api_key") else ""
    return {
        "env": False, "roles": roles, "provider": item["kind"], "api_key": key or "not-needed",
        "base_url": item.get("base_url") or None, "model": roles.get("model") or item.get("model") or "",
    }


# ---------------------------------------------------------------- testing a provider

def _list_models(kind: str, base_url: str, api_key: str) -> list[str]:
    if kind == "anthropic":
        url = f"{(base_url or 'https://api.anthropic.com').rstrip('/')}/v1/models?limit=1000"
        headers = {"anthropic-version": "2023-06-01"}
        if api_key:
            headers["x-api-key"] = api_key
    else:
        url = f"{base_url.rstrip('/')}/models"
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    try:
        r = httpx.get(url, headers=headers, timeout=TIMEOUT)
    except httpx.HTTPError:
        from app.services import local_models

        raise ValidationError(local_models.unreachable_message(url)
                              or f"Couldn't reach {urlparse(url).netloc}. Check the base URL.") from None
    if r.status_code in (401, 403):
        raise ValidationError("The API key was refused")
    if r.status_code == 404:
        raise ValidationError("No model list at this address. Check the base URL (it usually ends in /v1).")
    if r.status_code >= 400:
        raise ValidationError(f"The provider answered {r.status_code}")
    try:
        body = r.json()
    except ValueError:
        raise ValidationError("The provider's answer wasn't JSON. Check the base URL.") from None
    items = body.get("data") if isinstance(body, dict) else body
    names = {str(m.get("id")) for m in (items or []) if isinstance(m, dict) and m.get("id")}
    return sorted(names)[:1000]


def test(provider_id: Optional[str] = None, kind: str = "openai", base_url: str = "",
         api_key: str = "", preset: Optional[str] = None) -> dict:
    """Connect and list the provider's models: {ok, models}. Raises ValidationError."""
    if provider_id == ENV_ID:
        from app import llm
        cfg = llm.env_settings()
        kind, base_url = cfg["provider"], cfg["base_url"] or ""
        api_key = "" if cfg["api_key"] == "not-needed" else cfg["api_key"]
    elif provider_id:
        item = next((i for i in _load()["items"] if i["id"] == provider_id), None)
        if item is None:
            raise NotFoundError("Provider not found")
        kind, base_url = item["kind"], item.get("base_url") or ""
        api_key = secret_box.decrypt(item["api_key"], default="") if item.get("api_key") else ""
    else:
        spec = _PRESETS.get(preset or "custom", _PRESETS["custom"])
        kind = kind if (preset or "custom") == "custom" else spec["kind"]
        base_url = _clean_url(base_url or spec["base_url"], required=kind != "anthropic")
        api_key = _clean_text(api_key, "API key", 1000)
    if kind == "openai" and not base_url:
        base_url = "https://api.openai.com/v1"
    models = _list_models(kind, base_url, api_key)
    return {"ok": True, "models": models}


# ---------------------------------------------------------------- the model menu

MODELS_CACHE_SECONDS = 600
# Model ids that are clearly not chat models (embeddings, speech, safety filters, images).
_NOT_CHAT = re.compile(r"embed|whisper|tts|speech|transcri|moderation|guard|rerank|dall-e|image|orpheus|audio", re.I)
MAX_MENU_MODELS = 200
_models_cache: dict = {}


def available_models() -> list[str]:
    """Models for the menu next to the send button (and the coding agent's
    config): the models chosen for each job first, then the active provider's
    list (cached for 10 minutes). Never raises: without a list, only the
    chosen models are offered."""
    import time

    from app import llm
    from app.services.model_router import unique

    try:
        cfg = llm.settings()
    except llm.LLMConfigError:
        return []
    chosen = [cfg[r] for r in ROLES]
    active = _load()["active"]
    cached = _models_cache.get(active)
    if cached and time.time() - cached[0] < MODELS_CACHE_SECONDS:
        listed = cached[1]
    else:
        try:
            listed = test(provider_id=active)["models"]
        except Exception:  # noqa: BLE001 - offline, no list endpoint, refused key
            listed = []
        _models_cache[active] = (time.time(), listed)
    listed = [m for m in listed if not _NOT_CHAT.search(m)]
    return unique(chosen + listed)[:MAX_MENU_MODELS]


def forget_models() -> None:
    _models_cache.clear()
