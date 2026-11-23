import { normalizeText } from "../runtime/text.js";

/**
 * Page code for a Kernel call body, where `page` is in scope: paste it at the top of the code
 * string, then read values with `visibleText`, `visibleTexts` or `readRows` and your verified
 * Playwright locators. They read only the text a person sees on the rendered page, never the
 * text of a hidden element, a script, a style or a template.
 *
 * - `visibleText(locator, { as, lines, maxLength }?)` returns the text of the locator's one
 *   rendered match. A hidden match is skipped, so a locator that matches a hidden copy beside the
 *   rendered one still reads the rendered one.
 * - `visibleTexts(locator, { as, lines, maxLength }?)` returns the text of every rendered match,
 *   in page order. Hidden matches and empty texts are dropped.
 * - `readRows(rows, fields, { from, limit, as, lines, maxLength }?)` reads a list in one call. It
 *   takes the rendered matches of `rows`, from index `from` (default 0) for `limit` rows (default
 *   all of them), and returns one record per row. `fields` maps each field name to a CSS selector
 *   inside the row, or to `{ selector, attribute?, required?, lines? }`; `":scope"` is the row
 *   itself. A field is the row's first rendered match of its selector, read as text, or as the
 *   trimmed value of `attribute` when one is named, such as `{ selector: "a", attribute: "href" }`.
 *   A field with no rendered match is `null`, or fails when it is `required`. A row laid out with
 *   `display: contents`, which has no box of its own, is rendered when a child of it is.
 *
 *   ```js
 *   const offers = await readRows(page.locator("#results li.offer"), {
 *     name: { selector: "h3", required: true },
 *     price: ".price",
 *     link: { selector: "a", attribute: "href" },
 *   }, { limit: 20 });
 *   ```
 *
 * They read the page as it is now and never wait: wait for the answer first, for example with
 * `waitForOutcome`. They never change the page. They do not read into an iframe (read its frame's
 * locator instead), they read a panel collapsed by size alone, such as `max-height: 0` with
 * `overflow: hidden`, as visible, and they treat an absolutely positioned slide placed beyond the
 * page's width, as some carousels do, as hidden.
 *
 * Options:
 *
 * - `as`: `"visible"` (default) reads what a person sees and skips text hidden for screen readers
 *   only, such as an off-screen or 1 px clipped copy. `"accessible"` reads what a screen reader
 *   reads: it keeps that text and skips `aria-hidden="true"` content instead. A page that shows a
 *   value twice, a visual copy hidden from screen readers and a screen-reader copy hidden from
 *   view, yields exactly one copy in each mode, and a match hidden in the chosen mode is not
 *   rendered.
 * - `lines`: `false` (default) joins the text into one line with single spaces. `true` keeps one
 *   line per block, list item, table row or `<br>`.
 * - `maxLength`: default 4000 characters per value.
 *
 * Text is normalized as `normalizeText` does: characters that never show removed (the zero-width
 * non-joiner and joiner, which spell words and join emoji, stay), no-break and other Unicode
 * spaces read as spaces, runs of spaces collapsed, lines trimmed and empty lines dropped.
 *
 * They throw an `Error` named `VisibleTextFailure` with a `reason`, and a message that carries
 * counts, never page text:
 *
 * - `not_found`: the locator matched nothing (`matched` 0), or a `required` field had no rendered
 *   match; then `field` names it and `row` is its row's index among the rendered rows.
 * - `hidden_only`: the locator matched only hidden elements (`matched`, `rendered` 0). `readRows`
 *   fails so too when rows matched and none is rendered while one of them still has a box, such
 *   as rows at `opacity: 0` or `visibility: hidden` that are still fading in, or rows hidden from
 *   screen readers read `as: "accessible"`. Rows with no box at all, such as a template row a
 *   no-results page keeps `hidden` or `display: none`, read as `[]`: check the page's empty state
 *   when an empty list needs telling apart from a wrong selector.
 * - `ambiguous`: `visibleText` found several rendered matches (`matched`, `rendered`). Scope the
 *   locator to one, or use `visibleTexts` or `readRows` for a list.
 * - `too_long`: a value is longer than `maxLength` (`length`, `maxLength`, and `field` and `row`
 *   in `readRows`), which usually means the locator names a container rather than the value.
 */
export const visibleTextCode = String.raw`
const visibleTextFailure = (reason, message, detail) =>
  Object.assign(new Error(reason + ": " + message), { name: "VisibleTextFailure", reason, ...detail });
const visibleTextOptions = (options = {}) => {
  const as = options.as ?? "visible";
  if (as !== "visible" && as !== "accessible") throw new TypeError('as must be "visible" or "accessible"');
  const maxLength = options.maxLength ?? 4000;
  if (!Number.isInteger(maxLength) || maxLength < 1) throw new TypeError("maxLength must be a positive integer");
  return { as, lines: options.lines === true, maxLength };
};
// Runs in the page. It reads the rendered tree and never changes the page.
const visibleTextPage = (elements, arg) => {
  const normalize = ${String(normalizeText)};
  const styles = new Map();
  const style = (element) => {
    let computed = styles.get(element);
    if (computed === undefined) styles.set(element, (computed = getComputedStyle(element)));
    return computed;
  };
  const parentOf = (node) =>
    node.assignedSlot ?? node.parentElement ?? (node.parentNode instanceof ShadowRoot ? node.parentNode.host : null);
  const skipped = (element) => {
    const name = element.localName;
    if (name === "script" || name === "style" || name === "noscript" || name === "template") return true;
    return element.namespaceURI === "http://www.w3.org/2000/svg" && (name === "title" || name === "desc");
  };
  const clipsOverflow = (value) => value === "hidden" || value === "clip";
  const lengths = (text) => text.trim().split(/[\s,]+/u).map((value) => parseFloat(value));
  // clip: rect(top, right, bottom, left) with no area left, such as rect(0 0 0 0) or rect(1px 1px 1px 1px).
  const clipHides = (clip) => {
    const rect = /^rect\((.*)\)$/u.exec(clip);
    if (rect === null) return false;
    const [top, right, bottom, left] = lengths(rect[1]);
    return (Number.isFinite(top) && Number.isFinite(bottom) && bottom <= top)
      || (Number.isFinite(left) && Number.isFinite(right) && right <= left);
  };
  // clip-path: inset() that takes in at least the whole box, such as inset(50%).
  const insetHides = (clipPath) => {
    const inset = /^inset\(([^)]{0,200}?)(?:\s{1,10}round\b[^)]{0,200})?\)$/u.exec(clipPath);
    if (inset === null || !/^[\d.\s%]+$/u.test(inset[1])) return false;
    const [top = 0, right = top, bottom = top, left = right] = lengths(inset[1]);
    return top + bottom >= 100 || left + right >= 100;
  };
  // Hidden from view but kept for screen readers: a clipped box of at most 1 px, a zero-area
  // clip, or a box placed wholly outside the page.
  const visuallyHidden = (element, computed) => {
    // An element with display: contents has no box to clip or move; its children are judged.
    if (computed.display === "contents") return false;
    if (insetHides(computed.clipPath)) return true;
    if (parseFloat(computed.textIndent) <= -999) return true;
    const positioned = computed.position === "absolute" || computed.position === "fixed";
    if (positioned && clipHides(computed.clip)) return true;
    const clipped = clipsOverflow(computed.overflowX) && clipsOverflow(computed.overflowY);
    if (!clipped && !positioned) return false;
    const rect = element.getBoundingClientRect();
    if (clipped && rect.width <= 1 && rect.height <= 1) return true;
    if (!positioned) return false;
    const fixed = computed.position === "fixed";
    const x = fixed ? 0 : scrollX;
    const y = fixed ? 0 : scrollY;
    const width = fixed ? innerWidth : document.documentElement.scrollWidth;
    const height = fixed ? innerHeight : document.documentElement.scrollHeight;
    const before = (end, size) => end < 0 || (size > 0 && end <= 0);
    return before(rect.right + x, rect.width) || before(rect.bottom + y, rect.height)
      || rect.left + x >= width || rect.top + y >= height;
  };
  const excluded = (element, computed) =>
    arg.as === "accessible" ? element.getAttribute("aria-hidden") === "true" : visuallyHidden(element, computed);
  const childrenOf = (node) =>
    node.shadowRoot?.childNodes
      ?? (node.localName === "slot" ? node.assignedNodes({ flatten: true }) : node.childNodes);
  const hasArea = (rects) => [...rects].some((rect) => rect.width > 0 || rect.height > 0);
  // An element with display: contents has no box of its own: it shows what its children show,
  // a rendered child element or a text node with a box.
  const showsBox = (element) => {
    if (style(element).display !== "contents")
      return element.checkVisibility({ visibilityProperty: true, opacityProperty: true })
        && hasArea(element.getClientRects());
    return [...childrenOf(element)].some((child) => {
      if (child.nodeType === Node.ELEMENT_NODE) return !skipped(child) && !excluded(child, style(child)) && showsBox(child);
      if (child.nodeType !== Node.TEXT_NODE || child.data.trim() === "") return false;
      const parent = parentOf(child);
      if (parent === null || style(parent).visibility !== "visible") return false;
      const range = document.createRange();
      range.selectNodeContents(child);
      return hasArea(range.getClientRects());
    });
  };
  // A match is rendered when it has a box a person could see, and neither it nor an ancestor up
  // to stop is hidden in this mode.
  const rendered = (element, stop) => {
    if (!element.isConnected || element.closest("[hidden], template") !== null) return false;
    if (!showsBox(element)) return false;
    for (let at = element; at !== null && at !== stop; at = parentOf(at)) {
      if (at.nodeType !== Node.ELEMENT_NODE) break;
      if (skipped(at) || excluded(at, style(at))) return false;
      if (at === document.documentElement) break;
    }
    return true;
  };
  const inline = (display) => display.startsWith("inline") || display === "contents" || display.startsWith("ruby");
  const read = (root, lines) => {
    const parts = [];
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = parentOf(node);
        if (parent === null) return;
        const computed = style(parent);
        if (computed.visibility !== "visible") return;
        const keepBreaks = /^(pre|break-spaces)/u.test(computed.whiteSpace);
        parts.push(keepBreaks ? node.data : node.data.replace(/[\t\n\r\f ]+/gu, " "));
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node !== root) {
        if (skipped(node)) return;
        const computed = style(node);
        if (computed.display === "none" || parseFloat(computed.opacity) === 0 || excluded(node, computed)) return;
      }
      if (node.localName === "br") {
        parts.push("\n");
        return;
      }
      const computed = style(node);
      const display = computed.display;
      const separator = display === "table-cell" ? " " : inline(display) ? "" : "\n";
      parts.push(separator);
      if (computed.contentVisibility !== "hidden") for (const child of childrenOf(node)) visit(child);
      parts.push(separator);
    };
    visit(root);
    return normalize(parts.join(""), { lines });
  };
  if (arg.fields === undefined)
    return elements.map((element) => (rendered(element, null) ? read(element, arg.lines) : null));
  const rows = elements.filter((element) => rendered(element, null));
  // No row rendered: an empty list when every row is a template with no box, such as a
  // no-results page's hidden or display: none row. A row that has a box but is hidden another
  // way, such as a list still fading in from opacity 0 or rows hidden in this mode, is not.
  const showsContent = (element) =>
    [element, ...[...element.querySelectorAll("*")].slice(0, 500)].some((child) =>
      child.checkVisibility() && hasArea(child.getClientRects()));
  if (rows.length === 0 && elements.some(showsContent)) return { hidden: elements.length };
  const end = arg.limit === null ? rows.length : Math.min(rows.length, arg.from + arg.limit);
  const records = [];
  for (let index = arg.from; index < end; index += 1) {
    const row = rows[index];
    const record = {};
    for (const [name, field] of arg.fields) {
      const candidates = field.selector === ":scope" ? [row] : [...row.querySelectorAll(field.selector)];
      const match = candidates.find((element) => element === row || rendered(element, row));
      const value = match === undefined ? null
        : field.attribute === null ? read(match, field.lines ?? arg.lines)
        : match.getAttribute(field.attribute)?.trim() ?? null;
      if (value === null && field.required) return { missing: { field: name, row: index } };
      if (value !== null && value.length > arg.maxLength)
        return { tooLong: { field: name, row: index, length: value.length } };
      record[name] = value;
    }
    records.push(record);
  }
  return { records };
};
const visibleTextRead = async (locator, options) => {
  const { as, lines, maxLength } = visibleTextOptions(options);
  const texts = await locator.evaluateAll(visibleTextPage, { as, lines });
  const shown = texts.filter((text) => text !== null);
  const tooLong = shown.find((text) => text.length > maxLength);
  if (tooLong !== undefined)
    throw visibleTextFailure("too_long", tooLong.length + " characters, over the " + maxLength + " limit",
      { length: tooLong.length, maxLength });
  return { matched: texts.length, shown };
};
const visibleText = async (locator, options) => {
  const { matched, shown } = await visibleTextRead(locator, options);
  const counts = { matched, rendered: shown.length };
  const seen = matched + " matched, " + shown.length + " rendered";
  if (matched === 0) throw visibleTextFailure("not_found", seen, counts);
  if (shown.length === 0) throw visibleTextFailure("hidden_only", seen, counts);
  if (shown.length > 1) throw visibleTextFailure("ambiguous", seen, counts);
  return shown[0];
};
const visibleTexts = async (locator, options) =>
  (await visibleTextRead(locator, options)).shown.filter((text) => text !== "");
const readRows = async (rows, fields, options = {}) => {
  const { as, lines, maxLength } = visibleTextOptions(options);
  const from = options.from ?? 0;
  const limit = options.limit ?? null;
  if (!Number.isInteger(from) || from < 0) throw new TypeError("from must be a non-negative integer");
  if (limit !== null && (!Number.isInteger(limit) || limit < 0)) throw new TypeError("limit must be a non-negative integer");
  const entries = Object.entries(fields).map(([name, field]) => {
    const spec = typeof field === "string" ? { selector: field } : field;
    if (typeof spec?.selector !== "string") throw new TypeError("field " + name + " needs a selector");
    return [name, {
      selector: spec.selector,
      attribute: spec.attribute ?? null,
      required: spec.required === true,
      lines: spec.lines ?? null,
    }];
  });
  const answer = await rows.evaluateAll(visibleTextPage, { as, lines, maxLength, from, limit, fields: entries });
  if (answer.hidden !== undefined)
    throw visibleTextFailure("hidden_only", answer.hidden + " matched, 0 rendered",
      { matched: answer.hidden, rendered: 0 });
  if (answer.missing !== undefined)
    throw visibleTextFailure("not_found",
      "required field " + answer.missing.field + " has no rendered match in row " + answer.missing.row,
      answer.missing);
  if (answer.tooLong !== undefined)
    throw visibleTextFailure("too_long",
      "field " + answer.tooLong.field + " in row " + answer.tooLong.row + " has " + answer.tooLong.length
        + " characters, over the " + maxLength + " limit",
      { ...answer.tooLong, maxLength });
  return answer.records;
};
`;
