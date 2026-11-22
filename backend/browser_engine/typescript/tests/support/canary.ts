/**
 * Matches a numeric canary only where it stands as its own number. A substring check for "3700"
 * also matches timings, ids and hashes that happen to contain those digits, such as
 * `0.4076370000002498`, so it fails at random. A digit, or a decimal point next to a digit, on
 * either side makes the digits part of another number. Trailing punctuation such as "3700." at the
 * end of a sentence still counts as the canary.
 */
export const standaloneNumber = (canary: number | string): RegExp => {
  const digits = String(canary);
  if (!/^\d+$/u.test(digits)) throw new Error(`A numeric canary must be digits only: ${digits}`);
  return new RegExp(`(?<!\\d)(?<!\\d\\.)${digits}(?!\\d)(?!\\.\\d)`, "u");
};
