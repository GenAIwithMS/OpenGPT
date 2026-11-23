import { Effect, Exit } from "effect";
import { afterEach, expect, it } from "vitest";
import type { FailureDetail } from "../../src/runtime/failure-detail.js";
import {
  configureSignInTelemetry,
  pageCallFailure,
  report,
  type SignInReportContext,
  timeExecutionStage,
} from "../../src/runtime/sign-in-telemetry.js";

/** The silent sink a host that reports nothing runs with, restored after each test. */
afterEach(() =>
  configureSignInTelemetry({
    failure: () => Effect.void,
    defect: () => Effect.void,
    bestEffort: (effect) => Effect.ignore(effect),
    timeExecutionStage: (_sink, _stage, effect) => effect,
    pageCallFailure: (detail) => detail,
  }),
);

const context: SignInReportContext = {
  component: "worker",
  operation: "autofill.marker",
  phase: "autofill_step",
  subCause: "autofill_step_failed",
  correlation: { signIn: "synthetic-sign-in" },
  context: { check: "marker_visible" },
};
const detail: FailureDetail = { subCause: "autofill_step_failed", operation: "Runtime.evaluate" };

// The cases that read the unconfigured sink run first, before any test sets one.

it("reports nothing through an unconfigured sink", async () => {
  expect(await Effect.runPromise(report.failure(new Error("Synthetic failure"), context))).toBe(
    undefined,
  );
  expect(await Effect.runPromise(report.defect(new Error("Synthetic defect"), context))).toBe(
    undefined,
  );
});

it("swallows a best-effort step's failure through an unconfigured sink, after running it", async () => {
  let ran = 0;
  const step = Effect.suspend(() => {
    ran += 1;
    return Effect.fail(new Error("Synthetic best-effort failure"));
  });
  const exit = await Effect.runPromiseExit(
    report.bestEffort(step, { component: "worker", operation: "autofill.settle", correlation: 1 }),
  );
  expect(exit).toEqual(Exit.void);
  expect(ran).toBe(1);
});

it("leaves a stage untimed and a page call's failure as its detail through an unconfigured sink", () => {
  const stage = Effect.succeed("settled");
  expect(timeExecutionStage(undefined, "autofill_settle", stage)).toBe(stage);
  expect(pageCallFailure(detail)).toBe(detail);
});

it("hands the configured sink each failure and defect with its context, as given", async () => {
  const heard: { readonly kind: string; readonly error: unknown; readonly context: unknown }[] =
    [];
  configureSignInTelemetry({
    failure: (error, given) =>
      Effect.sync(() => {
        heard.push({ kind: "failure", error, context: given });
      }),
    defect: (cause, given) =>
      Effect.sync(() => {
        heard.push({ kind: "defect", error: cause, context: given });
      }),
    bestEffort: (effect) => Effect.ignore(effect),
    timeExecutionStage: (_sink, _stage, effect) => effect,
    pageCallFailure: (given) => given,
  });
  const failure = new Error("Synthetic failure");
  const defect = new Error("Synthetic defect");
  await Effect.runPromise(report.failure(failure, context));
  await Effect.runPromise(report.defect(defect, context));
  expect(heard).toHaveLength(2);
  expect(heard[0]?.kind).toBe("failure");
  expect(heard[0]?.error).toBe(failure);
  expect(heard[0]?.context).toBe(context);
  expect(heard[1]?.kind).toBe("defect");
  expect(heard[1]?.error).toBe(defect);
  expect(heard[1]?.context).toBe(context);
});

it("routes best-effort steps, stage timing and page call failures to the configured sink", async () => {
  const calls: string[] = [];
  const hostFailure = { host: "page call failed" };
  configureSignInTelemetry({
    failure: () => Effect.void,
    defect: () => Effect.void,
    bestEffort: (effect, given) =>
      Effect.sync(() => {
        calls.push(`bestEffort ${given.operation}`);
      }).pipe(Effect.zipRight(Effect.ignore(effect))),
    timeExecutionStage: (_sink, stage, effect) =>
      Effect.sync(() => {
        calls.push(`time ${stage}`);
      }).pipe(Effect.zipRight(effect)),
    pageCallFailure: (given) => {
      calls.push(`pageCallFailure ${given.operation ?? ""}`);
      return hostFailure;
    },
  });
  await Effect.runPromise(
    report.bestEffort(Effect.fail("ignored"), {
      component: "worker",
      operation: "autofill.settle",
      correlation: undefined,
    }),
  );
  expect(
    await Effect.runPromise(
      timeExecutionStage(undefined, "autofill_settle", Effect.succeed("settled")),
    ),
  ).toBe("settled");
  expect(pageCallFailure(detail)).toBe(hostFailure);
  expect(calls).toEqual([
    "bestEffort autofill.settle",
    "time autofill_settle",
    "pageCallFailure Runtime.evaluate",
  ]);
});
