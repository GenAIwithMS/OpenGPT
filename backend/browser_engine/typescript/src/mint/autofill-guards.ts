import type { AutofillSignedIn, AutofillStep } from "../destinations/autofill-step.js";
import { Effect } from "effect";
import { isSecret } from "../runtime/autofill-state.js";
import type { AutofillSignInState } from "../runtime/autofill-state.js";
import { type AutofillHost, autofillRecovery, refusedStep, result } from "./autofill-results.js";
import { namesMaskedContact } from "./sign-in-guards.js";

// What an autofill sign-in publishes with the tool never names one account: a signed-in check runs
// for every login, and a method's selector is copied into the recipe.

type Host = AutofillHost;

/** What the minter reads when a recorded selector, or a signed-in check, names this account. */
export const identityNotices = {
  selectors:
    "A screen's selectors and submit publish with the tool, so they never name this account's username, email, phone or account number (such as a \"Continue as …\" button or a data attribute holding it). Name each control by its role, label or a stable attribute, and send the step again.",
  indicator: `The signed-in check names this account's own identity, which publishes with the tool and fails for every other login. Name a marker every signed-in account shows, such as a sign-out control or the account menu, never the account's name, email or number, ${autofillRecovery}.`,
} as const;

/** The login's identifiers this sign-in knows: the held login's and the owner's answers. */
const identityValues = (
  h: Host,
  open: AutofillSignInState | undefined,
  filled: readonly string[] = [],
) => {
  const credentials = h.heldLogin.current?.credentials;
  return [
    credentials?.username,
    credentials?.email,
    credentials?.phone,
    credentials?.accountNumber,
    open?.sentIdentifiers.email,
    open?.sentIdentifiers.phone,
    open?.sentIdentifiers.accountNumber,
    ...filled,
    h.answeredLoginFields.current.email,
    h.answeredLoginFields.current.phone,
    h.answeredLoginFields.current.account_number,
  ].flatMap((value) => (value === undefined || value.length < 3 ? [] : [value.toLowerCase()]));
};

/**
 * Whether a text names a known identity value, or one of the shared masks (`[password]`, `[code]`,
 * `[recovery_code]`). The local `[private]` mask is the local recorder's own check (`holdsMask`).
 */
const namesIdentityOrSharedMask = (text: string, values: readonly string[]) => {
  const lower = text.toLowerCase();
  return (
    values.some((value) => lower.includes(value)) ||
    /\[(password|code|recovery_code)\]/u.test(lower)
  );
};

/** Whether the check names a known identity value, or one of the shared masks. */
const holdsIdentity = (indicator: AutofillSignedIn, values: readonly string[]) =>
  namesIdentityOrSharedMask(
    [indicator.selector, indicator.urlPath, indicator.openPath]
      .filter((part) => part !== undefined)
      .join(" "),
    values,
  );

/**
 * A refusal of a signed-in check that names the account's own identity, or undefined. The check
 * ships with the tool and runs for every login.
 */
export const identityRefusal = (h: Host, open: AutofillSignInState, indicator: AutofillSignedIn) =>
  holdsIdentity(indicator, identityValues(h, open))
    ? result({
        signedIn: false,
        failed: "indicator_holds_identity",
        nextStep: identityNotices.indicator,
      })
    : undefined;

/** A refusal of a method choice whose selector copies a masked contact detail, or undefined. */
export const maskedMethodRefusal = (h: Host, step: Pick<AutofillStep, "methods" | "submit">) => {
  if (step.methods === undefined) return undefined;
  const masked = step.methods.findIndex((option) => namesMaskedContact(option.selector));
  if (masked === -1 && !namesMaskedContact(step.submit ?? "")) return undefined;
  return refusedStep(
    h,
    "selector_names_contact",
    Math.max(masked, 0),
    "A method's selector publishes with the tool, so it never names the masked phone number or address the option shows. Name each option by its method's own words or a stable attribute, and send the step again.",
  );
};

/**
 * A refusal of a screen whose recorded selectors, submit or page name this account's identity, or
 * undefined: the recipe ships each one with the tool. Nothing is typed before it.
 */
export const stepIdentityRefusal = (
  h: Host,
  open: AutofillSignInState | undefined,
  step: Pick<AutofillStep, "fields" | "methods" | "submit" | "rejectedMarkers">,
  page: string,
  filled: readonly string[],
) => {
  const values = identityValues(
    h,
    open,
    step.fields.flatMap((field, index) => (isSecret(field.slot) ? [] : [filled[index] ?? ""])),
  );
  const selectors = [
    ...(step.rejectedMarkers ?? []).map((marker) => marker.selector),
    ...step.fields.map((field) => field.selector),
    ...(step.submit === undefined ? [] : [step.submit]),
    ...(step.methods ?? []).map((option) => option.selector),
  ];
  const named = selectors.findIndex((selector) => namesIdentityOrSharedMask(selector, values));
  if (named !== -1)
    return refusedStep(h, "selector_names_contact", named, identityNotices.selectors);
  // An address may carry a value percent-encoded, such as an email's `@` as `%40`.
  const encoded = values.map((value) => encodeURIComponent(value).toLowerCase());
  if (namesIdentityOrSharedMask(page, [...values, ...encoded]))
    return refusedStep(
      h,
      "page_names_contact",
      0,
      `This screen's address names this account's identity, and the recipe would publish it with the tool, so the host typed nothing. Use an account-independent route and inspect its sign-in screens.`,
    );
  return Effect.succeed(undefined);
};
