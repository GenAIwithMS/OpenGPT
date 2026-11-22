import { makeGuardianSession } from "./session.js";
import type { GuardianSession, GuardianSessionOptions } from "./session.js";
import { QuestionDecision } from "./question.js";
import { anchorQuotedFindings, decodePublicationDecision } from "./publication.js";
import {
  publicationContext,
  publicationDelta,
  publicationDeltaCounts,
  publicationRound,
} from "./publication-delta.js";
import type {
  PublicationDelta,
  PublicationRound,
  PublicationRoundFile,
} from "./publication-delta.js";
import type { AnsweredQuestion, PendingQuestion } from "./question.js";
import { TaskUpdateDecision } from "./task-update.js";
import { completeSource, wholeSource } from "./source.js";
import { makeOwnerConfirmations, stepIdentity } from "./owner-confirmation.js";
import type { HeldStepQuestion, OwnerConfirmedStep } from "./owner-confirmation.js";
import type { PendingTaskUpdate, ReviewedTaskUpdate } from "./task-update.js";
import {
  failureDetail,
  failureDetailMetadata,
  failureDetailOf,
} from "../runtime/failure-detail.js";
import type { FailureDetail } from "../runtime/failure-detail.js";
import { randomUUID } from "node:crypto";
import {
  Cause,
  Clock,
  Data,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Runtime,
  Schema,
} from "effect";
import type { ModelDiagnosticTiming } from "../models/model-diagnostic-timing.js";
import type { WritePath } from "../mint/contracts.js";
import type { RuntimeRecordInput } from "../models/model-runtime-record.js";
import type { GuardianReasoningEffort } from "./model.js";
import type { PromptCacheDiagnostic } from "../models/cached-instructions.js";
export type { PromptCacheDiagnostic } from "../models/cached-instructions.js";
import {
  cutToLimit,
  GuardianAction,
  GuardianRefusal,
  guardianRefusals,
  PublicationFinding,
  PublicationReason,
} from "./review-contracts.js";
import type {
  GuardianRefusalGround,
  PublicationScope,
  PublicationFileBlock,
} from "./review-contracts.js";
import {
  decisionForKind,
  guardianOutcomes,
  outcomeAccepted,
  reviewKindOf,
  reviewOutcomesOf,
  sourceChunkOf,
  sourceLedger,
  sourcePath,
  unchangedSources,
} from "./review-layout.js";
import type { GuardianOutcome, ReviewKind } from "./review-layout.js";
export type { PublicationFileBlock } from "./review-contracts.js";
export type { GuardianOutcome, ReviewKind } from "./review-layout.js";

export interface GuardianDiagnostics {
  readonly emit: (
    name: string,
    details: unknown,
    correlation?: {
      readonly reviewId?: string;
      readonly reviewKind?: "execution" | "publication" | "question" | "update" | "host";
      readonly modelTiming?: ModelDiagnosticTiming;
      readonly required?: boolean;
    },
  ) => Effect.Effect<void, Error>;
  readonly retainModelTranscript: GuardianDiagnostics["emit"];
  readonly retainRuntimeRecord?: (record: RuntimeRecordInput) => Effect.Effect<void, Error>;
  /**
   * Finite model and tool timing of a review whose model transcript is not retained, such as a
   * private host kind's. A review that retains its transcript carries the timing there instead,
   * so no model call is reported twice. Must not fail.
   */
  readonly observeModelTrace?: (
    name: "guardian.model",
    timing: ModelDiagnosticTiming,
    correlation?: {
      readonly reviewId?: string;
      readonly reviewKind?: "execution" | "publication" | "question" | "update" | "host";
    },
  ) => Effect.Effect<void>;
  readonly retainScreenedSource: (args: {
    readonly reviewId: string;
    readonly observation: string;
  }) => Effect.Effect<void, Error>;
}
export interface GuardianReviewOptions {
  /**
   * Decodes a publication decision in place of `decodePublicationDecision`, for a host that runs
   * its own publication review. It must be pure and may run more than once per model output: the
   * review also runs it, with no source reads, to decide whether an output needs the decode
   * follow-up. Only an `InvalidDecision` it returns at once gets that follow-up; another code, or
   * a decode that needs asynchronous work, gets none.
   */
  readonly decodePublication?: (
    scope: PublicationScope,
    raw: unknown,
  ) => Effect.Effect<GuardianDecision, ReviewFailure>;
  readonly diagnosticFailure?: (error: unknown, operation: string) => ReviewFailure;
  readonly bestEffort?: <A, E>(
    effect: Effect.Effect<A, E>,
    operation: string,
  ) => Effect.Effect<void>;
}

const rationaleLimit = 4000;
/**
 * A decision whose rationale is longer than the 4,000 characters it may hold keeps its first
 * 3,999 and an ellipsis, rather than failing as InvalidDecision and losing the decision: a denial
 * names every problem the source has, so its rationale can outgrow the limit the model is told.
 */
const boundedRationale = (raw: unknown): unknown => {
  if (typeof raw !== "object" || raw === null) return raw;
  const rationale: unknown = Reflect.get(raw, "rationale");
  if (typeof rationale !== "string" || rationale.length <= rationaleLimit) return raw;
  return { ...raw, rationale: cutToLimit(rationale, rationaleLimit) };
};

/** The characters an allow's advice may hold; the host cuts a longer one to fit. */
const adviceLimit = 2000;
/**
 * A decision with its advice kept only on an allow and only when it says something, cut to its
 * limit. Advice never blocks a step, so on a deny or escalate, whose rationale already carries
 * everything the agent must change, the host drops it.
 */
const allowAdvice = (raw: unknown): unknown => {
  if (typeof raw !== "object" || raw === null || !("advice" in raw)) return raw;
  const { advice, ...rest } = raw as Record<string, unknown>;
  return Reflect.get(raw, "outcome") === "allow" &&
    typeof advice === "string" &&
    advice.trim() !== ""
    ? { ...rest, advice: cutToLimit(advice, adviceLimit) }
    : rest;
};

export const GuardianDecision = Schema.Struct({
  outcome: Schema.Literal("allow", "deny", "escalate"),
  rationale: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4000)),
  /** A publication review's finite reason; execution reviews have none. */
  reason: Schema.optional(Schema.suspend(() => PublicationReason)),
  findings: Schema.optional(Schema.Array(Schema.suspend(() => PublicationFinding))),
  /**
   * A publication review's input design findings about choices on the site's sign-in pages, in
   * the host's sign-in recipe, which a temporary exception sets aside until such choices become
   * declared sign-in inputs (`decodePublicationDecision`). Reported, never blocking.
   */
  excusedSignInChoices: Schema.optional(Schema.Array(Schema.suspend(() => PublicationFinding))),
  /**
   * A publication denial's one short sentence its caller may read: why the tool was not
   * published, in plain words, apart from the private rationale. Other kinds have none.
   */
  publicReason: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  /**
   * An execution review's label of what the code does on the website. Every execution allow
   * carries one; a deny or escalate may. Other kinds have none.
   */
  action: Schema.optional(Schema.suspend(() => GuardianAction)),
  /**
   * An execution deny or escalate's refusal kind: `final` or `correctable`. Absent, from a
   * reviewer that predates it, the host counts the refusal as `final`. Other kinds have none.
   */
  refusal: Schema.optional(Schema.suspend(() => GuardianRefusal)),
  /**
   * An execution or recovery allow's note for the agent, such as a doubt about which page value
   * the request asks for. It never blocks the step; the host returns it with the allow. Other
   * outcomes and kinds have none.
   */
  advice: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(adviceLimit))),
});
export type GuardianDecision = typeof GuardianDecision.Type;
export class ReviewFailure extends Data.TaggedError("ReviewFailure")<{
  readonly code:
    | "Unavailable"
    /**
     * The review's decision does not decode. After the in-review correction that named the error,
     * it is never retried as an outage, since the model already saw why. A review that could get
     * no correction, as a private host kind's or one whose reviewer sends no follow-up, is
     * reviewed once more, since a fresh sample may decode.
     */
    | "InvalidDecision"
    /**
     * The review returned an outcome its kind does not return, still after the in-review
     * correction that named the outcomes it does. Reviewing the same input again repeats it, so it
     * is never retried as an outage.
     */
    | "InvalidOutcome"
    | "SourceUnavailable"
    | "PublicationBlocked"
    /**
     * The review used its turn limit and its one final turn, which may not read, still returned no
     * decision. Running it again would repeat that work, so it is never retried as an outage.
     */
    | "TurnLimitExceeded"
    /**
     * One model call went without a response for the per-call bound, and so did each time the
     * reviewer sent that same call again. Never retried as an outage, which would start the whole
     * review again.
     */
    | "ModelCallStalled"
    /**
     * The model provider refused the review's request as over the model's input limit, its context
     * window. That is no outage, and the same request fails the same way, so it is never retried as
     * one.
     */
    | "InputTooLarge"
    /**
     * An execution review allowed without reading the submitted entrypoint, still after the
     * in-review rounds that asked for it. A verdict on unread source, not an outage: no retry.
     */
    | "EntrypointNotRead";
  readonly reviewPhase?: "review_computation" | "diagnostic_retention";
  /**
   * The model provider refused the review's call because the account's quota is spent. Reviewing
   * again cannot help, and the attempt ends as the `model_quota_exhausted` host failure.
   */
  readonly modelQuotaExhausted?: true;
  /** Sub-cause, operation, underlying error, stack and context; see ERROR-LOGGING-STANDARD.md. */
  readonly failureDetail?: FailureDetail;
  readonly publicationBlock?: PublicationFileBlock;
  readonly diagnosticRetentionReason?: "screening" | "serialization" | "storage" | "unclassified";
  readonly diagnosticScreeningReason?:
    "detector_unavailable" | "invalid_detection" | "invalid_text" | "closed_scope" | undefined;
  readonly diagnosticStorageFailure?:
    | "credentials"
    | "denied"
    | "conflict"
    | "transport"
    | "timeout"
    | "service"
    | "verification"
    | "cancelled"
    | "unavailable"
    | undefined;
}> {}

/** A copy for a serialized cause; its `failureDetail` is projected separately. */
const withoutDetail = (failure: ReviewFailure): ReviewFailure =>
  failure.failureDetail === undefined
    ? failure
    : new ReviewFailure({
        code: failure.code,
        ...(failure.publicationBlock === undefined
          ? {}
          : { publicationBlock: failure.publicationBlock }),
        ...(failure.reviewPhase === undefined ? {} : { reviewPhase: failure.reviewPhase }),
        ...(failure.modelQuotaExhausted === true ? { modelQuotaExhausted: true } : {}),
        ...(failure.diagnosticRetentionReason === undefined
          ? {}
          : { diagnosticRetentionReason: failure.diagnosticRetentionReason }),
        ...(failure.diagnosticScreeningReason === undefined
          ? {}
          : { diagnosticScreeningReason: failure.diagnosticScreeningReason }),
        ...(failure.diagnosticStorageFailure === undefined
          ? {}
          : { diagnosticStorageFailure: failure.diagnosticStorageFailure }),
      });

/**
 * One review of a kind the host defines, run on the same Guardian conversation with the same
 * instructions, tool and output format as every built-in kind, so the cached prefix holds.
 */
export interface HostReview {
  /** The host's name for the kind, sent as trusted_review.kind. */
  readonly kind: string;
  /**
   * The host's policy for the kind, sent as trusted_review.policy, after the policy the
   * reviewer's `GuardianHostPolicies.hostKinds` registers for the kind, if that is other text.
   */
  readonly policy: string;
  /** What the kind judges, sent as host_review. Untrusted unless the policy says otherwise. */
  readonly evidence: unknown;
  /** The outcomes, from the shared vocabulary, that this kind may return. */
  readonly outcomes: readonly [GuardianOutcome, ...GuardianOutcome[]];
  /**
   * The finite codes the decision's label may take, which the policy names. Absent, the kind
   * returns no label.
   */
  readonly labels?: readonly [string, ...string[]];
  /**
   * The labels each listed outcome may carry, from `labels`, as the policy ties them; an outcome
   * it does not list carries any of them. A decision whose label its outcome does not carry is
   * invalid: a kind that is not private is told so once in the same review, as for an outcome.
   */
  readonly outcomeLabels?: Partial<Record<GuardianOutcome, readonly [string, ...string[]]>>;
  /**
   * Private review context: no readable diagnostic keeps the evidence, the transcript or the
   * rationale, and later reviews' readable records show the exchange only as a placeholder.
   */
  readonly private?: boolean;
}

/** A host-defined kind's decision: one of its outcomes, a rationale and any label. */
export interface HostReviewDecision {
  readonly outcome: GuardianOutcome;
  readonly rationale: string;
  readonly label?: string;
}

export interface PendingExecution {
  readonly invocationId: string;
  readonly attemptId: string;
  /**
   * The agent's own submitted file, never a host wrapper around it. An execution review includes
   * its first chunk in the request and allows only once Guardian has it in view.
   */
  readonly entrypoint: string;
  /**
   * The host's own trusted wrapper that loads the entrypoint, when it runs one: its path and
   * what it does. Guardian may read it but need not; the host wrote it, not the agent.
   */
  readonly hostWrapper?: {
    readonly path: string;
    readonly description: string;
  };
  // Intent and input have already crossed the trusted privacy broker. Observations carry the
  // published login URL raw, exactly as stored.
  readonly screenedIntent: string;
  /** Mints only: the screened intent as the owner submitted it. */
  readonly requestedIntent?: string;
  /**
   * Mints only: the caller-confirmed updates to the task that the host accepted, oldest first.
   * The effective task is `screenedIntent` with each applied in order. Every review after an
   * update reads them, and `allowedOrigins` is already rebound to a changed site.
   */
  readonly taskUpdates?: readonly ReviewedTaskUpdate[];
  readonly screenedInput: string;
  /**
   * Execution reviews only: the agent's own description of the step, the screened `intent` of its
   * execute call. Untrusted, never authority; the review reads at most its first 500 characters.
   */
  readonly agentNote?: string;
  /**
   * Execution reviews only: the write path a write build's act step declares or revises, screened,
   * as its execute call carries it. Untrusted call data, never authority.
   */
  readonly writePath?: WritePath;
  readonly screenedObservations: string;
  readonly accountScope: string;
  readonly allowedOrigins: readonly string[];
  /** A proposed input request; set only by `reviewQuestion`. */
  readonly questionCandidate?: PendingQuestion;
  /**
   * The minting agent's request for a new browser, with its screened reason; set only by
   * `reviewRecovery`. It runs no code, so no entrypoint read is required.
   */
  readonly recoveryCandidate?: { readonly rationale: string };
  /** A host-defined review kind's request; set only by `reviewHostKind`. */
  readonly hostReview?: HostReview;
  /** The minting agent's proposed task update; set only by `reviewTaskUpdate`. */
  readonly updateCandidate?: PendingTaskUpdate;
  readonly allowedEffects: readonly string[];
  /**
   * Execution reviews only: whether this step's authority includes a website write, as a write
   * build's write step has. An allow Guardian labels `write` without it is refused as out of
   * authority. Absent means no write authority.
   */
  readonly writeAuthority?: boolean;
  /**
   * The questions the owner answered in this job through the host's question flow, each with its
   * screened answer, in the order answered; a prompt asked again keeps only its latest answer.
   * Protected answers (secrets and logins) and a read-or-write choice are left out.
   */
  readonly answeredQuestions?: readonly AnsweredQuestion[];
  /**
   * Execution reviews only: the screened results of this attempt's last six steps, oldest first,
   * as the agent received them, each capped at 4 KiB. Untrusted website evidence, never authority.
   */
  readonly stepResults?: readonly {
    readonly executionId: string;
    readonly result: string;
  }[];
  /** Publication-only privacy scope selected by the host, never by the reviewer. */
  readonly publication?: PublicationScope;
  /** Host-selected mechanics and recorded chronology, not website claims or added authority. */
  readonly mintContext?: {
    /** Host authorization mechanics only; does not establish the source's read semantics. */
    readonly repeatableRead: boolean;
    /** Exact host-bound operation namespace available through readSource. */
    readonly operationSources: readonly string[];
    /**
     * Execution reviews of source only: the host's static import closure of the submitted
     * entrypoint, a lower bound on the operation files it loads. A module that could load a file
     * its imports do not name keeps every candidate file in it.
     */
    readonly executedSources?: readonly string[];
    /**
     * Execution reviews of source only: the screened JSON input schema the host last read, the
     * registered tool's in maintenance, else the one this attempt's latest example or contract
     * extraction declared. Absent before either; the source may have changed since.
     */
    readonly inputSchema?: string;
    /** Host-selected mechanics, not evidence of website state or additional authority. */
    readonly currentExecution?: {
      readonly purpose:
        | "command"
        | "explore"
        | "authenticate"
        | "test"
        | "example"
        | "act"
        | "inspect"
        | "residual"
        | "validate"
        | "contract"
        | "card_fill";
      readonly target: "pureFiles" | "savedHTTP" | "savedDOM" | "liveBrowser";
      /**
       * agent_chosen: a read's live test on an input the minting agent chose instead of the
       * caller's. intent_derived: a read's example or a write's act step whose caller sent empty
       * input runs the agent's reading of the intent and the owner's answered questions as its
       * submitted input. agent_chosen_batch: a batch of a read's live tests on inputs the minting
       * agent chose, whose submitted input lists each case's input under `cases`.
       */
      readonly input?: "agent_chosen" | "intent_derived" | "agent_chosen_batch";
      /**
       * Host facts about an offline command's sandbox. The submitted entrypoint is the command
       * text itself; the host runs it through its own shell wrapper, which is not reviewed.
       */
      readonly commandSandbox?: {
        readonly cwd: string;
        readonly timeoutSeconds: number;
        readonly maxOutputBytes: number;
      };
    };
    readonly browser: "not_opened" | "active" | "closed" | "unavailable";
    /**
     * Host fact, present only while no sign-in in this attempt is verified: the `{{secret.<id>}}`
     * handles answering a one-time or authenticator code question the agent asked after an
     * authenticate step of this attempt and before any verified sign-in, the code the site sent
     * as part of that sign-in. A code asked any other time is never listed.
     */
    readonly signInCodes?: readonly string[];
    /**
     * A write build's recorded write path, screened: the one an act step declared or revised that
     * an execution review allowed, recorded once that step dispatched. Absent before the session's
     * first act step, and for a session a host started without one.
     */
    readonly writePath?: WritePath;
    readonly captureIndex?: string;
    /**
     * The host's own notice, present once it replaced the attempt's browser (a proxy, mode or
     * loss recovery, or the agent's reviewed request): it directed the agent to navigate on from
     * the new browser's current page. Host-written, never agent text.
     */
    readonly browserReplacement?: { readonly notice: string };
    /**
     * Where the host last observed the active browser's page: the origin and path from its
     * latest capture checkpoint, and that checkpoint's readable capture. Host-verified, not a
     * website claim. Absent before an observation, and after a new browser or a page reset
     * until the next one.
     */
    readonly currentPage?: {
      readonly origin: string;
      readonly path: string;
      readonly capture: string;
    };
    readonly executions: readonly {
      readonly executionId: string;
      readonly attempt: "current" | "previous";
      readonly purpose: string;
      readonly target?: string;
      readonly status: "running" | "completed" | "failed" | "unsupported" | "needs_input";
      readonly effect: "not_sent" | "possible" | "verified";
      /** True only after the host confirms cleanup of this execution's sandbox. */
      readonly executorStopped?: boolean;
      /**
       * agent_chosen: a read's live test ran an input the minting agent chose.
       * agent_chosen_batch: a batch of such live tests on inputs it chose.
       */
      readonly input?: "agent_chosen" | "agent_chosen_batch";
      /**
       * The task revision the execution ran under, once an update applied: 0 for the original
       * request, else the `taskUpdates` revision then in force. What it did is judged against that
       * revision, never a later one.
       */
      readonly taskRevision?: number;
      readonly authentication?: {
        readonly state: "authenticated" | "failed";
        readonly effect: "possible" | "verified";
      };
    }[];
    /**
     * Execution reviews only: this build's earlier write executions and the outcome review's
     * newest finding for each, so a step that would commit the same change again is denied.
     * `unassessed`: no assessment yet.
     */
    readonly writes?: readonly {
      readonly executionId: string;
      readonly purpose: string;
      readonly entrypoint?: string;
      readonly outcome: "done" | "not_done" | "unknown" | "unassessed";
    }[];
    /**
     * Execution reviews only: this attempt's latest live test batches, and any older one holding
     * a failure that still stands on its source, oldest first, as the harness judged them
     * (`LiveTestHost.bindBatches`). Empty before a batch ran in this attempt,
     * a takeover's included; absent from a host that does not bind them.
     */
    readonly liveTests?: readonly ReviewedLiveTestBatch[];
  };
}

/**
 * One live test batch as an execution review sees it: the host facts that show which cases passed
 * on which source, so a review can tell whether a suite already ran on the source it judges.
 */
export interface ReviewedLiveTestBatch {
  /** The batch's own Guardian review, or the harness's id for a host that names none. */
  readonly batchId: string;
  /** The entrypoint the batch ran, under `operation/` as the review reads it. */
  readonly entrypoint: string;
  /** The digest of the source the batch ran: its entrypoint and its static import closure. */
  readonly sourceDigest: string;
  /** Whether that entrypoint and its static import closure are unchanged since the batch ran. */
  readonly sourceUnchanged: boolean;
  readonly cases: readonly {
    readonly id: string;
    readonly verdict: "pass" | "fail" | "inconclusive";
    /** `cold`: the case ran first on a new browser with an empty profile. */
    readonly start?: "cold" | "warm";
  }[];
}

/** Token counts of one review's model calls, summed over its calls. */
export interface GuardianUsage {
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly cacheWriteTokens: number;
  /** `cacheWriteTokens` written for 30 minutes and for 12 hours; a host's own reviewer may leave them out. */
  readonly cacheWrite30mTokens?: number;
  readonly cacheWrite12hTokens?: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  /**
   * Each model call's prompt cache comparison with the conversation's previous response, in call
   * order, for the calls whose response reported one: enums and counts only.
   */
  readonly promptCacheDiagnostics?: readonly PromptCacheDiagnostic[];
  /** The reasoning effort the review ran at; a host's own reviewer may leave it out. */
  readonly reasoningEffort?: GuardianReasoningEffort;
}

/** What the host puts in view before the reviewer runs. */
export interface ReviewSources {
  /** The entrypoint's first chunk, read by the host; absent when that read failed. */
  readonly entrypoint?: unknown;
  /** Executed sources byte-identical to a read already in this conversation's view. */
  readonly unchangedSources?: readonly string[];
  /** A later publication round's change since the mint's prior round, and that round's decision. */
  readonly publicationDelta?: PublicationDelta;
  /**
   * An execution review only: the owner's yes that confirms exactly this step, which an earlier
   * execution review held for the owner's confirmation. Guardian found it itself: the same
   * entrypoint, purpose, target, input and file text as the held step, and the host's record of
   * the owner's answer to the confirm question a question review allowed.
   */
  readonly ownerConfirmedStep?: OwnerConfirmedStep;
  /**
   * A question review only: the request's confirm questions that ask the owner to confirm a step
   * an execution review in this job held for that confirmation, with that review's rationale.
   */
  readonly heldStepQuestions?: readonly HeldStepQuestion[];
}

export interface ReviewTurn {
  readonly reviewId: string;
  readonly session?: GuardianSession;
  readonly pending: PendingExecution;
  readonly sources?: ReviewSources;
  readonly readSource: (path: string, offset: number) => Effect.Effect<string, ReviewFailure>;
  /**
   * Runs a `read_source` search, whose reads still go through `readSource`, so that a file
   * Guardian only searched does not count as read whole for a later publication round. A host
   * that wraps `readSource` keeps seeing every read, searches included. Absent, a search runs as
   * is.
   */
  readonly uncountedReads?: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
  /**
   * The follow-up the reviewer sends, in the same review, when the host cannot take its output
   * yet: once for an outcome the review's kind does not return and once for a decision that does
   * not decode (neither for a private host kind), and up to twice for a required read it did not
   * do. Undefined when the output stands; a reviewer sends at most `reviewFollowUpRounds`.
   */
  readonly followUp?: (raw: unknown) => string | undefined;
  readonly reportUsage?: (usage: GuardianUsage) => Effect.Effect<void>;
  readonly reportDiagnostic?: (
    value: unknown,
    timing?: ModelDiagnosticTiming,
  ) => Effect.Effect<void, ReviewFailure>;
  /** Required traced original model/tool record; a failure ends the review unavailable. */
  readonly retainRuntimeRecord?: (record: RuntimeRecordInput) => Effect.Effect<void, ReviewFailure>;
  /** Finite timing only, for a review whose transcript is not retained (no `reportDiagnostic`). */
  readonly observeTiming?: (timing: ModelDiagnosticTiming) => Effect.Effect<void>;
  /**
   * A model call that went without a response for the per-call bound and is being sent again,
   * with the same input: `attempt` counts the calls that stalled so far. Must not fail.
   */
  readonly observeModelCallRetry?: (retry: {
    readonly attempt: number;
    readonly timeoutMs: number;
  }) => Effect.Effect<void>;
}

/** The retention failure's own detail (operation, underlying error) beneath the review's. */
const retentionDetail = (error: unknown, operation: string) =>
  failureDetail("guardian_dependency_failed", {
    operation,
    error,
    helperFrames: 1,
  });

/** Maps a traced-record failure to the existing diagnostic-retention review outcome. */
const guardianRuntimeRecords = (
  diagnostics: GuardianDiagnostics | undefined,
  options: GuardianReviewOptions,
) => {
  const retain = diagnostics?.retainRuntimeRecord;
  return retain === undefined
    ? undefined
    : (record: RuntimeRecordInput) =>
        retain(record).pipe(
          Effect.mapError(
            (error) =>
              options.diagnosticFailure?.(error, "diagnostics.retainRuntimeRecord") ??
              new ReviewFailure({
                code: "Unavailable",
                reviewPhase: "diagnostic_retention",
                failureDetail: retentionDetail(error, "diagnostics.retainRuntimeRecord"),
              }),
          ),
        );
};

/**
 * How the host retries a review that did not complete. Waits run between attempts, the last
 * one repeating; a run of consecutive outages retries only within `budget`, then its failure is
 * returned as before.
 */
export interface ReviewRetry {
  readonly delays: readonly [Duration.DurationInput, ...Duration.DurationInput[]];
  readonly budget: Duration.DurationInput;
}

/**
 * Production retry for Guardian outages: provider errors and a required source read that failed.
 * A review that ran out of turns, whose model call stalled or whose request is over the model's
 * context window is not an outage, and is not started again. A decision that did not decode is
 * reviewed once more only when its review got no correction.
 */
export const guardianOutageRetry: ReviewRetry = {
  delays: ["2 seconds", "5 seconds", "15 seconds", "30 seconds", "60 seconds"],
  budget: "5 minutes",
};

/**
 * An outage the same review can get past by running again. Diagnostic retention keeps its own
 * handling, a spent model quota stays spent, and a refusal is a verdict, not an outage.
 */
const retriableOutage = (failure: ReviewFailure): boolean =>
  failure.modelQuotaExhausted !== true &&
  failure.reviewPhase !== "diagnostic_retention" &&
  failure.diagnosticRetentionReason === undefined &&
  (failure.code === "Unavailable" || failure.code === "SourceUnavailable");

/** The most fresh reviews a run of undecodable decisions without a correction gets. */
const uncorrectedDecodeRetries = 1;

export interface Reviewer {
  readonly run: (turn: ReviewTurn) => Effect.Effect<unknown, ReviewFailure>;
  /** Host retry for outages. Absent, a failed review returns at once. */
  readonly retry?: ReviewRetry;
}

/**
 * A failed read of a file the host provides: its source reader names the file's kind
 * `host_sdk` (see `hostProvidedSource`).
 */
const hostSourceGap = (failure: ReviewFailure) =>
  failure.code === "SourceUnavailable" &&
  failure.failureDetail?.context?.["pathCategory"] === "host_sdk";

/**
 * A deny or escalate after Guardian could not read a file the host provides rests on the host's
 * gap, which the minter cannot fix: the review fails with that read's `SourceUnavailable`, an
 * outage the host retries and that ends a build as a host failure, never as a policy refusal. An
 * allow stands, and a missing authored file stays Guardian's to judge.
 */
export const refusalsOnHostGapsFail = (reviewer: Reviewer): Reviewer => ({
  ...reviewer,
  run: (turn) =>
    Effect.suspend(() => {
      let gap: ReviewFailure | undefined;
      return reviewer
        .run({
          ...turn,
          readSource: (path, offset) =>
            turn.readSource(path, offset).pipe(
              Effect.tapError((error) =>
                Effect.sync(() => {
                  if (hostSourceGap(error)) gap ??= error;
                }),
              ),
            ),
        })
        .pipe(
          Effect.flatMap((raw) => {
            const outcome: unknown =
              typeof raw === "object" && raw !== null ? Reflect.get(raw, "outcome") : undefined;
            return gap !== undefined && (outcome === "deny" || outcome === "escalate")
              ? Effect.fail(gap)
              : Effect.succeed(raw);
          }),
        );
    }),
});

/**
 * One run of a review inside the outage retry loop. Offsets are `performance.now()` readings.
 * Each attempt is a fresh review with its own ID and its own `guardian.started` record, closed
 * by one `guardian.completed` or `guardian.failed`. The follow-up rounds an execution review
 * gets for a skipped entrypoint read stay inside its attempt, under the same review ID, and its
 * closing record counts them as `followUpRounds`.
 */
interface ReviewAttempt {
  /** 1-based, counting outage retries only. */
  readonly ordinal: number;
  /** This attempt's own wait for the session permit, when it ran under one. */
  readonly permitWait?: {
    readonly startOffsetMs: number;
    readonly endOffsetMs: number;
  };
  readonly started: (correlation: {
    readonly reviewId: string;
    readonly reviewKind: "execution" | "publication" | "question" | "update" | "host";
  }) => void;
}

const completeSession = (session?: GuardianSession) =>
  session
    ? session.complete().pipe(
        Effect.mapError(
          (error) =>
            new ReviewFailure({
              code: "Unavailable",
              reviewPhase: "diagnostic_retention",
              failureDetail: retentionDetail(error, "guardian.session.complete"),
            }),
        ),
      )
    : Effect.void;

/** The most follow-up rounds one review gets for a required read it skipped. */
const requiredReadRounds = 2;

/**
 * The most follow-up rounds one review gets: one outcome correction, one decode correction, one
 * settled-ground correction and the required reads.
 */
export const reviewFollowUpRounds = requiredReadRounds + 3;

/** The longest decode error a follow-up quotes. */
const decodeErrorLimit = 2000;

/** The indefinite article before a word in the host's text. */
const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");

/**
 * A refused decision's outcome as the host's text names it: one of the shared format's outcomes,
 * never another string a reviewer sent, which could carry anything into readable records.
 */
const refusedOutcome = (raw: unknown): GuardianOutcome | undefined => {
  const outcome: unknown =
    typeof raw === "object" && raw !== null ? Reflect.get(raw, "outcome") : undefined;
  return guardianOutcomes.find((known) => known === outcome);
};

/**
 * Which of a built-in kind's own outcomes holds what a reviewer that answers with another kind's
 * outcome most often means: that what it reviews should change first. A host-defined kind's
 * policy says that itself.
 */
const refusedOutcomeHint: Record<Exclude<ReviewKind, "host">, string> = {
  execution:
    "A step that should change before it runs, or that needs the caller first, is a deny or an escalate, as its policy says.",
  recovery: "A request for a new browser that should not be granted is a deny.",
  publication: "A tool that should change before it publishes is a deny.",
  question: "A request that should change before its caller sees it is a reword.",
  update:
    "An update that needs the caller's confirmation and lacks it or gives it ambiguously is a clarify, and one that is wrong as written is a reword.",
};

/**
 * The follow-up, once in a review, for a decision whose outcome its kind does not return: the
 * outcome it refused, the outcomes the kind returns, and which of them holds a change first.
 */
const outcomeCorrection = (
  kind: ReviewKind,
  kindName: string,
  outcomes: readonly GuardianOutcome[],
  raw: unknown,
) => {
  const refused = refusedOutcome(raw);
  return [
    `The host did not accept this decision: ${refused === undefined ? "its outcome is not one" : `${refused} is not an outcome`} ${article(kindName)} ${kindName} review returns.`,
    `It returns only ${outcomes.join(", ")}, as trusted_review.outcomes lists.`,
    "Decide this review again under its policy and return one of them.",
    ...(kind === "host" ? [] : [refusedOutcomeHint[kind]]),
  ].join(" ");
};

/**
 * Why a decision fails to decode, when its decode settles at once with `InvalidDecision`.
 * Undefined when it decodes, fails otherwise, or needs asynchronous work, which is stopped.
 */
const decodeError = (decoded: Effect.Effect<unknown, ReviewFailure>): string | undefined => {
  const exit = Effect.runSyncExit(decoded);
  if (Exit.isSuccess(exit)) return undefined;
  const defect = Option.getOrUndefined(Cause.dieOption(exit.cause));
  if (Runtime.isAsyncFiberException(defect)) {
    Effect.runFork(Fiber.interrupt(defect.fiber));
    return undefined;
  }
  const failure = Option.getOrUndefined(Cause.failureOption(exit.cause));
  if (failure?.code !== "InvalidDecision") return undefined;
  return cutToLimit(
    failure.failureDetail?.underlying?.message ?? "It does not match the output format.",
    decodeErrorLimit,
  );
};

const decisionFailure = (
  error: unknown,
  code: "InvalidDecision" | "InvalidOutcome" = "InvalidDecision",
) =>
  new ReviewFailure({
    failureDetail: failureDetail("guardian_dependency_failed", {
      error,
      phase: "decision_validation",
    }),
    code,
  });

const decodeDecision = (raw: unknown) =>
  Schema.decodeUnknown(GuardianDecision)(allowAdvice(boundedRationale(raw))).pipe(
    Effect.mapError(decisionFailure),
  );

/** What the host tells Guardian when it refuses a write label the step has no authority for. */
export const writeOutOfAuthority =
  "Out of authority: this review labelled the execution a write, and this step has no write authority. A read build, and every step outside a write build's write session, may only read. Change the source so it makes no persistent change on the website, or end the build if the task needs one.";

/**
 * An execution decision with its refusal kept only on a deny or escalate, and only when it is one
 * Guardian may return. Any other value, as an older or confused reviewer may send, counts as none:
 * the decision still decodes, and the host reads the refusal as `final`, as before the field.
 */
const knownRefusal = (raw: unknown): unknown => {
  if (typeof raw !== "object" || raw === null || !("refusal" in raw)) return raw;
  const { refusal, ...rest } = raw as Record<string, unknown>;
  return Reflect.get(raw, "outcome") !== "allow" &&
    guardianRefusals.some((known) => known === refusal)
    ? raw
    : rest;
};

/**
 * The ground an execution deny or escalate rests on (`refusalGround`) when the host's own record
 * settles it the other way: retry permission when trusted_execution_context.repeatableRead is
 * true, since the host itself refuses before review any run it does not permit, committing a
 * listed write again for a step the review labels a read, which changes nothing, missing write
 * authority for a step whose own authority grants the write (`writeAuthority`), such as an act step
 * reviewed right after a read-only explore, or missing confirmation for the very step the owner
 * confirmed (`confirmed`). Undefined for any other decision.
 */
const settledGroundOf = (
  pending: PendingExecution,
  raw: unknown,
  confirmed: OwnerConfirmedStep | undefined,
): GuardianRefusalGround | undefined => {
  if (reviewKindOf(pending) !== "execution" || typeof raw !== "object" || raw === null)
    return undefined;
  const outcome: unknown = Reflect.get(raw, "outcome");
  if (outcome !== "deny" && outcome !== "escalate") return undefined;
  const ground: unknown = Reflect.get(raw, "refusalGround");
  if (ground === "retry_permission" && pending.mintContext?.repeatableRead === true) return ground;
  if (ground === "committed_write" && Reflect.get(raw, "action") === "read") return ground;
  if (ground === "write_authority" && pending.writeAuthority === true) return ground;
  if (ground === "owner_confirmation" && confirmed !== undefined) return ground;
  return undefined;
};

/** What the host tells Guardian, once in the same review, about a refusal on a settled ground. */
const settledGroundCorrection: Record<GuardianRefusalGround, string> = {
  retry_permission:
    "The host did not accept this refusal: it rests on retry permission, and trusted_execution_context.repeatableRead is true. Whether a step may run again is the host's to decide: it refuses before review any run it does not permit, and it permits this one, a corrected example included. Judge this step's own source and effects under the policy and decide again, without retry permission as a ground.",
  committed_write:
    "The host did not accept this refusal as given: it rests on committing a listed write again, yet this review labels the step a read. If the submitted code changes the site, label it write and keep the refusal. If it changes nothing, it commits nothing again: reading back a write's result, the record it created or changed included, on any page of the authorized site, and the request's other remaining steps toward the same task stay allowed, so judge the step under the policy's other rules and decide again without the earlier write as a ground.",
  write_authority:
    "The host did not accept this refusal: it rests on this step having no write authority, and the host's record gives this step write authority, as its own trusted_authority.allowedEffects say. An earlier review's allowed effects are not this step's. Judge this step's own source and effects under the policy and decide again, without missing write authority as a ground.",
  owner_confirmation:
    "The host did not accept this refusal: it rests on this step needing the owner's confirmation, and trusted_authority.ownerConfirmedStep shows the owner already confirmed exactly this step, the one an earlier review held for that confirmation, with the same code and input. That answer authorizes this step, and it needs no task update. Decide again without missing confirmation as a ground. Refuse it still, with refusal final, only when the step weakens security or safety in a way no answer authorizes, and say which.",
};

/**
 * The decision a review ends with after the host sent back a refusal on a settled ground. A
 * refusal that still rests on it is correctable, never final, so a misread host fact never ends
 * the build as a policy block. After a committed-write refusal went back, only an allow labelled
 * read stands; any other allow keeps the original refusal, as correctable, so the pushback never
 * lets a second write through.
 */
const afterGroundPushback = (
  pending: PendingExecution,
  pushback: { readonly ground: GuardianRefusalGround; readonly refused: object },
  raw: unknown,
  confirmed: OwnerConfirmedStep | undefined,
): unknown => {
  if (typeof raw !== "object" || raw === null) return raw;
  if (settledGroundOf(pending, raw, confirmed) !== undefined)
    return { ...raw, refusal: "correctable" };
  return pushback.ground === "committed_write" &&
    Reflect.get(raw, "outcome") === "allow" &&
    Reflect.get(raw, "action") !== "read"
    ? { ...pushback.refused, refusal: "correctable" }
    : raw;
};

/**
 * An execution review's decision. An allow without an action label is malformed, so the review
 * runs again under the outage retry; a `write` allow on a step without write authority becomes a
 * denial.
 */
const decodeExecution = (pending: PendingExecution) => (raw: unknown) =>
  decodeDecision(knownRefusal(raw)).pipe(
    Effect.flatMap((decision) =>
      decision.outcome !== "allow"
        ? Effect.succeed(decision)
        : decision.action === undefined
          ? Effect.fail(decisionFailure(new Error("An execution allow has no action label")))
          : decision.action === "write" && pending.writeAuthority !== true
            ? Effect.succeed({
                outcome: "deny" as const,
                rationale: writeOutOfAuthority,
                action: decision.action,
              })
            : Effect.succeed(decision),
    ),
  );

/**
 * A host kind's decision whose label its outcome does not carry (`outcomeLabels`): the outcome
 * and the labels it carries. Undefined for any other decision.
 */
const labelRefusedBy = (
  request: HostReview,
  raw: unknown,
): { readonly outcome: string; readonly labels: readonly string[] } | undefined => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const outcome: unknown = Reflect.get(raw, "outcome");
  const label: unknown = Reflect.get(raw, "label");
  const labels =
    typeof outcome === "string" ? request.outcomeLabels?.[outcome as GuardianOutcome] : undefined;
  return labels !== undefined && !labels.some((carried) => carried === label)
    ? { outcome: outcome as string, labels }
    : undefined;
};

const decodeHost = (request: HostReview) => {
  const shape = Schema.Struct({
    outcome: Schema.Literal(...request.outcomes),
    rationale: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(rationaleLimit)),
    ...(request.labels === undefined ? {} : { label: Schema.Literal(...request.labels) }),
  });
  return (raw: unknown): Effect.Effect<HostReviewDecision, ReviewFailure> =>
    Schema.decodeUnknown(shape)(boundedRationale(raw), { onExcessProperty: "error" }).pipe(
      Effect.mapError((error) =>
        decisionFailure(request.private === true ? privateDecisionError(request, raw) : error),
      ),
      Effect.flatMap(
        (decision: HostReviewDecision): Effect.Effect<HostReviewDecision, ReviewFailure> =>
          labelRefusedBy(request, decision) === undefined
            ? Effect.succeed(decision)
            : decisionFailure(
                new Error(
                  request.private === true
                    ? "The label is not one the decision's outcome carries"
                    : `The label ${String(decision.label)} is not one a ${decision.outcome} carries`,
                ),
              ),
      ),
    );
};

/**
 * A private kind's invalid decision, described by a fixed reason only: the parse error would
 * echo the rejected value and the kind's labels into every readable record of the failure.
 */
const privateDecisionError = (request: HostReview, raw: unknown) => {
  const label = typeof raw === "object" && raw !== null ? Reflect.get(raw, "label") : undefined;
  return new Error(
    label !== undefined && !(request.labels ?? []).some((allowed) => allowed === label)
      ? "The label is not one of the kind's labels"
      : "The decision does not match the kind's format",
  );
};

export const makeGuardian = (
  reviewer: Reviewer,
  diagnostics?: GuardianDiagnostics,
  continuity?: GuardianSessionOptions,
  options: GuardianReviewOptions = {},
) => {
  const bestEffort =
    options.bestEffort ??
    (<A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        // error-reporting-allow: typed-recovery only retry/failure notifications are optional; required source retention and the review failure propagate separately
        Effect.catchAllCause(() => Effect.void),
        Effect.asVoid,
      ));
  const session = continuity === undefined ? undefined : makeGuardianSession(continuity);
  /** The steps this job's reviews held for the owner's confirmation, and the owner's answers. */
  const confirmations = makeOwnerConfirmations();
  /** Decode failures whose review sent the decode follow-up: never reviewed again. */
  const correctedDecodes = new WeakSet<ReviewFailure>();
  /** The latest publication round of a Guardian without a session, which keeps it here instead. */
  let ownPublicationRound: PublicationRound | undefined;
  const priorPublicationRound = () =>
    session === undefined ? ownPublicationRound : session.publicationRound();
  const keepPublicationRound = (round: PublicationRound) =>
    session === undefined
      ? Effect.sync(() => {
          ownPublicationRound = round;
        })
      : session.keepPublicationRound(round);
  /**
   * Every indexed file's screened text as Guardian would read it, through the host's own reader
   * so no read counts as Guardian's. A file the host cannot read, or cannot read whole within
   * 4 MiB, has no text and is not compared: a prefix never stands for the file.
   */
  const publicationFiles = (
    scope: PublicationScope,
    readSource: ReviewTurn["readSource"],
  ): Effect.Effect<readonly PublicationRoundFile[]> =>
    Effect.forEach(
      scope.files,
      (file) =>
        // error-reporting-allow: typed-recovery a file the host cannot read is left for Guardian to read, as in a first round
        Effect.option(completeSource(readSource, file.path)).pipe(
          Effect.map((read): PublicationRoundFile => {
            const text = Option.getOrUndefined(read);
            return {
              path: file.path,
              published: file.published,
              current: file.current,
              owner: file.owner,
              ...(text === undefined ? {} : { text }),
            };
          }),
        ),
      { concurrency: 4 },
    );
  /**
   * Runs one review again after an outage, each time as a fresh review with its own ID, until
   * it completes or the outage outlasts the retry budget.
   */
  const retryReview = <A>(
    kind: ReviewKind,
    attempt: (run: ReviewAttempt) => Effect.Effect<A, ReviewFailure>,
  ): Effect.Effect<A, ReviewFailure> => {
    const retry = reviewer.retry;
    if (retry === undefined) return attempt({ ordinal: 1, started: () => undefined });
    const budgetMs = Duration.toMillis(retry.budget);
    return Effect.gen(function* () {
      // The budget counts the outage, from the first failure on, not the review before it, which
      // has no deadline and may run long.
      let outageStartedMs: number | undefined;
      let decodeRetries = 0;
      for (let retries = 0; ; retries++) {
        // The failed attempt's review, so its retry interval is tied to it.
        let correlation: Parameters<ReviewAttempt["started"]>[0] | undefined;
        const outcome = yield* Effect.either(
          attempt({
            ordinal: retries + 1,
            started: (started) => {
              correlation = started;
            },
          }),
        );
        if (outcome._tag === "Right") return outcome.right;
        const failure = outcome.left;
        const waitMs = Duration.toMillis(
          retry.delays[Math.min(retries, retry.delays.length - 1)] ?? retry.delays[0],
        );
        const failedMs = yield* Clock.currentTimeMillis;
        outageStartedMs ??= failedMs;
        const outageMs = failedMs - outageStartedMs;
        const decodeRetry =
          failure.code === "InvalidDecision" &&
          !correctedDecodes.has(failure) &&
          decodeRetries < uncorrectedDecodeRetries;
        if (!(retriableOutage(failure) || decodeRetry) || outageMs + waitMs > budgetMs)
          return yield* failure;
        if (decodeRetry) decodeRetries++;
        const startOffsetMs = performance.now();
        yield* bestEffort(
          diagnostics?.emit(
            "guardian.review_retried",
            {
              kind,
              retry: retries + 1,
              attempt: retries + 1,
              code: failure.code,
              ...(failure.reviewPhase === undefined ? {} : { reviewPhase: failure.reviewPhase }),
              ...failureDetailMetadata(failure),
              waitMs,
              outageMs,
              startOffsetMs,
              endOffsetMs: startOffsetMs + waitMs,
            },
            correlation,
          ) ?? Effect.void,
          "guardian.review_retried",
        );
        yield* Effect.sleep(Duration.millis(waitMs));
      }
    });
  };
  /**
   * One review attempt holds the session alone. The wait for it is reported as an interval, and
   * the waits between retries run outside it, so another review can use the session meanwhile.
   */
  const exclusive = <A>(
    kind: ReviewKind,
    run: ReviewAttempt,
    work: (run: ReviewAttempt) => Effect.Effect<A, ReviewFailure>,
  ) =>
    session === undefined
      ? work(run)
      : Effect.gen(function* () {
          const requestedMs = yield* Clock.currentTimeMillis;
          const startOffsetMs = performance.now();
          return yield* session.exclusive(
            Effect.gen(function* () {
              const acquiredMs = yield* Clock.currentTimeMillis;
              const endOffsetMs = performance.now();
              yield* bestEffort(
                diagnostics?.emit("guardian.session_wait", {
                  kind,
                  attempt: run.ordinal,
                  startedAtUtc: new Date(requestedMs).toISOString(),
                  endedAtUtc: new Date(acquiredMs).toISOString(),
                  waitMs: acquiredMs - requestedMs,
                }) ?? Effect.void,
                "guardian.session_wait",
              );
              return yield* work({ ...run, permitWait: { startOffsetMs, endOffsetMs } });
            }),
          );
        });
  const withOutageRetry = <A>(
    kind: ReviewKind,
    attempt: (run: ReviewAttempt) => Effect.Effect<A, ReviewFailure>,
  ) => retryReview(kind, (run) => exclusive(kind, run, attempt));
  const review = <Decision extends { readonly outcome: string }>(
    run: ReviewAttempt,
    pending: PendingExecution,
    readSource: ReviewTurn["readSource"],
    decode: (raw: unknown) => Effect.Effect<Decision, ReviewFailure>,
    /** The decode with no source reads, for deciding at once whether an output decodes. */
    probe: (raw: unknown) => Effect.Effect<unknown, ReviewFailure> = decode,
  ): Effect.Effect<{ reviewId: string; decision: Decision }, ReviewFailure> =>
    Effect.gen(function* () {
      const reviewId = randomUUID();
      const kind = reviewKindOf(pending);
      const reviewKind = kind === "recovery" ? "execution" : kind;
      // A private host kind's request is private review context: no readable copy of it, its
      // transcript or its rationale is kept.
      const privateKind = pending.hostReview?.private === true;
      const hostKind =
        pending.hostReview === undefined ? {} : { hostKind: pending.hostReview.kind };
      const retainRuntimeRecord = guardianRuntimeRecords(diagnostics, options);
      const emit = (name: string, details: unknown, timing?: ModelDiagnosticTiming) =>
        (
          diagnostics?.[
            name === "guardian.model" && timing !== undefined && pending.publication === undefined
              ? "retainModelTranscript"
              : "emit"
          ](
            name,
            { reviewId, details },
            {
              reviewId,
              reviewKind,
              ...(timing === undefined ? {} : { modelTiming: timing }),
              // Guardian's readable copies are never dropped for ordinary diagnostics.
              required: true,
            },
          ) ?? Effect.void
        ).pipe(
          Effect.mapError(
            (error) =>
              options.diagnosticFailure?.(error, "diagnostics.emit") ??
              new ReviewFailure({
                code: "Unavailable",
                reviewPhase: "diagnostic_retention",
                failureDetail: retentionDetail(error, "diagnostics.emit"),
              }),
          ),
        );
      run.started({ reviewId, reviewKind });
      // A publication round reads its files to keep them for the next round, and a later round
      // is reviewed against the prior one.
      const roundFiles =
        pending.publication === undefined
          ? undefined
          : yield* publicationFiles(pending.publication, readSource);
      const roundContext = roundFiles === undefined ? {} : publicationContext(pending);
      const priorRound = roundFiles === undefined ? undefined : priorPublicationRound();
      const delta =
        roundFiles === undefined || priorRound === undefined
          ? undefined
          : publicationDelta(priorRound, roundFiles, roundContext);
      /** The chunks Guardian's own reads served in this review, by path and offset. */
      const served = new Map<string, Map<number, { nextOffset: number; hasMore: boolean }>>();
      /** The paths Guardian read whole in this review: every chunk from offset 0 to the end. */
      const readWhole = () =>
        new Set(
          [...served].flatMap(([path, chunks]) => {
            let offset = 0;
            for (let index = 0; index <= chunks.size; index++) {
              const chunk = chunks.get(offset);
              if (chunk === undefined) return [];
              if (!chunk.hasMore) return [path];
              if (chunk.nextOffset <= offset) return [];
              offset = chunk.nextOffset;
            }
            return [];
          }),
        );
      const observeModelTrace = diagnostics?.observeModelTrace;
      // Follow-up rounds for a refused outcome or label or a skipped entrypoint read, within this
      // attempt.
      let followUpRounds = 0;
      const startOffsetMs = performance.now();
      const timing = {
        attempt: run.ordinal,
        startOffsetMs,
        ...(run.permitWait === undefined
          ? {}
          : {
              permitWaitStartOffsetMs: run.permitWait.startOffsetMs,
              permitWaitEndOffsetMs: run.permitWait.endOffsetMs,
            }),
      };
      const endTiming = () => {
        const endOffsetMs = performance.now();
        return {
          attempt: run.ordinal,
          startOffsetMs,
          endOffsetMs,
          elapsedMs: endOffsetMs - startOffsetMs,
          ...(followUpRounds === 0 ? {} : { followUpRounds }),
        };
      };
      yield* emit(
        "guardian.started",
        privateKind
          ? {
              mode: "private",
              ...hostKind,
              invocationId: pending.invocationId,
              attemptId: pending.attemptId,
              timing,
            }
          : pending.publication === undefined
            ? { ...pending, timing }
            : {
                mode: "publication",
                ...pending,
                manifestFiles: pending.publication.files.length,
                manifestBytes: pending.publication.files.reduce(
                  (total, file) => total + file.byteLength,
                  0,
                ),
                ...(delta === undefined ? {} : { delta: publicationDeltaCounts(delta) }),
                timing,
              },
      );
      return yield* Effect.gen(function* () {
        // Only an execution runs the agent's code, so only its allow needs the entrypoint read.
        const requireEntrypoint = kind === "execution";
        const entrypoint = sourcePath(pending.entrypoint);
        // A compaction replaces what Guardian sees, so a read counts only until the next one.
        const epoch = () => session?.compactions() ?? 0;
        let entrypointReadAt: number | undefined;
        const publication = pending.publication;
        const unavailableSources = new Map<string, ReviewFailure>();
        // A publication review's reads are its source_read diagnostics below instead.
        const retain = (observation: string) =>
          publication !== undefined
            ? Effect.void
            : (diagnostics?.retainScreenedSource({ reviewId, observation }) ?? Effect.void).pipe(
                Effect.mapError(
                  (error) =>
                    options.diagnosticFailure?.(error, "diagnostics.retainScreenedSource") ??
                    new ReviewFailure({
                      code: "Unavailable",
                      reviewPhase: "diagnostic_retention",
                      failureDetail: retentionDetail(error, "diagnostics.retainScreenedSource"),
                    }),
                ),
              );
        /**
         * One read of the host's reader, with its interval as `performance.now()` offsets for the
         * read's failure record. A retention failure after the read carries the read's interval.
         */
        const timedRead = (path: string, offset: number) => {
          let startOffsetMs = 0;
          let endOffsetMs = 0;
          return {
            effect: Effect.suspend(() => {
              startOffsetMs = performance.now();
              return readSource(path, offset);
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  endOffsetMs = performance.now();
                }),
              ),
            ),
            interval: () => ({
              elapsedMs: endOffsetMs - startOffsetMs,
              startOffsetMs,
              endOffsetMs,
            }),
          };
        };
        const sourceFailed = (path: string, offset: number, error: ReviewFailure) => ({
          ...(publication === undefined
            ? { path, offset }
            : {
                path,
                manifestIndex: publication.files.findIndex((file) => file.path === path),
                offset,
              }),
          code: error.code,
          ...(error.publicationBlock === undefined
            ? {}
            : { publicationBlock: error.publicationBlock }),
          ...(error.diagnosticRetentionReason === undefined
            ? {}
            : { diagnosticRetentionReason: error.diagnosticRetentionReason }),
          ...(error.diagnosticScreeningReason === undefined
            ? {}
            : { diagnosticScreeningReason: error.diagnosticScreeningReason }),
          // Why the read failed, with its whole detail.
          ...failureDetailOf(error),
        });
        /**
         * Searches in progress. A search reads the whole file through `read` too, but shows Guardian
         * only slices around each match, so what it reads never counts as reading a file whole for a
         * later publication round. A plain read that runs alongside a search goes uncounted too,
         * which only leaves that file to be judged again.
         */
        let searching = 0;
        /** Guardian's own reads, through its tool: tracked for required evidence. */
        const read: ReviewTurn["readSource"] = (requested, offset) => {
          const path = sourcePath(requested);
          const timed = timedRead(path, offset);
          return timed.effect.pipe(
            Effect.tap(retain),
            Effect.tapError((error) =>
              emit("guardian.source_failed", {
                ...sourceFailed(path, offset, error),
                ...timed.interval(),
              }),
            ),
            Effect.tap((observation) =>
              publication === undefined
                ? Effect.void
                : emit("guardian.source_read", {
                    path,
                    manifestIndex: publication.files.findIndex((file) => file.path === path),
                    offset,
                    observation,
                  }),
            ),
            Effect.tapError((error) =>
              Effect.sync(() => {
                // Tool adapters can return source failures as model-visible text.
                // Preserve required evidence failures even if the model then denies.
                if (
                  (requireEntrypoint && path === entrypoint && offset === 0) ||
                  error.diagnosticRetentionReason !== undefined
                )
                  unavailableSources.set(JSON.stringify([path, offset]), error);
              }),
            ),
            Effect.tap((observation) =>
              Effect.sync(() => {
                const chunk =
                  roundFiles === undefined || searching > 0 ? undefined : sourceChunkOf(observation);
                if (chunk !== undefined) {
                  const chunks = served.get(chunk.path) ?? new Map();
                  chunks.set(chunk.byteOffset, {
                    nextOffset: chunk.nextOffset,
                    hasMore: chunk.hasMore,
                  });
                  served.set(chunk.path, chunks);
                }
                unavailableSources.delete(JSON.stringify([path, offset]));
                if (path === entrypoint && offset === 0) entrypointReadAt = epoch();
              }),
            ),
          );
        };
        let sources: ReviewSources | undefined;
        if (requireEntrypoint) {
          // The entrypoint goes into the request itself, so a typical review needs one call. This
          // is the host's read, kept apart from Guardian's: when it fails the source is left out
          // and Guardian reads it itself, and when only retaining the screened copy fails, the
          // source stays in view and the gap is recorded.
          const hostRead = timedRead(entrypoint, 0);
          const included = yield* Effect.either(hostRead.effect);
          const gap = (error: ReviewFailure) =>
            bestEffort(
              emit("guardian.source_failed", {
                ...sourceFailed(entrypoint, 0, error),
                ...hostRead.interval(),
                automatic: true,
              }),
              "guardian.source_failed",
            );
          if (included._tag === "Left") yield* gap(included.left);
          else {
            entrypointReadAt = epoch();
            const retained = yield* Effect.either(retain(included.right));
            if (retained._tag === "Left") yield* gap(retained.left);
          }
          const unchanged =
            session === undefined
              ? []
              : yield* unchangedSources(
                  sourceLedger(session.history()),
                  (pending.mintContext?.executedSources ?? []).filter(
                    (path) => sourcePath(path) !== entrypoint,
                  ),
                  (path, offset) => readSource(sourcePath(path), offset),
                );
          sources = {
            ...(included._tag === "Right"
              ? {
                  entrypoint: sourceChunkOf(included.right)?.value ?? included.right,
                }
              : {}),
            ...(unchanged.length === 0 ? {} : { unchangedSources: unchanged }),
          };
        }
        if (delta !== undefined) sources = { ...sources, publicationDelta: delta };
        // The owner's yes to a confirm question binds only to the step its review held, and only
        // when this step is that step: the same code and input.
        const confirmedStep =
          kind === "execution" && confirmations.pending(pending)
            ? yield* stepIdentity(pending, readSource).pipe(
                Effect.map((step) =>
                  step === undefined ? undefined : confirmations.confirmedFor(pending, step),
                ),
              )
            : undefined;
        if (confirmedStep !== undefined)
          sources = { ...sources, ownerConfirmedStep: confirmedStep };
        const heldQuestions =
          kind === "question" && pending.questionCandidate !== undefined
            ? confirmations.heldStepQuestions(pending.questionCandidate)
            : [];
        if (heldQuestions.length > 0) sources = { ...sources, heldStepQuestions: heldQuestions };
        const kindName = pending.hostReview?.kind ?? kind;
        const outcomes = reviewOutcomesOf(pending);
        /** A decision whose outcome this review's kind does not return. */
        const outcomeRefused = (raw: unknown) =>
          typeof raw === "object" &&
          raw !== null &&
          !Array.isArray(raw) &&
          typeof Reflect.get(raw, "outcome") === "string" &&
          !outcomeAccepted(pending, raw);
        let outcomeCorrected = false;
        let decodeCorrected = false;
        /** The refusal on a settled ground the host sent back in this review, if any. */
        let groundPushback:
          | { readonly ground: GuardianRefusalGround; readonly refused: object }
          | undefined;
        let readRounds = 0;
        // A publication finding names one of these paths exactly.
        const indexedPaths =
          publication?.files.filter((file) => file.byteLength > 0).map((file) => file.path) ?? [];
        const unread = (raw: unknown) =>
          requireEntrypoint &&
          typeof raw === "object" &&
          raw !== null &&
          Reflect.get(raw, "outcome") === "allow" &&
          entrypointReadAt !== epoch();
        const output = yield* reviewer.run({
          reviewId,
          ...(session ? { session } : {}),
          pending,
          ...(sources === undefined ? {} : { sources }),
          ...(retainRuntimeRecord === undefined ? {} : { retainRuntimeRecord }),
          // A private kind's transcript is never kept, so only its finite timing is reported.
          ...(privateKind
            ? observeModelTrace === undefined
              ? {}
              : {
                  observeTiming: (modelTiming: ModelDiagnosticTiming) =>
                    observeModelTrace("guardian.model", modelTiming, { reviewId, reviewKind }),
                }
            : {
                reportDiagnostic: (value: unknown, modelTiming?: ModelDiagnosticTiming) =>
                  emit("guardian.model", value, modelTiming),
              }),
          reportUsage: (usage) =>
            bestEffort(
              diagnostics?.emit(
                "guardian.usage",
                { reviewId, details: usage },
                { reviewId, reviewKind },
              ) ?? Effect.void,
              "guardian.usage",
            ),
          observeModelCallRetry: (retry) =>
            bestEffort(
              diagnostics?.emit(
                "guardian.model_call_retried",
                { reviewId, details: retry },
                { reviewId, reviewKind },
              ) ?? Effect.void,
              "guardian.model_call_retried",
            ),
          followUp: (output) => {
            // A private kind's exchange ends only at the next review request, so a correction
            // would carry its later output into readable records; it fails at once instead.
            if (!outcomeCorrected && !privateKind && outcomeRefused(output)) {
              outcomeCorrected = true;
              followUpRounds++;
              return outcomeCorrection(kind, kindName, outcomes, output);
            }
            // A label its outcome does not carry fails to decode; this names the labels it carries.
            const carried =
              pending.hostReview === undefined || privateKind || decodeCorrected
                ? undefined
                : labelRefusedBy(pending.hostReview, output);
            if (carried !== undefined) {
              decodeCorrected = true;
              followUpRounds++;
              return `The host did not accept this decision: a ${kindName} review's ${carried.outcome} carries only the label ${carried.labels.join(", ")}, as its policy says. Decide this review again under its policy and return a label its outcome carries.`;
            }
            const invalid =
              decodeCorrected || privateKind || outcomeRefused(output)
                ? undefined
                : decodeError(probe(decisionForKind(pending, output)));
            if (invalid !== undefined) {
              decodeCorrected = true;
              followUpRounds++;
              const paths =
                indexedPaths.length === 0
                  ? ""
                  : ` Each finding's path is one of these indexed paths exactly, with nothing added: ${indexedPaths.join(", ")}.`;
              return `The host could not decode this decision: ${invalid} Return this review's decision again in the output format, corrected.${paths}`;
            }
            // A refusal on a ground the host's own record settles goes back once, naming it.
            const settled =
              groundPushback === undefined
                ? settledGroundOf(pending, output, confirmedStep)
                : undefined;
            if (settled !== undefined) {
              groundPushback = { ground: settled, refused: output as object };
              followUpRounds++;
              return settledGroundCorrection[settled];
            }
            if (!unread(output) || readRounds >= requiredReadRounds) return undefined;
            readRounds++;
            followUpRounds++;
            return `The host did not accept this allow: an allow needs the submitted entrypoint ${entrypoint} in view in this review, and it is not, because the host could not include it or the conversation was compacted since. Read ${entrypoint} from offset 0 with read_source, then decide again.`;
          },
          readSource: read,
          uncountedReads: (effect) =>
            Effect.acquireUseRelease(
              Effect.sync(() => searching++),
              () => effect,
              () => Effect.sync(() => searching--),
            ),
        });
        const unavailableSource = unavailableSources.values().next().value;
        if (unavailableSource !== undefined) return yield* unavailableSource;
        // The closure above may have set it; the cast keeps the compiler from narrowing it away.
        const pushback = groundPushback as
          | { readonly ground: GuardianRefusalGround; readonly refused: object }
          | undefined;
        const raw =
          pushback === undefined
            ? output
            : afterGroundPushback(pending, pushback, output, confirmedStep);
        if (outcomeRefused(raw)) {
          // A private kind's failure names no outcome, as its decode failures name no value.
          const refused = privateKind ? undefined : refusedOutcome(raw);
          return yield* decisionFailure(
            new Error(
              `The outcome${refused === undefined ? "" : ` ${refused}`} is not one ${article(kind)} ${kind} review returns`,
            ),
            "InvalidOutcome",
          );
        }
        // Output that is not a decision at all fails to decode as InvalidDecision.
        const decision = yield* decode(decisionForKind(pending, raw)).pipe(
          Effect.tapError((failure) =>
            Effect.sync(() => {
              if (decodeCorrected) correctedDecodes.add(failure);
            }),
          ),
        );
        if (requireEntrypoint && decision.outcome === "allow" && entrypointReadAt !== epoch())
          return yield* new ReviewFailure({ code: "EntrypointNotRead" });
        // A correctable refusal that asks for the owner's confirmation holds this step for it,
        // unless the owner already confirmed it; an allowed confirm question that names it records
        // the ask. A final refusal holds nothing: no answer gets past it.
        const rationale: unknown = Reflect.get(decision, "rationale");
        if (
          kind === "execution" &&
          confirmedStep === undefined &&
          (decision.outcome === "deny" || decision.outcome === "escalate") &&
          Reflect.get(decision, "refusal") === "correctable" &&
          typeof raw === "object" &&
          raw !== null &&
          Reflect.get(raw, "refusalGround") === "owner_confirmation" &&
          typeof rationale === "string"
        ) {
          const step = yield* stepIdentity(pending, readSource);
          if (step !== undefined) confirmations.hold(reviewId, step, rationale);
        }
        if (
          decision.outcome === "allow_business" &&
          pending.questionCandidate !== undefined &&
          heldQuestions.length > 0
        )
          confirmations.asked(pending.questionCandidate, heldQuestions, pending.answeredQuestions);
        yield* emit(
          "guardian.completed",
          privateKind
            ? { mode: "private", ...hostKind, outcome: decision.outcome, timing: endTiming() }
            : publication === undefined
              ? { ...decision, timing: endTiming() }
              : { mode: "publication", ...decision, timing: endTiming() },
        );
        yield* completeSession(session);
        // Only a completed round is what the next one is reviewed against. Saving it is best
        // effort: an unsaved round leaves a takeover to review the next round as a first one.
        const round =
          roundFiles === undefined
            ? undefined
            : publicationRound(roundFiles, roundContext, decision, readWhole(), priorRound);
        if (round !== undefined)
          yield* bestEffort(keepPublicationRound(round), "guardian.publication_round");
        return { reviewId, decision };
      }).pipe(
        Effect.onExit((exit) =>
          exit._tag === "Failure"
            ? emit("guardian.failed", {
                state: "failed",
                ...(pending.publication === undefined ? {} : { mode: "publication" }),
                ...(privateKind ? { mode: "private", ...hostKind } : {}),
                cause: Cause.map(exit.cause, withoutDetail),
                ...failureDetailMetadata(Option.getOrUndefined(Cause.failureOption(exit.cause))),
                timing: endTiming(),
              }).pipe((emitted) => bestEffort(emitted, "guardian.review_diagnostic"))
            : Effect.void,
        ),
      );
    });
  return {
    session,
    review: (pending: PendingExecution, readSource: ReviewTurn["readSource"]) =>
      Effect.suspend(() => {
        if (
          pending.questionCandidate !== undefined ||
          pending.recoveryCandidate !== undefined ||
          pending.hostReview !== undefined
        )
          return Effect.fail(new ReviewFailure({ code: "InvalidDecision" }));
        const scope = pending.publication;
        if (scope === undefined)
          return withOutageRetry("execution", (run) =>
            review(run, pending, readSource, decodeExecution(pending)),
          );
        const publicationDecoder =
          (text: (path: string) => Effect.Effect<string, ReviewFailure>) => (raw: unknown) =>
            anchorQuotedFindings(scope, raw, text).pipe(
              Effect.flatMap((anchored) =>
                (options.decodePublication ?? decodePublicationDecision)(
                  scope,
                  boundedRationale(anchored),
                ),
              ),
            );
        // Where a quote sits never decides whether a decision decodes, so the probe reads no file
        // and puts each quoted finding on its whole file.
        return withOutageRetry("publication", (run) =>
          review(
            run,
            pending,
            readSource,
            publicationDecoder((path) => wholeSource(readSource, path)),
            publicationDecoder(() => Effect.fail(new ReviewFailure({ code: "SourceUnavailable" }))),
          ),
        );
      }),
    /**
     * Reviews the minting agent's request for a new browser as an ordinary execution review of
     * its reason, with the same context and evidence tool. It runs no code, so no
     * entrypoint read is required.
     */
    reviewRecovery: (
      pending: PendingExecution,
      rationale: string,
      readSource: ReviewTurn["readSource"],
    ): Effect.Effect<{ reviewId: string; decision: GuardianDecision }, ReviewFailure> =>
      Effect.suspend(() => {
        if (
          pending.publication !== undefined ||
          pending.questionCandidate !== undefined ||
          pending.recoveryCandidate !== undefined ||
          pending.hostReview !== undefined
        )
          return Effect.fail(new ReviewFailure({ code: "InvalidDecision" }));
        return withOutageRetry("recovery", (run) =>
          review(run, { ...pending, recoveryCandidate: { rationale } }, readSource, decodeDecision),
        );
      }),
    /**
     * Reviews one proposed input request through the same path, context and evidence tool as an
     * execution. A reword is never capped: each one is the agent's to act on.
     */
    reviewQuestion: (
      pending: PendingExecution,
      question: PendingQuestion,
      readSource: ReviewTurn["readSource"],
    ): Effect.Effect<{ reviewId: string; decision: QuestionDecision }, ReviewFailure> =>
      Effect.suspend(() => {
        if (
          pending.publication !== undefined ||
          pending.questionCandidate !== undefined ||
          pending.hostReview !== undefined
        )
          return Effect.fail(new ReviewFailure({ code: "InvalidDecision" }));
        return withOutageRetry("question", (run) =>
          review(run, { ...pending, questionCandidate: question }, readSource, (raw) =>
            Schema.decodeUnknown(QuestionDecision)(raw, {
              onExcessProperty: "error",
            }).pipe(Effect.mapError(decisionFailure)),
          ),
        );
      }),
    /**
     * Reviews the minting agent's proposed task update (`mint_update`) against the effective task
     * the pending review carries, through the same path, context and evidence tool as a question.
     * It runs no code, so no entrypoint read is required.
     */
    reviewTaskUpdate: (
      pending: PendingExecution,
      update: PendingTaskUpdate,
      readSource: ReviewTurn["readSource"],
    ): Effect.Effect<{ reviewId: string; decision: TaskUpdateDecision }, ReviewFailure> =>
      Effect.suspend(() => {
        if (
          pending.publication !== undefined ||
          pending.questionCandidate !== undefined ||
          pending.recoveryCandidate !== undefined ||
          pending.updateCandidate !== undefined ||
          pending.hostReview !== undefined
        )
          return Effect.fail(new ReviewFailure({ code: "InvalidDecision" }));
        return withOutageRetry("update", (run) =>
          review(run, { ...pending, updateCandidate: update }, readSource, (raw) =>
            Schema.decodeUnknown(TaskUpdateDecision)(raw, {
              onExcessProperty: "error",
            }).pipe(Effect.mapError(decisionFailure)),
          ),
        );
      }),
    /**
     * Runs one review of a host-defined kind as one more turn of the same conversation, under
     * the host's policy for it, and returns one of its outcomes. Without a reader, a source read
     * fails and Guardian judges the evidence it was given.
     */
    reviewHostKind: (
      pending: PendingExecution,
      request: HostReview,
      readSource: ReviewTurn["readSource"] = () =>
        Effect.fail(new ReviewFailure({ code: "SourceUnavailable" })),
    ): Effect.Effect<{ reviewId: string; decision: HostReviewDecision }, ReviewFailure> =>
      Effect.suspend(() => {
        if (
          pending.publication !== undefined ||
          pending.questionCandidate !== undefined ||
          pending.recoveryCandidate !== undefined ||
          pending.hostReview !== undefined
        )
          return Effect.fail(new ReviewFailure({ code: "InvalidDecision" }));
        return withOutageRetry("host", (run) =>
          review(run, { ...pending, hostReview: request }, readSource, decodeHost(request)),
        );
      }),
  };
};
