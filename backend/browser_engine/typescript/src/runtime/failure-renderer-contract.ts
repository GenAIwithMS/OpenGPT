import {
  classifyRun,
  runOutcomeCodes,
  type FailureRenderer,
  type RunEvidence,
  type RunOutcome,
} from "./run-outcome.js";

/*
 * The failure renderer contract, which every host's renderer runs in its own tests: the local
 * host's table and any other host's adapter. It needs no test framework: an empty issue list
 * means the renderer holds.
 */

const statuses = ["completed", "cleanup_pending", "outcome_unknown"];
const effects = ["not_started", "may_have_dispatched", "verified", "rejected", "unknown", "partial"];
const outputs = ["valid", "invalid", "failed"];
const toolEffects = ["read", "write", undefined] as const;
const failureReasons = [
  undefined,
  "no_response",
  "credentials_rejected",
  "invalid_input",
  "input_not_applied",
  "location_not_applied",
  "login_identity_conflict",
  "login_check_unavailable",
  "worker_lost",
];
const possibleCommits = [undefined, false, true];

/**
 * Every distinct outcome the classifier gives, over every combination of the evidence it reads.
 * A refused input carries a reason and a rejected login a field, so details are covered too.
 */
export const classifiedOutcomes = (): readonly RunOutcome[] => {
  const outcomes = new Map<string, RunOutcome>();
  for (const status of statuses)
    for (const effect of effects)
      for (const output of outputs)
        for (const tool_effect of toolEffects)
          for (const failure_reason of failureReasons)
            for (const possible_commit of possibleCommits) {
              const evidence: RunEvidence = {
                status,
                effect,
                output,
                tool_effect,
                failure_reason,
                possible_commit,
                refusal_reason: "The date must be in the future.",
                rejected_field: "password",
                unapplied_input: { field: "sort", requested: "price_low", step: "apply_sort" },
              };
              const outcome = classifyRun(evidence);
              if (outcome !== undefined) outcomes.set(JSON.stringify(outcome), outcome);
            }
  return [...outcomes.values()];
};

const advises = (advice: string | RegExp, text: string) =>
  typeof advice === "string"
    ? text.toLowerCase().includes(advice.toLowerCase())
    : text.search(advice) >= 0;
/** A bare verdict tells a caller nothing about what happened or whether to retry. */
const bare = (text: string) => /^\s*(?:operation\s+)?(?:failed|succeeded)\W*$/iu.test(text);

/**
 * Every way `renderer` breaks the contract; empty when it holds. It must word exactly the
 * classifier's codes, with non-empty text of its own for each code, keep each outcome's retry
 * class, never answer a bare "failed" or "succeeded", and tell every outcome whose step may have
 * committed, or whose write may have applied, to read the website back before any retry. A code
 * added to the classifier fails every renderer until it is worded.
 */
export const failureRendererIssues = (renderer: FailureRenderer): readonly string[] => {
  const issues: string[] = [];
  const handled = new Set<string>(renderer.codes);
  for (const code of runOutcomeCodes) if (!handled.has(code)) issues.push(`${code}: not handled`);
  for (const code of handled)
    if (!runOutcomeCodes.some((known) => known === code))
      issues.push(`${code}: not a code the classifier returns`);
  const texts = new Map<string, string>();
  for (const outcome of classifiedOutcomes()) {
    if (!handled.has(outcome.code)) continue;
    const label = `${outcome.code} (possible_commit ${String(outcome.possibleCommit)}, write_status ${String(outcome.writeStatus)})`;
    let rendered;
    try {
      rendered = renderer.render(outcome);
    } catch (error) {
      issues.push(`${label}: render threw ${error instanceof Error ? error.message : "a value"}`);
      continue;
    }
    if (rendered.message.trim() === "") issues.push(`${label}: empty message`);
    if (rendered.remediation.trim() === "") issues.push(`${label}: empty remediation`);
    if (bare(rendered.message) || bare(rendered.remediation))
      issues.push(`${label}: a bare failed or succeeded`);
    if (rendered.retry !== outcome.retry)
      issues.push(`${label}: retry ${rendered.retry}, expected ${outcome.retry}`);
    const text = `${rendered.message} ${rendered.remediation}`;
    const mayHaveChanged = outcome.possibleCommit || outcome.writeStatus === "may_have_applied";
    if (mayHaveChanged && !advises(renderer.readBackAdvice, text))
      issues.push(`${label}: no read-back advice`);
    const other = texts.get(text);
    if (other !== undefined && other !== outcome.code)
      issues.push(`${label}: same text as ${other}`);
    else texts.set(text, outcome.code);
  }
  return [...new Set(issues)];
};
