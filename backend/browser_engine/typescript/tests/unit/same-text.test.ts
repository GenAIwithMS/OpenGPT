import { expect, it } from "vitest";
import { sameText } from "../../src/runtime/text.js";

type Pairs = readonly (readonly [string, string])[];

/** Each pair gives the same answer in either order. */
const expectEach = (pairs: Pairs, same: boolean) => {
  for (const [shown, wanted] of pairs) {
    expect(sameText(shown, wanted), `${shown} | ${wanted}`).toBe(same);
    expect(sameText(wanted, shown), `${wanted} | ${shown}`).toBe(same);
  }
};

/** The page shows the short form and the caller wanted the full one: only that order matches. */
const expectShownShort = (pairs: Pairs) => {
  for (const [shown, wanted] of pairs) {
    expect(sameText(shown, wanted), `shown ${shown} | wanted ${wanted}`).toBe(true);
    expect(sameText(wanted, shown), `shown ${wanted} | wanted ${shown}`).toBe(false);
  }
};

it("ignores case, accents, spacing, apostrophes, and periods, commas and hyphens between letters", () => {
  expectEach(
    [
      ["Joe’s Café", "joes cafe"],
      ["  ABACÁ ", "abaca"],
      ["Crème Brûlée", "creme brulee"],
      ["St. Louis", "St Louis"],
      ["Saint-Denis", "saint denis"],
      ["Paris, France", "Paris France"],
    ],
    true,
  );
});

it("matches a word the page writes short when the wanted text has the full word", () => {
  expectShownShort([
    ["St-Jean", "Saint-Jean"],
    ["Ste-Marie", "Sainte-Marie"],
    ["ST-ÉTIENNE", "Saint-Etienne"],
    ["St. Louis", "Saint Louis"],
    ["12 Main St", "12 Main Street"],
    ["Apt 4B", "Apartment 4b"],
    ["Bd", "Boulevard"],
    ["Blvd", "Boulevard"],
    ["Mt", "Mount"],
    ["Ft", "Fort"],
    ["Ln", "Lane"],
    ["Hwy 1", "Highway 1"],
    ["Str", "Strasse"],
    ["TX", "Texas"],
    ["J Smith", "John Smith"],
    ["Wm", "William"],
  ]);
});

it("confirms a town the list writes short against the caller's spelling and the label picked", () => {
  expect(sameText("St-Exemple-sur-Lac", "Saint-Exemple-sur-Lac")).toBe(true);
  expect(sameText("St-Exemple-sur-Lac", "St-Exemple-sur-Lac")).toBe(true);
});

it("never matches a short wanted word against a longer word the page shows", () => {
  // Each pair is the caller's wanted text, then what the page shows.
  const pairs: Pairs = [
    ["USA", "Uzbekistan"],
    ["USA", "United States"],
    ["UAE", "Ukraine"],
    ["Ms", "Mr"],
    ["Ms", "Mrs"],
    ["Ms", "Miss"],
    ["Ms", "Dr"],
    ["Jon Lee", "Jonathan Lee"],
    ["Jo Smith", "John Smith"],
    ["Dan", "Duncan"],
    ["Pen", "Pencil"],
    ["XL", "XXXL"],
    ["5 m", "5 mm"],
    ["10 g", "10 gal"],
    ["j.smith@example.com", "jo.smith@example.com"],
    ["user@example.com", "user@example.community"],
    ["Row A", "Row AA"],
    ["York", "Yorkshire"],
    ["北京", "北京大学"],
  ];
  for (const [wanted, shown] of pairs)
    expect(sameText(shown, wanted), `shown ${shown} | wanted ${wanted}`).toBe(false);
});

it("reads no short form inside an email, domain or file name, or in a word outside Latin letters", () => {
  // Each pair is what the page shows, then the caller's wanted text.
  const pairs: Pairs = [
    ["j.smith@example.com", "jo.smith@example.com"],
    ["www.e.com", "www.example.com"],
    ["a.pdf", "annual.pdf"],
    ["Rpt 2024.pdf", "Receipt 2024.pdf"],
    ["a 2024.pdf", "annual 2024.pdf"],
    ["北京", "北京大学"],
    ["中国", "中国银行"],
    ["田中", "田中太郎"],
    ["Мск", "Москва"],
    ["क", "कमल"],
  ];
  for (const [shown, wanted] of pairs)
    expect(sameText(shown, wanted), `shown ${shown} | wanted ${wanted}`).toBe(false);
  // Latin letters beyond A to Z still read short.
  expect(sameText("Øst", "Østergade")).toBe(true);
  // An abbreviation's own periods, as in D.C. or U.S., leave short forms on.
  expect(sameText("100 Main Ave, Washington, D.C.", "100 Main Avenue, Washington, D.C.")).toBe(true);
  expect(sameText("U.S. Hwy 1", "U.S. Highway 1")).toBe(true);
});

it("drops characters that never show, as normalizeText does", () => {
  expect(sameText("St\u200B-Jean", "Saint-Jean")).toBe(true);
  expect(sameText("Jo\u00ADhn Smith", "\uFEFFJohn\u2060 Smith")).toBe(true);
});

it("still matches a page that shows a short word for a different longer wanted word, a known limit", () => {
  expect(sameText("Ms", "Miss")).toBe(true);
  expect(sameText("XL", "XXXL")).toBe(true);
});

it("needs the same number of words in the same order", () => {
  expectEach(
    [
      ["St-Jean", "St-Jean-de-Luz"],
      ["Smith John", "John Smith"],
      ["NY", "New York"],
      ["Le Mans", "Mans"],
      ["McDonald", "Mc Donald"],
      ["Acme Inc.", "Acme"],
      ["Paris, France", "Paris"],
    ],
    false,
  );
});

it("refuses a short word with a letter the full word lacks", () => {
  expectEach(
    [
      ["Ste-Foy", "Saint-Foy"],
      ["Ste", "St"],
    ],
    false,
  );
});

it("refuses a short word more than half as long, so similar names never match", () => {
  expectEach(
    [
      ["Jan", "Jean"],
      ["Jean", "Jeanne"],
      ["Dan", "Diane"],
      ["Bern", "Bergen"],
      ["Main St", "Martin St"],
      ["Lyon", "Lyons"],
      ["Paul", "Paula"],
      // Misses the guard costs: each fails loudly.
      ["Pkwy", "Parkway"],
      ["Ste", "Suite"],
      ["Robt", "Robert"],
      ["Hauptstr", "Hauptstraße"],
    ],
    false,
  );
});

it("needs a word holding a digit or another symbol to be the same word", () => {
  expectEach(
    [
      ["12 Main St", "123 Main Street"],
      ["10/04/2026", "10/14/2026"],
      ["$1,200", "$1,200.00"],
      ["1200", "1,200"],
      ["5", "-5"],
      ["1.5", "1-5"],
      ["5'10", "510"],
      ["5-", "5"],
      ["C++", "C"],
      ["C#", "C"],
      ["+", "&"],
      ["Blue/Green", "Blue Green"],
      ["(Gironde)", "Gironde"],
    ],
    false,
  );
  expectEach(
    [
      ["Apt 4B", "apt 4b"],
      ["$1,200", "$1,200"],
      ["-5", "-5"],
      ["Blue/Green", "blue/green"],
    ],
    true,
  );
});

/** The same digits in different groups: never the same value, in either mode. */
const regrouped: Pairs = [
  ["11/2/2025", "1/12/2025"],
  ["12/3", "1/23"],
  ["2025-1-12", "2025-11-2"],
  ["123 45th St", "12 345th St"],
  ["1 234", "12 34"],
];

/** Grouped digits, then the same digits bare: never the same value, in either mode. */
const grouped: Pairs = [
  ["3/4", "34"],
  ["10-12", "1012"],
  ["14-20", "1420"],
  ["29 59", "2959"],
  ["29-59", "2959"],
];

it("reads a space, hyphen, dash, slash or parentheses between digits as one separator", () => {
  expectEach(
    [
      ["29 59", "29-59"],
      ["29/59", "29 59"],
      ["29 – 59", "29 59"],
      ["46204-1234", "46204 1234"],
      ["(317) 555-1234", "317-555-1234"],
      ["Unit 29-59 Elm St", "unit 29 59 elm st"],
    ],
    true,
  );
  // The groups still count, and so do periods and commas between digits and every digit.
  expectEach(
    [
      ...regrouped,
      ...grouped,
      ["(555) 123-4567", "5551234567"],
      ["10.0", "100"],
      ["1,200", "1 200"],
      ["12", "123"],
      ["29 59", "29 58"],
      ["(12)", "12"],
    ],
    false,
  );
});

it("keeps words as they were by default, short forms and the half-length rule alike", () => {
  expect(sameText("UK", "Ukraine")).toBe(true);
  expect(sameText("Ukraine", "UK")).toBe(false);
  expect(sameText("12 Elm Pkwy", "12 Elm Parkway")).toBe(false);
  expect(sameText("Ste 4", "Suite 4")).toBe(false);
  expect(sameText("100 N Main St", "100 Main St")).toBe(false);
  expect(sameText("12 ELM ST", "12 Elm Street")).toBe(true);
});

/** The site rewrote what the tool typed: whether it kept everything the caller gave. */
const kept = (site: string, typed: string) => sameText(site, typed, { rewrite: true });

it("says a site's rewrite kept the typed value when it only reformatted, shortened or added", () => {
  const pairs: Pairs = [
    // Each pair is the site's version, then what the tool typed.
    ["29-59", "29 59"],
    ["29-59", "29/59"],
    ["12 ELM PKWY", "12 Elm Parkway"],
    ["STE 4", "Suite 4"],
    ["22 BIRCH CT", "22 Birch Court"],
    ["12 Elm Street", "12 Elm St"],
    ["46204-1234", "46204"],
    ["100 N Main St", "100 Main St"],
    ["(317) 555-1234", "317 555 1234"],
    // A short form at most three fifths as long as the word it stands for.
    ["100 Elm Trl", "100 Elm Trail"],
    ["100 Elm Rte", "100 Elm Route"],
    ["100 Elm Plz", "100 Elm Plaza"],
    ["100 Elm Rdg", "100 Elm Ridge"],
    ["100 Elm Blvd", "100 Elm Boulevard"],
    ["Apt 4", "Apartment 4"],
    [
      "12 Elm Pkwy, Ste 4, Springfield, IL 62704-0001",
      "12 elm parkway suite 4 springfield il 62704",
    ],
    ["USER@example.com", "user@example.com"],
    ["12 RUE DE L'EGLISE", "12 rue de l’Église"],
    // A word of one or two letters the site puts between two of the caller's, as a state.
    ["Springfield, IL 62704", "Springfield 62704"],
  ];
  for (const [site, typed] of pairs) expect(kept(site, typed), `${site} | ${typed}`).toBe(true);
});

it("says a site's rewrite only reformatted a word the caller gave that it wrote short or in full", () => {
  // Each pair is a site's version and what the tool typed, and holds in either order.
  const pairs: Pairs = [
    ["STE 5", "Suite 5"],
    ["12 ELM PKWY", "12 Elm Parkway"],
    ["12 ELM ST", "12 Elm Street"],
    ["1420 OAK RD", "1420 Oak Road"],
  ];
  for (const [one, other] of pairs) {
    expect(kept(one, other), `${one} | ${other}`).toBe(true);
    expect(kept(other, one), `${other} | ${one}`).toBe(true);
  }
});

it("says a site's rewrite changed a word it cut to, or wrote out from, its first three letters or more", () => {
  // Each pair is a site's version and what the tool typed, and is a change in either order.
  const pairs: Pairs = [
    ["100 Oak St", "100 Oakwood St"],
    ["100 Elm St", "100 Elmhurst St"],
    ["100 Ash St", "100 Ashford St"],
    ["100 Fox St", "100 Foxglove St"],
    ["Rob Smith", "Robert Smith"],
    ["Dan Smith", "Daniel Smith"],
    ["Kim Smith", "Kimberly Smith"],
    ["Pat Smith", "Patricia Smith"],
    ["100 Elm Ave", "100 Elm Avenue"],
    ["100 Elm Ter", "100 Elm Terrace"],
  ];
  for (const [one, other] of pairs) {
    expect(kept(one, other), `${one} | ${other}`).toBe(false);
    expect(kept(other, one), `${other} | ${one}`).toBe(false);
  }
});

it("says a site's rewrite only reformatted a phone number, a date or a count it wrote another way", () => {
  const pairs: Pairs = [
    // Each pair is the site's version, then what the tool typed.
    ["555.123.4567", "555-123-4567"],
    ["555-123-4567", "555.123.4567"],
    ["+1 (555) 123-4567", "555-123-4567"],
    ["+1 555 123 4567", "5551234567"],
    ["555-123-4567", "+1 555 123 4567"],
    ["01/12", "1/12"],
    ["2025-01-02", "2025-1-2"],
    ["1,420", "1420"],
    ["1,420,000", "1420000"],
  ];
  for (const [site, typed] of pairs) expect(kept(site, typed), `${site} | ${typed}`).toBe(true);
  // The same rules never read a decimal or a range as groups, nor take a dropped comma or zero.
  const changed: Pairs = [
    ["1.5", "1-5"],
    ["1-5", "1.5"],
    ["1420", "1,420"],
    ["14,20", "1420"],
    ["1/12", "01/12"],
    ["0123", "123"],
    ["+1 (555) 123-4567", "+44 (555) 123-4567"],
  ];
  for (const [site, typed] of changed) expect(kept(site, typed), `${site} | ${typed}`).toBe(false);
});

it("says a site's rewrite changed the typed value when it cut a word, guessed one or added its own", () => {
  const pairs: Pairs = [
    // Each pair is the site's version, then what the tool typed.
    // A word cut to its first four letters or more names another word, not a short form.
    ["1420 Lark Rd", "1420 Larkspur Road"],
    // An initial stands for too many words to be the caller's.
    ["100 M St", "100 Main St"],
    ["100 M L K Jr Blvd", "100 Martin Luther King Jr Blvd"],
    // A word the site wrote longer whose start is the caller's word of four letters or more.
    ["100 Mainland St", "100 Main St"],
    // A word holding a digit is the same word, or added by the site.
    ["Apt 4B", "Apt 4"],
    ["Apt 4 B", "Apt 4"],
    // A digit group added to a number that is not a postal code at the end.
    ["1420-2 Larkspur Rd", "1420 Larkspur Rd"],
    ["Unit 1420-2", "Unit 1420"],
    // A unit or a place the site added.
    ["100 Main St Ste 5", "100 Main St"],
    ["1420 Larkspur Rd Apt 2", "1420 Larkspur Rd"],
    ["1420 Larkspur Rd, Unit B, Springfield", "1420 Larkspur Rd, Springfield"],
    ["1420 Larkspur Rd, Springfield", "1420 Larkspur Rd"],
    ["1420 Larkspur Rd, Riverton, IL 62704", "1420 Larkspur Rd, IL 62704"],
    ["1420 Old Larkspur Rd", "1420 Larkspur Rd"],
    // A bare number the site grouped, too short to be a phone or account number.
    ["14-20", "1420"],
  ];
  for (const [site, typed] of pairs) expect(kept(site, typed), `${site} | ${typed}`).toBe(false);
});

it("says a site's rewrite changed the typed value when it dropped or changed what the caller gave", () => {
  const pairs: Pairs = [
    // Each pair is the site's version, then what the tool typed.
    ["1420 Oak Rd, Riverton", "1420 Oak Road, Springfield"],
    ["13 Elm Pkwy", "12 Elm Pkwy"],
    ["123", "12"],
    ["100", "10.0"],
    ["1200", "1,200"],
    ["100 Main St", "100 N Main St"],
    ["12 Elm", "12 Elm Pkwy"],
    ["Elm Pkwy 12", "12 Elm Pkwy"],
    // A number the site grouped differently, beyond a group it added at the end.
    ["4620-41234", "46204-1234"],
    ["2959", "29-59"],
    ["(555) 1234-567", "(555) 123-4567"],
    // A shorter word more than three fifths as long names another word, not a short form.
    ["100 Martin St", "100 Main St"],
    ["Marty Smith", "Mary Smith"],
    ["user@mail.example.com", "user@example.com"],
    ["Мск", "Москва"],
    ["12 Elm", ""],
    ["12 Elm", "-"],
  ];
  for (const [site, typed] of pairs) expect(kept(site, typed), `${site} | ${typed}`).toBe(false);
  for (const [one, other] of regrouped) {
    expect(kept(one, other), `${one} | ${other}`).toBe(false);
    expect(kept(other, one), `${other} | ${one}`).toBe(false);
  }
});

it("says a site kept a phone number typed bare that it grouped, but no shorter number and none it ungrouped", () => {
  for (const [site, typed] of grouped) {
    expect(kept(site, typed), `${site} | ${typed}`).toBe(false);
    expect(kept(typed, site), `${typed} | ${site}`).toBe(false);
  }
  expect(kept("(555) 123-4567", "5551234567")).toBe(true);
  expect(kept("5551234567", "(555) 123-4567")).toBe(false);
  expect(kept("Call (555) 123-4567 after 5", "call 5551234567 after 5")).toBe(true);
  expect(kept("(555) 123-4568", "5551234567")).toBe(false);
  expect(kept("555-123", "5551234567")).toBe(false);
});

it("folds only Latin accents, so a mark that spells another word in another script counts", () => {
  expectEach(
    [
      ["राम", "रमा"],
      ["कमल", "कोमल"],
      ["ขาว", "ข่าว"],
      ["バス", "パス"],
      // Letters that are not a base letter plus an accent stay as they are.
      ["Cœur", "Coeur"],
      ["Straße", "Strasse"],
      ["Øster", "Oster"],
      ["Łódź", "Lodz"],
    ],
    false,
  );
  expectEach(
    [
      ["Łódź", "Łodz"],
      ["Ñandú", "nandu"],
    ],
    true,
  );
});

it("keeps text of punctuation alone as it is, never blank", () => {
  expect(sameText("-", "-")).toBe(true);
  expectEach([["-", ""]], false);
  expectEach([["-", "  "]], false);
});

it("embeds as self-contained source, so page code can use it", () => {
  const embedded = new Function(`return ${String(sameText)};`)() as typeof sameText;
  expect(embedded("St-Jean", "Saint Jean")).toBe(true);
  expect(embedded("Saint Jean", "St-Jean")).toBe(false);
  expect(embedded("St-Jean", "St-Jean-de-Luz")).toBe(false);
  expect(embedded("29-59", "29 59")).toBe(true);
  expect(embedded("12 ELM PKWY", "12 Elm Parkway", { rewrite: true })).toBe(true);
  expect(embedded("13 ELM PKWY", "12 Elm Parkway", { rewrite: true })).toBe(false);
  expect(embedded("+1 (555) 123-4567", "555.123.4567", { rewrite: true })).toBe(true);
  expect(embedded("1420 Lark Rd Apt 2", "1420 Larkspur Road", { rewrite: true })).toBe(false);
});
