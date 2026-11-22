import { Effect } from "effect";
import {
  cardDigitRun,
  cardValueForms,
  isCardSlot,
  shortCardPart,
} from "../destinations/payment-frames.js";
import { shownForms } from "../privacy/value-forms.js";

/**
 * A short form of a secret (`shownForms`) counts in source only as a whole token, as the
 * submission guard finds a code: an all-digit form where no digit adjoins it, any other where no
 * letter, mark or digit adjoins it on a side whose own edge is one. A short value, such as a
 * favorite color or a six-digit code, turns up inside a longer word or a timestamp by chance.
 * Redaction, which feeds what a model sees, still masks every form wherever it appears.
 */
const wordClass = "[\\p{L}\\p{M}\\p{N}]";
/** Every place `form` stands as a whole token. */
const tokenPattern = (form: string) => {
  const adjoining = /^[0-9]+$/u.test(form) ? "[0-9]" : wordClass;
  const starts = new RegExp(`^${adjoining}`, "u").test(form);
  const ends = new RegExp(`${adjoining}$`, "u").test(form);
  const escaped = form.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&");
  return new RegExp(
    `${starts ? `(?<!${adjoining})` : ""}${escaped}${ends ? `(?!${adjoining})` : ""}`,
    "u",
  );
};

/** Explicit caller secrets live only for this run. This does not detect or classify page data. */
export const makeRunSecrets = () => {
  /** Each registered form, with the pattern source screening counts it by when it is short. */
  const values = new Map<string, RegExp | undefined>();
  /** Registers each form a page or URL can show the value in (`shownForms`). */
  const register = (value: string) => {
    for (const [shownForm, short] of shownForms(value))
      if (!short) values.set(shownForm, undefined);
      else if (!values.has(shownForm)) values.set(shownForm, tokenPattern(shownForm));
  };
  /**
   * A payment card's own patterns, masked only in what a model or log sees (`redact`), never
   * checked in source: a card number's digits in any grouping, and a short card part (a security
   * code, a short expiry or postal code) only where no digit adjoins it, so "ZX1239" and a file's
   * `123` stay as they are.
   */
  const cardPatterns = new Map<string, RegExp>();
  /** Registers a card number's digit run (`pattern`, global), masked whatever its grouping. */
  const registerCardPattern = (pattern: RegExp) => {
    cardPatterns.set(pattern.source, pattern);
  };
  /** Registers a short card part, of a few characters, as whole digit tokens. */
  const registerCardToken = (value: string) => {
    for (const [shownForm] of shownForms(value)) {
      const escaped = shownForm.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&");
      registerCardPattern(new RegExp(`(?<![0-9])${escaped}(?![0-9])`, "gu"));
    }
  };
  const ordered = () => [...values].sort(([left], [right]) => right.length - left.length);
  const redact = (text: string) =>
    [...cardPatterns.values()].reduce(
      (result, pattern) => result.replace(pattern, "[private]"),
      ordered().reduce((result, [secret]) => result.split(secret).join("[private]"), text),
    );
  /** The longest proper prefix of a registered form that `text` ends with, as a length. */
  const splitPrefix = (text: string) =>
    ordered().reduce((longest, [secret]) => {
      for (let length = Math.min(secret.length - 1, text.length); length > longest; length--)
        if (text.endsWith(secret.slice(0, length))) return length;
      return longest;
    }, 0);
  /** Redacts text a cut ended, so a secret the cut split leaves no prefix at its end either. */
  const redactCut = (text: string) => {
    const redacted = redact(text);
    return redacted.slice(0, redacted.length - splitPrefix(redacted));
  };
  const assertAbsent = (text: string) =>
    Effect.suspend(() =>
      ordered().some(([secret, token]) =>
        token === undefined ? text.includes(secret) : token.test(text),
      )
        ? Effect.fail(new Error("Source contains a caller-supplied secret"))
        : Effect.void,
    );
  const json = (value: unknown) =>
    // error-reporting-allow: typed-recovery an observation getter may throw raw secrets, so only the finite serialization failure crosses this redaction boundary
    Effect.try({
      try: () => {
        const seen = new WeakSet<object>();
        const visit = (item: unknown): unknown => {
          if (typeof item === "string") return redact(item);
          if (item === null || typeof item !== "object") return item;
          if (seen.has(item)) throw new Error("Observation must be JSON serializable");
          seen.add(item);
          const result: unknown = Array.isArray(item)
            ? item.map(visit)
            : Object.fromEntries(
                Object.entries(item).map(([key, entry]) => [redact(key), visit(entry)]),
              );
          seen.delete(item);
          return result;
        };
        return visit(value);
      },
      catch: () => new Error("Observation must be JSON serializable"),
    });
  return {
    register,
    registerCardPattern,
    registerCardToken,
    redact,
    redactCut,
    assertAbsent,
    json,
    clear: () => {
      values.clear();
      cardPatterns.clear();
    },
  };
};
export type RunSecrets = ReturnType<typeof makeRunSecrets>;

/**
 * Registers one `secret` answer of kind `kind`. A card answer is also masked in the forms a page
 * shows it in (`cardValueForms`), a short part only as a whole token, and a card number's digits
 * in any grouping.
 */
export const registerSecretAnswer = (secrets: RunSecrets, kind: string | undefined, value: string) => {
  if (!isCardSlot(kind)) return secrets.register(value);
  for (const form of cardValueForms(kind, value))
    if (form.length <= shortCardPart) secrets.registerCardToken(form);
    else secrets.register(form);
  const run = kind === "card_number" ? cardDigitRun(value) : undefined;
  if (run !== undefined) secrets.registerCardPattern(run);
};
