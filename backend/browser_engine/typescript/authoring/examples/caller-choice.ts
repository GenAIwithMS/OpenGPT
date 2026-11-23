import { Schema } from "effect";
import { defineOperation, timeoutDefaults, waitCode } from "../../src/browser/index.js";

const PageOption = Schema.Struct({ value: Schema.NonEmptyTrimmedString, label: Schema.NonEmptyTrimmedString });
const Offer = Schema.Union(
  Schema.Struct({
    seats: Schema.Array(PageOption),
    travelers: Schema.Array(Schema.Struct({ ...PageOption.fields, maskedLabel: Schema.String })),
  }),
  Schema.Struct({ failure: Schema.Literal("unexpected_page") }),
);
const Booked = Schema.Union(
  Schema.Struct({ reference: Schema.NonEmptyTrimmedString }),
  Schema.Struct({ failure: Schema.Literal("choice_gone", "not_confirmed") }),
);

// Observed contract: choosing a flight renders that flight's open seats and the account's saved
// travelers; "Book" submits the checked choices and shows a confirmation with its reference. The
// seats depend on the flight the caller chose, so they cannot be a published input: the script
// asks for them once the page offers them. Adapt from site evidence.
export default defineOperation(
  {
    name: "book_flight_seat",
    input: Schema.Struct({
      flight: Schema.NonEmptyString.pipe(Schema.pattern(/\S/u)).annotations({
        description: "Flight to book, as its Choose button names it",
      }),
    }),
    output: Schema.Struct({
      reference: Schema.NonEmptyTrimmedString.annotations({
        description: "Booking reference from the site's confirmation",
      }),
      seat: Schema.NonEmptyTrimmedString.annotations({ description: "Seat the caller chose" }),
    }),
    // Every question a run may ask, with its type and reviewed prompt. A choice's options come
    // from the page when the run asks.
    questions: {
      seat: { type: "choice", prompt: "Which seat on the selected flight?" },
      traveler: { type: "choice", prompt: "Which of your saved travelers is flying?" },
    },
    // The booking reference the site shows for this click, read back, confirms the write.
    write: { confirmation: "readback", commits: ["book-seat"] },
  },
  async ({
    kernel,
    sessionId,
    siteOrigin,
    siteDomain,
    input,
    ask,
    verified,
    enteringCommit,
    errors,
  }) => {
    if (siteOrigin === undefined)
      throw new errors.OperationFailure("No site origin for a live run", { dispatch: "not_sent" });
    // The options exist only once the flight is chosen. A value is what the script acts on; a
    // label is what the caller reads. Taken seats are left out, since the page refuses them.
    const read = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 60,
      code: `
        const flight = ${JSON.stringify(input.flight.trim())};
        // On the site: any https host on the host's site domain, else the site origin alone.
        const siteDomain = ${JSON.stringify(siteDomain ?? null)};
        const onSite = (url) => siteDomain === null ? url.origin === ${JSON.stringify(siteOrigin)}
          : url.protocol === "https:" && (url.hostname === siteDomain || url.hostname.endsWith("." + siteDomain));
        const current = new URL(page.url());
        if (!onSite(current)) return { failure: "unexpected_page" };
        await page.getByRole("button", { name: "Choose " + flight, exact: true }).click({ timeout: ${timeoutDefaults.action} });
        const seatMap = page.getByRole("radiogroup", { name: "Seats", exact: true });
        // The seat map names its flight once that flight's seats are shown.
        await seatMap
          .and(page.locator("[data-flight=" + JSON.stringify(flight) + "]"))
          .waitFor({ state: "attached", timeout: 10000 });
        const seats = await seatMap.getByRole("radio").evaluateAll((inputs) =>
          inputs.flatMap((input) =>
            input.disabled ? [] : [{ value: input.value, label: input.labels[0]?.textContent.trim() || input.value }],
          ),
        );
        const travelers = await page.getByLabel("Traveler", { exact: true }).locator("option").evaluateAll((options) =>
          options.flatMap((option) =>
            option.value
              ? [{ value: option.value, label: option.textContent.trim(), maskedLabel: option.dataset.masked || "Saved traveler" }]
              : [],
          ),
        );
        return { seats, travelers };
      `,
    });
    if (!read.success)
      throw new errors.OperationFailure(String(read.error), { stderr: read.stderr });
    const offer = Schema.decodeUnknownSync(Offer)(read.result);
    if ("failure" in offer)
      throw new errors.OperationFailure(offer.failure, { dispatch: "not_sent" });
    if (offer.seats.length === 0 || offer.travelers.length === 0)
      throw new errors.OperationFailure("The flight offers no seat or traveler");
    // A saved traveler is the caller's own account detail, so it is account-specific and carries
    // a masked label for the API and MCP. The run waits here with this page open until the caller
    // answers, then continues in place. No answer in time fails the run as no_response.
    const answer = await ask({
      seat: { options: offer.seats },
      traveler: {
        options: offer.travelers.map((traveler) => ({ ...traveler, accountSpecific: true })),
      },
    });
    // The booking call can send the booking, so its commit step is marked first.
    enteringCommit("book-seat");
    const booked = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 60,
      code: `
        ${waitCode}
        const chosenSeat = ${JSON.stringify(answer.seat)};
        const chosenTraveler = ${JSON.stringify(answer.traveler)};
        const seatMap = page.getByRole("radiogroup", { name: "Seats", exact: true });
        // The wait can be long, so confirm the page still offers the chosen seat first.
        const seat = seatMap.locator("input[value=" + JSON.stringify(chosenSeat) + "]");
        if ((await seat.count()) !== 1 || (await seat.isDisabled())) return { failure: "choice_gone" };
        await seat.check({ timeout: ${timeoutDefaults.action} });
        await page.getByLabel("Traveler", { exact: true }).selectOption(chosenTraveler, { timeout: ${timeoutDefaults.action} });
        // The booking is sent once; a page that shows no confirmation is reported unconfirmed.
        const book = page.getByRole("button", { name: "Book", exact: true });
        const confirmation = page.getByRole("status", { name: "Booking confirmation", exact: true });
        const shown = await waitForOutcome({ confirmation }, { action: () => book.click({ timeout: waitLimits.action }) }).then(
          () => true,
          (error) => {
            if (error.name !== "OutcomeWaitFailure") throw error;
            return false;
          },
        );
        if (!shown) return { failure: "not_confirmed" };
        return { reference: await confirmation.getAttribute("data-reference") };
      `,
    });
    // A failure after the click leaves the booking uncertain. Never book again here.
    if (!booked.success)
      throw new errors.OperationFailure(String(booked.error), { stderr: booked.stderr });
    const result = Schema.decodeUnknownSync(Booked)(booked.result);
    if ("failure" in result)
      throw new errors.OperationFailure(result.failure, {
        dispatch: result.failure === "choice_gone" ? "not_sent" : "sent",
      });
    // The confirmation with its reference, read after this click, shows the booking landed.
    verified();
    return { reference: result.reference, seat: answer.seat };
  },
);
