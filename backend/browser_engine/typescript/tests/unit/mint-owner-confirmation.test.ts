import { OpenAIProvider, setDefaultModelProvider, Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import { answersForReview, questionForReview } from "../../src/guardian/question.js";
import type { AnsweredQuestion } from "../../src/guardian/question.js";
import { makeGuardian, ReviewFailure } from "../../src/guardian/review.js";
import type { PendingExecution } from "../../src/guardian/review.js";
import { makeSourceInspector } from "../../src/guardian/source.js";
import { MintFailure } from "../../src/mint/contracts.js";
import type { AgentInputRequest, MintDependencies } from "../../src/mint/contracts.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { reviewDenied } from "../../src/mint/review-context.js";
import { makeMintContinuationFixture } from "../support/mint-fixtures.js";
import { portableJobSession } from "../support/portable-mint.js";

/*
 * A step Guardian holds for the owner's confirmation, through the real minter loop and the real
 * Guardian on recorded responses: the minter asks the owner with a confirm question that names
 * the refusal, the owner says yes, and the same step then runs, even when the next review at first
 * refuses it again for want of that confirmation. Before, that refusal stood, the update review
 * refused to overturn it, and the build ended blocked.
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

const trustStep = {
  purpose: "explore",
  target: "liveBrowser",
  entrypoint: "src/trust.ts",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 30,
};

const prompt =
  "The sign-in screen offers a \"Trust this device\" box. Ticking it lets the site remember the build's browser for this account. Tick it?";

/** The minter's confirm question, naming the refusal whose step it asks about. */
const confirmQuestion = (reviewId: string) => ({
  questions: [{ id: "trust_device", type: "confirm", prompt, confirmsReview: reviewId }],
});

/** The reviewId of the latest refusal the minter read, from its request's history. */
const refusedReviewId = (request: ModelRequest) =>
  [...JSON.stringify(request.input).matchAll(/\\"reviewId\\":\\"([^"\\]+)\\"/gu)].at(-1)?.[1] ??
  "missing";

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

const askOwner = decision({
  outcome: "escalate",
  rationale: "Ticking the trust box saves a lasting choice; ask the owner first.",
  refusal: "correctable",
  refusalGround: "owner_confirmation",
});

const reader = makeSourceInspector(
  (path) =>
    path === "src/trust.ts"
      ? Effect.succeed(
          new TextEncoder().encode("await page.getByLabel('Trust this device').check();"),
        )
      : Effect.fail(new ReviewFailure({ code: "SourceUnavailable" })),
  (_path, bytes) => Effect.succeed(new TextDecoder().decode(bytes)),
);

/**
 * A host over the real Guardian, as the local host wires it: each step and question is reviewed in
 * one job, and the owner's answers reach every later review.
 */
const guardianHost = (outputs: readonly ModelResponse["output"][]) => {
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
  const answered: AnsweredQuestion[] = [];
  const ran: string[] = [];
  const asked: AgentInputRequest[] = [];
  const turn = (entrypoint: string): PendingExecution => ({
    invocationId: "confirm_job",
    attemptId: "confirm_attempt",
    entrypoint,
    screenedIntent: "List the synthetic shop's saved orders",
    screenedInput: "{}",
    screenedObservations: "Synthetic fixture",
    accountScope: "account_confirm",
    allowedOrigins: ["https://shop.example.test"],
    allowedEffects: ["Read the shop's order pages"],
    answeredQuestions: [...answered],
    mintContext: {
      repeatableRead: false,
      operationSources: [entrypoint],
      executedSources: [entrypoint],
      browser: "active",
      currentExecution: { purpose: "explore", target: "liveBrowser" },
      executions: [],
    },
  });
  const dependencies: Partial<MintDependencies> = {
    reviewAndExecute: (submitted, beforeDispatch = () => Effect.void) =>
      Effect.gen(function* () {
        const entrypoint = submitted.purpose === "command" ? "command" : submitted.entrypoint;
        const { reviewId, decision } = yield* guardian
          .review(turn(entrypoint), reader)
          .pipe(Effect.mapError(() => new MintFailure({ code: "ReviewUnavailable" })));
        if (decision.outcome !== "allow")
          return yield* reviewDenied(reviewId, { ...decision, outcome: decision.outcome });
        yield* beforeDispatch({ reviewId, action: decision.action ?? "read" });
        ran.push(entrypoint);
        return {
          executionId: `execution_${ran.length}`,
          status: "completed",
          effect: "verified",
          resultRef: "protected_result",
          observations: { value: "public" },
        };
      }),
    reviewQuestion: (candidate, facts) =>
      Effect.gen(function* () {
        // The minter's closing words are reviewed as a report; this job's Guardian script is
        // only for its steps and its question.
        if (facts?.blockedOutcome === true)
          return { outcome: "allow_business" as const, rationale: "Synthetic report." };
        const question = yield* questionForReview(
          candidate,
          { credentialsAvailable: false, ...facts },
          (text) => Effect.succeed(text),
        );
        const result = yield* guardian.reviewQuestion(turn("question"), question, reader);
        return { ...result.decision, reviewId: result.reviewId };
      }).pipe(Effect.mapError(() => new MintFailure({ code: "ReviewUnavailable" }))),
    askInput: (candidate) =>
      Effect.gen(function* () {
        asked.push(candidate);
        const answers = { trust_device: { type: "confirm" as const, value: { confirmed: true } } };
        answered.push(
          ...(yield* answersForReview(candidate, answers, (text) => Effect.succeed(text))),
        );
        return answers;
      }),
  };
  return { reviews, ran, asked, dependencies };
};

it("runs the step the owner confirmed after Guardian held it for that confirmation", async () => {
  const host = guardianHost([
    askOwner,
    decision({ outcome: "allow_business", rationale: "Only the owner decides." }),
    // The next review at first asks again, as before the fix, and the host sends it back.
    decision({
      outcome: "escalate",
      rationale: "The box needs the owner's authority; propose a task update.",
      refusal: "final",
      refusalGround: "owner_confirmation",
    }),
    decision({ outcome: "allow", rationale: "The owner confirmed it.", action: "read" }),
  ]);
  const f = await fixture(
    (request, index) =>
      [
        call("execute", trustStep, "trust_1"),
        call("request_input", confirmQuestion(refusedReviewId(request)), "ask"),
        call("execute", trustStep, "trust_2"),
      ][index] ?? prose("Stopping."),
    host.dependencies,
    { effect: "read" },
  );
  await f.run();
  expect(host.ran).toEqual(["src/trust.ts"]);
  expect(host.reviews).toHaveLength(4);
  // The owner reads a plain confirm: the mark stays between the minter, the host and Guardian.
  expect(host.asked).toEqual([
    { questions: [{ id: "trust_device", type: "confirm", prompt }] },
  ]);
});

it("refuses a confirm question that names no refusal of this build", async () => {
  const host = guardianHost([]);
  const f = await fixture(
    (_request, index) =>
      [call("request_input", confirmQuestion("review_not_in_this_build"), "ask")][index] ??
      prose("Stopping."),
    host.dependencies,
    { effect: "read" },
  );
  await f.run();
  expect(host.reviews).toHaveLength(0);
  expect(host.asked).toHaveLength(0);
  expect(JSON.stringify(f.requests[1]?.input)).toContain("confirms_unknown_review");
});

it("refuses a confirm question that reuses the id of a question the owner already answered", async () => {
  // The last scripted allow is what a second review of the reused question would reach.
  const host = guardianHost([
    askOwner,
    decision({ outcome: "allow_business", rationale: "Only the owner decides." }),
    decision({ outcome: "allow_business", rationale: "Only the owner decides." }),
  ]);
  const f = await fixture(
    (request, index) =>
      [
        call("execute", trustStep, "trust_1"),
        call("request_input", confirmQuestion(refusedReviewId(request)), "ask_1"),
        call("request_input", confirmQuestion(refusedReviewId(request)), "ask_2"),
      ][index] ?? prose("Stopping."),
    host.dependencies,
    { effect: "read" },
  );
  await f.run();
  // The second ask never reaches review or the owner: its id already holds the owner's answer.
  expect(host.reviews).toHaveLength(2);
  expect(host.asked).toHaveLength(1);
  expect(JSON.stringify(f.requests[3]?.input)).toContain("confirms_question_reused");
});
