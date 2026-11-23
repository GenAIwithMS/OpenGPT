import { isolatedLocatorPage } from "./isolated-locator-page.js";
import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import {
  inspectAutofillStep,
  type AutofillInspection,
  type AutofillStep,
} from "../../src/destinations/autofill-step.js";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import { judgedOrigins } from "../../src/destinations/autofill-refusal.js";
import { rememberTyping } from "../../src/destinations/autofill-typed-page.js";
import {
  expectNotCarried,
  expectOriginsOnly,
  hostKeyboard,
  hostPage,
} from "./autofill-host-page.js";

// Chromium must generate the click and form events for native and custom sign-in actions.
const site = "https://member.example.test";
const password = "synthetic-action-password";
const passwordStep: AutofillStep = {
  fields: [{ selector: "#password", slot: "password" }],
  submit: "#continue",
};

const serve = async (page: Page, controls: string, passwordField = true) => {
  const received: URLSearchParams[] = [];
  // Every host of the site's registrable domain, so a form may move to another one.
  await page.route("https://*.example.test/**", async (route) => {
    if (route.request().method() === "POST") {
      received.push(new URLSearchParams(route.request().postData() ?? ""));
      await route.fulfill({ contentType: "text/html", body: "<p>Signed in</p>" });
    } else
      await route.fulfill({
        contentType: "text/html",
        body: `<form action="/session" method="post">${passwordField ? '<label>Password<input id="password" name="password" type="password"></label>' : ""}${controls}</form>`,
      });
  });
  await page.goto(`${site}/login`);
  return received;
};

const inspect = async (page: Page, step: AutofillStep = passwordStep) =>
  Effect.runPromise(
    inspectAutofillStep({
      step,
      page: await hostPage(page),
      siteOrigin: site,
      authenticationOrigins: [],
    }),
  );

const fill = async (
  page: Page,
  inspection: AutofillInspection,
  step: AutofillStep = passwordStep,
  values: readonly string[] = [password],
) =>
  Effect.runPromise(
    fillAutofillStep({
      step,
      values,
      inspection,
      page: await hostPage(page),
      keyboard: (await hostKeyboard(page)).keyboard,
      settleMs: 500,
    }),
  );

test("the host shows native and ARIA actions to Guardian on a fieldless verification screen", async ({
  page,
}) => {
  await serve(
    page,
    `<a href="#" data-analytics="emailSelectBtnChooseCodeLogin">Email a code</a>
<a href="#" data-analytics="phoneSelectBtnChooseCodeLogin">Text a code</a>
<input type="image" alt="Continue">
<div role="link" tabindex="0">Use another method</div>`,
    false,
  );
  const step: AutofillStep = {
    fields: [],
    methods: [
      { method: "email", selector: 'a[data-analytics="emailSelectBtnChooseCodeLogin"]' },
      { method: "sms", selector: 'a[data-analytics="phoneSelectBtnChooseCodeLogin"]' },
    ],
    submit: 'a[data-analytics="phoneSelectBtnChooseCodeLogin"]',
  };
  const inspection = await inspect(page, step);
  expect(inspection).toMatchObject({
    screen: {
      submit: { tag: "a", text: "Text a code" },
      buttons: expect.arrayContaining([
        "Email a code",
        "Text a code",
        "Continue",
        "Use another method",
      ]),
    },
  });
});

test("the host shows Guardian the page's origin and a disabled submit as the page labels it", async ({
  page,
}) => {
  await serve(page, '<button id="continue" disabled>Sign in</button>');
  const inspection = await inspect(page);
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  expect(inspection.screen.origin).toBe(site);
  // Guardian judges what the submit is, not whether the page has enabled it yet.
  expect(inspection.screen.submit).toMatchObject({ tag: "button", text: "Sign in" });
  expect(inspection.screen.submit).not.toHaveProperty("enabled");
});

for (const [name, step] of [
  ["its submit", passwordStep],
  ["its fields when it names no submit", { fields: passwordStep.fields }],
] as const)
  test(`the origin Guardian sees for a sign-in form in a configured origin's frame is the frame's, from ${name}`, async ({
    page,
  }) => {
    const provider = "https://auth.provider.test";
    await page.route(`${site}/**`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<iframe src="${provider}/login"></iframe>`,
      }),
    );
    await page.route(`${provider}/**`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<form action="/session" method="post"><label>Password<input id="password" name="password" type="password"></label><button id="continue">Sign in</button></form>',
      }),
    );
    await page.goto(`${site}/login`);
    await page.frameLocator("iframe").locator("#password").waitFor();
    const inspection = await Effect.runPromise(
      inspectAutofillStep({
        step,
        page: await hostPage(page),
        siteOrigin: site,
        authenticationOrigins: [provider],
      }),
    );
    if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
    expect(inspection.screen.origin).toBe(provider);
  });

for (const [name, control] of [
  ["a button", '<button id="continue">Sign in</button>'],
  ["a submit input", '<input id="continue" type="submit" value="Sign in">'],
  ["an image input", '<input id="continue" type="image" alt="Sign in">'],
  [
    "an anchor",
    '<a id="continue" href="#" onclick="event.preventDefault();this.closest(\'form\').requestSubmit()">Sign in</a>',
  ],
  [
    "an ARIA button",
    '<div id="continue" role="button" tabindex="0" onclick="this.closest(\'form\').requestSubmit()">Sign in</div>',
  ],
] as const)
  test(`the host submits a sign-in through ${name}`, async ({ page }) => {
    const received = await serve(page, control);
    const inspection = await inspect(page);
    if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
    const report = await Effect.runPromise(
      fillAutofillStep({
        step: passwordStep,
        values: [password],
        inspection,
        page: await hostPage(page),
        keyboard: (await hostKeyboard(page)).keyboard,
        settleMs: 500,
      }),
    );
    expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
    expect(received.map((form) => form.get("password"))).toEqual([password]);
  });

test("a fieldless anchor choice sends only the chosen verification method", async ({ page }) => {
  const received = await serve(
    page,
    `<input name="method" type="hidden">
<a href="#" data-analytics="emailSelectBtnChooseCodeLogin" onclick="event.preventDefault();this.closest('form').elements.method.value='email';this.closest('form').requestSubmit()">Email a code</a>
<a href="#" data-analytics="phoneSelectBtnChooseCodeLogin" onclick="event.preventDefault();this.closest('form').elements.method.value='sms';this.closest('form').requestSubmit()">Text a code</a>`,
    false,
  );
  const step: AutofillStep = {
    fields: [],
    methods: [
      { method: "email", selector: 'a[data-analytics="emailSelectBtnChooseCodeLogin"]' },
      { method: "sms", selector: 'a[data-analytics="phoneSelectBtnChooseCodeLogin"]' },
    ],
    submit: 'a[data-analytics="phoneSelectBtnChooseCodeLogin"]',
  };
  const inspection = await inspect(page, step);
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  const report = await Effect.runPromise(
    fillAutofillStep({
      step,
      values: [],
      inspection,
      page: await hostPage(page),
      keyboard: (await hostKeyboard(page)).keyboard,
      settleMs: 500,
    }),
  );
  expect(report).toMatchObject({ outcome: "filled", fields: [], submit: "clicked" });
  expect(received.map((form) => Object.fromEntries(form))).toEqual([{ method: "sms" }]);
});

for (const [name, control, reason] of [
  [
    "off-site anchor",
    '<a id="continue" href="https://other.test/receive">Sign in</a>',
    "credential_target_refused",
  ],
  // A link to a script that does nothing sends nothing itself, so it is judged by its form; one
  // whose script does something runs what its address says.
  [
    "unsafe anchor",
    '<a id="continue" href="javascript:send()">Sign in</a>',
    "credential_target_refused",
  ],
  // An inert control takes no interaction at all: it marks a form in the background, not one the
  // page enables on input.
  ["submit inside an inert region", '<div inert><button id="continue">Sign in</button></div>', "not_editable"],
] as const)
  test(`the host refuses a ${name} before any password is filled`, async ({ page }) => {
    const received = await serve(page, control);
    expect(await inspect(page)).toMatchObject({ outcome: "refused", reason, target: "submit" });
    expect(await page.locator("#password").inputValue()).toBe("");
    expect(received).toEqual([]);
  });

// A form's elements leave out an image submit, so its own formaction is read beside them.
test("the host refuses a sign-in whose image submit posts off the site before any password is filled", async ({
  page,
}) => {
  const received = await serve(
    page,
    '<input id="continue" type="image" alt="Sign in" formaction="https://other.test/receive">',
  );
  expect(await inspect(page)).toMatchObject({
    outcome: "refused",
    reason: "credential_target_refused",
    target: 0,
    failureDetail: { context: { part: "form_action", actionOrigins: `${site} https://other.test` } },
  });
  expect(await page.locator("#password").inputValue()).toBe("");
  expect(received).toEqual([]);
});

const usernameAndPassword: AutofillStep = {
  fields: [
    { selector: "#username", slot: "username", accepts: ["username"] },
    { selector: "#password", slot: "password" },
  ],
  submit: "#continue",
};
/** A username field, and page code that runs `enable(both)` on each input with whether both hold some. */
const enabledOnInput = (submit: string, enable: string) =>
  `<label>Username<input id="username" name="username"></label>${submit}
<script>const form = document.forms[0];
const enable = (both) => { ${enable} };
form.addEventListener('input', () => enable(form.username.value !== '' && form.password.value !== ''));</script>`;

// Many sign-in forms keep their submit disabled until the fields hold input. The host fills them
// and clicks the submit once the page enables it, never while it is disabled.
for (const [name, controls] of [
  [
    "a disabled button until both fields hold input",
    enabledOnInput(
      '<button id="continue" disabled>Sign in</button>',
      "document.getElementById('continue').disabled = !both;",
    ),
  ],
  [
    "a disabled submit input until both fields hold input",
    enabledOnInput(
      '<input id="continue" type="submit" value="Sign in" disabled>',
      "document.getElementById('continue').disabled = !both;",
    ),
  ],
  [
    "a disabled button until a second after both fields hold input",
    enabledOnInput(
      '<button id="continue" disabled>Sign in</button>',
      "clearTimeout(window.validating); window.validating = setTimeout(() => { document.getElementById('continue').disabled = !both; }, 1000);",
    ),
  ],
  [
    "an ARIA button marked aria-disabled until both fields hold input",
    enabledOnInput(
      `<div id="continue" role="button" tabindex="0" aria-disabled="true" onclick="if (this.getAttribute('aria-disabled') !== 'true') this.closest('form').requestSubmit()">Sign in</div>`,
      "document.getElementById('continue').setAttribute('aria-disabled', String(!both));",
    ),
  ],
  [
    "a button in a disabled fieldset until both fields hold input",
    enabledOnInput(
      '<fieldset id="actions" disabled><button id="continue">Sign in</button></fieldset>',
      "document.getElementById('actions').disabled = !both;",
    ),
  ],
] as const)
  test(`a sign-in whose submit is ${name} is filled and sent once`, async ({
    page,
  }) => {
    const received = await serve(page, controls);
    const inspection = await inspect(page, usernameAndPassword);
    if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
    expect(
      await fill(page, inspection, usernameAndPassword, ["synthetic-user", password]),
    ).toMatchObject({
      outcome: "filled",
      fields: [
        { slot: "username", status: "filled" },
        { slot: "password", status: "filled" },
      ],
      submit: "clicked",
    });
    expect(received.map((form) => Object.fromEntries(form))).toEqual([
      { password, username: "synthetic-user" },
    ]);
  });

// A submit still disabled once the host stops waiting is never clicked, even one whose own click
// handler would submit, and the report says why: it stayed disabled after the fields were filled.
for (const [name, controls] of [
  ["a disabled button that never enables", '<button id="continue" disabled>Sign in</button>'],
  [
    "an aria-disabled ARIA button that never enables",
    `<div id="continue" role="button" tabindex="0" aria-disabled="true" onclick="this.closest('form').requestSubmit()">Sign in</div>`,
  ],
  [
    "a button the page disables once the password is typed",
    `<button id="continue">Sign in</button>
<script>document.getElementById('password').addEventListener('input', () => { document.getElementById('continue').disabled = true; });</script>`,
  ],
  [
    "an ARIA button the page marks aria-disabled once the password is typed",
    `<div id="continue" role="button" tabindex="0" onclick="this.closest('form').requestSubmit()">Sign in</div>
<script>document.getElementById('password').addEventListener('input', () => { document.getElementById('continue').setAttribute('aria-disabled', 'true'); });</script>`,
  ],
] as const)
  test(`a sign-in whose submit is ${name} is filled and never clicked`, async ({ page }) => {
    const requested: string[] = [];
    page.on("request", (request) => requested.push(request.url()));
    const received = await serve(page, controls);
    const inspection = await inspect(page);
    if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
    const started = Date.now();
    const report = await fill(page, inspection);
    // The host waited for the page to enable it before it gave up.
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
    expect(report).toMatchObject({
      outcome: "filled",
      fields: [{ slot: "password", status: "filled" }],
      submit: "stayed_disabled",
      failureDetail: { phase: "submit_disabled", context: { check: "submit_disabled" } },
    });
    expect(report).not.toHaveProperty("clicked");
    expectOriginsOnly(report);
    expect(JSON.stringify([report, { ...report.failureDetail }])).not.toContain(password);
    expect(await page.locator("#password").inputValue()).toBe(password);
    expect(requested.filter((url) => new URL(url).pathname === "/session")).toEqual([]);
    expect(received).toEqual([]);
  });

test("a changed anchor destination is refused after typing without sending the form", async ({
  page,
}) => {
  const received = await serve(
    page,
    `<a id="continue" href="#" onclick="event.preventDefault();this.closest('form').requestSubmit()">Sign in</a>
<script>document.getElementById('password').addEventListener('input',()=>document.getElementById('continue').href='https://other.test/receive')</script>`,
  );
  const inspection = await inspect(page);
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  const report = await Effect.runPromise(
    fillAutofillStep({
      step: passwordStep,
      values: [password],
      inspection,
      page: await hostPage(page),
      keyboard: (await hostKeyboard(page)).keyboard,
      settleMs: 500,
    }),
  );
  expect(report).toMatchObject({ outcome: "filled", submit: "refused" });
  expect(received).toEqual([]);
});

// Page code may change a sign-in form between the host's inspection and its fill. Each call judges
// the controls as it finds them by inspection's own rule, so only a destination off the site or a
// field that takes no typing refuses.
for (const [change, script] of [
  ["URL gains a query and hash", "history.pushState(null, '', '/login?step=password#password')"],
  ["form action gains a query", "document.forms[0].action = '/session?step=password'"],
  [
    "URL's query changes on every call",
    "setInterval(() => history.replaceState(null, '', '/login?at=' + performance.now()), 1)",
  ],
] as const)
  test(`a sign-in form whose ${change} after inspection is still filled and sent`, async ({
    page,
  }) => {
    const received = await serve(page, '<button id="continue">Sign in</button>');
    const inspection = await inspect(page);
    if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
    await page.evaluate(script);
    expect(await fill(page, inspection)).toMatchObject({ outcome: "filled", submit: "clicked" });
    expect(received.map((form) => form.get("password"))).toEqual([password]);
  });

// Each refusal says which check fired, with origins and never a path, query or value.
for (const [change, script, reason, evidence] of [
  [
    "form action moves off the site",
    "document.forms[0].action = 'https://other.test/receive?next=%2Faccount'",
    "credential_target_refused",
    {
      check: "destination",
      part: "form_action",
      changed: "0.actions submit.actions",
      frameOrigin: site,
      documentOrigin: site,
      actionOrigins: "https://other.test",
      pageOrigin: site,
      matchFrameOrigin: site,
      framesSearched: 1,
    },
  ],
  [
    "form action moves to another path",
    "document.forms[0].action = '/v2/session'",
    "credential_target_refused",
    { check: "change", changed: "0.actions submit.actions", pageOrigin: site },
  ],
  [
    "field turns read-only",
    "document.getElementById('password').readOnly = true",
    "not_editable",
    { check: "not_editable", control: "text", changed: "0.editable" },
  ],
] as const)
  test(`a sign-in form whose ${change} after inspection is refused before typing`, async ({
    page,
  }) => {
    const received = await serve(page, '<button id="continue">Sign in</button>');
    const inspection = await inspect(page);
    if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
    await page.evaluate(script);
    const report = await fill(page, inspection);
    expect(report).toMatchObject({
      outcome: "refused",
      reason,
      target: 0,
      failureDetail: { phase: evidence.check, context: evidence },
    });
    expectOriginsOnly(report);
    expect(await page.locator("#password").inputValue()).toBe("");
    expect(received).toEqual([]);
  });

const phoneStep: AutofillStep = {
  fields: [
    { selector: "#phone", slot: "phone", accepts: ["phone"] },
    { selector: "#password", slot: "password" },
  ],
  submit: "#continue",
};

/** A phone field that locks on input while its formatter runs and formats once focus leaves it. */
const reformattingPhone = `<label>Phone<input id="phone" name="phone" type="tel"></label><button id="continue">Sign in</button>
<script>const phone = document.getElementById('phone');
phone.addEventListener('input', () => { phone.readOnly = true; });
phone.addEventListener('blur', () => {
  const digits = phone.value;
  phone.value = '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6);
  phone.readOnly = false;
});</script>`;

test("a phone field that locks while it reformats what was typed still signs in", async ({
  page,
}) => {
  // The field locks on input while its formatter runs and formats once focus leaves it, so the
  // password's call finds it read-only and the submit's finds it editable again.
  const received = await serve(page, reformattingPhone);
  const inspection = await inspect(page, phoneStep);
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  expect(await fill(page, inspection, phoneStep, ["4155550123", password])).toMatchObject({
    outcome: "filled",
    fields: [
      { slot: "phone", status: "filled" },
      { slot: "password", status: "filled" },
    ],
    submit: "clicked",
  });
  expect(received.map((form) => Object.fromEntries(form))).toEqual([
    { password, phone: "(415) 555-0123" },
  ]);
});

// Each call compares the controls against what the call before it found, which the page keeps, so
// A harmless change is judged again with no URL in any call's code.
test("a form whose action gains a query after inspection, then a typed field locks to reformat, still signs in", async ({
  page,
}) => {
  const received = await serve(page, reformattingPhone);
  const host = await hostPage(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({
      step: phoneStep,
      page: host,
      siteOrigin: site,
      authenticationOrigins: [],
    }),
  );
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  await page.evaluate(() => {
    const [form] = document.forms;
    if (form !== undefined) form.action = "/session?step=password";
  });
  const report = await Effect.runPromise(
    fillAutofillStep({
      step: phoneStep,
      values: ["4155550123", password],
      inspection,
      page: host,
      keyboard: (await hostKeyboard(page)).keyboard,
      settleMs: 500,
    }),
  );
  expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
  expect(received.map((form) => Object.fromEntries(form))).toEqual([
    { password, phone: "(415) 555-0123" },
  ]);
  expectNotCarried(host.calls, "4155550123");
  expectNotCarried(host.calls, password);
});

test("a page reloaded between inspection and fill, which drops what the page kept, still signs in", async ({
  page,
}) => {
  const received = await serve(page, '<button id="continue">Sign in</button>');
  const inspection = await inspect(page);
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  await page.reload();
  expect(await fill(page, inspection)).toMatchObject({ outcome: "filled", submit: "clicked" });
  expect(received.map((form) => form.get("password"))).toEqual([password]);
});

test("a typed field that reads differently on every call is refused on the third", async ({
  page,
}) => {
  // Once typed, the phone field reads as locked and unlocked by turns, so each call finds it
  // changed from what the call before it found.
  const received = await serve(
    page,
    `<label>Phone<input id="phone" name="phone" type="tel"></label><button id="continue">Sign in</button>
`,
  );
  // This controlled read fault belongs in the realm the host inspects; a page's main-world
  // JavaScript getter cannot change Patchright's private element wrapper.
  const kernel = await isolatedLocatorPage(page);
  try {
    const [primary] = kernel.page.frames();
    if (primary === undefined) throw new Error("Fixture primary frame missing");
    await primary.locator("#phone").evaluate((element) => {
      element.addEventListener(
        "input",
        () => {
          let locked = false;
          Object.defineProperty(element, "readOnly", {
            get: () => (locked = !locked),
            configurable: true,
          });
        },
        { once: true },
      );
    });
  } finally {
    await kernel.close();
  }
  const inspection = await inspect(page, phoneStep);
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  expect(await fill(page, inspection, phoneStep, ["4155550123", password])).toMatchObject({
    outcome: "filled",
    fields: [
      { slot: "phone", status: "filled" },
      { slot: "password", status: "failed" },
    ],
    submit: "not_attempted",
    failureDetail: { phase: "change", context: { check: "change", changed: "0.editable" } },
  });
  expect(await page.locator("#password").inputValue()).toBe("");
  expect(received).toEqual([]);
});

// Typing may move the form off the site or switch it to GET, which would put the values in a URL.
for (const [change, script, check] of [
  ["moves its action off the site", "form.action = 'https://other.test/receive'", "destination"],
  ["switches it from POST to GET", "form.method = 'get'", "change"],
] as const)
  for (const [moment, typed, passwordStatus, submit] of [
    ["the next value", "phone", "failed", "not_attempted"],
    ["the submit", "password", "filled", "refused"],
  ] as const)
    test(`a form whose typing ${change} is refused before ${moment}`, async ({ page }) => {
      const requested: string[] = [];
      page.on("request", (request) => requested.push(request.url()));
      const received = await serve(
        page,
        `<label>Phone<input id="phone" name="phone" type="tel"></label><button id="continue">Sign in</button>
<script>document.getElementById('${typed}').addEventListener('input', ({ target: { form } }) => { ${script}; });</script>`,
      );
      const inspection = await inspect(page, phoneStep);
      if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
      const report = await fill(page, inspection, phoneStep, ["4155550123", password]);
      expect(report).toMatchObject({
        outcome: "filled",
        fields: [
          { slot: "phone", status: "filled" },
          { slot: "password", status: passwordStatus },
        ],
        submit,
        failureDetail: { phase: check },
      });
      expect(await page.locator("#password").inputValue()).toBe(typed === "phone" ? "" : password);
      // The failure detail serializes only for its archive, so it is copied out to be read.
      expect(JSON.stringify([report, { ...report.failureDetail }])).not.toContain(password);
      expect(requested.filter((url) => url.includes(password))).toEqual([]);
      expect(received).toEqual([]);
    });

/** Request URLs that carry the password, as sent or once decoded. */
const carrying = (requested: readonly string[]) =>
  requested.filter((url) => url.includes(password) || decodeURIComponent(url).includes(password));

// Page code that runs while the host clicks acts after the last recheck. A submission that would
// put a value filled into a form judged to submit by POST into a URL is refused as it fires.
for (const [attack, controls, changed] of [
  [
    "click handler switches the form to GET",
    `<button id="continue" onclick="this.form.method = 'get'">Sign in</button>`,
    "submission.method",
  ],
  [
    "click handler gives its button formmethod=get",
    `<button id="continue" onclick="this.formMethod = 'get'">Sign in</button>`,
    "submission.method",
  ],
  [
    "click handler switches the form to GET and calls form.submit()",
    `<button id="continue" onclick="this.form.method = 'get'; this.form.submit()">Sign in</button>`,
    "submission.method",
  ],
  [
    "own submit handler switches the form to GET",
    `<button id="continue">Sign in</button>
<script>document.forms[0].addEventListener('submit', ({ target }) => { target.method = 'get'; });</script>`,
    "submission.method",
  ],
  [
    "click handler switches to GET a form whose Forgot password button submits by GET",
    `<button id="continue" onclick="this.form.method = 'get'">Sign in</button>
<button formmethod="get" formaction="/forgot">Forgot password?</button>`,
    "submission.method",
  ],
  [
    "click handler switches to GET a method-less form's formmethod=post button",
    `<button id="continue" formmethod="post" onclick="this.formMethod = 'get'">Sign in</button>
<script>document.forms[0].removeAttribute('method');</script>`,
    "submission.method",
  ],
  [
    "click handler switches to GET and, after form.submit(), its later formdata listener puts the form back with the password",
    `<button id="continue" onclick="const form = this.form; form.method = 'get'; window.addEventListener('formdata', (event) => { document.body.append(form); event.formData.set('password', form.password.value); }, true); form.submit()">Sign in</button>`,
    "submission.method",
  ],
  [
    "submit sits in a GET form, and its click handler switches the password's own POST form to GET and calls form.submit()",
    `</form><form method="get" action="/search"><button id="continue" type="button" onclick="const form = document.forms[0]; form.method = 'get'; form.submit()">Sign in</button>`,
    "submission.method",
  ],
  [
    "page defines the guard's former global name before the host arms it, and its click handler switches the form to GET",
    `<button id="continue" onclick="this.form.method = 'get'">Sign in</button>
<script>Object.defineProperty(window, '__opengptSubmissionGuard', { value: { refused: null } });</script>`,
    "submission.method",
  ],
  [
    "click handler puts the password in the form action",
    `<button id="continue" onclick="this.form.action = '/session?p=' + encodeURIComponent(this.form.password.value)">Sign in</button>`,
    "submission.action",
  ],
  [
    "typing puts the password in the form action",
    `<button id="continue">Sign in</button>
<script>document.getElementById('password').addEventListener('input', ({ target }) => { target.form.action = '/session?p=' + encodeURIComponent(target.value); });</script>`,
    "submission.action",
  ],
] as const)
  test(`a sign-in whose ${attack} is refused as it fires`, async ({ page }) => {
    const requested: string[] = [];
    page.on("request", (request) => requested.push(request.url()));
    const received = await serve(page, controls);
    const inspection = await inspect(page);
    if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
    const report = await fill(page, inspection);
    expect(carrying(requested)).toEqual([]);
    // The submission never leaves, not even without the values.
    expect(requested.filter((url) => new URL(url).pathname === "/session")).toEqual([]);
    expect(received).toEqual([]);
    // The click ran, so what it filled counts as maybe sent.
    expect(report).toMatchObject({
      outcome: "filled",
      fields: [{ slot: "password", status: "filled" }],
      submit: "refused",
      clicked: true,
      failureDetail: {
        phase: "change",
        context: { check: "change", changed, submissionActionOrigin: site, pageOrigin: site },
      },
    });
    expectOriginsOnly(report);
    expect(JSON.stringify([report, { ...report.failureDetail }])).not.toContain(password);
  });

test("a POST sign-in whose page reads its form as it submits still signs in", async ({ page }) => {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  const received = await serve(
    page,
    `<button id="continue" onclick="this.form.dataset.clicked = 'yes'">Sign in</button>
<script>document.forms[0].addEventListener('submit', ({ target }) => { new FormData(target); });</script>`,
  );
  const inspection = await inspect(page);
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  expect(await fill(page, inspection)).toMatchObject({ outcome: "filled", submit: "clicked" });
  expect(received.map((form) => form.get("password"))).toEqual([password]);
  expect(carrying(requested)).toEqual([]);
});

const codeStep: AutofillStep = {
  fields: [{ selector: "#code", slot: "code" }],
  submit: "#continue",
};
/** A code screen whose Verify button runs `onclick`, filled and clicked with `code`. */
const fillCode = async (page: Page, code: string, onclick: string, action = "/session") => {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  const received = await serve(
    page,
    `<label>Code<input id="code" name="code" inputmode="numeric"></label>
<button id="continue" onclick="${onclick}">Verify</button>
<script>document.forms[0].action = ${JSON.stringify(action)};</script>`,
    false,
  );
  const inspection = await inspect(page, codeStep);
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  const report = await fill(page, inspection, codeStep, [code]);
  return { report, received, requested };
};

// A page that enables its submit only on digit key presses, read by their legacy `which`, never on
// the host's native insertion, gets the code typed again key by key, then clicked once.
test("a code screen whose submit only a keyup enables is typed again key by key and sent once", async ({
  page,
}) => {
  const code = "246810";
  const received = await serve(
    page,
    `<label>Code<input id="code" name="code" inputmode="numeric"></label>
<button id="continue" disabled>Verify</button>
<script>document.getElementById('code').addEventListener('keyup', ({ target, which }) => { if (which >= 48 && which <= 57) document.getElementById('continue').disabled = !/^[0-9]{6}$/.test(target.value); });</script>`,
    false,
  );
  const inspection = await inspect(page, codeStep);
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  const host = await hostPage(page);
  const report = await Effect.runPromise(
    fillAutofillStep({
      step: codeStep,
      values: [code],
      inspection,
      page: host,
      keyboard: (await hostKeyboard(page)).keyboard,
      settleMs: 500,
    }),
  );
  expect(report).toMatchObject({
    outcome: "filled",
    fields: [{ slot: "code", status: "filled" }],
    submit: "clicked",
  });
  expect(received.map((form) => Object.fromEntries(form))).toEqual([{ code }]);
  expect(JSON.stringify(report)).not.toContain(code);
  expectNotCarried(host.calls, code);
});

// A code adjoined by digits is not found, since a short one turns up inside a timestamp by chance,
// and one the site's own address held before typing is no leak.
for (const [chance, code, onclick, action] of [
  [
    "inside a click-time timestamp",
    "2025",
    "this.form.action = '/session?ts=1759612025123'",
    "/session",
  ],
  [
    "in the action's path before typing",
    "2024",
    "this.form.action = '/2024/session?at=' + Date.now()",
    "/2024/session",
  ],
] as const)
  test(`a code ${chance} still signs in`, async ({ page }) => {
    const { report, received } = await fillCode(page, code, onclick, action);
    expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
    expect(received.map((form) => Object.fromEntries(form))).toEqual([{ code }]);
  });

// A code is found wherever no digit adjoins it, however the page joins it to other text.
for (const [where, onclick, changed, actionOrigin] of [
  [
    "the action's query",
    "this.form.action = '/session?otp=' + this.form.code.value",
    "submission.action",
    site,
  ],
  [
    "the action's bare query",
    "this.form.action = '/session?' + this.form.code.value",
    "submission.action",
    site,
  ],
  [
    "the action's query after a letter",
    "this.form.action = '/session?otp=c' + this.form.code.value",
    "submission.action",
    site,
  ],
  [
    "a query list in the action",
    "this.form.action = '/session?v=' + this.form.code.value + ',remember'",
    "submission.action",
    site,
  ],
  [
    "the action's path after a hyphen",
    "this.form.action = '/session/otp-' + this.form.code.value",
    "submission.action",
    site,
  ],
  [
    "the action's path before a file extension",
    "this.form.action = '/verify/' + this.form.code.value + '.json'",
    "submission.action",
    site,
  ],
  // An origin judged at inspection is named, any other is not, since it may hold a value.
  [
    "the action's hostname",
    "this.form.action = 'https://' + this.form.code.value + '.example.test/session'",
    "submission.action",
    "other",
  ],
  [
    "the action's hostname after letters",
    "this.form.action = 'https://otp' + this.form.code.value + '.example.test/session'",
    "submission.action",
    "other",
  ],
  [
    "a new GET form's hidden JSON",
    "const form = document.createElement('form'); form.action = '/session'; const state = document.createElement('input'); state.type = 'hidden'; state.name = 'state'; state.value = JSON.stringify({ otp: this.form.code.value }); form.append(state); document.body.append(form); form.submit(); return false;",
    "submission.method",
    site,
  ],
] as const)
  test(`a code the click handler puts in ${where} is refused as it fires`, async ({ page }) => {
    const code = "482913";
    const { report, received, requested } = await fillCode(page, code, onclick);
    expect(requested.filter((url) => url.includes(code))).toEqual([]);
    expect(received).toEqual([]);
    expect(report).toMatchObject({
      submit: "refused",
      clicked: true,
      failureDetail: { context: { changed, submissionActionOrigin: actionOrigin } },
    });
    expect(JSON.stringify([report, { ...report.failureDetail }])).not.toContain(code);
  });

// A code some screens split into one-character boxes, one digit typed into each. Its tests type
// into up to seven fields, so they get more time.
const boxCode = "482913";
const boxesStep: AutofillStep = {
  fields: Array.from(boxCode, (_, index) => ({ selector: `#box${index}`, slot: "code" as const })),
  submit: "#continue",
};
const boxes = Array.from(
  boxCode,
  (_, index) =>
    `<input id="box${index}" name="box${index}" inputmode="numeric" maxlength="1" aria-label="Digit ${index + 1}">`,
).join("");
/** A flow ID in the action's path, and a step in its query, where digits of the code stand alone. */
const flowAction = "/verify/a4e7f2c9-1b3d-4f5a-9c2e-d8b1e3f9a4c2?step=2";

/**
 * A code screen whose form posts to `flowAction` and whose Verify button runs `onclick`, inspected
 * once the host typed into the page earlier in the sign-in, so only the site's own origin exempts a
 * value and the action's path and query never do, then filled with `values`.
 */
const fillAfterTyping = async (
  page: Page,
  controls: string,
  step: AutofillStep,
  values: readonly string[],
  onclick: string,
  passwordField = false,
) => {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  const received = await serve(
    page,
    `${controls}<button id="continue" onclick="${onclick}">Verify</button>
<script>document.forms[0].action = ${JSON.stringify(flowAction)};</script>`,
    passwordField,
  );
  const host = await hostPage(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({
      step,
      page: host,
      siteOrigin: site,
      authenticationOrigins: [],
      judgedBeforeTyping: [],
    }),
  );
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  const report = await Effect.runPromise(
    fillAutofillStep({
      step,
      values,
      inspection,
      page: host,
      keyboard: (await hostKeyboard(page)).keyboard,
      settleMs: 500,
    }),
  );
  return { report, received, requested, host };
};

// A step's code fields are one code, their values joined in field order, found as a code in one
// field is: a box's lone digit is no code, and the whole code is found wherever it stands alone.
for (const [layout, controls, step, values, joined] of [
  [
    "six one-character boxes",
    boxes,
    boxesStep,
    [...boxCode],
    "Array.from(this.form.querySelectorAll('[name^=box]'), (box) => box.value).join('')",
  ],
  [
    "one field",
    '<label>Code<input id="code" name="code" inputmode="numeric"></label>',
    codeStep,
    [boxCode],
    "this.form.code.value",
  ],
] as const) {
  test(`a code in ${layout} signs in after typing when some of its digits stand alone in the action`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const { report, received, host } = await fillAfterTyping(page, controls, step, values, "");
    expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
    expect(received.map((form) => [...form.values()].join(""))).toEqual([boxCode]);
    expectNotCarried(host.calls, boxCode);
  });

  test(`a code in ${layout} the click handler puts whole in the action's query is refused as it fires`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const { report, received, requested } = await fillAfterTyping(
      page,
      controls,
      step,
      values,
      `this.form.action = '/verify?otp=' + ${joined}`,
    );
    expect(requested.filter((url) => url.includes(boxCode))).toEqual([]);
    expect(received).toEqual([]);
    expect(report).toMatchObject({
      submit: "refused",
      clicked: true,
      failureDetail: {
        context: { changed: "submission.action", submissionActionOrigin: site },
      },
    });
    expect(JSON.stringify([report, { ...report.failureDetail }])).not.toContain(boxCode);
  });
}

test("a password beside one-character code boxes is still found on its own", async ({ page }) => {
  test.setTimeout(90_000);
  const { report, received, requested } = await fillAfterTyping(
    page,
    boxes,
    { fields: [...passwordStep.fields, ...boxesStep.fields], submit: "#continue" },
    [password, ...boxCode],
    "this.form.action = '/verify?p=' + encodeURIComponent(this.form.password.value)",
    true,
  );
  expect(carrying(requested)).toEqual([]);
  expect(received).toEqual([]);
  expect(report).toMatchObject({
    submit: "refused",
    clicked: true,
    failureDetail: { context: { changed: "submission.action", submissionActionOrigin: site } },
  });
});

// Only one-character code fields join: two code fields that each hold the whole code are each
// found on their own, so the code in the action is refused, not a doubled code that never stands.
test("two code fields that each hold the whole code are each found on their own", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { report, received, requested } = await fillAfterTyping(
    page,
    '<input id="code" name="code" inputmode="numeric" aria-label="Code"><input id="again" name="again" inputmode="numeric" aria-label="Code again">',
    {
      fields: [
        { selector: "#code", slot: "code" },
        { selector: "#again", slot: "code" },
      ],
      submit: "#continue",
    },
    [boxCode, boxCode],
    "this.form.action = '/verify?otp=' + this.form.code.value",
  );
  expect(requested.filter((url) => url.includes(boxCode))).toEqual([]);
  expect(received).toEqual([]);
  expect(report).toMatchObject({
    submit: "refused",
    clicked: true,
    failureDetail: { context: { changed: "submission.action", submissionActionOrigin: site } },
  });
});

// A private answer is found inside any text, like a password: the guard finds it even where
// letters adjoin it in a path.
test("a private answer the click handler puts inside the action's path is refused as it fires", async ({
  page,
}) => {
  const answer = "synthetic-first-pet";
  const answerStep: AutofillStep = {
    fields: [{ selector: "#answer", slot: "private_answer" }],
    submit: "#continue",
  };
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  const received = await serve(
    page,
    `<label>Security answer<input id="answer" name="answer"></label>
<button id="continue" onclick="this.form.action = '/session/pet' + this.form.answer.value + 'name'">Verify</button>`,
    false,
  );
  const inspection = await inspect(page, answerStep);
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  const report = await fill(page, inspection, answerStep, [answer]);
  expect(requested.filter((url) => url.includes(answer))).toEqual([]);
  expect(received).toEqual([]);
  expect(report).toMatchObject({
    submit: "refused",
    clicked: true,
    failureDetail: { context: { changed: "submission.action", submissionActionOrigin: site } },
  });
  expect(JSON.stringify([report, { ...report.failureDetail }])).not.toContain(answer);
});

test("a password the click handler puts in the action's hostname is refused, naming no origin", async ({
  page,
}) => {
  // A host is lowercased as it is parsed, so the URL holds the password in another case.
  const mixedCase = "Synthetic-Host-Password";
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  const received = await serve(
    page,
    `<button id="continue" onclick="this.form.action = 'https://' + this.form.password.value + '.example.test/session'">Sign in</button>`,
  );
  const inspection = await inspect(page);
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  const report = await fill(page, inspection, passwordStep, [mixedCase]);
  const named = (text: string) => text.toLowerCase().includes(mixedCase.toLowerCase());
  expect(requested.filter(named)).toEqual([]);
  expect(received).toEqual([]);
  expect(report).toMatchObject({
    submit: "refused",
    clicked: true,
    failureDetail: {
      context: { changed: "submission.action", submissionActionOrigin: "other" },
    },
  });
  expect(named(JSON.stringify([report, { ...report.failureDetail }]))).toBe(false);
});

test("a submission the guard refuses names no action origin that part of the password made", async ({
  page,
}) => {
  const part = password.slice(0, 16);
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  const received = await serve(
    page,
    `<button id="continue" onclick="this.form.method = 'get'; this.form.action = 'https://' + this.form.password.value.slice(0, 16) + '.example.test/session'">Sign in</button>`,
  );
  const inspection = await inspect(page);
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  const report = await fill(page, inspection);
  expect(requested.filter((url) => url.includes(part))).toEqual([]);
  expect(received).toEqual([]);
  expect(report).toMatchObject({
    submit: "refused",
    clicked: true,
    failureDetail: {
      context: { changed: "submission.method", submissionActionOrigin: "other" },
    },
  });
  expect(JSON.stringify([report, { ...report.failureDetail }])).not.toContain(part);
});

test("a form whose typing moves its action to a scheme made of the password is refused, naming no origin", async ({
  page,
}) => {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  const received = await serve(
    page,
    `<button id="continue">Sign in</button>
<script>document.getElementById('password').addEventListener('input', ({ target }) => { target.form.action = target.value + ':x'; });</script>`,
  );
  const inspection = await inspect(page);
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  const report = await fill(page, inspection);
  expect(carrying(requested)).toEqual([]);
  expect(received).toEqual([]);
  expect(report).toMatchObject({
    submit: "refused",
    failureDetail: { context: { actionOrigins: "other" } },
  });
  expect(JSON.stringify([report, { ...report.failureDetail }])).not.toContain(password);
});

test("a form whose typing moves its action to a hostname made of the password is refused, naming no origin", async ({
  page,
}) => {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  const received = await serve(
    page,
    `<button id="continue">Sign in</button>
<script>document.getElementById('password').addEventListener('input', ({ target }) => { target.form.action = 'https://' + target.value + '.example.test/session'; });</script>`,
  );
  const inspection = await inspect(page);
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  const report = await fill(page, inspection);
  expect(carrying(requested)).toEqual([]);
  expect(received).toEqual([]);
  // The recheck before the click refuses it: the action moved to another origin.
  expect(report).toMatchObject({
    submit: "refused",
    failureDetail: { context: { check: "change", actionOrigins: "other" } },
  });
  expect(report).not.toHaveProperty("clicked");
  expect(JSON.stringify([report, { ...report.failureDetail }])).not.toContain(password);
});

test("a code screen judged GET after an identifier step on the same page submits as judged", async ({
  page,
}) => {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  // The identifier step posts by script and shows the code screen in the same document, which
  // keeps the email field and submits by GET, as Guardian then judges it.
  const received = await serve(
    page,
    `<label>Email<input id="email" name="email" type="email"></label>
<button id="next" type="button" onclick="const form = this.form; fetch('/identifier', { method: 'POST', body: new URLSearchParams(new FormData(form)) }); form.method = 'get'; form.insertAdjacentHTML('beforeend', '<label>Code<input id=code name=code></label><button id=verify>Verify</button>'); this.remove();">Next</button>`,
    false,
  );
  const emailStep: AutofillStep = {
    fields: [{ selector: "#email", slot: "email", accepts: ["email"] }],
    submit: "#next",
  };
  const first = await inspect(page, emailStep);
  if ("outcome" in first) throw new Error(`Inspection refused: ${first.reason}`);
  expect(await fill(page, first, emailStep, ["person@example.test"])).toMatchObject({
    submit: "clicked",
  });
  const verifyStep: AutofillStep = {
    fields: [{ selector: "#code", slot: "code" }],
    submit: "#verify",
  };
  const second = await inspect(page, verifyStep);
  if ("outcome" in second) throw new Error(`Inspection refused: ${second.reason}`);
  expect(await fill(page, second, verifyStep, ["246810"])).toMatchObject({ submit: "clicked" });
  expect(
    requested.flatMap((url) => {
      const { pathname, searchParams } = new URL(url);
      return pathname === "/session" ? [Object.fromEntries(searchParams)] : [];
    }),
  ).toEqual([{ email: "person@example.test", code: "246810" }]);
  expect(received.map((form) => Object.fromEntries(form))).toEqual([
    { email: "person@example.test" },
  ]);
});

test("a form judged to submit by GET still submits by GET", async ({ page }) => {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  await serve(page, '<button id="continue">Sign in</button>');
  await page.evaluate(() => {
    const [form] = document.forms;
    if (form !== undefined) form.method = "get";
  });
  const inspection = await inspect(page);
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  expect(await fill(page, inspection)).toMatchObject({ outcome: "filled", submit: "clicked" });
  // Guardian judged this form's method, so its values go in the URL.
  expect(
    requested.filter((url) => new URL(url).searchParams.get("password") === password),
  ).toHaveLength(1);
});

test("a frame's form judged GET, submitted by script from a submit in a form on the page, is refused as it fires", async ({
  page,
}) => {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  // The host's click submits the page's own POST form, so the frame's GET form is not the
  // submission Guardian judged for that click.
  const received = await serve(
    page,
    `</form><iframe srcdoc="<form method='get' action='/session'><label>Password<input id='password' name='password' type='password'></label></form>"></iframe>
<form method="post" action="/session"><button id="continue" type="button" onclick="document.querySelector('iframe').contentDocument.forms[0].submit()">Sign in</button></form>`,
    false,
  );
  await expect(page.frameLocator("iframe").locator("#password")).toBeVisible();
  const inspection = await inspect(page);
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  const report = await fill(page, inspection);
  expect(carrying(requested)).toEqual([]);
  expect(received).toEqual([]);
  expect(report).toMatchObject({
    submit: "refused",
    clicked: true,
    failureDetail: { context: { changed: "submission.method", submissionActionOrigin: site } },
  });
});

test("a frame's form judged GET, submitted by a control in no form on the page, still submits by GET", async ({
  page,
}) => {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  // The frame's form submits by GET, and the page's own control, in no form, submits it by script.
  await serve(
    page,
    `</form><iframe srcdoc="<form method='get' action='/session'><label>Password<input id='password' name='password' type='password'></label></form>"></iframe>
<div id="continue" role="button" tabindex="0" onclick="document.querySelector('iframe').contentDocument.forms[0].submit()">Sign in</div>`,
    false,
  );
  await expect(page.frameLocator("iframe").locator("#password")).toBeVisible();
  const inspection = await inspect(page);
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  const report = await fill(page, inspection);
  expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
  expect(report).not.toHaveProperty("clicked");
  // Guardian judged the field's own form, the one the page submits.
  expect(
    requested.filter((url) => new URL(url).searchParams.get("password") === password),
  ).toHaveLength(1);
});

// No value but a date of birth enters a Kernel call. Page code may copy what the
// host typed into a form's action or a frame's address; no call reports such a URL, and the host
// hands none back to Kernel in a later call's code.
test("a password the page copies into the form action's query while typing reaches no Kernel call or answer", async ({
  page,
}) => {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  const received = await serve(
    page,
    `<button id="continue">Sign in</button>
<script>document.getElementById('password').addEventListener('input', ({ target }) => { target.form.action = '/session?p=' + encodeURIComponent(target.value); });</script>`,
  );
  const host = await hostPage(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({
      step: passwordStep,
      page: host,
      siteOrigin: site,
      authenticationOrigins: [],
    }),
  );
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  const report = await Effect.runPromise(
    fillAutofillStep({
      step: passwordStep,
      values: [password],
      inspection,
      page: host,
      keyboard: (await hostKeyboard(page)).keyboard,
      settleMs: 500,
    }),
  );
  // The guard still refuses the submission that would carry it.
  expect(report).toMatchObject({ submit: "refused", clicked: true });
  expect(carrying(requested)).toEqual([]);
  expect(received).toEqual([]);
  expectNotCarried(host.calls, password);
});

for (const [part, address] of [
  ["query", "'/frame?p=' + encodeURIComponent(target.value)"],
  ["path", "'/frame/' + encodeURIComponent(target.value)"],
] as const)
  test(`a password the login frame's script puts in the frame's ${part} reaches no Kernel call or answer`, async ({
    page,
  }) => {
    const received: URLSearchParams[] = [];
    await page.route("https://*.example.test/**", async (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        received.push(new URLSearchParams(request.postData() ?? ""));
        await route.fulfill({ contentType: "text/html", body: "<p>Signed in</p>" });
        return;
      }
      await route.fulfill({
        contentType: "text/html",
        body: new URL(request.url()).pathname.startsWith("/frame")
          ? `<form action="/session" method="post"><label>Password<input id="password" name="password" type="password"></label><button id="continue">Sign in</button></form>
<script>document.getElementById('password').addEventListener('input', ({ target }) => history.replaceState(null, '', ${address}));</script>`
          : '<iframe src="/frame"></iframe>',
      });
    });
    await page.goto(`${site}/login`);
    await expect(page.frameLocator("iframe").locator("#password")).toBeVisible();
    const host = await hostPage(page);
    const inspection = await Effect.runPromise(
      inspectAutofillStep({
        step: passwordStep,
        page: host,
        siteOrigin: site,
        authenticationOrigins: [],
      }),
    );
    if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
    const report = await Effect.runPromise(
      fillAutofillStep({
        step: passwordStep,
        values: [password],
        inspection,
        page: host,
        keyboard: (await hostKeyboard(page)).keyboard,
        settleMs: 500,
      }),
    );
    expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
    expect(received.map((form) => form.get("password"))).toEqual([password]);
    expectNotCarried(host.calls, password);
  });

/** The second of two sign-in screens in one document: a code, whose Verify click switches to GET. */
const secondScreen: AutofillStep = {
  fields: [{ selector: "#code", slot: "code" }],
  submit: "#verify",
};

/**
 * One document with two sign-in screens: a password, whose typing writes the password into the
 * second form's action host on `domain`, then `secondScreen`.
 */
const serveTwoScreens = async (page: Page, domain: string) => {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  await page.route("https://*.example.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<form id="first" action="/session" method="post"><label>Password<input id="password" name="password" type="password"></label><button id="next" type="button" onclick="document.getElementById('first').hidden = true; document.getElementById('second').hidden = false;">Next</button></form>
<form id="second" action="/verify" method="post" hidden><label>Code<input id="code" name="code" inputmode="numeric"></label><button id="verify" onclick="this.form.method = 'get'">Verify</button></form>
<script>document.getElementById('password').addEventListener('input', ({ target }) => { document.getElementById('second').action = 'https://' + target.value + '.${domain}/session'; });</script>`,
    }),
  );
  await page.goto(`${site}/login`);
  const first = await inspect(page, { ...passwordStep, submit: "#next" });
  if ("outcome" in first) throw new Error(`Inspection refused: ${first.reason}`);
  expect(await fill(page, first, { ...passwordStep, submit: "#next" })).toMatchObject({
    submit: "clicked",
  });
  // The host inspects the next screen as the sign-in's: something was typed in it already, so
  // only what the first screen judged before that may be named besides the site.
  const host = await hostPage(page);
  const second = await Effect.runPromise(
    inspectAutofillStep({
      step: secondScreen,
      page: host,
      siteOrigin: site,
      authenticationOrigins: [],
      judgedBeforeTyping: [...judgedOrigins(first)],
    }),
  );
  return { host, second, requested };
};

// A later step finds what an earlier one's typing left in the document: once
// anything was typed in the sign-in, evidence names only the site's and its configured sign-in
// origins, and no later call's code holds an address the page supplied.
test("a second screen whose form an earlier screen's typing moved to a host made of the password names no origin and holds it in no call's code", async ({
  page,
}) => {
  const { host, second, requested } = await serveTwoScreens(page, "example.test");
  if ("outcome" in second) throw new Error(`Inspection refused: ${second.reason}`);
  const report = await Effect.runPromise(
    fillAutofillStep({
      step: secondScreen,
      values: ["482913"],
      inspection: second,
      page: host,
      keyboard: (await hostKeyboard(page)).keyboard,
      settleMs: 500,
    }),
  );
  expect(report).toMatchObject({
    submit: "refused",
    clicked: true,
    failureDetail: {
      context: { changed: "submission.method", submissionActionOrigin: "other" },
    },
  });
  expect(JSON.stringify([report, { ...report.failureDetail }])).not.toContain(password);
  expect(carrying(requested)).toEqual([]);
  for (const { script } of host.calls) expect(script).not.toContain(password);
});

test("a second screen whose form an earlier screen's typing moved off the site, to a host made of the password, is refused naming no origin", async ({
  page,
}) => {
  const { host, second } = await serveTwoScreens(page, "other.test");
  expect(second).toMatchObject({
    outcome: "refused",
    reason: "credential_target_refused",
    target: 0,
    failureDetail: {
      context: {
        check: "destination",
        part: "form_action",
        actionOrigins: "other",
        frameOrigin: site,
        pageOrigin: site,
      },
    },
  });
  expect(
    JSON.stringify([second, { ...Object(Reflect.get(second, "failureDetail")) }]),
  ).not.toContain(password);
  for (const { script } of host.calls) expect(script).not.toContain(password);
});

// A page that empties a typed field leaves the step with nothing it reports
// filled, yet a value reached the page. The fill says so to the host, and no later call's code
// holds an origin list a page could have put a typed value in.
test("a password the page empties after copying it, then writes into its form's action host, reaches no later call's code", async ({
  page,
}) => {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  const received = await serve(
    page,
    `<button id="continue">Sign in</button>
<script>const field = document.getElementById('password');
field.addEventListener('input', () => {
  const copied = field.value;
  field.value = '';
  setTimeout(() => { field.form.action = 'https://' + copied + '.example.test/session'; }, 300);
}, { once: true });</script>`,
  );
  const host = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  // The browser's own inspections and fills, which remember whether the host typed into it.
  const browser = rememberTyping({
    inspect: (request) =>
      inspectAutofillStep({ ...request, page: host, siteOrigin: site, authenticationOrigins: [] }),
    fill: (input: {
      step: AutofillStep;
      values: readonly string[];
      inspection: AutofillInspection;
    }) => fillAutofillStep({ ...input, page: host, keyboard, settleMs: 500 }),
  });
  const signIn = async () => {
    const inspection = await Effect.runPromise(browser.inspect(passwordStep));
    if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
    return Effect.runPromise(browser.fill({ step: passwordStep, values: [password], inspection }));
  };
  // The field held nothing when the submit's call checked it, yet the host typed into it.
  expect(await signIn()).toMatchObject({
    outcome: "filled",
    fields: [{ slot: "password", status: "failed" }],
    submit: "not_attempted",
    typed: true,
  });
  await page.waitForFunction(() => document.forms[0]?.action.includes("synthetic") === true);
  // The host signs in again on the same page, whose form now submits to a host made of it: its
  // guard refuses that, and names no origin made of it.
  expect(await signIn()).toMatchObject({
    submit: "refused",
    clicked: true,
    failureDetail: {
      context: { changed: "submission.action", submissionActionOrigin: "other", pageOrigin: site },
    },
  });
  for (const { script } of host.calls) expect(script).not.toContain(password);
  expect(carrying(requested)).toEqual([]);
  expect(received).toEqual([]);
});

// A page an earlier screen's click moved to a host made of the password is no
// origin a later screen's guard refusal names.
test("a guard refusal on a screen an earlier screen's click moved to a host made of the password names no page origin", async ({
  page,
}) => {
  await page.route("https://*.example.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body:
        new URL(route.request().url()).pathname === "/verify"
          ? `<form action="/verify" method="post"><label>Code<input id="code" name="code" inputmode="numeric"></label><button id="verify" onclick="this.form.method = 'get'">Verify</button></form>`
          : `<form action="/session" method="post"><label>Password<input id="password" name="password" type="password"></label><button id="next" type="button" onclick="location.href = 'https://' + this.form.password.value + '.example.test/verify'">Next</button></form>`,
    }),
  );
  await page.goto(`${site}/login`);
  const firstStep = { ...passwordStep, submit: "#next" };
  const first = await inspect(page, firstStep);
  if ("outcome" in first) throw new Error(`Inspection refused: ${first.reason}`);
  expect(await fill(page, first, firstStep)).toMatchObject({ submit: "clicked" });
  await page.waitForURL("**/verify");
  const host = await hostPage(page);
  const second = await Effect.runPromise(
    inspectAutofillStep({
      step: secondScreen,
      page: host,
      siteOrigin: site,
      authenticationOrigins: [],
      judgedBeforeTyping: [...judgedOrigins(first)],
    }),
  );
  if ("outcome" in second) throw new Error(`Inspection refused: ${second.reason}`);
  const report = await Effect.runPromise(
    fillAutofillStep({
      step: secondScreen,
      values: ["482913"],
      inspection: second,
      page: host,
      keyboard: (await hostKeyboard(page)).keyboard,
      settleMs: 500,
    }),
  );
  expect(report).toMatchObject({
    submit: "refused",
    clicked: true,
    failureDetail: {
      context: {
        changed: "submission.method",
        submissionActionOrigin: "other",
        pageOrigin: "other",
      },
    },
  });
  // The step's own `url` stays byte-exact; the refusal record names no such origin.
  expect(JSON.stringify({ ...report.failureDetail })).not.toContain(password);
});

/**
 * One document with a username screen, whose typing runs `onUsername`, then a password screen
 * whose form submits to `action`; the site keeps each form it receives.
 */
const serveUsernameThenPassword = async (page: Page, action: string, onUsername = "") => {
  const received: URLSearchParams[] = [];
  await page.route("https://*.example.test/**", async (route) => {
    if (route.request().method() === "POST") {
      received.push(new URLSearchParams(route.request().postData() ?? ""));
      await route.fulfill({ contentType: "text/html", body: "<p>Signed in</p>" });
    } else
      await route.fulfill({
        contentType: "text/html",
        body: `<form id="first"><label>Username<input id="username" name="username"></label><button id="next" type="button" onclick="document.getElementById('first').hidden = true; document.getElementById('second').hidden = false;">Next</button></form>
<form id="second" action="${action}" method="post" hidden><label>Password<input id="password" name="password" type="password"></label><button id="continue">Sign in</button></form>
<script>document.getElementById('username').addEventListener('input', ({ target }) => { ${onUsername} });</script>`,
      });
  });
  await page.goto(`${site}/login`);
  return received;
};
const usernameScreen: AutofillStep = {
  fields: [{ selector: "#username", slot: "username", accepts: ["username"] }],
  submit: "#next",
};

/** The browser's own inspections and fills on `page`, which remember whether the host typed. */
const browserOn = async (page: Page, typed?: boolean) => {
  const host = await hostPage(page, [site]);
  const { keyboard } = await hostKeyboard(page);
  const browser = rememberTyping({
    inspect: (request) =>
      inspectAutofillStep({ ...request, page: host, siteOrigin: site, authenticationOrigins: [] }),
    fill: (input: {
      step: AutofillStep;
      values: readonly string[];
      inspection: AutofillInspection;
    }) => fillAutofillStep({ ...input, page: host, keyboard, settleMs: 500 }),
    ...(typed === undefined ? {} : { typed }),
  });
  return async (step: AutofillStep, values: readonly string[]) => {
    const inspection = await Effect.runPromise(browser.inspect(step));
    if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
    return Effect.runPromise(browser.fill({ step, values, inspection }));
  };
};

// No page chose the site's own origin, so a secret inside its host is no leak,
// even after something was typed. A path or query the page chose may hold a value it typed.
test("a password inside the site's own host still signs in after a username screen", async ({
  page,
}) => {
  const received = await serveUsernameThenPassword(page, "/session");
  const signIn = await browserOn(page);
  expect(await signIn(usernameScreen, ["synthetic-user"])).toMatchObject({ submit: "clicked" });
  expect(await signIn(passwordStep, ["member"])).toMatchObject({
    outcome: "filled",
    submit: "clicked",
  });
  expect(received.map((form) => form.get("password"))).toEqual(["member"]);
});

test("a password a site path held at inspection after a username screen is refused, as page code could have put it there", async ({
  page,
}) => {
  const received = await serveUsernameThenPassword(page, "/portal/session");
  const signIn = await browserOn(page);
  expect(await signIn(usernameScreen, ["synthetic-user"])).toMatchObject({ submit: "clicked" });
  expect(await signIn(passwordStep, ["portal"])).toMatchObject({
    submit: "refused",
    clicked: true,
    failureDetail: { context: { changed: "submission.action", submissionActionOrigin: site } },
  });
  expect(received).toEqual([]);
});

// A form the page moved while the host typed keeps the move, so the retry's
// inspection finds it; on the site's own origin, its path and query are still the page's choice.
for (const [part, action, refusedBy] of [
  ["query", "'/session?p=' + encodeURIComponent(target.value)", site],
  ["path", "'/session/' + target.value", site],
  ["host", "'https://' + target.value + '.example.test/session'", "other"],
] as const)
  test(`a retry on a form whose typing put the password in its action's ${part} is refused again`, async ({
    page,
  }) => {
    const requested: string[] = [];
    page.on("request", (request) => requested.push(request.url()));
    const received = await serve(
      page,
      `<button id="continue">Sign in</button>
<script>document.getElementById('password').addEventListener('input', ({ target }) => { target.form.action = ${action}; });</script>`,
    );
    const signIn = await browserOn(page);
    expect(await signIn(passwordStep, [password])).toMatchObject({ submit: "refused" });
    // One more fill is allowed, on the form the page left moved.
    expect(await signIn(passwordStep, [password])).toMatchObject({
      submit: "refused",
      clicked: true,
      failureDetail: {
        context: { changed: "submission.action", submissionActionOrigin: refusedBy },
      },
    });
    expect(carrying(requested)).toEqual([]);
    expect(received).toEqual([]);
  });

// A worker that takes over rejoins the same page with no memory of the
// predecessor's typing, so it starts as typed.
test("a new worker on the page an earlier worker typed into grants no exemption for a host made of the password", async ({
  page,
}) => {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  const received = await serveUsernameThenPassword(
    page,
    "/session",
    "document.getElementById('second').action = 'https://' + target.value + '.example.test/session';",
  );
  // The earlier worker typed the username, which the page put in the next form's host.
  expect(await (await browserOn(page))(usernameScreen, [password])).toMatchObject({
    submit: "clicked",
  });
  // The successor rejoins the browser it recovered, so it starts as typed.
  const report = await (await browserOn(page, true))(passwordStep, [password]);
  expect(report).toMatchObject({
    submit: "refused",
    clicked: true,
    failureDetail: { context: { changed: "submission.action", submissionActionOrigin: "other" } },
  });
  expect(carrying(requested)).toEqual([]);
  expect(received).toEqual([]);
});
