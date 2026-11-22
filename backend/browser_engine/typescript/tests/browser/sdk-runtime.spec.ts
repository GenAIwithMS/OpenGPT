import { expect, test } from "@playwright/test";
import { Effect, Schema } from "effect";
import { ExecutionContext, makeEffectJournal } from "../../src/runtime/context.js";
import { Deadline } from "../../src/runtime/deadline.js";
import { defineOperation, executeOperation } from "../../src/runtime/operation.js";

const fixtureContext = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const journal = yield* makeEffectJournal;
      return {
        deadline: Deadline.after(),
        journal,
        events: { emit: () => Effect.void },
        capture: { start: Effect.void, finish: Effect.void },
      };
    }),
  );

test("an Effect write declared unverifiable cannot record a confirmation or mark itself verified", async () => {
  const outcome = async (record: "confirmed" | "verified") => {
    const execution = await fixtureContext();
    const write = defineOperation({
      name: "unverifiable_write",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      write: { confirmation: "unverifiable" },
      run: () =>
        Effect.gen(function* () {
          const context = yield* ExecutionContext;
          yield* record === "confirmed"
            ? context.journal.confirmed("message")
            : context.journal.verified;
          return {};
        }),
    });
    const result = await Effect.runPromise(
      Effect.scoped(executeOperation(write, {})).pipe(
        Effect.provideService(ExecutionContext, execution),
        Effect.either,
      ),
    );
    return { result, effect: await Effect.runPromise(execution.journal.state) };
  };
  for (const record of ["confirmed", "verified"] as const)
    expect(await outcome(record)).toMatchObject({
      result: {
        _tag: "Left",
        left: { _tag: "WriteConfirmationRefused", declared: "unverifiable" },
      },
      effect: "not_started",
    });
});
