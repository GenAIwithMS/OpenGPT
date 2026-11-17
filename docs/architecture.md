# Architecture

OpenGPT has three running parts and one database:

```
 Browser ──────────── React app (frontend/, Vite dev server on :3000)
    │  /api (JSON and Server-Sent Events)
    ▼
 FastAPI backend (backend/, :8000) ─────────────► MySQL
    │   ├─ chat graph (LangGraph) ──────────────► model provider (OpenAI- or Anthropic-compatible API)
    │   ├─ documents: local embeddings + FAISS     web search / weather / stocks APIs
    │   ├─ deep research, blog writer graphs
    │   ├─ connectors (MCP clients) ────────────► MCP servers (local commands or remote URLs)
    │   └─ coding agent manager
    │         │  HTTP on 127.0.0.1 with a random password
    ▼         ▼
 Coding agent (coding-agent/, Bun) ─────────────► the same model provider, MCP servers,
                                                   files and commands in project folders
```

- **Frontend** (`frontend/`): a single-page React app. It talks only to the
  backend, through `src/services/api.js`. Streaming replies arrive as
  Server-Sent Events.
- **Backend** (`backend/`): FastAPI. Routers in `app/router/` are thin; the
  logic is in `app/services/`. Every `/api` route checks the optional
  `API_TOKEN` and most are rate limited.
- **Coding agent** (`coding-agent/`): a separate Bun service that edits files
  and runs commands for the Code page. The backend starts it as a child
  process, gives it its config, and relays its events. It asks before
  changing anything.
- **MySQL** stores chat history (LangGraph checkpoints), thread titles,
  settings, connectors and coding projects. The coding agent keeps its own
  sessions in `~/.local/share/opengpt`.
- **Files on disk** live in `backend/app/storage/` (git-ignored): uploaded
  documents, blog images, personal skills, the encryption
  key for stored secrets, and the coding agent's log.

## A chat message, end to end

1. The UI posts to `POST /api/chat/stream` with the text, the thread id and
   any tools the user picked (search, deep research, blogs).
2. `services/chat.py` picks the path: the blog writer, deep research, or the
   chat graph.
3. The chat graph (`services/chatbot.py`) builds the system prompt
   (personalization, knowledge base, skills, connectors), binds the tools and
   streams the model's answer. When the model calls a tool, the tool node runs
   it and the model continues.
4. A connector tool that can change data pauses and sends an `approval`
   event; the UI shows Allow / Deny and posts the answer to
   `/api/chat/approvals/{id}`.
5. Each chunk goes to the browser as an SSE event (`thinking`, `ai`,
   `approval`, ...). The final answer is saved in the thread's checkpoint;
   temporary chats use an in-memory checkpointer and are never saved.

## A coding task, end to end

1. The Code page posts to `POST /api/code/sessions/{id}/stream`.
2. `services/coding_agent/stream.py` subscribes to the agent's event stream,
   sends the message, and relays text, tool calls and approval requests as
   SSE.
3. When the agent wants to edit a file or run a command it asks; the UI's
   answer goes back through `/api/code/sessions/{id}/approvals/{request}`.

## Where settings come from

| Setting | Stored in | Changed in |
|---|---|---|
| Model provider (default), database, API keys for tools, limits | `backend/.env` | the file; see [configuration](configuration.md) |
| Extra providers, model per job | `app_settings` table (keys encrypted) | Settings > Developer |
| Profile, general preferences | `app_settings` | Settings > Personalization, General |
| Connectors | `connectors` table (secrets encrypted) | Settings > Connectors |
| Skills on/off | `app_settings`; skill files on disk | Settings > Skills |

## Security model in short

- The backend listens on `127.0.0.1` by default. Exposing it (`HOST=0.0.0.0`)
  requires `API_TOKEN`, and the coding agent is then off unless
  `CODING_AGENT_ENABLED=true`.
- Secrets saved through the UI are encrypted (`app/secret_box.py`) and never
  sent back to the browser.
- The coding agent runs on `127.0.0.1` with a password, works only inside
  allowed folders, and asks before edits, commands and connector tools.
- Chat asks before connector tools that can change data.

See also the [decisions](decisions/README.md) behind these choices.
