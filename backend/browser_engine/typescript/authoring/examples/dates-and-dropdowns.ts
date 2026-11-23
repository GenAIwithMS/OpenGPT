import { Schema } from "effect";
import { CalendarDate, defineOperation, formControlsCode } from "../../src/browser/index.js";

const Cabin = Schema.Literal("economy", "business");
/** Each cabin's observed labels: the option is found by what it says, never by its position. */
const cabinLabels = { economy: ["Economy"], business: ["Business", "Business class"] } as const;
const failures = [
  "date_invalid",
  "format_mismatch",
  "control_unsupported",
  "listbox_missing",
  "option_missing",
  "option_ambiguous",
  "option_disabled",
  "not_committed",
] as const;

// An observed search form: the date is a month, day and year dropdown (months by name, days
// unpadded), and the cabin a custom dropdown. The SDK's `formControlsCode` fills a date into any
// date control and chooses an option in a native select or an ARIA dropdown, reading each back.
export default defineOperation(
  {
    name: "set_departure",
    input: Schema.Struct({
      date: CalendarDate.annotations({
        description: "Departure date, YYYY-MM-DD",
        examples: ["2026-11-14"],
      }),
      cabin: Cabin.annotations({ description: "Cabin class to search", examples: ["economy"] }),
    }),
    output: Schema.Struct({
      date: CalendarDate.annotations({
        description: "Departure date the form now holds, YYYY-MM-DD",
      }),
      cabin: Cabin.annotations({ description: "Cabin class the form now holds" }),
    }),
  },
  async ({ kernel, sessionId, input, errors }) => {
    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 60,
      code: `
        ${formControlsCode}
        const date = ${JSON.stringify(input.date)};
        const form = page.getByRole("search", { name: "Find departures", exact: true });
        try {
          // A split date names the one part each control takes.
          await fillDate(form.getByLabel("Month", { exact: true }), date, "MMMM");
          await fillDate(form.getByLabel("Day", { exact: true }), date, "D");
          await fillDate(form.getByLabel("Year", { exact: true }), date, "YYYY");
          await chooseOption(
            form.getByRole("combobox", { name: "Cabin", exact: true }),
            ${JSON.stringify(cabinLabels[input.cabin])},
          );
        } catch (error) {
          if (error.name === "FormControlFailure") return { failure: error.message };
          throw error;
        }
        return { set: true };
      `,
    });
    if (!answer.success)
      throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
    const result = Schema.decodeUnknownSync(
      Schema.Union(
        Schema.Struct({ set: Schema.Literal(true) }),
        Schema.Struct({ failure: Schema.Literal(...failures) }),
      ),
    )(answer.result);
    if ("failure" in result)
      throw new errors.OperationFailure(result.failure, {
        dispatch: result.failure === "not_committed" ? "sent" : "not_sent",
      });
    return input;
  },
);
