import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import type { AutofillStep, AutofillStepReport } from "../../src/destinations/autofill-step.js";
import {
  codeAskedAgain,
  recordAutofillValues,
  reserveCorrection,
  settleAutofillValues,
  wasSent,
} from "../../src/mint/autofill-rejected.js";
import type { AutofillHost } from "../../src/mint/autofill-results.js";
import { MintFailure } from "../../src/mint/contracts.js";
import { heldPasswordRejected, passwordDigest } from "../../src/mint/held-rejections.js";
import type {
  CredentialRejectedField,
  WebsiteCredentials,
} from "../../src/runtime/authentication.js";
import type { AnsweredLoginFields } from "../../src/runtime/autofill-values.js";
import {
  type AutofillSignInState,
  exhaustedSecret,
} from "../../src/runtime/autofill-state.js";

// The sign-in rules every host's build shares: how often a secret is filled, which rejected values
// go out again, how many corrections each field gets, and when a code is asked for again.

/** A build's sign-in state, as a host keeps it, holding `credentials`. */
const host = (credentials?: WebsiteCredentials) =>
  ({
    reportCorrelation: undefined,
    heldLogin: { current: credentials === undefined ? undefined : { credentials } },
    answeredLoginFields: { current: {} as AnsweredLoginFields },
    autofillPrimaryIdentifierKind: { current: undefined },
    autofillSignIn: { current: undefined },
    managedAuthenticationComplete: { current: false },
    autofillSentValues: { current: {} as Partial<Record<CredentialRejectedField, string>> },
    autofillSecretsFilled: { current: [] },
    autofillSecretsRefilled: { current: [] },
    autofillRejectedValues: { current: {} },
    autofillRejectedPassword: { current: undefined },
    autofillCodeRejected: { current: false },
    autofillCodeAgain: { current: undefined },
    autofillCorrectionRequests: { current: {} },
    autofillPendingRejectedFields: { current: [] },
  }) satisfies AutofillHost as AutofillHost & {
    readonly answeredLoginFields: { current: AnsweredLoginFields };
    readonly autofillSentValues: { current: Partial<Record<CredentialRejectedField, string>> };
  };

const screen = (...slots: AutofillStep["fields"][number]["slot"][]): AutofillStep => ({
  fields: slots.map((slot) => ({ selector: `#${slot}`, slot })),
  submit: "#go",
});

/** What named a control when the host inspected it. */
const named = (id: string) => ({
  label: "Code",
  ariaLabel: null,
  placeholder: null,
  type: "text",
  autocomplete: "one-time-code",
  name: "code",
  id,
});

describe("the secrets a sign-in fills", () => {
  it("fills a password or code twice at most, and any other secret once", () => {
    const h = host();
    h.autofillSecretsFilled.current = ["password", "zip"];
    expect(exhaustedSecret(h, true, screen("password"))).toBe(-1);
    h.autofillSecretsRefilled.current = ["password"];
    expect(exhaustedSecret(h, true, screen("username", "password"))).toBe(1);
    expect(exhaustedSecret(h, true, screen("zip"))).toBe(0);
    // A security answer is read or asked for each screen, never held as filled.
    expect(exhaustedSecret(h, true, screen("private_answer"))).toBe(-1);
  });

  it("starts a sign-in after a verified one with nothing filled", () => {
    const h = host();
    h.autofillSecretsFilled.current = ["zip"];
    h.managedAuthenticationComplete.current = true;
    expect(exhaustedSecret(h, false, screen("zip"))).toBe(-1);
    expect(exhaustedSecret(h, true, screen("zip"))).toBe(0);
  });
});

describe("the values the site rejected", () => {
  it("knows a held password the site rejected by its digest alone", () => {
    const h = host({ username: "owner", password: "synthetic-password" });
    expect(heldPasswordRejected(h)).toBe(false);
    h.autofillRejectedValues.current.password = [passwordDigest("synthetic-password")];
    expect(heldPasswordRejected(h)).toBe(true);
    const latest = host({ username: "owner", password: "other-password" });
    latest.autofillRejectedPassword.current = passwordDigest("other-password");
    expect(heldPasswordRejected(latest)).toBe(true);
    expect(JSON.stringify(h.autofillRejectedValues.current)).not.toContain("synthetic-password");
  });

  it("counts a value as sent once recorded, a password by its digest, and refuses one rejected before", async () => {
    const h = host();
    const step = screen("username", "password");
    expect(wasSent(h, "password")).toBe(false);
    await Effect.runPromise(recordAutofillValues(h, step, ["owner", "synthetic-password"], {}));
    expect(wasSent(h, "password")).toBe(true);
    expect(h.autofillSentValues.current).toEqual({
      username: "owner",
      password: passwordDigest("synthetic-password"),
    });
    h.autofillRejectedValues.current.username = ["owner"];
    const again = await Effect.runPromiseExit(
      recordAutofillValues(h, step, ["owner", "new-password"], {}),
    );
    expect(again).toEqual(
      Exit.fail(
        expect.objectContaining({ code: "CredentialsRejected", rejectedCredential: "username" }),
      ),
    );
  });

  it("records a date of birth as the owner's whole answer, not the part a control typed", async () => {
    const h = host();
    h.answeredLoginFields.current = { date_of_birth: "1990-04-02" };
    await Effect.runPromise(recordAutofillValues(h, screen("date_of_birth"), ["1990"], {}));
    expect(h.autofillSentValues.current.date_of_birth).toBe("1990-04-02");
  });

  it("puts back what a refused fill held, so it is no rejection evidence", () => {
    const h = host();
    h.autofillSentValues.current = { username: "new-owner" };
    const refused: AutofillStepReport = { outcome: "refused", reason: "credential_target_refused" };
    settleAutofillValues(h, screen("username"), { username: "owner" }, refused);
    expect(h.autofillSentValues.current).toEqual({ username: "owner" });
    settleAutofillValues(h, screen("username"), {}, refused);
    expect(h.autofillSentValues.current).toEqual({});
  });
});

describe("the corrections a rejection gets", () => {
  it("asks each logical login field twice at most, saying the tries left", () => {
    const h = host();
    const rejected = new MintFailure({ code: "CredentialsRejected", rejectedCredential: "password" });
    expect(reserveCorrection(h, rejected)).toBe(2);
    expect(reserveCorrection(h, rejected)).toBe(1);
    expect(reserveCorrection(h, rejected)).toBeUndefined();
    // The identifier the username went into counts as the username.
    const email = host();
    email.autofillPrimaryIdentifierKind.current = "email";
    email.autofillPendingRejectedFields.current = ["email", "password"];
    expect(reserveCorrection(email, rejected)).toBe(2);
    expect(email.autofillCorrectionRequests.current).toEqual({ username: 1, password: 1 });
  });
});

describe("a code asked for again", () => {
  const codeScreen = screen("code");

  it("says why: the host's own reason, else the same code field coming back after a code went out", () => {
    const h = host();
    h.autofillCodeAgain.current = "rejected";
    expect(codeAskedAgain(h, codeScreen, false, [named("otp")])).toBe("rejected");
    const returned = host();
    returned.autofillSecretsFilled.current = ["code"];
    returned.autofillSignIn.current = {
      steps: [{ page: "https://shop.example/verify", fields: [{ ...codeScreen.fields[0]!, identity: named("otp") }] }],
    } as unknown as AutofillSignInState;
    expect(codeAskedAgain(returned, codeScreen, false, [named("otp")])).toBe("returned");
    // Another code field, such as an emailed code's after a texted one's, is a first question.
    expect(codeAskedAgain(returned, codeScreen, false, [named("email-otp")])).toBeUndefined();
    // A screen that opens a sign-in asks for its first code.
    expect(codeAskedAgain(returned, codeScreen, true, [named("otp")])).toBeUndefined();
  });
});
