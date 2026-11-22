import { Either, Schema } from "effect";
import { expect, it } from "vitest";
import { RejectedMarker, SecretSlots } from "../../src/destinations/autofill-contracts.js";
import { autofillSignedInCode } from "../../src/destinations/autofill-page-code.js";
import { SignInStep } from "../../src/mint/contracts.js";

it("accepts a one-use private answer as a field but never as a recorded rejection", () => {
  expect(Either.isRight(Schema.decodeUnknownEither(SecretSlots)("private_answer"))).toBe(true);
  expect(
    Either.isLeft(
      Schema.decodeUnknownEither(RejectedMarker)({
        slot: "private_answer",
        selector: "#security-error",
      }),
    ),
  ).toBe(true);
});

it("retains a private answer's question selector and rejects it on another secret slot", () => {
  const field = { selector: "#answer", slot: "private_answer", questionSelector: "#question" };
  expect(Schema.decodeUnknownSync(SignInStep)({ fields: [field] })).toEqual({ fields: [field] });
  expect(Either.isLeft(Schema.decodeUnknownEither(SignInStep)({
    fields: [{ ...field, slot: "password" }],
  }))).toBe(true);
});

// A code split across one-character boxes is one code field per box, and some codes are longer
// than the six fields a screen may otherwise hold: the boxes have their own bound.
it.each([7, 8, 12])("accepts a code step of %i one-character boxes beside other fields", (count) => {
  const others = [
    { selector: "#user", accepts: ["username", "email"] },
    { selector: "#password", slot: "password" },
    ...["MM", "DD", "YYYY"].map((format) => ({ selector: `#dob-${format}`, slot: "date_of_birth", format })),
    { selector: "#zip", slot: "zip" },
  ];
  const boxes = Array.from({ length: count }, (_, at) => ({ selector: `#code-${at + 1}`, slot: "code" }));
  for (const fields of [boxes, [...others, ...boxes]])
    expect(Schema.decodeUnknownSync(SignInStep)({ fields, submit: "#verify" })).toEqual({
      fields,
      submit: "#verify",
    });
});

it("refuses more code boxes than the longest code, and more other fields than a screen holds", () => {
  const boxes = (count: number) =>
    Array.from({ length: count }, (_, at) => ({ selector: `#code-${at + 1}`, slot: "code" }));
  const others = (count: number) =>
    Array.from({ length: count }, (_, at) => ({ selector: `#answer-${at + 1}`, slot: "private_answer" }));
  for (const fields of [boxes(13), others(7), [...others(7), ...boxes(6)]])
    expect(Either.isLeft(Schema.decodeUnknownEither(SignInStep)({ fields, submit: "#go" }))).toBe(true);
  expect(Either.isRight(Schema.decodeUnknownEither(SignInStep)({
    fields: [...others(6), ...boxes(12)],
    submit: "#go",
  }))).toBe(true);
});

// A caller written for the signed-in page code before challenge fields keeps its arguments:
// `popups` stays fifth, and with no challenge fields given the code checks no challenge.
it("keeps the signed-in page code's popups fifth, with no challenge check by default", () => {
  const code = autofillSignedInCode("target", "#identity", "bank.example.test", ["#password"], [
    { opener: "primary", origin: "https://login.example.test" },
  ]);
  expect(code).toContain('const popupOrigins = ["https://login.example.test"];');
  expect(code).toContain("const challengeFields = [];");
  expect(code).toContain("const authenticationOrigins = [];");
});
