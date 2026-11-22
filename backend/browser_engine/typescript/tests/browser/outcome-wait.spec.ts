import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Schema } from "effect";
import { outcomeWaitCode } from "../../src/browser/outcome-wait.js";
import { defineOperation } from "../../src/runtime/operation.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";
import { failure, runExample } from "./authoring-fixture.js";

// The authoring library's outcome wait, run as a Kernel call body runs it (`page` in scope) on
// local search pages. Chromium must render them: an outcome counts only when it is visible.
const call = async (page: Page, body: string) => {
  const answer = await makeLocalKernel(page).browsers.playwright.execute("session-1", {
    timeout_sec: 10,
    code: `${outcomeWaitCode}\n${body}`,
  });
  return answer.success ? { result: answer.result } : { error: answer.error };
};

/**
 * A search page whose answer shows `delayMs` after the search: `html` replaces the busy
 * placeholder. Every outcome the waits below name sits in `#answer`.
 */
const searchPage = (page: Page, html: string, delayMs = 150) =>
  page.setContent(`
    <section id="answer"><p>Searching</p></section>
    <script>
      setTimeout(() => { document.querySelector("#answer").innerHTML = ${JSON.stringify(html)}; }, ${delayMs});
    </script>`);

// Refusal and error first, then the empty state, then results.
const waitBody = (timeout: number) => `
  const answer = page.locator("#answer");
  return await waitForOutcome({
    failed: answer.getByRole("alert"),
    empty: answer.getByText("No rooms match your dates", { exact: true }),
    results: answer.getByRole("list", { name: "Rooms", exact: true }),
  }, { timeout: ${timeout} });
`;

const rooms = `<ul aria-label="Rooms"><li>Garden room</li><li>Courtyard room</li></ul>`;

test("a search that shows its empty state returns the empty outcome, not a timeout", async ({
  page,
}) => {
  await searchPage(page, `<p>No rooms match your dates</p>`);
  expect(await call(page, waitBody(5000))).toEqual({ result: "empty" });
});

test("a delayed result appears after the busy state", async ({ page }) => {
  await searchPage(page, rooms, 400);
  expect(await call(page, waitBody(5000))).toEqual({ result: "results" });
});

test("the site's error wins over results shown beside it", async ({ page }) => {
  await searchPage(page, `<div role="alert">Search is unavailable</div>${rooms}`);
  expect(await call(page, waitBody(5000))).toEqual({ result: "failed" });
});

test("the site's error drawn beside partial results between two reads of one look wins", async ({
  page,
}) => {
  // The page draws its error banner and the rooms it could load in one render, as the look's
  // first outcome read ends. Results read before that render, and the error after it, would
  // return the results.
  await page.setContent(`<section id="answer"><p>Searching</p></section>`);
  const partial = `<div role="alert">Some rooms could not load</div><ul aria-label="Rooms"><li>Garden room</li></ul>`;
  expect(
    await call(
      page,
      `const answer = page.locator("#answer");
      let drawn = false;
      // Each outcome as the wait reads it: the page draws once the first count read ends.
      const drawAfterFirstRead = (locator) => ({
        count: async () => {
          const count = await locator.count();
          if (!drawn) {
            drawn = true;
            await page.evaluate((html) => { document.querySelector("#answer").innerHTML = html; }, ${JSON.stringify(partial)});
          }
          return count;
        },
        filter: (options) => locator.filter(options),
      });
      return await waitForOutcome({
        failed: drawAfterFirstRead(answer.getByRole("alert")),
        empty: drawAfterFirstRead(answer.getByText("No rooms match your dates", { exact: true })),
        results: drawAfterFirstRead(answer.getByRole("list", { name: "Rooms", exact: true })),
      }, { timeout: 5000 });`,
    ),
  ).toEqual({ result: "failed" });
});

test("a hidden copy makes the winning outcome ambiguous until its locator is scoped to visible elements", async ({
  page,
}) => {
  const empty = `No rooms match your dates`;
  await searchPage(page, `<p hidden>${empty}</p><p>${empty}</p>`);
  const ambiguous = await call(page, waitBody(5000));
  expect(ambiguous.error).toBe(
    "outcome_ambiguous: failed 0 visible of 0, empty 1 visible of 2, results 0 visible of 0",
  );
  const scoped = await call(
    page,
    `return await waitForOutcome({
      empty: page.getByText(${JSON.stringify(empty)}, { exact: true }).filter({ visible: true }),
      results: page.getByRole("list", { name: "Rooms", exact: true }),
    }, { timeout: 5000 });`,
  );
  expect(scoped).toEqual({ result: "empty" });
});

test("two visible matches of the winning outcome fail as ambiguous without picking one", async ({
  page,
}) => {
  await searchPage(page, `${rooms}${rooms}`);
  expect(
    await call(
      page,
      `try { ${waitBody(5000)} } catch (error) {
        return { name: error.name, reason: error.reason, outcome: error.outcome, observations: error.observations };
      }`,
    ),
  ).toEqual({
    result: {
      name: "OutcomeWaitFailure",
      reason: "outcome_ambiguous",
      outcome: "results",
      observations: {
        failed: { count: 0, visible: 0 },
        empty: { count: 0, visible: 0 },
        results: { count: 2, visible: 2 },
      },
    },
  });
});

test("an ambiguous outcome below the winner does not block it", async ({ page }) => {
  await searchPage(page, `<p>No rooms match your dates</p>${rooms}${rooms}`);
  expect(await call(page, waitBody(5000))).toEqual({ result: "empty" });
});

test("a timeout says what each outcome matched", async ({ page }) => {
  // The empty state is on the page but hidden, and the answer never comes.
  await searchPage(page, `<p hidden>No rooms match your dates</p><p>Still searching</p>`, 50);
  const { error } = await call(page, waitBody(300));
  // What it saw of the page's progress depends on when its first look came; the counts do not.
  expect(error).toMatch(
    /^outcome_timeout after 300 ms: failed 0 visible of 0, empty 0 visible of 1, results 0 visible of 0; /u,
  );
});

test("a no-results page for the query is the empty outcome", async ({ page }) => {
  await searchPage(page, `<h1>Search</h1><p>No rooms match your dates</p><a href="#">Clear dates</a>`);
  expect(await call(page, waitBody(5000))).toEqual({ result: "empty" });
});

test("a greyed-out choice is its own outcome, recognized at once", async ({ page }) => {
  await page.setContent(`
    <div role="grid" aria-label="March">
      <div role="row">
        <button role="gridcell" aria-disabled="true">14</button>
        <button role="gridcell">15</button>
      </div>
    </div>`);
  // A short timeout: had the wait looked only for an enabled day, it would time out.
  const day = (disabled: boolean) =>
    `page.getByRole("grid", { name: "March" }).getByRole("gridcell", { name: "14", exact: true, disabled: ${disabled} })`;
  expect(
    await call(
      page,
      `return await waitForOutcome({ unavailable: ${day(true)}, available: ${day(false)} }, { timeout: 1000 });`,
    ),
  ).toEqual({ result: "unavailable" });
});

/**
 * Results that a filter changes: clicking "Pets allowed" re-renders the list `delayMs` later,
 * after the click returns. `rendering` says how: `replace` swaps in a new list element, `inPlace`
 * rewrites the same list's rows, `same` leaves the list as it was, and `empty` replaces it with the
 * empty state.
 */
const filteredResults = (
  page: Page,
  rendering: "replace" | "inPlace" | "same" | "empty",
  delayMs = 300,
) =>
  page.setContent(`
    <button type="button">Pets allowed</button>
    <section id="answer">${rooms.replace("</ul>", "<li>Loft room</li></ul>")}</section>
    <script>
      document.querySelector("button").onclick = () => setTimeout(() => {
        const answer = document.querySelector("#answer");
        const rendering = ${JSON.stringify(rendering)};
        if (rendering === "replace") answer.innerHTML = ${JSON.stringify(rooms)};
        if (rendering === "inPlace") answer.querySelector("ul").innerHTML = "<li>Garden room</li>";
        if (rendering === "empty") answer.innerHTML = "<p>No rooms match your dates</p>";
      }, ${delayMs});
    </script>`);

/** Applies the filter as the wait's action, then reads the rooms the answer lists. */
const filterBody = (options: string) => `
  const answer = page.locator("#answer");
  const shown = await waitForOutcome({
    failed: answer.getByRole("alert"),
    empty: answer.getByText("No rooms match your dates", { exact: true }),
    results: answer.getByRole("list", { name: "Rooms", exact: true }),
  }, { action: () => page.getByRole("button", { name: "Pets allowed" }).click(), ${options} });
  return { shown, rooms: shown === "results" ? await answer.getByRole("listitem").allInnerTexts() : [] };
`;

test("after an action, the results from before it are not the answer", async ({ page }) => {
  // A long unchanged window: only the re-render, not the window, can end this wait in time.
  for (const rendering of ["replace", "inPlace"] as const) {
    await filteredResults(page, rendering);
    expect(await call(page, filterBody("timeout: 3000, unchangedMs: 5000"))).toEqual({
      result: { shown: "results", rooms: rendering === "replace" ? ["Garden room", "Courtyard room"] : ["Garden room"] },
    });
  }
  await filteredResults(page, "empty");
  expect(await call(page, filterBody("timeout: 3000, unchangedMs: 5000"))).toEqual({
    result: { shown: "empty", rooms: [] },
  });
});

test("after an action that leaves the results as they were, the wait ends after its unchanged window", async ({
  page,
}) => {
  await filteredResults(page, "same");
  expect(await call(page, filterBody("timeout: 3000, unchangedMs: 300"))).toEqual({
    result: { shown: "results", rooms: ["Garden room", "Courtyard room", "Loft room"] },
  });
  // Within a timeout shorter than the window, the unchanged results are no answer.
  await filteredResults(page, "same");
  const { error } = await call(page, filterBody("timeout: 300, unchangedMs: 5000"));
  expect(error).toBe(
    "outcome_timeout after 300 ms: failed 0 visible of 0, empty 0 visible of 0, results 1 visible of 1, unchanged; no progress seen",
  );
});

/**
 * Results on a site page whose "Pets allowed" filter asks the site for its answer, which comes
 * `answerMs` later, or never when it is `Infinity`: `replace` redraws the list with one room, `same`
 * leaves it as it was. Returns a function that gives when the site last answered, by `Date.now()`.
 */
const filterOverNetwork = async (page: Page, answerMs: number, rendering: "replace" | "same") => {
  const origin = "https://rooms.example.test";
  let answeredAt = Number.NaN;
  await page.route(`${origin}/**`, async (route) => {
    if (new URL(route.request().url()).pathname === "/rooms") {
      // Left unanswered, the request stays in flight, as a long-poll or a stream does.
      if (answerMs === Infinity) return;
      await new Promise((resolve) => setTimeout(resolve, answerMs));
      answeredAt = Date.now();
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(rendering === "replace" ? ["Garden room"] : null),
      });
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body: `<button type="button">Pets allowed</button>
        <section id="answer">${rooms.replace("</ul>", "<li>Loft room</li></ul>")}</section>
        <script>
          document.querySelector("button").onclick = async () => {
            const names = await (await fetch("/rooms?pets=1")).json();
            if (names !== null)
              document.querySelector("#answer").innerHTML =
                '<ul aria-label="Rooms">' + names.map((name) => "<li>" + name + "</li>").join("") + "</ul>";
          };
        </script>`,
    });
  });
  await page.goto(`${origin}/`);
  return () => answeredAt;
};

/** Runs `body`, an async function body that returns an object, and adds how long it took. */
const timed = (body: string) => `
  const started = Date.now();
  const answer = await (async () => { ${body} })();
  return { ...answer, elapsed: Date.now() - started };
`;

/** How long a `timed` body took, in milliseconds. */
const elapsed = (answer: { result?: unknown }) =>
  (answer.result as { elapsed?: number } | undefined)?.elapsed ?? Number.NaN;

test("a filter whose answer comes after the unchanged window returns the redrawn list", async ({
  page,
}) => {
  // The answer comes after the default 2 s window: the list from before the filter is no answer
  // while the request the filter started is still in flight.
  await filterOverNetwork(page, 2500, "replace");
  expect(await call(page, filterBody("timeout: 8000"))).toEqual({
    result: { shown: "results", rooms: ["Garden room"] },
  });
});

test("a filter whose slow answer ends while a look reads the old list returns the redrawn list", async ({
  page,
}) => {
  // The site answers after the 2 s window and redraws the list 50 ms later. The answer is held
  // until a look after the window has read the list from before the filter, and released as that
  // look's read of the list ends, so the request ends while the look runs, before it is judged. The
  // returning look's own changed count shows whether it returned the old list, whatever the page
  // shows by the time the rooms are read.
  const origin = "https://rooms.example.test";
  await page.route(`${origin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<button type="button">Pets allowed</button>
        <section id="answer">${rooms.replace("</ul>", "<li>Loft room</li></ul>")}</section>
        <script>
          document.querySelector("button").onclick = async () => {
            const names = await (await fetch("/rooms?pets=1")).json();
            setTimeout(() => {
              document.querySelector("#answer").innerHTML =
                '<ul aria-label="Rooms">' + names.map((name) => "<li>" + name + "</li>").join("") + "</ul>";
            }, 50);
          };
        </script>`,
    }),
  );
  await page.goto(`${origin}/`);
  const filtered = await call(
    page,
    `let release;
      const held = new Promise((resolve) => { release = resolve; });
      await page.route("**/rooms?pets=1", async (route) => {
        await held;
        await route.fulfill({ contentType: "application/json", body: JSON.stringify(["Garden room"]) });
      });
      const answered = page.waitForEvent("requestfinished", (request) => request.url().endsWith("/rooms?pets=1"));
      const answer = page.locator("#answer");
      const list = answer.getByRole("list", { name: "Rooms", exact: true });
      let clicked = Infinity;
      let changed;
      // The list as the wait reads it, whose changed-text read is the list's last read in each look.
      const results = {
        count: () => list.count(),
        filter: (options) => {
          const visible = list.filter(options);
          return {
            count: () => visible.count(),
            evaluateAll: async (fn, arg) => {
              const read = await visible.evaluateAll(fn, arg);
              changed = read;
              if (Date.now() - clicked > 2100) {
                release();
                await answered;
              }
              return read;
            },
          };
        },
      };
      const shown = await waitForOutcome({ failed: answer.getByRole("alert"), results }, {
        action: async () => {
          await page.getByRole("button", { name: "Pets allowed" }).click();
          clicked = Date.now();
        },
        timeout: 8000,
      });
      return { shown, changed, rooms: await answer.getByRole("listitem").allInnerTexts() };`,
  );
  expect(filtered).toMatchObject({ result: { shown: "results" } });
  expect((filtered.result as { changed?: number } | undefined)?.changed).toBeGreaterThan(0);
  expect(filtered).toMatchObject({ result: { rooms: ["Garden room"] } });
});

test("a request the filter started that never ends delays the unchanged list, never past the deadline", async ({
  page,
}) => {
  // The request stays in flight past the deadline, and the list stays as it was. The list from
  // before the filter counts once the wait's deadline less its unchanged window comes, so the
  // wait returns it, as it did before such a request held it back, rather than timing out. The
  // list coming back, not outcome_timeout, shows it counted before the deadline.
  await filterOverNetwork(page, Infinity, "same");
  const answer = await call(page, timed(filterBody("timeout: 8000")));
  expect(answer).toMatchObject({
    result: { shown: "results", rooms: ["Garden room", "Courtyard room", "Loft room"] },
  });
  expect(elapsed(answer)).toBeGreaterThanOrEqual(6000);
});

test("an already-settled page adds no extra delay", async ({ page }) => {
  const answeredAt = await filterOverNetwork(page, 1500, "same");
  // With no action, the answer on the page counts at its first look, well inside the 2 s
  // unchanged window.
  const settled = await call(
    page,
    timed(`return { shown: await waitForOutcome({
      results: page.locator("#answer").getByRole("list", { name: "Rooms", exact: true }),
    }, { timeout: 5000 }) };`),
  );
  expect(settled).toMatchObject({ result: { shown: "results" } });
  expect(elapsed(settled)).toBeLessThan(1000);
  // A filter whose request ended before its unchanged window, leaving the list as it was, still
  // ends at that window, about 0.5 s after the site's answer at 1.5 s, not a window after the
  // answer. Timed from the answer, a slow page before the click cannot push it past the bound, and
  // a window counted from the request's end never ends inside it. The 8 s timeout keeps the
  // deadline's own limit on the hold, at 6 s, out of the way.
  const unchanged = await call(page, timed(filterBody("timeout: 8000, unchangedMs: 2000")));
  const sinceAnswer = Date.now() - answeredAt();
  expect(unchanged).toMatchObject({
    result: { shown: "results", rooms: ["Garden room", "Courtyard room", "Loft room"] },
  });
  expect(elapsed(unchanged)).toBeGreaterThanOrEqual(2000);
  expect(sinceAnswer).toBeLessThan(2000);
});

test("an action that loads a new page waits for that page's answer", async ({ page }) => {
  const origin = "https://rooms.example.test";
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    // The old page lists rooms too: only the new page's answer counts.
    await route.fulfill({
      contentType: "text/html",
      body:
        url.pathname === "/search"
          ? `<section id="answer"><p>No rooms match your dates</p></section>`
          : `<form action="/search"><button>Search</button></form><section id="answer">${rooms}</section>`,
    });
  });
  await page.goto(`${origin}/`);
  expect(
    await call(
      page,
      `const answer = page.locator("#answer");
      return await waitForOutcome({
        empty: answer.getByText("No rooms match your dates", { exact: true }),
        results: answer.getByRole("list", { name: "Rooms", exact: true }),
      }, { action: () => page.getByRole("button", { name: "Search" }).click(), timeout: 3000, unchangedMs: 5000 });`,
    ),
  ).toEqual({ result: "empty" });
});

/**
 * A page that pre-renders its error and empty state hidden: the click shows `shows` 200 ms later,
 * and for the error also re-renders the results beside it.
 */
const prerendered = (page: Page, shows: "error" | "empty") =>
  page.setContent(`
    <button type="button">Pets allowed</button>
    <section id="answer">
      <p id="error" hidden>Search is unavailable</p>
      <p id="empty" hidden>No rooms match your dates</p>
      ${shows === "error" ? rooms : ""}
    </section>
    <script>
      document.querySelector("button").onclick = () => setTimeout(() => {
        document.querySelector(${JSON.stringify(`#${shows}`)}).hidden = false;
        if (${JSON.stringify(shows)} === "error")
          document.querySelector("ul").outerHTML = ${JSON.stringify(rooms)};
      }, 200);
    </script>`);

const prerenderedBody = (options: string) => `
  const answer = page.locator("#answer");
  return await waitForOutcome({
    failed: answer.getByText("Search is unavailable", { exact: true }),
    empty: answer.getByText("No rooms match your dates", { exact: true }),
    results: answer.getByRole("list", { name: "Rooms", exact: true }),
  }, { action: () => page.getByRole("button", { name: "Pets allowed" }).click(), ${options} });
`;

test("an error hidden before the action and shown beside re-rendered results wins", async ({
  page,
}) => {
  await prerendered(page, "error");
  expect(await call(page, prerenderedBody("timeout: 3000, unchangedMs: 5000"))).toEqual({
    result: "failed",
  });
});

test("an empty state hidden before the action and shown by it answers at once", async ({
  page,
}) => {
  // A timeout shorter than the unchanged window: only counting it as new ends the wait in time.
  await prerendered(page, "empty");
  expect(await call(page, prerenderedBody("timeout: 1500, unchangedMs: 5000"))).toEqual({
    result: "empty",
  });
});

// A tool whose call fails on its wait, run through the runtime: it rethrows the call's error, as
// the authoring references do.
const waitingTool = defineOperation(
  { input: Schema.Struct({}), output: Schema.String },
  async ({ kernel, sessionId, errors }) => {
    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 10,
      code: `${outcomeWaitCode}
        return await waitForOutcome({
          empty: page.getByText("No rooms match your dates", { exact: true }),
          results: page.getByRole("list", { name: "Rooms", exact: true }),
        }, { timeout: 300 });`,
    });
    if (!answer.success)
      throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
    return String(answer.result);
  },
);

test("a tool whose outcome wait times out fails as a browser action timeout", async ({ page }) => {
  await page.setContent(`<p>Searching</p>`);
  expect(failure((await runExample(page, waitingTool, {})).result)).toMatchObject({
    _tag: "BrowserActionTimeout",
  });
  // An ambiguous answer stays the tool's own failure.
  await page.setContent(`${rooms}${rooms}`);
  expect(failure((await runExample(page, waitingTool, {})).result)).toMatchObject({
    _tag: "OperationFailure",
  });
});
