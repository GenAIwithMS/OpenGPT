import { Effect } from "effect";
import { judgedOrigins } from "./autofill-refusal.js";
import type {
  AutofillInspection,
  AutofillRefusal,
  AutofillStep,
  AutofillStepReport,
} from "./autofill-step.js";

/**
 * A browser's autofill inspections and fills, which remember while this worker holds the browser
 * whether the host typed into its page: a refund, a corrected login or a relogin on that browser
 * never forgets it, nor does a field the page emptied after typing. A worker that
 * rejoins a browser its predecessor held cannot know what that one typed, so it starts as typed
 * (`typed`). A host whose other fills type into the same browser, such as a card fill, passes
 * `typed` as a function that reads its shared record, so each inspection reads it as it stands
 * then. Until something was typed,
 * each inspection's judged origins hold no typed value; from then on, an inspection may name only
 * those (`judgedBeforeTyping`) besides the site's and configured sign-in origins, since the page
 * may have put a typed value in any other, such as a form action's host.
 */
export const rememberTyping = <
  Fill extends { readonly inspection: AutofillInspection },
  EI,
  EF,
>(calls: {
  readonly inspect: (request: {
    readonly step: AutofillStep;
    readonly judgedBeforeTyping: readonly string[] | undefined;
  }) => Effect.Effect<AutofillRefusal | AutofillInspection, EI>;
  readonly fill: (input: Fill) => Effect.Effect<AutofillStepReport, EF>;
  readonly typed?: boolean | (() => boolean);
}) => {
  let typedHere = false;
  const shared = calls.typed;
  const typedNow = () =>
    typedHere || (typeof shared === "function" ? shared() === true : shared === true);
  const judged = new Set<string>();
  return {
    inspect: (step: AutofillStep) => {
      const typed = typedNow();
      return calls.inspect({ step, judgedBeforeTyping: typed ? [...judged] : undefined }).pipe(
        Effect.tap((inspected) =>
          Effect.sync(() => {
            if (!typed && !("outcome" in inspected))
              for (const origin of judgedOrigins(inspected)) judged.add(origin);
          }),
        ),
      );
    },
    fill: (input: Fill) =>
      calls.fill(input).pipe(
        Effect.tap((report) =>
          Effect.sync(() => {
            if (report.outcome !== "refused" && report.typed === true) typedHere = true;
          }),
        ),
      ),
  };
};
