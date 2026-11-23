import { Schema } from "effect";

export const TimingToolKind = Schema.Literal(
  "read_source",
  "execute",
  "retain_capture",
  "finish_build",
  "request_input",
  "filesystem",
  "shell",
  "other",
);

/** Measured only by the trusted model adapter, never extracted from model content. */
export const ModelDiagnosticTiming = Schema.Struct({
  phase: Schema.Literal(
    "started",
    "completed",
    "failed",
    "terminal",
    "tool_started",
    "tool_completed",
    "model_requested",
    "model_returned",
    "model_failed",
    "model_unsuccessful",
    "coverage_gap",
    "skill_installed",
    "skill_read",
    "compaction_observed",
    "compaction_applied",
    "segment_boundary",
    "runtime_record",
    "projection_gap",
  ),
  sequence: Schema.Int.pipe(Schema.nonNegative()),
  runId: Schema.optional(Schema.UUID),
  toolCall: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  toolKind: Schema.optional(TimingToolKind),
  /** Set on tool_completed: whether the host tool call returned or failed. */
  toolOutcome: Schema.optional(Schema.Literal("returned", "failed")),
  /** Finite lifecycle facts. Skill names come from host-installed skills, never model text. */
  count: Schema.optional(Schema.Int.pipe(Schema.between(0, Number.MAX_SAFE_INTEGER))),
  skill: Schema.optional(Schema.String.pipe(Schema.pattern(/^[a-z0-9][a-z0-9_-]{0,63}$/))),
  summaryState: Schema.optional(Schema.Literal("returned", "absent", "not_applicable")),
  recordState: Schema.optional(Schema.Literal("persisted", "failed", "cancelled")),
  gapReason: Schema.optional(Schema.Literal("capacity", "failed", "cancelled", "flush_timeout")),
  occurredAtUtc: Schema.String.pipe(
    Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  ),
  occurredMonotonicMs: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
  /** When the measured call, tool or run began, on the same clock as `occurredMonotonicMs`;
   * a timed phase ends at `startedMonotonicMs + elapsedMs`. */
  startedMonotonicMs: Schema.optional(Schema.Number.pipe(Schema.finite(), Schema.nonNegative())),
  queueMs: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
  call: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  elapsedMs: Schema.optional(Schema.Number.pipe(Schema.finite(), Schema.nonNegative())),
});
export type ModelDiagnosticTiming = typeof ModelDiagnosticTiming.Type;
