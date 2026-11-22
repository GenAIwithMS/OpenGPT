import {
  awsAccessKeyIdPattern,
  isCredentialAssignmentKey,
  isFreeTextSchemeCredential,
  isProviderKey,
  providerKeyPattern,
} from "./credential-policy.js";

/**
 * URL spans that screening must leave byte-exact. By user decision every part of a URL (scheme,
 * username, host, path, query, fragment, nested URLs) stays raw in all readable, stored and log
 * copies, because browser navigation and HTTP requests need the whole URL. Nothing inside these
 * spans is masked, aliased or registered.
 *
 * So a URL must end where it really ends, or the text glued to it escapes screening. Core screens
 * only credentials outside URLs, so a URL ends early only where a credential or a structural
 * closer begins. A URL runs to the next space, quote or angle bracket and loses trailing sentence
 * punctuation, and ends earlier at:
 * - an unbalanced `)`, `]` or `}` (balanced ones, as in `/wiki/Foo_(bar)`, stay, trimming
 *   included);
 * - a backslash escape other than `\/`, `\u` or `\x`;
 * - a character reference to a quote or an angle bracket, such as `&lt;`, `&quot;` or `&#x22;`,
 *   or one escaped again for markup, such as `&amp;lt;`: what it stands for ends a URL;
 * - a `,`, `;` or `|` whose next field starts with a credential: a credential-named `key=` or
 *   `key:` (`,password=…`), a bearer or basic credential, an AWS access key ID, a provider API key
 *   or a JSON Web Token, in the path, query or fragment alike. A `;` that closes any other
 *   character reference, such as `&amp;`, `&nbsp;` or the chained `&amp;amp;`, is no delimiter.
 *
 * Every other field stays part of the URL, so lists of dates, numbers, addresses or names in a
 * path or query (`?dates=2026-01-31,2026-02-07&otp=…`), matrix parameters (`;v=1`) and a URL in a
 * CSV row stay whole. A URL found inside another never extends it. The rules read a bounded
 * window at each delimiter, so the scan stays linear.
 */
export interface UrlSpan {
  readonly start: number;
  readonly end: number;
}

const trailingProse = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}", "\\"]);
const terminator = /[\s"'`<>]/u;

/** A URL candidate's end without the sentence punctuation after it, by a scan back to `floor`. */
const trimmedEnd = (text: string, floor: number, end: number) => {
  let trimmed = end;
  while (trimmed > floor && trailingProse.has(text[trimmed - 1] ?? "")) trimmed--;
  return trimmed;
};

const schemeRelativeHost = (candidate: string) => {
  const authority = candidate.slice(2).split(/[/?#\\]/u)[0] ?? "";
  return authority.includes(".") || authority.includes("@") || /:\d+$/u.test(authority);
};

const writtenAuthority = /[^/?#\\\s"'`<>]*/uy;
const reach = /[^\s"'`<>]*/uy;

/**
 * Whether the scheme-relative candidate at `start` names a host, read from its authority as
 * written, before any boundary rule or trimming shortens it, as `//host)` or `//host:1:` is.
 */
const writtenSchemeRelativeHost = (text: string, start: number) => {
  writtenAuthority.lastIndex = start + 2;
  return schemeRelativeHost(`//${writtenAuthority.exec(text)?.[0] ?? ""}`);
};

// Where each kind of URL starts; `urlEnd` finds where it ends. Scheme URLs (JSON-escaped
// `https:\/\/` included) and schemeless `www.` hosts. The scheme is bounded, so each position
// costs a fixed amount and the scan is linear.
const absoluteStart =
  /(?<![A-Za-z0-9])(?:[a-z][a-z0-9+.-]{1,31}:(?:\/\/|\\\/\\\/)|www\.)(?=[^\s"'`<>])/giu;
const schemeRelativeStart = /(?<![A-Za-z0-9+.:/\\-])\/\/(?=[^\s"'`<>])/gu;

const openers = "([{";
const closers = ")]}";

/**
 * The `;` at `index` ends a character reference such as `&amp;`, `&#38;` or `&#x26;`, or one
 * escaped again for markup, such as `&amp;amp;`, `&amp;#x26;` or `&amp;nbsp;`.
 */
const endsEntity = (text: string, index: number) =>
  /&(?:amp;){0,3}(?:amp|nbsp|#\d{1,6}|#x[0-9a-f]{1,6})$/iu.test(
    text.slice(Math.max(0, index - 24), index),
  );

const nextField = /[^\r\n,;|"'`<>]{0,64}/uy;

/**
 * The field after the delimiter at `index`, to the next delimiter or line end and at most 64
 * characters, and the key of the `key=` or `key:` that starts it.
 */
const fieldAfter = (text: string, index: number) => {
  nextField.lastIndex = index + 1;
  const field = nextField.exec(text)?.[0] ?? "";
  return { field, key: /^([A-Za-z_][\w.-]*)\s*[=:]/u.exec(field)?.[1] };
};

const sticky = (pattern: RegExp) => new RegExp(pattern.source, "uy");
const awsKeyStart = sticky(awsAccessKeyIdPattern());
const providerKeyStart = sticky(providerKeyPattern());
const schemeCredentialStart = /^(bearer|basic)[ \t]+([A-Za-z0-9._~+/=-]+)/iu;
const jwtStart = /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/u;

/** The match of a sticky `pattern` at the start of `field`. */
const matchAtStart = (pattern: RegExp, field: string) => {
  pattern.lastIndex = 0;
  return pattern.exec(field)?.[0];
};

/** A field that starts with an opaque credential, by the shapes diagnostic redaction removes. */
const startsCredential = (field: string) => {
  const scheme = schemeCredentialStart.exec(field);
  if (scheme !== null && isFreeTextSchemeCredential(scheme[1] ?? "", scheme[2] ?? "")) return true;
  if (jwtStart.test(field) || matchAtStart(awsKeyStart, field) !== undefined) return true;
  const providerKey = matchAtStart(providerKeyStart, field);
  return providerKey !== undefined && isProviderKey(providerKey);
};

/** What follows the delimiter at `index` is a credential, not more of the URL. */
const startsCredentialField = (text: string, index: number) => {
  const { field, key } = fieldAfter(text, index);
  return (key !== undefined && isCredentialAssignmentKey(key)) || startsCredential(field);
};

/** A URL scan's state: open bracket counts and the trim floor. */
interface Scan {
  readonly depths: number[];
  floor: number;
}

/** The bracket at `index` ends the URL: an unbalanced closer. A balanced one raises the floor. */
const bracketEnds = (scan: Scan, character: string, index: number) => {
  const opened = openers.indexOf(character);
  if (opened !== -1) scan.depths[opened] = (scan.depths[opened] ?? 0) + 1;
  const closed = closers.indexOf(character);
  if (closed === -1) return false;
  if ((scan.depths[closed] ?? 0) === 0) return true;
  scan.depths[closed] = (scan.depths[closed] ?? 0) - 1;
  scan.floor = index + 1;
  return false;
};

const isDelimiter = (text: string, index: number, character: string) =>
  character === "," || character === "|" || (character === ";" && !endsEntity(text, index));

/**
 * A reference to a double quote or an angle bracket, which end a URL, escaped again up to 3
 * times. An apostrophe is a URL character, so its references (`&#39;`) don't end one.
 */
const terminatorReference =
  /&(?:amp;){0,3}(?:lt|gt|quot|#0{0,4}(?:60|62|34)|#x0{0,4}(?:3c|3e|22));/iuy;

/** The URL ends at `index`, by the rules above. */
const endsAt = (text: string, index: number, scan: Scan) => {
  const character = text[index] ?? "";
  if (terminator.test(character)) return true;
  // A backslash escape other than JSON's `\/` (or a script's `&` and `\x26`) is a line
  // break, a tab or a quote written in a string: the URL ends before it.
  if (character === "\\" && !"/ux".includes(text[index + 1] ?? " ")) return true;
  if (character === "&") {
    terminatorReference.lastIndex = index;
    if (terminatorReference.test(text)) return true;
  }
  if (bracketEnds(scan, character, index)) return true;
  return isDelimiter(text, index, character) && startsCredentialField(text, index);
};

/**
 * Where the URL whose text starts at `bodyStart` ends (`end`, trailing punctuation trimmed, down
 * to `start` at most) and where its scan stopped (`stop`).
 */
const urlEnd = (text: string, start: number, bodyStart: number) => {
  const scan: Scan = { depths: [0, 0, 0], floor: start };
  let index = bodyStart;
  while (index < text.length && !endsAt(text, index, scan)) index++;
  return { end: trimmedEnd(text, scan.floor, index), stop: index };
};

/**
 * Sorted, disjoint ranges. A range that starts inside an earlier one is dropped: the outer URL's
 * own boundary stands, so a URL found inside it never carries it further.
 */
const disjointRanges = (ranges: UrlSpan[]): UrlSpan[] => {
  ranges.sort((left, right) => left.start - right.start);
  const disjoint: UrlSpan[] = [];
  for (const range of ranges) {
    const last = disjoint.at(-1);
    if (last === undefined || range.start >= last.end) disjoint.push(range);
  }
  return disjoint;
};

/**
 * Every URL in `text`, absolute or scheme-relative, each ending at its real boundary, sorted and
 * disjoint. Each kind's scan resumes where its last URL stopped.
 */
export const urlSpans = (text: string): UrlSpan[] => {
  if (!text.includes("/") && !/www\./iu.test(text)) return [];
  const ranges: UrlSpan[] = [];
  const scan = (pattern: RegExp, admit: (start: number, end: number) => boolean) => {
    const starts = new RegExp(pattern);
    for (let match = starts.exec(text); match !== null; match = starts.exec(text)) {
      const { end, stop } = urlEnd(text, match.index, match.index + match[0].length);
      if (!admit(match.index, end)) {
        // Like a URL read to the next space, a candidate that is none hides no URL in itself.
        reach.lastIndex = match.index;
        reach.exec(text);
        starts.lastIndex = Math.max(reach.lastIndex, match.index + 1);
        continue;
      }
      if (end > match.index) ranges.push({ start: match.index, end });
      starts.lastIndex = Math.max(stop, match.index + 1);
    }
  };
  scan(absoluteStart, () => true);
  // Both the authority as written and the URL's own must name a host: text past the URL's end
  // (`//token.`) can't make a candidate a URL, nor a shortening hide one (`//x)//host`).
  scan(
    schemeRelativeStart,
    (start, end) =>
      writtenSchemeRelativeHost(text, start) && schemeRelativeHost(text.slice(start, end)),
  );
  return disjointRanges(ranges);
};

/**
 * The URL or path that starts at `start`, such as a route at the start of a message, ending by
 * the same rules as `urlSpans`. It may be empty when `start` holds a terminator.
 */
export const urlSpanAt = (text: string, start: number): UrlSpan => ({
  start,
  end: Math.max(start, urlEnd(text, start, start + 1).end),
});

// The same starts, each read to the next space, quote or angle bracket.
const absoluteReach =
  /(?<![A-Za-z0-9])(?:[a-z][a-z0-9+.-]{1,31}:(?:\/\/|\\\/\\\/)|www\.)[^\s"'`<>]+/giu;
const schemeRelativeReach = /(?<![A-Za-z0-9+.:/\\-])\/\/[^\s"'`<>]+/gu;

/**
 * Each stretch of text a URL starts, read to the next space, quote or angle bracket and trimmed
 * of sentence punctuation, merged where stretches overlap. This is how far `urlSpans` reached
 * before URLs ended at field delimiters. It is never a screening exemption, only a measure for a
 * bound that must still accept text an older release measured that way.
 */
export const urlReaches = (text: string): UrlSpan[] => {
  if (!text.includes("/") && !/www\./iu.test(text)) return [];
  const ranges: UrlSpan[] = [];
  const add = (start: number, end: number) => {
    const trimmed = trimmedEnd(text, start, end);
    if (trimmed > start) ranges.push({ start, end: trimmed });
  };
  for (const match of text.matchAll(absoluteReach)) add(match.index, match.index + match[0].length);
  for (const match of text.matchAll(schemeRelativeReach))
    if (schemeRelativeHost(match[0])) add(match.index, match.index + match[0].length);
  ranges.sort((left, right) => left.start - right.start);
  const merged: UrlSpan[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end)
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
    else merged.push(range);
  }
  return merged;
};
