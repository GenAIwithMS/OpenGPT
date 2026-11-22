import { Data, Schema } from "effect";

/** Field kinds safe to disclose when the site refuses a sign-in value. */
export const credentialRejectedFields = [
  "username",
  "email",
  "phone",
  "account_number",
  "password",
  "code",
  "date_of_birth",
  "zip",
  "recovery_code",
] as const;
export const CredentialRejectedField = Schema.Literal(...credentialRejectedFields);
export type CredentialRejectedField = typeof CredentialRejectedField.Type;

/**
 * A two-factor method a sign-in may use: a run call's `sign_in_method` or one of the login's saved
 * recovery codes, used only while it is the method in force (the owner's choice or saved
 * preference), never as a fallback.
 */
export const signInMethodChoices = [
  "sms",
  "call",
  "email",
  "totp",
  "push",
  "recovery_code",
] as const;
type SignInMethodChoice = (typeof signInMethodChoices)[number];

export interface WebsiteCredentials {
  readonly username: string;
  /** Trusted saved-login metadata; never inferred from the identifier's text. */
  readonly primaryIdentifierKind?: "username" | "email" | "phone" | "account_number";
  /**
   * Whether the saved login holds a TOTP seed, as its directory row records it; absent when the
   * row predates that record (unknown, never absence). The seed itself never leaves the
   * credential worker.
   */
  readonly hasTotpSeed?: boolean | undefined;
  readonly password?: string | undefined;
  /** The extra fields a saved v3 login also holds; see `LoginExtraFields`. */
  readonly email?: string | undefined;
  readonly phone?: string | undefined;
  readonly accountNumber?: string | undefined;
  readonly dateOfBirth?: string | undefined;
  readonly zip?: string | undefined;
  readonly recoveryCodes?: readonly string[] | undefined;
  readonly preferredSignInMethod?: SignInMethodChoice | undefined;
}

/**
 * Why an operation could not stay signed in: `session_not_kept` when the site lost its signed-in
 * session, as on a page load, and the host could not sign in again.
 */
export type SessionLoss = "session_not_kept";

/**
 * An operation that finds the site signed out. The host signs in before the operation runs and
 * checks no identity, so only the operation can report that the session is gone.
 */
export class WebsiteAuthenticationFailed extends Data.TaggedError("WebsiteAuthenticationFailed")<{
  readonly code: "CredentialsRequired" | "MissingRecipe" | "InvalidCredential";
}> {}
