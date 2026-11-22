import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import type { Page, Route } from "playwright";
import { Effect, Either, Exit, Schema, Scope } from "effect";
import authEntry from "../../authoring/examples/auth-entry.js";
import chooseAirport from "../../authoring/examples/custom-selection.js";
import setDeparture from "../../authoring/examples/dates-and-dropdowns.js";
import attachDocument, {
  downloadStatement,
  pickTravelDate,
} from "../../authoring/examples/dates-and-files.js";
import dialogPicker from "../../authoring/examples/dialog-picker.js";
import deleteInvoice from "../../authoring/examples/native-dialog.js";
import readHeading from "../../authoring/examples/native-page.js";
import readCatalog, {
  detailFromUrl,
  detailNavigation,
  searchThenRead,
} from "../../authoring/examples/navigation.js";
import searchListings, { readRooms } from "../../authoring/examples/pagination.js";
import searchOrigin from "../../authoring/examples/picker-first.js";
import assignOwner from "../../authoring/examples/picker.js";
import selectStatus from "../../authoring/examples/selection.js";
import readInvoiceIds from "../../authoring/examples/variants.js";
import createTask from "../../authoring/examples/write-readback.js";
import placeOrder, {
  checkReview,
  fillStep,
  OrderInput,
  placeAndConfirm,
  placeStep,
} from "../../authoring/examples/write-session.js";
import { formControlsCode } from "../../src/browser/form-controls.js";
import { asksAsDeclared } from "../../src/execution/declared-questions.js";
import type { InputRequest } from "../../src/runtime/input-request.js";
import { defineOperation } from "../../src/runtime/operation.js";
import { sameText } from "../../src/runtime/text.js";
import {
  admitListCursor,
  randomListCursorKeys,
  sealListOutput,
  type ListCursorScope,
} from "../../src/runtime/list-cursor.js";

import { makeEffectJournal } from "../../src/runtime/context.js";
import { commitEvidenceOf, commitRetryRefusal, unenteredWrite } from "../../src/runtime/run-outcome.js";
import { runExample, failure, localFiles } from "./authoring-fixture.js";

const dialogPickerFixture = async (page: Page, mode: "success" | "ambiguous" | "no_commit") => {
  await page.setContent(
    [
      "<button type='button' id='launcher'>Choose catalog item</button>",
      "<input aria-label='Selected catalog key' value='A' readonly>",
      "<output id='opens'>0</output><output id='commits'>0</output>",
      "<output id='stale-clicks'>0</output><output id='replacements'>0</output>",
      "<output id='early-clicks'>0</output><div id='mount'></div>",
      "<div role='dialog' aria-label='Catalog item picker' hidden>",
      "<input aria-label='Find catalog item'><div role='option' data-key='B'>B</div></div>",
      "<script>",
      "const mode = '" + mode + "';",
      "document.querySelector('[hidden] [role=option]').onclick = () => { document.querySelector('#stale-clicks').textContent++; };",
      "document.querySelector('#launcher').onclick = () => {",
      " document.querySelector('#opens').textContent++;",
      " setTimeout(() => {",
      "  const mount = document.querySelector('#mount');",
      "  mount.innerHTML = \"<div role='dialog' aria-label='Catalog item picker' data-query='old'><input aria-label='Find catalog item'><div role='option' data-key='B'>B</div></div>\";",
      "  const dialog = mount.querySelector('[role=dialog]');",
      "  dialog.onclick = (event) => {",
      "   const item = event.target.closest('[role=option]'); if (!item) return;",
      "   document.querySelector('#commits').textContent++;",
      "   if (dialog.dataset.query !== 'item b') document.querySelector('#early-clicks').textContent++;",
      "   if (mode !== 'no_commit') document.querySelector('[aria-label=\"Selected catalog key\"]').value = item.dataset.key;",
      "  };",
      "  dialog.querySelector('input').oninput = (event) => {",
      "   const current = event.target;",
      "   const replacement = current.cloneNode(); replacement.value = current.value;",
      "   current.replaceWith(replacement);",
      "   document.querySelector('#replacements').textContent++;",
      "   setTimeout(() => {",
      "    dialog.dataset.query = replacement.value;",
      "    dialog.querySelectorAll('[role=option]').forEach((item) => item.remove());",
      "    const count = mode === 'ambiguous' ? 2 : 1;",
      "    for (let i = 0; i < count; i++) {",
      "     const item = document.createElement('div'); item.setAttribute('role', 'option');",
      "     item.dataset.key = 'B'; item.textContent = 'B'; dialog.append(item);",
      "    }",
      "   }, 100);",
      "  };",
      " }, 70);",
      "};",
      "</script>",
    ].join(""),
  );
};

test("current-page example checks the site and reads without navigating, in one call", async ({
  page,
}) => {
  const siteOrigin = "https://invoices.example.test";
  let requests = 0;
  await page.route("**/*", async (route) => {
    requests += 1;
    await route.fulfill({ contentType: "text/html", body: "<h1>Invoices</h1>" });
  });
  await page.goto(`${siteOrigin}/account`);
  const read = await runExample(page, readHeading, {}, { siteOrigin });
  expect(read.result).toEqual(Either.right({ heading: "Invoices" }));
  expect(read.calls).toHaveLength(1);
  // A sibling subdomain is the same site, as after an entry redirect from flights. to invoices.
  const sibling = await runExample(
    page,
    readHeading,
    {},
    { siteOrigin: "https://flights.example.test" },
  );
  expect(sibling.result).toEqual(Either.right({ heading: "Invoices" }));
  // Another registrable domain, and one that is only a suffix of the host's text, are not.
  for (const other of ["https://another.example.invalid", "https://ample.test"]) {
    const read = await runExample(page, readHeading, {}, { siteOrigin: other });
    expect(failure(read.result)).toMatchObject({ _tag: "OperationFailure", dispatch: "not_sent" });
  }
  expect(requests).toBe(1);
  expect(page.url()).toBe(`${siteOrigin}/account`);
});

// The site is the host's registrable domain, never the last labels of the origin: a multi-label
// public suffix or another tenant's page on a private suffix is another site, and a site with no
// registrable domain is its exact origin alone.
for (const [siteOrigin, pageUrl, reads] of [
  ["https://shop.example.co.uk", "https://www.example.co.uk/account", true],
  ["https://shop.example.co.uk", "https://other.co.uk/account", false],
  ["https://alice.github.io", "https://bob.github.io/account", false],
  ["https://localhost", "https://localhost/account", true],
  ["https://localhost", "https://app.localhost/account", false],
] as const)
  test(`current-page example for ${siteOrigin} ${reads ? "reads" : "refuses"} ${pageUrl}`, async ({
    page,
  }) => {
    await page.route("**/*", (route) =>
      route.fulfill({ contentType: "text/html", body: "<h1>Invoices</h1>" }),
    );
    await page.goto(pageUrl);
    const { result } = await runExample(page, readHeading, {}, { siteOrigin });
    if (reads) expect(result).toEqual(Either.right({ heading: "Invoices" }));
    else expect(failure(result)).toMatchObject({ _tag: "OperationFailure", dispatch: "not_sent" });
  });

for (const clears of [true, false]) {
  test(`catalog example ${clears ? "waits past" : "reports"} a verification page without navigating again`, async ({
    page,
  }) => {
    const siteOrigin = "https://catalog.example.invalid";
    let requests = 0;
    await page.route(`${siteOrigin}/**`, async (route) => {
      requests += 1;
      const ready = new URL(route.request().url()).searchParams.has("verified");
      await route.fulfill({
        contentType: "text/html",
        body: ready
          ? "<h1>Catalog</h1>"
          : `<p>Verifying your browser</p>${clears ? '<script>setTimeout(() => location.replace("/catalog?verified=1"), 80)</script>' : ""}`,
      });
    });
    const { result, calls } = await runExample(
      page,
      readCatalog,
      {},
      { siteOrigin, deadlineMs: clears ? 10_000 : 1_500 },
    );
    expect(calls.filter((code) => code.includes("page.goto"))).toHaveLength(1);
    expect(requests).toBe(clears ? 2 : 1);
    if (clears) expect(result).toEqual(Either.right({ heading: "Catalog" }));
    else expect(Either.isLeft(result)).toBe(true);
  });
}

test("catalog example treats a page showing both its heading and the verification text as the verification page", async ({
  page,
}) => {
  const siteOrigin = "https://catalog.example.invalid";
  let requests = 0;
  await page.route(`${siteOrigin}/**`, async (route) => {
    requests += 1;
    await route.fulfill({
      contentType: "text/html",
      body: `<h1>Catalog</h1><p>Verifying your browser</p>`,
    });
  });
  const { result } = await runExample(page, readCatalog, {}, { siteOrigin });
  // The verification wait passes at once, since the heading is ready, and the page loads once.
  expect(result).toEqual(Either.right({ heading: "Catalog" }));
  expect(requests).toBe(1);
});

// A records site reached through its own controls: its entry page has a search box, the search lists
// matching records as links, or says none match, and each record opens behind its own
// interstitial. record_7's page belongs to another record, and record_5's link lands on another
// path. record_8's results load late behind a busy region, and a search for record_down fails.
const recordsSite = async (page: Page, origin: string) => {
  const opened: string[] = [];
  const searches: string[] = [];
  const records = ["record_42", "record_420", "record_7", "record_5", "record_8"];
  await page.route(`${origin}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/favicon.ico") opened.push(url.pathname);
    const html = (body: string) => route.fulfill({ contentType: "text/html", body });
    if (url.pathname === "/")
      return html(`<form role="search" action="/search">
          <input type="search" name="q" aria-label="Record ID"><button>Search</button>
        </form>`);
    if (url.pathname === "/search") {
      const query = url.searchParams.get("q") ?? "";
      searches.push(query);
      if (query === "record_down")
        return route.fulfill({
          status: 503,
          contentType: "text/html",
          body: `<div role="alert">Search is unavailable. Try again later.</div>`,
        });
      const found = records.filter((id) => id.includes(query));
      const listed =
        found.map((id) => `<a href="/records/${id}">${id}</a>`).join("") ||
        `<p role="status">No matching records</p>`;
      if (query === "record_8")
        return html(`<section role="region" aria-label="Search results" aria-busy="true"><p>Loading results</p></section>
          <script>setTimeout(() => {
            const results = document.querySelector("section");
            results.innerHTML = ${JSON.stringify(listed)};
            results.setAttribute("aria-busy", "false");
          }, 800)</script>`);
      return html(`<section role="region" aria-label="Search results">${listed}</section>`);
    }
    if (url.pathname === "/records/record_5")
      return html(`<script>location.replace("/records/archived")</script>`);
    if (url.pathname === "/records/record_gone")
      return route.fulfill({ status: 404, contentType: "text/html", body: `<h1>Record not found</h1>` });
    if (url.pathname === "/records/record_blank") return html(`<main><p>Welcome back</p></main>`);
    const shown = url.pathname === "/records/record_7" ? "record_42" : url.pathname.slice(9);
    return html(`<section role="region" aria-label="Continue to record" data-record-id="${shown}">
        <button onclick="this.closest('section').outerHTML = '<section role=region aria-label=\\'Record details\\' data-record-id=${shown}><h1>Quarterly report</h1></section>'">Continue</button>
      </section>`);
  });
  return { opened, searches };
};

test("detail example searches the site for the record, follows its link and checks its identity", async ({
  page,
}) => {
  const origin = "https://records.example.invalid";
  const site = await recordsSite(page, origin);
  const read = async (record_id: string) => {
    const run = await runExample(page, detailNavigation, { record_id }, { siteOrigin: origin });
    // No call builds a URL from the caller's input: the record's page comes from its link.
    for (const code of run.calls) expect(code).not.toContain(`/records/${record_id}`);
    return run.result;
  };
  expect(await read("record_42")).toEqual(
    Either.right({ record_id: "record_42", title: "Quarterly report" }),
  );
  expect(site.searches).toEqual(["record_42"]);
  expect(site.opened).toEqual(["/", "/search", "/records/record_42"]);
  expect(failure(await read("record_7"))).toMatchObject({
    _tag: "OperationFailure",
    message: "identity_mismatch",
  });
  // The final path is checked against the link's own href.
  expect(failure(await read("record_5"))).toMatchObject({
    _tag: "OperationFailure",
    message: "target_mismatch",
  });
  // The site's search says no record matches, so the caller's value is at fault.
  expect(failure(await read("record_9"))).toMatchObject({
    _tag: "InvalidInput",
    message: "The site's search lists no record with this ID",
    field: "record_id",
  });
  // Results still loading, or a search that failed, say nothing about the caller's value.
  expect(await read("record_8")).toEqual(
    Either.right({ record_id: "record_8", title: "Quarterly report" }),
  );
  expect(failure(await read("record_down"))).toMatchObject({
    _tag: "OperationFailure",
    message: "results_unavailable",
  });
  expect(site.searches).toEqual([
    "record_42",
    "record_7",
    "record_5",
    "record_9",
    "record_8",
    "record_down",
  ]);
});

// A details tool whose input is the record's page URL opens that URL as the caller gave it, never
// rebuilt and without the site's search, and still reads the record's identity from the page.
test("detail example opens the caller's record URL unchanged and checks the page's identity", async ({
  page,
}) => {
  const origin = "https://records.example.invalid";
  const site = await recordsSite(page, origin);
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  const read = async (record_url: string) =>
    (await runExample(page, detailFromUrl, { record_url }, { siteOrigin: origin })).result;
  const link = `${origin}/records/record_42?from=list#top`;
  expect(await read(link)).toEqual(
    Either.right({ record_id: "record_42", title: "Quarterly report" }),
  );
  expect(site.opened).toEqual(["/records/record_42"]);
  expect(requested).toContain(`${origin}/records/record_42?from=list`);
  expect(site.searches).toEqual([]);
  // The page the link opens shows another record.
  expect(failure(await read(`${origin}/records/record_7`))).toMatchObject({
    _tag: "OperationFailure",
    message: "identity_mismatch",
  });
  // A link off the tool's site, or not https, is the caller's error, and nothing opens.
  const before = site.opened.length;
  for (const offSite of [
    "https://records.other.invalid/records/record_42",
    "http://records.example.invalid/records/record_42",
  ])
    expect(failure(await read(offSite))).toMatchObject({ _tag: "InvalidInput", field: "record_url" });
  expect(site.opened).toHaveLength(before);
});

test("detail example reports the site's not-found page for a record URL at once", async ({ page }) => {
  const origin = "https://records.example.invalid";
  await recordsSite(page, origin);
  const started = Date.now();
  const { result } = await runExample(
    page,
    detailFromUrl,
    { record_url: `${origin}/records/record_gone` },
    { siteOrigin: origin },
  );
  expect(failure(result)).toMatchObject({
    _tag: "InvalidInput",
    message: "The site has no record at this URL",
    field: "record_url",
  });
  expect(Date.now() - started).toBeLessThan(3000);
});

test("detail example fails a record URL whose page shows no answer once the page stops progressing", async ({
  page,
}) => {
  test.info().annotations.push({
    type: "slow",
    description: "The example uses the runtime's 8 s no-progress budget, which a test cannot inject.",
  });
  const origin = "https://records.example.invalid";
  await recordsSite(page, origin);
  const started = Date.now();
  const { result } = await runExample(
    page,
    detailFromUrl,
    { record_url: `${origin}/records/record_blank` },
    { siteOrigin: origin },
  );
  expect(failure(result)).toMatchObject({ _tag: "BrowserActionTimeout" });
  expect(String((failure(result) as { message: string }).message)).toMatch(/^outcome_unknown after /u);
  // Well before the 30 s cap.
  expect(Date.now() - started).toBeLessThan(15_000);
});

// A rooms site whose search the build proved reachable by its results URL, /search?q=. Site
// "proved" still answers that URL; "moved" now sends it to the entry page and its search box
// submits to /find?term=; "ignored" answers /search for its last query whatever q says, and its
// search box submits ?query=. Every results page shows its search box holding the query it answers.
const roomsSite = async (page: Page, origin: string, template: "proved" | "moved" | "ignored") => {
  const requests: string[] = [];
  const rooms = [
    ["room-1", "North room"],
    ["room-2", "South room"],
    ["room-3", "East room"],
  ] as const;
  const searchForm = (action: string, name: string, value = "") =>
    `<form role="search" action="${action}"><input type="search" name="${name}" aria-label="Search rooms" value="${value}"></form>`;
  const resultsPage = (action: string, name: string, query: string) => {
    const found = rooms.filter(([, room]) => room.toLowerCase().includes(query.toLowerCase()));
    return `${searchForm(action, name, query)}${
      found.length === 0
        ? `<p role="status">No matching rooms</p>`
        : `<ul aria-label="Rooms">${found.map(([id, room]) => `<li data-room-id="${id}"><span class="name">${room}</span></li>`).join("")}</ul>`
    }`;
  };
  await page.route(`${origin}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/favicon.ico") return route.fulfill({ status: 404 });
    requests.push(url.pathname + url.search);
    const html = (body: string) => route.fulfill({ contentType: "text/html", body });
    const [action, name] =
      template === "moved" ? ["/find", "term"] : template === "ignored" ? ["/search", "query"] : ["/search", "q"];
    if (url.pathname === "/") return html(searchForm(action, name));
    if (template === "moved" && url.pathname === "/search")
      return html(`<script>location.replace("/")</script>`);
    if (url.pathname === action)
      return html(
        resultsPage(
          action,
          name,
          template === "ignored" ? url.searchParams.get("query") ?? "north" : url.searchParams.get(name) ?? "",
        ),
      );
    return route.fulfill({ status: 404, body: "Not found" });
  });
  return requests;
};

const roomRows = Either.right({
  rooms: [
    { id: "room-1", name: "North room" },
    { id: "room-2", name: "South room" },
  ],
  more: true,
});

test("search example opens the proved results URL once and reads the rows there", async ({
  page,
}) => {
  const origin = "https://rooms.example.test";
  const requests = await roomsSite(page, origin, "proved");
  const { result } = await runExample(
    page,
    searchThenRead,
    { query: "room", limit: 2 },
    { siteOrigin: origin },
  );
  expect(result).toEqual(roomRows);
  expect(requests).toEqual(["/search?q=room"]);
});

for (const [template, landing] of [
  ["moved", "an entry page"],
  ["ignored", "another query's results"],
] as const)
  test(`search example falls back to the site's search box once when the results URL shows ${landing}`, async ({
    page,
  }) => {
    const origin = "https://rooms.example.test";
    const requests = await roomsSite(page, origin, template);
    const { result } = await runExample(
      page,
      searchThenRead,
      { query: "room", limit: 2 },
      { siteOrigin: origin },
    );
    expect(result).toEqual(roomRows);
    // The results URL once, never a variant of it, then the site's own search once.
    expect(requests.filter((request) => /^\/(?:search|find)\?/.test(request))).toEqual([
      "/search?q=room",
      template === "moved" ? "/find?term=room" : "/search?query=room",
    ]);
  });

// A rooms list that pages by appending: each "Show more" click adds the next two of `total` rooms
// after a short load, their names filling in a moment after the rows appear. With "removed" the
// button goes once every room shows; with "stuck" it stays and adds nothing.
const roomNames = ["North room", "South room", "East room", "West room"];
const appendingRooms = async (page: Page, total: number, ending: "removed" | "stuck", sentinel = false) => {
  await page.setContent(`
    <main><ul aria-label="Rooms"></ul>${sentinel ? '<div class="infinite-loader" style="height: 20px"></div>' : ""}</main>
    <button>Show more</button><output id="clicks">0</output>
    <script>{
      const names = ${JSON.stringify(roomNames.slice(0, total))};
      let shown = 0;
      const list = document.querySelector("ul");
      const button = document.querySelector("button");
      const next = () => {
        list.setAttribute("aria-busy", "true");
        setTimeout(() => {
          const added = names.slice(shown, shown + 2).map((name, index) => {
            const row = document.createElement("li");
            row.dataset.roomId = "room-" + (shown + index + 1);
            row.innerHTML = '<span class="name"></span>';
            list.append(row);
            setTimeout(() => { row.querySelector(".name").textContent = name; }, 80);
            return row;
          });
          shown += added.length;
          list.setAttribute("aria-busy", "false");
          if (shown === names.length && ${JSON.stringify(ending)} === "removed") button.remove();
        }, 120);
      };
      button.onclick = () => { document.querySelector("#clicks").textContent++; next(); };
      next();
    }</script>`);
};
const roomList = (count: number) =>
  roomNames.slice(0, count).map((name, index) => ({ id: `room-${index + 1}`, name }));
// A rooms page as the append example returns it: the list ended, or more with a next position.
const lastRooms = (rooms: readonly { readonly id: string; readonly name: string }[]) => ({
  rooms,
  next_cursor: null,
  next_cursor_expires_at: null,
  has_more: false,
  total_results: null,
  list_changed: false,
});
const moreRooms = (rooms: readonly { readonly id: string; readonly name: string }[]) => ({
  rooms,
  next_cursor: expect.stringMatching(/^pcd1\./u),
  next_cursor_expires_at: null,
  has_more: true,
  total_results: null,
  list_changed: false,
});
// A host that signs cursors, for the append example's later pages.
const roomCursors = (): ListCursorScope => ({
  keys: randomListCursorKeys(),
  operation: "list_rooms",
  now: Date.now(),
});

// A listing site that pages three rows at a time behind a search form, with a Next link. Each
// results page shows its rows at once and fills in their titles a moment later, as a page that
// streams its rows' details does.
const lateTitleListings = async (page: Page, origin: string) => {
  const listings = ["L1", "L2", "L3", "L4", "L5"];
  await page.route(`${origin}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/favicon.ico") return route.fulfill({ status: 404 });
    const query = url.searchParams.get("q") ?? "";
    const form = `<form action="/search"><input id="q" name="q" value="${query}"><button id="go">Search</button></form>`;
    if (url.pathname !== "/search") return route.fulfill({ contentType: "text/html", body: form });
    const pageNumber = Number(url.searchParams.get("page") ?? "1");
    const rows = listings.slice((pageNumber - 1) * 3, pageNumber * 3);
    const more = pageNumber * 3 < listings.length;
    return route.fulfill({
      contentType: "text/html",
      body: `${form}<p id="count">${(pageNumber - 1) * 3 + 1}-${(pageNumber - 1) * 3 + rows.length} of ${listings.length}</p>
<ol id="results">${rows.map((id) => `<li data-id="${id}"><span class="title"></span></li>`).join("")}</ol>
${more ? `<a rel="next" href="/search?q=${encodeURIComponent(query)}&page=${pageNumber + 1}">Next</a>` : ""}
<script>setTimeout(() => {
  for (const row of document.querySelectorAll("#results > li")) row.querySelector(".title").textContent = "Lamp " + row.dataset.id;
}, 300);</script>`,
    });
  });
};

test("paged search example waits for the titles of the rows it returns to fill in", async ({ page }) => {
  const origin = "https://listings.example.test";
  await lateTitleListings(page, origin);
  const { result } = await runExample(
    page,
    searchListings,
    { query: "lamps", limit: 2 },
    { siteOrigin: origin, list: {} },
  );
  expect(result).toEqual(
    Either.right({
      results: [
        { id: "L1", title: "Lamp L1", sponsored: false },
        { id: "L2", title: "Lamp L2", sponsored: false },
      ],
      next_cursor: expect.stringMatching(/^pcd1\./u),
      next_cursor_expires_at: null,
      has_more: true,
      total_results: 5,
      list_changed: false,
    }),
  );
});

test("append example reads each step's filled-in new rows until the control goes", async ({
  page,
}) => {
  await appendingRooms(page, 4, "removed");
  expect((await runExample(page, readRooms, { limit: 10 })).result).toEqual(
    Either.right(lastRooms(roomList(4))),
  );
  await expect(page.locator("#clicks")).toHaveText("1");
});

test("append example ends at the control going beside a loader the page always shows", async ({ page }) => {
  test.info().annotations.push({
    type: "slow",
    description: "The first page's loader counts until it held for the runtime's fixed 8 s no-progress window.",
  });
  await appendingRooms(page, 4, "removed", true);
  expect((await runExample(page, readRooms, { limit: 10 }, { deadlineMs: 30_000 })).result).toEqual(
    Either.right(lastRooms(roomList(4))),
  );
  await expect(page.locator("#clicks")).toHaveText("1");
});

test("append example stops at the limit without another step", async ({ page }) => {
  await appendingRooms(page, 4, "removed");
  expect((await runExample(page, readRooms, { limit: 1 }, { list: {} })).result).toEqual(
    Either.right(moreRooms(roomList(1))),
  );
  await expect(page.locator("#clicks")).toHaveText("0");
});

test("append example's page two replays page one's steps and continues after its last room", async ({
  page,
}) => {
  test.info().annotations.push({
    type: "slow",
    description: "Each page's first read is short of its rows until they held for the helper's fixed two seconds.",
  });
  const scope = roomCursors();
  await appendingRooms(page, 4, "removed");
  const first = await runExample(page, readRooms, { limit: 3 }, { list: {} });
  expect(first.result).toEqual(Either.right(moreRooms(roomList(3))));
  const cursor = (sealListOutput(Either.getOrThrow(first.result), { limit: 3 }, scope).output as {
    readonly next_cursor: string;
  }).next_cursor;
  const admitted = admitListCursor({ limit: 3, cursor }, scope);
  if (!admitted.ok) throw new Error(admitted.message);
  // A fresh run on a fresh page: the list starts again from its first rooms.
  await appendingRooms(page, 4, "removed");
  const second = await runExample(page, readRooms, { limit: 3, cursor }, { list: admitted.list });
  expect(second.result).toEqual(
    Either.right({ ...lastRooms([{ id: "room-4", name: "West room" }]) }),
  );
  await expect(page.locator("#clicks")).toHaveText("1");
});

test("append example keeps a list whose step adds no rows while Show more stays open, never ended", async ({
  page,
}) => {
  test.info().annotations.push({
    type: "slow",
    description:
      "A step that adds nothing ends only once the rows held unchanged for the helper's fixed two seconds.",
  });
  await appendingRooms(page, 2, "stuck");
  // has_more stays true with a position that continues: a stalled list is never called ended.
  expect(
    (await runExample(page, readRooms, { limit: 10 }, { deadlineMs: 30_000, list: {} })).result,
  ).toEqual(Either.right(moreRooms(roomList(2))));
  await expect(page.locator("#clicks")).toHaveText("1");
});

test("append example ends a list that still stalls on the next call instead of returning the same cursor", async ({
  page,
}) => {
  test.info().annotations.push({
    type: "slow",
    description:
      "Each call's step that adds nothing ends only once the rows held unchanged for the helper's fixed two seconds.",
  });
  const scope = roomCursors();
  await appendingRooms(page, 2, "stuck");
  const first = await runExample(page, readRooms, { limit: 10 }, { deadlineMs: 30_000, list: {} });
  expect(first.result).toEqual(Either.right(moreRooms(roomList(2))));
  const cursor = (sealListOutput(Either.getOrThrow(first.result), { limit: 10 }, scope).output as {
    readonly next_cursor: string;
  }).next_cursor;
  const admitted = admitListCursor({ limit: 10, cursor }, scope);
  if (!admitted.ok) throw new Error(admitted.message);
  await appendingRooms(page, 2, "stuck");
  const second = await runExample(
    page,
    readRooms,
    { limit: 10, cursor },
    { deadlineMs: 30_000, list: admitted.list },
  );
  // No rows and no step further: the list ends honestly as partial, never with the same cursor.
  expect(second.result).toEqual(
    Either.right({
      rooms: [],
      next_cursor: null,
      next_cursor_expires_at: null,
      has_more: true,
      total_results: null,
      list_changed: false,
      next_cursor_unavailable: "no_progress",
    }),
  );
});

// A rooms site whose "Show more" loads the next two rooms after `delayMs`, through the site's API or
// a timer, while a spinner shows below the list and the control is hidden or disabled; once every
// room shows, the control goes.
const slowAppendingRooms = async (
  page: Page,
  delayMs: number,
  via: "request" | "timer" = "request",
  whileLoading: "kept" | "hidden" | "disabled" = "kept",
) => {
  const origin = "https://rooms.example.test";
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/more") {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      await route.fulfill({ contentType: "application/json", body: "{}" }).catch(() => undefined);
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body: `<main>
        <ul aria-label="Rooms"><li data-room-id="room-1"><span class="name">North room</span></li><li data-room-id="room-2"><span class="name">South room</span></li></ul>
        <div id="status"></div><button>Show more</button><output id="clicks">0</output>
      </main>
      <script>
        const button = document.querySelector("button");
        button.onclick = async () => {
          document.querySelector("#clicks").textContent++;
          document.querySelector("#status").innerHTML = '<div class="spinner" style="height: 20px"></div>';
          if (${JSON.stringify(whileLoading)} === "hidden") button.hidden = true;
          if (${JSON.stringify(whileLoading)} === "disabled") button.disabled = true;
          if (${JSON.stringify(via)} === "request") await fetch("/more");
          else await new Promise((resolve) => setTimeout(resolve, ${delayMs}));
          document.querySelector("ul").insertAdjacentHTML("beforeend",
            '<li data-room-id="room-3"><span class="name">East room</span></li><li data-room-id="room-4"><span class="name">West room</span></li>');
          document.querySelector("#status").innerHTML = "";
          button.remove();
        };
      </script>`,
    });
  });
  await page.goto(`${origin}/`);
};

for (const whileLoading of ["hidden", "disabled"] as const)
  test(`append example never calls a control ${whileLoading} while a step loads the end of the list`, async ({
    page,
  }) => {
    test.info().annotations.push({
      type: "slow",
      description: "The step loads for 10 s without a request the wait can see, past the runtime's fixed 8 s window.",
    });
    await slowAppendingRooms(page, 10_000, "timer", whileLoading);
    const { result } = await runExample(page, readRooms, { limit: 10 }, { deadlineMs: 40_000 });
    // Every room, never a short list said to have no more.
    expect(result).toEqual(Either.right(lastRooms(roomList(4))));
  });

test("append example waits for a step whose rooms take longer than the request hold", async ({ page }) => {
  test.info().annotations.push({
    type: "slow",
    description: "The site's API answers after 5 s, past the 4 s a request stays busy when the wait did not start it.",
  });
  await slowAppendingRooms(page, 5000);
  expect((await runExample(page, readRooms, { limit: 10 })).result).toEqual(
    Either.right(lastRooms(roomList(4))),
  );
  await expect(page.locator("#clicks")).toHaveText("1");
});

// A rooms list with padding that streams each page in: ten rows per load, one every 80 ms.
const streamingRooms = (page: Page, total: number) =>
  page.setContent(`
    <ul aria-label="Rooms" style="padding: 20px"></ul><button>Show more</button><output id="clicks">0</output>
    <script>{
      let shown = 0;
      const list = document.querySelector("ul");
      const next = () => {
        const until = Math.min(shown + 10, ${total});
        for (let at = 1; shown < until; at += 1) {
          const id = (shown += 1);
          setTimeout(() => list.insertAdjacentHTML("beforeend",
            '<li data-room-id="room-' + id + '"><span class="name">Room ' + id + '</span></li>'), at * 80);
        }
      };
      document.querySelector("button").onclick = () => { document.querySelector("#clicks").textContent++; next(); };
      next();
    }</script>`);

test("append example takes its page size from a first page that streamed in, not from its first rows", async ({
  page,
}) => {
  test.info().annotations.push({
    type: "slow",
    description: "A first page shorter than the limit counts only once its rows held for the helper's fixed two seconds.",
  });
  await streamingRooms(page, 40);
  expect((await runExample(page, readRooms, { limit: 30 }, { list: {} })).result).toEqual(
    Either.right(
      moreRooms(
        Array.from({ length: 30 }, (_, index) => ({ id: `room-${index + 1}`, name: `Room ${index + 1}` })),
      ),
    ),
  );
  await expect(page.locator("#clicks")).toHaveText("2");
});

const siteOrigin = "https://members.example.test";
test("auth entry waits for an identifier-first sibling destination after one click", async ({
  page,
}, testInfo) => {
  const loginOrigin = "https://login.example.test";
  let entries = 0;
  let loginPages = 0;
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<nav aria-label="Members"><a href="/member/login">Log in</a></nav>`,
      });
    if (new URL(route.request().url()).origin === siteOrigin) {
      entries++;
      return route.fulfill({
        contentType: "text/html",
        body: `<script>location.replace(${JSON.stringify(`${loginOrigin}/member/login`)});</script>`,
      });
    }
    loginPages++;
    await route.fulfill({
      contentType: "text/html",
      body: `<div id="mount"></div><script>requestAnimationFrame(() => requestAnimationFrame(() => { document.querySelector('#mount').innerHTML = '<form aria-label="Member login"><label>Username<input type="text"></label><button>Continue</button></form>'; }));</script>`,
    });
  });
  await page.goto(siteOrigin);
  const { result } = await runExample(page, authEntry, {}, { siteOrigin, deadlineMs: 2000 });
  expect(result).toEqual(
    Either.right({
      origin: loginOrigin,
      pathname: "/member/login",
      controls: [
        { tag: "input", type: "text" },
        { tag: "button", type: "" },
      ],
      coverage: "observed_login_form",
    }),
  );
  expect(entries).toBe(1);
  expect(loginPages).toBe(1);
  await testInfo.attach("navigation-result", {
    body: JSON.stringify({ entries, loginPages, result }),
    contentType: "application/json",
  });
});

test("auth entry follows the observed link and reports controls without values", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route("**/*", async (route) => {
    requests.push(`${route.request().method()} ${route.request().url()}`);
    await route.fulfill({
      contentType: "text/html",
      body:
        new URL(route.request().url()).pathname === "/"
          ? // The employer link and collapsed duplicates come first in document order.
            `<nav aria-label="Employers"><a href="/employer/login">Log in</a></nav>
             <nav aria-label="Members">
               <ul hidden><li><a href="/member/register">Log in</a></li></ul>
               <a href="/member/register" style="display:block;width:0;height:0;overflow:hidden">Log in</a>
               <a href="/member/login">Log in</a>
             </nav>`
          : `<form aria-label="Member login">
              <label>Username<input type="text" value="private-user"></label>
              <label>Password<input type="password" value="private-password"></label>
              <button type="submit">Sign in</button>
            </form>`,
    });
  });
  await page.goto(siteOrigin);
  const { result, calls } = await runExample(page, authEntry, {}, { siteOrigin });
  expect(result).toEqual(
    Either.right({
      origin: siteOrigin,
      pathname: "/member/login",
      controls: [
        { tag: "input", type: "text" },
        { tag: "input", type: "password" },
        { tag: "button", type: "submit" },
      ],
      coverage: "observed_login_form",
    }),
  );
  expect(calls).toHaveLength(1);
  expect(requests).toEqual([`GET ${siteOrigin}/`, `GET ${siteOrigin}/member/login`]);
  expect(JSON.stringify(result)).not.toContain("private-");
});

// The site's entry redirected to www., a sibling of the authorized origin: still the site.
test("auth entry starts from a sibling subdomain of the site", async ({ page }) => {
  const sibling = "https://www.example.test";
  await page.route("**/*", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body:
        new URL(route.request().url()).pathname === "/"
          ? '<nav aria-label="Members"><a href="/member/login">Log in</a></nav>'
          : '<form aria-label="Member login"><label>Username<input type="text"></label></form>',
    });
  });
  await page.goto(sibling);
  const { result } = await runExample(page, authEntry, {}, { siteOrigin });
  expect(result).toEqual(
    Either.right({
      origin: sibling,
      pathname: "/member/login",
      controls: [{ tag: "input", type: "text" }],
      coverage: "observed_login_form",
    }),
  );
});

for (const entry of ["absent", "ambiguous", "wrong-path", "other-site"] as const)
  test(`auth entry rejects ${entry} evidence without navigating`, async ({ page }) => {
    const markup = {
      absent: '<nav aria-label="Employers"><a href="/member/login">Log in</a></nav>',
      ambiguous:
        '<nav aria-label="Members"><a href="/member/login">Log in</a><a href="/member/login">Log in</a></nav>',
      "wrong-path": '<nav aria-label="Members"><a href="/member/register">Log in</a></nav>',
      "other-site": '<nav aria-label="Members"><a href="/member/login">Log in</a></nav>',
    };
    let requests = 0;
    await page.route("**/*", async (route) => {
      requests += 1;
      await route.fulfill({ contentType: "text/html", body: markup[entry] });
    });
    const start = entry === "other-site" ? "https://unexpected.example.invalid" : siteOrigin;
    await page.goto(start);
    const { result } = await runExample(page, authEntry, {}, { siteOrigin });
    expect(failure(result)).toMatchObject({ _tag: "OperationFailure" });
    expect(page.url()).toBe(`${start}/`);
    expect(requests).toBe(1);
  });

test("native select example selects a canonical value and reads it back", async ({ page }) => {
  await page.setContent(
    '<label for="status">Invoice status</label><select id="status" onchange="document.querySelector(\'output\').textContent++"><option value="open">Open</option><option value="paid">Paid</option></select><output>0</output>',
  );
  expect((await runExample(page, selectStatus, { status: "paid" })).result).toEqual(
    Either.right({ status: "paid" }),
  );
  await expect(page.locator("output")).toHaveText("1");
});

test("picker example picks a suggested person, refuses one the site does not suggest and lets the caller choose among a shared name", async ({
  page,
}) => {
  await page.setContent(`
    <label for="owner">Owner</label><input id="owner" role="combobox" aria-controls="people" autocomplete="off">
    <ul id="people" role="listbox" hidden></ul>
    <script>
      const input = document.getElementById("owner"), list = document.getElementById("people");
      input.oninput = () => setTimeout(() => {
        list.hidden = false;
        list.innerHTML = ["Jordan Reyes", "Quinn Avery", "Casey Lund", "Jordan Lee"].filter((name) => name.toLowerCase().includes(input.value.toLowerCase()))
          .map((name) => '<li role="option">' + name + "</li>").join("");
      }, 80);
      list.onmousedown = (event) => event.preventDefault();
      list.onclick = (event) => { input.value = event.target.textContent; list.hidden = true; };
    </script>`);
  expect((await runExample(page, assignOwner, { owner: "jordan reyes" })).result).toEqual(
    Either.right({ owner: "Jordan Reyes" }),
  );
  await expect(page.getByRole("combobox", { name: "Owner" })).toHaveValue("Jordan Reyes");
  expect(failure((await runExample(page, assignOwner, { owner: "Ca" })).result)).toMatchObject({
    _tag: "InvalidInput",
    field: "owner",
    available: ["Casey Lund"],
    kind: "option_missing",
  });
  expect(failure((await runExample(page, assignOwner, { owner: "Jordan" })).result)).toMatchObject({
    _tag: "InvalidInput",
    field: "owner",
    available: ["Jordan Reyes", "Jordan Lee"],
    kind: "option_ambiguous",
  });
});

test("picker example that takes the first of a shared name returns the one it used", async ({
  page,
}) => {
  await page.setContent(`
    <label for="from">From</label><input id="from" role="combobox" aria-controls="stations" autocomplete="off">
    <ul id="stations" role="listbox" hidden></ul>
    <script>
      const input = document.getElementById("from"), list = document.getElementById("stations");
      input.oninput = () => setTimeout(() => {
        list.hidden = false;
        list.innerHTML = ["Fernhill", "Springfield, IL", "Springfield, MA"].filter((name) => name.toLowerCase().includes(input.value.toLowerCase()))
          .map((name) => '<li role="option">' + name + "</li>").join("");
      }, 80);
      list.onmousedown = (event) => event.preventDefault();
      list.onclick = (event) => { input.value = event.target.textContent; list.hidden = true; };
    </script>`);
  expect((await runExample(page, searchOrigin, { origin: "Springfield" })).result).toEqual(
    Either.right({ origin: "Springfield, IL" }),
  );
  await expect(page.getByRole("combobox", { name: "From" })).toHaveValue("Springfield, IL");
  expect(failure((await runExample(page, searchOrigin, { origin: "Ashby" })).result)).toMatchObject({
    _tag: "InvalidInput",
    field: "origin",
    kind: "option_missing",
  });
});

test("date and dropdown example fills a split date and a custom dropdown by label", async ({
  page,
}) => {
  const months = ["January", "February", "March", "April", "May", "June", "July"];
  await page.setContent(`
    <form role="search" aria-label="Find departures">
      <select name="month" aria-label="Month"><option value="">Month</option>${months.map((month, index) => `<option value="${index}">${month}</option>`).join("")}</select>
      <select name="day" aria-label="Day">${Array.from({ length: 31 }, (_, index) => `<option>${index + 1}</option>`).join("")}</select>
      <input name="year" aria-label="Year">
      <input role="combobox" aria-label="Cabin" readonly aria-expanded="false" aria-controls="cabins" name="cabin">
      <ul role="listbox" id="cabins" hidden><li role="option">Economy</li><li role="option">Business class</li></ul>
    </form>
    <script>
      const cabin = document.querySelector("[aria-label=Cabin]"); const list = document.querySelector("#cabins");
      cabin.onclick = () => { list.hidden = false; cabin.setAttribute("aria-expanded", "true"); };
      list.onclick = (event) => { cabin.value = event.target.textContent; list.hidden = true; cabin.setAttribute("aria-expanded", "false"); };
    </script>`);
  const form = () => page.evaluate(() => Object.fromEntries(new FormData(document.forms[0])));
  expect(
    (await runExample(page, setDeparture, { date: "2027-07-09", cabin: "business" })).result,
  ).toEqual(Either.right({ date: "2027-07-09", cabin: "business" }));
  expect(await form()).toEqual({ month: "6", day: "9", year: "2027", cabin: "Business class" });
  // A month the dropdown does not offer is refused before anything else changes.
  expect(
    failure(
      (await runExample(page, setDeparture, { date: "2027-08-01", cabin: "economy" })).result,
    ),
  ).toMatchObject({ _tag: "OperationFailure", message: "option_missing", dispatch: "not_sent" });
  expect(await form()).toEqual({ month: "6", day: "9", year: "2027", cabin: "Business class" });
});

test("ARIA listbox example waits for this query's delayed options and reads the committed choice", async ({
  page,
}) => {
  await page.setContent(`
    <input role="combobox" aria-label="Airport" aria-expanded="false" aria-controls="choices">
    <output role="status" aria-label="Selected airport" id="selected">A</output><output id="commits">0</output>
    <ul role="listbox" id="unrelated"><li role="option" data-key="B" onclick="throw Error('wrong popup')">Wrong</li></ul>
    <ul role="listbox" id="choices" data-query="old" style="display:none;min-height:20px"><li role="option" data-key="B">Stale B</li></ul>
    <script>
      const control = document.querySelector("input"); const popup = document.querySelector("#choices");
      control.onclick = () => { control.setAttribute("aria-expanded", "true"); popup.style.display = "block"; };
      control.oninput = () => setTimeout(() => {
        popup.innerHTML = '<li role="option" data-key="B">Airport B</li><li role="option" data-key="C">Airport C</li>';
        popup.dataset.query = control.value;
      }, 150);
      popup.onclick = (event) => {
        const key = event.target.dataset.key; if (!key) return;
        document.querySelector("#commits").textContent++;
        popup.setAttribute("data-query-at-commit", popup.dataset.query);
        control.setAttribute("aria-label", "Selected airport " + key);
        document.querySelector("#selected").textContent = key;
      };
    </script>`);
  expect((await runExample(page, chooseAirport, { code: "B", query: "airport b" })).result).toEqual(
    Either.right({ code: "B" }),
  );
  await expect(page.locator("#choices")).toHaveAttribute("data-query-at-commit", "airport b");
  await expect(page.locator("#commits")).toHaveText("1");
});

test("ARIA listbox example reports a choice the status never shows without waiting out a fixed timeout", async ({
  page,
}) => {
  await page.setContent(`
    <input role="combobox" aria-label="Airport" aria-expanded="false" aria-controls="choices">
    <output role="status" aria-label="Selected airport">A</output><output id="commits">0</output>
    <ul role="listbox" id="choices" style="display:none;min-height:20px"></ul>
    <script>
      const control = document.querySelector("input"); const popup = document.querySelector("#choices");
      control.onclick = () => { control.setAttribute("aria-expanded", "true"); popup.style.display = "block"; };
      control.oninput = () => setTimeout(() => {
        popup.innerHTML = '<li role="option" data-key="B">Airport B</li>';
        popup.dataset.query = control.value;
      }, 50);
      popup.onclick = () => { document.querySelector("#commits").textContent++; };
    </script>`);
  const started = Date.now();
  expect(
    failure((await runExample(page, chooseAirport, { code: "B", query: "airport b" })).result),
  ).toMatchObject({ _tag: "OperationFailure", message: "not_committed", dispatch: "sent" });
  // The status stayed the same for the unchanged window after the click, never a 30 s wait.
  expect(Date.now() - started).toBeLessThan(5000);
  await expect(page.locator("#commits")).toHaveText("1");
});

test("dialog picker waits for fresh choices and commits exactly once", async ({ page }) => {
  await dialogPickerFixture(page, "success");
  const { result, calls } = await runExample(page, dialogPicker, { query: "item b", key: "B" });
  expect(result).toEqual(Either.right({ selected_key: "B" }));
  expect(calls).toHaveLength(1);
  await expect(page.locator("#opens")).toHaveText("1");
  await expect(page.locator("#commits")).toHaveText("1");
  await expect(page.locator("#stale-clicks")).toHaveText("0");
  await expect(page.locator("#early-clicks")).toHaveText("0");
  await expect(page.getByRole("textbox", { name: "Selected catalog key" })).toHaveValue("B");
});

for (const mode of ["ambiguous", "no_commit"] as const)
  test(`dialog picker ${mode} fails without clicking again`, async ({ page }) => {
    await dialogPickerFixture(page, mode);
    const { result } = await runExample(
      page,
      dialogPicker,
      { query: "item b", key: "B" },
      { deadlineMs: 1_500 },
    );
    expect(Either.isLeft(result)).toBe(true);
    await expect(page.locator("#opens")).toHaveText("1");
    await expect(page.locator("#commits")).toHaveText(mode === "no_commit" ? "1" : "0");
    await expect(page.getByRole("textbox", { name: "Selected catalog key" })).toHaveValue("A");
  });

/**
 * The task site the write example was written against: the form posts the task, the site answers
 * `status` with `location`, if any, and the page then opens that location, answered as `detail`
 * says.
 */
const taskSite = async (
  page: Page,
  origin: string,
  answer: { readonly status: number; readonly location?: string },
  detail: (route: Route) => Promise<void>,
) => {
  let submissions = 0;
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      submissions += 1;
      await route.fulfill({
        status: answer.status,
        headers: answer.location === undefined ? {} : { location: answer.location },
      });
      return;
    }
    if (request.url() === `${origin}/tasks/new`) {
      await route.fulfill({
        contentType: "text/html",
        body: `<form aria-label="New task" method="post" action="/tasks">
          <label>Title<input name="title"></label><label>Assignee<input name="assignee"></label>
          <button>Create task</button>
        </form><script>
          document.querySelector("form").addEventListener("submit", async (event) => {
            event.preventDefault();
            const response = await fetch("/tasks", { method: "POST", body: new URLSearchParams(new FormData(event.target)) });
            location.href = response.headers.get("location");
          });
        </script>`,
      });
      return;
    }
    await detail(route);
  });
  await page.goto(`${origin}/tasks/new`);
  return { submissions: () => submissions };
};

// The create request's 201 and its Location give the output, so the detail page the save opens
// never matters: one showing another task, one that is missing, or one still loading when the run
// ends all leave the same verified write and output.
for (const detail of ["shown", "stale", "missing", "slow"] as const)
  test(`write example takes its output from its own 201, with no page read-back: ${detail}`, async ({
    page,
  }) => {
    const origin = "https://tasks.example.invalid";
    const requested = { title: "Review draft", assignee: "demo-user" };
    let runEnded = () => {};
    const ended = new Promise<void>((resolve) => {
      runEnded = resolve;
    });
    const site = await taskSite(
      page,
      origin,
      { status: 201, location: "/tasks/task-123" },
      async (route) => {
        // A slow detail page answers only after the run has returned.
        if (detail === "slow") await ended;
        const shown =
          detail === "stale"
            ? { id: "old-task", title: "Other task", assignee: "someone-else" }
            : { id: "task-123", ...requested };
        await route
          .fulfill(
            detail === "missing"
              ? { status: 404, contentType: "text/html", body: "<p>Not found</p>" }
              : {
                  contentType: "text/html; charset=utf-8",
                  body: `<section role="region" aria-label="Saved task">
                    <label>Task ID<input readonly value="${shown.id}"></label>
                    <label>Title<input readonly value="${shown.title}"></label>
                    <label>Assignee<input readonly value="${shown.assignee}"></label>
                  </section>`,
                },
          )
          .catch(() => {});
      },
    );
    const { result, calls, effect, ...recorded } = await runExample(page, createTask, requested, {
      siteOrigin: origin,
    });
    runEnded();
    expect(site.submissions()).toBe(1);
    expect(calls).toHaveLength(1);
    expect(createTask.write).toEqual({ confirmation: "readback", commits: ["create-task"] });
    // The 201 with its Location records the write as landed; the one submission entered its
    // commit mark.
    expect({ effect, ...recorded }).toEqual({
      effect: "verified",
      confirmation: "readback",
      commits: [{ name: "create-task", state: "confirmed" }],
    });
    // The output is the id from the Location alone, with no echo of the input.
    expect(result).toEqual(Either.right({ id: "task-123" }));
  });

// Sites often send Location as an absolute URL. One on the response's own origin names the task
// as a path does.
test("write example takes its id from an absolute Location on its own origin", async ({ page }) => {
  const origin = "https://tasks.example.invalid";
  const site = await taskSite(
    page,
    origin,
    { status: 201, location: `${origin}/tasks/task-123` },
    (route) => route.fulfill({ contentType: "text/html", body: "<p>Task saved</p>" }),
  );
  const { result, calls, effect } = await runExample(
    page,
    createTask,
    { title: "Review draft", assignee: "demo-user" },
    { siteOrigin: origin },
  );
  expect(site.submissions()).toBe(1);
  expect(calls).toHaveLength(1);
  expect(effect).toBe("verified");
  expect(result).toEqual(Either.right({ id: "task-123" }));
});

// A create that did not answer 201 with a Location naming the new task on the response's own
// origin confirms nothing: the run fails as sent, without recording the write as landed.
for (const [label, answer] of [
  ["a 200", { status: 200, location: "/tasks/task-123" }],
  ["a 4xx", { status: 422, location: "/tasks/task-123" }],
  ["no Location", { status: 201 }],
  ["a Location naming no task", { status: 201, location: "/tasks/" }],
  ["a Location with a trailing slash", { status: 201, location: "/tasks/123/" }],
  [
    "a Location on another origin",
    { status: 201, location: "https://other.example.invalid/tasks/task-123" },
  ],
] as const)
  test(`write example fails as not_saved on ${label}`, async ({ page }) => {
    const origin = "https://tasks.example.invalid";
    const site = await taskSite(page, origin, answer, (route) =>
      route.fulfill({ contentType: "text/html", body: "<p>Tasks</p>" }),
    );
    const { result, calls, effect } = await runExample(
      page,
      createTask,
      { title: "Review draft", assignee: "demo-user" },
      { siteOrigin: origin },
    );
    expect(site.submissions()).toBe(1);
    expect(calls).toHaveLength(1);
    expect(failure(result)).toMatchObject({
      _tag: "OperationFailure",
      message: "not_saved",
      dispatch: "sent",
    });
    expect(effect).not.toBe("verified");
  });

test("write example waits for a delayed submit control and its own receipt before returning", async ({
  page,
}) => {
  test.setTimeout(30_000);
  test.info().annotations.push({
    type: "slow",
    description: "The controlled twelve-second submit delay reproduces the old receipt/write race.",
  });
  const origin = "https://tasks.example.invalid";
  const requested = { title: "Review draft", assignee: "demo-user" };
  let submissions = 0;
  await page.route(`${origin}/**`, async (route) => {
    if (route.request().method() === "POST") {
      submissions += 1;
      await route.fulfill({ status: 201, headers: { location: "/tasks/task-123" } });
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body:
        route.request().url() === `${origin}/tasks/new`
          ? `<form aria-label="New task" method="post" action="/tasks">
              <label>Title<input name="title"></label><label>Assignee<input name="assignee"></label>
              <button disabled>Create task</button>
            </form><script>
              setTimeout(() => { document.querySelector("button").disabled = false; }, 12000);
              document.querySelector("form").addEventListener("submit", async (event) => {
                event.preventDefault();
                const response = await fetch("/tasks", { method: "POST", body: new URLSearchParams(new FormData(event.target)) });
                location.href = response.headers.get("location");
              });
            </script>`
          : `<section role="region" aria-label="Saved task">
              <label>Task ID<input readonly value="task-123"></label>
              <label>Title<input readonly value="${requested.title}"></label>
              <label>Assignee<input readonly value="${requested.assignee}"></label>
            </section>`,
    });
  });
  await page.goto(`${origin}/tasks/new`);
  const { result, calls } = await runExample(page, createTask, requested, {
    siteOrigin: origin,
    deadlineMs: 25_000,
  });
  expect(result).toEqual(Either.right({ id: "task-123" }));
  expect(submissions).toBe(1);
  expect(calls).toHaveLength(1);
});

// Delayed fields and a submit that enables only after the call ended reproduce a write firing
// after the call expired. A 4 s deadline scales every bound the example derives from
// remainingMs, so the race plays out in about three seconds instead of sixty-five.
test("write example settles a delayed submit before its outer call expires", async ({ page }) => {
  test.info().annotations.push({
    type: "slow",
    description:
      "The example's smallest safe call is three seconds, and the submit enables only after it ends.",
  });
  const origin = "https://tasks.example.invalid";
  const requested = { title: "Review draft", assignee: "demo-user" };
  let submissions = 0;
  await page.route(`${origin}/**`, async (route) => {
    if (route.request().method() === "POST") {
      submissions += 1;
      await route.fulfill({ status: 201, headers: { location: "/tasks/task-123" } });
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body: `<form aria-label="New task" method="post" action="/tasks">
          <span id="title"></span><span id="assignee"></span><button disabled>Create task</button>
        </form><script>
          setTimeout(() => { document.querySelector("#title").innerHTML = '<label>Title<input name="title"></label>'; }, 50);
          setTimeout(() => { document.querySelector("#assignee").innerHTML = '<label>Assignee<input name="assignee"></label>'; }, 100);
          setTimeout(() => { document.querySelector("button").disabled = false; }, 2800);
          document.querySelector("form").addEventListener("submit", async (event) => {
            event.preventDefault();
            await fetch("/tasks", { method: "POST", body: new URLSearchParams(new FormData(event.target)) });
          });
        </script>`,
    });
  });
  await page.goto(`${origin}/tasks/new`);
  const submitEnablesAt = Date.now() + 2_800;
  const { result } = await runExample(page, createTask, requested, {
    siteOrigin: origin,
    deadlineMs: 4_000,
  });
  expect(Either.isLeft(result)).toBe(true);
  expect(submissions).toBe(0);
  // 1.5 s past the moment the submit enables: a click left pending would have posted by now.
  await page.waitForTimeout(Math.max(0, submitEnablesAt + 1_500 - Date.now()));
  expect(submissions).toBe(0);
});

/**
 * The checkout the write-session example was written against: fill, review, place, confirm. The
 * review prices each unit at 12.50 and shows the total, under a membership offer while
 * `site.offer` is set. A pen adds a required engraving choice to the checkout once typed in,
 * and a full name then adds its text. A ring adds three at once, a size, a metal and an
 * inscription, and gold then adds its karat. A watch adds a strap and a strap size, shown greyed
 * out until a strap is chosen. A bracelet adds a charm, and a heart renames the quantity, clears
 * it and makes it required.
 */
const checkoutSite = async (
  page: Page,
  origin: string,
  orders: string[],
  site: { offer: boolean; declined: number } = { offer: false, declined: 0 },
) => {
  await page.exposeFunction("declineOffer", () => {
    site.declined += 1;
  });
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/checkout")
      return route.fulfill({
        contentType: "text/html",
        body: `<form aria-label="Checkout" method="get" action="/checkout/review">
          <label>Item<input name="item"></label><label>Quantity<input name="quantity"></label>
          <label><input type="checkbox" name="giftWrap"> Gift wrap</label>
          <label hidden>Engraving<select name="engraving" required disabled>
            <option value="">Choose</option><option>Initials</option><option>Full name</option>
          </select></label>
          <label hidden>Engraving text<input name="engraving_text" required disabled></label>
          <label hidden>Ring size<select name="size" required disabled>
            <option value="">Choose</option><option>Small</option><option>Medium</option><option>Large</option>
          </select></label>
          <label hidden>Metal<select name="metal" required disabled>
            <option value="">Choose</option><option>Gold</option><option>Silver</option>
          </select></label>
          <label hidden>Inscription<input name="inscription" required disabled></label>
          <label hidden>Gold karat<select name="karat" required disabled>
            <option value="">Choose</option><option>14k</option><option>18k</option>
          </select></label>
          <label hidden>Strap<select name="strap" required disabled>
            <option value="">Choose</option><option>Leather</option><option>Steel</option>
          </select></label>
          <label hidden>Strap size<select name="strap_size" required disabled>
            <option value="">Choose</option><option>Small</option><option>Large</option>
          </select></label>
          <label hidden>Charm<select name="charm" required disabled>
            <option value="">Choose</option><option>Star</option><option>Heart</option>
          </select></label>
          <button>Continue</button>
        </form>
        <script>
          const show = (name, shown) => {
            const field = document.querySelector("[name=" + name + "]");
            field.disabled = !shown;
            field.parentElement.hidden = !shown;
          };
          document.querySelector("[name=item]").addEventListener("input", (event) => {
            show("engraving", event.target.value === "pen");
            for (const name of ["size", "metal", "inscription"]) show(name, event.target.value === "ring");
            show("strap", event.target.value === "watch");
            document.querySelector("[name=strap_size]").parentElement.hidden = event.target.value !== "watch";
            show("charm", event.target.value === "bracelet");
          });
          document.querySelector("[name=engraving]").addEventListener("change", (event) => {
            show("engraving_text", event.target.value === "Full name");
          });
          document.querySelector("[name=metal]").addEventListener("change", (event) => {
            show("karat", event.target.value === "Gold");
          });
          document.querySelector("[name=strap]").addEventListener("change", (event) => {
            document.querySelector("[name=strap_size]").disabled = event.target.value === "";
          });
          document.querySelector("[name=charm]").addEventListener("change", (event) => {
            if (event.target.value !== "Heart") return;
            const quantity = document.querySelector("[name=quantity]");
            quantity.parentElement.firstChild.textContent = "Quantity (max 2 with a heart)";
            quantity.value = "";
            quantity.required = true;
          });
        </script>`,
      });
    // An armchair goes by courier, so the review asks for a delivery phone, but only once Place
    // order is pressed: the click keeps the review, with the phone field shown and flagged.
    const review = (item: string, total: string, extra = "") => `<p aria-label="Item">${item}</p>
          <p aria-label="Order total">${total}</p>
          <form aria-label="Review" method="post" action="/orders"><input type="hidden" name="item" value="${item}">
          <input type="hidden" name="quantity" value="${url.searchParams.get("quantity") ?? "1"}">
          <label hidden>Delivery phone<input type="tel" name="phone" aria-describedby="phone-error"></label>
          <p id="phone-error" hidden>Enter a phone number for the courier</p>${extra}<button>Place order</button></form>
          <script>
            document.forms[0].addEventListener("submit", (event) => {
              const phone = document.querySelector("[name=phone]");
              if (${JSON.stringify(item)} !== "armchair" || phone.value.trim() !== "") return;
              event.preventDefault();
              phone.parentElement.hidden = false;
              phone.setAttribute("aria-invalid", "true");
              document.querySelector("#phone-error").hidden = false;
            });
          </script>`;
    if (url.pathname === "/checkout/review")
      return route.fulfill({
        contentType: "text/html",
        body: `${review(url.searchParams.get("item") ?? "", `$${(Number(url.searchParams.get("quantity")) * 12.5).toFixed(2)}`)}
          ${site.offer ? `<div role="dialog" aria-label="Membership offer"><button onclick="window.declineOffer(); this.parentElement.remove()">No thanks</button></div>` : ""}`,
      });
    // The site answers the order's own POST with its confirmation. A sofa's order is taken, but
    // the site answers with the review again, its promo code flagged: the page can't tell whether
    // the order went through.
    if (url.pathname === "/orders" && request.method() === "POST") {
      const posted = new URLSearchParams(request.postData() ?? "");
      orders.push(posted.get("item") ?? "");
      if (posted.get("item") === "sofa")
        return route.fulfill({
          contentType: "text/html",
          body: review(
            "sofa",
            `$${(Number(posted.get("quantity")) * 12.5).toFixed(2)}`,
            `<label>Promo code<input name="promo" value="SPRING" aria-invalid="true"></label>`,
          ),
        });
      return route.fulfill({
        contentType: "text/html",
        body: `<p role="status" aria-label="Order confirmation">Order ORD-${1000 + orders.length} is placed.</p>`,
      });
    }
    return route.fulfill({ status: 404, body: "Not found" });
  });
};

test("write-session example commits once across its act steps and reads the site's confirmation back", async ({
  page,
}) => {
  const origin = "https://shop.example.invalid";
  const orders: string[] = [];
  const input = { item: "lamp", quantity: 2, gift_wrap: false, max_total_minor: 2500 };
  const site = { offer: false, declined: 0 };
  await checkoutSite(page, origin, orders, site);
  await page.goto("about:blank");
  const filled = await runExample(page, fillStep, input, { siteOrigin: origin });
  expect(filled).toMatchObject({
    result: Either.right({ review_shown: true }),
    confirmation: undefined,
  });
  expect(orders).toEqual([]);
  // A membership offer opens late, after the review loaded: the check before the mark declines it.
  await page.evaluate(() => {
    const offer = document.createElement("div");
    offer.setAttribute("role", "dialog");
    offer.setAttribute("aria-label", "Membership offer");
    offer.innerHTML = `<button onclick="window.declineOffer(); this.parentElement.remove()">No thanks</button>`;
    document.body.append(offer);
  });
  // The next step continues on the review page the first one left.
  const placed = await runExample(page, placeStep, input, { siteOrigin: origin });
  expect(placed).toMatchObject({
    result: Either.right({ order_number: "ORD-1001" }),
    effect: "verified",
    confirmation: "readback",
    commits: [{ name: "place-order", state: "confirmed" }],
  });
  expect(orders).toEqual(["lamp"]);
  expect(site.declined).toBe(1);
  // The composed script runs the same calls from a blank page and declares its confirmation.
  // This time the offer shows with the review: the script declines it and places the order.
  expect(placeOrder.write).toEqual({ confirmation: "readback", commits: ["place-order"] });
  site.offer = true;
  await page.goto("about:blank");
  const composed = await runExample(page, placeOrder, input, { siteOrigin: origin });
  expect(composed).toMatchObject({ confirmation: "readback", effect: "verified" });
  expect(site.declined).toBe(2);
  expect(orders).toEqual(["lamp", "lamp"]);
});

test("write-session example asks for a required field the item added, before anything saves", async ({
  page,
}) => {
  const origin = "https://shop.example.invalid";
  const orders: string[] = [];
  const input = { item: "pen", quantity: 1, gift_wrap: false };
  await checkoutSite(page, origin, orders);
  await page.goto("about:blank");
  const asked: InputRequest[] = [];
  const placed = await runExample(page, placeOrder, input, {
    siteOrigin: origin,
    answer: (request) => {
      asked.push(request);
      return { extra_field: "o1" };
    },
  });
  // The page's label and options reach the caller; the host words the question around them.
  expect(asked.map((request) => request.questions)).toEqual([
    [
      {
        id: "extra_field",
        type: "choice",
        prompt: "Engraving",
        options: [
          { id: "o1", label: "Initials" },
          { id: "o2", label: "Full name" },
        ],
      },
    ],
  ]);
  expect(asksAsDeclared(asked[0] as InputRequest, placeOrder.questions ?? {})).toBe(true);
  expect(placed).toMatchObject({
    result: Either.right({ order_number: "ORD-1001" }),
    commits: [{ name: "place-order", state: "confirmed" }],
  });
  expect(orders).toEqual(["pen"]);
});

test("write-session example stops before its commit mark when the added field can't be asked", async ({
  page,
}) => {
  const origin = "https://shop.example.invalid";
  const orders: string[] = [];
  await checkoutSite(page, origin, orders);
  await page.goto("about:blank");
  const unanswered = await runExample(page, placeOrder, { item: "pen", quantity: 1, gift_wrap: false }, {
    siteOrigin: origin,
  });
  expect(failure(unanswered.result)).toMatchObject({ _tag: "ScriptInputFailure", code: "Unavailable" });
  expect(unanswered.commits).toEqual([{ name: "place-order", state: "not_sent" }]);
  expect(orders).toEqual([]);
});

/** The fields each checkout sent on to its review, by name. */
const checkoutsOf = async (page: Page, origin: string) => {
  const sent: Record<string, string>[] = [];
  await page.route(`${origin}/checkout/review**`, (route) => {
    sent.push(Object.fromEntries(new URL(route.request().url()).searchParams));
    return route.fallback();
  });
  return sent;
};

const ringQuestions = [
  {
    id: "extra_field",
    type: "choice",
    prompt: "Ring size",
    options: [
      { id: "o1", label: "Small" },
      { id: "o2", label: "Medium" },
      { id: "o3", label: "Large" },
    ],
  },
  {
    id: "extra_field_2",
    type: "choice",
    prompt: "Metal",
    options: [
      { id: "o1", label: "Gold" },
      { id: "o2", label: "Silver" },
    ],
  },
  { id: "extra_field_3", type: "text", prompt: "Inscription" },
];

test("write-session example asks every field a step adds in one round, in page order, and fills each answer into its own field", async ({
  page,
}) => {
  const origin = "https://shop.example.invalid";
  const orders: string[] = [];
  await checkoutSite(page, origin, orders);
  const checkouts = await checkoutsOf(page, origin);
  await page.goto("about:blank");
  const asked: InputRequest[] = [];
  const placed = await runExample(page, placeOrder, { item: "ring", quantity: 1, gift_wrap: false }, {
    siteOrigin: origin,
    answer: (request) => {
      asked.push(request);
      return { extra_field: "o2", extra_field_2: "o2", extra_field_3: "S & R" };
    },
  });
  // One request: a site-field question per field, in the page's order, each with its own label
  // and options, and each one the publication reviewed.
  expect(asked.map((request) => request.questions)).toEqual([ringQuestions]);
  expect(asksAsDeclared(asked[0] as InputRequest, placeOrder.questions ?? {})).toBe(true);
  // Each answer went into the field it was asked for.
  expect(checkouts).toEqual([
    { item: "ring", quantity: "1", size: "Medium", metal: "Silver", inscription: "S & R" },
  ]);
  expect(placed).toMatchObject({
    result: Either.right({ order_number: "ORD-1001" }),
    commits: [{ name: "place-order", state: "confirmed" }],
  });
  expect(orders).toEqual(["ring"]);
});

for (const [problem, answers] of [
  ["an option the field does not offer", { extra_field: "o2", extra_field_2: "o9", extra_field_3: "S & R" }],
  ["a field left unanswered", { extra_field: "o2", extra_field_2: "o2" }],
] as const)
  test(`write-session example checks each answer of its one round and saves nothing on ${problem}`, async ({
    page,
  }) => {
    const origin = "https://shop.example.invalid";
    const orders: string[] = [];
    await checkoutSite(page, origin, orders);
    const checkouts = await checkoutsOf(page, origin);
    await page.goto("about:blank");
    const asked: InputRequest[] = [];
    const refused = await runExample(page, placeOrder, { item: "ring", quantity: 1, gift_wrap: false }, {
      siteOrigin: origin,
      answer: (request) => {
        asked.push(request);
        return answers;
      },
    });
    expect(asked.map((request) => request.questions)).toEqual([ringQuestions]);
    expect(failure(refused.result)).toMatchObject({ _tag: "ScriptInputFailure", code: "Unavailable" });
    expect(refused.commits).toEqual([{ name: "place-order", state: "not_sent" }]);
    expect(checkouts).toEqual([]);
    expect(orders).toEqual([]);
  });

test("write-session example asks a field the form adds after an answer in a second round", async ({
  page,
}) => {
  const origin = "https://shop.example.invalid";
  const orders: string[] = [];
  await checkoutSite(page, origin, orders);
  const checkouts = await checkoutsOf(page, origin);
  await page.goto("about:blank");
  const asked: InputRequest[] = [];
  const placed = await runExample(page, placeOrder, { item: "ring", quantity: 1, gift_wrap: false }, {
    siteOrigin: origin,
    answer: (request) => {
      asked.push(request);
      return asked.length === 1
        ? { extra_field: "o2", extra_field_2: "o1", extra_field_3: "S & R" }
        : { extra_field: "o2" };
    },
  });
  // Gold shows the karat only once it is chosen, so the karat is asked on its own after it.
  expect(asked.map((request) => request.questions)).toEqual([
    ringQuestions,
    [
      {
        id: "extra_field",
        type: "choice",
        prompt: "Gold karat",
        options: [
          { id: "o1", label: "14k" },
          { id: "o2", label: "18k" },
        ],
      },
    ],
  ]);
  for (const request of asked) expect(asksAsDeclared(request, placeOrder.questions ?? {})).toBe(true);
  expect(checkouts).toEqual([
    { item: "ring", quantity: "1", size: "Medium", metal: "Gold", inscription: "S & R", karat: "18k" },
  ]);
  expect(placed).toMatchObject({
    result: Either.right({ order_number: "ORD-1001" }),
    commits: [{ name: "place-order", state: "confirmed" }],
  });
  expect(orders).toEqual(["ring"]);
});

test("write-session example asks a field an answer enables after showing it greyed out", async ({ page }) => {
  const origin = "https://shop.example.invalid";
  const orders: string[] = [];
  await checkoutSite(page, origin, orders);
  const checkouts = await checkoutsOf(page, origin);
  await page.goto("about:blank");
  const asked: InputRequest[] = [];
  const placed = await runExample(page, placeOrder, { item: "watch", quantity: 1, gift_wrap: false }, {
    siteOrigin: origin,
    answer: (request) => {
      asked.push(request);
      return { extra_field: "o2" };
    },
  });
  // The strap size shows from the start, but greyed out: it is asked once the strap enables it.
  expect(asked.map((request) => request.questions.map((question) => question.prompt))).toEqual([
    ["Strap"],
    ["Strap size"],
  ]);
  expect(checkouts).toEqual([{ item: "watch", quantity: "1", strap: "Steel", strap_size: "Large" }]);
  expect(placed).toMatchObject({
    result: Either.right({ order_number: "ORD-1001" }),
    commits: [{ name: "place-order", state: "confirmed" }],
  });
  expect(orders).toEqual(["watch"]);
});

test("write-session example asks a field an answer adds whose label begins with the one answered", async ({
  page,
}) => {
  const origin = "https://shop.example.invalid";
  const orders: string[] = [];
  await checkoutSite(page, origin, orders);
  const checkouts = await checkoutsOf(page, origin);
  await page.goto("about:blank");
  const asked: InputRequest[] = [];
  const placed = await runExample(page, placeOrder, { item: "pen", quantity: 1, gift_wrap: false }, {
    siteOrigin: origin,
    answer: (request) => {
      asked.push(request);
      return { extra_field: asked.length === 1 ? "o2" : "S R" };
    },
  });
  expect(asked.map((request) => request.questions.map((question) => question.prompt))).toEqual([
    ["Engraving"],
    ["Engraving text"],
  ]);
  expect(checkouts).toEqual([
    { item: "pen", quantity: "1", engraving: "Full name", engraving_text: "S R" },
  ]);
  expect(placed).toMatchObject({ result: Either.right({ order_number: "ORD-1001" }) });
  expect(orders).toEqual(["pen"]);
});

test("write-session example never asks for an input it fills when an answer renames that field", async ({
  page,
}) => {
  const origin = "https://shop.example.invalid";
  const orders: string[] = [];
  await checkoutSite(page, origin, orders);
  const checkouts = await checkoutsOf(page, origin);
  await page.goto("about:blank");
  const asked: InputRequest[] = [];
  const stopped = await runExample(page, placeOrder, { item: "bracelet", quantity: 1, gift_wrap: false }, {
    siteOrigin: origin,
    deadlineMs: 4_000,
    answer: (request) => {
      asked.push(request);
      return { extra_field: asked.length === 1 ? "o2" : "7" };
    },
  });
  // The quantity is the caller's input, known by its name under its new label, so it is never
  // asked: the checkout stops before anything saves.
  expect(asked.map((request) => request.questions.map((question) => question.prompt))).toEqual([["Charm"]]);
  expect(failure(stopped.result)).toBeDefined();
  expect(stopped.commits).toEqual([{ name: "place-order", state: "not_sent" }]);
  expect(checkouts).toEqual([]);
  expect(orders).toEqual([]);
});

test("a tool that declares one site-field question and asks it once per field still runs as before", async ({
  page,
}) => {
  // A tool written before the example asked a step's fields in one round: one question, asked
  // with askOne for each field in turn.
  const oneByOne = defineOperation(
    {
      name: "fill_checkout",
      input: OrderInput,
      questions: { extra_field: { type: "site_field" } },
      output: Schema.Struct({ review_shown: Schema.Boolean }),
    },
    async ({ kernel, sessionId, siteOrigin, input, askOne }) => {
      const read = await kernel.browsers.playwright.execute(sessionId, {
        timeout_sec: 60,
        code: `
          ${formControlsCode}
          await page.goto(${JSON.stringify(`${siteOrigin}/checkout`)});
          const form = page.getByRole("form", { name: "Checkout", exact: true });
          await form.getByLabel("Item", { exact: true }).fill(${JSON.stringify(input.item)});
          await form.getByLabel("Quantity", { exact: true }).fill(${JSON.stringify(String(input.quantity))});
          return await unfilledRequiredFields(form);
        `,
      });
      const fields = read.result as { label: string; options?: { value: string; label: string }[] }[];
      const answers: { label: string; answer: string }[] = [];
      for (const { label, options } of fields)
        answers.push({
          label,
          answer: await askOne("extra_field", options === undefined ? { label } : { label, options }),
        });
      const continued = await kernel.browsers.playwright.execute(sessionId, {
        timeout_sec: 60,
        code: `
          ${formControlsCode}
          const form = page.getByRole("form", { name: "Checkout", exact: true });
          for (const { label, answer } of ${JSON.stringify(answers)}) await fillRequiredField(form, label, answer);
          await form.getByRole("button", { name: "Continue", exact: true }).click();
          await page.getByRole("button", { name: "Place order", exact: true }).waitFor({ timeout: 10000 });
          return true;
        `,
      });
      return { review_shown: continued.success && continued.result === true };
    },
  );
  const origin = "https://shop.example.invalid";
  const orders: string[] = [];
  await checkoutSite(page, origin, orders);
  const checkouts = await checkoutsOf(page, origin);
  await page.goto("about:blank");
  const asked: InputRequest[] = [];
  const filled = await runExample(page, oneByOne, { item: "ring", quantity: 1, gift_wrap: false }, {
    siteOrigin: origin,
    answer: (request) => {
      asked.push(request);
      return { extra_field: ["o2", "o2", "S & R"][asked.length - 1] ?? "" };
    },
  });
  // Each field is still its own request, asked and checked as that tool declared it.
  expect(asked.map((request) => request.questions)).toEqual(
    ringQuestions.map((question) => [{ ...question, id: "extra_field" }]),
  );
  for (const request of asked)
    expect(asksAsDeclared(request, { extra_field: { type: "site_field" } })).toBe(true);
  expect(filled.result).toEqual(Either.right({ review_shown: true }));
  expect(checkouts).toEqual([
    { item: "ring", quantity: "1", size: "Medium", metal: "Silver", inscription: "S & R" },
  ]);
  expect(orders).toEqual([]);
});

test("write-session example asks for a field the review flags only after Place order, then places the order once", async ({
  page,
}) => {
  const origin = "https://shop.example.invalid";
  const orders: string[] = [];
  const phones: string[] = [];
  await checkoutSite(page, origin, orders);
  await page.route(`${origin}/orders`, (route) => {
    phones.push(new URLSearchParams(route.request().postData() ?? "").get("phone") ?? "");
    return route.fallback();
  });
  await page.goto("about:blank");
  const asked: InputRequest[] = [];
  const placed = await runExample(page, placeOrder, { item: "armchair", quantity: 1, gift_wrap: false }, {
    siteOrigin: origin,
    answer: (request) => {
      asked.push(request);
      return { extra_field: "555-0100" };
    },
  });
  // The click proved it saved nothing, so the field it showed is asked, filled, and the order
  // placed by the second click alone.
  expect(asked.map((request) => request.questions)).toEqual([
    [{ id: "extra_field", type: "text", prompt: "Delivery phone" }],
  ]);
  expect(placed).toMatchObject({
    result: Either.right({ order_number: "ORD-1001" }),
    effect: "verified",
    commits: [{ name: "place-order", state: "confirmed" }],
  });
  expect(orders).toEqual(["armchair"]);
  expect(phones).toEqual(["555-0100"]);
});

test("write-session example records its click unsent before it asks the field the click proved missing", async ({
  page,
}) => {
  const origin = "https://shop.example.invalid";
  const orders: string[] = [];
  await checkoutSite(page, origin, orders);
  await page.goto("about:blank");
  const journal = await Effect.runPromise(makeEffectJournal);
  const whileAsked: unknown[] = [];
  const placed = await runExample(page, placeOrder, { item: "armchair", quantity: 1, gift_wrap: false }, {
    siteOrigin: origin,
    journal,
    answer: () => {
      whileAsked.push(Effect.runSync(journal.commits));
      return { extra_field: "555-0100" };
    },
  });
  // The click proved it saved nothing, so the step reads unsent while the question waits.
  expect(whileAsked).toEqual([[{ name: "place-order", state: "not_sent" }]]);
  // Entered again once the answer is filled, the second click alone places the order.
  expect(placed).toMatchObject({
    result: Either.right({ order_number: "ORD-1001" }),
    effect: "verified",
    commits: [{ name: "place-order", state: "confirmed" }],
  });
  expect(orders).toEqual(["armchair"]);
});

test("write-session example's act steps ask for a field the review flags only after Place order, then place the order once", async ({
  page,
}) => {
  // An act step declares no write, so the step it marks is one it never declared: it still goes
  // back once, so the build's act session can finish.
  const origin = "https://shop.example.invalid";
  const orders: string[] = [];
  const input = { item: "armchair", quantity: 1, gift_wrap: false };
  await checkoutSite(page, origin, orders);
  await page.goto("about:blank");
  const filled = await runExample(page, fillStep, input, { siteOrigin: origin });
  expect(filled.result).toEqual(Either.right({ review_shown: true }));
  const asked: InputRequest[] = [];
  const placed = await runExample(page, placeStep, input, {
    siteOrigin: origin,
    answer: (request) => {
      asked.push(request);
      return { extra_field: "555-0100" };
    },
  });
  expect(asked.map((request) => request.questions.map((question) => question.prompt))).toEqual([["Delivery phone"]]);
  expect(placed).toMatchObject({
    result: Either.right({ order_number: "ORD-1001" }),
    commits: [{ name: "place-order", state: "confirmed" }],
  });
  expect(orders).toEqual(["armchair"]);
});

test("write-session example asks nothing after a click whose page may have saved, and keeps it possibly sent", async ({
  page,
}) => {
  const origin = "https://shop.example.invalid";
  const orders: string[] = [];
  await checkoutSite(page, origin, orders);
  await page.goto("about:blank");
  const asked: InputRequest[] = [];
  const unsure = await runExample(page, placeOrder, { item: "sofa", quantity: 1, gift_wrap: false }, {
    siteOrigin: origin,
    answer: (request) => {
      asked.push(request);
      return { extra_field: "555-0100" };
    },
  });
  // The review came back with a filled field flagged: nothing proves the click saved nothing.
  expect(failure(unsure.result)).toMatchObject({ _tag: "OperationFailure", message: "not_confirmed" });
  expect(asked).toEqual([]);
  expect(unsure.commits).toEqual([{ name: "place-order", state: "sent" }]);
  expect(orders).toEqual(["sofa"]);
});

test("write-session example reports the order not sent when nobody answers the field a click proved missing", async ({
  page,
}) => {
  const origin = "https://shop.example.invalid";
  const orders: string[] = [];
  await checkoutSite(page, origin, orders);
  await page.goto("about:blank");
  const unanswered = await runExample(page, placeOrder, { item: "armchair", quantity: 1, gift_wrap: false }, {
    siteOrigin: origin,
  });
  expect(failure(unanswered.result)).toMatchObject({ _tag: "ScriptInputFailure", code: "Unavailable" });
  // The step went back before the question, so a run that ends on it reports nothing sent.
  expect(unanswered.commits).toEqual([{ name: "place-order", state: "not_sent" }]);
  expect(commitRetryRefusal(commitEvidenceOf(unanswered.commits))).toBeUndefined();
  expect(unenteredWrite(unanswered.effect, unanswered.commits)).toBe(true);
  expect(orders).toEqual([]);
});

/**
 * A review page after the checkout. Its form holds `fields`; Place order runs `refuseFirst` in
 * the page instead of saving on the first click when set, and otherwise saves the order by a
 * fetch and then runs `afterSave`, with `form`, the order's `number` and `confirm(ms)`, which
 * shows the confirmation that many milliseconds later.
 */
const reviewSite = async (
  page: Page,
  origin: string,
  orders: string[],
  site: { fields: string; afterSave?: string; refuseFirst?: string; novalidate?: boolean },
) => {
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/checkout")
      return route.fulfill({
        contentType: "text/html",
        body: `<form aria-label="Checkout" method="get" action="/checkout/review">
          <label>Item<input name="item"></label><label>Quantity<input name="quantity"></label>
          <label><input type="checkbox" name="giftWrap"> Gift wrap</label>
          <button>Continue</button>
        </form>`,
      });
    if (url.pathname === "/checkout/review") {
      const item = url.searchParams.get("item") ?? "";
      const quantity = url.searchParams.get("quantity") ?? "1";
      return route.fulfill({
        contentType: "text/html",
        body: `<p aria-label="Item">${item}</p><p aria-label="Order total">$${(Number(quantity) * 12.5).toFixed(2)}</p>
          <form aria-label="Review" ${site.novalidate === true ? "novalidate" : ""}>
          <input type="hidden" name="item" value="${item}"><input type="hidden" name="quantity" value="${quantity}">
          ${site.fields}<button>Place order</button></form>
          <script>
            const form = document.forms[0];
            let number = "";
            const confirm = (delay) => setTimeout(() => {
              const shown = document.createElement("p");
              shown.setAttribute("role", "status");
              shown.setAttribute("aria-label", "Order confirmation");
              shown.textContent = "Order " + number + " is placed.";
              document.body.append(shown);
            }, delay);
            let refused = ${site.refuseFirst === undefined ? "true" : "false"};
            form.addEventListener("submit", async (event) => {
              event.preventDefault();
              if (!refused) {
                refused = true;
                ${site.refuseFirst ?? ""}
                return;
              }
              const answer = await fetch("/orders", { method: "POST", body: new URLSearchParams(new FormData(form)) });
              number = await answer.text();
              ${site.afterSave ?? ""}
            });
          </script>`,
      });
    }
    if (url.pathname === "/orders" && request.method() === "POST") {
      const posted = new URLSearchParams(request.postData() ?? "");
      const extra = [...posted.keys()].filter((key) => !["item", "quantity"].includes(key));
      orders.push([posted.get("item") ?? "", ...extra.map((key) => `${key}=${posted.get(key)}`)].join("|"));
      return route.fulfill({ contentType: "text/plain", body: `ORD-${1000 + orders.length}` });
    }
    return route.fulfill({ status: 404, body: "Not found" });
  });
};

/**
 * Review pages whose Place order click does save and then leave a field flagged that was already
 * on the page before the click, some with its label rewritten as they flag it. The confirmation
 * shows only later.
 */
const savingReviews = {
  // An app that clears its form for the next order.
  reset: {
    fields: `<label>Contact email<input type="email" name="email" required value="sam@example.com"></label>`,
    afterSave: `form.querySelector("[name=email]").value = ""; confirm(800);`,
  },
  // A form that skips the browser's check and has a stray required on an optional field.
  novalidate: {
    novalidate: true,
    fields: `<label>Company<input name="company" required></label>`,
    afterSave: `confirm(400);`,
  },
  // A field the page flagged before the click, while the confirmation is slow.
  processing: {
    fields: `<label>Delivery instructions<input name="instructions" aria-required="true" aria-invalid="true"></label>`,
    afterSave: `document.body.insertAdjacentHTML("beforeend", "<p>Processing your order</p>"); confirm(4000);`,
  },
  // The cleared field's error message, written inside its label.
  "message in the label": {
    fields: `<label>Contact email <input type="email" name="email" required value="sam@example.com"></label>`,
    afterSave: `const email = form.querySelector("[name=email]"); email.value = ""; email.setAttribute("aria-invalid", "true");
      email.parentElement.insertAdjacentHTML("beforeend", '<span class="error">Enter an email address</span>'); confirm(800);`,
  },
  // A validator's error label, pointed at the field with for, which then names it.
  "error label for the field": {
    novalidate: true,
    fields: `<label>Company <input id="company" name="company" required></label>`,
    afterSave: `const company = form.querySelector("#company"); company.setAttribute("aria-invalid", "true");
      company.parentElement.insertAdjacentHTML("afterend", '<label id="company-error" class="error" for="company">This field is required.</label>'); confirm(400);`,
  },
  // "(required)" added to the label of the field it flags.
  "label marked required": {
    fields: `<label for="instr">Delivery instructions</label><input id="instr" name="instructions" aria-required="true" aria-invalid="true">`,
    afterSave: `document.body.insertAdjacentHTML("beforeend", "<p>Processing your order</p>");
      document.querySelector("label[for=instr]").textContent = "Delivery instructions (required)"; confirm(4000);`,
  },
  // A field with no label before the click, named by the aria-label it gets when flagged.
  "label given on flag": {
    novalidate: true,
    fields: `<input name="phone" placeholder="Phone" required>`,
    afterSave: `const phone = form.querySelector("[name=phone]"); phone.setAttribute("aria-label", "Phone number"); phone.setAttribute("aria-invalid", "true"); confirm(400);`,
  },
  // A field with no name or id, whose label gains the error message the save writes inside it.
  "unnamed field's label gains its error": {
    fields: `<label>Contact phone <input type="tel" required value="555-0100"></label>`,
    afterSave: `const phone = form.querySelector("[type=tel]"); phone.value = ""; phone.setAttribute("aria-invalid", "true");
      phone.parentElement.insertAdjacentHTML("beforeend", '<span class="error">Required</span>'); confirm(1500);`,
  },
  // A named field the save clears and renames, with an error mark written inside its label.
  "renamed field's label gains a star": {
    fields: `<label>Contact email <input type="email" name="email_r1" required value="sam@example.com"></label>`,
    afterSave: `const email = form.querySelector("[name=email_r1]"); email.value = ""; email.name = "email_r2"; email.setAttribute("aria-invalid", "true");
      email.parentElement.insertAdjacentHTML("beforeend", '<span class="error">*</span>'); confirm(800);`,
  },
  "renamed field's label gains a word": {
    fields: `<label>Contact email <input type="email" name="email_r1" required value="sam@example.com"></label>`,
    afterSave: `const email = form.querySelector("[name=email_r1]"); email.value = ""; email.name = "email_r2"; email.setAttribute("aria-invalid", "true");
      email.parentElement.insertAdjacentHTML("beforeend", '<span class="error">verplicht</span>'); confirm(800);`,
  },
  // A field with no name that the save gives one, with an error mark inside its label.
  "unnamed field gains a name": {
    fields: `<label>Contact email <input type="email" required value="sam@example.com"></label>`,
    afterSave: `const email = form.querySelector("[type=email]"); email.value = ""; email.name = "email"; email.setAttribute("aria-invalid", "true");
      email.parentElement.insertAdjacentHTML("beforeend", '<span class="error">*</span>'); confirm(800);`,
  },
  // A field the save mounts again with a new name and id, its label marked.
  "field mounted again": {
    fields: `<div id="email-box"><label for="email-a">Contact email</label><input type="email" id="email-a" name="email_a" required value="sam@example.com"></div>`,
    afterSave: `document.querySelector("#email-box").innerHTML = '<label for="email-b">Contact email *</label><input type="email" id="email-b" name="email_b" required aria-invalid="true">';
      confirm(800);`,
  },
  // aria-labelledby that gains the error's id, so its label becomes "Phone is required".
  "error joins the label": {
    fields: `<span id="ph-l">Phone</span><input name="phone" aria-labelledby="ph-l" required value="555-0100">`,
    afterSave: `const phone = form.querySelector("[name=phone]"); phone.value = ""; phone.setAttribute("aria-invalid", "true");
      phone.insertAdjacentHTML("afterend", '<span id="ph-e">is required</span>'); phone.setAttribute("aria-labelledby", "ph-l ph-e"); confirm(800);`,
  },
  // A card field the save clears: no question may ask it, and it was there before the click.
  "card field cleared": {
    fields: `<label>Card number<input name="card_number" autocomplete="cc-number" required value="on file"></label>`,
    afterSave: `const card = form.querySelector("[name=card_number]"); card.value = ""; card.setAttribute("aria-invalid", "true"); confirm(800);`,
  },
};

for (const [variant, site] of Object.entries(savingReviews))
  test(`write-session example never clicks again when a field on the page before the click is flagged after it (${variant})`, async ({
    page,
  }) => {
    const origin = "https://shop.example.invalid";
    const orders: string[] = [];
    await reviewSite(page, origin, orders, site);
    await page.goto("about:blank");
    const asked: InputRequest[] = [];
    const saved = await runExample(page, placeOrder, { item: "lamp", quantity: 1, gift_wrap: false }, {
      siteOrigin: origin,
      // An answer each flagged field would take, so a wrong question shows as a second order.
      answer: (request) => {
        asked.push(request);
        return { extra_field: "sam@example.com" };
      },
    });
    // The flagged field was there before the click, so nothing proves the click saved nothing.
    expect(orders).toHaveLength(1);
    expect(asked).toEqual([]);
    expect(saved.commits).toEqual([{ name: "place-order", state: "sent" }]);
    expect(failure(saved.result)).toMatchObject({ _tag: "OperationFailure", message: "not_confirmed" });
  });

test("write-session example asks nothing after a save that hides a field and shows a new required one, and keeps it possibly sent", async ({
  page,
}) => {
  // The save resets the form to pickup, which hides the delivery address and shows a required
  // store the page never showed before the click. A field the click hid proves nothing, so
  // nothing is asked and the step stays sent.
  const origin = "https://shop.example.invalid";
  const orders: string[] = [];
  await reviewSite(page, origin, orders, {
    fields: `<label>Delivery method<select name="method"><option selected>Delivery</option><option>Pickup</option></select></label>
      <label>Delivery address<input name="address" required value="1 Main St"></label>
      <label hidden>Pickup store<select name="store"><option value="">Choose</option><option>North</option><option>South</option></select></label>`,
    afterSave: `form.querySelector("[name=method]").value = "Pickup";
      const address = form.querySelector("[name=address]"); address.parentElement.hidden = true; address.value = ""; address.required = false;
      const store = form.querySelector("[name=store]"); store.parentElement.hidden = false; store.required = true; store.setAttribute("aria-invalid", "true");
      confirm(800);`,
  });
  await page.goto("about:blank");
  const asked: InputRequest[] = [];
  const saved = await runExample(page, placeOrder, { item: "lamp", quantity: 1, gift_wrap: false }, {
    siteOrigin: origin,
    answer: (request) => {
      asked.push(request);
      return { extra_field: "o1" };
    },
  });
  expect(asked).toEqual([]);
  expect(orders).toHaveLength(1);
  expect(failure(saved.result)).toMatchObject({
    _tag: "OperationFailure",
    message: "not_confirmed",
    dispatch: "sent",
  });
  expect(saved.commits).toEqual([{ name: "place-order", state: "sent" }]);
  expect(commitRetryRefusal(commitEvidenceOf(saved.commits))).toBe("commit_entered");
});

test("write-session example checks the review again before its second click when the answer changes the total", async ({
  page,
}) => {
  // The click is refused until a delivery speed is chosen, and express adds 5.00 to the total.
  const origin = "https://shop.example.invalid";
  const orders: string[] = [];
  await reviewSite(page, origin, orders, {
    fields: `<label hidden>Delivery speed<select name="speed"><option value="">Choose</option><option>Express</option><option>Standard</option></select></label>`,
    refuseFirst: `const speed = form.querySelector("[name=speed]"); speed.parentElement.hidden = false; speed.setAttribute("aria-invalid", "true");
      speed.addEventListener("change", () => {
        const total = document.querySelector("[aria-label='Order total']");
        total.textContent = speed.value === "Express" ? "$17.50" : "$12.50";
      });`,
    afterSave: `confirm(200);`,
  });
  await page.goto("about:blank");
  const asked: InputRequest[] = [];
  const placed = await runExample(page, placeOrder, { item: "lamp", quantity: 1, gift_wrap: false }, {
    siteOrigin: origin,
    answer: (request) => {
      asked.push(request);
      return { extra_field: "o1" };
    },
  });
  expect(asked.map((request) => request.questions.map((question) => question.prompt))).toEqual([["Delivery speed"]]);
  expect(placed).toMatchObject({
    result: Either.right({ order_number: "ORD-1001" }),
    commits: [{ name: "place-order", state: "confirmed" }],
  });
  expect(orders).toEqual(["lamp|speed=Express"]);
});

test("write-session example asks a field the review adds after an answer in a second round, then clicks once more", async ({
  page,
}) => {
  // The click is refused until a delivery method is chosen, and a courier then needs a phone.
  const origin = "https://shop.example.invalid";
  const orders: string[] = [];
  await reviewSite(page, origin, orders, {
    fields: `<label hidden>Delivery method<select name="method"><option value="">Choose</option><option>Courier</option><option>Post</option></select></label>
      <label hidden>Courier phone<input type="tel" name="phone" disabled></label>`,
    refuseFirst: `const method = form.querySelector("[name=method]"); method.parentElement.hidden = false; method.setAttribute("aria-invalid", "true");
      method.addEventListener("change", () => {
        const phone = form.querySelector("[name=phone]");
        const courier = method.value === "Courier";
        phone.disabled = !courier;
        phone.required = courier;
        phone.parentElement.hidden = !courier;
      });`,
    afterSave: `confirm(200);`,
  });
  await page.goto("about:blank");
  const asked: InputRequest[] = [];
  const placed = await runExample(page, placeOrder, { item: "lamp", quantity: 1, gift_wrap: false }, {
    siteOrigin: origin,
    answer: (request) => {
      asked.push(request);
      return { extra_field: asked.length === 1 ? "o1" : "555-0100" };
    },
  });
  expect(asked.map((request) => request.questions.map((question) => question.prompt))).toEqual([
    ["Delivery method"],
    ["Courier phone"],
  ]);
  expect(placed).toMatchObject({
    result: Either.right({ order_number: "ORD-1001" }),
    commits: [{ name: "place-order", state: "confirmed" }],
  });
  expect(orders).toEqual(["lamp|method=Courier|phone=555-0100"]);
});

test("write-session example asks a field the review enables after an answer, then clicks once more", async ({
  page,
}) => {
  // The courier phone shows greyed out from the start, and choosing a courier enables it.
  const origin = "https://shop.example.invalid";
  const orders: string[] = [];
  await reviewSite(page, origin, orders, {
    fields: `<label hidden>Delivery method<select name="method"><option value="">Choose</option><option>Courier</option><option>Post</option></select></label>
      <label>Courier phone<input type="tel" name="phone" disabled></label>`,
    refuseFirst: `const method = form.querySelector("[name=method]"); method.parentElement.hidden = false; method.setAttribute("aria-invalid", "true");
      method.addEventListener("change", () => {
        const phone = form.querySelector("[name=phone]");
        phone.disabled = method.value !== "Courier";
        phone.required = !phone.disabled;
      });`,
    afterSave: `confirm(200);`,
  });
  await page.goto("about:blank");
  const asked: InputRequest[] = [];
  const placed = await runExample(page, placeOrder, { item: "lamp", quantity: 1, gift_wrap: false }, {
    siteOrigin: origin,
    answer: (request) => {
      asked.push(request);
      return { extra_field: asked.length === 1 ? "o1" : "555-0100" };
    },
  });
  expect(asked.map((request) => request.questions.map((question) => question.prompt))).toEqual([
    ["Delivery method"],
    ["Courier phone"],
  ]);
  expect(placed).toMatchObject({
    result: Either.right({ order_number: "ORD-1001" }),
    commits: [{ name: "place-order", state: "confirmed" }],
  });
  expect(orders).toEqual(["lamp|method=Courier|phone=555-0100"]);
});

test("write-session example asks no second round for a required box with no label", async ({ page }) => {
  // The review has a required box with no label, name or id, which no question could ask.
  const origin = "https://shop.example.invalid";
  const orders: string[] = [];
  await reviewSite(page, origin, orders, {
    fields: `<input class="reference" aria-required="true">
      <label hidden>Delivery speed<select name="speed"><option value="">Choose</option><option>Express</option><option>Standard</option></select></label>`,
    refuseFirst: `const speed = form.querySelector("[name=speed]"); speed.parentElement.hidden = false; speed.setAttribute("aria-invalid", "true");`,
    afterSave: `confirm(200);`,
  });
  await page.goto("about:blank");
  const asked: InputRequest[] = [];
  const placed = await runExample(page, placeOrder, { item: "lamp", quantity: 1, gift_wrap: false }, {
    siteOrigin: origin,
    answer: (request) => {
      asked.push(request);
      return { extra_field: "o1" };
    },
  });
  expect(asked.map((request) => request.questions.map((question) => question.prompt))).toEqual([
    ["Delivery speed"],
  ]);
  expect(placed).toMatchObject({
    result: Either.right({ order_number: "ORD-1001" }),
    commits: [{ name: "place-order", state: "confirmed" }],
  });
  expect(orders).toEqual(["lamp|speed=Express"]);
});

test("write-session example asks no second round for a required field the review showed before the answers", async ({
  page,
}) => {
  // A review that marks an optional field required, which its own check never enforces: it was
  // on the review all along, so it is no field an answer added.
  const origin = "https://shop.example.invalid";
  const orders: string[] = [];
  await reviewSite(page, origin, orders, {
    fields: `<label>Company<input name="company" aria-required="true"></label>
      <label hidden>Delivery speed<select name="speed"><option value="">Choose</option><option>Express</option><option>Standard</option></select></label>`,
    refuseFirst: `const speed = form.querySelector("[name=speed]"); speed.parentElement.hidden = false; speed.setAttribute("aria-invalid", "true");`,
    afterSave: `confirm(200);`,
  });
  await page.goto("about:blank");
  const asked: InputRequest[] = [];
  const placed = await runExample(page, placeOrder, { item: "lamp", quantity: 1, gift_wrap: false }, {
    siteOrigin: origin,
    answer: (request) => {
      asked.push(request);
      return { extra_field: "o1" };
    },
  });
  expect(asked.map((request) => request.questions.map((question) => question.prompt))).toEqual([
    ["Delivery speed"],
  ]);
  expect(placed).toMatchObject({
    result: Either.right({ order_number: "ORD-1001" }),
    commits: [{ name: "place-order", state: "confirmed" }],
  });
  expect(orders).toEqual(["lamp|company=|speed=Express"]);
});

test("write-session example asks the fields past its declared questions in the next round", async ({
  page,
}) => {
  // The click is refused with four fields flagged at once, one more than the example declares.
  const origin = "https://shop.example.invalid";
  const orders: string[] = [];
  await reviewSite(page, origin, orders, {
    fields: `<div id="contact" hidden><label>First name<input name="first"></label><label>Last name<input name="last"></label>
      <label>Company<input name="company"></label><label>Phone<input type="tel" name="phone"></label></div>`,
    refuseFirst: `const contact = form.querySelector("#contact"); contact.hidden = false;
      contact.querySelectorAll("input").forEach((input) => { input.required = true; input.setAttribute("aria-invalid", "true"); });`,
    afterSave: `confirm(200);`,
  });
  await page.goto("about:blank");
  const asked: InputRequest[] = [];
  const placed = await runExample(page, placeOrder, { item: "lamp", quantity: 1, gift_wrap: false }, {
    siteOrigin: origin,
    answer: (request) => {
      asked.push(request);
      return asked.length === 1
        ? { extra_field: "Sam", extra_field_2: "Lee", extra_field_3: "Acme" }
        : { extra_field: "555-0100" };
    },
  });
  expect(
    asked.map((request) => request.questions.map(({ id, prompt }) => `${id}: ${prompt}`)),
  ).toEqual([
    ["extra_field: First name", "extra_field_2: Last name", "extra_field_3: Company"],
    ["extra_field: Phone"],
  ]);
  for (const request of asked) expect(asksAsDeclared(request, placeOrder.questions ?? {})).toBe(true);
  expect(placed).toMatchObject({
    result: Either.right({ order_number: "ORD-1001" }),
    commits: [{ name: "place-order", state: "confirmed" }],
  });
  expect(orders).toEqual(["lamp|first=Sam|last=Lee|company=Acme|phone=555-0100"]);
});

test("write-session example never clicks again when an answer shows a field no question can ask", async ({
  page,
}) => {
  // A courier needs a card on the review, which a site-field question never asks for.
  const origin = "https://shop.example.invalid";
  const orders: string[] = [];
  await reviewSite(page, origin, orders, {
    fields: `<label hidden>Delivery method<select name="method"><option value="">Choose</option><option>Courier</option><option>Post</option></select></label>
      <label hidden>Card number<input name="card" disabled></label>`,
    refuseFirst: `const method = form.querySelector("[name=method]"); method.parentElement.hidden = false; method.setAttribute("aria-invalid", "true");
      method.addEventListener("change", () => {
        const card = form.querySelector("[name=card]");
        const courier = method.value === "Courier";
        card.disabled = !courier;
        card.required = courier;
        card.parentElement.hidden = !courier;
      });`,
    afterSave: `confirm(200);`,
  });
  await page.goto("about:blank");
  const asked: InputRequest[] = [];
  const stopped = await runExample(page, placeOrder, { item: "lamp", quantity: 1, gift_wrap: false }, {
    siteOrigin: origin,
    answer: (request) => {
      asked.push(request);
      return { extra_field: "o1" };
    },
  });
  expect(asked.map((request) => request.questions.map((question) => question.prompt))).toEqual([
    ["Delivery method"],
  ]);
  // The step went back before the question and was never entered again, so it reads unsent.
  expect(failure(stopped.result)).toMatchObject({
    _tag: "OperationFailure",
    message: "not_confirmed",
    dispatch: "not_sent",
  });
  expect(stopped.commits).toEqual([{ name: "place-order", state: "not_sent" }]);
  expect(orders).toEqual([]);
});

test("write-session example refuses with the step unsent when its click shows card fields no question can ask", async ({
  page,
}) => {
  // Place order is refused until a card and its bank's routing number are given: the click shows
  // both, new, empty and required, so it saved nothing, and no site-field question may ask them.
  const origin = "https://shop.example.invalid";
  const orders: string[] = [];
  await reviewSite(page, origin, orders, {
    fields: `<label hidden>Card number<input name="card_number" autocomplete="cc-number"></label>
      <label hidden>Routing number<input name="routing"></label>`,
    refuseFirst: `for (const name of ["card_number", "routing"]) {
        const field = form.querySelector("[name=" + name + "]");
        field.parentElement.hidden = false;
        field.required = true;
        field.setAttribute("aria-invalid", "true");
      }`,
    afterSave: `confirm(200);`,
  });
  await page.goto("about:blank");
  const asked: InputRequest[] = [];
  const refused = await runExample(page, placeOrder, { item: "lamp", quantity: 1, gift_wrap: false }, {
    siteOrigin: origin,
    answer: (request) => {
      asked.push(request);
      return { extra_field: "o1" };
    },
  });
  // The caller's refusal names both fields, nothing is asked or clicked again, and the step reads
  // unsent, so the run reports that the write changed nothing.
  expect(failure(refused.result)).toMatchObject({ _tag: "InvalidInput" });
  const { message } = failure(refused.result) as Error;
  expect(message).toContain("Card number");
  expect(message).toContain("Routing number");
  expect(asked).toEqual([]);
  expect(refused.commits).toEqual([{ name: "place-order", state: "not_sent" }]);
  expect(unenteredWrite(refused.effect, refused.commits)).toBe(true);
  expect(orders).toEqual([]);
});

test("write-session example keeps the step sent when its second click shows a field no question can ask", async ({
  page,
}) => {
  // The first click asks for a phone. The second, with the phone filled, shows a card field and
  // saves nothing, but the step already went back once, so it stays possibly sent.
  const origin = "https://shop.example.invalid";
  const orders: string[] = [];
  await reviewSite(page, origin, orders, {
    fields: `<label hidden>Delivery phone<input type="tel" name="phone"></label>
      <label hidden>Card number<input name="card_number" autocomplete="cc-number"></label>
      <script>
        let clicks = 0;
        document.forms[0].addEventListener("submit", (event) => {
          clicks += 1;
          if (clicks !== 2) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          const card = document.querySelector("[name=card_number]");
          card.parentElement.hidden = false;
          card.required = true;
          card.setAttribute("aria-invalid", "true");
        });
      </script>`,
    refuseFirst: `const phone = form.querySelector("[name=phone]"); phone.parentElement.hidden = false; phone.setAttribute("aria-invalid", "true");`,
    afterSave: `confirm(200);`,
  });
  await page.goto("about:blank");
  const asked: InputRequest[] = [];
  const stopped = await runExample(page, placeOrder, { item: "lamp", quantity: 1, gift_wrap: false }, {
    siteOrigin: origin,
    answer: (request) => {
      asked.push(request);
      return { extra_field: "555-0100" };
    },
  });
  expect(asked.map((request) => request.questions.map((question) => question.prompt))).toEqual([
    ["Delivery phone"],
  ]);
  expect(failure(stopped.result)).toMatchObject({ _tag: "OperationFailure", message: "not_confirmed" });
  expect(stopped.commits).toEqual([{ name: "place-order", state: "sent" }]);
  expect(orders).toEqual([]);
});

test("write-session example keeps the step sent when its second click shows another field to ask", async ({
  page,
}) => {
  // The first click asks for a phone. The second, with the phone filled, shows delivery notes and
  // saves nothing, but the step already went back once, so it stays possibly sent, asked no more.
  const origin = "https://shop.example.invalid";
  const orders: string[] = [];
  await reviewSite(page, origin, orders, {
    fields: `<label hidden>Delivery phone<input type="tel" name="phone"></label>
      <label hidden>Delivery notes<input name="notes"></label>
      <script>
        let clicks = 0;
        document.forms[0].addEventListener("submit", (event) => {
          clicks += 1;
          if (clicks !== 2) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          const notes = document.querySelector("[name=notes]");
          notes.parentElement.hidden = false;
          notes.required = true;
          notes.setAttribute("aria-invalid", "true");
        });
      </script>`,
    refuseFirst: `const phone = form.querySelector("[name=phone]"); phone.parentElement.hidden = false; phone.setAttribute("aria-invalid", "true");`,
    afterSave: `confirm(200);`,
  });
  await page.goto("about:blank");
  const asked: InputRequest[] = [];
  const stopped = await runExample(page, placeOrder, { item: "lamp", quantity: 1, gift_wrap: false }, {
    siteOrigin: origin,
    answer: (request) => {
      asked.push(request);
      return { extra_field: "555-0100" };
    },
  });
  expect(asked.map((request) => request.questions.map((question) => question.prompt))).toEqual([
    ["Delivery phone"],
  ]);
  expect(failure(stopped.result)).toMatchObject({
    _tag: "OperationFailure",
    message: "not_confirmed",
    dispatch: "sent",
  });
  expect(stopped.commits).toEqual([{ name: "place-order", state: "sent" }]);
  expect(orders).toEqual([]);
});

test("write-session example refuses a total over the caller's limit before its commit mark", async ({
  page,
}) => {
  const origin = "https://shop.example.invalid";
  const orders: string[] = [];
  const input = { item: "lamp", quantity: 3, gift_wrap: false, max_total_minor: 2500 };
  await checkoutSite(page, origin, orders);
  await page.goto("about:blank");
  const refused = await runExample(page, placeOrder, input, { siteOrigin: origin });
  expect(failure(refused.result)).toMatchObject({
    _tag: "InvalidInput",
    field: "max_total_minor",
    kind: "over_price_limit",
  });
  // The caller sees the total the page showed beside the limit.
  const { message } = failure(refused.result) as Error;
  expect(message).toContain("3750");
  expect(message).toContain("2500");
  // The refusal came before the mark, so the run shows nothing sent and no order exists.
  expect(refused.commits).toEqual([{ name: "place-order", state: "not_sent" }]);
  expect(orders).toEqual([]);
});

test("write-session example stops before clicking when the total moves after its check", async ({
  page,
}) => {
  const origin = "https://shop.example.invalid";
  const orders: string[] = [];
  const input = { item: "lamp", quantity: 2, gift_wrap: false, max_total_minor: 2500 };
  await checkoutSite(page, origin, orders);
  await page.goto("about:blank");
  await runExample(page, fillStep, input, { siteOrigin: origin });
  // The site raises the total between the check before the mark and the marked call.
  const moved = defineOperation(
    {
      name: "place_order",
      input: OrderInput,
      output: Schema.Struct({ order_number: Schema.String }),
      questions: {
        extra_field: { type: "site_field" },
        extra_field_2: { type: "site_field" },
        extra_field_3: { type: "site_field" },
      },
      write: { confirmation: "readback", commits: ["place-order"] },
    },
    async (context) => {
      const checked = await checkReview(context);
      await page.getByLabel("Order total", { exact: true }).evaluate((total) => {
        total.textContent = "$26.00";
      });
      return placeAndConfirm(context, checked);
    },
  );
  const stopped = await runExample(page, moved, input, { siteOrigin: origin });
  expect(failure(stopped.result)).toMatchObject({
    _tag: "OperationFailure",
    message: "total_changed",
  });
  // The mark was entered, so the run counts the commit as possibly sent, though no order exists.
  expect(stopped.commits).toEqual([{ name: "place-order", state: "sent" }]);
  expect(orders).toEqual([]);
});

/** A write that saves an address, then places an order, each its own marked commit step. */
const markedWrite = (placeOrder: "click" | "refused") =>
  defineOperation(
    {
      name: "place_order",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      write: { confirmation: "message", commits: ["save-address", "place-order"] },
    },
    async ({ kernel, sessionId, enteringCommit, verified, errors }) => {
      enteringCommit("save-address");
      await kernel.browsers.playwright.execute(sessionId, { code: 'await page.click("#save");' });
      // A check that refuses the order stops the step before its commit is marked.
      if (placeOrder === "refused")
        throw new errors.OperationFailure("order total changed", { dispatch: "not_sent" });
      enteringCommit("place-order");
      await kernel.browsers.playwright.execute(sessionId, { code: 'await page.click("#place");' });
      verified({ confirmation: "message" });
      return {};
    },
  );

test("a write's commit marks read not_sent until their call runs, then sent, then confirmed", async ({
  page,
}) => {
  await page.setContent(
    "<button id='save' onclick=\"document.querySelector('#saved').textContent++\">Save address</button>" +
      "<button id='place' onclick=\"document.querySelector('#placed').textContent++\">Place order</button>" +
      "<output id='saved'>0</output><output id='placed'>0</output>",
  );
  const refused = await runExample(page, markedWrite("refused"), {});
  expect(failure(refused.result)).toMatchObject({ _tag: "OperationFailure", dispatch: "not_sent" });
  expect(refused.commits).toEqual([
    { name: "save-address", state: "sent" },
    { name: "place-order", state: "not_sent" },
  ]);
  await expect(page.locator("#placed")).toHaveText("0");
  const placed = await runExample(page, markedWrite("click"), {});
  expect(placed).toMatchObject({ result: Either.right({}), effect: "verified" });
  expect(placed.commits).toEqual([
    { name: "save-address", state: "confirmed" },
    { name: "place-order", state: "confirmed" },
  ]);
  await expect(page.locator("#placed")).toHaveText("1");
});

test("a commit mark the script never declared is still reported once entered", async ({ page }) => {
  const undeclared = defineOperation(
    {
      name: "confirm_booking",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      write: { confirmation: "message" },
    },
    async ({ enteringCommit }) => {
      enteringCommit("confirm-booking");
      return {};
    },
  );
  expect((await runExample(page, undeclared, {})).commits).toEqual([
    { name: "confirm-booking", state: "sent" },
  ]);
});

/**
 * A write as the writes skill has it: it types an address, reads back the version the site kept
 * on leaving the field, saves that version and reports the rewrite in `address_note`, worded by
 * the rewrite check alone.
 */
const saveAddress = defineOperation(
  {
    name: "save_address",
    input: Schema.Struct({ address: Schema.NonEmptyString }),
    output: Schema.Struct({ address: Schema.String, address_note: Schema.optional(Schema.String) }),
    write: { confirmation: "readback", commits: ["save-address"] },
  },
  async ({ kernel, sessionId, input, enteringCommit, verified, errors }) => {
    const typed = input.address;
    const read = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 10,
      code: `
        const field = page.getByLabel("Address", { exact: true });
        await field.fill(${JSON.stringify(typed)});
        await field.press("Tab");
        return await field.inputValue();
      `,
    });
    if (!read.success) throw new errors.OperationFailure(String(read.error), { dispatch: "not_sent" });
    const shown = String(read.result);
    const note =
      shown === typed
        ? undefined
        : sameText(shown, typed, { rewrite: true })
          ? `The site reformatted "${typed}" as "${shown}".`
          : `The site changed "${typed}" to "${shown}".`;
    enteringCommit("save-address");
    const saved = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 10,
      code: `
        await page.getByRole("button", { name: "Save address", exact: true }).click();
        const status = page.getByRole("status");
        await status.waitFor({ timeout: 5000 });
        return await status.textContent();
      `,
    });
    if (!saved.success) throw new errors.OperationFailure(String(saved.error), { stderr: saved.stderr });
    // The confirmation is compared against the site's version, not the caller's.
    if (!sameText(String(saved.result), `Saved ${shown}`))
      throw new errors.OperationFailure("not_saved", { dispatch: "sent" });
    verified();
    return note === undefined ? { address: shown } : { address: shown, address_note: note };
  },
);

test("a write keeps the site's rewrite of a typed value and notes whether it only reformatted or changed it", async ({
  page,
}) => {
  // The site standardizes an address when the field is left: one only reformatted, one changed.
  const rewrites = {
    "12 Elm Parkway, Suite 4": "12 ELM PKWY STE 4",
    "1420 Larkspur Road": "1420 LARK RD",
  };
  const save = async (address: string) => {
    await page.setContent(
      [
        "<label>Address<input name='address'></label>",
        "<button type='button'>Save address</button><p role='status' hidden></p>",
        // A block, so the next run's page declares its names again on the same window.
        "<script>{",
        `const rewrites = ${JSON.stringify(rewrites)};`,
        "window.saved = [];",
        "const field = document.querySelector('input');",
        "field.addEventListener('change', () => { field.value = rewrites[field.value] ?? field.value; });",
        "document.querySelector('button').onclick = () => {",
        " window.saved.push(field.value);",
        " const status = document.querySelector('[role=status]');",
        " status.textContent = 'Saved ' + field.value; status.hidden = false;",
        "};",
        "}</script>",
      ].join(""),
    );
    const run = await runExample(page, saveAddress, { address });
    const saved = await page.evaluate(() => (window as unknown as { saved: string[] }).saved);
    return { ...run, saved };
  };
  const reformatted = await save("12 Elm Parkway, Suite 4");
  const tidied = Either.getOrThrow(reformatted.result);
  expect(tidied.address).toBe("12 ELM PKWY STE 4");
  expect(tidied.address_note).toContain("reformatted");
  expect(reformatted.saved).toEqual(["12 ELM PKWY STE 4"]);
  expect(reformatted.commits).toEqual([{ name: "save-address", state: "confirmed" }]);
  // A rewrite that changed the caller's value is still saved, and the note names both values.
  const changed = await save("1420 Larkspur Road");
  const moved = Either.getOrThrow(changed.result);
  expect(moved.address).toBe("1420 LARK RD");
  expect(moved.address_note).not.toContain("reformatted");
  expect(moved.address_note).toContain("1420 Larkspur Road");
  expect(moved.address_note).toContain("1420 LARK RD");
  expect(changed.saved).toEqual(["1420 LARK RD"]);
  expect(changed.commits).toEqual([{ name: "save-address", state: "confirmed" }]);
  // A value the site kept as typed needs no note.
  const kept = await save("5 Birch Lane");
  expect(kept.result).toEqual(Either.right({ address: "5 Birch Lane" }));
  expect(kept.saved).toEqual(["5 Birch Lane"]);
});

/** A write that proves its effect, then optionally makes one more browser call. */
const provingWrite = (
  write: { readonly confirmation: "message" | "readback" | "unverifiable" },
  after: "return" | "another_call",
) =>
  defineOperation(
    { name: "proving_write", input: Schema.Struct({}), output: Schema.Struct({}), write },
    async ({ kernel, sessionId, verified }) => {
      verified(write.confirmation === "message" ? { confirmation: "message" } : undefined);
      if (after === "another_call")
        await kernel.browsers.playwright.execute(sessionId, { code: "return 1;", timeout_sec: 5 });
      return {};
    },
  );

test("verified records the write's proof, a later call reopens it, and unverifiable refuses it", async ({
  page,
}) => {
  expect(
    await runExample(page, provingWrite({ confirmation: "message" }, "return"), {}),
  ).toMatchObject({
    result: Either.right({}),
    effect: "verified",
    confirmation: "message",
  });
  expect(
    await runExample(page, provingWrite({ confirmation: "readback" }, "return"), {}),
  ).toMatchObject({
    effect: "verified",
    confirmation: "readback",
  });
  expect(
    await runExample(page, provingWrite({ confirmation: "readback" }, "another_call"), {}),
  ).toMatchObject({
    result: Either.right({}),
    effect: "may_have_dispatched",
    confirmation: undefined,
  });
  const refused = await runExample(
    page,
    provingWrite({ confirmation: "unverifiable" }, "return"),
    {},
  );
  expect(failure(refused.result)).toMatchObject({
    _tag: "WriteConfirmationRefused",
    recorded: "readback",
  });
  expect(refused.confirmation).toBeUndefined();
});

test("a call after verified turns a confirmed commit mark back to sent", async ({ page }) => {
  const reopened = defineOperation(
    {
      name: "place_order",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      write: { confirmation: "message", commits: ["place-order"] },
    },
    async ({ kernel, sessionId, enteringCommit, verified }) => {
      enteringCommit("place-order");
      verified({ confirmation: "message" });
      await kernel.browsers.playwright.execute(sessionId, { code: "return 1;", timeout_sec: 5 });
      return {};
    },
  );
  expect(await runExample(page, reopened, {})).toMatchObject({
    effect: "may_have_dispatched",
    confirmation: undefined,
    commits: [{ name: "place-order", state: "sent" }],
  });
});

const table = (id: string) =>
  `<table aria-label="Invoices"><tbody><tr data-invoice-id="${id}"><td>Old layout</td></tr></tbody></table>`;
const cards = (id: string) =>
  `<ul aria-label="Invoices"><li data-invoice-id="${id}">New layout</li></ul>`;
for (const fixture of [
  { name: "old layout", html: table("invoice_137"), ids: ["invoice_137"] },
  { name: "new layout", html: cards("invoice_982"), ids: ["invoice_982"] },
  {
    name: "ambiguous layouts",
    html: table("invoice_137") + cards("invoice_982"),
    reason: "ambiguous",
  },
  { name: "unsupported page", html: "<main>No invoices</main>", reason: "unsupported" },
  {
    name: "loading state",
    html: '<div role="progressbar"></div>' + cards("invoice_982"),
    reason: "loading",
  },
  {
    name: "identity mismatch",
    html: table("invoice_137") + table("invoice_463"),
    reason: "identity_mismatch",
  },
])
  test(`variant example chooses a layout from one observation: ${fixture.name}`, async ({
    page,
  }) => {
    await page.setContent(fixture.html);
    const { result } = await runExample(page, readInvoiceIds, {});
    if (fixture.ids) expect(result).toEqual(Either.right({ ids: fixture.ids }));
    else
      expect(failure(result)).toMatchObject({ _tag: "OperationFailure", message: fixture.reason });
  });

test("calendar example moves to the requested month and reads the committed date", async ({
  page,
}) => {
  await page.setContent(`
    <input aria-label="Travel date" readonly>
    <div role="dialog" aria-label="Choose date" hidden>
      <button>Previous month</button><button>Next month</button><div id="panel"></div>
    </div>
    <script>
      let month = 9;
      const render = () => {
        const id = "2026-" + String(month).padStart(2, "0");
        document.querySelector("#panel").innerHTML = '<section data-month="' + id + '">' +
          [1, 15].map((day) => '<button data-date="' + id + "-" + String(day).padStart(2, "0") + '">' + day + "</button>").join("") + "</section>";
      };
      render();
      document.querySelector("input").onclick = () => { document.querySelector("[role=dialog]").hidden = false; };
      document.querySelector("[role=dialog]").onclick = (event) => {
        const target = event.target;
        if (target.textContent === "Next month") { month++; render(); }
        else if (target.textContent === "Previous month") { month--; render(); }
        else if (target.dataset.date) document.querySelector("input").value = target.dataset.date;
      };
    </script>`);
  expect((await runExample(page, pickTravelDate, { date: "2026-11-15" })).result).toEqual(
    Either.right({ date: "2026-11-15" }),
  );
  expect(
    failure((await runExample(page, pickTravelDate, { date: "2026-11-03" })).result),
  ).toMatchObject({ _tag: "OperationFailure", message: "day_ambiguous" });
});

test("calendar example stops when a month step leaves the shown month unchanged", async ({
  page,
}) => {
  // The calendar offers nothing past its last month: its next-month button does nothing there.
  await page.setContent(`
    <input aria-label="Travel date" readonly>
    <div role="dialog" aria-label="Choose date">
      <button>Previous month</button><button>Next month</button>
      <section data-month="2026-12"><button data-date="2026-12-01">1</button></section>
    </div>`);
  expect(
    failure((await runExample(page, pickTravelDate, { date: "2027-01-01" })).result),
  ).toMatchObject({ _tag: "OperationFailure", message: "month_unavailable", dispatch: "not_sent" });
});

/** A synthetic documents site on its own origin, with a file input and a statement export. */
const documentsSite = async (page: Page) => {
  const origin = "https://documents.example.test";
  await page.route(`${origin}/**`, (route) =>
    new URL(route.request().url()).pathname === "/statement.csv"
      ? route.fulfill({
          contentType: "text/csv",
          headers: { "Content-Disposition": 'attachment; filename="statement.csv"' },
          body: "date,amount\n2026-01-02,12.50\n",
        })
      : route.fulfill({
          contentType: "text/html",
          body: '<label>Documents<input type="file" accept=".txt"></label><a href="/statement.csv">Download statement</a>',
        }),
  );
  await page.goto(`${origin}/`);
  const directory = await mkdtemp(join(tmpdir(), "opengpt-example-files-"));
  const scope = Effect.runSync(Scope.make());
  return {
    origin,
    directory,
    scope,
    close: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await rm(directory, { recursive: true, force: true });
    },
  };
};

test("upload example has the host place the caller's file and reads back the choice", async ({
  page,
}) => {
  const site = await documentsSite(page);
  try {
    const path = join(site.directory, "report.txt");
    await writeFile(path, "synthetic report");
    const reference = pathToFileURL(path).href;
    const files = await localFiles(page, {
      siteOrigin: site.origin,
      references: [reference],
      downloads: join(site.directory, "downloads"),
      scope: site.scope,
    });
    const input = { document: reference };
    const placed = await runExample(page, attachDocument, input, { files });
    expect(placed.result).toEqual(Either.right({ name: "report.txt", size: 16 }));
    // No call's code carries the file's bytes.
    expect(placed.calls.join("\n")).not.toContain("synthetic report");
    expect(failure((await runExample(page, attachDocument, input, { files })).result)).toMatchObject({
      _tag: "OperationFailure",
      message: "already_selected",
    });
  } finally {
    await site.close();
  }
});

test("download example returns the statement as a file object the host keeps", async ({ page }) => {
  const site = await documentsSite(page);
  try {
    const files = await localFiles(page, {
      siteOrigin: site.origin,
      references: [],
      downloads: join(site.directory, "downloads"),
      scope: site.scope,
    });
    const { result } = await runExample(page, downloadStatement, {}, { files });
    const statement = "date,amount\n2026-01-02,12.50\n";
    expect(Either.getOrUndefined(result), JSON.stringify(failure(result))).toMatchObject({
      statement: {
        $file: {
          name: "statement.csv",
          media_type: "text/csv",
          size: statement.length,
          sha256: createHash("sha256").update(statement).digest("hex"),
        },
      },
    });
  } finally {
    await site.close();
  }
});

test("a download's type comes from its bytes, else the server's type, never its name", async ({
  page,
}) => {
  test.info().annotations.push({ type: "slow", description: "Two downloads Chromium must save" });
  const site = await documentsSite(page);
  // Each export names itself one type and is another.
  const exports = [
    {
      filename: "statement.csv",
      contentType: "text/csv",
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]),
    },
    { filename: "statement.pdf", contentType: "text/csv; charset=utf-8", body: Buffer.from("a,b\n") },
  ];
  await page.route(`${site.origin}/statement.csv`, (route) => {
    const next = exports.shift();
    return next === undefined
      ? route.abort()
      : route.fulfill({
          contentType: next.contentType,
          headers: { "Content-Disposition": `attachment; filename="${next.filename}"` },
          body: next.body,
        });
  });
  try {
    const files = await localFiles(page, {
      siteOrigin: site.origin,
      references: [],
      downloads: join(site.directory, "downloads"),
      scope: site.scope,
    });
    const typeOf = async () => {
      const { result } = await runExample(page, downloadStatement, {}, { files });
      return (Either.getOrUndefined(result) as { statement: { $file: Record<string, unknown> } })
        .statement.$file;
    };
    expect(await typeOf()).toMatchObject({ name: "statement.csv", media_type: "image/png" });
    expect(await typeOf()).toMatchObject({ name: "statement.pdf", media_type: "text/csv" });
  } finally {
    await site.close();
  }
});

test("dialog example keeps the confirm open for the host and applies accept in the next call", async ({
  page,
}) => {
  await page.setContent(`<table><tr><td>INV-7</td><td>
        <button onclick="if (confirm('Delete invoice INV-7?')) this.closest('tr').remove()">Delete</button>
      </td></tr></table>`);
  const asked: unknown[] = [];
  const { result, calls } = await runExample(
    page,
    deleteInvoice,
    { invoice_id: "INV-7" },
    {
      dialogs: ({ interactionId: _id, ...report }) =>
        Effect.sync(() => {
          asked.push(report);
          return { choice: "accept" as const };
        }),
    },
  );
  expect(result).toEqual(Either.right({ deleted: true }));
  expect(asked).toEqual([
    {
      step: "delete-invoice",
      type: "confirm",
      message: "Delete invoice INV-7?",
      url: "about:blank",
    },
  ]);
  expect(calls).toHaveLength(2);
  await expect(page.getByRole("row")).toHaveCount(0);
});
