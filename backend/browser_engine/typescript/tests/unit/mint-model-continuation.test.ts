import {
  fixtureAllow,
  makeMintContinuationFixture,
  readAllow,
  portableJobSession,
} from "../support/mint-fixtures.js";
import { Usage } from "@openai/agents";
import type { AgentInputItem, ModelRequest, ModelResponse } from "@openai/agents";
import { Clock, Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { MintFailure } from "../../src/mint/contracts.js";
import type { MintDependencies, PublicationDecision } from "../../src/mint/contracts.js";
import type { ModelObserverFactory } from "../../src/models/model-observer.js";
import type { MintRecoveryFactory } from "../../src/mint/recovery-contracts.js";
import { EventUnavailable } from "../../src/runtime/errors.js";
import { makeGuardian, ReviewFailure } from "../../src/guardian/review.js";
import type { PendingExecution } from "../../src/guardian/review.js";
import { makeSourceInspector } from "../../src/guardian/source.js";
import { publicationScope } from "../../src/mint/publication-review.js";
import { reviewDenied } from "../../src/mint/review-context.js";
import { memoryPublicationDecisions } from "../../src/standalone/publication-decisions.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { signInUnavailableSummary } from "../../src/mint/sign-in-failure.js";
import { Deadline } from "../../src/runtime/deadline.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const prose = (text = "I stopped before publication."): ModelResponse => ({
  usage: new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
  output: [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    },
  ],
});

const intentTools = new Set(["execute", "finish_build", "request_input", "report_blocked"]);

/** One free-text question, as the agent asks it. */
const ask = (prompt: string) => ({ questions: [{ id: "report", type: "text", prompt }] });

const call = (name: string, input: unknown, id = name): ModelResponse => ({
  usage: new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
  output: [
    {
      type: "function_call",
      name,
      callId: id,
      arguments: JSON.stringify(
        intentTools.has(name) && typeof input === "object" && input !== null && !("intent" in input)
          ? { ...input, intent: `Synthetic ${name} purpose` }
          : input,
      ),
      status: "completed",
    },
  ],
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
  metadata: { name: "read_public", description: "Read public data" },
  coverage: "One actual example.",
};

const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);

it("asks in place, returns the answer to the model and continues to publication", async () => {
  const f = await fixture(
    (_request, index) =>
      [
        call("request_input", {
          questions: [
            {
              id: "report",
              type: "choice",
              prompt: "Which public report?",
              options: [
                { id: "annual", label: "Annual" },
                { id: "quarterly", label: "Quarterly" },
              ],
            },
          ],
        }),
        call("execute", execution),
        call("finish_build", publication),
      ][index] ?? prose(),
    {
      askInput: () => Effect.succeed({ report: { type: "choice", value: "quarterly" } }),
    },
  );
  expect(await f.run()).toMatchObject({ build: "published", publicationRef: "published_revision" });
  // The answer reached the model as the tool result, and the same attempt went on.
  const answered = JSON.stringify(f.requests[1]?.input);
  expect(answered).toContain('\\"status\\":\\"answered\\"');
  expect(answered).toContain('\\"report\\":\\"quarterly\\"');
  expect(f.counts()).toMatchObject({ executed: 1, published: 1 });
  const inputTool = f.requests[0]?.tools?.find((candidate) => candidate.name === "request_input");
  expect(JSON.stringify(inputTool)).not.toContain('"credential"');
});

// No answer is not an ending: the minter hears no_answer as the tool result and decides how to go
// on, here by publishing without it.
it("hands an unanswered question back as no_answer and the minter goes on to publish", async () => {
  const f = await fixture(
    (_request, index) =>
      [
        call("request_input", ask("Which public report?")),
        call("execute", execution),
        call("finish_build", publication),
      ][index] ?? prose(),
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({ build: "published", publicationRef: "published_revision" });
  expect(outcome).not.toHaveProperty("noResponse");
  expect(f.counts()).toEqual({ executed: 1, published: 1, asked: 1 });
  const handedBack = JSON.stringify(f.requests[1]?.input);
  expect(handedBack).toContain('\\"status\\":\\"no_answer\\"');
  expect(handedBack).toContain('\\"userInputRequired\\":false');
});

it("cancels a continued model request within the original invocation", async () => {
  const entered = Promise.withResolvers<void>();
  let aborted = false;
  const controller = new AbortController();
  const f = await fixture((request, index) =>
    index === 0
      ? prose()
      : new Promise((_resolve, reject) => {
          request.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
          entered.resolve();
        }),
  );
  const result = f.run(controller.signal).catch(() => undefined);
  await entered.promise;
  controller.abort();
  await result;
  expect(aborted).toBe(true);
  expect(f.requests).toHaveLength(2);
  expect(f.counts()).toEqual({ executed: 0, published: 0, asked: 0 });
});

/** How many of the host's own messages in a model request's input name `code`. */
const hostMessagesNaming = (request: ModelRequest, code: string) =>
  (Array.isArray(request.input) ? request.input : []).filter(
    (item) =>
      typeof item === "object" &&
      "role" in item &&
      item.role === "user" &&
      typeof item.content === "string" &&
      item.content.includes(code),
  ).length;

// After a sign-in that sent nothing failed, an agent may give final answers without a tool call
// until the repeated-final guard ends the attempt. The first such answer gets the way
// past the failed sign-in back, once, and the guard still ends a model that keeps answering.
it("hands the first final answer after a failed sign-in its way past, once, before the guard ends the attempt", async () => {
  const authentication = {
    phase: "login_poll" as const,
    code: "AuthenticationFailed" as const,
    providerAuthCode: "website_error" as const,
    providerReason:
      "Provider website_error: The login page returned an error; website said: 502 Bad Gateway nginx",
    nothingSubmitted: true as const,
  };
  const f = await fixture(
    (_request, index) =>
      index === 0
        ? call("execute", { ...execution, purpose: "authenticate", target: "liveBrowser" })
        : prose("An unchanged retry would fail the same way."),
    {
      reviewAndExecute: () => Effect.fail(new MintFailure({ code: "Unavailable", authentication })),
    },
  );
  expect(await f.run()).toMatchObject({ build: "incomplete" });
  // The execute, the answer that ended its segment, then three final answers in a row: the
  // guard still ends the attempt at the third.
  expect(f.requests).toHaveLength(5);
  // The host's own messages that carry the failed sign-in's root cause: only its guidance.
  expect(f.requests.map((request) => hostMessagesNaming(request, "website_error"))).toEqual([
    0, 0, 1, 1, 1,
  ]);
});

it("gives a final answer no sign-in guidance once the agent signs in again", async () => {
  const authentication = {
    phase: "login_poll" as const,
    code: "AuthenticationFailed" as const,
    providerAuthCode: "website_error" as const,
    nothingSubmitted: true as const,
  };
  let attempts = 0;
  const f = await fixture(
    (_request, index) =>
      index <= 1
        ? call(
            "execute",
            { ...execution, purpose: "authenticate", target: "liveBrowser" },
            `authenticate_${index}`,
          )
        : prose(),
    {
      reviewAndExecute: () =>
        attempts++ === 0
          ? Effect.fail(new MintFailure({ code: "Unavailable", authentication }))
          : Effect.succeed({
              executionId: "authenticated",
              status: "completed" as const,
              effect: "not_sent" as const,
              authentication: { state: "authenticated" as const, effect: "verified" as const },
              observations: "Signed in.",
            }),
    },
  );
  expect(await f.run()).toMatchObject({ build: "incomplete" });
  expect(f.requests.map((request) => hostMessagesNaming(request, "website_error"))).toEqual(
    f.requests.map(() => 0),
  );
});

// A sign-in fails after the login was sent, then its one relogin fails too. Told to authenticate
// again, a model would get a bare refusal, and only the repeated-final guard would end the attempt.
// A failure with no sign-in left ends the build at once as sign-in unavailable, with its cause.
it("ends the build as sign_in_unavailable once a failed sign-in leaves none, never through the repeated-final guard", async () => {
  const authentication = {
    phase: "login_poll" as const,
    code: "AuthenticationFailed" as const,
    providerAuthCode: "flow_failed" as const,
  };
  let signIns = 0;
  const f = await fixture(
    (_request, index) =>
      index <= 2
        ? call(
            "execute",
            { ...execution, purpose: "authenticate", target: "liveBrowser" },
            `authenticate_${index}`,
          )
        : prose("The site cannot be signed in."),
    {
      reviewAndExecute: () =>
        Effect.fail(
          new MintFailure({
            code: "Unavailable",
            authentication,
            ...(signIns++ === 0 ? {} : { spentSignIn: "relogin_spent" as const }),
          }),
        ),
    },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({
    build: "incomplete",
    recoveryReason: "sign_in_unavailable",
    stopReason: "sign_in_failed",
  });
  // The root cause's code stays in the diagnostics; the owner's summary is plain words.
  expect(outcome.summary).not.toContain("flow_failed");
  expect(outcome.diagnostics.join("\n")).toContain("flow_failed");
  // The two sign-ins, and the run ended with the second: no third call, no continuation prompt.
  expect(signIns).toBe(2);
  expect(f.requests).toHaveLength(2);
  expect(outcome.diagnostics.join("\n")).not.toContain("repeated_final_without_tool");
});

// The caller would not trust the origin the site's sign-in sent the login to. No later sign-in
// can count, so the build ends at once as sign-in unavailable, saying why.
it("ends the build at once as sign_in_unavailable when the caller does not trust the sign-in's origin", async () => {
  const f = await fixture(
    (_request, index) =>
      index === 0
        ? call("execute", { ...execution, purpose: "authenticate", target: "liveBrowser" })
        : prose("The site cannot be signed in."),
    {
      reviewAndExecute: () =>
        Effect.fail(
          new MintFailure({
            code: "Unavailable",
            authentication: {
              phase: "credential_submit",
              code: "CredentialTargetRefused",
              afterSubmission: true,
            },
            spentSignIn: "sign_in_origin_untrusted",
          }),
        ),
    },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({ build: "incomplete", recoveryReason: "sign_in_unavailable" });
  expect(outcome.summary).toBe(
    signInUnavailableSummary(
      { phase: "credential_submit", code: "CredentialTargetRefused", afterSubmission: true },
      "sign_in_origin_untrusted",
    ),
  );
  expect(outcome.summary).toContain(
    "the caller did not trust the origin the site's sign-in sent the login to",
  );
  expect(f.requests).toHaveLength(1);
});

// Every sign-in verified, but the site lost its signed-in session on a page load, and the host
// could not sign in again. The build ends as sign-in unavailable on that cause, not a failed
// sign-in's, and the agent hears to report it rather than authenticate again.
it("ends the build as sign_in_unavailable when the site keeps no signed-in session", async () => {
  let executions = 0;
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", execution),
        call("execute", { ...execution, purpose: "test", target: "liveBrowser" }, "test"),
      ][index] ?? prose("The site does not keep its session."),
    {
      // The example completes; the live test finds the session gone for good.
      reviewAndExecute: (_submitted, beforeDispatch = () => Effect.void) =>
        executions++ === 0
          ? beforeDispatch(readAllow).pipe(
              Effect.as({
                executionId: "execution_one",
                status: "completed" as const,
                effect: "verified" as const,
                resultRef: "protected_result",
                observations: { value: "public" },
              }),
            )
          : Effect.fail(new MintFailure({ code: "Unavailable", sessionLoss: "session_not_kept" })),
    },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({ build: "incomplete", recoveryReason: "sign_in_unavailable" });
  // The owner's summary names the lost session, not a failed sign-in or a spent relogin.
  for (const other of [
    signInUnavailableSummary(undefined, undefined),
    signInUnavailableSummary(undefined, "relogin_spent"),
  ])
    expect(outcome.summary).not.toBe(other);
  const answer = JSON.stringify(f.requests[2]?.input);
  expect(answer).toContain("report_sign_in_unavailable");
  expect(answer).toContain('\\"sessionLoss\\":\\"session_not_kept\\"');
  expect(outcome.diagnostics.join("\n")).toContain('"sessionLoss":"session_not_kept"');
  expect(f.requests).toHaveLength(3);
});

// A task impossible as asked (the site does not offer the form, or the owner's constraints cannot
// be met) must not end only through the repeated-final guard as an unexplained failure. The
// minter ends it blocked, with a typed reason, at once.
it("ends the build blocked with its reason and explanation when the minter reports it, never through the repeated-final guard", async () => {
  const explanation = "The site offers no online form for this request; it takes it by phone only.";
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", { ...execution, purpose: "explore" }),
        call("report_blocked", { reason: "site_lacks_capability", explanation }),
      ][index] ?? prose("The site does not offer this."),
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({
    build: "incomplete",
    blocked: { reason: "site_lacks_capability", explanation },
  });
  expect(outcome.hostFailure).toBeUndefined();
  // The blocked ending stopped the model: no continuation prompt followed it.
  expect(f.requests).toHaveLength(2);
  expect(f.counts()).toMatchObject({ published: 0 });
  expect(outcome.diagnostics.join("\n")).not.toContain("repeated_final_without_tool");
});

it("offers report_blocked on a build turn and never on the effect question turn", async () => {
  const question = await fixture(
    (_request, index) => (index === 0 ? call("request_input", effectQuestion()) : prose()),
    { askInput: () => Effect.succeed({ effect: { type: "choice", value: "read" } }) },
    { effect: "ask", siteOrigin: "https://reservations.example.com" },
  );
  await question.run();
  const build = await fixture(() => prose());
  await build.run();
  const offered = (requests: readonly ModelRequest[]) =>
    requests[0]?.tools?.map((tool) => tool.name) ?? [];
  expect(offered(question.requests)).not.toContain("report_blocked");
  expect(offered(build.requests)).toContain("report_blocked");
});

// Something the agent can still get past is not impossible as asked: the host refuses the blocked
// ending and says what to resolve first.
it("refuses report_blocked while a failed sign-in is unresolved", async () => {
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", { ...execution, purpose: "authenticate", target: "liveBrowser" }),
        call("report_blocked", { reason: "policy", explanation: "The site refused the login." }),
      ][index] ?? prose("Stopping."),
    {
      reviewAndExecute: () =>
        Effect.fail(
          new MintFailure({
            code: "Unavailable",
            authentication: {
              phase: "login_poll",
              code: "AuthenticationFailed",
              providerAuthCode: "flow_failed",
            },
          }),
        ),
    },
  );
  const outcome = await f.run();
  expect(outcome.blocked).toBeUndefined();
  expect(JSON.stringify(f.requests[2]?.input)).toContain("sign_in_unresolved");
});

it("refuses report_blocked while an unavailable review may still be resubmitted", async () => {
  let reviews = 0;
  const f = await fixture(
    (_request, index) =>
      [
        call("request_input", ask("Which report?")),
        call("report_blocked", { reason: "policy", explanation: "Review is not available." }),
      ][index] ?? prose("Stopping."),
    {
      reviewQuestion: () =>
        reviews++ === 0
          ? Effect.fail(
              new MintFailure({ code: "ReviewUnavailable", reviewFailure: "Unavailable" }),
            )
          : Effect.succeed({ outcome: "allow_business" as const, rationale: "Allowed." }),
    },
  );
  const outcome = await f.run();
  expect(outcome.blocked).toBeUndefined();
  expect(JSON.stringify(f.requests[2]?.input)).toContain("review_unavailable_pending");
});

// A policy block needs a refusal on record: a Guardian deny or escalation, or the owner's no. The
// minter's own reading of its instructions is none, so the host refuses the ending and the same
// attempt goes on to publish.
it("refuses a policy block nothing in the attempt refused and keeps building", async () => {
  const f = await fixture(
    (_request, index) =>
      [
        call("report_blocked", {
          reason: "policy",
          explanation: "The rules do not let this tool open the page the caller named.",
        }),
        call("execute", execution),
        call("finish_build", publication),
      ][index] ?? prose(),
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({ build: "published", publicationRef: "published_revision" });
  expect(outcome.blocked).toBeUndefined();
  expect(JSON.stringify(f.requests[1]?.input)).toContain("policy_not_refused");
  expect(f.counts()).toMatchObject({ executed: 1, published: 1 });
});

// A host may name a policy ending of its own, such as a repair's verdict that the caller's input
// caused the failure: the ending it allows needs no refusal on record, and any other still does.
it("ends a policy block the host allows without a refusal on record, and only that one", async () => {
  const allowed = "Caller verdict: the date is before the departure.";
  const f = await fixture(
    (_request, index) =>
      [
        call("report_blocked", { reason: "policy", explanation: "Another reason." }, "other"),
        call("report_blocked", { reason: "policy", explanation: allowed }, "allowed"),
      ][index] ?? prose("Stopping."),
    { policyBlockAllowed: (explanation) => explanation.startsWith("Caller verdict:") },
  );
  expect(await f.run()).toMatchObject({
    build: "incomplete",
    blocked: { reason: "policy", explanation: allowed },
  });
  expect(JSON.stringify(f.requests[1]?.input)).toContain("policy_not_refused");
});

it("ends a policy block once Guardian denied an execution in the attempt", async () => {
  const explanation = "Guardian refused the only way to reach the requested page.";
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", execution),
        call("report_blocked", { reason: "policy", explanation }),
      ][index] ?? prose("Stopping."),
    {
      preflight: () =>
        Effect.fail(
          new MintFailure({
            code: "ReviewDenied",
            review: { outcome: "deny", reviewId: "review_denied", rationale: "Not allowed." },
          }),
        ),
    },
  );
  expect(await f.run()).toMatchObject({
    build: "incomplete",
    blocked: { reason: "policy", explanation },
  });
});

/** A publication review that denies with `review`, then publishes the next submission. */
const denyPublicationOnce = (review: NonNullable<MintFailure["review"]>) => {
  let publications = 0;
  return {
    publications: () => publications,
    publish: () =>
      Effect.suspend(() =>
        ++publications === 1
          ? Effect.fail(new MintFailure({ code: "ReviewDenied", review }))
          : Effect.succeed({ publicationRef: "corrected_revision", diagnostics: [] }),
      ),
  };
};

const finding = (
  category: "example_value" | "exfiltration" | "customer_data" | "schema_mismatch",
) => ({
  path: "src/tool.ts",
  byteStart: 0,
  byteEnd: 6,
  category,
  explanation: "Synthetic finding explanation.",
});

/** The model's patch of one workspace file. */
const patch = (
  operation:
    | { readonly type: "update_file"; readonly path: string; readonly diff: string }
    | { readonly type: "create_file"; readonly path: string; readonly diff: string },
  callId: string,
): ModelResponse => ({
  usage: new Usage(),
  output: [{ type: "apply_patch_call" as const, callId, status: "completed" as const, operation }],
});

// A publication denial or escalation that asks for a correction is feedback, not a refusal: the
// minter that reports a policy block after one hears policy_not_refused, fixes it and publishes.
// An escalation for missing evidence is one: the minter gathers what the rationale names.
it.each([
  {
    outcome: "deny" as const,
    reason: "source_correction" as const,
    findings: [finding("example_value")],
  },
  { outcome: "deny" as const, reason: "unsupported_claim" as const, findings: [] },
  { outcome: "deny" as const, reason: "evidence" as const, findings: [] },
  { outcome: "escalate" as const, reason: "evidence" as const, findings: [] },
  { outcome: "escalate" as const, reason: "source_correction" as const, findings: [] },
])(
  "refuses a policy block after a correctable publication refusal ($outcome, $reason) and publishes the correction",
  async ({ outcome: decision, reason, findings }) => {
    const missing = "No passing case tests the list's second page.";
    const review = denyPublicationOnce({
      outcome: decision,
      reason,
      reviewId: "review_correctable",
      rationale: `The claim needs evidence or a correction. ${missing}`,
      findings,
    });
    const f = await fixture(
      (_request, index) =>
        [
          call("execute", execution),
          call("finish_build", publication, "denied_publication"),
          call("report_blocked", {
            reason: "policy",
            explanation: "Guardian refused to publish this tool.",
          }),
          patch(
            {
              type: "update_file",
              path: "src/tool.ts",
              diff: "@@\n-export default {};\n+export default { corrected: true };",
            },
            "correction",
          ),
          call("finish_build", publication, "corrected_publication"),
        ][index] ?? prose(),
      { publish: review.publish },
    );
    const outcome = await f.run();
    expect(outcome).toMatchObject({ build: "published", publicationRef: "corrected_revision" });
    expect(outcome.blocked).toBeUndefined();
    // The minter reads what the review found missing before it reports the block.
    expect(JSON.stringify(f.requests[2]?.input)).toContain(missing);
    expect(JSON.stringify(f.requests[3]?.input)).toContain("policy_not_refused");
    expect(review.publications()).toBe(2);
  },
);

// Only a refusal no correction within the minter's authority gets past ends the build blocked.
it.each([
  { outcome: "deny" as const, reason: "privacy" as const, findings: [finding("customer_data")] },
  { outcome: "deny" as const, reason: "authority" as const, findings: [] },
  {
    outcome: "deny" as const,
    reason: "source_correction" as const,
    findings: [finding("exfiltration")],
  },
  { outcome: "escalate" as const, reason: "privacy" as const, findings: [] },
  { outcome: "escalate" as const, reason: "authority" as const, findings: [] },
  {
    outcome: "escalate" as const,
    reason: "evidence" as const,
    findings: [finding("customer_data")],
  },
])(
  "ends a policy block after an unfixable publication refusal ($outcome, $reason)",
  async ({ outcome, reason, findings }) => {
    const explanation = "Guardian refused what this tool needs to publish.";
    const review = denyPublicationOnce({
      outcome,
      reason,
      reviewId: "review_unfixable",
      rationale: "Synthetic refusal.",
      findings,
    });
    const f = await fixture(
      (_request, index) =>
        [
          call("execute", execution),
          call("finish_build", publication),
          call("report_blocked", { reason: "policy", explanation }),
        ][index] ?? prose("Stopping."),
      { publish: review.publish },
    );
    expect(await f.run()).toMatchObject({
      build: "incomplete",
      blocked: { reason: "policy", explanation },
    });
    expect(review.publications()).toBe(1);
  },
);

// A finding only the host can fix is the host's defect, never the minter's policy block: the host
// ends the build as its own failure at once, instead of prompting the minter to go on.
it("ends the build as the host's failure after a publication denial for a host-owned file", async () => {
  const review = denyPublicationOnce({
    outcome: "deny",
    reason: "host_owned",
    reviewId: "review_host_owned",
    rationale: "Synthetic defect in a file the host wrote.",
    findings: [{ ...finding("schema_mismatch"), path: "operation/publication/routes.json" }],
  });
  const f = await fixture(
    (_request, index) =>
      [call("execute", execution), call("finish_build", publication)][index] ??
      prose("Stopping."),
    { publish: review.publish },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({
    build: "incomplete",
    hostFailure: "publication_unavailable",
    publicationDenial: { reason: "host_owned" },
  });
  expect(outcome.blocked).toBeUndefined();
  expect(review.publications()).toBe(1);
  // No continuation prompt follows the denial.
  expect(f.requests.length).toBeLessThanOrEqual(3);
});

// The review names another reason for a denial whose every finding is in a bundle file the host
// wrote, here its sign-in recipe. The host decodes it as host_owned, so the build ends as the
// host's failure at once and the minter never gets to end it as its own policy block.
it("ends the build as the host's failure when a review denies only a bundle file the host wrote", async () => {
  const bundle = new Map([
    ["src/tool.ts", "export default {};"],
    [
      "auth-fill.json",
      JSON.stringify({ version: 1, steps: [{ page: "https://portal.example/team/sample/login" }] }),
    ],
  ]);
  const sources = new Map<string, string>(
    [...bundle].map(([path, text]) => [`operation/${path}`, text]),
  );
  const reviewed: PendingExecution = {
    invocationId: "invocation_host_file",
    attemptId: "attempt_host_file",
    entrypoint: "operation/src/tool.ts",
    screenedIntent: "Read public reports",
    screenedInput: "{}",
    screenedObservations: "Prior example completed.",
    accountScope: "account_a",
    allowedOrigins: [],
    allowedEffects: ["Publish current package only"],
    publication: publicationScope(bundle, new Map(), { hostWritten: new Set(["auth-fill.json"]) }),
  };
  const guardian = makeGuardian({
    run: () =>
      Effect.succeed({
        outcome: "deny",
        reason: "source_correction",
        rationale: "The sign-in recipe's path names a team.",
        findings: [
          {
            path: "operation/auth-fill.json",
            quote: "team/sample",
            category: "private_literal",
            explanation: "The recorded page names a team.",
          },
        ],
      }),
  });
  const readSource = makeSourceInspector(
    (path) =>
      Effect.suspend(() => {
        const text = sources.get(path);
        return text === undefined
          ? Effect.fail(new ReviewFailure({ code: "SourceUnavailable" }))
          : Effect.succeed(new TextEncoder().encode(text));
      }),
    (_path, bytes) => Effect.succeed(new TextDecoder().decode(bytes)),
  );
  let publications = 0;
  // Publishes as a host does: Guardian reviews the bundle, and a refusal is the build's denial.
  const publish = () =>
    Effect.gen(function* () {
      publications++;
      const { reviewId, decision } = yield* guardian
        .review(reviewed, readSource)
        .pipe(Effect.mapError(() => new MintFailure({ code: "PublicationUnavailable" })));
      if (decision.outcome === "allow")
        return { publicationRef: "published_revision", diagnostics: [] };
      return yield* reviewDenied(reviewId, { ...decision, outcome: decision.outcome });
    });
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", execution),
        call("finish_build", publication),
        call("report_blocked", {
          reason: "policy",
          explanation: "Guardian refused to publish this tool.",
        }),
      ][index] ?? prose("Stopping."),
    { publish },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({
    build: "incomplete",
    hostFailure: "publication_unavailable",
    publicationDenial: { reason: "host_owned" },
  });
  expect(outcome.blocked).toBeUndefined();
  expect(publications).toBe(1);
  // No continuation prompt follows the denial.
  expect(f.requests.length).toBeLessThanOrEqual(3);
});

// Guardian denies the same submission again, so the host refuses it before review; a fix is
// reviewed as usual and publishes.
it("refuses a finish_build that changed nothing since its denial without reviewing it again", async () => {
  const review = denyPublicationOnce({
    outcome: "deny",
    reason: "source_correction",
    reviewId: "review_unchanged",
    rationale: "Synthetic correction.",
    findings: [finding("example_value")],
  });
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", execution),
        call("finish_build", publication, "denied"),
        call("finish_build", publication, "unchanged"),
        patch(
          {
            type: "update_file",
            path: "src/tool.ts",
            diff: "@@\n-export default {};\n+export default { corrected: true };",
          },
          "fix",
        ),
        call("finish_build", publication, "corrected"),
      ][index] ?? prose(),
    { publish: review.publish },
  );
  const outcome = await f.run();
  expect(toolResult(f.requests[3], "unchanged")).toMatchObject({
    status: "not_published",
    reason: "unchanged_since_denial",
  });
  expect(outcome).toMatchObject({ build: "published", publicationRef: "corrected_revision" });
  expect(review.publications()).toBe(2);
});

// What changed may lie outside the entrypoint's imports, as a flagged file does, or outside the
// workspace, as finish_build's own metadata does: either is reviewed again.
it.each([
  {
    change: "a flagged file the entrypoint does not import",
    findingPath: "operation/src/notes.ts",
    steps: [
      patch({ type: "create_file", path: "src/notes.ts", diff: "+export const notes = 1;" }, "fix"),
      call("finish_build", publication, "changed"),
    ],
  },
  {
    change: "the description alone",
    findingPath: "operation/src/tool.ts",
    steps: [
      call(
        "finish_build",
        { ...publication, metadata: { ...publication.metadata, description: "Read public data." } },
        "changed",
      ),
    ],
  },
])("reviews a finish_build after a denial when $change changed", async ({ findingPath, steps }) => {
  const review = denyPublicationOnce({
    outcome: "deny",
    reason: "source_correction",
    reviewId: "review_changed",
    rationale: "Synthetic correction.",
    findings: [{ ...finding("example_value"), path: findingPath }],
  });
  const f = await fixture(
    (_request, index) =>
      [call("execute", execution), call("finish_build", publication, "denied"), ...steps][index] ??
      prose(),
    { publish: review.publish },
  );
  expect(await f.run()).toMatchObject({ build: "published", publicationRef: "corrected_revision" });
  expect(review.publications()).toBe(2);
});

// The owner's no is their decision, not a safety refusal: a policy report that stands only on it
// ends as owner_declined, so the caller is never told a safety rule stopped the build.
it("ends a policy report that stands on the owner's no as owner_declined", async () => {
  const explanation = "The owner declined the only way to finish this task.";
  const f = await fixture(
    (_request, index) =>
      [
        call("request_input", {
          questions: [{ id: "proceed", type: "confirm", prompt: "May the tool do this?" }],
        }),
        call("report_blocked", { reason: "policy", explanation }),
      ][index] ?? prose("Stopping."),
    {
      askInput: () => Effect.succeed({ proceed: { type: "confirm", value: { confirmed: false } } }),
    },
  );
  expect(await f.run()).toMatchObject({
    build: "incomplete",
    blocked: { reason: "owner_declined", explanation },
    stopReason: "owner_declined",
  });
});

// No answer is no consent, so a write build whose confirmation went unanswered may stop safely
// instead of being steered on past what it asked, and nothing runs on the site. It ends as
// question_unanswered, never as a policy block.
it("ends a write build as question_unanswered once its confirmation went unanswered, running nothing", async () => {
  const explanation = "The owner did not confirm submitting the form, so this build stops.";
  const f = await fixture(
    (_request, index) =>
      [
        call("report_blocked", { reason: "policy", explanation }, "before"),
        call("request_input", {
          questions: [{ id: "proceed", type: "confirm", prompt: "May this build submit the form?" }],
        }),
        call("report_blocked", { reason: "policy", explanation }, "after"),
      ][index] ?? prose("Stopping."),
    {},
    { effect: "write" },
  );
  expect(await f.run()).toMatchObject({
    build: "incomplete",
    blocked: { reason: "question_unanswered", explanation },
    stopReason: "question_unanswered",
  });
  // Before the question went unanswered nothing refused this, so the first report was refused.
  expect(JSON.stringify(f.requests[1]?.input)).toContain("policy_not_refused");
  expect(f.counts()).toEqual({ executed: 0, published: 0, asked: 1 });
});

// A report Guardian could not review within the review outage budget reaches the caller only as
// its reason.
it("records a blocked ending without its explanation when the review stays unavailable", async () => {
  const f = await fixture(
    (_request, index) =>
      index === 0
        ? call("report_blocked", {
            reason: "site_lacks_capability",
            explanation: "Call 555-0100 to finish this.",
          })
        : prose(),
    {
      reviewOutageBudgetMs: 0,
      reviewQuestion: () =>
        Effect.fail(new MintFailure({ code: "ReviewUnavailable", reviewFailure: "Unavailable" })),
    },
  );
  const outcome = await f.run();
  expect(outcome.blocked).toEqual({ reason: "site_lacks_capability" });
  // The unreviewed explanation reaches no caller through the summary either.
  expect(outcome.summary).not.toContain("555-0100");
  expect(outcome.stopReason).toBe("site_lacks_capability");
  expect(f.requests).toHaveLength(1);
});

// An unavailable review of a blocked explanation is retried like any other review, so the caller
// still reads the explanation once Guardian allows it.
it("shows a blocked explanation whose review was unavailable once, then allowed", async () => {
  const explanation = "The site offers no online form for this request.";
  let reviews = 0;
  const f = await fixture(
    (_request, index) =>
      [
        call("report_blocked", { reason: "site_lacks_capability", explanation }, "first"),
        call("report_blocked", { reason: "site_lacks_capability", explanation }, "again"),
      ][index] ?? prose(),
    {
      reviewQuestion: () =>
        reviews++ === 0
          ? Effect.fail(new MintFailure({ code: "ReviewUnavailable", reviewFailure: "Unavailable" }))
          : Effect.succeed({ outcome: "allow_business" as const, rationale: "Plain." }),
    },
  );
  const outcome = await f.run();
  expect(toolResult(f.requests[1], "first")).toMatchObject({
    status: "review_unavailable",
    retryable: true,
  });
  expect(outcome.blocked).toEqual({ reason: "site_lacks_capability", explanation });
  expect(reviews).toBe(2);
  expect(f.requests).toHaveLength(2);
});

/** The parsed result of the tool call `callId`, as the model read it in `request`. */
const toolResult = (request: ModelRequest | undefined, callId: string): unknown => {
  const input = request?.input;
  if (!Array.isArray(input)) throw new Error("Missing continued history");
  const item = input.find(
    (entry) => entry.type === "function_call_result" && entry.callId === callId,
  );
  const output = item !== undefined && "output" in item ? item.output : undefined;
  const text =
    typeof output === "string"
      ? output
      : typeof output === "object" && output !== null && "text" in output
        ? output.text
        : undefined;
  if (typeof text !== "string") throw new Error(`Missing result of ${callId}`);
  return JSON.parse(text);
};

// Guardian asking for a reword never ends the build: the minter reads the rationale and revises
// its explanation, and only the allowed revision ends the build blocked.
it("returns a reworded blocked explanation to the minter, which revises it and ends blocked once allowed", async () => {
  const first = "Call 555-0100 to finish this.";
  const revised = "The site offers no online form for this request.";
  const rationale = "It passes on a phone number from the website.";
  const reviewed: string[] = [];
  const f = await fixture(
    (_request, index) =>
      [
        call("report_blocked", { reason: "site_lacks_capability", explanation: first }, "first"),
        call("report_blocked", { reason: "site_lacks_capability", explanation: revised }, "revised"),
      ][index] ?? prose(),
    {
      reviewQuestion: (request) =>
        Effect.sync(() => {
          reviewed.push(request.questions[0]?.prompt ?? "");
          return reviewed.length === 1
            ? { outcome: "reword" as const, rationale }
            : { outcome: "allow_business" as const, rationale: "Plain and consistent." };
        }),
    },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({
    build: "incomplete",
    blocked: { reason: "site_lacks_capability", explanation: revised },
  });
  expect(reviewed).toEqual([first, revised]);
  // The first report came back to the minter with Guardian's rationale, and nothing ended.
  expect(toolResult(f.requests[1], "first")).toMatchObject({ rationale });
  expect(f.requests).toHaveLength(2);
});

// Guardian judges a blocked report or a question about the inputs against the host's own record of
// the refusal, not only the minter's account of it.
it("shows the question and blocked-explanation reviews the host's publication refusal", async () => {
  const decisions = memoryPublicationDecisions();
  const reviewed: (readonly PublicationDecision[] | undefined)[] = [];
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", execution),
        call("finish_build", publication, "finish"),
        call("request_input", ask("The site needs another date. Which date should it use?")),
        call("report_blocked", {
          reason: "site_lacks_capability",
          explanation: "The site never took the request with the dates it offers.",
        }),
      ][index] ?? prose(),
    {
      publicationDecisions: decisions,
      publish: () =>
        Effect.fail(
          new MintFailure({ code: "PublicationUnavailable", reason: "write_not_submitted" }),
        ),
      askInput: () => Effect.succeed({ report: { type: "text", value: "Any date." } }),
      reviewQuestion: (_request, options) =>
        Effect.sync(() => {
          reviewed.push(options?.publicationDecisions);
          return { outcome: "allow_business" as const, rationale: "Consistent." };
        }),
    },
  );
  const outcome = await f.run();
  expect(outcome.blocked).toMatchObject({ reason: "site_lacks_capability" });
  const held = await Effect.runPromise(decisions.list);
  expect(held).toEqual([
    expect.objectContaining({
      outcome: "refused",
      code: "PublicationUnavailable",
      reason: "write_not_submitted",
      executionId: "execution_one",
      failedChecks: ["write_not_submitted"],
      recovery: "write_completion",
    }),
  ]);
  // Both reviews read that record, and the minter's refusal names the same decision.
  expect(reviewed).toEqual([held, held]);
  expect(toolResult(f.requests[2], "finish")).toMatchObject({
    status: "not_published",
    reason: "write_not_submitted",
    decisionId: held[0]?.decisionId,
  });
});

// The raw trace of each model call stays fail closed: one the host cannot keep stops the attempt
// before the next model call, whatever the readable copies do.
it("stops before the next model call when its raw trace cannot be kept", async () => {
  const sent: ModelRequest[] = [];
  let records = 0;
  let durability: { error: unknown; sequence: number; phase: string } | undefined;
  const runId = randomUUID();
  const observerFactory: ModelObserverFactory = (_persist, _signal, options) => ({
    attach: () => undefined,
    tool: (_call, invoke) => invoke(),
    // Write-ahead: each model call's raw record lands before the call is sent.
    provider: (provider) => ({
      getModel: async (name) => {
        const model = await provider.getModel(name);
        return {
          ...model,
          getResponse: async (request) => {
            const sequence = records++;
            try {
              await options?.record?.({
                identity: {
                  recordId: randomUUID(),
                  source: "mint.model",
                  runId,
                  sequence,
                  phase: "model_requested",
                  occurredAtUtc: new Date().toISOString(),
                  call: sequence,
                },
                payload: { input: "raw" },
              });
            } catch (error) {
              durability ??= { error, sequence, phase: "model_requested" };
              throw error;
            }
            return model.getResponse(request);
          },
        };
      },
    }),
    started: () => undefined,
    skillsInstalled: () => undefined,
    segment: () => undefined,
    completed: () => undefined,
    failed: () => undefined,
    takeNativeCall: () => undefined,
    durabilityFailure: () => durability,
    terminal: () => ({
      phase: "terminal",
      timing: {
        phase: "terminal",
        sequence: records,
        occurredAtUtc: new Date().toISOString(),
        occurredMonotonicMs: performance.now(),
        queueMs: 0,
      },
      value: {},
    }),
    flush: async () => undefined,
  });
  const f = await fixture(() => prose(), {
    model: makeOpenAIMinter(
      {
        getModel: () => ({
          getResponse: async (request) => {
            sent.push(request);
            return sent.length === 1 ? call("execute", { ...execution, purpose: "explore" }) : prose();
          },
          getStreamedResponse: () => {
            throw new Error("Unused stream");
          },
        }),
      },
      "medium",
      {},
      { observerFactory },
    ),
    diagnostics: {
      emit: () => Effect.void,
      retainModelTranscript: () => Effect.void,
      retainScreenedSource: () => Effect.void,
      // The second model call's raw record cannot be stored.
      retainRuntimeRecord: () =>
        Effect.suspend(() =>
          records > 1
            ? Effect.fail(
                new EventUnavailable({
                  event: "diagnostic_storage_failed",
                  diagnosticStorageFailure: "transport",
                }),
              )
            : Effect.void,
        ),
    },
  });
  const outcome = await f.run();
  expect(outcome).toMatchObject({ build: "incomplete", hostFailure: "diagnostic_retention" });
  // The first call's tool ran; the second call was never sent.
  expect(f.counts().executed).toBe(1);
  expect(sent).toHaveLength(1);
});

it("keeps a recoverable final answer on the continuation path, unblocked, through to publication", async () => {
  const f = await fixture(
    (_request, index) =>
      [
        prose("The report may not be on this site."),
        call("execute", execution),
        call("finish_build", publication),
      ][index] ?? prose(),
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({ build: "published", publicationRef: "published_revision" });
  expect(outcome.blocked).toBeUndefined();
  expect(f.requests).toHaveLength(3);
});

// A build whose example already completed keeps it: once sign-in is unavailable, the outcome waits
// while the retained receipt may still publish, and a publication stands.
it("still publishes a retained receipt after sign-in becomes unavailable", async () => {
  const authentication = {
    phase: "login_poll" as const,
    code: "AuthenticationFailed" as const,
    providerAuthCode: "flow_failed" as const,
  };
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", execution),
        call(
          "execute",
          { ...execution, purpose: "authenticate", target: "liveBrowser" },
          "authenticate",
        ),
        call("finish_build", publication),
      ][index] ?? prose(),
    {
      reviewAndExecute: (submitted, beforeDispatch = () => Effect.void) =>
        submitted.purpose === "authenticate"
          ? Effect.fail(
              new MintFailure({
                code: "Unavailable",
                authentication,
                spentSignIn: "relogin_spent",
              }),
            )
          : beforeDispatch(readAllow).pipe(
              Effect.as({
                executionId: "execution_one",
                status: "completed" as const,
                effect: "verified" as const,
                resultRef: "protected_result",
                observations: { value: "public" },
              }),
            ),
    },
  );
  const result = await f.run();
  expect(result).toMatchObject({ build: "published", publicationRef: "published_revision" });
  expect(result).not.toHaveProperty("recoveryReason");
  // The model heard sign-in was unavailable, and its run went on to publish.
  expect(f.requests).toHaveLength(3);
  expect(JSON.stringify(f.requests[2]?.input)).toContain("report_sign_in_unavailable");
});

// A build holding a retained receipt waited for the repeated-final guard when the
// model declined to publish after sign-in became unavailable, three continuation prompts later.
// Its first final answer without a tool call ends the build with the sign-in outcome instead.
it("ends a build holding a retained receipt as sign_in_unavailable at the first final answer", async () => {
  const authentication = {
    phase: "login_poll" as const,
    code: "AuthenticationFailed" as const,
    providerAuthCode: "flow_failed" as const,
  };
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", execution),
        call(
          "execute",
          { ...execution, purpose: "authenticate", target: "liveBrowser" },
          "authenticate",
        ),
      ][index] ?? prose("I will not publish; the site cannot be signed in."),
    {
      reviewAndExecute: (submitted, beforeDispatch = () => Effect.void) =>
        submitted.purpose === "authenticate"
          ? Effect.fail(
              new MintFailure({
                code: "Unavailable",
                authentication,
                spentSignIn: "relogin_spent",
              }),
            )
          : beforeDispatch(readAllow).pipe(
              Effect.as({
                executionId: "execution_one",
                status: "completed" as const,
                effect: "verified" as const,
                resultRef: "protected_result",
                observations: { value: "public" },
              }),
            ),
    },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({
    build: "incomplete",
    recoveryReason: "sign_in_unavailable",
    stopReason: "sign_in_failed",
  });
  // The root cause's code stays in the diagnostics; the owner's summary is plain words.
  expect(outcome.summary).not.toContain("flow_failed");
  expect(outcome.diagnostics.join("\n")).toContain("flow_failed");
  // The example, the sign-in, the final answer: no continuation prompt followed it.
  expect(f.requests).toHaveLength(3);
  expect(outcome.diagnostics.join("\n")).not.toContain("repeated_final_without_tool");
});

// A login identity conflict at sign-in ends the build with the conflict's own status.
it("ends a build whose sign-in hits a login identity conflict as login_identity_conflict", async () => {
  const f = await fixture(
    (_request, index) =>
      index === 0
        ? call("execute", { ...execution, purpose: "authenticate", target: "liveBrowser" })
        : prose(),
    {
      reviewAndExecute: () =>
        Effect.fail(
          new MintFailure({
            code: "Unavailable",
            authentication: {
              phase: "credential_resolve",
              code: "LoginIdentityConflict",
              nothingSubmitted: true,
            },
          }),
        ),
    },
  );
  expect(await f.run()).toMatchObject({
    build: "incomplete",
    recoveryReason: "login_identity_conflict",
  });
  expect(f.requests).toHaveLength(1);
});

// A sign-in whose cleanup the host could not confirm ends live work on its own
// terms, so it never says sign-in is unavailable, even beside a retained receipt.
it("gives no sign-in-unavailable ending to a sign-in whose cleanup is unconfirmed", async () => {
  const authentication = {
    phase: "login_poll" as const,
    code: "ProviderUncertain" as const,
    cleanupCode: "StopUnconfirmed" as const,
  };
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", execution),
        call(
          "execute",
          { ...execution, purpose: "authenticate", target: "liveBrowser" },
          "authenticate",
        ),
      ][index] ?? prose(),
    {
      reviewAndExecute: (submitted, beforeDispatch = () => Effect.void) =>
        submitted.purpose === "authenticate"
          ? Effect.fail(new MintFailure({ code: "Unavailable", authentication }))
          : beforeDispatch(readAllow).pipe(
              Effect.as({
                executionId: "execution_one",
                status: "completed" as const,
                effect: "verified" as const,
                resultRef: "protected_result",
                observations: { value: "public" },
              }),
            ),
    },
  );
  const outcome = await f.run();
  expect(outcome).not.toHaveProperty("recoveryReason");
  expect(JSON.stringify(f.requests[2]?.input)).not.toContain("buildOutcome");
});

/**
 * An example receipt, then a sign-in that fails with none left, then the rest of the model's turns;
 * the host's own outcomes after the model stops keep their order.
 */
const receiptThenSpentSignIn = (
  later: readonly ModelResponse[],
  overrides: Partial<MintDependencies> = {},
  onRequest: (index: number) => void = () => undefined,
) =>
  fixture(
    (_request, index) => {
      onRequest(index);
      return (
        [
          call("execute", execution),
          call(
            "execute",
            { ...execution, purpose: "authenticate", target: "liveBrowser" },
            "authenticate",
          ),
          ...later,
        ][index] ?? prose()
      );
    },
    {
      reviewAndExecute: (submitted, beforeDispatch = () => Effect.void) =>
        submitted.purpose === "authenticate"
          ? Effect.fail(
              new MintFailure({
                code: "Unavailable",
                authentication: {
                  phase: "login_poll",
                  code: "AuthenticationFailed",
                  providerAuthCode: "flow_failed",
                },
                spentSignIn: "relogin_spent",
              }),
            )
          : beforeDispatch(readAllow).pipe(
              Effect.as({
                executionId: "execution_one",
                status: "completed" as const,
                effect: "verified" as const,
                resultRef: "protected_result",
                observations: { value: "public" },
              }),
            ),
      ...overrides,
    },
  );

// Ending at the first final answer must not skip what the host settles after the
// model stops. A minter that left Guardian's input feedback unresolved still gets its last
// reviewed candidate published, privately and flagged.
it("still publishes the flagged input-feedback fallback when sign-in is unavailable", async () => {
  let fallbackPublications = 0;
  const f = await receiptThenSpentSignIn([call("finish_build", publication), prose()], {
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
  });
  expect(await f.run()).toMatchObject({
    build: "published",
    publicationRef: "fallback-revision",
  });
  expect(fallbackPublications).toBe(1);
  // The final answer after the feedback ended the model: no continuation prompt followed.
  expect(f.requests).toHaveLength(4);
});

// A host that becomes unavailable after the last tool call still ends with its own cause.
it("ends with the host's own cause when the host fails after sign-in became unavailable", async () => {
  let hostDown = false;
  const f = await receiptThenSpentSignIn(
    [prose()],
    { executionAvailability: () => (hostDown ? "host_unavailable" : "open") },
    (index) => {
      if (index === 2) hostDown = true;
    },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({ build: "incomplete", hostFailure: "host_unavailable" });
  expect(outcome).not.toHaveProperty("recoveryReason");
});

it("preserves finite reconciliation errors through the actual SDK tool boundary", async () => {
  const f = await fixture((_request, index) =>
    index === 0
      ? call("execute", { ...execution, purpose: "residual" })
      : call("report_blocked", {
          reason: "site_lacks_capability",
          explanation: "The synthetic site offers nothing to read.",
        }),
  );
  expect(await f.run()).toMatchObject({
    build: "incomplete",
    blocked: { reason: "site_lacks_capability" },
  });
  expect(JSON.stringify(f.requests[1]?.input)).toContain("ReconciliationRequired");
  expect(JSON.stringify(f.requests[1]?.input)).toContain("intent_input");
  expect(f.counts().executed).toBe(0);
});

// a read's live test may run an input the agent picks, as JSON text.
it("carries a live test's agent-chosen input through the actual SDK tool boundary", async () => {
  const received: unknown[] = [];
  const liveTest = { ...execution, purpose: "test", target: "liveBrowser" };
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", { ...liveTest, testInput: '{"amountMinor":12}' }, "agent_input"),
        call("execute", liveTest, "caller_input"),
      ][index] ?? prose(),
    {
      reviewAndExecute: (input, beforeDispatch = () => Effect.void) =>
        beforeDispatch(readAllow).pipe(
          Effect.zipRight(
            Effect.sync(() => ({
              executionId: `execution_${received.push(input)}`,
              status: "completed" as const,
              effect: "verified" as const,
              observations: { value: "public" },
            })),
          ),
        ),
    },
  );
  await f.run();
  expect(received).toEqual([
    expect.objectContaining({ purpose: "test", testInput: '{"amountMinor":12}' }),
    expect.objectContaining({ purpose: "test" }),
  ]);
  expect(received[1]).not.toHaveProperty("testInput");
});

it("keeps installed skills readable and protected from editing after prose continuation", async () => {
  const read = { path: ".agents/core/SKILL.md", offset: null, limit: null };
  const f = await fixture(
    (_request, index) =>
      [
        prose(),
        call("read_source", read, "read_skill_before"),
        {
          usage: new Usage(),
          output: [
            {
              type: "apply_patch_call" as const,
              callId: "edit_skill",
              status: "completed" as const,
              operation: {
                type: "update_file" as const,
                path: ".agents/core/SKILL.md",
                diff: "@@\n-Publish through finish_build or request legitimate missing input.\n+UNAUTHORIZED replacement",
              },
            },
          ],
        },
        call("read_source", read, "read_skill_after"),
        call("execute", execution),
        call("finish_build", publication),
      ][index] ?? prose(),
  );
  const result = await f.run();
  expect(result.diagnostics).toEqual([]);
  expect(result).toMatchObject({ build: "published", publicationRef: "published_revision" });
  expect(f.requests).toHaveLength(6);
  const input = f.requests[4]?.input;
  if (!Array.isArray(input)) throw new Error("Missing continued history");
  expect(
    input.find((item) => item.type === "apply_patch_call_output" && item.callId === "edit_skill"),
  ).toMatchObject({ status: "failed" });
  const reads = input.filter(
    (item) =>
      item.type === "function_call_result" &&
      ["read_skill_before", "read_skill_after"].includes(item.callId),
  );
  expect(reads).toHaveLength(2);
  const [before, after] = reads.map((read) => ("output" in read ? read.output : undefined));
  expect(before).toBeDefined();
  expect(after).toEqual(before);
  expect(JSON.stringify(after)).not.toContain("UNAUTHORIZED replacement");
});

it.each([false, true])(
  "honors only the host repeatableRead receipt across continuation (enabled=%s)",
  async (repeatableRead) => {
    let executions = 0;
    const chosenId = repeatableRead ? "execution_two" : "execution_one";
    const f = await fixture(
      (_request, index) =>
        [
          call("execute", execution, "first_read"),
          prose("Continue the source repair using the host receipt."),
          call("execute", execution, "second_read"),
          call("finish_build", { ...publication, executionId: chosenId }),
        ][index] ?? prose(),
      {
        repeatableRead,
        reviewAndExecute: (_input, beforeDispatch = () => Effect.void) =>
          beforeDispatch(readAllow).pipe(
            Effect.zipRight(
              Effect.sync(() => {
                executions++;
                return {
                  executionId: executions === 1 ? "execution_one" : "execution_two",
                  status: "completed" as const,
                  effect: "verified" as const,
                  resultRef: `protected_${executions}`,
                  observations: { value: "public" },
                };
              }),
            ),
          ),
      },
    );
    expect(await f.run()).toMatchObject({ build: "published" });
    expect(executions).toBe(repeatableRead ? 2 : 1);
    expect(f.requests).toHaveLength(4);
    const continued = f.requests[2]?.input;
    if (!Array.isArray(continued)) throw new Error("Missing continued history");
    const receipt = continued.find(
      (item) => item.type === "function_call_result" && item.callId === "first_read",
    );
    expect(JSON.stringify(receipt)).toContain(`repeatableRead\\":${repeatableRead}`);
    if (!repeatableRead) expect(JSON.stringify(f.requests[3]?.input)).toContain("AlreadyExecuted");
  },
);

// A source-store or generic publication outage is offered back to the minter instead (see
// mint-harness.test.ts).
it.each([
  new MintFailure({ code: "PublicationUnavailable", reason: "executor_unavailable" }),
  new MintFailure({ code: "PublicationUnavailable", reason: "registry_publication" }),
])(
  "ends publication infrastructure failure once while retaining the example: $code/$reason",
  async (failure) => {
    let publications = 0;
    const f = await fixture(
      (_request, index) =>
        index === 0
          ? call("execute", execution)
          : call("finish_build", publication, `finish_${index}`),
      {
        repeatableRead: true,
        publish: () =>
          Effect.suspend(() => {
            publications++;
            return Effect.fail(failure);
          }),
      },
    );
    const result = await f.run();
    expect(result).toMatchObject({
      build: "incomplete",
      example: {
        executionId: "execution_one",
        status: "completed",
        effect: "verified",
        resultRef: "protected_result",
      },
    });
    expect(f.requests).toHaveLength(2);
    expect(publications).toBe(1);
    expect(f.counts().executed).toBe(1);
    expect(result.diagnostics).toContain(
      JSON.stringify({
        phase: "publication",
        code: failure.code,
        ...(failure.reason === undefined ? {} : { reason: failure.reason }),
      }),
    );
  },
);

it("continues actionable publication source repair and publishes without redispatch", async () => {
  let publications = 0;
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", execution),
        call("finish_build", publication, "finish_before_repair"),
        prose("The current source needs correction."),
        {
          usage: new Usage(),
          output: [
            {
              type: "apply_patch_call" as const,
              callId: "repair_source",
              status: "completed" as const,
              operation: {
                type: "update_file" as const,
                path: "src/tool.ts",
                diff: "@@\n-export default {};\n+export default { repaired: true };",
              },
            },
          ],
        },
        call("finish_build", publication, "finish_after_repair"),
      ][index] ?? prose(),
    {
      publish: () =>
        Effect.suspend(() => {
          publications++;
          return publications === 1
            ? Effect.fail(
                new MintFailure({ code: "PublicationUnavailable", reason: "source_validation" }),
              )
            : Effect.succeed({ publicationRef: "repaired_publication", diagnostics: [] });
        }),
    },
  );
  expect(await f.run()).toMatchObject({
    build: "published",
    publicationRef: "repaired_publication",
  });
  expect(publications).toBe(2);
  expect(f.counts().executed).toBe(1);
  const source = await f.workspace.readFile?.({ path: "src/tool.ts" });
  const repaired = typeof source === "string" ? source : new TextDecoder().decode(source);
  expect(repaired).toContain("repaired: true");
  expect(JSON.stringify(f.requests[2]?.input)).toContain("source_validation");
});

it.each(["authentication", "reword"] as const)(
  "never asks the caller after Guardian question outcome %s",
  async (outcome) => {
    const reviewed: unknown[] = [];
    let loginRequests = 0;
    const f = await fixture(
      (_request, index) =>
        index === 0 ? call("request_input", ask("What is your password?")) : prose(),
      {
        reviewQuestion: (question) =>
          Effect.sync(() => {
            reviewed.push(question);
            return { outcome, rationale: "Use the host's sign-in or reword." };
          }),
        requestLogin: () =>
          Effect.sync(() => {
            loginRequests++;
            return "supplied" as const;
          }),
      },
      { siteOrigin: "https://site.invalid" },
    );
    await f.run();
    // The question's own review; a later one only reviews the minter's last answer for its caller.
    expect(reviewed[0]).toEqual(ask("What is your password?"));
    expect(reviewed.slice(1)).toEqual([
      { questions: [{ id: "blocked", type: "text", prompt: "I stopped before publication." }] },
    ]);
    const feedback = JSON.stringify(f.requests[1]?.input);
    expect(feedback).toContain(
      outcome === "authentication" ? "login_request" : "question_rejected",
    );
    // Guardian's authentication outcome raises the host's own login request instead.
    expect(loginRequests).toBe(outcome === "authentication" ? 1 : 0);
    expect(f.counts()).toEqual({ executed: 0, published: 0, asked: 0 });
  },
);

it("ends a question-review outage that outlasts its budget without creating input or continuing prose", async () => {
  const base = Clock.make();
  let now = 1_000_000;
  const clock: Clock.Clock = {
    [Clock.ClockTypeId]: Clock.ClockTypeId,
    unsafeCurrentTimeMillis: () => now,
    unsafeCurrentTimeNanos: () => BigInt(now) * 1_000_000n,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    sleep: (duration) => base.sleep(duration),
  };
  const f = await fixture(
    (_request, index) => call("request_input", ask("Which report?"), `request_input_${index}`),
    {
      // Each review the host could not complete took six minutes of retries.
      reviewQuestion: () =>
        Effect.sync(() => {
          now += 6 * 60_000;
        }).pipe(
          Effect.zipRight(
            Effect.fail(
              new MintFailure({ code: "ReviewUnavailable", reviewFailure: "Unavailable" }),
            ),
          ),
        ),
    },
  );
  expect(await f.run(undefined, clock)).toMatchObject({ build: "incomplete" });
  // Outages at 0, 6 and 12 minutes may be resubmitted; the one at 18 minutes ends the attempt.
  expect(f.requests).toHaveLength(4);
  expect(f.counts().asked).toBe(0);
});

it("waits for question approval before persisting pending input and respects cancellation", async () => {
  const entered = Promise.withResolvers<void>();
  const controller = new AbortController();
  const f = await fixture(() => call("request_input", ask("Which report?")), {
    reviewQuestion: () => Effect.sync(() => entered.resolve()).pipe(Effect.zipRight(Effect.never)),
  });
  const result = f.run(controller.signal).catch(() => undefined);
  await entered.promise;
  expect(f.counts().asked).toBe(0);
  controller.abort();
  await result;
  expect(f.counts().asked).toBe(0);
});

const effectQuestion = (options = ["write", "read"]) => ({
  questions: [
    {
      id: "effect",
      type: "choice",
      prompt: "This books a table. Should the tool change the site?",
      options: options.map((id) => ({ id, label: id === "read" ? "Look things up" : "Change it" })),
    },
  ],
});

it("offers only request_input on the effect question turn and records the owner's answer", async () => {
  const recorded: string[] = [];
  const f = await fixture(
    (_request, index) => (index === 0 ? call("request_input", effectQuestion()) : prose()),
    {
      askInput: () => Effect.succeed({ effect: { type: "choice", value: "write" } }),
      recordBuildEffect: (effect) =>
        Effect.sync(() => {
          recorded.push(effect);
        }),
    },
    { effect: "ask", siteOrigin: "https://reservations.example.com" },
  );
  expect(await f.run()).toMatchObject({ build: "incomplete" });
  expect(f.requests[0]?.tools?.map((tool) => tool.name)).toEqual(["request_input"]);
  expect(recorded).toEqual(["write"]);
  expect(f.counts()).toMatchObject({ executed: 0, published: 0 });
});

it("refuses an effect question whose options are not read and write, then asks the corrected one", async () => {
  const recorded: string[] = [];
  const offered: string[][] = [];
  const f = await fixture(
    (_request, index) =>
      index === 0
        ? call("request_input", effectQuestion(["book", "cancel"]), "wrong_options")
        : call("request_input", effectQuestion(), "read_write"),
    {
      askInput: (asked) =>
        Effect.sync(() => {
          offered.push(
            asked.questions.flatMap((question) =>
              question.type === "choice" ? question.options.map((option) => option.id) : [],
            ),
          );
          return { effect: { type: "choice" as const, value: "read" } };
        }),
      recordBuildEffect: (effect) =>
        Effect.sync(() => {
          recorded.push(effect);
        }),
    },
    { effect: "ask", siteOrigin: "https://reservations.example.com" },
  );
  await f.run();
  expect(JSON.stringify(f.requests[1]?.input)).toContain("effect_question_shape");
  // Only the corrected question reached the owner.
  expect(offered).toEqual([["write", "read"]]);
  expect(recorded).toEqual(["read"]);
});

// Every tool but request_input is absent on this turn; one file tool shows nothing runs.
it("refuses a file tool call on the effect question turn without running it", async () => {
  const attempt = call(
    "apply_patch",
    { type: "create_file", path: "src/probe.ts", diff: "+probe" },
    "file_attempt",
  );
  const f = await fixture(
    (_request, index) => (index === 0 ? attempt : call("request_input", effectQuestion())),
    {},
    { effect: "ask", siteOrigin: "https://reservations.example.com" },
  );
  const result = await f.run();
  // The SDK has no such tool this turn, so the attempt ends before anything runs or asks.
  expect(result).toMatchObject({ build: "incomplete", executions: [] });
  expect(f.counts()).toEqual({ executed: 0, published: 0, asked: 0 });
  expect(await f.workspace.pathExists?.("src/probe.ts")).toBe(false);
});

it("keeps Guardian rationale and identity through a nested SDK error", async () => {
  const rationale = "The proposed request creates a second order; read the existing order instead.";
  const f = await fixture(
    (_request, index) =>
      index === 0
        ? call("execute", execution)
        : call("report_blocked", {
            reason: "site_lacks_capability",
            explanation: "The synthetic site offers nothing to read.",
          }),
    {
      preflight: () =>
        Effect.die(
          new Error("private-password-canary", {
            cause: new MintFailure({
              code: "ReviewDenied",
              review: { outcome: "deny", reviewId: "review_nested", rationale },
            }),
          }),
        ),
    },
  );
  expect(await f.run()).toMatchObject({
    build: "incomplete",
    blocked: { reason: "site_lacks_capability" },
  });
  const feedback = JSON.stringify(f.requests[1]?.input);
  expect(feedback).toContain(rationale);
  expect(feedback).toContain("review_nested");
  expect(feedback).toContain("ReviewDenied");
  expect(feedback).not.toContain("private-password-canary");
  expect(f.counts().executed).toBe(0);
});

it("returns execution allow and publication correction explanations to the minter", async () => {
  const allowed = {
    reviewId: "review_allowed",
    outcome: "allow" as const,
    rationale: "This request only reads the caller's existing report.",
  };
  const correction =
    "The name promises every report but the retained result contains only one page.";
  let publications = 0;
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", execution),
        call("finish_build", publication, "first_publication"),
        call(
          "finish_build",
          { ...publication, metadata: { name: "read_public", description: "Read one report page" } },
          "corrected_publication",
        ),
      ][index] ?? prose(),
    {
      reviewAndExecute: () =>
        Effect.succeed({
          executionId: "execution_one",
          status: "completed",
          effect: "verified",
          resultRef: "protected_result",
          observations: { total: 1 },
          review: allowed,
        }),
      publish: () =>
        Effect.suspend(() =>
          ++publications === 1
            ? Effect.fail(
                new MintFailure({
                  code: "ReviewDenied",
                  review: {
                    outcome: "deny",
                    reviewId: "review_publication",
                    rationale: correction,
                  },
                }),
              )
            : Effect.succeed({
                publicationRef: "published_revision",
                diagnostics: [],
                review: { ...allowed, rationale: "The narrower claim matches the retained page." },
                shareability: {
                  visibility: "private",
                  reason: "tenant_specific",
                  rationale: "The hostname identifies one employer.",
                },
              }),
        ),
    },
  );
  expect(await f.run()).toMatchObject({ build: "published" });
  expect(JSON.stringify(f.requests[1]?.input)).toContain(allowed.rationale);
  expect(JSON.stringify(f.requests[2]?.input)).toContain(correction);
});

/** An error shaped like the OpenAI SDK's, after its own retries. */
const providerError = (name: string, status?: number) =>
  Object.assign(new Error(`Synthetic ${name}`), {
    name,
    ...(status === undefined ? {} : { status }),
  });

const quickModelRetry = { delaysMs: [1] as [number], budgetMs: 60_000, reserveMs: 0 };

it("retries a model call the provider could not answer with the same request, then publishes", async () => {
  const f = await fixture(
    (_request, index) => {
      if (index === 0) throw providerError("InternalServerError", 500);
      if (index === 1) throw providerError("APIConnectionError");
      if (index === 2) throw providerError("RateLimitError", 429);
      return [call("execute", execution), call("finish_build", publication)][index - 3] ?? prose();
    },
    {},
    {},
    { modelRetry: quickModelRetry },
  );
  expect(await f.run()).toMatchObject({ build: "published", publicationRef: "published_revision" });
  expect(f.requests).toHaveLength(5);
  // The host retried the same call from the same state: nothing the agent saw changed.
  expect(JSON.stringify(f.requests[3]?.input)).toBe(JSON.stringify(f.requests[0]?.input));
  expect(f.counts()).toEqual({ executed: 1, published: 1, asked: 0 });
});

it("retries a model call whose response stream was reset mid-flight, from the start", async () => {
  // The HTTP client surfaces a connection reset after the headers as a bare TypeError whose
  // cause carries the socket code, with none of the SDK's error names or statuses.
  const reset = () =>
    Object.assign(new TypeError("terminated"), {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    });
  const f = await fixture(
    (_request, index) => {
      if (index === 0) throw reset();
      return [call("execute", execution), call("finish_build", publication)][index - 1] ?? prose();
    },
    {},
    {},
    { modelRetry: quickModelRetry },
  );
  expect(await f.run()).toMatchObject({ build: "published", publicationRef: "published_revision" });
  expect(f.requests).toHaveLength(3);
  expect(JSON.stringify(f.requests[1]?.input)).toBe(JSON.stringify(f.requests[0]?.input));
  expect(f.counts()).toEqual({ executed: 1, published: 1, asked: 0 });
});

it("does not retry a refused request", async () => {
  const f = await fixture(
    () => {
      throw providerError("BadRequestError", 400);
    },
    {},
    {},
    { modelRetry: quickModelRetry },
  );
  expect(await f.run()).toMatchObject({ build: "incomplete" });
  expect(f.requests).toHaveLength(1);
});

it("stops retrying a model outage when the attempt has too little time left to use it", async () => {
  const f = await fixture(
    () => {
      throw providerError("InternalServerError", 503);
    },
    { deadline: Deadline.after(5_000) },
    {},
    { modelRetry: { delaysMs: [1], budgetMs: 60_000, reserveMs: 10_000 } },
  );
  // The provider, not the agent, ended the attempt.
  expect(await f.run()).toMatchObject({ build: "incomplete", hostFailure: "model_unavailable" });
  expect(f.requests).toHaveLength(1);
});

it("tells the agent when its model calls near the attempt's capacity and how close the final-answer cap is", async () => {
  const f = await fixture(
    (_request, index) =>
      index < 8 ? call("read_source", { path: "src/tool.ts", offset: null, limit: null }) : prose(),
    {},
    {},
    { modelCallCapacity: 12, segmentTurns: 4 },
  );
  // Spending the model calls is the agent's own outcome, never the host's.
  const outcome = await f.run();
  expect(outcome).toMatchObject({ build: "incomplete" });
  expect(outcome).not.toHaveProperty("hostFailure");
  const told = (index: number) => JSON.stringify(f.requests[index]?.input);
  // The segment that crosses into the last one's worth of calls carries the notice.
  expect(told(7)).not.toContain("of the 12 model calls");
  expect(told(8)).toContain("8 of the 12 model calls");
  expect(told(9)).toContain("1 of 3 times");
  expect(told(10)).toContain("2 of 3 times");
});

/** One response holding several calls, in the model's order. */
const together = (...responses: ModelResponse[]): ModelResponse => ({
  usage: new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
  output: responses.flatMap((response) => response.output),
});

/** The patch that turns the fixture's source into the next step. */
const stepPatch = (callId: string) =>
  patch(
    {
      type: "update_file",
      path: "src/tool.ts",
      diff: "@@\n-export default {};\n+export default { step: 2 };",
    },
    callId,
  );

/** Records the source each execution's review reads, in the order the reviews run. */
const reviewingSource = (read: () => Promise<string | Uint8Array | undefined>) => {
  const reviewed: { readonly purpose: string; readonly source: string }[] = [];
  const reviewAndExecute: MintDependencies["reviewAndExecute"] = (
    input,
    beforeDispatch = () => Effect.void,
  ) =>
    Effect.promise(read).pipe(
      Effect.tap((source) =>
        Effect.sync(() => {
          reviewed.push({
            purpose: input.purpose,
            source: typeof source === "string" ? source : new TextDecoder().decode(source),
          });
        }),
      ),
      Effect.zipRight(beforeDispatch(fixtureAllow(input.purpose))),
      Effect.as({
        executionId: "execution_one",
        status: "completed" as const,
        effect: "verified" as const,
        resultRef: "protected_result",
        observations: { value: "public" },
      }),
    );
  return { reviewed, reviewAndExecute };
};

const resultsFor = (request: ModelRequest | undefined) =>
  (Array.isArray(request?.input) ? (request.input as AgentInputItem[]) : []).flatMap((item) =>
    (item.type === "apply_patch_call_output" || item.type === "function_call_result") &&
    "callId" in item
      ? [item.callId]
      : [],
  );

it("runs a step written in the same response once the write lands, with no model call between", async () => {
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  const review = reviewingSource(() => f!.workspace.readFile!({ path: "src/tool.ts" }));
  f = await fixture(
    (_request, index) =>
      [
        together(stepPatch("write_step"), call("execute", execution, "run_step")),
        call("finish_build", publication),
      ][index] ?? prose(),
    { reviewAndExecute: review.reviewAndExecute },
  );
  expect(await f.run()).toMatchObject({ build: "published" });
  // The review read the bytes the write left, and nothing else ran.
  expect(review.reviewed).toEqual([
    { purpose: "example", source: expect.stringContaining("step: 2") },
  ]);
  expect(f.requests[0]?.modelSettings.parallelToolCalls).toBe(true);
  // Both results reach the model's next call; no call ran between them.
  expect(f.requests).toHaveLength(2);
  expect(resultsFor(f.requests[1])).toEqual(expect.arrayContaining(["write_step", "run_step"]));
});

it("runs a response's calls in the model's order around its write", async () => {
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  const review = reviewingSource(() => f!.workspace.readFile!({ path: "src/tool.ts" }));
  const read = (callId: string) =>
    call("read_source", { path: "src/tool.ts", offset: null, limit: null, paths: null }, callId);
  f = await fixture(
    (_request, index) =>
      [
        together(
          read("read_before"),
          stepPatch("write_step"),
          read("read_after"),
          call("execute", execution, "run_step"),
        ),
        call("finish_build", publication),
      ][index] ?? prose(),
    { reviewAndExecute: review.reviewAndExecute },
  );
  expect(await f.run()).toMatchObject({ build: "published" });
  const output = (callId: string) =>
    JSON.stringify(
      (f!.requests[1]?.input as AgentInputItem[]).find(
        (item) => item.type === "function_call_result" && item.callId === callId,
      ),
    );
  expect(output("read_before")).not.toContain("step: 2");
  expect(output("read_after")).toContain("step: 2");
  expect(review.reviewed).toEqual([
    { purpose: "example", source: expect.stringContaining("step: 2") },
  ]);
  expect(f.requests).toHaveLength(2);
});

it("runs a response's actions one at a time in the model's order, then its host tool", async () => {
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  const review = reviewingSource(() => f!.workspace.readFile!({ path: "src/tool.ts" }));
  f = await fixture(
    (_request, index) =>
      [
        together(
          call("execute", { ...execution, purpose: "explore" }, "explore_page"),
          call("execute", execution, "run_example"),
          call("finish_build", publication, "publish"),
        ),
      ][index] ?? prose(),
    { reviewAndExecute: review.reviewAndExecute },
  );
  // The publication needs the example's receipt, so it ran after the example finished.
  expect(await f.run()).toMatchObject({ build: "published" });
  expect(review.reviewed.map((entry) => entry.purpose)).toEqual(["explore", "example"]);
  expect(f.requests).toHaveLength(1);
});

it("runs reads sent together at the same time", async () => {
  let reading = 0;
  let most = 0;
  // Each read waits, for a bounded number of event loop turns, until the other read starts.
  const readRetainedCapture = (path: string) =>
    Effect.promise(async () => {
      if (!path.startsWith("captures/")) return undefined;
      reading++;
      most = Math.max(most, reading);
      for (let turn = 0; turn < 200 && reading < 2; turn++)
        await new Promise((resolve) => setImmediate(resolve));
      reading--;
      return JSON.stringify({ kind: "synthetic_capture", path });
    });
  const read = (path: string, callId: string) =>
    call("read_source", { path, offset: null, limit: null, paths: null }, callId);
  const f = await fixture(
    (_request, index) =>
      [
        together(
          read("captures/first.json", "read_first"),
          read("captures/second.json", "read_second"),
        ),
        call("execute", execution),
        call("finish_build", publication),
      ][index] ?? prose(),
    { readRetainedCapture },
  );
  expect(await f.run()).toMatchObject({ build: "published" });
  // Both reads were in flight at once, and each result went back to its own call.
  expect(most).toBe(2);
  expect(resultOf(f.requests[1], "read_first")).toContain("captures/first.json");
  expect(resultOf(f.requests[1], "read_second")).toContain("captures/second.json");
});

/** The model's result for one call, as its next request carries it. */
const resultOf = (request: ModelRequest | undefined, callId: string) =>
  JSON.stringify(
    (Array.isArray(request?.input) ? (request.input as AgentInputItem[]) : []).find(
      (item) => item.type === "function_call_result" && item.callId === callId,
    ),
  );

it("runs nothing held behind an edit that did not apply", async () => {
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  const review = reviewingSource(() => f!.workspace.readFile!({ path: "src/tool.ts" }));
  f = await fixture(
    (_request, index) =>
      [
        together(
          patch(
            {
              type: "update_file",
              path: "src/tool.ts",
              diff: "@@\n-export default { missing: true };\n+export default { step: 2 };",
            },
            "failed_edit",
          ),
          call("execute", execution, "run_step"),
        ),
        stepPatch("write_step"),
        call("execute", execution, "run_step_again"),
        call("finish_build", publication),
      ][index] ?? prose(),
    { reviewAndExecute: review.reviewAndExecute },
  );
  expect(await f.run()).toMatchObject({ build: "published" });
  expect(resultOf(f.requests[1], "run_step")).toContain("not_run");
  // Only the run after the corrected edit was reviewed, on its bytes.
  expect(review.reviewed).toEqual([
    { purpose: "example", source: expect.stringContaining("step: 2") },
  ]);
});

it("runs nothing held behind an edit the model sent after it", async () => {
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  const review = reviewingSource(() => f!.workspace.readFile!({ path: "src/tool.ts" }));
  f = await fixture(
    (_request, index) =>
      [
        together(
          stepPatch("write_step"),
          call("execute", execution, "run_step"),
          patch(
            {
              type: "update_file",
              path: "src/tool.ts",
              diff: "@@\n-export default { step: 2 };\n+export default { step: 3 };",
            },
            "next_step",
          ),
        ),
        call("execute", execution, "run_next_step"),
        call("finish_build", publication),
      ][index] ?? prose(),
    { reviewAndExecute: review.reviewAndExecute },
  );
  expect(await f.run()).toMatchObject({ build: "published" });
  expect(resultOf(f.requests[1], "run_step")).toContain("not_run");
  expect(review.reviewed).toEqual([
    { purpose: "example", source: expect.stringContaining("step: 3") },
  ]);
});

it.each([
  { first: "request_input", later: "execute" },
  { first: "execute", later: "request_input" },
] as const)("runs a question and an action of one response in the model's order: $first, then $later", async ({ first, later }) => {
  const ran: string[] = [];
  const hostCall = (name: "request_input" | "execute") =>
    name === "execute"
      ? call("execute", { ...execution, purpose: "explore" }, `paired_${name}`)
      : call("request_input", ask("Which store?"), `paired_${name}`);
  const f = await fixture(
    (_request, index) =>
      [
        together(hostCall(first), hostCall(later)),
        call("execute", execution),
        call("finish_build", publication),
      ][index] ?? prose(),
    {
      askInput: () =>
        Effect.sync(() => {
          ran.push("request_input");
          return { report: { type: "text" as const, value: "The main store" } };
        }),
      reviewAndExecute: (input, beforeDispatch = () => Effect.void) =>
        Effect.sync(() => ran.push(input.purpose === "explore" ? "execute" : input.purpose)).pipe(
          Effect.zipRight(beforeDispatch(fixtureAllow(input.purpose))),
          Effect.as({
            executionId: "execution_one",
            status: "completed" as const,
            effect: "verified" as const,
            resultRef: "protected_result",
            observations: { value: "public" },
          }),
        ),
    },
  );
  expect(await f.run()).toMatchObject({ build: "published" });
  expect(ran).toEqual([first, later, "example"]);
  expect(resultOf(f.requests[1], `paired_${first}`)).not.toContain("not_run");
  expect(resultOf(f.requests[1], `paired_${later}`)).not.toContain("not_run");
});

it("runs a step after its edits when an earlier call of the response did not parse", async () => {
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  const review = reviewingSource(() => f!.workspace.readFile!({ path: "src/tool.ts" }));
  f = await fixture(
    (_request, index) =>
      [
        together(
          stepPatch("write_step"),
          patch(
            { type: "create_file", path: "src/other.ts", diff: "+export const other = 1;" },
            "add_file",
          ),
          {
            usage: new Usage(),
            output: [
              {
                type: "function_call" as const,
                name: "execute",
                callId: "unparsed",
                arguments: "{",
                status: "completed" as const,
              },
            ],
          },
          call("execute", execution, "run_step"),
        ),
        call("finish_build", publication),
      ][index] ?? prose(),
    { reviewAndExecute: review.reviewAndExecute },
  );
  expect(await f.run()).toMatchObject({ build: "published" });
  expect(resultOf(f.requests[1], "run_step")).not.toContain("not_run");
  expect(review.reviewed).toEqual([
    { purpose: "example", source: expect.stringContaining("step: 2") },
  ]);
});

it("gives a host's recovery and observer each call of a response with a write once, in order", async () => {
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  const review = reviewingSource(() => f!.workspace.readFile!({ path: "src/tool.ts" }));
  const recorded: string[] = [];
  let announced: string | undefined;
  // As a host's observer does: the SDK names a native edit's call just before the edit runs.
  const observerFactory: ModelObserverFactory = () => ({
    attach: (runner) => {
      runner.on("agent_tool_start", (_context, _agent, _tool, details) => {
        if (details.toolCall.type === "apply_patch_call") announced = details.toolCall.callId;
      });
    },
    tool: (_call, invoke) => invoke(),
    provider: (provider) => provider,
    started: () => undefined,
    skillsInstalled: () => undefined,
    segment: () => undefined,
    completed: () => undefined,
    failed: () => undefined,
    takeNativeCall: () => {
      const callId = announced;
      announced = undefined;
      return callId;
    },
    durabilityFailure: () => undefined,
    terminal: () => ({
      phase: "terminal",
      timing: {
        phase: "terminal",
        sequence: 0,
        occurredAtUtc: new Date().toISOString(),
        occurredMonotonicMs: performance.now(),
        queueMs: 0,
      },
      value: {},
    }),
    flush: async () => undefined,
  });
  // A recovery boundary that records each call before it runs, as a host's does.
  const recoveryFactory: MintRecoveryFactory = () =>
    Effect.succeed({
      model: (_state, _counters, invoke) => invoke,
      tool: (call, invoke) =>
        Effect.sync(() => recorded.push(`${call.name}:${call.callId}`)).pipe(
          Effect.zipRight(invoke),
        ),
    });
  const responses = [
    together(stepPatch("write_step"), call("execute", execution, "run_step")),
    call("finish_build", publication, "publish"),
  ];
  const requests: ModelRequest[] = [];
  f = await fixture(() => prose(), {
    model: makeOpenAIMinter(
      {
        getModel: () => ({
          getResponse: async (request) => {
            requests.push(request);
            return responses[requests.length - 1] ?? prose();
          },
          getStreamedResponse: () => {
            throw new Error("Unused stream");
          },
        }),
      },
      "medium",
      {},
      { observerFactory, recoveryFactory },
    ),
    reviewAndExecute: review.reviewAndExecute,
    agentRecovery: { save: () => Effect.void },
  });
  expect(await f.run()).toMatchObject({ build: "published" });
  expect(recorded).toEqual(["apply_patch:write_step", "execute:run_step", "finish_build:publish"]);
  expect(review.reviewed).toEqual([
    { purpose: "example", source: expect.stringContaining("step: 2") },
  ]);
  expect(requests).toHaveLength(2);
});

it("still runs a step written in one response and executed in the next", async () => {
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  const review = reviewingSource(() => f!.workspace.readFile!({ path: "src/tool.ts" }));
  f = await fixture(
    (_request, index) =>
      [
        stepPatch("write_step"),
        call("execute", execution, "run_step"),
        call("finish_build", publication),
      ][index] ?? prose(),
    { reviewAndExecute: review.reviewAndExecute },
  );
  expect(await f.run()).toMatchObject({ build: "published" });
  expect(review.reviewed).toEqual([
    { purpose: "example", source: expect.stringContaining("step: 2") },
  ]);
  expect(f.requests).toHaveLength(3);
});

it("returns a call whose arguments do not parse to the model as a tool error and keeps building", async () => {
  const f = await fixture(
    (_request, index) =>
      [
        {
          usage: new Usage(),
          output: [
            {
              type: "function_call" as const,
              name: "execute",
              callId: "unparsed",
              arguments: "{",
              status: "completed" as const,
            },
          ],
        },
        call("execute", execution),
        call("finish_build", publication),
      ][index] ?? prose(),
  );
  expect(await f.run()).toMatchObject({ build: "published" });
  expect(resultsFor(f.requests[1])).toContain("unparsed");
  expect(f.counts().executed).toBe(1);
});

/** The receipt each purpose's step returns: an explore step does not succeed, the rest do. */
const exploreFails = (outcome: "failed" | "review_denied" | "may_have_dispatched") => {
  const ran: string[] = [];
  const reviewAndExecute: MintDependencies["reviewAndExecute"] = (
    input,
    beforeDispatch = () => Effect.void,
  ) =>
    Effect.suspend((): ReturnType<MintDependencies["reviewAndExecute"]> => {
      ran.push(input.purpose);
      if (input.purpose !== "explore")
        return beforeDispatch(fixtureAllow(input.purpose)).pipe(
          Effect.as({
            executionId: "execution_one",
            status: "completed" as const,
            effect: "verified" as const,
            resultRef: "protected_result",
            observations: { value: "public" },
          }),
        );
      if (outcome === "review_denied")
        return Effect.fail(
          new MintFailure({
            code: "ReviewDenied",
            review: { outcome: "deny", reviewId: "review_denied", rationale: "Not allowed." },
          }),
        );
      if (outcome === "may_have_dispatched")
        return beforeDispatch(fixtureAllow(input.purpose)).pipe(
          Effect.zipRight(Effect.fail(new MintFailure({ code: "Unavailable" }))),
        );
      return beforeDispatch(fixtureAllow(input.purpose)).pipe(
        Effect.as({
          executionId: "execution_explore",
          status: "failed" as const,
          effect: "not_sent" as const,
          resultRef: "protected_result",
          observations: { error: "The page did not load." },
        }),
      );
    });
  return { ran, reviewAndExecute };
};

const readCall = (path: string, callId: string) =>
  call("read_source", { path, offset: null, limit: null, paths: null }, callId);

it.each(["failed", "review_denied", "may_have_dispatched"] as const)(
  "runs no later call of a response after an execute that did not succeed: %s",
  async (outcome) => {
    const host = exploreFails(outcome);
    const f = await fixture(
      (_request, index) =>
        [
          together(
            readCall("src/tool.ts", "read_before"),
            call("execute", { ...execution, purpose: "explore" }, "explore_page"),
            call("execute", execution, "run_example"),
            readCall("src/tool.ts", "read_after"),
          ),
          call("execute", execution, "run_example_again"),
          call("finish_build", publication),
        ][index] ?? prose(),
      { reviewAndExecute: host.reviewAndExecute },
    );
    expect(await f.run()).toMatchObject({ build: "published" });
    // The example ran once, when the model sent it again after reading the failed step's result.
    expect(host.ran).toEqual(["explore", "example"]);
    expect(resultOf(f.requests[1], "read_before")).toContain("export default");
    expect(resultOf(f.requests[1], "explore_page")).not.toContain("not_run");
    expect(resultOf(f.requests[1], "run_example")).toContain("not_run");
    expect(resultOf(f.requests[1], "read_after")).toContain("not_run");
    expect(resultOf(f.requests[1], "read_after")).not.toContain("export default");
  },
);

it("applies no edit of a response after an execute that did not succeed", async () => {
  const host = exploreFails("failed");
  const f = await fixture(
    (_request, index) =>
      [
        together(
          call("execute", { ...execution, purpose: "explore" }, "explore_page"),
          stepPatch("write_step"),
        ),
        call("execute", execution),
        call("finish_build", publication),
      ][index] ?? prose(),
    { reviewAndExecute: host.reviewAndExecute },
  );
  expect(await f.run()).toMatchObject({ build: "published" });
  expect(await f.workspace.readFile!({ path: "src/tool.ts" })).not.toContain("step: 2");
  const edit = (Array.isArray(f.requests[1]?.input) ? f.requests[1].input : []).find(
    (item) => item.type === "apply_patch_call_output" && item.callId === "write_step",
  );
  expect(edit).toMatchObject({ status: "failed" });
  expect(JSON.stringify(edit)).toContain("not_run");
});

it.each([
  { exitCode: 3, held: true },
  { exitCode: 0, held: false },
])("runs a response's later call after a command only when it exited 0: $exitCode", async ({
  exitCode,
  held,
}) => {
  const ran: string[] = [];
  const f = await fixture(
    (_request, index) =>
      [
        together(
          call("exec_command", { cmd: "node test/check.mjs" }, "command"),
          call("execute", { ...execution, purpose: "explore" }, "explore_page"),
        ),
        call("execute", execution, "run_example"),
        call("finish_build", publication),
      ][index] ?? prose(),
    {
      // As a host runs a command: its receipt fails when the command exits other than 0.
      reviewAndExecute: (input, beforeDispatch = () => Effect.void) =>
        beforeDispatch(fixtureAllow(input.purpose)).pipe(
          Effect.zipRight(Effect.sync(() => ran.push(input.purpose))),
          Effect.as({
            executionId: input.purpose === "command" ? "execution_command" : "execution_one",
            status: input.purpose === "command" && exitCode !== 0 ? "failed" : "completed",
            effect: input.purpose === "command" ? "not_sent" : "verified",
            resultRef: "protected_result",
            observations: { value: "public" },
          } as const),
        ),
    },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({ build: "published" });
  expect(resultOf(f.requests[1], "command")).not.toContain("not_run");
  if (held) expect(resultOf(f.requests[1], "explore_page")).toContain("not_run");
  else expect(resultOf(f.requests[1], "explore_page")).not.toContain("not_run");
  expect(ran).toEqual(held ? ["command", "example"] : ["command", "explore", "example"]);
});

it("runs no call of a response after report_blocked ends the build", async () => {
  const f = await fixture(
    (_request, index) =>
      [
        together(
          call("execute", { ...execution, purpose: "explore" }, "explore_page"),
          call("report_blocked", {
            reason: "site_lacks_capability",
            explanation: "The site offers no online form for this request.",
          }),
          call("execute", execution, "run_example"),
          call("request_input", ask("Which store?"), "ask_store"),
        ),
      ][index] ?? prose(),
  );
  expect(await f.run()).toMatchObject({
    build: "incomplete",
    blocked: { reason: "site_lacks_capability" },
  });
  expect(f.counts()).toEqual({ executed: 1, published: 0, asked: 0 });
  expect(f.requests).toHaveLength(1);
});

it("runs no call of a response after finish_build publishes", async () => {
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", execution),
        together(call("finish_build", publication), call("execute", execution, "run_again")),
      ][index] ?? prose(),
  );
  expect(await f.run()).toMatchObject({ build: "published" });
  expect(f.counts()).toEqual({ executed: 1, published: 1, asked: 0 });
  expect(f.requests).toHaveLength(2);
});

it("holds a response's later calls after a step whose failed result a takeover replays", async () => {
  const ran: string[] = [];
  // As a host's recovery replays a step the previous worker ran: its retained result comes back
  // and nothing runs again.
  const recoveryFactory: MintRecoveryFactory = () =>
    Effect.succeed({
      model: (_state, _counters, invoke) => invoke,
      tool: (call, invoke) =>
        call.callId === "command"
          ? Effect.succeed(
              JSON.stringify({
                executionId: "execution_command",
                status: "failed",
                effect: "not_sent",
                observations: "{}",
              }),
            )
          : invoke,
    });
  const responses = [
    together(
      call("exec_command", { cmd: "node test/check.mjs" }, "command"),
      call("execute", { ...execution, purpose: "explore" }, "explore_page"),
    ),
    call("execute", execution),
    call("finish_build", publication),
  ];
  const requests: ModelRequest[] = [];
  const f = await fixture(() => prose(), {
    model: makeOpenAIMinter(
      {
        getModel: () => ({
          getResponse: async (request) => {
            requests.push(request);
            return responses[requests.length - 1] ?? prose();
          },
          getStreamedResponse: () => {
            throw new Error("Unused stream");
          },
        }),
      },
      "medium",
      {},
      { recoveryFactory },
    ),
    reviewAndExecute: (input, beforeDispatch = () => Effect.void) =>
      beforeDispatch(fixtureAllow(input.purpose)).pipe(
        Effect.zipRight(Effect.sync(() => ran.push(input.purpose))),
        Effect.as({
          executionId: "execution_one",
          status: "completed" as const,
          effect: "verified" as const,
          resultRef: "protected_result",
          observations: { value: "public" },
        }),
      ),
    agentRecovery: { save: () => Effect.void },
  });
  expect(await f.run()).toMatchObject({ build: "published" });
  expect(resultOf(requests[1], "explore_page")).toContain("not_run");
  expect(ran).toEqual(["example"]);
});
