import { makeMintHarnessFixture, readAllow, portableJobSession } from "../support/mint-fixtures.js";
import { portableMintProjection } from "../support/portable-mint.js";
import { solModel } from "../../src/models/models.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Clock, Effect, Either, Fiber, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  MintFailure,
  MintHarnessSnapshot,
  MintRequest,
  MintServices,
} from "../../src/mint/contracts.js";
import type {
  AgentInputRequest,
  ExecutionEvidence,
  MintDependencies,
  MintEntryNavigation,
  MintTurn,
  PublicationDecision,
  PublicationRequest,
} from "../../src/mint/contracts.js";
import { validateAnswer } from "../../src/runtime/input-request.js";
import type { ModelRequest } from "@openai/agents";
import { Deadline } from "../../src/runtime/deadline.js";
import { runMint } from "../../src/mint/harness.js";
import { EventUnavailable } from "../../src/runtime/errors.js";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const clean of cleanup.splice(0)) await clean();
});

const execution = {
  purpose: "example",
  target: "pureFiles",
  entrypoint: "src/tool.ts",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 30,
};

const publication = {
  entrypoint: "src/tool.ts",
  executionId: "execution_one",
  metadata: { name: "invoices", description: "Read invoices" },
  coverage: "One supplied example executed.",
};

const request = {
  mode: "mint",
  intent: "Parse authorized invoices secret-canary",
  businessInput: { body: "secret-canary" },
  observations: [],
};

it("defaults an omitted mint effect to read and preserves explicit write", () => {
  expect(Schema.decodeUnknownSync(MintRequest)(request).effect).toBe("read");
  expect(Schema.decodeUnknownSync(MintRequest)({ ...request, effect: "write" }).effect).toBe(
    "write",
  );
});

const modelInput = (input: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(input);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Expected model input object");
  return Schema.decodeUnknownSync(Schema.Record({ key: Schema.String, value: Schema.Unknown }))(
    parsed,
  );
};

it("reports observed nested, mixed, empty and metadata-named input types without values or counts", async () => {
  const f = await fixture((turn) =>
    Effect.sync(() => {
      const input = modelInput(turn.input);
      expect(input.businessInputTypes).toEqual({
        type: "object",
        fields: {
          emptyArray: { type: "array", elementTypes: [] },
          emptyObject: { type: "object", fields: {} },
          nested: {
            type: "object",
            fields: {
              enabled: { type: "boolean" },
              maybe: { type: "null" },
              names: { type: "array", elementTypes: [{ type: "string" }] },
            },
          },
          type: { type: "number" },
          varied: {
            type: "array",
            elementTypes: [
              { type: "array", elementTypes: [{ type: "boolean" }] },
              { type: "number" },
              { type: "string" },
            ],
          },
        },
      });
      expect(JSON.stringify(input.businessInputTypes)).not.toContain("example-value-canary");
      expect(JSON.stringify(input.businessInputTypes)).not.toContain("length");
    }),
  );
  await f.run({
    ...request,
    businessInput: {
      type: 7,
      nested: { enabled: true, maybe: null, names: ["example-value-canary", "other"] },
      varied: [1, "other", 2, [false]],
      emptyArray: [],
      emptyObject: {},
    },
  });
});

it.each([
  ["string", "private-root-canary"],
  ["number", 3500],
] as const)("reports a root %s input type", async (type, businessInput) => {
  const f = await fixture((turn) =>
    Effect.sync(() => {
      expect(modelInput(turn.input).businessInputTypes).toEqual({ type });
    }),
  );
  await f.run({ ...request, businessInput });
});

it("keeps a prototype-named input field inside the type tree", async () => {
  const f = await fixture((turn) =>
    Effect.sync(() => {
      const tree = modelInput(turn.input).businessInputTypes;
      if (tree === null || typeof tree !== "object" || Array.isArray(tree))
        throw new Error("Expected type tree");
      const fields: unknown = Reflect.get(tree, "fields");
      if (fields === null || typeof fields !== "object" || Array.isArray(fields))
        throw new Error("Expected type fields");
      expect(Object.hasOwn(fields, "__proto__")).toBe(true);
      expect(Reflect.get(fields, "__proto__")).toEqual({ type: "number" });
      expect(Object.getPrototypeOf(fields)).toBe(Object.prototype);
    }),
  );
  const businessInput: unknown = JSON.parse('{"__proto__":1}');
  await f.run({ ...request, businessInput });
});

it.each([Number.POSITIVE_INFINITY, undefined])(
  "rejects non-JSON business input %s before model invocation",
  async (businessInput) => {
    let modelCalls = 0;
    const f = await fixture(() =>
      Effect.sync(() => {
        modelCalls++;
      }),
    );
    const result = await Effect.runPromise(
      Effect.either(
        runMint({ ...request, businessInput }).pipe(
          Effect.provideService(MintServices, f.dependencies),
        ),
      ),
    );
    expect(result).toMatchObject({ _tag: "Left", left: { code: "InvalidRequest" } });
    expect(modelCalls).toBe(0);
  },
);

// A readable model transcript is diagnosis: a copy the host cannot keep is a recorded gap with its
// classification, and the build goes on to publish.
it.each([
  ["diagnostic_storage_failed", "storage"],
  ["screening_failed", "screening"],
  ["serialization_failed", "serialization"],
] as const)(
  "records a readable model transcript the host could not keep (%s) as a gap and keeps building",
  async (event, reason) => {
    const failure = () =>
      new EventUnavailable({
        event,
        ...(event === "diagnostic_storage_failed"
          ? { diagnosticStorageFailure: "transport" as const }
          : {}),
      });
    const f = await fixture(
      (turn) =>
        Effect.gen(function* () {
          yield* turn.reportTrace?.(
            { phase: "model_returned" },
            {
              phase: "model_returned",
              sequence: 0,
              occurredAtUtc: new Date().toISOString(),
              occurredMonotonicMs: performance.now(),
              queueMs: 0,
            },
          ) ?? Effect.void;
          yield* turn.reportTrace?.({ phase: "model_retry" }) ?? Effect.void;
          expect(turn.isComplete()).toBe(false);
          yield* turn.actions.execute(execution);
          yield* turn.actions.finish(publication);
        }),
      {
        diagnostics: {
          retainModelTranscript: () => Effect.fail(failure()),
          emit: (name) => (name === "mint.model" ? Effect.fail(failure()) : Effect.void),
          retainScreenedSource: () => Effect.void,
        },
      },
    );
    const outcome = await f.run();
    expect(outcome).toMatchObject({ build: "published", publicationRef: "published-revision" });
    const gaps = outcome.diagnostics
      .map((entry): unknown => JSON.parse(entry))
      .filter((entry) => typeof entry === "object" && entry !== null && "reason" in entry);
    expect(gaps).toEqual(
      Array(2).fill(
        expect.objectContaining({
          reason: "diagnostic_gap",
          event: "mint.model",
          diagnosticRetentionReason: reason,
        }),
      ),
    );
    expect(JSON.stringify(outcome.diagnostics)).not.toContain("secret-canary");
  },
);

// Diagnostics the host could not keep are recorded gaps, however many: the build goes on, and the
// failed receipt is never replayed or published.
it("keeps building through repeated diagnostic retention failures without replay or publication", async () => {
  let claims = 0;
  let publications = 0;
  let dispatches = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const feedback: unknown = JSON.parse(yield* turn.actions.execute(execution));
        // The agent is told the effect is possible and may continue.
        expect(feedback).toMatchObject({
          status: "diagnostic_unavailable",
          code: "Unavailable",
          diagnosticRetentionReason: "screening",
          retryable: true,
          effect: "possible",
          userInputRequired: false,
        });
        expect(JSON.stringify(feedback)).not.toContain("secret-canary");
        expect(JSON.stringify(feedback)).not.toContain("provider_unavailable");
        expect(turn.isComplete()).toBe(false);
        // The claimed example is never replayed, and its failed receipt cannot be published.
        expect(yield* Effect.either(turn.actions.execute(execution))).toMatchObject({
          _tag: "Left",
          left: { code: "AlreadyExecuted" },
        });
        expect(JSON.parse(yield* turn.actions.finish(publication))).toMatchObject({
          status: "not_published",
        });
        // A second retention failure is a gap too, and the next exploration still runs.
        const explore = { ...execution, purpose: "explore" };
        expect(JSON.parse(yield* turn.actions.execute(explore))).toMatchObject({
          status: "diagnostic_unavailable",
          retryable: true,
        });
        expect(turn.isComplete()).toBe(false);
        expect(JSON.parse(yield* turn.actions.execute(explore))).toMatchObject({
          status: "completed",
        });
        expect(turn.isComplete()).toBe(false);
      }),
    {
      claimExample: Effect.sync(() => {
        claims++;
      }),
      reviewAndExecute: (_input, beforeDispatch = () => Effect.void) =>
        beforeDispatch(readAllow).pipe(
          Effect.zipRight(
            Effect.sync(() => {
              dispatches++;
            }),
          ),
          Effect.zipRight(
            Effect.suspend(() =>
              dispatches > 2
              ? Effect.succeed({
                  executionId: "explore_after_gaps",
                  status: "completed" as const,
                  effect: "verified" as const,
                  observations: "page structure",
                })
              : Effect.fail(
                  Object.assign(
                    new MintFailure({
                      code: "Unavailable",
                      diagnosticRetentionReason: "screening",
                    }),
                    { message: "secret-canary from raw diagnostic" },
                  ),
                ),
            ),
          ),
        ),
      publish: () =>
        Effect.sync(() => {
          publications++;
          return { publicationRef: "unexpected-publication", diagnostics: [] };
        }),
    },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({
    build: "incomplete",
    example: { status: "failed", effect: "possible" },
  });
  expect(outcome.hostFailure).toBeUndefined();
  expect(claims).toBe(1);
  // The example and the two later explorations each reached the host once.
  expect(dispatches).toBe(3);
  expect(publications).toBe(0);
});

it("allows a corrected example after a Guardian deny without consuming its dispatch claim", async () => {
  const outcome = "deny";
  let reviews = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const response = yield* turn.actions.execute(execution);
        expect(JSON.parse(response)).toMatchObject({
          status: "review_rejected",
          code: "ReviewDenied",
          exampleClaimed: false,
          outcome,
        });
        expect(response).toContain("Read the initial controls before selecting a date");
        expect(response).not.toContain("secret-canary");
        expect(JSON.parse(yield* turn.actions.execute(execution))).toMatchObject({
          status: "review_rejected",
        });
      }),
    {
      reviewAndExecute: () =>
        Effect.suspend(() => {
          reviews++;
          return Effect.fail(
            new MintFailure({
              code: "ReviewDenied",
              review: {
                outcome,
                rationale: "Read the initial controls before selecting a date secret-canary",
              },
            }),
          );
        }),
    },
  );
  expect(await f.run()).toMatchObject({ build: "incomplete", example: { effect: "not_sent" } });
  expect(reviews).toBe(2);
});

// A review whose evidence the host could not keep is an ordinary review outage: it is offered back
// for resubmission under the review outage budget, never ended after one more failure.
it.each(["command", "explore", "example", "later_review"] as const)(
  "keeps offering a retry of an unavailable %s review whose evidence was not retained, without renewed example claims",
  async (kind) => {
    let reviews = 0;
    let claims = 0;
    const f = await fixture(
      (turn) =>
        Effect.gen(function* () {
          const submit = (attempt: "first" | "retry") =>
            kind === "command"
              ? Effect.tryPromise({
                  try: async () => {
                    if (!turn.session.execCommand) throw new Error("Missing command tool");
                    return turn.session.execCommand({ cmd: "node --check src/tool.ts" });
                  },
                  catch: () => new MintFailure({ code: "Unavailable" }),
                })
              : turn.actions.execute({
                  ...execution,
                  // A claimed example is never resubmitted; the retry is another execution.
                  purpose:
                    kind === "explore" || (kind === "later_review" && attempt === "retry")
                      ? "explore"
                      : "example",
                });
          for (const attempt of ["first", "retry"] as const) {
            const feedback: unknown = JSON.parse(String(yield* submit(attempt)));
            expect(feedback).toMatchObject({
              status: "review_unavailable",
              code: "ReviewUnavailable",
              reviewFailure: "Unavailable",
              reviewPhase: "diagnostic_retention",
              diagnosticRetentionReason: "storage",
              diagnosticStorageFailure: "unavailable",
              retryable: true,
              userInputRequired: false,
            });
            expect(feedback).not.toHaveProperty("outcome");
            expect(feedback).not.toHaveProperty("retriesRemaining");
            expect(turn.isComplete()).toBe(false);
          }
        }),
      {
        claimExample: Effect.sync(() => {
          claims++;
        }),
        reviewAndExecute: () =>
          Effect.suspend(() => {
            reviews++;
            return Effect.fail(
              new MintFailure({
                code: "ReviewUnavailable",
                reviewFailure: "Unavailable",
                reviewPhase: "diagnostic_retention",
                ...(kind === "later_review" ? {} : { reviewDispatch: "not_sent" as const }),
                diagnosticRetentionReason: "storage",
                diagnosticStorageFailure: "unavailable",
              }),
            );
          }),
      },
    );
    const outcome = await f.run();
    expect(outcome.build).toBe("incomplete");
    expect(outcome.hostFailure).toBeUndefined();
    expect(reviews).toBe(2);
    expect(claims).toBe(kind === "later_review" ? 1 : 0);
    if (kind === "example" || kind === "later_review")
      expect(outcome.example).toMatchObject({
        status: "failed",
        effect: kind === "example" ? "not_sent" : "possible",
      });
    else expect(outcome.example).toBeUndefined();
    expect(JSON.stringify(outcome.diagnostics)).toContain("ReviewUnavailable");
    expect(JSON.stringify(outcome.diagnostics)).toContain("storage");
  },
);

/** A clock the test moves by hand; sleeps still take real time. */
const steppedClock = (startMs = 1_000_000) => {
  const base = Clock.make();
  let now = startMs;
  const clock: Clock.Clock = {
    [Clock.ClockTypeId]: Clock.ClockTypeId,
    unsafeCurrentTimeMillis: () => now,
    unsafeCurrentTimeNanos: () => BigInt(now) * 1_000_000n,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    sleep: (duration) => base.sleep(duration),
  };
  return {
    clock,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

// One review outage budget serves execution review, publication review and the registry: each
// outage may be resubmitted until it outlasts the budget, which then ends the attempt.
it.each([
  {
    kind: "execution review",
    exampleFirst: false,
    call: (turn: MintTurn) => turn.actions.execute({ ...execution, purpose: "explore" }),
    failure: new MintFailure({
      code: "ReviewUnavailable",
      reviewFailure: "Unavailable",
      reviewDispatch: "not_sent",
    }),
    // An unavailable review is not a deny: the agent is told nothing was sent.
    retry: { status: "review_unavailable", reviewDispatch: "not_sent", retryable: true },
    exhausted: { status: "review_unavailable" },
  },
  {
    kind: "publication review",
    exampleFirst: true,
    call: (turn: MintTurn) => turn.actions.finish(publication),
    failure: new MintFailure({ code: "ReviewUnavailable", reviewFailure: "Unavailable" }),
    retry: { status: "review_unavailable", reviewFailure: "Unavailable", retryable: true },
    exhausted: { status: "review_unavailable" },
  },
  {
    kind: "registry",
    exampleFirst: true,
    call: (turn: MintTurn) => turn.actions.finish(publication),
    failure: new MintFailure({ code: "PublicationUnavailable", reason: "registry_unavailable" }),
    retry: { status: "not_published", reason: "registry_unavailable", retryable: true },
    exhausted: { status: "not_published", reason: "registry_unavailable", retryable: false },
  },
  {
    kind: "execution review whose evidence was not retained",
    exampleFirst: false,
    call: (turn: MintTurn) => turn.actions.execute({ ...execution, purpose: "explore" }),
    failure: new MintFailure({
      code: "ReviewUnavailable",
      reviewFailure: "Unavailable",
      reviewPhase: "diagnostic_retention",
      reviewDispatch: "not_sent",
      diagnosticRetentionReason: "storage",
    }),
    retry: { status: "review_unavailable", reviewPhase: "diagnostic_retention", retryable: true },
    exhausted: { status: "review_unavailable" },
  },
  // A screening service the publication needed stayed unavailable, so nothing names a file to fix.
  ...(
    [
      "source_screening",
      "schema_screening",
      "evidence_screening",
      "source_read",
    ] as const
  ).map((reason) => ({
    kind: `publication ${reason}`,
    exampleFirst: true,
    call: (turn: MintTurn) => turn.actions.finish(publication),
    failure: new MintFailure({ code: "PublicationUnavailable", reason }),
    retry: { status: "not_published", reason, retryable: true },
    exhausted: { status: "not_published", reason, retryable: false },
  })),
  {
    kind: "publication capture",
    exampleFirst: true,
    call: (turn: MintTurn) => turn.actions.finish(publication),
    failure: new MintFailure({ code: "CaptureUnavailable" }),
    retry: { status: "not_published", code: "CaptureUnavailable", retryable: true },
    exhausted: { status: "not_published", code: "CaptureUnavailable", retryable: false },
  },
])(
  "offers a retry through a $kind outage until it outlasts its budget, then ends",
  async ({ exampleFirst, call, failure, retry, exhausted }) => {
    const time = steppedClock();
    let calls = 0;
    const failing = () =>
      Effect.suspend(() => {
        calls++;
        return Effect.fail(failure);
      });
    const f = await fixture(
      (turn) =>
        Effect.gen(function* () {
          if (exampleFirst) yield* turn.actions.execute(execution);
          // 0, 4, 8 and 12 minutes into the outage are inside its 15 minutes.
          for (let resubmission = 0; resubmission < 4; resubmission++) {
            expect(JSON.parse(yield* call(turn))).toMatchObject(retry);
            expect(turn.isComplete()).toBe(false);
            time.advance(4 * 60_000);
          }
          const ended: unknown = JSON.parse(yield* call(turn));
          expect(ended).toMatchObject(exhausted);
          if (!("retryable" in exhausted)) expect(ended).not.toHaveProperty("retryable");
          expect(turn.isComplete()).toBe(true);
          if (exampleFirst)
            expect(yield* Effect.either(turn.actions.finish(publication))).toMatchObject({
              _tag: "Left",
              left: { code: "AlreadyExecuted" },
            });
        }).pipe(Effect.withClock(time.clock)),
      exampleFirst ? { publish: failing } : { reviewAndExecute: failing },
    );
    expect(await f.run()).toMatchObject({
      build: "incomplete",
      ...(exampleFirst ? { example: { effect: "verified", resultRef: "private-result-ref" } } : {}),
    });
    expect(calls).toBe(5);
  },
);

// A review request over Guardian's model input limit fails the same way when resubmitted, so it
// ends the attempt at once instead of offering resubmissions until the outage budget runs out.
it.each([
  {
    kind: "execution review",
    exampleFirst: false,
    call: (turn: MintTurn) => turn.actions.execute({ ...execution, purpose: "explore" }),
    failure: new MintFailure({
      code: "ReviewUnavailable",
      reviewFailure: "InputTooLarge",
      reviewPhase: "review_computation",
      reviewDispatch: "not_sent",
    }),
  },
  {
    kind: "publication review",
    exampleFirst: true,
    call: (turn: MintTurn) => turn.actions.finish(publication),
    failure: new MintFailure({
      code: "ReviewUnavailable",
      reviewFailure: "InputTooLarge",
      reviewPhase: "review_computation",
    }),
  },
])(
  "ends the attempt on a $kind over the model's input limit, without offering a retry",
  async ({ exampleFirst, call, failure }) => {
    let calls = 0;
    const failing = () =>
      Effect.suspend(() => {
        calls++;
        return Effect.fail(failure);
      });
    const f = await fixture(
      (turn) =>
        Effect.gen(function* () {
          if (exampleFirst) yield* turn.actions.execute(execution);
          const ended: unknown = JSON.parse(yield* call(turn));
          expect(ended).toMatchObject({
            status: "review_unavailable",
            reviewFailure: "InputTooLarge",
          });
          expect(ended).not.toHaveProperty("retryable");
          expect(turn.isComplete()).toBe(true);
        }),
      exampleFirst ? { publish: failing } : { reviewAndExecute: failing },
    );
    expect(await f.run()).toMatchObject({
      build: "incomplete",
      hostFailure: "review_unavailable",
    });
    expect(calls).toBe(1);
  },
);

// An older checkpoint still carries the retired retention counter; a takeover restores it.
it("decodes an older harness checkpoint that still carries its retention counter", () => {
  const checkpoint = {
    executions: [],
    purposes: [],
    diagnostics: [],
    exampleClaimed: false,
    writeSession: "none",
    unavailableOutputRefusals: 0,
    unavailableCauseRecorded: false,
    reviewUnavailableRetries: { execution: 0, publication: 0, question: 0 },
    destinationEvidenceRefusals: 0,
    inputFeedbackRounds: 0,
    inputFeedbackPublicTool: false,
    inputFeedbackCoverage: "",
    providerUnavailableRetries: 0,
    diagnosticRetentionRetries: 1,
    executionClosed: false,
    captchaChecks: 0,
  };
  expect(Schema.decodeUnknownSync(MintHarnessSnapshot)(checkpoint)).toMatchObject({
    exampleClaimed: false,
    writeSession: "none",
  });
});

// A takeover can cross releases: an older worker's schema requires the retired counter, so a new
// checkpoint still carries it, as 0 whatever retention gaps the attempt recorded.
it("writes the retired retention counter on a new checkpoint for an older worker", async () => {
  let capture: (() => MintHarnessSnapshot) | undefined;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
      }),
    {
      agentRecovery: {
        bindHarness: (bound) =>
          Effect.sync(() => {
            capture = bound;
          }),
        save: () => Effect.void,
      },
      reviewAndExecute: () =>
        Effect.fail(new MintFailure({ code: "Unavailable", diagnosticRetentionReason: "storage" })),
    },
  );
  await f.run();
  const snapshot = capture?.();
  expect(snapshot?.diagnosticRetentionRetries).toBe(0);
  // An older worker's decoder, which requires the counter, restores it.
  const olderDecoder = Schema.Struct({ diagnosticRetentionRetries: Schema.NonNegativeInt });
  expect(Schema.decodeUnknownSync(olderDecoder)(snapshot)).toEqual({
    diagnosticRetentionRetries: 0,
  });
  expect(Schema.decodeUnknownSync(MintHarnessSnapshot)(snapshot)).toMatchObject({
    diagnosticRetentionRetries: 0,
  });
});

const blockedReport = { reason: "site_lacks_capability", explanation: "The site has no such form." };
const freshAgent = {
  version: 1,
  sdkVersion: "0.18.0",
  sdkState: "",
  modelCalls: 0,
  finalsWithoutTool: 0,
  tools: [],
} as const;
const unavailableReview = () =>
  Effect.fail(new MintFailure({ code: "ReviewUnavailable", reviewFailure: "Unavailable" }));

// Failure mode: a review asked for a source correction after the host had ended live execution,
// so the fresh example it needed could never run, and the minter's only ending was a policy block
// that misreported a host fault. host_unavailable ends the attempt as the host's failure.
it("ends as the host's failure when the minter reports the host gone", async () => {
  let hostDown = false;
  let questionReviews = 0;
  const replies: unknown[] = [];
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const reportBlocked = turn.actions.reportBlocked;
        if (reportBlocked === undefined) throw new Error("Missing report_blocked");
        const report = {
          reason: "host_unavailable",
          explanation: "The host ended live execution before the corrected example could run.",
        };
        replies.push(JSON.parse(yield* reportBlocked(report)));
        yield* turn.actions.execute(execution);
        hostDown = true;
        replies.push(JSON.parse(yield* reportBlocked(report)));
      }),
    {
      executionAvailability: () => (hostDown ? "host_unavailable" : "open"),
      reviewQuestion: () =>
        Effect.sync(() => {
          questionReviews++;
          return { outcome: "allow_business" as const, rationale: "Plain." };
        }),
    },
  );
  const outcome = await f.run();
  expect(replies).toEqual([
    expect.objectContaining({ status: "blocked_refused", reason: "host_available" }),
    expect.objectContaining({ status: "host_unavailable" }),
  ]);
  expect(outcome).toMatchObject({ build: "incomplete", hostFailure: "host_unavailable" });
  expect(outcome.blocked).toBeUndefined();
  expect(questionReviews).toBe(0);
});

// The blocked explanation's decision ledger stays bounded however many denials the attempt had:
// the latest ones, each rationale capped, and a count of the rest.
it("bounds the decision ledger a blocked explanation's review reads", async () => {
  const ledgers: unknown[] = [];
  let denials = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        for (let index = 0; index < 15; index++)
          yield* turn.actions.execute({ ...execution, purpose: "explore" });
        const reportBlocked = turn.actions.reportBlocked;
        if (reportBlocked === undefined) throw new Error("Missing report_blocked");
        yield* reportBlocked({ reason: "policy", explanation: "Guardian refused every attempt." });
      }),
    {
      reviewAndExecute: () =>
        Effect.fail(
          new MintFailure({
            code: "ReviewDenied",
            review: { outcome: "deny", rationale: `Denial ${++denials}. ${"x".repeat(2_000)}` },
          }),
        ),
      reviewQuestion: (_request, options) =>
        Effect.sync(() => {
          ledgers.push(options?.decisionLedger);
          return { outcome: "allow_business" as const, rationale: "Consistent." };
        }),
    },
  );
  await f.run();
  const ledger = ledgers[0] as {
    denials: { rationale: string }[];
    omittedDenials?: number;
  };
  expect(ledger.omittedDenials).toBe(3);
  expect(ledger.denials).toHaveLength(12);
  expect(ledger.denials[0]?.rationale.startsWith("Denial 4.")).toBe(true);
  expect(ledger.denials.at(-1)?.rationale.startsWith("Denial 15.")).toBe(true);
  expect(Math.max(...ledger.denials.map(({ rationale }) => rationale.length))).toBeLessThanOrEqual(
    800,
  );
});

/**
 * The decision ledger a takeover's blocked review reads after its predecessor's execution was
 * denied, from the predecessor's checkpoint as `edit` leaves it.
 */
const ledgerAfterTakeover = async (edit: (checkpoint: Record<string, unknown>) => void) => {
  let capture: (() => MintHarnessSnapshot) | undefined;
  const first = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute({ ...execution, purpose: "explore" });
      }),
    {
      reviewAndExecute: () =>
        Effect.fail(
          new MintFailure({
            code: "ReviewDenied",
            review: { outcome: "deny", rationale: "The call creates server-side state." },
          }),
        ),
      agentRecovery: {
        bindHarness: (bound) =>
          Effect.sync(() => {
            capture = bound;
          }),
        save: () => Effect.void,
      },
    },
  );
  await first.run();
  const checkpoint = JSON.parse(JSON.stringify(capture?.())) as Record<string, unknown>;
  edit(checkpoint);
  const harness = Schema.decodeUnknownSync(MintHarnessSnapshot)(checkpoint);
  const ledgers: unknown[] = [];
  const takeover = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const reportBlocked = turn.actions.reportBlocked;
        if (reportBlocked === undefined) throw new Error("Missing report_blocked");
        yield* reportBlocked({ reason: "policy", explanation: "Guardian refused the call." });
      }),
    {
      reviewQuestion: (_request, options) =>
        Effect.sync(() => {
          ledgers.push(options?.decisionLedger);
          return { outcome: "allow_business" as const, rationale: "Consistent." };
        }),
      agentRecovery: { initial: { agent: freshAgent, harness }, save: () => Effect.void },
    },
  );
  await takeover.run();
  return ledgers;
};

// A takeover's blocked review read an empty ledger as host evidence that nothing was denied,
// though its predecessor's execution was.
it("keeps the decision ledger's denials across a takeover", async () => {
  const ledgers = await ledgerAfterTakeover(() => undefined);
  expect(ledgers).toEqual([
    {
      denials: [
        expect.objectContaining({
          review: "execution",
          outcome: "deny",
          rationale: "The call creates server-side state.",
        }),
      ],
      testFailures: [],
    },
  ]);
});

// A checkpoint from an older worker kept no ledger, so a missing denial there proves nothing.
it("marks the decision ledger partial after a takeover from a checkpoint without one", async () => {
  const ledgers = await ledgerAfterTakeover((checkpoint) => {
    delete checkpoint["decisionLedger"];
  });
  expect(ledgers).toEqual([{ partial: true, denials: [], testFailures: [] }]);
});

const hostCheckRefusal = new MintFailure({
  code: "PublicationUnavailable",
  reason: "autofill_recipe_not_verified",
});
/**
 * The reply to a takeover's host_refused report after its predecessor finished once per publish
 * decision in `decisions`, in order, from the predecessor's checkpoint as `edit` leaves it.
 */
const hostRefusedAfterTakeover = async (
  edit: (checkpoint: Record<string, unknown>) => void,
  decisions: readonly MintFailure[] = [hostCheckRefusal],
) => {
  let capture: (() => MintHarnessSnapshot) | undefined;
  let published = 0;
  const first = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        for (const _ of decisions) yield* turn.actions.finish(publication);
      }),
    {
      publish: () => Effect.fail(decisions[published++] ?? hostCheckRefusal),
      agentRecovery: {
        bindHarness: (bound) =>
          Effect.sync(() => {
            capture = bound;
          }),
        save: () => Effect.void,
      },
    },
  );
  await first.run();
  const checkpoint = JSON.parse(JSON.stringify(capture?.())) as Record<string, unknown>;
  edit(checkpoint);
  const harness = Schema.decodeUnknownSync(MintHarnessSnapshot)(checkpoint);
  const replies: unknown[] = [];
  const takeover = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const reportBlocked = turn.actions.reportBlocked;
        if (reportBlocked === undefined) throw new Error("Missing report_blocked");
        replies.push(
          JSON.parse(
            yield* reportBlocked({
              reason: "host_refused",
              explanation: "Publication's sign-in check failed on a new browser.",
            }),
          ),
        );
      }),
    { agentRecovery: { initial: { agent: freshAgent, harness }, save: () => Effect.void } },
  );
  await takeover.run();
  return replies;
};

// A host check's refusal is the host's own record, so a takeover keeps it; a checkpoint from an
// older worker, which kept none, grants no host_refused ending.
it.each([
  { checkpoint: "this worker's", edit: () => undefined, status: "blocked" },
  {
    checkpoint: "an older worker's",
    edit: (checkpoint: Record<string, unknown>) => {
      delete checkpoint["hostRefused"];
    },
    status: "blocked_refused",
  },
])("keeps a host refusal across a takeover from $checkpoint checkpoint", async ({ edit, status }) => {
  expect(await hostRefusedAfterTakeover(edit)).toEqual([expect.objectContaining({ status })]);
});

// A host refusal a later finish_build got past to Guardian's review stays cleared after a takeover,
// so the takeover refuses host_refused as the build that cleared it did.
it("keeps a host refusal a later finish_build got past cleared across a takeover", async () => {
  const kept: Record<string, unknown>[] = [];
  const replies = await hostRefusedAfterTakeover(
    (checkpoint) => {
      kept.push({ ...checkpoint });
    },
    [
      new MintFailure({ code: "PublicationUnavailable", reason: "variants_unsupported" }),
      new MintFailure({
        code: "ReviewDenied",
        review: {
          outcome: "deny",
          reason: "source_correction",
          reviewId: "review_correction",
          rationale: "Read the total from the invoice table.",
          findings: [],
        },
      }),
    ],
  );
  expect(kept[0]).not.toHaveProperty("hostRefused");
  expect(kept[0]).toHaveProperty("hostRefusalPassed", true);
  expect(replies).toEqual([
    expect.objectContaining({ status: "blocked_refused", reason: "host_refusal_passed" }),
  ]);
});

// A takeover reads the latest host refusal from the checkpoint's sources, so one whose instruction
// names its fix still sends the first host_refused report back to that step. A checkpoint from an
// older worker, which kept the refusal without its source, decodes as before and grants the ending.
it.each([
  {
    checkpoint: "this worker's",
    edit: () => undefined,
    reply: { status: "blocked_refused", reason: "host_refusal_names_step" },
  },
  {
    checkpoint: "an older worker's",
    edit: (checkpoint: Record<string, unknown>) => {
      delete checkpoint["hostRefusalSources"];
    },
    reply: { status: "blocked" },
  },
  // A sign-in screen the host refused at its destination check stands beside the named step, so
  // the report is taken at once.
  {
    checkpoint: "this worker's, with a sign-in screen refused at its destination,",
    edit: (checkpoint: Record<string, unknown>) => {
      checkpoint["signInDestinationRefused"] = true;
    },
    reply: { status: "blocked" },
  },
])(
  "sends host_refused back to a named step across a takeover from $checkpoint checkpoint",
  async ({ edit, reply }) => {
    const replies = await hostRefusedAfterTakeover(edit, [
      new MintFailure({ code: "PublicationUnavailable", reason: "variants_unsupported" }),
    ]);
    expect(replies).toEqual([expect.objectContaining(reply)]);
  },
);

/**
 * The reply to a takeover's site_declined report after its predecessor sent a sign-in that nothing
 * confirmed, from the predecessor's checkpoint as `edit` leaves it.
 */
const declinedAfterUnconfirmedSignIn = async (
  edit: (checkpoint: Record<string, unknown>) => void,
  signIn: MintDependencies["reviewAndExecute"] = () =>
    Effect.succeed({
      executionId: "sign_in_screen",
      status: "completed" as const,
      effect: "possible" as const,
      resultRef: "screen_result",
      observations: { step: { outcome: "filled", submit: "clicked" } },
    }),
) => {
  let capture: (() => MintHarnessSnapshot) | undefined;
  const first = await fixture(
    (turn) => turn.actions.execute({ ...execution, purpose: "authenticate", target: "liveBrowser" }),
    {
      reviewAndExecute: signIn,
      agentRecovery: {
        bindHarness: (bound) =>
          Effect.sync(() => {
            capture = bound;
          }),
        save: () => Effect.void,
      },
    },
  );
  await first.run();
  const checkpoint = JSON.parse(JSON.stringify(capture?.())) as Record<string, unknown>;
  edit(checkpoint);
  const harness = Schema.decodeUnknownSync(MintHarnessSnapshot)(checkpoint);
  const replies: unknown[] = [];
  const takeover = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const reportBlocked = turn.actions.reportBlocked;
        if (reportBlocked === undefined) throw new Error("Missing report_blocked");
        replies.push(
          JSON.parse(
            yield* reportBlocked({
              reason: "site_declined",
              explanation: "The site kept showing its sign-in screen.",
            }),
          ),
        );
      }),
    { agentRecovery: { initial: { agent: freshAgent, harness }, save: () => Effect.void } },
  );
  await takeover.run();
  return replies;
};

// The sign-in a predecessor sent and nothing confirmed is still unconfirmed after a takeover, so
// the site still never judged the task; a checkpoint from an older worker, which kept none, leaves
// the report as it was.
it.each([
  { checkpoint: "this worker's", edit: () => undefined, status: "sign_in_unavailable" },
  {
    checkpoint: "an older worker's",
    edit: (checkpoint: Record<string, unknown>) => {
      delete checkpoint["signInUnconfirmed"];
    },
    status: "blocked",
  },
])(
  "keeps an unconfirmed sign-in across a takeover from $checkpoint checkpoint",
  async ({ edit, status }) => {
    expect(await declinedAfterUnconfirmedSignIn(edit)).toEqual([
      expect.objectContaining({ status }),
    ]);
  },
);

// Guardian's final refusal of a predecessor's sign-in still stands alone after a takeover; a
// checkpoint from an older worker, which kept no such record, leaves the report as it was.
it.each([
  { checkpoint: "this worker's", edit: () => undefined, status: "sign_in_unavailable" },
  {
    checkpoint: "an older worker's",
    edit: (checkpoint: Record<string, unknown>) => {
      delete checkpoint["signInRefusalOnly"];
    },
    status: "blocked",
  },
])(
  "keeps a refused sign-in across a takeover from $checkpoint checkpoint",
  async ({ edit, status }) => {
    const refused = () =>
      Effect.fail(
        new MintFailure({
          code: "ReviewDenied",
          review: {
            outcome: "deny",
            reviewId: "review_sign_in",
            rationale: "This sign-in may not run.",
            refusal: "final",
          },
        }),
      );
    expect(await declinedAfterUnconfirmedSignIn(edit, refused)).toEqual([
      expect.objectContaining({ status }),
    ]);
  },
);

// A takeover in the middle of a blocked explanation's review outage keeps it resubmittable, so the
// build can still end blocked instead of looping on the refusal until it runs out of calls.
it("ends blocked after a takeover during a blocked explanation's review outage", async () => {
  let capture: (() => MintHarnessSnapshot) | undefined;
  const first = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const reportBlocked = turn.actions.reportBlocked;
        if (reportBlocked === undefined) throw new Error("Missing report_blocked");
        expect(JSON.parse(yield* reportBlocked(blockedReport))).toMatchObject({
          status: "review_unavailable",
          retryable: true,
        });
      }),
    {
      reviewQuestion: unavailableReview,
      agentRecovery: {
        bindHarness: (bound) =>
          Effect.sync(() => {
            capture = bound;
          }),
        save: () => Effect.void,
      },
    },
  );
  await first.run();
  const harness = Schema.decodeUnknownSync(MintHarnessSnapshot)(
    JSON.parse(JSON.stringify(capture?.())),
  );
  const replies: unknown[] = [];
  const takeover = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const reportBlocked = turn.actions.reportBlocked;
        if (reportBlocked === undefined) throw new Error("Missing report_blocked");
        replies.push(JSON.parse(yield* reportBlocked(blockedReport)));
      }),
    {
      reviewQuestion: () =>
        Effect.succeed({ outcome: "allow_business" as const, rationale: "Plain." }),
      agentRecovery: { initial: { agent: freshAgent, harness }, save: () => Effect.void },
    },
  );
  const outcome = await takeover.run();
  expect(replies).toEqual([expect.objectContaining({ status: "blocked" })]);
  expect(outcome.blocked).toEqual(blockedReport);
});

// A checkpoint from an older worker has no record of whose outage it was; once the outage budget
// is spent, report_blocked still goes through and ends blocked with the reason's fixed sentence.
it("lets report_blocked end blocked once a review outage outlasts its budget", async () => {
  const time = steppedClock();
  const start = Effect.runSync(time.clock.currentTimeMillis);
  const harness: MintHarnessSnapshot = {
    executions: [],
    purposes: [],
    diagnostics: [],
    exampleClaimed: false,
    writeSession: "none",
    unavailableOutputRefusals: 0,
    unavailableCauseRecorded: false,
    reviewUnavailableRetries: { execution: 0, publication: 0, question: 1 },
    reviewOutageStartedAt: start - 20 * 60_000,
    destinationEvidenceRefusals: 0,
    inputFeedbackRounds: 0,
    inputFeedbackPublicTool: false,
    inputFeedbackCoverage: "",
    providerUnavailableRetries: 0,
    executionClosed: false,
    captchaChecks: 0,
  };
  const takeover = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const reportBlocked = turn.actions.reportBlocked;
        if (reportBlocked === undefined) throw new Error("Missing report_blocked");
        expect(JSON.parse(yield* reportBlocked(blockedReport))).toMatchObject({
          status: "blocked",
          explanationShown: false,
        });
      }).pipe(Effect.withClock(time.clock)),
    {
      reviewQuestion: unavailableReview,
      agentRecovery: { initial: { agent: freshAgent, harness }, save: () => Effect.void },
    },
  );
  expect((await takeover.run()).blocked).toEqual({ reason: "site_lacks_capability" });
});

// A blocked explanation whose review request is over Guardian's model input limit would fail the
// same way when resubmitted, so report_blocked ends blocked with the reason alone, as past the
// outage budget.
it("lets report_blocked end blocked when its review is over the model's input limit", async () => {
  let reviews = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const reportBlocked = turn.actions.reportBlocked;
        if (reportBlocked === undefined) throw new Error("Missing report_blocked");
        expect(JSON.parse(yield* reportBlocked(blockedReport))).toMatchObject({
          status: "blocked",
          explanationShown: false,
        });
      }),
    {
      reviewQuestion: () =>
        Effect.suspend(() => {
          reviews++;
          return Effect.fail(
            new MintFailure({ code: "ReviewUnavailable", reviewFailure: "InputTooLarge" }),
          );
        }),
    },
  );
  expect((await f.run()).blocked).toEqual({ reason: "site_lacks_capability" });
  expect(reviews).toBe(1);
});

// Another review's outage is not the blocked explanation's: resubmit that call first.
it("refuses report_blocked again once a different review hits an outage", async () => {
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const reportBlocked = turn.actions.reportBlocked;
        if (reportBlocked === undefined) throw new Error("Missing report_blocked");
        expect(JSON.parse(yield* reportBlocked(blockedReport))).toMatchObject({
          status: "review_unavailable",
        });
        expect(
          JSON.parse(yield* turn.actions.execute({ ...execution, purpose: "explore" })),
        ).toMatchObject({ status: "review_unavailable" });
        expect(JSON.parse(yield* reportBlocked(blockedReport))).toMatchObject({
          status: "blocked_refused",
          reason: "review_unavailable_pending",
        });
      }),
    {
      reviewQuestion: unavailableReview,
      reviewAndExecute: () =>
        Effect.fail(
          new MintFailure({
            code: "ReviewUnavailable",
            reviewFailure: "Unavailable",
            reviewDispatch: "not_sent",
          }),
        ),
    },
  );
  expect((await f.run()).blocked).toBeUndefined();
});

// A source path the host refused to publish, such as one holding a credential, is the minter's to
// fix: never an outage to retry until its budget ends the build.
it("keeps a path screening refusal fixable, never a retryable outage", async () => {
  const time = steppedClock();
  let publications = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        for (let attempt = 0; attempt < 2; attempt++) {
          const refused: unknown = JSON.parse(yield* turn.actions.finish(publication));
          expect(refused).toMatchObject({ status: "not_published", reason: "path_screening" });
          expect(refused).not.toHaveProperty("retryable", true);
          expect(turn.isComplete()).toBe(false);
          time.advance(20 * 60_000);
        }
      }).pipe(Effect.withClock(time.clock)),
    {
      publish: () =>
        Effect.suspend(() => {
          publications++;
          return Effect.fail(
            new MintFailure({ code: "PublicationUnavailable", reason: "path_screening" }),
          );
        }),
    },
  );
  const outcome = await f.run();
  expect(outcome.hostFailure).toBeUndefined();
  expect(publications).toBe(2);
});

// A completed review starts the outage budget again; a host refusal that reaches no review does not.
it("restarts the review outage budget only when a review completes", async () => {
  const time = steppedClock();
  let calls = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const explore = {
          ...execution,
          purpose: "explore" as const,
          target: "liveBrowser" as const,
        };
        // 0: an outage. 8: a review completes. 16: another outage, inside a new budget.
        // 24: a refusal before any review. 32: sixteen minutes of outage end the attempt.
        for (const expected of [
          "review_unavailable",
          "completed",
          "review_unavailable",
          "unsupported",
        ]) {
          expect(JSON.parse(yield* turn.actions.execute(explore))).toMatchObject({
            status: expected,
          });
          expect(turn.isComplete()).toBe(false);
          time.advance(8 * 60_000);
        }
        yield* turn.actions.execute(explore);
        expect(turn.isComplete()).toBe(true);
      }).pipe(Effect.withClock(time.clock)),
    {
      reviewAndExecute: () =>
        Effect.suspend((): Effect.Effect<ExecutionEvidence, MintFailure> => {
          calls++;
          if (calls === 2)
            return Effect.succeed({
              executionId: "explore_one",
              status: "completed" as const,
              effect: "verified" as const,
              observations: "page structure",
            });
          if (calls === 4)
            return Effect.succeed({
              executionId: "refused_one",
              status: "unsupported" as const,
              effect: "not_sent" as const,
              observations: "The host refused this step before review.",
            });
          return Effect.fail(
            new MintFailure({
              code: "ReviewUnavailable",
              reviewFailure: "Unavailable",
              reviewDispatch: "not_sent",
            }),
          );
        }),
    },
  );
  expect(await f.run()).toMatchObject({ build: "incomplete", hostFailure: "review_unavailable" });
  expect(calls).toBe(5);
});

it("publishes the finished example after an unavailable publication review recovers", async () => {
  let publications = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        expect(JSON.parse(yield* turn.actions.finish(publication))).toMatchObject({
          status: "review_unavailable",
          retryable: true,
        });
        yield* turn.actions.finish(publication);
        expect(turn.isComplete()).toBe(true);
      }),
    {
      publish: () =>
        Effect.suspend(() =>
          publications++ === 0
            ? Effect.fail(
                new MintFailure({ code: "ReviewUnavailable", reviewFailure: "TurnLimitExceeded" }),
              )
            : Effect.succeed({ publicationRef: "published-after-retry", diagnostics: [] }),
        ),
    },
  );
  expect(await f.run()).toMatchObject({
    build: "published",
    publicationRef: "published-after-retry",
  });
  expect(publications).toBe(2);
  expect(f.seen).toHaveLength(1);
});

// An execution whose capture the host could not produce or screen is a capture gap: its result is
// withheld, its effect is possible, and the build goes on without replaying it.
it("keeps the build open when an execution's capture is unavailable", async () => {
  let dispatches = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const explore = { ...execution, purpose: "explore", target: "liveBrowser" };
        const withheld: unknown = JSON.parse(yield* turn.actions.execute(explore));
        expect(withheld).toMatchObject({
          status: "execution_unavailable",
          code: "CaptureUnavailable",
          captureGap: "capture_publication",
          userInputRequired: false,
        });
        expect(turn.isComplete()).toBe(false);
        expect(JSON.parse(yield* turn.actions.execute(explore))).toMatchObject({
          status: "completed",
        });
        yield* turn.actions.execute(execution);
        yield* turn.actions.finish(publication);
      }),
    {
      executionAvailability: () => "open",
      reviewAndExecute: (_input, beforeDispatch = () => Effect.void) =>
        beforeDispatch(readAllow).pipe(
          Effect.zipRight(
            Effect.suspend(() =>
              ++dispatches === 1
                ? Effect.fail(new MintFailure({ code: "CaptureUnavailable" }))
                : Effect.succeed({
                    executionId: dispatches === 2 ? "explore_two" : "execution_one",
                    status: "completed" as const,
                    effect: "verified" as const,
                    resultRef: "private-result-ref",
                    observations: "page structure",
                  }),
            ),
          ),
        ),
    },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({ build: "published", publicationRef: "published-revision" });
  expect(outcome.hostFailure).toBeUndefined();
  expect(dispatches).toBe(3);
});

it("keeps the build open when publication's capture evidence is unavailable, then publishes", async () => {
  let publications = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        expect(JSON.parse(yield* turn.actions.finish(publication))).toMatchObject({
          status: "not_published",
          code: "CaptureUnavailable",
          retryable: true,
          userInputRequired: false,
        });
        expect(turn.isComplete()).toBe(false);
        yield* turn.actions.finish(publication);
      }),
    {
      publish: () =>
        Effect.suspend(() =>
          publications++ === 0
            ? Effect.fail(new MintFailure({ code: "CaptureUnavailable" }))
            : Effect.succeed({ publicationRef: "published-after-capture", diagnostics: [] }),
        ),
    },
  );
  expect(await f.run()).toMatchObject({
    build: "published",
    publicationRef: "published-after-capture",
  });
  expect(publications).toBe(2);
  // The example ran once; publication never reran it to regenerate capture.
  expect(f.seen).toHaveLength(1);
});

// A host that publishes on the site's own no (`publishOnRefusal`) marks the session's
// `write_not_submitted` refusal, and the minter hears how to publish on that no instead of only
// being told to continue the write; an unmarked refusal keeps today's instruction.
it("tells the minter how to publish on the site's own no only when the host publishes on one", async () => {
  const answers: unknown[] = [];
  let publications = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        answers.push(JSON.parse(yield* turn.actions.finish(publication)));
        answers.push(JSON.parse(yield* turn.actions.finish(publication)));
        answers.push(JSON.parse(yield* turn.actions.finish(publication)));
      }),
    {
      publish: () =>
        Effect.suspend(() =>
          publications++ < 2
            ? Effect.fail(
                new MintFailure({
                  code: "PublicationUnavailable",
                  reason: "write_not_submitted",
                  ...(publications === 1 ? { publishesOnRefusal: true as const } : {}),
                }),
              )
            : Effect.succeed({ publicationRef: "published-revision", diagnostics: [] }),
        ),
    },
  );
  expect(await f.run()).toMatchObject({ build: "published" });
  const [marked = "", unmarked = ""] = answers.map((answer) =>
    String(Reflect.get(Object(answer), "instruction")),
  );
  expect(marked).toContain("write.commitsUnproven");
  expect(unmarked).not.toContain("write.commitsUnproven");
  // Past the added rule, both say the same.
  expect(marked.endsWith(unmarked.slice(unmarked.indexOf(" the remaining authorized work")))).toBe(
    true,
  );
});

// Each publication decision reaches the host as typed evidence, and the minter's answer names it.
it("records each publication decision, refused and published, through the host's hook", async () => {
  const recorded: PublicationDecision[] = [];
  const answers: unknown[] = [];
  let publications = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        answers.push(JSON.parse(yield* turn.actions.finish(publication)));
        answers.push(JSON.parse(yield* turn.actions.finish(publication)));
      }),
    {
      publicationDecisions: {
        record: (decision) =>
          Effect.sync(() => {
            recorded.push(decision);
          }),
        list: Effect.sync(() => recorded),
      },
      publish: () =>
        Effect.suspend(() =>
          publications++ === 0
            ? Effect.fail(
                new MintFailure({
                  code: "PublicationUnavailable",
                  reason: "write_not_submitted",
                }),
              )
            : Effect.succeed({ publicationRef: "published-revision", diagnostics: [] }),
        ),
    },
  );
  expect(await f.run()).toMatchObject({ build: "published" });
  expect(recorded).toEqual([
    {
      decisionId: expect.any(String),
      outcome: "refused",
      code: "PublicationUnavailable",
      reason: "write_not_submitted",
      executionId: "execution_one",
      decidedAt: expect.any(Number),
      failedChecks: ["write_not_submitted"],
      recovery: "write_completion",
      // Whole, so a review reads the instruction's last step too.
      instruction: Reflect.get(Object(answers[0]), "instruction"),
    },
    {
      decisionId: expect.any(String),
      outcome: "published",
      code: "Published",
      executionId: "execution_one",
      decidedAt: expect.any(Number),
      failedChecks: [],
      recovery: "none",
    },
  ]);
  expect(answers.map((answer) => Reflect.get(Object(answer), "decisionId"))).toEqual(
    recorded.map(({ decisionId }) => decisionId),
  );
});

// A contract mismatch is a source fix in a read, and a write the session did not demonstrate as
// declared in a write build, which never runs the write again.
it.each([
  { effect: "read", purpose: "example", recovery: "correct_source" },
  { effect: "write", purpose: "act", recovery: "write_completion" },
] as const)(
  "records a contract mismatch in a $effect build with recovery $recovery",
  async ({ effect, purpose, recovery }) => {
    const recorded: PublicationDecision[] = [];
    const f = await fixture(
      (turn) =>
        Effect.gen(function* () {
          yield* turn.actions.execute({ ...execution, purpose });
          expect(JSON.parse(yield* turn.actions.finish(publication))).toMatchObject({
            status: "not_published",
            reason: "contract_output_mismatch",
          });
        }),
      {
        publicationDecisions: {
          record: (decision) =>
            Effect.sync(() => {
              recorded.push(decision);
            }),
          list: Effect.sync(() => recorded),
        },
        publish: () =>
          Effect.fail(
            new MintFailure({ code: "PublicationUnavailable", reason: "contract_output_mismatch" }),
          ),
      },
    );
    await f.run({ ...request, effect });
    expect(recorded).toEqual([
      expect.objectContaining({ reason: "contract_output_mismatch", recovery }),
    ]);
  },
);

// A finish_build the host refuses before publication runs is a decision too.
it.each([
  { refusal: "an invalid request", input: { ...publication, metadata: undefined }, code: "InvalidRequest" },
  { refusal: "an entrypoint outside the workspace", input: { ...publication, entrypoint: "../outside.ts" }, code: "ScopeDenied" },
] as const)("records $refusal as a refused publication decision", async ({ input, code }) => {
  const recorded: PublicationDecision[] = [];
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        expect(yield* Effect.either(turn.actions.finish(input))).toMatchObject({
          _tag: "Left",
          left: { code },
        });
      }),
    {
      publicationDecisions: {
        record: (decision) =>
          Effect.sync(() => {
            recorded.push(decision);
          }),
        list: Effect.sync(() => recorded),
      },
    },
  );
  await f.run();
  expect(recorded).toEqual([
    expect.objectContaining({ outcome: "refused", code, recovery: "correct_source" }),
  ]);
});

// The host's fallback publication after unresolved input feedback is a decision as well.
it("records the end-of-run fallback publication of unresolved input feedback", async () => {
  const recorded: PublicationDecision[] = [];
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        yield* turn.actions.finish(publication);
      }),
    {
      publicationDecisions: {
        record: (decision) =>
          Effect.sync(() => {
            recorded.push(decision);
          }),
        list: Effect.sync(() => recorded),
      },
      publish: () =>
        Effect.fail(
          new MintFailure({
            code: "ReviewDenied",
            review: {
              outcome: "deny",
              reason: "input_feedback",
              rationale: "An account's own value is listed as an option.",
              findings: [],
            },
          }),
        ),
      inputFeedbackFallback: {
        kept: () => true,
        publish: Effect.succeed({
          publicationRef: "flagged-private",
          categories: [],
          diagnostics: [],
        }),
        flagPublished: Effect.void,
      },
    },
  );
  expect(await f.run()).toMatchObject({ build: "published", publicationRef: "flagged-private" });
  expect(recorded.map(({ outcome, recovery }) => [outcome, recovery])).toEqual([
    ["refused", "guardian_feedback"],
    ["published", "none"],
  ]);
});

// A host hook that throws is a recorded gap too, never a crash of the build.
it("records a publication decision log that throws as a gap and still publishes", async () => {
  let reviewed = false;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        yield* turn.actions.finish({ ...publication, executionId: "missing" });
        expect(JSON.parse(yield* turn.actions.requestInput(textQuestion("Which report?", "report")))).toMatchObject({
          status: "answered",
        });
        yield* turn.actions.finish(publication);
      }),
    {
      publicationDecisions: {
        record: () => {
          throw new Error("record crashed");
        },
        list: Effect.die(new Error("list crashed")),
      },
      reviewQuestion: () =>
        Effect.sync(() => {
          reviewed = true;
          return { outcome: "allow_business" as const, rationale: "Allowed." };
        }),
      askInput: () => Effect.succeed({ report: { type: "text", value: "Monthly." } }),
    },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({ build: "published" });
  expect(reviewed).toBe(true);
  expect(outcome.diagnostics.join("\n")).toContain("diagnostic_gap");
});

// Evidence the host could not keep is a gap: the publication decision still stands.
it("records a publication decision the host could not keep as a gap and still publishes", async () => {
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        yield* turn.actions.finish(publication);
      }),
    {
      publicationDecisions: {
        record: () => Effect.fail(new MintFailure({ code: "Unavailable" })),
        list: Effect.succeed([]),
      },
    },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({ build: "published" });
  expect(outcome.diagnostics.join("\n")).toContain("diagnostic_gap");
});

it.each([true, false])(
  "does not invite futile finish_build retries after a route-evidence refusal; repeatable read %s",
  async (repeatableRead) => {
    let publications = 0;
    const f = await fixture(
      (turn) =>
        Effect.gen(function* () {
          yield* turn.actions.execute(execution);
          const refused: unknown = JSON.parse(yield* turn.actions.finish(publication));
          expect(refused).toMatchObject({
            status: "not_published",
            reason: "destination_validation",
            destinationEvidenceGap: "sign_in_route_evidence",
            repeatableRead,
          });
          expect(turn.isComplete()).toBe(!repeatableRead);
          if (!repeatableRead) return;
          // A second refusal, even for a fresh receipt, ends the attempt.
          expect(JSON.parse(yield* turn.actions.finish(publication))).toMatchObject({
            repeatableRead: false,
          });
          expect(turn.isComplete()).toBe(true);
        }),
      {
        repeatableRead,
        publish: () =>
          Effect.suspend(() => {
            publications++;
            return Effect.fail(
              new MintFailure({
                code: "PublicationUnavailable",
                reason: "destination_validation",
                destinationEvidenceGap: "sign_in_route_evidence",
              }),
            );
          }),
      },
    );
    const outcome = await f.run();
    expect(outcome).toMatchObject({ build: "incomplete" });
    expect(publications).toBe(repeatableRead ? 2 : 1);
  },
);

it("retries an unavailable question review, then asks the reviewed question in place", async () => {
  let questionReviews = 0;
  const reviewed: unknown[] = [];
  const asked: unknown[] = [];
  const question = textQuestion("Which account type?", "account_type");
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        for (let resubmission = 0; resubmission < 2; resubmission++) {
          const feedback: unknown = JSON.parse(yield* turn.actions.requestInput(question));
          expect(feedback).toMatchObject({
            status: "review_unavailable",
            code: "ReviewUnavailable",
            retryable: true,
          });
          expect(turn.isComplete()).toBe(false);
        }
        expect(JSON.parse(yield* turn.actions.requestInput(question))).toMatchObject({
          status: "answered",
          answers: { account_type: "business" },
        });
        expect(turn.isComplete()).toBe(false);
      }),
    {
      reviewQuestion: (submitted) =>
        Effect.suspend(() => {
          reviewed.push(submitted);
          return questionReviews++ < 2
            ? Effect.fail(
                new MintFailure({ code: "ReviewUnavailable", reviewFailure: "Unavailable" }),
              )
            : Effect.succeed({
                outcome: "allow_business" as const,
                rationale: "Synthetic question is an ordinary business choice.",
              });
        }),
      askInput: (submitted) =>
        Effect.sync(() => {
          asked.push(submitted);
          return { account_type: { type: "text" as const, value: "business" } };
        }),
    },
  );
  const outcome = await f.run();
  expect(outcome.build).toBe("incomplete");
  expect(outcome).not.toHaveProperty("noResponse");
  expect(questionReviews).toBe(3);
  // Guardian reviews the whole request object, and only the approved one reaches the caller.
  expect(reviewed).toEqual([question, question, question]);
  expect(asked).toEqual([question]);
});

// model-continuation.test.ts routes the reword and supplied-login outcomes through the real SDK.
it.each([{ login: "held" }, { login: undefined }] as const)(
  "routes an authentication question review (login $login) without asking the caller",
  async ({ login }) => {
    let asked = 0;
    let loginRequests = 0;
    const f = await fixture(
      (turn) =>
        Effect.gen(function* () {
          const response: unknown = JSON.parse(
            yield* turn.actions.requestInput(textQuestion("What is your password?")),
          );
          expect(response).toMatchObject({
            status: "login_request",
            userInputRequired: false,
            login: login ?? "unavailable",
          });
          // The routing does not end the attempt: the agent continues.
          expect(turn.isComplete()).toBe(false);
        }),
      {
        reviewQuestion: () =>
          Effect.succeed({
            outcome: "authentication" as const,
            rationale: "Synthetic review rationale.",
          }),
        askInput: () =>
          Effect.sync(() => {
            asked++;
            return {};
          }),
        ...(login === undefined
          ? {}
          : {
              requestLogin: () =>
                Effect.sync(() => {
                  loginRequests++;
                  return login;
                }),
            }),
      },
    );
    expect(await f.run()).toMatchObject({ build: "incomplete" });
    expect(asked).toBe(0);
    expect(loginRequests).toBe(login === undefined ? 0 : 1);
  },
);

it("returns a secret answer to the model as the host's handle and refuses anything else in its place", async () => {
  const codeQuestion = {
    questions: [
      {
        id: "code",
        type: "secret" as const,
        secretKind: "one_time_code" as const,
        prompt: "The site texted a code. What is it?",
      },
      { id: "plan", type: "text" as const, prompt: "Which plan?" },
    ],
  };
  const handled = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const result: unknown = JSON.parse(yield* turn.actions.requestInput(codeQuestion));
        expect(result).toMatchObject({
          status: "answered",
          answers: { code: "{{secret.s2}}", plan: "gold" },
        });
      }),
    {
      askInput: () =>
        Effect.succeed({
          code: { type: "secret" as const, value: "{{secret.s2}}" },
          plan: { type: "text" as const, value: "gold" },
        }),
    },
  );
  expect((await handled.run()).build).toBe("incomplete");
  // A host that hands back the value itself breaks the contract; the model gets nothing of it.
  let refused: unknown;
  const raw = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const result = yield* Effect.either(turn.actions.requestInput(codeQuestion));
        refused = result._tag === "Left" ? result.left : result.right;
      }),
    {
      askInput: () =>
        Effect.succeed({
          code: { type: "secret" as const, value: "otp-canary-5521" },
          plan: { type: "text" as const, value: "gold" },
        }),
    },
  );
  await raw.run();
  expect(refused).toMatchObject({ _tag: "MintFailure", code: "Unavailable" });
  expect(JSON.stringify(refused)).not.toContain("otp-canary-5521");
});

it("ends once question review stays unavailable past its budget, without creating a request", async () => {
  let asked = 0;
  const time = steppedClock();
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const question = textQuestion("Which account type?");
        yield* turn.actions.requestInput(question);
        yield* turn.actions.requestInput(question);
        expect(turn.isComplete()).toBe(false);
        time.advance(15 * 60_000);
        expect(JSON.parse(yield* turn.actions.requestInput(question))).toMatchObject({
          status: "question_review_unavailable",
        });
        expect(turn.isComplete()).toBe(true);
      }).pipe(Effect.withClock(time.clock)),
    {
      reviewQuestion: () =>
        Effect.fail(new MintFailure({ code: "ReviewUnavailable", reviewFailure: "Unavailable" })),
      askInput: () =>
        Effect.sync(() => {
          asked++;
          return {};
        }),
    },
  );
  const outcome = await f.run();
  expect(outcome.build).toBe("incomplete");
  expect(outcome).not.toHaveProperty("noResponse");
  expect(asked).toBe(0);
});

const invalidOutcome = () =>
  Effect.fail(new MintFailure({ code: "ReviewUnavailable", reviewFailure: "InvalidOutcome" }));

// A review whose outcome Guardian kept refusing was answered as an outage to resubmit unchanged,
// and every review that completed in between restarted the outage budget, so the attempt never
// ended; past it, the attempt ended as an outage a repair is requeued for.
it("sends a refused-outcome review back to revise once, and ends the attempt at a second", async () => {
  let reviews = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const question = textQuestion("Which account type?");
        const first: unknown = JSON.parse(yield* turn.actions.requestInput(question));
        expect(first).toMatchObject({ status: "review_invalid_outcome" });
        // retryable:true tells the minter to submit the same call again, which this repeats.
        expect(first).not.toHaveProperty("retryable");
        expect(JSON.stringify(first)).not.toContain("unavailable");
        expect(turn.isComplete()).toBe(false);
        yield* turn.actions.requestInput(question);
        expect(turn.isComplete()).toBe(false);
        expect(JSON.parse(yield* turn.actions.requestInput(question))).toMatchObject({
          status: "review_invalid_outcome",
          retryable: false,
        });
        expect(turn.isComplete()).toBe(true);
      }),
    {
      // Refused, then completed, then refused again.
      reviewQuestion: () =>
        reviews++ === 1
          ? Effect.succeed({ outcome: "reword" as const, rationale: "Synthetic reword." })
          : invalidOutcome(),
    },
  );
  const outcome = await f.run();
  expect(outcome.build).toBe("incomplete");
  expect(outcome).not.toHaveProperty("hostFailure");
  expect(reviews).toBe(3);
});

// The second refused outcome ended the attempt with no typed ending and no diagnostic naming
// why, so a host read the build as a missing publication, though its write had applied.
it("names the ending of an attempt a second refused outcome ends, and the review that did", async () => {
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const question = textQuestion("Which account type?");
        yield* turn.actions.requestInput(question);
        yield* turn.actions.requestInput(question);
        expect(turn.isComplete()).toBe(true);
      }),
    { reviewQuestion: invalidOutcome },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({ build: "incomplete", stopReason: "host_unavailable" });
  // The host ended it, not an outage: nothing requeues it as one.
  expect(outcome).not.toHaveProperty("hostFailure");
  expect(phaseDiagnostics(outcome, "review")).toEqual([
    { phase: "review", reason: "review_unavailable", code: "InvalidOutcome", review: "question" },
  ]);
});

// A refused outcome started the review outage clock, so report_blocked was refused until the
// agent resubmitted the same request.
it("lets report_blocked through after a refused-outcome review, which starts no outage", async () => {
  let reviews = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.requestInput(textQuestion("Which account type?"));
        const reportBlocked = turn.actions.reportBlocked;
        if (reportBlocked === undefined) throw new Error("Missing report_blocked");
        expect(JSON.parse(yield* reportBlocked(blockedReport))).toMatchObject({
          status: "blocked",
          explanationShown: true,
        });
      }),
    {
      reviewQuestion: () =>
        reviews++ === 0
          ? invalidOutcome()
          : Effect.succeed({ outcome: "allow_business" as const, rationale: "Plain." }),
    },
  );
  expect((await f.run()).blocked).toEqual(blockedReport);
});

it("sends a blocked explanation whose outcome Guardian refused back once, then ends blocked", async () => {
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const reportBlocked = turn.actions.reportBlocked;
        if (reportBlocked === undefined) throw new Error("Missing report_blocked");
        expect(JSON.parse(yield* reportBlocked(blockedReport))).toMatchObject({
          status: "blocked_explanation_rejected",
        });
        expect(JSON.parse(yield* reportBlocked(blockedReport))).toMatchObject({
          status: "blocked",
          explanationShown: false,
        });
      }),
    { reviewQuestion: invalidOutcome },
  );
  const outcome = await f.run();
  expect(outcome.blocked).toEqual({ reason: "site_lacks_capability" });
  expect(phaseDiagnostics(outcome, "blocked_review")).toEqual([
    expect.objectContaining({ code: "InvalidOutcome" }),
    expect.objectContaining({ code: "InvalidOutcome" }),
  ]);
});

it("ends a taken-over attempt at its first refused outcome when its checkpoint already has one", async () => {
  const harness: MintHarnessSnapshot = {
    executions: [],
    purposes: [],
    diagnostics: [],
    exampleClaimed: false,
    writeSession: "none",
    unavailableOutputRefusals: 0,
    unavailableCauseRecorded: false,
    reviewUnavailableRetries: { execution: 0, publication: 0, question: 0 },
    invalidOutcomes: 1,
    destinationEvidenceRefusals: 0,
    inputFeedbackRounds: 0,
    inputFeedbackPublicTool: false,
    inputFeedbackCoverage: "",
    providerUnavailableRetries: 0,
    executionClosed: false,
    captchaChecks: 0,
  };
  const takeover = await fixture(
    (turn) =>
      Effect.gen(function* () {
        expect(
          JSON.parse(yield* turn.actions.requestInput(textQuestion("Which account type?"))),
        ).toMatchObject({ status: "review_invalid_outcome", retryable: false });
        expect(turn.isComplete()).toBe(true);
      }),
    {
      reviewQuestion: invalidOutcome,
      agentRecovery: { initial: { agent: freshAgent, harness }, save: () => Effect.void },
    },
  );
  expect(await takeover.run()).toMatchObject({
    build: "incomplete",
    stopReason: "host_unavailable",
  });
});

/** The parsed diagnostics a phase recorded. */
const phaseDiagnostics = (outcome: { readonly diagnostics: readonly string[] }, phase: string) =>
  outcome.diagnostics
    .map((entry): unknown => JSON.parse(entry))
    .filter((entry) => Reflect.get(Object(entry), "phase") === phase);

// A publication review whose outcome Guardian kept refusing was recorded as an outage to retry,
// which later reviews read as trusted host evidence, while the minter was told to revise.
it("records a refused-outcome publication review as a revision, then as ended at a second", async () => {
  const recorded: PublicationDecision[] = [];
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        const first: unknown = JSON.parse(yield* turn.actions.finish(publication));
        expect(first).toMatchObject({ status: "review_invalid_outcome" });
        expect(first).not.toHaveProperty("retryable");
        expect(turn.isComplete()).toBe(false);
        expect(JSON.parse(yield* turn.actions.finish(publication))).toMatchObject({
          status: "review_invalid_outcome",
          retryable: false,
        });
      }),
    {
      publicationDecisions: {
        record: (decision) =>
          Effect.sync(() => {
            recorded.push(decision);
          }),
        list: Effect.sync(() => recorded),
      },
      publish: invalidOutcome,
    },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({ build: "incomplete", stopReason: "host_unavailable" });
  expect(outcome).not.toHaveProperty("hostFailure");
  expect(recorded).toEqual([
    expect.objectContaining({
      outcome: "refused",
      failedChecks: ["InvalidOutcome"],
      recovery: "correct_source",
    }),
    expect.objectContaining({ outcome: "refused", recovery: "ended" }),
  ]);
  expect(phaseDiagnostics(outcome, "publication")).toEqual([
    expect.objectContaining({ code: "InvalidOutcome" }),
    expect.objectContaining({ code: "InvalidOutcome" }),
  ]);
  expect(phaseDiagnostics(outcome, "review")).toEqual([
    expect.objectContaining({ reason: "review_unavailable", review: "publication" }),
  ]);
});

it("gives a later question review a refused-outcome publication as a revision, not an outage", async () => {
  const recorded: PublicationDecision[] = [];
  const reviewed: unknown[] = [];
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        yield* turn.actions.finish(publication);
        yield* turn.actions.requestInput(textQuestion("Which account type?"));
      }),
    {
      publicationDecisions: {
        record: (decision) =>
          Effect.sync(() => {
            recorded.push(decision);
          }),
        list: Effect.sync(() => recorded),
      },
      publish: invalidOutcome,
      reviewQuestion: (_request, options) =>
        Effect.sync(() => {
          reviewed.push(...(options?.publicationDecisions ?? []));
          return { outcome: "allow_business" as const, rationale: "Plain." };
        }),
    },
  );
  await f.run();
  expect(reviewed).toEqual([
    expect.objectContaining({ outcome: "refused", recovery: "correct_source" }),
  ]);
});

// A question review saw a publication refusal only as its code, reason, checks and recovery, so it
// refused a question that relied on what the refusal's instruction requires.
it("gives a later question review the instruction each publication refusal carried", async () => {
  const recorded: PublicationDecision[] = [];
  const reviewed: PublicationDecision[] = [];
  let refusal: unknown;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute({ ...execution, purpose: "act" });
        refusal = JSON.parse(yield* turn.actions.finish(publication));
        yield* turn.actions.requestInput(textQuestion("May the refusal use a short code?"));
      }),
    {
      publicationDecisions: {
        record: (decision) =>
          Effect.sync(() => {
            recorded.push(decision);
          }),
        list: Effect.sync(() => recorded),
      },
      publish: () =>
        Effect.fail(
          new MintFailure({ code: "PublicationUnavailable", reason: "refusal_unreadable" }),
        ),
      reviewQuestion: (_request, options) =>
        Effect.sync(() => {
          reviewed.push(...(options?.publicationDecisions ?? []));
          return { outcome: "allow_business" as const, rationale: "Plain." };
        }),
    },
  );
  await f.run({ ...request, effect: "write" });
  expect(refusal).toMatchObject({ reason: "refusal_unreadable", instruction: expect.any(String) });
  expect(reviewed).toEqual([
    expect.objectContaining({
      reason: "refusal_unreadable",
      instruction: Reflect.get(Object(refusal), "instruction"),
    }),
  ]);
});

// A host that failed during the review that repeated a refused outcome ended the attempt with no
// host failure, so the outcome hid the host's own cause.
it("ends with the host's own cause when it fails during a refused-outcome review", async () => {
  let reviews = 0;
  let hostDown = false;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const question = textQuestion("Which account type?");
        yield* turn.actions.requestInput(question);
        expect(JSON.parse(yield* turn.actions.requestInput(question))).toMatchObject({
          status: "review_invalid_outcome",
          retryable: false,
          executionAvailability: "host_unavailable",
        });
      }),
    {
      executionAvailability: () => (hostDown ? "host_unavailable" : "open"),
      reviewQuestion: () => {
        if (reviews++ === 1) hostDown = true;
        return invalidOutcome();
      },
    },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({ build: "incomplete", hostFailure: "host_unavailable" });
  expect(phaseDiagnostics(outcome, "question_review")).toEqual([
    expect.objectContaining({ code: "InvalidOutcome" }),
    expect.objectContaining({ code: "InvalidOutcome" }),
  ]);
});

// Once live execution closed during an execution review whose outcome Guardian kept refusing, the
// answer still invited a revised resubmission that could no longer run.
it("points a refused-outcome execution to its retained receipt once live execution closed", async () => {
  let hostDown = false;
  let executions = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        const answer: unknown = JSON.parse(
          yield* turn.actions.execute({ ...execution, purpose: "explore" }),
        );
        expect(answer).toMatchObject({
          status: "review_invalid_outcome",
          executionAvailability: "host_unavailable",
        });
        expect(answer).not.toHaveProperty("retryable");
        expect(JSON.stringify(answer)).toContain("finish_build");
        expect(turn.isComplete()).toBe(false);
        yield* turn.actions.finish(publication);
      }),
    {
      executionAvailability: () => (hostDown ? "host_unavailable" : "open"),
      reviewAndExecute: () => {
        if (executions++ === 0)
          return Effect.succeed({
            executionId: "execution_one",
            status: "completed" as const,
            effect: "verified" as const,
            resultRef: "private-result-ref",
            observations: { result: "public" },
          });
        hostDown = true;
        return Effect.fail(
          new MintFailure({
            code: "ReviewUnavailable",
            reviewFailure: "InvalidOutcome",
            reviewDispatch: "not_sent",
          }),
        );
      },
    },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({ build: "published" });
  expect(phaseDiagnostics(outcome, "execution")).toEqual([
    expect.objectContaining({ code: "InvalidOutcome" }),
  ]);
});

// A task update review whose outcome Guardian kept refusing was diagnosed as an outage.
it("diagnoses a refused-outcome update review as InvalidOutcome and sends it back to revise", async () => {
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const answer: unknown = JSON.parse(
          yield* turn.actions.updateTask!({
            summary: "Read the notes from a different day.",
            changes: [{ setting: "input", values: { day: "2026-11-02" } }],
            confirmedBy: [],
            recommend: "update",
          }),
        );
        expect(answer).toMatchObject({ status: "review_invalid_outcome" });
        expect(answer).not.toHaveProperty("retryable");
      }),
    {
      reviewTaskUpdate: invalidOutcome,
      applyTaskUpdate: () => Effect.succeed({ outcome: "applied" as const }),
    },
  );
  expect(phaseDiagnostics(await f.run(), "task_update_review")).toEqual([
    expect.objectContaining({ code: "InvalidOutcome" }),
  ]);
});

it("keeps two answered requests in one attempt and publishes with both answers", async () => {
  const asked: unknown[] = [];
  const responses: unknown[] = [];
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        responses.push(
          JSON.parse(
            yield* turn.actions.requestInput({
              questions: [
                {
                  id: "format",
                  type: "choice",
                  prompt: "Which format?",
                  options: [
                    { id: "csv", label: "CSV" },
                    { id: "json", label: "JSON" },
                  ],
                },
              ],
            }),
          ),
        );
        expect(turn.isComplete()).toBe(false);
        responses.push(
          JSON.parse(
            yield* turn.actions.requestInput({
              notice: "Two more details.",
              questions: [
                { id: "region", type: "text", prompt: "Which region?" },
                { id: "archived", type: "confirm", prompt: "Include archived rows?" },
              ],
            }),
          ),
        );
        expect(turn.isComplete()).toBe(false);
        yield* turn.actions.execute(execution);
        yield* turn.actions.finish(publication);
      }),
    {
      askInput: (submitted) =>
        Effect.sync(() => {
          asked.push(submitted);
          return asked.length === 1
            ? { format: { type: "choice" as const, value: "csv" } }
            : {
                region: { type: "text" as const, value: "eu-west" },
                archived: { type: "confirm" as const, value: { confirmed: true } },
              };
        }),
    },
  );
  const outcome = await f.run();
  expect(responses).toMatchObject([
    { status: "answered", answers: { format: "csv" } },
    { status: "answered", answers: { region: "eu-west", archived: { confirmed: true } } },
  ]);
  expect(asked).toHaveLength(2);
  expect(asked[1]).toMatchObject({ notice: "Two more details." });
  expect(outcome).toMatchObject({ build: "published", publicationRef: "published-revision" });
  expect(outcome).not.toHaveProperty("noResponse");
  expect(f.seen).toHaveLength(1);
});

// A signed-out step that enters a contact detail only to set the store a read applies stays a read
// once the owner confirms it: Guardian labels it read, and the read build publishes.
it("publishes a read whose live contact step the owner confirmed, Guardian labelling it a read", async () => {
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        expect(
          JSON.parse(
            yield* turn.actions.requestInput({
              questions: [
                {
                  id: "guest_email",
                  type: "confirm",
                  prompt: "May the example enter guest@example.com to set the pickup store?",
                },
              ],
            }),
          ),
        ).toMatchObject({ status: "answered", answers: { guest_email: { confirmed: true } } });
        const receipt = yield* turn.actions.execute({ ...execution, target: "liveBrowser" });
        expect(JSON.parse(receipt)).toMatchObject({ status: "completed" });
        expect(JSON.parse(yield* turn.actions.finish(publication))).toMatchObject({
          status: "published",
        });
      }),
    {
      askInput: () => Effect.succeed({ guest_email: { type: "confirm", value: { confirmed: true } } }),
      reviewAndExecute: (_input, beforeDispatch = () => Effect.void) =>
        beforeDispatch(readAllow).pipe(
          Effect.as({
            executionId: "execution_one",
            status: "completed" as const,
            effect: "verified" as const,
            resultRef: "store-result-ref",
            observations: { result: "Pickup store set" },
            review: {
              outcome: "allow" as const,
              rationale: "Sets the store.",
              reviewId: "review_fixture",
              action: "read" as const,
            },
          }),
        ),
    },
  );
  const outcome = await f.run({ ...request, siteOrigin: "https://shop.example.test" });
  expect(outcome).toMatchObject({ build: "published", publicationRef: "published-revision" });
  expect(outcome.executions).toMatchObject([{ status: "completed", effect: "verified" }]);
});

/**
 * The caller's form answers, validated as a host validates them: the request the caller sees is
 * the one the harness hands the host, asked from the minting agent.
 */
const answeredByOwner =
  (wireAnswers: readonly Readonly<Record<string, unknown>>[]) => (submitted: AgentInputRequest) =>
    Effect.sync(() =>
      Either.getOrThrow(
        validateAnswer(
          { ...submitted, id: "1c9e3a5b-7d2f-4e6a-8b0c-2d4f6a8c0e1f", source: "agent" },
          wireAnswers[asked++] ?? {},
        ),
      ),
    );
let asked = 0;
afterEach(() => {
  asked = 0;
});

it("lets the owner answer a minter's choice and multiple choice in their own words or with a note", async () => {
  const responses: unknown[] = [];
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const format = {
          id: "format",
          type: "choice",
          prompt: "Which export format?",
          options: [
            { id: "csv", label: "CSV" },
            { id: "json", label: "JSON" },
          ],
        };
        const regions = {
          id: "regions",
          type: "multi_choice",
          prompt: "Which regions?",
          minSelections: 1,
          maxSelections: 2,
          options: [
            { id: "north", label: "North" },
            { id: "south", label: "South" },
          ],
        };
        responses.push(
          JSON.parse(yield* turn.actions.requestInput({ questions: [format] })),
          JSON.parse(yield* turn.actions.requestInput({ questions: [format, regions] })),
          JSON.parse(yield* turn.actions.requestInput({ questions: [regions] })),
        );
        yield* turn.actions.execute(execution);
        yield* turn.actions.finish(publication);
      }),
    {
      askInput: answeredByOwner([
        { format: { other: "Spreadsheet with one tab per month" } },
        {
          format: { option: "csv", note: "Semicolons between fields" },
          regions: { options: ["north"], note: "Only active stores" },
        },
        { regions: { options: [], other: "The whole country" } },
      ]),
    },
  );
  const outcome = await f.run();
  expect(responses).toEqual([
    expect.objectContaining({
      status: "answered",
      answers: { format: { other: "Spreadsheet with one tab per month" } },
    }),
    expect.objectContaining({
      status: "answered",
      answers: {
        format: { option: "csv", note: "Semicolons between fields" },
        regions: { options: ["north"], note: "Only active stores" },
      },
    }),
    expect.objectContaining({
      status: "answered",
      answers: { regions: { options: [], other: "The whole country" } },
    }),
  ]);
  expect(outcome).toMatchObject({ build: "published" });
});

it("asks the effect question again when the owner answers it in their own words", async () => {
  const recorded: string[] = [];
  const responses: unknown[] = [];
  const effectChoice = {
    questions: [
      {
        id: "effect",
        type: "choice" as const,
        prompt: "Will this tool change something on the website?",
        options: [
          { id: "read", label: "read" },
          { id: "write", label: "write" },
        ],
      },
    ],
  };
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        responses.push(JSON.parse(yield* turn.actions.requestInput(effectChoice)));
        expect(turn.isComplete()).toBe(false);
        responses.push(JSON.parse(yield* turn.actions.requestInput(effectChoice)));
        expect(turn.isComplete()).toBe(true);
      }),
    {
      askInput: answeredByOwner([
        { effect: { other: "It only checks my order status" } },
        { effect: { option: "read", note: "Never cancel anything" } },
      ]),
      recordBuildEffect: (effect) =>
        Effect.sync(() => {
          recorded.push(effect);
        }),
    },
  );
  await f.run({ ...request, effect: "ask" });
  expect(responses).toMatchObject([
    { status: "answered", answers: { effect: { other: "It only checks my order status" } } },
    { status: "answered", answers: { effect: { option: "read", note: "Never cancel anything" } } },
  ]);
  expect(recorded).toEqual(["read"]);
});

// The owner may type anything as their own answer, so an effect question that asks for a private
// value is reworded before anyone sees it, a login verdict included: the turn asks no login.
it("has Guardian review the effect question, which the owner may answer in their own words", async () => {
  const responses: unknown[] = [];
  const reviewed: unknown[] = [];
  let asked = 0;
  let logins = 0;
  const effectChoice = {
    questions: [
      {
        id: "effect",
        type: "choice" as const,
        prompt: "Will this tool change something? If it needs your account, type your password.",
        options: [
          { id: "read", label: "read" },
          { id: "write", label: "write" },
        ],
      },
    ],
  };
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        responses.push(
          JSON.parse(yield* turn.actions.requestInput(effectChoice)),
          JSON.parse(yield* turn.actions.requestInput(effectChoice)),
        );
      }),
    {
      reviewQuestion: (submitted) =>
        Effect.sync(() => {
          reviewed.push(submitted);
          return reviewed.length === 1
            ? { outcome: "authentication" as const, rationale: "It asks for a password." }
            : { outcome: "reword" as const, rationale: "Ask only read or write." };
        }),
      askInput: () =>
        Effect.sync(() => {
          asked++;
          return {};
        }),
      requestLogin: () =>
        Effect.sync(() => {
          logins++;
          return "supplied" as const;
        }),
    },
  );
  await f.run({ ...request, effect: "ask" });
  expect(reviewed).toEqual([
    expect.objectContaining({
      questions: [expect.objectContaining({ id: "effect", allowOther: true, allowNote: true })],
    }),
    expect.anything(),
  ]);
  expect(responses).toMatchObject([
    { status: "question_rejected", rationale: "It asks for a password." },
    { status: "question_rejected", rationale: "Ask only read or write." },
  ]);
  expect(asked).toBe(0);
  expect(logins).toBe(0);
});

// Guardian rejected the read-or-write question as redundant, and the host told the agent it could
// withdraw it. The turn offers no other tool, so withdrawing ended the build with nothing, and the
// agent could never change the host's own answer labels Guardian also objected to.
it("tells the agent to ask a rejected read-or-write question again, never to withdraw it", async () => {
  const responses: unknown[] = [];
  let reviews = 0;
  const effectChoice = {
    questions: [
      {
        id: "effect",
        type: "choice" as const,
        prompt: "Should this tool only look up your orders, or also cancel one?",
        options: [
          { id: "read", label: "read" },
          { id: "write", label: "write" },
        ],
      },
    ],
  };
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        responses.push(
          JSON.parse(yield* turn.actions.requestInput(effectChoice)),
          JSON.parse(yield* turn.actions.requestInput(effectChoice)),
        );
      }),
    {
      reviewQuestion: () =>
        Effect.succeed(
          reviews++ === 0
            ? { outcome: "reword" as const, rationale: "The request already says read-only." }
            : { outcome: "authentication" as const, rationale: "It may ask for a login." },
        ),
    },
  );
  await f.run({ ...request, effect: "ask" });
  const instruction =
    "Reword the question using the rationale and call request_input again. This read-or-write question is required, and no other tool opens until the person answers it. The host sets its two answer labels, so change only the prompt.";
  expect(responses).toEqual([
    {
      status: "question_rejected",
      rationale: "The request already says read-only.",
      userInputRequired: false,
      instruction,
    },
    {
      status: "question_rejected",
      rationale: "It may ask for a login.",
      userInputRequired: false,
      instruction,
    },
  ]);
});

it("keeps the reword-or-withdraw instruction for a rejected question other than read-or-write", async () => {
  const responses: unknown[] = [];
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        responses.push(
          JSON.parse(yield* turn.actions.requestInput(textQuestion("Which account type?"))),
        );
      }),
    {
      reviewQuestion: () =>
        Effect.succeed({ outcome: "reword" as const, rationale: "The site shows the types." }),
    },
  );
  await f.run();
  expect(responses).toEqual([
    {
      status: "question_rejected",
      rationale: "The site shows the types.",
      userInputRequired: false,
      instruction:
        "Reword the question using the rationale, or withdraw it and continue. Do not ask again for a value you were already given or that the site shows. A reworded question is reviewed again.",
    },
  ]);
});

// The question review didn't know a build was a write build, so it rejected the true statement
// that a write build does the task once, for real, before it publishes.
it.each(["read", "write"] as const)(
  "gives a %s build's question and blocked report reviews the build's effect",
  async (effect) => {
    const reviewed: unknown[] = [];
    const f = await fixture(
      (turn) =>
        Effect.gen(function* () {
          yield* turn.actions.requestInput(textQuestion("Which account type?"));
          const reportBlocked = turn.actions.reportBlocked;
          if (reportBlocked === undefined) throw new Error("Missing report_blocked");
          yield* reportBlocked(blockedReport);
        }),
      {
        reviewQuestion: (_submitted, options) =>
          Effect.sync(() => {
            reviewed.push(options);
            return { outcome: "allow_business" as const, rationale: "Plain." };
          }),
      },
    );
    await f.run({ ...request, effect });
    expect(reviewed).toEqual([
      expect.objectContaining({ buildEffect: effect }),
      expect.objectContaining({ blockedOutcome: true, buildEffect: effect }),
    ]);
  },
);

it("gives the read-or-write question's review no build effect, since none is decided", async () => {
  const reviewed: unknown[] = [];
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.requestInput({
          questions: [
            {
              id: "effect",
              type: "choice" as const,
              prompt: "Should this tool only look up your orders, or also cancel one?",
              options: [
                { id: "read", label: "read" },
                { id: "write", label: "write" },
              ],
            },
          ],
        });
      }),
    {
      reviewQuestion: (_submitted, options) =>
        Effect.sync(() => {
          reviewed.push(options);
          return { outcome: "reword" as const, rationale: "Say what it would cancel." };
        }),
    },
  );
  await f.run({ ...request, effect: "ask" });
  expect(reviewed).toHaveLength(1);
  expect(reviewed[0]).not.toHaveProperty("buildEffect");
});

it("publishes without assumptions when the build lists none", async () => {
  const f = await fixture((turn) =>
    Effect.gen(function* () {
      yield* turn.actions.execute(execution);
      yield* turn.actions.finish(publication);
    }),
  );
  const outcome = await f.run();
  expect(outcome.build).toBe("published");
  expect(outcome).not.toHaveProperty("assumptions");
});

it("returns a finite detector subtype for unavailable publication review and keeps the build open without another example", async () => {
  let publications = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const example: unknown = JSON.parse(yield* turn.actions.execute(execution));
        expect(example).toMatchObject({ status: "completed", effect: "verified" });
        const feedback: unknown = JSON.parse(yield* turn.actions.finish(publication));
        expect(feedback).toMatchObject({
          status: "review_unavailable",
          code: "ReviewUnavailable",
          reviewPhase: "diagnostic_retention",
          diagnosticRetentionReason: "screening",
          diagnosticScreeningReason: "detector_unavailable",
          userInputRequired: false,
          retryable: true,
        });
        expect(JSON.stringify(feedback)).not.toContain("PRIVATE_DETECTOR_MESSAGE");
        expect(turn.isComplete()).toBe(false);
        // A second retention failure is an outage under the same budget, not the end.
        expect(JSON.parse(yield* turn.actions.finish(publication))).toMatchObject({
          status: "review_unavailable",
          retryable: true,
        });
        expect(turn.isComplete()).toBe(false);
      }),
    {
      publish: () =>
        Effect.sync(() => {
          publications++;
        }).pipe(
          Effect.zipRight(
            Effect.fail(
              new MintFailure({
                code: "ReviewUnavailable",
                reviewFailure: "Unavailable",
                reviewPhase: "diagnostic_retention",
                diagnosticRetentionReason: "screening",
                diagnosticScreeningReason: "detector_unavailable",
              }),
            ),
          ),
        ),
    },
  );
  expect(await f.run()).toMatchObject({
    build: "incomplete",
    example: { status: "completed", effect: "verified" },
  });
  expect(publications).toBe(2);
});

it("allows a corrected exploration after deny feedback without requesting user input or claiming an example", async () => {
  const outcome = "deny";
  let reviews = 0;
  let claims = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const rejected = yield* turn.actions.execute({ ...execution, purpose: "explore" });
        expect(JSON.parse(rejected)).toMatchObject({ status: "review_rejected", outcome });
        const editor = turn.session.createEditor?.();
        if (!editor) return yield* new MintFailure({ code: "Unavailable" });
        expect(
          yield* Effect.promise(() =>
            editor.createFile({
              type: "create_file",
              path: "src/observation.ts",
              diff: "+export const observation = 'safe labels only';\n",
            }),
          ),
        ).toMatchObject({ status: "completed" });
        expect(yield* turn.actions.readSource("src/observation.ts")).toContain("safe labels only");
        const corrected = yield* turn.actions.execute({
          ...execution,
          purpose: "explore",
          entrypoint: "src/observation.ts",
        });
        expect(JSON.parse(corrected)).toMatchObject({
          status: "completed",
          executionId: "corrected_observation",
        });
      }),
    {
      claimExample: Effect.sync(() => {
        claims++;
      }),
      reviewAndExecute: (submitted) =>
        Effect.suspend(() => {
          reviews++;
          if (reviews === 1)
            return Effect.fail(
              new MintFailure({
                code: "ReviewDenied",
                review: { outcome, rationale: "Observe field labels without private values." },
              }),
            );
          expect(submitted).toMatchObject({ entrypoint: "src/observation.ts" });
          return Effect.succeed({
            executionId: "corrected_observation",
            status: "completed" as const,
            effect: "verified" as const,
            observations: "Visible field labels observed.",
          });
        }),
    },
  );
  const result = await f.run();
  expect(result.build).toBe("incomplete");
  expect(result.example).toBeUndefined();
  expect(reviews).toBe(2);
  expect(claims).toBe(0);
});

it("returns typed execution failure feedback and retains the claimed example uncertainty", async () => {
  let calls = 0;
  const metadata = {
    phase: "execute" as const,
    reason: "provider_unavailable" as const,
    dispatch: "unknown" as const,
    stage: "result_read" as const,
    providerStatus: 503,
    providerCode: "ETIMEDOUT" as const,
    elapsedMs: 30_000,
  };
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const response = yield* turn.actions.execute(execution);
        expect(JSON.parse(response)).toMatchObject({
          status: "execution_unavailable",
          execution: metadata,
        });
        expect(yield* Effect.either(turn.actions.execute(execution))).toMatchObject({
          _tag: "Left",
          left: { code: "AlreadyExecuted" },
        });
      }),
    {
      reviewAndExecute: () =>
        Effect.suspend(() => {
          calls++;
          return Effect.fail(
            new MintFailure({
              code: "Unavailable",
              reason: "executor_unavailable",
              execution: metadata,
            }),
          );
        }),
    },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({ build: "incomplete", example: { effect: "possible" } });
  expect(JSON.stringify(outcome.diagnostics)).toContain("result_read");
  expect(calls).toBe(1);
});

it("returns publication review feedback while preserving the completed example", async () => {
  const deniedHost = {
    repeatableRead: true,
    executionAvailability: () => "open" as const,
    publish: () =>
      Effect.fail(
        new MintFailure({
          code: "ReviewDenied",
          review: {
            outcome: "deny",
            rationale: "The current schema omits the observed currency secret-canary",
          },
        }),
      ),
  };
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        expect(JSON.parse(turn.input)).toMatchObject({
          executionContext: { executionAvailability: "open", repeatableRead: true },
        });
        yield* turn.actions.execute(execution);
        const response = yield* turn.actions.finish(publication);
        expect(JSON.parse(response)).toMatchObject({
          status: "not_published",
          repeatableRead: true,
          executionAvailability: "open",
        });
        expect(turn.isComplete()).toBe(false);
        expect(response).toContain("The current schema omits the observed currency");
        expect(response).not.toContain("secret-canary");
      }),
    deniedHost,
  );
  expect(await f.run()).toMatchObject({
    build: "incomplete",
    example: { status: "completed", resultRef: "private-result-ref" },
  });
  expect(f.seen).toHaveLength(1);
});

/** The caller left the request unanswered: the host's `noResponse` failure. */
const unanswered = (possibleCommit = false) =>
  new MintFailure({ code: "Unavailable", noResponse: { possibleCommit } });

/** A request_input call with one text question. */
const textQuestion = (prompt: string, id = "answer") => ({
  questions: [{ id, type: "text" as const, prompt }],
});

const fixture = makeMintHarnessFixture(cleanup, request, portableJobSession);

it("keeps the build open after a failed receipt the host did not mark terminal", async () => {
  let executions = 0;
  let publications = 0;
  let reached = false;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const receipt: unknown = JSON.parse(
          yield* turn.actions.execute({
            ...execution,
            target: "liveBrowser",
            purpose: "explore",
          }),
        );
        expect(receipt).toMatchObject({ status: "failed", effect: "possible" });
        expect(receipt).not.toHaveProperty("terminalFailure");
        expect(turn.isComplete()).toBe(false);
        reached = true;
      }),
    {
      reviewAndExecute: () =>
        Effect.sync(() => {
          executions++;
          return {
            executionId: "failed_live_read",
            status: "failed" as const,
            effect: "possible" as const,
            observations: { result: { status: "failed", errorCode: "DeadlineExceeded" } },
          };
        }),
      publish: () =>
        Effect.sync(() => {
          publications++;
          return { publicationRef: "unexpected", diagnostics: [] };
        }),
    },
  );
  const outcome = await f.run();
  expect(reached).toBe(true);
  expect(outcome.executions).toHaveLength(1);
  expect(outcome.executions[0]).toMatchObject({ status: "failed", effect: "possible" });
  expect(executions).toBe(1);
  expect(publications).toBe(0);
});

it("enforces capability clarification through the existing input tool before execution", async () => {
  const question = "What result do you need that product search does not provide?";
  let published = 0;
  const answered: string[] = [];
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const input = modelInput(turn.input);
        expect(input).not.toHaveProperty("businessInputTypes");
        const screenedRequest = input.screenedRequest;
        if (
          screenedRequest === null ||
          typeof screenedRequest !== "object" ||
          Array.isArray(screenedRequest)
        )
          throw new Error("Expected capability question request");
        expect(Object.keys(screenedRequest).sort()).toEqual(["instruction", "question"]);
        expect(screenedRequest).toMatchObject({ question });
        expect(yield* Effect.either(turn.actions.execute(execution))).toMatchObject({
          _tag: "Left",
          left: { code: "ScopeDenied" },
        });
        expect(yield* Effect.either(turn.actions.finish(publication))).toMatchObject({
          _tag: "Left",
          left: { code: "ScopeDenied" },
        });
        expect(yield* Effect.either(turn.actions.readSource("src/tool.ts"))).toMatchObject({
          _tag: "Left",
          left: { code: "ScopeDenied" },
        });
        // Any other request, or the question with a different type, is refused unasked.
        for (const refused of [
          textQuestion("Ask for a password"),
          {
            questions: [{ id: "need", type: "confirm", prompt: question }],
          },
          {
            questions: [
              ...textQuestion(question).questions,
              ...textQuestion("More?", "more").questions,
            ],
          },
        ])
          expect(JSON.parse(yield* turn.actions.requestInput(refused))).toMatchObject({
            status: "question_refused",
            reason: "capability_question_shape",
          });
        expect(turn.isComplete()).toBe(false);
        expect(
          JSON.parse(yield* turn.actions.requestInput(textQuestion(question, "need"))),
        ).toMatchObject({
          status: "answered",
          answers: { need: "Stock levels per warehouse" },
        });
        expect(turn.isComplete()).toBe(true);
      }),
    {
      capabilityQuestion: question,
      askInput: (submitted) =>
        Effect.sync(() => {
          expect(submitted).toEqual(textQuestion(question, "need"));
          return { need: { type: "text" as const, value: "Stock levels per warehouse" } };
        }),
      capabilityAnswered: (answer) =>
        Effect.sync(() => {
          answered.push(answer);
        }),
      publish: () =>
        Effect.sync(() => {
          published++;
          return { publicationRef: "invalid", diagnostics: [] };
        }),
    },
  );
  const outcome = await f.run();
  expect(outcome.build).toBe("incomplete");
  expect(outcome).not.toHaveProperty("noResponse");
  expect(answered).toEqual(["Stock levels per warehouse"]);
  expect(f.seen).toEqual([]);
  expect(published).toBe(0);
});

// The effect question turn refuses execution, publication and every question but one
// read-or-write choice, before asking. The owner may answer it in their own words, so Guardian
// reviews it like any other question the agent writes.
it("asks only one read-or-write effect question, refusing every other shape and action", async () => {
  let asked = 0;
  let reviews = 0;
  const recorded: string[] = [];
  const choice = (options: readonly string[] = ["write", "read"]) => ({
    questions: [
      {
        id: "effect",
        type: "choice" as const,
        prompt: "Will this tool change something on the website?",
        options: options.map((id) => ({ id, label: id })),
      },
    ],
  });
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        expect(turn.effectQuestion).toBe(true);
        expect(yield* Effect.either(turn.actions.execute(execution))).toMatchObject({
          _tag: "Left",
          left: { code: "ScopeDenied" },
        });
        expect(yield* Effect.either(turn.actions.finish(publication))).toMatchObject({
          _tag: "Left",
          left: { code: "ScopeDenied" },
        });
        for (const refused of [
          textQuestion("Read or write?"),
          choice(["read", "write", "both"]),
          choice(["read"]),
          { ...choice(), notice: "Pick one." },
          { questions: [...choice().questions, ...textQuestion("Why?").questions] },
        ])
          expect(JSON.parse(yield* turn.actions.requestInput(refused))).toMatchObject({
            status: "question_refused",
            reason: "effect_question_shape",
          });
        // Whether the owner may answer in their own words is the host's, never the agent's.
        expect(
          JSON.parse(
            yield* turn.actions.requestInput({
              questions: [{ ...choice().questions[0], allowOther: false }],
            }),
          ),
        ).toMatchObject({ status: "question_invalid", reason: "own_words_are_the_hosts" });
        expect(asked).toBe(0);
        expect(reviews).toBe(0);
        expect(turn.isComplete()).toBe(false);
        expect(JSON.parse(yield* turn.actions.requestInput(choice()))).toMatchObject({
          status: "answered",
          answers: { effect: "write" },
        });
        expect(turn.isComplete()).toBe(true);
      }),
    {
      reviewQuestion: () =>
        Effect.sync(() => {
          reviews++;
          return { outcome: "allow_business" as const, rationale: "Asks read or write." };
        }),
      askInput: () =>
        Effect.sync(() => {
          asked++;
          return { effect: { type: "choice" as const, value: "write" } };
        }),
      recordBuildEffect: (effect) =>
        Effect.sync(() => {
          recorded.push(effect);
        }),
    },
  );
  const outcome = await f.run({ ...request, effect: "ask" });
  expect(outcome).not.toHaveProperty("noResponse");
  expect(asked).toBe(1);
  expect(recorded).toEqual(["write"]);
  expect(reviews).toBe(1);
  expect(f.seen).toEqual([]);
});

it("refuses an effect question turn that also carries a capability question", async () => {
  const f = await fixture(() => Effect.die("The model must not start"), {
    capabilityQuestion: "What result do you need?",
  });
  const result = await Effect.runPromise(
    runMint({ ...request, effect: "ask" }).pipe(
      Effect.provideService(MintServices, f.dependencies),
      Effect.either,
    ),
  );
  expect(result).toMatchObject({ _tag: "Left", left: { code: "ScopeDenied" } });
});

it("screens intake/source/results and returns the actual first result separately from publication", async () => {
  const f = await fixture((turn) =>
    Effect.gen(function* () {
      expect(turn.input).not.toContain("secret-canary");
      expect(yield* turn.actions.readSource("src/tool.ts")).not.toContain("secret-canary");
      const output = yield* turn.actions.execute(execution);
      expect(output).not.toContain("secret-canary");
      expect(output).not.toContain("private-result-ref");
      yield* turn.actions.finish(publication);
    }),
  );
  const result = await f.run();
  expect(result).toMatchObject({
    build: "published",
    publicationRef: "published-revision",
    example: { resultRef: "private-result-ref", effect: "verified" },
  });
  expect(f.seen).toHaveLength(1);
});

it("rejects invalid intake and model-selected private refs before effects", async () => {
  const f = await fixture((turn) =>
    Effect.gen(function* () {
      const result = yield* Effect.either(
        turn.actions.execute({ ...execution, exampleInputRef: "another-invocation" }),
      );
      expect(result).toMatchObject({ _tag: "Left", left: { code: "InvalidRequest" } });
    }),
  );
  await expect(
    f.run({ ...request, website_auth: { password: "never-model-visible" } }),
  ).rejects.toBeDefined();
  await f.run();
  expect(f.seen).toHaveLength(0);
});

it("refuses a caller-supplied public origin field", async () => {
  const origin = "https://example.com";
  const f = await fixture(() => Effect.die("The model must not start"));
  expect(
    await Effect.runPromise(
      runMint({ ...request, siteOrigin: origin, publicSiteOrigin: origin }).pipe(
        Effect.provideService(MintServices, f.dependencies),
        Effect.either,
      ),
    ),
  ).toMatchObject({ _tag: "Left", left: { code: "InvalidRequest" } });
  expect(f.seen).toHaveLength(0);
});

it("serializes concurrent example calls and claims only one dispatch", async () => {
  let claims = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const attempts = yield* Effect.all(
          [turn.actions.execute(execution), turn.actions.execute(execution)].map(Effect.either),
          { concurrency: 2 },
        );
        expect(attempts.filter((result) => result._tag === "Right")).toHaveLength(1);
      }),
    {
      claimExample: Effect.sync(() => {
        claims++;
      }),
    },
  );
  await f.run();
  expect(claims).toBe(1);
  expect(f.seen).toHaveLength(1);
});

it("preserves possible effects through model failure and denies an unreconciled residual", async () => {
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution).pipe(Effect.either);
        expect(
          yield* Effect.either(turn.actions.execute({ ...execution, purpose: "residual" })),
        ).toMatchObject({ _tag: "Left", left: { code: "ReconciliationRequired" } });
        return yield* new MintFailure({ code: "Unavailable" });
      }),
    { reviewAndExecute: () => Effect.fail(new MintFailure({ code: "Unavailable" })) },
  );
  expect(await f.run()).toMatchObject({
    build: "incomplete",
    example: { status: "failed", effect: "possible" },
  });
});

it("does not publish model prose, skipped tests or a missing actual result", async () => {
  const f = await fixture((turn) =>
    Effect.gen(function* () {
      yield* turn.actions.execute({ ...execution, purpose: "test" });
      expect(JSON.parse(yield* turn.actions.finish(publication))).toMatchObject({
        status: "not_published",
        code: "PublicationUnavailable",
        userInputRequired: false,
      });
    }),
  );
  expect(await f.run()).toMatchObject({ build: "incomplete" });
});

it("records uncertain authentication separately without claiming the business example", async () => {
  let claims = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const failed = yield* Effect.exit(
          turn.actions.execute({ ...execution, purpose: "authenticate", target: "liveBrowser" }),
        );
        expect(failed._tag).toBe("Failure");
      }),
    {
      claimExample: Effect.sync(() => {
        claims++;
      }),
      reviewAndExecute: () => Effect.die(new Error("auth executor lost after login dispatch")),
    },
  );
  const result = await f.run();
  expect(result.executions).toMatchObject([
    {
      status: "failed",
      effect: "not_sent",
      authentication: { state: "failed", effect: "possible" },
    },
  ]);
  expect(claims).toBe(0);
  expect(result.build).toBe("incomplete");
});

it("records possible effects when an executor defects after the durable example claim", async () => {
  let claims = 0;
  let dispatches = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const failed = yield* Effect.exit(turn.actions.execute(execution));
        expect(failed._tag).toBe("Failure");
        expect(yield* Effect.either(turn.actions.execute(execution))).toMatchObject({
          _tag: "Left",
          left: { code: "AlreadyExecuted" },
        });
      }),
    {
      claimExample: Effect.sync(() => {
        claims++;
      }),
      reviewAndExecute: () =>
        Effect.sync(() => {
          dispatches++;
        }).pipe(Effect.zipRight(Effect.die(new Error("synthetic executor defect")))),
    },
  );
  const result = await f.run();
  expect(result).toMatchObject({
    build: "incomplete",
    example: { status: "failed", effect: "possible" },
  });
  expect(result.example).not.toHaveProperty("preflight");
  expect(result.executions).toHaveLength(1);
  expect(claims).toBe(1);
  expect(dispatches).toBe(1);
});

it.each(["example", "command"] as const)(
  "joins pending %s tool cleanup before returning an incomplete mint",
  async (kind) => {
    const started = Promise.withResolvers<void>();
    let cleaned = false;
    let lateRun: MintTurn["runTool"] | undefined;
    let pending: Promise<unknown> | undefined;
    const f = await fixture(
      (turn) =>
        Effect.gen(function* () {
          lateRun = turn.runTool;
          pending =
            kind === "example"
              ? turn.runTool(turn.actions.execute(execution))
              : turn.session.execCommand?.({ cmd: "node src/probe.js" });
          if (!pending) return yield* new MintFailure({ code: "Unavailable" });
          pending.catch(() => undefined);
          yield* Effect.promise(() => started.promise);
          return yield* new MintFailure({ code: "Unavailable" });
        }),
      {
        reviewAndExecute: (_input, dispatch = () => Effect.void) =>
          dispatch(readAllow).pipe(
            Effect.zipRight(Effect.sync(() => started.resolve())),
            Effect.zipRight(Effect.never),
            Effect.ensuring(
              Effect.sleep("20 millis").pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    cleaned = true;
                  }),
                ),
              ),
            ),
          ),
      },
    );
    const result = await f.run();
    expect(result.build).toBe("incomplete");
    expect(cleaned).toBe(true);
    await expect(pending).rejects.toBeDefined();
    if (kind === "example")
      expect(result.example).toMatchObject({ status: "failed", effect: "possible" });
    if (!lateRun) throw new Error("Expected callback bridge");
    let lateEffect = false;
    await expect(
      lateRun(
        Effect.sync(() => {
          lateEffect = true;
        }),
      ),
    ).rejects.toBeDefined();
    expect(lateEffect).toBe(false);
  },
);

it("parent cancellation waits for an independently invoked SDK execution tool to stop", async () => {
  const started = Promise.withResolvers<void>();
  let cleaned = false;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        turn.runTool(turn.actions.execute(execution)).catch(() => undefined);
        return yield* Effect.never;
      }),
    {
      reviewAndExecute: (_input, dispatch = () => Effect.void) =>
        dispatch(readAllow).pipe(
          Effect.zipRight(Effect.sync(() => started.resolve())),
          Effect.zipRight(Effect.never),
          Effect.ensuring(
            Effect.sleep("20 millis").pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  cleaned = true;
                }),
              ),
            ),
          ),
        ),
    },
  );
  const fiber = Effect.runFork(
    runMint(request).pipe(Effect.provideService(MintServices, f.dependencies)),
  );
  await started.promise;
  await Effect.runPromise(Fiber.interrupt(fiber));
  expect(cleaned).toBe(true);
});

it("confines source and edit paths to the workspace", async () => {
  const f = await fixture((turn) =>
    Effect.gen(function* () {
      for (const path of ["../outside", "/etc/passwd", "src/link.ts"])
        expect(yield* Effect.either(turn.actions.readSource(path))).toMatchObject({ _tag: "Left" });
      const editor = turn.session.createEditor?.();
      if (!editor) return yield* new MintFailure({ code: "Unavailable" });
      const write = yield* Effect.promise(() =>
        editor.createFile({
          type: "create_file",
          path: "runtime/changed.txt",
          diff: "+changed\n",
        }),
      );
      expect(write).toMatchObject({ status: "failed" });
    }),
  );
  await f.run();
});

it("native shell delegates each command to reviewed offline execution and rejects TTY", async () => {
  const f = await fixture((turn) =>
    Effect.gen(function* () {
      if (!turn.session.execCommand) return yield* new MintFailure({ code: "Unavailable" });
      const exec = turn.session.execCommand.bind(turn.session);
      yield* Effect.promise(() => exec({ cmd: "node src/probe.js" }));
      yield* Effect.promise(() => exec({ cmd: "node src/probe.js" }));
      yield* Effect.promise(async () => {
        await expect(turn.session.execCommand?.({ cmd: "sh", tty: true })).rejects.toBeDefined();
      });
    }),
  );
  await f.run();
  expect(f.seen).toEqual([
    { purpose: "command", target: "pureFiles", command: "node src/probe.js" },
    { purpose: "command", target: "pureFiles", command: "node src/probe.js" },
  ]);
});

it("ends the build as no_response when the host's sign-in request goes unanswered", async () => {
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        expect(
          JSON.parse(
            yield* turn.actions.execute({
              ...execution,
              purpose: "authenticate",
              target: "liveBrowser",
            }),
          ),
        ).toMatchObject({ status: "no_response" });
        expect(turn.isComplete()).toBe(true);
      }),
    {
      reviewAndExecute: (submitted) =>
        submitted.purpose === "authenticate"
          ? Effect.fail(unanswered())
          : Effect.succeed({
              executionId: "execution_one",
              status: "completed" as const,
              effect: "verified" as const,
              resultRef: "private-result-ref",
              observations: "done",
            }),
    },
  );
  // A write build whose example may have reached the site says so.
  expect(await f.run({ ...request, effect: "write" })).toMatchObject({
    build: "incomplete",
    noResponse: { possibleCommit: true },
  });
});

// A login question is the host's alone: the agent's credential request does not decode, so it is
// neither reviewed nor asked, and the attempt goes on.
it("refuses a model-requested credential question without reviewing or asking it", async () => {
  let refused = false;
  let asked = 0;
  let reviews = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        expect(
          JSON.parse(
            yield* turn.actions.requestInput({
              questions: [
                {
                  id: "login",
                  type: "credential",
                  prompt: "Send the website password again",
                  fields: "password",
                  reason: "invalid_credentials",
                  allowSave: false,
                  siteOrigin: "https://example.com",
                },
              ],
            }),
          ),
        ).toMatchObject({ status: "question_invalid", userInputRequired: false });
        expect(turn.isComplete()).toBe(false);
        refused = true;
      }),
    {
      reviewQuestion: () =>
        Effect.sync(() => {
          reviews++;
          return { outcome: "allow_business" as const, rationale: "Unexpected review." };
        }),
      askInput: () =>
        Effect.sync(() => {
          asked++;
          return {};
        }),
    },
  );
  await f.run();
  expect(refused).toBe(true);
  expect(asked).toBe(0);
  expect(reviews).toBe(0);
});

/** Probe receipts of a site's sign-in path: the public entry, a plan choice and a username page. */
const loginProbe = (executionId: string, page: string) => ({
  executionId,
  status: "completed" as const,
  effect: "verified" as const,
  resultRef: `result-${executionId}`,
  observations: { result: page },
});

it("records how much work ran before a question and whether sign-in was tried", async () => {
  const records: Array<{ readonly name: string; readonly details: unknown }> = [];
  let next = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute({ ...execution, purpose: "explore", target: "liveBrowser" });
        yield* turn.actions.execute({ ...execution, purpose: "explore", target: "liveBrowser" });
        yield* turn.actions.requestInput(
          textQuestion("Which member plan category applies to you?", "plan"),
        );
      }),
    {
      reviewAndExecute: () =>
        Effect.sync(() => loginProbe(`probe_${++next}`, "Account Login Options")),
      reviewQuestion: () =>
        Effect.succeed({
          outcome: "allow_business" as const,
          rationale: "Synthetic question is an ordinary business choice.",
        }),
      askInput: () => Effect.succeed({ plan: { type: "text" as const, value: "individual" } }),
      diagnostics: {
        emit: (name, details) => Effect.sync(() => void records.push({ name, details })),
        retainModelTranscript: () => Effect.void,
        retainScreenedSource: () => Effect.void,
      },
    },
  );
  await f.run();
  expect(records).toContainEqual({
    name: "mint.input_requested",
    details: {
      requestId: expect.any(String) as unknown,
      questionCount: 1,
      reviewOutcome: "allow_business",
      priorExecutions: 2,
      priorLiveExecutions: 2,
      lastExecutionPurpose: "explore",
      authenticateAttempted: false,
    },
  });
});

it("rejects oversized source before screening a truncated secret and screens SDK diagnostics", async () => {
  const f = await fixture((turn) =>
    Effect.gen(function* () {
      expect(yield* Effect.either(turn.actions.readSource("src/oversize.ts"))).toMatchObject({
        _tag: "Left",
      });
      yield* turn.reportDiagnostic("SDK failed: secret-canary");
    }),
  );
  await writeFile(
    join(f.workspace.root, "src/oversize.ts"),
    "x".repeat(8 * 1024 * 1024 - 4) + "secret-canary",
  );
  const result = await f.run();
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).not.toContain("secret-canary");
});

it("retains the exact bounded source diagnostic envelope without replacing the first result", async () => {
  const failure = new MintFailure({
    code: "PublicationUnavailable",
    reason: "source_screening",
    screening: {
      category: "authored_source",
      replacements: 1,
    },
  });
  const f = await fixture(
    (turn) =>
      turn.actions
        .execute(execution)
        .pipe(Effect.zipRight(turn.actions.finish(publication)), Effect.asVoid),
    { publish: () => Effect.fail(failure) },
  );
  const outcome = await f.run();
  expect(outcome.example?.resultRef).toBe("private-result-ref");
  expect(outcome.diagnostics).toEqual([
    JSON.stringify({
      phase: "publication",
      code: failure.code,
      reason: failure.reason,
      screening: failure.screening,
    }),
  ]);
});

it("lets the model correct source after a visible publication rejection without repeating the example", async () => {
  let publications = 0;
  let corrected = false;
  const privateLiteral = "synthetic-customer-record";
  const privateSource = `export const privateExample = '${privateLiteral}';`;
  const failure = new MintFailure({
    code: "ReviewDenied",
    review: {
      outcome: "deny",
      rationale:
        "Remove private literals and shipped private examples; use caller input and prevent private data exports or logging.",
      findings: [
        {
          path: "operation/src/tool.ts",
          byteStart: privateSource.indexOf(privateLiteral),
          byteEnd: privateSource.indexOf(privateLiteral) + privateLiteral.length,
          category: "private_literal",
          explanation: "The source holds a private literal; take the value from the input.",
        },
      ],
    },
  });
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const editor = turn.session.createEditor?.();
        if (!editor) return yield* new MintFailure({ code: "Unavailable" });
        yield* Effect.promise(() =>
          editor.updateFile({
            type: "update_file",
            path: "src/tool.ts",
            diff: `@@\n-export const privateExample = 'secret-canary';\n+${privateSource}\n`,
          }),
        );
        yield* turn.actions.execute(execution);
        const rejected = yield* turn.actions.finish(publication);
        const response = Schema.decodeUnknownSync(
          Schema.Struct({
            status: Schema.Literal("not_published"),
            diagnostic: Schema.String,
            instruction: Schema.String,
          }),
        )(JSON.parse(rejected));
        expect(JSON.parse(response.diagnostic)).toMatchObject({
          code: "ReviewDenied",
          review: failure.review,
        });
        expect(yield* Effect.either(turn.actions.execute(execution))).toMatchObject({
          _tag: "Left",
          left: { code: "AlreadyExecuted" },
        });
        expect(
          yield* Effect.promise(() =>
            editor.updateFile({
              type: "update_file",
              path: "src/tool.ts",
              diff: `@@\n-${privateSource}\n+export default { name: 'corrected' };\n`,
            }),
          ),
        ).toMatchObject({ status: "completed" });
        expect(yield* turn.actions.readSource("src/tool.ts")).toContain("corrected");
        corrected = true;
        yield* turn.actions.finish(publication);
        expect(yield* Effect.either(turn.actions.finish(publication))).toMatchObject({
          _tag: "Left",
          left: { code: "AlreadyExecuted" },
        });
      }),
    {
      publish: () =>
        Effect.suspend(() => {
          publications++;
          return corrected
            ? Effect.succeed({ publicationRef: "corrected-publication", diagnostics: [] })
            : Effect.fail(failure);
        }),
    },
  );
  const result = await f.run();
  expect(result).toMatchObject({
    build: "published",
    publicationRef: "corrected-publication",
    example: { resultRef: "private-result-ref" },
  });
  expect(f.seen).toHaveLength(1);
  expect(publications).toBe(2);
});

// A minter resubmits unchanged after a denial in a host file: a finding in a file the host
// wrote comes back as one the minter cannot fix from source.
it("returns a publication finding in a host-owned file as host_owned, not a source correction", async () => {
  const findings = [
    {
      path: "operation/operation.mjs",
      byteStart: 0,
      byteEnd: 12,
      category: "private_literal" as const,
      explanation: "The host-written entry names a private value.",
    },
  ];
  const failure = new MintFailure({
    code: "ReviewDenied",
    review: {
      outcome: "deny",
      reason: "host_owned",
      reviewId: "review_host_owned",
      rationale: "The host-written entry names a private value; it cannot be fixed from source.",
      findings,
    },
  });
  let response: unknown;
  let publications = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        response = JSON.parse(yield* turn.actions.finish(publication));
      }),
    {
      publish: () =>
        Effect.suspend(() => {
          publications++;
          return Effect.fail(failure);
        }),
    },
  );
  await f.run();
  expect(response).toMatchObject({
    status: "not_published",
    reason: "host_owned",
    findings,
    reviewId: "review_host_owned",
  });
  expect(publications).toBe(1);
});

it("keeps publication authority denial as a hard failure", async () => {
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        expect(yield* Effect.either(turn.actions.finish(publication))).toMatchObject({
          _tag: "Left",
          left: { code: "ScopeDenied" },
        });
      }),
    { publish: () => Effect.fail(new MintFailure({ code: "ScopeDenied" })) },
  );
  expect((await f.run()).build).toBe("incomplete");
});

it("retains screened unsupported capability diagnostics without private fixture identifiers", async () => {
  const f = await fixture(
    (turn) =>
      turn.actions
        .execute({
          ...execution,
          fixtureRefs: ["secret-canary-fixture"],
          caseFilter: ["secret-canary-filter"],
          maxWorkers: 2,
        })
        .pipe(Effect.asVoid),
    {
      reviewAndExecute: () =>
        Effect.succeed({
          executionId: "unsupported_one",
          status: "unsupported",
          effect: "not_sent",
          observations: "Unsupported fixture secret-canary",
        }),
    },
  );
  const result = await f.run();
  expect(result).toMatchObject({
    build: "incomplete",
    example: { status: "unsupported", effect: "not_sent" },
  });
  expect(result.diagnostics).toHaveLength(1);
  expect(JSON.parse(result.diagnostics[0] ?? "null")).toMatchObject({
    phase: "execution",
    purpose: "example",
    target: "pureFiles",
    fixtureCount: 1,
    filterCount: 1,
    maxWorkers: 2,
    status: "unsupported",
  });
  expect(result.diagnostics[0]).not.toContain("secret-canary");
  expect(result.diagnostics[0]).not.toContain("-fixture");
  expect(result.diagnostics[0]).not.toContain("-filter");
});

it("records a typed execution failure without losing uncertain example evidence", async () => {
  const f = await fixture((turn) => turn.actions.execute(execution).pipe(Effect.asVoid), {
    reviewAndExecute: () => Effect.fail(new MintFailure({ code: "ScopeDenied" })),
  });
  const result = await f.run();
  expect(result).toMatchObject({
    build: "incomplete",
    example: { status: "failed", effect: "possible" },
  });
  expect(result.diagnostics).toEqual([
    JSON.stringify({
      phase: "execution",
      purpose: "example",
      target: "pureFiles",
      fixtureCount: 0,
      filterCount: 0,
      maxWorkers: 1,
      code: "ScopeDenied",
    }),
  ]);
});

// An observation failure keeps only its coarse reason, never a runtime subtype.
it("keeps only the coarse observation reason and omits runtime provenance", async () => {
  const failure = new MintFailure({
    code: "ScopeDenied",
    destinationReason: "observation_unavailable",
  });
  Object.defineProperty(failure, "destinationObservationReason", {
    value: "private-runtime-canary",
    enumerable: true,
  });
  const observed = await fixture((turn) => turn.actions.execute(execution).pipe(Effect.asVoid), {
    reviewAndExecute: () => Effect.fail(failure),
  });
  const result = await observed.run();
  expect(JSON.parse(result.diagnostics[0] ?? "null")).toMatchObject({
    phase: "execution",
    code: "ScopeDenied",
    destinationReason: "observation_unavailable",
  });
  expect(result.diagnostics[0]).not.toContain("destinationObservationReason");
  expect(result.diagnostics[0]).not.toContain("private-runtime-canary");
});

it("rejects unsupported mechanics before the one-use example claim, then accepts one corrected example", async () => {
  let claims = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const unsupported = yield* turn.actions.execute({
          ...execution,
          fixtureRefs: ["secret-canary-fixture"],
        });
        expect(JSON.parse(unsupported)).toMatchObject({
          status: "unsupported",
          effect: "not_sent",
          preflight: "rejected_before_claim",
        });
        expect(claims).toBe(0);
        const completed = yield* turn.actions.execute(execution);
        expect(JSON.parse(completed)).not.toHaveProperty("preflight");
        expect(claims).toBe(1);
        expect(
          yield* Effect.either(
            turn.actions.execute({ ...execution, fixtureRefs: ["unsupported-late"] }),
          ),
        ).toMatchObject({ _tag: "Left", left: { code: "AlreadyExecuted" } });
        expect(yield* Effect.either(turn.actions.execute(execution))).toMatchObject({
          _tag: "Left",
        });
      }),
    {
      preflight: (input) =>
        Effect.succeed(
          input.fixtureRefs.length
            ? { supported: false as const, reason: "Unsupported fixture secret-canary" }
            : { supported: true as const },
        ),
      claimExample: Effect.sync(() => {
        claims++;
      }),
    },
  );
  const result = await f.run();
  expect(claims).toBe(1);
  expect(f.seen).toHaveLength(1);
  expect(result.example).toMatchObject({ status: "completed", resultRef: "private-result-ref" });
  expect(result.example).not.toHaveProperty("preflight");
  expect(result.diagnostics[0]).toContain("Unsupported fixture");
  expect(result.diagnostics[0]).not.toContain("secret-canary");
});

it("does not label a post-claim unsupported receipt as safely correctable or permit another claim", async () => {
  let claims = 0;
  let executions = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const receipt = yield* turn.actions.execute(execution);
        expect(JSON.parse(receipt)).not.toHaveProperty("preflight");
        expect(yield* Effect.either(turn.actions.execute(execution))).toMatchObject({
          _tag: "Left",
          left: { code: "AlreadyExecuted" },
        });
      }),
    {
      claimExample: Effect.sync(() => {
        claims++;
      }),
      reviewAndExecute: () =>
        Effect.sync(() => {
          executions++;
          return {
            executionId: "post_claim_receipt",
            status: "unsupported" as const,
            effect: "not_sent" as const,
            preflight: "rejected_before_claim",
            observations: "Host response after the durable claim",
          };
        }),
    },
  );
  const outcome = await f.run();
  expect(outcome.example).not.toHaveProperty("preflight");
  expect(claims).toBe(1);
  expect(executions).toBe(1);
});

it("records a safe finish rejection reason without replacing the completed example", async () => {
  const f = await fixture((turn) =>
    Effect.gen(function* () {
      yield* turn.actions.execute(execution);
      yield* turn.actions.finish({ ...publication, executionId: "unrecognized-receipt" });
    }),
  );
  const result = await f.run();
  expect(result.example).toMatchObject({ status: "completed", resultRef: "private-result-ref" });
  expect(result.diagnostics).toEqual([
    JSON.stringify({
      phase: "publication",
      code: "PublicationUnavailable",
      reason: "missing_receipt",
    }),
  ]);
});

it.each([
  { executionId: "https://private.invalid/id", checks: undefined },
  {
    executionId: "host-issued-receipt",
    checks: { passed: 1.5, failed: 0, skipped: 0, unsupported: 0, liveSiteTouched: false },
  },
])("validates host receipt metadata before exposing it", async (metadata) => {
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        expect(yield* Effect.either(turn.actions.execute(execution))).toMatchObject({
          _tag: "Left",
          left: { code: "InvalidRequest" },
        });
      }),
    {
      reviewAndExecute: () =>
        Effect.succeed({
          executionId: metadata.executionId,
          ...(metadata.checks ? { checks: metadata.checks } : {}),
          status: "completed",
          effect: "not_sent",
          resultRef: "private-result-ref",
          observations: "secret-canary",
        }),
    },
  );
  expect((await f.run()).build).toBe("incomplete");
});

it("never publishes Guardian's input-feedback fallback after the claimed attempt is revoked", async () => {
  let revoked = false;
  let fallbackPublications = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        expect(JSON.parse(yield* turn.actions.finish(publication))).toMatchObject({
          status: "not_published",
          reason: "input_feedback",
        });
        // The attempt is revoked after the feedback round, and the minter stops without fixing it.
        revoked = true;
      }),
    {
      attemptRevoked: () => revoked,
      publish: () =>
        Effect.fail(
          new MintFailure({
            code: "ReviewDenied",
            review: {
              outcome: "escalate",
              reason: "input_feedback",
              reviewId: "review_one",
              rationale: "Correct the indicated input.",
              findings: [
                {
                  path: "publication/definition.json",
                  byteStart: 0,
                  byteEnd: 1,
                  category: "account_specific_enum",
                  explanation: "Correct the indicated input.",
                },
              ],
            },
          }),
        ),
      inputFeedbackFallback: {
        kept: () => true,
        flagPublished: Effect.void,
        publish: Effect.sync(() => {
          fallbackPublications++;
          return {
            publicationRef: "fallback-revision",
            diagnostics: [],
            categories: ["account_specific_enum"],
          };
        }),
      },
    },
  );
  const outcome = await f.run();
  expect(fallbackPublications).toBe(0);
  expect(outcome.build).toBe("incomplete");
  expect(outcome.diagnostics.map((entry): unknown => JSON.parse(entry))).toContainEqual({
    phase: "attempt",
    reason: "stopped",
  });
});

/** A publication review that returns input feedback with these categories. */
const inputFeedback = (...categories: ("account_specific_enum" | "input_option")[]) =>
  new MintFailure({
    code: "ReviewDenied",
    review: {
      outcome: "deny",
      reason: "input_feedback",
      reviewId: "review_feedback",
      rationale: "Make the account an input.",
      findings: categories.map((category) => ({
        path: "publication/definition.json",
        byteStart: 0,
        byteEnd: 1,
        category,
        explanation: "The account input lists one value; make it free-form.",
      })),
    },
  });
const noFallbackEnding = "the build ends unpublished and reports Guardian's findings to the owner";
const unresolvedSummary =
  "Not built: Guardian's input feedback on this tool's schema was not resolved (account_specific_enum, input_option). Guardian's rationale: Make the account an input.";

/** The publication as the minter resubmits it after a feedback round, with its input corrected. */
const correctedPublication = (round: number) => ({
  ...publication,
  metadata: { ...publication.metadata, description: `Read invoices (revision ${round})` },
});

it("ends a build with no fallback unpublished once input feedback outlasts its two rounds", async () => {
  const replies: Record<string, unknown>[] = [];
  let publications = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        for (let round = 0; round < 3; round++)
          replies.push(JSON.parse(yield* turn.actions.finish(correctedPublication(round))));
      }),
    {
      publish: () =>
        Effect.suspend(() => {
          publications++;
          return Effect.fail(inputFeedback("account_specific_enum", "input_option"));
        }),
    },
  );
  const outcome = await f.run();
  expect(publications).toBe(3);
  expect(replies.map((reply) => [reply["reason"], reply["feedbackRoundsRemaining"]])).toEqual([
    ["input_feedback", 1],
    ["input_feedback", 0],
    ["input_feedback_unresolved", undefined],
  ]);
  expect(String(replies[0]?.["instruction"])).toContain(
    `If input findings remain after 1 more feedback round, or the build ends first, ${noFallbackEnding}.`,
  );
  expect(String(replies[1]?.["instruction"])).toContain(
    `This was the last feedback round: if the next review still finds input problems, ${noFallbackEnding}.`,
  );
  expect(outcome).toMatchObject({ build: "incomplete", summary: unresolvedSummary });
  expect(outcome.artifact).toBeUndefined();
});

it("ends a build with no fallback on the last review's input feedback when the minter stops first", async () => {
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        yield* turn.actions.finish(publication);
      }),
    { publish: () => Effect.fail(inputFeedback("account_specific_enum", "input_option")) },
  );
  expect(await f.run()).toMatchObject({ build: "incomplete", summary: unresolvedSummary });
});

it("reports no input feedback a later completed review replaced", async () => {
  let publications = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        yield* turn.actions.finish(publication);
        yield* turn.actions.finish(correctedPublication(1));
      }),
    {
      publish: () =>
        Effect.fail(
          publications++ === 0
            ? inputFeedback("account_specific_enum")
            : new MintFailure({
                code: "ReviewDenied",
                review: {
                  outcome: "deny",
                  reason: "privacy",
                  reviewId: "review_privacy",
                  rationale: "Remove the literal.",
                },
              }),
        ),
    },
  );
  const outcome = await f.run();
  expect(outcome.build).toBe("incomplete");
  expect(outcome.summary).not.toContain("input feedback");
});

// A host with its own fallback sees the harness as before the local publication review: the same
// instruction, one rationale screening per feedback round and no input-feedback record in its
// snapshots.
it("keeps a fallback host's instructions, screenings and snapshots", async () => {
  const replies: Record<string, unknown>[] = [];
  const snapshots: MintHarnessSnapshot[] = [];
  let capture: (() => MintHarnessSnapshot) | undefined;
  let screenings = 0;
  /** How often each finish_build screened the review's rationale. */
  const perRound: number[] = [];
  const projection = portableMintProjection();
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        for (let round = 0; round < 3; round++) {
          const before = screenings;
          replies.push(JSON.parse(yield* turn.actions.finish(correctedPublication(round))));
          perRound.push(screenings - before);
          if (capture !== undefined) snapshots.push(capture());
        }
      }),
    {
      projection: {
        ...projection,
        text: (value, area) => {
          if (value === "Make the account an input.") screenings++;
          return projection.text(value, area);
        },
      },
      agentRecovery: {
        bindHarness: (bound) =>
          Effect.sync(() => {
            capture = bound;
          }),
        save: () => Effect.void,
      },
      publish: () => Effect.fail(inputFeedback("account_specific_enum")),
      inputFeedbackFallback: {
        kept: () => true,
        flagPublished: Effect.void,
        publish: Effect.succeed(undefined),
      },
    },
  );
  await f.run();
  expect(String(replies[0]?.["instruction"])).toContain(
    "If input findings remain after 1 more feedback round, or the build ends first, the host publishes the last reviewed version privately to this account and flags it.",
  );
  expect(String(replies[0]?.["instruction"])).not.toContain(noFallbackEnding);
  expect(replies[2]?.["reason"]).toBe("input_feedback_unresolved");
  // As before, the round past the limit screens the rationale once fewer: its reply omits it.
  expect(perRound).toEqual([2, 2, 1]);
  expect(snapshots).toHaveLength(3);
  for (const snapshot of snapshots) expect(snapshot).not.toHaveProperty("inputFeedbackReview");
});

it("joins an in-flight editor promise before asking and refuses edits after the build ends", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let asked = false;
  let pending: Promise<unknown> | undefined;
  let writeFinished = false;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        pending = turn.session
          .createEditor?.()
          .createFile({ type: "create_file", path: "src/slow.ts", diff: "+export const value=1;" });
        if (!pending) return yield* new MintFailure({ code: "Unavailable" });
        yield* Effect.promise(() => started.promise);
        const request = turn.runTool(turn.actions.requestInput(textQuestion("Choose format")));
        release.resolve();
        expect(JSON.parse(yield* Effect.promise(() => request))).toMatchObject({
          status: "no_response",
        });
        const late = yield* Effect.promise(
          () =>
            turn.session.createEditor?.().createFile({
              type: "create_file",
              path: "src/late.ts",
              diff: "+export const late=1;",
            }) ?? Promise.resolve(undefined),
        );
        expect(late?.status).toBe("failed");
      }),
    {
      askInput: () =>
        Effect.suspend(() => {
          // The question waits for the edit that was already running.
          expect(writeFinished).toBe(true);
          asked = true;
          return Effect.fail(unanswered());
        }),
    },
  );
  const original = f.dependencies.workspace.createEditor?.bind(f.dependencies.workspace);
  if (!original) throw new Error("Editor required");
  const editor = original.call(f.dependencies.workspace);
  f.dependencies.workspace.createEditor = () => ({
    ...editor,
    createFile: async (operation) => {
      started.resolve();
      await release.promise;
      const result = await editor.createFile(operation);
      writeFinished = true;
      return result;
    },
  });
  // A write repair's unanswered question still ends the build, so later edits are refused.
  expect(await f.run({ ...request, mode: "maintenance", effect: "write" })).toMatchObject({
    build: "incomplete",
    noResponse: { possibleCommit: false },
  });
  await pending;
  expect(asked).toBe(true);
});

it("answers request_input in place through the actual pinned Runner and SandboxAgent with low reasoning", async () => {
  const effort = "low";
  const requests: ModelRequest[] = [];
  const { makeOpenAIMinter } = await import("../../src/mint/openai.js");
  const { Usage } = await import("@openai/agents");
  let calls = 0;
  const model = makeOpenAIMinter(
    {
      getModel: (name) => {
        expect(name).toBe(solModel);
        return {
          getResponse: async (request) => {
            requests.push(request);
            calls++;
            return {
              usage: new Usage(),
              output: [
                {
                  type: "function_call" as const,
                  callId: `request_${calls}`,
                  name: "request_input",
                  arguments: JSON.stringify({
                    questions: [
                      { id: `format_${calls}`, type: "text", prompt: "Which output format?" },
                    ],
                    intent: "Ask which output format the user needs.",
                  }),
                  status: "completed" as const,
                },
              ],
            };
          },
          getStreamedResponse: () => {
            throw new Error("Streaming unused");
          },
        };
      },
    },
    effort,
  );
  const asked: unknown[] = [];
  const f = await fixture(() => Effect.void, {
    model,
    skills: [
      {
        name: "core",
        description: "Synthetic SDK fixture",
        content: "Use request_input for clarification.",
      },
    ],
    // The first request is answered in place; the second goes unanswered, which ends a write
    // repair.
    askInput: (submitted) =>
      Effect.suspend(() => {
        asked.push(submitted);
        return asked.length === 1
          ? Effect.succeed({
              format_1: { type: "text" as const, value: "semicolon_values_answer" },
            })
          : Effect.fail(unanswered());
      }),
  });
  const outcome = await f.run({ ...request, mode: "maintenance", effect: "write" });
  expect(outcome).toMatchObject({
    build: "incomplete",
    noResponse: { possibleCommit: false },
    diagnostics: [],
  });
  // The intent stays with the model adapter; the host is asked the typed request alone.
  expect(asked).toEqual([
    { questions: [{ id: "format_1", type: "text", prompt: "Which output format?" }] },
    { questions: [{ id: "format_2", type: "text", prompt: "Which output format?" }] },
  ]);
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[0]?.input)).not.toContain("semicolon_values_answer");
  const sent = JSON.stringify(requests[1]?.input);
  expect(sent).toContain("request_1");
  expect(sent).toContain("function_call_result");
  expect(sent).toContain("semicolon_values_answer");
  expect(sent).not.toContain("secret-canary");
  expect(requests[0]?.modelSettings.store).toBe(false);
  // Minting requests provider-readable summaries and all-turns reasoning context.
  expect(requests[0]?.modelSettings.reasoning).toEqual({
    effort,
    summary: "auto",
    context: "all_turns",
  });
  expect(f.seen).toHaveLength(0);
}, 30_000);

it("asks after a write example whose effect is possible and continues with the answer", async () => {
  const asked: unknown[] = [];
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        expect(JSON.parse(yield* turn.actions.execute(execution))).toMatchObject({
          status: "failed",
          effect: "possible",
        });
        // An uncertain write does not block asking: the caller may know what happened.
        expect(
          JSON.parse(
            yield* turn.actions.requestInput(textQuestion("Did an order appear?", "seen")),
          ),
        ).toMatchObject({ status: "answered", answers: { seen: "no order yet" } });
        expect(turn.isComplete()).toBe(false);
        // Left unanswered, the second question goes back to the minter, and the build goes on.
        expect(
          JSON.parse(yield* turn.actions.requestInput(textQuestion("Retry now?", "retry"))),
        ).toMatchObject({ status: "no_answer", userInputRequired: false });
        expect(turn.isComplete()).toBe(false);
      }),
    {
      reviewAndExecute: () =>
        Effect.succeed({
          executionId: "uncertain",
          status: "failed",
          effect: "possible",
          observations: "Result unknown",
        }),
      askInput: (submitted) =>
        Effect.suspend(() => {
          asked.push(submitted);
          return asked.length === 1
            ? Effect.succeed({ seen: { type: "text" as const, value: "no order yet" } })
            : Effect.fail(unanswered());
        }),
    },
  );
  // The uncertain write stays on the outcome; the unanswered question did not end the build.
  const outcome = await f.run({ ...request, effect: "write" });
  expect(outcome).toMatchObject({ build: "incomplete", example: { effect: "possible" } });
  expect(outcome).not.toHaveProperty("noResponse");
  expect(asked).toHaveLength(2);
});

// Only an observation failure's coarse reason reaches the model; runtime provenance never does.
it("projects only the coarse observation reason into the pinned model tool failure", async () => {
  const { makeOpenAIMinter } = await import("../../src/mint/openai.js");
  const { Usage } = await import("@openai/agents");
  const requests: ModelRequest[] = [];
  const failure = new MintFailure({
    code: "ScopeDenied",
    destinationReason: "observation_unavailable",
  });
  Object.defineProperty(failure, "destinationObservationReason", {
    value: "private-runtime-canary",
    enumerable: true,
  });
  const f = await fixture(() => Effect.void, {
    skills: [{ name: "core", description: "Synthetic SDK fixture", content: "Use execute." }],
    reviewAndExecute: () => Effect.fail(failure),
    model: makeOpenAIMinter({
      getModel: () => ({
        getResponse: async (input) => {
          requests.push(input);
          if (requests.length > 1) throw new Error("fixture-stop-after-tool-feedback");
          return {
            usage: new Usage(),
            output: [
              {
                type: "function_call" as const,
                callId: "explore_once",
                name: "execute",
                arguments: JSON.stringify({
                  ...execution,
                  purpose: "explore",
                  intent: "Inspect the public page structure.",
                }),
                status: "completed" as const,
              },
            ],
          };
        },
        getStreamedResponse: () => {
          throw new Error("Streaming unused");
        },
      }),
    }),
  });
  await f.run();
  expect(requests).toHaveLength(2);
  const modelInput = JSON.stringify(requests[1]);
  expect(modelInput).toContain("tool_failed");
  expect(modelInput).toContain("ScopeDenied");
  expect(modelInput).toContain("observation_unavailable");
  expect(modelInput).not.toContain("destinationObservationReason");
  expect(modelInput).not.toContain("private-runtime-canary");
});

it("leaves typed non-provider and bare unavailable exploration repairable", async () => {
  for (const kind of ["typed", "bare"] as const) {
    let calls = 0;
    const f = await fixture(
      (turn) =>
        Effect.gen(function* () {
          const probe = { ...execution, purpose: "explore" as const };
          const first = yield* Effect.either(turn.actions.execute(probe));
          if (kind === "typed") {
            expect(first).toMatchObject({ _tag: "Right" });
            if (first._tag === "Right")
              expect(JSON.parse(first.right)).toMatchObject({
                status: "execution_unavailable",
                execution: { reason: "invalid_response", dispatch: "unknown" },
              });
          } else expect(first).toMatchObject({ _tag: "Left", left: { code: "Unavailable" } });
          expect(turn.isComplete()).toBe(false);
          expect(JSON.parse(yield* turn.actions.execute(probe))).toMatchObject({
            status: "completed",
          });
        }),
      {
        reviewAndExecute: () =>
          Effect.suspend(() => {
            calls++;
            return calls === 1
              ? Effect.fail(
                  kind === "typed"
                    ? new MintFailure({
                        code: "Unavailable",
                        reason: "executor_unavailable",
                        execution: {
                          phase: "execute",
                          reason: "invalid_response",
                          dispatch: "unknown",
                        },
                      })
                    : new MintFailure({ code: "Unavailable" }),
                )
              : Effect.succeed({
                  executionId: "corrected_explore",
                  status: "completed" as const,
                  effect: "verified" as const,
                  resultRef: "private-result-ref",
                  observations: "Corrected read",
                });
          }),
      },
    );
    expect(await f.run()).toMatchObject({ build: "incomplete" });
    expect(calls).toBe(2);
  }
});

it("publishes a finished example after the execution host becomes unavailable", async () => {
  let availability = "open" as "open" | "host_unavailable";
  let publications = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        expect(JSON.parse(yield* turn.actions.execute(execution))).toMatchObject({
          status: "completed",
        });
        availability = "host_unavailable";
        // Live execution is over, but the retained example keeps the attempt open.
        expect(turn.isComplete()).toBe(false);
        const refused: unknown = JSON.parse(
          yield* turn.actions.execute({ ...execution, purpose: "explore" }),
        );
        expect(refused).toMatchObject({
          status: "execution_unavailable",
          executionAvailability: "host_unavailable",
        });
        expect(turn.isComplete()).toBe(false);
        // Asking needs no live execution, so it stays available for publication details.
        expect(
          JSON.parse(yield* turn.actions.requestInput(textQuestion("Public tool name?", "name"))),
        ).toMatchObject({ status: "answered", answers: { name: "invoices" } });
        expect(turn.isComplete()).toBe(false);
        yield* turn.actions.finish(publication);
        expect(turn.isComplete()).toBe(true);
      }),
    {
      executionAvailability: () => availability,
      askInput: () => Effect.succeed({ name: { type: "text" as const, value: "invoices" } }),
      publish: () =>
        Effect.sync(() => {
          publications++;
          return { publicationRef: "published-after-host-loss", diagnostics: [] };
        }),
    },
  );
  expect(await f.run()).toMatchObject({
    build: "published",
    publicationRef: "published-after-host-loss",
  });
  expect(publications).toBe(1);
  expect(f.seen).toHaveLength(1);
});

it("does not offer an execution review retry once live execution has ended", async () => {
  let availability = "open" as "open" | "host_unavailable";
  let calls = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        // The host is lost while Guardian reviews a later exploration.
        const feedback: unknown = JSON.parse(
          yield* turn.actions.execute({ ...execution, purpose: "explore" }),
        );
        expect(feedback).toMatchObject({
          status: "review_unavailable",
          retryable: false,
          executionAvailability: "host_unavailable",
        });
        expect(feedback).not.toHaveProperty("retriesRemaining");
        expect(turn.isComplete()).toBe(false);
        yield* turn.actions.finish(publication);
        expect(turn.isComplete()).toBe(true);
      }),
    {
      executionAvailability: () => availability,
      reviewAndExecute: (input) =>
        Effect.suspend(() => {
          calls++;
          if (input.purpose === "example")
            return Effect.succeed({
              executionId: "execution_one",
              status: "completed" as const,
              effect: "verified" as const,
              resultRef: "private-result-ref",
              observations: "Completed example",
            });
          availability = "host_unavailable";
          return Effect.fail(
            new MintFailure({
              code: "ReviewUnavailable",
              reviewFailure: "Unavailable",
              reviewDispatch: "not_sent",
            }),
          );
        }),
    },
  );
  expect(await f.run()).toMatchObject({ build: "published" });
  expect(calls).toBe(2);
});

it("still retries and asks a question after live execution has ended", async () => {
  let availability = "open" as "open" | "host_unavailable";
  let questionReviews = 0;
  let asked = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        // The host is lost while Guardian reviews a question; asking stays open.
        const feedback: unknown = JSON.parse(
          yield* turn.actions.requestInput(textQuestion("Which account type?")),
        );
        expect(feedback).toMatchObject({
          status: "review_unavailable",
          retryable: true,
          executionAvailability: "host_unavailable",
        });
        const retried: unknown = JSON.parse(
          yield* turn.actions.requestInput(textQuestion("Which account type?")),
        );
        expect(retried).toMatchObject({ status: "answered", answers: { answer: "Checking" } });
        yield* turn.actions.finish(publication);
        expect(turn.isComplete()).toBe(true);
      }),
    {
      executionAvailability: () => availability,
      reviewQuestion: () =>
        Effect.suspend(() => {
          questionReviews++;
          if (questionReviews > 1)
            return Effect.succeed({
              outcome: "allow_business" as const,
              rationale: "Business choice.",
            });
          availability = "host_unavailable";
          return Effect.fail(
            new MintFailure({ code: "ReviewUnavailable", reviewFailure: "Unavailable" }),
          );
        }),
      askInput: () =>
        Effect.sync(() => {
          asked++;
          return { answer: { type: "text" as const, value: "Checking" } };
        }),
    },
  );
  expect(await f.run()).toMatchObject({ build: "published" });
  expect(questionReviews).toBe(2);
  expect(asked).toBe(1);
});

it("appends a finite host outage cause once", async () => {
  const cause = {
    diagnostics: [
      {
        phase: "execution",
        purpose: "explore",
        target: "liveBrowser",
        status: "failed",
        effect: "possible",
        errorCode: "DeadlineExceeded",
      },
      { phase: "background_policy", code: "ScopeDenied" },
    ],
  };
  let availability = "open" as "open" | "host_unavailable";
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute({ ...execution, purpose: "explore" });
        availability = "host_unavailable";
        expect(turn.isComplete()).toBe(true);
        expect(turn.isComplete()).toBe(true);
        expect(
          JSON.parse(yield* turn.actions.execute({ ...execution, purpose: "explore" })),
        ).toMatchObject({
          status: "execution_unavailable",
          executionAvailability: "host_unavailable",
        });
      }),
    {
      executionAvailability: () => availability,
      unavailableHostCause: () => (availability === "host_unavailable" ? cause : undefined),
    },
  );
  const outcome = await f.run();
  expect(outcome.diagnostics.map((entry): unknown => JSON.parse(entry))).toEqual(cause.diagnostics);
});

it("reports a background host outage that follows the last tool call", async () => {
  const cause = {
    reason: "review_unavailable" as const,
    diagnostics: [{ phase: "background_policy", code: "ScopeDenied" }],
  };
  let availability = "open" as "open" | "host_unavailable";
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute({ ...execution, purpose: "explore" });
        // The host is poisoned after the last tool returns; the model then ends
        // without another tool call or completion check.
        availability = "host_unavailable";
      }),
    {
      executionAvailability: () => availability,
      unavailableHostCause: () => (availability === "host_unavailable" ? cause : undefined),
    },
  );
  const outcome = await f.run();
  expect(outcome.build).toBe("incomplete");
  expect(outcome.diagnostics.map((entry): unknown => JSON.parse(entry))).toEqual(cause.diagnostics);
});

it("keeps a stronger terminal outcome when the host is poisoned afterwards", async () => {
  let availability = "open" as "open" | "host_unavailable";
  const time = steppedClock();
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        // Reviews unavailable past the outage budget end the attempt.
        for (let attempt = 0; attempt < 3; attempt++) {
          yield* turn.actions.execute({ ...execution, purpose: "explore" });
          time.advance(8 * 60_000);
        }
        expect(turn.isComplete()).toBe(true);
        availability = "host_unavailable";
      }).pipe(Effect.withClock(time.clock)),
    {
      executionAvailability: () => availability,
      unavailableHostCause: () =>
        availability === "host_unavailable"
          ? { diagnostics: [{ phase: "background_policy", code: "ScopeDenied" }] }
          : undefined,
      reviewAndExecute: () =>
        Effect.fail(
          new MintFailure({
            code: "ReviewUnavailable",
            reviewFailure: "Unavailable",
            reviewDispatch: "not_sent",
          }),
        ),
    },
  );
  const outcome = await f.run();
  expect(outcome.build).toBe("incomplete");
  expect(JSON.stringify(outcome.diagnostics)).not.toContain("background_policy");
});

it("omits availability for a host that does not report it and stops on asynchronous poison", async () => {
  const withoutHost = await fixture((turn) =>
    Effect.sync(() => {
      const input: unknown = JSON.parse(turn.input);
      expect(input).toMatchObject({ executionContext: { repeatableRead: false } });
      if (input === null || typeof input !== "object" || !("executionContext" in input))
        throw new Error("Missing execution context");
      expect(input.executionContext).not.toHaveProperty("executionAvailability");
      expect(turn.isComplete()).toBe(false);
    }),
  );
  expect(await withoutHost.run()).toMatchObject({ build: "incomplete" });

  let availability = "open" as "open" | "host_unavailable";
  const unavailableHost = { repeatableRead: false, executionAvailability: () => availability };
  const withHost = await fixture(
    (turn) =>
      Effect.sync(() => {
        expect(turn.isComplete()).toBe(false);
        availability = "host_unavailable";
        expect(turn.isComplete()).toBe(true);
      }),
    unavailableHost,
  );
  expect(await withHost.run()).toMatchObject({ build: "incomplete" });
  expect(withHost.seen).toHaveLength(0);
});

it.each(["metadata_free", "host_poison"] as const)(
  "stops the pinned SDK loop after one %s host failure",
  async (kind) => {
    const { makeOpenAIMinter } = await import("../../src/mint/openai.js");
    const { Usage } = await import("@openai/agents");
    const requests: ModelRequest[] = [];
    let executions = 0;
    let availability = "open" as "open" | "host_unavailable";
    const f = await fixture(() => Effect.void, {
      skills: [{ name: "core", description: "Synthetic SDK fixture", content: "Use execute." }],
      ...(kind === "host_poison" ? { executionAvailability: () => availability } : {}),
      reviewAndExecute: (_request, beforeDispatch = () => Effect.void) =>
        beforeDispatch(readAllow).pipe(
          Effect.zipRight(
            Effect.sync(() => {
              executions++;
              if (kind === "host_poison") availability = "host_unavailable";
            }),
          ),
          Effect.zipRight(
            Effect.fail(
              kind === "host_poison"
                ? new MintFailure({
                    code: "ScopeDenied",
                    destinationReason: "observation_unavailable",
                  })
                : new MintFailure({ code: "Unavailable", reason: "executor_unavailable" }),
            ),
          ),
        ),
      model: makeOpenAIMinter({
        getModel: () => ({
          getResponse: async (input) => {
            requests.push(input);
            return {
              usage: new Usage(),
              output:
                requests.length === 1
                  ? [
                      {
                        type: "function_call" as const,
                        callId: "browser_open_once",
                        name: "execute",
                        arguments: JSON.stringify({
                          ...execution,
                          purpose: "example",
                          intent: "Run the host-bound example once.",
                        }),
                        status: "completed" as const,
                      },
                    ]
                  : [
                      {
                        type: "message" as const,
                        role: "assistant" as const,
                        status: "completed" as const,
                        content: [{ type: "output_text" as const, text: "Try again." }],
                      },
                    ],
            };
          },
          getStreamedResponse: () => {
            throw new Error("Streaming unused");
          },
        }),
      }),
    });
    const outcome = await f.run();
    expect(outcome).toMatchObject({
      build: "incomplete",
      example: { status: "failed", effect: "possible" },
    });
    expect(executions).toBe(1);
    expect(requests).toHaveLength(1);
    const diagnostics = JSON.stringify(outcome.diagnostics);
    expect(diagnostics).not.toContain("model_final_without_host_terminal");
    expect(diagnostics).not.toContain("secret-canary");
  },
);

it("does not start a model turn after the inherited active deadline expires", async () => {
  let time = 0;
  const deadline = Deadline.after(100, () => time);
  time = 101;
  let modelLookups = 0;
  const terminal: unknown[] = [];
  const { makeOpenAIMinter } = await import("../../src/mint/openai.js");
  const f = await fixture(() => Effect.void, {
    deadline,
    diagnostics: {
      retainModelTranscript: (_name, value) =>
        Effect.sync(() => {
          terminal.push(value);
        }),
      emit: (_name, value) =>
        Effect.sync(() => {
          terminal.push(value);
        }),
      retainScreenedSource: () => Effect.void,
    },
    model: makeOpenAIMinter({
      getModel: () => {
        modelLookups++;
        throw new Error("Model must not start");
      },
    }),
  });
  expect(await f.run()).toMatchObject({ build: "incomplete" });
  expect(modelLookups).toBe(0);
  expect(
    terminal.find(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        "phase" in value &&
        value.phase === "terminal",
    ),
  ).toMatchObject({
    phase: "terminal",
    termination: { deadlineExpired: true },
    value: { modelState: "not_requested" },
  });
});

it("screens complete authored source before applying a range crossing a secret", async () => {
  let reached = false;
  const f = await fixture((turn) =>
    Effect.gen(function* () {
      const whole = yield* turn.actions.readSource("src/tool.ts");
      expect(whole).not.toContain("secret-canary");
      const part = yield* turn.actions.readSource("src/tool.ts", { offset: 31, limit: 6 });
      expect(part).not.toContain("secret");
      expect(JSON.parse(part)).toMatchObject({ offset: 31, offsetUnit: "UTF-16 code units" });
      reached = true;
    }),
  );
  await f.run();
  expect(reached).toBe(true);
});

it("refuses read_source ranges outside the source and a path outside the workspace", async () => {
  let reached = false;
  const f = await fixture((turn) =>
    Effect.gen(function* () {
      const { total } = Schema.decodeUnknownSync(Schema.Struct({ total: Schema.Number }))(
        JSON.parse(yield* turn.actions.readSource("src/tool.ts")),
      );
      for (const range of [
        { offset: -1 },
        { offset: total + 1 },
        { limit: 0 },
        { limit: 64_001 },
        { offset: 0.5 },
      ])
        expect(yield* Effect.either(turn.actions.readSource("src/tool.ts", range))).toMatchObject({
          _tag: "Left",
        });
      expect(
        yield* Effect.either(turn.actions.readSource("../src/tool.ts", { limit: 10 })),
      ).toMatchObject({ _tag: "Left" });
      reached = true;
    }),
  );
  await f.run();
  expect(reached).toBe(true);
});

it("permits a corrected host-authorized read and publishes its exact successful receipt", async () => {
  let calls = 0;
  let claims = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        expect(JSON.parse(yield* turn.actions.execute(execution))).toMatchObject({
          status: "failed",
          repeatableRead: true,
        });
        expect(JSON.parse(yield* turn.actions.execute(execution))).toMatchObject({
          status: "completed",
          executionId: "read_2",
          repeatableRead: true,
        });
        yield* turn.actions.finish({ ...publication, executionId: "read_2" });
      }),
    {
      repeatableRead: true,
      claimExample: Effect.sync(() => {
        claims++;
      }),
      reviewAndExecute: () =>
        Effect.sync(() => {
          calls++;
          return calls === 1
            ? {
                executionId: "read_1",
                status: "failed" as const,
                effect: "possible" as const,
                observations: "Extraction failed",
              }
            : {
                executionId: "read_2",
                status: "completed" as const,
                effect: "verified" as const,
                resultRef: "fresh_read_result",
                observations: "Fresh observed result",
              };
        }),
      publish: (_request, receipt) =>
        Effect.sync(() => {
          expect(receipt.executionId).toBe("read_2");
          return { publicationRef: "published", diagnostics: [] };
        }),
    },
  );
  const result = await f.run();
  expect(result.build).toBe("published");
  expect(result.executions.map((entry) => entry.executionId)).toEqual(["read_1", "read_2"]);
  expect(claims).toBe(2);
});

it("allows ordinary input after a stopped failed read without discarding its receipt", async () => {
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        expect(
          JSON.parse(yield* turn.actions.requestInput(textQuestion("Which observed option?"))),
        ).toMatchObject({ status: "no_answer" });
      }),
    {
      repeatableRead: true,
      reviewAndExecute: () =>
        Effect.succeed({
          executionId: "read_failed",
          status: "failed",
          effect: "possible",
          observations: "Read requires clarification",
        }),
    },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({ build: "incomplete" });
  expect(outcome).not.toHaveProperty("noResponse");
  expect(outcome.executions).toMatchObject([{ executionId: "read_failed", effect: "possible" }]);
});

// No answer is neither an ending nor consent: the minter hears no_answer and decides how to go on.
it("hands an unanswered question back as no_answer, and the build goes on to publish", async () => {
  let asked = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        expect(
          JSON.parse(yield* turn.actions.requestInput(textQuestion("Which format?"))),
        ).toMatchObject({ status: "no_answer", userInputRequired: false });
        expect(turn.isComplete()).toBe(false);
        yield* turn.actions.execute(execution);
        expect(JSON.parse(yield* turn.actions.finish(publication))).toMatchObject({
          status: "published",
        });
      }),
    {
      askInput: () =>
        Effect.sync(() => {
          asked++;
        }).pipe(Effect.zipRight(Effect.fail(unanswered()))),
    },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({ build: "published" });
  expect(outcome).not.toHaveProperty("noResponse");
  expect(asked).toBe(1);
});

it("refuses a task update whose confirmedBy names a question left unanswered", async () => {
  let reviews = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        expect(
          JSON.parse(
            yield* turn.actions.requestInput(textQuestion("May this build save the note?", "save")),
          ),
        ).toMatchObject({ status: "no_answer" });
        expect(
          JSON.parse(
            yield* turn.actions.updateTask!({
              summary: "Save the note on the site instead of only reading the notes.",
              changes: [{ setting: "effect", effect: "write" }],
              confirmedBy: ["save"],
              recommend: "update",
            }),
          ),
        ).toMatchObject({ status: "clarification_required", source: "host", unanswered: ["save"] });
        expect(turn.isComplete()).toBe(false);
      }),
    {
      reviewTaskUpdate: () =>
        Effect.sync(() => {
          reviews++;
          return { outcome: "allow" as const, rationale: "Unexpected review." };
        }),
      applyTaskUpdate: () => Effect.die("An unconfirmed update must not apply"),
    },
  );
  await f.run({ ...request, siteOrigin: "https://notes.example.test" });
  expect(reviews).toBe(0);
});

// In a write repair a question could gate the repair's write, so no answer still ends it.
it("ends a write repair as no_response when its question goes unanswered", async () => {
  const f = await fixture((turn) =>
    Effect.gen(function* () {
      expect(
        JSON.parse(yield* turn.actions.requestInput(textQuestion("Which order should it change?"))),
      ).toMatchObject({ status: "no_response" });
      expect(turn.isComplete()).toBe(true);
    }),
  );
  expect(await f.run({ ...request, mode: "maintenance", effect: "write" })).toMatchObject({
    build: "incomplete",
    noResponse: { possibleCommit: false },
  });
});

// A tool that runs signed in acts as the account's owner, so a question could gate what it does
// there: no answer ends the build, for the minter's own question and for its script's alike.
it("ends a signed-in build as no_response when the minter's question goes unanswered", async () => {
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        expect(
          JSON.parse(yield* turn.actions.requestInput(textQuestion("Which account page?"))),
        ).toMatchObject({ status: "no_response" });
        expect(turn.isComplete()).toBe(true);
      }),
    { websiteCredentialsAvailable: true },
  );
  expect(await f.run()).toMatchObject({
    build: "incomplete",
    noResponse: { possibleCommit: false },
  });
});

it("ends a signed-in build as no_response when its example's script question goes unanswered", async () => {
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const receipt: unknown = JSON.parse(yield* turn.actions.execute(execution));
        expect(receipt).not.toHaveProperty("scriptQuestion");
        expect(turn.isComplete()).toBe(true);
      }),
    {
      websiteCredentialsAvailable: true,
      reviewAndExecute: () =>
        Effect.succeed({
          executionId: "asked",
          status: "failed" as const,
          effect: "not_sent" as const,
          noResponse: { possibleCommit: false },
          observations: "The script's question expired unanswered.",
        }),
    },
  );
  expect(await f.run()).toMatchObject({
    build: "incomplete",
    noResponse: { possibleCommit: false },
  });
});

/** A sign-in the host verified. */
const verifiedSignIn = {
  executionId: "signed_in",
  status: "completed" as const,
  effect: "verified" as const,
  authentication: { state: "authenticated" as const, effect: "verified" as const },
  observations: "Signed in.",
};

// Whether a question goes back is decided when it goes unanswered, by whether the build is signed
// in or holds a login then: a build that starts signed out and signs in partway hands back its
// earlier question and ends on its later one.
it.each([
  {
    how: "a verified sign-in",
    signIn: (turn: MintTurn) =>
      turn.actions.execute({ ...execution, purpose: "authenticate", target: "liveBrowser" }),
    overrides: {
      reviewAndExecute: () => Effect.succeed(verifiedSignIn),
    },
  },
  {
    how: "a failed sign-in that sent the login",
    signIn: (turn: MintTurn) =>
      turn.actions.execute({ ...execution, purpose: "authenticate", target: "liveBrowser" }),
    overrides: {
      reviewAndExecute: () =>
        Effect.succeed({
          executionId: "sign_in_failed",
          status: "failed" as const,
          effect: "possible" as const,
          authentication: { state: "failed" as const, effect: "possible" as const },
          observations: "The site refused the login.",
        }),
    },
  },
  {
    how: "a sign-in that failed after submitting the login",
    signIn: (turn: MintTurn) =>
      turn.actions.execute({ ...execution, purpose: "authenticate", target: "liveBrowser" }),
    overrides: {
      reviewAndExecute: () =>
        Effect.fail(
          new MintFailure({
            code: "Unavailable",
            authentication: {
              phase: "credential_submit",
              code: "CredentialTargetRefused",
              afterSubmission: true,
            },
          }),
        ),
    },
  },
  {
    how: "a login the caller supplied when asked for one",
    signIn: (turn: MintTurn) =>
      turn.actions.requestInput(textQuestion("Which account should it use?", "account")),
    overrides: {
      reviewQuestion: (submitted: AgentInputRequest) =>
        Effect.succeed(
          submitted.questions[0]?.id === "account"
            ? { outcome: "authentication" as const, rationale: "It asks for a login." }
            : { outcome: "allow_business" as const, rationale: "An ordinary choice." },
        ),
      requestLogin: () => Effect.succeed("supplied" as const),
    },
  },
])(
  "hands back a question asked signed out and ends on one asked after $how",
  async ({ signIn, overrides }) => {
    const replies: unknown[] = [];
    const f = await fixture(
      (turn) =>
        Effect.gen(function* () {
          replies.push(JSON.parse(yield* turn.actions.requestInput(textQuestion("Which format?"))));
          expect(turn.isComplete()).toBe(false);
          yield* signIn(turn);
          replies.push(
            JSON.parse(yield* turn.actions.requestInput(textQuestion("Which period?", "period"))),
          );
          expect(turn.isComplete()).toBe(true);
        }),
      overrides,
    );
    const outcome = await f.run();
    expect(replies).toMatchObject([{ status: "no_answer" }, { status: "no_response" }]);
    expect(outcome).toMatchObject({ build: "incomplete", noResponse: { possibleCommit: false } });
  },
);

it("ends a build that signed in partway as no_response when its example's script question goes unanswered", async () => {
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute({
          ...execution,
          purpose: "authenticate",
          target: "liveBrowser",
        });
        const receipt: unknown = JSON.parse(yield* turn.actions.execute(execution));
        expect(receipt).not.toHaveProperty("scriptQuestion");
        expect(turn.isComplete()).toBe(true);
      }),
    {
      reviewAndExecute: (submitted) =>
        Effect.succeed(
          submitted.purpose === "authenticate"
            ? verifiedSignIn
            : {
                executionId: "asked",
                status: "failed" as const,
                effect: "not_sent" as const,
                noResponse: { possibleCommit: false },
                observations: "The script's question expired unanswered.",
              },
        ),
    },
  );
  expect(await f.run()).toMatchObject({
    build: "incomplete",
    noResponse: { possibleCommit: false },
  });
});

// The owner's cancel is a choice to stop: a signed-out build ends instead of going on without it.
it("ends a signed-out build as no_response when the owner cancels the minter's question", async () => {
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        expect(
          JSON.parse(yield* turn.actions.requestInput(textQuestion("Which format?"))),
        ).toMatchObject({ status: "no_response" });
        expect(turn.isComplete()).toBe(true);
      }),
    {
      askInput: () =>
        Effect.fail(
          new MintFailure({
            code: "Unavailable",
            noResponse: { possibleCommit: false },
            ownerCancelled: true,
          }),
        ),
    },
  );
  expect(await f.run()).toMatchObject({
    build: "incomplete",
    noResponse: { possibleCommit: false },
  });
});

// A sign-in that reached nothing leaves the build signed out, so its question still goes back.
it("hands back a question asked after a sign-in that sent nothing", async () => {
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute({
          ...execution,
          purpose: "authenticate",
          target: "liveBrowser",
        });
        expect(
          JSON.parse(yield* turn.actions.requestInput(textQuestion("Which format?"))),
        ).toMatchObject({ status: "no_answer" });
        expect(turn.isComplete()).toBe(false);
      }),
    {
      reviewAndExecute: () =>
        Effect.succeed({
          executionId: "sign_in_unsent",
          status: "failed" as const,
          effect: "not_sent" as const,
          observations: "The sign-in page did not load.",
        }),
    },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({ build: "incomplete" });
  expect(outcome).not.toHaveProperty("noResponse");
});

it("hands an example's unanswered script question back to the minter without ending the build", async () => {
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const receipt: unknown = JSON.parse(yield* turn.actions.execute(execution));
        expect(receipt).toMatchObject({
          status: "failed",
          scriptQuestion: { outcome: "unanswered" },
        });
        expect(receipt).toHaveProperty("scriptQuestion.instruction");
        expect(turn.isComplete()).toBe(false);
      }),
    {
      reviewAndExecute: () =>
        Effect.succeed({
          executionId: "asked",
          status: "failed" as const,
          effect: "not_sent" as const,
          noResponse: { possibleCommit: false },
          observations: "The script's question expired unanswered.",
        }),
    },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({ build: "incomplete" });
  expect(outcome).not.toHaveProperty("noResponse");
});

// An absent caller cannot hold a build open by being asked again and again: the minter's own
// questions and its scripts' share one limit of two hand-backs, and the next unanswered one ends
// the build.
it("hands back at most two unanswered questions per build, a script's included, then ends it as no_response", async () => {
  let asked = 0;
  const replies: unknown[] = [];
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        replies.push(JSON.parse(yield* turn.actions.requestInput(textQuestion("Which format?"))));
        replies.push(JSON.parse(yield* turn.actions.execute(execution)));
        expect(turn.isComplete()).toBe(false);
        replies.push(
          JSON.parse(yield* turn.actions.requestInput(textQuestion("Which period?", "period"))),
        );
        expect(turn.isComplete()).toBe(true);
      }),
    {
      askInput: () =>
        Effect.sync(() => {
          asked++;
        }).pipe(Effect.zipRight(Effect.fail(unanswered()))),
      reviewAndExecute: () =>
        Effect.succeed({
          executionId: "asked",
          status: "failed" as const,
          effect: "not_sent" as const,
          noResponse: { possibleCommit: false },
          observations: "The script's question expired unanswered.",
        }),
    },
  );
  const outcome = await f.run();
  expect(replies).toMatchObject([
    { status: "no_answer" },
    { status: "failed", scriptQuestion: { outcome: "unanswered" } },
    { status: "no_response" },
  ]);
  expect(outcome).toMatchObject({ build: "incomplete", noResponse: { possibleCommit: false } });
  expect(asked).toBe(2);
});

// The read-or-write and capability questions decide what the build may do, so no answer to either
// ends the build, while an ordinary question in the same kind of build would go back.
it.each([
  {
    question: "read-or-write",
    effect: "ask" as const,
    overrides: {},
    asking: {
      questions: [
        {
          id: "effect",
          type: "choice" as const,
          prompt: "Will this tool change something on the website?",
          options: [
            { id: "read", label: "read" },
            { id: "write", label: "write" },
          ],
        },
      ],
    },
  },
  {
    question: "capability",
    effect: "read" as const,
    overrides: { capabilityQuestion: "What result do you need?" },
    asking: textQuestion("What result do you need?", "need"),
  },
])(
  "ends the build as no_response when the $question question goes unanswered",
  async ({ effect, overrides, asking }) => {
    const f = await fixture(
      (turn) =>
        Effect.gen(function* () {
          expect(JSON.parse(yield* turn.actions.requestInput(asking))).toMatchObject({
            status: "no_response",
          });
          expect(turn.isComplete()).toBe(true);
        }),
      overrides,
    );
    expect(await f.run({ ...request, effect })).toMatchObject({
      build: "incomplete",
      noResponse: { possibleCommit: false },
    });
  },
);

// publication tells the minter what to fix, with no cap on fixable refusals.
it("tells the minter how to fix a registry refusal, with no cap, and publishes once it is fixed", async () => {
  let publications = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        for (let refusal = 0; refusal < 3; refusal++) {
          expect(JSON.parse(yield* turn.actions.finish(publication))).toMatchObject({
            status: "not_published",
            reason: "registry_invalid_definition",
            registryIssue: "definition_invalid",
            fixRequired: true,
          });
          expect(turn.isComplete()).toBe(false);
        }
        expect(JSON.parse(yield* turn.actions.finish(publication))).toMatchObject({
          status: "published",
        });
      }),
    {
      publish: () =>
        Effect.suspend(() =>
          publications++ < 3
            ? Effect.fail(
                new MintFailure({
                  code: "PublicationUnavailable",
                  reason: "registry_invalid_definition",
                  registryIssue: "definition_invalid",
                }),
              )
            : Effect.succeed({ publicationRef: "published-after-fix", diagnostics: [] }),
        ),
    },
  );
  expect(await f.run()).toMatchObject({
    build: "published",
    publicationRef: "published-after-fix",
  });
  expect(publications).toBe(4);
  expect(f.seen).toHaveLength(1);
});

// unusable input goes back to the agent with its reason, never fatal. A login
// URL no sign-in can start from is the minter's to fix by signing in again with a web loginUrl.
it("returns an unusable login URL refusal with its reason and publishes after signing in again", async () => {
  let publications = 0;
  const executed: string[] = [];
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        expect(JSON.parse(yield* turn.actions.finish(publication))).toMatchObject({
          status: "not_published",
          reason: "registry_invalid_definition",
          registryIssue: "login_url_unusable",
          registryProblem: "it is a javascript: URL, not a web page",
          fixRequired: true,
        });
        expect(turn.isComplete()).toBe(false);
        yield* turn.actions.execute({
          ...execution,
          purpose: "authenticate",
          target: "liveBrowser",
        });
        expect(JSON.parse(yield* turn.actions.finish(publication))).toMatchObject({
          status: "published",
        });
      }),
    {
      reviewAndExecute: (submitted) =>
        Effect.sync(() => {
          executed.push(submitted.purpose);
          return {
            executionId: submitted.purpose === "authenticate" ? "signed_in" : "execution_one",
            status: "completed" as const,
            effect: "verified" as const,
            resultRef: "private-result-ref",
            observations: "done",
          };
        }),
      publish: () =>
        Effect.suspend(() =>
          publications++ === 0
            ? Effect.fail(
                new MintFailure({
                  code: "PublicationUnavailable",
                  reason: "registry_invalid_definition",
                  registryIssue: "login_url_unusable",
                  registryProblem: "it is a javascript: URL, not a web page",
                }),
              )
            : Effect.succeed({ publicationRef: "published-after-sign-in", diagnostics: [] }),
        ),
    },
  );
  expect(await f.run()).toMatchObject({
    build: "published",
    publicationRef: "published-after-sign-in",
  });
  expect(executed).toEqual(["example", "authenticate"]);
  expect(publications).toBe(2);
});

// A tool another publication advanced while this build ran is never committed over: the minter
// hears it and may publish again, which reads the new version and is reviewed afresh.
it("tells the minter a tool changed underneath its publication and publishes on its next call", async () => {
  let publications = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        expect(JSON.parse(yield* turn.actions.finish(publication))).toMatchObject({
          status: "not_published",
          reason: "registry_conflict",
          registryIssue: "generation_moved",
          fixRequired: true,
        });
        expect(turn.isComplete()).toBe(false);
        expect(JSON.parse(yield* turn.actions.finish(publication))).toMatchObject({
          status: "published",
        });
      }),
    {
      publish: () =>
        Effect.suspend(() =>
          publications++ === 0
            ? Effect.fail(
                new MintFailure({
                  code: "PublicationUnavailable",
                  reason: "registry_conflict",
                  registryIssue: "generation_moved",
                }),
              )
            : Effect.succeed({ publicationRef: "published-after-move", diagnostics: [] }),
        ),
    },
  );
  expect(await f.run()).toMatchObject({
    build: "published",
    publicationRef: "published-after-move",
  });
  expect(publications).toBe(2);
});

it.each([
  ["registry_invalid_definition", "destination_evidence_invalid"],
  ["registry_conflict", undefined],
] as const)(
  "ends on a %s refusal (%s) the minter cannot fix and preserves the example",
  async (reason, registryIssue) => {
    const f = await fixture(
      (turn) =>
        Effect.gen(function* () {
          yield* turn.actions.execute(execution);
          expect(JSON.parse(yield* turn.actions.finish(publication))).toMatchObject({
            status: "not_published",
            reason,
            fixRequired: false,
          });
          expect(turn.isComplete()).toBe(true);
        }),
      {
        publish: () =>
          Effect.fail(
            new MintFailure({
              code: "PublicationUnavailable",
              reason,
              ...(registryIssue === undefined ? {} : { registryIssue }),
            }),
          ),
      },
    );
    expect(await f.run()).toMatchObject({
      build: "incomplete",
      example: { status: "completed", resultRef: "private-result-ref" },
    });
  },
);

it.each([
  new MintFailure({ code: "PublicationUnavailable", reason: "source_storage" }),
  new MintFailure({ code: "Unavailable" }),
])("offers another finish_build after a publication preparation outage (%o)", async (failure) => {
  let publications = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        expect(JSON.parse(yield* turn.actions.finish(publication))).toMatchObject({
          status: "not_published",
          retryable: true,
        });
        expect(turn.isComplete()).toBe(false);
        yield* turn.actions.finish(publication);
      }),
    {
      publish: () =>
        Effect.suspend(() =>
          publications++ === 0
            ? Effect.fail(failure)
            : Effect.succeed({ publicationRef: "published-after-outage", diagnostics: [] }),
        ),
    },
  );
  expect(await f.run()).toMatchObject({ build: "published" });
  expect(publications).toBe(2);
});

const outputUnavailable = () =>
  new MintFailure({ code: "PublicationUnavailable", reason: "example_output_unavailable" });

const freshExamples = () => {
  let calls = 0;
  return () =>
    Effect.sync(() => {
      calls++;
      return {
        executionId: `read_${calls}`,
        status: "completed" as const,
        effect: "verified" as const,
        resultRef: `result_${calls}`,
        observations: "Fresh observed result",
      };
    });
};

it("asks the minter to re-run the example when its retained output is unavailable, then publishes", async () => {
  const published: string[] = [];
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        const refused: unknown = JSON.parse(
          yield* turn.actions.finish({ ...publication, executionId: "read_1" }),
        );
        expect(refused).toMatchObject({
          status: "not_published",
          code: "PublicationUnavailable",
          reason: "example_output_unavailable",
          rerunsRemaining: 1,
          userInputRequired: false,
        });
        expect(turn.isComplete()).toBe(false);
        yield* turn.actions.execute(execution);
        yield* turn.actions.finish({ ...publication, executionId: "read_2" });
      }),
    {
      repeatableRead: true,
      reviewAndExecute: freshExamples(),
      publish: (_request, receipt) =>
        receipt.executionId === "read_1"
          ? Effect.fail(outputUnavailable())
          : Effect.sync(() => {
              published.push(receipt.executionId);
              return { publicationRef: "published", diagnostics: [] };
            }),
    },
  );
  expect(await f.run()).toMatchObject({ build: "published" });
  expect(published).toEqual(["read_2"]);
});

// a publication gate refusal names the file, what matched and where, and is the
// minter's to fix, never a review outage it retries. Fails if the refusal is generic, retryable or
// ends the attempt.
it("tells the minter which file, value kind and position the publication gate refused, then publishes the fix", async () => {
  let calls = 0;
  const responses: unknown[] = [];
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        responses.push(
          JSON.parse(yield* turn.actions.finish({ ...publication, executionId: "read_1" })),
        );
        expect(turn.isComplete()).toBe(false);
        yield* turn.actions.finish({ ...publication, executionId: "read_1" });
      }),
    {
      repeatableRead: true,
      reviewAndExecute: freshExamples(),
      publish: () =>
        calls++ === 0
          ? Effect.fail(
              new MintFailure({
                code: "PublicationUnavailable",
                reason: "evidence_screening",
                reviewFailure: "PublicationBlocked",
                publicationBlock: {
                  file: "operation/src/tool.mjs",
                  check: "registered_value",
                  entity: "COOKIE",
                  valueSource: "context_cookie",
                  line: 12,
                  column: 5,
                },
              }),
            )
          : Effect.succeed({ publicationRef: "published", diagnostics: [] }),
    },
  );
  expect(await f.run()).toMatchObject({ build: "published" });
  expect(responses).toHaveLength(1);
  const [refused] = responses;
  expect(refused).toMatchObject({
    status: "not_published",
    code: "PublicationUnavailable",
    reason: "evidence_screening",
    file: "src/tool.mjs",
    check: "registered_value",
    entity: "COOKIE",
    valueSource: "context_cookie",
    line: 12,
    column: 5,
    retryable: false,
    fixRequired: true,
    userInputRequired: false,
  });
  expect(refused).not.toHaveProperty("status", "review_unavailable");
  expect(String(Reflect.get(Object(refused), "instruction"))).toContain(
    "src/tool.mjs (line 12, column 5) holds a private value the host registered (COOKIE, from a cookie the site set)",
  );
});

// A publication privacy refusal is feedback on the retained write. The host may refuse the
// same authored source or description repeatedly, and the agent can correct it without replay.
it.each([
  { file: "operation/src/tool.mjs", section: undefined, reason: "source_screening" },
  { file: "publication/definition.json", section: "description", reason: "schema_screening" },
] as const)(
  "publishes a corrected write after repeated $reason refusals without another write",
  async ({ file, section, reason }) => {
    let executions = 0;
    let publications = 0;
    let sourceCorrected = false;
    const responses: unknown[] = [];
    const f = await fixture(
      (turn) =>
        Effect.gen(function* () {
          yield* turn.actions.execute({ ...execution, purpose: "act", target: "liveBrowser" });
          for (let attempt = 0; attempt < 3; attempt++) {
            responses.push(
              JSON.parse(
                yield* turn.actions.finish({
                  ...publication,
                  executionId: "act_1",
                  metadata: { name: "Accounts", description: "Private value in description" },
                }),
              ),
            );
            expect(turn.isComplete()).toBe(false);
          }
          sourceCorrected = true;
          yield* turn.actions.finish({
            ...publication,
            executionId: "act_1",
            metadata: { name: "Accounts", description: "Read the caller's account" },
          });
        }),
      {
        reviewAndExecute: () =>
          Effect.sync(() => {
            executions++;
            return {
              executionId: "act_1",
              status: "completed" as const,
              effect: "verified" as const,
              resultRef: "result_act",
              observations: "Submitted",
            };
          }),
        publish: (candidate) =>
          Effect.suspend(() => {
            publications++;
            const corrected =
              section === undefined
                ? sourceCorrected
                : candidate.metadata.description === "Read the caller's account";
            return corrected
              ? Effect.succeed({ publicationRef: "published", diagnostics: [] })
              : Effect.fail(
                  new MintFailure({
                    code: "PublicationUnavailable",
                    reason,
                    publicationBlock: {
                      file,
                      ...(section === undefined ? {} : { section }),
                      check: "registered_value",
                      entity: "USERNAME",
                    },
                  }),
                );
          }),
      },
    );
    expect(await f.run({ ...request, effect: "write" })).toMatchObject({ build: "published" });
    expect(executions).toBe(1);
    expect(publications).toBe(4);
    expect(responses).toHaveLength(3);
    for (const response of responses) {
      expect(response).toMatchObject({ status: "not_published", reason, fixRequired: true });
      expect(response).not.toHaveProperty("retriesRemaining");
    }
  },
);

// A write step that read the site's confirmation, but whose result the host did not accept,
// confirms nothing. Fails when that step publishes without a stated reason, when a later
// read-only step cannot confirm the session, or when no fallback remains once no read-back can.
it.each(["read_back", "fallback"] as const)(
  "publishes a write whose confirming result was withheld through a %s",
  async (path) => {
    const published: { executionId: string; readBackUnavailable?: string }[] = [];
    const responses: unknown[] = [];
    let steps = 0;
    const f = await fixture(
      (turn) =>
        Effect.gen(function* () {
          const act = { ...execution, purpose: "act", target: "liveBrowser" };
          // The agent hears at once that the write went out and must be read back, not redone.
          expect(JSON.parse(yield* turn.actions.execute(act))).toMatchObject({
            withheldConfirmation: "message",
            instruction: expect.stringContaining("Never repeat the write") as unknown,
          });
          const finish = (executionId: string, readBackUnavailable?: string) =>
            turn.actions.finish({
              ...publication,
              executionId,
              ...(readBackUnavailable === undefined ? {} : { readBackUnavailable }),
            });
          responses.push(JSON.parse(yield* finish("act_1")));
          if (path === "fallback") {
            expect(yield* Effect.either(finish("act_1", "   "))).toMatchObject({
              _tag: "Left",
              left: { code: "InvalidRequest" },
            });
            yield* finish("act_1", "The site shows the confirmation once and keeps no record");
            return;
          }
          // The read-back is its own step: running the write's step again would repeat it.
          yield* turn.actions.execute({ ...act, entrypoint: "src/read-back.ts" });
          responses.push(JSON.parse(yield* finish("act_1", "Not needed")));
          yield* finish("act_2");
        }),
      {
        reviewAndExecute: () =>
          Effect.sync((): ExecutionEvidence => {
            steps++;
            return steps === 1
              ? {
                  executionId: "act_1",
                  status: "failed",
                  effect: "verified",
                  withheldConfirmation: "message",
                  observations: "Result not accepted",
                }
              : {
                  executionId: "act_2",
                  status: "completed",
                  effect: "verified",
                  confirmation: "message",
                  resultRef: "result_read_back",
                  observations: "Read the confirmation back",
                };
          }),
        publish: (candidate) =>
          Effect.sync(() => {
            published.push({
              executionId: candidate.executionId,
              ...(candidate.readBackUnavailable === undefined
                ? {}
                : { readBackUnavailable: candidate.readBackUnavailable }),
            });
            return { publicationRef: "published", diagnostics: [] };
          }),
      },
    );
    expect(await f.run({ ...request, effect: "write" })).toMatchObject({ build: "published" });
    for (const response of responses)
      expect(response).toMatchObject({ status: "not_published", reason: "read_back_required" });
    expect(published).toEqual([
      path === "fallback"
        ? {
            executionId: "act_1",
            readBackUnavailable: "The site shows the confirmation once and keeps no record",
          }
        : { executionId: "act_2" },
    ]);
  },
);

// A confirmation the host marks as leaving steps of the session's recorded write path unentered,
// such as a saved draft's notice before the quote the path ends with, keeps the session open: its
// receipt names the steps left and the next act step runs. The step that leaves none closes it.
// Fails when the first confirmation closes the session, as every one did before write paths.
it("keeps a write session open past a confirmation its recorded path has steps after", async () => {
  const receipts: unknown[] = [];
  let steps = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const act = { ...execution, purpose: "act", target: "liveBrowser" };
        receipts.push(JSON.parse(yield* turn.actions.execute(act)));
        receipts.push(
          JSON.parse(yield* turn.actions.execute({ ...act, entrypoint: "src/quote.ts" })),
        );
        expect(
          yield* Effect.either(turn.actions.execute({ ...act, entrypoint: "src/after.ts" })),
        ).toMatchObject({ _tag: "Left", left: { code: "AlreadyExecuted" } });
        yield* turn.actions.finish({ ...publication, executionId: "act_2" });
      }),
    {
      reviewAndExecute: () =>
        Effect.sync((): ExecutionEvidence => {
          steps++;
          return steps === 1
            ? {
                executionId: "act_1",
                status: "completed",
                effect: "verified",
                confirmation: "message",
                writePathRemaining: ["get-quote"],
                resultRef: "result_draft",
                observations: "Draft saved",
              }
            : {
                executionId: "act_2",
                status: "completed",
                effect: "verified",
                confirmation: "message",
                resultRef: "result_quote",
                observations: "Quote ready",
              };
        }),
      publish: () => Effect.succeed({ publicationRef: "published", diagnostics: [] }),
    },
  );
  expect(await f.run({ ...request, effect: "write" })).toMatchObject({ build: "published" });
  expect(steps).toBe(2);
  expect(receipts[0]).toMatchObject({
    confirmation: "message",
    writePath: {
      remaining: ["get-quote"],
      instruction: expect.stringContaining(
        "This step's confirmation does not end the write session",
      ) as unknown,
    },
  });
  expect(receipts[1]).toMatchObject({ confirmation: "message" });
  expect(receipts[1]).not.toHaveProperty("writePath");
});

// The fallback is for a read-back that cannot run, such as once the execution host is lost. It
// fails when the withheld step does not keep the attempt open for publication.
it("publishes a withheld write confirmation through the fallback after the execution host is lost", async () => {
  let availability = "open" as "open" | "host_unavailable";
  const published: string[] = [];
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute({ ...execution, purpose: "act", target: "liveBrowser" });
        availability = "host_unavailable";
        expect(
          JSON.parse(
            yield* turn.actions.execute({ ...execution, purpose: "act", target: "liveBrowser" }),
          ),
        ).toMatchObject({ status: "execution_unavailable" });
        expect(turn.isComplete()).toBe(false);
        yield* turn.actions.finish({
          ...publication,
          executionId: "act_1",
          readBackUnavailable: "The execution host is unavailable, so no step can read it back",
        });
      }),
    {
      executionAvailability: () => availability,
      reviewAndExecute: () =>
        Effect.succeed({
          executionId: "act_1",
          status: "failed" as const,
          effect: "verified" as const,
          withheldConfirmation: "message" as const,
          observations: "Result not accepted",
        }),
      publish: (candidate) =>
        Effect.sync(() => {
          published.push(candidate.executionId);
          return { publicationRef: "published", diagnostics: [] };
        }),
    },
  );
  expect(await f.run({ ...request, effect: "write" })).toMatchObject({ build: "published" });
  expect(published).toEqual(["act_1"]);
});

// Host-owned evidence and an already executed write step have no agent-side source fix. Their
// refusals remain visible, without turning the publication gate into a terminal mint outcome.
it("keeps the build open and reports uneditable host-written evidence", async () => {
  const file = "publication/recorded-requests.json";
  let publications = 0;
  const responses: unknown[] = [];
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        for (let attempt = 0; attempt < 3; attempt++) {
          responses.push(
            JSON.parse(yield* turn.actions.finish({ ...publication, executionId: "read_1" })),
          );
          expect(turn.isComplete()).toBe(false);
        }
      }),
    {
      repeatableRead: true,
      reviewAndExecute: freshExamples(),
      publish: () =>
        Effect.suspend(() => {
          publications++;
          return Effect.fail(
            new MintFailure({
              code: "PublicationUnavailable",
              reason: "evidence_screening",
              reviewFailure: "PublicationBlocked",
              publicationBlock: { file, check: "contextual_secret", entity: "CREDENTIAL_FIELD" },
            }),
          );
        }),
    },
  );
  await f.run();
  expect(publications).toBe(3);
  expect(responses).toHaveLength(3);
  for (const response of responses) {
    expect(response).toMatchObject({
      reason: "evidence_screening",
      file,
      retryable: false,
      fixRequired: false,
    });
    expect(response).not.toHaveProperty("retriesRemaining");
  }
});

it("fails publication with a finite infrastructure reason after two unavailable re-runs", async () => {
  let publicationCalls = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        for (const [index, rerunsRemaining] of [1, 0].entries()) {
          yield* turn.actions.execute(execution);
          expect(
            JSON.parse(
              yield* turn.actions.finish({ ...publication, executionId: `read_${index + 1}` }),
            ),
          ).toMatchObject({ status: "not_published", rerunsRemaining });
        }
        yield* turn.actions.execute(execution);
        expect(
          JSON.parse(yield* turn.actions.finish({ ...publication, executionId: "read_3" })),
        ).toMatchObject({
          status: "publication_unavailable",
          code: "PublicationUnavailable",
          reason: "example_output_unrecoverable",
          userInputRequired: false,
        });
        expect(turn.isComplete()).toBe(true);
      }),
    {
      repeatableRead: true,
      reviewAndExecute: freshExamples(),
      publish: () =>
        Effect.suspend(() => {
          publicationCalls++;
          return Effect.fail(outputUnavailable());
        }),
    },
  );
  expect(await f.run()).toMatchObject({ build: "incomplete" });
  expect(publicationCalls).toBe(3);
});

it("does not offer a re-run of a non-repeatable example whose output is unavailable", async () => {
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        expect(JSON.parse(yield* turn.actions.finish(publication))).toMatchObject({
          status: "publication_unavailable",
          reason: "example_output_unrecoverable",
        });
        expect(turn.isComplete()).toBe(true);
      }),
    { publish: () => Effect.fail(outputUnavailable()) },
  );
  expect(await f.run()).toMatchObject({
    build: "incomplete",
    example: { status: "completed", resultRef: "private-result-ref" },
  });
});

type ScriptedStep =
  | { readonly final: string }
  | { readonly tool: string; readonly arguments: Readonly<Record<string, unknown>> };

/** Scripted pinned-SDK responses; a request past the script fails the model loop. */
const scriptedSdkMinter = async (steps: readonly ScriptedStep[], requests: ModelRequest[]) => {
  const { makeOpenAIMinter } = await import("../../src/mint/openai.js");
  const { Usage } = await import("@openai/agents");
  return makeOpenAIMinter({
    getModel: () => ({
      getResponse: async (input) => {
        requests.push(input);
        const step = steps[requests.length - 1];
        if (step === undefined) throw new Error("Unexpected model continuation");
        return {
          usage: new Usage(),
          output: [
            "final" in step
              ? {
                  type: "message" as const,
                  role: "assistant" as const,
                  status: "completed" as const,
                  content: [{ type: "output_text" as const, text: step.final }],
                }
              : {
                  type: "function_call" as const,
                  callId: `scripted_${requests.length}`,
                  name: step.tool,
                  arguments: JSON.stringify(step.arguments),
                  status: "completed" as const,
                },
          ],
        };
      },
      getStreamedResponse: () => {
        throw new Error("Streaming unused");
      },
    }),
  });
};

const deniedLiveTest = new MintFailure({
  code: "ReviewDenied",
  review: { outcome: "deny", rationale: "The live test would submit the booking form." },
});

const liveTest = {
  tool: "execute",
  arguments: {
    ...execution,
    purpose: "test",
    target: "liveBrowser",
    intent: "Check the flight search under the read mandate.",
  },
};

const noReceipt = {
  final: "Guardian denied the live test, so no example receipt can be produced.",
};

it("ends the attempt after three tool-free final answers in a row following a review denial", async () => {
  const requests: ModelRequest[] = [];
  let reviews = 0;
  const f = await fixture(() => Effect.void, {
    skills: [{ name: "core", description: "Synthetic SDK fixture", content: "Use execute." }],
    reviewAndExecute: () =>
      Effect.suspend(() => {
        reviews++;
        return Effect.fail(deniedLiveTest);
      }),
    // Before the bound, the loop prompted the model until the script ran out.
    model: await scriptedSdkMinter(
      [liveTest, ...Array.from({ length: 8 }, () => noReceipt)],
      requests,
    ),
  });
  const outcome = await f.run();
  expect(reviews).toBe(1);
  // The denial reaches the model as feedback it may act on; it does not end the attempt.
  expect(JSON.stringify(requests[1]?.input)).toContain("review_rejected");
  // One final answer closes the denied test's segment, then three tool-free finals follow.
  expect(requests).toHaveLength(5);
  expect(outcome.build).toBe("incomplete");
  expect(outcome.diagnostics.join("\n")).toContain("repeated_final_without_tool");
});

it("keeps prompting when tool calls separate tool-free final answers", async () => {
  const requests: ModelRequest[] = [];
  let reviews = 0;
  const f = await fixture(() => Effect.void, {
    skills: [{ name: "core", description: "Synthetic SDK fixture", content: "Use execute." }],
    reviewAndExecute: (submitted) =>
      Effect.suspend(() => {
        reviews++;
        if (reviews === 1) return Effect.fail(deniedLiveTest);
        return Effect.succeed({
          executionId: submitted.purpose === "example" ? "execution_one" : "execution_test",
          status: "completed" as const,
          effect: "verified" as const,
          resultRef: "private-result-ref",
          observations: { result: "public fares" },
        });
      }),
    model: await scriptedSdkMinter(
      [
        liveTest,
        noReceipt,
        noReceipt,
        noReceipt,
        { tool: "execute", arguments: { ...execution, intent: "Run the corrected read example." } },
        noReceipt,
        noReceipt,
        noReceipt,
        {
          tool: "finish_build",
          arguments: { ...publication, intent: "Publish the verified read." },
        },
      ],
      requests,
    ),
  });
  const outcome = await f.run();
  expect(outcome).toMatchObject({ build: "published", publicationRef: "published-revision" });
  expect(reviews).toBe(2);
  expect(requests).toHaveLength(9);
});

const providerFailure = (dispatch: "not_sent" | "unknown") =>
  new MintFailure({
    code: "Unavailable",
    execution: { phase: "execute", reason: "provider_unavailable", dispatch },
  });

it("lets the agent retry an undispatched provider failure, marks a dispatched one possible, and closes live execution once the outage outlasts its budget", async () => {
  const dispatches: ("not_sent" | "unknown")[] = ["not_sent", "unknown", "not_sent", "not_sent"];
  const time = steppedClock();
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const explore = { ...execution, purpose: "explore" };
        expect(JSON.parse(yield* turn.actions.execute(explore))).toMatchObject({
          status: "execution_unavailable",
          retryable: true,
          effect: "not_sent",
        });
        const unknown: unknown = JSON.parse(yield* turn.actions.execute(explore));
        expect(unknown).toMatchObject({ retryable: true, effect: "possible" });
        // A third failure is still inside the outage budget, past the old two-retry cap.
        time.advance(10 * 60_000);
        expect(JSON.parse(yield* turn.actions.execute(explore))).toMatchObject({
          retryable: true,
        });
        expect(turn.isComplete()).toBe(false);
        time.advance(5 * 60_000);
        expect(JSON.parse(yield* turn.actions.execute(explore))).not.toHaveProperty("retryable");
        expect(turn.isComplete()).toBe(true);
      }).pipe(Effect.withClock(time.clock)),
    {
      reviewAndExecute: () =>
        Effect.suspend(() => Effect.fail(providerFailure(dispatches.shift() ?? "not_sent"))),
    },
  );
  expect((await f.run()).build).toBe("incomplete");
});

it("ends on a dispatched provider failure whose executor stop was not confirmed", async () => {
  let availability = "open" as "open" | "host_unavailable";
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        const feedback: unknown = JSON.parse(
          yield* turn.actions.execute({ ...execution, purpose: "explore" }),
        );
        expect(feedback).not.toHaveProperty("retryable");
        expect(turn.isComplete()).toBe(true);
      }),
    {
      executionAvailability: () => availability,
      reviewAndExecute: () =>
        Effect.suspend(() => {
          // A failed executor stop poisons the host before the failure arrives.
          availability = "host_unavailable";
          return Effect.fail(providerFailure("unknown"));
        }),
    },
  );
  expect((await f.run()).build).toBe("incomplete");
});

it("reports anomaly counts in mint.model_finished and the attempt outcome once", async () => {
  const finished: unknown[] = [];
  const outcomes: string[] = [];
  const anomalies = {
    count: 3,
    critical: 1,
    entries: [
      {
        kind: "observation_gap" as const,
        reason: "event_unreadable" as const,
        severity: "critical" as const,
      },
    ],
  };
  const f = await fixture(() => Effect.void, {
    hostAnomalies: () => anomalies,
    attemptFinished: (outcome) =>
      Effect.sync(() => {
        outcomes.push(outcome);
      }),
    diagnostics: {
      retainModelTranscript: () => Effect.void,
      emit: (name, value) =>
        Effect.sync(() => {
          if (name === "mint.model_finished") finished.push(value);
        }),
      retainScreenedSource: () => Effect.void,
    },
  });
  expect((await f.run()).build).toBe("incomplete");
  expect(finished).toEqual([expect.objectContaining({ anomalies })]);
  expect(outcomes).toEqual(["incomplete"]);
});

describe("host entry page notice", () => {
  const entry = "https://site.invalid/claims/new?plan=ppo&sig=secret-canary#member";
  it("tells the first request the page is already loaded, with the exact URLs", async () => {
    let firstInput: Record<string, unknown> = {};
    let receipt = "";
    const f = await fixture(
      (turn) =>
        Effect.gen(function* () {
          firstInput = modelInput(turn.input);
          receipt = yield* turn.actions.execute({ ...execution, purpose: "explore" });
        }),
      {
        entryNavigation: () => ({
          state: "opened",
          outcome: "ready",
          requestedUrl: entry,
          resolvedUrl: "https://site.invalid/claims/new?plan=ppo&sig=secret-canary&step=2#member",
          redirects: [],
          status: 200,
        }),
      },
    );
    await f.run();
    expect(firstInput.hostEntryNavigation).toMatchObject({
      state: "opened",
      outcome: "ready",
      requestedUrl: entry,
      resolvedUrl: "https://site.invalid/claims/new?plan=ppo&sig=secret-canary&step=2#member",
      status: 200,
      instruction: expect.any(String) as unknown,
    });
    // An unchanged state is not repeated on later receipts.
    expect(modelInput(receipt)).not.toHaveProperty("hostEntryNavigation");
  });
  it("states a failed entry so the minter does not assume it is on the page", async () => {
    let input = "";
    const f = await fixture(
      (turn) =>
        Effect.sync(() => {
          input = turn.input;
        }),
      {
        entryNavigation: () => ({ state: "not_opened", outcome: "timeout", requestedUrl: entry }),
      },
    );
    await f.run();
    expect(modelInput(input).hostEntryNavigation).toMatchObject({
      state: "not_opened",
      outcome: "timeout",
      requestedUrl: entry,
      instruction: expect.any(String) as unknown,
    });
  });
  // A host may explain a replaced browser in its own words, such as a replacement that kept its
  // session, and change that explanation on the same page. The minter hears each change once.
  it("shows the notice again when only the host's own instruction changed", async () => {
    const hostInstruction = "The host kept the previous browser's session for this one.";
    let current: Extract<MintEntryNavigation, { readonly state: "replaced" }> = {
      state: "replaced",
      reason: "recovery",
      page: "https://site.invalid/home",
    };
    const receipts: string[] = [];
    const f = await fixture(
      (turn) =>
        Effect.gen(function* () {
          receipts.push(yield* turn.actions.execute({ ...execution, purpose: "explore" }));
          current = { ...current, instruction: hostInstruction };
          receipts.push(yield* turn.actions.execute({ ...execution, purpose: "explore" }));
          receipts.push(yield* turn.actions.execute({ ...execution, purpose: "explore" }));
        }),
      { entryNavigation: () => current },
    );
    await f.run();
    const [unchanged, explained, repeated] = receipts.map((receipt) => modelInput(receipt));
    expect(unchanged).not.toHaveProperty("hostEntryNavigation");
    expect(explained?.hostEntryNavigation).toMatchObject({
      state: "replaced",
      instruction: hostInstruction,
    });
    expect(repeated).not.toHaveProperty("hostEntryNavigation");
  });
  it("adds no notice when the host supplies none", async () => {
    let input = "";
    const f = await fixture((turn) =>
      Effect.sync(() => {
        input = turn.input;
      }),
    );
    await f.run();
    expect(modelInput(input)).not.toHaveProperty("hostEntryNavigation");
  });
});

// A read whose HTTP version can't port answers the host's ask with a structured reason, so the
// host publishes it once with the signal on record instead of a stub written to be deleted.
it("hands the host a read's structured reason for having no HTTP version", async () => {
  const candidates: PublicationRequest[] = [];
  const answers: unknown[] = [];
  const httpVersion = {
    outcome: "ruled_out",
    signal: "streaming_response",
    requestId: "req-17",
    note: "Results arrive only as server-sent events on the search stream.",
  } as const;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        answers.push(JSON.parse(yield* turn.actions.finish(publication)));
        answers.push(JSON.parse(yield* turn.actions.finish({ ...publication, httpVersion })));
      }),
    {
      publish: (candidate) =>
        Effect.suspend(() => {
          candidates.push(candidate);
          return candidate.httpVersion === undefined
            ? Effect.fail(
                new MintFailure({
                  code: "PublicationUnavailable",
                  reason: "http_implementation_untested",
                }),
              )
            : Effect.succeed({ publicationRef: "published", diagnostics: [] });
        }),
    },
  );
  const outcome = await f.run();
  expect(answers).toMatchObject([
    { status: "not_published", reason: "http_implementation_untested" },
    { status: "published" },
  ]);
  expect(candidates.map((candidate) => candidate.httpVersion)).toEqual([undefined, httpVersion]);
  expect(outcome.build).toBe("published");
});

it("refuses an HTTP version reason without a known signal before publication", async () => {
  let published = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(execution);
        expect(
          yield* Effect.either(
            turn.actions.finish({
              ...publication,
              httpVersion: { outcome: "ruled_out", signal: "too_hard", note: "x" },
            }),
          ),
        ).toMatchObject({ _tag: "Left", left: { code: "InvalidRequest" } });
        yield* turn.actions.finish(publication);
      }),
    {
      publish: () =>
        Effect.sync(() => {
          published++;
          return { publicationRef: "published", diagnostics: [] };
        }),
    },
  );
  await f.run();
  expect(published).toBe(1);
});

it("refuses an HTTP version reason on a write build before publication", async () => {
  let published = 0;
  const answers: unknown[] = [];
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        answers.push(
          JSON.parse(
            yield* turn.actions.finish({
              ...publication,
              httpVersion: {
                outcome: "ruled_out",
                signal: "streaming_response",
                note: "Results arrive only as server-sent events.",
              },
            }),
          ),
        );
      }),
    {
      publish: () =>
        Effect.sync(() => {
          published++;
          return { publicationRef: "published", diagnostics: [] };
        }),
    },
  );
  await f.run({ ...request, effect: "write" });
  expect(answers).toMatchObject([{ status: "not_published", reason: "http_version_on_write" }]);
  expect(published).toBe(0);
});
