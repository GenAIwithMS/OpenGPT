import { expect, it } from "vitest";
import { rankByWords, readBackMatches, sameText } from "../../src/browser/index.js";

it("scores 1 for text holding every word of the query, and 0 for text sharing none", () => {
  expect(rankByWords("Exemple Bay", ["Exemple Bay", "Bay Exemple", "Hillcrest"])).toEqual([1, 1, 0]);
  expect(rankByWords("Exemple Bay", [])).toEqual([]);
  expect(rankByWords("", ["Exemple Bay"])).toEqual([0]);
  expect(rankByWords("Exemple Bay", [""])).toEqual([0]);
});

it("scores above 1 a text that repeats the query's words", () => {
  expect(rankByWords("Smith", ["Smith Smith Smith"])[0]).toBeGreaterThan(1);
});

it("ranks the text that shares the most words above one that shares fewer or adds more", () => {
  const [whole, marina, exemple] = rankByWords("Exemple Bay", ["Exemple Bay", "Exemple Bay Marina", "Exemple"]);
  expect(whole ?? 0).toBeGreaterThan(marina ?? 0);
  expect(marina ?? 0).toBeGreaterThan(exemple ?? 0);
  expect(exemple ?? 0).toBeGreaterThan(0);
  // A word few texts hold counts for more than one every text holds.
  const [north, road] = rankByWords("Lakeside Park", ["North Lakeside", "Lakeside Park Road"]);
  expect(road ?? 0).toBeGreaterThan(north ?? 0);
});

it("reads words ignoring case, accents and punctuation between letters", () => {
  expect(rankByWords("ACME Café", ["acme cafe", "Acme-Cafe", "acme, café"])).toEqual([1, 1, 1]);
  expect(rankByWords("U.S.A.", ["USA"])).toEqual([1]);
  expect(rankByWords("Joe’s Diner", ["joes diner"])).toEqual([1]);
});

it("reads one date, one phone number or one amount however the page writes it", () => {
  expect(rankByWords("2026-11-05", ["Wed, Nov 4, 2026", "Thu, Nov 5, 2026", "5 November 2026", "Nov. 5th 2026"])).toEqual([
    0, 1, 1, 1,
  ]);
  expect(rankByWords("2026-11-25", ["11/25/2026", "25/11/2026", "25.11.2026"])).toEqual([1, 1, 1]);
  expect(rankByWords("(555) 010-0199", ["555.010.0199", "555 010 0199", "555 010 0198"])).toEqual([1, 1, 0]);
  expect(rankByWords("$1,250.00", ["1250", "1,250", "125"])).toEqual([1, 1, 0]);
  // A day and month order the text leaves open is no date, so it matches only as written.
  expect(rankByWords("03/04/2026", ["2026-03-04", "2026-04-03", "03/04/2026"])).toEqual([0, 0, 1]);
});

it("reads an amount of seven digits or more as its number, written bare or formatted", () => {
  expect(readBackMatches("¥1,500,000", "1500000")).toBe(true);
  expect(readBackMatches("1500000", "$1,500,000.00")).toBe(true);
  expect(readBackMatches("1500000.00", "€1,500,000")).toBe(true);
  expect(readBackMatches("Total 1500000", "1,500,000")).toBe(true);
  expect(rankByWords("1500000", ["¥1,500,000", "1,500,001", "15,000,000"])).toEqual([1, 0, 0]);
  // A phone or account number still matches however it is spaced, and only its own digits.
  expect(readBackMatches("5550100199", "(555) 010-0199")).toBe(true);
  expect(readBackMatches("+1 555 010 0199", "15550100199")).toBe(true);
  expect(readBackMatches("555 010 0198", "5550100199")).toBe(false);
});

it("keeps a number's decimal point and every one of its digits", () => {
  expect(readBackMatches("1234567.8", "12345678")).toBe(false);
  expect(readBackMatches("12345678", "1234567.8")).toBe(false);
  expect(readBackMatches("1,234,567.8", "12345678")).toBe(false);
  expect(readBackMatches("1234567.8", "1234567.8")).toBe(true);
  expect(readBackMatches("4155551234", "14155551234")).toBe(false);
  expect(readBackMatches("14155551234", "4155551234")).toBe(false);
  expect(readBackMatches("+1 (555) 010-0199", "(555) 010-0199")).toBe(false);
  expect(readBackMatches("1 555 010 0199", "15550100199")).toBe(true);
});

it("ignores characters that never show, and reads a combining accent as the letter's", () => {
  expect(rankByWords("Exemple Bay", ["Exem​ple Bay", "Ex­emple Bay", "Exemple⁠ Bay", "﻿Exemple Bay"])).toEqual([
    1, 1, 1, 1,
  ]);
  expect(rankByWords("Café", ["Café", "cafe"])).toEqual([1, 1]);
  expect(rankByWords("Exem​ple", ["Exemple", "Exem ple"])).toEqual([1, 0]);
});

it("keeps a number, an email, a domain or a file name as one word", () => {
  expect(rankByWords("12", ["123", "1.2", "12"])).toEqual([0, 0, 1]);
  expect(rankByWords("-5", ["5", "+5", "-5"])).toEqual([0, 0, 1]);
  expect(rankByWords("5-", ["5", "5-"])).toEqual([0, 1]);
  expect(rankByWords("jo.smith@example.com", ["j.smith@example.com", "jo smith example com"])).toEqual([0, 0]);
  expect(rankByWords("report-2024.pdf", ["report 2024 pdf"])).toEqual([0]);
});

it("scores 0 a text whose numbers are not the query's, whatever else it shares", () => {
  expect(rankByWords("Order 1250", ["Order 1251", "Order 1250 shipped"])).toEqual([0, expect.any(Number)]);
  // Four of five words shared would pass on words alone; the changed house number fails it.
  expect(rankByWords("Jane Exemple 42 Elm Street Hillcrest", ["Jane Exemple 44 Elm Street Hillcrest"])).toEqual([0]);
  expect(rankByWords("2026-11-05", ["Nov 5, 2027"])).toEqual([0]);
  // A text may not hold a number the query lacks.
  expect(rankByWords("Elm Street", ["42 Elm Street"])).toEqual([0]);
});

it("refuses a saved value with the caller's numbers in another order, or with one more or fewer", () => {
  expect(rankByWords("Adults 1 Children 2", ["Adults 2 Children 1", "Adults 1 Children 2"])).toEqual([0, 1]);
  expect(readBackMatches("Adults 2 Children 1", "Adults 1 Children 2")).toBe(false);
  expect(readBackMatches("3 Oak St Apt 12", "12 Oak St Apt 3")).toBe(false);
  expect(readBackMatches("5 15", "5")).toBe(false);
  expect(readBackMatches("5", "5 15")).toBe(false);
  expect(readBackMatches("5 5", "5")).toBe(false);
  // The words around the numbers may still move.
  expect(readBackMatches("Oak St 12, Apt 3", "12 Oak St Apt 3")).toBe(true);
});

it("embeds as self-contained source, so page code can use it", () => {
  const embedded = new Function(`return ${String(rankByWords)};`)() as typeof rankByWords;
  expect(embedded("Exemple Bay", ["Exemple Bay Marina", "Hillcrest"])).toEqual(
    rankByWords("Exemple Bay", ["Exemple Bay Marina", "Hillcrest"]),
  );
});

it("confirms whatever sameText confirms, the short-word rule included", () => {
  for (const [shown, wanted] of [
    ["St-Exemple-sur-Lac", "Saint-Exemple-sur-Lac"],
    ["Joe’s Café", "joes cafe"],
    ["Blvd Exemple", "Boulevard Exemple"],
  ] as const) {
    expect(sameText(shown, wanted), `${shown} | ${wanted}`).toBe(true);
    expect(readBackMatches(shown, wanted), `${shown} | ${wanted}`).toBe(true);
  }
  // BM25 alone misses this one, since St and Saint are different words.
  expect(rankByWords("Saint-Exemple-sur-Lac", ["St-Exemple-sur-Lac"])[0]).toBeLessThan(0.7);
});

it("confirms a saved value that differs only in format or word order", () => {
  expect(readBackMatches("Bay Exemple", "Exemple Bay")).toBe(true);
  expect(readBackMatches("Exemple, Jane", "Jane Exemple")).toBe(true);
  expect(readBackMatches("Main St 123", "123 Main St")).toBe(true);
  expect(readBackMatches("1,875", "1875")).toBe(true);
  expect(readBackMatches("1,875 sq ft", "1875")).toBe(true);
  expect(readBackMatches("$300,000.00", "300000")).toBe(true);
  expect(readBackMatches("Thu, Nov 5, 2026", "2026-11-05")).toBe(true);
  expect(readBackMatches("(555) 010-0199", "555.010.0199")).toBe(true);
  expect(readBackMatches("Exemple Bay Marina", "Exemple Bay")).toBe(true);
  // A wanted name inside a longer one is a known limit: it confirms.
  expect(readBackMatches("North Lakeside", "Lakeside")).toBe(true);
});

it("refuses a saved value with any number other than the caller's", () => {
  expect(readBackMatches("125 Main St", "123 Main St")).toBe(false);
  expect(readBackMatches("500000", "300000")).toBe(false);
  expect(readBackMatches("$500,000", "300000")).toBe(false);
  expect(readBackMatches("1,460", "1875")).toBe(false);
  expect(readBackMatches("1460 sq ft", "1,875")).toBe(false);
  expect(readBackMatches("Jane Exemple, 44 Elm Street, Hillcrest", "Jane Exemple, 42 Elm Street, Hillcrest")).toBe(
    false,
  );
  // A long value sharing every other word would pass on words alone.
  const house = (feet: string) => `Two storey brick house with slate roof, detached garage and ${feet} square feet`;
  expect(readBackMatches(house("1460"), house("1875"))).toBe(false);
  expect(readBackMatches(house("1,875"), house("1875"))).toBe(true);
});

it("ignores case on both of its steps", () => {
  expect(readBackMatches("EXEMPLE BAY", "exemple bay")).toBe(true);
  // sameText refuses a word added, so only the BM25 step can confirm these.
  expect(sameText("ACME INSURANCE GROUP", "acme")).toBe(false);
  expect(readBackMatches("ACME INSURANCE GROUP", "acme")).toBe(true);
  expect(readBackMatches("acme insurance group", "ACME")).toBe(true);
  expect(readBackMatches("BAY EXEMPLE", "exemple bay")).toBe(true);
});

it("confirms the wanted words among a few words more, and refuses them among more", () => {
  // One wanted word confirms with two words added, and not with three.
  expect(readBackMatches("Acme Insurance Group", "Acme")).toBe(true);
  expect(readBackMatches("Acme Insurance Group Ltd", "Acme")).toBe(false);
  // Four wanted words confirm among eleven more, and not among twelve.
  const words = (count: number) =>
    Array.from({ length: count }, (_, index) => `extra${String.fromCharCode(97 + index)}`).join(" ");
  const wanted = "alpha beta gamma delta";
  expect(readBackMatches(`${wanted} ${words(11)}`, wanted)).toBe(true);
  expect(readBackMatches(`${wanted} ${words(12)}`, wanted)).toBe(false);
});

it("refuses text that drops a wanted word or names another value", () => {
  expect(readBackMatches("Lakeside", "North Lakeside")).toBe(false);
  expect(readBackMatches("Hillcrest", "Exemple Bay")).toBe(false);
  expect(readBackMatches("Order 1251", "Order 1250")).toBe(false);
  expect(readBackMatches("12", "123")).toBe(false);
  expect(readBackMatches("Wed, Nov 4, 2026", "2026-11-05")).toBe(false);
  expect(readBackMatches("j.smith@example.com", "jo.smith@example.com")).toBe(false);
});
