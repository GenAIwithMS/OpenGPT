import { Effect } from "effect";
import type {
  AutofillInspection,
  AutofillField,
  AutofillRefusal,
  AutofillScreens,
  AutofillSignedIn,
  AutofillSignedInCheck,
  AutofillSlot,
  AutofillStep,
  AutofillStepReport,
  ExtraSecretSlot,
  IdentifierKind,
  SecretSlot,
} from "../destinations/autofill-step.js";
import { type AutofillRecipeStep, isSecondFactor } from "../destinations/autofill-recipe.js";
import type { ControlIdentity } from "../destinations/autofill-page-code.js";
import { report, type SignInReportContext } from "./sign-in-telemetry.js";

/**
 * Where a signed-in check of a tool with a workspace relation runs: the origin its account page
 * opens on, and, for `confirm`, the workspace origin its identity verification pins to the login.
 */
export interface SignInCheckAt {
  readonly origin: string;
  readonly workspace?: string;
}

/** The identifiers besides the username a sign-in submitted, which a host may bind to the login. */
export interface SentIdentifiers {
  readonly email?: string;
  readonly phone?: string;
}

/**
 * The page the browser is on, read without moving it: whether its document has parsed, a shape of
 * its DOM that changes as the page renders (its address, element count and text length), and the
 * HTTP status its navigation got, when the browser reports one.
 */
export interface PageState {
  readonly parsed: boolean;
  readonly shape: string;
  readonly status?: number;
}

/**
 * The host's sign-in calls on the browser a sign-in runs on: `inspect` finds a step's controls and
 * judges where they submit, `fill` types the host's values into them and clicks the submit, `check`
 * reads the signed-in marker alone, and `confirm` checks it and verifies the login as the host
 * does. `E` is the host's failure; `V` names a challenge vendor.
 */
export interface AutofillHooks<E = unknown, V extends string = string> {
  readonly inspect: (step: AutofillStep) => Effect.Effect<AutofillRefusal | AutofillInspection, E>;
  readonly fill: (input: {
    readonly step: AutofillStep;
    readonly values: readonly string[];
    readonly inspection: AutofillInspection;
  }) => Effect.Effect<AutofillStepReport>;
  /**
   * Clicks again the submit of the open sign-in's `blocked` screen, typing nothing, after its
   * `dismiss` when the step names one (`resubmitAutofillStep`). A host without it fills that
   * screen again as any other.
   */
  readonly resubmit?: (input: {
    readonly step: AutofillStep;
    readonly inspection: AutofillInspection;
  }) => Effect.Effect<AutofillStepReport>;
  /** The marker check alone, which verifies nothing: a replay polls it. */
  readonly check: (
    indicator: AutofillSignedIn,
    screens: AutofillScreens,
    challengeScreens?: AutofillScreens,
    at?: SignInCheckAt,
  ) => Effect.Effect<AutofillSignedInCheck>;
  /**
   * The marker check that ends a sign-in: a password field of the sign-in's own `screens` left on
   * the page fails it, as does a recorded code, recovery-code or security-answer control of
   * `challengeScreens` (`screens` when absent) that still shows. A host may verify the identifiers
   * the sign-in sent when the marker holds.
   */
  readonly confirm: (
    indicator: AutofillSignedIn,
    identifiers: SentIdentifiers,
    screens: AutofillScreens,
    challengeScreens?: AutofillScreens,
    at?: SignInCheckAt,
  ) => Effect.Effect<AutofillSignedInCheck, E>;
  /** Opens a page on the sign-in's tab, as a replay starts from the login URL. */
  readonly open: (url: string) => Effect.Effect<void, E>;
  /** Reads a recorded error marker without reading a field's value or verifying a login. */
  readonly markerVisible?: (
    selector: string,
    screenPage: string,
    popup?: AutofillStep["popup"],
  ) => Effect.Effect<boolean, E>;
  /**
   * The number a device approval's screen shows for the owner to pick on their device: the trimmed
   * text of the first visible element `selector` names on the screen's page, or undefined. The
   * shared code keeps it only when it is 1 to 3 digits (`approvalNumberOf`). A host without it
   * asks for the approval with no number.
   */
  readonly approvalNumber?: (
    selector: string,
    screenPage: string,
    popup?: AutofillStep["popup"],
  ) => Effect.Effect<string | undefined, E>;
  /**
   * Lets a replay that sent the login cleanly and ended on a page that can't tell, such as an
   * account picker the site shows before the marker, go on signed in. A host may check the
   * identifiers the sign-in used, binding nothing. Absent, such a replay fails its sign-in check.
   */
  readonly confirmCantTell?: (identifiers: SentIdentifiers) => Effect.Effect<void, E>;
  /** Hears each same-site load that failed, as it fails; returns the removal. */
  readonly onLoadFailure?: (listener: (failure: unknown) => void) => () => void;
  /**
   * A recorded screen that never showed: the host's look for a challenge on the page and its work
   * on one it confirms there; undefined when none shows.
   */
  readonly challenge?: Effect.Effect<
    { readonly outcome: "cleared" | "failed"; readonly vendor: V } | undefined
  >;
  /**
   * Whether this browser started on a new, empty profile, never a saved one that may already be
   * signed in: only then is a page it shows before any sign-in a signed-out page.
   */
  readonly startedEmpty?: boolean;
  /**
   * The primary tab as it is, read without moving it: whether its document parsed, a shape of
   * its DOM and its navigation's HTTP status, for a check's settling.
   */
  readonly pageState?: () => Effect.Effect<PageState | undefined>;
}

/** The host's masking of the values a sign-in types, and its check of a text for them. */
export interface SecretBroker {
  readonly register: (value: {
    readonly kind: "secret";
    readonly entity: RegisteredEntity;
    readonly value: string;
  }) => Effect.Effect<void, unknown>;
  readonly registeredSecretMatches: (text: string) => Effect.Effect<readonly unknown[], unknown>;
}

/** The entity a value the host asked or computed is registered under, for its placeholder. */
export type RegisteredEntity =
  | "EMAIL"
  | "PHONE"
  | "ACCOUNT_NUMBER"
  | "DATE_OF_BIRTH"
  | "ZIP"
  | "RECOVERY_CODE"
  | "ONE_TIME_CODE"
  | "SECURITY_ANSWER";

/**
 * A host's record of the security answers it typed from the login's saved answers, which it keeps
 * to flag one the site refused. The shared sign-in code tells it when a screen's values start
 * resolving (`begin`), when that screen's fill starts (`arm`) and returns (`settle`, which fields
 * it reached), and when its values were submitted (`submitted`). A host without saved answers
 * keeps none.
 */
export interface SecurityAnswerFills {
  readonly begin: () => void;
  readonly arm: (step: AutofillStep, values: readonly string[]) => void;
  readonly settle: (step: AutofillStep, filled: readonly boolean[]) => void;
  readonly submitted: () => void;
}

/**
 * One screen of an autofill sign-in as the host ran it, value-free: what a run replays.
 * `submittedBy` is `minter` when the host's click failed and the minter clicked it itself.
 */
interface AutofillRecordedStep {
  readonly popup?: AutofillRecipeStep["popup"];
  readonly approval?: AutofillRecipeStep["approval"];
  /** A device approval's element that shows the number the owner picks on their device. */
  readonly matchSelector?: string;
  readonly rejectedMarkers?: AutofillRecipeStep["rejectedMarkers"];
  /**
   * With each identifier field's accepted, held and sent kinds, never a value, and what named each
   * control when the host inspected it (`identity`), for the signed-in check alone.
   */
  readonly fields: readonly (AutofillField & { readonly identity?: ControlIdentity })[];
  readonly submit?: string;
  /** The key the host pressed in the last field to submit its form, on a form with no submit. */
  readonly submitKey?: AutofillRecipeStep["submitKey"];
  readonly submittedBy?: "host" | "minter";
  /** `keyboard` once the host pressed the screen's covered submit from the keyboard. */
  readonly submitVia?: AutofillRecipeStep["submitVia"];
  /** A two-factor method choice's recorded methods. */
  readonly methods?: AutofillRecipeStep["methods"];
  /** The password an earlier screen took that this one asked for again beside a second factor. */
  readonly refills?: AutofillRecipeStep["refills"];
  /** The covering notice's own control the host clicks on this screen (`AutofillStep.dismiss`). */
  readonly dismiss?: string;
  /** The page the step ran on, origin and path only. */
  readonly page: string;
}

/**
 * A screen's popup, how it submits, from the keyboard included, and the covering notice's control
 * it dismisses, which a step rebuilt for that screen keeps.
 */
export const screenSubmit = (
  screen: Pick<AutofillStep, "popup" | "submit" | "submitKey" | "submitVia" | "dismiss">,
) => ({
  ...(screen.popup === undefined ? {} : { popup: screen.popup }),
  ...(screen.submit === undefined ? {} : { submit: screen.submit }),
  ...(screen.submitKey === undefined ? {} : { submitKey: screen.submitKey }),
  ...(screen.submitVia === undefined ? {} : { submitVia: screen.submitVia }),
  ...(screen.dismiss === undefined ? {} : { dismiss: screen.dismiss }),
});

/** A recorded screen as the minter reads it back: without what only the signed-in check uses. */
export const withoutIdentity = (step: AutofillRecordedStep): AutofillRecordedStep => ({
  ...step,
  fields: step.fields.map(({ identity: _identity, ...field }) => field),
});

/**
 * The attempt's open autofill sign-in: the browser hooks it runs on and its steps so far.
 * Read-only looks run between its steps, and its later steps and its `signedIn` spend no further
 * sign-in.
 */
export interface AutofillSignInState<E = unknown, V extends string = string> {
  readonly hooks: AutofillHooks<E, V>;
  /**
   * Each screen as the host ran it, value-free: what a run replays. `submittedBy` is `minter` when
   * the host's click failed and the minter clicked it itself.
   */
  readonly steps: AutofillRecordedStep[];
  /**
   * Values a screen filled that no submit has sent yet, by slot, held in memory only and never
   * logged, until a submit is clicked or the minter goes on (`settleMinterSubmit`).
   */
  readonly filled: Map<AutofillSlot, string>;
  /**
   * Slots filled on a screen whose submit was clicked after the fill, by the host or, after the
   * host's click failed, by the minter once it went on, or whose fill's answer was lost.
   * `signedIn` needs an identifier and a password or code among them.
   */
  readonly submittedSlots: Set<AutofillSlot>;
  /** The identifiers besides the username submitted, which a host may bind to the login. */
  readonly sentIdentifiers: { email?: string; phone?: string; accountNumber?: string };
  /** Set once a screen's host click ran or its fill's answer was lost: it may have sent a value. */
  mayHaveSent?: true;
  /**
   * The screen just filled whose host click another element caught (`blocked`): nothing of it was
   * sent, and its fields still hold what was typed, so the same screen sent again is clicked again
   * without typing (`blockedScreen`). Cleared by the next screen's fill.
   */
  blocked?: AutofillStep | undefined;
  /**
   * The host's record of saved security answers a fill typed, which counts one as sent once its
   * screen's submit was clicked (`submitFilled`).
   */
  readonly securityAnswers?: SecurityAnswerFills;
}

export const isIdentifier = (slot: AutofillSlot): slot is IdentifierKind =>
  slot === "username" || slot === "email" || slot === "phone" || slot === "account_number";
/**
 * A security answer (`private_answer`): read or asked for each screen that asks one, and never
 * held as filled, so no sign-in counts it toward `signedIn`; only a saved one is tracked as sent,
 * by the host's record of security answers.
 */
const isPrivateAnswer = (slot: AutofillSlot): slot is "private_answer" => slot === "private_answer";
/** The secrets a sign-in fills at most twice (a password or code) or once (any other). */
export type AutofillSecret = Exclude<SecretSlot, "private_answer">;
/** Whether a field's slot is a tracked secret's: the password, a code or an extra secret. */
export const isSecret = (slot: AutofillSlot): slot is AutofillSecret =>
  !isIdentifier(slot) && !isPrivateAnswer(slot);
/** The secrets that prove the login: a sign-in verifies only once a submit sent one. */
export const provesLogin = (slot: AutofillSlot) => slot === "password" || slot === "code";

/** What a host keeps of the secrets its open sign-in filled, and whether its last one verified. */
interface FilledSecrets {
  readonly managedAuthenticationComplete: { readonly current: boolean };
  readonly autofillSecretsFilled: { readonly current: readonly AutofillSecret[] };
  readonly autofillSecretsRefilled: { readonly current: readonly AutofillSecret[] };
}

/**
 * The field of `step` that names a secret this sign-in may not fill again, or -1. A fill is not a
 * write, so a password or code filled once may be filled once more; any other secret never is. A
 * sign-in after one that completed starts with nothing filled (`open` false).
 */
export const exhaustedSecret = (h: FilledSecrets, open: boolean, step: AutofillStep) => {
  if (!open && h.managedAuthenticationComplete.current) return -1;
  return step.fields.findIndex(
    (field) =>
      isSecret(field.slot) &&
      h.autofillSecretsFilled.current.includes(field.slot) &&
      (!provesLogin(field.slot) || h.autofillSecretsRefilled.current.includes(field.slot)),
  );
};
/**
 * Whether the sign-in under way filled the login's password as often as it may, and none verified
 * since: every further screen that needs the password is refused (`exhaustedSecret`) until a
 * sign-in verifies, or a corrected login starts its fills again.
 */
export const passwordFillsSpent = (h: FilledSecrets) =>
  !h.managedAuthenticationComplete.current &&
  h.autofillSecretsFilled.current.includes("password") &&
  h.autofillSecretsRefilled.current.includes("password");
/**
 * Whether a sign-in submitted the login's identifier and its password or code (`submittedSlots`:
 * a submit clicked after the fill, `submitFilled`), or passed a step the owner approves: the proof
 * the host's sign-in needs before its indicator may verify the login, and a replay's
 * `loginProved`.
 */
export const submittedLoginProof = (
  state: Pick<AutofillSignInState, "submittedSlots" | "steps">,
) => {
  const submitted = [...state.submittedSlots];
  return (
    submitted.some(isIdentifier) &&
    (submitted.some(provesLogin) || state.steps.some((step) => step.approval !== undefined))
  );
};
/**
 * A date of birth, ZIP or recovery code: the site checks it, but it never proves the login. A
 * dropdown sends an option's own value, never the text the host chose, so it counts as
 * filled, and is never filled again in the sign-in, once its fill reached the page.
 */
export const isExtraSecret = (
  slot: AutofillSlot,
): slot is Exclude<ExtraSecretSlot, "private_answer"> =>
  slot === "date_of_birth" || slot === "zip" || slot === "recovery_code";

/**
 * The filled values went out with a submit clicked after the fill, by the host or the minter, or a
 * lost answer may have sent them: each counts as submitted, an email, phone or account number is
 * one a host may bind, and a saved security answer typed on the way counts as sent. Returns the
 * slots it moved.
 */
export const submitFilled = (state: AutofillSignInState): readonly AutofillSlot[] => {
  const moved = [...state.filled.keys()];
  for (const [slot, value] of state.filled) {
    if (slot === "email" || slot === "phone") state.sentIdentifiers[slot] = value;
    if (slot === "account_number") state.sentIdentifiers.accountNumber = value;
    state.submittedSlots.add(slot);
  }
  state.filled.clear();
  state.securityAnswers?.submitted();
  return moved;
};

/**
 * The minter went on from a screen whose fill reached the page but no host click sent: it clicked
 * that screen's submit itself, which records the screen as submitted by the minter, or the screen
 * had none and sent itself, as a code box that submits on its last digit does, or its values went
 * with the next screen's submit. Either way they count as submitted once the minter goes on.
 */
export const settleMinterSubmit = (state: AutofillSignInState): readonly AutofillSlot[] => {
  if (state.filled.size === 0) return [];
  const last = state.steps.at(-1);
  if (last?.submit !== undefined && last.submittedBy === undefined)
    state.steps[state.steps.length - 1] = { ...last, submittedBy: "minter" };
  return submitFilled(state);
};

/**
 * Whether a text carries a secret the broker holds, for what armStep records of a control; a
 * broker that cannot tell is reported and counts it as carrying one.
 */
export const registeredSecretIn =
  (
    broker: Pick<SecretBroker, "registeredSecretMatches">,
    context: Pick<SignInReportContext, "component" | "correlation">,
  ) =>
  (text: string) =>
    broker.registeredSecretMatches(text).pipe(
      Effect.map((found) => found.length > 0),
      Effect.catchAll((error) =>
        report
          .failure(error, {
            ...context,
            operation: "broker.registeredSecretMatches",
            phase: "autofill_step",
            subCause: "autofill_step_failed",
          })
          .pipe(Effect.as(true)),
      ),
    );

/**
 * What named a control when the inspection read it, and nothing else of it, so the signed-in
 * check knows that control from another its selector matches: none when any of it carries a
 * secret the broker holds (`secretIn`), such as a typed password page code copied into a
 * placeholder, since that check sends it to the browser in its code.
 */
const namedControl = (
  named: ControlIdentity | undefined,
  secretIn: (text: string) => Effect.Effect<boolean>,
) =>
  Effect.gen(function* () {
    if (named === undefined) return undefined;
    const { label, ariaLabel, placeholder, type, autocomplete, name, id } = named;
    const identity: ControlIdentity = {
      label,
      ariaLabel,
      placeholder,
      type,
      autocomplete,
      name,
      id,
    };
    for (const text of [label, ariaLabel, placeholder, type, autocomplete, name, id])
      if (text !== null && (yield* secretIn(text))) return undefined;
    return identity;
  });

/** `armStep` once what named each control is screened (`identities`, per field). */
const armScreened = (
  state: AutofillSignInState,
  step: AutofillStep,
  inspection: Pick<AutofillInspection, "page" | "targets">,
  values: readonly string[],
  identities: readonly (ControlIdentity | undefined)[],
) => {
  step.fields.forEach((field, index) => {
    if (!isExtraSecret(field.slot) && !isPrivateAnswer(field.slot))
      state.filled.set(field.slot, values[index] ?? "");
  });
  // A date of birth records the control the host found for it, never its value.
  const control = (index: number) => {
    const found = inspection.targets.fields[index]?.control;
    return found === undefined || found === "other" ? undefined : found;
  };
  const identified = (field: AutofillField, index: number) => {
    const identity = identities[index];
    return identity === undefined ? field : { ...field, identity };
  };
  state.steps.push({
    ...(step.popup === undefined ? {} : { popup: step.popup }),
    ...(step.rejectedMarkers === undefined ? {} : { rejectedMarkers: step.rejectedMarkers }),
    fields: step.fields.map((field, index) =>
      identified(
        field.slot === "date_of_birth" ? { ...field, control: control(index) } : field,
        index,
      ),
    ),
    ...(step.submit === undefined ? {} : { submit: step.submit }),
    ...(step.submitKey === undefined ? {} : { submitKey: step.submitKey }),
    ...(step.methods === undefined ? {} : { methods: step.methods }),
    ...(step.dismiss === undefined ? {} : { dismiss: step.dismiss }),
    page: inspection.page,
  });
  state.securityAnswers?.arm(step, values);
};

/**
 * Records a fill about to run and holds the step's values as filled until a submit goes out
 * (`submitFilled`). Each field keeps what named its control (`namedControl`), and a saved security
 * answer among the values counts as typed from here.
 */
export const armStep = (
  state: AutofillSignInState,
  step: AutofillStep,
  inspection: Pick<AutofillInspection, "page" | "targets"> & {
    readonly screen?: { readonly fields: readonly ControlIdentity[] };
  },
  values: readonly string[],
  /** Whether a control's naming carries a secret the broker holds (`registeredSecretIn`). */
  secretIn: (text: string) => Effect.Effect<boolean>,
) =>
  Effect.forEach(step.fields, (_, index) =>
    namedControl(inspection.screen?.fields[index], secretIn),
  ).pipe(Effect.map((identities) => armScreened(state, step, inspection, values, identities)));

/**
 * Whether a screen of the open sign-in (`open`, none for a sign-in it starts or a successor's
 * restart) asks for the password an earlier screen of it took, as its fill refills (`refills`),
 * beside a second factor none of its earlier screens took, as a site that wants the password
 * re-entered with a one-time code does: the recipe records the refill there, and only there a
 * run's replay makes it.
 */
export const reasksPassword = (
  open: AutofillSignInState | undefined,
  step: AutofillStep,
  refills: readonly AutofillSlot[],
) => {
  const earlier = (which: (slot: AutofillSlot) => boolean) =>
    open?.steps.some((taken) => taken.fields.some((field) => which(field.slot))) === true;
  return (
    refills.includes("password") &&
    step.fields.some((field) => isSecondFactor(field.slot)) &&
    earlier((slot) => slot === "password") &&
    !earlier(isSecondFactor)
  );
};

/** Marks the screen just armed as asking for the password again (`reasksPassword`). */
export const noteRefill = (state: AutofillSignInState) => {
  const armed = state.steps.at(-1);
  if (armed !== undefined)
    state.steps[state.steps.length - 1] = { ...armed, refills: ["password"] };
};

/**
 * Records what a fill did once it returns: a field it did not fill is not held as filled, nor a
 * saved security answer typed, a step that reached nothing leaves the recipe, a step the host
 * clicked records it, with `submitVia` when it pressed the submit from the keyboard, and one whose
 * click another element caught is the open sign-in's `blocked` screen. Returns whether anything
 * reached the page.
 */
export const recordStep = (
  state: AutofillSignInState,
  step: AutofillStep,
  stepReport: AutofillStepReport,
) => {
  const filled = step.fields.map(
    (_, index) =>
      stepReport.outcome === "uncertain" ||
      (stepReport.outcome === "filled" && stepReport.fields[index]?.status === "filled"),
  );
  step.fields.forEach((field, index) => {
    if (!filled[index] && !state.submittedSlots.has(field.slot)) state.filled.delete(field.slot);
  });
  state.securityAnswers?.settle(step, filled);
  const reached = filled.includes(true);
  const submit = stepReport.outcome === "filled" ? stepReport.submit : stepReport.outcome;
  state.blocked = submit === "blocked" && reached ? step : undefined;
  const last = state.steps.at(-1);
  if (!reached && submit !== "clicked" && submit !== "uncertain") state.steps.pop();
  else if (submit === "clicked" && last)
    state.steps[state.steps.length - 1] = {
      ...last,
      submittedBy: "host",
      ...(stepReport.outcome === "filled" && stepReport.via !== undefined
        ? { submitVia: stepReport.via }
        : {}),
    };
  return reached || submit === "clicked" || submit === "uncertain";
};

/**
 * The open sign-in's `blocked` screen when `request` names it again, by its popup, its fields'
 * selectors in order, its submit, submit key and methods, with the request's `dismiss`: the host
 * clicks its submit again and types nothing (`resubmitAutofillStep`). Undefined for any other
 * screen, which is a fill of its own.
 */
export const blockedScreen = (
  state: AutofillSignInState | undefined,
  request: Pick<AutofillStep, "popup" | "submit" | "submitKey" | "methods" | "dismiss"> & {
    readonly fields: readonly { readonly selector: string }[];
  },
): AutofillStep | undefined => {
  const blocked = state?.blocked;
  if (
    blocked === undefined ||
    blocked.submit !== request.submit ||
    blocked.submitKey !== request.submitKey ||
    JSON.stringify(blocked.popup) !== JSON.stringify(request.popup) ||
    JSON.stringify(blocked.methods) !== JSON.stringify(request.methods) ||
    blocked.fields.length !== request.fields.length ||
    blocked.fields.some((field, index) => field.selector !== request.fields[index]?.selector)
  )
    return undefined;
  const { dismiss: _dismiss, ...screen } = blocked;
  return request.dismiss === undefined ? screen : { ...screen, dismiss: request.dismiss };
};

/**
 * Records the host's click again of the `blocked` screen (`resubmitAutofillStep`) once it returns:
 * the screen's recorded step, the open sign-in's last, takes the `dismiss` the host clicks there,
 * which a run's replay clicks too, and the report settles it as a fill's would (`recordStep`). A
 * refusal clicked nothing, so the screen stays blocked with what it holds. A field found empty
 * before the click clicked nothing either, and nothing of the screen was sent: its step leaves the
 * recipe, so the screen filled again records it once, with its dismiss, and what the blocked fill
 * typed is no longer held. Returns those slots, which the host counts as filled, so the screen
 * filled again is a refill and a password or code is typed twice at most.
 */
export const recordResubmit = (
  state: AutofillSignInState,
  step: AutofillStep,
  stepReport: AutofillStepReport,
): readonly AutofillSlot[] => {
  if (stepReport.outcome === "refused") return [];
  if (stepReport.outcome === "filled" && stepReport.submit === "not_attempted") {
    state.blocked = undefined;
    state.steps.pop();
    const typed = [...state.filled.keys()];
    state.filled.clear();
    return typed;
  }
  const last = state.steps.at(-1);
  if (last !== undefined && step.dismiss !== undefined)
    state.steps[state.steps.length - 1] = { ...last, dismiss: step.dismiss };
  recordStep(state, step, stepReport);
  return [];
};
