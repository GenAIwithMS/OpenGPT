import { Effect } from "effect";
import type { WebsiteCredentials } from "./authentication.js";

/**
 * The login a run signs in with. A saved login's values are read only when
 * its value-free sign-in check fails, never up front: until then the run holds its directory
 * record alone. An inline login, a correction the caller made and a revision that signs in only by
 * its direct request hold their values from the start.
 */
export interface RunLogin<E> {
  /** It signs in without a password, so the direct sign-in request never applies. */
  readonly passwordless: boolean;
  /** The values the run holds, or undefined while it has read none. */
  readonly held: () => WebsiteCredentials | undefined;
  /**
   * The values: those held, else one read for the whole attempt. A read that failed stays failed,
   * so a sign-in that tries again never reads again. Every value read is registered with the
   * broker before it is returned, so masking covers it before any fill.
   */
  readonly values: Effect.Effect<WebsiteCredentials, E>;
  /** A login the caller corrected in place replaces what the run holds. */
  readonly hold: (credentials: WebsiteCredentials) => void;
}

export const makeRunLogin = <E>(options: {
  readonly held?: WebsiteCredentials | undefined;
  readonly passwordless: boolean;
  readonly read: Effect.Effect<WebsiteCredentials, E>;
  readonly register: (credentials: WebsiteCredentials) => Effect.Effect<void, E>;
}): Effect.Effect<RunLogin<E>> =>
  Effect.gen(function* () {
    let held = options.held;
    const read = yield* Effect.cached(
      options.read.pipe(
        Effect.tap(options.register),
        Effect.tap((credentials) =>
          Effect.sync(() => {
            held ??= credentials;
          }),
        ),
      ),
    );
    return {
      passwordless: options.passwordless,
      held: () => held,
      values: Effect.suspend(() => (held === undefined ? read : Effect.succeed(held))),
      hold: (credentials) => {
        held = credentials;
      },
    };
  });
