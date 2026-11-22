import type {
  AgentInputItem,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  Usage,
} from "@openai/agents";

/**
 * How long the provider keeps a prompt cache write: 30 minutes, its default, or 12 hours, which
 * costs more to write and suits a prefix many conversations share.
 */
export type PromptCacheTtl = "30m" | "12h";

/** One developer message of a request's instructions, with a cache breakpoint at its end. */
export interface InstructionsMessage {
  readonly text: string;
  /** Caches the request through the end of this message for `ttl`, whatever the request's mode. */
  readonly breakpoint?: PromptCacheTtl;
}

/**
 * A developer message as the Responses API takes it. The SDK has no developer role, so the item
 * travels as an unknown item, which its converter sends unchanged.
 */
export const developerMessage = ({ text, breakpoint }: InstructionsMessage): AgentInputItem => ({
  type: "unknown",
  providerData: {
    type: "message",
    role: "developer",
    content: [
      {
        type: "input_text",
        text,
        ...(breakpoint === undefined
          ? {}
          : { prompt_cache_breakpoint: { mode: "explicit", ttl: breakpoint } }),
      },
    ],
  },
});

/**
 * A model provider that sends an agent's instructions as developer messages at the start of each
 * request's input instead of as top-level `instructions`, which cannot hold a cache breakpoint.
 * `messages` are the instructions the agent was built with, split where the cache should break:
 * observers above this provider still see them as the request's instructions, and a request one
 * of them sends again, such as a compaction request, gets the same messages. Put it directly
 * above the provider that calls the model.
 */
export const instructionsAsMessages = (
  provider: ModelProvider,
  messages: readonly InstructionsMessage[],
): ModelProvider => {
  const items = messages.map(developerMessage);
  const sent = (request: ModelRequest): ModelRequest => {
    const { systemInstructions: _instructions, ...rest } = request;
    return {
      ...rest,
      input: [
        ...items,
        ...(typeof request.input === "string"
          ? [{ role: "user" as const, type: "message" as const, content: request.input }]
          : request.input),
      ],
    };
  };
  return {
    getModel: async (name?: string) => {
      const model = await provider.getModel(name);
      return {
        ...model,
        getResponse: (request: ModelRequest) => model.getResponse(sent(request)),
        getStreamedResponse: (request: ModelRequest) => model.getStreamedResponse(sent(request)),
      };
    },
  };
};

/** The instructions an agent is built with, from the same messages `instructionsAsMessages` sends. */
export const instructionsText = (messages: readonly InstructionsMessage[]) =>
  messages.map((message) => message.text).join("\n\n");

/**
 * The item that changes the reasoning effort of every later response in a conversation, until
 * another one does, while the request's own `reasoning.effort` and so its cached prefix stay as
 * they were. It goes before the user message it applies to; two never stand next to each other,
 * and provider-side automatic compaction does not accept a conversation that holds one.
 */
export const configurationUpdate = (effort: string): AgentInputItem => ({
  type: "unknown",
  providerData: { type: "configuration_update", reasoning: { effort } },
});

/** The effort a configuration update selects, or undefined for any other item. */
export const configurationUpdateEffort = (item: AgentInputItem): string | undefined => {
  if (item.type !== "unknown") return undefined;
  const data: unknown = item.providerData;
  if (typeof data !== "object" || data === null) return undefined;
  if (Reflect.get(data, "type") !== "configuration_update") return undefined;
  const reasoning: unknown = Reflect.get(data, "reasoning");
  const effort: unknown =
    typeof reasoning === "object" && reasoning !== null
      ? Reflect.get(reasoning, "effort")
      : undefined;
  return typeof effort === "string" ? effort : undefined;
};

/** The effort the latest configuration update in `items` selects, if any holds one. */
export const latestConfigurationEffort = (items: readonly AgentInputItem[]) => {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    const effort = item === undefined ? undefined : configurationUpdateEffort(item);
    if (effort !== undefined) return effort;
  }
  return undefined;
};

/** Ends the run that sent a prewarm request, once the provider answered it. */
class PrewarmSent extends Error {
  override readonly name = "PrewarmSent";
}

/**
 * Prewarms the cache of an agent's leading instructions: `run` runs the agent once through the
 * provider it is given, as a real request would, and that provider sends only the first `keep`
 * input items, the instructions to cache, as a request that prepares their cache and generates
 * nothing. The request is otherwise the run's own, byte for byte: model, tools, output format and
 * settings. Resolves with the prewarm's token counts.
 */
export const prewarmInstructions = async (
  provider: ModelProvider,
  keep: number,
  run: (provider: ModelProvider) => Promise<unknown>,
): Promise<Usage> => {
  let usage: Usage | undefined;
  const prewarming: ModelProvider = {
    getModel: async (name?: string) => {
      const model = await provider.getModel(name);
      const send = async (request: ModelRequest): Promise<never> => {
        const input = typeof request.input === "string" ? [] : request.input.slice(0, keep);
        const settings = request.modelSettings;
        const response = await model.getResponse({
          ...request,
          input,
          modelSettings: {
            ...settings,
            providerData: {
              ...settings.providerData,
              // Only the instructions' own breakpoint is written, and no output generated.
              prompt_cache_options: {
                ...settings.promptCacheOptions,
                mode: "explicit",
                prewarm: true,
              },
            },
          },
        });
        usage = response.usage;
        throw new PrewarmSent();
      };
      return {
        ...model,
        getResponse: send,
        getStreamedResponse: () => {
          throw new Error("A prewarm sends no streamed request");
        },
      };
    },
  };
  try {
    await run(prewarming);
  } catch (error) {
    if (usage === undefined) throw error;
  }
  if (usage === undefined) throw new Error("The prewarm run sent no request");
  return usage;
};

/**
 * The request comparing its prompt cache with the earlier response `responseId`, such as the
 * previous turn's: the provider then reports in the response's `prompt_cache_diagnostics` whether
 * the request reused that response's prefix, and why not. It never blocks or fails the request.
 */
export const withCacheComparison = (
  request: ModelRequest,
  responseId: string | undefined,
): ModelRequest => {
  if (responseId === undefined) return request;
  const settings = request.modelSettings;
  const options: unknown = settings.providerData?.["prompt_cache_options"];
  return {
    ...request,
    modelSettings: {
      ...settings,
      providerData: {
        ...settings.providerData,
        prompt_cache_options: {
          ...settings.promptCacheOptions,
          ...(typeof options === "object" && options !== null ? options : {}),
          comparison_response_id: responseId,
        },
      },
    },
  };
};

const diagnosticTypes = [
  "cache_hit",
  "cache_miss",
  "comparison_response_not_found",
  "unavailable",
] as const;
const diagnosticReasons = [
  "model_changed",
  "prompt_cache_key_changed",
  "service_tier_changed",
  "tools_changed",
  "text_format_changed",
  "reasoning_effort_changed",
  "verbosity_changed",
  "context_compacted",
  "input_changed",
] as const;

/** One model call's prompt cache comparison, as finite diagnostics: enums and counts only. */
export interface PromptCacheDiagnostic {
  readonly type: (typeof diagnosticTypes)[number];
  /** Why a miss missed, the first reason the provider classified; absent when not one it names. */
  readonly reason?: (typeof diagnosticReasons)[number];
  /** The provider's estimate of how many of the comparison's reusable tokens were not reused. */
  readonly cacheMissedTokens?: number;
  /** The token count of the comparison response's reusable prefix. */
  readonly comparisonReusableTokens?: number;
}

const tokenCount = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** The response's prompt cache comparison, when it reports one in a form this release reads. */
export const promptCacheDiagnosticOf = (
  response: ModelResponse,
): PromptCacheDiagnostic | undefined => {
  const data: unknown = response.providerData;
  const raw: unknown =
    typeof data === "object" && data !== null
      ? Reflect.get(data, "prompt_cache_diagnostics")
      : undefined;
  if (typeof raw !== "object" || raw === null) return undefined;
  const type = diagnosticTypes.find((known) => known === Reflect.get(raw, "type"));
  if (type === undefined) return undefined;
  const reason = diagnosticReasons.find((known) => known === Reflect.get(raw, "reason"));
  const missed = tokenCount(Reflect.get(raw, "cache_missed_tokens"));
  const reusable = tokenCount(Reflect.get(raw, "comparison_reusable_tokens"));
  return {
    type,
    ...(reason === undefined ? {} : { reason }),
    ...(missed === undefined ? {} : { cacheMissedTokens: missed }),
    ...(reusable === undefined ? {} : { comparisonReusableTokens: reusable }),
  };
};

/**
 * A model provider that keeps each response's prompt cache comparison, in call order, for the
 * caller to report with the call's usage.
 */
export const collectingCacheDiagnostics = (provider: ModelProvider) => {
  const diagnostics: PromptCacheDiagnostic[] = [];
  return {
    diagnostics,
    provider: {
      getModel: async (name?: string) => {
        const model = await provider.getModel(name);
        return {
          ...model,
          getResponse: async (request: ModelRequest) => {
            const response = await model.getResponse(request);
            const diagnostic = promptCacheDiagnosticOf(response);
            if (diagnostic !== undefined) diagnostics.push(diagnostic);
            return response;
          },
          getStreamedResponse: (request: ModelRequest) => model.getStreamedResponse(request),
        };
      },
    } satisfies ModelProvider,
  };
};
