import { Effect, Schema } from "effect";
import {
  openAutofillLogin,
  type AutofillPage,
  type AutofillSignedIn,
  type AutofillSignedInCheck,
} from "../destinations/autofill-step.js";
import { settledMarkerCheck } from "../destinations/marker-settle.js";
import {
  evaluateSignedInMarker,
  matchSignedOutSnapshots,
  type SignedInMarkerCheck,
  type SignedOutSnapshot,
} from "../destinations/signed-in-marker.js";
import { MintFailure, type SignedInMarkerCheckRequest } from "../mint/contracts.js";
import { failureDetail } from "../runtime/failure-detail.js";
import { primaryPageCode } from "../runtime/host-execute.js";
import type { SessionTyping } from "./authentication.js";

/** The most signed-out pages a build keeps, newest last. */
const keptPages = 4;

/**
 * Browser code that defines `within(ms, work)`: what `work` gives, or `late` once `ms` passed. A
 * page call such as `evaluate` has no time limit of its own, and a host call that outlasts its
 * limit stops the browser for the rest of the build, so the host bounds each one.
 */
const withinCode = `const late = Symbol("late");
const within = (ms, work) => {
  let timer;
  const expiry = new Promise((resolve) => {
    timer = setTimeout(resolve, ms, late);
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
};`;

/** The longest the host waits before it reads a signed-out page, and the quiet it waits for. */
const settle = { totalMs: 3000, quietMs: 1500 };

/**
 * Browser code that returns the primary tab's address, its serialized document, with its scripts'
 * and styles' text left out, and whether the page settled before the host read it (`settled`).
 * The match never reads scripts or styles, and they would take most of the 1 MiB a host call may
 * return. It returns null for a page that cannot show the site signed out, which a selector would
 * find nothing on whatever the marker:
 * - a page off the site's origin, such as a sign-in site's or a browser error page;
 * - a page that shows nothing, no text, form control or image in its body, such as the blank page
 *   a reset leaves when the root fails to load, or a client-rendered page's empty shell.
 *
 * Before it reads the page, the host waits for its load, then for its network to go quiet, then
 * for its document to go 1.5 seconds without a change. A page that then shows something settled,
 * and is read at once: about 2 seconds after its load, for a page that loads fast. A
 * client-rendered page whose script renders its header within about 1.5 seconds of its network
 * going quiet is read rendered, past a splash screen such as "Loading…". The host waits 3 seconds
 * at most in all, so a page whose load, network or document is still busy then is read as it is,
 * and one that showed nothing when its document went quiet is read once it shows something, if
 * it does before the 3 seconds end. Neither settled. One that still shows nothing is skipped.
 * The host never sees what a page renders after it read it: a settled page whose script renders
 * its header more than 1.5 seconds after its last change is read without it. A wait runs only
 * while time is left, since Playwright reads a timeout of 0 as no limit, and each page call is
 * bounded, so the host call ends inside its 15 seconds.
 */
const signedOutPageCode = (targetId: string, siteOrigin: string) => `${primaryPageCode(targetId)}
${withinCode}
const onSite = () => URL.parse(primary.url())?.origin === ${JSON.stringify(siteOrigin)};
if (!onSite()) return null;
const deadline = Date.now() + ${settle.totalMs};
const wait = async (start) => {
  const ms = Math.floor(deadline - Date.now());
  return ms > 0 ? await start(ms).catch(() => undefined) : undefined;
};
await wait((timeout) => primary.waitForLoadState("load", { timeout }));
await wait((timeout) => primary.waitForLoadState("networkidle", { timeout }));
// True when the document went quiet, false when time ran out first.
const quietEnded = await wait((timeout) =>
  within(
    timeout,
    primary.evaluate(
      ([quiet, limit]) =>
        new Promise((resolve) => {
          let still;
          let cap;
          const done = (wentQuiet) => {
            observer.disconnect();
            clearTimeout(still);
            clearTimeout(cap);
            resolve(wentQuiet);
          };
          const observer = new MutationObserver(() => {
            clearTimeout(still);
            still = setTimeout(done, quiet, true);
          });
          observer.observe(document, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
          });
          still = setTimeout(done, quiet, true);
          cap = setTimeout(done, limit, false);
        }),
      [${settle.quietMs}, timeout],
    ),
  ),
);
const shows = () =>
  within(
    1000,
    primary.evaluate(() => {
      const body = document.body;
      if (body === null) return false;
      if (body.innerText.trim() !== "") return true;
      const shown = body.querySelectorAll(
        "input:not([type=hidden]), select, textarea, button, img, svg, canvas, video",
      );
      return [...shown].some((element) => element.checkVisibility());
    }),
  ).then(
    (shown) => shown === true,
    () => false,
  );
let rendered = await shows();
const settled = quietEnded === true && rendered;
while (!rendered && deadline - Date.now() > 0) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  rendered = await shows();
}
if (!rendered || !onSite()) return null;
const dom = await within(
  5000,
  primary.evaluate(() => {
    const root = document.documentElement.cloneNode(true);
    for (const element of root.querySelectorAll("script, style")) element.textContent = "";
    return "<!doctype html>" + root.outerHTML;
  }),
).catch(() => late);
if (dom === late || !onSite()) return null;
return { url: primary.url(), dom, settled };`;
const SignedOutRead = Schema.Struct({
  url: Schema.String,
  dom: Schema.String,
  settled: Schema.Boolean,
});
const SignedOutPage = Schema.NullOr(SignedOutRead);

/**
 * The pages a build saw signed out, for its marker checks: the page a sign-in screen is on before
 * anything was typed, and a page a reset left signed out (see `makeBuildStart`). They stay in memory
 * for the build, and are never written or shown to a model. A page that cannot show the site
 * (see `signedOutPageCode`) is skipped, and so is one the host cannot read, such as one whose
 * document is still over 1 MiB: a later check has fewer pages to compare, and with none it reports
 * the signed-out page unchecked. The step that took it does not fail. A page that did not settle
 * may have shown more after the host read it, so it counts where it shows a marker, or leaves it
 * uncertain, and never shows a marker absent.
 */
const makeSignedOutPages = (page: AutofillPage, siteOrigin: string) => {
  const pages: (typeof SignedOutRead.Type)[] = [];
  return {
    /** Keeps the page the primary tab shows now. Returns whether it kept it. */
    take: page.execute(signedOutPageCode(page.targetId, siteOrigin), 15).pipe(
      Effect.flatMap(Schema.decodeUnknown(SignedOutPage)),
      Effect.map((read) => {
        if (read === null) return false;
        pages.push(read);
        if (pages.length > keptPages) pages.shift();
        return true;
      }),
      Effect.orElseSucceed(() => false),
    ),
    /** Every page kept: what each showed, it showed signed out. */
    get pages(): readonly SignedOutSnapshot[] {
      return [...pages];
    },
    /** The pages a check of `marker` compares: each settled one, and any other that may show it. */
    comparedWith: (marker: AutofillSignedIn): readonly SignedOutSnapshot[] =>
      pages.filter(
        (read) => read.settled || matchSignedOutSnapshots(marker, [read]) !== "absent",
      ),
  };
};

/**
 * Browser code that says whether the primary tab shows the direct answer to a form it submitted,
 * with no redirect after it. Opening that address again would send a GET in place of what the
 * form sent, such as a POST, so it may load another page. A history or page that does not answer
 * within 2 seconds counts too.
 */
const formAnswerCode = (targetId: string) => `${primaryPageCode(targetId)}
${withinCode}
const history = await context.newCDPSession(primary);
let submitted = true;
try {
  const read = await within(2000, history.send("Page.getNavigationHistory"));
  if (read !== late) submitted = read.entries[read.currentIndex]?.transitionType === "form_submit";
} finally {
  await history.detach().catch(() => undefined);
}
if (!submitted) return false;
const redirects = await within(
  2000,
  primary.evaluate(() => performance.getEntriesByType("navigation")[0]?.redirectCount ?? 0),
).catch(() => late);
return redirects === late || redirects === 0;`;

/** The most pages a build notes as explored signed in, newest last. */
const keptPaths = 10;

/** A page's path with its query, as the build notes the pages it explored. */
const pathOf = (url: URL) => `${url.pathname}${url.search}`;

/**
 * The local host's `MintDependencies.checkSignedInMarker`, and the pages it compares. It tests the
 * marker against the build's signed-out pages, on the live page as it is, after the host loads
 * the marker's page (`openPath`, else the site's root) again, and on the newest other page the
 * build explored once its sign-in sent the login. It signs nothing in and sends no value. The
 * loads move the primary tab. When the agent's page showed the marker and is not the
 * direct answer to a form, the host then opens its address again, and what that page held only in
 * memory, such as a half-filled form, is gone; otherwise the tab stays where the loads left it, as
 * the tool's text allows. Either way the host reads the page again for the next review. A current
 * page the host cannot read fails the check as unavailable, and so does an address that does not
 * open again, and a check once the write session started: its act steps continue the page as it
 * is.
 */
export const makeMarkerChecks = (input: {
  readonly page: AutofillPage;
  readonly siteOrigin: string;
  /** The live check, on the current page or on `openPath` once the host opened it. */
  readonly check: (indicator: AutofillSignedIn) => Effect.Effect<AutofillSignedInCheck>;
  /**
   * Whether the host typed a sign-in value into this session's browser, in this build or an
   * earlier one. Builds in a session share the browser's cookies, so after that a page may show
   * the site signed in, even before this build's own sign-in.
   */
  readonly typing: SessionTyping;
  /** Whether the build's current sign-in sent the login, or a sign-in of the build is verified. */
  readonly loginSent: () => boolean;
  /** Whether the build's write session started: its act steps continue the page as it is. */
  readonly writeSessionStarted: () => boolean;
  /** Reads the page the tab shows for the next review, once a check moved it. */
  readonly observe: Effect.Effect<void>;
}) => {
  const signedOut = makeSignedOutPages(input.page, input.siteOrigin);
  /** Pages the build explored once its sign-in sent the login, as paths, oldest first. */
  const exploredPaths: string[] = [];
  let firstScreen = true;
  // A page that renders after it loads gets up to 10 seconds to show the marker. Only the first
  // check loads it; each later one reads the page as it is. Any failure but a marker not shown
  // ends the wait.
  const load = (indicator: AutofillSignedIn, path: string) =>
    settledMarkerCheck(input.check, { ...indicator, openPath: path });
  return {
    /**
     * Keeps the page a reset left signed out: one that cleared the browser's cookies and site
     * storage, or one before any sign-in started on the browser.
     */
    afterSignedOutReset: Effect.asVoid(signedOut.take),
    /**
     * Keeps the page a sign-in screen is on, once the host found the screen's fields there and
     * Guardian allowed the step, before the host types: the build's first such page, while the
     * host has typed no sign-in value in this session. Nothing was typed on it, so it shows the
     * site signed out.
     */
    beforeTyping: Effect.suspend(() =>
      !firstScreen || input.typing.typed
        ? Effect.void
        : signedOut.take.pipe(
            Effect.map((kept) => {
              if (kept) firstScreen = false;
            }),
          ),
    ),
    /**
     * A sign-in screen, a rejected value, an approval or a code an exploration typed: the pages
     * explored before it may be screens of the sign-in under way, such as a code's, so none of them
     * is loaded as a signed-in page.
     */
    signInStep: () => {
      exploredPaths.length = 0;
    },
    /**
     * Notes the page an exploration left, once the build's sign-in sent the login. Guardian
     * reviewed that exploration as one that reads, so loading its page again repeats a read. The
     * page an act step left is never noted.
     */
    explored: (url: string | undefined) => {
      const page = URL.parse(url ?? "");
      if (!input.loginSent() || page === null || page.origin !== input.siteOrigin) return;
      const path = pathOf(page);
      const seen = exploredPaths.indexOf(path);
      if (seen !== -1) exploredPaths.splice(seen, 1);
      exploredPaths.push(path);
      if (exploredPaths.length > keptPaths) exploredPaths.shift();
    },
    /** Every page the build kept as signed out, which a sign-in's marker must not show. */
    signedOutPages: (): readonly SignedOutSnapshot[] => signedOut.pages,
    check: (marker: SignedInMarkerCheckRequest): Effect.Effect<SignedInMarkerCheck, MintFailure> =>
      Effect.gen(function* () {
        // The write session's next act step continues the page as it is, so no load may move it.
        if (input.writeSessionStarted())
          return yield* new MintFailure({
            code: "Unavailable",
            failureDetail: failureDetail("mint_host_dependency_failed", {
              operation: "standalone.checkSignedInMarker",
              error: new Error("The write session started, so the check loads no page"),
            }),
          });
        const indicator = { selector: marker.selector, urlPath: marker.urlPath };
        const signedInNow = yield* input.check(indicator);
        if (!signedInNow.signedIn && signedInNow.failed === "page_unavailable")
          return yield* new MintFailure({
            code: "Unavailable",
            failureDetail:
              signedInNow.failureDetail ??
              failureDetail("mint_host_dependency_failed", {
                operation: "standalone.checkSignedInMarker",
                error: new Error("The current page could not be read"),
              }),
          });
        const here = URL.parse(signedInNow.url ?? "");
        // The tab returns to the agent's page only when that page showed the marker, so it is a
        // signed-in page of the site, not a sign-in screen, and its address loads it again: not
        // the direct answer to a form.
        const formAnswer = input.page
          .execute(formAnswerCode(input.page.targetId), 15)
          .pipe(Effect.map((answer) => answer !== false));
        const returnTo =
          signedInNow.signedIn &&
          here !== null &&
          !(yield* Effect.orElseSucceed(formAnswer, () => true))
            ? here
            : undefined;
        // The tool's text: `openPath`, or the site's origin.
        const freshPath = marker.openPath ?? "/";
        const freshLoad = yield* load(indicator, freshPath);
        const fresh = new URL(freshPath, input.siteOrigin);
        // Another page, once the page the agent is on shows the marker: before that, the sign-in
        // may still be under way. Neither the page loaded fresh nor the agent's own page counts.
        const second = !signedInNow.signedIn
          ? undefined
          : exploredPaths.findLast(
              (path) =>
                path !== pathOf(fresh) &&
                (here === null || here.origin !== input.siteOrigin || path !== pathOf(here)),
            );
        const secondPage = second === undefined ? undefined : yield* load(indicator, second);
        const left = (secondPage ?? freshLoad).url;
        const reopened =
          returnTo === undefined || left === returnTo.href
            ? undefined
            : yield* Effect.either(openAutofillLogin({ page: input.page, url: returnTo.href }));
        yield* input.observe;
        // The agent then reads the page, as the tool's failure says, before it checks again.
        if (reopened?._tag === "Left")
          return yield* new MintFailure({
            code: "Unavailable",
            failureDetail: failureDetail("mint_host_dependency_failed", {
              operation: "standalone.checkSignedInMarker.return",
              error: reopened.left,
            }),
          });
        return evaluateSignedInMarker({
          marker: indicator,
          signedOutSnapshots: signedOut.comparedWith(indicator),
          signedInNow,
          freshLoad,
          secondPage,
        });
      }),
  };
};
