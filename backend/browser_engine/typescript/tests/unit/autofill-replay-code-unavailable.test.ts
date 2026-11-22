import { Data, Effect, Either } from "effect";
import { expect, it } from "vitest";
import type { AutofillInspection, AutofillStep } from "../../src/destinations/autofill-step.js";
import { credentialUnavailable } from "../../src/runtime/autofill-fresh-values.js";
import { makeReplay } from "../../src/runtime/autofill-replay-session.js";
import type { AutofillHooks } from "../../src/runtime/autofill-state.js";
import { Unanswered } from "../../src/runtime/login-field-asks.js";

// After the site refused a code, a code screen whose code the host can't give ends as the site's
// refusal, unless the host's own code source could give no code at all
// (`credentialUnavailable`): that step fails as the host's outage, through `failures.unanswered`.

class TestFailure extends Data.TaggedError("TestFailure")<{
  readonly cause: unknown;
}> {}

const origin = "https://example.test";
const page = `${origin}/verify`;
const codeStep: AutofillStep = {
  fields: [{ selector: "#code", slot: "code" }],
  submit: "#verify",
};
const target = {
  ownerUrl: null,
  documentOrigin: origin,
  actions: [`${origin}/session`],
  methods: ["post"],
  editable: true,
  control: "text" as const,
};
const inspection: AutofillInspection = {
  page,
  siteOrigin: origin,
  authenticationOrigins: [],
  targets: { fields: [target], submit: target },
  screen: { origin, fields: [], submit: null, buttons: ["Verify"] },
};

/** A code screen run again after a refused code, whose host code source answers `cause`. */
const retryWithout = async (cause: string) => {
  const unanswered: unknown[] = [];
  let fills = 0;
  const hooks: AutofillHooks<TestFailure> = {
    open: () => Effect.void,
    check: () =>
      Effect.succeed({ signedIn: false, failed: "indicator_not_visible", url: page } as const),
    confirm: () =>
      Effect.succeed({ signedIn: false, failed: "indicator_not_visible", url: page } as const),
    inspect: () => Effect.succeed(inspection),
    fill: () =>
      Effect.sync(() => {
        fills += 1;
        return { outcome: "filled" as const, fields: [], submit: "clicked" as const, url: page };
      }),
  };
  const replay = makeReplay({
    recipe: {
      version: 2,
      steps: [{ page, fields: [{ selector: "#code", slot: "code" }], submit: "#verify" }],
      signedIn: { selector: "#account" },
    },
    hooks,
    entryUrl: page,
    credentials: { username: "synthetic-user", password: "synthetic-password" },
    ask: () => Effect.dieMessage("The owner was asked"),
    broker: {
      register: () => Effect.void,
      registeredSecretMatches: () => Effect.succeed([]),
    },
    site: "example.test",
    correlation: undefined,
    emit: () => Effect.void,
    failures: {
      unanswered: (reason) => {
        unanswered.push(reason);
        return new TestFailure({ cause: reason });
      },
      unavailable: () => new TestFailure({ cause: "unavailable" }),
    },
    timing: { stepWaitMs: 60, pollMs: 5 },
    sent: { current: false },
    hosted: { code: () => Effect.succeed(new Unanswered(cause)) },
  });
  const result = await Effect.runPromise(
    Effect.either(replay.runStep(codeStep, inspection, "rejected")),
  );
  return { result, unanswered, fills };
};

it("fails the step through failures.unanswered when the host's code source can give no code", async () => {
  const { result, unanswered, fills } = await retryWithout(credentialUnavailable);
  expect(result).toEqual(Either.left(new TestFailure({ cause: credentialUnavailable })));
  expect(unanswered).toEqual([credentialUnavailable]);
  expect(fills).toBe(0);
});

it("ends as the site's refusal of the code when the host has no new code for another reason", async () => {
  const { result, unanswered, fills } = await retryWithout("code_corrections_exhausted");
  expect(result).toEqual(Either.right("code_rejected"));
  expect(unanswered).toEqual([]);
  expect(fills).toBe(0);
});
