<div align="center">

# ✦ OpenGPT ✦

### An open-source, ChatGPT-style AI assistant powered by LangGraph

Agentic tool use · Deep Research · Document Q&A (RAG) · Persistent multi-thread chats

<br />

<p>
  <img src="https://img.shields.io/badge/Python-3.13-3776AB?style=for-the-badge&logo=python&logoColor=white" alt="Python 3.13" />
  <img src="https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white" alt="FastAPI" />
  <img src="https://img.shields.io/badge/LangGraph-1C3C3C?style=for-the-badge&logo=langchain&logoColor=white" alt="LangGraph" />
  <img src="https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React 18" />
  <img src="https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white" alt="Vite" />
  <img src="https://img.shields.io/badge/Tailwind_CSS-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white" alt="Tailwind CSS" />
  <img src="https://img.shields.io/badge/MySQL-4479A1?style=for-the-badge&logo=mysql&logoColor=white" alt="MySQL" />
</p>

<p>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/GenAIwithMS/LangGraph-Chatbot?style=flat-square&color=22c55e" alt="License" /></a>
  <a href="https://github.com/GenAIwithMS/LangGraph-Chatbot/stargazers"><img src="https://img.shields.io/github/stars/GenAIwithMS/LangGraph-Chatbot?style=flat-square&color=facc15" alt="Stars" /></a>
  <a href="https://github.com/GenAIwithMS/LangGraph-Chatbot/network/members"><img src="https://img.shields.io/github/forks/GenAIwithMS/LangGraph-Chatbot?style=flat-square&color=60a5fa" alt="Forks" /></a>
  <a href="https://github.com/GenAIwithMS/LangGraph-Chatbot/issues"><img src="https://img.shields.io/github/issues/GenAIwithMS/LangGraph-Chatbot?style=flat-square&color=f97316" alt="Issues" /></a>
  <img src="https://img.shields.io/github/last-commit/GenAIwithMS/LangGraph-Chatbot?style=flat-square&color=a78bfa" alt="Last commit" />
</p>

<p>
  <a href="#quick-start"><b>Quick Start</b></a> ·
  <a href="#features"><b>Features</b></a> ·
  <a href="#technology-stack"><b>Tech Stack</b></a> ·
  <a href="#api-endpoints"><b>API</b></a> ·
  <a href="#contributing"><b>Contributing</b></a>
</p>

<br />

<img src="OpenGPT.png" alt="OpenGPT chat interface" width="92%" />

</div>

<br />

<table>
  <tr>
    <td align="center" width="25%">🧠<br /><b>Any model, agentic</b><br /><sub>OpenAI- or Anthropic-compatible models with search, weather, stocks &amp; calculator tools</sub></td>
    <td align="center" width="25%">🔬<br /><b>Deep Research</b><br /><sub>Multi-step research that clarifies, plans, and writes a full report</sub></td>
    <td align="center" width="25%">📄<br /><b>Chat with documents</b><br /><sub>Upload files and ask questions with FAISS-backed RAG</sub></td>
    <td align="center" width="25%">💾<br /><b>Never lose a thread</b><br /><sub>MySQL-persisted conversations, plus temporary session-only chats</sub></td>
  </tr>
</table>

## About

OpenGPT is an open-source, ChatGPT-style assistant built with LangGraph. It has a FastAPI backend and a React frontend. It works with **any model behind an OpenAI- or Anthropic-compatible API**, hosted or self-hosted. Conversations are saved in MySQL.

## Features

- **Any model provider**: one setting picks the OpenAI- or Anthropic-compatible endpoint and model ([Choosing a model](#choosing-a-model))
- **Streaming chat** with live "thinking" and tool status, plus edit, regenerate and stop
- **Tools the model can use**: web search (Parallel, Brave as fallback), weather (OpenWeather), stock quotes (Alpha Vantage), calculator
- **Inline citations**: search sources become links with title and date on hover
- **Deep Research**: plans, searches in several rounds and writes a full report you can edit and download
- **Blog writer**: researches and writes a structured blog post, with optional Gemini images
- **Chat with documents (RAG)**: attach PDF, Markdown or text files; several files per chat, searched together
- **Persistent threads** in MySQL, plus **temporary chats** that are never saved
- **Safe defaults**: local-only server, optional API token, rate limits, size limits, sanitized rendering
- **Coding agent** (the Code page): works in a project folder, reads and edits code and runs commands, with live progress. It asks before editing files or running commands and shows the diff first ([Coding agent](#coding-agent))

## Technology Stack

### Backend
- **Framework**: FastAPI + LangGraph
- **Models**: any OpenAI- or Anthropic-compatible endpoint (`langchain-openai`, `langchain-anthropic`)
- **Database**: MySQL with a custom LangGraph checkpoint saver
- **RAG**: FAISS + HuggingFace sentence-transformer embeddings (run locally)
- **Language**: Python 3.11+ (developed on 3.13)

### Frontend
- **Framework**: React 18 + Vite
- **Styling**: Tailwind CSS
- **Markdown**: React Markdown with GitHub Flavored Markdown, sanitized
- **Code highlighting**: Shiki
- **Icons**: Lucide React

### Coding agent
- **Runtime**: Bun + TypeScript service in `coding-agent/`, based on the opencode agent harness
- **Started by the backend** on 127.0.0.1 with a random password; the browser only talks to the backend

## Prerequisites

- Python 3.11+
- Node.js 18+ and npm
- MySQL 5.7+ or 8.0+
- An API key for a model provider (or a local model server)
- Optional: API keys for the tools you want (search, weather, stocks, images)
- Optional: [Bun](https://bun.sh) for the Code page (coding agent); chat works without it

## Quick Start

### 1. Configure

```bash
cd backend
cp .env.example .env
```

Edit `backend/.env`. At minimum, set your model and MySQL settings:

```env
LLM_PROVIDER=openai          # or anthropic
LLM_API_KEY=your_key
LLM_BASE_URL=                # leave empty for OpenAI / Anthropic themselves
LLM_MODEL=your_model_name

MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=chatbot_db
```

The database and tables are created automatically on first start. If something is wrong (MySQL not running, wrong password, missing model settings), the backend stops with a message saying what to fix.

### 2. Install

```bash
# Backend (from the repo root)
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r backend/requirements.txt

# Frontend
cd frontend && npm install

# Coding agent (optional, for the Code page; needs Bun)
cd coding-agent && bun install
```

### 3. Start

**Start scripts:** `./start.sh` (Linux/macOS) or `start.bat` (Windows). They start the backend on port 8000 and the frontend on port 3000, using `.venv` if present. When Bun is installed they also install the coding agent's dependencies on the first run; the backend then starts the coding agent itself.

**Or manually:**
```bash
cd backend && python main.py       # API on http://127.0.0.1:8000
cd frontend && npm run dev         # UI on http://localhost:3000
```

Open **http://localhost:3000**. API docs are at http://127.0.0.1:8000/docs.

## Choosing a model

OpenGPT speaks two APIs. Set the one your model's endpoint supports:

| Your endpoint speaks | `LLM_PROVIDER` | `LLM_BASE_URL` |
|---|---|---|
| The OpenAI API (OpenAI itself) | `openai` | *(empty)* |
| An OpenAI-compatible API | `openai` | the server's URL (usually ending in `/v1`) |
| The Anthropic API (Anthropic itself) | `anthropic` | *(empty)* |
| An Anthropic-compatible API | `anthropic` | the server's URL |

Then set `LLM_API_KEY` and `LLM_MODEL` (the model name your endpoint uses).

- A self-hosted server may need no `LLM_API_KEY`; `LLM_BASE_URL` is enough.
- Use a model that supports **tool calling**: chat tools, deep research and the blog writer depend on it.
- Optional per-task models, each defaulting to `LLM_MODEL`: `LLM_SMALL_MODEL` (titles, summaries), `BLOG_MODEL`, `RESEARCH_MODEL`. `LLM_MAX_TOKENS` sets the output limit (default 8192).

## Coding agent

The **Code** page in the sidebar runs a coding agent on your machine. Pick or create a project, describe a task, and watch it work: its reply, its thinking, and a card for each command it runs or file it reads or edits.

- **Projects** are folders directly inside `CODE_PROJECTS_ROOT` (default `backend/app/storage/code/`). Point it at e.g. `~/projects` to work on your own repositories. The agent only works inside the project folder; anything outside it is refused.
- **Approvals**: the agent asks before editing files, running commands, going online or reading `.env` files. Each request shows the command or the diff, with **Allow once**, **Always allow** (saved for the project; it says exactly what it covers, e.g. "commands starting with `git`") and **Deny** (optionally with a reason for the agent). Saved approvals can be reviewed and revoked from the project menu.
- **Model**: it uses `LLM_*` like the chat. Its requests are large (about 6–9k tokens of instructions and tool descriptions each), so set `CODING_AGENT_MODEL` to a model or plan with higher limits if requests fail with a "larger than the model allows" or rate-limit message.
- **Stop** ends the current task. If you close the page, the agent keeps working; reopen the session to see the result.

> ⚠️ **The coding agent runs commands and changes files on this computer.** Read approval requests before allowing them, and keep the API local (the default). When `HOST` exposes the API, the coding agent is off unless you set `CODING_AGENT_ENABLED=true`, and `API_TOKEN` is required.

How it is protected: the agent listens only on 127.0.0.1 with a password made for each run that never reaches the browser; it gets no backend secrets in its environment; only the configured model is available; a project folder can't change the agent's settings or permissions; and error details from the model are logged, not shown.

## Configuration

All settings live in `backend/.env`. [`backend/.env.example`](backend/.env.example) lists every option with comments. The main groups:

| Group | Settings |
|---|---|
| Model | `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, optional per-task models |
| Tools | `PARALLEL_API_KEY` / `BRAVE_API_KEY` (search), `WEATHER_API_KEY`, `STOCK_API_KEY`, `GOOGLE_API_KEY` (blog images), `TAVILY_API_KEY` |
| Database | `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE` |
| Server | `HOST` (default `127.0.0.1`), `PORT`, `RELOAD`, `CORS_ORIGINS`, `ENABLE_DOCS`, `LOG_LEVEL` |
| Security | `API_TOKEN` (required when `HOST` is not local; set `VITE_API_TOKEN` in `frontend/.env.local` to match) |
| Limits | `RATE_LIMIT_PER_MINUTE`, `MAX_MESSAGE_CHARS`, `MAX_UPLOAD_MB`, `MAX_BLOG_SECTIONS`, `MAX_CHECKPOINTS_PER_THREAD`, ... |
| Tracing | `LANGSMITH_TRACING` (off by default), `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT` |
| Coding agent | `CODING_AGENT_ENABLED`, `CODING_AGENT_MODEL`, `CODE_PROJECTS_ROOT`, `BUN_PATH`, `CODING_AGENT_PORT`, or `CODING_AGENT_URL` + `CODING_AGENT_PASSWORD` for an agent you start yourself |
| Frontend (`frontend/.env.local`) | `VITE_API_URL` (default `/api`: the Vite dev server forwards it to the backend; set the backend URL for other setups), `VITE_API_TOKEN` (when `API_TOKEN` is set) |

Tools without a key are simply unavailable. For example, without `GOOGLE_API_KEY` blogs show image captions instead of images.

## Project Structure

```
.
├── backend/
│   ├── main.py                    # Entry point (python main.py)
│   ├── app/
│   │   ├── __init__.py            # App factory: CORS, routers, startup checks
│   │   ├── llm.py                 # Model provider settings (OpenAI/Anthropic-compatible)
│   │   ├── security.py            # Optional API token, network exposure check
│   │   ├── rate_limit.py          # Per-client rate limiting
│   │   ├── error_handlers.py      # Error responses (generic messages + ref codes)
│   │   ├── router/                # HTTP routes (chat, threads, documents, code, health)
│   │   ├── schema/models.py       # Request/response models
│   │   ├── services/
│   │   │   ├── chatbot.py         # LangGraph chat graph and thread metadata
│   │   │   ├── chat.py            # Chat, blog and deep-research turns
│   │   │   ├── rag.py             # Document upload and retrieval
│   │   │   ├── citations.py       # Search citations -> links
│   │   │   ├── run_lock.py        # One reply at a time per thread
│   │   │   ├── thread.py          # Thread ids and titles
│   │   │   └── coding_agent/      # Starts the coding agent; projects, sessions,
│   │   │                          # live turns and approvals
│   │   ├── database/              # MySQL config, models, checkpoint saver
│   │   ├── tools/                 # Search, weather, stocks, calculator,
│   │   │                          # blogs/ and deep_research/
│   │   └── storage/               # Uploaded documents, blogs, images, code projects (git-ignored)
│   ├── scripts/                   # One-off maintenance scripts
│   ├── evals/                     # LangSmith evaluations
│   └── tests/
├── frontend/
│   ├── src/
│   │   ├── components/            # Chat UI; code/ for the Code page
│   │   ├── hooks/                 # useChat, useThreads, useCodeSession, useCodeWorkspace
│   │   ├── services/api.js        # API client
│   │   └── App.jsx
│   └── vite.config.js             # Dev server; proxies /api to the backend
├── coding-agent/                  # Coding agent service (Bun/TypeScript), started by the backend
├── start.sh / start.bat           # Start backend + frontend
└── README.md
```

## API Endpoints

All routes are under `/api`. When `API_TOKEN` is set, send `Authorization: Bearer <token>`.

### Chat
- `POST /api/chat/stream`: stream a reply (Server-Sent Events). Body: `message`, `thread_id`, `tools`, `temporary`, `session_id`
- `POST /api/chat`: send a message, get the full reply
- `POST /api/chat/edit`: edit an earlier message and stream the new reply
- `POST /api/chat/regenerate`: regenerate the last reply
- `POST /api/chat/temp/{session_id}/end`: forget a temporary chat

### Threads
- `GET /api/threads`: list threads
- `POST /api/threads/new`: create a thread
- `GET /api/threads/{id}`: thread messages
- `PUT /api/threads/{id}/title`: rename
- `PUT /api/threads/{id}/reports/{n}`: save an edited deep research report
- `DELETE /api/threads/{id}`: delete a thread with its documents

### Documents
- `POST /api/upload-pdf`: attach a PDF, Markdown or text file to a thread
- `POST /api/query-document`: ask a question about a thread's documents
- `GET /api/threads/{id}/document`: a thread's documents

### Code (coding agent)
- `GET /api/code/status`: whether the coding agent is ready, and its model
- `GET /api/code/projects`, `POST /api/code/projects`: list or create project folders
- `GET /api/code/sessions?project=...`, `POST /api/code/sessions`: list or start coding sessions
- `GET /api/code/sessions/{id}`, `PUT /api/code/sessions/{id}/title`, `DELETE /api/code/sessions/{id}`
- `GET /api/code/sessions/{id}/messages`: a session's history
- `POST /api/code/sessions/{id}/stream`: send a task and stream the agent's work (Server-Sent Events); `POST /api/code/sessions/{id}/stop` stops it
- `GET /api/code/sessions/{id}/approvals`, `POST /api/code/sessions/{id}/approvals/{approval_id}`: pending approvals; answer `once`, `always` or `reject`
- `GET /api/code/projects/{name}/approvals`, `DELETE /api/code/projects/{name}/approvals/{id}`: saved "always" approvals

### Other
- `GET /api/health`: health check
- `GET /api/blog-images/{file}`: images generated for blogs

## Development

```bash
# Backend tests (no MySQL or API keys needed)
cd backend && python -m unittest discover -s tests -t .
# or, with the dev tools: pip install -r requirements-dev.txt && pytest

# Frontend production build
cd frontend && npm run build

# Coding agent: typecheck, and tests per package
cd coding-agent && bun run typecheck:tsc
cd coding-agent/packages/core && bun test
```

Set `RELOAD=true` in `backend/.env` to auto-reload the backend on code changes.

### Upgrading an existing database

Chat history used to be stored with Python `pickle`. The app no longer loads pickled data, for security. Convert old data once:

```bash
cd backend && python -m scripts.migrate_checkpoints
```

The backend logs a reminder at startup if old data is still present.

## Troubleshooting

- **Backend exits at startup with "Startup failed: ..."**: the message names the problem. Usually MySQL isn't running, the `MYSQL_*` settings are wrong, or `LLM_API_KEY` / `LLM_MODEL` are missing.
- **Model errors (401/404)**: check `LLM_API_KEY`, `LLM_MODEL` and, for non-OpenAI hosts, `LLM_BASE_URL`. Also check that `LLM_PROVIDER` matches the API your provider speaks.
- **Tools never used / tool errors**: choose a model that supports tool calling.
- **"Too many requests"**: raise `RATE_LIMIT_PER_MINUTE` (or set it to 0) for local use.
- **Frontend can't reach the backend**: make sure the backend is running on port 8000. If you set `API_TOKEN`, set the same value as `VITE_API_TOKEN` in `frontend/.env.local`.
- **First document upload is slow**: the embedding model loads on first use (a few seconds, once).
- **Code page says the coding agent is unavailable**: the notice gives the reason. Usually Bun isn't installed (install it, or set `BUN_PATH`), `bun install` wasn't run in `coding-agent/`, or the API is exposed without `CODING_AGENT_ENABLED=true`. Details are in `backend/app/storage/coding-agent/agent.log`.
- **Coding tasks fail with "larger than the model allows" or a rate limit**: the agent's requests are bigger than chat's. Use a model or plan with higher limits via `CODING_AGENT_MODEL`.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Thanks to Contributors

A big thank you to everyone who has helped build OpenGPT! 💙


<a href="https://github.com/GenAIwithMS/OpenGPT/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=GenAIwithMS/OpenGPT" alt="Contributors"/>
</a>

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- LangGraph team for the agentic framework
- Every provider that offers an OpenAI- or Anthropic-compatible API
- FastAPI for the modern Python web framework
- React and Vite for the frontend tooling
- [opencode](https://github.com/anomalyco/opencode): the coding agent is based on the opencode agent harness (MIT License, see [coding-agent/LICENSE](coding-agent/LICENSE))

## Related Resources

- [Equibles](https://equibles.com): stock market data API
