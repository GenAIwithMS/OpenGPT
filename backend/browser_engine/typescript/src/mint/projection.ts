import type { Effect } from "effect";
import type { MintFailure } from "./contracts.js";

/** Explicit model/source projection supplied by the composition that owns secret values. */
export interface MintProjection {
  readonly text: (value: string, area?: "model" | "review") => Effect.Effect<string, MintFailure>;
  readonly json: (value: unknown) => Effect.Effect<unknown, MintFailure>;
  readonly source: (path: string, value: string) => Effect.Effect<string, MintFailure>;
}
