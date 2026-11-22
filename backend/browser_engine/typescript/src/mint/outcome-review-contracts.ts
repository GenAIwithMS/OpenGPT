import type { Duration, Effect } from "effect";
import { Schema } from "effect";
import type { AgentInputItem, ModelProvider } from "@openai/agents";
import { GuardianSessionSnapshot } from "../guardian/session.js";
import { GuardianAction } from "../guardian/review-contracts.js";
import type { MintFailure } from "./contracts.js";

/**
 * The outcome reviewer: a separate, persistent model session that judges whether each execution
 * Guardian labelled a write actually changed the website. Guardian reviews an action before it
 * runs and never sees its result; the reviewer reads what happened afterwards, through read-only
 * tools over the minter's full history and the host's records, and records one assessment per
 * write. It has no browser, shell or website access; it can only ask the minter for a readback,
 * which the minter runs through its normal Guardian-reviewed execution.
 *
 * The harness owns the schedule (`makeOutcomeReviewer` in `outcome-review.ts`): one turn at a
 * time per mint, with events that arrive during a turn coalesced into the next. The host supplies
 * the model, persistence and journal through `OutcomeReviewHost`.
 */

/**
 * What the reviewer concluded about one write. `done`: the evidence shows the intended change
 * happened. `not_done`: the evidence shows it did not, and the evidence covers the change's
 * account, scope and time. `unknown`: the evidence cannot tell.
 */
export const outcomeAssessments = ["done", "not_done", "unknown"] as const;
export const OutcomeAssessmentValue = Schema.Literal(...outcomeAssessments);
export type OutcomeAssessmentValue = typeof OutcomeAssessmentValue.Type;

/** References the reviewer may cite as evidence, by kind; see `OutcomeRecordRef`. */
const evidenceReference = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(300));

/**
 * One assessment of one write, the newest replacing any earlier one. `executionId` is the
 * write's stable action ID: the execution Guardian labelled `write`. `version` counts this
 * write's assessments from 1, so the newest evidence wins.
 */
export const OutcomeAssessment = Schema.Struct({
  executionId: Schema.String,
  version: Schema.Int.pipe(Schema.positive()),
  outcome: OutcomeAssessmentValue,
  explanation: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1000)),
  /**
   * What the assessment rests on: `history:<offset>` or `history:<offset>-<end>` for minter
   * history items, and the `ref` of a record the reviewer read (`execution:<id>`,
   * `source:<path>`, `capture:<path>`, `publication:<n>`, `task`).
   */
  evidence: Schema.Array(evidenceReference).pipe(Schema.maxItems(20)),
  /** When the reviewer submitted it, in epoch milliseconds. */
  assessedAt: Schema.NonNegativeInt,
});
export type OutcomeAssessment = typeof OutcomeAssessment.Type;

/**
 * How a write ended as the harness saw it. A step that timed out arrives as `failed` when the
 * host returned its result, or `result_lost` when no result came back.
 */
export const WriteExecutionStatus = Schema.Literal(
  "completed",
  "failed",
  "unsupported",
  "needs_input",
  "result_lost",
);
export type WriteExecutionStatus = typeof WriteExecutionStatus.Type;

/** One execution Guardian labelled `write`, as the reviewer tracks it. */
export const OutcomeWrite = Schema.Struct({
  executionId: Schema.String,
  /** The Guardian review that allowed it, when the host reported one. */
  reviewId: Schema.optionalWith(Schema.String, { exact: true }),
  purpose: Schema.String,
  /** The submitted entrypoint, so a repeat of the same step can wait for this assessment. */
  entrypoint: Schema.optionalWith(Schema.String, { exact: true }),
  /**
   * A digest of the contents of the entrypoint's static import closure when it ran, without
   * paths, so a copy of the same step under another name is a repeat too.
   */
  sourceDigest: Schema.optionalWith(Schema.String, { exact: true }),
  status: WriteExecutionStatus,
  effect: Schema.Literal("not_sent", "possible", "verified"),
  /** The confirmation the step's code recorded, as evidence; never the outcome by itself. */
  confirmation: Schema.optionalWith(Schema.Literal("message", "readback"), { exact: true }),
});
export type OutcomeWrite = typeof OutcomeWrite.Type;

/**
 * What wakes the reviewer. `write`: a write-labelled execution returned, failed or lost its
 * result. `execution`: a later execution ran while a write was unresolved, so it may hold a
 * readback. `task_updated`: the caller's answer or an approved change altered the remaining
 * work. `finish`: the minter called finish_build with a write unresolved. Each carries its
 * sequence number, so the reviewer's cursor says which it has seen.
 */
export const OutcomeReviewEvent = Schema.Union(
  Schema.Struct({
    seq: Schema.Int.pipe(Schema.positive()),
    kind: Schema.Literal("write"),
    write: OutcomeWrite,
  }),
  Schema.Struct({
    seq: Schema.Int.pipe(Schema.positive()),
    kind: Schema.Literal("execution"),
    executionId: Schema.String,
    purpose: Schema.String,
    action: Schema.optionalWith(GuardianAction, { exact: true }),
    status: WriteExecutionStatus,
  }),
  Schema.Struct({
    seq: Schema.Int.pipe(Schema.positive()),
    kind: Schema.Literal("task_updated"),
    /** Screened host text naming what changed, never the caller's raw values. */
    change: Schema.String,
  }),
  Schema.Struct({
    seq: Schema.Int.pipe(Schema.positive()),
    kind: Schema.Literal("finish"),
  }),
);
export type OutcomeReviewEvent = typeof OutcomeReviewEvent.Type;
type Unsequenced<E> = E extends unknown ? Omit<E, "seq"> : never;
export type OutcomeReviewEventInput = Unsequenced<OutcomeReviewEvent>;

/** A readback the reviewer asked the minter for, which the minter has not yet been shown. */
export const ObservationRequest = Schema.Struct({
  executionId: Schema.String,
  request: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(500)),
  /**
   * The version of the write's assessment when the reviewer asked, 0 before any. The request is
   * pending until a newer assessment, and a pending readback keeps the write from repeating.
   */
  assessedVersion: Schema.NonNegativeInt,
  /** The minter was shown the request. */
  delivered: Schema.optionalWith(Schema.Literal(true), { exact: true }),
});
export type ObservationRequest = typeof ObservationRequest.Type;

/**
 * The reviewer's recovery state, saved beside the minter's RunState: its conversation, every
 * event with the cursor of the last one a completed turn saw, the writes it tracks, their newest
 * assessments and the readbacks it asked for that no newer assessment answered yet.
 */
export const OutcomeReviewSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  conversation: GuardianSessionSnapshot,
  events: Schema.Array(OutcomeReviewEvent),
  cursor: Schema.NonNegativeInt,
  writes: Schema.Array(OutcomeWrite),
  assessments: Schema.Array(OutcomeAssessment),
  observationRequests: Schema.Array(ObservationRequest),
  /** finish_build ran, so the end of the attempt gives the reviewer one final turn. */
  finishRequested: Schema.Boolean,
});
export type OutcomeReviewSnapshot = typeof OutcomeReviewSnapshot.Type;

/**
 * A write's status for the caller. `applied`: assessed `done`. `not_applied`: assessed
 * `not_done`. `may_have_applied`: assessed `unknown`, or never assessed. Publication never waits
 * for an assessment, so an unresolved write publishes as `may_have_applied`.
 */
export type WriteStatus = "applied" | "not_applied" | "may_have_applied";
export interface WriteOutcome {
  readonly write: OutcomeWrite;
  readonly status: WriteStatus;
  readonly assessment?: OutcomeAssessment;
}

// Read-only evidence the reviewer reads through its tools.

/** The kinds of host record the reviewer can list and read. */
export const outcomeRecordKinds = ["execution", "source", "capture", "publication"] as const;
export const OutcomeRecordKind = Schema.Literal(...outcomeRecordKinds);
export type OutcomeRecordKind = typeof OutcomeRecordKind.Type;

/**
 * One record the reviewer may read: `ref` is `<kind>:<id>`, such as `execution:<executionId>`,
 * `source:src/save.mjs`, `capture:captures/index.json` or `publication:2`. `summary` is short
 * screened host text, such as an execution's purpose, label, status and effect.
 */
export interface OutcomeRecordEntry {
  readonly ref: string;
  readonly kind: OutcomeRecordKind;
  readonly summary: string;
}

/** A range of one record's screened text, in UTF-16 code units; `nextOffset` null at its end. */
export interface OutcomeRecordChunk {
  readonly ref: string;
  readonly text: string;
  readonly offset: number;
  readonly total: number;
  readonly nextOffset: number | null;
}

/**
 * The task as the reviewer reads it: the screened original request, the caller's accepted
 * answers in the order given, and the effective task state now (the build's effect, an approved
 * change, whether the write session is open, and what publication did).
 */
export interface OutcomeTaskState {
  readonly request: unknown;
  readonly answers: readonly unknown[];
  readonly state: Readonly<Record<string, unknown>>;
}

/**
 * The host records the reviewer reads, all screened as the minter sees them: secrets appear only
 * as `{{secret.<id>}}` handles. Nothing here reaches the website or changes anything. The
 * harness builds one from its own state; a host may wrap it to add its own records.
 */
export interface OutcomeEvidence {
  /** Every record of `kind`, oldest first. */
  readonly list: (
    kind: OutcomeRecordKind,
  ) => Effect.Effect<readonly OutcomeRecordEntry[], MintFailure>;
  /** A range of a listed record; undefined for a ref no list holds. */
  readonly read: (
    ref: string,
    range: { readonly offset: number; readonly limit: number },
  ) => Effect.Effect<OutcomeRecordChunk | undefined, MintFailure>;
  /** The original request, the accepted answers and the effective task state. */
  readonly task: () => Effect.Effect<OutcomeTaskState, MintFailure>;
}

// The reviewer's tools. Inputs are decoded with these schemas; every result is JSON text.

/** Finds minter history items whose text contains every word of `query`, case-insensitive. */
export const SearchHistoryInput = Schema.Struct({
  query: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)),
  limit: Schema.Int.pipe(Schema.between(1, 20)),
});
export type SearchHistoryInput = typeof SearchHistoryInput.Type;
/** Reads minter history items `offset` to `offset + limit - 1`, the first item being offset 0. */
export const ReadHistoryInput = Schema.Struct({
  offset: Schema.Int.pipe(Schema.nonNegative()),
  limit: Schema.Int.pipe(Schema.between(1, 50)),
});
export type ReadHistoryInput = typeof ReadHistoryInput.Type;
export const ListRecordsInput = Schema.Struct({ kind: OutcomeRecordKind });
export type ListRecordsInput = typeof ListRecordsInput.Type;
export const ReadRecordInput = Schema.Struct({
  ref: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(300)),
  offset: Schema.Int.pipe(Schema.nonNegative()),
  limit: Schema.Int.pipe(Schema.between(1, 65_536)),
});
export type ReadRecordInput = typeof ReadRecordInput.Type;
/** The assessment of one tracked write; the host fills in its version and time. */
export const SubmitAssessmentInput = Schema.Struct({
  executionId: Schema.String,
  outcome: OutcomeAssessmentValue,
  explanation: OutcomeAssessment.fields.explanation,
  evidence: OutcomeAssessment.fields.evidence,
});
export type SubmitAssessmentInput = typeof SubmitAssessmentInput.Type;
/** Asks the minter for a readback that would settle one tracked write. */
export const RequestObservationInput = ObservationRequest;
export type RequestObservationInput = typeof RequestObservationInput.Type;

/** The reviewer's tools, run by the harness. No tool reaches the website or writes but these two. */
export interface OutcomeReviewTools {
  readonly searchHistory: (input: unknown) => Effect.Effect<string, MintFailure>;
  readonly readHistory: (input: unknown) => Effect.Effect<string, MintFailure>;
  readonly listRecords: (input: unknown) => Effect.Effect<string, MintFailure>;
  readonly readRecord: (input: unknown) => Effect.Effect<string, MintFailure>;
  readonly readTask: (input: unknown) => Effect.Effect<string, MintFailure>;
  /** Records the assessment through the host's journal before it answers. */
  readonly submitAssessment: (input: unknown) => Effect.Effect<string, MintFailure>;
  /** Queues the request; the minter sees it with its next tool result. */
  readonly requestObservation: (input: unknown) => Effect.Effect<string, MintFailure>;
}

/** One reviewer turn: the wake message, on the reviewer's own continuing conversation. */
export interface OutcomeReviewTurn {
  /** The wake message: the coalesced events and the writes still unresolved. */
  readonly input: string;
  /** This is the final turn at finish_build: whatever it decides stands. */
  readonly final: boolean;
  readonly conversation: {
    readonly initial: GuardianSessionSnapshot | undefined;
    readonly save: (snapshot: GuardianSessionSnapshot) => Effect.Effect<void, Error>;
  };
  readonly tools: OutcomeReviewTools;
}

/** A reviewer turn that did not complete: the model, a tool's record or the turn's time failed. */
export interface OutcomeReviewerModel {
  readonly turn: (turn: OutcomeReviewTurn) => Effect.Effect<void, MintFailure>;
}

/**
 * What a host supplies for the outcome reviewer. Absent, no write is ever assessed: every write
 * stays unresolved, is never repeated and publishes as `may_have_applied`.
 */
/**
 * Durable storage for the minter's history items its run state no longer holds: those before a
 * provider compaction, once a new run segment starts from the compacted history. Offsets are
 * positions in the minter's whole history, oldest first. The minter stores each range before
 * the run state that holds it is replaced, and records the offset its run state starts at in
 * the recovery checkpoint (`MintAgentSnapshot.historyOffset`), so after a takeover the outcome
 * reviewer reads the earlier items here and the later ones from the restored run state. The
 * archive can grow far past any checkpoint, to millions of tokens.
 */
export interface MinterHistoryArchive {
  /**
   * Stores `items` from `offset`, which is at most the archive's length. A range stored again,
   * as after a takeover from an earlier checkpoint, holds the same items and replaces them.
   */
  readonly append: (
    offset: number,
    items: readonly AgentInputItem[],
  ) => Effect.Effect<void, MintFailure>;
  /** How many items the archive holds. */
  readonly length: Effect.Effect<number, MintFailure>;
  /** At most `limit` items from `offset`, oldest first. */
  readonly read: (
    offset: number,
    limit: number,
  ) => Effect.Effect<readonly AgentInputItem[], MintFailure>;
}

/** What the minter's run state holds now: its items and the history offset of the first. */
export interface LiveMinterHistory {
  readonly offset: number;
  readonly items: readonly AgentInputItem[];
}

export interface OutcomeReviewHost {
  /** The reviewer's model; `makeOpenAIOutcomeReviewer` is the core one. */
  readonly model: OutcomeReviewerModel;
  /**
   * Durable storage for the minter's history from before a compaction, which a takeover's
   * restored run state leaves out. Without one, the harness keeps it in memory for the attempt.
   */
  readonly historyArchive?: MinterHistoryArchive;
  /** Restored state from the recovery checkpoint, beside the minter's RunState. */
  readonly initial?: OutcomeReviewSnapshot;
  /**
   * Saves the reviewer's state beside the minter's RunState, after each change. A failed save is
   * retried with the next change; it never ends the build or the turn.
   */
  readonly save: (snapshot: OutcomeReviewSnapshot) => Effect.Effect<void, MintFailure>;
  /**
   * Records a write's newest assessment in the host's journal. A failure fails the reviewer's
   * turn, which is retried, so the assessment is never reported without being recorded.
   */
  readonly recordAssessment: (
    assessment: OutcomeAssessment,
    write: OutcomeWrite,
  ) => Effect.Effect<void, MintFailure>;
  /** Wraps the harness's evidence, for a host that holds records of its own. */
  readonly evidence?: (base: OutcomeEvidence) => OutcomeEvidence;
  /**
   * Receives a reader of the tracked writes and their newest assessments, for the host's
   * Guardian execution reviews (`MintReviewHost.writes`), so Guardian denies a step that would
   * commit the same change again.
   */
  readonly bindWrites?: (read: () => readonly WriteOutcome[]) => void;
  /** Waits between failed turns, the last repeating; production default 2 s, 5 s, 15 s, 30 s, 60 s. */
  readonly retryDelays?: readonly [Duration.DurationInput, ...Duration.DurationInput[]];
  /**
   * The reviewer's own diagnostics: turn start, completion, failure and retry. Never the minter's
   * trace, so reviewer activity never counts as minter progress. Must not fail.
   */
  readonly report?: (event: Readonly<Record<string, unknown>>) => Effect.Effect<void>;
}

/** Options for the core OpenAI reviewer model. */
export interface OutcomeReviewerModelOptions {
  readonly modelProvider?: ModelProvider;
  /** Model calls one turn may make; default 32. */
  readonly maxTurns?: number;
  /** How long one turn may run; default 5 minutes. */
  readonly turnTimeout?: Duration.DurationInput;
  /** The host's `prompt_cache_key`, sent on every request and the prewarm. */
  readonly promptCacheKey?: string;
}
