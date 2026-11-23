import { Data, Effect, Schema } from "effect";
import type { SignInLogin, SignInRecipe } from "../destinations/sign-in-recipe.js";
import { MintFailure } from "../mint/contracts.js";
import { CredentialRejectedField, type WebsiteCredentials } from "../runtime/authentication.js";
import { failureDetail } from "../runtime/failure-detail.js";
import type { InputAsker } from "../runtime/input-request.js";
import {
  boundedSignInAsker,
  boundedSignInHooks,
  runSessionSignIns,
  sessionOnPage,
  sessionSignInAllowance,
  sessionSignInExpired,
  type AutomaticSignInCause,
  type SessionSignInBound,
  type SessionSignInHook,
  type SessionSignInLimits,
  type SessionSignInRefusal,
} from "../runtime/session-sign-in.js";
import { makeAutofillRetryState } from "../runtime/autofill-correction.js";
import type { AutofillReplayTiming, AutofillRetryState } from "../runtime/autofill-replay-steps.js";
import {
  type RunSignInSecrets,
  signInForRun,
  SignInRunFailed,
  type SignInReplayBrowser,
} from "../runtime/sign-in-replay.js";
import { settledMarkerCheck } from "../destinations/marker-settle.js";
import { workspaceRelation } from "../runtime/workspace-origin.js";
import { localSignInLogin, makeSignInBrowser } from "./authentication.js";
import type { StandaloneSession } from "./session.js";

/** Why the local host could not leave the page signed in, and what failed. */
export class SessionSignInFailed extends Data.TaggedError("SessionSignInFailed")<{
  readonly refusal: SessionSignInRefusal;
  /** Why the page needed signing in again. */
  readonly trigger: AutomaticSignInCause;
  readonly reason: string;
  readonly failure?: unknown;
}> {}

/** A sign-in's bound passed before one of its steps could start. */
class SessionSignInExpiredStep extends Error {
  override readonly name = "SessionSignInExpired";
}

/**
 * An asker whose questions a sign-in under a bound may not start or wait past: `within` runs an
 * effect with every question asked through `ask` bounded by `bound`.
 */
export const makeBoundableAsk = (base: InputAsker) => {
  let bound: SessionSignInBound | undefined;
  const ask: InputAsker = Object.assign(
    (request: Parameters<InputAsker>[0], bounds?: Parameters<InputAsker>[1]) =>
      bound === undefined ? base(request, bounds) : boundedSignInAsker(base, bound)(request, bounds),
    base.recoverSecrets === undefined ? {} : { recoverSecrets: base.recoverSecrets },
  );
  const within = <A, E>(
    under: SessionSignInBound | undefined,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, E> =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        bound = under;
      }),
      () => effect,
      () =>
        Effect.sync(() => {
          bound = undefined;
        }),
    );
  return { ask, within };
};
export type BoundableAsk = ReturnType<typeof makeBoundableAsk>;

/** The part of a held login the site rejected: its identifier, as the username, or its password. */
type LoginField = "username" | "password";

/**
 * The part of the login a rejected field names. An identifier of any kind is the login's
 * username. A code, date of birth, ZIP or recovery code names none: those are asked fresh and
 * never held.
 */
const loginFieldOf = (field: string): LoginField | undefined => {
  if (field === "password") return "password";
  return field === "username" ||
    field === "email" ||
    field === "phone" ||
    field === "account_number"
    ? "username"
    : undefined;
};

/**
 * A login that a sign-in can mark as rejected. The values the site rejected are remembered, and
 * no sign-in sends them again, whether an automatic one or the build's own: while the login held
 * carries one, `login` holds none and its `values` asks for a correction. A correction that
 * repeats a rejected value is asked again once, and fails with `repeated` the second time.
 */
export const makeRejectableLogin = <E>(
  base: SignInLogin<E>,
  repeated: (field: CredentialRejectedField) => E,
) => {
  const rejectedValues = { username: new Set<string>(), password: new Set<string>() };
  /** The field of `login` that carries a value the site rejected, if any. */
  const repeats = (login: WebsiteCredentials): CredentialRejectedField | undefined => {
    if (login.password !== undefined && rejectedValues.password.has(login.password))
      return "password";
    return rejectedValues.username.has(login.username) ? "username" : undefined;
  };
  /** The part of the login the last correction asked for. */
  let corrected: LoginField | undefined;
  const correct = (field: CredentialRejectedField, held: WebsiteCredentials, triesLeft?: number) =>
    Effect.suspend(() => {
      corrected = loginFieldOf(field) ?? corrected;
      return base.correct(field, held, triesLeft);
    }).pipe(
      Effect.flatMap((answer) => {
        const again = repeats(answer);
        return again === undefined ? Effect.succeed(answer) : base.correct(again, answer);
      }),
      Effect.flatMap((answer) => {
        const again = repeats(answer);
        return again === undefined ? Effect.succeed(answer) : Effect.fail(repeated(again));
      }),
    );
  const login: SignInLogin<E> = {
    held: () => {
      const held = base.held();
      return held === undefined || repeats(held) !== undefined ? undefined : held;
    },
    values: Effect.suspend(() => {
      const held = base.held();
      const field = held === undefined ? undefined : repeats(held);
      return held === undefined || field === undefined ? base.values : correct(field, held);
    }),
    correct,
  };
  /** The site rejected the login held now, in `field`, its identifier or its password. */
  const reject = (field: LoginField) => {
    const held = base.held();
    if (held === undefined) return;
    if (field === "username") rejectedValues.username.add(held.username);
    if (field === "password" && held.password !== undefined)
      rejectedValues.password.add(held.password);
  };
  return {
    login,
    reject,
    /**
     * Marks the part of the held login a failed sign-in says the site rejected: its corrections
     * ran out, or the correction it asked for went unanswered.
     */
    failed: (failure: unknown) => {
      if (!(failure instanceof SignInRunFailed)) return;
      const field =
        failure.code === "CredentialsRejected"
          ? loginFieldOf(failure.reason ?? "")
          : // A login question goes unanswered with a login held only when it asked for a
            // correction, of the part the site rejected: the first question, answered, is what
            // holds one.
            failure.code === "NeedsInput" &&
              failure.reason === "login" &&
              login.held() !== undefined
            ? (corrected ?? "password")
            : undefined;
      if (field !== undefined) reject(field);
    },
  };
};
export type RejectableLogin<E> = ReturnType<typeof makeRejectableLogin<E>>;

type Failed = (
  refusal: SessionSignInRefusal,
  reason: string,
  failure?: unknown,
) => SessionSignInFailed;

/** A recorded sign-in to sign in again with: its recipe and its entry page. */
export interface RecordedSignIn {
  readonly recipe: SignInRecipe;
  readonly entryUrl: string;
}

/**
 * The workspace origin a run's sign-in learned for its login, held in memory for that run only:
 * the local host keeps no login between runs, so it pins nothing past one.
 */
export interface RunWorkspace {
  origin: string | undefined;
}

/**
 * The local host's automatic sign-in on the browser an operation holds. It checks the recorded
 * marker on the current page without moving it, and only when the page reads signed out does it
 * sign in again: first a check that types nothing (the recipe's account page, then a value-free
 * replay), then, within the allowance, `signInForRun` with the login already given, asking only
 * for what the screens need, and then it saves the session. Every step runs on `browser`, the
 * page the operation holds, and none starts once a script's bound passed.
 */
export const makeLocalSessionSignIn = (options: {
  readonly browser: SignInReplayBrowser<Error>;
  /** The sign-in to replay, once one was recorded and verified. */
  readonly recorded: () => RecordedSignIn | undefined;
  /**
   * The login the host already holds, read once per build or run; a build's marks what the site
   * rejected (`failed`).
   */
  readonly login: Pick<RejectableLogin<unknown>, "login"> &
    Partial<Pick<RejectableLogin<unknown>, "failed">>;
  /** The asker `login` and the sign-in's own questions ask through. */
  readonly asks: BoundableAsk;
  readonly secrets: RunSignInSecrets;
  /** The values the site rejected and the corrections asked, across this host's sign-ins. */
  readonly retryState?: AutofillRetryState;
  readonly site: string;
  readonly siteOrigin: string;
  readonly limits: SessionSignInLimits;
  /** Whether each check has its own `perScope` count (a build) or the whole run shares it. */
  readonly scope: "check" | "attempt";
  /**
   * The automatic sign-ins spent so far, which the caller may share across its sign-ins of one
   * attempt; a new count by default.
   */
  readonly spent?: { attempt: number; scope: number };
  readonly timing?: AutofillReplayTiming;
  /** The login's workspace origin under a recipe's workspace relation; each sign-in updates it. */
  readonly workspace?: RunWorkspace;
  /**
   * Whether a sign-in again may end on a page that can't tell, as a read's may, asked at each
   * sign-in, since a build's effect may change from read to write between them.
   */
  readonly allowCantTell?: () => boolean;
}) => {
  const spent = options.spent ?? { attempt: 0, scope: 0 };
  const replayBrowser = (bound: SessionSignInBound | undefined) =>
    bound === undefined
      ? options.browser
      : boundedSignInHooks(
          options.browser,
          bound,
          () => new SessionSignInExpiredStep("The sign-in's bound passed"),
        );
  const replay = (
    sign: RecordedSignIn,
    bound: SessionSignInBound | undefined,
    login: SignInLogin<unknown>,
  ) =>
    options.asks.within(
      bound,
      signInForRun({
        recipe: sign.recipe,
        entryUrl: sign.entryUrl,
        browser: replayBrowser(bound),
        login,
        ask: options.asks.ask,
        secrets: options.secrets,
        site: options.site,
        siteOrigin: options.siteOrigin,
        ...(options.timing === undefined ? {} : { timing: options.timing }),
        ...(options.retryState === undefined ? {} : { retryState: options.retryState }),
        ...(options.allowCantTell?.() === true ? { allowCantTell: true } : {}),
        ...(options.workspace?.origin === undefined
          ? {}
          : { workspaceOrigin: options.workspace.origin }),
      }).pipe(
        Effect.tap((signedIn) =>
          Effect.sync(() => {
            if (options.workspace !== undefined && signedIn.workspaceOrigin !== undefined)
              options.workspace.origin = signedIn.workspaceOrigin;
          }),
        ),
      ),
    );
  /** The recorded marker on the current page; no recorded sign-in says nothing. */
  const sessionOn = Effect.suspend(() => {
    const sign = options.recorded();
    if (sign === undefined) return Effect.succeed("unknown" as const);
    const { selector, urlPath } = sign.recipe.signedIn;
    const here = {
      ...(selector === undefined ? {} : { selector }),
      ...(urlPath === undefined ? {} : { urlPath }),
    };
    return options.browser
      .confirm(here, sign.recipe.steps, sign.recipe.steps)
      .pipe(Effect.map((check) => sessionOnPage(check, sign.recipe)));
  });
  /**
   * Whether the site is still signed in on a page that reads signed out without the marker: the
   * recipe's own check, which opens its account page, then the value-free replay, which types
   * nothing and stops where a value is needed. Both move the page and spend no sign-in.
   */
  const stillSignedIn = (
    sign: RecordedSignIn,
    bound: SessionSignInBound | undefined,
    failed: Failed,
  ) =>
    Effect.gen(function* () {
      const { signedIn, steps } = sign.recipe;
      if (signedIn.openPath !== undefined) {
        const check = yield* options.browser
          .confirm(signedIn, steps, steps, options.workspace?.origin)
          .pipe(Effect.mapError((error) => failed("session_sign_in_failed", "check_failed", error)));
        if (check.signedIn) return true;
      }
      const valuesNeeded = new Error("The value-free check needs the login");
      const free = yield* Effect.either(
        replay(sign, bound, {
          held: () => undefined,
          values: Effect.fail(valuesNeeded),
          correct: () => Effect.fail(valuesNeeded),
        }),
      );
      if (free._tag === "Right") return true;
      if (
        free.left instanceof SignInRunFailed &&
        free.left.code === "NeedsInput" &&
        free.left.reason === "login"
      )
        return false;
      return yield* failed("session_sign_in_failed", "replay_failed", free.left);
    });
  /** One automatic sign-in for one check, or why the session is not kept. */
  const signInAgain = (
    sign: RecordedSignIn,
    bound: SessionSignInBound | undefined,
    call: { scope: number },
    failed: Failed,
  ) =>
    Effect.gen(function* () {
      if (bound !== undefined && (yield* sessionSignInExpired(bound)))
        return yield* failed("session_sign_in_failed", "session_sign_in_expired");
      if (yield* stillSignedIn(sign, bound, failed))
        return { signedInAgain: true, alreadySignedIn: true } as const;
      const scope = options.scope === "check" ? call.scope : spent.scope;
      if (sessionSignInAllowance(options.limits, { attempt: spent.attempt, scope }) !== "allowed")
        return yield* failed("session_not_kept", "session_not_kept");
      spent.attempt += 1;
      spent.scope += 1;
      call.scope += 1;
      yield* replay(sign, bound, options.login.login).pipe(
        Effect.tapError((error) => Effect.sync(() => options.login.failed?.(error))),
        Effect.mapError((error) => failed("session_sign_in_failed", "replay_failed", error)),
      );
      return { signedInAgain: true, alreadySignedIn: false } as const;
    });
  /**
   * One check, and at most one sign-in when the page is signed out: `signedInAgain` as a script's
   * `ensureSignedIn` reads it, and `alreadySignedIn` when the check that typed nothing found the
   * site signed in. An unreadable page is left as it is. `bound` is the end of a sign-in made
   * while a script waits.
   */
  const ensureSignedIn = (cause: AutomaticSignInCause, bound?: SessionSignInBound) =>
    Effect.gen(function* () {
      const failed: Failed = (refusal, reason, failure) =>
        new SessionSignInFailed({
          refusal,
          trigger: cause,
          reason,
          ...(failure === undefined ? {} : { failure }),
        });
      const sign = options.recorded();
      if (sign === undefined) return { signedInAgain: false, alreadySignedIn: false } as const;
      const here = yield* sessionOn.pipe(
        Effect.mapError((error) => failed("session_sign_in_failed", "check_failed", error)),
      );
      if (here !== "signed_out") return { signedInAgain: false, alreadySignedIn: false } as const;
      return yield* signInAgain(sign, bound, { scope: 0 }, failed);
    });
  /**
   * The hook for one execution's `ensureSignedIn`. The runtime's automatic first call answers that
   * the page is as it was, without a check, since a check may move the page the execution starts
   * on: a build checked the page after its reset, and a run signed in just before it loaded the
   * site's root, which it does not check. A sign-in the host could not make is refused, and
   * `failed` hears why.
   */
  const hook = (failed?: (failure: SessionSignInFailed) => void): SessionSignInHook => {
    let calls = 0;
    const refuse = (failure: SessionSignInFailed) =>
      Effect.sync(() => {
        failed?.(failure);
        return { outcome: "refused", cause: failure.refusal } as const;
      });
    return (bound) =>
      Effect.suspend(() => {
        calls += 1;
        if (calls === 1) return Effect.succeed({ outcome: "signed_in", signedInAgain: false } as const);
        return ensureSignedIn("signed_out_mid_operation", bound).pipe(
          Effect.map(({ signedInAgain }) => ({ outcome: "signed_in", signedInAgain }) as const),
          Effect.catchAll(refuse),
          Effect.catchAllDefect((defect) =>
            refuse(
              new SessionSignInFailed({
                refusal: "session_sign_in_failed",
                trigger: "signed_out_mid_operation",
                reason: "sign_in_defect",
                failure: defect,
              }),
            ),
          ),
        );
      });
  };
  return { sessionOn, ensureSignedIn, hook };
};
export type LocalSessionSignIn = ReturnType<typeof makeLocalSessionSignIn>;

/**
 * A build's automatic sign-in failure as the build reports it: spent sign-ins end the build with
 * the session not kept, a login the site rejected takes the build's rejection path, an unanswered
 * question ends it unanswered, and any other failure leaves the host unavailable.
 */
export const mintSessionSignInFailure = (failed: SessionSignInFailed): MintFailure => {
  if (failed.refusal === "session_not_kept")
    return new MintFailure({
      code: "Unavailable",
      sessionLoss: "session_not_kept",
      failureDetail: failureDetail("autofill_step_failed", {
        operation: "signInAgain",
        phase: "automatic_sign_in",
        context: { outcome: "session_not_kept", cause: failed.trigger },
      }),
    });
  const failure = failed.failure;
  if (failure instanceof MintFailure) return failure;
  if (failure instanceof SignInRunFailed && failure.code === "CredentialsRejected") {
    const field = failure.reason;
    if (Schema.is(CredentialRejectedField)(field))
      return new MintFailure({ code: "CredentialsRejected", rejectedCredential: field });
  }
  if (failure instanceof SignInRunFailed && failure.code === "NeedsInput")
    return new MintFailure({ code: "Unavailable", noResponse: { possibleCommit: false } });
  return new MintFailure({
    code: "Unavailable",
    failureDetail: failureDetail("autofill_step_failed", {
      operation: "autofill.replay",
      phase: "automatic_sign_in",
      context: { outcome: "session_sign_in_failed", reason: failed.reason, cause: failed.trigger },
      ...(failure === undefined ? {} : { error: failure }),
    }),
  });
};

/**
 * A run's first sign-in, before its operation runs. On a browser this host already typed a sign-in
 * into (`typed`), as a library scope's run after its build, a recipe whose marker shows on its
 * account page checks that page first, as `stillSignedIn` does, waiting for a marker drawn late
 * (`settledMarkerCheck`), and signs nothing in when the marker shows there. Otherwise, and on a
 * new browser, it replays. A recipe with a workspace relation always replays, since only the
 * replay finds the workspace host the session is on.
 */
export const runSignInBefore = <E>(
  typed: () => boolean,
  input: Parameters<typeof signInForRun<E>>[0],
): ReturnType<typeof signInForRun<E>> =>
  Effect.gen(function* () {
    const { signedIn, steps } = input.recipe;
    if (
      typed() &&
      signedIn.openPath !== undefined &&
      workspaceRelation(input.recipe, input.siteOrigin) === undefined &&
      (yield* settledMarkerCheck(
        (shown) => input.browser.confirm(shown, steps, steps),
        signedIn,
        input.markerSettle,
      )).signedIn
    )
      return { alreadySignedIn: true };
    return yield* signInForRun(input);
  });

/**
 * A run's sign-in with its artifact's recorded sign-in: `before` signs in before the operation
 * runs, as every signed-in run does, and `hook` signs in again on the same browser whenever the
 * script's `ensureSignedIn` finds the page signed out, with the login `before` read. A run never
 * restores a saved session, so it saves none. Only a read's sign-in may end on a page that can't
 * tell: a write's needs its marker, as nothing checks the session again before the write commits.
 * `workspace` holds the workspace origin the run's sign-in learned, for this run only.
 */
export const makeRunSignIn = (
  session: StandaloneSession,
  signIn: RecordedSignIn,
  siteOrigin: string,
  authenticationOrigins: readonly string[],
  effect?: "read" | "write",
) => {
  const allowCantTell = effect === "read";
  const { browser, ask, secrets } = session;
  // The site as the owner's questions name it: its host, without `www.`.
  const site = new URL(siteOrigin).hostname.replace(/^www\./u, "");
  const asks = makeBoundableAsk(ask);
  const workspace: RunWorkspace = { origin: undefined };
  const signInBrowser = makeSignInBrowser({
    page: browser,
    keyboard: browser.keyboard,
    siteOrigin,
    authenticationOrigins,
    typing: session.signInTyping,
  });
  const login = { login: localSignInLogin({ ask: asks.ask, register: secrets.register, siteOrigin }) };
  // One run's sign-ins share what the site rejected, as one attempt's do in every host.
  const retryState = makeAutofillRetryState();
  const before = runSignInBefore(() => session.signInTyping.typed, {
    recipe: signIn.recipe,
    entryUrl: signIn.entryUrl,
    browser: signInBrowser,
    login: login.login,
    ask: asks.ask,
    secrets,
    site,
    siteOrigin,
    retryState,
    allowCantTell,
  }).pipe(
    Effect.tap((signedIn) =>
      Effect.sync(() => {
        workspace.origin = signedIn.workspaceOrigin;
      }),
    ),
  );
  const again = makeLocalSessionSignIn({
    browser: signInBrowser,
    recorded: () => signIn,
    login,
    asks,
    secrets,
    retryState,
    site,
    siteOrigin,
    limits: runSessionSignIns,
    scope: "attempt",
    workspace,
    allowCantTell: () => allowCantTell,
  });
  return { before, hook: again.hook, workspace };
};
