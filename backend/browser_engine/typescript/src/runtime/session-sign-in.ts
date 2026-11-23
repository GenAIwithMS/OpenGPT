import { Clock, Effect, Schema } from "effect";
import type {
  AutofillInspection,
  AutofillRefusal,
  AutofillSignedInCheck,
  AutofillStep,
  AutofillStepReport,
} from "../destinations/autofill-step.js";
import { pageMatches } from "../destinations/autofill-recipe.js";
import { failureDetail, type FailureDetail } from "./failure-detail.js";
import {
  InputRequestFailure,
  maximumInputWaitMs,
  type InputAsker,
} from "./input-request.js";

// A host's automatic sign-in on the browser an operation holds: the rules for when the page reads
// signed out, how many sign-ins an attempt may make, and the bound no step of a sign-in made while
// a script waits may pass. A host supplies the sign-in itself as `SessionSignInHook`.

/**
 * Why the host signed a page in again by itself, as it records each automatic sign-in: the page
 * was signed out when the operation started, or became signed out while it ran.
 */
export type AutomaticSignInCause = "signed_out_at_start" | "signed_out_mid_operation";

/**
 * How many automatic sign-ins the host makes when a signed-in page turns out signed out. They
 * never spend the model's relogin. A mint makes at most one per check and four per attempt
 * (examples, tests, the first write and publication reruns); a run at most three per try and four
 * per attempt.
 */
export const mintSessionSignIns = { perAttempt: 4, perScope: 1 } as const;
export const runSessionSignIns = { perAttempt: 4, perScope: 3 } as const;

export interface SessionSignInLimits {
  readonly perAttempt: number;
  /** Per mint check, or per run try. */
  readonly perScope: number;
}

export interface SessionSignInsSpent {
  readonly attempt: number;
  readonly scope: number;
}

/** Whether one more automatic sign-in fits, else why the session is not kept. */
export const sessionSignInAllowance = (
  limits: SessionSignInLimits,
  spent: SessionSignInsSpent,
): "allowed" | "session_not_kept" =>
  spent.attempt < limits.perAttempt && spent.scope < limits.perScope
    ? "allowed"
    : "session_not_kept";

/** A path without its trailing slash, the root `/` kept. */
export const pathOf = (path: string) => (path.length > 1 ? path.replace(/\/$/u, "") : path);

/**
 * A page's origin and path, the path as `pathOf` gives it, as recorded screens compare pages: a
 * signed-out page lands back on its screen's. Undefined for no page or one that is not an absolute
 * URL, such as a workspace screen's path.
 */
export const placeOf = (page: string | undefined) => {
  if (page === undefined) return undefined;
  const url = URL.parse(page);
  return url === null ? undefined : `${url.origin}${pathOf(url.pathname)}`;
};

/** Whether the page is one of the recorded sign-in screens (`pageMatches`). */
const onSignInScreen = (url: string | undefined, steps: SessionCheckRecipe["steps"]) =>
  url !== undefined && steps.some((step) => pageMatches(url, step));

const markerFailure = (failed: string) =>
  failed === "indicator_not_visible" ||
  failed === "path_mismatch" ||
  failed === "password_field_visible";

/**
 * A marker that names a path reads signed out only on that path. A missing marker matches the path
 * with or without a trailing slash. A marker that showed (`path_mismatch`) matches only the exact
 * path, since the sign-in check compares paths exactly: on a path that differs only by a trailing
 * slash the page may well be signed in, so it says nothing.
 */
const onMarkerPath = (url: string | undefined, urlPath: string, failed: string) => {
  const here = url === undefined ? undefined : URL.parse(url)?.pathname;
  if (here === undefined) return "unknown" as const;
  const same = failed === "path_mismatch" ? here === urlPath : pathOf(here) === pathOf(urlPath);
  return same ? ("signed_out" as const) : ("unknown" as const);
};

/** What a session check reads of a recorded sign-in: its screens and its marker's path. */
export interface SessionCheckRecipe {
  readonly steps: readonly {
    readonly page: string;
    readonly anySegments?: readonly number[] | undefined;
  }[];
  readonly signedIn: { readonly urlPath?: string | undefined };
}

/**
 * What the marker check on the current page says about the session. A missing marker alone can't
 * tell: a site may show a screen of its own between its sign-in and its pages, such as an account
 * or workspace picker, a "remember this device" prompt or its terms, and show the marker only past
 * it. So a page reads signed out only on the sign-in's own evidence:
 * - a marker that names a path, missing on that path. Elsewhere it says nothing, the password
 *   field included (a site's login page may show its form to a signed-in browser too);
 * - a marker that names no path, missing where the sign-in's own password field shows again or
 *   on one of the recorded sign-in screens;
 * - an off-site page that is one of the recorded sign-in screens (a sign-in origin the site sends
 *   to).
 * A page the check could not read, an unsupported selector or a recorded challenge that still
 * shows says nothing either.
 */
export const sessionOnPage = (
  check: AutofillSignedInCheck,
  recipe: SessionCheckRecipe,
): "signed_in" | "signed_out" | "unknown" => {
  if (check.signedIn) return "signed_in";
  const signInScreen = onSignInScreen(check.url, recipe.steps);
  if (check.failed === "off_site") return signInScreen ? "signed_out" : "unknown";
  if (!markerFailure(check.failed)) return "unknown";
  const { urlPath } = recipe.signedIn;
  if (urlPath !== undefined) return onMarkerPath(check.url, urlPath, check.failed);
  const formShown = check.failed === "password_field_visible" || check.passwordFieldVisible === true;
  return formShown || signInScreen ? "signed_out" : "unknown";
};

/**
 * Whether the page a sign-in ended on can't tell, once the sign-in sent every value it filled and
 * no rejection showed: the check read the page, found the marker missing or the page off the site,
 * and `sessionOnPage` does not read it signed out. A check with no address says nothing of where
 * the sign-in ended, so it is no can't tell. A sign-in that ends on one of its own recorded
 * screens, or where its password field shows, did not get past them, whatever path the marker
 * names. A sign-in that can't tell counts as signed in, and the operation that runs next proves it.
 */
export const markerCantTell = (check: AutofillSignedInCheck, recipe: SessionCheckRecipe) =>
  !check.signedIn &&
  check.url !== undefined &&
  (check.failed === "indicator_not_visible" ||
    check.failed === "path_mismatch" ||
    check.failed === "off_site") &&
  check.passwordFieldVisible !== true &&
  !onSignInScreen(check.url, recipe.steps) &&
  sessionOnPage(check, recipe) === "unknown";

/**
 * The host may fill a login into the browser of a running execution only while that execution
 * waits in its own `ensureSignedIn`, with the runtime holding its other browser calls; otherwise
 * only into a browser no execution can reach. Says why a fill into `browser` is refused, or
 * undefined when it may go ahead.
 */
export const executorBrowserRefusal = <Browser>(
  browser: Browser,
  executions: {
    /** The browser an execution was given and has not been confirmed stopped since. */
    readonly attached: Browser | undefined;
    /** The browser whose execution waits in its own `ensureSignedIn` right now. */
    readonly waitingInSignIn: Browser | undefined;
  },
): "run_sign_in_executor_attached" | undefined =>
  browser === executions.attached && browser !== executions.waitingInSignIn
    ? "run_sign_in_executor_attached"
    : undefined;

/**
 * Why the host could not leave the page signed in: `session_not_kept` once the attempt's
 * automatic sign-ins are spent, `session_sign_in_failed` when the recorded sign-in did not sign
 * in again (the host's own record says why).
 */
export const SessionSignInRefusal = Schema.Literal("session_not_kept", "session_sign_in_failed");
export type SessionSignInRefusal = typeof SessionSignInRefusal.Type;

/**
 * The end of an in-script sign-in's filling: its time (epoch milliseconds, the Effect clock) and
 * the stop raised once the script's execution exited, its answer's bound passed or its control
 * loop ended.
 */
export interface SessionSignInBound {
  readonly untilMs: number;
  readonly stop: AbortSignal;
}

/** The host's answer before it is addressed to one request. */
export type SessionSignInAnswer =
  | { readonly outcome: "signed_in"; readonly signedInAgain: boolean }
  | { readonly outcome: "refused"; readonly cause: SessionSignInRefusal };

/** The host's answer as it crosses a process boundary. */
export const SessionSignInAnswer = Schema.Union(
  Schema.Struct({ outcome: Schema.Literal("signed_in"), signedInAgain: Schema.Boolean }),
  Schema.Struct({ outcome: Schema.Literal("refused"), cause: SessionSignInRefusal }),
);

/**
 * A host's side of a script's `ensureSignedIn` (the runtime's `ScriptBrowser.signIn`): it makes
 * sure the job's page is still signed in, on the same browser, while the runtime holds the
 * script's other browser calls. No step of the sign-in starts after `bound.untilMs` or once
 * `bound.stop` is raised. The host checks first and types nothing on a page still signed in; it
 * types only the recorded sign-in and the caller's own answers, and answers `refused` whenever it
 * could not leave the page signed in.
 */
export type SessionSignInHook = (bound: SessionSignInBound) => Effect.Effect<SessionSignInAnswer>;

/**
 * The bounds of one in-script sign-in, each strictly inside the next, so the host never fills
 * after the runner could have stopped waiting and taken its browser back:
 * - filling: no step starts after it. It covers a caller's code (the input window) and the
 *   recorded screens' waits of a value-free replay and a replay with values, with a margin;
 * - answer: the host answers by then. A step that started just before the filling bound finishes
 *   (one fill or inspection), and past it the host stops the sign-in and refuses;
 * - settle: how long the host waits, once it stopped a sign-in, for its last step to end;
 * - the runner's wait: the answer bound and the settle, with a margin.
 */
export const sessionSignInFillMs = maximumInputWaitMs + 3 * 60_000;
export const sessionSignInAnswerMs = sessionSignInFillMs + 2 * 60_000;
export const sessionSignInSettleMs = 2 * 60_000;
export const sessionSignInWaitMs = sessionSignInAnswerMs + sessionSignInSettleMs + 60_000;

/** Whether the sign-in may no longer touch the page. */
export const sessionSignInExpired = (bound: SessionSignInBound) =>
  Clock.currentTimeMillis.pipe(Effect.map((now) => bound.stop.aborted || now >= bound.untilMs));

/** Why a step of a sign-in did not start: its bound passed. */
export const sessionSignInExpiredDetail = (): FailureDetail =>
  failureDetail("autofill_step_failed", {
    operation: "autofill.replay",
    phase: "automatic_sign_in",
    context: { outcome: "session_sign_in_expired" },
  });

/** The browser hooks of a sign-in that the bound gates. */
export interface BoundedSignInHooks<E> {
  readonly open: (url: string) => Effect.Effect<void, E>;
  readonly inspect: (step: AutofillStep) => Effect.Effect<AutofillRefusal | AutofillInspection, E>;
  readonly fill: (input: {
    readonly step: AutofillStep;
    readonly values: readonly string[];
    readonly inspection: AutofillInspection;
  }) => Effect.Effect<AutofillStepReport>;
}

/** The failure a host's hooks open a page with, which a step past the bound fails with too. */
type OpenFailure<Hooks> =
  Hooks extends { readonly open: (url: string) => Effect.Effect<void, infer E> } ? E : never;

/**
 * The browser hooks of a sign-in that runs while a script waits in `ensureSignedIn`, bounded at
 * each step's start: once the bound passed or the stop was raised, no page opens, no screen is
 * inspected and nothing is typed, so the host never fills after the script could have given up
 * and taken its browser back. A step already filling finishes; the next one never starts. An
 * open or inspection past the bound fails with the host's `expired` failure.
 */
export const boundedSignInHooks = <Hooks extends BoundedSignInHooks<unknown>>(
  hooks: Hooks,
  bound: SessionSignInBound,
  expired: (detail: FailureDetail) => OpenFailure<Hooks>,
): Hooks => {
  const gate = sessionSignInExpired(bound).pipe(
    Effect.flatMap((passed) =>
      passed ? Effect.fail(expired(sessionSignInExpiredDetail())) : Effect.void,
    ),
  );
  return {
    ...hooks,
    open: (url: string) => gate.pipe(Effect.zipRight(hooks.open(url))),
    inspect: (step: AutofillStep) => gate.pipe(Effect.zipRight(hooks.inspect(step))),
    fill: (input: Parameters<BoundedSignInHooks<unknown>["fill"]>[0]) =>
      Effect.flatMap(sessionSignInExpired(bound), (passed): Effect.Effect<AutofillStepReport> => {
        if (!passed) return hooks.fill(input);
        return Effect.succeed({
          outcome: "refused",
          reason: "typing_unavailable",
          failureDetail: sessionSignInExpiredDetail(),
        });
      }),
  };
};

/**
 * The caller's questions during that sign-in: none starts once the bound passed, and none waits
 * past it, so a code that arrives late is never typed.
 */
export const boundedSignInAsker = (ask: InputAsker, bound: SessionSignInBound): InputAsker =>
  Object.assign(
    (request: Parameters<InputAsker>[0], bounds?: Parameters<InputAsker>[1]) =>
      sessionSignInExpired(bound).pipe(
        Effect.flatMap((expired) =>
          expired
            ? Effect.fail(
                new InputRequestFailure({ code: "Unavailable", operation: "autofill.ask" }),
              )
            : ask(request, {
                ...bounds,
                sourceEndsAt: Math.min(bounds?.sourceEndsAt ?? bound.untilMs, bound.untilMs),
              }),
        ),
      ),
    ask.recoverSecrets === undefined ? {} : { recoverSecrets: ask.recoverSecrets },
  );

/**
 * The start check after a reset on the entry page: a sign-in, or a value-free check that found
 * the site still signed in, moved the page, so the entry page opens again (`reopen`). A fresh
 * sign-in that its load signs out again marks a session kept only in page memory
 * (`lostOnLoad`), which then starts where the sign-in left it. Returns whether the page is not
 * the entry page the script expects.
 */
export const signedInAtEntry = <E>(input: {
  /** One check of the current page and at most one sign-in when it reads signed out. */
  readonly ensureSignedIn: Effect.Effect<
    { readonly signedInAgain: boolean; readonly alreadySignedIn: boolean },
    E
  >;
  readonly reopen: Effect.Effect<void, E>;
  readonly lostOnLoad: { current: boolean };
}): Effect.Effect<boolean, E> =>
  Effect.gen(function* () {
    const first = yield* input.ensureSignedIn;
    if (!first.signedInAgain || (input.lostOnLoad.current && !first.alreadySignedIn))
      return first.signedInAgain;
    yield* input.reopen;
    // Still signed in: the entry page does not show the marker, so it says nothing more.
    if (first.alreadySignedIn) return false;
    // The check after the reopened entry page is the host's own, with its own sign-in.
    const again = yield* input.ensureSignedIn;
    if (again.alreadySignedIn) {
      yield* input.reopen;
      return false;
    }
    if (again.signedInAgain) input.lostOnLoad.current = true;
    return again.signedInAgain;
  });
