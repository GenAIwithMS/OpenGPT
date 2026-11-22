import { Data, Duration, Effect, Fiber, Option, TestClock, TestContext } from "effect";
import { expect, it } from "vitest";
import type { AutofillRecipe } from "../../src/destinations/autofill-recipe.js";
import type { AutofillStep } from "../../src/destinations/autofill-step.js";
import { replayAutofillRecipe } from "../../src/runtime/autofill-replay.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";

// A saved session whose site shows a page of its own at the login address, with no sign-in form,
// no marker and no redirect. No check of the session opens the recipe's account page: a read's
// value-free check ends on that login entry as one that can't tell once it stayed put, and the
// operation that runs next decides. A browser that started empty, a sign-in that follows a read of
// the page signed out, a write, or a wait after a recorded click waits for its screen instead.

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

const origin = "https://example.test";
const login = `${origin}/login`;
const target = {
  ownerUrl: null,
  documentOrigin: origin,
  actions: [`${origin}/session`],
  methods: ["post"],
  editable: true,
  control: "text" as const,
};
const pollMs = 50;

/** A site signed in already, whose login address shows its public page. */
const replay = async (
  steps: AutofillRecipe["steps"],
  options: {
    readonly read?: boolean;
    readonly startedEmpty?: boolean;
    readonly readSignedOut?: boolean;
  } = {},
) => {
  const opened: string[] = [];
  const confirmed: (string | undefined)[] = [];
  const events: unknown[] = [];
  const isLogIn = (step: AutofillStep) => step.submit === "#log-in" && step.fields.length === 0;
  const hooks: AutofillHooks<TestFailure> = {
    open: (url) =>
      Effect.sync(() => {
        opened.push(url);
      }),
    check: () =>
      Effect.succeed({ signedIn: false, failed: "indicator_not_visible", url: login } as const),
    confirm: (indicator) =>
      Effect.sync(() => {
        confirmed.push(indicator.openPath);
        return indicator.openPath === undefined
          ? ({ signedIn: false, failed: "indicator_not_visible", url: login } as const)
          : ({ signedIn: true, url: `${origin}/account` } as const);
      }),
    // Only a "Log in" link shows; no recorded sign-in screen does.
    inspect: (step) =>
      Effect.succeed(
        isLogIn(step)
          ? {
              page: login,
              siteOrigin: origin,
              authenticationOrigins: [],
              targets: { fields: [], submit: target },
              screen: { origin, fields: [], submit: null, buttons: ["Log in"] },
            }
          : ({ outcome: "refused", reason: "not_found" } as const),
      ),
    fill: () =>
      Effect.succeed({ outcome: "filled" as const, fields: [], submit: "clicked" as const, url: login }),
    ...(options.read === true ? { confirmCantTell: () => Effect.void } : {}),
    ...(options.startedEmpty === undefined ? {} : { startedEmpty: options.startedEmpty }),
  };
  const recipe: AutofillRecipe = {
    version: 2,
    steps,
    signedIn: { selector: "#identity", openPath: "/account" },
  };
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const running = yield* Effect.fork(
        replayAutofillRecipe({
          recipe,
          hooks,
          entryUrl: login,
          credentials: undefined,
          ...(options.readSignedOut === undefined ? {} : { readSignedOut: options.readSignedOut }),
          ask: () => Effect.dieMessage("Unexpected question"),
          broker: {
            register: () => Effect.void,
            registeredSecretMatches: () => Effect.succeed([]),
          },
          site: "example.test",
          correlation: undefined,
          emit: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          failures: {
            unanswered: () => new TestFailure({ code: "Unanswered" }),
            unavailable: () => new TestFailure({ code: "Unavailable" }),
          },
          timing: { stepWaitMs: 5_000, pollMs },
          sent: { current: false },
        }).pipe(Effect.scoped),
      );
      for (let polls = 0; polls < 1_000; polls++) {
        if (Option.isSome(yield* Fiber.poll(running))) break;
        yield* TestClock.adjust(Duration.millis(pollMs));
      }
      return yield* Fiber.join(running);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );
  return { outcome, opened, confirmed, events };
};

const passwordScreen = {
  page: login,
  fields: [{ selector: "#password", slot: "password" as const }],
  submit: "#go",
};

it("ends a read's value-free check on a login entry with no form or marker as can't tell, opening no account page", async () => {
  const { outcome, opened, confirmed, events } = await replay([passwordScreen], { read: true });
  expect(outcome).toEqual({ outcome: "signed_in", alreadySignedIn: true, cantTell: true });
  expect(events).toContainEqual({ stage: "skipped", reason: "cant_tell_entry" });
  expect(opened).toEqual([login]);
  expect(confirmed).toEqual([]);
});

it.each([
  ["in a browser that started empty", { read: true, startedEmpty: true }],
  ["in the sign-in that follows a read of the page signed out", { read: true, readSignedOut: true }],
  ["for a write", { read: false }],
] as const)(
  "waits for the first screen on such a login entry %s, opening no account page",
  async (_, options) => {
    const { outcome, opened, confirmed, events } = await replay([passwordScreen], options);
    expect(outcome).toMatchObject({ outcome: "unsent" });
    expect(events).not.toContainEqual({ stage: "skipped", reason: "cant_tell_entry" });
    expect(opened).toEqual([login]);
    expect(confirmed).toEqual([]);
  },
);

it("never checks the account page once a recorded click ran, so the entry is not reopened", async () => {
  const logIn = { page: login, fields: [], submit: "#log-in" };
  const { outcome, opened, confirmed } = await replay([logIn, passwordScreen], { read: true });
  expect(outcome).toMatchObject({ outcome: "unsent" });
  expect(opened).toEqual([login]);
  expect(confirmed).toEqual([]);
});
