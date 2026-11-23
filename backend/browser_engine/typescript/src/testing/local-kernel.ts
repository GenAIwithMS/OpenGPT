import { runInThisContext } from "node:vm";
import type { Page } from "playwright";
import type { KernelExecuteClient } from "../runtime/kernel-operation.js";

type Execute = KernelExecuteClient["browsers"]["playwright"]["execute"];

/**
 * Kernel's execute over a local saved-DOM page, so a Kernel script's offline test runs unchanged.
 * Each call's code runs as an async function body with `page`, `context` and `browser`, bounded
 * by its `timeout_sec`, and its result goes through JSON as Kernel's does.
 */
export const makeLocalKernel = (page: Page): KernelExecuteClient => {
  const execute: Execute = async (_sessionId, body) => {
    const limitMs = Math.min(300, Math.max(1, body.timeout_sec ?? 60)) * 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The code is the script's own call body, run on the saved page as Kernel runs it.
      const run: unknown = runInThisContext(
        `(async (page, context, browser) => {\n${body.code}\n})`,
      );
      if (typeof run !== "function") throw new Error("Call code unavailable");
      const value: unknown = await Promise.race([
        Reflect.apply(run, undefined, [page, page.context(), page.context().browser()]),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Execution timed out")), limitMs);
        }),
      ]);
      const result: unknown = value === undefined ? undefined : JSON.parse(JSON.stringify(value));
      return { success: true, result };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack !== undefined ? { stderr: error.stack } : {}),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  return { browsers: { playwright: { execute } } };
};
