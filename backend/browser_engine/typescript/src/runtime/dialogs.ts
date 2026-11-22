import { Data, Schema } from "effect";

/**
 * The native dialog contracts a Kernel script shares with the host. They sit in the runtime so the
 * sandbox's Kernel runtime can use them; `browser/dialogs/contracts.ts` re-exports them.
 */
export class DialogFailure extends Data.TaggedError("DialogFailure")<{
  readonly reason:
    | "invalid_request"
    | "unavailable"
    | "unauthorized"
    | "stale_decision"
    | "action_conflict"
    | "expired"
    | "screening_failed";
}> {}
export const DialogType = Schema.Literal("alert", "confirm", "prompt", "beforeunload");
export type DialogType = typeof DialogType.Type;
export const DialogChoice = Schema.Union(
  Schema.Struct({ choice: Schema.Literal("accept"), promptText: Schema.optional(Schema.String) }),
  Schema.Struct({ choice: Schema.Literal("dismiss") }),
);
export type DialogChoice = typeof DialogChoice.Type;
