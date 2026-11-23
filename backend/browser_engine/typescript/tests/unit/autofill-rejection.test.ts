import { Cause, Data, Effect, Exit } from "effect";
import { afterEach, expect, it } from "vitest";
import type { AutofillRecipeStep } from "../../src/destinations/autofill-recipe.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";
import { logicalRejectedField, recordedRejections } from "../../src/runtime/autofill-rejection.js";
import {
  configureSignInTelemetry,
  type SignInReportContext,
} from "../../src/runtime/sign-in-telemetry.js";

/** A host's own typed failure, as a marker inspection may fail with. */
class HostFailure extends Data.TaggedError("HostFailure")<{ readonly code: string }> {}

/** The silent sink a host that reports nothing runs with, restored after each test. */
const silentTelemetry = () =>
  configureSignInTelemetry({
    failure: () => Effect.void,
    defect: () => Effect.void,
    bestEffort: (effect) => Effect.ignore(effect),
    timeExecutionStage: (_sink, _stage, effect) => effect,
    pageCallFailure: (detail) => detail,
  });
afterEach(silentTelemetry);

const hooks = (markerVisible?: AutofillHooks["markerVisible"]): AutofillHooks => ({
  inspect: () => Effect.dieMessage("Unexpected inspect"),
  fill: () => Effect.dieMessage("Unexpected fill"),
  confirm: () => Effect.dieMessage("Unexpected confirm"),
  check: () => Effect.dieMessage("Unexpected check"),
  open: () => Effect.dieMessage("Unexpected open"),
  ...(markerVisible === undefined ? {} : { markerVisible }),
});

const steps: readonly AutofillRecipeStep[] = [
  {
    page: "https://example.test/login",
    fields: [],
    rejectedMarkers: [
      { slot: "password", selector: "#password-error" },
      { slot: "email", selector: "#email-error" },
    ],
  },
];

it("refuses a partial rejection when another marker cannot be inspected", async () => {
  const browser = hooks((selector) =>
    selector === "#password-error"
      ? Effect.succeed(true)
      : Effect.fail(new HostFailure({ code: "PlanUnavailable" })),
  );
  expect(await Effect.runPromise(recordedRejections(browser, steps))).toBe("unavailable");
});

it("collects all visible fields once, with credentials before one-time codes", async () => {
  const recorded: readonly AutofillRecipeStep[] = [
    {
      page: "https://example.test/code",
      fields: [],
      rejectedMarkers: [
        { slot: "code", selector: "#code-error" },
        { slot: "email", selector: "#email-error" },
        { slot: "password", selector: "#hidden-error" },
      ],
    },
    ...steps,
  ];
  const browser = hooks((selector, page) =>
    Effect.succeed(selector !== "#hidden-error" && page.startsWith("https://example.test/")),
  );
  expect(await Effect.runPromise(recordedRejections(browser, recorded))).toEqual([
    "email",
    "password",
    "code",
  ]);
});

it.each([
  ["missing inspection hook", hooks()],
  ["no visible markers", hooks(() => Effect.succeed(false))],
] as const)("returns no rejections with %s", async (_name, browser) => {
  expect(await Effect.runPromise(recordedRejections(browser, steps))).toEqual([]);
});

it.each([
  ["a typed inspection failure", () => Effect.fail(new HostFailure({ code: "PlanUnavailable" }))],
  ["an inspection defect", () => Effect.die(new Error("Marker inspection unavailable"))],
  [
    "a synchronous hook exception",
    () => {
      throw new Error("Marker inspection unavailable");
    },
  ],
] as const)("fails closed on %s", async (_name, inspect) => {
  expect(await Effect.runPromise(recordedRejections(hooks(inspect), steps))).toBe("unavailable");
});

it("reports a marker inspection that failed through the host's sink, with its correlation", async () => {
  const defects: { readonly cause: unknown; readonly context: SignInReportContext }[] = [];
  configureSignInTelemetry({
    failure: () => Effect.dieMessage("Unexpected failure report"),
    defect: (cause, context) =>
      Effect.sync(() => {
        defects.push({ cause, context });
      }),
    bestEffort: (effect) => Effect.ignore(effect),
    timeExecutionStage: (_sink, _stage, effect) => effect,
    pageCallFailure: (detail) => detail,
  });
  const failure = new HostFailure({ code: "PlanUnavailable" });
  const correlation = { signIn: "synthetic-sign-in" };
  expect(
    await Effect.runPromise(
      recordedRejections(
        hooks(() => Effect.fail(failure)),
        steps,
        correlation,
      ),
    ),
  ).toBe("unavailable");
  expect(defects).toHaveLength(1);
  expect(defects[0]?.context).toEqual({
    component: "worker",
    operation: "autofill.marker",
    subCause: "autofill_step_failed",
    correlation,
  });
  const cause = defects[0]?.cause;
  expect(Cause.isCause(cause) && Cause.squash(cause)).toBe(failure);
});

it("preserves worker interruption instead of treating it as a recipe failure", async () => {
  const result = await Effect.runPromise(
    Effect.exit(
      recordedRejections(
        hooks(() => Effect.interrupt),
        steps,
      ),
    ),
  );
  expect(Exit.isFailure(result)).toBe(true);
  if (Exit.isSuccess(result)) throw new Error("Expected worker interruption");
  expect(Cause.isInterrupted(result.cause)).toBe(true);
});

it.each(["username", "email", "phone", "account_number"] as const)(
  "uses one correction key for alternating generic and primary %s markers",
  (primaryKind) => {
    const rejected = ["username", primaryKind, "username", primaryKind] as const;
    expect(new Set(rejected.map((slot) => logicalRejectedField(slot, primaryKind)))).toEqual(
      new Set(["username"]),
    );
  },
);

it.each(["email", "phone", "account_number"] as const)(
  "does not infer that %s is the primary identifier without trusted kind",
  (slot) => expect(logicalRejectedField(slot)).toBe(slot),
);

it.each(["password", "code", "date_of_birth", "zip", "recovery_code"] as const)(
  "keeps %s separate from primary identifier corrections",
  (slot) => expect(logicalRejectedField(slot, "email")).toBe(slot),
);

it("keeps other identifier kinds distinct from the held primary", () => {
  expect(logicalRejectedField("phone", "email")).toBe("phone");
  expect(logicalRejectedField("email", "phone")).toBe("email");
});
