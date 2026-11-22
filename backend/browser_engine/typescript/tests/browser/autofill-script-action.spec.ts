import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import {
  inspectAutofillStep,
  type AutofillInspection,
  type AutofillStep,
  type FillSlot,
} from "../../src/destinations/autofill-step.js";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import { runCardFill } from "../../src/destinations/card-fill.js";
import { makeSecretHandles } from "../../src/mint/secret-handles.js";
import { makeSignInBrowser, type SessionTyping } from "../../src/standalone/authentication.js";
import { expectOriginsOnly, hostKeyboard, hostPage } from "./autofill-host-page.js";

// A sign-in form whose own action is a script that does nothing (`javascript:`,
// `javascript:void(0)`, `javascript:;`) sends nothing by itself: the page's own code posts what the
// form holds. The host judges such a form by where its controls sit and by its other destinations,
// on a sign-in step only. A script action that does anything else is refused as before.
const site = "https://member.example.test";
const otherSite = "https://login.other.test";
const username = "synthetic-script-user";
const password = "synthetic-script-password";
const signInStep: AutofillStep = {
  fields: [
    { selector: "#username", slot: "username", accepts: ["username"] },
    { selector: "#password", slot: "password" },
  ],
  submit: "#continue",
};
const cardStep: AutofillStep<FillSlot> = {
  fields: [{ selector: "#card", slot: "card_number" }],
  submit: "#continue",
};

/**
 * A sign-in form the page's own script posts to its own origin on submit, with `attributes` on the
 * form (a `javascript:` action and no method by default) and `submit` as its submit.
 */
const scriptForm = (
  attributes = 'action="javascript:void(0)"',
  submit = '<button id="continue" type="submit">Log in</button>',
) => `<form ${attributes} novalidate>
<label>Email<input id="username" name="username" autocomplete="username"></label>
<label>Password<input id="password" name="password" type="password" autocomplete="current-password"></label>
${submit}
</form>
<script>document.forms[0].addEventListener('submit', (event) => {
  event.preventDefault();
  fetch('/session', { method: 'POST', body: new URLSearchParams(new FormData(event.target)) });
});</script>`;

/** A card form the page's own script posts, like `scriptForm`. */
const cardForm = (attributes: string, onclick = "") => `<form ${attributes} novalidate>
<label>Card number<input id="card" name="card" autocomplete="cc-number" inputmode="numeric"></label>
<button id="continue" type="submit" onclick="${onclick}">Pay</button>
</form>
<script>document.forms[0].addEventListener('submit', (event) => {
  event.preventDefault();
  fetch('/pay', { method: 'POST', body: new URLSearchParams(new FormData(event.target)) });
});</script>`;

/**
 * Serves each origin's page in `pages` and opens the site's: every POST is kept with its origin,
 * and every request's URL.
 */
const serve = async (page: Page, pages: Readonly<Record<string, string>>) => {
  const posts: { readonly origin: string; readonly form: URLSearchParams }[] = [];
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  for (const origin of [site, otherSite])
    await page.route(`${origin}/**`, async (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        posts.push({
          origin: new URL(request.url()).origin,
          form: new URLSearchParams(request.postData() ?? ""),
        });
        await route.fulfill({ contentType: "text/html", body: "<p>Signed in</p>" });
      } else await route.fulfill({ contentType: "text/html", body: pages[origin] ?? "" });
    });
  await page.goto(`${site}/login`);
  return { posts, requested };
};

const inspect = async (
  page: Page,
  step: AutofillStep<FillSlot> = signInStep,
  judgedBeforeTyping?: readonly string[],
) =>
  Effect.runPromise(
    inspectAutofillStep({
      step,
      page: await hostPage(page),
      siteOrigin: site,
      authenticationOrigins: [],
      ...(judgedBeforeTyping === undefined ? {} : { judgedBeforeTyping }),
    }),
  );

const fill = async (
  page: Page,
  inspection: AutofillInspection,
  step: AutofillStep<FillSlot> = signInStep,
  values: readonly string[] = [username, password],
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

/** The inspection that passed, or a failure that names the check that refused it. */
const passed = (inspection: Awaited<ReturnType<typeof inspect>>) => {
  if (!("outcome" in inspection)) return inspection;
  const context: unknown = Reflect.get({ ...inspection.failureDetail }, "context");
  throw new Error(`Inspection refused: ${inspection.reason} ${JSON.stringify(context)}`);
};

/** Request URLs that carry the password, as sent or once decoded. */
const carrying = (requested: readonly string[]) =>
  requested.filter((url) => url.includes(password) || decodeURIComponent(url).includes(password));

for (const action of [
  "javascript:void(0)",
  "javascript:",
  "javascript:;",
  " JavaScript: void ( 0 ) ; ",
  "javascript:%20void%200",
])
  test(`a sign-in form the page's own script posts, with the action ${JSON.stringify(action)}, is filled, clicked and posted once to the site`, async ({
    page,
  }) => {
    const { posts, requested } = await serve(page, { [site]: scriptForm(`action="${action}"`) });
    const inspection = passed(await inspect(page));
    const report = await fill(page, inspection);
    expect(report).toMatchObject({
      outcome: "filled",
      fields: [
        { slot: "username", status: "filled" },
        { slot: "password", status: "filled" },
      ],
      submit: "clicked",
    });
    // The guard let the submission fire.
    expect(report).not.toHaveProperty("clicked");
    await expect.poll(() => posts.length).toBe(1);
    expect(posts.map(({ origin, form }) => [origin, form.get("username"), form.get("password")])).toEqual([
      [site, username, password],
    ]);
    expect(carrying(requested)).toEqual([]);
  });

for (const [name, pages, step, evidence] of [
  [
    "a sign-in form whose action is off the site",
    { [site]: scriptForm('action="https://other.test/receive"') },
    signInStep,
    { part: "form_action", actionOrigins: "https://other.test" },
  ],
  [
    "a sign-in form with a script action whose submit sends off the site",
    {
      [site]: scriptForm(
        undefined,
        '<button id="continue" type="submit" formaction="https://other.test/receive">Log in</button>',
      ),
    },
    signInStep,
    { part: "form_action", actionOrigins: "javascript: https://other.test" },
  ],
  [
    "a sign-in form with a script action in a frame off the site",
    { [site]: `<iframe src="${otherSite}/login"></iframe>`, [otherSite]: scriptForm() },
    signInStep,
    { part: "frame", frameOrigin: otherSite, actionOrigins: "javascript:" },
  ],
  [
    "a sign-in form whose script action does something",
    { [site]: scriptForm('action="javascript:send()"') },
    signInStep,
    { part: "form_action", actionOrigins: "javascript:" },
  ],
  [
    "a sign-in form whose script action calls a page function named like void",
    { [site]: scriptForm('action="javascript:Void(0)"') },
    signInStep,
    { part: "form_action", actionOrigins: "javascript:" },
  ],
  [
    "a sign-in form whose script action splits void with a line break",
    { [site]: scriptForm('action="javascript:vo%0Aid(0)"') },
    signInStep,
    { part: "form_action", actionOrigins: "javascript:" },
  ],
  [
    "a sign-in form whose script action does something inside void",
    { [site]: scriptForm('action="javascript:void(send())"') },
    signInStep,
    { part: "form_action", actionOrigins: "javascript:" },
  ],
  [
    "a card form with a script action",
    { [site]: cardForm('action="javascript:void(0)"') },
    cardStep,
    { part: "form_action", actionOrigins: "javascript:" },
  ],
] as const)
  test(`${name} is refused before anything is typed`, async ({ page }) => {
    const { posts } = await serve(page, pages);
    const fields = otherSite in pages ? page.frameLocator("iframe") : page;
    await expect(fields.locator(step.fields[0]?.selector ?? "")).toBeVisible();
    const inspection = await inspect(page, step);
    expect(inspection).toMatchObject({
      outcome: "refused",
      reason: "credential_target_refused",
      target: 0,
      failureDetail: { phase: "destination", context: { check: "destination", ...evidence } },
    });
    expectOriginsOnly(inspection);
    for (const { selector } of step.fields)
      expect(await fields.locator(selector).inputValue()).toBe("");
    expect(posts).toEqual([]);
  });

// Page code that runs while the host clicks acts after the last recheck. A script action puts no
// value in an address, so the guard lets a sign-in's submission to one fire by GET; an address on
// the site, or a card form's submission, is still refused as it fires.
test("a sign-in form the page's own script posts, turned to GET as the host clicks, still fires", async ({
  page,
}) => {
  const { posts, requested } = await serve(page, {
    [site]: scriptForm(
      'method="post" action="javascript:void(0)"',
      `<button id="continue" type="submit" onclick="this.form.method = 'get'">Log in</button>`,
    ),
  });
  const inspection = passed(await inspect(page));
  const report = await fill(page, inspection);
  expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
  expect(report).not.toHaveProperty("clicked");
  await expect.poll(() => posts.length).toBe(1);
  expect(posts.map(({ origin, form }) => [origin, form.get("password")])).toEqual([[site, password]]);
  expect(carrying(requested)).toEqual([]);
});

test("a sign-in form with a script action that the click turns to GET with a script that does something is refused as it fires", async ({
  page,
}) => {
  const { posts, requested } = await serve(page, {
    [site]: scriptForm(
      'method="post" action="javascript:void(0)"',
      `<button id="continue" type="submit" onclick="this.form.method = 'get'; this.form.action = 'javascript:void(window.sent = 1)'">Log in</button>`,
    ),
  });
  const inspection = passed(await inspect(page));
  const report = await fill(page, inspection);
  expect(report).toMatchObject({
    outcome: "filled",
    submit: "refused",
    clicked: true,
    failureDetail: {
      context: { check: "change", changed: "submission.method", submissionActionOrigin: "other" },
    },
  });
  expectOriginsOnly(report);
  expect(await page.evaluate(() => Reflect.get(window, "sent"))).toBeUndefined();
  expect(carrying(requested)).toEqual([]);
  expect(posts.filter(({ form }) => form.get("password") !== null)).toEqual([]);
});

test("a sign-in form whose typing turns its script action into one that does something is refused before the password is typed", async ({
  page,
}) => {
  const { posts } = await serve(page, {
    [site]: `${scriptForm()}
<script>document.getElementById('username').addEventListener('input', ({ target }) => { target.form.action = 'javascript:void(send())'; });</script>`,
  });
  const inspection = passed(await inspect(page));
  const report = await fill(page, inspection);
  expect(report).toMatchObject({
    outcome: "filled",
    fields: [
      { slot: "username", status: "filled" },
      { slot: "password", status: "failed" },
    ],
    submit: "not_attempted",
    failureDetail: { context: { check: "destination", part: "form_action" } },
  });
  expectOriginsOnly(report);
  expect(await page.locator("#password").inputValue()).toBe("");
  expect(posts).toEqual([]);
});

test("a sign-in form with a script action that the click turns to GET on the site's own path is refused as it fires", async ({
  page,
}) => {
  const { posts, requested } = await serve(page, {
    [site]: scriptForm(
      'method="post" action="javascript:void(0)"',
      `<button id="continue" type="submit" onclick="this.form.method = 'get'; this.form.action = '/session'">Log in</button>`,
    ),
  });
  const inspection = passed(await inspect(page));
  const report = await fill(page, inspection);
  expect(report).toMatchObject({
    outcome: "filled",
    submit: "refused",
    clicked: true,
    failureDetail: {
      context: { check: "change", changed: "submission.method", submissionActionOrigin: site },
    },
  });
  expectOriginsOnly(report);
  expect(carrying(requested)).toEqual([]);
  expect(posts.filter(({ form }) => form.get("password") !== null)).toEqual([]);
});

test("a card form that the click turns to GET with a script action is refused as it fires", async ({
  page,
}) => {
  const card = "4242424242424242";
  const { posts, requested } = await serve(page, {
    [site]: cardForm(
      'method="post" action="/pay"',
      "this.form.method = 'get'; this.form.action = 'javascript:void(0)'",
    ),
  });
  const inspection = passed(await inspect(page, cardStep));
  const report = await fill(page, inspection, cardStep, [card]);
  expect(report).toMatchObject({
    outcome: "filled",
    submit: "refused",
    clicked: true,
    failureDetail: { context: { check: "change", changed: "submission.method" } },
  });
  expect(requested.filter((url) => url.includes(card))).toEqual([]);
  expect(posts.filter(({ form }) => form.get("card") !== null)).toEqual([]);
});

// A sign-in panel many sites open from a header link whose own address is a script that does
// nothing, outside any form: following it sends nothing, and the page's own code opens the panel.
// On a sign-in step the host judges such a link by where it sits, as it does a button outside a
// form. Such a link inside a form whose script action does something, and such a link on a card-fill
// step, stay refused.
const panelStep: AutofillStep = { fields: [], submit: "a.sign-in-link" };
const headerLink = (href: string) =>
  `<header><a href="${href}" class="sign-in-link">Sign In</a></header>`;
const panelPage = `${headerLink("javascript:void(0);")}
<div id="panel" hidden>${scriptForm('action="/session"')}</div>
<script>document.querySelector('.sign-in-link').addEventListener('click', () => {
  document.getElementById('panel').hidden = false;
});</script>`;

test("a sign-in step whose submit is a header link to a script that does nothing opens the sign-in panel", async ({
  page,
}) => {
  const { posts } = await serve(page, { [site]: panelPage });
  const inspection = passed(await inspect(page, panelStep));
  const report = await fill(page, inspection, panelStep, []);
  expect(report).toMatchObject({ outcome: "filled", fields: [], submit: "clicked" });
  await expect(page.locator("#username")).toBeVisible();
  expect(posts).toEqual([]);
});

// A sign-in step that types nothing, such as a sign-in provider chooser whose links or buttons run
// the page's own script to pick a provider, sends nothing of the login, so a script address of its
// submit, its link's or its form's own, is not judged as a destination: the host judges the
// control by where it sits and its other destinations, and the screen the click leads to is
// inspected again before anything is typed there.
const chooserStep: AutofillStep = { fields: [], submit: "#provider" };
// The panel's form comes first: its script listens on the page's first form.
const chooserPage = (control: string) => `<div id="panel" hidden>${scriptForm('action="/session"')}</div>
${control}
<script>window.chooseProvider = () => { document.getElementById('panel').hidden = false; };</script>`;

for (const [name, control] of [
  ["a link whose address runs a script", '<a id="provider" href="javascript:chooseProvider(\'corp\')">Company account</a>'],
  [
    "a button in a form whose script action does something",
    '<form action="javascript:chooseProvider(\'corp\')"><button id="provider" type="submit">Company account</button></form>',
  ],
  [
    "a link to a script that does nothing in a form whose script action does something",
    `<form action="javascript:send()"><a id="provider" href="javascript:void(0)" onclick="chooseProvider('corp')">Company account</a></form>`,
  ],
  ["a button whose click handler runs a script", '<button id="provider" onclick="chooseProvider(\'corp\')">Company account</button>'],
] as const)
  test(`a sign-in step that types nothing clicks ${name}`, async ({ page }) => {
    const { posts } = await serve(page, { [site]: chooserPage(control) });
    const inspection = passed(await inspect(page, chooserStep));
    const report = await fill(page, inspection, chooserStep, []);
    expect(report).toMatchObject({ outcome: "filled", fields: [], submit: "clicked" });
    await expect(page.locator("#username")).toBeVisible();
    expect(posts).toEqual([]);
  });

test("a sign-in step that types nothing is refused a link whose address runs a script once something was typed on the browser", async ({
  page,
}) => {
  const { posts } = await serve(page, {
    [site]: chooserPage('<a id="provider" href="javascript:chooseProvider(\'corp\')">Company account</a>'),
  });
  const inspection = await inspect(page, chooserStep, [site]);
  expect(inspection).toMatchObject({
    outcome: "refused",
    reason: "credential_target_refused",
    target: "submit",
    failureDetail: { context: { check: "destination", part: "submit_destination" } },
  });
  expectOriginsOnly(inspection);
  expect(posts).toEqual([]);
});

test("a sign-in step that types nothing is refused a do-nothing link in a form whose script action does something once something was typed on the browser", async ({
  page,
}) => {
  const { posts } = await serve(page, {
    [site]: chooserPage(
      `<form action="javascript:send()"><a id="provider" href="javascript:void(0)" onclick="chooseProvider('corp')">Company account</a></form>`,
    ),
  });
  const inspection = await inspect(page, chooserStep, [site]);
  expect(inspection).toMatchObject({
    outcome: "refused",
    reason: "credential_target_refused",
    target: "submit",
    failureDetail: { context: { check: "destination", part: "submit_destination" } },
  });
  expectOriginsOnly(inspection);
  expect(posts).toEqual([]);
});

// The host's sign-in browser reads the browser's shared record of typing as it stands at each
// inspection, so a card fill on the same browser after the sign-in browser was made counts too.
test("a sign-in step that types nothing is refused a script link once a card fill typed on the browser", async ({
  page,
}) => {
  const { posts } = await serve(page, {
    [site]: `<label>Card number<input id="card" name="card" autocomplete="cc-number" inputmode="numeric"></label>
${chooserPage('<a id="provider" href="javascript:chooseProvider(\'corp\')">Company account</a>')}`,
  });
  const host = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const typing: SessionTyping = { typed: false };
  const signIn = makeSignInBrowser({
    page: host,
    keyboard,
    siteOrigin: site,
    authenticationOrigins: [],
    typing,
  });
  const handles = makeSecretHandles();
  const answers = handles.issue(
    { number: { type: "secret", value: "4242424242424242" } },
    { number: "card_number" },
  );
  const handle = answers["number"];
  if (handle?.type !== "secret") throw new Error("Not a secret");
  const filled = await Effect.runPromise(
    runCardFill({
      step: { fields: [{ selector: "#card", handle: handle.value }] },
      handles,
      page: host,
      keyboard,
      siteOrigin: site,
      review: () => Effect.void,
      // As the local host's card fill does: the browser's shared record of typing.
      beforeTyping: () =>
        Effect.sync(() => {
          typing.typed = true;
        }),
    }),
  );
  expect(filled).toMatchObject({ status: "filled" });
  expect(typing.typed).toBe(true);
  const inspection = await Effect.runPromise(signIn.inspect(chooserStep));
  expect(inspection).toMatchObject({
    outcome: "refused",
    reason: "credential_target_refused",
    target: "submit",
    failureDetail: { context: { check: "destination", part: "submit_destination" } },
  });
  expect(posts).toEqual([]);
});

for (const [name, body, step, evidence] of [
  [
    "a sign-in step that types nothing whose script link sits in a frame off the site",
    `<iframe src="${otherSite}/choose"></iframe>`,
    chooserStep,
    { part: "frame", frameOrigin: otherSite },
  ],
  [
    "a sign-in step that types nothing whose script link sits in a form that posts off the site",
    `<form action="https://other.test/receive"><a id="provider" href="javascript:chooseProvider('corp')">Company account</a></form>`,
    chooserStep,
    { part: "submit_destination", actionOrigins: "https://other.test javascript:" },
  ],
  [
    "a sign-in step that types a username and submits with a link whose address runs a script",
    `<label>Email<input id="username" name="username" autocomplete="username"></label>
<a id="provider" href="javascript:chooseProvider('corp')">Continue</a>`,
    { fields: [{ selector: "#username", accepts: ["username"], slot: "username" }], submit: "#provider" },
    { part: "submit_destination", actionOrigins: "javascript:" },
  ],
  [
    "a card-fill step whose submit link's own address is a script that does nothing",
    `<label>Card number<input id="card" name="card" autocomplete="cc-number" inputmode="numeric"></label>
${headerLink("javascript:void(0);")}`,
    { fields: [{ selector: "#card", slot: "card_number" }], submit: "a.sign-in-link" },
    { actionOrigins: "javascript:" },
  ],
] as const)
  test(`${name} is refused before anything is typed`, async ({ page }) => {
    const { posts } = await serve(page, {
      [site]: body,
      [otherSite]: chooserPage(
        '<a id="provider" href="javascript:chooseProvider(\'corp\')">Company account</a>',
      ),
    });
    const scope = body.includes("<iframe") ? page.frameLocator("iframe") : page;
    await expect(scope.locator(step.submit ?? "")).toBeVisible();
    const inspection = await inspect(page, step);
    expect(inspection).toMatchObject({
      outcome: "refused",
      reason: "credential_target_refused",
      target: "submit",
      failureDetail: {
        phase: "destination",
        context: { check: "destination", part: "submit_destination", ...evidence },
      },
    });
    expectOriginsOnly(inspection);
    for (const { selector } of step.fields) expect(await page.locator(selector).inputValue()).toBe("");
    expect(posts).toEqual([]);
  });

test("a sign-in step whose typing turns its submit link's script into one that does something is refused before the password is typed", async ({
  page,
}) => {
  const { posts } = await serve(page, {
    [site]: `<label>Email<input id="username" name="username" autocomplete="username"></label>
<label>Password<input id="password" name="password" type="password" autocomplete="current-password"></label>
<a id="continue" href="javascript:void(0)">Log in</a>
<script>document.getElementById('username').addEventListener('input', () => {
  document.getElementById('continue').href = 'javascript:void(send())';
});</script>`,
  });
  const inspection = passed(await inspect(page));
  const report = await fill(page, inspection);
  expect(report).toMatchObject({
    outcome: "filled",
    fields: [
      { slot: "username", status: "filled" },
      { slot: "password", status: "failed" },
    ],
    submit: "not_attempted",
    failureDetail: { context: { check: "destination", part: "submit_destination" } },
  });
  expectOriginsOnly(report);
  expect(await page.locator("#password").inputValue()).toBe("");
  expect(posts).toEqual([]);
});
