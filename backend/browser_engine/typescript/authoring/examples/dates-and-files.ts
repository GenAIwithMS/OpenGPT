import { Schema } from "effect";
import {
  CalendarDate,
  defineOperation,
  FileInput,
  FileOutput,
  timeoutDefaults,
  waitCode,
} from "../../src/browser/index.js";

// An observed calendar popup: month panels carry data-month (YYYY-MM) and days carry the full
// data-date, so day text alone never identifies a cell. Other sites need their own evidence.
export const pickTravelDate = defineOperation(
  {
    name: "pick_travel_date",
    input: Schema.Struct({
      date: CalendarDate.annotations({ description: "Travel date to pick, YYYY-MM-DD" }),
    }),
    output: Schema.Struct({
      date: CalendarDate.annotations({
        description: "Travel date the field now holds, YYYY-MM-DD",
      }),
    }),
  },
  async ({ kernel, sessionId, input, errors }) => {
    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 60,
      code: `
        ${waitCode}
        const date = ${JSON.stringify(input.date)};
        const field = page.getByRole("textbox", { name: "Travel date", exact: true });
        // A popup that never opens fails once the page stops progressing.
        const popup = page.getByRole("dialog", { name: "Choose date", exact: true });
        await waitForOutcome({ popup }, { action: () => field.click({ timeout: waitLimits.action }) });
        // The months the popup shows, as its panels name them.
        const shownMonths = { months: { locator: popup.locator("[data-month]"), attribute: "data-month", all: true } };
        let months = await popup.locator("[data-month]").evaluateAll((panels) =>
          panels.map((panel) => panel.getAttribute("data-month")),
        );
        // Advance month by month, at most 24 times. After each click, wait for the shown months
        // to change from what they were; months that stay the same mean the click did nothing.
        for (let step = 0; !months.includes(date.slice(0, 7)); step++) {
          if (step === 24 || months.length === 0) return { failure: "month_unavailable" };
          const back = date.slice(0, 7) < months[0];
          const control = popup.getByRole("button", { name: back ? "Previous month" : "Next month", exact: true });
          const moved = await waitForChange(shownMonths, { before: { months }, action: () => control.click({ timeout: waitLimits.action }) });
          if (!moved.changed) return { failure: "month_unavailable" };
          months = moved.values.months;
        }
        const day = popup.locator("[data-month=" + JSON.stringify(date.slice(0, 7)) + "] [data-date=" + JSON.stringify(date) + "]");
        if ((await day.count()) !== 1) return { failure: "day_ambiguous" };
        if (!(await day.isEnabled()) || (await day.getAttribute("aria-disabled")) === "true")
          return { failure: "day_disabled" };
        await day.click({ timeout: waitLimits.action });
        // A field or URL alone does not prove the date; read the committed ISO value back.
        return (await field.inputValue()) === date ? { date } : { failure: "not_committed" };
      `,
    });
    if (!answer.success)
      throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
    const result = Schema.decodeUnknownSync(
      Schema.Union(
        Schema.Struct({ date: CalendarDate }),
        Schema.Struct({
          failure: Schema.Literal(
            "month_unavailable",
            "day_ambiguous",
            "day_disabled",
            "not_committed",
          ),
        }),
      ),
    )(answer.result);
    if ("failure" in result)
      throw new errors.OperationFailure(result.failure, {
        dispatch: result.failure === "not_committed" ? "sent" : "not_sent",
      });
    return result;
  },
);

// Choosing a file can start an upload at once, so this is a write the host must authorize.
// The bytes never enter the code: the input holds the caller's file reference, and files.place
// has the host put that file into the one file input its label names, as data, never code.
export default defineOperation(
  {
    name: "attach_document",
    input: Schema.Struct({
      document: FileInput.annotations({ description: "The document to attach" }),
    }),
    output: Schema.Struct({
      name: Schema.NonEmptyTrimmedString.annotations({ description: "Name of the file the field now holds" }),
      size: Schema.Number.annotations({ description: "Size of that file in bytes" }),
    }),
  },
  async ({ kernel, sessionId, input, files, errors }) => {
    const chosen = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 30,
      code: `return await page.getByLabel("Documents", { exact: true }).evaluate((node) => node.files.length);`,
    });
    if (!chosen.success)
      throw new errors.OperationFailure(String(chosen.error), { stderr: chosen.stderr });
    // Same name and size is not the same content, so never reuse an existing choice.
    if (chosen.result !== 0)
      throw new errors.OperationFailure("already_selected", { dispatch: "not_sent" });
    // Selection is not proof the site accepted the upload; this reads back only the choice.
    const placed = await files.place(input.document, { field: { label: "Documents" } });
    return { name: placed.name, size: placed.size };
  },
);

// A download returns as a file object: files.collect runs the call that starts it, and the host
// keeps the bytes and returns their name, type, size and sha256 for the output.
export const downloadStatement = defineOperation(
  {
    name: "download_statement",
    input: Schema.Struct({}),
    output: Schema.Struct({
      statement: FileOutput.annotations({ description: "The statement the site exported" }),
    }),
  },
  async ({ kernel, sessionId, files, errors }) => {
    const statement = await files.collect(async () => {
      const answer = await kernel.browsers.playwright.execute(sessionId, {
        timeout_sec: 30,
        code: `await page.getByRole("link", { name: "Download statement", exact: true }).click({ timeout: ${timeoutDefaults.action} });`,
      });
      if (!answer.success)
        throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
    });
    // download_url and expires_at appear only when the published tool runs; return the file as collected and never require them.
    return { statement };
  },
);
