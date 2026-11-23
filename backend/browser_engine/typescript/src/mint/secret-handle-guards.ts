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
  plain,
  quasiText,
  writtenMembers,
} from "./inert-ast.js";
import type { AstNode, Tree } from "./inert-ast.js";

/**
 * What code holding a `{{secret.sN}}` handle may not do beside it (C9). The placement check in
 * `secret-handle-sinks.ts` is static, and static checking cannot be sound against code written to
 * recover the value; these refusals only close the cheap ways review found: redefining what a sink,
 * Kernel's client or `JSON.stringify` does through a global, a prototype or a property definition;
 * reading a typed field back; and a file reading its own filled source from disk or by importing
 * itself. Guardian's handle rule is the backstop for the rest.
 */

/** Globals through which code reaches, evaluates or redefines anything else. */
const reachingGlobals = new Set([
  "globalThis",
  "global",
  "self",
  "window",
  "Reflect",
  "Proxy",
  "Function",
  "eval",
  "arguments",
  "process",
  "require",
]);

/** Names that define properties or reach a prototype, as identifiers or as keys. */
const redefiningNames = new Set([
  "defineProperty",
  "defineProperties",
  "assign",
  "getPrototypeOf",
  "setPrototypeOf",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "__proto__",
  "prototype",
  "constructor",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

/** Playwright methods that read back what was typed or sent, or plant code in the page. */
const readingBack = new Set([
  "inputValue",
  "$eval",
  "$$eval",
  "ariaSnapshot",
  "postData",
  "postDataJSON",
  "postDataBuffer",
  "exposeFunction",
  "exposeBinding",
  "addInitScript",
  "addScriptTag",
]);

/**
 * Methods that run code in the page, which can read a typed field. A handle sent as a request
 * field travels inside `page.evaluate(() => fetch(…))`, so these are refused only beside a typed
 * handle.
 */
const pageCode = new Set(["evaluate", "evaluateHandle", "evaluateAll"]);

/** A static key's value; undefined for a key computed at run time. */
const staticKey = (key: AstNode | undefined): string | number | undefined => {
  const value = attribute(key, "value");
  if (key?.type === "Literal" && (typeof value === "string" || typeof value === "number"))
    return value;
  if (key?.type !== "TemplateLiteral" || fields(key, "expressions").length > 0) return undefined;
  return quasiText(fields(key, "quasis")[0]).cooked;
};

const keyedTypes = new Set(["Property", "MethodDefinition", "PropertyDefinition"]);

/**
 * The name a node gives a property or binding: an identifier's name, or a computed or quoted
 * key's static value. `null` is a key computed at run time, which could be any name.
 */
const givenName = (node: AstNode): string | number | null | undefined => {
  const name = nameOf(node);
  if (typeof name === "string") return name;
  const key =
    node.type === "MemberExpression" && !plain(node)
      ? field(node, "property")
      : keyedTypes.has(node.type) && (!plain(node) || field(node, "key")?.type === "Literal")
        ? field(node, "key")
        : undefined;
  return key === undefined ? undefined : (staticKey(key) ?? null);
};

/** Whether a `JSON` reference is the callee of a plain `JSON.stringify(…)` or `JSON.parse(…)`. */
const plainJsonCall = (tree: Tree, identifier: AstNode) => {
  const member = tree.parent(identifier);
  const call = member === undefined ? undefined : tree.parent(member.node);
  const method = member?.key === "object" ? memberName(member.node) : undefined;
  return (
    (method === "stringify" || method === "parse") &&
    notOptional(member?.node) &&
    call?.key === "callee" &&
    call.node.type === "CallExpression" &&
    notOptional(call.node)
  );
};

/** Nodes that assign an existing name rather than declare one. */
const assigningTypes = new Set([
  "AssignmentExpression",
  "UpdateExpression",
  "ForInStatement",
  "ForOfStatement",
]);

/** Whether code writes a name it never declares, or a member of one: a global. */
const writesGlobal = (tree: Tree) => {
  const only = (keep: (node: AstNode) => boolean): Tree => ({
    nodes: tree.nodes.filter(keep),
    parent: tree.parent,
  });
  const declared = new Set(
    boundNames(only((node) => !assigningTypes.has(node.type))).map(({ name }) => name),
  );
  const assigned = boundNames(only((node) => assigningTypes.has(node.type)));
  if (assigned.some(({ name }) => !declared.has(name))) return true;
  return writtenMembers(tree).some((member) => {
    const root = nameOf(chainRoot(member));
    return typeof root === "string" && !declared.has(root);
  });
};

/** TypeScript nodes whose contents are types, which never run. */
const typeContexts = new Set([
  "TSTypeAnnotation",
  "TSTypeAliasDeclaration",
  "TSInterfaceDeclaration",
  "TSTypeParameterDeclaration",
  "TSTypeParameterInstantiation",
]);

/** Whether a node sits in a TypeScript type, where a name only describes. */
const inType = (tree: Tree, node: AstNode) => {
  for (let holder = tree.parent(node); holder !== undefined; holder = tree.parent(holder.node))
    if (typeContexts.has(holder.node.type)) return true;
  return false;
};

/** Nodes code may not hold beside a handle: `this`, `import.meta`, `new.target` and `import()`. */
const reachingNodes = new Set(["ThisExpression", "MetaProperty", "ImportExpression"]);

/**
 * Whether code, the file or the Playwright code of one execute call, could redefine what a sink,
 * Kernel's client or `JSON.stringify` does: it reaches a global object, `Reflect`, `eval` or
 * `Function`; names a property-definition or prototype key, or a key computed at run time; uses
 * `JSON` other than to call `stringify` or `parse`; or writes a global.
 */
export const redefines = (tree: Tree) =>
  writesGlobal(tree) ||
  tree.nodes.some((node) => {
    if (reachingNodes.has(node.type)) return true;
    const name = givenName(node);
    if (name === undefined || typeof name === "number" || inType(tree, node)) return false;
    if (name === null || redefiningNames.has(name)) return true;
    if (node.type !== "Identifier" || !isReference(tree, node)) return false;
    return reachingGlobals.has(name) || (name === "JSON" && !plainJsonCall(tree, node));
  });

/**
 * Whether Playwright code could read back a value it holds: a read-back method anywhere, or code
 * run in the page beside a handle it types.
 */
export const readsBack = (tree: Tree, typed: boolean) =>
  tree.nodes.some((node) => {
    const name = givenName(node);
    return typeof name === "string" && (readingBack.has(name) || (typed && pageCode.has(name)));
  });

const fileModules = /^(?:node:)?(?:fs|fs\/promises|module|child_process|worker_threads|vm)$/u;
const stem = (specifier: string) =>
  specifier
    .split("/")
    .at(-1)
    ?.replace(/\.[cm]?[jt]sx?$/u, "");

/** Whether a file imports a module that reads files, or imports itself, which reads its source. */
export const readsOwnSource = (tree: Tree, path: string) =>
  tree.nodes.some((node) => {
    const specifier = attribute(field(node, "source"), "value");
    if (typeof specifier !== "string" || !node.type.endsWith("Declaration")) return false;
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    return fileModules.test(specifier) || (relative && stem(specifier) === stem(path));
  });

/** Pattern nodes a parameter binding sits in. */
const patternTypes = new Set([
  "ObjectPattern",
  "ArrayPattern",
  "Property",
  "AssignmentPattern",
  "RestElement",
]);

const isParameter = (tree: Tree, identifier: AstNode) => {
  let holder = tree.parent(identifier);
  while (holder !== undefined && patternTypes.has(holder.node.type))
    holder = tree.parent(holder.node);
  return holder?.key === "params";
};

/** Whether an identifier is the root of a plain member chain that is called, `kernel.a.b(…)`. */
const calledChainRoot = (tree: Tree, identifier: AstNode) => {
  let top = { node: identifier, holder: tree.parent(identifier) };
  while (
    top.holder?.node.type === "MemberExpression" &&
    top.holder.key === "object" &&
    plain(top.holder.node) &&
    notOptional(top.holder.node)
  )
    top = { node: top.holder.node, holder: tree.parent(top.holder.node) };
  return top.node !== identifier && top.holder?.key === "callee" && notOptional(top.holder.node);
};

/**
 * Whether `kernel` is anything but a function parameter used only to call through: declared,
 * written, aliased, passed or read as a value, any of which could wrap `execute` and keep the
 * filled code it is sent.
 */
export const kernelTampered = (tree: Tree) =>
  tree.nodes.some(
    (node) =>
      node.type === "Identifier" &&
      nameOf(node) === "kernel" &&
      isReference(tree, node) &&
      !inType(tree, node) &&
      !isParameter(tree, node) &&
      !calledChainRoot(tree, node),
  );
