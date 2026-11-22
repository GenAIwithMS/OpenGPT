import { Clock, Duration, Effect } from "effect";
import type { YieldableError } from "effect/Cause";
import { pageMatches, type AutofillRecipeStep } from "../destinations/autofill-recipe.js";
import type {
  AutofillInspection,
  AutofillRefusal,
  AutofillSignedInCheck,
  AutofillStep,
  AutofillStepRequest,
} from "../destinations/autofill-step.js";
import { callFailure } from "../destinations/autofill-refusal-evidence.js";
import { pageCallFailure, report } from "./sign-in-telemetry.js";
import type { AutofillHooks } from "./autofill-state.js";
import type { AutofillReplayInput, AutofillReplayTiming } from "./autofill-replay-steps.js";

import {
  cantTell,
  landingSettleMs,
  leftSignInScreens,
  stillOff,
  type OffScreens,
} from "./autofill-replay-pages.js";

/**
 * Which pages are the recorded screens: by default each screen's recorded page, its origin and its
 * path with any trailing slash but the root's dropped. Every replay session passes its own, which
 * put a workspace screen on the login's workspace origin.
 */
export interface ReplayScreens {
  readonly onScreens: (page: string) => boolean;
  readonly matches: (page: string, recorded: AutofillRecipeStep) => boolean;
}

/**
 * The default screens: a page is a screen on that screen's recorded origin and path
 * (`pageMatches`). A workspace screen records a path alone, so it matches no page here.
 */
export const exactScreens = (steps: readonly AutofillRecipeStep[]): ReplayScreens => {
  const matches = (page: string, recorded: AutofillRecipeStep) => pageMatches(page, recorded);
  return {
    onScreens: (page) => steps.some((step) => matches(page, step)),
    matches,
  };
};

/** The recorded screen a wait is on: its page as the replay knows it, and its listed segments. */
type RecordedPage = Pick<AutofillRecipeStep, "page" | "anySegments">;

/** A later page or ready credential fields prove progression; a coincident same-page button cannot. */
const inspectReplayProgression = <E>(
  hooks: Pick<AutofillHooks<E>, "inspect">,
  currentPage: RecordedPage,
  current: AutofillStep,
  alternatives: readonly AutofillStep[],
  later: readonly AutofillRecipeStep[],
  resolve: (request: AutofillStepRequest) => AutofillStep,
  screens: ReplayScreens,
) =>
  Effect.gen(function* () {
    for (const alternative of alternatives) {
      const found = yield* hooks.inspect(alternative);
      if (!("outcome" in found)) return { found } as const;
    }
    for (const recorded of later) {
      const probes =
        recorded.methods === undefined
          ? [resolve(recorded)]
          : recorded.methods.map((method) => ({
              fields: [],
              submit: method.selector,
              ...(recorded.popup === undefined ? {} : { popup: recorded.popup }),
            }));
      for (const probe of probes) {
        const found = yield* hooks.inspect(probe);
        if (
          !("outcome" in found) &&
          screens.matches(found.page, recorded) &&
          (!pageMatches(found.page, currentPage) ||
            (current.fields.length > 0 &&
              probe.fields.some(
                (field) => !current.fields.some((previous) => previous.selector === field.selector),
              )))
        )
          return { next: recorded } as const;
      }
    }
    return undefined;
  });

/**
 * How long a screen check whose page call failed waits before its one retry: the call can fail
 * while a single-page app is still starting, such as a frame that detaches mid-scan.
 */
const pageErrorSettleMs = 1_000;

/** A failed page call's own error goes to the failure archive; its step event keeps the reason. */
const reportCallFailure = (
  input: Pick<AutofillReplayInput, "correlation">,
  inspected: AutofillInspection | AutofillRefusal,
) => {
  const detail = "outcome" in inspected ? callFailure(inspected) : undefined;
  return detail === undefined
    ? Effect.void
    : report.failure(pageCallFailure(detail), {
        component: "worker",
        operation: "autofill.inspect",
        phase: "autofill_replay",
        subCause: "autofill_step_failed",
        correlation: input.correlation,
      });
};

/** Inspect a screen, once more after a short settle when its page call failed. */
const inspectSettled = <E extends YieldableError, V extends string>(
  input: Pick<AutofillReplayInput<E, V>, "hooks" | "emit" | "correlation">,
  step: AutofillStep,
) =>
  Effect.gen(function* () {
    const inspected = yield* input.hooks.inspect(step);
    if (!("outcome" in inspected) || inspected.reason !== "page_unavailable") return inspected;
    yield* reportCallFailure(input, inspected);
    yield* input.emit({ stage: "retried", reason: inspected.reason });
    yield* Effect.sleep(Duration.millis(pageErrorSettleMs));
    const retried = yield* input.hooks.inspect(step);
    yield* reportCallFailure(input, retried);
    return retried;
  });

type ChallengeGate<V extends string> = NonNullable<AutofillHooks<unknown, V>["challenge"]>;
/**
 * Runs the challenge gate's look at the page and, once it cleared a challenge, may send the screen
 * the replay last submitted again before the awaited screen's wait goes on.
 */
export type ClearThenResubmit<E = unknown, V extends string = string> = (
  gate: ChallengeGate<V>,
  awaited: AutofillStep,
) => Effect.Effect<Effect.Effect.Success<ChallengeGate<V>>, E>;

/**
 * A screen's wait at its deadline (`due`). A screen still missing then may sit behind a challenge
 * the site put up after the last submit, which no change to the recipe gets past: before the replay
 * ends on it, a host with a challenge look (`challenge`) looks at the page and works a challenge it
 * confirms there. A cleared challenge may first let the screen the replay last submitted be sent
 * again (`resubmit`), before the wait's next deadline would read that screen showing again as the
 * site's answer (`credential_screen_returned`), then gives the awaited screen its own wait again;
 * one the host could not clear ends the replay as `challenge_unsolved`, its vendor kept in
 * `progress`.
 */
const atDeadline =
  <E, V extends string>(
    hooks: Pick<AutofillHooks<E, V>, "challenge">,
    progress: { challenge?: V | undefined },
    stepWaitMs: number,
    resubmit: ClearThenResubmit<E, V>,
  ) =>
  (missing: AutofillRefusal, until: number, awaited: AutofillStep, due: boolean) =>
    Effect.gen(function* () {
      if (!due) return { until } as const;
      const challenge =
        missing.reason === "not_found" && hooks.challenge !== undefined
          ? yield* resubmit(hooks.challenge, awaited)
          : undefined;
      if (challenge === undefined) return { end: { found: missing } as const } as const;
      if (challenge.outcome === "failed") {
        progress.challenge = challenge.vendor;
        return { end: "challenge_unsolved" as const } as const;
      }
      return { until: (yield* Clock.currentTimeMillis) + stepWaitMs } as const;
    });

/**
 * A sign-in that may end on a page that can't tell went past the screens once the page left them
 * and the entry page, stayed put a moment (or until the screen's deadline) and can't tell, as a
 * site's login page sends a signed-in browser to its account picker, or a site skips a recorded
 * code screen this time. A page off the sign-in screens is no sign-out. The last check decides
 * from that page, and a replay that sent the login goes on only as one that sent it cleanly
 * (`lastCheck`).
 */
const landedCantTell = <E extends YieldableError, V extends string>(
  input: Pick<AutofillReplayInput<E, V>, "hooks" | "recipe">,
  off: OffScreens | undefined,
  now: number,
  until: number,
  here: AutofillSignedInCheck,
  screens: ReplayScreens,
) =>
  input.hooks.confirmCantTell !== undefined &&
  off !== undefined &&
  (now - off.since >= landingSettleMs || now >= until) &&
  cantTell(here, input.recipe, screens.onScreens);

/** Why a screen's wait ended past the screens, or on a login entry that can't tell, if it did. */
const landedReason = (shown: boolean, cantTellLanding: boolean, cantTellEntry: boolean) =>
  shown
    ? "signed_in_indicator"
    : cantTellLanding
      ? "cant_tell_landing"
      : cantTellEntry
        ? "cant_tell_entry"
        : undefined;

/**
 * A value-free check of a saved session that may end on a page that can't tell, with nothing run:
 * the login entry settled, its DOM unchanged 1.5 s (or until the screen's deadline), showing
 * neither the first screen, the marker nor a password field, as a site that shows a signed-in
 * browser its own page at the login address. A missing marker alone is no sign-out, and no
 * account page opens to settle it, so the check spends nothing and the operation that runs next
 * decides. A browser that started empty, a sign-in with the login's
 * values, or the sign-in that follows a read of the page signed out (`readSignedOut`) still needs
 * its screen. `entry` keeps the page's shape (`entryShape`) and since when.
 */
const entryCantTell = <V extends string>(
  progress: ScreenWaitProgress<V>,
  entry: { at: OffScreens | undefined },
  shape: string | undefined,
  now: number,
  until: number,
) => {
  entry.at = stillOff(entry.at, shape, now);
  if (entry.at === undefined || (now - entry.at.since < landingSettleMs && now < until))
    return false;
  progress.alreadySignedIn = true;
  progress.entryCantTell = true;
  return true;
};

/** Whether the page is one of the recorded sign-in screens, and not the entry the replay opened. */
const onAnotherScreen = (screens: ReplayScreens, entryUrl: string, url: string | undefined) =>
  url !== undefined &&
  !leftSignInScreens(screens.onScreens, entryUrl, url) &&
  leftSignInScreens(() => false, entryUrl, url);

/**
 * Whether a value-free check's untouched entry page shows neither marker, screen nor form. A page
 * the site sent the browser on to, one of the recorded sign-in screens other than the entry, is
 * the sign-in's own and waits for its screen.
 */
const entryCanStop = <E extends YieldableError, V extends string>(
  input: Pick<AutofillReplayInput<E, V>, "hooks" | "credentials" | "readSignedOut" | "entryUrl">,
  progress: ScreenWaitProgress<V>,
  here: AutofillSignedInCheck,
  screens: ReplayScreens,
) =>
  input.credentials === undefined &&
  !onAnotherScreen(screens, input.entryUrl, here.url) &&
  input.readSignedOut !== true &&
  input.hooks.startedEmpty !== true &&
  input.hooks.confirmCantTell !== undefined &&
  !progress.anythingSent &&
  progress.ran.length === 0 &&
  !here.signedIn &&
  (here.failed === "indicator_not_visible" || here.failed === "path_mismatch") &&
  here.passwordFieldVisible !== true;

/**
 * The entry page's shape while it may end a value-free check (`entryCanStop`): its address,
 * element count and text length (`pageState`), so a page still drawing its login form keeps the
 * check waiting; none while it has not parsed. A browser without a page state gives its address.
 */
const entryShape = <E extends YieldableError, V extends string>(
  input: Pick<AutofillReplayInput<E, V>, "hooks" | "credentials" | "readSignedOut" | "entryUrl">,
  progress: ScreenWaitProgress<V>,
  here: AutofillSignedInCheck,
  screens: ReplayScreens,
) =>
  Effect.gen(function* () {
    if (!entryCanStop(input, progress, here, screens)) return undefined;
    const state = input.hooks.pageState === undefined ? undefined : yield* input.hooks.pageState();
    if (state?.parsed === false) return undefined;
    return state?.shape ?? here.url;
  });

/** What a screen's wait reads and sets of the replay's progress. */
type ScreenWaitProgress<V extends string> = {
  readonly anythingSent: boolean;
  /** The recorded steps that ran, fieldless clicks included. */
  readonly ran: readonly AutofillStep[];
  challenge?: V | undefined;
  alreadySignedIn?: boolean;
  /** The first screen's wait ended on a login entry that can't tell (`entryCantTell`). */
  entryCantTell?: boolean;
  readonly screenGone?: boolean;
};

/**
 * Whether the wait holds a screen it found before the replay acts on it: one with fields, with
 * nothing run yet, in a value-free check or after a screen went under the host's fill
 * (`screenGone`). A single-page app's login route may show a signed-in browser its form a moment
 * before its script sends the browser on, so only a form that stayed shown needs the login, and
 * the wait sees the page leave meanwhile; nothing is typed into a page that is leaving.
 */
const holdsShown = <V extends string>(
  input: Pick<AutofillReplayInput, "credentials">,
  progress: ScreenWaitProgress<V>,
  step: AutofillStep,
) =>
  (input.credentials === undefined || progress.screenGone === true) &&
  step.fields.length > 0 &&
  progress.ran.length === 0 &&
  !progress.anythingSent;

/**
 * One screen wait's hold (`holdsShown`): true, after a poll's sleep, while the screen it found
 * has not yet stayed shown `landingSettleMs` (1.5 s) before the wait's deadline; a screen not found starts it
 * again.
 */
const holdShown = <V extends string>(
  input: Pick<AutofillReplayInput, "credentials">,
  progress: ScreenWaitProgress<V>,
  timing: AutofillReplayTiming,
) => {
  let shownSince: number | undefined;
  return (
    step: AutofillStep,
    found: AutofillInspection | AutofillRefusal | undefined,
    until: number,
  ) =>
    Effect.gen(function* () {
      if (found === undefined) shownSince = undefined;
      if (found === undefined || "outcome" in found || !holdsShown(input, progress, step))
        return false;
      const now = yield* Clock.currentTimeMillis;
      shownSince ??= now;
      if (now - shownSince >= landingSettleMs || now >= until) return false;
      yield* Effect.sleep(Duration.millis(timing.pollMs));
      return true;
    });
};

/** What a screen's wait reads of the replay's input. */
type ScreenWaitInput<E extends YieldableError, V extends string> = Pick<
  AutofillReplayInput<E, V>,
  "hooks" | "recipe" | "entryUrl" | "emit" | "correlation" | "credentials" | "readSignedOut"
>;

/** The recorded marker on the current page, without navigating. */
const markerHere = <E extends YieldableError, V extends string>({ hooks, recipe }: Pick<AutofillReplayInput<E, V>, "hooks" | "recipe">) =>
  hooks.check(
    { selector: recipe.signedIn.selector, urlPath: recipe.signedIn.urlPath },
    recipe.steps,
  );

/**
 * Waits for the recorded stage to become ready, or for evidence of a later stage or landing, and
 * at its deadline lets the challenge gate look for a challenge hiding the screen (`atDeadline`).
 * A value-free check's first screen may end on a login entry that can't tell (`entryCantTell`).
 */
export const makeReplayScreenWait = <
  E extends YieldableError,
  V extends string = string,
  Rejection extends string = never,
>(
  input: ScreenWaitInput<E, V>,
  progress: ScreenWaitProgress<V>,
  timing: AutofillReplayTiming,
  resolve: (request: AutofillStepRequest) => AutofillStep,
  rejection?: (due: boolean) => Effect.Effect<Rejection | undefined, E>,
  resubmit: ClearThenResubmit<E, V> = (gate) => gate,
  screens: ReplayScreens = exactScreens(input.recipe.steps),
) => {
  const { hooks, recipe } = input;
  const leftSignIn = (url?: string) => leftSignInScreens(screens.onScreens, input.entryUrl, url);
  const checkHere = markerHere(input);
  const now = Clock.currentTimeMillis;
  const deadline = atDeadline(hooks, progress, timing.stepWaitMs, resubmit);
  /** Inspect the current stage, rejection evidence and proved later stages before timing a wait. */
  const inspectStage = (
    step: AutofillStep,
    currentPage: RecordedPage,
    later: readonly AutofillRecipeStep[],
    alternatives: readonly AutofillStep[],
    due: boolean,
  ) =>
    Effect.gen(function* () {
      const inspected = yield* inspectSettled(input, step);
      if (!("outcome" in inspected)) return { found: inspected } as const;
      // Failing again, the page's signed-in check decides before the replay ends.
      if (inspected.reason === "page_unavailable") return { pageError: inspected } as const;
      if (
        inspected.reason !== "not_found" &&
        inspected.reason !== "not_editable" &&
        inspected.reason !== "popup_missing"
      )
        return { found: inspected } as const;
      if (rejection !== undefined) {
        const rejected = yield* rejection(due);
        if (rejected === "extra_retried") return rejected;
        if (rejected !== undefined) return rejected;
      }
      const progressed = yield* inspectReplayProgression(
        hooks,
        currentPage,
        step,
        alternatives,
        later,
        resolve,
        screens,
      );
      if (progressed !== undefined) {
        if (progressed.found !== undefined) return { found: progressed.found } as const;
        yield* input.emit({
          stage: "skipped",
          reason: "later_recorded_screen",
          nextStep: recipe.steps.indexOf(progressed.next),
        });
        return "skipped" as const;
      }
      return { waiting: inspected } as const;
    });
  return (
    step: AutofillStep,
    until: number,
    currentPage: string | RecordedPage,
    later: readonly AutofillRecipeStep[] = [],
    alternatives: readonly AutofillStep[] = [],
  ) =>
    Effect.gen(function* () {
      const current = typeof currentPage === "string" ? { page: currentPage } : currentPage;
      const left = { off: undefined as OffScreens | undefined };
      const entry = { at: undefined as OffScreens | undefined };
      let waitUntil = until;
      const held = holdShown(input, progress, timing);
      while (true) {
        const due = (yield* now) >= waitUntil;
        const stage = yield* inspectStage(step, current, later, alternatives, due);
        if (stage === "extra_retried") continue;
        if (typeof stage === "string") return stage;
        if (yield* held(step, stage.found, waitUntil)) continue;
        if (stage.found !== undefined) return { found: stage.found } as const;
        const inspected = stage.waiting ?? stage.pageError;
        const here = yield* checkHere;
        const at = yield* now;
        left.off = stillOff(left.off, leftSignIn(here.url) ? here.url : undefined, at);
        const landed = landedReason(
          here.signedIn,
          landedCantTell(input, left.off, at, waitUntil, here, screens),
          entryCantTell(
            progress,
            entry,
            yield* entryShape(input, progress, here, screens),
            at,
            waitUntil,
          ),
        );
        if (landed !== undefined) {
          yield* input.emit({ stage: "skipped", reason: landed });
          return "signed_in" as const;
        }
        // A bounded wait without observed progress stops the replay; a page error at once.
        if (stage.pageError !== undefined) return { found: inspected } as const;
        const next = yield* deadline(inspected, waitUntil, step, due);
        if ("end" in next) return next.end;
        waitUntil = next.until;
        yield* Effect.sleep(Duration.millis(timing.pollMs));
      }
    });
};
