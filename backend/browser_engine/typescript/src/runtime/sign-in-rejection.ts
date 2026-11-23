import { Effect, Option, Schema } from "effect";
import type { KernelExecuteClient } from "./kernel-execute-client.js";
import { CredentialRejectedField } from "./authentication.js";
import { kernelTimeoutSec } from "./kernel-execute-client.js";
import type { Deadline } from "./deadline.js";
import { CredentialsRejected, OperationFailure } from "./operation-failure.js";

/** A value-free field marker observed on the authorized page. */
export interface SignInRejectionMarker {
  readonly field: CredentialRejectedField;
  readonly selector: string;
}

/** Reads only marker visibility; malformed or unavailable inspection keeps its failure. */
export const inspectSignInRejection = (
  options: {
    readonly kernel: KernelExecuteClient;
    readonly sessionId: string;
    readonly deadline: Deadline;
  },
  request: SignInRejectionMarker,
) =>
  Effect.gen(function* () {
    const parsed = Schema.decodeUnknownOption(
      Schema.Struct({
        field: CredentialRejectedField,
        selector: Schema.NonEmptyString.pipe(Schema.maxLength(1000)),
      }),
    )(request);
    if (Option.isNone(parsed))
      return yield* Effect.fail(new OperationFailure("Invalid sign-in rejection marker"));
    const { field, selector } = parsed.value;
    const remainingMs = options.deadline.remainingMs();
    const answer = yield* Effect.tryPromise({
      try: () =>
        options.kernel.browsers.playwright.execute(
          options.sessionId,
          {
            code: `return await page.locator(${JSON.stringify(selector)}).isVisible();`,
            timeout_sec: kernelTimeoutSec(remainingMs),
          },
          { maxRetries: 0, timeout: remainingMs },
        ),
      catch: (cause) => new OperationFailure("Sign-in rejection marker unavailable", { cause }),
    });
    if (answer.success !== true)
      return yield* Effect.fail(
        new OperationFailure("Sign-in rejection marker unavailable", {
          stderr: answer.stderr,
          cause: answer.stderr ? undefined : answer.error,
        }),
      );
    if (answer.result !== true && answer.result !== false)
      return yield* Effect.fail(new OperationFailure("Invalid sign-in rejection marker result"));
    if (answer.result === true) return yield* Effect.fail(new CredentialsRejected(field));
  });
