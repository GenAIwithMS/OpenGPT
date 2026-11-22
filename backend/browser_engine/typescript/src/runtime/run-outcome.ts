import { Option, Schema } from "effect";
import type { CommitMark } from "./context.js";
import { commitMarkMaxLength, commitMarkPattern } from "./operation.js";
import { inlineLocalRefs, UnresolvedSchemaReference } from "../registry/schema-references.js";

/*
 * What a finished or failed run did to the website, and what its caller is told. These functions
 * are pure and shared by every host: the local host classifies its runs with them, and another
 * host may classify its own job records with them and word the result in its own way through a
 * `FailureRenderer`.
 */

/**
 * A runner's report of a write's commit marks. Only authored mark names pass: a name is a short
 * identifier with no spaces or punctuation beyond hyphens and underscores, so a caller's value
 * such as an email address or a sentence never reaches host records as one.
 */
const CommitReport = Schema.Struct({
  commits: Schema.Array(
    Schema.Struct({
      name: Schema.String.pipe(
        Schema.maxLength(commitMarkMaxLength),
        Schema.pattern(commitMarkPattern),
      ),
      state: Schema.Literal("not_sent", "sent", "confirmed"),
    }),
  ),
});

/**
 * What a write's runner reported about its commit marks. `not_entered`: the script declared its
 * commit steps and entered none. `entered`: a commit step was about to dispatch or did.
 * `undeclared`: the script declared no marks, so a commit the ledger cannot see (a GET) stays
 * possible. `unreported`: no readable report, so nothing is known. Only `not_entered` ever lets a
 * write count as having sent nothing.
 */
export type CommitEvidence = "not_entered" | "entered" | "undeclared" | "unreported";

/** The evidence of a runner's own report of its commit marks, once that report was read. */
export const commitEvidenceOf = (marks: readonly CommitMark[]) =>
  marks.length === 0
    ? ("undeclared" as const)
    : marks.some((mark) => mark.state !== "not_sent")
      ? ("entered" as const)
      : ("not_entered" as const);

export interface CommitReportOutcome {
  readonly evidence: CommitEvidence;
  /** The marks as reported; absent when the report was missing or unreadable. */
  readonly marks?: readonly CommitMark[];
}

/**
 * What an execution's runner result proves about its commit steps. A missing or malformed report
 * proves nothing, and a script without declared marks leaves a commit the ledger cannot see (a
 * GET) possible, so only `not_entered` ever lets a write count as having sent nothing.
 */
export const commitReportOf = (resultJson: unknown): CommitReportOutcome => {
  const decoded = Schema.decodeUnknownOption(CommitReport)(resultJson);
  if (Option.isNone(decoded)) return { evidence: "unreported" };
  const marks = decoded.value.commits;
  return { evidence: commitEvidenceOf(marks), marks };
};

/**
 * A possibly dispatched write whose every declared commit stayed unsent changed nothing. The
 * commit marks, not the page's own traffic, say whether a failed write sent its commit, whatever
 * failed it. Pass the marks of the runner's own final report (`commitReportOf`), or undefined
 * when there is none: a missing or unreadable report, or marks only streamed while the write ran,
 * prove nothing. A host whose other channels, such as a relay that sends requests for the
 * script, may have sent a write must check those too.
 */
export const unenteredWrite = (effect: string, marks: readonly CommitMark[] | undefined) =>
  effect === "may_have_dispatched" &&
  marks !== undefined &&
  marks.length > 0 &&
  marks.every((mark) => mark.state === "not_sent");

/** The tool revision fields the outcome functions read: its effect and declared confirmation. */
export interface OutcomeRevision {
  readonly effect: "read" | "write";
  /** A write's declared confirmation; absent on reads and on writes published before it existed. */
  readonly writeConfirmation?: "message" | "readback" | "unverifiable" | undefined;
}

/**
 * Whether the runner's evidence verifies the run. A write published with a declared confirmation
 * is verified only by the confirmation it recorded (a script's `verified()` with its kind, an
 * HTTP implementation's `journal.confirmed`); an HTTP implementation's bare `journal.verified` is
 * not enough. A legacy write, published before the declaration existed, keeps its journal's
 * verified effect.
 */
export const runnerVerified = (
  revision: OutcomeRevision | undefined,
  runnerEffect: "not_started" | "may_have_dispatched" | "verified",
  confirmation: "message" | "readback" | undefined,
) =>
  runnerEffect === "verified" &&
  (revision?.effect !== "write" ||
    revision.writeConfirmation === undefined ||
    confirmation !== undefined);

/**
 * What a write run that returned a validated result still needs. `confirmation_missing`: the
 * script finished but never recorded its confirmation, so the run failed and whether the write
 * took effect is unknown. `unverifiable`: the site offers no confirmation, so the result is
 * possibly completed. Reads, verified writes and writes that returned a declared refusal before
 * committing (`rejected`, from `returnedRefusal`) need nothing.
 */
export const validatedWriteNeeds = (
  revision: OutcomeRevision | undefined,
  websiteEffect: string,
): "nothing" | "confirmation_missing" | "unverifiable" =>
  revision?.effect !== "write" || websiteEffect === "verified" || websiteEffect === "rejected"
    ? "nothing"
    : revision.writeConfirmation === "unverifiable"
      ? "unverifiable"
      : "confirmation_missing";

/** The `status` a write's output carries when the tool refused the task before committing. */
export const refusedStatus = "refused";
/** A refusal's reason: a stable lowercase code, such as `over_price_limit`. */
export const refusalReasonPattern = /^[a-z][a-z0-9_]*$/;
export const refusalReasonMaxLength = 64;

const isJsonRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Every value a JSON Schema admits when it admits only listed strings: a `const`, an `enum`, or
 * an `anyOf` or `oneOf` of those, so each listed value may carry its own description. Undefined
 * when the schema admits anything else.
 */
const listedStrings = (schema: unknown): readonly string[] | undefined => {
  if (!isJsonRecord(schema)) return undefined;
  if ("const" in schema) return typeof schema["const"] === "string" ? [schema["const"]] : undefined;
  const listed = schema["enum"];
  if (Array.isArray(listed))
    return listed.length > 0 && listed.every((value) => typeof value === "string")
      ? listed
      : undefined;
  const branches = schema["anyOf"] ?? schema["oneOf"];
  if (!Array.isArray(branches) || branches.length === 0) return undefined;
  const values = branches.map(listedStrings);
  return values.every((value) => value !== undefined) ? values.flat() : undefined;
};

/**
 * The reason codes one output schema branch declares as a refusal: an object schema that
 * requires `status` and `reason`, whose `status` admits only `refused` and whose `reason` admits
 * only listed reason codes. Undefined for any other branch.
 */
const refusalBranchReasons = (branch: unknown): readonly string[] | undefined => {
  if (!isJsonRecord(branch)) return undefined;
  const properties = branch["properties"];
  const required = branch["required"];
  if (!isJsonRecord(properties) || !Array.isArray(required)) return undefined;
  if (!required.includes("status") || !required.includes("reason")) return undefined;
  const status = listedStrings(properties["status"]);
  if (status === undefined || status.length !== 1 || status[0] !== refusedStatus) return undefined;
  const reasons = listedStrings(properties["reason"]);
  return reasons !== undefined &&
    reasons.every(
      (reason) => reason.length <= refusalReasonMaxLength && refusalReasonPattern.test(reason),
    )
    ? reasons
    : undefined;
};

/**
 * Whether a `status` schema that lists no strings is a string with a `pattern` that `refused` does
 * not match, as a schema check that reads patterns with the `u` flag tests it. False for an
 * invalid pattern, and for a `status` with a `const`, an `enum` or a union.
 */
const patternExcludesRefused = (status: unknown): boolean => {
  if (!isJsonRecord(status) || status["type"] !== "string") return false;
  if (["const", "enum", "anyOf", "oneOf"].some((key) => key in status)) return false;
  const pattern = status["pattern"];
  if (typeof pattern !== "string") return false;
  try {
    return !new RegExp(pattern, "u").test(refusedStatus);
  } catch {
    return false;
  }
};

/**
 * Whether a branch that is not a refusal could still match an object whose `status` is `refused`:
 * any object branch, unless its `status` lists only other strings or is a string whose pattern
 * `refused` does not match, or it has no `status` property, no pattern properties, and admits no
 * property it does not list.
 */
const admitsRefused = (branch: unknown): boolean => {
  if (!isJsonRecord(branch)) return branch !== false;
  const type = branch["type"];
  if (typeof type === "string" && type !== "object") return false;
  const properties = branch["properties"];
  const status = isJsonRecord(properties) ? properties["status"] : undefined;
  if (status === undefined)
    return branch["additionalProperties"] !== false || branch["patternProperties"] !== undefined;
  const listed = listedStrings(status);
  return listed === undefined ? !patternExcludesRefused(status) : listed.includes(refusedStatus);
};

/** Keywords that describe a schema without changing what it admits. */
const annotationKeywords = new Set([
  "$comment",
  "deprecated",
  "description",
  "examples",
  "readOnly",
  "title",
  "writeOnly",
]);
/** How many unions deep inside the output's own union its branches are read. */
const nestedUnionDepth = 8;

/**
 * The branches of a schema that is only a union: one non-empty `anyOf` or `oneOf`, with nothing
 * beside it but annotations. Undefined for any other schema.
 */
const unionOnlyBranches = (schema: unknown): readonly unknown[] | undefined => {
  if (!isJsonRecord(schema)) return undefined;
  const keys = Object.keys(schema).filter((key) => !annotationKeywords.has(key));
  if (keys.length !== 1 || (keys[0] !== "anyOf" && keys[0] !== "oneOf")) return undefined;
  const branches = schema[keys[0]];
  return Array.isArray(branches) && branches.length > 0 ? branches : undefined;
};

/**
 * The output's branches, each branch that is only a union replaced by its own branches, down to
 * `nestedUnionDepth` unions deep. Effect writes `Schema.Union(Placed, Schema.Union(A, B))` as an
 * `anyOf` inside an `anyOf`, and an output that matches it matches one of `Placed`, `A` and `B`.
 */
const outputBranches = (branches: readonly unknown[], depth: number): readonly unknown[] =>
  branches.flatMap((branch) => {
    const nested = depth < nestedUnionDepth ? unionOnlyBranches(branch) : undefined;
    return nested === undefined ? [branch] : outputBranches(nested, depth + 1);
  });

/**
 * The refusal reasons a tool's output JSON Schema declares, as it publishes it. A write declares
 * a refusal as a branch of its output, the root schema or one of the root's `anyOf` or `oneOf`
 * branches, with local `$ref`s resolved: an object that requires `status`, admitting only
 * `refused`, and `reason`, admitting only listed reason codes, plus whatever values the caller
 * needs, such as the total and the limit it exceeded:
 *
 * `Schema.Union(Placed, Schema.Struct({ status: Schema.Literal("refused"), reason:
 * Schema.Literal("over_price_limit"), total: Schema.String, limit: Schema.String }))`
 *
 * A branch that is only a union, with nothing beside its `anyOf` or `oneOf` but annotations,
 * counts as its own branches, up to eight unions deep, so refusals grouped in a union of their
 * own are read as well.
 *
 * Empty when the schema declares no refusal, as every schema published before the convention
 * existed that has no such branch does, and when another branch could also match a `refused`
 * status, such as one whose `status` is free text, since a matching output would not show which
 * branch it is. A `status` that lists other strings, or is a string whose `pattern` does not
 * match `refused`, cannot.
 */
export const declaredRefusalReasons = (outputSchema: unknown): ReadonlySet<string> => {
  if (!isJsonRecord(outputSchema)) return new Set();
  let root: Record<string, unknown>;
  try {
    root = inlineLocalRefs({ ...outputSchema });
  } catch (error) {
    if (error instanceof UnresolvedSchemaReference) return new Set();
    throw error;
  }
  const union = root["anyOf"] ?? root["oneOf"];
  const branches = Array.isArray(union) ? outputBranches(union, 0) : [root];
  const refusals = branches.map(refusalBranchReasons);
  // An output proves itself a refusal only when no other branch could have matched it.
  if (branches.some((branch, index) => refusals[index] === undefined && admitsRefused(branch)))
    return new Set();
  return new Set(refusals.flatMap((reasons) => reasons ?? []));
};

/** Whether a schema, or a branch of its unions or `allOf`, lists `refused` as its `status`. */
const listsRefusedStatus = (schema: unknown, depth: number): boolean => {
  if (!isJsonRecord(schema) || depth > nestedUnionDepth * 2) return false;
  const properties = schema["properties"];
  const status = isJsonRecord(properties) ? properties["status"] : undefined;
  if (listedStrings(status)?.includes(refusedStatus) === true) return true;
  return ["anyOf", "oneOf", "allOf"].some((key) => {
    const branches = schema[key];
    return (
      Array.isArray(branches) && branches.some((branch) => listsRefusedStatus(branch, depth + 1))
    );
  });
};

/**
 * Whether a write's output schema has a refusal the host cannot read: some branch lists
 * `refused` as its `status`, so the write means to return refusals, and `declaredRefusalReasons`
 * finds none. A run that returns one is not a declared refusal, so it ends as an unknown outcome,
 * like any other unconfirmed write. A schema whose references do not resolve has none.
 */
export const unreadableRefusal = (outputSchema: unknown): boolean => {
  if (!isJsonRecord(outputSchema) || declaredRefusalReasons(outputSchema).size > 0) return false;
  try {
    return listsRefusedStatus(inlineLocalRefs({ ...outputSchema }), 0);
  } catch (error) {
    if (error instanceof UnresolvedSchemaReference) return false;
    throw error;
  }
};

/** A refusal a write returned as its output: the reason code its output schema declares. */
export interface DeclaredRefusal {
  readonly reason: string;
}

/**
 * The refusal a validated output is, when its `status` is `refused` and its `reason` is one the
 * output schema declares; undefined for any other output, a refusal shape the schema does not
 * declare included.
 */
export const declaredRefusalOf = (
  outputSchema: unknown,
  output: unknown,
): DeclaredRefusal | undefined => {
  if (!isJsonRecord(output) || output["status"] !== refusedStatus) return undefined;
  const reason = output["reason"];
  return typeof reason === "string" && declaredRefusalReasons(outputSchema).has(reason)
    ? { reason }
    : undefined;
};

/**
 * The refusal a write that returned a validated output made before committing, or undefined
 * when it must be classified as any other returned write. Only a declared refusal counts, and
 * only when the runner proves nothing was committed: the write declared its commit steps and
 * entered none (`not_entered`), and recorded no confirmation (`runnerEffect` is not `verified`).
 * A refusal returned after a commit step was entered, by a write that declares no commit steps,
 * or with a missing or unreadable report may have changed the website, so it stays unconfirmed.
 *
 * Two cautions for a host that passes `commits`:
 * - The evidence must cover every channel the run could send the write through. A request a host
 *   relays for the script, such as an HTTP transport that sends on its behalf, never enters a
 *   mark, so a host whose relay may have sent anything other than a read must not call this.
 * - A journal made with `makeEffectJournalWith({ settledCommits })` reports the settled marks as
 *   `not_sent`, although an earlier run sent them. A maintenance or continuation run that uses one
 *   must never be judged by its marks here.
 */
export const returnedRefusal = (returned: {
  readonly outputSchema: unknown;
  readonly output: unknown;
  readonly commits: CommitEvidence;
  readonly runnerEffect: string;
}): DeclaredRefusal | undefined =>
  returned.commits === "not_entered" && returned.runnerEffect !== "verified"
    ? declaredRefusalOf(returned.outputSchema, returned.output)
    : undefined;

/**
 * Why a write may not run again on its own, from its commit evidence alone. Only a write whose
 * declared commit steps were never entered may.
 */
export const commitRetryRefusal = (evidence: CommitEvidence) =>
  evidence === "not_entered" ? undefined : (`commit_${evidence}` as const);

/**
 * What a run's record says, as the classifier reads it. `status` is how the run ended
 * (`completed`, `cleanup_pending`, `outcome_unknown`, `cancelled`), `effect` what it did to the
 * website (`not_started`, `may_have_dispatched`, `verified`, `rejected`, `unknown`, `partial`),
 * `output` whether its result matched the tool's schema (`valid`, `invalid`, `failed`).
 */
export interface RunEvidence {
  readonly status: string;
  readonly effect: string;
  readonly output: string;
  /** The output did not match the schema, but the run reported it. */
  readonly output_drift?: boolean | undefined;
  /** The tool revision's own effect, when known. */
  readonly tool_effect?: "read" | "write" | undefined;
  /** Why the run stopped, when a known reason stopped it. */
  readonly failure_reason?: string | undefined;
  /** The run's own judgement that a step may have changed the website. */
  readonly possible_commit?: boolean | undefined;
  /**
   * For `no_response`: the kind of question the run's caller left unanswered, as the host names
   * it, such as `sign_in`, `login` or `other`. Absent when the host did not record one.
   */
  readonly unanswered_question?: string | undefined;
  /**
   * The write returned, before committing, a refusal its output schema declares, as
   * `returnedRefusal` found it; its effect is then `rejected`, and its output says why.
   */
  readonly declared_refusal?: boolean | undefined;
  /** The tool's or the site's own words, for a refused input or an input the page did not apply. */
  readonly refusal_reason?: string | undefined;
  /** The input a refusal named, when the tool named it. */
  readonly refusal_field?: string | undefined;
  /** Every choice the page offers for the refused input, when the tool read them. */
  readonly refusal_available?: readonly string[] | undefined;
  /** The refusal's kind as a short token, such as a refused cursor's `expired`. */
  readonly refusal_kind?: string | undefined;
  /** The login field the website rejected. */
  readonly rejected_field?: string | undefined;
  /** The input the caller supplied that the page did not apply, and what it kept instead. */
  readonly unapplied_input?: RunUnappliedInputEvidence | undefined;
  /** @deprecated A record an earlier release kept: read only when `unapplied_input` is absent. */
  readonly location?: RunUnappliedInputEvidence | undefined;
}

/** An input the page did not apply, as a run's record keeps it. */
export interface RunUnappliedInputEvidence {
  readonly field: string;
  readonly requested: string;
  readonly applied?: string | undefined;
  readonly step: string;
  readonly site_message?: string | undefined;
}

/**
 * How a caller may repeat a run that failed with a code. `never`: check the outcome first and
 * do not repeat it as is. `fix_input`: correct the input or the login, then run it again.
 * `same_key`: the same request may be repeated as is. `new_key`: a repeat is a new run, after
 * checking the website when a step may have changed it.
 */
export type RunRetryClass = "never" | "fix_input" | "same_key" | "new_key";

/** Every code the classifier returns. A host's renderer words each one. */
export const runOutcomeCodes = [
  "no_response",
  "credentials_rejected",
  "input_rejected",
  "input_not_applied",
  "login_identity_conflict",
  "website_sign_in_unavailable",
  "worker_lost",
  "outcome_unknown",
  "invalid_output",
  "execution_failed",
] as const;
export type RunOutcomeCode = (typeof runOutcomeCodes)[number];

/** Each code's retry class. A write that recorded its confirmation is `never`, whatever its code. */
export const runOutcomeRetry: { readonly [Code in RunOutcomeCode]: RunRetryClass } = {
  no_response: "new_key",
  credentials_rejected: "fix_input",
  input_rejected: "fix_input",
  input_not_applied: "same_key",
  login_identity_conflict: "fix_input",
  website_sign_in_unavailable: "same_key",
  worker_lost: "same_key",
  outcome_unknown: "never",
  invalid_output: "never",
  execution_failed: "never",
};

/** A failed run's code and its details, which a host may answer as JSON. */
export interface RunFailure {
  readonly code: RunOutcomeCode;
  readonly details: Readonly<Record<string, unknown>>;
}
const failure = (code: RunOutcomeCode, details?: Readonly<Record<string, unknown>>): RunFailure => ({
  code,
  details: details ?? {},
});

/**
 * A write that recorded its confirmation: the commit response or the page confirmed it. The write
 * landed, so whatever failed after the confirmation, the run reports it applied and never runs it
 * again.
 */
export const confirmedWrite = (view: RunEvidence) =>
  view.tool_effect === "write" && view.effect === "verified";

/** A run whose website effect may have changed the site without a confirmed outcome. */
export const unsettledEffect = (view: RunEvidence) =>
  view.status === "outcome_unknown" ||
  view.effect === "unknown" ||
  view.effect === "partial" ||
  view.effect === "may_have_dispatched";
/**
 * A run that ended in its result: a read, a confirmed write, a run that never touched the site,
 * or a write that returned one of its declared refusals before committing, which changed nothing.
 */
export const confirmedRun = (view: RunEvidence) =>
  (view.output === "valid" || view.output_drift === true) &&
  (view.status === "completed" || view.status === "cleanup_pending") &&
  (view.effect === "verified" ||
    view.effect === "not_started" ||
    (view.effect === "rejected" && view.declared_refusal === true));

/**
 * Whether a step may already have changed the website: the job says so, its effect is unsettled,
 * or its write read back its confirmation, so the website did change. Only a read's verified
 * effect changed nothing.
 */
export const possibleCommit = (view: RunEvidence) =>
  view.possible_commit === true ||
  unsettledEffect(view) ||
  (view.effect === "verified" && view.tool_effect !== "read");

/** A rejected login's details: whether a step may have committed, and the field it named. */
export const rejectedDetails = (view: RunEvidence, committed: boolean) => ({
  possible_commit: committed,
  ...(view.rejected_field === undefined ? {} : { field: view.rejected_field }),
});

/**
 * Starting over is safe only for a read or an untouched site. A confirmed write's outcome is
 * known, and it never runs again.
 */
const lostWorker = (view: RunEvidence): RunFailure =>
  view.tool_effect === "read" || view.effect === "not_started" || confirmedWrite(view)
    ? failure("worker_lost")
    : failure("outcome_unknown");

/** An input that did not apply ends a run that may run again: a read, or a site left untouched. */
const unappliedRetryable = (view: RunEvidence) =>
  view.possible_commit !== true &&
  !unsettledEffect(view) &&
  (view.tool_effect === "read" || view.effect === "not_started" || view.effect === "rejected");

/** Why a settled run failed. */
export const runError = (view: RunEvidence): RunFailure => {
  switch (view.failure_reason) {
    case "no_response":
      return failure("no_response", {
        possible_commit: possibleCommit(view),
        ...(view.unanswered_question === undefined ? {} : { question: view.unanswered_question }),
      });
    case "credentials_rejected":
      return failure("credentials_rejected", rejectedDetails(view, possibleCommit(view)));
    case "invalid_input":
      return failure("input_rejected", {
        possible_commit: possibleCommit(view),
        ...(view.refusal_reason === undefined ? {} : { reason: view.refusal_reason }),
        ...(view.refusal_field === undefined ? {} : { field: view.refusal_field }),
        ...(view.refusal_available === undefined || view.refusal_available.length === 0
          ? {}
          : { available: view.refusal_available }),
        ...(view.refusal_kind === undefined ? {} : { kind: view.refusal_kind }),
      });
    case "input_not_applied":
    // A record an earlier release kept under the location-only reason.
    case "location_not_applied": {
      // Only a read or an untouched site may run again as is; a write that applied or may have,
      // or a run that judged a step may have committed, keeps its own outcome.
      if (!unappliedRetryable(view)) break;
      const unapplied = view.unapplied_input ?? view.location;
      return failure("input_not_applied", {
        possible_commit: false,
        ...(view.refusal_reason === undefined ? {} : { reason: view.refusal_reason }),
        ...(unapplied === undefined
          ? {}
          : {
              field: unapplied.field,
              requested: unapplied.requested,
              ...(unapplied.applied === undefined ? {} : { applied: unapplied.applied }),
              step: unapplied.step,
              ...(unapplied.site_message === undefined
                ? {}
                : { site_message: unapplied.site_message }),
            }),
      });
    }
    case "login_identity_conflict":
      return failure("login_identity_conflict", {});
    case "login_check_unavailable":
      return failure("website_sign_in_unavailable");
    case "worker_lost":
      return lostWorker(view);
    case undefined:
      break;
  }
  if (unsettledEffect(view) && !confirmedWrite(view)) return failure("outcome_unknown");
  return failure(view.output === "invalid" ? "invalid_output" : "execution_failed");
};

/** What a write did to the website; null for a read or a tool whose effect is unknown. */
export type WriteStatus = "not_attempted" | "may_have_applied" | "applied" | "not_applied";
export const writeStatusOf = (view: RunEvidence): WriteStatus | null => {
  if (view.tool_effect !== "write") return null;
  if (view.effect === "verified") return "applied";
  if (unsettledEffect(view)) return "may_have_applied";
  if (view.effect === "rejected") return "not_applied";
  return "not_attempted";
};

/** A failed write that may have changed the site keeps the result its script returned, unconfirmed. */
export const unconfirmedWrite = (view: RunEvidence) =>
  view.tool_effect === "write" &&
  (unsettledEffect(view) || view.failure_reason === "worker_lost") &&
  (view.output === "valid" || view.output_drift === true);

/**
 * A run that did not end in a confirmed result: its code, write status and retry class.
 * `possibleCommit` follows the code and `writeStatus` follows the evidence, so they can differ:
 * a code that carries no possible commit can still describe a write that `may_have_applied`.
 * Either one means the website may have changed.
 */
export interface RunOutcome extends RunFailure {
  readonly writeStatus: WriteStatus | null;
  /** True: the code says a step may already have changed the website. */
  readonly possibleCommit: boolean;
  readonly retry: RunRetryClass;
}

/**
 * Whether an outcome tells its caller that a step may have committed. A code that carries
 * `possible_commit` says so in its details, `outcome_unknown` always may have, and every other
 * code means nothing reached the website or the website's effect is settled.
 */
const outcomeMayHaveCommitted = (failed: RunFailure) => {
  const stated = failed.details["possible_commit"];
  return typeof stated === "boolean" ? stated : failed.code === "outcome_unknown";
};

/**
 * A settled run's outcome when it did not end in a confirmed result. A confirmed write that then
 * failed keeps the code that says why, and is never run again.
 */
export const failedRunOutcome = (view: RunEvidence): RunOutcome => {
  const failed = runError(view);
  return {
    ...failed,
    writeStatus: writeStatusOf(view),
    possibleCommit: outcomeMayHaveCommitted(failed),
    retry: confirmedWrite(view) ? "never" : runOutcomeRetry[failed.code],
  };
};

/** A settled run's outcome; undefined when it ended in a confirmed result. */
export const classifyRun = (view: RunEvidence): RunOutcome | undefined =>
  confirmedRun(view) ? undefined : failedRunOutcome(view);

/** A run outcome in one host's words. */
export interface RenderedFailure {
  /** What happened. */
  readonly message: string;
  /** What to do next. */
  readonly remediation: string;
  /** The retry class the words carry, which is the outcome's own. */
  readonly retry: string;
  /** The HTTP status, for a host that answers over HTTP. */
  readonly status?: number;
}

/**
 * The failure renderer hook: turns a run outcome into one host's words. A host words every code
 * in `runOutcomeCodes`; `failureRendererIssues` checks that it does, and that every possible
 * commit tells the caller to read the website back before any retry.
 */
export interface FailureRenderer {
  /** The codes this renderer words; equal to `runOutcomeCodes`. */
  readonly codes: readonly RunOutcomeCode[];
  /** How this host's words tell a caller to read the website back before any retry. */
  readonly readBackAdvice: string | RegExp;
  readonly render: (outcome: RunOutcome) => RenderedFailure;
}
