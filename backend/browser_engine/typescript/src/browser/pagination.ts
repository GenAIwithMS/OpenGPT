import { Schema } from "effect";
import type {
  ListMechanism,
  ListPosition,
  ListReader,
  ListSegment,
} from "../runtime/list-page.js";
import { waitCode } from "./wait.js";

/**
 * In the page: what one look at the list saw. It reads the rows' keys, the pagination controls
 * nearest the list, the page indicator, the results summary and the site's empty and end marks in
 * one pass, and keeps the controls it chose in a page global named by the pager's token, so the
 * step that acts on them clicks the element this look judged. Locators the author named are
 * placed in the same global before each look.
 */
const scanCode = String.raw`
const pagerScanInPage = (rowElements, args) => {
  const store = (globalThis[Symbol.for(args.token)] ??= {});
  const named = (name) => store["named." + name];
  const norm = (value) => String(value ?? "").replace(/[\s   ]+/g, " ").trim();
  // Shown as Playwright judges it: a box with an area, not hidden by display or visibility.
  const shown = (element) => {
    if (!(element instanceof Element)) return false;
    const box = element.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return false;
    return typeof element.checkVisibility === "function" ? element.checkVisibility({ visibilityProperty: true }) : true;
  };
  const ancestors = (element) => {
    const list = [];
    for (let node = element; node; node = node.parentElement) list.push(node);
    return list;
  };
  const common = (a, b) => {
    const above = new Set(ancestors(a));
    for (let node = b; node; node = node.parentElement) if (above.has(node)) return node;
    return null;
  };
  const steps = (from, to) => {
    let count = 0;
    for (let node = from; node && node !== to; node = node.parentElement) count += 1;
    return count;
  };
  const distance = (a, b) => {
    if (!a || !b) return 0;
    const shared = common(a, b);
    return shared === null ? Infinity : steps(a, shared) + steps(b, shared);
  };
  const rowSet = new Set(rowElements);
  const inRow = (element) => {
    for (let node = element; node; node = node.parentElement) if (rowSet.has(node)) return true;
    return false;
  };

  // The rows' keys, each once, in the site's order. A row without a key is a placeholder slot.
  const keyOf = (row) => {
    const spec = args.key;
    let at = row;
    if (spec.selector) {
      const matches = [...row.querySelectorAll(spec.selector)];
      at = matches.find(shown) ?? (spec.attribute ? matches[0] : undefined);
    }
    if (!(at instanceof Element)) return null;
    const value = norm(spec.attribute ? at.getAttribute(spec.attribute) : shown(at) ? at.innerText : "");
    return value === "" ? null : value;
  };
  const keyed = [];
  const keys = [];
  const seen = new Set();
  let duplicates = 0;
  for (const row of rowElements) {
    const key = keyOf(row);
    if (key === null) continue;
    keyed.push(row);
    if (seen.has(key)) duplicates += 1;
    else {
      seen.add(key);
      keys.push(key);
    }
  }
  const listElement =
    named("list")?.[0] ??
    (keyed.length > 1
      ? keyed.reduce((shared, row) => (shared === null ? row : common(shared, row)), null)
      : (keyed[0] ?? rowElements[0])?.parentElement ?? null);

  // Controls: each actionable element in the pagination containers nearest the list, by its
  // accessible name, rel and class. Arrows alone rank below words, and a bare double arrow, which
  // is often the last page, lowest.
  const actionable =
    'a, button, [role="button"], [role="link"], [role="menuitem"], input[type="button"], input[type="submit"], [onclick], li[title]';
  const nameOf = (element) =>
    norm(
      element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.innerText ||
        element.value ||
        element.querySelector?.("img[alt]")?.getAttribute("alt") ||
        "",
    );
  const classify = (element) => {
    const name = nameOf(element);
    const word = name.replace(/[«‹›»<>←→⇐⇒⟨⟩|]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    const rel = String(element.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
    const hints = [element.getAttribute("class"), element.getAttribute("ref"), element.getAttribute("data-dt-idx"), element.id]
      .map((value) => String(value ?? ""))
      .join(" ");
    if (rel.includes("next")) return { kind: "next", rank: 4 };
    if (rel.includes("prev") || rel.includes("previous")) return { kind: "previous", rank: 4 };
    if (/^(?:last|last page|go to last page|first|first page|go to first page)$/.test(word)) return null;
    if (/\d/.test(word) && /\bpages\b/.test(word)) return null;
    if (/^(?:next|next page|go to next page|show next page|next results?|older|older (?:posts|entries|items|results))$/.test(word) ||
        /^next \d+ (?:results|items|entries|records|rows)$/.test(word))
      return { kind: "next", rank: 3 };
    if (/^(?:previous|prev|previous page|go to previous page|show previous page|previous results?|newer|newer (?:posts|entries|items|results))$/.test(word) ||
        /^previous \d+ (?:results|items|entries|records|rows)$/.test(word))
      return { kind: "previous", rank: 3 };
    const number = /^(?:(?:go to )?page )?(\d{1,5})$/.exec(word);
    if (number) return { kind: "number", n: Number(number[1]) };
    if (word === "") {
      const symbol = name.replace(/\s+/g, "");
      if (/^(?:›|>|→|⟩)$/.test(symbol)) return { kind: "next", rank: 2 };
      if (/^(?:‹|<|←|⟨)$/.test(symbol)) return { kind: "previous", rank: 2 };
      if (/^(?:»|>>)$/.test(symbol)) return { kind: "next", rank: 1 };
      if (/^(?:«|<<)$/.test(symbol)) return { kind: "previous", rank: 1 };
    }
    if (word === "" || word.length <= 2) {
      if (/(?:^|[\s_-])next(?:[\s_-]|$)|btnext|next-?page/i.test(hints)) return { kind: "next", rank: 2 };
      if (/(?:^|[\s_-])prev(?:ious)?(?:[\s_-]|$)|btprevious|prev-?page/i.test(hints)) return { kind: "previous", rank: 2 };
    }
    return null;
  };
  const disabledOf = (element, stop) => {
    for (let node = element, depth = 0; node instanceof Element && depth < 4; node = node.parentElement, depth += 1) {
      if (node.disabled === true || node.getAttribute("aria-disabled") === "true") return true;
      if (/(?:^|[\s_-])(?:disabled|is-disabled)(?:\s|$)/i.test(node.getAttribute("class") ?? "")) return true;
      if (node === stop) break;
    }
    return getComputedStyle(element).pointerEvents === "none";
  };
  const hrefOf = (element) => {
    const raw = element.getAttribute("href");
    if (raw === null || raw === "" || raw.startsWith("#") || /^javascript:/i.test(raw)) return null;
    try {
      // The same page whatever its fragment or parameter order.
      const target = new URL(raw, location.href);
      target.hash = "";
      target.searchParams.sort();
      return target.href;
    } catch {
      return null;
    }
  };
  const currentClass = /(?:^|[\s_-])(?:active|current|selected|this-page|is-current)(?:\s|$)/i;
  const recordsIn = (container) => {
    const records = [];
    for (const element of [container, ...container.querySelectorAll(actionable)]) {
      if (!element.matches(actionable) || inRow(element)) continue;
      const kind = classify(element);
      if (kind === null) continue;
      records.push({ element, container, ...kind });
    }
    // The page number that is no link: the current page, shown as plain text.
    for (const element of container.querySelectorAll("span, em, strong, b, li, div, input")) {
      if (element.matches(actionable) || element.querySelector(actionable) || inRow(element)) continue;
      const text = element.tagName === "INPUT" ? norm(element.value) : norm(element.innerText);
      if (/^\d{1,5}$/.test(text)) records.push({ element, container, kind: "number", n: Number(text), plain: true });
    }
    return records;
  };
  const containerSelector =
    'nav, [role="navigation"], .pagination, .pager, [class*="paginat" i], [class*="pager" i], [class*="paging" i], .tablenav-pages, [aria-label*="pagination" i]';
  const pagingRecords = (records) =>
    records.some((record) => record.kind === "next" || record.kind === "previous") ||
    records.filter((record) => record.kind === "number" && !record.plain).length >= 2;
  let containers = named("controls");
  let records = [];
  if (containers !== undefined) records = containers.flatMap(recordsIn);
  // Without rows there is no list to measure from: choose no pager rather than another list's.
  else if (listElement === null) containers = [];
  else {
    // Pagination containers by their markup, and the element around any run of page numbers
    // whatever its markup, such as a plain div of links.
    const candidates = new Set(document.querySelectorAll(containerSelector));
    for (const element of document.querySelectorAll(actionable)) {
      if (inRow(element) || !/^\d{1,5}$/.test(norm(element.innerText))) continue;
      const parent = element.parentElement?.tagName === "LI" ? element.parentElement.parentElement : element.parentElement;
      if (parent instanceof Element && parent !== document.body) candidates.add(parent);
    }
    const found = [...candidates]
      .filter((element) => !inRow(element))
      .map((element) => ({ element, records: recordsIn(element) }))
      .filter((entry) => pagingRecords(entry.records))
      .map((entry) => ({ ...entry, distance: distance(entry.element, listElement) }));
    const nearest = Math.min(...found.map((entry) => entry.distance));
    // Containers inside a nearer one hold the same controls; duplicates at the same distance, such
    // as a pager above the list and one below it, are both kept.
    const chosen = found.filter((entry) => entry.distance === nearest);
    containers = chosen.map((entry) => entry.element);
    records = chosen.flatMap((entry) => entry.records);
    if (records.length === 0) {
      // No pagination container: only explicit Next and Previous controls count, never inside a
      // carousel or slider.
      const carousel = '[class*="carousel" i], [class*="slider" i], [class*="swiper" i], [class*="slick" i], [aria-roledescription="carousel"]';
      for (const element of document.querySelectorAll(actionable)) {
        if (inRow(element) || element.closest(carousel)) continue;
        const kind = classify(element);
        if (kind !== null && kind.kind !== "number" && kind.rank >= 3) records.push({ element, container: document.body, ...kind });
      }
    }
  }
  // An element inside another control of the same kind is that control: keep the inner one.
  const unique = [];
  const taken = new Set();
  for (const record of records) {
    if (taken.has(record.element)) continue;
    taken.add(record.element);
    unique.push(record);
  }
  records = unique.filter(
    (record) => !unique.some((other) => other !== record && other.kind === record.kind && record.element.contains(other.element)),
  );
  for (const record of records) {
    record.visible = shown(record.element);
    record.disabled = !record.plain && disabledOf(record.element, record.container);
    record.href = record.plain ? null : hrefOf(record.element);
  }

  // A page number or bare double arrow that links to the page already shown, such as a last
  // page's "Last" arrow, is no way on. A worded Next may be a script control whose link is the
  // page itself, so it keeps its own state.
  const here = (() => {
    const target = new URL(location.href);
    target.hash = "";
    target.searchParams.sort();
    return target.href;
  })();
  for (const record of records)
    if (record.href !== null && record.href === here && !record.plain && (record.kind === "number" || record.rank <= 1))
      record.disabled = true;
  const pick = (kind) => {
    const all = records.filter((record) => record.kind === kind && record.visible);
    delete store[kind];
    if (all.length === 0) return { present: false, enabled: false, count: 0 };
    const best = Math.max(...all.map((record) => record.rank));
    const top = all.filter((record) => record.rank === best);
    const enabled = top.filter((record) => !record.disabled);
    if (enabled.length === 0) return { present: true, enabled: false, count: top.length };
    const targets = [...new Set(enabled.map((record) => record.href).filter((href) => href !== null))];
    if (targets.length > 1)
      return { present: true, enabled: true, count: top.length, ambiguous: true, targets: targets.length };
    store[kind] = enabled[0].element;
    return { present: true, enabled: true, count: top.length, href: targets[0] ?? null };
  };
  const named1 = (name, kind) => {
    const elements = named(name);
    if (elements === undefined) return undefined;
    delete store[kind];
    const visible = elements.filter(shown);
    if (visible.length === 0) return { present: false, enabled: false, count: 0 };
    const enabled = visible.filter((element) => !disabledOf(element, null));
    if (enabled.length === 0) return { present: true, enabled: false, count: visible.length };
    const targets = [...new Set(enabled.map(hrefOf).filter((href) => href !== null))];
    if (targets.length > 1)
      return { present: true, enabled: true, count: visible.length, ambiguous: true, targets: targets.length };
    store[kind] = enabled[0];
    return { present: true, enabled: true, count: visible.length, href: targets[0] ?? null };
  };
  const next = named1("next", "next") ?? pick("next");
  const previous = named1("previous", "previous") ?? pick("previous");

  // Numbered pages, each number once, and the current one.
  const numberElements = named("pageLinks");
  const numberRecords = numberElements === undefined
    ? records.filter((record) => record.kind === "number" && record.visible)
    : numberElements.filter(shown).map((element) => {
        const kind = classify(element);
        return kind?.kind === "number" ? { element, n: kind.n, href: hrefOf(element), disabled: disabledOf(element, null) } : null;
      }).filter((record) => record !== null);
  const isCurrent = (record) => {
    if (record.plain) return true;
    for (let node = record.element, depth = 0; node instanceof Element && depth < 2; node = node.parentElement, depth += 1) {
      const current = node.getAttribute("aria-current");
      if (current !== null && current !== "false") return true;
      if (node.getAttribute("aria-selected") === "true" || node.getAttribute("aria-pressed") === "true") return true;
      if (currentClass.test(node.getAttribute("class") ?? "")) return true;
    }
    return false;
  };
  const numbers = new Map();
  for (const record of numberRecords) {
    const current = isCurrent(record);
    const entry = numbers.get(record.n);
    if (entry === undefined) numbers.set(record.n, { n: record.n, current, enabled: !current && !record.disabled, element: record.element });
    else {
      entry.current ||= current;
      if (!entry.enabled && !current && !record.disabled) {
        entry.enabled = true;
        entry.element = record.element;
      }
    }
  }
  store.numbers = [...numbers.values()].filter((entry) => entry.enabled).map((entry) => ({ n: entry.n, element: entry.element }));
  // A page input, such as "[ 2 ] of 5", names the current page even beside other plain numbers.
  const inputs = numberRecords.filter((record) => record.plain && record.element.tagName === "INPUT");
  const currentNumbers = inputs.length === 1
    ? [inputs[0].n]
    : [...numbers.values()].filter((entry) => entry.current).map((entry) => entry.n);
  const namedCurrent = named("current")?.find(shown);
  const currentText = namedCurrent === undefined
    ? undefined
    : norm(namedCurrent.tagName === "INPUT" ? namedCurrent.value : namedCurrent.innerText);

  // The URL's own page, offset or cursor parameter, when it has one.
  const url = new URL(location.href);
  const params = new URLSearchParams(url.search);
  for (const [name, value] of new URLSearchParams(url.hash.replace(/^#!?\/?\??/, ""))) if (!params.has(name)) params.set(name, value);
  const param = (names, pattern) => {
    for (const name of names) {
      const value = params.get(name);
      if (value !== null && pattern.test(value)) return { name, value };
    }
    return null;
  };
  const urlPage = param(["page", "p", "paged", "pagenum", "page_number", "pageNumber", "pageNo", "currentPage"], /^\d{1,6}$/);
  const urlOffset = param(["offset", "start", "skip", "from", "first"], /^\d{1,9}$/);
  const urlCursor = param(["cursor", "after", "before", "page_token", "pageToken", "next_token", "continuation", "token"], /^\S{1,512}$/);

  const relNext = document.querySelector('link[rel~="next"][href]');
  let relNextHref = null;
  if (relNext !== null)
    try {
      relNextHref = new URL(relNext.getAttribute("href"), location.href).href;
    } catch {
      relNextHref = null;
    }

  // "Load more": the nearest control that loads more rows into this list, never one inside a row
  // or before the list, such as a filter's "Show more". Once this pager found it, a farther one
  // is not this list's.
  let loadMore = named1("loadMore", "loadMore");
  if (loadMore === undefined) {
    delete store.loadMore;
    const wording = /^(?:(?:load|show|see|view|get|display)\s+(?:\d+\s+)?more(?:\s+(?:results|items|products|entries|posts|rows|records|listings|reviews|comments))?|more(?:\s+(?:results|items|products|entries|posts))?|show next(?:\s+\d+)?(?:\s+\w+)?)\s*(?:\(\d+\))?$/i;
    const before = (element) =>
      listElement !== null && !listElement.contains(element) &&
      (listElement.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
    const candidates = [...document.querySelectorAll(actionable)]
      .filter((element) => !inRow(element) && shown(element) && !before(element))
      .filter((element) => wording.test(nameOf(element).replace(/[…⌄▾▼↓]+/g, "").trim()) || (/load-?more|show-?more/i.test(element.getAttribute("class") ?? "") && nameOf(element) !== ""))
      .map((element) => ({ element, distance: distance(element, listElement) }))
      .filter((candidate) => args.reach?.loadMore === undefined || candidate.distance <= args.reach.loadMore)
      .sort((a, b) => a.distance - b.distance);
    if (candidates.length === 0) loadMore = { present: false, enabled: false, count: 0 };
    else {
      const nearest = candidates.filter((candidate) => candidate.distance === candidates[0].distance);
      const enabled = nearest.filter((candidate) => !disabledOf(candidate.element, null));
      if (enabled.length > 0) store.loadMore = enabled[0].element;
      if (Number.isFinite(candidates[0].distance) && listElement !== null) store.reach = { ...store.reach, loadMore: candidates[0].distance };
      loadMore = { present: true, enabled: enabled.length > 0, count: nearest.length };
    }
  }

  // The scrolling element that holds the list: the author's, else the nearest scrollable one.
  let scroller = named("scroller")?.[0];
  if (scroller === undefined && listElement !== null)
    for (let node = listElement; node instanceof Element; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) {
        scroller = node;
        break;
      }
    }
  store.scroller = scroller ?? null;
  const scrolling = scroller ?? document.scrollingElement ?? document.documentElement;
  const scrollLeft = scrolling.scrollHeight - scrolling.scrollTop - (scroller ? scrolling.clientHeight : innerHeight);

  // The results summary, such as "Showing 1 to 25 of 312": the author's, else the nearest short
  // text outside the rows that reads as a range or a count.
  const summaryElement = named("summary")?.find(shown);
  let summary = summaryElement === undefined ? null : norm(summaryElement.innerText);
  if (summaryElement === undefined && named("summary") === undefined) {
    const pattern = /\d[\d,.\s]*\s*(?:-|–|—|to|through)\s*\d[\d,.\s]*\s+(?:of|out of|\/)\s|\b(?:showing|displaying|viewing|loaded)\s+\d|\b\d[\d,.]*\+?\s+(?:results?|items?|entries|records|matches|rows|hits|products|listings|orders)\b|\btotal\s*:?\s*\d|\bno (?:results|items|entries|records|matches)\b/i;
    const found = new Map();
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
    let visited = 0;
    for (let node = walker.nextNode(); node !== null && visited < 20000; node = walker.nextNode()) {
      visited += 1;
      if (!/\d|no /i.test(node.nodeValue ?? "")) continue;
      let element = node.parentElement;
      if (element === null || inRow(element)) continue;
      for (let depth = 0; element instanceof Element && depth < 4; depth += 1, element = element.parentElement) {
        if (/^(?:SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(element.tagName)) break;
        const text = norm(element.innerText);
        if (text.length > 160) break;
        if (pattern.test(text)) {
          if (!inRow(element) && shown(element) && !found.has(element)) found.set(element, text);
          break;
        }
      }
    }
    const ranked = [...found].map(([element, text]) => ({ text, distance: distance(element, listElement) }))
      .sort((a, b) => a.distance - b.distance);
    summary = ranked[0]?.text ?? null;
  }

  const empty = named("empty")?.some(shown) ?? false;
  const end = named("end")?.some(shown) ?? false;
  const loading = named("loading")?.some(shown) ?? false;
  const pagerText = containers.map((element) => norm(element.innerText)).join(" | ").slice(0, 400);
  return {
    reach: store.reach ?? null,
    keys,
    count: keys.length,
    duplicates,
    hasList: listElement !== null,
    empty,
    end,
    loading,
    next,
    previous,
    numbers: [...numbers.values()].map(({ n, current, enabled }) => ({ n, current, enabled })),
    current: currentNumbers.length === 1 ? currentNumbers[0] : null,
    currentText: currentText ?? null,
    urlPage,
    urlOffset,
    urlCursor,
    relNextHref,
    loadMore,
    scroll: { left: Math.max(0, Math.round(scrollLeft)), own: scroller !== undefined },
    summary,
    pagerText,
  };
};
`;

/**
 * On the host side of the page code: the pure readers of what a look returned, and the pager
 * itself.
 */
const pagerCode = String.raw`
// Reads a results summary: a range and its total ("Showing 1 to 25 of 312", "1–25 of 312"), a
// count ("312 results", "Total 85 items"), a shown count ("Showing 20 of 57") or a page count
// ("Page 2 of 10"). A total that is approximate ("about", "over", "more than", "1,000+", "many")
// is no total. Numbers may group thousands with commas, dots, spaces or apostrophes.
const pagerParseSummary = (text) => {
  const value = String(text ?? "").replace(/[   ]/g, " ").replace(/\s+/g, " ").trim();
  const result = { total: null, approximate: false };
  if (value === "") return result;
  const number = "(\\d{1,3}(?:[,.' ’]\\d{3})+(?!\\d)|\\d+)";
  const toInt = (digits) => Number(String(digits).replace(/[,.' ’]/g, ""));
  const approximateBefore = /(?:about|approx(?:\.|imately)?|around|over|more than|nearly|almost|roughly|at least|up to|~|>)\s*$/i;
  const totalAfter = (rest) => {
    const match = new RegExp("^\\s*(about |approx(?:\\.|imately)? |around |over |more than |nearly |almost |roughly |at least |~)?" + number + "(\\+|\\s*k\\b|\\s*m\\b)?", "i").exec(rest);
    if (match === null) return { total: null, approximate: /^\s*(?:many|more|several|lots)/i.test(rest) };
    if (match[1] !== undefined || match[3] !== undefined) return { total: null, approximate: true };
    return { total: toInt(match[2]), approximate: false };
  };
  const pageOf = new RegExp("\\bpage\\s+" + number + "\\s+(?:of|\\/)\\s+" + number, "i").exec(value);
  if (pageOf !== null) {
    result.page = toInt(pageOf[1]);
    result.pages = toInt(pageOf[2]);
  }
  const rest = pageOf === null ? value : value.slice(0, pageOf.index) + " | " + value.slice(pageOf.index + pageOf[0].length);
  const range = new RegExp(number + "\\s*(?:-|–|—|to|through|bis|à|a)\\s*" + number + "\\s+(?:of|out of|von|de|sur|di|van|av|\\/)\\s+(.*)$", "i").exec(rest) ??
    new RegExp(number + "\\s*(?:-|–|—)\\s*" + number + "\\s*\\/\\s*(.*)$", "i").exec(rest);
  if (range !== null) {
    result.from = toInt(range[1]);
    result.to = toInt(range[2]);
    Object.assign(result, totalAfter(range[3]));
    return result;
  }
  const showing = new RegExp("\\b(?:showing|displaying|viewing|loaded)\\s+" + number + "\\s+(?:of|out of)\\s+(.*)$", "i").exec(rest);
  if (showing !== null) {
    result.from = toInt(showing[1]) === 0 ? 0 : 1;
    result.to = toInt(showing[1]);
    Object.assign(result, totalAfter(showing[2]));
    return result;
  }
  if (/\bno (?:results|items|entries|records|matches)\b/i.test(rest)) return { ...result, total: 0 };
  const totalWord = new RegExp("\\b(?:total(?: of)?|found)\\s*:?\\s*" + number + "(\\+)?", "i").exec(rest);
  const counted = new RegExp(number + "(\\+)?\\s+(?:total\\s+)?(?:results?|items?|entries|records|matches|rows|hits|products|listings|orders)\\b", "i").exec(rest);
  const match = totalWord ?? counted;
  if (match !== null) {
    const before = rest.slice(0, match.index);
    if (match[2] !== undefined || approximateBefore.test(before)) return { ...result, approximate: true };
    return { ...result, total: toInt(match[1]) };
  }
  return result;
};

// The site's total when the page agrees with it: an exact count whose range holds together, and
// on a page that shows its last row, ends where the total says. Anything else is no total.
const pagerTrustedTotal = (parsed, facts) => {
  if (parsed.total === null || parsed.approximate) return null;
  const { from, to, total } = parsed;
  if (from !== undefined && to !== undefined) {
    if (to < from || to > total || (from === 0) !== (total === 0)) return null;
    if (facts.whole && !facts.growing && facts.rows > 0 && to - from + 1 !== facts.rows) return null;
    if (facts.whole && facts.growing && facts.rows > 0 && to !== facts.rows) return null;
    if (facts.ended && to !== total) return null;
  } else if (facts.ended && facts.growing && facts.rows !== total) return null;
  if (facts.ended && facts.empty && total !== 0) return null;
  return total;
};

const pagerFailure = (reason, message, details = {}) =>
  Object.assign(new Error(reason + ": " + message), { name: "PagerFailure", reason, ...details });

const pagerGrowing = (mechanism) => mechanism === "append" || mechanism === "scroll";

// What a look says about the page: its number, from the current page control, the author's
// indicator, a "Page 2 of 10" text or the URL's own page parameter.
const pagerPageOf = (look, urlBase) => {
  const fromText = (text) => {
    const match = /^\D*?(\d{1,6})\D*$/.exec(String(text ?? ""));
    return match === null ? null : Number(match[1]);
  };
  if (look.currentText !== null) return fromText(look.currentText);
  if (look.current !== null) return look.current;
  const parsed = pagerParseSummary(look.pagerText);
  if (parsed.page !== undefined) return parsed.page;
  const summary = pagerParseSummary(look.summary);
  if (summary.page !== undefined) return summary.page;
  // The URL's page parameter counts only once a step showed whether it counts from 0 or 1.
  if (look.urlPage !== null && urlBase !== undefined) return Number(look.urlPage.value) + urlBase;
  return null;
};

// Defaults a reader sets before the author's listPager call, such as the mechanism the tool names.
let pagerDefaults = {};

const listPager = (spec) => {
  if (spec === null || typeof spec !== "object") throw new TypeError("listPager needs { rows, key }");
  if (spec.rows === undefined || typeof spec.rows.evaluateAll !== "function")
    throw new TypeError("listPager needs rows, a locator for every row of the list");
  if (spec.key === undefined) throw new TypeError("listPager needs key, the field that identifies a row");
  const mechanisms = ["auto", "pages", "next_link", "append", "scroll", "offset"];
  const configured = spec.mechanism ?? pagerDefaults.mechanism ?? "auto";
  if (!mechanisms.includes(configured))
    throw new TypeError("listPager's mechanism is one of " + mechanisms.join(", "));
  const keySpec = typeof spec.key === "string" ? { selector: spec.key }
    : { ...(spec.key.selector === undefined ? {} : { selector: spec.key.selector }),
        ...(spec.key.attribute === undefined ? {} : { attribute: spec.key.attribute }) };
  const hooks = spec.hooks ?? {};
  const token = "opengpt.pager." + Date.now() + "." + Math.random();
  const limits = {
    stableMs: spec.stableMs ?? waitLimits.settle,
    unchangedMs: spec.unchangedMs ?? waitLimits.unchanged,
    noProgressMs: spec.noProgressMs ?? waitLimits.answer,
    timeout: spec.timeout ?? waitLimits.lateFillCap,
    maxSteps: spec.maxSteps ?? 20,
  };
  const site = spec.siteDomain === undefined ? {} : { siteDomain: spec.siteDomain };
  const waitOptions = {
    ...site,
    ...(spec.list === undefined ? {} : { region: spec.list }),
    ...(spec.loading === undefined ? {} : { loading: spec.loading }),
    noProgressMs: limits.noProgressMs,
  };
  const namedLocators = Object.entries({
    list: spec.list,
    controls: spec.controls,
    next: spec.next,
    previous: spec.previous,
    pageLinks: spec.pageLinks,
    current: spec.current,
    loadMore: spec.loadMore,
    summary: spec.summary,
    scroller: spec.scroller,
    empty: spec.empty,
    end: spec.end,
    loading: spec.loading,
  }).filter(([, locator]) => locator !== undefined);
  // Whether a step this pager took in this call changed the page's URL: then the URL names the
  // page and a segment carries it as its link.
  let urlPaged = false;
  let lastStepStalled = false;
  // How far from the list its own "Load more" sits, once a look found it.
  let reach = {};
  // What the URL's page parameter adds to give the page number: 1 when it counts from 0, 0 when
  // from 1, unknown until a value of 0 or a step from the first page shows it.
  let urlBase;

  const look = async () => {
    for (const [name, locator] of namedLocators)
      await locator.evaluateAll((elements, [key, slot]) => {
        (globalThis[Symbol.for(key)] ??= {})[slot] = elements;
      }, [token, "named." + name]);
    const seen = await spec.rows.evaluateAll(pagerScanInPage, { token, key: keySpec, reach });
    if (seen.reach !== null) reach = { ...reach, ...seen.reach };
    const result = { ...seen, url: page.url() };
    if (result.urlPage !== null && Number(result.urlPage.value) === 0) urlBase = 1;
    result.page = hooks.pageNumber === undefined ? pagerPageOf(result, urlBase) : await hooks.pageNumber(result);
    result.parsed = hooks.readTotal === undefined ? pagerParseSummary(result.summary)
      : { ...pagerParseSummary(result.summary), ...hooks.readTotal(result.summary) };
    return result;
  };
  const safeLook = () => look().catch((error) => {
    if (waitContextLost(error)) return undefined;
    throw error;
  });
  // The mechanism, from the first look that shows a way on; a list keeps it once found, so its
  // last page, whose control is gone, still pages the same way.
  let detected;
  const mechanismOf = (seen) => {
    if (configured !== "auto") return configured;
    if (detected !== undefined) return detected;
    let found = "offset";
    if (seen.numbers.filter((entry) => !entry.current).length >= 1 && seen.numbers.length >= 2) found = "pages";
    else if (seen.next.present || seen.previous.present || seen.relNextHref !== null) found = "next_link";
    else if (seen.loadMore.present) found = "append";
    else if (spec.scroller !== undefined || spec.end !== undefined) found = "scroll";
    if (found !== "offset") detected = found;
    return found;
  };
  // An element this pager's last look chose, as a handle in the rows' own frame.
  const chosen = async (slot, n) => {
    const reach = ([key, name, number]) => {
      const store = globalThis[Symbol.for(key)];
      if (store === undefined) return null;
      if (name === "numbers") return store.numbers?.find((entry) => entry.n === number)?.element ?? null;
      return store[name] ?? null;
    };
    const anchor = (await spec.rows.count()) > 0 ? spec.rows.first() : spec.list;
    const handle = anchor === undefined
      ? await page.evaluateHandle(reach, [token, slot, n ?? null])
      : await anchor.evaluateHandle((_, args) => {
          const store = globalThis[Symbol.for(args[0])];
          if (store === undefined) return null;
          if (args[1] === "numbers") return store.numbers?.find((entry) => entry.n === args[2])?.element ?? null;
          return store[args[1]] ?? null;
        }, [token, slot, n ?? null]);
    const element = handle.asElement();
    if (element === null) {
      await handle.dispose();
      throw pagerFailure("pager_no_control", "the " + slot + " control is gone");
    }
    return element;
  };
  // A control the page re-rendered since the look is found again by a fresh look, once.
  const click = async (slot, n, again = true) => {
    const element = await chosen(slot, n);
    try {
      await element.click({ timeout: waitLimits.action });
    } catch (error) {
      if (!again || !/not attached|detached|is gone/i.test(String(error?.message))) throw error;
      await look();
      await click(slot, n, false);
    } finally {
      await element.dispose();
    }
  };
  const scrollStep = async () => {
    const element = await chosen("scroller").catch(() => null);
    const last = (await spec.rows.count()) > 0 ? spec.rows.last() : undefined;
    await last?.scrollIntoViewIfNeeded({ timeout: waitLimits.action }).catch(() => undefined);
    if (element !== null) {
      await element.evaluate((node) => node.scrollTo({ top: node.scrollHeight }));
      await element.dispose();
    } else await page.evaluate(() => window.scrollTo({ top: document.scrollingElement.scrollHeight }));
    await page.mouse.wheel(0, 600).catch(() => undefined);
  };
  // The one action that moves the list on by a step, chosen from a look.
  const stepAction = (seen, mechanism) => {
    if (hooks.step !== undefined) return () => hooks.step(mechanism, seen);
    if (mechanism === "append") {
      if (!seen.loadMore.enabled) throw pagerFailure("pager_no_control", "no enabled control loads more rows");
      return () => click("loadMore");
    }
    if (mechanism === "scroll") return scrollStep;
    if (seen.next.ambiguous)
      throw pagerFailure("pager_ambiguous", seen.next.targets + " enabled Next controls lead to different pages; name the list's own with next");
    if (seen.next.enabled) return () => click("next");
    const current = seen.page;
    const following = current === null ? undefined : seen.numbers.find((entry) => entry.n === current + 1 && entry.enabled);
    if (following !== undefined) return () => click("numbers", following.n);
    if (seen.relNextHref !== null && seen.relNextHref !== seen.url)
      return () => page.goto(seen.relNextHref, { waitUntil: "domcontentloaded", timeout: waitLimits.navigation });
    throw pagerFailure("pager_no_control", "no enabled Next control or following page number");
  };
  // Waits for a step's answer by what it changes: the rows' keys (a page whose rows re-render
  // with the same keys has not moved yet), new rows for a growing list, or the site's empty mark.
  // The page indicator, the URL, the site's requests and the region's changes are progress, never
  // the answer. A step that changed nothing once the page went quiet stalled.
  const awaitStep = async (action, before, growing) => {
    const progress = waitProgress({ ...waitOptions });
    try {
      await progress.baseline();
      await action();
      progress.begin();
      const begun = Date.now();
      let quietBefore = false;
      let indicator = JSON.stringify([before.page, before.url, before.summary]);
      while (true) {
        const seen = await safeLook();
        const changes = [];
        if (seen === undefined) changes.push("page replaced");
        else {
          const shownNow = JSON.stringify([seen.page, seen.url, seen.summary]);
          if (shownNow !== indicator) {
            changes.push("page indicator");
            indicator = shownNow;
          }
        }
        await progress.sample(changes);
        if (seen !== undefined) {
          const newKeys = seen.keys.filter((key) => !before.keys.includes(key));
          const moved = growing
            ? seen.count > before.count || newKeys.length > 0
            : (seen.empty && !before.empty) || (seen.count > 0 && seen.keys.join("\n") !== before.keys.join("\n"));
          if (moved) return { moved: true, seen };
        }
        const now = Date.now();
        if (now - begun >= limits.timeout)
          throw pagerFailure("pager_step_timeout", "the list did not answer a step within " + limits.timeout + " ms; " + progress.describe());
        const quiet = seen !== undefined && progress.quietMs() >= Math.min(limits.unchangedMs, limits.noProgressMs) && !progress.busy(false) && !seen.loading;
        if (quiet && quietBefore) return { moved: false, seen };
        quietBefore = quiet;
        await waitSleep(100);
      }
    } finally {
      await progress.stop();
    }
  };
  // Whether the page says more rows follow than the ones it shows.
  const evidenceOfMore = (seen, rows) => {
    const parsed = seen.parsed;
    if (parsed.to !== undefined && parsed.total !== null && !parsed.approximate && parsed.to < parsed.total) return true;
    if (seen.page !== null && parsed.pages !== undefined && seen.page < parsed.pages) return true;
    if (seen.page !== null && seen.numbers.some((entry) => entry.n > seen.page && entry.enabled)) return true;
    if (rows !== undefined && parsed.total !== null && !parsed.approximate && parsed.to === undefined && rows < parsed.total) return true;
    return false;
  };
  const hasNextOf = (seen, mechanism) => {
    if (hooks.hasNext !== undefined) return hooks.hasNext(seen, mechanism);
    if (seen.empty || seen.end) return false;
    switch (mechanism) {
      case "offset":
        return false;
      case "append":
        return seen.loadMore.enabled;
      case "scroll": {
        // A scrolled list says nothing of its end until a scroll adds no rows, unless the site
        // shows a total.
        if (lastStepStalled) return evidenceOfMore(seen, seen.count);
        const total = seen.parsed.approximate ? null : seen.parsed.total;
        return total === null ? true : seen.count < total;
      }
      default:
        return seen.next.enabled || (seen.page !== null && seen.numbers.some((entry) => entry.n === seen.page + 1 && entry.enabled)) ||
          (seen.relNextHref !== null && seen.relNextHref !== seen.url && !seen.next.present);
    }
  };
  // Reads the controls until what they say held for stableMs with no request in flight. A list
  // whose control says it ended while the page says more rows follow, such as a Next that stays
  // disabled a moment after its rows arrived, gets unchangedMs to say otherwise.
  const holdControls = async (mechanism, rows) => {
    const progress = waitProgress({ ...waitOptions });
    const begun = Date.now();
    let signature;
    let since = begun;
    try {
      while (true) {
        const seen = await safeLook();
        await progress.sample(seen === undefined ? ["page replaced"] : []);
        const now = Date.now();
        if (seen !== undefined) {
          const hasNext = hasNextOf(seen, mechanism);
          const current = JSON.stringify([hasNext, seen.page, seen.summary, seen.keys.slice(0, 3)]);
          if (current !== signature) {
            signature = current;
            since = now;
          }
          const hold = !hasNext && evidenceOfMore(seen, rows) ? limits.unchangedMs : limits.stableMs;
          if ((now - since >= hold && !progress.busy(false) && !seen.loading) || now - begun >= limits.timeout)
            return { seen, hasNext };
        } else if (now - begun >= limits.timeout) throw pagerFailure("pager_step_timeout", "the page kept being replaced");
        await waitSleep(100);
      }
    } finally {
      await progress.stop();
    }
  };
  const fieldSpecs = spec.fields ?? {};
  // The first count rows as the list shows them now, with their fields filled in and holding.
  const readRows = async (count, expected) => {
    const ask = expected !== undefined && expected >= 1 && expected < count ? expected : count;
    let found = await waitForRows(spec.rows, fieldSpecs, {
      ...waitOptions,
      count: ask,
      key: spec.key,
      stableMs: limits.stableMs,
      unchangedMs: limits.unchangedMs,
      timeout: limits.timeout,
    });
    // The summary's range is only a shortcut: a page with more rows than it said reads them all.
    if (ask < count && found.more)
      found = await waitForRows(spec.rows, fieldSpecs, {
        ...waitOptions,
        count,
        key: spec.key,
        stableMs: limits.stableMs,
        unchangedMs: limits.unchangedMs,
        timeout: limits.timeout,
      });
    const seenKeys = new Set();
    const rows = found.rows.filter((row) => {
      if (seenKeys.has(row.key)) return false;
      seenKeys.add(row.key);
      return true;
    });
    return { rows, more: found.more };
  };
  const segmentOf = (seen, mechanism, rows, more, hasNext, extra = {}) => {
    const growing = pagerGrowing(mechanism);
    const parsed = seen.parsed;
    const totalResults = pagerTrustedTotal(parsed, {
      rows: rows.length,
      whole: !more,
      ended: !more && !hasNext,
      growing,
      empty: rows.length === 0,
    });
    return {
      mechanism,
      rows,
      more,
      hasNext,
      totalResults,
      ...(seen.page === null ? {} : { page: seen.page }),
      ...(parsed.from === undefined ? {} : { range: { from: parsed.from, to: parsed.to } }),
      ...(urlPaged || extra.href === true ? { href: seen.url } : {}),
      ...(extra.stalled ? { stalled: true } : {}),
      ...(seen.empty ? { empty: true } : {}),
    };
  };
  const echoOf = async (segment) =>
    hooks.echo === undefined ? segment : { ...segment, echo: await hooks.echo() };

  // The list as it stands: the site's empty mark, or the first count rows, then its controls.
  const read = async (count, options = {}) => {
    if (!Number.isInteger(count) || count < 1) throw new TypeError("pager.read needs count, the number of rows to read");
    if (spec.empty !== undefined) {
      const shown = await waitForOutcome(
        { empty: spec.empty, results: spec.list ?? spec.rows.first() },
        { ...waitOptions, timeout: Math.max(limits.timeout, limits.noProgressMs) },
      );
      if (shown === "empty") {
        const seen = await look();
        return echoOf(segmentOf(seen, mechanismOf(seen), [], false, false, options));
      }
    }
    // How many rows the page likely shows, from its summary's range or the caller's guess (such
    // as the previous page's size): a shortcut past the wait for a short page's count to hold,
    // never a cap, since a page with more rows than that reads them all.
    const first = options.seen ?? (await safeLook());
    const range = first?.parsed;
    const fromSummary = range?.from !== undefined && range.to !== undefined && range.from > 0
      ? (pagerGrowing(mechanismOf(first)) ? range.to : range.to - range.from + 1)
      : undefined;
    const guesses = [fromSummary, options.expect].filter((guess) => Number.isInteger(guess) && guess >= 1);
    const { rows, more } = await readRows(count, guesses.length === 0 ? undefined : Math.min(...guesses));
    const mechanism = mechanismOf(first ?? (await look()));
    const { seen, hasNext } = await holdControls(mechanism, rows.length);
    return echoOf(segmentOf(seen, mechanism, rows, more, hasNext, options));
  };
  // One step on from the list as it stands, then the first count rows: for a growing list, of
  // the whole list.
  // A step from the first page to a URL that names a page shows how its parameter counts.
  const learnUrlBase = (before, after) => {
    if (urlBase !== undefined || after.urlPage === null) return;
    const value = Number(after.urlPage.value);
    if (before.urlPage === null && (before.page ?? 1) === 1 && (value === 1 || value === 2)) urlBase = 2 - value;
  };
  // options.from: the page the caller last read, which the step goes on from; when the browser
  // shows another page, the pager goes back to it first.
  const next = async (count, options = {}) => {
    let before = await look();
    if (Number.isInteger(options.from) && before.page !== null && before.page !== options.from) {
      await moveTo(options.from, before);
      before = await look();
    }
    const mechanism = mechanismOf(before);
    if (mechanism === "offset") throw pagerFailure("pager_no_control", "the list is on one page");
    const growing = pagerGrowing(mechanism);
    const step = await awaitStep(stepAction(before, mechanism), before, growing);
    lastStepStalled = !step.moved;
    if (step.seen.url !== before.url) urlPaged = true;
    if (step.moved) {
      learnUrlBase(before, step.seen);
      step.seen.page = hooks.pageNumber === undefined ? pagerPageOf(step.seen, urlBase) : step.seen.page;
    }
    if (!step.moved && !growing) {
      // The control led nowhere: the rows did not change once the page went quiet. With
      // options.stall "fail", a page that still shows more rows gets one more try, then fails.
      const seen = step.seen;
      const more = evidenceOfMore(seen);
      if (more && options.stall === "fail") {
        if (options.retried !== true) return next(count, { ...options, retried: true });
        throw pagerFailure("pager_stalled", "a step changed nothing while the page shows more rows");
      }
      return echoOf(segmentOf(seen, mechanism, [], false, more, { stalled: true }));
    }
    const segment = await read(count, { ...options, seen: step.seen });
    return step.moved ? segment : { ...segment, stalled: true };
  };
  // A numbered page, from the list as it stands: its own link when the pager shows it, else the
  // nearest shown number toward it, else Next or Previous, one step at a time.
  const goToPage = async (target, count) => {
    if (!Number.isInteger(target) || target < 1) throw new TypeError("pager.goToPage needs a page number from 1");
    await moveTo(target, await look());
    return read(count);
  };
  const moveTo = async (target, from) => {
    let seen = from;
    let current = seen.page ?? 1;
    for (let steps = 0; current !== target; steps += 1) {
      if (steps >= Math.max(limits.maxSteps, target)) throw pagerFailure("pager_page_unreachable", "page " + target + " is more than " + steps + " steps away");
      const enabled = seen.numbers.filter((entry) => entry.enabled);
      const exact = enabled.find((entry) => entry.n === target);
      const toward = target > current
        ? enabled.filter((entry) => entry.n > current && entry.n < target).sort((a, b) => b.n - a.n)[0]
        : enabled.filter((entry) => entry.n < current && entry.n > target).sort((a, b) => a.n - b.n)[0];
      let action;
      let landing;
      if (exact !== undefined) {
        action = () => click("numbers", exact.n);
        landing = exact.n;
      } else if (toward !== undefined) {
        action = () => click("numbers", toward.n);
        landing = toward.n;
      } else if (target > current) {
        action = stepAction(seen, mechanismOf(seen) === "pages" ? "pages" : "next_link");
        landing = current + 1;
      } else if (seen.previous.enabled) {
        action = () => click("previous");
        landing = current - 1;
      } else throw pagerFailure("pager_page_unreachable", "no control leads from page " + current + " toward page " + target);
      const step = await awaitStep(action, seen, false);
      if (!step.moved) throw pagerFailure("pager_page_unreachable", "the step toward page " + target + " changed nothing");
      if (step.seen.url !== seen.url) urlPaged = true;
      const after = await look();
      if (landing === 2) learnUrlBase(seen, after);
      seen = after;
      seen.page = hooks.pageNumber === undefined ? pagerPageOf(seen, urlBase) : seen.page;
      current = seen.page ?? landing;
    }
    return seen;
  };
  // A growing list after steps "Load more" clicks or scrolls from the list as it stands.
  const replay = async (steps, count) => {
    let seen = await look();
    const mechanism = mechanismOf(seen);
    if (!pagerGrowing(mechanism)) throw pagerFailure("pager_no_control", "replay is for a list that grows by steps");
    for (let done = 0; done < steps; done += 1) {
      if (!hasNextOf(seen, mechanism)) break;
      const step = await awaitStep(stepAction(seen, mechanism), seen, true);
      lastStepStalled = !step.moved;
      if (!step.moved) break;
      seen = step.seen;
    }
    return read(count);
  };
  // Walks the list from where it stands, collecting each row once, until limit rows, a row until
  // names, the list's end, maxSteps steps or the time left runs out. It reads the rest of a page
  // before it steps past it. Rows a later page shows again are dropped and mark the list changed;
  // a step that shows only rows already collected stops the walk, since the list went back.
  const walk = async (options, match) => {
    const limit = options.limit ?? Infinity;
    const maxSteps = options.maxSteps ?? limits.maxSteps;
    const deadline = options.timeLeftMs === undefined ? Infinity : Date.now() + options.timeLeftMs;
    const pageRows = options.pageRows ?? 1000;
    const rows = [];
    const keys = new Set();
    let skipping = options.after !== undefined;
    let listChanged = false;
    let duplicates = 0;
    let steps = 0;
    let stoppedBy;
    let found = null;
    const firstCount = skipping || limit === Infinity ? pageRows : Math.min(pageRows, limit + 1);
    let segment = await read(Math.max(1, firstCount));
    const growing = pagerGrowing(segment.mechanism);
    // Whether the walk began at the list's first row, so that reaching its end counted it all.
    const fromTop = (segment.page ?? 1) === 1 && (segment.range?.from ?? 1) <= 1;
    let siteTotal = segment.totalResults;
    let lastIndex = 0;
    let freshCount = 0;
    // Rows this page already gave, when the walk reads more of it.
    let pageKeys = new Set();
    // A page's likely size for the next read: the last page's, or a growing step's added rows.
    let pageSize = segment.rows.length;
    while (stoppedBy === undefined) {
      const fresh = segment.rows.filter((row) => !pageKeys.has(row.key) && !(growing && keys.has(row.key)));
      freshCount = fresh.length;
      let added = 0;
      for (const [index, row] of fresh.entries()) {
        pageKeys.add(row.key);
        if (keys.has(row.key)) {
          duplicates += 1;
          listChanged = true;
          continue;
        }
        if (skipping) {
          keys.add(row.key);
          if (row.key === options.after) skipping = false;
          continue;
        }
        if (options.until !== undefined && options.until(row)) {
          stoppedBy = "until";
          lastIndex = index;
          break;
        }
        if (rows.length >= limit) {
          stoppedBy = "limit";
          lastIndex = index;
          break;
        }
        keys.add(row.key);
        rows.push(row);
        added += 1;
        if (match !== undefined && match(row)) {
          found = { row, index: rows.length - 1, page: segment.page ?? steps + 1, steps };
          stoppedBy = "found";
          lastIndex = index + 1;
          break;
        }
      }
      if (stoppedBy !== undefined) break;
      lastIndex = fresh.length;
      if (segment.totalResults !== null) siteTotal = segment.totalResults;
      const needed = skipping || rows.length < limit;
      // The rest of this page comes before the next one.
      if (segment.more && needed && Date.now() < deadline) {
        const before = segment.rows.length;
        const again = await read(Math.max(before + 1, Math.min(before + pageRows, before * 2 + 1)));
        if (again.rows.length > before) {
          segment = again;
          continue;
        }
        segment = { ...again, more: false };
      }
      if (!needed && !segment.more && !segment.hasNext) {
        stoppedBy = "end";
        break;
      }
      if (!needed) {
        stoppedBy = "limit";
        break;
      }
      if (steps > 0 && added === 0 && fresh.length > 0 && !skipping) {
        stoppedBy = "repeated";
        listChanged = true;
        break;
      }
      if (segment.stalled || !segment.hasNext) {
        // A scroll that adds no rows is how a scrolled list ends, unless the page says more follow.
        stoppedBy = segment.stalled && (segment.hasNext || segment.mechanism !== "scroll") ? "stalled" : "end";
        break;
      }
      if (steps >= maxSteps) {
        stoppedBy = "max_steps";
        break;
      }
      if (Date.now() >= deadline) {
        stoppedBy = "time";
        break;
      }
      const before = segment.rows.length;
      const ask = growing ? Math.min(before + pageRows, (limit === Infinity ? pageRows : limit) + keys.size + 1) : pageRows;
      segment = await next(Math.max(1, ask), pageSize >= 1 ? { expect: growing ? before + pageSize : pageSize } : {});
      if (!growing) pageKeys = new Set();
      if (segment.rows.length > 0) pageSize = growing ? Math.max(1, segment.rows.length - before) : segment.rows.length;
      steps += 1;
    }
    const restOfPage = lastIndex < freshCount;
    const hasMore = stoppedBy === "end" ? false
      : stoppedBy === "stalled" ? segment.hasNext || (siteTotal !== null && siteTotal > rows.length)
      : restOfPage || segment.more || segment.hasNext || stoppedBy === "repeated";
    const counted = stoppedBy === "end" && !listChanged && fromTop && options.after === undefined;
    return {
      rows,
      found,
      hasMore,
      stoppedBy,
      steps,
      listChanged,
      duplicates,
      // Once the walk saw the whole list unchanged from its first row, its own count is the total;
      // a site total that disagrees is reported beside it.
      totalResults: counted ? rows.length : siteTotal,
      ...(counted && siteTotal !== null && siteTotal !== rows.length ? { siteTotal, totalMismatch: true } : {}),
      ...(segment.page === undefined ? {} : { page: segment.page }),
      mechanism: segment.mechanism,
    };
  };
  const collect = (options = {}) => walk(options);
  const find = async (match, options = {}) => {
    if (typeof match !== "function") throw new TypeError("pager.find needs a function that matches the wanted row");
    const result = await walk(options, match);
    return { ...result, row: result.found?.row ?? null };
  };
  // What the list's paging looks like now, without acting: the mechanism the pager would use and
  // the controls it found. Run it while building to choose the tool's mechanism.
  const detect = async () => {
    const seen = await look();
    return {
      mechanism: mechanismOf(seen),
      rows: seen.count,
      duplicateRows: seen.duplicates,
      page: seen.page,
      next: seen.next,
      previous: seen.previous,
      numbers: seen.numbers,
      loadMore: seen.loadMore,
      relNextHref: seen.relNextHref,
      urlPage: seen.urlPage,
      urlOffset: seen.urlOffset,
      urlCursor: seen.urlCursor,
      summary: seen.summary,
      parsed: seen.parsed,
      empty: seen.empty,
      scrollLeft: seen.scroll.left,
    };
  };
  // Chooses the page size: the author's control, else a native select near the list whose options
  // are numbers. It picks the option equal to size, else the largest not above it, and waits for
  // the list to answer. Most sites go back to page one: call it before paging.
  const setPageSize = async (size) => {
    if (hooks.setPageSize !== undefined) return hooks.setPageSize(size);
    let control = spec.pageSize;
    if (control === undefined) {
      const candidates = page.locator("select").filter({ visible: true });
      const options = await candidates.evaluateAll((selects) =>
        selects.map((select) => [...select.options].map((option) => /^\D*(\d{1,4})\D*$/.test(option.textContent.trim()))));
      const index = options.findIndex((flags) => flags.length >= 2 && flags.every(Boolean));
      if (index < 0) throw pagerFailure("pager_no_control", "no page size select shows");
      control = candidates.nth(index);
    }
    const choices = await control.evaluate((select) =>
      [...select.options].map((option) => ({ value: option.value, n: Number(/(\d{1,4})/.exec(option.textContent)?.[1] ?? NaN), selected: option.selected })));
    const numeric = choices.filter((choice) => Number.isFinite(choice.n));
    const wanted = numeric.find((choice) => choice.n === size) ??
      numeric.filter((choice) => choice.n <= size).sort((a, b) => b.n - a.n)[0];
    if (wanted === undefined) throw pagerFailure("pager_no_control", "no page size of " + size + " or less is offered");
    if (wanted.selected) return wanted.n;
    const before = await look();
    const step = await awaitStep(() => control.selectOption(wanted.value, { timeout: waitLimits.action }), before, false);
    if (!step.moved && step.seen.count === before.count && step.seen.summary === before.summary)
      throw pagerFailure("pager_step_timeout", "the list did not change after choosing " + wanted.n + " rows per page");
    return wanted.n;
  };
  return { read, next, goToPage, replay, collect, find, detect, setPageSize, look };
};
`;

/**
 * Page code for a Kernel call body, where `page` is in scope: paste it after `waitCode`, once, at
 * the top of the code string. It declares `listPager(spec)`, which walks a list across its pages
 * and returns each page's rows as `waitForRows` reads them (`{ key, ...fields }`), and
 * `pagerParseSummary(text)`.
 *
 * `spec` names the list: `rows` (a locator for every row) and `key` (the row's identity, as
 * `waitForRows` takes it) are required; `fields` are the row's values. Every control is found on
 * its own from the list's pagination container nearest the rows (top and bottom duplicates
 * collapse into one), and each can be named instead: `list`, `controls`, `next`, `previous`,
 * `pageLinks`, `current`, `loadMore`, `summary`, `pageSize`, `scroller`, `empty` (the site's no
 * results message), `end` (its end-of-list mark) and `loading`. `mechanism` is `pages`,
 * `next_link`, `append`, `scroll` or `offset`, or `auto` to choose from the controls each look
 * finds; the default is `pagerDefaults.mechanism`, which `pagedListReader` sets to the tool's, else
 * `auto`. `hooks` replace one judgement each: `step(mechanism, look)` the action,
 * `hasNext(look, mechanism)`, `pageNumber(look)`, `readTotal(text)` (fields merged over the
 * parsed summary) and `echo()` (a value each segment carries, such as the query the page shows).
 * `siteDomain`, `stableMs`, `unchangedMs`, `noProgressMs`, `timeout` and `maxSteps` bound it.
 *
 * A step is judged by what it changed, never by a fixed sleep: a page step is done once the rows'
 * keys changed (rows re-rendered with the same keys have not moved) or the empty message showed;
 * a growing step once new keys arrived. The page indicator, the URL, the site's requests and DOM
 * changes keep the wait alive. A step that changed nothing once the page went quiet stalled. A
 * control that says the list ended while the page says more follow gets `unchangedMs` to change
 * its mind. A segment's `totalResults` is the summary's exact total only when the page agrees with
 * it; an approximate or contradicted total is null.
 *
 * The pager's methods: `read(count)`, `next(count)`, `goToPage(n, count)` and `replay(steps,
 * count)` return a segment `{ mechanism, rows, more, hasNext, totalResults, page?, range?, href?,
 * stalled?, empty?, echo? }`, `href` only when a step in this call changed the URL;
 * `collect({ limit, until, after, maxSteps, timeLeftMs, pageRows })` and `find(match, options)`
 * walk the list, each row once, and return `{ rows, row?, found, hasMore, stoppedBy, steps,
 * listChanged, duplicates, totalResults, siteTotal?, totalMismatch? }`; `detect()` reports the
 * mechanism and controls without acting; `setPageSize(n)` picks a page size. A failure is a
 * `PagerFailure` whose `reason` is `pager_no_control`, `pager_ambiguous`, `pager_step_timeout`,
 * `pager_page_unreachable` or, for a `next` told `{ stall: "fail" }`, `pager_stalled`: a step that
 * changed nothing twice while the page shows more rows. The waits' own failures pass through.
 */
export const paginationCode = `${scanCode}${pagerCode}`;

/** One row as the pager reads it: its key and each field, null when the row lacks it. */
export interface PagerRow {
  readonly key: string;
  readonly [field: string]: string | null;
}

/** One segment as the pager returns it: `readList`'s segment and what the pager saw of the page. */
export interface PagerSegment<Row> extends ListSegment<Row> {
  readonly mechanism: ListMechanism;
  /** The page number the site shows, when it shows one. */
  readonly page?: number;
  /** A step that changed nothing once the page went quiet. */
  readonly stalled?: boolean;
  readonly empty?: boolean;
  /** What the pager's `echo` hook read, such as the query the page shows. */
  readonly echo?: unknown;
}

const Field = Schema.NullOr(Schema.String);
const RawSegment = Schema.Struct({
  mechanism: Schema.Literal("pages", "next_link", "append", "scroll", "offset"),
  rows: Schema.Array(Schema.Record({ key: Schema.String, value: Field })),
  more: Schema.Boolean,
  hasNext: Schema.Boolean,
  totalResults: Schema.NullOr(Schema.Int.pipe(Schema.nonNegative())),
  page: Schema.optionalWith(Schema.Int.pipe(Schema.positive()), { exact: true }),
  href: Schema.optionalWith(Schema.String, { exact: true }),
  stalled: Schema.optionalWith(Schema.Boolean, { exact: true }),
  empty: Schema.optionalWith(Schema.Boolean, { exact: true }),
  echo: Schema.optionalWith(Schema.Unknown, { exact: true }),
});

/** The mechanisms the pager reads through the page; `api` reads the site's own endpoint instead. */
export type PagerMechanism = Exclude<ListMechanism, "api">;

/** How `pagedListReader` reaches and reads a list. */
export interface PagedListOptions<Row> {
  readonly mechanism: PagerMechanism;
  /**
   * Runs one Kernel call body and returns its result, such as
   * `(code) => kernel.browsers.playwright.execute(sessionId, { code, timeout_sec })` unwrapped.
   * The reader prepends `waitCode`, `paginationCode` and `setup` to each body.
   */
  readonly execute: (code: string) => Promise<unknown>;
  /** Page code that declares `pager`, such as `const pager = listPager({ rows, key, fields });`. */
  readonly setup: string;
  /**
   * Page code that starts the list as a first call does, such as opening the site and running the
   * search. A later call runs it again before it reaches its position by page number or steps.
   */
  readonly start: string;
  /** The row a tool returns, from the pager's row. */
  readonly row: (row: PagerRow) => Row;
  /** The row's stable key: the item's own ID. */
  readonly keyOf: (row: Row) => string;
  readonly promoted?: (row: Row) => boolean;
  /**
   * Whether a page opened by its saved link still shows this list, such as the query its `echo`
   * read. Without it, a link that lands on another page number than the position's starts over.
   */
  readonly sameList?: (segment: PagerSegment<Row>) => boolean;
  readonly remainingMs?: () => number;
  readonly readOnMs?: number;
}

/**
 * A `readList` reader whose site actions are the pager's: `open` opens the position's link and
 * checks it shows the same page, else starts the list (`start`) and goes to its page number, or
 * replays its steps; `more` reads again without acting; `next` takes one step on from the segment
 * it is given. A growing list keeps
 * every row it read before, so rows a virtual list dropped while it scrolled stay in order.
 */
export const pagedListReader = <Row>(
  options: PagedListOptions<Row>,
): ListReader<Row, PagerSegment<Row>> => {
  const growing = options.mechanism === "append" || options.mechanism === "scroll";
  const run = async (body: string): Promise<PagerSegment<Row>> => {
    // The tool's mechanism is the pager's default, so a list that shows no control yet (a short
    // or empty one) still pages the way the tool named.
    const answer = await options.execute(
      `${waitCode}\n${paginationCode}\npagerDefaults = ${JSON.stringify({ mechanism: options.mechanism })};\n${options.setup}\n${body}`,
    );
    const raw = Schema.decodeUnknownSync(RawSegment)(answer);
    if (raw.mechanism !== options.mechanism)
      throw new TypeError(
        `The pager read the list as ${raw.mechanism}, not the ${options.mechanism} the tool names; remove mechanism from listPager or name the same one`,
      );
    const { rows, ...rest } = raw;
    return {
      ...rest,
      rows: rows.map((row) => {
        const key = row["key"];
        if (key === null || key === undefined) throw new TypeError("A pager row has no key");
        return options.row({ ...row, key });
      }),
    };
  };
  // Rows a growing list showed before a step and no longer shows, such as rows a virtual list
  // dropped as it scrolled, then the rows it shows now, each key once.
  const merged = (before: PagerSegment<Row>, after: PagerSegment<Row>): PagerSegment<Row> => {
    if (!growing) return after;
    const keys = new Set(after.rows.map(options.keyOf));
    const dropped = before.rows.filter((row) => !keys.has(options.keyOf(row)));
    return dropped.length === 0 ? after : { ...after, rows: [...dropped, ...after.rows] };
  };
  const startAt = (position: ListPosition | undefined, count: number) => {
    switch (options.mechanism) {
      case "append":
      case "scroll":
        return `${options.start}\nreturn await pager.replay(${String(position?.steps ?? 0)}, ${String(count)});`;
      case "offset":
        return `${options.start}\nreturn await pager.read(${String(count)});`;
      default:
        return (position?.page ?? 1) <= 1
          ? `${options.start}\nreturn await pager.read(${String(count)});`
          : `${options.start}\nreturn await pager.goToPage(${String(position?.page)}, ${String(count)});`;
    }
  };
  return {
    keyOf: options.keyOf,
    ...(options.promoted === undefined ? {} : { promoted: options.promoted }),
    ...(options.remainingMs === undefined ? {} : { remainingMs: options.remainingMs }),
    ...(options.readOnMs === undefined ? {} : { readOnMs: options.readOnMs }),
    open: async (position, count) => {
      if (position?.href !== undefined && !growing && options.mechanism !== "offset") {
        const linked = await run(
          `await page.goto(${JSON.stringify(position.href)}, { waitUntil: "domcontentloaded", timeout: waitLimits.navigation });\nreturn await pager.read(${String(count)}, { href: true });`,
        );
        const same = options.sameList === undefined
          ? linked.page === undefined || position.page === undefined || linked.page === position.page
          : options.sameList(linked);
        if (same) return linked;
      }
      return run(startAt(position, count));
    },
    more: async (segment, count) => {
      const again = await run(`return await pager.read(${String(count)});`);
      const kept = segment.href === undefined || again.href !== undefined ? again : { ...again, href: segment.href };
      return merged(segment, kept);
    },
    // On from the segment readList read last: the pager goes back to its page first when the
    // browser shows another, such as after readList read an earlier page. A step that led nowhere
    // ends the reads, so readList never counts the same page twice.
    next: async (segment, count) => {
      const back =
        growing || segment.page !== undefined || segment.href === undefined
          ? ""
          : `if (page.url() !== ${JSON.stringify(segment.href)}) await page.goto(${JSON.stringify(segment.href)}, { waitUntil: "domcontentloaded", timeout: waitLimits.navigation });\n`;
      const options = growing ? "" : `, { stall: "fail"${segment.page === undefined ? "" : `, from: ${String(segment.page)}`} }`;
      return merged(segment, await run(`${back}return await pager.next(${String(count)}${options});`));
    },
  };
};
