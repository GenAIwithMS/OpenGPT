import type {
  AgentInputItem,
  Model,
  ModelRequest,
  ModelResponse,
  ModelSettings,
  StreamEvent,
} from "@openai/agents";

/**
 * A model on an API other than OpenAI's Responses API: an OpenAI-compatible Chat Completions
 * endpoint or an Anthropic-compatible one. The engine's requests use Responses-only features,
 * which this class turns into what any tool-calling chat API accepts:
 *
 * - `store`, reasoning summaries and context, `include`, prompt cache options and keys, and the
 *   provider's automatic compaction (`context_management`) are left out.
 * - `tool_choice: allowed_tools` becomes the request's tool list cut to the allowed tools.
 * - A cached developer message (raw provider data) becomes a system message with its text.
 * - A reasoning-effort update item is left out; reasoning items of earlier turns too.
 * - Compaction: a request that ends in the compaction trigger is answered by asking the model to
 *   summarise the conversation; the summary comes back as a compaction item, and on later
 *   requests a compaction item becomes a user message holding that summary.
 * - Function tools are sent without `strict`, which many compatible servers reject.
 *
 * The class name contains "ChatCompletions" on purpose: the SDK reads it to send function tools
 * instead of hosted shell and apply_patch tools, and no server-side compaction.
 */
export class ChatCompletionsCompatModel implements Model {
  constructor(
    private readonly inner: Model,
    private readonly options: { readonly reasoningEffort?: boolean } = {},
  ) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    try {
      if (endsWithCompactionTrigger(request)) return await this.compact(request);
      return await this.inner.getResponse(toChatRequest(request, this.options));
    } catch (error) {
      logModelError(error);
      throw error;
    }
  }

  getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    return this.inner.getStreamedResponse(toChatRequest(request, this.options));
  }

  private async compact(request: ModelRequest): Promise<ModelResponse> {
    const input = Array.isArray(request.input) ? request.input.slice(0, -1) : [];
    const asked: ModelRequest = {
      ...toChatRequest({ ...request, input }, this.options),
      tools: [],
      handoffs: [],
      input: [
        ...toChatItems(input),
        { role: "user", content: summaryRequest, type: "message" } as AgentInputItem,
      ],
    };
    const response = await this.inner.getResponse(asked);
    const summary = responseText(response).trim();
    return {
      ...response,
      output: summary
        ? [{ type: "compaction", id: `summary_${Date.now()}`, encrypted_content: summaryPrefix + summary }]
        : [],
    };
  }
}

/**
 * With BROWSER_ENGINE_LOG_MODEL_ERRORS=1, a failed model call writes its status and message to
 * stderr (never the request), so the backend's log shows why a provider refused it.
 */
const logModelError = (error: unknown) => {
  if (process.env["BROWSER_ENGINE_LOG_MODEL_ERRORS"] !== "1") return;
  const status: unknown = typeof error === "object" && error !== null ? Reflect.get(error, "status") : undefined;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Model call failed${status === undefined ? "" : ` (${String(status)})`}: ${message.slice(0, 500)}\n`);
};

/** Marks a summary this class wrote inside a compaction item. */
export const summaryPrefix = "opengpt-summary:";

const summaryRequest =
  "Summarise the conversation so far for yourself, so you can continue the task without it. " +
  "Keep every fact you still need: the task and its constraints, what you found on the site " +
  "(URLs, selectors, field names, values), the files you wrote and what each does, what was " +
  "tested and its results, the user's answers, and what is left to do. Plain text, no preamble.";

const endsWithCompactionTrigger = (request: ModelRequest) => {
  if (!Array.isArray(request.input) || request.input.length === 0) return false;
  const last = request.input[request.input.length - 1];
  return rawType(last) === "compaction_trigger";
};

/** The `type` of an item's raw provider data, for items the SDK passes as "unknown". */
const rawType = (item: AgentInputItem | undefined): unknown =>
  item !== undefined && item.type === "unknown" && item.providerData !== undefined
    ? Reflect.get(item.providerData, "type")
    : undefined;

const responsesOnlySettings = [
  "include",
  "prompt_cache_options",
  "prompt_cache_key",
  "context_management",
  "tool_choice",
  "reasoning",
  "store",
  "truncation",
] as const;

/** The request with only what a tool-calling chat API accepts. Exported for tests. */
export const toChatRequest = (
  request: ModelRequest,
  options: { readonly reasoningEffort?: boolean } = {},
): ModelRequest => {
  const settings = request.modelSettings;
  const providerData = { ...(settings.providerData ?? {}) };
  const allowed = allowedToolNames(providerData["tool_choice"]);
  for (const key of responsesOnlySettings) delete providerData[key];
  const effort = settings.reasoning?.effort;
  const { store: _store, reasoning: _reasoning, parallelToolCalls: _parallel, promptCacheOptions: _cache, ...rest } =
    settings as ModelSettings & { promptCacheOptions?: unknown };
  const modelSettings: ModelSettings = {
    ...rest,
    ...(options.reasoningEffort && effort ? { reasoning: { effort } } : {}),
    providerData,
  };
  const tools = (allowed === undefined ? request.tools : request.tools.filter((t) => allowed.has(t.name))).map(
    (tool) => (tool.type === "function" ? { ...tool, strict: false } : tool),
  );
  return {
    ...request,
    modelSettings,
    tools,
    input: Array.isArray(request.input) ? toChatItems(request.input) : request.input,
  };
};

const allowedToolNames = (choice: unknown): Set<string> | undefined => {
  if (typeof choice !== "object" || choice === null) return undefined;
  if (Reflect.get(choice, "type") !== "allowed_tools") return undefined;
  const tools: unknown = Reflect.get(choice, "tools");
  if (!Array.isArray(tools)) return undefined;
  return new Set(
    tools.map((t: unknown) => (typeof t === "object" && t !== null ? Reflect.get(t, "name") : undefined))
      .filter((name): name is string => typeof name === "string"),
  );
};

/** Input items a chat API accepts, in the same order. */
export const toChatItems = (items: readonly AgentInputItem[]): AgentInputItem[] =>
  items.flatMap((item): AgentInputItem[] => {
    const raw = rawType(item);
    if (raw === "message" && item.type === "unknown") {
      const data = item.providerData ?? {};
      const content: unknown = Reflect.get(data, "content");
      const text = Array.isArray(content)
        ? content.map((part: unknown) => (typeof part === "object" && part !== null ? Reflect.get(part, "text") : ""))
          .filter((t): t is string => typeof t === "string").join("\n\n")
        : typeof content === "string" ? content : "";
      const role = Reflect.get(data, "role") === "user" ? "user" : "system";
      return text ? [{ type: "message", role, content: text } as AgentInputItem] : [];
    }
    if (raw === "configuration_update" || raw === "compaction_trigger") return [];
    if (item.type === "reasoning") return [];
    if (item.type === "compaction") {
      const text = item.encrypted_content.startsWith(summaryPrefix)
        ? item.encrypted_content.slice(summaryPrefix.length)
        : "(An earlier part of this conversation was compacted and is not available.)";
      return [{
        type: "message",
        role: "user",
        content: `Host note: earlier turns were summarised to save context. Summary:\n\n${text}`,
      } as AgentInputItem];
    }
    return [item];
  });

const responseText = (response: ModelResponse): string =>
  response.output
    .map((item): string => {
      if (item.type !== "message") return "";
      const content: unknown = Reflect.get(item, "content");
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content
        .map((part: unknown) =>
          typeof part === "object" && part !== null && Reflect.get(part, "type") === "output_text"
            ? String(Reflect.get(part, "text") ?? "")
            : "")
        .join("");
    })
    .join("");
