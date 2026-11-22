import { Data, Effect } from "effect";
import { expect, it } from "vitest";
import {
  InputRequestFailure,
  type InputAsker,
  type InputRequest,
} from "../../src/runtime/input-request.js";
import type { AnsweredLoginFields } from "../../src/runtime/login-values.js";
import { makeLoginFieldAsk, Unanswered } from "../../src/runtime/login-field-asks.js";

class UnavailableField extends Data.TaggedError("UnavailableField")<{
  readonly operation: string;
}> {}

/** The ask with no save offer, recording what it registers with the broker. */
const field = () => {
  const registered: { readonly entity: string; readonly value: string }[] = [];
  const given: { current: AnsweredLoginFields } = { current: {} };
  const ask = makeLoginFieldAsk({
    broker: {
      register: ({ entity, value }) =>
        Effect.sync(() => {
          registered.push({ entity, value });
        }),
    },
    unavailable: (operation) => new UnavailableField({ operation }),
    site: "example.com",
    given,
  });
  return { ...ask, registered, given };
};

/** An owner who answers each request's questions with the next of `answers`, in order. */
const owner = (answers: readonly string[], type: "text" | "secret" = "secret") => {
  const requests: InputRequest[] = [];
  const queue = [...answers];
  const asker: InputAsker = (request) =>
    Effect.sync(() => {
      requests.push(request);
      const value = queue.shift() ?? "";
      return Object.fromEntries(request.questions.map((question) => [question.id, { type, value }]));
    });
  return { asker, requests };
};

/** An owner who never answers, recording each request. */
const silentOwner = () => {
  const requests: InputRequest[] = [];
  const asker: InputAsker = (request) =>
    Effect.suspend(() => {
      requests.push(request);
      return Effect.fail(new InputRequestFailure({ code: "NoResponse" }));
    });
  return { asker, requests };
};

it("asks the owner for a recovery code as private text, never as a one-time code, and keeps none", async () => {
  const ask = field();
  const answering = owner(["backup-1234"]);
  const result = await Effect.runPromise(ask.ask(answering.asker, "recovery_code"));
  expect(result).toEqual({ slot: "recovery_code", value: "backup-1234" });
  expect(answering.requests).toHaveLength(1);
  expect(answering.requests[0]).toMatchObject({
    source: "system",
    questions: [
      {
        id: "recovery_code",
        type: "secret",
        secretKind: "private_text",
        prompt: "Enter one of your example.com recovery codes.",
      },
    ],
  });
  expect(answering.requests[0]).not.toHaveProperty("savedLoginFieldSave");
  expect(ask.registered).toEqual([{ entity: "RECOVERY_CODE", value: "backup-1234" }]);
  expect(ask.given.current).toEqual({});
});

it("returns the owner's silence as unanswered, registering nothing", async () => {
  const ask = field();
  const silent = silentOwner();
  const result = await Effect.runPromise(ask.ask(silent.asker, "recovery_code"));
  expect(result).toBeInstanceOf(Unanswered);
  expect(result).toMatchObject({ cause: { code: "NoResponse" } });
  expect(silent.requests).toHaveLength(1);
  expect(ask.registered).toEqual([]);
});

it("asks again for the newest code with the host's notice, masking it with and without separators", async () => {
  const ask = field();
  const answering = owner(["482-913"]);
  const result = await Effect.runPromise(
    ask.ask(answering.asker, "code", "The site refused the last code."),
  );
  expect(result).toEqual({ slot: "code", value: "482-913" });
  expect(answering.requests[0]?.questions).toEqual([
    {
      id: "code",
      type: "secret",
      secretKind: "one_time_code",
      prompt: "The site refused the last code. Enter the newest sign-in code example.com sent you.",
    },
  ]);
  expect(ask.registered).toEqual([
    { entity: "ONE_TIME_CODE", value: "482-913" },
    { entity: "ONE_TIME_CODE", value: "482913" },
  ]);
  expect(ask.given.current).toEqual({});
});

it("keeps an answered identifier for the attempt, asking no save question without a save offer", async () => {
  const ask = field();
  const answering = owner(["+1 415 555 0142"], "text");
  const result = await Effect.runPromise(
    ask.ask(answering.asker, ["email", "phone"], undefined, true),
  );
  expect(result).toEqual({ slot: "phone", value: "+1 415 555 0142" });
  expect(answering.requests[0]?.questions).toEqual([
    {
      id: "email_or_phone",
      type: "text",
      maxLength: 320,
      prompt: "What's the email address or phone number for your example.com account?",
    },
  ]);
  expect(answering.requests[0]).not.toHaveProperty("savedLoginFieldSave");
  expect(ask.registered).toEqual([{ entity: "PHONE", value: "+1 415 555 0142" }]);
  expect(ask.given.current).toEqual({ phone: "+1 415 555 0142" });
});

it("asks a security answer with the page's own question, again after a blank answer, and never keeps it", async () => {
  const ask = field();
  const answering = owner(["   ", "synthetic-answer"]);
  const result = await Effect.runPromise(
    ask.askAnswer(
      answering.asker,
      {
        questionText: "What was the name of your first pet?",
        label: "Answer",
        ariaLabel: null,
        placeholder: null,
      },
      false,
    ),
  );
  expect(result).toEqual({ value: "synthetic-answer", consented: false });
  expect(answering.requests.map((request) => request.questions)).toEqual([
    [
      {
        id: "private_answer",
        type: "secret",
        secretKind: "private_text",
        prompt: "example.com asks this security question: What was the name of your first pet?",
      },
    ],
    [
      {
        id: "private_answer",
        type: "secret",
        secretKind: "private_text",
        prompt: "example.com asks this security question: What was the name of your first pet?",
      },
    ],
  ]);
  expect(ask.registered).toEqual([{ entity: "SECURITY_ANSWER", value: "synthetic-answer" }]);
  expect(ask.given.current).toEqual({});
});

it("names the security answer the owner left unanswered", async () => {
  const ask = field();
  const result = await Effect.runPromise(ask.askAnswer(silentOwner().asker, undefined, false));
  expect(result).toBeInstanceOf(Unanswered);
  expect(result).toMatchObject({ field: "private_answer" });
  expect(ask.registered).toEqual([]);
});

it("fails the ask after three answers the field cannot take", async () => {
  const ask = field();
  const answering = owner(["not a date", "1990-13-01", "April 7"]);
  const result = await Effect.runPromise(
    Effect.either(ask.ask(answering.asker, "date_of_birth")),
  );
  expect(result).toMatchObject({ _tag: "Left", left: { operation: "autofill.ask" } });
  expect(answering.requests).toHaveLength(3);
  expect(ask.registered).toEqual([]);
  expect(ask.given.current).toEqual({});
});
