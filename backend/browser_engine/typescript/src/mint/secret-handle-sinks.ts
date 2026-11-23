import { sameSite } from "../runtime/same-site.js";
import { sourceSyntax } from "../runtime/source-syntax.js";
import { kernelTampered, readsBack, readsOwnSource, redefines } from "./secret-handle-guards.js";
import {
  attribute,
  boundNames,
  chainRoot,
  field,
  fields,
  isReference,
  memberName,
  nameOf,
  notOptional,
  parseTree,
  plain,
  plainPropertyKey,
  quasiText,
  writtenMembers,
} from "./inert-ast.js";
import type { AstNode, Tree } from "./inert-ast.js";

/**
 * Where a `{{secret.sN}}` handle may be filled (C9). Exact-match masking cannot see a transformed
 * value, so a handle is filled only where the value can go nowhere but the site: the whole string
 * passed as the value to `fill`, `type` or `pressSequentially`, or a field of a request to this
 * site, inside the Playwright code of a `kernel.browsers.playwright.execute` call. The analysis is
 * an inert parse; no authored code runs. It keeps the value out of the model's transcript and
 * blocks accidental leaks; it is not sound against code written to recover the value, which is
 * Guardian's to deny (`secret-handle-guards.ts` closes the cheap ways).
 */

export type Quote = "'" | '"' | "`";
const templateQuote: Quote = "`";

/** An issued handle's text in a file, with the literals it sits in, innermost first. */
export interface Placement {
  readonly start: number;
  readonly handle: string;
  readonly quotes: readonly [Quote, Quote];
}

/** Where handle-like text starts, so a handle split across strings is still seen. */
const handleStart = /\{\{\s*secret\./gu;
const issuedShape = /^\{\{secret\.s[1-9]\d*\}\}$/u;

/** A string literal or an expression-free template literal's value, with its quote. */
const staticString = (
  node: AstNode | undefined,
  source: string,
): { readonly value: string; readonly quote: Quote } | undefined => {
  const value = attribute(node, "value");
  if (node?.type === "Literal" && typeof value === "string") {
    const quote = source[node.start];
    return quote === "'" || quote === '"' ? { value, quote } : undefined;
  }
  if (node?.type !== "TemplateLiteral" || fields(node, "expressions").length > 0) return undefined;
  const { cooked } = quasiText(fields(node, "quasis")[0]);
  return cooked === undefined ? undefined : { value: cooked, quote: templateQuote };
};

type Receiver = "page" | "frame" | "keyboard" | "request" | "locator" | "frameLocator";
const locatorQueries = [
  "locator",
  "getByRole",
  "getByLabel",
  "getByPlaceholder",
  "getByText",
  "getByTestId",
  "getByTitle",
  "getByAltText",
] as const;
const queries = (
  extra: Readonly<Record<string, Receiver>> = {},
): Readonly<Record<string, Receiver>> => ({
  ...Object.fromEntries(locatorQueries.map((name) => [name, "locator" as const])),
  frameLocator: "frameLocator",
  ...extra,
});

/** Playwright's query and frame methods, by what each receiver's call yields. */
const callResults: Readonly<Partial<Record<Receiver, Readonly<Record<string, Receiver>>>>> = {
  page: queries({ mainFrame: "frame", frame: "frame" }),
  frame: queries(),
  locator: queries({
    first: "locator",
    last: "locator",
    nth: "locator",
    filter: "locator",
    and: "locator",
    or: "locator",
    contentFrame: "frameLocator",
  }),
  frameLocator: queries({ first: "frameLocator", last: "frameLocator", nth: "frameLocator" }),
};
const pageProperties: Readonly<Record<string, Receiver>> = {
  keyboard: "keyboard",
  request: "request",
};

/**
 * What a Playwright chain rooted at Kernel's `page` yields, through its query and frame methods
 * only. Anything else, a receiver held in a variable included, is not a sink receiver.
 */
const receiverOf = (node: AstNode | undefined): Receiver | undefined => {
  if (node?.type === "Identifier") return nameOf(node) === "page" ? "page" : undefined;
  if (node?.type === "MemberExpression") return pagePropertyReceiver(node);
  return node?.type === "CallExpression" ? callReceiver(node) : undefined;
};

/** `page.keyboard` or `page.request`. */
const pagePropertyReceiver = (member: AstNode) => {
  const name = memberName(member);
  return receiverOf(field(member, "object")) === "page" && typeof name === "string"
    ? pageProperties[name]
    : undefined;
};

/** What a query or frame method called on a receiver yields. */
const callReceiver = (call: AstNode) => {
  const callee = notOptional(call) ? field(call, "callee") : undefined;
  const name = notOptional(callee) ? memberName(callee) : undefined;
  if (typeof name !== "string") return undefined;
  const base = receiverOf(field(callee, "object"));
  return base === undefined ? undefined : callResults[base]?.[name];
};

/**
 * Which argument of a sink call is the typed value, by receiver and method. The receiver decides,
 * not the argument count alone: `page.fill(selector, value, options?)` and the same on a frame
 * take it second; a locator's `fill(value, options?)` and `page.keyboard.type(text, options?)`
 * take it first.
 */
const typedValueSinks: Readonly<
  Partial<Record<Receiver, { readonly methods: readonly string[]; readonly index: number }>>
> = {
  page: { methods: ["fill", "type"], index: 1 },
  frame: { methods: ["fill", "type"], index: 1 },
  keyboard: { methods: ["type"], index: 0 },
  locator: { methods: ["fill", "type", "pressSequentially"], index: 0 },
};

const typedValueArgument = (call: AstNode) => {
  const callee = notOptional(call) ? field(call, "callee") : undefined;
  const name = notOptional(callee) ? memberName(callee) : undefined;
  const receiver = typeof name === "string" ? receiverOf(field(callee, "object")) : undefined;
  const sink = receiver === undefined ? undefined : typedValueSinks[receiver];
  const args = fields(call, "arguments");
  // The value, then at most an options object.
  const counted =
    sink !== undefined && args.length - sink.index >= 1 && args.length - sink.index <= 2;
  return counted && typeof name === "string" && sink.methods.includes(name)
    ? args[sink.index]
    : undefined;
};

const onSite = (url: string | undefined, siteOrigin: string | undefined) => {
  if (url === undefined || !url.startsWith("https://")) return false;
  try {
    return sameSite(siteOrigin, new URL(url));
    // error-reporting-allow: parse-predicate a URL that does not parse is not this site
  } catch {
    return false;
  }
};

const requestMethods = ["post", "put", "patch", "fetch"];

/**
 * The options object of a request to this site and the keys that may carry a handle in it: the
 * key's own value (`body` for `fetch`, `data` for `page.request`) or one property of the object
 * under it. The URL must be an absolute literal on the attempt's site, so the request can go
 * nowhere else.
 */
const requestFields = (call: AstNode, source: string, siteOrigin: string | undefined) => {
  const [url, options, ...rest] = fields(call, "arguments");
  const shaped = options?.type === "ObjectExpression" && rest.length === 0 && notOptional(call);
  if (!shaped || !onSite(staticString(url, source)?.value, siteOrigin)) return undefined;
  const callee = field(call, "callee");
  if (nameOf(callee) === "fetch") return { options, direct: ["body"], nested: ["headers"] };
  const method = memberName(callee);
  const pageRequest =
    notOptional(callee) &&
    receiverOf(field(callee, "object")) === "request" &&
    typeof method === "string" &&
    requestMethods.includes(method);
  return pageRequest
    ? { options, direct: ["data"], nested: ["data", "form", "multipart", "headers"] }
    : undefined;
};

/** The plain property holding a node as its value, with its key and the object it sits in. */
const holdingProperty = (tree: Tree, node: AstNode) => {
  const holder = tree.parent(node);
  const key = holder?.key === "value" ? plainPropertyKey(holder.node) : undefined;
  const object = holder === undefined ? undefined : tree.parent(holder.node);
  return typeof key === "string" && holder !== undefined && object?.node.type === "ObjectExpression"
    ? { key, property: holder.node, object: object.node }
    : undefined;
};

/** Whether an options object is the one a request to this site takes, holding `key` as allowed. */
const requestCarries = (
  tree: Tree,
  options: AstNode,
  key: string,
  depth: "direct" | "nested",
  source: string,
  siteOrigin: string | undefined,
) => {
  const call = tree.parent(options);
  if (call?.node.type !== "CallExpression" || call.key !== "arguments") return false;
  const sink = requestFields(call.node, source, siteOrigin);
  return sink !== undefined && sink.options === options && sink[depth].includes(key);
};

/** Whether a literal is exactly the value a site-input sink sends, and nothing else. */
const isSinkValue = (
  tree: Tree,
  literal: AstNode,
  source: string,
  siteOrigin: string | undefined,
) => {
  const holder = tree.parent(literal);
  if (holder?.node.type === "CallExpression" && holder.key === "arguments")
    return typedValueArgument(holder.node) === literal;
  const held = holdingProperty(tree, literal);
  if (held === undefined) return false;
  if (requestCarries(tree, held.object, held.key, "direct", source, siteOrigin)) return true;
  const group = holdingProperty(tree, held.object);
  return (
    group !== undefined &&
    requestCarries(tree, group.object, group.key, "nested", source, siteOrigin)
  );
};

/**
 * Whether `page` and `fetch` in this Playwright code are Kernel's page and the global fetch, used
 * only to call through: never declared, bound, assigned, aliased, passed or written to, and
 * nothing beside them redefines a global, a prototype or JSON (`redefines`).
 */
const trustedPlaywrightScope = (tree: Tree) => {
  if (redefines(tree)) return false;
  if (boundNames(tree).some(({ name }) => name === "page" || name === "fetch")) return false;
  const rewritten = writtenMembers(tree).some((member) => {
    const name = memberName(member);
    return name === "page" || name === "fetch" || nameOf(chainRoot(member)) === "page";
  });
  if (rewritten) return false;
  return tree.nodes.every((node) => {
    if (nameOf(node) !== "page" || !isReference(tree, node)) return true;
    const holder = tree.parent(node);
    return (
      holder?.node.type === "MemberExpression" && holder.key === "object" && plain(holder.node)
    );
  });
};

/** One stretch of Playwright code that is the file's own text, unescaped. */
interface Segment {
  readonly codeStart: number;
  readonly sourceStart: number;
  readonly length: number;
}

interface KernelCode {
  readonly code: string;
  readonly quote: Quote;
  readonly segments: readonly Segment[];
}

const isSerialized = (expression: AstNode | undefined) => {
  const callee = expression?.type === "CallExpression" ? field(expression, "callee") : undefined;
  const args = fields(expression, "arguments");
  return (
    nameOf(field(callee, "object")) === "JSON" &&
    memberName(callee) === "stringify" &&
    notOptional(expression) &&
    args.length > 0 &&
    args.every((argument) => argument !== undefined && argument.type !== "SpreadElement")
  );
};

const literalCode = (value: AstNode, source: string): KernelCode | undefined => {
  const code = attribute(value, "value");
  const quote = source[value.start];
  if (typeof code !== "string" || (quote !== "'" && quote !== '"')) return undefined;
  const raw = source.slice(value.start + 1, value.end - 1);
  const segments =
    raw === code ? [{ codeStart: 0, sourceStart: value.start + 1, length: raw.length }] : [];
  return { code, quote, segments };
};

/**
 * A template's code, where each `${…}` must be `JSON.stringify(…)`, which always yields one
 * complete JSON value; it becomes an opaque identifier here.
 */
const templateCode = (value: AstNode, source: string): KernelCode | undefined => {
  const expressions = fields(value, "expressions");
  if (!expressions.every(isSerialized)) return undefined;
  let code = "";
  const segments: Segment[] = [];
  for (const [index, quasi] of fields(value, "quasis").entries()) {
    const { cooked, raw } = quasiText(quasi);
    if (quasi === undefined || cooked === undefined) return undefined;
    // A TypeScript parse starts a template element at its opening "`" or "}", a JavaScript one
    // after it; a wrong offset only refuses, since each placement is checked against the file.
    const sourceStart = source.startsWith(cooked, quasi.start) ? quasi.start : quasi.start + 1;
    if (cooked === raw)
      segments.push({ codeStart: code.length, sourceStart, length: cooked.length });
    code += cooked;
    if (index < expressions.length) code += ` __serialized${index} `;
  }
  return { code, quote: templateQuote, segments };
};

/** The Playwright code a Kernel execute call's `code` property sends, mapped back to the file. */
const kernelCode = (property: AstNode, source: string) => {
  const value = field(property, "value");
  if (value?.type === "Literal") return literalCode(value, source);
  return value?.type === "TemplateLiteral" ? templateCode(value, source) : undefined;
};

const isKernelExecute = (call: AstNode) => {
  const callee = field(call, "callee");
  const playwright = field(callee, "object");
  const browsers = field(playwright, "object");
  return (
    notOptional(call) &&
    memberName(callee) === "execute" &&
    memberName(playwright) === "playwright" &&
    memberName(browsers) === "browsers" &&
    nameOf(field(browsers, "object")) === "kernel"
  );
};

/** Wraps Kernel code the way Kernel runs it: an async function body with `page` in scope. */
const kernelCodePrefix = "(async () => {\n";

/** Where a handle literal in Kernel code sits in the file, when it is the file's own text. */
const fileOffset = (kernel: KernelCode, codeStart: number, length: number) => {
  const segment = kernel.segments.find(
    (candidate) =>
      candidate.codeStart <= codeStart &&
      codeStart + length <= candidate.codeStart + candidate.length,
  );
  return segment === undefined ? undefined : segment.sourceStart + codeStart - segment.codeStart;
};

/** The handles in one Kernel code string that sit in a sink, mapped back to the file. */
const codePlacements = (
  property: AstNode,
  source: string,
  siteOrigin: string | undefined,
): Placement[] => {
  const kernel = kernelCode(property, source);
  if (kernel === undefined || !/\{\{\s*secret\./u.test(kernel.code)) return [];
  const wrapped = `${kernelCodePrefix}${kernel.code}\n})`;
  const tree = parseTree(wrapped, "js");
  if (tree === undefined || !trustedPlaywrightScope(tree)) return [];
  let typed = false;
  const placements = tree.nodes.flatMap((node): Placement[] => {
    const literal = staticString(node, wrapped);
    // The handle is the literal's whole, unescaped text.
    const whole =
      literal !== undefined &&
      issuedShape.test(literal.value) &&
      wrapped.slice(node.start + 1, node.end - 1) === literal.value;
    if (!whole || !isSinkValue(tree, node, wrapped, siteOrigin)) return [];
    const start = fileOffset(
      kernel,
      node.start + 1 - kernelCodePrefix.length,
      literal.value.length,
    );
    if (start === undefined || source.slice(start, start + literal.value.length) !== literal.value)
      return [];
    // A sink call's argument is typed into the page; a request field is not.
    typed ||= tree.parent(node)?.node.type === "CallExpression";
    return [{ start, handle: literal.value, quotes: [literal.quote, kernel.quote] }];
  });
  return readsBack(tree, typed) ? [] : placements;
};

/** Every handle placement in the file's Kernel execute calls. */
const filePlacements = (tree: Tree, source: string, siteOrigin: string | undefined) =>
  tree.nodes.flatMap((node) => {
    if (node.type !== "CallExpression" || !isKernelExecute(node)) return [];
    const [, options, ...rest] = fields(node, "arguments");
    if (options?.type !== "ObjectExpression" || rest.length > 0) return [];
    return fields(options, "properties").flatMap((property) =>
      property !== undefined && plainPropertyKey(property) === "code"
        ? codePlacements(property, source, siteOrigin)
        : [],
    );
  });

const lineAt = (source: string, offset: number) => source.slice(0, offset).split("\n").length;

/**
 * Where each handle in an authored file may be filled, or the line of the first one that may not.
 * Only JavaScript and TypeScript can hold one; a file with no handle-like text has nothing to fill.
 */
export const handlePlacements = (
  path: string,
  source: string,
  siteOrigin: string | undefined,
): { readonly placements: readonly Placement[] } | { readonly line: number } => {
  const occurrences = [...source.matchAll(handleStart)].map((match) => match.index);
  if (occurrences.length === 0) return { placements: [] };
  const syntax = sourceSyntax(path);
  const tree =
    syntax === undefined ? undefined : parseTree(source, syntax === "typescript" ? "ts" : "js");
  // `kernel` is the operation's own parameter and `JSON` the global, never a stand-in or a wrapped
  // method that could read the filled code, and the file never reads its own filled source.
  const guarded =
    tree !== undefined && !kernelTampered(tree) && !redefines(tree) && !readsOwnSource(tree, path);
  const placements = guarded ? filePlacements(tree, source, siteOrigin) : [];
  const placed = new Set(placements.map((placement) => placement.start));
  const misplaced = occurrences.find((offset) => !placed.has(offset));
  return misplaced === undefined ? { placements } : { line: lineAt(source, misplaced) };
};
