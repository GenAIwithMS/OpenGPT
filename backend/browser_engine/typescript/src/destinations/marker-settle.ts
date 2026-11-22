import { Clock, Duration, Effect } from "effect";
import type { AutofillSignedIn, AutofillSignedInCheck } from "./autofill-step.js";

/** How a check waits for a page to draw its marker: one check every `interval`, for `within`. */
export interface MarkerSettle {
  readonly within: Duration.Duration;
  readonly interval: Duration.Duration;
}

/**
 * How long a loaded page may take to draw its signed-in marker, for every check that waits for one
 * (a sign-in's confirming check and the build's fresh load among them), so they cannot drift
 * apart: a page may draw its account menu several seconds after it loaded.
 */
export const markerSettle: MarkerSettle = {
  within: Duration.seconds(10),
  interval: Duration.millis(500),
};

/**
 * Checks the marker, opening its page when it names one, then reads the page as it is again every
 * `interval` while the marker alone is missing, until `within` after the first check. A check that
 * shows it, or fails for any other reason, ends the wait: what counts as signed in is the check's.
 */
export const settledMarkerCheck = <E, R>(
  check: (indicator: AutofillSignedIn) => Effect.Effect<AutofillSignedInCheck, E, R>,
  indicator: AutofillSignedIn,
  settle: MarkerSettle = markerSettle,
) =>
  Effect.gen(function* () {
    let checked = yield* check(indicator);
    const until = (yield* Clock.currentTimeMillis) + Duration.toMillis(settle.within);
    const here = { selector: indicator.selector, urlPath: indicator.urlPath };
    while (!checked.signedIn && checked.failed === "indicator_not_visible") {
      const next = (yield* Clock.currentTimeMillis) + Duration.toMillis(settle.interval);
      if (next > until) break;
      yield* Effect.sleep(settle.interval);
      checked = yield* check(here);
    }
    return checked;
  });
