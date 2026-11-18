# OpenGPT backend

FastAPI + LangGraph. Serves the API under `/api`, runs the chat graph, deep
research and the blog writer, and manages the coding agent and connectors.

```bash
pip install -r requirements.txt        # from the repo root: pip install -r backend/requirements.txt
cp .env.example .env                   # then set LLM_* and MYSQL_*
python main.py                         # http://127.0.0.1:8000, API docs at /docs
python -m unittest discover -s tests -t .
```

## Layout

| Folder | What's inside | Read |
|---|---|---|
| `app/router/` | HTTP routes, one file per area | [README](app/router/README.md) |
| `app/services/` | The logic behind the routes | [README](app/services/README.md) |
| `app/services/coding_agent/` | The Code page's agent integration | [README](app/services/coding_agent/README.md) |
| `app/tools/` | Chat tools, deep research, blog writer | [README](app/tools/README.md) |
| `app/database/` | Tables, startup, chat history storage | [README](app/database/README.md) |
| `app/skills/` | OpenGPT's built-in skills | [docs](../docs/services/skills.md) |
| `app/storage/` | Runtime files (git-ignored) | |
| `tests/` | Tests: no MySQL, keys or network needed | [README](tests/README.md) |
| `scripts/` | One-off maintenance (e.g. `migrate_checkpoints`) | |
| `evals/` | LangSmith evaluations | [README](evals/README.md) |

Top-level files in `app/`: `__init__.py` (app factory: database, model
check, routers, background work), `llm.py` (the only place that builds
models), `secret_box.py` (encrypting stored secrets), `security.py` (API
token, exposure check), `rate_limit.py`, `exceptions.py` and
`error_handlers.py` (error types and responses).

More: [architecture](../docs/architecture.md), [configuration](../docs/configuration.md),
rules for working here in [AGENTS.md](AGENTS.md).
