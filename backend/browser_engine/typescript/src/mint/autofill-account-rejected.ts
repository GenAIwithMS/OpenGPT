import { Cause, Effect, Exit } from "effect";
import type { SignInStep } from "./contracts.js";
import { report } from "../runtime/sign-in-telemetry.js";
import type { AutofillSignInState } from "../runtime/autofill-state.js";
import { type AutofillHost, autofillRecovery } from "./autofill-results.js";

/**
 * The minter's report that the site refused the account itself, not a field: the page the login's
 * submit led to says the account is locked or suspended, and `selector` names that message on the
 * page (the sign-in step `rejected: { account, selector }`).
 */
export type AccountRejection = Extract<
  Extract<SignInStep, { readonly rejected: unknown }>["rejected"],
  { readonly account: unknown }
>;

/** Whether `selector` shows on the page the open sign-in's last screen led to, or `unavailable`. */
export const markerShown = (h: AutofillHost, open: AutofillSignInState, selector: string) =>
  Effect.gen(function* () {
    const page = open.steps.at(-1)?.page;
    const markerVisible = open.hooks.markerVisible;
    if (page === undefined || markerVisible === undefined) return false;
    const shown = yield* Effect.exit(
      Effect.suspend(() =>
        markerVisible.call(open.hooks, selector, page, open.steps.at(-1)?.popup),
      ),
    );
    if (Exit.isSuccess(shown)) return shown.value;
    if (Cause.isInterrupted(shown.cause)) return yield* Effect.interrupt;
    yield* report.defect(shown.cause, {
      component: "mint",
      operation: "autofill.account_marker",
      subCause: "autofill_step_failed",
      correlation: h.reportCorrelation,
    });
    return "unavailable" as const;
  });

/** What the minter reads when the host takes no verdict on the account from its report. */
export const noVerdictNotices = {
  nothing_rejected: `No screen of an open sign-in on this browser submitted the login, so the site cannot have refused its account. Send the sign-in screens' signInSteps first, ${autofillRecovery}.`,
  sign_in_on_replaced_browser: `The sign-in was open on a browser the host has since replaced, so this browser's page cannot be its answer. Send the sign-in screens' signInSteps again on this browser, ${autofillRecovery}.`,
  marker_matches_signed_out_page: `This marker also shows on a page the host saw signed out, before the login was sent, so it cannot tell a lock message from the rest of the site. Report the account again with a selector of the message itself, ${autofillRecovery}.`,
  marker_unchecked:
    "The host has no signed-out page of this site to compare the marker against, so it cannot tell a lock message from the rest of the site.",
  no_rejection_marker: `The marker does not show on the page the sign-in led to, so the host takes no verdict on the account. Explore read-only to see the page, and report the account again with a selector of the message it shows, ${autofillRecovery}.`,
} as const;
