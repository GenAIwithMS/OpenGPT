import { Either, Schema } from "effect";
import { parseSync } from "oxc-parser";
import type { Expression, Node } from "oxc-parser";
import { QuestionId } from "../runtime/input-request.js";
import { ScriptQuestionDeclarations } from "../runtime/script-input.js";

/** Not a literal: the value depends on something only running the code would know. */
const notLiteral = Symbol("not literal");

/** The value of a literal expression, or `notLiteral` for anything computed. */
const literal = (node: Expression): unknown => {
  if (node.type === "Literal")
    return typeof node.value === "bigint" || node.value instanceof RegExp ? notLiteral : node.value;
  if (node.type === "TemplateLiteral")
    return node.expressions.length === 0
      ? node.quasis.map((quasi) => quasi.value.cooked).join("")
      : notLiteral;
  if (node.type === "UnaryExpression") {
    if (node.operator !== "-" || node.argument.type !== "Literal") return notLiteral;
    const value = node.argument.value;
    return typeof value === "number" ? -value : notLiteral;
  }
  if (
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "ParenthesizedExpression"
  )
    return literal(node.expression);
  if (node.type === "ArrayExpression") {
    const items: unknown[] = [];
    for (const element of node.elements) {
      if (element === null || element.type === "SpreadElement") return notLiteral;
      const value = literal(element);
      if (value === notLiteral) return notLiteral;
      items.push(value);
    }
    return items;
  }
  if (node.type !== "ObjectExpression") return notLiteral;
  const entries: [string, unknown][] = [];
  for (const property of node.properties) {
    if (
      property.type !== "Property" ||
      property.computed ||
      property.kind !== "init" ||
      property.method
    )
      return notLiteral;
    const key =
      property.key.type === "Identifier"
        ? property.key.name
        : property.key.type === "Literal" && typeof property.key.value === "string"
          ? property.key.value
          : undefined;
    if (key === undefined) return notLiteral;
    const value = literal(property.value);
    if (value === notLiteral) return notLiteral;
    entries.push([key, value]);
  }
  return Object.fromEntries(entries);
};

const isDefineOperation = (callee: Expression) =>
  (callee.type === "Identifier" && callee.name === "defineOperation") ||
  (callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    callee.property.name === "defineOperation");

const isNode = (value: object): value is Node => "type" in value && typeof value.type === "string";

/** Every node below `node`, depth first. */
function* nodes(node: unknown): Generator<Node> {
  if (Array.isArray(node)) {
    for (const item of node) yield* nodes(item);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  if (isNode(node)) yield node;
  for (const value of Object.values(node)) if (typeof value === "object") yield* nodes(value);
}

/**
 * Read a draft's literal `defineOperation` questions without running its source. A computed,
 * absent or unparseable declaration has no static value.
 */
const draftQuestionValue = (path: string, source: string): unknown => {
  const lang = path.endsWith(".ts") ? "ts" : "js";
  let program: unknown;
  try {
    const parsed = parseSync(path, source, { lang, sourceType: "module" });
    if (parsed.errors.length > 0) return notLiteral;
    program = parsed.program;
    // error-reporting-allow: parse-predicate a draft that does not parse declares no questions
  } catch {
    return notLiteral;
  }
  const calls = [...nodes(program)].filter(
    (node) => node.type === "CallExpression" && isDefineOperation(node.callee),
  );
  const [call] = calls;
  if (calls.length !== 1 || call?.type !== "CallExpression") return notLiteral;
  const contract = call.arguments[0];
  if (contract === undefined || contract.type !== "ObjectExpression") return notLiteral;
  const property = contract.properties.find(
    (candidate) =>
      candidate.type === "Property" &&
      !candidate.computed &&
      ((candidate.key.type === "Identifier" && candidate.key.name === "questions") ||
        (candidate.key.type === "Literal" && candidate.key.value === "questions")),
  );
  if (property === undefined || property.type !== "Property") return notLiteral;
  return literal(property.value);
};

/** An unpublished example may ask only these fixed, reviewable questions. */
export const draftQuestionDeclarations = (
  path: string,
  source: string,
): ScriptQuestionDeclarations => {
  const value = draftQuestionValue(path, source);
  if (value === notLiteral) return {};
  return Either.getOrElse(
    Schema.decodeUnknownEither(ScriptQuestionDeclarations, { onExcessProperty: "error" })(value),
    () => ({}),
  );
};

/** Reject a literal contract's invalid ids before an example or write step can run. */
export const draftQuestionDeclarationFailure = (
  path: string,
  source: string,
): string | undefined => {
  const value = draftQuestionValue(path, source);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const invalidIds = Object.keys(value).filter((id) =>
    Either.isLeft(Schema.decodeUnknownEither(QuestionId)(id)),
  );
  if (invalidIds.length === 0) {
    const decoded = Schema.decodeUnknownEither(ScriptQuestionDeclarations, {
      onExcessProperty: "error",
    })(value);
    return Either.isLeft(decoded)
      ? `Invalid script questions: the run would declare none of them. Fix the declaration before executing: ${decoded.left.message}`
      : undefined;
  }
  return `Invalid script question ${invalidIds.length === 1 ? "id" : "ids"}: ${invalidIds
    .map((id) => JSON.stringify(id))
    .join(
      ", ",
    )}. Question ids must start with a lowercase letter and contain only lowercase letters, digits, or underscores, up to 64 characters. Rename them before executing.`;
};
