import { Cause, Option, Runtime, Schema } from "effect";
import type { ScreeningReasonValue } from "../runtime/diagnostic-reasons.js";
export type { ScreeningReasonValue } from "../runtime/diagnostic-reasons.js";
export type StorageFailure =
  | "credentials"
  | "denied"
  | "conflict"
  | "transport"
  | "timeout"
  | "service"
  | "verification"
  | "cancelled"
  | "unavailable"
  | undefined;
const tagged = (error: unknown, tag: string): error is Readonly<Record<string, unknown>> =>
  typeof error === "object" && error !== null && "_tag" in error && error._tag === tag;

export type RetentionReason = "screening" | "serialization" | "storage" | "unclassified";
const ScreeningReason = Schema.Literal(
  "detector_unavailable",
  "invalid_detection",
  "invalid_text",
  "closed_scope",
);

/** Project only the detector's closed category through diagnostic error wrappers. */
export const diagnosticScreeningReason = (error: unknown): ScreeningReasonValue | undefined => {
  try {
    if (Runtime.isFiberFailure(error)) {
      const cause = error[Runtime.FiberFailureCauseId];
      return diagnosticScreeningReason(
        Option.getOrUndefined(Cause.failureOption(cause)) ??
          Option.getOrUndefined(Cause.dieOption(cause)),
      );
    }
    if (tagged(error, "ScreeningUnavailable"))
      return Option.getOrUndefined(Schema.decodeUnknownOption(ScreeningReason)(error.reason));
    if (tagged(error, "EventUnavailable")) {
      if (error.event !== "screening_failed") return undefined;
      return Option.getOrUndefined(
        Schema.decodeUnknownOption(ScreeningReason)(error.screeningReason),
      );
    }
    if (typeof error !== "object" || error === null || !("diagnosticScreeningReason" in error))
      return undefined;
    return Option.getOrUndefined(
      Schema.decodeUnknownOption(ScreeningReason)(error.diagnosticScreeningReason),
    );
    // error-reporting-allow: typed-recovery a finite projection of an error its caller holds; a throwing getter has no reason
  } catch {
    return undefined;
  }
};

export const diagnosticStorageFailure = (error: unknown): StorageFailure => {
  try {
    if (Runtime.isFiberFailure(error)) {
      const cause = error[Runtime.FiberFailureCauseId];
      return diagnosticStorageFailure(
        Option.getOrUndefined(Cause.failureOption(cause)) ??
          Option.getOrUndefined(Cause.dieOption(cause)),
      );
    }
    if (typeof error !== "object" || error === null || !("diagnosticStorageFailure" in error))
      return undefined;
    const reported = error.diagnosticStorageFailure;
    for (const value of [
      "credentials",
      "denied",
      "conflict",
      "transport",
      "timeout",
      "service",
      "verification",
      "cancelled",
      "unavailable",
    ] as const)
      if (reported === value) return value;
    return undefined;
    // error-reporting-allow: typed-recovery a finite projection of an error its caller holds; a throwing getter has no category
  } catch {
    return undefined;
  }
};

export const diagnosticRetentionReason = (error: unknown): RetentionReason => {
  try {
    if (Runtime.isFiberFailure(error)) {
      const cause = error[Runtime.FiberFailureCauseId];
      return diagnosticRetentionReason(
        Option.getOrUndefined(Cause.failureOption(cause)) ??
          Option.getOrUndefined(Cause.dieOption(cause)),
      );
    }
    if (tagged(error, "EventUnavailable")) {
      if (error.event === "screening_failed") return "screening";
      if (error.event === "serialization_failed" || error.event === "invalid_source_evidence")
        return "serialization";
      if (
        error.event === "diagnostic_storage_failed" ||
        error.event === "diagnostic_reference_failed" ||
        error.event === "diagnostic_scope_invalid"
      )
        return "storage";
    }
    if (typeof error === "object" && error !== null && "diagnosticRetentionReason" in error) {
      const reason = error.diagnosticRetentionReason;
      if (reason === "screening" || reason === "serialization" || reason === "storage")
        return reason;
    }
    return "unclassified";
    // error-reporting-allow: typed-recovery a finite projection of an error its caller holds; a throwing getter is unclassified
  } catch {
    return "unclassified";
  }
};
