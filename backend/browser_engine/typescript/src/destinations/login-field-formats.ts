import { formatDate } from "../browser/form-controls.js";
import { DateOfBirthFormat } from "./autofill-contracts.js";

/** A date of birth an owner typed, year first, as the ISO date a record keeps; undefined if none. */
export const parseDateOfBirth = (value: string): string | undefined => {
  const parts = /^\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s*$/u.exec(value);
  if (parts === null) return undefined;
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return undefined;
  return date.toISOString().slice(0, 10);
};
/** The formats that write the whole date, rather than one part of a split date. */
const wholeDates = DateOfBirthFormat.literals.filter(
  (format) => format.includes("Y") && format.includes("M") && format.includes("D"),
);
/**
 * An ISO date of birth in each whole-date layout a page may show it in, which masking registers;
 * never one part alone, such as a month's "4", which is no secret to mask everywhere.
 */
export const wholeDateLayouts = (iso: string) =>
  parseDateOfBirth(iso) === undefined
    ? []
    : [...new Set(wholeDates.map((format) => formatDate(iso, format)))];
