import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test, expect } from "@playwright/test";
import { chromium } from "playwright";
import { Effect } from "effect";
import { makePlaywrightExecutor } from "../../src/execution/playwright-execute.js";
import type {
  PlaywrightExecutor,
  PlaywrightOptions,
} from "../../src/execution/playwright-execute.js";
import { makeKernelCompatibility } from "../../src/runtime/kernel-compatibility.js";
import { inspectAutofillStep } from "../../src/destinations/autofill-step.js";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import invoiceHeading from "../../authoring/examples/native-page.js";
import { detailNavigation } from "../../authoring/examples/navigation.js";
import { ExecutionContext, makeEffectJournal } from "../../src/runtime/context.js";
import { Deadline } from "../../src/runtime/deadline.js";
import { executeKernelOperation } from "../../src/runtime/kernel-operation-run.js";
import { runLocalOperation, type LocalOperationFailure } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";

const native = <A>(
  run: (executor: PlaywrightExecutor) => Promise<A>,
  options: PlaywrightOptions = {},
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* makePlaywrightExecutor(options);
        return yield* Effect.tryPromise({
          try: () => run(executor),
          catch: (error) =>
            error instanceof Error ? error : new Error("Native fixture failed", { cause: error }),
        });
      }),
    ),
  );

const client = (executor: PlaywrightExecutor) =>
  makeKernelCompatibility(executor.sessionId, executor.executeResponse).browsers.playwright;

test("compiled native executor starts from an inline ES module parent", async () => {
  const script = `import { Effect } from 'effect';
import { makePlaywrightExecutor } from './dist/typescript/src/execution/playwright-execute.js';
const response = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const executor = yield* makePlaywrightExecutor();
  return yield* executor.executeResponse('return await page.title();', 2);
})));
console.log(JSON.stringify(response));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { PATH: process.env["PATH"] ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const closed: readonly unknown[] = await once(child, "close");
  expect(closed[0], errors).toBe(0);
  expect(JSON.parse(output)).toEqual({ success: true, result: "", stdout: "", stderr: "" });
});

// Actual Chromium establishes persistent targets, trusted credential events and context ownership.
test("generated calls retain their selected page and full success or failure response", async () => {
  await native(async (executor) => {
    const kernel = client(executor);
    const response = await kernel.execute(executor.sessionId, {
      code: `await page.setContent('<title>Native fixture</title><label>Name<input></label>');
        await page.getByLabel('Name').fill('Caller supplied');
        console.log('stdout fixture'); console.warn('stderr fixture');
        return {title: await page.title(), value: await page.getByLabel('Name').inputValue()};`,
      timeout_sec: 2,
    });
    expect(response).toEqual({
      success: true,
      result: { title: "Native fixture", value: "Caller supplied" },
      stdout: "stdout fixture\n",
      stderr: "stderr fixture\n",
    });
    const failed = await kernel.execute(executor.sessionId, {
      code: "console.info('before throw'); console.error('error stream'); throw new Error('fixture failure');",
    });
    expect(failed.success).toBe(false);
    expect(failed.error).toBe("fixture failure");
    expect(failed.stdout).toBe("before throw\n");
    expect(failed.stderr).toContain("error stream\n");
    expect(failed.stderr).toContain("Error: fixture failure");
    const next = await kernel.execute(executor.sessionId, {
      code: "return await page.getByLabel('Name').inputValue();",
    });
    expect(next.result).toBe("Caller supplied");
    await expect(
      Effect.runPromise(executor.execute("throw new Error('host fixture failure');")),
    ).rejects.toThrow("host fixture failure");
  });
});

/** How long the page after a code screen takes to answer: far longer than typing takes. */
const nextPageDelayMs = 8_000;
/**
 * Two local origins serving the same pages. `/` has a code field in a form, a frame from each
 * origin, a site frame inside a site frame, a frame of the page's own making, fields in an open and
 * a closed shadow root, and another origin's frame in a closed shadow root. With `how`, typing the
 * sixth character leaves the page at once (`submit`, `href`), after a request (`fetch`) or a task
 * (`timeout`), or moves the focus into the other origin's frame (`captcha`). A frame that gets six
 * characters tells the page, which moves the focus back to its own field. `/two` has only the code
 * field and a frame from each origin, `/plain` no field and no frame (with `grab`, the first key
 * adds another origin's frame and focuses its field, then removes the frame or moves it onto the
 * site once the field has four characters, by `grab=remove` or `grab=site`), and `/swap` a site frame
 * that another origin's frame replaces after half a second, with a disabled field or none.
 */
const typingSites = async () => {
  const origins: string[] = [];
  const servers = ["site", "other"].map((which) =>
    createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://fixture");
      const path = url.pathname;
      if (path === "/next") {
        setTimeout(() => response.end("<p>Next</p>"), nextPageDelayMs);
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      if (path === "/api") return response.end("{}");
      if (path === "/frame")
        return response.end(
          `<input id="inner" class="${which}" aria-label="${which === "site" ? "Site" : "Other"} field"><script>const inner = document.getElementById('inner'); inner.addEventListener('input', (event) => { if (event.target.value.length >= 6) parent.postMessage('typed', '*'); if (event.target.value.length === 4) parent.postMessage(4, '*'); }); addEventListener('focus', () => inner.focus()); if (document.hasFocus()) inner.focus();</script>`,
        );
      if (path === "/nest") return response.end('<iframe id="deeper" src="/frame"></iframe>');
      if (path === "/plain") {
        const grab = url.searchParams.get("grab");
        // Once the frame's field has four characters: remove the frame, or move it onto the site.
        const then =
          grab === "remove"
            ? "frame.remove();"
            : grab === "site"
              ? `frame.src = '${origins[0] ?? ""}/frame';`
              : "";
        return response.end(
          grab === null
            ? "<p>Enter the code</p>"
            : `<p>Enter the code</p><script>addEventListener('keydown', () => { const frame = document.createElement('iframe'); frame.src = '${origins[1] ?? ""}/frame'; document.body.append(frame); frame.focus(); frame.addEventListener('load', () => frame.focus(), { once: true }); addEventListener('message', (event) => { if (event.data === 4) { ${then} } }); }, { once: true });</script>`,
        );
      }
      if (path === "/two")
        return response.end(
          `<label>Code<input id="code"></label><iframe id="same" src="/frame"></iframe><iframe id="other" src="${origins[1] ?? ""}/frame"></iframe>`,
        );
      if (path === "/empty")
        return response.end(url.searchParams.has("field") ? '<input id="inner" disabled>' : "<p>Loading</p>");
      if (path === "/swap")
        return response.end(
          `<iframe id="f" src="/empty${url.search}"></iframe><script>setTimeout(() => { const next = document.createElement('iframe'); next.id = 'f'; next.src = '${origins[1] ?? ""}/frame'; document.getElementById('f').replaceWith(next); }, 500);</script>`,
        );
      response.end(
        `<form id="form" action="/next"><label>Code<input id="code" name="code"></label></form><iframe id="same" src="/frame"></iframe><iframe id="other" src="${origins[1] ?? ""}/frame"></iframe><iframe id="nest" src="/nest"></iframe><iframe id="srcdoc" srcdoc="<input id=inner>"></iframe><div id="closed"></div><div id="open-field"></div><div id="closed-field"></div>
<script>
document.getElementById('closed').attachShadow({ mode: 'closed' }).innerHTML = '<iframe src="${origins[1] ?? ""}/frame?closed"></iframe>';
document.getElementById('open-field').attachShadow({ mode: 'open' }).innerHTML = '<input>';
const closedField = document.getElementById('closed-field').attachShadow({ mode: 'closed' });
closedField.innerHTML = '<input>';
window.focusClosedField = () => closedField.querySelector('input').focus();
addEventListener('message', () => document.getElementById('code').focus());
const how = new URLSearchParams(location.search).get('how');
document.getElementById('code').addEventListener('input', (event) => {
  if (event.target.value.length < 6) return;
  if (how === 'submit') document.getElementById('form').submit();
  if (how === 'href') location.href = '/next';
  if (how === 'fetch') fetch('/api').then(() => { location.href = '/next'; });
  if (how === 'timeout') setTimeout(() => { location.href = '/next'; }, 0);
  if (how === 'captcha') document.getElementById('other').focus();
});
</script>`,
      );
    }),
  );
  for (const server of servers) {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No fixture address");
    origins.push(`http://127.0.0.1:${address.port}`);
  }
  return {
    site: origins[0] ?? "",
    other: origins[1] ?? "",
    close: () =>
      Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.closeAllConnections();
              server.close(() => resolve());
            }),
        ),
      ),
  };
};

/**
 * Runs `code`, after loading `url` when given, while watching for two values, counting typing
 * only on `site`.
 */
const watchedRun =
  (executor: PlaywrightExecutor, site: string) => async (url: string, code: string) => {
    const watch = executor.watchTyping(
      ["111111", "222222"],
      (frameUrl) => URL.parse(frameUrl)?.origin === site,
    );
    const open = url === "" ? "" : `await page.goto('${url}');`;
    const response = await Effect.runPromise(watch.executeResponse(`${open} ${code}`, 30));
    const typed = [...watch.typed()].sort();
    return { success: response.success, error: response.error, typed, result: response.result };
  };

test("a typing watch marks a value typed only by a typing call on the site that completed", async () => {
  test.setTimeout(120_000);
  const { site, other, close } = await typingSites();
  try {
    await native(async (executor) => {
      const run = watchedRun(executor, site);
      const typed = (code: string) => run(`${site}/`, code);
      // Each call a handle may type through, on a locator, the page, a frame and the keyboard,
      // in this tab or another, even when the site then moves the focus into another origin.
      const onSite: readonly (readonly [code: string, url?: string])[] = [
        ["await page.locator('#code').fill('111111');"],
        ["await page.locator('#code').pressSequentially('111111');"],
        ["await page.getByLabel('Code').type('111111');"],
        ["await page.fill('#code', '111111');"],
        ["await page.mainFrame().type('#code', '111111');"],
        ["await page.frameLocator('#same').locator('#inner').fill('111111');"],
        ["await page.getByRole('textbox', { name: 'Code' }).fill('111111');"],
        ["await page.frameLocator('#same').getByRole('textbox', { name: 'Site field' }).fill('111111');"],
        ["await page.locator('#same').contentFrame().locator('#inner').fill('111111');"],
        ["await page.frameLocator('#nest').frameLocator('#deeper').locator('#inner').fill('111111');"],
        ["await page.locator('#open-field input').focus(); await page.keyboard.type('111111');"],
        ["await page.evaluate(() => window.focusClosedField()); await page.keyboard.type('111111');"],
        ["await page.keyboard.type('111111');", `${site}/plain`],
        [
          `const tab = await context.newPage(); await tab.goto('${site}/'); await tab.fill('#code', '111111'); await tab.close();`,
        ],
        [
          `await page.frames().find((frame) => frame.url() === '${site}/frame').fill('#inner', '111111');`,
        ],
        ["await page.locator('#code').focus(); await page.keyboard.type('111111');"],
        [
          "await page.frameLocator('#same').locator('#inner').focus(); await page.keyboard.type('111111');",
        ],
        [
          `const tab = await context.newPage(); await tab.goto('${site}/'); await tab.locator('#code').focus(); await tab.keyboard.type('111111'); await tab.close();`,
        ],
        ["await page.locator('#code').fill('111111');", `${site}/?how=captcha`],
        [
          "await page.locator('#code').focus(); await page.keyboard.type('111111');",
          `${site}/?how=captcha`,
        ],
      ];
      for (const [code, url = `${site}/`] of onSite)
        expect(await run(url, code), code).toEqual({ success: true, typed: [0] });
      // The same calls typing off the site: in another origin's frame, open or in a closed shadow
      // root, even once the focus came back; in a frame of the page's own making; in a page of the
      // code's own; in another tab; and with the page's focus redefined to point at the site.
      for (const code of [
        "await page.frameLocator('#other').locator('#inner').fill('111111');",
        "await page.frameLocator('#other').locator('#inner').pressSequentially('111111');",
        `await page.frames().find((frame) => frame.url() === '${other}/frame').fill('#inner', '111111');`,
        "await page.frameLocator('#other').locator('#inner').focus(); await page.keyboard.type('111111');",
        "await page.frames().find((frame) => frame.url().endsWith('?closed')).fill('#inner', '111111');",
        "await page.frames().find((frame) => frame.url().endsWith('?closed')).locator('#inner').focus(); await page.keyboard.type('111111');",
        "await page.frameLocator('#other').locator('#inner').fill('111111'); await page.waitForTimeout(200);",
        "await page.frameLocator('#srcdoc').locator('#inner').fill('111111');",
        "await page.goto('data:text/html,<input id=code>'); await page.locator('#code').fill('111111');",
        "const tab = await context.newPage(); await tab.goto('data:text/html,<input id=code>'); await tab.fill('#code', '111111'); await tab.close();",
        `const tab = await context.newPage(); await tab.goto('${other}/'); await tab.fill('#code', '111111'); await tab.close();`,
        `const tab = await context.newPage(); await tab.goto('${other}/'); await tab.locator('#code').focus(); await tab.keyboard.type('111111'); await tab.close();`,
        "await page.evaluate(() => Object.defineProperty(Document.prototype, 'activeElement', { configurable: true, get() { return document.getElementById('code'); } })); await page.frameLocator('#other').locator('#inner').focus(); await page.keyboard.type('111111');",
        // Keys with nothing focused, on a page with another origin's frame.
        "await page.keyboard.type('111111');",
      ])
        expect(await typed(code), code).toEqual({ success: true, typed: [] });
      // Keys with nothing focused on a page that adds another origin's frame and focuses its field
      // as typing starts, even when that frame is gone or on the site again once typing ends.
      expect(
        await run(
          `${site}/plain?grab=keep`,
          `await page.keyboard.type('111111', { delay: 150 }); return await page.frames().find((frame) => frame.url() === '${other}/frame').locator('#inner').inputValue();`,
        ),
      ).toEqual({ success: true, typed: [], result: "11111" });
      for (const grab of ["remove", "site"])
        expect(
          await run(`${site}/plain?grab=${grab}`, "await page.keyboard.type('111111', { delay: 150 });"),
          grab,
        ).toEqual({ success: true, typed: [] });
      // Selectors that reach another origin's frame however Playwright lets them: any frame, an
      // aria snapshot's reference, and a frame the page swaps in while the call waits.
      for (const [code, url] of [
        ["await page.frameLocator().locator('.other').fill('111111');", `${site}/two`],
        ["await page.fill('internal:control=any-frame >> .other', '111111');", `${site}/two`],
        [
          "const snapshot = await page.ariaSnapshot({ mode: 'ai' }); const line = snapshot.split('\\n').find((text) => text.includes('Other field')); await page.locator(`aria-ref=${/ref=(f\\d+e\\d+)/.exec(line)[1]}`).fill('111111');",
          `${site}/two`,
        ],
        ["await page.frameLocator('#f').locator('#inner').fill('111111');", `${site}/swap`],
        ["await page.frameLocator('#f').locator('#inner').fill('111111');", `${site}/swap?field`],
      ] as const)
        expect(await run(url, code), code).toEqual({ success: true, typed: [] });
      // A call that failed, a value no typing call entered and code that stopped first type nothing.
      expect(
        await typed(
          "try { await page.locator('#missing').fill('222222', { timeout: 500 }); } catch {} return '222222';",
        ),
      ).toEqual({ success: true, typed: [], result: "222222" });
      expect(
        await typed("throw new Error('stopped'); await page.locator('#code').fill('111111');"),
      ).toEqual({ success: false, error: "stopped", typed: [] });
      // Unwatched calls report nothing, and a later watch starts empty.
      const plain = await Effect.runPromise(
        executor.executeResponse(
          `await page.goto('${site}/'); await page.locator('#code').fill('111111');`,
          5,
        ),
      );
      expect(plain).toEqual({ success: true, stdout: "", stderr: "" });
      expect(await typed("await page.locator('#code').fill('222222');")).toEqual({
        success: true,
        typed: [1],
      });
    });
  } finally {
    await close();
  }
});

test("a code typed on a screen that leaves as soon as it is typed counts, without waiting for the next page", async () => {
  test.setTimeout(120_000);
  const { site, close } = await typingSites();
  try {
    await native(async (executor) => {
      const run = watchedRun(executor, site);
      for (const how of ["submit", "href", "fetch", "timeout"])
        for (const [before, typing] of [
          ["", "await tab.locator('#code').fill('111111');"],
          ["", "await tab.locator('#code').pressSequentially('111111');"],
          ["await tab.locator('#code').focus();", "await tab.keyboard.type('111111');"],
        ]) {
          // Each in a tab of its own, closed while its next page is still loading.
          const outcome = await run(
            "",
            `const tab = await context.newPage(); await tab.goto('${site}/?how=${how}'); ${before} const started = Date.now(); ${typing} const took = Date.now() - started; await tab.close(); return took;`,
          );
          expect(outcome, `${how}: ${typing}`).toMatchObject({ success: true, typed: [0] });
          // The call returned long before the next page could answer.
          expect(outcome.result, `${how}: ${typing}`).toBeLessThan(nextPageDelayMs / 2);
        }
    });
  } finally {
    await close();
  }
});

test("a typing watch ends with its script, so later calls fail as they did before it", async () => {
  await native(async (executor) => {
    const failures = `await page.setContent('<p>No field</p>');
const message = async (call) => { try { await call(); return 'completed'; } catch (error) { return String(error.message); } };
return [await message(() => page.locator('#missing').fill('x', { timeout: 200 })), await message(() => page.fill('#missing', 'x', { timeout: 200 }))];`;
    const messages = async () => {
      const response = await Effect.runPromise(executor.executeResponse(failures, 5));
      expect(response.success, response.error).toBe(true);
      return response.result;
    };
    const before = await messages();
    expect(
      Array.isArray(before) ? before.map((text) => String(text).split("\n")[0]) : before,
    ).toEqual(["locator.fill: Timeout 200ms exceeded.", "page.fill: Timeout 200ms exceeded."]);
    // After a watched script that completed, and one that threw after typing.
    for (const [ending, success] of [
      ["", true],
      ["throw new Error('stopped');", false],
    ] as const) {
      const watched = await Effect.runPromise(
        executor
          .watchTyping(["111111"], () => true)
          .executeResponse(
            `await page.setContent('<input id=code>'); await page.locator('#code').fill('111111'); ${ending}`,
            5,
          ),
      );
      expect(watched.success, watched.error).toBe(success);
      expect(await messages()).toEqual(before);
    }
  });
});

test("unsupported and oversized results fail without invalidating the browser", async () => {
  await native(async (executor) => {
    const kernel = client(executor);
    for (const code of [
      "return 1n;",
      "const value = {}; value.self = value; return value;",
      "return 'x'.repeat(1048577);",
      "console.log('x'.repeat(1048577)); return 'truncated success';",
    ]) {
      const response = await kernel.execute(executor.sessionId, { code });
      expect(response.success).toBe(false);
      expect(response.error).toBeTruthy();
      expect(response.result).toBeUndefined();
    }
    expect(await kernel.execute(executor.sessionId, { code: "return;" })).toEqual({
      success: true,
      stdout: "",
      stderr: "",
    });
    expect(
      (await kernel.execute(executor.sessionId, { code: "return [1, {ok: true}];" })).result,
    ).toEqual([1, { ok: true }]);
  });
});

// A string result's JSON adds its two quotes, so this returns `bytes` bytes of JSON.
const resultOfBytes = (bytes: number) => `return 'x'.repeat(${bytes - 2});`;
const mebibyte = 1_048_576;

test("a result over 1 MiB fails by default and one of 1 MiB succeeds", async () => {
  await native(async (executor) => {
    const kernel = client(executor);
    expect(
      await kernel.execute(executor.sessionId, { code: resultOfBytes(mebibyte + 1) }),
    ).toMatchObject({ success: false, error: "Native script result exceeds 1 MiB" });
    const fits = await kernel.execute(executor.sessionId, { code: resultOfBytes(mebibyte) });
    expect(fits.success, fits.error).toBe(true);
    expect(String(fits.result)).toHaveLength(mebibyte - 2);
  });
});

for (const [resultLimitBytes, named] of [
  [4 * mebibyte, "4 MiB"],
  [3_000_000, "3000000 bytes"],
  [64 * mebibyte, "64 MiB"],
] as const) {
  test(`a ${named} result limit admits larger results and names itself when exceeded`, async () => {
    await native(
      async (executor) => {
        const kernel = client(executor);
        const larger = await kernel.execute(executor.sessionId, {
          code: resultOfBytes(mebibyte + 1),
        });
        expect(larger.success, larger.error).toBe(true);
        expect(String(larger.result)).toHaveLength(mebibyte - 1);
        expect(
          await kernel.execute(executor.sessionId, { code: resultOfBytes(resultLimitBytes + 1) }),
        ).toMatchObject({ success: false, error: `Native script result exceeds ${named}` });
        // The limit covers the result only: console output keeps its own 1 MiB cap.
        expect(
          await kernel.execute(executor.sessionId, {
            code: "console.log('x'.repeat(1048577)); return 'printed';",
          }),
        ).toMatchObject({ success: false, error: "Native script output exceeds 1 MiB" });
      },
      { resultLimitBytes },
    );
  });
}

test("an invalid result limit is refused before a browser starts", async () => {
  for (const resultLimitBytes of [0, -1, 1.5, 64 * mebibyte + 1, Number.NaN, Infinity])
    await expect(
      native(() => Promise.resolve(), { resultLimitBytes, endpoint: "ws://127.0.0.1:9/never" }),
    ).rejects.toThrow("resultLimitBytes must be a positive integer and at most 67108864 bytes");
});

test("popup and frame actions preserve the original selected page across calls", async () => {
  await native(async (executor) => {
    const kernel = client(executor);
    const response = await kernel.execute(executor.sessionId, {
      code: `await page.setContent('<title>Primary</title><iframe srcdoc="<p>Frame fixture</p>"></iframe><button onclick="window.open(&quot;about:blank&quot;)">Open</button>');
        const popupPending = page.waitForEvent('popup');
        await page.getByText('Open', {exact:true}).click();
        const popup = await popupPending;
        await popup.setContent('<title>Popup</title>');
        return {frame: await page.frameLocator('iframe').locator('p').innerText(), popup: await popup.title(), pages: context.pages().length};`,
    });
    expect(response.success, response.error).toBe(true);
    expect(response).toMatchObject({
      success: true,
      result: { frame: "Frame fixture", popup: "Popup", pages: 2 },
    });
    expect(
      (await kernel.execute(executor.sessionId, { code: "return await page.title();" })).result,
    ).toBe("Primary");
  });
});

test("remote attachment releases owned contexts and preserves the caller's browser", async () => {
  const server = await chromium.launchServer({ headless: true });
  const owner = await chromium.connect(server.wsEndpoint());
  try {
    const unrelated = await owner.newContext();
    const page = await unrelated.newPage();
    await page.setContent("<title>Caller context</title><button>Still usable</button>");
    const census = await owner.newBrowserCDPSession();
    try {
      const before = await census.send("Target.getBrowserContexts");
      await native(
        async (executor) => {
          const response = await client(executor).execute(executor.sessionId, {
            code: "await page.setContent('<title>Attached fixture</title>'); const extra = await browser.newContext(); await extra.newPage(); return await page.title();",
          });
          expect(response.result).toBe("Attached fixture");
          await Effect.runPromise(executor.close);
        },
        { endpoint: server.wsEndpoint() },
      );
      expect(await census.send("Target.getBrowserContexts")).toEqual(before);
      expect(owner.isConnected()).toBe(true);
      await page.getByText("Still usable").click();
      expect(await page.title()).toBe("Caller context");
    } finally {
      await census.detach();
    }
  } finally {
    await owner.close();
    await server.close();
  }
});

for (const mode of ["pending_abort", "infinite_abort", "infinite_timeout"] as const) {
  test(`${mode} stops execution without replay`, async () => {
    const written = Promise.withResolvers<void>();
    let writes = 0;
    const fixture = createServer((request, response) => {
      if (request.url === "/write") {
        writes++;
        response.end("Recorded");
        written.resolve();
      } else response.end("<title>Cancellation fixture</title>");
    });
    fixture.listen(0, "127.0.0.1");
    await once(fixture, "listening");
    const address = fixture.address();
    if (address === null || typeof address === "string") throw new Error("Fixture address missing");
    const origin = `http://127.0.0.1:${address.port}`;
    const server = await chromium.launchServer({ headless: true });
    const owner = await chromium.connect(server.wsEndpoint());
    try {
      const unrelated = await owner.newContext();
      const page = await unrelated.newPage();
      await page.setContent("<title>Unrelated</title>");
      await native(
        async (executor) => {
          const kernel = client(executor);
          const abort = new AbortController();
          const completion = kernel
            .execute(
              executor.sessionId,
              {
                code: `await page.goto(${JSON.stringify(origin)});
            await page.evaluate(() => fetch('/write', {method:'POST'}).then(response => response.text()));
            ${mode === "pending_abort" ? "await page.waitForTimeout(60000);" : "while(true) {}"}`,
                timeout_sec: mode === "infinite_timeout" ? 1 : 10,
              },
              { signal: abort.signal, maxRetries: 3 },
            )
            .then(
              () => undefined,
              (error: unknown) => error,
            );
          await written.promise;
          if (mode !== "infinite_timeout") abort.abort(new Error("Caller cancelled fixture"));
          expect(await completion).toBeInstanceOf(Error);
          await expect(
            kernel.execute(executor.sessionId, { code: "return 'replay';" }),
          ).rejects.toThrow("invalidated");
          expect(writes).toBe(1);
        },
        { endpoint: server.wsEndpoint() },
      );
      expect(await page.title()).toBe("Unrelated");
      expect(owner.isConnected()).toBe(true);
      const census = await owner.newBrowserCDPSession();
      try {
        expect((await census.send("Target.getBrowserContexts")).browserContextIds).toHaveLength(1);
      } finally {
        await census.detach();
      }
    } finally {
      await owner.close();
      await server.close();
      fixture.closeAllConnections();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  });
}

test("original autofill uses native trusted input and refuses a stale field binding", async () => {
  await native(async (executor) => {
    const site = "https://login.example.test";
    await Effect.runPromise(
      executor.execute(`
      await context.route('${site}/**', route => route.fulfill({contentType:'text/html', body:'<label>Password<input id="password" type="password"></label><input id="other">'}));
      await page.goto('${site}');
      await page.evaluate(() => { window.trustedInput = []; document.addEventListener('input', event => window.trustedInput.push(event.isTrusted)); });
    `),
    );
    const step = { fields: [{ selector: "#password", slot: "password" as const }] };
    const host = { targetId: executor.targetId, execute: executor.execute };
    const inspection = await Effect.runPromise(
      inspectAutofillStep({
        step,
        page: host,
        siteOrigin: site,
        authenticationOrigins: [],
      }),
    );
    if ("outcome" in inspection) throw new Error(`Fixture refused: ${inspection.reason}`);
    const report = await Effect.runPromise(
      fillAutofillStep({
        step,
        values: ["synthetic-native-secret"],
        inspection,
        page: host,
        keyboard: executor.keyboard,
        settleMs: 0,
      }),
    );
    expect(report.outcome).toBe("filled");
    const verification = await Effect.runPromise(
      executor.executeResponse(
        `return await page.evaluate(() => ({filled: document.querySelector('#password').value === 'synthetic-native-secret', trusted: window.trustedInput}));`,
      ),
    );
    expect(verification.result).toEqual({ filled: true, trusted: [true] });
    expect(JSON.stringify(verification)).not.toContain("synthetic-native-secret");
    await Effect.runPromise(executor.execute("await page.locator('#password').fill('');"));
    const stale = await Effect.runPromise(
      fillAutofillStep({
        step,
        values: ["never-inserted"],
        inspection,
        page: host,
        settleMs: 0,
        keyboard: {
          insertText: (target, text) =>
            executor
              .execute("await page.locator('#other').focus();")
              .pipe(Effect.zipRight(executor.keyboard.insertText(target, text))),
        },
      }),
    );
    expect(stale.outcome).toBe("refused");
    expect(
      await Effect.runPromise(
        executor.execute("return await page.locator('#other').inputValue();"),
      ),
    ).toBe("");
  });
});

test("native autofill preserves an approved cross-site frame binding", async () => {
  const server = await chromium.launchServer({ headless: true, args: ["--site-per-process"] });
  try {
    await native(
      async (executor) => {
        const site = "https://login.example.test";
        const authOrigin = "https://approved-sign-in.test";
        await Effect.runPromise(
          executor.execute(`
      await context.route('${site}/**', route => route.fulfill({contentType:'text/html', body:'<iframe src="${authOrigin}"></iframe>'}));
      await context.route('${authOrigin}/**', route => route.fulfill({contentType:'text/html', body:'<input id="frame-password" type="password">'}));
      await page.goto('${site}');
      await page.frameLocator('iframe').locator('#frame-password').waitFor();
      const frame = page.frames().find(frame => frame.url().startsWith('${authOrigin}'));
      const cdp = await context.newCDPSession(frame); await cdp.detach();
    `),
        );
        const step = { fields: [{ selector: "#frame-password", slot: "password" as const }] };
        const host = { targetId: executor.targetId, execute: executor.execute };
        const inspection = await Effect.runPromise(
          inspectAutofillStep({
            step,
            page: host,
            siteOrigin: site,
            authenticationOrigins: [authOrigin],
          }),
        );
        if ("outcome" in inspection) throw new Error(`Fixture refused: ${inspection.reason}`);
        const report = await Effect.runPromise(
          fillAutofillStep({
            step,
            values: ["synthetic-frame-secret"],
            inspection,
            page: host,
            keyboard: executor.keyboard,
            settleMs: 0,
          }),
        );
        expect(report.outcome).toBe("filled");
        expect(
          await Effect.runPromise(
            executor.execute(
              `return await page.frameLocator('iframe').locator('#frame-password').evaluate(input => input.value === 'synthetic-frame-secret');`,
            ),
          ),
        ).toBe(true);
      },
      { endpoint: server.wsEndpoint() },
    );
  } finally {
    await server.close();
  }
});

// Under native Playwright the host's element reads run in the page's own world, where page code
// can redefine what they return. What Guardian and the submit wait act on comes from the browser.
const signInPage = (
  site: string,
  script: string,
  button = '<button id="continue">Sign in</button>',
) =>
  `await context.route('${site}/**', route => {
    if (route.request().method() === 'POST') context.signInPosts = (context.signInPosts ?? 0) + 1;
    return route.fulfill({contentType:'text/html', body: new URL(route.request().url()).pathname === '/session' ? '<p>Signed in</p>' : '<form action="/session" method="post"><label>Password<input id="password" name="password" type="password"></label>${button}</form><script>${script}</script>'});
  });
  await page.goto('${site}/login');`;
const passwordAndSubmit = {
  fields: [{ selector: "#password", slot: "password" as const }],
  submit: "#continue",
};
/** Fakes `:disabled` for the submit: true when `disabled`, else false. */
const fakeDisabled = (disabled: boolean) =>
  `const matches = Element.prototype.matches; Element.prototype.matches = function (selector) { return this.id === "continue" && selector === ":disabled" ? ${String(disabled)} : matches.call(this, selector); };`;
/** Fakes that no inert region holds the submit. */
const fakeNotInert =
  'const closest = Element.prototype.closest; Element.prototype.closest = function (selector) { return this.id === "continue" && selector === "[inert]" ? null : closest.call(this, selector); };';
/** Makes the password field read-only for 400 ms once typed into, then enables the submit 400 ms later. */
const enabledAfterReadOnly =
  'const field = document.getElementById("password"); field.addEventListener("input", () => { field.readOnly = true; setTimeout(() => { field.readOnly = false; setTimeout(() => { document.getElementById("continue").disabled = false; }, 400); }, 400); }, { once: true });';

test("native inspection reports the frame's own origin, not one page code claims", async () => {
  await native(async (executor) => {
    const site = "https://www.signin.test";
    await Effect.runPromise(
      executor.execute(
        signInPage(
          site,
          'Object.defineProperty(window,"origin",{get:()=>"https://accounts.signin.test",configurable:true})',
        ),
      ),
    );
    const inspection = await Effect.runPromise(
      inspectAutofillStep({
        step: passwordAndSubmit,
        page: { targetId: executor.targetId, execute: executor.execute },
        siteOrigin: site,
        authenticationOrigins: [],
      }),
    );
    if ("outcome" in inspection) throw new Error(`Fixture refused: ${inspection.reason}`);
    expect(inspection.screen.origin).toBe(site);
  });
});

for (const [name, button, script, expected] of [
  [
    "a submit page code fakes as disabled is clicked at once",
    '<button id="continue">Sign in</button>',
    fakeDisabled(true),
    { submit: "clicked", posts: 1 },
  ],
  [
    "a disabled submit page code fakes as enabled is never clicked and reported as staying disabled",
    '<button id="continue" disabled>Sign in</button>',
    fakeDisabled(false),
    { submit: "stayed_disabled", posts: 0 },
  ],
  // Inert stays a page read: faked away, the step goes on, yet Playwright's click never lands.
  [
    "an inert submit page code fakes as not inert is never clicked",
    '<div inert><button id="continue">Sign in</button></div>',
    fakeNotInert,
    { submit: "failed", posts: 0 },
  ],
  // The submit enabling is no change to the controls the host judges, whatever element it is.
  [
    "a submit input enabled after a field's brief read-only spell is clicked once",
    '<input id="continue" type="submit" value="Sign in" disabled>',
    enabledAfterReadOnly,
    { submit: "clicked", posts: 1 },
  ],
  [
    "a submit button enabled after a field's brief read-only spell is clicked once",
    '<button id="continue" disabled>Sign in</button>',
    enabledAfterReadOnly,
    { submit: "clicked", posts: 1 },
  ],
] as const)
  test(`native sign-in: ${name}`, async () => {
    await native(async (executor) => {
      const site = "https://www.signin.test";
      await Effect.runPromise(executor.execute(signInPage(site, script, button)));
      const host = { targetId: executor.targetId, execute: executor.execute };
      const inspection = await Effect.runPromise(
        inspectAutofillStep({
          step: passwordAndSubmit,
          page: host,
          siteOrigin: site,
          authenticationOrigins: [],
        }),
      );
      if ("outcome" in inspection) throw new Error(`Fixture refused: ${inspection.reason}`);
      const report = await Effect.runPromise(
        fillAutofillStep({
          step: passwordAndSubmit,
          values: ["synthetic-native-secret"],
          inspection,
          page: host,
          keyboard: executor.keyboard,
          settleMs: 500,
        }),
      );
      expect(report).toMatchObject({ outcome: "filled", submit: expected.submit });
      expect(
        await Effect.runPromise(executor.execute("return context.signInPosts ?? 0;")),
      ).toBe(expected.posts);
    });
  });

test("unchanged authored operations run through schema validation and native execution", async () => {
  await native(async (executor) => {
    const site = "https://example.test";
    await Effect.runPromise(
      executor.execute(`
      await context.route('${site}/**', route => {
        const path = new URL(route.request().url()).pathname;
        const body = path === '/search' ? '<section role="region" aria-label="Search results"><a href="/records/alpha">alpha</a></section>'
          : path === '/records/alpha' ? '<section role="region" aria-label="Record details" data-record-id="alpha"><h1>Requested record</h1></section>'
          : '<h1>Invoices</h1><form role="search" action="/search"><input type="search" name="q" aria-label="Record ID"></form>';
        return route.fulfill({contentType:'text/html', body});
      });
      await page.goto('${site}');
    `),
    );
    const journal = await Effect.runPromise(makeEffectJournal);
    const execution = {
      deadline: Deadline.after(5000),
      journal,
      events: { emit: () => Effect.void },
      capture: { start: Effect.void, finish: Effect.void },
    };
    const browser = {
      kernel: makeKernelCompatibility(executor.sessionId, executor.executeResponse),
      sessionId: executor.sessionId,
      siteOrigin: site,
    };
    expect(
      await Effect.runPromise(
        Effect.scoped(
          executeKernelOperation(invoiceHeading, {}, browser).pipe(
            Effect.provideService(ExecutionContext, execution),
          ),
        ),
      ),
    ).toEqual({ heading: "Invoices" });
    expect(
      await Effect.runPromise(
        Effect.scoped(
          executeKernelOperation(detailNavigation, { record_id: "alpha" }, browser).pipe(
            Effect.provideService(ExecutionContext, execution),
          ),
        ),
      ),
    ).toEqual({ record_id: "alpha", title: "Requested record" });
    const refusedInput = await Effect.runPromise(
      Effect.scoped(
        executeKernelOperation(detailNavigation, { record_id: "bad/id" }, browser).pipe(
          Effect.provideService(ExecutionContext, execution),
          Effect.either,
        ),
      ),
    );
    expect(refusedInput).toMatchObject({ _tag: "Left", left: { _tag: "InvalidInput" } });
  });
});

const writeFixture = async () => {
  const written = Promise.withResolvers<void>();
  let writes = 0;
  let credentialRequests = 0;
  const fixture = createServer((request, response) => {
    if (request.url === "/write") {
      writes++;
      written.resolve();
      response.end("Recorded");
    } else if (request.url?.startsWith("/credential")) {
      credentialRequests++;
      response.end("Observed");
    } else
      response
        .writeHead(200, { "content-type": "text/html" })
        .end(
          '<input id="password" type="password" oninput="fetch(\'/credential?value=\'+encodeURIComponent(this.value))">',
        );
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const address = fixture.address();
  if (address === null || typeof address === "string") throw new Error("Fixture address missing");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    written: written.promise,
    writes: () => writes,
    credentialRequests: () => credentialRequests,
    close: async () => {
      fixture.closeAllConnections();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    },
  };
};

test("lost native browser reports cleanup uncertainty and prevents replay", async () => {
  const fixture = await writeFixture();
  const server = await chromium.launchServer({ headless: true });
  try {
    await expect(
      native(
        async (executor) => {
          const kernel = client(executor);
          const pending = kernel
            .execute(executor.sessionId, {
              code: `await page.goto(${JSON.stringify(fixture.origin)}); await page.evaluate(()=>fetch('/write',{method:'POST'})); await page.waitForTimeout(60000);`,
            })
            .then(
              (response) => response,
              (error: unknown) => error,
            );
          await fixture.written;
          await server.close();
          const failure = await pending;
          if (failure instanceof Error) expect(String(failure)).toContain("cleanup unconfirmed");
          else expect(failure).toMatchObject({ success: false });
          await expect(
            kernel.execute(executor.sessionId, { code: "return 'retry';" }),
          ).rejects.toThrow("invalidated");
          await expect(Effect.runPromise(executor.close)).rejects.toThrow("cleanup unconfirmed");
          expect(fixture.writes()).toBe(1);
        },
        { endpoint: server.wsEndpoint() },
      ),
    ).rejects.toThrow("cleanup unconfirmed");
  } finally {
    await server.close();
    await fixture.close();
  }
});

test("credential queued behind cancelled browser work is never inserted", async () => {
  const fixture = await writeFixture();
  const server = await chromium.launchServer({ headless: true });
  const owner = await chromium.connect(server.wsEndpoint());
  try {
    const unrelated = await owner.newContext();
    const page = await unrelated.newPage();
    await page.setContent("<title>Caller context</title>");
    await native(
      async (executor) => {
        const kernel = client(executor);
        const abort = new AbortController();
        const bindingKey = "__opengpt_queued_fixture";
        await Effect.runPromise(
          executor.execute(`await page.goto(${JSON.stringify(fixture.origin)});
        await page.locator('#password').focus();
        await page.locator('#password').evaluate((field,key)=>{field.setAttribute(key,'');field[key]={document:field.ownerDocument,frame:field.ownerDocument.defaultView};},${JSON.stringify(bindingKey)});`),
        );
        expect(
          await Effect.runPromise(
            executor.keyboard.insertText(
              { bindingKey, documentOrigin: fixture.origin },
              "native-control",
            ),
          ),
        ).toBe("inserted");
        await expect.poll(fixture.credentialRequests).toBe(1);
        await Effect.runPromise(
          executor.execute(`
          await page.locator('#password').evaluate((field,key)=>{field.value='';field.focus();field.setAttribute(key,'');field[key]={document:field.ownerDocument,frame:field.ownerDocument.defaultView};},${JSON.stringify(bindingKey)});`),
        );
        const pending = kernel
          .execute(
            executor.sessionId,
            {
              code: "await page.evaluate(()=>fetch('/write',{method:'POST'}));await page.waitForTimeout(60000);",
            },
            { signal: abort.signal },
          )
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        await fixture.written;
        const queued = Effect.runPromise(
          executor.keyboard.insertText(
            { bindingKey, documentOrigin: fixture.origin },
            "synthetic-queued-secret",
          ),
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        abort.abort(new Error("Caller cancelled pending browser work"));
        expect(await pending).toBeInstanceOf(Error);
        const credentialFailure = await queued;
        expect(credentialFailure).toBeInstanceOf(Error);
        expect(String(credentialFailure)).toContain("invalidated");
        expect(fixture.writes()).toBe(1);
        expect(fixture.credentialRequests()).toBe(1);
      },
      { endpoint: server.wsEndpoint() },
    );
    expect(await page.title()).toBe("Caller context");
  } finally {
    await owner.close();
    await server.close();
    await fixture.close();
  }
});

test("native page code does not inherit host variables through process.env", async () => {
  const key = "BROWSER_ENGINE_NATIVE_HOST_ONLY_FIXTURE";
  const previous = process.env[key];
  process.env[key] = "synthetic-host-only-value";
  try {
    await native(async (executor) => {
      const response = await client(executor).execute(executor.sessionId, {
        code: `return process.env[${JSON.stringify(key)}] ?? null;`,
      });
      expect(response).toMatchObject({ success: true, result: null });
    });
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test("local operation preserves authored typed challenge failures", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* createLocalWorkspace();
        return yield* runLocalOperation({
          workspace,
          entrypoint: "operation/src/tool.mjs",
          sources: [
            [
              "operation/src/tool.mjs",
              `import { Schema } from "effect";
import { defineOperation, ChallengeFailure } from "../../runtime/index.js";
export default defineOperation({ input: Schema.Struct({}), output: Schema.Struct({}) }, async () => {
  throw new ChallengeFailure({ code: "Unavailable" });
});`,
            ],
          ],
          input: {},
          target: "pureFiles",
        }).pipe(Effect.either);
      }),
    ),
  );
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      name: "LocalOperationFailure",
      tag: "ChallengeFailure",
      code: "Unavailable",
      journal: { effect: "not_sent", commits: [] },
    },
  });
});

// A live run may have reached the site once its script starts, whether or not it called the
// browser yet; an offline run never can.
// A served run counts as possibly sent from its start, as the shared runner marks it. A mint step
// counts from its first browser call, so a step that stopped before one reads not sent.
test("local operation reports a started run as possibly sent, a mint step from its first browser call, and an offline run as unsent", async () => {
  const run = (
    target: "browser" | "pureFiles",
    options: { readonly dispatchAtFirstCall?: true; readonly callsBrowser?: true } = {},
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workspace = yield* createLocalWorkspace();
          return yield* runLocalOperation({
            workspace,
            entrypoint: "operation/src/tool.mjs",
            sources: [
              [
                "operation/src/tool.mjs",
                `import { Schema } from "effect";
import { defineOperation } from "../../runtime/index.js";
export default defineOperation({ input: Schema.Struct({}), output: Schema.Struct({}) }, async ({ kernel, sessionId }) => {
  ${options.callsBrowser === true ? 'await kernel.browsers.playwright.execute(sessionId, { code: "return 1;", timeout_sec: 5 });' : ""}
  throw new Error("Stopped");
});`,
              ],
            ],
            input: {},
            browser: {
              sessionId: "session-1",
              executeResponse: () =>
                options.callsBrowser === true
                  ? Effect.succeed({ success: true, result: 1 })
                  : Effect.fail(new Error("No browser call was expected")),
            },
            target,
            ...(options.dispatchAtFirstCall === undefined ? {} : { dispatchAtFirstCall: true }),
          }).pipe(Effect.either);
        }),
      ),
    );
  const effectOf = async (outcome: ReturnType<typeof run>) => {
    const result = await outcome;
    if (result._tag === "Right") throw new Error("Expected the run to fail");
    expect(result.left).toMatchObject({ name: "LocalOperationFailure", journal: { commits: [] } });
    return (result.left as LocalOperationFailure).journal.effect;
  };
  expect(await effectOf(run("browser"))).toBe("possible");
  expect(await effectOf(run("browser", { dispatchAtFirstCall: true }))).toBe("not_sent");
  expect(
    await effectOf(run("browser", { dispatchAtFirstCall: true, callsBrowser: true })),
  ).toBe("possible");
  expect(await effectOf(run("pureFiles"))).toBe("not_sent");
  // A step with no browser never marks, even when its script tries a browser call.
  expect(
    await effectOf(run("pureFiles", { dispatchAtFirstCall: true, callsBrowser: true })),
  ).toBe("not_sent");
  expect(await effectOf(run("pureFiles", { callsBrowser: true }))).toBe("not_sent");
});
