import { OpenAIProvider, setDefaultModelProvider, Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import { makeGuardian, ReviewFailure } from "../../src/guardian/review.js";
import type { PendingExecution } from "../../src/guardian/review.js";
import { makeSourceInspector } from "../../src/guardian/source.js";
import { MintFailure } from "../../src/mint/contracts.js";
import type { ExecutionEvidence, MintDependencies } from "../../src/mint/contracts.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { reviewDenied } from "../../src/mint/review-context.js";
import { makeMintContinuationFixture, readAllow } from "../support/mint-fixtures.js";
import { portableJobSession } from "../support/portable-mint.js";

/*
 * How Guardian's refusals of a write build's act steps decide whether the minter may end the build
 * as a policy block. A refusal that rests on missing write authority, when the step's own authority
 * grants the write, never lets it; a run of refusals of the act step with no act step allowed
 * between lets it at the fifth. Every scenario runs the real minter loop on recorded responses.
 */

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  setDefaultModelProvider(new OpenAIProvider());
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);

const usage = () => new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 });

const prose = (text: string): ModelResponse => ({
  usage: usage(),
  output: [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    },
  ],
});

/** A minter tool call with its declared intent. */
const call = (name: string, input: object, callId = name): ModelResponse => ({
  usage: usage(),
  output: [
    {
      type: "function_call",
      name,
      callId,
      arguments: JSON.stringify({ ...input, intent: `Synthetic ${name} purpose` }),
      status: "completed",
    },
  ],
});

const step = (entrypoint: string, purpose: "act" | "explore" = "act") => ({
  purpose,
  target: "liveBrowser",
  entrypoint,
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 30,
});

const explanation =
  "The safety review would not let the step fill the quote form's required field, so nothing was sent.";
const reportPolicy = call("report_blocked", { reason: "policy", explanation });

const completed = (executionId: string): ExecutionEvidence => ({
  executionId,
  status: "completed",
  effect: "verified",
  resultRef: "protected_result",
  observations: { value: "public" },
});

/** Guardian's correctable refusal of a step, as the host returns it to the harness. */
const refused = (entrypoint: string, outcome: "deny" | "escalate" = "deny") =>
  reviewDenied(`review_${entrypoint}`, {
    outcome,
    rationale: "Fill the field with the supplied value through the page's own control.",
    refusal: "correctable",
  });

/**
 * A scripted host: each step's entrypoint decides Guardian's answer. A refused entrypoint fails
 * before dispatch; any other passes the dispatch fence with its label and completes.
 */
const scriptedHost =
  (
    refusals: ReadonlyMap<string, "deny" | "escalate">,
  ): MintDependencies["reviewAndExecute"] =>
  (submitted, beforeDispatch = () => Effect.void) =>
    Effect.gen(function* () {
      const entrypoint = submitted.purpose === "command" ? "command" : submitted.entrypoint;
      const outcome = refusals.get(entrypoint);
      if (outcome !== undefined) return yield* refused(entrypoint, outcome);
      yield* beforeDispatch(
        submitted.purpose === "act"
          ? { reviewId: `review_${entrypoint}`, action: "write" }
          : readAllow,
      );
      return completed(`execution_${entrypoint.replace(/\W/g, "_")}`);
    });

/** The minter's script: each response in turn, then plain answers. */
const script =
  (responses: readonly ModelResponse[]) =>
  (_request: ModelRequest, index: number): ModelResponse =>
    responses[index] ?? prose("Stopping.");

/** The act steps' entrypoints, one per submission, so no step repeats an earlier one's file. */
const acts = (from: number, count: number) =>
  Array.from({ length: count }, (_unused, index) => `src/act-${from + index}.ts`);

it.each(["deny", "escalate"] as const)(
  "ends the build as policy, with its reviewed explanation, after the act step's fifth refusal in a row (the fifth a %s)",
  async (fifth) => {
    const refusedActs = acts(1, 5);
    const responses = [
      call("execute", step(refusedActs[0]!), "act_1"),
      call("execute", step(refusedActs[1]!), "act_2"),
      // A read-only look between refusals is no act step, so the run goes on.
      call("execute", step("src/look.ts", "explore"), "look"),
      call("execute", step(refusedActs[2]!), "act_3"),
      call("execute", step(refusedActs[3]!), "act_4"),
      call("execute", step(refusedActs[4]!), "act_5"),
      reportPolicy,
    ];
    const f = await fixture(
      script(responses),
      {
        reviewAndExecute: scriptedHost(
          new Map(refusedActs.map((path, index) => [path, index === 4 ? fifth : "deny"])),
        ),
      },
      { effect: "write" },
    );
    expect(await f.run()).toMatchObject({
      build: "incomplete",
      blocked: { reason: "policy", explanation },
      stopReason: "policy",
    });
  },
);

it("refuses a policy block after only four refusals of the act step in a row", async () => {
  const refusedActs = acts(1, 4);
  const responses = [
    ...refusedActs.map((path, index) => call("execute", step(path), `act_${index + 1}`)),
    reportPolicy,
  ];
  const f = await fixture(
    script(responses),
    { reviewAndExecute: scriptedHost(new Map(refusedActs.map((path) => [path, "deny"]))) },
    { effect: "write" },
  );
  const outcome = await f.run();
  expect(outcome).not.toHaveProperty("blocked");
  expect(JSON.stringify(f.requests[responses.length]?.input)).toContain("policy_not_refused");
});

it("starts the count again after Guardian allows an act step", async () => {
  const before = acts(1, 3);
  const after = acts(5, 4);
  const responses = [
    ...before.map((path, index) => call("execute", step(path), `before_${index + 1}`)),
    call("execute", step("src/act-4.ts"), "allowed"),
    ...after.map((path, index) => call("execute", step(path), `after_${index + 1}`)),
    reportPolicy,
  ];
  const f = await fixture(
    script(responses),
    {
      reviewAndExecute: scriptedHost(
        new Map([...before, ...after].map((path) => [path, "deny" as const])),
      ),
    },
    { effect: "write" },
  );
  const outcome = await f.run();
  expect(outcome).not.toHaveProperty("blocked");
  expect(JSON.stringify(f.requests[responses.length]?.input)).toContain("policy_not_refused");
});

/** Guardian's scripted model output, in the shared decision format. */
const decision = (value: Record<string, unknown>): ModelResponse["output"] => [
  {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [
      {
        type: "output_text",
        text: JSON.stringify({
          reason: null,
          findings: null,
          publicReason: null,
          label: null,
          action: null,
          refusal: null,
          refusalGround: null,
          advice: null,
          ...value,
        }),
      },
    ],
  },
];

/** A write build's act step, whose own allowed effects grant the write. */
const actWithAuthority: PendingExecution = {
  invocationId: "act_refusal_job",
  attemptId: "act_refusal_attempt",
  entrypoint: "operation/step.mjs",
  screenedIntent: "Send the synthetic quote form once with the caller's values",
  screenedInput: '{"email":"quote@example.test"}',
  screenedObservations: "Synthetic fixture",
  accountScope: "account_act_refusal",
  allowedOrigins: ["https://quotes.example.test"],
  allowedEffects: ["Send the quote form once with the caller's values"],
  writeAuthority: true,
  mintContext: {
    repeatableRead: false,
    operationSources: ["operation/step.mjs"],
    browser: "active",
    executions: [],
    currentExecution: { purpose: "act", target: "liveBrowser" },
  },
};

const reader = makeSourceInspector(
  (path) =>
    path === "operation/step.mjs"
      ? Effect.succeed(new TextEncoder().encode("export default 'synthetic step';"))
      : Effect.fail(new ReviewFailure({ code: "SourceUnavailable" })),
  (_path, bytes) => Effect.succeed(new TextDecoder().decode(bytes)),
);

it("refuses a policy block when Guardian keeps refusing an act step for missing write authority the step has", async () => {
  // Guardian refuses the act step as final for lacking write authority, and keeps the refusal
  // once the host says the step's own authority grants the write.
  const outputs = [0, 1].map(() =>
    decision({
      outcome: "deny",
      rationale: "The allowed effects prohibit all writes, so sending the form is out of authority.",
      action: "write",
      refusal: "final",
      refusalGround: "write_authority",
    }),
  );
  const reviews: ModelRequest[] = [];
  setDefaultModelProvider({
    getModel: () => ({
      getResponse: async (request) => {
        const output = outputs[reviews.length];
        reviews.push(request);
        if (output === undefined) throw new Error("No scripted response");
        return { usage: new Usage(), output };
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  });
  const guardian = makeGuardian({
    ...makeOpenAIReviewer("{{ tenant_policy_config }}", false, {
      executionEnvironment: nativeExecutionEnvironment,
    }),
    retry: { delays: ["1 millis"], budget: "1 minute" },
  });
  // Reviews the act step as a host does: Guardian's refusal is the step's denial.
  const reviewAndExecute: MintDependencies["reviewAndExecute"] = (
    _submitted,
    beforeDispatch = () => Effect.void,
  ) =>
    Effect.gen(function* () {
      const { reviewId, decision } = yield* guardian
        .review(actWithAuthority, reader)
        .pipe(Effect.mapError(() => new MintFailure({ code: "ReviewUnavailable" })));
      if (decision.outcome !== "allow")
        return yield* reviewDenied(reviewId, { ...decision, outcome: decision.outcome });
      yield* beforeDispatch({ reviewId, action: decision.action ?? "read" });
      return completed("execution_act");
    });
  const responses = [call("execute", step("src/send.ts"), "send"), reportPolicy];
  const f = await fixture(script(responses), { reviewAndExecute }, { effect: "write" });
  const outcome = await f.run();
  expect(reviews).toHaveLength(2);
  expect(outcome).not.toHaveProperty("blocked");
  expect(JSON.stringify(f.requests[responses.length]?.input)).toContain("policy_not_refused");
});
