import { Effect } from "effect";
import { expect, it } from "vitest";
import { checkAutofillSignedIn } from "../../src/destinations/autofill-step.js";
import type { AutofillSignInState } from "../../src/runtime/autofill-state.js";
import {
  armStep,
  reasksPassword,
  recordStep,
  settleMinterSubmit,
  submitFilled,
  submittedLoginProof,
} from "../../src/runtime/autofill-state.js";

const state = (): AutofillSignInState => ({
  // The bookkeeping under test never calls the browser.
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
});
const target = {
  ownerUrl: "https://example.test/login",
  documentOrigin: "https://example.test",
  actions: ["https://example.test/session"],
  methods: ["post"],
  editable: true,
  control: "text" as const,
};
const screen = {
  page: "https://example.test/login",
  targets: { fields: [target], submit: target },
};
/** A broker that holds no secret any control's naming carries. */
const noSecret = () => Effect.succeed(false);

// A value counts as submitted once a submit was clicked after it was filled, however the page then
// sends it; a screen with no submit of its own keeps its values for the next screen's submit, and a
// screen whose host click never ran counts once the minter went on.
it("counts filled values as submitted once a submit after the fill was clicked", () => {
  const signIn = state();
  const login = {
    fields: [
      { selector: "#email", slot: "email" as const },
      { selector: "#password", slot: "password" as const },
    ],
    submit: "#go",
  };
  Effect.runSync(
    armStep(
      signIn,
      login,
      { ...screen, targets: { fields: [target, target], submit: target } },
      ["synthetic@example.test", "synthetic-password"],
      noSecret,
    ),
  );
  // Filled, not yet submitted.
  expect([...signIn.submittedSlots]).toEqual([]);
  // The host's click sends both.
  expect(submitFilled(signIn).toSorted()).toEqual(["email", "password"]);
  expect([...signIn.submittedSlots].toSorted()).toEqual(["email", "password"]);
  expect(signIn.sentIdentifiers).toEqual({ email: "synthetic@example.test" });
  expect(signIn.filled.size).toBe(0);
});

// A code box that submits itself on its last digit names no submit: once the minter goes on, the
// code it filled counts as submitted, with no submitter recorded for the step.
it("counts a screen with no submit of its own as submitted once the minter goes on", () => {
  const signIn = state();
  const code = { fields: [{ selector: "#code", slot: "code" as const }] };
  Effect.runSync(
    armStep(
      signIn,
      code,
      { ...screen, targets: { fields: [target], submit: null } },
      ["246810"],
      noSecret,
    ),
  );
  recordStep(signIn, code, {
    outcome: "filled",
    fields: [{ slot: "code", status: "filled" }],
    submit: "none",
    url: screen.page,
  });
  expect([...signIn.submittedSlots]).toEqual([]);
  expect(settleMinterSubmit(signIn)).toEqual(["code"]);
  expect([...signIn.submittedSlots]).toEqual(["code"]);
  expect(signIn.steps.at(-1)?.submittedBy).toBeUndefined();
});

it("counts a screen whose host click never ran as submitted by the minter once it goes on", () => {
  const signIn = state();
  const login = {
    fields: [
      { selector: "#user", slot: "username" as const },
      { selector: "#password", slot: "password" as const },
    ],
    submit: "#go",
  };
  Effect.runSync(
    armStep(
      signIn,
      login,
      { ...screen, targets: { fields: [target, target], submit: target } },
      ["synthetic-user", "synthetic-password"],
      noSecret,
    ),
  );
  recordStep(signIn, login, {
    outcome: "filled",
    fields: [
      { slot: "username", status: "filled" },
      { slot: "password", status: "filled" },
    ],
    submit: "failed",
    url: screen.page,
  });
  expect([...signIn.submittedSlots]).toEqual([]);
  expect(settleMinterSubmit(signIn).toSorted()).toEqual(["password", "username"]);
  expect(signIn.steps.at(-1)?.submittedBy).toBe("minter");
  // Settling again moves nothing.
  expect(settleMinterSubmit(signIn)).toEqual([]);
});

// The proof a build's and a run's sign-in needs before it verifies the login: the identifier alone
// proves only that the site trusts the browser, never that the login is the owner's.
it("does not count the identifier submitted alone as proof of the login", () => {
  const signIn = state();
  signIn.submittedSlots.add("email");
  expect(submittedLoginProof(signIn)).toBe(false);
});

it("counts the identifier and its code submitted as proof of the login", () => {
  const signIn = state();
  signIn.submittedSlots.add("email").add("code");
  expect(submittedLoginProof(signIn)).toBe(true);
});

it("counts the identifier and its password submitted as proof of the login", () => {
  const signIn = state();
  signIn.submittedSlots.add("email").add("password");
  expect(submittedLoginProof(signIn)).toBe(true);
});

it("does not count a code submitted with no identifier as proof of the login", () => {
  const signIn = state();
  signIn.submittedSlots.add("code");
  expect(submittedLoginProof(signIn)).toBe(false);
});

it("counts the identifier submitted and an approval step passed as proof of the login", () => {
  const signIn = state();
  signIn.submittedSlots.add("email");
  signIn.steps.push({ page: screen.page, fields: [], approval: "email_link" });
  expect(submittedLoginProof(signIn)).toBe(true);
});

// What named each control reaches the signed-in check's browser code, so the naming of one that
// carries a secret the broker holds, as a placeholder page code copied a typed password into, is
// never recorded.
it("records no naming of a control that carries a registered secret", async () => {
  const signIn = state();
  const codeTarget = { ...target, actions: ["https://example.test/code"] };
  const named = (placeholder: string) => ({
    label: "Verification code",
    ariaLabel: null,
    placeholder,
    type: "text",
    autocomplete: "one-time-code",
    name: "code",
    id: null,
  });
  const copied = "typed-secret-Pa55word";
  await Effect.runPromise(
    armStep(
      signIn,
      {
        fields: [
          { selector: "#code", slot: "code" },
          { selector: "#backup", slot: "recovery_code" },
        ],
        submit: "#go",
      },
      {
        page: "https://example.test/code",
        targets: { fields: [codeTarget, codeTarget], submit: codeTarget },
        screen: { fields: [named(copied), named("6 digits")] },
      },
      ["123456", "backup-code"],
      (text) => Effect.succeed(text.includes(copied)),
    ),
  );
  expect(signIn.steps[0]?.fields).toEqual([
    { selector: "#code", slot: "code" },
    { selector: "#backup", slot: "recovery_code", identity: named("6 digits") },
  ]);
  const scripts: string[] = [];
  await Effect.runPromise(
    checkAutofillSignedIn({
      indicator: { selector: "#account" },
      page: {
        targetId: "agent-tab",
        execute: (code: string) =>
          Effect.sync(() => {
            scripts.push(code);
            return {
              url: "https://example.test/account",
              indicator: true,
              passwordVisible: false,
              challengeFormVisible: false,
            };
          }),
      },
      siteOrigin: "https://example.test",
      screens: signIn.steps,
      authenticationOrigins: [],
    }),
  );
  expect(scripts.join("\n")).toContain("6 digits");
  expect(scripts.join("\n")).not.toContain(copied);
});

it("marks a screen as asking for the password again only beside a second factor no earlier screen took", () => {
  const page = "https://login.example.test/password";
  const screen = (...slots: ("password" | "code")[]) => ({
    page,
    fields: slots.map((slot) => ({ selector: `#${slot}`, slot })),
  });
  const lateCode = screen("password", "code");
  const open = state();
  open.steps.push(screen("password"));
  expect(reasksPassword(open, lateCode, ["password"])).toBe(true);
  // No refill of the password, a screen without a code, or a sign-in that is not open.
  expect(reasksPassword(open, lateCode, [])).toBe(false);
  expect(reasksPassword(open, screen("password"), ["password"])).toBe(false);
  expect(reasksPassword(undefined, lateCode, ["password"])).toBe(false);
  // A code already went out on an earlier screen: a run's replay would refuse the refill.
  open.steps.push(screen("code"));
  expect(reasksPassword(open, lateCode, ["password"])).toBe(false);
});
