import { Schema } from "effect";
import { timeoutDefaults } from "../runtime/deadline.js";
import { operationErrors } from "../runtime/operation-failure.js";
import { foldChoiceText } from "../runtime/text.js";
import { pickerRanks, rankChoices } from "./picker-rank.js";

/**
 * The page's state for one picker, read in the control's own frame: every `phase` runs this one
 * self-contained function, so it travels to the page through `evaluate` whole. It finds the
 * picker's popup (the listbox the control owns through `aria-controls`, `aria-owns` or
 * `aria-activedescendant`, else a list, menu, table or dialog that showed since the picker
 * started, else one beside the control), its options, its search box and any loading sign,
 * looking through open shadow roots. It marks what it found with `data-opengpt-pick*`
 * attributes so the page code can click them with real Playwright input.
 */
const pickerPageCode = String.raw`(element, args) => {
  const doc = element.ownerDocument;
  const win = doc.defaultView;
  const store = (win[Symbol.for("opengpt.picker")] ??= new Map());
  const state = store.get(args.token) ?? { before: new WeakSet(), signs: new WeakSet() };
  store.set(args.token, state);
  const token = args.token;
  if (args.phase === "cleanup") {
    store.delete(token);
    if (store.size === 0) delete win[Symbol.for("opengpt.picker")];
  }
  const roots = [doc];
  for (let index = 0; index < roots.length; index++)
    for (const host of roots[index].querySelectorAll("*")) if (host.shadowRoot) roots.push(host.shadowRoot);
  const up = (node) => node.parentNode || node.host || null;
  const holds = (outer, node) => {
    for (let at = node; at; at = up(at)) if (at === outer) return true;
    return false;
  };
  // Every match in the page, or within one element, through open shadow roots.
  const all = (selector, within) => {
    if (!within) return roots.flatMap((root) => [...root.querySelectorAll(selector)]);
    const home = within.getRootNode();
    const found = [...within.querySelectorAll(selector)];
    for (const root of roots) if (root !== doc && root !== home && holds(within, root.host)) found.push(...root.querySelectorAll(selector));
    return found;
  };
  const tagged = (name, value) => all("[" + name + "=" + JSON.stringify(value) + "]")[0] ?? null;
  const untag = () => {
    for (const name of ["data-opengpt-pick", "data-opengpt-pick-hit", "data-opengpt-pick-confirm"])
      for (const found of all("[" + name + "^=" + JSON.stringify(token) + "]")) found.removeAttribute(name);
  };
  if (args.phase === "cleanup") {
    untag();
    for (const name of ["data-opengpt-pick-popup", "data-opengpt-pick-search", "data-opengpt-pick-scroll", "data-opengpt-pick-go"])
      for (const found of all("[" + name + "=" + JSON.stringify(token) + "]")) found.removeAttribute(name);
    return null;
  }
  const clean = (text) => String(text ?? "").replace(/[\u200B\u2060\uFEFF\u00AD]/g, "").replace(/\s+/g, " ").trim();
  const style = (node) => win.getComputedStyle(node);
  // Shown: laid out bigger than a dot, not hidden by CSS, and not clipped to nothing by itself
  // or a wrapper (a screen-reader-only copy of a list, or a closed dropdown clipped away, is not
  // the list a person sees).
  const clippedAway = (css) =>
    /^rect\(\s*0(px)?,?\s+0(px)?,?\s+0(px)?,?\s+0(px)?\s*\)$/.test(css.clip) || /inset\(\s*(50|100)%/.test(css.clipPath);
  const shown = (node) => {
    if (!node || !node.isConnected || !(node instanceof win.Element)) return false;
    const box = node.getBoundingClientRect();
    if (box.width <= 2 || box.height <= 2) return false;
    if (node.checkVisibility && !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    if (clippedAway(style(node))) return false;
    for (let at = up(node), depth = 0; at && depth < 15; at = up(at), depth++) {
      if (!(at instanceof win.Element)) continue;
      const css = style(at);
      if (css.overflow === "visible" && css.clip === "auto" && css.clipPath === "none") continue;
      if (clippedAway(css)) return false;
      const outer = at.getBoundingClientRect();
      if (outer.width <= 2 || outer.height <= 2) return false;
    }
    return true;
  };
  const editable = (node) =>
    node instanceof win.HTMLTextAreaElement
      ? !node.readOnly && !node.disabled
      : node instanceof win.HTMLInputElement
        ? /^(|text|search|email|url|tel|number)$/i.test(node.getAttribute("type") ?? "") && !node.readOnly && !node.disabled
        : node instanceof win.HTMLElement && node.isContentEditable;
  const fieldText = (node) =>
    node instanceof win.HTMLInputElement || node instanceof win.HTMLTextAreaElement
      ? node.value
      : node instanceof win.HTMLSelectElement
        ? (node.selectedOptions[0]?.textContent ?? "") + " " + node.value
        : (node.innerText ?? node.textContent ?? "");
  const focused = () => {
    let active = doc.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
    return active;
  };
  if (args.phase === "detect") {
    if (element instanceof win.HTMLSelectElement) return element.multiple ? "select-multiple" : "select";
    if (element instanceof win.HTMLInputElement && element.list instanceof win.HTMLDataListElement) return "datalist";
    if (element.getAttribute("aria-haspopup") === "dialog") return "dialog";
    if (editable(element)) return "typeahead";
    return "dropdown";
  }
  if (args.phase === "select-shown") return shown(element);
  if (args.phase === "focus-inside") {
    const active = focused();
    return Boolean(active && active !== doc.body && (active === element || holds(element, active)));
  }
  // The smallest wrapper around the control that holds no other field a person types into or
  // picks from: it shows the committed choice (a chip, a label beside the input, a read-only
  // copy), and never a neighbour's value.
  const otherField =
    'input:not([type=hidden]):not([readonly]):not([disabled]), textarea:not([readonly]), select, [contenteditable="true"], [role=combobox], [role=textbox], [role=searchbox]';
  const wrapper = () => {
    let best = element;
    for (let at = up(element), depth = 0; at && depth < 3 && at !== doc.body && at instanceof win.Element; at = up(at), depth++) {
      const others = all(otherField, at).filter((found) => found !== element && !holds(element, found) && shown(found));
      if (others.length > 0) break;
      best = at;
    }
    return best;
  };
  const popupRoles = "[role=listbox], [role=menu], [role=option], [role=menuitem], [role=tree], [role=grid], [role=dialog]";
  const visibleText = (root) => {
    const parts = [];
    const visit = (node) => {
      if (node.nodeType === 3) {
        parts.push(node.textContent);
        return;
      }
      if (!(node instanceof win.Element)) {
        for (const child of node.childNodes ?? []) visit(child);
        return;
      }
      if (node !== root && (node.matches(popupRoles) || node.hasAttribute("data-opengpt-pick-popup"))) return;
      if (node instanceof win.HTMLInputElement || node instanceof win.HTMLTextAreaElement) {
        if (node.type !== "hidden" && node.type !== "password") parts.push(" " + node.value + " ");
        return;
      }
      if (node instanceof win.HTMLSelectElement) {
        parts.push(" " + (node.selectedOptions[0]?.textContent ?? "") + " ");
        return;
      }
      if (node !== root && !node.checkVisibility?.({ checkVisibilityCSS: true })) return;
      if (node instanceof win.HTMLElement && /^(script|style|template)$/i.test(node.tagName)) return;
      parts.push(" ");
      for (const child of node.shadowRoot ? node.shadowRoot.childNodes : node.childNodes) visit(child);
      parts.push(" ");
    };
    visit(root);
    return clean(parts.join(""));
  };
  if (args.phase === "readback") {
    const around = wrapper();
    return {
      own: clean(fieldText(element)),
      around: around === element ? "" : visibleText(around),
      hidden: all("input[type=hidden]", around).map((found) => found.value).filter((value) => value !== ""),
    };
  }
  const removeControl =
    '[aria-label*="remove" i], [aria-label*="delete" i], [aria-label*="clear" i], [title*="remove" i], [title*="delete" i], [class*="remove" i], [class*="delete" i], [class*="close" i]';
  if (args.phase === "chips") {
    untag();
    const around = args.within ?? wrapper();
    const selector = args.chips ??
      '[class*="chip" i], [class*="tag" i], [class*="token" i], [class*="pill" i], [class*="badge" i], [class*="multi-value" i], [class*="multivalue" i], [class*="selection__choice" i], [class*="search-choice" i], [class*="selection-item" i]';
    const chipClass = /chip|(^|[\s_-])tags?([\s_-]|$)|token|pill|badge|multi-?value|selection__choice|search-choice|selection-item/i;
    let found = all(selector, around).filter(
      (chip) => shown(chip) && (args.chips || chipClass.test(typeof chip.className === "string" ? chip.className : "")) && !chip.matches(removeControl) && !chip.querySelector("input, textarea") && !holds(chip, element) && !chip.closest("[data-opengpt-pick-popup]"),
    );
    // A chip is the outermost match, never a list that holds several.
    found = found.filter((chip) => !found.some((other) => other !== chip && holds(other, chip)));
    found = found.filter((chip) => all(selector, chip).filter((inner) => inner !== chip && !inner.matches(removeControl)).length < 2 || args.chips);
    return found.map((chip, index) => {
      const tag = token + "-chip-" + index;
      chip.setAttribute("data-opengpt-pick", tag);
      const remove = all(removeControl + ", button, [role=button]", chip).find((inner) => inner !== chip && shown(inner));
      if (remove) remove.setAttribute("data-opengpt-pick-hit", tag);
      const text = [...chip.childNodes].filter((node) => !(node instanceof win.Element && node === remove)).map((node) => node.textContent).join(" ");
      const label = clean(remove ? text.replace(clean(remove.textContent), "") : chip.innerText).replace(/^[\u00D7\u2715\u2716]\s*|\s*[\u00D7\u2715\u2716]$/gu, "");
      return {
        tag,
        removable: Boolean(remove),
        label: label || clean(chip.getAttribute("title")) || clean(chip.getAttribute("aria-label")),
        names: [label, clean(chip.getAttribute("title")), clean(chip.getAttribute("aria-label")), clean(chip.getAttribute("data-value"))].filter(Boolean),
        value: chip.getAttribute("data-value") ?? "",
      };
    });
  }

  // Popups, options and loading signs.
  const containers =
    '[role=listbox], [role=menu], [role=grid], [role=tree], [role=dialog], [role=alertdialog], dialog, [aria-modal="true"], ul, ol, table, [class*="menu" i], [class*="dropdown" i], [class*="popup" i], [class*="popover" i], [class*="popper" i], [class*="suggest" i], [class*="autocomplete" i], [class*="results" i], [class*="options" i], [class*="listbox" i], [class*="lookup" i], [class*="picker" i], [class*="overlay" i]';
  const loadingSigns =
    '[aria-busy="true"], [role=progressbar]:not([aria-valuenow]):not([aria-valuetext]), [class*="loading" i], [class*="spinner" i], [class*="searching" i], [class*="skeleton" i]';
  // Whole status lines, so an option such as "Loading Dock B" stays an option.
  const statusText =
    /^(no (results?|matches|options|items|records|data|suggestions)( found)?|nothing (found|matches)|loading( results| options)?|searching|please (enter|type) .{0,40}|(enter|type) (at least )?\d+ (or more )?(characters?|letters?)|type to search|start typing.{0,40}|\d+ results? (are |is )?available)[.!\u2026]*$/i;
  const loadingText = /^(loading|searching)( results| options)?[.!\u2026]*$/i;
  const excluded =
    /(^|[\s_-])(group|header|heading|separator|divider|no-?results?|no-?options|no-?matches|no-?data|empty|loading|searching|optgroup|placeholder|footer|message)([\s_-]|$)/i;
  const creation = (node, text) =>
    /^\+?\s*(add|create)\s+(new\b|["\u201C\u2018'])/i.test(text) || node.matches('[class*="create-option" i], [class*="option-create" i], [data-create]');
  const tiers = [
    "[role=option]",
    "[role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=treeitem]",
    "[role=row], tr",
    "li",
    '[data-value], [data-option], [data-id], [data-key], [data-code], [class*="option" i], [class*="item" i], [class*="result" i], [class*="suggestion" i]',
  ];
  const optionsOf = (popup, statuses) => {
    const candidates = args.option ? [args.option] : tiers;
    for (const selector of candidates) {
      let found = all(selector, popup).filter((node) => node !== popup && shown(node));
      found = found.filter((node) => {
        if (node.matches("[role=presentation], [role=none], [role=separator], [role=group], [role=heading], [role=status], [role=alert]")) return false;
        if (node.matches("tr, [role=row]") && node.querySelector("th, [role=columnheader]")) return false;
        if (node.querySelector("input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea")) return false;
        const text = clean(node.innerText);
        const hasValue = node.hasAttribute("data-value") || node.hasAttribute("data-id") || node.hasAttribute("data-key");
        if (!args.option && ((typeof node.className === "string" && excluded.test(node.className)) || (!hasValue && statusText.test(text)))) {
          statuses.push(text);
          return false;
        }
        return text !== "" || node.hasAttribute("aria-label") || node.hasAttribute("title");
      });
      // Rows and list items: the innermost. Elements found by class: the outermost that is not a
      // list of several (an option's label span is part of the option).
      if (!args.option && (selector === tiers[2] || selector === tiers[3]))
        found = found.filter((node) => !found.some((other) => other !== node && holds(node, other)));
      if (!args.option && selector === tiers[4]) {
        found = found.filter((node) => found.filter((other) => other !== node && holds(node, other)).length < 2);
        found = found.filter((node) => !found.some((other) => other !== node && holds(other, node)));
      }
      if (found.length > 0) return found;
    }
    return [];
  };
  const before = (node) => state.before.has(node);
  const kindOf = (popup) =>
    popup.matches('[role=dialog], [role=alertdialog], dialog, [aria-modal="true"]') ? "dialog" : popup.matches("[role=listbox]") ? "listbox" : popup.matches("[role=menu]") ? "menu" : popup.matches("table, [role=grid]") ? "table" : "list";
  const rankOf = (popup) =>
    popup.matches("[role=listbox]") ? 0 : popup.matches("[role=menu], [role=grid], [role=tree]") ? 1 : popup.matches('[role=dialog], [role=alertdialog], dialog, [aria-modal="true"]') ? 2 : popup.matches("table") ? 3 : popup.matches("ul, ol") ? 4 : 5;
  const ids = (node) =>
    node
      ? ["aria-controls", "aria-owns"].flatMap((name) => (node.getAttribute(name) ?? "").split(/\s+/).filter(Boolean))
      : [];
  const byId = (id, near) => {
    const root = near.getRootNode();
    return (root.getElementById ? root.getElementById(id) : null) ?? doc.getElementById(id) ?? all("[id=" + JSON.stringify(id) + "]")[0] ?? null;
  };
  const owners = [element, element.closest("[role=combobox]"), tagged("data-opengpt-pick-search", token), focused()].filter(
    (node, index, list) => node instanceof win.Element && list.indexOf(node) === index,
  );
  const kept = tagged("data-opengpt-pick-popup", token);
  // How the popup was found: given, kept from an earlier look, owned through ARIA, fresh since
  // the picker started, an opened dialog, or beside the control.
  let via = null;
  const findPopup = () => {
    via = "given";
    if (args.popup) return shown(args.popup) ? args.popup : null;
    via = "kept";
    if (kept && shown(kept) && optionsOf(kept, []).length > 0) return kept;
    via = "owned";
    for (const owner of owners) {
      const owned = [...ids(owner).map((id) => byId(id, owner))];
      const activeId = owner.getAttribute("aria-activedescendant");
      if (activeId) owned.push(byId(activeId, owner)?.closest("[role=listbox], [role=menu], [role=grid], [role=tree]") ?? null);
      for (const target of owned) {
        if (!target || !shown(target)) continue;
        const inner = target.matches(popupRoles) ? target : all("[role=listbox], [role=menu], [role=grid], [role=tree]", target).find(shown);
        if (inner) return inner;
        if (optionsOf(target, []).length > 0) return target;
      }
    }
    const fresh = all(containers).filter(
      (node) => !before(node) && !holds(node, element) && shown(node) && optionsOf(node, []).length > 0,
    );
    // A dialog that opened holds the picker's search box and results, even while they are empty.
    const dialogs = all('[role=dialog], [role=alertdialog], dialog[open], [aria-modal="true"]').filter(
      (node) => !before(node) && !holds(node, element) && shown(node),
    );
    const pool = fresh.length > 0 ? fresh : dialogs;
    via = fresh.length > 0 ? "fresh" : "dialog";
    if (pool.length === 0) {
      via = "kept";
      if (kept && shown(kept)) return kept;
      via = "near";
      if (args.near) {
        const near = wrapper();
        const beside = all(containers, up(near) ?? near).filter((node) => !before(node) && !holds(node, element) && shown(node) && optionsOf(node, []).length > 0);
        if (beside.length > 0) return beside[0];
      }
      return null;
    }
    pool.sort((a, b) => {
      const order = rankOf(a) - rankOf(b);
      if (order !== 0) return order;
      if (kindOf(a) === "dialog" && kindOf(b) === "dialog") return holds(a, b) ? 1 : holds(b, a) ? -1 : 0;
      const counts = optionsOf(b, []).length - optionsOf(a, []).length;
      if (counts !== 0) return counts;
      return holds(a, b) ? 1 : holds(b, a) ? -1 : 0;
    });
    // A dialog's options often sit in a list or table inside it: the dialog is still the popup.
    const dialog = pool.find((node) => kindOf(node) === "dialog");
    if (dialog && pool.every((node) => node === dialog || holds(dialog, node))) return dialog;
    return pool[0];
  };
  const signsShown = () => all(loadingSigns).filter((node) => (shown(node) || node === element) && !(node instanceof win.HTMLInputElement && node !== element));
  if (args.phase === "snapshot") {
    untag();
    for (const node of all(containers)) if (shown(node) && optionsOf(node, []).length > 0) state.before.add(node);
    for (const node of all('[role=dialog], [role=alertdialog], dialog[open], [aria-modal="true"]')) if (shown(node)) state.before.add(node);
    for (const node of signsShown()) state.signs.add(node);
    state.focusedBefore = focused();
    state.focusedShown = shown(state.focusedBefore);
  }
  // The target's keyboard state: named by aria-activedescendant or focused (strong signs), or
  // marked selected or with an active class (weak signs, which page code counts only once they
  // appear after its own keys, since a saved choice is often marked selected).
  if (args.phase === "active") {
    const target = tagged("data-opengpt-pick", args.tag);
    if (!target) return null;
    const activeIds = owners.map((owner) => owner.getAttribute("aria-activedescendant")).filter(Boolean);
    const classes = typeof target.className === "string" ? target.className : "";
    const field = focused();
    return {
      strong: (target.id !== "" && activeIds.includes(target.id)) || field === target,
      selected: target.getAttribute("aria-selected") === "true",
      marked:
        Boolean(target.getAttribute("data-headlessui-state")?.split(" ").includes("active")) ||
        /(^|[\s_-])(active|focused|is-focused|highlighted|highlight)([\s_-]|$)/i.test(classes),
      inForm: Boolean(field && (field.form || field.closest?.("form"))),
    };
  }

  // A scan: the popup and its options, tagged for the page code.
  untag();
  const popup = findPopup();
  const statuses = [];
  let optionNodes = popup ? optionsOf(popup, statuses) : [];
  if (popup) {
    for (const found of all("[data-opengpt-pick-popup=" + JSON.stringify(token) + "]")) if (found !== popup) found.removeAttribute("data-opengpt-pick-popup");
    popup.setAttribute("data-opengpt-pick-popup", token);
  }
  // The popup's scroller: the popup or the nearest element around its options that scrolls.
  let scroller = null;
  if (popup) {
    const scrolls = (node) => node instanceof win.Element && node.scrollHeight > node.clientHeight + 2 && /(auto|scroll)/.test(style(node).overflowY);
    for (let at = optionNodes[0] ? up(optionNodes[0]) : popup; at; at = up(at)) {
      if (scrolls(at)) {
        scroller = at;
        break;
      }
      if (at === popup) break;
    }
    if (!scroller && scrolls(popup)) scroller = popup;
    for (const found of all("[data-opengpt-pick-scroll=" + JSON.stringify(token) + "]")) if (found !== scroller) found.removeAttribute("data-opengpt-pick-scroll");
    if (scroller) {
      // The next page starts at the last option rendered, so a list that renders beyond its view
      // is stepped through by what it rendered, and never skips an option.
      if (args.scroll === "next") {
        const last = optionNodes.at(-1);
        const lastTop = last ? last.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop : 0;
        scroller.scrollTop = Math.max(scroller.scrollTop + Math.max(scroller.clientHeight - 20, 10), lastTop - 4);
      }
      else if (typeof args.scroll === "number") scroller.scrollTop = args.scroll;
      scroller.setAttribute("data-opengpt-pick-scroll", token);
      if (args.scroll !== undefined && args.scroll !== null) optionNodes = optionsOf(popup, []);
    }
  }
  // The search box a popup brings: the one it holds, or the field that took focus as it opened.
  // A popup that opened to an empty list still brings the search box that took focus.
  let search = null;
  const active = focused();
  const newlyFocused = active !== state.focusedBefore || !state.focusedShown;
  const keptSearch = tagged("data-opengpt-pick-search", token);
  if (!popup && keptSearch && editable(keptSearch) && shown(keptSearch)) search = keptSearch;
  else if (!popup && active && active !== element && newlyFocused && !holds(element, active) && editable(active) && shown(active)) search = active;
  if (popup) {
    const candidates = [
      ...(active && active !== element && editable(active) && shown(active) ? [active] : []),
      ...all("input, textarea, [contenteditable=true]", popup).filter((node) => editable(node) && shown(node)),
      ...(up(popup) ? all("input, textarea", up(popup)).filter((node) => node !== element && !holds(node, element) && editable(node) && shown(node) && !holds(wrapper(), node)) : []),
    ];
    search = candidates.find((node) => node !== element) ?? null;
  }
  for (const found of all("[data-opengpt-pick-search=" + JSON.stringify(token) + "]")) if (found !== search) found.removeAttribute("data-opengpt-pick-search");
  if (search) search.setAttribute("data-opengpt-pick-search", token);
  const counts = new Map();
  const options = optionNodes.map((node, index) => {
    const tag = token + "-" + index;
    node.setAttribute("data-opengpt-pick", tag);
    const lines = (node.innerText ?? node.textContent ?? "").split("\n").map(clean).filter(Boolean);
    const text = clean(lines.join(" "));
    const cells = node.matches("tr, [role=row]")
      ? [...node.querySelectorAll("td, [role=gridcell], [role=cell]")].map((cell) => clean(cell.innerText)).filter(Boolean)
      : [];
    const names = [...new Set([lines[0] ?? "", text, clean(node.getAttribute("aria-label")), clean(node.getAttribute("title")), clean(node.getAttribute("label")), ...cells].filter(Boolean))];
    const value =
      [...(args.valueAttributes ?? []), "data-value", "value", "data-id", "data-key", "data-code", "data-option-value", "data-item-value"]
        .map((name) => node.getAttribute(name))
        .find((found) => found !== null && found.trim() !== "") ?? "";
    const classes = typeof node.className === "string" ? node.className : "";
    const disabled =
      node.getAttribute("aria-disabled") === "true" ||
      node.hasAttribute("disabled") ||
      Boolean(node.closest('[aria-disabled="true"], fieldset[disabled]') && holds(popup, node.closest('[aria-disabled="true"], fieldset[disabled]'))) ||
      /disabled/i.test(classes) ||
      node.getAttribute("data-disabled") === "true" || node.getAttribute("data-disabled") === "";
    // A row's one link or button is what selects it.
    if (node.matches("tr, [role=row]")) {
      const actions = [...node.querySelectorAll("a[href], button, [role=button], [role=link]")].filter(shown);
      if (actions.length === 1) actions[0].setAttribute("data-opengpt-pick-hit", tag);
    }
    const base = names.join("\u0001") + "\u0000" + value;
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    return {
      tag,
      key: base + "\u0000" + seen,
      label: lines[0] || clean(node.getAttribute("aria-label")) || clean(node.getAttribute("title")) || value,
      names,
      value,
      disabled,
      creation: creation(node, text),
      selected: node.getAttribute("aria-selected") === "true" || node.getAttribute("aria-checked") === "true",
      top: scroller ? scroller.scrollTop : 0,
    };
  });
  // Still loading: a loading sign new since the snapshot (in the popup, or anywhere not around
  // it), a "Loading" or "Searching" row, or a busy popup. why says which, as kinds and counts:
  // each sign's kind, tag (a custom element's is "custom") and place, never its text.
  const fresh = signsShown().filter((node) => !state.signs.has(node) && (!popup || holds(popup, node) || !holds(node, popup)));
  const loadingRows = statuses.filter((text) => loadingText.test(text)).length;
  const listBusy = Boolean(popup && popup.getAttribute("aria-busy") === "true");
  const loading = fresh.length > 0 || loadingRows > 0 || listBusy;
  const signKind = (node) =>
    node.getAttribute("aria-busy") === "true" ? "busy"
      : node.matches("[role=progressbar]:not([aria-valuenow]):not([aria-valuetext])") ? "progressbar"
      : (/loading|spinner|searching|skeleton/i.exec(node.getAttribute("class") ?? "")?.[0].toLowerCase() ?? "busy");
  const why = loading
    ? {
        signs: fresh.length,
        kinds: fresh.slice(0, 5).map((node) => ({
          sign: signKind(node),
          tag: /^[a-z][a-z0-9]*$/i.test(node.localName) ? node.localName.toLowerCase() : "custom",
          where: node === element ? "field" : !popup ? "page" : holds(popup, node) ? "list" : "outside_list",
        })),
        rows: loadingRows,
        listBusy,
      }
    : null;
  let confirm = null;
  if (popup && kindOf(popup) === "dialog") {
    const button = all("button, [role=button], input[type=button], input[type=submit]", popup).find(
      (node) => shown(node) && !node.disabled && node.getAttribute("aria-disabled") !== "true" &&
        /^(select|choose|ok|okay|done|confirm|use)( (selected|this|item|it))?$/i.test(clean(node.innerText || node.value)),
    );
    if (button) {
      button.setAttribute("data-opengpt-pick-confirm", token);
      confirm = true;
    }
  }
  // A popup's own search button, for a search box that searches only when asked.
  let go = false;
  for (const found of all("[data-opengpt-pick-go=" + JSON.stringify(token) + "]")) found.removeAttribute("data-opengpt-pick-go");
  if (popup && search) {
    const button = all("button, [role=button], input[type=button], input[type=submit]", popup).find(
      (node) => shown(node) && !node.disabled && /^(search|find|go|look ?up)$/i.test(clean(node.innerText || node.value || node.getAttribute("aria-label"))),
    );
    if (button) {
      button.setAttribute("data-opengpt-pick-go", token);
      go = true;
    }
  }
  const inForm = Boolean(search && (search.form || search.closest("form")));
  const expanded = owners.some((owner) => owner.getAttribute("aria-expanded") === "true");
  return {
    popup: Boolean(popup),
    kept: Boolean(popup && popup === kept),
    via: popup ? via : null,
    kind: popup ? kindOf(popup) : null,
    expanded,
    loading,
    why,
    search: Boolean(search),
    go,
    inForm,
    confirm,
    scroll: scroller ? { top: scroller.scrollTop, end: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2 } : null,
    options,
    statuses: statuses.slice(0, 5),
    signature: JSON.stringify([Boolean(popup), Boolean(search), loading, statuses.length, options.map((option) => [option.names[0], option.value, option.disabled])]),
  };
}`;

/**
 * Page code for a Kernel call body, where `page` is in scope: paste it once at the top of the
 * code string, beside `formControlsCode` or `waitCode` when the call needs them too (its names
 * all start with `picker` or `pick`), then call its functions with your verified locators.
 *
 * - `pickValue(control, wanted, options?)` chooses one value in any picker: a native select, an
 *   input with a datalist, an autocomplete or typeahead, an ARIA combobox, a dropdown built from
 *   divs, a dialog with a search box and a results table. `wanted` is the caller's value or a list
 *   of its spellings (`["CA", "California"]`).
 * - `pickValues(control, values, options?)` chooses several in a multi-select: a native
 *   `select[multiple]`, or chips and tags beside a typeahead or dropdown. `options.mode` is
 *   `"add"` (default: keep the chips already there) or `"replace"` (remove the others), and
 *   `options.create` types a value the list lacks and presses Enter to make a free-entry tag.
 * - `pickerOptions(control, options?)` opens the picker (typing `options.query` when given) and
 *   returns `{ kind, options: [{ label, value, disabled }] }`, every option it lists, scrolled
 *   through when the list renders as it scrolls, then closes it: the page's live options for a
 *   caller question or an `available` list.
 *
 * The kind is detected from the control, or set as `options.kind`: `select`, `datalist`,
 * `typeahead` (an editable field: type, then choose a suggestion), `dropdown` (a button or div
 * that opens a list, typing into the search box the list brings when its first view lacks an
 * exact match) or `dialog` (the same, for a launcher that opens a dialog; it clicks the dialog's
 * Select or OK button, or double-clicks the row, when a click alone leaves the dialog open).
 *
 * Matching (see `rankChoices`): a name or value as written, then ignoring case and spacing, then
 * accents and punctuation, then, only for `pickValue` with `tie: "first"`, a name whose text
 * before its first comma (not one between digits) is the value, ignoring the same (rank `leading`:
 * York, UK for York), then a name holding the value as whole words (New York for York), then,
 * only with `options.stem` set to true (as a read sets it; `pickValues` takes it too), a name with
 * as many words as the value whose words each equal the value's in order or, for words of Latin
 * letters only, begin the value's or begin with them, the shorter of five or more letters, such as
 * Dentistry for Dentist (rank `stem`). An option's names are its text, first line, accessible name,
 * `title` and, for a table row, each cell, and its value is `data-value`, `value`, `data-id`,
 * `data-key` or `data-code` (put others first with `options.valueAttributes`). Two options at the
 * best rank are ambiguous; an "Add ..." or "Create ..." row is never matched.
 *
 * Waits follow the page, never a fixed pause: after typing, the options count once no loading
 * sign shows (a busy region, an indeterminate progress bar, a loading or spinner class, a
 * "Loading" or "Searching" row), no request the picker's actions started is in flight, and they
 * have held still for `settleMs`; with no reaction at all, the field is typed again key by key
 * (a popup's search box first gets its Search button, or Enter when it is in no form).
 * A list for a stale query that lacks the value is typed once more. A list that ends empty, or
 * with no row `option` keeps, as on a page still starting up that dropped the typing, is typed
 * once more key by key, once a call, after the page's own requests go quiet (2 s at most), when
 * more than a third of the budget is left; never with `create` or `type`. A list that renders or loads
 * as it scrolls is read to its end before matching, so a tie further down is never missed; one too
 * long for two thirds of the budget is narrowed with its search box, or fails as `options_loading`.
 * Requests count only when the action caused them: a repeat of an earlier identical request, such
 * as a heartbeat or poller, never holds a wait open.
 *
 * The pick is clicked (a row's one link or button when it has one); `options.commit` set to
 * `"keyboard"` moves to it with ArrowDown and presses Enter. After it, focus left in the
 * control is blurred (`options.blur`: `"auto"`, `"tab"`, `"blur"` or `"none"`). Then the field must
 * show the choice (its own value or text, the wrapper around it that holds no other field, or a
 * hidden input's value; `options.committed`, a locator or a function of `{ label, value }`,
 * replaces that read) and keep showing it for `holdMs` after the page's requests end. A click
 * or Enter counts only once the page shows it did something (the popup closed, the field's text
 * changed or the option became selected), since a field holding the typed text already shows a
 * label equal to it. A pick that did not hold, such as an editor a grid refresh resets, is picked
 * again up to `options.refills` times (2), leaving the field with Tab; a click that did nothing is
 * tried with the keyboard when `commit` is `"auto"`. The keyboard presses Enter only on an option
 * its own keys made active (named by `aria-activedescendant` or focused, or, outside a form, newly
 * marked selected or active), so it never submits a form with nothing chosen.
 *
 * Hooks for a site's quirks: `query` (text to type, when the site searches by something other
 * than the value), `open()` (open the picker instead of clicking the control), `type(field,
 * query, step)` (type instead of the helper), `answered(popup, query)` (true once the popup shows
 * the answer to this query, such as a site's query marker), `listbox` (the popup's locator),
 * `option` (a CSS selector for its options), `search` (the search box's locator), `confirm` (the
 * dialog's confirm button), `chips` (a CSS selector for the chips of `pickValues`) and
 * `siteDomain` (the site's registrable domain, whose requests the waits follow). Budgets:
 * `timeout` (whole call, 10 s), `settleMs` (500), `holdMs` (500).
 *
 * A caller's value the picker lacks is not an error of the page: they return
 * `{ picked: false, reason, wanted, available, matches }`, where `reason` is `option_missing`,
 * `option_ambiguous` (`matches` lists the options that tie) or `option_disabled`, and
 * `available` every enabled option it listed. Decode with `PickOutcome` and throw
 * `pickRefusal(outcome, field)` (`InvalidInput` with `field` and `available`, which for options
 * that tie is `matches`), or ask the caller to choose among `matches`. In a tool that takes the
 * first of options that tie instead (each tool decides), pass `tie: "first"`, so the picker takes
 * the first of them in the site's order and returns the one it used, which the tool returns in
 * its output. Success is
 * `{ picked: true, kind, label, value, rank, refills }`, plus `tied`, the options that tied, when
 * `tie: "first"` took one.
 * Everything else throws an Error named `PickerFailure` whose message is a fixed reason, never a
 * value: `wanted_missing`, `popup_missing` (the control opened nothing), `options_loading` (still
 * loading, or more list to read, at the timeout), `not_committed` (the field never kept the
 * choice) or `timeout` (the budget ran out mid-action, or the control never showed). An
 * `options_loading` failure's `loading`, and its stack's first line, which a host logs, say what
 * still showed the list loading, as kinds and counts, never page text: new loading signs, each
 * with its kind, tag and place (on the field, in the list, outside it, or on the page), loading
 * rows, a busy list, requests the picker started still in flight with their types and age,
 * `answered` not yet true, and the options read when the list was not read to its end.
 */
export const pickerCode = String.raw`
const pickerFailure = (reason) => Object.assign(new Error(reason), { name: "PickerFailure" });
const pickerFold = ${String(foldChoiceText)};
const pickerRankChoices = ${String(rankChoices)};
const pickerRank = (s, list, wanted) => pickerRankChoices(list, wanted, pickerFold, { leading: s.tie === true, stem: s.options.stem === true });
const pickerPage = ${pickerPageCode};
const pickerLimits = Object.freeze(${JSON.stringify({
  timeout: 10_000,
  action: timeoutDefaults.action,
  settle: timeoutDefaults.settle,
  inflight: timeoutDefaults.answer,
  quiet: 2_000,
})});
// A Playwright action that ran out of the call's budget fails as the fixed reason "timeout".
const pickerTimedOut = (error, s) =>
  error?.name === "TimeoutError" || (error?.name !== "PickerFailure" && s && Date.now() >= s.until) ? pickerFailure("timeout") : error;
const pickerSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pickerWanted = (wanted) => {
  const spellings = (Array.isArray(wanted) ? wanted : [wanted]).map((item) => String(item ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
  if (spellings.length === 0) throw pickerFailure("wanted_missing");
  return [...new Set(spellings)];
};
// The site's own requests a picker's action caused: xhr, fetch and documents to the page's site
// (any host when the page has none) that started within causedMs of the action, counted until
// they end or for the inflight budget. A poll, one request (same method, URL and body) started
// four times at a steady interval outside every window the picker's own actions opened, such as
// a heartbeat, is the page's own and never counts. A request starting right after one of the
// picker's actions, such as a save sent again on each refill or a query typed again, never
// counts toward a poll. The site is siteDomain when given (the host computes it), else a
// conservative guess from the page's host.
const pickerNetwork = (page, causedMs, siteDomain) => {
  const entries = [];
  const starts = new Map();
  const polls = new Set();
  const marks = [];
  const siteOf = (host) => {
    const labels = host.split(".");
    if (labels.length <= 2 || /^\d+$/.test(labels.at(-1))) return host;
    const shared = labels.at(-1).length === 2 && /^(?:ac|co|com|edu|gov|ne|net|or|org)$/.test(labels.at(-2));
    return labels.slice(shared ? -3 : -2).join(".");
  };
  const firstParty = (url) => {
    try {
      const pageUrl = new URL(page.url());
      if (!/^https?:$/.test(pageUrl.protocol) || pageUrl.hostname === "") return true;
      const site = siteDomain ?? siteOf(pageUrl.hostname);
      const host = new URL(url).hostname;
      return host === site || host.endsWith("." + site);
    } catch {
      return true;
    }
  };
  const byRequest = new Map();
  const own = (request) => ["xhr", "fetch", "document"].includes(request.resourceType()) && firstParty(request.url());
  const keyOf = (request) => request.method() + " " + request.url() + " " + String(request.postData() ?? "").slice(0, 2048);
  // When a request of the page's own, polls aside, last started or ended, counting the end of one
  // that started before this listener, which entries never hold.
  let lastSeen = 0;
  const onRequest = (request) => {
    if (!own(request)) return;
    const key = keyOf(request);
    const at = Date.now();
    const ours = marks.some((mark) => at >= mark && at <= mark + causedMs);
    const times = ours ? (starts.get(key) ?? []) : [...(starts.get(key) ?? []), at].slice(-4);
    starts.set(key, times);
    if (!ours && times.length === 4) {
      const gaps = [times[1] - times[0], times[2] - times[1], times[3] - times[2]];
      if (Math.min(...gaps) >= 50 && Math.max(...gaps) - Math.min(...gaps) <= Math.max(...gaps) / 2) polls.add(key);
    }
    const entry = { at, endAt: null, key, type: request.resourceType() };
    entries.push(entry);
    byRequest.set(request, entry);
    if (!polls.has(key)) lastSeen = at;
  };
  const onDone = (request) => {
    const entry = byRequest.get(request);
    if (entry) entry.endAt = Date.now();
    byRequest.delete(request);
    if (entry ? !polls.has(entry.key) : own(request) && !polls.has(keyOf(request))) lastSeen = Date.now();
  };
  page.on("request", onRequest);
  page.on("requestfinished", onDone);
  page.on("requestfailed", onDone);
  const caused = (since) => entries.filter((entry) => !polls.has(entry.key) && entry.at >= since && entry.at <= since + causedMs);
  const pending = (since) => caused(since).filter((entry) => entry.endAt === null && Date.now() - entry.at < pickerLimits.inflight);
  return {
    mark: (at) => marks.push(at),
    inflight: (since) => pending(since).length,
    pending,
    // When the action's last caused request started or ended, or 0.
    lastAt: (since) => Math.max(0, ...caused(since).map((entry) => entry.endAt ?? entry.at)),
    // Whether the page's own requests, whatever started them, polls aside, went quiet for quietMs
    // since a time: none seen starting still in flight (for less than the inflight budget), and
    // none seen starting or ending in that time. A request in flight before this listener shows
    // only by its end, so the quiet counts from that time, never from before.
    quiet: (since, quietMs) => {
      const now = Date.now();
      if (now - Math.max(since, lastSeen) < quietMs) return false;
      return !entries.some((entry) => !polls.has(entry.key) && entry.endAt === null && now - entry.at < pickerLimits.inflight);
    },
    stop: () => {
      page.off("request", onRequest);
      page.off("requestfinished", onDone);
      page.off("requestfailed", onDone);
    },
  };
};
const pickerSession = async (control, options) => {
  const timeout = options.timeout ?? pickerLimits.timeout;
  const until = Date.now() + timeout;
  const left = () => Math.max(1, until - Date.now());
  const handle = await control.elementHandle({ timeout: left() });
  const frame = (handle && (await handle.ownerFrame())) ?? control.page().mainFrame();
  await handle?.dispose();
  const settleMs = options.settleMs ?? pickerLimits.settle;
  return {
    control,
    options,
    until,
    started: Date.now(),
    left,
    act: () => ({ timeout: Math.min(left(), pickerLimits.action) }),
    frame,
    token: "pk" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    net: pickerNetwork(control.page(), Math.max(settleMs * 2, 1000), options.siteDomain),
    settleMs,
    idleMs: Math.max(settleMs * 2, 600),
    holdMs: options.holdMs ?? settleMs,
    refills: options.refills ?? 2,
  };
};
// The page function is installed once per document, through Playwright rather than the page's
// own eval (so a strict content security policy allows it), and removed by the cleanup phase.
const pickerInstall = "globalThis[Symbol.for(\"opengpt.picker.page\")] = " + String(pickerPage);
const pickerRun = (element, args) => {
  if (!element.isConnected) return { installed: true, detached: true };
  const run = element.ownerDocument.defaultView[Symbol.for("opengpt.picker.page")];
  if (typeof run !== "function") return { installed: false };
  const value = run(element, args);
  if (args.phase === "cleanup") delete element.ownerDocument.defaultView[Symbol.for("opengpt.picker.page")];
  return { installed: true, value };
};
const pickerEval = async (s, phase, extra = {}) => {
  const popup = s.options.listbox ? await s.options.listbox.elementHandle({ timeout: s.act().timeout }).catch(() => null) : null;
  const args = {
    token: s.token,
    phase,
    popup,
    option: s.options.option ?? null,
    valueAttributes: s.options.valueAttributes ?? [],
    ...extra,
  };
  // The control's element is kept between reads and found again once the page replaced it.
  const wait = phase === "cleanup" ? 500 : s.act().timeout;
  const run = async () => {
    s.handle ??= await s.control.elementHandle({ timeout: wait });
    const answer = await s.handle.evaluate(pickerRun, args).catch((error) => {
      if (/not attached|detached|context was destroyed|Target closed/i.test(String(error?.message))) return { installed: true, detached: true };
      throw error;
    });
    if (!answer.detached) return answer;
    await s.handle.dispose().catch(() => undefined);
    s.handle = await s.control.elementHandle({ timeout: wait });
    return s.handle.evaluate(pickerRun, args);
  };
  try {
    let answer = await run();
    if (!answer.installed && phase !== "cleanup") {
      await s.frame.evaluate(pickerInstall);
      answer = await run();
    }
    return answer.installed ? answer.value : phase === "cleanup" ? null : s.control.evaluate(pickerPage, args, { timeout: s.act().timeout });
  } finally {
    await popup?.dispose();
  }
};
// Notes the start of one of the picker's own actions, for the network's poll check.
const pickerMark = (s) => {
  const at = Date.now();
  s.net.mark(at);
  s.markedAt = at;
  return at;
};
// The options_loading failure, its message the fixed reason. Its loading, and its stack's first
// line, which a host logs, say what still showed the list loading at the last look, as kinds and
// counts, never page text: new loading signs (see why), loading rows, a busy list, requests the
// action at since started still in flight, answered() not yet true, and how many options were
// read when the list was not read to its end (listRead).
const pickerLoadingText = (loading) => {
  const plural = (count, word) => count + " " + word + (count === 1 ? "" : "s");
  const signs = { busy: "busy region", progressbar: "progress bar", loading: "loading class", spinner: "spinner class", searching: "searching class", skeleton: "skeleton class" };
  const places = { field: "on the field", page: "on the page", list: "in the list", outside_list: "outside the list" };
  const parts = [];
  if (loading.signs > 0)
    parts.push(
      plural(loading.signs, "new loading sign") + ": " +
        loading.kinds.map((kind) => signs[kind.sign] + " (" + kind.tag + ") " + places[kind.where]).join(", ") +
        (loading.signs > loading.kinds.length ? " and " + (loading.signs - loading.kinds.length) + " more" : ""),
    );
  if (loading.rows > 0) parts.push(plural(loading.rows, "loading row") + " in the list");
  if (loading.listBusy) parts.push("the list marked busy");
  if (loading.requests > 0)
    parts.push(
      plural(loading.requests, "request") + " it started in flight (" + loading.requestTypes.join(", ") + ", " +
        (loading.requests === 1 ? "" : "the oldest ") + (loading.oldestRequestMs / 1000).toFixed(1) + " s)",
    );
  if (loading.answered === false) parts.push("answered() not true");
  if (loading.listRead !== undefined) parts.push("the list not read to its end (" + plural(loading.listRead, "option") + " read)");
  return parts.length === 0 ? "nothing still showed loading" : parts.join("; ");
};
const pickerLoadingFailure = (s, scan, since, answered, listRead) => {
  const requests = since === undefined ? [] : s.net.pending(since);
  const loading = {
    signs: scan?.why?.signs ?? 0,
    kinds: scan?.why?.kinds ?? [],
    rows: scan?.why?.rows ?? 0,
    listBusy: scan?.why?.listBusy ?? false,
    requests: requests.length,
    requestTypes: [...new Set(requests.map((entry) => entry.type))],
    oldestRequestMs: requests.length === 0 ? 0 : Date.now() - Math.min(...requests.map((entry) => entry.at)),
    answered: s.options.answered && typeof answered === "boolean" ? answered : null,
    ...(listRead === undefined ? {} : { listRead }),
  };
  const failure = Object.assign(pickerFailure("options_loading"), { loading });
  const stack = String(failure.stack ?? "");
  failure.stack = "PickerFailure: options_loading (" + pickerLoadingText(loading) + ")" + (stack.includes("\n") ? stack.slice(stack.indexOf("\n")) : "");
  return failure;
};
const pickerTag = (s, name, value) => s.frame.locator("[" + name + "=" + JSON.stringify(value) + "]");
const pickerChoices = (options) => options.map((option) => ({ names: option.names, value: option.value, disabled: option.disabled, key: option.key }));
// Waits for the picker's options to answer an action: no loading sign, no request the action
// started in flight, the author's answered() true, and the list unchanged for settleMs (or for
// idleMs when nothing reacted at all). Returns the last scan and whether anything reacted.
const pickerSettle = async (s, since, before, query) => {
  let last = null;
  let changedAt = since;
  let reacted = false;
  let looks = 0;
  while (true) {
    const scan = await pickerEval(s, "scan", { near: s.kind === "dropdown" });
    looks++;
    const now = Date.now();
    if (scan.signature !== last) {
      if (last !== null || scan.signature !== before) changedAt = now;
      last = scan.signature;
    }
    if (scan.signature !== before || s.net.lastAt(since) > 0) reacted = true;
    const busy = scan.loading || s.net.inflight(since) > 0;
    const quiet = now - Math.max(changedAt, s.net.lastAt(since));
    const answered = s.options.answered ? scan.popup && Boolean(await s.options.answered(pickerTag(s, "data-opengpt-pick-popup", s.token), query)) : true;
    // No reaction needs a few looks across the idle window, so one slow read cannot end it.
    if (!busy && answered && quiet >= (reacted ? s.settleMs : s.idleMs) && (reacted || looks >= 3)) return { scan, reacted };
    if (now >= s.until) {
      if (busy || !answered) throw pickerLoadingFailure(s, scan, since, answered);
      return { scan, reacted };
    }
    await pickerSleep(40);
  }
};
// Every option the list holds: a list that renders or loads as it scrolls is scrolled a page at a
// time to its end, remembering where each option showed, so a tie further down is never missed.
// complete says the whole list was read; scrolling stops with a third of the budget left, for
// the pick itself.
const pickerCollect = async (s, scan, wanted) => {
  const seen = new Map();
  const add = (found) => {
    for (const option of found.options) if (!seen.has(option.key)) seen.set(option.key, option);
  };
  add(scan);
  const reserve = s.until - (s.until - s.started) / 3;
  let latest = scan;
  let stuck = 0;
  let complete = !scan.scroll || scan.scroll.end;
  while (!complete && Date.now() < reserve && seen.size < 2000) {
    const size = seen.size;
    const at = latest.scroll.top;
    const scrolledAt = pickerMark(s);
    latest = await pickerEval(s, "scan", { scroll: "next" });
    // Options the scroll asked for can take a moment, or a request, to arrive.
    for (let look = 0; look < 25 && Date.now() < reserve; look++) {
      await pickerSleep(30);
      latest = await pickerEval(s, "scan");
      if (latest.loading || s.net.inflight(scrolledAt) > 0) continue;
      if (latest.options.some((option) => !seen.has(option.key)) || look >= 3) break;
    }
    add(latest);
    if (latest.scroll === null) complete = true;
    else if (seen.size > size) stuck = 0;
    else if (latest.scroll.end || latest.scroll.top === at || ++stuck >= 3) complete = !latest.loading;
  }
  const list = [...seen.values()].filter((option) => !option.creation);
  const ranking = wanted ? pickerRank(s, pickerChoices(list), wanted) : { status: "missing" };
  return { list, ranking, scan: latest, complete: complete || seen.size >= 2000 };
};
// The enabled options as shown, never a native select's empty-valued prompt such as "Choose...".
const pickerAvailable = (list) =>
  [...new Set(list.filter((option) => !option.disabled && !(option.native && option.value === "")).map((option) => option.label).filter(Boolean))].slice(0, 100);
// Options that tie, each as the caller can tell it apart: its label, else its whole text, else
// that and its value.
const pickerMatches = (options) => {
  const labels = options.map((option) => option.label);
  const texts = options.map((option, index) => (labels.indexOf(labels[index]) === labels.lastIndexOf(labels[index]) ? labels[index] : option.names?.[1] ?? labels[index]));
  return texts.map((text, index) => (texts.indexOf(text) === texts.lastIndexOf(text) || !options[index].value ? text : text + " [" + options[index].value + "]"));
};
// With tie "first", options that tie give the first enabled one in the list's order, kept by its
// position (its key or index), never found again by a label another option may share; every
// tied option greyed out is a value the site does not offer now.
const pickerOutcome = (found, wanted, tie = false) => {
  const { ranking, list } = found;
  if (ranking.status === "picked") return { status: "picked", option: list[ranking.index], rank: ranking.rank };
  const tied = ranking.status === "ambiguous" ? ranking.indexes.map((index) => list[index]) : [];
  const first = tie ? tied.find((option) => !option.disabled) : undefined;
  if (first) return { status: "picked", option: first, rank: ranking.rank, tied: pickerMatches(tied) };
  const reason = ranking.status === "ambiguous" ? (tie ? "option_disabled" : "option_ambiguous") : ranking.status === "disabled" ? "option_disabled" : "option_missing";
  return {
    status: "refused",
    refusal: {
      picked: false,
      reason,
      wanted: wanted[0],
      available: pickerAvailable(list),
      matches: ranking.status === "ambiguous" ? pickerMatches(tied) : ranking.status === "disabled" ? [list[ranking.index].label] : [],
    },
  };
};
// The success a pick returns, naming the options that tied when tie "first" took one of them.
const pickerPicked = (kind, found, refills) => ({
  picked: true,
  kind,
  label: found.option.label,
  value: found.option.value,
  rank: found.rank,
  refills,
  ...(found.tied ? { tied: found.tied } : {}),
});
const pickerFieldValue = (field, s) =>
  field.evaluate((node) => (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? node.value : node.textContent ?? ""), undefined, s.act());
// Types a query three ways, each a fallback for a field that ignored the one before: filled at
// once (one input event, so no race of answers); then, in a popup's search box, filled and run
// with the popup's Search button, or with Enter when the box is in no form (Enter in a form can
// submit it), and otherwise all but its last character filled and the last pressed as a key;
// then cleared and typed key by key.
const pickerType = async (s, field, query, step, scan) => {
  if (s.options.type) return s.options.type(field, query, step);
  if (step === 0) {
    if ((await pickerFieldValue(field, s).catch(() => "")) === query) await field.fill("", s.act());
    return field.fill(query, s.act());
  }
  if (step === 1 && field !== s.control && scan?.go) {
    await field.fill(query, s.act());
    return pickerTag(s, "data-opengpt-pick-go", s.token).click(s.act());
  }
  if (step === 1 && field !== s.control && scan && !scan.inForm) {
    await field.fill(query, s.act());
    return field.press("Enter", s.act());
  }
  if (step === 1) {
    await field.fill(query.slice(0, -1), s.act());
    return field.pressSequentially(query.slice(-1), s.act());
  }
  await field.fill("", s.act());
  return field.pressSequentially(query, { ...s.act(), delay: 10 });
};
// Waits, up to maxMs, for the page's own requests to go quiet for settleMs from now (see quiet).
const pickerPageQuiet = async (s, maxMs) => {
  const since = Date.now();
  const until = Math.min(s.until, since + maxMs);
  while (Date.now() < until && !s.net.quiet(since, s.settleMs)) await pickerSleep(40);
};
// Types each query in turn into the field and reads what the list answers. A field that shows
// no reaction is typed the next way; a list that reacted but lacks the value may hold the answer
// to an older query that landed last, so the value is typed once more. A list left empty, or with
// no row the author's option selector keeps, after the last query may come from a page still
// starting up, which dropped the typing: once a call, with more than a third of its time left,
// the field is typed once more key by key once the page's own requests go quiet (up to the quiet
// limit), never with the Enter or Search button of step 1. Never for a free-entry field or the
// author's own typing. Typing again that fails, such as out of time, refuses as the empty list did.
const pickerQuery = async (s, field, wanted, seenAvailable = []) => {
  const queries = s.options.query ? [String(s.options.query)] : wanted;
  let lastFound = null;
  const available = [...seenAvailable];
  for (const [index, query] of queries.entries()) {
    let retyped = false;
    let again = false;
    for (let step = 0; step < 3; step++) {
      let scan, reacted, found;
      try {
        const snapshot = await pickerEval(s, "snapshot", { near: s.kind === "dropdown" });
        const before = snapshot.signature;
        const since = pickerMark(s);
        await pickerType(s, field, query, step, snapshot);
        ({ scan, reacted } = await pickerSettle(s, since, before, query));
        found = await pickerCollect(s, scan, wanted);
        if (!found.complete) throw pickerLoadingFailure(s, found.scan, s.markedAt, undefined, found.list.length);
      } catch (error) {
        if (again) break;
        throw error;
      }
      lastFound = found;
      if (found.ranking.status !== "missing") return { found, field };
      available.push(...pickerAvailable(found.list));
      // A tag input that may create values and shows nothing for the text is a free-entry field.
      if (!reacted && s.options.create) break;
      if (!reacted && step < 2) continue;
      if (!retyped && scan.options.length > 0 && !s.options.type) {
        retyped = true;
        step = -1;
        continue;
      }
      const empty = scan.options.length === 0 && found.list.length === 0;
      const spare = s.left() - (s.until - s.started) / 3;
      if (!retyped && empty && !s.options.type && !s.options.create && index === queries.length - 1 && !s.typedAgain && spare > 0) {
        retyped = true;
        again = true;
        s.typedAgain = true;
        await pickerPageQuiet(s, Math.min(pickerLimits.quiet, spare));
        step = 1;
        continue;
      }
      break;
    }
  }
  const found = lastFound ?? { ranking: { status: "missing" }, list: [] };
  return { found, field, available: [...new Set(available)].slice(0, 100) };
};
const pickerOpen = async (s) => {
  await pickerEval(s, "snapshot");
  const first = await pickerEval(s, "scan", { near: false });
  if (first.popup && first.options.length > 0 && (first.expanded || ["given", "kept", "owned"].includes(first.via))) return first;
  const before = first.signature;
  const since = pickerMark(s);
  if (s.options.open) await s.options.open();
  else await s.control.click(s.act());
  const { scan } = await pickerSettle(s, since, before, "");
  if (!scan.popup && !scan.search) throw pickerFailure("popup_missing");
  return scan;
};
// Opens or types, then ranks: { status: "picked", option, rank, field } or { status: "refused" }.
const pickerFind = async (s, wanted) => {
  if (s.kind === "typeahead") {
    const { found, field, available } = await pickerQuery(s, s.control, wanted);
    const outcome = pickerOutcome(found, wanted, s.tie);
    if (outcome.status === "refused" && available && outcome.refusal.reason === "option_missing")
      outcome.refusal.available = [...new Set([...outcome.refusal.available, ...available])].slice(0, 100);
    return { ...outcome, field, scan: found.scan };
  }
  const scan = await pickerOpen(s);
  const found = await pickerCollect(s, scan, wanted);
  const strong = found.complete && found.ranking.status !== "missing" && ["exact", "normalized"].includes(found.ranking.rank);
  const search = s.options.search ?? (found.scan.search || scan.search ? pickerTag(s, "data-opengpt-pick-search", s.token) : null);
  // A list too long to read whole is narrowed with its search box, or not judged at all.
  if (!found.complete && search === null) throw pickerLoadingFailure(s, found.scan, s.markedAt, undefined, found.list.length);
  if (strong || search === null) return { ...pickerOutcome(found, wanted, s.tie), field: s.control, scan: found.scan, popupKind: scan.kind };
  const queried = await pickerQuery(s, search, wanted, pickerAvailable(found.list));
  const outcome = pickerOutcome(queried.found.ranking.status === "missing" && found.complete && found.ranking.status !== "missing" ? found : queried.found, wanted, s.tie);
  if (outcome.status === "refused" && queried.available && outcome.refusal.reason === "option_missing")
    outcome.refusal.available = [...new Set([...outcome.refusal.available, ...queried.available])].slice(0, 100);
  return { ...outcome, field: search, scan: queried.found.scan ?? found.scan, popupKind: scan.kind };
};
// Brings the chosen option into the rendered list (a list that renders as it scrolls may have
// dropped it) and returns its current tag.
const pickerLocate = async (s, option) => {
  for (let look = 0; look < 20 && Date.now() < s.until; look++) {
    const scan = await pickerEval(s, "scan", look === 0 ? { scroll: option.top } : {});
    const now = scan.options.find((candidate) => candidate.key === option.key);
    if (now) return now.tag;
    await pickerSleep(40);
  }
  return null;
};
const pickerClick = async (s, tag, double = false) => {
  const hit = pickerTag(s, "data-opengpt-pick-hit", tag);
  const target = (await hit.count()) > 0 ? hit : pickerTag(s, "data-opengpt-pick", tag);
  await target.scrollIntoViewIfNeeded({ timeout: Math.min(2000, s.left()) });
  if (double) await target.dblclick({ timeout: Math.min(2000, s.left()) });
  else await target.click({ timeout: Math.min(2000, s.left()) });
};
// Moves to the option with ArrowDown until the page marks it active, then presses Enter. Only a
// mark the keys made counts: aria-activedescendant or focus on it, or, outside a form, a selected
// state or active class it lacked before the first key. Enter with nothing active can submit a form.
const pickerKeys = async (s, field, option, count) => {
  await field.focus(s.act());
  let baseline = null;
  for (let press = 0; press <= count + 1 && Date.now() < s.until; press++) {
    const tag = await pickerLocate(s, option);
    if (tag === null) return false;
    const state = await pickerEval(s, "active", { tag });
    if (state === null) return false;
    baseline ??= state;
    const weak = press > 0 && ((state.selected && !baseline.selected) || (state.marked && !baseline.marked));
    if (state.strong || (weak && !state.inForm)) {
      await field.press("Enter", s.act());
      return true;
    }
    await field.press("ArrowDown", s.act());
    await pickerSleep(30);
  }
  return false;
};
const pickerCommit = async (s, found, method) => {
  const tag = await pickerLocate(s, found.option);
  if (tag === null) return false;
  if (method === "keyboard") {
    if (!(await pickerKeys(s, found.field, found.option, found.scan?.options.length ?? 20))) return false;
  } else {
    try {
      await pickerClick(s, tag);
    } catch (error) {
      if (!/Timeout|detached|not attached|intercept/i.test(String(error?.message))) throw error;
      return false;
    }
  }
  // A dialog a click leaves open wants its Select or OK button, or a double click on the row.
  if (found.popupKind === "dialog") {
    const until = Math.min(s.until, Date.now() + s.settleMs * 2);
    while (Date.now() < until) {
      const scan = await pickerEval(s, "scan");
      if (!scan.popup || scan.kind !== "dialog") return true;
      await pickerSleep(40);
    }
    const scan = await pickerEval(s, "scan");
    if (!scan.popup) return true;
    if (s.options.confirm) await s.options.confirm.click(s.act());
    else if (scan.confirm) await pickerTag(s, "data-opengpt-pick-confirm", s.token).click(s.act());
    else {
      const again = await pickerLocate(s, found.option);
      if (again) await pickerClick(s, again, true);
    }
  }
  return true;
};
const pickerBlur = async (s, mode, field) => {
  if (mode === "none") return;
  if (mode === "tab") {
    await (field ?? s.control).press("Tab", s.act()).catch(() => undefined);
    return;
  }
  if (mode === "blur" || (await pickerEval(s, "focus-inside").catch(() => false)))
    await s.control.blur(s.act()).catch(() => undefined);
};
const pickerPhrase = (text) => " " + pickerFold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ") + " ";
const pickerHas = (text, names) => {
  const shown = pickerPhrase(text);
  return names.some((name) => pickerPhrase(name).trim() !== "" && shown.includes(pickerPhrase(name)));
};
// Whether the field shows the choice now.
const pickerShows = async (s, option) => {
  const names = [option.label, ...(option.names ?? []).slice(0, 2)].filter(Boolean);
  const committed = s.options.committed;
  if (typeof committed === "function") return Boolean(await committed({ label: option.label, value: option.value }));
  if (committed) {
    const text = await committed
      .evaluate((node) =>
        node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
          ? node.value
          : node instanceof HTMLSelectElement
            ? (node.selectedOptions[0]?.textContent ?? "") + " " + node.value
            : node.innerText ?? node.textContent ?? "", undefined, { timeout: Math.min(1000, s.left()) })
      .catch(() => null);
    return text !== null && (pickerHas(text, names) || (option.value !== "" && text.trim() === option.value));
  }
  const read = await pickerEval(s, "readback").catch(() => null);
  if (read === null) return false;
  return pickerHas(read.own + " " + read.around, names) || (option.value !== "" && read.hidden.includes(option.value));
};
// The page's state around the field: its read-back, and whether the popup is open.
const pickerState = async (s) => {
  const read = s.options.committed ? null : await pickerEval(s, "readback").catch(() => null);
  const scan = await pickerEval(s, "scan").catch(() => null);
  return { text: JSON.stringify(read), popup: Boolean(scan?.popup), expanded: Boolean(scan?.expanded), options: scan?.options ?? [] };
};
// Whether a click or Enter did anything: the popup closed or collapsed, the field's read-back
// changed, or the option became selected. A field holding the typed text already shows the
// choice when the text is its label, so showing it alone proves nothing.
const pickerEvidence = async (s, pre, option) => {
  const until = Math.min(s.until, Date.now() + Math.max(s.holdMs * 2, 1000));
  const wasSelected = pre.options.find((candidate) => candidate.key === option.key)?.selected ?? false;
  while (true) {
    const now = await pickerState(s);
    const did =
      !now.popup || (pre.expanded && !now.expanded) || now.text !== pre.text ||
      (!wasSelected && Boolean(now.options.find((candidate) => candidate.key === option.key)?.selected));
    if (did) return true;
    if (Date.now() >= until) return false;
    await pickerSleep(40);
  }
};
// Confirms the choice holds: shown, then still shown holdMs after the page's last request.
// Returns "kept", "reverted" (shown, then lost) or "absent" (never shown in time).
const pickerConfirm = async (s, option, since, shows = () => pickerShows(s, option)) => {
  let okSince = null;
  let firstUntil = Date.now() + Math.max(s.holdMs * 2, 1000);
  while (true) {
    const ok = await shows();
    const now = Date.now();
    const busy = s.net.inflight(since) > 0;
    if (ok) {
      okSince ??= now;
      const lastRequest = s.net.lastAt(since);
      if (!busy && now - okSince >= s.holdMs && now - lastRequest >= s.holdMs) return "kept";
    } else {
      if (okSince !== null) return "reverted";
      if (busy) firstUntil = Math.max(firstUntil, now + s.holdMs);
      if (now >= firstUntil) return "absent";
    }
    if (now >= s.until) return ok ? "kept" : "absent";
    await pickerSleep(40);
  }
};
// How a pick commits on each try: a click and a blur first. A try whose commit did nothing on the
// page switches between click and keyboard (ArrowDown, then Enter); a try that did something but
// did not hold, such as an editor a refresh reset, commits the same way. Every refill leaves the
// field with Tab rather than a blur, for editors that save on Tab.
const pickerTry = (options, attempt, switches) => {
  const commit = options.commit ?? "auto";
  const method = commit === "auto" ? (switches % 2 === 1 ? "keyboard" : "click") : commit;
  const blur = options.blur ?? "auto";
  return { method, blur: blur === "auto" && attempt > 0 ? "tab" : blur };
};
const pickerDetect = async (s) => s.options.kind ?? (await pickerEval(s, "detect"));
const pickerNativeOptions = (control, s) =>
  control.evaluate((select) => {
    const list = select instanceof HTMLSelectElement ? [...select.options] : [...(select.list?.options ?? [])];
    return list.map((option, index) => ({
      index,
      label: (option.label || option.textContent || option.value || "").replace(/\s+/g, " ").trim(),
      names: [option.label, option.textContent, option.title].map((name) => String(name ?? "").replace(/\s+/g, " ").trim()).filter(Boolean),
      value: option.value,
      disabled: option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled),
      key: String(index),
      native: true,
    }));
  }, undefined, s.act());
const pickerNative = async (s, wanted) => {
  const list = await pickerNativeOptions(s.control, s);
  const outcome = pickerOutcome({ ranking: pickerRank(s, list, wanted), list }, wanted, s.tie);
  if (outcome.status === "refused") return outcome.refusal;
  const option = outcome.option;
  const force = !(await pickerEval(s, "select-shown"));
  for (let attempt = 0; attempt <= s.refills; attempt++) {
    const since = pickerMark(s);
    await s.control.selectOption({ index: option.index }, { ...s.act(), force });
    const kept = await pickerConfirm(s, option, since, () =>
      s.control.evaluate((select, index) => select.selectedIndex === index, option.index, { timeout: Math.min(1000, s.left()) }).catch(() => false),
    );
    if (kept === "kept") return pickerPicked("select", outcome, attempt);
    if (Date.now() >= s.until) break;
  }
  throw pickerFailure("not_committed");
};
const pickerDatalist = async (s, wanted) => {
  const list = await pickerNativeOptions(s.control, s);
  const outcome = pickerOutcome({ ranking: pickerRank(s, list, wanted), list }, wanted, s.tie);
  if (outcome.status === "refused") return outcome.refusal;
  const option = outcome.option;
  for (let attempt = 0; attempt <= s.refills; attempt++) {
    const since = pickerMark(s);
    await s.control.fill(option.value, s.act());
    await pickerBlur(s, pickerTry(s.options, attempt, 0).blur, s.control);
    const kept = await pickerConfirm(s, option, since, async () => (await pickerFieldValue(s.control, s).catch(() => null)) === option.value);
    if (kept === "kept") return pickerPicked("datalist", outcome, attempt);
  }
  throw pickerFailure("not_committed");
};
// Closes a popup a refused pick left open: Escape, then for a dropdown that ignores it, its control.
const pickerClose = async (s, field) => {
  const open = async () => (await pickerEval(s, "scan").catch(() => null))?.popup;
  if (!(await open())) return;
  await (field ?? s.control).press("Escape", s.act()).catch(() => undefined);
  if (s.kind === "dropdown" && (await open())) await s.control.click(s.act()).catch(() => undefined);
};
const pickerStart = (control, options) => pickerSession(control, options).catch((error) => { throw pickerTimedOut(error); });
const pickValue = async (control, wanted, options = {}) => {
  const spellings = pickerWanted(wanted);
  const s = await pickerStart(control, options);
  try {
    s.tie = options.tie === "first";
    s.kind = await pickerDetect(s);
    if (s.kind === "select" || s.kind === "select-multiple") return await pickerNative(s, spellings);
    if (s.kind === "datalist") return await pickerDatalist(s, spellings);
    let switches = 0;
    let acted = false;
    for (let attempt = 0; ; attempt++) {
      const { method, blur } = pickerTry(options, attempt, switches);
      const found = await pickerFind(s, spellings);
      if (found.status === "refused") {
        await pickerClose(s, found.field);
        return found.refusal;
      }
      const pre = await pickerState(s);
      const since = pickerMark(s);
      const committed = await pickerCommit(s, found, method);
      acted ||= committed;
      const did = committed && (await pickerEvidence(s, pre, found.option));
      if (did) {
        await pickerBlur(s, blur, found.field === s.control ? s.control : null);
        if ((await pickerConfirm(s, found.option, since)) === "kept")
          return pickerPicked(s.kind, found, attempt);
      } else switches++;
      if (Date.now() >= s.until && !acted) throw pickerFailure("timeout");
      if (attempt >= s.refills || Date.now() >= s.until) throw pickerFailure("not_committed");
    }
  } catch (error) {
    throw pickerTimedOut(error, s);
  } finally {
    s.net.stop();
    await pickerEval(s, "cleanup").catch(() => undefined);
    await s.handle?.dispose().catch(() => undefined);
  }
};
const pickerChips = (s) => pickerEval(s, "chips", { chips: s.options.chips ?? null });
// A chip is the value only by its whole name (as written, or ignoring case, spacing, accents and
// punctuation), never because its name holds the value as a word or shares its stem: "Blue Grey"
// is not "Blue".
const pickerChipIs = (chips, wanted) => {
  const ranking = pickerRankChoices(chips, wanted, pickerFold);
  return ranking.status === "picked" && ["exact", "normalized", "folded"].includes(ranking.rank) ? ranking : null;
};
const pickValues = async (control, values, options = {}) => {
  const list = (Array.isArray(values) ? values : [values]).map(pickerWanted);
  const s = await pickerStart(control, options);
  const mode = options.mode ?? "add";
  try {
    s.kind = await pickerDetect(s);
    if (s.kind === "select" || s.kind === "select-multiple") {
      const all = await pickerNativeOptions(s.control, s);
      const picked = [];
      for (const wanted of list) {
        const outcome = pickerOutcome({ ranking: pickerRank(s, all, wanted), list: all }, wanted);
        if (outcome.status === "refused") return { ...outcome.refusal, values: [] };
        picked.push(outcome.option);
      }
      const current = await s.control.evaluate((select) => [...select.selectedOptions].map((option) => option.index), undefined, s.act());
      const indexes = [...new Set([...(mode === "replace" ? [] : current), ...picked.map((option) => option.index)])];
      const force = !(await pickerEval(s, "select-shown"));
      const since = pickerMark(s);
      await s.control.selectOption(indexes.map((index) => ({ index })), { ...s.act(), force });
      const kept = await pickerConfirm(s, picked[0], since, () =>
        s.control.evaluate((select, wantedIndexes) => {
          const chosen = [...select.selectedOptions].map((option) => option.index).sort();
          return JSON.stringify(chosen) === JSON.stringify([...wantedIndexes].sort());
        }, indexes, { timeout: Math.min(1000, s.left()) }).catch(() => false),
      );
      if (kept !== "kept") throw pickerFailure("not_committed");
      return {
        picked: true,
        kind: "select",
        values: picked.map((option) => ({ label: option.label, value: option.value, added: !current.includes(option.index) })),
        removed: mode === "replace" ? all.filter((option) => current.includes(option.index) && !indexes.includes(option.index)).map((option) => option.label) : [],
      };
    }
    const results = [];
    const chipNames = (chip) => ({ names: chip.names.length > 0 ? chip.names : [chip.label], value: chip.value, disabled: false, key: chip.tag });
    for (const wanted of list) {
      const chips = await pickerChips(s);
      const present = pickerChipIs(chips.map(chipNames), wanted);
      if (present) {
        results.push({ label: chips[present.index].label, value: chips[present.index].value, added: false });
        continue;
      }
      let done = false;
      for (let attempt = 0; attempt <= s.refills && !done; attempt++) {
        const { method } = pickerTry(options, attempt, attempt);
        let found = await pickerFind(s, wanted);
        // A free-entry value is created rather than replaced by a suggestion that only holds it
        // or shares its stem.
        if (options.create && found.status === "picked" && ["leading", "words", "stem"].includes(found.rank))
          found = { status: "refused", field: found.field, refusal: { picked: false, reason: "option_missing", wanted: wanted[0], available: [], matches: [] } };
        const since = pickerMark(s);
        const showsChip = (label) => async () => {
          const now = await pickerChips(s).catch(() => []);
          return pickerChipIs(now.map(chipNames), [label]) !== null;
        };
        if (found.status === "refused") {
          // A site that stops suggesting a chosen option no longer lists a chip an earlier call
          // picked by stem or as whole words, so the chips are ranked as the options were.
          if (!options.create && found.refusal.reason === "option_missing") {
            const chips = await pickerChips(s);
            const chosen = pickerRank(s, chips.map(chipNames), wanted);
            if (chosen.status === "picked") {
              await pickerClose(s, found.field);
              results.push({ label: chips[chosen.index].label, value: chips[chosen.index].value, added: false });
              done = true;
              continue;
            }
          }
          if (!(options.create && found.refusal.reason === "option_missing")) {
            await pickerClose(s, found.field);
            return { ...found.refusal, values: results };
          }
          await found.field.fill(wanted[0], s.act());
          await found.field.press("Enter", s.act());
          if ((await pickerConfirm(s, { label: wanted[0], value: "" }, since, showsChip(wanted[0]))) === "kept") {
            results.push({ label: wanted[0], value: "", added: true });
            done = true;
          }
          continue;
        }
        if (await pickerCommit(s, found, method)) {
          if ((await pickerConfirm(s, found.option, since, showsChip(found.option.label))) === "kept") {
            results.push({ label: found.option.label, value: found.option.value, added: true });
            done = true;
          }
        }
      }
      if (!done) throw pickerFailure("not_committed");
    }
    const removed = [];
    if (mode === "replace") {
      for (let round = 0; round < 50 && Date.now() < s.until; round++) {
        const chips = await pickerChips(s);
        // A chip this call chose stays, even one it picked by stem or as whole words.
        const chosen = [...list, ...results.map((result) => [result.label])];
        const extra = chips.find((chip) => !chosen.some((wanted) => pickerChipIs([chipNames(chip)], wanted)));
        if (!extra) break;
        if (!extra.removable) throw pickerFailure("not_committed");
        const since = pickerMark(s);
        await pickerTag(s, "data-opengpt-pick-hit", extra.tag).click(s.act());
        const gone = await pickerConfirm(s, extra, since, async () => {
          const now = await pickerChips(s).catch(() => []);
          return !now.some((chip) => chip.label === extra.label);
        });
        if (gone !== "kept") throw pickerFailure("not_committed");
        removed.push(extra.label);
      }
    }
    await pickerClose(s, null);
    return { picked: true, kind: s.kind, values: results, removed };
  } catch (error) {
    throw pickerTimedOut(error, s);
  } finally {
    s.net.stop();
    await pickerEval(s, "cleanup").catch(() => undefined);
    await s.handle?.dispose().catch(() => undefined);
  }
};
const pickerOptions = async (control, options = {}) => {
  const s = await pickerStart(control, options);
  try {
    s.kind = await pickerDetect(s);
    if (["select", "select-multiple", "datalist"].includes(s.kind)) {
      const list = await pickerNativeOptions(s.control, s);
      return { kind: s.kind, options: list.map((option) => ({ label: option.label, value: option.value, disabled: option.disabled })) };
    }
    let scan;
    let field = s.control;
    if (s.kind === "typeahead") {
      if (!options.query) throw pickerFailure("wanted_missing");
      await pickerEval(s, "snapshot");
      const before = (await pickerEval(s, "scan")).signature;
      const since = pickerMark(s);
      await pickerType(s, s.control, String(options.query), 0);
      scan = (await pickerSettle(s, since, before, String(options.query))).scan;
    } else {
      scan = await pickerOpen(s);
      if (options.query && scan.search) {
        field = s.options.search ?? pickerTag(s, "data-opengpt-pick-search", s.token);
        const before = scan.signature;
        const since = pickerMark(s);
        await pickerType(s, field, String(options.query), 0);
        scan = (await pickerSettle(s, since, before, String(options.query))).scan;
      }
    }
    const found = await pickerCollect(s, scan, null);
    if (!found.complete) throw pickerLoadingFailure(s, found.scan, s.markedAt, undefined, found.list.length);
    await pickerClose(s, field);
    return { kind: s.kind, options: found.list.map((option) => ({ label: option.label, value: option.value, disabled: option.disabled })) };
  } catch (error) {
    throw pickerTimedOut(error, s);
  } finally {
    s.net.stop();
    await pickerEval(s, "cleanup").catch(() => undefined);
    await s.handle?.dispose().catch(() => undefined);
  }
};
`;

const NotPicked = Schema.Struct({
  picked: Schema.Literal(false),
  reason: Schema.Literal("option_missing", "option_ambiguous", "option_disabled"),
  wanted: Schema.String,
  available: Schema.Array(Schema.String),
  matches: Schema.Array(Schema.String),
});

const PickedValue = Schema.Struct({ label: Schema.String, value: Schema.String, added: Schema.Boolean });

/**
 * What `pickValue` returns, for decoding a call's result: the option it committed, or why the
 * caller's value is not among the options (`pickRefusal` turns that into `InvalidInput`).
 */
export const PickOutcome = Schema.Union(
  Schema.Struct({
    picked: Schema.Literal(true),
    kind: Schema.String,
    label: Schema.String,
    value: Schema.String,
    rank: Schema.Literal(...pickerRanks),
    refills: Schema.Number,
    // Only after `tie: "first"` took the first of several: the options that tied, as `matches` lists them.
    tied: Schema.optional(Schema.Array(Schema.String)),
  }),
  NotPicked,
);
export type PickOutcome = typeof PickOutcome.Type;

/**
 * What `pickValues` returns: each value and whether it was added or already chosen, and the
 * chips `"replace"` removed; or why one value is not among the options, with the values it had
 * added before it in `values`.
 */
export const PickManyOutcome = Schema.Union(
  Schema.Struct({
    picked: Schema.Literal(true),
    kind: Schema.String,
    values: Schema.Array(PickedValue),
    removed: Schema.Array(Schema.String),
  }),
  Schema.extend(NotPicked, Schema.Struct({ values: Schema.Array(PickedValue) })),
);
export type PickManyOutcome = typeof PickManyOutcome.Type;

/**
 * The `InvalidInput` for a value a picker does not offer, naming the input `field` and listing
 * what the picker offered as `available` (for an ambiguous value, the options that tie), with the
 * reason as its `kind`. Throw it: `throw pickRefusal(outcome, "store")`.
 */
export const pickRefusal = (
  outcome: { readonly reason: typeof NotPicked.Type.reason; readonly wanted: string } & Partial<
    Pick<typeof NotPicked.Type, "available" | "matches">
  >,
  field: string,
) => {
  const quoted = JSON.stringify(outcome.wanted);
  const message =
    outcome.reason === "option_ambiguous"
      ? `Several ${field} options match ${quoted}; choose one of: ${(outcome.matches ?? []).join("; ")}`
      : outcome.reason === "option_disabled"
        ? `The site lists ${field} ${quoted} but does not offer it now`
        : `The site offers no ${field} matching ${quoted}`;
  const available =
    outcome.reason === "option_ambiguous" ? (outcome.matches ?? []) : (outcome.available ?? []);
  return new operationErrors.InvalidInput(message, { field, available, kind: outcome.reason });
};
