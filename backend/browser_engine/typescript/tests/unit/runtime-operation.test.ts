import { Cause, Chunk, Effect, Exit, Layer, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ExecutionContext, makeEffectJournal } from "../../src/runtime/context.js";
import { Deadline } from "../../src/runtime/deadline.js";
import {
  CaptureUnavailable,
  InvalidInput,
  maximumInputIssuePath,
  maximumInputIssues,
} from "../../src/runtime/errors.js";
import { defineOperation, executeOperation } from "../../src/runtime/operation.js";
import { operationErrors } from "../../src/runtime/operation-failure.js";
import { leftOf } from "../support/expect-failure.js";
import type { ConditionObservation, ConditionState } from "../../src/browser/index.js";

const makeContext = (lifecycle: string[] = []) =>
  Effect.gen(function* () {
    const journal = yield* makeEffectJournal;
    return {
      deadline: Deadline.after(),
      journal,
      events: { emit: () => Effect.void },
      capture: {
        start: Effect.sync(() => {
          lifecycle.push("start");
        }),
        finish: Effect.sync(() => {
          lifecycle.push("finish");
        }),
      },
    };
  });

describe("operation host", () => {
  it("rejects invalid input before capture allocation or operation effects", async () => {
    const lifecycle: string[] = [];
    let effects = 0;
    const operation = defineOperation({
      name: "read_amount",
      input: Schema.Struct({ resourceId: Schema.String }),
      output: Schema.Number,
      run: () =>
        Effect.sync(() => {
          effects += 1;
          return 42;
        }),
    });
    const context = await Effect.runPromise(makeContext(lifecycle));
    const result = await Effect.runPromise(
      Effect.scoped(executeOperation(operation, { resourceId: 23 })).pipe(
        Effect.provide(Layer.succeed(ExecutionContext, context)),
        Effect.either,
      ),
    );
    expect(leftOf(result)._tag).toBe("InvalidInput");
    expect(effects).toBe(0);
    expect(lifecycle).toEqual([]);
  });

  it("keeps verified website outcome when output validation fails and closes capture", async () => {
    const lifecycle: string[] = [];
    const context = await Effect.runPromise(makeContext(lifecycle));
    const operation = defineOperation({
      name: "reserve",
      input: Schema.Void,
      output: Schema.Number.pipe(Schema.positive()),
      run: () =>
        Effect.gen(function* () {
          const execution = yield* ExecutionContext;
          yield* execution.journal.enteringDispatch;
          yield* execution.journal.verified;
          return -1;
        }),
    });
    const result = await Effect.runPromise(
      Effect.scoped(executeOperation(operation, undefined)).pipe(
        Effect.provide(Layer.succeed(ExecutionContext, context)),
        Effect.either,
      ),
    );
    const failure = leftOf(result);
    expect(failure._tag).toBe("InvalidOutput");
    // The schema error that rejected the output stays as its cause.
    expect(failure.cause).toMatchObject({ _tag: "ParseError" });
    expect(await Effect.runPromise(context.journal.state)).toBe("verified");
    expect(lifecycle).toEqual(["start", "finish"]);
  });

  it("returns the operation's result and records a gap when capture cannot finish", async () => {
    const events: { readonly name: string; readonly details: unknown }[] = [];
    const journal = await Effect.runPromise(makeEffectJournal);
    const context = {
      deadline: Deadline.after(),
      journal,
      events: {
        emit: (name: string, details: unknown) =>
          Effect.sync(() => {
            events.push({ name, details });
          }),
      },
      capture: {
        start: Effect.void,
        finish: Effect.fail(
          new CaptureUnavailable({ phase: "finish", captureReason: "storage_failed" }),
        ),
      },
    };
    const operation = defineOperation({
      name: "read_amount",
      input: Schema.Void,
      output: Schema.Number,
      run: () => Effect.succeed(42),
    });
    const exit = await Effect.runPromiseExit(
      Effect.scoped(executeOperation(operation, undefined)).pipe(
        Effect.provide(Layer.succeed(ExecutionContext, context)),
      ),
    );
    expect(exit).toEqual(Exit.succeed(42));
    expect(events).toContainEqual({
      name: "capture.finish_gap",
      details: { phase: "finish", reason: "storage_failed" },
    });
  });

  it("hands the host what an operation returned past its output schema", async () => {
    const context = await Effect.runPromise(makeContext());
    const operation = defineOperation({
      name: "read_amount",
      input: Schema.Void,
      output: Schema.Struct({ amount: Schema.Number }),
      // A script that returns what its schema does not allow, as a drifted site makes it do.
      run: () => Effect.succeed(Schema.decodeUnknownSync(Schema.Any)({ amount: "forty-two" })),
    });
    const result = await Effect.runPromise(
      Effect.scoped(executeOperation(operation, undefined)).pipe(
        Effect.provide(Layer.succeed(ExecutionContext, context)),
        Effect.either,
      ),
    );
    expect(leftOf(result)).toMatchObject({
      _tag: "InvalidOutput",
      output: { amount: "forty-two" },
    });
  });

  // The frozen deadline clock leaves the test clock to end the window. A slow observation keeps
  // the number of polls the test clock must step through small.

  it("nested budgets cannot outlive their parent", () => {
    let now = 0;
    const outer = Deadline.after(100, () => now);
    now = 90;
    expect(outer.child(5_000).remainingMs()).toBe(10);
    now = 101;
    expect(outer.remainingMs()).toBe(0);
  });

  it("leaves an outer operation deadline untagged", async () => {
    const context = await Effect.runPromise(makeContext());
    const operation = defineOperation({
      name: "slow_read",
      input: Schema.Void,
      output: Schema.Void,
      run: () => Effect.never,
    });
    const result = await Effect.runPromise(
      Effect.scoped(executeOperation(operation, undefined)).pipe(
        Effect.provide(
          Layer.succeed(ExecutionContext, { ...context, deadline: Deadline.after(10) }),
        ),
        Effect.either,
      ),
    );
    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "DeadlineExceeded", phase: "execution" },
    });
    expect(leftOf(result)).not.toHaveProperty("pwTimeoutSource");
  });

  it("finalizes capture on an interrupted operation without changing its effect journal", async () => {
    const lifecycle: string[] = [];
    const context = await Effect.runPromise(makeContext(lifecycle));
    const operation = defineOperation({
      name: "interrupted_write",
      input: Schema.Void,
      output: Schema.Void,
      run: () =>
        Effect.gen(function* () {
          yield* context.journal.enteringDispatch;
          return yield* Effect.interrupt;
        }),
    });
    const exit = await Effect.runPromiseExit(
      Effect.scoped(executeOperation(operation, undefined)).pipe(
        Effect.provide(Layer.succeed(ExecutionContext, context)),
      ),
    );
    expect(exit._tag).toBe("Failure");
    expect(lifecycle).toEqual(["start", "finish"]);
    expect(await Effect.runPromise(context.journal.state)).toBe("may_have_dispatched");
  });
});

describe("an input refusal thrown outside an Effect", () => {
  // An Effect operation that calls a runtime helper, such as `startList`, inside `Effect.gen` sees
  // the helper's throw as a defect. The runner fails the run with the caller's input refusal and
  // leaves every other defect as one.
  const run = (body: () => Effect.Effect<number>) =>
    Effect.gen(function* () {
      const context = yield* makeContext();
      const operation = defineOperation({
        name: "read_amount",
        input: Schema.Void,
        output: Schema.Number,
        run: body,
      });
      return yield* Effect.scoped(executeOperation(operation, undefined)).pipe(
        Effect.provide(Layer.succeed(ExecutionContext, context)),
      );
    }).pipe(Effect.runPromiseExit);
  const throwing = (error: unknown) => () =>
    Effect.sync(() => {
      throw error;
    });
  const causeOf = (exit: Exit.Exit<unknown, unknown>) => {
    if (!Exit.isFailure(exit)) throw new Error("the run succeeded");
    return exit.cause;
  };
  /** A refusal as another copy of the runtime, such as one a tool bundles, constructs it. */
  class OtherCopyRefusal extends Error {
    override readonly name = "InvalidInput";
    readonly _tag = "InvalidInput";
    constructor(
      message: string,
      readonly field: string,
      readonly kind: string,
    ) {
      super(message);
    }
  }

  it("fails with the runtime's refusal, its message and fields kept", async () => {
    const refusal = new operationErrors.InvalidInput("Pick another size", {
      field: "size",
      available: ["One Size"],
    });
    const cause = causeOf(await run(throwing(refusal)));
    expect(Option.getOrUndefined(Cause.failureOption(cause))).toBe(refusal);
  });

  it("fails with a refusal from another copy of the runtime", async () => {
    const refusal = new OtherCopyRefusal("Not a cursor this tool returned", "cursor", "malformed");
    const cause = causeOf(await run(throwing(refusal)));
    expect(Option.getOrUndefined(Cause.failureOption(cause))).toBe(refusal);
  });

  it("leaves a thrown schema InvalidInput, a plain Error and Effect.die as defects", async () => {
    const schemaError = new InvalidInput({ operation: "read_amount" });
    const plain = new Error("unexpected page");
    for (const [defect, body] of [
      [schemaError, throwing(schemaError)],
      [plain, throwing(plain)],
      [plain, () => Effect.die(plain)],
    ] as const) {
      const cause = causeOf(await run(body));
      expect(Option.isNone(Cause.failureOption(cause))).toBe(true);
      expect(Option.getOrUndefined(Cause.dieOption(cause))).toBe(defect);
    }
  });

  it("keeps the whole cause when another error ends the run beside the refusal", async () => {
    const refusal = new operationErrors.InvalidInput("Pick another size", { field: "size" });
    const cleanup = new Error("cleanup failed");
    const body = () => throwing(refusal)().pipe(Effect.ensuring(Effect.die(cleanup)));
    const cause = causeOf(await run(body));
    expect(Option.isNone(Cause.failureOption(cause))).toBe(true);
    expect(Chunk.toReadonlyArray(Cause.defects(cause))).toEqual([refusal, cleanup]);
  });
});

/** The issues an operation's input decode reports for `input`, through the operation host. */
const issuesFor = async <A, I>(input: Schema.Schema<A, I>, value: unknown) => {
  const operation = defineOperation({
    name: "issues",
    input,
    output: Schema.Void,
    run: () => Effect.void,
  });
  const context = await Effect.runPromise(makeContext());
  const failure = leftOf(
    await Effect.runPromise(
      Effect.scoped(executeOperation(operation, value)).pipe(
        Effect.provide(Layer.succeed(ExecutionContext, context)),
        Effect.either,
      ),
    ),
  );
  if (!(failure instanceof InvalidInput))
    throw new Error(`Expected InvalidInput, got ${failure._tag}`);
  return failure.issues;
};

describe("input issues", () => {
  it("reports every rejected property, not only the first", async () => {
    expect(
      await issuesFor(
        Schema.Struct({ item: Schema.String, quantity: Schema.Number, note: Schema.String }),
        { quantity: "two", note: "ok" },
      ),
    ).toEqual([
      { path: "item", issue: "missing" },
      { path: "quantity", issue: "invalid" },
    ]);
  });

  it("names a record's key, which the caller chose, only as a placeholder", async () => {
    const issues = await issuesFor(
      Schema.Struct({ totals: Schema.Record({ key: Schema.String, value: Schema.Number }) }),
      { totals: { "person@example.test": "bad" } },
    );
    expect(issues).toEqual([{ path: "totals[key]", issue: "invalid" }]);
    expect(JSON.stringify(issues)).not.toContain("example.test");
  });

  it("keeps array indexes and quotes a declared name that is not an identifier", async () => {
    expect(
      await issuesFor(
        Schema.Struct({
          "line.items": Schema.Array(Schema.Struct({ "": Schema.String })),
        }),
        { "line.items": [{ "": "ok" }, {}] },
      ),
    ).toEqual([{ path: '["line.items"][1][""]', issue: "missing" }]);
  });

  it("bounds how many issues and how long a path go back", async () => {
    const fields = Object.fromEntries(
      Array.from({ length: maximumInputIssues + 5 }, (_, index) => [`f${index}`, Schema.String]),
    );
    expect(await issuesFor(Schema.Struct(fields), {})).toHaveLength(maximumInputIssues);
    const long = "a".repeat(maximumInputIssuePath);
    const [issue] = (await issuesFor(Schema.Struct({ [long]: Schema.String }), {})) ?? [];
    expect(issue?.path.length).toBe(maximumInputIssuePath);
  });
});

// Saved integrations import the authored runtime (`../runtime/index.js`, which re-exports
// `browser/index.js`) from the installed package on every run, so its error classes stay.
describe("authored runtime errors", () => {
  it.each([
    "TargetPageMismatch",
    "TargetNotFound",
    "TargetAmbiguous",
    "TargetGuardMismatch",
    "TargetGuardUnavailable",
    "ConditionTimeout",
  ])("exports %s with its tag to authored operations", async (name) => {
    const runtime: Record<string, unknown> = await import("../../src/browser/index.js");
    const ErrorClass = runtime[name];
    if (typeof ErrorClass !== "function") throw new Error(`${name} is not exported`);
    expect(Reflect.construct(ErrorClass, [{}])).toMatchObject({ _tag: name });
  });

  it("exports the condition types a timeout reports", () => {
    const observation: ConditionObservation = { name: "ready", state: "unknown" };
    const state: ConditionState = observation.state;
    expect(state).toBe("unknown");
  });
});
