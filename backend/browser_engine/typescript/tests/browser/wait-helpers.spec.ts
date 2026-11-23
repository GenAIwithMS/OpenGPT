import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { chromium as patchright } from "patchright";
import { Either, Schema } from "effect";
import { outcomeWaitCode } from "../../src/browser/outcome-wait.js";
import { waitCode } from "../../src/browser/wait.js";
import { probeCallCode } from "../../src/runtime/host-execute.js";
import { defineOperation } from "../../src/runtime/operation.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";
import { failure, runExample } from "./authoring-fixture.js";

// The runtime's page waits, run as a Kernel call body runs them (`page` in scope) on local pages.
// Chromium must render them: visibility, DOM changes and the page's requests are what they watch.
// Every budget is injected, so each test ends in well under 3 s.
const call = async (page: Page, body: string, prefix = waitCode) => {
  const answer = await makeLocalKernel(page).browsers.playwright.execute("session-1", {
    timeout_sec: 10,
    code: `${prefix}\n${body}`,
  });
  return answer.success ? { result: answer.result } : { error: String(answer.error) };
};

const origin = "https://rooms.example.test";

/** Serves `html` at the origin's root, every other path through `api`, and opens the root. */
const site = async (
  page: Page,
  html: string,
  api: (path: string) => Promise<{ status?: number; body: string; contentType?: string }> = async () => ({
    body: "",
  }),
) => {
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/") {
      await route.fulfill({ contentType: "text/html", body: html });
      return;
    }
    const answer = await api(url.pathname);
    await route.fulfill({
      status: answer.status ?? 200,
      contentType: answer.contentType ?? "application/json",
      body: answer.body,
    });
  });
  await page.goto(`${origin}/`);
};

const rooms = `<ul aria-label="Rooms"><li>Garden room</li><li>Courtyard room</li></ul>`;

// Refusal and error first, then the empty state, then results, with injected budgets.
const outcomeBody = (options: string) => `
  const answer = page.locator("#answer");
  const started = Date.now();
  try {
    const shown = await waitForOutcome({
      failed: answer.getByRole("alert"),
      empty: answer.getByText("No rooms match your dates", { exact: true }),
      results: answer.getByRole("list", { name: "Rooms", exact: true }),
    }, { ${options} });
    return { shown, ms: Date.now() - started, report: waitReport() };
  } catch (error) {
    return { reason: error.reason, message: error.message, ms: Date.now() - started, progress: error.progress };
  }
`;

interface OutcomeAnswer {
  readonly shown?: string;
  readonly reason?: string;
  readonly message?: string;
  readonly ms: number;
  readonly report?: readonly { readonly summary: string; readonly looks: number }[];
}

const outcome = async (page: Page, options: string): Promise<OutcomeAnswer> => {
  const answer = await call(page, outcomeBody(options));
  if (answer.error !== undefined) throw new Error(answer.error);
  return answer.result as OutcomeAnswer;
};

test("a quiet page that shows none of the answers fails as outcome_unknown long before its cap", async ({
  page,
}) => {
  await page.setContent(`<section id="answer"><h1>Something else entirely</h1></section>`);
  const answer = await outcome(page, "noProgressMs: 300, timeout: 2000");
  // Its 2 s cap would have made it an outcome_timeout.
  expect(answer.reason).toBe("outcome_unknown");
  expect(answer.message).toMatch(
    /^outcome_unknown after \d+ ms, 300 ms without progress, no outcome showing: failed 0 visible of 0, empty 0 visible of 0, results 0 visible of 0; no progress seen$/u,
  );
});

test("an answer already on the page returns at the first look, with no second look to confirm it", async ({
  page,
}) => {
  await page.setContent(`<section id="answer">${rooms}</section>`);
  const answer = await outcome(page, "timeout: 3000");
  expect(answer.shown).toBe("results");
  expect(answer.report?.[0]?.looks).toBe(1);
  expect(answer.report?.[0]?.summary).toMatch(/^waitForOutcome: "results" showed after \d+ ms \(1 look\); /u);
});

test("a page showing a loading sign keeps the wait alive past the no-progress window", async ({
  page,
}) => {
  // A generic sign counts until it has held for the no-progress window, and the window then runs.
  await page.setContent(`
    <section id="answer"><div aria-busy="true">Searching</div></section>
    <script>
      setTimeout(() => { document.querySelector("#answer").innerHTML = ${JSON.stringify(rooms)}; }, 900);
    </script>`);
  const answer = await outcome(page, "noProgressMs: 700, timeout: 3000");
  expect(answer.shown).toBe("results");
  expect(answer.report?.[0]?.summary).toMatch(/^waitForOutcome: "results" showed after \d+ ms .*progress seen: loading sign /u);
});

test("the site's own loading sign counts once it is named, and a page without it fails fast", async ({
  page,
}) => {
  const html = `
    <section id="answer"><div class="wheel">Please hold</div></section>
    <script>
      setTimeout(() => { document.querySelector("#answer").innerHTML = ${JSON.stringify(rooms)}; }, 1500);
    </script>`;
  await page.setContent(html);
  expect((await outcome(page, `noProgressMs: 300, timeout: 3000, loading: page.locator(".wheel")`)).shown).toBe(
    "results",
  );
  await page.setContent(html);
  expect((await outcome(page, "noProgressMs: 300, timeout: 3000")).reason).toBe("outcome_unknown");
});

test("beacons and a repeating poll are not progress", async ({ page }) => {
  await site(
    page,
    `<section id="answer"><p>Welcome</p></section>
    <script>
      let n = 0;
      setInterval(() => {
        n += 1;
        new Image().src = "/pixel.gif?n=" + n;
        navigator.sendBeacon("/collect", String(n));
        fetch("/poll?n=" + n);
      }, 100);
    </script>`,
  );
  const answer = await outcome(page, "noProgressMs: 400, timeout: 3000");
  expect(answer.reason).toBe("outcome_unknown");
  expect(answer.message).toMatch(/ignored \d+ repeating requests$/u);
});

test("the site's own request in flight keeps the wait alive until its answer renders", async ({
  page,
}) => {
  await site(
    page,
    `<button type="button">Search</button><section id="answer"></section>
    <script>
      document.querySelector("button").onclick = async () => {
        const response = await fetch("/api/rooms");
        document.querySelector("#answer").innerHTML = (await response.json()).html;
      };
    </script>`,
    async (path) => {
      if (path !== "/api/rooms") return { body: "{}" };
      await new Promise((resolve) => setTimeout(resolve, 900));
      return { body: JSON.stringify({ html: rooms }) };
    },
  );
  const answer = await outcome(
    page,
    `noProgressMs: 300, timeout: 3000, siteDomain: "example.test", action: () => page.getByRole("button", { name: "Search" }).click()`,
  );
  expect(answer.shown).toBe("results");
  expect(answer.report?.[0]?.summary).toMatch(/site request/u);
});

test("changes inside the named region are progress, and the same changes elsewhere are not", async ({
  page,
}) => {
  const html = `
    <section id="answer"><p id="status">Checking source 0</p></section>
    <script>
    {
      let n = 0;
      const ticker = setInterval(() => { document.querySelector("#status").textContent = "Checking source " + (n += 1); }, 100);
      setTimeout(() => { clearInterval(ticker); document.querySelector("#answer").innerHTML = ${JSON.stringify(rooms)}; }, 900);
    }
    </script>`;
  await page.setContent(html);
  expect(
    await outcome(page, `noProgressMs: 300, timeout: 3000, region: page.locator("#answer")`),
  ).toMatchObject({ shown: "results" });
  await page.setContent(html);
  expect((await outcome(page, "noProgressMs: 300, timeout: 3000")).reason).toBe("outcome_unknown");
});

test("a URL that keeps changing is progress", async ({ page }) => {
  await site(
    page,
    `<section id="answer"><p>Loading step</p></section>
    <script>
      let step = 0;
      const steps = setInterval(() => history.replaceState(null, "", "/?step=" + (step += 1)), 150);
      setTimeout(() => { clearInterval(steps); document.querySelector("#answer").innerHTML = ${JSON.stringify(rooms)}; }, 900);
    </script>`,
  );
  const answer = await outcome(page, "noProgressMs: 300, timeout: 3000");
  expect(answer.shown).toBe("results");
  expect(answer.report?.[0]?.summary).toMatch(/URL change/u);
});

test("a page still progressing at the cap fails as outcome_timeout and says what it saw", async ({
  page,
}) => {
  await page.setContent(`<section id="answer"><div aria-busy="true">Searching</div></section>`);
  // The site's own sign, named, counts for as long as it shows.
  const answer = await outcome(page, `noProgressMs: 300, timeout: 800, loading: page.locator('[aria-busy="true"]')`);
  expect(answer.reason).toBe("outcome_timeout");
  expect(answer.message).toMatch(
    /^outcome_timeout after 800 ms: failed 0 visible of 0, empty 0 visible of 0, results 0 visible of 0; progress seen: loading sign \d\.\d s–\d\.\d s/u,
  );
});

test("after an action, a decorative loading sign from before it is not progress", async ({ page }) => {
  await page.setContent(`
    <div role="progressbar" aria-label="Step 2 of 3"></div>
    <button type="button">Search</button>
    <section id="answer"></section>`);
  const answer = await outcome(
    page,
    `noProgressMs: 300, timeout: 2000, action: () => page.getByRole("button", { name: "Search" }).click()`,
  );
  expect(answer.reason).toBe("outcome_unknown");
});

// A results page: `identified` rows with an ID fill at `rowsMs`; their prices show a skeleton
// until `priceMs` (never when null); `slots` unidentified slots fill at `slotsMs`.
const resultsPage = (
  page: Page,
  options: { identified: number; rowsMs: number; priceMs: number | null; slots?: number; slotsMs?: number },
) =>
  page.setContent(`
    <ol id="results"></ol>
    <script>
      const list = document.querySelector("#results");
      setTimeout(() => {
        for (let i = 1; i <= ${options.identified}; i += 1)
          list.insertAdjacentHTML("beforeend",
            '<li data-id="room-' + i + '"><h3>Room ' + i + '</h3><span class="price skeleton"></span></li>');
      }, ${options.rowsMs});
      ${
        options.priceMs === null
          ? ""
          : `setTimeout(() => {
        for (const price of document.querySelectorAll(".price")) {
          price.classList.remove("skeleton");
          price.textContent = "$" + (100 + Number(price.parentElement.dataset.id.slice(5)));
        }
      }, ${options.priceMs});`
      }
      setTimeout(() => {
        for (let i = 0; i < ${options.slots ?? 0}; i += 1)
          list.insertAdjacentHTML("beforeend", '<li class="sponsored"><h3>Sponsored</h3></li>');
      }, ${options.slotsMs ?? 0});
    </script>`);

// A search tool that waits for the rows it returns, run through the runtime as a hosted run is.
const searchTool = (count: number, options = "") =>
  defineOperation(
    {
      input: Schema.Struct({}),
      output: Schema.Struct({
        rooms: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, price: Schema.String })),
      }),
    },
    async ({ kernel, sessionId, errors }) => {
      const answer = await kernel.browsers.playwright.execute(sessionId, {
        timeout_sec: 10,
        code: `${waitCode}
          const { rows } = await waitForRows(page.locator("#results > li"), { name: "h3", price: ".price" }, {
            count: ${count}, key: { attribute: "data-id" }, noProgressMs: 400, stableMs: 100, unchangedMs: 300, ${options}
          });
          return rows.map((row) => ({ id: row.key, name: row.name, price: row.price }));`,
      });
      if (!answer.success)
        throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
      return { rooms: answer.result as { id: string; name: string; price: string }[] };
    },
  );

const rows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `room-${index + 1}`,
    name: `Room ${index + 1}`,
    price: `$${101 + index}`,
  }));

test("a search returns its first rows once they fill, without waiting for slots filled later", async ({
  page,
}) => {
  await resultsPage(page, { identified: 5, rowsMs: 100, priceMs: 200, slots: 20, slotsMs: 2500 });
  const started = Date.now();
  const run = await runExample(page, searchTool(5), {});
  expect(Either.getOrUndefined(run.result)).toEqual({ rooms: rows(5) });
  // A wait for the whole list would have ended only after the late slots filled.
  expect(Date.now() - started).toBeLessThan(2500);
});

test("a price the page fills late is returned filled, never empty", async ({ page }) => {
  await resultsPage(page, { identified: 3, rowsMs: 50, priceMs: 400 });
  const run = await runExample(page, searchTool(3), {});
  expect(Either.getOrUndefined(run.result)).toEqual({ rooms: rows(3) });
});

test("fewer rows than asked are returned once their count holds", async ({ page }) => {
  await resultsPage(page, { identified: 3, rowsMs: 50, priceMs: 100 });
  const run = await runExample(page, searchTool(5), {});
  expect(Either.getOrUndefined(run.result)).toEqual({ rooms: rows(3) });
});

test("a needed value still loading when progress stops fails the run as a browser action timeout", async ({
  page,
}) => {
  await resultsPage(page, { identified: 2, rowsMs: 50, priceMs: null });
  const run = await runExample(page, searchTool(2), {});
  const failed = failure(run.result) as { _tag: string; message: string };
  expect(failed._tag).toBe("BrowserActionTimeout");
  expect(failed.message).toMatch(
    /^values_loading after \d+ ms, 400 ms without progress: 2 identified rows of 2, needed 2; price still loading in rows 1, 2; /u,
  );
});

test("an infinite list stops at the rows asked for, or where the list ends", async ({ page }) => {
  const list = (total: number) =>
    page.setContent(`
      <ol id="results"></ol><button type="button">More</button>
      <script>
      {
        let shown = 0;
        const more = () => setTimeout(() => {
          const until = Math.min(shown + 10, ${total});
          for (; shown < until; ) {
            shown += 1;
            document.querySelector("#results").insertAdjacentHTML("beforeend",
              '<li data-id="r' + shown + '"><h3>Row ' + shown + '</h3></li>');
          }
        }, 100);
        more();
        document.querySelector("button").onclick = more;
      }
      </script>`);
  const body = (count: number) => `
    const rows = page.locator("#results > li");
    let read = await waitForRows(rows, { name: "h3" }, { count: Math.min(${count}, 10), key: { attribute: "data-id" }, noProgressMs: 400, stableMs: 50, unchangedMs: 300 });
    while (read.rows.length < ${count}) {
      const before = read.rows.length;
      read = await waitForRows(rows, { name: "h3" }, {
        count: ${count}, key: { attribute: "data-id" }, noProgressMs: 400, stableMs: 50, unchangedMs: 300,
        action: () => page.getByRole("button", { name: "More" }).click({ timeout: 1000 }),
      });
      if (read.rows.length === before) break;
    }
    return read.rows.map((row) => row.key);`;
  await list(40);
  const asked = await call(page, body(25));
  expect(asked.result).toEqual(Array.from({ length: 25 }, (_, index) => `r${index + 1}`));
  await list(18);
  const ended = await call(page, body(25));
  expect(ended.result).toEqual(Array.from({ length: 18 }, (_, index) => `r${index + 1}`));
});

test("a record's values are waited for until filled and holding, and an optional one may be absent", async ({
  page,
}) => {
  await page.setContent(`
    <main><h1>Garden room</h1><p id="price">Loading…</p></main>
    <script>
      setTimeout(() => { document.querySelector("#price").textContent = "$120"; }, 200);
      setTimeout(() => { document.querySelector("#price").textContent = "$125"; }, 350);
    </script>`);
  const answer = await call(
    page,
    `const { values } = await waitForValues({
      title: page.getByRole("heading", { level: 1 }),
      price: page.locator("#price"),
      rating: { locator: page.locator("#rating"), optional: true },
    }, { noProgressMs: 400, stableMs: 300 });
    return values;`,
  );
  expect(answer.result).toEqual({ title: "Garden room", price: "$125", rating: null });
});

test("a needed value that never shows fails and names it", async ({ page }) => {
  await page.setContent(`<main><h1>Garden room</h1></main>`);
  const answer = await call(
    page,
    `await waitForValues({ title: page.getByRole("heading", { level: 1 }), price: page.locator("#price") }, { noProgressMs: 300 });`,
  );
  expect(answer.error).toMatch(/^values_loading after \d+ ms, 300 ms without progress: price missing; no progress seen$/u);
});

// A booking quote: choosing guests shows a spinner for `spinnerMs`, then the total becomes `total`.
const quotePage = (page: Page, total: string, spinnerMs: number | null) =>
  page.setContent(`
    <label>Guests <select id="guests"><option>2</option><option>3</option></select></label>
    <div id="spinner" hidden>Updating price</div>
    <p id="total">$240</p>
    <script>
      document.querySelector("#guests").onchange = () => {
        ${spinnerMs === null ? "" : `document.querySelector("#spinner").hidden = false;`}
        setTimeout(() => {
          document.querySelector("#spinner").hidden = true;
          document.querySelector("#total").textContent = ${JSON.stringify(total)};
        }, ${spinnerMs ?? 0});
      };
    </script>`);

const changeBody = `
  const started = Date.now();
  const read = await waitForChange({ total: page.locator("#total") }, {
    action: () => page.locator("#guests").selectOption("3", { timeout: 1000 }),
    loading: page.locator("#spinner"),
    noProgressMs: 400,
    stableMs: 100,
    unchangedMs: 300,
  });
  // Whether the page still showed its loading sign when the wait returned.
  const spinnerShowing = await page.locator("#spinner").isVisible();
  return { ...read, spinnerShowing, ms: Date.now() - started };`;

test("after a choice, the dependent total is the new one, never the stale one", async ({ page }) => {
  await quotePage(page, "$360", 600);
  const answer = (await call(page, changeBody)).result as { values: unknown; changed: boolean };
  expect(answer).toMatchObject({ values: { total: "$360" }, changed: true });
});

test("a total that stays the same counts only after the loading sign went", async ({ page }) => {
  await quotePage(page, "$240", 500);
  // It returns only once the sign went, never while the total was still being worked out.
  expect((await call(page, changeBody)).result).toMatchObject({
    values: { total: "$240" },
    changed: false,
    spinnerShowing: false,
  });
  // With no loading sign at all, the same total counts once the page was quiet for the unchanged
  // window.
  await quotePage(page, "$240", null);
  const quiet = (await call(page, changeBody)).result as { changed: boolean; ms: number };
  expect(quiet.changed).toBe(false);
  expect(quiet.ms).toBeLessThan(2000);
});

test("a probe call acts with a short default timeout, and later calls get Playwright's back", async ({
  page,
}) => {
  await page.setContent(`
    <p>Nothing to click</p>
    <script>setTimeout(() => document.body.insertAdjacentHTML("beforeend", '<p id="late">Late</p>'), 900);</script>`);
  const failed = await makeLocalKernel(page).browsers.playwright.execute("session-1", {
    timeout_sec: 10,
    code: probeCallCode(`await page.getByRole("button", { name: "Apply" }).click();`, 200),
  });
  expect(failed.success).toBe(false);
  expect(String(failed.error)).toMatch(/Timeout 200ms exceeded/u);
  const later = await makeLocalKernel(page).browsers.playwright.execute("session-1", {
    timeout_sec: 10,
    code: `await page.locator("#late").waitFor(); return "seen";`,
  });
  expect(later).toEqual({ success: true, result: "seen" });
});

test("a before that is not the values object of the same fields is refused at once", async ({
  page,
}) => {
  await quotePage(page, "$240", null);
  const answer = await call(
    page,
    `await waitForChange({ total: page.locator("#total") }, { before: ["$240"], noProgressMs: 300 });`,
  );
  expect(answer.error).toMatch(/^waitForChange's before must be the values object/u);
});

// Decorative signs: a rating bar (a determinate progress bar), a quantity input whose class names
// a spinner, and a layout element whose class names one. None of them is the page loading.
const decorations = `<div role="progressbar" aria-valuenow="80" aria-valuemin="0" aria-valuemax="100" aria-label="Rating"></div><input type="number" class="qty-spinner" aria-label="Quantity" value="1"><span class="spinner-frame">&#9733;</span>`;

test("rows whose cards carry rating bars and spinner-named controls return promptly when fewer than asked", async ({
  page,
}) => {
  await page.setContent(`
    <ol id="results"></ol>
    <script>
      setTimeout(() => {
        for (let i = 1; i <= 3; i += 1)
          document.querySelector("#results").insertAdjacentHTML("beforeend",
            '<li data-id="room-' + i + '"><h3>Room ' + i + '</h3><span class="price">$' + (100 + i) + '</span>' + ${JSON.stringify(decorations)} + '</li>');
      }, 50);
    </script>`);
  const answer = await call(
    page,
    `const started = Date.now();
    const { rows } = await waitForRows(page.locator("#results > li"), { price: ".price" }, {
      count: 5, key: { attribute: "data-id" }, noProgressMs: 400, stableMs: 100, unchangedMs: 300, timeout: 2500,
    });
    return { keys: rows.map((row) => row.key), ms: Date.now() - started };`,
  );
  expect(answer.error).toBeUndefined();
  const result = answer.result as { keys: string[]; ms: number };
  expect(result.keys).toEqual(["room-1", "room-2", "room-3"]);
  expect(result.ms).toBeLessThan(1500);
});

test("a page whose only signs are decorative fails as outcome_unknown at the no-progress limit", async ({
  page,
}) => {
  await page.setContent(`<section id="answer"><h1>Something else entirely</h1>${decorations}</section>`);
  const answer = await outcome(page, "noProgressMs: 300, timeout: 2000");
  expect(answer.reason).toBe("outcome_unknown");
  expect(answer.ms).toBeLessThan(1500);
});

test("a dependent value confirmed unchanged beside a decorative sign returns without waiting out the cap", async ({
  page,
}) => {
  await quotePage(page, "$240", null);
  await page.locator("body").evaluate((body, html) => body.insertAdjacentHTML("beforeend", html), decorations);
  const answer = await call(
    page,
    `await page.locator("#guests").selectOption("3", { timeout: 1000 });
    return await waitForChange({ total: page.locator("#total") }, {
      before: { total: "$240" }, noProgressMs: 400, stableMs: 100, unchangedMs: 300, timeout: 2500,
    });`,
  );
  expect(answer.result).toEqual({ values: { total: "$240" }, changed: false });
});

test("a loading sign that appears after the action keeps the wait alive past the no-progress window", async ({
  page,
}) => {
  await page.setContent(`
    <button type="button">Search</button><section id="answer"></section>
    <script>
      document.querySelector("button").onclick = () => {
        document.querySelector("#answer").innerHTML = '<div class="results-skeleton" style="height: 40px"></div>';
        setTimeout(() => { document.querySelector("#answer").innerHTML = ${JSON.stringify(rooms)}; }, 600);
      };
    </script>`);
  const answer = await outcome(
    page,
    `noProgressMs: 500, timeout: 3000, action: () => page.getByRole("button", { name: "Search" }).click()`,
  );
  expect(answer, JSON.stringify(answer)).toMatchObject({ shown: "results" });
});

test("code pasting outcomeWaitCode beside its own wait helpers still runs", async ({ page }) => {
  await page.setContent(rooms.replace("<ul", `<section id="answer"><ul`) + "</section>");
  const answer = await call(
    page,
    `const waitSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitForRows = async () => "mine";
    const waitLimits = {};
    await waitSleep(1);
    return [await waitForOutcome({ results: page.getByRole("list", { name: "Rooms" }) }), await waitForRows()];`,
    outcomeWaitCode,
  );
  expect(answer).toEqual({ result: ["results", "mine"] });
});

test("a search sent to the same API path as earlier requests is still the site's request in flight", async ({
  page,
}) => {
  await site(
    page,
    `<button type="button">Search</button><section id="answer"></section>
    <script>
      const ask = (operation) => fetch("/graphql", { method: "POST", body: JSON.stringify({ operation }) });
      document.querySelector("button").onclick = async () => {
        await Promise.all([ask("Session"), ask("Flags")]);
        const response = await ask("SearchRooms");
        document.querySelector("#answer").innerHTML = (await response.json()).html;
      };
    </script>`,
    async (path) => {
      if (path !== "/graphql") return { body: "{}" };
      return { body: JSON.stringify({ html: rooms }) };
    },
  );
  // Only the search is slow.
  await page.route(`${origin}/graphql`, async (route) => {
    const slow = String(route.request().postData()).includes("SearchRooms");
    if (slow) await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ html: rooms }) });
  });
  const answer = await outcome(
    page,
    `noProgressMs: 500, timeout: 3000, siteDomain: "example.test", action: () => page.getByRole("button", { name: "Search" }).click()`,
  );
  expect(answer.shown).toBe("results");
});

test("a request that stays open does not hold a short list back", async ({ page }) => {
  await site(
    page,
    `<ol id="results"><li data-id="room-1"><h3>Room 1</h3></li></ol>
    <script>setTimeout(() => fetch("/events/wait"), 20);</script>`,
    async (path) => {
      if (path === "/events/wait") await new Promise((resolve) => setTimeout(resolve, 5000));
      return { body: "{}" };
    },
  );
  const answer = await call(
    page,
    `const started = Date.now();
    const { rows } = await waitForRows(page.locator("#results > li"), { name: "h3" }, {
      count: 5, key: { attribute: "data-id" }, siteDomain: "example.test", noProgressMs: 400, stableMs: 100, unchangedMs: 300, timeout: 2500,
    });
    return { keys: rows.map((row) => row.key), ms: Date.now() - started };`,
  );
  expect(answer.error).toBeUndefined();
  expect((answer.result as { ms: number }).ms).toBeLessThan(1500);
});

test("without siteDomain, a host under a shared suffix such as co.uk is not taken for the site", async ({
  page,
}) => {
  const shop = "https://shop.example.co.uk";
  await page.route("https://*.co.uk/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === shop && url.pathname === "/") {
      await route.fulfill({ contentType: "text/html", body: `<section id="answer"><p>Welcome</p></section>` });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.fulfill({ body: "" }).catch(() => undefined);
  });
  await page.goto(`${shop}/`);
  const signs = async (host: string) => {
    const answer = await call(
      page,
      `try {
        await waitForOutcome({ results: page.getByRole("list") }, {
          noProgressMs: 300, timeout: 3000,
          action: () => page.evaluate(() => { fetch("https://${host}/slow", { mode: "no-cors" }); }),
        });
      } catch (error) {
        return { reason: error.reason, signs: Object.keys(error.progress.signs) };
      }`,
    );
    return answer.result as { reason: string; signs: string[] };
  };
  // Another site under the same public suffix is not the site's own request.
  expect(await signs("tracker.co.uk")).toEqual({ reason: "outcome_unknown", signs: [] });
  // The site's own API host is.
  expect(await signs("api.example.co.uk")).toEqual({ reason: "outcome_unknown", signs: ["site request"] });
});

test("a row's field is read from its visible match, and a field only hidden is said to be hidden", async ({
  page,
}) => {
  await page.setContent(`
    <ol id="results">
      <li data-id="room-1"><h3>Room 1</h3><span class="price" style="display:none">$1</span><span class="price">$101</span><span class="badge" hidden>New</span></li>
    </ol>`);
  const found = await call(
    page,
    `const { rows } = await waitForRows(page.locator("#results > li"), { price: ".price" }, {
      count: 1, key: { attribute: "data-id" }, noProgressMs: 300, stableMs: 100,
    });
    return rows;`,
  );
  expect(found.result).toEqual([{ key: "room-1", price: "$101" }]);
  const hidden = await call(
    page,
    `await waitForRows(page.locator("#results > li"), { badge: ".badge" }, {
      count: 1, key: { attribute: "data-id" }, noProgressMs: 300, stableMs: 100,
    });`,
  );
  expect(hidden.error).toMatch(/: 1 identified rows of 1, needed 1; badge hidden in row 1; /u);
});

// A list of ten rows whose "Show more" loads ten more after `delayMs`: through the site's API when
// `request`, else in the page. While it loads, a spinner shows beside the list, or the list is
// aria-busy, or nothing shows but the request.
const growingList = (page: Page, sign: "spinner" | "busy" | "none", request: boolean, delayMs = 1500) =>
  site(
    page,
    `<main>
      <ol id="results"></ol><div id="loading-more"></div><button type="button">Show more</button>
    </main>
    <script>
      const list = document.querySelector("#results");
      const add = (from) => {
        for (let i = from; i < from + 10; i += 1)
          list.insertAdjacentHTML("beforeend", '<li data-id="r' + i + '"><h3>Row ' + i + '</h3></li>');
      };
      add(1);
      document.querySelector("button").onclick = async () => {
        if (${JSON.stringify(sign)} === "spinner")
          document.querySelector("#loading-more").innerHTML = '<div class="load-spinner" style="height: 20px"></div>';
        if (${JSON.stringify(sign)} === "busy") list.setAttribute("aria-busy", "true");
        if (${request}) await fetch("/api/more");
        else await new Promise((resolve) => setTimeout(resolve, ${delayMs}));
        add(11);
        document.querySelector("#loading-more").innerHTML = "";
        list.removeAttribute("aria-busy");
      };
    </script>`,
    async (path) => {
      if (path === "/api/more") await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { body: "{}" };
    },
  );

// A sign alone holds a list for the no-progress window, so those cases get a window longer than the
// load; a request the click started holds it until it ends, whatever the window.
const growBody = (noProgressMs: number) => `
  const { rows } = await waitForRows(page.locator("#results > li"), { name: "h3" }, {
    count: 20, key: { attribute: "data-id" }, noProgressMs: ${noProgressMs}, stableMs: 100, unchangedMs: 300, timeout: 4000,
    action: () => page.getByRole("button", { name: "Show more" }).click({ timeout: 1000 }),
  });
  return rows.length;`;

for (const [sign, request] of [
  ["spinner", true],
  ["none", true],
  ["spinner", false],
  ["busy", false],
] as const)
  test(`a "Show more" that loads for longer than the holds returns the grown list: ${sign} sign, ${request ? "site request" : "no request"}`, async ({
    page,
  }) => {
    await growingList(page, sign, request);
    expect(await call(page, growBody(request ? 400 : 2000))).toEqual({ result: 20 });
  });

test("a list still loading at the first look, with its spinner below the rows, returns every row", async ({
  page,
}) => {
  await page.setContent(`
    <main>
      <ol id="results"><li data-id="r1"><h3>Row 1</h3></li><li data-id="r2"><h3>Row 2</h3></li></ol>
      <div class="results-loader" style="height: 20px"></div>
    </main>
    <script>
      setTimeout(() => {
        for (let i = 3; i <= 10; i += 1)
          document.querySelector("#results").insertAdjacentHTML("beforeend", '<li data-id="r' + i + '"><h3>Row ' + i + '</h3></li>');
        document.querySelector(".results-loader").remove();
      }, 1500);
    </script>`);
  const answer = await call(
    page,
    `const { rows, more } = await waitForRows(page.locator("#results > li"), { name: "h3" }, {
      count: 10, key: { attribute: "data-id" }, noProgressMs: 2000, stableMs: 100, unchangedMs: 300, timeout: 4000,
    });
    return { count: rows.length, more };`,
  );
  expect(answer).toEqual({ result: { count: 10, more: false } });
});

test("a row whose key is only hidden is said to have its key hidden", async ({ page }) => {
  await page.setContent(`<ol id="results"><li><h3>Room 1</h3><span class="id" hidden>room-1</span></li></ol>`);
  const answer = await call(
    page,
    `await waitForRows(page.locator("#results > li"), { name: "h3" }, {
      count: 1, key: ".id", noProgressMs: 300, stableMs: 100,
    });`,
  );
  expect(answer.error).toMatch(/: 0 identified rows of 1, needed 1; key hidden in row 1; /u);
});

// Seven rows beside an element that only looks like a loader: kept in layout but invisible, a
// visible wrapper or sentinel the page never removes, or a busy region that never clears. With
// `more`, a "Show more" adds five rows.
const besideRows = (page: Page, sign: string, more = false) =>
  page.setContent(`
    <main${sign === "busy-main" ? ' aria-busy="true"' : ""}>
      <ol id="results"></ol>
      ${
        {
          hidden: '<div class="infinite-loader" style="height: 30px; visibility: hidden"></div>',
          transparent: '<div class="infinite-loader" style="height: 30px; opacity: 0"></div>',
          sentinel: '<div class="infinite-loader" style="height: 30px"></div>',
          wrapper: '<div class="loader-wrapper" style="padding: 10px"><button type="button">Show more</button></div>',
          "busy-main": "",
        }[sign]
      }
      ${more && sign !== "wrapper" ? '<button type="button">Show more</button>' : ""}
    </main>
    <script>
      const add = (from, to) => {
        for (let i = from; i <= to; i += 1)
          document.querySelector("#results").insertAdjacentHTML("beforeend", '<li data-id="r' + i + '"><h3>Row ' + i + '</h3></li>');
      };
      add(1, 7);
      for (const button of document.querySelectorAll("button")) button.onclick = () => setTimeout(() => add(8, 12), 100);
    </script>`);

const shortRead = (count: number, action = false, noProgressMs = 400) => `
  const started = Date.now();
  const { rows } = await waitForRows(page.locator("#results > li"), { name: "h3" }, {
    count: ${count}, key: { attribute: "data-id" }, noProgressMs: ${noProgressMs}, stableMs: 100, unchangedMs: 300, timeout: 8000,
    ${action ? 'action: () => page.getByRole("button", { name: "Show more" }).click({ timeout: 1000 }),' : ""}
  });
  return { count: rows.length, ms: Date.now() - started };`;

for (const sign of ["hidden", "transparent", "sentinel", "wrapper", "busy-main"])
  test(`a short list beside a loader that never leaves (${sign}) returns its rows within the no-progress window`, async ({
    page,
  }) => {
    await besideRows(page, sign);
    const answer = await call(page, shortRead(10));
    expect(answer.error).toBeUndefined();
    const result = answer.result as { count: number; ms: number };
    expect(result.count).toBe(7);
    expect(result.ms).toBeLessThan(2000);
  });

for (const sign of ["sentinel", "wrapper"])
  test(`a "Show more" beside a loader the page always shows (${sign}) returns the rows it added at once`, async ({
    page,
  }) => {
    await besideRows(page, sign, true);
    // A 4 s no-progress window: a sign held as new would keep the short list at least that long.
    const answer = await call(page, shortRead(20, true, 4000));
    expect(answer.error).toBeUndefined();
    const result = answer.result as { count: number; ms: number };
    expect(result.count).toBe(12);
    // The sign was there before the click, so it is the page's own: no hold.
    expect(result.ms).toBeLessThan(3000);
  });

// A long results page: `cards` cards whose image wrapper's class names a loader, as many sites mark
// an image still loading, after a Search button. A click runs `onSearch`, then shows the rooms after
// `answerMs`. `skipped` puts each card in content the browser skips rendering while off screen.
const hintedCards = (cards: number, { onSearch = "", answerMs = 300, skipped = false } = {}) => `
  <button type="button" id="search">Search</button><section id="answer"></section>
  <main>${`<div class="card"${skipped ? ' style="content-visibility: auto; contain-intrinsic-size: auto 40px"' : ""}><div class="card-image-loader" style="height: 4px"></div><span>Room</span></div>`.repeat(cards)}</main>
  <script>
    document.querySelector("#search").onclick = () => {
      ${onSearch}
      setTimeout(() => { document.querySelector("#answer").innerHTML = ${JSON.stringify(rooms)}; }, ${answerMs});
    };
  </script>`;

// One wait for the rooms after a click on Search. Its locators are plain CSS, which cost little on
// a long page, so the time it takes is the wait's own.
const searchWait = async (page: Page, noProgressMs: number): Promise<OutcomeAnswer> => {
  const answer = await call(
    page,
    `const started = Date.now();
    try {
      const shown = await waitForOutcome({ results: page.locator("#answer ul") }, {
        noProgressMs: ${noProgressMs}, timeout: 8000, action: () => page.locator("#search").click(),
      });
      return { shown, ms: Date.now() - started, report: waitReport() };
    } catch (error) {
      return { reason: error.reason, message: error.message, ms: Date.now() - started };
    }`,
  );
  if (answer.error !== undefined) throw new Error(answer.error);
  return answer.result as OutcomeAnswer;
};

/** Runs `use` on a page of a Patchright browser, whose locators evaluate in its isolated world. */
const onPatchright = async (use: (page: Page) => Promise<void>) => {
  const browser = await patchright.launch({ headless: true });
  try {
    // Patchright's page has Playwright's API, declared by its own copy of Playwright's types.
    await use((await browser.newPage()) as unknown as Page);
  } finally {
    await browser.close();
  }
};

// A Patchright locator's count costs time for each element it matches: counting every element whose
// class names a loader took seconds a look here, before the action and at each look after it.
test("on Patchright, a page full of elements whose classes name a loader costs each look one page call", async () => {
  await onPatchright(async (page) => {
    await page.setContent(hintedCards(400));
    const answer = await searchWait(page, 3000);
    expect(answer.shown).toBe("results");
    expect(answer.ms).toBeLessThan(3000);
  });
});

// Among hundreds of decorations from before the action, a skeleton that comes with it is still the
// page loading: it holds the wait past the no-progress window, and without it the wait ends sooner.
test("on Patchright, a skeleton that comes with the action holds the wait beside hundreds of decorations", async () => {
  await onPatchright(async (page) => {
    const skeleton = `document.querySelector("#answer").innerHTML = '<div class="results-skeleton" style="height: 40px"></div>';`;
    await page.setContent(hintedCards(400, { onSearch: skeleton, answerMs: 1300 }));
    const held = await searchWait(page, 800);
    expect(held, JSON.stringify(held)).toMatchObject({ shown: "results" });
    expect(held.report?.[0]?.summary).toMatch(/progress seen: loading sign /u);
    await page.setContent(hintedCards(400, { answerMs: 1300 }));
    expect((await searchWait(page, 800)).reason).toBe("outcome_unknown");
  });
});

// The look's one page call counts what a visible locator match counts: rendered, not hidden, with a
// box, or with display: contents a child element or text that shows, through open shadow roots. A
// sign in content the browser skips rendering does not show, and its box is never read: reading it
// would lay that content out, one element at a time, which took seconds with thousands of them.
test("a look counts the generic signs as visible matches, never in content the browser skips rendering", async ({
  page,
}) => {
  await page.setContent(`
    <div class="spinner" style="height: 10px"></div>
    <div class="results-skeleton" style="height: 10px; visibility: hidden"></div>
    <div class="loader" style="display: none"></div>
    <div class="loader-row" style="display: contents"><span style="display: inline-block; width: 10px; height: 10px"></span></div>
    <div class="loading-spinner" style="display: contents">Loading</div>
    <div class="spinner" style="height: 0"></div>
    <x-card></x-card>
    <div aria-busy="true" style="height: 10px"></div>
    <div style="content-visibility: auto; contain-intrinsic-size: auto 40px; margin-top: 4000px">
      <div class="loader" style="height: 10px"></div><div aria-busy="true" style="height: 10px"></div>
    </div>
    <script>
      customElements.define("x-card", class extends HTMLElement {
        connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = '<div class="shimmer" style="height: 10px"></div>'; }
      });
    </script>`);
  expect(await call(page, `return await page.evaluate(waitSignsInPage, waitSignsSpec);`)).toEqual({
    result: { signs: 1, classes: 4 },
  });
  // Within a region, only what its elements hold, their own shadow roots included.
  expect(await call(page, `return await page.locator("x-card").evaluateAll(waitSignsInPage, waitSignsSpec);`)).toEqual({
    result: { signs: 0, classes: 1 },
  });
});

// A page whose loaders each take 8 ms to measure: counting all 400 would hold every look for over
// three seconds, and the page runs one call at a time. A look stops counting class hints after its
// budget and takes them as unchanged, so the wait still answers at its own pace.
test("a look that runs out of time counting class hints takes them as unchanged", async ({ page }) => {
  const slowBoxes = `<script>
    const box = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      if (String(this.className).includes("loader")) for (const until = performance.now() + 8; performance.now() < until;);
      return box.call(this);
    };
  </script>`;
  await page.setContent(slowBoxes + hintedCards(400));
  const answer = await searchWait(page, 3000);
  expect(answer.shown).toBe("results");
  expect(answer.ms).toBeLessThan(3000);
  expect(answer.report?.[0]?.summary).not.toMatch(/loading sign/u);
});
