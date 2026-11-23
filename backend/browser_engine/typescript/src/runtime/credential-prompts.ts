import type { CredentialQuestion } from "./input-request.js";

export type CredentialReason = (typeof CredentialQuestion.Type)["reason"];

/** How many tries a correction has left, this one included. */
export const correctionTriesLeft = (triesLeft: number) =>
  triesLeft <= 1 ? "This is your last try." : `You have ${triesLeft} tries left.`;

/** The prompt each reason shows above the login fields; a correction shows its tries left. */
export const credentialPrompt = (reason: CredentialReason, triesLeft?: number) =>
  reason === "missing_credentials"
    ? "Sign in to the website so this request can continue."
    : reason === "invalid_credentials"
      ? `The website rejected the login. Enter a correction to continue.${
          triesLeft === undefined ? "" : ` ${correctionTriesLeft(triesLeft)}`
        }`
      : "The temporary password expired. Enter the password again to continue.";

/**
 * The host's standard message for why a login is asked, shown wherever the host asks for it and
 * never written by a model. A rejected login says plainly that the one given did not work and is
 * not tried again.
 */
export const credentialMessage = (reason: CredentialReason) =>
  reason === "missing_credentials"
    ? "OpenGPT needs a login for this website to continue."
    : reason === "invalid_credentials"
      ? "The website rejected the login you gave, so OpenGPT won't try it again. Enter the correct login to continue."
      : "The website's temporary password expired. Enter the current one to continue.";
