import { expect, test } from "@playwright/test";
import { call, callFailure, serve, submitted } from "./picker-fixture.js";

// The picker helper, run as a Kernel call body runs it, on synthetic pages that each model one
// kind of picker or one way a picker misbehaves. Chromium must generate the events: the widgets
// open, filter, highlight and commit only from real clicks, keys and scrolling.

/** An ARIA combobox that filters a local list as you type and commits a click. */
const combobox = `
<form><label for="person">Assignee</label>
<div class="field">
  <input id="person" role="combobox" aria-expanded="false" aria-controls="people" aria-autocomplete="list" autocomplete="off">
  <ul id="people" role="listbox" hidden style="margin:0;padding:0;list-style:none"></ul>
  <input type="hidden" name="person">
</div></form>
<script>
const people = [["1","Riley Hart"],["2","Morgan Ellis"],["3","Jordan Reyes"],["4","Casey Lund"],["5","Quinn Avery"],["6","Jordan Reyesford"]];
const input = document.getElementById("person"), list = document.getElementById("people"), hidden = document.querySelector("[name=person]");
const render = () => {
  const query = input.value.toLowerCase();
  list.innerHTML = people.filter(([, name]) => name.toLowerCase().includes(query))
    .map(([value, name]) => '<li role="option" id="p' + value + '" data-value="' + value + '">' + name + '</li>').join("");
  list.hidden = false;
  input.setAttribute("aria-expanded", "true");
};
input.addEventListener("input", render);
input.addEventListener("focus", render);
list.addEventListener("mousedown", (event) => event.preventDefault());
list.addEventListener("click", (event) => {
  const option = event.target.closest("[role=option]");
  if (!option) return;
  hidden.value = option.dataset.value;
  input.value = option.textContent;
  list.hidden = true;
  input.setAttribute("aria-expanded", "false");
});
</script>`;

test("pickValue types into an ARIA combobox and clicks the matching option", async ({ page }) => {
  await serve(page, combobox);
  expect(
    await call(page, `return await pickValue(page.getByRole("combobox", { name: "Assignee" }), "jordan reyes", fast);`),
  ).toEqual({ result: { picked: true, kind: "typeahead", label: "Jordan Reyes", value: "3", rank: "normalized", refills: 0 } });
  expect(await submitted(page)).toEqual({ person: "3" });
});

// With the stem option, a word picks the one suggestion whose whole name is a word it begins, ahead
// of the suggestions that hold that word among others.
test("pickValue picks the suggestion whose whole name shares the value's stem when asked", async ({ page }) => {
  const specialties = '[["1","Example Dentistry"],["2","Dentistry"],["3","Sample Dentistry"],["4","Placeholder Dentistry (Test Annex)"]]';
  await serve(page, combobox.replace("Assignee", "Specialty").replace(/const people = \[.*\];/, `const people = ${specialties};`));
  const field = 'page.getByRole("combobox", { name: "Specialty" })';
  // Without the stem option, as on a write, the value is refused as missing.
  expect(await call(page, `return await pickValue(${field}, "Dentist", fast);`)).toMatchObject({
    result: { picked: false, reason: "option_missing" },
  });
  expect(await call(page, `return await pickValue(${field}, "Dentist", { ...fast, stem: true });`)).toEqual({
    result: { picked: true, kind: "typeahead", label: "Dentistry", value: "2", rank: "stem", refills: 0 },
  });
  expect(await submitted(page)).toEqual({ person: "2" });
});

test("pickValue picks a native select's option by label, value or another spelling", async ({ page }) => {
  await serve(page, `<form><label>State <select name="state">
<option value="">Choose a state</option><option value="CA">California</option><option value="NV">Nevada</option>
<option value="OR" disabled>Oregon</option></select></label></form>`);
  const state = 'page.getByLabel("State")';
  expect(await call(page, `return await pickValue(${state}, ["CA", "California"], fast);`)).toEqual({
    result: { picked: true, kind: "select", label: "California", value: "CA", rank: "exact", refills: 0 },
  });
  expect(await call(page, `return await pickValue(${state}, "nevada", fast);`)).toMatchObject({ result: { value: "NV", rank: "normalized" } });
  expect(await submitted(page)).toEqual({ state: "NV" });
  // A disabled option is reported, and a missing one lists what the select offers, never its prompt.
  expect(await call(page, `return await pickValue(${state}, "Oregon", fast);`)).toEqual({
    result: { picked: false, reason: "option_disabled", wanted: "Oregon", available: ["California", "Nevada"], matches: ["Oregon"] },
  });
  expect(await call(page, `return await pickValue(${state}, "Texas", fast);`)).toEqual({
    result: { picked: false, reason: "option_missing", wanted: "Texas", available: ["California", "Nevada"], matches: [] },
  });
});

// A list that writes the wanted town short is refused, never picked without a word.
test("pickValue refuses a town the list writes short", async ({ page }) => {
  await serve(page, `<form><label>Town <select name="town">
<option value="">Choose a town</option><option value="1">St-Exemple-sur-Lac</option></select></label></form>`);
  expect(
    await call(page, `return await pickValue(page.getByLabel("Town"), "Saint-Exemple-sur-Lac", fast);`),
  ).toEqual({
    result: {
      picked: false,
      reason: "option_missing",
      wanted: "Saint-Exemple-sur-Lac",
      available: ["St-Exemple-sur-Lac"],
      matches: [],
    },
  });
  expect(await submitted(page)).toEqual({ town: "" });
});

test("pickValue prefers an exact match and reports options that tie once case is ignored", async ({ page }) => {
  await serve(page, `<form><label>Plan <select name="plan">
<option value="1">Basic</option><option value="2">basic</option><option value="3">Basic plus</option></select></label></form>`);
  expect(await call(page, `return await pickValue(page.getByLabel("Plan"), "basic", fast);`)).toMatchObject({
    result: { picked: true, value: "2", rank: "exact" },
  });
  expect(await call(page, `return await pickValue(page.getByLabel("Plan"), "BASIC", fast);`)).toEqual({
    result: { picked: false, reason: "option_ambiguous", wanted: "BASIC", available: ["Basic", "basic", "Basic plus"], matches: ["Basic", "basic"] },
  });
  expect(await submitted(page)).toEqual({ plan: "2" });
});

test("pickValue sets a hidden select behind a custom widget and the widget follows", async ({ page }) => {
  await serve(page, `<form><label id="size-label">Size</label>
<select name="size" aria-labelledby="size-label" style="position:absolute;width:1px;height:1px;clip:rect(0 0 0 0);overflow:hidden">
<option value="s">Small</option><option value="m">Medium</option><option value="l">Large</option></select>
<span id="shown">Small</span></form>
<script>document.querySelector("select").addEventListener("change", (event) => {
  document.getElementById("shown").textContent = event.target.selectedOptions[0].textContent; });</script>`);
  expect(await call(page, `return await pickValue(page.locator("select[name=size]"), "Large", fast);`)).toMatchObject({
    result: { picked: true, kind: "select", value: "l" },
  });
  await expect(page.locator("#shown")).toHaveText("Large");
});

test("pickValue fills an input's datalist value", async ({ page }) => {
  await serve(page, `<form><label>Browser <input name="browser" list="browsers"></label>
<datalist id="browsers"><option value="chromium">Chromium</option><option value="firefox">Firefox</option></datalist></form>`);
  expect(await call(page, `return await pickValue(page.getByLabel("Browser"), "Firefox", fast);`)).toEqual({
    result: { picked: true, kind: "datalist", label: "Firefox", value: "firefox", rank: "exact", refills: 0 },
  });
  expect(await submitted(page)).toEqual({ browser: "firefox" });
});

/**
 * An autocomplete whose suggestions come from the site's API: a "Loading..." panel shows while
 * the request runs, then a listbox the input owns, or "No options".
 */
const remoteAutocomplete = `
<form><label for="country">Country</label>
<input id="country" role="combobox" aria-expanded="false" aria-autocomplete="list" autocomplete="off">
<input type="hidden" name="country"></form>
<script>
const input = document.getElementById("country"), hidden = document.querySelector("[name=country]");
const popper = document.createElement("div");
popper.className = "autocomplete-popper";
popper.style.cssText = "position:absolute;top:40px;left:8px;width:300px;background:#fff;border:1px solid #ccc";
popper.hidden = true;
document.body.append(popper);
let generation = 0;
input.addEventListener("input", async () => {
  const mine = ++generation;
  popper.hidden = false;
  input.removeAttribute("aria-controls");
  popper.innerHTML = '<div class="autocomplete-loading">Loading…</div>';
  const answer = await (await fetch("/api/countries?q=" + encodeURIComponent(input.value))).json();
  if (mine !== generation) return;
  if (answer.length === 0) { popper.innerHTML = '<div class="autocomplete-noOptions">No options</div>'; return; }
  popper.innerHTML = '<ul role="listbox" id="country-list" style="margin:0;padding:0">' +
    answer.map((item) => '<li role="option" data-value="' + item.code + '">' + item.name + '</li>').join("") + "</ul>";
  input.setAttribute("aria-controls", "country-list");
  input.setAttribute("aria-expanded", "true");
});
popper.addEventListener("mousedown", (event) => event.preventDefault());
popper.addEventListener("click", (event) => {
  const option = event.target.closest("[role=option]");
  if (!option) return;
  input.value = option.textContent;
  hidden.value = option.dataset.value;
  popper.hidden = true;
  input.setAttribute("aria-expanded", "false");
});
</script>`;
const countries = [
  ["CA", "Canada"], ["TD", "Chad"], ["CL", "Chile"], ["CN", "China"], ["CO", "Colombia"],
  ["AQ", "Chilean Antarctic Territory"], ["CU", "Cuba"],
] as const;
const countryApi = (params: URLSearchParams) => ({
  delayMs: 150,
  body: countries
    .filter(([, name]) => name.toLowerCase().includes((params.get("q") ?? "").toLowerCase()))
    .map(([code, name]) => ({ code, name })),
});

test("pickValue waits out an autocomplete's loading panel and picks among partial matches", async ({ page }) => {
  await serve(page, remoteAutocomplete, countryApi);
  const country = 'page.getByRole("combobox", { name: "Country" })';
  // "Chile" also matches "Chilean Antarctic Territory" as a prefix: the exact name wins.
  expect(await call(page, `return await pickValue(${country}, "Chile", fast);`)).toEqual({
    result: { picked: true, kind: "typeahead", label: "Chile", value: "CL", rank: "exact", refills: 0 },
  });
  expect(await submitted(page)).toEqual({ country: "CL" });
  // A whole word of one option's name picks it.
  expect(await call(page, `return await pickValue(${country}, "antarctic", fast);`)).toMatchObject({
    result: { picked: true, value: "AQ", rank: "words" },
  });
});

test("pickValue reports no match, with what the site suggested, instead of timing out", async ({ page }) => {
  await serve(page, remoteAutocomplete, countryApi);
  const country = 'page.getByRole("combobox", { name: "Country" })';
  expect(await call(page, `return await pickValue(${country}, "Atlantis", fast);`)).toEqual({
    result: { picked: false, reason: "option_missing", wanted: "Atlantis", available: [], matches: [] },
  });
  // A prefix is not a name: the options the site listed come back as available.
  expect(await call(page, `return await pickValue(${country}, "Chi", fast);`)).toEqual({
    result: { picked: false, reason: "option_missing", wanted: "Chi", available: ["Chile", "China", "Chilean Antarctic Territory"], matches: [] },
  });
});

test("pickValue types again key by key when the field listens only to keys, and answers that land out of order never win", async ({ page }) => {
  const cities = ["Sacramento", "Salem", "San Diego", "San Jose", "Santa Fe", "Santiago", "Seattle", "Spokane"];
  const asked: string[] = [];
  await serve(
    page,
    `<form><label>City <input id="city" autocomplete="off"></label><ul id="cities"></ul><input type="hidden" name="city"></form>
<script>
const input = document.getElementById("city"), list = document.getElementById("cities");
// Every key asks the API; the page draws whichever answer lands last.
input.addEventListener("keyup", async () => {
  const answer = await (await fetch("/api/cities?q=" + encodeURIComponent(input.value))).json();
  list.innerHTML = answer.map((name) => "<li>" + name + "</li>").join("");
});
list.addEventListener("click", (event) => {
  const item = event.target.closest("li");
  input.value = item.textContent;
  document.querySelector("[name=city]").value = item.textContent;
  list.innerHTML = "";
});
</script>`,
    (params) => {
      const query = params.get("q") ?? "";
      asked.push(query);
      // Shorter queries answer slower, so an early key's answer lands after the last key's.
      return {
        delayMs: Math.max(20, 400 - query.length * 60),
        body: cities.filter((name) => name.toLowerCase().startsWith(query.toLowerCase())).slice(0, 5),
      };
    },
  );
  expect(await call(page, `return await pickValue(page.getByLabel("City"), "Santiago", fast);`)).toMatchObject({
    result: { picked: true, label: "Santiago", rank: "exact" },
  });
  expect(await submitted(page)).toEqual({ city: "Santiago" });
});

test("pickValue types the value once more when a slower, older answer replaced the list", async ({ page }) => {
  await serve(
    page,
    `<form><label>Destination <input id="to" role="combobox" aria-controls="to-list" autocomplete="off"></label>
<ul id="to-list" role="listbox"></ul></form>
<script>
const input = document.getElementById("to"), list = document.getElementById("to-list");
const draw = (names) => { list.innerHTML = names.map((name) => '<li role="option">' + name + "</li>").join(""); };
// Focus asks for recent places slowly; typing asks for matches quickly. Both draw on arrival.
input.addEventListener("focus", async () => draw(await (await fetch("/api/recent")).json()));
input.addEventListener("input", async () => {
  if (input.value === "") { draw([]); return; }
  draw(await (await fetch("/api/places?q=" + encodeURIComponent(input.value))).json());
});
list.addEventListener("click", (event) => { input.value = event.target.textContent; draw([]); });
</script>`,
    (params, path) =>
      path === "/api/recent"
        ? { delayMs: 400, body: ["Lisbon", "Porto"] }
        : { delayMs: 40, body: ["Madrid", "Malaga"].filter((name) => name.toLowerCase().startsWith((params.get("q") ?? "").toLowerCase())) },
  );
  expect(await call(page, `return await pickValue(page.getByLabel("Destination"), "Madrid", fast);`)).toMatchObject({
    result: { picked: true, label: "Madrid" },
  });
  await expect(page.getByLabel("Destination")).toHaveValue("Madrid");
});

/**
 * A search box that loads its search when it first takes focus, in a chain of its own requests
 * lasting about 2 s. Until they finish, typing draws only the box's "Search with AI" row, which the
 * author's `option` selector leaves out, and asks the site nothing; once they finish, typing also
 * asks the site for places.
 */
const startingUp = `
<form><label for="where">Destination</label>
<input id="where" role="combobox" aria-controls="where-list" aria-expanded="false" autocomplete="off">
<ul id="where-list" role="listbox" hidden></ul><input type="hidden" name="where"></form>
<script>
const input = document.getElementById("where"), list = document.getElementById("where-list");
let ready = false, loading = false, generation = 0;
input.addEventListener("focus", async () => {
  if (loading) return;
  loading = true;
  for (let step = 0; step < 8; step++) await fetch("/api/start?step=" + step);
  ready = true;
});
const draw = (places) => {
  list.innerHTML = places.map((place) => '<li role="option" data-value="' + place + '">' + place + "</li>").join("") +
    '<li role="option" aria-label="' + input.value + ' Search with AI">' + input.value + " · Search with AI</li>";
  list.hidden = false;
  input.setAttribute("aria-expanded", "true");
};
input.addEventListener("input", async () => {
  const mine = ++generation;
  draw([]);
  if (!ready || input.value === "") return;
  const places = await (await fetch("/api/places?q=" + encodeURIComponent(input.value))).json();
  if (mine === generation) draw(places);
});
list.addEventListener("mousedown", (event) => event.preventDefault());
list.addEventListener("click", (event) => {
  const option = event.target.closest("[role=option]");
  if (!option || !option.dataset.value) return;
  input.value = option.dataset.value;
  document.querySelector("[name=where]").value = option.dataset.value;
  list.hidden = true;
  input.setAttribute("aria-expanded", "false");
});
</script>`;
const startingUpApi = (params: URLSearchParams, path: string) =>
  path === "/api/start"
    ? { delayMs: 250, body: {} }
    : {
        delayMs: 60,
        body: ["Tokyo", "Tokyo Bay", "Toronto", "Toulouse"].filter((place) =>
          place.toLowerCase().startsWith((params.get("q") ?? "").toLowerCase()),
        ),
      };
const notAiRow = `'[role="option"]:not([aria-label$="Search with AI"])'`;

test("pickValue types again key by key, once the page's own requests go quiet, when its option selector left no row", async ({ page }) => {
  await serve(page, startingUp, startingUpApi);
  expect(
    await call(page, `return await pickValue(page.getByLabel("Destination"), "Tokyo", { ...fast, tie: "first", option: ${notAiRow} });`),
  ).toEqual({ result: { picked: true, kind: "typeahead", label: "Tokyo", value: "Tokyo", rank: "exact", refills: 0 } });
  expect(await submitted(page)).toEqual({ where: "Tokyo" });
});

test("pickValue still refuses a place a starting-up page never offers, and its option selector's left-out row is no choice", async ({ page }) => {
  await serve(page, startingUp, startingUpApi);
  expect(
    await call(page, `return await pickValue(page.getByLabel("Destination"), "Qxzvw", { ...fast, tie: "first", option: ${notAiRow} });`),
  ).toEqual({ result: { picked: false, reason: "option_missing", wanted: "Qxzvw", available: [], matches: [] } });
  expect(await submitted(page)).toEqual({ where: "" });
});

/**
 * A search box that asks the site for its default list, with an empty term, when it takes focus,
 * and for matches as you type, drawing each answer as it lands. A new visitor's default list is
 * empty, and the slower empty-term answer lands after the typed term's. A term that matches no
 * city answers with popular cities.
 */
const defaultList = `
<form><label>City <input id="city" role="combobox" aria-controls="city-list" autocomplete="off"></label>
<ul id="city-list" role="listbox"></ul></form>
<script>
const input = document.getElementById("city"), list = document.getElementById("city-list");
const draw = (names) => { list.innerHTML = names.map((name) => '<li role="option">' + name + "</li>").join(""); };
const ask = async (term) => draw(await (await fetch("/api/suggest?q=" + encodeURIComponent(term))).json());
input.addEventListener("focus", () => ask(""));
input.addEventListener("input", () => { if (input.value !== "") ask(input.value); });
list.addEventListener("mousedown", (event) => event.preventDefault());
list.addEventListener("click", (event) => { input.value = event.target.textContent; draw([]); });
</script>`;
const defaultListApi = (params: URLSearchParams) => {
  const term = (params.get("q") ?? "").toLowerCase();
  if (term === "") return { delayMs: 400, body: [] };
  const found = ["Chicago", "Charlotte", "Cincinnati"].filter((name) => name.toLowerCase().startsWith(term));
  return { delayMs: 40, body: found.length > 0 ? found : ["Lisbon", "Porto"] };
};

test("pickValue types again key by key when an empty default list replaced the list", async ({ page }) => {
  await serve(page, defaultList, defaultListApi);
  expect(await call(page, `return await pickValue(page.getByLabel("City"), "Chicago", fast);`)).toEqual({
    result: { picked: true, kind: "typeahead", label: "Chicago", value: "", rank: "exact", refills: 0 },
  });
  await expect(page.getByLabel("City")).toHaveValue("Chicago");
});

test("pickValue still refuses a city the site lacks after an empty default list, listing the cities it offered", async ({ page }) => {
  await serve(page, defaultList, defaultListApi);
  expect(await call(page, `return await pickValue(page.getByLabel("City"), "Qxzvw", fast);`)).toEqual({
    result: { picked: false, reason: "option_missing", wanted: "Qxzvw", available: ["Lisbon", "Porto"], matches: [] },
  });
});

test("pickValue leaves an empty list's typing to the author's type hook", async ({ page }) => {
  await serve(page, defaultList, defaultListApi);
  expect(
    await call(
      page,
      `const steps = [];
      const outcome = await pickValue(page.getByLabel("City"), "Chicago", { ...fast, type: async (field, query, step) => { steps.push(step); await field.fill(query); } });
      return { outcome, steps };`,
    ),
  ).toEqual({ result: { outcome: { picked: false, reason: "option_missing", wanted: "Chicago", available: [], matches: [] }, steps: [0] } });
});

test("pickValues with create makes the typed tag at once when the list shows nothing for it", async ({ page }) => {
  await serve(page, `<form><label for="tag-entry">Tags</label><div class="tag-input"><input id="tag-entry" role="combobox" aria-controls="tag-list" autocomplete="off"></div>
<ul id="tag-list" role="listbox" hidden></ul><input type="hidden" name="tags"></form>
<script>
const input = document.getElementById("tag-entry"), box = document.querySelector(".tag-input"), list = document.getElementById("tag-list");
window.keys = [];
input.addEventListener("input", () => { list.hidden = false; list.innerHTML = '<li class="no-results">No matches</li>'; });
input.addEventListener("keydown", (event) => {
  window.keys.push(event.key);
  if (event.key !== "Enter" || input.value.trim() === "") return;
  event.preventDefault();
  input.insertAdjacentHTML("beforebegin", '<span class="tag">' + input.value.trim() + '<button type="button" aria-label="Remove">×</button></span>');
  input.value = "";
  list.hidden = true;
  document.querySelector("[name=tags]").value = [...box.querySelectorAll(".tag")].map((tag) => tag.firstChild.textContent).join(",");
});
</script>`);
  expect(await call(page, `return await pickValues(page.getByLabel("Tags"), ["urgent"], { ...fast, create: true });`)).toEqual({
    result: { picked: true, kind: "typeahead", values: [{ label: "urgent", value: "", added: true }], removed: [] },
  });
  expect(await submitted(page)).toEqual({ tags: "urgent" });
  // Filled once and committed with Enter: never typed again key by key.
  expect(await page.evaluate(() => (window as unknown as { keys: string[] }).keys)).toEqual(["Enter"]);
});

test("pickValue types an empty list's search box again key by key, never with Enter", async ({ page }) => {
  // A popup search box in no form: any text the site lacks shows "No results", and an emptied box
  // changes nothing. Enter there would run the site's own search.
  await serve(page, `<button type="button" aria-label="Region" aria-haspopup="listbox" aria-controls="region-popup" aria-expanded="false">Choose</button>
<div id="region-popup" hidden><input aria-label="Find region" autocomplete="off">
<ul role="listbox" id="regions"><li role="option">North</li><li role="option">South</li></ul></div>
<script>
const button = document.querySelector("button"), popup = document.getElementById("region-popup"), search = popup.querySelector("input");
window.pressed = [];
button.addEventListener("click", () => { popup.hidden = false; button.setAttribute("aria-expanded", "true"); });
search.addEventListener("input", () => { if (search.value !== "") document.getElementById("regions").innerHTML = '<li class="no-results">No results</li>'; });
search.addEventListener("keydown", (event) => { if (event.key === "Enter") window.pressed.push(event.key); });
</script>`);
  expect(await call(page, `return await pickValue(page.getByRole("button", { name: "Region" }), "Qxzvw", fast);`)).toEqual({
    result: { picked: false, reason: "option_missing", wanted: "Qxzvw", available: ["North", "South"], matches: [] },
  });
  expect(await page.evaluate(() => (window as unknown as { pressed: string[] }).pressed)).toEqual([]);
});

test("pickValue refuses as the empty list did when typing it again runs out of time", async ({ page }) => {
  // Typing draws "No matches" at once; each key also asks the site, which never answers.
  await serve(
    page,
    `<form><label>Branch <input id="branch" role="combobox" aria-controls="branches" autocomplete="off"></label>
<ul id="branches" role="listbox" hidden></ul></form>
<script>
const input = document.getElementById("branch"), list = document.getElementById("branches");
input.addEventListener("input", () => { list.hidden = false; list.innerHTML = '<li class="no-results">No matches</li>'; });
input.addEventListener("keydown", () => { fetch("/api/branches?q=" + encodeURIComponent(input.value)); });
</script>`,
    () => ({ delayMs: 20_000, body: [] }),
  );
  expect(await call(page, `return await pickValue(page.getByLabel("Branch"), "Northside", { ...fast, timeout: 3000 });`)).toEqual({
    result: { picked: false, reason: "option_missing", wanted: "Northside", available: [], matches: [] },
  });
});

test("pickValue still refuses, and never types again, when too little of its time is left", async ({ page }) => {
  // The site answers every term with nothing, after 2.3 s of the call's 3 s.
  await serve(
    page,
    `<form><label>Branch <input id="branch" role="combobox" aria-controls="branches" autocomplete="off"></label>
<ul id="branches" role="listbox" hidden></ul></form>
<script>
const input = document.getElementById("branch"), list = document.getElementById("branches");
window.inputs = 0;
input.addEventListener("input", async () => {
  window.inputs++;
  await (await fetch("/api/branches?q=" + encodeURIComponent(input.value))).json();
  list.hidden = false;
  list.innerHTML = '<li class="no-results">No matches</li>';
});
</script>`,
    () => ({ delayMs: 2300, body: [] }),
  );
  expect(await call(page, `return await pickValue(page.getByLabel("Branch"), "Northside", { ...fast, timeout: 3000 });`)).toEqual({
    result: { picked: false, reason: "option_missing", wanted: "Northside", available: [], matches: [] },
  });
  expect(await page.evaluate(() => (window as unknown as { inputs: number }).inputs)).toBe(1);
});

test("pickValue's wait for the page to go quiet is bounded on a page that never does", async ({ page }) => {
  // The page keeps a request of its own in flight, each to a new address, so none is a poll.
  await serve(
    page,
    `${defaultList}<script>let beat = 0; setInterval(() => fetch("/api/beacon?n=" + beat++), 100);</script>`,
    (params, path) => (path === "/api/beacon" ? { delayMs: 150, body: {} } : defaultListApi(params)),
  );
  const started = Date.now();
  expect(await call(page, `return await pickValue(page.getByLabel("City"), "Chicago", { ...fast, timeout: 10_000 });`)).toMatchObject({
    result: { picked: true, label: "Chicago" },
  });
  // About 1.3 s for each wait the page's requests stretch, and 2 s for the quiet the page never
  // reaches; waiting on until a third of the call is left would take over 9 s.
  expect(Date.now() - started).toBeLessThan(9000);
});

test("pickValue waits for debounced suggestions that show no loading sign", async ({ page }) => {
  await serve(page, `<form><label>Fruit <input id="fruit" autocomplete="off"></label><div class="suggestions"></div></form>
<script>
const input = document.getElementById("fruit"), box = document.querySelector(".suggestions");
let timer;
input.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    box.innerHTML = ["Apple", "Apricot", "Avocado"].filter((name) => name.toLowerCase().startsWith(input.value.toLowerCase()))
      .map((name) => '<div class="suggestion" data-value="' + name.toLowerCase() + '">' + name + "</div>").join("");
  }, 250);
});
box.addEventListener("click", (event) => { input.value = event.target.textContent; box.innerHTML = ""; });
</script>`);
  expect(await call(page, `return await pickValue(page.getByLabel("Fruit"), "Apricot", fast);`)).toEqual({
    result: { picked: true, kind: "typeahead", label: "Apricot", value: "apricot", rank: "exact", refills: 0 },
  });
});

/**
 * A grid row whose cell editor is an ARIA combobox. A commit sends a save; `reverts` times the
 * grid's refresh, which redraws the editor with the row's old value, answers the save.
 */
const gridEditor = (reverts: "once" | "always") => `
<table><tbody><tr><td>Row 1</td><td id="cell"></td></tr></tbody></table>
<output id="saves">0</output>
<script>
const owners = ["Avery Lee", "Blake Moss", "Casey Ng"];
let saved = "Avery Lee", refreshes = 0;
const draw = (value) => {
  document.getElementById("cell").innerHTML =
    '<input aria-label="Owner" role="combobox" aria-controls="owner-list" autocomplete="off" value="' + value + '">' +
    '<ul id="owner-list" role="listbox" hidden></ul>';
  const input = document.querySelector("[aria-label=Owner]"), list = document.getElementById("owner-list");
  input.addEventListener("input", () => {
    list.hidden = false;
    list.innerHTML = owners.filter((name) => name.toLowerCase().includes(input.value.toLowerCase()))
      .map((name) => '<li role="option">' + name + "</li>").join("");
  });
  list.addEventListener("click", async (event) => {
    input.value = event.target.textContent;
    list.hidden = true;
    const chosen = input.value;
    document.getElementById("saves").textContent++;
    await fetch("/api/save");
    refreshes++;
    if (${JSON.stringify(reverts)} === "always" || refreshes === 1) draw(saved);
    else saved = chosen;
  });
};
draw(saved);
</script>`;

test("pickValue picks again when a grid refresh puts the old value back", async ({ page }) => {
  await serve(page, gridEditor("once"), () => ({ delayMs: 80, body: {} }));
  expect(await call(page, `return await pickValue(page.getByLabel("Owner"), "Casey Ng", fast);`)).toEqual({
    result: { picked: true, kind: "typeahead", label: "Casey Ng", value: "", rank: "exact", refills: 1 },
  });
  await expect(page.getByLabel("Owner")).toHaveValue("Casey Ng");
  await expect(page.locator("#saves")).toHaveText("2");
});

test("pickValue gives up as not_committed after a bounded number of refills", async ({ page }) => {
  await serve(page, gridEditor("always"), () => ({ delayMs: 40, body: {} }));
  expect(await call(page, `return await pickValue(page.getByLabel("Owner"), "Casey Ng", { ...fast, refills: 1 });`)).toEqual({
    error: "not_committed",
  });
  await expect(page.locator("#saves")).toHaveText("2");
});

/** A button that opens a listbox of `options` (`[value, text, title?, disabled?]`). */
const dropdown = (options: readonly (readonly [string, string, string?, boolean?])[]) => `
<form><button type="button" id="pick" aria-label="Customer" aria-haspopup="listbox" aria-expanded="false" aria-controls="customers">Choose</button>
<div id="customers" role="listbox" hidden>${options
  .map(
    ([value, text, title, disabled]) =>
      `<div role="option" data-value="${value}"${title ? ` title="${title}"` : ""}${disabled ? ' aria-disabled="true"' : ""}>${text}</div>`,
  )
  .join("")}</div><input type="hidden" name="customer"></form>
<script>
const button = document.getElementById("pick"), list = document.getElementById("customers");
button.addEventListener("click", () => { list.hidden = !list.hidden; button.setAttribute("aria-expanded", String(!list.hidden)); });
list.addEventListener("click", (event) => {
  const option = event.target.closest("[role=option]");
  if (!option || option.getAttribute("aria-disabled") === "true") return;
  button.textContent = option.title || option.innerText.split("\\n")[0];
  document.querySelector("[name=customer]").value = option.dataset.value;
  list.hidden = true;
  button.setAttribute("aria-expanded", "false");
});
</script>`;

test("pickValue matches an option by the name in its title or the value in its data attribute", async ({ page }) => {
  const options = [
    ["ACM-2", "Acme Insur…", "Acme Insurance Group"],
    ["ACM-3", "Acme Indus…", "Acme Industrial Supply"],
  ] as const;
  await serve(page, dropdown(options));
  const customer = 'page.getByRole("button", { name: "Customer" })';
  expect(await call(page, `return await pickValue(${customer}, "Acme Insurance Group", fast);`)).toEqual({
    result: { picked: true, kind: "dropdown", label: "Acme Insur…", value: "ACM-2", rank: "exact", refills: 0 },
  });
  expect(await submitted(page)).toEqual({ customer: "ACM-2" });
  expect(await call(page, `return await pickValue(${customer}, "acm-3", fast);`)).toMatchObject({
    result: { picked: true, value: "ACM-3", rank: "normalized" },
  });
  expect(await submitted(page)).toEqual({ customer: "ACM-3" });
});

test("pickValue reports two options with one label as ambiguous, each by its full text", async ({ page }) => {
  await serve(
    page,
    dropdown([
      ["17", "John Smith<br><small>john.s@example.com</small>"],
      ["42", "John Smith<br><small>jsmith@example.org</small>"],
      ["50", "Jane Smith"],
      ["61", "Jon Smithers", "", true],
    ]),
  );
  expect(await call(page, `return await pickValue(page.getByRole("button", { name: "Customer" }), "John Smith", fast);`)).toEqual({
    result: {
      picked: false,
      reason: "option_ambiguous",
      wanted: "John Smith",
      available: ["John Smith", "Jane Smith"],
      matches: ["John Smith john.s@example.com", "John Smith jsmith@example.org"],
    },
  });
  expect(await submitted(page)).toEqual({ customer: "" });
  expect(await call(page, `return await pickValue(page.getByRole("button", { name: "Customer" }), "Jon Smithers", fast);`)).toMatchObject({
    result: { picked: false, reason: "option_disabled", matches: ["Jon Smithers"] },
  });
});

test("pickValue with tie first takes the first of the options that tie, in the site's order, and names them", async ({ page }) => {
  await serve(page, `<form><label>City <select name="city">
<option value="">Choose a city</option><option value="spf-il">Springfield, Illinois</option>
<option value="spf-mo">Springfield, Missouri</option><option value="shb">Shelbyville</option></select></label></form>`);
  const city = 'page.getByLabel("City")';
  // Without the option a tie is refused, as before.
  expect(await call(page, `return await pickValue(${city}, "Springfield", fast);`)).toEqual({
    result: {
      picked: false,
      reason: "option_ambiguous",
      wanted: "Springfield",
      available: ["Springfield, Illinois", "Springfield, Missouri", "Shelbyville"],
      matches: ["Springfield, Illinois", "Springfield, Missouri"],
    },
  });
  expect(await submitted(page)).toEqual({ city: "" });
  expect(await call(page, `return await pickValue(${city}, "Springfield", { ...fast, tie: "first" });`)).toEqual({
    result: {
      picked: true,
      kind: "select",
      label: "Springfield, Illinois",
      value: "spf-il",
      rank: "leading",
      refills: 0,
      tied: ["Springfield, Illinois", "Springfield, Missouri"],
    },
  });
  expect(await submitted(page)).toEqual({ city: "spf-il" });
  // One match is picked as before, with no tie to report, and a value the site lacks is still refused.
  expect(await call(page, `return await pickValue(${city}, "Shelbyville", { ...fast, tie: "first" });`)).toEqual({
    result: { picked: true, kind: "select", label: "Shelbyville", value: "shb", rank: "exact", refills: 0 },
  });
  expect(await call(page, `return await pickValue(${city}, "Capital City", { ...fast, tie: "first" });`)).toEqual({
    result: {
      picked: false,
      reason: "option_missing",
      wanted: "Capital City",
      available: ["Springfield, Illinois", "Springfield, Missouri", "Shelbyville"],
      matches: [],
    },
  });
  expect(await submitted(page)).toEqual({ city: "shb" });
});

test("pickValue with tie first takes a city whose name before its comma is the value over one holding it as a word", async ({ page }) => {
  await serve(page, `<form><label>City <select name="city">
<option value="">Choose a city</option><option value="nyc">New York</option>
<option value="yrk">York, UK</option><option value="ykt">Yorktown</option></select></label></form>`);
  const city = 'page.getByLabel("City")';
  // Without tie first, both hold York as a word and tie, refused as before.
  expect(await call(page, `return await pickValue(${city}, "York", fast);`)).toEqual({
    result: {
      picked: false,
      reason: "option_ambiguous",
      wanted: "York",
      available: ["New York", "York, UK", "Yorktown"],
      matches: ["New York", "York, UK"],
    },
  });
  expect(await submitted(page)).toEqual({ city: "" });
  // With it, York, UK is York before its comma, while New York only holds York as a word, so
  // nothing ties.
  expect(await call(page, `return await pickValue(${city}, "York", { ...fast, tie: "first" });`)).toEqual({
    result: { picked: true, kind: "select", label: "York, UK", value: "yrk", rank: "leading", refills: 0 },
  });
  expect(await submitted(page)).toEqual({ city: "yrk" });
  expect(await call(page, `return await pickValue(${city}, "New York", fast);`)).toEqual({
    result: { picked: true, kind: "select", label: "New York", value: "nyc", rank: "exact", refills: 0 },
  });
  expect(await submitted(page)).toEqual({ city: "nyc" });
});

test("pickValue with tie first picks options with one label by position, skipping a greyed-out one", async ({ page }) => {
  await serve(page, `<form>
<label>Branch <select name="branch"><option value="">Choose a branch</option>
<option value="b-40">Springfield</option><option value="b-12">Springfield</option><option value="b-7">Shelbyville</option></select></label>
<label>Depot <select name="depot"><option value="">Choose a depot</option>
<option value="d-1" disabled>Springfield</option><option value="d-2">Springfield</option><option value="d-3">Springfield</option></select></label>
<label>Yard <select name="yard"><option value="">Choose a yard</option>
<option value="y-1" disabled>Springfield</option><option value="y-2" disabled>Springfield</option><option value="y-3">Shelbyville</option></select></label>
</form>`);
  const tie = '{ ...fast, tie: "first" }';
  expect(await call(page, `return await pickValue(page.getByLabel("Branch"), "Springfield", ${tie});`)).toEqual({
    result: {
      picked: true,
      kind: "select",
      label: "Springfield",
      value: "b-40",
      rank: "exact",
      refills: 0,
      tied: ["Springfield [b-40]", "Springfield [b-12]"],
    },
  });
  expect(await call(page, `return await pickValue(page.getByLabel("Depot"), "Springfield", ${tie});`)).toEqual({
    result: {
      picked: true,
      kind: "select",
      label: "Springfield",
      value: "d-2",
      rank: "exact",
      refills: 0,
      tied: ["Springfield [d-1]", "Springfield [d-2]", "Springfield [d-3]"],
    },
  });
  // Every tied option greyed out is a value the site does not offer now.
  expect(await call(page, `return await pickValue(page.getByLabel("Yard"), "Springfield", ${tie});`)).toEqual({
    result: {
      picked: false,
      reason: "option_disabled",
      wanted: "Springfield",
      available: ["Shelbyville"],
      matches: ["Springfield [y-1]", "Springfield [y-2]"],
    },
  });
  expect(await submitted(page)).toEqual({ branch: "b-40", depot: "d-2", yard: "" });
});

test("pickValue with tie first clicks the first of identical options in a dropdown, not one found again by its label", async ({ page }) => {
  // The options carry no value, so only their position tells them apart; the page records the
  // position of the one clicked.
  await serve(page, `<form><button type="button" id="pick" aria-label="Office" aria-haspopup="listbox" aria-expanded="false" aria-controls="offices">Choose</button>
<div id="offices" role="listbox" hidden><div role="option">Shelbyville</div><div role="option">Springfield</div><div role="option">Springfield</div></div>
<input type="hidden" name="office"></form>
<script>
const button = document.getElementById("pick"), list = document.getElementById("offices");
button.addEventListener("click", () => { list.hidden = !list.hidden; button.setAttribute("aria-expanded", String(!list.hidden)); });
list.addEventListener("click", (event) => {
  const option = event.target.closest("[role=option]");
  if (!option) return;
  button.textContent = option.textContent;
  document.querySelector("[name=office]").value = String([...list.children].indexOf(option));
  list.hidden = true;
  button.setAttribute("aria-expanded", "false");
});
</script>`);
  const office = 'page.getByRole("button", { name: "Office" })';
  expect(await call(page, `return await pickValue(${office}, "Springfield", fast);`)).toEqual({
    result: { picked: false, reason: "option_ambiguous", wanted: "Springfield", available: ["Shelbyville", "Springfield"], matches: ["Springfield", "Springfield"] },
  });
  expect(await submitted(page)).toEqual({ office: "" });
  expect(await call(page, `return await pickValue(${office}, "Springfield", { ...fast, tie: "first" });`)).toEqual({
    result: { picked: true, kind: "dropdown", label: "Springfield", value: "", rank: "exact", refills: 0, tied: ["Springfield", "Springfield"] },
  });
  expect(await submitted(page)).toEqual({ office: "1" });
});

test("pickValue with tie first clicks the first enabled of identical options in a dropdown when the first is greyed out", async ({ page }) => {
  // The options carry no value and share one label, so only their position tells them apart; the
  // first is greyed out and ignores clicks, and the page records the position of the one clicked.
  await serve(page, `<form><button type="button" id="pick" aria-label="Office" aria-haspopup="listbox" aria-expanded="false" aria-controls="offices">Choose</button>
<div id="offices" role="listbox" hidden><div role="option">Shelbyville</div><div role="option" aria-disabled="true">Springfield</div><div role="option">Springfield</div><div role="option">Springfield</div></div>
<input type="hidden" name="office"></form>
<script>
const button = document.getElementById("pick"), list = document.getElementById("offices");
button.addEventListener("click", () => { list.hidden = !list.hidden; button.setAttribute("aria-expanded", String(!list.hidden)); });
list.addEventListener("click", (event) => {
  const option = event.target.closest("[role=option]");
  if (!option || option.getAttribute("aria-disabled") === "true") return;
  button.textContent = option.textContent;
  document.querySelector("[name=office]").value = String([...list.children].indexOf(option));
  list.hidden = true;
  button.setAttribute("aria-expanded", "false");
});
</script>`);
  const office = 'page.getByRole("button", { name: "Office" })';
  expect(await call(page, `return await pickValue(${office}, "Springfield", { ...fast, tie: "first" });`)).toEqual({
    result: { picked: true, kind: "dropdown", label: "Springfield", value: "", rank: "exact", refills: 0, tied: ["Springfield", "Springfield", "Springfield"] },
  });
  expect(await submitted(page)).toEqual({ office: "2" });
});

test("pickValue scrolls a virtualized list to an option it has not rendered yet", async ({ page }) => {
  await serve(page, `<form><button type="button" aria-label="Item" aria-haspopup="listbox" aria-controls="items" aria-expanded="false">Choose</button>
<div id="items" role="listbox" hidden style="height:200px;overflow-y:auto;position:relative">
<div id="spacer" style="position:relative"></div></div><input type="hidden" name="item"></form>
<script>
const button = document.querySelector("button"), list = document.getElementById("items"), spacer = document.getElementById("spacer");
const total = 200, height = 24;
spacer.style.height = total * height + "px";
// Only the rows in view, and a few beyond, are in the page.
const render = () => {
  const first = Math.max(0, Math.floor(list.scrollTop / height) - 2);
  spacer.innerHTML = "";
  for (let index = first; index < Math.min(total, first + 20); index++)
    spacer.insertAdjacentHTML("beforeend", '<div role="option" data-value="i' + index + '" style="position:absolute;top:' + index * height + 'px;height:' + height + 'px">Item ' + index + "</div>");
};
list.addEventListener("scroll", render);
button.addEventListener("click", () => { list.hidden = false; button.setAttribute("aria-expanded", "true"); render(); });
list.addEventListener("click", (event) => {
  const option = event.target.closest("[role=option]");
  button.textContent = option.textContent;
  document.querySelector("[name=item]").value = option.dataset.value;
  list.hidden = true;
  button.setAttribute("aria-expanded", "false");
});
</script>`);
  expect(await call(page, `return await pickValue(page.getByRole("button", { name: "Item" }), "Item 150", fast);`)).toMatchObject({
    result: { picked: true, label: "Item 150", value: "i150", rank: "exact" },
  });
  expect(await submitted(page)).toEqual({ item: "i150" });
});

test("pickValue scrolls a list that loads more options from the site as it scrolls", async ({ page }) => {
  await serve(
    page,
    `<form><button type="button" aria-label="Region" aria-haspopup="listbox" aria-controls="regions" aria-expanded="false">Choose</button>
<ul id="regions" role="listbox" hidden style="height:150px;overflow-y:auto;margin:0"></ul></form>
<script>
const button = document.querySelector("button"), list = document.getElementById("regions");
let next = 0, busy = false;
const more = async () => {
  if (busy || next >= 100) return;
  busy = true;
  list.setAttribute("aria-busy", "true");
  const names = await (await fetch("/api/regions?from=" + next)).json();
  list.insertAdjacentHTML("beforeend", names.map((name) => '<li role="option" style="height:20px">' + name + "</li>").join(""));
  next += names.length;
  list.removeAttribute("aria-busy");
  busy = false;
};
list.addEventListener("scroll", () => { if (list.scrollTop + list.clientHeight >= list.scrollHeight - 10) more(); });
button.addEventListener("click", () => { list.hidden = false; button.setAttribute("aria-expanded", "true"); if (next === 0) more(); });
list.addEventListener("click", (event) => { button.textContent = event.target.textContent; list.hidden = true; button.setAttribute("aria-expanded", "false"); });
</script>`,
    (params) => {
      const from = Number(params.get("from"));
      return { delayMs: 60, body: Array.from({ length: 20 }, (_, index) => `Region ${from + index}`) };
    },
  );
  expect(await call(page, `return await pickValue(page.getByRole("button", { name: "Region" }), "Region 87", fast);`)).toMatchObject({
    result: { picked: true, label: "Region 87" },
  });
  await expect(page.getByRole("button", { name: "Region" })).toHaveText("Region 87");
});

test("pickValue works inside a shadow root", async ({ page }) => {
  await serve(page, `<form><picker-box></picker-box></form>
<script>
customElements.define("picker-box", class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = '<label>Team <input role="combobox" aria-controls="teams" autocomplete="off"></label><ul id="teams" role="listbox" hidden></ul>';
    const input = root.querySelector("input"), list = root.getElementById("teams");
    input.addEventListener("input", () => {
      list.hidden = false;
      list.innerHTML = ["Design", "Data", "Development"].filter((name) => name.toLowerCase().startsWith(input.value.toLowerCase()))
        .map((name) => '<li role="option">' + name + "</li>").join("");
    });
    list.addEventListener("click", (event) => { input.value = event.target.textContent; list.hidden = true; });
  }
});
</script>`);
  expect(await call(page, `return await pickValue(page.getByRole("combobox", { name: "Team" }), "Data", fast);`)).toMatchObject({
    result: { picked: true, label: "Data", rank: "exact" },
  });
  await expect(page.getByRole("combobox", { name: "Team" })).toHaveValue("Data");
});

test("pickValue works inside an iframe", async ({ page }) => {
  await serve(page, `<iframe src="/frame" style="width:400px;height:300px"></iframe>`, undefined, { "/frame": combobox });
  expect(
    await call(page, `return await pickValue(page.frameLocator("iframe").getByRole("combobox", { name: "Assignee" }), "Quinn Avery", fast);`),
  ).toMatchObject({ result: { picked: true, label: "Quinn Avery", value: "5" } });
  await expect(page.frameLocator("iframe").locator("[name=person]")).toHaveValue("5");
});

/** A combobox whose options ignore the mouse: ArrowDown moves the active option, Enter commits. */
const keyboardOnly = `
<form><label>Priority <input id="priority" role="combobox" aria-controls="levels" aria-expanded="false" autocomplete="off"></label>
<ul id="levels" role="listbox" hidden></ul><input type="hidden" name="priority"></form>
<script>
const input = document.getElementById("priority"), list = document.getElementById("levels");
const levels = ["Low", "Normal", "High", "Urgent"];
let active = -1;
const draw = () => {
  const shown = levels.filter((name) => name.toLowerCase().includes(input.value.toLowerCase()));
  list.innerHTML = shown.map((name, index) => '<li role="option" id="lvl-' + index + '"' + (index === active ? ' class="is-active"' : "") + ">" + name + "</li>").join("");
  input.setAttribute("aria-activedescendant", active >= 0 ? "lvl-" + active : "");
  list.hidden = false;
  input.setAttribute("aria-expanded", "true");
};
input.addEventListener("input", () => { active = -1; draw(); });
input.addEventListener("keydown", (event) => {
  const count = list.querySelectorAll("[role=option]").length;
  if (event.key === "ArrowDown") { active = Math.min(count - 1, active + 1); draw(); event.preventDefault(); }
  if (event.key === "Enter" && active >= 0) {
    input.value = list.querySelectorAll("[role=option]")[active].textContent;
    document.querySelector("[name=priority]").value = input.value;
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    event.preventDefault();
  }
});
</script>`;

test("pickValue falls back to ArrowDown and Enter when a click does not commit", async ({ page }) => {
  await serve(page, keyboardOnly);
  expect(await call(page, `return await pickValue(page.getByLabel("Priority"), "High", fast);`)).toMatchObject({
    result: { picked: true, label: "High", refills: 1 },
  });
  expect(await submitted(page)).toEqual({ priority: "High" });
});

test("pickValue selects with the keyboard alone when asked", async ({ page }) => {
  await serve(page, keyboardOnly);
  expect(await call(page, `return await pickValue(page.getByLabel("Priority"), "Urgent", { ...fast, commit: "keyboard" });`)).toMatchObject({
    result: { picked: true, label: "Urgent", refills: 0 },
  });
  expect(await submitted(page)).toEqual({ priority: "Urgent" });
});

test("pickValue blurs the field when the site commits a choice only on blur", async ({ page }) => {
  await serve(page, `<form><label>Airport <input id="airport" autocomplete="off"></label>
<ul id="airports" role="listbox"></ul><output id="chosen"></output></form>
<script>
const input = document.getElementById("airport"), list = document.getElementById("airports");
const airports = ["Oslo (OSL)", "Osaka (KIX)"];
input.addEventListener("input", () => {
  list.innerHTML = airports.filter((name) => name.toLowerCase().includes(input.value.toLowerCase())).map((name) => '<li role="option">' + name + "</li>").join("");
});
list.addEventListener("mousedown", (event) => event.preventDefault());
list.addEventListener("click", (event) => { input.value = event.target.textContent; list.innerHTML = ""; });
// The choice counts only once the field loses focus holding a listed name.
input.addEventListener("blur", () => { if (airports.includes(input.value)) document.getElementById("chosen").textContent = input.value; });
</script>`);
  expect(
    await call(page, `return await pickValue(page.getByLabel("Airport"), "OSL", { ...fast, committed: page.locator("#chosen") });`),
  ).toMatchObject({ result: { picked: true, label: "Oslo (OSL)", rank: "words", refills: 0 } });
  await expect(page.locator("#chosen")).toHaveText("Oslo (OSL)");
});

/** A grid cell editor that saves only when Tab leaves it. */
const tabCommit = `
<table><tr><td><input aria-label="Status" role="combobox" aria-controls="statuses" autocomplete="off"><ul id="statuses" role="listbox" hidden></ul></td>
<td id="status-cell">Open</td><td><input aria-label="Notes"></td></tr></table>
<script>
const input = document.querySelector("[aria-label=Status]"), list = document.getElementById("statuses");
const statuses = ["Open", "In progress", "Closed"];
let active = -1;
const draw = () => {
  const shown = statuses.filter((name) => name.toLowerCase().includes(input.value.toLowerCase()));
  list.innerHTML = shown.map((name, index) => '<li role="option" id="st-' + index + '">' + name + "</li>").join("");
  input.setAttribute("aria-activedescendant", active >= 0 ? "st-" + active : "");
  list.hidden = false;
};
input.addEventListener("input", () => { active = -1; draw(); });
list.addEventListener("mousedown", (event) => event.preventDefault());
list.addEventListener("click", (event) => { input.value = event.target.textContent; list.hidden = true; });
input.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") { active++; draw(); event.preventDefault(); }
  if (event.key === "Enter" && active >= 0) { input.value = list.querySelectorAll("li")[active].textContent; list.hidden = true; event.preventDefault(); }
  if (event.key === "Tab" && statuses.includes(input.value)) document.getElementById("status-cell").textContent = input.value;
});
</script>`;

test("pickValue presses Tab to commit when asked, and tries Tab on a refill when it was not", async ({ page }) => {
  await serve(page, tabCommit);
  const cell = 'page.locator("#status-cell")';
  expect(
    await call(page, `return await pickValue(page.getByLabel("Status"), "Closed", { ...fast, blur: "tab", committed: ${cell} });`),
  ).toMatchObject({ result: { picked: true, label: "Closed", refills: 0 } });
  await expect(page.locator("#status-cell")).toHaveText("Closed");
  expect(
    await call(page, `return await pickValue(page.getByLabel("Status"), "In progress", { ...fast, committed: ${cell} });`),
  ).toMatchObject({ result: { picked: true, label: "In progress", refills: 1 } });
  await expect(page.locator("#status-cell")).toHaveText("In progress");
});

test("pickValue opens a dropdown built from plain divs and reads the choice back from it", async ({ page }) => {
  await serve(page, `<form><div class="field"><span>Size</span>
<div class="dd" id="size" tabindex="0">Pick a size</div>
<div class="dd-menu" style="display:none;border:1px solid #999">
  <div class="dd-item" data-value="s"><span class="dd-item-label">Small</span></div>
  <div class="dd-item" data-value="m"><span class="dd-item-label">Medium</span></div>
  <div class="dd-item" data-value="l"><span class="dd-item-label">Large</span></div>
</div></div><input type="hidden" name="size"></form>
<script>
const control = document.getElementById("size"), menu = document.querySelector(".dd-menu");
control.addEventListener("click", () => { menu.style.display = menu.style.display === "none" ? "block" : "none"; });
menu.addEventListener("click", (event) => {
  const item = event.target.closest(".dd-item");
  control.textContent = item.textContent.trim();
  document.querySelector("[name=size]").value = item.dataset.value;
  menu.style.display = "none";
});
</script>`);
  expect(await call(page, `return await pickValue(page.locator("#size"), "medium", fast);`)).toEqual({
    result: { picked: true, kind: "dropdown", label: "Medium", value: "m", rank: "normalized", refills: 0 },
  });
  expect(await submitted(page)).toEqual({ size: "m" });
});

test("pickValue never picks an Add or Create row for a value the list lacks", async ({ page }) => {
  await serve(page, `<form><label>Vendor <input id="vendor" role="combobox" aria-controls="vendors" autocomplete="off"></label>
<ul id="vendors" role="listbox"></ul></form>
<script>
const input = document.getElementById("vendor"), list = document.getElementById("vendors");
input.addEventListener("input", () => {
  const names = ["Northwind Traders", "Contoso Supplies"].filter((name) => name.toLowerCase().includes(input.value.toLowerCase()));
  list.innerHTML = names.map((name) => '<li role="option">' + name + "</li>").join("") +
    '<li role="option" class="create-option">Add "' + input.value + '"</li>';
});
</script>`);
  expect(await call(page, `return await pickValue(page.getByLabel("Vendor"), "Fabrikam", fast);`)).toEqual({
    result: { picked: false, reason: "option_missing", wanted: "Fabrikam", available: [], matches: [] },
  });
});

test("pickValue fails fast as popup_missing when the control opens nothing", async ({ page }) => {
  await serve(page, `<button type="button" aria-label="Broken" aria-haspopup="listbox">Choose</button>`);
  expect(await call(page, `return await pickValue(page.getByRole("button", { name: "Broken" }), "Anything", fast);`)).toEqual({
    error: "popup_missing",
  });
});

test("pickValue fails as options_loading when the list never finishes loading", async ({ page }) => {
  await serve(page, `<label>Account <input id="account" autocomplete="off"></label><div id="box"></div>
<script>document.getElementById("account").addEventListener("input", () => {
  document.getElementById("box").innerHTML = '<div class="spinner" role="progressbar" style="width:20px;height:20px">…</div>';
});</script>`);
  // The reason stays fixed, as code compares it; the stack's first line, which a host logs, and
  // the failure's loading say what still showed: kinds and counts, never the page's text.
  expect(await callFailure(page, `return await pickValue(page.getByLabel("Account"), "Savings", { ...fast, timeout: 2000 });`)).toEqual({
    error: "options_loading",
    stack: "PickerFailure: options_loading (1 new loading sign: progress bar (div) on the page)",
  });
  expect(
    await call(
      page,
      `try { await pickValue(page.getByLabel("Account"), "Savings", { ...fast, timeout: 2000 }); }
      catch (error) { return { name: error.name, message: error.message, loading: error.loading }; }`,
    ),
  ).toEqual({
    result: {
      name: "PickerFailure",
      message: "options_loading",
      loading: {
        signs: 1,
        kinds: [{ sign: "progressbar", tag: "div", where: "page" }],
        rows: 0,
        listBusy: false,
        requests: 0,
        requestTypes: [],
        oldestRequestMs: 0,
        answered: null,
      },
    },
  });
});

test("pickValue's options_loading names a request its typing started that never answered", async ({ page }) => {
  await serve(
    page,
    `<label>Account <input id="account" autocomplete="off"></label><ul id="accounts" role="listbox"></ul>
<script>document.getElementById("account").addEventListener("input", (event) => { fetch("/accounts?q=" + encodeURIComponent(event.target.value)); });</script>`,
    () => ({ body: [], delayMs: 5000 }),
  );
  const failed = await callFailure(page, `return await pickValue(page.getByLabel("Account"), "Savings", { ...fast, timeout: 2000 });`);
  expect(failed.error).toBe("options_loading");
  expect(failed.stack).toMatch(/^PickerFailure: options_loading \(1 request it started in flight \(fetch, \d+\.\d s\)\)$/u);
});

test("pickValue waits for a site's own answered signal when given one", async ({ page }) => {
  await serve(page, `<label>Code <input id="code" role="combobox" aria-controls="codes" autocomplete="off"></label>
<ul id="codes" role="listbox" data-query=""></ul>
<script>
const input = document.getElementById("code"), list = document.getElementById("codes");
input.addEventListener("input", () => {
  // The old options stay until the new answer, which arrives in two parts.
  setTimeout(() => { list.insertAdjacentHTML("beforeend", '<li role="option">' + input.value + '-A</li>'); }, 150);
  setTimeout(() => { list.innerHTML = '<li role="option">' + input.value + '</li><li role="option">' + input.value + '-B</li>'; list.dataset.query = input.value; }, 450);
});
list.addEventListener("click", (event) => { input.value = event.target.textContent; list.innerHTML = ""; });
</script>`);
  expect(
    await call(
      page,
      `return await pickValue(page.getByLabel("Code"), "ZX9", { ...fast, answered: async (popup, query) => (await popup.getAttribute("data-query")) === query });`,
    ),
  ).toMatchObject({ result: { picked: true, label: "ZX9", rank: "exact" } });
});

test("pickValue fails as timeout, a fixed reason, when its control never shows", async ({ page }) => {
  await serve(page, `<p>No picker here</p>`);
  expect(await call(page, `return await pickValue(page.getByLabel("Missing"), "Anything", { ...fast, timeout: 500 });`)).toEqual({
    error: "timeout",
  });
});

test("pickValue never presses Enter in a form when no option became active, so the form is not submitted", async ({ page }) => {
  await serve(page, `<form id="ticket"><label>Severity <input id="severity" role="combobox" aria-controls="levels" autocomplete="off"></label>
<ul id="levels" role="listbox" hidden></ul><button type="submit">Save</button></form><output id="submits">0</output>
<script>
const input = document.getElementById("severity"), list = document.getElementById("levels");
// The saved choice is marked selected; clicks and keys change nothing.
input.addEventListener("input", () => {
  list.hidden = false;
  list.innerHTML = ["Low", "High"].map((name) => '<li role="option"' + (name === "High" ? ' aria-selected="true"' : "") + ">" + name + "</li>").join("");
});
document.getElementById("ticket").addEventListener("submit", (event) => { event.preventDefault(); document.getElementById("submits").textContent++; });
</script>`);
  expect(await call(page, `return await pickValue(page.getByLabel("Severity"), "High", { ...fast, refills: 1 });`)).toEqual({ error: "not_committed" });
  await expect(page.locator("#submits")).toHaveText("0");
});

test("pickValue ignores a page's background polling while it waits", async ({ page }) => {
  await serve(page, `${combobox}<script>setInterval(() => fetch("/api/heartbeat"), 150);</script>`, () => ({ delayMs: 60, body: {} }));
  expect(await call(page, `return await pickValue(page.getByRole("combobox", { name: "Assignee" }), "Quinn Avery", fast);`)).toMatchObject({
    result: { picked: true, label: "Quinn Avery", value: "5" },
  });
});

test("pickValue reads a virtualized list to its end and reports a tie further down", async ({ page }) => {
  await serve(page, `<button type="button" aria-label="Contact" aria-haspopup="listbox" aria-controls="contacts" aria-expanded="false">Choose</button>
<div id="contacts" role="listbox" hidden style="height:200px;overflow-y:auto;position:relative"><div id="rows" style="position:relative"></div></div>
<script>
const button = document.querySelector("button"), list = document.getElementById("contacts"), rows = document.getElementById("rows");
const total = 160, height = 24;
const name = (index) => (index === 3 || index === 150 ? "Ana Silva" : "Contact " + index);
rows.style.height = total * height + "px";
const render = () => {
  const first = Math.max(0, Math.floor(list.scrollTop / height) - 2);
  rows.innerHTML = "";
  for (let index = first; index < Math.min(total, first + 20); index++)
    rows.insertAdjacentHTML("beforeend", '<div role="option" data-value="c' + index + '" style="position:absolute;top:' + index * height + 'px">' + name(index) + "</div>");
};
list.addEventListener("scroll", render);
button.addEventListener("click", () => { list.hidden = false; button.setAttribute("aria-expanded", "true"); render(); });
</script>`);
  expect(await call(page, `return await pickValue(page.getByRole("button", { name: "Contact" }), "Ana Silva", fast);`)).toMatchObject({
    result: { picked: false, reason: "option_ambiguous", matches: ["Ana Silva [c3]", "Ana Silva [c150]"] },
  });
});

test("pickValue waits for a refill's own save and reports a choice the page reverts again", async ({ page }) => {
  // The save takes longer than the hold window, and the same save is sent again on the refill.
  await serve(page, gridEditor("always"), () => ({ delayMs: 500, body: {} }));
  expect(await call(page, `return await pickValue(page.getByLabel("Owner"), "Casey Ng", { ...fast, refills: 1 });`)).toEqual({
    error: "not_committed",
  });
  await expect(page.getByLabel("Owner")).toHaveValue("Avery Lee");
});

test("pickValue keeps options whose names start like a prompt", async ({ page }) => {
  await serve(page, dropdown([["a", "Type A"], ["b", "Type B"], ["m", "Enter manually"], ["o", "Other"]]).replace(/ data-value="[a-z]"/g, ""));
  expect(await call(page, `return await pickValue(page.getByRole("button", { name: "Customer" }), "Type B", fast);`)).toMatchObject({
    result: { picked: true, label: "Type B", rank: "exact" },
  });
  await expect(page.getByRole("button", { name: "Customer" })).toHaveText("Type B");
});

test("pickValue never mistakes its own repeated saves for a page's poller, however many refills it has", async ({ page }) => {
  await serve(page, gridEditor("always"), () => ({ delayMs: 500, body: {} }));
  expect(await call(page, `return await pickValue(page.getByLabel("Owner"), "Casey Ng", { ...fast, refills: 3, timeout: 15000 });`)).toEqual({
    error: "not_committed",
  });
  await expect(page.getByLabel("Owner")).toHaveValue("Avery Lee");
});
