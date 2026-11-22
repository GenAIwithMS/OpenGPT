import type { AgentInputItem, ModelRequest, ModelSettings } from "@openai/agents";

/**
 * Prompt caching on the Responses API. A request reads the longest cached prefix that ends at a
 * cache breakpoint. In implicit mode the provider sets one breakpoint at the end of the latest
 * eligible message, and an explicit breakpoint on a content part adds another, with its own
 * lifetime. Tools render before the input, so a prefix holds only while the tool list and the
 * content before the breakpoint stay the same in every byte.
 */
export type PromptCacheTtl = "30m" | "12h";

export interface PromptCacheOptions {
  readonly mode?: "implicit" | "explicit";
  /** The lifetime of the implicit breakpoint and of explicit breakpoints without their own. */
  readonly ttl?: PromptCacheTtl;
  /**
   * Writes the request's prefix to the cache without generating output, billed at the cache-write
   * rate. The real request that follows sends the same prefix without it.
   */
  readonly prewarm?: boolean;
  /**
   * `prompt_cache_key`: requests with different keys keep separate cache accounting, such as one
   * key per environment. A prewarm and the requests it prepares must send the same key.
   */
  readonly key?: string;
}

/**
 * Sets the request's `prompt_cache_options` and `prompt_cache_key`. Provider data is spread last
 * into the request, so this carries a lifetime and a prewarm the SDK's typed
 * `promptCacheOptions` does not accept yet.
 */
export const withPromptCache = (
  settings: ModelSettings,
  { key, ...options }: PromptCacheOptions,
): ModelSettings => ({
  ...settings,
  providerData: {
    ...settings.providerData,
    prompt_cache_options: options,
    ...(key === undefined ? {} : { prompt_cache_key: key }),
  },
});

/**
 * A developer message whose text parts end at an explicit cache breakpoint with `ttl`. The SDK
 * has no developer role, so the item goes as raw provider data, which the Responses converter
 * passes through with its content parts unchanged.
 */
export const cachedDeveloperItem = (
  texts: readonly [string, ...string[]],
  ttl: PromptCacheTtl,
): AgentInputItem => {
  const last = texts.length - 1;
  return {
    type: "unknown",
    providerData: {
      type: "message",
      role: "developer",
      content: texts.map((text, index) => ({
        type: "input_text",
        text,
        ...(index === last ? { prompt_cache_breakpoint: { mode: "explicit", ttl } } : {}),
      })),
    },
  };
};

/**
 * The request with its instructions, and the host's static content after them, moved into a
 * first developer message that ends at a cache breakpoint with `ttl`. Top-level instructions
 * cannot carry a breakpoint. Everything before the breakpoint must be the same for every
 * request that should share it: the tools, the instructions and `staticContent`. The item is
 * added on every request, ahead of everything the SDK sends, a compaction item included, so a
 * compaction never moves it.
 */
export const withCachedPrefix = (
  request: ModelRequest,
  staticContent: readonly string[],
  ttl: PromptCacheTtl,
): ModelRequest => {
  const texts = [request.systemInstructions ?? "", ...staticContent].filter((text) => text !== "");
  const [first, ...rest] = texts;
  if (first === undefined) return request;
  const input: AgentInputItem[] =
    typeof request.input === "string"
      ? [{ role: "user", type: "message", content: request.input }]
      : request.input;
  const { systemInstructions: _moved, ...unprefixed } = request;
  return { ...unprefixed, input: [cachedDeveloperItem([first, ...rest], ttl), ...input] };
};

/**
 * How `allowed_tools` names one tool of the request: a function by name, a native tool such as
 * `apply_patch` or `shell` by its type, and a hosted tool by the type it is sent with.
 */
const toolReference = (tool: ModelRequest["tools"][number]) => {
  if (tool.type === "function") return { type: "function", name: tool.name };
  if (tool.type !== "hosted_tool") return { type: tool.type };
  const sent: unknown = tool.providerData?.["type"];
  return { type: typeof sent === "string" ? sent : tool.name };
};

/**
 * The request restricted to the tools `allowed` admits, with every tool still sent. Changing
 * which tools may run then leaves the tool list, and the cached prefix it starts, unchanged:
 * `tool_choice` is not part of the prefix. A request that already forbids tools (`none`) or forces
 * one tool keeps its choice; `required` stays required among the allowed tools.
 */
export const withAllowedTools = (
  request: ModelRequest,
  allowed: (name: string) => boolean,
): ModelRequest => {
  const choice = request.modelSettings.toolChoice;
  if (choice !== undefined && choice !== "auto" && choice !== "required") return request;
  const tools = request.tools.filter((tool) => allowed(tool.name));
  if (tools.length === request.tools.length) return request;
  return {
    ...request,
    modelSettings: {
      ...request.modelSettings,
      providerData: {
        ...request.modelSettings.providerData,
        tool_choice: {
          type: "allowed_tools",
          mode: choice === "required" ? "required" : "auto",
          tools: tools.map(toolReference),
        },
      },
    },
  };
};

/**
 * The request with `prompt_cache_options.comparison_response_id`: the provider then reports in
 * the response's `prompt_cache_diagnostics` whether it reused the prefix the earlier response
 * cached, and why not. It only asks for diagnostics: it loads nothing from the earlier response
 * and changes no caching.
 */
export const withCacheComparison = (request: ModelRequest, responseId: string): ModelRequest => {
  const providerData = request.modelSettings.providerData;
  const options: unknown = providerData?.["prompt_cache_options"];
  return {
    ...request,
    modelSettings: {
      ...request.modelSettings,
      providerData: {
        ...providerData,
        prompt_cache_options: {
          ...(typeof options === "object" && options !== null ? options : {}),
          comparison_response_id: responseId,
        },
      },
    },
  };
};

const cacheDiagnosticTypes = [
  "cache_hit",
  "cache_miss",
  "comparison_response_not_found",
  "unavailable",
] as const;
const cacheMissReasons = [
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

/** The provider's verdict on reusing the compared response's prefix, as finite fields. */
export interface PromptCacheDiagnostics {
  readonly type: (typeof cacheDiagnosticTypes)[number];
  readonly reason?: (typeof cacheMissReasons)[number];
  /** Of the compared response's reusable prefix, the tokens estimated not reused. */
  readonly cacheMissedTokens?: number;
  /** The compared response's reusable prefix, in tokens. */
  readonly comparisonReusableTokens?: number;
}

const tokenCount = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * A response's `prompt_cache_diagnostics`, from the response the SDK keeps as provider data, with
 * only its known enums and counts; none when the response has none.
 */
export const promptCacheDiagnostics = (providerData: unknown): PromptCacheDiagnostics | undefined => {
  if (typeof providerData !== "object" || providerData === null) return undefined;
  const diagnostics: unknown = Reflect.get(providerData, "prompt_cache_diagnostics");
  if (typeof diagnostics !== "object" || diagnostics === null) return undefined;
  const type = cacheDiagnosticTypes.find((known) => known === Reflect.get(diagnostics, "type"));
  if (type === undefined) return undefined;
  const reason = cacheMissReasons.find((known) => known === Reflect.get(diagnostics, "reason"));
  const missed = tokenCount(Reflect.get(diagnostics, "cache_missed_tokens"));
  const reusable = tokenCount(Reflect.get(diagnostics, "comparison_reusable_tokens"));
  return {
    type,
    ...(reason === undefined ? {} : { reason }),
    ...(missed === undefined ? {} : { cacheMissedTokens: missed }),
    ...(reusable === undefined ? {} : { comparisonReusableTokens: reusable }),
  };
};
