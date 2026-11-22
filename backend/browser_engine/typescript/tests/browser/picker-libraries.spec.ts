import { expect, test } from "@playwright/test";
import { call, serve, submitted } from "./picker-fixture.js";

// The picker helper on synthetic pages that reproduce the markup and event handling common UI
// libraries use for pickers: a hidden select with a search dropdown, a results list that commits
// on mouseup, a menu with no ARIA roles, a screen-reader copy of the list beside the visible one,
// a list appended to the body, chips, free-entry tags and lookup dialogs. Chromium must generate
// the events: the widgets open on mousedown, commit on mouseup, click or Enter, and filter on keys.

test("pickValue drives a hidden select's search dropdown that loads results remotely", async ({ page }) => {
  await serve(
    page,
    `<form><label id="lang-label">Language</label>
<select name="lang" style="position:absolute;width:1px;height:1px;clip:rect(0 0 0 0);overflow:hidden" tabindex="-1" aria-hidden="true">
<option value=""></option></select>
<span class="select2-container"><span class="select2-selection" role="combobox" aria-labelledby="lang-label" aria-haspopup="true" aria-expanded="false" tabindex="0">
<span class="select2-selection__rendered">Choose…</span></span></span></form>
<script>
const select = document.querySelector("select"), selection = document.querySelector(".select2-selection");
let dropdown = null;
const close = () => { dropdown?.remove(); dropdown = null; selection.setAttribute("aria-expanded", "false"); };
selection.addEventListener("mousedown", (event) => {
  event.preventDefault();
  if (dropdown) return close();
  dropdown = document.createElement("span");
  dropdown.className = "select2-dropdown";
  dropdown.style.cssText = "position:absolute;top:60px;left:8px;width:260px;background:#fff;border:1px solid #aaa";
  dropdown.innerHTML = '<span class="select2-search"><input class="select2-search__field" type="search" aria-controls="lang-results" autocomplete="off"></span>' +
    '<span class="select2-results"><ul class="select2-results__options" role="listbox" id="lang-results">' +
    '<li class="select2-results__option select2-results__message" role="alert">Please enter 1 or more characters</li></ul></span>';
  document.body.append(dropdown);
  selection.setAttribute("aria-expanded", "true");
  const search = dropdown.querySelector("input"), results = dropdown.querySelector("ul");
  search.focus();
  search.addEventListener("input", async () => {
    results.innerHTML = '<li class="select2-results__option loading-results" role="option" aria-disabled="true">Searching…</li>';
    const found = await (await fetch("/api/languages?q=" + encodeURIComponent(search.value))).json();
    if (!dropdown) return;
    results.innerHTML = found.length === 0 ? '<li class="select2-results__option select2-results__message" role="alert">No results found</li>' :
      found.map((item) => '<li class="select2-results__option" role="option" aria-selected="false" id="lang-' + item.id + '">' + item.text + "</li>").join("");
  });
  // Select2 commits on mouseup.
  results.addEventListener("mouseup", (event) => {
    const item = event.target.closest("[role=option]");
    if (!item || item.getAttribute("aria-disabled") === "true") return;
    const value = item.id.slice(5);
    select.innerHTML = '<option value="' + value + '" selected>' + item.textContent + "</option>";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector(".select2-selection__rendered").textContent = item.textContent;
    close();
  });
});
</script>`,
    (params) => {
      const all = [
        { id: "pt", text: "Portuguese" },
        { id: "pt-BR", text: "Portuguese (Brazil)" },
        { id: "es", text: "Spanish" },
        { id: "sv", text: "Swedish" },
      ];
      const query = (params.get("q") ?? "").toLowerCase();
      return { delayMs: 120, body: all.filter((item) => item.text.toLowerCase().includes(query)) };
    },
  );
  expect(await call(page, `return await pickValue(page.getByRole("combobox", { name: "Language" }), "Portuguese", fast);`)).toEqual({
    result: { picked: true, kind: "dropdown", label: "Portuguese", value: "", rank: "exact", refills: 0 },
  });
  expect(await submitted(page)).toEqual({ lang: "pt" });
  await expect(page.locator(".select2-selection__rendered")).toHaveText("Portuguese");
});

/** A dropdown that opens on mousedown, filters on keyup, skips group headings and commits on mouseup. */
const chosen = `
<form><label for="fruit">Fruit</label>
<select id="fruit" name="fruit" style="display:none"><option value=""></option>
<optgroup label="Citrus"><option value="or">Orange</option><option value="le" disabled>Lemon</option><option value="gf">Grapefruit</option></optgroup>
<optgroup label="Berries"><option value="bb">Blueberry</option><option value="st">Strawberry</option></optgroup></select>
<div class="chosen-container" id="fruit_chosen" style="position:relative;width:240px">
<a class="chosen-single" tabindex="-1" style="display:block;border:1px solid #aaa"><span>Select a fruit</span></a>
<div class="chosen-drop" style="position:absolute;width:100%;background:#fff;clip:rect(0,0,0,0);clip-path:inset(100% 100%)">
<div class="chosen-search"><input class="chosen-search-input" type="text" autocomplete="off"></div><ul class="chosen-results"></ul></div></div></form>
<script>
const select = document.getElementById("fruit"), container = document.getElementById("fruit_chosen");
const drop = container.querySelector(".chosen-drop"), results = container.querySelector(".chosen-results"), search = container.querySelector("input");
const build = () => {
  const query = search.value.toLowerCase();
  results.innerHTML = [...select.querySelectorAll("optgroup")].map((group) =>
    '<li class="group-result">' + group.label + "</li>" + [...group.querySelectorAll("option")]
      .filter((option) => option.textContent.toLowerCase().includes(query))
      .map((option) => '<li class="' + (option.disabled ? "disabled-result" : "active-result") + '" data-option-array-index="' + option.index + '">' + option.textContent + "</li>").join("")
  ).join("");
};
const open = (yes) => { drop.style.clip = yes ? "auto" : "rect(0,0,0,0)"; drop.style.clipPath = yes ? "none" : "inset(100% 100%)"; if (yes) { build(); search.focus(); } };
container.querySelector(".chosen-single").addEventListener("mousedown", (event) => { event.preventDefault(); open(drop.style.clip !== "auto"); });
search.addEventListener("keyup", build);
results.addEventListener("mouseup", (event) => {
  const item = event.target.closest(".active-result");
  if (!item) return;
  select.selectedIndex = Number(item.dataset.optionArrayIndex);
  container.querySelector(".chosen-single span").textContent = item.textContent;
  open(false);
});
</script>`;

test("pickValue picks in a dropdown that commits on mouseup and lists group headings", async ({ page }) => {
  await serve(page, chosen);
  const fruit = 'page.locator("#fruit_chosen .chosen-single")';
  expect(await call(page, `return await pickValue(${fruit}, "grapefruit", fast);`)).toEqual({
    result: { picked: true, kind: "dropdown", label: "Grapefruit", value: "", rank: "normalized", refills: 0 },
  });
  expect(await submitted(page)).toEqual({ fruit: "gf" });
  // A group heading is never an option, and a disabled entry is reported, not clicked.
  expect(await call(page, `return await pickValue(${fruit}, "Citrus", fast);`)).toEqual({
    result: { picked: false, reason: "option_missing", wanted: "Citrus", available: ["Orange", "Grapefruit", "Blueberry", "Strawberry"], matches: [] },
  });
  expect(await call(page, `return await pickValue(${fruit}, "Lemon", fast);`)).toMatchObject({
    result: { picked: false, reason: "option_disabled", matches: ["Lemon"] },
  });
  expect(await submitted(page)).toEqual({ fruit: "gf" });
});

test("pickValue picks from a menu with no ARIA roles that shows the choice beside the input", async ({ page }) => {
  await serve(page, `<form><label for="color-input">Color</label>
<div class="rs-container" style="width:260px"><div class="rs__control" style="border:1px solid #ccc;display:flex">
<div class="rs__value-container"><div class="rs__placeholder">Select...</div>
<div class="rs__input-container"><input id="color-input" aria-autocomplete="list" aria-expanded="false" aria-haspopup="true" role="combobox" autocomplete="off"></div></div>
<div class="rs__indicators">▾</div></div><input type="hidden" name="color"></div></form>
<script>
const colors = ["Teal", "Navy", "Coral", "Amber", "Ivory", "Olive", "Plum", "Rust", "Sage", "Mint"];
const input = document.getElementById("color-input"), container = document.querySelector(".rs-container");
let menu = null;
const drawMenu = () => {
  menu ??= container.appendChild(Object.assign(document.createElement("div"), { className: "rs__menu" }));
  const shown = colors.filter((name) => name.toLowerCase().includes(input.value.toLowerCase()));
  menu.innerHTML = '<div class="rs__menu-list">' + (shown.length ? shown.map((name, index) => '<div class="rs__option" id="rs-option-' + index + '">' + name + "</div>").join("") : '<div class="rs__menu-notice rs__menu-notice--no-options">No options</div>') + "</div>";
  input.setAttribute("aria-expanded", "true");
};
input.addEventListener("input", drawMenu);
container.addEventListener("mousedown", (event) => { if (event.target.closest(".rs__option")) event.preventDefault(); });
container.addEventListener("click", (event) => {
  const option = event.target.closest(".rs__option");
  if (!option) return;
  container.querySelector(".rs__value-container").firstElementChild.outerHTML = '<div class="rs__single-value">' + option.textContent + "</div>";
  container.querySelector("[name=color]").value = option.textContent.toLowerCase();
  input.value = "";
  menu.remove();
  menu = null;
  input.setAttribute("aria-expanded", "false");
});
</script>`);
  expect(await call(page, `return await pickValue(page.getByRole("combobox", { name: "Color" }), "olive", fast);`)).toEqual({
    result: { picked: true, kind: "typeahead", label: "Olive", value: "", rank: "normalized", refills: 0 },
  });
  expect(await submitted(page)).toEqual({ color: "olive" });
});

test("pickValue ignores a screen-reader copy of the list and picks in the visible one by its title", async ({ page }) => {
  await serve(page, `<form><label for="city">City</label>
<div class="ant-select" style="width:260px"><div class="ant-select-selector" style="border:1px solid #ccc">
<span class="ant-select-selection-search"><input id="city" class="ant-select-selection-search-input" role="combobox" aria-expanded="false" aria-controls="city_list" aria-owns="city_list" aria-autocomplete="list" autocomplete="off"></span>
<span class="ant-select-selection-item" title=""></span></div></div></form>
<div id="city_list" role="listbox" style="height:0;width:0;overflow:hidden"></div>
<div class="ant-select-dropdown" style="position:absolute;top:60px;left:8px;width:260px;display:none">
<div class="rc-virtual-list-holder" style="max-height:120px;overflow-y:auto"><div class="rc-virtual-list-holder-inner"></div></div></div>
<script>
const cities = [["ly", "Lyon"], ["po", "Porto"], ["gz", "Graz"], ["tu", "Turku"], ["be", "Bergen"], ["gh", "Ghent"]];
const input = document.getElementById("city"), a11y = document.getElementById("city_list");
const dropdown = document.querySelector(".ant-select-dropdown"), inner = document.querySelector(".rc-virtual-list-holder-inner");
input.addEventListener("input", () => {
  const shown = cities.filter(([, name]) => name.toLowerCase().includes(input.value.toLowerCase()));
  // The screen-reader copy names only the first options; the visible list carries titles.
  a11y.innerHTML = shown.slice(0, 2).map(([value, name]) => '<div role="option" aria-label="' + name + '">' + value + "</div>").join("");
  inner.innerHTML = shown.map(([value, name]) => '<div class="ant-select-item ant-select-item-option" title="' + name + '" data-key="' + value + '"><div class="ant-select-item-option-content">' + name + "</div></div>").join("");
  dropdown.style.display = "block";
  input.setAttribute("aria-expanded", "true");
});
dropdown.addEventListener("mousedown", (event) => event.preventDefault());
dropdown.addEventListener("click", (event) => {
  const option = event.target.closest(".ant-select-item-option");
  const item = document.querySelector(".ant-select-selection-item");
  item.textContent = option.title;
  item.title = option.title;
  input.value = "";
  dropdown.style.display = "none";
  input.setAttribute("aria-expanded", "false");
});
</script>`);
  expect(await call(page, `return await pickValue(page.getByRole("combobox", { name: "City" }), "Graz", fast);`)).toEqual({
    result: { picked: true, kind: "typeahead", label: "Graz", value: "gz", rank: "exact", refills: 0 },
  });
  await expect(page.locator(".ant-select-selection-item")).toHaveText("Graz");
});

test("pickValue picks from a list appended to the body while the input shows a loading class", async ({ page }) => {
  await serve(
    page,
    `<form><label for="tags">Material</label> <input id="tags" class="ui-autocomplete-input" autocomplete="off" name="material"></form>
<div role="status" aria-live="assertive" class="ui-helper-hidden-accessible" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)"></div>
<script>
const input = document.getElementById("tags");
const menu = Object.assign(document.createElement("ul"), { className: "ui-autocomplete ui-menu ui-widget" });
menu.style.cssText = "position:absolute;top:40px;left:80px;list-style:none;padding:0;background:#fff;border:1px solid #aaa;display:none";
document.body.append(menu);
input.addEventListener("input", async () => {
  input.classList.add("ui-autocomplete-loading");
  const found = await (await fetch("/api/terms?term=" + encodeURIComponent(input.value))).json();
  input.classList.remove("ui-autocomplete-loading");
  menu.innerHTML = found.map((name) => '<li class="ui-menu-item"><div class="ui-menu-item-wrapper" tabindex="-1">' + name + "</div></li>").join("");
  menu.style.display = found.length ? "block" : "none";
  document.querySelector("[role=status]").textContent = found.length + " results are available";
});
menu.addEventListener("mouseover", (event) => { menu.querySelectorAll(".ui-state-active").forEach((node) => node.classList.remove("ui-state-active")); event.target.closest(".ui-menu-item-wrapper")?.classList.add("ui-state-active"); });
menu.addEventListener("click", (event) => { input.value = event.target.closest(".ui-menu-item-wrapper").textContent; menu.style.display = "none"; });
</script>`,
    (params) => ({
      delayMs: 150,
      body: ["Granite", "Graphite", "Gravel", "Grain"].filter((name) => name.toLowerCase().includes((params.get("term") ?? "").toLowerCase())),
    }),
  );
  expect(await call(page, `return await pickValue(page.getByLabel("Material"), "Graphite", fast);`)).toEqual({
    result: { picked: true, kind: "typeahead", label: "Graphite", value: "", rank: "exact", refills: 0 },
  });
  expect(await submitted(page)).toEqual({ material: "Graphite" });
});

/**
 * A lookup dialog: a launcher opens a modal with a search box that searches on Enter or its
 * Search button, and a results table whose row click only highlights until Select is pressed.
 */
const lookupDialog = `
<form><label>Customer <input id="customer-name" readonly></label><input type="hidden" name="customer_id">
<button type="button" id="find" aria-haspopup="dialog">Find customer</button></form>
<div role="dialog" aria-modal="true" aria-label="Find customer" hidden style="position:fixed;top:20px;left:20px;background:#fff;border:1px solid #333;padding:8px">
<input type="search" aria-label="Search customers"> <button type="button" class="go">Search</button>
<table><thead><tr><th>ID</th><th>Name</th><th>City</th></tr></thead><tbody></tbody></table>
<button type="button" id="choose" disabled>Select</button> <button type="button" id="cancel">Cancel</button></div>
<script>
const dialog = document.querySelector("[role=dialog]"), body = dialog.querySelector("tbody"), search = dialog.querySelector("input");
let highlighted = null;
document.getElementById("find").addEventListener("click", () => { dialog.hidden = false; body.innerHTML = ""; search.value = ""; });
const run = async () => {
  const rows = await (await fetch("/api/customers?q=" + encodeURIComponent(search.value))).json();
  body.innerHTML = rows.map((row) => '<tr data-id="' + row.id + '"><td>' + row.id + "</td><td>" + row.name + "</td><td>" + row.city + "</td></tr>").join("");
};
search.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); run(); } });
dialog.querySelector(".go").addEventListener("click", run);
body.addEventListener("click", (event) => {
  highlighted = event.target.closest("tr");
  body.querySelectorAll("tr").forEach((row) => row.classList.toggle("selected", row === highlighted));
  document.getElementById("choose").disabled = false;
});
document.getElementById("choose").addEventListener("click", () => {
  document.getElementById("customer-name").value = highlighted.children[1].textContent;
  document.querySelector("[name=customer_id]").value = highlighted.dataset.id;
  dialog.hidden = true;
});
document.getElementById("cancel").addEventListener("click", () => { dialog.hidden = true; });
dialog.addEventListener("keydown", (event) => { if (event.key === "Escape") dialog.hidden = true; });
</script>`;
const customers = [
  { id: "C-101", name: "Acme Insurance Group", city: "Boston" },
  { id: "C-102", name: "Acme Industrial Supply", city: "Denver" },
  { id: "C-205", name: "Globex Corporation", city: "Austin" },
];
const customerApi = (params: URLSearchParams) => ({
  delayMs: 120,
  body: customers.filter((row) => row.name.toLowerCase().includes((params.get("q") ?? "").toLowerCase())),
});

test("pickValue searches a lookup dialog on Enter, then presses its Select button", async ({ page }) => {
  await serve(page, lookupDialog, customerApi);
  expect(await call(page, `return await pickValue(page.getByRole("button", { name: "Find customer" }), "Acme Insurance Group", fast);`)).toEqual({
    result: { picked: true, kind: "dialog", label: "C-101 Acme Insurance Group Boston", value: "C-101", rank: "exact", refills: 0 },
  });
  expect(await submitted(page)).toEqual({ customer_id: "C-101" });
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("pickValue reports two rows of a lookup dialog that both match, and closes the dialog", async ({ page }) => {
  await serve(page, lookupDialog, customerApi);
  expect(await call(page, `return await pickValue(page.getByRole("button", { name: "Find customer" }), "Acme", fast);`)).toEqual({
    result: {
      picked: false,
      reason: "option_ambiguous",
      wanted: "Acme",
      available: ["C-101 Acme Insurance Group Boston", "C-102 Acme Industrial Supply Denver"],
      matches: ["C-101 Acme Insurance Group Boston", "C-102 Acme Industrial Supply Denver"],
    },
  });
  expect(await submitted(page)).toEqual({ customer_id: "" });
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("pickValue clicks the one link in a lookup row that selects it", async ({ page }) => {
  await serve(page, `<form><button type="button" id="pick-account">Choose account</button> <output id="account"></output></form>
<dialog id="accounts"><label>Find <input id="q"></label><table><tbody></tbody></table></dialog>
<script>
const dialog = document.getElementById("accounts"), body = dialog.querySelector("tbody");
document.getElementById("pick-account").addEventListener("click", () => dialog.showModal());
document.getElementById("q").addEventListener("input", (event) => {
  body.innerHTML = ["Checking 1001", "Savings 2002"].filter((name) => name.toLowerCase().includes(event.target.value.toLowerCase()))
    .map((name) => '<tr><td>' + name + '</td><td><a href="#" class="use">Use</a></td></tr>').join("");
});
body.addEventListener("click", (event) => {
  if (!event.target.matches(".use")) return;
  event.preventDefault();
  document.getElementById("account").textContent = event.target.closest("tr").cells[0].textContent;
  dialog.close();
});
</script>`);
  expect(
    await call(page, `return await pickValue(page.getByRole("button", { name: "Choose account" }), "Savings 2002", { ...fast, kind: "dialog" });`),
  ).toMatchObject({ result: { picked: true, kind: "dialog", rank: "exact" } });
  await expect(page.locator("#account")).toHaveText("Savings 2002");
});

/** Chips beside a combobox: a chip per choice, each with a delete icon. */
const chips = `
<form><label for="colors">Colors</label>
<div class="chip-field" style="border:1px solid #ccc;display:flex;flex-wrap:wrap;gap:4px;width:360px">
<div class="Chip-root" role="button" data-value="red"><span class="Chip-label">Red</span><svg class="Chip-deleteIcon" aria-label="Remove Red" width="12" height="12"><rect width="12" height="12"/></svg></div>
<input id="colors" role="combobox" aria-controls="color-options" autocomplete="off"></div>
<ul id="color-options" role="listbox" hidden></ul><input type="hidden" name="colors" value="red"></form>
<script>
const field = document.querySelector(".chip-field"), input = document.getElementById("colors"), list = document.getElementById("color-options");
const all = ["Red", "Green", "Blue", "Black", "Blue Grey"];
const sync = () => { document.querySelector("[name=colors]").value = [...field.querySelectorAll(".Chip-root")].map((chip) => chip.dataset.value).join(","); };
input.addEventListener("input", () => {
  const chosen = [...field.querySelectorAll(".Chip-label")].map((label) => label.textContent);
  list.innerHTML = all.filter((name) => !chosen.includes(name) && name.toLowerCase().includes(input.value.toLowerCase()))
    .map((name) => '<li role="option">' + name + "</li>").join("");
  list.hidden = false;
});
list.addEventListener("mousedown", (event) => event.preventDefault());
list.addEventListener("click", (event) => {
  const name = event.target.textContent;
  input.insertAdjacentHTML("beforebegin", '<div class="Chip-root" role="button" data-value="' + name.toLowerCase() + '"><span class="Chip-label">' + name +
    '</span><svg class="Chip-deleteIcon" aria-label="Remove ' + name + '" width="12" height="12"><rect width="12" height="12"/></svg></div>');
  input.value = "";
  list.hidden = true;
  sync();
});
field.addEventListener("click", (event) => { const icon = event.target.closest(".Chip-deleteIcon"); if (icon) { icon.closest(".Chip-root").remove(); sync(); } });
</script>`;

test("pickValues adds chips for new values and keeps the ones already chosen", async ({ page }) => {
  await serve(page, chips);
  expect(await call(page, `return await pickValues(page.getByRole("combobox", { name: "Colors" }), ["Blue", "red"], fast);`)).toEqual({
    result: {
      picked: true,
      kind: "typeahead",
      values: [
        { label: "Blue", value: "", added: true },
        { label: "Red", value: "red", added: false },
      ],
      removed: [],
    },
  });
  expect(await submitted(page)).toEqual({ colors: "red,blue" });
});

test("pickValues replaces the chosen chips when asked, and stops at a value the list lacks", async ({ page }) => {
  await serve(page, chips);
  expect(
    await call(page, `return await pickValues(page.getByRole("combobox", { name: "Colors" }), ["Green"], { ...fast, mode: "replace" });`),
  ).toMatchObject({ result: { picked: true, values: [{ label: "Green", added: true }], removed: ["Red"] } });
  expect(await submitted(page)).toEqual({ colors: "green" });
  expect(await call(page, `return await pickValues(page.getByRole("combobox", { name: "Colors" }), ["Black", "Purple"], fast);`)).toEqual({
    result: {
      picked: false,
      reason: "option_missing",
      wanted: "Purple",
      available: [],
      matches: [],
      values: [{ label: "Black", value: "", added: true }],
    },
  });
});

test("pickValues makes free-entry tags with Enter when asked to create them", async ({ page }) => {
  await serve(page, `<form><label for="tag-entry">Tags</label><div class="tag-input"><input id="tag-entry" autocomplete="off"></div><input type="hidden" name="tags"></form>
<script>
const input = document.getElementById("tag-entry"), box = document.querySelector(".tag-input");
input.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || input.value.trim() === "") return;
  event.preventDefault();
  input.insertAdjacentHTML("beforebegin", '<span class="tag">' + input.value.trim() + '<button type="button" aria-label="Remove">×</button></span>');
  input.value = "";
  document.querySelector("[name=tags]").value = [...box.querySelectorAll(".tag")].map((tag) => tag.firstChild.textContent).join(",");
});
</script>`);
  expect(await call(page, `return await pickValues(page.getByLabel("Tags"), ["urgent", "q3 review"], { ...fast, create: true });`)).toEqual({
    result: {
      picked: true,
      kind: "typeahead",
      values: [
        { label: "urgent", value: "", added: true },
        { label: "q3 review", value: "", added: true },
      ],
      removed: [],
    },
  });
  expect(await submitted(page)).toEqual({ tags: "urgent,q3 review" });
});

test("pickValues chooses several options of a native multiple select", async ({ page }) => {
  await serve(page, `<form><label>Days <select name="days" multiple size="5">
<option value="mon" selected>Monday</option><option value="tue">Tuesday</option><option value="wed">Wednesday</option>
<option value="thu">Thursday</option><option value="fri">Friday</option></select></label></form>`);
  expect(await call(page, `return await pickValues(page.getByLabel("Days"), ["Wednesday", "fri"], fast);`)).toEqual({
    result: {
      picked: true,
      kind: "select",
      values: [
        { label: "Wednesday", value: "wed", added: true },
        { label: "Friday", value: "fri", added: true },
      ],
      removed: [],
    },
  });
  expect(await submitted(page)).toEqual({ days: "mon,wed,fri" });
  expect(await call(page, `return await pickValues(page.getByLabel("Days"), ["Tuesday"], { ...fast, mode: "replace" });`)).toMatchObject({
    result: { picked: true, removed: ["Monday", "Wednesday", "Friday"] },
  });
  expect(await submitted(page)).toEqual({ days: "tue" });
});

test("pickValue matches a native select's option by stem only when asked", async ({ page }) => {
  await serve(page, `<form><label>Specialty <select name="specialty">
<option value="">Choose a specialty</option><option value="cd">Example Dentistry</option><option value="d">Dentistry</option>
</select></label></form>`);
  const specialty = 'page.getByLabel("Specialty")';
  expect(await call(page, `return await pickValue(${specialty}, "Dentist", fast);`)).toMatchObject({
    result: { picked: false, reason: "option_missing" },
  });
  expect(await call(page, `return await pickValue(${specialty}, "Dentist", { ...fast, stem: true });`)).toEqual({
    result: { picked: true, kind: "select", label: "Dentistry", value: "d", rank: "stem", refills: 0 },
  });
  expect(await submitted(page)).toEqual({ specialty: "d" });
});

test("pickValues matches a native multiple select's options by stem only when asked", async ({ page }) => {
  await serve(page, `<form><label>Specialties <select name="specialties" multiple size="4">
<option value="cd">Example Dentistry</option><option value="d">Dentistry</option><option value="p">Pediatrics</option>
<option value="po">Podiatry</option></select></label></form>`);
  const specialties = 'page.getByLabel("Specialties")';
  expect(await call(page, `return await pickValues(${specialties}, ["Dentist", "Pediatric"], fast);`)).toMatchObject({
    result: { picked: false, reason: "option_missing", wanted: "Dentist" },
  });
  expect(await call(page, `return await pickValues(${specialties}, ["Dentist", "Pediatric"], { ...fast, stem: true });`)).toEqual({
    result: {
      picked: true,
      kind: "select",
      values: [
        { label: "Dentistry", value: "d", added: true },
        { label: "Pediatrics", value: "p", added: true },
      ],
      removed: [],
    },
  });
  expect(await submitted(page)).toEqual({ specialties: "d,p" });
});

// The chips field with specialties for suggestions, and Enter making a free-entry chip.
const specialtyChips = chips
  .replace('const all = ["Red", "Green", "Blue", "Black", "Blue Grey"];', 'const all = ["Example Dentistry", "Dentistry"];')
  .replace(
    "list.addEventListener(\"mousedown\"",
    `input.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || input.value.trim() === "") return;
  event.preventDefault();
  const name = input.value.trim();
  input.insertAdjacentHTML("beforebegin", '<div class="Chip-root" role="button" data-value="' + name.toLowerCase() + '"><span class="Chip-label">' + name + "</span></div>");
  input.value = "";
  list.hidden = true;
  sync();
});
list.addEventListener("mousedown"`,
  );

test("pickValues adds a chip suggestion by stem when asked", async ({ page }) => {
  await serve(page, specialtyChips);
  const field = 'page.getByRole("combobox", { name: "Colors" })';
  expect(await call(page, `return await pickValues(${field}, ["Dentist"], { ...fast, stem: true });`)).toEqual({
    result: { picked: true, kind: "typeahead", values: [{ label: "Dentistry", value: "", added: true }], removed: [] },
  });
  expect(await submitted(page)).toEqual({ colors: "red,dentistry" });
});

// Replace removes the chips the call did not choose, never one it just picked by stem or as whole
// words, which its whole name does not match.
test("pickValues with replace keeps the chip it picked by stem", async ({ page }) => {
  await serve(page, specialtyChips);
  const field = 'page.getByRole("combobox", { name: "Colors" })';
  expect(await call(page, `return await pickValues(${field}, ["Dentist"], { ...fast, stem: true, mode: "replace" });`)).toEqual({
    result: { picked: true, kind: "typeahead", values: [{ label: "Dentistry", value: "", added: true }], removed: ["Red"] },
  });
  expect(await submitted(page)).toEqual({ colors: "dentistry" });
});

test("pickValues with replace keeps the chip it picked as whole words", async ({ page }) => {
  await serve(page, chips);
  const field = 'page.getByRole("combobox", { name: "Colors" })';
  expect(await call(page, `return await pickValues(${field}, ["Grey"], { ...fast, mode: "replace" });`)).toEqual({
    result: { picked: true, kind: "typeahead", values: [{ label: "Blue Grey", value: "", added: true }], removed: ["Red"] },
  });
  expect(await submitted(page)).toEqual({ colors: "blue grey" });
});

// The field stops suggesting a chosen option, so a second call finds the chip it made by stem among
// the chips, ranked as the options were, instead of refusing the value as missing.
test("pickValues finds the chip it picked by stem again once the site stops suggesting it", async ({ page }) => {
  await serve(page, specialtyChips);
  const field = 'page.getByRole("combobox", { name: "Colors" })';
  expect(await call(page, `return await pickValues(${field}, ["Dentist"], { ...fast, stem: true });`)).toMatchObject({
    result: { picked: true, values: [{ label: "Dentistry", added: true }] },
  });
  expect(await call(page, `return await pickValues(${field}, ["Dentist"], { ...fast, stem: true });`)).toEqual({
    result: { picked: true, kind: "typeahead", values: [{ label: "Dentistry", value: "dentistry", added: false }], removed: [] },
  });
  expect(await submitted(page)).toEqual({ colors: "red,dentistry" });
});

test("pickValues with create makes the typed tag rather than take a suggestion that matches only by stem", async ({ page }) => {
  await serve(page, specialtyChips);
  const field = 'page.getByRole("combobox", { name: "Colors" })';
  expect(await call(page, `return await pickValues(${field}, ["Dentist"], { ...fast, stem: true, create: true });`)).toEqual({
    result: { picked: true, kind: "typeahead", values: [{ label: "Dentist", value: "", added: true }], removed: [] },
  });
  expect(await submitted(page)).toEqual({ colors: "red,dentist" });
});

test("pickerOptions lists every option of a list that renders as it scrolls, then closes it", async ({ page }) => {
  await serve(page, `<button type="button" aria-label="Seat" aria-haspopup="listbox" aria-controls="seats" aria-expanded="false">Choose</button>
<div id="seats" role="listbox" hidden style="height:100px;overflow-y:auto;position:relative"><div id="rows" style="position:relative"></div></div>
<script>
const button = document.querySelector("button"), list = document.getElementById("seats"), rows = document.getElementById("rows");
const total = 60, height = 20;
rows.style.height = total * height + "px";
const render = () => {
  const first = Math.max(0, Math.floor(list.scrollTop / height) - 1);
  rows.innerHTML = "";
  for (let index = first; index < Math.min(total, first + 8); index++)
    rows.insertAdjacentHTML("beforeend", '<div role="option"' + (index % 10 === 9 ? ' aria-disabled="true"' : "") + ' data-value="s' + index + '" style="position:absolute;top:' + index * height + 'px">Seat ' + index + "</div>");
};
list.addEventListener("scroll", render);
button.addEventListener("click", () => { list.hidden = !list.hidden; button.setAttribute("aria-expanded", String(!list.hidden)); render(); });
list.addEventListener("keydown", (event) => { if (event.key === "Escape") { list.hidden = true; button.setAttribute("aria-expanded", "false"); } });
button.addEventListener("keydown", (event) => { if (event.key === "Escape") { list.hidden = true; button.setAttribute("aria-expanded", "false"); } });
</script>`);
  const answer = await call(page, `return await pickerOptions(page.getByRole("button", { name: "Seat" }), fast);`);
  expect(answer).toMatchObject({ result: { kind: "dropdown" } });
  const options = (answer as { result: { options: { label: string; value: string; disabled: boolean }[] } }).result.options;
  expect(options).toHaveLength(60);
  expect(options[59]).toEqual({ label: "Seat 59", value: "s59", disabled: true });
  await expect(page.getByRole("listbox")).toBeHidden();
});

test("pickValues adds a value even when a chip already holds it as a word", async ({ page }) => {
  await serve(page, chips);
  const colors = 'page.getByRole("combobox", { name: "Colors" })';
  expect(await call(page, `return await pickValues(${colors}, ["Blue Grey"], fast);`)).toMatchObject({ result: { picked: true } });
  expect(await call(page, `return await pickValues(${colors}, ["Blue"], { ...fast, mode: "replace" });`)).toEqual({
    result: { picked: true, kind: "typeahead", values: [{ label: "Blue", value: "", added: true }], removed: ["Red", "Blue Grey"] },
  });
  expect(await submitted(page)).toEqual({ colors: "blue" });
});
