import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { chromium as patchright } from "patchright";
import { Effect } from "effect";
import { inspectAutofillStep, type AutofillStep } from "../../src/destinations/autofill-step.js";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import { hostKeyboard, hostPage } from "./autofill-host-page.js";

// A sign-in form inside a custom element's shadow root. Chromium retargets the document's focus to
// the outermost shadow host, so only a real browser shows whether the host still finds the field it
// focused, and refuses when the focus moves to a sibling in the same shadow root.
const site = "https://login.example.test";
const username = "Sy.n!";
const password = "p@9x";

/**
 * A `<x-login>` element whose shadow root, open or closed (`mode`), holds the whole form: inputs in
 * a shadow root belong to no form outside it. Beside the form, in the same shadow root, sits
 * another input. `nested` wraps it in another custom element's open shadow root.
 * `onPasswordFocus` runs as the password field takes the focus, with the field as `this`.
 */
const loginPage = ({ nested = false, mode = "open", onPasswordFocus = "" } = {}) => `<!doctype html>
<body>${nested ? "<x-outer></x-outer>" : "<x-login></x-login>"}
<script>
customElements.define("x-login", class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: "${mode}" });
    root.innerHTML = \`<form action="/session" method="post">
<label>Username<input name="username" autocomplete="username"></label>
<label>Password<input name="password" type="password" autocomplete="current-password"></label>
<button>Sign in</button></form>
<input name="other" aria-label="Other">\`;
    root.querySelector("input[name=password]").addEventListener("focus", function () { ${onPasswordFocus} });
  }
});
customElements.define("x-outer", class extends HTMLElement {
  connectedCallback() {
    this.attachShadow({ mode: "open" }).innerHTML = "<x-login></x-login>";
  }
});
</script></body>`;

/** Serves the page and keeps each form the site receives. */
const serve = async (page: Page, body: string) => {
  const received: URLSearchParams[] = [];
  await page.route(`${site}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      received.push(new URLSearchParams(request.postData() ?? ""));
      await route.fulfill({ contentType: "text/html", body: "<p>Signed in</p>" });
    } else await route.fulfill({ contentType: "text/html", body });
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

/** The value of the shadow root's `other` input, the sibling no credential may reach. */
const otherValue = (page: Page) => page.locator("input[name=other]").inputValue();

const fill = async (
  page: Page,
  step: AutofillStep,
  values: readonly string[],
  { beforeInsert, patchright = false }: { beforeInsert?: () => Promise<void>; patchright?: boolean } = {},
) => {
  const host = await hostPage(page, [], { patchright });
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step, page: host, siteOrigin: site, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error(`Fixture inspection refused: ${inspection.reason}`);
  const { keyboard } = await hostKeyboard(page, beforeInsert);
  return Effect.runPromise(
    fillAutofillStep({ step, values, inspection, page: host, keyboard, settleMs: 500 }),
  );
};

for (const nested of [false, true])
  test(`types and submits credentials in ${nested ? "nested open" : "an open"} shadow root`, async ({
    page,
  }) => {
    const received = await serve(page, loginPage({ nested }));
    const inputs: { readonly name: string; readonly trusted: boolean }[] = [];
    await page.exposeFunction(
      "reportInput",
      (event: { name: string; trusted: boolean }) => void inputs.push(event),
    );
    await page.evaluate(() => {
      const report: unknown = Reflect.get(window, "reportInput");
      if (typeof report !== "function") throw new Error("Fixture input reporter missing");
      // Input events are composed, so the composed path's first node is the shadow input.
      document.addEventListener("input", (event) => {
        const [target] = event.composedPath();
        if (target instanceof HTMLInputElement)
          Reflect.apply(report, window, [{ name: target.name, trusted: event.isTrusted }]);
      });
    });
    const report = await fill(page, loginStep, [username, password]);
    expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
    expect(received.map((form) => Object.fromEntries(form))).toEqual([
      { username, password },
    ]);
    expect(inputs).toEqual([
      { name: "username", trusted: true },
      { name: "password", trusted: true },
    ]);
  });

const passwordStep: AutofillStep = {
  fields: [{ selector: "input[name=password]", slot: "password" }],
};

test("a shadow field that hands its focus to a sibling in its shadow root is refused", async ({
  page,
}) => {
  const received = await serve(
    page,
    loginPage({ onPasswordFocus: 'this.getRootNode().querySelector("input[name=other]").focus();' }),
  );
  const report = await fill(page, passwordStep, [password]);
  expect(report).toMatchObject({
    outcome: "refused",
    reason: "credential_target_refused",
    target: 0,
    failureDetail: { phase: "not_focused", context: { check: "not_focused", activeTag: "input" } },
  });
  expect(await otherValue(page)).toBe("");
  expect(received).toEqual([]);
});

test("a native insertion into a shadow field refuses once a sibling took the focus", async ({
  page,
}) => {
  const received = await serve(page, loginPage());
  const report = await fill(page, passwordStep, [password], {
    beforeInsert: () =>
      page.locator("input[name=other]").evaluate((other: HTMLElement) => other.focus()),
  });
  expect(report).toMatchObject({
    outcome: "refused",
    reason: "credential_target_refused",
    target: 0,
    failureDetail: {
      phase: "typing_refused",
      context: { check: "typing_refused", insertion: "focus_moved" },
    },
  });
  expect(await otherValue(page)).toBe("");
  expect(await page.locator("input[name=password]").inputValue()).toBe("");
  expect(received).toEqual([]);
});

// Playwright's locators stop at a closed shadow root; Patchright's reach inside it.
test("types and submits credentials in a closed shadow root on Patchright", async () => {
  const browser = await patchright.launch({ headless: true });
  try {
    // Patchright's page has Playwright's API, declared by its own copy of Playwright's types.
    const page = (await browser.newPage()) as unknown as Page;
    const received = await serve(page, loginPage({ mode: "closed" }));
    const report = await fill(page, loginStep, [username, password], { patchright: true });
    expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
    expect(received.map((form) => Object.fromEntries(form))).toEqual([{ username, password }]);
  } finally {
    await browser.close();
  }
});
