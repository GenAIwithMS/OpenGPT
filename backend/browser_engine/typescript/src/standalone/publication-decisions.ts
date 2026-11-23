import { Effect } from "effect";
import type { PublicationDecision, PublicationDecisionLog } from "../mint/contracts.js";

/**
 * The local host's publication decisions: kept in memory for one mint request, whose runs share
 * them. The local host has no takeover, so nothing outlives the request.
 */
export const memoryPublicationDecisions = (): PublicationDecisionLog => {
  const decisions: PublicationDecision[] = [];
  return {
    record: (decision) =>
      Effect.sync(() => {
        decisions.push(decision);
      }),
    list: Effect.sync(() => [...decisions]),
  };
};
