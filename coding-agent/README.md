# OpenGPT Coding Agent

The coding agent gives OpenGPT the ability to work on code: read and edit files, run shell commands, review diffs and ask for approval before risky actions. It runs as its own headless HTTP API server. The OpenGPT backend talks to it over HTTP; it has no user interface of its own.

The coding agent is based on the [opencode](https://github.com/anomalyco/opencode) agent harness (MIT licensed), trimmed to its server and core packages. See [Credits](#credits).

> **Status:** the server runs on its own. Wiring it into the OpenGPT chat (sessions, streaming, approvals, model settings) is in progress.

## Requirements

- [Bun](https://bun.sh) 1.4.4 or newer (`packageManager` in `package.json`)

## Install

```bash
cd coding-agent
bun install
```

## Run

```bash
cd coding-agent/packages/cli
OPENGPT_PASSWORD=change-me bun run src/serve-main.ts --port 4096
```

Options:

| Flag | Meaning |
| --- | --- |
| `--port P` | Port to listen on |
| `--hostname H` | Address to bind (local only by default) |
| `--cors ORIGIN` | Allow browser requests from this origin (repeatable) |

The agent works on the folder the server is started from.

## Authentication

Every request needs HTTP Basic auth with user `opengpt` and the password from `OPENGPT_PASSWORD`:

```bash
curl -u opengpt:change-me http://127.0.0.1:4096/api/info
```

Always set a password, and keep the server on `127.0.0.1` unless it is behind your own access control: the agent can run commands and change files on this machine.

## API

- All routes are under `/api` (sessions, prompts, diffs, permissions, terminals, files, models).
- The OpenAPI spec is at `/openapi.json`.

## Configuration

| Setting | Meaning |
| --- | --- |
| `OPENGPT_PASSWORD` | Server password (required) |
| `OPENGPT_CONFIG` | Path to a config file |
| `OPENGPT_CONFIG_CONTENT` | Config as inline JSON |
| `OPENGPT_LOG_LEVEL` | Log level, e.g. `DEBUG` |

Config is read from, lowest to highest priority:

1. `~/.config/opengpt/opengpt.json` (or `.jsonc`): your global settings
2. `opengpt.json` in the project folder and its parents
3. `.opengpt/opengpt.json` in the project folder and its parents

Data (sessions, logs) is stored in `~/.local/share/opengpt`.

## Layout

```
coding-agent/
├── packages/
│   ├── cli/              # Server entry point (src/serve-main.ts)
│   ├── server/           # HTTP API, auth
│   ├── core/             # Agent loop, sessions, tools, prompts, config
│   ├── ai/               # Model provider adapters
│   ├── protocol/         # API contract
│   ├── schema/           # Shared data types
│   ├── client/           # Generated TypeScript client
│   ├── process-daemon/   # Terminal (PTY) helper
│   └── ...               # util, plugin, codemode, theme, simulation, tooling
└── LICENSE               # opencode's MIT license (must be kept)
```

## Development

```bash
cd coding-agent
bun run typecheck:tsc          # typecheck every package
cd packages/core && bun test   # tests run per package, not from the root
```

## Credits

The coding agent is built on the [opencode](https://github.com/anomalyco/opencode) agent harness by the opencode authors, starting from upstream commit `cbe71595e1` (v2.3.0). It is used under the MIT License; the original copyright notice and license are in [LICENSE](LICENSE), and must be kept with this code.

Changes from upstream: the desktop, terminal and web interfaces and the release tooling were removed, a headless server entry point was added, and user-facing names were changed to OpenGPT.
