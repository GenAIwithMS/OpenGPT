import { Effect } from "effect";
import type { SiteNaming } from "../registry/site-naming.js";
import { MintFailure } from "./contracts.js";

// The login URL a signed-in tool publishes, and the other published parts, checked at publication:
// a registered credential in any of them is refused every time, and a login URL that is one
// authorization request is asked about once.

/** Parameters that belong to one authorization request: their values are spent when it ends. */
const oneTimeParameters = new Set(
  [
    "code_challenge",
    "code_verifier",
    "oauth_token",
    "oauth_verifier",
    "oauth_nonce",
    "oauth_signature",
    "samlrequest",
    "samlresponse",
    "login_challenge",
    "login_verifier",
  ].map((name) => name.toLowerCase()),
);
/** Parameters that are one-time only when their value is opaque rather than a readable word. */
const opaqueWhenRandom = new Set(["state", "nonce", "relaystate"]);
/** A random token mixes letters and digits at length; `state=CA` or `state=signed-in` does not. */
const looksOpaque = (value: string) =>
  value.length >= 16 && /^[\w.~+/=-]+$/u.test(value) && /\d/u.test(value) && /[a-z]/iu.test(value);

/**
 * A query or fragment's parameters with percent escapes decoded and `+` left as written: an
 * unescaped `+` in a base64 `state` is a plus, not the space `URLSearchParams` makes of it.
 */
const rawParameters = (query: string): URLSearchParams =>
  new URLSearchParams(query.replaceAll("+", "%2B"));

/**
 * An identity provider's authorization endpoint: OAuth's `/authorize` (Okta's
 * `/oauth2/default/v1/authorize`, Azure's `/oauth2/v2.0/authorize`, Auth0's), PingFederate's
 * `/as/authorization.oauth2` and Keycloak's `/protocol/openid-connect/auth`. Opening one starts a
 * new authorization request built for the sign-in that read it.
 */
const authorizePath =
  /\/(?:authorize|as\/authorization\.oauth2|protocol\/openid-connect\/auth)\/?$/iu;

/**
 * What marks a login URL as one authorization request: its one-time parameters' names (never
 * their values), such as an OAuth `code_challenge`, an opaque `state` or `nonce`, or a
 * `SAMLRequest`, and its path when that is an identity provider's authorize endpoint. During a
 * build it only tells the minting agent once that the URL is unlikely to work again, whether it
 * read the URL from the page or passed it itself, and never changes or refuses the URL. The
 * sign-in version check refuses a version whose entry URL it marks (`one_time_url`), since no
 * later run could open that URL again, unless the host already asked about it.
 */
export const oneTimeLoginUrlParameters = (loginUrl: string): readonly string[] => {
  const url = URL.parse(loginUrl);
  if (url === null) return [];
  const names = new Set<string>();
  if (authorizePath.test(url.pathname)) names.add(url.pathname);
  const inspect = (parameters: URLSearchParams) => {
    for (const [name, value] of parameters) {
      const key = name.toLowerCase();
      if (
        oneTimeParameters.has(key) ||
        (opaqueWhenRandom.has(key) && looksOpaque(value)) ||
        (key === "request_uri" && value.startsWith("urn:ietf:params:oauth:request_uri:"))
      )
        names.add(name);
    }
  };
  inspect(rawParameters(url.search.slice(1)));
  if (url.hash.length > 1) {
    const fragment = url.hash.slice(1);
    inspect(rawParameters(fragment));
    // A hash route, such as `#/oauth/callback?code_challenge=…`, carries its own query after `?`.
    const routeQuery = fragment.indexOf("?");
    if (routeQuery >= 0) inspect(rawParameters(fragment.slice(routeQuery + 1)));
  }
  return [...names].sort();
};

/**
 * Which registered secrets a text carries, as a host's screening finds them, never their values:
 * each one's kind (`entity`), whether the caller or the host's sign-in supplied it, and whether it
 * is a session token the host found in the site's traffic.
 */
export interface RegisteredSecretMatcher<E> {
  readonly registeredSecretMatches: (text: string) => Effect.Effect<
    readonly {
      readonly entity: string;
      readonly supplied: boolean;
      readonly sessionToken?: boolean | undefined;
    }[],
    E
  >;
}

/**
 * Secrets are kept out of a published tool only at publication. The login URL, name and
 * description are refused every time one holds a registered credential or a discovered session
 * token, naming the part and the kind of credential but never its value, until the agent removes
 * it; nothing is redacted, rewritten or dropped, and nothing here ends the build. Capture and
 * review can register a value after the first check, so every later gate over these parts runs
 * this first: a registered credential there is always this refusal, never a definition block.
 */
export const refuseCredentialParts = <E>(
  broker: RegisteredSecretMatcher<E>,
  texts: {
    readonly loginUrl: string | undefined;
    readonly name: string;
    readonly description: string;
    readonly site: SiteNaming | undefined;
  },
): Effect.Effect<void, MintFailure> =>
  Effect.gen(function* () {
    const credentialParts = yield* Effect.forEach(
      [
        { part: "loginUrl" as const, text: texts.loginUrl },
        { part: "name" as const, text: texts.name },
        { part: "description" as const, text: texts.description },
        { part: "siteName" as const, text: texts.site?.name },
        { part: "siteSummary" as const, text: texts.site?.summary },
      ],
      ({ part, text }) =>
        Effect.gen(function* () {
          if (text === undefined) return undefined;
          const matched = yield* Effect.either(broker.registeredSecretMatches(text));
          // A part that cannot be screened is refused, its credential kind unnamed.
          if (matched._tag === "Left") return { part, credentialKinds: ["credential"] };
          const kinds = [
            ...new Set(
              matched.right
                .filter((match) => match.supplied || match.sessionToken)
                .map((match) => match.entity),
            ),
          ].sort();
          return kinds.length === 0 ? undefined : { part, credentialKinds: kinds };
        }),
    ).pipe(Effect.map((parts) => parts.filter((part) => part !== undefined)));
    if (credentialParts.length > 0)
      return yield* new MintFailure({
        code: "PublicationUnavailable",
        reason:
          credentialParts[0]?.part === "loginUrl"
            ? "login_url_contains_credential"
            : "metadata_contains_credential",
        publicationFeedback: { parts: credentialParts },
      });
  });
