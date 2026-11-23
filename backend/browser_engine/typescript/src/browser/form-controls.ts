import { Schema } from "effect";
import { foldChoiceText } from "../runtime/text.js";

/**
 * The shape of a form control, as the page code reads it: a native date input, a text box, a
 * native select, or a custom ARIA dropdown (a combobox or a button that opens a listbox).
 */
export type FormControlShape = "date" | "text" | "select" | "combobox" | "other";

/**
 * An ISO `YYYY-MM-DD` date as `format` writes it, from the tokens `YYYY`, `YY`, `MMMM` and `MMM`
 * (the month's full and short name in `locale`, English when the locale is unknown), `MM`, `M`, `DD`
 * and `D`; anything else is kept as written. The page code's `formatDate` is this function, so the
 * host and a script render a date the same way. An impossible date throws `date_invalid`.
 * Self-contained: it runs in page code from its own source.
 */
export const formatDate = (iso: string, format: string, locale = "en-US"): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(iso);
  const [, year = "", month = "", day = ""] = match ?? [];
  const at = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (match === null || at.getUTCMonth() !== Number(month) - 1 || at.getUTCDate() !== Number(day))
    throw Object.assign(new Error("date_invalid"), { name: "FormControlFailure" });
  const named = (style: "long" | "short") => {
    try {
      return new Intl.DateTimeFormat(locale, { month: style, timeZone: "UTC" }).format(at);
      // error-reporting-allow: typed-recovery a locale the browser does not know names the month in English, as documented
    } catch {
      return new Intl.DateTimeFormat("en-US", { month: style, timeZone: "UTC" }).format(at);
    }
  };
  const tokens: Readonly<Record<string, string>> = {
    YYYY: year,
    YY: year.slice(2),
    MMMM: named("long"),
    MMM: named("short"),
    MM: month,
    M: String(Number(month)),
    DD: day,
    D: String(Number(day)),
  };
  return format.replace(/YYYY|YY|MMMM|MMM|MM|M|DD|D/gu, (token) => tokens[token] ?? token);
};

/**
 * A date-only input or output, `YYYY-MM-DD`, that is a real calendar date: `2026-02-30` fails to
 * decode, so an operation refuses it before it runs. Its JSON Schema is `format: "date"`, so a
 * caller's JSON Schema validator refuses it too. It checks the calendar with `formatDate`, the
 * check `fillDate` makes in the page, and sets no range: an earliest or latest date, a past date
 * or a range's order is the task's or the site's rule, which the operation checks itself.
 */
export const CalendarDate = Schema.String.pipe(
  Schema.filter(
    (value) => {
      try {
        formatDate(value, "");
        return true;
        // error-reporting-allow: typed-recovery formatDate throws only date_invalid: the answer
      } catch {
        return false;
      }
    },
    {
      description: "a calendar date, YYYY-MM-DD",
      jsonSchema: { format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    },
  ),
);

/**
 * Page code for a Kernel call body, where `page` is in scope: paste it at the top of the code
 * string, then call its functions with your verified Playwright locators. Every function reads
 * back that the page took the value and throws an Error whose message is a fixed reason, never a
 * value: `date_invalid`, `format_mismatch`, `control_unsupported`, `listbox_missing`,
 * `option_missing`, `option_ambiguous`, `option_disabled`, `field_missing`, `field_ambiguous`,
 * `labels_missing` or `not_committed`.
 *
 * - `formControlShape(control, { timeout }?)`: the control's shape (`FormControlShape`).
 * - `formatDate(iso, format, locale?)`: an ISO `YYYY-MM-DD` date as `format` writes it (see
 *   the exported `formatDate`).
 * - `fillDate(control, iso, format, { timeout }?)`: fills an ISO date into whatever date control
 *   the page has: a native date input (always ISO), a text box written in `format` (typed again
 *   character by character when an input mask rewrote it), or one part of a split date (`MM`, `DD`
 *   or `YYYY`) in a text box, a native select or a custom dropdown, matched by number or month name.
 *   It returns `{ shape }`, never the value.
 * - `chooseOption(control, wanted, { timeout }?)`: chooses the one option of a native select or a
 *   custom dropdown whose label or value is one of `wanted` (a string or a list of alternate
 *   spellings, such as `["CA", "California"]`), ignoring case, accents, spacing and punctuation.
 *   A label that equals one wins over a value that does,
 *   which wins over a label that holds it as whole words; two different options at the winning
 *   rank are ambiguous. A custom dropdown is opened, its own listbox found through `aria-controls`
 *   or `aria-owns` (else the one visible listbox), typed into when it filters as you type, and
 *   scrolled when it renders its options as you scroll. Returns `{ shape, label, value }`.
 * - `unfilledRequiredFields(scope, { timeout, before }?)`: the empty required fields a form shows
 *   now, in page order, such as ones it adds once an earlier answer is in. A field counts when it
 *   is visible, enabled, empty and marked `required` or `aria-required="true"`, or flagged invalid
 *   (`aria-invalid="true"`, the `is-invalid` class or the browser's own check after a submit). A
 *   control inside another one, such as a combobox's own text box, counts as that one, with its
 *   required mark, flag and value. Each is `{ label, shape, options? }`, its label from its
 *   `<label for>`, a wrapping label, `aria-labelledby` or `aria-label`. A text box, select or
 *   combobox with a label is supported, and a select or combobox listing 1 to 50 options now
 *   carries them as `{ value, label }`, ready for a site-field question. Any other field comes back
 *   `unsupported: true`: a checkbox, a date, a read-only box, one with no label, a select or
 *   combobox with two options of one label, and a card, password, one-time code or identity
 *   number field, by its `autocomplete` (`cc-…`, `current-password`, `new-password`,
 *   `one-time-code`) or by a label, name or id such as card number, card #, credit card, security
 *   code, card verification, CVV, CVN, CID, a card's expiry (next to "card", or as MM/YY or valid
 *   thru), SSN, verification, authentication or SMS code, a gate, door, access, alarm, lockbox or
 *   entry code (not one whose label is also an offer's code or a note, such as a promo, coupon,
 *   discount, presale or early access code, or instructions or notes that mention one), OTP, a
 *   6-digit code, a PIN (not a PIN code, which can be a postcode), password, passport, driver's
 *   licence, national ID or national insurance number, a TIN or EIN, IBAN, bank account, routing
 *   number or sort code, and a few of their German, Spanish and French names. With `before`,
 *   what `visibleFieldLabels(scope, { enabledOnly: true })` read before some answers were
 *   filled, it lists only the labelled fields those answers showed or enabled: none whose label,
 *   name or id is among `before`.
 * - `visibleFieldLabels(scope, { timeout, enabledOnly }?)`: every field the form shows now, by its
 *   label, as `unfilledRequiredFields` names it, and by each name and id it carries. Read them in
 *   the marked call just before the click, for `blockingRequiredFields`. With `enabledOnly: true`
 *   it leaves out disabled fields, for `unfilledRequiredFields`' `before`.
 * - `blockingRequiredFields(scope, before, { timeout, unaskable }?)`: after a click that should
 *   have saved or moved on, whether the page proves the click saved nothing. `before` is what
 *   `visibleFieldLabels` read just before the click; without it, it throws `labels_missing`. It
 *   returns `{ fields }` when the form still shows, once, and every control it flagged invalid is
 *   an empty required field a site-field question can ask, as `unfilledRequiredFields` lists
 *   them, that was not on the page before the click. Otherwise it returns `null`, such as when the
 *   form is gone, nothing is flagged, a filled or unsupported field is flagged too, or a flagged
 *   field was already showing, by its label, name or id, which a save may have cleared or the page
 *   may have flagged before. A flagged field whose label begins with a label shown before, as when
 *   the page writes its error inside the label, or reads as an error message, such as "Required"
 *   or "This field is required.", counts as one already showing. It also returns `null` when the
 *   click hid or removed a field shown before it, by its label, name or id, as a save that resets
 *   the form to another option may. A label the page only extended, as with its error, is still
 *   showing.
 *   With `unaskable: true`, when every flagged field is such a new, empty, required field with a
 *   label, but one or more are a card, password, code or identity number field as
 *   `unfilledRequiredFields` names them, which no site-field question may ask, such as a card or
 *   bank field, and every other one a question can ask, it returns `{ unaskable: true, labels }`
 *   instead of `null`, with the labels of those secret ones: the click saved nothing, and no
 *   question can fill them. A flagged field already showing, one with no label, or another
 *   unsupported one, such as a date, or a box to tick or a button to choose even when it names a
 *   card, still gives `null`, so a repair can teach the tool to fill it.
 *   Call it only once the click's wait found no confirmation and the form flagged a field, as a
 *   `{ invalid }` outcome of `waitForOutcomeResult` does.
 * - `fillRequiredField(scope, label, answer, { timeout }?)`: fills the one supported field
 *   `unfilledRequiredFields` returned with that label: a text box is filled and read back, a
 *   select or combobox chooses `answer` with `chooseOption`. Returns `{ shape }`.
 */
export const formControlsCode = String.raw`
const formControlFailure = (reason) => Object.assign(new Error(reason), { name: "FormControlFailure" });
/** Words of a validation message, such as "Required" or "This field is required.", rather than a field's name. */
const formControlMessageWords = /\brequired\b|\b(?:is|are) (?:missing|not valid)\b|\bthis field\b|\bplease (?:enter|select|choose|provide|fill|complete|correct)\b|\benter a valid\b|\bmust (?:be|contain|have|match)\b|\bcan(?:not|'t|’t| not) be (?:blank|empty)\b|\binvalid\b|\bist erforderlich\b|\bes (?:obligatorio|requerido)\b|\best (?:obligatoire|requis)\b/i;
/** Folds case, accents, spacing and punctuation, so "Joe’s Café" and "joes cafe" name the same option. */
const formControlText = ${String(foldChoiceText)};
const formControlFrame = async (control, options) => {
  const handle = await control.elementHandle(options);
  const frame = handle === null ? null : await handle.ownerFrame();
  return frame ?? control.page().mainFrame();
};
const formControlShape = (control, options) =>
  control.evaluate((element) => {
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
  }, undefined, options);
const formatDate = ${String(formatDate)};
const formControlOrdinal = (day) => {
  const number = Number(day);
  const suffix = number % 10 === 1 && number !== 11 ? "st" : number % 10 === 2 && number !== 12 ? "nd" : number % 10 === 3 && number !== 13 ? "rd" : "th";
  return number + suffix;
};
/** Every way an option can name one part of the date, the format's own first. */
const formControlDateCandidates = (iso, format, locale) => {
  const kinds = new Set((String(format).match(/YYYY|YY|MMMM|MMM|MM|M|DD|D/g) ?? []).map((token) => token[0]));
  if (kinds.size !== 1) throw formControlFailure("format_mismatch");
  const [kind] = kinds;
  const first = formatDate(iso, format, locale);
  const same = { Y: ["YYYY", "YY"], M: ["MM", "M", "MMMM", "MMM"], D: ["DD", "D"] }[kind];
  const candidates = [first, ...same.map((token) => formatDate(iso, token, locale))];
  if (kind === "M") candidates.push(...same.slice(2).map((token) => formatDate(iso, token, "en-US")));
  if (kind === "D") candidates.push(formControlOrdinal(iso.slice(8)));
  return [...new Set(candidates)];
};
/** The one option a choice names, by rank: label, then value, then whole words of the label. */
const formControlPick = (options, wanted) => {
  const names = new Set(wanted.map(formControlText).filter((name) => name !== ""));
  const words = (label) => label.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const ranks = [
    (option) => names.has(option.label),
    (option) => option.value !== "" && names.has(option.value),
    (option) => [...names].some((name) => (" " + words(option.label).join(" ") + " ").includes(" " + name + " ")),
  ];
  for (const rank of ranks) {
    const matched = options.filter(rank);
    if (matched.length === 0) continue;
    if (matched.length > 1) return { failure: "option_ambiguous" };
    return matched[0].disabled ? { failure: "option_disabled" } : { option: matched[0] };
  }
  return { failure: "option_missing" };
};
const formControlSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Playwright's error for a fill the page refused quotes the value, so it becomes the fixed reason. */
const formControlFill = (control, text, timeout) =>
  control.fill(text, { timeout }).catch(() => {
    throw formControlFailure("not_committed");
  });
const formControlTypeKeys = (control, keys, timeout) =>
  control.pressSequentially(keys, { timeout }).catch(() => {
    throw formControlFailure("not_committed");
  });
const formControlChooseNative = async (control, wanted, timeout) => {
  const options = await control.evaluate((select) =>
    Array.from(select.options).map((option, index) => ({
      index,
      label: option.label || option.textContent || "",
      value: option.value,
      disabled: option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled),
    })),
    undefined,
    { timeout },
  );
  const picked = formControlPick(
    options.map((option) => ({ ...option, label: formControlText(option.label), value: formControlText(option.value) })),
    wanted,
  );
  if (picked.failure) throw formControlFailure(picked.failure);
  await control.selectOption({ index: picked.option.index }, { timeout });
  if ((await control.evaluate((select) => select.selectedIndex, undefined, { timeout })) !== picked.option.index)
    throw formControlFailure("not_committed");
  const chosen = options[picked.option.index];
  return { shape: "select", label: chosen.label.trim(), value: chosen.value };
};
const formControlListbox = async (control, frame, until, timeout) => {
  while (true) {
    const ids = [await control.getAttribute("aria-controls", { timeout }), await control.getAttribute("aria-owns", { timeout })]
      .filter(Boolean)
      .flatMap((value) => value.split(/\s+/).filter(Boolean));
    for (const id of ids) {
      const owned = frame.locator("[id=" + JSON.stringify(id) + "]");
      if ((await owned.count()) !== 1 || !(await owned.isVisible())) continue;
      if ((await owned.getAttribute("role", { timeout })) === "listbox") return owned;
      const inner = owned.locator("[role=listbox]");
      if ((await inner.count()) === 1) return inner;
      return owned;
    }
    if (ids.length === 0) {
      const visible = [];
      const listboxes = frame.locator("[role=listbox]");
      const count = Math.min(await listboxes.count(), 20);
      for (let index = 0; index < count; index++)
        if (await listboxes.nth(index).isVisible()) visible.push(listboxes.nth(index));
      if (visible.length === 1) return visible[0];
      if (visible.length > 1) throw formControlFailure("listbox_missing");
    }
    if (Date.now() >= until) throw formControlFailure("listbox_missing");
    await formControlSleep(50);
  }
};
const formControlOptions = (listbox) =>
  listbox.locator("[role=option]").evaluateAll((options) =>
    options.map((option, index) => ({
      index,
      label: option.getAttribute("aria-label") || option.textContent || "",
      value: option.getAttribute("data-value") ?? option.getAttribute("value") ?? "",
      disabled: option.getAttribute("aria-disabled") === "true",
    })),
  );
const formControlChooseCustom = async (control, wanted, timeout) => {
  const until = Date.now() + timeout;
  const frame = await formControlFrame(control, { timeout });
  if ((await control.getAttribute("aria-expanded", { timeout })) !== "true") await control.click({ timeout });
  const editable = await control.evaluate(
    (element) => element instanceof HTMLInputElement && !element.readOnly && !element.disabled,
    undefined,
    { timeout },
  );
  let typed = false;
  // A dropdown that filters as you type can list nothing until something is typed.
  let listbox = editable
    ? await formControlListbox(control, frame, Math.min(until, Date.now() + 500), timeout).catch((error) => {
        if (error.name !== "FormControlFailure") throw error;
        return null;
      })
    : null;
  if (listbox === null && editable) {
    await formControlFill(control, wanted[0], timeout);
    typed = true;
  }
  listbox ??= await formControlListbox(control, frame, until, timeout);
  let picked = { failure: "option_missing" };
  let options = [];
  let stuck = 0;
  while (true) {
    const before = options.length;
    options = await formControlOptions(listbox);
    if (options.length !== before) stuck = 0;
    picked = formControlPick(
      options.map((option) => ({ ...option, label: formControlText(option.label), value: formControlText(option.value) })),
      wanted,
    );
    if (picked.failure !== "option_missing" || Date.now() >= until) break;
    // A dropdown that filters as you type shows its options for the typed text.
    if (editable && !typed) {
      await formControlFill(control, wanted[0], timeout);
      typed = true;
      continue;
    }
    // One that renders its options as it scrolls shows more of them further down.
    const moved = await listbox.evaluate((element) => {
      const before = element.scrollTop;
      element.scrollTop = before + Math.max(element.clientHeight, 1);
      return element.scrollTop !== before;
    }, undefined, { timeout });
    // Options the scroll asked for can take a moment to arrive; a list that stays put has no more.
    if (moved) stuck = 0;
    else if (!editable && ++stuck > 10) break;
    await formControlSleep(50);
  }
  if (picked.failure) throw formControlFailure(picked.failure);
  const option = listbox.locator("[role=option]").nth(picked.option.index);
  await option.scrollIntoViewIfNeeded({ timeout });
  await option.click({ timeout });
  const chosen = options[picked.option.index];
  // The control shows the choice as its label or one of the wanted names, alone or as whole words
  // of its text ("Month: July"), or the option itself is marked selected.
  const phrase = (text) => " " + formControlText(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ") + " ";
  const names = [chosen.label, ...wanted].map(phrase).filter((name) => name.trim() !== "");
  while (true) {
    const shown = await control.evaluate((element) =>
      element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.textContent,
      undefined,
      { timeout },
    );
    const selected = await option.getAttribute("aria-selected", { timeout: 100 }).catch(() => null);
    if (names.some((name) => phrase(shown).includes(name)) || selected === "true")
      return { shape: "combobox", label: chosen.label.trim(), value: chosen.value };
    if (Date.now() >= until) throw formControlFailure("not_committed");
    await formControlSleep(50);
  }
};
const chooseOption = async (control, wanted, options = {}) => {
  const timeout = options.timeout ?? 10000;
  const choices = (Array.isArray(wanted) ? wanted : [wanted]).map(String);
  if (choices.length === 0) throw formControlFailure("option_missing");
  const shape = await formControlShape(control, { timeout });
  if (shape === "select") return formControlChooseNative(control, choices, timeout);
  if (shape === "combobox") return formControlChooseCustom(control, choices, timeout);
  throw formControlFailure("control_unsupported");
};
/** Letters and digits only: an input mask adds or drops separators, never the date itself. */
const formControlSameText = (shown, expected) =>
  formControlText(shown).replace(/[^\p{L}\p{N}]/gu, "") === formControlText(expected).replace(/[^\p{L}\p{N}]/gu, "");
const fillDate = async (control, iso, format, options = {}) => {
  const timeout = options.timeout ?? 10000;
  const shape = await formControlShape(control, { timeout });
  const frame = await formControlFrame(control, { timeout });
  const locale = (await frame.evaluate(() => document.documentElement.lang).catch(() => "")) || "en-US";
  if (shape === "date") {
    formatDate(iso, "YYYY-MM-DD");
    await formControlFill(control, iso, timeout);
    if ((await control.inputValue({ timeout })) !== iso) throw formControlFailure("not_committed");
    return { shape };
  }
  if (shape === "select" || shape === "combobox") {
    await chooseOption(control, formControlDateCandidates(iso, format, locale), { timeout });
    return { shape };
  }
  if (shape !== "text") throw formControlFailure("control_unsupported");
  const text = formatDate(iso, format, locale);
  await formControlFill(control, text, timeout);
  if (formControlSameText(await control.inputValue({ timeout }), text)) return { shape };
  // A masked field rewrites what is filled at once; it takes the date typed key by key, with or
  // without its separators.
  for (const keys of [text, text.replace(/[^\p{L}\p{N}]/gu, "")]) {
    await formControlFill(control, "", timeout);
    await formControlTypeKeys(control, keys, timeout);
    if (formControlSameText(await control.inputValue({ timeout }), text)) return { shape };
  }
  throw formControlFailure("not_committed");
};
/** The controls a form's field can be, beside the inputs that are buttons or carry no value. */
const formControlFieldSelector =
  "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), select, textarea, [role=combobox], [role=textbox], [aria-haspopup=listbox], [contenteditable=true]";
/** Input types that take typed text; a password or a one-time code is never one of them. */
const formControlTextTypes = new Set(["", "text", "email", "tel", "url", "number", "search"]);
/**
 * Every visible, enabled, empty control in scope that is marked required (required,
 * aria-required="true", or flagged invalid by aria-invalid="true", the is-invalid class or the
 * browser's own check after a submit), each with its label, its supported shape or unsupported, a
 * select's or combobox's options when it lists 1 to 50 now, whether the page flagged it, and its
 * control. A control inside another one, such as a combobox's own text box, is that one, and
 * its required mark, flag and value count as that one's. Mode "flagged" keeps only the flagged
 * ones, each with its keys (its label and every name and id it and its inner controls carry), and
 * counts the flagged controls that are not empty; mode "labels" returns the keys of every visible
 * control instead, and mode "enabled labels" those of every visible, enabled one.
 */
const formControlRequiredFields = async (scope, timeout, mode = "required") => {
  const candidates = scope.locator(formControlFieldSelector);
  const found = await candidates.evaluateAll((elements, mode) => {
    const words = (text) => String(text ?? "").replace(/[\s\u200b]+/g, " ").trim();
    // A card, a password, a one-time code or an identity number goes through the host's own
    // protected forms, never a site-field question.
    const secretTokens = /^(cc-.*|current-password|new-password|one-time-code)$/;
    // A PIN code or pincode is a postcode in some countries, so only a PIN alone counts.
    const secretWords = /\b(?:card ?(?:number|no)|cc ?(?:number|num)|credit card|card verification|security ?code|cvv2?|cvc2?|csc|cvn|cid|ssn|social security|verification ?code|authentication code|sms ?code|otp|\d[- ]?digit code|pass ?word|passcode|passport|driv(?:er|ing).?s? ?licen[cs]e|national ?(?:insurance|id|identity|identification)|iban|bank ?account|routing ?(?:transit )?(?:number|no)|sort ?code|card ?(?:expiry|expiration|exp)|cc ?exp(?:iry|iration)?|(?:expiry|expiration) (?:date )?(?:of|on) (?:your |the )?card|valid ?(?:thru|through)|mm ?\/ ?yy|kartennummer|n[uú]mero de tarjeta|num[eé]ro de carte|passwort|kennwort|contrase[nñ]a|mot de passe|reisepass|pasaporte|passeport|f[uü]hrerschein|(?:permiso|licencia|carn[eé]) de conducir|permis de conduire|personalausweis|ausweisnummer|documento de identidad|carte d.identit|sozialversicherung(?:snummer)?|seguridad social|s[eé]curit[eé] sociale|kontonummer|bankleitzahl|cuenta bancaria|compte bancaire)\b|\bcard ?#|\bpin\b(?! ?code)/i;
    // Short codes that are ordinary words in some languages count only in capitals.
    const secretCodes = /\b(?:EIN|TIN|DNI|NIE)\b/;
    // An access code, such as a gate or door code, unless its label shows an offer's code or a
    // note that mentions one, such as delivery instructions.
    const accessCodes = /\b(?:gate|door|access|alarm|lockbox|entry) ?code\b/i;
    const notAccessCodes = /\b(?:promo|coupon|discount|pre ?sale|early ?access|instruction|note)/i;
    const spaced = (text) => words(String(text ?? "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\-.[\]]+/g, " "));
    const flagMarks = '[aria-invalid="true"], .is-invalid' +
      (globalThis.CSS?.supports?.("selector(:user-invalid)") ? ", :user-invalid" : "");
    // A wrapping label holds the control itself, whose value or options are not its name.
    const labelText = (label) => {
      const copy = label.cloneNode(true);
      copy.querySelectorAll("input, select, textarea, [role=listbox], [role=combobox], [role=option]").forEach((inner) => inner.remove());
      return words(copy.textContent);
    };
    const nameOf = (element) => {
      const labels = Array.from(element.labels ?? []);
      const byFor = labels.find((label) => !label.contains(element));
      if (byFor) return labelText(byFor);
      const wrapping = element.closest("label");
      if (wrapping) return labelText(wrapping);
      const ids = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
      const named = ids.map((id) => element.ownerDocument.getElementById(id)).filter(Boolean);
      if (named.length > 0) return words(named.map((node) => node.textContent).join(" "));
      return words(element.getAttribute("aria-label"));
    };
    const isEmpty = (element) => {
      if (element instanceof HTMLInputElement) {
        if (element.type === "checkbox") return !element.checked;
        if (element.type === "radio") {
          const radios = Array.from((element.form ?? element.ownerDocument).querySelectorAll("input[type=radio]"));
          return !(element.name === "" ? [element] : radios.filter((other) => other.name === element.name)).some((other) => other.checked);
        }
        if (element.type === "file") return (element.files?.length ?? 0) === 0;
        return element.value.trim() === "";
      }
      if (element instanceof HTMLTextAreaElement) return element.value.trim() === "";
      if (element instanceof HTMLSelectElement) return element.value === "";
      return words(element.textContent) === "";
    };
    const optionsOf = (element) => {
      let labels = [];
      if (element instanceof HTMLSelectElement)
        labels = Array.from(element.options).filter((option) => !option.disabled && option.value !== "").map((option) => words(option.label || option.textContent));
      else {
        const ids = [element.getAttribute("aria-controls"), element.getAttribute("aria-owns")].filter(Boolean).flatMap((value) => value.split(/\s+/));
        const lists = ids.map((id) => element.ownerDocument.getElementById(id)).filter(Boolean);
        labels = lists.flatMap((list) => Array.from(list.querySelectorAll("[role=option]")))
          .filter((option) => option.getAttribute("aria-disabled") !== "true")
          .map((option) => words(option.getAttribute("aria-label") || option.textContent));
      }
      labels = labels.filter((label) => label !== "");
      // Two options with one label can't be told apart by an answer.
      if (new Set(labels).size < labels.length) return { duplicate: true };
      return labels.length >= 1 && labels.length <= 50 ? { options: labels.map((label) => ({ value: label, label })) } : {};
    };
    const shown = (element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
    const outer = elements.filter((element) => !elements.some((other) => other !== element && other.contains(element)));
    const partsOf = (element) => [element, ...elements.filter((other) => other !== element && element.contains(other))];
    // A field is known by its label and by each name and id it and its inner controls carry, so
    // one whose label the page rewrites when it flags it is still the same field.
    const keysOf = (element) =>
      [nameOf(element), ...partsOf(element).flatMap((part) => [part.getAttribute("name"), part.id])].filter(
        (key) => typeof key === "string" && key !== "",
      );
    const enabledOf = (element) => !element.matches(":disabled") && element.getAttribute("aria-disabled") !== "true";
    if (mode === "labels" || mode === "enabled labels")
      return { labels: outer.filter((element) => shown(element) && (mode === "labels" || enabledOf(element))).flatMap(keysOf) };
    let flaggedFilled = 0;
    const fields = elements.flatMap((element, index) => {
      if (!outer.includes(element)) return [];
      // A combobox's own text box, inside it, carries its required mark, flag and value.
      const parts = partsOf(element);
      const enabled = enabledOf(element);
      const flagged = parts.some((part) => part.matches(flagMarks));
      const required = flagged || parts.some((part) => part.required === true || part.getAttribute("aria-required") === "true");
      if (!shown(element) || !enabled || !required) return [];
      if (!parts.every(isEmpty)) {
        if (flagged) flaggedFilled += 1;
        return [];
      }
      const label = nameOf(element);
      const tokens = (element.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/);
      const texts = [label, element.getAttribute("name"), element.id].map(spaced);
      const listed = optionsOf(element);
      return [{
        index,
        label,
        options: listed.options,
        duplicate: listed.duplicate === true,
        input: element instanceof HTMLInputElement ? element.type : undefined,
        // A box to tick or a button to choose that names a card or a bank is never one itself.
        secret:
          !(element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) &&
          (tokens.some((token) => secretTokens.test(token)) ||
            texts.some((text) => secretWords.test(text) || secretCodes.test(text)) ||
            (texts.some((text) => accessCodes.test(text)) && !notAccessCodes.test(texts[0]))),
        readOnly: element.readOnly === true,
        flagged,
        keys: keysOf(element),
      }];
    });
    return { fields, flaggedFilled };
  }, mode);
  if (mode === "labels" || mode === "enabled labels") return found.labels;
  const fields = [];
  for (const field of found.fields) {
    if (mode === "flagged" && !field.flagged) continue;
    const control = candidates.nth(field.index);
    let shape = await formControlShape(control, { timeout });
    if (field.secret || (shape === "text" && ((field.input !== undefined && !formControlTextTypes.has(field.input)) || field.readOnly)))
      shape = "other";
    const supported =
      field.label !== "" &&
      (shape === "text" || ((shape === "select" || shape === "combobox") && !field.duplicate));
    fields.push({
      label: field.label,
      shape,
      ...(supported && shape !== "text" && field.options !== undefined ? { options: field.options } : {}),
      ...(supported ? {} : { unsupported: true }),
      secret: field.secret,
      keys: field.keys,
      control,
    });
  }
  return mode === "flagged" ? { fields, flaggedFilled: found.flaggedFilled } : fields;
};
const unfilledRequiredFields = async (scope, options = {}) => {
  const { before } = options;
  if (before !== undefined && !Array.isArray(before)) throw formControlFailure("labels_missing");
  // With before, only a labelled field none of whose keys it holds: one shown or enabled since.
  const seen = new Set((before ?? []).map(String));
  return (await formControlRequiredFields(scope, options.timeout ?? 10000))
    .filter((field) => before === undefined || (field.label !== "" && !field.keys.some((key) => seen.has(key))))
    .map(({ control, keys, secret, ...field }) => field);
};
const visibleFieldLabels = async (scope, options = {}) =>
  formControlRequiredFields(scope, options.timeout ?? 10000, options.enabledOnly === true ? "enabled labels" : "labels");
const blockingRequiredFields = async (scope, before, options = {}) => {
  if (!Array.isArray(before)) throw formControlFailure("labels_missing");
  const timeout = options.timeout ?? 10000;
  if ((await scope.count()) !== 1 || !(await scope.isVisible())) return null;
  const { fields, flaggedFilled } = await formControlRequiredFields(scope, timeout, "flagged");
  // A field the page already showed before the click, by its label, name or id, may have been
  // cleared or flagged by a save. So may one whose label begins with a label shown before, as
  // when the page writes its error inside the label, or whose label reads as an error message.
  const seen = new Set(before.map(String));
  const extendsKey = (label, key) =>
    label.length > key.length && label.startsWith(key) && !/[\p{L}\p{N}]/u.test(label.charAt(key.length));
  const extended = (label) => [...seen].some((key) => extendsKey(label, key));
  const stale = (field) =>
    field.keys.some((key) => seen.has(key)) || extended(field.label) || formControlMessageWords.test(field.label);
  if (fields.length === 0 || flaggedFilled > 0 || fields.some(stale)) return null;
  // A click that hid or removed a field the form showed before may be a save that reset the
  // form, so it proves nothing. A label the page only extended, as with its error, is kept.
  const after = await formControlRequiredFields(scope, timeout, "labels");
  if ([...seen].some((key) => !after.some((shown) => shown === key || extendsKey(shown, key)))) return null;
  const unasked = fields.filter((field) => field.unsupported);
  if (unasked.length === 0) return { fields: fields.map(({ control, keys, secret, ...field }) => field) };
  // The click still saved nothing, but no site-field question may ask a secret, such as a card
  // number. Any other kind, such as a date, is left to a repair that can teach the tool to fill
  // it. Only a labelled field can be told apart from one shown before, and named.
  if (options.unaskable !== true || unasked.some((field) => field.label === "" || !field.secret)) return null;
  return { unaskable: true, labels: unasked.map((field) => field.label) };
};
const fillRequiredField = async (scope, label, answer, options = {}) => {
  const timeout = options.timeout ?? 10000;
  const matched = (await formControlRequiredFields(scope, timeout)).filter((field) => field.label === label && !field.unsupported);
  if (matched.length === 0) throw formControlFailure("field_missing");
  if (matched.length > 1) throw formControlFailure("field_ambiguous");
  const [field] = matched;
  const text = String(answer);
  if (field.shape !== "text") {
    await chooseOption(field.control, text, { timeout });
    return { shape: field.shape };
  }
  await formControlFill(field.control, text, timeout);
  const shown = await field.control.evaluate(
    (element) => ("value" in element ? element.value : element.textContent),
    undefined,
    { timeout },
  );
  if (!formControlSameText(shown, text)) throw formControlFailure("not_committed");
  return { shape: "text" };
};
`;
