import { expect, test } from "@playwright/test";
import { Effect } from "effect";
import { inspectAutofillStep, type AutofillStep } from "../../src/destinations/autofill-step.js";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import { hostKeyboard, hostPage } from "./autofill-host-page.js";

const site = "https://login.example.test";
const password = "p@9x";
// A separate process is essential here: Chromium must scope the resolved native node to its OOPIF.

test.use({ launchOptions: { args: ["--site-per-process"] } });
test("preserves an approved login in an OOPIF", async ({ page }) => {
  const authOrigin = "https://approved-sign-in.test";
  await page.route(`${site}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: `<iframe src="${authOrigin}"></iframe>` }),
  );
  await page.route(`${authOrigin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<input id="frame-password" type="password">',
    }),
  );
  await page.goto(site);
  const frame = page.frames().find((frame) => frame.url().startsWith(authOrigin));
  if (!frame) throw new Error("Fixture frame missing");
  await frame.locator("#frame-password").waitFor();
  const session = await page.context().newCDPSession(frame);
  await session.detach();
  const step: AutofillStep = { fields: [{ selector: "#frame-password", slot: "password" }] };
  const host = await hostPage(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({
      step,
      page: host,
      siteOrigin: site,
      authenticationOrigins: [authOrigin],
    }),
  );
  if ("outcome" in inspection) throw new Error("Fixture inspection refused");
  const { keyboard } = await hostKeyboard(page);
  const report = await Effect.runPromise(
    fillAutofillStep({ step, values: [password], inspection, page: host, keyboard }),
  );
  expect(report.outcome).toBe("filled");
  expect(await frame.locator("#frame-password").inputValue()).toBe(password);
});
