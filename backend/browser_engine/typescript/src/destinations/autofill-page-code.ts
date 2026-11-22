import { Schema } from "effect";
import { formControlsCode } from "../browser/form-controls.js";
import { maximumCodeBoxes, type AutofillPopup, type DateOfBirthFormat } from "./autofill-contracts.js";
import { elementReadMs, locateCode, questionTextCode } from "./autofill-locate-code.js";
import { clipCode, controlNamingCode } from "./control-naming-code.js";
import { pageCode, primaryPageCode } from "../runtime/host-execute.js";
import { hostOnSiteSource } from "../runtime/same-site.js";
import { submissionGuardCode } from "./autofill-submission-guard.js";
import { holdsFocusCode } from "./field-focus-code.js";
import { pageControlsCode } from "./page-controls.js";

/**
 * Page code: where each code field sits among its screen's one-character boxes, as
 * `Described.codeBox` says, else null. A box is a visible, enabled, editable text input that takes
 * one character:
 * - by its `maxlength` of 1, among the like boxes of its screen, the field's form, or its document
 *   or shadow root outside one;
 * - or, with no `maxlength` limit, by the page's own script, as many one-time-code widgets limit
 *   their boxes, when the step names two or more code fields: among the visible, enabled, editable
 *   text inputs that are children of its parent element, when those are two to
 *   `maximumCodeBoxes`, all of its type and none with a `maxlength` limit. A field that is the only
 *   such input in its parent counts one level up instead, among its parent and the parent's
 *   siblings, when each of them holds one such input as its only element. Elements that show no
 *   box, such as a hidden input, a style element or a message not shown, count at neither level.
 *   When the step's boxes found so disagree on how many there are, or two take one place, as boxes
 *   split between two containers do, none of them is a box.
 * A field that is no box, or a screen with fewer than two, has none. Attributes only, never a value.
 * When the step names one code field and it is the first box of such a row by its `maxlength`, as
 * a code screen the recipe never recorded may show, `codeBoxRow` names each other box of that same
 * row, in order, by a selector that matches it alone in its document or shadow root: its id, else
 * its name, else its `aria-label`. A row with a box none of those name alone, or with more than
 * `maximumCodeBoxes` boxes, has none.
 */
const codeBoxesCode = `const codeBoxes = [];
const codeFields = codeSlots.filter(Boolean).length;
for (const [index, field] of fields.entries()) {
  if (!codeSlots[index]) {
    codeBoxes.push(null);
    continue;
  }
  const codeBox = await field.locator.evaluate((element, [codeFields, mostBoxes]) => {
    const textTypes = ["", "text", "tel", "number", "password", "search"];
    const shown = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && node.checkVisibility({ visibilityProperty: true });
    };
    const shownChildren = (node) => Array.from(node.children).filter(shown);
    const editable = (control) => {
      if (control.tagName !== "INPUT") return false;
      if (!textTypes.includes((control.getAttribute("type") ?? "").toLowerCase())) return false;
      if (control.disabled || control.readOnly) return false;
      return shown(control);
    };
    const place = (boxes, limit) => {
      const at = boxes.indexOf(element);
      return boxes.length < 2 || at < 0 ? null : { box: at + 1, of: boxes.length, limit };
    };
    const nameOf = (control) => {
      const root = control.getRootNode();
      for (const attribute of ["id", "name", "aria-label"]) {
        const value = control.getAttribute(attribute);
        if (!value) continue;
        const selector = "input[" + attribute + '="' + CSS.escape(value) + '"]';
        const matches = root.querySelectorAll(selector);
        if (matches.length === 1 && matches[0] === control) return selector;
      }
      return null;
    };
    if (!editable(element)) return null;
    if (element.maxLength === 1) {
      const screen = element.form ?? element.getRootNode();
      const boxes = Array.from(screen.querySelectorAll("input")).filter((control) => editable(control) && control.maxLength === 1);
      const found = place(boxes, "maxlength");
      if (found === null || codeFields !== 1 || found.box !== 1 || boxes.length > mostBoxes) return found;
      return { ...found, rest: boxes.slice(1).map(nameOf) };
    }
    if (element.maxLength >= 0 || codeFields < 2 || element.parentNode === null) return null;
    let boxes = Array.from(element.parentNode.children).filter(editable);
    const wrapper = element.parentElement;
    if (boxes.length === 1 && wrapper?.parentNode) {
      boxes = shownChildren(wrapper.parentNode).map((child) => {
        const held = shownChildren(child);
        return held.length === 1 ? held[0] : null;
      });
      if (!boxes.every((control) => control !== null && editable(control))) return null;
    }
    if (boxes.length > mostBoxes || boxes.some((control) => control.maxLength >= 0 || control.type !== element.type))
      return null;
    return place(boxes, "script");
  }, [codeFields, ${maximumCodeBoxes}], { timeout: ${elementReadMs} }).catch(() => null);
  codeBoxes.push(codeBox);
}
const rowRest = codeBoxes.find((codeBox) => codeBox?.rest !== undefined)?.rest;
const codeBoxRow = rowRest === undefined || rowRest.includes(null) ? undefined : rowRest;
const scriptBoxes = codeBoxes.filter((codeBox) => codeBox?.limit === "script");
const scriptAgree =
  new Set(scriptBoxes.map(({ box }) => box)).size === scriptBoxes.length &&
  new Set(scriptBoxes.map(({ of }) => of)).size <= 1;
for (const [index, codeBox] of codeBoxes.entries())
  codeBoxes[index] =
    codeBox === null || (codeBox.limit === "script" && !scriptAgree) ? null : { box: codeBox.box, of: codeBox.of };`;

/**
 * Page code: the step's controls and visible native and ARIA actions, for the host and Guardian.
 * The page keeps the controls as found, with every form destination as found, under `observed`.
 */
const inspectCode = `await keep(observed, {
  questions: fields.map(({ described }) => described.questionText ?? null),
  targets: { fields: fields.map(({ target }) => target), submit: submit === null ? null : submit.target },
  destinations: [submit, ...fields].flatMap((found) => found?.destinations ?? []),
});
const buttons = [];
for (const frame of primary.frames()) {
  const candidates = frame.locator('button, input[type="submit"], input[type="button"], input[type="image"], a, [role~="button"], [role~="link"], [role~="menuitem"], [role~="radio"]');
  const read = [];
  try {
    const count = Math.min(await candidates.count(), 50);
    for (let index = 0; index < count && buttons.length + read.length < 20; index++) {
      const candidate = candidates.nth(index);
      if (!(await candidate.isVisible())) continue;
      const words = clip(await candidate.evaluate((element) => element.getAttribute("aria-label") ?? (element instanceof HTMLInputElement ? (element.type === "image" ? element.alt : element.value) : element.textContent), undefined, { timeout: ${elementReadMs} }));
      read.push(words ?? "(unlabelled button)");
    }
  } catch (error) {
    // A frame the page took away mid-read is skipped with its buttons.
    if (frame.isDetached()) continue;
    throw error;
  }
  buttons.push(...read);
}
${codeBoxesCode}
return {
  fields: fields.map(({ target, described }, index) => ({
    target,
    described: codeBoxes[index] === null ? described : { ...described, codeBox: codeBoxes[index] },
  })),
  submit: submit === null ? null : { target: submit.target, described: submit.described },
  located,
  buttons,
  ...(submitKey === null || submit === null ? {} : { keySubmit: { submitControls: submit.submitControls } }),
  ...(popupTargetId === undefined ? {} : { popupTargetId }),
  ...(codeBoxRow === undefined ? {} : { codeBoxRow }),
  url: primary.url(),
  document: await documentStart(),
};`;

/**
 * One call of a step's fill, after its inspection. None carries a value but a date's: the host
 * types every other value itself over its own DevTools socket, into the field `focus` left focused. `check` names the field the host typed just before, which must now hold
 * something, so typing that went to another element never leads to a click.
 * - `focus`: empties the field when it holds something and focuses it, then reads that the field
 *   itself holds the focus, inside a shadow root too (`holdsFocusCode`), and names the tag of the
 *   element that holds it otherwise.
 * - `date`: fills a date of birth with the authoring library's `fillDate`, which needs the page's
 *   own options, so this call's code holds the date (`iso`).
 * - `dismiss`: clicks a covering notice's own control (`dismissCode`).
 * - `submit`: first reads whether the page sent what was typed itself (`pageSentCode`). Otherwise
 *   it guards the submission as it fires (`submissionGuardCode`, under the host's
 *   `guardKey` and armed for `guardCall`, with every form action and link destination as the
 *   step's inspection found them, which the page kept under `inspection`, the submission's method
 *   as judged, and how each field's secret is found by value, if it is one), reads the page's
 *   alert text when the host counts new alerts (`alertsBefore`), clicks the submit (or, for a step
 *   with a submit key, presses that key in its last field, which stands as the submit), or presses
 *   Enter on the submit itself once focus landed on it, when another element caught a click the
 *   host may press past (`pressCovered`) or the step says to (`submitVia`), waits for the page to
 *   settle and reads its controls (`pageControlsCode`), with how many of their alerts did not show
 *   before the click (`newAlerts`) when it read them. A disabled submit it never clicks: it says so
 *   and does nothing, and the host calls again while the page may still enable it.
 */
export type AutofillFillCall =
  | {
      /**
       * Clicks the step's `dismiss`, a covering notice's own close, reject or accept control, when it shows
       * (`dismissCode`): never one of the step's controls, one that holds or shares a form with
       * them, one that submits a form, or a link to another page. A control of a notice that
       * covers one of the step's controls may share their form or submit one: its click's
       * submission is cancelled.
       */
      readonly kind: "dismiss";
      readonly selector: string;
    }
  | {
      readonly kind: "focus";
      readonly index: number;
      readonly bindingKey: string;
    }
  | {
      readonly kind: "date";
      readonly index: number;
      readonly iso: string;
      readonly format: DateOfBirthFormat;
    }
  | {
      readonly kind: "submit";
      readonly settleMs: number;
      readonly guardKey: string;
      readonly guardCall: string;
      /** The id the page keeps the step's inspection under. */
      readonly inspection: string | undefined;
      /**
       * Once something was typed before the inspection, the configured origins, whose own scheme
       * and host alone still exempt a secret in place of what the inspection found; else null.
       */
      readonly exempt: readonly string[] | null;
      readonly secretMatch: readonly ("within" | "token" | null)[];
      /** The submit as judged: whether it submits a form at all, and by GET. */
      readonly submitInForm: boolean;
      readonly submitGet: boolean;
      /** Whether each field's own form was judged to submit by GET. */
      readonly fieldGet: readonly boolean[];
      /**
       * A sign-in step's submit: its guard lets a submission to a script that does nothing
       * (`javascript:`, `javascript:void(0)`, `javascript:;`) fire by GET, since navigating there
       * puts no entry in an address and runs nothing.
       */
      readonly scriptSubmit?: true;
      /** Only look: a call that finds the step's fields clicks nothing and answers `none`. */
      readonly look?: true;
      /**
       * The step's code boxes, by field index: its code fields the host typed one character each,
       * when it typed two or more. Each must still hold exactly one character before the click.
       */
      readonly codeBoxes?: readonly number[];
      /**
       * Read the page's alerts just before the click, waiting at most `alertsBeforeMs`, so the
       * answer counts the new ones after it (`newAlerts`); a read that runs out counts nothing.
       */
      readonly alertsBefore?: true;
      /**
       * When another element catches the click, press the submit from the keyboard instead, once
       * focus lands on it: only on the host's click again of a `blocked` screen. Without it, such a
       * click is `blocked`, so a covering notice is dismissed first.
       */
      readonly pressCovered?: true;
    };

/** How long the read of the page's alerts before a submit's click may hold the click back. */
const alertsBeforeMs = 500;

/**
 * Page code: when any control differs from the one the host last judged (the submit's `editable`
 * aside, which only follows whether it is disabled, as a submit input's does), which the page kept
 * under `judged`, or the page lost it, does nothing, keeps every control as found under `observed` and
 * hands them back, for the host to judge again by inspection's rule (page code may move a form off
 * the site once values are typed, so each call finds and judges every control again). Otherwise
 * checks that each field in `check` still holds something (the one the host just typed, or every
 * field it typed before a submit it clicks again), then runs the call; the first that holds nothing
 * fails the check, with its index. A field that check cannot read counts
 * as empty, except in the submit call of a step with fields and no submit (`readsOnly`), which only
 * reads the page: there a read that fails, as when the page takes the field away while the call
 * reads it, fails the call, a look the host takes again, and is never a typed field left empty.
 * With no settle wait the host takes no look again, so the failed call stands, and the host reports
 * it as uncertain: what was typed may have been sent.
 */
const fillCallCode = (
  call: AutofillFillCall,
  judgedId: string | undefined,
  check: readonly number[],
  typedAt: string,
) => `const judgment = await kept(${JSON.stringify(judgedId ?? null)});
const judged = judgment?.targets ?? null;
const questions = fields.map(({ described }) => described.questionText ?? null);
for (let index = 0; index < questionSelectors.length; index++) {
  if (questionSelectors[index] === null) continue;
  if (judgment === null) return { error: "target_changed", target: index, url: primary.url() };
  if (questions[index] !== judgment.questions?.[index])
    return { error: "target_changed", target: index, question: "changed", url: primary.url() };
}
const same = (found, expected, editable = true) =>
  found === null || expected === null
    ? found === expected
    : found.ownerUrl === expected.ownerUrl &&
      JSON.stringify(found.ancestors ?? []) === JSON.stringify(expected.ancestors ?? []) &&
      (found.explicitGet ?? false) === (expected.explicitGet ?? false) &&
      (found.scriptAction ?? false) === (expected.scriptAction ?? false) &&
      (found.scriptHref ?? false) === (expected.scriptHref ?? false) &&
      found.documentOrigin === expected.documentOrigin &&
      (!editable || found.editable === expected.editable) &&
      found.control === expected.control &&
      JSON.stringify(found.actions) === JSON.stringify(expected.actions) &&
      JSON.stringify(found.methods) === JSON.stringify(expected.methods) &&
      found.submitMethod === expected.submitMethod;
const found = { fields: fields.map(({ target }) => target), submit: submit === null ? null : submit.target };
if (
  judged === null ||
  found.fields.some((target, index) => !same(target, judged.fields[index] ?? null)) ||
  // A submit the page enables is no change: the submit call reads whether it is disabled itself.
  !same(found.submit, judged.submit, false)
) {
  await keep(observed, { targets: found, questions });
  return { changed: found, located, url: primary.url() };
}
// Where the page was as the host typed each field, kept in the page under the fill's id, so the
// submit call compares against it with no address in its code.
const typedAt = ${JSON.stringify(typedAt)};
const readsOnly = ${JSON.stringify(call.kind === "submit")} && fields.length > 0 && submit === null;
${call.kind === "submit" ? pageSentCode : call.kind === "dismiss" ? "" : "await keep(typedAt, primary.url());"}
for (const check of ${JSON.stringify(check)}) {
  // Its length only, never its value.
  const holding = fields[check].locator.evaluate(
    (element) => typeof element.value === "string" && element.value.length > 0,
    undefined,
    { timeout: ${elementReadMs} },
  );
  const holds = await (readsOnly ? holding : holding.catch(() => false));
  if (!holds) {
    ${call.kind === "submit" ? "if (await allEmptied()) return { pageSent: true, url: primary.url() };" : ""}
    return { checked: false, field: check, url: primary.url() };
  }
}
${call.kind === "submit" && call.look !== true ? codeBoxesHoldCode(call.codeBoxes ?? []) : ""}
${fillCallBody(call)}`;

/**
 * Page code for the submit call of a step the host submits, whose code the host typed across
 * several one-character boxes (`boxes`, by field index): before the host clicks, each holds
 * exactly one character, so a box a widget emptied or filled twice as the host typed the next never
 * goes out as part of a code. Lengths only, never a value; a box it cannot read counts as wrong.
 * The first that does not fails the check, with its index (`field`).
 */
const codeBoxesHoldCode = (boxes: readonly number[]) =>
  boxes.length === 0
    ? ""
    : `if (!readsOnly) {
  for (const index of ${JSON.stringify(boxes)}) {
    const field = fields[index];
    if (field === undefined) continue;
    const holdsOne = await field.locator
      .evaluate(
        (element) => typeof element.value === "string" && Array.from(element.value).length === 1,
        undefined,
        { timeout: ${elementReadMs} },
      )
      .catch(() => false);
    if (!holdsOne) return { checked: false, field: index, url: primary.url() };
  }
}`;

/**
 * Page code for the submit call of a step with fields and no submit, once every field is typed and
 * found as the host judged it: the page sent what was typed itself, as a code widget does on its
 * last box, when its address names another page than the one the host typed the last field on
 * (`typedAt`, by origin and path, so a query or hash the page writes as it goes is no move; a
 * window replaced since keeps no address to compare), or every field is disabled. A step whose
 * fields are gone was sent too; the host reads that from the call's own refusal to find them.
 * `allEmptied`, for the check of the field typed last, reads whether the page emptied every field
 * of such a step of several, as a widget does when it draws its boxes again after the site refused
 * what it sent: the host saw each earlier field hold its value when it typed the next. Lengths
 * only, never a value; a field it cannot read fails the call, as the check's own read does there
 * (`readsOnly`). A step with a submit is the host's to click: a form that locks, moves or
 * redraws itself while it checks what was typed has not sent it, and the submit call waits on it
 * or refuses as before.
 */
const pageSentCode = `const originAndPath = (url) => {
  try {
    const at = new URL(url);
    return at.origin + at.pathname;
  } catch {
    return null;
  }
};
if (readsOnly) {
  const typedPage = await kept(typedAt);
  if (typeof typedPage === "string" && originAndPath(typedPage) !== originAndPath(primary.url()))
    return { pageSent: true, url: primary.url() };
  const fieldsDisabled = await Promise.all(
    fields.map(({ locator }) => locator.isDisabled({ timeout: 1000 }).catch(() => false)),
  );
  if (fieldsDisabled.every(Boolean)) return { pageSent: true, url: primary.url() };
}
const allEmptied = async () => {
  if (fields.length < 2 || !readsOnly) return false;
  for (const { locator } of fields) {
    const empty = await locator.evaluate(
      (element) => typeof element.value === "string" && element.value.length === 0,
      undefined,
      { timeout: ${elementReadMs} },
    );
    if (!empty) return false;
  }
  return true;
};`;

/**
 * Page code: the element at the centre of `element`, a submit whose click failed, when it is
 * neither the submit, inside it nor around it: the outermost element over the submit that holds it,
 * as a notice holds its own buttons, by its tag and role attribute, each cut short, never anything
 * else of it (`coveringElement` keeps those on its lists). Null when the submit has no box or
 * nothing else sits over it.
 */
const coveringCode = `(element) => {
  const box = element.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const root = element.getRootNode();
  let hit = (typeof root.elementFromPoint === "function" ? root : element.ownerDocument).elementFromPoint(x, y);
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (inner === null || inner === hit) break;
    hit = inner;
  }
  if (hit === null || hit === element || element.contains(hit) || hit.contains(element)) return null;
  let cover = hit;
  const page = [element.ownerDocument.body, element.ownerDocument.documentElement];
  while (cover.parentElement !== null && !page.includes(cover.parentElement) && !cover.parentElement.contains(element))
    cover = cover.parentElement;
  return { tag: String(cover.tagName).slice(0, 40), role: cover.getAttribute("role")?.slice(0, 40) ?? null };
}`;

/**
 * Page code: the covering notice that holds `element`, else null. For each of the step's controls
 * (`own`) with a box, scrolled into view when its centre lies outside it and `scroll` says so
 * (else skipped), the element at that
 * centre when it is neither the control, inside it nor around it, and the outermost element over
 * the control that holds it, as `coveringCode` reads a notice that caught a click. That element is
 * the covering notice when it holds `element` and none of the step's controls. Open shadow roots
 * count as part of their host.
 */
const noticeCoverCode = `(element, own, scroll) => {
  const parentOf = (node) => (node.parentNode instanceof ShadowRoot ? node.parentNode.host : node.parentNode);
  const holds = (outer, inner) => {
    for (let node = inner; node !== null; node = parentOf(node)) if (node === outer) return true;
    return false;
  };
  const page = [element.ownerDocument.body, element.ownerDocument.documentElement];
  for (const control of own) {
    const view = control.ownerDocument.defaultView;
    const centre = () => {
      const box = control.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return null;
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      return x >= 0 && y >= 0 && x < view.innerWidth && y < view.innerHeight ? { x, y } : undefined;
    };
    let at = centre();
    if (at === undefined && scroll) {
      control.scrollIntoView({ block: "nearest", inline: "nearest" });
      at = centre();
    }
    if (at === null || at === undefined) continue;
    const root = control.getRootNode();
    let hit = (typeof root.elementFromPoint === "function" ? root : control.ownerDocument).elementFromPoint(at.x, at.y);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(at.x, at.y);
      if (inner === null || inner === hit) break;
      hit = inner;
    }
    if (hit === null || holds(control, hit) || holds(hit, control)) continue;
    let cover = hit;
    for (let up = parentOf(cover); up instanceof Element && !page.includes(up) && !holds(up, control); up = parentOf(cover))
      cover = up;
    if (holds(cover, element) && !own.some((other) => holds(cover, other))) return cover;
  }
  return null;
}`;

/**
 * Page code for a `dismiss` call: finds the selector's one visible match across the primary tab's
 * frames (`locate`); none, or several, is `not_shown` or `ambiguous`, and nothing is clicked. A
 * match is refused (`part`) when it is one of the step's controls in its frame, holds one or sits in
 * one (`sign_in_control`), sits in the form of one (`sign_in_form`), or is, sits in or holds a
 * control that submits a form (`submits_form`) or a link to another page than this one
 * (`opens_page`), open shadow roots included: a notice's own close, reject or accept control is
 * none of these. Otherwise it is clicked, and the call waits a moment
 * for it to go, as a notice that fades does. Attributes only, never a value.
 *
 * One that sits in the sign-in's form, or would submit a form, is still clicked when it sits in a
 * notice that covers one of the step's controls (`noticeCoverCode`) and every control a click of it
 * may reach that submits a form sits in that notice too: some pages wrap the whole page in one form, notice
 * included, and give the notice a button with no type. First the step's fields are emptied
 * (`emptied`), so nothing typed sits in the form while the page's own code runs, and the host
 * types them again; a field it cannot empty keeps the notice unclicked (`failed`). For that click
 * alone, capture listeners on its window cancel the default action of every click that reaches the
 * notice and every submit event, so the page's own handler runs and neither the click nor the
 * handler's own requestSubmit submits a form; the host removes them once the tasks the click
 * queued ran. What the page's own code sends regardless, by a form's submit(), fetch or XHR, or
 * once the listeners are off, holds nothing typed, as the fields are empty until the host types
 * them again. When the page's own code starts a navigation in the meantime, such as a reload or
 * that submit(), the call waits for the new document, and the next call finds the step's controls
 * again before anything is typed.
 */
const dismissCode = (selector: string) => `const notice = await locate(${JSON.stringify(selector)});
if ("error" in notice)
  return { dismiss: notice.error === "not_found" ? "not_shown" : "ambiguous", url: primary.url() };
const noticeFrame = notice.handle ? await notice.handle.ownerFrame() : null;
const own = [];
for (const control of submit === null ? fields : [...fields, submit]) {
  const handle = await control.locator.elementHandle({ timeout: ${elementReadMs} }).catch(() => null);
  if (handle !== null && noticeFrame !== null && (await handle.ownerFrame()) === noticeFrame) own.push(handle);
}
const verdict = await notice.locator.evaluate((element, own) => {
  // Open shadow roots count as part of their host: a host holds what its root holds.
  const parentOf = (node) => (node.parentNode instanceof ShadowRoot ? node.parentNode.host : node.parentNode);
  const holds = (outer, inner) => {
    for (let node = inner; node !== null; node = parentOf(node)) if (node === outer) return true;
    return false;
  };
  const ancestry = (node) => {
    const chain = [];
    for (let at = node; at instanceof Element; at = parentOf(at)) chain.push(at);
    return chain;
  };
  const within = (root) => {
    const found = [];
    const walk = (scope) => {
      for (const child of scope.children) {
        found.push(child);
        if (child.shadowRoot !== null) walk(child.shadowRoot);
        walk(child);
      }
    };
    if (root.shadowRoot !== null) walk(root.shadowRoot);
    walk(root);
    return found;
  };
  const formOf = (control) =>
    "form" in control && control.form instanceof HTMLFormElement
      ? control.form
      : (ancestry(control).find((node) => node instanceof HTMLFormElement) ?? null);
  if (own.some((control) => holds(control, element) || holds(element, control)))
    return { part: "sign_in_control", cancel: null };
  // The covering notice that holds it, read only for a control in the sign-in's form or one that
  // submits a form, which may then be clicked with its submission cancelled.
  let cover;
  const covering = () => (cover === undefined ? (cover = (${noticeCoverCode})(element, own, true)) : cover);
  const form = formOf(element);
  const inSignInForm = form !== null && own.some((control) => formOf(control) === form);
  if (inSignInForm && covering() === null) return { part: "sign_in_form", cancel: null };
  // What a click of it may reach: the element, what holds it and what it holds, since a click at
  // its centre lands on whatever it holds there, and the control a label among them clicks.
  const held = [...ancestry(element), ...within(element)];
  const reached = [
    ...held,
    ...held.flatMap((node) => (node instanceof HTMLLabelElement && node.control !== null ? [node.control] : [])),
  ];
  if (own.some((control) => reached.includes(control))) return { part: "sign_in_control", cancel: null };
  const submits = (node) =>
    ((node instanceof HTMLButtonElement && node.type === "submit") ||
      (node instanceof HTMLInputElement && ["submit", "image"].includes(node.type))) &&
    formOf(node) !== null;
  const submitting = reached.filter(submits);
  if (submitting.length > 0 && (covering() === null || !submitting.every((node) => holds(cover, node))))
    return { part: "submits_form", cancel: null };
  const here = new URL(element.ownerDocument.URL);
  here.hash = "";
  const opens = (node) => {
    if (!node.matches("a[href], area[href]")) return false;
    const to = new URL(node.href, element.ownerDocument.baseURI);
    to.hash = "";
    return to.protocol !== "javascript:" && to.href !== here.href;
  };
  if (reached.some(opens)) return { part: "opens_page", cancel: null };
  return {
    part: null,
    cancel: inSignInForm ? "sign_in_form" : submitting.length > 0 ? "submits_form" : null,
  };
}, own, { timeout: ${elementReadMs} });
if (verdict.part !== null) return { dismiss: "refused", part: verdict.part, url: primary.url() };
// A click whose submission is cancelled: the listeners go on the notice's window just before the
// click and come off right after it, and note whether the page's own code started a navigation.
let disarm = null;
if (verdict.cancel !== null) {
  const arming = notice.handle === null
    ? null
    : await notice.handle
        .evaluateHandle((element, own) => {
          // Read as the check read it, which scrolled each control into view already.
          const cover = (${noticeCoverCode})(element, own, false);
          if (cover === null) return null;
          const scope = element.ownerDocument.defaultView;
          let navigated = false;
          const cancel = (event) => {
            if (event.composedPath().includes(cover)) event.preventDefault();
          };
          // A form the page's own handler submits with requestSubmit sends nothing either. One it
          // submits with submit() fires no submit event and goes out, with the fields emptied.
          const cancelSubmit = (event) => event.preventDefault();
          const note = (event) => {
            if (!event.destination.sameDocument) navigated = true;
          };
          scope.addEventListener("click", cancel, true);
          scope.addEventListener("submit", cancelSubmit, true);
          scope.navigation?.addEventListener("navigate", note);
          let armed = true;
          const off = () => {
            if (armed) {
              scope.removeEventListener("click", cancel, true);
              scope.removeEventListener("submit", cancelSubmit, true);
              scope.navigation?.removeEventListener("navigate", note);
              armed = false;
            }
            return navigated;
          };
          // Never left on, whatever becomes of the host's own call to take it off.
          setTimeout(off, 10000);
          return off;
        }, own)
        .catch(() => null);
  const armed = arming === null ? false : await arming.evaluate((off) => typeof off === "function").catch(() => false);
  if (!armed) {
    await arming?.dispose().catch(() => undefined);
    return { dismiss: "refused", part: verdict.cancel, url: primary.url() };
  }
  disarm = arming;
}
// When the notice's document began loading, which tells it from the document a navigation loads.
const documentOf = (frame) => frame.evaluate(() => performance.timeOrigin).catch(() => undefined);
const noticeDocument = disarm === null ? undefined : await documentOf(noticeFrame);
let navigated = false;
let emptied = false;
try {
  // Before such a click the step's fields are emptied, so nothing typed is in the form while the
  // page's own code runs, and the host types them again. One it cannot empty, or read, keeps the
  // notice unclicked.
  if (disarm !== null)
    for (const { locator } of fields) {
      const holding = () =>
        locator
          .evaluate((element) => typeof element.value === "string" && element.value.length > 0, undefined, { timeout: ${elementReadMs} })
          .catch(() => null);
      const holds = await holding();
      if (holds === false) continue;
      if (holds === true) await locator.fill("", { timeout: 5000 }).catch(() => undefined);
      if ((await holding()) !== false) return { dismiss: "failed", ...(emptied ? { emptied } : {}), url: primary.url() };
      emptied = true;
    }
  await notice.locator.click({ timeout: 5000 });
} catch {
  return { dismiss: "failed", ...(emptied ? { emptied } : {}), url: primary.url() };
} finally {
  // A document that left took the listener with it, and its navigation started.
  // Off once the tasks the click queued ran, such as a navigation the page's own code planned.
  if (disarm !== null) {
    navigated = await disarm
      .evaluate((off) => new Promise((resolve) => setTimeout(() => resolve(off()), 0)))
      .catch(() => true);
    await disarm.dispose().catch(() => undefined);
  }
}
if (navigated && noticeFrame !== null) {
  // The new document, once it replaced the notice's: a same-document navigation is none.
  for (const until = Date.now() + 5000; Date.now() < until; ) {
    const now = await documentOf(noticeFrame);
    if (now !== undefined && now !== noticeDocument) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await noticeFrame.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => undefined);
}
await notice.locator.waitFor({ state: "hidden", timeout: 2000 }).catch(() => undefined);
return { dismiss: "clicked", ...(emptied ? { emptied } : {}), url: primary.url() };`;

const fillCallBody = (call: AutofillFillCall) => {
  if (call.kind === "dismiss") return dismissCode(call.selector);
  if (call.kind === "focus")
    return `const field = fields[${call.index}].locator;
const fieldLocated = located.fields[${call.index}];
const question = fields[${call.index}].question;
try {
  // Emptied only when it holds something: Playwright clears with a Delete key a page sees.
  if (await field.evaluate((element) => typeof element.value === "string" && element.value.length > 0, undefined, { timeout: ${elementReadMs} }))
    await field.fill("", { timeout: 5000 });
  await field.focus({ timeout: 5000 });
  // Keep this original-node binding in Patchright's isolated world, inaccessible to page code.
  // The tag of the element that holds the focus instead, if another does: the deepest one, read
  // through open shadow roots; a closed root shows only its host.
  const activeTag = await field.evaluate((element, [key, questionRequired]) => {
    const holdsFocus = ${holdsFocusCode};
    if (!holdsFocus(element)) {
      let active = element.ownerDocument.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      return active === null ? "none" : active.tagName.toLowerCase();
    }
    const binding = { document: element.ownerDocument, frame: element.ownerDocument.defaultView, questionRequired };
    Object.defineProperty(element, key, { value: binding, configurable: true });
    // Transfer the guard through this frame's isolated world; no value is involved.
    if (questionRequired) Object.defineProperty(element.ownerDocument.defaultView, key, { value: binding, configurable: true });
    element.setAttribute(key, "");
    return null;
  }, [${JSON.stringify(call.bindingKey)}, question !== undefined], { timeout: ${elementReadMs} }, true);
  if (activeTag === null && question !== undefined) {
    await question.locator.evaluate((element, { key, text }) => {
      const scope = element.ownerDocument.defaultView;
      const binding = scope[key];
      delete scope[key];
      if (!binding) throw new Error("Question binding unavailable");
      const readQuestionText = ${questionTextCode};
      binding.checkQuestion = () => readQuestionText(element) === text;
    }, { key: ${JSON.stringify(call.bindingKey)}, text: question.text }, { timeout: ${elementReadMs} }, true);
  }
  return activeTag === null
    ? { focused: true, located: fieldLocated, url: primary.url(), document: await documentStart() }
    : { focused: false, unfocused: { activeTag }, located: fieldLocated, url: primary.url() };
} catch (error) {
  const focusError = error instanceof Error && /^[A-Za-z]{1,64}$/.test(error.name) ? error.name : "unknown";
  return { focused: false, unfocused: { focusError }, located: fieldLocated, url: primary.url() };
} finally {
  if (question !== undefined) await field.evaluate((element, key) => {
    delete element.ownerDocument.defaultView[key];
  }, ${JSON.stringify(call.bindingKey)}, { timeout: 1000 }, true).catch(() => undefined);
}`;
  if (call.kind === "date")
    return `try {
  // A date goes into whatever date control the page has, in the format the field takes.
  await fillDate(fields[${call.index}].locator, ${JSON.stringify(call.iso)}, ${JSON.stringify(call.format)}, { timeout: 5000 });
  return { dated: true, url: primary.url(), document: await documentStart() };
} catch {
  return { dated: false, url: primary.url() };
}`;
  return `${call.look === true ? "return { submit: \"none\", url: primary.url() };\n" : ""}if (submit === null) return { submit: "none", url: primary.url() };
// Disabled as Playwright's own click judges it, read where page code cannot redefine the answer.
if (await submit.locator.isDisabled({ timeout: 5000 })) return { submit: "disabled", url: primary.url() };
const guardKey = ${JSON.stringify(call.guardKey)};
const guardCall = ${JSON.stringify(call.guardCall)};
const secretMatch = ${JSON.stringify(call.secretMatch)};
const fieldGet = ${JSON.stringify(call.fieldGet)};
// None once the page lost them: then a secret any action holds is refused, as if none held it before.
const exempt = ${JSON.stringify(call.exempt)};
const inspected =
  exempt ?? (await kept(${JSON.stringify(call.inspection ?? null)}))?.destinations ?? [];
const submitHandle = await submit.locator.elementHandle({ timeout: 5000 });
const submitFrame = await submitHandle.ownerFrame();
const guarded = [];
for (const [index, field] of fields.entries()) {
  const handle = await field.locator.elementHandle({ timeout: 5000 });
  // Only the form the host's click submits, judged GET, submits by GET: the
  // methods as judged, not as read now, which page code could have changed since the recheck.
  const guarding = await handle.evaluate(${submissionGuardCode}, {
    key: guardKey,
    call: guardCall,
    actions: inspected,
    match: secretMatch[index] ?? null,
    submit: (await handle.ownerFrame()) === submitFrame ? submitHandle : null,
    submitInForm: ${JSON.stringify(call.submitInForm)},
    submitGet: ${JSON.stringify(call.submitGet)},
    fieldGet: fieldGet[index] === true,
    scriptSubmit: ${JSON.stringify(call.scriptSubmit === true)},
  });
  if (guarding) guarded.push(handle);
}
// Read through the same handles, so in the guard's own world; a document that left has none.
const refusedSubmission = async () => {
  for (const handle of guarded) {
    const refused = await handle
      .evaluate((field, { key, call }) => {
        const guard = field.ownerDocument.defaultView[key];
        return guard?.call === call ? guard.refused : null;
      }, { key: guardKey, call: guardCall })
      .catch(() => null);
    if (refused) return refused;
  }
  return null;
};
${pageControlsCode}
// The alert text the page shows before the click, so the host counts only what the submit brought:
// read only for a host that counts, and never past a short bound, so no frame holds the click back.
const alertsBefore = ${
    call.alertsBefore === true
      ? `await Promise.race([
  pageControls(true).then((found) => found.alerts, () => null),
  new Promise((resolve) => setTimeout(() => resolve(null), ${alertsBeforeMs})),
])`
      : "null"
  };
const nextNavigation = () =>
  primary
    .waitForEvent("framenavigated", { predicate: (frame) => frame === primary.mainFrame(), timeout: ${call.settleMs} })
    .then(() => true, () => false);
let navigated = nextNavigation();
// Whether a request for a navigation of the main frame went out from the click on, as a form's
// submission sends, and whether such a navigation committed since.
let requested = false;
let committed = false;
const noteRequest = (request) => {
  try {
    if (request.isNavigationRequest() && request.frame() === primary.mainFrame()) requested = true;
  } catch {}
};
const noteCommit = (frame) => {
  if (frame === primary.mainFrame()) committed = true;
};
// The origin of each navigation of the main frame from the click until the page settled, in order,
// server redirects included, and the page's address at the click: where the page went on its own
// from the host's submit, and from where.
const clickedFrom = primary.url();
const hops = [];
const noteHop = (request) => {
  try {
    if (request.isNavigationRequest() && request.frame() === primary.mainFrame())
      hops.push(new URL(request.url()).origin);
  } catch {}
};
// An answer the call returns before the page settled, once it stopped noting navigations.
const unwatched = (answer) => {
  primary.off("request", noteHop);
  return answer;
};
primary.on("request", noteRequest);
primary.on("request", noteHop);
primary.on("framenavigated", noteCommit);
let late = false;
// "keyboard" once the host pressed Enter on the submit itself, which activates it as a click does
// and which no element over it can catch.
let via = null;
// Presses the submit from the keyboard only once focus landed on that same element; false, having
// pressed nothing, when focus went anywhere else.
const pressSubmit = async () => {
  const focused = await submitHandle
    .evaluate((element) => {
      element.focus({ preventScroll: true });
      let active = element.ownerDocument.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      return active === element;
    })
    .catch(() => false);
  if (!focused) return false;
  via = "keyboard";
  navigated = nextNavigation();
  await submitHandle.press("Enter", { timeout: 5000 });
  return true;
};
try {
  // A submit key goes to the last field, which stands as the submit and submits its own form.
  if (submitKey !== null) await submit.locator.press(submitKey, { timeout: 5000 });
  else if (!(submitVia === "keyboard" && (await pressSubmit()))) await submit.locator.click({ timeout: 5000 });
} catch (error) {
  // Playwright's click waits, inside its own timeout, for the navigation it started to commit, which
  // a slow chain of redirects can outlast. One whose request for the main frame went out reached
  // the page, whatever the site answered: the host goes on as after any click, never to click again.
  if (requested) late = true;
  else {
    // Playwright names an element that intercepts pointer events when another sits over the
    // submit, and never dispatches the click then: blocked, by the element at the submit's centre.
    const intercepted =
      submitKey === null && via === null && error instanceof Error && error.message.includes("intercepts pointer events");
    const blockedBy = intercepted
      ? await submit.locator.evaluate(${coveringCode}, undefined, { timeout: ${elementReadMs} }).catch(() => null)
      : null;
    if (blockedBy === null) return unwatched({ submit: "failed", url: primary.url() });
    // On a click again, the covered submit is pressed from the keyboard instead; the element over
    // it is never clicked. Any other call reports it blocked, so a covering notice is dismissed first.
    try {
      if (!${JSON.stringify(call.pressCovered === true)} || !(await pressSubmit()))
        return unwatched({ submit: "blocked", blockedBy, url: primary.url() });
    } catch {
      if (!requested) return unwatched({ submit: "failed", url: primary.url() });
      late = true;
    }
  }
} finally {
  primary.off("request", noteRequest);
  primary.off("framenavigated", noteCommit);
}
// Such a click's navigation gets the settle wait from here to commit, as a click's own gets.
const lateCommit = !late
  ? false
  : committed ||
    primary
      .waitForEvent("framenavigated", { predicate: (frame) => frame === primary.mainFrame(), timeout: ${call.settleMs} })
      .then(() => true, () => false);
let submission = await refusedSubmission();
if (submission === null && ((await navigated) || (await lateCommit)))
  await primary.waitForLoadState("domcontentloaded", { timeout: ${call.settleMs} }).catch(() => undefined);
primary.off("request", noteHop);
submission ??= await refusedSubmission();
if (submission !== null) return { submission, url: primary.url() };
const settled = await documentStart();
const settledTitle = await primary.title().catch(() => undefined);
// What the page shows once the submit settled, never a value, for the minter's next step.
const controls = await pageControls().catch(() => null);
const newAlerts =
  controls === null || alertsBefore === null ? null : controls.alerts.filter((text) => !alertsBefore.includes(text)).length;
return {
  submit: "clicked",
  ...(via === null ? {} : { via }),
  url: primary.url(),
  navigated: {
    clicked: clickedFrom,
    origins: hops,
    ...(settled === undefined ? {} : { document: settled }),
    ...(typeof settledTitle === "string" ? { title: settledTitle } : {}),
  },
  ...(controls === null ? {} : { controls: newAlerts === null ? controls : { ...controls, newAlerts } }),
};`;
};

/**
 * Page code: `keySubmit` stands a step's last field in as its submit when the step submits with a
 * key: the field's own place and destinations (its form's action and method, every form action and
 * method its controls could submit with), described for Guardian as that form, by its own name,
 * id and label and its method, never a value; and how many submit controls the form shows. A
 * field in no form submits nothing (`submitMethod` null), which the host refuses.
 */
const keySubmitCode = `const keySubmit = async (field) => {
  const form = await field.locator.evaluate((element) => {
    const associated =
      "form" in element && element.form instanceof HTMLFormElement ? element.form : element.closest("form");
    if (associated === null) return null;
    const controls = Array.from(
      Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, "elements").get.call(associated),
    );
    const submitter = (control) =>
      (control instanceof HTMLButtonElement && control.type === "submit") ||
      (control instanceof HTMLInputElement && ["submit", "image"].includes(control.type));
    const shows = (control) => {
      const box = control.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && control.checkVisibility({ visibilityProperty: true, opacityProperty: true });
    };
    return {
      name: associated.getAttribute("name"),
      id: associated.getAttribute("id"),
      ariaLabel: associated.getAttribute("aria-label"),
      submitControls: controls.filter((control) => submitter(control) && shows(control)).length,
    };
  }, undefined, { timeout: ${elementReadMs} });
  return {
    ...field,
    submitControls: form?.submitControls ?? 0,
    described: {
      tag: "form",
      role: null,
      formMethod: field.target.submitMethod,
      type: null,
      name: clip(form?.name ?? null),
      id: clip(form?.id ?? null),
      autocomplete: null,
      inputmode: null,
      label: null,
      placeholder: null,
      ariaLabel: clip(form?.ariaLabel ?? null),
      text: null,
    },
  };
};`;

/**
 * Page code for a fill call: when the primary page's document began loading, which tells one
 * document from the next. A new document changes it; a pushState, a redraw or a reload of a frame
 * never does. Undefined when the page cannot say, as while it loads.
 */
const documentStartCode = `const documentStart = () =>
  primary.mainFrame().evaluate(() => performance.timeOrigin).catch(() => undefined);`;

/** Resolves only a real child of the stable primary opener, on the recorded origin. */
export const autofillPageCode = (targetId: string, popup: AutofillPopup | undefined) =>
  popup === undefined
    ? primaryPageCode(targetId)
    : `${pageCode(targetId, "opener")}
const popupOrigin = ${JSON.stringify(popup.origin)};
const matches = [];
for (const candidate of context.pages()) {
  if (candidate === opener || candidate.isClosed()) continue;
  if (await candidate.opener() !== opener) continue;
  let origin;
  try { origin = new URL(candidate.url()).origin; } catch { continue; }
  if (origin === popupOrigin) matches.push(candidate);
}
if (matches.length !== 1) return {
  error: matches.length === 0 ? "popup_missing" : "popup_ambiguous", target: "popup"
};
const primary = matches[0];
`;

/**
 * The question selector a step call reads for a field: a private answer's question, which every
 * call reads and the fill checks has not changed before it types the answer, and, at inspection
 * only, a code's instruction, which the host puts in the code question and never checks again,
 * since a screen may count down its time in it.
 */
const questionRead = (
  field: { readonly slot?: string | undefined; readonly questionSelector?: string | undefined },
  inspection: boolean,
) =>
  field.slot === "private_answer" || (inspection && field.slot === "code")
    ? (field.questionSelector ?? null)
    : null;

/**
 * One host call for a step: its inspection, or with `fill`, one call of its fill. What it finds,
 * the page keeps under `observed`; a fill call compares against what it kept under `judged`.
 */
export const autofillStepCode = (
  targetId: string,
  step: {
    readonly fields: readonly {
      readonly selector: string;
      readonly slot?: string | undefined;
      readonly questionSelector?: string | undefined;
    }[];
    readonly submit?: string | undefined;
    readonly submitKey?: string | undefined;
    readonly submitVia?: string | undefined;
    readonly popup?: AutofillPopup | undefined;
  },
  observed: string,
  fill?: {
    readonly popupTargetId?: string | undefined;
    readonly call: AutofillFillCall;
    readonly judged: string | undefined;
    /** The fields the host typed that must still hold something before the call acts. */
    readonly check: readonly number[];
    /** The fill's id for where the page was as each field was typed. */
    readonly typedAt: string;
  },
) => `${autofillPageCode(targetId, step.popup)}
let popupTargetId;
${
  step.popup === undefined
    ? ""
    : `const authTargetSession = await context.newCDPSession(primary);
try { popupTargetId = (await authTargetSession.send("Target.getTargetInfo")).targetInfo.targetId; }
finally { await authTargetSession.detach(); }
${fill === undefined ? "" : `if (popupTargetId !== ${JSON.stringify(fill.popupTargetId)}) return {error:"target_changed", target:"popup"};`}`
}
${formControlsCode}
${locateCode}
${documentStartCode}
const observed = ${JSON.stringify(observed)};
const selectors = ${JSON.stringify(step.fields.map((field) => field.selector))};
const questionSelectors = ${JSON.stringify(step.fields.map((field) => questionRead(field, fill === undefined)))};
const codeSlots = ${JSON.stringify(step.fields.map((field) => field.slot === "code"))};
const submitSelector = ${JSON.stringify(step.submit ?? null)};
const submitKey = ${JSON.stringify(step.submitKey ?? null)};
const submitVia = ${JSON.stringify(step.submitVia ?? null)};
// Every control is found first, then read in one pass (readControls). A control that is not found
// ends the call at once, after the no-wait read of the ones found before it (checkReads).
const foundFields = [];
for (let index = 0; index < selectors.length; index++) {
  const foundField = await locate(selectors[index], questionSelectors[index]);
  if ("error" in foundField) {
    await checkReads(foundFields);
    return { ...foundField, target: index, url: primary.url()${fill?.call.kind === "submit" ? ", document: await documentStart()" : ""} };
  }
  foundFields.push(foundField);
}
const foundSubmit =
  (submitKey !== null && foundFields.length > 0) || submitSelector === null ? null : await locate(submitSelector);
if (foundSubmit !== null && "error" in foundSubmit) {
  await checkReads(foundFields);
  return { ...foundSubmit, target: "submit", url: primary.url() };
}
const readFound = await readControls(foundSubmit === null ? foundFields : [...foundFields, foundSubmit]);
const fields = readFound.slice(0, foundFields.length);
${keySubmitCode}
const submit =
  submitKey !== null && fields.length > 0
    ? await keySubmit(fields[fields.length - 1])
    : foundSubmit === null
      ? null
      : readFound[foundFields.length];
// An inert submit takes no interaction at all, so nothing is typed for it. A disabled one may be
// enabled once the fields hold input; the submit call never clicks it while it is disabled.
if (submit !== null && submit.inert)
  return { error: "not_editable", target: "submit", located: submit.located, url: primary.url() };
const located = { fields: fields.map((field) => field.located), submit: submit === null ? null : submit.located };
${fill === undefined ? inspectCode : fillCallCode(fill.call, fill.judged, fill.check, fill.typedAt)}`;

/** What named a control when the host inspected it, each as `clip` keeps it. */
export interface ControlIdentity {
  readonly label: string | null;
  readonly ariaLabel: string | null;
  readonly placeholder: string | null;
  readonly type: string | null;
  readonly autocomplete: string | null;
  readonly name: string | null;
  readonly id: string | null;
}

/** What `autofillSignedInCode` answers. */
export const SignedInPage = Schema.Struct({
  url: Schema.String,
  indicator: Schema.NullOr(Schema.Boolean),
  passwordVisible: Schema.Boolean,
  challengeFormVisible: Schema.Boolean,
});

/**
 * Page code: whether a recorded challenge field still asks. A selector counts only where it
 * matches the same control the host inspected (`sameControl`), one that shows and takes typing, in
 * a frame on the site or a configured sign-in origin whose every frame above it shows. A control
 * or frame the host cannot read in time, such as one that detaches during the check, shows nothing.
 */
const signedInChallengeFormCode = `
${clipCode}
/** How long the host waits to read one control's naming. */
const namingLimitMs = 1500;
// A call that does not answer within the limit fails, whether it waits for a control that
// detached or the page keeps it busy.
const withinLimit = (call) => {
  let timer;
  const expiry = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Timed out")), namingLimitMs);
  });
  return Promise.race([call, expiry]).finally(() => clearTimeout(timer));
};
// The same words name it as named the recorded field, with its type, autocomplete, name and id
// where inspection recorded one. An id or name generated on each render, such as ":r3:" or
// "mat-input-3", differs once the page renders the control again, so that control shows nothing.
const sameControl = async (control, identity) => {
  const named = await withinLimit(control.evaluate((element) => {
    ${controlNamingCode}
    return controlNaming(element);
  }, undefined, { timeout: namingLimitMs }));
  const found = Object.fromEntries(Object.entries(named).map(([key, value]) => [key, clip(value)]));
  return ["label", "ariaLabel", "placeholder"].every((key) => found[key] === identity[key]) &&
    ["type", "autocomplete", "name", "id"].every((key) => identity[key] === null || found[key] === identity[key]);
};
// A frame's own address, or for an about:blank or about:srcdoc frame, the first one above it with
// a real address, as locate reads where a control sits.
const frameAddress = (frame) => {
  let scope = frame;
  while (scope !== null && ["about:blank", "about:srcdoc"].includes(scope.url())) scope = scope.parentFrame();
  return scope === null ? "" : scope.url();
};
const challengeOrigin = (frame) => {
  let url;
  try {
    url = new URL(frameAddress(frame));
  } catch {
    return false;
  }
  return onSiteHost(url.hostname) || authenticationOrigins.includes(url.origin);
};
// The frame and every frame above it show, as a question's frames are read.
const frameShows = async (frame) => {
  for (let scope = frame; scope.parentFrame() !== null; scope = scope.parentFrame())
    if (!(await (await scope.frameElement()).isVisible())) return false;
  return true;
};
// A read-only or disabled control takes no typing, and one that is no form control throws.
const takesTyping = (control) => control.isEditable({ timeout: 1000 }).catch(() => false);
// A control the host cannot read shows nothing: a check that cannot tell does not fail.
const stillAsks = async (control, identity) => {
  try {
    return (await control.isVisible()) && (await takesTyping(control)) && (await sameControl(control, identity));
  } catch {
    return false;
  }
};
const recordedChallengeVisible = async (fields) => {
  if (fields.length === 0) return false;
  for (const frame of primary.frames()) {
    try {
      if (!challengeOrigin(frame) || !(await frameShows(frame))) continue;
      for (const { selector, identity } of fields) {
        const located = frame.locator(selector);
        const count = Math.min(await located.count(), 100);
        for (let index = 0; index < count; index++)
          if (await stillAsks(located.nth(index), identity)) return true;
      }
    } catch {
      // A frame the host cannot read, such as one that detaches during the check, shows nothing.
      continue;
    }
  }
  return false;
};`;

/**
 * One host call: the page URL, whether the indicator is visible in a frame on the site (its host
 * `siteHost` or a subdomain of it on the same site, as `hostOnSiteSource` reads it), and whether a
 * password field of the sign-in's own shows in any frame: one of its fields (`signInFields`, by
 * selector), or one in the form of a visible one. Another form's password field, such as a
 * change-password form or an inner service's login,
 * does not count unless one of those selectors matches in it. A hidden match, such as the username
 * a change-password form keeps for password managers, is no sign-in form showing. With no
 * `signInFields`, any visible password field counts. A recorded challenge field
 * (`challengeFields`, each with the identity the host inspected) still asks as
 * `signedInChallengeFormCode` reads it, on the site or one of `authenticationOrigins`. Both come
 * after `popups` and default to none, so a caller that passes no challenge fields gets no
 * challenge check.
 */
export const autofillSignedInCode = (
  targetId: string,
  selector: string | undefined,
  siteHost: string,
  signInFields: readonly string[],
  popups: readonly AutofillPopup[] = [],
  challengeFields: readonly {
    readonly selector: string;
    readonly identity: ControlIdentity;
  }[] = [],
  authenticationOrigins: readonly string[] = [],
) =>
  `${primaryPageCode(targetId)}
const popupOrigins = ${JSON.stringify(popups.map((popup) => popup.origin))};
for (const candidate of context.pages()) {
  if (candidate === primary || candidate.isClosed() || await candidate.opener() !== primary) continue;
  let origin;
  try { origin = new URL(candidate.url()).origin; } catch { continue; }
  if (popupOrigins.includes(origin)) return { url: primary.url(), indicator: false, passwordVisible: false, challengeFormVisible: false };
}
const onSiteHost = ${hostOnSiteSource(siteHost)};
const onSite = (frame) => {
  let host = "";
  try {
    host = new URL(frame.url()).hostname;
  } catch {
    return false;
  }
  return onSiteHost(host);
};
const authenticationOrigins = ${JSON.stringify(authenticationOrigins)};
const visibleIn = async (selector, scopes) => {
  for (const scope of scopes) {
    const located = scope.locator(selector);
    const count = Math.min(await located.count(), 100);
    for (let index = 0; index < count; index++)
      if (await located.nth(index).isVisible()) return true;
  }
  return false;
};
${signedInChallengeFormCode}
const password = 'input[type="password"]';
// The field itself, or a control of its form as locate reads the form (its form attribute too),
// that is a password field and shows: a box with an area, and not hidden.
const passwordInForm = (element, matched) => {
  const form =
    "form" in element && element.form instanceof HTMLFormElement ? element.form : element.closest("form");
  const controls = form
    ? Array.from(Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, "elements").get.call(form))
    : [element];
  return controls.some((control) => {
    const box = control.getBoundingClientRect();
    return (
      control.matches(matched) &&
      box.width > 0 &&
      box.height > 0 &&
      control.checkVisibility({ visibilityProperty: true })
    );
  });
};
const signInPasswordVisible = async (selectors) => {
  for (const frame of primary.frames())
    for (const fieldSelector of selectors) {
      const located = frame.locator(fieldSelector);
      const count = Math.min(await located.count(), 100);
      for (let index = 0; index < count; index++) {
        const field = located.nth(index);
        if (!(await field.isVisible())) continue;
        if (await field.evaluate(passwordInForm, password)) return true;
      }
    }
  return false;
};
const selector = ${JSON.stringify(selector ?? null)};
const signInFields = ${JSON.stringify(signInFields)};
const challengeFields = ${JSON.stringify(challengeFields)};
const siteFrames = primary.frames().filter(onSite);
return {
  url: primary.url(),
  indicator: selector === null ? null : await visibleIn(selector, siteFrames),
  challengeFormVisible: await recordedChallengeVisible(challengeFields),
  // With no field of the sign-in's own to go by, any password field on the page still counts.
  passwordVisible:
    signInFields.length === 0
      ? popupOrigins.length === 0 && await visibleIn(password, primary.frames())
      : await signInPasswordVisible(signInFields),
};`;
