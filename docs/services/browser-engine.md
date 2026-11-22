# Browser engine

The engine behind the agent's browser: it builds and runs website tools. The
Agent page uses it through the browser tools ([agent](agent.md#the-browser)).

## Files

`backend/browser_engine/` (TypeScript, Node 24): its own
[AGENTS.md](../../backend/browser_engine/AGENTS.md) has the commands, and
[docs/how-it-works.md](../../backend/browser_engine/docs/how-it-works.md) in
that folder describes every part in detail. The backend starts it from
`app/services/browser_engine.py`. Model access is in the engine's
`typescript/src/models/`: `provider-config.ts` (the configuration and the
provider), `compat-model.ts` (other APIs), `context-window.ts`,
`wrap-model.ts`.

## What it does

It doesn't click around a site with a model every time. It **builds a tool
once** and then runs that tool without a model:

1. **Build ("mint").** Given a site, a task in plain words and whether the
   tool may only **read** or also **write**, a model agent explores the site
   in a local Chromium (driven by Playwright), does the task once and writes
   the steps as code. It asks you questions when it needs something, such as
   which option you meant.
2. **Review (Guardian).** A second model reviews every command and browser
   step before it runs, and the finished code before it is saved: it refuses
   steps outside the task's authority, sign-in tricks and code that sends
   your data elsewhere.
3. **Save.** The result is a folder with the tool's code, its input and
   output schemas and a small MCP server for it.
4. **Run.** Running a saved tool replays its steps in the browser. It needs
   no model and no API key, so it is fast and gives the same result each
   time.

Sign-in: the engine only types a login on the site itself or on sign-in
pages you allow, and never resubmits a login the site rejected.

## How OpenGPT runs it

- `app/services/browser_engine.py` starts it as a **child process** for one
  job and gives it the model configuration as JSON on a pipe (file descriptor
  in `BROWSER_ENGINE_CONFIG_FD`): the API key is never on a command line, in
  the environment or in a file. It opens no port and is not a separate
  service.
- It needs Node.js 24 (`BROWSER_ENGINE_NODE`, or `node` on PATH) and Chromium,
  and a built engine (`pnpm build`). The launcher says which is missing.
- To try a build from the terminal (from `backend/`):
  `python -m app.services.browser_engine mint --url https://example.com
  --intent "Read the main heading" --out /tmp/heading --effect read`.
- The agent's browser tools use its MCP mode (`opengpt-browser-mcp`):
  `mint --root app/storage/browser/integrations` to build, and
  `serve --artifact <tool folder>` to run a saved tool. `EngineClient` in
  `browser_engine.py` speaks MCP over the process's stdin and stdout: it
  calls `mint`, follows the job with `get_job`, and answers its questions
  with `provide_input`.
- The Docker image includes it: a build stage on Node.js 24 builds it, and
  the final image has Node.js 24 and Chromium (`PLAYWRIGHT_BROWSERS_PATH=/opt/playwright`,
  `BROWSER_ENGINE_NODE=/usr/local/bin/node`).
- `./start.sh` builds it the first time and after it changes (when Node.js 24
  is found), and installs Chromium. On Windows the browser isn't available.

## Models

Builds use the **active provider** (Settings > Developer) and two models in
Settings > Models: **Browser build** (`BROWSER_BUILD_MODEL`) and **Browser
review** (`BROWSER_REVIEW_MODEL`, default the build model), both defaulting to
the chat model. The engine names its models by fixed IDs; the provider maps
them to these.

| Provider | API the engine uses |
|---|---|
| OpenAI itself (no base URL) | Responses API: every feature, as the engine was tuned |
| Any other OpenAI-compatible endpoint | Chat Completions |
| Anthropic or an Anthropic-compatible endpoint | Anthropic Messages (through the AI SDK) |

On Chat Completions and Anthropic, `ChatCompletionsCompatModel` turns the
engine's OpenAI-only request features into plain ones: no prompt-cache or
reasoning-continuity settings, the allowed tools as the tool list, the cached
instructions as a system message, function tools instead of hosted shell and
patch tools, and compaction as a summary the model writes. Compaction
thresholds scale to the context window (`BROWSER_CONTEXT_TOKENS`, default
128,000).

**What a build needs from the provider.** A build sends a first request of
about 28,000 tokens (instructions, skills and tools) and hundreds of
thousands of tokens over a build, from a model that calls tools well. A plan
that limits tokens per minute below that refuses the first request (seen
with an 8,000 tokens-per-minute limit: "Request too large"). Set
`BROWSER_ENGINE_LOG_MODEL_ERRORS=1` to see why a provider refuses a call. The
engine was tuned on OpenAI's reasoning models; other models may build less
reliably. See [decision 0011](../decisions/0011-browser-engine-on-any-provider.md).

## Tests

From `backend/browser_engine`: `pnpm typecheck`, `pnpm test` (unit) and, after
`pnpm build` and `pnpm exec playwright install chromium`, `pnpm test:browser`
(local fixture sites). No test calls a real model. CI runs them in the
`browser-engine` job.

## Licence notices

Some of the engine's code comes from other open-source projects; their
required notices are in `backend/browser_engine/THIRD_PARTY_NOTICES.md`. Keep
that file and the licence headers of adapted files.
