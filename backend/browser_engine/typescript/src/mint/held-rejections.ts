import { createHash } from "node:crypto";
import type { CredentialRejectedField } from "../runtime/authentication.js";
import { failureDetail } from "../runtime/failure-detail.js";
import { MintFailure } from "./contracts.js";

/** The attempt's held login and the digest of the password the site rejected, if any. */
export type HeldPassword = {
  readonly heldLogin: {
    readonly current:
      | {
          readonly credentials?:
            | { readonly username?: string; readonly password?: string | undefined }
            | undefined;
        }
      | undefined;
  };
  readonly autofillRejectedPassword: { current: string | undefined };
  readonly autofillRejectedValues: {
    current: Partial<Record<CredentialRejectedField, readonly string[]>>;
  };
};

/** Retains the last possibly sent password digest, never an unrelated held replacement. */
export const rememberRejectedPassword = (h: HeldPassword, sentDigest: string | undefined) => {
  if (sentDigest !== undefined) h.autofillRejectedPassword.current = sentDigest;
};

/**
 * Whether the password the attempt holds is one the site rejected, by its digest: the last one
 * possibly sent, or any the attempt remembers. It is never sent again.
 */
export const heldPasswordRejected = (h: HeldPassword) => {
  const password = h.heldLogin.current?.credentials?.password;
  return (
    password !== undefined &&
    (passwordDigest(password) === h.autofillRejectedPassword.current ||
      h.autofillRejectedValues.current.password?.includes(passwordDigest(password)) === true)
  );
};

/**
 * The login's password as the attempt remembers a rejected one: a digest, kept with the attempt,
 * never the value.
 */
export const passwordDigest = (password: string) =>
  createHash("sha256")
    .update(JSON.stringify(["opengpt-rejected-password-v1", password]))
    .digest("hex");

/** The sign-in fails as rejected: a remaining field correction runs, or the build ends. */
export const rejection = (
  cause:
    | "site_rejected"
    | "equal_correction"
    | "rejected_password_held"
    | "rejected_primary_held"
    | "rejected_login_held",
  field: CredentialRejectedField = "password",
) =>
  new MintFailure({
    code: "CredentialsRejected",
    rejectedCredential: field,
    failureDetail: failureDetail("mint_host_dependency_failed", {
      operation: "autofill.rejected",
      phase: "sign_in",
      context: { cause },
    }),
  });
