import { Deferred, Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserExecuteResponse } from "../../src/runtime/browser-execution.js";
import { makeKernelCompatibility } from "../../src/runtime/kernel-compatibility.js";

afterEach(() => vi.useRealTimers());

describe("generated browser execution compatibility", () => {
  it.each<BrowserExecuteResponse>([
    { success: true, result: { count: 2 }, stdout: "read two rows\n", stderr: "warning\n" },
    {
      success: false,
      error: "selector unavailable",
      stdout: "started\n",
      stderr: "Error: selector unavailable\n    at call",
    },
    { success: true },
    { success: true, result: undefined },
    { success: true, result: null },
  ])("preserves the answered script envelope %#", async (response) => {
    const kernel = makeKernelCompatibility("owned", () => Effect.succeed(response));
    const answer = await kernel.browsers.playwright.execute("owned", {
      code: "return await page.title();",
    });
    expect(answer).toStrictEqual(response);
    expect(Object.hasOwn(answer, "result")).toBe(Object.hasOwn(response, "result"));
  });

  it("rejects with the original transport error and never retries a possibly sent write", async () => {
    const transport = new Error("connection lost after submission", {
      cause: new Error("socket closed"),
    });
    let submissions = 0;
    const kernel = makeKernelCompatibility("owned", () =>
      Effect.sync(() => {
        submissions += 1;
      }).pipe(Effect.zipRight(Effect.fail(transport))),
    );
    await expect(
      kernel.browsers.playwright.execute(
        "owned",
        { code: "await page.getByRole('button').click();" },
        { maxRetries: 5 },
      ),
    ).rejects.toBe(transport);
    expect(submissions).toBe(1);
  });

  it("retains the generated SDK default and explicit script deadlines", async () => {
    const kernel = makeKernelCompatibility("owned", (_code, timeoutSec) =>
      Effect.succeed({ success: true, result: timeoutSec }),
    );
    await expect(
      kernel.browsers.playwright.execute("owned", { code: "return await page.title();" }),
    ).resolves.toEqual({ success: true, result: 60 });
    await expect(
      kernel.browsers.playwright.execute("owned", {
        code: "return await page.title();",
        timeout_sec: 30,
      }),
    ).resolves.toEqual({ success: true, result: 30 });
    await expect(
      kernel.browsers.playwright.execute("owned", {
        code: "return await page.title();",
        timeout_sec: 300,
      }),
    ).resolves.toEqual({ success: true, result: 300 });
  });

  it.each([0, -1, NaN, Infinity, 301])(
    "rejects script timeout %s before website execution",
    async (timeout_sec) => {
      let writes = 0;
      const kernel = makeKernelCompatibility("owned", () =>
        Effect.sync(() => {
          writes += 1;
          return { success: true };
        }),
      );
      await expect(
        kernel.browsers.playwright.execute("owned", {
          code: "await page.click('button');",
          timeout_sec,
        }),
      ).rejects.toThrow("Invalid browser execution request");
      expect(writes).toBe(0);
    },
  );

  it.each([
    { timeout: 0 },
    { timeout: -1 },
    { timeout: 1.5 },
    { timeout: Infinity },
    { maxRetries: -1 },
    { maxRetries: 0.5 },
  ])("rejects malformed request options %j before website execution", async (options) => {
    let writes = 0;
    const kernel = makeKernelCompatibility("owned", () =>
      Effect.sync(() => {
        writes += 1;
        return { success: true };
      }),
    );
    await expect(
      kernel.browsers.playwright.execute("owned", { code: "await page.click('button');" }, options),
    ).rejects.toThrow("Invalid browser execution options");
    expect(writes).toBe(0);
  });

  it("rejects a foreign session and malformed external code before website execution", async () => {
    let writes = 0;
    const kernel = makeKernelCompatibility("owned", () =>
      Effect.sync(() => {
        writes += 1;
        return { success: true };
      }),
    );
    await expect(
      kernel.browsers.playwright.execute("foreign", { code: "await page.click('button');" }),
    ).rejects.toThrow("session does not match");
    const malformed: unknown = Reflect.apply(kernel.browsers.playwright.execute, undefined, [
      "owned",
      { code: 17 },
    ]);
    expect(malformed).toBeInstanceOf(Promise);
    await expect(malformed).rejects.toThrow("Invalid browser execution request");
    expect(writes).toBe(0);
  });

  it("does not dispatch an already aborted request", async () => {
    const controller = new AbortController();
    const cancellation = new Error("Caller cancelled before execution");
    controller.abort(cancellation);
    let writes = 0;
    const kernel = makeKernelCompatibility("owned", () =>
      Effect.sync(() => {
        writes += 1;
        return { success: true };
      }),
    );
    await expect(
      kernel.browsers.playwright.execute(
        "owned",
        { code: "await page.click('button');" },
        { signal: controller.signal },
      ),
    ).rejects.toBe(cancellation);
    expect(writes).toBe(0);
  });

  it.each(["abort", "timeout"] as const)(
    "%s interrupts one execution and waits for cleanup before rejection",
    async (mode) => {
      if (mode === "timeout") vi.useFakeTimers();
      const started = await Effect.runPromise(Deferred.make<void>());
      const cleanupStarted = await Effect.runPromise(Deferred.make<void>());
      const cleanupAllowed = await Effect.runPromise(Deferred.make<void>());
      const controller = new AbortController();
      let writes = 0;
      let cleanups = 0;
      let settled = false;
      const kernel = makeKernelCompatibility("owned", () =>
        Effect.sync(() => {
          writes += 1;
        }).pipe(
          Effect.zipRight(Deferred.succeed(started, undefined)),
          Effect.zipRight(Effect.never),
          Effect.onInterrupt(() =>
            Deferred.succeed(cleanupStarted, undefined).pipe(
              Effect.zipRight(Deferred.await(cleanupAllowed)),
              Effect.zipRight(
                Effect.sync(() => {
                  cleanups += 1;
                }),
              ),
            ),
          ),
        ),
      );
      const answer = kernel.browsers.playwright
        .execute(
          "owned",
          { code: "await page.click('button');" },
          {
            signal: controller.signal,
            maxRetries: 2,
            ...(mode === "timeout" ? { timeout: 100 } : {}),
          },
        )
        .then(
          (value) => {
            settled = true;
            return value;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
      await Effect.runPromise(Deferred.await(started));
      if (mode === "abort") controller.abort();
      else await vi.advanceTimersByTimeAsync(100);
      await Effect.runPromise(Deferred.await(cleanupStarted));
      expect(settled).toBe(false);
      expect(writes).toBe(1);
      await Effect.runPromise(Deferred.succeed(cleanupAllowed, undefined));
      const failure = await answer;
      expect(failure).toBeInstanceOf(Error);
      if (mode === "timeout")
        expect(failure).toEqual(new Error("Browser execution transport timed out"));
      expect(cleanups).toBe(1);
      expect(writes).toBe(1);
    },
  );
});
