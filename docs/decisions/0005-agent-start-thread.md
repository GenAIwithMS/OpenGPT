# 0005. Child processes start from one long-lived thread

Status: accepted (2026-11-16)

## Context

The backend starts the coding agent with Linux's `PR_SET_PDEATHSIG`, so the
agent stops if the backend dies without cleaning up. After connectors were
added, the agent was restarted from short-lived background threads, and it
kept dying with "exit code -15" (SIGTERM). The kernel sends the parent-death
signal when the *thread* that created the child exits, not only when the
process does.

## Decision

All agent processes are started through `process.spawn()`
(`backend/app/services/coding_agent/process.py`): one daemon thread that
lives as long as the backend creates every child; callers on other threads
hand it the job and wait for the result.

## Consequences

- Restarts from any thread are safe, and the agent still stops when the
  backend process ends.
- New code that starts long-running children must use `spawn()`; the rule is
  in `backend/AGENTS.md` and covered by a test in
  `tests/test_coding_agent.py`.
