import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentInputItem, Model, ModelRequest, ModelResponse } from "@openai/agents";
import { Usage } from "@openai/agents";
import { afterEach, describe, expect, it } from "vitest";
import { ChatCompletionsCompatModel, coerce, normalizePatch, repairJson, summaryPrefix, toChatItems, toChatRequest } from "../../src/models/compat-model.js";
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
    expect(sent.tools.every((t) => t.type !== "function" || t.strict === true)).toBe(true);   // kept
    const loose = toChatRequest(request({ tools: [tool("execute")] }), { strictTools: false });
    expect(loose.tools.every((t) => t.type !== "function" || t.strict === false)).toBe(true);
    expect(sent.modelSettings).toEqual({ providerData: { temperature_hint: 1 } });
  });

  it("keeps the reasoning effort only when the model accepts it", () => {
    const settings = { reasoning: { effort: "low" as const } };
    expect(toChatRequest(request({ modelSettings: settings })).modelSettings.reasoning).toBeUndefined();
    expect(toChatRequest(request({ modelSettings: settings }), { reasoningEffort: true }).modelSettings.reasoning)
      .toEqual({ effort: "low" });
  });

  it("keeps system messages at the start, merged, and turns a later one into a host note", () => {
    const dev = (text: string) => ({ type: "unknown", providerData: { type: "message", role: "developer",
      content: [{ type: "input_text", text }] } }) as AgentInputItem;
    const items = toChatItems([dev("A"), dev("B"), { role: "user", content: "hi", type: "message" } as AgentInputItem, dev("C")]);
    expect(items).toEqual([
      { type: "message", role: "system", content: "A\n\nB" },
      { role: "user", content: "hi", type: "message" },
      { type: "message", role: "user", content: "Host note:\nC" },
    ]);
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

describe("tool-call arguments with type slips", () => {
  it("corrects numbers and booleans sent as text, and empty text where null is allowed", () => {
    const schema = {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: ["integer", "null"] },
        limit: { type: "number" },
        tty: { type: "boolean" },
        paths: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
        note: { type: ["string", "null"] },
        nested: { type: "object", properties: { n: { type: "integer" } } },
      },
    };
    expect(coerce({ path: "a", offset: "0", limit: "400", tty: "false", paths: "", note: "", nested: { n: "3" } }, schema))
      .toEqual({ path: "a", offset: 0, limit: 400, tty: false, paths: null, note: "", nested: { n: 3 } });
    expect(coerce({ paths: "[\"x\"]", offset: "abc" }, schema)).toEqual({ paths: ["x"], offset: "abc" });
    expect(coerce({ paths: "None", offset: "null", note: "None" }, schema)).toEqual({ paths: null, offset: null, note: null });
    // Schemas that point at definitions ($ref), as the engine's tools do.
    const withRefs = {
      type: "object",
      properties: { step: { anyOf: [{ $ref: "#/$defs/Step" }, { type: "null" }] }, count: { $ref: "#/$defs/Count" } },
      $defs: { Step: { type: "object", properties: { timeout: { type: "integer" } } }, Count: { type: "integer" } },
    };
    expect(coerce({ step: "None", count: "4" }, withRefs)).toEqual({ step: null, count: 4 });
    expect(coerce({ step: { timeout: "15" }, count: 1 }, withRefs)).toEqual({ step: { timeout: 15 }, count: 1 });
  });

  it("fixes the arguments of a model's tool call before the engine reads them", async () => {
    const inner = new Recorder();
    inner.getResponse = async () => ({
      usage: new Usage(),
      output: [{ type: "function_call", callId: "c1", name: "read_source", status: "completed",
                 arguments: JSON.stringify({ offset: "0" }) }],
    }) as unknown as ModelResponse;
    const model = new ChatCompletionsCompatModel(inner);
    const readSource = { ...tool("read_source"), parameters: { type: "object" as const,
      properties: { offset: { type: "integer" } }, required: ["offset"], additionalProperties: false } };
    const response = await model.getResponse(request({ tools: [readSource] }));
    expect(Reflect.get(response.output[0] as object, "arguments")).toBe(JSON.stringify({ offset: 0 }));
  });
});

describe("tool calls with invalid JSON", () => {
  it("quotes a bare word value and never sends invalid arguments back", () => {
    expect(repairJson('{"operation": create_file, "path": "a.mjs", "ok": true}'))
      .toBe('{"operation": "create_file", "path": "a.mjs", "ok": true}');
    expect(repairJson('{"a": 1}')).toBe('{"a": 1}');
    const items = toChatItems([
      { type: "function_call", callId: "c1", name: "apply_patch", status: "completed", arguments: '{"operation": create_file}' },
      { type: "function_call", callId: "c2", name: "x", status: "completed", arguments: '{"broken": ' },
    ] as unknown as AgentInputItem[]);
    expect(items.map((i) => JSON.parse(String(Reflect.get(i, "arguments"))))).toEqual([
      { operation: "create_file" }, { invalid_arguments: '{"broken": ' },
    ]);
  });
});

describe("more argument slips", () => {
  it("reads None as null in a text-or-null field, and as the minimum for a required number", () => {
    const schema = { type: "object", properties: {
      exampleInput: { anyOf: [{ type: "string" }, { type: "null" }] },
      maxWorkers: { type: "integer", minimum: 1, maximum: 16 },
      label: { type: "string" },
    } };
    expect(coerce({ exampleInput: "None", maxWorkers: "None", label: "None" }, schema))
      .toEqual({ exampleInput: null, maxWorkers: 1, label: "None" });
    expect(coerce({ exampleInput: "" }, schema)).toEqual({ exampleInput: "" });
    const lists = { type: "object", properties: { caseFilter: { type: "array", items: { type: "string" } },
      maybe: { anyOf: [{ type: "array" }, { type: "null" }] } } };
    expect(coerce({ caseFilter: null, maybe: null }, lists)).toEqual({ caseFilter: [], maybe: null });
    const required = { ...lists, required: ["caseFilter", "maybe"] };
    expect(coerce({}, required)).toEqual({ caseFilter: [], maybe: null });
    const minimum = { type: "object", properties: { testInput: { anyOf: [{ type: "string", minLength: 2 }, { type: "null" }] } } };
    expect(coerce({ testInput: "" }, minimum)).toEqual({ testInput: null });
    const jsonText = { type: "object", properties: { exampleInput: { anyOf: [{ type: "string" }, { type: "null" }] } } };
    expect(coerce({ exampleInput: {} }, jsonText)).toEqual({ exampleInput: "{}" });
    expect(coerce({ exampleInput: { a: 1 } }, jsonText)).toEqual({ exampleInput: '{"a":1}' });
  });

  it("escapes raw line breaks inside JSON strings", () => {
    expect(JSON.parse(repairJson('{"patch": "line one\nline two", "n": 1}'.replace("\\n", "\n"))))
      .toEqual({ patch: "line one\nline two", n: 1 });
  });

  it("turns any apply_patch form into one patch text", () => {
    const patch = "*** Begin Patch\n*** Create File: /workspace/explore/a.mjs\n+x\n*** End Patch";
    const fixed = "*** Begin Patch\n*** Add File: explore/a.mjs\n+x\n*** End Patch";
    expect(normalizePatch({ command: ["apply_patch", patch] })).toEqual({ patch: fixed });
    expect(normalizePatch({ command: ["apply_patch"], operation: "create_file", path: "x", patch })).toEqual({ patch: fixed });
    expect(normalizePatch({ operations: [{ type: "create_file", path: "/workspace/b.mjs", content: "a\nb" }] }))
      .toEqual({ patch: "*** Begin Patch\n*** Add File: b.mjs\n+a\n+b\n*** End Patch" });
    const update = { operation: { type: "update_file", path: "c.mjs", diff: "@@\n-a\n+b" } };
    expect(normalizePatch(update)).toBe(update);   // a real update diff goes to the tool as it is
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
