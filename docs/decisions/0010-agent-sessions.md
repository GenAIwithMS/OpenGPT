# 0010. Agent sessions: background tasks that pause for the user

Status: accepted (2026-11-22)

## Context

Chat answers one message at a time, and its approvals wait at most five
minutes in the open page. Longer tasks ("check my issues, draft an update,
post it") need to run for minutes, survive closing the page or restarting
OpenGPT, and wait for the user as long as it takes before anything changes.
This is also the base for the browser and for scheduled tasks.

## Decision

- **A session is a LangGraph graph with a checkpoint**, in the chat
  checkpointer under `agent-<id>`, plus a row and an event log for the page.
  It reuses chat's tools unchanged, including tools that read LangGraph state.
- **Pauses use `interrupt()`.** A question or an approval stops the graph;
  the session is `waiting` with no time limit and the worker is free. The
  answer resumes it, also after a restart. Chat's `chat_approvals.ask` checks
  whether it runs in a session and pauses instead of waiting in the stream,
  so connector tools need no change.
- **One tool call per step.** On resume LangGraph runs the paused node
  again. If a node ran several calls, a call that finished before another
  paused would run twice (a second post, a second email). Running one call
  per node means only the paused call runs again.
- **One worker, single user.** Sessions run one at a time; the rest queue.
- **The page polls** for new events instead of a second live stream: simple,
  and it recovers by itself after a restart.

## Consequences

- A task with many tool calls has many steps; the step limit counts model
  calls, not tool calls.
- If OpenGPT stops in the middle of a tool call, Continue runs that call
  again. A connector write that completed just before the stop could repeat;
  the page shows the session as interrupted so the user can check first.
- A long-running session blocks the queue until it finishes or waits.
