import { Data } from "effect";
import { getDomain, getPublicSuffix, parse } from "tldts";

// Site identity: which site a host belongs to. Every site check in this package goes through this
// module, and a unit test refuses a suffix list lookup or a hand-written host suffix check
// anywhere else.
//
// A host's site is its registrable domain (eTLD+1) under the public suffix list, its private
// section included, so each user's page on a hosting suffix such as github.io is its own site. A
// host may add its own private suffixes (`configureSiteIdentity`): under each, every label directly
// below the suffix is its own site in the same way. Where several suffixes match, the longest wins.
// With no added suffix, every result is the public list's alone.
//
// Site identity is not origin identity. An exact origin (scheme, host and port) stays compared as
// an origin wherever a check names one, such as a configured sign-in origin or a payment frame.

/** Why `makeSiteIdentity` refused an entry of `privateSuffixes`. */
export type InvalidPrivateSuffixReason =
  /** Not a string, or an empty one. */
  | "empty"
  /**
   * Not a lower-case host name as `URL` writes it (punycode for an IDN), with no scheme, port,
   * path, wildcard, leading or trailing dot; or an IP address.
   */
  | "invalid"
  /**
   * A name with no registrable domain of its own: a suffix the public suffix list already holds,
   * such as `com`, `co.uk` or `github.io`, or a single label such as `localhost`.
   */
  | "public_suffix";

/** A host-supplied private suffix that `makeSiteIdentity` refused. */
export class InvalidPrivateSuffix extends Data.TaggedError("InvalidPrivateSuffix")<{
  readonly entry: unknown;
  readonly reason: InvalidPrivateSuffixReason;
}> {}

/** What a host adds to the public suffix list. */
export interface SiteIdentityOptions {
  /**
   * Extra private suffixes, each a host name such as `apps.example.test`: every label directly
   * below one, as in `alpha.apps.example.test`, is its own site, and the suffix itself has no
   * registrable domain. Each must sit below a suffix the public list holds and must not be one.
   */
  readonly privateSuffixes?: readonly string[] | undefined;
}

/** Site identity under one suffix configuration. */
export interface SiteIdentity {
  /** The host's added private suffixes, validated, without repeats, in the order given. */
  readonly privateSuffixes: readonly string[];
  /**
   * A host name's registrable domain, or undefined for an IP address, `localhost`, a host that is
   * itself a suffix, and text that is no host name.
   */
  readonly registrableDomain: (hostname: string) => string | undefined;
  /** The site of a URL or host name: its registrable domain, else its host as written. */
  readonly siteOf: (urlOrHost: URL | string) => string;
  /**
   * The registrable domain whose HTTPS hosts `sameSite` accepts for an exact HTTPS site origin.
   * Undefined for any other origin text and for a host with no registrable domain (an IP address,
   * localhost or a bare suffix such as github.io), whose site is only its own host.
   */
  readonly siteDomain: (siteOrigin: string) => string | undefined;
  /**
   * Whether `url` is an HTTPS URL on the same site as the authorized exact HTTPS site origin:
   * apex, www and sibling subdomains of its registrable domain, never another site under a
   * suffix below it. The site's own registrable domain is always allowed, sign-in included.
   */
  readonly sameSite: (authorizedSiteOrigin: string | undefined, url: URL) => boolean;
  /**
   * JavaScript source of a page-side predicate `(hostname) => boolean`: whether a lower-case host
   * name is `domain` or below it, leaving out every host under an added private suffix at or below
   * `domain`, which is another site. Page code has no suffix list, so a host builds it here from
   * the site it computed. With no such suffix it is the plain `host === domain` or `.domain` test.
   */
  readonly hostOnSiteSource: (domain: string) => string;
  /**
   * The added private suffixes at or below `domain`: every host that is one of them or below one
   * is another site than `domain`, though its name ends in `domain`. Empty with no added suffix.
   */
  readonly separateSuffixes: (domain: string) => readonly string[];
}

const labelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/**
 * The host name a suffix match reads, as the public list's lookup reads it: taken out of a URL or
 * `host:port` the same way, in lower case with no trailing dots. Undefined for anything with an
 * empty label, such as a leading dot, so an added suffix never matches text that is no host name.
 */
const normalHost = (input: string) => {
  const host = parse(input, { allowPrivateDomains: true })
    .hostname?.toLowerCase()
    .replace(/\.+$/u, "");
  return host === undefined || host.split(".").includes("") ? undefined : host;
};

const labelCount = (name: string) => (name === "" ? 0 : name.split(".").length);

const validSuffix = (entry: unknown): string => {
  if (typeof entry !== "string" || entry === "")
    throw new InvalidPrivateSuffix({ entry, reason: "empty" });
  const labels = entry.split(".");
  if (
    entry.length > 253 ||
    !labels.every((label) => labelPattern.test(label)) ||
    /^\d+$/u.test(labels.at(-1) ?? "") ||
    URL.parse(`https://${entry}/`)?.hostname !== entry
  )
    throw new InvalidPrivateSuffix({ entry, reason: "invalid" });
  if (getDomain(entry, { allowPrivateDomains: true }) === null)
    throw new InvalidPrivateSuffix({ entry, reason: "public_suffix" });
  return entry;
};

/**
 * Site identity under the public suffix list, private section included, plus `options`'
 * `privateSuffixes`. Throws `InvalidPrivateSuffix` for an entry that is empty, not a host name,
 * or itself a listed suffix.
 */
export const makeSiteIdentity = (options: SiteIdentityOptions = {}): SiteIdentity => {
  const privateSuffixes = [...new Set((options.privateSuffixes ?? []).map(validSuffix))];

  const registrableDomain = (hostname: string): string | undefined => {
    const listed = getDomain(hostname, { allowPrivateDomains: true });
    if (listed === null) return undefined;
    if (privateSuffixes.length === 0) return listed;
    const host = normalHost(hostname);
    // A host that is itself an added suffix has no registrable domain, as a bare listed one has
    // none; neither has text the list reads a domain in but that is no host name.
    if (host === undefined || privateSuffixes.includes(host)) return undefined;
    const added = privateSuffixes
      .filter((suffix) => host.endsWith(`.${suffix}`))
      .reduce((longest, suffix) => (labelCount(suffix) > labelCount(longest) ? suffix : longest), "");
    const listedSuffix = getPublicSuffix(hostname, { allowPrivateDomains: true }) ?? "";
    if (labelCount(added) <= labelCount(listedSuffix)) return listed;
    return host
      .split(".")
      .slice(-(labelCount(added) + 1))
      .join(".");
  };

  const hostOf = (urlOrHost: URL | string) =>
    typeof urlOrHost === "string" ? urlOrHost : urlOrHost.hostname;

  const siteOf = (urlOrHost: URL | string) =>
    registrableDomain(hostOf(urlOrHost)) ?? hostOf(urlOrHost);

  const siteDomain = (siteOrigin: string) => {
    const url = URL.parse(siteOrigin);
    if (url === null || url.protocol !== "https:" || url.origin !== siteOrigin) return undefined;
    return registrableDomain(url.hostname);
  };

  const sameSite = (authorizedSiteOrigin: string | undefined, url: URL) => {
    if (authorizedSiteOrigin === undefined || url.protocol !== "https:") return false;
    const authorized = URL.parse(authorizedSiteOrigin);
    return (
      authorized !== null &&
      authorized.protocol === "https:" &&
      authorized.origin === authorizedSiteOrigin &&
      siteOf(authorized.hostname) === siteOf(url.hostname)
    );
  };

  const separateSuffixes = (domain: string) =>
    privateSuffixes.filter((suffix) => suffix === domain || suffix.endsWith(`.${domain}`));

  const hostOnSiteSource = (domain: string) => {
    const site = JSON.stringify(domain);
    const below = separateSuffixes(domain);
    return below.length === 0
      ? `((host) => host === ${site} || host.endsWith("." + ${site}))`
      : `((host) => host === ${site} || (host.endsWith("." + ${site}) && !${JSON.stringify(below)}.some((suffix) => host === suffix || host.endsWith("." + suffix))))`;
  };

  return {
    privateSuffixes,
    registrableDomain,
    siteOf,
    siteDomain,
    sameSite,
    hostOnSiteSource,
    separateSuffixes,
  };
};

let configured = makeSiteIdentity();

/**
 * Sets the process's site identity: the public suffix list plus the host's own private suffixes.
 * A host calls it once at startup, before any site check, with the list its own configuration
 * names; every site check in this package then reads it. Each process, and each bundle with its
 * own copy of this module, that runs site checks configures it. Throws `InvalidPrivateSuffix`, keeping
 * the identity in force, when an entry is refused. With no suffixes it restores the default, the
 * public list alone.
 */
export const configureSiteIdentity = (options: SiteIdentityOptions): SiteIdentity => {
  configured = makeSiteIdentity(options);
  return configured;
};

/** The process's site identity, as `configureSiteIdentity` last set it. */
export const siteIdentity = (): SiteIdentity => configured;

/** `SiteIdentity.registrableDomain` under the process's site identity. */
export const registrableDomain = (hostname: string): string | undefined =>
  configured.registrableDomain(hostname);

/** `SiteIdentity.siteOf` under the process's site identity. */
export const siteOf = (urlOrHost: URL | string): string => configured.siteOf(urlOrHost);

/** `SiteIdentity.siteDomain` under the process's site identity. */
export const siteDomain = (siteOrigin: string): string | undefined =>
  configured.siteDomain(siteOrigin);

/** `SiteIdentity.sameSite` under the process's site identity. */
export const sameSite = (authorizedSiteOrigin: string | undefined, url: URL): boolean =>
  configured.sameSite(authorizedSiteOrigin, url);

/** `SiteIdentity.separateSuffixes` under the process's site identity. */
export const separateSuffixes = (domain: string): readonly string[] =>
  configured.separateSuffixes(domain);

/** `SiteIdentity.hostOnSiteSource` under the process's site identity. */
export const hostOnSiteSource = (domain: string): string => configured.hostOnSiteSource(domain);

/**
 * Whether the public suffix list, ICANN or private section, lists the suffix `hostname` sits
 * under, rather than only its default rule for an unknown top-level label. Added private suffixes
 * never count: they change where one site ends, not which names are public.
 */
export const publicSuffixListed = (hostname: string): boolean => {
  const { isIcann, isPrivate } = parse(hostname, { allowPrivateDomains: true });
  return isIcann === true || isPrivate === true;
};
