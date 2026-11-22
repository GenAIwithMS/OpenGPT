import { sameSite, siteDomain } from "./same-site.js";

// Where a sign-in may move off the site's own host: a per-account workspace host on the site's
// registrable domain. Every rule here is deterministic host code; a Guardian review may narrow
// it, never widen it.

/** A recipe's workspace relation: its sign-in may move to a per-account host on `parent`. */
export interface WorkspaceRelation {
  /** The registrable domain of the tool's site origin. */
  readonly parent: string;
}

/** An exact https origin with no user name, password or path: `new URL(value).origin === value`. */
const exactHttpsOrigin = (value: string) => {
  const url = URL.parse(value);
  return url !== null &&
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.origin === value
    ? url
    : undefined;
};

/**
 * Whether `candidate` may be a per-account workspace origin of the site at `siteOrigin`: an exact
 * https origin with no user info or path, on the registrable domain `parent` (public suffix list,
 * private suffixes included, as `sameSite` reads it), where `parent` is the site's own registrable
 * domain, on another host than the site's and on the site's own port (a site on the default port
 * admits no explicit port). A site with no registrable domain, such as a host that is itself a
 * suffix, has no workspace host.
 */
export const workspaceHost = (siteOrigin: string, parent: string, candidate: string): boolean => {
  const site = exactHttpsOrigin(siteOrigin);
  const url = exactHttpsOrigin(candidate);
  if (site === undefined || url === undefined) return false;
  // A workspace host is named by its host alone: it runs on the site's own port.
  if (url.port !== site.port) return false;
  const domain = siteDomain(siteOrigin);
  if (domain === undefined || domain !== parent) return false;
  if (siteDomain(candidate) !== parent) return false;
  if (url.hostname === site.hostname) return false;
  // There is deliberately no rule on the shape of the host's labels (such as accepting only one
  // label below `parent`), so `a.b.example.com` passes like `acme.example.com`. Add such a rule
  // here, and only here, if it is wanted.
  return true;
};

/**
 * The recipe's workspace relation when it is valid for `siteOrigin`: its `parent` is the site's
 * registrable domain. Undefined otherwise, and every workspace step is then refused.
 */
export const workspaceRelation = (
  recipe: { readonly version: number; readonly workspace?: WorkspaceRelation | undefined },
  siteOrigin: string,
): WorkspaceRelation | undefined => {
  const parent = recipe.workspace?.parent;
  return parent !== undefined && parent === siteDomain(siteOrigin) ? { parent } : undefined;
};

/** A login's pinned workspace origin when it passes `workspaceHost` under a valid relation. */
export const pinnedWorkspaceOrigin = (
  siteOrigin: string,
  relation: WorkspaceRelation | undefined,
  pinned: string | undefined,
): string | undefined =>
  relation !== undefined &&
  pinned !== undefined &&
  workspaceHost(siteOrigin, relation.parent, pinned)
    ? pinned
    : undefined;

/** A recorded screen: an exact page, or a workspace screen's path. */
export interface RecordedScreen {
  readonly origin?: "workspace" | undefined;
  readonly page: string;
}

/**
 * The origin a recorded screen runs on: an exact page's own origin, or for a workspace screen the
 * replay's workspace origin, undefined while it has none.
 */
export const recordedScreenOrigin = (
  step: RecordedScreen,
  workspaceOrigin: string | undefined,
): string | undefined =>
  step.origin === "workspace" ? workspaceOrigin : (URL.parse(step.page)?.origin ?? undefined);

/**
 * A recorded screen's page as a live page is compared with it, origin and path: a workspace
 * screen's path on the replay's workspace origin, or the path alone while it has none, which
 * matches no live page.
 */
export const recordedScreenPage = (step: RecordedScreen, workspaceOrigin: string | undefined) =>
  step.origin === "workspace" && workspaceOrigin !== undefined
    ? `${workspaceOrigin}${step.page}`
    : step.page;

/** What one replay knows when it judges a live screen's origin. */
export interface ScreenOriginContext {
  readonly siteOrigin: string;
  /** The recipe's relation, valid for the site (`workspaceRelation`). */
  readonly relation: WorkspaceRelation | undefined;
  /** The login's pinned workspace origin, valid for the site (`pinnedWorkspaceOrigin`). */
  readonly pinned: string | undefined;
  /** The workspace origin this replay already admitted, if any. */
  readonly candidate: string | undefined;
  /**
   * Whether this replay already submitted the login's identifier on an exact-origin screen (the
   * shared host or a configured sign-in origin), after which only the site navigated.
   */
  readonly identifierSent: boolean;
}

/** Why a live screen's origin was refused. */
export type ScreenOriginRefusal = "workspace_unverified" | "screen_origin_changed";

/**
 * A live screen's origin admitted for a recorded screen, with the workspace origin it taught this
 * replay when it is a new one, or refused. `sibling` marks a refused origin on the site's own
 * registrable domain, which a host reports by the public role `unrecognized_sibling` and keeps the
 * origin itself private.
 */
export type ScreenOriginAdmission =
  | { readonly admitted: true; readonly learned?: string }
  | { readonly admitted: false; readonly reason: ScreenOriginRefusal; readonly sibling: boolean };

/**
 * An identifier-first sign-in may continue on a workspace host the site sent it to once this
 * replay submitted the login's identifier on an exact-origin screen.
 * A replay learns at most one host this way: a second, different one shown after it has no new
 * identifier behind it. Change this one predicate to tighten or drop the rule.
 */
const identifierAnchorAdmits = (context: ScreenOriginContext) =>
  context.identifierSent && context.candidate === undefined;

const refused = (
  context: ScreenOriginContext,
  live: string,
  reason: ScreenOriginRefusal,
): ScreenOriginAdmission => {
  const url = URL.parse(live);
  return { admitted: false, reason, sibling: url !== null && sameSite(context.siteOrigin, url) };
};

/**
 * Whether a live screen on `live` (an origin) may run the recorded screen `step`.
 *
 * An exact recorded screen runs on its own origin, or on the login's pinned workspace when the
 * recipe has a relation (the shared sign-in sent this login to its own workspace). A workspace
 * host seen there without a pinned one, or another than the pinned one before this replay sent
 * the login's identifier, is `workspace_unverified`: this login sent nothing that explains it, so
 * it may be leftover cookies, a link or another workspace the site remembers.
 *
 * A workspace screen runs on the replay's workspace origin (the one it admitted, else the pinned
 * one), or on a new workspace host once the identifier anchor admits it, which this replay then
 * learns. Any other workspace host is `workspace_unverified`. Everything else is
 * `screen_origin_changed`.
 */
export const admitScreenOrigin = (
  context: ScreenOriginContext,
  step: RecordedScreen,
  live: string,
): ScreenOriginAdmission => {
  const { relation, siteOrigin } = context;
  const sibling = relation !== undefined && workspaceHost(siteOrigin, relation.parent, live);
  if (step.origin === "workspace")
    return relation === undefined
      ? refused(context, live, "screen_origin_changed")
      : admitWorkspaceScreen(context, live, sibling);
  return admitExactScreen(context, step, live, sibling);
};

/** An exact recorded screen: its own origin, or the login's pinned workspace under a relation. */
const admitExactScreen = (
  context: ScreenOriginContext,
  step: RecordedScreen,
  live: string,
  sibling: boolean,
): ScreenOriginAdmission => {
  const { relation, pinned } = context;
  if (live === recordedScreenOrigin(step, undefined)) return { admitted: true };
  if (relation !== undefined && pinned !== undefined && live === pinned) return { admitted: true };
  if (sibling && (pinned === undefined || !context.identifierSent))
    return refused(context, live, "workspace_unverified");
  return refused(context, live, "screen_origin_changed");
};

/** A workspace screen: the replay's workspace origin, or a new one the identifier anchor admits. */
const admitWorkspaceScreen = (
  context: ScreenOriginContext,
  live: string,
  sibling: boolean,
): ScreenOriginAdmission => {
  if (live === (context.candidate ?? context.pinned)) return { admitted: true };
  if (sibling && identifierAnchorAdmits(context)) return { admitted: true, learned: live };
  if (sibling) return refused(context, live, "workspace_unverified");
  return refused(context, live, "screen_origin_changed");
};

/** What one replay knows when it decides where its signed-in check runs. */
export interface SignedInCheckContext {
  readonly siteOrigin: string;
  readonly relation: WorkspaceRelation | undefined;
  readonly pinned: string | undefined;
  /** The workspace origin this replay learned through the identifier anchor, if any. */
  readonly candidate: string | undefined;
  /** The current page's origin, if known. */
  readonly current: string | undefined;
  /**
   * Whether this replay sent the login's password or code on an exact-origin screen, one whose
   * live origin was its recorded origin.
   */
  readonly credentialsSent: boolean;
}

/**
 * Where the signed-in check opens the recipe's `openPath`. Without a relation, the site origin.
 * With one: the workspace origin this replay admitted; else the current page's origin when it is a
 * workspace host and there is no pinned origin, it is the pinned one, or this replay sent the
 * login's credentials on an exact-origin screen; else the pinned origin; else the site origin.
 */
export const signedInCheckOrigin = (input: SignedInCheckContext): string => {
  const { siteOrigin, relation, pinned, candidate, current } = input;
  if (relation === undefined) return siteOrigin;
  if (candidate !== undefined) return candidate;
  if (
    current !== undefined &&
    workspaceHost(siteOrigin, relation.parent, current) &&
    (pinned === undefined || current === pinned || input.credentialsSent)
  )
    return current;
  return pinned ?? siteOrigin;
};

/**
 * The workspace origin a verified sign-in pins to its login: the signed-in check's origin
 * (`signedInCheckOrigin`) when the recipe has a valid relation, that origin is a workspace host
 * other than the site's, and this login's own sign-in explains it: it is the pinned one, the one
 * this replay learned through the identifier anchor, or the site moved there after this replay
 * sent the login's credentials on an exact-origin screen. A workspace host the session merely
 * shows, with no pin and nothing sent, may be this run's check origin but never becomes the
 * login's.
 */
export const workspaceToPin = (input: SignedInCheckContext): string | undefined => {
  const { siteOrigin, relation, pinned, candidate } = input;
  const at = signedInCheckOrigin(input);
  if (relation === undefined || !workspaceHost(siteOrigin, relation.parent, at)) return undefined;
  return at === candidate || at === pinned || input.credentialsSent ? at : undefined;
};

/** How many layers of percent-encoding a carried address is read through before it is refused. */
const maxEncodingLayers = 4;

/** One layer of percent-encoding read as a site reads a parameter, or undefined when malformed. */
const decodedOnce = (text: string) => {
  try {
    return decodeURIComponent(text.replaceAll("+", " "));
  } catch {
    return undefined;
  }
};

/** The ideographic full stop and its fullwidth and halfwidth forms, which a host may read as ".". */
const otherFullStops = /[\u3002\uFF0E\uFF61]/gu;

/**
 * Whether a login URL's path, query or fragment names another address, as a site's redirect
 * parameter (`?next=https://...`) or a redirect path (`/r/evil.example.com/`) does: an absolute or
 * protocol-relative URL, a backslash, or a host on `parent`, the site's registrable domain, read
 * through its percent-encoding as the site would, with compatibility forms such as fullwidth
 * letters read as their plain ones (NFKC) and any other full stop read as ".". The URL's own host
 * is never read.
 * Text that fails to decode, or that is still encoded after `maxEncodingLayers` layers, counts as
 * naming one. A recipe with a workspace relation opens no such login URL: the site could send
 * every account's sign-in on to a host the URL chose, after the identifier.
 */
export const entryNamesAddress = (loginUrl: string, parent: string): boolean => {
  const url = URL.parse(loginUrl);
  if (url === null) return true;
  let carried = `${url.pathname}${url.search}${url.hash}`;
  for (let layer = 0; ; layer++) {
    const next = decodedOnce(carried);
    if (next === undefined || (next !== carried && layer === maxEncodingLayers)) return true;
    if (next === carried) break;
    carried = next;
  }
  const text = carried.normalize("NFKC").replace(otherFullStops, ".").toLowerCase();
  if (text.includes("//") || text.includes("\\")) return true;
  const domain = parent.toLowerCase().replaceAll(".", "\\.");
  return new RegExp(`(?:^|[^a-z0-9-])(?:[a-z0-9-]+\\.)*${domain}(?:$|[^a-z0-9-])`, "u").test(text);
};
