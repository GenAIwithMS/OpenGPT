import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import { inspectAutofillStep, type AutofillStep } from "../../src/destinations/autofill-step.js";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import { hostKeyboard, hostPage } from "./autofill-host-page.js";

// Chromium must lay the page out: whether an alert is seen depends on its box and its styles.
const site = "https://member.example.test";
const step: AutofillStep = {
  fields: [{ selector: "#password", slot: "password" }],
  submit: "#continue",
};

// The same notice shows before and after the submit; it is no answer to it.
const banner = '<div aria-live="polite">We use cookies on this site</div>';
const form = (field: string) =>
  `<form action="/session" method="post"><label>Password${field}</label><button id="continue">Sign in</button></form>`;

// Beside the site's answer, text no person sees, and a success notice, none of them an error: a
// screen reader's live region, a toast at opacity 0, an error moved off the page and a success
// alert. The field names its error, which wraps an alert of its own.
const answered = [
  banner,
  '<div role="alert">The password is incorrect</div>',
  '<div aria-live="assertive" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Form submitted</div>',
  '<div role="alert" style="opacity:0">Saved</div>',
  '<div class="error" style="position:absolute;left:-9999px;width:200px">Moved off the page</div>',
  '<div class="alert alert-success">Code sent</div>',
  '<div id="password-message">Error: <span role="alert">Try again</span></div>',
  form(
    '<input id="password" name="password" type="password" aria-invalid="true" aria-errormessage="password-message">',
  ),
].join("");

/**
 * The sign-in page, whose own script counts each time something reads its alerts, in the tab's
 * session storage, which outlives the submit's page load; `slow` makes each read take 3 s, as a
 * frame that answers late does.
 */
const signInPage = (slow: boolean) =>
  `<script>
const query = Document.prototype.querySelectorAll;
Document.prototype.querySelectorAll = function (selector) {
  if (String(selector).includes('role~="alert"')) {
    sessionStorage.setItem("alertReads", String(Number(sessionStorage.getItem("alertReads") ?? 0) + 1));
    ${slow ? "const end = Date.now() + 3000; while (Date.now() < end);" : ""}
  }
  return query.call(this, selector);
};
</script>${banner}${form('<input id="password" name="password" type="password">')}`;

/**
 * Signs in on a page served so, with the fill's own options, and returns the report and how many
 * times the sign-in page's alerts were read before the submit left it.
 */
const signIn = async (
  page: Page,
  options: { readonly countNewAlerts?: boolean; readonly slow?: boolean; readonly settleMs?: number },
) => {
  const posted: string[] = [];
  await page.route(`${site}/**`, async (route) => {
    if (route.request().method() === "POST") posted.push(route.request().url());
    await route.fulfill({
      contentType: "text/html",
      body: route.request().method() === "POST" ? answered : signInPage(options.slow === true),
    });
  });
  await page.goto(`${site}/login`);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({
      step,
      page: await hostPage(page),
      siteOrigin: site,
      authenticationOrigins: [],
    }),
  );
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  const report = await Effect.runPromise(
    fillAutofillStep({
      step,
      values: ["synthetic-alert-password"],
      inspection,
      page: await hostPage(page),
      keyboard: (await hostKeyboard(page)).keyboard,
      settleMs: options.settleMs ?? 500,
      ...(options.countNewAlerts === true ? { countNewAlerts: true } : {}),
    }),
  );
  if (report.outcome !== "filled") throw new Error(`Fill did not complete: ${report.outcome}`);
  const reads = await page.evaluate(() => Number(sessionStorage.getItem("alertReads") ?? 0));
  return { report, reads, posted };
};

test("a submit's answer is the alert text a person sees that was not there before the click", async ({
  page,
}) => {
  const { report } = await signIn(page, { countNewAlerts: true });
  expect(report.controls?.alerts).toEqual([
    "We use cookies on this site",
    "The password is incorrect",
    "Error: Try again",
  ]);
  // The notice shown before the click is no answer to it.
  expect(report.controls?.newAlerts).toBe(2);
});

// Only a host that reads the count pays for the read before the click: a run's replay, and any
// host that did not ask, clicks without it, and its report counts nothing.
test("a fill that does not ask for the count never reads the alerts before its click", async ({
  page,
}) => {
  const { report, reads } = await signIn(page, {});
  expect(reads).toBe(0);
  expect(report.controls?.alerts).toContain("The password is incorrect");
  expect(report.controls?.newAlerts).toBeUndefined();
});

// A frame that answers the read late never holds the click back for long: the click goes ahead,
// and with no read before it, the report counts nothing.
test("a read before the click that a frame answers late gives no count and holds the click back no longer", async ({
  page,
}) => {
  const { report, reads, posted } = await signIn(page, {
    countNewAlerts: true,
    slow: true,
    settleMs: 5000,
  });
  expect(reads).toBe(1);
  expect(posted).toHaveLength(1);
  expect(report.controls?.newAlerts).toBeUndefined();
});
