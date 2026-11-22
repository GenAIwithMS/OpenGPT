import { Schema } from "effect";
import { defineOperation, formControlsCode } from "../../src/browser/index.js";

const Status = Schema.Literal("open", "paid");

// A native select: the SDK's `chooseOption` picks the one option whose label or canonical value
// is the input, and reads back that the select took it. Labels and the operating-system popup are
// not selectors. The host authorizes this selection, including any site autosave behavior.
export default defineOperation(
  {
    name: "select_invoice_status",
    input: Schema.Struct({
      status: Status.annotations({ description: "Invoice status to select" }),
    }),
    output: Schema.Struct({
      status: Status.annotations({ description: "Invoice status the select now holds" }),
    }),
  },
  async ({ kernel, sessionId, input, errors }) => {
    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 30,
      code: `
        ${formControlsCode}
        const select = page.getByLabel("Invoice status", { exact: true });
        return (await chooseOption(select, ${JSON.stringify(input.status)})).value;
      `,
    });
    if (!answer.success)
      throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
    if (answer.result !== input.status)
      throw new errors.OperationFailure("The selected status did not read back", {
        dispatch: "sent",
      });
    return { status: input.status };
  },
);
