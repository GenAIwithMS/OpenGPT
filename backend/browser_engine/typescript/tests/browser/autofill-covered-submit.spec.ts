import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import { inspectAutofillStep, type AutofillStep } from "../../src/destinations/autofill-step.js";
import { fillAutofillStep, resubmitAutofillStep } from "../../src/destinations/autofill-fill.js";
import { hostKeyboard, hostPage } from "./autofill-host-page.js";

// A fixed footer that sits over a sign-in form's Log In button catches the host's click, and has
// no control of its own to dismiss. Chromium must lay out the footer over the button at the
// default viewport and decide where the click lands.
const site = "https://member.example.test";
const username = "synthetic-owner";
const password = "synthetic-footer-password";
const signInStep: AutofillStep = {
  fields: [
    { selector: "#username", slot: "username" },
    { selector: "#password", slot: "password" },
  ],
  submit: "#log-in",
};

/**
 * Serves, at /login, a sign-in form at the foot of a page that does not scroll, under a fixed
 * footer that notes any click on it, and keeps each form the site received.
 */
const serve = async (page: Page, script = "") => {
  const received: Record<string, string>[] = [];
  await page.route("https://*.example.test/**", async (route) => {
    if (route.request().method() === "POST") {
      received.push(Object.fromEntries(new URLSearchParams(route.request().postData() ?? "")));
      await route.fulfill({ contentType: "text/html", body: '<p id="account">Signed in</p>' });
    } else
      await route.fulfill({
        contentType: "text/html",
        body: `<body style="margin:0;height:100vh;overflow:hidden">
<form action="/session" method="post" style="position:absolute;bottom:20px;left:20px">
<label>Username<input id="username" name="username"></label>
<label>Password<input id="password" name="password" type="password"></label>
<button id="log-in">Log In</button></form>
<footer id="footer" style="position:fixed;bottom:0;left:0;right:0;height:120px;background:#eee">Help and terms</footer>
<script>document.getElementById("footer").addEventListener("click", () => sessionStorage.setItem("footer", "clicked"));
${script}</script></body>`,
      });
  });
  await page.goto(`${site}/login`);
  return received;
};

const inspect = async (page: Page) => {
  const hosted = await hostPage(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step: signInStep, page: hosted, siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  return { hosted, inspection };
};

const fill = async (page: Page) => {
  const { hosted, inspection } = await inspect(page);
  const { keyboard } = await hostKeyboard(page);
  return Effect.runPromise(
    fillAutofillStep({
      step: signInStep,
      values: [username, password],
      inspection,
      page: hosted,
      keyboard,
      settleMs: 1_000,
    }),
  );
};

/** The host's click again of the blocked screen, sent again unchanged, typing nothing. */
const clickAgain = async (page: Page) => {
  const { hosted, inspection } = await inspect(page);
  return Effect.runPromise(
    resubmitAutofillStep({ step: signInStep, inspection, page: hosted, settleMs: 1_000 }),
  );
};

const filled = [
  { slot: "username", status: "filled" },
  { slot: "password", status: "filled" },
];

test("a fixed footer over Log In catches the host's click: the fill reports it blocked by the footer, and the screen sent again presses that same Log In from the keyboard and signs in, clicking nothing on the footer; a Log In that focus never lands on stays blocked", async ({
  page,
}) => {
  // Four clicks the footer catches, each through Playwright's full 5 s click timeout.
  test.setTimeout(60_000);
  const received = await serve(page);
  expect(await fill(page)).toMatchObject({
    outcome: "filled",
    fields: filled,
    submit: "blocked",
    blockedBy: { tag: "footer", role: null },
  });
  expect(received).toEqual([]);
  expect(await clickAgain(page)).toMatchObject({
    outcome: "filled",
    fields: filled,
    submit: "clicked",
    via: "keyboard",
  });
  expect(received).toEqual([{ username, password }]);
  expect(await page.evaluate(() => sessionStorage.getItem("footer"))).toBeNull();

  // The same page, whose Log In gives the focus up as soon as it takes it.
  const unfocused = await page.context().newPage();
  const sent = await serve(
    unfocused,
    'document.getElementById("log-in").addEventListener("focus", (event) => event.target.blur());',
  );
  expect(await fill(unfocused)).toMatchObject({ outcome: "filled", submit: "blocked" });
  expect(await clickAgain(unfocused)).toMatchObject({
    outcome: "filled",
    submit: "blocked",
    blockedBy: { tag: "footer", role: null },
  });
  expect(sent).toEqual([]);
  expect(await unfocused.evaluate(() => sessionStorage.getItem("footer"))).toBeNull();
});
