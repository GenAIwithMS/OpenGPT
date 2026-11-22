import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import { returnedRun, type RunOutcomeFailure } from "../../src/standalone/run-report.js";

// A synthetic checkout script that reads the order total from the page and refuses a total over
// the caller's limit, run in the local operation child against a browser whose page shows a total
// of 120. What its caller is told depends on where it refuses and whether its schema declares it.

const entrypoint = "operation/src/tool.mjs";
const declaredRefusal = `Schema.Struct({ status: Schema.Literal("refused"), reason: Schema.Literal("over_price_limit"), total: Schema.Number, limit: Schema.Number })`;
const undeclaredRefusal = `Schema.Struct({ status: Schema.Literal("refused"), reason: Schema.String, total: Schema.Number, limit: Schema.Number })`;
const checkout = (refusal: string, refuse: "before_commit" | "after_commit") => `import { Schema } from "effect";
import { defineOperation } from "../../runtime/index.js";
const Placed = Schema.Struct({ status: Schema.Literal("placed"), orderNumber: Schema.String });
export default defineOperation(
  {
    input: Schema.Struct({ maxTotal: Schema.Number }),
    output: Schema.Union(Placed, ${refusal}),
    write: { confirmation: "readback", commits: ["place-order"] },
  },
  async ({ kernel, sessionId, input, enteringCommit, verified }) => {
    const review = await kernel.browsers.playwright.execute(sessionId, { code: "return readTotal();" });
    const total = review.result.total;
    ${refuse === "after_commit" ? 'enteringCommit("place-order");' : ""}
    if (total > input.maxTotal)
      return { status: "refused", reason: "over_price_limit", total, limit: input.maxTotal };
    ${refuse === "before_commit" ? 'enteringCommit("place-order");' : ""}
    await kernel.browsers.playwright.execute(sessionId, { code: "return placeOrder();" });
    verified();
    return { status: "placed", orderNumber: "A-1" };
  },
);`;
const browser = {
  sessionId: "local",
  executeResponse: () => Effect.succeed({ success: true, result: { total: 120 } }),
};
const run = (source: string, maxTotal: number) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* createLocalWorkspace();
        const result = yield* runLocalOperation({
          workspace,
          entrypoint,
          sources: [[entrypoint, source]],
          input: { maxTotal },
          browser,
        });
        return yield* Effect.either(returnedRun("write", result));
      }),
    ),
  );
const failureOf = (settled: Either.Either<unknown, RunOutcomeFailure>) => {
  if (Either.isRight(settled)) throw new Error("Expected a failed run");
  return settled.left;
};

// Each case starts a local operation child, which takes seconds on a loaded host.
describe("a write that refuses in its output", { timeout: 30_000 }, () => {
  it("returns a declared refusal made before any commit step as its result", async () => {
    expect(await run(checkout(declaredRefusal, "before_commit"), 100)).toEqual(
      Either.right({ status: "refused", reason: "over_price_limit", total: 120, limit: 100 }),
    );
  });

  it("still places the order when the total is within the limit", async () => {
    expect(await run(checkout(declaredRefusal, "before_commit"), 150)).toEqual(
      Either.right({ status: "placed", orderNumber: "A-1" }),
    );
  });

  it("reports a declared refusal made after a commit step was entered as possibly applied", async () => {
    const failure = failureOf(await run(checkout(declaredRefusal, "after_commit"), 100));
    expect(failure.outcome).toMatchObject({
      code: "outcome_unknown",
      writeStatus: "may_have_applied",
      possibleCommit: true,
    });
    expect(failure.unconfirmed).toEqual({
      output: { status: "refused", reason: "over_price_limit", total: 120, limit: 100 },
    });
  });

  it("does not take a refusal shape the output schema does not declare as a refusal", async () => {
    const failure = failureOf(await run(checkout(undeclaredRefusal, "before_commit"), 100));
    expect(failure.outcome).toMatchObject({
      code: "outcome_unknown",
      writeStatus: "may_have_applied",
      possibleCommit: true,
    });
  });
});
