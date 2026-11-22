import type { AgentInputItem, ModelRequest, ModelResponse } from "@openai/agents";

/**
 * Input tokens at which the minter compacts its history while it waits on a tool. A turn whose
 * input crosses it starts the compaction, and the turns that go out before it lands still send
 * the whole history, so a request can grow past it by a few turns' worth before the window
 * applies; `mintCompactionLimitTokens` bounds that growth.
 */
export const mintIdleCompactionTokens = 250_000;

/**
 * The estimated input at which a request waits for a compaction instead of going out whole:
 * below the provider-side backstop (`mintCompactionThresholdTokens`, 268K) and the model's 272K
 * long-context boundary, where the input price doubles, with room for the estimate's error.
 */
export const mintCompactionLimitTokens = 260_000;

/** The Responses API compacts the context it is sent when this is the last input item. */
const compactionTrigger: AgentInputItem = {
  type: "unknown",
  providerData: { type: "compaction_trigger" },
};

/** Output items that leave the model waiting on a tool result. */
const toolCallTypes = new Set(["function_call", "shell_call", "apply_patch_call", "computer_call"]);

/**
 * Items the model wrote; the previous response's output tokens already count them. Everything
 * else added since, such as a tool's result or a host message, is new input.
 */
const modelOutputTypes = new Set([
  "reasoning",
  "function_call",
  "shell_call",
  "apply_patch_call",
  "computer_call",
  "compaction",
]);

/**
 * A conservative token count for input text: three characters a token, fewer than the
 * tokenizer's usual four, so the estimate errs high and a request waits rather than crosses.
 */
const charactersPerToken = 3;

type IdleCompactionEvent =
  | {
      readonly state: "started";
      readonly inputTokens: number;
      /** `limit`: the next request would have neared the long-context boundary; it waited. */
      readonly trigger: "watermark" | "limit";
    }
  | { readonly state: "ready" }
  | { readonly state: "failed"; readonly reason: "no_compaction_item" | "provider_failed" }
  | { readonly state: "superseded" };

type Compact = (request: ModelRequest) => Promise<ModelResponse>;

/**
 * Compaction off the minter's critical path. A server-side compaction runs inside the request
 * that crosses its threshold, so the turn waits for it (about a minute for the big model).
 * Instead, once a turn ends in tool calls with its input above the watermark, the same
 * request plus a compaction trigger runs in the background while the tools run: it reads
 * that turn's cached prefix. When it returns, each later request sends the compacted window
 * in place of the compacted prefix, followed by every item after it, so the reasoning and
 * tool calls of the turn being answered stay paired with their results.
 *
 * A turn normally never waits for a running compaction: it goes out uncompacted, and the
 * compaction applies to the first request after it lands. At most one compaction runs or
 * waits to apply at a time: a turn that was already out when one landed still reports its
 * long input, and starts none. A request whose estimated input reaches `limitTokens` waits
 * for the running compaction, or starts one of the last request and waits for it, so no
 * request crosses the long-context boundary while a window is on its way. The SDK's history
 * keeps every item; only what is sent changes. A provider compaction (the 268K backstop)
 * starts the SDK's input at its own item, so a window for the old prefix no longer matches and
 * is dropped, and the turn it compacted no longer counts toward the next request's estimate.
 *
 * `note`, when it gives an item, follows the compaction item in the window. It is taken when
 * the compaction starts, so it describes what came before the compacted request, and the
 * window keeps the same item on every later request, so their cached prefix holds.
 */
export const makeIdleCompaction = (options: {
  readonly watermarkTokens: number;
  readonly limitTokens?: number;
  readonly report: (event: IdleCompactionEvent) => Promise<void>;
  readonly note?: () => AgentInputItem | undefined;
}) => {
  const controller = new AbortController();
  let running: Promise<void> | undefined;
  let disabled = false;
  let ready:
    | { readonly length: number; readonly key: string; readonly window: AgentInputItem[] }
    | undefined;
  /** A landed window no request has sent yet. */
  let unapplied = false;
  /** The last turn: what it sent, how long it was, and how to compact it. */
  let last:
    | {
        readonly request: ModelRequest;
        readonly sent: ModelRequest;
        readonly length: number;
        readonly tokens: number;
        readonly compact: Compact;
      }
    | undefined;
  const reports = new Set<Promise<void>>();
  const report = (event: IdleCompactionEvent) => {
    const sent = options.report(event).finally(() => reports.delete(sent));
    reports.add(sent);
    return sent;
  };
  const key = (items: readonly AgentInputItem[]) => JSON.stringify(items);

  /** The input to send for the SDK's input: the compacted window replaces its prefix. */
  const view = (input: string | AgentInputItem[]): string | AgentInputItem[] => {
    if (ready === undefined || typeof input === "string") return input;
    if (input.length < ready.length || key(input.slice(0, ready.length)) !== ready.key) {
      ready = undefined;
      unapplied = false;
      void report({ state: "superseded" });
      return input;
    }
    unapplied = false;
    return [...ready.window, ...input.slice(ready.length)];
  };

  /** Starts a compaction of `request`, sent as `sent`, in the background. */
  const start = (
    request: ModelRequest,
    sent: ModelRequest,
    compact: Compact,
    event: { readonly inputTokens: number; readonly trigger: "watermark" | "limit" },
  ) => {
    if (typeof request.input === "string" || !Array.isArray(sent.input)) return;
    const original = [...request.input];
    const compacted = { length: original.length, key: key(original) };
    const note = options.note?.();
    void report({ state: "started", ...event });
    running = compact({
      ...sent,
      input: [...sent.input, compactionTrigger],
      signal: controller.signal,
    })
      .then(async (result) => {
        const item = result.output.findLast((entry) => entry.type === "compaction");
        if (item === undefined) {
          disabled = true;
          await report({ state: "failed", reason: "no_compaction_item" });
          return;
        }
        ready = { ...compacted, window: note === undefined ? [item] : [item, note] };
        unapplied = true;
        await report({ state: "ready" });
      })
      .catch(async () => {
        if (controller.signal.aborted) return;
        // The provider-side backstop still bounds the context; no retry loop here.
        disabled = true;
        await report({ state: "failed", reason: "provider_failed" });
      })
      .finally(() => {
        running = undefined;
      });
  };

  /** After a returned turn: starts a background compaction when the model now waits on tools. */
  const afterTurn = (
    request: ModelRequest,
    sent: ModelRequest,
    response: ModelResponse,
    compact: Compact,
  ) => {
    // The provider compacted this turn: the SDK's next input starts at its compaction item, so
    // this turn's input neither prefixes it nor measures it, and compacting it would be wasted.
    const providerCompacted = response.output.some((item) => item.type === "compaction");
    last =
      typeof request.input === "string" || providerCompacted
        ? undefined
        : {
            request,
            sent,
            length: request.input.length,
            tokens: response.usage.inputTokens + response.usage.outputTokens,
            compact,
          };
    // One compaction at a time, until its window has gone out: this turn may have been sent
    // before the last one landed, so its long input is already being compacted.
    if (disabled || running !== undefined || unapplied || controller.signal.aborted) return;
    if (response.usage.inputTokens < options.watermarkTokens) return;
    if (providerCompacted) return;
    if (!response.output.some((item) => item.type !== undefined && toolCallTypes.has(item.type)))
      return;
    start(request, sent, compact, {
      inputTokens: response.usage.inputTokens,
      trigger: "watermark",
    });
  };

  /** The next request's input tokens, from the last turn's count and what was added since. */
  const estimate = (input: readonly AgentInputItem[], previous: NonNullable<typeof last>) => {
    const added = input
      .slice(previous.length)
      .filter((item) => item.type === undefined || !modelOutputTypes.has(item.type));
    return previous.tokens + Math.ceil(JSON.stringify(added).length / charactersPerToken);
  };

  /**
   * Before a request goes out: when its estimated input reaches the limit and no window is
   * waiting to apply, it waits for the running compaction, or starts one of the last request,
   * which stayed under the limit, and waits for that. A failed compaction leaves the request to
   * the provider's backstop.
   */
  const beforeSend = async (input: string | AgentInputItem[], signal?: AbortSignal) => {
    const limit = options.limitTokens;
    if (limit === undefined || typeof input === "string" || last === undefined) return;
    if (unapplied || disabled || controller.signal.aborted) return;
    const tokens = estimate(input, last);
    if (tokens < limit) return;
    if (running === undefined)
      start(last.request, last.sent, last.compact, { inputTokens: tokens, trigger: "limit" });
    const compacting = running;
    if (compacting === undefined) return;
    // The attempt's abort ends the wait; the call then fails as aborted.
    await new Promise<void>((done) => {
      if (signal?.aborted) return done();
      signal?.addEventListener("abort", () => done(), { once: true });
      void compacting.finally(done);
    });
  };

  /** Ends a compaction still running when the attempt ends; waits for it and its reports. */
  const close = async () => {
    controller.abort();
    await running;
    await Promise.all(reports);
  };

  return { view, afterTurn, beforeSend, close };
};
