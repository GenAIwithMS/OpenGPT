import { Effect, Schema } from "effect";
import { urlSpans } from "../privacy/url-spans.js";
import { primaryPageCode, type HostExecute } from "./host-execute.js";
import { hostOnSiteSource, siteOf } from "./same-site.js";

/**
 * How a live step's page starts. `none` continues the page as the previous step left it. The
 * others reset the browser and then load the site root: `keep` keeps the browser's cookies and
 * site storage as they are, `clear` removes them, and `restore` puts back a session a host saved.
 * A build step only ever keeps or clears (see `startStateFor`); `restore` is for a host's own
 * resets, such as a run's retry.
 */
export type StartState = "none" | "clear" | "restore" | "keep";

/** A build step's purpose, as the minting agent submits it. */
export type StepPurpose =
  "explore" | "authenticate" | "test" | "example" | "act" | "inspect" | "residual" | "card_fill";

/** A step about to run: its purpose, and whether it runs on the live browser. */
export interface StartStep {
  readonly purpose: StepPurpose;
  readonly live: boolean;
}

/** A write session's first step is its first `act`; later steps continue its page. */
export const isFirstWriteStep = (purpose: StepPurpose, writeSessionStarted: boolean) =>
  purpose === "act" && !writeSessionStarted;

/**
 * A live example, a live test and a write session's first step start over at the site root, with
 * none of the page state exploration left. They keep the browser's cookies and site storage, so a
 * site that trusts a browser session keeps trusting it. A browser where a sign-in started and no
 * sign-in was verified is the exception: its reset clears them, so a half-finished sign-in never
 * reaches a step. Every other step continues the current page. Whether the published tool works
 * for a caller with nothing remembered is a fresh browser's question: see the live test contract.
 */
export const startStateFor = (
  step: StartStep & {
    readonly writeSessionStarted: boolean;
    /** Whether a sign-in step started on this browser. */
    readonly signInStarted: boolean;
    /** Whether a sign-in on this browser was verified. */
    readonly signInVerified: boolean;
  },
): StartState => {
  const resets =
    step.live &&
    (step.purpose === "example" ||
      step.purpose === "test" ||
      isFirstWriteStep(step.purpose, step.writeSessionStarted));
  if (!resets) return "none";
  return step.signInStarted && !step.signInVerified ? "clear" : "keep";
};

/**
 * One build's start state on one browser: whether its write session started, whether a sign-in
 * started or was verified on that browser, and what the current sign-in sent. A host calls
 * `signIn()` on each sign-in step, a signed-in check included, `sent(...)` for what a sign-in
 * step may have sent, `verified()` when the site shows the build signed in, `plan(step)` before
 * each step and `dispatched(step)` once the step's page is ready. A failed page start stops the
 * step and changes nothing, so the next step's plan asks again. A host that replaces the browser,
 * such as for a new proxy, calls `browserReplaced()`: the new browser starts with an empty
 * profile, so the tracker forgets what it saw on the old one. `signInStartedBefore` says whether
 * a sign-in started on the current browser before this build, as on a browser that builds share;
 * the tracker asks it at each plan, so after a replacement it must answer for the new browser.
 */
export const makeStartTracker = (
  options: { readonly signInStartedBefore?: () => boolean } = {},
) => {
  let writeSessionStarted = false;
  let signInStarted = false;
  let signInVerified = false;
  let signInOpen = false;
  let sentIdentifier = false;
  let sentProof = false;
  const started = () => signInStarted || options.signInStartedBefore?.() === true;
  return {
    /**
     * A sign-in step, a signed-in check included. The first one after a verified sign-in, or the
     * build's first, starts a new sign-in: nothing sent counts for it yet. Later steps of the same
     * sign-in, each screen of it, add to what it sent.
     */
    signIn: () => {
      signInStarted = true;
      if (signInOpen) return;
      sentIdentifier = false;
      sentProof = false;
      signInOpen = true;
    },
    /**
     * What a sign-in step may have sent: the login's identifier, or what proves it (a password, a
     * code or an approval the user completed).
     */
    sent: (kind: "identifier" | "proof") => {
      if (kind === "identifier") sentIdentifier = true;
      else sentProof = true;
    },
    /** Whether this sign-in sent the login's identifier and what proves it. */
    get submitted() {
      return sentIdentifier && sentProof;
    },
    /**
     * The site shows the build signed in. It counts only once the sign-in sent the login, so a
     * page that already showed an account proves nothing. A verified sign-in is over: what it
     * sent counts for no later check. Returns whether it counted.
     */
    verified: () => {
      if (!(sentIdentifier && sentProof)) return false;
      signInVerified = true;
      signInOpen = false;
      sentIdentifier = false;
      sentProof = false;
      return true;
    },
    /** Whether a sign-in started on this browser, before this build included. */
    get signInStarted() {
      return started();
    },
    /** Whether a sign-in on this browser was verified, and no sign-in started since. */
    get signedIn() {
      return signInVerified && !signInOpen;
    },
    /** How `step`'s page starts. Planning changes nothing. */
    plan: (step: StartStep): StartState =>
      startStateFor({ ...step, writeSessionStarted, signInStarted: started(), signInVerified }),
    /** The step's page is ready and it runs now: a write session's first step starts it. */
    dispatched: (step: StartStep) => {
      if (isFirstWriteStep(step.purpose, writeSessionStarted)) writeSessionStarted = true;
    },
    /**
     * The host replaced the browser, which starts with an empty profile: the tracker forgets every
     * sign-in started, sent or verified on the old one. `signInStarted` is then whatever
     * `signInStartedBefore` says of the new browser, false without it. The write session stays as
     * it was.
     */
    browserReplaced: () => {
      signInStarted = false;
      signInVerified = false;
      signInOpen = false;
      sentIdentifier = false;
      sentProof = false;
    },
  };
};

/**
 * The primary tab's session storage the save kept, per same-site origin, in the order read: what
 * Playwright's storage state leaves out.
 */
export const SavedSessionStorage = Schema.Array(
  Schema.Struct({
    origin: Schema.String,
    entries: Schema.Array(Schema.Tuple(Schema.String, Schema.String)),
  }),
);
export type SavedSessionStorage = typeof SavedSessionStorage.Type;

/** Saved session storage past this many bytes is left out of the save. */
export const savedSessionStorageCapBytes = 1024 * 1024;

/** What `saveSessionCode` returns: the context's storage state and the tab's session storage. */
export const SavedSession = Schema.Struct({
  state: Schema.Unknown,
  sessionStorage: SavedSessionStorage,
});
export type SavedSession = typeof SavedSession.Type;

/**
 * One browser call that reads the context's storage state and the primary tab's session storage,
 * from its main frame and the frames on the site's registrable domain only, one read per origin.
 */
export const saveSessionCode = (targetId: string, primaryOrigin: string) => {
  const url = new URL(primaryOrigin);
  return `${primaryPageCode(targetId)}
const scheme = ${JSON.stringify(url.protocol)};
const onSiteHost = ${hostOnSiteSource(siteOf(url))};
const sameSite = (href) => {
  try {
    const url = new URL(href);
    return url.protocol === scheme && onSiteHost(url.hostname);
  } catch {
    return false;
  }
};
const state = await context.storageState({ indexedDB: true });
const sessionStorage = [];
const read = new Set();
for (const frame of primary.frames()) {
  if (!sameSite(frame.url()) || read.has(new URL(frame.url()).origin)) continue;
  const stored = await frame
    .evaluate(() => {
      const entries = [];
      for (let index = 0; index < sessionStorage.length; index++) {
        const key = sessionStorage.key(index);
        if (key !== null) entries.push([key, sessionStorage.getItem(key) ?? ""]);
      }
      return { origin: location.origin, entries };
    })
    .catch(() => undefined);
  if (stored === undefined || !sameSite(stored.origin + "/") || read.has(stored.origin)) continue;
  read.add(stored.origin);
  if (stored.entries.length > 0) sessionStorage.push(stored);
}
return { state, sessionStorage };`;
};

/**
 * Browser code that stops the primary tab's loading. A failed goto can reject before Chromium
 * commits its error document; stopping it keeps that late commit from cancelling the next goto.
 */
export const stopLoadingCode = (targetId: string) => `${primaryPageCode(targetId)}
const stopped = await context.newCDPSession(primary);
try { await stopped.send("Page.stopLoading"); } finally { await stopped.detach(); }`;

/** Why a load of the requested page failed, read from the browser's error message. */
export type EntryNavigationFailureKind =
  | "dns"
  | "refused"
  | "reset"
  | "tls"
  | "aborted"
  | "blocked"
  | "closed"
  | "timeout"
  | "other";

/**
 * How a host's load of the requested page went: `ready` or `http_error` when the site answered,
 * with its final status, the redirects before it and where the tab landed; `failed` or `timeout`
 * when the load did not complete, with its `failure`. A host may skip the load.
 */
export type EntryNavigationOutcome =
  | {
      readonly outcome: "ready" | "http_error" | "failed" | "timeout";
      readonly requestedUrl: string;
      readonly resolvedUrl: string;
      readonly redirects: readonly { readonly url: string; readonly status: number | null }[];
      readonly redirectsTruncated: boolean;
      readonly status: number | null;
      readonly durationMs: number;
      readonly failure?: {
        readonly kind: EntryNavigationFailureKind;
        readonly name: string;
        readonly message: string;
      };
    }
  | { readonly outcome: "skipped" };

const maxRedirects = 20;
const maxMessage = 2048;

const failureKind = (message: string): EntryNavigationFailureKind => {
  if (/Timeout \d+ms exceeded/u.test(message)) return "timeout";
  if (/net::ERR_NAME_NOT_RESOLVED|net::ERR_NAME_RESOLUTION_FAILED/u.test(message)) return "dns";
  if (/net::ERR_CONNECTION_REFUSED/u.test(message)) return "refused";
  if (/net::ERR_CONNECTION_(RESET|CLOSED|ABORTED)|net::ERR_EMPTY_RESPONSE/u.test(message))
    return "reset";
  if (/net::ERR_(CERT_|SSL_)/u.test(message)) return "tls";
  if (/net::ERR_BLOCKED_BY_(CLIENT|RESPONSE|ADMINISTRATOR)/u.test(message)) return "blocked";
  if (/net::ERR_ABORTED/u.test(message)) return "aborted";
  if (/has been closed|Target closed|Browser closed/u.test(message)) return "closed";
  return "other";
};

/** What one navigation call answers: the load's final response, or why it failed. */
export const EntryAnswer = Schema.Union(
  Schema.Struct({
    ok: Schema.Literal(true),
    response: Schema.NullOr(
      Schema.Struct({
        status: Schema.Number,
        headers: Schema.Record({ key: Schema.String, value: Schema.String }),
        method: Schema.String,
        redirected: Schema.Boolean,
        startedAt: Schema.optionalWith(Schema.Number, { exact: true }),
      }),
    ),
    redirects: Schema.Array(
      Schema.Struct({ url: Schema.String, status: Schema.NullOr(Schema.Number) }),
    ),
    truncated: Schema.Boolean,
    url: Schema.String,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    name: Schema.String,
    message: Schema.String,
    url: Schema.NullOr(Schema.String),
  }),
);

/**
 * One browser call: the primary tab loads the page and reports its final response and redirects.
 */
export const entryNavigationCode = (
  targetId: string,
  href: string,
  timeoutMs: number,
) => `${primaryPageCode(targetId)}
try {
  const response = await primary.goto(${JSON.stringify(href)}, { waitUntil: "domcontentloaded", timeout: ${timeoutMs} });
  const chain = [];
  let request = response ? response.request().redirectedFrom() : null;
  while (request && chain.length <= ${maxRedirects}) {
    chain.unshift(request);
    request = request.redirectedFrom();
  }
  const truncated = chain.length > ${maxRedirects};
  const redirects = [];
  for (const entry of truncated ? chain.slice(chain.length - ${maxRedirects}) : chain)
    redirects.push({ url: entry.url(), status: (await entry.response().catch(() => null))?.status() ?? null });
  const startTime = response ? response.request().timing().startTime : 0;
  return {
    ok: true,
    response: response && {
      status: response.status(),
      headers: await response.allHeaders().catch(() => response.headers()),
      method: response.request().method(),
      redirected: response.request().redirectedFrom() !== null,
      ...(Number.isFinite(startTime) && startTime > 0 ? { startedAt: startTime } : {}),
    },
    redirects,
    truncated,
    url: primary.url(),
  };
} catch (error) {
  let url = null;
  try {
    url = primary.url();
  } catch {}
  return {
    ok: false,
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
    url,
  };
}`;

/** A load the site answered: `http_error` for an error status, else `ready`. */
export const answeredEntry = (
  requestedUrl: string,
  answer: Extract<typeof EntryAnswer.Type, { ok: true }>,
  durationMs: number,
) => {
  const status = answer.response?.status ?? null;
  return {
    outcome: status !== null && status >= 400 ? "http_error" : "ready",
    requestedUrl,
    resolvedUrl: answer.url,
    redirects: answer.redirects,
    redirectsTruncated: answer.truncated,
    status,
    durationMs,
  } satisfies EntryNavigationOutcome;
};

/**
 * A load that did not complete: `timeout` when it ran out of time, else `failed`, with the error's
 * name, its kind and its message, cut at 2,048 characters but never inside a URL. `url` is where
 * the tab was when it failed, if it could say.
 */
export const failedEntry = (
  requestedUrl: string,
  url: string | null,
  error: unknown,
  durationMs: number,
) => {
  const name = error instanceof Error ? error.name.slice(0, 200) : "UnknownError";
  const rawMessage = error instanceof Error ? error.message : String(error);
  const messageLimit = urlSpans(rawMessage).reduce(
    (limit, span) => Math.max(limit, span.end),
    maxMessage,
  );
  const message = rawMessage.slice(0, messageLimit);
  const kind = failureKind(message);
  return {
    outcome: kind === "timeout" ? "timeout" : "failed",
    requestedUrl,
    // A closed page keeps the requested URL as the last known location.
    resolvedUrl: url ?? requestedUrl,
    redirects: [],
    redirectsTruncated: false,
    status: null,
    durationMs,
    failure: { kind, name, message },
  } satisfies EntryNavigationOutcome;
};

/**
 * Loads the requested page on the primary tab in one browser call and says how it went. It never
 * fails: a load that did not complete is the outcome's evidence, as is the browser call's own
 * failure.
 */
export const loadEntry = (
  execute: HostExecute,
  targetId: string,
  requestedUrl: string,
  timeoutMs: number,
): Effect.Effect<EntryNavigationOutcome> =>
  Effect.promise(async () => {
    const started = performance.now();
    const elapsed = () => Math.max(0, Math.round(performance.now() - started));
    const href = new URL(requestedUrl).href;
    let last: { readonly url: string | null } = { url: null };
    try {
      const answer = await Effect.runPromise(
        execute(
          entryNavigationCode(targetId, href, timeoutMs),
          Math.ceil(timeoutMs / 1_000) + 5,
        ).pipe(Effect.flatMap(Schema.decodeUnknown(EntryAnswer))),
      );
      last = answer;
      if (!answer.ok) throw Object.assign(new Error(answer.message), { name: answer.name });
      return answeredEntry(requestedUrl, answer, elapsed());
    } catch (error) {
      return failedEntry(requestedUrl, last.url, error, elapsed());
    }
  });

/**
 * How a reset leaves the browser's site data. `restore` puts back `session`, the value
 * `saveSessionCode` returned.
 */
export type PageStart =
  | { readonly siteData: "clear" | "keep" }
  | { readonly siteData: "restore"; readonly session: SavedSession | undefined };

/**
 * One browser call that closes every other tab and leaves the primary tab blank. Unless site data
 * is kept, it then clears every cookie, the tab's session storage and the storage of every origin
 * the browser visited, and puts back `restored` and `restoredSessionStorage` when given. It sends
 * no request: session storage that only a site document can clear or set is cleared, then set
 * again, on a blank document of that origin that Playwright serves locally in the same tab, and
 * Playwright restores each origin's other storage the same way. `origins` are cleared besides the
 * primary one. Cookies whose names start with one of `keptCookiePrefixes`, which a host supplies,
 * are kept across a clear and put back last, over a restored one of the same name, domain and
 * path. `cleanupOnly` leaves the tab on about:blank.
 */
export const resetPageCode = (
  targetId: string,
  primaryOrigin: string,
  siteData: "keep" | "clear" | "restore",
  restored: unknown,
  restoredSessionStorage: SavedSessionStorage = [],
  origins: readonly string[] = [],
  cleanupOnly = false,
  keptCookiePrefixes: readonly string[] = [],
) => `${primaryPageCode(targetId)}
const primaryOrigin = ${JSON.stringify(primaryOrigin)};
const cleared = ${JSON.stringify([...new Set([primaryOrigin, ...origins])])};
const siteData = ${JSON.stringify(siteData)};
const restored = ${JSON.stringify(siteData === "restore" ? restored : null)};
const tabStorage = new Map(${JSON.stringify(
  siteData === "restore"
    ? restoredSessionStorage.map(({ origin, entries }) => [origin, entries])
    : [],
)});
const keptPrefixes = ${JSON.stringify(siteData !== "keep" ? keptCookiePrefixes : [])};
// A jar that cannot be read keeps nothing: the reset wipes it as it would without the keep.
const kept = keptPrefixes.length === 0
  ? []
  : (await context.cookies().catch(() => [])).filter((cookie) =>
      keptPrefixes.some((prefix) => cookie.name.startsWith(prefix)));
for (const other of context.pages()) if (other !== primary) await other.close();
if (siteData !== "keep")
  for (const frame of primary.frames())
    await frame.evaluate(() => sessionStorage.clear()).catch(() => undefined);
const session = await context.newCDPSession(primary);
try {
  await session.send("Page.stopLoading");
  if (siteData !== "keep")
    for (const origin of cleared)
      await session.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
} finally {
  await session.detach();
}
// An inert same-origin document clears the old page without loading the website before
// its session is restored. Returning to an origin also exposes its tab session storage, so a
// saved same-site origin's entries go back the same way, the site origin's last.
const local = (route) => route.fulfill({ contentType: "text/html", body: "<html></html>" });
const navigation = await context.newCDPSession(primary);
await navigation.send("Network.setBypassServiceWorker", { bypass: true });
try {
  for (const origin of [...[...tabStorage.keys()].filter((origin) => origin !== primaryOrigin), primaryOrigin]) {
    await primary.route(origin + "/**", local);
    try {
      await primary.goto(origin + "/", { waitUntil: "domcontentloaded", timeout: 10_000 });
      if (siteData !== "keep")
        await primary.evaluate((entries) => {
          sessionStorage.clear();
          for (const [key, value] of entries) sessionStorage.setItem(key, value);
        }, tabStorage.get(origin) ?? []);
    } finally {
      await primary.unroute(origin + "/**", local);
    }
  }
} finally {
  await navigation.send("Network.setBypassServiceWorker", { bypass: false });
  await navigation.detach();
}
if (siteData !== "keep")
  await context.setStorageState(restored ?? { cookies: [], origins: [] });
// One at a time, since Chromium refuses a whole call over one cookie it rejects. The reset has
// done its job by now, so a refused cookie only loses its own clearance.
for (const cookie of kept) await context.addCookies([cookie]).catch(() => undefined);
${cleanupOnly ? 'await primary.goto("about:blank", { timeout: 10_000 });' : ""}`;

/** What a host does around a reset: before the site root loads, and loading it. */
export interface StartPageHooks {
  /** Runs after the old page is cleared, before the root loads. */
  readonly beforeEntry: Effect.Effect<void, Error>;
  /** Loads `url` on the primary tab. A load that fails leaves the tab stopped, not failed. */
  readonly navigateRoot: (url: string) => Effect.Effect<void, Error>;
}

/** The local browser's hooks: nothing before entry, and a plain goto that is stopped on failure. */
export const localStartHooks = (execute: HostExecute, targetId: string): StartPageHooks => ({
  beforeEntry: Effect.void,
  navigateRoot: (url) =>
    execute(
      `${primaryPageCode(targetId)}
try {
  await primary.goto(${JSON.stringify(url)}, { waitUntil: "domcontentloaded", timeout: 30_000 });
  return true;
} catch {
  return false;
}`,
      40,
    ).pipe(
      Effect.flatMap((loaded) =>
        loaded === true ? Effect.void : execute(stopLoadingCode(targetId), 10),
      ),
      Effect.asVoid,
    ),
});

/**
 * Resets the primary tab as `start` says and then loads the site root. A root that does not load
 * leaves the reset in place: the step still runs and may navigate deeper itself. A `restore`
 * without a saved session fails before it touches the browser.
 */
export const startPage = (
  execute: HostExecute,
  targetId: string,
  origin: string,
  start: PageStart,
  hooks: StartPageHooks,
): Effect.Effect<void, Error> =>
  start.siteData === "restore" && start.session === undefined
    ? Effect.fail(new Error("No saved session to restore"))
    : execute(
        resetPageCode(
          targetId,
          origin,
          start.siteData,
          start.siteData === "restore" ? start.session?.state : undefined,
          start.siteData === "restore" ? start.session?.sessionStorage : undefined,
        ),
        60,
      ).pipe(
        Effect.zipRight(hooks.beforeEntry),
        Effect.zipRight(hooks.navigateRoot(new URL("/", origin).href)),
      );
