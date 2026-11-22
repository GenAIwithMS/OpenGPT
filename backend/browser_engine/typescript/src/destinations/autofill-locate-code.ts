import { randomUUID } from "node:crypto";
import { opaqueOrigins } from "./autofill-refusal.js";
import { clipCode, controlNamingCode } from "./control-naming-code.js";

/**
 * The primary page's window key for what each step call found, the same for every call of this
 * host process. Random, like the guard's, so it is no fixed name a page could define first; a
 * main-world page can still find it once a call set it.
 */
const judgmentKey = `__opengpt_judgment_${randomUUID()}`;

/**
 * How long a step call's read of a control it already found may wait for that control. A page can
 * take a control away while a call reads it, as a code widget that sends itself does when it loads
 * the next page; Playwright's own default would wait out its whole timeout, or with none set
 * forever, for a control that never comes back. The read fails then, and the call with it. A date
 * call's fill is the exception: it reads its field through the authoring library's `fillDate`,
 * which bounds what it does to the field by its own timeout, not every read.
 */
export const elementReadMs = 5_000;

/**
 * Page code: `where` reads a URL as the host judges it, never its query, fragment or credentials,
 * in any of which page code may have put a typed value: a frame by its origin,
 * a form or link destination by its origin and path, which the request watch counts, and an opaque
 * one by a fixed name, the host's own (`opaqueOrigins`), else `other:`. Credentials are never
 * trusted, so only that a URL has them leaves the page.
 */
const whereCode = `const opaqueNames = ${JSON.stringify(opaqueOrigins)};
const where = (address, path) => {
  let url;
  try {
    url = new URL(address);
  } catch {
    return "invalid";
  }
  if (url.origin === "null") {
    const name = url.protocol === "about:" ? "about:" + url.pathname : url.protocol;
    return opaqueNames.includes(name) ? name : "other:";
  }
  if (url.protocol === "blob:") return "blob:" + url.origin;
  const credentials = url.username !== "" || url.password !== "" ? "credentials@" : "";
  return url.protocol + "//" + credentials + url.host + (path ? url.pathname : "");
};
`;

/**
 * Page code: `keep` holds what a call found in the primary page's window, under the host's
 * per-process key and an id the host chose, and `kept` reads it back, or null once the page lost
 * it (the window was replaced, or a later call's finding pushed it out). A later call compares
 * against it by id, so no call's code holds an address the page supplied.
 */
const keptCode = `const judgmentKey = ${JSON.stringify(judgmentKey)};
const keep = (id, record) =>
  primary
    .mainFrame()
    .evaluate(([key, id, record]) => {
      let kept = window[key];
      if (!(kept instanceof Map)) {
        kept = new Map();
        Object.defineProperty(window, key, { value: kept, configurable: true });
      }
      kept.set(id, record);
      for (const old of kept.keys()) if (kept.size > 32) kept.delete(old);
    }, [judgmentKey, id, record])
    .catch(() => undefined);
const kept = (id) =>
  id === null
    ? Promise.resolve(null)
    : primary
        .mainFrame()
        .evaluate(([key, id]) => (window[key] instanceof Map ? window[key].get(id) ?? null : null), [judgmentKey, id])
        .catch(() => null);
`;

/** Same value-free question read for inspection and the final synchronous credential guard. */
export const questionTextCode = `(element) => {
  if (!element.isConnected ||
      !element.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return null;
  const box = element.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  if (element.matches('input,textarea,select') || element.isContentEditable) return null;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const words = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest('input,textarea,select,[contenteditable]') ||
        !parent.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    words.push(node.textContent);
    if (words.join(' ').length > 8_000) return null;
  }
  const text = words.join(' ').trim().replace(/\\s+/g, ' ');
  return text.length > 0 && text.length <= 2_000 ? text : null;
}`;

/**
 * Page code: the shape of a form control element (`FormControlShape`), the function
 * `formControlShape` in `formControlsCode` evaluates, word for word, so a step call reads it in the
 * same evaluation as the control's other properties. A unit test keeps the two the same.
 */
const controlShapeCode = String.raw`(element) => {
    const popup = element.getAttribute("aria-haspopup");
    if (element instanceof HTMLSelectElement) return "select";
    // A date picker's popup is a dialog or grid: the field still takes typing.
    if (popup === "dialog" || popup === "grid") return element instanceof HTMLInputElement ? "text" : "other";
    if (element.getAttribute("role") === "combobox" || popup === "listbox" || popup === "true" || popup === "menu")
      return "combobox";
    if (element instanceof HTMLInputElement && element.type === "date") return "date";
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable)
      return "text";
    return "other";
  }`;

/**
 * Page code: whether an address is a script that does nothing, the only script action a sign-in
 * form may have: `javascript:`, `javascript:;`, `javascript:void(0)` or `javascript:void 0`, with
 * or without a closing semicolon, read as the browser runs it (the address as parsed, its body
 * percent-decoded). The scheme may be in any case, and whitespace may stand only between the
 * body's words and signs, where script reads it as whitespace: one inside `void` could split it into
 * two statements, the second a call of the page's own function. `void` is lowercase, as script
 * reads it; `Void(0)` calls a function of the page's. Any other body runs what it says, so it is
 * judged as any action off the site; one that does not decode, too. The step call and the
 * submission guard both judge by it.
 */
export const noOpScriptCode = String.raw`(address) => {
  let url;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  if (url.protocol !== "javascript:") return false;
  let body;
  try {
    body = decodeURIComponent(url.href.slice("javascript:".length));
  } catch {
    return false;
  }
  return /^\s*(?:void\s*\(\s*0\s*\)|void\s+0)?\s*;?\s*$/.test(body);
}`;

/**
 * Page code: what a step call reads of one control it found (`readControls`): every form action
 * and method it could submit with, its form's own action first, whether that action is a script
 * that does nothing (`scriptAction`, `noOpScriptCode`), its link destination and whether that is a
 * script that does nothing (`scriptHref`), whether it is disabled, inert or editable, whether it is
 * empty, its shape and the words that label it, never its value.
 */
const controlReadCode = `(element) => {
  const associated =
    "form" in element && element.form instanceof HTMLFormElement ? element.form : element.closest("form");
  // Read through the form's own getters: a control named "action", "method" or "elements"
  // shadows the property of that name on the form itself.
  const formProperty = (name) =>
    Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, name).get.call(associated);
  // The form's own action comes first.
  const actions = associated ? [formProperty("action")] : [];
  const methods = associated ? [formProperty("method")] : [];
  // Whether the form's own action is a script that does nothing, which sends nothing by itself.
  const scriptAction = associated !== null && (${noOpScriptCode})(actions[0]);
  // Whether the form or a control in it says GET itself: a bare form reads as GET too, but a
  // page that submits it with code sends nothing in an address.
  let explicitGet = associated ? (associated.getAttribute("method") ?? "").trim().toLowerCase() === "get" : false;
  // A link-style sign-in action may navigate instead of submitting its containing form.
  const href = element instanceof HTMLAnchorElement ? element.getAttribute("href") : null;
  if (href !== null) actions.push(new URL(href, document.baseURI).href);
  // Whether the link's own address is a script that does nothing, which sends nothing by itself.
  const scriptHref = href !== null && (${noOpScriptCode})(actions[actions.length - 1]);
  // A form's elements leave out its image submits, so they are read beside them.
  const images = associated
    ? Array.from(associated.getRootNode().querySelectorAll("input[type=image]")).filter(
        (input) => input.form === associated,
      )
    : [];
  for (const control of associated ? [...formProperty("elements"), ...images] : [element]) {
    const action = control.getAttribute("formaction");
    if (action !== null) actions.push(new URL(action, document.baseURI).href);
    const method = control.getAttribute("formmethod");
    if (method !== null) methods.push(method.toLowerCase());
    if (method !== null && method.trim().toLowerCase() === "get") explicitGet = true;
  }
  // The method a submission with it as the submitter goes by, as the browser reads it: a submit
  // button's own formmethod, else its form's. Another control's, such as a "Forgot password"
  // button's, says nothing of it.
  const submitter =
    (element instanceof HTMLButtonElement && element.type === "submit") ||
    (element instanceof HTMLInputElement && ["submit", "image"].includes(element.type));
  const submitMethod = associated
    ? submitter && element.hasAttribute("formmethod")
      ? element.formMethod
      : formProperty("method")
    : null;
  // Disabled, which a page may undo once the fields hold input, and inert, which takes no
  // interaction at all, as an inactive or background form does. Page code can redefine what
  // these read, so the submit call reads whether the submit is disabled again through Playwright.
  const disabled = element.matches(":disabled") || element.closest('[aria-disabled="true"]') !== null;
  const inert = element.closest("[inert]") !== null;
  const editable =
    (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
    !disabled && !inert && !element.readOnly;
  // Only whether it holds a value leaves the page, never the value.
  const empty =
    (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
    element.value === "";
  ${controlNamingCode}
  const naming = controlNaming(element);
  return {
    disabled,
    inert,
    shape: (${controlShapeCode})(element),
    target: { documentOrigin: self.origin, actions, scriptAction, scriptHref, methods, explicitGet, submitMethod, editable, empty },
    described: {
      role: element.getAttribute("role"),
      formMethod: methods.join(",") || null,
      tag: element.tagName.toLowerCase(),
      type: naming.type,
      name: naming.name,
      id: naming.id,
      autocomplete: naming.autocomplete,
      inputmode: element.getAttribute("inputmode"),
      label: naming.label,
      placeholder: naming.placeholder,
      ariaLabel: naming.ariaLabel,
      text: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? null : element.textContent,
    },
  };
}`;

/**
 * Page code: `locate` finds a selector's one visible match across the primary tab's frames, and
 * `readControls` reads every control a call found. Where each sits is read from the element itself,
 * never from the frame the search started in: its own frame (or the first one above it with a real
 * URL) and its document's origin. It also reads every form action and method it could submit with,
 * its link destination, shape and words that label it, never its value (`controlReadCode`). Every
 * URL leaves only as `where` reads it; the destinations as found stay in the page
 * (`destinations`), for the guard. For the host's evidence it says which frame matched and how
 * many it searched, or, with no one visible match, each frame that matched and how often.
 */
const findCode = `${clipCode}
// Questions are explicit observed locators, never inferred from names or routes.
const readQuestion = async (frame, selector) => {
  if (selector == null || selector.includes(">>") || selector.includes("internal:")) return undefined;
  try {
    for (let scope = frame; scope.parentFrame() !== null; scope = scope.parentFrame())
      if (!(await (await scope.frameElement()).isVisible())) return undefined;
    const candidates = frame.locator(selector);
    const count = await candidates.count();
    if (count > 100) return undefined;
    const visible = [];
    for (let index = 0; index < count; index++)
      if (await candidates.nth(index).isVisible()) visible.push(candidates.nth(index));
    if (visible.length !== 1) return undefined;
    const text = await visible[0].evaluate(${questionTextCode}, undefined, { timeout: ${elementReadMs} });
    return text === null ? undefined : { locator: visible[0], text };
  } catch { return undefined; }
};
const locate = async (selector, questionSelector) => {
  const visible = [];
  const frames = primary.frames();
  const matches = [];
  for (const frame of frames) {
    const located = frame.locator(selector);
    let count;
    const shown = [];
    try {
      count = await located.count();
      if (count <= 100)
        for (let index = 0; index < count; index++)
          if (await located.nth(index).isVisible()) shown.push(located.nth(index));
    } catch (error) {
      // A frame the page took away mid-search, such as an ad slot, is skipped with what it read.
      if (frame.isDetached()) continue;
      throw error;
    }
    const match = { frameUrl: where(frame.url(), false), count, visible: shown.length };
    if (count > 0) matches.push(match);
    if (count > 100) return { error: "ambiguous_match", searched: { frames: frames.length, matches } };
    for (const locator of shown) visible.push({ frame, locator });
  }
  if (visible.length !== 1)
    return { error: visible.length === 0 ? "not_found" : "ambiguous_match", searched: { frames: frames.length, matches } };
  const [{ frame, locator }] = visible;
  const read = { timeout: ${elementReadMs} };
  const handle = await locator.elementHandle(read);
  let owner = handle ? await handle.ownerFrame() : null;
  while (owner && ["about:blank", "about:srcdoc"].includes(owner.url())) owner = owner.parentFrame();
  // Each frame between the owner and the top document, nearest first, by origin.
  const ancestors = [];
  for (let up = owner ? owner.parentFrame() : null; up && up.parentFrame(); up = up.parentFrame())
    if (!["about:blank", "about:srcdoc"].includes(up.url())) ancestors.push(where(up.url(), false));
  return { frame, locator, handle, owner, ancestors, questionSelector, frames: frames.length };
};
// The controls found in each frame, in the order found.
const frameGroups = (founds) => {
  const groups = new Map();
  for (const found of founds) groups.set(found.frame, [...(groups.get(found.frame) ?? []), found]);
  return [...groups.values()];
};
// One evaluation per frame reads every control found there, so a call sees them all as they were
// at one moment: a page that changes several at once, as a form that locks or unlocks every field
// does, never reads as half changed. The first control's locator runs it, so it waits for that
// control as any read does, and the others go in as the handles found. When the page replaced one
// of those since it was found, or loaded a new document, which no handle found before reaches,
// each control there is read through its own locator, which finds it as the page now shows it. A
// read that fails then fails the call. A wait for the first control that runs out ends the call
// at once, as that control's own read would.
const readControls = async (founds) => {
  const read = { timeout: ${elementReadMs} };
  const reads = new Map();
  for (const group of frameGroups(founds)) {
    const [first, ...others] = group;
    let values = null;
    try {
      values = await first.locator.evaluate((element, others) => {
        if (!others.every((other) => other.isConnected)) return null;
        const readControl = ${controlReadCode};
        return [element, ...others].map(readControl);
      }, others.map((found) => found.handle), read);
    } catch (error) {
      if (error?.name === "TimeoutError") throw error;
    }
    if (values === null) {
      values = [];
      for (const found of group) values.push(await found.locator.evaluate(${controlReadCode}, undefined, read));
    }
    group.forEach((found, index) => reads.set(found, values[index]));
  }
  const controls = [];
  for (const found of founds) {
    const { frame, locator, owner, ancestors, questionSelector, frames } = found;
    const read = reads.get(found);
    const described = Object.fromEntries(Object.entries(read.described).map(([key, value]) => [key, key === "tag" ? value : clip(value)]));
    const question = await readQuestion(frame, questionSelector);
    if (question !== undefined) described.questionText = question.text;
    // A recorded question with no one visible match, or none the host reads, is said so.
    else if (questionSelector != null) described.questionUnread = true;
    const control =
      (read.disabled || read.inert) && (read.shape === "select" || read.shape === "combobox") ? "other" : read.shape;
    controls.push({
      locator,
      question,
      inert: read.inert,
      target: {
        ...read.target,
        ownerUrl: owner ? where(owner.url(), false) : null,
        ancestors,
        actions: read.target.actions.map((action) => where(action, true)),
        control,
      },
      destinations: read.target.actions,
      described,
      located: { frameUrl: where(frame.url(), false), frames },
    });
  }
  return controls;
};
// The controls found before one the call could not find, read through the handles found with no
// wait, as each was read when found: one the page took away, or whose document is gone, is
// skipped, and a read that fails fails the call. A frame's controls are read in one evaluation,
// which throws when one of them is in a document the frame no longer shows; each is then read
// alone, so only the ones whose document is gone are skipped.
const checkReads = async (founds) => {
  const readFails = (element, others) => {
    const readControl = ${controlReadCode};
    for (const each of [element, ...others]) {
      if (!each.isConnected) continue;
      try {
        readControl(each);
      } catch {
        return true;
      }
    }
    return false;
  };
  for (const group of frameGroups(founds)) {
    const [first, ...others] = group;
    let failed = await first.handle.evaluate(readFails, others.map((found) => found.handle)).catch(() => null);
    if (failed === null)
      for (const found of group) {
        failed = await found.handle.evaluate(readFails, []).catch(() => false);
        if (failed) break;
      }
    if (failed) throw new Error("A control the call found could not be read");
  }
};
`;

/**
 * A selector that reaches into another frame (`>>` chains, Playwright's `internal:` engines such as
 * `internal:control=enter-frame`) is never run: each control is found in its own frame.
 */
export const frameCrossing = (selector: string) =>
  selector.includes(">>") || selector.includes("internal:");
export const unsupportedSelector = (step: {
  readonly fields: readonly { readonly selector: string }[];
  readonly submit?: string | undefined;
}) => {
  const index = step.fields.findIndex((field) => frameCrossing(field.selector));
  if (index !== -1) return index;
  return step.submit !== undefined && frameCrossing(step.submit) ? ("submit" as const) : undefined;
};

/**
 * The page code every step call starts with, after `formControlsCode` and with `primary` bound:
 * `where`, `keep` and `kept`, and `locate`.
 */
export const locateCode = `${whereCode}${keptCode}${findCode}`;
