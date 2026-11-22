import { Effect, Either, Schema } from "effect";
import type { BrowserExecute } from "./browser-execution.js";
import type { KernelExecuteClient } from "./kernel-execute-client.js";

const ExecuteRequest = Schema.Struct({
  code: Schema.String,
  timeout_sec: Schema.optional(Schema.Number.pipe(Schema.between(1, 300))),
});

const RequestOptions = Schema.Struct({
  maxRetries: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
  timeout: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
});

/**
 * The native executor's generated-code view. Session checks and request deadlines happen
 * before dispatch; SDK retry options never replay a native website action.
 */
export const makeKernelCompatibility = (
  sessionId: string,
  executeResponse: BrowserExecute,
): KernelExecuteClient => ({
  browsers: {
    playwright: {
      execute: (requestedSessionId, body, options) =>
        Effect.runPromise(
          Effect.either(
            Effect.gen(function* () {
              if (options?.signal?.aborted) {
                const reason: unknown = options.signal.reason;
                return yield* Effect.fail(
                  reason instanceof Error
                    ? reason
                    : new Error("Browser execution aborted before dispatch", { cause: reason }),
                );
              }
              if (requestedSessionId !== sessionId)
                return yield* Effect.fail(new Error("Browser execution session does not match"));
              const request = yield* Schema.decodeUnknown(ExecuteRequest)(body).pipe(
                Effect.mapError(
                  (cause) => new Error("Invalid browser execution request", { cause }),
                ),
              );
              const requestOptions = yield* Schema.decodeUnknown(RequestOptions)(
                options ?? {},
              ).pipe(
                Effect.mapError(
                  (cause) => new Error("Invalid browser execution options", { cause }),
                ),
              );
              const execution = executeResponse(request.code, request.timeout_sec ?? 60);
              return yield* requestOptions.timeout === undefined
                ? execution
                : execution.pipe(
                    Effect.timeoutFail({
                      duration: requestOptions.timeout,
                      onTimeout: () => new Error("Browser execution transport timed out"),
                    }),
                  );
            }),
          ),
          options?.signal === undefined || options.signal === null
            ? {}
            : { signal: options.signal },
        ).then((answer) => {
          if (Either.isLeft(answer)) throw answer.left;
          return answer.right;
        }),
    },
  },
});
