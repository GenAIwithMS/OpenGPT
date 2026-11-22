import { createHmac } from "node:crypto";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { describe, expect, it } from "vitest";
import { runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import {
  admitListCursor,
  listCursorKeys,
  sealListOutput,
  type ListCursorKeys,
  type ListCursorScope,
} from "../../src/runtime/list-cursor.js";
import { ExecutionContext, makeEffectJournal } from "../../src/runtime/context.js";
import { Deadline } from "../../src/runtime/deadline.js";
import { defineOperation, executeOperation } from "../../src/runtime/operation.js";
import { operationErrors } from "../../src/runtime/operation-failure.js";
import {
  finishList,
  listCursorMaxLength,
  listCursorTtlMs,
  listInputFields,
  listOutputFields,
  listSeenMax,
  selectRows,
  startList,
  withListHost,
  type ListHost,
  type ListMechanism,
  type ListPosition,
} from "../../src/runtime/list-page.js";
import { runOutcomeFailure } from "../../src/standalone/run-report.js";

// The cursor's arithmetic and its checks, as a host and a script see them. The whole path, from a
// served run's output to the next run's refusal, is in tests/browser/standalone-list-pages.spec.ts.

const key = (id: string, byte: number) => ({ id, secret: new Uint8Array(32).fill(byte) });
const keys: ListCursorKeys = listCursorKeys({ current: key("k1", 1) });
const issuedAt = Date.UTC(2026, 0, 5, 12);
const scope = (overrides: Partial<ListCursorScope> = {}): ListCursorScope => ({
  keys,
  operation: "tool-1",
  siteOrigin: "https://www.example.test",
  now: issuedAt,
  ...overrides,
});
const input = { query: "lamps", limit: 2 };
type Row = { readonly id: string; readonly sponsored?: boolean };
const keyOf = (row: Row) => row.id;
const promoted = (row: Row) => row.sponsored === true;
const rows = (...ids: readonly string[]): Row[] => ids.map((id) => ({ id }));
/** A run's input as a host that signs cursors hands it to the script. */
const hosted = (value: object, host: ListHost = {}) => withListHost(value, host);

/** Page one of a list, sealed by the host: the cursor a caller gets back. */
const pageOne = (
  next: ListPosition | null = { page: 1, offset: 2, href: "https://www.example.test/s?q=lamps" },
  mechanism: ListMechanism = "pages",
  at: ListCursorScope = scope(),
) => {
  const list = startList(hosted(input), { mechanism });
  const returned = rows("a", "b");
  const fields = finishList(list, {
    rows: returned,
    keyOf,
    next,
    hasMore: true,
    totalResults: 5,
    listChanged: false,
  });
  return sealListOutput({ results: returned, ...fields }, input, at);
};
const cursorOf = (sealed: { readonly output: unknown }) =>
  String(Reflect.get(sealed.output as object, "next_cursor"));
/** The list a later page starts from, once the host admitted its cursor. */
const continuing = (cursor: string, mechanism: ListMechanism = "pages", at = scope()) => {
  const value = { ...input, cursor };
  const admitted = admitListCursor(value, at);
  if (!admitted.ok) throw new Error(`refused: ${admitted.reason}`);
  return startList(hosted(value, admitted.list), { mechanism });
};

describe("a sealed cursor", () => {
  it("signs page one's position and says when it expires", () => {
    const sealed = pageOne();
    expect(sealed.dropped).toBeUndefined();
    expect(sealed.output).toMatchObject({
      next_cursor: expect.stringMatching(/^pc1\.k1\./u),
      next_cursor_expires_at: new Date(issuedAt + listCursorTtlMs).toISOString(),
      has_more: true,
      total_results: 5,
      list_changed: false,
    });
  });

  it("gives the next run the position, where limit may change", () => {
    const cursor = cursorOf(pageOne());
    const value = { ...input, limit: 3, cursor };
    const admitted = admitListCursor(value, scope());
    if (!admitted.ok) throw new Error("refused");
    expect(startList(hosted(value, admitted.list), { mechanism: "pages" })).toMatchObject({
      limit: 3,
      returned: 2,
      position: { page: 1, offset: 2, href: "https://www.example.test/s?q=lamps" },
    });
  });

  it.each([
    ["altered", (cursor: string) => cursor.replace(/(\.[A-Za-z0-9_-]{8})/u, "$1X"), scope()],
    ["other_tool", (cursor: string) => cursor, scope({ operation: "tool-2" })],
    ["expired", (cursor: string) => cursor, scope({ now: issuedAt + listCursorTtlMs })],
    ["off_site", (cursor: string) => cursor, scope({ siteOrigin: "https://other.test" })],
    ["other_account", (cursor: string) => cursor, scope({ subject: "account-b" })],
    ["unknown_key", (cursor: string) => cursor, scope({ keys: { current: key("k9", 9) } })],
    ["version", (cursor: string) => cursor.replace(/^pc1\./u, "pc2."), scope()],
    ["malformed", (cursor: string) => `${cursor}.extra`, scope()],
  ] as const)("refuses a cursor that is %s", (reason, change, at) => {
    const cursor = change(cursorOf(pageOne(undefined, undefined, scope({ subject: "account-a" }))));
    const checked = at.subject === undefined ? { ...at, subject: "account-a" } : at;
    expect(admitListCursor({ ...input, cursor }, checked)).toMatchObject({
      ok: false,
      reason,
      message: expect.stringContaining("Call again without cursor"),
    });
  });

  it("works for ten minutes after the call that returned it, and not a millisecond longer", () => {
    const cursor = cursorOf(pageOne());
    const tenMinutes = 10 * 60 * 1_000;
    expect(pageOne().output).toMatchObject({
      next_cursor_expires_at: new Date(issuedAt + tenMinutes).toISOString(),
    });
    expect(
      admitListCursor({ ...input, cursor }, scope({ now: issuedAt + tenMinutes - 1 })),
    ).toMatchObject({ ok: true });
    expect(
      admitListCursor({ ...input, cursor }, scope({ now: issuedAt + tenMinutes + 1 })),
    ).toMatchObject({ ok: false, reason: "expired" });
  });

  it("refuses a cursor an older host signed for longer, once ten minutes have passed", () => {
    // Re-sign a cursor as a host with a longer lifetime would have: same key, an hour's expiry.
    const sealed = cursorOf(pageOne());
    const [prefix, keyId, body] = sealed.split(".");
    const payload = JSON.parse(Buffer.from(body ?? "", "base64url").toString("utf8")) as {
      iat: number;
      exp: number;
    };
    const longer = Buffer.from(JSON.stringify({ ...payload, exp: payload.iat + 3_600 })).toString(
      "base64url",
    );
    const signed = `${prefix}.${keyId}.${longer}`;
    const cursor = `${signed}.${createHmac("sha256", new Uint8Array(32).fill(1)).update(signed).digest("base64url")}`;
    const tenMinutes = 10 * 60 * 1_000;
    expect(
      admitListCursor({ ...input, cursor }, scope({ now: issuedAt + tenMinutes - 1 })),
    ).toMatchObject({ ok: true });
    expect(
      admitListCursor({ ...input, cursor }, scope({ now: issuedAt + 30 * 60 * 1_000 })),
    ).toMatchObject({ ok: false, reason: "expired" });
  });

  it("refuses a cursor sent with other inputs", () => {
    const cursor = cursorOf(pageOne());
    expect(admitListCursor({ query: "desks", cursor }, scope())).toMatchObject({
      ok: false,
      reason: "inputs_changed",
    });
  });

  it("keeps verifying under a rotated key until the old key is dropped", () => {
    const cursor = cursorOf(pageOne());
    const rotated = listCursorKeys({ current: key("k2", 2), previous: [key("k1", 1)] });
    expect(admitListCursor({ ...input, cursor }, scope({ keys: rotated }))).toMatchObject({
      ok: true,
    });
    expect(
      admitListCursor({ ...input, cursor }, scope({ keys: { current: key("k2", 2) } })),
    ).toMatchObject({ ok: false, reason: "unknown_key" });
  });

  it("drops a next position off the tool's site, and says why", () => {
    expect(pageOne({ page: 2, offset: 0, href: "https://elsewhere.test/s?page=2" })).toMatchObject({
      dropped: "off_site",
      output: {
        next_cursor: null,
        next_cursor_expires_at: null,
        has_more: true,
        next_cursor_unavailable: "off_site",
      },
    });
  });

  it("treats an empty cursor as none", () => {
    for (const value of [input, { ...input, cursor: "" }, { ...input, cursor: null }])
      expect(admitListCursor(value, scope())).toEqual({ ok: true, list: {} });
    expect(startList(hosted({ ...input, cursor: "" }), { mechanism: "pages" }).position).toBe(
      undefined,
    );
  });
});

it("keeps the host's channel out of anything that walks a run's input", () => {
  const value = withListHost({ check_in: "2026-03-01" }, {});
  expect(new URLSearchParams(value).toString()).toBe("check_in=2026-03-01");
  expect(JSON.stringify(value)).toBe('{"check_in":"2026-03-01"}');
  expect(startList(value, { mechanism: "pages" }).signed).toBe(true);
});

describe("a cursor the host did not sign", () => {
  // Tools never make or read a cursor of their own: the host refuses every cursor it did not sign
  // before the run starts, and a runtime draft sent in as a cursor too.
  it("is refused as malformed, whatever its form", () => {
    for (const cursor of [
      "page=2",
      "abc",
      " ",
      "pc1",
      "pc1.k1",
      "pc.k1.body.signature",
      "x.k1.body.signature",
      "PC1.k1.body.signature",
      "pcd1",
      2,
      true,
      { page: 2 },
      ["page=2"],
    ])
      expect(admitListCursor({ ...input, cursor }, scope())).toMatchObject({
        ok: false,
        reason: "malformed",
      });
  });

  it("never reaches the caller as a tool's next cursor, which the host would refuse", () => {
    const legacy = { query: "lamps" };
    const more = { results: [], next_cursor: "page=3", has_more: true };
    expect(sealListOutput(more, legacy, scope())).toEqual({
      output: {
        results: [],
        next_cursor: null,
        next_cursor_expires_at: null,
        has_more: true,
        next_cursor_unavailable: "not_a_draft",
      },
      dropped: "not_a_draft",
    });
    // A tool that says the list has no more keeps saying so, with no reason for a missing cursor.
    const ended = { results: [], next_cursor: "page=3", has_more: false };
    expect(sealListOutput(ended, legacy, scope())).toEqual({
      output: { results: [], next_cursor: null, next_cursor_expires_at: null, has_more: false },
      dropped: "not_a_draft",
    });
    // A next cursor of another type is no runtime draft either, and an output without has_more
    // counts as having more.
    for (const next of [3, { page: 3 }])
      expect(sealListOutput({ results: [], next_cursor: next }, legacy, scope())).toEqual({
        output: {
          results: [],
          next_cursor: null,
          next_cursor_expires_at: null,
          has_more: true,
          next_cursor_unavailable: "not_a_draft",
        },
        dropped: "not_a_draft",
      });
    const none = { results: [], next_cursor: null, has_more: false };
    expect(sealListOutput(none, legacy, scope())).toEqual({ output: none });
    const absent = { results: [] };
    expect(sealListOutput(absent, legacy, scope())).toEqual({ output: absent });
  });

  it("names another host version for a cursor in another version's form", () => {
    expect(admitListCursor({ ...input, cursor: "pc2.k1.body.signature" }, scope())).toMatchObject({
      ok: false,
      reason: "version",
    });
  });

  it("refuses a runtime draft sent in as a cursor", () => {
    const draft = finishList(startList(hosted(input), { mechanism: "pages" }), {
      rows: rows("a"),
      keyOf,
      next: { page: 2, offset: 0, href: "https://www.example.test/s?page=2" },
      hasMore: true,
      totalResults: null,
      listChanged: false,
    }).next_cursor;
    expect(draft).toMatch(/^pcd1\./u);
    expect(admitListCursor({ ...input, cursor: draft }, scope())).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });

  it("is refused by the runtime's list, which reads only the position a host checked", () => {
    expect(() =>
      startList(hosted({ ...input, cursor: "page=2" }), { mechanism: "pages" }),
    ).toThrow(expect.objectContaining({ name: "InvalidInput", field: "cursor", kind: "malformed" }));
  });
});

describe("an Effect operation's list", () => {
  // An HTTP version is an Effect operation: its list's refusal reaches the host as the typed
  // refusal, as a Kernel script's does, never as a defect.
  const listTool = (mechanism: ListMechanism) =>
    defineOperation({
      name: "search_lamps",
      input: Schema.Struct({ query: Schema.String, ...listInputFields }),
      output: Schema.Struct({ results: Schema.Array(Schema.String), ...listOutputFields }),
      run: (value) =>
        Effect.gen(function* () {
          const list = startList(value, { mechanism });
          const page = finishList(list, {
            rows: [],
            keyOf: String,
            next: null,
            hasMore: false,
            totalResults: null,
            listChanged: false,
          });
          return { results: [], ...page };
        }),
    });
  const execute = (mechanism: ListMechanism, value: object, list: ListHost) =>
    Effect.runPromiseExit(
      Effect.gen(function* () {
        const journal = yield* makeEffectJournal;
        return yield* Effect.scoped(executeOperation(listTool(mechanism), value, { list })).pipe(
          Effect.provideService(ExecutionContext, {
            deadline: Deadline.after(),
            journal,
            events: { emit: () => Effect.void },
            capture: { start: Effect.void, finish: Effect.void },
          }),
        );
      }),
    );
  const failureOf = (exit: Exit.Exit<unknown, unknown>) => {
    if (!Exit.isFailure(exit)) throw new Error("the run succeeded");
    const failure = Cause.failureOption(exit.cause);
    if (Option.isNone(failure)) throw new Error(`not a typed failure: ${Cause.pretty(exit.cause)}`);
    return failure.value;
  };

  it("fails with the typed refusal for a cursor from before the tool paged another way", async () => {
    const value = { ...input, cursor: cursorOf(pageOne()) };
    const admitted = admitListCursor(value, scope());
    if (!admitted.ok) throw new Error(`refused: ${admitted.reason}`);
    const failure = failureOf(await execute("append", value, admitted.list));
    expect(failure).toBeInstanceOf(operationErrors.InvalidInput);
    expect(failure).toMatchObject({
      field: "cursor",
      kind: "mechanism_changed",
      message: expect.stringContaining("This tool now pages the site another way"),
    });
  });

  it("fails with the typed refusal for a cursor its host did not check", async () => {
    const failure = failureOf(await execute("pages", { ...input, cursor: "page=2" }, {}));
    expect(failure).toBeInstanceOf(operationErrors.InvalidInput);
    expect(failure).toMatchObject({ field: "cursor", kind: "malformed" });
  });
});

describe("a host that does not sign cursors", () => {
  const referenceTool = async () =>
    stripTypeScriptTypes(await readFile("typescript/authoring/examples/pagination.ts", "utf8"))
      .replace('"../../src/browser/index.js"', '"../../runtime/index.js"');
  const entrypoint = "operation/src/tool.mjs";

  it("refuses a hand-written draft before the script touches the site", async () => {
    const forged = `pcd1.${Buffer.from(
      JSON.stringify({
        m: "pages",
        pos: { page: 2, offset: 0, href: "http://169.254.169.254/latest/" },
        n: 1,
        s: [],
      }),
    ).toString("base64url")}`;
    let browserCalls = 0;
    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workspace = yield* createLocalWorkspace();
          return yield* runLocalOperation({
            workspace,
            entrypoint,
            sources: [[entrypoint, yield* Effect.promise(referenceTool)]],
            input: { query: "lamps", cursor: forged },
            browser: {
              sessionId: "local",
              executeResponse: () => {
                browserCalls++;
                return Effect.succeed({ success: true, result: null });
              },
            },
          }).pipe(Effect.flip, Effect.map(runOutcomeFailure("read", "operation")));
        }),
      ),
    );
    expect(failure.outcome).toMatchObject({
      code: "input_rejected",
      details: { field: "cursor", kind: "malformed" },
    });
    expect(browserCalls).toBe(0);
  });

  it("returns no cursor it cannot sign, and says why", () => {
    const fields = finishList(startList(input, { mechanism: "pages" }), {
      rows: rows("a"),
      keyOf,
      next: { page: 2, offset: 0, href: "https://www.example.test/s?page=2" },
      hasMore: true,
      totalResults: null,
      listChanged: false,
    });
    expect(fields).toMatchObject({
      next_cursor: null,
      has_more: true,
      next_cursor_unavailable: "unsigned_host",
    });
  });
});

describe("the rows a later page returns", () => {
  const continued = (sitePage: readonly Row[]) =>
    selectRows(continuing(cursorOf(pageOne())), sitePage, keyOf);

  it("continue after the last returned row, wherever rows were inserted above it", () => {
    expect(continued(rows("a", "b", "c", "d"))).toEqual({
      rows: rows("c", "d"),
      listChanged: false,
    });
    // The caller never gets the inserted row, so the list says it changed.
    expect(continued(rows("new", "a", "b", "c"))).toEqual({ rows: rows("c"), listChanged: true });
  });

  it("say the list changed for a row removed above the last returned one, within its page or across", () => {
    // Page one returned a and b, which end at offset 2 of their site page.
    const cursor = cursorOf(pageOne({ page: 1, offset: 2, href: "https://www.example.test/s?q=lamps" }));
    // A row above them removed: b moves up within the page.
    expect(selectRows(continuing(cursor), rows("b", "c", "d"), keyOf)).toEqual({
      rows: rows("c", "d"),
      listChanged: true,
    });
    // Enough removed that b moves back to the page before: the page starts after it.
    expect(selectRows(continuing(cursor), rows("c", "d"), keyOf)).toEqual({
      rows: rows("c", "d"),
      listChanged: true,
    });
  });

  it("continue after the last returned row still there, and say so, when the anchor is gone", () => {
    expect(continued(rows("a", "c", "d"))).toEqual({ rows: rows("c", "d"), listChanged: true });
    expect(continued(rows("c", "d"))).toEqual({ rows: rows("c", "d"), listChanged: true });
  });

  it("say the list changed when a position at a site page's start lacks the anchor", () => {
    // Page one ended at a site page's end; a position naming the next site page cannot tell a row
    // removed above the boundary from no change, so it says the list may have changed.
    const cursor = cursorOf(
      pageOne({ page: 2, offset: 0, href: "https://www.example.test/s?q=lamps&page=2" }),
    );
    expect(selectRows(continuing(cursor), rows("d", "e"), keyOf)).toEqual({
      rows: rows("d", "e"),
      listChanged: true,
    });
  });

  it("follow a site's own continuation token without calling the list changed", () => {
    const cursor = cursorOf(pageOne({ offset: 0, token: "after-b" }, "api"));
    expect(selectRows(continuing(cursor, "api"), rows("c", "d"), keyOf)).toEqual({
      rows: rows("c", "d"),
      listChanged: false,
    });
  });

  it("say the list changed when a token position into the anchor's own segment lacks it", () => {
    // The token fetched the segment that holds the last returned row, and the position resumes
    // inside it: that row gone from those rows is a change, as on a site page.
    const cursor = cursorOf(pageOne({ offset: 2, token: "from-a" }, "api"));
    expect(selectRows(continuing(cursor, "api"), rows("c", "d"), keyOf)).toEqual({
      rows: rows("c", "d"),
      listChanged: true,
    });
  });

  it("never repeat a returned row, and drop a sponsored copy of one without calling it a change", () => {
    const later = continuing(cursorOf(pageOne()));
    const sponsored = (id: string) => ({ id, sponsored: true });
    expect(selectRows(later, [...rows("a", "b"), sponsored("a"), ...rows("c")], keyOf, { promoted })).toEqual({
      rows: rows("c"),
      listChanged: false,
    });
    // A sponsored copy ahead of its organic row on the same page gives way to it; a promoted row
    // whose item the page shows only promoted stays in place.
    expect(
      selectRows(later, [...rows("a", "b"), sponsored("d"), sponsored("e"), ...rows("c", "d")], keyOf, {
        promoted,
      }),
    ).toEqual({ rows: [sponsored("e"), ...rows("c", "d")], listChanged: false });
    // An organic row a previous page returned is a change, as without `promoted`.
    expect(selectRows(later, [...rows("a", "b", "c", "a")], keyOf, { promoted })).toEqual({
      rows: rows("c"),
      listChanged: true,
    });
  });
});

describe("finishList", () => {
  const list = startList(hosted({}), { mechanism: "append" });
  const finish = (next: ListPosition | null, returned = rows("a")) =>
    finishList(list, {
      rows: returned,
      keyOf,
      next,
      hasMore: false,
      totalResults: null,
      listChanged: false,
    });

  it("gives no cursor past the deepest replay, keeps has_more and says why", () => {
    expect(finish({ steps: 20, offset: 0 }).next_cursor).toMatch(/^pcd1\./u);
    expect(finish({ steps: 21, offset: 0 })).toMatchObject({
      next_cursor: null,
      has_more: true,
      next_cursor_unavailable: "depth_cap",
    });
  });

  // A list that stalls while the site still offers more would otherwise hand back the cursor it
  // was given, with no rows, on every call: a caller paging until has_more is false never ends.
  it("ends a later page that returned no rows and stayed at its position, keeping has_more", () => {
    const stalled = { steps: 1, offset: 2 };
    const later = continuing(cursorOf(pageOne(stalled, "append")), "append");
    const again = (next: ListPosition, returned: readonly Row[]) =>
      finishList(later, {
        rows: returned,
        keyOf,
        next,
        hasMore: true,
        totalResults: null,
        listChanged: false,
      });
    expect(again(stalled, [])).toEqual({
      next_cursor: null,
      next_cursor_expires_at: null,
      has_more: true,
      total_results: null,
      list_changed: false,
      next_cursor_unavailable: "no_progress",
    });
    // A step further, or rows returned, is progress and continues.
    expect(again({ steps: 2, offset: 2 }, []).next_cursor).toMatch(/^pcd1\./u);
    expect(again(stalled, rows("c")).next_cursor).toMatch(/^pcd1\./u);
  });

  it("anchors a later page that returned no rows on the row it resumed after", () => {
    const later = continuing(cursorOf(pageOne()));
    // The call read past rows returned before, up to c, and returned none.
    const fields = finishList(later, {
      rows: [],
      keyOf,
      next: { page: 1, offset: 3, href: "https://www.example.test/s?q=lamps" },
      hasMore: true,
      totalResults: null,
      listChanged: false,
      resumeAfter: "c",
    });
    const resumed = continuing(
      cursorOf(sealListOutput({ results: [], ...fields }, input, scope())),
    );
    expect(selectRows(resumed, rows("a", "b", "c", "d"), keyOf)).toEqual({
      rows: rows("d"),
      listChanged: false,
    });
  });

  it("anchors a later page that returned no rows on the sponsored row it resumed after", () => {
    const later = continuing(cursorOf(pageOne()));
    const fields = finishList(later, {
      rows: [],
      keyOf,
      promoted,
      next: { page: 1, offset: 3, href: "https://www.example.test/s?q=lamps" },
      hasMore: true,
      totalResults: null,
      listChanged: false,
      resumeAfter: "x",
      resumeAfterPromoted: true,
    });
    const resumed = continuing(
      cursorOf(sealListOutput({ results: [], ...fields }, input, scope())),
    );
    expect(
      selectRows(resumed, [...rows("a", "b"), { id: "x", sponsored: true }, ...rows("c")], keyOf, {
        promoted,
      }),
    ).toEqual({ rows: rows("c"), listChanged: false });
  });

  it("refuses more rows than limit", () => {
    expect(() =>
      finishList(startList(hosted({ limit: 1 }), { mechanism: "append" }), {
        rows: rows("a", "b"),
        keyOf,
        next: null,
        hasMore: false,
        totalResults: null,
        listChanged: false,
      }),
    ).toThrow("at most limit rows");
  });

  it("refuses a cursor from before the tool paged another way", () => {
    expect(() => continuing(cursorOf(pageOne()), "append")).toThrow(
      expect.objectContaining({ name: "InvalidInput", field: "cursor", kind: "mechanism_changed" }),
    );
  });
});

describe("a cursor at the size limits", () => {
  const longest = (length: number) =>
    `https://www.example.test/s?q=${"x".repeat(length - "https://www.example.test/s?q=".length)}`;
  const fullPage = (count: number) => rows(...Array.from({ length: count }, (_, i) => `row-${i}`));

  it("signs a full page whose site link is as long as a position holds", () => {
    const limitInput = { query: "lamps", limit: 50 };
    const returned = fullPage(50);
    const fields = finishList(startList(hosted(limitInput), { mechanism: "next_link" }), {
      rows: returned,
      keyOf,
      next: {
        page: 100_000,
        steps: 100_000,
        offset: 100_000,
        pageSize: 10_000,
        href: longest(1_024),
      },
      hasMore: true,
      totalResults: null,
      listChanged: false,
      context: "a location the site chose",
    });
    const sealed = sealListOutput(
      { results: returned, ...fields },
      limitInput,
      scope({
        keys: { current: key("k".repeat(16), 3) },
        subject: "an account",
        now: 9_999_999_999_000,
      }),
    );
    expect(sealed.dropped).toBeUndefined();
    const cursor = cursorOf(sealed);
    expect(cursor.length).toBeLessThanOrEqual(listCursorMaxLength);
    const list = continuing(
      cursor,
      "next_link",
      scope({
        keys: { current: key("k".repeat(16), 3) },
        subject: "an account",
        now: 9_999_999_999_000,
      }),
    );
    expect(list.seen.size).toBe(listSeenMax);
  });

  it("signs the largest draft a position can make, whatever its text", () => {
    // Text that JSON escapes takes the most bytes per character; the draft's byte bound decides.
    const fullInput = { query: "lamps", limit: 50 };
    const largest = Array.from({ length: 201 }, (_, length) => 200 - length)
      .map((scopeLength) =>
        finishList(startList(hosted(fullInput), { mechanism: "pages" }), {
          rows: fullPage(50),
          keyOf,
          next: {
            page: 100_000,
            steps: 100_000,
            offset: 100_000,
            pageSize: 10_000,
            href: longest(1_024),
            scope: "\u0001".repeat(scopeLength),
          },
          hasMore: true,
          totalResults: null,
          listChanged: false,
          context: "x",
        }),
      )
      .find((fields) => fields.next_cursor !== null);
    expect(largest?.next_cursor).toMatch(/^pcd1\./u);
    const at = scope({ keys: { current: key("k".repeat(16), 3) }, subject: "an account" });
    const sealed = sealListOutput({ results: [], ...largest }, fullInput, at);
    expect(sealed.dropped).toBeUndefined();
    expect(cursorOf(sealed).length).toBeLessThanOrEqual(listCursorMaxLength);
  });

  it("ends the list with a reason when the site's link is longer than a cursor holds", () => {
    const fields = finishList(startList(hosted(input), { mechanism: "pages" }), {
      rows: rows("a"),
      keyOf,
      next: { page: 2, offset: 0, href: longest(1_025) },
      hasMore: true,
      totalResults: null,
      listChanged: false,
    });
    expect(fields).toMatchObject({
      next_cursor: null,
      has_more: true,
      next_cursor_unavailable: "position_too_long",
    });
  });
});
