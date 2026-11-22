import { Schema } from "effect";
import { PickOutcome, defineOperation, pickRefusal, pickerCode } from "../../src/browser/index.js";

// An observed search form whose From field is a typeahead that suggests stations as you type.
// Several stations can share a name, such as two towns called Springfield. This tool takes the
// first of the equal matches in the site's order (`tie: "first"`) instead of letting the caller
// choose, and returns the one it used, as the site labels it, so the caller sees which one it
// searched from. A name the site does not suggest is the caller's to fix: `pickRefusal` turns it
// into `InvalidInput` with the names the site offered. The label is this site's evidence, not a
// selector for other sites.
export default defineOperation(
  {
    name: "set_search_origin",
    input: Schema.Struct({
      origin: Schema.NonEmptyTrimmedString.annotations({
        description:
          "Station to depart from, as the site lists it. A name several stations share uses the first the site suggests, which the output names",
        examples: ["Fernhill"],
      }),
    }),
    output: Schema.Struct({
      origin: Schema.String.annotations({
        description: "Station the search departs from, as the site labels it",
      }),
    }),
  },
  async ({ kernel, sessionId, input, errors }) => {
    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 60,
      code: `
        ${pickerCode}
        return await pickValue(page.getByRole("combobox", { name: "From", exact: true }), ${JSON.stringify(input.origin)}, { tie: "first" });
      `,
    });
    if (!answer.success) throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
    const outcome = Schema.decodeUnknownSync(PickOutcome)(answer.result);
    if (!outcome.picked) throw pickRefusal(outcome, "origin");
    return { origin: outcome.label };
  },
);
