import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import { makeRunDialogDecider, watchingUnanswered } from "../../src/inputs/dialog.js";
import { noIncidents } from "../../src/runtime/incidents.js";
import {
  InputRequestFailure,
  type InputAsker,
  type InputRequest,
} from "../../src/runtime/input-request.js";
import { runOutcomeFailure } from "../../src/standalone/run-report.js";

// A write that declares one commit step and calls the browser once, then fails before entering
// it, after a question its caller never answered. The local host keeps no log of what the page
// sent, so it can't show the write changed nothing: the run fails as no_response, and may have
// applied, as the hosted runner reports it.

const entrypoint = "src/tool.mjs";
const operation = (contract: string, body: string) => `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation(${contract}, ${body});`;
const saving = `input: Schema.Struct({}), output: Schema.Struct({ saved: Schema.Boolean }), write: { confirmation: "message", commits: ["save"] }`;

const afterPopUp = operation(
  `{ ${saving} }`,
  `async ({ kernel, sessionId, decideDialog }) => {
    await kernel.browsers.playwright.execute(sessionId, { code: "return review();" });
    const decided = await decideDialog({ step: "review", type: "confirm", message: "Continue?", url: "https://shop.example.test/cart" });
    throw new Error("The save button was missing after the " + decided.choice);
  }`,
);
const ownQuestion = operation(
  `{ ${saving}, questions: { note: { type: "text", prompt: "Which note should I keep?" } } }`,
  `async ({ kernel, sessionId, ask }) => {
    await kernel.browsers.playwright.execute(sessionId, { code: "return review();" });
    await ask(["note"]);
    return { saved: true };
  }`,
);

const browser = {
  sessionId: "session_1",
  executeResponse: () => Effect.succeed({ success: true, result: {} }),
};

/** A run of `source` whose caller answers no question, wired as the local host runs a tool. */
const run = (source: string) => {
  const asked: InputRequest[] = [];
  const unansweredAsk: InputAsker = (request) =>
    Effect.sync(() => asked.push(request)).pipe(
      Effect.zipRight(Effect.fail(new InputRequestFailure({ code: "NoResponse" }))),
    );
  const dialogs = watchingUnanswered(unansweredAsk);
  return Effect.runPromise(
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
            keepDriftedOutput: true,
            ask: unansweredAsk,
            declaredQuestions: { note: { type: "text", prompt: "Which note should I keep?" } },
            decideDialog: makeRunDialogDecider({
              ask: dialogs.ask,
              project: (text) => text,
              readOnly: false,
              incidents: noIncidents,
            }),
          }).pipe(
            Effect.mapError((error) =>
              runOutcomeFailure("write", "operation", dialogs.unanswered())(error),
            ),
          ),
        );
      }),
    ),
  ).then((settled) => ({ settled, asked, unanswered: dialogs.unanswered() }));
};

// Each case starts a local operation child, which takes seconds on a loaded host.
describe("a write that fails after its caller left a question unanswered", { timeout: 30_000 }, () => {
  it("is no_response and may have applied when the question was a pop-up's", async () => {
    const { settled, asked, unanswered } = await run(afterPopUp);
    if (Either.isRight(settled)) throw new Error("expected the run to fail");
    expect(asked.map((request) => request.questions.map(({ id }) => id))).toEqual([["decision"]]);
    expect(unanswered).toBe(true);
    expect(settled.left.outcome).toMatchObject({
      code: "no_response",
      writeStatus: "may_have_applied",
      possibleCommit: true,
    });
    expect(settled.left.journal).toMatchObject({
      effect: "possible",
      commits: [{ name: "save", state: "not_sent" }],
    });
  });

  it("is no_response and may have applied when the script asked it", async () => {
    const { settled, unanswered } = await run(ownQuestion);
    if (Either.isRight(settled)) throw new Error("expected the run to fail");
    // The script's own question isn't a pop-up's: its failure says no_response on its own.
    expect(unanswered).toBe(false);
    expect(settled.left.outcome).toMatchObject({
      code: "no_response",
      writeStatus: "may_have_applied",
      possibleCommit: true,
    });
  });
});
