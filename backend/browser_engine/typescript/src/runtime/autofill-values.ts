import { Effect } from "effect";
import type { YieldableError } from "effect/Cause";
import type {
  AutofillField,
  AutofillStep,
  AutofillStepRequest,
  FillSlot,
  IdentifierKind,
} from "../destinations/autofill-step.js";
import { wholeDateLayouts } from "../destinations/login-field-formats.js";
import type { WebsiteCredentials } from "./authentication.js";
import { correctionTriesLeft } from "./credential-prompts.js";
import type { InputAsker } from "./input-request.js";
import {
  chosenKind,
  heldField,
  loginFieldKeys,
  separateUsername,
  type AnsweredLoginField,
  type AnsweredLoginFields,
  type Asked,
  type LoginIdentifierKind,
} from "./login-values.js";
import type { SecretBroker, SecurityAnswerFills } from "./autofill-state.js";
import { makeFreshAutofillValues } from "./autofill-fresh-values.js";
import {
  type AutofillValueFailure,
  bareCode,
  codeDoesNotFit,
  fitsCodeBoxes,
  makeLoginFieldAsk,
  type SaveOffer,
  type ShownAnswerField,
  Unanswered,
} from "./login-field-asks.js";

export type {
  AnsweredLoginField,
  AnsweredLoginFields,
  LoginIdentifierKind,
} from "./login-values.js";
export { heldField } from "./login-values.js";

type CorrectionField = AnsweredLoginField | "recovery_code";

/**
 * A saved date of birth or ZIP the site has not refused: the owner's edit of the saved login. A
 * refused saved value is never read again.
 */
const unrefusedSavedExtra = (
  slot: AnsweredLoginField,
  login: { readonly credentials: WebsiteCredentials },
  rejected: ReadonlySet<string>,
) => {
  if (slot !== "date_of_birth" && slot !== "zip") return undefined;
  const saved = login.credentials[loginFieldKeys[slot]];
  return saved !== undefined && !rejected.has(saved) ? saved : undefined;
};

/** Whether the login holds a kind: a username of its own, else one `heldField` finds. */
export const holdsKind =
  (credentials: WebsiteCredentials, given: AnsweredLoginFields) => (kind: IdentifierKind) =>
    kind === "username"
      ? separateUsername(credentials)
      : heldField(kind, credentials, given) !== undefined;

/** Why a sign-in needs a new code: the site rejected the last one, or a takeover restarted it. */
export type CodeAgain = "rejected" | "resumed";
/** A recovery code a step's value took from the host, and how many unspent codes remain after it. */
export interface TakenRecoveryCode {
  readonly code: string;
  readonly remaining: number;
}

/**
 * The step as the host sends it: each identifier field takes the kind `chosenKind` picks. Without
 * the login's values (a value-free replay, which fills no field) only the owner's answers count.
 */
const resolveStep = (
  step: AutofillStepRequest,
  credentials: WebsiteCredentials | undefined,
  given: AnsweredLoginFields,
): AutofillStep => ({
  ...step,
  fields: step.fields.map((field) =>
    "slot" in field
      ? field
      : {
          ...field,
          slot: chosenKind(
            field.accepts,
            credentials === undefined
              ? (kind) => kind !== "username" && given[kind] !== undefined
              : holdsKind(credentials, given),
          ),
        },
  ),
});

/** A value the host resolved for a field: the owner's, the login's or its own; else why none. */
export type Found =
  | Unanswered
  | {
      readonly slot: AutofillField["slot"];
      readonly value: string;
      readonly recoveryCode?: TakenRecoveryCode;
    };

/**
 * The screen's own instruction for its code, which the first code field that names one
 * (`questionSelector`) read at inspection, such as to call a number or approve in an app; none
 * when the host could not read it.
 */
const codeInstruction = (step: AutofillStep, screen: readonly ShownAnswerField[] | undefined) =>
  step.fields.flatMap((field, index) => {
    const shown = screen?.[index];
    return field.slot === "code" &&
      field.questionSelector !== undefined &&
      shown?.questionUnread !== true &&
      shown?.questionText !== undefined
      ? [shown.questionText]
      : [];
  })[0];

/**
 * The step's values in field order, the step with the kind each identifier field was sent, which
 * an answer to a field that accepts several kinds decides, and the recovery codes it took. A later
 * field the owner did not answer, or that failed, fills nothing: the codes it took go back.
 */
const valuesInOrder =
  <L extends AutofillLogin, E>(
    valueFor: (
      field: AutofillField,
      login: L,
      shown: ShownAnswerField | undefined,
      passwordShown: boolean,
    ) => Effect.Effect<Found, E>,
    giveBackTaken: (login: L, taken: readonly TakenRecoveryCode[]) => Effect.Effect<void>,
  ) =>
  /** `screen` is the step's fields as the host inspected them, in the step's order. */
  (step: AutofillStep, login: L, screen?: readonly ShownAnswerField[]) => {
    const recoveryCodes: TakenRecoveryCode[] = [];
    const giveBack = Effect.suspend(() => giveBackTaken(login, recoveryCodes));
    // A screen carries one code: its code fields, such as one-digit boxes, share it, asked or
    // read once. A screen that asked for two different codes would get the first in both.
    const boxes = step.fields.filter((field) => field.slot === "code").length;
    const instruction = codeInstruction(step, screen);
    const codeLogin =
      boxes > 1 || instruction !== undefined
        ? {
            ...login,
            ...(boxes > 1 ? { codeBoxes: boxes } : {}),
            ...(instruction === undefined ? {} : { codeInstruction: instruction }),
          }
        : login;
    return Effect.gen(function* () {
      const values: string[] = [];
      const fields: AutofillField[] = [];
      // A saved security answer among them counts as typed only once the screen's fill starts.
      login.securityAnswers?.begin();
      const passwordShown = step.fields.some(
        (field, index) => field.slot === "password" && screen?.[index] !== undefined,
      );
      let code: Exclude<Found, Unanswered> | undefined;
      for (const [index, field] of step.fields.entries()) {
        const found =
          field.slot === "code"
            ? (code ??
              boxedCode(yield* valueFor(field, codeLogin, screen?.[index], passwordShown), boxes))
            : yield* valueFor(field, login, screen?.[index], passwordShown);
        if (found instanceof Unanswered) {
          yield* giveBack;
          return found;
        }
        if (field.slot === "code") code = found;
        values.push(found.value);
        fields.push({ ...field, slot: found.slot });
        if (found.recoveryCode !== undefined) recoveryCodes.push(found.recoveryCode);
      }
      return { values, step: { ...step, fields }, recoveryCodes };
    }).pipe(Effect.tapError(() => giveBack));
  };

/**
 * The code a screen's code fields share. Several, such as one-character boxes, take it one
 * character each, without the spaces and hyphens it is often written with (`123 456`), so what the
 * host types, watches go out and rules out after a refusal is the code the site gets. A code that
 * does not fit them is never typed, since a box keeps only its first character and a widget that
 * sends itself would spend the site's try on it: an owner's answer was asked again already
 * (`codeBoxes`), and one the host gave ends the step (`codeDoesNotFit`). One code field takes the
 * code as given.
 */
const boxedCode = (found: Found, boxes: number): Found => {
  if (found instanceof Unanswered || boxes < 2) return found;
  return fitsCodeBoxes(found.value, boxes)
    ? { ...found, value: bareCode(found.value) }
    : new Unanswered(codeDoesNotFit);
};

/**
 * The values as the host types them: a screen with as many code fields as its code has characters,
 * one-digit boxes, takes one character in each, in order (`valuesInOrder` gives a screen of several
 * code fields no other code); any other screen takes its values as they are. Every code field's
 * value stays the whole code everywhere else, since what the host watches go out and what a
 * refusal rules out is the code.
 */
export const typedValues = (
  step: Pick<AutofillStep<FillSlot>, "fields">,
  values: readonly string[],
) => {
  const boxes = step.fields.flatMap((field, index) => (field.slot === "code" ? [index] : []));
  const [first] = boxes;
  const characters = first === undefined ? [] : Array.from(values[first] ?? "");
  if (boxes.length < 2 || characters.length !== boxes.length) return values;
  return values.map((value, index) => {
    const box = boxes.indexOf(index);
    return box === -1 ? value : (characters[box] ?? value);
  });
};

/** What the host holds of a login for one step's values. */
export interface AutofillLogin {
  readonly credentials: WebsiteCredentials;
  readonly ask: InputAsker;
  /**
   * Why a new code is needed, for the owner: the site rejected the last one, a takeover, or the
   * code screen came back after this sign-in may have sent a code, with no rejection reported.
   */
  readonly codeAgain?: CodeAgain | "returned";
  /** Codes this sign-in already sent and rejected; never fill one again. */
  readonly rejectedCodes?: ReadonlySet<string>;
  /** Private field-specific rejection history held by this sign-in's host. */
  readonly rejectedValues?: Partial<Record<CorrectionField, ReadonlySet<string>>>;
  /** Only the actual rejected secondary field consumes this shared correction budget. */
  readonly correctionRequests?: Partial<Record<CorrectionField, number>>;
  /** Every caller correction ask consumes one of the sign-in's two code re-asks. */
  readonly codeRequests?: { current: number };
  /**
   * The code fields of the step being filled when it has several, such as one-character boxes,
   * which take a code only one character each: an owner's answer that does not fit is asked
   * again.
   */
  readonly codeBoxes?: number;
  /**
   * The code screen's own instruction for the code, such as to call a number within a few minutes,
   * which the owner is asked for the code with.
   */
  readonly codeInstruction?: string;
  /** Whether an asked field may be kept with the login, with the owner's yes (`SaveOffer`). */
  readonly offerSave?: boolean;
  /** Whether a corrected answer to a rejected field may be kept, with the owner's yes. */
  readonly secondaryCorrectionSave?: Effect.Effect<boolean>;
  /** The host's record of the saved security answers it types (`SecurityAnswerFills`). */
  readonly securityAnswers?: SecurityAnswerFills | undefined;
}

/**
 * The values a host gives from what it keeps besides the login's record, each with the login a
 * step resolves with (`L`, which may carry the host's own fields): a code field's code, a recovery
 * code field's code, a security answer, and the give-back of recovery codes a step took and never
 * filled. Absent, the owner is asked. `saveOffer` offers to keep an answer the owner gives.
 */
export interface HostedValues<E, L extends AutofillLogin> {
  /**
   * A code field's code. When the host's own code source can't give a code, it returns
   * `Unanswered` with the `credentialUnavailable` cause, so the step fails as the host's outage
   * rather than as the site's refusal of a code.
   */
  readonly code?: ((login: L) => Effect.Effect<Found, E>) | undefined;
  readonly recoveryCode?: ((login: L) => Effect.Effect<Found, E>) | undefined;
  readonly privateAnswer?:
    | ((
        login: L,
        shown: ShownAnswerField | undefined,
        passwordShown: boolean,
      ) => Effect.Effect<Found, E>)
    | undefined;
  readonly giveBack?:
    | ((login: L, taken: readonly TakenRecoveryCode[]) => Effect.Effect<void>)
    | undefined;
  readonly saveOffer?: SaveOffer | undefined;
}

/**
 * The values an autofill step fills, in field order: the login's stored username into a
 * `username` slot, its password, and an identifier, date of birth or ZIP its record holds. What the
 * login does not hold is asked of the owner in place: a plain host question for an identifier, the
 * same `system` source as every login ask, and a secret one for a date of birth, ZIP, code,
 * recovery code or security answer, unless the host gives one (`hosted`). An answered identifier
 * is the same login, never another account. Each value is registered with the broker so every
 * channel masks it as the username is. Fields the owner gives are kept for the attempt (`given`);
 * a code is asked for each screen that shows one, once for all of that screen's code fields.
 */
export const makeAutofillValues = <
  E extends YieldableError,
  L extends AutofillLogin = AutofillLogin,
>(dependencies: {
  readonly broker: Pick<SecretBroker, "register">;
  readonly unavailable: AutofillValueFailure<E>;
  readonly site: string;
  readonly given: { current: AnsweredLoginFields };
  readonly hosted?: HostedValues<E, L> | undefined;
}) => {
  const { given, hosted } = dependencies;
  const { register, ask, askAnswer, fail } = makeLoginFieldAsk({
    ...dependencies,
    saveOffer: hosted?.saveOffer,
  });
  const { askedCode, correctedValue } = makeFreshAutofillValues({ ask });
  /** The host's code, else the owner's, with why a new one is needed. */
  const codeValue = (login: L): Effect.Effect<Found, E> =>
    hosted?.code?.(login) ?? askedCode(login, login.codeBoxes);
  /** The host's recovery code, else the owner's; a rejected one is corrected in place. */
  const recoveryValue = (login: L): Effect.Effect<Found, E> =>
    hosted?.recoveryCode?.(login) ??
    Effect.gen(function* () {
      const rejected = login.rejectedValues?.recovery_code;
      if (!rejected?.size) return yield* ask(login.ask, "recovery_code");
      return yield* correctedValue(login, "recovery_code", () => ask(login.ask, "recovery_code"));
    });
  /** The host's security answer, else the owner's, asked with the site's own question. */
  const answerValue = (
    login: L,
    shown: ShownAnswerField | undefined,
    passwordShown: boolean,
  ): Effect.Effect<Found, E> =>
    hosted?.privateAnswer?.(login, shown, passwordShown) ??
    Effect.gen(function* () {
      const answered = yield* askAnswer(login.ask, shown, false);
      if (answered instanceof Unanswered) return answered;
      return { slot: "private_answer" as const, value: answered.value };
    });
  /** A rejected extra never falls back to its saved value or the primary identifier's shape. */
  const fieldValue = (slot: AnsweredLoginField, login: AutofillLogin) =>
    Effect.gen(function* () {
      const privateExtra = slot === "date_of_birth" || slot === "zip";
      const requested: Asked = privateExtra ? slot : [slot];
      const rejected = login.rejectedValues?.[slot] ?? new Set<string>();
      if (rejected.size === 0) {
        const held = heldField(slot, login.credentials, given.current);
        return held === undefined
          ? yield* ask(login.ask, requested, undefined, login.offerSave === true)
          : { value: held };
      }
      const fresh = given.current[slot];
      if (fresh !== undefined && !rejected.has(fresh)) return { value: fresh };
      const saved = unrefusedSavedExtra(slot, login, rejected);
      if (saved !== undefined) return { value: saved };
      // Do not infer a secondary email from the primary after rejection.
      if (!login.correctionRequests) return new Unanswered("correction_history_unavailable");
      const offerSave = yield* login.secondaryCorrectionSave ?? Effect.succeed(false);
      return yield* correctedValue(login, slot, (triesLeft) =>
        ask(
          login.ask,
          requested,
          `The site did not accept the last value, so it needs a correction. ${correctionTriesLeft(triesLeft)}`,
          offerSave,
        ),
      );
    });
  /** A date of birth or ZIP: the record's, the owner's answer, else asked with the save offer. */
  const checkedValue = (slot: "date_of_birth" | "zip", login: AutofillLogin) =>
    Effect.gen(function* () {
      const answered = yield* fieldValue(slot, login);
      if (answered instanceof Unanswered) return answered;
      if (slot === "zip") {
        yield* register(slot, answered.value);
        return { slot, value: answered.value };
      }
      // The date is masked in every whole-date layout a page may show it in. The fill writes the
      // ISO date as the field takes it, with the authoring library's `fillDate`.
      for (const layout of wholeDateLayouts(answered.value)) yield* register(slot, layout);
      return { slot, value: answered.value };
    });
  /** Resolves a secondary identifier without guessing a rejected primary alias. */
  const identifierValue = (field: AutofillField, slot: LoginIdentifierKind, login: AutofillLogin) =>
    Effect.gen(function* () {
      if (login.rejectedValues?.[slot]?.size) {
        const corrected = yield* fieldValue(slot, login);
        return corrected instanceof Unanswered ? corrected : { slot, value: corrected.value };
      }
      // The saved record's identifier first, then one the owner gave this attempt; else the owner
      // is asked for one of the kinds the field accepts.
      const stored = heldField(slot, login.credentials, given.current);
      if (stored !== undefined) return { slot, value: stored };
      const asked = (field.accepts ?? [slot]).filter(
        (kind): kind is LoginIdentifierKind => kind !== "username",
      );
      return yield* ask(login.ask, asked, undefined, login.offerSave === true);
    });
  const valueFor = (
    field: AutofillField,
    login: L,
    shown: ShownAnswerField | undefined,
    passwordShown: boolean,
  ): Effect.Effect<Found, E> =>
    Effect.gen(function* () {
      const { slot } = field;
      if (slot === "private_answer") return yield* answerValue(login, shown, passwordShown);
      if (slot === "password") {
        if (login.credentials.password !== undefined)
          return { slot, value: login.credentials.password };
        return yield* fail("browser.lifecycle.autofill", { check: "password_unavailable" });
      }
      if (slot === "code") return yield* codeValue(login);
      if (slot === "recovery_code") return yield* recoveryValue(login);
      if (slot === "username") return { slot, value: login.credentials.username };
      if (slot === "date_of_birth" || slot === "zip") return yield* checkedValue(slot, login);
      return yield* identifierValue(field, slot, login);
    });
  const valuesFor = valuesInOrder<L, E>(
    valueFor,
    (login, taken) => hosted?.giveBack?.(login, taken) ?? Effect.void,
  );
  return {
    valuesFor,
    /** The step as the host sends it; see `resolveStep`. */
    resolve: (step: AutofillStepRequest, credentials: WebsiteCredentials | undefined) =>
      resolveStep(step, credentials, given.current),
    /** Drops an answer that is not the site's bound one, so the next step asks again. */
    forget: (field: AnsweredLoginField) => {
      if (given.current[field] === undefined) return false;
      const next = { ...given.current };
      delete next[field];
      given.current = next;
      return true;
    },
  };
};
