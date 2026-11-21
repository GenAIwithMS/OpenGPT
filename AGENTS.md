# AGENTS.md

Instructions for AI coding agents working in this repository. People: see
[CONTRIBUTING.md](CONTRIBUTING.md).

OpenGPT is an open-source chat assistant: a FastAPI + LangGraph
backend, a React frontend, and a coding agent (a separate Bun service) behind
the Code page. Data is stored in MySQL.

## Where things are

| Path | What | Read first |
|---|---|---|
| `backend/` | FastAPI app, LangGraph chat graph, services, tests | [backend/AGENTS.md](backend/AGENTS.md) |
| `backend/app/services/coding_agent/` | Starts and talks to the coding agent | [its AGENTS.md](backend/app/services/coding_agent/AGENTS.md) |
| `frontend/` | React + Vite + Tailwind UI | [frontend/AGENTS.md](frontend/AGENTS.md) |
| `coding-agent/` | The coding agent service (TypeScript, Bun), a trimmed fork | [coding-agent/AGENTS.md](coding-agent/AGENTS.md) |
| `docs/` | Developer docs: architecture, configuration, one page per service, guides, decisions | [docs/README.md](docs/README.md) |
| `README.md` | What OpenGPT is, quick start, configuration | |
| `Dockerfile`, `docker-compose.yml`, `.dockerignore` | The `genaiwithms/opengpt` image (backend + built frontend + coding agent) and MySQL | [Run with Docker](docs/guides/run-with-docker.md) |
| `.github/workflows/ci.yml` | CI: tests, frontend build and coding agent type check on pushes to `main` and pull requests; then builds and pushes the image to Docker Hub | [Run with Docker](docs/guides/run-with-docker.md#how-the-published-image-is-built) |

More specific `AGENTS.md` files override this one for their folder.

## Commands

```bash
# Backend tests: no MySQL, API keys or network needed
cd backend && python -m unittest discover -s tests -t .

# Frontend build (there is no separate lint step)
cd frontend && npm run build

# Coding agent type check, and its tests (per package)
cd coding-agent && bun run typecheck:tsc
cd coding-agent/packages/core && bun test
```

Run the tests for what you changed, and the whole backend suite before you
finish. Add or update tests with every behaviour change.

## Rules

- **Secrets.** Never print, log, commit or send `backend/.env`, API keys,
  tokens or `backend/app/storage/` (it holds the encryption key, uploads and
  logs; it is git-ignored). Stored secrets go through `app/secret_box.py` and
  are never returned by the API.
- **No specific model provider.** OpenGPT works with any OpenAI- or
  Anthropic-compatible endpoint. Don't hard-code or recommend one provider or
  model in code defaults, docs or examples; use the generic `LLM_*` settings.
  (Lists of presets that users choose from are fine.)
- **Running things.** Don't start containers. The developer's own servers
  usually run on ports 8000 (backend) and 3000 (frontend): never stop or
  restart them. For manual checks start your own on other ports (e.g. backend
  `PORT=8001`, frontend `vite preview --port 4317`) and stop them afterwards.
  Remove any test data you create.
- **Docker image.** Nothing secret or user data goes in the image:
  `.dockerignore` lets in only `backend/`, `frontend/`, `coding-agent/` and
  `LICENSE`, without `.env` files, storage or databases. A new system
  dependency or folder the app needs at runtime goes in the `Dockerfile` too.
- **Keep the licence.** `coding-agent/` is based on an MIT-licensed project;
  keep `coding-agent/LICENSE` and its credits.
- **Files that stay out of git:** `CODE_REVIEW_REPORT.md`,
  `CODING_AGENT_PLAN.md`, `SETTINGS_PLAN.md` (private plans),
  `instructions-to-add-settings.txt`, `personal-notes.txt`, `settings/` and
  reference screenshots in the repo root.
- **Docs.** When you change behaviour, settings or a convention, update in
  the same change: the service's page in `docs/services/`, new settings in
  `.env.example` and `docs/configuration.md`, and the matching `AGENTS.md`.
  Record significant design choices in `docs/decisions/`.

## Git

- Only commit when asked. Show the commit message first.
- Stage files by explicit path. Never `git add -A`, `git add .` or a
  repository-wide `git add -u`.
- Commit messages: `type: summary` (`feat`, `fix`, `docs`, `style`,
  `refactor`, `test`, `chore`), then a short body of `-` bullets saying what
  changed for the user. Call the coding agent "the coding agent" (not the name
  of the project it was forked from).
- Don't add `Co-Authored-By` or other AI attribution trailers.

## Writing (UI text, docs, messages)

Plain, short and specific. Say what happens and what the user can do. No
marketing words, no emoji in UI text. Error messages name the problem and the
fix ("Base URL: use an http:// or https:// address").
