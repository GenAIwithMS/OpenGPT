// The identity guards a recorded sign-in passes: what a published selector, page or signed-in
// marker never holds, because it replays for every login. The sign-in version check applies them
// to every part of a version. The build's recorder screens each screen as it records with the
// shared rules in `autofill-guards.ts`, which take `namesMaskedContact` from here, and its own
// check for `[private]`.

/**
 * Whether a text names one of an account's identity values (lowercased, as `values` holds them),
 * or the placeholder a screened page shows for one.
 */
export const namesIdentityOrPrivateMask = (text: string, values: readonly string[]): boolean => {
  const lower = text.toLowerCase();
  return values.some((value) => lower.includes(value)) || lower.includes("[private]");
};

/**
 * Whether a text copies a masked or partial contact detail or number, as choice buttons show one
 * ("Text (***) ***-1234", "j•••@example.com", "Checking ••1234"): a run of mask characters, or
 * four or more digits in a row.
 */
export const namesMaskedContact = (text: string): boolean => /[*•●]{2,}|\d{4,}/u.test(text);
