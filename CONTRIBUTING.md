# Contributing to OpenGPT

Thanks for helping. This guide covers setting up, making a change and
opening a pull request. Using an AI coding agent? It reads
[AGENTS.md](AGENTS.md); the rules there apply to people too.

Have a question, or an idea you'd like to discuss first? Use
[Discussions](https://github.com/GenAIwithMS/OpenGPT/discussions): Q&A for
questions, Ideas for features. Issues are for bugs and agreed work.

## Set up

Follow the [Quick Start](README.md#quick-start) in the README: Python 3.11+,
Node.js 18+, MySQL, and optionally Bun for the Code page. Then:

```bash
./start.sh          # backend on :8000, frontend on :3000, or the next free ports (start.bat on Windows)
```

Set `RELOAD=true` in `backend/.env` to reload the backend when you edit it.

## Where to make a change

| You are changing | Look in | Guide |
|---|---|---|
| API, chat, tools, settings, connectors, skills, providers | `backend/app/` | [backend/AGENTS.md](backend/AGENTS.md) |
| The Code page's agent integration | `backend/app/services/coding_agent/` | [its AGENTS.md](backend/app/services/coding_agent/AGENTS.md) |
| The UI | `frontend/src/` | [frontend/AGENTS.md](frontend/AGENTS.md) |
| The coding agent service itself | `coding-agent/` | [coding-agent/AGENTS.md](coding-agent/AGENTS.md) |

## Before you open a pull request

```bash
cd backend && python -m unittest discover -s tests -t .   # all tests pass
cd frontend && npm run build                              # builds cleanly
cd coding-agent && bun run typecheck:tsc                  # only if you changed coding-agent/
```

- Add or update tests for what you changed. Backend tests need no MySQL, API
  keys or network.
- Try the change in the browser, including what happens when something fails.
- Update the docs in the same pull request: the README, `.env.example` for
  new settings, and the `AGENTS.md` of the folder if a rule or convention
  changed.
- No secrets, keys, `.env` files or `backend/app/storage/` contents in
  commits, screenshots or logs.
- Keep OpenGPT provider-neutral: no hard-coded default provider or model.

## Commits and pull requests

- Branch from `main` (or the branch you were asked to target) with a short,
  descriptive name.
- Commit messages: `type: summary`, where type is `feat`, `fix`, `docs`,
  `style`, `refactor`, `test` or `chore`. Add a short body of bullets saying
  what changed for users when it isn't obvious. Example:

  ```
  fix: coding agent stopped (exit -15) after connector changes

  - Agents are now started from one long-lived thread, so restarting
    after a settings change no longer stops them
  ```

- One topic per pull request. Describe what changed, why, and how you
  tested it; add screenshots for UI changes.

## Security

Please don't report security problems in a public issue. Contact the
maintainers privately (on GitHub: the repository's Security tab, "Report a
vulnerability", when it is enabled).

## Licence

By contributing you agree that your work is released under the project's
[licence](LICENSE). The coding agent in `coding-agent/` keeps its own MIT
licence and credits; don't remove them.
