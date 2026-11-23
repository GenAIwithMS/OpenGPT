import { Effect } from "effect";
import type { AutofillSignedIn } from "../destinations/autofill-step.js";
import {
  loginPathRefusal,
  matchSignedOutSnapshots,
  type SignedOutSnapshot,
  signedOutMatchRefusal,
} from "../destinations/signed-in-marker.js";
import type { AutofillSignInState } from "../runtime/autofill-state.js";
import { type AutofillHost, autofillRecovery, emit, result } from "./autofill-results.js";

// What a build's signed-in check refuses before it reads the page: a sign-in no submit sent, and a
// marker the host can already tell apart from nothing.

type Host = AutofillHost;

type MarkerHost = Pick<AutofillHost, "diagnostics" | "reportCorrelation">;

/** A marker the host refuses at `signedIn`, the package's reasons for what the host already holds. */
export type MarkerRefusal = "marker_matches_signed_out_page" | "marker_is_login_path";

/**
 * The refusal the host decides from what it already holds, before it touches the page: a marker
 * a signed-out page shows, or a path alone that is one of the sign-in pages' paths.
 */
export const markerRefusalFor = (
  indicator: AutofillSignedIn,
  signedOutPages: readonly SignedOutSnapshot[],
  loginPaths: readonly string[],
) => {
  const signedOut = matchSignedOutSnapshots(indicator, signedOutPages);
  const refusal: MarkerRefusal | undefined =
    signedOutMatchRefusal({ signedOutSnapshot: signedOut }) ??
    loginPaths
      .map((path) => loginPathRefusal(indicator, path))
      .find((found) => found !== undefined);
  return { signedOut, refusal };
};

const markerChecked =
  "The host checks this marker after resets, at every operation start, after page loads in the middle of a run and on whatever page a failure lands on";
const pickAnother =
  "pick a site-wide element only a signed-in user sees, such as the global header's account menu or a sign-out control, preferring an aria-label, role or visible text to generated class names. Test it with check_signed_in_marker until every check passes, then send signedIn again";
const refusalReasons: Record<MarkerRefusal, string> = {
  marker_matches_signed_out_page:
    "This marker also shows on a page the host saw signed out, so it cannot tell a signed-in page from a signed-out one.",
  marker_is_login_path:
    "This path is a sign-in page's, where a signed-out browser is, and a single-page app keeps one path either way.",
};

/** A marker the host refused: the open sign-in stays open for another. */
export const refuseMarker = (h: MarkerHost, refusal: MarkerRefusal) =>
  Effect.gen(function* () {
    yield* emit(h, { stage: "marker_refused", reason: refusal });
    return result({
      signedIn: false,
      failed: refusal,
      nextStep: `${refusalReasons[refusal]} ${markerChecked}, so ${pickAnother}.`,
    });
  });

/**
 * Why the host cannot take the page as signed in before checking the minter's indicator: the
 * sign-in was open on a browser the host has since replaced (`sign_in_on_replaced_browser`), or no
 * screen of it was submitted after its identifier and a password, code or protected approval were
 * filled (`credentials_not_submitted`), as when the browser was already signed in. A submit counts
 * once its click ran after the fill, the host's or the minter's.
 */
export const unsubmitted = (h: Host, open: AutofillSignInState | undefined) =>
  Effect.gen(function* () {
    if (open === undefined && h.autofillSignIn.current !== undefined) {
      yield* emit(h, {
        stage: "signed_in_refused",
        failed: "sign_in_on_replaced_browser",
      });
      return result({
        signedIn: false,
        failed: "sign_in_on_replaced_browser",
        nextStep: `The sign-in was open on a browser the host has since replaced, so nothing on this browser submitted the login. Send the sign-in screens' signInSteps again on this browser; the host fills a password or code at most once more, ${autofillRecovery}.`,
      });
    }
    yield* emit(h, {
      stage: "signed_in_refused",
      failed: "credentials_not_submitted",
    });
    return result({
      signedIn: false,
      failed: "credentials_not_submitted",
      nextStep: `No screen on this browser was submitted after the host filled the login's identifier with a password, code, or protected approval, so the host cannot take this page as signed in yet. Send each sign-in screen's signInStep (its fields and submit) first, then signedIn, ${autofillRecovery}.`,
    });
  });
