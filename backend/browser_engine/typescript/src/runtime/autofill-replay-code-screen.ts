import { Clock, Effect } from "effect";
import type { YieldableError } from "effect/Cause";
import type { AutofillStep } from "../destinations/autofill-step.js";
import { report } from "./sign-in-telemetry.js";
import type { AutofillReplayInput } from "./autofill-replay-steps.js";
import { findCodeScreen } from "./autofill-unrecorded-code.js";
import type { Replay } from "./autofill-replay-session.js";
import type { AutofillLogin } from "./autofill-values.js";

const originOf = (page: string) => URL.parse(page)?.origin;

/** How often the marker wait looks for a code field, between its marker checks, by default. */
const codeLookMs = 1_000;

/**
 * Whether a field of `step`, a screen this replay submitted, may still show on the page: only a
 * field the page no longer has (`not_found`) is gone; a page that could not be read, or a match
 * that was not one, may still be showing it.
 */
const stillShows = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  step: AutofillStep,
) =>
  Effect.exists(step.fields, (field) =>
    input.hooks
      .inspect({ fields: [field], ...(step.popup === undefined ? {} : { popup: step.popup }) })
      .pipe(Effect.map((found) => !("outcome" in found) || found.reason !== "not_found")),
  );

/** Whether the screen this replay last submitted is gone, none of its fields still showing. */
export const lastScreenGone = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
) => {
  const submitted = replay.progress.ran.at(-1);
  return submitted === undefined
    ? Effect.succeed(true)
    : Effect.map(stillShows(input, submitted), (shows) => !shows);
};

/**
 * Whether the page is a code screen the recipe never recorded, which no marker wait need outlast:
 * no code may have gone out yet, an empty code field shows on a recorded screen's origin, and
 * the screen this replay last submitted is gone, none of its fields still showing. That
 * screen still showing is one the site may still be checking, whatever other field it has (an
 * optional code box beside a password, a recovery code's own field), so the wait goes on, as it
 * does once a code may have gone out: a code screen shown again then waits for its marker first.
 */
const unrecordedCodeShown = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
) =>
  Effect.gen(function* () {
    let shown = false;
    yield* report.bestEffort(
      Effect.gen(function* () {
        const here = yield* findCodeScreen(input.hooks);
        if ("outcome" in here || here.inspection.targets.fields[0]?.empty !== true) return;
        const at = originOf(here.inspection.page);
        if (at === undefined || !replay.signInOrigins().has(at)) return;
        shown = yield* lastScreenGone(input, replay);
      }),
      {
        component: "worker",
        operation: "autofill.unrecordedCodeShown",
        phase: "autofill_replay",
        correlation: input.correlation,
      },
    );
    return shown;
  });

/**
 * Whether the marker wait looks for an unrecorded code screen after a check that found no marker:
 * only while no code may have gone out, on a page on a recorded screen's origin, so a page that
 * can't be one costs no read, and at most once each `codeLookMs`.
 */
const codeLookDue = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  replay: Replay<E, V, L>,
  url: string | undefined,
  now: number,
  next: number,
) => {
  const at = url === undefined ? undefined : originOf(url);
  return (
    now >= next &&
    !replay.sent.maySent.has("code") &&
    at !== undefined &&
    replay.signInOrigins().has(at)
  );
};

/**
 * Whether the marker wait ends at an unrecorded code screen, for a replay that asked to
 * (`endAtUnrecordedCode`): any other replay reads nothing more than its marker checks. `look`
 * holds when the next look is due.
 */
export const endsAtCodeScreen = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  url: string | undefined,
  look: { next: number },
) =>
  Effect.gen(function* () {
    if (input.endAtUnrecordedCode !== true) return false;
    // Read after the check, which may take a while, so the look keeps to its own pace.
    const now = yield* Clock.currentTimeMillis;
    if (!codeLookDue(replay, url, now, look.next)) return false;
    look.next = now + (replay.timing.codeLookMs ?? codeLookMs);
    return yield* unrecordedCodeShown(input, replay);
  });
