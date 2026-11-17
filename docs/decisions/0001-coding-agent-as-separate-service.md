# 0001. The coding agent is a separate service, based on an existing open-source agent

Status: accepted (2026-11-14)

## Context

OpenGPT needed a Code page that can read and edit files and run commands
safely: permissions, approvals, diffs, sessions, many tools. Building that
from scratch in the Python backend would take long and repeat work that
mature open-source agents already do well.

## Decision

Use an MIT-licensed agent harness, trimmed to its headless server and core
packages, as `coding-agent/`. It runs as a separate Bun process that the
backend starts, configures (model, connectors, skills) and talks to over HTTP
on `127.0.0.1` with a random password. OpenGPT keeps its own frontend; the
agent has no UI.

## Consequences

- The Code page gets a capable agent with permissions and approvals from day
  one.
- Two runtimes (Python and Bun) to install and keep working; chat still works
  without Bun.
- Changes to the agent are kept small and behind `OPENGPT_*` switches so
  upstream fixes stay easy to bring in. Its licence and credits must stay
  (`coding-agent/LICENSE`, README).
- The backend owns the agent's lifecycle; see [0005](0005-agent-start-thread.md).
