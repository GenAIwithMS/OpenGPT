import { Clock, Data, Duration, Effect, Fiber, Option, TestClock, TestContext } from "effect";
import { expect, it } from "vitest";
import type { AutofillRecipe } from "../../src/destinations/autofill-recipe.js";
import type { AutofillSignedInCheck, AutofillStep } from "../../src/destinations/autofill-step.js";
import { replayAutofillRecipe } from "../../src/runtime/autofill-replay.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";

// What a screen's wait does after the host filled a screen: a fill whose screen went with nothing
// sent waits again once, as a single-page app's login route removes its form while it sends a
// signed-in browser on; and once the login went out, a page off the sign-in screens that can't
// tell, such as an account picker in place of a code screen the site skipped, ends the wait. A
// submitted screen still showing is the site's answer only at the wait's deadline.

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

const origin = "https://example.test";
const login = `${origin}/login`;
const pollMs = 50;
const target = {
  ownerUrl: null,
  documentOrigin: origin,
  actions: [`${origin}/session`],
  methods: ["post"],
  editable: true,
  control: "text" as const,
};
const passwordScreen = {
  page: login,
  fields: [{ selector: "#password", slot: "password" as const }],
  submit: "#go",
};
const isPassword = (step: AutofillStep) =>
  step.fields.some((field) => field.selector === "#password");
const shownAt = (page: string, step: AutofillStep) => ({
  page,
  siteOrigin: origin,
  authenticationOrigins: [],
  targets: {
    fields: step.fields.map(() => target),
    submit: { ...target, editable: false, control: "other" as const },
  },
  screen: { origin, fields: [], submit: null, buttons: ["Sign in"] },
});

/** Replays `recipe` with the login on `hooks`, the test clock moving one poll at a time. */
const replay = async (recipe: AutofillRecipe, hooks: AutofillHooks<TestFailure>) => {
  const events: unknown[] = [];
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const running = yield* Effect.fork(
        replayAutofillRecipe({
          recipe,
          hooks,
          entryUrl: login,
          credentials: { username: "synthetic-user", password: "synthetic-password" },
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
  return { outcome, events };
};

/**
 * A saved profile's login form that the page removes as the host fills it, sending nothing, then
 * the page moves on to the signed-in home page; with `stays`, the form stays and the fill failed.
 */
const goneUnderFill = (stays: boolean) => {
  let page: "login" | "home" = "login";
  const here = (): AutofillSignedInCheck =>
    page === "home"
      ? { signedIn: true, url: `${origin}/home` }
      : { signedIn: false, failed: "indicator_not_visible", url: login };
  const hooks: AutofillHooks<TestFailure> = {
    open: () => Effect.void,
    check: () => Effect.sync(here),
    confirm: () => Effect.sync(here),
    inspect: (step) =>
      Effect.sync(() =>
        page === "login" && isPassword(step)
          ? shownAt(login, step)
          : ({ outcome: "refused", reason: "not_found" } as const),
      ),
    fill: ({ step }) =>
      Effect.sync(() => {
        if (!stays) page = "home";
        return {
          outcome: "filled" as const,
          fields: step.fields.map((field) => ({ slot: field.slot, status: "failed" as const })),
          submit: "not_attempted" as const,
          url: login,
        };
      }),
  };
  return hooks;
};

const recipe: AutofillRecipe = {
  version: 2,
  steps: [passwordScreen],
  signedIn: { selector: "#identity" },
};

it("waits again once when a fill's screen went with nothing sent, and finds the session signed in", async () => {
  const { outcome, events } = await replay(recipe, goneUnderFill(false));
  expect(outcome).toEqual({ outcome: "signed_in", alreadySignedIn: true });
  expect(events).toContainEqual({ stage: "retried", reason: "screen_gone" });
});

it("ends a failed fill whose screen still shows as before", async () => {
  const { outcome, events } = await replay(recipe, goneUnderFill(true));
  expect(outcome).toMatchObject({ outcome: "unsent", reason: "fill_failed" });
  expect(events).not.toContainEqual({ stage: "retried", reason: "screen_gone" });
});

it("ends a code screen's wait on an account picker that can't tell once the password went out", async () => {
  let page: "login" | "picker" = "login";
  const confirmed: unknown[] = [];
  const here = (): AutofillSignedInCheck =>
    page === "picker"
      ? { signedIn: false, failed: "path_mismatch", url: `${origin}/choose` }
      : { signedIn: false, failed: "indicator_not_visible", url: login };
  const hooks: AutofillHooks<TestFailure> = {
    open: () => Effect.void,
    check: () => Effect.sync(here),
    confirm: () => Effect.sync(here),
    inspect: (step) =>
      Effect.sync(() =>
        page === "login" && isPassword(step)
          ? shownAt(login, step)
          : ({ outcome: "refused", reason: "not_found" } as const),
      ),
    fill: ({ step }) =>
      Effect.sync(() => {
        page = "picker";
        return {
          outcome: "filled" as const,
          fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
          submit: "clicked" as const,
          url: login,
        };
      }),
    confirmCantTell: (identifiers) =>
      Effect.sync(() => {
        confirmed.push(identifiers);
      }),
  };
  const { outcome, events } = await replay(
    {
      version: 2,
      steps: [
        passwordScreen,
        { page: `${origin}/verify`, fields: [{ selector: "#code", slot: "code" }], submit: "#verify" },
      ],
      signedIn: { selector: "#identity", urlPath: "/account" },
    },
    hooks,
  );
  expect(outcome).toMatchObject({ outcome: "signed_in", alreadySignedIn: false, cantTell: true });
  expect(events).toContainEqual({ stage: "skipped", reason: "cant_tell_landing" });
  expect(confirmed).toHaveLength(1);
});

it("waits for a password screen the site shows 1.5 s after the identifier went out", async () => {
  let continuedAt: number | undefined;
  let signedIn = false;
  const here = (): AutofillSignedInCheck =>
    signedIn
      ? { signedIn: true, url: `${origin}/home` }
      : { signedIn: false, failed: "indicator_not_visible", url: login };
  const hooks: AutofillHooks<TestFailure> = {
    open: () => Effect.void,
    check: () => Effect.sync(here),
    confirm: () => Effect.sync(here),
    // The site looks the account up for 1.5 s, showing the identifier screen meanwhile.
    inspect: (step) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) =>
          isPassword(step) === (continuedAt !== undefined && now - continuedAt >= 1_500)
            ? shownAt(login, step)
            : ({ outcome: "refused", reason: "not_found" } as const),
        ),
      ),
    fill: ({ step }) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          if (isPassword(step)) signedIn = true;
          else continuedAt = now;
          return {
            outcome: "filled" as const,
            fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
            submit: "clicked" as const,
            url: login,
          };
        }),
      ),
  };
  const { outcome } = await replay(
    {
      version: 2,
      steps: [
        { page: login, fields: [{ selector: "#email", accepts: ["username"] }], submit: "#continue" },
        passwordScreen,
      ],
      signedIn: { selector: "#identity" },
    },
    hooks,
  );
  expect(outcome).toMatchObject({ outcome: "signed_in", alreadySignedIn: false });
});
