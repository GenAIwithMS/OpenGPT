import { Effect, Exit } from "effect";
import { DialogFailure } from "./contracts.js";

export interface DialogActionPort {
  readonly begin: (pageId: string, actionId: string) => Effect.Effect<void, DialogFailure>;
  readonly end: (
    pageId: string,
    actionId: string,
    outcome: "completed" | "failed",
  ) => Effect.Effect<void, DialogFailure>;
}
/** Explicit opt-in: keep this same native action and its postcondition alive while the host holds a dialog. */
export const withDialogAction = <A>(
  port: DialogActionPort,
  identity: { readonly pageId: string; readonly actionId: string },
  actionAndPostcondition: (options: { readonly timeout: 0 }) => Promise<A>,
) =>
  Effect.gen(function* () {
    let cleanupFailure: DialogFailure | undefined;
    const result = yield* Effect.exit(
      Effect.acquireUseRelease(
        port.begin(identity.pageId, identity.actionId),
        () =>
          Effect.tryPromise({
            try: () => actionAndPostcondition({ timeout: 0 }),
            catch: () => new DialogFailure({ reason: "unavailable" }),
          }),
        (_, exit) =>
          port
            .end(identity.pageId, identity.actionId, Exit.isSuccess(exit) ? "completed" : "failed")
            .pipe(
              Effect.catchAll((error) =>
                Effect.sync(() => {
                  cleanupFailure = error;
                }),
              ),
            ),
      ),
    );
    if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
    if (cleanupFailure) return yield* cleanupFailure;
    return result.value;
  });
