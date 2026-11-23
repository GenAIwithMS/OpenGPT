import { Schema } from "effect";

const OpaqueId = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{1,200}$/));
const Count = Schema.Int.pipe(Schema.between(0, Number.MAX_SAFE_INTEGER));

const RuntimeRecordPhase = Schema.Literal(
  "model_requested",
  "model_returned",
  "model_failed",
  "tool_called",
  "tool_returned",
  "skill_read",
  "compaction_observed",
  "compaction_applied",
);
const TraceSource = Schema.Literal(
  "mint.model",
  "guardian.model",
  "capability.model",
  "intake.model",
  "test_generation.model",
);
export const RuntimeRecordIdentity = Schema.Struct({
  recordId: Schema.UUID,
  source: TraceSource,
  runId: Schema.UUID,
  sequence: Count,
  phase: RuntimeRecordPhase,
  occurredAtUtc: Schema.String.pipe(
    Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  ),
  call: Schema.optional(Count),
  toolCallId: Schema.optional(OpaqueId),
  toolName: Schema.optional(Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_.-]{1,64}$/))),
});
export type RuntimeRecordIdentity = typeof RuntimeRecordIdentity.Type;

/** The original SDK/provider values, before any readable projection. */
export interface RuntimeRecordInput {
  readonly identity: RuntimeRecordIdentity;
  readonly payload: unknown;
}
