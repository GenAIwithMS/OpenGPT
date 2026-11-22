import { Effect } from "effect";
import { runCardFill } from "../destinations/card-fill.js";
import { paymentFrameOrigins } from "../destinations/payment-frames.js";
import type { LocalOperationOptions } from "../execution/local-operation.js";
import type { StandaloneSession } from "./session.js";

/**
 * The local host's card fill for a script's `fillCard`, on the session's browser: the card-fill
 * step's checks on `siteOrigin`, with no review of its own, since Guardian reviewed the build step
 * that runs the script or the published script itself. Once a value was typed into the page, a
 * refusal names only the site's and the listed origins.
 */
export const sessionCardFill =
  (session: StandaloneSession, siteOrigin: string): NonNullable<LocalOperationOptions["cardFill"]> =>
  ({ step, handles }) =>
    runCardFill({
      step,
      handles,
      page: session.browser,
      keyboard: session.browser.keyboard,
      siteOrigin,
      judgedBeforeTyping: session.signInTyping.typed ? [...paymentFrameOrigins] : undefined,
      review: () => Effect.void,
      beforeTyping: () =>
        Effect.sync(() => {
          session.signInTyping.typed = true;
        }),
    });
