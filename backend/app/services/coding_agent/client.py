"""HTTP client for the coding agent.

All calls to the agent go through `call()`: it adds the password and the
project folder header, and turns agent errors into the app's own errors.
Agent error text is never passed to the browser (it can contain provider
responses, account ids or file paths); it is logged with a ref code instead.
"""
import logging
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote

import httpx

from app.error_handlers import log_error, public_error
from app.exceptions import ConflictError, NotFoundError, ServiceUnavailableError, UpstreamError, ValidationError
from app.services.coding_agent.process import agent

logger = logging.getLogger(__name__)

# The agent's header naming the folder a request is about.
DIRECTORY_HEADER = "x-opencode-directory"
TIMEOUT = httpx.Timeout(60.0, connect=5.0)

_client: Optional[httpx.AsyncClient] = None


def _shared_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(timeout=TIMEOUT)
    return _client


async def close() -> None:
    global _client
    if _client is not None and not _client.is_closed:
        await _client.aclose()
    _client = None


def headers_for(directory: Optional[Path]) -> dict:
    return {DIRECTORY_HEADER: quote(str(directory), safe="")} if directory else {}


def require_agent() -> tuple[str, tuple[str, str]]:
    """The agent's URL and credentials, or 503 when it isn't running."""
    url, auth = agent.base_url, agent.auth
    if not url or not auth:
        raise ServiceUnavailableError(agent.status.detail or "The coding agent is not available.")
    return url, auth


async def call(
    method: str,
    path: str,
    *,
    directory: Optional[Path] = None,
    json: Any = None,
    params: Optional[dict] = None,
) -> Any:
    """Call the agent API. Returns the parsed JSON body (None for empty replies)."""
    url, auth = require_agent()
    try:
        response = await _shared_client().request(
            method, url + path, auth=auth, headers=headers_for(directory), json=json, params=params
        )
    except httpx.HTTPError as e:
        ref = log_error(f"Coding agent request failed: {method} {path}", e)
        raise UpstreamError(f"The coding agent could not be reached. (ref {ref})") from None

    status = response.status_code
    if status < 400:
        if status == 204 or not response.content:
            return None
        return response.json()

    body = response.text[:2000]
    logger.warning("Coding agent %s %s -> %s: %s", method, path, status, body)
    if status == 404:
        raise NotFoundError("Not found")
    if status == 409:
        raise ConflictError("The coding agent is busy with this session")
    if status in (400, 422):
        raise ValidationError("The coding agent rejected the request")
    if status == 401:
        # The password is made per run; a mismatch means a stale or foreign agent.
        ref = log_error("Coding agent rejected the backend's password", RuntimeError(body))
        raise ServiceUnavailableError(f"The coding agent is not available. (ref {ref})")
    ref = log_error(f"Coding agent error: {method} {path} -> {status}", RuntimeError(body))
    raise UpstreamError(public_error(ref))
