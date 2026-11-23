import { Data, ParseResult } from "effect";
import type { Schema, SchemaAST } from "effect";
import type {
  CaptureFailureReason,
  CaptureCollectionDiagnostic,
  CaptureScreeningDiagnostic,
} from "./capture-diagnostic.js";
import type { ScreeningReasonValue } from "./diagnostic-reasons.js";
import type { FailureDetail } from "./failure-detail.js";

export type Dispatch = "not_sent" | "sent" | "unknown";

/**
 * Where an input schema rejected an input: the property path (`""` for the input itself) and
 * whether the value was `missing` or `invalid` there. Never the value, and never a key the caller
 * chose, so it can go to the minter.
 */
export interface InputIssue {
  readonly path: string;
  readonly issue: "missing" | "invalid";
}

/** At most this many issues, each path at most this long, go back. */
export const maximumInputIssues = 20;
export const maximumInputIssuePath = 200;

/** A key the schema does not declare, such as a record's, which is the caller's own text. */
const undeclaredKey = "[key]";
const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

/** The schemas a path segment can lead into from `ast`, and whether `key` is declared there. */
const childrenOf = (
  ast: SchemaAST.AST,
  key: PropertyKey,
): { readonly declared: boolean; readonly children: readonly SchemaAST.AST[] } => {
  switch (ast._tag) {
    case "Refinement":
      return childrenOf(ast.from, key);
    case "Transformation": {
      const [from, to] = [childrenOf(ast.from, key), childrenOf(ast.to, key)];
      return {
        declared: from.declared || to.declared,
        children: [...from.children, ...to.children],
      };
    }
    case "Suspend":
      return childrenOf(ast.f(), key);
    case "Union": {
      const members = ast.types.map((member) => childrenOf(member, key));
      return {
        declared: members.some((member) => member.declared),
        children: members.flatMap((member) => member.children),
      };
    }
    case "TypeLiteral": {
      const property = ast.propertySignatures.find((candidate) => candidate.name === key);
      return property === undefined
        ? { declared: false, children: ast.indexSignatures.map((signature) => signature.type) }
        : { declared: true, children: [property.type] };
    }
    case "TupleType": {
      if (typeof key !== "number") return { declared: false, children: [] };
      const element = ast.elements[key];
      return {
        declared: true,
        children: element === undefined ? ast.rest.map((rest) => rest.type) : [element.type],
      };
    }
    default:
      return { declared: false, children: [] };
  }
};

/** One rejected path as text: declared names and indexes kept, any other key `[key]`. */
const issuePath = (ast: SchemaAST.AST, path: readonly PropertyKey[]) => {
  let at: readonly SchemaAST.AST[] = [ast];
  let text = "";
  for (const key of path) {
    const next = at.map((candidate) => childrenOf(candidate, key));
    const declared = next.some((candidate) => candidate.declared);
    text +=
      !declared || typeof key === "symbol"
        ? undeclaredKey
        : typeof key === "number"
          ? `[${key}]`
          : identifier.test(key)
            ? `${text === "" ? "" : "."}${key}`
            : `[${JSON.stringify(key)}]`;
    at = next.flatMap((candidate) => candidate.children);
  }
  return text.length > maximumInputIssuePath
    ? `${text.slice(0, maximumInputIssuePath - 1)}…`
    : text;
};

/**
 * The rejected paths of a decode of `schema`, one per path, at most `maximumInputIssues`. A
 * property name the schema declares and an array index are kept; a key it does not declare, such
 * as a record's, reads `[key]`.
 */
export const inputIssues = (
  schema: Schema.Schema.Any,
  error: ParseResult.ParseError,
): readonly InputIssue[] => {
  const issues = new Map<string, InputIssue["issue"]>();
  for (const { _tag, path } of ParseResult.ArrayFormatter.formatErrorSync(error)) {
    const at = issuePath(schema.ast, path);
    if (issues.get(at) !== "missing") issues.set(at, _tag === "Missing" ? "missing" : "invalid");
  }
  return [...issues].slice(0, maximumInputIssues).map(([path, issue]) => ({ path, issue }));
};

export class InvalidInput extends Data.TaggedError("InvalidInput")<{
  readonly operation: string;
  /** Where the schema rejected the input, when the decode said so. */
  readonly issues?: readonly InputIssue[];
}> {}

export class InvalidOutput extends Data.TaggedError("InvalidOutput")<{
  readonly operation: string;
  /** The schema error, as `Error.cause`; the host's projection keeps only the tag. */
  readonly cause?: unknown;
  /** What the operation returned, which the runner hands the host as drifted output. */
  readonly output?: unknown;
}> {}

/** A write declared `unverifiable` recorded a confirmation; its declaration and its code disagree. */
export class WriteConfirmationRefused extends Data.TaggedError("WriteConfirmationRefused")<{
  readonly declared: "unverifiable";
  readonly recorded: "message" | "readback";
}> {}

/**
 * A maintenance execution entered a settled commit step: one the original run confirmed, or one
 * it marked `sent` that this run's read-back did not find missing. It fails before the step's
 * execute call, so this call sends nothing. A run's `notCommitted` fails with it too when the step
 * may already have saved, so the step stays sent.
 */
export class CommitAlreadySent extends Data.TaggedError("CommitAlreadySent")<{
  readonly name: string;
}> {}

export class DeadlineExceeded extends Data.TaggedError("DeadlineExceeded")<{
  readonly phase: string;
  readonly dispatch: Dispatch;
  /** Which browser.pw option was configured; this does not identify the winning deadline. */
  readonly pwTimeoutSource?: "action_default" | "explicit_option";
}> {}

export class CaptureUnavailable extends Data.TaggedError("CaptureUnavailable")<{
  readonly phase: "start" | "finish";
  readonly captureReason?: CaptureFailureReason;
  readonly captureCollection?: CaptureCollectionDiagnostic;
  readonly captureScreening?: typeof CaptureScreeningDiagnostic.Type;
  readonly captureReleasePreparation?: "complete";
}> {}

export class EventUnavailable extends Data.TaggedError("EventUnavailable")<{
  readonly event: string;
  /** Host-side detail of a finite-metadata or serialization failure; archive-only. */
  readonly failureDetail?: FailureDetail;
  readonly screeningReason?: ScreeningReasonValue;
  readonly diagnosticStorageFailure?:
    | "credentials"
    | "denied"
    | "conflict"
    | "transport"
    | "timeout"
    | "service"
    | "verification"
    | "cancelled"
    | "unavailable";
}> {}

export class BrowserFailure extends Data.TaggedError("BrowserFailure")<{
  readonly operation: string;
  readonly dispatch: Dispatch;
  /** Private execution detail; screen before releasing logs or model observations. */
  readonly cause?: unknown;
}> {}

export class TargetPageMismatch extends Data.TaggedError("TargetPageMismatch")<{}> {}

export class TargetNotFound extends Data.TaggedError("TargetNotFound")<{}> {}

export class TargetAmbiguous extends Data.TaggedError("TargetAmbiguous")<{
  readonly count: number;
}> {}

export class TargetGuardMismatch extends Data.TaggedError("TargetGuardMismatch")<{
  readonly guard: string;
}> {}

export class TargetGuardUnavailable extends Data.TaggedError("TargetGuardUnavailable")<{
  readonly guard: string;
}> {}

export type ConditionState = "passed" | "failed" | "unknown";

export interface ConditionObservation {
  readonly name: string;
  readonly state: ConditionState;
}

export class ConditionTimeout extends Data.TaggedError("ConditionTimeout")<{
  readonly phase: "ready" | "guard" | "complete";
  readonly dispatch: Dispatch;
  readonly conditions: readonly ConditionObservation[];
  readonly configuredMs: number;
  readonly effectiveMs: number;
}> {}

export class FixtureUnavailable extends Data.TaggedError("FixtureUnavailable")<{
  readonly reason: "missing_body" | "invalid_json" | "unsupported_encoding";
  /** The decode or parse error, as `Error.cause`. */
  readonly cause?: unknown;
}> {}

export class OfflineTrafficDenied extends Data.TaggedError("OfflineTrafficDenied")<{
  readonly count: number;
}> {}
