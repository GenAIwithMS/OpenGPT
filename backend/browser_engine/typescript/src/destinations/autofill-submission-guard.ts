import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import type { AutofillFillCall } from "./autofill-page-code.js";
import { foundEvidence, namedOrigin, refused, withCheck } from "./autofill-refusal.js";
import { noOpScriptCode } from "./autofill-locate-code.js";
import type { FillSlot, Targets } from "./autofill-step.js";
import { isCardSlot } from "./payment-frames.js";

/**
 * Page code: arms the guard on a filled field's own window for one submit call (`call`), and says
 * whether it guards that field. The page's own code runs while the host clicks, after the last
 * recheck, so the guard judges the submission as it fires.
 * - A field in the form the host's click submits, when that submission was judged GET
 *   (`submitGet`), is not guarded: it submits as judged. When the submit was
 *   judged in no form (`submitInForm` false), in whatever frame, the field's own form's judgment
 *   decides (`fieldGet`). A field in another form or another frame (`submit` null) than a submit in
 *   a form is guarded whatever the submit's method.
 * - It refuses a submission by GET from a form that holds a guarded field, or whose controls or
 *   entries carry a filled secret, and one to an action URL that carries a filled secret no action
 *   carried at inspection (`actions`, as the page kept them, never through the host; once the page
 *   was typed into before that inspection, only the site's and configured sign-in origins
 *   themselves, since page code may have put a typed value in any path or query). A password or recovery code is found inside any text
 *   (`match: "within"`); a code only where no digit adjoins it, nor a letter when the code has one
 *   (`"token"`), since a short one turns up inside a timestamp by chance. A step's code fields that
 *   each hold one character are one code, their values joined in field order, so a code split into
 *   one-character boxes is found whole and never one character at a time; a longer code field is a
 *   code of its own. Both ignore case, since a URL's host is lowercased as it is parsed.
 * - On a sign-in step's submit (`scriptSubmit`), a submission by GET whose action is a script that
 *   does nothing (`noOpScriptCode`) is not refused for its method: navigating to such an action
 *   puts no entry in an address and runs nothing. Any other script action is refused by GET as
 *   before, its action may still not carry a filled secret, and a card-fill step's submit has no
 *   such exception.
 * - A refused submit event is canceled. `form.submit()` fires no submit event, but its entry
 *   list's `formdata` event comes once the browser fixed the method and action; it cannot be
 *   canceled, so the guard stops the event, empties the entry list and takes the form out of the
 *   document until a later task, since a form not connected once its entry list is built cannot
 *   navigate.
 * One guard serves each window, under the host's random per-process `key` rather than a fixed
 * name. Its listeners stay for the document's life, and a new call disarms what an earlier one
 * armed there, so an earlier screen's judgment never refuses a later one's. DOM listeners work
 * from Patchright's isolated world as from the page's own, where a patched
 * `HTMLFormElement.prototype.submit` would not. The guard records only the refusal's method and
 * action origin, as found; the host names that origin only when no typed value can be in it.
 */
export const submissionGuardCode = `(field, { key, call, actions, match, submit, submitInForm, submitGet, fieldGet, scriptSubmit }) => {
  const view = field.ownerDocument.defaultView;
  let guard = view[key];
  if (guard === undefined) {
    guard = { call: null, refused: null, fields: [], secrets: [], actions: [], scriptSubmit: false };
    Object.defineProperty(view, key, { value: guard });
    const submitters = new WeakMap();
    // The form's own getters: a control named "method", "action" or "elements" shadows the form's.
    const [formMethod, formAction, formElements] = ["method", "action", "elements"].map(
      (name) => Object.getOwnPropertyDescriptor(view.HTMLFormElement.prototype, name).get,
    );
    const decode = (text) => {
      try {
        return decodeURIComponent(text);
      } catch {
        return text;
      }
    };
    // Each secret as typed, or as the page left it in its fields, a code's boxes joined in order.
    const secrets = () =>
      guard.secrets.flatMap(({ parts, token }) =>
        [parts.map(({ typed }) => typed), parts.map(({ element }) => element.value)]
          .map((values) => values.map((value) => (typeof value === "string" ? value : "")).join(""))
          .filter((value) => value !== "")
          .map((value) => ({ value: value.toLowerCase(), token })),
      );
    const carriedIn = (text, { value, token }) => {
      if (typeof text !== "string") return false;
      const read = text.toLowerCase();
      if (!token) return read.includes(value);
      const adjoins = /^[0-9]+$/.test(value) ? /[0-9]/ : /[\\p{L}\\p{N}]/u;
      for (let at = read.indexOf(value); at !== -1; at = read.indexOf(value, at + 1))
        if (!adjoins.test(read.charAt(at - 1)) && !adjoins.test(read.charAt(at + value.length)))
          return true;
      return false;
    };
    const carries = (text) => secrets().some((secret) => carriedIn(text, secret));
    // Where a URL may hold a value: all of it, decoded, and each part decoded on its own.
    const readings = (url) => {
      try {
        const parsed = new URL(url);
        return [
          url,
          decode(url),
          decode(parsed.username),
          decode(parsed.password),
          parsed.hostname,
          ...parsed.pathname.split("/").map(decode),
          ...parsed.searchParams.keys(),
          ...parsed.searchParams.values(),
          decode(parsed.hash.slice(1)),
        ];
      } catch {
        return [url, decode(url)];
      }
    };
    // A secret an action already held before typing, such as part of the site's address, is no leak.
    const inUrl = (url) => {
      const inspected = guard.actions.flatMap(readings);
      return secrets().some(
        (secret) =>
          readings(url).some((read) => carriedIn(read, secret)) &&
          !inspected.some((read) => carriedIn(read, secret)),
      );
    };
    const holds = (form) =>
      Array.from(formElements.call(form)).some(
        (control) => guard.fields.includes(control) || carries(control.value),
      );
    // A submitter's own formmethod and formaction override its form's, as the browser reads them.
    const submission = (form, submitter) => ({
      method: submitter?.hasAttribute("formmethod") ? submitter.formMethod : formMethod.call(form),
      action: submitter?.hasAttribute("formaction") ? submitter.formAction : formAction.call(form),
    });
    // A sign-in's submission to a script that does nothing navigates to the script alone, with no
    // entry in it.
    const noOpScript = ${noOpScriptCode};
    const refused = ({ method, action }, held) =>
      method === "get" && held && !(guard.scriptSubmit && noOpScript(action))
        ? "method"
        : method !== "dialog" && inUrl(action)
          ? "action"
          : null;
    const originOf = (url) => {
      try {
        return new URL(url).origin;
      } catch {
        return "invalid";
      }
    };
    const record = (changed, { method, action }) => {
      guard.refused = { changed, method, actionOrigin: originOf(action) };
    };
    view.addEventListener("submit", (event) => {
      const form = event.target;
      if (!event.isTrusted || !(form instanceof view.HTMLFormElement)) return;
      submitters.set(form, event.submitter);
      const fired = submission(form, event.submitter);
      const changed = refused(fired, holds(form));
      if (changed === null) return;
      event.preventDefault();
      record(changed, fired);
    }, true);
    view.addEventListener("formdata", (event) => {
      const form = event.target;
      if (!event.isTrusted || !(form instanceof view.HTMLFormElement)) return;
      const held = holds(form) || [...event.formData.values()].some(carries);
      // form.submit() has no submitter, so the form's own method and action count too.
      let changed = null;
      let fired;
      for (const submitter of [null, submitters.get(form) ?? null]) {
        fired = submission(form, submitter);
        changed = refused(fired, held);
        if (changed !== null) break;
      }
      if (changed === null) return;
      // No later listener may put the form back or its entries in again.
      event.stopImmediatePropagation();
      for (const name of new Set(event.formData.keys())) event.formData.delete(name);
      const { parentNode, nextSibling } = form;
      form.remove();
      view.setTimeout(() => {
        if (!form.isConnected && parentNode?.isConnected)
          parentNode.insertBefore(form, nextSibling?.parentNode === parentNode ? nextSibling : null);
      });
      record(changed, fired);
    }, true);
  }
  if (guard.call !== call)
    Object.assign(guard, {
      call,
      refused: null,
      fields: [],
      secrets: [],
      actions,
      scriptSubmit: scriptSubmit === true,
    });
  // The form a control belongs to, as inspection read it.
  const formOf = (element) =>
    "form" in element && element.form instanceof view.HTMLFormElement ? element.form : element.closest("form");
  const submitted = submit === null ? null : formOf(submit);
  const judgedGet = submitInForm ? submitGet && submitted !== null && formOf(field) === submitted : fieldGet;
  if (judgedGet) return false;
  guard.fields.push(field);
  if (match === null) return true;
  // A step's one-character code fields are one code, which the host arms in field order. A longer
  // code field holds a code of its own.
  const part = { element: field, typed: field.value };
  const box = match === "token" && typeof part.typed === "string" && [...part.typed].length === 1;
  const code = box ? guard.secrets.find((secret) => secret.box) : undefined;
  if (code === undefined) guard.secrets.push({ parts: [part], token: match === "token", box });
  else code.parts.push(part);
  return true;
}`;

/**
 * The submission guard's window key for this host process, the same for every call so each call
 * re-arms the window's one guard. Random, so it is no fixed name a page could define first; a
 * main-world page can still find it once armed, it lasts across jobs on one Pod, and such a page
 * could patch the event prototypes anyway.
 */
const guardKey = `__opengpt_submission_${randomUUID()}`;

/**
 * The secrets the submission guard also finds by value, beyond the fields themselves: a password
 * or recovery code inside any text, a code only where no digit adjoins it, since a short one turns
 * up inside a timestamp by chance. The guard joins a step's `"token"` fields that each hold one
 * character, its code's boxes, into one code. A date part or a ZIP is never matched by value, since
 * a dropdown's or a hidden field's own value may hold one.
 */
const secretMatch: Partial<Record<FillSlot, "within" | "token">> = {
  password: "within",
  recovery_code: "within",
  private_answer: "within",
  code: "token",
};

/**
 * A step's submit call, whose guard judges the submission by the methods as judged (`judged`) and
 * the destinations the page kept under `inspection`, or with `exempt` only those origins, whose
 * scheme and host no page chose. A sign-in step's, with no part of a payment card, lets a
 * submission to a script that does nothing fire by GET (`scriptSubmit`).
 */
export const guardedSubmit = (
  step: { readonly fields: readonly { readonly slot: FillSlot }[] },
  judged: typeof Targets.Type,
  call: {
    readonly settleMs: number;
    readonly inspection: string | undefined;
    readonly exempt: readonly string[] | null;
    /** The step's code boxes the call checks each hold one character (`AutofillFillCall`). */
    readonly codeBoxes?: readonly number[];
    readonly alertsBefore: boolean;
    /** Whether a click another element catches is pressed from the keyboard (`AutofillFillCall`). */
    readonly pressCovered?: boolean;
  },
): AutofillFillCall => ({
  kind: "submit",
  ...(call.codeBoxes === undefined || call.codeBoxes.length === 0 ? {} : { codeBoxes: call.codeBoxes }),
  settleMs: call.settleMs,
  ...(call.alertsBefore ? { alertsBefore: true as const } : {}),
  ...(call.pressCovered === true ? { pressCovered: true as const } : {}),
  guardKey,
  guardCall: randomUUID(),
  inspection: call.inspection,
  exempt: call.exempt,
  secretMatch: step.fields.map((field) => secretMatch[field.slot] ?? null),
  ...(step.fields.some((field) => isCardSlot(field.slot)) ? {} : { scriptSubmit: true as const }),
  submitInForm: (judged.submit?.submitMethod ?? null) !== null,
  submitGet: judged.submit?.submitMethod === "get",
  fieldGet: judged.fields.map((target) => target.submitMethod === "get"),
});

/**
 * A submission the submit call's guard refused as it fired: what turned, its method and its
 * action's origin as found.
 */
export const GuardRefusal = Schema.Struct({
  submission: Schema.Struct({
    changed: Schema.Literal("method", "action"),
    method: Schema.Literal("get", "post", "dialog"),
    actionOrigin: Schema.String,
  }),
  url: Schema.String,
});

/**
 * A submission the page turned, after the last recheck, into one that would put a filled value in a
 * URL, which the submit call's guard refused as it fired: the pre-click switch's own refusal, so
 * the minter and the step event treat both alike. The guard records the action's origin as it
 * found it, and the host names it only when `named` holds it, the page's too.
 */
export const firedRefusal = (
  { submission, url }: typeof GuardRefusal.Type,
  named: ReadonlySet<string>,
) =>
  withCheck(refused("credential_target_refused", "submit"), "change", {
    changed: `submission.${submission.changed}`,
    submissionMethod: submission.method,
    submissionActionOrigin: submission.actionOrigin.includes("//")
      ? namedOrigin(submission.actionOrigin, named)
      : "other",
    ...foundEvidence(url, undefined, named),
  });
