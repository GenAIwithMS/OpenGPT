import type { Dispatch } from "./errors.js";
import type { OperationFailure } from "./kernel-operation.js";

/** A completed provider call whose native browser action timed out, not a lost execution. */
export class BrowserActionTimeout extends Error {
  readonly _tag = "BrowserActionTimeout";
  readonly dispatch: Dispatch;
  constructor(failure: OperationFailure) {
    super(failure.message, { cause: failure });
    this.name = "BrowserActionTimeout";
    this.dispatch = failure.dispatch;
  }
}

/**
 * Only Kernel's failed response establishes a settled timeout: a native action's, or one of the
 * runtime's page waits that ended without its answer: no outcome, values still loading, or a control
 * not ready to act on, within its cap or once the page stopped progressing.
 */
export const nativeActionTimeout = (answer: {
  readonly success: boolean;
  readonly error?: string;
}): string | undefined =>
  answer.success === false &&
  typeof answer.error === "string" &&
  (/^(?:TimeoutError:\s*)?(?:locator|page|frame)\.[A-Za-z]+: Timeout \d+ms exceeded\b/u.test(
    answer.error,
  ) ||
    /^(?:(?:OutcomeWait|ValueWait|ReadyWait)Failure:\s*)?(?:outcome_(?:timeout|unknown)|values_(?:loading|timeout)|change_unknown|not_ready|ready_timeout) after \d+ ms\b/u.test(
      answer.error,
    ))
    ? answer.error
    : undefined;
