import { Effect } from "effect";

/**
 * The one set of budgets the runtime's waits apply and the authoring skills quote.
 *
 * - `navigation`: a `goto` or URL wait, to document commit.
 * - `action`: a click, fill, press or select on an element a wait has shown ready, and every action
 *   in an exploration probe.
 * - `answer`: how long a wait goes on with no visible progress before it fails.
 * - `answerCap`: the hard cap on an answer wait while the page keeps progressing.
 * - `settle`: the gap between the two looks that must agree on the values a tool returns.
 * - `unchanged`: how long an answer or value from before an action must hold to count as unchanged.
 * - `lateFillCap`: the cap on waiting for values the site fills in after its answer.
 */
export const timeoutDefaults = {
  execution: 20 * 60_000,
  action: 5_000,
  readiness: 5_000,
  navigation: 30_000,
  answer: 8_000,
  answerCap: 30_000,
  settle: 500,
  unchanged: 2_000,
  lateFillCap: 15_000,
  http: 60_000,
} as const;

export class Deadline {
  private pausedAt: number | undefined;
  private pausedMilliseconds = 0;
  private suspensionCount = 0;
  private constructor(
    private readonly activeExpiresAt: number,
    private readonly now: () => number,
    private readonly parentRemaining?: () => number,
  ) {}

  get expiresAt(): number {
    return this.now() + this.remainingMs();
  }

  /** Trusted holds pause the active budget; each caller owns and releases its suspension. */
  suspend(): () => void {
    if (this.suspensionCount === 0) this.pausedAt = this.now();
    this.suspensionCount += 1;
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      this.suspensionCount -= 1;
      if (this.suspensionCount === 0 && this.pausedAt !== undefined) {
        this.pausedMilliseconds += Math.max(0, this.now() - this.pausedAt);
        this.pausedAt = undefined;
      }
    };
  }

  /** Observe changes made by challenge suspension instead of freezing a wall timeout. */
  readonly awaitExpiry: Effect.Effect<void> = Effect.suspend(() => {
    const remaining = this.remainingMs();
    return remaining <= 0
      ? Effect.void
      : Effect.sleep(Math.min(remaining, 100)).pipe(Effect.zipRight(this.awaitExpiry));
  });

  static after(milliseconds = timeoutDefaults.execution, now = () => performance.now()): Deadline {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
      throw new RangeError("A deadline requires a positive finite duration");
    }
    return new Deadline(now() + milliseconds, now);
  }

  remainingMs(): number {
    const now = this.now();
    const pause =
      this.pausedMilliseconds +
      (this.pausedAt === undefined ? 0 : Math.max(0, now - this.pausedAt));
    return Math.max(
      0,
      Math.min(this.activeExpiresAt + pause - now, this.parentRemaining?.() ?? Infinity),
    );
  }

  limitTo(other: Deadline): Deadline {
    return new Deadline(Infinity, this.now, () =>
      Math.min(this.remainingMs(), other.remainingMs()),
    );
  }

  child(milliseconds: number): Deadline {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
      throw new RangeError("A deadline requires a positive finite duration");
    }
    return new Deadline(this.now() + milliseconds, this.now, () => this.remainingMs());
  }
}
