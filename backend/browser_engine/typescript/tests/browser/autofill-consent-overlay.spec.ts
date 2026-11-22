import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import { chromium as patchright } from "patchright";
import { inspectAutofillStep, type AutofillStep } from "../../src/destinations/autofill-step.js";
import { fillAutofillStep, resubmitAutofillStep } from "../../src/destinations/autofill-fill.js";
import { expectNotCarried, hostKeyboard, hostPage } from "./autofill-host-page.js";

// A cookie or consent notice that sits over a sign-in form's submit catches the host's click, so
// the click never reaches the submit. Chromium must lay out the notice over the button and decide
// where the click lands.
const site = "https://member.example.test";
const username = "synthetic-owner";
const password = "synthetic-overlay-password";
const signInStep: AutofillStep = {
  fields: [
    { selector: "#username", slot: "username" },
    { selector: "#password", slot: "password" },
  ],
  submit: "#sign-in",
};
const dismissed: AutofillStep = { ...signInStep, dismiss: "#consent-accept" };

const notice = `<div id="consent" role="dialog" aria-label="Cookie notice" style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:10">
<p>This site uses cookies.</p><button id="consent-accept" type="button">Accept</button></div>`;
// What the page saw happen, in order, kept across the sign-in's own navigation.
const pageEvents = `const note = (event) => {
  const events = JSON.parse(sessionStorage.getItem("events") ?? "[]");
  if (!events.includes(event)) sessionStorage.setItem("events", JSON.stringify([...events, event]));
};
document.addEventListener("input", () => note("typed"));
document.addEventListener("click", (event) => {
  if (event.target.id !== "consent-accept") return;
  document.getElementById("consent").remove();
  note("accepted");
});`;

/**
 * Serves a sign-in form at /login, with `extra` markup after it, and keeps each request that
 * reached the site after the page loaded.
 */
const serve = async (page: Page, extra: string, script = "") => {
  const received: URLSearchParams[] = [];
  await page.route("https://*.example.test/**", async (route) => {
    if (route.request().method() === "POST") {
      received.push(new URLSearchParams(route.request().postData() ?? ""));
      await route.fulfill({ contentType: "text/html", body: '<p id="account">Signed in</p>' });
    } else
      await route.fulfill({
        contentType: "text/html",
        body: `<form action="/session" method="post">
<label>Username<input id="username" name="username"></label>
<label>Password<input id="password" name="password" type="password"></label>
<button id="sign-in">Sign in</button></form>${extra}
<script>${pageEvents}
${script}</script>`,
      });
  });
  await page.goto(`${site}/login`);
  return received;
};

/** The host's page and keyboard, counting each value the keyboard typed. */
const host = async (page: Page, { patchright = false } = {}) => {
  const typed: string[] = [];
  const { keyboard } = await hostKeyboard(page);
  return {
    page: await hostPage(page, [], { patchright }),
    typed,
    keyboard: {
      insertText: (...args: Parameters<typeof keyboard.insertText>) =>
        Effect.suspend(() => {
          typed.push(args[1]);
          return keyboard.insertText(...args);
        }),
    },
  };
};

const inspect = (hosted: Awaited<ReturnType<typeof host>>, step: AutofillStep) =>
  Effect.runPromise(
    inspectAutofillStep({ step, page: hosted.page, siteOrigin: site, authenticationOrigins: [] }),
  ).then((inspection) => {
    if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
    return inspection;
  });

const fill = async (hosted: Awaited<ReturnType<typeof host>>, step: AutofillStep) =>
  Effect.runPromise(
    fillAutofillStep({
      step,
      values: [username, password],
      inspection: await inspect(hosted, step),
      page: hosted.page,
      keyboard: hosted.keyboard,
      settleMs: 1_000,
    }),
  );

test("a notice over the submit catches the host's click: blocked, by the notice, with nothing sent; the step sent again with the notice's own control as dismiss clicks it and submits once without typing", async ({
  page,
}) => {
  const received = await serve(page, notice);
  const hosted = await host(page);
  const blocked = await fill(hosted, signInStep);
  expect(blocked).toMatchObject({
    outcome: "filled",
    fields: [
      { slot: "username", status: "filled" },
      { slot: "password", status: "filled" },
    ],
    submit: "blocked",
    blockedBy: { tag: "div", role: "dialog" },
  });
  expect(received).toEqual([]);

  const report = await Effect.runPromise(
    resubmitAutofillStep({
      step: dismissed,
      inspection: await inspect(hosted, dismissed),
      page: hosted.page,
      settleMs: 1_000,
    }),
  );
  expect(report).toMatchObject({
    outcome: "filled",
    fields: [
      { slot: "username", status: "filled" },
      { slot: "password", status: "filled" },
    ],
    submit: "clicked",
  });
  expect(received.map((body) => Object.fromEntries(body))).toEqual([{ username, password }]);
  expect(hosted.typed).toEqual([username, password]);
  expectNotCarried(hosted.page.calls, password);
});

// Kernel's browsers run Patchright, whose click names the element that caught it as Playwright's does.
test("on Patchright too, a notice over the submit catches the host's click: blocked, by the notice, with nothing sent", async () => {
  const browser = await patchright.launch({ headless: true });
  try {
    // Patchright's page has Playwright's API, declared by its own copy of Playwright's types.
    const page = (await browser.newPage()) as unknown as Page;
    const received = await serve(page, notice);
    const report = await fill(await host(page, { patchright: true }), signInStep);
    expect(report).toMatchObject({ submit: "blocked", blockedBy: { tag: "div", role: "dialog" } });
    expect(received).toEqual([]);
  } finally {
    await browser.close();
  }
});

test("a notice whose page code copies what was typed into its label, class and tag reports only its tag and role from their fixed lists", async ({
  page,
}) => {
  const received = await serve(
    page,
    "",
    `document.getElementById("password").addEventListener("input", () => {
  if (document.getElementById("consent")) return;
  const typed = document.getElementById("username").value;
  const cover = document.createElement(typed.toLowerCase().replace(/[^a-z]/g, "") + "-notice");
  cover.id = "consent";
  cover.setAttribute("role", typed);
  cover.setAttribute("aria-label", "Continue as " + typed.toLowerCase());
  cover.className = "x".repeat(190) + " " + typed;
  cover.style.cssText = "position:fixed;inset:0;z-index:10;display:block";
  document.body.append(cover);
}, { once: true });`,
  );
  const report = await fill(await host(page), signInStep);
  expect(report).toMatchObject({ submit: "blocked", blockedBy: { tag: "other", role: null } });
  expect(JSON.stringify(report).toLowerCase()).not.toContain(username.slice(0, 8).toLowerCase());
  expect(received).toEqual([]);
});

test("a step that names the notice's own control as dismiss clears it before typing and submits once", async ({
  page,
}) => {
  const received = await serve(page, notice);
  const hosted = await host(page);
  const report = await fill(hosted, dismissed);
  expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
  expect(await page.evaluate(() => sessionStorage.getItem("events"))).toBe(
    JSON.stringify(["accepted", "typed"]),
  );
  expect(received.map((body) => Object.fromEntries(body))).toEqual([{ username, password }]);
  expect(hosted.typed).toEqual([username, password]);
});

test("a notice drawn only once the fields hold input is dismissed when it catches the click, and the submit is clicked once more without typing", async ({
  page,
}) => {
  const received = await serve(
    page,
    "",
    `document.getElementById("password").addEventListener("input", () => {
  if (!document.getElementById("consent")) document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(notice)});
}, { once: true });`,
  );
  const hosted = await host(page);
  const report = await fill(hosted, dismissed);
  expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
  expect(received.map((body) => Object.fromEntries(body))).toEqual([{ username, password }]);
  expect(hosted.typed).toEqual([username, password]);
});

test("a dismiss the page does not show is skipped, and the step fills and submits as before", async ({
  page,
}) => {
  const received = await serve(page, "");
  const hosted = await host(page);
  const report = await fill(hosted, dismissed);
  expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
  expect(received).toHaveLength(1);
});

for (const [named, dismiss] of [
  ["the sign-in submit", "#sign-in"],
  ["a control of the sign-in form", "#forgot"],
  ["a control that submits a form", "#subscribe"],
  ["a link to another page", "#elsewhere"],
  ["a shadow host whose root holds a control that submits a form", "#shadow-banner"],
  ["a container whose centre is a link to another page", "#links"],
  ["a label inside a control that submits a form", "#ok-label"],
  ["a label of a control that submits a form", "#offer-label"],
] as const)
  test(`a dismiss that names ${named} is refused before anything is typed`, async ({ page }) => {
    const received = await serve(
      page,
      `<div id="banner"><form action="/newsletter" method="post"><button id="subscribe">OK</button></form>
<a id="elsewhere" href="/privacy">Close</a>
<div id="shadow-banner"></div>
<div id="links" style="width:200px;height:40px"><a href="/privacy" style="display:block;width:100%;height:100%">Privacy</a></div>
<form action="/offers" method="post"><button><span id="ok-label">OK</span></button><button id="offer-ok">Yes</button></form>
<label id="offer-label" for="offer-ok">Accept</label></div>`,
      `document.querySelector("form").insertAdjacentHTML("beforeend", '<button id="forgot" type="button">Forgot?</button>');
document.getElementById("shadow-banner").attachShadow({ mode: "open" }).innerHTML = '<form action="/partners" method="post"><button style="width:200px;height:40px">OK</button></form>';`,
    );
    const hosted = await host(page);
    const report = await fill(hosted, { ...signInStep, dismiss });
    expect(report).toMatchObject({ outcome: "refused", reason: "dismiss_refused" });
    expect(hosted.typed).toEqual([]);
    expect(received).toEqual([]);
    expect(page.url()).toBe(`${site}/login`);
  });
