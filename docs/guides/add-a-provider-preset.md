# Add a provider preset

Presets are the services offered in Settings > Developer > Add provider.
Users can always use Custom for anything else.

1. **Check the service** has an OpenAI-compatible (Chat Completions) or
   Anthropic-compatible (Messages) API, a model list endpoint, and models
   that support tool calling.
2. **Add an entry** to `PRESETS` in `backend/app/services/providers.py`:
   `id`, `name`, `kind` (`openai` or `anthropic`), `base_url` (for OpenAI
   compatible APIs it usually ends in `/v1`), `keys_url` (where users get a
   key), and `local: True` for servers on this computer that need no key.
3. **Add its logo** in `frontend/src/components/settings/ProviderLogo.jsx`:
   Simple Icons if available, otherwise the official icon downloaded from the
   company's site into `frontend/src/assets/providers/` with its source in
   `SOURCES.md`.
4. **Test**: `backend/tests/test_providers.py` passes; in the browser, add
   the provider with a real key, press Test, pick a model, make it active
   and send a message in a temporary chat. Remove the key afterwards.

Presets are a list for users to choose from; don't make any one of them the
default in code or docs.
