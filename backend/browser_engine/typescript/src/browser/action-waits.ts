/**
 * The kinds of answer `waitForOutcome` and `waitForOutcomeResult` race beside plain locators, and
 * `waitForReady`, the wait before acting on a control. `waitCode` (./wait.ts) pastes both; this
 * module holds their page code and the shapes they return.
 */

/** The kind of answer an outcome is: a locator showing, or one of the declared kinds. */
export type OutcomeKind =
  | "locator"
  | "gone"
  | "invalid"
  | "url"
  | "response"
  | "dialog"
  | "popup"
  | "announced"
  | "check";

/** One field a site marked invalid: its label as the page names it, and its error message. */
export interface InvalidField {
  readonly field: string;
  readonly message: string;
}

/**
 * What showed the winning outcome, by kind: the locator's one visible match and its text, how long
 * a `gone` element stayed gone, the fields marked invalid, the URL reached, the response's method,
 * URL and status, the native dialog's type and message, the popup's URL, or a `check`'s value.
 */
export interface OutcomeEvidence {
  readonly count?: number;
  readonly visible?: number;
  readonly text?: string;
  readonly goneForMs?: number;
  readonly fields?: readonly InvalidField[];
  readonly url?: string;
  readonly method?: string;
  readonly status?: number;
  readonly type?: string;
  readonly message?: string;
  readonly value?: unknown;
}

/** What a declared, non-locator outcome showed at the last look. */
export interface OutcomeKindObservation {
  readonly kind: Exclude<OutcomeKind, "locator">;
  readonly matched: boolean;
  readonly count?: number;
  readonly visible?: number;
  readonly invalid?: number;
  readonly seen?: number;
}

/**
 * `waitForOutcomeResult`'s answer. The response, dialog or popup page that won, when one did, is on
 * `response`, `dialog` or `page`, kept off the JSON so the result can be returned as it is.
 */
export interface OutcomeResult {
  readonly outcome: string;
  readonly kind: OutcomeKind;
  readonly afterMs: number;
  readonly looks: number;
  readonly evidence: OutcomeEvidence;
  readonly observations: Readonly<Record<string, OutcomeKindObservation | Readonly<Record<string, number>>>>;
}

/** What held a `waitForReady` back at some look, by kind. */
export type ReadyBlocker =
  | "absent"
  | "ambiguous"
  | "hidden"
  | "disabled"
  | "read-only"
  | "busy"
  | "covered"
  | "moving"
  | "overlay"
  | "collapsed"
  | "pending"
  | "until";

/**
 * `waitForReady`'s answer: when the control was ready, what held it back on the way, how many
 * self-opening panels it closed and whether it expanded the control's section.
 */
export interface ReadyResult {
  /** Removes the locator handlers that close `dismiss` panels before later actions. */
  readonly release: () => Promise<void>;
  readonly afterMs: number;
  readonly looks: number;
  readonly waitedFor: readonly ReadyBlocker[];
  readonly dismissed: number;
  readonly expanded: boolean;
}

/**
 * Page code for the declared outcome kinds. Uses `page`, and `waitSleep` and `waitContextLost`
 * from the progress code before it.
 */
export const outcomeKindsCode = String.raw`
const outcomeWaitKinds = ["gone", "invalid", "url", "response", "dialog", "popup", "announced", "check"];
const outcomeWaitIsLocator = (value) =>
  value !== null && typeof value === "object" && typeof value.count === "function" && typeof value.filter === "function";
const outcomeWaitIsRegExp = (value) => Object.prototype.toString.call(value) === "[object RegExp]";
const outcomeWaitClean = (text, limit) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
// One outcome as the wait reads it: a locator, or an object naming exactly one kind.
const outcomeWaitCandidate = (name, value) => {
  if (outcomeWaitIsLocator(value)) return { name, kind: "locator", locator: value };
  const kinds = value !== null && typeof value === "object" ? outcomeWaitKinds.filter((kind) => value[kind] !== undefined) : [];
  const refuse = (what) => {
    throw new TypeError('waitForOutcome outcome "' + name + '" ' + what);
  };
  if (kinds.length !== 1) refuse("needs a locator, or an object with exactly one of " + outcomeWaitKinds.join(", "));
  const kind = kinds[0];
  const spec = value[kind];
  if ((kind === "gone" || kind === "invalid") && !outcomeWaitIsLocator(spec)) refuse("needs a locator as " + kind);
  if (kind === "check" && typeof spec !== "function") refuse("needs a function as check");
  if (kind === "url" && !(typeof spec === "string" || outcomeWaitIsRegExp(spec) || typeof spec === "function"))
    refuse("needs a string, a RegExp or a function of the URL as url");
  if (kind === "response" && !(typeof spec === "function" ||
      (spec !== null && typeof spec === "object" && ["method", "url", "status", "navigation"].some((field) => spec[field] !== undefined))))
    refuse("needs a function of the response or { method, url, status, navigation }, with at least one of them, as response");
  if (kind === "dialog" && !(spec === true || typeof spec === "string" || Array.isArray(spec)))
    refuse('needs true, a dialog type such as "alert", or a list of types as dialog');
  if (kind === "popup" && !(spec === true || typeof spec === "function")) refuse("needs true or a function of the new page as popup");
  if (kind === "announced" && !(typeof spec === "string" || outcomeWaitIsRegExp(spec))) refuse("needs a string or a RegExp as announced");
  if (value.stableMs !== undefined && !(Number.isFinite(value.stableMs) && value.stableMs >= 0)) refuse("needs stableMs of 0 or more");
  return { name, kind, spec, locator: kind === "gone" || kind === "invalid" ? spec : undefined, stableMs: value.stableMs };
};
// A URL matcher: a function of the URL, a RegExp tested against the whole URL, or a string equal to
// the whole URL, its path, or its path and query.
const outcomeWaitUrlMatches = (matcher, href) => {
  let url;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (typeof matcher === "function") return Boolean(matcher(url));
  if (outcomeWaitIsRegExp(matcher)) {
    matcher.lastIndex = 0;
    return matcher.test(href);
  }
  return href === matcher || url.pathname === matcher || url.pathname + url.search === matcher;
};
const outcomeWaitResponseMatches = async (matcher, response) => {
  if (typeof matcher === "function") return Boolean(await matcher(response));
  const request = response.request();
  if (matcher.method !== undefined && request.method().toUpperCase() !== String(matcher.method).toUpperCase()) return false;
  if (matcher.url !== undefined && !outcomeWaitUrlMatches(matcher.url, response.url())) return false;
  if (matcher.navigation !== undefined && request.isNavigationRequest() !== Boolean(matcher.navigation)) return false;
  const status = response.status();
  if (typeof matcher.status === "number") return status === matcher.status;
  if (Array.isArray(matcher.status)) return status >= matcher.status[0] && status <= matcher.status[1];
  if (typeof matcher.status === "function") return Boolean(matcher.status(status));
  return true;
};
const outcomeWaitDialogType = (spec, type) =>
  spec === true || spec === type || (Array.isArray(spec) && spec.includes(type));
// Keeps a live handle off the JSON, so a result holding it can still be returned from a call.
const outcomeWaitHidden = (target, name, value) =>
  value === undefined ? target : Object.defineProperty(target, name, { value, enumerable: false });
// Listens, from before the action, for the outcomes the page announces as events: a response, a
// native dialog, a popup, and main-frame navigations for url outcomes. Each candidate keeps its
// first match. Nothing here handles a dialog or waits on a promise of Playwright's: stop() removes
// every listener, so a losing outcome leaves nothing behind.
const outcomeWaitEvents = (candidates) => {
  const hits = new Map();
  const seen = { response: 0, dialog: 0, popup: 0 };
  const listeners = [];
  let stopped = false;
  let failure;
  let navigatedAt = -Infinity;
  let dialog;
  let unnamedDialog;
  let dialogOpened;
  const dialogSignal = new Promise((resolve) => {
    dialogOpened = resolve;
  });
  let announceHit;
  const hitSignal = new Promise((resolve) => {
    announceHit = resolve;
  });
  const on = (event, handler) => {
    page.on(event, handler);
    listeners.push(() => page.off(event, handler));
  };
  const of = (kind) => candidates.filter((candidate) => candidate.kind === kind);
  const hit = (candidate, at, evidence, handles) => {
    const earlier = hits.get(candidate.name);
    if (stopped || (earlier !== undefined && earlier.at <= at)) return;
    hits.set(candidate.name, { at, evidence, handles });
    announceHit();
  };
  // A matcher that throws is a bug in the code: the next look rethrows it.
  const match = (candidate, test, at, evidence, handles) =>
    Promise.resolve()
      .then(test)
      .then(
        (matched) => {
          if (matched) hit(candidate, at, evidence(), handles);
        },
        (error) => {
          failure ??= error;
        },
      );
  if (of("url").length > 0)
    on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigatedAt = Date.now();
    });
  if (of("response").length > 0)
    on("response", (response) => {
      seen.response += 1;
      const at = Date.now();
      for (const candidate of of("response"))
        match(candidate, () => outcomeWaitResponseMatches(candidate.spec, response), at, () => ({
          url: response.url(),
          method: response.request().method(),
          status: response.status(),
        }), { response });
    });
  // Page scripts stop while a native dialog is open, so the wait decides at once: the first dialog
  // outcome whose type matches, or a failure naming a dialog no outcome names.
  if (of("dialog").length > 0)
    on("dialog", (opened) => {
      seen.dialog += 1;
      dialog ??= opened;
      const candidate = of("dialog").find((each) => outcomeWaitDialogType(each.spec, opened.type()));
      if (candidate === undefined) unnamedDialog ??= opened;
      else hit(candidate, Date.now(), { type: opened.type(), message: opened.message() }, { dialog: opened });
      dialogOpened(opened);
    });
  if (of("popup").length > 0)
    on("popup", (opened) => {
      seen.popup += 1;
      const at = Date.now();
      for (const candidate of of("popup"))
        match(candidate, () => (candidate.spec === true ? true : candidate.spec(opened)), at, () => ({ url: opened.url() }), {
          page: opened,
        });
    });
  return {
    hit: (name) => hits.get(name),
    seen: (kind) => seen[kind],
    navigatedSince: (at) => navigatedAt >= at,
    dialogOpen: () => dialog !== undefined,
    dialog: () => dialog,
    unnamedDialog: () => unnamedDialog,
    dialogSignal,
    hitSignal,
    anyHit: () => hits.size > 0,
    rethrow: () => {
      if (failure !== undefined) throw failure;
    },
    stop: () => {
      stopped = true;
      for (const remove of listeners) remove();
    },
  };
};
// Runs in the page: keeps, by key, every text a live region announces from now on, as a screen
// reader would hear it: a toast, a snackbar, an alert or a status message that is added, shown or
// changes inside an element with aria-live (not off) or the role alert, alertdialog, status or log.
// A toast that comes and goes between two looks is still kept. With seed, what such regions show
// now counts too: a page the action replaced is all new.
const outcomeWaitAnnounceInPage = ({ key, seed }) => {
  if (globalThis[Symbol.for(key)] !== undefined) return;
  const live = '[aria-live]:not([aria-live="off"]), [role="alert"], [role="alertdialog"], [role="status"], [role="log"]';
  const state = { texts: [] };
  globalThis[Symbol.for(key)] = state;
  const shows = (element) =>
    element.isConnected &&
    (typeof element.checkVisibility === "function" ? element.checkVisibility({ visibilityProperty: true }) : element.getClientRects().length > 0);
  const said = (element) => String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500);
  const keep = (text) => {
    if (text === "" || state.texts.at(-1) === text) return;
    state.texts.push(text);
    if (state.texts.length > 50) state.texts.shift();
  };
  const note = (node) => {
    const element = node.nodeType === 1 ? node : node.parentElement;
    if (!element) return;
    const regions = [element.closest(live), ...element.querySelectorAll(live)].filter((region) => region !== null);
    for (const region of regions) if (shows(region)) keep(said(region));
  };
  if (seed) for (const region of document.querySelectorAll(live)) if (shows(region)) keep(said(region));
  state.observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "childList") for (const node of record.addedNodes) note(node);
      note(record.target);
    }
  });
  state.observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-hidden", "open"],
  });
};
const outcomeWaitAnnounced = async (key) => {
  const texts = await page.evaluate((key) => globalThis[Symbol.for(key)]?.texts.slice() ?? null, key);
  if (texts !== null) return texts;
  await page.evaluate(outcomeWaitAnnounceInPage, { key, seed: true });
  return page.evaluate((key) => globalThis[Symbol.for(key)]?.texts.slice() ?? [], key);
};
const outcomeWaitTextMatches = (matcher, text) => {
  if (outcomeWaitIsRegExp(matcher)) {
    matcher.lastIndex = 0;
    return matcher.test(text);
  }
  return text.includes(matcher);
};
// Runs in the page: every control under the roots the site marked invalid, with its label and its
// message. A control is invalid when it has aria-invalid="true", the is-invalid class, or fails the
// browser's own validation after the person tried to submit (:user-invalid). One hidden behind a
// styled control counts when its label shows.
const outcomeWaitInvalidInPage = (roots) => {
  const marks = '[aria-invalid="true"], .is-invalid' +
    (globalThis.CSS?.supports?.("selector(:user-invalid)") ? ", :user-invalid" : "");
  const shows = (element) =>
    typeof element.checkVisibility === "function"
      ? element.checkVisibility({ visibilityProperty: true, opacityProperty: true })
      : element.getClientRects().length > 0;
  const clean = (text, limit) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  const byIds = (ids) =>
    String(ids ?? "").split(/\s+/).flatMap((id) => {
      const element = id === "" ? null : document.getElementById(id);
      return element !== null && shows(element) ? [clean(element.innerText, 200)] : [];
    }).filter((text) => text !== "");
  const label = (element) =>
    clean(element.getAttribute("aria-label"), 100) ||
    byIds(element.getAttribute("aria-labelledby")).join(" ") ||
    clean([...(element.labels ?? [])].map((each) => each.innerText).join(" "), 100) ||
    clean(element.closest("label")?.innerText, 100) ||
    clean(element.getAttribute("name") ?? element.getAttribute("placeholder") ?? element.id, 100);
  const message = (element) => {
    const linked = [...byIds(element.getAttribute("aria-errormessage")), ...byIds(element.getAttribute("aria-describedby"))];
    if (linked.length > 0) return clean(linked.join(" "), 200);
    const near = element.parentElement?.querySelector('.invalid-feedback, [role="alert"], [class*="error" i]');
    if (near && near !== element && !near.contains(element) && shows(near)) return clean(near.innerText, 200);
    return clean(element.validationMessage, 200);
  };
  const fields = [];
  const seen = new Set();
  for (const root of roots)
    for (const element of [root, ...root.querySelectorAll(marks)]) {
      if (seen.has(element) || !element.matches(marks)) continue;
      seen.add(element);
      if (!shows(element) && ![...(element.labels ?? [])].some(shows)) continue;
      fields.push({ field: label(element), message: message(element) });
    }
  return fields.slice(0, 20);
};
// Reads one outcome at a look: what it matched, and whether it shows.
const outcomeWaitRead = async (candidate, state, key, events) => {
  const { kind, name } = candidate;
  if (kind === "locator") {
    const count = await candidate.locator.count();
    const visible = count === 0 ? 0 : await candidate.locator.filter({ visible: true }).count();
    return key === undefined ? { count, visible }
      : { count, visible, changed: visible === 0 ? 0 : await outcomeWaitChanged(candidate.locator, key) };
  }
  if (kind === "gone") {
    const count = await candidate.locator.count();
    const visible = count === 0 ? 0 : await candidate.locator.filter({ visible: true }).count();
    const now = Date.now();
    if (visible > 0) {
      state.goneSeen.add(name);
      state.goneSince.delete(name);
    } else if (state.goneSeen.has(name) && !state.goneSince.has(name)) state.goneSince.set(name, now);
    return { kind, matched: state.goneSince.has(name), count, visible };
  }
  if (kind === "invalid") {
    const fields = await candidate.locator.evaluateAll(outcomeWaitInvalidInPage);
    state.invalidFields.set(name, fields);
    return { kind, matched: fields.length > 0, invalid: fields.length };
  }
  if (kind === "url") {
    const href = page.url();
    const matched = outcomeWaitUrlMatches(candidate.spec, href) &&
      (state.urlBefore === undefined || href !== state.urlBefore || events.navigatedSince(state.actedAt));
    return { kind, matched };
  }
  if (kind === "announced") {
    const texts = await outcomeWaitAnnounced(state.announceKey);
    const text = texts.find((each) => outcomeWaitTextMatches(candidate.spec, each));
    if (text !== undefined) state.announcedText.set(name, text);
    return { kind, matched: text !== undefined, seen: texts.length };
  }
  if (kind === "check") {
    try {
      const value = await candidate.spec();
      if (value) state.checked.set(name, value);
      return { kind, matched: Boolean(value) };
    } catch (error) {
      if (waitContextLost(error)) return { kind, matched: false };
      throw error;
    }
  }
  return { kind, matched: events.hit(name) !== undefined, seen: events.seen(kind) };
};
const outcomeWaitInvalidKey = (fields) => JSON.stringify(fields ?? []);
// Whether an outcome counts at this look. A locator or invalid fields shown before the action, and
// unchanged, count only once no longer stale; a gone element counts once it stayed gone stableMs.
const outcomeWaitShows = (candidate, observation, state, stale, now) => {
  if (observation === undefined) return false;
  if (candidate.kind === "locator") return observation.visible > 0 && !(stale && observation.changed === 0);
  if (candidate.kind === "invalid")
    return observation.matched && !(stale &&
      outcomeWaitInvalidKey(state.invalidFields.get(candidate.name)) === state.invalidBefore.get(candidate.name));
  if (candidate.kind === "gone")
    return observation.matched && now - state.goneSince.get(candidate.name) >= (candidate.stableMs ?? 300);
  return observation.matched;
};
// Whether an outcome shows anything at all, even an answer from before the action: a page showing
// one is not quiet.
const outcomeWaitShowsAny = (candidate, observation) =>
  observation !== undefined &&
  (candidate.kind === "locator" ? observation.visible > 0 : candidate.kind !== "url" && candidate.kind !== "check" && observation.matched);
const outcomeWaitEvidence = async (candidate, observation, state, events, now) => {
  const { kind, name } = candidate;
  if (kind === "locator") {
    let text;
    try {
      text = await candidate.locator.evaluateAll((elements) =>
        elements.find((element) =>
          typeof element.checkVisibility === "function" ? element.checkVisibility() : element.getClientRects().length > 0)?.innerText);
    } catch {
      text = undefined;
    }
    return { count: observation.count, visible: observation.visible, ...(typeof text === "string" ? { text: outcomeWaitClean(text, 500) } : {}) };
  }
  if (kind === "gone") return { goneForMs: now - state.goneSince.get(name) };
  if (kind === "invalid") return { fields: state.invalidFields.get(name) ?? [] };
  if (kind === "url") return { url: page.url() };
  if (kind === "announced") return { text: state.announcedText.get(name) };
  if (kind === "check") {
    const value = state.checked.get(name);
    if (value === true) return {};
    try {
      return { value: JSON.parse(JSON.stringify(value)) };
    } catch {
      return {};
    }
  }
  return { ...events.hit(name).evidence };
};
`;

/**
 * Page code for `waitForReady`. Uses `page`, and the limits, progress tracker and records of the
 * progress code before it.
 */
export const readyWaitCode = String.raw`
// Runs in the page: the state of the control's visible matches at one look.
const readyWaitInPage = (elements, spec) => {
  // Visible as Playwright counts it: a box and no visibility:hidden. A transparent native input
  // under a styled checkbox, radio or switch still counts.
  const shows = (element) =>
    (typeof element.checkVisibility === "function"
      ? element.checkVisibility({ visibilityProperty: true })
      : element.getClientRects().length > 0) &&
    element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
  const visible = elements.filter(shows);
  if (elements.length === 0) return { blockers: ["absent"] };
  if (visible.length === 0) return { blockers: ["hidden"] };
  if (visible.length > 1) return { blockers: ["ambiguous"], visible: visible.length };
  const element = visible[0];
  const blockers = [];
  const details = {};
  if (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true" || element.closest("[inert]") !== null)
    blockers.push("disabled");
  if (spec.editable && (element.readOnly === true || element.getAttribute("aria-readonly") === "true")) blockers.push("read-only");
  if (element.closest('[aria-busy="true"]') !== null) blockers.push("busy");
  else {
    const sign = [...element.querySelectorAll(spec.signs)].find(shows);
    if (sign !== undefined) blockers.push("busy");
  }
  const rect = element.getBoundingClientRect();
  const box = [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value * 10) / 10).join(",");
  // What a click at the control's centre would hit, through open shadow roots. A control whose
  // centre is outside the viewport is scrolled to before a click, so it is not judged here.
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  if (x >= 0 && y >= 0 && x < innerWidth && y < innerHeight) {
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (inner === null || inner === hit) break;
      hit = inner;
    }
    const labels = [...(element.labels ?? [])];
    const reaches = hit !== null && (element.contains(hit) || labels.some((label) => label.contains(hit)) ||
      (hit.getRootNode() instanceof ShadowRoot && element.contains(hit.getRootNode().host)));
    if (!reaches) {
      blockers.push("covered");
      details.covered = hit === null ? "nothing"
        : hit.localName + (hit.id ? "#" + hit.id : "") +
          [...hit.classList].slice(0, 2).map((name) => "." + name).join("") +
          (hit.getAttribute("role") ? '[role="' + hit.getAttribute("role") + '"]' : "");
    }
  }
  return { blockers, box, details };
};
// Whether a section toggle shows its section collapsed: aria-expanded="false", or the summary of a
// closed details element; null when it says neither, and then it is never clicked.
const readyWaitCollapsed = (toggle) =>
  toggle.evaluate((element) => {
    const expanded = element.getAttribute("aria-expanded");
    if (expanded !== null) return expanded === "false";
    const details = element.closest("details");
    return details !== null && element.localName === "summary" ? !details.open : null;
  });
const readyWaitLateMs = 500;
const readyWaitFailure = (reason, message, details) =>
  Object.assign(new Error(reason + message), { name: "ReadyWaitFailure", reason, ...details });
const readyWaitSaid = (blockers, details, visible) =>
  blockers.length === 0 ? "ready but not yet holding"
    : blockers.map((blocker) =>
      blocker === "absent" ? "no element matches"
        : blocker === "hidden" ? "no match is visible"
        : blocker === "ambiguous" ? (visible ?? 2) + " visible elements match"
        : blocker === "covered" ? "covered by " + (details?.covered ?? "another element")
        : blocker === "overlay" ? "an overlay you named shows"
        : blocker === "collapsed" ? "its section is collapsed"
        : blocker === "pending" ? "the page reports requests pending"
        : blocker === "until" ? "until() is not yet true"
        : blocker === "moving" ? "it is still moving"
        : "it is " + blocker).join(", ");
const waitForReady = async (target, options = {}) => {
  if (target === null || typeof target !== "object" || typeof target.evaluateAll !== "function")
    throw new TypeError("waitForReady needs the control's Playwright locator");
  const overlays = options.overlays === undefined ? [] : [options.overlays].flat();
  const dismiss = options.dismiss === undefined ? [] : [options.dismiss].flat();
  const timeout = options.timeout ?? waitLimits.answerCap;
  const noProgressMs = options.noProgressMs ?? waitLimits.answer;
  const holdMs = options.stableMs ?? waitLimits.settle;
  const dismissLimit = options.dismissLimit ?? 5;
  const loading = overlays.length === 0 ? options.loading
    : overlays.slice(1).reduce((all, overlay) => all.or(overlay), overlays[0]);
  const progress = waitProgress({ ...options, loading, noProgressMs });
  const spec = { editable: options.editable === true, signs: waitLoadingSigns + ", " + waitLoadingClasses };
  const waitedFor = new Set();
  let looks = 0;
  let dismissed = 0;
  let expanded = false;
  let expandTried = false;
  const begun = Date.now();
  const finish = (fields, summary) =>
    waitRecord({
      wait: "waitForReady",
      ...fields,
      elapsedMs: Date.now() - begun,
      looks,
      progress: progress.describe(),
      summary: "waitForReady: " + summary + "; " + progress.describe(),
    });
  // A panel that opens on its own, such as a tour or a what's-new dialog, may open after the wait
  // returns: from then on Playwright closes it before each action on the page, up to dismissLimit
  // times, until release(). During the wait the wait closes it itself.
  const handlers = [];
  const watch = async () => {
    if (options.watch === false || typeof page.addLocatorHandler !== "function") return;
    for (const close of dismiss) {
      await page.addLocatorHandler(close, async () => {
        await close.filter({ visible: true }).first().click({ timeout: waitLimits.action }).catch(() => undefined);
      }, { times: dismissLimit, noWaitAfter: true });
      handlers.push(close);
    }
  };
  const release = async () => {
    for (const close of handlers.splice(0)) await page.removeLocatorHandler(close).catch(() => undefined);
  };
  try {
    progress.begin();
    // deadline, a Date.now() time such as the call's own, bounds the wait wherever the action left it.
    const until = Math.min(begun + timeout, options.deadline ?? Infinity);
    let box;
    let readySince;
    let quietBefore = false;
    while (true) {
      looks += 1;
      // Every click and read is bounded by the deadline, with readyWaitLateMs of grace shared by
      // all of them past it: a page held up by a pending navigation reads as absent until then.
      const left = () => Math.max(1, until + readyWaitLateMs - Date.now());
      const read = async () => {
        // Close what opened on its own first: it may be what covers the control. After a click,
        // the panel gets a moment to close before it is clicked again.
        for (const close of dismiss) {
          if (dismissed >= dismissLimit) break;
          const shown = close.filter({ visible: true }).first();
          if ((await close.filter({ visible: true }).count()) === 0) continue;
          dismissed += 1;
          await shown.click({ timeout: Math.min(waitLimits.action, left()) }).catch(() => undefined);
          await shown.waitFor({ state: "hidden", timeout: Math.min(1000, left()) }).catch(() => undefined);
        }
        const state = await target.evaluateAll(readyWaitInPage, spec);
        // Expand only a section that holds the control hidden, and only once, through a toggle
        // that says it is collapsed: a control already showing or not yet there is never clicked.
        if (options.expand !== undefined && !expandTried && state.blockers[0] === "hidden" &&
            (await options.expand.filter({ visible: true }).count()) > 0) {
          const toggle = options.expand.filter({ visible: true }).first();
          if ((await readyWaitCollapsed(toggle)) === true) {
            expandTried = true;
            expanded = true;
            await toggle.click({ timeout: Math.min(waitLimits.action, left()) });
            state.blockers = ["collapsed", ...state.blockers];
          }
        }
        for (const overlay of overlays)
          if ((await overlay.filter({ visible: true }).count()) > 0) {
            state.blockers.push("overlay");
            break;
          }
        if (options.pending !== undefined && (await page.evaluate(options.pending))) state.blockers.push("pending");
        if (options.until !== undefined && !(await options.until())) state.blockers.push("until");
        return state;
      };
      let state;
      try {
        const reading = read();
        reading.catch(() => undefined);
        state = (await waitBounded(reading, left())) ?? { blockers: ["absent"] };
      } catch (error) {
        if (!waitContextLost(error)) throw error;
        state = { blockers: ["absent"] };
      }
      const now = Date.now();
      if (state.box !== undefined && box !== undefined && state.box !== box) state.blockers.push("moving");
      box = state.box;
      for (const blocker of state.blockers) waitedFor.add(blocker);
      if (state.blockers.length > 0) readySince = undefined;
      else readySince ??= now;
      const sampling = progress.sample(state.blockers.includes("moving") ? ["control moving"] : []);
      sampling.catch(() => undefined);
      await waitBounded(sampling, left());
      // Ready once nothing holds it back on two looks with the same box. After anything held it
      // back, or a panel was closed, that must hold for stableMs too, so a spinner that flickers off
      // for a moment does not count as gone.
      if (readySince !== undefined && looks >= 2 && ((waitedFor.size === 0 && dismissed === 0) || now - readySince >= holdMs)) {
        const result = {
          afterMs: now - begun,
          looks,
          waitedFor: [...waitedFor],
          dismissed,
          expanded,
        };
        finish({ outcome: "ready" }, "ready after " + result.afterMs + " ms (" + looks + " looks)" +
          (result.waitedFor.length > 0 ? ", waited for: " + result.waitedFor.join(", ") : ""));
        await watch();
        return Object.defineProperty(result, "release", { value: release, enumerable: false });
      }
      const said = readyWaitSaid(state.blockers, state.details, state.visible);
      const reasonOf = (fallback) => (state.blockers[0] === "ambiguous" ? "ready_ambiguous" : fallback);
      if (now >= until) {
        const reason = reasonOf("ready_timeout");
        const failure = readyWaitFailure(reason, " after " + Math.round(Math.max(0, until - begun)) + " ms: " + said + "; " + progress.describe(),
          { blockers: state.blockers, progress: progress.diagnostics() });
        finish({ reason }, failure.message);
        throw failure;
      }
      const quiet = readySince === undefined && progress.quietMs() >= noProgressMs;
      if (quiet && !quietBefore) quietBefore = true;
      else if (quiet) {
        const reason = reasonOf("not_ready");
        const failure = readyWaitFailure(reason, " after " + (now - begun) + " ms, " + Math.round(noProgressMs) +
          " ms without progress: " + said + "; " + progress.describe(), { blockers: state.blockers, progress: progress.diagnostics() });
        finish({ reason }, failure.message);
        throw failure;
      } else quietBefore = false;
      await waitSleep(readySince === undefined ? 100 : 50);
    }
  } finally {
    await progress.stop();
  }
};
`;
