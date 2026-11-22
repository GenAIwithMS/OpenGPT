import type {
  BrowserExecuteOptions,
  BrowserExecuteRequest,
  BrowserExecuteResponse,
} from "./browser-execution.js";

/**
 * The part of Kernel's SDK client a script uses: `browsers.playwright.execute`. Kernel's own client
 * is one, and so is the saved-DOM stand-in.
 */
export interface KernelExecuteClient {
  readonly browsers: {
    readonly playwright: {
      readonly execute: (
        sessionId: string,
        body: BrowserExecuteRequest,
        options?: BrowserExecuteOptions,
      ) => Promise<BrowserExecuteResponse>;
    };
  };
}
/** Kernel's own limit per call. */
const maximumCallSeconds = 300;

/** Whole seconds Kernel accepts: at most 300 and at most the time left. */
export const kernelTimeoutSec = (remainingMs: number): number =>
  Math.min(maximumCallSeconds, Math.max(1, Math.floor(remainingMs / 1000)));
