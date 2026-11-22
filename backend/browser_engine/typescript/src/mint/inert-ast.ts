import { parseSync } from "oxc-parser";

/**
 * Inert syntax-tree reading for authored source: nodes with their parents, and the names code
 * binds, writes or refers to. Nothing is imported, resolved or executed.
 */

export interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
}

const isNode = (value: unknown): value is AstNode =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "type") === "string" &&
  typeof Reflect.get(value, "start") === "number" &&
  typeof Reflect.get(value, "end") === "number";

export const attribute = (node: AstNode | undefined, key: string): unknown =>
  node === undefined ? undefined : Reflect.get(node, key);
export const field = (node: AstNode | undefined, key: string): AstNode | undefined => {
  const value = attribute(node, key);
  return isNode(value) ? value : undefined;
};
export const fields = (
  node: AstNode | undefined,
  key: string,
): readonly (AstNode | undefined)[] => {
  const value = attribute(node, key);
  return Array.isArray(value) ? value.map((entry) => (isNode(entry) ? entry : undefined)) : [];
};
export const nameOf = (node: AstNode | undefined) =>
  node?.type === "Identifier" ? attribute(node, "name") : undefined;
export const notOptional = (node: AstNode | undefined) => attribute(node, "optional") === false;
export const plain = (node: AstNode | undefined) => attribute(node, "computed") === false;

export interface Tree {
  readonly nodes: readonly AstNode[];
  readonly parent: (node: AstNode) => { readonly node: AstNode; readonly key: string } | undefined;
}

/** Every node of an inert parse with its parent; undefined when the source does not parse. */
export const parseTree = (source: string, lang: "js" | "ts"): Tree | undefined => {
  try {
    const parsed = parseSync(`source.${lang}`, source, { lang, sourceType: "module" });
    if (parsed.errors.length > 0) return undefined;
    const nodes: AstNode[] = [];
    const parents = new Map<AstNode, { node: AstNode; key: string }>();
    const visit = (node: AstNode) => {
      nodes.push(node);
      for (const [key, value] of Object.entries(node))
        for (const entry of Array.isArray(value) ? value : [value])
          if (isNode(entry)) {
            parents.set(entry, { node, key });
            visit(entry);
          }
    };
    visit(parsed.program);
    return { nodes, parent: (node) => parents.get(node) };
    // error-reporting-allow: parse-predicate a source the parser throws on is unparsed, which callers treat as holding nothing they may trust
  } catch {
    return undefined;
  }
};

/** A plain property's key, `key: value`: not computed, shorthand, a method or an accessor. */
export const plainPropertyKey = (property: AstNode | undefined) => {
  const simple =
    property?.type === "Property" &&
    attribute(property, "kind") === "init" &&
    plain(property) &&
    attribute(property, "shorthand") === false &&
    attribute(property, "method") === false;
  const key = simple ? field(property, "key") : undefined;
  const literal = key?.type === "Literal" ? attribute(key, "value") : undefined;
  return nameOf(key) ?? (typeof literal === "string" ? literal : undefined);
};

export const memberName = (member: AstNode | undefined) =>
  member?.type === "MemberExpression" && plain(member)
    ? nameOf(field(member, "property"))
    : undefined;

export const quasiText = (quasi: AstNode | undefined) => {
  const value = attribute(quasi, "value");
  const read = (key: string): unknown =>
    typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  const cooked = read("cooked");
  return { cooked: typeof cooked === "string" ? cooked : undefined, raw: read("raw") };
};

/** The key of each pattern a pattern node binds through. */
const patternChildren: Readonly<Record<string, string>> = {
  AssignmentPattern: "left",
  RestElement: "argument",
  TSParameterProperty: "parameter",
};

/** Names a pattern binds; a member expression target binds none. */
const patternNames = (pattern: AstNode | undefined): string[] => {
  if (pattern === undefined) return [];
  if (pattern.type === "Identifier") return [String(attribute(pattern, "name"))];
  if (pattern.type === "ArrayPattern") return fields(pattern, "elements").flatMap(patternNames);
  if (pattern.type === "ObjectPattern")
    return fields(pattern, "properties").flatMap((property) =>
      patternNames(
        property?.type === "RestElement" ? field(property, "argument") : field(property, "value"),
      ),
    );
  const child = patternChildren[pattern.type];
  return child === undefined ? [] : patternNames(field(pattern, child));
};

/** Where each kind of node binds names: its pattern keys, and whether they are parameters. */
const bindingKeys: Readonly<Record<string, readonly (readonly [string, boolean])[]>> = {
  VariableDeclarator: [["id", false]],
  FunctionDeclaration: [
    ["id", false],
    ["params", true],
  ],
  FunctionExpression: [
    ["id", false],
    ["params", true],
  ],
  ArrowFunctionExpression: [["params", true]],
  ClassDeclaration: [["id", false]],
  ClassExpression: [["id", false]],
  CatchClause: [["param", false]],
  ImportSpecifier: [["local", false]],
  ImportDefaultSpecifier: [["local", false]],
  ImportNamespaceSpecifier: [["local", false]],
  AssignmentExpression: [["left", false]],
  ForInStatement: [["left", false]],
  ForOfStatement: [["left", false]],
  UpdateExpression: [["argument", false]],
};

/** Every name the tree declares, binds as a parameter or assigns, and whether it was a parameter. */
export const boundNames = (tree: Tree) =>
  tree.nodes.flatMap((node) =>
    (bindingKeys[node.type] ?? []).flatMap(([key, parameter]) =>
      [field(node, key), ...fields(node, key)]
        .flatMap(patternNames)
        .map((name) => ({ name, parameter })),
    ),
  );

/** The member expressions code writes to: assignment, update and delete targets. */
export const writtenMembers = (tree: Tree) =>
  tree.nodes.flatMap((node) => {
    const deletion = node.type === "UnaryExpression" && attribute(node, "operator") === "delete";
    const target =
      node.type === "AssignmentExpression"
        ? field(node, "left")
        : node.type === "UpdateExpression" || deletion
          ? field(node, "argument")
          : undefined;
    return target?.type === "MemberExpression" ? [target] : [];
  });

const chainLinks: Readonly<Record<string, string>> = {
  MemberExpression: "object",
  CallExpression: "callee",
  ParenthesizedExpression: "expression",
};

/** The identifier a member or call chain starts from. */
export const chainRoot = (node: AstNode | undefined): AstNode | undefined => {
  const link = node === undefined ? undefined : chainLinks[node.type];
  return link === undefined ? node : chainRoot(field(node, link));
};

/** Keys whose identifier names a property, key or label rather than referring to a binding. */
const namingKeys: Readonly<Record<string, string>> = {
  MemberExpression: "property",
  Property: "key",
  MethodDefinition: "key",
  PropertyDefinition: "key",
  LabeledStatement: "label",
  BreakStatement: "label",
  ContinueStatement: "label",
};

/** Whether an identifier refers to a binding, rather than naming a property, key or label. */
export const isReference = (tree: Tree, identifier: AstNode) => {
  const holder = tree.parent(identifier);
  if (holder === undefined || namingKeys[holder.node.type] !== holder.key) return true;
  if (holder.key === "label") return false;
  // A computed key and a shorthand property's value do refer to a binding.
  return !plain(holder.node) || attribute(holder.node, "shorthand") === true;
};
