import { Schema } from "effect";
import { PickOutcome, defineOperation, pickRefusal, pickerCode } from "../../src/browser/index.js";

// An observed task form whose owner field is a typeahead that suggests people as you type. The
// SDK's `pickValue` types the caller's name, waits for the suggestions to settle, picks the one
// that matches, and confirms the field kept it. A name the site does not suggest is the caller's
// to fix, and this tool lets the caller choose among people who share a name rather than taking
// the first and returning the one it used, as `picker-first.ts` does (each tool decides):
// `pickRefusal` turns either into `InvalidInput` with the names the site offered, or the ones
// that tie. The label is this site's evidence, not a selector for other sites.
export default defineOperation(
  {
    name: "assign_task_owner",
    input: Schema.Struct({
      owner: Schema.NonEmptyTrimmedString.annotations({
        description: "Name of the person to assign, as the site lists them",
        examples: ["Jordan Reyes"],
      }),
    }),
    output: Schema.Struct({
      owner: Schema.String.annotations({ description: "Owner the field now shows" }),
    }),
  },
  async ({ kernel, sessionId, input, errors }) => {
    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 60,
      code: `
        ${pickerCode}
        return await pickValue(page.getByRole("combobox", { name: "Owner", exact: true }), ${JSON.stringify(input.owner)});
      `,
    });
    if (!answer.success)
      throw new errors.OperationFailure(String(answer.error), {
        stderr: answer.stderr,
        dispatch: answer.error === "not_committed" ? "sent" : "not_sent",
      });
    const outcome = Schema.decodeUnknownSync(PickOutcome)(answer.result);
    if (!outcome.picked) throw pickRefusal(outcome, "owner");
    return { owner: outcome.label };
  },
);
