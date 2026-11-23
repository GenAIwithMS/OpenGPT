import { Data, Effect } from "effect";

export type VariantApplicability = "applicable" | "not_applicable" | "identity_mismatch";

export class VariantSelectionFailed extends Data.TaggedError("VariantSelectionFailed")<{
  readonly reason: "unsupported" | "ambiguous" | "identity_mismatch" | "invalid_guard";
}> {}

export interface SupportedVariant<Input, Output, Error, Services> {
  readonly id: string;
  readonly applicability: (input: Input) => Effect.Effect<VariantApplicability, Error, Services>;
  readonly run: (input: Input) => Effect.Effect<Output, Error, Services>;
}

/** Guards inspect current authorized state. Selection never retries a dispatched implementation. */
export const runSupportedVariant = <Input, Output, Error, Services>(
  variants: readonly SupportedVariant<Input, Output, Error, Services>[],
  input: Input,
): Effect.Effect<Output, Error | VariantSelectionFailed, Services> =>
  Effect.gen(function* () {
    let selected: SupportedVariant<Input, Output, Error, Services> | undefined;
    if (new Set(variants.map((variant) => variant.id)).size !== variants.length)
      return yield* new VariantSelectionFailed({ reason: "invalid_guard" });
    for (const variant of variants) {
      const state = yield* Effect.suspend(() => variant.applicability(input));
      if (state === "identity_mismatch")
        return yield* new VariantSelectionFailed({ reason: "identity_mismatch" });
      if (state === "not_applicable") continue;
      if (state !== "applicable")
        return yield* new VariantSelectionFailed({ reason: "invalid_guard" });
      if (selected) return yield* new VariantSelectionFailed({ reason: "ambiguous" });
      selected = variant;
    }
    if (!selected) return yield* new VariantSelectionFailed({ reason: "unsupported" });
    return yield* selected.run(input);
  });
