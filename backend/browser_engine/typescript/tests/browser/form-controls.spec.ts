import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { formControlsCode } from "../../src/browser/form-controls.js";
import { sameText } from "../../src/runtime/text.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";

// The authoring library's date and dropdown helpers, run as a Kernel call body runs them (`page` in
// scope) on local fixture pages, one per control shape. Chromium must generate the events: the
// custom dropdowns open, filter and commit only from real clicks, typing and scrolling.
const call = async (page: Page, body: string) => {
  const answer = await makeLocalKernel(page).browsers.playwright.execute("session-1", {
    timeout_sec: 10,
    code: `${formControlsCode}\n${body}`,
  });
  return answer.success ? { result: answer.result } : { error: answer.error };
};

/** What the page's form would submit. */
const submitted = (page: Page) =>
  page.evaluate(() => {
    const form = document.forms[0];
    return form === undefined ? {} : Object.fromEntries(new FormData(form));
  });

const dateOfBirth = "1990-07-04";

/**
 * A custom dropdown: a button that owns a listbox through aria-controls, rendered when opened,
 * which commits a click into the button's text and a hidden input. `virtual` renders ten options
 * at a time as the listbox scrolls; `filter` is an editable combobox whose options follow typing.
 */
const dropdown = (
  name: string,
  options: readonly (readonly [string, string])[],
  mode: "plain" | "virtual" | "filter" = "plain",
) => `
<div class="dropdown" data-name="${name}">
  ${
    mode === "filter"
      ? `<input role="combobox" aria-label="${name}" aria-expanded="false" aria-controls="${name}-list" autocomplete="off">`
      : `<button type="button" aria-label="${name}" aria-haspopup="listbox" aria-expanded="false" aria-controls="${name}-list">Select</button>`
  }
  <input type="hidden" name="${name}">
  <div role="listbox" id="${name}-list" hidden style="max-height:100px;overflow:auto"></div>
</div>
<script>
(() => {
  const root = document.querySelector('[data-name="${name}"]');
  const control = root.querySelector('[aria-controls]');
  const list = root.querySelector('[role=listbox]');
  const hidden = root.querySelector('input[type=hidden]');
  const all = ${JSON.stringify(options)};
  const mode = ${JSON.stringify(mode)};
  let shown = 10;
  const render = () => {
    const query = mode === "filter" ? control.value.toLowerCase() : "";
    // A filtering dropdown lists nothing until something is typed.
    const visible = mode === "filter" && query === "" ? [] : all.filter(([, label]) => label.toLowerCase().startsWith(query)).slice(0, mode === "virtual" ? shown : all.length);
    // Options arrive a moment after the page asks for them, as from a server.
    setTimeout(() => {
      list.innerHTML = visible.map(([value, label]) => '<div role="option" style="height:20px" data-value="' + value + '">' + label + '</div>').join("");
    }, 30);
  };
  const open = () => { list.hidden = false; control.setAttribute("aria-expanded", "true"); render(); };
  control.addEventListener("click", open);
  if (mode === "filter") control.addEventListener("input", () => { if (list.hidden) open(); else render(); });
  list.addEventListener("scroll", () => {
    if (mode === "virtual" && list.scrollTop + list.clientHeight >= list.scrollHeight - 5 && shown < all.length) { shown += 10; render(); }
  });
  list.addEventListener("click", (event) => {
    const option = event.target.closest("[role=option]");
    if (!option) return;
    hidden.value = option.dataset.value;
    if (mode === "filter") control.value = option.textContent; else control.textContent = option.textContent;
    list.hidden = true;
    control.setAttribute("aria-expanded", "false");
  });
})();
</script>`;

const months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

for (const [format, typed] of [
  ["MM/DD/YYYY", "07/04/1990"],
  ["DD/MM/YYYY", "04/07/1990"],
  ["YYYY-MM-DD", "1990-07-04"],
  ["MMDDYYYY", "07041990"],
  ["DD.MM.YYYY", "04.07.1990"],
  ["MMMM D, YYYY", "July 4, 1990"],
] as const)
  test(`fillDate writes ${format} into a text box`, async ({ page }) => {
    await page.setContent(
      `<form><label>Date of birth<input name="dob" placeholder="${format}"></label></form>`,
    );
    const filled = await call(
      page,
      `return await fillDate(page.getByLabel("Date of birth"), ${JSON.stringify(dateOfBirth)}, ${JSON.stringify(format)});`,
    );
    expect(filled).toEqual({ result: { shape: "text" } });
    expect(await submitted(page)).toEqual({ dob: typed });
  });

test("fillDate fills a native date input with the ISO date, whatever the format", async ({
  page,
}) => {
  await page.setContent(`<form><label>Date of birth<input type="date" name="dob"></label></form>`);
  const filled = await call(
    page,
    `return await fillDate(page.getByLabel("Date of birth"), "1990-07-04", "MM/DD/YYYY");`,
  );
  expect(filled).toEqual({ result: { shape: "date" } });
  expect(await submitted(page)).toEqual({ dob: "1990-07-04" });
});

test("fillDate types into a masked field that rewrites what is filled at once", async ({
  page,
}) => {
  // The mask keeps digits only as they are typed one by one, adding its own slashes; a value set
  // in one go is cleared.
  await page.setContent(`<form><label>Date of birth<input name="dob" maxlength="10"></label></form>
<script>
const field = document.querySelector("input");
let digits = "";
field.addEventListener("keydown", (event) => {
  event.preventDefault();
  if (/^\\d$/.test(event.key) && digits.length < 8) digits += event.key;
  field.value = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean).join("/");
});
field.addEventListener("input", () => { if (field.value.replace(/\\D/g, "") !== digits) field.value = ""; });
</script>`);
  const filled = await call(
    page,
    `return await fillDate(page.getByLabel("Date of birth"), "1990-07-04", "MM/DD/YYYY");`,
  );
  expect(filled).toEqual({ result: { shape: "text" } });
  expect(await submitted(page)).toEqual({ dob: "07/04/1990" });
});

test("fillDate fills split month, day and year text boxes", async ({ page }) => {
  await page.setContent(`<form><fieldset><legend>Date of birth</legend>
<label>Month<input name="month" maxlength="2"></label>
<label>Day<input name="day" maxlength="2"></label>
<label>Year<input name="year" maxlength="4"></label></fieldset></form>`);
  const filled = await call(
    page,
    `const iso = "1990-07-04";
return [
  await fillDate(page.getByLabel("Month"), iso, "MM"),
  await fillDate(page.getByLabel("Day"), iso, "DD"),
  await fillDate(page.getByLabel("Year"), iso, "YYYY"),
];`,
  );
  expect(filled).toEqual({ result: [{ shape: "text" }, { shape: "text" }, { shape: "text" }] });
  expect(await submitted(page)).toEqual({ month: "07", day: "04", year: "1990" });
});

test("fillDate chooses month, day and year in native selects by name or number", async ({
  page,
}) => {
  // Month values count from zero, so only the names tell July; days are unpadded; a placeholder
  // option leads each list.
  const monthOptions = months.map((name, index) => `<option value="${index}">${name}</option>`);
  const dayOptions = Array.from({ length: 31 }, (_, index) => `<option>${index + 1}</option>`);
  const yearOptions = Array.from({ length: 100 }, (_, index) => `<option>${2025 - index}</option>`);
  await page.setContent(`<form>
<label>Month<select name="month"><option value="">Month</option>${monthOptions.join("")}</select></label>
<label>Day<select name="day"><option value="">Day</option>${dayOptions.join("")}</select></label>
<label>Year<select name="year"><option value="">Year</option>${yearOptions.join("")}</select></label></form>`);
  const filled = await call(
    page,
    `const iso = "1990-07-04";
return [
  await fillDate(page.getByLabel("Month"), iso, "MM"),
  await fillDate(page.getByLabel("Day"), iso, "DD"),
  await fillDate(page.getByLabel("Year"), iso, "YYYY"),
];`,
  );
  expect(filled).toEqual({
    result: [{ shape: "select" }, { shape: "select" }, { shape: "select" }],
  });
  expect(await submitted(page)).toEqual({ month: "6", day: "4", year: "1990" });
});

test("fillDate chooses a month and a day in custom dropdowns", async ({ page }) => {
  // The month list shows short names and the day list ordinals.
  const monthList = months.map((name, index) => [String(index + 1), name.slice(0, 3)] as const);
  const ordinal = (day: number) =>
    `${day}${day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th"}`;
  const dayList = Array.from(
    { length: 31 },
    (_, index) => [String(index + 1), ordinal(index + 1)] as const,
  );
  await page.setContent(`<form>${dropdown("Month", monthList)}${dropdown("Day", dayList)}</form>`);
  const filled = await call(
    page,
    `const iso = "1990-07-04";
return [
  await fillDate(page.getByRole("button", { name: "Month" }), iso, "MM"),
  await fillDate(page.getByRole("button", { name: "Day" }), iso, "DD"),
];`,
  );
  expect(filled).toEqual({ result: [{ shape: "combobox" }, { shape: "combobox" }] });
  expect(await submitted(page)).toEqual({ Month: "7", Day: "4" });
});

test("fillDate scrolls a custom year dropdown that renders its options as it scrolls", async ({
  page,
}) => {
  const yearList = Array.from({ length: 40 }, (_, index) => {
    const year = String(2025 - index);
    return [year, year] as const;
  });
  await page.setContent(`<form>${dropdown("Year", yearList, "virtual")}</form>`);
  const filled = await call(
    page,
    `return await fillDate(page.getByRole("button", { name: "Year" }), "1990-07-04", "YYYY");`,
  );
  expect(filled).toEqual({ result: { shape: "combobox" } });
  expect(await submitted(page)).toEqual({ Year: "1990" });
});

test("chooseOption picks one option by any of its spellings in a native select", async ({
  page,
}) => {
  await page.setContent(`<form><label>State<select name="state">
<option value="">Choose</option><option value="CA">California</option><option value="NV">Nevada</option>
<option value="OR" disabled>Oregon</option></select></label></form>`);
  const state = 'page.getByLabel("State")';
  expect(await call(page, `return await chooseOption(${state}, ["California", "CA"]);`)).toEqual({
    result: { shape: "select", label: "California", value: "CA" },
  });
  expect(await submitted(page)).toEqual({ state: "CA" });
  // A value alone names it; a disabled or missing option is refused and changes nothing.
  expect(await call(page, `return await chooseOption(${state}, "NV");`)).toMatchObject({
    result: { value: "NV" },
  });
  expect(await call(page, `return await chooseOption(${state}, "Oregon");`)).toMatchObject({
    error: "option_disabled",
  });
  expect(await call(page, `return await chooseOption(${state}, "Texas");`)).toMatchObject({
    error: "option_missing",
  });
  expect(await submitted(page)).toEqual({ state: "NV" });
});

test("chooseOption refuses two different options that both match", async ({ page }) => {
  await page.setContent(`<form><label>Plan<select name="plan">
<option value="a">Basic monthly</option><option value="b">Basic yearly</option></select></label></form>`);
  expect(await call(page, `return await chooseOption(page.getByLabel("Plan"), "basic");`)).toEqual({
    error: "option_ambiguous",
  });
  expect(await submitted(page)).toEqual({ plan: "a" });
});

test("chooseOption types into a dropdown that filters as you type", async ({ page }) => {
  const countries = ["Canada", "Chile", "China", "France", "Germany"].map(
    (name) => [name.slice(0, 2).toUpperCase(), name] as const,
  );
  await page.setContent(`<form>${dropdown("Country", countries, "filter")}</form>`);
  expect(
    await call(page, `return await chooseOption(page.getByLabel("Country"), "Chile");`),
  ).toEqual({ result: { shape: "combobox", label: "Chile", value: "CH" } });
  expect(await submitted(page)).toEqual({ Country: "CH" });
});

test("chooseOption matches a name whatever its apostrophe style", async ({ page }) => {
  await page.setContent(`<form><label>Shop<select name="shop">
<option value="">Choose</option><option value="1">Joe’s Bakery</option><option value="2">Anaʼs Market</option>
</select></label></form>`);
  const shop = 'page.getByLabel("Shop")';
  expect(await call(page, `return await chooseOption(${shop}, "Joe's Bakery");`)).toEqual({
    result: { shape: "select", label: "Joe’s Bakery", value: "1" },
  });
  expect(await call(page, `return await chooseOption(${shop}, "ana‘s market");`)).toMatchObject({
    result: { value: "2" },
  });
  expect(await submitted(page)).toEqual({ shop: "2" });
});

const places = `<form><label>Place<select name="place">
<option value="">Choose</option><option value="1">Abacá</option><option value="2">St. Louis</option>
<option value="3">Lyon</option></select></label></form>`;

test("chooseOption matches a name whatever its accents", async ({ page }) => {
  await page.setContent(places);
  expect(await call(page, `return await chooseOption(page.getByLabel("Place"), "Abaca");`)).toEqual({
    result: { shape: "select", label: "Abacá", value: "1" },
  });
  expect(await submitted(page)).toEqual({ place: "1" });
});

test("chooseOption matches a name with or without its periods", async ({ page }) => {
  await page.setContent(places);
  expect(
    await call(page, `return await chooseOption(page.getByLabel("Place"), "St Louis");`),
  ).toEqual({ result: { shape: "select", label: "St. Louis", value: "2" } });
  expect(await submitted(page)).toEqual({ place: "2" });
});

test("chooseOption matches a hyphenated name spelled with a space", async ({ page }) => {
  const cities = [
    ["SD", "Saint-Denis"],
    ["SE", "Saint-Étienne"],
    ["LY", "Lyon"],
  ] as const;
  await page.setContent(`<form>${dropdown("City", cities)}</form>`);
  expect(
    await call(page, `return await chooseOption(page.getByLabel("City"), "Saint Denis");`),
  ).toEqual({ result: { shape: "combobox", label: "Saint-Denis", value: "SD" } });
  expect(await submitted(page)).toEqual({ City: "SD" });
});

test("chooseOption refuses two options that differ only by accents", async ({ page }) => {
  await page.setContent(`<form><label>Place<select name="place">
<option value="1">Abaca</option><option value="2">Abacá</option></select></label></form>`);
  expect(await call(page, `return await chooseOption(page.getByLabel("Place"), "Abaca");`)).toEqual({
    error: "option_ambiguous",
  });
  expect(await submitted(page)).toEqual({ place: "1" });
});

test("chooseOption picks the one label that holds the whole phrase", async ({ page }) => {
  await page.setContent(`<form><label>Customer<select name="customer">
<option value="">Choose</option><option value="7">Acme insurance Customer</option>
<option value="8">Acme Bank Customer</option></select></label></form>`);
  const customer = 'page.getByLabel("Customer")';
  expect(await call(page, `return await chooseOption(${customer}, "Acme insurance");`)).toEqual({
    result: { shape: "select", label: "Acme insurance Customer", value: "7" },
  });
  // Only whole words count: part of a word matches nothing.
  expect(await call(page, `return await chooseOption(${customer}, "Acme insur");`)).toEqual({
    error: "option_missing",
  });
  expect(await submitted(page)).toEqual({ customer: "7" });
});

test("chooseOption refuses two labels that both hold the phrase", async ({ page }) => {
  await page.setContent(`<form><label>Customer<select name="customer">
<option value="">Choose</option><option value="7">Acme insurance Customer</option>
<option value="9">Acme insurance Vendor</option></select></label></form>`);
  expect(
    await call(page, `return await chooseOption(page.getByLabel("Customer"), "Acme insurance");`),
  ).toEqual({ error: "option_ambiguous" });
  expect(await submitted(page)).toEqual({ customer: "" });
});

// Symbols such as +, # and & are part of a name, so a name never loses them to match a label.
for (const [wanted, labels] of [
  ["C++", ["C", "Java"]],
  ["C#", ["C"]],
  ["+", ["&"]],
  // main gives option_missing here too: the label's words drop its symbols.
  ["C++", ["C++ Developer", "Java"]],
] as const)
  test(`chooseOption finds no option for ${wanted} among ${labels.join(", ")}`, async ({ page }) => {
    const options = labels.map((label, index) => `<option value="${index + 1}">${label}</option>`);
    await page.setContent(`<form><label>Skill<select name="skill">
<option value="">Choose</option>${options.join("")}</select></label></form>`);
    expect(
      await call(page, `return await chooseOption(page.getByLabel("Skill"), ${JSON.stringify(wanted)});`),
    ).toEqual({ error: "option_missing" });
    expect(await submitted(page)).toEqual({ skill: "" });
  });

test("chooseOption still picks a label that holds the name as a word between symbols", async ({
  page,
}) => {
  await page.setContent(`<form><label>Size<select name="size">
<option value="">Choose</option><option value="m">Size (M)</option><option value="l">Size (L)</option>
</select></label><label>Color<select name="color">
<option value="">Choose</option><option value="bg">Blue/Green</option><option value="r">Red</option>
</select></label><label>Month<select name="month">
<option value="">Choose</option><option value="7">Month: July</option><option value="6">Month: June</option>
</select></label></form>`);
  expect(await call(page, `return await chooseOption(page.getByLabel("Size"), "M");`)).toMatchObject(
    { result: { label: "Size (M)", value: "m" } },
  );
  expect(
    await call(page, `return await chooseOption(page.getByLabel("Color"), "Blue");`),
  ).toMatchObject({ result: { label: "Blue/Green", value: "bg" } });
  expect(
    await call(page, `return await chooseOption(page.getByLabel("Month"), "July");`),
  ).toMatchObject({ result: { label: "Month: July", value: "7" } });
  expect(await submitted(page)).toEqual({ size: "m", color: "bg", month: "7" });
});

// A period, comma or dash before a digit belongs to a number, as in -5, 1.5 and 1-5.
for (const [wanted, labels, outcome] of [
  ["5", ["+5", "0", "-5"], { error: "option_ambiguous" }],
  ["-5", ["5", "10"], { error: "option_missing" }],
  ["1.5 years", ["1-5 years", "6-10 years"], { error: "option_missing" }],
  ["-5", ["-5", "5"], { result: { shape: "select", label: "-5", value: "a" } }],
] as const)
  test(`chooseOption keeps a number's sign and separators: ${wanted} among ${labels.join(", ")}`, async ({
    page,
  }) => {
    const options = labels.map((label, index) => `<option value="${"abc"[index]}">${label}</option>`);
    await page.setContent(`<form><label>Amount<select name="amount">
<option value="">Choose</option>${options.join("")}</select></label></form>`);
    expect(
      await call(page, `return await chooseOption(page.getByLabel("Amount"), ${JSON.stringify(wanted)});`),
    ).toEqual(outcome);
    expect(await submitted(page)).toEqual({ amount: "result" in outcome ? outcome.result.value : "" });
  });

test("chooseOption still folds a period or hyphen before a letter beside numbers", async ({
  page,
}) => {
  await page.setContent(`<form><label>Place<select name="place">
<option value="">Choose</option><option value="1">St. Louis</option><option value="2">Saint-Denis</option>
<option value="3">1-5 years</option><option value="4">1.5 miles</option></select></label></form>`);
  const place = 'page.getByLabel("Place")';
  expect(await call(page, `return await chooseOption(${place}, "St Louis");`)).toMatchObject({
    result: { label: "St. Louis", value: "1" },
  });
  expect(await call(page, `return await chooseOption(${place}, "Saint Denis");`)).toMatchObject({
    result: { label: "Saint-Denis", value: "2" },
  });
  expect(await submitted(page)).toEqual({ place: "2" });
});

// Punctuation next to a digit on either side belongs to the value, and a value of punctuation
// alone names no option, not even one with an empty label.
for (const [wanted, labels] of [
  ["5-", ["5", "10"]],
  ["5'10", ["510", "6'0"]],
  ["-", ["", "Other"]],
] as const)
  test(`chooseOption finds no option for ${JSON.stringify(wanted)} among ${JSON.stringify(labels)}`, async ({
    page,
  }) => {
    const options = labels.map((label, index) => `<option value="${"abc"[index]}">${label}</option>`);
    await page.setContent(`<form><label>Height<select name="height">
<option value="">Choose</option>${options.join("")}</select></label></form>`);
    expect(
      await call(page, `return await chooseOption(page.getByLabel("Height"), ${JSON.stringify(wanted)});`),
    ).toEqual({ error: "option_missing" });
    expect(await submitted(page)).toEqual({ height: "" });
  });

test("chooseOption still folds punctuation between letters beside a value with digits", async ({
  page,
}) => {
  await page.setContent(`<form><label>Name<select name="name">
<option value="">Choose</option><option value="1">St. Louis</option><option value="2">Saint-Denis</option>
<option value="3">OBrien</option><option value="4">5'10</option><option value="5">1-5 years</option>
</select></label></form>`);
  const name = 'page.getByLabel("Name")';
  expect(await call(page, `return await chooseOption(${name}, "St Louis");`)).toMatchObject({
    result: { label: "St. Louis", value: "1" },
  });
  expect(await call(page, `return await chooseOption(${name}, "Saint Denis");`)).toMatchObject({
    result: { label: "Saint-Denis", value: "2" },
  });
  expect(await call(page, `return await chooseOption(${name}, "O'Brien");`)).toMatchObject({
    result: { label: "OBrien", value: "3" },
  });
  expect(await submitted(page)).toEqual({ name: "3" });
});

test("chooseOption keeps a value of punctuation alone as it is, never blank", async ({ page }) => {
  await page.setContent(`<form><label>Code<select name="code">
<option value="">Choose</option><option value="a"></option><option value="b">-</option>
</select></label></form>`);
  const code = 'page.getByLabel("Code")';
  // "-" names the option labelled "-", never the one with an empty label.
  expect(await call(page, `return await chooseOption(${code}, "-");`)).toEqual({
    result: { shape: "select", label: "-", value: "b" },
  });
  // Blank stays blank and names nothing.
  expect(await call(page, `return await chooseOption(${code}, "  ");`)).toEqual({
    error: "option_missing",
  });
  expect(await submitted(page)).toEqual({ code: "b" });
});

// A list may write a name short, as St-Jean for Saint-Jean, and a short label can also stand for
// a longer name it is not, as UK for Ukraine. A pick never takes a short label: it refuses, and
// sameText confirms the read-back of a pick made another way.
const towns = (labels: readonly string[]) => {
  const options = labels.map((label, index) => `<option value="${index + 1}">${label}</option>`);
  return `<form><label>Town<select name="town">
<option value="">Choose</option>${options.join("")}</select></label></form>`;
};

test("chooseOption never takes a label that writes the wanted name short", async ({ page }) => {
  await page.setContent(towns(["St-Jean", "St-Jean-de-Luz", "Ste-Marie", "UK"]));
  for (const wanted of ["Saint Jean", "Sainte-Marie", "Ukraine"])
    expect(
      await call(page, `return await chooseOption(page.getByLabel("Town"), "${wanted}");`),
      wanted,
    ).toEqual({ error: "option_missing" });
  expect(await submitted(page)).toEqual({ town: "" });
  await page.setContent(`<form>${dropdown("Town", [["SJ", "St-Jean"], ["SM", "Ste-Marie"]])}</form>`);
  expect(
    await call(page, `return await chooseOption(page.getByLabel("Town"), "Saint Jean");`),
  ).toEqual({ error: "option_missing" });
  expect(await submitted(page)).toEqual({ Town: "" });
});

test("chooseOption refuses a town the list writes short, and the read-back of the right pick confirms it", async ({
  page,
}) => {
  await page.setContent(towns(["St-Exemple-sur-Lac"]));
  const town = 'page.getByLabel("Town")';
  // Asked for the caller's spelling, the pick refuses loudly instead of choosing the short label.
  expect(await call(page, `return await chooseOption(${town}, "Saint-Exemple-sur-Lac");`)).toEqual({
    error: "option_missing",
  });
  expect(await submitted(page)).toEqual({ town: "" });
  // Once the right option is chosen, its read-back agrees with both the caller's spelling and
  // the label picked.
  expect(await call(page, `return await chooseOption(${town}, "St-Exemple-sur-Lac");`)).toEqual({
    result: { shape: "select", label: "St-Exemple-sur-Lac", value: "1" },
  });
  const shown = await page
    .getByLabel("Town")
    .evaluate((select: HTMLSelectElement) => select.selectedOptions[0]?.label ?? "");
  expect(sameText(shown, "Saint-Exemple-sur-Lac")).toBe(true);
  expect(sameText(shown, "St-Exemple-sur-Lac")).toBe(true);
});

test("chooseOption waits for a typeahead's results instead of taking a short label it showed before", async ({
  page,
}) => {
  // Opening lists recent picks; the results for what was typed arrive 3 s later, as from a slow
  // server.
  await page.setContent(`<form><label for="country">Country</label>
<input id="country" role="combobox" aria-expanded="false" aria-controls="country-list" autocomplete="off">
<div role="listbox" id="country-list" hidden></div><input type="hidden" name="country"></form>
<script>
const input = document.getElementById("country");
const list = document.getElementById("country-list");
const hidden = document.querySelector("[name=country]");
const show = (options) => {
  list.innerHTML = options.map(([value, label]) => '<div role="option" data-value="' + value + '">' + label + '</div>').join("");
};
input.addEventListener("click", () => {
  show([["UK", "UK"], ["US", "USA"]]);
  list.hidden = false;
  input.setAttribute("aria-expanded", "true");
});
input.addEventListener("input", () => {
  const query = input.value.toLowerCase();
  setTimeout(() => show([["UA", "Ukraine"]].filter(([, label]) => label.toLowerCase().startsWith(query))), 3000);
});
list.addEventListener("click", (event) => {
  const option = event.target.closest("[role=option]");
  if (!option) return;
  hidden.value = option.dataset.value;
  input.value = option.textContent;
  list.hidden = true;
  input.setAttribute("aria-expanded", "false");
});
</script>`);
  expect(
    await call(page, `return await chooseOption(page.getByLabel("Country"), "Ukraine");`),
  ).toEqual({ result: { shape: "combobox", label: "Ukraine", value: "UA" } });
  expect(await submitted(page)).toEqual({ country: "UA" });
});

// A wanted code or title is never read as short for a longer label either.
test("chooseOption never reads a wanted code or title as short for a longer label", async ({
  page,
}) => {
  await page.setContent(`<form><label>Country<select name="country">
<option value="">Choose</option><option value="US">United States</option><option value="UZ">Uzbekistan</option>
<option value="AE">United Arab Emirates</option><option value="UA">Ukraine</option>
</select></label><label>Title<select name="title">
<option value="">Choose</option><option value="1">Mr</option><option value="2">Mrs</option>
<option value="3">Miss</option><option value="4">Dr</option></select></label></form>`);
  for (const [control, wanted] of [
    ["Country", "USA"],
    ["Country", "UAE"],
    ["Title", "Ms"],
  ] as const)
    expect(
      await call(page, `return await chooseOption(page.getByLabel("${control}"), "${wanted}");`),
      wanted,
    ).toEqual({ error: "option_missing" });
  expect(await submitted(page)).toEqual({ country: "", title: "" });
});

// A date part never reads an option as short for its name: Jn would otherwise stand for June.
test("fillDate never reads a month option as short for the month's name", async ({ page }) => {
  await page.setContent(`<html lang="en-US"><body><form><label>Month<select name="month">
<option value="">Choose</option><option>Jn</option><option>Jl</option></select></label></form></body></html>`);
  expect(
    await call(page, `return await fillDate(page.getByLabel("Month"), "1990-06-04", "MMMM");`),
  ).toEqual({ error: "option_missing" });
  expect(await submitted(page)).toEqual({ month: "" });
});

test("chooseOption and fillDate fail within about their timeout, never 30 s, when what they read vanishes", async ({
  page,
}) => {
  // Playwright's own default: a read that passes no timeout waits this long for its element.
  page.setDefaultTimeout(30_000);
  // A dropdown that lists two places when opened, taller than the list shows, then drops its list
  // as the page redraws once it first scrolls.
  await page.setContent(`<style>#place-list { height: 2em; overflow-y: auto } #place-list div { height: 10em }</style>
<form>
<button type="button" aria-label="Place" aria-haspopup="listbox" aria-expanded="false" aria-controls="place-list">Select</button>
<div role="listbox" id="place-list" hidden></div></form>
<script>
const button = document.querySelector("button");
button.addEventListener("click", () => {
  const list = document.querySelector("#place-list");
  list.innerHTML = '<div role="option">Lyon</div><div role="option">Paris</div>';
  list.hidden = false;
  button.setAttribute("aria-expanded", "true");
  list.addEventListener("scroll", () => list.remove(), { once: true });
});
</script>`);
  const timed = (step: string) => `
    const started = Date.now();
    try {
      await ${step};
      return { name: "none" };
    } catch (error) {
      return { name: error.name, elapsed: Date.now() - started };
    }`;
  for (const [timeout, step] of [
    // The wanted place is not listed, and the list goes once the picker scrolls to look further
    // down it.
    [2000, `chooseOption(page.getByRole("button", { name: "Place" }), "Nice", { timeout: 2000 })`],
    // The control itself is gone.
    [1000, `chooseOption(page.getByLabel("Country"), "France", { timeout: 1000 })`],
    [1000, `fillDate(page.getByLabel("Month"), "1990-07-04", "MM", { timeout: 1000 })`],
  ] as const) {
    const answer = await call(page, timed(step));
    // Each read waits at most the picker's timeout, so it fails one timeout after the read that
    // missed, never after Playwright's 30 s.
    expect(answer, step).toMatchObject({ result: { name: "TimeoutError" } });
    expect((answer.result as { elapsed: number }).elapsed, step).toBeLessThan(2 * timeout);
  }
});

test("a failure names its reason, never the value", async ({ page }) => {
  await page.setContent(`<form><label>Date of birth<input name="dob"></label>
<label>Month<select name="month"><option>7</option></select></label></form>`);
  // An impossible date, a whole date for one part's select, and a dropdown choice in a text box.
  expect(
    await call(
      page,
      `return await fillDate(page.getByLabel("Date of birth"), "1990-02-30", "MM/DD/YYYY");`,
    ),
  ).toEqual({ error: "date_invalid" });
  expect(
    await call(
      page,
      `return await fillDate(page.getByLabel("Month"), "1990-07-04", "MM/DD/YYYY");`,
    ),
  ).toEqual({ error: "format_mismatch" });
  expect(
    await call(page, `return await chooseOption(page.getByLabel("Date of birth"), "July");`),
  ).toEqual({ error: "control_unsupported" });
  expect(await submitted(page)).toEqual({ dob: "", month: "7" });
});

test("a fill the page never takes names its reason, never the value Playwright's error would quote", async ({
  page,
}) => {
  await page.setContent(`<form><label>Date of birth<input name="dob" readonly></label></form>`);
  expect(
    await call(
      page,
      `return await fillDate(page.getByLabel("Date of birth"), "1990-07-04", "MM/DD/YYYY", { timeout: 500 });`,
    ),
  ).toEqual({ error: "not_committed" });
});
