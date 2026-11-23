# Agent

> **Status: not fully tested yet.** The Agent page, the browser and scheduled
> tasks are built and covered by automated tests, but they still need proper
> testing in real use. So far: one live agent session with a real model
> worked (a question, a tool and a result); scheduled tasks have only run in
> tests; and the browser has not yet finished a real website build (see
> [browser engine](browser-engine.md)). Expect rough edges, and report what
> you find.

The **Agent** page: you give the agent a task and it works on it in the
background, step by step, with the same tools chat has (web search, weather,
calculator, stocks, knowledge base, skills, memory and your connectors). It
asks you when it needs something, and asks before a connector tool changes
anything. You can close the page; it keeps working.

It can also use **websites** in a browser, and run tasks **on a schedule**
(below).

## Files

| Path | What |
|---|---|
| `app/services/agent/__init__.py` | What the routes call: create, answer, decide, stop, continue, delete |
| `app/services/agent/store.py` | Sessions and events in the database (`agent_sessions`, `agent_events`) |
| `app/services/agent/graph.py` | The LangGraph graph, its tools and prompt |
| `app/services/agent/runner.py` | The background worker, limits, Stop, pauses, recovery after a restart |
| `app/services/agent/browser.py` | The browser tools, site permissions, the browser's questions |
| `app/services/agent/schedules.py` | Scheduled tasks: next times, the scheduler thread, missed runs, expiry |
| `frontend/src/components/agent/Schedules.jsx` | The schedule list and dialog |
| `app/router/browser.py` | `/api/browser`: status, websites, saved website tools |
| `frontend/src/components/agent/BrowserInputCard.jsx` | The browser's questions on the page (login, code, choice) |
| `frontend/src/components/settings/BrowserPage.jsx` | Settings > Browser |
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
`interrupted`, `expired` (a scheduled session's approval nobody answered).

| Situation | What happens |
|---|---|
| You press **Stop** | Running: it stops after the current step. Queued or waiting: at once |
| A limit is reached (`AGENT_MAX_STEPS` model calls, `AGENT_MAX_MINUTES` per run) | Stopped, with the reason; **Continue** goes on |
| The model or a tool fails | `failed`, with a message that names the problem, not internal details |
| OpenGPT restarts | Running sessions become `interrupted` (**Continue** resumes from the last saved step); queued ones are queued again; waiting ones stay waiting |
| Stopped while waiting | **Continue** shows the question or approval again |
| Done | Type an instruction to give it more to do in the same session |

## The browser

When the [browser engine](browser-engine.md) can run here (Node.js 24 and a
built engine; Settings > Browser says what is missing), the agent gets three
tools:

| Tool | Does |
|---|---|
| `Browser_task(url, task, effect, input)` | Builds a tool for the task on that site (minutes). A **read** tool then runs and returns what it found; a **write** tool makes its change once while it is built |
| `Browser_tools()` | Lists saved website tools |
| `Run_browser_tool(name, input)` | Runs a saved tool again, with no model |

- **Permission first.** The first time the agent uses a website it asks
  (an approval card); allowing it lets the agent read that site later too.
  **Every write asks**, also on a site already allowed. Settings > Browser
  lists the websites (read, or read and change) and saved tools; you can
  change or remove them.
- **Logins.** The browser starts empty every time and signs in itself: when a
  site needs a login, a one-time code or a choice, the session waits and the
  page shows a card. The answers go from the page straight to the engine
  (`POST .../browser-input`), kept in memory only: never in the database, the
  events, the checkpoint or a model's context. The engine types a login only
  on that site's own sign-in pages. Logins aren't saved, so a later run asks
  again.
- **Stop** while the browser waits cancels its job. After a restart, a
  session that was waiting for the browser becomes interrupted (the browser
  process is gone); Continue starts the browser task again.
- While the browser works, the run occupies the worker (other sessions wait).
- Saved tools are in `app/storage/browser/integrations/<name>/`.
- **Show the browser window** (Settings > Browser, `/api/browser/options`)
  starts the engine with `--headed`, so Chromium opens in a window on this
  computer.
- Without the browser, the agent's prompt says why (Node.js 24 missing, not
  built), so it tells the user instead of refusing vaguely.

## Scheduled tasks

A schedule starts the same kind of session at set times: **once** (date and
time), **every day**, **some days of the week**, or a **cron line**
(`m h dom mon dow`), in the user's timezone (the browser's, saved with the
schedule). Times are wall-clock times there, so 09:00 stays 09:00 across
daylight saving changes.

- **Prepare and wait.** A scheduled session is told nobody is watching: it
  reads and prepares, and anything that changes data waits for approval, as
  every change does. You get the badge and notification when it needs you.
- **Expiry.** An approval nobody answers within `AGENT_APPROVAL_HOURS`
  (default 24) ends the session as `expired`; nothing is changed. Continue
  shows the approval again.
- **One run at a time.** While a schedule's last session still works or
  waits, its next time is skipped (`skipped_busy`).
- **OpenGPT must be running.** A time missed while it was off is skipped and
  shown as `missed`; with `AGENT_SCHEDULE_CATCH_UP=true` it runs once at
  startup instead.
- A one-off schedule turns itself off after it runs. Pausing keeps it, with
  no next time.
- The scheduler is a thread in the backend that checks every 30 seconds.
- On the Agent page, the start screen lists schedules (run now, pause,
  edit, delete); a session's **Schedule** button schedules its task.

## Events

What the page shows, in order (`agent_events`, numbered per session):
`task`, `instruction`, `plan`, `message`, `tool_call`, `tool_result`,
`question`, `answer`, `approval`, `approval_done`, `browser_input` (the
questions, never an answer or an expected username), `browser_input_done`,
`result`, `status`. A
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
| `POST /api/agent/sessions/{id}/browser-input` | `{request_id, answers}`: answers to the browser's questions, to the engine only |
| `POST /api/agent/sessions/{id}/stop` | Stop |
| `GET /api/browser/status` | `{available, reason}` |
| `GET/PUT /api/browser/options` | `{show_window}`: show the browser in a window |
| `GET/PUT/DELETE /api/browser/sites` | Websites the agent may use: `{url, access: "read" \| "write"}` |
| `GET /api/browser/tools`, `DELETE /api/browser/tools/{name}` | Saved website tools |
| `POST /api/agent/sessions/{id}/continue` | Go on; optional `{message}` adds an instruction |
| `DELETE /api/agent/sessions/{id}` | Delete it, its events and its checkpoint (not while running) |
| `GET/POST /api/agent/schedules` | List, or create `{task, title?, repeat, time, date, days (Monday is 0), cron, timezone}` |
| `PUT/DELETE /api/agent/schedules/{id}` | Change any field (`enabled` pauses), or delete |
| `POST /api/agent/schedules/{id}/run` | Run it now |
| `GET /api/agent/schedules/{id}/runs` | The sessions it started |

## Not covered yet

- Saved logins (each browser task asks for a login again) and a live view
  of the browser in the page (a window on this computer is available).
- Several sessions at once: one runs, the rest queue.

See [decision 0010](../decisions/0010-agent-sessions.md).

## Tests

`tests/test_agent_schedules.py`: next times (timezones, daylight saving,
cron), the scheduler (one run at a time, one-off, paused), missed runs,
expiry, the scheduled-run note, routes.

`tests/test_agent_browser.py`: the browser tools against a stand-in engine
(`tests/fake_browser_engine.py`): permission, the login card (the password
reaches the engine and is stored nowhere), writes, Stop, saved tools,
recovery, routes.

`tests/test_agent.py`: runs with a scripted model (plan, tools, result),
questions, approvals (each tool call runs once), denial, Stop and Continue,
the step limit, failures, restart recovery, the database checkpointer, and
the routes.
