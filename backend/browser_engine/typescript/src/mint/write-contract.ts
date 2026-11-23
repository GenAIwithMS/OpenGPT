import { commitMarkMaxLength, commitMarkPattern } from "../runtime/operation.js";

/** Commit steps a run can prove it never reached: one or more distinct authored mark names. */
const declaresCommitMarks = (commits: readonly unknown[] | undefined) =>
  commits !== undefined &&
  commits.length > 0 &&
  new Set(commits).size === commits.length &&
  commits.every(
    (name) =>
      typeof name === "string" &&
      name.length <= commitMarkMaxLength &&
      commitMarkPattern.test(name),
  );

/**
 * The marks `commitsUnproven` may excuse from having been entered: distinct marks of `commits`
 * after the last one the session entered. A session that entered none has nothing to follow, so
 * it may excuse none, unless it ended in the site's own refusal (`refused`), which may excuse all.
 * Undefined when the declaration lists anything else.
 */
const unprovenMarks = (
  commits: readonly unknown[],
  unproven: readonly unknown[] | undefined,
  entered: ReadonlySet<string>,
  refused: boolean,
): ReadonlySet<unknown> | undefined => {
  if (unproven === undefined) return new Set();
  const last = commits.findLastIndex((name) => typeof name === "string" && entered.has(name));
  const later = new Set(last === -1 && !refused ? [] : commits.slice(last + 1));
  return Array.isArray(unproven) &&
    new Set(unproven).size === unproven.length &&
    unproven.every((name) => later.has(name))
    ? new Set(unproven)
    : undefined;
};

/**
 * Why a composed write script cannot publish against its session: it declares no confirmation,
 * names none of its commit steps (so no run of it could show it sent nothing), declares a
 * commit step the session never entered (so its marks do not follow its real commit), rejects
 * the caller's own input, declares one the named step did not record, or declares
 * `unverifiable` although a step of the session did confirm the write. A commit step after the
 * last one the session entered may stay unentered when `commitsUnproven` names it: the session
 * stopped before it, as when the caller's facts ran out, and publication reports it unproven.
 * A session that ended in the site's own refusal (`refused`, which only a host that publishes on
 * one passes) proved that refusal, not a confirmation: every commit step after the last one it
 * entered, all of them when it entered none, may be unproven, and no confirmation is matched.
 */
export const writeContractRefusal = (
  declared:
    | {
        readonly confirmation: "message" | "readback" | "unverifiable";
        readonly commits?: readonly unknown[];
        readonly commitsUnproven?: readonly unknown[];
      }
    | undefined,
  inputDecodes: boolean,
  step: { readonly confirmation?: "message" | "readback" },
  session: {
    readonly confirmed: boolean;
    readonly enteredMarks: ReadonlySet<string>;
    readonly refused?: boolean;
  },
) => {
  if (declared === undefined) return "confirmation_undeclared" as const;
  if (!declaresCommitMarks(declared.commits)) return "commit_marks_undeclared" as const;
  const commits = declared.commits ?? [];
  const refused = session.refused === true;
  const excused = unprovenMarks(commits, declared.commitsUnproven, session.enteredMarks, refused);
  if (
    excused === undefined ||
    commits.some(
      (name) => typeof name !== "string" || (!session.enteredMarks.has(name) && !excused.has(name)),
    )
  )
    return "commit_marks_unentered" as const;
  if (!inputDecodes) return "contract_input_mismatch" as const;
  if (declared.confirmation === "unverifiable")
    return session.confirmed ? ("confirmation_unrecorded" as const) : undefined;
  if (refused) return undefined;
  return step.confirmation !== declared.confirmation
    ? ("confirmation_unrecorded" as const)
    : undefined;
};
