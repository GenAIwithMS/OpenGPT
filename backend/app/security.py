"""API access control.

Set API_TOKEN in .env to require `Authorization: Bearer <token>` on every
/api route. Without a token the API is open, so the server only allows that
while it is bound to this machine (see `check_exposure`).
"""
import hmac
import os
from typing import Optional

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.exceptions import UnauthorizedError

LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}

# auto_error=False so a missing header becomes our own 401 error format.
_bearer = HTTPBearer(auto_error=False)


def get_api_token() -> Optional[str]:
    token = os.getenv("API_TOKEN", "").strip()
    return token or None


def require_api_token(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> None:
    expected = get_api_token()
    if expected is None:
        return
    supplied = credentials.credentials if credentials else ""
    # Constant-time comparison so the token can't be guessed byte by byte.
    if not hmac.compare_digest(supplied.encode(), expected.encode()):
        raise UnauthorizedError("Missing or invalid API token")


def is_local_host(host: str) -> bool:
    return host.strip().lower() in LOCAL_HOSTS


def check_exposure(host: str) -> None:
    """Refuse to serve the API to the network without a token."""
    if not is_local_host(host) and get_api_token() is None:
        raise SystemExit(
            f"Refusing to start on HOST={host} without API_TOKEN: anyone on the "
            "network could read and delete every chat. Set API_TOKEN in "
            "backend/.env (and VITE_API_TOKEN in frontend/.env.local), or use "
            "HOST=127.0.0.1."
        )
