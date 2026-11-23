import { Data, Effect } from "effect";
import { expect, it } from "vitest";
import type { AutofillStep } from "../../src/destinations/autofill-step.js";
import {
  armStep,
  recordStep,
  submitFilled,
  type AutofillSignInState,
  type SecurityAnswerFills,
} from "../../src/runtime/autofill-state.js";
import {
  type AutofillLogin,
  type HostedValues,
  makeAutofillValues,
} from "../../src/runtime/autofill-values.js";
import type { InputAsker, InputRequest } from "../../src/runtime/input-request.js";

// What a host gives from what it keeps besides the login's record (`hosted`), and what the shared
// sign-in code tells a host's record of the security answers it types.

class UnavailableValue extends Data.TaggedError("UnavailableValue")<{
  readonly operation: string;
}> {}

const values = (hosted?: HostedValues<UnavailableValue, AutofillLogin>) =>
  makeAutofillValues({
    broker: { register: () => Effect.void },
    unavailable: (operation) => new UnavailableValue({ operation }),
    site: "example.test",
    given: { current: {} },
    hosted,
  });

/** An owner who answers every question with `value`, recording each request. */
const owner = (value: string) => {
  const requests: InputRequest[] = [];
  const ask: InputAsker = (request) =>
    Effect.sync(() => {
      requests.push(request);
      return Object.fromEntries(
        request.questions.map((question) => [question.id, { type: "secret" as const, value }]),
      );
    });
  return { ask, requests };
};
const neverAsked: InputAsker = () => Effect.dieMessage("The owner was asked");
const login = (ask: InputAsker): AutofillLogin => ({
  credentials: { username: "synthetic-user", password: "synthetic-password" },
  ask,
});

it.each([
  ["a code", "code", "code"],
  ["a recovery code", "recovery_code", "recovery_code"],
  ["a security answer", "private_answer", "private_answer"],
] as const)("asks the owner for %s when the host gives none", async (_name, slot, question) => {
  const answering = owner("synthetic-value");
  const filled = await Effect.runPromise(
    values().valuesFor({ fields: [{ selector: "#value", slot }] }, login(answering.ask)),
  );
  expect(filled).toMatchObject({ values: ["synthetic-value"], step: { fields: [{ slot }] } });
  expect(answering.requests.map((request) => request.questions.map(({ id }) => id))).toEqual([
    [question],
  ]);
});

it("takes the host's code for a code field, with the step's login, and asks the owner nothing", async () => {
  const heard: AutofillLogin[] = [];
  const autofill = values({
    code: (given) =>
      Effect.sync(() => {
        heard.push(given);
        return { slot: "code" as const, value: "246810" };
      }),
  });
  const held = login(neverAsked);
  const filled = await Effect.runPromise(
    autofill.valuesFor({ fields: [{ selector: "#code", slot: "code" }] }, held),
  );
  expect(filled).toMatchObject({ values: ["246810"] });
  expect(heard).toHaveLength(1);
  expect(heard[0]).toBe(held);
  expect(heard[0]).not.toHaveProperty("codeBoxes");
});

it("asks the host once for a screen of several code fields, naming how many it fills", async () => {
  const heard: AutofillLogin[] = [];
  const autofill = values({
    code: (given) =>
      Effect.sync(() => {
        heard.push(given);
        return { slot: "code" as const, value: "246810" };
      }),
  });
  const held = login(neverAsked);
  const boxes: AutofillStep = {
    fields: Array.from({ length: 6 }, (_, index) => ({
      selector: `#digit-${index}`,
      slot: "code" as const,
    })),
  };
  const filled = await Effect.runPromise(autofill.valuesFor(boxes, held));
  expect(filled).toMatchObject({ values: Array.from({ length: 6 }, () => "246810") });
  expect(heard).toEqual([{ ...held, codeBoxes: 6 }]);
});

it("tells the host's security answer record each time a screen's values start resolving", async () => {
  let begun = 0;
  const securityAnswers: SecurityAnswerFills = {
    begin: () => {
      begun += 1;
    },
    arm: () => undefined,
    settle: () => undefined,
    submitted: () => undefined,
  };
  const autofill = values();
  const step = { fields: [{ selector: "#user", slot: "username" as const }] };
  const held = { ...login(neverAsked), securityAnswers };
  await Effect.runPromise(autofill.valuesFor(step, held));
  expect(begun).toBe(1);
  await Effect.runPromise(autofill.valuesFor(step, held));
  expect(begun).toBe(2);
});

it("tells the host's security answer record a screen's fill started, returned and was submitted, in that order", async () => {
  const calls: unknown[][] = [];
  const securityAnswers: SecurityAnswerFills = {
    begin: () => calls.push(["begin"]),
    arm: (step, filled) => calls.push(["arm", step, filled]),
    settle: (step, reached) => calls.push(["settle", step, reached]),
    submitted: () => calls.push(["submitted"]),
  };
  const signIn: AutofillSignInState = {
    hooks: {
      inspect: () => Effect.dieMessage("Unexpected inspect"),
      fill: () => Effect.dieMessage("Unexpected fill"),
      confirm: () => Effect.dieMessage("Unexpected confirm"),
      check: () => Effect.dieMessage("Unexpected check"),
      open: () => Effect.dieMessage("Unexpected open"),
    },
    steps: [],
    filled: new Map(),
    submittedSlots: new Set(),
    sentIdentifiers: {},
    securityAnswers,
  };
  const target = {
    ownerUrl: "https://example.test/verify",
    documentOrigin: "https://example.test",
    actions: ["https://example.test/verify"],
    methods: ["post"],
    editable: true,
    control: "text" as const,
  };
  const step: AutofillStep = {
    fields: [
      { selector: "#user", slot: "username" },
      { selector: "#answer", slot: "private_answer" },
    ],
    submit: "#go",
  };
  await Effect.runPromise(
    armStep(
      signIn,
      step,
      { page: "https://example.test/verify", targets: { fields: [target, target], submit: target } },
      ["synthetic-user", "synthetic-answer"],
      () => Effect.succeed(false),
    ),
  );
  recordStep(signIn, step, {
    outcome: "filled",
    fields: [
      { slot: "username", status: "filled" },
      { slot: "private_answer", status: "filled" },
    ],
    submit: "clicked",
    url: "https://example.test/verify",
  });
  submitFilled(signIn);
  expect(calls).toEqual([
    ["arm", step, ["synthetic-user", "synthetic-answer"]],
    ["settle", step, [true, true]],
    ["submitted"],
  ]);
  // A security answer is never held as filled: only the identifier counts as submitted.
  expect([...signIn.submittedSlots]).toEqual(["username"]);
});
