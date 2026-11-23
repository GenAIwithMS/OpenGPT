import { Schema } from "effect";
import { defineOperation } from "../../src/browser/index.js";

const InvoiceId = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{1,100}$/));

// A native confirm dialog is a host decision between two calls. The first call keeps the
// dialog on globalThis and returns what it showed, without awaiting the click that raised it.
// The host decides, and the second call accepts or dismisses the same dialog.
export default defineOperation(
  {
    name: "delete_invoice",
    input: Schema.Struct({
      invoice_id: InvoiceId.annotations({ description: "ID of the invoice to delete" }),
    }),
    output: Schema.Struct({
      deleted: Schema.Boolean.annotations({
        description: "True when the invoice is gone from the list after the dialog",
      }),
    }),
  },
  async ({ kernel, sessionId, input, decideDialog, errors }) => {
    const raised = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 30,
      code: `
        const row = page.getByRole("row").filter({ has: page.getByText(${JSON.stringify(input.invoice_id)}, { exact: true }) });
        if ((await row.count()) !== 1) return { failure: "invoice_missing" };
        const shown = new Promise((resolve) => page.once("dialog", (dialog) => {
          globalThis.dialog = dialog;
          resolve({ type: dialog.type(), message: dialog.message(), url: page.url() });
        }));
        // This click and absence decision share one short window so no late click can
        // continue after the operation has reported no dialog.
        void row.getByRole("button", { name: "Delete", exact: true }).click({ timeout: 5000 }).catch(() => {});
        return await Promise.race([
          shown,
          new Promise((resolve) => setTimeout(() => resolve({ failure: "no_dialog" }), 5000)),
        ]);
      `,
    });
    if (!raised.success)
      throw new errors.OperationFailure(String(raised.error), { stderr: raised.stderr });
    const shown = Schema.decodeUnknownSync(
      Schema.Union(
        Schema.Struct({
          type: Schema.Literal("alert", "confirm", "prompt", "beforeunload"),
          message: Schema.String,
          url: Schema.String,
        }),
        Schema.Struct({ failure: Schema.Literal("invoice_missing", "no_dialog") }),
      ),
    )(raised.result);
    if ("failure" in shown)
      throw new errors.OperationFailure(shown.failure, {
        dispatch: shown.failure === "no_dialog" ? "sent" : "not_sent",
      });
    // The step name is the same on every run, so the host can match this dialog next time.
    const decision = await decideDialog({ step: "delete-invoice", ...shown });
    const answered = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 30,
      code: `
        ${
          decision.choice === "accept"
            ? `await globalThis.dialog.accept(${JSON.stringify(decision.promptText ?? "")});`
            : "await globalThis.dialog.dismiss();"
        }
        delete globalThis.dialog;
        const row = page.getByRole("row").filter({ has: page.getByText(${JSON.stringify(input.invoice_id)}, { exact: true }) });
        // Read the result back: the row is gone only if the site deleted it.
        await row.waitFor({ state: ${JSON.stringify(decision.choice === "accept" ? "detached" : "visible")}, timeout: 10000 });
        return { deleted: (await row.count()) === 0 };
      `,
    });
    if (!answered.success)
      throw new errors.OperationFailure(String(answered.error), {
        dispatch: "sent",
        stderr: answered.stderr,
      });
    return Schema.decodeUnknownSync(Schema.Struct({ deleted: Schema.Boolean }))(answered.result);
  },
);
