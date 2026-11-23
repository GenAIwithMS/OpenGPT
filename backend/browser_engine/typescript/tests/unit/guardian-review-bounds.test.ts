import { OpenAIProvider, setDefaultModelProvider, Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { guardianModelCallBound } from "../../src/guardian/model.js";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import type { GuardianModelOptions } from "../../src/guardian/openai.js";
import { guardianOutageRetry, makeGuardian } from "../../src/guardian/review.js";
import type { GuardianDiagnostics, PendingExecution } from "../../src/guardian/review.js";

// A review has no deadline of its own. It is bounded by its turn limit, which ends in one turn
// that must decide, by a bound on each model call, which sends only that call again, and by the
// host's outage retry for provider errors.

afterEach(() => {
  vi.useRealTimers();
  setDefaultModelProvider(new OpenAIProvider());
});

const native = { executionEnvironment: nativeExecutionEnvironment };
const toolPath = "operation/src/tool.mjs";
const files = new Map([
  [toolPath, "export const read = async (page) => page.title();"],
  ["publication/definition.json", JSON.stringify({ name: "read_title" })],
  ["captures/page/dom.html", "<title>Synthetic page</title>"],
]);
const execution: PendingExecution = {
  invocationId: "invocation_bounds",
  attemptId: "attempt_bounds",
  entrypoint: toolPath,
  screenedIntent: "Read the page title",
  screenedInput: "{}",
  screenedObservations: "Synthetic fixture",
  accountScope: "account_bounds",
  allowedOrigins: ["https://example.test"],
  allowedEffects: ["read"],
};
const publication: PendingExecution = {
  ...execution,
  allowedOrigins: [],
  allowedEffects: ["Publish current package only"],
  publication: {
    files: [...files].map(([path, source]) => ({
      path,
      byteLength: Buffer.byteLength(source),
      published: !path.startsWith("captures/"),
      current: true,
      owner: path === toolPath ? ("minter" as const) : ("host" as const),
    })),
  },
};
const readSource = (path: string, offset: number) =>
  Effect.succeed(
    JSON.stringify({
      kind: "untrusted_source",
      path,
      byteOffset: offset,
      nextOffset: offset,
      hasMore: false,
      source: offset === 0 ? (files.get(path) ?? "") : "",
    }),
  );

const message = (value: unknown): ModelResponse["output"][number] => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: JSON.stringify(value) }],
});
const read = (path: string, callId: string): ModelResponse["output"][number] => ({
  type: "function_call",
  callId,
  name: "read_source",
  status: "completed",
  arguments: JSON.stringify({ path, offset: 0, match: null }),
});
const allowRead = { outcome: "allow", rationale: "Reads the title only.", action: "read" };
const allowPublication = {
  outcome: "allow",
  reason: "approved",
  rationale: "The evidence supports the claims.",
  findings: null,
  label: null,
  action: null,
};

/**
 * A scripted model. Each call gets its response from `respond`, after `ms` on the test's clock;
 * `ms: "never"` is a call that hangs until its signal aborts.
 */
const scripted = (
  respond: (
    call: number,
    request: ModelRequest,
  ) => {
    readonly ms?: number | "never";
    readonly output?: ModelResponse["output"];
    readonly error?: unknown;
  },
) => {
  const requests: ModelRequest[] = [];
  const aborted: number[] = [];
  setDefaultModelProvider({
    getModel: () => ({
      getResponse: async (request) => {
        requests.push(request);
        const call = requests.length;
        const turn = respond(call, request);
        if (turn.ms === "never")
          return new Promise<never>((_resolve, reject) => {
            request.signal?.addEventListener(
              "abort",
              () => {
                aborted.push(call);
                reject(new Error("Synthetic aborted call"));
              },
              { once: true },
            );
          });
        const ms = turn.ms;
        if (ms !== undefined) await new Promise((resolve) => setTimeout(resolve, ms));
        if (turn.error !== undefined) throw turn.error;
        return { usage: new Usage(), output: turn.output ?? [] };
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  });
  return { requests, aborted };
};

/** Runs `effect` to its end, moving the test's clock a second at a time for up to `limitMs`. */
const settle = async <A>(effect: Effect.Effect<A, unknown>, limitMs = 3_600_000) => {
  let settled = false;
  const result = Effect.runPromise(Effect.either(effect)).finally(() => {
    settled = true;
  });
  for (let elapsed = 0; elapsed < limitMs && !settled; elapsed += 1_000)
    await vi.advanceTimersByTimeAsync(1_000);
  return result;
};

/** The review requests in a request's input: one per review the conversation was sent. */
const reviewRequests = (request: ModelRequest | undefined) =>
  (typeof request?.input === "string" ? [request.input] : (request?.input ?? [])).filter(
    (item) =>
      typeof item === "string" ||
      (item.type === "message" &&
        item.role === "user" &&
        JSON.stringify(item.content).includes("trusted_review")),
  ).length;

const recordingDiagnostics = () => {
  const events: { name: string; details: unknown }[] = [];
  const diagnostics: GuardianDiagnostics = {
    emit: (name, details) =>
      Effect.sync(() => {
        events.push({ name, details });
      }),
    retainScreenedSource: () => Effect.void,
    retainModelTranscript: () => Effect.void,
  };
  return { events, diagnostics };
};

const reviewer = (options: Partial<GuardianModelOptions> = {}) => ({
  ...makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, {
    ...native,
    ...options,
  }),
  retry: guardianOutageRetry,
});

describe("a review with slow model calls", () => {
  it("runs to its decision past the old deadline, without starting the review again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    // Four calls of 100 s each: 400 s of reviewing, more than a publication review used to get,
    // and each call well inside the per-call bound.
    const reads = [toolPath, "publication/definition.json", "captures/page/dom.html"];
    const model = scripted((call) => ({
      ms: 100_000,
      output:
        call <= reads.length
          ? [read(reads[call - 1] ?? "", `read_${call}`)]
          : [message(allowPublication)],
    }));
    const { events, diagnostics } = recordingDiagnostics();
    const result = await settle(
      makeGuardian(reviewer(), diagnostics, {}).review(publication, readSource),
    );
    expect(result).toMatchObject({ _tag: "Right", right: { decision: { outcome: "allow" } } });
    expect(model.requests).toHaveLength(4);
    // The conversation got the publication request once: no second attempt sent it again.
    expect(reviewRequests(model.requests.at(-1))).toBe(1);
    expect(events.filter((event) => event.name === "guardian.started")).toHaveLength(1);
    expect(events.some((event) => event.name === "guardian.review_retried")).toBe(false);
  });
});

describe("a model call that hangs", () => {
  it("is sent again alone, with the same input, and the review goes on to decide", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const model = scripted((call) =>
      call === 1
        ? { output: [read(toolPath, "read_1")] }
        : call === 2
          ? { ms: "never" }
          : { output: [message(allowRead)] },
    );
    const { events, diagnostics } = recordingDiagnostics();
    const result = await settle(
      makeGuardian(reviewer(), diagnostics, {}).review(execution, readSource),
    );
    expect(result).toMatchObject({ _tag: "Right", right: { decision: { outcome: "allow" } } });
    expect(model.requests).toHaveLength(3);
    expect(model.aborted).toEqual([2]);
    expect(model.requests[2]?.input).toEqual(model.requests[1]?.input);
    expect(reviewRequests(model.requests.at(-1))).toBe(1);
    expect(events.filter((event) => event.name === "guardian.started")).toHaveLength(1);
    expect(events.find((event) => event.name === "guardian.model_call_retried")).toMatchObject({
      details: { details: { attempt: 1, timeoutMs: guardianModelCallBound.timeoutMs } },
    });
  });

  it("ends as ModelCallStalled once its retries are spent, and is not started again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const model = scripted(() => ({ ms: "never" }));
    const { events, diagnostics } = recordingDiagnostics();
    const result = await settle(
      makeGuardian(
        reviewer({ modelCallBound: { timeoutMs: 10_000, retries: 2 } }),
        diagnostics,
        {},
      ).review(execution, readSource),
    );
    expect(result).toMatchObject({
      _tag: "Left",
      left: { code: "ModelCallStalled", reviewPhase: "review_computation" },
    });
    expect(model.requests).toHaveLength(3);
    expect(model.aborted).toEqual([1, 2, 3]);
    expect(events.filter((event) => event.name === "guardian.started")).toHaveLength(1);
    expect(events.some((event) => event.name === "guardian.review_retried")).toBe(false);
  });
});

describe("a review that reaches its turn limit", () => {
  it("gets one turn that cannot read and must decide, and returns that decision", async () => {
    const model = scripted((call, request) =>
      request.modelSettings.toolChoice === "none"
        ? { output: [message(allowRead)] }
        : { output: [read(toolPath, `read_${call}`)] },
    );
    const result = await Effect.runPromise(
      Effect.either(
        makeGuardian(reviewer({ specialize: () => ({ maxTurns: 3 }) }), undefined, {}).review(
          execution,
          readSource,
        ),
      ),
    );
    expect(result).toMatchObject({ _tag: "Right", right: { decision: { outcome: "allow" } } });
    expect(model.requests).toHaveLength(4);
    const toolChoices = model.requests.map((request) => request.modelSettings.toolChoice);
    expect(toolChoices.slice(0, 3)).not.toContain("none");
    expect(model.requests[3]?.modelSettings.toolChoice).toBe("none");
    // The final turn continues the same conversation: every read so far is in its input.
    const finalInput = model.requests[3]?.input;
    expect(
      (typeof finalInput === "string" ? [] : (finalInput ?? [])).filter(
        (item) => item.type === "function_call_result",
      ),
    ).toHaveLength(3);
    expect(reviewRequests(model.requests[3])).toBe(1);
  });

  it("fails as TurnLimitExceeded when the final turn still reads, with no new try", async () => {
    const model = scripted((call) => ({ output: [read(toolPath, `read_${call}`)] }));
    const { events, diagnostics } = recordingDiagnostics();
    const result = await Effect.runPromise(
      Effect.either(
        makeGuardian(reviewer({ specialize: () => ({ maxTurns: 3 }) }), diagnostics, {}).review(
          execution,
          readSource,
        ),
      ),
    );
    expect(result).toMatchObject({ _tag: "Left", left: { code: "TurnLimitExceeded" } });
    expect(model.requests).toHaveLength(4);
    expect(events.filter((event) => event.name === "guardian.started")).toHaveLength(1);
  });
});

describe("a provider outage", () => {
  it("still reviews again after the outage retry's wait", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const outage = Object.assign(new Error("Synthetic service unavailable"), { status: 503 });
    const model = scripted((call) =>
      call === 1
        ? { error: outage }
        : call === 2
          ? { output: [read(toolPath, "read_2")] }
          : { output: [message(allowRead)] },
    );
    const { events, diagnostics } = recordingDiagnostics();
    const result = await settle(
      makeGuardian(reviewer(), diagnostics).review(execution, readSource),
    );
    expect(result).toMatchObject({ _tag: "Right", right: { decision: { outcome: "allow" } } });
    expect(model.requests).toHaveLength(3);
    expect(events.filter((event) => event.name === "guardian.started")).toHaveLength(2);
    expect(events.find((event) => event.name === "guardian.review_retried")).toMatchObject({
      details: { code: "Unavailable", waitMs: 2_000 },
    });
  });

  it("is retried however long the review ran before it, since the budget counts only the outage", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
    // 300 s of healthy reading, past the outage retry's 5-minute budget, and then a 503.
    const outage = Object.assign(new Error("Synthetic service unavailable"), { status: 503 });
    const reads = [toolPath, "publication/definition.json", "captures/page/dom.html"];
    const model = scripted((call) =>
      call <= reads.length
        ? { ms: 100_000, output: [read(reads[call - 1] ?? "", `read_${call}`)] }
        : call === reads.length + 1
          ? { error: outage }
          : { output: [message(allowPublication)] },
    );
    const { events, diagnostics } = recordingDiagnostics();
    const result = await settle(
      makeGuardian(reviewer(), diagnostics, {}).review(publication, readSource),
    );
    expect(result).toMatchObject({ _tag: "Right", right: { decision: { outcome: "allow" } } });
    expect(model.requests).toHaveLength(5);
    expect(events.find((event) => event.name === "guardian.review_retried")).toMatchObject({
      details: { code: "Unavailable", waitMs: 2_000, outageMs: 0 },
    });
  });
});
