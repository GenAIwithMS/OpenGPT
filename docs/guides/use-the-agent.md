# Use the agent

> **Status: not fully tested yet.** The agent, its browser and schedules are
> built, but they need proper testing in real use: the browser in particular
> has not yet finished a real website build. Treat these features as a
> preview and check what they do.

The **Agent** page runs a task in the background: it plans, uses your tools,
connected apps and (optionally) websites, and ends with a summary. You can
close the page while it works.

## Give it a task

1. Open **Agent** in the sidebar and describe the task. Say what you want at
   the end: "Check my open GitHub issues and draft a short status update."
2. Watch the plan and each step, or leave. The sidebar shows a number when
   a session needs you; turn on notifications in Settings > General.
3. When it asks something, answer in the card. When it wants to change
   something (post, send, create, delete), it shows what and waits for
   **Allow** or **Deny**.
4. **Stop** at any time. After a stop, a limit or a restart, **Continue**
   goes on. When it's done, type an instruction to give it more to do.

Choose its model in Settings > Models (**Agent**). It needs a model that calls
tools well.

## Websites

For sites you have no connector for, the agent can use a browser.

- **Setup.** It needs Node.js 24 on macOS or Linux (or the Docker image,
  which has it). Install Node.js 24, or set `BROWSER_ENGINE_NODE` in
  `backend/.env` to a Node.js 24 binary; `./start.sh` then builds the browser
  engine and installs Chromium the first time. Restart the backend after
  changing it. Settings > Browser says whether it's ready, or what's missing.
  Until then the agent has no browser tools and says so if you ask it to use
  a website.
- **It's OpenGPT's own browser**, not the one you are using: the agent never
  controls your browser or its sign-ins.
- **Watch it.** Turn on **Show the browser window** in Settings > Browser to
  see the browser in a window on your computer while it works (needs a
  screen; leave it off on a server or in Docker).
- **Permission.** The first time it uses a site, it asks. Every change on a
  website asks again. Settings > Browser lists the sites (read, or read and
  change) and lets you remove them.
- **Logins.** When a site needs a login, a code or a choice, the page shows a
  card. The login goes only to the browser, which types it only on that
  site. It isn't saved, so a later task asks again. Some sites, such as
  Google's sign-in, block automated browsers.
- **Saved tools.** Each website task leaves a tool that does the same task
  again quickly, without a model. Settings > Browser lists them.
- **Models.** Building a website tool uses the **Browser build** and
  **Browser review** models (Settings > Models). A build sends large requests
  (its first one is about 28,000 tokens), so the provider plan needs high
  per-minute token limits.

## Schedules

On the Agent page, **New schedule** (or **Schedule** on a session) runs a
task at set times: once, every day, on some weekdays, or by a cron line, in
your timezone.

A scheduled run prepares everything and **waits for your approval** before
it changes anything. If nobody answers within a day, nothing is changed and
the session ends as expired. OpenGPT must be running at that time; a time
missed while it was off is skipped (or run once at startup with
`AGENT_SCHEDULE_CATCH_UP=true`).

## What is stored, and how to delete it

| What | Where | Delete it |
|---|---|---|
| Sessions: task, plan, steps, tool results (cut to 8,000 characters), your answers to questions, the result | The database (`agent_sessions`, `agent_events`) and the agent's checkpoint | Delete the session (sidebar menu on the Agent page) |
| Schedules | The database (`agent_schedules`) | Delete the schedule on the Agent page |
| Websites the agent may use | The database (app settings) | Settings > Browser |
| Saved website tools (code that repeats a task on a site) | `backend/app/storage/browser/integrations/` | Settings > Browser, or delete the folder |
| Logins, one-time codes and other answers to the browser | **Not stored**: kept in memory until the browser takes them | Nothing to delete |

The browser starts with an empty profile every time, so no cookies or site
data are kept between tasks.

## Limits

| Setting | Default | Meaning |
|---|---|---|
| `AGENT_MAX_STEPS` | 50 | Model calls per run; then it stops and Continue goes on |
| `AGENT_MAX_MINUTES` | 30 | Minutes per run, the same way |
| `AGENT_APPROVAL_HOURS` | 24 | A scheduled run's unanswered approval expires after this |

One session runs at a time; others wait their turn. See
[agent](../services/agent.md) and [browser engine](../services/browser-engine.md)
for how it works.
