import { expect, it } from "vitest";
import { citesCallerRequest } from "../../src/mint/caller-citation.js";

/*
 * A caller_input ending's basis: its intent cites the caller's request, by a field name its input
 * holds or by words of its instruction, never by a value alone.
 */

const request = "List every open order, and stop if the account number does not match the export.";
const input = { accounts: [{ accountNumber: "A-77", lines: [{ unit_price: 4 }] }] };

it.each([
  ["a nested field in camelCase", "accountNumber is missing from the export"],
  ["a field inside an array, written in words", "The unit price conflicts with its source."],
  ["four words of the instruction in a row", "The request says: stop if the account number does not match."],
  ["a whole short instruction", "Asked to export it all, nothing more."],
])("takes %s", (_name, intent) => {
  const text = intent.startsWith("Asked") ? "Export it all" : request;
  expect(citesCallerRequest(intent, text, input)).toBe(true);
});

it.each([
  ["no intent", undefined],
  ["words the request never says", "The data looks inconsistent, so the build stops."],
  ["a value but no field", "A-77 is wrong."],
  ["three words of the instruction", "It should stop if the totals change."],
])("refuses %s", (_name, intent) => {
  expect(citesCallerRequest(intent, request, input)).toBe(false);
});
