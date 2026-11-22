import { makeReplayScreenWait } from "./autofill-replay-screens.js";
import { Effect } from "effect";
import type { YieldableError } from "effect/Cause";
import { logicalRejectedField, recordedRejections, rejectableSlot } from "./autofill-rejection.js";
import {
  pageMatches,
  pathMatches,
  type AutofillRecipe,
  type AutofillRecipeStep,
  type RejectedMarker,
  type SignInMethodChoice,
} from "../destinations/autofill-recipe.js";
import { resolvedPage, type SignInRecipeStep } from "../destinations/sign-in-recipe.js";
import { signedInCheckOrigin, workspaceHost, workspaceToPin } from "./workspace-origin.js";
import type {
  AutofillInspection,
  AutofillRefusal,
  AutofillSignedInCheck,
  AutofillSlot,
  AutofillStep,
  AutofillStepRequest,
} from "../destinations/autofill-step.js";
import {
  type AutofillSecret,
  type AutofillSignInState,
  isIdentifier,
  provesLogin,
} from "./autofill-state.js";
import { type AutofillLogin, makeAutofillValues } from "./autofill-values.js";
import { cantTell, leftSignInScreens } from "./autofill-replay-pages.js";
import {
  type AutofillReplayInput,
  type AutofillRetryState,
  type AutofillReplayOutcome,
  defaultTiming,
  pickMethod,
  shownAgain,
} from "./autofill-replay-steps.js";
import { runReplayStep, correctReplayExtras, settleCarried } from "./autofill-replay-fill.js";

/** The refusals a screen wait ends with when the screen never showed. */
const missingScreen: ReadonlySet<string> = new Set(["not_found", "not_editable", "popup_missing"]);

/**
 * The first same-site load that failed after the replay's latest submit: a screen that then never
 * shows is its downstream symptom, so the refusal points at it.
 */
const makeFirstCause = () => {
  let submitted = false;
  let first: unknown;
  return {
    /**
     * A step fills and submits: a load that failed before it is not what its next screen waits
     * on, and the browser hears none that started before the step's last insertion.
     */
    submitted: () => {
      submitted = true;
      first = undefined;
    },
    heard: (failure: unknown) => {
      if (submitted && first === undefined) first = failure;
    },
    /** A refused screen's first cause, for its step event, when the screen never showed. */
    evidence: (refusal: AutofillRefusal) =>
      first !== undefined && missingScreen.has(refusal.reason) ? { firstCause: first } : {},
  };
};

/**
 * The replay's recorded screens as it knows the login's workspace origin, which
 * `progress.workspace` holds and the replay updates as it pins or admits one.
 */
const workspaceScreens = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  progress: { readonly workspace: string | undefined },
) => {
  /** Whether an origin passes the workspace gates for this tool; false without a relation. */
  const sibling = (origin: string | undefined) =>
    input.workspace !== undefined &&
    origin !== undefined &&
    workspaceHost(input.workspace.siteOrigin, input.workspace.parent, origin);
  /**
   * The recorded steps with each workspace screen on the workspace origin this replay knows, or by
   * its path alone while it knows none, which then matches no live page.
   */
  const resolvedSteps = (): readonly AutofillRecipeStep[] =>
    (input.recipe.steps as readonly SignInRecipeStep[]).map((step) =>
      step.origin === "workspace"
        ? { ...step, page: resolvedPage(step, progress.workspace) ?? step.page }
        : step,
    );
  /**
   * Whether a page (origin and path) is this recorded screen: its recorded page, or for a workspace
   * screen its path on the workspace origin this replay knows, or, while it knows none, on a host
   * that passes the gates. Paths compare with any trailing slash but the root's dropped. Typing
   * there still waits for the screen's admission.
   */
  const matchesRecorded = (page: string, recorded: SignInRecipeStep) => {
    if (recorded.origin !== "workspace") return pageMatches(page, recorded);
    const at = URL.parse(page);
    if (at === null || !pathMatches(at.pathname, recorded.page, recorded.anySegments)) return false;
    return progress.workspace !== undefined ? at.origin === progress.workspace : sibling(at.origin);
  };
  return { sibling, resolvedSteps, matchesRecorded };
};

const makeReplaySession = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
) => {
  const { hooks, recipe } = input;
  const timing = input.timing ?? defaultTiming;
  const securityAnswers = input.hosted?.securityAnswers;
  const state: AutofillSignInState<E, V> = {
    hooks,
    steps: [],
    filled: new Map(),
    submittedSlots: new Set(),
    sentIdentifiers: {},
    ...(securityAnswers === undefined ? {} : { securityAnswers }),
  };
  /**
   * What the replay sent: `maySent` is every secret a clicked submit sent,
   * which the replay never fills again, and the sign-in's `submittedSlots` are what a submit
   * clicked after the fill sent, which the indicator check needs.
   */
  const sent = {
    maySent: new Set<AutofillSecret>(),
    seenSent: (slot: AutofillSlot) => state.submittedSlots.has(slot),
  };
  const firstCause = makeFirstCause();
  const values = makeAutofillValues<E, L>({
    broker: input.broker,
    unavailable: input.failures.unavailable,
    given: input.answers?.given ?? { current: {} },
    site: input.site,
    hosted: input.hosted,
  });
  const retryState: AutofillRetryState = input.retryState ?? {
    rejectedValues: {},
    lastFilled: {},
    correctionRequests: {},
    codeRequests: { current: 0 },
    codeAttempts: { current: 0 },
  };
  const rejectedCodes = new Set(retryState.rejectedValues.code ?? []);
  const codeRequests = retryState.codeRequests;
  let rejectedFields: readonly RejectedMarker["slot"][] = [];
  const recordRejected = (fields: readonly RejectedMarker["slot"][]) => {
    rejectedFields = fields;
    for (const field of fields) {
      const logical = logicalRejectedField(field, input.credentials?.primaryIdentifierKind);
      const value = retryState.lastFilled[logical];
      if (value === undefined) continue;
      (retryState.rejectedValues[logical] ??= new Set()).add(value);
      if (logical === "code") rejectedCodes.add(value);
    }
  };
  const observeRejections = Effect.gen(function* () {
    const observed = yield* recordedRejections(hooks, resolvedSteps(), input.correlation);
    if (observed !== "unavailable") recordRejected(observed);
    return observed;
  });
  const progress = {
    anythingSent: false,
    chosen: undefined as SignInMethodChoice | undefined,
    ran: [] as AutofillStep[],
    /** The password or code a retry filled a second time, which is never filled again. */
    refilled: new Set<AutofillSecret>(),
    /** A screen's wait that sent nothing found the session signed in, or can't tell. */
    alreadySignedIn: false,
    /** The first screen's wait ended on a login entry that can't tell (`entryCantTell`). */
    entryCantTell: false,
    /** A screen went while the host filled it, which sent nothing (`screenGoneUnsent`). */
    screenGone: false,
    /** The vendor of a challenge behind a screen that never showed, which the gate could not clear. */
    challenge: undefined as V | undefined,
    /**
     * The code screen the recipe never recorded that this replay answered, by its page and field
     * (`codeScreenOf`): only that screen coming back is a refused code, and a code it refused is
     * never the host generator's again.
     */
    unrecordedCodeScreen: undefined as string | undefined,
    /**
     * The login's workspace origin as this replay knows it: the pinned one, or the host this
     * replay admitted after it sent the login's identifier on the site's own sign-in.
     */
    workspace: input.workspace?.pinned,
    /**
     * The workspace origin the passing signed-in check ran on, where the run goes on, which is the
     * login's own only when `workspace` holds it too.
     */
    checkedOn: undefined as string | undefined,
    /** Whether a recorded screen on its exact origin (the shared host) sent these. */
    exactSent: { identifier: false, credentials: false },
  };
  const { sibling, resolvedSteps, matchesRecorded } = workspaceScreens(input, progress);
  const outcome = (reason: string): AutofillReplayOutcome<V> => ({
    outcome: progress.anythingSent ? "unclear" : "unsent",
    reason,
    ...(rejectedFields.length === 0 ? {} : { rejectedFields }),
    ...(progress.challenge === undefined ? {} : { challenge: progress.challenge }),
  });
  // The marker as the current page shows it, read once; the end's check lets the page settle.
  const onPage = { selector: recipe.signedIn.selector, urlPath: recipe.signedIn.urlPath };
  // This replay's own screens, as its inspections named their controls, are the sign-in whose
  // recorded challenges count: the recipe holds no control's naming.
  const checkHere = Effect.suspend(() => hooks.check(onPage, recipe.steps, state.steps));
  const indicatorShown = checkHere.pipe(Effect.map((check) => check.signedIn));

  return {
    input,
    hooks,
    recipe,
    timing,
    state,
    sent,
    firstCause,
    values,
    retryState,
    rejectedCodes,
    codeRequests,
    progress,
    outcome,
    observeRejections,
    recordRejected,
    sibling,
    resolvedSteps,
    matchesRecorded,
    onPage,
    checkHere,
    indicatorShown,
  };
};
export type ReplaySession<
  E extends YieldableError = YieldableError,
  V extends string = string,
  L extends AutofillLogin = AutofillLogin,
> = ReturnType<typeof makeReplaySession<E, V, L>>;
/**
 * A submitted credential screen returning with no recorded error marker is no verdict on the login:
 * the replay ends with the login unmarked (`credential_screen_returned`).
 */
export const returnedCredential = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  session: Pick<ReplaySession<E, V, L>, "progress" | "sent" | "hooks">,
) =>
  Effect.gen(function* () {
    const { progress, sent, hooks } = session;
    const previous = progress.ran.at(-1);
    if (previous !== undefined && !previous.fields.some((field) => field.slot === "code")) {
      const field =
        previous.fields.find((one) => one.slot === "password") ??
        previous.fields.find((one) => isIdentifier(one.slot));
      if (field !== undefined && rejectableSlot(field.slot) && sent.seenSent(field.slot)) {
        const returned = yield* hooks.inspect({
          fields: [field],
          ...(previous.popup === undefined ? {} : { popup: previous.popup }),
        });
        if (!("outcome" in returned)) return "credential_screen_returned" as const;
      }
    }
    return undefined;
  });
/**
 * Resolve current rejection evidence before waiting for a later screen. The submitted screen still
 * showing is the site's answer only at the wait's deadline (`due`), as a site may look the account
 * up before it shows the next screen.
 */
const screenRejection = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  session: ReplaySession<E, V, L>,
  retryExtras: (
    observed: readonly RejectedMarker["slot"][],
  ) => ReturnType<typeof correctReplayExtras<E, V, L>>,
  due: boolean,
) =>
  Effect.gen(function* () {
    const observed = yield* session.observeRejections;
    if (observed === "unavailable") return "ambiguous_combined_rejection" as const;
    const extra = yield* retryExtras(observed);
    if (extra !== undefined) return extra;
    const marked = observed[0];
    if (marked !== undefined && marked !== "code")
      return marked === "password"
        ? ("password_rejected" as const)
        : ("username_rejected" as const);
    return due ? yield* returnedCredential(session) : undefined;
  });

/**
 * A saved security answer the site refused: after the sign-in failed, the screen that took it
 * shows its question again after a submit clicked on it sent the answer. A host that keeps saved
 * answers flags it (`hosted.refuseShownAnswer`), so no later sign-in types it.
 */
const refuseShownAnswer = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  session: ReplaySession<E, V, L>,
) =>
  Effect.suspend(
    () => session.input.hosted?.refuseShownAnswer?.(session.progress.ran) ?? Effect.void,
  );

/**
 * Whether the login went out cleanly: every credential stage actually run was submitted after its
 * fill, and no rejection marker shows.
 */
const sentCleanly = <E extends YieldableError, V extends string, L extends AutofillLogin>(session: ReplaySession<E, V, L>) =>
  Effect.gen(function* () {
    settleCarried(session);
    const required = session.progress.ran
      .flatMap((step) => step.fields)
      .filter((field) => isIdentifier(field.slot) || provesLogin(field.slot));
    if (required.some((field) => !session.state.submittedSlots.has(field.slot))) return false;
    const rejected = yield* session.observeRejections;
    return rejected !== "unavailable" && rejected.length === 0;
  });

/** Whether the last screen that took a security answer shows its field again: the site refused it. */
const answerShownAgain = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  session: ReplaySession<E, V, L>,
) =>
  Effect.gen(function* () {
    const step = session.progress.ran.findLast((ran) =>
      ran.fields.some((field) => field.slot === "private_answer"),
    );
    const field = step?.fields.find((candidate) => candidate.slot === "private_answer");
    if (step === undefined || field === undefined) return false;
    const shown = yield* session.hooks.inspect({
      fields: [field],
      ...(step.popup === undefined ? {} : { popup: step.popup }),
    });
    return !("outcome" in shown);
  });

/**
 * Whether the replay, its login sent cleanly and no security question shown again, ended on a page
 * that can't tell: `here`, the check the caller already holds, else the page as it is now. The host
 * checks the identifiers it sent (`confirmCantTell`), binding nothing until the operation
 * succeeds; a host without that hook fails the sign-in as before.
 */
const endedCantTell =
  <E extends YieldableError, V extends string, L extends AutofillLogin>(session: ReplaySession<E, V, L>) =>
  (here?: AutofillSignedInCheck) =>
  Effect.gen(function* () {
    const confirmCantTell = session.hooks.confirmCantTell;
    if (confirmCantTell === undefined || !(yield* sentCleanly(session))) return false;
    if (yield* answerShownAgain(session)) return false;
    const onScreens = (page: string) =>
      session.recipe.steps.some((step) => session.matchesRecorded(page, step));
    const recorded = { signedIn: session.recipe.signedIn, steps: session.resolvedSteps() };
    if (!cantTell(here ?? (yield* session.checkHere), recorded, onScreens)) return false;
    yield* confirmCantTell(session.state.sentIdentifiers);
    return true;
  });

/** Confirms only after every credential stage actually run was submitted after its fill. */
const verifySignIn =
  <E extends YieldableError, V extends string, L extends AutofillLogin>(session: ReplaySession<E, V, L>) =>
  (indicator: AutofillRecipe["signedIn"]) =>
  Effect.gen(function* () {
    if (!(yield* sentCleanly(session))) return false;
    const at = yield* checkOrigin(session);
    const confirmed = yield* session.hooks.confirm(
      indicator,
      session.state.sentIdentifiers,
      session.recipe.steps,
      session.state.steps,
      at === undefined
        ? undefined
        : { origin: at.origin, ...(at.pin === undefined ? {} : { workspace: at.pin }) },
    );
    // The check and the login's identity verification passed on the workspace origin: the run
    // goes on there, and when this sign-in explains it, it is the login's and the confirm pinned it.
    if (confirmed.signedIn && at !== undefined) {
      session.progress.checkedOn = at.origin;
      if (at.pin !== undefined) session.progress.workspace = at.pin;
    }
    return confirmed.signedIn;
  });

/**
 * Where the signed-in check of a tool with a workspace relation reads the site's marker, and the
 * workspace origin its passing check pins: the host this replay admitted; else the page's own
 * host when it passes the gates and the login has none pinned, it is the pinned one, or this
 * replay sent the login on the shared sign-in (the site moved the workspace); else the pinned
 * one. Never a host page content alone points to: the site navigated there during this sign-in.
 * Only a host this sign-in explains is pinned (`workspaceToPin`): a session that merely shows an
 * unpinned workspace host runs its check there but never makes it the login's. Undefined keeps
 * the tool's site, as for a tool without a relation.
 */
const checkOrigin = <E extends YieldableError, V extends string, L extends AutofillLogin>(session: ReplaySession<E, V, L>) =>
  Effect.gen(function* () {
    const workspace = session.input.workspace;
    if (workspace === undefined) return undefined;
    const { progress } = session;
    const checked = yield* session.checkHere;
    const context = {
      siteOrigin: workspace.siteOrigin,
      relation: { parent: workspace.parent },
      pinned: workspace.pinned,
      candidate: progress.workspace !== workspace.pinned ? progress.workspace : undefined,
      current: URL.parse(checked.url ?? "")?.origin,
      credentialsSent: progress.exactSent.credentials,
    };
    const origin = signedInCheckOrigin(context);
    if (!workspaceHost(workspace.siteOrigin, workspace.parent, origin)) return undefined;
    const pin = workspaceToPin(context);
    if (pin !== undefined && workspace.pinned !== undefined && pin !== workspace.pinned)
      yield* workspace.observe({ kind: "changed", origin: pin });
    return { origin, pin };
  });
export const makeReplay = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
) => {
  const session = makeReplaySession(input);
  const run = (
    asked: AutofillStep,
    inspection: AutofillInspection,
    codeAgain?: "rejected",
    explicitCodeRejection = false,
    corrected: ReadonlySet<AutofillSlot> = new Set(),
    planned: readonly AutofillSecret[] = [],
  ) =>
    runReplayStep(session, asked, inspection, codeAgain, explicitCodeRejection, corrected, planned);
  const extras = (observed: readonly RejectedMarker["slot"][]) =>
    correctReplayExtras(session, run, observed);
  return {
    /** The run holds none of the login's values: this replay is its value-free sign-in check. */
    valueFree: input.credentials === undefined,
    timing: session.timing,
    state: session.state,
    sent: session.sent,
    firstCause: session.firstCause,
    progress: session.progress,
    outcome: session.outcome,
    indicatorShown: session.indicatorShown,
    checkHere: session.checkHere,
    /** Whether a page (origin and path) is one of the recorded screens, as this replay knows them. */
    onScreens: (page: string) =>
      input.recipe.steps.some((step) => session.matchesRecorded(page, step)),
    matchesRecorded: session.matchesRecorded,
    resolvedSteps: session.resolvedSteps,
    sibling: session.sibling,
    /** The origins the recorded screens ran on: where a sign-in screen can be. */
    signInOrigins: () =>
      new Set(session.resolvedSteps().flatMap((step) => URL.parse(step.page)?.origin ?? [])),
    onPage: session.onPage,
    awaitScreen: makeReplayScreenWait(
      input,
      session.progress,
      session.timing,
      (request) => session.values.resolve(request, input.credentials),
      (due) => screenRejection(session, extras, due),
      input.hosted?.resubmit?.(session) ?? ((gate) => gate),
      {
        onScreens: (page) => input.recipe.steps.some((step) => session.matchesRecorded(page, step)),
        matches: session.matchesRecorded,
      },
    ),
    runStep: run,
    verify: verifySignIn(session),
    endedCantTell: endedCantTell(session),
    observeRejections: session.observeRejections,
    recordRejected: session.recordRejected,
    correctExtras: extras,
    resolve: (request: AutofillStepRequest) => session.values.resolve(request, input.credentials),
    shownAgain: (slot: AutofillSecret) =>
      shownAgain(session.hooks, session.progress.ran, session.sent.maySent, slot),
    refuseShownAnswer: refuseShownAnswer(session),
    pickMethod: (methods: NonNullable<AutofillRecipeStep["methods"]>) =>
      pickMethod(input, methods),
  };
};
export type Replay<
  E extends YieldableError = YieldableError,
  V extends string = string,
  L extends AutofillLogin = AutofillLogin,
> = ReturnType<typeof makeReplay<E, V, L>>;

/**
 * The workspace origin a passing check verified for a tool with a workspace relation: the login's
 * own when this sign-in explains it (`workspaceToPin`), else one the run only goes on at.
 */
export const workspaceOf = <E extends YieldableError, V extends string, L extends AutofillLogin>(replay: Replay<E, V, L>) => {
  const at = replay.progress.checkedOn;
  if (at === undefined) return {};
  return at === replay.progress.workspace ? { workspaceOrigin: at } : { unpinnedWorkspace: at };
};

/**
 * Nothing was sent and the indicator shows: the saved profile was already this login's. A sign-in
 * that may end on a page that can't tell is already signed in on one too, off every recorded screen
 * and the entry page, as a later run's is when the site's login page sends its saved session to an
 * account picker: the marker wait's page (`cantTellHere`), else the page the full check left.
 */
export const alreadySignedIn = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  cantTellHere: AutofillSignedInCheck | undefined,
) =>
  Effect.gen(function* () {
    const mayCantTell = input.hooks.confirmCantTell !== undefined;
    const recorded = { signedIn: input.recipe.signedIn, steps: replay.resolvedSteps() };
    const offSignIn = (check: AutofillSignedInCheck) =>
      mayCantTell &&
      cantTell(check, recorded, replay.onScreens) &&
      leftSignInScreens(replay.onScreens, input.entryUrl, check.url);
    const signedIn = { outcome: "signed_in", alreadySignedIn: true } as const;
    if (cantTellHere !== undefined && offSignIn(cantTellHere))
      return { ...signedIn, cantTell: true } as const;
    if (yield* replay.verify(input.recipe.signedIn)) return { ...signedIn, ...workspaceOf(replay) };
    if (mayCantTell && offSignIn(yield* replay.checkHere))
      return { ...signedIn, cantTell: true } as const;
    return replay.outcome("indicator_not_visible");
  });
