import type { AgentInputItem, ModelProvider, Runner } from "@openai/agents";
import type { ModelDiagnosticTiming } from "./model-diagnostic-timing.js";
import type { RuntimeRecordIdentity, RuntimeRecordInput } from "./model-runtime-record.js";

export interface ModelDiagnosticsOptions {
  /** Required durability. Resolves only after the traced record's index/reference is usable. */
  readonly record?: (record: RuntimeRecordInput) => Promise<void>;
  /** Finite lifecycle projection for telemetry. Must not block or throw. */
  readonly observe?: (timing: ModelDiagnosticTiming) => void;
  readonly source?: RuntimeRecordIdentity["source"];
  /** Host-installed skill names; only these can be reported as read. */
  readonly skills?: readonly string[];
  /** Bounds for asynchronous readable projection when a traced record exists. */
  readonly projection?: {
    readonly maxPending: number;
    readonly maxBytes: number;
    readonly flushTimeoutMs: number;
  };
}

/** Lifecycle observer supplied by the host around the original model SDK. */
export interface ModelObserver {
  readonly attach: (runner: Runner) => void;
  readonly tool: <A>(
    call: {
      readonly name: string;
      readonly callId?: string;
      readonly arguments: string;
      readonly intent?: string;
      /**
       * Set only by a trusted host file-read tool after selecting its source path. A call that
       * reads several files dispatches once per file, each with its own path and arguments,
       * under the same `callId`.
       */
      readonly readPath?: string;
    },
    invoke: () => Promise<A>,
  ) => Promise<A>;
  readonly provider: (provider: ModelProvider) => ModelProvider;
  readonly started: (input: string | readonly AgentInputItem[]) => void;
  readonly skillsInstalled: (names: readonly string[]) => void;
  readonly segment: (details: {
    readonly reason: "sdk_turn_ceiling";
    readonly modelCalls: number;
  }) => void;
  readonly completed: (history: readonly AgentInputItem[], usage: unknown) => void;
  readonly failed: (error: unknown) => void;
  readonly takeNativeCall: () => string | undefined;
  readonly durabilityFailure: () =>
    { readonly error: unknown; readonly sequence: number; readonly phase: string } | undefined;
  /** The host owns and interprets the diagnostic payload; it grants no model authority. */
  readonly terminal: () => {
    readonly phase: string;
    readonly timing: ModelDiagnosticTiming;
    readonly value: unknown;
  };
  readonly flush: () => Promise<void>;
}

export type ModelObserverFactory = (
  persist: (value: unknown, timing: ModelDiagnosticTiming) => Promise<void>,
  signal?: AbortSignal,
  options?: ModelDiagnosticsOptions,
) => ModelObserver;
