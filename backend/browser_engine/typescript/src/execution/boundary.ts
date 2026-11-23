import { Data } from "effect";
import type { FailureDetail } from "../runtime/failure-detail.js";

export type ProcessStatus = "running" | "completed" | "failed" | "killed" | "stopped" | "unknown";

/**
 * How an execution's result file failed to be a runner result. A runner that ran and reported a
 * failure is not a defect: its result decodes with `status: "failed"` and its own error code.
 */
export type RunnerResultCause =
  "missing" | "empty" | "truncated" | "invalid_encoding" | "malformed_json" | "invalid_shape";

export interface RunnerResultDefect {
  readonly cause: RunnerResultCause;
  readonly resultBytes: number;
  /** The runner's exit status as its launch shell reported it. */
  readonly exitCode: number;
  /** The signal that ended the runner, when its shell reported one (exit status 128 + n). */
  readonly signal?: string;
  readonly processStatus?: ProcessStatus;
  readonly processElapsedMs?: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly eventsBytes: number;
  /** Whether the events channel ended on a whole line; a runner cut off mid-write leaves part of one. */
  readonly eventsComplete: boolean;
  /** Channels whose file did not exist when read. */
  readonly missingChannels: readonly RunnerChannel[];
  /** How long before launch the sandbox's lifetime was last extended, which redeploys it. */
  readonly sinceLifetimeUpdateMs?: number;
}

export class ExecutionBoundaryError extends Data.TaggedError("ExecutionBoundaryError")<{
  /** Provider error, stack and site; archive-only (see ERROR-LOGGING-STANDARD.md). */
  readonly failureDetail?: FailureDetail;
  readonly phase: "prepare" | "execute" | "stop";
  readonly reason:
    | "invalid_request"
    | "provider_unavailable"
    | "invalid_response"
    | "isolation_unverified"
    | "cleanup_unconfirmed"
    | "allocation_unresolved";
  readonly dispatch: "not_sent" | "unknown";
  readonly stage?:
    | "create"
    | "setup"
    | "browser_bridge"
    | "operation_files"
    | "operation_launch"
    | "process_wait"
    | "process_poll"
    | "control_read"
    | "control_write"
    | "result_read"
    | "stdout_read"
    | "stderr_read"
    | "events_read"
    | "result_decode"
    | "sandbox_inspect"
    | "sandbox_remove"
    // A shared run VM's slot: its lease, a login that moved since it, its policy and release.
    | "sandbox_lease"
    | "sandbox_key_moved"
    | "sandbox_policy"
    | "sandbox_release";
  readonly elapsedMs?: number;
  readonly providerStatus?: number;
  /**
   * A job workspace staging failure: which operation, why, and which workspace paths. The paths are
   * the agent's own workspace files, so the agent sees them and can act on them.
   */
  readonly workspace?: {
    readonly operation: "stage";
    readonly reason: "digest_mismatch" | "provider_failed";
    readonly fileCount: number;
    readonly mismatched?: readonly string[];
  };
  /** Trusted host correlation; excluded from model-facing execution failure metadata. */
  readonly sandboxName?: string;
  readonly process?: {
    readonly initialPid: number | null;
    readonly initialStatus: ProcessStatus;
    readonly lastPid: number | null;
    readonly lastStatus: ProcessStatus;
    readonly polls: number;
    readonly elapsedMs: number;
  };
  /**
   * Why an execution's result could not be read, with what its runner process and channels
   * showed. Finite host facts only: no channel content, sandbox or process identity.
   */
  readonly runnerResult?: RunnerResultDefect;
  readonly providerCode?:
    | "ETIMEDOUT"
    | "ECONNRESET"
    | "ECONNREFUSED"
    | "ENOTFOUND"
    | "EAI_AGAIN"
    | "EPIPE"
    | "UND_ERR_CONNECT_TIMEOUT"
    | "UND_ERR_HEADERS_TIMEOUT"
    | "UND_ERR_SOCKET"
    | "HTTP2_RESET"
    | "ABORT_ERR"
    | "TimeoutError"
    | "AbortError"
    | "HOST_CALL_TIMEOUT"
    | "PROCESS_DEADLINE_EXCEEDED";
}> {}

/** The operation runner's four output channels, each a file its launch opened. */
export type RunnerChannel = "result" | "stdout" | "stderr" | "events";
