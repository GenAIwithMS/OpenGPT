import { passwordDigest, rejection } from "./held-rejections.js";
import { logicalRejectedField, rejectableSlot } from "../runtime/autofill-rejection.js";
import { Effect } from "effect";
import type { AutofillStep, AutofillStepReport } from "../destinations/autofill-step.js";
import type { ControlIdentity } from "../destinations/autofill-page-code.js";
import type { CredentialRejectedField } from "../runtime/authentication.js";
import { type AutofillHost, autofillRecovery, emit, result } from "./autofill-results.js";
import type { MintFailure } from "./contracts.js";

// A build sign-in's rejection rules: which reported fields count as rejected, which values may go
// out again, how many corrections each field gets, and when a code is asked for again.

type Host = AutofillHost;

type RejectionHost = Pick<
  AutofillHost,
  | "autofillPrimaryIdentifierKind"
  | "autofillSentValues"
  | "autofillSecretsFilled"
  | "autofillSecretsRefilled"
  | "autofillRejectedValues"
  | "autofillCodeRejected"
  | "autofillCodeAgain"
  | "diagnostics"
  | "reportCorrelation"
>;

type CorrectionHost = Pick<
  AutofillHost,
  "autofillCorrectionRequests" | "autofillPrimaryIdentifierKind" | "autofillPendingRejectedFields"
>;

/** What the minter does after a rejection the host took, by what the host made of it. */
export const rejectionNotices = {
  nothingRejected: (slot: CredentialRejectedField) =>
    `No ${slot} was sent in this sign-in, so there is nothing for the site to have rejected. Explore read-only to see the page, then send the next signInStep.`,
  freshCorrection:
    "The host will ask for a fresh correction of that field on its next sign-in screen. Send that screen's signInStep again.",
  freshCode:
    "The host will ask the owner for a new code at the next code step. Send the code screen's signInStep again.",
  correctedLogin:
    "The owner gave a corrected login. Start the sign-in screens again from the login page: send each screen's signInStep, then signedIn.",
} as const;

/** A screen that asks for a value before the host saw the login's identifier step. */
export const identifierUnobserved = {
  step: { outcome: "refused", reason: "login_identifier_unobserved" },
  nextStep:
    "Inspect the site's sign-in entry and provide its identifier step before requesting a secret. No credential was requested or sent.",
} as const;

/**
 * The fields the site rejected: those whose recorded error marker shows on the page after a submit
 * sent them, as the host reads them (`admittedVisible`). The minter's word alone, or the same
 * screen coming back with no marker, is no verdict on the login. A code is single use, so a fresh
 * one is asked for either way.
 */
export const rejectedFieldsOf = (
  h: RejectionHost,
  admittedVisible: readonly CredentialRejectedField[],
  requestedSlot: CredentialRejectedField,
): readonly CredentialRejectedField[] | "no_rejection_marker" => {
  if (admittedVisible.length > 0) return admittedVisible;
  if (!wasSent(h, requestedSlot)) return [];
  return requestedSlot === "code" ? [requestedSlot] : "no_rejection_marker";
};

/** A reported rejection no recorded error marker shows: no mark on the login, and nobody asked. */
export const unmarkedRejection = (h: RejectionHost, slot: CredentialRejectedField) =>
  emit(h, { stage: "step", outcome: "refused", reason: "no_rejection_marker" }).pipe(
    Effect.as(
      result({
        rejected: false,
        reason: "no_rejection_marker",
        nextStep: `No recorded error marker for the ${slot} shows on the page, so the host neither marks the login nor asks its owner. If the page shows the site's error for that field, send that screen's signInStep again with the error as its rejectedMarkers, then report the rejection again. Otherwise explore read-only to see the page, ${autofillRecovery}.`,
      }),
    ),
  );

/** The corrected login's value for a rejected primary field: its username, or its password's digest. */
export const correctedPrimaryValue = (
  credentials:
    | { readonly username?: string | undefined; readonly password?: string | undefined }
    | undefined,
  slot: CredentialRejectedField,
) => {
  const password = credentials?.password;
  return slot === "password"
    ? password === undefined
      ? undefined
      : passwordDigest(password)
    : credentials?.username;
};

/** A changed password, unlike a new identifier alone, starts its own send allowance. */
export const restartPasswordSendsIfFresh = (h: RejectionHost, password: string | undefined) => {
  const sentPassword = h.autofillSentValues.current.password;
  // A new identifier alone cannot spend the same password a third time. State without its sent
  // digest cannot prove a fresh password and keeps its existing ceiling.
  if (
    password !== undefined &&
    sentPassword !== undefined &&
    passwordDigest(password) !== sentPassword
  ) {
    h.autofillSecretsFilled.current = h.autofillSecretsFilled.current.filter(
      (secret) => secret !== "password",
    );
    h.autofillSecretsRefilled.current = h.autofillSecretsRefilled.current.filter(
      (secret) => secret !== "password",
    );
  }
};

/** A field the site may reject that holds a secret, which the host may have filled. */
const secretField = (field: CredentialRejectedField) =>
  field === "password" ||
  field === "code" ||
  field === "date_of_birth" ||
  field === "zip" ||
  field === "recovery_code";

/** Whether this sign-in may have sent a value for the field, so the site can have rejected it. */
export const wasSent = (h: RejectionHost, field: CredentialRejectedField) =>
  h.autofillSentValues.current[
    logicalRejectedField(field, h.autofillPrimaryIdentifierKind.current ?? "username")
  ] !== undefined ||
  (secretField(field) && h.autofillSecretsFilled.current.includes(field));

/** Persist every visible rejected value, including simultaneous markers. */
export const rememberVisibleRejections = (
  h: RejectionHost,
  fields: readonly CredentialRejectedField[],
) => {
  for (const field of fields) {
    const key = logicalRejectedField(field, h.autofillPrimaryIdentifierKind.current ?? "username");
    const sent = h.autofillSentValues.current[key];
    if (sent !== undefined) {
      const previous = h.autofillRejectedValues.current[key] ?? [];
      // The latest three are kept.
      if (!previous.includes(sent))
        h.autofillRejectedValues.current[key] = [...previous, sent].slice(-3);
    }
    if (field === "code") {
      h.autofillCodeRejected.current = true;
      h.autofillCodeAgain.current = "rejected";
    }
    h.autofillSecretsFilled.current = h.autofillSecretsFilled.current.filter(
      (secret) => secret !== field,
    );
  }
};

/** Guard the actual private values, then capture them before the step is filled. */
export const recordAutofillValues = (
  h: AutofillHost,
  step: AutofillStep,
  values: readonly string[],
  credentials: { readonly dateOfBirth?: string | undefined },
) =>
  Effect.gen(function* () {
    // A private answer is never rejection evidence: it is asked or read for each fill alone.
    const recorded = step.fields
      .flatMap((field, index) => {
        const slot = field.slot;
        return rejectableSlot(slot) ? [{ field: slot, index }] : [];
      })
      .map(({ field, index }) => ({
        field,
        // DOB controls may type month, day and year separately; rejection belongs to the
        // canonical answer, so a new date sharing its year is not mistaken for a rejected value.
        value:
          field === "date_of_birth"
            ? (h.answeredLoginFields.current.date_of_birth ??
              credentials.dateOfBirth ??
              values[index])
            : values[index],
      }));
    for (const { field, value } of recorded) {
      if (value === undefined) continue;
      const privateValue = field === "password" ? passwordDigest(value) : value;
      const key = logicalRejectedField(
        field,
        h.autofillPrimaryIdentifierKind.current ?? "username",
      );
      if (h.autofillRejectedValues.current[key]?.includes(privateValue))
        return yield* rejection("equal_correction", field);
    }
    for (const { field, value } of recorded) {
      if (value === undefined) continue;
      const key = logicalRejectedField(
        field,
        h.autofillPrimaryIdentifierKind.current ?? "username",
      );
      h.autofillSentValues.current[key] = field === "password" ? passwordDigest(value) : value;
    }
  });

/**
 * A definitive refusal/not-attempted fill cannot introduce rejection evidence for that value, nor
 * can a phone the field changed before any submit (`changed`).
 */
export const settleAutofillValues = (
  h: Pick<AutofillHost, "autofillSentValues" | "autofillPrimaryIdentifierKind">,
  step: AutofillStep,
  previous: Readonly<Partial<Record<CredentialRejectedField, string>>>,
  report: AutofillStepReport,
) => {
  for (const [index, field] of step.fields.entries()) {
    if (!rejectableSlot(field.slot)) continue;
    if (
      report.outcome !== "refused" &&
      !(
        report.outcome === "filled" &&
        (report.fields[index]?.status === "not_attempted" ||
          report.fields[index]?.status === "changed")
      )
    )
      continue;
    const key = logicalRejectedField(
      field.slot,
      h.autofillPrimaryIdentifierKind.current ?? "username",
    );
    const before = previous[key];
    if (before === undefined) delete h.autofillSentValues.current[key];
    else h.autofillSentValues.current[key] = before;
  }
};

/**
 * Each visibly rejected primary field consumes only its own paired-question budget. Returns the
 * tries left with this one, or undefined when a field's budget is spent.
 */
export const reserveCorrection = (h: CorrectionHost, error: MintFailure) => {
  const { autofillCorrectionRequests } = h;
  const field = error.rejectedCredential ?? "password";
  const primaryKind = h.autofillPrimaryIdentifierKind.current ?? "username";
  const visible =
    h.autofillPendingRejectedFields.current.length > 0
      ? h.autofillPendingRejectedFields.current
      : [field];
  const fields = [
    ...new Set(visible.map((slot) => logicalRejectedField(slot, primaryKind))),
  ].filter((slot) => slot === "username" || slot === "password");
  if (fields.some((slot) => (autofillCorrectionRequests.current[slot] ?? 0) >= 2)) return undefined;
  const triesLeft = Math.min(
    2,
    ...fields.map((slot) => 2 - (autofillCorrectionRequests.current[slot] ?? 0)),
  );
  for (const slot of fields)
    autofillCorrectionRequests.current[slot] = (autofillCorrectionRequests.current[slot] ?? 0) + 1;
  return triesLeft;
};

const identityKeys = [
  "label",
  "ariaLabel",
  "placeholder",
  "type",
  "autocomplete",
  "name",
  "id",
] as const satisfies readonly (keyof ControlIdentity)[];

/**
 * Why a code step asks the owner for a code again, if it does: the host's recorded reason, else
 * `returned` when the code field this open sign-in last filled comes back, named the same, after
 * its code may have gone out and nothing reported it refused. Another code field, such as an
 * emailed code's after a texted one's, is a first question.
 */
export const codeAskedAgain = (
  h: Host,
  step: AutofillStep,
  opensSignIn: boolean,
  shown: readonly ControlIdentity[],
) => {
  const index = step.fields.findIndex((field) => field.slot === "code");
  if (index === -1) return undefined;
  if (h.autofillCodeAgain.current !== undefined) return h.autofillCodeAgain.current;
  if (opensSignIn || !h.autofillSecretsFilled.current.includes("code")) return undefined;
  const last = h.autofillSignIn.current?.steps
    .findLast((ran) => ran.fields.some((field) => field.slot === "code"))
    ?.fields.find((field) => field.slot === "code")?.identity;
  const now = shown[index];
  return last !== undefined &&
    now !== undefined &&
    identityKeys.every((key) => last[key] === now[key])
    ? ("returned" as const)
    : undefined;
};

/** A code rejection whose value was not kept cannot prove a fresh replacement. */
export const ambiguousRecoveredCode = (h: Host, step: AutofillStep) =>
  (h.autofillCodeRejected.current || h.autofillCodeAgain.current === "rejected") &&
  (h.autofillRejectedValues.current.code?.length ?? 0) === 0 &&
  step.fields.some((field) => field.slot === "code");
