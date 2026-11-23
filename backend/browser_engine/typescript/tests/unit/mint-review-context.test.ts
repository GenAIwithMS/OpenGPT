import { DateTime, Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ReviewFailure, type ReviewedLiveTestBatch } from "../../src/guardian/review.js";
import { failureDetail } from "../../src/runtime/failure-detail.js";
import {
  allowedEffectsFor,
  cappedStepResult,
  contractExtractionNote,
  explorationAllowedEffect,
  currentDateObservations,
  makeStepResults,
  mintReviewContext,
  pageLocation,
  reviewDenied,
  reviewFailureOf,
  trackedWrites,
  type CurrentExecution,
  type ExecutionEntry,
  type MintReviewHost,
  type ObservedPage,
} from "../../src/mint/review-context.js";
import type { WriteOutcome } from "../../src/mint/outcome-review-contracts.js";
import { portableMintProjection } from "../support/portable-mint.js";

const projection = portableMintProjection(["private-schema-value"]);
const page: ObservedPage = {
  origin: "https://site.invalid",
  path: "/search?q=lamp#results",
  capture: "captures/current-page.aria.yml",
};
/** A host whose facts the test sets between reviews. */
const fakeHost = () => {
  const state = {
    repeatableRead: false,
    browser: "active" as ReturnType<MintReviewHost["browser"]>,
    observed: undefined as ObservedPage | undefined,
    executions: [] as ExecutionEntry[],
    inputSchema: undefined as unknown,
    signInCodes: [] as string[],
  };
  const host: MintReviewHost = {
    repeatableRead: () => state.repeatableRead,
    browser: () => state.browser,
    observedPage: () => state.observed,
    executions: () => state.executions,
    inputSchema: () => state.inputSchema,
    signInCodes: () => state.signInCodes,
  };
  return { state, host };
};
const sources = new Map([
  ["operation/src/tool.mjs", `import { readPage } from "./flow.mjs";\nexport default readPage;`],
  ["operation/src/flow.mjs", "export const readPage = `return document.title;`;"],
  ["operation/src/step.mjs", `import { readPage } from "./flow.mjs";\nexport default readPage;`],
  ["operation/command.sh", "ls src"],
]);
const context = (
  host: MintReviewHost,
  currentExecution?: CurrentExecution,
  step: { readonly entrypoint?: string; readonly startsOnFreshPage?: boolean } = {},
) =>
  Effect.runPromise(
    mintReviewContext(host, projection, {
      sources,
      entrypoint: step.entrypoint ?? "operation/src/tool.mjs",
      ...(currentExecution === undefined ? {} : { currentExecution }),
      ...(step.startsOnFreshPage === undefined
        ? {}
        : { startsOnFreshPage: step.startsOnFreshPage }),
    }),
  );
const live = (purpose: CurrentExecution["purpose"]): CurrentExecution => ({
  purpose,
  target: "liveBrowser",
});

describe("allowedEffectsFor", () => {
  it("gives a live act step the write session's text and other live steps the exploration text", () => {
    expect(allowedEffectsFor(live("act"))[0]).toMatch(/^The caller's requested task, done once/u);
    // A session on the agent's reading of the request may hold only values the request states.
    const derived = allowedEffectsFor({ ...live("act"), input: "intent_derived" })[0];
    expect(derived).toMatch(/^The caller's requested task, done once across this session's steps/u);
    expect(derived).toContain(
      "Every value in that input must be stated by the trusted intent or an answered question",
    );
    // What the page supplies stays under the general policy, and add-ons need the owner's word.
    expect(derived).toContain(
      "Values the page supplies, such as a site option the request selects, a default, a form token or a suggestion, follow the general policy as before.",
    );
    expect(derived).toContain(
      "An add-on, optional purchase, pre-selected paid option, saved payment or private detail is enabled, accepted or declined only as the trusted intent or an answered question says, never as that input alone says",
    );
    expect(derived).not.toContain("every value a step types, chooses or submits");
    for (const purpose of ["explore", "test", "example"] as const)
      expect(allowedEffectsFor(live(purpose))[0]).toMatch(/^Authorized repeatable reads/u);
  });

  it("gives a live read step a text that keeps the request's context out of its constraints", () => {
    // A date or place the request gives as context must not become a filter Guardian enforces.
    for (const purpose of ["explore", "test", "example", "inspect", "residual"] as const)
      expect(allowedEffectsFor(live(purpose))).toEqual([
        "Authorized repeatable reads, navigation, observation and transient search/query interactions, including query submission when its read semantics are established. Respect constraints the request states, such as a date range, filter, sort or limit. Context it gives, such as the current date or the caller's location, is not a constraint unless the request applies it. Navigating to and observing the site's public sign-in pages, including the site's own redirects to its sign-in origin, is allowed. Clicking the site's own sign-in link or button to open its sign-in screen or dialog is navigation, even when the page says results need a login. Entering or submitting a username, email, phone number, password or code, submitting a sign-in step, or switching accounts is not: credential submission belongs only to the host-owned authenticate step. After the host has signed in, entering the caller's own input into a context step that asks for no username, email, phone number, password, code, date of birth, ZIP or security answer and does not verify who the user is, such as choosing a supplier, company, client or language, and continuing past it is navigation, not a sign-in step or an account switch. No autosave, holds, drafts, uploads, business commitments, account changes or other writes, even for exploration/test setup.",
      ]);
  });

  it("is the exploration text other hosts give their own exploration steps", () => {
    expect(allowedEffectsFor(live("explore"))).toEqual([explorationAllowedEffect]);
  });

  it("gives a live sign-in step the sign-in text and every offline step the offline text", () => {
    // The host fills a signInStep itself; an authored sign-in writes secret handles in its source.
    expect(allowedEffectsFor(live("authenticate"))).toEqual([
      "Signing in on the site's own sign-in page: the step enters the login and codes the caller supplied privately, either filled by the host or written as secret handles in the step's source, submits them, and checks whether the account is signed in. Nothing else on the site may change.",
    ]);
    for (const purpose of ["command", "contract", "test", "example"] as const)
      expect(allowedEffectsFor({ purpose, target: "pureFiles" })).toEqual([
        "Offline local files, source checks and computation only. No live website, credentials or network.",
      ]);
  });

  it("names no hosted service in any text", () => {
    for (const purpose of ["act", "explore", "authenticate"] as const)
      expect(allowedEffectsFor(live(purpose)).join(" ")).not.toMatch(/kernel|vault|managed auth/iu);
  });
});

describe("mintReviewContext", () => {
  it("gives Guardian the page the host last observed", async () => {
    const { state, host } = fakeHost();
    const pages: unknown[] = [];
    const review = async (current?: CurrentExecution, startsOnFreshPage = false) =>
      pages.push((await context(host, current, { startsOnFreshPage })).currentPage);
    await review({ purpose: "command", target: "pureFiles" });
    await review(live("explore"));
    state.observed = page;
    await review(live("explore"));
    // A step that starts on a fresh page does not read the page left open.
    await review(live("example"), true);
    await review(live("explore"));
    await review({ purpose: "command", target: "pureFiles" });
    // An observation that could not say which page is current leaves none.
    state.observed = undefined;
    await review(live("explore"));
    expect(pages).toEqual([undefined, undefined, page, undefined, page, page, undefined]);
  });

  it("gives a question review only the observed page, and no page from a browser that is not active", async () => {
    const { state, host } = fakeHost();
    state.observed = page;
    const question = await context(host);
    expect(question.currentPage).toEqual(page);
    expect(question).not.toHaveProperty("currentExecution");
    expect(question).not.toHaveProperty("executedSources");
    for (const browser of ["not_opened", "closed", "unavailable"] as const) {
      state.browser = browser;
      expect(await context(host, live("explore"))).not.toHaveProperty("currentPage");
    }
  });

  it("gives an execution review the sign-in codes the host lists, and a question review none", async () => {
    const { state, host } = fakeHost();
    expect(await context(host, live("explore"))).not.toHaveProperty("signInCodes");
    state.signInCodes = ["{{secret.s1}}"];
    const reviewed = await context(host, live("explore"));
    expect(reviewed.signInCodes).toEqual(["{{secret.s1}}"]);
    // The host's list is copied, so a code it notes later reaches only later reviews.
    state.signInCodes.push("{{secret.s2}}");
    expect(reviewed.signInCodes).toEqual(["{{secret.s1}}"]);
    expect(await context(host)).not.toHaveProperty("signInCodes");
  });

  it("tells an execution review which operation files its entrypoint imports", async () => {
    const { host } = fakeHost();
    const reviewed = await context(host, live("explore"));
    expect(reviewed.operationSources).toEqual([...sources.keys()]);
    expect(reviewed.executedSources).toEqual(
      expect.arrayContaining(["operation/src/tool.mjs", "operation/src/flow.mjs"]),
    );
    expect(reviewed.executedSources).not.toContain("operation/src/step.mjs");
    expect(reviewed.executedSources).not.toContain("operation/command.sh");
  });

  it.each([
    ["a query", `import op from "./step.mjs?v=1";\nexport default op;`, {}],
    ["a fragment", `import op from "./step.mjs#x";\nexport default op;`, {}],
    ["a percent escape", `import op from "./st%65p.mjs";\nexport default op;`, {}],
    [
      "createRequire",
      `import { createRequire } from "node:module";\nconst op = createRequire(import.meta.url)("./step.mjs");\nexport default op;`,
      {},
    ],
    ["eval", `const op = await eval('import("./step.mjs")');\nexport default op.default;`, {}],
    [
      "the Function constructor",
      `const load = (() => {}).constructor('return import("./step.mjs")');\nexport default (await load()).default;`,
      {},
    ],
    [
      "an absolute path",
      `import op from "/workspace/operation/src/step.mjs";\nexport default op;`,
      {},
    ],
    [
      "a child process",
      `import { execFileSync } from "node:child_process";\nexecFileSync("node", ["./step.mjs"]);\nexport default {name:'read'};`,
      {},
    ],
    [
      "a package import",
      `import op from "#step";\nexport default op;`,
      { "operation/src/package.json": JSON.stringify({ imports: { "#step": "./step.mjs" } }) },
    ],
  ] as const)(
    "keeps every candidate file when the entrypoint loads one through %s",
    async (_, tool, extra) => {
      const { host } = fakeHost();
      const reviewed = await Effect.runPromise(
        mintReviewContext(host, projection, {
          sources: new Map([
            ["operation/src/tool.mjs", tool],
            ["operation/src/step.mjs", "export default {};"],
            ...Object.entries(extra),
          ]),
          entrypoint: "operation/src/tool.mjs",
          currentExecution: live("explore"),
        }),
      );
      expect(reviewed.executedSources).toContain("operation/src/step.mjs");
    },
  );

  it("gives an offline command its sandbox facts and no executed files or input schema", async () => {
    const { state, host } = fakeHost();
    state.inputSchema = { type: "object" };
    const command: CurrentExecution = {
      purpose: "command",
      target: "pureFiles",
      commandSandbox: { cwd: "/tmp/workspace", timeoutSeconds: 30, maxOutputBytes: 1_048_576 },
    };
    const reviewed = await context(host, command, { entrypoint: "operation/command.sh" });
    expect(reviewed.currentExecution).toEqual(command);
    expect(reviewed).not.toHaveProperty("executedSources");
    expect(reviewed).not.toHaveProperty("inputSchema");
  });

  it("gives each execution review the input schema the host last read, screened", async () => {
    const { state, host } = fakeHost();
    expect(await context(host, live("example"))).not.toHaveProperty("inputSchema");
    state.inputSchema = {
      type: "object",
      properties: { guests: { type: "integer", description: "private-schema-value" } },
    };
    const reviewed = await context(host, { purpose: "test", target: "liveBrowser" });
    expect(JSON.parse(reviewed.inputSchema ?? "null")).toEqual({
      type: "object",
      properties: { guests: { type: "integer", description: "[private]" } },
    });
    expect(await context(host)).not.toHaveProperty("inputSchema");
  });

  it("carries the host's read authority, browser state and step history", async () => {
    const { state, host } = fakeHost();
    state.repeatableRead = true;
    state.browser = "not_opened";
    state.executions = [
      {
        executionId: "unresolved_1",
        attempt: "current",
        purpose: "test",
        target: "liveBrowser",
        status: "running",
        effect: "possible",
        input: "agent_chosen",
      },
    ];
    expect(await context(host, live("test"))).toMatchObject({
      repeatableRead: true,
      browser: "not_opened",
      executions: state.executions,
    });
  });

  it("gives an execution review each tracked write with its newest assessment, and a question review none", async () => {
    const writes: readonly WriteOutcome[] = [
      {
        write: {
          executionId: "write_1",
          purpose: "act",
          entrypoint: "src/save.mjs",
          sourceDigest: "digest_1",
          status: "completed",
          effect: "possible",
        },
        status: "applied",
        assessment: {
          executionId: "write_1",
          version: 2,
          outcome: "done",
          explanation: "The saved note is listed.",
          evidence: ["execution:read_1"],
          assessedAt: 0,
        },
      },
      {
        write: {
          executionId: "write_2",
          purpose: "act",
          status: "result_lost",
          effect: "possible",
        },
        status: "may_have_applied",
      },
    ];
    const tracked = [
      { executionId: "write_1", purpose: "act", entrypoint: "src/save.mjs", outcome: "done" },
      { executionId: "write_2", purpose: "act", outcome: "unassessed" },
    ];
    expect(trackedWrites(writes)).toStrictEqual(tracked);
    const { host } = fakeHost();
    const withWrites: MintReviewHost = { ...host, writes: () => writes };
    expect((await context(withWrites, live("act"))).writes).toStrictEqual(tracked);
    expect(await context(withWrites)).not.toHaveProperty("writes");
    expect(await context(host, live("act"))).not.toHaveProperty("writes");
  });

  it("gives an execution review the judged live test batches, and a question review none", async () => {
    const batches: readonly ReviewedLiveTestBatch[] = [
      {
        batchId: "review_batch",
        entrypoint: "operation/src/tool.mjs",
        sourceDigest: "digest_1",
        sourceUnchanged: true,
        cases: [
          { id: "cold-1", verdict: "pass", start: "cold" },
          { id: "warm-1", verdict: "fail", start: "warm" },
        ],
      },
    ];
    const { host } = fakeHost();
    const withBatches: MintReviewHost = { ...host, liveTests: () => Effect.succeed(batches) };
    expect((await context(withBatches, live("example"))).liveTests).toStrictEqual(batches);
    expect(await context(withBatches)).not.toHaveProperty("liveTests");
    expect(await context(host, live("example"))).not.toHaveProperty("liveTests");
    // Bound with none on record, as after a takeover: the review is told so.
    const noneYet: MintReviewHost = { ...host, liveTests: () => Effect.succeed([]) };
    expect((await context(noneYet, live("example"))).liveTests).toStrictEqual([]);
  });
});

describe("makeStepResults", () => {
  it("gives each execution review the last six step results the agent saw, capped at 4 KiB", () => {
    const results = makeStepResults();
    expect(results.forReview(live("explore"))).toEqual({ stepResults: [] });
    for (let step = 1; step <= 7; step++)
      results.record(`step_${step}`, {
        url: `https://www.site.invalid/booking/${step}?venue=42`,
        ...(step === 7 ? { page: "<p>seat é</p>".repeat(900) } : {}),
      });
    results.record("step_8", "Error: no Book button on the redirected page");
    const { stepResults = [] } = results.forReview(live("example"));
    expect(stepResults.map((step) => step.executionId)).toEqual([
      "step_3",
      "step_4",
      "step_5",
      "step_6",
      "step_7",
      "step_8",
    ]);
    for (const step of stepResults)
      expect(new TextEncoder().encode(step.result).byteLength).toBeLessThanOrEqual(4096);
    expect(stepResults[4]?.result).toContain("https://www.site.invalid/booking/7?venue=42");
    expect(stepResults[4]?.result.endsWith("…[truncated at 4 KiB]")).toBe(true);
    expect(stepResults[4]?.result).not.toContain("�");
    expect(stepResults[5]?.result).toBe("Error: no Book button on the redirected page");
  });

  it("caps one result at 4 KiB, cut on a character and marked", () => {
    const marker = "…[truncated at 4 KiB]";
    expect(cappedStepResult("a".repeat(4096))).toBe("a".repeat(4096));
    const room = 4096 - new TextEncoder().encode(marker).byteLength;
    expect(cappedStepResult("a".repeat(4097))).toBe(`${"a".repeat(room)}${marker}`);
    // A two-byte character the cut splits is dropped whole, never kept as a replacement character.
    const split = cappedStepResult(`${"a".repeat(room - 1)}é${"b".repeat(100)}`);
    expect(split).toBe(`${"a".repeat(room - 1)}${marker}`);
  });

  it("keeps step results out of question reviews", () => {
    const results = makeStepResults();
    results.record("step_1", { value: 1 });
    expect(results.forReview(undefined)).toEqual({});
  });
});

describe("pageLocation", () => {
  it("reads an origin and a path with its query and fragment", () => {
    expect(pageLocation(new URL("https://site.invalid/search?q=lamp#results"))).toEqual({
      origin: "https://site.invalid",
      path: "/search?q=lamp#results",
    });
  });

  it("keeps a blank page and gives no page for a browser error page", () => {
    expect(pageLocation(new URL("about:blank"))).toEqual({ origin: "about:blank", path: "" });
    expect(pageLocation(new URL("chrome-error://chromewebdata/"))).toBeUndefined();
  });
});

describe("observations", () => {
  it("dates a build with the host's clock in UTC", () => {
    expect(currentDateObservations(DateTime.unsafeMake("2026-03-14T09:26:53.589Z"))).toEqual({
      todayUtc: "2026-03-14",
      nowUtc: "2026-03-14T09:26:53.589Z",
    });
  });

  it("describes contract extraction without hosted services", () => {
    expect(contractExtractionNote).toContain("never calls operation.run");
    expect(contractExtractionNote).not.toMatch(/kernel|sandbox|capture/iu);
  });
});

describe("reviewFailureOf", () => {
  it("preserves finite review phase before any browser or executor dispatch", () => {
    const failure = reviewFailureOf(
      new ReviewFailure({ code: "Unavailable", reviewPhase: "review_computation" }),
      "not_sent",
    );
    expect(failure).toMatchObject({
      code: "ReviewUnavailable",
      reviewFailure: "Unavailable",
      reviewPhase: "review_computation",
      reviewDispatch: "not_sent",
    });
    expect(failure).not.toHaveProperty("modelOutage");
  });

  it("marks a spent model quota and keeps the failure's detail", () => {
    const failure = reviewFailureOf(
      new ReviewFailure({
        code: "Unavailable",
        modelQuotaExhausted: true,
        failureDetail: failureDetail("guardian_dependency_failed", { operation: "guardian.model" }),
      }),
    );
    expect(failure).toMatchObject({
      code: "ReviewUnavailable",
      reviewFailure: "Unavailable",
      modelOutage: "quota_exhausted",
      failureDetail: { operation: "guardian.model" },
    });
    expect(failure).not.toHaveProperty("reviewDispatch");
  });
});

describe("reviewDenied", () => {
  it("turns a deny or an escalation into a ReviewDenied refusal with its rationale", () => {
    expect(reviewDenied("review_1", { outcome: "deny", rationale: "Denied" })).toMatchObject({
      code: "ReviewDenied",
      review: { outcome: "deny", rationale: "Denied", reviewId: "review_1" },
    });
    expect(reviewDenied("review_2", { outcome: "escalate", rationale: "Ask" }).review).toEqual({
      outcome: "escalate",
      rationale: "Ask",
      reviewId: "review_2",
    });
  });
});
