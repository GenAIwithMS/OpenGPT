import { domainToUnicode } from "node:url";
import { Schema } from "effect";
import { trustableSignInUrl } from "../runtime/sign-in-origins.js";

/**
 * What page code reports of where the page went from a host's click of a submit until it settled:
 * the primary page's whole address at the click (`clicked`), the origin of each navigation of its
 * main frame in order, server redirects included, when the document it settled on began loading
 * (`performance.timeOrigin`) and that document's title. It never leaves the fill call: the host
 * reports only the `SiteNavigation` made from it (`reportedNavigation`).
 */
export const PageNavigation = Schema.Struct({
  clicked: Schema.String,
  origins: Schema.Array(Schema.String),
  document: Schema.optional(Schema.Number),
  title: Schema.optional(Schema.String),
});
export type PageNavigation = typeof PageNavigation.Type;

/**
 * Where the page went on its own from a host's click of a sign-in step's submit until it settled.
 * Host-only: the page chose all of it after the host typed, so the host never logs, keeps or
 * forwards it, and screens what it shows a review as it would the page's own text.
 */
export const SiteNavigation = Schema.Struct({
  /** The origin of the page whose submit the host clicked, as page code read it at the click. */
  from: Schema.String,
  /** That page's path at the click, without its query or fragment. */
  fromPathname: Schema.optional(Schema.String),
  /** The origin of each navigation of the primary tab's main frame from the click, in order. */
  origins: Schema.Array(Schema.String),
  /** When the document the page settled on began loading (`performance.timeOrigin`). */
  document: Schema.optional(Schema.Number),
  /** The settled page's path, without its query or fragment. */
  pathname: Schema.optional(Schema.String),
  /** The settled page's title, at most `titleLimit` code points. */
  title: Schema.optional(Schema.String),
});
export type SiteNavigation = typeof SiteNavigation.Type;

/** The most navigations a redirect chain may hold for a sign-in to carry its trust along it. */
export const maximumRedirectHops = 10;

/** The most code points of the settled page's title a host reports. */
export const titleLimit = 200;

/** `text` with each percent-encoded run decoded, three times over; a malformed run stays. */
const decoded = (text: string) => {
  let read = text;
  for (let round = 0; round < 3; round += 1)
    read = read.replace(/(?:%[0-9a-f]{2})+/giu, (run) => {
      try {
        return decodeURIComponent(run);
        // error-reporting-allow: typed-recovery a malformed percent run is compared as written
      } catch {
        return run;
      }
    });
  return read;
};

/** Letters and digits alone, lower-cased: a value however a page splits or joins it. */
const squeezed = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

/**
 * Whether `text`, which a page chose after typing, holds any of `values`: as typed or
 * percent-encoded, in any case, or by its letters and digits alone, so a value split across a
 * host's labels, or an email whose `@` became a dot, still counts.
 */
const holdsValue = (text: string, values: readonly string[]) => {
  const read = decoded(text);
  const lower = `${text}\n${read}`.toLowerCase();
  const letters = squeezed(read);
  return values.some((value) => {
    if (value === "") return false;
    if ([value, encodeURIComponent(value)].some((form) => lower.includes(form.toLowerCase())))
      return true;
    const squeezedValue = squeezed(value);
    return squeezedValue !== "" && letters.includes(squeezedValue);
  });
};

/** An origin's host as `URL` writes it and, for an internationalized name, in Unicode. */
const hostForms = (origin: string) => {
  const url = URL.parse(origin);
  if (url === null) return undefined;
  const unicode = domainToUnicode(url.hostname);
  return unicode === "" || unicode === url.hostname ? [url.hostname] : [url.hostname, unicode];
};

/**
 * Whether the clicked page's own address, past its origin, spells a host the chain went to other
 * than its own or one already trusted, as an open redirect's parameter (`?next=`, `#return=`) does:
 * as written, or by its letters and digits alone, so a fullwidth host, an ideographic full stop or
 * escaped dots still count. A destination chosen any other way, by a form field, a cookie, a script
 * or the server's own state, is not spelled there, so this never shows the site chose the host.
 */
const namesHop = (clicked: URL, origins: readonly string[], trusted: readonly string[]) => {
  const rest = decoded(`${clicked.pathname}${clicked.search}${clicked.hash}`);
  const lower = rest.toLowerCase();
  const letters = squeezed(rest);
  return origins.some((origin) => {
    const url = URL.parse(origin);
    if (url === null) return true;
    if (url.hostname === clicked.hostname || trusted.includes(url.origin)) return false;
    return (hostForms(origin) ?? []).some((form) => {
      const squeezedForm = squeezed(form);
      return (
        lower.includes(form.toLowerCase()) ||
        (squeezedForm !== "" && letters.includes(squeezedForm))
      );
    });
  });
};

/**
 * What a host reports of where a clicked submit's page went (`SiteNavigation`), from page code's
 * `PageNavigation`, the address the page settled on (`url`) and every value the sign-in typed on
 * this browser so far (`typed`); undefined, so nothing carries, when:
 * - a host of the chain holds a typed value in any form `holdsValue` reads, its Unicode form for an
 *   internationalized name included;
 * - or the clicked page's own address spells a host the chain went to other than its own and
 *   those in `trusted` (`namesHop`): a destination the address chose is an open redirect's, so it
 *   never reaches a host's review. One chosen any other way still does.
 * A path or title that holds a typed value is left out on its own; a title is checked whole before
 * it is cut to `titleLimit` code points. Neither path keeps a query or fragment.
 */
export const reportedNavigation = (input: {
  readonly page: PageNavigation;
  readonly url: string;
  readonly typed: readonly string[];
  readonly trusted: readonly string[];
}): SiteNavigation | undefined => {
  const { page, typed } = input;
  const clicked = URL.parse(page.clicked);
  if (clicked === null) return undefined;
  const hosts = page.origins.map(hostForms);
  if (hosts.some((forms) => forms === undefined || forms.some((form) => holdsValue(form, typed))))
    return undefined;
  if (namesHop(clicked, page.origins, input.trusted)) return undefined;
  const shown = (text: string | undefined) =>
    text === undefined || text === "" || holdsValue(text, typed) ? undefined : text;
  const fromPathname = shown(clicked.pathname);
  const pathname = shown(URL.parse(input.url)?.pathname);
  // Checked whole, then cut by code point, so a value across the cut leaves no piece of itself.
  const whole = shown(page.title?.trim());
  const title = whole === undefined ? undefined : Array.from(whole).slice(0, titleLimit).join("");
  return {
    from: clicked.origin,
    ...(fromPathname === undefined ? {} : { fromPathname }),
    origins: page.origins,
    ...(page.document === undefined ? {} : { document: page.document }),
    ...(pathname === undefined ? {} : { pathname }),
    ...(title === undefined ? {} : { title }),
  };
};

/**
 * The origin a sign-in may carry its trust to, from a trusted screen it submitted on `from`, when
 * the live page is where the site's own navigation from that submit settled, else undefined:
 * - the navigation is that screen's submit's: page code read `from`'s origin at the click;
 * - the host's click started a chain of at most `maximumRedirectHops` navigations, each https;
 * - the chain ended on the live page's origin, another than `from`'s;
 * - the live page is still the document the chain settled on (the same `performance.timeOrigin`),
 *   so nothing navigated it since, the minter's own steps included;
 * - and the live page is an address a host may trust for a sign-in at all (`trustableSignInUrl`).
 * A navigation the page made after the click's settle wait, such as a script's later redirect, is
 * a new document, so it carries nothing and the screen is judged as before.
 */
export const redirectCandidate = (input: {
  readonly from: string;
  readonly navigated: SiteNavigation;
  readonly live: { readonly url: string; readonly document?: number | undefined };
}): string | undefined => {
  const { origins, document } = input.navigated;
  if (URL.parse(input.from)?.origin !== input.navigated.from) return undefined;
  if (origins.length === 0 || origins.length > maximumRedirectHops) return undefined;
  if (document === undefined || input.live.document !== document) return undefined;
  if (!origins.every((origin) => URL.parse(origin)?.protocol === "https:")) return undefined;
  const live = URL.parse(input.live.url);
  if (live === null || !trustableSignInUrl(live)) return undefined;
  if (live.origin !== origins.at(-1) || live.origin === input.navigated.from) return undefined;
  return live.origin;
};
