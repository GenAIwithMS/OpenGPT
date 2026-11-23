import type { Effect } from "effect";
import { timeoutDefaults } from "./deadline.js";

/** One browser's host calls: plain Playwright code with `page`, `context` and `browser`. */
export type HostExecute = (code: string, timeoutSec?: number) => Effect.Effect<unknown, Error>;

/**
 * The code a host call starts with to bind `name` to the tab with this target id, which may not
 * be Kernel's foreground `page`. It fails when that tab is closed.
 */
export const pageCode = (targetId: string, name: string) => `
const ${name} = await (async () => {
  for (const candidate of context.pages()) {
    const session = await context.newCDPSession(candidate);
    try {
      const { targetInfo } = await session.send("Target.getTargetInfo");
      if (targetInfo.targetId === ${JSON.stringify(targetId)}) return candidate;
    } finally {
      await session.detach().catch(() => undefined);
    }
  }
  throw new Error("Page closed");
})();
`;

/** Binds `primary` to the browser's primary tab; see `pageCode`. */
export const primaryPageCode = (targetId: string) => pageCode(targetId, "primary");

/**
 * An exploration probe's call code: the runtime's action budget as the page's default timeout
 * while it runs, navigation kept at its own budget, and Playwright's default put back after. A
 * probe's locator that matches nothing then fails in seconds with Playwright's own timeout error,
 * not after 30 s. A host wraps every call an exploration probe makes, and nothing else.
 */
export const probeCallCode = (code: string, actionMs: number = timeoutDefaults.action) => `page.setDefaultNavigationTimeout(${timeoutDefaults.navigation});
page.setDefaultTimeout(${actionMs});
try {
${code}
} finally {
  page.setDefaultTimeout(${timeoutDefaults.navigation});
}`;
