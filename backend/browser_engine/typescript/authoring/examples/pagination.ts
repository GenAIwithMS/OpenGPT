import { Schema } from "effect";
import {
  defineOperation,
  listInputFields,
  listOutputFields,
  readList,
  startList,
  visibleTextCode,
  waitCode,
} from "../../src/browser/index.js";

// A search whose site pages with numbered pages and a Next link. `readList` does the paging: it
// asks the reader below for exactly the rows the call's window needs, reads the rest of a site
// page or the next one while rows are lacking, and writes the next position, so the call's
// `limit` and the site's page size need not match. Page one runs the search through the site's
// own form. A later page starts as page one did (the host opens the site and signs in first when
// the tool signs in), then opens the site's own link to the page that holds the last returned
// row and reads the query back; when that link no longer shows the query, it runs the search and
// follows Next to that page's number. Each read waits for the list's answer, then only for the
// rows asked for, and reads their visible text. The selectors and the read are site logic:
// replace them with what the build observed on the site.

const Listing = Schema.Struct({
  id: Schema.NonEmptyTrimmedString.annotations({ description: "The site's listing ID" }),
  title: Schema.NonEmptyTrimmedString.annotations({ description: "The listing's title as the site shows it" }),
  sponsored: Schema.Boolean.annotations({
    description: "True for a listing the site marks as sponsored",
  }),
});
type Listing = typeof Listing.Type;

/**
 * One site page as the read returns it: its link as the browser shows it, the query it shows, the
 * rows asked for, whether it holds rows past them, its Next link and the site's count.
 */
const SitePage = Schema.Struct({
  href: Schema.String,
  query: Schema.String,
  rows: Schema.Array(Listing),
  more: Schema.Boolean,
  next: Schema.NullOr(Schema.String),
  totalResults: Schema.NullOr(Schema.Number),
});
type SitePage = typeof SitePage.Type & { readonly hasNext: boolean };

/**
 * Page code, after waitCode and visibleTextCode with `site` and `action` declared: waits for the
 * list's answer, the site's empty message or its results, then for the first `count` rows to
 * have their ID and title filled in and holding, and reads the query the page shows, its count
 * and its Next link. A page that shows no answer throws outcome_unknown or outcome_timeout, and
 * rows still loading when the page stops progressing throw values_loading: the host retries a
 * read once after either, so they are never caught here.
 */
const readPageCode = (count: number) => `
const results = page.locator("#results");
const shown = await waitForOutcome({ empty: page.locator("#no-results"), results }, { ...site, action });
const query = (await page.locator("#q").inputValue({ timeout: waitLimits.action })).trim();
if (shown === "empty")
  return { href: page.url(), query, rows: [], more: false, next: null, totalResults: null };
const { rows, more } = await waitForRows(page.locator("#results > li"), {
  title: ".title",
  // The badge's presence is the mark, so read its class rather than text it may not have.
  sponsored: { selector: ".sponsored", attribute: "class", optional: true },
}, { count: ${count}, key: { attribute: "data-id" }, region: results, ...site });
const counted = /of (\\d+)/.exec((await visibleTexts(page.locator("#count")))[0] ?? "");
const next = page.locator("a[rel=next]");
const nextHref = (await next.count()) === 1 ? await next.getAttribute("href", { timeout: waitLimits.action }) : null;
return {
  href: page.url(),
  query,
  rows: rows.map((row) => ({ id: row.key, title: row.title, sponsored: row.sponsored !== null })),
  more,
  next: nextHref === null ? null : new URL(nextHref, page.url()).href,
  totalResults: counted === null ? null : Number(counted[1]),
};`;

/**
 * The listing's own ID, the same on a sponsored copy: `readList` drops a sponsored copy of a listing
 * the rows it read show, or an earlier page returned, so a listing comes back at its organic place.
 */
const keyOf = (row: Listing) => row.id;

/**
 * Reading on to another site page needs at least this much of the run's time left. With less, the
 * call returns the rows it read and a position that continues.
 */
const readOnMs = 5_000;

export default defineOperation(
  {
    name: "search_listings",
    input: Schema.Struct({
      query: Schema.NonEmptyString.pipe(Schema.pattern(/\S/u)).annotations({ description: "What to search the listings for" }),
      ...listInputFields,
    }),
    output: Schema.Struct({
      results: Schema.Array(Listing).annotations({
        description: "Listings in the site's order, sponsored ones in place",
      }),
      ...listOutputFields,
    }),
  },
  async ({ kernel, sessionId, siteOrigin, siteDomain, input, remainingMs, errors }) => {
    // Before any browser work: the limit, and on a later page the position the cursor holds.
    const list = startList(input, { mechanism: "pages" });
    if (siteOrigin === undefined)
      throw new errors.OperationFailure("No site origin for a live run", { dispatch: "not_sent" });
    const query = input.query.trim();
    // One Kernel call per site page: `steps` brings the page and `action` is the step that brings
    // its answer, run once by the wait. Each call stays inside the run's own deadline.
    const run = async (steps: string, action: string, count: number): Promise<SitePage> => {
      const timeoutSec = Math.min(60, Math.floor(remainingMs() / 1_000) - 1);
      if (timeoutSec < 1) throw new errors.OperationFailure("No time left to read the list");
      const answer = await kernel.browsers.playwright.execute(sessionId, {
        timeout_sec: timeoutSec,
        code: `
${waitCode}
${visibleTextCode}
// The site's own requests, on every host of its domain, count as progress.
const site = ${JSON.stringify(siteDomain === undefined ? {} : { siteDomain })};
${steps}
const action = ${action};
${readPageCode(count)}`,
      });
      if (!answer.success)
        throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
      const sitePage = Schema.decodeUnknownSync(SitePage)(answer.result);
      return { ...sitePage, hasNext: sitePage.next !== null };
    };
    const navigate = (url: string) =>
      `await page.goto(${JSON.stringify(url)}, { waitUntil: "domcontentloaded", timeout: waitLimits.navigation });`;
    const search = (count: number) =>
      run(
        `${navigate(siteOrigin)}
await page.locator("#q").fill(${JSON.stringify(input.query.trim())}, { timeout: waitLimits.action });`,
        `() => page.locator("#go").click({ timeout: waitLimits.action })`,
        count,
      );
    const open = (href: string, count: number) => run(navigate(href), "undefined", count);

    const page = await readList(list, {
      keyOf,
      promoted: (row) => row.sponsored,
      remainingMs,
      readOnMs,
      open: async (position, count) => {
        // A later page: the site's own link to the page that holds the last returned row, which
        // must still show this query.
        if (position?.href !== undefined) {
          const linked = await open(position.href, count);
          if (linked.query === query) return linked;
        }
        // Page one, or a link that no longer shows the query: run the search, then follow Next to
        // the page the position names, waiting only for the rows read on that page.
        const target = position?.page ?? 1;
        let sitePage = await search(target === 1 ? count : 1);
        for (let at = 2; at <= target && sitePage.next !== null; at++)
          sitePage = await open(sitePage.next, at === target ? count : 1);
        if (sitePage.query !== query)
          throw new errors.OperationFailure("The results page does not show the requested query");
        return sitePage;
      },
      // More rows of the page already open, such as when rows inserted above the last returned
      // row pushed the window further down it: read again, without navigating.
      more: (_sitePage, count) => run("", "undefined", count),
      next: async (sitePage, count) => {
        if (sitePage.next === null) throw new errors.OperationFailure("The page has no Next link");
        return open(sitePage.next, count);
      },
    });
    return { results: page.rows, ...page.output };
  },
);

const Room = Schema.Struct({
  id: Schema.NonEmptyTrimmedString.annotations({ description: "The room's ID on the site" }),
  name: Schema.NonEmptyTrimmedString.annotations({ description: "The room's name" }),
});
type Room = typeof Room.Type;

/**
 * The rooms list as one read leaves it: the first rows asked for in the site's order, whether more
 * show past them, whether "Show more" is still offered, and how many rows one step adds.
 */
const Listed = Schema.Struct({
  rows: Schema.Array(Schema.Struct({ key: Schema.NonEmptyTrimmedString, name: Schema.NonEmptyTrimmedString })),
  more: Schema.Boolean,
  hasNext: Schema.Boolean,
  stepSize: Schema.Int.pipe(Schema.positive()),
});
type RoomsRead = { readonly rows: readonly Room[] } & Omit<typeof Listed.Type, "rows">;

// Append pagination on an observed list: "Show more" adds the next rooms to the same list, each
// row named by its data-room-id. `readList` asks for each read and step and writes the position:
// the fewest steps that load the last returned room and the offset after it, so a later page
// replays exactly those steps, then reads on. Each step waits for the rows it added. The control
// gone or disabled after a step's rows arrived is the end of the list. A step that adds no
// identified row is not proof of the end: one more read without a click decides, and the end is
// only the rows still not grown with the control still gone or disabled. A list that stops
// growing while the control is still offered has more: readList returns a position that
// continues, never a null cursor, and a later call that still stalls there ends the list with
// has_more true and next_cursor_unavailable "no_progress".
// Adapt every role, name and attribute from your own session's evidence.
export const readRooms = defineOperation(
  {
    name: "list_rooms",
    input: Schema.Struct({ ...listInputFields }),
    output: Schema.Struct({
      rooms: Schema.Array(Room).annotations({ description: "Rooms in the site's order" }),
      ...listOutputFields,
    }),
  },
  async ({ kernel, sessionId, siteDomain, input, errors }) => {
    // Before any browser work: the limit, and on a later page the steps the cursor holds.
    const list = startList(input, { mechanism: "append" });
    const run = async (code: string): Promise<RoomsRead> => {
      const answer = await kernel.browsers.playwright.execute(sessionId, {
        timeout_sec: 120,
        code: `
        ${waitCode}
        // The site's own requests, on every host of its domain, count as progress.
        const site = ${JSON.stringify(siteDomain === undefined ? {} : { siteDomain })};
        const list = page.getByRole("list", { name: "Rooms", exact: true });
        const rows = list.getByRole("listitem");
        const more = page.getByRole("button", { name: "Show more", exact: true });
        const offered = async () => (await more.count()) === 1 && (await more.isEnabled());
        const read = (count, action) =>
          waitForRows(rows, { name: ".name" }, {
            count,
            key: { attribute: "data-room-id" },
            region: list,
            ...site,
            ...(action === undefined ? {} : { action }),
          });
        // One "Show more" step from a list of before rows, waiting for about a step's rows more,
        // up to count. Many sites hide or disable the control while a step loads, and a
        // load the wait cannot see (another domain's API, a timer) can outlast it, so a step that
        // added nothing reads once more without a click before anyone calls the list ended.
        const step = async (before, count, stepSize) => {
          const target = Math.min(count, before + stepSize);
          const found = await read(target, () => more.click({ timeout: waitLimits.action }));
          return found.rows.length > before ? found : await read(target);
        };
        // What a read found, and whether the control still offers a step after it.
        const answer = async (found, stepSize) =>
          ({ rows: found.rows, more: found.more, hasNext: await offered(), stepSize });
        ${code}
      `,
      });
      if (!answer.success)
        throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
      const read = Schema.decodeUnknownSync(Listed)(answer.result);
      return { ...read, rows: read.rows.map(({ key, name }) => ({ id: key, name })) };
    };
    const page = await readList(list, {
      keyOf: (room: Room) => room.id,
      // The list as the run found it, then on a later page the steps the position holds.
      open: (position, count) =>
        run(`
        // An empty list is an answer only the site's own words give, never a list without rows.
        // A page that shows neither throws outcome_unknown or outcome_timeout, which the host
        // retries once, as it does a row still loading when the page stops progressing.
        const shown = await waitForOutcome({
          empty: page.getByRole("status").filter({ hasText: /^No rooms$/ }),
          list,
        }, site);
        if (shown === "empty") return { rows: [], more: false, hasNext: false, stepSize: 1 };
        // The first page's size comes from its rows once they have all arrived: a list can show
        // before its rows finish streaming in, so a count taken now could be one row. Asking for
        // the rows wanted returns fewer once their count held with no loading sign or request in
        // flight.
        let found = await read(${count});
        const stepSize = Math.max(1, found.rows.length);
        for (let done = 0; done < ${position?.steps ?? 0}; done++) {
          if (!(await offered())) break;
          const before = found.rows.length;
          found = await step(before, ${count}, stepSize);
          if (found.rows.length <= before) break;
        }
        if (found.more) found = await read(${count});
        return answer(found, stepSize);`),
      // More of the rows already loaded: read again, without a click.
      more: (rooms, count) => run(`return answer(await read(${count}), ${rooms.stepSize});`),
      next: (rooms, count) =>
        run(`return answer(
          await step(${rooms.rows.length}, ${count}, ${rooms.stepSize}),
          ${rooms.stepSize},
        );`),
    });
    return { rooms: page.rows, ...page.output };
  },
);

const Item = Schema.Struct({
  id: Schema.NonEmptyTrimmedString.annotations({ description: "The item's ID on the site" }),
  name: Schema.NonEmptyTrimmedString.annotations({ description: "The item's name" }),
  maker: Schema.NonEmptyTrimmedString.annotations({ description: "The item's maker, from its own page" }),
});
type Item = typeof Item.Type;

/** The light rows one read of the list leaves: each row's key, name and link to its own page. */
const LightRows = Schema.Struct({
  rows: Schema.Array(Schema.Struct({ id: Schema.NonEmptyTrimmedString, name: Schema.NonEmptyTrimmedString, href: Schema.String })),
  more: Schema.Boolean,
});
type LightRow = (typeof LightRows.Type)["rows"][number];
type LightRead = typeof LightRows.Type & { readonly hasNext: boolean };

// Rows whose fields come from each row's own detail page, on a list the site shows whole on one
// page (`offset`). `readList` reads only the light rows the list itself shows, keyed as usual, and
// the tool then opens the detail page only for each row `readList` returned. Avoid opening a
// detail page inside `open` or `more`: `readList` asks them for every row from the start of the
// list up to the cursor's position, so a later page would open every earlier row's page again.
// Adapt every role, name and attribute from your own session's evidence.
export const readItemDetails = defineOperation(
  {
    name: "list_item_details",
    input: Schema.Struct({ ...listInputFields }),
    output: Schema.Struct({
      items: Schema.Array(Item).annotations({ description: "Items in the site's order" }),
      ...listOutputFields,
    }),
  },
  async ({ kernel, sessionId, siteOrigin, siteDomain, input, remainingMs, errors }) => {
    const list = startList(input, { mechanism: "offset" });
    if (siteOrigin === undefined)
      throw new errors.OperationFailure("No site origin for a live run", { dispatch: "not_sent" });
    const run = async (code: string): Promise<unknown> => {
      const timeoutSec = Math.min(60, Math.floor(remainingMs() / 1_000) - 1);
      if (timeoutSec < 1) throw new errors.OperationFailure("No time left to read the items");
      const answer = await kernel.browsers.playwright.execute(sessionId, {
        timeout_sec: timeoutSec,
        code: `
${waitCode}
// The site's own requests, on every host of its domain, count as progress.
const site = ${JSON.stringify(siteDomain === undefined ? {} : { siteDomain })};
${code}`,
      });
      if (!answer.success)
        throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
      return answer.result;
    };
    const navigate = (url: string) =>
      `await page.goto(${JSON.stringify(url)}, { waitUntil: "domcontentloaded", timeout: waitLimits.navigation });`;
    const onSite = (url: URL) =>
      siteDomain === undefined
        ? url.origin === siteOrigin
        : url.protocol === "https:" &&
          (url.hostname === siteDomain || url.hostname.endsWith(`.${siteDomain}`));
    // The first `count` light rows of the list, after `steps` bring it.
    const readRows = async (steps: string, count: number): Promise<LightRead> => {
      const read = Schema.decodeUnknownSync(LightRows)(
        await run(`${steps}
const list = page.getByRole("list", { name: "Items", exact: true });
const shown = await waitForOutcome({ empty: page.getByRole("status").filter({ hasText: /^No items$/ }), list }, site);
if (shown === "empty") return { rows: [], more: false };
const { rows, more } = await waitForRows(list.getByRole("listitem"), {
  name: ".name",
  href: { selector: "a", attribute: "href" },
}, { count: ${count}, key: { attribute: "data-item-id" }, region: list, ...site });
return { rows: rows.map((row) => ({ id: row.key, name: row.name, href: new URL(row.href, page.url()).href })), more };`),
      );
      return { ...read, hasNext: false };
    };
    const page = await readList(list, {
      keyOf: (row: LightRow) => row.id,
      remainingMs,
      open: (_position, count) => readRows(navigate(new URL("/items", siteOrigin).href), count),
      // More of the list already open: read again, without navigating.
      more: (_read, count) => readRows("", count),
    });
    // Each returned row's own page, one call each, only for the rows this call returns.
    const items: Item[] = [];
    for (const row of page.rows) {
      if (!onSite(new URL(row.href)))
        throw new errors.OperationFailure("An item's link leaves the site");
      const detail = Schema.decodeUnknownSync(Schema.Struct({ maker: Schema.NonEmptyTrimmedString }))(
        await run(`${navigate(row.href)}
const { values } = await waitForValues({ maker: page.getByTestId("maker") }, site);
return { maker: values.maker };`),
      );
      items.push({ id: row.id, name: row.name, maker: detail.maker });
    }
    return { items, ...page.output };
  },
);
