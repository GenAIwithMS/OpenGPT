import type { ReviewedTaskUpdate } from "../guardian/task-update.js";

/**
 * How many words in a row of the request's own text a `caller_input` report's intent repeats to
 * cite the caller's instruction; a shorter request is cited whole.
 */
const quotedWords = 4;
/** The most input field names read, and how deep, so a large input stays cheap to check. */
const maximumFields = 2_000;
const maximumDepth = 12;

/** Lowercase words, with a camelCase or snake_case name split into its words. */
const words = (text: string): readonly string[] =>
  text
    .normalize("NFKC")
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];

/** Every field name the input holds, nested ones included, never a value. */
const fieldNames = (input: unknown): readonly string[] => {
  const names: string[] = [];
  const pending: { readonly value: unknown; readonly depth: number }[] = [
    { value: input, depth: 0 },
  ];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { value, depth } = next;
    if (typeof value !== "object" || value === null || depth >= maximumDepth) continue;
    for (const [key, child] of Object.entries(value)) {
      if (!Array.isArray(value)) names.push(key);
      if (names.length >= maximumFields) return names;
      pending.push({ value: child, depth: depth + 1 });
    }
  }
  return names;
};

/** The intent's words, spaced so that a run of words matches whole words only. */
const spoken = (intent: string) => ` ${words(intent).join(" ")} `;

/** Whether the spoken intent holds this run of words, in order. */
const says = (said: string, run: readonly string[]) =>
  run.length > 0 && said.includes(` ${run.join(" ")} `);

/**
 * Whether the spoken intent repeats four words in a row of the text, or all of it when the text is
 * shorter but holds at least `fewest` words.
 */
const quotes = (said: string, text: string, fewest = 1): boolean => {
  const asked = words(text);
  if (asked.length < fewest) return false;
  const length = Math.min(quotedWords, asked.length);
  for (let start = 0; start + length <= asked.length && length > 0; start++)
    if (says(said, asked.slice(start, start + length))) return true;
  return false;
};

/**
 * Whether a `caller_input` report's intent cites the caller's own request: it names a field the
 * task's input holds, or repeats four words in a row of the request's text, or all of it when the
 * text is shorter. Case, punctuation, spacing and camelCase or snake_case names are ignored.
 */
export const citesCallerRequest = (
  intent: string | undefined,
  requestText: string,
  input: unknown,
): boolean => {
  if (intent === undefined) return false;
  const said = spoken(intent);
  if (fieldNames(input).some((name) => says(said, words(name)))) return true;
  return quotes(said, requestText);
};

/** The texts an intent may quote to cite an accepted update: its own, and its confirming answers'. */
const updateTexts = (update: ReviewedTaskUpdate): readonly string[] => [
  update.summary,
  ...update.changes.flatMap((change) =>
    "text" in change && change.text !== undefined ? [change.text] : [],
  ),
  ...update.confirmation.flatMap(({ answer, other, note }) => [
    ...(typeof answer === "string"
      ? [answer]
      : "confirmed" in answer
        ? answer.text === undefined
          ? []
          : [answer.text]
        : answer),
    ...(other === undefined ? [] : [other]),
    ...(note === undefined ? [] : [note]),
  ]),
];

/**
 * Whether a `caller_input` report's intent cites a task update the owner confirmed in an answer:
 * an accepted update whose `confirmedBy` named an answered question, so its `confirmation` holds
 * that answer. The intent names its revision, such as "revision 2", or repeats four words in a row
 * of its summary, of a change it makes or of the answer that confirmed it, or all of such a text
 * when it is shorter. A one-word text, such as an answer "Yes", is too short to quote.
 */
export const citesConfirmedUpdate = (
  intent: string | undefined,
  updates: readonly ReviewedTaskUpdate[],
): boolean => {
  if (intent === undefined) return false;
  const said = spoken(intent);
  return updates.some(
    (update) =>
      update.confirmation.length > 0 &&
      (says(said, ["revision", String(update.revision)]) ||
        updateTexts(update).some((text) => quotes(said, text, 2))),
  );
};
