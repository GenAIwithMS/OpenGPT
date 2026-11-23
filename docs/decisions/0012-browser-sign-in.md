# 0012. The browser signs in itself; logins are never stored

Status: accepted (2026-11-23)

## Context

The plan was for the user to sign in once in a saved browser profile and the
agent to reuse it. The browser engine works differently: every build and run
starts with an empty browser, and the engine signs in itself. It asks for the
login as a question, types it only on the site's own sign-in pages, keeps it
from the models, and counts a site as signed in only after its own sign-in
steps (a page that already shows an account proves nothing to its checks).
Saved logins and saved browser profiles are not in this version of the
engine. Reusing a signed-in profile would mean rebuilding its sign-in and
safety logic.

## Decision

- Use the engine's sign-in. When it needs a login, a one-time code or a
  choice, the agent session waits and the Agent page shows a card.
- The answers go from the page to the engine through one endpoint and are
  kept in memory only, never in the database, the session's events or
  checkpoint, logs, or a model's context. The browser task blocks in the
  agent's worker while it waits, instead of pausing the graph, so the answer
  never becomes a checkpointed resume value.
- Logins are not saved: each browser task that needs one asks again.
- Sites need the user's permission (read, or read and change), and every
  write asks first.

## Consequences

- Scheduled tasks that need a login will stop and ask each time, until saved
  logins exist (encrypted, opt-in), which can come later.
- Sites that block automated browsers, such as Google's sign-in, can't be
  used this way.
- A session waiting for the browser holds the agent's worker; other sessions
  wait. After a restart the browser process is gone, so the session is
  interrupted and its browser task starts again on Continue.
