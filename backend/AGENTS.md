# Backend

FastAPI + LangGraph, Python 3.13. Entry point `main.py`; the app is built in
`app/__init__.py` (`create_app`: database, model settings check, routers,
lifespan for background work).

## Layout

| Path | Role |
|---|---|
| `app/router/` | HTTP only: parse the request (pydantic models), call a service, return JSON. No business logic. |
| `app/services/` | The logic. One module per feature (chat, rag, knowledge, connectors, skills, providers, settings, ...). Each starts with a docstring explaining how it works; keep it current. |
| `app/services/chatbot.py` | The LangGraph chat graph: system prompt, tools offered per message, tool node. |
| `app/services/chat.py` | Runs the graph and turns its stream into the SSE events the frontend reads. |
| `app/services/coding_agent/` | The coding agent integration. See its own AGENTS.md. |
| `app/tools/` | Chat tools (search, weather, ...), deep research, blog writer. |
| `app/database/` | SQLAlchemy models (`models.py`), engine (`config.py`), startup (`init_db.py`), LangGraph checkpointer. |
| `app/schema/models.py` | Shared request/response models. |
| `app/llm.py` | The only place that builds chat models. |
| `app/secret_box.py` | Encryption for secrets stored in the database. |
| `app/security.py`, `app/rate_limit.py` | API token check, rate limiting. |
| `app/exceptions.py`, `app/error_handlers.py` | Error types and how they become responses. |
| `app/skills/` | OpenGPT's built-in skills (SKILL.md folders). |
| `app/storage/` | Runtime data: uploads, encryption key, skills, logs. Git-ignored; never commit or print it. |
| `tests/` | unittest tests. |

## Rules

- **Errors.** Raise the classes in `app/exceptions.py` (`ValidationError`,
  `NotFoundError`, `ConflictError`, `ForbiddenError`, `UpstreamError`, ...)
  with a message the user can act on. Don't raise `HTTPException`. For an
  unexpected error, log it with `log_error(context, exc)` and show only
  `public_error(ref)`; never put stack traces, paths or secrets in a response.
- **Models.** Get chat models only through `app/llm.py`: `LazyChatModel(role)`
  at module level, `chat_model(...)` / `model_name(role)` inside functions,
  `structured(...)` for structured output. Roles: `model`, `small_model`,
  `research_model`, `blog_model`, `coding_model`. Never construct a provider
  client directly or build a model at import time. After changing provider
  settings call `llm.reload()`.
- **Secrets.** Encrypt with `secret_box.encrypt()` before storing; return only
  names or `has_key`-style flags to the browser; never log them.
- **Small settings and state** go in the `app_settings` table (one JSON value
  per key) through a service, not in files.
- **Database changes.** New tables: add them to `app/database/models.py`;
  `create_all()` creates them at startup. A new column on an existing table
  also needs an upgrade step in `app/database/init_db.py`, because
  `create_all()` doesn't alter existing tables.
- **New routes.** Add a router in `app/router/` and include it in
  `create_app()` with `dependencies=[Depends(require_api_token)]`. Add
  `Depends(rate_limit)` to expensive or outward-calling POSTs. Bound every
  input (`Field(max_length=...)`, size limits on uploads).
- **Outbound requests and files from users.** Use timeouts and size limits.
  When extracting archives, skip links and absolute or `..` paths (see
  `services/skills.py`).
- **Child processes.** Start long-running children through
  `services/coding_agent/process.spawn`, not from a short-lived thread (see
  that folder's AGENTS.md).
- **Chat tools.** A tool offered to the model must also be resolvable by the
  tool node (`chatbot.tool_node` builds the list per call). Connector tools
  that can change data must ask first (`services/chat_approvals.py`).
- **Dependencies** are pinned in `requirements.txt`; add new ones there with
  an exact version and a comment saying what they are for.

## Tests

```bash
python -m unittest discover -s tests -t .      # everything (about a minute)
python -m unittest tests.test_skills           # one module
```

- Tests run without MySQL, API keys or network. Start a test module with
  `from tests import _helpers` and call `_helpers.use_sqlite()` in `setUp`
  for an in-memory database.
- Fake outside services with a local `http.server` in a thread (see
  `tests/test_connector_oauth.py`, `tests/test_providers.py`) or
  `unittest.mock`. Never call real providers from tests.
- Tests must not touch `app/storage/`: patch paths to a temporary directory.
- Cover the failure paths too (invalid input, refused requests, timeouts).
