/** One option a picker listed, as `rankChoices` reads it. */
export interface PickerChoice {
  /** Every name the option shows or carries: its text, first line, accessible name, title, cells. */
  readonly names: readonly string[];
  /** The value the option carries in an attribute, such as `data-value`, or "". */
  readonly value: string;
  readonly disabled: boolean;
  /** Options with one key are one option seen twice; different keys are different options. */
  readonly key: string;
}

/** How closely the winning option matched, best first. */
export const pickerRanks = ["exact", "normalized", "folded", "leading", "words", "stem"] as const;
export type PickerRank = (typeof pickerRanks)[number];

export type PickerRanking =
  | { readonly status: "picked"; readonly index: number; readonly rank: PickerRank }
  | { readonly status: "disabled"; readonly index: number; readonly rank: PickerRank }
  | {
      readonly status: "ambiguous";
      readonly indexes: readonly number[];
      readonly rank: PickerRank;
    }
  | { readonly status: "missing" };

/**
 * The one option `wanted` names, a list of spellings of one choice, by rank: a name or the value
 * as written (trimmed), then ignoring case and spacing, then also ignoring accents and
 * punctuation (`fold`), then, only with `options.leading`, a name whose leading part, its text
 * before its first comma that is not between two digits, is a spelling, folded the same way
 * (`leading`: York, UK for York, but not 1,000 miles for 1), then a name holding a spelling as
 * whole words (New York for York), then, only with `options.stem`, a name whose words pair one
 * for one, in order, with a spelling's (`stem`), as a read asks for and a write never does. Two
 * words pair when they are equal, or when both are Latin letters only and the shorter, of five or
 * more letters, is the whole start of the longer, such as Dentist and Dentistry or Dentists and
 * Dentist, but not Employee and Employer, County and Country, Physician and Physics, Adam and
 * Adams, or UK and Ukraine. The value never matches by stem. A name beats the value at each rank.
 * Options at the first rank that matches decide: one option (by key) is picked, or reported
 * disabled when every copy of it is; two or more are ambiguous, never guessed. A weaker rank never
 * overrules a stronger one, so a disabled exact match is not replaced by a looser one. Without
 * `options.leading`, no option ranks `leading`; without `options.stem`, none ranks `stem`.
 *
 * It is pure and self-contained: the page code of `pickerCode` embeds this same function with
 * `fold` set to `foldChoiceText`.
 */
export const rankChoices = (
  choices: readonly PickerChoice[],
  wanted: readonly string[],
  fold: (text: string) => string,
  options: { readonly leading?: boolean; readonly stem?: boolean } = {},
): PickerRanking => {
  const squash = (text: string) => String(text ?? "").replace(/\s+/gu, " ").trim();
  const lower = (text: string) => squash(text).toLowerCase();
  const words = (text: string) => fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const phrase = (text: string) => " " + words(text).join(" ") + " ";
  // Two words pair when they are equal, or when both are Latin letters only and the shorter, of
  // five or more letters, is the whole start of the longer.
  const latin = /^\p{Script=Latin}+$/u;
  const pairs = (want: string, have: string) => {
    if (want === have) return true;
    if (!latin.test(want) || !latin.test(have)) return false;
    const [short, long] = want.length <= have.length ? [want, have] : [have, want];
    return short.length >= 5 && long.startsWith(short);
  };
  const spellings = wanted.map(squash).filter((spelling) => spelling !== "");
  const tests: readonly (readonly [PickerRank, (choice: PickerChoice) => boolean])[] = [
    ["exact", (choice) => choice.names.some((name) => spellings.includes(squash(name)))],
    ["exact", (choice) => choice.value !== "" && spellings.includes(squash(choice.value))],
    ...(
      [
        ["normalized", lower],
        ["folded", fold],
      ] as const
    ).flatMap(([rank, form]) => {
      const forms = new Set(spellings.map(form).filter((spelling) => spelling !== ""));
      return [
        [rank, (choice: PickerChoice) => choice.names.some((name) => forms.has(form(name)))],
        [rank, (choice: PickerChoice) => choice.value !== "" && forms.has(form(choice.value))],
      ] as const;
    }),
    ...(options.leading === true
      ? ([
          [
            "leading",
            (choice: PickerChoice) => {
              const forms = new Set(spellings.map(fold).filter((spelling) => spelling !== ""));
              return choice.names.some((name) => {
                // The first comma that is not a thousands separator, as in 1,000.
                const comma = String(name ?? "").search(/(?<!\p{N}),|,(?!\p{N})/u);
                return comma > 0 && forms.has(fold(String(name).slice(0, comma)));
              });
            },
          ],
        ] as const)
      : []),
    [
      "words",
      (choice) => {
        const parts = spellings.map(phrase).filter((part) => part.trim() !== "");
        return choice.names.some((name) => parts.some((part) => phrase(name).includes(part)));
      },
    ],
    [
      "stem",
      (choice) => {
        if (options.stem !== true) return false;
        const wants = spellings.map(words).filter((list) => list.length > 0);
        return choice.names.some((name) => {
          const have = words(name);
          return wants.some((want) => want.length === have.length && want.every((word, at) => pairs(word, have[at] ?? "")));
        });
      },
    ],
  ];
  for (const [rank, test] of tests) {
    const matched = choices.flatMap((choice, index) => (test(choice) ? [index] : []));
    if (matched.length === 0) continue;
    const keys = [...new Set(matched.map((index) => choices[index]?.key))];
    if (keys.length > 1) {
      const indexes = keys.map((key) => matched.find((index) => choices[index]?.key === key) ?? 0);
      return { status: "ambiguous", indexes, rank };
    }
    const enabled = matched.find((index) => choices[index]?.disabled === false);
    return enabled === undefined
      ? { status: "disabled", index: matched[0] ?? 0, rank }
      : { status: "picked", index: enabled, rank };
  }
  return { status: "missing" };
};
