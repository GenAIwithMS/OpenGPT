# AGENTS.md: browser engine

OpenGPT's browser engine (TypeScript, Node 24). It builds website integrations
in a local Chromium: it explores a site, does a task once, writes a
deterministic tool for it and has the tool's code reviewed before it is
saved. Running a saved tool needs no model. See
[docs/services/browser-engine.md](../../docs/services/browser-engine.md).

The backend starts it as a child process (`app/services/browser_engine.py`),
with the model configuration on a pipe, only while a job needs it. It never
runs as a separate service and opens no port.

## Commands

Node 24.21 or a later Node 24 release, and pnpm (the version in
`package.json`, `packageManager`).

```bash
cd backend/browser_engine
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build                 # browser tests run the built dist/
pnpm test                  # unit tests (Vitest)
pnpm exec playwright install chromium
pnpm test:browser          # browser tests against local fixture sites
```

Tests use fixture sites and scripted model responses. They need no model key,
and no test may call a real model.

## Layout

- `typescript/src/`: the minter, Guardian (reviews every command and the
  final code), the runtime that runs saved tools, browser helpers, the local
  MCP host and the terminal interface (`standalone/`)
- `typescript/authoring/`: the minter's prompts and examples (skills)
- `typescript/tests/unit/`, `typescript/tests/browser/`: tests
- `tools/copy-assets.ts`: copies prompts and policies into `dist/`
- `THIRD_PARTY_NOTICES.md`: licence notices that must stay (see below)

## Rules

- **Keep the notices.** Parts of the engine come from MIT and Apache 2.0
  projects, whose licences require their notices to stay with the code.
  Never delete `THIRD_PARTY_NOTICES.md`, or the source and licence header at
  the top of files adapted from them (such as `guardian/upstream-policy.md`
  and `destinations/accessible-name.ts`).
- **Names.** User-facing text says OpenGPT. The package is
  `opengpt-browser-engine`; saved tools import `opengpt-browser-engine/runtime`.
- **Models.** The engine names its build and review models by the IDs in
  `typescript/src/models/models.ts` (a unit test keeps them there);
  `models/provider-config.ts` maps them to the models OpenGPT configures and
  picks the API (Responses, Chat Completions or Anthropic). Other APIs go
  through `models/compat-model.ts`, which turns Responses-only request
  features into plain ones. A model wrapper must keep the model's class:
  use `wrapModel` (the SDK reads the class name to choose function or hosted
  tools).
- **Prompts are hashed.** Some unit tests pin the hash of prompt files; when you
  change a prompt, update the hash the test names.
- Write the failing test first for a change in behaviour.
