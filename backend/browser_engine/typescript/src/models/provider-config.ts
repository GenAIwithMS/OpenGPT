import { readFileSync } from "node:fs";
import type { Model, ModelProvider } from "@openai/agents";
import { OpenAIProvider } from "@openai/agents";
import { Schema } from "effect";
import { ChatCompletionsCompatModel } from "./compat-model.js";
import { configureContextWindow } from "./context-window.js";
import { lunaModel, solModel } from "./models.js";

/**
 * The model provider OpenGPT's backend hands the engine: which API it speaks, where, with which
 * key, and which models build and review. The backend writes it as JSON to a pipe whose file
 * descriptor is in `BROWSER_ENGINE_CONFIG_FD`, so the key is never on a command line, in the
 * environment or in a file.
 *
 * - `responses`: OpenAI's Responses API (OpenAI itself), with every feature the engine uses.
 * - `chat`: any OpenAI-compatible Chat Completions endpoint.
 * - `anthropic`: any Anthropic-compatible Messages endpoint.
 */
export const ModelConfig = Schema.Struct({
  api: Schema.Literal("responses", "chat", "anthropic"),
  baseUrl: Schema.optional(Schema.String),
  apiKey: Schema.optional(Schema.String),
  /** The model that builds integrations; the default OpenAI model when absent. */
  buildModel: Schema.optional(Schema.String),
  /** The model that reviews every step and the final code; the build model when absent. */
  reviewModel: Schema.optional(Schema.String),
  /** The models' context window, in tokens; compaction thresholds scale to it. */
  contextTokens: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(16_000))),
  /** Send a reasoning effort on chat APIs (only for models that accept it). */
  reasoningEffort: Schema.optional(Schema.Boolean),
});
export type ModelConfig = Schema.Schema.Type<typeof ModelConfig>;

/** Context window assumed for chat and Anthropic models when none is given. */
export const defaultChatContextTokens = 128_000;

export const parseModelConfig = (value: unknown): ModelConfig => Schema.decodeUnknownSync(ModelConfig)(value);

/** The configuration from the backend's pipe, or undefined when none was given. */
export const readModelConfig = (env: NodeJS.ProcessEnv = process.env): ModelConfig | undefined => {
  const fd = env["BROWSER_ENGINE_CONFIG_FD"];
  if (fd === undefined || fd === "") return undefined;
  const number = Number(fd);
  if (!Number.isInteger(number) || number < 3) throw new Error("BROWSER_ENGINE_CONFIG_FD must be a file descriptor of 3 or more.");
  return parseModelConfig(JSON.parse(readFileSync(number, "utf8")));
};

/**
 * One provider for the minter, Guardian and the outcome reviewer. The engine names its two
 * models by their OpenAI IDs (`solModel` builds, `lunaModel` reviews); this provider maps them
 * to the configured models.
 */
export const modelName = (config: ModelConfig, name?: string): string => {
  const build = config.buildModel ?? solModel;
  if (name === lunaModel) return config.reviewModel ?? config.buildModel ?? lunaModel;
  return name === solModel || !name ? build : name;
};

export const makeModelProvider = (config: ModelConfig): ModelProvider => {
  const named = (name?: string) => modelName(config, name);
  if (config.api === "responses") {
    const openai = new OpenAIProvider({
      useResponses: true,
      ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
      ...(config.baseUrl === undefined ? {} : { baseURL: config.baseUrl }),
    });
    return { getModel: (name) => openai.getModel(named(name)) };
  }
  const options = config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort };
  if (config.api === "chat") {
    const openai = new OpenAIProvider({
      useResponses: false,
      apiKey: config.apiKey ?? "not-needed",
      ...(config.baseUrl === undefined ? {} : { baseURL: config.baseUrl }),
    });
    return {
      getModel: async (name) => new ChatCompletionsCompatModel(await openai.getModel(named(name)), options),
    };
  }
  return {
    getModel: async (name) => new ChatCompletionsCompatModel(await anthropicModel(config, named(name)), options),
  };
};

const anthropicModel = async (config: ModelConfig, model: string): Promise<Model> => {
  const [{ createAnthropic }, { aisdk }] = await Promise.all([
    import("@ai-sdk/anthropic"),
    import("@openai/agents-extensions/ai-sdk"),
  ]);
  const anthropic = createAnthropic({
    ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    ...(config.baseUrl === undefined ? {} : { baseURL: anthropicBaseUrl(config.baseUrl) }),
  });
  // AiSdkModel differs from Model only in an optional usage field's typing.
  return aisdk(anthropic(model)) as unknown as Model;
};

/** The AI SDK wants the URL that ends in /v1; OpenGPT stores it as the server's root. */
const anthropicBaseUrl = (url: string) => {
  const trimmed = url.replace(/\/+$/u, "");
  return /\/v\d+$/u.test(trimmed) ? trimmed : `${trimmed}/v1`;
};

/**
 * The engine options for a configuration: the same provider for every model role, and the
 * compaction thresholds scaled to the models' context window.
 */
export const modelOptions = (config: ModelConfig | undefined) => {
  if (config === undefined) return {};
  configureContextWindow(config.contextTokens ?? (config.api === "responses" ? undefined : defaultChatContextTokens));
  const provider = makeModelProvider(config);
  return { minterProvider: provider, guardianProvider: provider, outcomeReviewerProvider: provider };
};
