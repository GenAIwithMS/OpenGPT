# Coding agent

The headless agent service behind OpenGPT's Code page: TypeScript on Bun,
built with Effect. It is a trimmed fork of an MIT-licensed agent harness
(credits and the starting upstream commit are in [README.md](README.md)).
The OpenGPT backend starts it (`backend/app/services/coding_agent/`); it has
no UI of its own.

```bash
bun install                                   # once
bun run typecheck:tsc                         # type check every package
cd packages/server && bun run typecheck:tsc   # one package (faster)
cd packages/core && bun test                  # tests run per package, never from the root
```

`bun run typecheck` and `bun run check` need a Bun command this setup doesn't
have; use `typecheck:tsc`.

## Packages that matter here

| Package | Role |
|---|---|
| `packages/cli` | Entry point: `src/serve-main.ts`; `src/server-process.ts` turns `OPENGPT_*` environment variables into server options. |
| `packages/server` | HTTP API and auth; `src/options.ts` (option schema), `src/routes.ts` (wires options into services). |
| `packages/core` | Agent loop, sessions, tools, permissions, config discovery (`src/config.ts`, `src/config/discovery.ts`), skills, MCP. |
| `packages/ai` | Model provider adapters. |
| `packages/protocol`, `packages/schema`, `packages/client` | API contract, shared types, generated client. |

## Rules

- **Keep `LICENSE`** and the credits in `README.md`. In OpenGPT commit
  messages, call this "the coding agent".
- **Keep changes small and marked** so upstream fixes stay easy to bring
  over. Prefer an `OPENGPT_*` environment switch over rewriting behaviour,
  and leave a short comment saying why.
- **Adding a server option** needs four places, or it is silently dropped:
  the env variable in `cli/src/server-process.ts`, the field in
  `server/src/options.ts`, forwarding in `server/src/routes.ts` (it copies
  options field by field), and the option in `core/src/config.ts` `Options`
  where it is used. Then run `typecheck:tsc`.
- **Switches OpenGPT relies on** (set by the backend, keep them working):
  `OPENGPT_PASSWORD` (Basic auth, user `opengpt`), `OPENGPT_CONFIG_CONTENT`
  (config as JSON: model, `mcp`, `skills.paths`), `OPENGPT_STRICT_LOCATION`,
  `OPENGPT_DISABLE_PROJECT_CONFIG`, `OPENGPT_DISABLE_CLAUDE_CODE`,
  `OPENGPT_DISABLE_AGENTS_SKILLS`, `OPENGPT_DISABLE_FREE_MODELS`,
  `OPENGPT_DISABLE_MODELS_FETCH`.
- **Safety defaults stay on.** Listen on `127.0.0.1` only, require the
  password, ask before edits and commands, keep file access inside the
  session's folder. Don't add hosted models, telemetry, auto-update or share
  links.
- **No UI here.** The interface is OpenGPT's frontend; don't bring back the
  desktop, terminal or web apps.
- **Generated code.** Don't edit `packages/client` generated files by hand.

## Checking against a real agent

Start it through the backend on a test port, or by hand:

```bash
cd packages/cli
OPENGPT_PASSWORD=test bun --env-file=../../../backend/.env run src/serve-main.ts --port 4096
curl -u opengpt:test http://127.0.0.1:4096/api/info
```

`GET /api/skill` lists the skills it loaded; `/openapi.json` has every route.
Stop it when you are done.
