"""Sign in to remote MCP servers with OAuth (the MCP authorization flow).

Instead of pasting a token, the user clicks Add, signs in on the provider's
own page, and authorizes OpenGPT:

1. Discover: the server answers 401 with its protected-resource metadata,
   which names its authorization server; that server's metadata gives the
   authorize/token (and registration) endpoints.
2. Client: register OpenGPT dynamically (RFC 7591) when the server allows it,
   or use a pre-registered app from backend/.env (GitHub needs this:
   GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET).
3. Authorize with PKCE (S256) and a single-use `state`; the provider sends the
   browser back to /api/connectors/oauth/callback.
4. Exchange the code for tokens, store them encrypted, refresh before expiry.

The callback URL is this backend's own address (OPENGPT_PUBLIC_URL, default
http://127.0.0.1:<PORT>), so sign-in works while OpenGPT runs locally.
"""
import base64
import hashlib
import json
import logging
import os
import secrets
import threading
import time
from typing import Optional
from urllib.parse import urlencode, urlparse, urlunparse

import httpx

from app import secret_box
from app.database.config import DatabaseConfig
from app.database.models import AppSetting
from app.exceptions import UpstreamError, ValidationError

logger = logging.getLogger(__name__)

TIMEOUT = httpx.Timeout(15.0)
FLOW_TTL_SECONDS = 600
_flows: dict[str, dict] = {}          # state -> pending sign-in
_flows_lock = threading.Lock()

# Pre-registered OAuth apps for servers without dynamic registration.
PRESET_CLIENTS = {
    "github": {"client_id_env": "GITHUB_OAUTH_CLIENT_ID", "client_secret_env": "GITHUB_OAUTH_CLIENT_SECRET",
               "scope": "repo read:org read:user user:email"},
}


def public_base() -> str:
    custom = (os.getenv("OPENGPT_PUBLIC_URL") or "").strip().rstrip("/")
    return custom or f"http://127.0.0.1:{os.getenv('PORT', '8000')}"


def redirect_uri() -> str:
    return f"{public_base()}/api/connectors/oauth/callback"


def preset_client(name: Optional[str]) -> Optional[dict]:
    preset = PRESET_CLIENTS.get(name or "")
    if not preset:
        return None
    client_id = (os.getenv(preset["client_id_env"]) or "").strip()
    client_secret = (os.getenv(preset["client_secret_env"]) or "").strip()
    if not client_id or not client_secret:
        return None
    return {"client_id": client_id, "client_secret": client_secret, "scope": preset["scope"]}


# ----- discovery -----

def _get_json(client: httpx.Client, url: str) -> Optional[dict]:
    try:
        r = client.get(url, headers={"Accept": "application/json"})
        if r.status_code == 200:
            data = r.json()
            return data if isinstance(data, dict) else None
    except (httpx.HTTPError, ValueError):
        pass
    return None


def _resource_metadata_url(client: httpx.Client, server_url: str) -> str:
    """From the server's 401 (WWW-Authenticate), or the well-known default."""
    try:
        r = client.post(server_url, json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "OpenGPT", "version": "1"}}},
            headers={"Accept": "application/json, text/event-stream"})
        header = r.headers.get("www-authenticate", "")
        if 'resource_metadata="' in header:
            return header.split('resource_metadata="', 1)[1].split('"', 1)[0]
    except httpx.HTTPError:
        pass
    p = urlparse(server_url)
    return urlunparse((p.scheme, p.netloc, "/.well-known/oauth-protected-resource" + p.path.rstrip("/"), "", "", ""))


def _auth_server_metadata(client: httpx.Client, issuer: str) -> Optional[dict]:
    p = urlparse(issuer.rstrip("/"))
    root = f"{p.scheme}://{p.netloc}"
    path = p.path
    candidates = [
        f"{root}/.well-known/oauth-authorization-server{path}",
        f"{root}/.well-known/openid-configuration{path}",
        f"{issuer.rstrip('/')}/.well-known/oauth-authorization-server",
        f"{issuer.rstrip('/')}/.well-known/openid-configuration",
    ]
    for url in candidates:
        data = _get_json(client, url)
        if data and data.get("authorization_endpoint") and data.get("token_endpoint"):
            return data
    return None


def discover(server_url: str) -> Optional[dict]:
    """The server's OAuth setup, or None if it doesn't use OAuth."""
    with httpx.Client(timeout=TIMEOUT, follow_redirects=True) as client:
        resource = _get_json(client, _resource_metadata_url(client, server_url))
        servers = (resource or {}).get("authorization_servers") or []
        if not servers:
            return None
        meta = _auth_server_metadata(client, servers[0])
        if not meta:
            return None
        return {
            "issuer": meta.get("issuer") or servers[0],
            "authorization_endpoint": meta["authorization_endpoint"],
            "token_endpoint": meta["token_endpoint"],
            "registration_endpoint": meta.get("registration_endpoint"),
            "scopes": (resource or {}).get("scopes_supported") or [],
            "resource": (resource or {}).get("resource") or server_url,
        }


# ----- clients (dynamic registration, cached per authorization server) -----

def _client_key(issuer: str) -> str:
    return "oauth-client:" + hashlib.sha256(issuer.encode()).hexdigest()[:40]


def _registered_client(issuer: str, registration_endpoint: str) -> dict:
    key = _client_key(issuer)
    with DatabaseConfig.get_session_factory()() as db:
        row = db.get(AppSetting, key)
        cached = secret_box.decrypt(row.value, default=None) if row else None
        if cached and cached.get("redirect_uri") == redirect_uri():
            return cached
        try:
            r = httpx.post(registration_endpoint, timeout=TIMEOUT, json={
                "client_name": "OpenGPT",
                "redirect_uris": [redirect_uri()],
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": "none",
            })
            r.raise_for_status()
            data = r.json()
        except (httpx.HTTPError, ValueError) as e:
            logger.warning("OAuth client registration failed at %s: %s", registration_endpoint, e)
            raise UpstreamError("The service didn't accept OpenGPT's sign-in registration. Try again later.") from None
        client = {"client_id": data["client_id"], "client_secret": data.get("client_secret"),
                  "redirect_uri": redirect_uri()}
        value = secret_box.encrypt(client)
        if row is None:
            db.add(AppSetting(key=key, value=value))
        else:
            row.value = value
        db.commit()
        return client


# ----- the sign-in flow -----

def _pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def _prune() -> None:
    now = time.time()
    for state in [s for s, f in _flows.items() if now - f["created"] > FLOW_TTL_SECONDS]:
        _flows.pop(state, None)


def start(server_url: str, target: dict, preset: Optional[str] = None) -> str:
    """Begin a sign-in. `target` says what to do on success (create or update a connector).
    Returns the provider URL to open."""
    oauth = discover(server_url)
    if not oauth:
        raise ValidationError("This server doesn't offer sign-in. Add it with a token instead.")
    client = preset_client(preset)
    scope = client.pop("scope") if client else " ".join(oauth["scopes"])
    if client is None:
        if not oauth["registration_endpoint"]:
            raise ValidationError("This service needs an app registered for OpenGPT before you can sign in. "
                                  "Add it with a token instead.")
        client = _registered_client(oauth["issuer"], oauth["registration_endpoint"])
    verifier, challenge = _pkce()
    state = secrets.token_urlsafe(32)
    with _flows_lock:
        _prune()
        _flows[state] = {"created": time.time(), "verifier": verifier, "client": client,
                         "oauth": oauth, "server_url": server_url, "target": target}
    params = {"response_type": "code", "client_id": client["client_id"], "redirect_uri": redirect_uri(),
              "state": state, "code_challenge": challenge, "code_challenge_method": "S256",
              "resource": oauth["resource"]}
    if scope:
        params["scope"] = scope
    return f"{oauth['authorization_endpoint']}?{urlencode(params)}"


def finish(state: str, code: str) -> dict:
    """Exchange the code for tokens. Returns {"target", "oauth" (to store)}."""
    with _flows_lock:
        _prune()
        flow = _flows.pop(state or "", None)   # single use
    if not flow or not code:
        raise ValidationError("This sign-in link expired or was already used. Start again from OpenGPT.")
    client, oauth = flow["client"], flow["oauth"]
    data = {"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri(),
            "client_id": client["client_id"], "code_verifier": flow["verifier"], "resource": oauth["resource"]}
    if client.get("client_secret"):
        data["client_secret"] = client["client_secret"]
    tokens = _token_request(oauth["token_endpoint"], data)
    return {"target": flow["target"], "oauth": _stored(tokens, client, oauth)}


def _token_request(endpoint: str, data: dict) -> dict:
    try:
        r = httpx.post(endpoint, data=data, timeout=TIMEOUT, headers={"Accept": "application/json"})
        body = r.json() if r.content else {}
    except (httpx.HTTPError, ValueError) as e:
        logger.warning("OAuth token request failed: %s", e)
        raise UpstreamError("Couldn't finish signing in with the service. Try again.") from None
    if r.status_code >= 400 or "access_token" not in body:
        logger.warning("OAuth token request refused (%s): %s", r.status_code, str(body)[:300])
        raise UpstreamError("The service refused the sign-in. Try again.")
    return body


def _stored(tokens: dict, client: dict, oauth: dict, previous: Optional[dict] = None) -> dict:
    expires_in = tokens.get("expires_in")
    return {
        "access_token": tokens["access_token"],
        "refresh_token": tokens.get("refresh_token") or (previous or {}).get("refresh_token"),
        "expires_at": time.time() + float(expires_in) if expires_in else None,
        "token_endpoint": oauth["token_endpoint"],
        "resource": oauth["resource"],
        "client_id": client["client_id"],
        "client_secret": client.get("client_secret"),
    }


def needs_refresh(stored: dict, within_seconds: int = 300) -> bool:
    expires = (stored or {}).get("expires_at")
    return bool(expires and stored.get("refresh_token") and expires - time.time() < within_seconds)


def refresh(stored: dict) -> dict:
    """New tokens from the refresh token."""
    data = {"grant_type": "refresh_token", "refresh_token": stored["refresh_token"],
            "client_id": stored["client_id"], "resource": stored.get("resource")}
    if stored.get("client_secret"):
        data["client_secret"] = stored["client_secret"]
    tokens = _token_request(stored["token_endpoint"], data)
    oauth = {"token_endpoint": stored["token_endpoint"], "resource": stored.get("resource")}
    client = {"client_id": stored["client_id"], "client_secret": stored.get("client_secret")}
    return _stored(tokens, client, oauth, previous=stored)


def callback_page(ok: bool, message: str) -> str:
    """Tiny page shown in the sign-in window; tells the opener and closes."""
    safe = (message.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
    payload = json.dumps({"type": "opengpt-connector", "ok": ok})
    color = "#86efac" if ok else "#fca5a5"
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>OpenGPT</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#202123;font-family:system-ui,sans-serif;color:#e5e7eb">
<div style="text-align:center;padding:24px"><p style="font-size:18px;margin:0 0 8px">OpenGPT</p>
<p style="color:{color};margin:0">{safe}</p><p style="color:#9ca3af;font-size:13px">You can close this window.</p></div>
<script>try{{window.opener&&window.opener.postMessage({payload},"*")}}catch(e){{}}setTimeout(function(){{window.close()}},{1200 if ok else 4000});</script>
</body></html>"""
