import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Either, Schema } from "effect";
import { canonicalJson } from "./fingerprint.js";
import {
  decodeListDraft,
  listDraftFields,
  listCursorMaxLength,
  listCursorTtlMs,
  type CursorRefusal,
  type ListCursorUnavailable,
  type ListHost,
} from "./list-page.js";
import { sameSite } from "./same-site.js";

// The host's side of list cursors. A run's script writes an unsigned draft of where the next rows
// start (`finishList`); the host signs it into the cursor the caller sees (`sealListOutput`). When
// a caller sends a cursor back, the host checks it before the run starts, before any browser or
// machine is provisioned for it (`admitListCursor`), and hands the run the position it signed on
// the host channel beside the input (`withListHost`). A script never sees the key, so it cannot
// make a cursor the host accepts.
//
// A cursor's body is signed, not encrypted: anyone holding it can read the site's own link or
// token to the next page and the list scope, as the site wrote them, plus digests. The tool, the
// inputs and the caller appear only as keyed digests. Treat a cursor like the page it points to.

/** One signing key: a short id the cursor names and at least 32 secret bytes. */
export interface ListCursorKey {
  readonly id: string;
  readonly secret: Uint8Array;
}

/**
 * The host's keys: `current` signs, and `current` or any of `previous` verifies, so a rotated
 * key keeps its cursors working until they expire. Keep a replaced key in `previous` for at least
 * `listCursorTtlMs`.
 */
export interface ListCursorKeys {
  readonly current: ListCursorKey;
  readonly previous?: readonly ListCursorKey[];
}

const keyIdPattern = /^[A-Za-z0-9_-]{1,16}$/u;
const minimumSecretBytes = 32;

/** Keys a host checks once, at start: a bad id or a short secret throws. */
export const listCursorKeys = (keys: ListCursorKeys): ListCursorKeys => {
  for (const key of [keys.current, ...(keys.previous ?? [])]) {
    if (!keyIdPattern.test(key.id))
      throw new TypeError("A list cursor key id is 1 to 16 letters, digits, - or _");
    if (key.secret.byteLength < minimumSecretBytes)
      throw new TypeError(`A list cursor key holds at least ${minimumSecretBytes} bytes`);
  }
  return keys;
};

/** A fresh random key, for a host that keeps its cursors only while its process runs. */
export const randomListCursorKeys = (): ListCursorKeys => ({
  current: { id: randomBytes(6).toString("base64url"), secret: randomBytes(32) },
});

/**
 * Where a cursor applies: the host's stable id for the tool, its site, the caller it is issued to
 * and the host's clock.
 */
export interface ListCursorScope {
  readonly keys: ListCursorKeys;
  /** The tool, the same across its repairs, such as a host's tool id or a local integration's name. */
  readonly operation: string;
  /**
   * The site's origin. A cursor's site link must be on it, or on an HTTPS host of its registrable
   * domain.
   */
  readonly siteOrigin?: string;
  /**
   * Who the cursor is issued to, as the host binds a run: an opaque value such as its account
   * and saved login. A cursor is refused for any other. A host with one caller leaves it unset.
   */
  readonly subject?: string;
  /** The host's clock, in milliseconds since the epoch. */
  readonly now: number;
}

const wirePrefix = "pc1";
/** How far apart two hosts' clocks may be when one checks a cursor's age from another's. */
const clockSkewMs = 5_000;
const keyedDigestLength = 16;

/** The signed part of a cursor: the draft, the tool, the inputs, the caller and its lifetime. */
const SignedCursor = Schema.Struct({
  v: Schema.Literal(1),
  op: Schema.String,
  ih: Schema.String,
  sub: Schema.String,
  iat: Schema.Int,
  exp: Schema.Int,
  ...listDraftFields,
});

/** A value's digest under the signing key, so a holder cannot guess small values back from it. */
const keyedDigest = (key: ListCursorKey, domain: string, text: string) =>
  createHmac("sha256", key.secret)
    .update(`${domain}\0${text}`)
    .digest("base64url")
    .slice(0, keyedDigestLength);

/** The inputs that make a list: every input but `cursor`, `limit` and `include`. */
const listInputs = (input: unknown): unknown => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const {
    cursor: _cursor,
    limit: _limit,
    include: _include,
    ...rest
  } = input as Record<string, unknown>;
  return rest;
};

/** The canonical text of the inputs a cursor is bound to, or undefined for input that is not JSON. */
const listInputText = (input: unknown): string | undefined => {
  try {
    return canonicalJson(JSON.parse(JSON.stringify(listInputs(input) ?? null)));
    // error-reporting-allow: parse-predicate input that is not JSON data binds no cursor
  } catch {
    return undefined;
  }
};

/** The keyed digests a cursor is bound by, or undefined for input that is not JSON. */
const bindings = (key: ListCursorKey, input: unknown, scope: ListCursorScope) => {
  const inputs = listInputText(input);
  return inputs === undefined
    ? undefined
    : {
        op: keyedDigest(key, "operation", scope.operation),
        ih: keyedDigest(key, "inputs", inputs),
        sub: keyedDigest(key, "subject", scope.subject ?? ""),
      };
};

const mac = (key: ListCursorKey, signed: string) =>
  createHmac("sha256", key.secret).update(signed).digest();

/**
 * Whether a site link is on the cursor's site: its exact origin, or an HTTPS host of its
 * registrable domain. A link with a user name or password never is.
 */
const onSite = (href: string, siteOrigin: string | undefined) => {
  const url = URL.parse(href);
  if (url === null || url.username !== "" || url.password !== "") return false;
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  return siteOrigin !== undefined && (url.origin === siteOrigin || sameSite(siteOrigin, url));
};

/** What each refusal tells the caller. Each says to start over, which always works. */
const refusalText: { readonly [Reason in CursorRefusal]: string } = {
  malformed: "The cursor is not one this tool returned.",
  altered: "The cursor was changed after this tool returned it.",
  unknown_key:
    "The cursor was signed with a key this host no longer holds, such as before it restarted.",
  version: "The cursor comes from another version of the host.",
  other_tool: "The cursor belongs to another tool.",
  other_account: "The cursor was returned to another account or login.",
  inputs_changed: "The cursor was returned for other inputs; only limit may change between pages.",
  expired: "The cursor expired; a cursor works for ten minutes after the call that returned it.",
  off_site: "The cursor points off the tool's site.",
  mechanism_changed: "This tool now pages the site another way, so the cursor no longer applies.",
  site_expired: "The site no longer accepts the position this cursor holds.",
};

/** A refused cursor's message for the caller. */
export const listCursorRefusalMessage = (reason: CursorRefusal) =>
  `${refusalText[reason]} Call again without cursor to start from the first page, and skip the results you already have by their IDs.`;

export type ListCursorAdmission =
  | {
      readonly ok: true;
      /**
       * What the run gets beside its input (`withListHost`): the position a signed cursor holds,
       * or none. The input itself runs unchanged.
       */
      readonly list: ListHost;
    }
  | { readonly ok: false; readonly reason: CursorRefusal; readonly message: string };

const refused = (reason: CursorRefusal): ListCursorAdmission => ({
  ok: false,
  reason,
  message: listCursorRefusalMessage(reason),
});

/**
 * Checks a run's `cursor` input before the run starts: a cursor this host signed for this tool,
 * these inputs and this caller, unexpired, whose site link is on the tool's site. A host refuses
 * the run at once on `ok: false`, as an input the caller fixes, with nothing provisioned and no
 * repair; on `ok: true` it runs the script with the input unchanged and `list` beside it. An
 * input without a cursor, or with an empty or null one, gets no position. Any other cursor this
 * host did not sign is refused: tools never make or read a cursor of their own, so one in another
 * form, or that is not a string, is `malformed`, and so is a runtime draft sent as a cursor, since
 * only this host may turn one into a position.
 */
export const admitListCursor = (input: unknown, scope: ListCursorScope): ListCursorAdmission => {
  const cursor: unknown =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? Reflect.get(input, "cursor")
      : undefined;
  if (cursor === undefined || cursor === null || cursor === "") return { ok: true, list: {} };
  if (typeof cursor !== "string") return refused("malformed");
  const parts = cursor.split(".");
  const [prefix, keyId, body, signature] = parts;
  if (prefix !== wirePrefix) {
    const otherVersion = prefix !== undefined && /^pc\d+$/u.test(prefix) && parts.length >= 2;
    return refused(otherVersion ? "version" : "malformed");
  }
  if (
    cursor.length > listCursorMaxLength ||
    parts.length !== 4 ||
    keyId === undefined ||
    body === undefined ||
    signature === undefined ||
    !/^[A-Za-z0-9_-]+$/u.test(body) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(signature)
  )
    return refused("malformed");
  const key = [scope.keys.current, ...(scope.keys.previous ?? [])].find(
    (candidate) => candidate.id === keyId,
  );
  if (key === undefined) return refused("unknown_key");
  const expected = mac(key, `${wirePrefix}.${keyId}.${body}`);
  const given = Buffer.from(signature, "base64url");
  if (given.byteLength !== expected.byteLength || !timingSafeEqual(given, expected))
    return refused("altered");
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    // error-reporting-allow: parse-predicate a signed body that is not JSON is malformed
  } catch {
    return refused("malformed");
  }
  if (typeof payload !== "object" || payload === null || Reflect.get(payload, "v") !== 1)
    return refused("version");
  const decoded = Schema.decodeUnknownEither(SignedCursor, { onExcessProperty: "error" })(payload);
  if (Either.isLeft(decoded)) return refused("malformed");
  const signed = decoded.right;
  const bound = bindings(key, input, scope);
  if (signed.op !== bound?.op) return refused("other_tool");
  if (signed.sub !== bound.sub) return refused("other_account");
  if (signed.ih !== bound.ih) return refused("inputs_changed");
  // A cursor ends at its own expiry, and never later than this host's lifetime after it was
  // issued, with a few seconds for clocks that differ: a host with a longer lifetime may have
  // signed it.
  const ends = Math.min(signed.exp * 1000, signed.iat * 1000 + listCursorTtlMs + clockSkewMs);
  if (scope.now >= ends) return refused("expired");
  if (signed.pos.href !== undefined && !onSite(signed.pos.href, scope.siteOrigin))
    return refused("off_site");
  const { v: _v, op: _op, ih: _ih, sub: _sub, iat: _iat, exp: _exp, ...draft } = signed;
  return { ok: true, list: { position: draft } };
};

/** Why a host dropped a script's next cursor instead of signing it. */
export type DroppedListCursor = Extract<
  ListCursorUnavailable,
  "not_a_draft" | "off_site" | "inputs_not_json"
>;

/**
 * Signs the `next_cursor` a run's output holds and fills `next_cursor_expires_at`,
 * `listCursorTtlMs` (ten minutes) from `now`. `input` is the caller's input for the run, as sent.
 * Only a runtime draft is signed; an absent or null next cursor leaves the output unchanged. A
 * next cursor in any other form or of any other type, which `admitListCursor` would refuse if a
 * caller sent it back, a draft that does not decode, and a draft whose site link is off the
 * tool's site are dropped: `next_cursor` becomes null and `dropped` says why. `has_more` stays as
 * the output gave it, true unless it is false (an output without it gets `has_more: true`), and
 * when it is true `next_cursor_unavailable` says why too. Every valid draft fits in a cursor, so
 * none is dropped for its size.
 */
export const sealListOutput = (
  output: unknown,
  input: unknown,
  scope: ListCursorScope,
): { readonly output: unknown; readonly dropped?: DroppedListCursor } => {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return { output };
  const fields = output as Record<string, unknown>;
  const next = fields["next_cursor"];
  if (next === undefined || next === null) return { output };
  const drop = (dropped: DroppedListCursor) => {
    const hasMore = fields["has_more"] !== false;
    return {
      output: {
        ...fields,
        next_cursor: null,
        next_cursor_expires_at: null,
        has_more: hasMore,
        ...(hasMore ? { next_cursor_unavailable: dropped } : {}),
      },
      dropped,
    };
  };
  const draft = decodeListDraft(next);
  if (draft === undefined) return drop("not_a_draft");
  if (draft.pos.href !== undefined && !onSite(draft.pos.href, scope.siteOrigin))
    return drop("off_site");
  const key = scope.keys.current;
  const bound = bindings(key, input, scope);
  if (bound === undefined) return drop("inputs_not_json");
  const issued = Math.floor(scope.now / 1000);
  const expires = issued + listCursorTtlMs / 1000;
  const body = Buffer.from(
    JSON.stringify(
      Schema.encodeSync(SignedCursor)({ v: 1, ...bound, iat: issued, exp: expires, ...draft }),
    ),
  ).toString("base64url");
  const signed = `${wirePrefix}.${key.id}.${body}`;
  return {
    output: {
      ...fields,
      next_cursor: `${signed}.${mac(key, signed).toString("base64url")}`,
      next_cursor_expires_at: new Date(expires * 1000).toISOString(),
    },
  };
};
