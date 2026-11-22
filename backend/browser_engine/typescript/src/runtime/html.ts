import { selectAll, selectOne as selectFirst } from "css-select";
import type { AnyNode, Document, Element } from "domhandler";
import { findAll, getOuterHTML, textContent } from "domutils";
import { Data, Effect, Either, ParseResult, Schema } from "effect";
import { parseDocument } from "htmlparser2";
import { answer, described, readText, safeMethods, unexpected } from "./http-operation.js";
import type { OperationFailure } from "./operation-failure.js";
import type { HttpFailure, SiteHttpRequest, SiteHttpService } from "./site-http.js";

/** One element of a parsed page. */
export interface HtmlNode {
  /** The element's text: entities decoded, each run of whitespace one space, trimmed. */
  readonly text: () => string;
  /** An attribute's value with entities decoded, or undefined when the element has none. */
  readonly attr: (name: string) => string | undefined;
  /** The element's own markup, the element included. */
  readonly html: () => string;
  /** Every descendant that matches a CSS selector, in document order. */
  readonly select: (css: string) => HtmlNode[];
  /** The first descendant that matches a CSS selector, or undefined when none does. */
  readonly selectOne: (css: string) => HtmlNode | undefined;
}

/** A parsed page. */
export interface HtmlDocument {
  /** Every element that matches a CSS selector, in document order. */
  readonly select: (css: string) => HtmlNode[];
  /** The first element that matches a CSS selector, or undefined when none does. */
  readonly selectOne: (css: string) => HtmlNode | undefined;
  /** The page's `<title>` text, or undefined when it has none or it is blank. */
  readonly title: () => string | undefined;
}

/** An attribute the element itself has, never a name inherited from `Object.prototype`. */
const ownAttribute = (element: Element, name: string): string | undefined =>
  Object.hasOwn(element.attribs, name) ? element.attribs[name] : undefined;

const collapsed = (node: AnyNode) => textContent(node).replace(/\s+/gu, " ").trim();

const node = (element: Element): HtmlNode => ({
  text: () => collapsed(element),
  attr: (name) => ownAttribute(element, name.toLowerCase()),
  html: () => getOuterHTML(element),
  select: (css) => selectAll<AnyNode, Element>(css, element).map(node),
  selectOne: (css) => {
    const found = selectFirst<AnyNode, Element>(css, element);
    return found === null ? undefined : node(found);
  },
});

const titleOf = (document: Document) => {
  const title = selectFirst<AnyNode, Element>("title", document);
  const text = title === null ? "" : collapsed(title);
  return text === "" ? undefined : text;
};

/**
 * Parses an HTML answer into an inert tree to read with CSS selectors. Nothing on the page runs
 * and nothing is fetched. A selector the CSS engine does not support throws.
 */
export const parseHtml = (text: string): HtmlDocument => {
  const document = parseDocument(text);
  return {
    select: (css) => selectAll<AnyNode, Element>(css, document).map(node),
    selectOne: (css) => {
      const found = selectFirst<AnyNode, Element>(css, document);
      return found === null ? undefined : node(found);
    },
    title: () => titleOf(document),
  };
};

/**
 * Where a page keeps JSON: a `<script>` element by its `id`, every `<script>` of a JSON type
 * (`ld+json` is `application/ld+json`, `json` is `application/json`), an attribute such as
 * `data-state` that holds JSON, or a global a script assigns, such as `__APP_STATE__` in
 * `window.__APP_STATE__ = {...}` or `self.__APP_STATE__ = JSON.parse("...")`.
 */
export type EmbeddedJsonSelector =
  | { readonly id: string }
  | { readonly type: "ld+json" | "json" }
  | { readonly attribute: string }
  | { readonly assignment: string };

/**
 * `embeddedJson` found no JSON where the selector points: `missing` when nothing is there or it is
 * empty, `unparsable` when it is there but is not JSON. The message names the selector and the
 * page's title.
 */
export class EmbeddedJsonFailure extends Data.TaggedError("EmbeddedJsonFailure")<{
  readonly reason: "missing" | "unparsable";
  readonly message: string;
}> {}

const selectorText = (select: EmbeddedJsonSelector) =>
  "id" in select
    ? `<script id="${select.id}">`
    : "type" in select
      ? `<script type="application/${select.type}">`
      : "attribute" in select
        ? `[${select.attribute}]`
        : `a <script> assigning ${select.assignment}`;

const escapedPattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * Where a script assigns `name`: `name =`, `window.name =`, `self.name =`, `globalThis.name =` or
 * `window["name"] =`, never `==`, a longer name or another object's property. The match ends at
 * the `=`.
 */
const assignmentPattern = (name: string) =>
  new RegExp(
    `(?:^|[^\\w$.])(?:(?:(?:window|self|globalThis)\\.)?${escapedPattern(name)}|(?:window|self|globalThis)\\[\\s*(["'])${escapedPattern(name)}\\1\\s*\\])\\s*=(?![=>])`,
    "gu",
  );

/**
 * The end of a quoted JavaScript string that starts at `start` with its quote, just past the
 * closing quote, or undefined when it never closes.
 */
const stringEnd = (text: string, start: number): number | undefined => {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === "\\") index++;
    else if (text[index] === quote) return index + 1;
  }
  return undefined;
};

/** The balanced `{...}` or `[...]` that starts at `start`, skipping brackets inside strings. */
const balancedValue = (text: string, start: number): string | undefined => {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (char === '"' || char === "'" || char === "`") {
      const end = stringEnd(text, index);
      if (end === undefined) return undefined;
      index = end - 1;
    } else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
};

const simpleEscapes: Readonly<Record<string, string>> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
};

/** A JavaScript string literal's value: its escapes decoded, `\` + newline dropped. */
const decodedString = (literal: string): string | undefined => {
  let value = "";
  for (let index = 1; index < literal.length - 1; index++) {
    const char = literal[index] ?? "";
    if (char !== "\\") {
      value += char;
      continue;
    }
    const next = literal[++index] ?? "";
    if (next === "x" || next === "u") {
      const braced = next === "u" && literal[index + 1] === "{";
      const close = braced ? literal.indexOf("}", index) : -1;
      const hex = braced
        ? literal.slice(index + 2, close)
        : literal.slice(index + 1, index + (next === "x" ? 3 : 5));
      if (!/^[0-9a-fA-F]+$/u.test(hex) || (!braced && hex.length !== (next === "x" ? 2 : 4)))
        return undefined;
      const code = Number.parseInt(hex, 16);
      if (code > 0x10ffff) return undefined;
      value += String.fromCodePoint(code);
      index = braced ? close : index + hex.length;
    } else if (next === "\n") continue;
    else if (next === "\r") {
      if (literal[index + 1] === "\n") index++;
    } else value += simpleEscapes[next] ?? next;
  }
  return value;
};

/**
 * The JSON text a script assigns to `name`: the object or array literal after the `=`, or the
 * string a `JSON.parse("...")` there decodes, for each assignment in source order. The scan is
 * linear: matching goes on after each value it read, and stops at a value that never closes, since
 * nothing after it can close either.
 */
const assignedValues = (script: string, name: string): string[] => {
  const values: string[] = [];
  const pattern = assignmentPattern(name);
  for (let match = pattern.exec(script); match !== null; match = pattern.exec(script)) {
    const after = match.index + match[0].length;
    const rest = script.slice(after, after + 64);
    const start = after + (rest.length - rest.trimStart().length);
    const parse = /^JSON\.parse\(\s*/u.exec(script.slice(start, start + 64));
    if (parse !== null) {
      const quoted = start + parse[0].length;
      if (!/["'`]/u.test(script[quoted] ?? "")) continue;
      const end = stringEnd(script, quoted);
      if (end === undefined) break;
      const decoded = decodedString(script.slice(quoted, end));
      if (decoded !== undefined) values.push(decoded);
      pattern.lastIndex = end;
      continue;
    }
    if (script[start] !== "{" && script[start] !== "[") continue;
    const value = balancedValue(script, start);
    if (value === undefined) break;
    values.push(value);
    pattern.lastIndex = start + value.length;
  }
  return values;
};

/** Comment and CDATA wrappers, with an optional `//` before each marker, and a trailing `;`. */
const wrappers = [
  /^(?:\/\/[ \t]*)?<!--/u,
  /(?:\/\/[ \t]*)?-->$/u,
  /^(?:\/\/[ \t]*)?<!\[CDATA\[/u,
  /(?:\/\/[ \t]*)?\]\]>$/u,
  /;$/u,
];

const unwrapped = (text: string) => {
  let current = text.trim();
  for (let previous = ""; previous !== current; ) {
    previous = current;
    for (const wrapper of wrappers) current = current.replace(wrapper, "").trim();
  }
  return current;
};

const scriptType = (element: Element) =>
  (ownAttribute(element, "type") ?? "").split(";")[0]?.trim().toLowerCase();

/** A classic or module script, the kinds that can assign state; never a data or template block. */
const isJavaScript = (element: Element) => {
  const type = scriptType(element) ?? "";
  return type === "" || type === "module" || /^(?:text|application)\/(?:x-)?(?:java|ecma)script$/u.test(type);
};

/** The raw texts the selector points at, in document order. */
const candidates = (document: Document, select: EmbeddedJsonSelector) => {
  if ("id" in select)
    return findAll(
      (element) => element.name === "script" && element.attribs["id"] === select.id,
      document,
    ).map((element) => textContent(element));
  if ("type" in select)
    return findAll(
      (element) =>
        element.name === "script" && scriptType(element) === `application/${select.type}`,
      document,
    ).map((element) => textContent(element));
  // The last assignment wins, as it does when the page runs: an empty initialiser filled in later
  // gives the filled value.
  if ("assignment" in select)
    return findAll(
      (element) =>
        element.name === "script" &&
        ownAttribute(element, "src") === undefined &&
        isJavaScript(element),
      document,
    )
      .flatMap((element) => assignedValues(textContent(element), select.assignment))
      .reverse();
  const name = select.attribute.toLowerCase();
  return findAll((element) => ownAttribute(element, name) !== undefined, document).map(
    (element) => ownAttribute(element, name) ?? "",
  );
};

/**
 * The JSON a page embeds where `select` points. Script text loses surrounding whitespace,
 * `<!-- -->` and `<![CDATA[ ]]>` wrappers and a trailing `;`; an attribute's entities are decoded.
 * An `id` or `attribute` selector gives the first value that parses; a `type` selector gives an
 * array of every block of that type that parses, each as written (an `@graph` stays as it is).
 * Fails with an `EmbeddedJsonFailure` that names the selector and the page's title.
 */
export const embeddedJson = (
  text: string,
  select: EmbeddedJsonSelector,
): Either.Either<unknown, EmbeddedJsonFailure> => {
  const document = parseDocument(text);
  const title = titleOf(document);
  const page =
    title === undefined
      ? "the page, which has no title"
      : `the page ${JSON.stringify(title.slice(0, 200))}`;
  const where = `${selectorText(select)} in ${page}`;
  const found = candidates(document, select);
  const present = found.map(unwrapped).filter((value) => value !== "");
  if (present.length === 0)
    return Either.left(
      new EmbeddedJsonFailure({
        reason: "missing",
        message: `${where} is ${found.length === 0 ? "missing" : "empty"}.`,
      }),
    );
  const parsed: unknown[] = [];
  let firstError: unknown;
  for (const value of present) {
    try {
      parsed.push(JSON.parse(value));
    } catch (error) {
      firstError ??= error;
    }
  }
  if (parsed.length === 0)
    return Either.left(
      new EmbeddedJsonFailure({
        reason: "unparsable",
        message: `${where} is not JSON: ${
          firstError instanceof Error ? firstError.message : String(firstError)
        }`,
      }),
    );
  return Either.right("type" in select ? parsed : parsed[0]);
};

/**
 * JSON a page embeds, decoded with `schema`: `readText`, then `embeddedJson` at `select`. When a
 * safe read's answer did not come over the page's fetch and lacks the block, as a page that fills
 * it in only for a browser does, it reads once more over the page's fetch
 * (`requires: ["page-environment"]`) where the host can carry it, never from an offline replay.
 * When that read fails, the block's own failure stands and names the fetch's failure. Each
 * failure is an `OperationFailure` of class `parsing` that names the selector, the page's title,
 * and the URL, status and transport of the answer it read.
 */
export const readEmbeddedJson = <A, I, R>(
  http: SiteHttpService,
  request: SiteHttpRequest,
  select: EmbeddedJsonSelector,
  schema: Schema.Schema<A, I, R>,
): Effect.Effect<A, HttpFailure | OperationFailure, R> =>
  Effect.gen(function* () {
    let read = yield* readText(http, request);
    let found = embeddedJson(read.text, select);
    /** Why the page's fetch gave no answer to read, when it was asked and failed. */
    let retryFailure: string | undefined;
    if (
      Either.isLeft(found) &&
      found.left.reason === "missing" &&
      // A replay holds only the answers the live test recorded; asking it again finds none.
      read.response.transport !== "page-fetch" &&
      read.response.transport !== "saved-http" &&
      safeMethods.has(request.method) &&
      request.requires?.includes("page-environment") !== true &&
      http.capabilities.includes("page-environment")
    ) {
      const retried = yield* Effect.either(
        readText(http, {
          ...request,
          requires: [...(request.requires ?? []), "page-environment"],
        }),
      );
      if (Either.isRight(retried)) {
        read = retried.right;
        found = embeddedJson(read.text, select);
      } else
        retryFailure =
          retried.left._tag === "HttpFailure"
            ? `${retried.left.code} (dispatch ${retried.left.dispatch})`
            : retried.left.message.slice(0, 300);
    }
    const { response } = read;
    if (Either.isLeft(found))
      return yield* Effect.fail(
        unexpected(
          `${found.left.message}${retryFailure === undefined ? "" : ` Reading it again over the page's fetch failed: ${retryFailure}.`} ${described(request, response)}`,
          answer("parsing", request, response),
          found.left,
        ),
      );
    return yield* Schema.decodeUnknown(schema)(found.right).pipe(
      Effect.mapError((error) =>
        unexpected(
          `${request.method} ${response.requestUrl} answered ${selectorText(select)} JSON that does not match the schema: ${ParseResult.TreeFormatter.formatErrorSync(error)}`,
          answer("parsing", request, response),
          error,
        ),
      ),
    );
  });
