import { Schema } from "effect";
import { SignInMethod } from "./autofill-contracts.js";

/**
 * A value a tool's sign-in takes from its caller or the saved login, as the tool's public
 * `login_fields` names it. One-time codes, recovery codes included, never appear: a run gets them
 * from the owner or the saved login, never from its call.
 */
export const LoginField = Schema.Literal(
  "username",
  "password",
  "email",
  "phone",
  "account_number",
  "date_of_birth",
  "zip",
);
export type LoginField = typeof LoginField.Type;

/**
 * What one verified sign-in used, value-free: the fields it filled and, when it met a two-factor
 * method choice, every method that choice offered that a call may name. A revision records it as
 * its `login_fields` and `sign_in_methods`; one without it predates the record.
 */
export const LoginFields = Schema.Array(LoginField).pipe(
  Schema.minItems(1),
  Schema.maxItems(LoginField.literals.length),
);
export const SignInMethods = Schema.Array(SignInMethod).pipe(
  Schema.minItems(1),
  Schema.maxItems(SignInMethod.literals.length),
);
