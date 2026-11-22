import { once } from "node:events";
import { createServer } from "node:http";
import { test, expect, type Page } from "@playwright/test";
import { Effect, Schema } from "effect";
import type { HostExecute } from "../../src/runtime/host-execute.js";
import { configureSiteIdentity } from "../../src/runtime/same-site.js";
import {
  loadEntry,
  localStartHooks,
  SavedSession,
  saveSessionCode,
  startPage,
  stopLoadingCode,
  type PageStart,
} from "../../src/runtime/start-state.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";
import { requestSite } from "../../src/standalone/request-context.js";
import type { StandaloneSession } from "../../src/standalone/session.js";

// The page reset a live example, live test or write session's first step starts from, on local
// Chromium against a local site that counts each path it serves.

const startSite = async () => {
  const hits = new Map<string, number>();
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://site.test").pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    // A page that moved twice, and one the site does not have.
    if (path === "/old" || path === "/older") {
      response.writeHead(path === "/older" ? 301 : 302, {
        location: path === "/older" ? "/old" : "/claims",
      });
      response.end();
      return;
    }
    // A page whose connection the site drops.
    if (path === "/dropped") {
      response.destroy();
      return;
    }
    response.statusCode = path === "/missing" ? 404 : 200;
    response.setHeader("Content-Type", "text/html");
    response.end(`<h1>${path}</h1>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No site address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    hits: (path: string) => hits.get(path) ?? 0,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};
type Site = Awaited<ReturnType<typeof startSite>>;

/** The host's browser calls on `page`, as the native executor runs them. */
const host = async (page: Page) => {
  const kernel = makeLocalKernel(page);
  const calls: string[] = [];
  const execute: HostExecute = (code, timeoutSec) =>
    Effect.sync(() => calls.push(code)).pipe(
      Effect.zipRight(
        Effect.promise(() =>
          kernel.browsers.playwright.execute("local", {
            code,
            ...(timeoutSec === undefined ? {} : { timeout_sec: timeoutSec }),
          }),
        ),
      ),
      Effect.flatMap((response) =>
        response.success
          ? Effect.succeed(response.result)
          : Effect.fail(new Error(response.error ?? "Browser call failed")),
      ),
    );
  const cdp = await page.context().newCDPSession(page);
  const { targetInfo } = await cdp.send("Target.getTargetInfo");
  await cdp.detach();
  return { execute, targetId: targetInfo.targetId, calls };
};

interface Reset {
  readonly reset: (start: PageStart) => Promise<void>;
  readonly save: () => Promise<SavedSession>;
  /** Whether a call stopped the primary tab's loading after a failed root load. */
  readonly stopped: () => boolean;
}
const withSite = async (page: Page, run: (site: Site, browser: Reset) => Promise<void>) => {
  const site = await startSite();
  const { execute, targetId, calls } = await host(page);
  try {
    await run(site, {
      reset: (start) =>
        Effect.runPromise(
          startPage(execute, targetId, site.origin, start, localStartHooks(execute, targetId)),
        ),
      save: () =>
        Effect.runPromise(
          execute(saveSessionCode(targetId, site.origin), 60).pipe(
            Effect.flatMap(Schema.decodeUnknown(SavedSession)),
          ),
        ),
      stopped: () => calls.includes(stopLoadingCode(targetId)),
    });
  } finally {
    await site.close();
  }
};

test("resets to the site root with no exploration cookies, storage or tabs", async ({ page }) => {
  await withSite(page, async (site, { reset }) => {
    await page.goto(`${site.origin}/claims`);
    await page.evaluate(() => {
      document.cookie = "recent=SFO-NYC; max-age=3600";
      localStorage.setItem("recent", "SFO-NYC");
      sessionStorage.setItem("recent", "SFO-NYC");
    });
    await page.context().newPage();
    await reset({ siteData: "clear" });
    expect(page.context().pages().map((open) => open.url())).toEqual([`${site.origin}/`]);
    expect(await page.context().cookies()).toEqual([]);
    await page.goto(`${site.origin}/claims`);
    expect(await page.evaluate(() => localStorage.getItem("recent"))).toBeNull();
    // Session storage belongs to the tab, so clearing the origin's data alone would keep it.
    expect(await page.evaluate(() => sessionStorage.getItem("recent"))).toBeNull();
  });
});

test("keeps a restored session and lets the step go deeper when the root fails to load", async ({
  page,
}) => {
  await withSite(page, async (site, { reset, save, stopped }) => {
    await page.goto(`${site.origin}/claims`);
    await page.evaluate(() => localStorage.setItem("login", "member"));
    const session = await save();
    await page.evaluate(() => localStorage.setItem("login", "changed"));
    await page.context().route(`${site.origin}/`, (route) => route.abort("failed"));
    await reset({ siteData: "restore", session });
    await page.goto(`${site.origin}/claims`, { waitUntil: "domcontentloaded" });
    expect(page.url()).toBe(`${site.origin}/claims`);
    await expect.poll(() => page.evaluate(() => localStorage.getItem("login"))).toBe("member");
    expect(site.hits("/")).toBe(0);
    expect(stopped()).toBe(true);
  });
});

test("keeps every kind of site data while returning to the site root, and closes other tabs", async ({
  page,
}) => {
  await withSite(page, async (site, { reset, stopped }) => {
    await page.goto(`${site.origin}/claims`);
    await page.evaluate(async () => {
      document.cookie = "login=member; max-age=3600";
      localStorage.setItem("login", "member");
      sessionStorage.setItem("login", "member");
      await new Promise<void>((resolve, reject) => {
        const opened = indexedDB.open("site", 1);
        opened.onupgradeneeded = () => opened.result.createObjectStore("state");
        opened.onerror = () => reject(opened.error);
        opened.onsuccess = () => {
          const write = opened.result.transaction("state", "readwrite");
          write.objectStore("state").put("member", "login");
          write.oncomplete = () => {
            opened.result.close();
            resolve();
          };
        };
      });
    });
    await page.context().newPage();
    await reset({ siteData: "keep" });
    expect(page.context().pages().map((open) => open.url())).toEqual([`${site.origin}/`]);
    expect(stopped()).toBe(false);
    expect(site.hits("/")).toBe(1);
    expect((await page.context().cookies()).map((cookie) => cookie.name)).toEqual(["login"]);
    expect(
      await page.evaluate(async () => ({
        local: localStorage.getItem("login"),
        session: sessionStorage.getItem("login"),
        indexed: await new Promise((resolve) => {
          const opened = indexedDB.open("site", 1);
          opened.onsuccess = () => {
            const read = opened.result.transaction("state").objectStore("state").get("login");
            read.onsuccess = () => resolve(read.result);
            read.onerror = () => resolve(null);
          };
          opened.onerror = () => resolve(null);
        }),
      })),
    ).toEqual({ local: "member", session: "member", indexed: "member" });
  });
});

test("clears the site's tab storage when exploration left the site before the reset", async ({
  page,
}) => {
  await withSite(page, async (site, { reset }) => {
    await page.goto(`${site.origin}/claims`);
    await page.evaluate(() => sessionStorage.setItem("recent", "SFO-NYC"));
    await page.goto("about:blank");
    await reset({ siteData: "clear" });
    // Cleanup stays local, then the root is loaded once.
    expect(site.hits("/")).toBe(1);
    await page.goto(`${site.origin}/claims`);
    expect(await page.evaluate(() => sessionStorage.getItem("recent"))).toBeNull();
  });
});

test("clears storage exploration left on another origin before a signed-out step", async ({
  page,
}) => {
  const other = "https://second.example.test";
  await withSite(page, async (_site, { reset }) => {
    await page.route(`${other}/**`, (route) =>
      route.fulfill({ contentType: "text/html", body: "<html></html>" }),
    );
    await page.goto(`${other}/`);
    await page.evaluate(() => {
      document.cookie = "recent=SFO-NYC; max-age=3600";
      localStorage.setItem("recent", "SFO-NYC");
    });
    // Nothing names the other origin: the reset clears every origin the browser visited.
    await reset({ siteData: "clear" });
    expect(await page.context().cookies()).toEqual([]);
    await page.goto(`${other}/`);
    expect(await page.evaluate(() => localStorage.getItem("recent"))).toBeNull();
  });
});

test("restores the session saved after sign-in and drops what exploration added", async ({
  page,
}) => {
  await withSite(page, async (site, { reset, save }) => {
    await page.goto(`${site.origin}/claims`);
    await page.evaluate(() => {
      document.cookie = "login=member-1; max-age=3600";
      localStorage.setItem("token", "member-1");
    });
    const session = await save();
    await page.evaluate(() => {
      document.cookie = "recent=SFO-NYC; max-age=3600";
      localStorage.setItem("token", "changed");
      localStorage.setItem("recent", "SFO-NYC");
      sessionStorage.setItem("recent", "SFO-NYC");
    });
    await reset({ siteData: "restore", session });
    expect(
      (await page.context().cookies()).map((cookie) => `${cookie.name}=${cookie.value}`),
    ).toEqual(["login=member-1"]);
    await page.goto(`${site.origin}/claims`);
    expect(
      await page.evaluate(() => ({
        token: localStorage.getItem("token"),
        recent: localStorage.getItem("recent"),
        session: sessionStorage.getItem("recent"),
      })),
    ).toEqual({ token: "member-1", recent: null, session: null });
  });
});

test("a restore puts back the tab's session storage the saved session had", async ({ page }) => {
  await withSite(page, async (site, { reset, save }) => {
    await page.goto(`${site.origin}/claims`);
    await page.evaluate(() => sessionStorage.setItem("login", "member"));
    const session = await save();
    await page.evaluate(() => sessionStorage.setItem("login", "changed"));
    await reset({ siteData: "restore", session });
    expect(await page.evaluate(() => sessionStorage.getItem("login"))).toBe("member");
  });
});

// A saved session keeps the tab storage of frames on the site only, by the site identity: with a
// host's added private suffix, a sibling subdomain's frame below it is another site's.
test("saves a sibling subdomain's tab storage only while no added suffix splits them", async ({
  page,
}) => {
  const site = "http://alpha.apps.example.test";
  const sibling = "http://beta.apps.example.test";
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({
      contentType: "text/html",
      body:
        url.origin === site
          ? `<script>sessionStorage.setItem("site", "alpha")</script><iframe src="${sibling}/frame"></iframe>`
          : `<script>sessionStorage.setItem("site", "beta")</script>`,
    });
  });
  const { execute, targetId } = await host(page);
  const save = () =>
    Effect.runPromise(
      execute(saveSessionCode(targetId, site), 60).pipe(
        Effect.flatMap(Schema.decodeUnknown(SavedSession)),
      ),
    );
  await page.goto(`${site}/`);
  await expect(page.frameLocator("iframe").locator("script")).toHaveCount(1);
  expect((await save()).sessionStorage.map(({ origin }) => origin)).toEqual([site, sibling]);
  configureSiteIdentity({ privateSuffixes: ["apps.example.test"] });
  try {
    expect((await save()).sessionStorage).toEqual([
      { origin: site, entries: [["site", "alpha"]] },
    ]);
  } finally {
    configureSiteIdentity({});
  }
});

// The host's load of the request's page: one call that reports how it went, whatever happened.
test("loads the request's page and reports its status, its redirects and where it landed", async ({
  page,
}) => {
  const site = await startSite();
  const { execute, targetId } = await host(page);
  try {
    const load = (path: string) =>
      Effect.runPromise(loadEntry(execute, targetId, `${site.origin}${path}`, 30_000));
    expect(await load("/older")).toEqual({
      outcome: "ready",
      requestedUrl: `${site.origin}/older`,
      resolvedUrl: `${site.origin}/claims`,
      redirects: [
        { url: `${site.origin}/older`, status: 301 },
        { url: `${site.origin}/old`, status: 302 },
      ],
      redirectsTruncated: false,
      status: 200,
      durationMs: expect.any(Number),
    });
    expect(page.url()).toBe(`${site.origin}/claims`);
    expect(await load("/missing")).toMatchObject({
      outcome: "http_error",
      resolvedUrl: `${site.origin}/missing`,
      redirects: [],
      status: 404,
    });
    await page.route(`${site.origin}/refused`, (route) => route.abort("connectionrefused"));
    expect(await load("/refused")).toMatchObject({
      outcome: "failed",
      requestedUrl: `${site.origin}/refused`,
      status: null,
      failure: { kind: "refused" },
    });
  } finally {
    await site.close();
  }
});

// Chromium may commit its error page a moment after a failed load's goto rejects, which would cut
// off a goto the step makes at once. The local host stops the tab after a failed load.
test("a step's goto right after the request's page failed to load is never cut off", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const site = await startSite();
  const closed = await startSite();
  await closed.close();
  const { execute, targetId } = await host(page);
  const session = { browser: { execute, targetId } } as unknown as StandaloneSession;
  const deep = `${site.origin}/deep`;
  try {
    const landed: string[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      for (const url of [`${closed.origin}/claims`, `${site.origin}/dropped`]) {
        // Any error page the last attempt left commits before the tab starts over.
        await page.waitForTimeout(1_000);
        await page.goto("about:blank");
        const entry = await Effect.runPromise(requestSite(session, { url }));
        await Effect.runPromise(entry.navigate);
        expect(entry.entryNavigation()).toMatchObject({ state: "not_opened", outcome: "failed" });
        // The step's own load, at once, as a first explore would make it.
        const step = await Effect.runPromise(
          execute(`await page.goto(${JSON.stringify(deep)}); return page.url();`, 30).pipe(
            Effect.either,
          ),
        );
        landed.push(
          step._tag === "Right" ? String(step.right) : (step.left.message.split("\n")[0] ?? ""),
        );
      }
    }
    expect(landed).toEqual(Array.from({ length: 12 }, () => deep));
  } finally {
    await site.close();
  }
});
