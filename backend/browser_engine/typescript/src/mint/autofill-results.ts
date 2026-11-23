import { lostTyping } from "../destinations/autofill-refusal.js";
import type {
  AutofillStep,
  AutofillStepReport,
  IdentifierKind,
} from "../destinations/autofill-step.js";
import { Effect } from "effect";
import type { CredentialRejectedField, WebsiteCredentials } from "../runtime/authentication.js";
import type { AutofillSecret, AutofillSignInState } from "../runtime/autofill-state.js";
import type { CodeAgain } from "../runtime/autofill-values.js";
import type { EventSink } from "../runtime/context.js";
import { failureDetail } from "../runtime/failure-detail.js";
import { InputRequestFailure } from "../runtime/input-request.js";
import type { Unanswered } from "../runtime/login-field-asks.js";
import type { AnsweredLoginFields } from "../runtime/login-values.js";
import { report } from "../runtime/sign-in-telemetry.js";
import { MintFailure } from "./contracts.js";

/**
 * What a build's sign-in rules read and keep of the sign-in under way: refs the host holds for the
 * whole build and updates in place, and the host's event sink, if it keeps one. A host passes its
 * own state; nothing here is a copy.
 */
export interface AutofillHost {
  /** Where the sign-in's value-free events go; absent, they go nowhere. */
  readonly diagnostics?: EventSink | undefined;
  /** The host's own correlation for its reports, passed through unread. */
  readonly reportCorrelation: unknown;
  /** The login the build holds, once one is. */
  readonly heldLogin: {
    readonly current: { readonly credentials?: WebsiteCredentials | undefined } | undefined;
  };
  /** The identifiers, date of birth and ZIP the owner gave in this build. */
  readonly answeredLoginFields: { readonly current: AnsweredLoginFields };
  /** The kind of identifier field the login's username went into. */
  readonly autofillPrimaryIdentifierKind: { current: IdentifierKind | undefined };
  /** The open sign-in, if one is open. */
  readonly autofillSignIn: { current: AutofillSignInState | undefined };
  /** Whether the latest sign-in verified. */
  readonly managedAuthenticationComplete: { current: boolean };
  /** Each field's last value a fill may have sent, a password as its digest. */
  readonly autofillSentValues: { readonly current: Partial<Record<CredentialRejectedField, string>> };
  /** The secrets the open sign-in may have sent, and those it filled once more. */
  readonly autofillSecretsFilled: { current: readonly AutofillSecret[] };
  readonly autofillSecretsRefilled: { current: readonly AutofillSecret[] };
  /** The values the site rejected in this build, by field, a password as its digest. */
  readonly autofillRejectedValues: {
    readonly current: Partial<Record<CredentialRejectedField, string[]>>;
  };
  /** The digest of the password the site rejected last. */
  readonly autofillRejectedPassword: { current: string | undefined };
  /** Whether the site rejected a code of the open sign-in. */
  readonly autofillCodeRejected: { current: boolean };
  /** Why the next code step asks the owner for a code again, if it does. */
  readonly autofillCodeAgain: { current: CodeAgain | undefined };
  /** How many corrections of each field the owner was asked for. */
  readonly autofillCorrectionRequests: {
    readonly current: Partial<Record<CredentialRejectedField, number>>;
  };
  /** The fields the latest rejection found rejected, until its correction is asked. */
  readonly autofillPendingRejectedFields: { current: readonly CredentialRejectedField[] };
}

export const autofillRecovery =
  "then inspect read-only and correct the sign-in steps from the page's evidence";

/**
 * The result an autofill call returns. A step whose
 * submit ran, or whose answer was lost, may have sent the login to the site.
 */
export const result = (value: unknown, maySend = false) => ({
  result: new TextEncoder().encode(
    JSON.stringify({
      status: "succeeded",
      websiteEffect: maySend ? "may_have_dispatched" : "not_started",
      output: { value, schemas: { input: {}, output: {} } },
    }),
  ),
  stdout: new Uint8Array(),
  stderr: new Uint8Array(),
  events: new TextEncoder().encode("[]"),
  exitCode: 0,
});

type DiagnosticHost = Pick<AutofillHost, "diagnostics" | "reportCorrelation">;

export const emit = (h: DiagnosticHost, details: Readonly<Record<string, unknown>>) =>
  report.bestEffort(h.diagnostics?.emit("authentication.autofill_step", details) ?? Effect.void, {
    component: "mint",
    operation: "diagnostics.emit",
    phase: "authentication.autofill_step",
    correlation: h.reportCorrelation,
  });

/** A step the host refused before touching the page: it typed and asked nothing. */
export const refusedStep = (
  h: DiagnosticHost,
  reason:
    | "credential_already_filled"
    | "identifier_conflict"
    | "nothing_rejected"
    | "selector_names_contact"
    | "page_names_contact"
    | "code_unavailable"
    | "credential_unavailable"
    | "login_lacks_identifier",
  target: number,
  nextStep: string,
) =>
  emit(h, { stage: "step", outcome: "refused", reason }).pipe(
    Effect.as(result({ step: { outcome: "refused", reason, target }, nextStep })),
  );

/** A value the step could not get: the owner did not answer, or the host could not ask. */
export const unansweredFailure = ({ cause: unanswered }: Unanswered) =>
  new MintFailure({
    code: "Unavailable",
    ...(unanswered instanceof InputRequestFailure && unanswered.code === "NoResponse"
      ? { noResponse: { possibleCommit: false } }
      : {}),
    failureDetail: failureDetail("mint_host_dependency_failed", {
      operation: "autofill.ask",
      phase: "sign_in_input",
      error: unanswered,
    }),
  });

const filledNotices = {
  blocked:
    "The host filled the fields, but another element sat over the submit and caught its click (blockedBy), such as a cookie or tracking consent banner, so nothing was sent and no fill was spent. Never click the submit yourself. Find that banner's own control with a read-only explore (never read a field the host filled): its close or dismiss control, else one that rejects or declines what is not essential, else accept when that is the only way out. Then send this same signInStep again with that control's selector as dismiss: the host clicks it, then clicks the submit once more, typing nothing unless the dismiss emptied a field. When that element has no such control, such as a fixed header or footer, send this same signInStep again without dismiss, and without resizing or scrolling the page: the host then presses the submit from the keyboard.",
  failed:
    "The host filled the fields, but its click of the submit failed. You may click that one submit yourself in an explore, and nothing else: never read, change or return a field the host filled. Then continue with the next signInStep, or signedIn.",
  none: "The host filled the fields; the screen has no button. Explore read-only to see what it revealed, then send the next signInStep for it.",
  clicked:
    "The host filled the fields and clicked the submit. Explore read-only to read the next screen (never read a field the host filled), then send its signInStep, or signInStep.signedIn with what shows the site signed in.",
  not_attempted:
    "A field could not be filled, so the host did not submit. Explore read-only to see why, then correct the step.",
  refused:
    "The host filled the fields, but afterwards a field or the submit no longer sat or submitted where the host judged it (page code moved the form or changed how it submits), so the host did not click, or stopped the submission as it fired. Never click it yourself: inspect the changed form and correct the sign-in step.",
  stayed_disabled:
    "The host filled the fields, but the page kept the submit disabled through the host's wait for it to be enabled, so the host never clicked it. Never click it yourself: explore read-only to see what the page still needs before it enables the submit, such as another field, a checkbox or a choice (never read a field the host filled), then correct the sign-in step.",
  page: "The host filled the fields, and the page may have sent them itself: once the last field was filled, the screen moved on, emptied its fields or stopped taking typing before the host clicked anything. Explore read-only to read the next screen (never read a field the host filled), then send its signInStep, or signInStep.signedIn with what shows the site signed in.",
} as const;

/** The country calling codes one or two digits long; every other code is three. */
const shortCallingCodes = new Set([
  ...["1", "7", "20", "27", "30", "31", "32", "33", "34", "36", "39"],
  ...["40", "41", "43", "44", "45", "46", "47", "48", "49"],
  ...["51", "52", "53", "54", "55", "56", "57", "58"],
  ...["60", "61", "62", "63", "64", "65", "66", "81", "82", "84", "86"],
  ...["90", "91", "92", "93", "94", "95", "98"],
]);

/**
 * A phone number's country calling code, digits only, when the number is written in international
 * form, after `+` or `00`; undefined for a number written another way, which does not say it.
 */
export const callingCode = (number: string) => {
  const written = number.trim();
  const lead = /^(?:\+|00)/u.exec(written)?.[0];
  if (lead === undefined) return undefined;
  const digits = written.slice(lead.length).replaceAll(/[^0-9]/gu, "");
  if (digits.length < 4 || digits.startsWith("0")) return undefined;
  const short = [digits.slice(0, 1), digits.slice(0, 2)].find((code) => shortCallingCodes.has(code));
  return short ?? digits.slice(0, 3);
};

/**
 * A step the host stopped before its submit because a phone field kept other digits than the
 * number it typed (field status `changed`), with the number's calling code when it is written in
 * international form (`callingCode`), else the site's own country, as a number written without its
 * calling code most likely belongs to it. Nothing was submitted and nobody was asked.
 */
export const changedPhoneNotice = (number: string | undefined) => {
  const code = number === undefined ? undefined : callingCode(number);
  const lead =
    "The phone field kept different digits than the number the host typed, as when the site's country picker is set to another country. Nothing was submitted and nobody was asked.";
  return code === undefined
    ? `${lead} If the screen has a country picker, prefer setting it to the site's own country with an explore step, then send this signInStep again.`
    : `${lead} The number's country calling code is +${code}. If the screen has a country picker, prefer setting it to that country with an explore step, then send this signInStep again.`;
};

/** The first field of a fill that a phone the page changed stopped (`changed`), else -1. */
export const changedField = (stepReport: AutofillStepReport) =>
  stepReport.outcome === "filled"
    ? stepReport.fields.findIndex((field) => field.status === "changed")
    : -1;

/** A fill whose answer was lost, other than a field's typing call's: the submit's call included. */
export const lostFillNotice = `The host lost the fill call's answer: the fields and the submit may have reached the site. It never retries a fill by itself. Explore read-only to see the page, then continue with the next signInStep, ${autofillRecovery}.`;

/**
 * A fill whose lost answer was a field's typing call's (`lostTyping`): the host clicks the submit
 * only after every field.
 */
export const lostTypingNotice =
  "The host lost the answer of the call that typed a field, so that field may hold its value. The host never clicked the submit. It never retries a fill by itself. Explore read-only to see the page, then continue with the next signInStep.";

/** A step whose `dismiss` the host refused before it typed or clicked anything. */
export const dismissRefusedNotice =
  "The step's dismiss is not a covering notice's own control: it is or holds a control of the sign-in, opens another page, matches more than one visible element, or sits in the sign-in's form or submits a form outside a notice that covers the step's controls. The host typed and clicked nothing. Send the step again with the notice's own close or dismiss control as dismiss, else one that rejects or declines what is not essential, else its accept control, or without dismiss.";

/** After a step whose covered submit the host pressed from the keyboard (`via: "keyboard"`). */
export const keyboardSubmitNotice =
  "Something sat over the submit and caught the host's click, so the host pressed the same submit from the keyboard instead, and nothing on the covering element was clicked. Explore read-only to read the next screen (never read a field the host filled), then send its signInStep, or signedIn.";

/** After a step whose submit key the host pressed. */
const keyNotices = {
  failed:
    "The host filled the fields, but its press of the step's submitKey failed. Never press it yourself: explore read-only to see the page (never read a field the host filled), then continue with the next signInStep, or signedIn.",
  clicked:
    "The host filled the fields and pressed the step's submitKey in the last field. Explore read-only to read the next screen (never read a field the host filled), then send its signInStep, or signInStep.signedIn with what shows the site signed in.",
} as const;

export const stepNotice = (
  stepReport: AutofillStepReport,
  step?: Pick<AutofillStep, "submitKey">,
) => {
  if (stepReport.outcome === "refused" && stepReport.reason === "dismiss_refused")
    return dismissRefusedNotice;
  if (stepReport.outcome === "refused")
    return `The host typed and clicked nothing (${stepReport.reason}), so nothing reached the site and no sign-in was spent. Correct the step from the page's evidence, ${autofillRecovery}.`;
  if (lostTyping(stepReport)) return lostTypingNotice;
  if (stepReport.outcome === "uncertain") return lostFillNotice;
  if (
    step?.submitKey !== undefined &&
    (stepReport.submit === "failed" || stepReport.submit === "clicked")
  )
    return keyNotices[stepReport.submit];
  if (stepReport.via === "keyboard") return keyboardSubmitNotice;
  return filledNotices[stepReport.submit];
};
