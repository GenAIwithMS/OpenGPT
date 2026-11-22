import { Effect } from "effect";
import { expect, it } from "vitest";
import { runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import { runOutcomeFailure } from "../../src/standalone/run-report.js";

// A script that could not apply a value its caller supplied in the local operation child, against
// a browser that answers every call with nothing: what its run outcome tells the caller.

const entrypoint = "operation/src/tool.mjs";
/** A synthetic list read whose page reset the caller's sort to its own default. */
const resetSort = `import { Schema } from "effect";
import { defineOperation } from "../../runtime/index.js";
export default defineOperation({ input: Schema.Struct({ sort: Schema.Literal("price_low", "rating") }), output: Schema.Struct({ items: Schema.Array(Schema.String) }) },
  async ({ input, errors }) => {
    throw new errors.InputNotApplied("The page reset the sort to its own default", { field: "sort", requested: input.sort, applied: "featured", step: "apply_sort" });
  });`;
/** A synthetic store-scoped read, on the deprecated name, whose page kept another store. */
const unappliedLocation = (detail: string) => `import { Schema } from "effect";
import { defineOperation } from "../../runtime/index.js";
export default defineOperation({ input: Schema.Struct({ zip: Schema.String }), output: Schema.Struct({ store: Schema.String }) },
  async ({ input, errors }) => {
    throw new errors.LocationNotApplied("The page kept its own store after ZIP " + input.zip, ${detail});
  });`;
const browser = {
  sessionId: "local",
  executeResponse: () => Effect.succeed({ success: true, result: null }),
};
/** A synthetic pickup write that reads the page's store first, then finds it kept another. */
const unappliedWrite = `import { Schema } from "effect";
import { defineOperation } from "../../runtime/index.js";
export default defineOperation({ input: Schema.Struct({ zip: Schema.String }), output: Schema.Struct({ store: Schema.String }), write: { confirmation: "readback" } },
  async ({ input, errors, kernel, sessionId }) => {
    await kernel.browsers.playwright.execute(sessionId, { code: "return null" });
    throw new errors.InputNotApplied("The page kept its own store after ZIP " + input.zip, { field: "zip", requested: input.zip, applied: "Example Store, 00002", step: "store_save" });
  });`;
const outcomeOf = (source: string, input: Record<string, unknown>, write = false) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* createLocalWorkspace();
        return yield* runLocalOperation({
          workspace,
          entrypoint,
          sources: [[entrypoint, source]],
          input,
          browser,
        }).pipe(
          Effect.flip,
          Effect.map(runOutcomeFailure(write ? "write" : "read", "operation")),
        );
      }),
    ),
  );
const locationOutcome = (detail: string) => outcomeOf(unappliedLocation(detail), { zip: "00001" });

it("fails loudly with the requested and kept value when the page reset a sort", async () => {
  const failure = await outcomeOf(resetSort, { sort: "price_low" });
  expect(failure.outcome).toMatchObject({
    code: "input_not_applied",
    retry: "same_key",
    possibleCommit: false,
    details: {
      reason: "The page reset the sort to its own default",
      field: "sort",
      requested: "price_low",
      applied: "featured",
      step: "apply_sort",
    },
  });
  expect(failure.message).toContain("price_low");
  expect(failure.message).toContain("featured");
});

it("ends a published tool's deprecated LocationNotApplied the same way", async () => {
  const failure = await locationOutcome(
    `{ field: "zip", requested: input.zip, applied: "Example Store, 00002", step: "store_save", siteMessage: "Something went wrong. Try again." }`,
  );
  expect(failure.outcome).toMatchObject({
    code: "input_not_applied",
    retry: "same_key",
    possibleCommit: false,
    details: {
      field: "zip",
      requested: "00001",
      applied: "Example Store, 00002",
      step: "store_save",
      site_message: "Something went wrong. Try again.",
    },
  });
  expect(failure.message).toContain("00001");
  expect(failure.message).toContain("Example Store, 00002");
});

it("reports a value the page showed none for without an applied value", async () => {
  const failure = await locationOutcome(`{ field: "zip", requested: input.zip, step: "zip_entry" }`);
  expect(failure.outcome.code).toBe("input_not_applied");
  expect(failure.outcome.details).toEqual({
    possible_commit: false,
    reason: "The page kept its own store after ZIP 00001",
    field: "zip",
    requested: "00001",
    step: "zip_entry",
  });
});

it("keeps a write whose browser step may have changed the site from a same-request retry", async () => {
  const failure = await outcomeOf(unappliedWrite, { zip: "00001" }, true);
  expect(failure.outcome).toMatchObject({ code: "outcome_unknown", retry: "never" });
});

it("keeps a numeric value the script passed as its text", async () => {
  const failure = await locationOutcome(`{ field: "zip", requested: 1, applied: 2, step: "store_save" }`);
  expect(failure.outcome.details).toMatchObject({ requested: "1", applied: "2" });
});
