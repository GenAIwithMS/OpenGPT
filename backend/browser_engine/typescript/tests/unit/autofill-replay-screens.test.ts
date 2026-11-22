import { Clock, Data, Duration, Effect, Fiber, Option, TestClock, TestContext } from "effect";
import { expect, it } from "vitest";
import type { AutofillStep } from "../../src/destinations/autofill-step.js";
import { makeReplayScreenWait } from "../../src/runtime/autofill-replay-screens.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

it.each(["not_found", "not_editable"] as const)(
  "keeps a required account choice when it is %s beside ready password fields",
  async (reason) => {
    const page = "https://example.test/login";
    const choice = { fields: [], submit: "#authorized-plan" } satisfies AutofillStep;
    const password = {
      fields: [{ slot: "password", selector: "#password" }],
      submit: "#submit",
    } satisfies AutofillStep;
    const later = { ...password, page };
    const hooks: AutofillHooks<TestFailure> = {
      inspect: (step) =>
        Effect.succeed(
          step.fields[0]?.selector === "#password"
            ? {
                page,
                siteOrigin: "https://example.test",
                authenticationOrigins: [],
                targets: { fields: [], submit: null },
                screen: { origin: "https://example.test", fields: [], submit: null, buttons: [] },
              }
            : { outcome: "refused", reason },
        ),
      check: () => Effect.succeed({ signedIn: false, failed: "indicator_not_visible", url: page }),
      fill: () => Effect.dieMessage("Unexpected fill"),
      confirm: () => Effect.dieMessage("Unexpected confirm"),
      open: () => Effect.dieMessage("Unexpected open"),
    };
    const wait = makeReplayScreenWait(
      {
        hooks,
        entryUrl: page,
        recipe: {
          version: 1,
          steps: [{ ...choice, page }, later],
          signedIn: { selector: "#identity" },
        },
        emit: () => Effect.void,
        correlation: { jobId: "job", attemptId: "attempt" },
        credentials: undefined,
      },
      { anythingSent: false, ran: [] },
      { stepWaitMs: 0, pollMs: 1 },
      () => password,
    );
    const result = await Effect.runPromise(
      wait(choice, 0, page, [later]).pipe(Effect.provide(TestContext.TestContext)),
    );
    expect(result).toEqual({ found: { outcome: "refused", reason } });
  },
);

// A single-page app's login route shows a signed-in browser its form for a moment, then its script
// sends the browser on: the saved session's value-free check waits that out and finds the marker,
// while a replay holding the login fills the form it found at once.
it.each([
  ["value-free check", undefined, "signed_in"],
  ["replay with the login", { username: "user", password: "secret" }, "found"],
] as const)("a %s on a form that goes a moment after it shows", async (_, credentials, ends) => {
  const page = "https://example.test/login";
  const form = {
    fields: [{ slot: "password", selector: "#password" }],
    submit: "#next",
  } satisfies AutofillStep;
  let looks = 0;
  const shownLooks = 3;
  const shown = {
    page,
    siteOrigin: "https://example.test",
    authenticationOrigins: [],
    targets: { fields: [], submit: null },
    screen: { origin: "https://example.test", fields: [], submit: null, buttons: [] },
  };
  const expected = { signed_in: "signed_in", found: { found: shown } }[ends];
  const hooks: AutofillHooks<TestFailure> = {
    inspect: () =>
      Effect.sync(() => {
        looks += 1;
        return looks <= shownLooks ? shown : { outcome: "refused", reason: "not_found" };
      }),
    check: () =>
      Effect.sync(() =>
        looks > shownLooks
          ? { signedIn: true, url: "https://example.test/home" }
          : { signedIn: false, failed: "indicator_not_visible", url: page },
      ),
    fill: () => Effect.dieMessage("Unexpected fill"),
    confirm: () => Effect.dieMessage("Unexpected confirm"),
    open: () => Effect.dieMessage("Unexpected open"),
  };
  const wait = makeReplayScreenWait(
    {
      hooks,
      entryUrl: page,
      recipe: {
        version: 1,
        steps: [{ ...form, page }],
        signedIn: { selector: "#identity" },
      },
      emit: () => Effect.void,
      correlation: { jobId: "job", attemptId: "attempt" },
      credentials,
    },
    { anythingSent: false, ran: [] },
    { stepWaitMs: 60_000, pollMs: 1 },
    () => form,
  );
  const result = await Effect.runPromise(wait(form, Date.now() + 60_000, page));
  expect(result).toEqual(expected);
});

// A saved profile's login entry whose form draws seconds after the page loads: the value-free
// check ends on a login entry that can't tell only once the page settled, never while it still
// draws, and never in the sign-in that follows a read of the page signed out.
it.each([
  ["still drawing its form", { drawing: true, readSignedOut: false }],
  ["static, after a read of the page signed out", { drawing: false, readSignedOut: true }],
] as const)(
  "a value-free check waits for a login form drawn 2.5 s late on an entry page %s",
  async (_, { drawing, readSignedOut }) => {
    const page = "https://example.test/login";
    const form = {
      fields: [{ slot: "password", selector: "#password" }],
      submit: "#next",
    } satisfies AutofillStep;
    const drawnAtMs = 2_500;
    const shown = {
      page,
      siteOrigin: "https://example.test",
      authenticationOrigins: [],
      targets: { fields: [], submit: null },
      screen: { origin: "https://example.test", fields: [], submit: null, buttons: [] },
    };
    const hooks: AutofillHooks<TestFailure> = {
      inspect: () =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) =>
            now >= drawnAtMs
              ? shown
              : { outcome: "refused" as const, reason: "not_found" as const },
          ),
        ),
      check: () => Effect.succeed({ signedIn: false, failed: "indicator_not_visible", url: page }),
      // A page drawing its form keeps changing; a static one does not.
      pageState: () =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) => ({ parsed: true, shape: drawing ? `${page}|${now}` : `${page}|1` })),
        ),
      confirmCantTell: () => Effect.void,
      fill: () => Effect.dieMessage("Unexpected fill"),
      confirm: () => Effect.dieMessage("Unexpected confirm"),
      open: () => Effect.dieMessage("Unexpected open"),
    };
    const progress = { anythingSent: false, ran: [] };
    const wait = makeReplayScreenWait(
      {
        hooks,
        entryUrl: page,
        recipe: { version: 1, steps: [{ ...form, page }], signedIn: { selector: "#identity" } },
        emit: () => Effect.void,
        correlation: { jobId: "job", attemptId: "attempt" },
        credentials: undefined,
        readSignedOut,
      },
      progress,
      { stepWaitMs: 60_000, pollMs: 100 },
      () => form,
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const waiting = yield* Effect.fork(wait(form, 60_000, page));
        for (let polls = 0; polls < 1_000; polls++) {
          if (Option.isSome(yield* Fiber.poll(waiting))) break;
          yield* TestClock.adjust(Duration.millis(100));
        }
        return yield* Fiber.join(waiting);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );
    expect(result).toEqual({ found: shown });
    expect(progress).not.toHaveProperty("entryCantTell", true);
  },
);
