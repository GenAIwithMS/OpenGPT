import { publicSuffixListed, sameSite, siteDomain } from "./same-site.js";

/**
 * Whether a URL is on the site or one of its configured sign-in origins, with no user name or
 * password in it: where the host types a sign-in's values.
 */
export const trustedUrl = (
  siteOrigin: string,
  authenticationOrigins: readonly string[],
  value: string,
) => {
  const url = URL.parse(value);
  return (
    url !== null &&
    !url.username &&
    !url.password &&
    (authenticationOrigins.includes(url.origin) || sameSite(siteOrigin, url))
  );
};

/**
 * Top-level labels whose names the public suffix list holds as ICANN yet no public website signs
 * in under: `arpa` (such as home.arpa and in-addr.arpa) and `onion`.
 */
const unsignedTopLevels = new Set(["arpa", "onion"]);

/**
 * Whether a host may trust `url` for a sign-in step beyond the site and its configured sign-in
 * origins (`trustSignInUrl`): an https address with no user name or password, on a host with a
 * registrable domain under a listed public suffix. Never plain http, an IP address, localhost, a
 * bare public suffix such as github.io, a name only a private network resolves, such as one under
 * .localhost, .internal, .local, .test or .invalid, or a host under .arpa or .onion. The host's own
 * predicate is asked only about a URL that passes this.
 */
export const trustableSignInUrl = (url: URL) => {
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (siteDomain(url.origin) === undefined) return false;
  // Every trailing dot, as the public suffix list's lookup ignores them all.
  const topLevel = url.hostname.replace(/\.+$/u, "").split(".").at(-1) ?? "";
  if (unsignedTopLevels.has(topLevel)) return false;
  return publicSuffixListed(url.hostname);
};
