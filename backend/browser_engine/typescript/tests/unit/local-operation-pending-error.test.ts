import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { LocalOperationFailure, runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import { runOutcomeFailure } from "../../src/standalone/run-report.js";

// A write's script that fails while a browser call it made is still out. The call may yet reach
// the page, so the child's error is not its own report of what the write did, as a result sent
// with a request still out is not.

const entrypoint = "src/tool.mjs";
const failingWhileOut = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation(
  {
    input: Schema.Struct({}),
    output: Schema.Struct({ placed: Schema.Boolean }),
    write: { confirmation: "message", commits: ["pay"] },
  },
  async ({ kernel, sessionId }) => {
    void kernel.browsers.playwright.execute(sessionId, { code: "return pay();" }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    throw new Error("The total was missing");
  },
);`;

// The child starts on a loaded host in seconds.
describe("a child's error while a host request is still out", { timeout: 30_000 }, () => {
  it("is no report of its own, so the write may have applied", async () => {
    const settled = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workspace = yield* createLocalWorkspace();
          return yield* Effect.either(
            runLocalOperation({
              workspace,
              entrypoint,
              sources: [[entrypoint, failingWhileOut]],
              input: {},
              // The browser call never returns while the script runs.
              browser: { sessionId: "session_1", executeResponse: () => Effect.never },
            }),
          );
        }),
      ),
    );
    if (Either.isRight(settled)) throw new Error("expected the run to fail");
    expect(settled.left).toBeInstanceOf(LocalOperationFailure);
    expect(settled.left).toMatchObject({ message: "The total was missing", reported: false });
    expect(runOutcomeFailure("write", "operation")(settled.left).outcome).toMatchObject({
      code: "outcome_unknown",
      writeStatus: "may_have_applied",
    });
  });
});
