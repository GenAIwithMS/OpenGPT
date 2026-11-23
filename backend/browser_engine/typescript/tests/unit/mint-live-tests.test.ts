import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Usage } from "@openai/agents";
import type { ModelProvider, ModelRequest, ModelResponse } from "@openai/agents";
import { Effect, Either, Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import {
  MintFailure,
  type LiveTestBatch,
  type LiveTestBatchResult,
  type LiveTestHost,
  type MintDependencies,
  MintHarnessSnapshot,
  type PublicationDecision,
} from "../../src/mint/contracts.js";
import type { ReviewedLiveTestBatch } from "../../src/guardian/review.js";
import type { LiveTestOutcome } from "../../src/mint/live-tests.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import type { MintAgentSnapshot, MintRecoveryFactory } from "../../src/mint/recovery-contracts.js";
import { Deadline } from "../../src/runtime/deadline.js";
import type { FieldFill } from "../../src/runtime/output-lint.js";
import { validateAnswer } from "../../src/runtime/input-request.js";
import { makeMintContinuationFixture, readAllow } from "../support/mint-fixtures.js";
import { portableJobSession } from "../support/portable-mint.js";

// A read signed out designs its own live test cases, runs them as batches and reads every result;
// publication review gets the host's own record of them. These drive the minter's live_tests tool
// through scripted model turns.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);
const read = { effect: "read", siteOrigin: "https://shop.example.test" } as const;

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
/** The JSON a tool call returned, as the next model request carries it. */
const resultOf = (request: ModelRequest | undefined, callId: string): Record<string, unknown> => {
  const input = request?.input;
  if (!Array.isArray(input)) throw new Error("Missing history");
  const item = input.find(
    (entry) => entry.type === "function_call_result" && entry.callId === callId,
  ) as { readonly output?: unknown } | undefined;
  const output = item?.output;
  const text =
    typeof output === "string"
      ? output
      : typeof output === "object" && output !== null && "text" in output
        ? String(output.text)
        : JSON.stringify(output);
  return JSON.parse(text) as Record<string, unknown>;
};

const example = {
  purpose: "example",
  target: "liveBrowser",
  entrypoint: "src/tool.ts",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 60,
};
const finish = {
  entrypoint: "src/tool.ts",
  executionId: "execution_one",
  metadata: { name: "search_catalog", description: "Search a synthetic catalog" },
  coverage: "The example searched one query.",
};
const plan = { action: "plan", entrypoint: "src/tool.ts", cases: null, maxWorkers: null };
const runAll = { action: "run", entrypoint: "src/tool.ts", cases: null, maxWorkers: 3 };

interface ToolSchemas {
  readonly input: unknown;
  readonly output: unknown;
}

/** A search tool's declared schemas, as the host reads them offline. */
const schemas = {
  input: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string" },
      sort: { enum: ["relevance", "price_low", "price_high"] },
      in_stock: { type: "boolean" },
      cursor: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
  },
  output: {
    type: "object",
    required: ["results", "has_next_page", "next_cursor"],
    properties: {
      results: { type: "array", items: { type: "object" } },
      has_next_page: { type: "boolean" },
      next_cursor: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
  },
};

const cases = {
  cases: [
    { id: "repeat-1", purpose: "The example on a fresh browser.", input: { query: "lamp" }, expect: "result" },
    {
      id: "sort-price",
      purpose: "Sorting by price reorders the results.",
      input: { query: "lamp", sort: "price_low" },
      expect: "result",
    },
    { id: "nothing", purpose: "A query with no results.", input: { query: "zzqx" }, expect: "empty" },
    {
      id: "page-2",
      purpose: "Page two through the cursor page one returned.",
      input: { query: "lamp" },
      expect: "result",
      next_page: true,
    },
  ],
  notTested: [{ what: "A sort the site does not offer", reason: "Every sort is offered." }],
};

/**
 * `file` with `count` more cases that pass on the host's default results, so that a test about
 * failing cases still has at least 70% of its cases passing and its publication goes to review.
 */
const withPassing = <F extends { readonly cases: readonly object[] }>(file: F, count: number) => ({
  ...file,
  cases: [
    ...file.cases,
    ...Array.from({ length: count }, (_unused, index) => ({
      id: `also-${index + 1}`,
      purpose: "Another query returns its results.",
      input: { query: `also ${index + 1}` },
      expect: "result",
    })),
  ],
});

/** A host that runs each case through `outcomes`, recording each batch it was asked to run. */
/** Each case's outcome, the same for every batch or by the batch's index. */
type Outcomes =
  | Readonly<Record<string, LiveTestOutcome>>
  | ((batch: number) => Readonly<Record<string, LiveTestOutcome>>);

/**
 * A host that supports signed-in batches unless `signedInBatches` is false, and reads the tool's
 * schemas from `schemasNow` each time it reads them, `schemas` unless given.
 */
const liveTestHost = (
  outcomes: Outcomes,
  result?: LiveTestBatchResult,
  {
    signedInBatches = true,
    schemasNow = () => schemas,
  }: { readonly signedInBatches?: boolean; readonly schemasNow?: () => ToolSchemas } = {},
) => {
  const batches: LiveTestBatch[] = [];
  const host: LiveTestHost = {
    maxWorkers: 3,
    ...(signedInBatches ? { signedInBatches: true as const } : {}),
    schemas: () => Effect.sync(schemasNow),
    run: (batch) =>
      Effect.sync(() => {
        batches.push(batch);
        const now = typeof outcomes === "function" ? outcomes(batches.length - 1) : outcomes;
        return (
          result ?? {
            status: "ran" as const,
            reviewId: "review_batch",
            lanes: Math.min(batch.workers, batch.cases.length),
            cases: batch.cases.map((testCase, index) => ({
              id: testCase.id,
              outcome: now[testCase.id] ?? {
                status: "completed" as const,
                output: { results: [{ name: "Lamp" }], has_next_page: true, next_cursor: "c2" },
              },
              durationMs: 20_000,
              lane: index % batch.workers,
              // Each lane past the build's own browser opens new, so its first case runs cold.
              start: index > 0 && index < batch.workers ? ("cold" as const) : ("warm" as const),
            })),
          }
        );
      }),
  };
  return { host, batches };
};

const writeWorkspace = async (root: string, files: Readonly<Record<string, string>>) => {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
};
const toolSource = "export default { name: 'search_catalog' };\n";

/** Publication requests and the host evidence each received. */
const publications = () => {
  const seen: { coverage: string; liveTests?: object; testedFields?: readonly FieldFill[] }[] = [];
  const publish: MintDependencies["publish"] = (request, _evidence, hostEvidence) =>
    Effect.sync(() => {
      seen.push({
        coverage: request.coverage,
        ...(hostEvidence?.liveTests === undefined ? {} : { liveTests: hostEvidence.liveTests }),
        ...(hostEvidence?.testedFields === undefined ? {} : { testedFields: hostEvidence.testedFields }),
      });
      return { publicationRef: "published_revision", diagnostics: [] };
    });
  return { seen, publish };
};

const completedExample: MintDependencies["reviewAndExecute"] = (_input, beforeDispatch) =>
  (beforeDispatch?.(readAllow) ?? Effect.void).pipe(
    Effect.as({
      executionId: "execution_one",
      status: "completed" as const,
      effect: "verified" as const,
      resultRef: "protected_result",
      observations: { results: 3 },
    }),
  );

it("runs the cases a read designed as one batch and hands publication the host's record", async () => {
  const { host, batches } = liveTestHost({
    "sort-price": {
      status: "failed",
      errorClass: "TimeoutError",
      message: "locator.click: Timeout 5000ms exceeded",
      frame: "src/tool.ts:12",
    },
    nothing: { status: "completed", output: { results: [], has_next_page: false, next_cursor: null } },
  });
  const published = publications();
  let root = "";
  const f = await fixture(
    async (_request, index) => {
      if (index === 1) await writeWorkspace(root, { "test/cases.json": JSON.stringify(cases) });
      return (
        [
          call("live_tests", plan, "plan"),
          call("execute", example, "example"),
          call("live_tests", runAll, "run"),
          call("finish_build", finish, "finish"),
        ][index] ?? prose()
      );
    },
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource });
  const outcome = await f.run();

  // Before any case exists, the plan lists none; the host builds no checklist from the schemas.
  const planned = resultOf(f.requests[1], "plan");
  expect(planned["cases"]).toEqual([]);

  // The first passing example's receipt reminds the agent of its cases.
  const receipt = resultOf(f.requests[2], "example");
  expect(receipt["testPlan"]).toMatchObject({ plannedCases: 4 });

  // One batch, every case, with the next page's cursor fields (the string cursor, never the
  // boolean beside it), at most three at once.
  expect(batches).toHaveLength(1);
  expect(batches[0]?.workers).toBe(3);
  expect(batches[0]?.cases.map((testCase) => testCase.id)).toEqual([
    "repeat-1",
    "sort-price",
    "nothing",
    "page-2",
  ]);
  expect(batches[0]?.cases.find((testCase) => testCase.id === "page-2")?.nextPage).toEqual({
    inputField: "cursor",
    outputField: "next_cursor",
  });

  // The agent sees every result, a failure with the line that threw.
  const ran = resultOf(f.requests[3], "run");
  expect(ran["status"]).toBe("ran");
  expect(ran["cases"]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "repeat-1", purpose: "The example on a fresh browser.", status: "pass" }),
      expect.objectContaining({ id: "nothing", status: "pass", got: "empty" }),
      expect.objectContaining({
        id: "sort-price",
        status: "fail",
        errorClass: "TimeoutError",
        frame: "src/tool.ts:12",
      }),
    ]),
  );

  // One failing case of four never refuses publication by itself: 75% clears the 70% bar, and
  // the review reads the host's record.
  expect(outcome.build).toBe("published");
  expect(published.seen).toHaveLength(1);
  // The record lists each case with its purpose, input and verdict, and what was not tested.
  const record = published.seen[0]?.liveTests as {
    cases: { id: string; input: unknown; results: Record<string, unknown> }[];
    notTested: unknown;
  };
  expect(record.cases).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "sort-price",
        purpose: "Sorting by price reorders the results.",
        input: { query: "lamp", sort: "price_low" },
        results: { playwright: expect.objectContaining({ status: "fail" }) },
      }),
    ]),
  );
  expect(record.notTested).toEqual(cases.notTested);
  // Each result says how its browser started, and each version counts the cases that passed cold.
  expect(
    record.cases.map((entry) => (entry.results["playwright"] as { start?: string }).start).sort(),
  ).toEqual(["cold", "cold", "warm", "warm"]);
  expect((published.seen[0]?.liveTests as { versions: unknown[] }).versions).toEqual([
    expect.objectContaining({ version: "playwright", coldPasses: 1 }),
  ]);
  expect(published.seen[0]?.coverage).toContain(
    "4 cases. Playwright version (src/tool.ts): 3 pass, 1 fail, 0 inconclusive; 1 passed cold.",
  );
});

it("marks results stale in the publication record when the source changed after they ran", async () => {
  const { host } = liveTestHost({});
  const published = publications();
  let root = "";
  const f = await fixture(
    async (_request, index) => {
      // The agent edits the source after the batch and publishes without running it again.
      if (index === 3) await writeWorkspace(root, { "src/tool.ts": `${toolSource}// edited\n` });
      return (
        [
          call("execute", example, "example"),
          call("live_tests", runAll, "run"),
          call("execute", example, "again"),
          call("finish_build", finish, "finish"),
        ][index] ?? prose()
      );
    },
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      repeatableRead: true,
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(cases) });
  await f.run();
  const record = published.seen[0]?.liveTests as { cases: { results: { playwright: { status: string } } }[] };
  expect(record.cases.map((testCase) => testCase.results.playwright.status)).toEqual([
    "stale",
    "stale",
    "stale",
    "stale",
  ]);
});

it("gives the example's review each judged batch, and whether its source is still the one it ran", async () => {
  const { host } = liveTestHost({
    nothing: { status: "completed", output: { results: [{ name: "Lamp" }], has_next_page: false, next_cursor: null } },
  });
  let batches: Effect.Effect<readonly ReviewedLiveTestBatch[]> | undefined;
  const binding: LiveTestHost = {
    ...host,
    bindBatches: (read) => {
      batches = read;
    },
  };
  // What the host's review of each example would put in its trusted context.
  const reviewed: (readonly ReviewedLiveTestBatch[])[] = [];
  const reviewAndExecute: MintDependencies["reviewAndExecute"] = (input, beforeDispatch) =>
    Effect.gen(function* () {
      reviewed.push(yield* batches ?? Effect.succeed([]));
      return yield* completedExample(input, beforeDispatch);
    });
  let root = "";
  const f = await fixture(
    async (_request, index) => {
      // After the first example passes, the agent edits the source and runs the example again.
      if (index === 2) await writeWorkspace(root, { "src/tool.ts": `${toolSource}// edited\n` });
      return (
        [
          call("live_tests", runAll, "run"),
          call("execute", example, "example"),
          call("execute", example, "edited"),
        ][index] ?? prose()
      );
    },
    { liveTests: binding, deadline: Deadline.after(30 * 60_000), repeatableRead: true, reviewAndExecute },
    read,
  );
  root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(cases) });
  await f.run();

  const batch = {
    batchId: "review_batch",
    entrypoint: "operation/src/tool.ts",
    sourceDigest: expect.any(String),
    cases: [
      { id: "repeat-1", verdict: "pass", start: "warm" },
      { id: "sort-price", verdict: "pass", start: "cold" },
      { id: "nothing", verdict: "fail", start: "cold" },
      { id: "page-2", verdict: "pass", start: "warm" },
    ],
  };
  // The example right after the batch runs the source the batch ran; the one after the edit does not.
  expect(reviewed).toEqual([
    [{ ...batch, sourceUnchanged: true }],
    [{ ...batch, sourceUnchanged: false }],
  ]);
});

it("keeps a batch whose failure still stands on the source in the example review's window", async () => {
  // `nothing` expects no results and gets some, so it fails every time it runs.
  const { host } = liveTestHost({
    nothing: { status: "completed", output: { results: [{ name: "Lamp" }], has_next_page: false, next_cursor: null } },
  });
  let batches: Effect.Effect<readonly ReviewedLiveTestBatch[]> | undefined;
  const binding: LiveTestHost = {
    ...host,
    bindBatches: (read) => {
      batches = read;
    },
  };
  const reviewed: (readonly ReviewedLiveTestBatch[])[] = [];
  const reviewAndExecute: MintDependencies["reviewAndExecute"] = (input, beforeDispatch) =>
    Effect.gen(function* () {
      reviewed.push(yield* batches ?? Effect.succeed([]));
      return yield* completedExample(input, beforeDispatch);
    });
  const only = (ids: readonly string[]) => ({ ...runAll, cases: ids });
  const f = await fixture(
    (_request, index) =>
      [
        // The whole suite, with `nothing` failing; then only the passing cases, in later batches
        // that would push the failing one out of a window of the latest four.
        call("live_tests", runAll, "all"),
        call("live_tests", only(["repeat-1", "sort-price", "page-2"]), "passing"),
        call("live_tests", only(["repeat-1"]), "one"),
        call("live_tests", only(["sort-price"]), "two"),
        call("live_tests", only(["page-2"]), "three"),
        call("execute", example, "example"),
      ][index] ?? prose(),
    { liveTests: binding, deadline: Deadline.after(30 * 60_000), reviewAndExecute },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(cases) });
  await f.run();

  // The example's review still sees `nothing` failing on the source it runs.
  const failing = (reviewed[0] ?? []).flatMap((batch) =>
    batch.sourceUnchanged ? batch.cases.filter((ran) => ran.verdict !== "pass").map((ran) => ran.id) : [],
  );
  expect(failing).toEqual(["nothing"]);
});

/**
 * Runs `batches` in turn, each a list of case ids on an entrypoint, with each batch's outcomes by
 * its index, then the example on src/tool.ts; returns the non-passing cases the example's review
 * sees on unchanged source, with their verdicts.
 */
const failuresSeenByExample = async (
  batches: readonly {
    readonly entrypoint: string;
    readonly cases: readonly string[];
    /** src/tool.ts as the agent rewrites it before this batch runs. */
    readonly source?: string;
  }[],
  outcomes: (batch: number) => Readonly<Record<string, LiveTestOutcome>>,
  /** src/tool.ts as the agent leaves it before the example. */
  sourceAtExample?: string,
) => {
  const { host } = liveTestHost(outcomes);
  let bound: Effect.Effect<readonly ReviewedLiveTestBatch[]> | undefined;
  const binding: LiveTestHost = {
    ...host,
    bindBatches: (batchesNow) => {
      bound = batchesNow;
    },
  };
  const reviewed: (readonly ReviewedLiveTestBatch[])[] = [];
  const reviewAndExecute: MintDependencies["reviewAndExecute"] = (input, beforeDispatch) =>
    Effect.gen(function* () {
      reviewed.push(yield* bound ?? Effect.succeed([]));
      return yield* completedExample(input, beforeDispatch);
    });
  let root = "";
  const f = await fixture(
    async (_request, index) => {
      const source = index < batches.length ? batches[index]?.source : sourceAtExample;
      if (index <= batches.length && source !== undefined)
        await writeWorkspace(root, { "src/tool.ts": source });
      return (
        [
          ...batches.map(({ entrypoint, cases: ids }, batch) =>
            call("live_tests", { ...runAll, entrypoint, cases: ids }, `batch-${batch}`),
          ),
          call("execute", example, "example"),
        ][index] ?? prose()
      );
    },
    { liveTests: binding, deadline: Deadline.after(30 * 60_000), reviewAndExecute },
    read,
  );
  root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, {
    "src/tool.ts": toolSource,
    "src/other.ts": `${toolSource}// another version\n`,
    "test/cases.json": JSON.stringify(cases),
  });
  await f.run();
  return (reviewed[0] ?? []).flatMap((batch) =>
    batch.sourceUnchanged && batch.entrypoint === "operation/src/tool.ts"
      ? batch.cases.filter((ran) => ran.verdict !== "pass").map((ran) => `${ran.id}:${ran.verdict}`)
      : [],
  );
};
const allCases = ["repeat-1", "sort-price", "nothing", "page-2"];
const singles = ["repeat-1", "sort-price", "page-2"].map((id) => ({ entrypoint: "src/tool.ts", cases: [id] }));
const resultsForNothing = {
  nothing: { status: "completed", output: { results: [{ name: "Lamp" }], has_next_page: false, next_cursor: null } },
} as const;
/** `nothing` finds no results, as it expects, so it passes. */
const nothingPasses = {
  nothing: { status: "completed", output: { results: [], has_next_page: false, next_cursor: null } },
} as const;

it("keeps a failure in review when the case passes only on another entrypoint", async () => {
  const failures = await failuresSeenByExample(
    [
      { entrypoint: "src/tool.ts", cases: allCases },
      { entrypoint: "src/other.ts", cases: ["nothing"] },
      ...singles,
    ],
    // `nothing` fails on the first batch and passes on the other entrypoint's.
    (batch) => (batch === 0 ? resultsForNothing : nothingPasses),
  );
  expect(failures).toEqual(["nothing:fail"]);
});

it("shows the failure on the current source when the same case also failed on another", async () => {
  const edited = `${toolSource}// edited\n`;
  const failures = await failuresSeenByExample(
    [
      // `nothing` fails on the original source, again on the edited one, then the agent reverts
      // exactly and runs only the passing cases.
      { entrypoint: "src/tool.ts", cases: allCases },
      { entrypoint: "src/tool.ts", cases: ["nothing"], source: edited },
      ...singles.map((batch, index) => (index === 0 ? { ...batch, source: toolSource } : batch)),
    ],
    () => resultsForNothing,
  );
  expect(failures).toEqual(["nothing:fail"]);
});

it("keeps a failure in review when the source goes back to the one it failed on", async () => {
  const edited = `${toolSource}// edited\n`;
  const onEdited = (ids: readonly string[]) => ({ entrypoint: "src/tool.ts", cases: ids, source: edited });
  const failures = await failuresSeenByExample(
    [
      // `nothing` fails on the original source, then on the edited one, then passes there.
      { entrypoint: "src/tool.ts", cases: allCases },
      onEdited(["nothing"]),
      ...["repeat-1", "sort-price", "page-2", "repeat-1"].map((id) => onEdited([id])),
      onEdited(["nothing"]),
    ],
    (batch) => (batch === 6 ? nothingPasses : resultsForNothing),
    // The agent reverts the edit exactly before the example.
    toolSource,
  );
  expect(failures).toEqual(["nothing:fail"]);
});

it("keeps a failure in review when its rerun on the same source was inconclusive", async () => {
  const failures = await failuresSeenByExample(
    [
      { entrypoint: "src/tool.ts", cases: allCases },
      { entrypoint: "src/tool.ts", cases: ["nothing"] },
      ...singles,
    ],
    (batch) =>
      batch === 0
        ? resultsForNothing
        : batch === 1
          ? { nothing: { status: "inconclusive", reason: "challenge" } }
          : {},
  );
  expect(failures).toEqual(["nothing:fail", "nothing:inconclusive"]);
});

it("tells the agent when the host could not read the schemas its verdicts and next pages need", async () => {
  const { host, batches } = liveTestHost({});
  const unreadable: LiveTestHost = {
    ...host,
    schemas: () => Effect.fail(new MintFailure({ code: "Unavailable" })),
  };
  const f = await fixture(
    (_request, index) => [call("live_tests", runAll, "run")][index] ?? prose(),
    { liveTests: unreadable, deadline: Deadline.after(30 * 60_000) },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  const single = { cases: cases.cases.filter((testCase) => testCase.next_page !== true) };
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(single) });
  await f.run();
  expect(batches).toHaveLength(1);
  const ran = resultOf(f.requests[1], "run");
  expect(ran["status"]).toBe("ran");
  expect(ran).toHaveProperty("schemaProblem");
});

// Fails when the source digest follows the host runtime's relative import out of the workspace:
// the workspace refuses that path, so live_tests answered source_unreadable and ran nothing.
it.each(["../../runtime/index.js", "../../browser/index.js"])(
  "runs the batch for a tool that imports the host runtime as %s",
  async (sdk) => {
    const { host, batches } = liveTestHost({});
    const f = await fixture(
      (_request, index) =>
        [call("live_tests", { ...runAll, entrypoint: "src/tool.mjs" }, "run")][index] ?? prose(),
      { liveTests: host, deadline: Deadline.after(30 * 60_000) },
      read,
    );
    const root = (f.workspace as unknown as { root: string }).root;
    const single = { cases: cases.cases.filter((testCase) => testCase.next_page !== true) };
    await writeWorkspace(root, {
      "src/tool.mjs": `import { defineOperation } from "${sdk}";\nexport default defineOperation;\n`,
      "test/cases.json": JSON.stringify(single),
    });
    await f.run();
    expect(resultOf(f.requests[1], "run")).toMatchObject({ status: "ran" });
    expect(batches).toHaveLength(1);
    expect(batches[0]?.sourceDigest).toEqual(expect.any(String));
  },
);

// Fails when the digest swallows a read the workspace refused: the host never hears of it.
it("reports a source digest the host could not read, and runs nothing", async () => {
  const { host, batches } = liveTestHost({});
  const reported: { readonly error: unknown; readonly operation: string }[] = [];
  const f = await fixture(
    (_request, index) => [call("live_tests", runAll, "run")][index] ?? prose(),
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reporting: {
        failure: (error, details) =>
          Effect.sync(() => {
            reported.push({ error, operation: details.operation });
          }),
        bestEffort: (effect) => Effect.ignore(effect),
      },
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  // The workspace refuses a path with a space, so the import cannot be read.
  await writeWorkspace(root, {
    "src/tool.ts": `import helper from "./helper copy.mjs";\nexport default helper;\n`,
    "test/cases.json": JSON.stringify(cases),
  });
  await f.run();
  expect(resultOf(f.requests[1], "run")).toMatchObject({ status: "source_unreadable" });
  expect(batches).toHaveLength(0);
  expect(reported).toEqual(
    expect.arrayContaining([
      { error: expect.any(MintFailure) as unknown, operation: "stepDigest" },
    ]),
  );
});

it("checks each case's output as it checks an example's, and the record keeps the findings", async () => {
  const markup = {
    status: "completed" as const,
    output: {
      results: [{ name: "Example &amp; Co <b>Lamp</b>" }],
      has_next_page: false,
      next_cursor: null,
    },
  };
  const { host } = liveTestHost({ "repeat-1": markup });
  const published = publications();
  const f = await fixture(
    (_request, index) =>
      [
        call("live_tests", runAll, "run"),
        call("execute", example, "example"),
        call("finish_build", finish, "finish"),
      ][index] ?? prose(),
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(cases) });
  await f.run();

  // The agent reads the case's findings, a blocking one marked, with what it means and a sample.
  const ran = resultOf(f.requests[1], "run") as {
    cases: Record<string, unknown>[];
    outputChecksInstruction?: string;
  };
  const flagged = ran.cases.find((testCase) => testCase["id"] === "repeat-1");
  expect(flagged?.["outputChecks"]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: "results[].name",
        check: "markup",
        blocking: true,
        meaning: expect.any(String),
        sample: expect.stringContaining("Lamp"),
      }),
    ]),
  );
  expect(ran.cases.find((testCase) => testCase["id"] === "sort-price")).not.toHaveProperty(
    "outputChecks",
  );
  expect(ran.outputChecksInstruction).toEqual(expect.any(String));

  // A finding on a case never refuses publication; the record keeps it compactly for the review.
  expect(published.seen).toHaveLength(1);
  const record = published.seen[0]?.liveTests as {
    cases: { id: string; results: { playwright: Record<string, unknown> } }[];
  };
  expect(
    record.cases.find((testCase) => testCase.id === "repeat-1")?.results.playwright["outputChecks"],
  ).toEqual([
    { path: "results[].name", check: "markup", count: 1, blocking: true },
  ]);
});

it("flags a field no case filled on each case, and gives publication every case's fields", async () => {
  const output = (results: readonly object[], storeNotice: string | null) => ({
    status: "completed" as const,
    output: { results, has_next_page: false, next_cursor: null, store_notice: storeNotice },
  });
  const { host } = liveTestHost({
    "repeat-1": output([{ name: "Lamp", note: null }, { name: "Desk lamp", note: null }], null),
    "sort-price": output([{ name: "Floor lamp", note: null }], "Prices for the chosen store"),
  });
  const published = publications();
  const f = await fixture(
    (_request, index) =>
      [
        call("live_tests", runAll, "run"),
        call("execute", example, "example"),
        call("finish_build", finish, "finish"),
      ][index] ?? prose(),
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(cases) });
  await f.run();

  const record = published.seen[0]?.liveTests as {
    cases: { id: string; results: { playwright: { outputChecks?: { path: string; check: string }[] } } }[];
  };
  const checksOf = (id: string) =>
    (record.cases.find((testCase) => testCase.id === id)?.results.playwright.outputChecks ?? []).map(
      ({ path, check }) => `${path} ${check}`,
    );
  // Three records across the cases, none with a note; the store notice one case filled.
  expect(checksOf("repeat-1")).toEqual(["results[].note empty_field"]);
  expect(checksOf("sort-price")).toEqual(["results[].note empty_field"]);
  // Publication gets each case's fields as paths and counts, never a value.
  const tested = published.seen[0]?.testedFields ?? [];
  expect(tested).toHaveLength(cases.cases.length);
  expect(tested).toContainEqual(expect.objectContaining({ store_notice: { records: 1, filled: 1 } }));
  expect(JSON.stringify(tested)).not.toContain("Prices for");
});

it("keeps a failing case in the publication record after the minter deletes or changes it", async () => {
  const { host, batches } = liveTestHost({
    "sort-price": { status: "failed", errorClass: "TimeoutError", frame: "src/tool.ts:12" },
  });
  const published = publications();
  let root = "";
  // Without the failing sort case, and with the failing no-results case on another query.
  const trimmed = {
    ...cases,
    cases: cases.cases
      .filter((testCase) => testCase.id !== "sort-price")
      .map((testCase) =>
        testCase.id === "nothing" ? { ...testCase, input: { query: "zzqy" } } : testCase,
      ),
  };
  const f = await fixture(
    async (_request, index) => {
      if (index === 1)
        await writeWorkspace(root, { "test/cases.json": JSON.stringify(withPassing(trimmed, 1)) });
      return (
        [
          call("live_tests", runAll, "first"),
          call("live_tests", runAll, "second"),
          call("execute", example, "example"),
          call("finish_build", finish, "finish"),
        ][index] ?? prose()
      );
    },
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(cases) });
  await f.run();
  expect(batches).toHaveLength(2);
  const record = published.seen[0]?.liveTests as {
    cases: { id: string }[];
    retired: Record<string, unknown>[];
  };
  expect(record.cases.map((testCase) => testCase.id)).not.toContain("sort-price");
  expect(record.retired).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "sort-price",
        retiredBecause: "deleted from the cases file",
        lastVerdict: "fail",
        frame: "src/tool.ts:12",
        input: { query: "lamp", sort: "price_low" },
        onPublishedSource: true,
      }),
      expect.objectContaining({
        id: "nothing",
        retiredBecause: "changed after it failed",
        lastVerdict: "fail",
        input: { query: "zzqx" },
      }),
    ]),
  );
  expect(published.seen[0]?.coverage).toContain("2 retired cases (2 last failed)");
});

/**
 * Runs `turns` of live_tests batches, editing the workspace before each, then publishes. Each
 * batch reads the tool's schemas from `schemasAt` for its index, `schemas` unless given.
 */
const batchesThenPublish = async (
  outcomes: Outcomes,
  edits: readonly Readonly<Record<string, string>>[],
  schemasAt?: (batch: number) => ToolSchemas,
) => {
  let turn = 0;
  const { host, batches } = liveTestHost(outcomes, undefined, {
    schemasNow: () => schemasAt?.(Math.min(turn, edits.length - 1)) ?? schemas,
  });
  const published = publications();
  let root = "";
  const runs = edits.map((_edit, index) => call("live_tests", runAll, `run_${index}`));
  const f = await fixture(
    async (_request, index) => {
      turn = index;
      const edit = edits[index];
      if (edit !== undefined) await writeWorkspace(root, edit);
      return (
        [...runs, call("execute", example, "example"), call("finish_build", finish, "finish")][
          index
        ] ?? prose()
      );
    },
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  root = (f.workspace as unknown as { root: string }).root;
  await f.run();
  expect(batches).toHaveLength(edits.length);
  return {
    ...(published.seen[0]?.liveTests as { retired: Record<string, unknown>[] }),
    coverage: published.seen[0]?.coverage ?? "",
  };
};
const otherStore = (expectation: string) =>
  JSON.stringify({
    cases: [
      {
        id: "other-store",
        purpose: "A second store the store picker lists.",
        input: { query: "lamp", store: "Mill Street" },
        expect: expectation,
      },
    ],
  });
const emptyList = {
  status: "completed" as const,
  output: { results: [], has_next_page: false, next_cursor: null },
};

// The review excuses a relabeled failure only when the captures show the site giving the new
// answer for that input, so the host names the passing case for it and excuses nothing itself.
it("never excuses a failure by a case that changed its expectation, and names that case for the review", async () => {
  // The second store's results come back empty; the agent relabels the case to expect that.
  const record = await batchesThenPublish({ "other-store": emptyList }, [
    { "src/tool.ts": toolSource, "test/cases.json": otherStore("result") },
    { "test/cases.json": otherStore("empty") },
  ]);
  expect(record.retired).toEqual([
    expect.objectContaining({
      id: "other-store",
      lastVerdict: "fail",
      expect: "result",
      changedExpectationBy: "other-store",
    }),
  ]);
  expect(record.retired[0]).not.toHaveProperty("excusedBy");
});

it("names no case for a changed expectation that does not pass", async () => {
  const record = await batchesThenPublish({ "other-store": emptyList }, [
    { "src/tool.ts": toolSource, "test/cases.json": otherStore("result") },
    { "test/cases.json": JSON.stringify(withPassing(JSON.parse(otherStore("invalid_input")), 3)) },
  ]);
  expect(record.retired).toEqual([
    expect.objectContaining({ id: "other-store", lastVerdict: "fail", expect: "result" }),
  ]);
  expect(record.retired[0]).not.toHaveProperty("changedExpectationBy");
});

it("excuses a failure only by a case passing its input and expectation after the code changed", async () => {
  const record = await batchesThenPublish(
    (batch) => (batch === 0 ? { "other-store": emptyList } : {}),
    [
      { "src/tool.ts": toolSource, "test/cases.json": otherStore("result") },
      {
        "src/tool.ts": `${toolSource}// fixed\n`,
        "test/cases.json": otherStore("result").replace('"other-store"', '"second-store"'),
      },
    ],
  );
  expect(record.retired).toEqual([
    expect.objectContaining({
      id: "other-store",
      retiredBecause: "deleted from the cases file",
      excusedBy: "second-store",
    }),
  ]);
});

it("keeps a failure that passed when run again on the same code as flaky", async () => {
  const record = await batchesThenPublish(
    (batch) => (batch === 0 ? { "other-store": emptyList } : {}),
    [{ "src/tool.ts": toolSource, "test/cases.json": otherStore("result") }, {}],
  );
  expect(record.retired).toEqual([
    expect.objectContaining({
      id: "other-store",
      lastVerdict: "fail",
      flaky: true,
      onPublishedSource: true,
    }),
  ]);
  expect(record.retired[0]).not.toHaveProperty("excusedBy");
});

// A challenge or a site block on the rerun tests nothing about the tool, so it neither shows the
// failure was a race nor clears it: the failure keeps counting as the case's result.
it("keeps a failure counting when its rerun on the same code is inconclusive", async () => {
  const blocked = { status: "inconclusive" as const, reason: "challenge" as const };
  const record = (await batchesThenPublish(
    (batch) => ({ "other-store": batch === 0 ? emptyList : blocked }),
    [
      {
        "src/tool.ts": toolSource,
        "test/cases.json": JSON.stringify(withPassing(JSON.parse(otherStore("result")), 3)),
      },
      {},
    ],
  )) as unknown as {
    readonly retired: readonly Record<string, unknown>[];
    readonly cases: readonly { readonly id: string; readonly results: Record<string, unknown> }[];
  };
  expect(record.retired).toEqual([]);
  expect(record.cases.find((entry) => entry.id === "other-store")?.results).toMatchObject({
    playwright: { status: "fail" },
  });
});

const oneCase = (id: string, expectation: string, input: object) =>
  JSON.stringify(
    withPassing(
      { cases: [{ id, purpose: "One synthetic input the site answers.", input, expect: expectation }] },
      3,
    ),
  );
const longQuery = { query: "lamp ".repeat(60) };
/** The search schemas with the query bounded at `maxLength`, and any `more` of the input schema. */
const queryBoundedAt = (maxLength: number, more: Record<string, unknown> = {}) => ({
  ...schemas,
  input: {
    ...schemas.input,
    properties: { ...schemas.input.properties, query: { type: "string", minLength: 1, maxLength } },
    ...more,
  },
});
/** The search schemas with the query bounded as the site's own search field is. */
const boundedQuery = queryBoundedAt(100);
type Retired = Record<string, unknown> & {
  readonly clearedBy?: { readonly ways: readonly string[]; readonly siteAnswer?: string };
};
const stillCounting = (record: { readonly retired: readonly Record<string, unknown>[] }) =>
  record.retired.filter((entry) => "clearedBy" in entry).length;
const siteRefused = { status: "failed" as const, errorClass: "HttpError", frame: "src/tool.ts:9" };
const oneResult = {
  status: "completed" as const,
  output: { results: [{ name: "Lamp" }], has_next_page: false, next_cursor: null },
};

/**
 * Runs `input` as a case that fails on the first source, whose schemas are `first`, deletes it with
 * a source edit, and publishes against `published`, the schemas the edited source declares.
 */
const retiredUnder = (input: object, published: ToolSchemas, first: ToolSchemas = schemas) =>
  batchesThenPublish(
    { "old-input": siteRefused },
    [
      { "src/tool.ts": toolSource, "test/cases.json": oneCase("old-input", "result", input) },
      {
        "src/tool.ts": `${toolSource}// schema changed\n`,
        "test/cases.json": JSON.stringify(withPassing({ cases: [] }, 3)),
      },
    ],
    (batch) => (batch === 0 ? first : published),
  );

// A failure whose input the published schema now refuses tests an input the tool no longer
// claims. The host reads that from the schema itself, so no relabelled case is involved.
it("stops counting a retired failure once the published schema rejects its input", async () => {
  const record = await retiredUnder(longQuery, boundedQuery);
  expect(record.retired).toEqual([
    expect.objectContaining({
      id: "old-input",
      lastVerdict: "fail",
      outsideSchema: { path: "/query", keyword: "maxLength" },
    }),
  ]);
  expect(record.retired[0]).not.toHaveProperty("clearedBy");
  expect(record.coverage).toContain("0 of those failures still count.");
});

// A bound the schema puts on a value the old input supplied is the claim that changed. Every
// other error holds for the input's values: a field the schema newly requires, or a rule over the
// whole input, would mark every old case outside while the schema still accepts what it sent.
it("marks a retired failure outsideSchema only where the schema bounds a value it supplied", async () => {
  const zipRequired = {
    ...schemas,
    input: {
      ...schemas.input,
      required: ["query", "zip"],
      properties: { ...schemas.input.properties, zip: { type: "string" } },
    },
  };
  const newlyRequired = await retiredUnder({ query: "lamp" }, zipRequired);
  expect(newlyRequired.retired[0]).not.toHaveProperty("outsideSchema");
  expect(stillCounting(newlyRequired)).toBe(1);

  const eitherIdentifier = queryBoundedAt(1000, {
    anyOf: [{ required: ["zip"] }, { required: ["store_id"] }],
  });
  const wholeInputRule = await retiredUnder({ query: "lamp" }, eitherIdentifier);
  expect(wholeInputRule.retired[0]).not.toHaveProperty("outsideSchema");
  expect(stillCounting(wholeInputRule)).toBe(1);

  // The bound sits in one branch of a rule over the whole input, which the input breaks by lacking
  // both identifiers: the query's length is not why the schema rejects it.
  const boundInBranch = await retiredUnder(longQuery, {
    ...schemas,
    input: {
      ...schemas.input,
      anyOf: [
        { required: ["zip"] },
        { required: ["store_id"], properties: { query: { type: "string", maxLength: 5 } } },
      ],
    },
  });
  expect(boundInBranch.retired[0]).not.toHaveProperty("outsideSchema");
  expect(stillCounting(boundInBranch)).toBe(1);

  const loosened = await retiredUnder(longQuery, schemas, queryBoundedAt(400));
  expect(loosened.retired[0]).not.toHaveProperty("outsideSchema");
  expect(stillCounting(loosened)).toBe(1);

  // Every error counts, not the first: the new required field beside the bound on the query.
  const boundedAndRequired = await retiredUnder(
    longQuery,
    queryBoundedAt(100, { required: ["zip", "query"] }),
  );
  expect(boundedAndRequired.retired[0]).toMatchObject({
    outsideSchema: { path: "/query", keyword: "maxLength" },
  });
  expect(stillCounting(boundedAndRequired)).toBe(0);

  const closed = await retiredUnder(
    { query: "lamp", store: "Mill Street" },
    queryBoundedAt(1000, { additionalProperties: false }),
  );
  expect(closed.retired[0]).toMatchObject({
    outsideSchema: { path: "/store", keyword: "additionalProperties" },
  });
});

// A refusal satisfies an expectation of error as judgeCase judges it, so a case that now refuses
// the input with InvalidInput after a fix shows the earlier failure fixed.
it("excuses a failure that expected error by a later InvalidInput for the same input", async () => {
  const input = { query: "lamp", store: "Nowhere Street" };
  const record = await batchesThenPublish(
    (batch) =>
      batch === 0
        ? { "store-refused": { status: "failed", errorClass: "TimeoutError", frame: "src/tool.ts:14" } }
        : { "store-not-listed": { status: "invalid_input", field: "store", available: ["Mill Street"] } },
    [
      { "src/tool.ts": toolSource, "test/cases.json": oneCase("store-refused", "error", input) },
      {
        "src/tool.ts": `${toolSource}// refuses an unlisted store\n`,
        "test/cases.json": oneCase("store-not-listed", "invalid_input", input),
      },
    ],
  );
  expect(record.retired).toEqual([
    expect.objectContaining({ id: "store-refused", lastVerdict: "fail", excusedBy: "store-not-listed" }),
  ]);
  expect(stillCounting(record)).toBe(0);
});

// On the same source the refusal and the failure come from the same code: the pass shows the
// relabel, not a fix, so it is only a lead the review checks against the site.
it("never excuses a failure by a refusal that passes on the same source", async () => {
  const input = { query: "lamp", store: "Nowhere Street" };
  const record = await batchesThenPublish(
    (batch) =>
      batch === 0
        ? { "store-refused": { status: "failed", errorClass: "TimeoutError", frame: "src/tool.ts:14" } }
        : { "store-not-listed": { status: "invalid_input", field: "store", available: ["Mill Street"] } },
    [
      { "src/tool.ts": toolSource, "test/cases.json": oneCase("store-refused", "error", input) },
      { "test/cases.json": oneCase("store-not-listed", "invalid_input", input) },
    ],
  );
  const [retired] = record.retired as Retired[];
  expect(retired).toMatchObject({ id: "store-refused", changedExpectationBy: "store-not-listed" });
  expect(retired).not.toHaveProperty("excusedBy");
  expect(retired?.clearedBy?.siteAnswer).toBe("refusal");
});

// InputNotApplied passes a case that expects error, but a case that expects invalid_input passes
// only on InvalidInput, so it shows a different answer, not the old expectation met.
it("never excuses an invalid_input failure by an InputNotApplied pass", async () => {
  const input = { query: "lamp", store: "Nowhere Street" };
  const record = await batchesThenPublish(
    (batch) =>
      batch === 0
        ? { "store-unlisted": oneResult }
        : { "store-not-applied": { status: "failed", errorClass: "InputNotApplied", frame: "src/tool.ts:14" } },
    [
      { "src/tool.ts": toolSource, "test/cases.json": oneCase("store-unlisted", "invalid_input", input) },
      {
        "src/tool.ts": `${toolSource}// reports the store unapplied\n`,
        "test/cases.json": oneCase("store-not-applied", "error", input),
      },
    ],
  );
  const [retired] = record.retired as Retired[];
  expect(retired).toMatchObject({
    id: "store-unlisted",
    lastVerdict: "fail",
    changedExpectationBy: "store-not-applied",
  });
  expect(retired).not.toHaveProperty("excusedBy");
  expect(stillCounting(record)).toBe(1);
});

it("says how a retired failure that still counts can be cleared", async () => {
  const record = await batchesThenPublish(
    (batch) =>
      batch === 0
        ? {
            "other-store": emptyList,
            "sort-price": { status: "failed", errorClass: "TimeoutError", frame: "src/tool.ts:12" },
          }
        : { "other-store": emptyList },
    [
      {
        "src/tool.ts": toolSource,
        "test/cases.json": JSON.stringify({
          cases: [
            ...JSON.parse(otherStore("result")).cases,
            { id: "sort-price", purpose: "Sort by price.", input: { query: "lamp", sort: "price_low" }, expect: "result" },
          ],
        }),
      },
      { "src/tool.ts": `${toolSource}// edited\n`, "test/cases.json": otherStore("empty") },
    ],
  );
  const retired = record.retired as Retired[];
  const relabelled = retired.find((entry) => entry.id === "other-store");
  const deleted = retired.find((entry) => entry.id === "sort-price");
  expect(relabelled).toMatchObject({
    lastVerdict: "fail",
    changedExpectationBy: "other-store",
    clearedBy: { ways: ["changedExpectationBy", "excusedBy", "outsideSchema"], siteAnswer: "no_results" },
  });
  expect(relabelled).not.toHaveProperty("excusedBy");
  expect(deleted).toMatchObject({
    lastVerdict: "fail",
    clearedBy: { ways: ["changedExpectationBy", "excusedBy", "outsideSchema"] },
  });
  expect(deleted?.clearedBy).not.toHaveProperty("siteAnswer");
  expect(stillCounting(record)).toBe(2);
});

// A no-results case the site answers with near matches expects results once the minter sees
// them; the lead stands on the site's own results for that input, as an empty lead does on its
// no-results state.
it("names the site's own results as what a lead that now expects results needs", async () => {
  const misspelt = { query: "lmap" };
  const record = await batchesThenPublish(
    { "misspelt-query": oneResult },
    [
      { "src/tool.ts": toolSource, "test/cases.json": oneCase("misspelt-query", "empty", misspelt) },
      { "test/cases.json": oneCase("misspelt-query", "result", misspelt) },
    ],
  );
  const [retired] = record.retired as Retired[];
  expect(retired).toMatchObject({
    id: "misspelt-query",
    lastVerdict: "fail",
    expect: "empty",
    changedExpectationBy: "misspelt-query",
    clearedBy: { siteAnswer: "results" },
  });
});

// Changing a case to expect what a regression now returns is the minter's own account. It
// excuses nothing: the old expectation still rejects the new result.
it("never lets a case relabelled to a regression's result excuse the failure", async () => {
  const input = { query: "lamp", store: "Mill Street" };
  const refused = { status: "invalid_input" as const, field: "store", available: ["Elm Road"] };
  const record = await batchesThenPublish(
    { "listed-store": refused },
    [
      { "src/tool.ts": toolSource, "test/cases.json": oneCase("listed-store", "result", input) },
      {
        "src/tool.ts": `${toolSource}// edited\n`,
        "test/cases.json": oneCase("listed-store", "invalid_input", input),
      },
    ],
  );
  const [retired] = record.retired as Retired[];
  expect(retired).toMatchObject({
    id: "listed-store",
    lastVerdict: "fail",
    expect: "result",
    changedExpectationBy: "listed-store",
  });
  expect(retired).not.toHaveProperty("excusedBy");
  expect(retired).not.toHaveProperty("outsideSchema");
  expect(stillCounting(record)).toBe(1);
});

// A refusal lead stands only on the site's own controls refusing the input, by a status that
// says the input itself was refused. The failing run's own request is the tool's, so a bug in it
// can draw the same status.
it("names the site's own refusal, by an input-shaped status only, as what a refusal lead needs", async () => {
  const record = await batchesThenPublish(
    (batch) =>
      batch === 0
        ? { "long-query": siteRefused }
        : { "long-query": { status: "failed", errorClass: "InputNotApplied", frame: "src/tool.ts:9" } },
    [
      { "src/tool.ts": toolSource, "test/cases.json": oneCase("long-query", "result", longQuery) },
      {
        "src/tool.ts": `${toolSource}// refuses what the site refuses\n`,
        "test/cases.json": oneCase("long-query", "error", longQuery),
      },
    ],
  );
  const [retired] = record.retired as Retired[];
  expect(retired).toMatchObject({
    id: "long-query",
    changedExpectationBy: "long-query",
    clearedBy: { siteAnswer: "refusal", refusalStatuses: [400, 413, 414, 422] },
  });
});

it("publishes with the gaps when too little time is left for a batch, and the record says so", async () => {
  const { host, batches } = liveTestHost({});
  const published = publications();
  const f = await fixture(
    (_request, index) =>
      [
        call("live_tests", runAll, "run"),
        call("execute", example, "example"),
        call("finish_build", finish, "finish"),
      ][index] ?? prose(),
    {
      liveTests: host,
      // Less than the batch's margin before the attempt's end.
      deadline: Deadline.after(2 * 60_000 + 30_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(cases) });
  await f.run();
  expect(batches).toHaveLength(0);
  expect(resultOf(f.requests[1], "run")).toMatchObject({ status: "no_time" });
  expect(published.seen).toHaveLength(1);
  expect(published.seen[0]?.liveTests).toMatchObject({ outOfTime: true });
  expect(published.seen[0]?.coverage).toContain("ran out of time");
});

// A host whose cases may each run longer than the default gets no batch it cannot fit one case in:
// such a batch would only end every case inconclusive for the deadline.
it("refuses a batch as no_time when less than the host's case limit is left, and runs one that fits", async () => {
  const attempt = async (batchMs: number) => {
    const { host, batches } = liveTestHost({});
    const f = await fixture(
      (_request, index) =>
        [
          call("live_tests", runAll, "run"),
          call("execute", example, "example"),
          call("finish_build", finish, "finish"),
        ][index] ?? prose(),
      {
        liveTests: { ...host, caseTimeoutMs: 120_000 },
        // The attempt keeps two minutes after the batch; `batchMs` is what the batch may use.
        deadline: Deadline.after(2 * 60_000 + batchMs),
        reviewAndExecute: completedExample,
        publish: publications().publish,
      },
      read,
    );
    const root = (f.workspace as unknown as { root: string }).root;
    await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(cases) });
    await f.run();
    return { batches: batches.length, status: resultOf(f.requests[1], "run")["status"] };
  };
  expect(await attempt(90_000)).toEqual({ batches: 0, status: "no_time" });
  expect(await attempt(150_000)).toEqual({ batches: 1, status: "ran" });
});

it("says time ran out only when the attempt's end, not the batch's own cap, stopped a case", async () => {
  const stopped = { status: "inconclusive" as const, reason: "deadline" as const };
  const record = async (attemptMs: number) => {
    const { host, batches } = liveTestHost({ "sort-price": stopped, nothing: emptyResults });
    const published = publications();
    const f = await fixture(
      (_request, index) =>
        [
          call("live_tests", runAll, "run"),
          call("execute", example, "example"),
          call("finish_build", finish, "finish"),
        ][index] ?? prose(),
      {
        liveTests: host,
        deadline: Deadline.after(attemptMs),
        reviewAndExecute: completedExample,
        publish: published.publish,
      },
      read,
    );
    const root = (f.workspace as unknown as { root: string }).root;
    await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(cases) });
    await f.run();
    expect(batches).toHaveLength(1);
    return published.seen[0]?.liveTests as { outOfTime?: boolean };
  };
  // Half an hour left: the batch's own ten-minute cap stopped the case, so testing can go on.
  expect((await record(30 * 60_000)).outOfTime).toBeUndefined();
  // Five minutes left: the attempt's end set the batch's deadline.
  expect((await record(5 * 60_000)).outOfTime).toBe(true);
});

it("never counts a case the site blocked on the browser's egress against the tool", async () => {
  const { host, batches } = liveTestHost({ "sort-price": { status: "inconclusive", reason: "site_block" } });
  const file = withPassing(cases, 1);
  const published = publications();
  const f = await fixture(
    (_request, index) =>
      [
        call("live_tests", runAll, "run"),
        call("execute", example, "example"),
        call("finish_build", finish, "finish"),
      ][index] ?? prose(),
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(file) });
  await f.run();

  expect(batches).toHaveLength(1);
  const blocked = (resultOf(f.requests[1], "run")["cases"] as { id: string }[]).find(
    (testCase) => testCase.id === "sort-price",
  );
  expect(blocked).toMatchObject({ status: "inconclusive", got: "site_block" });
  expect(published.seen[0]?.coverage).toContain("3 pass, 1 fail, 1 inconclusive;");
});

it("runs nothing when Guardian denies the batch, and says why", async () => {
  const { host, batches } = liveTestHost(
    {},
    {
      status: "review_denied",
      reviewId: "review_denied_batch",
      rationale: "Case repeat-1 guesses an order number.",
    },
  );
  const published = publications();
  const f = await fixture(
    (_request, index) =>
      [
        call("live_tests", runAll, "run"),
        call("execute", example, "example"),
        call("finish_build", finish, "finish"),
      ][index] ?? prose(),
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(cases) });
  await f.run();
  expect(batches).toHaveLength(1);
  expect(resultOf(f.requests[1], "run")).toMatchObject({
    status: "review_denied",
    rationale: "Case repeat-1 guesses an order number.",
  });
  const record = published.seen[0]?.liveTests as { cases: { results: { playwright: { status: string } } }[] };
  expect(record.cases.every((testCase) => testCase.results.playwright.status === "not_run")).toBe(true);
});

const httpSource = "export default { name: 'search_catalog_http' };\n";
const runHttp = { action: "run", entrypoint: "src/tool-http.mjs", cases: null, maxWorkers: 3 };
const planOf = (entrypoint: string) => ({ action: "plan", entrypoint, cases: null, maxWorkers: null });
const statuses = (result: Record<string, unknown>) =>
  Object.fromEntries(
    (result["cases"] as { id: string; status: string }[]).map((testCase) => [testCase.id, testCase.status]),
  );

// A read signed out runs the same cases as a batch on both versions. Each version keeps its own
// results: a batch on the HTTP version neither replaces nor stales the Playwright version's.
it("runs the cases as a batch on each version, and each version keeps its own results", async () => {
  const { host, batches } = liveTestHost((batch) =>
    batch === 0
      ? {
          "sort-price": { status: "failed", errorClass: "TimeoutError", message: "Timed out" },
          nothing: { status: "completed", output: { results: [], has_next_page: false, next_cursor: null } },
        }
      : {
          nothing: {
            status: "failed",
            errorClass: "OperationFailure",
            message: "Unexpected status 500",
            frame: "src/tool-http.mjs:9",
          },
        },
  );
  const published = publications();
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", example, "example"),
        call("live_tests", runAll, "run_playwright"),
        call("live_tests", runHttp, "run_http"),
        call("live_tests", planOf("src/tool.ts"), "plan_playwright"),
        call("finish_build", finish, "finish"),
      ][index] ?? prose(),
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, {
    "src/tool.ts": toolSource,
    "src/tool-http.mjs": httpSource,
    "test/cases.json": JSON.stringify(cases),
  });
  await f.run();

  expect(batches.map((batch) => batch.entrypoint)).toEqual(["src/tool.ts", "src/tool-http.mjs"]);
  const both = { "repeat-1": "pass", "page-2": "pass" };
  expect(statuses(resultOf(f.requests[3], "run_http"))).toEqual({
    ...both,
    "sort-price": "pass",
    nothing: "fail",
  });
  // After the HTTP batch, the Playwright version's results stand as they ran.
  expect(statuses(resultOf(f.requests[4], "plan_playwright"))).toEqual({
    ...both,
    "sort-price": "fail",
    nothing: "pass",
  });

  // The record shows each case's result on each version, against that version's own source.
  const record = published.seen[0]?.liveTests as {
    versions: { version: string; entrypoint: string }[];
    cases: { id: string; results: Record<string, { status: string }> }[];
  };
  expect(record.versions.map(({ version, entrypoint }) => [version, entrypoint])).toEqual([
    ["playwright", "src/tool.ts"],
    ["http", "src/tool-http.mjs"],
  ]);
  const byCase = Object.fromEntries(
    record.cases.map((testCase) => [
      testCase.id,
      [testCase.results["playwright"]?.status, testCase.results["http"]?.status],
    ]),
  );
  expect(byCase).toEqual({
    "repeat-1": ["pass", "pass"],
    "sort-price": ["fail", "pass"],
    nothing: ["pass", "fail"],
    "page-2": ["pass", "pass"],
  });
  expect(published.seen[0]?.coverage).toContain(
    "HTTP version (src/tool-http.mjs): 3 pass, 1 fail, 0 inconclusive; 1 passed cold.",
  );
});

/** A scripted minter that checkpoints before each model call, as a host's recovery store does. */
const checkpointingMinter = (respondTo: (index: number) => ModelResponse) => {
  const requests: ModelRequest[] = [];
  const recoveryFactory: MintRecoveryFactory = (store) =>
    Effect.succeed({
      model: (state, counters, invoke) =>
        store
          .save({ version: 1, sdkVersion: "0.18.0", sdkState: state(), ...counters, tools: [] })
          .pipe(Effect.zipRight(invoke)),
      tool: (_call, invoke) => invoke,
    });
  const provider: ModelProvider = {
    getModel: () => ({
      getResponse: async (request) => {
        requests.push(request);
        return respondTo(requests.length - 1);
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  };
  return { requests, model: makeOpenAIMinter(provider, "medium", {}, { recoveryFactory }) };
};

// A checkpoint from an older release keeps results without an entrypoint: a worker that takes
// it over restores them as the Playwright version's, and the HTTP version has run nothing yet.
it("restores an older checkpoint's results as the Playwright version's", async () => {
  const { host } = liveTestHost({
    nothing: { status: "completed", output: { results: [], has_next_page: false, next_cursor: null } },
  });
  const checkpoints: { agent: MintAgentSnapshot; harness: MintHarnessSnapshot }[] = [];
  const files = {
    "src/tool.ts": toolSource,
    "src/tool-http.mjs": httpSource,
    "test/cases.json": JSON.stringify(cases),
  };
  const before = checkpointingMinter(
    (index) =>
      [call("execute", example, "example"), call("live_tests", runAll, "run")][index] ?? prose(),
  );
  const first = await fixture(() => prose(), {
    model: before.model,
    liveTests: host,
    deadline: Deadline.after(30 * 60_000),
    reviewAndExecute: completedExample,
    agentRecovery: {
      save: (agent, harness) =>
        Effect.sync(() => {
          checkpoints.push({ agent, harness });
        }),
    },
  }, read);
  await writeWorkspace((first.workspace as unknown as { root: string }).root, files);
  await first.run().catch(() => undefined);
  const saved = checkpoints.find((checkpoint) => (checkpoint.harness.liveTests ?? []).length > 0);
  if (saved === undefined) throw new Error("No checkpoint with live test results");
  // What an older release wrote: the same results, with no entrypoint.
  const older = Schema.decodeUnknownSync(MintHarnessSnapshot)(
    JSON.parse(
      JSON.stringify({
        ...saved.harness,
        liveTests: saved.harness.liveTests?.map(({ entrypoint: _entrypoint, ...record }) => record),
      }),
    ),
  );
  expect(older.liveTests?.some((record) => record.entrypoint !== undefined)).toBe(false);

  const published = publications();
  const after = checkpointingMinter(
    (index) =>
      [
        call("live_tests", planOf("src/tool.ts"), "plan_playwright"),
        call("live_tests", planOf("src/tool-http.mjs"), "plan_http"),
        call("finish_build", finish, "finish"),
      ][index] ?? prose(),
  );
  const second = await fixture(() => prose(), {
    model: after.model,
    liveTests: host,
    deadline: Deadline.after(30 * 60_000),
    reviewAndExecute: completedExample,
    publish: published.publish,
    agentRecovery: { initial: { agent: saved.agent, harness: older }, save: () => Effect.void },
  }, read);
  await writeWorkspace((second.workspace as unknown as { root: string }).root, files);
  await second.run();
  const pass = { "repeat-1": "pass", "sort-price": "pass", nothing: "pass", "page-2": "pass" };
  expect(statuses(resultOf(after.requests[1], "plan_playwright"))).toEqual(pass);
  expect(statuses(resultOf(after.requests[2], "plan_http"))).toEqual(
    Object.fromEntries(Object.keys(pass).map((id) => [id, "not_run"])),
  );
  const record = published.seen[0]?.liveTests as {
    cases: { results: Record<string, { status: string }> }[];
  };
  expect(record.cases.map((testCase) => testCase.results["playwright"]?.status)).toEqual(
    Object.values(pass),
  );
  expect(record.cases.every((testCase) => testCase.results["http"]?.status === "not_run")).toBe(true);
});

// A count's honest answer to an input that matches nothing is zero, a filled value the judge reads
// as a result, never as empty. The minter marks that case `noMatch`, and the record says so.
const countSchemas = {
  input: {
    type: "object",
    required: ["month", "year"],
    properties: {
      month: { type: "integer", minimum: 1, maximum: 12 },
      year: { type: "integer" },
    },
  },
  output: {
    type: "object",
    required: ["month", "year", "start_date", "end_date", "review_count"],
    properties: {
      month: { type: "integer" },
      year: { type: "integer" },
      start_date: { type: "string" },
      end_date: { type: "string" },
      review_count: { type: "integer" },
    },
  },
};
const monthCount = (month: number, count: number) => ({
  status: "completed" as const,
  output: {
    month,
    year: 2024,
    start_date: `2024-0${month}-01`,
    end_date: `2024-0${month}-28`,
    review_count: count,
  },
});
const countCases = (noMatch: boolean) => ({
  cases: [
    {
      id: "busy-month",
      purpose: "A month the site lists reviews for.",
      input: { month: 4, year: 2024 },
      expect: "result",
    },
    {
      id: "quiet-month",
      purpose: "A month the site lists no reviews for; its filtered list shows a total of 0.",
      input: { month: 2, year: 2024 },
      expect: "result",
      ...(noMatch ? { noMatch: true } : {}),
    },
  ],
});
const countFinish = {
  ...finish,
  metadata: { name: "count_reviews", description: "Count a month's reviews" },
};

it("keeps a case marked noMatch in the publication record, and marking a passed case keeps its result", async () => {
  const { host } = liveTestHost(
    { "busy-month": monthCount(4, 351), "quiet-month": monthCount(2, 0) },
    undefined,
    { schemasNow: () => countSchemas },
  );
  const published = publications();
  let root = "";
  const f = await fixture(
    async (_request, index) => {
      // After the batch passed, the minter marks its zero case as the no-match case.
      if (index === 2)
        await writeWorkspace(root, { "test/cases.json": JSON.stringify(countCases(true)) });
      return (
        [
          call("execute", example, "example"),
          call("live_tests", runAll, "run"),
          call("live_tests", plan, "plan"),
          call("finish_build", countFinish, "finish"),
        ][index] ?? prose()
      );
    },
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, {
    "src/tool.ts": toolSource,
    "test/cases.json": JSON.stringify(countCases(false)),
  });
  const outcome = await f.run();

  // The zero is a result, as before, and the case passes as one.
  const ran = resultOf(f.requests[2], "run")["cases"] as Record<string, unknown>[];
  expect(ran.find((testCase) => testCase["id"] === "quiet-month")).toMatchObject({
    status: "pass",
    got: "a result",
  });
  // The flag describes the case, as its purpose does: adding it leaves the result standing.
  const planned = resultOf(f.requests[3], "plan")["cases"] as Record<string, unknown>[];
  expect(planned.find((testCase) => testCase["id"] === "quiet-month")).toMatchObject({
    status: "pass",
    noMatch: true,
  });
  expect(planned.find((testCase) => testCase["id"] === "busy-month")).not.toHaveProperty("noMatch");

  expect(outcome.build).toBe("published");
  const record = published.seen[0]?.liveTests as {
    cases: { id: string; noMatch?: boolean; results: Record<string, { status: string }> }[];
  };
  expect(record.cases.find((testCase) => testCase.id === "quiet-month")).toMatchObject({
    noMatch: true,
    results: { playwright: { status: "pass" } },
  });
  // A case without the flag is recorded as it always was.
  expect(record.cases.find((testCase) => testCase.id === "busy-month")).not.toHaveProperty(
    "noMatch",
  );
});

it("keeps a case's noMatch in its result across a takeover", async () => {
  const { host } = liveTestHost(
    { "busy-month": monthCount(4, 351), "quiet-month": monthCount(2, 0) },
    undefined,
    { schemasNow: () => countSchemas },
  );
  const checkpoints: MintHarnessSnapshot[] = [];
  const minter = checkpointingMinter(
    (index) =>
      [call("execute", example, "example"), call("live_tests", runAll, "run")][index] ?? prose(),
  );
  const f = await fixture(() => prose(), {
    model: minter.model,
    liveTests: host,
    deadline: Deadline.after(30 * 60_000),
    reviewAndExecute: completedExample,
    agentRecovery: {
      save: (_agent, harness) =>
        Effect.sync(() => {
          checkpoints.push(harness);
        }),
    },
  }, read);
  await writeWorkspace((f.workspace as unknown as { root: string }).root, {
    "src/tool.ts": toolSource,
    "test/cases.json": JSON.stringify(countCases(true)),
  });
  await f.run().catch(() => undefined);
  const saved = checkpoints.find((harness) => (harness.liveTests ?? []).length > 0);
  if (saved === undefined) throw new Error("No checkpoint with live test results");
  const restored = Schema.decodeUnknownSync(MintHarnessSnapshot)(JSON.parse(JSON.stringify(saved)));
  expect(restored.liveTests?.find((result) => result.id === "quiet-month")).toMatchObject({
    expect: "result",
    noMatch: true,
  });
  expect(restored.liveTests?.find((result) => result.id === "busy-month")).not.toHaveProperty(
    "noMatch",
  );
});

const signInStep = { ...example, purpose: "authenticate", entrypoint: "src/sign-in.ts" };
const signingIn: MintDependencies["reviewAndExecute"] = (input, beforeDispatch) =>
  input.purpose === "authenticate"
    ? (beforeDispatch?.(readAllow) ?? Effect.void).pipe(
        Effect.as({
          executionId: "sign_in_one",
          status: "completed" as const,
          effect: "verified" as const,
          authentication: { state: "authenticated" as const, effect: "verified" as const },
          observations: {},
        }),
      )
    : completedExample(input, beforeDispatch);

// A signed-in read sets every optional input its example left unset in one combined case, and may
// run up to four distinct inputs in all. Running an input again, after a fix or on the HTTP
// version, is free; a batch that would add a fifth input is refused and runs nothing.
const combined = {
  cases: [
    {
      id: "every-filter",
      purpose: "The sort and in-stock filter the example left unset, set from its own rows; each row shows both.",
      input: { query: "lamp", sort: "price_low", in_stock: true },
      expect: "result",
      next_page: true,
    },
    {
      id: "other-sort",
      purpose: "The descending sort opens a results page laid out differently.",
      input: { query: "lamp", sort: "price_high" },
      expect: "result",
    },
  ],
  notTested: [{ what: "A query with no results", reason: "A signed-in read runs its combined case only." }],
};
const thirdCase = { id: "third", purpose: "Another query.", input: { query: "desk" }, expect: "result" };
/** Three more inputs, one past what a signed-in read that ran two may still run. */
const overLimitCases = [
  thirdCase,
  { id: "fourth", purpose: "Another query.", input: { query: "chair" }, expect: "result" },
  { id: "fifth", purpose: "Another query.", input: { query: "sofa" }, expect: "result" },
];
const filterIgnored = {
  status: "failed" as const,
  errorClass: "InputNotApplied",
  message: "The in-stock filter did not apply.",
  frame: "src/tool.ts:4",
};

it("runs a signed-in read's combined filter case on its signed-in browser and refuses a fifth input", async () => {
  const { host, batches } = liveTestHost((batch) =>
    batch === 0 ? { "every-filter": filterIgnored } : {},
  );
  const published = publications();
  let root = "";
  const f = await fixture(
    async (_request, index) => {
      if (index === 3)
        await writeWorkspace(root, {
          "test/cases.json": JSON.stringify({ ...combined, cases: [...combined.cases, ...overLimitCases] }),
        });
      // The fix for the ignored filter.
      if (index === 4) await writeWorkspace(root, { "src/tool.ts": `${toolSource}// fixed\n` });
      return (
        [
          call("execute", signInStep, "sign_in"),
          call("execute", example, "example"),
          call("live_tests", runAll, "run"),
          call("live_tests", { ...runAll, cases: ["third", "fourth", "fifth"] }, "third"),
          call("live_tests", { ...runAll, cases: ["every-filter"] }, "rerun"),
          call("live_tests", { ...runHttp, cases: ["every-filter", "other-sort"] }, "http"),
          call("finish_build", finish, "finish"),
        ][index] ?? prose()
      );
    },
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: signingIn,
      publish: published.publish,
    },
    read,
  );
  root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, {
    "src/tool.ts": toolSource,
    "src/tool-http.mjs": httpSource,
    "src/sign-in.ts": toolSource,
    "test/cases.json": JSON.stringify(combined),
  });
  await f.run();

  // The first passing example reminds a signed-in read of its combined case too.
  expect(resultOf(f.requests[2], "example")["testPlan"]).toMatchObject({ plannedCases: 2 });
  // Two inputs run, on the build's own signed-in browser only.
  expect(statuses(resultOf(f.requests[3], "run"))).toEqual({
    "every-filter": "fail",
    "other-sort": "pass",
  });
  // A batch that would add a fifth input runs nothing.
  expect(resultOf(f.requests[4], "third")).toMatchObject({ status: "limit" });
  // The same input again after the fix, and on the HTTP version, runs.
  expect(statuses(resultOf(f.requests[5], "rerun"))).toEqual({ "every-filter": "pass" });
  expect(statuses(resultOf(f.requests[6], "http"))).toEqual({
    "every-filter": "pass",
    "other-sort": "pass",
  });
  expect(batches.map((batch) => batch.cases.map((testCase) => testCase.id))).toEqual([
    ["every-filter", "other-sort"],
    ["every-filter"],
    ["every-filter", "other-sort"],
  ]);
  expect(batches.every((batch) => batch.signedIn === true && batch.workers === 1)).toBe(true);
  // Page two runs within the combined case, through the cursor page one returned.
  expect(batches[0]?.cases[0]?.nextPage).toEqual({ inputField: "cursor", outputField: "next_cursor" });

  // Publication gets the host's record of the signed-in cases, marked as a signed-in read's.
  const record = published.seen[0]?.liveTests as {
    signedIn?: boolean;
    cases: { id: string; results: Record<string, { status: string }> }[];
  };
  expect(record.signedIn).toBe(true);
  expect(
    Object.fromEntries(
      record.cases.map((testCase) => [
        testCase.id,
        [testCase.results["playwright"]?.status, testCase.results["http"]?.status],
      ]),
    ),
  ).toEqual({
    // other-sort ran on the source before the fix.
    "every-filter": ["pass", "pass"],
    "other-sort": ["stale", "pass"],
    third: ["not_run", "not_run"],
    fourth: ["not_run", "not_run"],
    fifth: ["not_run", "not_run"],
  });
});

it("counts a signed-in read's test inputs across live_tests and execute", async () => {
  const { host, batches } = liveTestHost({});
  const ran: (string | undefined)[] = [];
  const test = (testInput: object) => ({
    ...example,
    purpose: "test",
    testInput: JSON.stringify(testInput),
  });
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", signInStep, "sign_in"),
        call("execute", example, "example"),
        call("live_tests", { ...runAll, cases: ["every-filter"] }, "batch"),
        call("execute", test({ query: "lamp", sort: "price_high" }), "second"),
        call("execute", test({ query: "desk" }), "third"),
        call("execute", test({ query: "chair" }), "fourth"),
        call("execute", test({ query: "sofa" }), "fifth"),
        // The second input again, its keys in another order: no new input.
        call("execute", test({ sort: "price_high", query: "lamp" }), "again"),
        call("finish_build", finish, "finish"),
      ][index] ?? prose(),
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: (input, beforeDispatch) => {
        if (input.purpose === "test") ran.push(input.testInput);
        return signingIn(input, beforeDispatch);
      },
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, {
    "src/tool.ts": toolSource,
    "src/sign-in.ts": toolSource,
    "test/cases.json": JSON.stringify(combined),
  });
  await f.run();
  expect(batches).toHaveLength(1);
  expect(resultOf(f.requests[7], "fifth")).toMatchObject({ status: "unsupported" });
  expect(ran.map((input) => JSON.parse(input ?? "null") as unknown)).toEqual([
    { query: "lamp", sort: "price_high" },
    { query: "desk" },
    { query: "chair" },
    { sort: "price_high", query: "lamp" },
  ]);
});

// A takeover keeps a signed-in read's count: an input that ran before it runs again for free, and a
// batch that would take it past four distinct inputs stays refused.
it("keeps a signed-in read's counted inputs across a takeover", async () => {
  const { host, batches } = liveTestHost({});
  const checkpoints: { agent: MintAgentSnapshot; harness: MintHarnessSnapshot }[] = [];
  const files = {
    "src/tool.ts": toolSource,
    "src/sign-in.ts": toolSource,
    "test/cases.json": JSON.stringify({ ...combined, cases: [...combined.cases, ...overLimitCases] }),
  };
  const before = checkpointingMinter(
    (index) =>
      [
        call("execute", signInStep, "sign_in"),
        call("execute", example, "example"),
        call("live_tests", { ...runAll, cases: ["every-filter", "other-sort"] }, "run"),
      ][index] ?? prose(),
  );
  const first = await fixture(() => prose(), {
    model: before.model,
    liveTests: host,
    deadline: Deadline.after(30 * 60_000),
    reviewAndExecute: signingIn,
    agentRecovery: {
      save: (agent, harness) =>
        Effect.sync(() => {
          checkpoints.push({ agent, harness });
        }),
    },
  }, read);
  await writeWorkspace((first.workspace as unknown as { root: string }).root, files);
  await first.run().catch(() => undefined);
  const saved = checkpoints.find((checkpoint) => (checkpoint.harness.liveTests ?? []).length > 0);
  if (saved === undefined) throw new Error("No checkpoint with live test results");
  // The checkpoint round-trips as a stored one does.
  const stored = Schema.decodeUnknownSync(MintHarnessSnapshot)(
    JSON.parse(JSON.stringify(saved.harness)),
  );

  const after = checkpointingMinter(
    (index) =>
      [
        call("live_tests", { ...runAll, cases: ["every-filter"] }, "again"),
        call("live_tests", { ...runAll, cases: ["third", "fourth", "fifth"] }, "third"),
      ][index] ?? prose(),
  );
  const second = await fixture(() => prose(), {
    model: after.model,
    liveTests: host,
    deadline: Deadline.after(30 * 60_000),
    reviewAndExecute: signingIn,
    agentRecovery: { initial: { agent: saved.agent, harness: stored }, save: () => Effect.void },
  }, read);
  await writeWorkspace((second.workspace as unknown as { root: string }).root, files);
  await second.run().catch(() => undefined);
  expect(statuses(resultOf(after.requests[1], "again"))).toEqual({ "every-filter": "pass" });
  expect(resultOf(after.requests[2], "third")).toMatchObject({ status: "limit" });
  expect(batches.map((batch) => batch.cases.map((testCase) => testCase.id))).toEqual([
    ["every-filter", "other-sort"],
    ["every-filter"],
  ]);
});

// A host on the contract before signed-in batches never declares them, and would run a signed-in
// read's cases on new browsers with no session: such a read keeps proving its tool with its example.
it("runs no live tests for a signed-in read on a host that does not support signed-in batches", async () => {
  const { host, batches } = liveTestHost({}, undefined, { signedInBatches: false });
  const published = publications();
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", signInStep, "sign_in"),
        call("execute", example, "example"),
        call("live_tests", { ...runAll, cases: ["every-filter"] }, "run"),
        call("finish_build", finish, "finish"),
      ][index] ?? prose(),
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: signingIn,
      publish: published.publish,
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, {
    "src/tool.ts": toolSource,
    "src/sign-in.ts": toolSource,
    "test/cases.json": JSON.stringify(combined),
  });
  await f.run();
  // No test plan reminder after the example, the batch is refused, and nothing ran.
  expect(resultOf(f.requests[2], "example")["testPlan"]).toBeUndefined();
  expect(resultOf(f.requests[3], "run")).toMatchObject({ status: "unavailable" });
  expect(batches).toHaveLength(0);
  expect(published.seen[0]?.liveTests).toBeUndefined();
});

it("runs no live tests for a write, signed in or not", async () => {
  const { host, batches } = liveTestHost({});
  const f = await fixture(
    (_request, index) =>
      [call("execute", signInStep, "sign_in"), call("live_tests", runAll, "run")][index] ?? prose(),
    { liveTests: host, deadline: Deadline.after(30 * 60_000), reviewAndExecute: signingIn },
    { ...read, effect: "write" },
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, {
    "src/tool.ts": toolSource,
    "src/sign-in.ts": toolSource,
    "test/cases.json": JSON.stringify(combined),
  });
  await f.run();
  expect(resultOf(f.requests[2], "run")).toMatchObject({ status: "unavailable" });
  expect(batches).toHaveLength(0);
});

// Testing scope follows what the tool is now. A repair of a read that starts signed out runs its
// cases; once it signs in, it is a signed-in read held to four test inputs, and its publication
// carries only what ran signed in: here nothing, so the review judges its example.
it("holds a repair that signs in mid-build to the signed-in bound", async () => {
  const { host, batches } = liveTestHost({
    nothing: { status: "completed", output: { results: [], has_next_page: false, next_cursor: null } },
  });
  const published = publications();
  const f = await fixture(
    (_request, index) =>
      [
        call("live_tests", runAll, "before_sign_in"),
        call("execute", signInStep, "sign_in"),
        call("live_tests", runAll, "after_sign_in"),
        call("execute", example, "example"),
        call("finish_build", finish, "finish"),
      ][index] ?? prose(),
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: signingIn,
      publish: published.publish,
    },
    { ...read, mode: "maintenance", observations: { failure: "The results list did not load." } },
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, {
    "src/tool.ts": toolSource,
    "src/sign-in.ts": toolSource,
    "test/cases.json": JSON.stringify(withPassing(cases, 2)),
  });
  await f.run();
  expect(resultOf(f.requests[1], "before_sign_in")).toMatchObject({ status: "ran" });
  // Its cases hold five inputs, one more than a signed-in read runs.
  expect(resultOf(f.requests[3], "after_sign_in")).toMatchObject({ status: "limit" });
  expect(batches).toHaveLength(1);
  expect(published.seen).toHaveLength(1);
  expect(published.seen[0]?.liveTests).toBeUndefined();
  expect(published.seen[0]?.coverage).not.toContain("Host live tests");
});

const emptyResults = {
  status: "completed" as const,
  output: { results: [], has_next_page: false, next_cursor: null },
};
const httpFailure = {
  status: "failed" as const,
  errorClass: "OperationFailure",
  message: "Unexpected status 403",
  frame: "src/tool-http.mjs:9",
};

// An HTTP version ruled out at finish_build does not ship, so its failing batch results are
// neither recorded nor judged: the publication record lists the Playwright version alone.
it("leaves a ruled-out HTTP version's results out of the publication record", async () => {
  const { host } = liveTestHost((batch) =>
    batch === 0
      ? { nothing: emptyResults }
      : { "repeat-1": httpFailure, "sort-price": httpFailure, nothing: httpFailure, "page-2": httpFailure },
  );
  const published = publications();
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", example, "example"),
        call("live_tests", runAll, "run_playwright"),
        call("live_tests", runHttp, "run_http"),
        call(
          "finish_build",
          {
            ...finish,
            httpVersion: {
              outcome: "ruled_out",
              signal: "bot_wall_on_page_fetch",
              note: "Every request to the results route returned a challenge page.",
            },
          },
          "finish",
        ),
      ][index] ?? prose(),
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, {
    "src/tool.ts": toolSource,
    "src/tool-http.mjs": httpSource,
    "test/cases.json": JSON.stringify(cases),
  });
  const outcome = await f.run();
  expect(outcome.build).toBe("published");
  const record = published.seen[0]?.liveTests as {
    versions: { version: string }[];
    cases: { results: Record<string, { status: string }> }[];
    retired: unknown[];
  };
  expect(record.versions.map((entry) => entry.version)).toEqual(["playwright"]);
  expect(record.cases.every((testCase) => Object.keys(testCase.results).join() === "playwright")).toBe(
    true,
  );
  expect(record.cases.every((testCase) => testCase.results["playwright"]?.status === "pass")).toBe(true);
  expect(published.seen[0]?.coverage).not.toContain("HTTP version");
});

// An HTTP version the minter deleted after its batch failed does not ship either, so the record
// leaves it out as it does a ruled-out one: a version listed without its file would draw coverage
// findings no test can clear.
it("leaves a deleted HTTP version's results out of the publication record", async () => {
  const { host } = liveTestHost((batch) =>
    batch === 0
      ? { nothing: emptyResults }
      : { "repeat-1": httpFailure, "sort-price": httpFailure, nothing: httpFailure, "page-2": httpFailure },
  );
  const published = publications();
  let root = "";
  const f = await fixture(
    async (_request, index) => {
      // The agent deletes the HTTP version after its batch failed, then publishes.
      if (index === 3) await rm(join(root, "src/tool-http.mjs"));
      return (
        [
          call("execute", example, "example"),
          call("live_tests", runAll, "run_playwright"),
          call("live_tests", runHttp, "run_http"),
          call("finish_build", finish, "finish"),
        ][index] ?? prose()
      );
    },
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, {
    "src/tool.ts": toolSource,
    "src/tool-http.mjs": httpSource,
    "test/cases.json": JSON.stringify(cases),
  });
  const outcome = await f.run();
  expect(outcome.build).toBe("published");
  const record = published.seen[0]?.liveTests as { versions: { version: string }[] };
  expect(record.versions.map((entry) => entry.version)).toEqual(["playwright"]);
  expect(published.seen[0]?.coverage).not.toContain("HTTP version");
});

// The latest HTTP batch ran a scratch file, while src/tool-http.mjs still ships: the record lists
// the HTTP version by its conventional file, whether the minter deleted the scratch file, rather
// than dropping it, or kept it, rather than naming a file that does not ship.
it.each([
  { scratch: "deleted", remove: true },
  { scratch: "kept", remove: false },
])(
  "lists a shipping HTTP version by its file when its latest batch ran a scratch file, $scratch",
  async ({ remove }) => {
    const { host } = liveTestHost((batch) =>
      batch === 0
        ? { nothing: emptyResults }
        : { "repeat-1": httpFailure, "sort-price": httpFailure, nothing: httpFailure, "page-2": httpFailure },
    );
    const published = publications();
    let root = "";
    const f = await fixture(
      async (_request, index) => {
        if (index === 3 && remove) await rm(join(root, "src/scratch-http.mjs"));
        return (
          [
            call("execute", example, "example"),
            call("live_tests", runAll, "run_playwright"),
            call("live_tests", { ...runHttp, entrypoint: "src/scratch-http.mjs" }, "run_scratch"),
            call("finish_build", finish, "finish"),
          ][index] ?? prose()
        );
      },
      {
        liveTests: host,
        deadline: Deadline.after(30 * 60_000),
        reviewAndExecute: completedExample,
        publish: published.publish,
      },
      read,
    );
    root = (f.workspace as unknown as { root: string }).root;
    await writeWorkspace(root, {
      "src/tool.ts": toolSource,
      "src/tool-http.mjs": httpSource,
      "src/scratch-http.mjs": httpSource,
      "test/cases.json": JSON.stringify(cases),
    });
    const outcome = await f.run();
    expect(outcome.build).toBe("published");
    const record = published.seen[0]?.liveTests as {
      versions: { version: string; entrypoint?: string }[];
    };
    expect(record.versions.map((entry) => [entry.version, entry.entrypoint])).toEqual([
      ["playwright", "src/tool.ts"],
      ["http", "src/tool-http.mjs"],
    ]);
  },
);

// A sign-in counts only on the site it happened on: after an update moves the build to another
// site, the read has not signed in there, so it is a read signed out and runs its live tests.
it("runs live tests after an update moves a signed-in read to a site it has not signed in to", async () => {
  const sister = "https://shop.example.org";
  const { host, batches } = liveTestHost({ nothing: emptyResults });
  const published = publications();
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", signInStep, "sign_in"),
        call(
          "request_input",
          {
            questions: [
              {
                id: "site",
                type: "choice",
                prompt: `The catalog lives on ${sister}. Build the tool there?`,
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
            summary: `Build the tool on ${sister}, where the catalog lives.`,
            changes: [{ setting: "site", origin: sister }],
            confirmedBy: ["site"],
            recommend: "update",
          },
          "update",
        ),
        call("live_tests", runAll, "run"),
        call("execute", example, "example"),
        call("finish_build", finish, "finish"),
      ][index] ?? prose(),
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: signingIn,
      publish: published.publish,
      askInput: (submitted) =>
        Effect.sync(() =>
          Either.getOrThrow(
            validateAnswer(
              { ...submitted, id: "5b3f0e2a-6c1d-4f7e-9a8b-0c2d4e6f8a1b", source: "agent" },
              { site: "move" },
            ),
          ),
        ),
      reviewTaskUpdate: () =>
        Effect.succeed({ outcome: "allow" as const, rationale: "Scripted review.", reviewId: "review_update" }),
      applyTaskUpdate: () => Effect.succeed({ outcome: "applied" as const }),
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, {
    "src/tool.ts": toolSource,
    "src/sign-in.ts": toolSource,
    "test/cases.json": JSON.stringify(cases),
  });
  await f.run();
  expect(resultOf(f.requests[3], "update")).toMatchObject({ status: "updated" });
  expect(resultOf(f.requests[4], "run")).toMatchObject({ status: "ran" });
  expect(batches).toHaveLength(1);
  expect(published.seen[0]?.liveTests).toBeDefined();
});

// A checkpoint keeps the HTTP version's results in a field of their own. A worker from an older
// release drops that field and the entrypoints when it saves again, so the next new worker
// restores only the Playwright version's results, never the HTTP version's in their place.
it("never restores the HTTP version's results as the Playwright version's after an older worker", async () => {
  const { host } = liveTestHost((batch) =>
    batch === 0 ? { nothing: emptyResults } : { nothing: httpFailure, "sort-price": emptyResults },
  );
  const checkpoints: { agent: MintAgentSnapshot; harness: MintHarnessSnapshot }[] = [];
  const files = {
    "src/tool.ts": toolSource,
    "src/tool-http.mjs": httpSource,
    "test/cases.json": JSON.stringify(cases),
  };
  const before = checkpointingMinter(
    (index) =>
      [
        call("execute", example, "example"),
        call("live_tests", runAll, "run_playwright"),
        call("live_tests", runHttp, "run_http"),
      ][index] ?? prose(),
  );
  const first = await fixture(() => prose(), {
    model: before.model,
    liveTests: host,
    deadline: Deadline.after(30 * 60_000),
    reviewAndExecute: completedExample,
    agentRecovery: {
      save: (agent, harness) =>
        Effect.sync(() => {
          checkpoints.push({ agent, harness });
        }),
    },
  }, read);
  await writeWorkspace((first.workspace as unknown as { root: string }).root, files);
  await first.run().catch(() => undefined);
  const saved = checkpoints.find((checkpoint) => (checkpoint.harness.liveTestsHttp ?? []).length > 0);
  if (saved === undefined) throw new Error("No checkpoint with both versions' results");
  // The Playwright field holds the Playwright version's results alone.
  expect(saved.harness.liveTests?.map((record) => record.entrypoint)).toEqual(
    Array.from({ length: 4 }, () => "src/tool.ts"),
  );
  // What an older worker saves again: no HTTP field, and no entrypoints.
  const { liveTestsHttp: _http, ...kept } = saved.harness;
  const resaved = Schema.decodeUnknownSync(MintHarnessSnapshot)(
    JSON.parse(
      JSON.stringify({
        ...kept,
        liveTests: kept.liveTests?.map(({ entrypoint: _entrypoint, ...record }) => record),
      }),
    ),
  );

  const after = checkpointingMinter(
    (index) =>
      [
        call("live_tests", planOf("src/tool.ts"), "plan_playwright"),
        call("live_tests", planOf("src/tool-http.mjs"), "plan_http"),
      ][index] ?? prose(),
  );
  const second = await fixture(() => prose(), {
    model: after.model,
    liveTests: host,
    deadline: Deadline.after(30 * 60_000),
    reviewAndExecute: completedExample,
    agentRecovery: { initial: { agent: saved.agent, harness: resaved }, save: () => Effect.void },
  }, read);
  await writeWorkspace((second.workspace as unknown as { root: string }).root, files);
  await second.run().catch(() => undefined);
  const ids = ["repeat-1", "sort-price", "nothing", "page-2"];
  expect(statuses(resultOf(after.requests[1], "plan_playwright"))).toEqual(
    Object.fromEntries(ids.map((id) => [id, "pass"])),
  );
  expect(statuses(resultOf(after.requests[2], "plan_http"))).toEqual(
    Object.fromEntries(ids.map((id) => [id, "not_run"])),
  );
});

// Guardian's review of a blocked report read only the latest publication refusals' codes. The
// earlier denials it had to check the report against lived only in its own compacted
// conversation, so it rejected a true report as not established by the evidence. What a failing
// case threw is the agent's own tool code speaking, so the ledger keeps it apart from host facts.
// The host's own refusal of a batch, such as a cap on live runs, and a passing no-match case are
// on record too, so a report that cites either is judged against them.
it("shows the blocked-explanation review the build's denials and failing cases", async () => {
  const toolMessage = "The site demands a human check on every request; automation cannot continue";
  const gateReason = "This attempt has had every live run its host allows. No live test case ran.";
  const { host: ranHost } = liveTestHost({
    "sort-price": {
      status: "failed",
      errorClass: "SiteRequiresHumanVerification",
      message: toolMessage,
      frame: "src/tool.ts:12",
    },
    "page-2": { status: "failed", errorClass: "E".repeat(400) },
    nothing: { status: "completed", output: { results: [], has_next_page: false, next_cursor: null } },
  });
  let batchesRun = 0;
  const host: LiveTestHost = {
    ...ranHost,
    run: (batch) =>
      batchesRun++ === 0
        ? ranHost.run(batch)
        : Effect.fail(
            new MintFailure({ code: "ReconciliationRequired", recoveryGate: { reason: gateReason } }),
          ),
  };
  const explore = { ...example, purpose: "explore" };
  const executionRationale = "The submitted call creates server-side session state, so it is a write.";
  const publicationRationale = "The source reads a field the captures never show.";
  const findingExplanation = "The price field is read from a selector absent from every capture.";
  const reviewed: Parameters<NonNullable<MintDependencies["reviewQuestion"]>>[1][] = [];
  let root = "";
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", explore, "explore"),
        call("execute", example, "example"),
        call("live_tests", runAll, "run"),
        call("live_tests", runAll, "refused"),
        call("finish_build", finish, "finish"),
        call("report_blocked", {
          reason: "policy",
          explanation: "Guardian refused the call that creates the session state the site requires.",
        }),
      ][index] ?? prose(),
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: (input, beforeDispatch) =>
        input.purpose === "explore"
          ? Effect.fail(
              new MintFailure({
                code: "ReviewDenied",
                review: { outcome: "deny", reviewId: "review_explore", rationale: executionRationale },
              }),
            )
          : completedExample(input, beforeDispatch),
      publish: () =>
        Effect.fail(
          new MintFailure({
            code: "ReviewDenied",
            review: {
              outcome: "deny",
              reason: "source_correction",
              reviewId: "review_publication",
              rationale: publicationRationale,
              findings: [findingExplanation, "Second.", "Third.", "Fourth.", "Fifth."].map(
                (explanation) => ({
                  path: "src/tool.ts",
                  byteStart: 0,
                  byteEnd: 10,
                  category: "schema_mismatch" as const,
                  explanation,
                }),
              ),
            },
          }),
        ),
      reviewQuestion: (_request, options) =>
        Effect.sync(() => {
          reviewed.push(options);
          return { outcome: "allow_business" as const, rationale: "Consistent with the ledger." };
        }),
    },
    read,
  );
  root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, {
    "src/tool.ts": toolSource,
    "test/cases.json": JSON.stringify(withPassing(cases, 3)),
  });
  const outcome = await f.run();
  expect(outcome.blocked).toMatchObject({ reason: "policy" });
  expect(reviewed).toHaveLength(1);
  expect(reviewed[0]).toMatchObject({
    blockedOutcome: true,
    decisionLedger: {
      denials: [
        {
          review: "execution",
          outcome: "deny",
          reviewId: "review_explore",
          rationale: executionRationale,
        },
        {
          review: "publication",
          outcome: "deny",
          reason: "source_correction",
          reviewId: "review_publication",
          rationale: publicationRationale,
          findings: [findingExplanation, "Second.", "Third.", "Fourth."],
          omittedFindings: 1,
        },
      ],
      testCounts: { pass: 5, fail: 2, inconclusive: 0 },
      hostRefusals: [{ tool: "live_tests", code: "ReconciliationRequired", reason: gateReason }],
      noMatchCases: [{ caseId: "nothing", verdict: "pass" }],
    },
  });
  expect(reviewed[0]?.decisionLedger?.noMatchCases?.[0]?.excerpt).toBeDefined();
  const failures = reviewed[0]?.decisionLedger?.testFailures ?? [];
  // The verdict is the host's; the error class and message are only what the tool reported.
  expect(failures[0]).toEqual({
    caseId: "sort-price",
    entrypoint: "src/tool.ts",
    verdict: "fail",
    toolReported: { errorClass: "SiteRequiresHumanVerification", message: toolMessage },
  });
  expect(failures[1]?.toolReported?.errorClass?.length).toBeLessThanOrEqual(120);
});

// A read whose cases mostly fail on the source it publishes is not sent to publication review:
// the review would hold it back on those failures anyway, after minutes of review time. The bar
// is 70% of the cases with a pass or a fail on that source, not all of them, so that a case that
// is itself wrong does not hold back a working tool while it is corrected.

/**
 * `pass + fail + inconclusive` cases that each expect results, as one batch's outcomes: the first
 * `pass` return results, the next `inconclusive` meet a site block or a challenge, and the rest
 * fail with a timeout.
 */
const scoredBatch = (counts: { pass: number; fail: number; inconclusive?: number }) => {
  const inconclusive = counts.inconclusive ?? 0;
  const total = counts.pass + inconclusive + counts.fail;
  const ids = Array.from({ length: total }, (_unused, index) => `case-${index + 1}`);
  const outcomes: Record<string, LiveTestOutcome> = {};
  ids.forEach((id, index) => {
    if (index < counts.pass) return;
    outcomes[id] =
      index < counts.pass + inconclusive
        ? { status: "inconclusive", reason: index % 2 === 0 ? "site_block" : "challenge" }
        : {
            status: "failed",
            errorClass: "TimeoutError",
            message: "locator.click: Timeout 5000ms exceeded",
            frame: "src/tool.ts:12",
          };
  });
  const file = {
    cases: ids.map((id, index) => ({
      id,
      purpose: `Query ${index + 1} returns its results.`,
      input: { query: `query ${index + 1}` },
      expect: "result",
    })),
  };
  return { file, outcomes };
};

/** Runs one batch with `counts`, the example, then `finish_build`; what publication received. */
const finishAfterScoredBatch = async (counts: Parameters<typeof scoredBatch>[0]) => {
  const { file, outcomes } = scoredBatch(counts);
  const { host, batches } = liveTestHost(outcomes);
  const published = publications();
  const f = await fixture(
    (_request, index) =>
      [
        call("live_tests", runAll, "run"),
        call("execute", example, "example"),
        call("finish_build", finish, "finish"),
      ][index] ?? prose(),
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(file) });
  const outcome = await f.run();
  expect(batches).toHaveLength(1);
  return {
    outcome,
    reviews: published.seen,
    finished: () => resultOf(f.requests[3], "finish"),
  };
};

it("does not send a read to publication review while 8 of its 23 cases pass on that source", async () => {
  const { outcome, reviews, finished } = await finishAfterScoredBatch({ pass: 8, fail: 15 });

  // No review started: publish, which runs the review, was never called.
  expect(reviews).toHaveLength(0);
  expect(outcome.build).not.toBe("published");
  expect(finished()).toMatchObject({
    status: "not_published",
    code: "PublicationUnavailable",
    reason: "live_tests_below_threshold",
    userInputRequired: false,
    instruction:
      "Publication review not started: only 8 of 23 live test cases on src/tool.ts pass on this source (34%), and review starts at 70%. Fix the code where a case fails, or the case where it is wrong, run every case again, then call finish_build.",
  });
});

it.each([
  { label: "17 of 23 (73%)", counts: { pass: 17, fail: 6 } },
  { label: "exactly 70%, 7 of 10", counts: { pass: 7, fail: 3 } },
  { label: "exactly 70%, 14 of 20", counts: { pass: 14, fail: 6 } },
  // Thirteen inconclusive cases tested nothing about the tool: 7 of the 10 counted pass.
  { label: "7 of 10 counted, beside 13 inconclusive", counts: { pass: 7, fail: 3, inconclusive: 13 } },
  // Every case inconclusive: none counts, so the review judges coverage as before.
  { label: "no counted case, 5 inconclusive", counts: { pass: 0, fail: 0, inconclusive: 5 } },
])("sends a read to publication review once its cases pass at least 70%: $label", async ({ counts }) => {
  const { outcome, reviews } = await finishAfterScoredBatch(counts);
  expect(reviews).toHaveLength(1);
  expect(outcome.build).toBe("published");
});

it.each([
  // 69.6% is below 70%, and reads 69%, never rounded up to the bar it misses.
  { label: "16 of 23 (69%)", counts: { pass: 16, fail: 7 }, passed: "16 of 23", percent: 69 },
  // Inconclusive cases leave the counted ones: 6 of 10 is 60%, never 6 of 15.
  {
    label: "6 of 10 counted, beside 5 inconclusive",
    counts: { pass: 6, fail: 4, inconclusive: 5 },
    passed: "6 of 10",
    percent: 60,
  },
])("does not send a read to publication review below 70%: $label", async ({ counts, passed, percent }) => {
  const { reviews, finished } = await finishAfterScoredBatch(counts);
  expect(reviews).toHaveLength(0);
  expect(finished()).toMatchObject({ reason: "live_tests_below_threshold" });
  expect(finished()["instruction"]).toContain(
    `only ${passed} live test cases on src/tool.ts pass on this source (${percent}%), and review starts at 70%.`,
  );
});

// A refusal for the bar is the minter's to fix through its code or its cases. It is no host check
// refusing a step the build needs, so it grants no host_refused ending, and the host's record says
// a new live observation follows it.
it("records a refusal for the bar as needing new live tests, and grants no host_refused ending", async () => {
  const { file, outcomes } = scoredBatch({ pass: 8, fail: 15 });
  const { host } = liveTestHost(outcomes);
  const published = publications();
  const recorded: PublicationDecision[] = [];
  const f = await fixture(
    (_request, index) =>
      [
        call("live_tests", runAll, "run"),
        call("execute", example, "example"),
        call("finish_build", finish, "finish"),
        call(
          "report_blocked",
          { reason: "host_refused", explanation: "A OpenGPT check refused publication." },
          "blocked",
        ),
      ][index] ?? prose(),
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
      publicationDecisions: {
        record: (decision) =>
          Effect.sync(() => {
            recorded.push(decision);
          }),
        list: Effect.sync(() => recorded),
      },
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(file) });
  const outcome = await f.run();
  expect(published.seen).toHaveLength(0);
  expect(resultOf(f.requests[3], "finish")).toMatchObject({ reason: "live_tests_below_threshold" });
  expect(recorded).toEqual([
    expect.objectContaining({
      outcome: "refused",
      code: "PublicationUnavailable",
      reason: "live_tests_below_threshold",
      executionId: "execution_one",
      failedChecks: ["live_tests_below_threshold"],
      recovery: "new_observation",
    }),
  ]);
  expect(JSON.stringify(resultOf(f.requests[4], "blocked"))).toContain("host_not_refused");
  expect(outcome.blocked?.reason).not.toBe("host_refused");
});

/** `host` as a host that caps its batches leaves it once one ran: no case fits in what is left. */
const cappedAfterOneBatch = (host: LiveTestHost, batches: readonly LiveTestBatch[]): LiveTestHost => ({
  ...host,
  get caseTimeoutMs() {
    return batches.length === 0 ? 60_000 : Number.POSITIVE_INFINITY;
  },
});

// Once the attempt ran out of time for live tests, no case can run again, so a refusal that asks
// for that could never be met: the review decides on the record as it is, as before the bar.
it.each([
  { label: "a later batch the host refused as no_time", way: "no_time" },
  { label: "a case the attempt's deadline stopped", way: "deadline" },
] as const)("sends a read below the bar to review once time ran out for tests: $label", async ({ way }) => {
  const { file, outcomes } = scoredBatch({ pass: 2, fail: 5 });
  // Stopped by the attempt's end: inconclusive, so 2 of the 6 counted pass.
  const scored =
    way === "deadline"
      ? { ...outcomes, "case-3": { status: "inconclusive" as const, reason: "deadline" as const } }
      : outcomes;
  const { host, batches } = liveTestHost(scored);
  const capped = way === "no_time" ? cappedAfterOneBatch(host, batches) : host;
  const steps =
    way === "no_time"
      ? [call("live_tests", runAll, "run"), call("live_tests", runAll, "again")]
      : [call("live_tests", runAll, "run")];
  const published = publications();
  const f = await fixture(
    (_request, index) =>
      [...steps, call("execute", example, "example"), call("finish_build", finish, "finish")][index] ??
      prose(),
    {
      liveTests: capped,
      deadline: Deadline.after(way === "deadline" ? 5 * 60_000 : 30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(file) });
  const outcome = await f.run();
  expect(batches).toHaveLength(1);
  if (way === "no_time") expect(resultOf(f.requests[2], "again")).toMatchObject({ status: "no_time" });
  expect(published.seen).toHaveLength(1);
  expect(published.seen[0]?.liveTests).toMatchObject({ outOfTime: true });
  expect(published.seen[0]?.coverage).toContain(way === "deadline" ? "2 pass, 4 fail" : "2 pass, 5 fail");
  expect(outcome.build).toBe("published");
});

// A host that caps its batches says nothing as its last batch ends: no further batch fits from
// then on. A finish_build right after it cannot be asked to run the cases again either, or a fix
// it asks for would reach the review untested.
it("sends a read below the bar to review when no further batch fits after its last one", async () => {
  const { file, outcomes } = scoredBatch({ pass: 8, fail: 15 });
  const { host, batches } = liveTestHost(outcomes);
  const published = publications();
  const f = await fixture(
    (_request, index) =>
      [
        call("live_tests", runAll, "run"),
        call("execute", example, "example"),
        call("finish_build", finish, "finish"),
      ][index] ?? prose(),
    {
      liveTests: cappedAfterOneBatch(host, batches),
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(file) });
  const outcome = await f.run();
  expect(batches).toHaveLength(1);
  expect(published.seen).toHaveLength(1);
  expect(published.seen[0]?.coverage).toContain("8 pass, 15 fail");
  expect(outcome.build).toBe("published");
});

/**
 * A host that caps its batches at `regular` and keeps one more in reserve past the cap, each case
 * in it allowed `reservedMs`, until a batch runs on it.
 */
const cappedWithReserve = (
  host: LiveTestHost,
  batches: readonly LiveTestBatch[],
  { regular, caseMs = 60_000, reservedMs = 60_000 }: { regular: number; caseMs?: number; reservedMs?: number },
): LiveTestHost => ({
  ...host,
  get caseTimeoutMs() {
    return batches.length < regular ? caseMs : Number.POSITIVE_INFINITY;
  },
  get reservedCaseTimeoutMs() {
    return batches.length === regular ? reservedMs : undefined;
  },
});
const pageCases = (id: string) =>
  JSON.stringify({
    cases: [
      { id: "repeat-1", purpose: "The example on a fresh browser.", input: { query: "lamp" }, expect: "result" },
      { id, purpose: "Page two of thirty results.", input: { query: "lamp 30" }, expect: "result", next_page: true },
    ],
  });
const pageTimeout = {
  status: "failed" as const,
  errorClass: "TimeoutError",
  message: "locator.click: Timeout 5000ms exceeded",
  frame: "src/tool.ts:3",
};
const runCases = (ids: readonly string[]) => ({ ...runAll, cases: ids });

/**
 * A read whose next-page case failed and was rebuilt under a new id with the same input, which
 * passed on fixed source; then the source changed again, all within a host's cap of two batches.
 * Then each of `calls` and a publication. Each batch's cases run through `outcomes`.
 */
const pastTheCap = async (
  outcomes: (batch: number) => Readonly<Record<string, LiveTestOutcome>>,
  calls: readonly ModelResponse[],
  reserve: { readonly reservedMs?: number; readonly caseMs?: number; readonly attemptMs?: number } = {},
) => {
  const { host, batches } = liveTestHost(outcomes);
  const published = publications();
  let root = "";
  const edits: Readonly<Record<number, Readonly<Record<string, string>>>> = {
    1: { "src/tool.ts": `${toolSource}// pages fixed\n`, "test/cases.json": pageCases("page-30") },
    2: { "src/tool.ts": `${toolSource}// pages fixed\n// filters fixed\n` },
  };
  const steps = [
    call("live_tests", runAll, "first"),
    call("live_tests", runAll, "rebuilt"),
    ...calls,
    call("execute", example, "example"),
    call("finish_build", finish, "finish"),
  ];
  const f = await fixture(
    async (_request, index) => {
      const edit = edits[index];
      if (edit !== undefined) await writeWorkspace(root, edit);
      return steps[index] ?? prose();
    },
    {
      liveTests: cappedWithReserve(host, batches, { regular: 2, ...reserve }),
      deadline: Deadline.after(reserve.attemptMs ?? 30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": pageCases("page-and-next") });
  const outcome = await f.run();
  const record = published.seen[0]?.liveTests as {
    readonly outOfTime?: boolean;
    readonly cases: readonly { readonly id: string }[];
    readonly retired: readonly Record<string, unknown>[];
  };
  const stepOf = new Map(steps.map((step, index) => [(step.output[0] as { callId?: string }).callId, index]));
  /** What the call `callId` returned, as the model request after it carries it. */
  const answer = (callId: string) => resultOf(f.requests[(stepOf.get(callId) ?? -1) + 1], callId);
  return { outcome, batches, record, answer };
};
const failsFirst = (batch: number) => (batch === 0 ? { "page-and-next": pageTimeout } : {});

// Past a host's batch cap, the review still needs a case of a retired failure's exact input to pass
// on the source it publishes, or it holds publication back on that failure. The host's reserved
// batch runs that case, and only cases a failure is pending on, once.
it("runs the cases a failure is pending on in the host's reserved batch past its cap", async () => {
  const { outcome, batches, record, answer } = await pastTheCap(failsFirst, [
    call("live_tests", runAll, "all"),
    call("live_tests", runCases(["page-30"]), "reserved"),
    call("live_tests", runCases(["page-30"]), "again"),
  ]);
  // Every case at once is no reserved batch: the refusal names the case a failure is pending on.
  expect(answer("all")).toMatchObject({ status: "no_time", reservedFor: ["page-30"] });
  expect(answer("reserved")).toMatchObject({ status: "ran" });
  // The reserve is spent: the host offers none again.
  expect(answer("again")).toMatchObject({ status: "no_time" });
  expect(answer("again")).not.toHaveProperty("reservedFor");
  expect(batches.map((batch) => batch.cases.map((testCase) => testCase.id))).toEqual([
    ["repeat-1", "page-and-next"],
    ["repeat-1", "page-30"],
    ["page-30"],
  ]);
  // The exact input passed on the published source, so the retired failure no longer counts.
  expect(record.retired).toEqual([
    expect.objectContaining({ id: "page-and-next", lastVerdict: "fail", excusedBy: "page-30" }),
  ]);
  expect(record.retired[0]).not.toHaveProperty("clearedBy");
  expect(outcome.build).toBe("published");
});

it("keeps a failure counting when its case still fails in the reserved batch", async () => {
  const { batches, record, answer } = await pastTheCap(
    (batch) => (batch === 0 ? { "page-and-next": pageTimeout } : batch === 2 ? { "page-30": pageTimeout } : {}),
    [call("live_tests", runCases(["page-30"]), "reserved"), call("live_tests", runCases(["page-30"]), "again")],
  );
  expect(answer("reserved")).toMatchObject({ status: "ran" });
  expect(answer("again")).toMatchObject({ status: "no_time" });
  expect(answer("again")).not.toHaveProperty("reservedFor");
  expect(batches).toHaveLength(3);
  // The review reads the case failing on the source it publishes, and the retired failure still
  // counting.
  expect(record.cases).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "page-30", results: { playwright: expect.objectContaining({ status: "fail" }) } }),
    ]),
  );
  expect(record.retired).toEqual([
    expect.objectContaining({ id: "page-and-next", clearedBy: expect.anything() }),
  ]);
  expect(record.retired[0]).not.toHaveProperty("excusedBy");
});

// A run on the source a case failed on clears nothing: a pass there is flaky, and the failure keeps
// counting. So the reserve waits for an edit after the failure.
it("keeps the reserve while a case's failure is on the current source, and runs it after an edit", async () => {
  const { host, batches } = liveTestHost((batch) => (batch === 0 ? { "page-30": pageTimeout } : {}));
  const published = publications();
  let root = "";
  const steps = [
    call("live_tests", runAll, "first"),
    call("live_tests", runCases(["page-30"]), "unchanged"),
    call("live_tests", runCases(["page-30"]), "edited"),
    call("execute", example, "example"),
    call("finish_build", finish, "finish"),
  ];
  const f = await fixture(
    async (_request, index) => {
      if (index === 2) await writeWorkspace(root, { "src/tool.ts": `${toolSource}// pages fixed\n` });
      return steps[index] ?? prose();
    },
    {
      liveTests: cappedWithReserve(host, batches, { regular: 1 }),
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": pageCases("page-30") });
  await f.run();
  const unchanged = resultOf(f.requests[2], "unchanged");
  expect(unchanged).toMatchObject({ status: "no_time" });
  expect(unchanged).not.toHaveProperty("reservedFor");
  expect(resultOf(f.requests[3], "edited")).toMatchObject({ status: "ran" });
  expect(batches.map((batch) => batch.cases.map((testCase) => testCase.id))).toEqual([
    ["repeat-1", "page-30"],
    ["page-30"],
  ]);
});

// No regular batch fits once the reserve runs, so the record says time ran out even when no batch
// was refused first, and the review notes the untested gaps in its rationale only.
it("records that time ran out when the reserved batch runs before any refusal", async () => {
  const { answer, record } = await pastTheCap(failsFirst, [
    call("live_tests", runCases(["page-30"]), "reserved"),
  ]);
  expect(answer("reserved")).toMatchObject({ status: "ran" });
  expect(record.outOfTime).toBe(true);
});

it("refuses a reserved batch that names a case no failure is pending on, or that the attempt has no time for", async () => {
  const mixed = await pastTheCap(failsFirst, [
    call("live_tests", runCases(["repeat-1"]), "passing"),
    call("live_tests", runCases(["page-30", "repeat-1"]), "mixed"),
  ]);
  expect(mixed.answer("passing")).toMatchObject({ status: "no_time", reservedFor: ["page-30"] });
  expect(mixed.answer("mixed")).toMatchObject({ status: "no_time", reservedFor: ["page-30"] });
  expect(mixed.batches).toHaveLength(2);
  expect(mixed.record.outOfTime).toBe(true);
  // The attempt keeps two minutes after a batch: three minutes leave room for a 30 s case, not
  // for the reserve's two-minute one.
  const late = await pastTheCap(failsFirst, [call("live_tests", runCases(["page-30"]), "reserved")], {
    caseMs: 30_000,
    reservedMs: 120_000,
    attemptMs: 3 * 60_000,
  });
  expect(late.answer("reserved")).toMatchObject({ status: "no_time" });
  expect(late.answer("reserved")).not.toHaveProperty("reservedFor");
  expect(late.batches).toHaveLength(2);
});

/**
 * Publication that Guardian denies every time, as when a retired failure only a new batch on the
 * published source could clear keeps counting; `seen` counts the reviews.
 */
const deniedForRetiredFailure = () => {
  let seen = 0;
  const publish: MintDependencies["publish"] = () =>
    Effect.suspend(() => {
      seen += 1;
      return Effect.fail(
        new MintFailure({
          code: "ReviewDenied",
          review: {
            outcome: "deny",
            reason: "source_correction",
            reviewId: `review_publication_${seen}`,
            rationale: "A retired failure has no passing case of its input on the source being published.",
            findings: [
              {
                path: "publication/tests.json",
                byteStart: 0,
                byteEnd: 10,
                category: "schema_mismatch" as const,
                explanation: "A retired failure still counts.",
              },
            ],
          },
        }),
      );
    });
  return { publish, reviews: () => seen };
};
const spentExplanation =
  "The host ran every live test batch it allows, and the publication review still needs a retired failure to pass again on the final code.";
const reportSpent = (callId: string) =>
  call("report_blocked", { reason: "host_refused", explanation: spentExplanation }, callId);
const allowExplanation: MintDependencies["reviewQuestion"] = () =>
  Effect.succeed({ outcome: "allow_business" as const, rationale: "Consistent with the record." });
const parsedDiagnostics = (outcome: { readonly diagnostics: readonly string[] }) =>
  outcome.diagnostics.flatMap((entry) => {
    try {
      return [JSON.parse(entry) as Record<string, unknown>];
    } catch {
      return [];
    }
  });

// Past the host's last batch, a publication denial that only a new batch could clear can never be
// met in the attempt. The minter's honest stop on it ends the build blocked as the host's refusal,
// at once, instead of the attempt running on until it stops answering with a tool.
it("ends the build host_refused once the host refused live tests and a publication denial stands", async () => {
  const { file, outcomes } = scoredBatch({ pass: 6, fail: 1 });
  const { host, batches } = liveTestHost(outcomes);
  const guardian = deniedForRetiredFailure();
  const f = await fixture(
    (_request, index) =>
      [
        call("live_tests", runAll, "run"),
        call("live_tests", runAll, "again"),
        call("execute", example, "example"),
        call("finish_build", finish, "finish"),
        reportSpent("blocked"),
      ][index] ?? prose(),
    {
      liveTests: cappedAfterOneBatch(host, batches),
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: guardian.publish,
      reviewQuestion: allowExplanation,
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(file) });
  const outcome = await f.run();
  expect(batches).toHaveLength(1);
  // With no reserve, the answer prefers the honest stop after a denial that needs a new batch.
  expect(resultOf(f.requests[2], "again")).toMatchObject({ status: "no_time" });
  expect(String(resultOf(f.requests[2], "again")["instruction"])).toContain(
    "prefer report_blocked with reason host_refused",
  );
  expect(resultOf(f.requests[4], "finish")).toMatchObject({ code: "ReviewDenied" });
  // The build ends on the report: no turn after it, and the caller reads the explanation.
  expect(f.requests).toHaveLength(5);
  expect(outcome.build).toBe("incomplete");
  expect(outcome.blocked).toEqual({ reason: "host_refused", explanation: spentExplanation });
  expect(outcome.stopReason).toBe("host_refused");
  // The standing review finding stays on the outcome, and the record names what the report stood on.
  expect(outcome.publicationDenial).toEqual({ reason: "source_correction", category: "schema_mismatch" });
  expect(parsedDiagnostics(outcome)).toContainEqual(
    expect.objectContaining({ phase: "blocked", reason: "host_refused", basis: "live_tests_spent" }),
  );
  expect(outcome.summary).toContain("live test");
});

// host_refused stays strict: a no_time answer alone, with no denial standing, is no refusal of a
// step the build needs, and neither is a denial while the host would still run a batch.
it.each([
  { label: "no_time with no publication denial standing", way: "no_denial" },
  { label: "a publication denial while a batch still fits", way: "batch_fits" },
] as const)("refuses host_refused on $label", async ({ way }) => {
  const { file, outcomes } = scoredBatch({ pass: 6, fail: 1 });
  const { host, batches } = liveTestHost(outcomes);
  const guardian = deniedForRetiredFailure();
  const steps =
    way === "no_denial"
      ? [call("live_tests", runAll, "run"), call("live_tests", runAll, "again"), reportSpent("blocked")]
      : [
          call("live_tests", runAll, "run"),
          call("execute", example, "example"),
          call("finish_build", finish, "finish"),
          reportSpent("blocked"),
        ];
  const f = await fixture((_request, index) => steps[index] ?? prose(), {
    liveTests: way === "no_denial" ? cappedAfterOneBatch(host, batches) : host,
    deadline: Deadline.after(30 * 60_000),
    reviewAndExecute: completedExample,
    publish: guardian.publish,
    reviewQuestion: allowExplanation,
  }, read);
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(file) });
  const outcome = await f.run();
  if (way === "no_denial") {
    expect(resultOf(f.requests[2], "again")).toMatchObject({ status: "no_time" });
    expect(guardian.reviews()).toBe(0);
  } else expect(guardian.reviews()).toBe(1);
  expect(resultOf(f.requests[steps.length], "blocked")).toMatchObject({
    status: "blocked_refused",
    reason: "host_not_refused",
  });
  expect(outcome.blocked?.reason).not.toBe("host_refused");
});

// The reserve past a host's cap is a re-test the host would still run, so the report waits for it:
// the minter runs the cases a failure is pending on first, and only a denial that still stands
// after them ends the build.
it("refuses host_refused while the host's reserved batch would still run, and ends the build after it", async () => {
  const { host, batches } = liveTestHost((batch) => (batch === 0 ? { "page-30": pageTimeout } : {}));
  const guardian = deniedForRetiredFailure();
  let root = "";
  const steps = [
    call("live_tests", runAll, "first"),
    call("live_tests", runAll, "all"),
    call("execute", example, "example"),
    call("finish_build", finish, "finish"),
    reportSpent("early"),
    call("live_tests", runCases(["page-30"]), "reserved"),
    call("execute", example, "again"),
    call("finish_build", finish, "refinish"),
    reportSpent("spent"),
  ];
  const f = await fixture(
    async (_request, index) => {
      // The fix after the failure, so its case is one a failure is pending on.
      if (index === 1) await writeWorkspace(root, { "src/tool.ts": `${toolSource}// pages fixed\n` });
      return steps[index] ?? prose();
    },
    {
      liveTests: cappedWithReserve(host, batches, { regular: 1 }),
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: guardian.publish,
      reviewQuestion: allowExplanation,
    },
    read,
  );
  root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": pageCases("page-30") });
  const outcome = await f.run();
  expect(resultOf(f.requests[2], "all")).toMatchObject({ status: "no_time", reservedFor: ["page-30"] });
  expect(resultOf(f.requests[5], "early")).toMatchObject({
    status: "blocked_refused",
    reason: "live_tests_reserved",
    reservedFor: ["page-30"],
  });
  expect(resultOf(f.requests[6], "reserved")).toMatchObject({ status: "ran" });
  expect(batches.map((batch) => batch.cases.map((testCase) => testCase.id))).toEqual([
    ["repeat-1", "page-30"],
    ["page-30"],
  ]);
  expect(guardian.reviews()).toBe(2);
  // The build ends on the second report: no turn after it.
  expect(f.requests).toHaveLength(steps.length);
  expect(outcome.blocked).toEqual({ reason: "host_refused", explanation: spentExplanation });
});

// A case that failed on the current source is pending only once the code changes, so the reserve
// names no case yet, but it is still open: the report waits for it, and the no_time answer never
// prefers the stop while it is. After the fix, the reserve re-tests the case, and only a denial
// that still stands then ends the build.
it("refuses host_refused while the reserve is open with its case failing on the current source", async () => {
  const { host, batches } = liveTestHost((batch) => (batch === 0 ? { "page-30": pageTimeout } : {}));
  const guardian = deniedForRetiredFailure();
  const capped = cappedWithReserve(host, batches, { regular: 1 });
  let root = "";
  const steps = [
    call("live_tests", runAll, "first"),
    call("live_tests", runAll, "all"),
    call("execute", example, "example"),
    call("finish_build", finish, "finish"),
    reportSpent("early"),
    call("live_tests", runCases(["page-30"]), "reserved"),
    call("execute", example, "again"),
    call("finish_build", finish, "refinish"),
    reportSpent("spent"),
  ];
  const f = await fixture(
    async (_request, index) => {
      // The fix comes only after the refused report.
      if (index === 5) await writeWorkspace(root, { "src/tool.ts": `${toolSource}// pages fixed\n` });
      return steps[index] ?? prose();
    },
    {
      liveTests: capped,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: guardian.publish,
      reviewQuestion: allowExplanation,
    },
    read,
  );
  root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": pageCases("page-30") });
  const outcome = await f.run();
  const all = resultOf(f.requests[2], "all");
  expect(all).toMatchObject({ status: "no_time" });
  expect(all).not.toHaveProperty("reservedFor");
  expect(String(all["instruction"])).toContain("joins it once you change the code: page-30");
  expect(String(all["instruction"])).not.toContain("report_blocked");
  expect(resultOf(f.requests[5], "early")).toMatchObject({
    status: "blocked_refused",
    reason: "live_tests_reserved",
    reservedFor: [],
    failedOnSource: ["page-30"],
  });
  expect(String(resultOf(f.requests[5], "early")["instruction"])).not.toContain("rests on something else");
  expect(resultOf(f.requests[6], "reserved")).toMatchObject({ status: "ran" });
  expect(batches).toHaveLength(2);
  expect(capped.reservedCaseTimeoutMs).toBeUndefined();
  expect(guardian.reviews()).toBe(2);
  expect(f.requests).toHaveLength(steps.length);
  expect(outcome.blocked).toEqual({ reason: "host_refused", explanation: spentExplanation });
});

// The reserve being open decides the report alone, so a cases file that cannot be read when the
// minter reports never lets it stand: the minter fixes the file and runs the reserve first.
it("refuses host_refused while the reserve is open and the cases file cannot be read", async () => {
  const { host, batches } = liveTestHost((batch) => (batch === 0 ? { "page-30": pageTimeout } : {}));
  const guardian = deniedForRetiredFailure();
  const capped = cappedWithReserve(host, batches, { regular: 1 });
  let root = "";
  const steps = [
    call("live_tests", runAll, "first"),
    call("live_tests", runAll, "all"),
    call("execute", example, "example"),
    call("finish_build", finish, "finish"),
    reportSpent("early"),
  ];
  const f = await fixture(
    async (_request, index) => {
      if (index === 1) await writeWorkspace(root, { "src/tool.ts": `${toolSource}// pages fixed\n` });
      if (index === 4) await writeWorkspace(root, { "test/cases.json": "{ not json" });
      return steps[index] ?? prose();
    },
    {
      liveTests: capped,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: guardian.publish,
      reviewQuestion: allowExplanation,
    },
    read,
  );
  root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": pageCases("page-30") });
  const outcome = await f.run();
  expect(resultOf(f.requests[2], "all")).toMatchObject({ status: "no_time", reservedFor: ["page-30"] });
  expect(String(resultOf(f.requests[2], "all")["instruction"])).not.toContain("report_blocked");
  expect(resultOf(f.requests[5], "early")).toMatchObject({
    status: "blocked_refused",
    reason: "live_tests_reserved",
    reservedFor: [],
    failedOnSource: [],
  });
  expect(batches).toHaveLength(1);
  expect(capped.reservedCaseTimeoutMs).toBe(60_000);
  expect(outcome.blocked?.reason).not.toBe("host_refused");
});

// With the reserve open and no case failing, the refusal names no case to fix. A denial that still
// stands then rests on something other than a live test, so the minter fixes what it names.
it("refuses host_refused while the reserve is open with no case failing, and points at the denial", async () => {
  const { host, batches } = liveTestHost(() => ({}));
  const guardian = deniedForRetiredFailure();
  const steps = [
    call("live_tests", runAll, "first"),
    call("live_tests", runAll, "all"),
    call("execute", example, "example"),
    call("finish_build", finish, "finish"),
    reportSpent("early"),
  ];
  const f = await fixture(
    (_request, index) => steps[index] ?? prose(),
    {
      liveTests: cappedWithReserve(host, batches, { regular: 1 }),
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: guardian.publish,
      reviewQuestion: allowExplanation,
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": pageCases("page-30") });
  const outcome = await f.run();
  expect(resultOf(f.requests[2], "all")).toMatchObject({ status: "no_time" });
  expect(guardian.reviews()).toBe(1);
  const early = resultOf(f.requests[5], "early");
  expect(early).toMatchObject({
    status: "blocked_refused",
    reason: "live_tests_reserved",
    reservedFor: [],
    failedOnSource: [],
  });
  expect(String(early["instruction"])).toContain(
    "If publication/tests.json names no failure that still counts, the denial rests on something else, so prefer to fix what the denial names, then call finish_build again.",
  );
  expect(batches).toHaveLength(1);
  expect(outcome.blocked?.reason).not.toBe("host_refused");
});

// A signed-in read is held to the bar on the cases it ran signed in, the only ones its record
// holds: its combined case failing beside the one other case it ran is 1 of 2.
it("holds a signed-in read to the bar on the cases it ran signed in", async () => {
  const { host, batches } = liveTestHost({ "every-filter": filterIgnored });
  const published = publications();
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", signInStep, "sign_in"),
        call("execute", example, "example"),
        call("live_tests", runAll, "run"),
        call("finish_build", finish, "finish"),
      ][index] ?? prose(),
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: signingIn,
      publish: published.publish,
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, {
    "src/tool.ts": toolSource,
    "src/sign-in.ts": toolSource,
    "test/cases.json": JSON.stringify(combined),
  });
  await f.run();
  expect(batches).toHaveLength(1);
  expect(batches[0]?.signedIn).toBe(true);
  expect(published.seen).toHaveLength(0);
  expect(resultOf(f.requests[4], "finish")).toMatchObject({
    reason: "live_tests_below_threshold",
    instruction:
      "Publication review not started: only 1 of 2 live test cases on src/tool.ts pass on this source (50%), and review starts at 70%. Fix the code where a case fails, or the case where it is wrong, run every case again, then call finish_build.",
  });
});

// Only the version finish_build publishes is held to the bar. An HTTP version beside a published
// Playwright version is judged by the publication review from its own results, as before, so its
// failures never keep the Playwright version from review.
it.each([
  { published: "src/tool.ts", reviewed: true },
  { published: "src/tool-http.mjs", reviewed: false },
])(
  "holds the version it publishes to the bar, never an HTTP version beside it: $published",
  async ({ published: entrypoint, reviewed }) => {
    const { host, batches } = liveTestHost((batch) =>
      batch === 0
        ? { nothing: emptyResults }
        : { "repeat-1": httpFailure, "sort-price": httpFailure, nothing: httpFailure, "page-2": httpFailure },
    );
    const published = publications();
    const f = await fixture(
      (_request, index) =>
        [
          call("live_tests", runAll, "run_playwright"),
          call("live_tests", runHttp, "run_http"),
          call("execute", { ...example, entrypoint }, "example"),
          call("finish_build", { ...finish, entrypoint }, "finish"),
        ][index] ?? prose(),
      {
        liveTests: host,
        deadline: Deadline.after(30 * 60_000),
        reviewAndExecute: completedExample,
        publish: published.publish,
      },
      read,
    );
    const root = (f.workspace as unknown as { root: string }).root;
    await writeWorkspace(root, {
      "src/tool.ts": toolSource,
      "src/tool-http.mjs": httpSource,
      "test/cases.json": JSON.stringify(cases),
    });
    await f.run();
    expect(batches).toHaveLength(2);
    if (reviewed) {
      expect(published.seen).toHaveLength(1);
      expect(published.seen[0]?.coverage).toContain("HTTP version (src/tool-http.mjs): 0 pass, 4 fail");
    } else {
      expect(published.seen).toHaveLength(0);
      expect(resultOf(f.requests[4], "finish")["instruction"]).toContain(
        "only 0 of 4 live test cases on src/tool-http.mjs pass on this source (0%)",
      );
    }
  },
);

// Only results on the source being published count. Once the source changes they are stale and
// test nothing there, so they hold nothing back: the review judges the stale cases as before.
it("counts no result that ran on an earlier source", async () => {
  const { file, outcomes } = scoredBatch({ pass: 8, fail: 15 });
  const { host } = liveTestHost(outcomes);
  const published = publications();
  let root = "";
  const f = await fixture(
    async (_request, index) => {
      // The agent edits the source after the batch, then runs the example again on it.
      if (index === 1) await writeWorkspace(root, { "src/tool.ts": `${toolSource}// edited\n` });
      return (
        [
          call("live_tests", runAll, "run"),
          call("execute", example, "example"),
          call("finish_build", finish, "finish"),
        ][index] ?? prose()
      );
    },
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(file) });
  await f.run();
  expect(published.seen).toHaveLength(1);
  expect(published.seen[0]?.coverage).toContain("0 pass, 0 fail, 0 inconclusive, 23 stale");
});

// A host can hold publication review while a counted case fails on the source being published
// (`LiveTestHost.holdReviewOnFailingCases`). The review would deny such a build on that case
// anyway, as a schema mismatch at the line it threw from, after minutes of review time. So
// finish_build names the failing cases and starts no review, and the minter fixes the code or
// retires the case. Once no case can run again, the review decides on the record as before.

/** `host` as a host that holds publication review while a counted case fails. */
const holdingReview = (host: LiveTestHost): LiveTestHost => ({
  ...host,
  holdReviewOnFailingCases: true,
});

/**
 * Publication through a scripted Guardian review, as a host runs it: Guardian starts, then holds
 * publication back on each case that fails on the published Playwright source, as a schema
 * mismatch at the line it threw from, and allows it otherwise. `events` lists what each review
 * emitted.
 */
const guardianPublication = () => {
  const events: string[] = [];
  const publish: MintDependencies["publish"] = (_request, _evidence, hostEvidence) =>
    Effect.suspend(() => {
      events.push("guardian.started");
      const record = hostEvidence?.liveTests as
        | { readonly cases: readonly { readonly id: string; readonly results: Record<string, { readonly status: string }> }[] }
        | undefined;
      const failing = (record?.cases ?? []).filter(
        (testCase) => testCase.results["playwright"]?.status === "fail",
      );
      if (failing.length === 0) {
        events.push("guardian.completed:allow");
        return Effect.succeed({ publicationRef: "published_revision", diagnostics: [] });
      }
      events.push("guardian.completed:deny");
      return Effect.fail(
        new MintFailure({
          code: "ReviewDenied",
          review: {
            outcome: "deny",
            reason: "source_correction",
            reviewId: "review_publication",
            rationale: "A live test case fails on the source being published.",
            findings: failing.map((testCase) => ({
              path: "src/tool.ts",
              byteStart: 0,
              byteEnd: 10,
              category: "schema_mismatch" as const,
              explanation: `Case ${testCase.id} fails on this source.`,
            })),
          },
        }),
      );
    });
  return { events, publish };
};

/** Runs one batch with `counts`, the example, then `finish_build`, through `guardianPublication`. */
const finishThroughGuardian = async (
  counts: Parameters<typeof scoredBatch>[0],
  holdReview: boolean,
) => {
  const { file, outcomes } = scoredBatch(counts);
  const { host, batches } = liveTestHost(outcomes);
  const guardian = guardianPublication();
  const f = await fixture(
    (_request, index) =>
      [
        call("live_tests", runAll, "run"),
        call("execute", example, "example"),
        call("finish_build", finish, "finish"),
      ][index] ?? prose(),
    {
      liveTests: holdReview ? holdingReview(host) : host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: guardian.publish,
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(file) });
  const outcome = await f.run();
  expect(batches).toHaveLength(1);
  return { outcome, events: guardian.events, finished: () => resultOf(f.requests[3], "finish") };
};

/** What the refusal tells the minter after it names the failing cases. */
const failingCasesGuidance =
  "and the review holds publication back on a failing case. Prefer fixing the code where a case fails; retire a case, by changing or deleting it in test/cases.json, only where the case itself is wrong. After a code fix, run every case again; then call finish_build.";

it("names a case that fails on the published source instead of starting publication review", async () => {
  // Six of seven cases pass, 85%, which clears the 70% bar.
  const { outcome, events, finished } = await finishThroughGuardian({ pass: 6, fail: 1 }, true);

  // No review started, so no Guardian event: finish_build answered at once, naming the case.
  expect(events).toEqual([]);
  expect(outcome.build).not.toBe("published");
  expect(finished()).toMatchObject({
    status: "not_published",
    code: "PublicationUnavailable",
    reason: "live_test_cases_failing",
    userInputRequired: false,
    instruction: `Publication review not started: live test case case-7 on src/tool.ts fails on this source, ${failingCasesGuidance}`,
  });
});

it("names every failing case of the published version", async () => {
  const { events, finished } = await finishThroughGuardian({ pass: 8, fail: 2 }, true);
  expect(events).toEqual([]);
  expect(finished()).toMatchObject({
    reason: "live_test_cases_failing",
    instruction: `Publication review not started: live test cases case-9 and case-10 on src/tool.ts fail on this source, ${failingCasesGuidance}`,
  });
});

// A host that does not hold the review sends the same build to it, as before: the review starts
// and holds publication back on the failing case as a schema mismatch.
it("sends a read with a failing case to publication review on a host that does not hold it", async () => {
  const { outcome, events, finished } = await finishThroughGuardian({ pass: 6, fail: 1 }, false);
  expect(events).toEqual(["guardian.started", "guardian.completed:deny"]);
  expect(outcome.build).not.toBe("published");
  expect(finished()).toMatchObject({ status: "not_published", code: "ReviewDenied" });
  expect(JSON.stringify(finished())).toContain("schema_mismatch");
});

it.each([
  { label: "every case passes", counts: { pass: 7, fail: 0 } },
  // Inconclusive cases tested nothing about the tool, so they hold nothing back.
  { label: "the rest are inconclusive", counts: { pass: 5, fail: 0, inconclusive: 2 } },
])("starts publication review as before when no counted case fails: $label", async ({ counts }) => {
  const { outcome, events } = await finishThroughGuardian(counts, true);
  expect(events).toEqual(["guardian.started", "guardian.completed:allow"]);
  expect(outcome.build).toBe("published");
});

// Below 70% the bar's own refusal stands, worded as before.
it("keeps the bar's refusal for a read whose cases pass below 70%", async () => {
  const { events, finished } = await finishThroughGuardian({ pass: 2, fail: 5 }, true);
  expect(events).toEqual([]);
  expect(finished()).toMatchObject({ reason: "live_tests_below_threshold" });
});

// Retiring the case releases the hold: the review then judges the retired failure from the
// record, as it does any retired case.
it("starts publication review once the minter retires the failing case", async () => {
  const { file, outcomes } = scoredBatch({ pass: 6, fail: 1 });
  const { host } = liveTestHost(outcomes);
  const guardian = guardianPublication();
  const recorded: PublicationDecision[] = [];
  let root = "";
  const f = await fixture(
    async (_request, index) => {
      // After the refusal, the minter deletes the case it judged wrong.
      if (index === 3)
        await writeWorkspace(root, {
          "test/cases.json": JSON.stringify({ cases: file.cases.filter(({ id }) => id !== "case-7") }),
        });
      return (
        [
          call("live_tests", runAll, "run"),
          call("execute", example, "example"),
          call("finish_build", finish, "finish"),
          call("finish_build", finish, "again"),
        ][index] ?? prose()
      );
    },
    {
      liveTests: holdingReview(host),
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: guardian.publish,
      publicationDecisions: {
        record: (decision) =>
          Effect.sync(() => {
            recorded.push(decision);
          }),
        list: Effect.sync(() => recorded),
      },
    },
    read,
  );
  root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(file) });
  const outcome = await f.run();
  expect(resultOf(f.requests[3], "finish")).toMatchObject({ reason: "live_test_cases_failing" });
  // The refusal is the minter's to fix and needs a new live observation, like the bar's.
  expect(recorded[0]).toMatchObject({
    outcome: "refused",
    code: "PublicationUnavailable",
    reason: "live_test_cases_failing",
    failedChecks: ["live_test_cases_failing"],
    recovery: "new_observation",
  });
  expect(guardian.events).toEqual(["guardian.started", "guardian.completed:allow"]);
  expect(outcome.build).toBe("published");
});

// A refusal that names failing cases is the minter's to fix, so it grants no host_refused ending.
it("grants no host_refused ending after naming a failing case", async () => {
  const { file, outcomes } = scoredBatch({ pass: 6, fail: 1 });
  const { host } = liveTestHost(outcomes);
  const guardian = guardianPublication();
  const f = await fixture(
    (_request, index) =>
      [
        call("live_tests", runAll, "run"),
        call("execute", example, "example"),
        call("finish_build", finish, "finish"),
        call(
          "report_blocked",
          { reason: "host_refused", explanation: "A OpenGPT check refused publication." },
          "blocked",
        ),
      ][index] ?? prose(),
    {
      liveTests: holdingReview(host),
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: guardian.publish,
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(file) });
  const outcome = await f.run();
  expect(guardian.events).toEqual([]);
  expect(JSON.stringify(resultOf(f.requests[4], "blocked"))).toContain("host_not_refused");
  expect(outcome.blocked?.reason).not.toBe("host_refused");
});

// Once no case can run again, a refusal that asks for that could never be met: the review decides
// on the record as it is, as for the bar.
it.each([
  { label: "no further batch fits after the last one", way: "capped" },
  { label: "a later batch the host refused as no_time", way: "no_time" },
  { label: "a case the attempt's deadline stopped", way: "deadline" },
] as const)("starts publication review with a failing case once no case can run again: $label", async ({ way }) => {
  const { file, outcomes } = scoredBatch({ pass: 6, fail: 1 });
  const scored =
    way === "deadline"
      ? { ...outcomes, "case-3": { status: "inconclusive" as const, reason: "deadline" as const } }
      : outcomes;
  const { host, batches } = liveTestHost(scored);
  // Hold first, then cap: the cap reads the batches each time it is asked.
  const holding = holdingReview(host);
  const liveTests = way === "deadline" ? holding : cappedAfterOneBatch(holding, batches);
  const steps =
    way === "no_time"
      ? [call("live_tests", runAll, "run"), call("live_tests", runAll, "again")]
      : [call("live_tests", runAll, "run")];
  const guardian = guardianPublication();
  const f = await fixture(
    (_request, index) =>
      [...steps, call("execute", example, "example"), call("finish_build", finish, "finish")][index] ??
      prose(),
    {
      liveTests,
      deadline: Deadline.after(way === "deadline" ? 5 * 60_000 : 30 * 60_000),
      reviewAndExecute: completedExample,
      publish: guardian.publish,
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(file) });
  await f.run();
  expect(batches).toHaveLength(1);
  if (way === "no_time") expect(resultOf(f.requests[2], "again")).toMatchObject({ status: "no_time" });
  expect(guardian.events).toEqual(["guardian.started", "guardian.completed:deny"]);
});

// Only the version finish_build publishes is held: an HTTP version's failures beside a published
// Playwright version go to the review from its own results, as before.
it("never holds a published Playwright version back on an HTTP version's failing cases", async () => {
  const { host } = liveTestHost((batch) =>
    batch === 0
      ? { nothing: emptyResults }
      : { "repeat-1": httpFailure, "sort-price": httpFailure, nothing: httpFailure, "page-2": httpFailure },
  );
  const guardian = guardianPublication();
  const f = await fixture(
    (_request, index) =>
      [
        call("live_tests", runAll, "run_playwright"),
        call("live_tests", runHttp, "run_http"),
        call("execute", example, "example"),
        call("finish_build", finish, "finish"),
      ][index] ?? prose(),
    {
      liveTests: holdingReview(host),
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: guardian.publish,
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, {
    "src/tool.ts": toolSource,
    "src/tool-http.mjs": httpSource,
    "test/cases.json": JSON.stringify(cases),
  });
  const outcome = await f.run();
  expect(guardian.events).toEqual(["guardian.started", "guardian.completed:allow"]);
  expect(outcome.build).toBe("published");
});

// A live test batch since the host refused a submission is new evidence, so the same submission
// sent again after a later finish_build got past that refusal is a new refusal, which a
// host_refused report stands on.
it("counts a host refusal of a resent submission after a live test batch since as a new refusal", async () => {
  const { file, outcomes } = scoredBatch({ pass: 7, fail: 0 });
  const { host, batches } = liveTestHost(outcomes);
  const refusals = [
    new MintFailure({ code: "PublicationUnavailable", reason: "autofill_recipe_not_verified" }),
    new MintFailure({
      code: "ReviewDenied",
      review: {
        outcome: "deny",
        reason: "source_correction",
        reviewId: "review_correction",
        rationale: "Read the price from the result row.",
        findings: [],
      },
    }),
    new MintFailure({ code: "PublicationUnavailable", reason: "autofill_recipe_not_verified" }),
  ];
  let published = 0;
  const explanation = "A OpenGPT check refused publication, so no tool was published.";
  const f = await fixture(
    (_request, index) =>
      [
        call("live_tests", runAll, "run"),
        call("execute", example, "example"),
        call("finish_build", finish, "refused"),
        call("finish_build", { ...finish, coverage: "Reviewed again." }, "denied"),
        call("live_tests", runAll, "again"),
        call("finish_build", finish, "resent"),
        call("report_blocked", { reason: "host_refused", explanation }, "blocked"),
      ][index] ?? prose(),
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: () => Effect.fail(refusals[published++] ?? refusals[0]!),
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(file) });
  const outcome = await f.run();
  expect(batches).toHaveLength(2);
  expect(published).toBe(3);
  expect(resultOf(f.requests[6], "resent")).toMatchObject({ reason: "autofill_recipe_not_verified" });
  expect(outcome.blocked).toEqual({ reason: "host_refused", explanation });
});
