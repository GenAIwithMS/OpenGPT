import { Schema } from "effect";
import { FailureDetailSchema, type FailureDetail } from "../runtime/failure-detail.js";

/**
 * Host-side gaps the mint continued past instead of stopping (design §3.7): a capture that
 * stayed unavailable after one retry, a replaced browser's final capture that failed, page
 * dialogs the host resolved conservatively, and a browser create Kernel rate-limited.
 */
type HostIncidentReason =
  | "proxy_swapped"
  | "kernel_rate_limited"
  | "capture_unavailable_after_retry"
  | "capture_background_unavailable"
  | "capture_final_unavailable"
  | "capture_lost_with_sandbox"
  | "capture_unavailable_at_sign_in"
  | "dialog_decision_expired"
  | "dialog_resolution_uncertain"
  | "dialog_observation_failed"
  | "dialog_action_failed";

export interface HostIncident {
  readonly source: "host";
  /**
   * `proxy_swap` is an ordinary egress move, recorded so the gap it leaves is visible; `browser`
   * is a browser start Kernel slowed, recorded so the wait is visible.
   */
  readonly kind: "capture_unavailable" | "dialog" | "proxy_swap" | "browser";
  readonly reason: HostIncidentReason;
  /** A suspected OpenGPT bug: alerted and counted, never silently absorbed. */
  readonly hostBug: boolean;
  readonly severity: "info" | "high";
  /** Set when the page may have acted on an outcome the host could not confirm. */
  readonly websiteEffect?: "may_have_dispatched";
  /** A finite code naming the failed step, never free text. */
  readonly subCause?: string;
  /** Finite fields of the failure behind the incident, such as which capture step failed. */
  readonly detail?: FailureDetail;
  /** For a capture incident: the capture step that failed and its finite cause. */
  readonly capture?: { readonly stage?: string; readonly cause?: string };
}

/**
 * A gap in a browser's request recording. The host may have missed traffic in it, so every
 * execution it overlaps is possible, never verified.
 */
export interface RecorderIncident {
  readonly source: "recorder";
  readonly kind: "observation_gap";
  readonly reason:
    | "start_incomplete"
    | "target_setup_failed"
    | "event_unreadable"
    | "transport_lost"
    | "foreign_target_unclosed"
    | "target_undetached"
    | "request_unseen";
  /** A lost socket or a target left attached at stop is ordinary; any other gap is a bug. */
  readonly hostBug: boolean;
  readonly severity: "info" | "critical";
  readonly websiteEffect: "may_have_dispatched";
  readonly targetType?: "page" | "iframe" | "worker" | "shared_worker" | "service_worker";
  readonly detail: FailureDetail;
}

export type MintIncident = RecorderIncident | HostIncident;

export const MintIncident = Schema.Union(
  Schema.Struct({
    source: Schema.Literal("host"),
    kind: Schema.Literal("capture_unavailable", "dialog", "proxy_swap", "browser"),
    reason: Schema.Literal(
      "proxy_swapped",
      "kernel_rate_limited",
      "capture_unavailable_after_retry",
      "capture_background_unavailable",
      "capture_final_unavailable",
      "capture_lost_with_sandbox",
      "capture_unavailable_at_sign_in",
      "dialog_decision_expired",
      "dialog_resolution_uncertain",
      "dialog_observation_failed",
      "dialog_action_failed",
    ),
    hostBug: Schema.Boolean,
    severity: Schema.Literal("info", "high"),
    websiteEffect: Schema.optionalWith(Schema.Literal("may_have_dispatched"), { exact: true }),
    subCause: Schema.optionalWith(Schema.String, { exact: true }),
    detail: Schema.optionalWith(FailureDetailSchema, { exact: true }),
    capture: Schema.optionalWith(
      Schema.Struct({
        stage: Schema.optionalWith(Schema.String, { exact: true }),
        cause: Schema.optionalWith(Schema.String, { exact: true }),
      }),
      { exact: true },
    ),
  }),
  Schema.Struct({
    source: Schema.Literal("recorder"),
    kind: Schema.Literal("observation_gap"),
    reason: Schema.Literal(
      "start_incomplete",
      "target_setup_failed",
      "event_unreadable",
      "transport_lost",
      "foreign_target_unclosed",
      "target_undetached",
      "request_unseen",
    ),
    hostBug: Schema.Boolean,
    severity: Schema.Literal("info", "critical"),
    websiteEffect: Schema.Literal("may_have_dispatched"),
    targetType: Schema.optionalWith(
      Schema.Literal("page", "iframe", "worker", "shared_worker", "service_worker"),
      { exact: true },
    ),
    detail: FailureDetailSchema,
  }),
);

/** The finite, URL-free fields of one suspected bug, as `mint.model_finished` records them. */
export interface HostAnomalyEntry {
  readonly kind: MintIncident["kind"];
  readonly reason: MintIncident["reason"];
  readonly severity: MintIncident["severity"];
  readonly subCause?: string;
}

export interface HostAnomalySummary {
  readonly count: number;
  readonly critical: number;
  readonly entries: readonly HostAnomalyEntry[];
}

/** How a mint attempt ended, for its one closed anomaly record. */
export type MintAttemptOutcome = "published" | "incomplete" | "failed" | "interrupted";
