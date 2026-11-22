import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import {
  inspectAutofillStep,
  type AutofillInspection,
  type AutofillStep,
} from "../../src/destinations/autofill-step.js";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import { rememberTyping } from "../../src/destinations/autofill-typed-page.js";
import { expectOriginsOnly, hostKeyboard, hostPage } from "./autofill-host-page.js";

// An identifier-first sign-in: the site takes the identifier, then hands off to a password screen
// on another host, which no inspection judged before anything was typed. A host whose user allowed
// the sign-in to go wherever the site sends it trusts that host with its own predicate
// (`trustSignInUrl`), and the inspection names it by origin (`trustedSignInOrigins`). Without the
// predicate, or on a host core never lets a predicate trust, the password screen is refused and
// the password goes nowhere. Chromium must follow the cross-site handoff after typing.
const site = "https://www.shop.example";
const signInHost = "https://login.example.net";
const email = "synthetic.user@mail.example.org";
const password = "p@9x!z";

const identifierStep: AutofillStep = {
  fields: [{ selector: "input[name=email]", slot: "email", accepts: ["email"] }],
  submit: 'button:text-is("Next")',
};
const passwordStep: AutofillStep = {
  fields: [{ selector: "input[name=password]", slot: "password" }],
  submit: 'button:text-is("Sign in")',
};

/**
 * Serves the site's identifier screen, which hands off to `handoff`'s password screen once it
 * receives the identifier, and keeps each form each of them receives.
 */
const serve = async (page: Page, handoff: string) => {
  const received = { site: [] as URLSearchParams[], handoff: [] as URLSearchParams[] };
  await page.route(`${site}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      received.site.push(new URLSearchParams(request.postData() ?? ""));
      await route.fulfill({
        contentType: "text/html",
        body: `<script>location.replace(${JSON.stringify(`${handoff}/u/password`)})</script>`,
      });
    } else
      await route.fulfill({
        contentType: "text/html",
        body: `<form action="/identify" method="post"><label>Email<input name="email" type="email" autocomplete="username"></label><button>Next</button></form>`,
      });
  });
  await page.route(`${handoff}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      received.handoff.push(new URLSearchParams(request.postData() ?? ""));
      await route.fulfill({ contentType: "text/html", body: "<p>Signed in</p>" });
    } else
      await route.fulfill({
        contentType: "text/html",
        body: `<form action="/session" method="post"><label>Password<input name="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form>`,
      });
  });
  await page.goto(`${site}/login`);
  return received;
};

/**
 * Types the identifier on the site, as a host's browser does, then inspects the password screen
 * the site handed off to, with `trustSignInUrl` when given. Returns that inspection and a fill of
 * the password into it.
 */
const afterIdentifier = async (
  page: Page,
  handoff: string,
  trustSignInUrl?: (url: URL) => boolean,
) => {
  const host = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const browser = rememberTyping({
    inspect: ({ step, judgedBeforeTyping }) =>
      inspectAutofillStep({
        step,
        page: host,
        siteOrigin: site,
        authenticationOrigins: [],
        judgedBeforeTyping,
        ...(trustSignInUrl === undefined ? {} : { trustSignInUrl }),
      }),
    fill: (input: {
      readonly step: AutofillStep;
      readonly values: readonly string[];
      readonly inspection: AutofillInspection;
    }) => fillAutofillStep({ ...input, page: host, keyboard, settleMs: 2_000 }),
  });
  const identifier = await Effect.runPromise(browser.inspect(identifierStep));
  if ("outcome" in identifier) throw new Error(`Refused: ${identifier.reason}`);
  expect(
    await Effect.runPromise(
      browser.fill({ step: identifierStep, values: [email], inspection: identifier }),
    ),
  ).toMatchObject({ outcome: "filled", submit: "clicked" });
  await page.waitForURL(`${handoff}/u/password`);
  const inspected = await Effect.runPromise(browser.inspect(passwordStep));
  return {
    inspected,
    fill: (inspection: AutofillInspection) =>
      Effect.runPromise(browser.fill({ step: passwordStep, values: [password], inspection })),
  };
};

test("signs in on the password screen's host the predicate trusts after the identifier was typed", async ({
  page,
}) => {
  const received = await serve(page, signInHost);
  const asked: string[] = [];
  const { inspected, fill } = await afterIdentifier(page, signInHost, (url) => {
    asked.push(url.origin);
    return true;
  });
  if ("outcome" in inspected) throw new Error(`Refused: ${inspected.reason}`);
  expect(inspected.trustedSignInOrigins).toEqual([signInHost]);
  expect(await fill(inspected)).toMatchObject({ outcome: "filled", submit: "clicked" });
  expect(received.site.map((form) => Object.fromEntries(form))).toEqual([{ email }]);
  expect(received.handoff.map((form) => Object.fromEntries(form))).toEqual([{ password }]);
  expect(new Set(asked)).toEqual(new Set([signInHost]));
});

test("refuses the password screen's host after the identifier was typed without a predicate", async ({
  page,
}) => {
  const received = await serve(page, signInHost);
  const { inspected } = await afterIdentifier(page, signInHost);
  expect(inspected).toMatchObject({ outcome: "refused", reason: "credential_target_refused" });
  expect(inspected).not.toHaveProperty("trustedSignInOrigins");
  expect(Reflect.get(inspected, "failureDetail")).toMatchObject({
    context: { check: "destination", frameOrigin: "other", pageOrigin: "other" },
  });
  expectOriginsOnly(inspected);
  expect(received.site).toHaveLength(1);
  expect(received.handoff).toEqual([]);
});

for (const [name, handoff] of [
  ["plain http", "http://login.example.net"],
  ["an IP address", "https://203.0.113.7"],
  ["a private network name", "https://login.corp.local"],
] as const)
  test(`refuses a password screen on ${name} after the identifier was typed whatever the predicate trusts`, async ({
    page,
  }) => {
    const received = await serve(page, handoff);
    const asked: string[] = [];
    const { inspected } = await afterIdentifier(page, handoff, (url) => {
      asked.push(url.origin);
      return true;
    });
    expect(inspected).toMatchObject({ outcome: "refused", reason: "credential_target_refused" });
    expect(inspected).not.toHaveProperty("trustedSignInOrigins");
    expect(Reflect.get(inspected, "failureDetail")).toMatchObject({
      context: { check: "destination", frameOrigin: "other" },
    });
    expect(asked).toEqual([]);
    expect(received.handoff).toEqual([]);
  });
