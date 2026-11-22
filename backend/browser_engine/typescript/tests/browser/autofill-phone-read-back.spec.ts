import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import { inspectAutofillStep, type AutofillStep } from "../../src/destinations/autofill-step.js";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import { hostKeyboard, hostPage } from "./autofill-host-page.js";

// A phone sign-in whose country picker the site preset to +1, with a mask that keeps ten digits
// after the picker's own calling code. A number with another calling code, typed under it, comes
// out shifted and cut: its own calling code takes the first digit's place and its last digit is
// lost. The host reads the field back before it clicks the submit and sends nothing then.
const site = "https://login.example.test";
const otherCountry = "+7 912 345-67-89";
const sameCountry = "+1 (415) 555-0134";

const phoneStep: AutofillStep = {
  fields: [{ selector: "input[name=phone]", slot: "phone", accepts: ["phone"] }],
  submit: 'button:text-is("Sign in")',
};

const screen = `<form action="/session" method="post">
<label>Country <select name="country"><option value="1" selected>+1</option><option value="7">+7</option></select></label>
<label>Phone <input name="phone" type="tel" autocomplete="tel"></label>
<button>Sign in</button>
</form>
<script>
const country = document.querySelector("select[name=country]");
const phone = document.querySelector("input[name=phone]");
phone.addEventListener("input", () => {
  const typed = phone.value.trim();
  let digits = typed.replace(/[^0-9]/g, "");
  if (typed.startsWith("+" + country.value)) digits = digits.slice(country.value.length);
  digits = digits.slice(0, 10);
  phone.value = digits.length < 7
    ? digits
    : "(" + digits.slice(0, 3) + ") " + digits.slice(3, 6) + "-" + digits.slice(6);
});
</script>`;

/** A phone sign-in whose page code empties the field whenever anything is typed into it. */
const emptyingScreen = `<form action="/session" method="post">
<label>Phone <input name="phone" type="tel" autocomplete="tel"></label>
<button>Sign in</button>
</form>
<script>
const phone = document.querySelector("input[name=phone]");
phone.addEventListener("input", () => { phone.value = ""; });
</script>`;

/** Serves the screen and keeps each form the site receives. */
const serve = async (page: Page, body = screen) => {
  const received: Record<string, string>[] = [];
  await page.route(`${site}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      received.push(Object.fromEntries(new URLSearchParams(request.postData() ?? "")));
      await route.fulfill({ contentType: "text/html", body: "<p>Code sent</p>" });
    } else await route.fulfill({ contentType: "text/html", body });
  });
  await page.goto(`${site}/login`);
  return received;
};

/** The host's fill of the phone screen, inspected first, with `phone` as the login's number. */
const signIn = async (page: Page, phone: string) => {
  const host = await hostPage(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step: phoneStep, page: host, siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error(`Refused: ${inspection.reason}`);
  const { keyboard } = await hostKeyboard(page);
  return Effect.runPromise(
    fillAutofillStep({
      step: phoneStep,
      values: [phone],
      inspection,
      page: host,
      keyboard,
      settleMs: 2_000,
    }),
  );
};

test("never submits a phone the field kept other digits of, under a picker preset to another country", async ({
  page,
}) => {
  const received = await serve(page);
  const report = await signIn(page, otherCountry);
  expect(report).toMatchObject({
    outcome: "filled",
    fields: [{ slot: "phone", status: "changed" }],
    submit: "not_attempted",
  });
  await page.waitForTimeout(500);
  expect(received).toEqual([]);
  expect(JSON.stringify(report)).not.toContain("912");
});

test("submits the same number once the picker shows its country", async ({ page }) => {
  const received = await serve(page);
  expect(await signIn(page, otherCountry)).toMatchObject({ submit: "not_attempted" });
  // What an explore step does once the host names the number's calling code.
  await page.selectOption("select[name=country]", "7");
  const report = await signIn(page, otherCountry);
  expect(report).toMatchObject({
    outcome: "filled",
    fields: [{ slot: "phone", status: "filled" }],
    submit: "clicked",
  });
  expect(received).toEqual([{ country: "7", phone: "(912) 345-6789" }]);
});

test("submits a number the field keeps whole, its calling code dropped, as before", async ({
  page,
}) => {
  const received = await serve(page);
  const report = await signIn(page, sameCountry);
  expect(report).toMatchObject({
    outcome: "filled",
    fields: [{ slot: "phone", status: "filled" }],
    submit: "clicked",
  });
  expect(received).toEqual([{ country: "1", phone: "(415) 555-0134" }]);
});

test("leaves a phone field the page emptied to the empty-field check, as before", async ({
  page,
}) => {
  const received = await serve(page, emptyingScreen);
  const report = await signIn(page, sameCountry);
  expect(report).toMatchObject({
    outcome: "filled",
    fields: [{ slot: "phone", status: "failed" }],
    submit: "not_attempted",
  });
  await page.waitForTimeout(500);
  expect(received).toEqual([]);
});
