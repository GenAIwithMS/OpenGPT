import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import { inspectAutofillStep, type AutofillStep } from "../../src/destinations/autofill-step.js";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import { expectNotCarried, hostKeyboard, hostPage } from "./autofill-host-page.js";

// A code screen whose form has no submit control: one text field, which the browser submits when
// Enter is pressed in it. A step names that key in place of a submit, and the host presses it in
// the step's last field, judging and guarding the field's form as it would a clicked submit's.
// Chromium must generate the key events and the form's implicit submission.
const site = "https://login.example.test";
const code = "246810";

const codeStep: AutofillStep = {
  fields: [{ selector: "#code", slot: "code" }],
  submitKey: "Enter",
};

/** A code form posting to `action`, with `extra` markup inside the form. */
const codeForm = (action: string, extra = "") =>
  `<form method="post" action="${action}"><label>Code<input id="code" name="code" autocomplete="one-time-code" inputmode="numeric"></label>${extra}</form>`;

/** Serves `screen` at /verify and keeps every request that reached the site after it loaded. */
const serve = async (page: Page, screen: string) => {
  const requests: { readonly method: string; readonly url: string; readonly body: string }[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const screenLoad = url.origin === site && url.pathname === "/verify" && request.method() === "GET";
    if (!screenLoad)
      requests.push({ method: request.method(), url: request.url(), body: request.postData() ?? "" });
    await route.fulfill({
      contentType: "text/html",
      body: screenLoad ? screen : '<p id="account">Signed in</p>',
    });
  });
  await page.goto(`${site}/verify`);
  return requests;
};

/** The host's inspection of `step`, then its fill with `values` when the inspection passes. */
const inspectAndFill = async (page: Page, step: AutofillStep, values: readonly string[]) => {
  const host = await hostPage(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step, page: host, siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) return { inspection, report: undefined };
  const report = await Effect.runPromise(
    fillAutofillStep({
      step,
      values,
      inspection,
      page: host,
      keyboard: (await hostKeyboard(page)).keyboard,
      settleMs: 2_000,
    }),
  );
  expectNotCarried(host.calls, code);
  return { inspection, report };
};

test("a code form with no submit control is submitted by Enter in its field, its form described for Guardian", async ({
  page,
}) => {
  const requests = await serve(page, codeForm("/verify"));
  const { inspection, report } = await inspectAndFill(page, codeStep, [code]);
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  expect(inspection.screen.submit).toMatchObject({ tag: "form", formMethod: "post" });
  expect(inspection.screen.submitKey).toEqual({ key: "Enter", field: 0, submitControls: 0 });
  expect(report).toMatchObject({
    outcome: "filled",
    fields: [{ slot: "code", status: "filled" }],
    submit: "clicked",
  });
  expect(requests).toEqual([
    { method: "POST", url: `${site}/verify`, body: `code=${code}` },
  ]);
  await expect(page.locator("#account")).toBeVisible();
});

test("a form that shows a submit control says so to Guardian", async ({ page }) => {
  await serve(page, codeForm("/verify", "<button>Verify</button>"));
  const host = await hostPage(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step: codeStep, page: host, siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  expect(inspection.screen.submitKey).toEqual({ key: "Enter", field: 0, submitControls: 1 });
});

test("a code field in no form is refused before anything is typed", async ({ page }) => {
  const requests = await serve(
    page,
    `<input id="code" aria-label="Code"><script>
document.getElementById("code").addEventListener("keyup", (event) => {
  if (event.key === "Enter") fetch("/api/code", { method: "POST", body: event.target.value });
});
</script>`,
  );
  const { inspection, report } = await inspectAndFill(page, codeStep, [code]);
  expect(report).toBeUndefined();
  expect(inspection).toMatchObject({
    outcome: "refused",
    reason: "credential_target_refused",
    target: "submit",
    failureDetail: { context: { check: "submit_key", part: "no_form" } },
  });
  await expect(page.locator("#code")).toHaveValue("");
  expect(requests).toEqual([]);
});

test("a code form that posts to another site is refused before anything is typed", async ({
  page,
}) => {
  const requests = await serve(page, codeForm("https://collector.example.net/code"));
  const { inspection, report } = await inspectAndFill(page, codeStep, [code]);
  expect(report).toBeUndefined();
  expect(inspection).toMatchObject({ outcome: "refused", reason: "credential_target_refused" });
  await expect(page.locator("#code")).toHaveValue("");
  expect(requests).toEqual([]);
});

test("a code form the page turns to GET as Enter is pressed is stopped as it fires, and the code never reaches an address", async ({
  page,
}) => {
  const requests = await serve(
    page,
    `${codeForm("/verify")}<script>
document.getElementById("code").addEventListener("keydown", (event) => {
  if (event.key === "Enter") event.target.form.method = "get";
});
</script>`,
  );
  const { report } = await inspectAndFill(page, codeStep, [code]);
  expect(report).toMatchObject({
    outcome: "filled",
    fields: [{ slot: "code", status: "filled" }],
    submit: "refused",
    clicked: true,
    failureDetail: { context: { check: "change", changed: "submission.method" } },
  });
  expect(requests).toEqual([]);
  expect(page.url()).toBe(`${site}/verify`);
});

test("a code form that submits itself once the code is typed, before the host presses Enter, is reported sent by the page and never submitted twice", async ({
  page,
}) => {
  const requests = await serve(
    page,
    `${codeForm("/verify")}<script>
document.getElementById("code").addEventListener("input", (event) => {
  if (event.target.value.length === 6) event.target.form.requestSubmit();
});
</script>`,
  );
  const { report } = await inspectAndFill(page, codeStep, [code]);
  expect(report).toMatchObject({
    outcome: "filled",
    fields: [{ slot: "code", status: "filled" }],
    submit: "page",
  });
  expect(requests).toEqual([{ method: "POST", url: `${site}/verify`, body: `code=${code}` }]);
  await expect(page.locator("#account")).toBeVisible();
});
