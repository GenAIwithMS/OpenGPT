import type { Page, Route } from "playwright";
import { pickerCode } from "../../src/browser/picker.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";

/**
 * Runs page code after `pickerCode`, as a Kernel call body runs it (`page` in scope), with `fast`
 * declared: short settle and hold windows, since every fixture answers within a few hundred
 * milliseconds.
 */
export const call = async (page: Page, body: string, timeoutSec = 20) => {
  const answer = await makeLocalKernel(page).browsers.playwright.execute("session-1", {
    timeout_sec: timeoutSec,
    code: `${pickerCode}\nconst fast = { settleMs: 120, holdMs: 120, timeout: 8000 };\n${body}`,
  });
  return answer.success ? { result: answer.result } : { error: answer.error };
};

/** Like `call`, for a call that fails: its error and the first line of its stack, as a host logs them. */
export const callFailure = async (page: Page, body: string, timeoutSec = 20) => {
  const answer = await makeLocalKernel(page).browsers.playwright.execute("session-1", {
    timeout_sec: timeoutSec,
    code: `${pickerCode}\nconst fast = { settleMs: 120, holdMs: 120, timeout: 8000 };\n${body}`,
  });
  return answer.success
    ? { result: answer.result }
    : { error: answer.error, stack: String(answer.stderr ?? "").split("\n")[0] };
};

export const origin = "https://picker.test";

/** A JSON answer for one fixture request, after `delayMs`, as a site's API gives it. */
export type Api = (
  params: URLSearchParams,
  path: string,
) => { readonly body: unknown; readonly delayMs?: number };

/**
 * Serves `html` at the fixture origin, any other page in `pages` by path, and every other path
 * from `api`, then opens the origin. Requests then reach the page as a site's own.
 */
export const serve = async (
  page: Page,
  html: string,
  api?: Api,
  pages: Readonly<Record<string, string>> = {},
) => {
  await page.route(`${origin}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const document = url.pathname === "/" ? html : pages[url.pathname];
    if (document !== undefined)
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: document });
    if (api === undefined) return route.fulfill({ status: 404, body: "" });
    const { body, delayMs = 0 } = api(url.searchParams, url.pathname);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    // A request the page abandoned, or a page already closed, needs no answer.
    await route
      .fulfill({ contentType: "application/json", body: JSON.stringify(body) })
      .catch(() => undefined);
  });
  await page.goto(`${origin}/`);
};

/** What the page's first form would submit. */
export const submitted = (page: Page) =>
  page.evaluate(() => {
    const form = document.forms[0];
    if (form === undefined) return {};
    const data = new FormData(form);
    return Object.fromEntries([...new Set(data.keys())].map((key) => [key, data.getAll(key).join(",")]));
  });
