// Failure modes covered: a later step reuses an answer to a question that matches by id alone or
// has another id, to one whose follow-up changed, to a code, secret, login or payment card
// question, no longer valid for the question as asked, or after the owner answered its prompt
// anew; the same question asked again, or long after the owner answered, asks the owner again; a
// reuse changes the answer's shape; a host reading kept answers back decodes one it cannot read,
// or refuses one an earlier release kept with more fields.
import { Effect, Either, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  forgetScriptAnswers,
  KeptScriptAnswer,
  keptScriptAnswers,
  reusedScriptAnswers,
  scriptQuestionKeys,
  validateKeptAnswers,
} from "../../src/mint/script-answer-reuse.js";
import type { InputRequest, ValidAnswers } from "../../src/runtime/input-request.js";

const request = (questions: InputRequest["questions"]): InputRequest => ({
  id: "request",
  source: "script",
  questions,
});
const choice = {
  id: "plan",
  type: "choice" as const,
  prompt: "Which plan do you have?",
  options: [
    { id: "gold", label: "Gold" },
    { id: "silver", label: "Silver" },
  ],
};
const plan = request([choice]);
const gold: ValidAnswers = { plan: { type: "choice", value: "gold" } };
const keys = (asked: InputRequest) =>
  Effect.runSync(scriptQuestionKeys(asked, (text) => Effect.succeed(text)));
const kept = (asked: InputRequest, answers: ValidAnswers) =>
  keptScriptAnswers([], keys(asked), answers);
const reuse = (asked: InputRequest, entries: readonly KeptScriptAnswer[]) =>
  reusedScriptAnswers(asked, keys(asked), entries);

describe("a later step's script question", () => {
  it("reuses the owner's answer in a fresh answer's shape, a refusal as a refusal", () => {
    expect(reuse(plan, kept(plan, gold))).toEqual(gold);
    const approve = request([{ id: "approve", type: "confirm", prompt: "Approve the terms?" }]);
    const declined: ValidAnswers = { approve: { type: "confirm", value: { confirmed: false } } };
    expect(reuse(approve, kept(approve, declined))).toEqual(declined);
  });

  it("reuses an answer as often as the question comes back, and keeps it until replaced", () => {
    const entries = kept(plan, gold);
    // Reusing leaves the kept answer in place, so every later ask of the same question reuses it.
    for (let ask = 0; ask < 3; ask++) expect(reuse(plan, entries)).toEqual(gold);
    // A kept answer carries no time and no step, so neither age nor the asking step ends it.
    expect(entries).toEqual([{ question: keys(plan)[0], answer: gold["plan"] }]);
    // Only a newer answer to the same prompt replaces it; another prompt's answer keeps it.
    expect(keptScriptAnswers(entries, keys(request([])), {})).toEqual(entries);
  });

  it("never keeps or reuses an answer to a code, a secret or a login", () => {
    const secrets = request([
      { id: "code", type: "secret", secretKind: "one_time_code", prompt: "Which code?" },
      { id: "pin", type: "secret", secretKind: "private_text", prompt: "What is your PIN?" },
      {
        id: "login",
        type: "credential",
        prompt: "Sign in to the site",
        fields: "username_password",
        reason: "missing_credentials",
        allowSave: false,
        siteOrigin: "https://example.com",
      },
    ]);
    const answers: ValidAnswers = {
      code: { type: "secret", value: "246810" },
      pin: { type: "secret", value: "1357" },
      login: { type: "credential", value: { username: "a", password: "b", saveLogin: false } },
    };
    expect(keys(secrets)).toEqual([undefined, undefined, undefined]);
    expect(kept(secrets, answers)).toEqual([]);
    expect(reuse(secrets, kept(secrets, answers))).toBeUndefined();
    // One protected question in a request asks the whole request again.
    const mixed = request([choice, ...secrets.questions.slice(0, 1)]);
    expect(reuse(mixed, kept(mixed, { ...gold, code: answers["code"]! }))).toBeUndefined();
  });

  it("never keeps or reuses a part of a payment card, which is asked again every time", () => {
    const card = request([
      { id: "number", type: "secret", secretKind: "card_number", prompt: "Card number?" },
      { id: "expiry", type: "secret", secretKind: "card_expiry", prompt: "Expiry?" },
      { id: "cvc", type: "secret", secretKind: "card_cvc", prompt: "Security code?" },
      { id: "zip", type: "secret", secretKind: "billing_postal_code", prompt: "Billing ZIP?" },
    ]);
    const answers: ValidAnswers = {
      number: { type: "secret", value: "4242424242424242" },
      expiry: { type: "secret", value: "12/34" },
      cvc: { type: "secret", value: "123" },
      zip: { type: "secret", value: "94110" },
    };
    expect(keys(card)).toEqual([undefined, undefined, undefined, undefined]);
    expect(kept(card, answers)).toEqual([]);
    expect(reuse(card, kept(card, answers))).toBeUndefined();
  });

  it("matches the id, type, prompt, options and a confirm's follow-up", () => {
    const entries = kept(plan, gold);
    for (const changed of [
      { ...choice, id: "tier" },
      { ...choice, type: "multi_choice" as const, minSelections: 1, maxSelections: 1 },
      { ...choice, prompt: "Which plan should the booking use?" },
      { ...choice, options: [...choice.options, { id: "bronze", label: "Bronze" }] },
      {
        ...choice,
        options: [
          { id: "gold", label: "Gold plan" },
          { id: "silver", label: "Silver" },
        ],
      },
    ])
      expect(reuse(request([changed]), entries)).toBeUndefined();
    const confirm = { id: "approve", type: "confirm" as const, prompt: "Approve the terms?" };
    const withNote = { ...confirm, followUp: { prompt: "Anything to add?" } };
    const yes: ValidAnswers = { approve: { type: "confirm", value: { confirmed: true } } };
    expect(reuse(request([withNote]), kept(request([confirm]), yes))).toBeUndefined();
    expect(reuse(request([withNote]), kept(request([withNote]), yes))).toEqual(yes);
  });

  it("asks again when the kept answer is not valid for the question as asked now", () => {
    const extras = {
      id: "extras",
      type: "multi_choice" as const,
      prompt: "Which extras?",
      options: [
        { id: "bag", label: "Bag" },
        { id: "seat", label: "Seat" },
      ],
      minSelections: 0,
      maxSelections: 2,
    };
    const both: ValidAnswers = { extras: { type: "multi_choice", value: ["bag", "seat"] } };
    const entries = kept(request([extras]), both);
    expect(reuse(request([extras]), entries)).toEqual(both);
    expect(reuse(request([{ ...extras, maxSelections: 1 }]), entries)).toBeUndefined();
  });

  it("keeps only the owner's latest answer to a prompt", () => {
    const entries = kept(plan, gold);
    expect(reuse(plan, forgetScriptAnswers(entries, [choice.prompt]))).toBeUndefined();
    expect(reuse(plan, forgetScriptAnswers(entries, ["Which seat?"]))).toEqual(gold);
    const wider = request([
      { ...choice, options: [...choice.options, { id: "bronze", label: "Bronze" }] },
    ]);
    const bronze: ValidAnswers = { plan: { type: "choice", value: "bronze" } };
    const newer = keptScriptAnswers(entries, keys(wider), bronze);
    expect(reuse(plan, newer)).toBeUndefined();
    expect(reuse(wider, newer)).toEqual(bronze);
  });

  it("checks kept answers by the rules of a fresh answer, for a host that keeps them itself", () => {
    expect(validateKeptAnswers(plan, gold)).toEqual(Either.right(gold));
    expect(validateKeptAnswers(plan, { plan: { type: "choice", value: "bronze" } })).toMatchObject({
      _tag: "Left",
    });
    expect(validateKeptAnswers(plan, { plan: "gold" })).toMatchObject({
      _tag: "Left",
      left: { reason: "malformed" },
    });
  });

  it("decodes only the kept answers this release reads, when a host reads them back", () => {
    const [entry] = kept(plan, gold);
    // An earlier release also kept when and in which run the owner answered; neither matters now.
    const earlier = { ...entry, executionId: "first", answeredAtMs: 0 };
    expect(
      [entry, earlier, { question: { id: "plan" } }].flatMap((candidate) =>
        Option.toArray(Schema.decodeUnknownOption(KeptScriptAnswer)(candidate)),
      ),
    ).toEqual([entry, entry]);
  });
});
