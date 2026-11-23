import { Data, Effect } from "effect";
import { expect, it } from "vitest";
import { formatDate } from "../../src/browser/form-controls.js";
import { parseDateOfBirth } from "../../src/destinations/login-field-formats.js";
import {
  type AnsweredLoginFields,
  makeAutofillValues,
  typedValues,
} from "../../src/runtime/autofill-values.js";
import {
  InputRequestFailure,
  type InputAsker,
  type InputRequest,
} from "../../src/runtime/input-request.js";
import { codeDoesNotFit, Unanswered } from "../../src/runtime/login-field-asks.js";

class UnavailableValue extends Data.TaggedError("UnavailableValue")<{
  readonly operation: string;
}> {}

const values = (given: { current: AnsweredLoginFields } = { current: {} }) => {
  const registered: string[] = [];
  const autofill = makeAutofillValues({
    broker: {
      register: (value) =>
        Effect.sync(() => {
          registered.push(value.value);
        }),
    },
    unavailable: (operation) => new UnavailableValue({ operation }),
    site: "example.test",
    given,
  });
  return { autofill, registered, given };
};
const neverAsked: InputAsker = () => Effect.dieMessage("The owner was asked");
const login = (
  credentials: {
    readonly username: string;
    readonly phone?: string;
    readonly zip?: string;
  },
  ask: InputAsker = neverAsked,
) => ({
  credentials: { ...credentials, password: "synthetic-password" },
  ask,
});
const phoneStep = { fields: [{ selector: "#tel", slot: "phone" as const }] };
const codeStep = { fields: [{ selector: "#code", slot: "code" as const }] };
/** A screen of six one-character code boxes. */
const boxesStep = {
  fields: Array.from({ length: 6 }, (_, index) => ({
    selector: `#digit-${index}`,
    slot: "code" as const,
  })),
};
/** An asker that answers each request's questions with the next of `answers`, recording each. */
const scripted = (answers: readonly string[], type: "text" | "secret" = "secret") => {
  const requests: InputRequest[] = [];
  const queue = [...answers];
  const ask: InputAsker = (request) =>
    Effect.sync(() => {
      requests.push(request);
      const value = queue.shift() ?? "";
      return Object.fromEntries(request.questions.map((question) => [question.id, { type, value }]));
    });
  return { ask, requests };
};

it.each(["fresh", "repeated"] as const)(
  "keeps a rejected manual recovery code out of a %s correction",
  async (answer) => {
    const { autofill } = values();
    let asked = 0;
    const ask: InputAsker = () =>
      Effect.sync(() => {
        asked += 1;
        return {
          recovery_code: {
            type: "secret" as const,
            value: answer === "fresh" && asked === 2 ? "fresh-recovery" : "rejected-recovery",
          },
        };
      });
    const correctionRequests = { recovery_code: 0 };
    const result = await Effect.runPromise(
      autofill.valuesFor(
        { fields: [{ selector: "#recovery", slot: "recovery_code" }] },
        {
          ...login({ username: "primary-owner" }, ask),
          rejectedValues: { recovery_code: new Set(["rejected-recovery"]) },
          correctionRequests,
        },
      ),
    );
    if (answer === "fresh") expect(result).toMatchObject({ values: ["fresh-recovery"] });
    else expect(result).toBeInstanceOf(Unanswered);
    expect(asked).toBe(2);
    expect(correctionRequests.recovery_code).toBe(2);
  },
);

it.each(["saved", "primary fallback"] as const)(
  "replaces a rejected secondary email from %s without changing the primary login",
  async (source) => {
    const { autofill, given } = values();
    const rejected = "old@example.test";
    let asked = 0;
    const ask: InputAsker = () =>
      Effect.sync(() => {
        asked += 1;
        return { email: { type: "text" as const, value: "corrected@example.test" } };
      });
    const credentials = {
      username: source === "primary fallback" ? rejected : "primary-owner",
      password: "synthetic-password",
      primaryIdentifierKind: "username" as const,
      ...(source === "saved" ? { email: rejected } : {}),
    };
    const correctionRequests = { email: 0 };
    const held = {
      credentials,
      ask,
      rejectedValues: { email: new Set([rejected]) },
      correctionRequests,
    };
    const step = { fields: [{ selector: "#email", slot: "email" as const }] };
    for (let round = 0; round < 2; round++)
      expect(await Effect.runPromise(autofill.valuesFor(step, held))).toMatchObject({
        values: ["corrected@example.test"],
      });
    expect(asked).toBe(1);
    expect(correctionRequests.email).toBe(1);
    expect(given.current.email).toBe("corrected@example.test");
    expect(credentials.username).toBe(source === "primary fallback" ? rejected : "primary-owner");
    expect(credentials.password).toBe("synthetic-password");
  },
);

it("bounds rejected secondary answers without filling the rejected value", async () => {
  const { autofill } = values();
  let asked = 0;
  const ask: InputAsker = () =>
    Effect.sync(() => {
      asked += 1;
      return { phone: { type: "text" as const, value: "+1 415 555 0142" } };
    });
  const correctionRequests = { phone: 0 };
  expect(
    await Effect.runPromise(
      autofill.valuesFor(phoneStep, {
        ...login({ username: "primary-owner", phone: "+1 415 555 0142" }, ask),
        rejectedValues: { phone: new Set(["+1 415 555 0142"]) },
        correctionRequests,
      }),
    ),
  ).toBeInstanceOf(Unanswered);
  expect(asked).toBe(2);
  expect(correctionRequests.phone).toBe(2);
});

it("fills a username slot with the stored identifier, even one that looks like a phone number", async () => {
  const { autofill } = values();
  const filled = await Effect.runPromise(
    autofill.valuesFor(
      { fields: [{ selector: "#user", slot: "username" }] },
      login({ username: "+1 415 555 0100" }),
    ),
  );
  expect(filled).toMatchObject({ values: ["+1 415 555 0100"] });
});

it("fills a phone slot from the saved record without asking", async () => {
  const { autofill } = values();
  expect(
    await Effect.runPromise(
      autofill.valuesFor(
        phoneStep,
        login({ username: "synthetic-user", phone: "+1 415 555 0142" }),
      ),
    ),
  ).toMatchObject({ values: ["+1 415 555 0142"] });
});

it("asks for an identifier the login does not hold once per attempt, and keeps it for a successor", async () => {
  const { autofill, given, registered } = values();
  const asked: string[] = [];
  const ask: InputAsker = (request) =>
    Effect.sync(() => {
      const [question] = request.questions;
      asked.push(question?.id ?? "");
      return { phone: { type: "text" as const, value: "+1 415 555 0142" } };
    });
  for (let round = 0; round < 2; round++)
    expect(
      await Effect.runPromise(
        autofill.valuesFor(phoneStep, login({ username: "synthetic-user" }, ask)),
      ),
    ).toMatchObject({ values: ["+1 415 555 0142"] });
  expect(asked).toEqual(["phone"]);
  expect(registered).toEqual(["+1 415 555 0142"]);
  // A successor restored with the attempt's answers fills it without asking.
  const successor = values({ current: { ...given.current } });
  expect(
    await Effect.runPromise(
      successor.autofill.valuesFor(phoneStep, login({ username: "synthetic-user" })),
    ),
  ).toMatchObject({ values: ["+1 415 555 0142"] });
});

// A site whose usernames are email addresses may still name an email-only field; the login's
// email-shaped username is its email address, so nothing is asked.
it("sends an email-shaped username into an email-only field without asking", async () => {
  const { autofill } = values();
  const resolved = autofill.resolve(
    { fields: [{ selector: "#email", accepts: ["email"] }] },
    { username: "owner@example.test", password: "synthetic-password" },
  );
  expect(resolved.fields).toEqual([{ selector: "#email", accepts: ["email"], slot: "email" }]);
  expect(
    await Effect.runPromise(
      autofill.valuesFor(resolved, login({ username: "owner@example.test" })),
    ),
  ).toMatchObject({ values: ["owner@example.test"] });
});

it("asks again when the answer to a phone-only field is no phone number", async () => {
  const { autofill } = values();
  const answers = ["not a number", "+1 415 555 0142"];
  let asked = 0;
  const ask: InputAsker = (request) =>
    Effect.sync(() => {
      asked += 1;
      const value = answers.shift() ?? "";
      return Object.fromEntries(
        request.questions.map((question) => [question.id, { type: "text" as const, value }]),
      );
    });
  const filled = await Effect.runPromise(
    autofill.valuesFor(phoneStep, login({ username: "synthetic-user" }, ask)),
  );
  expect(asked).toBe(2);
  expect(filled).toMatchObject({ values: ["+1 415 555 0142"] });
});

it("reads a date of birth only as a real year, month and day, and writes it in each layout and dropdown part a field takes", () => {
  expect(["1990-04-07", " 1990/4/7 ", "1990.04.07"].map(parseDateOfBirth)).toEqual([
    "1990-04-07",
    "1990-04-07",
    "1990-04-07",
  ]);
  // A day the month does not have, a 13th month and a day-first date are not dates of birth.
  expect(["1990-02-30", "1990-13-01", "07/04/1990", "April 7"].map(parseDateOfBirth)).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
  expect(
    (
      [
        "YYYY-MM-DD",
        "MM/DD/YYYY",
        "DD/MM/YYYY",
        "MMDDYYYY",
        "YYYY",
        "MM",
        "M",
        "MMM",
        "MMMM",
        "DD",
        "D",
      ] as const
    ).map((format) => formatDate("1990-04-07", format)),
  ).toEqual([
    "1990-04-07",
    "04/07/1990",
    "07/04/1990",
    "04071990",
    "1990",
    "04",
    "4",
    "Apr",
    "April",
    "07",
    "7",
  ]);
});

it("stops asking a phone-only field after three answers that are no phone number", async () => {
  const { autofill, given, registered } = values();
  let asked = 0;
  const ask: InputAsker = (request) =>
    Effect.sync(() => {
      asked += 1;
      return Object.fromEntries(
        request.questions.map((question) => [
          question.id,
          { type: "text" as const, value: "not a number" },
        ]),
      );
    });
  const filled = await Effect.runPromise(
    Effect.either(autofill.valuesFor(phoneStep, login({ username: "synthetic-user" }, ask))),
  );
  expect(asked).toBe(3);
  expect(filled).toMatchObject({ _tag: "Left", left: { operation: "autofill.ask" } });
  expect(given.current).toEqual({});
  expect(registered).toEqual([]);
});

// A username of digits is often a member number, not the login's phone number, so a phone-only
// field asks the owner instead of typing the username and binding it as the phone.
it("asks for the phone number of a login whose username is all digits, and fills nothing unanswered", async () => {
  const { autofill, given, registered } = values();
  const asked: string[] = [];
  const ask: InputAsker = (request) =>
    Effect.suspend(() => {
      asked.push(...request.questions.map((question) => question.id));
      return Effect.fail(new InputRequestFailure({ code: "NoResponse" }));
    });
  const resolved = autofill.resolve(
    { fields: [{ selector: "#tel", accepts: ["phone"] }] },
    { username: "4155550142", password: "synthetic-password" },
  );
  const filled = await Effect.runPromise(
    autofill.valuesFor(resolved, login({ username: "4155550142" }, ask)),
  );
  expect(asked).toEqual(["phone"]);
  expect(filled).not.toHaveProperty("values");
  expect(given.current).toEqual({});
  expect(registered).toEqual([]);
});

it("refuses a repeated manual code on resume without asking indefinitely", async () => {
  const { autofill } = values();
  let asked = 0;
  const ask: InputAsker = (request) =>
    Effect.suspend(() => {
      asked += 1;
      if (asked > 1) return Effect.dieMessage("A repeated resumed code caused another request");
      return Effect.succeed(
        Object.fromEntries(
          request.questions.map((question) => [
            question.id,
            { type: "secret" as const, value: "111111" },
          ]),
        ),
      );
    });
  const result = await Effect.runPromise(
    autofill.valuesFor(
      { fields: [{ selector: "#code", slot: "code" }] },
      {
        ...login({ username: "synthetic-user" }, ask),
        codeAgain: "resumed",
        rejectedCodes: new Set(["111111"]),
        codeRequests: { current: 0 },
      },
    ),
  );
  expect(result).toBeInstanceOf(Unanswered);
  expect(asked).toBe(1);
});

// The cases below have no unit counterpart to port; they cover the owner-asked date of birth, ZIP
// and code paths and `typedValues` that core keeps.

it("asks for a date of birth the login does not hold as a secret, kept as its ISO date and masked in each whole-date layout", async () => {
  const { autofill, given, registered } = values();
  const owner = scripted([" 1990/4/7 "]);
  const filled = await Effect.runPromise(
    autofill.valuesFor(
      { fields: [{ selector: "#dob", slot: "date_of_birth" }] },
      login({ username: "synthetic-user" }, owner.ask),
    ),
  );
  expect(filled).toMatchObject({ values: ["1990-04-07"] });
  expect(owner.requests.map((request) => request.questions[0])).toMatchObject([
    { id: "date_of_birth", type: "secret", secretKind: "private_text" },
  ]);
  expect(registered).toEqual(
    expect.arrayContaining([" 1990/4/7 ", "1990-04-07", "04/07/1990", "07/04/1990", "04071990"]),
  );
  expect(given.current).toEqual({ date_of_birth: "1990-04-07" });
});

it("never fills a saved ZIP the site refused, and asks for a correction in its place", async () => {
  const { autofill, registered } = values();
  const owner = scripted(["94107"]);
  const correctionRequests = { zip: 0 };
  const filled = await Effect.runPromise(
    autofill.valuesFor(
      { fields: [{ selector: "#zip", slot: "zip" }] },
      {
        ...login({ username: "synthetic-user", zip: "10001" }, owner.ask),
        rejectedValues: { zip: new Set(["10001"]) },
        correctionRequests,
      },
    ),
  );
  expect(filled).toMatchObject({ values: ["94107"] });
  expect(owner.requests).toHaveLength(1);
  expect(owner.requests[0]?.questions[0]?.prompt).toMatch(
    /^The site did not accept the last value, so it needs a correction\./u,
  );
  expect(correctionRequests.zip).toBe(1);
  expect(registered).toContain("94107");
  expect(registered).not.toContain("10001");
});

it("fills a saved ZIP the site has not refused without asking", async () => {
  const { autofill } = values();
  expect(
    await Effect.runPromise(
      autofill.valuesFor(
        { fields: [{ selector: "#zip", slot: "zip" }] },
        login({ username: "synthetic-user", zip: "10001" }),
      ),
    ),
  ).toMatchObject({ values: ["10001"] });
});

it("asks the owner for a code as given, masked with and without its separators, and keeps none for the attempt", async () => {
  const { autofill, given, registered } = values();
  const owner = scripted(["123 456"]);
  const filled = await Effect.runPromise(
    autofill.valuesFor(codeStep, login({ username: "synthetic-user" }, owner.ask)),
  );
  expect(filled).toMatchObject({ values: ["123 456"] });
  expect(owner.requests.map((request) => request.questions)).toEqual([
    [
      {
        id: "code",
        type: "secret",
        secretKind: "one_time_code",
        prompt: "Enter the sign-in code example.test sent you.",
      },
    ],
  ]);
  expect(registered).toEqual(["123 456", "123456"]);
  expect(given.current).toEqual({});
});

it("asks again for the newest code after a refusal, spending the sign-in's code re-asks", async () => {
  const { autofill } = values();
  const owner = scripted(["111111", "222222"]);
  const codeRequests = { current: 0 };
  const filled = await Effect.runPromise(
    autofill.valuesFor(codeStep, {
      ...login({ username: "synthetic-user" }, owner.ask),
      codeAgain: "rejected",
      rejectedCodes: new Set(["111111"]),
      codeRequests,
    }),
  );
  expect(filled).toMatchObject({ values: ["222222"] });
  expect(owner.requests.map((request) => request.questions[0]?.prompt)).toEqual([
    "The site refused the last code. Enter the newest sign-in code example.test sent you.",
    "The site refused the last code. Enter the newest sign-in code example.test sent you.",
  ]);
  expect(codeRequests.current).toBe(2);
});

it("asks nothing once the sign-in's code re-asks are spent", async () => {
  const { autofill } = values();
  const result = await Effect.runPromise(
    autofill.valuesFor(codeStep, {
      ...login({ username: "synthetic-user" }),
      codeAgain: "rejected",
      codeRequests: { current: 2 },
    }),
  );
  expect(result).toEqual(new Unanswered("code_corrections_exhausted"));
});

it("asks once for a screen of code boxes, again for a code that does not fit them, and types it one character each", async () => {
  const { autofill } = values();
  const owner = scripted(["12345", "123-456"]);
  const filled = await Effect.runPromise(
    autofill.valuesFor(boxesStep, login({ username: "synthetic-user" }, owner.ask)),
  );
  expect(owner.requests).toHaveLength(2);
  expect(filled).toMatchObject({ values: Array.from({ length: 6 }, () => "123456") });
  if (filled instanceof Unanswered) throw new Error("Expected the boxes' code");
  expect(typedValues(filled.step, filled.values)).toEqual(["1", "2", "3", "4", "5", "6"]);
});

it("ends a screen of code boxes unanswered after three codes that do not fit them", async () => {
  const { autofill, registered } = values();
  const owner = scripted(["12345", "1234567", "12"]);
  const result = await Effect.runPromise(
    autofill.valuesFor(boxesStep, login({ username: "synthetic-user" }, owner.ask)),
  );
  expect(result).toEqual(new Unanswered(codeDoesNotFit));
  expect(owner.requests).toHaveLength(3);
  expect(registered).toEqual([]);
});

it("types a code one character per box only when the screen has as many code fields as it has characters", () => {
  const user = { selector: "#user", slot: "username" as const };
  const box = (index: number) => ({ selector: `#digit-${index}`, slot: "code" as const });
  expect(
    typedValues({ fields: [user, box(0), box(1), box(2)] }, ["synthetic-user", "123", "123", "123"]),
  ).toEqual(["synthetic-user", "1", "2", "3"]);
  // A code of another length, and a screen of one code field, take their values as they are.
  expect(typedValues({ fields: [box(0), box(1), box(2)] }, ["1234", "1234", "1234"])).toEqual([
    "1234",
    "1234",
    "1234",
  ]);
  expect(typedValues({ fields: [user, box(0)] }, ["synthetic-user", "123456"])).toEqual([
    "synthetic-user",
    "123456",
  ]);
});
