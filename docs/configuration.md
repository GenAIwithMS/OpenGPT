# Configuration

All backend settings are environment variables, usually set in
`backend/.env` (start from `backend/.env.example`). Restart the backend after
changing them. Settings changed in the app (Settings > Developer, Connectors,
Skills) are stored in the database instead and apply at once.

## Model provider

| Variable | Default | Meaning |
|---|---|---|
| `LLM_PROVIDER` | `openai` | `openai` (Chat Completions API) or `anthropic` (Messages API), for the provider itself or any compatible server |
| `LLM_API_KEY` | | API key. A self-hosted server may need none, but then needs `LLM_BASE_URL` |
| `LLM_BASE_URL` | | Endpoint URL; empty for OpenAI or Anthropic themselves |
| `LLM_MODEL` | | Main model (required). Must support tool calling |
| `LLM_SMALL_MODEL` | `LLM_MODEL` | Chat titles and short summaries |
| `RESEARCH_MODEL` | `LLM_MODEL` | Deep research |
| `BLOG_MODEL` | `LLM_MODEL` | Blog writer |
| `CODING_AGENT_MODEL` | `LLM_MODEL` | Coding agent |
| `AGENT_MODEL` | `LLM_MODEL` | The agent on the Agent page. Needs good tool calling |
| `BROWSER_BUILD_MODEL` | `LLM_MODEL` | Builds website tools in the browser engine |
| `BROWSER_REVIEW_MODEL` | `BROWSER_BUILD_MODEL` | Reviews every browser step and the finished tool |
| `LLM_MAX_TOKENS` | `8192` | Max output tokens per call |

A provider chosen in Settings > Developer overrides these (see
[providers](services/providers.md)).

## Tools

| Variable | Enables |
|---|---|
| `PARALLEL_API_KEY` | Web search (preferred) |
| `BRAVE_API_KEY` | Web search fallback |
| `WEATHER_API_KEY` | Weather (OpenWeather) |
| `STOCK_API_KEY` | Stock prices (Alpha Vantage) |
| `GOOGLE_API_KEY` | Images in blog posts (skipped when empty) |
| `TAVILY_API_KEY` | Research for blog posts, and deep research with `SEARCH_API=tavily` |

## Database

| Variable | Default |
|---|---|
| `MYSQL_HOST` | `localhost` |
| `MYSQL_PORT` | `3306` |
| `MYSQL_USER` | `root` |
| `MYSQL_PASSWORD` | |
| `MYSQL_DATABASE` | `chatbot_db` |

The database and tables are created at startup.

## Server and access

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | `0.0.0.0` exposes the API on your network (then `API_TOKEN` is required) |
| `PORT` | `8000` | The start scripts use the next free port when this one is taken |
| `BIND_HOST` | `HOST` | Address to listen on when it differs from `HOST`. The Docker image sets `0.0.0.0` (inside the container) and keeps `HOST` local, because its port is published on 127.0.0.1 only |
| `FRONTEND_DIST` | | Folder with the built frontend; when set, the backend serves it on its own port (the Docker image does this) |
| `RELOAD` | `false` | Reload on code changes (development) |
| `CORS_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | Comma-separated origins allowed to call the API. When unset, the start scripts use the frontend's actual port |
| `API_TOKEN` | | When set, every `/api` request needs `Authorization: Bearer <token>`; set the same value as `VITE_API_TOKEN` in `frontend/.env.local` |
| `ENABLE_DOCS` | on locally | Interactive API docs at `/docs` |
| `LOG_LEVEL` | `INFO` | `DEBUG` also logs queries and thread ids |
| `SETTINGS_SECRET` | | Key for encrypting stored secrets. Without it a random key is created in `backend/app/storage/secret.key`; keep that file with your database |
| `OPENGPT_PUBLIC_URL` | `http://127.0.0.1:<PORT>` | Address providers send the browser back to after connector sign-in |

## Limits

| Variable | Default | Meaning |
|---|---|---|
| `RATE_LIMIT_PER_MINUTE` | `20` | Chat, upload and query requests per client per minute (`0` = off) |
| `MAX_MESSAGE_CHARS` | `20000` | Longest chat message |
| `MAX_UPLOAD_MB` | `20` | Largest uploaded document |
| `MAX_KNOWLEDGE_FILES` | `50` | Documents in the knowledge base |
| `MAX_PROJECT_FILES` | `50` | Files in one project |
| `MAX_REPORT_CHARS` | `200000` | Longest edited research report |
| `MAX_BLOG_SECTIONS` | `10` | Sections per blog post |
| `MAX_CACHED_RETRIEVERS` | `32` | Document indexes kept in memory |
| `MAX_CHECKPOINTS_PER_THREAD` | `20` | Older chat checkpoints are deleted (`0` = keep all) |
| `EMBEDDING_MODEL` | `sentence-transformers/all-MiniLM-L6-v2` | Local embedding model for documents |

## Deep research

| Variable | Default | Meaning |
|---|---|---|
| `SEARCH_API` | `parallel` | `parallel`, `tavily`, `duckduckgo` or `none` |
| `DEEP_RESEARCH_MAX_ITERATIONS` | `3` | Rounds the research supervisor may run |
| `DEEP_RESEARCH_MAX_TOOL_CALLS` | `6` | Searches each researcher may make |
| `MAX_CONCURRENT_RESEARCH_UNITS` | `5` | Researchers working in parallel |

## Agent

The Agent page ([agent](services/agent.md)).

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_MAX_STEPS` | `50` | Model calls per run; then the session stops and **Continue** goes on |
| `AGENT_MAX_MINUTES` | `30` | Minutes per run; then the session stops the same way |
| `AGENT_APPROVAL_HOURS` | `24` | A scheduled session's approval nobody answers in this time expires |
| `AGENT_SCHEDULE_CATCH_UP` | `false` | `true`: a scheduled time missed while OpenGPT was off runs once at startup (default: skipped) |

## Browser engine

[Browser engine](services/browser-engine.md): builds use the active provider and
the two browser models above.

| Variable | Default | Meaning |
|---|---|---|
| `BROWSER_ENGINE_NODE` | `node` on PATH | The Node.js 24 binary that runs the engine |
| `BROWSER_CONTEXT_TOKENS` | `128000` (OpenAI: as tuned) | The browser models' context window; compaction thresholds scale to it |
| `BROWSER_REASONING_EFFORT` | `false` | Send a reasoning effort on chat APIs (only for models that accept it) |
| `BROWSER_ENGINE_LOG_MODEL_ERRORS` | | `1`: the engine logs why a provider refused a model call (status and message, never the request) |

## Coding agent

| Variable | Default | Meaning |
|---|---|---|
| `CODING_AGENT_ENABLED` | on locally, off when exposed | Turn the Code page's agent on or off |
| `CODING_AGENT_PORT` | a free port | Port for the agent on `127.0.0.1` |
| `CODING_AGENT_DIR` | `<repo>/coding-agent` | Where the agent's code is |
| `CODING_AGENT_START_TIMEOUT` | `90` | Seconds to wait for it to start |
| `BUN_PATH` | `bun` on PATH or `~/.bun/bin/bun` | Bun executable |
| `CODE_ALLOWED_ROOTS` | your home folder | Folders the agent may work in (comma-separated); hidden folders and the home folder itself are never allowed |
| `CODE_PROJECTS_ROOT` | `~/OpenGPT Projects` | Where New project creates folders |
| `CODING_AGENT_URL`, `CODING_AGENT_PASSWORD` | | Use an agent you started yourself instead |

## Connector sign-in

| Variable | Meaning |
|---|---|
| `GITHUB_OAUTH_CLIENT_ID` | OpenGPT's GitHub OAuth app (Device Flow enabled). With only the ID, GitHub sign-in shows a code to enter on github.com |
| `GITHUB_OAUTH_CLIENT_SECRET` | With the secret too, GitHub uses the redirect sign-in instead |

## Tracing

| Variable | Default | Meaning |
|---|---|---|
| `LANGSMITH_TRACING` | `false` | `true` sends prompts and documents to LangSmith |
| `LANGSMITH_PROJECT` | `OpenGPT` | |
| `LANGSMITH_API_KEY` | | |
| `LANGSMITH_ENDPOINT` | LangSmith's | |

## Frontend

| Variable (in `frontend/.env.local`) | Meaning |
|---|---|
| `VITE_API_URL` | Backend URL when it isn't proxied at `/api` |
| `VITE_API_TOKEN` | Same value as the backend's `API_TOKEN` |

The dev server's ports come from the environment of `npm run dev` (the start
scripts set them to free ports):

| Variable | Default | Meaning |
|---|---|---|
| `OPENGPT_FRONTEND_PORT` | `3000` | Port of the dev server |
| `OPENGPT_BACKEND_PORT` | `8000` | Backend port the dev server forwards `/api` to |
