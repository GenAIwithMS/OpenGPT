import { report } from "./sign-in-telemetry.js";
import { Cause, Effect, Exit } from "effect";
import type { AutofillRecipeStep, RejectedMarker } from "../destinations/autofill-recipe.js";
import type { AutofillSlot, IdentifierKind } from "../destinations/autofill-step.js";
import type { AutofillHooks } from "./autofill-state.js";

/** The recipe's observed, value-free error marker, checked before another credential can go out. */
export const recordedRejections = <E>(
  hooks: Pick<AutofillHooks<E>, "markerVisible">,
  steps: readonly AutofillRecipeStep[],
  correlation: unknown = "process",
): Effect.Effect<readonly RejectedMarker["slot"][] | "unavailable"> =>
  Effect.gen(function* () {
    const markerVisible = hooks.markerVisible;
    if (markerVisible === undefined) return [];
    const markers = steps
      .flatMap((step) =>
        (step.rejectedMarkers ?? []).map((marker) => ({
          marker,
          page: step.page,
          popup: step.popup,
        })),
      )
      .sort(
        (left, right) => Number(left.marker.slot === "code") - Number(right.marker.slot === "code"),
      );
    const rejected = new Set<RejectedMarker["slot"]>();
    for (const { marker, page, popup } of markers) {
      const visible = yield* Effect.exit(
        Effect.suspend(() => markerVisible.call(hooks, marker.selector, page, popup)),
      );
      if (Exit.isFailure(visible)) {
        if (Cause.isInterrupted(visible.cause)) return yield* Effect.interrupt;
        yield* report.defect(visible.cause, {
          component: "worker",
          operation: "autofill.marker",
          subCause: "autofill_step_failed",
          correlation,
        });
        return "unavailable" as const;
      }
      if (visible.value) rejected.add(marker.slot);
    }
    return [...rejected];
  });

/**
 * Correction counts follow the held primary identifier, while public labels keep their kind. A
 * private answer is never one: no marker names it and no correction asks for it.
 */
export const logicalRejectedField = <Slot extends RejectedMarker["slot"]>(
  slot: Slot,
  primaryIdentifierKind?: IdentifierKind,
): Slot | "username" => (slot === primaryIdentifierKind ? "username" : slot);

/** Whether a filled field's value may become rejection evidence: every slot but a private answer. */
export const rejectableSlot = (slot: AutofillSlot): slot is RejectedMarker["slot"] =>
  slot !== "private_answer";
