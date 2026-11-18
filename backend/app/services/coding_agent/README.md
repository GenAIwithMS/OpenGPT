# Coding agent integration

The backend's side of the Code page. The agent itself is a separate Bun
service in `coding-agent/`; this package starts it, configures it and relays
between it and the browser. Rules for changing this code are in
[AGENTS.md](AGENTS.md); the feature overview is in
[docs/services/coding-agent.md](../../../../docs/services/coding-agent.md).

## Lifecycle

```
backend start ──► process.start()
                   ├─ config.model_config_json(): model (llm.settings), every menu model,
                   │  connectors (mcp), skills (paths)
                   ├─ spawn("bun run src/serve-main.ts") on 127.0.0.1:<free port>,
                   │  random password, allowlisted environment
                   └─ _wait_ready(): poll until it answers ─► status "running"

settings change ──► agent.restart() in a thread (stop, start again)
backend stop   ──► process.stop(); the agent also dies with the backend (PR_SET_PDEATHSIG)
```

`status()` notices an agent that exited and reports why ("stopped
unexpectedly (exit code N)"); `/api/code/status` shows it to the UI.

## One turn

```
POST /api/code/sessions/{id}/stream
  stream.run_turn()
   ├─ refuse if the session is busy
   ├─ subscribe to the agent's event stream (first, so nothing is missed)
   ├─ sync_profile(): personalization as an instruction entry
   ├─ POST /api/session/{id}/model  (menu choice or Auto, model_router)
   ├─ POST /api/session/{id}/prompt
   └─ translate agent events ─► SSE: start, model, text, reasoning, tool,
      approval, approval_done, title, error, done
```

Stop: `POST /stop` interrupts the agent. Approvals: the agent asks;
`approvals.py` lists pending requests and answers once / always / reject.
"Always" answers are saved per project and can be revoked.

## Modules

| Module | Owns |
|---|---|
| `config.py` | `CODING_AGENT_*` settings, the agent's JSON config, the coding model |
| `process.py` | `CodingAgent` (start, restart, stop, status), `spawn()`, `child_env()` |
| `client.py` | `call()`: every HTTP request to the agent, with the password and errors mapped to `AppError` |
| `projects.py` | Project folders, `CODE_ALLOWED_ROOTS`, the folder browser |
| `sessions.py` | Sessions and history; `PERMISSION_RULES` |
| `stream.py` | Turns and event translation |
| `approvals.py` | Pending and saved approvals |

## Data

- `code_projects` table: the projects list.
- The agent's own storage (`~/.local/share/opengpt`): sessions, messages.
- `backend/app/storage/coding-agent/agent.log`: the agent's output.
