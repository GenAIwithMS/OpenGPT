# Coding agent (Code page)

The Code page lets the assistant work on folders on this computer: read and
edit files, run commands, and show diffs, asking before anything that
changes things. The work is done by the coding agent, a separate Bun service
in `coding-agent/`; the backend manages it in
`app/services/coding_agent/` (rules for working there:
[its AGENTS.md](../../backend/app/services/coding_agent/AGENTS.md)).

## How it works

1. **Start.** At backend startup, `process.CodingAgent.start()` launches
   `bun run src/serve-main.ts` on a free `127.0.0.1` port with a random
   password and an allowlisted environment. Its config (`config.py`) carries
   the model (from `app/llm.py`, so the same provider as chat, or the coding
   model from Settings > Developer), enabled [connectors](connectors.md) and
   enabled [skills](skills.md). `/api/code/status` reports starting, running
   or why it is unavailable.
2. **Projects** (`projects.py`): a project is a folder the user opened or
   created, stored in the `code_projects` table. Folders must be inside
   `CODE_ALLOWED_ROOTS`; hidden folders and the home folder itself are
   refused. New projects go in `CODE_PROJECTS_ROOT`.
3. **Sessions** (`sessions.py`): created in the agent for a project folder.
   The agent stores them and their messages itself. `PERMISSION_RULES` lets
   read-only actions run; everything else asks.
4. **A turn** (`stream.py`): subscribe to the agent's events, send the
   message, relay text, reasoning, tool calls and diffs as SSE.
5. **Approvals** (`approvals.py`): when the agent asks, the UI shows the
   request; the user allows once, always (saved for the project) or denies.
6. **Changes to settings** (connectors, skills, provider) restart the agent
   in the background so it reads its config again.

## API

`/api/code/status`, `/code/projects` (list, create, open, remove),
`/code/folders` (folder browser), `/code/sessions` (list, create, rename,
delete, messages), `/code/sessions/{id}/stream`, `/stop`, `/approvals`,
`/code/projects/{id}/approvals` (saved "always allow" answers).

## Settings

[Configuration > Coding agent](../configuration.md#coding-agent). The agent
is off by default when the API is exposed on the network.

## Security

- Bound to `127.0.0.1`, password on every request, never exposed by the
  backend directly.
- File access is limited to the session's folder (`OPENGPT_STRICT_LOCATION`),
  and a project folder can't change the agent's settings or permissions.
- Edits, commands, web access and connector tools ask first.

## Pitfalls

- Start the agent only through `process.spawn()`: started from a short-lived
  thread it is killed moments later (exit code -15). See
  [decision 0005](../decisions/0005-agent-start-thread.md).
- The agent's requests are larger than chat's (instructions and tools); a
  model or plan with small limits may refuse them. Use a different coding
  model in Settings > Developer.
- Logs: `backend/app/storage/coding-agent/agent.log`.

## Tests

`tests/test_coding_agent.py`, `test_code_projects.py`, `test_code_sessions.py`,
`test_code_stream.py`, `test_code_approvals.py` (with a fake agent server).
