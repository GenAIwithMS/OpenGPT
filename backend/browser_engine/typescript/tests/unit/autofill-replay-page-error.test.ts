import { Data, Duration, Effect, Fiber, TestClock, TestContext } from "effect";
import { afterEach, expect, it } from "vitest";
import type { AutofillRecipe } from "../../src/destinations/autofill-recipe.js";
import type { AutofillRefusal } from "../../src/destinations/autofill-step.js";
import { failureDetail } from "../../src/runtime/failure-detail.js";
import { replayAutofillRecipe } from "../../src/runtime/autofill-replay.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";
import {
  configureSignInTelemetry,
  type SignInReportContext,
  type SignInTelemetry,
} from "../../src/runtime/sign-in-telemetry.js";

// A screen check's page call can fail while a single-page app is still starting, such as a frame
// detaching mid-scan. The host refuses it as `page_unavailable`, which used to end the sign-in
// before the saved profile's signed-in check ran.

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

/** What a host that reports nothing sets, as the shared sign-in code starts. */
const silent: SignInTelemetry = {
  failure: () => Effect.void,
  defect: () => Effect.void,
  bestEffort: (effect) => Effect.ignore(effect),
  timeExecutionStage: (_sink, _stage, effect) => effect,
  pageCallFailure: (detail) => detail,
};

afterEach(() => {
  configureSignInTelemetry(silent);
});

const page = "https://example.test/";
const origin = "https://example.test";

type Inspected = AutofillRefusal["reason"] | "shown";

/** The error behind a failed page call, as Playwright reports a frame that detached mid-scan. */
const frameDetached = "locator.count: Frame was detached";

/**
 * A replay of a one-screen recipe whose first screen clicks "Log in", as an email-code recipe
 * starts. Each screen check answers the next of `inspections` (the last repeats). The saved
 * profile is `signed_in`, `signed_out`, or signed in to `another_account`: its marker shows, and
 * the identity check refuses it. A clicked screen signs the page in.
 */
const replay = async (
  inspections: readonly Inspected[],
  profile: "signed_in" | "signed_out" | "another_account",
) => {
  let inspected = 0;
  let fills = 0;
  const events: Readonly<Record<string, unknown>>[] = [];
  const reported: { readonly error: unknown; readonly context: SignInReportContext }[] = [];
  const target = {
    ownerUrl: null,
    documentOrigin: origin,
    actions: [`${origin}/session`],
    methods: ["post"],
    editable: true,
    control: "other" as const,
  };
  const signedInCheck = (verifiesIdentity: boolean) =>
    Effect.sync(() =>
      fills > 0 || profile === "signed_in" || (profile === "another_account" && !verifiesIdentity)
        ? { signedIn: true as const, url: page }
        : { signedIn: false as const, failed: "indicator_not_visible" as const, url: page },
    );
  const hooks: AutofillHooks<TestFailure> = {
    open: () => Effect.void,
    check: () => signedInCheck(false),
    confirm: () => signedInCheck(true),
    inspect: () =>
      Effect.sync(() => {
        const answer = inspections[Math.min(inspected, inspections.length - 1)] ?? "shown";
        inspected += 1;
        return answer === "shown"
          ? {
              page,
              siteOrigin: origin,
              authenticationOrigins: [],
              targets: { fields: [], submit: target },
              screen: { origin, fields: [], submit: null, buttons: ["Log in"] },
            }
          : answer === "page_unavailable"
            ? {
                outcome: "refused" as const,
                reason: answer,
                failureDetail: failureDetail("autofill_step_failed", {
                  operation: "autofill.inspect",
                  error: new Error(frameDetached),
                }),
              }
            : { outcome: "refused" as const, reason: answer };
      }),
    fill: () =>
      Effect.sync(() => {
        fills += 1;
        return { outcome: "filled" as const, fields: [], submit: "clicked" as const, url: page };
      }),
  };
  const recipe: AutofillRecipe = {
    version: 2,
    steps: [{ page, fields: [], submit: 'button:text-is("Log in")' }],
    signedIn: { selector: "#profile-menu" },
  };
  configureSignInTelemetry({
    ...silent,
    failure: (error, context) => Effect.sync(() => void reported.push({ error, context })),
  });
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const running = yield* Effect.fork(
        replayAutofillRecipe({
          recipe,
          hooks,
          entryUrl: page,
          credentials: undefined,
          ask: () => Effect.dieMessage("Unexpected question"),
          broker: {
            register: () => Effect.void,
            registeredSecretMatches: () => Effect.succeed([]),
          },
          site: "example.test",
          correlation: { jobId: "job", attemptId: "attempt" },
          emit: (details) => Effect.sync(() => events.push(details)),
          failures: {
            unanswered: () => new TestFailure({ code: "BrowserUnavailable" }),
            unavailable: () => new TestFailure({ code: "BrowserUnavailable" }),
          },
          timing: { stepWaitMs: 30_000, pollMs: 250 },
          sent: { current: false },
        }).pipe(Effect.scoped),
      );
      yield* TestClock.adjust(Duration.minutes(1));
      return yield* Fiber.join(running);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );
  // The reported error is the host's own for the failed call (`pageCallFailure`), here the detail
  // itself, which keeps every field when serialized on its own.
  const callFailures = reported.filter(
    ({ error, context }) =>
      context.operation === "autofill.inspect" && JSON.stringify(error).includes(frameDetached),
  );
  return { outcome, inspected, fills, events, callFailures };
};

it("checks a signed-in profile after a screen check fails twice on a page error, and goes on signed in", async () => {
  const { outcome, inspected, fills, events, callFailures } = await replay(
    ["page_unavailable"],
    "signed_in",
  );

  expect(outcome).toEqual({ outcome: "signed_in", alreadySignedIn: true });
  expect(inspected).toBe(2);
  expect(fills).toBe(0);
  expect(events).toContainEqual({ stage: "retried", reason: "page_unavailable" });
  // The failed call's own error reaches the failure archive, which the step event never carries.
  expect(callFailures).not.toHaveLength(0);
});

it("refuses a profile signed in to another account after a page error, as for any saved session", async () => {
  const { outcome, fills } = await replay(["page_unavailable"], "another_account");

  expect(outcome).toEqual({ outcome: "unsent", reason: "indicator_not_visible" });
  expect(fills).toBe(0);
});

it("fails as page_unavailable when the screen check fails twice and the page is signed out", async () => {
  const { outcome, inspected, fills } = await replay(["page_unavailable"], "signed_out");

  expect(outcome).toEqual({ outcome: "unsent", reason: "page_unavailable" });
  expect(inspected).toBe(2);
  expect(fills).toBe(0);
});

it("fills the screen when the retried check finds it", async () => {
  const { outcome, fills } = await replay(["page_unavailable", "shown"], "signed_out");

  expect(outcome).toMatchObject({ outcome: "signed_in" });
  expect(fills).toBe(1);
});

it("keeps waiting out a screen that is not found, then fails as not_found", async () => {
  const { outcome, fills } = await replay(["not_found"], "signed_out");

  expect(outcome).toEqual({ outcome: "unsent", reason: "not_found" });
  expect(fills).toBe(0);
});
