import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { runInThisContext } from "node:vm";
import { chromium as patchright } from "patchright";
import { Effect, Schema } from "effect";
import { inspectAutofillStep, type AutofillStep } from "../../src/destinations/autofill-step.js";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import {
  PageControls,
  pageControlsCode,
  presentControls,
  type PageControl,
} from "../../src/destinations/page-controls.js";
import { hostKeyboard, hostPage } from "./autofill-host-page.js";

// A minter writes a role selector from the name the host saved for a control. Playwright's `role=`
// engine matches that name whole, against the control's computed accessible name, so the saved name
// must be that accessible name: never a label's raw text, which can hold words the page hides from
// assistive technology.
const site = "https://member.example.test";

/** The control's selector by its role and saved name, as a minter writes one. */
const byRole = (control: PageControl) =>
  `role=${control.role}[name=${JSON.stringify(control.name)}]`;

/** `pageControls()` as the host's call runs it, on this page's frames, as the minter reads it. */
const readControls = async (page: Page) => {
  const run: unknown = runInThisContext(
    `(async (primary) => {\n${pageControlsCode}\nreturn pageControls();\n})`,
  );
  if (typeof run !== "function") throw new Error("Page code unavailable");
  return presentControls(
    Schema.decodeUnknownSync(PageControls)(await Reflect.apply(run, undefined, [page])),
  );
};

// The screen after the identifier, as hosted sign-in pages draw it: the label marks the password
// required with an asterisk hidden from assistive technology.
const identifierScreen = `<form action="/session" method="post">
<label for="email">Email</label><input id="email" name="email" type="email">
<button id="next">Continue</button></form>`;
const passwordScreen = `<form action="/session/password" method="post">
<label for="password">Password<span aria-hidden="true"> *</span></label>
<input id="password" name="password" type="password" required>
<button id="continue">Continue</button></form>`;

test("the next screen's password field is saved under the name a role selector matches", async ({
  page,
}) => {
  await page.route(`${site}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: route.request().method() === "POST" ? passwordScreen : identifierScreen,
    }),
  );
  await page.goto(`${site}/login`);
  const step: AutofillStep = { fields: [{ selector: "#email", slot: "username" }], submit: "#next" };
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step, page: await hostPage(page), siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  const report = await Effect.runPromise(
    fillAutofillStep({
      step,
      values: ["member@example.test"],
      inspection,
      page: await hostPage(page),
      keyboard: (await hostKeyboard(page)).keyboard,
      settleMs: 500,
    }),
  );
  if (report.outcome !== "filled") throw new Error(`Fill did not complete: ${report.outcome}`);
  const field = report.controls?.controls.find((control) => control.type === "password");
  if (field === undefined) throw new Error("No password control saved");
  // The label's raw text, "Password *", matched no element.
  await expect(page.locator(byRole(field))).toHaveCount(1);
  await expect(page.locator(byRole(field))).toHaveId("password");
  expect(field).toMatchObject({ role: "textbox", name: "Password", visible: true });
});

/**
 * Controls each named as Playwright's role engine names them, by `id`: hidden words left out
 * unless the label that holds them is hidden itself, visible and CSS-generated words kept, and an
 * `aria-label` taken as written.
 */
const named = [
  {
    id: "password",
    html: '<label for="password">Password<span aria-hidden="true"> *</span></label><input id="password" type="password">',
    role: "textbox",
    name: "Password",
  },
  {
    id: "email",
    html: '<span id="email-label">Email<span aria-hidden="true">*</span></span><input id="email" type="email" aria-labelledby="email-label">',
    role: "textbox",
    name: "Email",
  },
  {
    // A label and an aria-labelledby on the same field, each with a hidden asterisk.
    id: "username",
    html: '<label id="username-label" for="username">Username<span aria-hidden="true"> *</span></label><input id="username" aria-labelledby="username-label">',
    role: "textbox",
    name: "Username",
  },
  { id: "code", html: '<input id="code" aria-label="Code *">', role: "textbox", name: "Code *" },
  {
    id: "phone",
    html: '<label for="phone">Phone *</label><input id="phone" type="tel">',
    role: "textbox",
    name: "Phone *",
  },
  {
    id: "zip",
    html: '<label for="zip">Zip<span class="marker"> *</span></label><input id="zip">',
    role: "textbox",
    name: "Zip *",
  },
  {
    id: "city",
    html: '<label for="city">City<span style="display:none"> (hidden)</span><span style="visibility:hidden"> (unseen)</span></label><input id="city">',
    role: "textbox",
    name: "City",
  },
  {
    id: "given",
    html: '<label for="given" class="required">Given name</label><input id="given">',
    role: "textbox",
    name: "Given name *",
  },
  {
    // Generated text that holds a one-letter class name is still the label's own words.
    id: "nickname",
    html: '<label for="nickname">Nickname<span class="o"></span></label><input id="nickname">',
    role: "textbox",
    name: "Nickname (optional)",
  },
  {
    // Generated text that holds the label's whole class name is still the label's own words.
    id: "badge",
    html: '<label for="badge" class="req">Badge number</label><input id="badge">',
    role: "textbox",
    name: "Badge number (required)",
  },
  {
    id: "street",
    html: '<label for="street"><div>Street</div><div>address</div></label><input id="street">',
    role: "textbox",
    name: "Street address",
  },
  {
    // A hidden label still names its field.
    id: "search",
    html: '<span id="search-label" hidden>Search <span aria-hidden="true">all</span> terms</span><input id="search" type="search" aria-labelledby="search-label">',
    role: "searchbox",
    name: "Search all terms",
  },
  {
    id: "terms",
    html: '<input id="terms" type="checkbox"><label for="terms">I agree<span aria-hidden="true">*</span></label>',
    role: "checkbox",
    name: "I agree",
  },
  {
    id: "help",
    html: '<a id="help" href="#help"><span aria-hidden="true">?</span> Help</a>',
    role: "link",
    name: "Help",
  },
  {
    id: "close",
    html: '<button id="close" type="button"><img alt="Close" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></button>',
    role: "button",
    name: "Close",
  },
  { id: "send", html: '<input id="send" type="submit">', role: "button", name: "Submit" },
] as const;

const namesPage = `<!doctype html><style>.required::after { content: " \\2a"; } .o::after { content: " (optional)"; } .req::after { content: " (required)"; }</style><form onsubmit="return false">${named
  .map((control) => `<div>${control.html}</div>`)
  .join("")}</form>`;

/** Every control is saved under its accessible name, and that name's role selector finds it alone. */
const expectRoleSelectorsMatch = async (page: Page) => {
  await page.setContent(namesPage);
  const { controls } = await readControls(page);
  for (const { id, role, name } of named) {
    const control = controls.find((found) => found.role === role && found.name === name);
    expect(control, `${id} is saved as ${role} "${name}"`).toBeDefined();
    if (control === undefined) continue;
    await expect(page.locator(byRole(control)), id).toHaveCount(1);
    await expect(page.locator(byRole(control)), id).toHaveId(id);
  }
};

test("each control is saved under the accessible name its role selector matches", async ({ page }) => {
  await expectRoleSelectorsMatch(page);
});

test("each control is saved under the accessible name its role selector matches on Patchright", async () => {
  const browser = await patchright.launch({ headless: true });
  try {
    // Patchright's page has Playwright's API, declared by its own copy of Playwright's types.
    await expectRoleSelectorsMatch((await browser.newPage()) as unknown as Page);
  } finally {
    await browser.close();
  }
});

test("a name never holds what was typed: not a field, an editable element or an attribute the page copied it to", async ({
  page,
}) => {
  // The page copies the typed nickname into an attribute its label's generated text shows.
  await page.setContent(`<!doctype html>
<style>.mirror::after { content: " " attr(data-value); } [contenteditable] { display: inline-block; min-width: 4em; }</style>
<label for="amount">Amount in <input id="currency" aria-label="Currency"></label><input id="amount">
<div role="textbox" contenteditable="true" id="note"></div>
<label for="nickname">Nickname <span contenteditable="true" id="nickname-text"></span></label><input id="nickname">
<button type="button">Save <span contenteditable="true" id="button-text"></span></button>
<label for="mirror" class="mirror">Mirror</label><input id="mirror"
  oninput="this.labels[0].dataset.value = this.value">`);
  await page.locator("#currency").fill("typed-currency");
  await page.locator("#note").fill("typed-note");
  await page.locator("#nickname-text").fill("typed-nickname");
  await page.locator("#button-text").fill("typed-button");
  await page.locator("#mirror").fill("typed-mirror");
  const { controls } = await readControls(page);
  expect(controls.map((control) => control.name)).toEqual(
    expect.arrayContaining(["Amount in", "Currency", "Nickname", "Save", "Mirror"]),
  );
  expect(JSON.stringify(controls)).not.toContain("typed-");
  expect(controls).toContainEqual(expect.objectContaining({ role: "textbox", name: null, type: null }));
});

// An editable control is never named by its own text, though its author's label still names it.
test("an editable control is never named by what was typed into it", async ({ page }) => {
  await page.setContent(`<!doctype html>
<style>[contenteditable] { display: inline-block; min-width: 4em; }</style>
<div role="button" contenteditable="true" id="edit-button"></div>
<div role="option" contenteditable="true" id="edit-option" aria-label="Choice"></div>
<div role="option" contenteditable="true" id="edit-plain-option"></div>
<div role="textbox" contenteditable="true" id="edit-message" aria-label="Message"></div>`);
  await page.locator("#edit-button").fill("typed-button");
  await page.locator("#edit-option").fill("typed-option");
  await page.locator("#edit-plain-option").fill("typed-plain-option");
  await page.locator("#edit-message").fill("typed-message");
  const { controls } = await readControls(page);
  expect(JSON.stringify(controls)).not.toContain("typed-");
  expect(controls).toContainEqual(expect.objectContaining({ role: "button", name: null }));
  expect(controls).toContainEqual(expect.objectContaining({ role: "option", name: "Choice" }));
  expect(controls).toContainEqual(expect.objectContaining({ role: "option", name: null }));
  expect(controls).toContainEqual(expect.objectContaining({ role: "textbox", name: "Message" }));
});

// However the page draws a typed value into a label's generated text, from the label's id or
// class, a custom property or a rule its script adds, the value stays out of the name.
test("a typed value the page draws into generated text never reaches a name", async ({ page }) => {
  await page.setContent(`<!doctype html>
<style>
  #by-id::after { content: " " attr(id); }
  .by-class::after { content: " " attr(class); }
  .by-property::after { content: " " var(--typed); }
</style>
<form id="mirrors"></form>
<label for="id-field">Identifier</label><input id="id-field">
<label for="class-field">Class</label><input id="class-field">
<label for="property-field" class="by-property">Property</label><input id="property-field">
<label for="rule-field" id="rule-label">Rule</label><input id="rule-field">
<label for="plain" class="required-mark">Plain</label><input id="plain">
<label for="shadow-mirror" class="by-property" id="shadow-label">Shadow</label><input id="shadow-mirror"><x-field></x-field>
<style>.required-mark::after { content: " *"; }</style>
<script>
  const label = (field) => field.labels[0];
  document.querySelector("#id-field").addEventListener("input", (event) => { label(event.target).id = event.target.value; label(event.target).setAttribute("data-id", ""); document.styleSheets[0].insertRule("[data-id]::after { content: ' ' attr(id); }"); });
  document.querySelector("#class-field").addEventListener("input", (event) => { label(event.target).className = event.target.value; document.styleSheets[0].insertRule("." + CSS.escape(event.target.value) + "::after { content: ' ' attr(class); }"); });
  document.querySelector("#property-field").addEventListener("input", (event) => label(event.target).style.setProperty("--typed", JSON.stringify(event.target.value)));
  customElements.define("x-field", class extends HTMLElement {
    connectedCallback() {
      const root = this.attachShadow({ mode: "open" });
      root.innerHTML = '<input id="shadow-field" aria-label="Shadow field">';
      root.querySelector("input").addEventListener("input", (event) =>
        document.querySelector("#shadow-label").style.setProperty("--typed", JSON.stringify(event.target.value)));
    }
  });
  document.querySelector("#rule-field").addEventListener("input", (event) => document.styleSheets[0].insertRule("#rule-label::after { content: " + JSON.stringify(" " + event.target.value) + "; }"));
</script>`);
  await page.locator("#id-field").fill("typed-identifier");
  await page.locator("#class-field").fill("typed-class");
  await page.locator("#property-field").fill("typed-property");
  await page.locator("#rule-field").fill("typed-rule");
  await page.locator("#shadow-field").fill("typed-shadow");
  const { controls } = await readControls(page);
  expect(JSON.stringify(controls)).not.toContain("typed-");
  expect(controls.map((control) => control.name)).toEqual(
    expect.arrayContaining(["Identifier", "Class", "Property", "Rule", "Plain *", "Shadow"]),
  );
  // A field in an open shadow root, whose value the page draws into a label outside it, counts too.
  expect(
    await page.locator("#shadow-label").evaluate((label) => getComputedStyle(label, "::after").content),
  ).toBe('" typed-shadow"');
});

// A page script can make reading a name throw, here for one field's styles: that name is null,
// and the frame's other controls and its alerts are saved as ever.
test("a name that cannot be read is null, and the frame keeps its other controls and alerts", async ({
  page,
}) => {
  await page.setContent(`<!doctype html>
<script>
const read = window.getComputedStyle;
window.getComputedStyle = function (element, pseudo) {
  if (element.id === "broken") throw new Error("unreadable");
  return read.call(this, element, pseudo);
};
</script>
<input id="broken" aria-label="Broken"><label for="email">Email</label><input id="email" type="email">
<div role="alert">Try again</div>`);
  const { controls, alerts } = await readControls(page);
  expect(controls).toContainEqual(expect.objectContaining({ type: "text", name: null }));
  expect(controls).toContainEqual(expect.objectContaining({ type: "email", name: "Email" }));
  expect(alerts).toEqual(["Try again"]);
});

test("a hidden control is saved under the name its include-hidden role selector matches", async ({
  page,
}) => {
  // Only the field is hidden: its include-hidden name keeps the label's hidden asterisk.
  await page.setContent(`<!doctype html>
<label for="otp">One-time code<span aria-hidden="true"> *</span></label><div hidden><input id="otp"></div>`);
  const { controls } = await readControls(page);
  const control = controls.find((found) => found.type === "text");
  expect(control).toMatchObject({ role: "textbox", name: "One-time code *", visible: false });
  if (control === undefined) return;
  await expect(page.locator(`${byRole(control)}[include-hidden]`)).toHaveId("otp");
});
