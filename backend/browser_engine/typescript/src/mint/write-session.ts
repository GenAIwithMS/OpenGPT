import { Effect } from "effect";
import { confirmActionUnmatched } from "../browser/dialogs/expected.js";
import {
  declaredRefusalReasons,
  unreadableRefusal,
  type CommitEvidence,
  type DeclaredRefusal,
} from "../runtime/run-outcome.js";
import { MintFailure, type ExecutionRequest, type WritePath } from "./contracts.js";
import { entrypointImportClosure } from "./operation-source.js";
import { writeContractRefusal } from "./write-contract.js";
import type { GuardianAction } from "../guardian/review-contracts.js";
import type { OutcomeAssessment } from "./outcome-review-contracts.js";

// The commit evidence of an act step's runner, shared with the run outcome classifier. This module
// keeps exporting both names, so its subpath's exports are unchanged.
export { commitEvidenceOf, type CommitEvidence } from "../runtime/run-outcome.js";

/**
 * Whether an act step that did not succeed may have committed its write: the host counted
 * something it sent, or could not count (`sent` undefined), or the step entered a commit mark or
 * returned no result (a lost page). Those last two may have committed where the host's count
 * cannot see, so the minter verifies before writing again.
 *
 * @deprecated Hosts use `readBackFirst`, which keys on Guardian's write label and the commit marks.
 */
export const commitUncertain = (sent: number | undefined, commit?: CommitEvidence) =>
  sent !== 0 || commit === "entered" || commit === "unreported";

/**
 * Why a failed act step may have committed its write, for its receipt.
 *
 * @deprecated Hosts use `readBackFirst`.
 */
export const uncertainCommit = (sent: number | undefined, commit: CommitEvidence | undefined) =>
  sent === undefined
    ? "the page sent requests the host could not count"
    : sent > 0
      ? `the page sent ${sent} request(s) or opened socket(s) that could change the site`
      : commit === "entered"
        ? "its script entered a declared commit step, which may have sent the write as a request the host does not count (a GET link, for example)"
        : "it returned no result, as when its page was lost or its runner stopped, so the host cannot tell which commit steps it entered";

/**
 * The receipt of an act step that failed after it may have committed its write. The host never
 * blocks or resubmits a write; the minter verifies by reading back, then decides.
 *
 * @deprecated Hosts use `readBackFirst`.
 */
export const verifyFirstNotice = (sent: number | undefined, commit: CommitEvidence | undefined) =>
  `This act step did not complete after ${uncertainCommit(sent, commit)}, so the write may already be committed. Before any further write, verify: run an act step that only reads the page or the account and learns whether the write happened. If it did, record it with verified() in that step and publish against it; never submit the write again. If the read-back shows nothing happened, you may submit the write again with the caller's values and read its confirmation. Either way, adjust the composed script to what actually works end to end. The host never resubmits a write for you.`;

/** Why a failed act step Guardian labelled a write may have committed it, for its receipt. */
const labelledWriteUncertainty = (commit: CommitEvidence | undefined) =>
  commit === "entered"
    ? "its script entered a declared commit step"
    : commit === "unreported"
      ? "it returned no result, as when its page was lost or its runner stopped, so the host cannot tell which commit steps it entered"
      : "Guardian labelled it a write";

/**
 * The receipt of an act step that failed after it may have committed its write. The host never
 * blocks or resubmits a write; the minter verifies by reading back, then decides. A commit request
 * the site answered 2xx or 3xx lets that read be the write's own result, on the page as it stands
 * or looked up on another page such as a list.
 */
const labelledWriteNotice = (commit: CommitEvidence | undefined) =>
  `This act step did not complete after ${labelledWriteUncertainty(commit)}, so the write may already be committed. Before any further write, verify: run an act step that only reads the page or the account and learns whether the write happened. When this step's stateChangingRequests shows its commit request to the site returned 2xx or 3xx, that step may read back the write's own result, the record it just created or changed: on the page as it stands, or looked up on another page such as a list. Check it shows no error or validation message, read what the output needs, and call verified() there. Reading is allowed; a second write is not. A 200 whose body reports an error, as GraphQL can, did not go through. Read the site's own proof for such a commit, as for an error status, since part of it may have applied. A 202, or a 2xx whose body says the work is queued, counts too: return the site's own status word for it, such as Queued, in the output. If the write happened, record it with verified() in that step and publish against it; never submit the write again. If the read-back shows nothing happened, you may submit the write again with the caller's values and read its confirmation. Either way, adjust the composed script to what actually works end to end. The host never resubmits a write for you.`;

/**
 * What an act step Guardian labelled a write asks of the minter when it did not complete: read
 * back before any further write, unless its commit marks show no commit step entered, since such
 * a step changed nothing. Each host decides that the step was a write that did not complete; the
 * rule and its text are the same for every host.
 */
export const readBackFirst = (commit: CommitEvidence | undefined) =>
  commit === "not_entered"
    ? undefined
    : { verifyFirst: true as const, notice: labelledWriteNotice(commit) };

/** What publication reads of one act step of a write session. */
export interface WriteSessionMarks {
  /** The confirmation the step recorded. */
  readonly confirmation?: "message" | "readback";
  /** The commit marks this step's runner reported entered (`sent` or `confirmed`). */
  readonly enteredMarks: readonly string[];
  /**
   * Set only when the step returned no readable commit report, such as when its browser was lost:
   * the commit marks its runner streamed to the host as it entered them.
   */
  readonly streamedMarks?: readonly string[];
  /**
   * The host's own record shows this step may have reached the site, as an effect journal does
   * once the step called the browser, or as a step whose dispatch fence passed does.
   */
  readonly possiblySent?: boolean;
  /** Guardian's action label for the step: only a `write` is the session's write. */
  readonly action?: GuardianAction;
  /** The outcome review's newest finding for this step's write, when it has one. */
  readonly assessment?: OutcomeAssessment["outcome"];
  /**
   * The refusal this step returned in a shape its own output schema declares, while its runner
   * showed it entered no commit mark and recorded no confirmation (`returnedRefusal`): the site's
   * own no to the session's input, such as a product it does not offer for these facts. A host
   * sets it only on the session's last act step, and only when no other step may have sent a write
   * without entering a mark, since the check reads it on the step named for publication alone.
   */
  readonly refused?: DeclaredRefusal;
}

/**
 * The commit marks a session entered: those its steps' runners reported, and, once a later step
 * confirmed the write, those a step whose result was lost streamed as it entered them.
 */
export const sessionEnteredMarks = (steps: readonly WriteSessionMarks[]) => {
  const entered = new Set(steps.flatMap((step) => step.enteredMarks));
  steps.forEach((step, index) => {
    if (steps.slice(index + 1).some((later) => later.confirmation !== undefined))
      for (const name of step.streamedMarks ?? []) entered.add(name);
  });
  return entered;
};

/** The commit marks of a recorded write path that `entered` lacks, in path order. */
export const writePathRemaining = (
  path: WritePath | undefined,
  entered: ReadonlySet<string>,
): readonly string[] =>
  path === undefined ? [] : path.steps.map((step) => step.commit).filter((name) => !entered.has(name));

/**
 * The marks of the recorded path the session entered that a revision drops or moves out of their
 * order. A revision may add marks anywhere, the ones the session entered off the path included.
 */
const enteredMarksLost = (
  recorded: WritePath,
  revised: WritePath,
  entered: ReadonlySet<string>,
) => {
  const order = revised.steps.map((step) => step.commit);
  const lost: string[] = [];
  let next = 0;
  for (const { commit } of recorded.steps) {
    if (!entered.has(commit)) continue;
    const at = order.indexOf(commit, next);
    if (at === -1) lost.push(commit);
    else next = at + 1;
  }
  return lost;
};

/**
 * Why a write build's act step may not run with the write path it carries, if it may not, before
 * any review or dispatch. A build's first act step declares its whole write path; a later one may
 * revise it, keeping every mark of the recorded path the session already entered, in the same
 * order. A session that started without a recorded path, as one a host started before it kept
 * paths, runs on without one. Hosts apply it to a build's write session, never to a repair's.
 */
export const writePathRefusal = (
  submitted: Pick<ExecutionRequest, "purpose" | "target" | "writePath">,
  session: {
    readonly started: boolean;
    readonly path: WritePath | undefined;
    readonly enteredMarks: ReadonlySet<string>;
  },
): string | undefined => {
  if (submitted.purpose !== "act" || submitted.target !== "liveBrowser") return undefined;
  if (submitted.writePath === undefined)
    return session.started
      ? undefined
      : "A write build's first act step declares writePath before anything is sent: in steps, each step that saves or submits on the site through to the outcome the request asks for, by the commit mark its helper enters, in order; in ends, what the last step leaves the caller with. Guardian reviews the path as publication will review the tool, and the session runs until every mark on it is entered. Add writePath and execute again. Nothing was executed.";
  if (session.path === undefined) return undefined;
  const lost = enteredMarksLost(session.path, submitted.writePath, session.enteredMarks);
  return lost.length === 0
    ? undefined
    : `A revised writePath keeps every mark of the recorded path the session already entered, in the same order: ${lost.join(", ")}. Correct writePath and execute again. Nothing was executed.`;
};

/**
 * The receipt note of an act step after which marks of the recorded write path are not yet settled,
 * as unentered or entered only by a step that lost its result: the session runs on until they are,
 * and a confirmation the step recorded does not end it.
 */
export const writePathNotice = (remaining: readonly string[], confirmed: boolean) => ({
  remaining,
  instruction: `${confirmed ? "This step's confirmation does not end the write session. " : ""}The session's recorded write path has commit marks not yet settled (a step that lost its result may have entered them): ${remaining.join(", ")}. The session runs until every one is settled. Read back first where a receipt says so: a read-back that confirms the write settles the marks a lost step entered. Then run only steps that never ran, on the page as it stands; never redo one that finished or may have. When the page shows the path must change, such as a step the site skips for this input, declare the revised path in writePath on the next act step.`,
});

/** Whether a step of the session recorded a confirmation. */
export const sessionConfirmed = (steps: readonly WriteSessionMarks[]) =>
  steps.some((entry) => entry.confirmation !== undefined);

/**
 * Whether the session sent its write. A recorded confirmation is that proof, whatever request
 * carried the commit. Otherwise (an unverifiable write) a step Guardian labelled a write must
 * have possibly reached the site without the outcome review finding it `not_done`: a write whose
 * outcome is unknown or not yet assessed counts, since publication never waits for the review.
 * Request counts and commit marks never decide it; they stay the write contract's evidence.
 */
export const sessionSentWrite = (session: { readonly steps: readonly WriteSessionMarks[] }) =>
  sessionConfirmed(session.steps) ||
  session.steps.some(
    (step) =>
      step.action === "write" && step.possiblySent === true && step.assessment !== "not_done",
  );

const sessionRefusal = (
  reason: NonNullable<MintFailure["reason"]>,
  writePathMarks?: readonly string[],
  publishesOnRefusal = false,
) =>
  new MintFailure({
    code: "PublicationUnavailable",
    reason,
    ...(writePathMarks === undefined ? {} : { writePathMarks }),
    // The two refusals a minter meets when it has not yet published on the site's own no.
    ...(publishesOnRefusal &&
    (reason === "write_not_submitted" || reason === "commit_marks_unentered")
      ? { publishesOnRefusal: true as const }
      : {}),
  });

/**
 * A write session's checks before its composed script publishes, in order: the session sent its
 * write and, given `writePath`, entered every mark of its recorded write path; then the script's
 * contract, which `extract` reads offline only after that, declares a confirmation and the commit
 * marks the session entered, decodes the session's input and matches the confirmation the named
 * step recorded, and declares every mark of the recorded path. Then, given the script's
 * `outputSchema`, every refusal it lists is one the host reads as declared. Last, given
 * `confirms`, the script names each step its session accepted a confirm popup at. The composed
 * script is never run. Its result names, as `commitsUnproven` in the order `commits` declares
 * them, the commit steps the contract declares unproven, after the last one the session entered,
 * which no run has shown yet; it leaves the key out when there are none.
 *
 * A host that publishes a write whose example ended in the site's own no sets `publishOnRefusal`.
 * Then, when the step named for publication entered no commit mark, recorded no confirmation and
 * returned a declared refusal (`refused`), the refusal is the session's proven outcome: the check
 * skips the sent and write path checks, and the composed script must declare that refusal's reason
 * in its output schema and name every commit step after the last one the session entered (all of
 * them when it entered none) in `commitsUnproven`. The result carries the refusal as `refusal`.
 */
export const checkWriteSession = <
  Extracted extends {
    readonly contract: { readonly write?: Parameters<typeof writeContractRefusal>[0] };
    readonly inputDecodes: boolean;
    /** The composed script's files, which the confirm popup check reads. */
    readonly files?: ReadonlyMap<string, string>;
    /**
     * The composed script's output JSON Schema, as it publishes it. Given it, the check refuses
     * an output schema that lists a `refused` status the host cannot read as a declared refusal
     * (`unreadableRefusal`), as `refusal_unreadable`. A host that leaves it out skips that check.
     */
    readonly outputSchema?: unknown;
  },
  E,
  R,
>(check: {
  readonly session: { readonly steps: readonly WriteSessionMarks[] };
  /** The act step named for publication. */
  readonly step: Pick<WriteSessionMarks, "confirmation" | "refused"> & {
    readonly enteredMarks?: readonly string[];
  };
  readonly extract: Effect.Effect<Extracted, E, R>;
  /**
   * The steps the session's act steps accepted confirm popups at, and the composed script's
   * entrypoint. The entrypoint's import closure must name each step as a literal, or a run could
   * never match its recorded confirm. A host that runs this check on its own leaves it unset.
   */
  readonly confirms?: { readonly steps: Iterable<string>; readonly entrypoint: string };
  /**
   * The session's recorded write path, which its first act step declared and Guardian allowed. A
   * host that kept none, as for a session started before hosts kept paths, leaves it unset.
   */
  readonly writePath?: WritePath;
  /**
   * For a publication that replaces a published revision, such as a repair or a change, that
   * revision's output JSON Schema. A refusal the host cannot read in it too is not refused here,
   * so a tool published before the refusal check is never refused for the shape it has.
   */
  readonly registeredOutputSchema?: unknown;
  /**
   * Set by a host that publishes a write whose example ended in the site's own declared no. A
   * host that leaves it unset refuses such a session as before.
   */
  readonly publishOnRefusal?: boolean;
}) =>
  Effect.gen(function* () {
    const { session, step } = check;
    // The step named for publication saved and confirmed nothing, so the site's own no may stand.
    const refusable =
      check.publishOnRefusal === true &&
      step.confirmation === undefined &&
      step.enteredMarks?.length === 0;
    const refuse = (reason: NonNullable<MintFailure["reason"]>, writePathMarks?: readonly string[]) =>
      sessionRefusal(reason, writePathMarks, refusable);
    const siteRefusal = refusable ? step.refused : undefined;
    if (siteRefusal === undefined && !sessionSentWrite(session))
      return yield* refuse("write_not_submitted");
    const enteredMarks = sessionEnteredMarks(session.steps);
    // The refusal ends the session (the host sets `refused` only on its last act step), so the
    // path's later marks stay unentered.
    const unrun =
      siteRefusal === undefined ? writePathRemaining(check.writePath, enteredMarks) : [];
    if (unrun.length > 0) return yield* refuse("write_path_unfinished", unrun);
    const extracted = yield* check.extract;
    const declared = extracted.contract.write?.confirmation;
    const refusal = writeContractRefusal(extracted.contract.write, extracted.inputDecodes, step, {
      confirmed: sessionConfirmed(session.steps),
      enteredMarks,
      ...(siteRefusal === undefined ? {} : { refused: true }),
    });
    if (refusal !== undefined || declared === undefined)
      return yield* refuse(refusal ?? "confirmation_undeclared");
    const commits = extracted.contract.write?.commits ?? [];
    const undeclared = writePathRemaining(check.writePath, new Set(commits.map(String)));
    if (undeclared.length > 0) return yield* refuse("write_path_undeclared", undeclared);
    // A refusal the host cannot read ends its run as an unknown outcome, so it is fixed now.
    if (
      extracted.outputSchema !== undefined &&
      unreadableRefusal(extracted.outputSchema) &&
      (check.registeredOutputSchema === undefined ||
        !unreadableRefusal(check.registeredOutputSchema))
    )
      return yield* refuse("refusal_unreadable");
    // The example's refusal stands for the tool only when the composed script declares it too.
    if (
      siteRefusal !== undefined &&
      !declaredRefusalReasons(extracted.outputSchema).has(siteRefusal.reason)
    )
      return yield* refuse("write_not_submitted");
    // A run accepts a confirm popup without asking only at the action the build accepted it at,
    // so the composed script must run each such action under the session's action id.
    if (check.confirms !== undefined) {
      const files = extracted.files ?? new Map<string, string>();
      const composed = entrypointImportClosure(files, check.confirms.entrypoint);
      yield* confirmActionUnmatched(check.confirms.steps, [...composed.values()]);
    }
    // The contract check accepted these only as marks of `commits` the session never entered.
    const declaredUnproven = new Set(extracted.contract.write?.commitsUnproven ?? []);
    const unproven = (extracted.contract.write?.commits ?? [])
      .filter((name) => declaredUnproven.has(name))
      .map(String);
    const checked: {
      readonly extracted: Extracted;
      readonly declared: NonNullable<typeof declared>;
      readonly commitsUnproven?: readonly string[];
      readonly refusal?: DeclaredRefusal;
    } = {
      extracted,
      declared,
      ...(unproven.length === 0 ? {} : { commitsUnproven: unproven }),
      ...(siteRefusal === undefined ? {} : { refusal: siteRefusal }),
    };
    return checked;
  });
