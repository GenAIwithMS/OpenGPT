import {
  makeMintContinuationFixture,
  makeMintHarnessFixture,
  portableJobSession,
  readAllow,
} from "../support/mint-fixtures.js";
import { Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Deferred, Effect, Fiber } from "effect";
import { afterEach, expect, it } from "vitest";
import { MintFailure } from "../../src/mint/contracts.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { autofillRefusalFailure } from "../../src/mint/sign-in-failure.js";
import { portableMintProjection } from "../support/portable-mint.js";

/*
 * How an unpublished build ends: each ending carries its own typed reason, so a host can tell the
 * caller what stopped the build instead of reporting a missing publication. Every scenario runs
 * the real minter loop on recorded model responses.
 */

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const prose = (text = "I stopped before publication."): ModelResponse => ({
  usage: new Usage({
    requests: 1,
    inputTokens: 2,
    outputTokens: 1,
    totalTokens: 3,
  }),
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

const call = (name: string, input: unknown, id = name): ModelResponse => ({
  usage: new Usage({
    requests: 1,
    inputTokens: 2,
    outputTokens: 1,
    totalTokens: 3,
  }),
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

const ask = (prompt: string) => ({
  questions: [{ id: "report", type: "text", prompt }],
});

const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);

/** The owner's choice to stop, as a choice question the minter asks once a needed fact is unknown. */
const stopChoice = {
  questions: [
    {
      id: "next",
      type: "choice",
      prompt: "The form needs a start date the request doesn't give. How should the build go on?",
      options: [
        { id: "stop", label: "Stop here; I don't know it" },
        { id: "wait", label: "I'll find it and answer" },
      ],
    },
  ],
};

it.each([
  { reason: "question_unanswered", refusal: "no_question_unanswered" },
  { reason: "owner_declined", refusal: "owner_not_declined" },
  { reason: "owner_ended", refusal: "owner_not_ended" },
] as const)(
  "refuses $reason with nothing on record, then ends with it once its basis is recorded",
  async ({ reason, refusal }) => {
    const explanation = "The owner's answer is needed to choose the report, so this build stops.";
    const f = await fixture(
      (_request, index) =>
        [
          call("report_blocked", { reason, explanation }, "before"),
          reason === "question_unanswered"
            ? call("request_input", ask("Which report?"))
            : reason === "owner_ended"
              ? call("request_input", stopChoice)
              : call("request_input", {
                  questions: [
                    {
                      id: "proceed",
                      type: "confirm",
                      prompt: "May the tool do this?",
                    },
                  ],
                }),
          call("report_blocked", { reason, explanation }, "after"),
        ][index] ?? prose("Stopping."),
      reason === "owner_declined"
        ? {
            askInput: () =>
              Effect.succeed({
                proceed: { type: "confirm", value: { confirmed: false } },
              }),
          }
        : reason === "owner_ended"
          ? {
              askInput: () =>
                Effect.succeed({ next: { type: "choice", value: "stop" } }),
            }
          : {},
    );
    const outcome = await f.run();
    expect(JSON.stringify(f.requests[1]?.input)).toContain(refusal);
    expect(outcome).toMatchObject({
      build: "incomplete",
      blocked: { reason, explanation },
      stopReason: reason,
    });
  },
);

// A site that offers the task but declines the example's own facts ends under its own reason, with
// the site's reason in the explanation its caller reads, not as a site that lacks the capability.
it("ends a build the site declined for the example's own facts as site_declined", async () => {
  const explanation =
    "The site declined to quote this example applicant because it says they already hold a policy.";
  const f = await fixture(
    (_request, index) =>
      [call("report_blocked", { reason: "site_declined", explanation })][index] ??
      prose("Stopping."),
  );
  expect(await f.run()).toMatchObject({
    build: "incomplete",
    blocked: { reason: "site_declined", explanation },
    stopReason: "site_declined",
  });
});

// A site that is temporarily down for the failing input ends under its own reason, so a host can
// tell its caller to try again later instead of reading it as a site that lacks the capability.
it("ends a build whose site is temporarily down as site_unavailable", async () => {
  const explanation =
    "The site is showing its own maintenance page instead of the search, so nothing can be checked until it is back.";
  const f = await fixture(
    (_request, index) =>
      [call("report_blocked", { reason: "site_unavailable", explanation })][index] ??
      prose("Stopping."),
  );
  expect(await f.run()).toMatchObject({
    build: "incomplete",
    blocked: { reason: "site_unavailable", explanation },
    stopReason: "site_unavailable",
  });
  // The model is offered the reason, with what it covers.
  const offered = JSON.stringify(
    f.requests[0]?.tools.find((tool) => "name" in tool && tool.name === "report_blocked"),
  );
  expect(offered).toContain("site_unavailable when the site is temporarily down for the failing input");
  expect(offered).toContain("never a 5xx answer only to the request the tool made");
  expect(f.requests).toHaveLength(1);
});

/** A request that orders a stop on contradictory facts, with the fact it names in its input. */
const stopOnConflict = {
  intent:
    "Create the order from the record. If the record's facts contradict each other or their cited source, stop before creating anything.",
  businessInput: {
    record: { order: { deliveryDate: "2026-01-02", sourceExcerpt: "2019-05-14" } },
  },
};
const conflictExplanation =
  "The record's delivery date differs from the excerpt it cites. Correct the date in the record and build again.";

// The caller's own request stops the build: its facts conflict and it orders a stop. That ends
// under its own reason, never as a site that lacks the capability.
it("ends a build its caller's own request stops as caller_input, citing the field", async () => {
  const f = await fixture(
    (_request, index) =>
      [
        call("report_blocked", {
          reason: "caller_input",
          explanation: conflictExplanation,
          intent: "The field delivery_date differs from the excerpt cited as its source.",
        }),
      ][index] ?? prose("Stopping."),
    {},
    stopOnConflict,
  );
  expect(await f.run()).toMatchObject({
    build: "incomplete",
    blocked: { reason: "caller_input", explanation: conflictExplanation },
    stopReason: "caller_input",
  });
  expect(f.requests).toHaveLength(1);
});

it("refuses caller_input whose intent cites nothing in the request, then takes a quoted instruction", async () => {
  const f = await fixture(
    (_request, index) =>
      [
        call(
          "report_blocked",
          {
            reason: "caller_input",
            explanation: conflictExplanation,
            intent: "The data looks inconsistent, so the build stops.",
          },
          "uncited",
        ),
        call(
          "report_blocked",
          {
            reason: "caller_input",
            explanation: conflictExplanation,
            intent:
              "The request says that if the record's facts contradict their cited source, stop before creating anything.",
          },
          "quoted",
        ),
      ][index] ?? prose("Stopping."),
    {},
    stopOnConflict,
  );
  const outcome = await f.run();
  expect(JSON.stringify(f.requests[1]?.input)).toContain("caller_input_not_cited");
  expect(outcome).toMatchObject({
    build: "incomplete",
    blocked: { reason: "caller_input", explanation: conflictExplanation },
    stopReason: "caller_input",
  });
});

// A real site gap keeps its own reason, with no citation, beside a request that could stop itself.
it("still ends a site gap as site_lacks_capability", async () => {
  const explanation = "The site offers no way to create this kind of order.";
  const f = await fixture(
    (_request, index) =>
      [
        call("report_blocked", {
          reason: "site_lacks_capability",
          explanation,
          intent: "The catalogue lists no product for it.",
        }),
      ][index] ?? prose("Stopping."),
    {},
    stopOnConflict,
  );
  expect(await f.run()).toMatchObject({
    build: "incomplete",
    blocked: { reason: "site_lacks_capability", explanation },
    stopReason: "site_lacks_capability",
  });
});

// Guardian's refusal stays a policy block, even when a question also went unanswered.
it("keeps a policy block that stands on a Guardian refusal", async () => {
  const explanation = "Guardian refused the only way to reach the requested page.";
  const f = await fixture(
    (_request, index) =>
      [
        call("request_input", ask("Which report?")),
        call("execute", {
          purpose: "example",
          target: "pureFiles",
          entrypoint: "src/tool.ts",
          fixtureRefs: [],
          caseFilter: [],
          maxWorkers: 1,
          timeoutSeconds: 30,
        }),
        call("report_blocked", { reason: "policy", explanation }),
      ][index] ?? prose("Stopping."),
    {
      preflight: () =>
        Effect.fail(
          new MintFailure({
            code: "ReviewDenied",
            review: {
              outcome: "deny",
              reviewId: "review_denied",
              rationale: "Not allowed.",
            },
          }),
        ),
    },
  );
  expect(await f.run()).toMatchObject({
    blocked: { reason: "policy", explanation },
    stopReason: "policy",
  });
});

const pureExample = {
  purpose: "example",
  target: "pureFiles",
  entrypoint: "src/tool.ts",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 30,
};

// Guardian's refusal of an execution often names a fix, such as removing a click or adding a site
// guard, yet any refusal let the minter end the build as a policy block, and its caller read that a
// safety review ruled the request out. Only a refusal Guardian marked final, or one from a
// reviewer that marks none, as before, lets the build end as policy.
it.each([
  { refusal: "correctable", ends: false },
  { refusal: "final", ends: true },
  { refusal: undefined, ends: true },
] as const)(
  "lets an execution refusal marked $refusal end the build as policy: $ends",
  async ({ refusal, ends }) => {
    const explanation = "Guardian refused the only way to reach the requested page.";
    const f = await fixture(
      (_request, index) =>
        [
          call("execute", pureExample),
          call("report_blocked", { reason: "policy", explanation }),
        ][index] ?? prose("Stopping."),
      {
        reviewAndExecute: () =>
          Effect.fail(
            new MintFailure({
              code: "ReviewDenied",
              review: {
                outcome: "deny",
                reviewId: "review_denied",
                rationale: "Remove the extra click before the read.",
                ...(refusal === undefined ? {} : { refusal }),
              },
            }),
          ),
      },
    );
    const outcome = await f.run();
    if (ends)
      expect(outcome).toMatchObject({
        blocked: { reason: "policy", explanation },
        stopReason: "policy",
      });
    else {
      expect(outcome).not.toHaveProperty("blocked");
      expect(JSON.stringify(f.requests[2]?.input)).toContain("policy_not_refused");
    }
    // The minter reads the refusal's kind beside Guardian's rationale.
    const rejected = JSON.stringify(f.requests[1]?.input);
    if (refusal === undefined) expect(rejected).not.toContain("refusal\\\":");
    else expect(rejected).toContain(`\\"refusal\\":\\"${refusal}\\"`);
  },
);

const finishBuild = {
  entrypoint: "src/tool.ts",
  executionId: "execution_one",
  metadata: { name: "read_public", description: "Read public data" },
  coverage: "One actual example.",
};
const hostCheckRefused = new MintFailure({
  code: "PublicationUnavailable",
  reason: "autofill_recipe_not_verified",
});
const guardianCorrection = new MintFailure({
  code: "ReviewDenied",
  review: {
    outcome: "deny",
    reason: "source_correction",
    reviewId: "review_correction",
    rationale: "Read the price from the result row.",
    findings: [],
  },
});
const publicationOutage = new MintFailure({
  code: "PublicationUnavailable",
  reason: "registry_unavailable",
});
/** Advice the host gives once: finishing again with the same login URL publishes it. */
const oneTimeLoginUrl = new MintFailure({
  code: "PublicationUnavailable",
  reason: "login_url_one_time",
});
/** Advice the host gives once: finishing again, or passing httpVersion, publishes the read. */
const httpUntested = new MintFailure({
  code: "PublicationUnavailable",
  reason: "http_implementation_untested",
});
const httpStale = new MintFailure({
  code: "PublicationUnavailable",
  reason: "http_implementation_stale",
});
/** An infrastructure gap: the example's output was not available to publish. */
const outputUnavailable = new MintFailure({
  code: "PublicationUnavailable",
  reason: "example_output_unavailable",
});

/** The result of the request's last call, as the minter reads it. */
const lastResult = (request: ModelRequest | undefined) =>
  JSON.stringify(Array.isArray(request?.input) ? request.input.at(-1) : request?.input);

// A host check that refused a step the build needs, such as publication's own sign-in check,
// left the minter only a policy block, and its caller read that a safety review ruled the request
// out. It ends as host_refused, which stands only on a refusal the host itself recorded in this
// attempt: never on Guardian's denial, an outage, an infrastructure gap or advice the host gives
// once. Each refusal is a publish's, in order; an outage holds every blocked report back until a
// review completes, so its case finishes again and Guardian's correction completes one.
it.each([
  { basis: "a host check", publish: [hostCheckRefused], ends: true },
  { basis: "Guardian", publish: [guardianCorrection], ends: false },
  { basis: "an outage", publish: [publicationOutage, guardianCorrection], ends: false },
  { basis: "one-time login URL advice", publish: [oneTimeLoginUrl], ends: false },
  { basis: "untested HTTP version advice", publish: [httpUntested], ends: false },
  { basis: "stale HTTP version advice", publish: [httpStale], ends: false },
  { basis: "an unavailable output", publish: [outputUnavailable], ends: false },
])("ends as host_refused after $basis refused publication: $ends", async ({ publish, ends }) => {
  const explanation = "Publication's sign-in check failed on a new browser, so no tool was published.";
  let published = 0;
  const f = await fixture(
    (_request, index) =>
      [
        call("report_blocked", { reason: "host_refused", explanation }, "before"),
        call("execute", pureExample),
        ...publish.map((_, n) => call("finish_build", finishBuild, `finish_${n}`)),
        call("report_blocked", { reason: "host_refused", explanation }, "after"),
      ][index] ?? prose("Stopping."),
    {
      publish: () => Effect.fail(publish[published++] ?? guardianCorrection),
      // After an unavailable output, a repeatable read may run a fresh example: the build goes on.
      repeatableRead: publish[0] === outputUnavailable,
    },
  );
  const outcome = await f.run();
  expect(lastResult(f.requests[1])).toContain("host_not_refused");
  if (ends) {
    expect(outcome).toMatchObject({
      build: "incomplete",
      blocked: { reason: "host_refused", explanation },
      stopReason: "host_refused",
    });
    expect(blockedRecord(outcome)).toMatchObject({
      hostRefusals: [
        {
          source: "publication",
          code: "PublicationUnavailable",
          reason: "autofill_recipe_not_verified",
        },
      ],
    });
  } else {
    expect(outcome).not.toHaveProperty("blocked");
    expect(lastResult(f.requests[3 + publish.length])).toContain("host_not_refused");
  }
});

/** What an accepted ending's `phase: "blocked"` diagnostic says the host refusal stood on. */
const blockedRecord = (outcome: { readonly diagnostics: readonly string[] }) =>
  outcome.diagnostics
    .flatMap((entry) => {
      try {
        return [JSON.parse(entry) as Record<string, unknown>];
      } catch {
        return [];
      }
    })
    .find((entry) => entry["phase"] === "blocked");

/** The result of the call `callId` that the minter reads in `request`, parsed. */
const resultOf = (request: ModelRequest | undefined, callId: string): unknown => {
  const item = (Array.isArray(request?.input) ? request.input : []).find(
    (entry) => entry.type === "function_call_result" && entry.callId === callId,
  ) as { readonly output?: unknown } | undefined;
  const output = item?.output;
  return JSON.parse(
    typeof output === "string"
      ? output
      : typeof output === "object" && output !== null && "text" in output
        ? String(output.text)
        : JSON.stringify(output),
  );
};
/** A host check's refusal the minter fixes in its metadata: variants a Kernel script can't run. */
const variantsUnsupported = new MintFailure({
  code: "PublicationUnavailable",
  reason: "variants_unsupported",
});
const hostRefusalPassed =
  "A host check refused a step earlier in this attempt, but a later finish_build got past it, so the build has not ended. Fix the findings the latest refusal names and call finish_build again. Use host_refused only when a host check still refuses a step and nothing left in this attempt can fix it.";
const hostRefusalNamesStep =
  "The host's last refusal, refusedReason, names a step that fixes it in its instruction or rationale, so the build has not ended. Prefer doing that step and calling finish_build again; if publication still cannot pass, you may report host_refused again.";
const hostRefusalRepeated =
  "Your last finish_build sent again, unchanged, a submission the host refused before a later finish_build got past that refusal to Guardian's review, so it is no new refusal and the build has not ended. Prefer fixing what Guardian's latest decision names, then calling finish_build again. Use host_refused only when a host check still refuses a step and nothing left in this attempt can fix it.";
/** finish_build with its own coverage, so a submission after a denial is not the same again. */
const finishAs = (n: number) =>
  call(
    "finish_build",
    { ...finishBuild, coverage: `One actual example, round ${n}.` },
    `finish_${n}`,
  );

// A host check's refusal the minter fixed no longer stands once a later finish_build gets past
// the host's checks to Guardian's review. Guardian's correction is then what stops the build, and
// the minter can still fix it, so host_refused is refused and the build goes on to publish.
it("refuses host_refused once a later finish_build got past the host's refusal to Guardian", async () => {
  const explanation = "A OpenGPT check refused publication, so no tool was published.";
  const refusals = [variantsUnsupported, guardianCorrection];
  let published = 0;
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", pureExample),
        finishAs(0),
        finishAs(1),
        call("report_blocked", { reason: "host_refused", explanation }, "report"),
        finishAs(2),
      ][index] ?? prose("Stopping."),
    {
      publish: () => {
        const refusal = refusals[published++];
        return refusal === undefined
          ? Effect.succeed({ publicationRef: "published_revision", diagnostics: [] })
          : Effect.fail(refusal);
      },
    },
  );
  const outcome = await f.run();
  expect(outcome).not.toHaveProperty("blocked");
  expect(outcome).toMatchObject({ build: "published" });
  expect(published).toBe(3);
  expect(resultOf(f.requests[2], "finish_0")).toMatchObject({ reason: "variants_unsupported" });
  expect(resultOf(f.requests[3], "finish_1")).toMatchObject({ code: "ReviewDenied" });
  expect(resultOf(f.requests[4], "report")).toEqual({
    status: "blocked_refused",
    reason: "host_refusal_passed",
    userInputRequired: false,
    instruction: hostRefusalPassed,
  });
});

/** A host check's refusal that carries a review of its own, as a host may attach to one. */
const reviewedHostRefusal = new MintFailure({
  code: "PublicationUnavailable",
  reason: "autofill_recipe_not_verified",
  review: { outcome: "deny", rationale: "Fresh sign-in failure." },
});

// A host check's refusal that is the latest publication decision still stands, after Guardian's
// correction and after an earlier refusal a later finish_build got past alike. One that carries a
// review is still the host's refusal, not a finish_build that got past the host's checks.
it.each([
  { basis: "after Guardian's correction", publish: [guardianCorrection, hostCheckRefused] },
  {
    basis: "again after a finish_build got past the first",
    publish: [variantsUnsupported, guardianCorrection, hostCheckRefused],
  },
  { basis: "with a review of its own", publish: [reviewedHostRefusal] },
  {
    basis: "with a review of its own after a finish_build got past the first",
    publish: [variantsUnsupported, guardianCorrection, reviewedHostRefusal],
  },
])(
  "ends as host_refused when a host check refused the latest publication $basis",
  async ({ publish }) => {
    const explanation = "A OpenGPT check refused publication, so no tool was published.";
    let published = 0;
    const f = await fixture(
      (_request, index) =>
        [
          call("execute", pureExample),
          ...publish.map((_, n) => finishAs(n)),
          call("report_blocked", { reason: "host_refused", explanation }),
        ][index] ?? prose("Stopping."),
      { publish: () => Effect.fail(publish[published++] ?? guardianCorrection) },
    );
    expect(await f.run()).toMatchObject({
      build: "incomplete",
      blocked: { reason: "host_refused", explanation },
      stopReason: "host_refused",
    });
    expect(published).toBe(publish.length);
  },
);

/** A host's own publication refusal, by reason, as a host that names more reasons than core sends it. */
const publicationRefused = (reason: string) =>
  new MintFailure({
    code: "PublicationUnavailable",
    reason: reason as NonNullable<MintFailure["reason"]>,
  });

/** A host's own refusal whose step the host names in its review rationale, as core has no text for it. */
const noMatchRationale =
  "Run one live case whose input matches nothing, expecting empty, then call finish_build again with the same executionId.";
const noMatchUntested = new MintFailure({
  code: "PublicationUnavailable",
  reason: "no_match_case_untested" as NonNullable<MintFailure["reason"]>,
  review: { outcome: "deny", rationale: noMatchRationale },
});

// A host refusal whose instruction or rationale names the step that fixes it is no reason the
// build cannot go on: the first host_refused report after it is refused with that step, and a
// second is accepted, so a minter that still cannot get past it can stop. Core's own refusal
// carries the step in its instruction; a host's refusal core has no text for carries it in its
// rationale, and the generic instruction core gives it is not repeated.
it.each([
  {
    refusal: variantsUnsupported,
    step: {
      refusalInstruction: expect.stringContaining(
        "Either remove supportedVariants from the tool's metadata",
      ),
    },
    absent: "refusalRationale",
  },
  {
    refusal: noMatchUntested,
    step: { refusalRationale: noMatchRationale },
    absent: "refusalInstruction",
  },
])(
  "refuses the first host_refused after $refusal.reason, which names its fix, and accepts a second",
  async ({ refusal, step, absent }) => {
    const explanation = "A OpenGPT check refused publication, so no tool was published.";
    const f = await fixture(
      (_request, index) =>
        [
          call("execute", pureExample),
          finishAs(0),
          call("report_blocked", { reason: "host_refused", explanation }, "first"),
          call("report_blocked", { reason: "host_refused", explanation }, "second"),
        ][index] ?? prose("Stopping."),
      { publish: () => Effect.fail(refusal) },
    );
    const outcome = await f.run();
    const first = resultOf(f.requests[3], "first");
    expect(first).toEqual({
      status: "blocked_refused",
      reason: "host_refusal_names_step",
      refusedReason: refusal.reason,
      ...step,
      userInputRequired: false,
      instruction: hostRefusalNamesStep,
    });
    expect(first).not.toHaveProperty(absent);
    expect(outcome).toMatchObject({
      build: "incomplete",
      blocked: { reason: "host_refused", explanation },
      stopReason: "host_refused",
    });
    expect(blockedRecord(outcome)).toMatchObject({
      hostRefusals: [{ source: "publication", reason: refusal.reason }],
    });
  },
);

// A host's refusal core has no text for names no step unless it carries a rationale: the report
// is taken at once, as before.
it.each([
  { refusal: "no_match_case_untested" },
  { refusal: "source_changed_since_example" },
])("takes host_refused at once after $refusal with no rationale", async ({ refusal }) => {
  const explanation = "A OpenGPT check refused publication, so no tool was published.";
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", pureExample),
        finishAs(0),
        call("report_blocked", { reason: "host_refused", explanation }, "report"),
      ][index] ?? prose("Stopping."),
    { publish: () => Effect.fail(publicationRefused(refusal)) },
  );
  expect(await f.run()).toMatchObject({ blocked: { reason: "host_refused", explanation } });
});

// A sign-in screen the host refused because the password's fills are spent stands beside a refusal
// that names its step, so the report is taken at once.
it("takes host_refused at once when a refused password refill stands beside a named step", async () => {
  const explanation = "A OpenGPT check refused publication, so no tool was published.";
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", pureExample),
        finishAs(0),
        call("report_blocked", { reason: "host_refused", explanation }, "report"),
      ][index] ?? prose("Stopping."),
    { publish: () => Effect.fail(variantsUnsupported), signInRefillRefused: () => true },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({ blocked: { reason: "host_refused", explanation } });
  expect(blockedRecord(outcome)).toMatchObject({
    hostRefusals: [
      { source: "publication", reason: "variants_unsupported" },
      { source: "sign_in_refill" },
    ],
  });
});

// The step a refusal names is offered once per reason: after it, the same refusal again, as when
// the minter took the step and the host still refused, takes the report at once.
it("takes host_refused at once when a refusal whose step was offered refuses again", async () => {
  const explanation = "A OpenGPT check refused publication, so no tool was published.";
  let published = 0;
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", pureExample),
        finishAs(0),
        call("report_blocked", { reason: "host_refused", explanation }, "first"),
        finishAs(1),
        call("report_blocked", { reason: "host_refused", explanation }, "second"),
      ][index] ?? prose("Stopping."),
    {
      publish: () => {
        published++;
        return Effect.fail(variantsUnsupported);
      },
    },
  );
  const outcome = await f.run();
  expect(published).toBe(2);
  expect(resultOf(f.requests[3], "first")).toMatchObject({ reason: "host_refusal_names_step" });
  expect(outcome).toMatchObject({ blocked: { reason: "host_refused" } });
});

// A refusal whose step is not the latest host refusal gets no extra round: a host check that
// refused later, with no step of its own, stands as before.
it("takes host_refused at once when a refusal with no named step is the latest", async () => {
  const explanation = "A OpenGPT check refused publication, so no tool was published.";
  const refusals = [variantsUnsupported, hostCheckRefused];
  let published = 0;
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", pureExample),
        finishAs(0),
        finishAs(1),
        call("report_blocked", { reason: "host_refused", explanation }, "report"),
      ][index] ?? prose("Stopping."),
    { publish: () => Effect.fail(refusals[published++] ?? hostCheckRefused) },
  );
  expect(await f.run()).toMatchObject({ blocked: { reason: "host_refused", explanation } });
});

// A host refusal the minter brings about by sending a submission the host already refused, with
// nothing changed, after a later finish_build got past that refusal to Guardian, is the same
// refusal again, not a new one: it gives host_refused no basis, so the build goes on from
// Guardian's decision and publishes once the minter fixes it.
it("grants no host_refused basis to a host refusal of a submission repeated unchanged", async () => {
  const explanation = "A OpenGPT check refused publication, so no tool was published.";
  const refusals = [hostCheckRefused, guardianCorrection, hostCheckRefused];
  let published = 0;
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", pureExample),
        finishAs(0),
        finishAs(1),
        call("report_blocked", { reason: "host_refused", explanation }, "passed"),
        call(
          "finish_build",
          { ...finishBuild, coverage: "One actual example, round 0." },
          "repeat",
        ),
        call("report_blocked", { reason: "host_refused", explanation }, "repeated"),
        finishAs(2),
      ][index] ?? prose("Stopping."),
    {
      publish: () => {
        const refusal = refusals[published++];
        return refusal === undefined
          ? Effect.succeed({ publicationRef: "published_revision", diagnostics: [] })
          : Effect.fail(refusal);
      },
    },
  );
  const outcome = await f.run();
  expect(published).toBe(4);
  expect(resultOf(f.requests[4], "passed")).toMatchObject({ reason: "host_refusal_passed" });
  expect(resultOf(f.requests[5], "repeat")).toMatchObject({
    reason: "autofill_recipe_not_verified",
  });
  expect(resultOf(f.requests[6], "repeated")).toEqual({
    status: "blocked_refused",
    reason: "host_refusal_repeated",
    userInputRequired: false,
    instruction: hostRefusalRepeated,
  });
  expect(outcome).not.toHaveProperty("blocked");
  expect(outcome).toMatchObject({ build: "published" });
});

// What the latest finish_build did decides: once a later finish_build is refused before
// publication, the repeat is no longer the last one, and the report is refused as for any host
// refusal a finish_build got past.
it("refuses host_refused as passed once a finish_build follows the repeated submission", async () => {
  const explanation = "A OpenGPT check refused publication, so no tool was published.";
  const refusals = [hostCheckRefused, guardianCorrection, hostCheckRefused];
  let published = 0;
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", pureExample),
        finishAs(0),
        finishAs(1),
        call("finish_build", { ...finishBuild, coverage: "One actual example, round 0." }, "repeat"),
        call("finish_build", { ...finishBuild, coverage: "One actual example, round 1." }, "denied"),
        call("report_blocked", { reason: "host_refused", explanation }, "report"),
      ][index] ?? prose("Stopping."),
    { publish: () => Effect.fail(refusals[published++] ?? hostCheckRefused) },
  );
  const outcome = await f.run();
  expect(published).toBe(3);
  expect(resultOf(f.requests[5], "denied")).toMatchObject({ reason: "unchanged_since_denial" });
  expect(resultOf(f.requests[6], "report")).toMatchObject({ reason: "host_refusal_passed" });
  expect(outcome).not.toHaveProperty("blocked");
});

// The same host refusal of a changed submission is a new refusal, and host_refused stands on it.
it("keeps a host_refused basis on a host refusal of a changed submission", async () => {
  const explanation = "A OpenGPT check refused publication, so no tool was published.";
  const refusals = [hostCheckRefused, guardianCorrection, hostCheckRefused];
  let published = 0;
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", pureExample),
        finishAs(0),
        finishAs(1),
        finishAs(2),
        call("report_blocked", { reason: "host_refused", explanation }, "report"),
      ][index] ?? prose("Stopping."),
    { publish: () => Effect.fail(refusals[published++] ?? hostCheckRefused) },
  );
  expect(await f.run()).toMatchObject({ blocked: { reason: "host_refused", explanation } });
});

const moveSite = [
  call("request_input", {
    questions: [{ id: "move", type: "confirm", prompt: "May the build move to the sister site?" }],
  }),
  call(
    "mint_update",
    {
      summary: "Build on the sister site.",
      changes: [{ setting: "site", origin: "https://other.example.test" }],
      confirmedBy: ["move"],
      recommend: "update",
      intent: "The owner confirmed the task lives on the sister site.",
    },
    "update",
  ),
];

const signIn = call("execute", { ...pureExample, purpose: "authenticate", target: "liveBrowser" });
/** A sign-in the host refused to type into: the login would go where credentials may not. */
const credentialTargetRefused = new MintFailure({
  code: "Unavailable",
  authentication: { phase: "credential_submit", code: "CredentialTargetRefused" },
});
/** The minter gives up the refused sign-in, so its blocked ending is no longer held back. */
const giveUpSignIn = call("abandon_sign_in", { intent: "The host refused the sign-in form." });

// The host's refusal of a sign-in or of a task update is on record too, and a policy report that
// stands only on a host refusal is refused with the way to host_refused.
it.each([
  {
    basis: "a sign-in",
    steps: [signIn, giveUpSignIn],
    record: { source: "sign_in_step", code: "CredentialTargetRefused" },
  },
  {
    basis: "a site change",
    steps: moveSite,
    record: { source: "task_update", reason: "change_unsupported" },
  },
])("ends as host_refused after the host refused $basis", async ({ steps, record }) => {
  const explanation = "A OpenGPT check refused the step this build needs.";
  const f = await fixture(
    (_request, index) =>
      [
        ...steps,
        call("report_blocked", { reason: "policy", explanation }, "policy"),
        call("report_blocked", { reason: "host_refused", explanation }, "host"),
      ][index] ?? prose("Stopping."),
    {
      reviewAndExecute: () => Effect.fail(credentialTargetRefused),
      abandonSignIn: () => Effect.succeed({ outcome: "abandoned" as const }),
      askInput: () => Effect.succeed({ move: { type: "confirm", value: { confirmed: true } } }),
      reviewTaskUpdate: () =>
        Effect.succeed({ outcome: "allow" as const, rationale: "Same task.", reviewId: "r1" }),
      applyTaskUpdate: () =>
        Effect.succeed({
          outcome: "refused" as const,
          reason: "change_unsupported",
          notice: "This build cannot move to that site.",
        }),
    },
    { siteOrigin: "https://shop.example.test" },
  );
  const outcome = await f.run();
  const policy = JSON.stringify(f.requests[steps.length + 1]?.input);
  expect(policy).toContain("policy_not_refused");
  expect(policy).toContain("Use host_refused");
  expect(outcome).toMatchObject({
    blocked: { reason: "host_refused", explanation },
    stopReason: "host_refused",
  });
  expect(blockedRecord(outcome)).toMatchObject({ hostRefusals: [record] });
});

// A refusal of the minter's own request is no host check refusing a step the build needs: the
// minter fixes the request. An authenticate the host's preflight refused, as for a wrong target or
// a missing sign-in step, grants no host_refused ending.
it("grants no host_refused ending for an authenticate the preflight refused", async () => {
  const explanation = "A OpenGPT check refused the step this build needs.";
  const f = await fixture(
    (_request, index) =>
      [signIn, call("report_blocked", { reason: "host_refused", explanation })][index] ??
      prose("Stopping."),
    {
      preflight: (submitted) =>
        Effect.succeed(
          submitted.purpose === "authenticate"
            ? { supported: false as const, reason: "The sign-in names no signInStep." }
            : { supported: true as const },
        ),
    },
    { siteOrigin: "https://shop.example.test" },
  );
  const outcome = await f.run();
  expect(outcome).not.toHaveProperty("blocked");
  expect(lastResult(f.requests[2])).toContain("host_not_refused");
});

const makeWrite = call(
  "mint_update",
  {
    summary: "Make the build a write.",
    changes: [{ setting: "effect", effect: "write" }],
    confirmedBy: ["move"],
    recommend: "update",
    intent: "The owner confirmed the task writes.",
  },
  "update",
);

/** The host refused to type a field of the sign-in screen, by its `check`. */
const autofillRefused = (check: string) =>
  autofillRefusalFailure(
    { check, field: 0, slot: "password", screen: { fields: ["#password"], submit: "#sign-in" } },
    { nothingSubmitted: true },
  );

// A sign-in the host refused because the login would go where credentials may not is a host check
// refusing a step the build needs. A selector the fill could not use, such as a field it did not
// find or one that matched twice, is the minter's to correct: it grants no host_refused ending.
it.each([
  {
    basis: "an unverified destination",
    failure: new MintFailure({
      code: "Unavailable",
      authentication: { phase: "credential_submit", code: "CredentialTargetUnverified" },
    }),
    ends: true,
  },
  { basis: "the fill's destination check", failure: autofillRefused("destination"), ends: true },
  { basis: "a field it did not find", failure: autofillRefused("not_found"), ends: false },
  {
    basis: "a selector that matched twice",
    failure: autofillRefused("ambiguous_match"),
    ends: false,
  },
])("ends as host_refused after a sign-in refused for $basis: $ends", async ({ failure, ends }) => {
  const explanation = "A OpenGPT check refused the sign-in this build needs.";
  const f = await fixture(
    (_request, index) =>
      [signIn, giveUpSignIn, call("report_blocked", { reason: "host_refused", explanation })][
        index
      ] ?? prose("Stopping."),
    {
      reviewAndExecute: () => Effect.fail(failure),
      abandonSignIn: () => Effect.succeed({ outcome: "abandoned" as const }),
    },
    { siteOrigin: "https://shop.example.test" },
  );
  const outcome = await f.run();
  expect(JSON.stringify(f.requests[2]?.input)).toContain("sign_in_abandoned");
  if (ends)
    expect(outcome).toMatchObject({
      blocked: { reason: "host_refused", explanation },
      stopReason: "host_refused",
    });
  else {
    expect(outcome).not.toHaveProperty("blocked");
    expect(lastResult(f.requests[3])).toContain("host_not_refused");
  }
});

// The harness's own refusal of a task update, such as a site change in a build with no site or a
// write build made a write again, refuses the minter's request, which it can fix. Only a change
// the host refused to apply is a host check refusing a step: these grant no host_refused ending.
it.each([
  { refusal: "offline_build", steps: moveSite, request: {} },
  {
    refusal: "already_write",
    steps: [moveSite[0], makeWrite],
    request: { effect: "write", siteOrigin: "https://shop.example.test" },
  },
] as const)(
  "grants no host_refused ending for an update the harness refused as $refusal",
  async ({ refusal, steps, request }) => {
    const explanation = "A OpenGPT check refused the step this build needs.";
    const f = await fixture(
      (_request, index) =>
        [...steps, call("report_blocked", { reason: "host_refused", explanation })][index] ??
        prose("Stopping."),
      {
        askInput: () => Effect.succeed({ move: { type: "confirm", value: { confirmed: true } } }),
        reviewTaskUpdate: () =>
          Effect.succeed({ outcome: "allow" as const, rationale: "Same task.", reviewId: "r1" }),
        applyTaskUpdate: () =>
          Effect.succeed({
            outcome: "refused" as const,
            reason: "change_unsupported",
            notice: "This build cannot take that change.",
          }),
      },
      request,
    );
    const outcome = await f.run();
    expect(JSON.stringify(f.requests[2]?.input)).toContain(`\\"reason\\":\\"${refusal}\\"`);
    expect(outcome).not.toHaveProperty("blocked");
    expect(lastResult(f.requests[3])).toContain("host_not_refused");
  },
);

// A minter that stops answering with tools says why in its last answer. Its caller reads that
// answer only after the pipeline a blocked explanation takes: host-private values removed and
// Guardian's review of a blocked outcome allowing it.
it("ends three tool-free answers as final_text_without_tool, with the reviewed last answer", async () => {
  const reviewed: unknown[] = [];
  const f = await fixture(
    (_request, index) =>
      index < 2
        ? prose("Still looking.")
        : prose("The site lists no prices for account acct-7731 without a membership."),
    {
      redactCallerText: (text) => text.replaceAll("acct-7731", "[account]"),
      reviewQuestion: (candidate, context) =>
        Effect.sync(() => {
          reviewed.push({ candidate, blockedOutcome: context?.blockedOutcome });
          return { outcome: "allow_business" as const, rationale: "Plain." };
        }),
    },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({
    build: "incomplete",
    stopReason: "final_text_without_tool",
    stopExplanation: "The site lists no prices for account [account] without a membership.",
  });
  expect(JSON.stringify(reviewed)).not.toContain("acct-7731");
  expect(reviewed).toEqual([expect.objectContaining({ blockedOutcome: true })]);
});

it("keeps no last answer Guardian did not allow", async () => {
  const f = await fixture(() => prose("Call 555-0100 to finish this request."), {
    reviewQuestion: () =>
      Effect.succeed({
        outcome: "reword" as const,
        rationale: "It passes on a phone number.",
      }),
  });
  const outcome = await f.run();
  expect(outcome.stopReason).toBe("final_text_without_tool");
  expect(outcome).not.toHaveProperty("stopExplanation");
  expect(JSON.stringify(outcome)).not.toContain("555-0100");
});

it("ends an attempt that spent its model calls as turn_budget_spent", async () => {
  const f = await fixture(
    () => call("read_source", { path: "src/tool.ts", offset: null, limit: null }),
    {},
    {},
    { modelCallCapacity: 4, segmentTurns: 2 },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({
    build: "incomplete",
    stopReason: "turn_budget_spent",
  });
  expect(outcome).not.toHaveProperty("hostFailure");
});

it("names a published build's ending with no stop reason", async () => {
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", {
          purpose: "example",
          target: "pureFiles",
          entrypoint: "src/tool.ts",
          fixtureRefs: [],
          caseFilter: [],
          maxWorkers: 1,
          timeoutSeconds: 30,
        }),
        call("finish_build", {
          entrypoint: "src/tool.ts",
          executionId: "execution_one",
          metadata: { name: "read_public", description: "Read public data" },
          coverage: "One actual example.",
        }),
      ][index] ?? prose(),
  );
  const outcome = await f.run();
  expect(outcome.build).toBe("published");
  expect(outcome).not.toHaveProperty("stopReason");
});

// Guardian's public reason for a denial reaches the caller screened like their other text, and the
// private rationale never does.
it("carries Guardian's screened public reason on a publication denial", async () => {
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", {
          purpose: "example",
          target: "pureFiles",
          entrypoint: "src/tool.ts",
          fixtureRefs: [],
          caseFilter: [],
          maxWorkers: 1,
          timeoutSeconds: 30,
        }),
        call("finish_build", {
          entrypoint: "src/tool.ts",
          executionId: "execution_one",
          metadata: { name: "read_public", description: "Read public data" },
          coverage: "One actual example.",
        }),
      ][index] ?? prose("Stopping."),
    {
      redactCallerText: (text) => text.replaceAll("acct-7731", "[account]"),
      publish: () =>
        Effect.fail(
          new MintFailure({
            code: "ReviewDenied",
            review: {
              outcome: "deny",
              reason: "privacy",
              reviewId: "review_denied",
              rationale: "Private rationale: src/tool.ts hard-codes a member number.",
              findings: [],
              publicReason: "The tool for acct-7731 would have published private details.",
            },
          }),
        ),
    },
  );
  const outcome = await f.run();
  expect(outcome.publicationDenial).toEqual({
    reason: "privacy",
    publicReason: "The tool for [account] would have published private details.",
  });
  // What a caller reads; the host's own diagnostics keep the review as it came.
  expect(JSON.stringify([outcome.summary, outcome.publicationDenial])).not.toContain(
    "Private rationale",
  );
});

const authenticate = {
  purpose: "authenticate",
  target: "liveBrowser",
  entrypoint: "src/tool.ts",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 30,
};

const accountLocked = new MintFailure({
  code: "Unavailable",
  authentication: {
    phase: "credential_submit",
    code: "AccountLocked",
    afterSubmission: true,
  },
});

// The site said the account is locked: no retry or correction gets past it, so the build ends at
// once, typed, with words its owner can act on and no operator code.
it("ends a sign-in the site refused for its account as account_locked", async () => {
  const f = await fixture(
    (_request, index) =>
      index === 0 ? call("execute", authenticate) : prose("The account is locked."),
    { reviewAndExecute: () => Effect.fail(accountLocked) },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({
    build: "incomplete",
    recoveryReason: "sign_in_unavailable",
    stopReason: "account_locked",
  });
  expect(outcome.summary).toContain("locked, suspended or disabled");
  expect(outcome.summary).not.toMatch(/AccountLocked|credential_submit|receipts/u);
  // The build ends with the failed sign-in itself, with no further model call.
  expect(f.requests).toHaveLength(1);
});

// A sign-in that failed for good while an earlier receipt might still publish used to leave the
// minter no ending: report_blocked was refused as an unresolved sign-in. It now ends the build
// with the sign-in's own result.
it("lets the minter end the build once sign-in is unavailable and a receipt was held back", async () => {
  let executions = 0;
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", {
          purpose: "example",
          target: "pureFiles",
          entrypoint: "src/tool.ts",
          fixtureRefs: [],
          caseFilter: [],
          maxWorkers: 1,
          timeoutSeconds: 30,
        }),
        call("execute", authenticate, "sign_in"),
        call("report_blocked", {
          reason: "site_lacks_capability",
          explanation: "The account page cannot be reached without signing in.",
        }),
      ][index] ?? prose("Stopping."),
    {
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
          : Effect.fail(accountLocked),
    },
  );
  const outcome = await f.run();
  // report_blocked ended the build at once: no refusal went back for another model call.
  expect(f.requests).toHaveLength(3);
  expect(outcome).toMatchObject({
    build: "incomplete",
    recoveryReason: "sign_in_unavailable",
    stopReason: "account_locked",
  });
  expect(outcome).not.toHaveProperty("blocked");
});

// The owner's summary of a failed sign-in is plain words: never the root cause's code or phase.
it("words a failed sign-in's summary without operator codes", async () => {
  const f = await fixture(
    (_request, index) => (index === 0 ? call("execute", authenticate) : prose("Stopping.")),
    {
      reviewAndExecute: () =>
        Effect.fail(
          new MintFailure({
            code: "Unavailable",
            authentication: {
              phase: "credential_submit",
              code: "AuthenticationFailed",
              afterSubmission: true,
            },
            spentSignIn: "relogin_spent",
          }),
        ),
    },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({
    recoveryReason: "sign_in_unavailable",
    stopReason: "sign_in_failed",
  });
  expect(outcome.summary).toContain("could not be signed in");
  expect(outcome.summary).not.toMatch(/AuthenticationFailed|credential_submit|receipts/u);
});

/** A sign-in screen the host filled and submitted: it may have sent the login, and proves nothing. */
const submittedScreen = {
  executionId: "sign_in_screen",
  status: "completed" as const,
  effect: "possible" as const,
  resultRef: "screen_result",
  observations: { step: { outcome: "filled", submit: "clicked" } },
};
/** The host's own check after the sign-in: signed in, or not. */
const signInCheck = (state: "authenticated" | "failed") => ({
  executionId: `sign_in_check_${state}`,
  status: "completed" as const,
  effect: "not_sent" as const,
  resultRef: "check_result",
  authentication: { state, effect: "verified" as const },
  observations: { signedIn: state === "authenticated" },
});
const declinedExample = {
  reason: "site_declined",
  explanation: "The site kept showing its sign-in screen, so it declined this example.",
};

/**
 * A build that signs in through `steps`, one authenticate each, then sends `report`. A step that is
 * a failure fails its authenticate before its dispatch fence, and `{ afterFence }` fails it past
 * the fence.
 */
const signInThenDecline = (
  steps: readonly (object | MintFailure)[],
  overrides: Parameters<typeof fixture>[1] = {},
  report: { readonly reason: string; readonly explanation: string } = declinedExample,
) => {
  let executions = 0;
  return fixture(
    (_request, index) =>
      [
        ...steps.map((_, step) => call("execute", authenticate, `sign_in_${step}`)),
        call("report_blocked", report),
      ][index] ?? prose("Stopping."),
    {
      reviewAndExecute: (_submitted, beforeDispatch = () => Effect.void) => {
        const step = steps[executions++] ?? submittedScreen;
        if (step instanceof MintFailure) return Effect.fail(step);
        const dispatched = beforeDispatch({ reviewId: "review_sign_in", action: "authentication" });
        return "afterFence" in step && step.afterFence instanceof MintFailure
          ? Effect.zipRight(dispatched, Effect.fail(step.afterFence))
          : dispatched.pipe(Effect.as(step as typeof submittedScreen));
      },
      ...overrides,
    },
  );
};

// The site accepted the login, but the page load after it showed the sign-in form again: every
// step reported filled and clicked, and nothing confirmed the sign-in. That is no site declining
// the example, so the build ends as sign-in unavailable, in core's session_not_kept words, and
// its caller is never told to change the request.
it("ends a site_declined report as sign-in unavailable while the site did not keep the session", async () => {
  const f = await signInThenDecline([submittedScreen, signInCheck("failed")], {
    signInSessionLoss: () => "session_not_kept",
  });
  const outcome = await f.run();
  expect(outcome).not.toHaveProperty("blocked");
  expect(outcome).toMatchObject({
    build: "incomplete",
    recoveryReason: "sign_in_unavailable",
    stopReason: "sign_in_failed",
  });
  expect(outcome.summary).toContain(
    "accepted the login each time, but the signed-in session did not survive the page load",
  );
  // The report ended the build at once, with no further model call.
  expect(f.requests).toHaveLength(3);
});

/** The minter's rejection report the host answered with no rejection marker it saw. */
const rejectionUnconfirmed = {
  executionId: "rejected_report",
  status: "completed" as const,
  effect: "not_sent" as const,
  resultRef: "rejected_result",
  authentication: { state: "failed" as const, effect: "verified" as const },
  observations: { rejected: false, reason: "no_rejection_marker" },
};

// A login the site refused, whose message was gone before the host's rejection check: the host
// reported no rejection marker and an unconfirmed sign-in. site_declined still ends as sign-in
// unavailable, in the plain words a failed sign-in gets, since the host saw no accepted login.
it("ends a site_declined report as sign-in unavailable after a sign-in that never confirmed", async () => {
  const f = await signInThenDecline([submittedScreen, rejectionUnconfirmed]);
  const outcome = await f.run();
  expect(outcome).not.toHaveProperty("blocked");
  expect(outcome).toMatchObject({
    recoveryReason: "sign_in_unavailable",
    stopReason: "sign_in_failed",
  });
  expect(outcome.summary).toContain("could not be signed in");
  expect(outcome.summary).not.toContain("did not survive");
});

// Every ending that tells the caller to change the request, or that the site or a check ruled it
// out, is no truer than site_declined while the sign-in never confirmed. A Guardian refusal of an
// earlier sign-in step, as of a field label, made a policy block possible; it ended the build that
// way after a refused login whose message had gone.
const refusedLabel = new MintFailure({
  code: "ReviewDenied",
  review: { outcome: "deny", reviewId: "review_label", rationale: "Wrong field label." },
});
const refusedForm = autofillRefused("destination");
it.each([
  { reason: "site_lacks_capability", first: [] },
  { reason: "policy", first: [refusedLabel] },
] as const)(
  "ends a $reason report as sign-in unavailable while the sign-in never confirmed",
  async ({ reason, first }) => {
    const f = await signInThenDecline([...first, submittedScreen, rejectionUnconfirmed], {}, {
      reason,
      explanation: "The site's sign-in kept refusing, so this build cannot go on.",
    });
    const outcome = await f.run();
    expect(outcome).not.toHaveProperty("blocked");
    expect(outcome).toMatchObject({
      recoveryReason: "sign_in_unavailable",
      stopReason: "sign_in_failed",
    });
  },
);

/** What an accepted or rewritten ending's `phase: "blocked"` diagnostic records. */
const blockedDiagnostic = (outcome: { readonly diagnostics: readonly string[] }) =>
  outcome.diagnostics
    .flatMap((entry) => {
      try {
        return [JSON.parse(entry) as Record<string, unknown>];
      } catch {
        return [];
      }
    })
    .find((entry) => entry["phase"] === "blocked");

// A host refusal before the login went out is no longer the latest sign-in event: the host
// refused a sign-in form, then a later screen sent the login and nothing confirmed it. The report
// ends as sign-in unavailable, and its record still names the check that refused the form.
it("ends a host_refused report on a form refused before the login went out as sign-in unavailable", async () => {
  const f = await signInThenDecline([refusedForm, submittedScreen, rejectionUnconfirmed], {}, {
    reason: "host_refused",
    explanation: "The host would not type the login into the site's form.",
  });
  const outcome = await f.run();
  expect(outcome).not.toHaveProperty("blocked");
  expect(outcome).toMatchObject({ recoveryReason: "sign_in_unavailable", stopReason: "sign_in_failed" });
  expect(blockedDiagnostic(outcome)).toMatchObject({
    reason: "sign_in_unavailable",
    reported: "host_refused",
    hostRefusals: [{ source: "sign_in_step", code: "AutofillRefused", check: "destination" }],
  });
});

/**
 * A build that, as asked, first has the host refuse a site change and Guardian deny a publication
 * that passed the host's checks (`before`), then signs in through `steps`, each an authenticate's
 * result or failure, then has the host refuse a site change (`update`) and publication
 * (`publish`), and reports host_refused.
 */
const hostRefusedAfter = (
  steps: readonly (object | MintFailure)[],
  then: {
    readonly update?: boolean;
    readonly publish?: boolean;
    readonly before?: { readonly update: true; readonly guardianDenied: true };
  } = {},
) => {
  let executions = 0;
  let published = 0;
  const publications = then.before === undefined ? [] : [guardianCorrection];
  return fixture(
    (_request, index) =>
      [
        ...(then.before === undefined
          ? []
          : [
              ...moveSite,
              call("execute", pureExample, "example_before"),
              call("finish_build", finishBuild, "finish_before"),
            ]),
        ...steps.map((_, step) => call("execute", authenticate, `sign_in_${step}`)),
        ...(then.update === true ? moveSite : []),
        ...(then.publish === true
          ? [call("execute", pureExample, "example"), call("finish_build", finishBuild, "finish")]
          : []),
        call("report_blocked", {
          reason: "host_refused",
          explanation: "A OpenGPT check refused the step this build needs.",
        }),
      ][index] ?? prose("Stopping."),
    {
      reviewAndExecute: (submitted, beforeDispatch = () => Effect.void) => {
        if (submitted.purpose !== "authenticate")
          return beforeDispatch({ reviewId: "review_example", action: "read" }).pipe(
            Effect.as({
              executionId: "execution_one",
              status: "completed" as const,
              effect: "verified" as const,
              resultRef: "example_result",
              observations: { result: "fixture" },
            }),
          );
        const step = steps[executions++] ?? submittedScreen;
        if (step instanceof MintFailure) return Effect.fail(step);
        return beforeDispatch({ reviewId: "review_sign_in", action: "authentication" }).pipe(
          Effect.as(step as typeof submittedScreen),
        );
      },
      askInput: () => Effect.succeed({ move: { type: "confirm", value: { confirmed: true } } }),
      reviewTaskUpdate: () =>
        Effect.succeed({ outcome: "allow" as const, rationale: "Same task.", reviewId: "r1" }),
      applyTaskUpdate: () =>
        Effect.succeed({
          outcome: "refused" as const,
          reason: "change_unsupported",
          notice: "This build cannot move to that site.",
        }),
      publish: () => Effect.fail(publications[published++] ?? hostCheckRefused),
    },
    { siteOrigin: "https://shop.example.test" },
  );
};
const refusedFormRecord = { source: "sign_in_step", code: "AutofillRefused", check: "destination" };
const refusedUpdateRecord = { source: "task_update", reason: "change_unsupported" };
const refusedPublicationRecord = {
  source: "publication",
  code: "PublicationUnavailable",
  reason: "autofill_recipe_not_verified",
};

// While the sign-in never confirmed, a host refusal apart from it keeps a host_refused report's
// reason: a sign-in form the host refused after the login went out, or a site change it refused.
// A later publication refusal, which may follow from the unconfirmed sign-in, neither hides it
// nor ends the build as sign-in unavailable, and the record lists every check still standing.
it.each([
  {
    basis: "a form refused after the login went out",
    steps: [submittedScreen, refusedForm, signInCheck("failed")],
    then: {},
    recorded: [refusedFormRecord],
  },
  {
    basis: "a form refused after the login went out, then a refused publication",
    steps: [submittedScreen, refusedForm, signInCheck("failed")],
    then: { publish: true },
    recorded: [refusedFormRecord, refusedPublicationRecord],
  },
  {
    basis: "a refused site change",
    steps: [submittedScreen],
    then: { update: true },
    recorded: [refusedUpdateRecord],
  },
  {
    basis: "a refused site change, then a refused publication",
    steps: [submittedScreen],
    then: { update: true, publish: true },
    recorded: [refusedUpdateRecord, refusedPublicationRecord],
  },
  // The same form refused again after a later login went out is the latest sign-in event again.
  {
    basis: "a form refused again after a later login went out",
    steps: [refusedForm, submittedScreen, refusedForm, signInCheck("failed")],
    then: {},
    recorded: [refusedFormRecord],
  },
])(
  "keeps a host_refused report on $basis while the sign-in never confirmed",
  async ({ steps, then, recorded }) => {
    const f = await hostRefusedAfter(steps, then);
    const outcome = await f.run();
    expect(outcome).toMatchObject({ build: "incomplete", blocked: { reason: "host_refused" } });
    expect(outcome).not.toHaveProperty("recoveryReason");
    expect(blockedDiagnostic(outcome)).toMatchObject({
      reason: "host_refused",
      hostRefusals: recorded,
    });
  },
);

// A publication that passed the host's checks and that Guardian then denied ends the host refusals
// standing before it: what Guardian decided is what the build answers. A refused site change
// before it therefore no longer keeps the reason of a host_refused report on a publication the
// host refused after a login the site silently rejected, which ends as sign-in unavailable.
it("ends host refusals once a publication passes the host's checks", async () => {
  const f = await hostRefusedAfter([submittedScreen, rejectionUnconfirmed], {
    before: { update: true, guardianDenied: true },
    publish: true,
  });
  const outcome = await f.run();
  expect(outcome).not.toHaveProperty("blocked");
  expect(outcome).toMatchObject({ recoveryReason: "sign_in_unavailable", stopReason: "sign_in_failed" });
  expect(blockedDiagnostic(outcome)).toMatchObject({
    reason: "sign_in_unavailable",
    reported: "host_refused",
    hostRefusals: [refusedPublicationRecord],
  });
});

// The login went out and the site silently refused it; publication then refused a recipe nothing
// verified. That refusal follows from the unconfirmed sign-in, so a host_refused report on it ends
// as sign-in unavailable, as before, with the publication check on record.
it("ends a host_refused report on a publication refused after an unconfirmed sign-in as sign-in unavailable", async () => {
  const steps = [submittedScreen, rejectionUnconfirmed];
  let executions = 0;
  const f = await fixture(
    (_request, index) =>
      [
        ...steps.map((_, step) => call("execute", authenticate, `sign_in_${step}`)),
        call("execute", pureExample, "example"),
        call("finish_build", finishBuild, "finish"),
        call("report_blocked", {
          reason: "host_refused",
          explanation: "A OpenGPT check refused publication, so no tool was published.",
        }),
      ][index] ?? prose("Stopping."),
    {
      reviewAndExecute: (submitted, beforeDispatch = () => Effect.void) => {
        const dispatched = beforeDispatch({
          reviewId: "review_step",
          action: submitted.purpose === "authenticate" ? "authentication" : "read",
        });
        if (submitted.purpose !== "authenticate")
          return dispatched.pipe(
            Effect.as({
              executionId: "execution_one",
              status: "completed" as const,
              effect: "verified" as const,
              resultRef: "example_result",
              observations: { result: "fixture" },
            }),
          );
        return dispatched.pipe(Effect.as(steps[executions++] ?? submittedScreen));
      },
      publish: () => Effect.fail(hostCheckRefused),
    },
  );
  const outcome = await f.run();
  expect(outcome).not.toHaveProperty("blocked");
  expect(outcome).toMatchObject({ recoveryReason: "sign_in_unavailable" });
  expect(blockedDiagnostic(outcome)).toMatchObject({
    reason: "sign_in_unavailable",
    reported: "host_refused",
    hostRefusals: [
      { source: "publication", code: "PublicationUnavailable", reason: "autofill_recipe_not_verified" },
    ],
  });
});

// Guardian's final refusal of the sign-in itself, with nothing sent, is no reason the task is
// impossible as asked: the build never got past signing in. A report that stands only on it ends as
// sign-in unavailable, as an unconfirmed sign-in does, never as a policy block or a site's limit.
const refusedSignIn = (refusal?: "final" | "correctable") =>
  new MintFailure({
    code: "ReviewDenied",
    review: {
      outcome: "deny",
      reviewId: "review_sign_in_refused",
      rationale: "This sign-in may not run.",
      ...(refusal === undefined ? {} : { refusal }),
    },
  });
it.each([
  { reason: "policy", refusal: "final", kind: "final" },
  { reason: "policy", refusal: undefined, kind: "unmarked" },
  { reason: "site_lacks_capability", refusal: "final", kind: "final" },
  { reason: "site_declined", refusal: "final", kind: "final" },
] as const)(
  "ends a $reason report as sign-in unavailable when its only refusal is Guardian's $kind refusal of the sign-in",
  async ({ reason, refusal }) => {
    const f = await signInThenDecline([refusedSignIn(refusal)], {}, {
      reason,
      explanation: "Guardian refused the sign-in, so this build cannot go on.",
    });
    const outcome = await f.run();
    expect(outcome).not.toHaveProperty("blocked");
    expect(outcome).toMatchObject({
      build: "incomplete",
      recoveryReason: "sign_in_unavailable",
      stopReason: "sign_in_failed",
    });
  },
);

// A refusal Guardian marked correctable names a fix, so nothing stands on it; and a final refusal
// of any other step or of a publication, a host check's refusal, a move to another site or a
// confirmed sign-in after it keeps the report's own ending.
const refusedRead = new MintFailure({
  code: "ReviewDenied",
  review: { outcome: "deny", reviewId: "review_read", rationale: "Not allowed.", refusal: "final" },
});
it("refuses a policy report on a correctable refusal of the sign-in", async () => {
  const f = await signInThenDecline([refusedSignIn("correctable")], {}, {
    reason: "policy",
    explanation: "Guardian refused the sign-in.",
  });
  const outcome = await f.run();
  expect(outcome).not.toMatchObject({ recoveryReason: "sign_in_unavailable" });
  expect(lastResult(f.requests[2])).toContain("policy_not_refused");
});
it("keeps a policy block that also stands on a final refusal of another step", async () => {
  const explanation = "Guardian refused the only way to reach the requested page.";
  let executions = 0;
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", authenticate, "sign_in"),
        call("execute", pureExample, "read"),
        call("report_blocked", { reason: "policy", explanation }),
      ][index] ?? prose("Stopping."),
    {
      reviewAndExecute: () =>
        Effect.fail(executions++ === 0 ? refusedSignIn("final") : refusedRead),
    },
  );
  expect(await f.run()).toMatchObject({
    blocked: { reason: "policy", explanation },
    stopReason: "policy",
  });
});
/** Guardian refuses the sign-in in its preflight review; every other step passes it. */
const refuseSignInOnly: { preflight: NonNullable<NonNullable<Parameters<typeof fixture>[1]>["preflight"]> } = {
  preflight: (submitted) =>
    submitted.purpose === "authenticate"
      ? Effect.fail(refusedSignIn("final"))
      : Effect.succeed({ supported: true as const }),
};
it("keeps a host_refused block after Guardian also refused the sign-in", async () => {
  const explanation = "A OpenGPT check refused the step this build needs.";
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", authenticate, "sign_in"),
        ...moveSite,
        call("report_blocked", { reason: "host_refused", explanation }),
      ][index] ?? prose("Stopping."),
    {
      ...refuseSignInOnly,
      askInput: () => Effect.succeed({ move: { type: "confirm", value: { confirmed: true } } }),
      reviewTaskUpdate: () =>
        Effect.succeed({ outcome: "allow" as const, rationale: "Same task.", reviewId: "r1" }),
      applyTaskUpdate: () =>
        Effect.succeed({
          outcome: "refused" as const,
          reason: "change_unsupported",
          notice: "This build cannot move to that site.",
        }),
    },
    { siteOrigin: "https://shop.example.test" },
  );
  expect(await f.run()).toMatchObject({
    blocked: { reason: "host_refused", explanation },
    stopReason: "host_refused",
  });
});
// A host refusal a later finish_build got past is still a refusal on record beside Guardian's
// refusal of the sign-in, so a policy report keeps its own ending.
it("keeps a policy block after Guardian refused the sign-in and a finish_build got past a host refusal", async () => {
  const explanation = "Guardian refused the only way to reach the requested page.";
  const refusals = [variantsUnsupported, guardianCorrection];
  let published = 0;
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", authenticate, "sign_in"),
        call("execute", pureExample, "read"),
        finishAs(0),
        finishAs(1),
        call("report_blocked", { reason: "policy", explanation }),
      ][index] ?? prose("Stopping."),
    {
      ...refuseSignInOnly,
      publish: () => Effect.fail(refusals[published++] ?? guardianCorrection),
    },
  );
  expect(await f.run()).toMatchObject({
    blocked: { reason: "policy", explanation },
    stopReason: "policy",
  });
  expect(published).toBe(2);
});
it("keeps a policy block once the build moved to another site after Guardian refused the sign-in", async () => {
  const explanation = "Guardian refused the only way to reach the requested page.";
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", authenticate, "sign_in"),
        ...moveSite,
        call("report_blocked", { reason: "policy", explanation }),
      ][index] ?? prose("Stopping."),
    {
      ...refuseSignInOnly,
      askInput: () => Effect.succeed({ move: { type: "confirm", value: { confirmed: true } } }),
      reviewTaskUpdate: () =>
        Effect.succeed({ outcome: "allow" as const, rationale: "Same task.", reviewId: "r1" }),
      applyTaskUpdate: () => Effect.succeed({ outcome: "applied" as const }),
    },
    { siteOrigin: "https://shop.example.test" },
  );
  expect(await f.run()).toMatchObject({
    blocked: { reason: "policy", explanation },
    stopReason: "policy",
  });
});
it("keeps a policy block that also stands on a publication refusal no correction gets past", async () => {
  const explanation = "Guardian refused to publish what this tool reads.";
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", authenticate, "sign_in"),
        call("execute", pureExample, "read"),
        call("finish_build", finishBuild, "finish"),
        call("report_blocked", { reason: "policy", explanation }),
      ][index] ?? prose("Stopping."),
    {
      ...refuseSignInOnly,
      publish: () =>
        Effect.fail(
          new MintFailure({
            code: "ReviewDenied",
            review: {
              outcome: "deny",
              reason: "privacy",
              reviewId: "review_privacy",
              rationale: "The output holds another person's details.",
              findings: [],
            },
          }),
        ),
    },
  );
  expect(await f.run()).toMatchObject({
    blocked: { reason: "policy", explanation },
    stopReason: "policy",
  });
});
it("keeps site_declined once a later sign-in confirmed after Guardian refused one", async () => {
  const f = await signInThenDecline([refusedSignIn("final"), submittedScreen, signInCheck("authenticated")]);
  expect(await f.run()).toMatchObject({
    blocked: { reason: "site_declined" },
    stopReason: "site_declined",
  });
});

// A sign-in the host confirmed, or one that sent nothing, leaves site_declined as it was: a screen
// that sent nothing, one whose host found nothing to submit, and one that stopped past its
// dispatch fence with nothing sent.
const sentNothingPastFence = new MintFailure({
  code: "Unavailable",
  execution: { phase: "execute", reason: "provider_unavailable", dispatch: "not_sent" },
});
it.each([
  { name: "a confirmed sign-in", steps: [submittedScreen, signInCheck("authenticated")] },
  {
    name: "a screen that sent nothing",
    steps: [{ ...submittedScreen, effect: "not_sent" as const }],
  },
  {
    name: "a failed sign-in step that sent nothing",
    steps: [
      {
        ...submittedScreen,
        effect: "not_sent" as const,
        authentication: { state: "failed" as const, effect: "possible" as const },
      },
    ],
  },
  { name: "a step stopped past its fence before sending", steps: [{ afterFence: sentNothingPastFence }] },
])("keeps site_declined after $name", async ({ steps }) => {
  const f = await signInThenDecline(steps, { signInSessionLoss: () => "session_not_kept" });
  expect(await f.run()).toMatchObject({
    blocked: { reason: "site_declined" },
    stopReason: "site_declined",
  });
});

// The ending a report gets is decided first, by the checks every report passes: one with no basis
// on record is refused and the build goes on, signed in or not. Only an ending those checks accept
// becomes sign-in unavailable while the sign-in never confirmed.
it.each([
  { reason: "policy", refusal: "policy_not_refused" },
  { reason: "host_refused", refusal: "host_not_refused" },
])(
  "refuses an unfounded $reason report after an unconfirmed sign-in as $refusal",
  async ({ reason, refusal }) => {
    const f = await signInThenDecline([submittedScreen], {}, {
      reason,
      explanation: "The site's sign-in kept refusing.",
    });
    const outcome = await f.run();
    expect(outcome).not.toMatchObject({ recoveryReason: "sign_in_unavailable" });
    expect(JSON.stringify(f.requests[2]?.input)).toContain(refusal);
  },
);

// A policy report that stands only on the owner's no takes that name, and the owner's own no keeps
// its ending, sign-in or not.
it("ends a policy report that stands on the owner's no as owner_declined after an unconfirmed sign-in", async () => {
  const f = await fixture(
    (_request, index) =>
      [
        signIn,
        call("request_input", {
          questions: [{ id: "go", type: "confirm", prompt: "May the build open the account page?" }],
        }),
        call("report_blocked", {
          reason: "policy",
          explanation: "The owner did not allow the account page.",
        }),
      ][index] ?? prose("Stopping."),
    {
      reviewAndExecute: (_submitted, beforeDispatch = () => Effect.void) =>
        beforeDispatch({ reviewId: "review_sign_in", action: "authentication" }).pipe(
          Effect.as(submittedScreen),
        ),
      askInput: () => Effect.succeed({ go: { type: "confirm", value: { confirmed: false } } }),
    },
  );
  expect(await f.run()).toMatchObject({
    blocked: { reason: "owner_declined" },
    stopReason: "owner_declined",
  });
});

// owner_ended stands only on the owner's latest answer with nothing run since: an answer the build
// went on from, such as a date it then tried on a site that failed, never ends it as the owner's
// choice, and neither does a secret answer, which Guardian never sees, or a sign-in after the answer.
const failedSiteStep = {
  executionId: "example_failed",
  status: "failed" as const,
  effect: "not_sent" as const,
  resultRef: "example_failed_result",
  observations: { error: "The site showed an error page." },
};
const stopAnswer = { next: { type: "choice", value: "stop" } } as const;
it.each([
  {
    after: "a step that failed on the site after a date answer",
    steps: [
      call("request_input", {
        questions: [{ id: "start", type: "text", prompt: "Which start date should the example use?" }],
      }),
      call("execute", pureExample),
    ],
    answers: { start: { type: "text", value: "2026-11-02" } },
  },
  {
    after: "a secret answer after the owner chose to stop",
    steps: [
      call("request_input", stopChoice),
      call(
        "request_input",
        {
          questions: [
            { id: "note", type: "secret", secretKind: "private_text", prompt: "Which reference?" },
          ],
        },
        "secret",
      ),
    ],
    answers: { ...stopAnswer, note: { type: "secret", value: "private-reference" } },
  },
  {
    after: "a sign-in after the owner chose to stop",
    steps: [call("request_input", stopChoice), signIn],
    answers: stopAnswer,
  },
] as const)("refuses owner_ended after $after", async ({ steps, answers }) => {
  const explanation = "You chose to stop because the start date is unknown.";
  const f = await fixture(
    (_request, index) =>
      [...steps, call("report_blocked", { reason: "owner_ended", explanation })][index] ??
      prose("Stopping."),
    {
      reviewAndExecute: (submitted, beforeDispatch = () => Effect.void) =>
        submitted.purpose === "authenticate"
          ? beforeDispatch({ reviewId: "review_sign_in", action: "authentication" }).pipe(
              Effect.as(submittedScreen),
            )
          : Effect.succeed(failedSiteStep),
      askInput: (request) =>
        Effect.succeed(
          Object.fromEntries(
            request.questions.flatMap((question) =>
              question.id in answers ? [[question.id, answers[question.id as keyof typeof answers]]] : [],
            ),
          ),
        ),
    },
  );
  const outcome = await f.run();
  expect(outcome).not.toMatchObject({ blocked: { reason: "owner_ended" } });
  expect(JSON.stringify(f.requests[steps.length + 1]?.input ?? null)).toContain("owner_not_ended");
});

// A stop condition the owner picked in an answer, which the minter recorded with mint_update and
// then had to check, is the caller's own request too: once the check meets it, caller_input stands
// on that update when the intent cites it, though owner_ended no longer can.
it("ends caller_input on a stop condition the owner confirmed in an answer, citing its revision", async () => {
  const explanation =
    "The store redirected to its sister store, and you asked to stop then, so nothing was searched.";
  let asked = 0;
  let executed = 0;
  const f = await fixture(
    (_request, index) =>
      [
        call("request_input", {
          questions: [
            {
              id: "store",
              type: "choice",
              prompt: "The store sends this browser to its sister store. Where should the tool search?",
              options: [
                { id: "sister", label: "Search the sister store instead" },
                { id: "stop", label: "Keep the main store only, and stop if it redirects" },
              ],
            },
          ],
        }),
        call("mint_update", {
          summary: "Stop without searching when the store redirects.",
          changes: [
            {
              setting: "requirement",
              change: "add",
              text: "Search only the main store, and stop when it redirects to the sister store.",
            },
          ],
          confirmedBy: ["store"],
          recommend: "update",
          intent: "The owner picked the stop option.",
        }),
        call("execute", { ...pureExample, purpose: "explore", target: "liveBrowser" }),
        call("report_blocked", {
          reason: "caller_input",
          explanation,
          intent: "Task revision 1 requires stopping on this redirect.",
        }),
      ][index] ?? prose("The store redirected, so I stopped."),
    {
      askInput: () =>
        Effect.sync(() => {
          asked++;
          return { store: { type: "choice", value: "stop" } } as const;
        }),
      reviewAndExecute: (_input, beforeDispatch = () => Effect.void) =>
        beforeDispatch(readAllow).pipe(
          Effect.zipRight(
            Effect.sync(() => {
              executed++;
              return {
                executionId: "origin_check",
                status: "completed" as const,
                effect: "not_sent" as const,
                resultRef: "origin_result",
                observations: { url: "https://sister.example.test/" },
              };
            }),
          ),
        ),
      reviewTaskUpdate: () =>
        Effect.succeed({ outcome: "allow" as const, rationale: "Confirmed.", reviewId: "r1" }),
      applyTaskUpdate: () => Effect.succeed({ outcome: "applied" as const }),
    },
    {
      intent: "Search the store's catalog by keyword and return each product's title and price.",
      businessInput: { keyword: "kettle" },
    },
  );
  expect(await f.run()).toMatchObject({
    build: "incomplete",
    blocked: { reason: "caller_input", explanation },
    stopReason: "caller_input",
  });
  // It ends at its first report: the owner is asked once, and nothing runs after the check.
  expect(f.requests).toHaveLength(4);
  expect({ asked, executed }).toEqual({ asked: 1, executed: 1 });
});

// The owner's own choice to end the build keeps its ending, sign-in or not, as their no does.
it("keeps owner_ended after an unconfirmed sign-in", async () => {
  const f = await fixture(
    (_request, index) =>
      [
        signIn,
        call("request_input", stopChoice),
        call("report_blocked", {
          reason: "owner_ended",
          explanation: "You chose to stop because the start date is unknown.",
        }),
      ][index] ?? prose("Stopping."),
    {
      reviewAndExecute: (_submitted, beforeDispatch = () => Effect.void) =>
        beforeDispatch({ reviewId: "review_sign_in", action: "authentication" }).pipe(
          Effect.as(submittedScreen),
        ),
      askInput: () => Effect.succeed({ next: { type: "choice", value: "stop" } }),
    },
  );
  expect(await f.run()).toMatchObject({
    blocked: { reason: "owner_ended" },
    stopReason: "owner_ended",
  });
});

// A build that moved to another site left the first site's sign-in behind with it.
it("keeps site_declined after a move to another site that left an unconfirmed sign-in", async () => {
  const f = await fixture(
    (_request, index) =>
      [signIn, ...moveSite, call("report_blocked", declinedExample)][index] ?? prose("Stopping."),
    {
      reviewAndExecute: (_submitted, beforeDispatch = () => Effect.void) =>
        beforeDispatch({ reviewId: "review_sign_in", action: "authentication" }).pipe(
          Effect.as(submittedScreen),
        ),
      askInput: () => Effect.succeed({ move: { type: "confirm", value: { confirmed: true } } }),
      reviewTaskUpdate: () =>
        Effect.succeed({ outcome: "allow" as const, rationale: "Same task.", reviewId: "r1" }),
      applyTaskUpdate: () => Effect.succeed({ outcome: "applied" as const }),
    },
    { siteOrigin: "https://shop.example.test" },
  );
  expect(await f.run()).toMatchObject({
    blocked: { reason: "site_declined" },
    stopReason: "site_declined",
  });
});

// A login the site visibly rejected fails the sign-in: site_declined is refused until that is
// resolved, as with any failed sign-in, so the owner is asked to fix the login.
it("refuses site_declined while a rejected login is unresolved", async () => {
  const f = await fixture(
    (_request, index) =>
      [call("execute", authenticate), call("report_blocked", declinedExample)][index] ??
      prose("Stopping."),
    {
      reviewAndExecute: () =>
        Effect.fail(
          new MintFailure({
            code: "Unavailable",
            authentication: {
              phase: "credential_submit",
              code: "CredentialsRejected",
              afterSubmission: true,
            },
          }),
        ),
    },
  );
  const outcome = await f.run();
  expect(JSON.stringify(f.requests[2]?.input)).toContain("sign_in_unresolved");
  expect(outcome).not.toHaveProperty("blocked");
});

// The owner chose not to sign in: their answer comes back as a result, not a failed sign-in, the
// host never signs in again, and the build may end as the owner's choice.
it("hands a declined login back as a result and ends as owner_declined when the minter stops", async () => {
  let signIns = 0;
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", authenticate, "first"),
        call("execute", authenticate, "again"),
        call("report_blocked", {
          reason: "policy",
          explanation: "Without signing in, the site shows no order history.",
        }),
      ][index] ?? prose("Stopping."),
    {
      reviewAndExecute: () =>
        Effect.suspend(() => {
          signIns++;
          return Effect.fail(new MintFailure({ code: "Unavailable", loginDeclined: "no_account" }));
        }),
    },
  );
  const outcome = await f.run();
  const declined = JSON.stringify(f.requests[1]?.input);
  expect(declined).toContain('\\"status\\":\\"login_declined\\"');
  expect(declined).toContain('\\"declined\\":\\"no_account\\"');
  expect(declined).not.toContain("authentication_unavailable");
  // The second authenticate hears the same answer and runs nothing.
  expect(signIns).toBe(1);
  expect(JSON.stringify(f.requests[2]?.input)).toContain("login_declined");
  expect(outcome).toMatchObject({
    build: "incomplete",
    blocked: { reason: "owner_declined" },
    stopReason: "owner_declined",
  });
  expect(outcome).not.toHaveProperty("recoveryReason");
});

// A login request Guardian routed a question to may be declined too: the minter hears it and
// builds the public part, and the host raises no further login request.
it("hands a declined login request back with the public-only guidance", async () => {
  let loginRequests = 0;
  const f = await fixture(
    (_request, index) =>
      [
        call("request_input", ask("What is your password?")),
        call("request_input", ask("What is your password, please?"), "again"),
        call("report_blocked", {
          reason: "owner_declined",
          explanation: "The owner chose not to sign in, and the site shows nothing signed out.",
        }),
      ][index] ?? prose("Stopping."),
    {
      // Guardian routes each password question to the host's login request, and allows the
      // blocked explanation.
      reviewQuestion: (candidate) =>
        Effect.succeed(
          candidate.questions[0]?.id === "blocked"
            ? { outcome: "allow_business" as const, rationale: "Plain." }
            : { outcome: "authentication" as const, rationale: "Asks for a login." },
        ),
      requestLogin: () =>
        Effect.sync(() => {
          loginRequests++;
          return "public_only" as const;
        }),
    },
    { siteOrigin: "https://shop.example.test" },
  );
  const outcome = await f.run();
  const answer = JSON.stringify(f.requests[1]?.input);
  expect(answer).toContain('\\"declined\\":\\"public_only\\"');
  expect(answer).toContain("without signing in");
  expect(outcome).toMatchObject({ blocked: { reason: "owner_declined" } });
  // The second login question hears the owner's answer again; nobody is asked twice.
  expect(JSON.stringify(f.requests[2]?.input)).toContain("without signing in");
  expect(loginRequests).toBe(1);
});

const failedSignIn = new MintFailure({
  code: "Unavailable",
  authentication: { phase: "login_poll", code: "AuthenticationFailed", afterSubmission: true },
});
const lacksPublicPart = {
  reason: "site_lacks_capability",
  explanation: "Signed out, the site shows no order history.",
};

// A sign-in the minter cannot get past may be given up, where the host allows it: the build goes
// on signed out, so its blocked ending is no longer held back by the unresolved sign-in.
it.each([
  { outcome: "abandoned", status: "sign_in_abandoned", ends: true },
  { outcome: "refused", status: "abandon_sign_in_refused", ends: false },
] as const)(
  "gives up a failed sign-in when the host allows it: $outcome",
  async ({ outcome, status, ends }) => {
    let abandons = 0;
    const f = await fixture(
      (_request, index) =>
        [
          call("execute", authenticate),
          call("abandon_sign_in", { intent: "The account page cannot be signed in." }),
          call("report_blocked", lacksPublicPart),
        ][index] ?? prose("Stopping."),
      {
        reviewAndExecute: () => Effect.fail(failedSignIn),
        abandonSignIn: () =>
          Effect.sync(() => {
            abandons++;
            return outcome === "abandoned"
              ? { outcome }
              : { outcome, reason: "sign_in_required", notice: "This task needs the account." };
          }),
      },
    );
    const outcome_ = await f.run();
    expect(abandons).toBe(1);
    expect(JSON.stringify(f.requests[2]?.input)).toContain(status);
    if (ends) expect(outcome_.blocked).toMatchObject({ reason: "site_lacks_capability" });
    else {
      expect(outcome_).not.toHaveProperty("blocked");
      expect(JSON.stringify(f.requests[3]?.input)).toContain("sign_in_unresolved");
    }
  },
);

// The owner confirmed that the task runs signed out: once the update applies, a failed sign-in
// holds nothing back.
it("drops a failed sign-in once an update makes the task run signed out", async () => {
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", authenticate),
        call(
          "request_input",
          {
            questions: [
              {
                id: "public",
                type: "confirm",
                prompt: "Should the tool read only what the site shows without signing in?",
              },
            ],
          },
          "ask",
        ),
        call(
          "mint_update",
          {
            summary: "Read only what the site shows without signing in.",
            changes: [
              {
                setting: "login",
                change: "signed_out",
                text: "Read only what the site shows signed out.",
              },
            ],
            confirmedBy: ["public"],
            recommend: "update",
            intent: "The owner confirmed reading signed out.",
          },
          "update",
        ),
        call("report_blocked", lacksPublicPart),
      ][index] ?? prose("Stopping."),
    {
      reviewAndExecute: () => Effect.fail(failedSignIn),
      askInput: () => Effect.succeed({ public: { type: "confirm", value: { confirmed: true } } }),
      reviewTaskUpdate: () =>
        Effect.succeed({ outcome: "allow" as const, rationale: "Confirmed.", reviewId: "r1" }),
      applyTaskUpdate: () => Effect.succeed({ outcome: "applied" as const }),
    },
  );
  const outcome = await f.run();
  expect(JSON.stringify(f.requests[3]?.input)).toContain("runs signed out");
  expect(outcome.blocked).toMatchObject({ reason: "site_lacks_capability" });
});

// A write build that goes on signed out, as a guest of a site that offers its task without an
// account, still does its write through act steps; a read's example and live tests are no part
// of it.
it("points a write build that goes on signed out to its act steps", async () => {
  const f = await fixture(
    (_request, index) =>
      [
        call(
          "request_input",
          {
            questions: [
              {
                id: "guest",
                type: "confirm",
                prompt: "Should the tool apply as a new applicant, without signing in?",
              },
            ],
          },
          "ask",
        ),
        call(
          "mint_update",
          {
            summary: "Apply as a new applicant, without signing in.",
            changes: [{ setting: "login", change: "signed_out" }],
            confirmedBy: ["guest"],
            recommend: "update",
            intent: "The owner confirmed applying signed out.",
          },
          "update",
        ),
      ][index] ?? prose("Stopping."),
    {
      askInput: () => Effect.succeed({ guest: { type: "confirm", value: { confirmed: true } } }),
      reviewTaskUpdate: () =>
        Effect.succeed({ outcome: "allow" as const, rationale: "Confirmed.", reviewId: "r1" }),
      applyTaskUpdate: () => Effect.succeed({ outcome: "applied" as const }),
    },
    { effect: "write", siteOrigin: "https://shop.example.test" },
  );
  await f.run();
  const applied = lastResult(f.requests[2]);
  expect(applied).toContain("runs signed out");
  expect(applied).toContain("purpose act");
  expect(applied).not.toContain("live tests");
});

// The same holds for a write whose host let it give its sign-in up: what it does next is its act
// steps, never a read's example and live tests.
it("points a write build that gave its sign-in up to its act steps", async () => {
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", authenticate),
        call("abandon_sign_in", { intent: "The site offers the task without an account." }),
      ][index] ?? prose("Stopping."),
    {
      reviewAndExecute: () => Effect.fail(failedSignIn),
      abandonSignIn: () => Effect.succeed({ outcome: "abandoned" as const }),
    },
    { effect: "write", siteOrigin: "https://shop.example.test" },
  );
  await f.run();
  const abandoned = lastResult(f.requests[2]);
  expect(abandoned).toContain("sign_in_abandoned");
  expect(abandoned).toContain("purpose act");
  expect(abandoned).not.toContain("live tests");
});

const harnessFixture = makeMintHarnessFixture(
  cleanups,
  { mode: "mint", intent: "Read public data", businessInput: {}, observations: [] },
  portableJobSession,
);

// The host's hook has no guard of its own, so giving up the sign-in waits for the execution in
// flight, a sign-in step included, and never runs beside it.
it("never gives up a sign-in while an execution is in flight", async () => {
  const order: string[] = [];
  const f = await harnessFixture(
    (turn) =>
      Effect.gen(function* () {
        const abandon = turn.actions.abandonSignIn;
        if (abandon === undefined) throw new Error("Missing abandon_sign_in");
        const signIn = yield* Effect.fork(turn.actions.execute(authenticate));
        yield* Deferred.await(entered);
        const giveUp = yield* Effect.fork(abandon({}));
        // Let the request to give up run as far as it can while the sign-in is still in flight.
        yield* Effect.yieldNow();
        yield* Effect.sleep("20 millis");
        order.push("sign_in_released");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(signIn);
        expect(JSON.parse(yield* Fiber.join(giveUp))).toMatchObject({
          status: "sign_in_abandoned",
        });
      }),
    {
      reviewAndExecute: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.zipRight(Deferred.await(release)),
          Effect.zipRight(Effect.fail(failedSignIn)),
        ),
      abandonSignIn: () =>
        Effect.sync(() => {
          order.push("abandoned");
          return { outcome: "abandoned" as const };
        }),
    },
  );
  const entered = Effect.runSync(Deferred.make<void>());
  const release = Effect.runSync(Deferred.make<void>());
  await f.run();
  expect(order).toEqual(["sign_in_released", "abandoned"]);
});

// Once a build gave up signing in, it stays signed out: another authenticate runs nothing and no
// login is asked for, so the given-up sign-in never comes back unresolved.
it.each(["tool", "update"] as const)(
  "keeps a build signed out once it gave up signing in through the %s",
  async (path) => {
    let signIns = 0;
    let loginRequests = 0;
    const giveUp =
      path === "tool"
        ? [call("abandon_sign_in", { intent: "The sign-in cannot be resolved." })]
        : [
            call(
              "request_input",
              {
                questions: [
                  {
                    id: "public",
                    type: "confirm",
                    prompt: "Should the tool read only what the site shows without signing in?",
                  },
                ],
              },
              "confirm",
            ),
            call(
              "mint_update",
              {
                summary: "Read only what the site shows without signing in.",
                changes: [
                  {
                    setting: "login",
                    change: "signed_out",
                    text: "Read only what the site shows signed out.",
                  },
                ],
                confirmedBy: ["public"],
                recommend: "update",
                intent: "The owner confirmed reading signed out.",
              },
              "update",
            ),
          ];
    const f = await fixture(
      (_request, index) =>
        [
          call("execute", authenticate, "first"),
          ...giveUp,
          call("execute", authenticate, "again"),
          call(
            "request_input",
            { questions: [{ id: "report", type: "text", prompt: "What is your password?" }] },
            "login",
          ),
          call("report_blocked", lacksPublicPart),
        ][index] ?? prose("Stopping."),
      {
        reviewAndExecute: () =>
          Effect.suspend(() => {
            signIns++;
            return Effect.fail(failedSignIn);
          }),
        abandonSignIn: () => Effect.succeed({ outcome: "abandoned" as const }),
        askInput: () => Effect.succeed({ public: { type: "confirm", value: { confirmed: true } } }),
        reviewQuestion: (candidate) =>
          Effect.succeed(
            candidate.questions[0]?.id === "report"
              ? { outcome: "authentication" as const, rationale: "Asks for a login." }
              : { outcome: "allow_business" as const, rationale: "Plain." },
          ),
        requestLogin: () =>
          Effect.sync(() => {
            loginRequests++;
            return "supplied" as const;
          }),
        reviewTaskUpdate: () =>
          Effect.succeed({ outcome: "allow" as const, rationale: "Confirmed.", reviewId: "r1" }),
        applyTaskUpdate: () => Effect.succeed({ outcome: "applied" as const }),
      },
    );
    const outcome = await f.run();
    expect(signIns).toBe(1);
    expect(loginRequests).toBe(0);
    const again = 1 + giveUp.length + 1;
    expect(JSON.stringify(f.requests[again]?.input)).toContain("sign_in_abandoned");
    expect(JSON.stringify(f.requests[again + 1]?.input)).toContain('\\"login\\":\\"abandoned\\"');
    expect(outcome.blocked).toMatchObject({ reason: "site_lacks_capability" });
  },
);

// A login the owner declined after an earlier sign-in failed leaves nothing to resolve: the
// failed sign-in's guidance never comes back to contradict the owner's answer.
it("gives no failed sign-in's guidance once the owner declined a login request", async () => {
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", authenticate),
        call(
          "request_input",
          { questions: [{ id: "report", type: "text", prompt: "What is your password?" }] },
          "login",
        ),
      ][index] ?? prose("Stopping."),
    {
      reviewAndExecute: () => Effect.fail(failedSignIn),
      reviewQuestion: (candidate) =>
        Effect.succeed(
          candidate.questions[0]?.id === "report"
            ? { outcome: "authentication" as const, rationale: "Asks for a login." }
            : { outcome: "allow_business" as const, rationale: "Plain." },
        ),
      requestLogin: () => Effect.succeed("public_only" as const),
    },
  );
  await f.run();
  for (const request of f.requests.slice(2))
    expect(JSON.stringify(request.input)).not.toContain("The last sign-in failed and nothing");
});

it("records no sign-in execution for a login the owner declined", async () => {
  const f = await fixture(
    (_request, index) => (index === 0 ? call("execute", authenticate) : prose("Stopping.")),
    {
      reviewAndExecute: () =>
        Effect.fail(new MintFailure({ code: "Unavailable", loginDeclined: "public_only" })),
    },
  );
  const outcome = await f.run();
  expect(outcome.executions).toEqual([]);
});

// A public reason the host cannot screen never reaches the caller unscreened; the denial stands.
it("drops a public reason whose screen failed and keeps the denial", async () => {
  const projection = portableMintProjection();
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", {
          purpose: "example",
          target: "pureFiles",
          entrypoint: "src/tool.ts",
          fixtureRefs: [],
          caseFilter: [],
          maxWorkers: 1,
          timeoutSeconds: 30,
        }),
        call("finish_build", {
          entrypoint: "src/tool.ts",
          executionId: "execution_one",
          metadata: { name: "read_public", description: "Read public data" },
          coverage: "One actual example.",
        }),
      ][index] ?? prose("Stopping."),
    {
      projection: {
        ...projection,
        text: (value, area) =>
          value.includes("unscreenable")
            ? Effect.fail(new MintFailure({ code: "Unavailable" }))
            : projection.text(value, area),
      },
      publish: () =>
        Effect.fail(
          new MintFailure({
            code: "ReviewDenied",
            review: {
              outcome: "deny",
              reason: "privacy",
              reviewId: "review_denied",
              rationale: "Synthetic refusal.",
              findings: [],
              publicReason: "An unscreenable sentence.",
            },
          }),
        ),
    },
  );
  const outcome = await f.run();
  expect(outcome.publicationDenial).toEqual({ reason: "privacy" });
});

// The review of the minter's last answer never changes how the build ended: a failure, a defect
// or a review that outlasts its bound keeps no explanation.
it.each([
  {
    name: "failure",
    review: () => Effect.fail(new MintFailure({ code: "ReviewUnavailable" })),
  },
  { name: "defect", review: () => Effect.die(new Error("Synthetic reviewer defect")) },
  { name: "timeout", review: () => Effect.never },
] as const)("keeps no last answer when its review ends in a $name", async ({ review }) => {
  const f = await fixture(() => prose("The site lists no prices without a membership."), {
    reviewQuestion: review,
    stopExplanationReviewMs: 20,
  });
  const outcome = await f.run();
  expect(outcome.stopReason).toBe("final_text_without_tool");
  expect(outcome).not.toHaveProperty("stopExplanation");
});

// A login check the host could not run is the host's ending, not a failed sign-in.
it("names a restored login-check ending host_unavailable", async () => {
  const f = await harnessFixture(() => Effect.void, {
    agentRecovery: {
      initial: {
        agent: {
          version: 1,
          sdkVersion: "0.18.0",
          sdkState: "",
          modelCalls: 0,
          finalsWithoutTool: 0,
          tools: [],
        },
        harness: {
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
          executionClosed: false,
          captchaChecks: 0,
          terminal: {
            build: "incomplete",
            recoveryReason: "login_check_unavailable",
            summary: "The login could not be checked.",
          },
        },
      },
      save: () => Effect.void,
    },
  });
  expect((await f.run()).stopReason).toBe("host_unavailable");
});

// A no to a question that asks whether to end the build means keep going, never a declined step.
// While Guardian's denial of the last publication stands, a policy report that stood only on that
// no is refused, and the minter's stop ends with Guardian's decision instead.
it("refuses to read a no to ending the build as owner_declined, and ends with Guardian's denial when the minter stops", async () => {
  const asked: unknown[] = [];
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", pureExample),
        call("finish_build", finishBuild),
        call("request_input", {
          questions: [
            {
              id: "end",
              type: "confirm",
              prompt: "End this build without publishing?",
              endsBuild: true,
            },
          ],
        }),
        call("report_blocked", {
          reason: "policy",
          explanation: "Guardian wants evidence nobody can supply.",
        }),
      ][index] ?? prose("Stopping."),
    {
      publish: () =>
        Effect.fail(
          new MintFailure({
            code: "ReviewDenied",
            review: {
              outcome: "deny",
              reason: "evidence",
              reviewId: "review_evidence",
              rationale: "The live tests do not show the conditional field.",
              findings: [],
            },
          }),
        ),
      askInput: (request) => {
        asked.push(request);
        return Effect.succeed({ end: { type: "confirm" as const, value: { confirmed: false } } });
      },
    },
  );
  const outcome = await f.run();
  // The host never sends the flag on: the question the owner reads is a plain confirm.
  expect(asked).toEqual([
    { questions: [{ id: "end", type: "confirm", prompt: "End this build without publishing?" }] },
  ]);
  expect(JSON.stringify(f.requests[4]?.input)).toContain("owner_kept_going");
  expect(JSON.stringify(f.requests[4]?.input)).toContain("the build ends with Guardian's decision");
  expect(outcome).not.toHaveProperty("blocked");
  expect(outcome).toMatchObject({ build: "incomplete", publicationDenial: { reason: "evidence" } });
});
