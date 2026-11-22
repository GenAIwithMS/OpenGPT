# Decisions

Short records of significant choices: the situation, what was decided, and
what follows from it. When a decision changes, add a new record that
replaces the old one rather than rewriting history.

| # | Decision | Date |
|---|---|---|
| [0001](0001-coding-agent-as-separate-service.md) | The coding agent is a separate service, based on an existing open-source agent | 2026-11-14 |
| [0002](0002-encrypted-secrets-in-the-database.md) | Secrets entered in the app are encrypted in the database | 2026-11-16 |
| [0003](0003-ask-before-connector-actions.md) | Chat asks before connector tools that can change data | 2026-11-16 |
| [0004](0004-skills-installed-not-bundled.md) | Third-party skills are installed from GitHub at a pinned version, not bundled | 2026-11-16 |
| [0005](0005-agent-start-thread.md) | Child processes start from one long-lived thread | 2026-11-16 |
| [0006](0006-auto-model-per-message.md) | Auto picks a model per message without an extra model call | 2026-11-17 |
| [0007](0007-find-local-models.md) | Find local models by port and by the apps' own folders | 2026-11-19 |
| [0008](0008-memory.md) | Memory: saved facts plus searching past chats; files stay per chat | 2026-11-21 |
| [0009](0009-projects.md) | Projects: chats with shared instructions and files | 2026-11-22 |
| [0010](0010-agent-sessions.md) | Agent sessions: background tasks that pause for the user | 2026-11-22 |
| [0011](0011-browser-engine-on-any-provider.md) | The browser engine on any provider | 2026-11-22 |
| [0012](0012-browser-sign-in.md) | The browser signs in itself; logins are never stored | 2026-11-23 |

## Template

```markdown
# NNNN. Title

Status: accepted (YYYY-MM-DD)

## Context
What problem or constraint led to this.

## Decision
What we chose.

## Consequences
What gets easier, what gets harder, what to watch.
```
