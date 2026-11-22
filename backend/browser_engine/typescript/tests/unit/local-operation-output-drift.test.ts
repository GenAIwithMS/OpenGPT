import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { LocalOperationFailure, runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import { returnedRun } from "../../src/standalone/run-report.js";

// A synthetic write whose output no longer matches its schema, run in the local operation child.
// A run that keeps drifted output gets it back as its result; any other run fails as before.

const entrypoint = "operation/src/tool.mjs";
const saving = (returned: string, steps: "confirmed" | "unsent") => `import { Schema } from "effect";
import { defineOperation } from "../../runtime/index.js";
export default defineOperation(
  {
    input: Schema.Struct({}),
    output: Schema.Struct({ saved: Schema.Boolean }),
    write: { confirmation: "readback", commits: ["save"] },
  },
  async ({ kernel, sessionId, enteringCommit, verified }) => {
    ${
      steps === "confirmed"
        ? 'enteringCommit("save"); await kernel.browsers.playwright.execute(sessionId, { code: "return save();" }); verified();'
        : 'await kernel.browsers.playwright.execute(sessionId, { code: "return review();" });'
    }
    return ${returned};
  },
);`;
const browser = {
  sessionId: "local",
  executeResponse: () => Effect.succeed({ success: true, result: {} }),
};
const run = (source: string, keepDriftedOutput: boolean) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* createLocalWorkspace();
        return yield* Effect.either(
          runLocalOperation({
            workspace,
            entrypoint,
            sources: [[entrypoint, source]],
            input: {},
            browser,
            ...(keepDriftedOutput ? { keepDriftedOutput: true } : {}),
          }),
        );
      }),
    ),
  );

// Each case starts a local operation child, which takes seconds on a loaded host.
describe("a write whose output failed its schema", { timeout: 30_000 }, () => {
  it("hands a run that keeps drifted output the output, flagged, with its journal", async () => {
    const result = await run(saving('{ saved: "yes" }', "confirmed"), true);
    if (Either.isLeft(result)) throw result.left;
    expect(result.right).toMatchObject({
      output: { saved: "yes" },
      outputDrift: true,
      effect: "verified",
      commits: [{ name: "save", state: "confirmed" }],
      write: { confirmation: "readback", commits: ["save"] },
    });
    expect(Effect.runSync(Effect.either(returnedRun("write", result.right)))).toEqual(
      Either.right({ saved: "yes" }),
    );
  });

  it("fails as invalid output for a run that does not keep it", async () => {
    const result = await run(saving('{ saved: "yes" }', "confirmed"), false);
    expect(Either.isLeft(result) && result.left).toBeInstanceOf(LocalOperationFailure);
    expect(Either.isLeft(result) && result.left).toMatchObject({ code: "InvalidOutput" });
  });

  it("fails as invalid output when the drifted output is not JSON", async () => {
    const result = await run(saving("{ saved: 1n }", "confirmed"), true);
    expect(Either.isLeft(result) && result.left).toMatchObject({ code: "InvalidOutput" });
  });

  it("reports a drifted write that entered none of its commits as not applied", async () => {
    const result = await run(saving('{ saved: "yes" }', "unsent"), true);
    if (Either.isLeft(result)) throw result.left;
    const settled = Effect.runSync(Effect.either(returnedRun("write", result.right)));
    expect(Either.isLeft(settled) && settled.left.outcome).toMatchObject({
      code: "invalid_output",
      writeStatus: "not_applied",
    });
  });
});
