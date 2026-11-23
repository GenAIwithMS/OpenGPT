import { expect, test } from "@playwright/test";
import type { Frame, Locator, Page } from "playwright";
import { Effect } from "effect";
import { inspectAutofillStep, type AutofillStep } from "../../src/destinations/autofill-step.js";
import { hostPage } from "./autofill-host-page.js";

// A page can take a frame away while a step call searches its frames, as an ad slot or a widget
// that reloads itself does. A frame that is gone holds nothing to type into, so the search skips it
// and reads the rest; any other failure still fails the call.
const site = "https://login.example.test";
const ads = "https://ads.widgets.test";

const loginStep: AutofillStep = {
  fields: [
    { selector: "input[name=username]", slot: "username", accepts: ["username"] },
    { selector: "input[name=password]", slot: "password" },
  ],
  submit: 'button:text-is("Sign in")',
};

/** Serves the sign-in page with an ad slot's frame, and waits for the frame's content. */
const serve = async (page: Page) => {
  await page.route(`${site}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<form action="/session" method="post">
<label>Username<input name="username"></label>
<label>Password<input name="password" type="password"></label>
<button>Sign in</button></form><iframe src="${ads}/slot"></iframe>`,
    }),
  );
  await page.route(`${ads}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<p>Sponsored</p>" }),
  );
  await page.goto(`${site}/login`);
  const frame = page.frames().find((each) => each !== page.mainFrame());
  if (!frame) throw new Error("Fixture frame missing");
  await frame.locator("p").waitFor();
  return frame;
};

/**
 * Fails the ad slot's frame on the first `count()` of the username field's locator in it. `detach`
 * takes the frame out of the page just before that call runs, so Playwright's own call fails as the
 * frame is gone; otherwise the call throws while the frame stays attached.
 */
const failFrame = (page: Page, frame: Frame, detach: boolean) => {
  const locate = frame.locator.bind(frame);
  let failed = false;
  const failing = (located: Locator): Locator =>
    new Proxy(located, {
      get: (target, property) => {
        if (property === "count")
          return async () => {
            if (!failed) {
              failed = true;
              if (!detach) throw new Error("Synthetic frame failure");
              const gone = page.waitForEvent("framedetached");
              await page.evaluate(() => document.querySelector("iframe")?.remove());
              await gone;
            }
            return target.count();
          };
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  Object.defineProperty(frame, "locator", {
    configurable: true,
    value: (selector: string, options?: Parameters<Frame["locator"]>[1]) => {
      const located = locate(selector, options);
      return selector === "input[name=username]" ? failing(located) : located;
    },
  });
};

const inspect = async (page: Page) =>
  Effect.runPromise(
    inspectAutofillStep({
      step: loginStep,
      page: await hostPage(page),
      siteOrigin: site,
      authenticationOrigins: [],
    }),
  );

test("finds the sign-in fields when a frame detaches as the search reaches it", async ({ page }) => {
  const frame = await serve(page);
  failFrame(page, frame, true);
  const inspection = await inspect(page);
  if ("outcome" in inspection)
    throw new Error(
      `Inspection refused: ${inspection.reason} ${JSON.stringify(inspection.failureDetail ?? null)}`,
    );
  expect(inspection.targets.fields.map((field) => field.ownerUrl)).toEqual([site, site]);
  expect(frame.isDetached()).toBe(true);
});

test("a frame that fails without detaching still fails the inspection", async ({ page }) => {
  const frame = await serve(page);
  failFrame(page, frame, false);
  expect(await inspect(page)).toMatchObject({
    outcome: "refused",
    reason: "page_unavailable",
    failureDetail: {
      operation: "autofill.inspect",
      underlying: { message: "Synthetic frame failure" },
    },
  });
  expect(frame.isDetached()).toBe(false);
});
