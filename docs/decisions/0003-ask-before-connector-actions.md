# 0003. Chat asks before connector tools that can change data

Status: accepted (2026-11-16)

## Context

Connectors give the chat model tools on real accounts: creating issues,
sending payments, editing pages. A model can misread a request or be steered
by text in a web page or document, and it should not change someone's data
on its own.

## Decision

- Tools the MCP server marks read-only (`readOnlyHint`) run directly.
- Every other tool pauses the reply and asks in the chat with an Allow /
  Deny card showing the exact arguments. The tool waits on the user's answer
  (`app/services/chat_approvals.py`); the answer arrives through
  `POST /api/chat/approvals/{id}`.
- No answer within 5 minutes, pressing Stop, or a request from a path that
  can't show the question (not a live chat) counts as Deny.
- The coding agent already asks before every connector tool.

## Consequences

- Users stay in control of anything that changes their accounts.
- Servers that don't mark read-only tools cause more questions; that errs on
  the safe side.
- The waiting tool holds the chat's worker thread while it waits, bounded by
  the timeout.
