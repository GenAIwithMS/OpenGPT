# Agent

The **Agent** page: you give the agent a task and it works on it in the
background, step by step, with the same tools chat has (web search, weather,
calculator, stocks, knowledge base, skills, memory and your connectors). It
asks you when it needs something, and asks before a connector tool changes
anything. You can close the page; it keeps working.

The browser (signing in to websites and using them) and scheduled tasks are
planned next; see [browser engine](browser-engine.md).

## Files

| Path | What |
|---|---|
| `app/services/agent/__init__.py` | What the routes call: create, answer, decide, stop, continue, delete |
| `app/services/agent/store.py` | Sessions and events in the database (`agent_sessions`, `agent_events`) |
| `app/services/agent/graph.py` | The LangGraph graph, its tools and prompt |
| `app/services/agent/runner.py` | The background worker, limits, Stop, pauses, recovery after a restart |
| `app/services/chat_approvals.py` | Approvals: in a session they pause the graph instead of waiting in chat |
| `app/router/agent.py` | `/api/agent` |
| `frontend/src/components/agent/AgentView.jsx` | The page: new task, the session timeline, question and approval cards |
| `frontend/src/hooks/useAgentSessions.js` | The session list, the sidebar badge, notifications |

## How a session runs

1. **Start.** `POST /api/agent/sessions` saves the task (status `queued`) and
   queues it. One worker thread runs one session at a time; others wait.
2. **Work.** The graph alternates between the model (the **Agent** model in
   Settings > Models, `AGENT_MODEL`, default the chat model) and tools. It
   writes a plan with `Update_plan`, then calls tools. The tools node runs
   **one tool call per step**, and every step is checkpointed (thread id
   `agent-<session id>` in the chat checkpointer; chat lists leave these
   out).
3. **Pause.** `Ask_user` and approvals call LangGraph's `interrupt()`. The
   graph stops, the session becomes `waiting`, and the worker moves on to the
   next session. There is no time limit. Your answer
   (`POST .../answer` or `.../approval`) queues the session again, and the
   graph resumes inside the same tool call. Because each call is its own
   step, a call that already finished never runs twice.
4. **Finish.** When the model replies without tool calls, that reply is the
   result and the session is `done`.

Statuses: `queued`, `running`, `waiting`, `done`, `failed`, `stopped`,
`interrupted`.

| Situation | What happens |
|---|---|
| You press **Stop** | Running: it stops after the current step. Queued or waiting: at once |
| A limit is reached (`AGENT_MAX_STEPS` model calls, `AGENT_MAX_MINUTES` per run) | Stopped, with the reason; **Continue** goes on |
| The model or a tool fails | `failed`, with a message that names the problem, not internal details |
| OpenGPT restarts | Running sessions become `interrupted` (**Continue** resumes from the last saved step); queued ones are queued again; waiting ones stay waiting |
| Stopped while waiting | **Continue** shows the question or approval again |
| Done | Type an instruction to give it more to do in the same session |

## Events

What the page shows, in order (`agent_events`, numbered per session):
`task`, `instruction`, `plan`, `message`, `tool_call`, `tool_result`,
`question`, `answer`, `approval`, `approval_done`, `result`, `status`. A
tool result shown on the page is cut at 8,000 characters (the model gets the
whole result). The page polls `GET /api/agent/sessions/{id}?after=<seq>`
every 1.5 seconds while the session works, and every 5 seconds otherwise.

## In the app

- **Agent** in the sidebar, under Code. A dot (collapsed sidebar) or a
  number shows how many sessions are waiting for you. On the Agent page the
  sidebar lists the sessions, with rename and delete.
- `/agent` starts a task; `/agent/<id>` shows a session: the task, the plan,
  each tool call (open it to see its input and result), questions and
  approvals with their answers, and the result.
- When a session finishes, fails or starts waiting while the tab is hidden,
  you get the notification and sound chosen in Settings > General.

## API

| Route | Does |
|---|---|
| `GET /api/agent/sessions` | All sessions, latest activity first |
| `POST /api/agent/sessions` | Start `{task}` |
| `GET /api/agent/sessions/{id}?after=N` | The session and its events after event N |
| `PUT /api/agent/sessions/{id}` | Rename `{title}` |
| `POST /api/agent/sessions/{id}/answer` | Answer its question `{text}` |
| `POST /api/agent/sessions/{id}/approval` | `{decision: "allow" \| "deny"}` |
| `POST /api/agent/sessions/{id}/stop` | Stop |
| `POST /api/agent/sessions/{id}/continue` | Go on; optional `{message}` adds an instruction |
| `DELETE /api/agent/sessions/{id}` | Delete it, its events and its checkpoint (not while running) |

## Not covered yet

- The browser (phase 3) and scheduled tasks (phase 4).
- Several sessions at once: one runs, the rest queue.

See [decision 0010](../decisions/0010-agent-sessions.md).

## Tests

`tests/test_agent.py`: runs with a scripted model (plan, tools, result),
questions, approvals (each tool call runs once), denial, Stop and Continue,
the step limit, failures, restart recovery, the database checkpointer, and
the routes.
