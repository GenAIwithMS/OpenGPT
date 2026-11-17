# Connectors (MCP)

Connectors give the assistant tools from MCP (Model Context Protocol)
servers: services like GitHub or Notion, or local programs like Git or a
browser. They work in chat and in the coding agent.

## Files

| File | Role |
|---|---|
| `app/services/connectors.py` | The `connectors` table: catalog, add, import JSON, update, delete; specs for chat and for the coding agent |
| `app/services/connector_oauth.py` | Sign-in: OAuth discovery, client registration, PKCE, device flow, token refresh |
| `app/services/mcp_tools.py` | Chat side: live MCP connections and the tools built from them |
| `app/services/chat_approvals.py` | Asking the user in chat before a tool that can change data |
| `app/router/connectors.py` | `/api/connectors/...`, the sign-in callback, the token refresh loop |
| `frontend/src/components/settings/ConnectorsPage.jsx` | The settings page, catalog and sign-in windows |

## Adding a connector

- **From the catalog** (`CATALOG` in `connectors.py`). Each entry says how it
  is added:
  - `auth: "oauth"`: the user signs in on the provider's page (Notion,
    Linear, Sentry, Vercel, Canva, Stripe, PayPal). OpenGPT discovers the
    authorization server from the MCP server, registers itself
    automatically, and uses PKCE with a single-use state.
  - GitHub doesn't allow automatic registration: with
    `GITHUB_OAUTH_CLIENT_ID` it uses the device flow (a code to enter on
    github.com); with the secret too, the redirect flow; with neither, a
    token.
  - `key`: the user pastes an API key (Brave Search, Firecrawl).
  - nothing: local servers that need no key (Git, Playwright, Fetch, ...).
- **Custom**: a local command, a remote URL (signs in if the server supports
  it), or an `mcpServers` JSON config.

Secrets (env values, headers, tokens) are encrypted in the row and never
returned; the API shows only their names and `signed_in`. Tokens are
refreshed before they expire by a background loop.

## In chat

`mcp_tools.chat_tools()` keeps one connection per connector that is on for
chat, on a background event loop. A connection is reopened when the
connector's settings or token change and retried a minute after a failure.
Each MCP tool becomes a chat tool named `server__tool`.

- Tools the server marks **read-only** run directly.
- Any other tool **asks first**: the tool sends an `approval` event into the
  stream and waits; the user's answer arrives at
  `POST /api/chat/approvals/{id}`. No answer in 5 minutes, Stop, or a request
  that isn't from a live chat counts as no.

The card on the settings page shows "Connected · n tools" or the reason it
couldn't connect (`/api/connectors` includes the chat status).

## In the coding agent

`connectors.agent_mcp_config()` adds enabled connectors to the agent's
config; changes restart the agent. The agent asks before every connector
tool.

## API

`GET/POST /api/connectors`, `GET /connectors/catalog`,
`POST /connectors/catalog/{id}`, `POST /connectors/import`,
`PUT/DELETE /connectors/{id}`, `POST /connectors/oauth/start`,
`POST /connectors/oauth/device/{flow}`, `GET /connectors/oauth/callback`
(no API token: protected by the single-use state).

## Pitfalls

- Local servers run with the backend's user's permissions; only add commands
  you trust.
- The sign-in callback URL is this backend's own address
  (`OPENGPT_PUBLIC_URL`); register that URL in OAuth apps.

## Tests

`tests/test_connectors.py`, `test_connector_oauth.py`, `test_mcp_tools.py`
(with a small MCP server in `tests/fixtures/notes_mcp.py`).
