import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentInputItem, Model, ModelRequest, ModelResponse } from "@openai/agents";
import { Usage } from "@openai/agents";
import { afterEach, describe, expect, it } from "vitest";
import { ChatCompletionsCompatModel, summaryPrefix, toChatItems, toChatRequest } from "../../src/models/compat-model.js";
import { configureContextWindow, scaledTokens } from "../../src/models/context-window.js";
import { lunaModel, solModel } from "../../src/models/models.js";
import { makeModelProvider, modelName, modelOptions, parseModelConfig, readModelConfig } from "../../src/models/provider-config.js";
import { wrapModel } from "../../src/models/wrap-model.js";

const tool = (name: string) => ({
  type: "function" as const,
  name,
  description: name,
  parameters: { type: "object" as const, properties: {}, required: [], additionalProperties: false },
  strict: true,
});

const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  input: [{ role: "user", content: "hi", type: "message" } as AgentInputItem],
  modelSettings: {},
  tools: [],
  outputType: "text",
  handoffs: [],
  tracing: false,
  ...overrides,
});

class Recorder implements Model {
  seen: ModelRequest[] = [];
  constructor(private readonly text = "ok") {}
  async getResponse(sent: ModelRequest): Promise<ModelResponse> {
    this.seen.push(sent);
    return {
      usage: new Usage(),
      output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: this.text }] }],
    } as ModelResponse;
  }
  getStreamedResponse(): AsyncIterable<never> {
    throw new Error("not used");
  }
}

describe("a request for a chat API", () => {
  it("leaves out Responses-only settings and cuts the tools to the allowed ones", () => {
    const sent = toChatRequest(
      request({
        tools: [tool("read_source"), tool("execute"), tool("finish_build")],
        modelSettings: {
          store: false,
          parallelToolCalls: true,
          reasoning: { effort: "medium", summary: "auto" },
          providerData: {
            include: ["reasoning.encrypted_content"],
            prompt_cache_options: { mode: "implicit", comparison_response_id: "resp_1" },
            prompt_cache_key: "k",
            context_management: [{ type: "compaction" }],
            tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "execute" }] },
            temperature_hint: 1,
          },
        },
      }),
    );
    expect(sent.tools.map((t) => t.name)).toEqual(["execute"]);
    expect(sent.tools.every((t) => t.type !== "function" || t.strict === false)).toBe(true);
    expect(sent.modelSettings).toEqual({ providerData: { temperature_hint: 1 } });
  });

  it("keeps the reasoning effort only when the model accepts it", () => {
    const settings = { reasoning: { effort: "low" as const } };
    expect(toChatRequest(request({ modelSettings: settings })).modelSettings.reasoning).toBeUndefined();
    expect(toChatRequest(request({ modelSettings: settings }), { reasoningEffort: true }).modelSettings.reasoning)
      .toEqual({ effort: "low" });
  });

  it("turns raw and compacted items into plain messages", () => {
    const items = toChatItems([
      { type: "unknown", providerData: { type: "message", role: "developer",
        content: [{ type: "input_text", text: "Rules" }, { type: "input_text", text: "Context", prompt_cache_breakpoint: {} }] } },
      { type: "unknown", providerData: { type: "configuration_update", reasoning: { effort: "low" } } },
      { type: "reasoning", content: [], providerData: {} } as unknown as AgentInputItem,
      { type: "compaction", encrypted_content: `${summaryPrefix}Found the form at /book.` },
      { type: "compaction", encrypted_content: "opaque-provider-bytes" },
      { role: "user", content: "next", type: "message" } as AgentInputItem,
    ]);
    expect(items).toEqual([
      { type: "message", role: "system", content: "Rules\n\nContext" },
      { type: "message", role: "user", content: expect.stringContaining("Found the form at /book.") },
      { type: "message", role: "user", content: expect.stringContaining("not available") },
      { role: "user", content: "next", type: "message" },
    ]);
  });
});

describe("compaction on a chat API", () => {
  it("answers the compaction trigger with a summary the next request carries", async () => {
    const inner = new Recorder("The task: book a table. Done: found the form.");
    const model = new ChatCompletionsCompatModel(inner);
    const trigger = { type: "unknown", providerData: { type: "compaction_trigger" } } as AgentInputItem;
    const response = await model.getResponse(request({
      tools: [tool("execute")],
      input: [{ role: "user", content: "Book a table", type: "message" } as AgentInputItem, trigger],
    }));
    expect(inner.seen[0]?.tools).toEqual([]);
    const asked = inner.seen[0]?.input as AgentInputItem[];
    expect(JSON.stringify(asked.at(-1))).toContain("Summarise the conversation");
    expect(JSON.stringify(asked)).not.toContain("compaction_trigger");
    expect(response.output).toEqual([
      { type: "compaction", id: expect.any(String), encrypted_content: `${summaryPrefix}The task: book a table. Done: found the form.` },
    ]);

    await model.getResponse(request({ input: [...(response.output as AgentInputItem[]), { role: "user", content: "go on", type: "message" } as AgentInputItem] }));
    expect(JSON.stringify(inner.seen[1]?.input)).toContain("found the form");
  });
});

describe("the configured provider", () => {
  afterEach(() => configureContextWindow(undefined));

  it("maps the engine's two models to the configured ones", () => {
    const both = parseModelConfig({ api: "chat", buildModel: "builder", reviewModel: "reviewer" });
    expect([modelName(both, solModel), modelName(both, lunaModel), modelName(both)]).toEqual(["builder", "reviewer", "builder"]);
    const buildOnly = parseModelConfig({ api: "chat", buildModel: "builder" });
    expect(modelName(buildOnly, lunaModel)).toBe("builder");
    const none = parseModelConfig({ api: "responses" });
    expect([modelName(none, solModel), modelName(none, lunaModel)]).toEqual([solModel, lunaModel]);
  });

  it("gives a chat model whose class the SDK reads as Chat Completions, also behind a wrapper", async () => {
    const chat = makeModelProvider(parseModelConfig({ api: "chat", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k" }));
    const model = await chat.getModel(solModel);
    expect(model).toBeInstanceOf(ChatCompletionsCompatModel);
    expect(Reflect.get(model, "inner").constructor.name).toContain("ChatCompletions");
    expect(wrapModel(model, {}).constructor.name).toContain("ChatCompletions");
    const responses = makeModelProvider(parseModelConfig({ api: "responses", apiKey: "k" }));
    expect((await responses.getModel(lunaModel)).constructor.name).toContain("Responses");
  });

  it("refuses an unknown API and a tiny context window", () => {
    expect(() => parseModelConfig({ api: "gemini" })).toThrow();
    expect(() => parseModelConfig({ api: "chat", contextTokens: 1000 })).toThrow();
  });

  it("reads the configuration from the backend's pipe", () => {
    const folder = mkdtempSync(join(tmpdir(), "engine-config-"));
    try {
      const file = join(folder, "config.json");
      writeFileSync(file, JSON.stringify({ api: "chat", apiKey: "secret", buildModel: "m" }));
      const fd = openSync(file, "r");
      try {
        expect(readModelConfig({ BROWSER_ENGINE_CONFIG_FD: String(fd) })).toEqual({ api: "chat", apiKey: "secret", buildModel: "m" });
      } finally {
        closeSync(fd);
      }
      expect(readModelConfig({})).toBeUndefined();
      expect(() => readModelConfig({ BROWSER_ENGINE_CONFIG_FD: "1" })).toThrow("file descriptor");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("scales compaction thresholds to a smaller context window", () => {
    expect(scaledTokens(250_000)).toBe(250_000);
    const options = modelOptions(parseModelConfig({ api: "chat", apiKey: "k" }));
    expect(Object.keys(options).sort()).toEqual(["guardianProvider", "minterProvider", "outcomeReviewerProvider"]);
    expect(scaledTokens(250_000)).toBe(Math.floor((250_000 / 272_000) * (128_000 - 16_000)));
    expect(modelOptions(undefined)).toEqual({});
  });
});
