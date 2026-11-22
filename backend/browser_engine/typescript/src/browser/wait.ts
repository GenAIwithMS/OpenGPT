import { timeoutDefaults } from "../runtime/deadline.js";
import { outcomeKindsCode, readyWaitCode } from "./action-waits.js";

/**
 * What one outcome's locator matched at the last look: all its matches and the visible ones, and
 * after an `action`, how many visible ones are new or changed since before it.
 */
export interface OutcomeObservation {
  readonly count: number;
  readonly visible: number;
  readonly changed?: number;
}

/** When a progress sign was first and last seen, in milliseconds from the wait's start. */
export interface WaitProgressSign {
  readonly first: number;
  readonly last: number;
}

/**
 * What a wait saw of the page's progress: each kind of sign and when, how long ago the last one
 * was, the page's own requests still in flight, and how many repeating requests it ignored.
 */
export interface WaitProgress {
  readonly signs: Readonly<Record<string, WaitProgressSign>>;
  readonly quietSinceMs: number;
  readonly inflight: number;
  readonly ignoredRepeats: number;
}

/** One entry of `waitReport()`: a wait this call ran and how it ended, in words and numbers. */
export interface WaitRecord {
  readonly wait: "waitForOutcome" | "waitForRows" | "waitForValues" | "waitForChange" | "waitForReady";
  readonly outcome?: string;
  readonly reason?: string;
  readonly elapsedMs: number;
  readonly looks: number;
  readonly progress: string;
  readonly summary: string;
}

/**
 * `confirmCommit`'s answer (`confirmCommitCode`): whether the write's final commit went through
 * (`done`), did not (`not_done`) or can't be told from the response and the page (`unclear`); its
 * status in the core notation, `queued` with the site's own word in `status_label` when the site
 * took the work to finish later; and a sentence saying what decided it.
 */
export interface CommitConfirmation {
  readonly state: "done" | "not_done" | "unclear";
  readonly status: "completed" | "queued" | "failed" | "unconfirmed";
  readonly status_label?: string;
  readonly reason: string;
}

/**
 * The page-progress tracker every wait shares. A wait keeps going while the page shows progress
 * and fails once it has shown none for `noProgressMs`. Progress is any of:
 *
 * - the author's `loading` locator showing (for as long as it shows);
 * - a generic loading sign, within `region` when one is named, coming, going, or new: a busy
 *   region, an indeterminate progress bar, or a skeleton, shimmer, spinner or loader class (never
 *   on a form control) counts while it shows until it has held for `noProgressMs`. Determinate
 *   bars (ratings, steps, meters) never count, and signs showing before the action in the same
 *   number, or class hints already there at the first look, are the page's own decoration. One
 *   page call counts them at each look; a sign element in content the browser skips rendering
 *   does not show, and a look whose count runs out of time takes the class hints as unchanged.
 *   `waitForRows` also counts a sign beside its rows (in their container or the element around
 *   it, never inside a row, and only when it is visible): one there before the action, in the
 *   same number, is the page's own; any other counts while it shows, until it and the rows have
 *   held for `noProgressMs` with no request the action started in flight;
 * - DOM changes inside the author's `region` (never the whole page: carousels and ads never stop);
 * - one of the site's own `document`, `xhr` or `fetch` requests in flight (the site is
 *   `siteDomain`, else a conservative guess from the page's host). A request the action started
 *   counts until it ends, up to `lateFillCap`, and the page then gets `unchangedMs` to render its
 *   answer; any other counts for 10 s and keeps the page busy for 4 s, since long-polls and
 *   streams stay open. Beacons, images, fonts and media never count, and a request repeated with
 *   the same method, URL and body (numbers aside) at a steady interval is a poll and is ignored;
 * - the page's URL changing, or the page being replaced;
 * - the wait's own reads changing: an outcome's matches, rows or values filling or changing.
 *
 * Network activity alone never proves the content is coming; it only keeps a wait alive.
 */
const progressCode = String.raw`
const waitLimits = Object.freeze(${JSON.stringify({
  navigation: timeoutDefaults.navigation,
  action: timeoutDefaults.action,
  answer: timeoutDefaults.answer,
  answerCap: timeoutDefaults.answerCap,
  settle: timeoutDefaults.settle,
  unchanged: timeoutDefaults.unchanged,
  lateFillCap: timeoutDefaults.lateFillCap,
})});
const waitRecords = [];
// Every wait this call ran, oldest first, each with a sentence saying how it ended.
const waitReport = () => waitRecords.map((record) => ({ ...record }));
const waitSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A promise, or fallback once ms have passed without it settling; its timer never outlives it.
const waitBounded = (promise, ms, fallback = undefined) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), Math.max(0, ms));
    }),
  ]).finally(() => clearTimeout(timer));
};
const waitSeconds = (ms) => (Math.max(0, ms) / 1000).toFixed(1) + " s";
const waitContextLost = (error) =>
  /Execution context was destroyed|Frame was detached/.test(String(error?.message));
// Generic loading signs. A busy region or an indeterminate progress bar says the page is loading;
// a determinate bar (one with a value) is a rating, a step or a meter. A class that names a
// skeleton, shimmer, spinner or loader is only a hint, and never on a form control.
const waitLoadingSigns = '[aria-busy="true"], [role="progressbar"]:not([aria-valuenow], [aria-valuetext])';
const waitLoadingClasses =
  ':is([class*="skeleton" i], [class*="shimmer" i], [class*="spinner" i], [class*="loader" i]):not(input, select, textarea, button, option, [role="progressbar"])';
// How long one look's sign count may run in the page, which runs one call at a time, before it
// leaves the class hints uncounted.
const waitClassesBudgetMs = 250;
// Runs in the page, as page.evaluate(spec) or region.evaluateAll(elements, spec): how many generic
// loading signs and class hints show in the document or the region's elements, through open
// shadow roots, in one call, since a locator's count can cost a protocol call for each element it
// matches. A sign shows as a visible locator match does: rendered, not hidden by visibility, with
// a box, or for display: contents, a child element or text that shows. An element in content the
// browser skips rendering (content-visibility) does not show, and its box is never read: reading
// it would lay that content out, one element at a time. A display: contents sign is judged by its
// children even there, its text by a range's box, as the visible check judges it. A closed shadow
// root is out of page code's reach, so a sign inside one, which a Patchright locator could count,
// is not counted. Class hints left uncounted after the budget are null.
const waitSignsInPage = (first, second) => {
  const [roots, spec] = second === undefined ? [[document], first] : [first, second];
  const started = performance.now();
  const scopes = new Set(roots);
  for (const scope of scopes) {
    if (scope.shadowRoot) scopes.add(scope.shadowRoot);
    for (const node of scope.querySelectorAll("*")) if (node.shadowRoot) scopes.add(node.shadowRoot);
  }
  const boxed = (box) => box.width > 0 && box.height > 0;
  const textShows = (text) => {
    const range = text.ownerDocument.createRange();
    range.selectNode(text);
    return boxed(range.getBoundingClientRect());
  };
  const shows = (element) => {
    const rendered = typeof element.checkVisibility !== "function" ||
      element.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
    // Without a box: display: contents shows when a child element or text does; hidden or skipped
    // content does not.
    if (!rendered)
      return !element.checkVisibility() && getComputedStyle(element).display === "contents" &&
        [...element.childNodes].some((child) =>
          child.nodeType === Node.ELEMENT_NODE ? shows(child) : child.nodeType === Node.TEXT_NODE && textShows(child));
    return boxed(element.getBoundingClientRect());
  };
  const count = (selector, budgetMs) => {
    const seen = new Set();
    let shown = 0;
    for (const scope of scopes)
      for (const element of scope.querySelectorAll(selector)) {
        if (seen.has(element)) continue;
        seen.add(element);
        if (shows(element)) shown += 1;
        if (performance.now() - started > budgetMs) return null;
      }
    return shown;
  };
  return { signs: count(spec.signs, Infinity), classes: count(spec.classes, spec.budgetMs) };
};
const waitSignsSpec = { signs: waitLoadingSigns, classes: waitLoadingClasses, budgetMs: waitClassesBudgetMs };
// A request the wait's action started, while it ran or in the second after, is the answer on its
// way: it counts as progress and keeps the page busy until it ends, up to
// lateFillCap. Any other request counts as progress for up to 10 s, and keeps the page busy for up
// to 4 s (or the no-progress window when shorter): a long-poll or a stream stays open with nothing
// to come, and starts on its own.
const waitCausedMs = 1000;
const waitInflightMs = 10000;
const waitBusyRequestMs = 4000;
// The site's registrable domain, when the code gave none: the last two labels of the page's host,
// or three under a country's shared second level (example.co.uk, never co.uk). Pass the context's
// siteDomain, which the host computed with the public suffix list, to be exact.
const waitSiteDomain = (host) => {
  const labels = host.split(".");
  if (labels.length <= 2 || /^\d+$/.test(labels.at(-1))) return host;
  const shared = labels.at(-1).length === 2 &&
    /^(?:ac|co|com|edu|gen|go|gob|gov|gv|in|ind|info|int|lg|ltd|me|mil|ne|net|nhs|nic|nom|or|org|plc|sch|web)$/.test(labels.at(-2));
  return labels.slice(shared ? -3 : -2).join(".");
};
// What makes two requests the same one again: method, path, query and body, with every number
// (counters, timestamps, cache busters) read as the same.
const waitRequestKey = (request) => {
  const url = new URL(request.url());
  const body = String(request.postData() ?? "").slice(0, 4096).replace(/\d+/g, "#");
  let hash = 2166136261;
  for (let i = 0; i < body.length; i += 1) hash = Math.imul(hash ^ body.charCodeAt(i), 16777619);
  return request.method() + " " + url.origin + url.pathname + url.search.replace(/\d+/g, "#") + " " + (hash >>> 0).toString(36);
};
const waitProgress = (options = {}) => {
  const noProgressMs = options.noProgressMs ?? waitLimits.answer;
  const key = "opengpt.waitProgress." + Date.now() + "." + Math.random();
  let started = Date.now();
  // Requests that start before this are the action's: from the baseline look, taken just before
  // the action, to a second after it returned. A wait without an action causes none.
  let causedUntil = -Infinity;
  let acted = false;
  let lastProgress = started;
  let signs = {};
  const mark = (kind, at = Date.now()) => {
    const sign = (signs[kind] ??= { first: at - started, last: at - started });
    sign.last = at - started;
    if (at > lastProgress) lastProgress = at;
  };
  const sameSite = (url) => {
    try {
      const host = new URL(url).hostname;
      const domain = options.siteDomain ?? waitSiteDomain(new URL(page.url()).hostname);
      return domain !== "" && (host === domain || host.endsWith("." + domain));
    } catch {
      return false;
    }
  };
  // The site's requests in flight, by request: when each started and what makes it the same again.
  const pending = new Map();
  const starts = new Map();
  const polls = new Set();
  let ignoredRepeats = 0;
  const onRequest = (request) => {
    if (!["document", "xhr", "fetch"].includes(request.resourceType()) || !sameSite(request.url())) return;
    const key = waitRequestKey(request);
    const now = Date.now();
    // A poll repeats the same request at a steady interval: from its third start, once two
    // intervals of at least 50 ms agree within half, it is ignored with every copy in flight.
    // Requests to one path that differ, such as an API's different queries, never are.
    const times = [...(starts.get(key) ?? []), now].slice(-3);
    starts.set(key, times);
    if (!polls.has(key) && times.length === 3) {
      const [first, second] = [times[1] - times[0], times[2] - times[1]];
      if (Math.min(first, second) >= 50 && Math.abs(first - second) <= Math.max(first, second) / 2) {
        polls.add(key);
        for (const [other, entry] of pending) if (entry.key === key) pending.delete(other);
      }
    }
    if (polls.has(key)) {
      ignoredRepeats += 1;
      return;
    }
    pending.set(request, { at: now, key, caused: now <= causedUntil });
    mark("site request");
  };
  // When the action's last request ended: the page then gets unchangedMs to render its answer.
  let causedEnded = -Infinity;
  const onDone = (request) => {
    const entry = pending.get(request);
    if (entry === undefined) return;
    pending.delete(request);
    if (entry.caused) causedEnded = Date.now();
    mark("site request");
  };
  page.on("request", onRequest);
  page.on("requestfinished", onDone);
  page.on("requestfailed", onDone);
  let url = page.url();
  // Generic signs, each kind with its count before the action (or, for class hints, at the first
  // look), its count at the last look and when that last changed. A sign counts while it shows
  // more than before, until its count has held for the no-progress window. A sign that stays is
  // part of the page. (waitForRows also judges the signs beside its rows: see listSigns.)
  const generic = {
    signs: { holdMs: noProgressMs, before: undefined, count: 0, changedAt: started, shows: false },
    classes: { holdMs: noProgressMs, before: undefined, count: 0, changedAt: started, shows: false, firstLook: true },
  };
  let loadingShows = false;
  let region = { count: 0, targets: 0 };
  // One look at the page's signs. The baseline look, taken before the action, notes them without
  // counting anything as progress.
  // Quiet time runs to the latest look that could see progress: the first look after the start
  // only installs the region's observer and notes the signs.
  let samples = 0;
  let sampledAt = started;
  const sample = async (changes = [], baseline = false) => {
    const now = Date.now();
    samples += 1;
    sampledAt = now;
    const note = (kind) => {
      if (!baseline) mark(kind, now);
    };
    for (const kind of changes) note(kind);
    if (page.url() !== url) {
      url = page.url();
      note("URL change");
    }
    for (const { at, caused } of pending.values())
      if (now - at < (caused ? waitLimits.lateFillCap : waitInflightMs)) {
        note("site request");
        break;
      }
    try {
      loadingShows = options.loading !== undefined && (await options.loading.filter({ visible: true }).count()) > 0;
      if (loadingShows) note("loading sign");
      // A generic sign counts when it comes or goes, and while it is new: see generic above. Both
      // kinds are counted in one page call; class hints left uncounted are no news at this look.
      const counted = await (options.region === undefined
        ? page.evaluate(waitSignsInPage, waitSignsSpec)
        : options.region.evaluateAll(waitSignsInPage, waitSignsSpec));
      for (const [name, sign] of Object.entries(generic)) {
        // A count left undone is no news: the last count stands, so a sign showing keeps its
        // hold, and a baseline or first look notes nothing.
        const fresh = counted[name];
        if (fresh === null && (baseline || (sign.firstLook && sign.before === undefined))) continue;
        const count = fresh ?? sign.count;
        if (baseline || (sign.firstLook && sign.before === undefined)) {
          sign.before = count;
          sign.changedAt = now;
        } else {
          if (count !== sign.count) {
            sign.changedAt = now;
            note("loading sign");
          }
          sign.shows = count > (sign.before ?? 0) && now - sign.changedAt < sign.holdMs;
          if (sign.shows) note("loading sign");
        }
        sign.count = count;
      }
      if (options.region !== undefined) {
        const seen = await options.region.evaluateAll((elements, key) => {
          const state = (globalThis[Symbol.for(key)] ??= { count: 0, targets: new Set() });
          state.observer ??= new MutationObserver((records) => {
            state.count += records.length;
          });
          for (const element of elements)
            if (!state.targets.has(element)) {
              state.targets.add(element);
              state.observer.observe(element, {
                subtree: true,
                childList: true,
                characterData: true,
                attributes: true,
                attributeFilter: ["class", "hidden", "aria-busy", "aria-hidden", "src", "value", "disabled"],
              });
            }
          return { count: state.count, targets: state.targets.size };
        }, key);
        // The first look only installs the observer; a region that appears later is progress.
        if (seen.count !== region.count || (seen.targets !== region.targets && region.targets !== 0))
          note("region changes");
        region = seen;
      }
    } catch (error) {
      if (!waitContextLost(error)) throw error;
      note("page replaced");
    }
  };
  return {
    // Before the action: what already shows is the page from before it.
    baseline: () => {
      acted = true;
      causedUntil = Infinity;
      return sample([], true);
    },
    // The budgets start once the action returns; requests it started stay in flight.
    begin: () => {
      started = Date.now();
      causedUntil = acted ? started + waitCausedMs : -Infinity;
      lastProgress = started;
      signs = {};
      samples = 0;
    },
    // Without a baseline, a sign already showing at the first look is the page still loading.
    sample: (changes) => sample(changes),
    quietMs: () => (samples < 2 ? 0 : sampledAt - lastProgress),
    // A loading sign showing or a site request in flight, at the last look. waitForRows judges the
    // generic signs itself, beside its rows (pageSigns false).
    busy: (pageSigns = true) => {
      const now = Date.now();
      const busyRequestMs = Math.min(noProgressMs, waitBusyRequestMs);
      return loadingShows || (pageSigns && (generic.signs.shows || generic.classes.shows)) ||
        now - causedEnded < (options.unchangedMs ?? waitLimits.unchanged) ||
        [...pending.values()].some(({ at, caused }) => now - at < (caused ? waitLimits.lateFillCap : busyRequestMs));
    },
    // A request the action started still in flight.
    causedInflight: () => {
      const now = Date.now();
      return [...pending.values()].some(({ at, caused }) => caused && now - at < waitLimits.lateFillCap);
    },
    diagnostics: () => ({
      signs: Object.fromEntries(Object.entries(signs).map(([kind, sign]) => [kind, { ...sign }])),
      quietSinceMs: lastProgress - started,
      inflight: pending.size,
      ignoredRepeats,
    }),
    describe: () => {
      const entries = Object.entries(signs);
      const seen = entries.length === 0
        ? "no progress seen"
        : "progress seen: " +
          entries
            .map(([kind, { first, last }]) =>
              kind + " " + (last > first ? waitSeconds(first) + "–" + waitSeconds(last) : "at " + waitSeconds(first)))
            .join(", ") +
          "; last progress at " + waitSeconds(lastProgress - started);
      return seen + (ignoredRepeats > 0 ? "; ignored " + ignoredRepeats + " repeating requests" : "");
    },
    stop: async (inPage = true) => {
      page.off("request", onRequest);
      page.off("requestfinished", onDone);
      page.off("requestfailed", onDone);
      if (inPage && options.region !== undefined) {
        const cleanup = options.region
          .evaluateAll((elements, key) => {
            globalThis[Symbol.for(key)]?.observer?.disconnect();
            delete globalThis[Symbol.for(key)];
          }, key)
          .catch(() => undefined);
        let timer;
        await Promise.race([cleanup, new Promise((resolve) => { timer = setTimeout(resolve, 250); })]);
        clearTimeout(timer);
      }
    },
  };
};
const waitRecord = (record) => {
  waitRecords.push(record);
  return record;
};
`;

/**
 * `waitForOutcome`, unchanged in what it decides, now with a progress budget: it fails as
 * `outcome_unknown` once the page shows no outcome and no progress for `noProgressMs`.
 */
const outcomeCode = String.raw`
const outcomeWaitSeen = (observations) =>
  Object.entries(observations)
    .map(([name, observation]) => {
      const { kind, count, visible, changed, matched, invalid, seen } = observation;
      if (kind === undefined || kind === "gone")
        return name + (kind === "gone" ? " (gone) " : " ") + visible + " visible of " + count +
          (changed === 0 && visible > 0 ? ", unchanged" : "");
      if (kind === "invalid") return name + " " + invalid + " invalid fields";
      if (kind === "url") return name + (matched ? " URL matched" : " URL not matched");
      if (kind === "check") return name + (matched ? " check true" : " check not true");
      if (kind === "announced") return name + (matched ? " announced" : " no matching announcement of " + seen + " seen");
      return name + (matched ? " " + kind + " matched" : " no matching " + kind + " of " + seen + " seen");
    })
    .join(", ");
const outcomeWaitFailure = (reason, message, observations, extra) =>
  Object.assign(new Error(reason + message), {
    name: "OutcomeWaitFailure",
    reason,
    observations,
    ...extra,
  });
// What each visible element showed before the action, kept in the page by a key of this wait's
// own; a page the action replaced has none, so everything on it is new.
const outcomeWaitNote = (locator, key) =>
  locator.filter({ visible: true }).evaluateAll((elements, key) => {
    const noted = (globalThis[Symbol.for(key)] ??= new WeakMap());
    for (const element of elements) noted.set(element, element.innerText);
  }, key);
const outcomeWaitChanged = (locator, key) =>
  locator.filter({ visible: true }).evaluateAll((elements, key) => {
    const noted = globalThis[Symbol.for(key)];
    return elements.filter((element) => noted?.get(element) !== element.innerText).length;
  }, key);
// Reads the outcomes highest priority last, so a look that sees one also sees a higher one drawn
// in the same render. The observations keep the listed order.
const outcomeWaitObserve = async (outcomes, key, state, events) => {
  const candidates = Array.isArray(outcomes) ? outcomes
    : Object.entries(outcomes).map(([name, locator]) => ({ name, kind: "locator", locator }));
  const observations = {};
  for (const candidate of [...candidates].reverse())
    observations[candidate.name] = await outcomeWaitRead(candidate, state, key, events);
  return Object.fromEntries(candidates.map(({ name }) => [name, observations[name]]));
};
// How long a look the page holds up may still finish once a response or popup outcome arrived, and
// once the deadline passed.
const outcomeWaitGraceMs = 1000;
const outcomeWaitLateMs = 500;
const waitForOutcomeResult = async (outcomes, options = {}) => {
  const names = Object.keys(outcomes ?? {});
  if (names.length === 0) throw new TypeError("waitForOutcome needs at least one outcome");
  const candidates = names.map((name) => outcomeWaitCandidate(name, outcomes[name]));
  const timeout = options.timeout ?? waitLimits.answerCap;
  const noProgressMs = options.noProgressMs ?? waitLimits.answer;
  const progress = waitProgress({ ...options, noProgressMs });
  const events = outcomeWaitEvents(candidates);
  const state = {
    goneSeen: new Set(),
    goneSince: new Map(),
    invalidFields: new Map(),
    invalidBefore: new Map(),
    checked: new Map(),
    announcedText: new Map(),
    announceKey: candidates.some((candidate) => candidate.kind === "announced")
      ? "opengpt.outcomeAnnounce." + Date.now() + "." + Math.random() : undefined,
    urlBefore: undefined,
    actedAt: -Infinity,
  };
  let looks = 0;
  const finish = (fields, summary) =>
    waitRecord({
      wait: "waitForOutcome",
      ...fields,
      elapsedMs: Date.now() - begun,
      looks,
      progress: progress.describe(),
      summary: "waitForOutcome: " + summary + "; " + progress.describe(),
    });
  let begun = Date.now();
  let key;
  // How long the cleanup may take: 250 ms, and nothing past the wait's hard stop.
  let cleanupMs = () => 250;
  try {
    if (options.action !== undefined) {
      key = "opengpt.outcomeWait." + Date.now() + "." + Math.random();
      for (const candidate of candidates) {
        if (candidate.kind === "locator") await outcomeWaitNote(candidate.locator, key);
        if (candidate.kind === "gone" && (await candidate.locator.filter({ visible: true }).count()) > 0)
          state.goneSeen.add(candidate.name);
        if (candidate.kind === "invalid")
          state.invalidBefore.set(candidate.name, outcomeWaitInvalidKey(await candidate.locator.evaluateAll(outcomeWaitInvalidInPage)));
      }
      state.urlBefore = page.url();
      if (state.announceKey !== undefined) await page.evaluate(outcomeWaitAnnounceInPage, { key: state.announceKey, seed: false });
      await progress.baseline();
      state.actedAt = Date.now();
      // A click whose handler opens a native dialog does not return until the dialog is handled,
      // and the wait's dialog listener keeps Playwright from dismissing it: with a dialog outcome,
      // the wait goes on once the action returns or a dialog opens.
      if (candidates.some((candidate) => candidate.kind === "dialog")) {
        const acting = Promise.resolve().then(() => options.action());
        acting.catch(() => undefined);
        const first = await Promise.race([acting.then(() => "acted"), events.dialogSignal.then(() => "dialog")]);
        if (first === "acted") await acting;
      } else await options.action();
    }
    progress.begin();
    begun = Date.now();
    // deadline, a Date.now() time such as the call's own, bounds the wait wherever the action left it.
    const until = Math.min(begun + timeout, options.deadline ?? Infinity);
    // Past the deadline, every page call shares outcomeWaitLateMs of grace and then ends: the wait
    // never outlasts hardStop, however long the page holds it.
    const hardStop = until + outcomeWaitLateMs;
    const beforeStop = () => Math.max(0, hardStop - Date.now());
    cleanupMs = () => Math.min(250, beforeStop());
    const unchangedMs = options.unchangedMs ?? waitLimits.unchanged;
    const unchangedFrom = begun + unchangedMs;
    // A page or frame the action is replacing can drop a look midway; the next look sees the new one.
    // The page cannot always be read: a native dialog stops its scripts, and while a navigation
    // is pending Playwright cannot evaluate in it. A look the page holds up ends at the deadline
    // (with outcomeWaitLateMs of grace, so a look begun just before it finishes), at once for a dialog,
    // and outcomeWaitGraceMs after a response or popup outcome arrived, which then decides on the
    // outcomes the page announced as events.
    const unblocked = (reading) => {
      reading.catch(() => undefined);
      const bounded = waitBounded(reading, beforeStop());
      if (!candidates.some((candidate) => ["response", "dialog", "popup"].includes(candidate.kind))) return bounded;
      return Promise.race([
        bounded,
        events.dialogSignal.then(() => undefined),
        events.hitSignal.then(() => waitBounded(reading, Math.min(outcomeWaitGraceMs, beforeStop()))),
      ]);
    };
    const look = () =>
      unblocked(outcomeWaitObserve(candidates, key, state, events).catch((error) => {
        if (waitContextLost(error)) return undefined;
        throw error;
      }));
    const result = (candidate, observations, evidence) => {
      const handles = events.hit(candidate.name)?.handles ?? {};
      const answer = {
        outcome: candidate.name,
        kind: candidate.kind,
        afterMs: Date.now() - begun,
        looks,
        evidence,
        observations,
      };
      for (const [name, value] of Object.entries(handles)) outcomeWaitHidden(answer, name, value);
      // A dialog that opened while the wait listened stays open whichever outcome won.
      if (answer.dialog === undefined) outcomeWaitHidden(answer, "dialog", events.dialog());
      finish(
        { outcome: candidate.name },
        '"' + candidate.name + '"' + (candidate.kind === "locator" ? "" : " (" + candidate.kind + ")") + " showed after " +
          answer.afterMs + " ms (" + looks + (looks === 1 ? " look)" : " looks)"),
      );
      return answer;
    };
    // The first look that shows an outcome decides: no second look confirms it. An answer from
    // before the action is kept out of that look by the stale rule below, not by a second look.
    let last;
    let signature;
    let quietBefore = false;
    while (true) {
      // A request the action started that was in flight as the look began counts as in flight for
      // that look's matches, even when it ends while the look runs.
      const inflightAtStart = progress.causedInflight();
      const observations = await look();
      events.rethrow();
      looks += 1;
      last = observations ?? last;
      // A match from before the action stays stale while a request the action started is in flight,
      // but only until the deadline less the unchanged window, so a match the wait returned before
      // such requests held it back still returns in time. One clock read serves this and the
      // deadline below, so the hold never outlasts the deadline even with no unchanged window.
      const now = Date.now();
      const stale = now < unchangedFrom ||
        (now < until - unchangedMs && (inflightAtStart || progress.causedInflight()));
      // With the page unreadable, only the outcomes the page announced as events decide, in the
      // listed order.
      const blocked = events.dialogOpen() || (observations === undefined && events.anyHit());
      const shown = candidates.find((candidate) =>
        blocked ? ["response", "dialog", "popup"].includes(candidate.kind) && events.hit(candidate.name) !== undefined
          : outcomeWaitShows(candidate, observations?.[candidate.name], state, stale, now));
      if (shown !== undefined) {
        const observation = observations?.[shown.name];
        if (shown.kind === "locator" && observation.count > 1) {
          const failure = outcomeWaitFailure("outcome_ambiguous", ": " + outcomeWaitSeen(observations), observations, {
            outcome: shown.name,
          });
          finish({ reason: "outcome_ambiguous", outcome: shown.name }, failure.message);
          throw failure;
        }
        const evidence = await waitBounded(
          outcomeWaitEvidence(shown, observation, state, events, now),
          Math.max(250, until - Date.now()),
          {},
        );
        return result(shown, observations ?? last ?? {}, evidence);
      }
      if (events.unnamedDialog() !== undefined) {
        const opened = events.unnamedDialog();
        const failure = outcomeWaitFailure(
          "outcome_unknown",
          " after " + (now - begun) + " ms: a native " + opened.type() + " dialog opened that no outcome names",
          last ?? {},
          {},
        );
        outcomeWaitHidden(failure, "dialog", opened);
        finish({ reason: "outcome_unknown" }, failure.message);
        throw failure;
      }
      // Only a look that decides nothing samples the page's progress: the decision never uses it.
      const current = JSON.stringify(observations ?? null);
      await unblocked(progress.sample(
        observations === undefined ? ["page replaced"]
          : signature !== undefined && current !== signature ? ["outcome matches changing"] : [],
      ));
      // An outcome the page announced as an event during the sample decides at the next look.
      if (events.dialogOpen() || events.anyHit()) continue;
      signature = current;
      if (now >= until) {
        const seen = last ?? (beforeStop() > 0 ? await look().catch(() => undefined) : undefined) ?? {};
        const failure = outcomeWaitFailure(
          "outcome_timeout",
          " after " + Math.round(Math.max(0, until - begun)) + " ms: " +
            (Object.keys(seen).length === 0 ? "the page could not be read" : outcomeWaitSeen(seen)) + "; " + progress.describe(),
          seen,
          { progress: progress.diagnostics() },
        );
        finish({ reason: "outcome_timeout" }, failure.message);
        throw failure;
      }
      // Nothing shows, not even an answer from before the action, and the page went quiet.
      // A quiet page fails only when the next look agrees, since the page may have answered
      // between this look's outcomes and its progress sample.
      const anyShown = candidates.some((candidate) => outcomeWaitShowsAny(candidate, observations?.[candidate.name]));
      const quiet = !anyShown && progress.quietMs() >= noProgressMs;
      if (quiet && !quietBefore) quietBefore = true;
      else if (quiet) {
        const seen = last ?? {};
        const failure = outcomeWaitFailure(
          "outcome_unknown",
          " after " + (Date.now() - begun) + " ms, " + Math.round(noProgressMs) + " ms without progress, no outcome showing: " +
            outcomeWaitSeen(seen) + "; " + progress.describe(),
          seen,
          { progress: progress.diagnostics() },
        );
        finish({ reason: "outcome_unknown" }, failure.message);
        throw failure;
      } else quietBefore = false;
      await waitSleep(100);
    }
  } catch (error) {
    // A dialog that opened while the wait listened stays open: the failure carries it too.
    if (error !== null && typeof error === "object" && error.dialog === undefined) outcomeWaitHidden(error, "dialog", events.dialog());
    throw error;
  } finally {
    events.stop();
    // With a native dialog open the page cannot run the cleanup; what it leaves is inert.
    const inPage = !events.dialogOpen();
    // A page held up by a pending navigation gets a moment; what it keeps is inert.
    for (const each of [key, state.announceKey])
      if (each !== undefined && inPage)
        await waitBounded(
          page.evaluate((key) => {
            globalThis[Symbol.for(key)]?.observer?.disconnect?.();
            delete globalThis[Symbol.for(key)];
          }, each),
          cleanupMs(),
        ).catch(() => undefined);
    await progress.stop(inPage && cleanupMs() > 0);
  }
};
const waitForOutcome = async (outcomes, options = {}) => (await waitForOutcomeResult(outcomes, options)).outcome;
`;

/**
 * `waitForRows`, `waitForValues` and `waitForChange`: wait for the values a tool returns to be
 * filled in and to read the same on two looks.
 */
const valueCode = String.raw`
// Runs in the page: reads each element's value, or says it is absent or still loading. A value is
// still loading when it is empty, reads as a loading word or only dots, matches the author's
// placeholder, or sits in an aria-busy, skeleton or shimmer element (up to its row).
const waitReadInPage = (elements, spec) => {
  const loadingWords = /^(?:loading|updating|calculating|fetching|searching|please wait)\b/i;
  const visible = (element) =>
    typeof element.checkVisibility === "function" ? element.checkVisibility()
      : element.getClientRects().length > 0;
  const busy = (element, stop) => {
    for (let node = element, depth = 0; node instanceof Element && depth < 8; node = node.parentElement, depth += 1) {
      if (node.getAttribute("aria-busy") === "true") return true;
      if (/skeleton|shimmer/i.test(node.getAttribute("class") ?? "")) return true;
      if (node === stop) break;
    }
    return false;
  };
  const read = (element, field, stop, identity) => {
    if (!(element instanceof Element)) return { state: "absent" };
    const raw = field.attribute ? element.getAttribute(field.attribute) : visible(element) ? element.innerText : "";
    const value = String(raw ?? "").trim();
    const placeholder = field.placeholder ? new RegExp(field.placeholder.source, field.placeholder.flags) : undefined;
    if (value === "" || loadingWords.test(value) || /^[.…\s]+$/.test(value) || placeholder?.test(value))
      return { state: "loading" };
    if (!identity && busy(element, stop)) return { state: "loading" };
    return { state: "filled", value };
  };
  // How many loading signs show beside a list's rows: in the rows' container or the element around
  // it, never inside a row. A decoration lives in its card, while a list still loading shows its
  // spinner, skeleton or busy state beside the rows. A class hint that holds rows is their layout,
  // not a sign, and a sign kept in layout but invisible (visibility or opacity) does not show.
  const shown = (element) =>
    typeof element.checkVisibility === "function"
      ? element.checkVisibility({ visibilityProperty: true, opacityProperty: true })
      : element.getClientRects().length > 0;
  const listSigns = (rows, selectors) => {
    if (rows.length === 0) return 0;
    let common = rows[0].parentElement;
    while (common !== null && !rows.every((row) => common.contains(row))) common = common.parentElement;
    if (common === null) return 0;
    const outer = common.parentElement;
    const root = outer === null || outer === document.body || outer === document.documentElement ? common : outer;
    let count = 0;
    for (const element of [root, ...root.querySelectorAll(selectors.all)])
      if (
        element.matches(selectors.all) &&
        shown(element) &&
        !rows.some((row) => row.contains(element)) &&
        (element.matches(selectors.signs) || !rows.some((row) => element.contains(row)))
      )
        count += 1;
    return count;
  };
  if (spec.mode === "rows")
    return { signs: listSigns(elements, spec.signs), rows: elements.map((row) => {
      // A row's field is its first visible match, such as the price a responsive card shows
      // beside a hidden copy. Read text whose matches are all hidden is hidden, not loading: the
      // selector names the wrong copy, or the site shows it only on another layout.
      const at = (field) => {
        if (!field.selector) return row;
        const matches = [...row.querySelectorAll(field.selector)];
        return matches.find(visible) ?? (field.attribute || matches.length === 0 ? matches[0] : "hidden");
      };
      const take = (field, identity) => {
        const element = at(field);
        return element === "hidden" ? { state: "hidden" } : read(element, field, row, identity);
      };
      const fields = {};
      for (const [name, field] of Object.entries(spec.fields)) fields[name] = take(field, false);
      return { key: take(spec.key, true), fields };
    }) };
  const field = spec.field;
  const candidates = field.attribute ? elements : elements.filter(visible);
  if (candidates.length === 0) return { state: "absent" };
  if (field.all) {
    const values = candidates.map((element) => read(element, field, undefined, false));
    return values.some((value) => value.state !== "filled") ? { state: "loading" }
      : { state: "filled", value: values.map((value) => value.value) };
  }
  if (candidates.length > 1) return { state: "ambiguous", count: candidates.length };
  return read(candidates[0], field, undefined, false);
};
// A field as the page code reads it: a CSS selector inside the row (or the row itself), or for
// waitForValues a Playwright locator, with an attribute to read instead of the text.
const waitFieldSpec = (field, where) => {
  const spec = typeof field === "string" ? { selector: field }
    : field !== null && typeof field === "object" && typeof field.evaluateAll === "function" ? { locator: field }
    : field !== null && typeof field === "object" ? field
    : undefined;
  if (spec === undefined) throw new TypeError(where + " needs a selector, a locator or { selector | locator, attribute }");
  const placeholder = spec.placeholder instanceof RegExp
    ? { source: spec.placeholder.source, flags: spec.placeholder.flags.replace("g", "") }
    : undefined;
  return {
    ...(spec.selector === undefined ? {} : { selector: spec.selector }),
    ...(spec.locator === undefined ? {} : { locator: spec.locator }),
    ...(spec.attribute === undefined ? {} : { attribute: spec.attribute }),
    ...(spec.all === true ? { all: true } : {}),
    ...(spec.optional === true ? { optional: true } : {}),
    ...(placeholder === undefined ? {} : { placeholder }),
  };
};
const valueWaitFailure = (reason, message, details) =>
  Object.assign(new Error(reason + message), { name: "ValueWaitFailure", reason, ...details });
const valueWaitRows = (list) =>
  list.length === 0 ? "" : (list.length === 1 ? " in row " : " in rows ") + list.slice(0, 10).join(", ") + (list.length > 10 ? " and " + (list.length - 10) + " more" : "");
// Runs the shared loop for a value wait: look, note progress, return once ready on two agreeing
// looks, fail once quiet or past the cap. evaluate() returns { ready, snapshot, filled, problems,
// result, settleMs }.
const valueWaitLoop = async (wait, options, evaluate, timeoutDefault) => {
  const timeout = options.timeout ?? timeoutDefault;
  const noProgressMs = options.noProgressMs ?? waitLimits.answer;
  const progress = waitProgress({ ...options, noProgressMs });
  let looks = 0;
  let begun = Date.now();
  const finish = (fields, summary) =>
    waitRecord({
      wait,
      ...fields,
      elapsedMs: Date.now() - begun,
      looks,
      progress: progress.describe(),
      summary: wait + ": " + summary + "; " + progress.describe(),
    });
  try {
    await options.prepare?.();
    if (options.action !== undefined) {
      await progress.baseline();
      await options.action();
    }
    progress.begin();
    begun = Date.now();
    const until = begun + timeout;
    let candidate;
    let candidateAt = begun;
    let filled = -1;
    let quietBefore = false;
    while (true) {
      let state;
      try {
        state = await evaluate(progress);
      } catch (error) {
        if (!waitContextLost(error)) throw error;
        state = undefined;
      }
      looks += 1;
      const changes = [];
      if (state === undefined) changes.push("page replaced");
      else if (state.signs) changes.push("loading sign");
      else if (candidate !== undefined && state.snapshot !== candidate) {
        changes.push(state.filled > filled ? "values filling" : "values changing");
      }
      await progress.sample(changes);
      const now = Date.now();
      if (state !== undefined) {
        if (state.snapshot !== candidate) {
          candidate = state.snapshot;
          candidateAt = now;
        }
        filled = state.filled;
        // Readiness that depends on progress is judged after this look's sample.
        state.ready = typeof state.ready === "function" ? state.ready() : state.ready;
        if (state.ready && now - candidateAt >= state.settleMs) {
          finish({ outcome: "ready" }, state.summary(now - begun, looks));
          return state.result;
        }
      }
      if (now >= until) {
        const problems = state?.problems ?? "the page was being replaced";
        const failure = valueWaitFailure(
          "values_timeout",
          " after " + Math.round(timeout) + " ms: " + problems + "; " + progress.describe(),
          { progress: progress.diagnostics() },
        );
        finish({ reason: "values_timeout" }, failure.message);
        throw failure;
      }
      // A quiet page fails only when the next look agrees, as in waitForOutcome.
      const quiet = progress.quietMs() >= noProgressMs && !state?.ready;
      if (quiet && !quietBefore) quietBefore = true;
      else if (quiet) {
        const reason = state?.reason ?? "values_loading";
        const failure = valueWaitFailure(
          reason,
          " after " + (now - begun) + " ms, " + Math.round(noProgressMs) + " ms without progress: " +
            (state?.problems ?? "nothing read") + "; " + progress.describe(),
          { progress: progress.diagnostics() },
        );
        finish({ reason }, failure.message);
        throw failure;
      } else quietBefore = false;
      await waitSleep(100);
    }
  } finally {
    await progress.stop();
  }
};
const waitForRows = async (rows, fields, options = {}) => {
  const count = options.count;
  if (!Number.isInteger(count) || count < 1) throw new TypeError("waitForRows needs count, the number of rows you return");
  if (options.key === undefined) throw new TypeError("waitForRows needs key, the field that identifies a row");
  const key = waitFieldSpec(options.key, "waitForRows key");
  const spec = {
    mode: "rows",
    key,
    fields: Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, waitFieldSpec(field, "waitForRows field " + name)])),
  };
  const settle = options.stableMs ?? waitLimits.settle;
  const fewSettle = Math.max(settle, options.unchangedMs ?? waitLimits.unchanged);
  spec.signs = { all: waitLoadingSigns + ", " + waitLoadingClasses, signs: waitLoadingSigns };
  const noProgressMs = options.noProgressMs ?? waitLimits.answer;
  // The signs beside the rows. Those there before the action, in the same number, are the page's
  // own. One that came after it, or that shows without an action, counts while it shows, until it
  // and the rows have held unchanged for noProgressMs with no request the action started still in
  // flight: then it is decoration too, so a sign that never leaves costs one window, never the cap.
  let signsBefore = 0;
  let signsCount;
  let signsChangedAt = 0;
  let rowsSeen;
  let rowsChangedAt = 0;
  const prepare = async () => {
    await options.prepare?.();
    if (options.action !== undefined) signsBefore = (await rows.evaluateAll(waitReadInPage, spec)).signs;
  };
  return valueWaitLoop("waitForRows", { ...options, prepare }, async (progress) => {
    const { rows: read, signs: listSigns } = await rows.evaluateAll(waitReadInPage, spec);
    const identified = read.filter((row) => row.key.state === "filled");
    const hiddenKeys = read.flatMap((row, index) => (row.key.state === "hidden" ? [index + 1] : []));
    const taken = identified.slice(0, count);
    const loading = {};
    const hidden = {};
    const missing = {};
    let filledCount = 0;
    taken.forEach((row, index) => {
      for (const [name, value] of Object.entries(row.fields)) {
        if (value.state === "filled") filledCount += 1;
        else if (value.state === "loading") (loading[name] ??= []).push(index + 1);
        else if (spec.fields[name].optional) continue;
        else if (value.state === "hidden") (hidden[name] ??= []).push(index + 1);
        else (missing[name] ??= []).push(index + 1);
      }
    });
    const problems = [
      ...Object.entries(loading).map(([name, list]) => name + " still loading" + valueWaitRows(list)),
      ...Object.entries(hidden).map(([name, list]) => name + " hidden" + valueWaitRows(list)),
      ...Object.entries(missing).map(([name, list]) => name + " missing" + valueWaitRows(list)),
    ];
    const complete = problems.length === 0;
    const few = taken.length < count;
    if (hiddenKeys.length > 0) problems.push("key hidden" + valueWaitRows(hiddenKeys));
    const now = Date.now();
    if (listSigns !== signsCount) {
      signsCount = listSigns;
      signsChangedAt = now;
    }
    const rowsNow = JSON.stringify(taken);
    if (rowsNow !== rowsSeen) {
      rowsSeen = rowsNow;
      rowsChangedAt = now;
    }
    const listLoading = listSigns > signsBefore &&
      (now - Math.max(signsChangedAt, rowsChangedAt) < noProgressMs || progress.causedInflight());
    return {
      // No identified row is never an answer: an empty list is waitForOutcome's to decide. Fewer
      // rows than asked are an answer only once nothing shows the list is still loading.
      ready: () => complete && taken.length > 0 && (!few || (!listLoading && !progress.busy(false))),
      signs: listLoading,
      settleMs: few ? fewSettle : settle,
      filled: taken.length * 1000 + filledCount,
      // The rows are read before the signs beside them, so a loader leaving in between restarts
      // the settle, and the next look sees the rows it left for.
      snapshot: JSON.stringify([listSigns, taken]),
      reason: "values_loading",
      problems:
        identified.length + " identified rows of " + read.length + ", needed " + count +
        (problems.length === 0 ? "" : "; " + problems.join("; ")),
      summary: (elapsed, looks) =>
        taken.length + " of " + count + " rows filled and holding after " + elapsed + " ms (" + looks + " looks)" +
        (few ? ", fewer rows than asked and the count held" : ""),
      result: {
        rows: taken.map((row) => ({
          key: row.key.value,
          ...Object.fromEntries(Object.entries(row.fields).map(([name, value]) => [name, value.state === "filled" ? value.value : null])),
        })),
        more: identified.length > count,
      },
    };
  }, waitLimits.lateFillCap);
};
// Reads each named field once: its value, or that it is absent, ambiguous or still loading.
const valueWaitRead = async (specs) => {
  const read = {};
  for (const [name, spec] of Object.entries(specs))
    read[name] = await spec.locator.evaluateAll(waitReadInPage, { mode: "field", field: { ...spec, locator: undefined } });
  return read;
};
const valueWaitState = (specs, read) => {
  const problems = [];
  let filled = 0;
  let absent = false;
  for (const [name, value] of Object.entries(read)) {
    if (value.state === "filled") filled += 1;
    else if (value.state === "loading") problems.push(name + " still loading");
    else if (value.state === "ambiguous") problems.push(name + " matches " + value.count + " visible elements");
    else if (!specs[name].optional) {
      absent = true;
      problems.push(name + " missing");
    }
  }
  const values = Object.fromEntries(Object.entries(read).map(([name, value]) => [name, value.state === "filled" ? value.value : null]));
  return { problems, filled, absent, values, complete: problems.length === 0 };
};
const valueWaitSpecs = (fields, where) => {
  const specs = Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, waitFieldSpec(field, where + " field " + name)]));
  for (const [name, spec] of Object.entries(specs))
    if (spec.locator === undefined) throw new TypeError(where + " field " + name + " needs a Playwright locator");
  if (Object.keys(specs).length === 0) throw new TypeError(where + " needs at least one field");
  return specs;
};
const waitForValues = async (fields, options = {}) => {
  const specs = valueWaitSpecs(fields, "waitForValues");
  const settle = options.stableMs ?? waitLimits.settle;
  return valueWaitLoop("waitForValues", options, async () => {
    const state = valueWaitState(specs, await valueWaitRead(specs));
    return {
      ready: state.complete,
      settleMs: settle,
      filled: state.filled,
      snapshot: JSON.stringify(state.values),
      reason: "values_loading",
      problems: state.problems.join("; "),
      summary: (elapsed, looks) => Object.keys(specs).length + " values filled and holding after " + elapsed + " ms (" + looks + " looks)",
      result: { values: state.values },
    };
  }, waitLimits.lateFillCap);
};
const waitForChange = async (fields, options = {}) => {
  const specs = valueWaitSpecs(fields, "waitForChange");
  if (options.before === undefined && options.action === undefined)
    throw new TypeError("waitForChange needs before (the values from before the choice) or action (the choice itself)");
  let before = options.before;
  if (before !== undefined && (before === null || typeof before !== "object" || Array.isArray(before) ||
      Object.keys(before).sort().join() !== Object.keys(specs).sort().join()))
    throw new TypeError("waitForChange's before must be the values object an earlier wait returned, with the same field names");
  const settle = options.stableMs ?? waitLimits.settle;
  const unchangedMs = options.unchangedMs ?? waitLimits.unchanged;
  const noProgressMs = options.noProgressMs ?? waitLimits.answer;
  return valueWaitLoop("waitForChange", {
    ...options,
    prepare: async () => {
      if (before === undefined) before = valueWaitState(specs, await valueWaitRead(specs)).values;
    },
  }, async (progress) => {
    const state = valueWaitState(specs, await valueWaitRead(specs));
    const changed = JSON.stringify(state.values) !== JSON.stringify(before);
    // The same values count once nothing has shown progress for unchangedMs: a loading sign or
    // request that came after the choice must first go.
    return {
      ready: () => state.complete && (changed || progress.quietMs() >= Math.min(unchangedMs, noProgressMs)),
      settleMs: changed ? settle : 0,
      filled: state.filled,
      snapshot: JSON.stringify(state.values),
      reason: state.absent && state.problems.every((problem) => problem.endsWith(" missing")) ? "change_unknown" : "values_loading",
      problems: state.problems.length > 0 ? state.problems.join("; ") : changed ? "values changed but not yet holding" : "values unchanged",
      summary: (elapsed, looks) =>
        (changed ? "values changed" : "values confirmed unchanged after " + unchangedMs + " ms without progress") +
        ", after " + elapsed + " ms (" + looks + " looks)",
      result: { values: state.values, changed },
    };
  }, waitLimits.answerCap);
};
`;

/**
 * Page code for a Kernel call body, where `page` is in scope: paste it once at the top of the code
 * string, then wait with your verified Playwright locators. It declares the waits below, which share
 * one set of limits (`waitLimits`, from `timeoutDefaults`) and one progress budget, and
 * `waitReport()`.
 *
 * Every wait returns as soon as its condition holds: a ready page costs `waitForOutcome` one look,
 * and the value waits two looks `settle` (0.5 s) apart. While it waits it watches the page's
 * progress: the site's own loading sign passed as `loading`, for as long as it shows; a generic
 * sign (a busy region, an indeterminate progress bar, a skeleton, shimmer, spinner or loader class,
 * within `region` when named) only while it is new, so a decoration holds a wait for at most one
 * no-progress window, and one there before the action not at all; DOM changes
 * inside the `region` you name; one of the site's own document or API requests in flight (beacons,
 * polls and long-open requests aside; pass the context's `siteDomain` to say which hosts are the
 * site's); the URL changing; and the wait's own reads filling or changing. It keeps waiting while progress
 * continues, up to `timeout`, and fails once nothing has progressed for `noProgressMs` (default
 * `answer`, 8 s). A failure is an `Error` with a `reason`, and a message that names the reason, what
 * each outcome or field showed (counts and states, never page text), which progress signs it saw
 * and when progress stopped. `waitReport()` returns one record per wait this call ran, each with a
 * `summary` sentence: return it from a probe to see how each wait ended.
 *
 * `waitForOutcome(outcomes, { action, loading, region, siteDomain, noProgressMs, timeout,
 * unchangedMs }?)` waits for whichever of the page's possible answers appears, after a step whose
 * answer can vary, such as a search, a filter, a date pick or a submit, and returns its key.
 * `outcomes` names one locator per answer, highest priority first, such as `{ refused, failed,
 * unavailable, empty, results }`: when several show at once, the first listed wins, so list a
 * refusal, the site's error or a greyed-out choice before an empty state, and an empty state before
 * results. Each locator names one element, such as the results list rather than its rows. It only
 * observes: about every 100 ms it counts each locator's matches and its visible ones, and never
 * clicks, types or navigates itself. It answers at the first look that shows an outcome.
 * `timeout` (default `answerCap`, 30 s) is the hard cap, reached only while the page keeps
 * progressing. `action` is the step itself, such as `() => apply.click()`, which it runs exactly
 * once, after noting what each outcome showed: a match that was visible before it, with the same
 * text, counts only once it has stayed so for `unchangedMs` (default 2000) and no request the
 * action started is still in flight, or was as the look began. Such a request holds it back for
 * at most `lateFillCap` (15 s), and never past `timeout` less `unchangedMs`, so the match still
 * counts before the timeout.
 * `timeout`, `noProgressMs` and `unchangedMs` start once the action returns; `deadline`, a
 * `Date.now()` time such as the call's own, ends the wait by then however long the action took. Its
 * `OutcomeWaitFailure` has `observations` (`OutcomeObservation` by key) and one of these reasons:
 *
 * - `outcome_ambiguous`, when the winning outcome's locator matches more than one element; its
 *   `outcome` is that key. Scope the locator, for example with `.filter({ visible: true })`.
 * - `outcome_unknown`, when no outcome shows and the page made no progress for `noProgressMs`: a
 *   challenge, the site's error or a layout the code does not handle, never slowness.
 * - `outcome_timeout`, when the page was still progressing at `timeout`.
 *
 * An outcome may also be an object naming one declared kind, raced beside the locators in the same
 * listed order, so a site that answers in a way the code did not expect still ends the wait:
 *
 * - `{ gone: locator, stableMs? }`: the element, visible before the action (or at a look), has
 *   had no visible match for `stableMs` (default 300), such as a form or a modal closing. A form
 *   redrawn in place within that time is not gone.
 * - `{ invalid: locator }`: a control inside it is marked invalid (`aria-invalid="true"`, the
 *   `is-invalid` class, or the browser's own check after a submit). Fields flagged before the
 *   action, and unchanged, follow the same `unchangedMs` rule as a locator.
 * - `{ url }`: the page's URL matches a string (the whole URL, its path, or path and query), a
 *   RegExp or a function of the `URL`. After an `action` it counts only once the page navigated,
 *   by a document load or a route change, so an edit page whose URL already matched waits.
 * - `{ response }`: a response arrived, from before the action, that a function of the Playwright
 *   `Response` accepts, or that matches `{ method, url, status, navigation }` (`status` a number,
 *   `[low, high]` or a function). It races the page's answers, so a request the site batches,
 *   caches or renames never hangs the wait: name one only for a write's commit request.
 * - `{ dialog: true | type | [types] }`: a native dialog opened, even one the action's own click
 *   raised. Page scripts stop while it is open, so it decides at once, and a dialog of a type no
 *   outcome names fails as `outcome_unknown`. The wait never accepts or dismisses it: a dialog
 *   that opened while it listened is on the result's or failure's `dialog`, whichever won. An
 *   action still waiting to click when a dialog opens clicks once the dialog is handled, so
 *   handle it before ending the call.
 * - `{ popup: true | (page) => boolean }`: the page opened a new tab or window.
 * - `{ announced: string | RegExp }`: a live region (`aria-live`, or the role `alert`, `status`,
 *   `log` or `alertdialog`) announced matching text after the action, as a screen reader hears
 *   it. A toast that comes and goes between two looks still counts.
 * - `{ check: async () => value }`: a condition of your own, true once it returns a truthy value.
 *   It has no stale rule: one already true before the action wins at the first look.
 *
 * `waitForOutcomeResult(outcomes, options?)` is the same wait returning `OutcomeResult`: the
 * winning `outcome` and its `kind`, `afterMs`, `looks`, the `observations`, and `evidence` of what
 * showed it (a locator's visible text, the invalid fields' labels and messages, the URL reached,
 * the response's method, URL and status, the dialog's type and message). The winning Playwright
 * `response`, `dialog` or popup `page` is on the result too, kept off its JSON. Every listener
 * the losing outcomes used is removed before it returns or throws.
 *
 * `waitForRows(rows, fields, { count, key, ...options })` waits until the first `count` identified
 * rows have every field filled and read the same on two looks `stableMs` apart (default `settle`,
 * 0.5 s), and returns `{ rows: [{ key, ...fields }], more }`. `rows` is a locator for every row;
 * `key` and each field are a CSS selector inside the row, or `{ selector, attribute, optional,
 * placeholder }` (no selector reads the row itself), read from its first visible match; a needed
 * text field whose matches are all hidden is reported `hidden`. A row without a key is a
 * placeholder slot and is skipped. When fewer identified rows than `count` exist, it returns them
 * once their count and values held for `unchangedMs`, no loading sign beside the rows still counts,
 * no request the action started is in flight, and no other site request started under 4 s ago is;
 * no identified row at all
 * is never an answer, so decide an empty list with `waitForOutcome` first. Options also take
 * `action` (run once first, such as a "load more" click), `loading`, `region`, `siteDomain`,
 * `noProgressMs` and `timeout` (default `lateFillCap`, 15 s).
 *
 * `waitForValues(fields, options?)` waits until each named field (a Playwright locator, or
 * `{ locator, attribute, all, optional, placeholder }`) is filled in and the values read the same
 * on two looks, and returns `{ values }`. `all` reads every visible match as a list.
 *
 * `waitForChange(fields, { before, action, ...options })` waits, after a choice, for the values
 * that depend on it: it returns `{ values, changed }` once they differ from `before` (or from what
 * they were before `action` ran) and hold, or once they stayed the same for `unchangedMs` with no
 * progress sign showing, so a loading sign or request the choice started must first go.
 *
 * `waitForReady(control, { overlays, expand, dismiss, pending, until, editable, stableMs,
 * dismissLimit, watch, deadline, ...options })` waits before an action until the control's one visible
 * match is attached, visible, enabled (and not read-only when `editable`), not busy (no
 * `aria-busy` around it, no spinner inside it), in the same place on two looks, and what a click
 * at its centre would hit is the control itself, not an overlay. It also waits while an `overlays`
 * locator shows, while `pending` (a function run in the page, such as
 * `() => window.jQuery?.active ?? 0`) returns a truthy count, and until `until()` is true. Once
 * anything held it back, ready must hold for `stableMs` (default `settle`), so a spinner that
 * flickers off between two requests does not count as gone. `expand` names the toggle of the
 * control's section: it clicks it once while the control is hidden and the toggle says the
 * section is collapsed (`aria-expanded` false, or the summary of a closed `details`), so it never
 * closes an open one. `dismiss`
 * names the close or skip controls of panels that open on their own, such as a tour, a what's-new
 * dialog or a cookie banner: it clicks one that shows, up to `dismissLimit` (5) times, and once
 * ready keeps a Playwright locator handler on each, so one that opens later is closed before the
 * next action, until `result.release()` or `dismissLimit` uses (`watch: false` skips it). It
 * returns `ReadyResult`, and fails as a `ReadyWaitFailure` with `blockers` and a message naming
 * what held it back last: `not_ready` once nothing progressed for `noProgressMs`, `ready_timeout`
 * at `timeout` (default `answerCap`), `ready_ambiguous` when more than one visible element
 * matches.
 *
 * A value is still loading, never absent, while it is empty, reads as a loading word or only dots,
 * matches the field's `placeholder` pattern, or sits in an `aria-busy`, skeleton or shimmer
 * element. An `optional` field may be absent and is then `null`; a needed one may not. A value
 * still loading when progress stops fails with `values_loading`, whether optional or not;
 * `change_unknown` when waitForChange's fields are missing; `values_timeout` at the cap. Each is a
 * `ValueWaitFailure`.
 */
export const waitCode = `${progressCode}${outcomeKindsCode}${outcomeCode}${valueCode}${readyWaitCode}`;

/**
 * `waitForOutcome` alone, for code written against the first release of it: it declares only the
 * names that release declared (`waitForOutcome`, `outcomeWaitFailure`, `outcomeWaitNote`,
 * `outcomeWaitChanged` and `outcomeWaitObserve`), keeping every other helper inside, so code that
 * pastes it beside helpers of its own still parses. New code pastes `waitCode` instead; never both.
 */
export const outcomeOnlyWaitCode = `
const { outcomeWaitFailure, outcomeWaitNote, outcomeWaitChanged, outcomeWaitObserve, waitForOutcome } = (() => {
${progressCode}${outcomeKindsCode}${outcomeCode}
return { outcomeWaitFailure, outcomeWaitNote, outcomeWaitChanged, outcomeWaitObserve, waitForOutcome };
})();
`;

/**
 * `confirmCommit(outcome, page)`, pasted after `waitCode` in a write's commit call, just before the
 * click's wait. It declares that one name, its helpers inside, so code that pastes `waitCode`
 * beside a `confirmCommit` of its own still parses. It uses `page`, and `waitCode`'s `waitLimits`,
 * `waitBounded`, `waitSleep`, `outcomeWaitClean` and `outcomeWaitInvalidInPage`. Pasting it notes
 * the page's address, how many messages show each text, and its flagged fields as they stand.
 * After, as many messages with a text as showed it then are stale, whatever element or page shows
 * them, so a page that draws its messages again, or a redirect to a page with the same banner,
 * adds no error, while one more message with an old text is new.
 *
 * It judges the commit from the `{ response }` answer of the click's `waitForOutcomeResult` and
 * the page, and returns `CommitConfirmation`, plain data a call can return. It never marks a write
 * done or not done without proof: whatever the response and the page leave open is `unclear`.
 *
 * - A response that is not 2xx or 3xx is `not_done`; a 201 with a Location is `done` at once. A 3xx
 *   whose Location is the page that posted (same path), or whose query names an error or failure,
 *   is `unclear` unless the page shows an error.
 * - A 2xx body that reads as JSON is `not_done` for a success field (`success`, `succeeded`,
 *   `isSuccess`, any case) that is false, `"false"`, 0 or `"no"` or holds an error word, `ok:
 *   false`, an error field holding an error (not empty, and not a word for none such as "No
 *   error"), a status of 400 or more, or an error word in a status or message. An error field is
 *   any named for errors up to two levels down, and `error`, `errors` or `userErrors` up to four;
 *   true counts only under `error`, `errors` or `hasError(s)`, and a setting such as
 *   `notifyOnError` is never one. It is `unclear` for a success field holding anything but true,
 *   `"true"`, 1, `"yes"`, `"ok"` or `"success"`, or a status or message that refuses a value
 *   ("required", "unable", "could not") or says declined, rejected or denied, words a write may
 *   itself have meant. A string holding JSON, as in `{ d: "..." }`, is read too. A body that is
 *   neither JSON nor HTML, or can't be read within 1 s, is `unclear`; a 3xx's or an empty one is no
 *   body.
 * - The page then gets the settle window (`settle`, 0.5 s). A field newly marked invalid, or a
 *   message whose text is new with words of an error or a refusal, is `not_done`, whatever the
 *   body's message said. A message is an alert, an assertive live region or anything styled as an
 *   error, with letters, outside links, buttons and labels, and not one only a screen reader hears.
 *   A new message styled as an error with no such words, one that mixes them with a success, one
 *   that says declined, rejected or denied, an alert that says neither error nor success, or a
 *   field still marked invalid as before, is `unclear`.
 * - Otherwise the commit is `done`: `queued` for a 202, or a body whose status says queued, pending
 *   or processing, with that word as `status_label`, else `completed`. An outcome with no response
 *   is `not_done` when the page shows a new error, else `unclear`. A native dialog that opened
 *   during the wait and says the write failed is `not_done`; while one stays open the page can't
 *   be read, which is `unclear`.
 *
 * It never clicks, and it reads the body for at most 1 s and the page for at most about 2 s.
 */
export const confirmCommitCode = String.raw`
const confirmCommit = await (async () => {
  // Words that say a write failed; "no errors" says none. Words that refuse a value prove nothing
  // on their own, nor do words a write may itself have meant, as declining or rejecting something.
  const errorWords = /\b(?:errors?|fail(?:s|ed|ure)?|invalid|forbidden|unauthori[sz]ed)\b/i;
  const noErrors = /\b(?:no|without|zero|0)\s+errors?\b/i;
  const refusalWords = /\b(?:required|must|cannot|can't|could not|couldn't|unable|not valid|please (?:enter|select|choose|provide|fill|complete|correct|try again))\b/i;
  const openWords = /\b(?:declined|rejected|denied)\b/i;
  const successWords = /\b(?:success(?:ful|fully)?|saved|created|updated|submitted|completed|confirmed|thank you)\b/i;
  const queuedWords = /\b(?:queued|enqueued|pending|processing|in progress)\b/i;
  const words = (value) => String(value).replace(/[_-]+/g, " ");
  const saysError = (value) => typeof value === "string" && errorWords.test(words(value)) && !noErrors.test(words(value));
  const saysRefusal = (value) => typeof value === "string" && refusalWords.test(words(value));
  const clip = (value) => outcomeWaitClean(typeof value === "string" ? value : JSON.stringify(value), 160);
  const list = (texts) => texts.slice(0, 3).map((text) => '"' + clip(text) + '"').join(", ");
  // A success field's value: true, false, or anything else, which leaves it unclear.
  const truth = (value) => {
    const text = typeof value === "string" ? value.trim().toLowerCase() : value;
    if (text === true || text === 1 || ["true", "1", "yes", "ok", "success"].includes(text)) return true;
    if (text === false || text === 0 || ["false", "0", "no"].includes(text) || saysError(value)) return false;
    return undefined;
  };
  // Whether an error field holds an error: not empty, zero, false or a word for none, at any depth.
  const filled = (value, depth = 0) => {
    if (value === null || value === undefined || value === false || value === 0) return false;
    if (typeof value === "string")
      return !/^\s*(?:0+|none|null|false|ok|success|n\/a|no errors?(?: found)?)?\s*\.?\s*$/i.test(value);
    if (typeof value !== "object" || depth > 3) return true;
    return (Array.isArray(value) ? value : Object.values(value)).some((each) => filled(each, depth + 1));
  };
  // Whether a field is an error field: up to two levels down, any named for errors, as in
  // { data: { save: { errors } } }; deeper, only error, errors and userErrors. A setting for what
  // to do on an error, such as notifyOnError, never is.
  const errorField = (name, depth) =>
    !/onerrors?$/.test(name) &&
    (depth <= 2 ? /errors?$|^error(?:message|msg|text|code)s?$/.test(name) : ["error", "errors", "usererrors"].includes(name));
  // Whether an error field holds an error; true does only under error, errors or hasError(s).
  const holdsError = (name, field) =>
    field === true ? ["error", "errors", "haserror", "haserrors"].includes(name) : filled(field);
  // What a JSON body says: the first sign the write failed, the first that leaves it unclear, and
  // the site's word for queued work. Error fields count up to four levels down (see errorField),
  // as in { data: { records: { save: { userErrors } } } }; success and ok fields up to two;
  // status and message words up to one. A string that holds JSON, as some frameworks wrap a body
  // in { d: "..." }, is read as one more level. It looks at 2,000 values at most.
  const judgeBody = (body) => {
    const found = {};
    let budget = 2000;
    const visit = (value, depth) => {
      if (depth > 4 || value === null || typeof value !== "object" || (budget -= 1) < 0) return;
      if (Array.isArray(value)) {
        for (const each of value.slice(0, 50)) visit(each, depth + 1);
        return;
      }
      for (const [key, field] of Object.entries(value)) {
        const name = key.toLowerCase().replace(/[_-]/g, "");
        const said = key + " is " + clip(field);
        if (depth <= 2 && /^(?:is)?succe(?:ss|ssful|eded)$/.test(name)) {
          const holds = truth(field);
          if (holds === false) found.failed ??= said;
          else if (holds === undefined) found.unclear ??= said + ", not true";
        } else if (depth <= 2 && name === "ok" && field === false) found.failed ??= said;
        else if (errorField(name, depth)) {
          if (holdsError(name, field)) found.failed ??= said;
        } else if (depth <= 1 && (name === "status" || name === "statuscode") && typeof field === "number" && field >= 400)
          found.failed ??= said;
        else if (depth <= 1 && /^(?:status|state|result|outcome|message|msg|statusmessage|detail)$/.test(name) && typeof field === "string") {
          if (saysError(field)) found.failed ??= said;
          else if (saysRefusal(field) || openWords.test(field)) found.unclear ??= said;
          else if ((name === "status" || name === "state") && queuedWords.test(words(field)))
            found.queued ??= outcomeWaitClean(field, 100);
        }
        if (typeof field === "string" && depth <= 1 && /^\s*[[{]/.test(field)) {
          try {
            visit(JSON.parse(field), depth + 1);
          } catch {}
        } else visit(field, depth + 1);
      }
    };
    visit(body, 0);
    return found;
  };
  // The body: JSON, HTML, none (empty, or a redirect's, which can't be read), or unclear when it
  // is something else or can't be read within 1 s.
  const readBody = async (response, status) => {
    const text = await waitBounded(Promise.resolve().then(() => response.text()).catch(() => null), 1000);
    if (text === undefined) return { unclear: "its body could not be read within 1 s" };
    if (text === null) return status >= 300 ? {} : { unclear: "its body could not be read" };
    if (text.trim() === "") return {};
    try {
      return { json: JSON.parse(text) };
    } catch {}
    const type = String(response.headers()["content-type"] ?? "").toLowerCase();
    if (type.includes("html") || /^\s*(?:<!doctype html|<html[\s>])/i.test(text)) return { html: true };
    return { unclear: "its body is neither JSON nor HTML" + (type === "" ? "" : " (" + clip(type) + ")") };
  };
  // Elements that may hold the site's message: alerts, assertive live regions, and anything styled
  // as an error.
  const messages =
    '[role="alert"], [role="alertdialog"], [aria-live="assertive"], [class*="error" i], [class*="danger" i], [class*="invalid" i]';
  // Runs in the page: each visible message with letters, outside links, buttons and labels and
  // wider than a pixel, its text (500 characters at most), what its styling says (its own or up
  // to two elements around it), and whether it is an alert.
  const messagesInPage = (elements) => {
    const shows = (element) =>
      typeof element.checkVisibility === "function"
        ? element.checkVisibility({ visibilityProperty: true, opacityProperty: true })
        : element.getClientRects().length > 0;
    const styling = (element) => {
      const parts = [];
      for (let node = element, depth = 0; node instanceof Element && depth < 3; node = node.parentElement, depth += 1)
        for (const name of ["class", "data-type", "data-status", "data-variant", "data-severity"]) parts.push(node.getAttribute(name) ?? "");
      return parts.join(" ");
    };
    return elements.flatMap((element) => {
      if (element.closest('a, button, label, summary, input, select, textarea, option, [role="button"], [role="link"]') || !shows(element))
        return [];
      const box = element.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1) return [];
      const text = String(element.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
      if (!/\p{L}/u.test(text)) return [];
      const style = styling(element);
      return [{
        text,
        errorStyle: /error|danger|invalid|fail/i.test(style),
        successStyle: /success/i.test(style),
        alert: element.matches('[role="alert"], [role="alertdialog"], [aria-live="assertive"]'),
      }];
    });
  };
  const fieldKey = (field) => field.field + "\u0000" + field.message;
  const fieldText = (field) => field.field + (field.message === "" ? " is marked invalid" : ": " + field.message);
  // Notes the page as it stands now, before the click: its address, how many messages show each
  // text, and its flagged fields. After, as many messages with a text as showed it then are stale,
  // whatever element or page shows them, as a page that draws its messages again or a redirect to
  // a page with the same banner; one more with that text is new.
  const read = (promise) => waitBounded(promise.catch(() => undefined), 1000);
  const postedFrom = page.url();
  const shownBefore = await read(page.locator(messages).evaluateAll(messagesInPage));
  const staleCounts = new Map();
  for (const message of shownBefore ?? []) {
    const text = message.text.toLowerCase();
    staleCounts.set(text, (staleCounts.get(text) ?? 0) + 1);
  }
  const flaggedBefore = await read(page.locator("body").evaluateAll(outcomeWaitInvalidInPage));
  const staleFields = new Set((flaggedBefore ?? []).map(fieldKey));
  // One look at the page: the new errors it shows, and what it shows that leaves the write open.
  const look = async (page) => {
    const fields = await page.locator("body").evaluateAll(outcomeWaitInvalidInPage);
    const shown = await page.locator(messages).evaluateAll(messagesInPage);
    const errors = fields.filter((field) => !staleFields.has(fieldKey(field))).map(fieldText);
    const open = fields.filter((field) => staleFields.has(fieldKey(field))).map((field) => fieldText(field) + ", as before the click");
    const counted = new Map();
    for (const message of shown) {
      const text = message.text.toLowerCase();
      counted.set(text, (counted.get(text) ?? 0) + 1);
      if (counted.get(text) <= (staleCounts.get(text) ?? 0)) continue;
      const refuses = saysError(message.text) || saysRefusal(message.text);
      const succeeds = message.successStyle || successWords.test(message.text);
      if (refuses && !succeeds) errors.push(message.text);
      else if (refuses) open.push(message.text + " (a success beside a refusal)");
      else if (openWords.test(message.text)) open.push(message.text);
      else if (message.errorStyle && !message.successStyle) open.push(message.text + " (styled as an error, with no words of one)");
      else if (message.alert && !succeeds) open.push(message.text + " (an alert that says neither error nor success)");
    }
    return { errors: [...new Set(errors)], open: [...new Set(open)] };
  };
  // Looks for the settle window, so an error the page draws just after the response counts, and
  // returns at the first look that shows one. Undefined when no look could read the page.
  const watch = async (page) => {
    const begun = Date.now();
    const capMs = 2000;
    let seen;
    while (true) {
      const each = await waitBounded(look(page).catch(() => undefined), Math.max(0, begun + capMs - Date.now()));
      if (each !== undefined) {
        seen = each;
        if (each.errors.length > 0) return each;
      }
      const elapsed = Date.now() - begun;
      if ((seen !== undefined && elapsed >= waitLimits.settle) || elapsed >= capMs) return seen;
      await waitSleep(100);
    }
  };
  // A redirect gives no body, so one back to the page that posted, or to an address whose query
  // names an error or failure, may carry a refusal the page check can't see: why, or undefined.
  const redirectedBack = (response) => {
    const location = String(response.headers()["location"] ?? "").trim();
    if (location === "") return undefined;
    try {
      const to = new URL(location, response.url());
      const from = new URL(postedFrom);
      let query = to.search + to.hash;
      try {
        query = decodeURIComponent(query);
      } catch {}
      if (/error|fail/i.test(query)) return "it redirected to " + clip(location) + ", whose query names an error";
      if (to.origin === from.origin && to.pathname === from.pathname)
        return "it redirected back to the page that posted, " + clip(to.pathname);
    } catch {}
    return undefined;
  };
  return async (outcome, page) => {
    const done = (reason, queued, label) => ({
      state: "done",
      status: queued ? "queued" : "completed",
      ...(label === undefined ? {} : { status_label: label }),
      reason,
    });
    const notDone = (reason) => ({ state: "not_done", status: "failed", reason });
    const unclear = (reason) => ({ state: "unclear", status: "unconfirmed", reason });
    // A native dialog that opened during the wait and says the write failed is the page's answer.
    // While one stays open the page can't be read, and the look below finds it unclear.
    const dialog = outcome?.dialog;
    if (dialog !== undefined && dialog !== null && saysError(dialog.message()))
      return notDone("a native " + dialog.type() + ' dialog said "' + clip(dialog.message()) + '"');
    const response = outcome?.response;
    if (response === undefined || response === null) {
      const seen = await watch(page);
      const answered = outcome?.outcome === undefined ? "" : '; "' + outcome.outcome + '" answered the wait';
      if (seen !== undefined && seen.errors.length > 0)
        return notDone("no commit response" + answered + "; the page shows " + list(seen.errors));
      return unclear("no commit response to confirm" + answered);
    }
    const status = response.status();
    const where = response.request().method() + " " + new URL(response.url()).pathname + " answered " + status;
    if (status < 200 || status >= 400) return notDone(where);
    const location = String(response.headers()["location"] ?? "").trim();
    if (status === 201 && location !== "") return done(where + " with Location " + clip(location), false);
    const body = await readBody(response, status);
    const found = body.json === undefined ? {} : judgeBody(body.json);
    if (found.failed !== undefined) return notDone(where + "; its body's " + found.failed);
    const seen = await watch(page);
    if (seen !== undefined && seen.errors.length > 0) return notDone(where + "; the page shows " + list(seen.errors));
    const back = status >= 300 ? redirectedBack(response) : undefined;
    if (back !== undefined) return unclear(where + "; " + back);
    if (body.unclear !== undefined) return unclear(where + "; " + body.unclear);
    if (found.unclear !== undefined) return unclear(where + "; its body's " + found.unclear);
    if (seen === undefined) return unclear(where + "; the page could not be read after it");
    if (seen.open.length > 0) return unclear(where + "; the page shows " + list(seen.open));
    return done(
      where + (body.json === undefined ? "" : "; its body shows no error") + "; the page shows no error",
      status === 202 || found.queued !== undefined,
      found.queued,
    );
  };
})();
`;
