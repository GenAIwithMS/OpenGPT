import type { ExecutionEvidence } from "./contracts.js";
import { finiteRunnerErrorCode } from "../runtime/runner-codes.js";

/** Closed, host-derived facts from a runner that already finished before capture failed. */
export interface RunnerFailure {
  readonly status: "failed";
  readonly effect: ExecutionEvidence["effect"];
  /** The host's finite execution-code projection; `unclassified` for a code it does not know. */
  readonly errorCode: string;
  /** The runner's own code and message, screened with the job's broker before the agent sees it. */
  readonly runnerErrorCode?: string;
  readonly runnerErrorMessage?: string;
  readonly pwTimeoutSource?: "action_default" | "explicit_option";
  readonly captureGap: "secret_discovery" | "capture_publication";
}

export const finiteCaptureGap = (
  value: unknown,
): "secret_discovery" | "capture_publication" | undefined =>
  value === "secret_discovery" || value === "capture_publication" ? value : undefined;
const finiteWebsiteEffect = (value: unknown): value is "not_sent" | "possible" | "verified" =>
  value === "not_sent" || value === "possible" || value === "verified";

const runnerFailureBase = (value: unknown) => {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const status = "status" in value ? value.status : undefined;
    const effect = "effect" in value ? value.effect : undefined;
    const captureGap = finiteCaptureGap("captureGap" in value ? value.captureGap : undefined);
    const errorCode = "errorCode" in value ? value.errorCode : undefined;
    if (status !== "failed" || !finiteWebsiteEffect(effect) || captureGap === undefined)
      return undefined;
    return {
      source: value,
      projected: {
        status: "failed" as const,
        effect,
        errorCode: finiteRunnerErrorCode(typeof errorCode === "string" ? errorCode : undefined),
        captureGap,
      },
    };
    // error-reporting-allow: parse-predicate unreadable runner tuple fields supply no trusted finite metadata
  } catch {
    return undefined;
  }
};

/** The runner's own code and message, when a value carries them as strings. */
export const runnerErrorFields = (source: object) => {
  const code = "runnerErrorCode" in source ? source.runnerErrorCode : undefined;
  const message = "runnerErrorMessage" in source ? source.runnerErrorMessage : undefined;
  return {
    ...(typeof code === "string" ? { runnerErrorCode: code } : {}),
    ...(typeof message === "string" ? { runnerErrorMessage: message } : {}),
  };
};

/** Rebuild rather than forward a runner tuple supplied across an error boundary. */
export const finiteRunnerFailure = (value: unknown): RunnerFailure | undefined => {
  const base = runnerFailureBase(value);
  if (base === undefined) return undefined;
  let projected: RunnerFailure = base.projected;
  try {
    projected = { ...projected, ...runnerErrorFields(base.source) };
    const pwTimeoutSource =
      "pwTimeoutSource" in base.source ? base.source.pwTimeoutSource : undefined;
    return pwTimeoutSource === "action_default" || pwTimeoutSource === "explicit_option"
      ? { ...projected, pwTimeoutSource }
      : projected;
    // error-reporting-allow: parse-predicate an unreadable optional timeout getter leaves only the already validated finite tuple
  } catch {
    return projected;
  }
};
