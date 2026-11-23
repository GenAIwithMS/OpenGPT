import { Data } from "effect";

/** A site's bot challenge that Kernel's automatic solver did not clear in time. */
export class ChallengeFailure extends Data.TaggedError("ChallengeFailure")<{
  readonly code: "Unavailable";
  /** Set only by `waitPastChallenge`: how long Kernel's automatic solver had before failing. */
  readonly solverWaitMs?: number;
}> {}

/** The solver window `waitPastChallenge` gives a bot challenge before it fails. */
export const challengeSolverWaitMs = 30_000;
