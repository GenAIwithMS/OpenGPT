/**
 * Features the shared prompts describe that another host supplies and the local host does not.
 * The local host renders this list twice: on top of its minter's `AGENTS.md`, as features to
 * ignore, and at the end of its Guardian's execution policy, as protections not to count on. A
 * host that supplies them all renders neither.
 *
 * Each entry is one line, with an id a change uses to find it. A change that brings a feature to
 * the local host deletes that feature's entry here, and nothing else needs to change.
 */
export interface HostedFeature {
  readonly id: string;
  readonly name: string;
}

export const hostedFeatures: readonly HostedFeature[] = [
  { id: "anti-bot", name: "Anti-bot, CAPTCHA, proxies and browser replacement" },
  { id: "saved-logins", name: "Saved logins" },
  { id: "http-recording", name: "HTTP recording, captures, HTTP versions and savedHTTP" },
  { id: "maintenance", name: "Maintenance and repair" },
  { id: "saved-browser-profiles", name: "Saved browser profiles" },
  // Covers the shared text about `stateChangingRequests`: the core skill's "State-changing
  // requests" section and the write session's rule to read it on every step. The local host reads
  // back an uncertain commit from its own record of the step, without this list.
  {
    id: "state-changing-requests",
    name: "Per-step list of requests that could change the site (`stateChangingRequests`)",
  },
  { id: "host-incidents", name: "Host incidents" },
  { id: "offline-command-sandbox", name: "Sandboxed offline commands" },
  { id: "protected-answers", name: "Protected answers" },
  { id: "direct-sign-in", name: "Direct sign-in" },
  { id: "private-fallback-publication", name: "Private fallback publication" },
  { id: "saved-dom-tests", name: "savedDOM tests" },
  { id: "execution-capacity", name: "Execution capacity" },
  { id: "browser-retirement", name: "Browser retirement" },
  { id: "write-fencing", name: "Write fencing" },
];

/** What the local minter reads first: the features to ignore, one per line. */
export const renderHostedFeaturesPreamble = (features: readonly HostedFeature[]) =>
  features.length === 0
    ? ""
    : [
        "These features are not available here. Please ignore these features.",
        ...features.map(({ name }) => `- ${name}`),
      ].join("\n");

/** A name as it reads mid-sentence: "Host incidents" becomes "host incidents", "savedDOM" stays. */
const midSentence = (name: string) =>
  /^[A-Z][a-z]/u.test(name) ? `${name.charAt(0).toLowerCase()}${name.slice(1)}` : name;

/** What the local Guardian reads last: the same features, as protections not to count on. */
export const renderHostedProtectionsLine = (features: readonly HostedFeature[]) =>
  features.length === 0
    ? ""
    : `These hosted protections aren't present here: ${features
        .map(({ name }) => midSentence(name))
        .join("; ")}. Don't count on them.`;

export const hostedFeaturesPreamble = renderHostedFeaturesPreamble(hostedFeatures);
export const hostedProtectionsLine = renderHostedProtectionsLine(hostedFeatures);
