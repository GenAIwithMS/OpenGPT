import type { Page } from "playwright";
import { waitCode } from "../../src/browser/wait.js";
import { paginationCode } from "../../src/browser/pagination.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";

// Synthetic list sites for the pager's browser tests. Each reproduces the markup pattern of a
// common table, grid or admin library, or a deliberately bad behavior, with made-up records. Every
// delay is short and injected, so a walk across several pages ends in well under 3 s.

export const origin = "https://list.example.test";

/** Record ids and names in the site's order: R001 "Record 1", and so on. */
export const records = (count: number, from = 1) =>
  Array.from({ length: count }, (_, index) => ({
    key: `R${String(from + index).padStart(3, "0")}`,
    name: `Record ${from + index}`,
  }));

/** Budgets small enough for local fixtures; the defaults are the runtime's. */
export const fastBudgets = "stableMs: 120, unchangedMs: 300, noProgressMs: 700, timeout: 4000";

/** Runs a Kernel call body after the wait and pager code, as a script's call does. */
export const runPager = async (page: Page, body: string) => {
  const answer = await makeLocalKernel(page).browsers.playwright.execute("session-1", {
    timeout_sec: 40,
    code: `${waitCode}\n${paginationCode}\ntry {\n${body}\n} catch (error) {\n  return { failure: error.reason ?? error.name, message: error.message };\n}`,
  });
  if (!answer.success) throw new Error(String(answer.error));
  return answer.result as Record<string, unknown>;
};

/** Serves each path through `handler`; `/api/wait?ms=` answers after that many milliseconds. */
export const serve = async (
  page: Page,
  handler: (url: URL) => string | { readonly status?: number; readonly body: string; readonly delayMs?: number },
) => {
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/favicon.ico") return route.fulfill({ status: 404 });
    if (url.pathname === "/api/wait") {
      await new Promise((resolve) => setTimeout(resolve, Number(url.searchParams.get("ms") ?? "0")));
      return route.fulfill({ contentType: "application/json", body: "{}" }).catch(() => undefined);
    }
    const answer = handler(url);
    if (typeof answer !== "string" && answer.delayMs !== undefined)
      await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
    const body = typeof answer === "string" ? answer : answer.body;
    return route.fulfill({
      status: typeof answer === "string" ? 200 : (answer.status ?? 200),
      contentType: "text/html; charset=utf-8",
      body,
    });
  });
};

/**
 * A client-side table that re-renders its rows in place, without a URL change, in the markup of
 * `style`. Options make it misbehave the ways real lists do.
 */
export interface TableApp {
  readonly style: "datatables" | "mui" | "grid" | "antd" | "bootstrap-js" | "plain";
  readonly total: number;
  readonly pageSize: number;
  /** Milliseconds each page load takes, cycled; a load goes through the site's own request. */
  readonly delays?: readonly number[];
  /** Pagers above and below the table, as admin tables often show. */
  readonly duplicatePagers?: boolean;
  /** A step first re-renders the current rows, new elements with the same content. */
  readonly identicalReload?: boolean;
  /** Next stays disabled this long after the new rows show. */
  readonly nextLagMs?: number;
  /** Rows appear one at a time, this many milliseconds apart. */
  readonly streamMs?: number;
  /** The summary's total is this much more than the rows. */
  readonly totalOffset?: number;
  /** A row the site adds at the top once page one was read, as a list sorted by newest does. */
  readonly insertAfterFirstStep?: boolean;
  /** A step from this page goes back to page one, as a filter re-applied on every step does. */
  readonly resetFromPage?: number;
  /** The last page's Next stays enabled and does nothing. */
  readonly deadLastNext?: boolean;
  /** Numbered links show only a window around the current page, with the first and last. */
  readonly windowed?: boolean;
  /** Page sizes a native select offers. */
  readonly pageSizes?: readonly number[];
  /** Show the approximate summary this library uses when it does not know the total. */
  readonly approximate?: boolean;
  /** No summary at all. */
  readonly noSummary?: boolean;
  /** While a page loads, its rows are replaced by placeholder rows without ids. */
  readonly skeleton?: boolean;
  /** While a page loads, its rows are removed and a spinner shows instead. */
  readonly clearRows?: boolean;
  /** Previous and Next are bare arrows, with no label. */
  readonly arrowsOnly?: boolean;
  /** Next on this page is shown enabled and does nothing. */
  readonly deadNextOnPage?: number;
}

export const tableApp = (options: TableApp) => `<!doctype html>
<html><body>
<header><nav><a href="/">Home</a> <a href="/help">Help</a></nav></header>
<section class="carousel"><button aria-label="Next">›</button><div class="slide">Featured</div></section>
<main id="app">
  ${options.pageSizes === undefined ? "" : `<label>Rows per page <select id="size">${options.pageSizes.map((size) => `<option value="${size}"${size === options.pageSize ? " selected" : ""}>${size}</option>`).join("")}</select></label>`}
  <label>Filter <input id="filter"></label>
  <div class="pager-slot" id="top"></div>
  <div class="grid-body"><table><tbody id="rows"></tbody></table></div>
  <div class="info" id="info"></div>
  <div class="pager-slot" id="bottom"></div>
  <output id="loads">0</output>
</main>
<script>
(() => {
  const config = ${JSON.stringify(options)};
  let data = Array.from({ length: config.total }, (_, i) => ({ id: "R" + String(i + 1).padStart(3, "0"), name: "Record " + (i + 1) }));
  let current = 1;
  let size = config.pageSize;
  let filter = "";
  let loads = 0;
  let steps = 0;
  let nextHeld = false;
  const tbody = document.querySelector("#rows");
  const all = () => data.filter((row) => row.name.includes(filter));
  const pages = () => Math.max(1, Math.ceil(all().length / size));
  const rowHtml = (row) =>
    config.style === "grid"
      ? '<tr class="row" data-id="' + row.id + '"><td class="pinned">' + row.id + '</td><td class="name">' + row.name + "</td></tr>"
      : '<tr data-id="' + row.id + '"><td class="name">' + row.name + "</td></tr>";
  const renderRows = (rows) => {
    tbody.innerHTML = "";
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td class="empty">No matching records found</td></tr>';
      return;
    }
    if (!config.streamMs) {
      tbody.innerHTML = rows.map(rowHtml).join("");
      // A grid with a pinned column draws each row twice, in two containers, under one id.
      if (config.style === "grid") tbody.insertAdjacentHTML("beforeend", rows.map((row) => '<tr class="row pinned-copy" data-id="' + row.id + '"><td class="name">' + row.name + "</td></tr>").join(""));
      return;
    }
    rows.forEach((row, index) => setTimeout(() => tbody.insertAdjacentHTML("beforeend", rowHtml(row)), (index + 1) * config.streamMs));
  };
  const visibleRows = () => all().slice((current - 1) * size, current * size);
  const summary = () => {
    const count = all().length;
    const from = count === 0 ? 0 : (current - 1) * size + 1;
    const to = Math.min(current * size, count);
    const total = count + (config.totalOffset ?? 0);
    if (config.noSummary) return "";
    if (config.approximate) return from + "–" + to + " of more than " + to;
    switch (config.style) {
      case "datatables": return "Showing " + from + " to " + to + " of " + total + " entries";
      case "mui": return from + "–" + to + " of " + total;
      case "grid": return from + " to " + to + " of " + total;
      case "antd": return "Total " + total + " items";
      default: return "Showing " + from + " to " + to + " of " + total + " results";
    }
  };
  const numbersToShow = () => {
    const last = pages();
    if (!config.windowed) return Array.from({ length: last }, (_, i) => i + 1);
    const shown = new Set([1, last, current - 1, current, current + 1].filter((n) => n >= 1 && n <= last));
    return [...shown].sort((a, b) => a - b);
  };
  const pagerHtml = () => {
    const last = pages();
    const prevOff = current === 1;
    const nextOff = (current >= last && !config.deadLastNext) || nextHeld;
    const nums = numbersToShow();
    const gaps = (render) => nums.map((n, i) => (i > 0 && n - nums[i - 1] > 1 ? render.gap : "") + render.page(n)).join("");
    switch (config.style) {
      case "datatables":
        return '<div class="dataTables_paginate paging_simple_numbers">' +
          '<a class="paginate_button previous' + (prevOff ? " disabled" : "") + '" aria-disabled="' + prevOff + '" role="link" data-dt-idx="previous" tabindex="' + (prevOff ? -1 : 0) + '" data-go="' + (current - 1) + '">Previous</a><span>' +
          gaps({ gap: '<span class="ellipsis">…</span>', page: (n) => '<a class="paginate_button' + (n === current ? " current" : "") + '" role="link"' + (n === current ? ' aria-current="page"' : "") + ' data-go="' + n + '">' + n + "</a>" }) +
          '</span><a class="paginate_button next' + (nextOff ? " disabled" : "") + '" aria-disabled="' + nextOff + '" role="link" data-dt-idx="next" tabindex="' + (nextOff ? -1 : 0) + '" data-go="' + (current + 1) + '">Next</a></div>';
      case "mui":
        return '<div class="MuiTablePagination-root"><p class="MuiTablePagination-displayedRows">' + summary() + '</p>' +
          '<button class="MuiIconButton-root' + (prevOff ? " Mui-disabled" : "") + '"' + (prevOff ? " disabled" : "") + ' aria-label="Go to previous page" title="Go to previous page" data-go="' + (current - 1) + '"><svg viewBox="0 0 24 24"></svg></button>' +
          '<button class="MuiIconButton-root' + (nextOff ? " Mui-disabled" : "") + '"' + (nextOff ? " disabled" : "") + ' aria-label="Go to next page" title="Go to next page" data-go="' + (current + 1) + '"><svg viewBox="0 0 24 24"></svg></button></div>';
      case "grid":
        return '<div class="ag-paging-panel"><span class="ag-paging-row-summary-panel">' + summary().replace(/(\\d[\\d,]*)/g, '<span class="ag-paging-row-summary-panel-number">$1</span>') + '</span>' +
          '<span class="ag-paging-page-summary-panel">' +
          '<div class="ag-button ag-paging-button' + (prevOff ? " ag-disabled" : "") + '" role="button" aria-label="Previous Page" aria-disabled="' + prevOff + '" data-go="' + (current - 1) + '"><span class="ag-icon ag-icon-previous" style="display: inline-block; width: 16px; height: 16px"></span></div>' +
          '<span class="ag-paging-description" role="status"><span>Page </span><span class="ag-paging-number">' + current + '</span><span> of </span><span class="ag-paging-number">' + last + '</span></span>' +
          '<div class="ag-button ag-paging-button' + (nextOff ? " ag-disabled" : "") + '" role="button" aria-label="Next Page" aria-disabled="' + nextOff + '" data-go="' + (current + 1) + '"><span class="ag-icon ag-icon-next" style="display: inline-block; width: 16px; height: 16px"></span></div></span></div>';
      case "antd":
        return '<ul class="ant-pagination"><li class="ant-pagination-total-text">' + summary() + '</li>' +
          '<li title="Previous Page" style="display: inline-block" class="ant-pagination-prev' + (prevOff ? " ant-pagination-disabled" : "") + '" aria-disabled="' + prevOff + '" data-go="' + (current - 1) + '"><button class="ant-pagination-item-link" type="button"' + (prevOff ? " disabled" : "") + '><span class="anticon" style="display: inline-block; width: 14px; height: 14px"></span></button></li>' +
          nums.map((n) => '<li style="display: inline-block" title="' + n + '" class="ant-pagination-item ant-pagination-item-' + n + (n === current ? " ant-pagination-item-active" : "") + '"><a rel="nofollow" data-go="' + n + '">' + n + "</a></li>").join("") +
          (current + 5 <= last ? '<li title="Next 5 Pages" style="display: inline-block" class="ant-pagination-jump-next"><a class="ant-pagination-item-link" data-go="' + (current + 5) + '">•••</a></li>' : "") +
          '<li title="Next Page" style="display: inline-block" class="ant-pagination-next' + (nextOff ? " ant-pagination-disabled" : "") + '" aria-disabled="' + nextOff + '" data-go="' + (current + 1) + '"><button class="ant-pagination-item-link" type="button"' + (nextOff ? " disabled" : "") + '><span class="anticon" style="display: inline-block; width: 14px; height: 14px"></span></button></li></ul>';
      case "bootstrap-js":
        return '<nav aria-label="Page navigation"><ul class="pagination">' +
          '<li class="page-item' + (prevOff ? " disabled" : "") + '"><a class="page-link" href="#" data-go="' + (current - 1) + '">' + (config.arrowsOnly ? "‹" : "Previous") + "</a></li>" +
          gaps({ gap: '<li class="page-item disabled"><span class="page-link">…</span></li>', page: (n) => '<li class="page-item' + (n === current ? " active" : "") + '"' + (n === current ? ' aria-current="page"' : "") + '><a class="page-link" href="#" data-go="' + n + '">' + n + "</a></li>" }) +
          '<li class="page-item' + (nextOff ? " disabled" : "") + '"><a class="page-link" href="#"' + (config.arrowsOnly ? "" : ' aria-label="Next"') + ' data-go="' + (current + 1) + '">' + (config.arrowsOnly ? "›" : '<span aria-hidden="true">&raquo;</span>') + "</a></li></ul></nav>";
      default:
        return '<div class="pager"><button data-go="' + (current - 1) + '"' + (prevOff ? " disabled" : "") + '>Previous</button> <span>Page ' + current + '</span> <button data-go="' + (current + 1) + '"' + (nextOff ? " disabled" : "") + ">Next</button></div>";
    }
  };
  const renderPager = () => {
    document.querySelector("#bottom").innerHTML = pagerHtml();
    document.querySelector("#top").innerHTML = config.duplicatePagers ? pagerHtml() : "";
    document.querySelector("#info").textContent = config.style === "mui" || config.style === "grid" || config.style === "antd" ? "" : summary();
  };
  const load = async (target) => {
    const delay = config.delays === undefined ? 0 : config.delays[loads % config.delays.length];
    loads += 1;
    document.querySelector("#loads").textContent = loads;
    tbody.setAttribute("aria-busy", "true");
    for (const control of document.querySelectorAll("[data-go]")) control.setAttribute("aria-disabled", "true");
    if (config.identicalReload) renderRows(visibleRows());
    if (config.clearRows) tbody.innerHTML = "";
    if (config.clearRows) document.querySelector("#info").textContent = "Loading…";
    if (config.skeleton) tbody.innerHTML = Array.from({ length: size }, () => '<tr class="skeleton"><td class="name"></td></tr>').join("");
    await fetch("/api/wait?ms=" + delay);
    current = Math.min(Math.max(1, target), pages());
    if (config.nextLagMs) nextHeld = true;
    renderRows(visibleRows());
    renderPager();
    tbody.removeAttribute("aria-busy");
    if (config.nextLagMs) setTimeout(() => { nextHeld = false; renderPager(); }, config.nextLagMs);
  };
  document.addEventListener("click", (event) => {
    const control = event.target.closest("[data-go]");
    if (control === null) return;
    event.preventDefault();
    if (control.closest(".disabled, .ant-pagination-disabled") || control.disabled || control.getAttribute("aria-disabled") === "true") return;
    const target = Number(control.dataset.go);
    if (target > pages()) return;
    if (config.deadNextOnPage === current && target === current + 1) return;
    steps += 1;
    if (config.insertAfterFirstStep && steps === 1) data = [{ id: "R000", name: "Record 0" }, ...data];
    load(config.resetFromPage !== undefined && current >= config.resetFromPage && target > current ? 1 : target);
  });
  document.querySelector("#size")?.addEventListener("change", (event) => {
    size = Number(event.target.value);
    load(1);
  });
  document.querySelector("#filter").addEventListener("input", (event) => {
    filter = event.target.value;
    load(1);
  });
  current = 1;
  renderRows(visibleRows());
  renderPager();
})();
</script>
</body></html>`;

/** Opens a table app at the origin's root. */
export const openTable = async (page: Page, options: TableApp) => {
  await serve(page, () => tableApp(options));
  await page.goto(`${origin}/`);
};

/** The pager spec for a table app's rows. */
export const tableSpec = (extra = "") =>
  `rows: page.locator("#rows > tr"), key: { attribute: "data-id" }, fields: { name: ".name" }, empty: page.locator("#rows .empty"), ${fastBudgets}${extra === "" ? "" : `, ${extra}`}`;
