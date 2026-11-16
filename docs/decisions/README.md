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
