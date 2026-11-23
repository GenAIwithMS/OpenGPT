import type { FailureSubCause, FailureContextValue } from "../runtime/failure-detail.js";
import type { Effect } from "effect";
import type { ModelDiagnosticTiming } from "../models/model-diagnostic-timing.js";
import type { RuntimeRecordInput } from "../models/model-runtime-record.js";

interface MintDiagnosticCorrelation {
  readonly reviewId?: string;
  readonly reviewKind?: "execution" | "publication" | "question";
  readonly executionId?: string;
  readonly sandboxName?: string;
  readonly modelTiming?: ModelDiagnosticTiming;
  readonly lifecycleObserved?: boolean;
  readonly required?: boolean;
  readonly onStored?: () => void;
  readonly eventId?: string;
}
/** Actual retention capability, absent when the composition does not retain transcripts. */
export interface MintDiagnostics {
  readonly emit: (
    name: string,
    details: unknown,
    correlation?: MintDiagnosticCorrelation,
  ) => Effect.Effect<void, Error>;
  readonly retainModelTranscript: MintDiagnostics["emit"];
  readonly retainRuntimeRecord?: (record: RuntimeRecordInput) => Effect.Effect<void, Error>;
  readonly observeModelTrace?: (
    name: "mint.model" | "guardian.model",
    timing: ModelDiagnosticTiming,
  ) => Effect.Effect<void>;
  readonly retainScreenedSource?: (args: {
    readonly reviewId: string;
    readonly observation: string;
  }) => Effect.Effect<void, Error>;
  readonly flush?: Effect.Effect<void>;
}
export interface MintReportContext {
  readonly component: string;
  readonly operation: string;
  readonly phase?: string;
  readonly subCause?: FailureSubCause;
  readonly correlation: "process" | { readonly jobId: string; readonly attemptId: string };
  readonly context?: Readonly<Record<string, FailureContextValue | undefined>>;
  readonly sink?: MintDiagnostics;
}
export interface MintReporting {
  readonly failure: (error: unknown, details: MintReportContext) => Effect.Effect<void>;
  readonly bestEffort: (
    effect: Effect.Effect<void, Error>,
    details: MintReportContext,
  ) => Effect.Effect<void>;
}
