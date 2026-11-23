import { readBackMatches } from "./text.js";

/** A caller value the site holds differently after a save: `shown` is left out when it shows none. */
export interface SavedValueDifference<Field extends string = string> {
  readonly field: Field;
  readonly wanted: string;
  readonly shown?: string;
}

/**
 * Saves one page of a form saved over several pages and reads back each value of `wanted` from
 * what the site stored. `wanted` holds each field the site shows for the caller's values: the
 * label of the option the tool picked when it picked one, such as California for a caller's CA,
 * and the caller's value otherwise. `save` fills the page with the same entries and saves it,
 * behind its commit mark. Use it only for a save that updates the same record or page, never one
 * that adds an item, such as a cart line or a row, since its second save would add another.
 * `read` reads what the site saved for each field, from a summary, a review page or the saved
 * page, with null or no entry for a field it no longer shows, which counts as differing.
 * Each field is compared with `readBackMatches`. When one differs, it saves once more and reads
 * back again, and never saves a third time. It returns the fields that still differ, in `wanted`'s
 * order, empty when the site kept every value, so the tool stops before its final commit and
 * reports them. A save or read that throws ends it with that error.
 */
export const saveAndReadBack = async <Field extends string>(options: {
  readonly save: () => Promise<unknown>;
  readonly read: () => Promise<Partial<Readonly<Record<Field, string | number | null | undefined>>>>;
  readonly wanted: Readonly<Record<Field, string | number>>;
}): Promise<readonly SavedValueDifference<Field>[]> => {
  const differences = async (): Promise<readonly SavedValueDifference<Field>[]> => {
    const shown = await options.read();
    return (Object.keys(options.wanted) as Field[]).flatMap((field) => {
      const wanted = String(options.wanted[field]);
      const read = shown[field];
      if (read === undefined || read === null) return [{ field, wanted }];
      return readBackMatches(String(read), wanted) ? [] : [{ field, wanted, shown: String(read) }];
    });
  };
  await options.save();
  const first = await differences();
  if (first.length === 0) return first;
  await options.save();
  return differences();
};
