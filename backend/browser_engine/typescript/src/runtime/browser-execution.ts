import { Schema } from "effect";
import type { Effect } from "effect";

/** The answered script envelope, independent of the execution transport. */
export const BrowserExecuteResponse = Schema.Struct({
  success: Schema.Boolean,
  error: Schema.optionalWith(Schema.String, { exact: true }),
  result: Schema.optionalWith(Schema.Unknown, { exact: true }),
  stderr: Schema.optionalWith(Schema.String, { exact: true }),
  stdout: Schema.optionalWith(Schema.String, { exact: true }),
});

export type BrowserExecuteResponse = typeof BrowserExecuteResponse.Type;

export interface BrowserExecuteRequest {
  readonly code: string;
  readonly timeout_sec?: number;
}

/** Only the SDK request options used by browser execution callers. */
export interface BrowserExecuteOptions {
  readonly maxRetries?: number;
  readonly timeout?: number;
  readonly signal?: AbortSignal | null;
}

/** Failed Effects mean no script answer was received; script errors remain in the envelope. */
export type BrowserExecute = (
  code: string,
  timeoutSec?: number,
) => Effect.Effect<BrowserExecuteResponse, Error>;
