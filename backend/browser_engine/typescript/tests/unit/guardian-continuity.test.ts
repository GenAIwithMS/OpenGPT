import OpenAI from "openai";
import { lunaModel } from "../../src/models/models.js";
import { GuardianSessionSnapshot } from "../../src/guardian/session.js";
import { OpenAIProvider, setDefaultModelProvider, Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Deferred, Effect, Either, Fiber, Schema } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { ReviewFailure, makeGuardian } from "../../src/guardian/review.js";
import type { GuardianDiagnostics, PendingExecution } from "../../src/guardian/review.js";
import type { ModelDiagnosticTiming } from "../../src/models/model-diagnostic-timing.js";
import type { ModelObserverFactory } from "../../src/models/model-observer.js";
import { makeSourceInspector } from "../../src/guardian/source.js";
import type { SourceProjection } from "../../src/guardian/source.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import { conversationOf } from "../support/guardian-requests.js";

const native = { executionEnvironment: nativeExecutionEnvironment };

const pending: PendingExecution = {
  invocationId: "mint_continuity",
  attemptId: "attempt_one",
  entrypoint: "operation/operation.mjs",
  screenedIntent: "Read the selected trip",
  screenedInput: "{}",
  screenedObservations: "Synthetic fixture",
  accountScope: "account_one",
  allowedOrigins: ["https://travel.example.test"],
  allowedEffects: ["read"],
};
afterEach(() => {
  setDefaultModelProvider(new OpenAIProvider());
  vi.restoreAllMocks();
});
const reason: ModelResponse["output"][number] = {
  type: "reasoning",
  id: "rs_first",
  content: [],
  providerData: { encrypted_content: "opaque-first-review-reasoning" },
};

it("keeps reasoning and source exchanges between reviews of the same mint without sharing another mint", async () => {
  const requests: ModelRequest[] = [];
  let sourceReads = 0;
  setDefaultModelProvider({
    getModel: () => ({
      getResponse: async (request) => {
        requests.push(request);
        const call = requests.length;
        return {
          usage: new Usage(),
          output:
            call === 1
              ? [
                  {
                    type: "function_call" as const,
                    callId: `read_${call}`,
                    name: "read_source",
                    arguments: JSON.stringify({ path: "operation/helper.mjs", offset: 0 }),
                    status: "completed" as const,
                  },
                ]
              : [
                  ...(call === 2 ? [reason] : []),
                  {
                    type: "message" as const,
                    role: "assistant" as const,
                    status: "completed" as const,
                    content: [
                      {
                        type: "output_text" as const,
                        text: JSON.stringify({
                          outcome: "allow",
                          rationale: "Current source was read",
                          action: "read",
                        }),
                      },
                    ],
                  },
                ],
        };
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  });
  const reviewer = makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native);
  const guardian = makeGuardian(reviewer, undefined, {});
  const read = () =>
    Effect.sync(() => {
      sourceReads++;
      return JSON.stringify({
        kind: "untrusted_source",
        path: pending.entrypoint,
        byteOffset: 0,
        source: "export default 1",
        nextOffset: 16,
        hasMore: false,
      });
    });
  await Effect.runPromise(guardian.review(pending, read));
  await Effect.runPromise(guardian.review({ ...pending, screenedInput: '{"day":2}' }, read));
  const other = makeGuardian(reviewer, undefined, {});
  await Effect.runPromise(other.review({ ...pending, invocationId: "other_mint" }, read));
  // Each review's request carries its current entrypoint; the first review also read a helper.
  expect(sourceReads).toBe(4);
  expect(requests).toHaveLength(4);
  expect(JSON.stringify(requests[2]?.input)).toContain("opaque-first-review-reasoning");
  expect(JSON.stringify(requests[2]?.input)).toContain("read_1");
  expect(JSON.stringify(requests[3]?.input)).not.toContain("opaque-first-review-reasoning");
});

const message = (outcome: "allow" | "deny" = "allow"): ModelResponse["output"][number] => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [
    {
      type: "output_text",
      text: JSON.stringify({ outcome, rationale: "Fixture verdict", action: "read" }),
    },
  ],
});
const call = (id: string): ModelResponse["output"][number] => ({
  type: "function_call",
  callId: id,
  name: "read_source",
  status: "completed",
  arguments: JSON.stringify({ path: pending.entrypoint, offset: 0 }),
});
const provide = (outputs: readonly ModelResponse["output"][], requests: ModelRequest[]) => {
  setDefaultModelProvider({
    getModel: () => ({
      getResponse: async (request) => {
        requests.push(request);
        const output = outputs[requests.length - 1];
        if (!output) throw new Error("Synthetic provider interrupted");
        return { usage: new Usage(), output };
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  });
};
const readCurrent = () =>
  Effect.succeed(
    JSON.stringify({
      kind: "untrusted_source",
      path: pending.entrypoint,
      byteOffset: 0,
      source: "export default 1",
      nextOffset: 16,
      hasMore: false,
    }),
  );

it("observes a private session review's model timing and permit wait without retaining its transcript", async () => {
  vi.spyOn(performance, "now").mockReturnValue(100);
  // A private host kind that reads the entrypoint, then an ordinary execution review on the same
  // session whose entrypoint is already in its request.
  provide([[call("timed")], [message()], [message()]], []);
  const modelTiming: ModelDiagnosticTiming = {
    phase: "model_returned",
    sequence: 0,
    occurredAtUtc: "2000-01-01T00:00:00.000Z",
    occurredMonotonicMs: 5,
    startedMonotonicMs: 2,
    queueMs: 0,
    elapsedMs: 3,
  };
  /** A host observer that reports one finite timing and passes model and tool calls through. */
  const observerFactory: ModelObserverFactory = (persist) => {
    let persisted: Promise<void> = Promise.resolve();
    return {
      attach: () => undefined,
      tool: (_call, invoke) => invoke(),
      provider: (provider) => provider,
      started: () => {
        persisted = persist({ phase: "started" }, modelTiming);
      },
      skillsInstalled: () => undefined,
      segment: () => undefined,
      completed: () => undefined,
      failed: () => undefined,
      takeNativeCall: () => undefined,
      durabilityFailure: () => undefined,
      terminal: () => ({ phase: "terminal", timing: modelTiming, value: {} }),
      flush: () => persisted,
    };
  };
  const observed: unknown[] = [];
  const transcripts: { reviewId?: string; modelTiming?: ModelDiagnosticTiming }[] = [];
  const started: unknown[] = [];
  const diagnostics: GuardianDiagnostics = {
    emit: (name, details) =>
      Effect.sync(() => {
        if (name === "guardian.started") started.push(details);
      }),
    retainModelTranscript: (_name, _details, correlation) =>
      Effect.sync(() => {
        transcripts.push({
          ...(correlation?.reviewId === undefined ? {} : { reviewId: correlation.reviewId }),
          ...(correlation?.modelTiming === undefined
            ? {}
            : { modelTiming: correlation.modelTiming }),
        });
      }),
    retainScreenedSource: () => Effect.void,
    observeModelTrace: (name, timing, correlation) =>
      Effect.sync(() => {
        observed.push({ name, timing, correlation });
      }),
  };
  const guardian = makeGuardian(
    makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, {
      ...native,
      observerFactory,
    }),
    diagnostics,
    {},
  );
  const reviewed = await Effect.runPromise(
    guardian.reviewHostKind(
      pending,
      {
        kind: "synthetic_private_check",
        policy: "Allow when the synthetic evidence is consistent; otherwise deny.",
        evidence: { note: "Synthetic private evidence" },
        outcomes: ["allow", "deny"],
        private: true,
      },
      readCurrent,
    ),
  );
  expect(observed).toEqual([
    {
      name: "guardian.model",
      timing: modelTiming,
      correlation: { reviewId: reviewed.reviewId, reviewKind: "host" },
    },
  ]);
  expect(transcripts).toEqual([]);
  const timing = (started[0] as { details: { timing: Record<string, number> } }).details.timing;
  expect(timing).toMatchObject({
    attempt: 1,
    startOffsetMs: 100,
    permitWaitStartOffsetMs: 100,
    permitWaitEndOffsetMs: 100,
  });
  // An ordinary session review keeps its whole record, timing included, so its timing is not
  // observed a second time.
  const execution = await Effect.runPromise(guardian.review(pending, readCurrent));
  expect(observed).toHaveLength(1);
  expect(transcripts).toEqual([{ reviewId: execution.reviewId, modelTiming }]);
});

it("keeps a publication's permit wait separate from the mint review holding the session", async () => {
  let now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const records: {
    name: string;
    details: unknown;
    reviewId?: string;
    reviewKind?: string;
  }[] = [];
  const record: GuardianDiagnostics["emit"] = (name, details, correlation) =>
    Effect.sync(() => {
      records.push({ name, details, ...correlation });
    });
  const results = await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const guardian = makeGuardian(
        {
          run: (turn) =>
            Effect.gen(function* () {
              if (turn.pending.publication === undefined) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                yield* turn.readSource(pending.entrypoint, 0);
              } else {
                now += 4;
              }
              return {
                outcome: "allow" as const,
                rationale: "Approved synthetic source.",
                action: "read" as const,
              };
            }),
        },
        {
          emit: record,
          retainModelTranscript: record,
          retainScreenedSource: () => Effect.void,
        },
        {},
      );
      const mint = yield* Effect.fork(guardian.review(pending, readCurrent));
      yield* Deferred.await(entered);
      const publication = yield* Effect.fork(
        guardian.review({ ...pending, publication: { files: [] } }, readCurrent),
      );
      yield* Effect.yieldNow();
      now += 30;
      yield* Deferred.succeed(release, undefined);
      return {
        mint: yield* Fiber.join(mint),
        publication: yield* Fiber.join(publication),
      };
    }),
  );
  const details = (name: string, reviewId: string) =>
    (
      records.find((record) => record.name === name && record.reviewId === reviewId)?.details as {
        details: { timing: Record<string, number> };
      }
    ).details.timing;
  expect(results.mint.reviewId).not.toBe(results.publication.reviewId);
  expect(details("guardian.started", results.publication.reviewId)).toMatchObject({
    attempt: 1,
    permitWaitStartOffsetMs: 100,
    permitWaitEndOffsetMs: 130,
    startOffsetMs: 130,
  });
  expect(details("guardian.completed", results.mint.reviewId)).toMatchObject({
    startOffsetMs: 100,
    endOffsetMs: 130,
    elapsedMs: 30,
  });
  expect(details("guardian.completed", results.publication.reviewId)).toMatchObject({
    startOffsetMs: 130,
    endOffsetMs: 134,
    elapsedMs: 4,
  });
  expect(
    records.find((record) => record.reviewId === results.publication.reviewId)?.reviewKind,
  ).toBe("publication");
});

const InlinedEntrypoint = Schema.Struct({
  submitted_call: Schema.Struct({
    entrypointSource: Schema.optional(
      Schema.Struct({
        kind: Schema.Literal("untrusted_source"),
        path: Schema.String,
        byteOffset: Schema.Number,
        nextOffset: Schema.Number,
        hasMore: Schema.Boolean,
        source: Schema.String,
      }),
    ),
  }),
});
/** The entrypoint source carried in a request's own review message, as the model saw it. */
const inlinedEntrypoint = (request: ModelRequest | undefined) => {
  const input = request?.input;
  const review =
    typeof input === "string"
      ? undefined
      : input?.findLast(
          (item) =>
            "role" in item &&
            item.role === "user" &&
            typeof item.content === "string" &&
            item.content.startsWith("{"),
        );
  const content =
    typeof input === "string"
      ? input
      : review !== undefined && "content" in review
        ? review.content
        : undefined;
  return Schema.decodeUnknownSync(Schema.parseJson(InlinedEntrypoint))(content).submitted_call
    .entrypointSource;
};
/** The host's own source reader over in-memory files, with the host's source projection. */
const inspector = (
  files: Record<string, string>,
  project: SourceProjection = (_path, bytes) => Effect.succeed(new TextDecoder().decode(bytes)),
) =>
  makeSourceInspector((path) => {
    const text = files[path];
    return text === undefined
      ? Effect.fail(new ReviewFailure({ code: "SourceUnavailable" }))
      : Effect.succeed(new TextEncoder().encode(text));
  }, project);

it("gives a restored conversation's next review the current entrypoint source, so an allow needs no new read", async () => {
  const requests: ModelRequest[] = [];
  provide([[call("first")], [reason, message()], [message()]], requests);
  let saved: typeof GuardianSessionSnapshot.Type | undefined;
  const reviewer = makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native);
  const first = makeGuardian(reviewer, undefined, {
    save: (snapshot) =>
      Effect.sync(() => {
        saved = Schema.decodeUnknownSync(GuardianSessionSnapshot)(
          JSON.parse(JSON.stringify(snapshot)),
        );
      }),
  });
  await Effect.runPromise(
    first.review(pending, inspector({ [pending.entrypoint]: "export default 1" })),
  );
  expect(saved?.incomplete).toBe(false);
  const replacement = makeGuardian(reviewer, undefined, {
    initial: Schema.decodeUnknownSync(GuardianSessionSnapshot)(saved),
  });
  const edited = "export default 'edited since the first review'";
  const reviewed = await Effect.runPromise(
    replacement.review(
      { ...pending, attemptId: "takeover" },
      inspector({ [pending.entrypoint]: edited }),
    ),
  );
  expect(reviewed.decision.outcome).toBe("allow");
  expect(requests).toHaveLength(3);
  expect(JSON.stringify(requests[2]?.input)).toContain("opaque-first-review-reasoning");
  expect(inlinedEntrypoint(requests[2])).toEqual({
    kind: "untrusted_source",
    path: pending.entrypoint,
    byteOffset: 0,
    nextOffset: edited.length,
    hasMore: false,
    source: edited,
  });
});

it("tells a restored conversation the host's resume note once, before its next request", async () => {
  const note = "The build was paused and resumed. Its browser is new; review as usual.";
  const requests: ModelRequest[] = [];
  provide([[message()], [message()], [message()]], requests);
  let saved: typeof GuardianSessionSnapshot.Type | undefined;
  const reviewer = makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native);
  const save = (snapshot: typeof GuardianSessionSnapshot.Type) =>
    Effect.sync(() => {
      saved = Schema.decodeUnknownSync(GuardianSessionSnapshot)(
        JSON.parse(JSON.stringify(snapshot)),
      );
    });
  const files = inspector({ [pending.entrypoint]: "export default 1" });
  await Effect.runPromise(makeGuardian(reviewer, undefined, { save }).review(pending, files));
  const resumed = makeGuardian(reviewer, undefined, {
    initial: Schema.decodeUnknownSync(GuardianSessionSnapshot)(saved),
    resumeNote: note,
    save,
  });
  await Effect.runPromise(resumed.review({ ...pending, attemptId: "resumed" }, files));
  await Effect.runPromise(resumed.review({ ...pending, attemptId: "resumed" }, files));

  const notes = (request: ModelRequest | undefined) => {
    const input = request?.input;
    return (Array.isArray(input) ? input : []).flatMap((item, index) =>
      "role" in item && item.role === "user" && item.content === note ? [index] : [],
    );
  };
  expect(notes(requests[0])).toEqual([]);
  // The note comes once, right before the resumed attempt's first request.
  const firstResumed = requests[1]?.input;
  expect(notes(requests[1])).toEqual([Array.isArray(firstResumed) ? firstResumed.length - 2 : -1]);
  expect(inlinedEntrypoint(requests[1])?.source).toBe("export default 1");
  // The conversation keeps it in place, and nothing adds it again.
  expect(notes(requests[2])).toEqual(notes(requests[1]));
  expect(JSON.stringify(saved?.history)).toContain(note);
});

it("masks a registered secret in the entrypoint source the request carries", async () => {
  const secret = "synthetic-registered-entrypoint-secret";
  const secrets = makeRunSecrets();
  secrets.register(secret);
  const requests: ModelRequest[] = [];
  provide([[message()]], requests);
  const guardian = makeGuardian(
    makeOpenAIReviewer("{{ tenant_policy_config }}", false, native),
    undefined,
    {},
  );
  const reviewed = await Effect.runPromise(
    guardian.review(
      pending,
      inspector({ [pending.entrypoint]: `export const token = "${secret}";` }, (_path, bytes) =>
        Effect.sync(() => secrets.redact(new TextDecoder().decode(bytes))),
      ),
    ),
  );
  expect(reviewed.decision.outcome).toBe("allow");
  expect(inlinedEntrypoint(requests[0])?.source).toBe('export const token = "[private]";');
  expect(JSON.stringify(requests)).not.toContain(secret);
});

it("carries only the first page of a large entrypoint, and later pages come through read_source", async () => {
  const requests: ModelRequest[] = [];
  provide(
    [
      [
        {
          type: "function_call",
          callId: "second_page",
          name: "read_source",
          status: "completed",
          arguments: JSON.stringify({ path: pending.entrypoint, offset: 64 * 1024 }),
        },
      ],
      [message()],
    ],
    requests,
  );
  const guardian = makeGuardian(
    makeOpenAIReviewer("{{ tenant_policy_config }}", false, native),
    undefined,
    {},
  );
  const reviewed = await Effect.runPromise(
    guardian.review(
      pending,
      inspector({ [pending.entrypoint]: `${"a".repeat(70_000)}second-page-marker` }),
    ),
  );
  expect(reviewed.decision.outcome).toBe("allow");
  const firstPage = inlinedEntrypoint(requests[0]);
  expect(firstPage).toMatchObject({ byteOffset: 0, nextOffset: 64 * 1024, hasMore: true });
  expect(firstPage?.source).toBe("a".repeat(64 * 1024));
  expect(JSON.stringify(requests[0])).not.toContain("second-page-marker");
  // The model's own read of the next page returns the rest of the file.
  const nextInput = requests[1]?.input;
  const pageResult = (Array.isArray(nextInput) ? nextInput : []).find(
    (item) => item.type === "function_call_result" && item.callId === "second_page",
  );
  expect(JSON.stringify(pageResult)).toContain("second-page-marker");
});

it("keeps an interrupted model response and closes an unreturned source call on takeover", async () => {
  const requests: ModelRequest[] = [];
  provide([[reason, call("interrupted_source")]], requests);
  const reviewer = makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native);
  const checkpoints: (typeof GuardianSessionSnapshot.Type)[] = [];
  const first = makeGuardian(reviewer, undefined, {
    save: (snapshot) =>
      Effect.sync(() => {
        checkpoints.push(snapshot);
      }),
  });
  await Effect.runPromise(
    Effect.either(
      first.review(pending, () => Effect.fail(new ReviewFailure({ code: "SourceUnavailable" }))),
    ),
  );
  const snapshot = checkpoints.find(
    (checkpoint) =>
      JSON.stringify(checkpoint.history).includes("interrupted_source") &&
      !JSON.stringify(checkpoint.history).includes("function_call_result"),
  );
  expect(snapshot?.incomplete).toBe(true);
  const later: ModelRequest[] = [];
  provide([[call("fresh_source")], [message()]], later);
  const replacement = makeGuardian(reviewer, undefined, {
    initial: Schema.decodeUnknownSync(GuardianSessionSnapshot)(snapshot),
  });
  const reviewed = await Effect.runPromise(
    replacement.review({ ...pending, attemptId: "takeover" }, readCurrent),
  );
  expect(reviewed.decision.outcome).toBe("allow");
  expect(JSON.stringify(later[0]?.input)).toContain("opaque-first-review-reasoning");
  expect(JSON.stringify(later[0]?.input)).toContain("did not complete");
  const recoveredInput = later[0]?.input;
  expect(
    (Array.isArray(recoveredInput) ? recoveredInput : []).filter(
      (item) => item.type === "function_call_result" && item.callId === "interrupted_source",
    ),
  ).toHaveLength(1);
});

it("continues from provider compaction after takeover without replaying the older raw context", async () => {
  const requests: ModelRequest[] = [];
  const compact: ModelResponse["output"][number] = {
    type: "compaction",
    id: "cmp_one",
    encrypted_content: "opaque-compacted-context",
  };
  provide(
    [[call("first")], [reason, compact, call("after_compaction")], [message()], [message()]],
    requests,
  );
  const reviewer = makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native);
  const first = makeGuardian(reviewer, undefined, {});
  await Effect.runPromise(first.review(pending, readCurrent));
  const replacement = makeGuardian(reviewer, undefined, {
    initial: Schema.decodeUnknownSync(GuardianSessionSnapshot)(first.session?.snapshot()),
  });
  await Effect.runPromise(replacement.review({ ...pending, attemptId: "takeover" }, readCurrent));
  expect(conversationOf(requests[3])[0]).toMatchObject({
    type: "compaction",
    encrypted_content: "opaque-compacted-context",
  });
  expect(JSON.stringify(requests[3]?.input)).not.toContain("opaque-first-review-reasoning");
  expect(requests[3]?.modelSettings.reasoning?.context).toBe("all_turns");
  expect(requests[3]?.modelSettings.providerData).toMatchObject({
    context_management: [{ type: "compaction", compact_threshold: 240000 }],
  });
});

it("compacts a conversation at the threshold with the previous request plus a trigger, so it reads the cache", async () => {
  const requests: ModelRequest[] = [];
  const compact: ModelResponse["output"][number] = {
    type: "compaction",
    id: "cmp_explicit",
    encrypted_content: "opaque-explicitly-compacted-context",
  };
  // The first review's request is near the threshold; the second's new request would cross it.
  const scripted = [
    { output: [reason, message()], inputTokens: 236_000, cachedTokens: 0 },
    { output: [compact], inputTokens: 236_010, cachedTokens: 236_000 },
    // The compaction counts as one during the review, so the entrypoint is read again.
    { output: [call("entrypoint_after_compaction")], inputTokens: 30_000, cachedTokens: 0 },
    { output: [message()], inputTokens: 31_000, cachedTokens: 30_000 },
  ];
  setDefaultModelProvider({
    getModel: () => ({
      getResponse: async (request) => {
        requests.push(request);
        const next = scripted[requests.length - 1];
        if (!next) throw new Error("Synthetic provider has no more responses");
        return {
          usage: new Usage({
            input_tokens: next.inputTokens,
            output_tokens: 1_000,
            total_tokens: next.inputTokens + 1_000,
            input_tokens_details: { cached_tokens: next.cachedTokens },
          }),
          output: next.output,
        };
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  });
  const usage: unknown[] = [];
  const guardian = makeGuardian(
    makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native),
    {
      emit: (name, details) =>
        Effect.sync(() => {
          if (name === "guardian.usage") usage.push(details);
        }),
      retainModelTranscript: () => Effect.void,
      retainScreenedSource: () => Effect.void,
    },
    {},
  );
  await Effect.runPromise(
    guardian.review({ ...pending, screenedObservations: "first-review-observation" }, readCurrent),
  );
  await Effect.runPromise(
    guardian.review(
      { ...pending, screenedObservations: `second-review-observation ${"x".repeat(48_000)}` },
      readCurrent,
    ),
  );
  expect(requests).toHaveLength(4);
  const [previous, compaction, continued, afterRead] = requests;
  const inputOf = (request: ModelRequest | undefined) =>
    Array.isArray(request?.input) ? request.input : [];
  const withoutInput = (request: ModelRequest | undefined) =>
    JSON.stringify({ ...request, input: undefined, signal: undefined });
  // The compaction request is the previous request byte for byte, with the trigger appended.
  expect(withoutInput(compaction)).toBe(withoutInput(previous));
  expect(JSON.stringify(inputOf(compaction).slice(0, -1))).toBe(JSON.stringify(inputOf(previous)));
  expect(inputOf(compaction).at(-1)).toMatchObject({
    providerData: { type: "compaction_trigger" },
  });
  // The review then continues from the compacted window, followed by the previous review's
  // output and the new request, without replaying what the window replaced.
  expect(conversationOf(continued)[0]).toMatchObject({ type: "compaction", id: "cmp_explicit" });
  expect(JSON.stringify(inputOf(continued))).toContain("opaque-first-review-reasoning");
  expect(JSON.stringify(inputOf(continued))).toContain("second-review-observation");
  expect(JSON.stringify(inputOf(continued))).not.toContain("first-review-observation");
  expect(conversationOf(afterRead)[0]).toMatchObject({ type: "compaction", id: "cmp_explicit" });
  expect(JSON.stringify(inputOf(afterRead))).not.toContain("first-review-observation");
  expect(guardian.session?.compactions()).toBe(1);
  expect(guardian.session?.snapshot().history[0]).toMatchObject({ type: "compaction" });
  expect(usage.at(-1)).toMatchObject({
    details: { modelCalls: 3, inputTokens: 297_010, cachedTokens: 266_000 },
  });
});

it("sends the request unchanged when compaction fails, and does not try compacting again", async () => {
  const requests: ModelRequest[] = [];
  const isTrigger = (request: ModelRequest) =>
    Array.isArray(request.input) &&
    JSON.stringify(request.input.at(-1)).includes("compaction_trigger");
  setDefaultModelProvider({
    getModel: () => ({
      getResponse: async (request) => {
        requests.push(request);
        if (isTrigger(request)) throw new Error("Synthetic provider rejected the request");
        return {
          usage: new Usage({
            input_tokens: 236_000,
            output_tokens: 1_000,
            total_tokens: 237_000,
            input_tokens_details: { cached_tokens: 0 },
          }),
          output: [message()],
        };
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  });
  const guardian = makeGuardian(
    makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native),
    undefined,
    {},
  );
  const big = "x".repeat(48_000);
  for (const [index, observations] of ["first", `second ${big}`, `third ${big}`].entries()) {
    const reviewed = await Effect.runPromise(
      guardian.review(
        { ...pending, attemptId: `attempt-${index}`, screenedObservations: observations },
        readCurrent,
      ),
    );
    expect(reviewed.decision.outcome).toBe("allow");
  }
  // One failed compaction attempt, then each review's own request goes out unchanged.
  expect(requests.filter(isTrigger)).toHaveLength(1);
  expect(requests.filter((request) => !isTrigger(request))).toHaveLength(3);
  expect(guardian.session?.compactions()).toBe(0);
  const third = requests.at(-1)?.input;
  expect(JSON.stringify(third)).toContain("third");
  expect(JSON.stringify(third)).toContain("first");
});

it("serializes concurrent reviews without forking the conversation", async () => {
  const requests: ModelRequest[] = [];
  provide([[call("first")], [reason, message()], [call("second")], [message()]], requests);
  const guardian = makeGuardian(
    makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native),
    undefined,
    {},
  );
  await Effect.runPromise(
    Effect.all(
      [
        guardian.review(pending, readCurrent),
        guardian.review({ ...pending, screenedInput: '{"day":2}' }, readCurrent),
      ],
      { concurrency: "unbounded" },
    ),
  );
  expect(JSON.stringify(requests[2]?.input)).toContain("opaque-first-review-reasoning");
});

it("does not return an allow when the conversation checkpoint cannot be saved", async () => {
  const requests: ModelRequest[] = [];
  provide([[call("first")], [message()]], requests);
  const guardian = makeGuardian(
    makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native),
    undefined,
    {
      save: (snapshot) =>
        snapshot.incomplete ? Effect.void : Effect.fail(new Error("Synthetic save failure")),
    },
  );
  const result = await Effect.runPromise(Effect.either(guardian.review(pending, readCurrent)));
  expect(result).toMatchObject({ _tag: "Left", left: { reviewPhase: "diagnostic_retention" } });
});

it.each(["all_turns", "current_turn", undefined] as const)(
  "requests all-turn reasoning on the wire and reports provider mode %s without guessing",
  async (effective) => {
    const bodies: unknown[] = [];
    const reported: unknown[] = [];
    const client = new OpenAI({
      apiKey: "synthetic-key",
      maxRetries: 0,
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
        return new Response(
          JSON.stringify({
            id: "resp_wire",
            object: "response",
            created_at: 1,
            status: "completed",
            model: lunaModel,
            ...(effective ? { reasoning: { context: effective } } : {}),
            output: [
              {
                type: "reasoning",
                id: "rs_wire",
                summary: [],
                encrypted_content: "opaque-wire-reasoning",
              },
              {
                type: "message",
                id: "msg_wire",
                role: "assistant",
                status: "completed",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      outcome: "allow",
                      rationale: "Synthetic recovery",
                      action: "read",
                    }),
                    annotations: [],
                  },
                ],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    setDefaultModelProvider(new OpenAIProvider({ openAIClient: client }));
    const guardian = makeGuardian(
      makeOpenAIReviewer("{{ tenant_policy_config }}", false, native),
      undefined,
      {
        reportReasoning: (context) =>
          Effect.sync(() => {
            reported.push(context);
          }),
      },
    );
    const result = await Effect.runPromise(
      Effect.either(guardian.reviewRecovery(pending, "Synthetic stalled browser", readCurrent)),
    );
    expect(bodies[0]).toMatchObject({
      model: lunaModel,
      store: false,
      reasoning: { context: "all_turns" },
      include: ["reasoning.encrypted_content"],
      context_management: [{ type: "compaction", compact_threshold: 240000 }],
    });
    expect(reported).toEqual([
      expect.objectContaining({
        requested: "all_turns",
        effective: effective ?? "not_reported",
        level: effective === "current_turn" ? "warning" : "info",
      }),
    ]);
    expect(Either.isRight(result)).toBe(true);
    expect(guardian.session?.snapshot().effectiveReasoningContext).toBe(
      effective ?? "not_reported",
    );
  },
);

it("cancellation releases the review permit and a late response cannot overwrite the next review", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const requested = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const lateFinished = yield* Deferred.make<void>();
        let calls = 0;
        setDefaultModelProvider({
          getModel: () => ({
            getResponse: async () => {
              calls++;
              if (calls === 1) {
                await Effect.runPromise(Deferred.succeed(requested, undefined));
                await Effect.runPromise(Deferred.await(release));
                await Effect.runPromise(Deferred.succeed(lateFinished, undefined));
                return { usage: new Usage(), output: [reason, message()] };
              }
              return { usage: new Usage(), output: calls === 2 ? [call("current")] : [message()] };
            },
            getStreamedResponse: () => {
              throw new Error("Unused stream");
            },
          }),
        });
        const guardian = makeGuardian(
          makeOpenAIReviewer("{{ tenant_policy_config }}", false, native),
          undefined,
          {},
        );
        const old = yield* Effect.forkScoped(guardian.review(pending, readCurrent));
        yield* Deferred.await(requested);
        yield* Fiber.interrupt(old);
        const next = yield* guardian.review(
          { ...pending, screenedInput: '{"next":true}' },
          readCurrent,
        );
        expect(next.decision.outcome).toBe("allow");
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(lateFinished);
        yield* Effect.yieldNow();
        expect(JSON.stringify(guardian.session?.snapshot())).not.toContain(
          "opaque-first-review-reasoning",
        );
        expect(guardian.session?.snapshot().incomplete).toBe(false);
      }),
    ),
  );
});

it("a failed source-result checkpoint ends the review before a model can allow without that result", async () => {
  const requests: ModelRequest[] = [];
  provide([[call("source")], [message()]], requests);
  let refused = false;
  const guardian = makeGuardian(
    makeOpenAIReviewer("{{ tenant_policy_config }}", false, native),
    undefined,
    {
      save: (snapshot) =>
        Effect.suspend(() => {
          if (!refused && JSON.stringify(snapshot.history).includes("function_call_result")) {
            refused = true;
            return Effect.fail(new Error("Synthetic source-result checkpoint failure"));
          }
          return Effect.void;
        }),
    },
  );
  const result = await Effect.runPromise(Effect.either(guardian.review(pending, readCurrent)));
  expect(Either.isLeft(result)).toBe(true);
  expect(requests).toHaveLength(1);
});

it("cancelling the final checkpoint leaves the review incomplete", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const saving = yield* Deferred.make<void>();
        const requests: ModelRequest[] = [];
        provide([[call("current")], [message()]], requests);
        const guardian = makeGuardian(
          makeOpenAIReviewer("{{ tenant_policy_config }}", false, native),
          undefined,
          {
            save: (snapshot) =>
              snapshot.incomplete
                ? Effect.void
                : Deferred.succeed(saving, undefined).pipe(Effect.zipRight(Effect.never)),
          },
        );
        const reviewing = yield* Effect.forkScoped(guardian.review(pending, readCurrent));
        yield* Deferred.await(saving);
        yield* Fiber.interrupt(reviewing);
        expect(guardian.session?.snapshot().incomplete).toBe(true);
      }),
    ),
  );
});

it("preserves a provider quota failure through the Effect session boundary", async () => {
  setDefaultModelProvider({
    getModel: () => ({
      getResponse: async () => {
        throw Object.assign(new Error("Synthetic quota refusal"), { code: "insufficient_quota" });
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  });
  const guardian = makeGuardian(
    makeOpenAIReviewer("{{ tenant_policy_config }}", false, native),
    undefined,
    {},
  );
  const result = await Effect.runPromise(Effect.either(guardian.review(pending, readCurrent)));
  expect(result).toMatchObject({ _tag: "Left", left: { modelQuotaExhausted: true } });
});
