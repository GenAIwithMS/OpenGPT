# 0006. Auto picks a model per message without an extra model call

Status: accepted (2026-11-17)

## Context

Users wanted a model menu by the send button, like other chatbots, with an
Auto choice that uses a suitable model for each task. Asking a model to
classify every message first would add latency and cost to every reply, and
many setups have tight rate limits.

## Decision

Auto (`backend/app/services/model_router.py`) looks at the message itself:
greetings and very short replies go to the *Titles and summaries* model;
long, code-heavy or analytical requests (and questions about attached
documents) go to the *Deep research* model; everything else to the *Chat*
model (the *Coding agent* model on the Code page, which never uses the light
model). The three come from Settings > Developer, so users decide what
"light" and "strong" mean. Picking a model in the menu turns Auto off for
that page.

## Consequences

- No extra call, no added latency; the rules are predictable and testable.
- The rules are simple and will sometimes pick a bigger or smaller model than
  ideal. Users who care pick a model, or set the three job models.
- With one model for every job, Auto changes nothing.
- A smarter router (e.g. a small model deciding) can replace `tier()` later
  without changing the API or the UI.
