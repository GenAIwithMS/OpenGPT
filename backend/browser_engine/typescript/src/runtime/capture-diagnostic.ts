import { Schema } from "effect";
export const CaptureScreeningDiagnostic = Schema.Struct({
  stage: Schema.Literal(
    "http_observation",
    "protocol_json",
    "secret_discovery",
    "page_text",
    "body_text",
    "structured_observation",
    /** The capture screening process itself, whatever it was screening. */
    "screening_process",
  ),
  reason: Schema.Literal(
    "detector_unavailable",
    "invalid_detection",
    "invalid_text",
    "closed_scope",
    /** The process exited, was killed or answered outside its protocol. */
    "process_failed",
    /** The process ran out of its own heap and exited; the worker process was unaffected. */
    "out_of_memory",
    /** The command outlived its screening deadline and was stopped. */
    "deadline",
  ),
});

/** Collector-owned categories and counts only; never source content or exception text. */
export interface CaptureCollectionDiagnostic {
  readonly stage:
    | "network_observer"
    | "page_attachment"
    | "stream_schema"
    | "checkpoint"
    | "settle"
    | "header_discovery"
    | "checkpoint_selection"
    | "promotion"
    | "lifecycle";
  /** Collector-derived cause only; never exception text or provider error details. */
  readonly cause?:
    "deadline" | "missing_context" | "context_closed" | "browser_disconnected" | "request_rejected";
  readonly elapsedMs?: number;
  readonly budgetMs?: number;
  readonly browserConnected?: boolean;
  readonly contextClosed?: boolean;
  readonly failures?: number;
  readonly observedRequests?: number;
  readonly pendingHeaders?: number;
  /** A record may have both sides pending; side counts can overlap. */
  readonly pendingRequestHeaders?: number;
  readonly pendingResponseHeaders?: number;
  readonly unavailableHeaders?: number;
}

export type CaptureFailureReason =
  | "invalid_scope"
  | "not_attached"
  | "closed"
  | "invalid_request"
  | "collection_failed"
  | "screening_failed"
  | "byte_limit"
  | "storage_failed";
