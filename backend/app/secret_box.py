"""Encryption for secrets stored in the database (connector tokens, and
later provider API keys).

The key comes from SETTINGS_SECRET in backend/.env. Without it, a random key
is created once in backend/app/storage/secret.key (readable only by you), so
it works out of the box locally. Keep that file (or SETTINGS_SECRET) with
the database: without it the stored secrets can't be decrypted.
"""
import base64
import hashlib
import json
import logging
import os
import threading
from pathlib import Path
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger(__name__)

KEY_FILE = Path(__file__).resolve().parent / "storage" / "secret.key"
_lock = threading.Lock()
_fernet = None


def _key() -> bytes:
    configured = (os.getenv("SETTINGS_SECRET") or "").strip()
    if configured:
        # Any string works: it is stretched into a Fernet key.
        return base64.urlsafe_b64encode(hashlib.sha256(configured.encode()).digest())
    if KEY_FILE.exists():
        return KEY_FILE.read_bytes().strip()
    KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
    key = Fernet.generate_key()
    # Created readable by the owner only.
    fd = os.open(KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(key)
    logger.info("Created %s for encrypting stored secrets", KEY_FILE)
    return key


def _box() -> Fernet:
    global _fernet
    with _lock:
        if _fernet is None:
            _fernet = Fernet(_key())
        return _fernet


def encrypt(value: Any) -> str:
    """Encrypt a JSON-serialisable value."""
    return _box().encrypt(json.dumps(value).encode()).decode()


def decrypt(token: str, default: Any = None) -> Any:
    """Decrypt a value from `encrypt`; `default` if it can't be read (e.g. the key changed)."""
    if not token:
        return default
    try:
        return json.loads(_box().decrypt(token.encode()))
    except (InvalidToken, ValueError):
        logger.error("A stored secret could not be decrypted (was SETTINGS_SECRET or secret.key changed?)")
        return default


def _reset_for_tests() -> None:
    global _fernet
    with _lock:
        _fernet = None
