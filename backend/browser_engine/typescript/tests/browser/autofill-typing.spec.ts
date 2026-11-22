import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import { inspectAutofillStep, type AutofillStep } from "../../src/destinations/autofill-step.js";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import type { CredentialTypingMode } from "../../src/destinations/credential-keyboard.js";
import { expectOriginsOnly, hostKeyboard, hostPage } from "./autofill-host-page.js";

// The host types an autofill step's values itself, over its own DevTools session, into the field a
// Kernel call focused. Chromium must generate trusted input events
// and establish where native insertion lands when a page moves focus or navigates.
const site = "https://login.example.test";
const username = "Sy.n!";
const password = "p@9x";

/** Serves the screen and keeps each form the site receives. */
const serve = async (page: Page, screen: string) => {
  const received: URLSearchParams[] = [];
  await page.route(`${site}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      received.push(new URLSearchParams(request.postData() ?? ""));
      await route.fulfill({ contentType: "text/html", body: "<p>Signed in</p>" });
    } else
      await route.fulfill({
        contentType: "text/html",
        body: `<form action="/session" method="post">${screen}<button>Sign in</button></form>`,
      });
  });
  await page.goto(`${site}/login`);
  return received;
};

const loginStep: AutofillStep = {
  fields: [
    { selector: "input[name=username]", slot: "username", accepts: ["username"] },
    { selector: "input[name=password]", slot: "password" },
  ],
  submit: 'button:text-is("Sign in")',
};
const loginScreen = `<label>Username<input name="username" autocomplete="username"></label>
<label>Password<input name="password" type="password" autocomplete="current-password"></label>`;

test("Kernel isolated locator evaluation still sends credentials by trusted native input", async ({
  page,
}) => {
  const received = await serve(page, loginScreen);
  const inputs: { readonly name: string; readonly trusted: boolean }[] = [];
  await page.exposeFunction(
    "reportInput",
    (event: { name: string; trusted: boolean }) => void inputs.push(event),
  );
  await page.evaluate(() => {
    const report: unknown = Reflect.get(window, "reportInput");
    if (typeof report !== "function") throw new Error("Fixture input reporter missing");
    document.addEventListener("input", (event) => {
      if (event.target instanceof HTMLInputElement)
        Reflect.apply(report, window, [{ name: event.target.name, trusted: event.isTrusted }]);
    });
  });
  const report = await signIn(page, loginStep, "paste");
  expect(received.map((form) => Object.fromEntries(form))).toEqual([{ username, password }]);
  expect(inputs).toHaveLength(2);
  expect(inputs).toEqual(
    expect.arrayContaining([
      { name: "username", trusted: true },
      { name: "password", trusted: true },
    ]),
  );
  expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
});

const signIn = async (page: Page, step: AutofillStep, typing: CredentialTypingMode) => {
  const host = await hostPage(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step, page: host, siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error(`Refused: ${inspection.reason}`);
  const { keyboard } = await hostKeyboard(page);
  return Effect.runPromise(
    fillAutofillStep({
      step,
      values: [username, password],
      inspection,
      page: host,
      keyboard,
      typing,
      settleMs: 2_000,
    }),
  );
};

type SeenKey = {
  readonly type: string;
  readonly key: string;
  readonly field: string;
  readonly trusted: boolean;
  readonly at: number;
};

/** Every key event the page's inputs see, kept on the test's side across the submit. */
const watchKeys = async (page: Page) => {
  const seen: SeenKey[] = [];
  await page.exposeFunction("reportKey", (key: SeenKey) => void seen.push(key));
  await page.evaluate(() => {
    const report: unknown = Reflect.get(window, "reportKey");
    if (typeof report !== "function") throw new Error("The key reporter is missing");
    for (const type of ["keydown", "keyup"])
      document.addEventListener(
        type,
        (event) => {
          if (!(event instanceof KeyboardEvent) || !(event.target instanceof HTMLInputElement))
            return;
          Reflect.apply(report, window, [
            {
              type,
              key: event.key,
              field: event.target.name,
              trusted: event.isTrusted,
              at: event.timeStamp,
            },
          ]);
        },
        true,
      );
  });
  return seen;
};

test("a keyboard request refuses before clearing, focusing or transferring any value", async ({
  page,
}) => {
  const received = await serve(page, loginScreen);
  await page.locator("input[name=username]").fill("existing-username");
  await page.locator("input[name=password]").fill("existing-password");
  await page.evaluate(
    () => document.activeElement instanceof HTMLElement && document.activeElement.blur(),
  );
  const report = await signIn(page, loginStep, "keyboard");
  expect(report).toMatchObject({ outcome: "refused", reason: "typing_unavailable" });
  expect(await page.locator("input[name=username]").inputValue()).toBe("existing-username");
  expect(await page.locator("input[name=password]").inputValue()).toBe("existing-password");
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
  expect(received).toEqual([]);
});

test("the paste mode inserts each value with no key events", async ({ page }) => {
  const received = await serve(page, loginScreen);
  const seen = await watchKeys(page);
  const inputs: { readonly field: string; readonly trusted: boolean }[] = [];
  await page.exposeFunction(
    "reportInput",
    (input: { field: string; trusted: boolean }) => void inputs.push(input),
  );
  await page.evaluate(() => {
    const report: unknown = Reflect.get(window, "reportInput");
    if (typeof report !== "function") throw new Error("Input reporter missing");
    document.addEventListener("input", (event) => {
      if (event.target instanceof HTMLInputElement)
        Reflect.apply(report, window, [{ field: event.target.name, trusted: event.isTrusted }]);
    });
  });
  const report = await signIn(page, loginStep, "paste");
  expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
  expect(received.map((form) => Object.fromEntries(form))).toEqual([{ username, password }]);
  expect(seen).toEqual([]);
  expect(inputs).toEqual([
    { field: "username", trusted: true },
    { field: "password", trusted: true },
  ]);
});

test("typing that a page sends to another field is never submitted", async ({ page }) => {
  // The page moves focus off the password field to another input as soon as it is focused.
  const received = await serve(
    page,
    `${loginScreen.replace(
      'autocomplete="current-password"',
      `autocomplete="current-password" onfocus="setTimeout(() => document.getElementById('other').focus(), 0)"`,
    )}<input id="other" name="other" aria-label="Other">`,
  );
  const report = await signIn(page, loginStep, "paste");
  expect(report).toMatchObject({
    outcome: "filled",
    fields: [
      { slot: "username", status: "filled" },
      { slot: "password", status: "failed" },
    ],
    submit: "not_attempted",
  });
  expect(await page.locator("#other").inputValue()).toBe("");
  expect(received).toEqual([]);
});

test("refuses typing after the checked page navigated to an unapproved origin", async ({
  page,
}) => {
  const allowed = "https://login.allowed.test";
  const elsewhere = "https://unapproved.test";
  await page.route("https://**/*", (route) =>
    route.fulfill({ contentType: "text/html", body: '<input id="password" type="password">' }),
  );
  await page.goto(allowed);
  const step = { fields: [{ slot: "password" as const, selector: "#password" }] };
  const host = await hostPage(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step, page: host, siteOrigin: allowed, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error("Initial inspection refused");
  const { keyboard } = await hostKeyboard(page);
  const faultedKeyboard = {
    ...keyboard,
    insertText: (target: Parameters<typeof keyboard.insertText>[0], text: string) =>
      Effect.promise(async () => {
        // The checked site navigates while its focus reply travels back to the host.
        await page.evaluate((url) => {
          location.href = url;
        }, elsewhere);
        await page.waitForURL(elsewhere + "/");
        await page.locator("#password").focus();
      }).pipe(Effect.zipRight(keyboard.insertText(target, text))),
  };
  await Effect.runPromise(
    fillAutofillStep({
      step,
      values: ["synthetic-fixture-value"],
      inspection,
      page: host,
      keyboard: faultedKeyboard,
      typing: "paste",
    }),
  );
  expect(await page.locator("#password").inputValue()).toBe("");
});

test("replacing the bound field before insertion leaves the replacement empty", async ({
  page,
}) => {
  await serve(page, loginScreen);
  const step: AutofillStep = { fields: [{ selector: "input[name=password]", slot: "password" }] };
  const host = await hostPage(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step, page: host, siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error("Initial inspection refused");
  const { keyboard } = await hostKeyboard(page);
  const report = await Effect.runPromise(
    fillAutofillStep({
      step,
      values: [password],
      inspection,
      page: host,
      keyboard: {
        insertText: (target, text) =>
          Effect.promise(async () => {
            await page.evaluate(() => {
              const original = document.querySelector("input[name=password]");
              if (!(original instanceof HTMLInputElement)) throw new Error("Fixture field missing");
              const replacement = original.cloneNode(true);
              original.replaceWith(replacement);
              if (replacement instanceof HTMLInputElement) replacement.focus();
            });
          }).pipe(Effect.zipRight(keyboard.insertText(target, text))),
      },
    }),
  );
  expect(report).toMatchObject({
    outcome: "refused",
    reason: "credential_target_refused",
    failureDetail: { context: { check: "typing_refused", insertion: "binding_not_in_world" } },
  });
  expect(await page.locator("input[name=password]").inputValue()).toBe("");
});

// Chromium decides the bound field's document and focus state at the moment of insertion.
for (const { cause, fault } of [
  { cause: "focus_moved", fault: () => document.getElementById("other")?.focus() },
  {
    cause: "detached",
    fault: () => document.querySelector("input[name=password]")?.remove(),
  },
] as const)
  test(`a native insertion refused as ${cause} says so, naming no binding, selector or value`, async ({
    page,
  }) => {
    const received = await serve(page, `${loginScreen}<input id="other" aria-label="Other">`);
    const step: AutofillStep = {
      fields: [{ selector: "input[name=password]", slot: "password" }],
    };
    const host = await hostPage(page);
    const inspection = await Effect.runPromise(
      inspectAutofillStep({ step, page: host, siteOrigin: site, authenticationOrigins: [] }),
    );
    if ("outcome" in inspection) throw new Error("Fixture inspection refused");
    const { keyboard } = await hostKeyboard(page, () => page.evaluate(fault));
    const report = await Effect.runPromise(
      fillAutofillStep({ step, values: [password], inspection, page: host, keyboard }),
    );
    expect(report).toMatchObject({
      outcome: "refused",
      reason: "credential_target_refused",
      target: 0,
      failureDetail: {
        phase: "typing_refused",
        context: { check: "typing_refused", insertion: cause, documentOrigin: site },
      },
    });
    expectOriginsOnly(report);
    const recorded = JSON.stringify(report);
    for (const secret of [password, "__opengpt_autofill_", step.fields[0]?.selector ?? ""])
      expect(recorded).not.toContain(secret);
    expect(await page.locator("#other").inputValue()).toBe("");
    expect(received).toEqual([]);
  });

test("a page cannot copy a credential binding onto a replacement control", async ({ page }) => {
  const received = await serve(page, loginScreen);
  await page.evaluate(() => {
    new MutationObserver((records) => {
      for (const record of records) {
        const key = record.attributeName;
        const original = record.target;
        if (
          key === null ||
          !key.startsWith("__opengpt_autofill_") ||
          !(original instanceof HTMLInputElement) ||
          !original.isConnected ||
          !original.hasAttribute(key)
        )
          continue;
        const replacement = original.cloneNode(true);
        Object.defineProperty(replacement, key, {
          value: Reflect.get(original, key),
          configurable: true,
        });
        original.replaceWith(replacement);
        if (replacement instanceof HTMLInputElement) replacement.focus();
      }
    }).observe(document, { subtree: true, attributes: true });
  });
  const step: AutofillStep = {
    fields: [{ selector: "input[name=username]", slot: "username", accepts: ["username"] }],
  };
  const host = await hostPage(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step, page: host, siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error("Initial inspection refused");
  const { keyboard } = await hostKeyboard(page);
  const report = await Effect.runPromise(
    fillAutofillStep({
      step,
      values: [username],
      inspection,
      page: host,
      keyboard,
      typing: "paste",
    }),
  );
  expect(await page.locator("input[name=username]").inputValue()).toBe("");
  expect(received).toEqual([]);
  expect(report).toMatchObject({ outcome: "refused", reason: "credential_target_refused" });
});

test("beforeinput moving focus does not redirect the native insertion", async ({ page }) => {
  await serve(page, `${loginScreen}<input id="other">`);
  await page.locator("input[name=password]").evaluate((element) => {
    element.addEventListener("beforeinput", () => document.getElementById("other")?.focus());
  });
  const step: AutofillStep = { fields: [{ selector: "input[name=password]", slot: "password" }] };
  const host = await hostPage(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step, page: host, siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error("Fixture inspection refused");
  const { keyboard } = await hostKeyboard(page);
  const report = await Effect.runPromise(
    fillAutofillStep({ step, values: [password], inspection, page: host, keyboard }),
  );
  expect(await page.locator("#other").inputValue()).toBe("");
  const held = await page.locator("input[name=password]").inputValue();
  if (held === "") expect(report.outcome).toBe("refused");
  else expect(held).toBe(password);
});

for (const kind of ["srcdoc", "blank", "approved cross-origin"] as const) {
  test(`atomic insertion preserves a login in an ${kind} frame`, async ({ page }) => {
    const authOrigin = "https://approved-sign-in.test";
    await page.route(`${site}/**`, (route) =>
      route.fulfill({ contentType: "text/html", body: '<iframe id="login"></iframe>' }),
    );
    await page.route(`${authOrigin}/**`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<input id="frame-password" type="password">',
      }),
    );
    await page.goto(site);
    const frameElement = page.locator("#login");
    if (kind === "srcdoc")
      await frameElement.evaluate((element) =>
        element.setAttribute("srcdoc", '<input id="frame-password" type="password">'),
      );
    if (kind === "approved cross-origin")
      await frameElement.evaluate(
        (element, origin) => element.setAttribute("src", origin),
        authOrigin,
      );
    const frame = await (await frameElement.elementHandle())?.contentFrame();
    if (!frame) throw new Error("Fixture frame missing");
    if (kind === "blank")
      await frame.evaluate(() => {
        document.body.innerHTML = '<input id="frame-password" type="password">';
      });
    await frame.locator("#frame-password").waitFor();
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
    if ("outcome" in inspection)
      throw new Error(`Initial fixture inspection refused: ${inspection.reason}`);
    const { keyboard } = await hostKeyboard(page);
    const report = await Effect.runPromise(
      fillAutofillStep({ step, values: [password], inspection, page: host, keyboard }),
    );
    expect(report).toMatchObject({
      outcome: "filled",
      fields: [{ slot: "password", status: "filled" }],
    });
    expect(await frame.locator("#frame-password").inputValue()).toBe(password);
  });
}

test("refuses an opaque sandboxed login frame before value transfer", async ({ page }) => {
  await page.route(`${site}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<iframe sandbox="allow-scripts" srcdoc="&lt;input id=frame-password type=password&gt;"></iframe>',
    }),
  );
  await page.goto(site);
  const frame = page.frames().find((frame) => frame !== page.mainFrame());
  if (!frame) throw new Error("Fixture frame missing");
  await frame.locator("#frame-password").waitFor();
  const host = await hostPage(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({
      step: { fields: [{ selector: "#frame-password", slot: "password" }] },
      page: host,
      siteOrigin: site,
      authenticationOrigins: [],
    }),
  );
  expect(inspection).toMatchObject({ outcome: "refused" });
  expect(await frame.locator("#frame-password").inputValue()).toBe("");
});

const chat = "https://chat.widgets.test";
// A third-party widget's frame can hold a match for the step's selector; the refusal says where.
for (const [where, pageField, reason, evidence] of [
  [
    "only in a third-party frame",
    "",
    "credential_target_refused",
    {
      check: "destination",
      part: "frame",
      frameOrigin: chat,
      documentOrigin: chat,
      matchFrameOrigin: chat,
      framesSearched: 2,
      pageOrigin: site,
    },
  ],
  [
    "in the page and a third-party frame",
    '<input name="username" aria-label="Username">',
    "ambiguous_match",
    {
      check: "ambiguous_match",
      framesSearched: 2,
      matches: `${site} 1/1, ${chat} 1/1`,
      pageOrigin: site,
    },
  ],
] as const)
  test(`a field matched ${where} is refused, naming the frames' origins`, async ({ page }) => {
    await page.route(`${site}/**`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `${pageField}<iframe src="${chat}/embed/visitor?session=synthetic"></iframe>`,
      }),
    );
    await page.route(`${chat}/**`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<input name="username" aria-label="Chat">',
      }),
    );
    await page.goto(`${site}/login?next=%2Faccount`);
    await page.frameLocator("iframe").locator("input[name=username]").waitFor();
    const report = await Effect.runPromise(
      inspectAutofillStep({
        step: {
          fields: [{ selector: "input[name=username]", slot: "username", accepts: ["username"] }],
        },
        page: await hostPage(page),
        siteOrigin: site,
        authenticationOrigins: [],
      }),
    );
    expect(report).toMatchObject({
      outcome: "refused",
      reason,
      target: 0,
      failureDetail: { phase: evidence.check, context: evidence },
    });
    expectOriginsOnly(report);
  });

test("a field that hands its focus to another element is refused, naming that element", async ({
  page,
}) => {
  const received = await serve(
    page,
    `<label>Password<input name="password" type="password" onfocus="document.getElementById('other').focus()"></label>
<input id="other" aria-label="Other">`,
  );
  const step: AutofillStep = { fields: [{ selector: "input[name=password]", slot: "password" }] };
  const host = await hostPage(page);
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step, page: host, siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error(`Fixture inspection refused: ${inspection.reason}`);
  const { keyboard } = await hostKeyboard(page);
  const report = await Effect.runPromise(
    fillAutofillStep({ step, values: [password], inspection, page: host, keyboard }),
  );
  expect(report).toMatchObject({
    outcome: "refused",
    reason: "credential_target_refused",
    target: 0,
    failureDetail: {
      phase: "not_focused",
      context: {
        check: "not_focused",
        activeTag: "input",
        frameOrigin: site,
        documentOrigin: site,
        actionOrigins: site,
        pageOrigin: site,
        matchFrameOrigin: site,
        framesSearched: 1,
      },
    },
  });
  expectOriginsOnly(report);
  expect(await page.locator("#other").inputValue()).toBe("");
  expect(received).toEqual([]);
});

// Chromium establishes real child targets; the provider fixture must retain their opener identity.
for (const state of ["authorized", "ambiguous", "replaced", "closed"] as const) {
  test(`the isolated host preserves ${state} authentication popup authority`, async ({ page }) => {
    const received: URLSearchParams[] = [];
    await page.context().route(`${site}/**`, async (route) => {
      if (route.request().method() === "POST") {
        received.push(new URLSearchParams(route.request().postData() ?? ""));
        await route.fulfill({ contentType: "text/html", body: "<p>Signed in</p>" });
      } else
        await route.fulfill({
          contentType: "text/html",
          body: `<form action="/session" method="post">${loginScreen}<button>Sign in</button></form>`,
        });
    });
    await page.goto(`${site}/login`);
    const open = async () => {
      const opened = page.waitForEvent("popup");
      await page.evaluate(() => window.open("/popup-form"));
      const popup = await opened;
      await popup.waitForLoadState("domcontentloaded");
      return popup;
    };
    const popup = await open();
    if (state === "ambiguous") await open();
    const host = await hostPage(page);
    const step: AutofillStep = {
      ...loginStep,
      popup: { opener: "primary", origin: site },
    };
    const inspection = await Effect.runPromise(
      inspectAutofillStep({ step, page: host, siteOrigin: site, authenticationOrigins: [] }),
    );
    if (state === "ambiguous") {
      expect(inspection).toMatchObject({ outcome: "refused", reason: "popup_ambiguous" });
      for (const candidate of page.context().pages())
        expect(await candidate.locator("input[name=username]").inputValue()).toBe("");
      expect(received).toEqual([]);
      return;
    }
    if ("outcome" in inspection) throw new Error(`Refused: ${inspection.reason}`);
    let replacement: Page | undefined;
    if (state === "closed" || state === "replaced") {
      await popup.close();
      if (state === "replaced") replacement = await open();
    }
    const { keyboard } = await hostKeyboard(state === "authorized" ? popup : page);
    const report = await Effect.runPromise(
      fillAutofillStep({
        step,
        values: [username, password],
        inspection,
        page: host,
        keyboard,
        settleMs: 500,
      }),
    );
    if (state === "authorized") {
      expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
      expect(received.map((form) => Object.fromEntries(form))).toEqual([{ username, password }]);
    } else {
      expect(report).toMatchObject({
        outcome: "refused",
        reason: state === "replaced" ? "credential_target_refused" : "popup_missing",
        target: "popup",
      });
      expect(received).toEqual([]);
      if (replacement !== undefined) {
        expect(await replacement.locator("input[name=username]").inputValue()).toBe("");
        expect(await replacement.locator("input[name=password]").inputValue()).toBe("");
      }
    }
  });
}
