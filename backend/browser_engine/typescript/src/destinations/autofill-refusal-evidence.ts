import type { AutofillStepReport } from "./autofill-step.js";

/** A step report's refusal evidence for its step event: empty unless a check refused it. */
export const refusalEvidence = (report: AutofillStepReport) => {
  const context = report.outcome === "uncertain" ? undefined : report.failureDetail?.context;
  return context?.["check"] === undefined ? {} : context;
};

/**
 * A step report's failure detail when a call of it failed, for the failure archive. A check's
 * refusal is the host working as it should, so its evidence goes only in the step event.
 */
export const callFailure = (report: AutofillStepReport) =>
  report.failureDetail?.context?.["check"] === undefined ? report.failureDetail : undefined;
