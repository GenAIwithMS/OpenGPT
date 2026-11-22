import { Either, Schema } from "effect";
import { SignInRecipe, type SignInRecipeStep } from "../destinations/sign-in-recipe.js";
import { pageMatches } from "../destinations/autofill-recipe.js";
import {
  loginPathRefusal,
  matchSignedOutSnapshots,
  type SignedOutSnapshot,
} from "../destinations/signed-in-marker.js";
import { oneTimeLoginUrlParameters } from "./login-url.js";
import { namesIdentityOrPrivateMask, namesMaskedContact } from "./sign-in-guards.js";
import { registrableDomain, sameSite } from "../runtime/same-site.js";
import { workspaceRelation } from "../runtime/workspace-origin.js";

// A sign-in recipe version checked as a unit: one value-free recipe that every run signing in to
// the site replays. The checks are deterministic and name each refused part by its path in the
// version, never its value.

/**
 * One version of a site's sign-in, value-free: where every run starts and the recipe it replays
 * (every screen and its selectors, the signed-in marker, and for version 4 or 5 its workspace
 * relation). It runs on https origins of the site itself, and a workspace step on each login's
 * own workspace host on the site's registrable domain, which it names by path only.
 */
export interface SignInVersion {
  readonly entryUrl: string;
  readonly recipe: SignInRecipe;
}

export interface SignInVersionInput {
  /** The exact https origin of the site the version signs in to. */
  readonly siteOrigin: string;
  readonly version: SignInVersion;
  /** Pages the host saw before any sign-in sent a value, which the marker must not match. */
  readonly signedOutSnapshots: readonly SignedOutSnapshot[];
  /**
   * Identity values the host knows for the account that recorded the version, such as its
   * username, email, phone or account number. No part of a version may name one; none is ever
   * returned. The identity rules apply to the values a caller passes, and to the `[private]`
   * placeholder whatever it passes: a host that no longer holds them, because it applied identity
   * guards of its own to each screen while it recorded the sign-in, passes none.
   */
  readonly identities?: readonly string[] | undefined;
  /**
   * Whether the host already asked about this entry URL as one authorization request, and the
   * build kept it: `one_time_url` then does not refuse it.
   */
  readonly entryUrlAsked?: boolean | undefined;
}

/** The checks' rules, each a reason a version is refused. */
export type SignInVersionRule =
  // The recipe is not one a host reads (`SignInRecipe`), such as one with no steps or a workspace
  // step whose page is more than a path. No other check runs on it.
  | "invalid_recipe"
  // A selector names an account's identity, or copies a masked or partial contact or number.
  | "selector_names_contact"
  // The entry URL, a page or a popup does, past its origin or in a host label below the site's
  // registrable domain. Past an entry URL the host already asked about (`entryUrlAsked`), only
  // its path is read for a masked number, since its query and fragment hold spent one-time values.
  | "page_names_contact"
  // The signed-in marker does.
  | "indicator_holds_identity"
  // The marker has neither a selector nor a URL path.
  | "marker_missing"
  // The marker is a URL path alone that a sign-in page also has.
  | "marker_is_login_path"
  // A page seen signed out shows the marker.
  | "marker_matches_signed_out_page"
  // A step's submit, method or page, or the account page the marker opens, signs out.
  | "sign_out"
  // The entry URL is one authorization request, which no later run can open again, and the host
  // did not already ask about it (`entryUrlAsked`).
  | "one_time_url"
  // The entry URL carries a user name or password.
  | "url_credentials"
  // The recipe's workspace relation names another domain than the site's registrable domain.
  | "workspace_parent"
  // The entry URL, a page or a popup is not https, wherever it is.
  | "insecure_origin"
  // The entry URL, a page or a popup is not on the site's registrable domain, or a workspace step
  // has no workspace relation for the site. Off-site sign-in pages are reported under this rule
  // alone, so a host that permits sign-in on another site's origin, such as an identity
  // provider's, drops this rule's findings itself and still gets every other rule, https
  // included. A workspace step without a valid relation is also refused as `workspace_parent`.
  | "foreign_origin"
  // A step lists segments written as `*` (version 7's `anySegments`) on a page off the site's own
  // origin that is no workspace step, such as another site's sign-in, or on the page the entry URL
  // opens, which a run opens rather than matches.
  | "wildcard_placement";

/** A refused part, by its path in the version, such as `recipe.steps[2].submit`. */
export interface SignInVersionFinding {
  readonly rule: SignInVersionRule;
  readonly part: string;
}

interface Text {
  readonly part: string;
  readonly text: string;
}

const stepSelectors = (step: SignInRecipeStep, at: string): Text[] => [
  ...(step.rejectedMarkers ?? []).map((marker, index) => ({
    part: `${at}.rejectedMarkers[${index}].selector`,
    text: marker.selector,
  })),
  ...step.fields.flatMap((field, index) => [
    { part: `${at}.fields[${index}].selector`, text: field.selector },
    ...("questionSelector" in field && field.questionSelector !== undefined
      ? [{ part: `${at}.fields[${index}].questionSelector`, text: field.questionSelector }]
      : []),
  ]),
  ...(step.submit === undefined ? [] : [{ part: `${at}.submit`, text: step.submit }]),
  ...(step.methods ?? []).map((option, index) => ({
    part: `${at}.methods[${index}].selector`,
    text: option.selector,
  })),
];

/** What a page names past its origin: a path's path, an absolute URL's path, query and fragment. */
const pastOrigin = (page: string) => {
  if (page.startsWith("/") && !page.startsWith("//")) return page;
  const url = URL.parse(page);
  return url === null ? page : `${url.pathname}${url.search}${url.hash}`;
};

/**
 * The host labels of a URL or origin below its registrable domain, such as `jane` in
 * `https://jane.example.com`, read from `registrableDomain`'s label count; empty when it has none
 * or does not parse.
 */
const belowDomain = (value: string) => {
  const host = (URL.parse(value)?.hostname ?? "").replace(/\.+$/u, "");
  const domain = registrableDomain(host);
  if (domain === undefined) return "";
  const labels = host.split(".");
  return labels.slice(0, Math.max(0, labels.length - domain.split(".").length)).join(".");
};

/** Sign-out words, with camel case split so `signOutButton` reads as `sign Out Button`. */
const signsOut = (text: string) =>
  /\b(?:log|sign)[\s_-]?(?:out|off)\b/iu.test(text.replace(/([a-z])([A-Z])/gu, "$1 $2"));

/** Whether `value`, a URL or an origin, is https. */
const secure = (value: string) => URL.parse(value)?.protocol === "https:";

/**
 * Whether `value`, a URL or an origin, is on the site at `siteOrigin`, its registrable domain
 * (`sameSite`), whatever its scheme: `secure` judges that on its own.
 */
const onSite = (siteOrigin: string, value: string) => {
  const url = URL.parse(value);
  if (url === null) return false;
  if (url.protocol === "http:") url.protocol = "https:";
  return url.protocol === "https:" && sameSite(siteOrigin, url);
};

/**
 * The deterministic checks of a version: every selector and page against the recording guards
 * (the recording account's identity values and the masked-contact pattern), the signed-in marker
 * against the pages seen signed out and the sign-in's own pages, no sign-out, an entry URL any
 * later run can open, and every page https and on the site itself or, for a workspace step, on a
 * workspace host the recipe's relation admits (`workspaceRelation`). Each refused part once per
 * rule, in the version's order; empty when the version passes.
 */
export const checkSignInVersion = (
  input: SignInVersionInput,
): readonly SignInVersionFinding[] => {
  const { siteOrigin, version, signedOutSnapshots } = input;
  // The version may come from storage or another process: check what it holds, not its type.
  const decoded = Schema.decodeUnknownEither(SignInRecipe)(version.recipe);
  if (Either.isLeft(decoded)) return [{ rule: "invalid_recipe", part: "recipe" }];
  const recipe = decoded.right;
  const values = (input.identities ?? []).flatMap((value) =>
    value.length < 3 ? [] : [value.toLowerCase()],
  );
  // An address may carry a value percent-encoded, such as an email's `@` as `%40`.
  const pageValues = [
    ...values,
    ...values.map((value) => encodeURIComponent(value).toLowerCase()),
  ];
  const findings: SignInVersionFinding[] = [];
  const refuse = (rule: SignInVersionRule, part: string) => {
    if (!findings.some((finding) => finding.rule === rule && finding.part === part))
      findings.push({ rule, part });
  };

  const relation = workspaceRelation(recipe, siteOrigin);
  if ("workspace" in recipe && recipe.workspace !== undefined && relation === undefined)
    refuse("workspace_parent", "recipe.workspace");

  const entry = URL.parse(version.entryUrl);
  if (!secure(version.entryUrl)) refuse("insecure_origin", "entryUrl");
  if (!onSite(siteOrigin, version.entryUrl)) refuse("foreign_origin", "entryUrl");
  if (entry !== null && (entry.username !== "" || entry.password !== ""))
    refuse("url_credentials", "entryUrl");
  if (input.entryUrlAsked !== true && oneTimeLoginUrlParameters(version.entryUrl).length > 0)
    refuse("one_time_url", "entryUrl");
  const entryPast = pastOrigin(version.entryUrl);
  if (
    // An asked one-time URL's query and fragment hold spent random values, which often have four
    // digits in a row: only its path is read for a masked number.
    namesMaskedContact(input.entryUrlAsked === true ? (entry?.pathname ?? entryPast) : entryPast) ||
    namesIdentityOrPrivateMask(entryPast, pageValues) ||
    namesIdentityOrPrivateMask(belowDomain(version.entryUrl), values)
  )
    refuse("page_names_contact", "entryUrl");
  if (signsOut(entryPast)) refuse("sign_out", "entryUrl");

  const steps: readonly SignInRecipeStep[] = recipe.steps;
  steps.forEach((step, index) => {
    const at = `recipe.steps[${index}]`;
    for (const { part, text } of stepSelectors(step, at)) {
      if (namesMaskedContact(text) || namesIdentityOrPrivateMask(text, values))
        refuse("selector_names_contact", part);
      // What a step clicks: its submit and its methods.
      if (/\.(?:submit|methods\[\d+\]\.selector)$/u.test(part) && signsOut(text))
        refuse("sign_out", part);
    }
    const page = pastOrigin(step.page);
    if (
      namesMaskedContact(page) ||
      namesIdentityOrPrivateMask(page, pageValues) ||
      namesIdentityOrPrivateMask(belowDomain(step.page), values)
    )
      refuse("page_names_contact", `${at}.page`);
    if (signsOut(page)) refuse("sign_out", `${at}.page`);
    if (step.origin !== "workspace" && !secure(step.page)) refuse("insecure_origin", `${at}.page`);
    if (step.origin === "workspace" ? relation === undefined : !onSite(siteOrigin, step.page))
      refuse("foreign_origin", `${at}.page`);
    if (
      step.anySegments !== undefined &&
      ((step.origin !== "workspace" && URL.parse(step.page)?.origin !== siteOrigin) ||
        pageMatches(version.entryUrl, step))
    )
      refuse("wildcard_placement", `${at}.anySegments`);
    if (step.popup !== undefined) {
      if (namesIdentityOrPrivateMask(belowDomain(step.popup.origin), values))
        refuse("page_names_contact", `${at}.popup.origin`);
      if (!secure(step.popup.origin)) refuse("insecure_origin", `${at}.popup.origin`);
      if (!onSite(siteOrigin, step.popup.origin)) refuse("foreign_origin", `${at}.popup.origin`);
    }
  });

  const marker = recipe.signedIn;
  for (const [key, text] of [
    ["selector", marker.selector],
    ["urlPath", marker.urlPath],
    ["openPath", marker.openPath],
  ] as const) {
    if (text === undefined) continue;
    const selector = key === "selector";
    const named = selector ? text : pastOrigin(text);
    if (
      namesMaskedContact(named) ||
      namesIdentityOrPrivateMask(named, selector ? values : pageValues)
    )
      refuse("indicator_holds_identity", `recipe.signedIn.${key}`);
    // The host opens the account page before it checks the marker.
    if (key === "openPath" && signsOut(named)) refuse("sign_out", "recipe.signedIn.openPath");
  }
  if (marker.selector === undefined && marker.urlPath === undefined) {
    refuse("marker_missing", "recipe.signedIn");
    return findings;
  }
  if (
    [{ page: version.entryUrl, anySegments: undefined }, ...steps].some(
      (step) => loginPathRefusal(marker, step.page, step.anySegments) !== undefined,
    )
  )
    refuse("marker_is_login_path", "recipe.signedIn.urlPath");
  if (matchSignedOutSnapshots(marker, signedOutSnapshots) === "matches")
    refuse("marker_matches_signed_out_page", "recipe.signedIn");
  return findings;
};
