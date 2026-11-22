import { readFile } from "node:fs/promises";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import type { Scope } from "effect";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";
import {
  ExecutionContext,
  makeEffectJournal,
  makeEffectJournalWith,
} from "../../src/runtime/context.js";
import { Deadline } from "../../src/runtime/deadline.js";
import { CaptureUnavailable } from "../../src/runtime/errors.js";
import type { KernelExecuteClient } from "../../src/runtime/kernel-operation.js";
import { executeKernelOperation } from "../../src/runtime/kernel-operation-run.js";
import { commitReportOf } from "../../src/runtime/run-outcome.js";
import { defineOperation } from "../../src/runtime/operation.js";
import { offlineKernel } from "../support/offline-kernel.js";

/** A browser that answers every call with success, without provider HTTP. */
const answeringKernel: KernelExecuteClient = {
  browsers: { playwright: { execute: async () => ({ success: true, result: null }) } },
};

const run = async <A, E>(
  program: Effect.Effect<A, E, ExecutionContext | Scope.Scope>,
  journalOf = makeEffectJournal,
  deadline = Deadline.after(60_000),
) => {
  const journal = await Effect.runPromise(journalOf);
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      program.pipe(
        Effect.provideService(ExecutionContext, {
          deadline,
          journal,
          events: { emit: () => Effect.void },
          capture: { start: Effect.void, finish: Effect.void },
        }),
      ),
    ),
  );
  return { exit, websiteEffect: await Effect.runPromise(journal.state) };
};

const failureOf = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) throw new Error("Expected the script to fail");
  return Cause.failureOption(exit.cause);
};

describe("executeKernelOperation", () => {
  it("returns the script's result and records a gap when capture cannot finish", async () => {
    const events: { readonly name: string; readonly details: unknown }[] = [];
    const journal = await Effect.runPromise(makeEffectJournal);
    const operation = defineOperation(
      { input: Schema.Struct({}), output: Schema.Struct({ title: Schema.String }) },
      async () => ({ title: "Example Domain" }),
    );
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        executeKernelOperation(operation, {}, { kernel: offlineKernel, sessionId: "session-1" }).pipe(
          Effect.provideService(ExecutionContext, {
            deadline: Deadline.after(60_000),
            journal,
            events: {
              emit: (name, details) =>
                Effect.sync(() => {
                  events.push({ name, details });
                }),
            },
            capture: {
              start: Effect.void,
              finish: Effect.fail(new CaptureUnavailable({ phase: "finish" })),
            },
          }),
        ),
      ),
    );
    expect(exit).toEqual(Exit.succeed({ title: "Example Domain" }));
    expect(events).toContainEqual({ name: "capture.finish_gap", details: { phase: "finish" } });
  });

  it("marks a live run possibly dispatched before its first call, and an offline one never", async () => {
    const write = defineOperation(
      { input: Schema.Struct({}), output: Schema.String },
      async ({ verified }) => {
        verified();
        return "saved";
      },
    );
    const silent = defineOperation(
      { input: Schema.Struct({}), output: Schema.String },
      async () => "read",
    );
    expect(
      await run(executeKernelOperation(silent, {}, { kernel: answeringKernel, sessionId: "s" })),
    ).toEqual({ exit: Exit.succeed("read"), websiteEffect: "may_have_dispatched" });
    // An offline run cannot reach a site, so its mark changes nothing.
    expect(
      await run(
        executeKernelOperation(write, {}, { kernel: offlineKernel, sessionId: "s", offline: true }),
      ),
    ).toEqual({ exit: Exit.succeed("saved"), websiteEffect: "not_started" });
  });

  it("runs an offline script without a browser, and a call it makes fails unsent", async () => {
    const parser = defineOperation(
      { input: Schema.Struct({ text: Schema.String }), output: Schema.Number },
      async ({ input }) => input.text.length,
    );
    expect(
      await run(
        executeKernelOperation(
          parser,
          { text: "abc" },
          { kernel: offlineKernel, sessionId: "offline", offline: true },
        ),
      ),
    ).toEqual({ exit: Exit.succeed(3), websiteEffect: "not_started" });
    const calling = defineOperation(
      { input: Schema.Struct({}), output: Schema.Null },
      async ({ kernel, sessionId }) => {
        await kernel.browsers.playwright.execute(sessionId, { code: "return 1;", timeout_sec: 5 });
        return null;
      },
    );
    const called = await run(
      executeKernelOperation(calling, {}, { kernel: offlineKernel, sessionId: "offline", offline: true }),
    );
    expect(failureOf(called.exit)).toMatchObject(
      Option.some({ _tag: "OperationFailure", dispatch: "not_sent" }),
    );
  });

  // A confirmed write that then fails keeps its confirmed commit step in the runner's report, so a
  // host reading it sees the write confirmed live; a browser call after verified() reopens it.
  it.each([
    { after: "throws", effect: "verified", confirmation: "readback", state: "confirmed" },
    { after: "returns invalid output", effect: "verified", confirmation: "readback", state: "confirmed" },
    { after: "calls the browser, then throws", effect: "may_have_dispatched", confirmation: undefined, state: "sent" },
  ])("reports the commit step $state when a confirmed write $after", async (expected) => {
    const write = defineOperation(
      {
        input: Schema.Struct({}),
        output: Schema.Struct({ saved: Schema.Boolean }),
        write: { confirmation: "readback", commits: ["save"] },
      },
      async ({ kernel, sessionId, enteringCommit, verified }) => {
        enteringCommit("save");
        await kernel.browsers.playwright.execute(sessionId, { code: "return 1;", timeout_sec: 5 });
        verified();
        if (expected.after === "returns invalid output")
          return { saved: "yes" } as unknown as { saved: boolean };
        if (expected.after === "calls the browser, then throws")
          await kernel.browsers.playwright.execute(sessionId, { code: "return 2;", timeout_sec: 5 });
        throw new Error("Another field differs after the save");
      },
    );
    const journal = await Effect.runPromise(makeEffectJournal);
    const { exit, websiteEffect } = await run(
      executeKernelOperation(write, {}, { kernel: answeringKernel, sessionId: "s" }),
      Effect.succeed(journal),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(websiteEffect).toBe(expected.effect);
    expect(await Effect.runPromise(journal.confirmation)).toBe(expected.confirmation);
    const commits = await Effect.runPromise(journal.commits);
    expect(commitReportOf({ commits })).toEqual({
      evidence: "entered",
      marks: [{ name: "save", state: expected.state }],
    });
  });

  // A host may settle commit steps an earlier run sent or confirmed: entering one fails before its
  // execute call, and the steps still unsent enter as usual.
  it("refuses a commit step already settled, before its execute call", async () => {
    const write = (step: string) =>
      defineOperation(
        {
          input: Schema.Struct({}),
          output: Schema.String,
          write: { confirmation: "readback", commits: ["save-address", "place-order"] },
        },
        async ({ kernel, sessionId, enteringCommit }) => {
          enteringCommit(step);
          await kernel.browsers.playwright.execute(sessionId, {
            code: "return 1;",
            timeout_sec: 10,
          });
          return step;
        },
      );
    const attempt = async (step: string) => {
      let calls = 0;
      const kernel: KernelExecuteClient = {
        browsers: {
          playwright: {
            execute: async () => {
              calls += 1;
              return { success: true, result: 1 };
            },
          },
        },
      };
      const journal = await Effect.runPromise(
        makeEffectJournalWith({ settledCommits: ["save-address", "confirm-terms"] }),
      );
      const outcome = await run(
        executeKernelOperation(write(step), {}, { kernel, sessionId: "s" }),
        Effect.succeed(journal),
      );
      return { ...outcome, calls, commits: await Effect.runPromise(journal.commits) };
    };
    const refused = await attempt("save-address");
    expect(failureOf(refused.exit)).toEqual(
      Option.some(expect.objectContaining({ _tag: "CommitAlreadySent", name: "save-address" })),
    );
    expect(refused.calls).toBe(0);
    expect(refused.commits).toEqual([
      { name: "save-address", state: "not_sent" },
      { name: "place-order", state: "not_sent" },
    ]);
    const confirmed = await attempt("confirm-terms");
    expect(failureOf(confirmed.exit)).toEqual(
      Option.some(expect.objectContaining({ _tag: "CommitAlreadySent", name: "confirm-terms" })),
    );
    expect(confirmed.calls).toBe(0);
    const finished = await attempt("place-order");
    expect(finished.exit).toEqual(Exit.succeed("place-order"));
    expect(finished.calls).toBe(1);
    expect(finished.commits).toEqual([
      { name: "save-address", state: "not_sent" },
      { name: "place-order", state: "sent" },
    ]);
  });

  it("fails before dispatch when the deadline is already spent, and as unknown when it passes mid-run", async () => {
    const spent = Deadline.after(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const quick = defineOperation({ input: Schema.Struct({}), output: Schema.String }, async () => "done");
    const late = await run(
      executeKernelOperation(quick, {}, { kernel: answeringKernel, sessionId: "s" }),
      makeEffectJournal,
      spent,
    );
    expect(failureOf(late.exit)).toEqual(
      Option.some(expect.objectContaining({ _tag: "DeadlineExceeded", dispatch: "not_sent" })),
    );
    expect(late.websiteEffect).toBe("not_started");
    const hanging = defineOperation(
      { input: Schema.Struct({}), output: Schema.String },
      () => new Promise<string>(() => {}),
    );
    const expired = await run(
      executeKernelOperation(hanging, {}, { kernel: answeringKernel, sessionId: "s" }),
      makeEffectJournal,
      Deadline.after(50),
    );
    expect(failureOf(expired.exit)).toEqual(
      Option.some(expect.objectContaining({ _tag: "DeadlineExceeded", dispatch: "unknown" })),
    );
    expect(expired.websiteEffect).toBe("may_have_dispatched");
  });

  it("refuses output its schema rejects", async () => {
    const wrong = defineOperation(
      { input: Schema.Struct({}), output: Schema.Number },
      async () => "not a number" as unknown as number,
    );
    const exit = (await run(executeKernelOperation(wrong, {}, { kernel: answeringKernel, sessionId: "s" })))
      .exit;
    expect(failureOf(exit)).toEqual(
      Option.some(expect.objectContaining({ _tag: "InvalidOutput" })),
    );
  });

  it("runs a host's `first` in place of the script, with the script's run as its fallback", async () => {
    const script = defineOperation(
      { input: Schema.Struct({ query: Schema.String }), output: Schema.String },
      async ({ input }) => `script:${input.query}`,
    );
    const firstSaw: string[] = [];
    const fallback = await run(
      executeKernelOperation(script, { query: "a" }, { kernel: answeringKernel, sessionId: "s" }, (run, input) => {
        firstSaw.push(input.query);
        return run;
      }),
    );
    expect(fallback.exit).toEqual(Exit.succeed("script:a"));
    expect(firstSaw).toEqual(["a"]);
    const replaced = await run(
      executeKernelOperation(script, { query: "b" }, { kernel: answeringKernel, sessionId: "s" }, () =>
        Effect.succeed("first:b"),
      ),
    );
    expect(replaced.exit).toEqual(Exit.succeed("first:b"));
  });
});

// The local host never passes `first`: only a host that supplies its own implementation does.
it("is called by the local child without a `first` runner", async () => {
  const child = await readFile("typescript/src/execution/local-operation-child.ts", "utf8");
  const parsed = parseSync("local-operation-child.ts", child, { lang: "ts", sourceType: "module" });
  const argumentCounts: number[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const callee = record["callee"] as Record<string, unknown> | undefined;
    if (record["type"] === "CallExpression" && callee?.["name"] === "executeKernelOperation")
      argumentCounts.push((record["arguments"] as unknown[]).length);
    Object.values(record).forEach(visit);
  };
  visit(parsed.program);
  expect(argumentCounts).toEqual([3]);
});
