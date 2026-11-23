import { expect, test, type Page } from "@playwright/test";
import { Either, Schema } from "effect";
import listRecords from "../../authoring/examples/pager.js";
import {
  defineOperation,
  listInputFields,
  listOutputFields,
  pagedListReader,
  readList,
  startList,
  type PagerMechanism,
} from "../../src/browser/index.js";
import {
  admitListCursor,
  randomListCursorKeys,
  sealListOutput,
  type ListCursorScope,
} from "../../src/runtime/list-cursor.js";
import type { KernelOperation } from "../../src/runtime/kernel-operation.js";
import { runExample } from "./authoring-fixture.js";
import {
  fastBudgets,
  openTable,
  origin,
  records,
  runPager,
  serve,
  tableApp,
  tableSpec,
  type TableApp,
} from "./pagination-fixture.js";

let tableAppHtml: string | undefined;

// The pager walks synthetic lists in the markup of common table, grid and admin libraries, and
// lists that misbehave on purpose. Each test asserts what a caller sees: the rows, each once and
// in order, whether more follow, and the total. Chromium renders every fixture, since visibility,
// re-renders and the page's requests are what the pager judges.

const collect = (page: Page, spec: string, options = "") =>
  runPager(page, `const pager = listPager({ ${spec} });\nreturn await pager.collect({ ${options} });`);

const table = async (page: Page, options: TableApp, collectOptions = "", extra = "") => {
  await openTable(page, options);
  return collect(page, tableSpec(extra), collectOptions);
};

test.describe("numbered pages that re-render in place", () => {
  test("a DataTables-style table with jittery loads is collected whole, each row once", async ({ page }) => {
    const result = await table(page, { style: "datatables", total: 57, pageSize: 10, delays: [40, 160, 20, 90] });
    expect(result).toMatchObject({
      rows: records(57),
      hasMore: false,
      stoppedBy: "end",
      steps: 5,
      listChanged: false,
      duplicates: 0,
      totalResults: 57,
      mechanism: "pages",
    });
    await expect(page.locator("#loads")).toHaveText("5");
  });

  test("an icon-button pager with a range summary reads its exact total", async ({ page }) => {
    const result = await table(page, { style: "mui", total: 23, pageSize: 10, delays: [150, 40] });
    expect(result).toMatchObject({ rows: records(23), hasMore: false, totalResults: 23, steps: 2 });
  });

  test("a grid that draws each row twice and shows 'Page 1 of 3' counts every row once", async ({ page }) => {
    const result = await table(page, { style: "grid", total: 45, pageSize: 20 });
    expect(result).toMatchObject({ rows: records(45), duplicates: 0, totalResults: 45, page: 3 });
  });

  test("a pager whose 'Next 5 Pages' jump sits beside Next steps one page at a time", async ({ page }) => {
    const result = await table(page, { style: "antd", total: 85, pageSize: 10 }, "limit: 25");
    expect(result).toMatchObject({
      rows: records(25),
      hasMore: true,
      stoppedBy: "limit",
      steps: 2,
      totalResults: 85,
    });
  });

  test("duplicate pagers above and below the table step once per page", async ({ page }) => {
    // Two matching Next controls must make one click, never an ambiguous one.
    const result = await table(page, { style: "bootstrap-js", total: 32, pageSize: 10, duplicatePagers: true });
    expect(result).toMatchObject({ rows: records(32), hasMore: false, steps: 3 });
    await expect(page.locator("#loads")).toHaveText("3");
  });

  test("rows that first re-render with the same content are not taken for the next page", async ({ page }) => {
    const result = await table(page, {
      style: "plain",
      total: 25,
      pageSize: 10,
      delays: [250],
      identicalReload: true,
    });
    expect(result).toMatchObject({ rows: records(25), duplicates: 0, stoppedBy: "end" });
  });

  test("rows that stream in one at a time after a jittery load are read whole", async ({ page }) => {
    const result = await table(page, {
      style: "datatables",
      total: 37,
      pageSize: 10,
      delays: [30, 220, 70],
      streamMs: 25,
    });
    expect(result).toMatchObject({ rows: records(37), duplicates: 0, totalResults: 37 });
  });

  test("a Next that stays disabled a moment after its rows show does not end the list", async ({ page }) => {
    const result = await table(page, { style: "mui", total: 30, pageSize: 10, nextLagMs: 220 });
    expect(result).toMatchObject({ rows: records(30), stoppedBy: "end", steps: 2 });
  });

  test("a Next mid-list that does nothing while the page shows more stops with more to come", async ({ page }) => {
    const result = await table(page, { style: "datatables", total: 40, pageSize: 10, deadNextOnPage: 2 });
    expect(result).toMatchObject({ rows: records(20), stoppedBy: "stalled", hasMore: true });
  });

  test("a last page whose Next stays enabled and does nothing ends without more", async ({ page }) => {
    const result = await table(page, { style: "datatables", total: 25, pageSize: 10, deadLastNext: true });
    expect(result).toMatchObject({ rows: records(25), hasMore: false, stoppedBy: "stalled", totalResults: 25 });
  });

  test("a windowed pager reaches a far page through the numbers it shows", async ({ page }) => {
    await openTable(page, { style: "datatables", total: 120, pageSize: 10, windowed: true });
    const segment = await runPager(
      page,
      `const pager = listPager({ ${tableSpec()} });\nreturn await pager.goToPage(7, 10);`,
    );
    expect(segment).toMatchObject({ rows: records(10, 61), page: 7, hasNext: true, totalResults: 120 });
  });
});

test.describe("pages that load in other ways", () => {
  test("rows replaced by placeholder rows while a page loads are waited past", async ({ page }) => {
    const result = await table(page, { style: "mui", total: 28, pageSize: 10, delays: [180], skeleton: true });
    expect(result).toMatchObject({ rows: records(28), duplicates: 0, totalResults: 28 });
  });

  test("rows removed while a page loads, with only page numbers and an arrow to step by", async ({ page }) => {
    const result = await table(page, { style: "bootstrap-js", total: 40, pageSize: 10, delays: [200], clearRows: true, arrowsOnly: true });
    expect(result).toMatchObject({ rows: records(40), stoppedBy: "end", hasMore: false, totalResults: 40 });
  });

  test("a table inside a frame is stepped through the frame's own controls", async ({ page }) => {
    await serve(page, (url) =>
      url.pathname === "/frame"
        ? (tableAppHtml ?? "")
        : `<h1>Reports</h1><iframe id="f" src="/frame" style="width: 900px; height: 700px"></iframe>`,
    );
    tableAppHtml = tableApp({ style: "datatables", total: 24, pageSize: 10, delays: [50] });
    await page.goto(`${origin}/`);
    await expect(page.frameLocator("#f").locator("#rows > tr").first()).toBeVisible();
    const result = await collect(
      page,
      `rows: page.frameLocator("#f").locator("#rows > tr"), key: { attribute: "data-id" }, fields: { name: ".name" }, ${fastBudgets}`,
    );
    expect(result).toMatchObject({ rows: records(24), steps: 2, totalResults: 24 });
  });

  test("a server that takes a while to answer each page is followed through full navigations", async ({ page }) => {
    const all = records(26);
    await serve(page, (url) => {
      const n = Number(url.searchParams.get("page") ?? "1");
      const nav = `<nav aria-label="pagination"><ul class="pagination">${n > 1 ? `<li class="page-item"><a class="page-link" href="/slow?page=${n - 1}">Previous</a></li>` : ""}${n * 10 < all.length ? `<li class="page-item"><a class="page-link" href="/slow?page=${n + 1}">Next</a></li>` : `<li class="page-item disabled"><span class="page-link">Next</span></li>`}</ul></nav>`;
      return { body: `${rowsHtml(all.slice((n - 1) * 10, n * 10))}${nav}`, delayMs: n === 1 ? 0 : 400 };
    });
    await page.goto(`${origin}/slow`);
    expect(await collect(page, serverSpec())).toMatchObject({ rows: all, steps: 2, hasMore: false });
    expect(page.url()).toBe(`${origin}/slow?page=3`);
  });
});

test.describe("totals", () => {
  test("an off-by-one site total gives way to the rows the walk counted", async ({ page }) => {
    const result = await table(page, { style: "datatables", total: 30, pageSize: 10, totalOffset: 1 });
    expect(result).toMatchObject({ rows: records(30), totalResults: 30, siteTotal: 31, totalMismatch: true });
  });

  test("a last page that contradicts the site's total reports no total", async ({ page }) => {
    await openTable(page, { style: "datatables", total: 30, pageSize: 10, totalOffset: 1 });
    const first = await runPager(page, `const pager = listPager({ ${tableSpec()} });\nreturn await pager.read(10);`);
    // Page one cannot tell; the last page can.
    expect(first).toMatchObject({ totalResults: 31 });
    const last = await runPager(page, `const pager = listPager({ ${tableSpec()} });\nreturn await pager.goToPage(3, 10);`);
    expect(last).toMatchObject({ rows: records(10, 21), hasNext: false, totalResults: null });
  });

  test("an approximate total is no total until the walk counted the whole list", async ({ page }) => {
    await openTable(page, { style: "mui", total: 18, pageSize: 10, approximate: true });
    const first = await runPager(page, `const pager = listPager({ ${tableSpec()} });\nreturn await pager.read(10);`);
    expect(first).toMatchObject({ rows: records(10), hasNext: true, totalResults: null });
    const result = await collect(page, tableSpec());
    expect(result).toMatchObject({ rows: records(18), totalResults: 18 });
  });
});

test.describe("lists that change while they are read", () => {
  test("a row added above the first page shifts the next page without a row counted twice", async ({ page }) => {
    const result = await table(page, { style: "datatables", total: 25, pageSize: 10, insertAfterFirstStep: true });
    expect(result).toMatchObject({ rows: records(25), duplicates: 1, listChanged: true, stoppedBy: "end" });
  });

  test("a step that goes back to page one stops the walk instead of counting rows again", async ({ page }) => {
    const result = await table(page, { style: "datatables", total: 50, pageSize: 10, resetFromPage: 3 });
    expect(result).toMatchObject({ rows: records(30), hasMore: true, stoppedBy: "repeated", listChanged: true });
  });

  test("a filter that sends the table back to page one is read from page one", async ({ page }) => {
    await openTable(page, { style: "datatables", total: 60, pageSize: 10 });
    const result = await runPager(
      page,
      `const pager = listPager({ ${tableSpec()} });
       const third = await pager.goToPage(3, 10);
       await page.locator("#filter").fill("Record 1");
       // The site answers the filter by itself: wait for its first page, then walk it.
       await waitForChange({ first: page.locator("#rows > tr").first() }, { before: { first: "Record 21" }, ${fastBudgets} });
       const filtered = await pager.collect();
       return { third: third.page, filtered };`,
    );
    expect(result).toMatchObject({
      third: 3,
      filtered: { rows: [records(1)[0], ...records(10, 10)], page: 2, duplicates: 0, totalResults: 11 },
    });
  });

  test("a page-size select picks the largest size it offers up to the one asked", async ({ page }) => {
    await openTable(page, { style: "datatables", total: 120, pageSize: 10, pageSizes: [10, 25, 50, 100] });
    const result = await runPager(
      page,
      `const pager = listPager({ ${tableSpec()} });
       const size = await pager.setPageSize(60);
       return { size, collected: await pager.collect() };`,
    );
    expect(result).toMatchObject({ size: 50, collected: { rows: records(120), steps: 2, totalResults: 120 } });
  });
});

test.describe("finding and stopping", () => {
  test("find stops on the page that holds the wanted record", async ({ page }) => {
    await openTable(page, { style: "datatables", total: 57, pageSize: 10 });
    const result = await runPager(
      page,
      `const pager = listPager({ ${tableSpec()} });\nreturn await pager.find((row) => row.name === "Record 34");`,
    );
    expect(result).toMatchObject({
      row: { key: "R034", name: "Record 34" },
      found: { page: 4, steps: 3 },
      stoppedBy: "found",
      hasMore: true,
    });
  });

  test("find reports a record the list does not hold after reading it all", async ({ page }) => {
    await openTable(page, { style: "datatables", total: 23, pageSize: 10 });
    const result = await runPager(
      page,
      `const pager = listPager({ ${tableSpec()} });\nreturn await pager.find((row) => row.key === "R999");`,
    );
    expect(result).toMatchObject({ row: null, stoppedBy: "end", hasMore: false, steps: 2 });
  });

  test("a walk resumes after a known row and stops at the row it was told to", async ({ page }) => {
    const result = await table(
      page,
      { style: "datatables", total: 40, pageSize: 10 },
      `after: "R012", until: (row) => row.key === "R027"`,
    );
    expect(result).toMatchObject({ rows: records(14, 13), stoppedBy: "until", hasMore: true });
  });

  test("a walk that resumes after a row past the first rows of a long page reads the rest of it", async ({ page }) => {
    const result = await table(page, { style: "datatables", total: 50, pageSize: 25 }, `after: "R015", limit: 5`);
    expect(result).toMatchObject({ rows: records(5, 16), stoppedBy: "limit", hasMore: true });
  });

  test("a walk stops at its step bound and says more follow", async ({ page }) => {
    const result = await table(page, { style: "datatables", total: 57, pageSize: 10 }, "maxSteps: 2");
    expect(result).toMatchObject({ rows: records(30), stoppedBy: "max_steps", hasMore: true, steps: 2 });
  });

  test("an empty result is the site's own empty message, never a failure", async ({ page }) => {
    await openTable(page, { style: "datatables", total: 20, pageSize: 10 });
    await page.locator("#filter").fill("nothing like this");
    await expect(page.locator("#rows .empty")).toBeVisible();
    const result = await runPager(
      page,
      `const pager = listPager({ ${tableSpec()} });\nreturn { segment: await pager.read(10), collected: await pager.collect() };`,
    );
    expect(result).toMatchObject({
      segment: { rows: [], hasNext: false, empty: true, totalResults: 0 },
      collected: { rows: [], hasMore: false, stoppedBy: "end", totalResults: 0 },
    });
  });
});

/** A server-rendered page per URL, built by `render` from the URL's own parameters. */
const serverList = (
  page: Page,
  render: (url: URL) => string,
) => serve(page, (url) => `<!doctype html><html><head>${headOf(url)}</head><body>${render(url)}</body></html>`);
let headOf: (url: URL) => string = () => "";

const rowsHtml = (rows: readonly { readonly key: string; readonly name: string }[]) =>
  `<table id="list"><tbody id="rows">${rows.map((row) => `<tr data-id="${row.key}"><td class="name">${row.name}</td></tr>`).join("")}</tbody></table>`;
const serverSpec = (extra = "") =>
  `rows: page.locator("#rows > tr"), key: { attribute: "data-id" }, fields: { name: ".name" }, ${fastBudgets}${extra === "" ? "" : `, ${extra}`}`;

test.describe("pages the server renders, one URL per page", () => {
  test.afterEach(() => {
    headOf = () => "";
  });

  test("an admin table with duplicate top and bottom Next links and a page input", async ({ page }) => {
    const all = records(57);
    const size = 12;
    await serverList(page, (url) => {
      const paged = Number(url.searchParams.get("paged") ?? "1");
      const last = Math.ceil(all.length / size);
      const nav = `<div class="tablenav"><div class="tablenav-pages"><span class="displaying-num">${all.length} items</span>
        <span class="pagination-links">
        ${paged > 1 ? `<a class="prev-page button" href="/items?paged=${paged - 1}"><span class="screen-reader-text">Previous page</span><span aria-hidden="true">‹</span></a>` : `<span class="tablenav-pages-navspan button disabled" aria-hidden="true">‹</span>`}
        <span class="paging-input"><input class="current-page" type="text" value="${paged}" size="1"> of <span class="total-pages">${last}</span></span>
        ${paged < last ? `<a class="next-page button" href="/items?paged=${paged + 1}"><span class="screen-reader-text">Next page</span><span aria-hidden="true">›</span></a>` : `<span class="tablenav-pages-navspan button disabled" aria-hidden="true">›</span>`}
        </span></div></div>`;
      return `${nav}${rowsHtml(all.slice((paged - 1) * size, paged * size))}${nav}`;
    });
    await page.goto(`${origin}/items`);
    const result = await collect(page, serverSpec());
    expect(result).toMatchObject({ rows: all, hasMore: false, steps: 4, totalResults: 57, mechanism: "next_link" });
    expect(page.url()).toBe(`${origin}/items?paged=5`);
  });

  test("a feed paged by opaque cursor tokens in its Older and Newer links", async ({ page }) => {
    const all = records(23);
    const token = (index: number) => Buffer.from(`after:${index}`).toString("base64url");
    await serverList(page, (url) => {
      const after = url.searchParams.get("after");
      const start = after === null ? 0 : Number(Buffer.from(after, "base64url").toString().split(":")[1]);
      const rows = all.slice(start, start + 7);
      const end = start + rows.length;
      return `${rowsHtml(rows)}<div class="paginate-container"><div class="pagination">
        ${start > 0 ? `<a href="/feed?before=${token(start)}">Newer</a>` : `<span class="disabled">Newer</span>`}
        ${end < all.length ? `<a href="/feed?after=${token(end)}">Older</a>` : `<span class="disabled">Older</span>`}
        </div></div>`;
    });
    await page.goto(`${origin}/feed`);
    const result = await runPager(
      page,
      `const pager = listPager({ ${serverSpec()} });
       const first = await pager.next(7);
       return { first: { href: first.href, rows: first.rows.length }, detected: await pager.detect(), rest: await pager.collect() };`,
    );
    expect(result).toMatchObject({
      first: { href: `${origin}/feed?after=${token(7)}`, rows: 7 },
      detected: { mechanism: "next_link", urlCursor: { name: "after", value: token(7) } },
      rest: { rows: records(16, 8), hasMore: false },
    });
  });

  test("the URL's page number is read from the page parameters the pager knows, never from pg", async ({ page }) => {
    await serverList(page, () => rowsHtml(records(5)));
    const urlPageOf = async (query: string) => {
      await page.goto(`${origin}/items?${query}`);
      return (await runPager(page, `const pager = listPager({ ${serverSpec()} });\nreturn await pager.detect();`))["urlPage"];
    };
    for (const name of ["page", "p", "paged", "pagenum", "page_number", "pageNumber", "pageNo", "currentPage"])
      expect(await urlPageOf(`${name}=3`), name).toEqual({ name, value: "3" });
    expect(await urlPageOf("pg=3")).toBeNull();
  });

  test("a page whose only way on is the document's rel=next link", async ({ page }) => {
    const all = records(19);
    headOf = (url) => {
      const n = Number(url.searchParams.get("page") ?? "1");
      return n * 8 < all.length ? `<link rel="next" href="/catalog?page=${n + 1}">` : "";
    };
    await serverList(page, (url) => {
      const n = Number(url.searchParams.get("page") ?? "1");
      return rowsHtml(all.slice((n - 1) * 8, n * 8));
    });
    await page.goto(`${origin}/catalog`);
    expect(await collect(page, serverSpec())).toMatchObject({ rows: all, hasMore: false, steps: 2 });
  });

  test("a pager whose range summary is split across inline elements, with rel=next links", async ({ page }) => {
    const all = records(40);
    await serverList(page, (url) => {
      const n = Number(url.searchParams.get("page") ?? "1");
      const from = (n - 1) * 15 + 1;
      const to = Math.min(n * 15, all.length);
      return `${rowsHtml(all.slice(from - 1, to))}
        <nav role="navigation" aria-label="Pagination Navigation">
          <p class="text-sm">Showing <span class="font-medium">${from}</span> to <span class="font-medium">${to}</span> of <span class="font-medium">${all.length}</span> results</p>
          ${n > 1 ? `<a href="/orders?page=${n - 1}" rel="prev" aria-label="&laquo; Previous">&lsaquo;</a>` : `<span aria-disabled="true" aria-label="&laquo; Previous"><span aria-hidden="true">&lsaquo;</span></span>`}
          ${[1, 2, 3].map((p) => (p === n ? `<span aria-current="page"><span>${p}</span></span>` : `<a href="/orders?page=${p}" aria-label="Go to page ${p}">${p}</a>`)).join("")}
          ${to < all.length ? `<a href="/orders?page=${n + 1}" rel="next" aria-label="Next &raquo;">&rsaquo;</a>` : `<span aria-disabled="true" aria-label="Next &raquo;"><span aria-hidden="true">&rsaquo;</span></span>`}
        </nav>`;
    });
    await page.goto(`${origin}/orders`);
    expect(await collect(page, serverSpec())).toMatchObject({ rows: all, totalResults: 40, steps: 2, mechanism: "pages" });
  });

  test("arrows without labels step with the single arrow, never the double one that jumps to the end", async ({
    page,
  }) => {
    const all = records(36);
    await serverList(page, (url) => {
      const n = Number(url.searchParams.get("p") ?? "1");
      const link = (to: number, text: string) => `<a href="/list?p=${to}">${text}</a>`;
      return `${rowsHtml(all.slice((n - 1) * 9, n * 9))}<div class="pages">
        ${link(1, "«")} ${link(Math.max(1, n - 1), "‹")}
        ${[1, 2, 3, 4].map((p) => (p === n ? `<b>${p}</b>` : link(p, String(p)))).join(" ")}
        ${n < 4 ? link(n + 1, "›") : ""} ${link(4, "»")}
      </div>`;
    });
    await page.goto(`${origin}/list`);
    expect(await collect(page, serverSpec())).toMatchObject({ rows: all, steps: 3, duplicates: 0 });
  });

  test("duplicate Next links that lead to different pages fail as ambiguous rather than guess", async ({
    page,
  }) => {
    await serverList(page, (url) => {
      const n = Number(url.searchParams.get("page") ?? "1");
      return `<ul class="pagination"><li><a href="/odd?page=${n + 1}">Next</a></li></ul>
        ${rowsHtml(records(5, (n - 1) * 5 + 1))}
        <ul class="pagination"><li><a href="/odd?page=${n + 2}">Next</a></li></ul>`;
    });
    await page.goto(`${origin}/odd`);
    expect(await collect(page, serverSpec())).toMatchObject({ failure: "pager_ambiguous" });
  });
});

test.describe("one page among other controls", () => {
  test("two lists on one page each step with their own pager", async ({ page }) => {
    await page.setContent(`
      ${["a", "b"].map((list) => `<section id="${list}"><h2>List ${list}</h2>
        <ol class="rows"></ol><nav aria-label="pagination"><button class="prev">Previous</button><button class="next">Next</button></nav></section>`).join("")}
      <script>
        for (const list of ["a", "b"]) {
          let n = 1;
          const section = document.getElementById(list);
          const render = () => {
            section.querySelector(".rows").innerHTML = [1, 2, 3].map((i) => '<li data-id="' + list + ((n - 1) * 3 + i) + '"><span class="name">' + list.toUpperCase() + " " + ((n - 1) * 3 + i) + "</span></li>").join("");
            section.querySelector(".next").disabled = n === 3;
            section.querySelector(".prev").disabled = n === 1;
          };
          section.querySelector(".next").onclick = () => { n += 1; render(); };
          section.querySelector(".prev").onclick = () => { n -= 1; render(); };
          render();
        }
      </script>`);
    const result = await collect(
      page,
      `rows: page.locator("#b .rows > li"), key: { attribute: "data-id" }, fields: { name: ".name" }, ${fastBudgets}`,
    );
    expect(result).toMatchObject({ rows: Array.from({ length: 9 }, (_, i) => ({ key: `b${i + 1}`, name: `B ${i + 1}` })), steps: 2 });
    await expect(page.locator("#a .rows > li").first()).toHaveAttribute("data-id", "a1");
  });

  test("a list on one page is read whole, and a carousel's Next is left alone", async ({ page }) => {
    await page.setContent(`
      <div class="carousel"><button aria-label="Next">›</button><p id="slide">Slide 1</p></div>
      ${rowsHtml(records(8))}
      <script>document.querySelector(".carousel button").onclick = () => { document.querySelector("#slide").textContent = "Slide 2"; };</script>`);
    const result = await runPager(
      page,
      `const pager = listPager({ ${serverSpec()} });\nreturn { detected: await pager.detect(), collected: await pager.collect() };`,
    );
    expect(result).toMatchObject({
      detected: { mechanism: "offset", next: { present: false } },
      collected: { rows: records(8), steps: 0, stoppedBy: "end", hasMore: false },
    });
    await expect(page.locator("#slide")).toHaveText("Slide 1");
  });
});

/** A "Load more" list: each click fetches the next batch through the site's own request. */
const loadMoreList = (
  page: Page,
  options: { readonly total: number; readonly batch: number; readonly label?: string; readonly ending: "removed" | "message" | "stuck" },
) =>
  serve(
    page,
    () => `<ul id="rows"></ul><p id="status"></p><button id="more">${options.label ?? "Load more"}</button><output id="clicks">0</output>
    <script>
      const total = ${options.total}, batch = ${options.batch}, ending = ${JSON.stringify(options.ending)};
      let shown = 0;
      const list = document.querySelector("#rows");
      const button = document.querySelector("#more");
      const add = () => {
        const until = ending === "stuck" && shown >= batch ? shown : Math.min(total, shown + batch);
        for (; shown < until; shown += 1)
          list.insertAdjacentHTML("beforeend", '<li data-id="R' + String(shown + 1).padStart(3, "0") + '"><span class="name">Record ' + (shown + 1) + "</span></li>");
        if (shown >= total) {
          if (ending === "removed") button.remove();
          if (ending === "message") { button.remove(); document.querySelector("#status").textContent = "No more results"; }
        }
      };
      button.onclick = async () => {
        document.querySelector("#clicks").textContent++;
        button.disabled = true;
        button.textContent = "Loading…";
        await fetch("/api/wait?ms=" + (60 + (shown % 3) * 50));
        add();
        button.disabled = false;
        button.textContent = ${JSON.stringify(options.label ?? "Load more")};
      };
      add();
    </script>`,
  ).then(() => page.goto(`${origin}/`));
const listSpec = (extra = "") =>
  `rows: page.locator("#rows > li"), key: { attribute: "data-id" }, fields: { name: ".name" }, ${fastBudgets}${extra === "" ? "" : `, ${extra}`}`;

test.describe("lists that grow", () => {
  test("a 'Load more' list that disables its button while it loads is read to its end", async ({ page }) => {
    await loadMoreList(page, { total: 30, batch: 8, ending: "removed" });
    expect(await collect(page, listSpec())).toMatchObject({
      rows: records(30),
      stoppedBy: "end",
      hasMore: false,
      steps: 3,
      mechanism: "append",
    });
    await expect(page.locator("#clicks")).toHaveText("3");
  });

  test("a 'Show 10 more' button replaced by an end message", async ({ page }) => {
    await loadMoreList(page, { total: 25, batch: 10, label: "Show 10 more", ending: "message" });
    expect(await collect(page, listSpec(`end: page.getByText("No more results")`))).toMatchObject({
      rows: records(25),
      hasMore: false,
      steps: 2,
    });
  });

  test("a 'Load more' that adds nothing while it stays offered stops with more still to come", async ({ page }) => {
    await loadMoreList(page, { total: 30, batch: 8, ending: "stuck" });
    expect(await collect(page, listSpec())).toMatchObject({ rows: records(8), stoppedBy: "stalled", hasMore: true });
  });

  test("a facet's 'Show more' beside the list is left alone for the list's own 'Load more'", async ({ page }) => {
    await loadMoreList(page, { total: 20, batch: 8, ending: "removed" });
    await page.evaluate(() => {
      document.body.insertAdjacentHTML(
        "afterbegin",
        '<aside><h3>Brand</h3><ul id="facets"><li>Alpha</li><li>Beta</li></ul><button id="facet-more">Show more</button></aside>',
      );
      document.querySelector("#facet-more")?.addEventListener("click", () => document.querySelector("#facets")?.insertAdjacentHTML("beforeend", "<li>Gamma</li>"));
    });
    expect(await collect(page, listSpec())).toMatchObject({ rows: records(20), stoppedBy: "end", mechanism: "append" });
    await expect(page.locator("#facets > li")).toHaveCount(2);
  });

  test("a growing list stopped by find or a limit says rows remain", async ({ page }) => {
    await loadMoreList(page, { total: 15, batch: 5, ending: "removed" });
    const result = await runPager(
      page,
      `const pager = listPager({ ${listSpec()} });
       const found = await pager.find((row) => row.key === "R014");
       return { found: { row: found.row, hasMore: found.hasMore }, limited: await listPager({ ${listSpec()} }).collect({ limit: 13 }) };`,
    );
    expect(result).toMatchObject({
      found: { row: { key: "R014" }, hasMore: true },
      limited: { rows: records(13), hasMore: true, stoppedBy: "limit" },
    });
  });

  test("a collect stops at its limit without another click", async ({ page }) => {
    await loadMoreList(page, { total: 30, batch: 8, ending: "removed" });
    expect(await collect(page, listSpec(), "limit: 5")).toMatchObject({ rows: records(5), hasMore: true, steps: 0 });
    await expect(page.locator("#clicks")).toHaveText("0");
  });

  test("an infinite scroll in its own scrolling panel loads until the panel adds no rows", async ({ page }) => {
    await serve(
      page,
      () => `<div id="panel" style="height: 200px; overflow-y: auto"><ul id="rows"></ul><div id="sentinel" style="height: 1px"></div></div>
      <script>
        let shown = 0;
        const add = async () => {
          if (shown >= 35) return;
          await fetch("/api/wait?ms=80");
          const until = Math.min(35, shown + 10);
          for (; shown < until; shown += 1)
            document.querySelector("#rows").insertAdjacentHTML("beforeend", '<li data-id="R' + String(shown + 1).padStart(3, "0") + '" style="height: 30px"><span class="name">Record ' + (shown + 1) + "</span></li>");
        };
        new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) add(); }, { root: document.querySelector("#panel") })
          .observe(document.querySelector("#sentinel"));
      </script>`,
    );
    await page.goto(`${origin}/`);
    expect(await collect(page, listSpec(`mechanism: "scroll"`))).toMatchObject({
      rows: records(35),
      stoppedBy: "end",
      hasMore: false,
      mechanism: "scroll",
    });
  });

  test("a virtual list that drops its first rows as it scrolls is collected once, in order", async ({ page }) => {
    await serve(
      page,
      () => `<div id="panel" style="height: 150px; overflow-y: auto"><ul id="rows"></ul></div>
      <script>
        let shown = 0;
        const panel = document.querySelector("#panel");
        const list = document.querySelector("#rows");
        const add = () => {
          const until = Math.min(40, shown + 8);
          for (; shown < until; shown += 1)
            list.insertAdjacentHTML("beforeend", '<li data-id="R' + String(shown + 1).padStart(3, "0") + '" style="height: 30px"><span class="name">Record ' + (shown + 1) + "</span></li>");
          // Keep at most 12 rows in the document, as a windowed list does.
          while (list.children.length > 12) list.firstElementChild.remove();
        };
        let busy = false;
        panel.addEventListener("scroll", async () => {
          if (busy || panel.scrollTop + panel.clientHeight < panel.scrollHeight - 5 || shown >= 40) return;
          busy = true;
          await fetch("/api/wait?ms=50");
          add();
          busy = false;
        });
        add();
      </script>`,
    );
    await page.goto(`${origin}/`);
    expect(await collect(page, listSpec(`mechanism: "scroll"`))).toMatchObject({ rows: records(40), duplicates: 0 });
  });
});

test.describe("detecting how a list pages", () => {
  for (const [name, options, mechanism] of [
    ["numbered pages", { style: "datatables", total: 30, pageSize: 10 }, "pages"],
    ["Previous and Next only", { style: "mui", total: 30, pageSize: 10 }, "next_link"],
    ["a single page", { style: "plain", total: 8, pageSize: 10 }, "next_link"],
  ] as const)
    test(`detect names ${name} without acting`, async ({ page }) => {
      await openTable(page, options);
      const detected = await runPager(page, `const pager = listPager({ ${tableSpec()} });\nreturn await pager.detect();`);
      expect(detected).toMatchObject({ mechanism });
      await expect(page.locator("#loads")).toHaveText("0");
    });

  test("detect names a 'Load more' list as append", async ({ page }) => {
    await loadMoreList(page, { total: 30, batch: 8, ending: "removed" });
    expect(await runPager(page, `const pager = listPager({ ${listSpec()} });\nreturn await pager.detect();`)).toMatchObject({
      mechanism: "append",
      loadMore: { present: true, enabled: true },
    });
  });
});

/** A list tool on `pagedListReader`, as a script writes one, with the fixtures' budgets. */
const readerTool = (mechanism: PagerMechanism, rows: string, start: string) =>
  defineOperation(
    {
      name: "list_rows",
      input: Schema.Struct({ ...listInputFields }),
      output: Schema.Struct({
        rows: Schema.Array(Schema.Struct({ key: Schema.String, name: Schema.String })),
        ...listOutputFields,
      }),
    },
    async ({ kernel, sessionId, input, remainingMs, errors }) => {
      const list = startList(input, { mechanism });
      const read = await readList(
        list,
        pagedListReader({
          mechanism,
          execute: async (code) => {
            const answer = await kernel.browsers.playwright.execute(sessionId, { timeout_sec: 30, code });
            if (!answer.success) throw new errors.OperationFailure(String(answer.error));
            return answer.result;
          },
          setup: `const pager = listPager({ ${rows}, key: { attribute: "data-id" }, fields: { name: ".name" }, ${fastBudgets} });`,
          start,
          row: (row) => ({ key: row.key, name: row.name ?? "" }),
          keyOf: (row) => row.key,
          remainingMs,
        }),
      );
      return { rows: read.rows, ...read.output };
    },
  );

/**
 * Page one, then page two with the cursor page one returned, sealed and checked as a host does.
 * `reopen` gives page two a fresh page, as a new run gets.
 */
const twoCalls = async <Input, EncodedInput, Output, EncodedOutput>(
  page: Page,
  tool: KernelOperation<Input, EncodedInput, Output, EncodedOutput>,
  name: string,
  limit: number,
) => {
  const scope: ListCursorScope = { keys: randomListCursorKeys(), operation: name, siteOrigin: origin, now: Date.now() };
  const first = Either.getOrThrow((await runExample(page, tool, { limit }, { siteOrigin: origin, list: {}, deadlineMs: 40_000 })).result);
  const cursor = (sealListOutput(first, { limit }, scope).output as { readonly next_cursor: string | null }).next_cursor;
  const admitted = admitListCursor({ limit, cursor }, scope);
  if (!admitted.ok) throw new Error(admitted.message);
  await page.goto("about:blank");
  const second = Either.getOrThrow(
    (await runExample(page, tool, { limit, cursor }, { siteOrigin: origin, list: admitted.list, deadlineMs: 40_000 })).result,
  );
  return { first, second };
};

const pageOf = (rows: readonly { readonly key: string; readonly name: string }[], hasMore: boolean, total: number | null) => ({
  rows,
  has_more: hasMore,
  total_results: total,
  list_changed: false,
  next_cursor: hasMore ? expect.stringMatching(/^pcd1\./u) : null,
  next_cursor_expires_at: null,
});

test.describe("readList through the pager, one call per page", () => {
  test("a table that re-renders in place: page two starts the list again and reaches its page by number", async ({
    page,
  }) => {
    await openTable(page, { style: "datatables", total: 57, pageSize: 10, delays: [60, 20] });
    const tool = readerTool("pages", `rows: page.locator("#rows > tr")`, `await page.goto(${JSON.stringify(`${origin}/`)});`);
    // A limit that ends inside a site page: page two finishes that page and goes on to the next.
    const { first, second } = await twoCalls(page, tool, "list_rows", 15);
    expect(first).toEqual(pageOf(records(15), true, 57));
    expect(second).toEqual(pageOf(records(15, 16), true, 57));
  });

  test("pages with their own URLs: page two opens the site's link to its page", async ({ page }) => {
    const all = records(30);
    const visited: string[] = [];
    await serve(page, (url) => {
      visited.push(url.pathname + url.search);
      const paged = Number(url.searchParams.get("paged") ?? "1");
      const next = paged * 12 < all.length ? `<a class="next-page" href="/items?paged=${paged + 1}">Next page</a>` : "";
      return `<div class="tablenav-pages"><span class="displaying-num">${all.length} items</span>${next}</div>${rowsHtml(all.slice((paged - 1) * 12, paged * 12))}`;
    });
    const tool = readerTool("next_link", `rows: page.locator("#rows > tr")`, `await page.goto(${JSON.stringify(`${origin}/items`)});`);
    const { first, second } = await twoCalls(page, tool, "list_rows", 15);
    expect(first).toEqual(pageOf(records(15), true, 30));
    expect(second).toEqual(pageOf(records(15, 16), false, 30));
    // Page two went straight to the second site page by its link, never through page one again.
    expect(visited).toEqual(["/items", "/items?paged=2", "/items?paged=2", "/items?paged=3"]);
  });

  test("a 'Load more' list: page two replays page one's steps and continues", async ({ page }) => {
    await loadMoreList(page, { total: 30, batch: 8, ending: "removed" });
    const tool = readerTool("append", `rows: page.locator("#rows > li")`, `await page.goto(${JSON.stringify(`${origin}/`)});`);
    const { first, second } = await twoCalls(page, tool, "list_rows", 10);
    expect(first).toEqual(pageOf(records(10), true, null));
    expect(second).toEqual(pageOf(records(10, 11), true, null));
    await expect(page.locator("#clicks")).toHaveText("2");
  });

  test("the reference example pages a table through two calls", async ({ page }) => {
    test.info().annotations.push({
      type: "slow",
      description: "The example keeps the runtime's default settle and hold times, which each read waits out.",
    });
    test.setTimeout(60_000);
    await openTable(page, { style: "datatables", total: 57, pageSize: 10 });
    const { first, second } = await twoCalls(page, listRecords, "list_records", 15);
    const named = (rows: readonly { readonly key: string; readonly name: string }[]) =>
      rows.map((row) => ({ id: row.key, name: row.name }));
    const { rows: _first, ...firstFields } = pageOf(records(15), true, 57);
    const { rows: _second, ...secondFields } = pageOf(records(15, 16), true, 57);
    expect(first).toEqual({ records: named(records(15)), ...firstFields });
    expect(second).toEqual({ records: named(records(15, 16)), ...secondFields });
  });
});

test.describe("readList through the pager on lists that show no control", () => {
  test("a 'Load more' list short enough to show no control is one page", async ({ page }) => {
    await loadMoreList(page, { total: 5, batch: 8, ending: "removed" });
    const tool = readerTool("append", `rows: page.locator("#rows > li")`, `await page.goto(${JSON.stringify(`${origin}/`)});`);
    const first = await runExample(page, tool, { limit: 10 }, { siteOrigin: origin, list: {}, deadlineMs: 40_000 });
    expect(Either.getOrThrow(first.result)).toEqual(pageOf(records(5), false, null));
  });

  test("an empty 'Load more' list answers with no rows", async ({ page }) => {
    await serve(page, () => `<ul id="rows"></ul><p id="none">No rooms match</p>`);
    await page.goto(`${origin}/`);
    const tool = readerTool(
      "append",
      `rows: page.locator("#rows > li"), empty: page.locator("#none")`,
      `await page.goto(${JSON.stringify(`${origin}/`)});`,
    );
    const first = await runExample(page, tool, { limit: 10 }, { siteOrigin: origin, list: {}, deadlineMs: 40_000 });
    expect(Either.getOrThrow(first.result)).toEqual(pageOf([], false, null));
  });

  test("a scrolled list named as such pages through two calls", async ({ page }) => {
    const panel = () => `<div id="panel" style="height: 200px; overflow-y: auto"><ul id="rows"></ul><div id="sentinel" style="height: 1px"></div></div>
      <script>
        let shown = 0;
        const add = async () => {
          if (shown >= 24) return;
          await fetch("/api/wait?ms=60");
          const until = Math.min(24, shown + 8);
          for (; shown < until; shown += 1)
            document.querySelector("#rows").insertAdjacentHTML("beforeend", '<li data-id="R' + String(shown + 1).padStart(3, "0") + '" style="height: 30px"><span class="name">Record ' + (shown + 1) + "</span></li>");
        };
        new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) add(); }, { root: document.querySelector("#panel") })
          .observe(document.querySelector("#sentinel"));
      </script>`;
    await serve(page, panel);
    const tool = readerTool("scroll", `rows: page.locator("#rows > li")`, `await page.goto(${JSON.stringify(`${origin}/`)});`);
    const { first, second } = await twoCalls(page, tool, "list_rows", 10);
    expect(first).toEqual(pageOf(records(10), true, null));
    expect(second).toEqual(pageOf(records(10, 11), true, null));
  });

  test("pages whose URL parameter counts from zero are reached by number on a later call", async ({ page }) => {
    const all = records(30);
    await serve(page, (url) => {
      const index = Number(url.searchParams.get("page") ?? "0");
      const next = (index + 1) * 10 < all.length ? `<a href="/zero?page=${index + 1}">Next</a>` : `<span class="disabled">Next</span>`;
      return `${rowsHtml(all.slice(index * 10, index * 10 + 10))}<div class="pager">${index > 0 ? `<a href="/zero?page=${index - 1}">Previous</a>` : ""}${next}</div>`;
    });
    const tool = readerTool("next_link", `rows: page.locator("#rows > tr")`, `await page.goto(${JSON.stringify(`${origin}/zero`)});`);
    const { first, second } = await twoCalls(page, tool, "list_rows", 15);
    expect(first).toEqual(pageOf(records(15), true, null));
    expect(second).toEqual(pageOf(records(15, 16), false, null));
  });
});

test("readList fails a call whose step leads nowhere while the page shows more, never calling the list ended", async ({
  page,
}) => {
  await openTable(page, { style: "datatables", total: 40, pageSize: 10, deadNextOnPage: 2 });
  const tool = readerTool("pages", `rows: page.locator("#rows > tr")`, `await page.goto(${JSON.stringify(`${origin}/`)});`);
  const { result } = await runExample(page, tool, { limit: 25 }, { siteOrigin: origin, list: {}, deadlineMs: 40_000 });
  expect(Either.isLeft(result) ? String(result.left) : "no failure").toContain("pager_stalled");
});
