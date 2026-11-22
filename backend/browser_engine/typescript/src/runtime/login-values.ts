import { identifierPreference, type IdentifierKind } from "../destinations/autofill-step.js";
import { parseDateOfBirth } from "../destinations/login-field-formats.js";
import type { WebsiteCredentials } from "./authentication.js";

/** An identifier a site may ask for besides the username: it picks which account signs in. */
export type LoginIdentifierKind = "email" | "phone" | "account_number";
/** A field the owner may be asked for during a sign-in: an identifier, a date of birth or a ZIP. */
export type AnsweredLoginField = LoginIdentifierKind | "date_of_birth" | "zip";
/** The fields the owner gave in this build. */
export type AnsweredLoginFields = Partial<Record<AnsweredLoginField, string>>;

export const kindNames = {
  email: "email address",
  phone: "phone number",
  account_number: "account number",
} as const;
/** What the host asks the owner for: identifiers of the kinds a field accepts, or one secret. */
export type Asked =
  | readonly LoginIdentifierKind[]
  | "code"
  | "recovery_code"
  | "date_of_birth"
  | "zip";

export const emailShaped = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.trim());
export const phoneShaped = (value: string) =>
  /^\+?[\d\s().-]+$/u.test(value.trim()) && value.replace(/\D/gu, "").length >= 7;

/**
 * The kind of an answer to the kinds a field accepts: an email-shaped answer is an email address,
 * one shaped like a number a phone number when the field takes one, and anything else an account
 * number when it takes one. An answer of no accepted shape has no kind, so the owner is asked
 * again.
 */
export const answeredKind = (
  value: string,
  kinds: readonly LoginIdentifierKind[],
): LoginIdentifierKind | undefined => {
  if (kinds.length === 1 && kinds[0] !== "phone") return kinds[0];
  if (kinds.includes("email") && emailShaped(value)) return "email";
  if (kinds.includes("phone") && phoneShaped(value)) return "phone";
  if (kinds.includes("account_number")) return "account_number";
  return kinds.includes("email") ? "email" : undefined;
};

/** A ZIP or postal code the owner typed, trimmed; undefined if it cannot be one. */
export const parseZip = (value: string) => {
  const zip = value.trim();
  return zip.length >= 3 && zip.length <= 10 ? zip : undefined;
};

export type Kept = "code" | "recovery_code" | AnsweredLoginField;
/** An answer as the field keeps it, and its kind; undefined when it is none the field takes. */
export const parsedAnswer = (
  asked: Asked,
  value: string,
): { readonly slot: Kept; readonly value: string } | undefined => {
  if (asked === "code" || asked === "recovery_code") return { slot: asked, value };
  if (asked === "date_of_birth") {
    const date = parseDateOfBirth(value);
    return date === undefined ? undefined : { slot: asked, value: date };
  }
  if (asked === "zip") {
    const zip = parseZip(value);
    return zip === undefined ? undefined : { slot: asked, value: zip };
  }
  const kind = answeredKind(value, asked);
  return kind === undefined ? undefined : { slot: kind, value };
};

/** Where an answered field's own value sits in a login. */
export const loginFieldKeys = {
  email: "email",
  phone: "phone",
  account_number: "accountNumber",
  date_of_birth: "dateOfBirth",
  zip: "zip",
} as const satisfies Record<AnsweredLoginField, keyof WebsiteCredentials>;

/**
 * A field the login holds: its own value, the owner's answer in this build, or, for an email
 * address, an email-shaped username (a site whose usernames are emails). A username of digits is
 * never taken as the phone number: it is as often a member number.
 */
/**
 * Whether a login's username is a username of its own. A login saved without one keeps its
 * primary identifier, an email address, phone number or account number, as its username and under
 * its own key, so a username equal to one of its identifiers is that identifier: a sign-in types it
 * into a field that takes that kind, or a username alone.
 */
export const separateUsername = (login: {
  readonly username: string;
  readonly email?: string | undefined;
  readonly phone?: string | undefined;
  readonly accountNumber?: string | undefined;
}) =>
  login.username !== "" &&
  login.username !== login.email &&
  login.username !== login.phone &&
  login.username !== login.accountNumber;

export const heldField = (
  field: AnsweredLoginField,
  credentials: WebsiteCredentials,
  given: AnsweredLoginFields,
) =>
  credentials[loginFieldKeys[field]] ??
  given[field] ??
  (field === "email" && emailShaped(credentials.username) ? credentials.username : undefined);

/**
 * The kind the host sends into an identifier field: the first it accepts that the login holds, by
 * `identifierPreference`; else the kind the owner is asked for.
 */
export const chosenKind = (
  accepts: readonly IdentifierKind[],
  held: (kind: IdentifierKind) => boolean,
): IdentifierKind =>
  identifierPreference.find((kind) => accepts.includes(kind) && held(kind)) ??
  accepts.find((kind) => kind !== "username") ??
  "username";
