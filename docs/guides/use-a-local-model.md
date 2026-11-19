# Use a local model

OpenGPT can use a model that runs on your own computer, with no API key and
no data leaving the machine. It works with any local server that speaks the
OpenAI API: Ollama, LM Studio, llama.cpp (`llama-server`) and Jan have
presets, and anything else can be added as Custom.

## The quick way

1. Download a model and start the server, for example `ollama pull <model>`
   then `ollama serve`, or load a model in LM Studio and start its server.
2. In OpenGPT open **Settings > Developer > Find local models**.
3. Pick a model under the running server and press **Use this model**. Chat
   uses it at once and the coding agent restarts with it.

**Find local models** checks the usual port of each server and the app's own
model folder, and says what to do next:

| What it finds | What it says |
|---|---|
| Server running with models | The models, ready to use |
| Models downloaded, server not running | Which models you have, and how to start the server |
| Server running, no models | How to download one |
| App installed, nothing downloaded | How to download a model and start it |

The folder check only reads model names and sizes in each app's own folder
(no disk-wide search) and is skipped when the backend is open to the network
(`HOST` isn't local).

| Server | Port | Model folder checked |
|---|---|---|
| Ollama | 11434 (or `OLLAMA_HOST`) | `OLLAMA_MODELS`, `~/.ollama/models`, `/usr/share/ollama/.ollama/models` |
| LM Studio | 1234 | `~/.lmstudio/models`, `~/.cache/lm-studio/models` |
| llama.cpp | 8080 | `LLAMA_CACHE`, `~/.cache/llama.cpp` |
| Jan | 1337 | Jan's data folder (`.../Jan/data/llamacpp/models`) |

A server on another port or another computer: **Add provider > Custom** with
its address (usually ending in `/v1`).

## With backend/.env

```env
LLM_PROVIDER=openai
LLM_BASE_URL=http://localhost:11434/v1   # your server's address
LLM_API_KEY=                             # not needed for most local servers
LLM_MODEL=<model name>
```

## Things to know

- **Tool calling.** Chat tools, deep research and the blog writer need a
  model that supports tool calling. If a model doesn't, chat says so. For
  llama.cpp, start `llama-server` with `--jinja` to turn tool calling on.
- **Context length.** Ollama keeps a short context window by default, so long
  chats and documents get cut off. Set `OLLAMA_CONTEXT_LENGTH` (for example
  `16384`) and restart Ollama. In LM Studio and llama.cpp, set the context
  length when you load the model (`-c` for `llama-server`).
- **The coding agent** sends long requests. Small local models may struggle;
  choose a larger model for the *Coding agent* job in Settings > Developer.
- **Jan** asks for an API key: copy it from Jan's Local API Server settings.
- OpenGPT never starts a local server for you.

Code: `backend/app/services/local_models.py`, `GET /api/providers/local`,
`frontend/src/components/settings/LocalModels.jsx`. See
[the providers page](../services/providers.md).
