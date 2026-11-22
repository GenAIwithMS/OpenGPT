# Browser engine

The engine that will let OpenGPT's agent use websites in a browser. It is in
the repository but not used by the app yet: the Agent page (planned) will
start it.

## Files

`backend/browser_engine/` (TypeScript, Node 24): its own
[AGENTS.md](../../backend/browser_engine/AGENTS.md) has the commands, and
[docs/how-it-works.md](../../backend/browser_engine/docs/how-it-works.md) in
that folder describes every part in detail.

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

## How OpenGPT will run it

- The backend starts it as a **child process** for one job, talks to it over
  stdin and stdout, and stops it when the job ends. It opens no port and is
  not a separate service.
- It needs Node 24 and Chromium on the machine (and, later, in the Docker
  image). Until the Agent page uses it, the image doesn't include it.

## Models

Today the engine calls OpenAI models (set in
`typescript/src/models/models.ts`) through the OpenAI Agents SDK, and needs
an OpenAI key to build tools. Making it use the providers configured in
OpenGPT (any OpenAI- or Anthropic-compatible endpoint) is planned work.

## Tests

From `backend/browser_engine`: `pnpm typecheck`, `pnpm test` (unit) and, after
`pnpm build` and `pnpm exec playwright install chromium`, `pnpm test:browser`
(local fixture sites). No test calls a real model. CI runs them in the
`browser-engine` job.

## Licence notices

Some of the engine's code comes from other open-source projects; their
required notices are in `backend/browser_engine/THIRD_PARTY_NOTICES.md`. Keep
that file and the licence headers of adapted files.
