# Providers (Settings > Developer)

Which model service OpenGPT uses, and which model does each job.

## Files

`app/services/providers.py`, `app/router/providers.py` (`/api/providers`),
`app/llm.py`, `frontend/src/components/settings/DeveloperPage.jsx`,
`ProviderLogo.jsx`.

## How it works

- **Default** is the provider in `backend/.env` (`LLM_*`). The page shows it
  as "Default" with its API type and model, never its address or key.
- **Added providers** come from presets (OpenAI, Anthropic, Gemini,
  OpenRouter, Mistral, DeepSeek, xAI, Groq, Together, Fireworks, Cerebras,
  Hugging Face, Ollama, LM Studio) or Custom (any OpenAI- or
  Anthropic-compatible URL). They are stored in `app_settings` (key
  `providers`) with the API key encrypted.
- **Test** lists the provider's models (`/models`, or `/v1/models` for the
  Anthropic API), which the page offers as suggestions.
- **Active provider and per-job models**: `model` (chat), `small_model`,
  `research_model`, `blog_model`, `coding_model`. Empty means the provider's
  default.
- `llm.settings()` returns the active provider and models; saving calls
  `llm.reload()`, so chat uses the new choice at once, and restarts the
  coding agent.

## The model menu and Auto

Next to the send button (chat and Code) is a menu: **Auto** or one model.

- The list comes from `GET /api/providers/models`: the models chosen for
  each job first, then the active provider's list (cached 10 minutes,
  `providers.available_models()`), without ids that are clearly not chat
  models (embeddings, speech, safety filters, images).
- **Auto** (`app/services/model_router.py`) picks per message, with no extra
  model call: the *Titles and summaries* model for greetings and very short
  replies, the *Chat* model (on Code, the *Coding agent* model) for most
  messages, and the *Deep research* model for long, code-heavy or analytical
  requests and questions about attached documents. Code tasks never use the
  light model. If those jobs share one model, Auto always uses it.
- Picking a model turns Auto off for that page. The choice is remembered in
  the browser (`frontend/src/lib/modelChoice.js`) and sent with each message
  as `model` (`"auto"` or a model id).
- Chat shows which model answered under each reply ("Auto · name" when Auto
  picked it). Deep research and blogs keep using their own job's model.

See [decision 0006](../decisions/0006-auto-model-per-message.md).

## Startup

The backend creates the database first, then checks the model settings, so a
provider chosen in Settings works even if `.env` is incomplete. If neither
`.env` nor a saved provider is usable, the backend stops with a message.

## Security

- Keys are encrypted and never sent to the browser (`has_key` only).
- Test requests go to the URL the user entered (local servers like Ollama
  are allowed on purpose); the API token protects the endpoint.

## Tests

`tests/test_providers.py` (fake OpenAI-compatible server),
`tests/test_llm_settings.py`.
