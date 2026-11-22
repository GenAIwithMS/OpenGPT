import { Effect } from "effect";
import type { YieldableError } from "effect/Cause";
import type { AutofillInspection, AutofillStep } from "../destinations/autofill-step.js";
import type { SignInRecipeStep } from "../destinations/sign-in-recipe.js";
import { admitScreenOrigin } from "./workspace-origin.js";
import type { Replay } from "./autofill-replay-session.js";
import type { AutofillReplayInput } from "./autofill-replay-steps.js";
import type { AutofillLogin } from "./autofill-values.js";
import { isIdentifier, provesLogin } from "./autofill-state.js";

const originOf = (page: string) => URL.parse(page)?.origin;

/** The workspace a passing check ran on: the login's own, or one this sign-in does not explain. */
export interface CheckedWorkspace {
  readonly workspaceOrigin?: string;
  /** A workspace host the run goes on that is never the login's (`workspaceToPin`). */
  readonly unpinnedWorkspace?: string;
}

/**
 * A tool whose sign-in may move to the login's own workspace host (recipe version 4): the tool's
 * site, its public relation, and the login's pinned workspace origin. See `admitScreen`.
 */
export interface ReplayWorkspace<E = unknown> {
  readonly siteOrigin: string;
  readonly parent: string;
  /** The login's pinned workspace origin, private to its account, if it has one. */
  readonly pinned: string | undefined;
  /**
   * Hears the concrete host the replay refused or admitted, which never goes into a step event:
   * the run keeps it in its private diagnostics only. It fails when the run could not register an
   * admitted host to be masked, which stops the replay before it goes on there.
   */
  readonly observe: (event: {
    readonly kind: "refused" | "admitted" | "changed";
    readonly origin: string;
  }) => Effect.Effect<void, E>;
}

/**
 * What the workspace gates know for a shown screen: the tool's relation, the login's pinned
 * origin, and what this replay learned and sent.
 */
const admissionContext = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
) => {
  const workspace = input.workspace;
  const known = replay.progress.workspace;
  return {
    siteOrigin: workspace?.siteOrigin ?? "",
    relation: workspace === undefined ? undefined : { parent: workspace.parent },
    pinned: workspace?.pinned,
    candidate: known !== workspace?.pinned ? known : undefined,
    identifierSent: replay.progress.exactSent.identifier,
  };
};

/**
 * Whether a shown screen may be filled where it shows (workspace origins).
 * A screen recorded on an exact origin (the site or a shared sign-in host) must show there, or,
 * for a tool with a workspace relation, on the login's own workspace origin: the shared sign-in
 * may send a remembered workspace to its own sign-in page. A workspace screen
 * must show on the login's workspace origin, or on a host that passes the gates that the site
 * navigated to after this replay sent the login's identifier on a recorded screen on its exact
 * origin (the identifier-first anchor), which this replay then
 * admits as the login's workspace, one host per replay. Any other host is refused: another
 * tenant's sign-in on a shared domain passes the site check. A host that passes the gates seen
 * before this login sent anything (a leftover cookie, a link, or another workspace the site
 * remembers) is `workspace_unverified`, which the run clears and replays once; it is never a
 * recipe fault.
 */
export const admitScreen = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  recorded: SignInRecipeStep,
  page: string,
) =>
  Effect.gen(function* () {
    const live = originOf(page);
    if (live === undefined) return "screen_origin_changed" as const;
    const workspace = input.workspace;
    const known = replay.progress.workspace;
    const admitted = admitScreenOrigin(admissionContext(input, replay), recorded, live);
    if (admitted.admitted) {
      if (admitted.learned !== undefined) {
        yield* (
          workspace?.observe({
            kind: known === undefined ? "admitted" : "changed",
            origin: admitted.learned,
          }) ?? Effect.void
        );
        replay.progress.workspace = admitted.learned;
      }
      return undefined;
    }
    // Same site but not this login's workspace: the step event names only the role, and the
    // concrete host goes to the run's private diagnostics.
    if (admitted.sibling && workspace !== undefined) {
      yield* workspace.observe({ kind: "refused", origin: live });
      yield* input.emit({ stage: "step", outcome: "refused", role: "unrecognized_sibling" });
    }
    return admitted.reason;
  });

/**
 * What a screen sent on its recorded exact origin (the shared host): its identifier,
 * its proof. A screen admitted on the login's pinned workspace, or a workspace screen, counts for
 * nothing here: only the exact origin anchors the login's workspace (`admitScreen`).
 */
export const noteExactSent = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  replay: Replay<E, V, L>,
  recorded: SignInRecipeStep,
  step: AutofillStep,
  inspection: AutofillInspection,
) => {
  const live = originOf(inspection.page);
  if (recorded.origin === "workspace" || live === undefined || live !== originOf(recorded.page))
    return;
  const sent = step.fields
    .map((field) => field.slot)
    .filter((slot) => replay.state.submittedSlots.has(slot));
  if (sent.some(isIdentifier)) replay.progress.exactSent.identifier = true;
  if (sent.some(provesLogin)) replay.progress.exactSent.credentials = true;
};
