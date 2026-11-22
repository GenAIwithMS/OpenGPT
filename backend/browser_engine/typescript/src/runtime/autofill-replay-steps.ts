import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { YieldableError } from "effect/Cause";
import type { SignInRecipe } from "../destinations/sign-in-recipe.js";
import type { CheckedWorkspace, ReplayWorkspace } from "./autofill-replay-workspace.js";
import {
  type AutofillRecipeStep,
  isSecondFactor,
  type RejectedMarker,
  type SignInMethodChoice,
} from "../destinations/autofill-recipe.js";
import type {
  AutofillSlot,
  AutofillStep,
  AutofillStepReport,
} from "../destinations/autofill-step.js";
import { refusalEvidence } from "../destinations/autofill-refusal-evidence.js";
import {
  type AutofillHooks,
  type AutofillSecret,
  type SecretBroker,
  type SecurityAnswerFills,
  isExtraSecret,
  isSecret,
  provesLogin,
} from "./autofill-state.js";
import type {
  AnsweredLoginFields,
  AutofillLogin,
  HostedValues,
  makeAutofillValues,
  TakenRecoveryCode,
} from "./autofill-values.js";
import {
  type AutofillValueFailure,
  type ShownAnswerField,
  savedLoginFieldSaveOffer,
} from "./login-field-asks.js";
import type { WebsiteCredentials } from "./authentication.js";
import type { InputAsker, Question } from "./input-request.js";
import type { EventSink } from "./context.js";
import type { ClearThenResubmit } from "./autofill-replay-screens.js";
import type { ReplaySession } from "./autofill-replay-session.js";

// A run's replay of an autofill sign-in recipe: its contract and the pieces of one step.

/**
 * A replay that signed in, on the workspace origin its check verified for a tool with a workspace
 * relation; `cantTell` when it ended on a page that can't tell, which no check of the marker has
 * proven.
 */
type SignedInReplay = {
  readonly outcome: "signed_in";
  readonly cantTell?: true;
} & CheckedWorkspace;

/**
 * How a run's replay of the published recipe ended:
 * - `signed_in`: the host checked the indicator and verified the login's identity;
 *   `alreadySignedIn` when the bound profile was signed in and no credential field was sent;
 *   `cantTell` when a sign-in that may end on a page that can't tell ended on one (see
 *   `confirmCantTell`).
 * - `unsent`: nothing reached the site.
 * - `unclear`: something may have reached the site and the recipe's sign-in check failed.
 * `password_rejected` means the site took the password and showed its screen again, so the owner
 * may be asked for the login; `challenge_unsolved` means a screen never showed behind a challenge
 * the host could not clear, whose vendor `challenge` names.
 */
export type AutofillReplayOutcome<V extends string = string> =
  | (SignedInReplay & { readonly alreadySignedIn: true })
  | (SignedInReplay & {
      readonly alreadySignedIn: false;
      /** It submitted the login's identifier and its password or code, or passed an approval. */
      readonly loginProved: boolean;
    })
  | {
      readonly outcome: "unsent";
      readonly reason: string;
      readonly rejectedFields?: readonly RejectedMarker["slot"][];
      readonly challenge?: V;
    }
  | {
      readonly outcome: "unclear";
      readonly reason: string;
      readonly rejectedFields?: readonly RejectedMarker["slot"][];
      readonly challenge?: V;
    };

/** Private existing-attempt state survives browser and credential replay rebuilds. */
export interface AutofillRetryState {
  readonly rejectedValues: Partial<Record<AutofillSlot, Set<string>>>;
  readonly lastFilled: Partial<Record<AutofillSlot, string>>;
  readonly correctionRequests: Partial<Record<AutofillSlot, number>>;
  readonly codeRequests: { current: number };
  readonly codeAttempts: { current: number };
}

/**
 * How a replay waits: for each screen to show, and between polls. A replay has no cumulative
 * budget: finite recorded screens, each waited at most `stepWaitMs`, the per-field correction and
 * code retry bounds, protected input expiry and cancellation bound it.
 */
export interface AutofillReplayTiming {
  readonly stepWaitMs: number;
  readonly pollMs: number;
  /** How long after a cleared challenge the replay lets the page answer before it clicks again. */
  readonly clearSettleMs?: number;
  /**
   * How often the marker wait after the screens looks for a code screen the recipe never recorded,
   * between its marker checks (1 s when absent).
   */
  readonly codeLookMs?: number;
}
/** How long a replay waits for a recorded screen's fields before it gives up: sign-in pages are often slow. */
const recordedScreenWaitMs = 30_000;
export const defaultTiming: AutofillReplayTiming = {
  stepWaitMs: recordedScreenWaitMs,
  pollMs: 250,
};

/**
 * Why a value-free replay stopped: the screen it reached needs the login's values, which the run
 * reads before it replays again from the entry URL.
 */
export const valuesNeeded = "values_needed";

/** The methods' names, as the caller reads them. */
export const methodLabels: Record<SignInMethodChoice, string> = {
  sms: "Text message",
  call: "Phone call",
  email: "Email",
  totp: "Authenticator app",
  push: "Push notification",
  recovery_code: "Recovery code",
};

/** A recorded method choice's option. */
export type SignInMethodOption = NonNullable<AutofillRecipeStep["methods"]>[number];

/**
 * What a host adds to a replay from what it keeps besides the login's record, each optional: the
 * values it gives (`HostedValues`), its record of the saved security answers it types, and:
 * - `login`: each step's login with the host's own fields, given the method this replay picked
 *   (`chosen`) and whether a code may come from the host's own generator (`seedAllowed`);
 * - `method`: a method choice the host decides before the owner is asked;
 * - `settleRecoveryCodes`: a filled step's recovery codes, used when it reached the page, else
 *   given back;
 * - `identifierConflict`: whether the host refuses the identifiers a step would type;
 * - `refuseShownAnswer`: after a failed check, a saved answer whose question shows again;
 * - `resubmit`: the challenge look at a screen's deadline, which may send the last screen again.
 */
export interface HostedSignIn<
  E extends YieldableError,
  V extends string = string,
  L extends AutofillLogin = AutofillLogin,
> extends HostedValues<E, L> {
  readonly securityAnswers?: SecurityAnswerFills | undefined;
  readonly login?:
    | ((
        base: AutofillLogin,
        step: { readonly chosen: SignInMethodChoice | undefined; readonly seedAllowed: boolean },
      ) => L)
    | undefined;
  readonly method?:
    | ((
        methods: NonNullable<AutofillRecipeStep["methods"]>,
      ) => Effect.Effect<SignInMethodOption | undefined, E>)
    | undefined;
  readonly settleRecoveryCodes?:
    | ((taken: readonly TakenRecoveryCode[], reached: boolean) => Effect.Effect<void>)
    | undefined;
  readonly identifierConflict?:
    | ((step: AutofillStep, values: readonly string[]) => Effect.Effect<boolean, E>)
    | undefined;
  readonly refuseShownAnswer?:
    | ((ran: readonly AutofillStep[]) => Effect.Effect<void, E>)
    | undefined;
  readonly resubmit?: ((session: ReplaySession<E, V, L>) => ClearThenResubmit<E, V>) | undefined;
}

export interface AutofillReplayInput<
  E extends YieldableError = YieldableError,
  V extends string = string,
  L extends AutofillLogin = AutofillLogin,
> {
  readonly latency?: EventSink | undefined;
  readonly recipe: SignInRecipe;
  /** Set for a tool with a workspace relation; absent, every screen keeps its recorded origin. */
  readonly workspace?: ReplayWorkspace<E> | undefined;
  readonly hooks: AutofillHooks<E, V>;
  /** Where the replay starts: the published login URL, else the site. */
  readonly entryUrl: string;
  /**
   * The login's values, or undefined while the run holds none: the replay is then the run's
   * value-free sign-in check. It checks a saved session and runs fieldless navigation as ever, and
   * stops unsent (`valuesNeeded`) at the first screen that would need a value, a method choice or
   * an approval, so the run reads its login only when it must.
   */
  readonly credentials: WebsiteCredentials | undefined;
  /**
   * A session read just found the page signed out, and this value-free check is the sign-in that
   * follows it: its login entry never ends as one that can't tell (`entryCantTell`).
   */
  readonly readSignedOut?: boolean;
  readonly retryState?: AutofillRetryState;
  readonly ask: InputAsker;
  /** The fields the owner gave, kept with the attempt. */
  readonly answers?: { readonly given: { current: AnsweredLoginFields } };
  readonly broker: Pick<SecretBroker, "register" | "registeredSecretMatches">;
  /** The site's name for the host's questions. */
  readonly site: string;
  /** The host's own correlation for its reports, passed through unread. */
  readonly correlation: unknown;
  readonly emit: (details: Readonly<Record<string, unknown>>) => Effect.Effect<void>;
  /**
   * The run's failures: a question that failed (unanswered ends the run, an outage falls back),
   * and a dependency that failed.
   */
  readonly failures: {
    /** `field` names the value that went unanswered, when the host knows it. */
    readonly unanswered: (cause: unknown, field?: string) => E;
    readonly unavailable: AutofillValueFailure<E>;
  };
  readonly timing?: AutofillReplayTiming;
  /**
   * The marker wait after the screens ends at a code screen the recipe never recorded
   * (`unrecordedCodeShown`), looking for one between its marker checks: for a caller that hands
   * over at such a screen. Every other replay never looks, and waits.
   */
  readonly endAtUnrecordedCode?: boolean;
  /** Set once a submit may have sent the login, for a caller whose replay failed part way. */
  readonly sent: { current: boolean };
  /** What the host adds from what it keeps besides the login's record; see `HostedSignIn`. */
  readonly hosted?: HostedSignIn<E, V, L> | undefined;
}

/** Asks the caller one host-written question and returns its answer. */
export const askOne = <E extends YieldableError>(
  input: Pick<AutofillReplayInput<E>, "ask" | "failures">,
  question: Question,
) =>
  input.ask({ id: randomUUID(), source: "system", questions: [question] }).pipe(
    Effect.mapError(input.failures.unanswered),
    Effect.map((answers) => answers[question.id]),
  );

/**
 * A filled step's extra secrets: a date of birth, ZIP or recovery code that reached the page is
 * never filled again in the sign-in, and each recovery code it took is spent or given back.
 */
export const settleFilled = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  sent: { readonly maySent: Set<AutofillSecret> },
  step: AutofillStep,
  taken: readonly TakenRecoveryCode[],
  reached: boolean,
) =>
  Effect.suspend(() => {
    if (reached)
      for (const field of step.fields) if (isExtraSecret(field.slot)) sent.maySent.add(field.slot);
    return input.hosted?.settleRecoveryCodes?.(taken, reached) ?? Effect.void;
  });

/**
 * The method a choice screen picks: the host's (`hosted.method`), else the caller's answer to a
 * host-written choice of the methods the mint recorded, each mapped to its recorded click. With a
 * host's save offer for a method (`saveOffer.method`), that choice comes with it, and the host
 * hears the answer.
 */
export const pickMethod = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  methods: NonNullable<AutofillRecipeStep["methods"]>,
) =>
  Effect.gen(function* () {
    const hosted = yield* input.hosted?.method?.(methods) ?? Effect.succeed(undefined);
    if (hosted) return hosted;
    const options = methods.map((option, index) => ({
      id: `option_${index}`,
      label: methodLabels[option.method],
    }));
    const offered = input.hosted?.saveOffer?.method;
    const questions: Question[] = [
      {
        id: "method",
        type: "choice",
        prompt: `How should ${input.site} confirm it's you?`,
        options,
      },
      ...(offered === undefined ? [] : [offered]),
    ];
    const answers = yield* input
      .ask({
        id: randomUUID(),
        source: "system",
        ...savedLoginFieldSaveOffer(questions),
        questions,
      })
      .pipe(Effect.mapError(input.failures.unanswered));
    const answer = answers["method"];
    const index = options.findIndex(
      (option) => answer?.type === "choice" && option.id === answer.value,
    );
    const picked = methods[index];
    if (picked !== undefined) {
      input.hosted?.saveOffer?.answered({ method: picked.method }, answers);
      return picked;
    }
    return yield* input.failures.unavailable("autofill.method", {
      context: { check: "answer_shape" },
    });
  });

/**
 * Why a fill did not complete its screen, or undefined when it did: the host clicked its submit,
 * it has none, or its page sent what the host filled itself (`page`, as a code widget does on its
 * last box).
 */
export const fillFailure = (stepReport: AutofillStepReport) => {
  if (stepReport.outcome !== "filled") return stepReport.reason;
  if (stepReport.fields.some((field) => field.status !== "filled")) return "fill_failed";
  return stepReport.submit === "clicked" ||
    stepReport.submit === "none" ||
    stepReport.submit === "page"
    ? undefined
    : `submit_${stepReport.submit}`;
};

export const stepDiagnostic = (step: AutofillStep, stepReport: AutofillStepReport) => ({
  stage: "step",
  outcome: stepReport.outcome,
  slots: step.fields.map((field) => field.slot).join(","),
  ...(stepReport.outcome === "filled"
    ? {
        statuses: stepReport.fields.map((field) => field.status).join(","),
        submit: stepReport.submit,
      }
    : { reason: stepReport.reason }),
  ...refusalEvidence(stepReport),
});

/**
 * Each step's login: the login's record, the owner's ask and the replay's rejection history, with
 * the host's own fields (`hosted.login`).
 */
const stepLogin = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  base: AutofillLogin,
  step: { readonly chosen: SignInMethodChoice | undefined; readonly seedAllowed: boolean },
): L => input.hosted?.login?.(base, step) ?? (base as L);

/**
 * A step's values; a host's code comes from its own generator only for the app method or with no
 * choice, and only while `seedAllowed`.
 */
export const valuesFor = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  values: ReturnType<typeof makeAutofillValues<E, L>>,
  chosen: SignInMethodChoice | undefined,
  step: AutofillStep,
  codeAgain: "rejected" | undefined,
  fresh: Pick<
    AutofillLogin,
    "rejectedCodes" | "codeRequests" | "rejectedValues" | "correctionRequests"
  >,
  /** The step's fields as the host inspected them: a security answer's question among them. */
  screen: readonly ShownAnswerField[],
  seedAllowed: boolean,
) =>
  input.credentials === undefined
    ? step.fields.length === 0
      ? Effect.succeed({ values: [], step, recoveryCodes: [] })
      : Effect.fail(
          input.failures.unavailable("autofill.values", { context: { check: "values_not_held" } }),
        )
    : values.valuesFor(
        step,
        stepLogin(
          input,
          {
            credentials: input.credentials,
            ask: input.ask,
            ...(input.hosted?.securityAnswers === undefined
              ? {}
              : { securityAnswers: input.hosted.securityAnswers }),
            ...fresh,
            ...(codeAgain === undefined ? {} : { codeAgain }),
          },
          { chosen, seedAllowed },
        ),
        screen,
      );

/** Whether the last step that took `slot` shows its field again: the site answered with it. */
export const shownAgain = <E>(
  hooks: Pick<AutofillHooks<E>, "inspect">,
  ran: readonly AutofillStep[],
  maySent: ReadonlySet<AutofillSecret>,
  slot: AutofillSecret,
) =>
  Effect.gen(function* () {
    const step = ran.findLast((candidate) => candidate.fields.some((field) => field.slot === slot));
    const field = step?.fields.find((candidate) => candidate.slot === slot);
    if (step === undefined || field === undefined || !maySent.has(slot)) return undefined;
    const inspected = yield* hooks.inspect({
      fields: [field],
      ...(step.popup === undefined ? {} : { popup: step.popup }),
    });
    return "outcome" in inspected ? undefined : step;
  });

/**
 * Whether a recorded screen's planned refill of `slot` holds now: the screen lists it (`planned`,
 * its recipe step's `refills`), it went out once at most so far, and the screen also asks for a
 * second factor this replay has not sent, as a site that wants the password entered again with a
 * one-time code does. A screen asking for it again any other way is a rejection.
 */
const plannedRefill = (
  step: AutofillStep,
  slot: AutofillSecret,
  planned: readonly AutofillSecret[],
  maySent: ReadonlySet<AutofillSecret>,
  refilled: ReadonlySet<AutofillSecret>,
) =>
  planned.some((each) => each === slot) &&
  !refilled.has(slot) &&
  step.fields.some(
    (field) => isSecondFactor(field.slot) && isSecret(field.slot) && !maySent.has(field.slot),
  );

/**
 * Whether a step would fill a secret that may have gone out already beyond what a retry of a
 * refused code, or the recorded screen's planned refill, allows: a password or code once more
 * each, so either goes out at most twice; a date of birth, ZIP or recovery code never again.
 */
export const refillRefused = (
  step: AutofillStep,
  maySent: ReadonlySet<AutofillSecret>,
  refilled: ReadonlySet<AutofillSecret>,
  codeAgain: "rejected" | undefined,
  corrected: ReadonlySet<AutofillSlot>,
  planned: readonly AutofillSecret[] = [],
) =>
  step.fields.some(
    (field) =>
      isSecret(field.slot) &&
      maySent.has(field.slot) &&
      !corrected.has(field.slot) &&
      !(
        codeAgain === "rejected" &&
        (field.slot === "code" || (provesLogin(field.slot) && !refilled.has(field.slot)))
      ) &&
      !plannedRefill(step, field.slot, planned, maySent, refilled),
  );

/** Records each secret a step may have sent, and those it sent a second time. */
export const noteMaySent = (
  step: AutofillStep,
  sentBefore: ReadonlySet<AutofillSecret>,
  maySent: Set<AutofillSecret>,
  refilled: Set<AutofillSecret>,
) => {
  for (const field of step.fields) {
    if (!isSecret(field.slot)) continue;
    if (sentBefore.has(field.slot)) refilled.add(field.slot);
    maySent.add(field.slot);
  }
};

/** Value-free inspection shared by compound code and extra-field retry admission. */
export const emptyReplayFields = <E>(
  hooks: Pick<AutofillHooks<E>, "inspect">,
  fields: AutofillStep["fields"],
  popup?: AutofillStep["popup"],
) =>
  Effect.forEach(fields, (field) =>
    hooks
      .inspect({ fields: [field], ...(popup === undefined ? {} : { popup }) })
      .pipe(
        Effect.map((found) =>
          !("outcome" in found) && found.targets.fields[0]?.empty === true ? field : undefined,
        ),
      ),
  ).pipe(Effect.map((found) => found.filter((field) => field !== undefined)));

export const emptyRetryFields = <E>(
  input: { readonly hooks: Pick<AutofillHooks<E>, "inspect"> },
  shown: AutofillStep,
  codeRejected: boolean,
) =>
  Effect.gen(function* () {
    const fields: AutofillStep["fields"][number][] = [];
    for (const field of shown.fields) {
      if (field.slot === "code") fields.push(field);
      else if (provesLogin(field.slot)) {
        const empty = yield* emptyReplayFields(input.hooks, [field], shown.popup);
        if (empty.length > 0) {
          // Older recipes cannot tell which half of the combined screen the site rejected.
          if (field.slot === "password" && !codeRejected) return "ambiguous_combined_rejection";
          fields.push(field);
        }
      }
    }
    return fields;
  });
