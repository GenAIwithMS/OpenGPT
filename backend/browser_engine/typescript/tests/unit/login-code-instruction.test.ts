import { Data, Effect, Either, Schema } from "effect";
import { expect, it } from "vitest";
import type { AutofillStep } from "../../src/destinations/autofill-step.js";
import {
  guardianExecutionPolicy,
  nativeExecutionEnvironment,
} from "../../src/guardian/execution-policy.js";
import { SignInStep } from "../../src/mint/contracts.js";
import { type AutofillLogin, makeAutofillValues } from "../../src/runtime/autofill-values.js";
import type { InputAsker, InputRequest } from "../../src/runtime/input-request.js";
import type { ShownAnswerField } from "../../src/runtime/login-field-asks.js";

// A code screen that asks the owner to do something first, such as call a number or approve in an
// app, names the element with that instruction as the code field's `questionSelector`. The host
// reads that element's text at inspection and asks for the code with it, so the owner knows what
// the site wants. A plain code screen keeps the plain question.

class UnavailableValue extends Data.TaggedError("UnavailableValue")<{
  readonly operation: string;
}> {}

const values = () =>
  makeAutofillValues({
    broker: { register: () => Effect.void },
    unavailable: (operation) => new UnavailableValue({ operation }),
    site: "example.test",
    given: { current: {} },
  });

/** An owner who answers every question with a code, recording each request. */
const owner = () => {
  const requests: InputRequest[] = [];
  const ask: InputAsker = (request) =>
    Effect.sync(() => {
      requests.push(request);
      return Object.fromEntries(
        request.questions.map((question) => [question.id, { type: "secret" as const, value: "4821" }]),
      );
    });
  return { ask, requests };
};

const login = (ask: InputAsker, more: Partial<AutofillLogin> = {}): AutofillLogin => ({
  credentials: { username: "synthetic-user", password: "synthetic-password" },
  ask,
  ...more,
});

const codeStep: AutofillStep = {
  fields: [{ selector: "#code", slot: "code", questionSelector: "#call-in" }],
  submit: "#verify",
};

const instruction =
  "Call 1-800-555-0100 from the phone on your account within 5 minutes. A voice reads you a 4-digit code.";

/** The code field as the host inspected it: the instruction it read, or none. */
const shown = (field: Partial<ShownAnswerField> = {}): ShownAnswerField => ({
  label: "Code",
  ariaLabel: null,
  placeholder: null,
  ...field,
});

/** The prompt of the one code question the owner was asked for the step. */
const askedPrompt = async (step: AutofillStep, screen: readonly ShownAnswerField[], more = {}) => {
  const answering = owner();
  const filled = await Effect.runPromise(
    values().valuesFor(step, login(answering.ask, more), screen),
  );
  expect(filled).toMatchObject({ values: ["4821"] });
  expect(answering.requests).toHaveLength(1);
  const [question] = answering.requests[0]?.questions ?? [];
  expect(question).toMatchObject({ id: "code", type: "secret", secretKind: "one_time_code" });
  return question?.prompt;
};

it("asks for the code with the screen's own instruction, which the code field names", async () => {
  expect(await askedPrompt(codeStep, [shown({ questionText: instruction })])).toBe(
    `example.test shows this on its sign-in screen: “${instruction}” Follow it, then enter the code here.`,
  );
});

it("keeps the screen's instruction when it asks again for a newer code", async () => {
  expect(
    await askedPrompt(codeStep, [shown({ questionText: instruction })], { codeAgain: "rejected" }),
  ).toBe(
    `The site refused the last code. example.test shows this on its sign-in screen: “${instruction}” Follow it, then enter the newest code here.`,
  );
});

it("cuts a long instruction to fit the question", async () => {
  const long = `${"Call the number on the screen. ".repeat(80)}End.`;
  const prompt = await askedPrompt(codeStep, [shown({ questionText: long })]);
  expect(prompt?.length).toBeLessThanOrEqual(2_000);
  expect(prompt).toMatch(/^example\.test shows this on its sign-in screen: “Call the number/u);
  expect(prompt).toMatch(/…” Follow it, then enter the code here\.$/u);
});

it.each([
  ["a plain code screen", { fields: [{ selector: "#code", slot: "code" }] }, [shown()]],
  ["a code screen the host did not inspect", codeStep, []],
  [
    "an instruction the host could not read",
    codeStep,
    [shown({ questionText: instruction, questionUnread: true })],
  ],
] as const)("keeps today's question for %s", async (_name, step, screen) => {
  expect(await askedPrompt(step, screen)).toBe("Enter the sign-in code example.test sent you.");
});

it("asks for one code with the instruction across a screen of code boxes", async () => {
  const boxes: AutofillStep = {
    fields: [1, 2, 3, 4].map((box) => ({
      selector: `#box-${box}`,
      slot: "code" as const,
      ...(box === 1 ? { questionSelector: "#call-in" } : {}),
    })),
    submit: "#verify",
  };
  const answering = owner();
  const filled = await Effect.runPromise(
    values().valuesFor(boxes, login(answering.ask), [
      shown({ questionText: instruction }),
      shown(),
      shown(),
      shown(),
    ]),
  );
  expect(filled).toMatchObject({ values: ["4821", "4821", "4821", "4821"] });
  expect(answering.requests).toHaveLength(1);
  expect(answering.requests[0]?.questions[0]?.prompt).toContain(instruction);
});

it("lets a code field name its screen's instruction, and no other field but a private answer", () => {
  const code = { selector: "#code", slot: "code", questionSelector: "#call-in" };
  expect(Schema.decodeUnknownSync(SignInStep)({ fields: [code] })).toEqual({ fields: [code] });
  for (const slot of ["password", "recovery_code", "zip"])
    expect(
      Either.isLeft(Schema.decodeUnknownEither(SignInStep)({ fields: [{ ...code, slot }] })),
    ).toBe(true);
});

it("tells Guardian what a code field's question selector names", () => {
  expect(guardianExecutionPolicy(nativeExecutionEnvironment)).toContain(
    "A code field's questionSelector, when present, must be the screen's own instruction for that code, such as to call a number or approve in an app.",
  );
});
