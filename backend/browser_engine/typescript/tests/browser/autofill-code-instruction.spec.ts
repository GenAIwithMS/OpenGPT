import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import { inspectAutofillStep, type AutofillStep } from "../../src/destinations/autofill-step.js";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import { hostKeyboard, hostPage } from "./autofill-host-page.js";

// A code screen that asks the owner to call a number within a few minutes, counting the time down
// in its own instruction. The code field names that instruction as its `questionSelector`: the
// host reads it at inspection, for the code question, and never checks it again, so the countdown
// never stops the fill.
const site = "https://login.example.test";

const codeStep: AutofillStep = {
  fields: [{ selector: "input[name=code]", slot: "code", questionSelector: "#call-in" }],
  submit: 'button:text-is("Verify")',
};

const screen = `<form action="/verify" method="post">
<p id="call-in">Call 1-800-555-0100 from the phone on your account. Time left: <span id="left">300</span> seconds.</p>
<label>Code <input name="code" inputmode="numeric" autocomplete="one-time-code"></label>
<button>Verify</button>
</form>
<script>
const left = document.querySelector("#left");
setInterval(() => { left.textContent = String(Number(left.textContent) - 1); }, 50);
</script>`;

/** Serves the screen and keeps each form the site receives. */
const serve = async (page: Page) => {
  const received: Record<string, string>[] = [];
  await page.route(`${site}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      received.push(Object.fromEntries(new URLSearchParams(request.postData() ?? "")));
      await route.fulfill({ contentType: "text/html", body: "<p>Signed in</p>" });
    } else await route.fulfill({ contentType: "text/html", body: screen });
  });
  await page.goto(`${site}/login/code`);
  return received;
};

test("reads a code screen's own instruction at inspection and fills the code while it counts down", async ({
  page,
}) => {
  const received = await serve(page);
  const host = await hostPage(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step: codeStep, page: host, siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error(`Refused: ${inspection.reason}`);
  expect(inspection.screen.fields[0]?.questionText).toMatch(
    /^Call 1-800-555-0100 from the phone on your account\. Time left: \d+ seconds\.$/u,
  );
  // The countdown moves on before the fill.
  await page.waitForTimeout(300);
  const { keyboard } = await hostKeyboard(page);
  const report = await Effect.runPromise(
    fillAutofillStep({
      step: codeStep,
      values: ["4821"],
      inspection,
      page: host,
      keyboard,
      settleMs: 2_000,
    }),
  );
  expect(report).toMatchObject({
    outcome: "filled",
    fields: [{ slot: "code", status: "filled" }],
    submit: "clicked",
  });
  expect(received).toEqual([{ code: "4821" }]);
});
