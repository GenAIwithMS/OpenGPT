# Routers

HTTP only: each route validates its input with pydantic, calls a service and
returns JSON or a Server-Sent Events stream. Business logic lives in
`app/services/`. All routers are included in `create_app()`
(`app/__init__.py`) under `/api`, behind the optional `API_TOKEN`.

| File | Prefix | Covers | Service |
|---|---|---|---|
| `chat.py` | `/api` | Chat streaming, edit, regenerate, temporary chats, connector approvals, threads (rename, pin), document upload and questions | `services/chat.py`, `rag.py`, `chat_approvals.py` |
| `code.py` | `/api/code` | Coding agent status, projects, folder browser, sessions, streaming turns, approvals | `services/coding_agent/` |
| `connectors.py` | `/api/connectors` | Connector catalog, add / import / update / remove, sign-in (OAuth, device code), token refresh loop | `services/connectors.py`, `connector_oauth.py`, `mcp_tools.py` |
| `skills.py` | `/api/skills` | Skills list, on/off, create, edit, upload, GitHub import, Explore catalog | `services/skills.py` |
| `providers.py` | `/api/providers` | Model providers, testing, active provider and job models, the model menu (`/models`) | `services/providers.py`, `model_router.py` |
| `settings.py` | `/api/settings` | Profile and general settings, knowledge base files, saved memories | `services/settings.py`, `knowledge.py`, `memory.py` |
| `agent.py` | `/api/agent` | Agent sessions: start, events, answers, approvals, the browser's questions, stop, continue; schedules | `services/agent/` |
| `browser.py` | `/api/browser` | The agent's browser: status, websites it may use, saved website tools | `services/agent/browser.py` |
| `projects.py` | `/api` | Projects (`/projects`), their files, moving a chat (`/threads/{id}/project`) | `services/projects.py` |
| `health.py` | `/api` | `GET /api/health` | |

## Conventions

- Request bodies are pydantic models with bounded fields
  (`Field(max_length=...)`); shared ones are in `app/schema/models.py`.
- Raise `app/exceptions.py` errors; never `HTTPException`.
- Expensive or outward-calling POSTs depend on `rate_limit`.
- Streaming routes return `StreamingResponse` with `text/event-stream`; the
  final event is `done` or `error`.
- `connectors_callback_router` (`GET /api/connectors/oauth/callback`) is the
  one route without the API token: the provider redirects the browser there,
  and the single-use OAuth `state` protects it.

The full route list with parameters is at `/docs` on a running backend.
