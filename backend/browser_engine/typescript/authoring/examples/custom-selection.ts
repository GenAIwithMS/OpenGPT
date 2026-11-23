import { Schema } from "effect";
import { defineOperation, waitCode } from "../../src/browser/index.js";

const AirportCode = Schema.String.pipe(Schema.pattern(/^[A-Z]{1,4}$/));

// An observed ARIA combobox that owns one listbox through aria-controls. The data-key,
// data-query and "Selected airport" status are this site's evidence, not general rules.
export default defineOperation(
  {
    name: "choose_airport",
    input: Schema.Struct({
      code: AirportCode.annotations({
        description: "Code of the airport to choose, one to four capital letters",
      }),
      query: Schema.NonEmptyString.pipe(Schema.pattern(/\S/u)).annotations({
        description: "Text to type into the airport search, such as a city name",
      }),
    }),
    output: Schema.Struct({
      code: AirportCode.annotations({ description: "Code of the airport the site now shows" }),
    }),
  },
  async ({ kernel, sessionId, input, errors }) => {
    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 60,
      code: `
        ${waitCode}
        const code = ${JSON.stringify(input.code)};
        const query = ${JSON.stringify(input.query.trim())};
        const combobox = page.getByRole("combobox", { name: "Airport", exact: true });
        await waitForOutcome({ combobox });
        // Search only inside the listbox this control owns, never the whole page.
        const popupId = await combobox.getAttribute("aria-controls", { timeout: waitLimits.action });
        if (!popupId) return { failure: "ownership_unknown" };
        const popup = page.locator("[id=" + JSON.stringify(popupId) + "]");
        if ((await combobox.getAttribute("aria-expanded")) !== "true")
          await combobox.click({ timeout: waitLimits.action });
        // Old options can stay visible, so wait until the listbox answers this query.
        await waitForOutcome(
          { answered: popup.and(page.locator("[data-query=" + JSON.stringify(query) + "]")) },
          { action: () => combobox.fill(query, { timeout: waitLimits.action }) },
        );
        const option = popup.locator("[role=option][data-key=" + JSON.stringify(code) + "]");
        if ((await option.count()) !== 1) return { failure: "option_missing" };
        if ((await option.getAttribute("aria-disabled")) === "true")
          return { failure: "option_disabled" };
        // The control's name can change after a choice, so read the committed code from the
        // site's status instead of the combobox. The click is the wait's action, so a status
        // that never changes is confirmed unchanged, never waited out.
        const selected = page.getByRole("status", { name: "Selected airport", exact: true });
        const { values } = await waitForChange(
          { code: selected },
          { action: () => option.click({ timeout: waitLimits.action }) },
        );
        return values.code === code ? { code } : { failure: "not_committed" };
      `,
    });
    if (!answer.success)
      throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
    const result = Schema.decodeUnknownSync(
      Schema.Union(
        Schema.Struct({ code: AirportCode }),
        Schema.Struct({
          failure: Schema.Literal(
            "ownership_unknown",
            "option_missing",
            "option_disabled",
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
