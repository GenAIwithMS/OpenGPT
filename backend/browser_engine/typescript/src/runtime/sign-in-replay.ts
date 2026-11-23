import { Data, Effect } from "effect";
import type { AutofillPopup } from "../destinations/autofill-contracts.js";
import type { AutofillSignedInCheck } from "../destinations/autofill-step.js";
import { type MarkerSettle, settledMarkerCheck } from "../destinations/marker-settle.js";
import {
  decodeSignInRecipe,
  type SignInBrowser,
  type SignInLogin,
  type SignInRecipe,
} from "../destinations/sign-in-recipe.js";
import type { CredentialRejectedField, WebsiteCredentials } from "./authentication.js";
import {
  askCredentialCorrection,
  correctedReplayCredentials,
  makeAutofillRetryState,
  resetAutofillRetryState,
} from "./autofill-correction.js";
import { replayAutofillRecipe } from "./autofill-replay.js";
import type {
  AutofillReplayOutcome,
  AutofillReplayTiming,
  AutofillRetryState,
} from "./autofill-replay-steps.js";
import type { ReplayWorkspace } from "./autofill-replay-workspace.js";
import type { AutofillHooks, SecretBroker } from "./autofill-state.js";
import { typedValues } from "./autofill-values.js";
import { logicalRejectedField } from "./autofill-rejection.js";
import type { InputAsker } from "./input-request.js";
import { makeRunLogin } from "./run-login.js";
import { trustedUrl } from "./sign-in-origins.js";
import { entryNamesAddress, pinnedWorkspaceOrigin, workspaceRelation } from "./workspace-origin.js";

// A run's sign-in on the local host: the shared replay with the local browser, login and asks.

const spoken = (reason: string | undefined) => (reason ?? "login").replaceAll("_", " ");
const runFailureMessages = {
  CredentialsRejected: (reason: string | undefined) =>
    `The website rejected the ${spoken(reason)} given for this sign-in, and the run sends it no more. Run the tool again with the right value.`,
  NeedsInput: () =>
    "The sign-in needs an answer that was not given, so the run stopped before the tool ran.",
  RecipeFailed: (reason: string | undefined) =>
    `The saved sign-in no longer matches the website (${spoken(reason)}). Build the tool again to record its sign-in.`,
  MissingRecipe: (reason: string | undefined) =>
    `The tool's saved sign-in can't be read (${spoken(reason)}), so the tool doesn't run signed out. Build the tool again.`,
} as const;
/** Advice for a reason that is no fault of the recipe or of a value given. */
const reasonMessages = new Map([
  [
    "workspace_unverified",
    "The sign-in opened a workspace of the website that this login had not signed in to, so nothing was typed and the run stopped before the tool ran. Sign out of the website in this browser, or clear its data for the site, then run the tool again.",
  ],
  [
    "entry_page_unavailable",
    "The sign-in page didn't load, so the run stopped before the tool ran. Check that the website is reachable, then run the tool again.",
  ],
]);

/** Why a run could not sign in, value-free. The run fails with it and never runs signed out. */
export class SignInRunFailed extends Data.TaggedError("SignInRunFailed")<{
  /**
   * `CredentialsRejected`: the site rejected a value given for the sign-in, once its corrections
   * ran out or for a value that is never corrected. `NeedsInput`: a question the sign-in needs
   * went unanswered. `RecipeFailed`: the recorded sign-in no longer matches the site, or its
   * entry page did not load. `MissingRecipe`: the integration's recipe cannot be read.
   */
  readonly code: "CredentialsRejected" | "NeedsInput" | "RecipeFailed" | "MissingRecipe";
  /** A finite reason: the rejected field, the replay's reason, or why the recipe is unreadable. */
  readonly reason?: string;
}> {
  override get message() {
    return reasonMessages.get(this.reason ?? "") ?? runFailureMessages[this.code](this.reason);
  }
}

/** The browser a run's sign-in replays on: the recorder's, which also opens and reads markers. */
export interface SignInReplayBrowser<E> extends SignInBrowser<E> {
  /** Opens the recipe's entry page on the run's tab. */
  readonly open: (url: string) => Effect.Effect<void, E>;
  /** Whether a recorded rejection marker shows on its screen's page, never what it says. */
  readonly markerVisible: (
    selector: string,
    page: string,
    popup?: AutofillPopup,
  ) => Effect.Effect<boolean, E>;
  /**
   * The number a device approval's screen shows for the owner to pick on their device
   * (`AutofillHooks.approvalNumber`). A browser without it asks for the approval with no number.
   */
  readonly approvalNumber?: (
    selector: string,
    page: string,
    popup?: AutofillPopup,
  ) => Effect.Effect<string | undefined, E>;
  /**
   * Clears the browser's data for the site, once, after a replay found another workspace's
   * sign-in before this login sent anything (`workspace_unverified`). A host without it fails
   * the run at the first such refusal.
   */
  readonly clearSiteData?: () => Effect.Effect<void, E>;
}

/**
 * A private workspace event: `relearned` when this replay admitted another workspace than the
 * pinned one, `unrecognized_sibling` when it refused a live screen on another host of the site.
 * Each names an origin, so a host keeps it private and reports a refusal only by its role.
 */
export type WorkspaceOriginEvent =
  | { readonly kind: "relearned"; readonly from: string; readonly to: string }
  | { readonly kind: "unrecognized_sibling"; readonly origin: string };

/** What the local host masks: each value a sign-in types, and a text checked for one. */
export interface RunSignInSecrets {
  readonly register: (value: string) => void;
  readonly assertAbsent: (text: string) => Effect.Effect<void, unknown>;
}

/** A browser call that failed, carried through the shared replay to the run as it failed. */
class ReplayBrowserFailed<E> extends Data.TaggedError("ReplayBrowserFailed")<{
  readonly error: E;
}> {}

type ReplayFailure<E> = SignInRunFailed | ReplayBrowserFailed<E>;

/**
 * The shared replay's page hooks over the local browser: `check` reads the marker once, `confirm`
 * waits for a marker drawn late (`settledMarkerCheck`), and a read's sign-in may end on a page that
 * can't tell (`confirmCantTell`). An entry page that does not load fails `entry_page_unavailable`.
 * Every sign-in sets `startedEmpty`, so a check without values never ends on a login entry that
 * can't tell. The engine reads `pageState` only for that, so none is given.
 */
const replayHooks = <E>(
  browser: SignInReplayBrowser<E>,
  allowCantTell: boolean,
  settle: MarkerSettle | undefined,
): AutofillHooks<ReplayFailure<E>> => {
  const failed = (error: E) => new ReplayBrowserFailed({ error });
  const checkOn: AutofillHooks<ReplayFailure<E>>["confirm"] = (
    indicator,
    _identifiers,
    screens,
    challengeScreens,
    at,
  ) =>
    settledMarkerCheck(
      (shown) =>
        browser
          .confirm(shown, screens, challengeScreens ?? screens, at?.origin)
          .pipe(Effect.mapError(failed)),
      indicator,
      settle,
    );
  const readNumber = browser.approvalNumber;
  return {
    inspect: (step) => browser.inspect(step).pipe(Effect.mapError(failed)),
    // One-character code boxes take the code one character each, as the host types it.
    fill: (input) => browser.fill({ ...input, values: typedValues(input.step, input.values) }),
    check: (indicator, screens, challengeScreens, at) =>
      browser.confirm(indicator, screens, challengeScreens ?? screens, at?.origin).pipe(
        Effect.catchAll(() =>
          Effect.succeed<AutofillSignedInCheck>({ signedIn: false, failed: "page_unavailable" }),
        ),
      ),
    confirm: checkOn,
    open: (url) =>
      browser
        .open(url)
        .pipe(
          Effect.mapError(
            () => new SignInRunFailed({ code: "RecipeFailed", reason: "entry_page_unavailable" }),
          ),
        ),
    markerVisible: (selector, screenPage, popup) =>
      browser.markerVisible(selector, screenPage, popup).pipe(Effect.mapError(failed)),
    ...(readNumber === undefined
      ? {}
      : {
          approvalNumber: (selector: string, screenPage: string, popup?: AutofillPopup) =>
            readNumber.call(browser, selector, screenPage, popup).pipe(Effect.mapError(failed)),
        }),
    ...(allowCantTell ? { confirmCantTell: () => Effect.void } : {}),
    startedEmpty: true,
  };
};

/** The local masking as the shared sign-in code's broker, for runs and builds. */
export const localSecretBroker = (secrets: RunSignInSecrets): SecretBroker => ({
  register: (entry) => Effect.sync(() => secrets.register(entry.value)),
  registeredSecretMatches: (text) =>
    Effect.either(secrets.assertAbsent(text)).pipe(
      Effect.map((found) => (found._tag === "Left" ? [found.left] : [])),
    ),
});

/**
 * Where the replay may sign in besides the recorded exact pages, for a recipe whose workspace
 * relation is valid for the run's site: the login's pinned workspace origin, and the events that
 * name the workspace hosts it admitted or refused.
 */
const replayWorkspace = <E>(
  recipe: SignInRecipe,
  siteOrigin: string,
  pinnedOrigin: string | undefined,
  onEvent: ((event: WorkspaceOriginEvent) => void) | undefined,
): ReplayWorkspace<E> | undefined => {
  const relation = workspaceRelation(recipe, siteOrigin);
  if (relation === undefined) return undefined;
  const pinned = pinnedWorkspaceOrigin(siteOrigin, relation, pinnedOrigin);
  let known = pinned;
  return {
    siteOrigin,
    parent: relation.parent,
    pinned,
    observe: (event) =>
      Effect.sync(() => {
        if (event.kind === "refused")
          onEvent?.({ kind: "unrecognized_sibling", origin: event.origin });
        else if (known !== undefined && known !== event.origin)
          onEvent?.({ kind: "relearned", from: known, to: event.origin });
        if (event.kind !== "refused") known = event.origin;
      }),
  };
};

const rejected = (field: string) =>
  new SignInRunFailed({ code: "CredentialsRejected", reason: field });

type Correct = (
  field: CredentialRejectedField,
  held: WebsiteCredentials,
  triesLeft: number,
) => Effect.Effect<WebsiteCredentials, SignInRunFailed>;

/**
 * A corrected login for the rejected `fields` of `held`, at most twice per field, saying how many
 * tries are left; a correction that repeats a rejected value is asked again within those tries.
 */
const correctedLogin = (
  fields: readonly CredentialRejectedField[],
  held: WebsiteCredentials,
  retryState: AutofillRetryState,
  correct: Correct,
) =>
  askCredentialCorrection({
    fields,
    credentials: held,
    rejectedValues: {
      username: (retryState.rejectedValues.username ??= new Set()),
      password: (retryState.rejectedValues.password ??= new Set()),
    },
    correctionRequests: retryState.correctionRequests,
    reject: rejected,
    ask: (triesLeft) =>
      correct(fields[0] ?? "password", held, triesLeft).pipe(
        Effect.map((credentials) => ({ credentials })),
      ),
  }).pipe(Effect.map((corrected) => correctedReplayCredentials(held, corrected.credentials)));

/**
 * The part of `held` an earlier sign-in of this run had rejected, which no sign-in types again
 * until a sign-in verifies.
 */
const rejectedBefore = (
  held: WebsiteCredentials,
  retryState: AutofillRetryState,
): CredentialRejectedField | undefined => {
  if (held.password !== undefined && retryState.rejectedValues.password?.has(held.password))
    return "password";
  return retryState.rejectedValues.username?.has(held.username) ? "username" : undefined;
};

/**
 * A replay that did not sign in with the login: a rejected username or password asks for a
 * corrected login, at most twice per field, saying how many tries are left, and never sends a
 * rejected value again; any other reason fails the run.
 */
const afterRejection = (
  replayed: Exclude<AutofillReplayOutcome, { readonly outcome: "signed_in" }>,
  held: WebsiteCredentials,
  retryState: AutofillRetryState,
  correct: Correct,
) =>
  Effect.gen(function* () {
    const { reason } = replayed;
    if (reason === "code_rejected") return yield* rejected("code");
    if (reason === "extra_rejected")
      return yield* rejected(replayed.rejectedFields?.[0] ?? "password");
    if (reason !== "password_rejected" && reason !== "username_rejected")
      return yield* new SignInRunFailed({ code: "RecipeFailed", reason });
    const observed = replayed.rejectedFields ?? [
      reason === "username_rejected" ? "username" : "password",
    ];
    const paired = observed.filter(
      (field) =>
        field === "password" ||
        logicalRejectedField(field, held.primaryIdentifierKind) === "username",
    );
    if (paired.length === 0) return yield* rejected(observed[0] ?? "password");
    return yield* correctedLogin(paired, held, retryState, correct);
  });

/** Why a value the sign-in needed was not given, as the run reports it. */
const unanswered = (_cause: unknown, field?: string) =>
  new SignInRunFailed({ code: "NeedsInput", reason: field ?? "sign_in_value" });

/**
 * Signs a run in with the integration's recipe before its operation runs, on the shared replay. It
 * first replays without values and asks nothing when the session already shows signed in.
 * Otherwise it reads the login once (`login`), replays with it, asking the owner (`ask`) for any
 * code, date of birth, ZIP or security answer the screens need, and corrects a rejected username
 * or password at most twice per field, never sending a rejected value again, in this sign-in or in
 * a later one sharing its `retryState`. Values stay in memory for the run. A recipe it cannot read fails `MissingRecipe`, and an entry page off the site fails
 * before anything opens, as does, for a recipe with a workspace relation, one whose query or
 * fragment names another address (`entryNamesAddress`).
 *
 * A recipe with a workspace relation may sign in on the login's own workspace host
 * (`workspaceOrigin`, the one pinned to the login, or one this run learns), and the result names
 * the workspace origin to pin, only one this login's own sign-in explains. A replay that finds
 * another workspace's sign-in before this login sent anything (`workspace_unverified`) clears the
 * site's data and starts again once, when the browser can, and otherwise fails the run.
 */
export const signInForRun = <E>(input: {
  readonly recipe: SignInRecipe;
  readonly entryUrl: string;
  readonly browser: SignInReplayBrowser<E>;
  /** The owner's login; a login question left unanswered fails the run `NeedsInput`. */
  readonly login: SignInLogin<unknown>;
  /** Asks the owner for what the screens need besides the login. */
  readonly ask: InputAsker;
  /** Masks each value the sign-in types before any screen can send it. */
  readonly secrets: RunSignInSecrets;
  /** The site as a question names it. */
  readonly site: string;
  /** The site the run is authorized for, which the entry page must be on. */
  readonly siteOrigin: string;
  readonly timing?: AutofillReplayTiming;
  /** How long a check waits for a marker drawn late; `markerSettle` unless a test shortens it. */
  readonly markerSettle?: MarkerSettle;
  /** The login's pinned workspace origin, ignored unless it passes `workspaceHost`. */
  readonly workspaceOrigin?: string;
  /** Hears each replay's private workspace events. */
  readonly onWorkspaceEvent?: (event: WorkspaceOriginEvent) => void;
  /** Whether a page that can't tell signs it in, as a read's may. */
  readonly allowCantTell?: boolean;
  /**
   * The values the site rejected and the corrections asked, kept across the sign-ins of one run;
   * a new one by default. A verified sign-in clears it.
   */
  readonly retryState?: AutofillRetryState;
}): Effect.Effect<
  { readonly alreadySignedIn: boolean; readonly workspaceOrigin?: string },
  E | SignInRunFailed
> =>
  Effect.gen(function* () {
    const recipe = decodeSignInRecipe(JSON.stringify(input.recipe) ?? "");
    if (recipe === "invalid" || recipe === "unknown_version")
      return yield* new SignInRunFailed({ code: "MissingRecipe", reason: recipe });
    if (!trustedUrl(input.siteOrigin, input.browser.authenticationOrigins, input.entryUrl))
      return yield* new SignInRunFailed({ code: "RecipeFailed", reason: "entry_off_site" });
    // A recipe whose sign-in may move to a per-account workspace host opens no login URL that
    // names another address: the site could send every account on to a host the URL chose.
    const relation = workspaceRelation(recipe, input.siteOrigin);
    if (relation !== undefined && entryNamesAddress(input.entryUrl, relation.parent))
      return yield* new SignInRunFailed({ code: "RecipeFailed", reason: "entry_names_address" });
    const loginUnanswered = () => new SignInRunFailed({ code: "NeedsInput", reason: "login" });
    const runLogin = yield* makeRunLogin({
      held: input.login.held(),
      passwordless: false,
      read: input.login.values.pipe(Effect.mapError(loginUnanswered)),
      register: () => Effect.void,
    });
    const correct = (field: CredentialRejectedField, held: WebsiteCredentials, triesLeft: number) =>
      input.login.correct(field, held, triesLeft).pipe(Effect.mapError(loginUnanswered));
    const retryState = input.retryState ?? makeAutofillRetryState();
    const hooks = replayHooks(input.browser, input.allowCantTell === true, input.markerSettle);
    const broker = localSecretBroker(input.secrets);
    const given = { current: {} };
    let held = runLogin.held();
    let cleared = false;
    while (true) {
      // A login an earlier sign-in of this run had rejected is corrected before anything is typed.
      const before = held === undefined ? undefined : rejectedBefore(held, retryState);
      if (held !== undefined && before !== undefined) {
        held = yield* correctedLogin([before], held, retryState, correct);
        runLogin.hold(held);
      }
      const workspace = replayWorkspace<ReplayFailure<E>>(
        recipe,
        input.siteOrigin,
        input.workspaceOrigin,
        input.onWorkspaceEvent,
      );
      const replayed = yield* Effect.scoped(
        replayAutofillRecipe({
          recipe,
          hooks,
          entryUrl: input.entryUrl,
          credentials: held,
          retryState,
          ask: input.ask,
          answers: { given },
          broker,
          site: input.site,
          correlation: undefined,
          emit: () => Effect.void,
          failures: {
            unanswered,
            unavailable: (_operation, detail) =>
              new SignInRunFailed({
                code: "NeedsInput",
                reason:
                  typeof detail.context?.["check"] === "string"
                    ? detail.context["check"]
                    : "sign_in_value",
              }),
          },
          sent: { current: false },
          ...(workspace === undefined ? {} : { workspace }),
          ...(input.timing === undefined ? {} : { timing: input.timing }),
        }),
      ).pipe(
        Effect.catchTag("ReplayBrowserFailed", (failure) => Effect.fail(failure.error)),
      );
      if (replayed.outcome === "signed_in") {
        resetAutofillRetryState(retryState);
        return {
          alreadySignedIn: replayed.alreadySignedIn,
          ...(replayed.workspaceOrigin === undefined
            ? {}
            : { workspaceOrigin: replayed.workspaceOrigin }),
        };
      }
      // Another workspace's sign-in before this login sent anything: leftover cookies or a link.
      // The site's data is cleared and the entry reopened once; a second refusal fails the run.
      if (replayed.reason === "workspace_unverified") {
        if (cleared || input.browser.clearSiteData === undefined)
          return yield* new SignInRunFailed({ code: "RecipeFailed", reason: replayed.reason });
        cleared = true;
        yield* input.browser.clearSiteData();
        continue;
      }
      // The value-free check did not find the session signed in: the login is read once, and the
      // sign-in replays again from the entry page.
      if (held === undefined) {
        held = yield* runLogin.values;
        continue;
      }
      held = yield* afterRejection(replayed, held, retryState, correct);
      runLogin.hold(held);
    }
  });
