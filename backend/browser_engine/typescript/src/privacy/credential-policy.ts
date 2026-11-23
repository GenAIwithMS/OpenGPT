/*
 * The credential policy: one description of the credential shapes that
 * every deterministic masking sink uses. A rule masks by structure, never an ordinary word,
 * because a false positive is worse than a rare miss. A credential-named key, an auth or cookie
 * header or a scheme word only says where a credential may be; the value decides.
 *
 * - A single ordinary word is never a credential by shape (`password: required`, `Bearer token`,
 *   `Authorization: failed`). A real common-word password is still masked where it is known,
 *   as a registered or contextual value.
 * - A field named only `token`, `secret`, `pass` or `pin` is not masked for its name.
 * - URLs stay raw except a userinfo password and a database URL's `password` query value.
 * - Outside a header, `Bearer` and `Basic` are ordinary English ("Basic information", "Bearer of
 *   bad news"), so a bare scheme's value must look like a token.
 *
 * This module has no imports and uses only ES2017 regular-expression syntax plus lookbehind,
 * so callers can use the same masking rules without starting a runtime.
 */

export const credentialPolicy = {
  /** Values that only say whether a credential is set. */
  literalValues: ["true", "false", "null", "undefined", "none", "nil"],
  /** Names whose value is a password, even with an unseparated prefix (`PGPASSWORD`). */
  passwordNames: ["password", "passwd", "passphrase", "passcode", "pwd"],
  /**
   * Multi-word credential names, matched with an optional `-` or `_` between words and a word
   * boundary before them (`MY_API_KEY`, `userAccessToken`), so `valid_token` is not `val` +
   * `id_token`. Generic names (`token`, `secret`, `key`, `auth`, `session`) are absent.
   */
  multiWordNames: [
    ["client", "secret"],
    ["secret", "access", "key"],
    ["secret", "key"],
    ["account", "key"],
    ["security", "token"],
    ["private", "key"],
    ["api", "key"],
    ["access", "token"],
    ["refresh", "token"],
    ["id", "token"],
    ["session", "token"],
    ["auth", "token"],
    ["totp", "seed"],
    ["secret", "string"],
    ["secret", "binary"],
  ],
  /** The shell's working directory, never a password. */
  shellDirectoryNames: ["PWD", "OLDPWD"],
  /** JSON header fields whose value is a request credential unless it is one ordinary word. */
  jsonHeaderFields: ["authorization", "proxy-authorization", "cookie", "set-cookie"],
  /** Vault response fields that hold the secret itself. */
  vaultFields: ["SecretString", "SecretBinary"],
  authorizationSchemes: [
    "basic",
    "bearer",
    "digest",
    "token",
    "negotiate",
    "ntlm",
    "aws4-hmac-sha256",
    "oauth",
    "hawk",
    "hoba",
    "mutual",
    "scram-sha-1",
    "scram-sha-256",
    "vapid",
    "dpop",
    "gnap",
    "privatetoken",
    "apikey",
    "api-key",
    "key",
    "jwt",
    "mac",
    "ssws",
    "sso-key",
  ],
  /** Set-Cookie attributes, whose values (`Path=/`, `Expires=…`) are not secrets. */
  setCookieAttributes: [
    "path",
    "domain",
    "expires",
    "max-age",
    "samesite",
    "secure",
    "httponly",
    "partitioned",
    "priority",
  ],
  /** A free-text Bearer value: this long, with a letter-and-digit run this long holding a digit. */
  bearerToken: { minLength: 16, runLength: 8 },
  /** A value with no scheme or name: this long, or this long with letters and digits. */
  opaqueValue: { minLength: 16, mixedMinLength: 8 },
  /**
   * Provider key prefixes and their bodies. A `random` body must hold a 16+ letter-and-digit run
   * with a digit, or upper case with three digits, so slugs (`sk-hynix-ddr5-memory-kit`) and
   * identifiers (`bl_workspace_configuration`) stay.
   */
  providerKeys: [
    { prefixes: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"], body: "A-Za-z0-9", minBody: 20 },
    { prefixes: ["github_pat_"], body: "A-Za-z0-9_", minBody: 20 },
    { prefixes: ["sk-proj-", "sk-ant-", "sk-"], body: "A-Za-z0-9_-", minBody: 20, random: true },
    { prefixes: ["sk_live_", "sk_test_", "rk_live_", "rk_test_"], body: "A-Za-z0-9", minBody: 10 },
    { prefixes: ["xoxa-", "xoxb-", "xoxp-", "xoxr-", "xoxs-"], body: "A-Za-z0-9-", minBody: 10 },
    { prefixes: ["whsec_"], body: "A-Za-z0-9+/=", minBody: 16 },
    { prefixes: ["phx_"], body: "A-Za-z0-9", minBody: 20, random: true },
    { prefixes: ["bl_"], body: "A-Za-z0-9", minBody: 20, random: true },
  ],
  /**
   * AWS access key IDs: one of these prefixes and 16 upper-case letters or digits, with no letter
   * or digit on either side. An underscore may touch one (`KEY_AKIA…`).
   */
  awsAccessKeyIdPrefixes: ["AKIA", "ASIA"],
} as const;

type Span = { readonly start: number; readonly end: number };

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const alternation = (words: readonly string[]) => words.map(escapeRegExp).join("|");
const wordSet = (words: readonly string[], flags: string) =>
  new RegExp(`^(?:${alternation(words)})$`, flags);

const trailingPunctuation = /[.,;:!?)\]}]+$/u;
const ordinaryWord = /^(?:[a-z]+|[A-Z][a-z]*|[A-Z]+)(?:[-'](?:[a-z]+|[A-Z][a-z]*|[A-Z]+))*$/u;

/**
 * One ordinary word, or words joined by `-` or `'`: letters only, in lowercase, Capitalized or
 * upper case (`required`, `Missing`, `NONE`, `case-sensitive`), with trailing sentence
 * punctuation ignored. No credential format looks like this.
 */
export const isOrdinaryWord = (value: string): boolean =>
  ordinaryWord.test(value.replace(trailingPunctuation, ""));

const literalValue = wordSet(credentialPolicy.literalValues, "iu");

/** Values that only say whether a credential is set. */
export const isLiteralValue = (value: string): boolean => literalValue.test(value);

/**
 * A credential key's value that stays: a literal, or one ordinary word after `key: ` with a space,
 * which is how prose and validation messages read (`password: required`, `api_key: missing`).
 * `key=value`, quoted and JSON string values are always credentials.
 */
export const isOrdinaryKeyValue = (separator: string, value: string): boolean =>
  isLiteralValue(value) || (/:[ \t]+$/u.test(separator) && isOrdinaryWord(value));

/** Whether some letter-and-digit run of at least `length` characters holds a digit. */
const hasRandomRun = (value: string, length: number) =>
  (value.match(/[A-Za-z0-9]+/gu) ?? []).some((run) => run.length >= length && /[0-9]/u.test(run));

/** A free-text Bearer value: long, with a random letter-and-digit run, never a word or slug. */
export const isBearerToken = (value: string): boolean =>
  value.length >= credentialPolicy.bearerToken.minLength &&
  /^[A-Za-z0-9._~+/=-]+$/u.test(value) &&
  hasRandomRun(value, credentialPolicy.bearerToken.runLength);

const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** A Basic credential decodes to printable `user:password` with a non-empty user; words do not. */
export const isBasicCredential = (value: string): boolean => {
  const body = value.replace(/={1,2}$/u, "");
  if (!/^[A-Za-z0-9+/]{4,}$/u.test(body) || body.length % 4 === 1) return false;
  let buffer = 0;
  let bits = 0;
  let decoded = "";
  for (const character of body) {
    buffer = ((buffer << 6) | base64Alphabet.indexOf(character)) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      decoded += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return /^[\x20-\x7e]+$/u.test(decoded) && decoded.indexOf(":") >= 1;
};

/** Whether a free-text `Bearer x` or `Basic x` value (any case) is a credential. */
export const isFreeTextSchemeCredential = (scheme: string, value: string): boolean =>
  /^bearer$/iu.test(scheme) ? isBearerToken(value) : isBasicCredential(value);

/**
 * An `sk-` key is random: a 16+ letter-and-digit run holding a digit, or upper case with three or
 * more digits. Slugs such as `sk-hynix-ddr5-memory-kit` or `sk-onboarding-step-2026` are not keys.
 */
export const isRandomKeyBody = (value: string): boolean =>
  (/[A-Z]/u.test(value) && (value.match(/[0-9]/gu) ?? []).length >= 3) || hasRandomRun(value, 16);

type KeyShape = (typeof credentialPolicy.providerKeys)[number];
const isRandomShape = (shape: KeyShape): boolean => "random" in shape && shape.random;
/** A body's separators: its characters other than letters, digits and `_` (`-`, or `+/=`). */
const separatorsOf = (body: string) => body.replace(/A-Z|a-z|0-9|_/gu, "");
/** Words as one regular-expression term: the word itself, or a group of alternatives. */
const oneOf = (words: readonly string[]) =>
  words.length === 1 ? escapeRegExp(words[0] ?? "") : `(?:${alternation(words)})`;
/**
 * A character class, written with `\w` and `\d` where they fit, which keeps the pattern short:
 * `matchAll` copies a pattern on every call, at a cost that grows with its length.
 */
const characters = (body: string) => {
  const short = body.replace("A-Za-z0-9_", "\\w").replace("0-9", "\\d");
  return short === "\\w" ? short : `[${short}]`;
};
const escapedClass = (text: string) => characters(text.replace(/[-\]^\\]/gu, "\\$&"));
/** Whether a body's characters cover every character of `text`. */
const reads = (body: string, text: string) => new RegExp(`^[${body}]*$`, "u").test(text);
const printable = Array.from({ length: 95 }, (_, offset) => String.fromCharCode(32 + offset));

/**
 * `isRandomKeyBody` over a body's whole run of characters, as a lookahead at its start. A body of
 * only letters and digits, at least 16 long, is one run, so it is random when it holds a digit.
 */
const randomBodyCheck = (body: string, minBody: number) => {
  const others = (body.includes("_") ? "_" : "") + separatorsOf(body);
  if (others === "" && minBody >= 16) return "(?=[A-Za-z]*\\d)";
  const runStart = others === "" ? "" : `(?:[A-Za-z\\d]*${escapedClass(others)})*?`;
  const any = characters(body);
  return `(?:(?=${any}*?[A-Z])(?=(?:${any}*?\\d){3})|(?=${runStart}(?=[A-Za-z\\d]{16})[A-Za-z]*\\d))`;
};

/**
 * A word start: no letter, digit or `_` before the key. Before a letter, digit or `_`, which every
 * listed prefix starts with, `\b` is that same boundary, and the engine reads it faster.
 */
const wordStart = credentialPolicy.providerKeys.every(({ prefixes }) =>
  prefixes.every((prefix) => /^\w/u.test(prefix)),
)
  ? "\\b"
  : "(?<!\\w)";

/** Whether `inner`'s body holds a character that `outer`'s body lacks. */
const widerBody = (inner: KeyShape, outer: KeyShape) =>
  printable.some((character) => reads(inner.body, character) && !reads(outer.body, character));

/**
 * The keys of the listed shapes that `select` picks, by prefix, as one alternation. `check` checks
 * each as `isProviderKey` does: its length, and a random body where its shape needs one. A key read
 * `into` another body is read to the end of its own. Prefixes with the same rest share one term.
 */
const keyTerms = (
  select: (inner: KeyShape, prefix: string) => boolean,
  check: boolean,
  into?: KeyShape,
): string => {
  const prefixesByRest = new Map<string, string[]>();
  for (const inner of credentialPolicy.providerKeys) {
    const prefixes = inner.prefixes.filter((prefix) => select(inner, prefix));
    if (prefixes.length === 0) continue;
    const body = characters(inner.body);
    const random = check && isRandomShape(inner) ? randomBodyCheck(inner.body, inner.minBody) : "";
    const length = check ? `(?=${body}{${String(inner.minBody)}})` : "";
    const rest = `${length}${random}${into === undefined ? "" : bodyLoop(inner, into)}`;
    prefixesByRest.set(rest, [...(prefixesByRest.get(rest) ?? []), ...prefixes]);
  }
  return [...prefixesByRest].map(([rest, prefixes]) => `${oneOf(prefixes)}${rest}`).join("|");
};

/**
 * A key body after its prefix, read as far as its characters run, so no key loses its tail. A
 * key written in the body that the body could not read whole is read whole by its own rule:
 *
 * - A random body is never cut, since its first part may not be random alone. At its start and
 *   after each separator it reads such a key that needs no random body into itself
 *   (`sk-…-whsec_…+…`), and `isProviderKey` accepts a match that holds a key.
 * - Any other body, at each word start in it, reads in a key whose prefix it reads but whose
 *   body it does not (`xoxb-…-sk-…_…`). A separator ends it only before a key whose prefix it
 *   cannot read (`whsec_…/ghp_…`), so both keys are found and masked whole. Read `within` another
 *   body, it ends only before a key that body cannot read whole either (`sk-…-whsec_…=whsec_…`).
 *
 * Every other key shape is more of the same key (`sk-proj-…-bl_…_…`). Each run of letters and
 * digits is read at once, so the keys it may read in are tried only where a run starts or ends.
 * A run is read only to its end, so a pattern built on this one that fails after a body gives
 * the run back whole rather than trying every split of it.
 */
function bodyLoop(shape: KeyShape, within: KeyShape = shape): string {
  const { body } = shape;
  const separators = separatorsOf(body);
  const all = `${characters(body)}*`;
  if (separators === "") return all;
  const word = characters(body.slice(0, body.length - separators.length));
  const separator = escapedClass(separators);
  if (isRandomShape(shape)) {
    const held = keyTerms(
      (inner, prefix) => !isRandomShape(inner) && (!reads(body, prefix) || widerBody(inner, shape)),
      true,
      shape,
    );
    return held === "" ? all : `(?:${held})?(?:${word}+(?!${word})|${separator}(?:${held})?)*`;
  }
  const take = keyTerms(
    (inner, prefix) => reads(body, prefix) && widerBody(inner, shape),
    false,
    shape,
  );
  const cut = keyTerms(
    (inner, prefix) =>
      !reads(body, prefix) && (!reads(within.body, prefix) || widerBody(inner, within)),
    true,
  );
  if (take === "" && cut === "") return all;
  const taken = take === "" ? "" : `${wordStart}(?:${take})|`;
  return `(?:${taken}${word}+(?!${word})|${separator}${cut === "" ? "" : `(?!${cut})`})*`;
}

/**
 * A key body: at least `minBody` of its characters, then the body as `bodyLoop` reads it. A part
 * shorter than `minBody` before a key the body stops at still counts on its own wherever the
 * body's characters, read through every separator, run `minBody` long.
 */
const bodyPattern = (shape: KeyShape) => {
  const all = characters(shape.body);
  const loop = bodyLoop(shape);
  if (loop === `${all}*`) return `${all}{${String(shape.minBody)},}`;
  return `(?=${all}{${String(shape.minBody)}})${loop}`;
};
// Only a body with a separator can hold another key after one.
const providerShapes = credentialPolicy.providerKeys.flatMap((shape) =>
  shape.prefixes.map((prefix) => ({
    prefix,
    random: isRandomShape(shape),
    holds: separatorsOf(shape.body) !== "",
  })),
);
// One alternative per shape, its prefixes in list order, keeps the pattern short.
const providerKeySource = `${wordStart}(?:${credentialPolicy.providerKeys
  .map((shape) => `${oneOf(shape.prefixes)}${bodyPattern(shape)}`)
  .join("|")})`;
/**
 * A key that needs no random body, written after a separator of a random body (`sk-…-xoxb-…`).
 * The random body reads it as its own, so a match that holds one is a key.
 */
const heldKey = new RegExp(
  `${escapedClass(
    credentialPolicy.providerKeys
      .filter(isRandomShape)
      .map(({ body }) => separatorsOf(body))
      .join(""),
  )}(?:${credentialPolicy.providerKeys
    .filter((shape) => !isRandomShape(shape))
    .map(({ prefixes, body, minBody }) => `${oneOf(prefixes)}${characters(body)}{${String(minBody)}}`)
    .join("|")})`,
  "u",
);

/**
 * Provider API keys, by prefix and body, starting at a word boundary. Each match
 * must also pass `isProviderKey`, which checks a random body. Longer prefixes come first
 * (`sk-proj-` before `sk-`). Match with the pattern as returned. A pattern built on its source
 * with an anchor or assertion after it can take exponential time on text with several keys
 * written into one key.
 */
export const providerKeyPattern = (): RegExp => new RegExp(providerKeySource, "gu");

/**
 * Whether a `providerKeyPattern` match is a key rather than a slug or an identifier. A random
 * shape's match is a key when its body is random or it holds a key that needs no random body.
 */
export const isProviderKey = (match: string): boolean => {
  const shape = providerShapes.find((candidate) => match.startsWith(candidate.prefix));
  return (
    shape !== undefined &&
    (!shape.random ||
      isRandomKeyBody(match.slice(shape.prefix.length)) ||
      (shape.holds && heldKey.test(match)))
  );
};

/** AWS access key IDs (`AKIA…`, `ASIA…`) with no letter or digit on either side. */
export const awsAccessKeyIdPattern = (): RegExp =>
  new RegExp(
    `(?<![A-Za-z0-9])(?:${alternation(credentialPolicy.awsAccessKeyIdPrefixes)})[0-9A-Z]{16}(?![A-Za-z0-9])`,
    "gu",
  );

const multiWordNameSources = credentialPolicy.multiWordNames.map((words) => words.join("[-_]?"));

/**
 * Every credential name as a regular-expression alternation, for any case: the password names,
 * then the multi-word names with an optional separator between words. A surface adds its own
 * prefix grammar and confirms the key with `isCredentialAssignmentKey`.
 */
export const credentialNameSource = [
  ...credentialPolicy.passwordNames,
  ...multiWordNameSources,
].join("|");

const passwordNameEnd = new RegExp(`(?:${alternation(credentialPolicy.passwordNames)})$`, "iu");
const multiWordName = new RegExp(`^(?:${multiWordNameSources.join("|")})$`, "iu");
const shellDirectoryName = wordSet(credentialPolicy.shellDirectoryNames, "u");

/**
 * Whether a key names a credential by its words. A password name may carry an unseparated prefix
 * (`PGPASSWORD`, `dbpassword`); a multi-word name needs a separator or a camelCase step before it
 * (`MY_API_KEY`, `userAccessToken`), so `valid_token` is not `val` + `id_token`. The shell's
 * `PWD` and `OLDPWD` are directories.
 */
export const isCredentialAssignmentKey = (key: string): boolean => {
  if (shellDirectoryName.test(key)) return false;
  if (passwordNameEnd.test(key)) return true;
  for (let start = 0; start < key.length; start += 1) {
    const before = key.charAt(start - 1);
    const boundary =
      start === 0 ||
      before === "-" ||
      before === "_" ||
      (/[a-z0-9]/u.test(before) && /[A-Z]/u.test(key.charAt(start)));
    if (boundary && multiWordName.test(key.slice(start))) return true;
  }
  return false;
};

/** An Azure Storage connection string; outside one, `account_key` is often a business id. */
const azureConnection = /DefaultEndpointsProtocol=|AccountName=|\.core\.windows\.net/iu;

/**
 * A short business identifier (`ACME-123`), which is what `account_key` names outside Azure. A
 * random 16-24 character secret keeps an 8+ letter-and-digit run holding a digit, and an
 * 88-character storage key is too long, so both are still masked.
 */
const isShortIdentifier = (value: string) => {
  const content = value.replace(/^\\?["']|\\?["']$/gu, "");
  return /^[A-Za-z0-9_-]{1,24}$/u.test(content) && !hasRandomRun(content, 8);
};

/**
 * Whether a credential-named assignment keeps its value: a literal or one word after `key: `, a
 * container after `:` (a JSON value, whose own leaves are screened where they are), or an
 * `account_key` holding a short identifier outside an Azure connection string. `text` is the
 * whole input, which says whether it is an Azure connection string.
 */
export const isKeptAssignmentValue = (
  key: string,
  separator: string,
  value: string,
  text: string,
): boolean =>
  (!/^\\?["']/u.test(value) && isOrdinaryKeyValue(separator.replace(/^\\?["']/u, ""), value)) ||
  (/^[[{]/u.test(value) && separator.includes(":")) ||
  (/account[-_]?key$/iu.test(key) && !azureConnection.test(text) && isShortIdentifier(value));

/**
 * A bracketed value after `=` (`password=[…]`, `password={…}`) as one token, closing bracket
 * included: quotes, spaces and commas inside stay part of it (`["…"]`, `[ … ]`, `[a,b]`). A
 * surface puts it first among its value alternatives.
 */
export const bracketedValueSource = String.raw`\[[^\]\r\n]*\]|\{[^}\r\n]*\}`;

const authorizationScheme = wordSet(credentialPolicy.authorizationSchemes, "iu");

/** Whether the word after a scheme is its credential: any non-word after a known scheme. */
const isSchemeCredential = (scheme: string, known: boolean, token: string): boolean =>
  known
    ? !isOrdinaryWord(token) || (/^basic$/iu.test(scheme) && isBasicCredential(token))
    : isOrdinaryWord(scheme) && isBearerToken(token);

/** A value with no scheme is a credential when it is opaque: 16+, or 8+ with letters and digits. */
const isOpaqueValue = (value: string): boolean =>
  !isOrdinaryWord(value) &&
  (value.length >= credentialPolicy.opaqueValue.minLength ||
    (value.length >= credentialPolicy.opaqueValue.mixedMinLength &&
      /[0-9]/u.test(value) &&
      /[A-Za-z]/u.test(value)));

/** The credential after a scheme word, or undefined when that word is followed by prose. */
const schemeCredential = (
  value: string,
  first: string,
  known: boolean,
  next: RegExpExecArray,
): Span | undefined => {
  const token = next[1] ?? "";
  const start = first.length + next[0].length - token.length;
  const toEnd = { start, end: value.trimEnd().length };
  // Auth-params may put whitespace around `=` (RFC 7616 BWS): `Digest username = "ada", …`.
  if (known && /^[ \t]+[A-Za-z][\w-]*[ \t]*=/u.test(value.slice(first.length))) return toEnd;
  if (!isSchemeCredential(first, known, token)) return undefined;
  // Auth-params (`Credential=…, Signature=…`) run to the end of the value.
  return /^[A-Za-z][\w-]*=[^=]/u.test(token) ? toEnd : { start, end: start + token.length };
};

/**
 * The credential inside an `Authorization` or `Proxy-Authorization` header value, as offsets into
 * `value`, or undefined for prose such as `Authorization: failed because the token expired`.
 * After a known scheme any value that is not an ordinary word is the credential; after another
 * word only a token-shaped value is; with no scheme, an opaque value is. Auth-params
 * (`Credential=…, Signature=…`) run to the end of the value; a token68 is one token.
 */
export const authorizationCredential = (value: string): Span | undefined => {
  const first = /^[^\s,;]+/u.exec(value)?.[0];
  if (first === undefined) return undefined;
  const known = authorizationScheme.test(first);
  const next = /^[ \t]+([^\s,;]+)/u.exec(value.slice(first.length));
  const found = next === null ? undefined : schemeCredential(value, first, known, next);
  if (found !== undefined) return found;
  return !known && isOpaqueValue(first) ? { start: 0, end: first.length } : undefined;
};

const setCookieAttribute = wordSet(credentialPolicy.setCookieAttributes, "iu");
/** A cookie name; empty only directly before `=` and a letter or digit (`=value; x=1`). */
const cookieName = /^(?:[^\s=;,"'\\]+|(?==[A-Za-z0-9]))/u;
/**
 * A cookie value: DQUOTE-wrapped (RFC 6265: no `;` or `, ` inside, and the closing quote is
 * followed by whitespace, a separator or the end, so a later cookie's quote never closes an
 * earlier one, as in `a="x; b="y; sid=…`), unterminated in truncated text (it ends where a
 * bare value would, at whitespace or a separator, so `sid="abc then the request failed` keeps
 * its prose and `note="x; sid=…` still reaches `sid`), an `Expires` date
 * (IMF-fixdate, RFC 850 or asctime), or bare octets. A comma inside a bare value
 * (`consent=analytics,ads`) continues it; a comma and whitespace (`Headers.get` joins Set-Cookie
 * values with `", "`) ends it.
 */
const cookieValue =
  /^(?:"(?:[^"\r\n;,]|,(?![ \t]))*"(?=[\s;,]|$)|"(?:[^\s;,]|,(?![ \t]))*|[A-Za-z]{3,9},[ \t]*\d{1,2}[ -][A-Za-z]{3}[ -]\d{2,4}[ \t]+\d{2}:\d{2}:\d{2}[ \t]+GMT|[A-Za-z]{3}[ \t]+[A-Za-z]{3}[ \t]+\d{1,2}[ \t]+\d{2}:\d{2}:\d{2}[ \t]+\d{4}|(?:[^\s;,"'\\]|,(?![ \t]))*)/u;

/** A pair value's span inside its quotes, if any, or undefined when it is empty. */
const pairValue = (raw: string, valueStart: number): Span | undefined => {
  const opened = raw.startsWith('"');
  const closed = opened && raw.length >= 2 && raw.endsWith('"');
  const start = valueStart + (opened ? 1 : 0);
  const end = valueStart + raw.length - (closed ? 1 : 0);
  return end > start ? { start, end } : undefined;
};

/**
 * Whether a pair's value stays. A Set-Cookie attribute's value is never a credential. A request
 * cookie named like one (`Cookie: domain=…`) is a cookie, but only an opaque value counts, so
 * `Cookie: domain=example.com mismatch` stays prose. After a leading valueless word
 * (`cookie: rejected; reason=expired`), an ordinary-word value shorter than the opaque length
 * stays too; `flag; sid=synthlettersonlysessionvalue` is still masked.
 */
const keptCookieValue = (
  name: string,
  content: string,
  setCookie: boolean,
  afterProse: boolean,
): boolean =>
  setCookieAttribute.test(name)
    ? setCookie || !isOpaqueValue(content)
    : afterProse &&
      isOrdinaryWord(content) &&
      content.length < credentialPolicy.opaqueValue.minLength;

/** One `name[=value]` segment at `position`: where it ends and its masked value's span, if any. */
const cookieSegment = (
  value: string,
  position: number,
  setCookie: boolean,
  afterProse: boolean,
): { readonly end: number; readonly pair: boolean; readonly value?: Span } | undefined => {
  const name = cookieName.exec(value.slice(position))?.[0];
  if (name === undefined) return undefined;
  const afterName = position + name.length;
  // `sid = "…"`: whitespace may surround the equals sign.
  const equals = /^[ \t]*=[ \t]*/u.exec(value.slice(afterName))?.[0];
  if (equals === undefined) return { end: afterName, pair: false };
  const valueStart = afterName + equals.length;
  const raw = cookieValue.exec(value.slice(valueStart))?.[0] ?? "";
  const span = pairValue(raw, valueStart);
  const end = valueStart + raw.length;
  if (span === undefined) return { end, pair: true };
  return keptCookieValue(name, value.slice(span.start, span.end), setCookie, afterProse)
    ? { end, pair: true }
    : { end, pair: true, value: span };
};

/**
 * The separator after a segment: `;` (empty segments included, `a=x;; sid=…` and `a=1; ; sid=…`),
 * or a comma and whitespace before the next `name=`.
 */
const cookieSeparator = (value: string, position: number): number | undefined =>
  (/^[ \t]*;[ \t;]*/u.exec(value.slice(position)) ??
    /^[ \t]*,[ \t]+(?=[^\s=;,"'\\]+[ \t]*=)/u.exec(value.slice(position)))?.[0].length;

/** A Cookie value with no `name=value` pair counts only when it is opaque. */
const opaqueCookie = (value: string) => {
  const first = /^[^\s;,"'\\]+/u.exec(value)?.[0];
  return first !== undefined && !first.includes("=") && isOpaqueValue(first)
    ? { run: { start: 0, end: first.length }, values: [{ start: 0, end: first.length }] }
    : undefined;
};

/**
 * The `name=value` pairs of a Cookie or Set-Cookie header value: the run from the first masked
 * pair and the value of each masked pair (quotes excluded). The run continues across `;`
 * segments and across `, name=` with a space (a comma-joined Set-Cookie, as `Headers.get`
 * returns it), so `theme=dark; Path=/, session=…` loses both values. Leading valueless words
 * before `;` stay outside the run (`flag; [sid]`, `blocked; reason=third-party`). A value with no
 * pair is masked only when it is opaque. Prose such as `cookie: invalid format` has neither.
 */
export const cookieCredentials = (
  value: string,
  setCookie: boolean,
): { readonly run: Span; readonly values: readonly Span[] } | undefined => {
  const values: Span[] = [];
  let position = 0;
  let start: number | undefined;
  let end = 0;
  let paired = false;
  let afterProse = false;
  for (;;) {
    const segment = cookieSegment(value, position, setCookie, afterProse);
    if (segment === undefined) break;
    const separator = cookieSeparator(value, segment.end);
    // Before the first pair, a valueless segment is skipped only before `;` (`flag; sid=…`),
    // so `cookie: invalid format` is not a run.
    if (!segment.pair && !paired) {
      if (!/^[ \t]*;/u.test(value.slice(segment.end))) break;
      afterProse = true;
    }
    paired ||= segment.pair;
    if (segment.value !== undefined) {
      values.push(segment.value);
      start ??= position;
    }
    end = segment.end;
    if (separator === undefined) break;
    position = end + separator;
  }
  return start !== undefined ? { run: { start, end }, values } : opaqueCookie(value);
};
