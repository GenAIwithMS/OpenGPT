import { runInThisContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { paginationCode } from "../../src/browser/pagination.js";

// The pager's pure readers of a results summary, run from the page code exactly as a Kernel call
// declares them. Each wording below is one that common table, grid and admin libraries render.

interface Parsed {
  readonly total: number | null;
  readonly approximate: boolean;
  readonly from?: number;
  readonly to?: number;
  readonly page?: number;
  readonly pages?: number;
}
interface Facts {
  readonly rows: number;
  readonly whole: boolean;
  readonly ended: boolean;
  readonly growing: boolean;
  readonly empty: boolean;
}

const { pagerParseSummary, pagerTrustedTotal } = runInThisContext(
  `(() => {\n${paginationCode}\nreturn { pagerParseSummary, pagerTrustedTotal };\n})()`,
) as {
  readonly pagerParseSummary: (text: string | null) => Parsed;
  readonly pagerTrustedTotal: (parsed: Parsed, facts: Facts) => number | null;
};

describe("a results summary", () => {
  it.each([
    ["Showing 1 to 10 of 57 entries", { from: 1, to: 10, total: 57 }],
    ["Showing 11 to 20 of 57 entries (filtered from 1,204 total entries)", { from: 11, to: 20, total: 57 }],
    ["1–25 of 312", { from: 1, to: 25, total: 312 }],
    ["1 to 100 of 8,618", { from: 1, to: 100, total: 8618 }],
    ["Results 21 - 30 of 1.204", { from: 21, to: 30, total: 1204 }],
    ["Showing 1 to 15 of 57 results", { from: 1, to: 15, total: 57 }],
    ["11-20 / 57", { from: 11, to: 20, total: 57 }],
    ["Items 41–45 of 45", { from: 41, to: 45, total: 45 }],
    ["Showing 0 to 0 of 0 entries", { from: 0, to: 0, total: 0 }],
    ["Showing 20 of 57 reviews", { from: 1, to: 20, total: 57 }],
    ["57 items", { total: 57 }],
    ["Total 85 items", { total: 85 }],
    ["3 120 results", { total: 3120 }],
    ["No results found", { total: 0 }],
  ])("reads %j", (text, expected) => {
    expect(pagerParseSummary(text)).toMatchObject({ ...expected, approximate: false });
  });

  it.each([
    "1–25 of more than 25",
    "1 to 100 of more",
    "About 1,230 results",
    "1-20 of 1,000+",
    "Over 500 items",
    "1–10 of about 2,000",
    "1-48 of over 3,000 results",
  ])("takes %j as no exact total", (text) => {
    expect(pagerParseSummary(text)).toMatchObject({ total: null, approximate: true });
  });

  it("reads a page count apart from the results range beside it", () => {
    expect(pagerParseSummary("1 to 20 of 45 | Page 1 of 3")).toMatchObject({
      from: 1,
      to: 20,
      total: 45,
      page: 1,
      pages: 3,
    });
    // A page count alone is no total of results.
    expect(pagerParseSummary("Page 2 of 10")).toMatchObject({ page: 2, pages: 10, total: null });
  });

  it("reads nothing from text that holds no count", () => {
    expect(pagerParseSummary("Sort by newest")).toEqual({ total: null, approximate: false });
    expect(pagerParseSummary(null)).toEqual({ total: null, approximate: false });
  });
});

describe("the total a segment reports", () => {
  const facts = (overrides: Partial<Facts>): Facts => ({
    rows: 10,
    whole: true,
    ended: false,
    growing: false,
    empty: false,
    ...overrides,
  });

  it("keeps a range that agrees with the rows shown", () => {
    expect(pagerTrustedTotal(pagerParseSummary("Showing 11 to 20 of 57"), facts({}))).toBe(57);
    expect(pagerTrustedTotal(pagerParseSummary("51 to 57 of 57"), facts({ rows: 7, ended: true }))).toBe(57);
  });

  it("drops a total the last page contradicts", () => {
    // The site counts 31 but its last page ends at 30.
    expect(pagerTrustedTotal(pagerParseSummary("21 to 30 of 31"), facts({ ended: true }))).toBeNull();
    // A range that claims more rows than the page shows.
    expect(pagerTrustedTotal(pagerParseSummary("21 to 31 of 31"), facts({ ended: true }))).toBeNull();
    expect(pagerTrustedTotal(pagerParseSummary("1 to 10 of 9"), facts({}))).toBeNull();
  });

  it("drops a growing list's total that its last rows contradict", () => {
    expect(pagerTrustedTotal(pagerParseSummary("40 results"), facts({ rows: 39, ended: true, growing: true }))).toBeNull();
    expect(pagerTrustedTotal(pagerParseSummary("40 results"), facts({ rows: 40, ended: true, growing: true }))).toBe(40);
    expect(pagerTrustedTotal(pagerParseSummary("Showing 20 of 40"), facts({ rows: 20, growing: true }))).toBe(40);
  });

  it("never reports an approximate total", () => {
    expect(pagerTrustedTotal(pagerParseSummary("1–25 of more than 25"), facts({ rows: 25 }))).toBeNull();
  });

  it("keeps a page only partly read", () => {
    expect(pagerTrustedTotal(pagerParseSummary("1 to 25 of 100"), facts({ rows: 5, whole: false }))).toBe(100);
  });
});
