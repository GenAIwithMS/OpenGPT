import { lunaModel } from "../models/models.js";

/**
 * The reasoning efforts a host may pick for one review through `specialize`. Every review runs on
 * the same model, so a session's history stays valid across reviews of different efforts.
 */
export type GuardianReasoningEffort = "low" | "medium";

/** Execution and question reviews share the user's selected Guardian configuration. */
export const guardianModel = {
  model: lunaModel,
  modelSettings: { store: false, reasoning: { effort: "medium" as GuardianReasoningEffort } },
};

/**
 * How long one Guardian model call may go without a response, and how many times the reviewer
 * sends that same call again when it does. A review has no deadline of its own: its turn limit
 * bounds how much it reads, and this bounds each call. Five minutes leaves room for a call in
 * which the provider compacts a long conversation.
 */
export interface GuardianModelCallBound {
  readonly timeoutMs: number;
  readonly retries: number;
}

export const guardianModelCallBound: GuardianModelCallBound = { timeoutMs: 300_000, retries: 2 };

/**
 * @deprecated A review no longer has a deadline, and nothing in the package reads this. A review
 * is bounded by its turn limit, which ends in one turn that must decide, and by
 * `guardianModelCallBound` on each model call. Kept so a host that imports it still loads; it will
 * be removed.
 */
export const guardianReviewTimeout = (developmentPublicRead: boolean, publication = false) =>
  developmentPublicRead ? 600_000 : publication ? 300_000 : 120_000;
