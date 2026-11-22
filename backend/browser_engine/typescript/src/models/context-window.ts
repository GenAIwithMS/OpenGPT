/**
 * The models' context window. The engine's compaction thresholds are tuned for its default
 * OpenAI models, whose long-context price boundary is 272K tokens. With smaller models
 * (OpenGPT's other providers) each threshold scales down to the configured window, minus room
 * for the reply.
 */
const tunedFor = 272_000;
const replyRoom = 16_000;
let configured: number | undefined;

/** Set by the host from its provider configuration; undefined keeps the tuned thresholds. */
export const configureContextWindow = (tokens: number | undefined) => {
  configured = tokens;
};

/** A threshold tuned for the default models, scaled to the configured window. */
export const scaledTokens = (tuned: number): number =>
  configured === undefined ? tuned : Math.floor((tuned / tunedFor) * Math.max(configured - replyRoom, 8_000));
