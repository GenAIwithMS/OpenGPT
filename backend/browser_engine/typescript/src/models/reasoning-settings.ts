import type { ModelSettings } from "@openai/agents";
import { Schema } from "effect";

/** Settings that help model quality are always on for every runtime agent. With `store:false`
 * the provider keeps no conversation state, so each response must return its encrypted
 * reasoning (`reasoning.encrypted_content`) and the SDK sends those items back on the next
 * turn, carrying reasoning across turns and continuations. Readable summaries are requested
 * too. None of our agents use hosted tools that add their own `include` entries; the SDK
 * replaces its tool-derived `include` with this provider-data value. */
export const withReasoningContinuity = (settings: ModelSettings): ModelSettings => ({
  ...settings,
  store: false,
  reasoning: { ...settings.reasoning, summary: "auto" },
  providerData: { ...settings.providerData, include: ["reasoning.encrypted_content"] },
});

/** The reasoning context the provider applied to a response, as it reports it. A model that
 * ignores `all_turns` drops earlier turns' reasoning from the render, which also rewrites the
 * cached prompt from the first such item. */
export const effectiveReasoningContext = (
  providerData: unknown,
): "all_turns" | "current_turn" | "not_reported" => {
  const metadata = Schema.decodeUnknownEither(
    Schema.Struct({
      reasoning: Schema.Struct({ context: Schema.Literal("all_turns", "current_turn") }),
    }),
  )(providerData);
  return metadata._tag === "Right" ? metadata.right.reasoning.context : "not_reported";
};
