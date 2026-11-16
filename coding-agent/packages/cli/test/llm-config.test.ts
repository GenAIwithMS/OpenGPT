import { describe, expect, test } from "bun:test"
import { configFromLlmEnv } from "../src/llm-config"

const parse = (env: Record<string, string>) => {
  const json = configFromLlmEnv(env)
  return json === undefined ? undefined : JSON.parse(json)
}

describe("configFromLlmEnv", () => {
  test("makes the LLM_* model the default", () => {
    const config = parse({ LLM_API_KEY: "k", LLM_BASE_URL: "http://host/v1", LLM_MODEL: "m" })
    expect(config.model).toBe("opengpt/m")
    expect(config.providers.opengpt).toEqual({
      name: "OpenGPT",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: "http://host/v1", apiKey: "k" },
      models: { m: { name: "m" } },
    })
  })

  test("CODING_AGENT_MODEL overrides the model", () => {
    const config = parse({ LLM_API_KEY: "k", LLM_MODEL: "chat", CODING_AGENT_MODEL: "coder" })
    expect(config.model).toBe("opengpt/coder")
    expect(Object.keys(config.providers.opengpt.models)).toEqual(["coder"])
  })

  test("anthropic uses its own API by default", () => {
    const config = parse({ LLM_PROVIDER: "anthropic", LLM_API_KEY: "k", LLM_MODEL: "m" })
    expect(config.providers.opengpt.package).toBe("@opencode/ai/providers/anthropic-compatible")
    expect(config.providers.opengpt.settings.baseURL).toBe("https://api.anthropic.com/v1")
  })

  test("no model or an unknown provider gives no config", () => {
    expect(parse({ LLM_API_KEY: "k" })).toBeUndefined()
    expect(parse({ LLM_MODEL: "your_model_here" })).toBeUndefined()
    expect(parse({ LLM_PROVIDER: "other", LLM_MODEL: "m" })).toBeUndefined()
  })

  test("placeholder keys are not sent", () => {
    const config = parse({ LLM_API_KEY: "your_api_key_here", LLM_BASE_URL: "http://localhost:11434/v1", LLM_MODEL: "m" })
    expect(config.providers.opengpt.settings).toEqual({ baseURL: "http://localhost:11434/v1" })
  })
})
