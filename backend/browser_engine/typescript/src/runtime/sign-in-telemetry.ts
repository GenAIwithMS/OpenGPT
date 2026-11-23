import { Effect } from "effect";
import type { EventSink } from "./context.js";
import type { FailureContextValue, FailureDetail, FailureSubCause } from "./failure-detail.js";

/** Where a sign-in's report names what failed: the host's reporter reads every field as given. */
export interface SignInReportContext {
  readonly component: string;
  readonly operation: string;
  readonly phase?: string;
  readonly subCause: FailureSubCause;
  /** The host's own correlation for the sign-in, passed through unread. */
  readonly correlation: unknown;
  readonly context?: Readonly<Record<string, FailureContextValue | undefined>>;
}

/** A best-effort step's report context, whose sub-cause is optional. */
export type SignInBestEffortContext = Omit<SignInReportContext, "subCause"> & {
  readonly subCause?: FailureSubCause;
};

/**
 * What the shared sign-in code reports through, which a host sets once for its process
 * (`configureSignInTelemetry`): its failure archive and its latency events. The local host sets
 * none, so a sign-in reports nothing and behaves the same.
 */
export interface SignInTelemetry {
  /** An expected failure the sign-in goes on past. */
  readonly failure: (error: unknown, context: SignInReportContext) => Effect.Effect<void>;
  /** An unexpected failure the sign-in goes on past. */
  readonly defect: (cause: unknown, context: SignInReportContext) => Effect.Effect<void>;
  /** A step whose failure never changes the sign-in: it is reported and dropped. */
  readonly bestEffort: <A, X, R>(
    effect: Effect.Effect<A, X, R>,
    context: SignInBestEffortContext,
  ) => Effect.Effect<void, never, R>;
  /** Times one stage of the sign-in for the host's latency events. */
  readonly timeExecutionStage: <A, X, R>(
    sink: EventSink | undefined,
    stage: "autofill_settle",
    effect: Effect.Effect<A, X, R>,
  ) => Effect.Effect<A, X, R>;
  /** The host's own failure for a page call that failed, which `failure` then reports. */
  readonly pageCallFailure: (detail: FailureDetail) => unknown;
}

const silent: SignInTelemetry = {
  failure: () => Effect.void,
  defect: () => Effect.void,
  bestEffort: (effect) => Effect.ignore(effect),
  timeExecutionStage: (_sink, _stage, effect) => effect,
  pageCallFailure: (detail) => detail,
};

let telemetry: SignInTelemetry = silent;

/** Sets what the shared sign-in code reports through; the last setting wins. */
export const configureSignInTelemetry = (sink: SignInTelemetry) => {
  telemetry = sink;
};

/** The host's reporter, read at each call. */
export const report = {
  failure: (error: unknown, context: SignInReportContext) => telemetry.failure(error, context),
  defect: (cause: unknown, context: SignInReportContext) => telemetry.defect(cause, context),
  bestEffort: <A, X, R>(effect: Effect.Effect<A, X, R>, context: SignInBestEffortContext) =>
    telemetry.bestEffort(effect, context),
};

/** The host's stage timer, read at each call. */
export const timeExecutionStage = <A, X, R>(
  sink: EventSink | undefined,
  stage: "autofill_settle",
  effect: Effect.Effect<A, X, R>,
) => telemetry.timeExecutionStage(sink, stage, effect);

/** The host's failure for a page call that failed. */
export const pageCallFailure = (detail: FailureDetail) => telemetry.pageCallFailure(detail);
