import { Effect } from "effect";
import { expect, it } from "vitest";
import { runSupportedVariant } from "../../src/runtime/variants.js";
import type { VariantApplicability } from "../../src/runtime/variants.js";

const candidate = (id: string, applicability: VariantApplicability, run = Effect.succeed(id)) => ({
  id,
  applicability: () => Effect.succeed(applicability),
  run: () => run,
});

it("fails closed on ambiguous, unsupported, and identity mismatch observations before any run", async () => {
  let runs = 0;
  const run = Effect.sync(() => {
    runs += 1;
    return "ran";
  });
  for (const [states, reason] of [
    [["applicable", "applicable"], "ambiguous"],
    [["not_applicable", "not_applicable"], "unsupported"],
    [["applicable", "identity_mismatch"], "identity_mismatch"],
  ] as const) {
    const outcome = await Effect.runPromise(
      Effect.either(
        runSupportedVariant(
          states.map((state, index) => candidate(String(index), state, run)),
          {},
        ),
      ),
    );
    expect(outcome).toMatchObject({ _tag: "Left", left: { reason } });
  }
  expect(runs).toBe(0);
});

it("does not fall back after the selected implementation possibly dispatches", async () => {
  let writes = 0;
  const outcome = await Effect.runPromise(
    Effect.either(
      runSupportedVariant(
        [
          {
            id: "new",
            applicability: () => Effect.succeed("applicable" as const),
            run: () =>
              Effect.sync(() => {
                writes += 1;
              }).pipe(Effect.zipRight(Effect.fail("timeout_after_dispatch"))),
          },
          candidate("old", "not_applicable"),
        ],
        {},
      ),
    ),
  );
  expect(outcome).toMatchObject({ _tag: "Left", left: "timeout_after_dispatch" });
  expect(writes).toBe(1);
});

it("fails closed when every candidate is disabled or the candidate IDs are duplicated", async () => {
  expect(
    await Effect.runPromise(
      Effect.either(runSupportedVariant<undefined, string, never, never>([], undefined)),
    ),
  ).toMatchObject({
    _tag: "Left",
    left: { reason: "unsupported" },
  });
  expect(
    await Effect.runPromise(
      Effect.either(
        runSupportedVariant(
          [candidate("same", "not_applicable"), candidate("same", "applicable")],
          {},
        ),
      ),
    ),
  ).toMatchObject({ _tag: "Left", left: { reason: "invalid_guard" } });
});
