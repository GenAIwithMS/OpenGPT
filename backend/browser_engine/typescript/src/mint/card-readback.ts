import { posix } from "node:path";
import { sourceSyntax } from "../runtime/source-syntax.js";

/**
 * A card's digits stay with the host: a script's `fillCard` types the caller's card from its
 * handles, and the script never holds the card. Code that read a card field back after typing
 * would put the card in the result, the logs and, during a build, the model's context and traces,
 * so the host refuses source that could read a field back once a card is in play: before every
 * live step of a build that has the caller's card, and before a live step runs or a tool
 * publishes when some file calls `fillCard`.
 *
 * The check is a static scan of the authored files under src/, explore/, test/ and scratch/: of
 * every one Node could run, code strings and comments included, read with `\u`, `\x` and octal
 * escapes decoded, line continuations joined and a member named by a string literal
 * (`page["pdf"]`) read as a dotted one. It refuses reading a field's value or the page's markup, running code in
 * the page or planting it there, a DevTools session, an accessibility snapshot, a screenshot or
 * PDF of the page, recording the page, and reading a request body. It does not see a name built
 * at run time. Guardian's card rule is the backstop.
 */

const fillsCard = /\bfillCard\b/u;

/**
 * `getAttribute` with anything but a plain literal name other than `value`: an attribute named at
 * run time may be `value`.
 */
const valueAttribute = /\bgetAttribute\b(?![ \t]*\([ \t]*(["'`])(?!value\1)[\w:.-]+\1[ \t]*[,)])/iu;

/** Ways code could read a typed card back. */
const refused: readonly (readonly [RegExp, string])[] = [
  [/\b(?:inputValue|getProperty|jsonValue)\b/u, "reads a field's value"],
  [valueAttribute, "reads a field's value"],
  [/\.content[ \t]*\(|\b(?:innerHTML|outerHTML)\b/u, "reads the page's markup"],
  [/\$\$?eval\b/u, "runs code in the page"],
  [/\b(?:evaluate(?:Handle|All)?|waitForFunction)\b/u, "runs code in the page"],
  [
    /\b(?:exposeFunction|exposeBinding|addInitScript|addScriptTag|addStyleTag)\b/u,
    "plants code in the page",
  ],
  [/\bnew(?:Browser)?CDPSession\b/u, "opens a DevTools session"],
  [/\bariaSnapshot\b|\.accessibility\b/u, "reads an accessibility snapshot"],
  [/\bscreenshot\b/u, "takes a screenshot"],
  [/\.pdf[ \t]*[(;,)\]}]|\.pdf\.(?:call|apply|bind)\b/u, "prints the page"],
  [
    /\.tracing\b|\b(?:recordVideo|recordHar|routeFromHAR|startTracing|startScreencast|screencast)\b|\.video[ \t]*\(/u,
    "records the page",
  ],
  [/\bpostData(?:Buffer|JSON)?\b/u, "reads a request body"],
];

/** An authored file a step or a tool may run from. */
const authored = (path: string) => /^(?:src|explore|test|scratch)\//u.test(path);
/** A file Node could run: JavaScript or TypeScript by its extension, or one with none. */
const runnable = (path: string) => sourceSyntax(path) !== undefined || posix.extname(path) === "";

/** A code point an escape names, kept escaped when it would break a line or names none. */
const unescaped = (escape: string, code: number) =>
  code > 0x10ffff || [0x0a, 0x0d, 0x2028, 0x2029].includes(code)
    ? escape
    : String.fromCodePoint(code);

/**
 * Source as the scan reads it: escapes decoded and string-named members dotted, line for line,
 * then each line continuation in a string joined, at the offsets `joinedAt` lists.
 */
const normalized = (source: string) => {
  const decoded = source
    .replace(
      /\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})|\\([0-3][0-7]{0,2}|[4-7][0-7]?)/gu,
      (escape: string, braced?: string, four?: string, two?: string, octal?: string) =>
        unescaped(
          escape,
          octal === undefined
            ? Number.parseInt(braced ?? four ?? two ?? "", 16)
            : Number.parseInt(octal, 8),
        ),
    )
    .replace(/\??\.?\[[ \t]*(["'`])([A-Za-z_$][\w$]*)\1[ \t]*\]/gu, ".$2");
  const joinedAt: number[] = [];
  let text = "";
  let from = 0;
  for (const continuation of decoded.matchAll(/\\(?:\r\n|[\n\r\u2028\u2029])/gu)) {
    text += decoded.slice(from, continuation.index);
    joinedAt.push(text.length);
    from = continuation.index + continuation[0].length;
  }
  return { text: text + decoded.slice(from), joinedAt };
};

/** The original line of an offset into normalized source, counting the lines it joined. */
const lineAt = (source: ReturnType<typeof normalized>, offset: number) =>
  source.text.slice(0, offset).split("\n").length +
  source.joinedAt.filter((at) => at <= offset).length;

/**
 * The first authored file and line that could read a typed card back, with what it does, when the
 * build has the caller's card (`cardIssued`, false for a publication) or some authored file calls
 * `fillCard`.
 */
export const cardReadback = (
  files: ReadonlyMap<string, string>,
  cardIssued: boolean,
): { readonly path: string; readonly line: number; readonly does: string } | undefined => {
  const sources = [...files]
    .filter(([path]) => authored(path))
    .map(([path, source]) => [path, normalized(source)] as const);
  if (!cardIssued && !sources.some(([, source]) => fillsCard.test(source.text))) return undefined;
  for (const [path, source] of sources) {
    if (!runnable(path)) continue;
    for (const [pattern, does] of refused) {
      const match = pattern.exec(source.text);
      if (match !== null) return { path, line: lineAt(source, match.index), does };
    }
  }
  return undefined;
};

/** The rule a refusal states after its file, line and what the code does. */
export const cardReadbackRule =
  "a card stays with the host: fillCard types the caller's card from its handles, and once a build has the caller's card or its source calls fillCard, no source reads a field's value or the page's markup, runs or plants code in the page, opens a DevTools session, takes an accessibility snapshot, screenshot or PDF of the page, records the page, or reads a request body";

/**
 * Why a live step is refused before review for code that could read a typed card back, when the
 * build has the caller's card (`cardIssued`) or its source calls `fillCard`.
 */
export const cardReadbackRefusal = (
  files: ReadonlyMap<string, string>,
  step: { readonly target: string },
  cardIssued: boolean,
): string | undefined => {
  if (step.target !== "liveBrowser") return undefined;
  const found = cardReadback(files, cardIssued);
  return found === undefined
    ? undefined
    : `${found.path} line ${found.line} ${found.does}: ${cardReadbackRule}. Nothing was executed.`;
};
