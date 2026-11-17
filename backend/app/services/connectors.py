"""Connectors (Settings > Connectors): MCP servers that give the assistant tools.

A connector is either
    local   a command that starts an MCP server on this computer (e.g. npx ...)
    remote  the URL of an MCP server (Streamable HTTP)

Secrets (environment variables of local servers, headers of remote ones)
are stored encrypted (app/secret_box.py) and never returned to the browser:
the API only says which names are set.

Nothing from the catalog runs until the user adds it: adding a local server
can download its package (npm/PyPI) when it first starts.
The coding agent asks before using any MCP tool (sessions.PERMISSION_RULES
doesn't allow them), and gets the enabled connectors in its config.
"""
import json
import logging
import re
import shlex
import uuid
from typing import Any, Optional
from urllib.parse import urlparse

from app import secret_box
from app.services import connector_oauth
from app.database.config import DatabaseConfig
from app.database.models import Connector
from app.exceptions import ConflictError, NotFoundError, ValidationError

logger = logging.getLogger(__name__)

MAX_CONNECTORS = 30
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,47}$")
_ENV_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
_HEADER_RE = re.compile(r"^[A-Za-z0-9-]{1,64}$")
_SECRET_MAX = 4096

# Well-known open MCP servers. Shown in "Browse connectors"; none is added or run by default.
# `env`/`headers`: values the user fills in; "{VALUE}" in a header template is replaced.
# `auth`: "oauth" = sign in on the provider's page (GitHub needs its OAuth app in
# backend/.env, otherwise it falls back to a token); "key" = asks for a key; none.
CATALOG = [
    {"id": "github", "name": "GitHub", "category": "Development", "kind": "remote", "auth": "oauth",
     "oauth_preset": "github", "url": "https://api.githubcopilot.com/mcp/",
     "description": "Repositories, issues, pull requests and code search on GitHub.",
     "headers": [{"name": "Authorization", "label": "GitHub personal access token", "template": "Bearer {VALUE}",
                  "required": True}],
     "homepage": "https://github.com/github/github-mcp-server"},
    {"id": "notion", "name": "Notion", "category": "Productivity", "kind": "remote", "auth": "oauth",
     "url": "https://mcp.notion.com/mcp",
     "description": "Search, read and update pages and databases in your Notion workspace.",
     "homepage": "https://developers.notion.com/docs/mcp"},
    {"id": "linear", "name": "Linear", "category": "Productivity", "kind": "remote", "auth": "oauth",
     "url": "https://mcp.linear.app/mcp",
     "description": "Find, create and update issues, projects and comments in Linear.",
     "homepage": "https://linear.app/docs/mcp"},
    {"id": "sentry", "name": "Sentry", "category": "Development", "kind": "remote", "auth": "oauth",
     "url": "https://mcp.sentry.dev/mcp",
     "description": "Look up errors, issues and releases in Sentry.",
     "homepage": "https://docs.sentry.io/product/sentry-mcp/"},
    {"id": "vercel", "name": "Vercel", "category": "Development", "kind": "remote", "auth": "oauth",
     "url": "https://mcp.vercel.com/",
     "description": "Projects, deployments and logs on Vercel.",
     "homepage": "https://vercel.com/docs/mcp/vercel-mcp"},
    {"id": "canva", "name": "Canva", "category": "Design", "kind": "remote", "auth": "oauth",
     "url": "https://mcp.canva.com/mcp",
     "description": "Find, create and edit designs in Canva.",
     "homepage": "https://www.canva.dev/docs/connect/canva-mcp-server-setup/"},
    {"id": "stripe", "name": "Stripe", "category": "Finance", "kind": "remote", "auth": "oauth",
     "url": "https://mcp.stripe.com/",
     "description": "Customers, payments, invoices and products in your Stripe account.",
     "homepage": "https://docs.stripe.com/mcp"},
    {"id": "paypal", "name": "PayPal", "category": "Finance", "kind": "remote", "auth": "oauth",
     "url": "https://mcp.paypal.com/mcp",
     "description": "Invoices, orders, products and transactions in your PayPal account.",
     "homepage": "https://developer.paypal.com/tools/mcp-server/"},
    {"id": "context7", "auth": "key", "name": "Context7", "category": "Development", "kind": "remote",
     "url": "https://mcp.context7.com/mcp",
     "description": "Up-to-date documentation and code examples for libraries and frameworks.",
     "headers": [{"name": "CONTEXT7_API_KEY", "label": "API key (optional)", "template": "{VALUE}", "required": False}],
     "homepage": "https://github.com/upstash/context7"},
    {"id": "git", "name": "Git", "category": "Development", "kind": "local",
     "command": ["uvx", "mcp-server-git"],
     "description": "Read and search git repositories: status, log, diffs, branches.",
     "requires": "uv", "homepage": "https://github.com/modelcontextprotocol/servers/tree/main/src/git"},
    {"id": "playwright", "name": "Playwright", "category": "Browser", "kind": "local",
     "command": ["npx", "-y", "@playwright/mcp"],
     "description": "Control a web browser: open pages, click, fill forms, take screenshots.",
     "requires": "Node.js", "homepage": "https://github.com/microsoft/playwright-mcp"},
    {"id": "chrome-devtools", "name": "Chrome DevTools", "category": "Browser", "kind": "local",
     "command": ["npx", "-y", "chrome-devtools-mcp"],
     "description": "Inspect and debug pages in Chrome: console, network, performance.",
     "requires": "Node.js and Chrome", "homepage": "https://github.com/ChromeDevTools/chrome-devtools-mcp"},
    {"id": "fetch", "name": "Fetch", "category": "Web", "kind": "local",
     "command": ["uvx", "mcp-server-fetch"],
     "description": "Fetch a web page and convert it to readable text.",
     "requires": "uv", "homepage": "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch"},
    {"id": "brave-search", "auth": "key", "name": "Brave Search", "category": "Web", "kind": "local",
     "command": ["npx", "-y", "@brave/brave-search-mcp-server"],
     "description": "Web, news and image search through the Brave Search API.",
     "env": [{"name": "BRAVE_API_KEY", "label": "Brave Search API key", "required": True}],
     "requires": "Node.js", "homepage": "https://github.com/brave/brave-search-mcp-server"},
    {"id": "firecrawl", "auth": "key", "name": "Firecrawl", "category": "Web", "kind": "local",
     "command": ["npx", "-y", "firecrawl-mcp"],
     "description": "Scrape and crawl websites into clean text.",
     "env": [{"name": "FIRECRAWL_API_KEY", "label": "Firecrawl API key", "required": True}],
     "requires": "Node.js", "homepage": "https://github.com/mendableai/firecrawl-mcp-server"},
    {"id": "memory", "name": "Memory", "category": "Productivity", "kind": "local",
     "command": ["npx", "-y", "@modelcontextprotocol/server-memory"],
     "description": "A small knowledge graph the assistant can remember facts in.",
     "requires": "Node.js", "homepage": "https://github.com/modelcontextprotocol/servers/tree/main/src/memory"},
    {"id": "sequential-thinking", "name": "Sequential Thinking", "category": "Productivity", "kind": "local",
     "command": ["npx", "-y", "@modelcontextprotocol/server-sequential-thinking"],
     "description": "Structured step-by-step reasoning for complex problems.",
     "requires": "Node.js",
     "homepage": "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking"},
    {"id": "time", "name": "Time", "category": "Productivity", "kind": "local",
     "command": ["uvx", "mcp-server-time"],
     "description": "Current time and time zone conversions.",
     "requires": "uv", "homepage": "https://github.com/modelcontextprotocol/servers/tree/main/src/time"},
]
_CATALOG_BY_ID = {c["id"]: c for c in CATALOG}


# ----- validation -----

def _clean_name(name: str) -> str:
    name = (name or "").strip().lower().replace(" ", "-")
    if not _NAME_RE.match(name):
        raise ValidationError("Name: use lowercase letters, digits, - and _ (up to 48), starting with a letter or digit")
    return name


def _clean_command(command: Any) -> list[str]:
    if isinstance(command, str):
        try:
            command = shlex.split(command)
        except ValueError:
            raise ValidationError("Command: check the quotes") from None
    if not isinstance(command, list) or not command or len(command) > 30:
        raise ValidationError("Command is required (a program and its arguments)")
    out = []
    for part in command:
        if not isinstance(part, str) or not part or len(part) > 500 or "\x00" in part:
            raise ValidationError("Command: each part must be text of up to 500 characters")
        out.append(part)
    return out


def _clean_url(url: str) -> str:
    url = (url or "").strip()
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or len(url) > 2000:
        raise ValidationError("URL: use an http:// or https:// address")
    return url


def _clean_pairs(values: Any, pattern: re.Pattern, what: str) -> dict[str, str]:
    if values in (None, ""):
        return {}
    if not isinstance(values, dict) or len(values) > 30:
        raise ValidationError(f"{what}: expected up to 30 name/value pairs")
    out = {}
    for key, value in values.items():
        if not isinstance(key, str) or not pattern.match(key):
            raise ValidationError(f"{what}: invalid name {key!r}")
        if not isinstance(value, str) or len(value) > _SECRET_MAX or "\n" in value:
            raise ValidationError(f"{what}: invalid value for {key}")
        out[key] = value
    return out


# ----- storage -----

def _session():
    return DatabaseConfig.get_session_factory()()


def _secrets(row: Connector) -> dict:
    data = secret_box.decrypt(row.secrets, default={}) or {}
    return {"env": data.get("env") or {}, "headers": data.get("headers") or {}, "oauth": data.get("oauth")}


def _info(row: Connector) -> dict:
    """What the browser sees: never secret values, only their names."""
    secrets = _secrets(row)
    entry = _CATALOG_BY_ID.get(row.catalog_id or "")
    return {
        "id": row.id,
        "name": row.name,
        "title": entry["name"] if entry else row.name,
        "description": entry["description"] if entry else None,
        "kind": row.kind,
        "command": json.loads(row.command) if row.command else None,
        "url": row.url,
        "env_names": sorted(secrets["env"]),
        "header_names": sorted(secrets["headers"]),
        "signed_in": bool(secrets["oauth"]),
        "catalog_id": row.catalog_id,
        "enabled": bool(row.enabled),
        "use_in_chat": bool(row.use_in_chat),
        "use_in_code": bool(row.use_in_code),
    }


def list_connectors() -> list[dict]:
    with _session() as db:
        return [_info(r) for r in db.query(Connector).order_by(Connector.created_at, Connector.name).all()]


def _auth(entry: dict) -> str:
    """How adding this entry works now: "oauth", "key" or "none"."""
    if entry.get("auth") == "oauth":
        # GitHub signs in only with OpenGPT's OAuth app configured; otherwise a token.
        if entry.get("oauth_preset") and not connector_oauth.preset_client(entry["oauth_preset"]):
            return "key"
        return "oauth"
    return "key" if (entry.get("env") or entry.get("headers")) else "none"


def catalog() -> list[dict]:
    added = {c["catalog_id"] for c in list_connectors() if c["catalog_id"]}
    out = []
    for c in CATALOG:
        auth = _auth(c)
        item = {**c, "added": c["id"] in added, "auth": auth}
        if c.get("auth") == "oauth" and auth == "key":
            item["oauth_hint"] = ("Sign in with GitHub needs a GitHub OAuth app for OpenGPT: set "
                                  "GITHUB_OAUTH_CLIENT_ID in backend/.env (see .env.example).")
        out.append(item)
    return out


def create(*, name: str, kind: str, command: Any = None, url: str = None, env: Any = None,
           headers: Any = None, catalog_id: Optional[str] = None, oauth: Optional[dict] = None) -> dict:
    name = _clean_name(name)
    if kind == "local":
        values = {"command": json.dumps(_clean_command(command)), "url": None}
        secrets = {"env": _clean_pairs(env, _ENV_RE, "Environment"), "headers": {}}
    elif kind == "remote":
        values = {"command": None, "url": _clean_url(url)}
        secrets = {"env": {}, "headers": _clean_pairs(headers, _HEADER_RE, "Headers"), "oauth": oauth}
    else:
        raise ValidationError("Kind must be local or remote")
    with _session() as db:
        if db.query(Connector).count() >= MAX_CONNECTORS:
            raise ValidationError(f"You can add up to {MAX_CONNECTORS} connectors")
        if db.query(Connector).filter_by(name=name).first():
            raise ConflictError(f"A connector named {name} already exists")
        row = Connector(id=str(uuid.uuid4()), name=name, kind=kind, catalog_id=catalog_id,
                        secrets=secret_box.encrypt(secrets), **values)
        db.add(row)
        db.commit()
        db.refresh(row)
        return _info(row)


def add_from_catalog(catalog_id: str, values: Optional[dict] = None) -> dict:
    entry = _CATALOG_BY_ID.get(catalog_id)
    if not entry:
        raise NotFoundError("Unknown connector")
    values = values or {}
    if _auth(entry) == "oauth":
        raise ValidationError(f"{entry['name']} is added by signing in")
    if any(c["catalog_id"] == catalog_id for c in list_connectors()):
        raise ConflictError(f"{entry['name']} is already added")

    def filled(fields):
        out = {}
        for field in fields or []:
            value = (values.get(field["name"]) or "").strip()
            if not value:
                if field.get("required"):
                    raise ValidationError(f"{field['label']} is required")
                continue
            out[field["name"]] = field.get("template", "{VALUE}").replace("{VALUE}", value)
        return out

    return create(name=entry["id"], kind=entry["kind"], command=entry.get("command"), url=entry.get("url"),
                  env=filled(entry.get("env")), headers=filled(entry.get("headers")), catalog_id=catalog_id)


def import_json(text: str) -> list[dict]:
    """Add servers from an MCP JSON config, e.g. {"mcpServers": {"name": {"command": ..., "args": [...]}}}."""
    if not text or len(text) > 50_000:
        raise ValidationError("Paste an MCP configuration (JSON)")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise ValidationError(f"Not valid JSON: {e.msg} (line {e.lineno})") from None
    servers = data.get("mcpServers") or data.get("servers") or data.get("mcp", {}).get("servers") \
        if isinstance(data, dict) else None
    if not isinstance(servers, dict) or not servers:
        raise ValidationError('Expected {"mcpServers": {"name": {...}}}')
    prepared = []
    for name, spec in servers.items():
        if not isinstance(spec, dict):
            raise ValidationError(f"{name}: expected an object")
        if spec.get("url"):
            prepared.append(dict(name=name, kind="remote", url=spec["url"], headers=spec.get("headers")))
        elif spec.get("command"):
            command = spec["command"]
            command = ([command] if isinstance(command, str) else list(command)) + list(spec.get("args") or [])
            prepared.append(dict(name=name, kind="local", command=command,
                                 env=spec.get("env") or spec.get("environment")))
        else:
            raise ValidationError(f"{name}: needs a command or a url")
    # Validate everything before adding anything.
    for p in prepared:
        _clean_name(p["name"])
        if p["kind"] == "local":
            _clean_command(p["command"])
            _clean_pairs(p.get("env"), _ENV_RE, "Environment")
        else:
            _clean_url(p["url"])
            _clean_pairs(p.get("headers"), _HEADER_RE, "Headers")
    return [create(**p) for p in prepared]


def update(connector_id: str, changes: dict) -> dict:
    with _session() as db:
        row = db.get(Connector, _check_id(connector_id))
        if row is None:
            raise NotFoundError("Connector not found")
        for flag in ("enabled", "use_in_chat", "use_in_code"):
            if flag in changes:
                if not isinstance(changes[flag], bool):
                    raise ValidationError(f"{flag} must be true or false")
                setattr(row, flag, changes[flag])
        if "env" in changes or "headers" in changes:
            secrets = _secrets(row)
            if "env" in changes:
                if row.kind != "local":
                    raise ValidationError("Only local connectors have environment variables")
                secrets["env"] = _clean_pairs(changes["env"], _ENV_RE, "Environment")
            if "headers" in changes:
                if row.kind != "remote":
                    raise ValidationError("Only remote connectors have headers")
                secrets["headers"] = _clean_pairs(changes["headers"], _HEADER_RE, "Headers")
            row.secrets = secret_box.encrypt(secrets)
        db.commit()
        db.refresh(row)
        return _info(row)


def delete(connector_id: str) -> None:
    with _session() as db:
        deleted = db.query(Connector).filter_by(id=_check_id(connector_id)).delete()
        db.commit()
    if not deleted:
        raise NotFoundError("Connector not found")


def _check_id(connector_id: str) -> str:
    try:
        return str(uuid.UUID(str(connector_id)))
    except ValueError:
        raise ValidationError("Invalid connector id") from None


# ----- sign in (OAuth) -----

def start_sign_in(catalog_id: Optional[str] = None, name: Optional[str] = None,
                  url: Optional[str] = None, connector_id: Optional[str] = None) -> dict:
    """Start signing in for a catalog entry, a custom URL, or an existing
    connector (sign in again): {"authorize_url"} or {"device": {...}}."""
    preset = None
    if connector_id:
        with _session() as db:
            row = db.get(Connector, _check_id(connector_id))
            if row is None or row.kind != "remote":
                raise NotFoundError("Connector not found")
            server_url, target = row.url, {"connector_id": row.id}
            preset = (_CATALOG_BY_ID.get(row.catalog_id or "") or {}).get("oauth_preset")
    elif catalog_id:
        entry = _CATALOG_BY_ID.get(catalog_id)
        if not entry or _auth(entry) != "oauth":
            raise ValidationError("This connector doesn't use sign-in")
        if any(c["catalog_id"] == catalog_id for c in list_connectors()):
            raise ConflictError(f"{entry['name']} is already added")
        server_url, target, preset = entry["url"], {"catalog_id": catalog_id}, entry.get("oauth_preset")
    else:
        name, server_url = _clean_name(name), _clean_url(url)
        with _session() as db:
            if db.query(Connector).filter_by(name=name).first():
                raise ConflictError(f"A connector named {name} already exists")
        target = {"name": name, "url": server_url}
    return connector_oauth.start(server_url, target, preset)


def finish_sign_in(state: str, code: str) -> dict:
    """Store the tokens from a finished sign-in: add the connector, or update it."""
    return _save_sign_in(connector_oauth.finish(state, code))


def poll_device_sign_in(flow_id: str) -> dict:
    """Device sign-in: {"status": "pending"|"denied"|"expired"} or {"status": "done", "connector"}."""
    result = connector_oauth.device_poll(flow_id)
    if result["status"] != "done":
        return {"status": result["status"]}
    return {"status": "done", "connector": _save_sign_in(result)}


def _save_sign_in(result: dict) -> dict:
    target, oauth = result["target"], result["oauth"]
    if target.get("connector_id"):
        with _session() as db:
            row = db.get(Connector, target["connector_id"])
            if row is None:
                raise NotFoundError("Connector not found")
            secrets = _secrets(row)
            secrets["oauth"] = oauth
            row.secrets = secret_box.encrypt(secrets)
            db.commit()
            db.refresh(row)
            return _info(row)
    if target.get("catalog_id"):
        entry = _CATALOG_BY_ID[target["catalog_id"]]
        return create(name=entry["id"], kind="remote", url=entry["url"], catalog_id=entry["id"], oauth=oauth)
    return create(name=target["name"], kind="remote", url=target["url"], oauth=oauth)


def _fresh_oauth(row: Connector, secrets: dict, force_within: int = 300) -> Optional[dict]:
    """The connector's OAuth tokens, refreshed (and saved) if they expire soon."""
    oauth = secrets.get("oauth")
    if oauth and connector_oauth.needs_refresh(oauth, force_within):
        try:
            oauth = connector_oauth.refresh(oauth)
            secrets["oauth"] = oauth
            row.secrets = secret_box.encrypt(secrets)
        except Exception as e:
            logger.warning("Could not refresh the sign-in for connector %s: %s", row.name, getattr(e, "message", e))
    return oauth


def refresh_due(within_seconds: int = 900) -> int:
    """Refresh sign-ins expiring within the window. Returns how many were refreshed."""
    count = 0
    with _session() as db:
        for row in db.query(Connector).filter_by(enabled=True).all():
            secrets = _secrets(row)
            before = (secrets.get("oauth") or {}).get("access_token")
            after = (_fresh_oauth(row, secrets, within_seconds) or {}).get("access_token")
            if before and after and before != after:
                count += 1
        db.commit()
    return count


# ----- runtime -----

def _servers(where: str) -> list[dict]:
    """Enabled connectors used in ``where`` ("code" or "chat"), with their
    secrets and a fresh sign-in token."""
    flag = Connector.use_in_code if where == "code" else Connector.use_in_chat
    out = []
    with _session() as db:
        for row in db.query(Connector).filter(Connector.enabled.is_(True), flag.is_(True)).all():
            secrets = _secrets(row)
            entry = _CATALOG_BY_ID.get(row.catalog_id or "")
            spec = {"id": row.id, "name": row.name, "title": entry["name"] if entry else row.name,
                    "catalog_id": row.catalog_id, "kind": row.kind}
            if row.kind == "local":
                spec["command"] = json.loads(row.command)
                spec["env"] = dict(secrets["env"])
            else:
                headers = dict(secrets["headers"])
                oauth = _fresh_oauth(row, secrets)
                if oauth:
                    headers["Authorization"] = f"Bearer {oauth['access_token']}"
                spec["url"] = row.url
                spec["headers"] = headers
            out.append(spec)
        db.commit()  # refreshed tokens
    return out


def chat_servers() -> list[dict]:
    """Connectors for chat: [{id, name, title, catalog_id, kind, command/env | url/headers}]."""
    return _servers("chat")


def agent_mcp_config() -> dict:
    """MCP servers for the coding agent's config (enabled, used in Code)."""
    servers = {}
    for spec in _servers("code"):
        if spec["kind"] == "local":
            entry = {"type": "local", "command": spec["command"]}
            if spec["env"]:
                entry["environment"] = spec["env"]
        else:
            entry = {"type": "remote", "url": spec["url"], "oauth": False}
            if spec["headers"]:
                entry["headers"] = spec["headers"]
        servers[spec["name"]] = entry
    return {"servers": servers} if servers else {}
