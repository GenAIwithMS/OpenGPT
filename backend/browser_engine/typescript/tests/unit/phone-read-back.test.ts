import { runInThisContext } from "node:vm";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import type { AutofillInspection, AutofillStep } from "../../src/destinations/autofill-step.js";
import {
  type CredentialKeyboard,
  makeCredentialKeyboard,
  phoneDigitsCode,
} from "../../src/destinations/credential-keyboard.js";
import { settleAutofillValues } from "../../src/mint/autofill-rejected.js";
import {
  callingCode,
  changedField,
  changedPhoneNotice,
} from "../../src/mint/autofill-results.js";

// A phone field may keep other digits than the host typed, as when the site's country picker is
// set to another country and its mask shifts and cuts the number. The host reads a phone field
// back on its private socket before it clicks the submit, and stops when the digits changed.

/** The page code's answer for a field that holds `shown` once the host typed `typed`. */
const readBack = (typed: string, field: object) => {
  const code: unknown = runInThisContext(`(${phoneDigitsCode})`);
  if (typeof code !== "function") throw new Error("Read-back code unavailable");
  return Reflect.apply(code, field, [typed]) as unknown;
};
const holding = (value: unknown) => ({ isConnected: true, value });

it.each([
  ["the number as typed", "+7 912 345-67-89", "+7 912 345-67-89"],
  ["the number without its calling code", "+7 912 345-67-89", "(912) 345-6789"],
  ["a national number with its trunk prefix", "+44 7911 123456", "07911 123456"],
  ["the number after the picker's own calling code", "912 345 6789", "+7 912 345 67 89"],
  ["a number without its trunk prefix", "8 912 345-67-89", "912 345 67 89"],
  ["a number dialed with 00, without its calling code", "0044 7911 123456", "7911 123456"],
  ["a number dialed with 00, as a national number", "0044 7911 123456", "07911 123456"],
  ["a number dialed with 00 and a three-digit calling code", "00353 87 123 4567", "87 123 4567"],
  ["a number dialed with 011, without its calling code", "011 44 7911 123456", "7911 123456"],
])("keeps %s", (_name, typed, shown) => {
  expect(readBack(typed, holding(shown))).toBe("kept");
});

it.each([
  ["shifted under another country and cut", "+7 912 345-67-89", "(791) 234-5678"],
  ["cut short", "+1 415 555 0134", "(415) 555-013"],
  ["dialed with 00, shifted under another country", "0044 7911 123456", "(004) 479-1112"],
  ["with a digit lost inside", "+1 415 555 0134", "(415) 555-034"],
])("reads a number %s as changed", (_name, typed, shown) => {
  expect(readBack(typed, holding(shown))).toBe("changed");
});

it.each([
  ["a field gone from its document", "+1 415 555 0134", { isConnected: false, value: "x" }],
  ["a field with no text value", "+1 415 555 0134", { isConnected: true }],
  ["a number with no digits", "call me", holding("call me")],
  ["a field the page emptied, which the next call finds empty", "+1 415 555 0134", holding("")],
])("can't tell for %s", (_name, typed, field) => {
  expect(readBack(typed, field)).toBe("unread");
});

/** A private socket whose insertion answers `inserted` and whose read-back answers `read`. */
const socket = (read: () => Promise<unknown>) => {
  const calls: { readonly declaration: string; readonly values: readonly unknown[] }[] = [];
  let bindingKey = "";
  const native = makeCredentialKeyboard({
    sessions: () => ["page"],
    send: (method, params) => {
      if (method === "DOM.getDocument")
        return Promise.resolve({
          root: { backendNodeId: 1, children: [{ backendNodeId: 2, attributes: [bindingKey, ""] }] },
        });
      if (method === "DOM.resolveNode") return Promise.resolve({ object: { objectId: "field" } });
      if (method !== "Runtime.callFunctionOn") return Promise.resolve({});
      const declaration = String(params["functionDeclaration"]);
      const args = params["arguments"];
      calls.push({
        declaration,
        values: Array.isArray(args) ? args.map((arg: { value: unknown }) => arg.value) : [],
      });
      return declaration === phoneDigitsCode ? read() : Promise.resolve({ result: { value: "inserted" } });
    },
  });
  const keyboard: CredentialKeyboard = {
    insertText: (target, text, options) =>
      Effect.suspend(() => {
        bindingKey = target.bindingKey;
        return native.insertText(target, text, options);
      }),
  };
  return { keyboard, calls };
};
const target = { bindingKey: "__binding", documentOrigin: "https://login.example.test" };

it("reads a phone back after typing it, on the same private socket, and answers what it found", async () => {
  const { keyboard, calls } = socket(() => Promise.resolve({ result: { value: "changed" } }));
  const answer = await Effect.runPromise(keyboard.insertText(target, "+7 912 345-67-89", { phone: true }));
  expect(answer).toBe("changed");
  expect(calls.map(({ declaration }) => declaration === phoneDigitsCode)).toEqual([false, true]);
  expect(calls[1]?.values).toEqual(["+7 912 345-67-89"]);
});

it.each([
  ["kept", () => Promise.resolve({ result: { value: "kept" } })],
  ["unread", () => Promise.resolve({ result: { value: "unread" } })],
  ["failed", () => Promise.reject(new Error("The browser refused the read"))],
])("answers inserted when the read back %s", async (_name, read) => {
  const { keyboard } = socket(read);
  expect(
    await Effect.runPromise(keyboard.insertText(target, "+1 415 555 0134", { phone: true })),
  ).toBe("inserted");
});

it("reads nothing back for any other field", async () => {
  const { keyboard, calls } = socket(() => Promise.resolve({ result: { value: "changed" } }));
  expect(await Effect.runPromise(keyboard.insertText(target, "synthetic-password"))).toBe("inserted");
  expect(calls).toHaveLength(1);
});

const site = "https://login.example.test";
const inspection: AutofillInspection = {
  page: `${site}/login`,
  targets: { fields: [], submit: null },
  siteOrigin: site,
  authenticationOrigins: [],
  screen: { origin: site, fields: [], submit: null, buttons: [] },
};
const step: AutofillStep = {
  fields: [
    { selector: "#phone", slot: "phone", accepts: ["phone"] },
    { selector: "#password", slot: "password" },
  ],
  submit: "#sign-in",
};

it("stops a fill at a phone the field changed: nothing more typed, no submit clicked", async () => {
  const typed: { readonly text: string; readonly phone: boolean }[] = [];
  const calls: string[] = [];
  const report = await Effect.runPromise(
    fillAutofillStep({
      step,
      values: ["+7 912 345-67-89", "synthetic-password"],
      inspection,
      page: {
        targetId: "primary",
        execute: (code) =>
          Effect.sync(() => {
            calls.push(code.includes("guardKey") ? "submit" : "focus");
            return { focused: true, url: inspection.page };
          }),
      },
      keyboard: {
        insertText: (_target, text, options) =>
          Effect.sync(() => {
            typed.push({ text, phone: options?.phone === true });
            return "changed" as const;
          }),
      },
    }),
  );
  expect(report).toEqual({
    outcome: "filled",
    fields: [
      { slot: "phone", status: "changed" },
      { slot: "password", status: "not_attempted" },
    ],
    submit: "not_attempted",
    url: inspection.page,
    typed: true,
  });
  expect(typed).toEqual([{ text: "+7 912 345-67-89", phone: true }]);
  expect(calls).toEqual(["focus"]);
  expect(changedField(report)).toBe(0);
  expect(JSON.stringify(report)).not.toContain("912");
});

it.each([
  ["+7 912 345-67-89", "7"],
  ["+1 (415) 555-0134", "1"],
  ["+44 7911 123456", "44"],
  ["0049 1512 3456789", "49"],
  ["+380 44 123 4567", "380"],
  ["+86 138 0013 8000", "86"],
  ["+213 555 12 34 56", "213"],
])("names the calling code of %s", (number, code) => {
  expect(callingCode(number)).toBe(code);
  expect(changedPhoneNotice(number)).toContain(`The number's country calling code is +${code}.`);
});

it.each(["912 345 6789", "8 912 345-67-89", "+0 123 4567", "+12"])(
  "names no calling code for %s, which does not say it",
  (number) => {
    expect(callingCode(number)).toBeUndefined();
    expect(changedPhoneNotice(number)).toBe(
      "The phone field kept different digits than the number the host typed, as when the site's country picker is set to another country. Nothing was submitted and nobody was asked. If the screen has a country picker, prefer setting it to the site's own country with an explore step, then send this signInStep again.",
    );
  },
);

it("tells the minter what to do about a changed phone, naming only its calling code", () => {
  expect(changedPhoneNotice("+7 912 345-67-89")).toBe(
    "The phone field kept different digits than the number the host typed, as when the site's country picker is set to another country. Nothing was submitted and nobody was asked. The number's country calling code is +7. If the screen has a country picker, prefer setting it to that country with an explore step, then send this signInStep again.",
  );
});

it("counts a phone the field changed as never sent", () => {
  // An email signs in, and the phone is a second identifier the site checks.
  const h = {
    autofillSentValues: { current: { phone: "+7 912 345-67-89" } },
    autofillPrimaryIdentifierKind: { current: "email" as const },
  };
  settleAutofillValues(h, { fields: [step.fields[0]!] }, {}, {
    outcome: "filled",
    fields: [{ slot: "phone", status: "changed" }],
    submit: "not_attempted",
    url: inspection.page,
  });
  expect(h.autofillSentValues.current).toEqual({});
});
