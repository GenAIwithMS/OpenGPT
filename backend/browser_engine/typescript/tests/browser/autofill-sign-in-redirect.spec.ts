import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import {
  inspectAutofillStep,
  type AutofillInspection,
  type AutofillStep,
  type FillSlot,
  type SignInRedirect,
  type SiteNavigation,
} from "../../src/destinations/autofill-step.js";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import { expectOriginsOnly, hostKeyboard, hostPage } from "./autofill-host-page.js";

// A sign-in whose site moves to another host after the username screen, such as a sign-in
// service on another registrable domain, keeps the trust its host gave the first screen along the
// redirect the site itself starts from that screen's submit, once the host's review of the new
// host says yes. A page that something else navigated since, or a review that says no, carries
// nothing, and the password screen there is refused as before.
const site = "https://login.example.net";
const signInService = "https://auth.example.org";
const username = "synthetic-redirect-user";
const password = "synthetic-redirect-password";

const usernameStep: AutofillStep = {
  fields: [{ selector: "#username", slot: "username", accepts: ["username"] }],
  submit: "#next",
};
const passwordStep: AutofillStep = {
  fields: [{ selector: "#password", slot: "password" }],
  submit: "#sign-in",
};

const usernamePage = `<form method="post" action="/identify">
<label>Email<input id="username" name="username" autocomplete="username"></label>
<button id="next" type="submit">Next</button>
</form>`;
const passwordPage = (action = "/session") => `<title>Sign in</title>
<form method="post" action="${action}">
<label>Password<input id="password" name="password" type="password" autocomplete="current-password"></label>
<button id="sign-in" type="submit">Sign in</button>
</form>`;

/**
 * Serves the site's username screen, whose submit the site answers with a redirect to the sign-in
 * service's password screen, and keeps every POST with its origin. Playwright's own routes see only
 * a redirect chain's first request, so the pages are served through DevTools' request interception,
 * which sees each one.
 */
const serve = async (
  page: Page,
  options: {
    readonly redirectTo?: string;
    readonly passwordAction?: string;
    /** The username screen's own address, past its origin. */
    readonly loginPath?: string;
  } = {},
) => {
  const redirectTo = options.redirectTo ?? `${signInService}/password`;
  const posts: { readonly origin: string; readonly form: URLSearchParams }[] = [];
  const session = await page.context().newCDPSession(page);
  const answer = (status: number, headers: Record<string, string>, body = "") => ({
    responseCode: status,
    responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })),
    body: Buffer.from(body).toString("base64"),
  });
  session.on("Fetch.requestPaused", ({ requestId, request }) => {
    const { origin } = new URL(request.url);
    const html = (body: string) => answer(200, { "content-type": "text/html" }, body);
    let response;
    if (request.method === "POST") {
      posts.push({ origin, form: new URLSearchParams(request.postData ?? "") });
      response =
        origin === site
          ? answer(302, { location: redirectTo })
          : html("<p>Signed in</p>");
    } else if (origin === site) response = html(usernamePage);
    else if (origin === new URL(redirectTo).origin)
      response = html(passwordPage(options.passwordAction));
    else response = answer(404, {});
    void session.send("Fetch.fulfillRequest", { requestId, ...response }).catch(() => undefined);
  });
  await session.send("Fetch.enable", { patterns: [{ urlPattern: "https://*" }] });
  await page.goto(`${site}${options.loginPath ?? "/login"}`);
  return posts;
};

const inspect = async (
  page: Page,
  step: AutofillStep<FillSlot>,
  redirect?: Parameters<typeof inspectAutofillStep>[0]["redirect"],
) =>
  Effect.runPromise(
    inspectAutofillStep({
      step,
      page: await hostPage(page),
      siteOrigin: site,
      authenticationOrigins: [],
      ...(redirect === undefined ? {} : { redirect }),
    }),
  );

const fill = async (
  page: Page,
  step: AutofillStep,
  inspection: AutofillInspection,
  values: readonly string[],
  /** What the sign-in typed before, none by default; `unsaid` when the host does not say. */
  typedBefore: readonly string[] | "unsaid" = [],
) =>
  Effect.runPromise(
    fillAutofillStep({
      step,
      values,
      ...(typedBefore === "unsaid" ? {} : { typedBefore }),
      inspection,
      page: await hostPage(page),
      keyboard: (await hostKeyboard(page)).keyboard,
      settleMs: 1000,
    }),
  );

/** The inspection that passed, or a failure that names the check that refused it. */
const passed = (inspection: Awaited<ReturnType<typeof inspect>>) => {
  if (!("outcome" in inspection)) return inspection;
  const context: unknown = Reflect.get({ ...inspection.failureDetail }, "context");
  throw new Error(`Inspection refused: ${inspection.reason} ${JSON.stringify(context)}`);
};

/**
 * Types the username on the site's screen and submits it, with what the sign-in typed before
 * (`typedBefore`, none by default): where the site's redirect led, if the report names it.
 */
const submitUsername = async (page: Page, typedBefore?: readonly string[]) => {
  const inspection = passed(await inspect(page, usernameStep));
  const report = await fill(page, usernameStep, inspection, [username], typedBefore ?? []);
  expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
  await expect(page.locator("#password")).toBeVisible();
  const navigated: unknown = Reflect.get(report, "navigated");
  return navigated as SiteNavigation | undefined;
};

/** `submitUsername`'s navigation, which the test needs it to name. */
const named = (navigated: SiteNavigation | undefined) => {
  if (navigated === undefined) throw new Error("The click's report names no navigation");
  return navigated;
};

/** A review that answers `allow` and keeps what it was asked. */
const reviewing = (allow: boolean) => {
  const asked: SignInRedirect[] = [];
  return {
    asked,
    review: (redirect: SignInRedirect) =>
      Effect.sync(() => {
        asked.push(redirect);
        return allow;
      }),
  };
};

const refusedOffSite = {
  outcome: "refused",
  reason: "credential_target_refused",
  failureDetail: { phase: "destination", context: { check: "destination" } },
};

test("the click's report names where the site's own redirect led, and the password screen there is refused without a redirect to carry", async ({
  page,
}) => {
  await serve(page, { loginPath: "/login?step=identify" });
  const navigated = named(await submitUsername(page));
  expect(navigated).toEqual({
    from: site,
    fromPathname: "/login",
    origins: [site, signInService],
    document: expect.any(Number),
    pathname: "/password",
    title: "Sign in",
  });
  const inspection = await inspect(page, passwordStep);
  expect(inspection).toMatchObject(refusedOffSite);
  expectOriginsOnly(inspection);
});

test("a sign-in keeps its trust along the redirect the site starts from its trusted screen once the review says yes", async ({
  page,
}) => {
  const posts = await serve(page);
  const navigated = named(await submitUsername(page));
  const { asked, review } = reviewing(true);
  const inspection = passed(
    await inspect(page, passwordStep, { from: `${site}/login`, navigated, review }),
  );
  expect(asked).toEqual([
    {
      from: site,
      fromPathname: "/login",
      candidate: signInService,
      candidatePathname: "/password",
      candidateTitle: "Sign in",
      chain: [site, signInService],
    },
  ]);
  expect(inspection.carriedSignInOrigin).toBe(signInService);
  const report = await fill(page, passwordStep, inspection, [password]);
  expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
  await expect.poll(() => posts.length).toBe(2);
  expect(posts.map(({ origin, form }) => [origin, [...form.values()]])).toEqual([
    [site, [username]],
    [signInService, [password]],
  ]);
});

test("a redirect the review does not trust carries nothing", async ({ page }) => {
  const posts = await serve(page);
  const navigated = named(await submitUsername(page));
  const { asked, review } = reviewing(false);
  const inspection = await inspect(page, passwordStep, { from: `${site}/login`, navigated, review });
  expect(asked).toHaveLength(1);
  expect(inspection).toMatchObject(refusedOffSite);
  expect(await page.locator("#password").inputValue()).toBe("");
  expect(posts.filter(({ origin }) => origin === signInService)).toEqual([]);
});

test("a page something else navigated since the site's redirect carries nothing, and the review is never asked", async ({
  page,
}) => {
  const posts = await serve(page);
  const navigated = named(await submitUsername(page));
  // Another navigation to the same address, as a step of the minter's own would make.
  await page.goto(`${signInService}/password`);
  const { asked, review } = reviewing(true);
  const inspection = await inspect(page, passwordStep, { from: `${site}/login`, navigated, review });
  expect(inspection).toMatchObject(refusedOffSite);
  expect(asked).toEqual([]);
  expect(posts.filter(({ origin }) => origin === signInService)).toEqual([]);
});

test("a redirect from a screen the sign-in never trusted carries nothing", async ({ page }) => {
  await serve(page);
  const navigated = named(await submitUsername(page));
  const { asked, review } = reviewing(true);
  const inspection = await inspect(page, passwordStep, {
    from: "https://elsewhere.example.com/login",
    navigated,
    review,
  });
  expect(inspection).toMatchObject(refusedOffSite);
  expect(asked).toEqual([]);
});

test("a redirect to a host whose name holds what the step typed is never reported", async ({
  page,
}) => {
  await serve(page, { redirectTo: `https://${username}.example.org/password` });
  expect(await submitUsername(page)).toBeUndefined();
});

test("a redirect whose new page sends the password to a third host carries nothing, and the review is never asked", async ({
  page,
}) => {
  const third = "https://third.example.com";
  const posts = await serve(page, { passwordAction: `${third}/session` });
  const navigated = named(await submitUsername(page));
  const { asked, review } = reviewing(true);
  const inspection = await inspect(page, passwordStep, { from: `${site}/login`, navigated, review });
  expect(inspection).toMatchObject(refusedOffSite);
  expect(asked).toEqual([]);
  expect(await page.locator("#password").inputValue()).toBe("");
  expect(posts.filter(({ origin }) => origin !== site)).toEqual([]);
});

test("a username screen whose own address names the host its submit went to never reports where it went", async ({
  page,
}) => {
  // An open redirect's parameter, not the site's own sign-in, chose that host.
  await serve(page, {
    loginPath: `/login?next=${encodeURIComponent(`${signInService}/password`)}`,
  });
  expect(await submitUsername(page)).toBeUndefined();
});

test("a redirect to a host whose name holds a value typed on an earlier screen, split across its labels, is never reported", async ({
  page,
}) => {
  await serve(page, { redirectTo: "https://synthetic-ear.lier.example.org/password" });
  expect(await submitUsername(page, ["synthetic-earlier"])).toBeUndefined();
});

test("a fill whose host does not say what the sign-in typed before never reports where the page went", async ({
  page,
}) => {
  await serve(page);
  const inspection = passed(await inspect(page, usernameStep));
  const report = await fill(page, usernameStep, inspection, [username], "unsaid");
  expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
  await expect(page.locator("#password")).toBeVisible();
  expect(report).not.toHaveProperty("navigated");
});

test("a popup step never carries, and the review is never asked", async ({ page }) => {
  await serve(page);
  const navigated = named(await submitUsername(page));
  // The popup's requests are its own page's, so a route serves them.
  await page.context().route(`${signInService}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: passwordPage() }),
  );
  const opened = page.waitForEvent("popup");
  await page.evaluate((url) => window.open(url), `${signInService}/password`);
  await (await opened).waitForLoadState("domcontentloaded");
  const { asked, review } = reviewing(true);
  const inspection = await inspect(
    page,
    { ...passwordStep, popup: { opener: "primary", origin: signInService } },
    { from: `${site}/login`, navigated, review },
  );
  expect(inspection).toMatchObject({ outcome: "refused" });
  expect(asked).toEqual([]);
});
