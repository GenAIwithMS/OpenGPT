import { OperationFailure } from "../../src/runtime/kernel-operation.js";
import type { KernelExecuteClient } from "../../src/runtime/kernel-operation.js";

/** An offline run, such as a parser, has no browser: any call fails at once, having sent nothing. */
export const offlineKernel: KernelExecuteClient = {
  browsers: {
    playwright: {
      execute: () =>
        Promise.reject(
          new OperationFailure("An offline run has no browser", {
            dispatch: "not_sent",
          }),
        ),
    },
  },
};
