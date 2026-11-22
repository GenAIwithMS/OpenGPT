import type {
  AgentInputItem,
  Model,
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from "@openai/agents";
import { protocol, Usage } from "@openai/agents";
import { compaction, StaticCompactionPolicy } from "@openai/agents/sandbox";
import { Effect, Schema } from "effect";
import { decodePublicationRound, PublicationRound } from "./publication-delta.js";
import {
  configurationUpdate,
  configurationUpdateEffort,
  latestConfigurationEffort,
  withCacheComparison,
} from "../models/cached-instructions.js";
import { leadingPrivateAfter } from "./review-layout.js";

/** Private continuation state; complete original exchanges remain in protected model records. */
export const GuardianSessionSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  sdkVersion: Schema.Literal("0.18.0"),
  history: Schema.Array(Schema.Unknown),
  incomplete: Schema.Boolean,
  effectiveReasoningContext: Schema.optional(
    Schema.Literal("all_turns", "current_turn", "not_reported"),
  ),
  /**
   * The items before the history's first request belong to a private review whose request
   * a compaction removed, so readable records still withhold them.
   */
  leadingPrivate: Schema.optional(Schema.Literal(true)),
  /**
   * The mint's latest publication round: its decision and the files it judged, which the next
   * round's request is a delta against. Kept apart from the history, so no compaction drops it.
   * Stored loosely and decoded when used, so a round this release cannot read, such as one with
   * a finding category a later release added, is dropped rather than failing the restore.
   */
  publicationRound: Schema.optional(Schema.Unknown),
  /**
   * The conversation's latest response, which the next request compares its prompt cache with,
   * also after a takeover.
   */
  latestResponseId: Schema.optional(Schema.String),
});
export type GuardianSessionSnapshot = typeof GuardianSessionSnapshot.Type;
interface GuardianReasoningReport {
  readonly requested: "all_turns";
  readonly effective: "all_turns" | "current_turn" | "not_reported";
  readonly level: "info" | "warning";
  readonly detail?: string;
}
export interface GuardianSessionOptions {
  readonly reportReasoning?: (context: GuardianReasoningReport) => Effect.Effect<void>;
  readonly initial?: GuardianSessionSnapshot;
  readonly save?: (snapshot: GuardianSessionSnapshot) => Effect.Effect<void, Error>;
  /**
   * What the conversation is told after a turn that did not complete: the result of each tool
   * call it left unanswered, and the message before the next request. Guardian's own by default;
   * another continuing session, such as the outcome reviewer's, names its own work.
   */
  readonly interruption?: { readonly toolResult: string; readonly continuation: string };
  /**
   * A note for a restored conversation, such as why its build stopped and resumed: added once,
   * as a message before the next request, and kept in the history like any other item.
   */
  readonly resumeNote?: string;
}

const guardianInterruption = {
  toolResult:
    "The previous review was interrupted before this source result was retained. No source result or approval is implied. Read the current source again.",
  continuation:
    "The preceding review did not complete. Continue in the same conversation and review the following current request afresh; earlier verdicts are not authorization.",
};

export const guardianContinuityPolicy =
  "This is one continuing Guardian conversation for this mint. Earlier requests, source reads, " +
  "reasoning and verdicts are historical context, which neither grants nor limits this " +
  "request's authority. Apply the current instructions and this turn's trusted authority: read " +
  "this step's allowed effects from its own trusted_authority, not from an earlier review's, so " +
  "an act step keeps the write its own allowedEffects grant after a read-only explore review. " +
  "Inspect current source for every execution: an earlier allow never satisfies this review, " +
  "and an earlier read does only for a source the host lists in trusted_review.unchangedSources " +
  "as byte-identical to it. An interrupted review grants no approval.";

/** The conversation size, in input tokens, at which Guardian compacts it; the minter's too. */
const guardianCompactionTokens = 240_000;

/**
 * The provider-side compaction at the same threshold, with no additional tools or sandbox. It
 * is the backstop: the session compacts first (see `compactBefore`), since the provider's
 * compaction inside a request reads none of the conversation's cached prefix. The provider does
 * not combine it with a configuration update, so a request whose input holds one goes without it
 * while the session's own compaction covers it (see `backstopped` in `makeGuardianSession`).
 */
export const guardianCompaction = (): ReturnType<typeof compaction> =>
  compaction({ policy: new StaticCompactionPolicy(guardianCompactionTokens) });

/** The Responses API compacts the context it is sent when this is the last input item. */
const compactionTrigger: AgentInputItem = {
  type: "unknown",
  providerData: { type: "compaction_trigger" },
};

/** Tokens of items not yet sent, overestimated: their JSON runs nearer 4 bytes a token. */
const estimatedTokens = (items: readonly AgentInputItem[]) =>
  Math.ceil(JSON.stringify(items).length / 3);

/** Items compared by content: a restored history may hold an item's fields in another order. */
const key = (items: readonly AgentInputItem[]) =>
  JSON.stringify(items, (_name, value: unknown) =>
    value === null || typeof value !== "object" || Array.isArray(value)
      ? value
      : Object.fromEntries(
          Object.entries(value).sort(([left], [right]) => (left < right ? -1 : 1)),
        ),
  );

type ItemsRequest = Omit<ModelRequest, "input"> & { readonly input: AgentInputItem[] };

/**
 * The request without provider-side automatic compaction when its input holds a configuration
 * update, which the provider refuses to combine with it.
 */
const withoutAutomaticCompaction = <R extends ModelRequest>(request: R): R => {
  const providerData = request.modelSettings.providerData;
  if (
    providerData === undefined ||
    !("context_management" in providerData) ||
    typeof request.input === "string" ||
    !request.input.some((item) => configurationUpdateEffort(item) !== undefined)
  )
    return request;
  const { context_management: _automatic, ...rest } = providerData;
  return { ...request, modelSettings: { ...request.modelSettings, providerData: rest } };
};

const withArrayInput = (request: ModelRequest): ItemsRequest | undefined =>
  typeof request.input === "string" ? undefined : { ...request, input: request.input };

/** How a continuing session compacts what it sends; see `makeGuardianSession`. */
interface SessionCompaction {
  /** The request as it is sent: the conversation from its latest compaction on. */
  readonly view: (request: ModelRequest) => ModelRequest;
  /** Compacts the conversation first when this request would reach the threshold. */
  readonly before: (
    model: Model,
    sent: ModelRequest,
  ) => Effect.Effect<{ readonly sent: ModelRequest; readonly usage?: Usage }, Error>;
  /** The request as it goes to the provider, with or without its automatic compaction. */
  readonly backstopped: (request: ModelRequest) => ModelRequest;
  /** Records the request sent and its response, which the next request continues. */
  readonly after: (sent: ModelRequest, response: ModelResponse) => void;
}

const reasoningEfforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const closeInterruptedReview = (
  items: AgentInputItem[],
  interruption: NonNullable<GuardianSessionOptions["interruption"]>,
) => {
  const answered = new Set(
    items.flatMap((item) => (item.type === "function_call_result" ? [item.callId] : [])),
  );
  for (const item of [...items])
    if (item.type === "function_call" && !answered.has(item.callId))
      items.push({
        type: "function_call_result",
        status: "completed",
        name: item.name,
        callId: item.callId,
        output: { type: "text", text: interruption.toolResult },
      });
  items.push({ role: "user", type: "message", content: interruption.continuation });
};

const providerError = (error: unknown) =>
  error instanceof Error ? error : new Error("Guardian provider failed", { cause: error });

const addedUsage = (first: Usage, second: Usage) => {
  const total = new Usage();
  total.add(first);
  total.add(second);
  return total;
};

const continuationProvider = ({
  provider,
  state,
  signal,
  save,
  reportReasoning,
  setEffective,
  compacted,
  compaction: sessionCompaction,
  comparison,
}: {
  provider: ModelProvider;
  state: () => AgentInputItem[];
  signal: () => AbortSignal;
  save: (items: readonly AgentInputItem[], incomplete: boolean) => Effect.Effect<void, Error>;
  reportReasoning: GuardianSessionOptions["reportReasoning"];
  setEffective: (value: "all_turns" | "current_turn" | "not_reported") => void;
  compacted: () => void;
  compaction: SessionCompaction;
  /** The conversation's latest response, which each request compares its prompt cache with. */
  comparison: { readonly latest: () => string | undefined; readonly set: (id?: string) => void };
}): ModelProvider => ({
  getModel: (name) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const model = yield* Effect.promise(async () => provider.getModel(name));
        return {
          ...model,
          getStreamedResponse: model.getStreamedResponse.bind(model),
          getResponse: (request: ModelRequest) =>
            Effect.runPromise(
              Effect.gen(function* () {
                yield* save(state(), true);
                const prepared = yield* sessionCompaction.before(
                  model,
                  sessionCompaction.view(request),
                );
                signal().throwIfAborted();
                if (prepared.usage !== undefined) yield* save(state(), true);
                const returned = yield* Effect.tryPromise({
                  try: () =>
                    model.getResponse(
                      withCacheComparison(
                        sessionCompaction.backstopped(prepared.sent),
                        comparison.latest(),
                      ),
                    ),
                  catch: providerError,
                });
                comparison.set(returned.responseId);
                signal().throwIfAborted();
                sessionCompaction.after(prepared.sent, returned);
                if (returned.output.some((item) => item.type === "compaction")) compacted();
                // The review's usage counts the compaction call too.
                const response =
                  prepared.usage === undefined
                    ? returned
                    : { ...returned, usage: addedUsage(prepared.usage, returned.usage) };
                const metadata = Schema.decodeUnknownEither(
                  Schema.Struct({
                    reasoning: Schema.Struct({
                      context: Schema.Literal("all_turns", "current_turn"),
                    }),
                  }),
                )(response.providerData);
                const effective =
                  metadata._tag === "Right" ? metadata.right.reasoning.context : "not_reported";
                setEffective(effective);
                yield* save([...state(), ...response.output], true);
                // A current_turn response still decides: each request carries its own trusted
                // authority and source inspection, and the replayed history keeps earlier requests,
                // source exchanges and verdicts. Only earlier turns' reasoning is not carried.
                if (reportReasoning)
                  yield* reportReasoning(
                    effective === "current_turn"
                      ? {
                          requested: "all_turns",
                          effective,
                          level: "warning",
                          detail:
                            "Guardian requested all_turns reasoning but the provider reported current_turn: earlier reviews' reasoning was not carried into this response. The review continues; earlier requests, source exchanges and verdicts are still sent as conversation history.",
                        }
                      : { requested: "all_turns", effective, level: "info" },
                  );
                return response;
              }),
              { signal: signal() },
            ),
        };
      }),
    ),
});

export const makeGuardianSession = (options: GuardianSessionOptions) => {
  const permit = Effect.unsafeMakeSemaphore(1);
  /** The resume note, until a request carries it. */
  let resumeNote = options.resumeNote;
  /** Compactions this process made or observed; each replaces the context Guardian sees. */
  let compactions = 0;
  let current: GuardianSessionSnapshot = options.initial ?? {
    version: 1,
    sdkVersion: "0.18.0",
    history: [],
    incomplete: false,
  };
  const history = (): AgentInputItem[] =>
    current.history.map((item) => protocol.ModelItem.parse(item));
  /**
   * The current review's compacted prefixes, as the SDK's input holds them, each replaced by its
   * compaction item and the configuration update in force where it was cut, if any. A new review
   * starts from the saved history, which already starts there.
   */
  let windows: {
    readonly length: number;
    readonly key: string;
    readonly items: readonly AgentInputItem[];
  }[] = [];
  /** The last request sent with no compaction in its response, and its size with that output. */
  let last:
    | {
        readonly request: ItemsRequest;
        readonly outputs: number;
        readonly tokens: number;
      }
    | undefined;
  /** Set once a compaction request returned no compaction: the provider-side backstop remains. */
  let triggerUnsupported = false;
  /**
   * The effort in force when a request went to the provider's compaction without its
   * configuration updates (see `backstopped`), until its response arrives.
   */
  let backstopEffort: string | undefined;
  /** The provider's compaction item that ended that effort, which follows it again. */
  let providerCompacted: { readonly key: string; readonly effort: string } | undefined;
  /** Keeps the conversation's latest response, which the next request compares with. */
  const setLatestResponse = (id: string | undefined) => {
    const { latestResponseId: _previous, ...rest } = current;
    current = id === undefined ? rest : { ...rest, latestResponseId: id };
  };
  /**
   * Only a compaction item replaces context, never our own trimming: the items from the latest
   * one on, each compacted prefix replaced by its item, and the items that dropped out.
   */
  const view = (items: readonly AgentInputItem[]) => {
    let kept = [...items];
    const dropped: AgentInputItem[] = [];
    const cut = (length: number) => {
      dropped.push(...kept.slice(0, length));
      kept = kept.slice(length);
    };
    const toLatestCompaction = () =>
      cut(
        Math.max(
          0,
          kept.findLastIndex((item) => item.type === "compaction"),
        ),
      );
    toLatestCompaction();
    // The effort a provider's compaction ended follows its item again, before the windows are
    // matched, since a later compaction of this review keyed its window on the items with it.
    const [first, second] = kept;
    if (
      providerCompacted !== undefined &&
      first?.type === "compaction" &&
      key([first]) === providerCompacted.key &&
      (second === undefined || configurationUpdateEffort(second) === undefined)
    )
      kept = [first, configurationUpdate(providerCompacted.effort), ...kept.slice(1)];
    for (const window of windows)
      if (kept.length >= window.length && key(kept.slice(0, window.length)) === window.key) {
        cut(window.length);
        kept = [...window.items, ...kept];
      }
    toLatestCompaction();
    return { kept, dropped };
  };
  const save = (items: readonly AgentInputItem[], incomplete: boolean) =>
    Effect.suspend(() => {
      const { kept, dropped } = view(items);
      const { leadingPrivate: _previous, ...rest } = current;
      current = {
        ...rest,
        history: kept,
        incomplete,
        ...(leadingPrivateAfter(dropped, current.leadingPrivate === true)
          ? { leadingPrivate: true as const }
          : {}),
      };
      return (options.save?.(current) ?? Effect.void).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            current = { ...current, incomplete: true };
          }),
        ),
      );
    });
  /**
   * Compacts the conversation before a request that would reach the threshold, by sending the
   * last request again, the same in every byte, with a compaction trigger after its input. That
   * request reads the cached prefix the last request wrote, where the provider's own compaction
   * inside the crossing request would process the whole conversation uncached. The returned
   * compaction item replaces the last request's input; the last response's output and every
   * later item follow it, so its reasoning and calls stay paired with their results. A compaction
   * ends every configuration update before it, so the one in force where it cut, if any, follows
   * the compaction item again, and the effort holds.
   */
  const compactBefore = (
    model: Model,
    sent: ModelRequest,
  ): Effect.Effect<{ readonly sent: ModelRequest; readonly usage?: Usage }, Error> =>
    Effect.gen(function* () {
      const previous = last;
      const input: AgentInputItem[] | undefined = withArrayInput(sent)?.input;
      if (previous === undefined || input === undefined || triggerUnsupported) return { sent };
      const prefix = previous.request.input.length;
      const carried = prefix + previous.outputs;
      if (
        input.length <= carried ||
        previous.tokens + estimatedTokens(input.slice(carried)) < guardianCompactionTokens ||
        key(input.slice(0, prefix)) !== key(previous.request.input)
      )
        return { sent };
      const { signal: _previousSignal, ...request } = previous.request;
      const outcome = yield* Effect.either(
        Effect.tryPromise({
          try: () =>
            model.getResponse(
              withCacheComparison(
                withoutAutomaticCompaction({
                  ...request,
                  input: [...request.input, compactionTrigger],
                  ...(sent.signal === undefined ? {} : { signal: sent.signal }),
                }),
                current.latestResponseId,
              ),
            ),
          catch: providerError,
        }),
      );
      // A failed compaction leaves the request as it was, for the provider-side backstop (see
      // `backstopped`), and stops further attempts, so a persistent failure is not retried on
      // every request.
      if (outcome._tag === "Left") {
        if (sent.signal?.aborted === true) return yield* Effect.fail(outcome.left);
        triggerUnsupported = true;
        return { sent };
      }
      setLatestResponse(outcome.right.responseId);
      const item = outcome.right.output.findLast((entry) => entry.type === "compaction");
      if (item === undefined) {
        triggerUnsupported = true;
        return { sent, usage: outcome.right.usage };
      }
      const next = input[prefix];
      // An update that already follows the cut takes over; two never stand next to each other.
      const effort =
        next !== undefined && configurationUpdateEffort(next) !== undefined
          ? undefined
          : latestConfigurationEffort(input.slice(0, prefix));
      const items = effort === undefined ? [item] : [item, configurationUpdate(effort)];
      windows = [...windows, { length: prefix, key: key(input.slice(0, prefix)), items }];
      compactions++;
      return {
        sent: { ...sent, input: [...items, ...input.slice(prefix)] },
        usage: outcome.right.usage,
      };
    });
  /**
   * The request's tokens, overestimated: the last request's reported size and the items added
   * since when it continues that request, or else an estimate of the whole request.
   */
  const requestTokens = (request: ItemsRequest) => {
    const previous = last;
    if (previous !== undefined) {
      const prefix = previous.request.input.length;
      const carried = prefix + previous.outputs;
      if (
        request.input.length >= carried &&
        key(request.input.slice(0, prefix)) === key(previous.request.input)
      )
        return previous.tokens + estimatedTokens(request.input.slice(carried));
    }
    return (
      estimatedTokens(request.input) + Math.ceil((request.systemInstructions?.length ?? 0) / 3)
    );
  };
  /**
   * The request as it goes to the provider. One whose input holds a configuration update goes
   * without the provider's automatic compaction, which does not combine with one, while it stays
   * below the threshold, so the session's own compaction covers it. One that would reach the
   * threshold anyway, because the session could not compact first (its compaction failed, or a
   * restored session knows no size yet), must not go without any compaction: it keeps the
   * provider's, without its configuration updates, and carries the effort in force as its own.
   * That request reads none of the cached prefix, and the effort follows the provider's
   * compaction item again as an update (see `view`).
   */
  const backstopped = (request: ModelRequest): ModelRequest => {
    backstopEffort = undefined;
    const items = withArrayInput(request);
    const providerData = request.modelSettings.providerData;
    if (
      items === undefined ||
      providerData === undefined ||
      !("context_management" in providerData)
    )
      return request;
    const inForce = latestConfigurationEffort(items.input);
    if (inForce === undefined) return request;
    const effort = reasoningEfforts.find((known) => known === inForce);
    if (effort === undefined || requestTokens(items) < guardianCompactionTokens)
      return withoutAutomaticCompaction(request);
    backstopEffort = effort;
    return {
      ...request,
      input: items.input.filter((item) => configurationUpdateEffort(item) === undefined),
      modelSettings: {
        ...request.modelSettings,
        reasoning: { ...request.modelSettings.reasoning, effort },
      },
    };
  };
  const compaction: SessionCompaction = {
    view: (request) => {
      const input = withArrayInput(request)?.input;
      return input === undefined ? request : { ...request, input: view(input).kept };
    },
    before: compactBefore,
    backstopped,
    after: (sent, response) => {
      const compacted = response.output.findLast((item) => item.type === "compaction");
      if (compacted !== undefined && backstopEffort !== undefined)
        providerCompacted = { key: key([compacted]), effort: backstopEffort };
      backstopEffort = undefined;
      const request = withArrayInput(sent);
      last =
        request === undefined || response.output.some((item) => item.type === "compaction")
          ? undefined
          : {
              request,
              outputs: response.output.length,
              tokens: response.usage.inputTokens + response.usage.outputTokens,
            };
    },
  };
  return {
    provider: (provider: ModelProvider, state: () => AgentInputItem[], signal: () => AbortSignal) =>
      continuationProvider({
        compaction,
        provider,
        state,
        signal,
        save,
        reportReasoning: options.reportReasoning,
        setEffective: (effective) => {
          current = { ...current, effectiveReasoningContext: effective };
        },
        compacted: () => {
          compactions++;
        },
        comparison: { latest: () => current.latestResponseId, set: setLatestResponse },
      }),
    snapshot: () => current,
    /** Whether readable records must withhold the history's leading items; see the snapshot. */
    leadingPrivate: () => current.leadingPrivate === true,
    /** The conversation since its last compaction, as the next request continues it. */
    history,
    /** The mint's latest publication round, which the next one is reviewed against, if readable. */
    publicationRound: () => decodePublicationRound(current.publicationRound),
    /** Keeps a completed publication round and saves it with the conversation. */
    keepPublicationRound: (round: PublicationRound) =>
      Effect.suspend(() => {
        current = { ...current, publicationRound: Schema.encodeSync(PublicationRound)(round) };
        return options.save?.(current) ?? Effect.void;
      }),
    /** Changes whenever a compaction replaces the context, including in the middle of a review. */
    compactions: () => compactions,
    exclusive: <A, E, R>(work: Effect.Effect<A, E, R>) => permit.withPermits(1)(work),
    observe: (items: readonly AgentInputItem[]) => save(items, true),
    complete: () => save(history(), false),
    sourceResult: (callId: string, output: string) =>
      save(
        [
          ...history(),
          {
            type: "function_call_result",
            status: "completed",
            name: "read_source",
            callId,
            output: { type: "text", text: output },
          },
        ],
        true,
      ),
    /**
     * The reasoning effort the conversation's latest configuration update selects, since its
     * latest compaction; undefined when none does, so the request's own effort holds.
     */
    reasoningEffort: () => latestConfigurationEffort(history()),
    /**
     * Adds a request; `continuing` marks the host's follow-up within the review in progress.
     * `effort`, when given, adds a configuration update to it before the request, so this and
     * later responses reason at that effort without changing the request's own.
     */
    input: (request: string, continuing = false, effort?: string) =>
      Effect.gen(function* () {
        if (!continuing) windows = [];
        const items = history();
        if (current.incomplete && !continuing) {
          closeInterruptedReview(items, options.interruption ?? guardianInterruption);
        }
        // The conversation holds the note from here on, even when this save fails.
        if (resumeNote !== undefined)
          items.push({ role: "user", type: "message", content: resumeNote });
        resumeNote = undefined;
        if (effort !== undefined) {
          // Two updates never stand next to each other: the newer one replaces the older.
          const last = items.at(-1);
          if (last !== undefined && configurationUpdateEffort(last) !== undefined) items.pop();
          items.push(configurationUpdate(effort));
        }
        items.push({ role: "user", type: "message", content: request });
        yield* save(items, true);
        return items;
      }),
  };
};
export type GuardianSession = ReturnType<typeof makeGuardianSession>;
