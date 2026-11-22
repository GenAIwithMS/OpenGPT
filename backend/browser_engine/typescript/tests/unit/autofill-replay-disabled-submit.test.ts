import { Data, Duration, Effect, TestClock, TestContext } from "effect";
import { expect, it } from "vitest";
import type { AutofillStepReport } from "../../src/destinations/autofill-step.js";
import type { WebsiteCredentials } from "../../src/runtime/authentication.js";
import type {
  AutofillRecipe,
  AutofillRecipeStep,
} from "../../src/destinations/autofill-recipe.js";
import { replayAutofillRecipe } from "../../src/runtime/autofill-replay.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";

// The host fills a screen whose submit is disabled and waits 5 s for the page to enable it, rather
// than refusing the screen as `not_editable` for the replay to wait for it.

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

const page = "https://example.test/login";
const origin = "https://example.test";

/**
 * A replay of one recorded screen whose host fill reports `submit` for each call in turn, each
 * after the host's 5 s wait when the submit stayed disabled. The site is signed in once a fill
 * clicked.
 */
type Submit = Extract<AutofillStepReport, { readonly outcome: "filled" }>["submit"];

const replay = async (
  step: Omit<AutofillRecipeStep, "page">,
  submits: readonly Submit[],
  credentials?: WebsiteCredentials,
) => {
  let fills = 0;
  let clicked = false;
  const target = {
    ownerUrl: null,
    documentOrigin: origin,
    actions: [`${origin}/session`],
    methods: ["post"],
    editable: true,
    control: "text" as const,
  };
  const hooks: AutofillHooks<TestFailure> = {
    open: () => Effect.void,
    check: () =>
      Effect.sync(() =>
        clicked
          ? { signedIn: true as const, url: `${origin}/account` }
          : { signedIn: false as const, failed: "indicator_not_visible" as const, url: page },
      ),
    confirm: () => Effect.succeed({ signedIn: true as const, url: `${origin}/account` }),
    inspect: (inspected) =>
      Effect.succeed({
        page,
        siteOrigin: origin,
        authenticationOrigins: [],
        targets: {
          fields: inspected.fields.map(() => target),
          submit: { ...target, editable: false, control: "other" as const },
        },
        screen: { origin, fields: [], submit: null, buttons: ["Continue"] },
      }),
    fill: ({ step: filled }) =>
      Effect.gen(function* () {
        const submit = submits[Math.min(fills, submits.length - 1)] ?? "clicked";
        fills += 1;
        if (submit === "stayed_disabled") yield* TestClock.adjust(Duration.seconds(5));
        clicked ||= submit === "clicked";
        return {
          outcome: "filled" as const,
          fields: filled.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
          submit,
          url: page,
        };
      }),
  };
  const recipe: AutofillRecipe = {
    version: 2,
    steps: [{ ...step, page }],
    signedIn: { selector: "#identity" },
  };
  const outcome = await Effect.runPromise(
    replayAutofillRecipe({
      recipe,
      hooks,
      entryUrl: page,
      credentials,
      ask: () => Effect.dieMessage("Unexpected question"),
      broker: {
        register: () => Effect.void,
        registeredSecretMatches: () => Effect.succeed([]),
      },
      site: "example.test",
      correlation: { jobId: "job", attemptId: "attempt" },
      emit: () => Effect.void,
      failures: {
        unanswered: () => new TestFailure({ code: "BrowserUnavailable" }),
        unavailable: () => new TestFailure({ code: "BrowserUnavailable" }),
      },
      timing: { stepWaitMs: 30_000, pollMs: 250 },
      sent: { current: false },
    }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext)),
  );
  return { outcome, fills };
};

const fieldless = { fields: [], submit: "#continue" };

it("waits again for a fieldless screen whose submit stayed disabled, then clicks it once enabled", async () => {
  const { outcome, fills } = await replay(fieldless, [
    "stayed_disabled",
    "stayed_disabled",
    "clicked",
  ]);

  expect(outcome).toMatchObject({ outcome: "signed_in" });
  expect(fills).toBe(3);
});

it("ends a fieldless screen whose submit stays disabled through its screen's wait, sending nothing", async () => {
  const { outcome, fills } = await replay(fieldless, ["stayed_disabled"]);

  expect(outcome).toEqual({ outcome: "unsent", reason: "submit_stayed_disabled" });
  // 30 s of screen wait at 5 s a fill.
  expect(fills).toBe(6);
});

it("ends a screen with fields at once when its submit stayed disabled", async () => {
  const { outcome, fills } = await replay(
    {
      fields: [{ selector: "#username", accepts: ["username"] }],
      submit: "#next",
    },
    ["stayed_disabled", "clicked"],
    { username: "synthetic-user" },
  );

  expect(outcome).toEqual({ outcome: "unsent", reason: "submit_stayed_disabled" });
  expect(fills).toBe(1);
});
