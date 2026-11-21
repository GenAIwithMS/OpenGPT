<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="logo/png/wordmark-white-1024.png" />
    <img src="logo/png/wordmark-1024.png" alt="OpenGPT" width="320" />
  </picture>
</h1>

### An open-source AI chat assistant powered by LangGraph

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
  <a href="LICENSE"><img src="https://img.shields.io/github/license/GenAIwithMS/OpenGPT?style=flat-square&color=22c55e" alt="License" /></a>
  <a href="https://github.com/GenAIwithMS/OpenGPT/stargazers"><img src="https://img.shields.io/github/stars/GenAIwithMS/OpenGPT?style=flat-square&color=facc15" alt="Stars" /></a>
  <a href="https://github.com/GenAIwithMS/OpenGPT/network/members"><img src="https://img.shields.io/github/forks/GenAIwithMS/OpenGPT?style=flat-square&color=60a5fa" alt="Forks" /></a>
  <a href="https://github.com/GenAIwithMS/OpenGPT/issues"><img src="https://img.shields.io/github/issues/GenAIwithMS/OpenGPT?style=flat-square&color=f97316" alt="Issues" /></a>
  <img src="https://img.shields.io/github/last-commit/GenAIwithMS/OpenGPT?style=flat-square&color=a78bfa" alt="Last commit" />
  <a href="https://github.com/GenAIwithMS/OpenGPT/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/GenAIwithMS/OpenGPT/ci.yml?branch=main&style=flat-square&label=CI" alt="CI" /></a>
  <a href="https://hub.docker.com/r/genaiwithms/opengpt"><img src="https://img.shields.io/docker/pulls/genaiwithms/opengpt?logo=docker&label=pulls" alt="Docker pulls" /></a>
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

OpenGPT is an open-source chat assistant built with LangGraph. It has a FastAPI backend and a React frontend. It works with **any model behind an OpenAI- or Anthropic-compatible API**, hosted or self-hosted. Conversations are saved in MySQL.

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
- **Connectors (MCP)**: add GitHub, Notion, Linear and other MCP servers by signing in, or your own by command, URL or JSON; chat and the coding agent can use their tools, and anything that changes data asks first
- **Skills**: reusable instructions (SKILL.md) that chat and the coding agent load when a task fits; built-in ones, an Explore catalog, or create, upload and import from GitHub
- **Personalization and knowledge base**: your profile and custom instructions, plus documents every chat can search
- **Memory**: the assistant remembers facts you share across chats, and can search your past chats when you refer to them
- **Projects**: group chats with shared instructions and files that every chat in the project uses; pin, share, rename and move chats between projects from the sidebar ([Projects](#projects))
- **Pinned chats**: pin a chat or a project to keep it at the top of the sidebar
- **Settings for providers**: add more model providers and choose a model for each job (chat, titles, research, blogs, coding)
- **Search window** (Ctrl/Cmd+K) for chats, coding projects and sessions

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
- An API key for a model provider, or a model running on your computer (Ollama, LM Studio, llama.cpp, Jan or any OpenAI-compatible server)
- Optional: API keys for the tools you want (search, weather, stocks, images)
- Optional: [Bun](https://bun.sh) for the Code page (coding agent); chat works without it

## Run with Docker

The quickest way to try OpenGPT: one image with MySQL alongside, no Python,
Node or MySQL to install.

```bash
cp backend/.env.example backend/.env    # set LLM_* (your model provider) at least
docker compose up -d                    # then open http://localhost:8000
```

It uses the [`genaiwithms/opengpt`](https://hub.docker.com/r/genaiwithms/opengpt) image. Details, updates, local models and the coding agent in Docker: [Run with Docker](docs/guides/run-with-docker.md).

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

To use a model on your computer instead, see [Use a local model](docs/guides/use-a-local-model.md): after the first start, **Settings > Developer > Find local models** finds running servers and downloaded models.

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

**Start scripts:** `./start.sh` (Linux/macOS) or `start.bat` (Windows). They start the backend on port 8000 (or `PORT` from `backend/.env`) and the frontend on port 3000, using `.venv` if present. If a port is already in use they pick the next free one and print the addresses to open. When Bun is installed they also install the coding agent's dependencies on the first run; the backend then starts the coding agent itself.

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

## Projects

A project groups chats that share instructions and files. Every chat in it gets the project's instructions in its system prompt and searches the project's files on each message.

- **Create** a project with the **+** next to **Projects** in the sidebar. Click a project to show or hide its chats; its **...** menu has **Project settings** (instructions and files, in a popup), **Pin project**, **Share project** (copies its link), **Rename project**, **Project home** (its page) and **Delete project** (deletes its chats too). The pencil icon starts a new chat in the project.
- **Chat menu**: every chat in the sidebar has **Share** (copies its link), **Rename**, **Pin chat**, **Move to project** (hover to pick a project or create one), **Remove from project** and **Delete**.
- **Pinned** chats and projects stay at the top of their list, with a pin icon. Pinning doesn't change when they were last used.

Shared links open for anyone who can already reach your OpenGPT (your other devices, or others on the same server); there are no public links. See [docs/services/projects.md](docs/services/projects.md).

## Coding agent

The **Code** page in the sidebar runs a coding agent on your machine. Pick or create a project, describe a task, and watch it work: its reply, its thinking, and a card for each command it runs or file it reads or edits.

- **Projects are folders on your computer.** Use **Open folder…** in the project menu to browse and pick one (or paste its path), or **New project** to create an empty one in `~/OpenGPT Projects` (`CODE_PROJECTS_ROOT`). Opened folders are remembered in the project menu; removing one from the list never deletes its files. The agent only works inside the chosen folder; anything outside it is refused.
- **Which folders can be opened**: folders inside your home folder by default (`CODE_ALLOWED_ROOTS` to change), never hidden folders such as `~/.ssh`, and never the home folder itself. Browsing and opening folders only work while the API is local (the default).
- **Approvals**: the agent asks before editing files, running commands, going online or reading `.env` files. Each request shows the command or the diff, with **Allow once**, **Always allow** (saved for the project; it says exactly what it covers, e.g. "commands starting with `git`") and **Deny** (optionally with a reason for the agent). Saved approvals can be reviewed and revoked from the project menu.
- **Model**: it uses `LLM_*` like the chat. Its requests are large (about 6,000 to 9,000 tokens of instructions and tool descriptions each), so set `CODING_AGENT_MODEL` to a model or plan with higher limits if requests fail with a "larger than the model allows" or rate-limit message.
- **Stop** ends the current task. If you close the page, the agent keeps working; reopen the session to see the result.

> ⚠️ **The coding agent runs commands and changes files on this computer.** Read approval requests before allowing them, and keep the API local (the default). When `HOST` exposes the API, the coding agent is off unless you set `CODING_AGENT_ENABLED=true`, and `API_TOKEN` is required.

How it is protected: the agent listens only on 127.0.0.1 with a password made for each run that never reaches the browser; it gets no backend secrets in its environment; only the configured model is available; a project folder can't change the agent's settings or permissions; and error details from the model are logged, not shown.

## Configuration

All settings live in `backend/.env`. [`backend/.env.example`](backend/.env.example) lists them with comments, and [docs/configuration.md](docs/configuration.md) describes every one. More providers and a model per job can be set in the app (Settings > Developer). The main groups:

| Group | Settings |
|---|---|
| Model | `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, optional per-task models |
| Tools | `PARALLEL_API_KEY` / `BRAVE_API_KEY` (search), `WEATHER_API_KEY`, `STOCK_API_KEY`, `GOOGLE_API_KEY` (blog images), `TAVILY_API_KEY` |
| Database | `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE` |
| Server | `HOST` (default `127.0.0.1`), `PORT`, `RELOAD`, `CORS_ORIGINS`, `ENABLE_DOCS`, `LOG_LEVEL` |
| Security | `API_TOKEN` (required when `HOST` is not local; set `VITE_API_TOKEN` in `frontend/.env.local` to match) |
| Limits | `RATE_LIMIT_PER_MINUTE`, `MAX_MESSAGE_CHARS`, `MAX_UPLOAD_MB`, `MAX_BLOG_SECTIONS`, `MAX_CHECKPOINTS_PER_THREAD`, ... |
| Tracing | `LANGSMITH_TRACING` (off by default), `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT` |
| Coding agent | `CODING_AGENT_ENABLED`, `CODING_AGENT_MODEL`, `CODE_ALLOWED_ROOTS`, `CODE_PROJECTS_ROOT`, `BUN_PATH`, `CODING_AGENT_PORT`, or `CODING_AGENT_URL` + `CODING_AGENT_PASSWORD` for an agent you start yourself |
| Frontend (`frontend/.env.local`) | `VITE_API_URL` (default `/api`: the Vite dev server forwards it to the backend; set the backend URL for other setups), `VITE_API_TOKEN` (when `API_TOKEN` is set) |

Tools without a key are simply unavailable. For example, without `GOOGLE_API_KEY` blogs show image captions instead of images.

## Project Structure

```
backend/        FastAPI app: routers, services, chat graph, tools, tests
frontend/       React app (Vite, Tailwind)
coding-agent/   Coding agent service (Bun/TypeScript), started by the backend
docs/           Developer documentation
start.sh / start.bat   Start backend + frontend
```

How the parts fit together: [docs/architecture.md](docs/architecture.md).
Each feature has its own page in [docs/](docs/README.md).

## API

All routes are under `/api`; when `API_TOKEN` is set, send
`Authorization: Bearer <token>`. The interactive reference with every route
and its parameters is at http://127.0.0.1:8000/docs on a running backend.
The [service pages](docs/README.md#services) explain what each group of
routes does.

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

New tables and columns (for example projects and pinned chats) are added automatically when the backend starts; restart it after updating.

## Troubleshooting

- **Backend exits at startup with "Startup failed: ..."**: the message names the problem. Usually MySQL isn't running, the `MYSQL_*` settings are wrong, or `LLM_API_KEY` / `LLM_MODEL` are missing.
- **Model errors (401/404)**: check `LLM_API_KEY`, `LLM_MODEL` and, for non-OpenAI hosts, `LLM_BASE_URL`. Also check that `LLM_PROVIDER` matches the API your provider speaks.
- **Tools never used / tool errors**: choose a model that supports tool calling (for llama.cpp, start `llama-server` with `--jinja`).
- **Local model not found or not answering**: open **Settings > Developer > Find local models**. It says whether the server is running and which models are downloaded. Long chats cut off with Ollama: raise `OLLAMA_CONTEXT_LENGTH`.
- **"Too many requests"**: raise `RATE_LIMIT_PER_MINUTE` (or set it to 0) for local use.
- **Frontend can't reach the backend**: make sure the backend is running on port 8000 (the start scripts handle other ports themselves; when starting by hand on another port, set `OPENGPT_BACKEND_PORT` for `npm run dev`). If you set `API_TOKEN`, set the same value as `VITE_API_TOKEN` in `frontend/.env.local`.
- **First document upload is slow**: the embedding model loads on first use (a few seconds, once).
- **Code page says the coding agent is unavailable**: the notice gives the reason. Usually Bun isn't installed (install it, or set `BUN_PATH`), `bun install` wasn't run in `coding-agent/`, or the API is exposed without `CODING_AGENT_ENABLED=true`. Details are in `backend/app/storage/coding-agent/agent.log`.
- **Coding tasks fail with "larger than the model allows" or a rate limit**: the agent's requests are bigger than chat's. Use a model or plan with higher limits via `CODING_AGENT_MODEL`.

## Getting help

- **Questions** (setup, model providers, connectors, the coding agent): ask in [Discussions Q&A](https://github.com/GenAIwithMS/OpenGPT/discussions/categories/q-a). Check [Troubleshooting](#troubleshooting) first.
- **Ideas**: start a thread in [Discussions Ideas](https://github.com/GenAIwithMS/OpenGPT/discussions/categories/ideas).
- **Bugs**: open an [issue](https://github.com/GenAIwithMS/OpenGPT/issues/new/choose).
- **Security problems**: report them privately through [Security advisories](https://github.com/GenAIwithMS/OpenGPT/security/advisories/new), not in public.

Never post your `backend/.env`, API keys or tokens.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and commit conventions. AI coding agents read [AGENTS.md](AGENTS.md) and the `AGENTS.md` in each part of the project.

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
