import { OpenAIProvider, setDefaultModelProvider } from "@openai/agents";
import { Chunk, Effect, Fiber, Option, TestClock, TestContext } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { ReviewFailure, guardianOutageRetry, makeGuardian } from "../../src/guardian/review.js";
import type {
  GuardianDiagnostics,
  PendingExecution,
  Reviewer,
  ReviewRetry,
} from "../../src/guardian/review.js";

afterEach(() => vi.restoreAllMocks());

const native = { executionEnvironment: nativeExecutionEnvironment };

const pending: PendingExecution = {
  invocationId: "invocation_a",
  attemptId: "attempt_a",
  entrypoint: "operation.ts",
  screenedIntent: "Read the public page title",
  screenedInput: "{}",
  screenedObservations: "untrusted page observations",
  accountScope: "account_a",
  allowedOrigins: ["https://example.test"],
  allowedEffects: ["read"],
};
const readSource = () =>
  Effect.succeed(
    JSON.stringify({ kind: "untrusted_source", path: pending.entrypoint, source: "export {}" }),
  );
const quickRetry: ReviewRetry = { delays: ["1 millis"], budget: "1 minute" };

/** A reviewer that fails `outages` times with `failure`, then allows after reading the source. */
const flaky = (failure: () => unknown, outages: number, retry?: ReviewRetry) => {
  let runs = 0;
  const reviewer: Reviewer = {
    run: (turn) =>
      Effect.suspend(() => {
        runs++;
        if (runs <= outages) {
          const outcome = failure();
          return outcome instanceof ReviewFailure ? Effect.fail(outcome) : Effect.succeed(outcome);
        }
        return turn
          .readSource(turn.pending.entrypoint, 0)
          .pipe(
            Effect.as({
              outcome: "allow",
              rationale: "Reads the page title only.",
              action: "read",
            }),
          );
      }),
    ...(retry === undefined ? {} : { retry }),
  };
  return { reviewer, runs: () => runs };
};

it.each([
  [
    "a provider outage",
    () => new ReviewFailure({ code: "Unavailable", reviewPhase: "review_computation" }),
  ],
  ["a required source read that failed", () => new ReviewFailure({ code: "SourceUnavailable" })],
] as const)(
  "reviews again after %s and returns the decision that completes",
  async (_, failure) => {
    const f = flaky(failure, 2, quickRetry);
    const reviewed = await Effect.runPromise(makeGuardian(f.reviewer).review(pending, readSource));
    expect(reviewed.decision).toMatchObject({ outcome: "allow" });
    expect(f.runs()).toBe(3);
  },
);

it("reviews a proposed question again after an outage", async () => {
  let runs = 0;
  const reviewer: Reviewer = {
    retry: quickRetry,
    run: () =>
      Effect.suspend(() =>
        runs++ === 0
          ? Effect.fail(new ReviewFailure({ code: "Unavailable" }))
          : Effect.succeed({ outcome: "allow_business", rationale: "Only the caller knows." }),
      ),
  };
  const reviewed = await Effect.runPromise(
    makeGuardian(reviewer).reviewQuestion(
      pending,
      {
        questions: [{ id: "size", type: "text", prompt: "Which size?" }],
        credentialsAvailable: false,
      },
      readSource,
    ),
  );
  expect(reviewed.decision).toMatchObject({ outcome: "allow_business" });
  expect(runs).toBe(2);
});

it.each([
  [
    "a diagnostic retention failure",
    () =>
      new ReviewFailure({
        code: "Unavailable",
        reviewPhase: "diagnostic_retention",
        diagnosticRetentionReason: "storage",
      }),
  ],
  // Running out of turns or a model call that keeps stalling is no outage: reviewing again would
  // repeat the whole review's work.
  ["a turn limit", () => new ReviewFailure({ code: "TurnLimitExceeded" })],
  [
    "a stalled model call",
    () => new ReviewFailure({ code: "ModelCallStalled", reviewPhase: "review_computation" }),
  ],
] as const)("returns %s at once, without another review", async (_, failure) => {
  const f = flaky(failure, 5, quickRetry);
  const result = await Effect.runPromise(
    Effect.either(makeGuardian(f.reviewer).review(pending, readSource)),
  );
  expect(result).toMatchObject({ _tag: "Left", left: { code: failure().code } });
  expect(f.runs()).toBe(1);
});

// A reviewer that sends no follow-up gets one fresh review for a decision that does not decode,
// since a fresh sample may decode, and no more.
it.each([
  [1, "Right"],
  [2, "Left"],
] as const)(
  "reviews once more after %i undecodable decisions from a reviewer that sends no follow-up",
  async (outages, tag) => {
    const f = flaky(() => ({ outcome: "allow", rationale: "" }), outages, quickRetry);
    const result = await Effect.runPromise(
      Effect.either(makeGuardian(f.reviewer).review(pending, readSource)),
    );
    expect(result).toMatchObject(
      tag === "Right"
        ? { _tag: "Right", right: { decision: { outcome: "allow" } } }
        : { _tag: "Left", left: { code: "InvalidDecision" } },
    );
    expect(f.runs()).toBe(2);
  },
);

it("times each review attempt and ties the retry to the attempt that failed", async () => {
  let now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const events: {
    name: string;
    details: unknown;
    reviewId?: string;
    reviewKind?: string;
  }[] = [];
  const record: GuardianDiagnostics["emit"] = (name, details, correlation) =>
    Effect.sync(() => {
      events.push({
        name,
        // Review-scoped events wrap their details; the retry event carries them directly.
        details:
          name === "guardian.review_retried" ? details : (details as { details: unknown }).details,
        ...(correlation?.reviewId === undefined ? {} : { reviewId: correlation.reviewId }),
        ...(correlation?.reviewKind === undefined ? {} : { reviewKind: correlation.reviewKind }),
      });
    });
  const diagnostics: GuardianDiagnostics = {
    emit: record,
    retainModelTranscript: record,
    retainScreenedSource: () => Effect.void,
  };
  // Attempt 1: the host's own entrypoint read fails after 5 ms, then Guardian's read of it fails
  // after 7 ms. Attempt 2: the host's read takes no time and Guardian's read succeeds after 3 ms.
  const readMs = [5, 7, 0, 3];
  let reads = 0;
  const failingOnce = () =>
    Effect.suspend(() => {
      const read = reads++;
      now += readMs[read] ?? 0;
      return read < 2
        ? Effect.fail(new ReviewFailure({ code: "SourceUnavailable" }))
        : readSource();
    });
  const f = flaky(() => undefined, 0, {
    delays: ["20 millis"],
    budget: "1 minute",
  });
  const reviewed = await Effect.runPromise(
    Effect.gen(function* () {
      const review = yield* Effect.fork(
        makeGuardian(f.reviewer, diagnostics).review(pending, failingOnce),
      );
      yield* Effect.yieldNow();
      now += 20;
      yield* TestClock.adjust("20 millis");
      return yield* Fiber.join(review);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );
  type Timing = {
    attempt: number;
    startOffsetMs: number;
    endOffsetMs?: number;
    elapsedMs?: number;
  };
  const named = (name: string) => events.filter((event) => event.name === name);
  const timing = (event: { details: unknown } | undefined) =>
    (event?.details as { timing: Timing } | undefined)?.timing;
  const started = named("guardian.started");
  expect(started.map((event) => timing(event)?.attempt).sort()).toEqual([1, 2]);
  const first = started.find((event) => timing(event)?.attempt === 1);
  const second = started.find((event) => timing(event)?.attempt === 2);
  expect(first?.reviewId).not.toBe(second?.reviewId);
  expect(second?.reviewId).toBe(reviewed.reviewId);

  const sourceFailures = named("guardian.source_failed");
  expect(sourceFailures.map((event) => event.reviewId)).toEqual([first?.reviewId, first?.reviewId]);
  const hostRead = sourceFailures[0]?.details as Record<string, unknown>;
  expect(hostRead).toMatchObject({
    automatic: true,
    elapsedMs: 5,
    startOffsetMs: 100,
    endOffsetMs: 105,
  });
  const sourceFailed = sourceFailures[1]?.details as Record<string, number>;
  expect(sourceFailed).not.toHaveProperty("automatic");
  expect(sourceFailed).toMatchObject({
    elapsedMs: 7,
    startOffsetMs: 105,
    endOffsetMs: 112,
  });
  expect(sourceFailed["endOffsetMs"]! - sourceFailed["startOffsetMs"]!).toBe(
    sourceFailed["elapsedMs"],
  );

  const failed = named("guardian.failed")[0];
  expect(failed?.reviewId).toBe(first?.reviewId);
  const failedTiming = timing(failed);
  expect(failedTiming).toMatchObject({
    attempt: 1,
    startOffsetMs: timing(first)?.startOffsetMs,
  });
  expect(failedTiming?.endOffsetMs).toBeGreaterThanOrEqual(failedTiming!.startOffsetMs);
  expect(failedTiming?.elapsedMs).toBe(failedTiming!.endOffsetMs! - failedTiming!.startOffsetMs);

  const retried = named("guardian.review_retried")[0];
  expect(retried).toMatchObject({
    reviewId: first?.reviewId,
    reviewKind: "execution",
    details: { attempt: 1, retry: 1, waitMs: 20 },
  });
  const interval = retried?.details as {
    startOffsetMs: number;
    endOffsetMs: number;
  };
  expect(interval.endOffsetMs - interval.startOffsetMs).toBe(20);

  const completed = named("guardian.completed")[0];
  expect(completed?.reviewId).toBe(second?.reviewId);
  const completedTiming = timing(completed);
  expect(completedTiming).toMatchObject({
    attempt: 2,
    startOffsetMs: timing(second)?.startOffsetMs,
  });
  expect(completedTiming).toMatchObject({
    startOffsetMs: 132,
    endOffsetMs: 135,
    elapsedMs: 3,
  });
});

it("keeps the follow-up rounds for a skipped entrypoint read inside one attempt", async () => {
  const run = async (readsWhenAsked: boolean) => {
    const events: { name: string; details: unknown; reviewId?: string }[] = [];
    const record: GuardianDiagnostics["emit"] = (name, details, correlation) =>
      Effect.sync(() => {
        events.push({
          name,
          details: (details as { details: unknown }).details,
          ...(correlation?.reviewId === undefined ? {} : { reviewId: correlation.reviewId }),
        });
      });
    let runs = 0;
    let hostRead = true;
    const reviewer: Reviewer = {
      retry: quickRetry,
      // Allows without reading, and reads the entrypoint only once asked, when `readsWhenAsked`.
      run: (turn) =>
        Effect.gen(function* () {
          runs++;
          const output = {
            outcome: "allow",
            rationale: "Reads the page title only.",
            action: "read",
          };
          for (let round = 0; round < 2; round++) {
            if (turn.followUp?.(output) === undefined) break;
            if (readsWhenAsked) yield* turn.readSource(turn.pending.entrypoint, 0);
          }
          return output;
        }),
    };
    // The host's own read fails, so the entrypoint is not in the request.
    const reader = () =>
      Effect.suspend(() => {
        const host = hostRead;
        hostRead = false;
        return host ? Effect.fail(new ReviewFailure({ code: "SourceUnavailable" })) : readSource();
      });
    const result = await Effect.runPromise(
      Effect.either(
        makeGuardian(reviewer, {
          emit: record,
          retainModelTranscript: record,
          retainScreenedSource: () => Effect.void,
        }).review(pending, reader),
      ),
    );
    const named = (name: string) => events.filter((event) => event.name === name);
    return { result, runs, named };
  };

  const answered = await run(true);
  expect(answered.result).toMatchObject({
    _tag: "Right",
    right: { decision: { outcome: "allow" } },
  });
  expect(answered.runs).toBe(1);
  const started = answered.named("guardian.started");
  expect(started).toHaveLength(1);
  expect(started[0]?.details).toMatchObject({ timing: { attempt: 1 } });
  const completed = answered.named("guardian.completed");
  expect(completed).toHaveLength(1);
  expect(completed[0]?.reviewId).toBe(started[0]?.reviewId);
  expect(completed[0]?.details).toMatchObject({ timing: { attempt: 1, followUpRounds: 1 } });

  const unanswered = await run(false);
  expect(unanswered.result).toMatchObject({ _tag: "Left", left: { code: "EntrypointNotRead" } });
  expect(unanswered.runs).toBe(1);
  expect(unanswered.named("guardian.review_retried")).toEqual([]);
  expect(unanswered.named("guardian.started")).toHaveLength(1);
  const failed = unanswered.named("guardian.failed");
  expect(failed).toHaveLength(1);
  expect(failed[0]?.details).toMatchObject({ timing: { attempt: 1, followUpRounds: 2 } });
});

it("returns the outage once it outlasts the retry budget", async () => {
  const f = flaky(() => new ReviewFailure({ code: "Unavailable" }), 100, {
    delays: ["20 millis"],
    budget: "50 millis",
  });
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const review = yield* Effect.fork(
        Effect.either(makeGuardian(f.reviewer).review(pending, readSource)),
      );
      for (let step = 0; step < 10; step++) yield* TestClock.adjust("20 millis");
      return yield* Fiber.join(review);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );
  expect(result).toMatchObject({ _tag: "Left", left: { code: "Unavailable" } });
  // Reviews at 0, 20 and 40 ms; waiting until 60 ms would pass the 50 ms budget.
  expect(f.runs()).toBe(3);
});

it("returns an outage at once for a reviewer with no retry", async () => {
  const f = flaky(() => new ReviewFailure({ code: "Unavailable" }), 1);
  const result = await Effect.runPromise(
    Effect.either(makeGuardian(f.reviewer).review(pending, readSource)),
  );
  expect(result).toMatchObject({ _tag: "Left", left: { code: "Unavailable" } });
  expect(f.runs()).toBe(1);
});

it("reports the provider's spent quota from Guardian's own model call, without reviewing again", async () => {
  let calls = 0;
  setDefaultModelProvider({
    getModel: () => ({
      getResponse: () => {
        calls++;
        return Promise.reject(
          Object.assign(new Error("Synthetic spent quota"), {
            name: "RateLimitError",
            status: 429,
            code: "insufficient_quota",
          }),
        );
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  });
  try {
    const result = await Effect.runPromise(
      Effect.either(
        makeGuardian({
          ...makeOpenAIReviewer("{{ tenant_policy_config }}", false, native),
          retry: quickRetry,
        }).review(pending, readSource),
      ),
    );
    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        code: "Unavailable",
        modelQuotaExhausted: true,
        failureDetail: { subCause: "model_quota_exhausted" },
      },
    });
    expect(calls).toBe(1);
  } finally {
    setDefaultModelProvider(new OpenAIProvider());
  }
});

/**
 * Runs `effect` on the test clock, moving the clock to each wait it schedules once the review is
 * parked in it, so the production retry's waits pass without real time.
 */
const onTestClock = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(effect);
      for (;;) {
        if (Option.isSome(yield* Fiber.poll(fiber))) return yield* Fiber.join(fiber);
        const wake = Chunk.head(yield* TestClock.sleeps());
        if (Option.isSome(wake)) yield* TestClock.setTime(wake.value);
        else yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1)));
      }
    }).pipe(Effect.provide(TestContext.TestContext)),
  );

/** Guardian's own model call failing every time with the provider's error `providerError`. */
const failingModelReview = async (providerError: () => Error) => {
  let calls = 0;
  const retried: unknown[] = [];
  const record: GuardianDiagnostics["emit"] = (name, details) =>
    Effect.sync(() => {
      if (name === "guardian.review_retried") retried.push(details);
    });
  setDefaultModelProvider({
    getModel: () => ({
      getResponse: () => {
        calls++;
        return Promise.reject(providerError());
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  });
  try {
    const result = await onTestClock(
      Effect.either(
        makeGuardian(
          {
            ...makeOpenAIReviewer("{{ tenant_policy_config }}", false, native),
            retry: guardianOutageRetry,
          },
          { emit: record, retainModelTranscript: record, retainScreenedSource: () => Effect.void },
        ).review(pending, readSource),
      ),
    );
    return { result, calls, retried };
  } finally {
    setDefaultModelProvider(new OpenAIProvider());
  }
};

/** A provider's server error, as its SDK raises it, with the provider's own `code`. */
const serverError = (code: string) =>
  Object.assign(new Error(`500 Synthetic provider failure (${code})`), {
    name: "InternalServerError",
    status: 500,
    code,
  });

it("fails a review over the model's context window once, without reviewing again", async () => {
  const review = await failingModelReview(() => serverError("context_length_exceeded"));
  expect(review.result).toMatchObject({ _tag: "Left", left: { code: "InputTooLarge" } });
  // The request is over the model's input limit, so the outage retry neither waits nor sends it
  // again.
  expect(review.calls).toBe(1);
  expect(review.retried).toEqual([]);
});

it("still reviews again after any other provider error, within the outage budget", async () => {
  const review = await failingModelReview(() => serverError("server_error"));
  expect(review.result).toMatchObject({ _tag: "Left", left: { code: "Unavailable" } });
  // Attempts at 0, 2, 7, 22, 52, 112, 172, 232 and 292 seconds; one more would pass 5 minutes.
  expect(review.calls).toBe(9);
  expect(review.retried).toHaveLength(8);
});
