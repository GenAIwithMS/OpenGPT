import { createHash } from "node:crypto";
import { Either, Schema } from "effect";
import { OperationFailure, operationErrors } from "./operation-failure.js";
import { listHostOf } from "./list-host.js";

export { withListHost, type ListHost } from "./list-host.js";

// One page of a list per call, and a cursor to the next. A script reads the position it continues
// from with `startList` and reads the page with `readList`, which reaches the position through the
// script's site actions, picks the rows it returns with `selectRows` and writes the list's output
// fields with `finishList`. The host signs every cursor a caller sees and checks it before the
// next run starts, so a script never writes, signs or parses a cursor itself: the position it
// gets is one this tool returned within ten minutes, for the same inputs. The position reaches the
// script on a host channel beside its input (`withListHost`), never in the input itself, so a run
// whose host did not check a cursor refuses it rather than trusting what the caller sent.

/** Rows a call returns when the caller names no `limit`, and the most it may ask for. */
export const listLimitDefault = 20;
export const listLimitMax = 50;
/** The longest cursor a caller may send back. */
export const listCursorMaxLength = 2_048;
/** How long a cursor can be used after the run that returned it: ten minutes. */
export const listCursorTtlMs = 600_000;
/**
 * The most row-key digests a cursor keeps from the rows returned before it: the last rows
 * returned, across calls, which is what a later page needs to drop rows it already returned and
 * to find its place when the last returned row is gone.
 */
export const listSeenMax = 16;
/**
 * The most bytes a draft's JSON may take. With the host's own fields and signature added, any
 * draft within it seals into a cursor no longer than `listCursorMaxLength`.
 */
export const listDraftMaxBytes = 1_360;
/**
 * The most calls in a row the run's time may stop at the same position before it read past it, or
 * that find the site showing none of a list earlier pages returned rows of. The next one that
 * stops there ends the list with `no_progress`, so a caller paging until `has_more` is false still
 * ends when every run's time runs out before it reads.
 */
const listTimeStopsMax = 1;
/** The most one call reads before it returns what it has with a cursor that continues. */
export const listCallBounds = { sitePages: 5, steps: 10 } as const;
/**
 * The deepest position a cursor may hold when it has no link or token from the site to open: the
 * replay from the first page grows with depth, so past it `next_cursor` is null.
 */
export const listDepth = { sitePages: 10, steps: 20 } as const;

/**
 * How a site shows the next rows: `pages` (numbered page links), `next_link` (only a Next link,
 * often with an opaque token), `append` (a "Load more" control), `scroll` (rows that load as the
 * list scrolls), `api` (the page's own list endpoint with an offset, page or token) or `offset`
 * (the whole list on one page, read in windows).
 */
export const ListMechanism = Schema.Literal(
  "pages",
  "next_link",
  "append",
  "scroll",
  "api",
  "offset",
);
export type ListMechanism = typeof ListMechanism.Type;

/**
 * Why a cursor was refused. The host refuses `malformed`, `altered`, `unknown_key`, `version`,
 * `other_tool`, `other_account`, `inputs_changed`, `expired` and `off_site` before the run starts;
 * the script refuses `mechanism_changed` when the tool now pages another way, and `site_expired`
 * when the site refuses its own link or token and the position cannot be rebuilt.
 */
export const CursorRefusal = Schema.Literal(
  "malformed",
  "altered",
  "unknown_key",
  "version",
  "other_tool",
  "other_account",
  "inputs_changed",
  "expired",
  "off_site",
  "mechanism_changed",
  "site_expired",
);
export type CursorRefusal = typeof CursorRefusal.Type;

/** A row key's or context's digest in a cursor: 48 bits, so no account value rides in it. */
const Digest = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{8}$/u));
const countMax = 100_000;
const Count = Schema.Int.pipe(Schema.between(0, countMax));
const hrefMaxLength = 1_024;
const tokenMaxLength = 512;
const scopeMaxLength = 200;

/**
 * Where the next rows start on the site: the site page and the offset within it, the steps of a
 * "Load more" or scroll replay, and the site's own link to that page (`href`) or its list API's
 * token (`token`) exactly as this run read them. `scope` is a list scope the site applies by its
 * own value, such as a year or a tab.
 */
export const ListPosition = Schema.Struct({
  page: Schema.optional(Schema.Int.pipe(Schema.between(1, 100_000))),
  steps: Schema.optional(Count),
  offset: Count,
  pageSize: Schema.optional(Schema.Int.pipe(Schema.between(1, 10_000))),
  href: Schema.optional(Schema.String.pipe(Schema.maxLength(hrefMaxLength))),
  token: Schema.optional(Schema.String.pipe(Schema.maxLength(tokenMaxLength))),
  scope: Schema.optional(Schema.String.pipe(Schema.maxLength(scopeMaxLength))),
});
export type ListPosition = typeof ListPosition.Type;

const draftBytes = (draft: unknown) => Buffer.byteLength(JSON.stringify(draft), "utf8");

/**
 * The part of a cursor a script writes and reads: its mechanism, position, the rows returned so
 * far, the anchor (the last returned row's key digest), the digests of the last rows returned,
 * the digest of the context the site applied, how many calls in a row the run's time stopped at
 * this position or found the site showing none of the list (`t`), and whether rows returned before
 * may come back on later pages (`r`), set once a page started over or continued from a segment's
 * first row without finding where the previous page left off. The host adds the tool, the inputs' digest, the caller it was issued to
 * and the expiry, and signs it. Its JSON is at most `listDraftMaxBytes`.
 */
export const listDraftFields = {
  m: ListMechanism,
  pos: ListPosition,
  n: Count,
  a: Schema.optional(Digest),
  s: Schema.Array(Digest).pipe(Schema.maxItems(listSeenMax)),
  cx: Schema.optional(Digest),
  t: Schema.optional(Schema.Int.pipe(Schema.between(1, listTimeStopsMax))),
  r: Schema.optional(Schema.Literal(1)),
};
export const ListDraft = Schema.Struct(listDraftFields).pipe(
  Schema.filter((draft) => draftBytes(draft) <= listDraftMaxBytes),
);
export type ListDraft = typeof ListDraft.Type;

/** How a draft travels between the runtime and its host, never to a caller. */
export const listDraftPrefix = "pcd1.";

export const encodeListDraft = (draft: ListDraft) =>
  `${listDraftPrefix}${Buffer.from(JSON.stringify(Schema.encodeSync(ListDraft)(draft))).toString("base64url")}`;

/** The draft a `pcd1.` string holds, or undefined for any other value. */
export const decodeListDraft = (value: unknown): ListDraft | undefined => {
  if (typeof value !== "string" || !value.startsWith(listDraftPrefix)) return undefined;
  const body = value.slice(listDraftPrefix.length);
  if (!/^[A-Za-z0-9_-]*$/u.test(body)) return undefined;
  try {
    const decoded = Schema.decodeUnknownEither(ListDraft, { onExcessProperty: "error" })(
      JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
    );
    return Either.isRight(decoded) ? decoded.right : undefined;
    // error-reporting-allow: parse-predicate a draft that is not JSON is no draft
  } catch {
    return undefined;
  }
};

/** A row key's or context's digest, as cursors carry it. */
export const listDigest = (value: string) =>
  createHash("sha256").update(value).digest("base64url").slice(0, 8);

/** A promoted row's digest: a cursor remembers it apart from the item's organic row. */
const promotedDigest = (digest: string) => listDigest(`promoted\u0000${digest}`);

/**
 * Each row's digest as a cursor remembers it, or undefined for a promoted copy, which is no row of
 * the list. A row `promoted` marks is a copy when the rows hold the same item unpromoted, an earlier
 * promoted row holds it, or a previous page returned it (`list.seen`); a promoted row that is the
 * anchor, the last row the previous page returned, is never a copy.
 * Any other promoted row is remembered apart from the item's organic row, so an organic row a later
 * page shows after its promoted copy was returned is new, not a returned row come back.
 */
const rowDigests = <Row>(
  rows: readonly Row[],
  keyOf: (row: Row) => string,
  promoted: ((row: Row) => boolean) | undefined,
  list?: Pick<ListStart, "seen" | "anchor">,
): (string | undefined)[] => {
  const plain = rows.map((row) => listDigest(keyOf(row)));
  if (promoted === undefined) return plain;
  const marked = rows.map((row) => promoted(row));
  const organic = new Set(plain.filter((_, index) => !marked[index]));
  const shown = new Set<string>();
  return plain.map((digest, index) => {
    if (!marked[index]) return digest;
    const own = promotedDigest(digest);
    if (list !== undefined && own === list.anchor && !shown.has(own)) {
      shown.add(own);
      return own;
    }
    const returned = list !== undefined && (list.seen.has(digest) || list.seen.has(own));
    if (organic.has(digest) || shown.has(own) || returned) return undefined;
    shown.add(own);
    return own;
  });
};

/** The list inputs every list tool takes; spread them into its input schema's fields. */
export const listInputFields = {
  limit: Schema.optional(
    Schema.Int.pipe(Schema.between(1, listLimitMax)).annotations({
      description: `The most results to return in this call, 1 to ${listLimitMax}. Default ${listLimitDefault}.`,
    }),
  ),
  cursor: Schema.optional(
    Schema.String.pipe(Schema.maxLength(listCursorMaxLength)).annotations({
      description:
        "The next_cursor a previous call returned, to get the results that follow. Send the same other inputs as that call; limit may change.",
    }),
  ),
};

/** The list outputs every list tool returns; spread them into its output schema's fields. */
export const listOutputFields = {
  next_cursor: Schema.NullOr(Schema.String).annotations({
    description:
      "Pass as cursor, with the same inputs, to get the results that follow. Null when no more can be fetched.",
  }),
  next_cursor_expires_at: Schema.NullOr(Schema.String).annotations({
    description:
      "When next_cursor stops working, as an ISO 8601 UTC time; null when next_cursor is null.",
  }),
  has_more: Schema.Boolean.annotations({
    description: "Whether the site shows more results after these, reachable or not.",
  }),
  total_results: Schema.NullOr(Schema.Int.pipe(Schema.nonNegative())).annotations({
    description:
      "The site's own exact count of results; null when it shows none or only an approximate one.",
  }),
  list_changed: Schema.Boolean.annotations({
    description:
      "True when the site's list changed since the cursor was issued, and on every later page once rows returned before can come back; rows may be missing or repeated relative to earlier pages, so de-duplicate by key.",
  }),
  next_cursor_unavailable: Schema.optional(
    Schema.Literal(
      "depth_cap",
      "no_progress",
      "position_too_long",
      "unsigned_host",
      "off_site",
      "not_a_draft",
      "inputs_not_json",
    ).annotations({
      description:
        "Why next_cursor is null although has_more is true: depth_cap past the deepest page this tool can reach again, no_progress when this call returned no results and could not move past the cursor's position, or the run's time stopped it there twice in a row, position_too_long when the site's link to the next page is too long for a cursor, off_site when it leaves the site, or the host could not sign one.",
    }),
  ),
};

/** Why a list that has more returned no next cursor. */
export type ListCursorUnavailable = NonNullable<ListOutput["next_cursor_unavailable"]>;

/** The list fields `finishList` writes into a tool's output. */
export interface ListOutput {
  readonly next_cursor: string | null;
  readonly next_cursor_expires_at: string | null;
  readonly has_more: boolean;
  readonly total_results: number | null;
  readonly list_changed: boolean;
  readonly next_cursor_unavailable?:
    | "depth_cap"
    | "no_progress"
    | "position_too_long"
    | "unsigned_host"
    | "off_site"
    | "not_a_draft"
    | "inputs_not_json";
}

/** Where a call starts: its `limit`, and on a later page the position the cursor holds. */
export interface ListStart {
  readonly limit: number;
  readonly mechanism: ListMechanism;
  /** Undefined on the first page. */
  readonly position?: ListPosition;
  /** Rows earlier pages returned. */
  readonly returned: number;
  readonly anchor?: string;
  readonly seen: ReadonlySet<string>;
  readonly context?: string;
  /**
   * How many calls in a row before this one the run's time stopped at this position, or found the
   * site showing none of the list.
   */
  readonly timeStops: number;
  /**
   * Whether rows returned before may come back: an earlier page in this cursor's chain started
   * over or continued without finding where the page before it left off.
   */
  readonly mayRepeat: boolean;
  /** Whether the run's host signs the next cursor; without it, `finishList` returns none. */
  readonly signed: boolean;
}

const refuse = (reason: CursorRefusal, message: string) =>
  new operationErrors.InvalidInput(message, { field: "cursor", kind: reason });

/**
 * Reads the call's `limit` and the position its cursor holds, before any browser work. The
 * position comes from the host, which checked the cursor's signature, tool, inputs, caller and
 * expiry before the run started. It throws `errors.InvalidInput` with `field: "cursor"` when the
 * run has a cursor its host did not check, or the tool now pages another way than when it was
 * issued. The run fails with that refusal in a Kernel script and an Effect operation alike, so an
 * HTTP version calls it directly too. An empty cursor is none.
 */
export const startList = (
  input: unknown,
  options: { readonly mechanism: ListMechanism },
): ListStart => {
  const limitValue: unknown =
    typeof input === "object" && input !== null ? Reflect.get(input, "limit") : undefined;
  const cursor: unknown =
    typeof input === "object" && input !== null ? Reflect.get(input, "cursor") : undefined;
  const limit =
    typeof limitValue === "number" && Number.isInteger(limitValue)
      ? Math.min(Math.max(limitValue, 1), listLimitMax)
      : listLimitDefault;
  const host = listHostOf(input);
  const signed = host !== undefined;
  if (cursor === undefined || cursor === null || cursor === "")
    return {
      limit,
      mechanism: options.mechanism,
      returned: 0,
      seen: new Set(),
      timeStops: 0,
      mayRepeat: false,
      signed,
    };
  const draft = host?.position;
  if (draft === undefined)
    throw refuse(
      "malformed",
      "The cursor is not one this tool returned. Call again without cursor to start from the first page.",
    );
  if (draft.m !== options.mechanism)
    throw refuse(
      "mechanism_changed",
      "This tool now pages the site another way, so the cursor no longer applies. Call again without cursor to start from the first page and skip the results you already have.",
    );
  return {
    limit,
    mechanism: draft.m,
    position: draft.pos,
    returned: draft.n,
    ...(draft.a === undefined ? {} : { anchor: draft.a }),
    seen: new Set(draft.s),
    ...(draft.cx === undefined ? {} : { context: draft.cx }),
    timeStops: draft.t ?? 0,
    mayRepeat: draft.r === 1,
    signed,
  };
};

/** The indices in `rows` of the rows `selectRows` picks, and whether the list changed. */
const pickRows = <Row>(
  list: ListStart,
  rows: readonly Row[],
  keyOf: (row: Row) => string,
  options: { readonly context?: string; readonly promoted?: (row: Row) => boolean },
): { readonly indices: number[]; readonly listChanged: boolean } => {
  const digests = rowDigests(rows, keyOf, options.promoted, list);
  let start = 0;
  let changed = false;
  const position = list.position;
  if (position !== undefined) {
    // A site token that starts right after the anchor (offset 0) reads rows that cannot hold it.
    const pastAnchor = position.token !== undefined && position.offset === 0;
    const anchor = list.anchor === undefined ? -1 : digests.lastIndexOf(list.anchor);
    if (anchor >= 0) {
      start = anchor + 1;
      // The anchor moved from where the cursor saw it: rows were inserted or removed above it.
      // An inserted row is one the caller never gets, and a removed one is gone from rows it got.
      if (!pastAnchor && anchor !== position.offset - 1) changed = true;
    } else {
      // The anchor is gone: continue after the last returned row still here, so a removal
      // repeats rows rather than skipping them. A position names the segment that holds the
      // anchor, so its absence there is a change.
      const lastSeen = digests.findLastIndex(
        (digest) => digest !== undefined && list.seen.has(digest),
      );
      start = lastSeen + 1;
      if (lastSeen >= 0 || (list.anchor !== undefined && !pastAnchor)) changed = true;
    }
    if (
      list.context !== undefined &&
      options.context !== undefined &&
      listDigest(options.context) !== list.context
    )
      changed = true;
  }
  const kept = new Set<string>();
  const indices: number[] = [];
  for (let index = start; index < rows.length; index++) {
    const digest = digests[index];
    // A promoted copy of an item the list holds is no row of it, here or on any page.
    if (digest === undefined) continue;
    if (list.seen.has(digest)) {
      changed = true;
      continue;
    }
    if (kept.has(digest)) continue;
    kept.add(digest);
    indices.push(index);
  }
  return { indices, listChanged: changed };
};

/**
 * Picks the rows that follow the previous page from `rows`, the rows the call read in the site's
 * order from where its position starts: the segment that holds the anchor, the last row the
 * previous page returned. It continues after the anchor, wherever that row now is. When the
 * anchor is gone, it continues after the last row the previous page returned that is still
 * there, else from the first row, so a change repeats rows rather than skipping them. It drops
 * rows the previous page returned and any key twice. `listChanged` is true when anything changed
 * at or above the anchor: it moved from the offset the cursor saw it at (rows were inserted or
 * removed above it), it is gone, a row the cursor remembers came back, or the context the site applied (such
 * as a location it chose) differs. Rows that changed below the anchor are simply returned. A
 * position whose site `token` starts right after the anchor (offset 0) reads rows that cannot
 * hold it, so there the anchor's absence is no change. It only sees `rows`: finding an anchor
 * that moved into another segment is `readList`'s work. A key is the item's own stable ID, the
 * same for a sponsored copy of a row. With `promoted`, a promoted row whose item the rows also hold
 * unpromoted, or a previous page returned, is a copy: it is dropped, and never counts as a change,
 * so the organic row stays at its organic place. A promoted row whose item the list shows only
 * promoted stays in place. `readList` calls it for you.
 */
export const selectRows = <Row>(
  list: ListStart,
  rows: readonly Row[],
  keyOf: (row: Row) => string,
  options: { readonly context?: string; readonly promoted?: (row: Row) => boolean } = {},
): { readonly rows: Row[]; readonly listChanged: boolean } => {
  const picked = pickRows(list, rows, keyOf, options);
  return {
    rows: picked.indices.flatMap((index) => {
      const row = rows[index];
      return row === undefined ? [] : [row];
    }),
    listChanged: picked.listChanged,
  };
};

/** Whether the tool can rebuild `next` on a later call. */
const reachable = (next: ListPosition) =>
  next.href !== undefined ||
  next.token !== undefined ||
  ((next.page ?? 1) <= listDepth.sitePages && (next.steps ?? 0) <= listDepth.steps);

/** Whether two positions name the same place on the site. */
const samePosition = (a: ListPosition, b: ListPosition) =>
  a.page === b.page &&
  a.steps === b.steps &&
  a.offset === b.offset &&
  a.pageSize === b.pageSize &&
  a.href === b.href &&
  a.token === b.token &&
  a.scope === b.scope;

/** Whether a next position fits in a cursor, with room for everything else the cursor holds. */
const fits = (next: ListPosition) =>
  (next.href?.length ?? 0) <= hrefMaxLength &&
  (next.token?.length ?? 0) <= tokenMaxLength &&
  (next.scope?.length ?? 0) <= scopeMaxLength;

/** Parameter names that carry a session, a credential or a URL signature, compared without case. */
const sessionParameter =
  /^(?:j?sessionid|session_?(?:id|token|key)|php_?sessid|sessid|aspsessionid\w*|sid|cfid|cftoken|access_?token|id_?token|auth_?token|authenticity_?token|csrf_?token|token|api_?key|password|passwd|sig|signature|x-amz-(?:signature|credential|security-token)|x-goog-(?:signature|credential))$/iu;

/** An ASP.NET cookieless session path segment, such as `(S(a1b2c3))`. */
const cookielessSegment = /^\((?:[A-Z]\([^()]*\))+\)$/u;

/**
 * Whether a site link carries a session, a credential or a signature: a user name or password, a
 * path parameter such as `;jsessionid=`, a cookieless session path segment, or such a parameter
 * in its query or fragment. A cursor never carries one: the next call signs in through the host
 * instead.
 */
const carriesSession = (href: string) => {
  const url = URL.parse(href);
  if (url === null) return false;
  if (url.username !== "" || url.password !== "") return true;
  const segments = url.pathname.split("/");
  if (segments.some((segment) => cookielessSegment.test(segment))) return true;
  const names = [
    ...segments
      .flatMap((segment) => segment.split(";").slice(1))
      .map((parameter) => parameter.split("=")[0] ?? ""),
    ...url.searchParams.keys(),
    ...new URLSearchParams(url.hash.slice(1)).keys(),
  ];
  return names.some((name) => sessionParameter.test(name));
};

/** A position without a site link that carries a session; the next call reaches it by number. */
const withoutSession = (next: ListPosition): ListPosition => {
  if (next.href === undefined || !carriesSession(next.href)) return next;
  const { href: _href, ...rest } = next;
  return rest;
};

/**
 * Writes the list's output fields for the rows this call returns. `next` is where the following
 * rows start, null when the site shows nothing further; it names the segment that holds the last
 * returned row, so the next call finds that row again. When the list has more but no cursor
 * can continue it, `next_cursor` is null, `has_more` stays true and `next_cursor_unavailable`
 * says why: past the deepest position the tool can rebuild without a site link or token, a site
 * link or token too long for a cursor, a later page that returned no rows and stayed at the
 * position it started from, such as a list that stalls while the site still offers more (so a
 * caller paging until `has_more` is false still ends), or a host that does not sign cursors. A
 * call that the run's time stopped before it could read past its position passes `bounded`: its
 * next cursor then holds the same position, since a call with more time continues there, unless
 * the call before it stopped there the same way, when the list ends with `no_progress`. A
 * site link that carries a session or a credential is left out of the cursor, so the next call
 * reaches that page by its number. The host signs `next_cursor` and fills
 * `next_cursor_expires_at` after the run. `readList` calls it for you.
 */
export const finishList = <Row>(
  list: ListStart,
  page: {
    readonly rows: readonly Row[];
    readonly keyOf: (row: Row) => string;
    /** Whether the site marks a row sponsored or promoted, as the reader's `promoted` says. */
    readonly promoted?: (row: Row) => boolean;
    readonly next: ListPosition | null;
    readonly hasMore: boolean;
    readonly totalResults: number | null;
    readonly listChanged: boolean;
    readonly context?: string;
    /**
     * The run's time stopped this call before it read past its position, or the site showed none
     * of the list a later call may read; not a stall.
     */
    readonly bounded?: boolean;
    /**
     * With no rows, the key of the row `next` resumes after when it is not the last row the
     * previous page returned, such as a row returned earlier that this call read past.
     */
    readonly resumeAfter?: string;
    /** Whether the row `resumeAfter` names is one `promoted` marks. */
    readonly resumeAfterPromoted?: boolean;
    /**
     * Rows returned before may come back on this page or a later one, such as after the page
     * started over: `list_changed` is true on it and on every later page from its cursor.
     */
    readonly mayRepeat?: boolean;
  },
): ListOutput => {
  if (page.rows.length > list.limit)
    throw new OperationFailure(
      `finishList got ${page.rows.length} rows for a limit of ${list.limit}; return at most limit rows`,
      { dispatch: "unknown" },
    );
  const fields = {
    next_cursor_expires_at: null,
    has_more: page.hasMore || page.next !== null,
    total_results: page.totalResults,
    list_changed: page.listChanged || page.mayRepeat === true || list.mayRepeat,
  };
  const ended = (reason: ListCursorUnavailable): ListOutput => ({
    next_cursor: null,
    ...fields,
    has_more: true,
    next_cursor_unavailable: reason,
  });
  if (page.next === null) return { next_cursor: null, ...fields };
  // A site link that carries a session or a credential stays out of the cursor; the page number
  // reaches the same page after the next call signs in.
  const next = withoutSession(page.next);
  // A call that read nothing past its position stalls. A call the run's time stopped there does
  // not, unless the calls before it stopped there the same way.
  const stopped =
    page.rows.length === 0 && list.position !== undefined && samePosition(next, list.position);
  const timeStops = stopped && page.bounded === true ? list.timeStops + 1 : 0;
  if (stopped && (page.bounded !== true || timeStops > listTimeStopsMax))
    return ended("no_progress");
  if (!reachable(next)) return ended("depth_cap");
  if (!fits(next)) return ended("position_too_long");
  if (!list.signed) return ended("unsigned_host");
  const digests = rowDigests(page.rows, page.keyOf, page.promoted).filter(
    (digest) => digest !== undefined,
  );
  const anchor =
    digests.at(-1) ??
    (page.resumeAfter === undefined
      ? list.anchor
      : page.resumeAfterPromoted === true
        ? promotedDigest(listDigest(page.resumeAfter))
        : listDigest(page.resumeAfter));
  // The last rows returned across calls, this call's last.
  const seen = [...[...list.seen].filter((digest) => !digests.includes(digest)), ...digests];
  const context = page.context === undefined ? list.context : listDigest(page.context);
  const draft = Schema.decodeUnknownEither(ListDraft)({
    m: list.mechanism,
    pos: next,
    n: Math.min(list.returned + page.rows.length, countMax),
    ...(anchor === undefined ? {} : { a: anchor }),
    s: seen.slice(-listSeenMax),
    ...(context === undefined ? {} : { cx: context }),
    ...(timeStops === 0 ? {} : { t: timeStops }),
    ...(page.mayRepeat === true || list.mayRepeat ? { r: 1 } : {}),
  });
  if (Either.isLeft(draft)) {
    // Within each field's length, a position can still be too large as a whole.
    const positionValid = Either.isRight(Schema.decodeUnknownEither(ListPosition)(next));
    if (positionValid) return ended("position_too_long");
    throw new OperationFailure(
      `finishList got a next position that is not one: ${String(draft.left.message).slice(0, 500)}`,
      { dispatch: "unknown" },
    );
  }
  return { next_cursor: encodeListDraft(draft.right), ...fields };
};

/**
 * One segment of a list as a reader reads it: a site page (`pages`, `next_link`), one response of
 * the page's own list API (`api`), or the whole list as it stands after some "Load more" steps or
 * scrolls (`append`, `scroll`) or on its one page (`offset`). `rows` are its rows in the site's
 * order from its first row, up to the count asked for.
 */
export interface ListSegment<Row> {
  readonly rows: readonly Row[];
  /** Whether the segment shows rows past the ones read, such as the rest of a site page. */
  readonly more: boolean;
  /**
   * Whether another segment follows: a Next link, a "Load more" control still offered, rows still
   * to scroll to, or the API's next token.
   */
  readonly hasNext: boolean;
  /** The site's own link to this segment, exactly as the run read it (`pages`, `next_link`). */
  readonly href?: string;
  /** The site's own token, page or offset that fetched this segment (`api`); none for the first. */
  readonly token?: string;
  /** A list scope the site applies by its own value, such as a year or a tab. */
  readonly scope?: string;
  /** The site's own exact count of results, when it shows one. */
  readonly totalResults?: number | null;
  /** A context the site applied that the caller did not set, such as a location it chose. */
  readonly context?: string;
}

/**
 * How `readList` reads a site's list. Each function does one site action and reads; `readList`
 * decides which to call, how many rows to ask for and where the next call starts.
 */
export interface ListReader<Row, Segment extends ListSegment<Row>> {
  /**
   * A row's stable key: the item's own ID, such as a product number, SKU or listing ID, never its
   * link text or position. A sponsored copy of a row has the same key as the row.
   */
  readonly keyOf: (row: Row) => string;
  /**
   * Whether the site marks a row sponsored or promoted, such as `(row) => row.sponsored`. A
   * promoted copy of an item the list also shows unpromoted, or one an earlier page returned, is
   * dropped and never counts as a change, so an item comes back at its organic place. The one
   * repeat left: a sponsored copy returned before its organic row was read, such as one at the
   * top of a page whose organic row sits further on, which then comes back too. A promoted row
   * whose item the list shows only promoted stays in place.
   */
  readonly promoted?: (row: Row) => boolean;
  /**
   * Reaches where this call starts and reads the first `count` rows of that segment. On a first
   * page `position` is undefined: start the list as the first call always does, such as running
   * the search. On a later page, the host has already started this run as it started the first
   * one and signed it in when the tool signs in; then follow the position: open its `href`
   * (`pages`, `next_link`) and read back that it shows the same list, else start the list and
   * follow Next to its `page`; fetch its `token` (`api`), else fetch the responses up to its
   * `page`; or start the list and repeat the "Load more" click or scroll `steps` times (`append`,
   * `scroll`). A position with only a `page` is also how `readList` reads an earlier segment
   * whole, asking for up to 1,000 rows. For `append` and `scroll`, `count` counts the rows of the
   * whole list.
   */
  readonly open: (position: ListPosition | undefined, count: number) => Promise<Segment>;
  /**
   * Reads the open segment again for its first `count` rows, without navigating or acting.
   * `readList` asks a reader for at most 1,000 rows, or the last segment's rows read plus `limit`
   * when that is more; `open` asks for the position's offset plus `limit`.
   */
  readonly more?: (segment: Segment, count: number) => Promise<Segment>;
  /**
   * Moves on from `segment`, the last one read, and reads the first `count` rows of the next: opens
   * the next site page, fetches the API's next response, or takes one more "Load more" step or
   * scroll, after which `count` counts the rows of the whole list.
   */
  readonly next?: (segment: Segment, count: number) => Promise<Segment>;
  /** The run's time left; with `readOnMs` or less left, the call returns what it read. */
  readonly remainingMs?: () => number;
  /** The time reading on needs. Default 5 s. */
  readonly readOnMs?: number;
}

/** How many segments past the opened one readList looks for an anchor no remembered row shows. */
const blindSegments = 2;

/** The most rows readList asks a reader for when it reads a whole segment. */
const segmentRowsMax = 1_000;

/** A list read as one growing document: the segment after a step holds every row before it too. */
const growing = (mechanism: ListMechanism) =>
  mechanism === "append" || mechanism === "scroll" || mechanism === "offset";

/**
 * Reads one call's page of a list and writes its output fields: from where the position starts,
 * it reads exactly the rows the window needs, reads the rest of a segment or moves on to the next
 * while rows are lacking, within `listCallBounds` and the run's time, and returns at most `limit`
 * rows. The call's page size and the site's need not match: a window can end inside a segment,
 * span two or more, or end on a short last one. The next position names the segment that holds
 * the last returned row (the site page and its link, the API token, or the fewest steps that load
 * it) and the offset after that row within it, so the next call reaches that segment again and
 * resumes after that row wherever it now is, dropping the rows the cursor remembers.
 *
 * When the segment a later page opens (`pages`, `next_link`, `api`) shows neither that row nor any
 * row the cursor remembers, rows removed above may have pulled them back, or rows inserted above
 * pushed them on. It looks up to two segments on, keeping a read to start over, and reads the
 * previous segment by its page number, which finds them after removals of up to about a segment's
 * rows. A reader reaches a page by its number by following Next from the first page, so that read
 * costs one read per page: when the previous segment is the list's first it is read before looking
 * on, since a start over needs it too; an earlier one is read after, only when it fits within the
 * call's reads with one left to start over, never deep in a list. When neither direction shows
 * them, it starts over from
 * the list's first segment in the same call: after that row or the last remembered row when that
 * segment shows one, else from the list's first row, repeating rows rather than skipping any. A
 * step back or a start over sets `list_changed`. A start over, or a page continued from a
 * segment's first row with neither that row nor any remembered row in sight, can also return rows
 * returned before the remembered ones, so `list_changed` stays true on that page and on every later
 * page from its cursor; de-duplicate by key once it is true. A list that stops growing while the
 * site still offers more stops this call with `has_more` true. A call returns no rows while the
 * list has more only when the run's time or the call's reads stopped it. A call the run's time
 * stopped before it read past its position hands back that same position, and a second such call
 * in a row ends the list with `no_progress`. So does a later page whose site shows no rows and a
 * total of 0 after earlier pages returned rows, which usually means the search did not load: it is
 * never the list's end, and `reason` says so for the tool to return.
 */
export const readList = async <Row, Segment extends ListSegment<Row>>(
  list: ListStart,
  reader: ListReader<Row, Segment>,
): Promise<{ readonly rows: Row[]; readonly output: ListOutput; readonly reason?: string }> => {
  const whole = growing(list.mechanism);
  const start = list.position;
  const anchor = list.anchor;
  // The page number of the first segment read, which a step back or a start over lowers.
  let base = start?.page ?? 1;
  let segments: Segment[] = [await reader.open(start, (start?.offset ?? 0) + list.limit)];
  const rowsRead = () =>
    whole ? (segments.at(-1)?.rows ?? []) : segments.flatMap((segment) => segment.rows);
  const digestsOf = (rows: readonly Row[]) =>
    rowDigests(rows, reader.keyOf, reader.promoted, list);
  const context = () => segments.find((segment) => segment.context !== undefined)?.context;
  const pick = () => {
    const applied = context();
    return pickRows(list, rowsRead(), reader.keyOf, {
      ...(applied === undefined ? {} : { context: applied }),
      ...(reader.promoted === undefined ? {} : { promoted: reader.promoted }),
    });
  };
  // The reads after the first: one per site page or API response, or one per step.
  const budget = whole ? listCallBounds.steps : listCallBounds.sitePages - 1;
  let reads = 0;
  let outOfTime = false;
  const timeLeft = () => {
    if (reader.remainingMs === undefined || reader.remainingMs() > (reader.readOnMs ?? 5_000))
      return true;
    outOfTime = true;
    return false;
  };
  // Whether the call looks for the anchor at all: a later page whose position does not start
  // right after it.
  const tracking =
    start !== undefined &&
    anchor !== undefined &&
    !(start.token !== undefined && start.offset === 0);
  const inSight = (rows: readonly Row[]) =>
    digestsOf(rows).some(
      (digest) => digest !== undefined && (digest === anchor || list.seen.has(digest)),
    );
  // The step back found the anchor or a returned row in the previous segment.
  let steppedBack = false;
  // Neither direction found them: the call started over from the list's first segment.
  let restarted = false;
  // The previous segment, read whole, when it shows neither.
  let previous: { readonly page: number; readonly segment: Segment } | undefined;
  // Neither the anchor nor any returned row is in sight, and the list's first segment is not the
  // one read: the call may still step back or start over.
  const lost = () =>
    tracking && !whole && !restarted && (start?.page ?? 1) > 1 && !inSight(rowsRead());
  // The reads a start over still needs: none once the list's first segment was read.
  const startOverReads = () => (lost() && previous?.page !== 1 ? 1 : 0);
  let blind = 0;
  // Whether the anchor may lie further on: it is not among the rows read, and no row returned
  // before is either, or those rows run to the last row read. Rows inserted above the anchor push
  // it on, maybe past the segment the position names; once a returned row is followed by rows
  // never returned, the anchor is gone instead. With no returned row in sight at all, it looks at
  // most `blindSegments` segments on, keeping the read a start over needs.
  const seeking = () => {
    if (!tracking) return false;
    const keys = digestsOf(rowsRead());
    if (anchor !== undefined && keys.includes(anchor)) return false;
    const lastSeen = keys.findLastIndex((key) => key !== undefined && list.seen.has(key));
    if (lastSeen >= 0) return lastSeen === keys.length - 1;
    return !steppedBack && !restarted && blind < blindSegments && reads < budget - startOverReads();
  };
  // A count asked of a reader: at most 1,000 rows, or the last segment's rows read plus `limit`.
  const countOf = (count: number, last: Segment) =>
    Math.min(count, Math.max(segmentRowsMax, last.rows.length + list.limit));
  const readOn = async () => {
    let picked = pick();
    for (;;) {
      const looking = seeking();
      if (!looking && (picked.indices.length >= list.limit || lost())) return;
      const last = segments.at(-1);
      if (last === undefined || !(last.more || last.hasNext) || reads >= budget) return;
      if (!timeLeft()) return;
      // Looking for the anchor reads a segment at least as large as the last one.
      const lacking = looking
        ? Math.max(list.limit, last.rows.length)
        : list.limit - picked.indices.length;
      reads++;
      if (last.more) {
        // Rows of this segment still unread come before the next one; looking for the anchor
        // reads the rest of them at once.
        if (reader.more === undefined) return;
        const reread = await reader.more(
          last,
          countOf(
            looking
              ? Math.max(segmentRowsMax, last.rows.length + lacking)
              : last.rows.length + lacking,
            last,
          ),
        );
        segments[segments.length - 1] = reread;
        if (reread.rows.length <= last.rows.length) return;
      } else {
        if (reader.next === undefined) return;
        if (looking) blind++;
        const following = await reader.next(
          last,
          countOf(whole ? last.rows.length + lacking : lacking, last),
        );
        segments.push(following);
        // A list that did not grow after a step stalls while the site still offers more.
        if (whole && following.rows.length <= last.rows.length) return;
      }
      picked = pick();
    }
  };
  // An earlier segment, whole, by its page number. A reader may reach a page by its number only by
  // starting the list and following Next to it, one load per page, so it costs that many reads.
  const readBack = async (page: number) => {
    reads += page;
    return reader.open(
      { page, offset: 0, ...(start?.scope === undefined ? {} : { scope: start.scope }) },
      segmentRowsMax,
    );
  };
  const opened = segments[0];
  if (lost() && opened?.more === true && reader.more !== undefined && timeLeft()) {
    // The rest of the opened segment first: rows inserted above may have pushed them down it.
    reads++;
    segments = [await reader.more(opened, Math.max(segmentRowsMax, opened.rows.length))];
  }
  // The previous segment, read whole: the call resumes there when it shows the anchor or a
  // returned row.
  const stepBack = async () => {
    const back = await readBack(base - 1);
    if (inSight(back.rows)) {
      steppedBack = true;
      base--;
      segments = back.more ? [back] : [back, ...segments];
    } else previous = { page: base - 1, segment: back };
  };
  // Removals above pull the anchor back into the previous segment. When that is the list's first,
  // one read reaches it, and a start over needs it anyway: read it before looking on.
  if (lost() && base === 2 && reads < budget && timeLeft()) await stepBack();
  await readOn();
  // An earlier previous segment costs one read per page: read it only when that fits within the
  // call's reads with one left to start over.
  if (lost() && previous === undefined && reads + base <= budget && timeLeft()) {
    await stepBack();
    if (steppedBack) await readOn();
  }
  if (lost() && (previous?.page === 1 || (reads + 1 <= budget && timeLeft()))) {
    // Neither direction shows them: start over from the list's first segment, continuing after
    // the anchor or a returned row when it shows one, else from its first row.
    const first = previous?.page === 1 ? previous.segment : await readBack(1);
    restarted = true;
    base = 1;
    segments = [first];
    await readOn();
  }
  const applied = context();
  const totalResults = segments[0]?.totalResults ?? null;
  const positionOf = (segment: Segment | undefined, page: number, offset: number): ListPosition => {
    const scope = segment?.scope ?? start?.scope;
    const common = { offset, ...(scope === undefined ? {} : { scope }) };
    switch (list.mechanism) {
      case "pages":
      case "next_link":
        return {
          page,
          ...common,
          ...(segment?.href === undefined ? {} : { href: segment.href }),
        };
      case "api":
        return {
          page,
          ...common,
          ...(segment?.token === undefined ? {} : { token: segment.token }),
        };
      case "append":
      case "scroll":
        return { steps: (start?.steps ?? 0) + page - base, ...common };
      case "offset":
        return common;
    }
  };
  // The call's reads ran out before it could start over: no rows, and the list's first segment,
  // where the next call starts over.
  if (lost() && !outOfTime)
    return {
      rows: [],
      output: finishList(list, {
        rows: [],
        keyOf: reader.keyOf,
        next: { page: 1, offset: 0, ...(start?.scope === undefined ? {} : { scope: start.scope }) },
        hasMore: true,
        totalResults,
        listChanged: true,
        ...(applied === undefined ? {} : { context: applied }),
        mayRepeat: true,
      }),
    };
  // The run's time ran out before this call read past its position, before it found the anchor
  // rows inserted above pushed further on, or before it could step back or start over: the next
  // call continues from the same position.
  if (
    start !== undefined &&
    (lost() ||
      (outOfTime && !steppedBack && !restarted && (pick().indices.length === 0 || seeking())))
  )
    return {
      rows: [],
      output: finishList(list, {
        rows: [],
        keyOf: reader.keyOf,
        next: start,
        hasMore: true,
        totalResults,
        listChanged: pick().listChanged,
        ...(applied === undefined ? {} : { context: applied }),
        bounded: true,
      }),
    };
  // A later page whose site shows no rows and a total of 0 after earlier pages returned rows is far
  // likelier a search that did not load or apply than a list that emptied: the next call retries
  // the same position, once, as after a call the run's time stopped, so the list never ends here.
  if (start !== undefined && list.returned > 0 && totalResults === 0 && rowsRead().length === 0) {
    const output = finishList(list, {
      rows: [],
      keyOf: reader.keyOf,
      next: start,
      hasMore: true,
      totalResults,
      listChanged: pick().listChanged,
      ...(applied === undefined ? {} : { context: applied }),
      bounded: true,
    });
    return {
      rows: [],
      output,
      reason:
        output.next_cursor === null
          ? `The site showed no results on a later page after listing ${list.returned} before, and no cursor can retry that page, so its list may have emptied. Prefer calling again without cursor to start from the first page.`
          : `The site showed no results on a later page after listing ${list.returned} before; this usually means its search or list did not load. Prefer calling again with next_cursor and the same inputs.`,
    };
  }
  const picked = pick();
  const read = rowsRead();
  const keys = digestsOf(read);
  const results = picked.indices.slice(0, list.limit).flatMap((index) => {
    const row = read[index];
    return row === undefined ? [] : [row];
  });
  // The segment that holds the last returned row, else the last row it read past: the fewest
  // steps that load it, or the last site page or response that shows it.
  const lastIndex = picked.indices[results.length - 1];
  let at = segments.length - 1;
  let offset = segments.at(-1)?.rows.length ?? 0;
  let resumeAfter: string | undefined;
  let resumeAfterPromoted = false;
  if (!whole) {
    // With no row returned, after the last row read that the anchor or a returned row is, so
    // rows already returned that this call read past are not read again.
    const resume =
      lastIndex ??
      keys.findLastIndex((key) => key !== undefined && (key === anchor || list.seen.has(key)));
    if (resume >= 0) {
      let before = 0;
      at = segments.findIndex((segment) => {
        if (resume < before + segment.rows.length) return true;
        before += segment.rows.length;
        return false;
      });
      offset = resume - before + 1;
      const row = read[resume];
      if (lastIndex === undefined && row !== undefined) {
        resumeAfter = reader.keyOf(row);
        resumeAfterPromoted = reader.promoted?.(row) === true;
      }
    }
  } else {
    const last = lastIndex === undefined ? anchor : keys[lastIndex];
    const digests = segments.map((segment) => digestsOf(segment.rows));
    const found = last === undefined ? -1 : digests.findIndex((digest) => digest.includes(last));
    if (last !== undefined && found >= 0) {
      at = found;
      offset = (digests[found] ?? []).lastIndexOf(last) + 1;
    }
  }
  const last = segments.at(-1);
  const hasMore =
    picked.indices.length > results.length || last?.more === true || last?.hasNext === true;
  return {
    rows: results,
    output: finishList(list, {
      rows: results,
      keyOf: reader.keyOf,
      ...(reader.promoted === undefined ? {} : { promoted: reader.promoted }),
      next: hasMore ? positionOf(segments[at], base + at, offset) : null,
      ...(resumeAfter === undefined ? {} : { resumeAfter }),
      ...(resumeAfterPromoted ? { resumeAfterPromoted } : {}),
      hasMore,
      totalResults,
      listChanged: picked.listChanged || steppedBack || restarted,
      // A start over, or rows picked from a segment's first row with neither the anchor nor any
      // returned row in sight, can return rows returned before the remembered ones.
      ...(restarted || (tracking && !inSight(read)) ? { mayRepeat: true } : {}),
      ...(applied === undefined ? {} : { context: applied }),
    }),
  };
};
