# Coding agent integration

The Code page talks to the backend; the backend runs the coding agent
(`coding-agent/`, a Bun service) as a child process and talks to it over HTTP
on `127.0.0.1` with a random password.

| Module | Role |
|---|---|
| `config.py` | Settings (`CODING_AGENT_*`) and the agent's JSON config: model from `app/llm.py`, connectors (`mcp`), skills (`skills.paths`). |
| `process.py` | Start, watch, restart and stop the agent; its environment. |
| `client.py` | Every HTTP call to the agent (`call()` adds the password). |
| `projects.py` | Project folders the agent may work in (`CODE_ALLOWED_ROOTS`). |
| `sessions.py` | Sessions and messages; `PERMISSION_RULES` (what runs without asking). |
| `stream.py` | One turn: send the message, relay the agent's events as SSE. |
| `approvals.py` | Answering the agent when it asks before acting. |

## Rules

- **Start the agent only through `spawn()`** (`process.py`). Linux sends the
  parent-death signal when the *thread* that started a child exits, so a child
  started from a short-lived thread (e.g. a restart after a settings change)
  gets SIGTERM moments later ("exit code -15"). `spawn()` uses one thread that
  lives as long as the backend.
- **Restart, don't patch, to apply settings.** Connectors, skills and the
  model are read when the agent starts. After changing them call
  `agent.restart()` in a background thread. An agent started by hand
  (`CODING_AGENT_URL`) is never restarted.
- **The agent's environment is an allowlist** (`child_env()` plus
  `_AGENT_FLAGS`). Don't pass the backend's whole environment: it holds
  secrets the agent doesn't need. Keep these flags on:
  `OPENGPT_STRICT_LOCATION` (files outside the project count as outside),
  `OPENGPT_DISABLE_PROJECT_CONFIG` (a project can't change permissions),
  `OPENGPT_DISABLE_CLAUDE_CODE` and `OPENGPT_DISABLE_AGENTS_SKILLS` (skills
  come only from Settings > Skills), `OPENGPT_DISABLE_FREE_MODELS`.
- **Asking before acting is the safety model.** Only read-only actions are in
  `PERMISSION_RULES`; edits, commands, web access and connector (MCP) tools
  ask the user. Don't add allow rules for actions that change things.
- **Projects** must stay inside `CODE_ALLOWED_ROOTS`; hidden folders and the
  home folder itself are refused (`projects.py`).
- The agent's log is `app/storage/coding-agent/agent.log`.

## Testing

`tests/test_coding_agent.py`, `test_code_*.py` use a fake agent server; they
never start Bun. To check the real agent by hand, start a backend on another
port (`PORT=8001`) and stop it afterwards; don't touch the developer's backend.
