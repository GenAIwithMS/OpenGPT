import type { ModelResponse } from "@openai/agents";
import { Schema, type Effect } from "effect";
import type { MintFailure } from "./contracts.js";

const ToolCall = Schema.Struct({
  callId: Schema.String,
  name: Schema.String,
  arguments: Schema.String,
  native: Schema.Boolean,
});
export type RecoveryToolCall = typeof ToolCall.Type;
const ToolResult = Schema.Struct({
  ...ToolCall.fields,
  state: Schema.Literal("started", "returned"),
  result: Schema.optional(Schema.Unknown),
});
/** Private executable state. This is never a diagnostic event or a model-visible artifact. */
export const MintAgentSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  sdkVersion: Schema.Literal("0.18.0"),
  sdkState: Schema.String,
  modelCalls: Schema.NonNegativeInt,
  finalsWithoutTool: Schema.NonNegativeInt,
  /**
   * The position in the minter's whole history of the run state's first item; the items before
   * it are in the outcome review's history archive. Absent means 0.
   */
  historyOffset: Schema.optional(Schema.NonNegativeInt),
  response: Schema.optional(Schema.Unknown),
  tools: Schema.Array(ToolResult),
});
export type MintAgentSnapshot = typeof MintAgentSnapshot.Type;
export interface MintAgentRecovery {
  readonly initial?: MintAgentSnapshot;
  /**
   * With `initial` only: one user message the restored run adds before its next model call. A
   * saved `response` replays first, with its tool calls, and the message follows their results.
   * Checkpoints hold it from the next model call on; see `MintDependencies.agentRecovery`.
   */
  readonly resumeMessage?: string;
  /** Rejoins a fenced retained execution or reads its result. Must never dispatch the action. */
  readonly recoverTool?: (
    call: RecoveryToolCall,
  ) => Effect.Effect<{ readonly result: unknown } | undefined, MintFailure>;
  /** Resolves after the full host snapshot's protected reference passes the jobs lease CAS. */
  readonly save: (snapshot: MintAgentSnapshot) => Effect.Effect<void, MintFailure>;
}

interface MintRecoveryBoundary {
  readonly model: <E>(
    state: () => string,
    counters: {
      readonly modelCalls: number;
      readonly finalsWithoutTool: number;
      /** Stored as the snapshot's `historyOffset`. */
      readonly historyOffset: number;
    },
    invoke: Effect.Effect<ModelResponse, E>,
  ) => Effect.Effect<ModelResponse, E | MintFailure>;
  readonly tool: <E>(
    call: RecoveryToolCall,
    invoke: Effect.Effect<unknown, E>,
  ) => Effect.Effect<unknown, E | MintFailure>;
}
export type MintRecoveryFactory = (
  store: MintAgentRecovery,
) => Effect.Effect<MintRecoveryBoundary, MintFailure>;
