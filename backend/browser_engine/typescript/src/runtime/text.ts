/**
 * Text as a person reads it: characters that never show (zero-width space U+200B, word joiner
 * U+2060, byte order mark U+FEFF and soft hyphen U+00AD) removed, while the zero-width
 * non-joiner and joiner (U+200C, U+200D), which spell words in many scripts and join emoji, stay;
 * a no-break space or any other Unicode space read as a space, runs of spaces and tabs collapsed
 * to one, each line trimmed and empty lines dropped. By default the lines are joined
 * with one space; `lines: true` keeps them, separated by "\n".
 *
 * It is pure and self-contained: the page code of `visibleTextCode` embeds this same function, so a
 * value read over HTTP or from parsed HTML normalizes as one read from the rendered page does.
 */
export const normalizeText = (text: string, options: { readonly lines?: boolean } = {}): string =>
  text
    .replace(/[\u200B\u2060\uFEFF\u00AD]/gu, "")
    .replace(/\r\n?|[\u0085\u2028\u2029]/gu, "\n")
    .replace(/[ \t\v\f\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/gu, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(options.lines === true ? "\n" : " ");

/**
 * A choice's name folded for matching: case, accents and runs of spaces ignored, apostrophes
 * dropped and the punctuation `.`, `,`, hyphens and dashes read as a space, except next to a
 * digit, so "Joe’s Café" and "joes cafe" name the same option while "-1.5" keeps its sign and
 * point. Text that folds to nothing is kept as written, trimmed.
 *
 * It is pure and self-contained: the page code of `formControlsCode` and `pickerCode` embeds this
 * same function, so every option match folds names alike.
 */
export const foldChoiceText = (text: unknown): string => {
  const folded = String(text ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .normalize("NFC")
    .replace(/(?<!\p{N})['\u2018\u2019\u02bc](?!\p{N})/gu, "")
    .replace(/(?<!\p{N})[.,\-\u2010\u2011\u2012\u2013\u2014](?!\p{N})/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  return folded === "" ? String(text ?? "").trim() : folded;
};

/**
 * Whether `shown`, text read from the page, names what `wanted` names, as a person reads them.
 * Case, accents on Latin, Greek and Cyrillic letters, spacing and apostrophes are ignored, and so
 * are periods, commas and hyphens between letters, while marks that change a word in other scripts,
 * such as Hindi, Thai and Japanese, still count. A word `shown` writes short, such as St for Saint
 * or Blvd for Boulevard, matches the full word in `wanted` when it starts with the same letter,
 * keeps its letters in order and is at most half as long. This holds only for words of Latin
 * letters, never inside an email, domain or file name. A short word in `wanted` never matches a
 * longer one in `shown`, so a wanted Pen never matches a shown Pencil. Both texts need the same
 * number of words in the same order, and a word holding a digit or another symbol, such as a slash
 * or a bracket, must be the same word, so 12 never matches 123, C++ never matches C and Blue/Green
 * never matches Blue Green. A space, hyphen, dash, slash or parentheses between digits is one
 * separator, whichever it is, so 29 59, 29-59 and 29/59 match, and so do (317) 555-1234 and
 * 317-555-1234, but the groups it separates count: 1/12 never matches 11/2, 1 234 never matches
 * 12 34 and 2959 never matches 29 59. A period or comma between digits counts too, so 10.0 never
 * matches 100. Compare numbers, dates and amounts as values instead.
 *
 * With `{ rewrite: true }`, `shown` is the site's own version of a value the tool typed, `wanted`,
 * such as an address the site standardized as it was entered, and the answer is whether it kept
 * everything the caller gave. It only tells a rewrite that reformatted the value from one that
 * changed it, and never decides whether a write goes on. Every word and number of `wanted` must
 * appear in `shown`, in order. A word may be written short or in full either way, with the same
 * first letter, its letters in order and a short form of two letters or more, at most three fifths
 * as long as the full word, and of two letters when it is the full word's start. So Parkway
 * matches PKWY, Suite matches STE and St matches Street, either way, while Main never matches
 * Martin, Mainland or M, Larkspur never matches Lark, Oakwood never matches Oak and Avenue never
 * matches Ave. A number keeps its groups, as above, though the site may pad a group of a grouped
 * number with zeros, as 01/12 for 1/12, or add thousands commas to a bare one, as 1,420 for 1420,
 * and three or more groups split by periods, as in 555.123.4567, are groups as a hyphen splits
 * them. A bare number of seven digits or more, a phone or account number, may come back grouped,
 * so 5551234567 matches (555) 123-4567, but a shorter one never does and a grouped one never
 * comes back regrouped or bare, so 1420 never matches 14-20 and 29-59 never matches 2959. What
 * the site adds is a change, a word holding a digit, a unit or a place alike, so Apt 4 never
 * matches Apt 4B, and 1420 Larkspur Rd never matches 1420-2 Larkspur Rd or 1420 Larkspur Rd
 * Apt 2, with three exceptions: a word of one or two Latin letters between two of the caller's,
 * as 100 N Main St adds N to 100 Main St; a country code before a number, as +1 before
 * (555) 123-4567; and one more group after a postal code of five digits or more that ends the
 * caller's value, so 46204 matches 46204-1234. Other punctuation is ignored. A dropped or changed
 * word or number fails, so 1420 Oak Road, Springfield never matches 1420 Oak Rd, Riverton, except
 * a country code the caller typed where the site shows none. An email, domain or file name, or a
 * `wanted` with no letter or digit, compares as it does without the option.
 *
 * It is pure and self-contained, so page code can embed it.
 */
export const sameText = (
  shown: string,
  wanted: string,
  options: { readonly rewrite?: boolean } = {},
): boolean => {
  const fold = (text: string) => {
    const raw = String(text ?? "").replace(/[\u00AD\u200B\u2060\uFEFF]/gu, "");
    const folded = raw
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/gu, "")
      .normalize("NFC")
      .toLowerCase()
      .replace(/(?<!\p{N})['\u2018\u2019\u02bc](?!\p{N})/gu, "")
      .replace(/(?<!\p{N})[.,\-\u2010\u2011\u2012\u2013\u2014](?!\p{N})/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    return folded === "" ? raw.trim() : folded;
  };
  // A space, hyphen, dash, slash or parentheses between digits is one separator, written as a
  // hyphen, and the opening parenthesis of a group such as (317) before more digits goes. The
  // groups stay, so 1/12 never reads as 11/2.
  const groupDigits = (text: string) =>
    text
      .replace(/\((?=\p{N}+\)[\s/\-\u2010-\u2014]*\p{N})/gu, "")
      .replace(/(?<=\p{N})[\s/()\-\u2010-\u2014]+(?=\p{N})/gu, "-");
  // One word writes another short: same first letter, its letters in order in the other word,
  // and at most half as long when `halfLength` holds, three fifths otherwise.
  const shortens = (short: string, full: string, halfLength: boolean) => {
    const latin = /^\p{Script=Latin}+$/u.test(short + full);
    if (!latin || short[0] !== full[0]) return false;
    if (halfLength ? short.length * 2 > full.length : short.length * 5 > full.length * 3)
      return false;
    let next = 0;
    for (const letter of full) if (letter === short[next]) next++;
    return next === short.length;
  };
  // An email, domain or file name is a literal: none of its words reads as short for another. A
  // period before two letters marks one; an abbreviation's own periods, as in D.C., do not.
  const both = String(shown ?? "") + " " + String(wanted ?? "");
  const literal = /@|[\p{L}\p{N}]\.\p{L}{2}/u.test(both);
  // Words and numbers, a number keeping a period or comma between its digits and a word holding
  // a digit, such as 4b, staying one word, `mixed`. A number that follows another across
  // separators alone continues it, `joined`, and so does each group of three or more split by
  // periods alone, as in 555.123.4567. `plus` marks a number written after a plus sign.
  type Part = { text: string; number: boolean; mixed: boolean; joined: boolean; plus: boolean };
  const parts = (text: string) => {
    const folded = fold(text);
    const found: Part[] = [];
    let end = 0;
    for (const match of folded.matchAll(
      /(?:\p{N}+(?:[.,]\p{N}+)*|[\p{L}\p{M}\u200C\u200D]+)+/gu,
    )) {
      const gap = folded.slice(end, match.index);
      end = (match.index ?? 0) + match[0].length;
      const number = /^\p{N}+(?:[.,]\p{N}+)*$/u.test(match[0]);
      const mixed = !number && /\p{N}/u.test(match[0]);
      const previous = found[found.length - 1];
      const joined = number && previous?.number === true && /^[\s/()\-\u2010-\u2014]*$/u.test(gap);
      const groups = /^\p{N}+(?:\.\p{N}+){2,}$/u.test(match[0]) ? match[0].split(".") : [match[0]];
      groups.forEach((group, index) =>
        found.push({
          text: group,
          number,
          mixed,
          joined: joined || index > 0,
          plus: number && index === 0 && gap.endsWith("+"),
        }),
      );
    }
    return found;
  };
  // The site's version keeps each of the caller's words and numbers, in order. A number the
  // caller gave starts one of the site's with the same groups, one by one; a bare one of seven
  // digits or more, a phone or account number, may also be the site's whole number, grouped, as
  // 5551234567 is (555) 123-4567. What the site adds is a change, except a word of one or two
  // Latin letters between two of the caller's, a country code before a number, and one more
  // group after a postal code of five digits or more that ends the caller's value.
  const kept = (site: readonly Part[], given: readonly Part[]) => {
    const items: Part[][] = [];
    for (const part of given) {
      const last = items[items.length - 1];
      if (part.joined && last !== undefined) last.push(part);
      else items.push([part]);
    }
    // A country code: one to three digits after a plus sign, before the groups of a number.
    const country = (part: Part | undefined) =>
      part !== undefined && part.plus && !part.joined && /^\p{N}{1,3}$/u.test(part.text);
    const countryAt = (index: number) => country(site[index]) && site[index + 1]?.joined === true;
    // Whether a number starts at the site's part `index`, on its own or after a country code.
    const opens = (index: number) => site[index]?.joined === false || countryAt(index - 1);
    // The site writes a word short or in full, the short form at most three fifths as long. A
    // short form is two letters or more, and one that is the full word's start has two letters,
    // as St for Street, so Oak never stands for Oakwood, nor Main for Mainland.
    const sameWord = (there: string, typed: string) => {
      if (there === typed) return true;
      const [short, full] = there.length < typed.length ? [there, typed] : [typed, there];
      if (short.length < 2 || (short.length > 2 && full.startsWith(short))) return false;
      return shortens(short, full, false);
    };
    // The site writes a bare number with thousands commas, as 1,420 for 1420, or pads a group of
    // a grouped number with zeros, as 01/12 for 1/12.
    const sameNumber = (there: string, typed: string, grouped: boolean) => {
      if (there === typed) return true;
      if (!/^\p{N}+$/u.test(typed)) return false;
      if (grouped) {
        const padding = there.slice(0, there.length - typed.length);
        return there.length > typed.length && /^0+$/u.test(padding) && there.endsWith(typed);
      }
      return /^\p{N}{1,3}(?:,\p{N}{3})+$/u.test(there) && there.replace(/,/gu, "") === typed;
    };
    // How many of the site's parts from `start` the caller's item takes, or 0 when it does not
    // fit there.
    const fits = (item: readonly Part[], start: number): number => {
      const first = item[0];
      if (first === undefined || (first.number && !opens(start))) return 0;
      if (first.number && item.length === 1 && /^\p{N}{7,}$/u.test(first.text)) {
        let end = start + 1;
        while (site[end]?.joined === true) end++;
        const whole = site.slice(start, end).map((there) => there.text);
        if (end - start > 1 && whole.join("") === first.text) return end - start;
      }
      // A country code the caller typed may be left out, as 555-123-4567 for +1 555 123 4567,
      // when the site shows none.
      if (country(first) && item.length > 1 && !country(site[start]) && !countryAt(start - 1))
        return fits(item.slice(1), start);
      const all = item.every((part, offset) => {
        const there = site[start + offset];
        if (there === undefined || there.number !== part.number || there.mixed !== part.mixed)
          return false;
        if (part.number) {
          const grouped = item.length > 1;
          return (offset === 0 || there.joined) && sameNumber(there.text, part.text, grouped);
        }
        return part.mixed ? there.text === part.text : sameWord(there.text, part.text);
      });
      return all ? item.length : 0;
    };
    let at = 0;
    for (const [index, item] of items.entries()) {
      let start = at;
      let taken = 0;
      while (start < site.length && (taken = fits(item, start)) === 0) start++;
      if (taken === 0) return false;
      for (let added = at; added < start; added++) {
        const part = site[added];
        const inserted =
          index > 0 && part !== undefined && /^\p{Script=Latin}{1,2}$/u.test(part.text);
        if (!inserted && !(added === start - 1 && countryAt(added))) return false;
      }
      at = start + taken;
    }
    const last = items[items.length - 1];
    const postal = last?.length === 1 && /^\p{N}{5,}$/u.test(last[0]?.text ?? "");
    const extra = site.slice(at);
    return (
      extra.length === 0 ||
      (extra.length === 1 && postal && extra[0]?.joined === true && /^\p{N}+$/u.test(extra[0].text))
    );
  };
  if (options?.rewrite === true && !literal) {
    const given = parts(wanted);
    if (given.length > 0) return kept(parts(shown), given);
  }
  const a = groupDigits(fold(shown)).split(" ");
  const b = groupDigits(fold(wanted)).split(" ");
  return (
    a.length === b.length &&
    a.every(
      (word, index) => word === b[index] || (!literal && shortens(word, b[index] ?? "", true)),
    )
  );
};

/**
 * How much of `query`'s words each of `texts` holds, by BM25 (Okapi BM25 with k1 1.2 and b 0.75,
 * and Lucene's word weight), with `texts` as the set that weighs each word: a word few of them
 * hold counts for more. Each score is the text's BM25 score for the query over the query's own
 * score as a text, so a text holding every word of the query once and no other scores 1, it falls
 * as the query's words go missing or the text adds others, and 0 is a text sharing no word with
 * it. A text that repeats the query's words can score above 1, as "Smith Smith Smith" does for
 * Smith. Apart from the numbers rule below, ranking texts by it ranks them by plain BM25.
 *
 * Words are read as `foldChoiceText` reads names: case, accents, apostrophes and periods, commas
 * and hyphens between letters are ignored. A whole text that names one date, such as
 * "Nov 5, 2026", "5 November 2026", "2026-11-05" or "25/11/2026", is one word, that date, unless
 * its day and month could be either way round, as in "03/04/2026". A whole text of 7 to 15 digits
 * with only spaces, periods, hyphens, brackets and a leading +, other than a decimal number such
 * as 1500000.00 or 1234567.8, is one word, all its digits, so a phone or account number matches
 * however it is spaced, and 14155551234 never matches 4155551234. Thousands commas, a trailing .00
 * and currency symbols are dropped, so $1,250.00 matches 1250 and ¥1,500,000 matches 1500000. An
 * email, domain or file name, a word whose digits are joined by a slash, period or hyphen, such as
 * 1.5 or ACCT-0042, and a number with a sign before or after it, such as -5 or 5+, each stay one
 * word, so 12 never matches 123 or 1.2, 1234567.8 never matches 12345678, and 5 never matches -5.
 * A run of single letters is one word, so U.S.A. matches USA.
 *
 * Numbers must match exactly: a text whose words holding a digit, read as above, are not the
 * query's, the same ones in the same order, scores 0 whatever else it shares. So 125 Main St never
 * matches 123 Main St, 500000 never matches 300000, "Adults 2 Children 1" never matches
 * "Adults 1 Children 2", and "5 15" never matches 5. The words around them may move, so
 * "Main St 123" matches "123 Main St". Any other word counts only by its BM25 weight, so a
 * negation such as "not" or "non" is one more word.
 *
 * It is pure and self-contained, so page code can embed it.
 */
export const rankByWords = (query: string, texts: readonly string[]): number[] => {
  const months: Readonly<Record<string, number>> = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    sept: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };
  const weekdays: Readonly<Record<string, number>> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const monthOf = (name: string) => months[name] ?? months[name.slice(0, 3)] ?? 0;
  // The ISO date a whole text names, or "" for none, an impossible date or an unclear order.
  const dateOf = (text: string): string => {
    let rest = text.normalize("NFC").toLowerCase().replace(/,/gu, " ").replace(/\s+/gu, " ").trim();
    let weekday: number | undefined;
    const named = /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?\s+(.*)$/u.exec(rest);
    if (named !== null) {
      weekday = weekdays[named[1] ?? ""];
      rest = named[2] ?? "";
    }
    let year = 0;
    let month = 0;
    let day = 0;
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/u.exec(rest);
    const numeric = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/u.exec(rest);
    const monthFirst = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s+(\d{4})$/u.exec(rest);
    const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?\s+(\d{4})$/u.exec(rest);
    if (iso !== null) [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    else if (numeric !== null) {
      const first = Number(numeric[1]);
      const second = Number(numeric[2]);
      year = Number(numeric[3]);
      if (first > 12 && second <= 12) [day, month] = [first, second];
      else if ((second > 12 && first <= 12) || first === second) [month, day] = [first, second];
      else return "";
    } else if (monthFirst !== null && monthOf(monthFirst[1] ?? "") > 0)
      [month, day, year] = [monthOf(monthFirst[1] ?? ""), Number(monthFirst[2]), Number(monthFirst[3])];
    else if (dayFirst !== null && monthOf(dayFirst[2] ?? "") > 0)
      [day, month, year] = [Number(dayFirst[1]), monthOf(dayFirst[2] ?? ""), Number(dayFirst[3])];
    else return "";
    const at = new Date(Date.UTC(year, month - 1, day));
    if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return "";
    if (weekday !== undefined && at.getUTCDay() !== weekday) return "";
    return at.toISOString().slice(0, 10);
  };
  const foldCase = (word: string) =>
    word.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").normalize("NFC").toLowerCase();
  const foldName = (word: string) => {
    const folded = foldCase(word)
      .replace(/(?<!\p{N})['\u2018\u2019\u02bc](?!\p{N})/gu, "")
      .replace(/(?<!\p{N})[.,\-\u2010\u2011\u2012\u2013\u2014](?!\p{N})/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    return folded === "" ? word.trim() : folded;
  };
  const wordsOf = (text: string): string[] => {
    const raw = String(text ?? "")
      .replace(/[\u200B\u2060\uFEFF\u00AD]/gu, "")
      .replace(/[\s\u0085]+/gu, " ")
      .trim();
    const date = dateOf(raw);
    if (date !== "") return ["date:" + date];
    // A phone or account number is all its digits, the word a bare number or an amount also gives.
    // A decimal number keeps its point.
    if (/^[+\d\s().-]+$/u.test(raw) && !/^\d+\.\d+$/u.test(raw)) {
      const digits = raw.replace(/\D/gu, "");
      if (digits.length >= 7 && digits.length <= 15) return [digits];
    }
    const spaced = raw
      .replace(/(?<![\p{L}\p{N}])(\d{1,3}(?:,\d{3})+)(?!\p{N})/gu, (number) => number.replace(/,/gu, ""))
      .replace(/(?<![\p{N}.])(\d+)\.0{1,2}(?!\p{N})/gu, "$1")
      .replace(/[$\u20AC\u00A3\u00A5\u20B9]/gu, " ");
    const words: string[] = [];
    for (const piece of spaced.split(" ")) {
      const word = piece.replace(/^[("'\u2018\u201C[]+|[)"'\u2019\u201D\].,;:!?\u2026]+$/gu, "");
      if (word === "") continue;
      const literal =
        /@|[\p{L}\p{N}]\.\p{L}{2,}/u.test(word) ||
        (/\p{N}/u.test(word) && /^[+-]?[\p{L}\p{N}]+(?:[/.-][\p{L}\p{N}]+)+$/u.test(word)) ||
        /^[+-]\p{N}|\p{N}[+-]$/u.test(word);
      if (literal) words.push(foldCase(word));
      else words.push(...foldName(word).split(/[^\p{L}\p{N}\p{M}+#&%]+/u).filter(Boolean));
    }
    // A run of single letters, as in U.S.A., is one word.
    const joined: string[] = [];
    for (let at = 0; at < words.length; at++) {
      if (!/^\p{L}$/u.test(words[at] ?? "") || !/^\p{L}$/u.test(words[at + 1] ?? "")) {
        joined.push(words[at] ?? "");
        continue;
      }
      let run = "";
      while (/^\p{L}$/u.test(words[at] ?? "")) run += words[at++];
      joined.push(run);
      at--;
    }
    return joined;
  };
  const docs = texts.map(wordsOf);
  const asked = wordsOf(query);
  const k1 = 1.2;
  const b = 0.75;
  const holding = new Map<string, number>();
  let total = 0;
  for (const doc of docs) {
    total += doc.length;
    for (const word of new Set(doc)) holding.set(word, (holding.get(word) ?? 0) + 1);
  }
  const average = docs.length === 0 ? 1 : Math.max(total / docs.length, 1e-9);
  const weight = (word: string) => {
    const held = holding.get(word) ?? 0;
    return Math.log(1 + (docs.length - held + 0.5) / (held + 0.5));
  };
  const score = (doc: readonly string[]) => {
    if (asked.length === 0 || doc.length === 0) return 0;
    const counts = new Map<string, number>();
    for (const word of doc) counts.set(word, (counts.get(word) ?? 0) + 1);
    const norm = k1 * (1 - b + (b * doc.length) / average);
    let sum = 0;
    for (const word of asked) {
      const count = counts.get(word) ?? 0;
      if (count > 0) sum += (weight(word) * count * (k1 + 1)) / (count + norm);
    }
    return sum;
  };
  // The text's numbers, as read above, must be the query's: the same ones in the same order.
  const numbersOf = (words: readonly string[]) => words.filter((word) => /\p{N}/u.test(word));
  const numbers = numbersOf(asked);
  const sameNumbers = (doc: readonly string[]) => {
    const held = numbersOf(doc);
    return held.length === numbers.length && held.every((word, index) => word === numbers[index]);
  };
  const own = score(asked);
  return docs.map((doc) => (own === 0 || !sameNumbers(doc) ? 0 : score(doc) / own));
};

/**
 * Whether text read back from the page, `shown`, confirms `wanted`: `sameText(shown, wanted)`
 * holds, or `shown` holds enough of `wanted`'s words, a `rankByWords` score for `wanted` of 0.7 or
 * more with `shown` as the only text. `wanted` is the label of the option the tool picked when it
 * picked one, and the caller's value otherwise, since California never confirms a caller's CA
 * that the tool picked as California. Case, accents,
 * spacing and punctuation between letters are ignored either way. The second step accepts the
 * wanted words in another order and among other words: a one-word value is confirmed by text
 * that adds up to two words to it, and text that drops one of the wanted words is not, unless the
 * value has eleven words or more. So a wanted name inside a longer one, such as Lakeside in North
 * Lakeside, is confirmed. `shown` must hold the numbers `wanted` holds and no others, in the same
 * order: dates, phone numbers and amounts as `rankByWords` reads them, so 1,875 confirms 1875, and
 * other numbers the same, so 125 Main St never confirms 123 Main St and "5 15" never confirms 5.
 * It calls `sameText` and `rankByWords`, so page code that embeds it embeds those two first.
 */
export const readBackMatches = (shown: string, wanted: string): boolean =>
  sameText(shown, wanted) || (rankByWords(wanted, [shown])[0] ?? 0) >= 0.7;
