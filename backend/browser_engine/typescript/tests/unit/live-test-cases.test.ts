import { Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  caseDigest,
  cursorPairOf,
  decodeCasesFile,
  failingCasesRefusal,
  failingLiveTestCases,
  judgeCase,
  liveTestsEvidence,
  liveTestsEvidenceProblem,
  primaryListOf,
  signedInTestInputRefusal,
  testInputKey,
  uncountedTestInputs,
} from "../../src/mint/live-tests.js";

// What the runner reads from a tool's schemas, and the verdicts, are pure and full of edge cases:
// schema shapes the host must read right, so a correct tool is judged by its real results list.

const object = (
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): Record<string, unknown> => ({ type: "object", properties, required });

describe("cursorPairOf", () => {
  it("reads a string cursor beside a boolean has_next_page, never the boolean", () => {
    const output = object({
      results: { type: "array" },
      has_next_page: { type: "boolean" },
      next_cursor: { anyOf: [{ type: "string" }, { type: "null" }] },
    });
    const input = object({ query: { type: "string" }, cursor: { type: ["string", "null"] } }, [
      "query",
    ]);
    expect(cursorPairOf(input, output)).toEqual({ inputField: "cursor", outputField: "next_cursor" });
  });

  it("reads only the runtime's string cursor and next_cursor, never a continuation of the tool's own", () => {
    const results = { results: { type: "array" } };
    for (const [input, output] of [
      [{ page_token: { type: "string" } }, { next_page_token: { type: "string" } }],
      [{ continuation: { type: "string" } }, { continuation_token: { type: "string" } }],
      [{ cursor: { type: "string" } }, { cursor: { type: "string" } }],
      [{ next_cursor: { type: "string" } }, { next_cursor: { type: "string" } }],
      [{ cursor: { type: "integer" } }, { next_cursor: { type: "integer" } }],
      [{ cursor: { type: "string" } }, { next_cursor: { type: "number" } }],
    ] as const)
      expect(cursorPairOf(object(input), object({ ...results, ...output }))).toBeUndefined();
  });

  it("finds no cursor when only a boolean says there is a next page", () => {
    const output = object({ results: { type: "array" }, has_next_page: { type: "boolean" } });
    const input = object({ query: { type: "string" }, page_token: { type: "boolean" } });
    expect(cursorPairOf(input, output)).toBeUndefined();
  });
});

describe("primaryListOf", () => {
  it("reads a details record with image and variant lists as a details read", () => {
    const input = object({ url: { type: "string" }, size: { type: "string" } }, ["url"]);
    const output = object({
      title: { type: "string" },
      price: { type: "number" },
      images: { type: "array", items: { type: "string" } },
      variants: { type: "array", items: object({ name: { type: "string" } }) },
    });
    expect(primaryListOf(input, output)).toBeUndefined();
  });

  it("finds the results list of a search beside other arrays", () => {
    const input = object(
      { query: { type: "string" }, limit: { type: "integer" }, store_id: { type: "string" } },
      ["query"],
    );
    const output = object({
      facets: { type: "array", items: object({ name: { type: "string" } }) },
      results: { type: "array", items: object({ title: { type: "string" } }) },
    });
    expect(primaryListOf(input, output)).toEqual({ field: "results" });
  });
});

describe("judgeCase", () => {
  const completed = (output: unknown) => ({
    id: "case",
    outcome: { status: "completed" as const, output },
    durationMs: 1,
  });

  it("judges a list read by its results list", () => {
    const results = { field: "results" };
    const judge = (expectation: "result" | "empty", output: unknown) =>
      judgeCase({ expect: expectation }, completed(output), results);
    expect(judge("result", { results: [{}], facets: [] }).verdict).toBe("pass");
    expect(judge("result", { results: [], facets: [{}] }).verdict).toBe("fail");
    expect(judge("empty", { results: [], facets: [{}] }).verdict).toBe("pass");
    expect(judge("empty", { results: [{}] })).toMatchObject({ verdict: "fail", got: "results (1)" });
  });

  // A cursor the tool ignores reloads page one: page two then repeats its rows.
  it("fails a page two that only repeats page one's rows, and passes one that moves on", () => {
    const results = { field: "results" };
    const paged = (first: unknown, second: unknown) => ({
      ...completed(first),
      followUp: { status: "completed" as const, output: second },
    });
    const page = (...names: string[]) => ({ results: names.map((name) => ({ name, price: 1 })) });
    const reordered = { results: [{ price: 1, name: "b" }, { price: 1, name: "a" }] };
    expect(judgeCase({ expect: "result" }, paged(page("a", "b"), reordered), results)).toMatchObject({
      verdict: "fail",
      got: "results (2)",
    });
    // A subset of page one's rows is a repeat too.
    expect(judgeCase({ expect: "result" }, paged(page("a", "b"), page("b")), results).verdict).toBe("fail");
    // A page two that holds one new row moves on, though the list shifted by a row.
    expect(judgeCase({ expect: "result" }, paged(page("a", "b"), page("b", "c")), results).verdict).toBe(
      "pass",
    );
    // An empty page two is judged as before, and a details read has no list to compare.
    expect(judgeCase({ expect: "result" }, paged(page("a"), page()), results).verdict).toBe("fail");
    expect(
      judgeCase({ expect: "result" }, paged({ title: "a" }, { title: "a" }), undefined).verdict,
    ).toBe("pass");
  });

  it("judges a details record by its values, never by its empty lists", () => {
    const record = { title: "Lamp", price: 10, images: [], variants: [] };
    expect(judgeCase({ expect: "result" }, completed(record), undefined).verdict).toBe("pass");
    expect(judgeCase({ expect: "result" }, completed({ title: null, images: [] }), undefined).verdict).toBe(
      "fail",
    );
    expect(judgeCase({ expect: "invalid_input" }, completed(record), undefined).verdict).toBe("fail");
  });

  // A reservation lookup whose place takes no online bookings answers with a filled record and no
  // times list, which its output schema allows.
  it("judges a filled record whose nullable list is null as a result", () => {
    const input = object({ place: { type: "string" }, date: { type: "string" } }, ["place", "date"]);
    const times = { type: "array", items: object({ time: { type: "string" } }) };
    const output = (list: unknown) =>
      object({ status: { type: "string" }, address: { type: ["string", "null"] }, available_times: list });
    const nullable = primaryListOf(input, output({ ...times, type: ["array", "null"] }));
    const record = { status: "not on the reservation network", address: "1 Main St", available_times: null };
    expect(judgeCase({ expect: "result" }, completed(record), nullable)).toMatchObject({
      verdict: "pass",
      got: "a result (no available_times)",
    });
    expect(judgeCase({ expect: "result" }, completed(record), primaryListOf(input, output(times))).verdict).toBe("fail");
    expect(judgeCase({ expect: "result" }, completed({ status: "", available_times: null }), nullable).detail).toBe(
      "The tool returned a record whose available_times is null. If the site lists no available_times for this input, expect empty for this case, or choose an input the site lists available_times for.",
    );
  });

  it("passes a refusal only where one was expected, and a loud failure but not a timeout", () => {
    const refused = {
      id: "case",
      outcome: { status: "invalid_input" as const, field: "size", available: ["s", "m"] },
      durationMs: 1,
    };
    expect(judgeCase({ expect: "invalid_input" }, refused, undefined)).toMatchObject({
      verdict: "pass",
      refusal: { field: "size", available: ["s", "m"] },
    });
    expect(judgeCase({ expect: "result" }, refused, undefined).verdict).toBe("fail");
    const failed = (errorClass: string) => ({
      id: "case",
      outcome: { status: "failed" as const, errorClass, frame: "src/tool.mjs:40" },
      durationMs: 1,
    });
    expect(judgeCase({ expect: "error" }, failed("InputNotApplied"), undefined).verdict).toBe("pass");
    // An older runtime's name for the same refusal.
    expect(judgeCase({ expect: "error" }, failed("LocationNotApplied"), undefined).verdict).toBe("pass");
    expect(judgeCase({ expect: "error" }, failed("TimeoutError"), undefined).verdict).toBe("fail");
    // Only a declared refusal is the loud failure a case expects; a code bug never passes.
    expect(judgeCase({ expect: "error" }, failed("OperationFailure"), undefined).verdict).toBe("fail");
    expect(judgeCase({ expect: "error" }, failed("TypeError"), undefined).verdict).toBe("fail");
    expect(judgeCase({ expect: "result" }, failed("TimeoutError"), undefined)).toMatchObject({
      verdict: "fail",
      frame: "src/tool.mjs:40",
    });
  });

  it("judges a next-page case on page 2, and never fails it for a challenge", () => {
    const paged = {
      id: "case",
      outcome: { status: "completed" as const, output: { results: [{}], next_cursor: "c2" } },
      followUp: { status: "completed" as const, output: { results: [] } },
      durationMs: 1,
    };
    expect(judgeCase({ expect: "result" }, paged, { field: "results" })).toMatchObject({ verdict: "fail" });
    expect(
      judgeCase(
        { expect: "result" },
        { id: "case", outcome: { status: "inconclusive", reason: "challenge" }, durationMs: 1 },
        { field: "results" },
      ).verdict,
    ).toBe("inconclusive");
  });
});

describe("caseDigest", () => {
  it("keeps a result when only the case's purpose is reworded or its noMatch mark changes", () => {
    const testCase = { id: "a", purpose: "One.", input: { query: "lamp" }, expect: "result" as const };
    expect(caseDigest({ ...testCase, purpose: "Another." })).toBe(caseDigest(testCase));
    expect(caseDigest({ ...testCase, noMatch: true })).toBe(caseDigest(testCase));
    expect(caseDigest({ ...testCase, expect: "empty" })).not.toBe(caseDigest(testCase));
  });
});

describe("decodeCasesFile", () => {
  it("refuses a duplicate case id, a case with no expectation and one with no purpose", () => {
    const one = { id: "a", purpose: "The example again.", input: {}, expect: "result" };
    expect(Either.isLeft(decodeCasesFile(JSON.stringify({ cases: [one, one] })))).toBe(true);
    const { expect: _expect, ...unexpecting } = one;
    expect(Either.isLeft(decodeCasesFile(JSON.stringify({ cases: [unexpecting] })))).toBe(true);
    const { purpose: _purpose, ...unexplained } = one;
    expect(Either.isLeft(decodeCasesFile(JSON.stringify({ cases: [unexplained] })))).toBe(true);
    expect(decodeCasesFile(undefined)).toEqual(Either.right({ cases: [] }));
  });

  it("keeps a case's noMatch mark, and refuses one that is not a boolean", () => {
    const zero = {
      id: "zero",
      purpose: "A month with no reviews.",
      input: { month: 2 },
      expect: "result",
      noMatch: true,
    };
    expect(decodeCasesFile(JSON.stringify({ cases: [zero] }))).toEqual(
      Either.right({ cases: [zero] }),
    );
    expect(
      Either.isLeft(decodeCasesFile(JSON.stringify({ cases: [{ ...zero, noMatch: "yes" }] }))),
    ).toBe(true);
  });

  it("keeps what the agent chose not to test, with why", () => {
    const notTested = [{ what: "A location the site cannot apply", reason: "No location control." }];
    expect(decodeCasesFile(JSON.stringify({ cases: [], notTested }))).toEqual(
      Either.right({ cases: [], notTested }),
    );
    expect(
      Either.isLeft(decodeCasesFile(JSON.stringify({ cases: [], notTested: [{ what: "Sort" }] }))),
    ).toBe(true);
  });
});

// A signed-in read runs live tests on a few distinct inputs. What counts as one input is pure and
// easy to get wrong: key order, nesting, repeats in one batch, and reruns of a counted input.
describe("the signed-in test input bound", () => {
  const combined = { query: "lamp", filters: { status: "open", tags: ["a", "b"] }, in_stock: true };
  const reordered = { in_stock: true, filters: { tags: ["a", "b"], status: "open" }, query: "lamp" };

  it("treats the same input written in another key order as one input, at every depth", () => {
    expect(testInputKey(reordered)).toBe(testInputKey(combined));
    expect(uncountedTestInputs([testInputKey(combined)], [reordered])).toEqual([]);
  });

  it("tells inputs apart by a value, a list's order or a missing key", () => {
    const keys = [
      combined,
      { ...combined, in_stock: false },
      { ...combined, filters: { status: "open", tags: ["b", "a"] } },
      { query: "lamp", filters: combined.filters },
    ].map(testInputKey);
    expect(new Set(keys).size).toBe(4);
  });

  it("counts an input named by several cases of one batch once", () => {
    expect(uncountedTestInputs([], [combined, reordered, { query: "desk" }])).toHaveLength(2);
    expect(signedInTestInputRefusal([], [combined, reordered, { query: "desk" }])).toBeUndefined();
  });

  it("allows up to the limit, then refuses only a new input", () => {
    const counted = [combined, { query: "desk" }, { query: "chair" }].map(testInputKey);
    expect(signedInTestInputRefusal(counted, [{ query: "lamp" }])).toBeUndefined();
    // Four counted: a rerun of any is free, a fifth input is refused.
    const full = [...counted, testInputKey({ query: "lamp" })];
    expect(signedInTestInputRefusal(full, [reordered, { query: "desk" }])).toBeUndefined();
    expect(signedInTestInputRefusal(full, [{ query: "sofa" }])).toBeDefined();
    // A batch that would add two inputs when one is left runs nothing.
    expect(signedInTestInputRefusal(counted, [{ query: "lamp" }, { query: "sofa" }])).toBeDefined();
    expect(
      signedInTestInputRefusal(
        [],
        [combined, { query: "desk" }, { query: "chair" }, { query: "lamp" }, { query: "sofa" }],
      ),
    ).toBeDefined();
  });
});

describe("liveTestsEvidence", () => {
  const failedThenDeleted = {
    id: "sort-price",
    caseDigest: "case",
    sourceDigest: "earlier",
    verdict: "fail" as const,
    got: "TimeoutError",
    frame: "src/tool.ts:12",
    durationMs: 1,
    input: { query: "lamp", sort: "price_low" },
    expect: "result" as const,
  };

  // Running out of time for live tests leaves gaps to the rationale, never a failure: a source fix
  // and a passing case of its input still clear it, so it keeps counting.
  it("keeps a deleted failure counting, with a source fix as its way out, when time ran out", () => {
    const { record, coverage } = liveTestsEvidence({
      file: { cases: [] },
      outOfTime: true,
      versions: [
        {
          version: "playwright",
          sourceDigest: "published",
          records: new Map([[failedThenDeleted.id, failedThenDeleted]]),
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
        },
      ],
    });
    expect(record).toMatchObject({ outOfTime: true });
    expect(record.retired).toEqual([
      expect.objectContaining({
        id: "sort-price",
        lastVerdict: "fail",
        clearedBy: expect.objectContaining({ ways: expect.arrayContaining(["excusedBy"]) }),
      }),
    ]);
    expect(record.retired[0]).not.toHaveProperty("outsideSchema");
    expect(coverage).toContain("1 of those failures still counts.");
  });

  // A count's zero case first expected empty and failed as a result; marked noMatch, it passes. Its
  // lead needs the site's zero, never a page listing results, which a count that matched nothing
  // cannot show.
  it("asks a noMatch lead for the site's no-results state, never its results", () => {
    const quiet = {
      id: "quiet-month",
      purpose: "A month the site lists no reviews for; its filtered list shows a total of 0.",
      input: { month: 2, year: 2024 },
      expect: "result" as const,
    };
    const failedEmpty = {
      id: quiet.id,
      caseDigest: caseDigest({ ...quiet, expect: "empty" }),
      sourceDigest: "published",
      verdict: "fail" as const,
      got: "a result",
      durationMs: 1,
      input: quiet.input,
      expect: "empty" as const,
    };
    const leadOf = (noMatch: boolean) => {
      const testCase = noMatch ? { ...quiet, noMatch: true } : quiet;
      const passing = {
        id: quiet.id,
        caseDigest: caseDigest(testCase),
        sourceDigest: "published",
        verdict: "pass" as const,
        got: "a result",
        durationMs: 1,
      };
      return liveTestsEvidence({
        file: { cases: [testCase] },
        versions: [
          {
            version: "playwright",
            sourceDigest: "published",
            records: new Map([[quiet.id, passing]]),
            replaced: [failedEmpty],
          },
        ],
      }).record.retired[0];
    };
    expect(leadOf(true)).toMatchObject({
      changedExpectationBy: quiet.id,
      clearedBy: { siteAnswer: "no_results" },
    });
    expect(leadOf(false)).toMatchObject({
      changedExpectationBy: quiet.id,
      clearedBy: { siteAnswer: "results" },
    });
  });

  // A host that read no input schema cannot mark a failure outsideSchema, so the record never
  // offers that way out.
  it("offers no schema bound as a way out when the host read no input schema", () => {
    const failed = {
      id: "deleted-case",
      caseDigest: "case",
      sourceDigest: "earlier",
      verdict: "fail" as const,
      got: "TimeoutError",
      durationMs: 1,
      input: { query: "lamp" },
      expect: "result" as const,
    };
    const { record } = liveTestsEvidence({
      file: { cases: [] },
      versions: [
        { version: "playwright", sourceDigest: "published", records: new Map([[failed.id, failed]]) },
      ],
    });
    expect(record.retired).toEqual([
      expect.objectContaining({
        id: "deleted-case",
        clearedBy: expect.objectContaining({ ways: ["changedExpectationBy", "excusedBy"] }),
      }),
    ]);
  });
});

describe("failingLiveTestCases", () => {
  const record = (statuses: Readonly<Record<string, Readonly<Record<string, string>>>>) => ({
    versions: [
      { version: "playwright" as const, entrypoint: "src/tool.mjs" },
      { version: "http" as const, entrypoint: "src/tool-http.mjs" },
    ],
    cases: Object.entries(statuses).map(([id, results]) => ({
      id,
      results: Object.fromEntries(
        Object.entries(results).map(([version, status]) => [version, { status }]),
      ),
    })),
  });

  it("names the published version's failing cases in the cases file's order, and nothing else", () => {
    const both = record({
      a: { playwright: "pass", http: "fail" },
      b: { playwright: "fail", http: "pass" },
      c: { playwright: "inconclusive", http: "fail" },
      d: { playwright: "stale", http: "fail" },
      e: { playwright: "not_run", http: "fail" },
      f: { playwright: "fail", http: "fail" },
    });
    expect(failingLiveTestCases(both, "playwright")).toEqual({
      version: "playwright",
      entrypoint: "src/tool.mjs",
      ids: ["b", "f"],
    });
    expect(failingLiveTestCases(both, "http")?.ids).toEqual(["a", "c", "d", "e", "f"]);
  });

  it("finds none when no counted case fails, the version is missing or the record is bare", () => {
    expect(failingLiveTestCases(record({ a: { playwright: "pass" } }), "playwright")).toBeUndefined();
    expect(
      failingLiveTestCases(
        { versions: [{ version: "playwright" }], cases: [{ id: "a", results: { http: { status: "fail" } } }] },
        "http",
      ),
    ).toBeUndefined();
    expect(failingLiveTestCases(liveTestsEvidenceProblem("unreadable").record, "playwright")).toBeUndefined();
  });

  it("names up to ten cases and counts the rest", () => {
    const ids = Array.from({ length: 12 }, (_unused, index) => `case-${index + 1}`);
    const text = failingCasesRefusal({ version: "playwright", entrypoint: "src/tool.mjs", ids });
    expect(text).toContain(
      "live test cases case-1, case-2, case-3, case-4, case-5, case-6, case-7, case-8, case-9, case-10 and 2 more on src/tool.mjs fail on this source,",
    );
    expect(failingCasesRefusal({ version: "playwright", ids: ["a", "b", "c"] })).toContain(
      "live test cases a, b and c fail on this source,",
    );
  });
});
