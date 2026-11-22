import { Schema } from "effect";
import { accessibleNames } from "./accessible-name.js";

/**
 * A control on the page as the minter reads it after a submit: its role, accessible name, input
 * type and state. Never its value, typed text or placeholder, which a site may fill with what was
 * typed.
 */
export const PageControl = Schema.Struct({
  role: Schema.String,
  name: Schema.NullOr(Schema.String),
  type: Schema.NullOr(Schema.String),
  required: Schema.Boolean,
  visible: Schema.Boolean,
  enabled: Schema.Boolean,
});
export type PageControl = typeof PageControl.Type;

/**
 * The page's controls, visible ones first and at most `pageControlsLimit`, of `total` found, and
 * the visible error and alert text it shows (`alerts`, at most `pageAlertsLimit`): a site's
 * refusal of a submit may be gone by the time anyone looks again. A reader that predates `alerts`
 * drops it. Host-only, never shown to the minter: `newAlerts`, how many of `alerts` the page did
 * not show right before a submit's click, absent when the page was not read then.
 */
export const PageControls = Schema.Struct({
  controls: Schema.Array(PageControl),
  total: Schema.Number,
  alerts: Schema.optional(Schema.Array(Schema.String)),
  newAlerts: Schema.optional(Schema.NonNegativeInt),
});
export type PageControls = typeof PageControls.Type;

/** At most this many controls are kept; `total` still counts every one. */
export const pageControlsLimit = 100;

/** At most this many alert lines are kept, the first in page order. */
export const pageAlertsLimit = 10;

/**
 * The longest role or name text page code returns for one control. Longer text is dropped whole,
 * never cut: a cut could keep the start of a typed value that screening for the whole value misses.
 */
export const pageControlTextLimit = 32_768;

/**
 * Page code, with `primary` bound: `pageControls()` reads every frame's form controls, buttons
 * and links as `PageControl`s, and its visible alert and error text (`alerts`), or null when the
 * page cannot be read; `pageControls(true)` reads only the alerts. Values never leave the page: an
 * alert is an element's rendered text, which holds no field's value, and an element that holds a
 * field is never one. An alert is text a person sees: never one a pixel wide or tall, as a
 * screen reader's is, transparent, hidden or wholly off the page, and never one styled as a
 * success or a notice.
 * A name is the control's accessible name as `accessibleNames` reads it, the name a `role=`
 * selector matches, so words the page hides from assistive technology, such as a required mark,
 * are not in it.
 * Names and roles come back as the page has them, never trimmed, collapsed or cut short, so the
 * host screens a typed value echoed in them whole before `presentControls` shortens them; a name
 * longer than `pageControlTextLimit` is null, and such a role is the element's implicit one. The
 * `pageControlsLimit` it keeps are the most useful: visible ones first, then enabled fields,
 * required ones first, each group in page order.
 */
export const pageControlsCode = `const pageControls = async (alertsOnly = false) => {
  const read = ({ limit, textLimit, alertLimit, alertsOnly }) => {
    // Page text as it is, or null when it has no words.
    const raw = (value) => (typeof value === "string" && value.trim() !== "" ? value : null);
    // Text past the limit is dropped whole, never cut, so no part of a typed value escapes screening.
    const capped = (value) => (value !== null && value.length > textLimit ? null : value);
    const accessibleName = (${String(accessibleNames)})();
    const buttonTypes = ["submit", "button", "reset", "image"];
    const roleOf = (element) => {
      const explicit = capped(raw(element.getAttribute("role")));
      if (explicit !== null) return explicit;
      if (element instanceof HTMLInputElement) {
        if (buttonTypes.includes(element.type)) return "button";
        if (element.type === "checkbox" || element.type === "radio") return element.type;
        if (element.type === "range") return "slider";
        if (element.type === "number") return "spinbutton";
        if (element.type === "search") return "searchbox";
        return "textbox";
      }
      if (element instanceof HTMLSelectElement) return element.multiple || element.size > 1 ? "listbox" : "combobox";
      if (element instanceof HTMLTextAreaElement) return "textbox";
      if (element instanceof HTMLAnchorElement) return "link";
      return element.tagName.toLowerCase();
    };
    // The accessible name, or null when it has no words, is longer than the limit or cannot be
    // read: never cut, and a name that cannot be read never costs the frame its other controls.
    const nameOf = (element) => {
      try {
        return capped(raw(accessibleName(element)));
      } catch {
        return null;
      }
    };
    const selector = 'input:not([type="hidden"]), select, textarea, button, a[href], [role~="button"], [role~="link"], [role~="checkbox"], [role~="radio"], [role~="switch"], [role~="tab"], [role~="menuitem"], [role~="option"], [role~="textbox"], [role~="combobox"]';
    const found = alertsOnly ? [] : Array.from(document.querySelectorAll(selector));
    // Rank every control before keeping any: visible first, then enabled fields, required first.
    const ranked = found.map((element, order) => {
      const box = element.getBoundingClientRect();
      const visible = box.width > 0 && box.height > 0 && element.checkVisibility({ visibilityProperty: true });
      const enabled = !element.matches(":disabled") && element.closest('[aria-disabled="true"], [inert]') === null;
      const field = element instanceof HTMLInputElement ? !buttonTypes.includes(element.type) : element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement;
      const required = element.required === true || element.getAttribute("aria-required") === "true";
      const rank = (visible ? 0 : 4) + (field && enabled ? 0 : 2) + (required ? 0 : 1);
      return { element, order, rank, visible, enabled, required };
    });
    ranked.sort((left, right) => left.rank - right.rank || left.order - right.order);
    const controls = ranked.slice(0, limit).map(({ element, rank, visible, enabled, required }) => ({
      rank,
      role: roleOf(element),
      name: nameOf(element),
      type: element instanceof HTMLInputElement ? element.type : null,
      required,
      visible,
      enabled,
    }));
    // The page's visible error and alert text: an alert or live region, the error a field names
    // as its own, or an element whose class or id says error, alert or invalid. Each element that
    // holds no control, outermost first in page order, its rendered text once, as the page has it.
    const alertSelector = '[role~="alert"], [role~="alertdialog"], [aria-live="assertive"], [aria-live="polite"], [class*="error" i], [id*="error" i], [class*="alert" i], [class*="invalid" i]';
    const named = [];
    for (const field of document.querySelectorAll('[aria-errormessage], [aria-invalid="true"][aria-describedby]')) {
      const ids = [field.getAttribute("aria-errormessage"), field.getAttribute("aria-invalid") === "true" ? field.getAttribute("aria-describedby") : null];
      for (const id of ids.join(" ").split(/\\s+/).filter(Boolean)) {
        const element = document.getElementById(id);
        if (element !== null) named.push(element);
      }
    }
    // Seen by a person: more than a pixel each way, as a screen reader's text never is, not
    // transparent or hidden, and not wholly off the page.
    const seen = (element) => {
      const box = element.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1) return false;
      const page = document.documentElement;
      const left = box.left + window.scrollX;
      const top = box.top + window.scrollY;
      if (left + box.width <= 0 || top + box.height <= 0) return false;
      if (left >= Math.max(page.scrollWidth, window.innerWidth) || top >= Math.max(page.scrollHeight, window.innerHeight)) return false;
      return element.checkVisibility({ visibilityProperty: true, opacityProperty: true });
    };
    // Styled as a success or a notice, as "alert-success" or "toast-info" are: never an error.
    const notice = (element) => Array.from(element.classList).some((name) => /(^|[-_])(success|info)([-_]|$)/i.test(name));
    const candidates = [...new Set([...document.querySelectorAll(alertSelector), ...named])].sort((one, other) =>
      one.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
    const alerts = [];
    const taken = [];
    for (const element of candidates) {
      if (alerts.length >= alertLimit) break;
      if (taken.some((outer) => outer.contains(element))) continue;
      if (element.matches(selector) || element.querySelector("input, select, textarea") !== null) continue;
      // A notice's own text is none, and neither is any inside it.
      if (notice(element)) {
        taken.push(element);
        continue;
      }
      if (!seen(element)) continue;
      const text = capped(raw(element.innerText));
      if (text === null) continue;
      taken.push(element);
      if (!alerts.includes(text)) alerts.push(text);
    }
    return { controls, total: found.length, alerts };
  };
  const controls = [];
  const alerts = [];
  let total = 0;
  for (const frame of primary.frames()) {
    const found = await frame
      .evaluate(read, { limit: ${pageControlsLimit}, textLimit: ${pageControlTextLimit}, alertLimit: ${pageAlertsLimit}, alertsOnly })
      .catch(() => null);
    if (found === null) continue;
    controls.push(...found.controls);
    total += found.total;
    for (const text of found.alerts) if (!alerts.includes(text)) alerts.push(text);
  }
  // Across frames by the same rank, each frame's in page order and frames in tree order.
  const kept = controls
    .map((control, order) => ({ control, order }))
    .sort((left, right) => left.control.rank - right.control.rank || left.order - right.order)
    .slice(0, ${pageControlsLimit})
    .map(({ control: { rank, ...control } }) => control);
  return { controls: kept, total, alerts: alerts.slice(0, ${pageAlertsLimit}) };
};
`;

/** The longest role, name and alert the minter is shown; longer ones are cut, after screening. */
const shownRole = 40;
const shownName = 120;
const shownAlert = 200;

/** Text as the minter reads it: whitespace collapsed and cut to `length`, or null when empty. */
const shown = (value: string | null, length: number) => {
  const text = value?.replace(/\s+/g, " ").trim().slice(0, length) ?? "";
  return text === "" ? null : text;
};

/**
 * The controls as the minter reads them, from controls already screened for typed values: each
 * role its first word, each name in single spaces and at most 120 characters, and each alert line
 * in single spaces and at most 200, kept only when the page showed one; never the host-only
 * `newAlerts`. Screen before this, never after: cutting a name first can leave part of a typed
 * value no screening finds.
 */
export const presentControls = (screened: PageControls): PageControls => {
  const alerts = (screened.alerts ?? []).flatMap((alert) => shown(alert, shownAlert) ?? []);
  return {
    total: screened.total,
    controls: screened.controls.map((control) => ({
      ...control,
      role: shown(control.role.trim().split(/\s+/)[0] ?? "", shownRole) ?? "generic",
      name: shown(control.name, shownName),
    })),
    ...(alerts.length === 0 ? {} : { alerts }),
  };
};

/** Where the host saves the controls it found after a sign-in step's submit, in the workspace. */
export const afterSubmitPath = (step: number) => `captures/after-submit/${step}.json`;

/** At most this many controls go inline in a failed step's result. */
export const inlineControlsLimit = 30;

/**
 * The controls saved after the last submit, for a failed step's result: at most
 * `inlineControlsLimit`, with a note naming the file that holds the rest.
 */
export const inlineControls = (path: string, saved: PageControls) => ({
  path,
  controls: saved.controls.slice(0, inlineControlsLimit),
  ...(saved.total > inlineControlsLimit
    ? {
        truncated: `Showing ${inlineControlsLimit} of ${saved.total} controls; read ${path} for more.`,
      }
    : {}),
});
