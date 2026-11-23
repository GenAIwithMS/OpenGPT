import { selectAll } from "css-select";
import type { AnyNode, Element } from "domhandler";
import { parseDocument } from "htmlparser2";
import { expect, it } from "vitest";
import {
  namesWholeOtherWord,
  unrecordedCodeStep,
} from "../../src/runtime/autofill-unrecorded-code.js";

// The box a run's replay takes for a code screen its recipe never recorded, as its selector
// matches on a parsed page (css-select, no browser). A false match types a code into that box and
// clicks its form's submit, so a checkout's card security code, a PIN, a redeem or area code and
// a year are never one. A box the selector matched whose name, id or autocomplete holds `pin` as
// a word of its own is not one either (`findCodeField`).
const field = unrecordedCodeStep.fields[0]?.selector ?? "";

/** The boxes the selector matches on a page whose body is `body`. */
const matched = (body: string) =>
  selectAll<AnyNode, Element>(field, parseDocument(`<html><body>${body}</body></html>`));

/** How many boxes the replay takes: the selector's one match, unless it names a PIN. */
const taken = (body: string) => {
  const found = matched(body);
  const [box] = found;
  if (found.length !== 1 || box === undefined) return 0;
  const named = {
    name: box.attribs["name"] ?? null,
    id: box.attribs["id"] ?? null,
    autocomplete: box.attribs["autocomplete"] ?? null,
  };
  return namesWholeOtherWord(named) ? 0 : 1;
};

for (const { label, input, matches } of [
  { label: "an id that names a one-time code", input: '<input id="otp" name="code">', matches: 1 },
  {
    label: "a code name on a six-digit numeric box",
    input: '<input name="code" inputmode="numeric" maxlength="6">',
    matches: 1,
  },
  {
    label: "a card code's four-digit box",
    input: '<input name="cardCode" inputmode="numeric" maxlength="4">',
    matches: 0,
  },
  {
    label: "a CVV named for a verification code",
    input: '<input id="cvv" name="verificationCode" inputmode="numeric" maxlength="4">',
    matches: 0,
  },
  {
    label: "a CVC code's phone-digits box",
    input: '<input name="cvcCode" type="tel" maxlength="4">',
    matches: 0,
  },
  {
    label: "a card security code named securityCode",
    input: '<input name="securityCode" inputmode="numeric" maxlength="4">',
    matches: 0,
  },
  {
    label: "a box marked as a card's security code",
    input: '<input name="verification" inputmode="numeric" maxlength="4" autocomplete="cc-csc">',
    matches: 0,
  },
  {
    label: "a box marked as a card's expiry",
    input: '<input name="exp_code" inputmode="numeric" maxlength="4" autocomplete="cc-exp">',
    matches: 0,
  },
  {
    label: "an otpInput box, whose pin is no word of its own",
    input: '<input name="otpInput" inputmode="numeric" maxlength="6">',
    matches: 1,
  },
  {
    label: "a code box with a spinner's id",
    input: '<input id="spinner" name="code" inputmode="numeric" maxlength="6">',
    matches: 1,
  },
  {
    label: "a box marked as a one-time code and named pin",
    input: '<input name="pin" autocomplete="one-time-code">',
    matches: 1,
  },
  {
    label: "a pinCode box",
    input: '<input name="pinCode" inputmode="numeric" maxlength="6">',
    matches: 0,
  },
  ...["pin", "PIN", "user_pin", "userPin"].map((name) => ({
    label: `a code box named ${name}`,
    input: `<input id="code" name="${name}" inputmode="numeric" maxlength="6">`,
    matches: 0,
  })),
  {
    label: "a PIN code's phone-digits box",
    input: '<input name="pincode" type="tel" maxlength="6">',
    matches: 0,
  },
  {
    label: "a shop's six-digit pincode box",
    input: '<input name="pincode" inputmode="numeric" maxlength="6">',
    matches: 0,
  },
  {
    label: "a PINCode box",
    input: '<input name="PINCode" inputmode="numeric" maxlength="6">',
    matches: 0,
  },
  {
    label: "a plain text box named code",
    input: '<input name="code" type="text">',
    matches: 0,
  },
  {
    label: "a code box whose autocomplete is a phone number's",
    input: '<input name="code" inputmode="numeric" maxlength="6" autocomplete="tel-national">',
    matches: 0,
  },
  {
    label: "a nine-digit code box",
    input: '<input name="code" inputmode="numeric" maxlength="9">',
    matches: 0,
  },
  {
    label: "a code box whose autocomplete is a postal code's",
    input: '<input name="code" inputmode="numeric" maxlength="6" autocomplete="postal-code">',
    matches: 0,
  },
  {
    label: "a password box named otp",
    input: '<input type="password" name="otp">',
    matches: 0,
  },
  {
    label: "an image check's code box",
    input: '<input name="captchaCode" inputmode="numeric" maxlength="5">',
    matches: 0,
  },
  {
    label: "a redeem code's numeric box",
    input: '<input name="redeemCode" inputmode="numeric" maxlength="6">',
    matches: 0,
  },
  {
    label: "an area code's phone-digits box",
    input: '<input name="area_code" type="tel" maxlength="5">',
    matches: 0,
  },
  {
    label: "an age check's year box",
    input: '<input name="age_verification_year" type="number" maxlength="4">',
    matches: 0,
  },
])
  it(`${matches === 1 ? "takes" : "never takes"} ${label} for an unrecorded code screen's box`, () => {
    expect(taken(`<form>${input}<button>Continue</button></form>`)).toBe(matches);
  });

// A page with a field marked as a one-time code counts only that field, so a box beside it whose
// name says code is not a second match.
it("takes only the marked box on a page with one marked as a one-time code", () => {
  const found = matched(
    '<form><input id="code-1" autocomplete="one-time-code">' +
      '<input id="code-2" name="code" inputmode="numeric" maxlength="6">' +
      "<button>Continue</button></form>",
  );
  expect(found).toHaveLength(1);
  expect(found[0]?.attribs["id"]).toBe("code-1");
});
