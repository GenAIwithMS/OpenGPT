import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { test, expect } from "@playwright/test";
import type { ModelProvider } from "@openai/agents";
import { Effect } from "effect";
import { createBrowserEngine } from "../../src/standalone/engine.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { listCursorTtlMs } from "../../src/runtime/list-page.js";
import { RunOutcomeFailure } from "../../src/standalone/run-report.js";

// A list tool paged through the local host: each call is a fresh run, the host signs the cursor
// each page returns and checks it before the next run touches the site. The tool is the
// pagination skill's own reference, run against a fixture site whose list changes between calls.

const unreachableModel: ModelProvider = {
  getModel: () => {
    throw new Error("A run makes no model request");
  },
};

/** The reference tool as a saved artifact's module, importing the seeded runtime. */
const referenceTool = async () =>
  stripTypeScriptTypes(
    await readFile("typescript/authoring/examples/pagination.ts", "utf8"),
  ).replace('"../../src/browser/index.js"', '"../runtime/index.js"');

/**
 * A tool that writes its own next cursor, which the host never signs and would refuse if a caller
 * sent it back.
 */
const ownCursorTool = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({
  name: "own_cursor",
  input: Schema.Struct({}),
  output: Schema.Struct({ next_cursor: Schema.NullOr(Schema.String), has_more: Schema.Boolean }),
}, async () => ({ next_cursor: "page=2", has_more: true }));`;

/**
 * A listing site that pages `pageSize` rows at a time behind a search form, with a Next link. Its
 * `listings` are the rows in the site's order; a test changes them between calls.
 */
const startListings = async (
  listings = ["L1", "L2", "L3", "L4", "L5", "L6", "L7"],
  pageSize = 3,
) => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    const url = new URL(request.url ?? "/", "http://fixture.test");
    const query = url.searchParams.get("q") ?? "";
    const page = Number(url.searchParams.get("page") ?? "1");
    const from = (page - 1) * pageSize;
    const rows = url.pathname === "/search" ? listings.slice(from, page * pageSize) : [];
    const more = url.pathname === "/search" && page * pageSize < listings.length;
    response.setHeader("Content-Type", "text/html");
    response.end(`<form action="/search"><input id="q" name="q" value="${query}">
<button id="go">Search</button></form>
${
  url.pathname !== "/search"
    ? ""
    : rows.length === 0
      ? `<p id="no-results">No listings</p>`
      : `<p id="count">${from + 1}-${from + rows.length} of ${listings.length}</p>
<ol id="results">${rows.map((id) => `<li data-id="${id}"><span class="title">Lamp ${id}</span></li>`).join("")}</ol>
${more ? `<a rel="next" href="/search?q=${encodeURIComponent(query)}&page=${page + 1}">Next</a>` : ""}`
}`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture address");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    listings,
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
};

interface Page {
  readonly results: readonly { readonly id: string }[];
  readonly next_cursor: string | null;
  readonly next_cursor_expires_at: string | null;
  readonly has_more: boolean;
  readonly total_results: number | null;
  readonly list_changed: boolean;
}

test("a list pages by signed cursors across changes and refuses a stale cursor before the site", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Ten runs of paged tools on a fixture site, each in a fresh run",
  });
  test.setTimeout(60_000);
  const site = await startListings();
  let now = Date.UTC(2026, 0, 5, 12);
  const source = await referenceTool();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createBrowserEngine({
            ask: makeInputAsker(() => Effect.succeed({})),
            minterProvider: unreachableModel,
            guardianProvider: unreachableModel,
            timeoutMs: 20_000,
            listCursors: { now: () => now },
          });
          const runTool = (content: string, input: Record<string, unknown>) =>
            service.run(
              {
                entrypoint: "src/tool.mjs",
                files: [{ path: "src/tool.mjs", content }],
                inputSchema: {},
                outputSchema: {},
              },
              { url: site.url, intent: "Search the listings", effect: "read", input },
            );
          const run = (input: Record<string, unknown>) =>
            runTool(source, input).pipe(Effect.map((output) => output as Page));
          const ids = (page: Page) => page.results.map((row) => row.id);

          const first = yield* run({ query: "lamps", limit: 2 });
          expect(first).toMatchObject({
            has_more: true,
            total_results: 7,
            list_changed: false,
            next_cursor: expect.stringMatching(/^pc1\./u),
            next_cursor_expires_at: new Date(now + listCursorTtlMs).toISOString(),
          });
          expect(ids(first)).toEqual(["L1", "L2"]);

          // Page two finishes site page one and reads into site page two.
          const second = yield* run({ query: "lamps", limit: 2, cursor: first.next_cursor });
          expect(ids(second)).toEqual(["L3", "L4"]);
          expect(second.list_changed).toBe(false);

          // A listing added above the last returned row repeats nothing and skips nothing; the
          // caller never gets it, so the list says it changed.
          site.listings.unshift("N0");
          const third = yield* run({ query: "lamps", limit: 2, cursor: second.next_cursor });
          expect(ids(third)).toEqual(["L5", "L6"]);
          expect(third.list_changed).toBe(true);

          // The last returned row is gone: the list says it changed, and the last page has no cursor.
          site.listings.splice(site.listings.indexOf("L6"), 1);
          const last = yield* run({ query: "lamps", limit: 2, cursor: third.next_cursor });
          expect(last).toMatchObject({ list_changed: true, next_cursor: null, has_more: false });
          expect(ids(last)).toEqual(["L7"]);

          // Page one ends at a site page's end; a listing removed above that boundary moves the
          // next site page's first row back across it, and page two still returns it.
          site.listings.splice(0, site.listings.length, "L1", "L2", "L3", "L4", "L5", "L6", "L7");
          const boundary = yield* run({ query: "lamps", limit: 3 });
          expect(ids(boundary)).toEqual(["L1", "L2", "L3"]);
          site.listings.splice(site.listings.indexOf("L1"), 1);
          const across = yield* run({ query: "lamps", limit: 3, cursor: boundary.next_cursor });
          expect(ids(across)).toEqual(["L4", "L5", "L6"]);

          // A tool's own next cursor never reaches the caller: the host would refuse it.
          expect(yield* runTool(ownCursorTool, {})).toEqual({
            next_cursor: null,
            next_cursor_expires_at: null,
            has_more: true,
            next_cursor_unavailable: "not_a_draft",
          });

          // A cursor past its ten minutes, one sent with other inputs, a position written by hand,
          // or a cursor in a form the host never signs ends the run before the site.
          const before = site.requests();
          now += listCursorTtlMs;
          const expired = yield* Effect.flip(
            run({ query: "lamps", limit: 2, cursor: second.next_cursor }),
          );
          now -= listCursorTtlMs;
          const otherInputs = yield* Effect.flip(
            run({ query: "desks", limit: 2, cursor: second.next_cursor }),
          );
          const handWritten = yield* Effect.flip(
            run({
              query: "lamps",
              limit: 2,
              cursor: `pcd1.${Buffer.from(
                JSON.stringify({
                  m: "pages",
                  pos: { page: 2, offset: 0, href: "http://169.254.169.254/latest/" },
                  n: 2,
                  s: [],
                }),
              ).toString("base64url")}`,
            }),
          );
          const unsigned = yield* Effect.flip(run({ query: "lamps", limit: 2, cursor: "page=2" }));
          for (const [failure, kind] of [
            [expired, "expired"],
            [otherInputs, "inputs_changed"],
            [handWritten, "malformed"],
            [unsigned, "malformed"],
          ] as const) {
            expect(failure).toBeInstanceOf(RunOutcomeFailure);
            expect(failure).toMatchObject({
              outcome: {
                code: "input_rejected",
                details: { field: "cursor", kind },
              },
            });
          }
          expect(site.requests()).toBe(before);
        }),
      ),
    );
  } finally {
    await site.close();
  }
});

test("a list whose call size differs from the site's page size returns exact windows across site pages", async () => {
  test.info().annotations.push({
    type: "slow",
    description:
      "Twelve runs of the reference tool on a fixture site with 30 rows per page, each in a fresh run",
  });
  test.setTimeout(150_000);
  const ids = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, index) => `L${from + index}`);
  const site = await startListings(ids(1, 95), 30);
  const issued = Date.UTC(2026, 0, 5, 12);
  let now = issued;
  const source = await referenceTool();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createBrowserEngine({
            ask: makeInputAsker(() => Effect.succeed({})),
            minterProvider: unreachableModel,
            guardianProvider: unreachableModel,
            timeoutMs: 20_000,
            listCursors: { now: () => now },
          });
          const run = (input: Record<string, unknown>) =>
            service
              .run(
                {
                  entrypoint: "src/tool.mjs",
                  files: [{ path: "src/tool.mjs", content: source }],
                  inputSchema: {},
                  outputSchema: {},
                },
                { url: site.url, intent: "Search the listings", effect: "read", input },
              )
              .pipe(Effect.map((output) => output as Page));
          const idsOf = (page: Page) => page.results.map((row) => row.id);

          // Twenty at a time over thirty per site page: page two finishes site page one and
          // starts site page two, and page three finishes site page two.
          const first = yield* run({ query: "lamps", limit: 20 });
          expect(idsOf(first)).toEqual(ids(1, 20));
          expect(first).toMatchObject({
            has_more: true,
            total_results: 95,
            list_changed: false,
            next_cursor_expires_at: new Date(issued + 10 * 60 * 1_000).toISOString(),
          });
          const second = yield* run({ query: "lamps", limit: 20, cursor: first.next_cursor });
          expect(idsOf(second)).toEqual(ids(21, 40));
          const third = yield* run({ query: "lamps", limit: 20, cursor: second.next_cursor });
          expect(idsOf(third)).toEqual(ids(41, 60));
          expect([second.list_changed, third.list_changed]).toEqual([false, false]);

          // Fifty at a time: one call spans two site pages, and the last ends on a short page.
          const wide = yield* run({ query: "lamps", limit: 50 });
          expect(idsOf(wide)).toEqual(ids(1, 50));
          const rest = yield* run({ query: "lamps", limit: 50, cursor: wide.next_cursor });
          expect(idsOf(rest)).toEqual(ids(51, 95));
          expect(rest).toMatchObject({ next_cursor: null, has_more: false });

          // A row inserted above the last returned row pushes the window down its site page:
          // the call reads on in the same page and still returns exactly its limit. The caller
          // never gets the inserted row, so the list says it changed.
          site.listings.unshift("N0");
          const inserted = yield* run({ query: "lamps", limit: 5, cursor: first.next_cursor });
          expect(idsOf(inserted)).toEqual(ids(21, 25));
          expect(inserted.list_changed).toBe(true);
          // A row the caller got removed above it: no gap, no repeat, and the list changed.
          site.listings.splice(site.listings.indexOf("L3"), 1);
          const removed = yield* run({ query: "lamps", limit: 20, cursor: inserted.next_cursor });
          expect(idsOf(removed)).toEqual(ids(26, 45));
          expect(removed.list_changed).toBe(true);
          // The last returned row removed: nothing skipped, and the list says it changed.
          site.listings.splice(site.listings.indexOf("L45"), 1);
          const changed = yield* run({ query: "lamps", limit: 20, cursor: removed.next_cursor });
          expect(idsOf(changed)).toEqual(ids(46, 65));
          expect(changed.list_changed).toBe(true);
          // A burst of new rows on top pushes the last returned row, and every row the cursor
          // remembers, past the site page it was on: the call reads on to find it, and returns
          // the next twenty rather than rows it returned before.
          site.listings.unshift(...Array.from({ length: 45 }, (_, index) => `B${index + 1}`));
          const burst = yield* run({ query: "lamps", limit: 20, cursor: changed.next_cursor });
          expect(idsOf(burst)).toEqual(ids(66, 85));
          expect(burst.list_changed).toBe(true);

          // Ten minutes and a millisecond after it was returned, a cursor ends the run before
          // the site.
          const before = site.requests();
          now = issued + 10 * 60 * 1_000 + 1;
          const expired = yield* Effect.flip(
            run({ query: "lamps", limit: 20, cursor: first.next_cursor }),
          );
          expect(expired).toBeInstanceOf(RunOutcomeFailure);
          expect(expired).toMatchObject({
            outcome: { code: "input_rejected", details: { field: "cursor", kind: "expired" } },
          });
          expect(site.requests()).toBe(before);
        }),
      ),
    );
  } finally {
    await site.close();
  }
});
