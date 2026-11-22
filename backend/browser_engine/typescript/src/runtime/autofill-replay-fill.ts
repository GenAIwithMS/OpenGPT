import { Effect } from "effect";
import type { YieldableError } from "effect/Cause";
import { timeExecutionStage } from "./sign-in-telemetry.js";
import { logicalRejectedField, rejectableSlot } from "./autofill-rejection.js";
import type {
  AutofillInspection,
  AutofillSlot,
  AutofillStep,
} from "../destinations/autofill-step.js";
import { maySend } from "../destinations/autofill-refusal.js";
import {
  armStep,
  type AutofillSecret,
  isSecret,
  recordStep,
  registeredSecretIn,
  screenSubmit,
  submitFilled,
} from "./autofill-state.js";
import { Unanswered } from "./login-field-asks.js";
import { credentialUnavailable } from "./autofill-fresh-values.js";
import type { ReplaySession } from "./autofill-replay-session.js";
import type { RejectedMarker } from "../destinations/autofill-recipe.js";
import type { AutofillLogin } from "./autofill-values.js";
import {
  emptyReplayFields,
  refillRefused,
  noteMaySent,
  fillFailure,
  settleFilled,
  stepDiagnostic,
  valuesFor,
} from "./autofill-replay-steps.js";
/** Exclude every previously submitted code from the next fresh-code request. */
const noteCodeValues = (
  rejectedCodes: Set<string>,
  step: AutofillStep,
  filled: readonly string[],
) => {
  for (const [index, field] of step.fields.entries())
    if (field.slot === "code" && filled[index] !== undefined) rejectedCodes.add(filled[index]);
};
/** Record actual host-filled values and consumed code submissions for later rejection evidence. */
const recordFilledValues = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  session: ReplaySession<E, V, L>,
  step: AutofillStep,
  filled: readonly string[],
  codeAgain: "rejected" | undefined,
) => {
  const { retryState, input } = session;
  for (const [index, field] of step.fields.entries()) {
    const value = filled[index];
    // A private answer is never rejection evidence, so it is never kept past its fill.
    if (value !== undefined && rejectableSlot(field.slot))
      retryState.lastFilled[
        logicalRejectedField(field.slot, input.credentials?.primaryIdentifierKind)
      ] = value;
  }
  if (codeAgain === "rejected" && step.fields.some((field) => field.slot === "code"))
    retryState.codeAttempts.current += 1;
};
/**
 * A code the step could not get after the site refused one ends as that refusal, unless the host
 * could not read a code it keeps for the login at all (`credentialUnavailable`), which is its own.
 */
const codeRejectedAgain = (codeAgain: "rejected" | undefined, unanswered: Unanswered) =>
  codeAgain === "rejected" && unanswered.cause !== credentialUnavailable;
/** Admission preserves each replay's unchanged-secret cap and the sign-in's code correction cap. */
const retryRefusal = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  session: ReplaySession<E, V, L>,
  asked: AutofillStep,
  codeAgain: "rejected" | undefined,
  explicitCodeRejection: boolean,
  corrected: ReadonlySet<AutofillSlot>,
  planned: readonly AutofillSecret[],
) => {
  const { retryState, sent, progress } = session;
  if (
    codeAgain === "rejected" &&
    asked.fields.some((field) => field.slot === "code") &&
    retryState.codeAttempts.current >= 2
  )
    return "code_rejected" as const;
  if (refillRefused(asked, sent.maySent, progress.refilled, codeAgain, corrected, planned))
    return codeAgain === "rejected" && explicitCodeRejection
      ? "code_rejected"
      : "credential_already_filled";
  return undefined;
};

/**
 * One observed screen: admitted by the host, filled and submitted. Why it did not complete, or
 * undefined. `planned` is the recorded screen's `refills`.
 */
export const runReplayStep = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  session: ReplaySession<E, V, L>,
  asked: AutofillStep,
  inspection: AutofillInspection,
  codeAgain?: "rejected",
  explicitCodeRejection = false,
  corrected: ReadonlySet<AutofillSlot> = new Set(),
  planned: readonly AutofillSecret[] = [],
) =>
  Effect.gen(function* () {
    const {
      input,
      hooks,
      retryState,
      sent,
      progress,
      values,
      rejectedCodes,
      codeRequests,
      state,
    } = session;
    codeAgain ??= retryState.rejectedValues.code?.size ? "rejected" : undefined;
    // The replay went on: a screen before that no click sent sent itself, before the bound counts.
    settleCarried(session);
    const refused = retryRefusal(
      session,
      asked,
      codeAgain,
      explicitCodeRejection,
      corrected,
      planned,
    );
    if (refused !== undefined) return refused;
    const resolved = yield* valuesFor(
      input,
      values,
      progress.chosen,
      asked,
      codeAgain,
      {
        rejectedCodes,
        codeRequests,
        rejectedValues: retryState.rejectedValues,
        correctionRequests: retryState.correctionRequests,
      },
      inspection.screen.fields,
      // A code screen the recipe never recorded that refused a code may want one the site sent
      // rather than the host's generator's, so its retries never spend a try on that.
      codeAgain !== "rejected" || progress.unrecordedCodeScreen === undefined,
    );
    if (resolved instanceof Unanswered)
      if (corrected.size > 0) return "extra_rejected";
      else
        return codeRejectedAgain(codeAgain, resolved)
          ? "code_rejected"
          : yield* input.failures.unanswered(resolved.cause, resolved.field);
    // The kinds the fields were sent as: an answer to a field that accepts several decides.
    const { values: filled, step, recoveryCodes } = resolved;
    noteCodeValues(rejectedCodes, step, filled);
    if (yield* input.hosted?.identifierConflict?.(step, filled) ?? Effect.succeed(false)) {
      yield* input.hosted?.settleRecoveryCodes?.(recoveryCodes, false) ?? Effect.void;
      return "identifier_conflict";
    }
    // What went out before this fill.
    const sentBefore = new Set(sent.maySent);
    yield* armStep(
      state,
      step,
      inspection,
      filled,
      registeredSecretIn(input.broker, { component: "worker", correlation: input.correlation }),
    );
    session.firstCause.submitted();
    const stepReport = yield* hooks.fill({ step, values: filled, inspection });
    yield* timeExecutionStage(
      input.latency,
      "autofill_settle",
      settleFilled(input, sent, step, recoveryCodes, recordStep(state, step, stepReport)),
    );
    // A click, or a lost answer, sent every filled value, a fieldless submit's carried ones too.
    if (maySend(stepReport)) {
      submitFilled(state);
      if (step.fields.length > 0) {
        recordFilledValues(session, step, filled, codeAgain);
        progress.anythingSent = true;
        input.sent.current = true;
        noteMaySent(step, sentBefore, sent.maySent, progress.refilled);
      }
    }
    yield* input.emit(stepDiagnostic(step, stepReport));
    progress.ran.push(step);
    return fillFailure(stepReport);
  });

/**
 * The replay went on from a screen whose values no click sent, such as a code box that submits on
 * its last digit: they went out, so they count as submitted and its secrets as maybe sent.
 */
export const settleCarried = (session: Pick<ReplaySession, "state" | "sent">) => {
  for (const slot of submitFilled(session.state))
    if (isSecret(slot)) session.sent.maySent.add(slot);
};

/** Corrects only visibly rejected secondary fields on their existing screen. */
export const correctReplayExtras = <
  E extends YieldableError,
  V extends string,
  L extends AutofillLogin,
>(
  session: ReplaySession<E, V, L>,
  runStep: (
    asked: AutofillStep,
    inspection: AutofillInspection,
    codeAgain?: "rejected",
    explicitCodeRejection?: boolean,
    corrected?: ReadonlySet<AutofillSlot>,
  ) => ReturnType<typeof runReplayStep<E, V, L>>,
  observed: readonly RejectedMarker["slot"][],
) =>
  Effect.gen(function* () {
    const { input, progress, retryState, hooks } = session;
    // A primary/password correction rebuilds the replay; preserve the other observations first.
    if (
      observed.some(
        (slot) =>
          slot === "password" ||
          logicalRejectedField(slot, input.credentials?.primaryIdentifierKind) === "username",
      )
    )
      return undefined;
    const extras = new Set<AutofillSlot>(observed.filter((slot) => slot !== "code"));
    if (extras.size === 0) return undefined;
    const previous = [...progress.ran]
      .reverse()
      .find((step) => step.fields.some((field) => extras.has(field.slot)));
    if (previous === undefined) return "extra_rejected" as const;
    const fields = previous.fields.filter((field) => extras.has(field.slot));
    if (
      fields.length !== extras.size ||
      fields.some((field) => !retryState.rejectedValues[field.slot]?.size)
    )
      return "extra_rejected" as const;
    // A compound recovery screen may clear its one-use code when another field is rejected.
    // Its existing ledger chooses a fresh code; never refill the already-used code.
    const corrected = new Set(extras);
    const emptyRecovery = yield* emptyReplayFields(
      hooks,
      previous.fields.filter(
        (field) => field.slot === "recovery_code" && !corrected.has(field.slot),
      ),
      previous.popup,
    );
    for (const field of emptyRecovery) {
      fields.push(field);
      corrected.add(field.slot);
    }
    const retryStep: AutofillStep = {
      fields,
      ...screenSubmit(previous),
    };
    const inspected = yield* hooks.inspect(retryStep);
    if ("outcome" in inspected) return "extra_rejected" as const;
    return (yield* runStep(retryStep, inspected, undefined, false, corrected)) ?? "extra_retried";
  });
