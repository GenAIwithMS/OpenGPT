import { Effect } from "effect";
import type { YieldableError } from "effect/Cause";
import { approvalNumberOf, type AutofillPopup } from "../destinations/autofill-contracts.js";
import type { SignInRecipeStep } from "../destinations/sign-in-recipe.js";
import { leftSignInScreens } from "./autofill-replay-pages.js";
import { returnedCredential, type Replay } from "./autofill-replay-session.js";
import type { AutofillReplayInput } from "./autofill-replay-steps.js";
import type { AutofillHooks } from "./autofill-state.js";
import type { AutofillLogin } from "./autofill-values.js";

/**
 * The number a device approval's screen shows for the owner to pick, read once from its
 * `matchSelector` element: kept only when it is 1 to 3 digits (`approvalNumberOf`). None without a
 * selector, from a host that can't read one, or when the read fails, and nothing else of the page
 * is kept.
 */
export const approvalNumber = <E>(
  hooks: Pick<AutofillHooks<E>, "approvalNumber">,
  matchSelector: string | undefined,
  page: string,
  popup: AutofillPopup | undefined,
) => {
  const read = hooks.approvalNumber;
  if (matchSelector === undefined || read === undefined) return Effect.succeed(undefined);
  return read.call(hooks, matchSelector, page, popup).pipe(
    Effect.map(approvalNumberOf),
    Effect.orElseSucceed(() => undefined),
  );
};

/** A device approval's confirmation, naming the number to pick when its screen showed one. */
export const withApprovalNumber = (prompt: string, number: string | undefined) =>
  number === undefined ? prompt : `${prompt} If it asks you to choose a number, pick ${number}.`;

/** A page's origin, scheme, host and port; none for an opaque one, which matches nothing. */
const originOf = (page: string) => {
  const origin = URL.parse(page)?.origin;
  return origin === undefined || origin === "null" ? undefined : origin;
};

/**
 * Whether the page shown after the previous screen's submit is a recorded approval's screen, where
 * the owner approves the sign-in off the page. The recorded page is admitted as before. A site's
 * approval page often holds a code of its own in its path, and a recording may have saved the page
 * the site showed once the owner approved, so a new browser shows neither: any other page on the
 * recorded page's origin (`recordedPage`, a workspace screen's as this replay knows it) is
 * admitted too, unless it is one of the recorded screens or the entry page, shows a password field
 * or the credential screen the replay submitted again, or shows the signed-in marker already, which
 * signed the browser in with no approval (`signed_in`, which the sign-in's own check then verifies).
 * A page on any other origin is never admitted. Anything not admitted ends as before
 * (`screen_changed`).
 */
export const approvalScreen = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  recorded: SignInRecipeStep,
  recordedPage: string,
  page: string,
) =>
  Effect.gen(function* () {
    if (replay.matchesRecorded(page, recorded)) return "admitted" as const;
    const origin = originOf(recordedPage);
    if (
      origin === undefined ||
      originOf(page) !== origin ||
      !leftSignInScreens(replay.onScreens, input.entryUrl, page)
    )
      return "screen_changed" as const;
    const here = yield* replay.checkHere;
    if (here.signedIn) {
      yield* input.emit({ stage: "skipped", reason: "signed_in_indicator" });
      return "signed_in" as const;
    }
    if ("passwordFieldVisible" in here && here.passwordFieldVisible === true)
      return "screen_changed" as const;
    const returned = yield* returnedCredential({
      progress: replay.progress,
      sent: replay.sent,
      hooks: input.hooks,
    });
    return returned === undefined ? ("admitted" as const) : ("screen_changed" as const);
  });
