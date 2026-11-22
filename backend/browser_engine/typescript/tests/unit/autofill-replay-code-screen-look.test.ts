import { Clock, Data, Duration, Effect, Fiber, TestClock, TestContext } from "effect";
import { expect, it } from "vitest";
import type { AutofillRecipe } from "../../src/destinations/autofill-recipe.js";
import type { AutofillRefusal, AutofillStep } from "../../src/destinations/autofill-step.js";
import { replayAutofillRecipe } from "../../src/runtime/autofill-replay.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";

// The marker wait after the screens ends at a code screen the recipe never recorded only for a
// replay that hands over at one (`endAtUnrecordedCode`). Every other replay never looks for one
// while it waits, so a slow sign-in pays no extra read, and looks once, after the 30 s wait, as
// before. The page is scripted on a test clock.

class TestFailure extends Data.TaggedError("TestFailure")<{ readonly code: string }> {}

const origin = "https://example.test";
const target = {
  ownerUrl: null,
  documentOrigin: origin,
  actions: [`${origin}/session`],
  methods: ["post"],
  editable: true,
  control: "text" as const,
};

/** The host's own code for a code screen, as a host with a saved authenticator gives one. */
const hostCode = "246810";

/** A code field as the host describes it, by its name alone. */
const codeField = (name: string) => ({
  tag: "input",
  role: null,
  formMethod: "post",
  type: "text",
  name,
  id: null,
  autocomplete: null,
  inputmode: "numeric",
  label: null,
  placeholder: null,
  ariaLabel: null,
  text: null,
  slot: "code" as const,
});

/** A screen the page shows, its fields empty or not, and the code field's name when it has one. */
const shown = (step: AutofillStep, page: string, empty: boolean, codeName?: string) => ({
  page,
  siteOrigin: origin,
  authenticationOrigins: [],
  targets: {
    fields: step.fields.map(() => ({ ...target, empty })),
    submit: { ...target, editable: false, control: "other" as const },
  },
  screen: {
    origin,
    fields: codeName === undefined ? [] : [codeField(codeName)],
    submit: null,
    buttons: ["Continue"],
  },
});

/**
 * A password screen whose submit leads to a code screen the recipe never recorded, with an empty
 * one-time-code field. The submitted password field's own check then answers `submitted`: gone
 * (`not_found`), still showing (`shown`), or another refusal. The code screen's fill may type the
 * code behind a submit that stays disabled (`typed`), or type nothing (`nothing`), sending nothing
 * either way. A read's replay (`cantTell`) may end on a page that can't tell, off its marker's
 * path. The code field may carry a name (`codeName`). The full check's confirmation reads signed
 * in unless `confirmed` is false. Returns when the replay looked for a code field, when it typed
 * the code and how many code fills it made, in test-clock ms.
 */
const replay = async (options: {
  readonly endAtUnrecordedCode?: boolean;
  readonly submitted: AutofillRefusal["reason"] | "shown";
  readonly codeFill?: "typed" | "nothing";
  readonly cantTell?: true;
  readonly codeName?: string;
  readonly confirmed?: false;
}) => {
  let passwordSent = false;
  let codeSent = false;
  const codeLooks: number[] = [];
  let codeTypedAt: number | undefined;
  let codeFills = 0;
  const hooks: AutofillHooks<TestFailure> = {
    open: () => Effect.void,
    check: () =>
      Effect.succeed(
        codeSent
          ? { signedIn: true as const, url: `${origin}/account` }
          : {
              signedIn: false as const,
              failed: "indicator_not_visible" as const,
              url: `${origin}/${passwordSent ? "code" : "login"}`,
            },
      ),
    confirm: () =>
      Effect.succeed(
        options.confirmed === false
          ? {
              signedIn: false as const,
              failed: "indicator_not_visible" as const,
              url: `${origin}/code`,
            }
          : { signedIn: true as const, url: `${origin}/account` },
      ),
    ...(options.cantTell ? { confirmCantTell: () => Effect.void } : {}),
    inspect: (step) =>
      Effect.gen(function* () {
        if (step.fields[0]?.slot === "code") {
          codeLooks.push(yield* Clock.currentTimeMillis);
          return passwordSent && !codeSent
            ? shown(step, `${origin}/code`, true, options.codeName)
            : { outcome: "refused" as const, reason: "not_found" as const };
        }
        if (!passwordSent) return shown(step, `${origin}/login`, true);
        return options.submitted === "shown"
          ? shown(step, `${origin}/login`, false)
          : { outcome: "refused" as const, reason: options.submitted };
      }),
    fill: ({ step }) =>
      Effect.gen(function* () {
        const code = step.fields.some((field) => field.slot === "code");
        if (code) codeFills += 1;
        else passwordSent = true;
        if (code && options.codeFill === "nothing")
          return {
            outcome: "filled" as const,
            fields: step.fields.map((field) => ({ slot: field.slot, status: "failed" as const })),
            submit: "not_attempted" as const,
            url: `${origin}/code`,
          };
        if (code) {
          codeSent = options.codeFill === undefined;
          codeTypedAt = yield* Clock.currentTimeMillis;
        }
        return {
          outcome: "filled" as const,
          fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
          submit: code && options.codeFill === "typed" ? "stayed_disabled" : "clicked",
          url: `${origin}/login`,
        };
      }),
  };
  const recipe: AutofillRecipe = {
    version: 2,
    steps: [
      {
        page: `${origin}/login`,
        fields: [{ selector: "#password", slot: "password" }],
        submit: "#continue",
      },
    ],
    signedIn: { selector: "#identity", ...(options.cantTell ? { urlPath: "/account" } : {}) },
  };
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const running = yield* Effect.fork(
        replayAutofillRecipe({
          recipe,
          hooks,
          entryUrl: `${origin}/login`,
          credentials: { username: "synthetic-user", password: "synthetic-password" },
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
          ...(options.endAtUnrecordedCode === undefined
            ? {}
            : { endAtUnrecordedCode: options.endAtUnrecordedCode }),
          sent: { current: false },
          hosted: { code: () => Effect.succeed({ slot: "code" as const, value: hostCode }) },
        }).pipe(Effect.scoped),
      );
      yield* TestClock.adjust(Duration.minutes(2));
      return yield* Fiber.join(running);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );
  return { outcome, codeLooks, codeTypedAt, codeFills };
};

it("never looks for a code field while a run's replay waits for its marker, and answers the code screen after the wait, as before", async () => {
  const { outcome, codeLooks, codeTypedAt } = await replay({ submitted: "not_found" });
  expect(outcome).toMatchObject({ outcome: "signed_in" });
  // The one look is the probe after the 30 s wait, which every replay makes.
  expect(codeLooks).toHaveLength(1);
  expect(codeLooks[0]).toBeGreaterThanOrEqual(30_000);
  expect(codeTypedAt).toBeGreaterThanOrEqual(30_000);
});

it("ends a hand-over replay's marker wait at once at a code screen the recipe never recorded, once the submitted screen is gone", async () => {
  const { outcome, codeLooks, codeTypedAt } = await replay({
    endAtUnrecordedCode: true,
    submitted: "not_found",
  });
  expect(outcome).toMatchObject({ outcome: "signed_in" });
  expect(codeLooks[0]).toBeLessThan(1_000);
  expect(codeTypedAt).toBeLessThan(1_000);
});

// The screen the replay submitted still showing is the site's answer to it, so the code box beside
// it takes no code, after the wait either: the full check decides (here, the scripted page's
// check passes).
it.each([
  ["still shows", "shown"],
  ["could not be read", "page_unavailable"],
  ["matched more than once", "ambiguous_match"],
] as const)(
  "keeps a hand-over replay's marker wait going, and types no code, while the submitted screen's field %s",
  async (_name, submitted) => {
    const { outcome, codeLooks, codeTypedAt } = await replay({
      endAtUnrecordedCode: true,
      submitted,
    });
    expect(outcome).toMatchObject({ outcome: "signed_in" });
    expect(codeLooks.at(-1)).toBeGreaterThanOrEqual(30_000);
    expect(codeTypedAt).toBeUndefined();
  },
);

// A fill that typed no code leaves the sign-in as it was, its step dropped from the screens that
// ran, so the full check decides alone: signed in when its confirmation is, else its own failed
// check, never the fill's failure.
it.each([
  ["signed in", undefined, { outcome: "signed_in" }],
  ["not signed in", false, { outcome: "unclear", reason: "sign_in_check_failed" }],
] as const)(
  "lets the full check decide when the unrecorded code screen's fill typed no code and the confirmation reads %s",
  async (_name, confirmed, expected) => {
    const { outcome, codeTypedAt, codeFills } = await replay({
      submitted: "not_found",
      codeFill: "nothing",
      ...(confirmed === undefined ? {} : { confirmed }),
    });
    expect(codeFills).toBe(1);
    expect(codeTypedAt).toBeUndefined();
    expect(outcome).toMatchObject(expected);
  },
);

// A code typed behind a submit that stayed disabled counts as sent once the replay goes on, so a
// read that may end on a page that can't tell would end signed in on the code screen, its code
// spent: the replay stops at that fill instead.
it("stops a read that may end on a page that can't tell at an unrecorded code screen whose typed code never went out", async () => {
  const { outcome, codeTypedAt } = await replay({
    submitted: "not_found",
    codeFill: "typed",
    cantTell: true,
  });
  expect(codeTypedAt).toBeDefined();
  expect(outcome).toMatchObject({ outcome: "unclear", reason: "submit_stayed_disabled" });
});

// A box the selector matched whose name holds `pin` as a word of its own names a PIN, not a code,
// so the replay types nothing into it; `pin` inside `otpInput` is no such word.
it.each([
  ["otpInput", true],
  ["pinCode", false],
] as const)(
  "decides by its name whether an unrecorded code screen's box named %s takes a code",
  async (codeName, answered) => {
    const { codeLooks, codeTypedAt, codeFills } = await replay({
      submitted: "not_found",
      codeName,
    });
    expect(codeLooks).toHaveLength(1);
    expect(codeFills).toBe(answered ? 1 : 0);
    expect(codeTypedAt === undefined).toBe(!answered);
  },
);

// A hand-over replay's marker wait looks through the same check, so a PIN's box never ends it
// early.
it("keeps a hand-over replay's marker wait going, and types no code, on a page whose only code-like box is a pinCode", async () => {
  const { codeLooks, codeTypedAt, codeFills } = await replay({
    endAtUnrecordedCode: true,
    submitted: "not_found",
    codeName: "pinCode",
  });
  expect(codeLooks[0]).toBeLessThan(1_000);
  expect(codeLooks.at(-1)).toBeGreaterThanOrEqual(30_000);
  expect(codeFills).toBe(0);
  expect(codeTypedAt).toBeUndefined();
});
