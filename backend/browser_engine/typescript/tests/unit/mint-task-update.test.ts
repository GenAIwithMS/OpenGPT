import { Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect, Either } from "effect";
import { afterEach, expect, it } from "vitest";
import type {
  AgentInputRequest,
  MintDependencies,
  TaskUpdateApplication,
  TaskUpdateCandidate,
} from "../../src/mint/contracts.js";
import { MintFailure } from "../../src/mint/contracts.js";
import type { TaskUpdateDecision } from "../../src/guardian/task-update.js";
import type {
  OutcomeReviewHost,
  OutcomeReviewSnapshot,
} from "../../src/mint/outcome-review-contracts.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { memoryPublicationDecisions } from "../../src/standalone/publication-decisions.js";
import { validateAnswer } from "../../src/runtime/input-request.js";
import { makeMintContinuationFixture, readAllow } from "../support/mint-fixtures.js";
import { portableJobSession } from "../support/portable-mint.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);

const usage = () => new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 });
const call = (name: string, input: object, callId = name): ModelResponse => ({
  usage: usage(),
  output: [
    {
      type: "function_call",
      name,
      callId,
      arguments: JSON.stringify({ intent: `Synthetic ${name} purpose`, ...input }),
      status: "completed",
    },
  ],
});
const prose = (): ModelResponse => ({
  usage: usage(),
  output: [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Done." }],
    },
  ],
});
/** The parsed result the harness returned for a call, from the request after it. */
const resultOf = (requests: readonly ModelRequest[], callId: string) => {
  for (const request of requests) {
    const input = request.input;
    if (!Array.isArray(input)) continue;
    const item = input.find(
      (entry) => entry.type === "function_call_result" && entry.callId === callId,
    );
    if (item === undefined || item.type !== "function_call_result") continue;
    const output = item.output;
    const text =
      typeof output === "string"
        ? output
        : Array.isArray(output)
          ? output.map((part) => ("text" in part ? part.text : "")).join("")
          : "text" in output
            ? output.text
            : "";
    return JSON.parse(text) as Record<string, unknown>;
  }
  return undefined;
};
const example = {
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
  metadata: { name: "notes", description: "Read the saved notes" },
  coverage: "One example ran.",
};
const site = "https://notes.example.test";

/** The caller answers each request in turn, as the wire would give it. */
const answering = (wire: readonly Readonly<Record<string, unknown>>[]) => {
  let index = 0;
  return (submitted: AgentInputRequest) =>
    Effect.sync(() =>
      Either.getOrThrow(
        validateAnswer(
          { ...submitted, id: "5b3f0e2a-6c1d-4f7e-9a8b-0c2d4e6f8a1b", source: "agent" },
          wire[index++] ?? {},
        ),
      ),
    );
};

/**
 * A scripted Guardian and host for task updates: Guardian decides each review in turn, and the
 * host applies what it is given, unless `host` answers instead.
 */
const updateHost = (
  decisions: readonly TaskUpdateDecision["outcome"][],
  host?: (
    application: TaskUpdateApplication,
  ) => ReturnType<NonNullable<MintDependencies["applyTaskUpdate"]>>,
) => {
  const reviews: TaskUpdateCandidate[] = [];
  const applied: TaskUpdateApplication[] = [];
  const overrides: Partial<MintDependencies> = {
    reviewTaskUpdate: (candidate) =>
      Effect.sync(() => {
        reviews.push(candidate);
        return {
          outcome: decisions[reviews.length - 1] ?? "reword",
          rationale: "Scripted review.",
          reviewId: `review_${reviews.length}`,
        };
      }),
    applyTaskUpdate: (application) =>
      host?.(application) ??
      Effect.sync(() => {
        applied.push(application);
        return { outcome: "applied" as const };
      }),
  };
  return { reviews, applied, overrides };
};

const saveQuestion = {
  questions: [
    {
      id: "save",
      type: "choice",
      prompt: "The notes page only saves a note when you submit it. May this build save it?",
      options: [
        { id: "save", label: "Yes, save the note on the site" },
        { id: "look", label: "No, only look at the notes" },
      ],
    },
  ],
};
const toWrite = {
  summary: "Save the note on the site instead of only reading the notes.",
  changes: [{ setting: "effect", effect: "write" }],
  confirmedBy: ["save"],
  recommend: "update",
};

it("turns a read build into a write build once the caller picks the option the minter wrote", async () => {
  const updates = updateHost(["allow"]);
  const f = await fixture(
    (_request, index) =>
      [call("request_input", saveQuestion, "ask"), call("mint_update", toWrite, "update")][index] ??
      prose(),
    { ...updates.overrides, askInput: answering([{ save: "save" }]), repeatableRead: true },
    { effect: "read", siteOrigin: site },
  );
  await f.run();
  expect(resultOf(f.requests, "update")).toMatchObject({
    status: "updated",
    task: { revision: 1, effect: "write", siteOrigin: site },
    repeatableRead: false,
  });
  // Guardian read the caller's pick as the option's own words, and the host applied a write.
  expect(updates.reviews[0]?.update.confirmation).toEqual([
    {
      id: "save",
      question: saveQuestion.questions[0]?.prompt,
      answer: "Yes, save the note on the site",
    },
  ]);
  expect(updates.reviews[0]?.current).toMatchObject({ revision: 0, effect: "read" });
  expect(updates.applied[0]?.next).toMatchObject({ revision: 1, effect: "write" });
});

// A write build that confirms a page default before its first act step is still a write build:
// the host, not the minter, gives the review the build's effect, so the review never reads the
// update as a read build's.
it("gives a write build's update review the write effect before its first act step", async () => {
  const updates = updateHost(["allow"]);
  const deliveryQuestion = {
    questions: [
      {
        id: "delivery",
        type: "choice",
        prompt: "The order form preselects standard delivery. Keep standard delivery?",
        options: [
          { id: "standard", label: "Yes, keep standard delivery" },
          { id: "stop", label: "No, stop" },
        ],
      },
    ],
  };
  const f = await fixture(
    (_request, index) =>
      [
        call("request_input", deliveryQuestion, "ask"),
        call(
          "mint_update",
          {
            summary: "Keep the form's standard delivery, as the caller confirmed.",
            changes: [{ setting: "input", values: { delivery: "standard" } }],
            confirmedBy: ["delivery"],
            recommend: "update",
          },
          "update",
        ),
      ][index] ?? prose(),
    { ...updates.overrides, askInput: answering([{ delivery: "standard" }]) },
    { effect: "write", siteOrigin: site },
  );
  await f.run();
  expect(resultOf(f.requests, "update")).toMatchObject({
    status: "updated",
    task: { revision: 1, effect: "write" },
  });
  expect(updates.reviews).toHaveLength(1);
  expect(updates.reviews[0]?.update.effect).toBe("write");
  expect(updates.reviews[0]?.current).toMatchObject({ revision: 0, effect: "write" });
  expect(updates.applied[0]?.next).toMatchObject({ revision: 1, effect: "write" });
  // The minter reads the same rule: a confirmed answer settles a decision that held a step for
  // the caller's input, authority or confirmation, never one made because a step weakens security.
  const mintUpdate = f.requests[0]?.tools.find((tool) => tool.name === "mint_update");
  expect(JSON.stringify(mintUpdate ?? null)).toContain(
    JSON.stringify(
      "No update removes the requested action itself or allows repeating a write that may have committed. The caller's confirmed answer settles a Guardian decision that held a step for their input, authority or confirmation, a scope decision included, but never one made because a step weakens security or safety.",
    ).slice(1, -1),
  );
});

it("drops a prerequisite the caller said the site does not offer", async () => {
  const updates = updateHost(["allow"]);
  const f = await fixture(
    (_request, index) =>
      [
        call(
          "request_input",
          {
            questions: [
              {
                id: "check",
                type: "text",
                prompt:
                  "The site shows no way to check a note's history before saving. How should the build go on?",
              },
            ],
          },
          "ask",
        ),
        call(
          "mint_update",
          {
            summary: "Save the note without checking its history first.",
            changes: [
              { setting: "requirement", change: "drop", text: "Check the note's history first." },
            ],
            confirmedBy: ["check"],
            recommend: "update",
          },
          "update",
        ),
        call("execute", example, "example"),
        call("finish_build", publication, "publish"),
      ][index] ?? prose(),
    {
      ...updates.overrides,
      askInput: answering([{ check: "Skip the history check and just save it" }]),
    },
    { siteOrigin: site },
  );
  const outcome = await f.run();
  expect(resultOf(f.requests, "update")).toMatchObject({ status: "updated" });
  expect(updates.applied[0]?.next.updates).toEqual([
    {
      revision: 1,
      summary: "Save the note without checking its history first.",
      changes: [
        { setting: "requirement", change: "drop", text: "Check the note's history first." },
      ],
      confirmation: [
        {
          id: "check",
          question:
            "The site shows no way to check a note's history before saving. How should the build go on?",
          answer: "Skip the history check and just save it",
        },
      ],
      reviewId: "review_1",
      requestDigest: expect.any(String),
    },
  ]);
  expect(outcome.build).toBe("published");
});

it("moves the build to another site of the same product, with the host rebinding it", async () => {
  const sister = "https://notes.example.org";
  const updates = updateHost(["allow"]);
  const f = await fixture(
    (_request, index) =>
      [
        call(
          "request_input",
          {
            questions: [
              {
                id: "site",
                type: "choice",
                prompt: `Your notes live on ${sister}, not on this site. Build the tool there?`,
                options: [
                  { id: "move", label: `Yes, use ${sister}` },
                  { id: "stay", label: "No, stay here" },
                ],
              },
            ],
          },
          "ask",
        ),
        call(
          "mint_update",
          {
            summary: `Build the tool on ${sister}, where the caller's notes live.`,
            changes: [{ setting: "site", origin: sister }],
            confirmedBy: ["site"],
            recommend: "update",
          },
          "update",
        ),
      ][index] ?? prose(),
    { ...updates.overrides, askInput: answering([{ site: "move" }]) },
    { siteOrigin: site },
  );
  await f.run();
  expect(updates.applied[0]).toMatchObject({
    current: { siteOrigin: site },
    next: { siteOrigin: sister, revision: 1 },
  });
  expect(resultOf(f.requests, "update")).toMatchObject({
    status: "updated",
    task: { siteOrigin: sister, siteDomain: "example.org" },
  });
});

it("asks the caller first when the host needs a login for the new site", async () => {
  const sister = "https://notes.example.org";
  const updates = updateHost(["allow"], () =>
    Effect.succeed({
      outcome: "clarification_required" as const,
      reason: "login_required",
      notice: "The account has no saved login for the new site. Ask the caller to add one.",
    }),
  );
  const f = await fixture(
    (_request, index) =>
      [
        call("request_input", { questions: [{ id: "site", type: "text", prompt: "Where?" }] }),
        call(
          "mint_update",
          {
            summary: `Build the tool on ${sister}.`,
            changes: [{ setting: "site", origin: sister }],
            confirmedBy: ["site"],
            recommend: "update",
          },
          "update",
        ),
      ][index] ?? prose(),
    { ...updates.overrides, askInput: answering([{ site: sister }]) },
    { siteOrigin: site },
  );
  const outcome = await f.run();
  expect(resultOf(f.requests, "update")).toMatchObject({
    status: "clarification_required",
    source: "host",
    reason: "login_required",
  });
  expect(outcome).not.toHaveProperty("blocked");
});

it("ends the build blocked with the recommendation when the change is a different task", async () => {
  const updates = updateHost(["allow"]);
  const suggestedRequest = "Book a table at the restaurant the caller picks on the booking site.";
  const f = await fixture(
    (_request, index) =>
      [
        call("request_input", { questions: [{ id: "task", type: "text", prompt: "What next?" }] }),
        call(
          "mint_update",
          {
            summary: "The caller now wants to book a table, not list restaurant hours.",
            changes: [{ setting: "purpose", text: "Book a table at a restaurant." }],
            confirmedBy: ["task"],
            recommend: "new_mint",
            suggestedRequest,
          },
          "update",
        ),
        call("execute", example, "after"),
      ][index] ?? prose(),
    { ...updates.overrides, askInput: answering([{ task: "Actually book me a table" }]) },
    { siteOrigin: site },
  );
  const outcome = await f.run();
  expect(outcome).toMatchObject({
    build: "incomplete",
    blocked: {
      reason: "new_mint_recommended",
      explanation: "The caller now wants to book a table, not list restaurant hours.",
      suggestedRequest,
    },
  });
  // The build ends with the update: nothing runs after it, and the host applied nothing.
  expect(f.counts().executed).toBe(0);
  expect(updates.applied).toEqual([]);
});

it("ends the build blocked when Guardian agrees the change belongs in a new build", async () => {
  const updates = updateHost(["new_mint"]);
  const f = await fixture(
    (_request, index) =>
      [
        call("request_input", { questions: [{ id: "task", type: "text", prompt: "What next?" }] }),
        call(
          "mint_update",
          {
            summary: "Order supplies on another vendor's store instead.",
            changes: [{ setting: "site", origin: "https://store.vendor.test" }],
            confirmedBy: ["task"],
            recommend: "new_mint",
            suggestedRequest: "Order the listed supplies on the other vendor's store.",
          },
          "update",
        ),
      ][index] ?? prose(),
    { ...updates.overrides, askInput: answering([{ task: "Use the other vendor" }]) },
    { siteOrigin: site },
  );
  const outcome = await f.run();
  expect(outcome.blocked).toEqual({
    reason: "new_mint_recommended",
    explanation: "Order supplies on another vendor's store instead.",
    suggestedRequest: "Order the listed supplies on the other vendor's store.",
  });
  expect(updates.applied).toEqual([]);
});

// Guardian called the minter's revised requirement a new task, and the host ended the build with
// that call: the owner was told to start over, with no request to send, for the task they asked for.
const revisedRequirement = {
  summary: "Convert the uploaded PDF and return its text, without a preview step.",
  changes: [{ setting: "requirement", change: "drop", text: "Show a preview before converting." }],
  confirmedBy: ["task"],
  recommend: "update",
};

it("asks the caller to confirm when Guardian finds the minter's same-task update a new build", async () => {
  const updates = updateHost(["new_mint"]);
  const f = await fixture(
    (_request, index) =>
      [
        call("request_input", { questions: [{ id: "task", type: "text", prompt: "What next?" }] }),
        call("mint_update", revisedRequirement, "update"),
      ][index] ?? prose(),
    { ...updates.overrides, askInput: answering([{ task: "Skip the preview" }]) },
    { siteOrigin: site },
  );
  const outcome = await f.run();
  expect(resultOf(f.requests, "update")).toEqual({
    status: "clarification_required",
    userInputRequired: false,
    source: "guardian",
    rationale: "Scripted review.",
    instruction:
      "Nothing changed. Ask the caller with request_input about what the rationale says is unconfirmed, naming the change plainly, then call mint_update again naming the questions they answered in confirmedBy.",
  });
  expect(outcome).not.toHaveProperty("blocked");
  expect(updates.applied).toEqual([]);
});

it.each(["allow", "clarify", "reword", "new_mint"] as const)(
  "never ends a build as a new-build recommendation without a suggested request (Guardian %s)",
  async (decision) => {
    const updates = updateHost([decision]);
    const f = await fixture(
      (_request, index) =>
        [
          call("request_input", { questions: [{ id: "task", type: "text", prompt: "What next?" }] }),
          call("mint_update", revisedRequirement, "update"),
        ][index] ?? prose(),
      { ...updates.overrides, askInput: answering([{ task: "Skip the preview" }]) },
      { siteOrigin: site },
    );
    const outcome = await f.run();
    if (outcome.blocked?.reason === "new_mint_recommended")
      expect(outcome.blocked).toHaveProperty("suggestedRequest");
    expect(resultOf(f.requests, "update")?.["status"]).not.toBe("new_mint_recommended");
  },
);

// The owner said the change is the same task, and Guardian still called it a new build: asking the
// owner again would only repeat the loop until the build ran out of turns.
it("asks the minter to reword, not the owner again, when Guardian calls the same change a new build twice", async () => {
  const updates = updateHost(["new_mint", "new_mint"]);
  const sameTask = {
    questions: [
      {
        id: "same",
        type: "choice",
        prompt: "Is converting the PDF without a preview still the task you asked for?",
        options: [
          { id: "same", label: "Yes, the same task" },
          { id: "other", label: "No, a different task" },
        ],
      },
    ],
  };
  const f = await fixture(
    (_request, index) =>
      [
        call("request_input", { questions: [{ id: "task", type: "text", prompt: "What next?" }] }),
        call("mint_update", revisedRequirement, "first"),
        call("request_input", sameTask, "confirm"),
        // The retry rewords the summary and cites the owner's yes: still the same change.
        call(
          "mint_update",
          {
            ...revisedRequirement,
            summary: "Skip the preview and return the PDF's text, which the owner confirmed.",
            confirmedBy: ["task", "same"],
          },
          "second",
        ),
      ][index] ?? prose(),
    {
      ...updates.overrides,
      askInput: answering([{ task: "Skip the preview" }, { same: "same" }]),
    },
    { siteOrigin: site },
  );
  const outcome = await f.run();
  expect(resultOf(f.requests, "first")).toMatchObject({
    status: "clarification_required",
    source: "guardian",
  });
  expect(resultOf(f.requests, "second")).toEqual({
    status: "reword",
    userInputRequired: false,
    rationale: "Scripted review.",
    instruction:
      "Nothing changed, and the build continues under the current task. Revise the update using the rationale and call mint_update again, or continue without it.",
  });
  // Guardian still decided both, the second with the owner's yes before it.
  expect(updates.reviews).toHaveLength(2);
  expect(updates.reviews[1]?.update.confirmation.map(({ id }) => id)).toEqual(["task", "same"]);
  expect(outcome).not.toHaveProperty("blocked");
  expect(updates.applied).toEqual([]);
});

it("asks the owner again when Guardian calls a change a new build after an update applied", async () => {
  const updates = updateHost(["new_mint", "allow", "new_mint"]);
  const f = await fixture(
    (_request, index) =>
      [
        call("request_input", { questions: [{ id: "task", type: "text", prompt: "What next?" }] }),
        call("mint_update", revisedRequirement, "first"),
        call(
          "mint_update",
          {
            summary: "Convert the PDF the caller named.",
            changes: [{ setting: "input", values: { file: "notes.pdf" } }],
            confirmedBy: ["task"],
            recommend: "update",
          },
          "applied",
        ),
        call("mint_update", revisedRequirement, "later"),
      ][index] ?? prose(),
    { ...updates.overrides, askInput: answering([{ task: "Skip the preview" }]) },
    { siteOrigin: site },
  );
  await f.run();
  expect(resultOf(f.requests, "first")).toMatchObject({
    status: "clarification_required",
    source: "guardian",
  });
  expect(resultOf(f.requests, "applied")).toMatchObject({ status: "updated" });
  expect(resultOf(f.requests, "later")).toMatchObject({
    status: "clarification_required",
    source: "guardian",
  });
});

// Screening swaps a private value for a longer marker, so a suggested request under the limit as
// written can end past it. The ending used to drop it, and the caller got nothing to send.
it("asks the minter to shorten a suggested request that screening pushed past the limit", async () => {
  const updates = updateHost(["allow"]);
  const marker = "[a private value the host withheld from the caller]";
  const written =
    `Order the listed supplies on the other vendor's store for account ACCT-4471. ${"Keep the current quantities. ".repeat(14)}`.trim();
  expect(written.length).toBeLessThanOrEqual(500);
  expect(written.replaceAll("ACCT-4471", marker).length).toBeGreaterThan(500);
  const shorter = "Order the listed supplies on the other vendor's store.";
  const recommendation = {
    summary: "The caller now wants to order from another vendor's store.",
    changes: [{ setting: "purpose", text: "Order supplies on another vendor's store." }],
    confirmedBy: ["task"],
    recommend: "new_mint",
  };
  const f = await fixture(
    (_request, index) =>
      [
        call("request_input", { questions: [{ id: "task", type: "text", prompt: "What next?" }] }),
        call("mint_update", { ...recommendation, suggestedRequest: written }, "long"),
        call("mint_update", { ...recommendation, suggestedRequest: shorter }, "short"),
      ][index] ?? prose(),
    {
      ...updates.overrides,
      askInput: answering([{ task: "Use the other vendor" }]),
      redactCallerText: (text) => text.replaceAll("ACCT-4471", marker),
    },
    { siteOrigin: site },
  );
  const outcome = await f.run();
  expect(outcome.blocked).toEqual({
    reason: "new_mint_recommended",
    explanation: recommendation.summary,
    suggestedRequest: shorter,
  });
  expect(resultOf(f.requests, "long")).toEqual({
    status: "update_invalid",
    userInputRequired: false,
    reason: "suggested_request_too_long",
    instruction:
      "Private values in suggestedRequest made it longer than 500 characters once screened. Shorten it, leave private values out, and call mint_update again.",
  });
  // The long one never reached Guardian.
  expect(updates.reviews).toHaveLength(1);
  expect(updates.reviews[0]?.update.suggestedRequest).toBe(shorter);
});

it("keeps building after Guardian asks to reword an update", async () => {
  const updates = updateHost(["reword", "allow"]);
  const f = await fixture(
    (_request, index) =>
      [
        call("request_input", { questions: [{ id: "date", type: "text", prompt: "Which day?" }] }),
        call(
          "mint_update",
          {
            summary: "Change the day.",
            changes: [{ setting: "input", values: { day: "2026-11-02" } }],
            confirmedBy: ["date"],
            recommend: "update",
          },
          "first",
        ),
        call(
          "mint_update",
          {
            summary: "Look up notes for November 2 instead of November 1, as the caller asked.",
            changes: [{ setting: "input", values: { day: "2026-11-02" } }],
            confirmedBy: ["date"],
            recommend: "update",
          },
          "second",
        ),
        call("execute", example, "example"),
        call("finish_build", publication, "publish"),
      ][index] ?? prose(),
    { ...updates.overrides, askInput: answering([{ date: "November 2 instead" }]) },
    { siteOrigin: site },
  );
  const outcome = await f.run();
  expect(resultOf(f.requests, "first")).toMatchObject({
    status: "reword",
    rationale: "Scripted review.",
  });
  expect(resultOf(f.requests, "second")).toMatchObject({ status: "updated" });
  expect(updates.applied).toHaveLength(1);
  expect(updates.applied[0]?.next.businessInput).toEqual({ day: "2026-11-02" });
  expect(outcome.build).toBe("published");
});

it("asks the minter to confirm an update that cites no answered question", async () => {
  const updates = updateHost(["allow"]);
  const f = await fixture(
    (_request, index) =>
      [call("mint_update", { ...toWrite, confirmedBy: ["save"] }, "update")][index] ?? prose(),
    { ...updates.overrides, repeatableRead: true },
    { effect: "read", siteOrigin: site },
  );
  await f.run();
  expect(resultOf(f.requests, "update")).toMatchObject({
    status: "clarification_required",
    source: "host",
    unanswered: ["save"],
  });
  expect(updates.reviews).toEqual([]);
});

/** Execution receipts numbered in order, each completed with a protected result. */
const numberedExecutions = () => {
  let count = 0;
  const reviewAndExecute: MintDependencies["reviewAndExecute"] = (_input, beforeDispatch) =>
    (beforeDispatch?.(readAllow) ?? Effect.void).pipe(
      Effect.zipRight(
        Effect.sync(() => {
          count++;
          return {
            executionId: `execution_${count}`,
            status: "completed" as const,
            effect: "verified" as const,
            resultRef: `protected_${count}`,
            observations: { value: "public" },
          };
        }),
      ),
    );
  return reviewAndExecute;
};
const sister = "https://notes.example.org";
const siteQuestion = {
  questions: [
    {
      id: "site",
      type: "choice",
      prompt: `Your notes live on ${sister}. Build the tool there?`,
      options: [
        { id: "move", label: `Yes, use ${sister}` },
        { id: "stay", label: "No, stay here" },
      ],
    },
  ],
};
const toSister = {
  summary: `Build the tool on ${sister}, where the caller's notes live.`,
  changes: [{ setting: "site", origin: sister }],
  confirmedBy: ["site"],
  recommend: "update",
};

// Guardian judges a proposed change against the host's own record of the refusal that led to it,
// not only the minter's account of it.
it("shows the update review the host's publication refusal", async () => {
  const updates = updateHost(["allow"]);
  const decisions = memoryPublicationDecisions();
  const dateQuestion = {
    questions: [
      {
        id: "date",
        type: "choice",
        prompt: "The site does not take notes dated on a weekend. Use Monday instead?",
        options: [
          { id: "monday", label: "Yes, use Monday" },
          { id: "stop", label: "No, stop" },
        ],
      },
    ],
  };
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", { ...example, purpose: "act", target: "liveBrowser" }, "act"),
        call("finish_build", { ...publication, executionId: "execution_1" }, "refused"),
        call("request_input", dateQuestion, "ask"),
        call(
          "mint_update",
          {
            summary: "Date the note Monday, since the site refuses weekend dates.",
            changes: [{ setting: "input", values: { date: "monday" } }],
            confirmedBy: ["date"],
            recommend: "update",
          },
          "update",
        ),
      ][index] ?? prose(),
    {
      ...updates.overrides,
      askInput: answering([{ date: "monday" }]),
      reviewAndExecute: numberedExecutions(),
      publicationDecisions: decisions,
      publish: () =>
        Effect.fail(
          new MintFailure({ code: "PublicationUnavailable", reason: "write_not_submitted" }),
        ),
    },
    { effect: "write", siteOrigin: site },
  );
  await f.run();
  expect(resultOf(f.requests, "refused")).toMatchObject({ reason: "write_not_submitted" });
  const held = await Effect.runPromise(decisions.list);
  expect(held).toEqual([
    expect.objectContaining({ reason: "write_not_submitted", recovery: "write_completion" }),
  ]);
  expect(updates.reviews).toHaveLength(1);
  expect(updates.reviews[0]?.update.publicationDecisions).toEqual(held);
});

it("publishes after a site change only an example that ran on the new site", async () => {
  const updates = updateHost(["allow"]);
  const decisions = memoryPublicationDecisions();
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", example, "before"),
        call("request_input", siteQuestion, "ask"),
        call("mint_update", toSister, "update"),
        call("finish_build", { ...publication, executionId: "execution_1" }, "stale"),
        call("execute", example, "after"),
        call("finish_build", { ...publication, executionId: "execution_2" }, "publish"),
      ][index] ?? prose(),
    {
      ...updates.overrides,
      askInput: answering([{ site: "move" }]),
      repeatableRead: true,
      reviewAndExecute: numberedExecutions(),
      publicationDecisions: decisions,
    },
    { effect: "read", siteOrigin: site },
  );
  const outcome = await f.run();
  expect(resultOf(f.requests, "update")).toMatchObject({ status: "updated" });
  expect(resultOf(f.requests, "stale")).toMatchObject({
    status: "not_published",
    reason: "example_before_site_change",
  });
  expect(outcome.build).toBe("published");
  // The stale refusal is host evidence: a fresh example on the current site recovers it.
  expect(await Effect.runPromise(decisions.list)).toEqual([
    expect.objectContaining({
      outcome: "refused",
      reason: "example_before_site_change",
      executionId: "execution_1",
      recovery: "new_observation",
    }),
    expect.objectContaining({ outcome: "published", executionId: "execution_2" }),
  ]);
  expect(f.counts().published).toBe(1);
});

it("lets a read build that ran its live example become a write, and publishes only the write", async () => {
  const updates = updateHost(["allow"]);
  const decisions = memoryPublicationDecisions();
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", example, "read"),
        call("request_input", saveQuestion, "ask"),
        call("mint_update", toWrite, "update"),
        call("finish_build", { ...publication, executionId: "execution_1" }, "stale"),
        call("execute", { ...example, purpose: "act", target: "liveBrowser" }, "act"),
      ][index] ?? prose(),
    {
      ...updates.overrides,
      askInput: answering([{ save: "save" }]),
      repeatableRead: false,
      reviewAndExecute: numberedExecutions(),
      publicationDecisions: decisions,
    },
    { effect: "read", siteOrigin: site },
  );
  await f.run();
  // The read's receipt is refused as host evidence: the write itself is still to do.
  expect(await Effect.runPromise(decisions.list)).toEqual([
    expect.objectContaining({
      outcome: "refused",
      reason: "example_before_effect_change",
      executionId: "execution_1",
      recovery: "write_completion",
    }),
  ]);
  expect(resultOf(f.requests, "read")).toMatchObject({ status: "completed" });
  expect(resultOf(f.requests, "update")).toMatchObject({
    status: "updated",
    task: { revision: 1, effect: "write" },
  });
  expect(resultOf(f.requests, "stale")).toMatchObject({
    status: "not_published",
    reason: "example_before_effect_change",
  });
  expect(resultOf(f.requests, "act")).toMatchObject({ status: "completed" });
});

it("refuses a site change once the build cannot run another live example", async () => {
  const updates = updateHost(["allow"]);
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", example, "example"),
        call("request_input", siteQuestion, "ask"),
        call("mint_update", toSister, "update"),
      ][index] ?? prose(),
    { ...updates.overrides, askInput: answering([{ site: "move" }]), repeatableRead: false },
    { effect: "read", siteOrigin: site },
  );
  await f.run();
  expect(resultOf(f.requests, "update")).toMatchObject({
    status: "update_refused",
    reason: "no_live_example_left",
  });
  expect(String(resultOf(f.requests, "update")?.["instruction"])).toContain("new_mint");
  expect(updates.reviews).toEqual([]);
});

it("refuses a site change while the write session is open", async () => {
  const updates = updateHost(["allow"]);
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", { ...example, purpose: "act", target: "liveBrowser" }, "act"),
        call("request_input", siteQuestion, "ask"),
        call("mint_update", toSister, "update"),
      ][index] ?? prose(),
    { ...updates.overrides, askInput: answering([{ site: "move" }]) },
    { effect: "write", siteOrigin: site },
  );
  await f.run();
  expect(resultOf(f.requests, "act")).toMatchObject({ status: "completed" });
  expect(resultOf(f.requests, "update")).toMatchObject({
    status: "update_refused",
    reason: "write_session_open",
  });
  expect(updates.reviews).toEqual([]);
});

// A build that started on one site, such as a sign-in host, and needs another can't move on a host
// that can't move builds. Asking the caller to confirm a move the host then refuses wastes the
// build, so the host refuses the move when the minter proposes it, and the new build the minter
// recommends next shows Guardian the host's report.
it("refuses a site move when proposed on a host that can't move builds, and shows Guardian why", async () => {
  const updates = updateHost(["allow"]);
  const suggestedRequest = `Read the saved notes on ${sister}.`;
  const asked: AgentInputRequest[] = [];
  const f = await fixture(
    (_request, index) =>
      [
        call("mint_update", { ...toSister, confirmedBy: [] }, "move"),
        call("mint_update", toSister, "confirmed"),
        call(
          "mint_update",
          { ...toSister, confirmedBy: [], recommend: "new_mint", suggestedRequest },
          "new_build",
        ),
      ][index] ?? prose(),
    {
      ...updates.overrides,
      siteMoveUnsupported: true,
      askInput: (request) =>
        Effect.sync(() => {
          asked.push(request);
          return {};
        }),
    },
    { siteOrigin: site },
  );
  const outcome = await f.run();
  for (const id of ["move", "confirmed"]) {
    expect(resultOf(f.requests, id), id).toMatchObject({
      status: "update_refused",
      reason: "site_move_unsupported",
    });
    expect(String(resultOf(f.requests, id)?.["instruction"]), id).toContain("new_mint");
  }
  expect(asked).toEqual([]);
  expect(updates.reviews).toHaveLength(1);
  expect(updates.reviews[0]?.update).toMatchObject({
    recommend: "new_mint",
    siteMoveUnsupported: true,
  });
  expect(outcome.blocked).toMatchObject({ reason: "new_mint_recommended", suggestedRequest });
  expect(updates.applied).toEqual([]);
});

it("asks for the caller's confirmation before a change that widens what the build may do", async () => {
  const updates = updateHost(["allow"]);
  const f = await fixture(
    (_request, index) =>
      [
        call("mint_update", { ...toSister, confirmedBy: [] }, "site"),
        call("mint_update", { ...toWrite, confirmedBy: [] }, "write"),
      ][index] ?? prose(),
    { ...updates.overrides, repeatableRead: true },
    { effect: "read", siteOrigin: site },
  );
  await f.run();
  for (const id of ["site", "write"])
    expect(resultOf(f.requests, id), id).toMatchObject({
      status: "clarification_required",
      source: "host",
      reason: "confirmation_required",
    });
  expect(updates.reviews).toEqual([]);
});

// Fails when an applied update leaves the outcome reviewer unaware that the remaining work changed,
// or when a refused one tells it the work changed.
it("tells the outcome reviewer about an applied update, never a refused one", async () => {
  const updates = updateHost(["reword", "allow"]);
  const saved: OutcomeReviewSnapshot[] = [];
  const review: OutcomeReviewHost = {
    // A reviewer that takes its turns and never assesses, so the write stays unresolved.
    model: { turn: () => Effect.void },
    save: (snapshot) =>
      Effect.sync(() => {
        saved.push(snapshot);
      }),
    recordAssessment: () => Effect.void,
  };
  const dropCheck = {
    summary: "Save the note without checking its history first.",
    changes: [{ setting: "requirement", change: "drop", text: "Check the note's history first." }],
    confirmedBy: [],
    recommend: "update",
  };
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", { ...example, purpose: "act", target: "liveBrowser" }, "save"),
        call("mint_update", dropCheck, "refused"),
        call("mint_update", dropCheck, "applied"),
      ][index] ?? prose(),
    {
      ...updates.overrides,
      outcomeReview: review,
      reviewAndExecute: (_input, beforeDispatch) =>
        (beforeDispatch?.({ reviewId: "review_save", action: "write" }) ?? Effect.void).pipe(
          Effect.as({
            executionId: "save_1",
            status: "completed" as const,
            effect: "possible" as const,
            resultRef: "save_result",
            observations: { page: "Saved." },
            review: {
              reviewId: "review_save",
              outcome: "allow" as const,
              rationale: "Scripted review.",
              action: "write" as const,
            },
          }),
        ),
    },
    { effect: "write", siteOrigin: site },
  );
  await f.run();
  expect(resultOf(f.requests, "refused")).toMatchObject({ status: "reword" });
  expect(resultOf(f.requests, "applied")).toMatchObject({ status: "updated" });
  const events = saved.at(-1)?.events ?? [];
  expect(events.filter((event) => event.kind === "task_updated")).toEqual([
    expect.objectContaining({ change: expect.stringContaining(dropCheck.summary) as unknown }),
  ]);
});
