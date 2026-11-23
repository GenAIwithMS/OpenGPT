import { Clock, Duration, Effect } from "effect";
import type { YieldableError } from "effect/Cause";
import type { AutofillRecipeStep } from "../destinations/autofill-recipe.js";
import { resolvedPage, type SignInRecipeStep } from "../destinations/sign-in-recipe.js";
import type {
  AutofillInspection,
  AutofillRefusal,
  AutofillSignedInCheck,
  AutofillStep,
} from "../destinations/autofill-step.js";
import { refusalEvidence } from "../destinations/autofill-refusal-evidence.js";
import { isIdentifier, screenSubmit, submittedLoginProof } from "./autofill-state.js";
import type { AutofillLogin } from "./autofill-values.js";
import {
  type AutofillReplayInput,
  emptyRetryFields,
  askOne,
  valuesNeeded,
} from "./autofill-replay-steps.js";
import { alreadySignedIn, makeReplay, type Replay, workspaceOf } from "./autofill-replay-session.js";
import { endsAtCodeScreen, lastScreenGone } from "./autofill-replay-code-screen.js";
import { admitScreen, noteExactSent } from "./autofill-replay-workspace.js";
import { approvalNumber, approvalScreen, withApprovalNumber } from "./autofill-replay-approval.js";
import { settleCarried } from "./autofill-replay-fill.js";
import {
  codeBoxRow,
  codeScreenOf,
  findCodeScreen,
  onSignInOrigin,
} from "./autofill-unrecorded-code.js";
import {
  cantTell,
  offScreens,
  landingSettleMs,
  stillOff,
  type OffScreens,
} from "./autofill-replay-pages.js";

/**
 * A recorded screen's page as this replay knows it, a workspace screen's on its workspace origin,
 * with the segments it lists.
 */
const pageOf = <E extends YieldableError, V extends string, L extends AutofillLogin>(replay: Replay<E, V, L>, recorded: SignInRecipeStep) => ({
  page: resolvedPage(recorded, replay.progress.workspace) ?? recorded.page,
  anySegments: recorded.anySegments,
});

/** A recorded screen the host refused: its step event says which check, then the replay ends. */
const refusedScreen = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  refusal: AutofillRefusal,
) =>
  input
    .emit({
      stage: "step",
      outcome: "refused",
      reason: refusal.reason,
      ...refusalEvidence(refusal),
      ...replay.firstCause.evidence(refusal),
    })
    .pipe(Effect.as(replay.outcome(refusal.reason)));

/**
 * A recorded code screen that never showed within its wait (`not_found`), with neither the marker
 * nor a later recorded screen in its place: the site asked for no code this time, or showed another
 * screen. The replay then goes on to its sign-in check, which looks for a code screen the recipe
 * never recorded, before it ends with the recorded screen's refusal (`replayAutofillRecipe`).
 */
const codeScreenMissing = (recorded: SignInRecipeStep, refusal: AutofillRefusal) =>
  refusal.reason === "not_found" &&
  recorded.fields.some((field) => "slot" in field && field.slot === "code");

/** A recorded code screen that never showed, with the refusal its wait ended with. */
interface MissingCodeScreen {
  readonly codeScreenMissing: AutofillRefusal;
}
const missingCodeScreen = (refusal: AutofillRefusal): MissingCodeScreen => ({
  codeScreenMissing: refusal,
});

/** A recorded screen shown and admitted, with the step that fills it. */
interface ShownScreen {
  readonly step: AutofillStep;
  readonly inspection: AutofillInspection;
}
const shownScreen = (step: AutofillStep, inspection: AutofillInspection): ShownScreen => ({
  step,
  inspection,
});

/** The recorded screen as it runs now: a method choice clicks the method this run picks. */
const screenFor = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  replay: Replay<E, V, L>,
  recorded: SignInRecipeStep,
  until: number,
  later: readonly AutofillRecipeStep[],
) =>
  Effect.gen(function* () {
    // Each identifier field takes the kind this run's login holds that it accepts.
    const step: AutofillStep = replay.resolve({
      fields: recorded.fields,
      ...screenSubmit(recorded),
    });
    if (recorded.methods === undefined) return step;
    // The choice screen shows before a method is picked; its first option finds it.
    const probe = {
      fields: [],
      submit: recorded.methods[0]?.selector ?? "",
      ...(recorded.popup === undefined ? {} : { popup: recorded.popup }),
    };
    const alternatives = recorded.methods.slice(1).map((method) => ({
      fields: [],
      submit: method.selector,
      ...(recorded.popup === undefined ? {} : { popup: recorded.popup }),
    }));
    const shown = yield* replay.awaitScreen(
      probe,
      until,
      pageOf(replay, recorded),
      later,
      alternatives,
    );
    if (typeof shown === "string" || "outcome" in shown.found) return shown;
    // Picking a method may send a code: a value-free replay stops before it.
    if (replay.valueFree) return valuesNeeded;
    const picked = yield* replay.pickMethod(recorded.methods);
    replay.progress.chosen = picked.method;
    return {
      fields: [],
      submit: picked.selector,
      ...(recorded.popup === undefined ? {} : { popup: recorded.popup }),
    };
  });

/** An approval happens off the page: the caller confirms it, and a "no" stops the replay. */
const confirmPush = <E extends YieldableError, V extends string, L extends AutofillLogin>(input: AutofillReplayInput<E, V, L>, replay: Replay<E, V, L>) =>
  askOne(input, {
    id: "approved",
    type: "confirm",
    prompt: `Approve the sign-in request ${input.site} sent you, then confirm here.`,
  }).pipe(
    Effect.map((approved) =>
      approved?.type === "confirm" && approved.value.confirmed
        ? ("continue" as const)
        : replay.outcome("push_declined"),
    ),
  );

/** Wait for a resolved step's screen, and admit it only on the recorded screen's own origin. */
const awaitRecordedScreen = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  step: AutofillStep,
  recorded: SignInRecipeStep,
  until: number,
  later: readonly AutofillRecipeStep[],
) =>
  Effect.gen(function* () {
    const shown = yield* replay.awaitScreen(step, until, pageOf(replay, recorded), later);
    if (typeof shown === "string")
      return shown === "signed_in" || shown === "skipped" ? shown : replay.outcome(shown);
    if ("outcome" in shown.found)
      return codeScreenMissing(recorded, shown.found)
        ? missingCodeScreen(shown.found)
        : yield* refusedScreen(input, replay, shown.found);
    // The screen must sit on its recorded origin or the login's own workspace, not only on the
    // same site: another tenant's login on a shared domain would pass the site check.
    const refused = yield* admitScreen(input, replay, recorded, shown.found.page);
    if (refused !== undefined) return replay.outcome(refused);
    return shownScreen(step, shown.found);
  });

/** Resolve and admit the observed recorded screen before any host-filled submission. */
const inspectRecordedScreen = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  recorded: SignInRecipeStep,
  until: number,
  later: readonly AutofillRecipeStep[],
) =>
  Effect.gen(function* () {
    const step = yield* screenFor(replay, recorded, until, later);
    if (typeof step === "string")
      return step === "signed_in" || step === "skipped" ? step : replay.outcome(step);
    if ("found" in step)
      return "outcome" in step.found
        ? yield* refusedScreen(input, replay, step.found)
        : replay.outcome("screen_changed");
    return yield* awaitRecordedScreen(input, replay, step, recorded, until, later);
  });

/**
 * A fill that sent nothing found its screen gone, as a single-page app's login route removes its
 * form while it sends a signed-in browser on: once per replay, the step leaves the screens that
 * ran and the screen gets a wait of its own, which finds the page signed in, or the screen, which
 * it holds until it stays shown before filling it again (`holdsShown`).
 */
const screenGoneUnsent = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  step: AutofillStep,
  ranBefore: number,
) =>
  Effect.gen(function* () {
    if (replay.progress.screenGone || replay.progress.anythingSent || replay.sent.maySent.size > 0)
      return false;
    const here = yield* input.hooks.inspect(step);
    if (!("outcome" in here) || here.reason !== "not_found") return false;
    replay.progress.ran.splice(ranBefore);
    replay.progress.screenGone = true;
    yield* input.emit({ stage: "retried", reason: "screen_gone" });
    return true;
  });

/** Fill only a recorded screen whose live controls and origin passed inspection. */
const runScreen = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  recorded: SignInRecipeStep,
  until: number,
  later: readonly AutofillRecipeStep[],
) =>
  Effect.gen(function* () {
    const inspected = yield* inspectRecordedScreen(input, replay, recorded, until, later);
    if (typeof inspected === "string" || "outcome" in inspected || "codeScreenMissing" in inspected)
      return inspected;
    const { step } = inspected;
    let { inspection } = inspected;
    // The screen is shown and needs the login: a value-free replay stops before anything is sent.
    if (replay.valueFree && (recorded.approval !== undefined || step.fields.length > 0))
      return replay.outcome(valuesNeeded);
    if (recorded.approval !== undefined) {
      settleCarried(replay);
      if (![...replay.state.submittedSlots].some(isIdentifier))
        return replay.outcome("identifier_not_submitted");
      // The approval may show on another page of its recorded origin (`approvalScreen`).
      const approval = yield* approvalScreen(
        input,
        replay,
        recorded,
        pageOf(replay, recorded).page,
        inspection.page,
      );
      if (approval === "signed_in") return approval;
      if (approval === "screen_changed") return replay.outcome(approval);
      // A device approval may have the owner pick the number its screen shows (`matchSelector`).
      const number =
        recorded.approval === "device"
          ? yield* approvalNumber(
              input.hooks,
              recorded.matchSelector,
              inspection.page,
              recorded.popup,
            )
          : undefined;
      const answer = yield* askOne(input, {
        id: "approved",
        type: "confirm",
        prompt:
          recorded.approval === "email_link"
            ? `Open the sign-in link ${input.site} emailed you, then confirm here.`
            : withApprovalNumber(
                `Approve the sign-in request ${input.site} sent to your device, then confirm here.`,
                number,
              ),
      });
      if (answer?.type !== "confirm" || !answer.value.confirmed)
        return replay.outcome("approval_declined");
      replay.state.steps.push({
        page: inspection.page,
        fields: [],
        approval: recorded.approval,
        ...(recorded.matchSelector === undefined ? {} : { matchSelector: recorded.matchSelector }),
        ...(recorded.popup === undefined ? {} : { popup: recorded.popup }),
      });
      return "continue" as const;
    }
    for (;;) {
      const ranBefore = replay.progress.ran.length;
      const failed = yield* replay.runStep(
        step,
        inspection,
        undefined,
        false,
        undefined,
        recorded.refills,
      );
      if (failed === undefined) break;
      // A fieldless step whose submit the page kept disabled through the host's wait typed and
      // clicked nothing, so it waits for its screen again within the screen's own wait, as it
      // did while the host refused a disabled submit, and so does a fill whose screen went with
      // nothing sent. Any other step with fields ends: the page still wants something besides them.
      const now = yield* Clock.currentTimeMillis;
      const waitsAgain =
        failed === "submit_stayed_disabled"
          ? step.fields.length === 0 && now < until
          : yield* screenGoneUnsent(input, replay, step, ranBefore);
      if (!waitsAgain) return replay.outcome(failed);
      // A screen gone under the fill gets a screen's wait of its own, so its hold still runs.
      const by = failed === "submit_stayed_disabled" ? until : now + replay.timing.stepWaitMs;
      const shown = yield* awaitRecordedScreen(input, replay, step, recorded, by, later);
      if (typeof shown === "string" || "outcome" in shown || "codeScreenMissing" in shown)
        return shown;
      inspection = shown.inspection;
    }
    // What a screen on its exact origin sent anchors the login's workspace (`admitScreen`).
    noteExactSent(replay, recorded, step, inspection);
    // An approval happens off the page: the caller confirms it, then the screens go on.
    if (replay.progress.chosen === "push" && recorded.methods !== undefined)
      return yield* confirmPush(input, replay);
    return "continue" as const;
  });

/** The recorded screens in order, each waited for at most `stepWaitMs`. */
const runScreens = <E extends YieldableError, V extends string, L extends AutofillLogin>(input: AutofillReplayInput<E, V, L>, replay: Replay<E, V, L>) =>
  Effect.gen(function* () {
    for (const [index, recorded] of input.recipe.steps.entries()) {
      const now = yield* Clock.currentTimeMillis;
      const ran = yield* runScreen(
        input,
        replay,
        recorded,
        now + replay.timing.stepWaitMs,
        input.recipe.steps.slice(index + 1),
      );
      if (ran === "signed_in")
        return replay.progress.entryCantTell
          ? ({ outcome: "signed_in", alreadySignedIn: true, cantTell: true } as const)
          : replay.progress.alreadySignedIn
            ? ({ outcome: "signed_in", alreadySignedIn: true, ...workspaceOf(replay) } as const)
            : undefined;
      if (ran !== "continue" && ran !== "skipped") return ran;
    }
    return undefined;
  });

/**
 * Waits, bounded, for the marker to show on the current page. Once the page left the recorded
 * login screens and stayed put a moment, a read's sign-in on a page that can't tell stops waiting
 * and returns that page's check
 * (`cantTellHere`) for the last check to decide from. A page that reads signed out, such as the
 * marker's own path, waits out a marker drawn late.
 * A caller that hands over at a code screen the recipe never recorded stops once the page is one
 * (`endsAtCodeScreen`), which the probe after the wait answers.
 */
const awaitIndicator = <E extends YieldableError, V extends string, L extends AutofillLogin>(input: AutofillReplayInput<E, V, L>, replay: Replay<E, V, L>) =>
  Effect.gen(function* () {
    const until = (yield* Clock.currentTimeMillis) + replay.timing.stepWaitMs;
    const mayCantTell = input.hooks.confirmCantTell !== undefined;
    // The page off the recorded screens, and since when: a passing page redirects on before it
    // settles, so only one that stayed put can't tell.
    let off: OffScreens | undefined;
    const look = { next: 0 };
    while (true) {
      const now = yield* Clock.currentTimeMillis;
      if (now >= until) return { shown: false } as const;
      const check = yield* replay.checkHere;
      if (check.signedIn) return { shown: true } as const;
      if (yield* endsAtCodeScreen(input, replay, check.url, look)) return { shown: false } as const;
      off = stillOff(off, offScreens(replay.onScreens, check.url), now);
      if (off !== undefined && now - off.since >= landingSettleMs) {
        if (
          mayCantTell &&
          cantTell(
            check,
            { signedIn: input.recipe.signedIn, steps: replay.resolvedSteps() },
            replay.onScreens,
          )
        )
          return { shown: false, cantTellHere: check } as const;
      }
      yield* Effect.sleep(Duration.millis(replay.timing.pollMs));
    }
  });

/**
 * The last code step whose field shows again. An unrecorded code screen shows again only where it
 * was found: a code field on another screen is the site's next one, not a refusal of the code the
 * first took.
 */
const codeShownAgain = <E extends YieldableError, V extends string, L extends AutofillLogin>(input: AutofillReplayInput<E, V, L>, replay: Replay<E, V, L>) =>
  Effect.gen(function* () {
    const shown = yield* replay.shownAgain("code");
    const unrecorded = replay.progress.unrecordedCodeScreen;
    if (shown === undefined || unrecorded === undefined) return shown;
    const here = yield* input.hooks.inspect({
      fields: shown.fields,
      ...(shown.popup === undefined ? {} : { popup: shown.popup }),
    });
    return !("outcome" in here) && codeScreenOf(here) === unrecorded ? shown : undefined;
  });

/**
 * A code screen that came back: the caller types a new code, never one from the host's generator.
 * What was sent does not decide the rest, the screen does: every other password or
 * code field it shows empty is filled again, as a site that empties the whole screen needs, and a
 * field that still holds a value is left as it is. A password goes out at most twice this way.
 */
const retryCode = <E extends YieldableError, V extends string, L extends AutofillLogin>(input: AutofillReplayInput<E, V, L>, replay: Replay<E, V, L>) =>
  Effect.gen(function* () {
    const observed = yield* replay.observeRejections;
    if (observed === "unavailable") return "ambiguous_combined_rejection";
    const extra = yield* replay.correctExtras(observed);
    if (extra !== undefined) return extra;
    const rejected = observed[0];
    if (rejected === "password") return "password_rejected";
    if (rejected !== undefined && rejected !== "code") return "username_rejected";
    const shown = yield* codeShownAgain(input, replay);
    if (shown === undefined) return "none" as const;
    replay.recordRejected([...observed, "code"]);
    const fields = yield* emptyRetryFields(input, shown, rejected === "code");
    if (typeof fields === "string") return fields;
    const retryStep: AutofillStep = {
      fields,
      ...screenSubmit(shown),
    };
    const inspected = yield* input.hooks.inspect(retryStep);
    if ("outcome" in inspected) return "none" as const;
    return (
      (yield* replay.runStep(retryStep, inspected, "rejected", rejected === "code")) ??
      ("retried" as const)
    );
  });

/**
 * A code screen the recipe never recorded, looked for once and only while no code may have gone
 * out, so the look never sends a second one (`findCodeScreen`, `onSignInOrigin`). A code field in
 * no form with a submit is filled with no submit, so the page's own send counts (`page`). A field
 * that is the first of a row of one-character boxes takes the whole row, or nothing (`codeBoxRow`).
 * Its code comes as a recorded code screen's does: the host's own, else the owner's answer to the
 * host's question; after it refuses a code, its retries never take the host generator's (see
 * `runReplayStep`). The screen this replay last submitted still showing is the site's
 * answer to it, such as a password screen shown again or a refused recovery code, so a code box on
 * it takes no code. A fill that typed no code leaves the sign-in as it was, its step dropped from
 * the screens that ran, for the full check to decide; one that typed it and sent nothing stops, as
 * the code it holds would count as sent there.
 * `ran` when the code went out, `none` when none shows, or why it stopped.
 */
const unrecordedCode = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  probed: { current: boolean },
) =>
  Effect.gen(function* () {
    if (probed.current || replay.sent.maySent.has("code")) return "none" as const;
    probed.current = true;
    const field = yield* findCodeScreen(input.hooks);
    const found = "outcome" in field ? field : yield* codeBoxRow(input.hooks, field);
    if ("outcome" in found || !onSignInOrigin(replay.signInOrigins(), found.inspection))
      return "none" as const;
    if (!(yield* lastScreenGone(input, replay))) return "none" as const;
    replay.progress.unrecordedCodeScreen = codeScreenOf(found.inspection);
    const before = replay.progress.ran.length;
    const failed = yield* replay.runStep(found.step, found.inspection);
    if (failed === undefined && replay.sent.maySent.has("code")) return "ran" as const;
    if (replay.sent.maySent.has("code") || replay.state.filled.has("code"))
      return failed ?? "sign_in_check_failed";
    replay.progress.ran.splice(before);
    return "none" as const;
  });

/** The indicator verified a sign-in this replay sent, and whether it submitted the login proof. */
const signedInBySending = <E extends YieldableError, V extends string, L extends AutofillLogin>(replay: Replay<E, V, L>) =>
  ({
    outcome: "signed_in",
    alreadySignedIn: false,
    loginProved: submittedLoginProof(replay.state),
    ...workspaceOf(replay),
  }) as const;

/**
 * The full check for a recipe that checks on the landing page, else why the replay did not sign
 * in: the password screen showing again after a submit sent the password, with no recorded error
 * marker, is no verdict on the login (`credential_screen_returned`); the
 * password screen after no submit sent it (`password_screen_again`), or any other failed check, is
 * the recipe's. A saved security answer whose question shows again was refused, and is flagged.
 * A read's page that can't tell, such as an account picker the site shows before its marker, signs
 * in. One the marker wait already found so (`cantTellHere`)
 * decides from that check, with no marker wait of its own, as a missed marker only waits for the
 * read to prove the sign-in, and a marker drawn since changes nothing.
 */
const lastCheck = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  cantTellHere: AutofillSignedInCheck | undefined,
) =>
  Effect.gen(function* () {
    if (cantTellHere === undefined && (yield* replay.verify(input.recipe.signedIn)))
      return signedInBySending(replay);
    if ((yield* replay.shownAgain("password")) === undefined) {
      yield* replay.refuseShownAnswer;
      if (yield* replay.endedCantTell(cantTellHere))
        return { ...signedInBySending(replay), cantTell: true } as const;
      return replay.outcome("sign_in_check_failed");
    }
    return replay.outcome(
      replay.sent.seenSent("password") ? "credential_screen_returned" : "password_screen_again",
    );
  });

/**
 * After the screens, the recipe's own sign-in check decides: the marker on the
 * page, a code screen answered first (a refused code's retry, else one the recipe never recorded:
 * see `retryCode` and `unrecordedCode`), then the full check on the page as it is, once it settled. A
 * check that fails ends the replay with its reason, such as a password the site rejected.
 */
const settle = <E extends YieldableError, V extends string, L extends AutofillLogin>(input: AutofillReplayInput<E, V, L>, replay: Replay<E, V, L>) =>
  Effect.gen(function* () {
    const probed = { current: false };
    while (true) {
      // A screen that submitted itself, such as a code box on its last digit, sent its values:
      // they count before the code retry and the unrecorded-code probe decide.
      settleCarried(replay);
      const waited = yield* awaitIndicator(input, replay);
      if (!replay.progress.anythingSent)
        return yield* alreadySignedIn(input, replay, waited.cantTellHere);
      if (waited.shown && (yield* replay.verify(replay.onPage))) return signedInBySending(replay);
      const code = yield* retryCode(input, replay);
      if (code === "retried" || code === "extra_retried") continue;
      if (code !== "none") return replay.outcome(code);
      const unrecorded = yield* unrecordedCode(input, replay, probed);
      if (unrecorded === "ran") continue;
      if (unrecorded !== "none") return replay.outcome(unrecorded);
      return yield* lastCheck(input, replay, waited.cantTellHere);
    }
  });

/**
 * Replays the recipe on the run's own browser with the host's fill: each screen is found and
 * judged (one visible match, frame and form on the site or a configured sign-in origin), filled
 * and submitted, then the host checks the indicator. The build's rules hold: a password or code
 * goes out at most twice, a visible credential rejection stops before another fill, and an empty
 * combined screen without distinct code-rejection evidence ends the replay
 * (`ambiguous_combined_rejection`).
 * A value counts as sent once a submit was clicked after it was filled.
 */
export const replayAutofillRecipe = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
) =>
  Effect.gen(function* () {
    const replay = makeReplay(input);
    const removeFailureListener = input.hooks.onLoadFailure?.(replay.firstCause.heard);
    if (removeFailureListener) yield* Effect.addFinalizer(() => Effect.sync(removeFailureListener));
    yield* input.hooks.open(input.entryUrl);
    const stopped = yield* runScreens(input, replay);
    if (stopped === undefined) return yield* settle(input, replay);
    if (!("codeScreenMissing" in stopped)) return stopped;
    // A recorded code screen that never showed: the sign-in check decides, and looks for a code
    // screen the recipe never recorded. One that signs in, or sends a code, stands; otherwise the
    // replay ends with the recorded screen's refusal, as before.
    const settled = yield* settle(input, replay);
    if (settled.outcome === "signed_in" || replay.sent.maySent.has("code")) return settled;
    return yield* refusedScreen(input, replay, stopped.codeScreenMissing);
  });
