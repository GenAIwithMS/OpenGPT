# Add a connector to the catalog

The catalog is `CATALOG` in `backend/app/services/connectors.py`.

## 1. Check the server

- **Remote server**: find its MCP URL and check how it signs in:

  ```bash
  curl -si -X POST <url> -H 'Content-Type: application/json' -d '{}' | head -20
  ```

  A `401` with `WWW-Authenticate: Bearer resource_metadata="..."` means
  OAuth. Follow that URL, then the authorization server's metadata: a
  `registration_endpoint` means OpenGPT can register itself (no setup for
  users). Without one, the provider needs a pre-registered app (like GitHub)
  or an API key.
- **Local server**: the command (`npx -y ...`, `uvx ...`), what it needs
  installed, and which environment variables it requires.
- Check the licence and that it comes from the service itself or a
  well-known maintainer.

## 2. Add the entry

Copy a similar entry. Fields: `id` (also the connector's name: lowercase,
digits, `-`, `_`), `name`, `description`, `category`, `homepage` (its docs),
`kind` (`remote` with a `url`, or `local` with a `command` list and
`requires`, e.g. "Node.js"). How it is added:

- `"auth": "oauth"` for sign-in;
- `env` / `headers` with the variables the user must provide (asked for when
  adding, stored encrypted);
- neither for servers that need nothing.

## 3. Add its logo

In `frontend/src/components/settings/ConnectorLogo.jsx`: a Simple Icons mark
if one exists; otherwise download the official icon from the company's own
site into `frontend/src/assets/connectors/` and list the source in that
folder's `SOURCES.md`.

## 4. Check

- `backend/tests/test_connectors.py` passes
  (`test_every_catalog_entry_is_valid` checks every entry's fields).
- Add it in the browser against a test backend: sign in or enter the key, see
  "Connected · n tools", try a read-only tool and one that asks first in a
  temporary chat, then remove it.
