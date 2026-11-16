# 0002. Secrets entered in the app are encrypted in the database

Status: accepted (2026-11-16)

## Context

Connectors, sign-in tokens and model providers need API keys and tokens that
users enter in Settings, not in `backend/.env`. They must survive restarts,
and a database dump or a curious browser must not reveal them.

## Decision

Encrypt every such secret with Fernet (`app/secret_box.py`) before storing
it in MySQL. The key comes from `SETTINGS_SECRET` or, if unset, a random key
created once in `backend/app/storage/secret.key` (file mode 0600,
git-ignored). The API never returns secret values, only their names or a
`has_key` / `signed_in` flag.

## Consequences

- Users manage keys in the app; nothing secret reaches the browser after it
  is saved.
- The key must be kept with the database: without it stored secrets can't be
  read (they are treated as missing, and users enter them again).
- Anyone with both the database and the key file can read the secrets; the
  key file stays local and private.
