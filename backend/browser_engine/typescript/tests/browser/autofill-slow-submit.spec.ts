import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import { chromium as patchright } from "patchright";
import { inspectAutofillStep, type AutofillStep } from "../../src/destinations/autofill-step.js";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import { maySend } from "../../src/destinations/autofill-refusal.js";
import { expectNotCarried, hostKeyboard, hostPage } from "./autofill-host-page.js";

// A sign-in form whose post the site answers at once with a redirect, then through a chain of
// redirects that ends on the account page only after the host's 5 s click, as a slow proxy can
// make it. Playwright's click waits, inside its own timeout, for the navigation it started to
// commit, so the click throws although the form went out. Chromium must send the form and follow
// each redirect, which only a real server shows: a routed request's redirects are not routed. The
// site serves HTTPS on a local port, under a name the browser maps to it, with a certificate made
// for the run.
const hostname = "slow-login.example.test";
const browserArgs = [`--host-resolver-rules=MAP ${hostname} 127.0.0.1`];
test.use({ ignoreHTTPSErrors: true, launchOptions: { args: browserArgs } });
const username = "synthetic-agent";
const password = "synthetic-slow-password";

const signInStep: AutofillStep = {
  fields: [
    { selector: "#username", slot: "username" },
    { selector: "#password", slot: "password" },
  ],
  submit: "#sign-in",
};

const loginPage = `<form method="post" action="/session"><label>Username<input id="username" name="username"></label><label>Password<input id="password" name="password" type="password"></label><button id="sign-in">Log in</button></form>`;

/** One request that reached the site after the sign-in page loaded, its icon's aside. */
interface Received {
  readonly method: string;
  readonly path: string;
}

/** A local site and the requests it received, closed with `close`. */
interface Site {
  readonly origin: string;
  readonly received: Received[];
  readonly close: () => Promise<void>;
}

const html = (response: ServerResponse, body: string) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
};

/**
 * A site on a local HTTPS port that serves `screen` at /login. The form's post to /session is answered at
 * once with a redirect, to the account page when `hops` is 0, else to the first of `hops`
 * redirects, each answered `hopMs` after it arrives, the last to the account page. Keeps every
 * request but the screen's own load.
 */
const startSite = async ({
  hops,
  hopMs = 0,
  screen = loginPage,
}: {
  readonly hops: number;
  readonly hopMs?: number;
  readonly screen?: string;
}): Promise<Site> => {
  const received: Received[] = [];
  const directory = await mkdtemp(join(tmpdir(), "opengpt-slow-submit-"));
  await promisify(execFile)("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(directory, "key.pem"),
    "-out",
    join(directory, "cert.pem"),
    "-subj",
    `/CN=${hostname}`,
    "-days",
    "1",
  ]);
  const tls = {
    key: await readFile(join(directory, "key.pem")),
    cert: await readFile(join(directory, "cert.pem")),
  };
  await rm(directory, { recursive: true, force: true });
  const server = createServer(tls, (request, response) => {
    const method = request.method ?? "";
    const path = new URL(request.url ?? "/", "http://site.test").pathname;
    request.resume();
    if (path === "/login" && method === "GET") return html(response, screen);
    if (path !== "/favicon.ico") received.push({ method, path });
    if (path === "/session") {
      response.writeHead(302, { location: hops > 0 ? "/hop/1" : "/account" });
      return response.end();
    }
    const hop = /^\/hop\/(\d+)$/u.exec(path);
    if (hop !== null) {
      const next = Number(hop[1]) + 1;
      setTimeout(() => {
        response.writeHead(302, { location: next > hops ? "/account" : `/hop/${next}` });
        response.end();
      }, hopMs);
      return;
    }
    if (path === "/account") return html(response, '<p id="account">Signed in</p>');
    response.writeHead(204);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing site port");
  return {
    origin: `https://${hostname}:${address.port}`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

/** Runs `use` with `site` started and its sign-in page open on `page`, then closes the site. */
const onSite = async (
  page: Page,
  options: Parameters<typeof startSite>[0],
  use: (site: Site) => Promise<void>,
) => {
  const site = await startSite(options);
  try {
    await page.goto(`${site.origin}/login`);
    await use(site);
  } finally {
    await site.close();
  }
};

/** The redirect chain a slow answer goes through: four redirects of 1.6 s, 6.4 s in all. */
const slow = { hops: 4, hopMs: 1_600 };
/** Each request the slow chain makes from the form's post on, the account page last. */
const slowChain: readonly Received[] = [
  { method: "POST", path: "/session" },
  ...[1, 2, 3, 4].map((hop) => ({ method: "GET", path: `/hop/${hop}` })),
  { method: "GET", path: "/account" },
];

/** The host's inspection and fill of `step` with `values` on `page`, and how long the fill took. */
const fill = async (
  page: Page,
  site: Site,
  step: AutofillStep,
  values: readonly string[],
  { patchright = false } = {},
) => {
  const host = await hostPage(page, [], { patchright });
  const inspection = await Effect.runPromise(
    inspectAutofillStep({ step, page: host, siteOrigin: site.origin, authenticationOrigins: [] }),
  );
  if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
  const started = Date.now();
  const report = await Effect.runPromise(
    fillAutofillStep({
      step,
      values,
      inspection,
      page: host,
      keyboard: (await hostKeyboard(page)).keyboard,
    }),
  );
  expectNotCarried(host.calls, password);
  return { report, tookMs: Date.now() - started };
};

test("a submit whose post the site answers through redirects slower than the click's timeout is clicked, and the account page loads", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await onSite(page, slow, async (site) => {
    const { report, tookMs } = await fill(page, site, signInStep, [username, password]);
    expect(report).toMatchObject({
      outcome: "filled",
      fields: [
        { slot: "username", status: "filled" },
        { slot: "password", status: "filled" },
      ],
      submit: "clicked",
    });
    // What the step filled may have gone out, so the host counts the sign-in as sent.
    expect(maySend(report)).toBe(true);
    // The click ran out of time, then the host waited for the navigation it started.
    expect(tookMs).toBeGreaterThan(5_000);
    expect(site.received).toEqual(slowChain);
    expect(report.outcome === "filled" && new URL(report.url).pathname).toBe("/account");
    await expect(page.locator("#account")).toBeVisible();
  });
});

// Kernel's browsers run Patchright, which evaluates in its own world by default.
test("on Patchright too, a submit whose redirects outlast the click's timeout is clicked", async () => {
  test.setTimeout(60_000);
  const browser = await patchright.launch({ headless: true, args: browserArgs });
  try {
    // Patchright's page has Playwright's API, declared by its own copy of Playwright's types.
    const page = (await browser.newPage({ ignoreHTTPSErrors: true })) as unknown as Page;
    await onSite(page, slow, async (site) => {
      const { report } = await fill(page, site, signInStep, [username, password], {
        patchright: true,
      });
      expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
      expect(maySend(report)).toBe(true);
      expect(site.received).toEqual(slowChain);
      await expect(page.locator("#account")).toBeVisible();
    });
  } finally {
    await browser.close();
  }
});

test("a submit key whose form's redirects outlast the press's timeout is pressed", async ({
  page,
}) => {
  test.setTimeout(60_000);
  // One password field and no button: Enter in the field submits its form.
  const screen = `<form method="post" action="/session"><label>Password<input id="password" name="password" type="password"></label></form>`;
  await onSite(page, { ...slow, screen }, async (site) => {
    const { report } = await fill(
      page,
      site,
      { fields: [{ selector: "#password", slot: "password" }], submitKey: "Enter" },
      [password],
    );
    expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
    expect(maySend(report)).toBe(true);
    expect(site.received).toEqual(slowChain);
  });
});

test("a click that runs out of time before it reaches the submit, with no request for the page, still fails and counts nothing sent", async ({
  page,
}) => {
  test.setTimeout(60_000);
  // The submit never holds still, so Playwright's click waits for it until its timeout and never
  // clicks. The page's own script keeps calling the site meanwhile, which is no navigation.
  const screen = `<style>@keyframes drift{from{transform:translateX(0)}to{transform:translateX(40px)}}#sign-in{animation:drift .2s linear infinite alternate}</style>${loginPage}<script>setInterval(()=>fetch("/ping"),300)</script>`;
  await onSite(page, { hops: 0, screen }, async (site) => {
    const { report } = await fill(page, site, signInStep, [username, password]);
    expect(report).toMatchObject({ outcome: "filled", submit: "failed" });
    expect(maySend(report)).toBe(false);
    expect(site.received.some(({ path }) => path === "/session")).toBe(false);
    expect(site.received.some(({ path }) => path === "/ping")).toBe(true);
  });
});

test("a submit the site answers at once is clicked as before, with the next page's controls", async ({
  page,
}) => {
  await onSite(page, { hops: 0 }, async (site) => {
    const { report, tookMs } = await fill(page, site, signInStep, [username, password]);
    expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
    expect(report.outcome === "filled" && report.controls).toBeTruthy();
    expect(tookMs).toBeLessThan(5_000);
    expect(site.received).toEqual([
      { method: "POST", path: "/session" },
      { method: "GET", path: "/account" },
    ]);
    await expect(page.locator("#account")).toBeVisible();
  });
});
