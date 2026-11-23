import { Option, SchemaAST } from "effect";
import type { ParseResult } from "effect";

/**
 * What a schema node expects, from its structure, or for a refinement or transformation (such
 * as a prefixed ID) from its own description: never a decoded value.
 */
const expected = (ast: SchemaAST.AST): string => {
  if (SchemaAST.isUnion(ast))
    return ast.types
      .filter((member) => !SchemaAST.isUndefinedKeyword(member))
      .map(expected)
      .join(" or ");
  if (!SchemaAST.isRefinement(ast) && !SchemaAST.isTransformation(ast)) return ast.toString();
  const described = SchemaAST.getDescriptionAnnotation(ast);
  if (Option.isSome(described)) return described.value;
  return SchemaAST.isTransformation(ast) ? expected(ast.from) : ast.toString();
};

const segments = (path: PropertyKey | readonly PropertyKey[]): readonly PropertyKey[] =>
  typeof path === "object" ? path : [path];
const leafMessages = {
  Missing: "is required",
  Unexpected: "is not a field this accepts",
  Forbidden: "is not allowed",
} as const;

type Issue = { readonly message: string; readonly path: readonly PropertyKey[] };

const sameIssue = (left: Issue, right: Issue) =>
  left.message === right.message &&
  left.path.length === right.path.length &&
  left.path.every((segment, index) => segment === right.path[index]);

/**
 * A struct's or union's failures, each once, in the order its members report them: a union of
 * plain values that all fail is one issue.
 */
const compositeIssues = (issue: ParseResult.Composite, path: readonly PropertyKey[]): Issue[] => {
  // An optional field's `undefined` branch failing says nothing a caller can act on.
  const inner = ("_tag" in issue.issues ? [issue.issues] : issue.issues).filter(
    (member) => !(member._tag === "Type" && member.ast._tag === "UndefinedKeyword"),
  );
  if (issue.ast._tag === "Union" && inner.every((member) => member._tag === "Type"))
    return [{ path, message: `expected ${expected(issue.ast)}` }];
  const issues = inner.flatMap((member) => valueFreeIssues(member, path));
  // A union's members can fail alike, as two object shapes refusing a field neither declares.
  return issues.filter(
    (candidate, index) => issues.findIndex((other) => sameIssue(other, candidate)) === index,
  );
};

/**
 * Names each failing path and what it expects, never the value received, so an answer or a
 * diagnostic cannot reflect a private argument such as a password. A union of plain values
 * (literals, keywords) that all fail is one issue naming every member.
 */
export const valueFreeIssues = (
  issue: ParseResult.ParseIssue,
  path: readonly PropertyKey[] = [],
): Issue[] => {
  switch (issue._tag) {
    case "Pointer":
      return valueFreeIssues(issue.issue, [...path, ...segments(issue.path)]);
    case "Composite":
      return compositeIssues(issue, path);
    case "Refinement":
      return issue.kind === "Predicate"
        ? [{ path, message: `expected ${expected(issue.ast)}` }]
        : valueFreeIssues(issue.issue, path);
    case "Transformation":
      return issue.kind === "Transformation"
        ? [{ path, message: `expected ${expected(issue.ast)}` }]
        : valueFreeIssues(issue.issue, path);
    case "Type":
      return [{ path, message: `expected ${expected(issue.ast)}` }];
    case "Missing":
    case "Unexpected":
    case "Forbidden":
      return [{ path, message: leafMessages[issue._tag] }];
  }
};
