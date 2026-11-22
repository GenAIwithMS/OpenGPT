import type { AutofillStep } from "../destinations/autofill-step.js";
import {
  type AutofillSecret,
  type AutofillSignInState,
  isSecret,
  provesLogin,
  settleMinterSubmit,
} from "../runtime/autofill-state.js";
import { type AutofillHost, autofillRecovery, refusedStep } from "./autofill-results.js";

// What a build sign-in keeps of the secrets it filled: a password or code is filled once more at
// most in one sign-in, any other secret once.

type Host = AutofillHost;

/** Secrets the sign-in may have sent: only a password or code is filled once more. */
export const addFilledSecrets = (h: Host, secrets: readonly AutofillSecret[]) => {
  h.autofillSecretsFilled.current = [...new Set([...h.autofillSecretsFilled.current, ...secrets])];
};

/** The secrets a step names that the sign-in already filled, which its fill would refill. */
export const filledBefore = (h: Host, step: AutofillStep) =>
  step.fields
    .map((field) => field.slot)
    .filter(isSecret)
    .filter((slot) => h.autofillSecretsFilled.current.includes(slot));

/** Secrets the sign-in filled again after it may have sent them: it never fills them again. */
export const addRefilledSecrets = (h: Host, secrets: readonly AutofillSecret[]) => {
  h.autofillSecretsRefilled.current = [
    ...new Set([...h.autofillSecretsRefilled.current, ...secrets]),
  ];
};

/** A step that names a secret the sign-in filled as often as it may types nothing. */
export const refusedRefill = (h: Host, step: AutofillStep, target: number) => {
  const slot = step.fields[target]?.slot ?? "password";
  return refusedStep(
    h,
    "credential_already_filled",
    target,
    `The host already filled this login's ${slot} ${provesLogin(slot) ? "twice" : "once"} in this sign-in and never fills it again, so it typed nothing: if the site did not sign in, count it as a possible rejection. Explore read-only to see the page; send signedIn if the page shows the site signed in, ${autofillRecovery}.`,
  );
};

/**
 * The minter went on after a screen the host's click never sent: it submitted that screen itself,
 * or the screen sent itself. Its secrets count as filled, as after the host's own click.
 */
export const settleMinter = (h: Host, open: AutofillSignInState | undefined) => {
  if (open === undefined) return;
  addFilledSecrets(h, settleMinterSubmit(open).filter(isSecret));
};
