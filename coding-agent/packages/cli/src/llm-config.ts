// Builds the agent's model config from OpenGPT's LLM_* settings, so the
// default model is the one OpenGPT is configured with. The backend passes the
// same config in OPENGPT_CONFIG_CONTENT; this covers starting the agent by hand,
// e.g. `bun --env-file=../../../backend/.env run src/serve-main.ts`.
//
//   LLM_PROVIDER   openai | anthropic (default: openai)
//   LLM_API_KEY    API key for the endpoint
//   LLM_BASE_URL   endpoint URL (default: the provider's own API)
//   LLM_MODEL      model name (required)
//   CODING_AGENT_MODEL  model for the coding agent (default: LLM_MODEL)

export const PROVIDER_ID = "opengpt"

const PACKAGES = {
  openai: "@opencode/ai/providers/openai-compatible",
  anthropic: "@opencode/ai/providers/anthropic-compatible",
} as const

const DEFAULT_BASE_URLS = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
} as const

// Placeholder values left in .env (e.g. "your_api_key_here") count as not set,
// matching backend/app/llm.py.
const PLACEHOLDER = /^(your[_-].*|.*_here|[a-z_]+_api_key)$/i

function setting(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim()
  return value && !PLACEHOLDER.test(value) ? value : undefined
}

/** The config JSON for the LLM_* settings, or undefined when LLM_MODEL is not set. */
export function configFromLlmEnv(env: NodeJS.ProcessEnv): string | undefined {
  const model = setting(env, "CODING_AGENT_MODEL") ?? setting(env, "LLM_MODEL")
  if (!model) return undefined
  const provider = (setting(env, "LLM_PROVIDER") ?? "openai").toLowerCase()
  if (provider !== "openai" && provider !== "anthropic") return undefined
  const apiKey = setting(env, "LLM_API_KEY")
  return JSON.stringify({
    providers: {
      [PROVIDER_ID]: {
        name: "OpenGPT",
        package: PACKAGES[provider],
        settings: {
          baseURL: setting(env, "LLM_BASE_URL") ?? DEFAULT_BASE_URLS[provider],
          ...(apiKey ? { apiKey } : {}),
        },
        models: { [model]: { name: model } },
      },
    },
    model: `${PROVIDER_ID}/${model}`,
    share: "disabled",
    update: "disable",
  })
}
