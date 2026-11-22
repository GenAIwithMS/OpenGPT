import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { recipeStep } from "../destinations/autofill-recipe.js";
import { maySend, typingRefusal } from "../destinations/autofill-refusal.js";
import { refusalEvidence } from "../destinations/autofill-refusal-evidence.js";
import {
  codeBoxesRefusal,
  type AutofillInspection,
  type AutofillScreens,
  type AutofillSignedIn,
  type AutofillStep,
  type AutofillStepReport,
} from "../destinations/autofill-step.js";
import { type MarkerSettle, settledMarkerCheck } from "../destinations/marker-settle.js";
import {
  matchSignedOutSnapshots,
  type SignedOutSnapshot,
} from "../destinations/signed-in-marker.js";
import {
  SignInRecipe,
  signInRecipe,
  type SignInBrowser,
  type SignInLogin,
} from "../destinations/sign-in-recipe.js";
import type { CredentialRejectedField, WebsiteCredentials } from "../runtime/authentication.js";
import { logicalRejectedField, recordedRejections } from "../runtime/autofill-rejection.js";
import { approvalNumber, withApprovalNumber } from "../runtime/autofill-replay-approval.js";
import {
  armStep,
  type AutofillHooks,
  type AutofillSignInState,
  blockedScreen,
  exhaustedSecret,
  isExtraSecret,
  isIdentifier,
  isSecret,
  provesLogin,
  noteRefill,
  passwordFillsSpent,
  reasksPassword,
  recordResubmit,
  recordStep,
  registeredSecretIn,
  submitFilled,
  submittedLoginProof,
} from "../runtime/autofill-state.js";
import { makeAutofillValues, typedValues } from "../runtime/autofill-values.js";
import { failureDetail, type FailureContextValue } from "../runtime/failure-detail.js";
import type { InputAsker } from "../runtime/input-request.js";
import { Unanswered } from "../runtime/login-field-asks.js";
import {
  localSecretBroker,
  type RunSignInSecrets,
  type SignInReplayBrowser,
} from "../runtime/sign-in-replay.js";
import { type AccountRejection, markerShown, noVerdictNotices } from "./autofill-account-rejected.js";
import {
  addFilledSecrets,
  addRefilledSecrets,
  filledBefore,
  refusedRefill,
  settleMinter,
} from "./autofill-filled.js";
import {
  identityNotices,
  identityRefusal,
  maskedMethodRefusal,
  stepIdentityRefusal,
} from "./autofill-guards.js";
import {
  ambiguousRecoveredCode,
  codeAskedAgain,
  correctedPrimaryValue,
  identifierUnobserved,
  recordAutofillValues,
  rejectedFieldsOf,
  rejectionNotices,
  rememberVisibleRejections,
  reserveCorrection,
  restartPasswordSendsIfFresh,
  settleAutofillValues,
  unmarkedRejection,
  wasSent,
} from "./autofill-rejected.js";
import {
  type AutofillHost,
  changedField,
  changedPhoneNotice,
  emit,
  refusedStep,
  result,
  stepNotice,
  unansweredFailure,
} from "./autofill-results.js";
import { MintFailure, type SignInStep } from "./contracts.js";
import { rejection, rememberRejectedPassword, heldPasswordRejected } from "./held-rejections.js";
import { markerRefusalFor, refuseMarker, unsubmitted } from "./signed-in-marker.js";
import { autofillRefusalFailure } from "./sign-in-failure.js";

/** What one sign-in step gave the minter, and what it means for the build. */
export interface SignInStepResult {
  /** What the minter reads besides the screen's report. */
  readonly result: Readonly<Record<string, unknown>>;
  /** The screen's report, after the host inspected it and maybe filled it. */
  readonly report?: AutofillStepReport;
  /** The check showed the site signed in once the sign-in sent the login: it is verified. */
  readonly verified?: true;
  /** The owner completed the sign-in's approval. */
  readonly approved?: true;
}

/** A verified sign-in's value-free recipe and the address its runs start from. */
export interface PublishedSignIn {
  readonly recipe: SignInRecipe;
  readonly entryUrl: string;
}

/** What a shared rule's answer holds for the minter, as the host reads it back. */
const Shown = Schema.parseJson(
  Schema.Struct({
    output: Schema.Struct({ value: Schema.Record({ key: Schema.String, value: Schema.Unknown }) }),
  }),
);

/** A shared rule's answer as the minter reads it. */
const shown = (answer: ReturnType<typeof result>): SignInStepResult => ({
  result: Schema.decodeUnknownSync(Shown)(new TextDecoder().decode(answer.result)).output.value,
});

/**
 * What the minter does after a screen the host inspected and maybe filled, with the values the
 * fill typed (`typed`), which name a changed phone's calling code.
 */
const notice = (
  report: AutofillStepReport,
  step?: Pick<AutofillStep, "submitKey">,
  typed?: readonly string[],
) => {
  const changed = changedField(report);
  if (changed !== -1) return changedPhoneNotice(typed?.[changed]);
  return report.outcome === "refused" && report.codeBoxes !== undefined
    ? `This screen splits its code across ${report.codeBoxes.boxes} one-character boxes, and the step's code fields named only the boxes at places ${report.codeBoxes.named.join(", ")}, in that order (codeBoxes.named, counted from 1). The host typed and clicked nothing, so nothing reached the site, no code was asked for and no sign-in was spent. Send the step again with one code field per box, all ${report.codeBoxes.boxes} of them in order from the first box to the last; the host asks for the code once and types one character into each box.`
    : stepNotice(report, step);
};

/** A web address a run can open, without credentials or fragment; undefined for anything else. */
const entryOf = (url: string | undefined) => {
  const parsed = URL.parse(url ?? "");
  if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:"))
    return undefined;
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  return parsed.href;
};

/**
 * Whether a recorded selector or check holds `[private]`, the mask the local minter sees in place
 * of every value it was given (`inputs/secrets.ts`). It stands for this account's identity or a
 * secret, and would publish with the tool; the shared guards match values and other masks.
 */
const holdsMask = (text: string | undefined) => text?.toLowerCase().includes("[private]") === true;

/** The index of a screen's first recorded selector that holds the mask, or -1. */
const maskedSelector = (step: Extract<SignInStep, { readonly fields: unknown }>) =>
  [
    ...(step.rejectedMarkers ?? []).map((marker) => marker.selector),
    ...step.fields.flatMap((field) =>
      "questionSelector" in field && field.questionSelector !== undefined
        ? [field.selector, field.questionSelector]
        : [field.selector],
    ),
    ...(step.submit === undefined ? [] : [step.submit]),
    ...(step.methods ?? []).map((option) => option.selector),
    ...(step.dismiss === undefined ? [] : [step.dismiss]),
  ].findIndex(holdsMask);

/** A host call that failed, as the build's failure. */
const unavailable = (
  operation: string,
  detail: {
    readonly error?: unknown;
    readonly context?: Readonly<Record<string, FailureContextValue | undefined>>;
  },
) =>
  new MintFailure({
    code: "Unavailable",
    failureDetail: failureDetail("mint_host_dependency_failed", { operation, ...detail }),
  });

/** A value the step could not get: the site's refusal when its corrections ran out, else unanswered. */
const unansweredStep = (h: AutofillHost, unanswered: Unanswered) => {
  if (
    h.autofillCodeRejected.current &&
    (unanswered.cause === "code_corrections_exhausted" ||
      unanswered.cause === "code_already_rejected")
  )
    return Effect.fail(rejection("site_rejected", "code"));
  if (
    unanswered.cause === "field_corrections_exhausted" &&
    (unanswered.field === "date_of_birth" || unanswered.field === "zip")
  )
    return Effect.fail(rejection("site_rejected", unanswered.field));
  return Effect.fail(unansweredFailure(unanswered));
};

/**
 * Records a build's sign-in screen by screen, as the host fills it, in the local host's order over
 * the shared sign-in rules. Each screen is inspected, reviewed (`review`) and checked for this
 * account's identity before anything is typed; its values come from the login (`login`, asked
 * once when needed) and the shared value questions (`ask`), each masked (`secrets`) before any
 * screen can send it. A screen counts as sent once the host clicked its submit after the fill, or
 * the minter went on from it. A signed-in check verifies the sign-in only after its identifier and
 * a password or code were sent, or an approval or a code an exploration typed; then the sign-in's
 * value-free recipe is what the build publishes, while no later sign-in reached the site
 * (`published`). A password or code is filled twice at most in one sign-in, any other secret
 * once. A rejection counts only where its recorded error marker shows, a code's always: a code
 * gets two fresh ones, the login two corrections in place, an identifier, date of birth, ZIP or
 * recovery code a fresh answer on its next screen. A marker a signed-out page shows
 * (`signedOutPages`), or a sign-in page's path, is refused before the page is read.
 */
export const makeSignInRecorder = (input: {
  readonly browser: SignInBrowser<never> &
    Pick<SignInReplayBrowser<Error>, "markerVisible" | "approvalNumber" | "open">;
  readonly login: SignInLogin<MintFailure>;
  readonly ask: InputAsker;
  readonly secrets: RunSignInSecrets;
  readonly review: (step: AutofillStep, seen: AutofillInspection) => Effect.Effect<void, Error>;
  /** The site as a question names it: its host, without `www.`. */
  readonly site: string;
  /** The pages the build saw signed out, which a marker or a lock message must not show. */
  readonly signedOutPages: () => readonly SignedOutSnapshot[];
  /** How long a check waits for a marker drawn late; `markerSettle` unless a test shortens it. */
  readonly markerSettle?: MarkerSettle;
}) => {
  const { browser, login } = input;
  /** The build's sign-in state, as the shared rules read and keep it. */
  const h: AutofillHost = {
    reportCorrelation: undefined,
    heldLogin: {
      get current() {
        const credentials = login.held();
        return credentials === undefined ? undefined : { credentials };
      },
    },
    answeredLoginFields: { current: {} },
    autofillPrimaryIdentifierKind: { current: undefined },
    autofillSignIn: { current: undefined },
    managedAuthenticationComplete: { current: false },
    autofillSentValues: { current: {} },
    autofillSecretsFilled: { current: [] },
    autofillSecretsRefilled: { current: [] },
    autofillRejectedValues: { current: {} },
    autofillRejectedPassword: { current: undefined },
    autofillCodeRejected: { current: false },
    autofillCodeAgain: { current: undefined },
    autofillCorrectionRequests: { current: {} },
    autofillPendingRejectedFields: { current: [] },
  };
  const broker = localSecretBroker(input.secrets);
  const values = makeAutofillValues<MintFailure>({
    broker,
    unavailable,
    site: input.site,
    given: h.answeredLoginFields,
  });
  const secretIn = registeredSecretIn(broker, { component: "mint", correlation: undefined });
  /** The page calls the shared rules make, over the build's browser. */
  const hooks: AutofillHooks<Error> = {
    inspect: (step) => browser.inspect(step),
    // One-character code boxes take the code one character each, as the host types it.
    fill: (filling) =>
      browser.fill({ ...filling, values: typedValues(filling.step, filling.values) }),
    ...(browser.resubmit === undefined ? {} : { resubmit: browser.resubmit }),
    check: (indicator, screens, challengeScreens) =>
      browser.confirm(indicator, screens, challengeScreens ?? screens),
    // The check that ends a sign-in waits for a marker the page draws late.
    confirm: (indicator, _identifiers, screens, challengeScreens) =>
      settledMarkerCheck(
        (shownMarker) => browser.confirm(shownMarker, screens, challengeScreens ?? screens),
        indicator,
        input.markerSettle,
      ),
    open: (url) => browser.open(url),
    markerVisible: (selector, page, popup) => browser.markerVisible(selector, page, popup),
    ...(browser.approvalNumber === undefined ? {} : { approvalNumber: browser.approvalNumber }),
  };

  /** Sign-ins whose screens reached the site; a verified one publishes while it is the latest. */
  let signIns = 0;
  let verified:
    | { readonly recipe: SignInRecipe; readonly entry: string | undefined; readonly signIn: number }
    | undefined;
  /** The latest login URL the minter gave, which runs open rather than the first screen's address. */
  let loginUrl: string | undefined;
  /** Where the open sign-in's runs would start, and whether an exploration typed its code. */
  let entry: string | undefined;
  let codeTyped = false;
  /** Every screen the build filled, and where the current sign-in's start. */
  const screens: AutofillScreens[number][] = [];
  let signInStart = 0;
  /** The recorded markers the page showed right after the latest screen's submit, until the next. */
  /**
   * The host refused a screen for a password it already filled as often as it may
   * (`credential_already_filled`), and the password has stayed spent since: every step that leaves
   * it unspent clears this.
   */
  let passwordRefillRefused = false;
  /**
   * The host refused a screen at its destination check, typing nothing because a field, its form
   * or its submit would send the login somewhere credentials may not go, and no later screen that
   * takes a password or code passed the check and no sign-in verified since.
   */
  let destinationRefused = false;
  /**
   * A screen's inspection: one refused at the destination check sets `destinationRefused`, and one
   * that passed clears it when the screen takes a password or code. A screen with no such field,
   * such as an identifier screen, says nothing of where the password would go.
   */
  const noteInspection = (step: AutofillStep, inspected: AutofillInspection | AutofillStepReport) => {
    if (!("outcome" in inspected)) {
      if (step.fields.some((field) => provesLogin(field.slot))) destinationRefused = false;
    } else if (
      inspected.outcome === "refused" &&
      inspected.reason === "credential_target_refused" &&
      refusalEvidence(inspected)["check"] === "destination"
    )
      destinationRefused = true;
  };
  let afterSubmit:
    | { readonly open: AutofillSignInState; readonly slots: readonly CredentialRejectedField[] }
    | undefined;

  const close = () => {
    h.autofillSignIn.current = undefined;
    entry = undefined;
    codeTyped = false;
    afterSubmit = undefined;
  };

  /**
   * Opens a sign-in for its first screen. One after a verified sign-in starts with nothing filled.
   * The returned refund puts everything back when that screen reached nothing of the site.
   */
  const openSignIn = (at: string | undefined) => {
    const filledBefore = h.autofillSecretsFilled.current;
    const refilledBefore = h.autofillSecretsRefilled.current;
    const codeRejectedBefore = h.autofillCodeRejected.current;
    if (h.managedAuthenticationComplete.current) {
      h.autofillSecretsFilled.current = [];
      h.autofillSecretsRefilled.current = [];
      h.autofillCodeRejected.current = false;
    }
    h.managedAuthenticationComplete.current = false;
    const state: AutofillSignInState<Error> = {
      hooks,
      steps: [],
      filled: new Map(),
      submittedSlots: new Set(),
      sentIdentifiers: {},
    };
    h.autofillSignIn.current = state;
    entry = at;
    signIns += 1;
    const refund = () => {
      h.autofillSecretsFilled.current = filledBefore;
      h.autofillSecretsRefilled.current = refilledBefore;
      h.autofillCodeRejected.current = codeRejectedBefore;
      close();
      signIns -= 1;
    };
    return { state, refund };
  };

  /** The screen as the signed-in check reads it: each field with what named its control. */
  const screenOf = (step: AutofillStep, inspected: AutofillInspection) => ({
    ...step,
    fields: step.fields.map((item, index) => {
      const named = inspected.screen.fields[index];
      return named === undefined
        ? item
        : {
            ...item,
            identity: {
              label: named.label,
              ariaLabel: named.ariaLabel,
              placeholder: named.placeholder,
              type: named.type,
              autocomplete: named.autocomplete,
              name: named.name,
              id: named.id,
            },
          };
    }),
  });

  /** The step's values from the held login, asking the owner for what it does not hold. */
  const stepValues = (
    step: AutofillStep,
    credentials: WebsiteCredentials,
    opensSignIn: boolean,
    inspected: AutofillInspection,
  ) =>
    Effect.gen(function* () {
      if (ambiguousRecoveredCode(h, step)) return new Unanswered("code_already_rejected");
      const codeRequests = {
        get current() {
          return h.autofillCorrectionRequests.current.code ?? 0;
        },
        set current(count: number) {
          h.autofillCorrectionRequests.current.code = count;
        },
      };
      const codeAgain = codeAskedAgain(h, step, opensSignIn, inspected.screen.fields);
      const filled = yield* values.valuesFor(
        step,
        {
          credentials,
          ask: input.ask,
          rejectedValues: Object.fromEntries(
            Object.entries(h.autofillRejectedValues.current)
              .filter(([field]) => field !== "username" && field !== "password" && field !== "code")
              .map(([field, rejected]) => [field, new Set(rejected)]),
          ),
          correctionRequests: h.autofillCorrectionRequests.current,
          rejectedCodes: new Set(h.autofillRejectedValues.current.code ?? []),
          codeRequests,
          ...(codeAgain === undefined ? {} : { codeAgain }),
        },
        inspected.screen.fields,
      );
      if (codeAgain !== undefined && !(filled instanceof Unanswered))
        h.autofillCodeAgain.current = undefined;
      return filled;
    });

  /**
   * After a host click sent the open sign-in's values: a site's message can be gone before the
   * minter reports it, so the recorded markers that show right after the submit count too, until
   * the next screen.
   */
  const markersAfterSubmit = (state: AutofillSignInState) =>
    Effect.gen(function* () {
      if (
        h.autofillSignIn.current !== state ||
        !state.steps.some((recorded) => (recorded.rejectedMarkers ?? []).length > 0)
      )
        return;
      const seen = yield* recordedRejections(
        state.hooks,
        state.steps.map(recipeStep),
        h.reportCorrelation,
      );
      afterSubmit = { open: state, slots: seen === "unavailable" ? [] : seen };
    });

  /**
   * The open sign-in's `blocked` screen sent again: inspected and reviewed as any screen, then its
   * submit clicked again after its `dismiss`, typing nothing (`resubmit`). The values its fill typed
   * were never sent, so the minter going on sent nothing, and no secret is filled again: the click
   * that sends them counts them once, as the fill's own click would have. A field the page emptied
   * before the click, as when the dismiss loaded the page again, clicks nothing (`emptied`).
   */
  const resubmit = (
    request: Extract<SignInStep, { readonly fields: unknown }>,
    state: AutofillSignInState,
    step: AutofillStep,
    again: NonNullable<AutofillHooks["resubmit"]>,
    beforeFill: Effect.Effect<void, Error>,
  ) =>
    Effect.gen(function* () {
      const holding = maskedSelector(request);
      if (holding !== -1)
        return shown(
          yield* refusedStep(h, "selector_names_contact", holding, identityNotices.selectors),
        );
      const inspected = yield* browser.inspect(step);
      noteInspection(step, inspected);
      if ("outcome" in inspected)
        return { report: inspected, result: { nextStep: notice(inspected) } };
      yield* input.review(step, inspected);
      yield* beforeFill;
      afterSubmit = undefined;
      const report = yield* again({ step, inspection: inspected });
      addFilledSecrets(h, recordResubmit(state, step, report).filter(isSecret));
      if (maySend(report)) {
        state.mayHaveSent = true;
        addFilledSecrets(h, submitFilled(state).filter(isSecret));
        yield* markersAfterSubmit(state);
      }
      return { report, result: { nextStep: notice(report, step) } } satisfies SignInStepResult;
    });

  /** A click again that found a field the blocked fill typed empty, so it clicked nothing. */
  const emptied = (report: AutofillStepReport | undefined) =>
    report?.outcome === "filled" && report.submit === "not_attempted";

  const fill = (
    request: Extract<SignInStep, { readonly fields: unknown }>,
    beforeFill: Effect.Effect<void, Error>,
  ) => {
    let filled: string[] = [];
    let step: AutofillStep = { ...request, fields: [] };
    return Effect.gen(function* () {
      const before = h.autofillSignIn.current;
      const blocked = blockedScreen(before, request);
      const dispatch = yield* Effect.once(beforeFill);
      if (before !== undefined && blocked !== undefined && hooks.resubmit !== undefined) {
        const again = yield* resubmit(request, before, blocked, hooks.resubmit, dispatch);
        // A field the page emptied: the screen is filled again below, as a refill.
        if (!emptied(again.report)) return again;
      }
      // The minter went on: the screen before, which it submitted or which sent itself, is sent.
      settleMinter(h, before);
      const masked = maskedMethodRefusal(h, request);
      if (masked !== undefined) return shown(yield* masked);
      const holding = maskedSelector(request);
      if (holding !== -1)
        return shown(
          yield* refusedStep(h, "selector_names_contact", holding, identityNotices.selectors),
        );
      let held = login.held();
      step = values.resolve(request, held);
      if (step.fields.some((field) => field.slot === "password") && heldPasswordRejected(h))
        return yield* rejection("rejected_password_held");
      // A password or code this sign-in already filled is filled once more at most: a page error
      // may have kept the first from the site, but the site may have rejected it, and sending it
      // a third time risks a lockout.
      const opens = h.autofillSignIn.current === undefined;
      const again = exhaustedSecret(h, !opens, step);
      if (again !== -1) {
        if (h.autofillCodeRejected.current && step.fields.some((field) => field.slot === "code"))
          return yield* rejection("site_rejected", "code");
        if (step.fields[again]?.slot === "password") passwordRefillRefused = true;
        return shown(yield* refusedRefill(h, step, again));
      }
      const refills = filledBefore(h, step);
      const inspected = yield* browser.inspect(step);
      noteInspection(step, inspected);
      if ("outcome" in inspected)
        return { report: inspected, result: { nextStep: notice(inspected) } };
      // A code split across one-character boxes goes out whole only when the step names every
      // box, so a step that names part of them is sent back before Guardian or the owner sees it.
      const partial = codeBoxesRefusal(step, inspected);
      if (partial !== undefined) return { report: partial, result: { nextStep: notice(partial) } };
      const at = opens ? entryOf(inspected.url ?? inspected.page) : undefined;
      yield* input.review(step, inspected);
      if (
        held === undefined &&
        step.fields.length > 0 &&
        !step.fields.some((field) => field.accepts !== undefined)
      )
        return shown(result(identifierUnobserved));
      yield* dispatch;
      if (held === undefined && step.fields.length > 0) {
        held = yield* login.values;
        step = values.resolve(request, held);
      }
      const valued =
        held === undefined
          ? { values: [] as string[], step }
          : yield* stepValues(step, held, opens, inspected);
      if (valued instanceof Unanswered) return yield* unansweredStep(h, valued);
      step = valued.step;
      filled = valued.values;
      const named = yield* stepIdentityRefusal(
        h,
        h.autofillSignIn.current,
        step,
        inspected.page,
        filled,
      );
      if (named !== undefined) return shown(named);
      // The field the login's username went into is its primary identifier.
      for (const [index, field] of step.fields.entries())
        if (isIdentifier(field.slot) && held !== undefined && filled[index] === held.username)
          h.autofillPrimaryIdentifierKind.current ??= field.slot;
      const previous = { ...h.autofillSentValues.current };
      yield* recordAutofillValues(h, step, filled, held ?? {});
      const open = h.autofillSignIn.current;
      const { state, refund } =
        open === undefined ? openSignIn(at) : { state: open, refund: () => undefined };
      const reasked = reasksPassword(open, step, refills);
      yield* armStep(state, step, inspected, filled, secretIn);
      if (reasked) noteRefill(state);
      afterSubmit = undefined;
      const report = yield* hooks.fill({ step, values: filled, inspection: inspected });
      settleAutofillValues(h, step, previous, report);
      screens.push(screenOf(step, inspected));
      // A first screen that reached nothing leaves no sign-in open.
      if (!recordStep(state, step, report)) refund();
      else {
        addRefilledSecrets(h, refills);
        addFilledSecrets(h, step.fields.map((field) => field.slot).filter(isExtraSecret));
      }
      // A host click after the fill, or a lost answer, may have sent every filled value.
      if (maySend(report)) {
        state.mayHaveSent = true;
        addFilledSecrets(h, submitFilled(state).filter(isSecret));
        yield* markersAfterSubmit(state);
      }
      const refusal = typingRefusal(step, report);
      if (refusal !== undefined)
        return yield* autofillRefusalFailure(refusal, {
          nothingSubmitted: state.mayHaveSent !== true && state.submittedSlots.size === 0,
        });
      return { report, result: { nextStep: notice(report, step, filled) } };
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          // A private answer is discarded after its fill.
          step.fields.forEach((field, index) => {
            if (field.slot === "private_answer") filled[index] = "";
          });
        }),
      ),
    );
  };

  const approval = (step: Extract<SignInStep, { readonly approval: unknown }>) =>
    Effect.gen(function* () {
      const open = h.autofillSignIn.current;
      settleMinter(h, open);
      if (open === undefined || ![...open.submittedSlots].some(isIdentifier))
        return {
          result: {
            approved: false,
            failed: "identifier_not_submitted",
            nextStep:
              "Send the identifier screen first, then request protected confirmation of the site's email link or device approval.",
          },
        };
      const screen = yield* browser.inspect({
        fields: [],
        ...(step.popup === undefined ? {} : { popup: step.popup }),
      });
      if ("outcome" in screen) return { result: { approved: false, failed: screen.reason } };
      // A device approval may have the owner pick the number its screen shows (`matchSelector`).
      const number =
        step.approval === "device"
          ? yield* approvalNumber(hooks, step.matchSelector, screen.page, step.popup)
          : undefined;
      const answered = yield* Effect.either(
        input.ask({
          id: randomUUID(),
          source: "system",
          questions: [
            {
              id: "approved",
              type: "confirm",
              prompt:
                step.approval === "email_link"
                  ? "Open the sign-in link the site emailed you, then confirm here."
                  : withApprovalNumber(
                      "Approve the site's sign-in request on your device, then confirm here.",
                      number,
                    ),
            },
          ],
        }),
      );
      if (answered._tag === "Left")
        return yield* unansweredFailure(new Unanswered(answered.left));
      const answer = answered.right["approved"];
      if (answer?.type !== "confirm" || !answer.value.confirmed)
        return { result: { approved: false, failed: "approval_declined" } };
      // The screen after a blocked one: sending that one again is a fill of its own.
      open.blocked = undefined;
      open.steps.push({
        page: screen.page,
        fields: [],
        approval: step.approval,
        ...(step.approval === "device" && step.matchSelector !== undefined
          ? { matchSelector: step.matchSelector }
          : {}),
        ...(step.popup === undefined ? {} : { popup: step.popup }),
      });
      return {
        approved: true as const,
        result: {
          approved: true,
          nextStep:
            "Explore read-only to find the site's signed-in indicator, then send signedIn. The confirmation alone does not verify sign-in.",
        },
      };
    });

  /** The recorded error markers of the open sign-in that the page shows now or showed right after the latest submit. */
  const visibleRejections = (requestedSlot: CredentialRejectedField) =>
    Effect.gen(function* () {
      const open = h.autofillSignIn.current;
      if (open === undefined) return [];
      const observed = yield* recordedRejections(
        open.hooks,
        open.steps.map(recipeStep),
        h.reportCorrelation,
      );
      if (observed === "unavailable")
        return yield* unavailable("autofill.rejection_marker", {
          context: { requestedSlot, steps: open.steps.length },
        });
      const seenAfterSubmit = afterSubmit?.open === open ? afterSubmit.slots : [];
      return [...new Set([...observed, ...seenAfterSubmit])];
    });

  /**
   * The site said a field was wrong. Only a field this sign-in may have sent, whose recorded error
   * marker shows on the page, counts, and a code always does: a code gets a fresh one until three
   * were rejected; the login a correction in place, twice per field, which starts the sign-in
   * again; any other field a fresh answer on its next screen.
   */
  const rejectedStep = (requestedSlot: CredentialRejectedField) =>
    Effect.gen(function* () {
      const primaryKind = h.autofillPrimaryIdentifierKind.current ?? "username";
      const logical = (field: CredentialRejectedField) => logicalRejectedField(field, primaryKind);
      const visible = yield* visibleRejections(requestedSlot);
      const admitted = visible.filter((field) => wasSent(h, field));
      const rejectedFields = rejectedFieldsOf(h, admitted, requestedSlot);
      if (rejectedFields === "no_rejection_marker")
        return shown(yield* unmarkedRejection(h, requestedSlot));
      const slot = rejectedFields[0] ?? visible[0] ?? requestedSlot;
      if (rejectedFields.length === 0)
        return shown(
          yield* refusedStep(h, "nothing_rejected", 0, rejectionNotices.nothingRejected(slot)),
        );
      yield* emit(h, { stage: "rejected", slot });
      h.autofillPendingRejectedFields.current = [...rejectedFields];
      rememberVisibleRejections(h, rejectedFields);
      if (slot === "code") {
        if ((h.autofillRejectedValues.current.code?.length ?? 0) >= 3)
          return yield* rejection("site_rejected", "code");
        h.autofillCodeRejected.current = true;
        h.autofillSecretsFilled.current = h.autofillSecretsFilled.current.filter(
          (secret) => secret !== "code",
        );
        h.autofillCodeAgain.current = "rejected";
        return { result: { rejected: "code", nextStep: rejectionNotices.freshCode } };
      }
      if (logical(slot) !== "username" && slot !== "password") {
        h.autofillPendingRejectedFields.current = [];
        return { result: { rejected: slot, nextStep: rejectionNotices.freshCorrection } };
      }
      if (rejectedFields.includes("password"))
        rememberRejectedPassword(h, h.autofillSentValues.current.password);
      const failed = rejection("site_rejected", slot);
      const held = login.held();
      const triesLeft = held === undefined ? undefined : reserveCorrection(h, failed);
      if (held === undefined || triesLeft === undefined) return yield* failed;
      h.autofillPendingRejectedFields.current = [];
      const corrected = yield* login.correct(slot, held, triesLeft);
      // A correction equal to a rejected value is the second rejection: it is never sent.
      const value = correctedPrimaryValue(corrected, slot);
      if (
        value !== undefined &&
        (h.autofillRejectedValues.current[logical(slot)]?.includes(value) === true ||
          (slot === "password" && value === h.autofillRejectedPassword.current))
      )
        return yield* rejection("equal_correction", slot);
      restartPasswordSendsIfFresh(h, corrected.password);
      // The rejected sign-in is over: the next screen starts a new one.
      close();
      return { result: { corrected: true, nextStep: rejectionNotices.correctedLogin } };
    });

  /** A report the host takes no verdict on the account from: the sign-in stays as it was. */
  const noVerdict = (reason: Exclude<keyof typeof noVerdictNotices, "marker_unchecked">) =>
    emit(h, { stage: "step", outcome: "refused", reason }).pipe(
      Effect.as({ result: { rejected: false, reason, nextStep: noVerdictNotices[reason] } }),
    );

  /**
   * The site showed the account itself locked or suspended, at `selector`. Only a sign-in that
   * submitted the login can be refused for its account, and only a message that shows now on the
   * page the sign-in led to, and on no page the build saw signed out, counts; then no correction
   * gets past it, and sign-in ends in the build.
   */
  const accountRejectedStep = (rejected: AccountRejection) =>
    Effect.gen(function* () {
      const open = h.autofillSignIn.current;
      settleMinter(h, open);
      if (open === undefined || !submittedLoginProof(open))
        return yield* noVerdict("nothing_rejected");
      if (
        matchSignedOutSnapshots({ selector: rejected.selector }, input.signedOutPages()) ===
        "matches"
      )
        return yield* noVerdict("marker_matches_signed_out_page");
      const markerOn = yield* markerShown(h, open, rejected.selector);
      if (markerOn === "unavailable")
        return yield* unavailable("autofill.account_marker", {
          context: { steps: open.steps.length },
        });
      if (!markerOn) return yield* noVerdict("no_rejection_marker");
      yield* emit(h, { stage: "rejected", account: rejected.account });
      close();
      return yield* new MintFailure({
        code: "Unavailable",
        authentication: {
          phase: "credential_submit",
          code: "AccountLocked",
          account: rejected.account,
          afterSubmission: true,
        },
      });
    });

  /** The paths of the sign-in's pages, where a signed-out browser lands too. */
  const signInPaths = (open: AutofillSignInState) => [
    ...new Set(
      [
        loginUrl,
        ...open.steps.map((screen) => screen.page),
        ...(verified?.recipe.steps.map((screen) => screen.page) ?? []),
      ].flatMap((url) => (url === undefined ? [] : (URL.parse(url)?.pathname ?? []))),
    ),
  ];

  const signedIn = (indicator: AutofillSignedIn) =>
    Effect.gen(function* () {
      const open = h.autofillSignIn.current;
      settleMinter(h, open);
      // Only a sign-in that submitted the login's identifier and its password or code, an
      // approval, or a code an exploration typed, may verify it.
      if (
        open === undefined ||
        !(
          submittedLoginProof(open) ||
          (codeTyped && [...open.submittedSlots].some(isIdentifier))
        )
      )
        return shown(yield* unsubmitted(h, open));
      if ([indicator.selector, indicator.urlPath, indicator.openPath].some(holdsMask))
        return shown(
          result({
            signedIn: false,
            failed: "indicator_holds_identity",
            nextStep: identityNotices.indicator,
          }),
        );
      const named = identityRefusal(h, open, indicator);
      if (named !== undefined) return shown(named);
      const { refusal } = markerRefusalFor(indicator, input.signedOutPages(), signInPaths(open));
      if (refusal !== undefined) return shown(yield* refuseMarker(h, refusal));
      const checked = yield* hooks.confirm(
        indicator,
        open.sentIdentifiers,
        screens,
        screens.slice(signInStart),
      );
      if (!checked.signedIn) return { result: checked };
      signInStart = screens.length;
      verified = {
        recipe: signInRecipe(open.steps, indicator),
        entry: loginUrl ?? entry,
        signIn: signIns,
      };
      close();
      h.managedAuthenticationComplete.current = true;
      h.autofillSecretsFilled.current = [];
      h.autofillSecretsRefilled.current = [];
      h.autofillCodeRejected.current = false;
      destinationRefused = false;
      return { result: checked, verified: true as const };
    });

  return {
    /**
     * Runs one sign-in step: a screen, an approval, a rejected field or account, or a signed-in
     * check. `loginUrl` is the minter's login route, which runs open; `beforeFill` runs once the
     * screen passed its review, before the host asks for or types anything.
     */
    step: (
      step: SignInStep,
      given: string | undefined,
      beforeFill: Effect.Effect<void, Error>,
    ): Effect.Effect<SignInStepResult, MintFailure | Error> =>
      Effect.suspend((): Effect.Effect<SignInStepResult, MintFailure | Error> => {
        loginUrl = entryOf(given) ?? loginUrl;
        if ("fields" in step) return fill(step, beforeFill);
        if ("approval" in step) return approval(step);
        if ("rejected" in step)
          return "slot" in step.rejected
            ? rejectedStep(step.rejected.slot)
            : accountRejectedStep(step.rejected);
        return signedIn(step.signedIn);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (!passwordFillsSpent(h)) passwordRefillRefused = false;
          }),
        ),
      ),
    /**
     * An exploration typed a code the site sent for the sign-in under way, on the site or a
     * configured sign-in origin: it proves the open sign-in as a code the host fills does.
     */
    codeTyped: () => {
      if (h.autofillSignIn.current !== undefined) codeTyped = true;
    },
    /** The screens a signed-in check reads now: every screen, and the current sign-in's. */
    screens: () => ({ screens: [...screens], challengeScreens: screens.slice(signInStart) }),
    /**
     * Whether the host refused a screen of the sign-in under way because it already filled the
     * password as often as it may, and the password is still spent.
     */
    passwordRefillRefused: () => passwordRefillRefused && passwordFillsSpent(h),
    /**
     * Whether the host refused a screen at its destination check, and no later screen that takes a
     * password or code passed the check and no sign-in verified since.
     */
    destinationRefused: () => destinationRefused,
    /** The latest verified sign-in, while no later sign-in reached the site; else none. */
    published: (): PublishedSignIn | undefined => {
      if (verified === undefined || verified.signIn !== signIns) return undefined;
      const { recipe, entry: entryUrl } = verified;
      return entryUrl === undefined || !Schema.is(SignInRecipe)(recipe)
        ? undefined
        : { recipe, entryUrl };
    },
  };
};
