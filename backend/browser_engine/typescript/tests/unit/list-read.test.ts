import { describe, expect, it } from "vitest";
import { admitListCursor, listCursorKeys, sealListOutput } from "../../src/runtime/list-cursor.js";
import {
  listCallBounds,
  listSeenMax,
  readList,
  startList,
  withListHost,
  type ListMechanism,
  type ListPosition,
  type ListReader,
  type ListSegment,
  type ListStart,
} from "../../src/runtime/list-page.js";

// Where each call of a list starts and what it returns when the call's page size and the site's
// differ, for every mechanism. A simulated site serves the rows; each call is a fresh read whose
// position comes from the cursor the previous call returned, sealed and admitted as a host does.

const origin = "https://www.example.test";
const scope = {
  keys: listCursorKeys({ current: { id: "k1", secret: new Uint8Array(32).fill(7) } }),
  operation: "list-tool",
  siteOrigin: origin,
  now: Date.UTC(2026, 0, 5, 12),
};
const ids = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => `r${from + index}`);

interface Row {
  readonly id: string;
}
/** A segment as the simulated readers return it, with where it sits on the site. */
interface SiteSegment extends ListSegment<Row> {
  readonly at: number;
}

/** The most rows a simulated site serves per request, as a site request with a count would. */
const requestMax = 1_000;
const checkCount = (count: number) => {
  if (!Number.isInteger(count) || count < 1 || count > requestMax)
    throw new Error(`a reader was asked for ${count} rows`);
};

/** A list site: `rows` in its order, `pageSize` rows per site page, API response or step. */
const listSite = (rows: string[], pageSize: number) => {
  const pageOf = (page: number) => rows.slice((page - 1) * pageSize, page * pageSize);
  const hrefOf = (page: number) => `${origin}/s?q=lamps&page=${page}`;
  const separate = (page: number, count: number, token?: string): SiteSegment => {
    checkCount(count);
    const all = pageOf(page);
    return {
      at: page,
      rows: all.slice(0, count).map((id) => ({ id })),
      more: all.length > count,
      hasNext: page * pageSize < rows.length,
      href: hrefOf(page),
      ...(token === undefined ? {} : { token }),
      totalResults: rows.length,
    };
  };
  // The whole list after `steps` "Load more" steps or scrolls.
  const grown = (steps: number, count: number): SiteSegment => {
    checkCount(count);
    const all = rows.slice(0, (steps + 1) * pageSize);
    return {
      at: steps,
      rows: all.slice(0, count).map((id) => ({ id })),
      more: all.length > count,
      hasNext: all.length < rows.length,
    };
  };
  const readers: Record<ListMechanism, ListReader<Row, SiteSegment>> = {
    pages: {
      keyOf: (row) => row.id,
      open: async (position, count) =>
        separate(
          position?.href === undefined
            ? (position?.page ?? 1)
            : Number(new URL(position.href).searchParams.get("page")),
          count,
        ),
      more: async (segment, count) => separate(segment.at, count),
      next: async (segment, count) => separate(segment.at + 1, count),
    },
    // A position without a link is reached by its page number, as a reader follows Next to it.
    next_link: {
      keyOf: (row) => row.id,
      open: async (position, count) =>
        separate(
          position?.href === undefined
            ? (position?.page ?? 1)
            : Number(new URL(position.href).searchParams.get("page")),
          count,
        ),
      more: async (segment, count) => separate(segment.at, count),
      next: async (segment, count) => separate(segment.at + 1, count),
    },
    // The API's token is the index its response starts at; the first request sends none. A
    // position without a token is reached by its page number.
    api: {
      keyOf: (row) => row.id,
      open: async (position, count) => {
        const page =
          position?.token === undefined
            ? (position?.page ?? 1)
            : Number(position.token) / pageSize + 1;
        return separate(page, count, page === 1 ? undefined : String((page - 1) * pageSize));
      },
      more: async (segment, count) => separate(segment.at, count, segment.token),
      next: async (segment, count) =>
        separate(segment.at + 1, count, String(segment.at * pageSize)),
    },
    append: {
      keyOf: (row) => row.id,
      open: async (position, count) => grown(position?.steps ?? 0, count),
      more: async (segment, count) => grown(segment.at, count),
      next: async (segment, count) => grown(segment.at + 1, count),
    },
    scroll: {
      keyOf: (row) => row.id,
      open: async (position, count) => grown(position?.steps ?? 0, count),
      more: async (segment, count) => grown(segment.at, count),
      next: async (segment, count) => grown(segment.at + 1, count),
    },
    // The whole list on one page.
    offset: {
      keyOf: (row) => row.id,
      open: async (_position, count) => ({
        at: 0,
        rows: rows.slice(0, count).map((id) => ({ id })),
        more: rows.length > count,
        hasNext: false,
      }),
      more: async (_segment, count) => ({
        at: 0,
        rows: rows.slice(0, count).map((id) => ({ id })),
        more: rows.length > count,
        hasNext: false,
      }),
    },
  };
  // Which segment each call's `open` reached: the site page, API response or steps it loaded,
  // and the pages the readers loaded since `loads.count` was last reset. Like the reference
  // reader, a site page or response reached by its number alone starts the list and follows Next
  // to it, one load per page.
  const opened: number[] = [];
  const loads = { count: 0 };
  const logged = Object.fromEntries(
    Object.entries(readers).map(([mechanism, reader]) => [
      mechanism,
      {
        ...reader,
        open: async (position: ListPosition | undefined, count: number) => {
          const byNumber =
            mechanism !== "append" &&
            mechanism !== "scroll" &&
            mechanism !== "offset" &&
            position?.href === undefined &&
            position?.token === undefined;
          loads.count += byNumber ? (position?.page ?? 1) : 1;
          const segment = await reader.open(position, count);
          opened.push(segment.at);
          return segment;
        },
        ...(reader.more === undefined
          ? {}
          : {
              more: async (segment: SiteSegment, count: number) => {
                loads.count++;
                return reader.more?.(segment, count) as Promise<SiteSegment>;
              },
            }),
        ...(reader.next === undefined
          ? {}
          : {
              next: async (segment: SiteSegment, count: number) => {
                loads.count++;
                return reader.next?.(segment, count) as Promise<SiteSegment>;
              },
            }),
      },
    ]),
  ) as Record<ListMechanism, ListReader<Row, SiteSegment>>;
  return { rows, readers: logged, opened, loads };
};

/** One call: its list from the input and the cursor the host admitted, then its rows and fields. */
const call = async (
  site: ReturnType<typeof listSite>,
  mechanism: ListMechanism,
  limit: number,
  cursor?: string,
  remainingMs?: () => number,
) => {
  const input = { query: "lamps", limit, ...(cursor === undefined ? {} : { cursor }) };
  const admitted = admitListCursor(input, scope);
  if (!admitted.ok) throw new Error(`refused: ${admitted.reason}`);
  const list: ListStart = startList(withListHost(input, admitted.list), { mechanism });
  const reader = site.readers[mechanism];
  const page = await readList(list, remainingMs === undefined ? reader : { ...reader, remainingMs });
  const sealed = sealListOutput({ rows: page.rows, ...page.output }, input, scope).output as {
    readonly next_cursor: string | null;
  };
  return {
    ids: page.rows.map((row) => row.id),
    output: page.output,
    cursor: sealed.next_cursor ?? undefined,
    reason: page.reason,
  };
};

const mechanisms: readonly ListMechanism[] = [
  "pages",
  "next_link",
  "api",
  "append",
  "scroll",
  "offset",
];

describe.each(mechanisms)("a %s list read 20 at a time over 30 per segment", (mechanism) => {
  it("continues inside a segment and across into the next, with no gap or repeat", async () => {
    const site = listSite(ids(1, 95), 30);
    const first = await call(site, mechanism, 20);
    expect(first.ids).toEqual(ids(1, 20));
    const second = await call(site, mechanism, 20, first.cursor);
    expect(second.ids).toEqual(ids(21, 40));
    const third = await call(site, mechanism, 20, second.cursor);
    expect(third.ids).toEqual(ids(41, 60));
    for (const page of [first, second, third])
      expect(page.output).toMatchObject({ has_more: true, list_changed: false });
  });

  it("straddles two segments when the call is larger than a segment", async () => {
    const site = listSite(ids(1, 95), 30);
    const first = await call(site, mechanism, 50);
    expect(first.ids).toEqual(ids(1, 50));
    const second = await call(site, mechanism, 50, first.cursor);
    expect(second.ids).toEqual(ids(51, 95));
    expect(second.output).toMatchObject({ next_cursor: null, has_more: false });
  });

  it("ends on a short last segment", async () => {
    const site = listSite(ids(1, 65), 30);
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = await call(site, mechanism, 20, cursor);
      pages.push(page.ids);
      cursor = page.cursor;
    } while (cursor !== undefined);
    expect(pages).toEqual([ids(1, 20), ids(21, 40), ids(41, 60), ids(61, 65)]);
  });

  it("keeps the anchor's guarantees when rows are inserted or removed between calls", async () => {
    const site = listSite(ids(1, 95), 30);
    const first = await call(site, mechanism, 20);
    // A row inserted above the last returned row: the next window starts right after that row,
    // here reading the rest of its segment past the rows first asked for.
    // The caller never gets the inserted row, so the list says it changed.
    site.rows.unshift("new");
    const inserted = await call(site, mechanism, 5, first.cursor);
    expect(inserted.ids).toEqual(ids(21, 25));
    expect(inserted.output.list_changed).toBe(true);
    // Nothing changed since: the next call says so.
    const unchanged = await call(site, mechanism, 5, inserted.cursor);
    expect(unchanged.ids).toEqual(ids(26, 30));
    expect(unchanged.output.list_changed).toBe(false);
    // A row the caller got removed above it: no gap, no repeat, and the list changed.
    site.rows.splice(site.rows.indexOf("r3"), 1);
    const removed = await call(site, mechanism, 15, unchanged.cursor);
    expect(removed.ids).toEqual(ids(31, 45));
    expect(removed.output.list_changed).toBe(true);
    // The last returned row itself removed: no row skipped, and the list says it changed.
    site.rows.splice(site.rows.indexOf("r45"), 1);
    const gone = await call(site, mechanism, 20, removed.cursor);
    expect(gone.ids).toEqual(ids(46, 65));
    expect(gone.output.list_changed).toBe(true);
    // A burst of new rows on top pushes the last returned row, and every row the cursor
    // remembers, about one and a half segments on: the call finds it and returns the next twenty.
    site.rows.unshift(...Array.from({ length: 45 }, (_, index) => `b${index + 1}`));
    const burst = await call(site, mechanism, 20, gone.cursor);
    expect(burst.ids).toEqual(ids(66, 85));
    expect(burst.output.list_changed).toBe(true);
  });
});

describe("the position a call hands the next", () => {
  // Which segment each call opens first: the one that holds the last row the previous call
  // returned, so the next call reaches it directly and resumes inside it.
  it.each<readonly [ListMechanism, readonly number[]]>([
    ["pages", [1, 1, 2]],
    ["next_link", [1, 1, 2]],
    ["api", [1, 1, 2]],
    ["append", [0, 0, 1]],
    ["scroll", [0, 0, 1]],
    ["offset", [0, 0, 0]],
  ])("reopens the %s segment that holds the last returned row", async (mechanism, segments) => {
    const site = listSite(ids(1, 95), 30);
    const first = await call(site, mechanism, 20);
    const second = await call(site, mechanism, 20, first.cursor);
    await call(site, mechanism, 20, second.cursor);
    expect(site.opened).toEqual(segments);
  });
});

describe("a list that stops growing while the site still offers more", () => {
  const stalled = (): ListReader<Row, SiteSegment> => {
    const grown = (at: number): SiteSegment => ({
      at,
      rows: ids(1, 2).map((id) => ({ id })),
      more: false,
      hasNext: true,
    });
    return {
      keyOf: (row) => row.id,
      open: async (position) => grown(position?.steps ?? 0),
      next: async (segment) => grown(segment.at + 1),
    };
  };

  it("returns what it read with has_more, and ends the next call that still stalls", async () => {
    const site = { rows: [], readers: { append: stalled() } } as unknown as ReturnType<
      typeof listSite
    >;
    const first = await call(site, "append", 10);
    expect(first.ids).toEqual(ids(1, 2));
    expect(first.output).toMatchObject({ has_more: true, next_cursor: expect.any(String) });
    const second = await call(site, "append", 10, first.cursor);
    expect(second.ids).toEqual([]);
    expect(second.output).toMatchObject({
      next_cursor: null,
      has_more: true,
      next_cursor_unavailable: "no_progress",
    });
  });
});

describe("a site link that carries a session", () => {
  it.each([
    `${origin}/s;jsessionid=A1B2C3?q=lamps&page=1`,
    `${origin}/s?q=lamps&page=1&sid=A1B2C3`,
    `${origin}/s?q=lamps&page=1#access_token=A1B2C3`,
    `${origin}/(S(A1B2C3))/s?q=lamps&page=1`,
    `${origin}/s?q=lamps&page=1&CFID=7&CFTOKEN=A1B2C3`,
    `${origin}/s?q=lamps&page=1&sessid=A1B2C3`,
    `${origin}/s?q=lamps&page=1&api_key=A1B2C3`,
    `${origin}/s?q=lamps&page=1&X-Amz-Signature=A1B2C3`,
    `${origin}/s?q=lamps&page=1&token=A1B2C3`,
    `${origin}/s?q=lamps&page=1&sig=A1B2C3`,
  ])("stays out of the cursor, which reaches the page by its number: %s", async (link) => {
    const site = listSite(ids(1, 95), 30);
    const reader = site.readers.pages;
    const withLink: ListReader<Row, SiteSegment> = {
      ...reader,
      open: async (position, count) => ({ ...(await reader.open(position, count)), href: link }),
    };
    const sessionSite = { ...site, readers: { ...site.readers, pages: withLink } };
    const first = await call(sessionSite, "pages", 20);
    expect(first.cursor).toEqual(expect.any(String));
    expect(first.cursor).not.toContain("A1B2C3");
    const decoded = Buffer.from(String(first.cursor).split(".")[2] ?? "", "base64url").toString();
    expect(decoded).not.toContain("A1B2C3");
    expect((await call(site, "pages", 20, first.cursor)).ids).toEqual(ids(21, 40));
  });
});

/** A small seeded random source, so each run of the fuzz cases checks the same sequences. */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
  return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
};

describe.each(mechanisms)("a %s list that changes between calls", (mechanism) => {
  const whole = mechanism === "append" || mechanism === "scroll" || mechanism === "offset";

  it("skips no row, repeats rows only with list_changed and returns none only when its reads run out, through bursts of new rows on top and removals of returned rows", async () => {
    const random = seeded(mechanisms.indexOf(mechanism) + 1);
    for (let trial = 0; trial < 60; trial++) {
      const pageSize = 1 + Math.floor(random() * 30);
      const limit = 1 + Math.floor(random() * 50);
      // A list reached by steps stays within the deepest replay, new rows included.
      const total = whole ? Math.min(90, pageSize * 6) : 90;
      const original = ids(1, total);
      const site = listSite([...original], pageSize);
      const returned: string[] = [];
      let cursor: string | undefined;
      let inserted = 0;
      for (let calls = 0; calls < 1_000; calls++) {
        site.loads.count = 0;
        const page = await call(site, mechanism, limit, cursor);
        // A call loads at most its bound, and repeats a row only while it says the list changed.
        const allLoads = whole ? 1 + listCallBounds.steps : listCallBounds.sitePages;
        const repeated = page.ids.some((id) => returned.includes(id));
        expect({ pageSize, limit, loads: site.loads.count <= allLoads }).toEqual({
          pageSize,
          limit,
          loads: true,
        });
        if (repeated) expect(page.output.list_changed).toBe(true);
        returned.push(...page.ids);
        cursor = page.cursor;
        if (cursor === undefined) break;
        // Only the call's reads stop a call with no rows here: the run's time never runs out.
        if (page.ids.length === 0)
          expect({ pageSize, limit, loads: site.loads.count }).toEqual({
            pageSize,
            limit,
            loads: allLoads,
          });
        // A newest-first burst of up to two segments' new rows above everything returned.
        if (random() < 0.5 && inserted < pageSize * 8) {
          const burst = Math.floor(random() * (2 * pageSize + 1));
          for (let row = 0; row < burst; row++) site.rows.unshift(`n${++inserted}`);
        }
        // Several rows the caller already got, removed, such as rows it acted on, while another
        // of the rows the cursor remembers stays.
        if (random() < 0.3) {
          const removals = 1 + Math.floor(random() * 8);
          for (let removal = 0; removal < removals; removal++) {
            const gone = returned[Math.floor(random() * returned.length)] ?? "";
            const remembered = returned
              .slice(-listSeenMax)
              .filter((id) => id !== gone && site.rows.includes(id));
            if (remembered.length === 0 || !site.rows.includes(gone)) continue;
            site.rows.splice(site.rows.indexOf(gone), 1);
          }
        }
      }
      // Every row comes back, in order. A call that starts over repeats rows, and may return new
      // rows from above.
      const firsts = [...new Set(returned.filter((id) => id.startsWith("r")))];
      expect({ pageSize, limit, firsts }).toEqual({ pageSize, limit, firsts: original });
    }
  });

  it("finds a last-of-its-segment row one insertion pushed into the next segment, with limit 1", async () => {
    const site = listSite(ids(1, 9), 3);
    const pages: string[] = [];
    let cursor: string | undefined;
    for (let calls = 0; calls < 3; calls++) {
      const page = await call(site, mechanism, 1, cursor);
      pages.push(...page.ids);
      cursor = page.cursor;
    }
    expect(pages).toEqual(ids(1, 3));
    site.rows.unshift("new");
    const next = await call(site, mechanism, 1, cursor);
    expect(next.ids).toEqual(["r4"]);
    expect(next.output.list_changed).toBe(true);
    const after = await call(site, mechanism, 1, next.cursor);
    expect(after.ids).toEqual(["r5"]);
    expect(after.output.list_changed).toBe(false);
  });

  it("reads past a burst of new rows larger than a segment and its remembered rows", async () => {
    const site = listSite(ids(1, 150), 30);
    const first = await call(site, mechanism, 20);
    site.rows.unshift(...Array.from({ length: 45 }, (_, index) => `n${index + 1}`));
    const next = await call(site, mechanism, 20, first.cursor);
    expect(next.ids).toEqual(ids(21, 40));
    expect(next.output.list_changed).toBe(true);
  });
});

describe("a call the run's time stops", () => {
  it("hands back its own position when it read no row past it, never ending the list", async () => {
    const site = listSite(ids(1, 60), 20);
    const first = await call(site, "append", 20);
    expect(first.ids).toEqual(ids(1, 20));
    // Time runs out right after the page opened, and the last returned row ends that segment.
    const short = await call(site, "append", 20, first.cursor, () => 1_000);
    expect(short.ids).toEqual([]);
    expect(short.output).toMatchObject({ has_more: true, next_cursor: expect.any(String) });
    expect(short.output.next_cursor_unavailable).toBeUndefined();
    const resumed = await call(site, "append", 20, short.cursor);
    expect(resumed.ids).toEqual(ids(21, 40));
  });

  it("ends the list with no_progress when the run's time stops it there twice in a row", async () => {
    const site = listSite(ids(1, 80), 20);
    const first = await call(site, "append", 20);
    const short = await call(site, "append", 20, first.cursor, () => 1_000);
    expect(short.output.next_cursor).toEqual(expect.any(String));
    // A call with time between two stops continues, and the next stop hands back a cursor again.
    const resumed = await call(site, "append", 20, short.cursor);
    expect(resumed.ids).toEqual(ids(21, 40));
    const stopped = await call(site, "append", 20, resumed.cursor, () => 1_000);
    expect(stopped.output.next_cursor).toEqual(expect.any(String));
    const again = await call(site, "append", 20, stopped.cursor, () => 1_000);
    expect(again.ids).toEqual([]);
    expect(again.output).toMatchObject({
      next_cursor: null,
      has_more: true,
      next_cursor_unavailable: "no_progress",
    });
  });
});

describe("a later page whose site shows no results after earlier pages returned some", () => {
  it("never ends the list: it hands back a cursor for the same page with a reason, once", async () => {
    // A directory search with 310 results. The first page returns 20, then the next call's
    // search shows no results and a total of 0, as a search that did not load would.
    const site = listSite(ids(1, 310), 20);
    const first = await call(site, "pages", 20);
    expect(first.ids).toEqual(ids(1, 20));
    expect(first.output).toMatchObject({ has_more: true, total_results: 310 });
    const results = site.rows.splice(0);
    const empty = await call(site, "pages", 20, first.cursor);
    expect(empty.ids).toEqual([]);
    expect(empty.output).toMatchObject({
      has_more: true,
      next_cursor: expect.any(String),
      total_results: 0,
    });
    expect(empty.output.next_cursor_unavailable).toBeUndefined();
    expect(empty.reason).toMatch(/no results on a later page after listing 20 before.*next_cursor/u);
    // The same search still shows nothing on the call after: the list ends without a cursor, its
    // has_more still true, so a caller paging until has_more is false still ends.
    const again = await call(site, "pages", 20, empty.cursor);
    expect(again.output).toMatchObject({
      next_cursor: null,
      has_more: true,
      next_cursor_unavailable: "no_progress",
    });
    // A first page with no cursor that shows no results is the list's end, as before.
    expect((await call(site, "pages", 20)).output).toMatchObject({
      next_cursor: null,
      has_more: false,
    });
    // The search loads again: the cursor continues where the first page stopped.
    site.rows.push(...results);
    const resumed = await call(site, "pages", 20, empty.cursor);
    expect(resumed.ids).toEqual(ids(21, 40));
  });
});

describe.each<ListMechanism>(["pages", "next_link", "api"])(
  "a %s list whose rows above the last returned one are removed",
  (mechanism) => {
    it("finds the last returned row the removals pulled back into the previous segment", async () => {
      const site = listSite(ids(1, 30), 10);
      const first = await call(site, mechanism, 11);
      expect(first.ids).toEqual(ids(1, 11));
      site.rows.splice(site.rows.indexOf("r2"), 1);
      site.rows.splice(site.rows.indexOf("r3"), 1);
      const next = await call(site, mechanism, 11, first.cursor);
      expect(next.ids).toEqual(ids(12, 22));
      expect(next.output.list_changed).toBe(true);
    });

    it("reads to the end when every row before the last returned one is gone", async () => {
      const site = listSite(ids(1, 20), 10);
      const first = await call(site, mechanism, 11);
      site.rows.splice(0, 10);
      const next = await call(site, mechanism, 11, first.cursor);
      expect(next.ids).toEqual(ids(12, 20));
      expect(next.output).toMatchObject({ list_changed: true, has_more: false });
    });

    it("starts over from the list's first segment after removals of more than a segment's rows", async () => {
      const site = listSite(ids(1, 60), 5);
      const first = await call(site, mechanism, 15);
      expect(first.ids).toEqual(ids(1, 15));
      // The last returned row moves from the third segment to the first.
      site.rows.splice(site.rows.indexOf("r2"), 12);
      const next = await call(site, mechanism, 15, first.cursor);
      expect(next.ids).toEqual(ids(16, 22));
      expect(next.output.list_changed).toBe(true);
      const later: string[] = [];
      let cursor = next.cursor;
      while (cursor !== undefined) {
        const page = await call(site, mechanism, 15, cursor);
        later.push(...page.ids);
        cursor = page.cursor;
      }
      expect(later).toEqual(ids(23, 60));
    });

    it("starts over from the list's first row in one call after a burst further on than it looks", async () => {
      const site = listSite(ids(1, 100), 10);
      const first = await call(site, mechanism, 20);
      const burst = Array.from({ length: 50 }, (_, index) => `n${index + 1}`);
      site.rows.unshift(...burst);
      const next = await call(site, mechanism, 20, first.cursor);
      expect(next.ids).toEqual(burst.slice(0, 20));
      expect(next.output.list_changed).toBe(true);
    });

    it("never steps back further than a call can read, and says the list changed on every page after starting over", async () => {
      const site = listSite(ids(1, 600), 20);
      let cursor: string | undefined;
      for (let calls = 0; calls < 5; calls++)
        cursor = (await call(site, mechanism, 50, cursor)).cursor;
      // The last returned row, r250, moves from site page 13 to page 12, which only a replay of
      // twelve pages reaches.
      site.rows.splice(site.rows.indexOf("r100"), 12);
      site.opened.length = 0;
      site.loads.count = 0;
      const next = await call(site, mechanism, 50, cursor);
      expect(site.loads.count).toBeLessThanOrEqual(listCallBounds.sitePages);
      expect(site.opened).toEqual([13, 1]);
      // It started over from the list's first row.
      expect(next.ids.slice(0, 3)).toEqual(ids(1, 3));
      const returned = [...next.ids];
      const changed = [next.output.list_changed];
      cursor = next.cursor;
      while (cursor !== undefined) {
        const page = await call(site, mechanism, 50, cursor);
        returned.push(...page.ids);
        changed.push(page.output.list_changed);
        cursor = page.cursor;
      }
      expect(changed.every((value) => value)).toBe(true);
      expect(returned.filter((id) => !ids(1, 250).includes(id))).toEqual(ids(251, 600));
    });
  },
);

describe("a site link with only list parameters", () => {
  it("stays in the cursor, so the next call opens it", async () => {
    const site = listSite(ids(1, 95), 30);
    const link = `${origin}/s?q=lamps&session=fall&page=1`;
    const reader = site.readers.pages;
    const opened: (string | undefined)[] = [];
    const withLink: ListReader<Row, SiteSegment> = {
      ...reader,
      open: async (position, count) => {
        opened.push(position?.href);
        return { ...(await reader.open(position, count)), href: link };
      },
    };
    const linkSite = { ...site, readers: { ...site.readers, pages: withLink } };
    const first = await call(linkSite, "pages", 20);
    await call(linkSite, "pages", 20, first.cursor);
    expect(opened).toEqual([undefined, link]);
  });
});

describe("a list that shows sponsored copies of its own rows", () => {
  interface Card {
    readonly id: string;
    readonly sponsored: boolean;
  }
  /** Site pages of cards keyed by the item's own ID; `*` marks a sponsored card. */
  const sponsoredSite = (pages: readonly (readonly string[])[]) => {
    const card = (text: string): Card => ({ id: text.replace(/^\*/u, ""), sponsored: text.startsWith("*") });
    const sitePage = (page: number, count: number) => {
      checkCount(count);
      const all = pages[page - 1] ?? [];
      return {
        at: page,
        rows: all.slice(0, count).map(card),
        more: all.length > count,
        hasNext: page < pages.length,
        href: `${origin}/s?q=lamps&page=${page}`,
      };
    };
    const reader: ListReader<Card, ListSegment<Card> & { readonly at: number }> = {
      keyOf: (row) => row.id,
      promoted: (row) => row.sponsored,
      open: async (position, count) =>
        sitePage(position?.href === undefined ? (position?.page ?? 1) : Number(new URL(position.href).searchParams.get("page")), count),
      more: async (segment, count) => sitePage(segment.at, count),
      next: async (segment, count) => sitePage(segment.at + 1, count),
    };
    return async (limit: number, cursor?: string) => {
      const input = { query: "lamps", limit, ...(cursor === undefined ? {} : { cursor }) };
      const admitted = admitListCursor(input, scope);
      if (!admitted.ok) throw new Error(`refused: ${admitted.reason}`);
      const list = startList(withListHost(input, admitted.list), { mechanism: "pages" });
      const page = await readList(list, reader);
      const sealed = sealListOutput({ rows: page.rows, ...page.output }, input, scope).output as {
        readonly next_cursor: string | null;
      };
      return {
        cards: page.rows.map((row) => (row.sponsored ? `*${row.id}` : row.id)),
        output: page.output,
        cursor: sealed.next_cursor ?? undefined,
      };
    };
  };

  it("returns each item once at its organic place, keeps a promoted-only row, and never calls a repeated copy a change", async () => {
    const call = sponsoredSite([
      ["*r7", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9"],
      ["*r3", "r10", "r11", "*p1", "r12", "r13", "r14", "*r25", "r15", "r16"],
      ["*p1", "r17", "r18", "r19", "r20", "r21", "r22", "r23", "r24", "r25"],
    ]);
    const first = await call(10);
    expect(first.cards).toEqual(ids(1, 10));
    // A sponsored copy of a row page one returned, a promoted-only row, and a copy whose organic
    // row this call does not read, which stays in place.
    const second = await call(10, first.cursor);
    expect(second.cards).toEqual(["r11", "*p1", "r12", "r13", "r14", "*r25", ...ids(15, 18)]);
    // The promoted-only row shown again on the next site page, and the organic row of the copy.
    const third = await call(10, second.cursor);
    expect(third.cards).toEqual(ids(19, 25));
    for (const page of [first, second, third]) expect(page.output.list_changed).toBe(false);
    expect(third.output.has_more).toBe(false);
  });

  it("continues after a sponsored copy that ended the previous page, without calling it a change", async () => {
    const call = sponsoredSite([["r1", "r2", "*r9", "r3", "r9", "r4", "r5", "r6"]]);
    const first = await call(3);
    expect(first.cards).toEqual(["r1", "r2", "*r9"]);
    const second = await call(3, first.cursor);
    expect(second.cards).toEqual(["r3", "r9", "r4"]);
    for (const page of [first, second]) expect(page.output.list_changed).toBe(false);
  });

  it("returns an item's organic row on a later page after its sponsored copy, without calling it a change", async () => {
    const call = sponsoredSite([
      ["*r8", "r1", "r2", "r3", "r4", "r5", "r6", "r7"],
      ["r8", "r9", "r10"],
    ]);
    const first = await call(5);
    expect(first.cards).toEqual(["*r8", ...ids(1, 4)]);
    const second = await call(5, first.cursor);
    expect(second.cards).toEqual(ids(5, 9));
    for (const page of [first, second]) expect(page.output.list_changed).toBe(false);
  });
});
