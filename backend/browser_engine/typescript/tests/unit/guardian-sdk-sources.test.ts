import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ReviewFailure, refusalsOnHostGapsFail } from "../../src/guardian/review.js";
import type { PendingExecution, Reviewer, ReviewTurn } from "../../src/guardian/review.js";
import {
  hostProvidedSource,
  hostReference,
  operationReviewSources,
  sdkJavaScriptPath,
  sdkReference,
} from "../../src/guardian/source.js";
import { failureDetail } from "../../src/runtime/failure-detail.js";

/** A host's SDK: its own folder, the public package and the package's runtime modules. */
const sdkFiles = new Map([
  ["runtime/index.js", 'export * from "opengpt-browser-engine/runtime";\n'],
  ["node_modules/opengpt-browser-engine/package.json", '{"exports":{"./runtime":"./dist/browser/index.js"}}'],
  ["node_modules/opengpt-browser-engine/dist/browser/index.js", 'export * from "./form-controls.js";\n'],
  ["node_modules/opengpt-browser-engine/dist/browser/form-controls.js", "export const formControlsCode = 1;\n"],
  ["opengpt-browser-engine/browser/index.js", 'export * from "../runtime/operation.js";\n'],
  ["opengpt-browser-engine/runtime/operation.js", "export const defineOperation = (value) => value;\n"],
]);

describe("operationReviewSources", () => {
  it("serves the SDK at its own path and under operation/, where an operation file of its own wins", () => {
    const sources = operationReviewSources(
      sdkFiles,
      new Map([
        ["src/tool.mjs", 'import "../../runtime/index.js";\n'],
        ["runtime/index.js", "export const authored = 1;\n"],
      ]),
    );
    expect(sources.get("runtime/index.js")).toBe(sdkFiles.get("runtime/index.js"));
    expect(sources.get("operation/runtime/index.js")).toBe("export const authored = 1;\n");
    expect(sources.get("operation/opengpt-browser-engine/runtime/operation.js")).toBe(
      sdkFiles.get("opengpt-browser-engine/runtime/operation.js"),
    );
    expect(sources.get("operation/src/tool.mjs")).toBe('import "../../runtime/index.js";\n');
  });

  it("reads a bare opengpt-browser-engine/runtime as the module it loads, only when the SDK holds that module", () => {
    const entry = sdkFiles.get("opengpt-browser-engine/browser/index.js");
    const sources = operationReviewSources(sdkFiles, new Map());
    expect([sources.get("opengpt-browser-engine/runtime"), sources.get("operation/opengpt-browser-engine/runtime")]).toEqual([
      entry,
      entry,
    ]);
    const builtOnly = operationReviewSources(
      new Map([["runtime/index.js", "export {};\n"]]),
      new Map(),
    );
    expect(builtOnly.has("opengpt-browser-engine/runtime")).toBe(false);
  });
});

describe("hostProvidedSource", () => {
  it("names the files the host ships, at their own path or under operation/, and nothing else", () => {
    const provided = hostProvidedSource(sdkFiles);
    expect(
      [
        "runtime/index.js",
        "operation/runtime/index.js",
        "node_modules/opengpt-browser-engine/dist/browser/form-controls.js",
        "opengpt-browser-engine/runtime",
        "operation/opengpt-browser-engine/runtime",
      ].map(provided),
    ).toEqual([true, true, true, true, true]);
    // An SDK folder, a guessed SDK path and an authored file are the agent's or Guardian's.
    expect(
      ["runtime/", "runtime/form-controls.js", "operation/src/tool.mjs"].map(provided),
    ).toEqual([false, false, false]);
    expect(hostProvidedSource(new Map([["runtime/index.js", ""]]))("opengpt-browser-engine/runtime")).toBe(
      false,
    );
  });
});

describe("sdkJavaScriptPath", () => {
  it("reads an SDK module spelled as TypeScript as the JavaScript that runs, and leaves authored TypeScript alone", () => {
    expect(
      [
        "opengpt-browser-engine/runtime/operation.ts",
        "opengpt-browser-engine/runtime/operation.d.ts",
        "runtime/operation.ts",
        "operation/opengpt-browser-engine/runtime/operation.d.ts",
        "node_modules/opengpt-browser-engine/dist/browser/index.d.ts",
      ].map(sdkJavaScriptPath),
    ).toEqual([
      "opengpt-browser-engine/runtime/operation.js",
      "opengpt-browser-engine/runtime/operation.js",
      "runtime/operation.js",
      "operation/opengpt-browser-engine/runtime/operation.js",
      "node_modules/opengpt-browser-engine/dist/browser/index.js",
    ]);
    expect(
      ["operation/src/tool.ts", "src/types.d.ts", "opengpt-browser-engine/runtime/operation.js"].map(
        sdkJavaScriptPath,
      ),
    ).toEqual([undefined, undefined, undefined]);
  });
});

describe("sdkReference", () => {
  const reference = sdkReference({
    files: sdkFiles,
    runtimeEntry: "node_modules/opengpt-browser-engine/dist/browser/index.js",
  });

  it("points a guessed SDK path at the runtime entry and the one module with its file name", () => {
    for (const guess of ["runtime/form-controls.js", "operation/runtime/form-controls.ts"])
      expect(reference(guess), guess).toEqual({
        kind: "host_sdk_reference",
        state: "not_an_sdk_file",
        runtimeEntry: "node_modules/opengpt-browser-engine/dist/browser/index.js",
        resolvedFrom: "opengpt-browser-engine/runtime",
        sameFileName: "node_modules/opengpt-browser-engine/dist/browser/form-controls.js",
      });
    // Several SDK modules are named `index.js`, so only the runtime entry answers.
    expect(reference("node_modules/opengpt-browser-engine/dist/typescript/src/runtime/index.js")).toEqual({
      kind: "host_sdk_reference",
      state: "not_an_sdk_file",
      runtimeEntry: "node_modules/opengpt-browser-engine/dist/browser/index.js",
      resolvedFrom: "opengpt-browser-engine/runtime",
    });
    expect(sdkReference({ files: sdkFiles, runtimeEntry: undefined })("opengpt-browser-engine/x.js")).toEqual({
      kind: "host_sdk_reference",
      state: "not_an_sdk_file",
    });
  });

  it("has no pointer for an SDK file or a path outside the SDK's folders", () => {
    for (const path of [
      "runtime/index.js",
      "opengpt-browser-engine/runtime/operation.ts",
      "operation/src/missing.mjs",
      "executed/runtime/index.js",
    ])
      expect(reference(path), path).toBeUndefined();
  });

  it("answers in place of the file as one chunk with nothing more to read", () => {
    expect(JSON.parse(hostReference("runtime/form-controls.js", { kind: "k" }))).toEqual({
      kind: "untrusted_source",
      path: "runtime/form-controls.js",
      byteOffset: 0,
      nextOffset: 0,
      hasMore: false,
      source: '{"kind":"k"}',
    });
  });
});

describe("refusalsOnHostGapsFail", () => {
  const pending: PendingExecution = {
    invocationId: "invocation_a",
    attemptId: "attempt_a",
    entrypoint: "operation/src/tool.mjs",
    screenedIntent: "Read the public page title",
    screenedInput: "{}",
    screenedObservations: "",
    accountScope: "account_a",
    allowedOrigins: ["https://example.test"],
    allowedEffects: ["read"],
  };
  const unavailable = (pathCategory: string) =>
    new ReviewFailure({
      code: "SourceUnavailable",
      failureDetail: failureDetail("guardian_dependency_failed", {
        operation: "guardian.source.read",
        error: new Error("closed"),
        context: { pathCategory, offset: 0 },
      }),
    });
  /** A reviewer that reads `path` once, whatever the read gives, then decides `outcome`. */
  const reviewer = (path: string, outcome: string): Reviewer => ({
    run: (turn) =>
      turn.readSource(path, 0).pipe(
        Effect.either,
        Effect.as({ outcome, rationale: "The SDK it imports is unavailable." }),
      ),
  });
  const review = (inner: Reviewer, failure: ReviewFailure) => {
    const turn: ReviewTurn = {
      reviewId: "review_a",
      pending,
      readSource: (path) =>
        path === "operation/src/tool.mjs"
          ? Effect.succeed(JSON.stringify({ kind: "untrusted_source", path, source: "" }))
          : Effect.fail(failure),
    };
    return Effect.runPromise(Effect.either(refusalsOnHostGapsFail(inner).run(turn)));
  };

  it("fails a deny or escalate after a failed read of a host file with that read's failure", async () => {
    const gap = unavailable("host_sdk");
    for (const outcome of ["deny", "escalate"]) {
      const reviewed = await review(reviewer("operation/runtime/index.js", outcome), gap);
      expect(reviewed._tag === "Left" && reviewed.left, outcome).toBe(gap);
    }
  });

  it("keeps an allow after a host gap, and a refusal after an authored file's failure", async () => {
    expect(
      await review(reviewer("operation/runtime/index.js", "allow"), unavailable("host_sdk")),
    ).toMatchObject({ _tag: "Right", right: { outcome: "allow" } });
    expect(
      await review(reviewer("operation/src/missing.mjs", "deny"), unavailable("workspace")),
    ).toMatchObject({ _tag: "Right", right: { outcome: "deny" } });
  });
});
