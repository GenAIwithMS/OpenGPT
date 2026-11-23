import { Data, Effect } from "effect";
import {
  LocalOperationFailure,
  type LocalOperationJournal,
  type LocalOperationOutput,
} from "../execution/local-operation.js";
import { InputRequestFailure } from "../runtime/input-request.js";
import type { WriteDeclaration } from "../runtime/operation.js";
import {
  classifyRun,
  commitReportOf,
  failedRunOutcome,
  returnedRefusal,
  runnerVerified,
  unconfirmedWrite,
  validatedWriteNeeds,
  unenteredWrite,
  type OutcomeRevision,
  type RunEvidence,
  type RunOutcome,
} from "../runtime/run-outcome.js";
import { SignInRunFailed } from "../runtime/sign-in-replay.js";
import { localFailureText } from "./failure-text.js";

/**
 * A run that did not end in a confirmed result. `outcome` says what it did to the website and how
 * to retry, and the message says the same in one sentence. A write that may have applied keeps
 * the output its script returned, unconfirmed. `journal` is what the operation reported about
 * the website, when it reported anything, for a keyed job's record.
 */
export class RunOutcomeFailure extends Data.TaggedError("RunOutcomeFailure")<{
  readonly outcome: RunOutcome;
  readonly text: string;
  readonly unconfirmed?: { readonly output: unknown };
  readonly journal?: LocalOperationJournal;
}> {
  override get message() {
    return this.text;
  }
}

/** The effect a run's request declares, when it declares one. */
export type DeclaredEffect = "read" | "write" | undefined;

/** A write the script declares is a write, whatever the request says. */
const revisionOf = (
  declared: "read" | "write",
  write: WriteDeclaration | undefined,
): OutcomeRevision =>
  write === undefined
    ? { effect: declared }
    : { effect: "write", writeConfirmation: write.confirmation };

/** The journal fields of an operation's result. */
const journalOf = ({ effect, commits, confirmation }: LocalOperationJournal): LocalOperationJournal =>
  confirmation === undefined ? { effect, commits } : { effect, commits, confirmation };

/** The website effect a write's journal shows. */
const journalEffect = (journal: LocalOperationJournal, revision: OutcomeRevision | undefined) =>
  journal.effect === "not_sent"
    ? "not_started"
    : journal.effect === "possible" || !runnerVerified(revision, "verified", journal.confirmation)
      ? "may_have_dispatched"
      : "verified";

const unconfirmedLead = {
  confirmation_missing:
    "The write returned without recording its confirmation, so it may have changed the website.",
  unverifiable:
    "This site offers no confirmation for the write, so it may have changed the website.",
} as const;

/**
 * A run whose operation returned: its output when it is a read, a confirmed write or a refusal
 * its output schema declares, returned before any commit step, else the
 * failure that says the write may have applied. A script that declares no write is a read unless
 * the request says it writes.
 *
 * A write's output that failed its schema (`outputDrift`) was produced after the write, so it is
 * returned as drift: as the result of a confirmed write or one that sent nothing, and as the
 * unconfirmed output of one that may have applied. One whose declared commit steps all stayed
 * unsent changed nothing and fails as invalid output, unless the caller left a pop-up's question
 * unanswered during the run (`unanswered`). Any other run's drifted output is no result: it fails
 * as the `InvalidOutput` it is, with what its journal shows.
 */
export const returnedRun = (
  declared: DeclaredEffect,
  result: LocalOperationOutput,
  unanswered = false,
): Effect.Effect<unknown, RunOutcomeFailure> => {
  const revision = revisionOf(declared ?? "read", result.write);
  const drift = result.outputDrift === true;
  if (drift && revision.effect === "read")
    return Effect.fail(
      runOutcomeFailure(declared, "operation", unanswered)(
        new LocalOperationFailure("InvalidOutput", journalOf(result), "InvalidOutput"),
      ),
    );
  const commits = commitReportOf(result);
  // A declared refusal returned before any commit step changed nothing, so the write did not apply.
  // Only a validated output declares one.
  const refusal =
    revision.effect === "write" && !drift
      ? returnedRefusal({
          outputSchema: result.schemas.output,
          output: result.output,
          commits: commits.evidence,
          runnerEffect: result.effect === "verified" ? "verified" : "may_have_dispatched",
        })
      : undefined;
  const journaled = journalEffect(result, revision);
  // A read holds no write authority, so its validated return completes it.
  const effect =
    revision.effect === "read"
      ? "verified"
      : refusal !== undefined || (drift && !unanswered && unenteredWrite(journaled, commits.marks))
        ? "rejected"
        : journaled;
  const evidence: RunEvidence = {
    status: "completed",
    effect,
    output: drift ? "invalid" : "valid",
    tool_effect: revision.effect,
    ...(drift ? { output_drift: true } : {}),
    ...(refusal === undefined ? {} : { declared_refusal: true }),
  };
  const outcome = classifyRun(evidence);
  if (outcome === undefined) return Effect.succeed(result.output);
  const needs = validatedWriteNeeds(revision, effect);
  return Effect.fail(
    new RunOutcomeFailure({
      outcome,
      text: localFailureText(outcome, needs === "nothing" ? undefined : unconfirmedLead[needs]),
      ...(unconfirmedWrite(evidence) ? { unconfirmed: { output: result.output } } : {}),
      journal: journalOf(result),
    }),
  );
};

const operationReasons: Readonly<Record<string, string>> = {
  NoResponse: "no_response",
  InvalidInput: "invalid_input",
  InputNotApplied: "input_not_applied",
  CredentialsRejected: "credentials_rejected",
};

/**
 * What a failed operation's journal shows. The commit marks decide, whatever failed the write: a
 * write that may have dispatched and whose child reported every declared commit step unsent
 * changed nothing (`unenteredWrite`), and a recorded confirmation keeps it applied. Only the
 * child's own final report proves that. A failure the host raised without it (its deadline, a
 * child that exited, an error or a result sent with host requests pending) keeps the write
 * possibly applied, as does a question left unanswered: this host keeps no request log to show
 * what the page sent before it. A run that fails after the caller left a pop-up's question
 * unanswered (`unanswered`) fails as that, as when the script's own question went unanswered.
 * A refused input or login, or a run that couldn't sign in again, with no commit step entered
 * also changed nothing. A failure with no journal may have dispatched anything.
 *
 * A run that couldn't sign in again (the host refused the sign-in a script waited for, as when
 * its sign-ins were spent or the sign-in failed) reports the sign-in unavailable, to retry with
 * the same request. That holds for a read and for a run that sent nothing or entered none of its
 * declared commit steps, and never once the journal shows a commit step entered or reports its
 * marks unreadably, whatever the request says. A write that may have applied keeps the outcome
 * its journal shows, so a retry can't repeat it.
 */
const operationEvidence = (
  declared: DeclaredEffect,
  error: unknown,
  unanswered: boolean,
): RunEvidence => {
  if (!(error instanceof LocalOperationFailure))
    return {
      status: "completed",
      effect: declared === "read" ? "not_started" : "may_have_dispatched",
      output: "failed",
      tool_effect: declared,
      ...(unanswered ? { failure_reason: "no_response" } : {}),
    };
  const { journal } = error;
  const tool = declared ?? (journal.commits.length > 0 ? "write" : undefined);
  const base =
    tool === "read"
      ? "not_started"
      : journalEffect(journal, tool === undefined ? undefined : { effect: tool });
  const report = commitReportOf(journal);
  const commits = report.evidence;
  const unentered = base === "may_have_dispatched" && commits === "not_entered";
  const signedOut =
    !unanswered &&
    error.sessionLoss === "session_not_kept" &&
    (commits === "not_entered" || commits === "undeclared") &&
    (base === "not_started" || unentered);
  const reason = unanswered
    ? "no_response"
    : signedOut
      ? "login_check_unavailable"
      : operationReasons[error.code ?? ""];
  const refused = signedOut || reason === "invalid_input" || reason === "credentials_rejected";
  // The child's own report, never one the host kept from the stream, and never past a question
  // left unanswered.
  const unsent =
    error.reported &&
    reason !== "no_response" &&
    unenteredWrite(base, report.marks);
  const effect = unsent || (refused && unentered) ? "rejected" : base;
  return {
    status: "completed",
    effect,
    output: error.code === "InvalidOutput" ? "invalid" : "failed",
    tool_effect: tool,
    failure_reason: reason,
    // The tool's own InvalidInput names the refused value's rule; a schema refusal names nothing.
    ...(reason === "invalid_input" && error.message !== "InvalidInput"
      ? { refusal_reason: error.message }
      : {}),
    ...(reason === "invalid_input" && error.refusal?.field !== undefined
      ? { refusal_field: error.refusal.field }
      : {}),
    ...(reason === "invalid_input" && error.refusal?.available !== undefined
      ? { refusal_available: error.refusal.available }
      : {}),
    ...(reason === "invalid_input" && error.refusal?.kind !== undefined
      ? { refusal_kind: error.refusal.kind }
      : {}),
    ...(reason === "input_not_applied" ? unappliedEvidence(error) : {}),
  };
};

/** An input the script could not apply: its own words and what the page kept instead. */
const unappliedEvidence = (error: LocalOperationFailure) => {
  const unapplied = error.unapplied;
  return {
    ...(error.message === "" ? {} : { refusal_reason: error.message }),
    ...(unapplied === undefined
      ? {}
      : {
          unapplied_input: {
            field: unapplied.field,
            requested: unapplied.requested,
            ...(unapplied.applied === undefined ? {} : { applied: unapplied.applied }),
            step: unapplied.step,
            ...(unapplied.siteMessage === undefined ? {} : { site_message: unapplied.siteMessage }),
          },
        }),
  };
};

/** What a failure before the operation shows: nothing reached the website through the tool. */
const beforeOperationEvidence = (declared: DeclaredEffect, error: unknown): RunEvidence => ({
  status: "completed",
  effect: "not_started",
  output: "failed",
  tool_effect: declared,
  ...(error instanceof InputRequestFailure && error.code === "NoResponse"
    ? { failure_reason: "no_response" }
    : {}),
});

/**
 * The failure a run reports for `error`, raised before its operation started (site checks,
 * sign-in questions, the start page) or during it. An outcome already classified passes through
 * unchanged. `unanswered` says the caller left a pop-up's question unanswered during the run.
 */
export const runOutcomeFailure =
  (declared: DeclaredEffect, stage: "before_operation" | "operation", unanswered = false) =>
  (error: unknown): RunOutcomeFailure => {
    if (error instanceof RunOutcomeFailure) return error;
    const outcome = failedRunOutcome(
      stage === "operation"
        ? operationEvidence(declared, error, unanswered)
        : beforeOperationEvidence(declared, error),
    );
    return new RunOutcomeFailure({
      outcome,
      text: localFailureText(outcome),
      ...(error instanceof LocalOperationFailure ? { journal: journalOf(error.journal) } : {}),
    });
  };

/**
 * The failure a run reports for `error` raised before its operation started. A sign-in failure
 * stays the typed `SignInRunFailed` a caller may catch: it names the field or step and what to
 * do, and nothing reached the website through the tool.
 */
export const beforeOperationFailure =
  (declared: DeclaredEffect) =>
  (error: unknown): RunOutcomeFailure | SignInRunFailed =>
    error instanceof SignInRunFailed ? error : runOutcomeFailure(declared, "before_operation")(error);
