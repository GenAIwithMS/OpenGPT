# 0011. The browser engine on any provider

Status: accepted (2026-11-22)

## Context

The browser engine was built for OpenAI's Responses API and two OpenAI
models. It uses Responses-only features: encrypted reasoning carried across
turns, prompt-cache options and explicit cache breakpoints, `allowed_tools`,
reasoning-effort update items, hosted shell and apply_patch tools, and
server-side compaction. OpenGPT works with any OpenAI- or Anthropic-compatible
endpoint, and the engine had to use the same providers.

## Decision

- **One provider for all three model roles** (minter, Guardian, outcome
  reviewer), built from OpenGPT's active provider. The engine keeps naming its
  models by their OpenAI IDs; the provider maps them to the **Browser build**
  and **Browser review** models.
- **The API follows the provider**: OpenAI itself uses the Responses API
  unchanged; any other OpenAI-compatible endpoint uses Chat Completions;
  Anthropic-compatible endpoints use the Agents SDK's AI SDK adapter.
- **One adapter instead of changes throughout the engine.**
  `ChatCompletionsCompatModel` turns each request into one a tool-calling chat
  API accepts, and emulates compaction: it answers the compaction trigger with
  a summary the model writes and sends that summary back as a message. The
  engine's build and review logic stays as it was.
- **Wrappers keep the model's class** (`wrapModel`): the SDK chooses function
  tools over hosted tools, and no server compaction, from the class name.
- **The configuration goes on a pipe**, so the key never appears on a
  command line, in the environment or in a file.
- Compaction thresholds scale to the models' context window.

## Consequences

- Measured on 2026-11-22: requests through the adapter work on an
  OpenAI-compatible endpoint (both model roles called tools and answered).
  A full build could not run on that account: its first request is about
  28,000 tokens and the plan allowed 8,000 tokens per minute. A full build
  on a non-OpenAI model is still to be measured on a plan with higher limits.
- Without encrypted reasoning and prompt caching, builds on other APIs cost
  more tokens and may be less reliable than on the models the engine was
  tuned for.
- Compaction on other APIs is a model-written summary, so details the summary
  leaves out are lost; the prompt asks it to keep URLs, selectors, files and
  results.
