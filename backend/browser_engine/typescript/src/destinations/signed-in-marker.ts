/**
 * The signed-in marker's own checks, apart from the live page: whether a signed-out page shows it,
 * how the host's checks of one marker add up, and the reasons a host refuses or warns about it.
 *
 * The marker (`AutofillSignedIn`) is checked in many places: after a reset, at every operation's
 * start, after a page load in the middle of a script, and on whatever page a failure lands on. A
 * marker a signed-out page also shows makes a signed-out page look signed in, so the host tests
 * it against a page it saw before the sign-in sent anything.
 *
 * The signed-out snapshot is the masked, serialized document an explore checkpoint keeps
 * (`<!doctype html>` and the root element's `outerHTML`). Matching it is approximate:
 * - The selector is read as a Playwright selector: CSS with Playwright's `:has-text`, `:text`,
 *   `:text-is`, `:text-matches` and `:visible`, and the `text`, `css`, `id`, `data-testid` and
 *   `role` engines. Anything else, such as XPath or `:hover`, leaves the page unchecked, as does
 *   a frame-crossing selector (`>>`, `internal:`), which the live check refuses too.
 * - A role selector is checked only for the roles whose implicit elements this match knows
 *   (`coveredRoles`); any other leaves the page unchecked. An input whose type it does not map
 *   with certainty, such as `password` or `date`, leaves a `textbox` marker unchecked (and a file
 *   input a `button` one); other roles ignore it. What it cannot decide is never absent.
 * - A role's name follows the accessible-name rules in part: `aria-labelledby` first, then
 *   `aria-label` or a native attribute (`alt`, a button's value, an svg's `<title>`, a table's
 *   caption), then, for roles named from their content, the content, built from each child's own
 *   text alternative and leaving out what the page hides, and `title` last. A name it cannot
 *   compute, such as a form field's `<label>` or content holding a form control or embedded
 *   content, leaves the page unchecked. CSS-generated text (`::before`, `::after`) is not seen.
 * - The snapshot is the main document alone: a shadow root's content and frames are not in it.
 * - Visibility is estimated without layout or stylesheets: an element counts as hidden only
 *   under a `hidden` attribute, an inline `display: none` or `visibility: hidden`, a closed
 *   dialog or details, a hidden input, or inside an element the page never renders (`head`,
 *   `template`, `script`, `style`, `noscript`). An element a stylesheet hides, or an empty box,
 *   counts as visible, so an error refuses a good marker rather than passes a bad one.
 */
import { pathMatches } from "./autofill-recipe.js";
import type { AutofillSignedIn } from "./autofill-step.js";
import { frameCrossing } from "./autofill-locate-code.js";

/** A page the host saw signed out: its URL and its masked, serialized document. */
export interface SignedOutSnapshot {
  readonly url: string;
  readonly dom: string;
}

/**
 * Whether the signed-out snapshots show the marker: `unchecked` when the host has none, or the
 * selector uses syntax the snapshot match cannot read.
 */
export type SignedOutSnapshotMatch = "absent" | "matches" | "unchecked";

/**
 * The host's checks of one marker:
 * - `signedOutSnapshot`: whether a page seen before the sign-in shows it (it must not);
 * - `signedInNow`: whether the live, signed-in page shows it (it must);
 * - `freshLoad`: whether it still shows after the host loads `openPath`, or the site's origin,
 *   again (it must);
 * - `secondPage`: whether another page the agent visited signed in shows it, when the host had
 *   one (it must).
 */
export interface SignedInMarkerCheck {
  readonly signedOutSnapshot: SignedOutSnapshotMatch;
  readonly signedInNow: boolean;
  readonly freshLoad: boolean;
  readonly secondPage?: boolean;
}

/** Why a host refuses a marker. */
export type SignedInMarkerRefusal =
  | "marker_matches_signed_out_page"
  | "marker_is_login_path"
  | "marker_not_signed_in_now"
  | "marker_lost_on_fresh_load"
  | "marker_missing_on_second_page";

/** What a host tells the agent about a marker it still accepts. */
export type SignedInMarkerWarning =
  "selector_relies_on_generated_classes" | "signed_out_page_unchecked";

export type SignedInMarkerVerdict =
  | { readonly accepted: true; readonly warnings: readonly SignedInMarkerWarning[] }
  | {
      readonly accepted: false;
      readonly refusals: readonly [SignedInMarkerRefusal, ...SignedInMarkerRefusal[]];
      readonly warnings: readonly SignedInMarkerWarning[];
    };

/** A live check's answer, such as `checkAutofillSignedIn`'s. */
interface LiveCheck {
  readonly signedIn: boolean;
}

/**
 * Adds up the host's checks of one marker: the signed-out snapshots it matches here, and the
 * answers of its live checks (the current page, a fresh load and, when it had one, another
 * signed-in page).
 */
export const evaluateSignedInMarker = (input: {
  readonly marker: AutofillSignedIn;
  readonly signedOutSnapshots: readonly SignedOutSnapshot[];
  readonly signedInNow: LiveCheck;
  readonly freshLoad: LiveCheck;
  readonly secondPage?: LiveCheck | undefined;
}): SignedInMarkerCheck => ({
  signedOutSnapshot: matchSignedOutSnapshots(input.marker, input.signedOutSnapshots),
  signedInNow: input.signedInNow.signedIn,
  freshLoad: input.freshLoad.signedIn,
  ...(input.secondPage === undefined ? {} : { secondPage: input.secondPage.signedIn }),
});

/** The refusal for a marker a signed-out page shows. */
export const signedOutMatchRefusal = (
  check: Pick<SignedInMarkerCheck, "signedOutSnapshot">,
): "marker_matches_signed_out_page" | undefined =>
  check.signedOutSnapshot === "matches" ? "marker_matches_signed_out_page" : undefined;

const pathOf = (value: string) => {
  const path = URL.parse(value, "https://login.invalid")?.pathname;
  return path === undefined ? undefined : path.length > 1 ? path.replace(/\/$/u, "") : path;
};

/**
 * The refusal for a path alone that is the recorded login page's path (`loginPath`, a path or a
 * URL), any one segment at each place its `anySegments` lists (`pathMatches`): a signed-out run
 * lands there too.
 */
export const loginPathRefusal = (
  marker: AutofillSignedIn,
  loginPath: string | undefined,
  anySegments?: readonly number[],
): "marker_is_login_path" | undefined => {
  if (marker.selector !== undefined || marker.urlPath === undefined || loginPath === undefined)
    return undefined;
  const login = pathOf(loginPath);
  const path = pathOf(marker.urlPath);
  return login !== undefined && path !== undefined && pathMatches(path, login, anySegments)
    ? "marker_is_login_path"
    : undefined;
};

/**
 * A class name a build tool or CSS-in-JS library made: a known prefix (`css-`, `sc-`, `jsx-`,
 * `emotion-`, `jss`), or a last segment of five or more letters and digits with at least two
 * digits, or five or more digits.
 */
const generatedClass = (name: string) => {
  if (/^(?:css|sc|jsx|emotion|styled)-[A-Za-z0-9]+$/u.test(name) || /^jss\d+$/u.test(name))
    return true;
  const last = name.split(/[-_]+/u).at(-1) ?? "";
  if (!/^[A-Za-z0-9]{5,}$/u.test(last)) return false;
  const digits = last.replace(/\D/gu, "").length;
  return digits === last.length || (digits >= 2 && digits < last.length);
};

/**
 * The warning for a selector whose only distinguishing parts are generated class names: it has
 * one, and no attribute, id, text or role to anchor it.
 */
export const generatedClassWarning = (
  selector: string,
): "selector_relies_on_generated_classes" | undefined => {
  const parsed = parseSelector(selector);
  if (parsed === undefined) return undefined;
  const classes: string[] = [];
  let anchored = false;
  const visit = (list: SelectorList) => {
    for (const complex of list)
      for (const { compound } of complex) {
        for (const part of compound) {
          if (part.kind === "class") classes.push(part.name);
          else if (part.kind === "attribute" || part.kind === "id" || part.kind === "text")
            anchored = true;
          else if (part.kind === "pseudo-list") visit(part.list);
        }
      }
  };
  if (parsed.kind === "css") visit(parsed.list);
  else anchored = true;
  return !anchored && classes.some(generatedClass)
    ? "selector_relies_on_generated_classes"
    : undefined;
};

/**
 * The host's verdict on a marker: every refusal its checks give, in a fixed order, and its
 * warnings. Without a `check`, only what the marker itself shows is judged; without a
 * `loginPath`, the login path is not compared.
 */
export const validateSignedInMarker = (input: {
  readonly marker: AutofillSignedIn;
  readonly check?: SignedInMarkerCheck | undefined;
  readonly loginPath?: string | undefined;
}): SignedInMarkerVerdict => {
  const { marker, check } = input;
  const refusals = [
    check === undefined ? undefined : signedOutMatchRefusal(check),
    loginPathRefusal(marker, input.loginPath),
    check?.signedInNow === false ? ("marker_not_signed_in_now" as const) : undefined,
    check?.freshLoad === false ? ("marker_lost_on_fresh_load" as const) : undefined,
    check?.secondPage === false ? ("marker_missing_on_second_page" as const) : undefined,
  ].filter((refusal) => refusal !== undefined);
  const warnings = [
    marker.selector === undefined ? undefined : generatedClassWarning(marker.selector),
    check?.signedOutSnapshot === "unchecked" ? ("signed_out_page_unchecked" as const) : undefined,
  ].filter((warning) => warning !== undefined);
  const [first, ...rest] = refusals;
  return first === undefined
    ? { accepted: true, warnings }
    : { accepted: false, refusals: [first, ...rest], warnings };
};

/**
 * Whether the signed-out snapshots show the marker: one shows it when its selector has a visible
 * match there and its path is the snapshot's path, for whichever of the two the marker names.
 * With no match, an element it may match where the name could not be computed leaves the pages
 * unchecked.
 */
export const matchSignedOutSnapshots = (
  marker: AutofillSignedIn,
  snapshots: readonly SignedOutSnapshot[],
): SignedOutSnapshotMatch => {
  if (snapshots.length === 0) return "unchecked";
  const step = marker.selector === undefined ? undefined : parseSelector(marker.selector);
  if (marker.selector !== undefined && step === undefined) return "unchecked";
  let uncertain = false;
  for (const snapshot of snapshots) {
    if (marker.urlPath !== undefined && pathOf(snapshot.url) !== pathOf(marker.urlPath)) continue;
    if (step === undefined) return "matches";
    const found = query(parseDocument(snapshot.dom), step);
    if (found.matched.some(visible)) return "matches";
    if (found.uncertain.some(visible)) uncertain = true;
  }
  return uncertain ? "unchecked" : "absent";
};

// ---------------------------------------------------------------------------------------------
// The serialized document, as a tree.

interface SnapshotElement {
  readonly tag: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: SnapshotNode[];
  readonly parent: SnapshotElement | undefined;
}
type SnapshotNode = SnapshotElement | { readonly text: string };

const isElement = (node: SnapshotNode): node is SnapshotElement => "tag" in node;

const voidElements = new Set(
  "area base br col embed hr img input link meta param source track wbr keygen frame".split(" "),
);
/** Elements whose content the serializer writes as raw text, and the escaped text ones. */
const rawTextElements = new Set(
  "script style xmp iframe noembed noframes noscript plaintext textarea title".split(" "),
);
const namedEntities: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};
const decodeEntities = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return namedEntities[name.toLowerCase()] ?? whole;
  });

const attributePattern = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu;

/**
 * Builds the element tree of a serialized document. Serializer output closes every element that
 * is not void, so this reads it strictly and tolerates the rest: an end tag with no open match is
 * ignored, and one that matches an outer element closes the inner ones.
 */
const parseDocument = (html: string): SnapshotElement => {
  const root: SnapshotElement = {
    tag: "#document",
    attributes: new Map(),
    children: [],
    parent: undefined,
  };
  const stack: SnapshotElement[] = [root];
  const current = () => stack[stack.length - 1] ?? root;
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf("<", at);
    const textEnd = open === -1 ? html.length : open;
    if (textEnd > at) current().children.push({ text: decodeEntities(html.slice(at, textEnd)) });
    if (open === -1) break;
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      at = close === -1 ? html.length : close + 3;
      continue;
    }
    if (html[open + 1] === "!" || html[open + 1] === "?") {
      const close = html.indexOf(">", open);
      at = close === -1 ? html.length : close + 1;
      continue;
    }
    const end = /^<\/([A-Za-z][^\s/>]*)[^>]*>/u.exec(html.slice(open, open + 300));
    if (end !== null) {
      const tag = (end[1] ?? "").toLowerCase();
      const index = stack.findLastIndex((element) => element.tag === tag);
      if (index > 0) stack.length = index;
      at = open + end[0].length;
      continue;
    }
    const start = /^<([A-Za-z][^\s/>]*)/u.exec(html.slice(open, open + 300));
    if (start === null) {
      current().children.push({ text: "<" });
      at = open + 1;
      continue;
    }
    const tag = (start[1] ?? "").toLowerCase();
    // The tag ends at the first `>` outside a quoted attribute value.
    let cursor = open + start[0].length;
    let quote: string | undefined;
    while (cursor < html.length) {
      const char = html[cursor];
      if (quote !== undefined) {
        if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
      cursor++;
    }
    const inside = html.slice(open + start[0].length, cursor);
    const attributes = new Map<string, string>();
    for (const match of inside.matchAll(attributePattern)) {
      const name = (match[1] ?? "").toLowerCase();
      if (!attributes.has(name))
        attributes.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
    }
    const element: SnapshotElement = { tag, attributes, children: [], parent: current() };
    current().children.push(element);
    at = cursor + 1;
    if (voidElements.has(tag) || inside.trimEnd().endsWith("/")) continue;
    if (rawTextElements.has(tag)) {
      const close = html.toLowerCase().indexOf(`</${tag}`, at);
      const text = html.slice(at, close === -1 ? html.length : close);
      if (text.length > 0)
        element.children.push({
          text: tag === "textarea" || tag === "title" ? decodeEntities(text) : text,
        });
      const after = close === -1 ? -1 : html.indexOf(">", close);
      at = after === -1 ? html.length : after + 1;
      continue;
    }
    stack.push(element);
  }
  return root;
};

const elementsUnder = function* (node: SnapshotElement): Generator<SnapshotElement> {
  for (const child of node.children)
    if (isElement(child)) {
      yield child;
      yield* elementsUnder(child);
    }
};

const elementChildren = (element: SnapshotElement) => element.children.filter(isElement);

const textCache = new WeakMap<SnapshotElement, string>();
/** The element's text as a page shows it: no script, style or template text. */
const textOf = (element: SnapshotElement): string => {
  const cached = textCache.get(element);
  if (cached !== undefined) return cached;
  let text = "";
  if (element.tag === "input") {
    const type = (element.attributes.get("type") ?? "").toLowerCase();
    if (type === "button" || type === "submit" || type === "reset")
      text = element.attributes.get("value") ?? "";
  } else if (!["script", "style", "template", "noscript", "head"].includes(element.tag))
    for (const child of element.children) text += isElement(child) ? textOf(child) : child.text;
  textCache.set(element, text);
  return text;
};
const normalize = (text: string) => text.replace(/[\s\u00a0]+/gu, " ").trim();

// ---------------------------------------------------------------------------------------------
// Visibility, estimated without layout.

const neverRendered = new Set([
  "head",
  "template",
  "script",
  "style",
  "noscript",
  "title",
  "#document",
]);

const inlineStyle = (element: SnapshotElement, property: string) => {
  const style = element.attributes.get("style");
  if (style === undefined) return undefined;
  let value: string | undefined;
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    if (declaration.slice(0, colon).trim().toLowerCase() === property)
      value = declaration
        .slice(colon + 1)
        .replace(/!important/iu, "")
        .trim()
        .toLowerCase();
  }
  return value;
};

const displayed = (element: SnapshotElement): boolean => {
  for (let node: SnapshotElement | undefined = element; node !== undefined; node = node.parent) {
    if (node.tag === "#document") return true;
    if (neverRendered.has(node.tag) || node.attributes.has("hidden")) return false;
    if (inlineStyle(node, "display") === "none") return false;
    if (node.tag === "dialog" && !node.attributes.has("open")) return false;
    const parent: SnapshotElement | undefined = node.parent;
    if (parent?.tag === "details" && !parent.attributes.has("open")) {
      const summary: SnapshotElement | undefined = elementChildren(parent).find(
        (child) => child.tag === "summary",
      );
      if (summary !== node) return false;
    }
  }
  return true;
};

/** The element shows: displayed, and the nearest inline visibility does not hide it. */
const visible = (element: SnapshotElement): boolean => {
  if (element.tag === "input" && (element.attributes.get("type") ?? "").toLowerCase() === "hidden")
    return false;
  if (!displayed(element)) return false;
  for (let node: SnapshotElement | undefined = element; node !== undefined; node = node.parent) {
    const visibility = inlineStyle(node, "visibility");
    if (visibility !== undefined && visibility !== "inherit")
      return visibility !== "hidden" && visibility !== "collapse";
  }
  return true;
};

// ---------------------------------------------------------------------------------------------
// Playwright selectors, the part a snapshot can answer.

type TextMatcher = (text: string) => boolean;

type SimplePart =
  | { readonly kind: "type"; readonly name: string }
  | { readonly kind: "id"; readonly name: string }
  | { readonly kind: "class"; readonly name: string }
  | {
      readonly kind: "attribute";
      readonly name: string;
      readonly operator: "" | "=" | "~=" | "|=" | "^=" | "$=" | "*=";
      readonly value: string;
      readonly caseless: boolean;
    }
  | { readonly kind: "pseudo"; readonly test: (element: SnapshotElement) => boolean }
  | { readonly kind: "text"; readonly test: (element: SnapshotElement) => boolean }
  | {
      readonly kind: "pseudo-list";
      readonly name: "not" | "is" | "where" | "has";
      readonly list: SelectorList;
    };
type Combinator = " " | ">" | "+" | "~";
/** A compound and the combinator that joins it to the compound before it. */
type ComplexSelector = readonly {
  readonly combinator: Combinator;
  readonly compound: readonly SimplePart[];
}[];
type SelectorList = readonly ComplexSelector[];

type Step =
  | { readonly kind: "css"; readonly list: SelectorList }
  | { readonly kind: "text"; readonly test: TextMatcher }
  | { readonly kind: "role"; readonly test: (element: SnapshotElement) => boolean | "unknown" }
  | { readonly kind: "attribute"; readonly name: string; readonly value: string };

class Unsupported extends Error {}

const unquote = (body: string): { readonly value: string; readonly quoted: boolean } => {
  const trimmed = body.trim();
  const first = trimmed[0];
  if ((first === '"' || first === "'") && trimmed.endsWith(first) && trimmed.length >= 2)
    return { value: trimmed.slice(1, -1).replace(/\\(.)/gu, "$1"), quoted: true };
  return { value: trimmed, quoted: false };
};

/**
 * Playwright's text matching: a quoted value matches the whole text exactly, or ignoring case
 * with an `i` suffix; an unquoted one, or one with an `i` suffix, matches a part of it ignoring
 * case; `/regex/flags` matches as a regular expression.
 */
const textMatcher = (body: string, exactByDefault: boolean): TextMatcher => {
  const trimmed = body.trim();
  const regex = /^\/(.*)\/([dgimsuvy]*)$/su.exec(trimmed);
  if (regex !== null) {
    const pattern = new RegExp(regex[1] ?? "", (regex[2] ?? "").replace(/[gy]/gu, ""));
    return (text) => pattern.test(normalize(text));
  }
  const suffix = /^(["'])(.*)\1([is]?)$/su.exec(trimmed);
  if (suffix !== null) {
    const value = normalize((suffix[2] ?? "").replace(/\\(.)/gu, "$1"));
    if (suffix[3] === "i")
      return (text) => normalize(text).toLowerCase().includes(value.toLowerCase());
    return exactByDefault || suffix[3] === "s"
      ? (text) => normalize(text) === value
      : (text) => normalize(text).toLowerCase().includes(value.toLowerCase());
  }
  const value = normalize(trimmed).toLowerCase();
  return (text) => normalize(text).toLowerCase().includes(value);
};

/**
 * An element the text matches, where no element child's text also matches: the innermost
 * element holding the text, as Playwright's text engine returns it.
 */
const innermostText = (test: TextMatcher) => (element: SnapshotElement) =>
  test(textOf(element)) && !elementChildren(element).some((child) => test(textOf(child)));

/** An element inside one of these tags is not a page-level banner or content info. */
const sectioning = new Set(["article", "aside", "main", "nav", "section"]);
const insideSectioning = (element: SnapshotElement) => {
  for (let node = element.parent; node !== undefined; node = node.parent)
    if (sectioning.has(node.tag)) return true;
  return false;
};

/**
 * The implicit role of the elements whose role this match knows, as Playwright gives it. Any
 * other element has none here, and a role selector for a role outside `coveredRoles` is not
 * checked at all.
 */
const implicitRole = (element: SnapshotElement): string | undefined => {
  const { tag, attributes } = element;
  const type = (attributes.get("type") ?? "text").toLowerCase();
  switch (tag) {
    case "a":
    case "area":
      return attributes.has("href") ? "link" : undefined;
    case "button":
    case "summary":
      return "button";
    case "input":
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox" || type === "radio") return type;
      if (type === "search") return attributes.has("list") ? "combobox" : "searchbox";
      if (type === "range") return "slider";
      if (["text", "email", "tel", "url"].includes(type))
        return attributes.has("list") ? "combobox" : "textbox";
      return undefined;
    case "textarea":
      return "textbox";
    case "select":
      return attributes.has("multiple") || Number(attributes.get("size") ?? 0) > 1
        ? "listbox"
        : "combobox";
    case "datalist":
      return "listbox";
    case "option":
      return "option";
    case "nav":
      return "navigation";
    case "header":
      return insideSectioning(element) ? undefined : "banner";
    case "footer":
      return insideSectioning(element) ? undefined : "contentinfo";
    case "main":
      return "main";
    case "aside":
      return "complementary";
    case "form":
      return authorName(element) === "" && !element.attributes.get("title") ? undefined : "form";
    case "dialog":
      return "dialog";
    case "ul":
    case "ol":
    case "menu":
      return "list";
    case "li":
      return "listitem";
    case "img":
      return attributes.get("alt") === "" ? "presentation" : "img";
    case "svg":
      return "img";
    case "table":
      return "table";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return "heading";
    default:
      return undefined;
  }
};

/** The roles `implicitRole` gives: a role selector for any other role leaves the page unchecked. */
const coveredRoles = new Set([
  "link",
  "button",
  "checkbox",
  "radio",
  "searchbox",
  "slider",
  "textbox",
  "combobox",
  "listbox",
  "option",
  "navigation",
  "banner",
  "contentinfo",
  "main",
  "complementary",
  "form",
  "dialog",
  "list",
  "listitem",
  "img",
  "table",
  "heading",
]);

const roleOf = (element: SnapshotElement) =>
  element.attributes.get("role")?.trim().toLowerCase().split(/\s+/u)[0] || implicitRole(element);

/** Roles whose accessible name may come from their content; any other is named by its author. */
const nameFromContent = new Set([
  "button",
  "checkbox",
  "heading",
  "link",
  "option",
  "radio",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "treeitem",
  "cell",
  "gridcell",
  "columnheader",
  "rowheader",
  "row",
  "switch",
  "tooltip",
]);
/** Form fields, whose name comes from a `<label>` this match does not resolve. */
const labelledFields = new Set(["textbox", "searchbox", "combobox", "listbox", "slider"]);
/** Content whose part of a name this match cannot know. */
const opaqueContent = new Set([
  "input",
  "select",
  "textarea",
  "iframe",
  "object",
  "embed",
  "canvas",
  "video",
  "audio",
  "math",
]);
/** Elements that add no space around their text in a name. */
const inlineTags = new Set(
  "a abbr b bdi bdo cite code data dfn em font i img kbd label mark q s samp small span strong sub sup svg time u var".split(
    " ",
  ),
);

const documentOf = (element: SnapshotElement) => {
  let node = element;
  while (node.parent !== undefined) node = node.parent;
  return node;
};

/** A name this match cannot compute reliably. */
const unknownName = Symbol("unknown name");
type Name = string | typeof unknownName;

const ariaHidden = (element: SnapshotElement) =>
  element.attributes.get("aria-hidden")?.trim().toLowerCase() === "true";

/** The elements `aria-labelledby` names, in order; empty when it names none on the page. */
const labelledBy = (element: SnapshotElement): SnapshotElement[] => {
  const ids = (element.attributes.get("aria-labelledby") ?? "").split(/\s+/u).filter(Boolean);
  if (ids.length === 0) return [];
  const byId = new Map<string, SnapshotElement>();
  for (const candidate of elementsUnder(documentOf(element))) {
    const id = candidate.attributes.get("id");
    if (id !== undefined && !byId.has(id)) byId.set(id, candidate);
  }
  return ids.flatMap((id) => byId.get(id) ?? []);
};

const joinNames = (names: readonly Name[]): Name =>
  names.includes(unknownName) ? unknownName : names.join(" ");

/** `aria-label`, or the name a native attribute gives; undefined when neither does. */
const ownLabel = (element: SnapshotElement): string | undefined => {
  const label = element.attributes.get("aria-label");
  if (label !== undefined && label.trim() !== "") return label;
  const type = (element.attributes.get("type") ?? "").toLowerCase();
  if (
    element.tag === "img" ||
    element.tag === "area" ||
    (element.tag === "input" && type === "image")
  )
    return element.attributes.get("alt") || undefined;
  if (element.tag === "input" && ["button", "submit", "reset"].includes(type))
    return element.attributes.get("value") || undefined;
  if (element.tag === "svg") {
    const title = elementChildren(element).find((child) => child.tag === "title");
    return title === undefined ? undefined : textOf(title) || undefined;
  }
  if (element.tag === "table") {
    const caption = elementChildren(element).find((child) => child.tag === "caption");
    return caption === undefined ? undefined : textOf(caption) || undefined;
  }
  return undefined;
};

/** The name its author gave: `aria-labelledby`, `aria-label` or a native attribute, never `title`. */
const authorName = (element: SnapshotElement): Name => {
  const referenced = labelledBy(element);
  if (referenced.length > 0) {
    const name = joinNames(referenced.map((node) => ownLabel(node) ?? contentName(node)));
    if (name === unknownName || name.trim() !== "") return name;
  }
  return ownLabel(element) ?? "";
};

/**
 * The name an element's content gives, as the accessible-name rules build it: each child's own
 * text alternative (`aria-labelledby`, `aria-label`, `alt`, an svg's `<title>`), else its
 * content, leaving out what the page hides. A form control or embedded content in it makes the
 * name unknown.
 */
const contentName = (element: SnapshotElement): Name => {
  let name = "";
  for (const child of element.children) {
    if (!isElement(child)) {
      name += child.text;
      continue;
    }
    if (ariaHidden(child) || !visible(child)) continue;
    const type = (child.attributes.get("type") ?? "").toLowerCase();
    const button = child.tag === "input" && ["button", "submit", "reset", "image"].includes(type);
    if (opaqueContent.has(child.tag) && !button) return unknownName;
    const referenced = labelledBy(child);
    let part: Name =
      referenced.length > 0
        ? joinNames(referenced.map((node) => ownLabel(node) ?? contentName(node)))
        : (ownLabel(child) ?? (child.tag === "svg" ? "" : contentName(child)));
    if (part === unknownName) return unknownName;
    if (part.trim() === "") part = child.attributes.get("title") ?? "";
    name += inlineTags.has(child.tag) ? part : ` ${part} `;
  }
  return name;
};

/** The accessible name, estimated, or `unknownName` where this match cannot compute it. */
const nameOf = (element: SnapshotElement, role: string): Name => {
  const author = authorName(element);
  if (author === unknownName) return unknownName;
  const authored =
    labelledBy(element).length > 0 || (element.attributes.get("aria-label") ?? "").trim() !== "";
  if (!authored && labelledFields.has(role)) return unknownName;
  if (author.trim() !== "") return author;
  // `title` is the last resort: after the content for roles named from it, else after the author.
  const content = nameFromContent.has(role) ? contentName(element) : "";
  if (content === unknownName || content.trim() !== "") return content;
  return element.attributes.get("title") ?? "";
};

/** Input types whose implicit role `implicitRole` gives with certainty. */
const mappedInputTypes = new Set(
  "button submit reset image checkbox radio search range text email tel url hidden".split(" "),
);
/**
 * Whether an input without its own role, whose type `implicitRole` does not map, may have `role`:
 * Playwright gives such an input `textbox`, or `button` for a file input. For any other role it is
 * no candidate.
 */
const uncertainRole = (element: SnapshotElement, role: string) => {
  if (element.tag !== "input" || element.attributes.get("role")?.trim()) return false;
  const type = (element.attributes.get("type") ?? "text").trim().toLowerCase();
  if (mappedInputTypes.has(type)) return false;
  return role === "textbox" || (role === "button" && type === "file");
};

/** Whether the element or an ancestor hides it from the accessibility tree with `aria-hidden`. */
const hiddenFromRoles = (element: SnapshotElement) => {
  for (let node: SnapshotElement | undefined = element; node !== undefined; node = node.parent)
    if (ariaHidden(node)) return true;
  return false;
};

/**
 * `role=button[name="Sign out"][level=2]`, with Playwright's `i` and `s` suffixes on the name. A
 * role outside `coveredRoles` is unsupported, and a name it cannot compute answers `unknown`.
 */
const roleStep = (body: string): Step => {
  const match = /^([a-z-]+)((?:\[[^\]]*\])*)$/iu.exec(body.trim());
  if (match === null) throw new Unsupported();
  const role = (match[1] ?? "").toLowerCase();
  if (!coveredRoles.has(role)) throw new Unsupported();
  const tests: ((element: SnapshotElement) => boolean | "unknown")[] = [];
  let includeHidden = false;
  for (const [, attribute] of (match[2] ?? "").matchAll(/\[([^\]]*)\]/gu)) {
    const pair = /^\s*([a-z-]+)\s*(?:=\s*(.*?))?\s*$/isu.exec(attribute ?? "");
    if (pair === null) throw new Unsupported();
    const name = (pair[1] ?? "").toLowerCase();
    const value = pair[2];
    if (name === "include-hidden")
      includeHidden = value === undefined || unquote(value).value !== "false";
    else if (name === "name" && value !== undefined) {
      // An attribute's case flag may follow its quoted value after a space, in either case:
      // `"Sign out" i`, `"Sign out"I`.
      const flagged = /^(["'])(.*)\1\s*([is])$/isu.exec(value.trim());
      const matches = textMatcher(
        flagged === null
          ? value
          : `${flagged[1]}${flagged[2]}${flagged[1]}${(flagged[3] ?? "").toLowerCase()}`,
        false,
      );
      tests.push((element) => {
        const computed = nameOf(element, role);
        return computed === unknownName ? "unknown" : matches(computed);
      });
    } else if (name === "level" && value !== undefined) {
      const level = Number(unquote(value).value);
      tests.push((element) => {
        const explicit = element.attributes.get("aria-level");
        const own = explicit ?? (/^h[1-6]$/u.test(element.tag) ? element.tag.slice(1) : undefined);
        return Number(own) === level;
      });
    } else throw new Unsupported();
  }
  return {
    kind: "role",
    test: (element) => {
      if (!includeHidden && hiddenFromRoles(element)) return false;
      if (uncertainRole(element, role)) return "unknown";
      if (roleOf(element) !== role) return false;
      let answer: boolean | "unknown" = true;
      for (const test of tests) {
        const result = test(element);
        if (result === false) return false;
        if (result === "unknown") answer = "unknown";
      }
      return answer;
    },
  };
};

const engines: Readonly<Record<string, (body: string) => Step>> = {
  css: (body) => ({ kind: "css", list: parseCss(body) }),
  text: (body) => ({ kind: "text", test: textMatcher(body, true) }),
  id: (body) => ({ kind: "attribute", name: "id", value: unquote(body).value }),
  "data-testid": (body) => ({ kind: "attribute", name: "data-testid", value: unquote(body).value }),
  "data-test-id": (body) => ({
    kind: "attribute",
    name: "data-test-id",
    value: unquote(body).value,
  }),
  "data-test": (body) => ({ kind: "attribute", name: "data-test", value: unquote(body).value }),
  role: roleStep,
};

const parseStep = (part: string): Step => {
  if (part.startsWith("//") || part.startsWith("..")) throw new Unsupported();
  if (part.startsWith('"') || part.startsWith("'"))
    return { kind: "text", test: textMatcher(part, true) };
  const engine = /^([a-zA-Z_0-9+:*-]+)=/u.exec(part);
  if (engine !== null) {
    const parse = engines[(engine[1] ?? "").toLowerCase()];
    if (parse === undefined) throw new Unsupported();
    return parse(part.slice(engine[0].length));
  }
  return { kind: "css", list: parseCss(part) };
};

/**
 * A Playwright selector as one step, or undefined when the snapshot match cannot read it. A
 * frame-crossing selector (`>>` chains and `internal:` engines) the live check refuses as well.
 */
const parseSelector = (selector: string): Step | undefined => {
  if (frameCrossing(selector)) return undefined;
  try {
    return parseStep(selector.trim());
  } catch (error) {
    if (error instanceof Unsupported || error instanceof SyntaxError) return undefined;
    throw error;
  }
};

/** A CSS selector list with Playwright's text and visibility pseudo-classes. */
const parseCss = (source: string): SelectorList => {
  let at = 0;
  const peek = () => source[at];
  const skipSpace = () => {
    const start = at;
    while (at < source.length && /\s/u.test(source[at] ?? "")) at++;
    return at > start;
  };
  const identifier = (): string => {
    let name = "";
    while (at < source.length) {
      const char = source[at] ?? "";
      if (char === "\\") {
        name += source[at + 1] ?? "";
        at += 2;
      } else if (/[A-Za-z0-9_\-\u00a0-\uffff]/u.test(char)) {
        name += char;
        at++;
      } else break;
    }
    if (name === "") throw new Unsupported();
    return name;
  };
  const quoted = (): string => {
    const quote = source[at];
    at++;
    let value = "";
    while (at < source.length && source[at] !== quote) {
      if (source[at] === "\\") at++;
      value += source[at] ?? "";
      at++;
    }
    if (source[at] !== quote) throw new Unsupported();
    at++;
    return value;
  };
  /** A parenthesized argument, as raw text. */
  const argument = (): string => {
    if (peek() !== "(") throw new Unsupported();
    let depth = 0;
    let quote: string | undefined;
    const start = at + 1;
    for (; at < source.length; at++) {
      const char = source[at];
      if (quote !== undefined) {
        if (char === "\\") at++;
        else if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === "(") depth++;
      else if (char === ")" && --depth === 0) {
        at++;
        return source.slice(start, at - 1);
      }
    }
    throw new Unsupported();
  };
  const attribute = (): SimplePart => {
    at++;
    skipSpace();
    const name = identifier().toLowerCase();
    skipSpace();
    if (peek() === "]") {
      at++;
      return { kind: "attribute", name, operator: "", value: "", caseless: false };
    }
    const operator = /^(=|~=|\|=|\^=|\$=|\*=)/u.exec(source.slice(at))?.[1];
    if (operator === undefined) throw new Unsupported();
    at += operator.length;
    skipSpace();
    const value = peek() === '"' || peek() === "'" ? quoted() : identifier();
    skipSpace();
    let caseless = false;
    if (peek() === "i" || peek() === "I" || peek() === "s" || peek() === "S") {
      caseless = peek()?.toLowerCase() === "i";
      at++;
      skipSpace();
    }
    if (peek() !== "]") throw new Unsupported();
    at++;
    return {
      kind: "attribute",
      name,
      operator: operator as "=" | "~=" | "|=" | "^=" | "$=" | "*=",
      value,
      caseless,
    };
  };
  const pseudo = (): SimplePart => {
    at++;
    if (peek() === ":") throw new Unsupported();
    const name = identifier().toLowerCase();
    switch (name) {
      case "not":
      case "is":
      case "where":
      case "matches":
        return {
          kind: "pseudo-list",
          name: name === "matches" ? "is" : name,
          list: parseCss(argument()),
        };
      case "has":
        return { kind: "pseudo-list", name, list: parseCss(argument()) };
      case "has-text":
      case "text": {
        const test = textMatcher(argument(), false);
        return name === "text"
          ? { kind: "text", test: innermostText(test) }
          : { kind: "text", test: (element) => test(textOf(element)) };
      }
      case "text-is": {
        const value = normalize(unquote(argument()).value);
        return { kind: "text", test: innermostText((text) => normalize(text) === value) };
      }
      case "text-matches": {
        const [pattern, flags] = argument()
          .split(/,(?=(?:[^"']|"[^"]*"|'[^']*')*$)/u)
          .map((part) => unquote(part).value);
        const regex = new RegExp(pattern ?? "", (flags ?? "").replace(/[gy]/gu, ""));
        return { kind: "text", test: innermostText((text) => regex.test(normalize(text))) };
      }
      case "visible":
        return { kind: "pseudo", test: visible };
      case "root":
        return { kind: "pseudo", test: (element) => element.parent?.tag === "#document" };
      case "first-child":
        return { kind: "pseudo", test: (element) => siblings(element)[0] === element };
      case "last-child":
        return { kind: "pseudo", test: (element) => siblings(element).at(-1) === element };
      case "only-child":
        return { kind: "pseudo", test: (element) => siblings(element).length === 1 };
      case "first-of-type":
        return {
          kind: "pseudo",
          test: (element) =>
            siblings(element).find((other) => other.tag === element.tag) === element,
        };
      case "last-of-type":
        return {
          kind: "pseudo",
          test: (element) =>
            siblings(element).findLast((other) => other.tag === element.tag) === element,
        };
      case "nth-child": {
        const [a, b] = nth(argument());
        return {
          kind: "pseudo",
          test: (element) => {
            const position = siblings(element).indexOf(element) + 1;
            return a === 0 ? position === b : (position - b) / a >= 0 && (position - b) % a === 0;
          },
        };
      }
      case "empty":
        return {
          kind: "pseudo",
          test: (element) =>
            element.children.every((child) => !isElement(child) && child.text === ""),
        };
      case "checked":
        return {
          kind: "pseudo",
          test: (element) =>
            element.attributes.has("checked") || element.attributes.has("selected"),
        };
      case "disabled":
        return { kind: "pseudo", test: (element) => element.attributes.has("disabled") };
      case "enabled":
        return { kind: "pseudo", test: (element) => !element.attributes.has("disabled") };
      case "link":
      case "any-link":
        return {
          kind: "pseudo",
          test: (element) => element.tag === "a" && element.attributes.has("href"),
        };
      default:
        throw new Unsupported();
    }
  };
  const compound = (): SimplePart[] => {
    const parts: SimplePart[] = [];
    if (peek() === "*") at++;
    else if (/[A-Za-z_\\\u00a0-\uffff-]/u.test(peek() ?? ""))
      parts.push({ kind: "type", name: identifier().toLowerCase() });
    for (;;) {
      const char = peek();
      if (char === "#") {
        at++;
        parts.push({ kind: "id", name: identifier() });
      } else if (char === ".") {
        at++;
        parts.push({ kind: "class", name: identifier() });
      } else if (char === "[") parts.push(attribute());
      else if (char === ":") parts.push(pseudo());
      else break;
    }
    return parts;
  };
  const complex = (): ComplexSelector => {
    const result: { combinator: Combinator; compound: readonly SimplePart[] }[] = [];
    let combinator: Combinator = " ";
    skipSpace();
    // A relative selector inside :has() may start with a combinator.
    if (peek() === ">" || peek() === "+" || peek() === "~") {
      combinator = peek() as Combinator;
      at++;
      skipSpace();
    }
    for (;;) {
      const start = at;
      const parts = compound();
      if (at === start) throw new Unsupported();
      result.push({ combinator, compound: parts });
      const spaced = skipSpace();
      const next = peek();
      if (next === undefined || next === "," || next === ")") break;
      if (next === ">" || next === "+" || next === "~") {
        combinator = next;
        at++;
        skipSpace();
      } else if (spaced) combinator = " ";
      else throw new Unsupported();
    }
    return result;
  };
  const list: ComplexSelector[] = [complex()];
  while (peek() === ",") {
    at++;
    list.push(complex());
  }
  skipSpace();
  if (at !== source.length) throw new Unsupported();
  return list;
};

const nth = (body: string): readonly [number, number] => {
  const text = body.replace(/\s+/gu, "").toLowerCase();
  if (text === "odd") return [2, 1];
  if (text === "even") return [2, 0];
  const match = /^([+-]?\d*)n([+-]\d+)?$/u.exec(text);
  if (match !== null) {
    const a = match[1] === "" || match[1] === "+" ? 1 : match[1] === "-" ? -1 : Number(match[1]);
    return [a, Number(match[2] ?? 0)];
  }
  if (/^[+-]?\d+$/u.test(text)) return [0, Number(text)];
  throw new Unsupported();
};

const siblings = (element: SnapshotElement) =>
  element.parent === undefined ? [element] : elementChildren(element.parent);

const attributeMatches = (
  element: SnapshotElement,
  part: Extract<SimplePart, { kind: "attribute" }>,
) => {
  const actual = element.attributes.get(part.name);
  if (actual === undefined) return false;
  if (part.operator === "") return true;
  const have = part.caseless ? actual.toLowerCase() : actual;
  const want = part.caseless ? part.value.toLowerCase() : part.value;
  switch (part.operator) {
    case "=":
      return have === want;
    case "~=":
      return have.split(/\s+/u).includes(want);
    case "|=":
      return have === want || have.startsWith(`${want}-`);
    case "^=":
      return want !== "" && have.startsWith(want);
    case "$=":
      return want !== "" && have.endsWith(want);
    case "*=":
      return want !== "" && have.includes(want);
  }
};

const compoundMatches = (element: SnapshotElement, compound: readonly SimplePart[]): boolean =>
  compound.every((part) => {
    switch (part.kind) {
      case "type":
        return element.tag === part.name;
      case "id":
        return element.attributes.get("id") === part.name;
      case "class":
        return (element.attributes.get("class") ?? "").split(/\s+/u).includes(part.name);
      case "attribute":
        return attributeMatches(element, part);
      case "pseudo":
      case "text":
        return part.test(element);
      case "pseudo-list":
        if (part.name === "not") return !listMatches(element, part.list);
        if (part.name === "has") return part.list.some((complex) => hasMatch(element, complex));
        return listMatches(element, part.list);
    }
  });

/** Whether the element matches the complex selector's last compound and, leftward, the rest. */
const complexMatches = (
  element: SnapshotElement,
  complex: ComplexSelector,
  index = complex.length - 1,
): boolean => {
  const entry = complex[index];
  if (entry === undefined) return true;
  if (!compoundMatches(element, entry.compound)) return false;
  if (index === 0) return true;
  const previous = index - 1;
  switch (entry.combinator) {
    case ">":
      return (
        element.parent !== undefined &&
        element.parent.tag !== "#document" &&
        complexMatches(element.parent, complex, previous)
      );
    case " ":
      for (
        let node = element.parent;
        node !== undefined && node.tag !== "#document";
        node = node.parent
      )
        if (complexMatches(node, complex, previous)) return true;
      return false;
    case "+": {
      const all = siblings(element);
      const before = all[all.indexOf(element) - 1];
      return before !== undefined && complexMatches(before, complex, previous);
    }
    case "~": {
      const all = siblings(element);
      return all
        .slice(0, all.indexOf(element))
        .some((before) => complexMatches(before, complex, previous));
    }
  }
};

const listMatches = (element: SnapshotElement, list: SelectorList) =>
  list.some((complex) => complexMatches(element, complex));

/**
 * `:has()` with a relative selector: the selector matches with the anchor in front of it, joined
 * by the selector's leading combinator (a descendant when it has none).
 */
const hasMatch = (anchor: SnapshotElement, complex: ComplexSelector): boolean => {
  const anchored: ComplexSelector = [
    { combinator: " ", compound: [{ kind: "pseudo", test: (element) => element === anchor }] },
    ...complex,
  ];
  const leading = complex[0]?.combinator ?? " ";
  const within = leading === " " || leading === ">" ? anchor : anchor.parent;
  if (within === undefined) return false;
  for (const candidate of elementsUnder(within))
    if (complexMatches(candidate, anchored)) return true;
  return false;
};

/**
 * The document's elements the step matches, and those it may match where this match cannot
 * compute what the step asks, such as a role's name.
 */
const query = (
  document: SnapshotElement,
  step: Step,
): { readonly matched: SnapshotElement[]; readonly uncertain: SnapshotElement[] } => {
  const matched: SnapshotElement[] = [];
  const uncertain: SnapshotElement[] = [];
  for (const element of elementsUnder(document)) {
    const answer = stepMatches(element, step);
    if (answer === true) matched.push(element);
    else if (answer === "unknown") uncertain.push(element);
  }
  return { matched, uncertain };
};

const stepMatches = (element: SnapshotElement, step: Step): boolean | "unknown" => {
  switch (step.kind) {
    case "css":
      return listMatches(element, step.list);
    case "text":
      return innermostText(step.test)(element);
    case "role":
      return step.test(element);
    case "attribute":
      return element.attributes.get(step.name) === step.value;
  }
};
