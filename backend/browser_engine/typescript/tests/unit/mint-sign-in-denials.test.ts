import { Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { MintFailure, type MintDependencies } from "../../src/mint/contracts.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { makeMintContinuationFixture } from "../support/mint-fixtures.js";
import { portableJobSession } from "../support/portable-mint.js";

/*
 * Guardian can deny a sign-in step as correctable while asking for something the step cannot say.
 * The minter sends the same step again and again, no blocked ending applies to a correctable
 * denial, and the build loops until the minter answers without a tool call three times, with no
 * reason. Three correctable denials in a row of one unchanged step end sign-in in the build, the
 * way three identical host refusals do. Every scenario runs the real minter loop on recorded
 * model responses.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);

const site = "https://member.example.test";
const usage = () => new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 });
const intentTools = new Set(["execute", "finish_build", "request_input", "report_blocked"]);
const call = (name: string, input: object, callId: string): ModelResponse => ({
  usage: usage(),
  output: [
    {
      type: "function_call",
      name,
      callId,
      arguments: JSON.stringify(
        intentTools.has(name) ? { ...input, intent: `Synthetic ${name} purpose` } : input,
      ),
      status: "completed",
    },
  ],
});
const prose = (text = "The sign-in could not continue."): ModelResponse => ({
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

/** A code split across six one-character boxes, as the minter names the screen. */
const codeStep = {
  fields: [1, 2, 3, 4, 5, 6].map((box) => ({ selector: `input[name="pin${box}"]`, slot: "code" })),
  submit: "#verify",
};
/** The same screen with a corrected submit: a changed step. */
const changedStep = { ...codeStep, submit: "button[type=submit]" };
const execution = {
  target: "liveBrowser",
  entrypoint: "src/tool.ts",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 30,
};
const authenticate = (callId: string, signInStep: object = codeStep) =>
  call("execute", { ...execution, purpose: "authenticate", signInStep }, callId);
const explore = (callId: string) => call("execute", { ...execution, purpose: "explore" }, callId);
const pureExample = (callId: string) =>
  call("execute", { ...execution, purpose: "example", target: "pureFiles" }, callId);

const rationale =
  "The code boxes are listed without the placement the screen needs; add it to each field.";
/** Guardian's denial of an execution, marked as one a correction gets past. */
const denied = (reviewId: string, text = rationale) =>
  new MintFailure({
    code: "ReviewDenied",
    review: { outcome: "deny", reviewId, rationale: text, refusal: "correctable" },
  });

/**
 * The host's execution: each execute takes the next scripted answer, a denial or `allow`; once
 * the script runs out, the step is allowed. An allowed step completes.
 */
const scripted = (answers: readonly (MintFailure | "allow")[]) => {
  const queue = [...answers];
  let runs = 0;
  return {
    runs: () => runs,
    reviewAndExecute: ((submitted, beforeDispatch = () => Effect.void) => {
      runs++;
      const next = queue.shift() ?? "allow";
      if (next instanceof MintFailure) return Effect.fail(next);
      return beforeDispatch({
        reviewId: `review_allowed_${runs}`,
        action: submitted.purpose === "authenticate" ? "authentication" : "read",
      }).pipe(
        Effect.as({
          executionId: `execution_${runs}`,
          status: "completed" as const,
          effect:
            submitted.purpose === "authenticate" ? ("possible" as const) : ("verified" as const),
          ...(submitted.purpose === "example" ? { resultRef: "protected_result" } : {}),
          observations: { value: "public" },
        }),
      );
    }) satisfies MintDependencies["reviewAndExecute"],
  };
};

/** The execute answer the model read for `callId`. */
const answerTo = (request: ModelRequest | undefined, callId: string) => {
  const items = Array.isArray(request?.input) ? request.input : [];
  const item = items.find(
    (entry) => entry.type === "function_call_result" && entry.callId === callId,
  );
  const output = item?.type === "function_call_result" ? item.output : undefined;
  const text =
    typeof output === "string"
      ? output
      : output !== undefined && "text" in output
        ? output.text
        : "";
  return JSON.parse(text === "" ? "{}" : text) as Record<string, unknown>;
};
/** The diagnostic that recorded sign-in as unavailable, if any. */
const signInEnded = (diagnostics: readonly string[]) =>
  diagnostics
    .map((entry) => JSON.parse(entry) as Record<string, unknown>)
    .find((entry) => entry["phase"] === "sign_in" && entry["reason"] === "sign_in_unavailable");

const endedSentence = "Guardian denied the same sign-in step 3 times in a row";

it("ends sign-in at the third correctable denial of the same step, with Guardian's reason on record", async () => {
  const host = scripted([denied("review_1"), denied("review_2"), denied("review_3")]);
  const run = await fixture(
    (_request, index) =>
      [
        authenticate("sign_in_1"),
        authenticate("sign_in_2"),
        authenticate("sign_in_3"),
        call(
          "report_blocked",
          { reason: "policy", explanation: "Guardian keeps denying the code step." },
          "blocked",
        ),
      ][index] ?? prose(),
    { autofillSignIn: true, reviewAndExecute: host.reviewAndExecute },
    { effect: "read", siteOrigin: site },
  );
  const outcome = await run.run();
  expect(host.runs()).toBe(3);
  // The second denial still asks for a correction.
  const second = answerTo(run.requests[2], "sign_in_2");
  expect(second).toMatchObject({ status: "review_rejected", rationale });
  expect(second).not.toHaveProperty("nextStep");
  // The third ends the build at once: the model is not asked again.
  expect(run.requests).toHaveLength(3);
  expect(outcome).toMatchObject({
    build: "incomplete",
    recoveryReason: "sign_in_unavailable",
    stopReason: "sign_in_failed",
  });
  expect(outcome.summary).toContain(endedSentence);
  expect(outcome.summary).not.toContain(rationale);
  expect(signInEnded(outcome.diagnostics)).toMatchObject({
    spentSignIn: "guardian_denials_repeated",
    reviewId: "review_3",
    rationale,
  });
});

// Guardian rewords its rationale from one review to the next, so the wording does not decide it:
// the step did not change, so a fourth try would not either.
it("ends sign-in when the same unchanged step is denied three times for different reasons", async () => {
  const host = scripted([
    denied("review_1", "The code boxes need their placement."),
    denied("review_2", "Uncheck the remembered-device box first."),
    denied("review_3", "Each code box still lacks its place among the boxes."),
  ]);
  const run = await fixture(
    (_request, index) => (index < 3 ? authenticate(`sign_in_${index + 1}`) : prose()),
    { autofillSignIn: true, reviewAndExecute: host.reviewAndExecute },
    { effect: "read", siteOrigin: site },
  );
  const outcome = await run.run();
  expect(run.requests).toHaveLength(3);
  expect(outcome).toMatchObject({ recoveryReason: "sign_in_unavailable" });
  expect(signInEnded(outcome.diagnostics)).toMatchObject({
    reviewId: "review_3",
    rationale: "Each code box still lacks its place among the boxes.",
  });
});

it("goes on when the same step is allowed after two denials", async () => {
  const host = scripted([denied("review_1"), denied("review_2"), "allow"]);
  const run = await fixture(
    (_request, index) => (index < 3 ? authenticate(`sign_in_${index + 1}`) : prose()),
    { autofillSignIn: true, reviewAndExecute: host.reviewAndExecute },
    { effect: "read", siteOrigin: site },
  );
  const outcome = await run.run();
  expect(host.runs()).toBe(3);
  expect(answerTo(run.requests[3], "sign_in_3")).toMatchObject({ status: "completed" });
  expect(outcome.recoveryReason).not.toBe("sign_in_unavailable");
  expect(signInEnded(outcome.diagnostics)).toBeUndefined();
});

// A changed step is a correction: the count starts again from it, and three denials in a row of
// the step as it now stands end sign-in.
it("starts the count again when the step changes between denials", async () => {
  const steps = [codeStep, changedStep, codeStep, codeStep, codeStep];
  const host = scripted(steps.map((_, index) => denied(`review_${index + 1}`)));
  const run = await fixture(
    (_request, index) => {
      const step = steps[index];
      return step === undefined ? prose() : authenticate(`sign_in_${index + 1}`, step);
    },
    { autofillSignIn: true, reviewAndExecute: host.reviewAndExecute },
    { effect: "read", siteOrigin: site },
  );
  const outcome = await run.run();
  // The fourth is only the second denial in a row of the step as it now stands.
  expect(answerTo(run.requests[4], "sign_in_4")).not.toHaveProperty("nextStep");
  expect(run.requests).toHaveLength(5);
  expect(outcome).toMatchObject({ recoveryReason: "sign_in_unavailable" });
  expect(signInEnded(outcome.diagnostics)).toMatchObject({ reviewId: "review_5" });
});

// An explore or a question between them runs no sign-in step, so the denials are still in a row.
it("keeps counting across an explore and a question between denials", async () => {
  const host = scripted([denied("review_1"), "allow", denied("review_2"), denied("review_3")]);
  const run = await fixture(
    (_request, index) =>
      [
        authenticate("sign_in_1"),
        explore("look"),
        authenticate("sign_in_2"),
        call(
          "request_input",
          { questions: [{ id: "device", type: "text", prompt: "Keep this device remembered?" }] },
          "ask",
        ),
        authenticate("sign_in_3"),
      ][index] ?? prose(),
    {
      autofillSignIn: true,
      reviewAndExecute: host.reviewAndExecute,
      askInput: () => Effect.succeed({ device: { type: "text", value: "No" } }),
    },
    { effect: "read", siteOrigin: site },
  );
  const outcome = await run.run();
  expect(host.runs()).toBe(4);
  expect(run.requests).toHaveLength(5);
  expect(outcome).toMatchObject({ recoveryReason: "sign_in_unavailable" });
});

// Only a host autofill sign-in step counts: an explore, or an authenticate that runs the minter's
// own source, is judged as before however often Guardian denies it.
it.each([
  { kind: "explore", step: explore },
  {
    kind: "authenticate without a sign-in step",
    step: (callId: string) => call("execute", { ...execution, purpose: "authenticate" }, callId),
  },
])("never ends sign-in for repeated denials of an $kind", async ({ step }) => {
  const host = scripted([denied("review_1"), denied("review_2"), denied("review_3")]);
  const run = await fixture(
    (_request, index) => (index < 3 ? step(`step_${index + 1}`) : prose()),
    { autofillSignIn: true, reviewAndExecute: host.reviewAndExecute },
    { effect: "read", siteOrigin: site },
  );
  const outcome = await run.run();
  expect(host.runs()).toBe(3);
  expect(answerTo(run.requests[3], "step_3")).toMatchObject({ status: "review_rejected" });
  expect(outcome.recoveryReason).not.toBe("sign_in_unavailable");
  expect(signInEnded(outcome.diagnostics)).toBeUndefined();
});

// A retained receipt may still publish, so the ending waits for the model to stop, as it does for
// any sign-in that becomes unavailable; the third answer tells the agent why and what comes next.
it("tells the agent sign-in is unavailable and holds the ending for a receipt that may publish", async () => {
  const host = scripted(["allow", denied("review_1"), denied("review_2"), denied("review_3")]);
  const run = await fixture(
    (_request, index) =>
      [
        pureExample("example"),
        authenticate("sign_in_1"),
        authenticate("sign_in_2"),
        authenticate("sign_in_3"),
        authenticate("sign_in_4"),
      ][index] ?? prose(),
    { autofillSignIn: true, reviewAndExecute: host.reviewAndExecute },
    { effect: "read", siteOrigin: site },
  );
  const outcome = await run.run();
  const third = answerTo(run.requests[4], "sign_in_3");
  expect(third).toMatchObject({
    status: "review_rejected",
    reviewId: "review_3",
    rationale,
    nextStep: "report_sign_in_unavailable",
    spentSignIn: "guardian_denials_repeated",
  });
  expect(third["notice"]).toContain("3 times in a row");
  expect(third["notice"]).toContain("A retained receipt may still publish");
  // A later authenticate gets the same answer and runs nothing.
  expect(answerTo(run.requests[5], "sign_in_4")).toEqual(third);
  expect(host.runs()).toBe(4);
  expect(outcome).toMatchObject({ recoveryReason: "sign_in_unavailable" });
});
