import { randomUUID } from "node:crypto";
import { Cause, Clock, Data, Deferred, Effect, Either, Fiber, type Scope } from "effect";
import { MintFailure } from "../mint/contracts.js";
import { ReviewFailure } from "../guardian/review.js";
import { modelFailureMetadata } from "../models/model-failure.js";
import { LocalOperationFailure } from "../execution/local-operation.js";
import { makeInputAsker } from "../inputs/callback.js";
import { SignInRunFailed } from "../runtime/sign-in-replay.js";
import type {
  RunOutcome,
  RunOutcomeCode,
  RunRetryClass,
  WriteStatus,
} from "../runtime/run-outcome.js";
import { RunOutcomeFailure } from "./run-report.js";
import { submitJob, type JobStore, type RetrySubmission } from "../runtime/job-store.js";
import {
  makeMemoryJobStore,
  type LocalJobRecord,
  type LocalJobStore,
} from "../runtime/local-job-store.js";
import {
  InputRequestFailure,
  maximumInputWaitMs,
  validateAnswer,
  type InputAnswers,
  type InputAsker,
  type InputRequest,
} from "../runtime/input-request.js";

interface PendingInput {
  readonly request: InputRequest;
  readonly expiresAt: number;
  readonly answer: Deferred.Deferred<InputAnswers, InputRequestFailure>;
}
interface Job {
  readonly id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  changed: Deferred.Deferred<void>;
  readonly inputPermit: Effect.Semaphore;
  pending?: PendingInput;
  output?: unknown;
  finishedAt?: number;
  error?: string;
  /** The job failed signing in, before the operation it runs could act on the website. */
  beforeOperation?: true;
  /** A run that did not end in a confirmed result: what it did to the website and how to retry. */
  outcome?: RunOutcomeFailure;
  /** A retry key started the job, so the job store keeps its record. */
  readonly recorded?: true;
  fiber?: Fiber.RuntimeFiber<void>;
}
export interface McpJobView {
  readonly job_id: string;
  readonly status: "running" | "input_required" | "completed" | "failed" | "cancelled";
  readonly output?: unknown;
  readonly pending_input?: InputRequest & { readonly expires_at: string };
  readonly next?: { readonly tool: string; readonly arguments: Record<string, unknown> };
  readonly error?: string;
  /** A failed run's finite code. */
  readonly code?: RunOutcomeCode;
  /** What a failed write did to the website; null for a read or a tool of unknown effect. */
  readonly write_status?: WriteStatus | null;
  /** True: a step may already have changed the website, so read it back before any retry. */
  readonly possible_commit?: boolean;
  readonly retry?: RunRetryClass;
  /** The call's retry key named this job, so the call started nothing new. */
  readonly rejoined?: true;
}
/** A failed run's outcome fields in its job view. */
const outcomeView = (
  outcome: Pick<RunOutcome, "code" | "writeStatus" | "possibleCommit" | "retry">,
) => ({
  code: outcome.code,
  write_status: outcome.writeStatus,
  possible_commit: outcome.possibleCommit,
  retry: outcome.retry,
});
const terminalRetentionMs = 15 * 60_000;
class McpJobFailure extends Data.TaggedError("McpJobFailure")<{
  readonly code: "busy" | "unknown_job" | "stale_input" | "invalid_answers" | "retry_conflict";
}> {}
const requestErrors = {
  busy: "The server is busy. Wait for or cancel its active job.",
  unknown_job: "Unknown or expired job.",
  stale_input: "This input request is no longer pending.",
  invalid_answers: "Answers do not match the pending questions.",
  retry_conflict:
    "This idempotency key was already used for a different request. Repeat the original request with that key, or use a new key for a new request.",
};
/** What a server's jobs do. A run makes no model request, so its messages never mention one. */
export type McpJobKind = "mint" | "run";
export const mcpFailureMessage = (
  cause: Cause.Cause<unknown>,
  kind: McpJobKind = "mint",
): string => {
  const error = Cause.squash(cause);
  if (error instanceof McpJobFailure) return requestErrors[error.code];
  if (error instanceof RunOutcomeFailure) return error.message;
  if (error instanceof ReviewFailure) return `Guardian review failed (${error.code}).`;
  if (error instanceof MintFailure) return `Mint failed (${error.code}).`;
  if (error instanceof InputRequestFailure) return `Input could not be completed (${error.code}).`;
  // A run's sign-in failure names only the field or step, never a value, and what to do next.
  if (error instanceof SignInRunFailed) return `Sign-in failed (${error.code}): ${error.message}`;
  // The tool's own InvalidInput says which value the task or site refuses, for the caller to fix.
  // A schema decode failure carries only its name, which the generic message below covers.
  if (
    error instanceof LocalOperationFailure &&
    error.code === "InvalidInput" &&
    error.message !== "InvalidInput"
  )
    return `Operation failed (InvalidInput): ${error.message}`;
  if (
    error instanceof LocalOperationFailure &&
    ["InvalidInput", "InvalidOutput", "NoResponse"].includes(error.code ?? "")
  )
    return `Operation failed (${error.code}).`;
  const metadata = modelFailureMetadata(error);
  if (metadata.httpStatus === 401 || metadata.code === "invalid_api_key")
    return "Model provider authentication failed. Check the server's model configuration.";
  if (metadata.httpStatus === 429) return "Model provider quota or rate limit was reached.";
  return kind === "run"
    ? "Operation failed. Check the local browser and integration configuration."
    : "Operation failed. Check the local model, browser and integration configuration.";
};
const signalChange = (job: Job) =>
  Effect.gen(function* () {
    const previous = job.changed;
    job.changed = yield* Deferred.make<void>();
    yield* Deferred.succeed(previous, undefined);
  });
const snapshot = (
  job: Pick<Job, "id" | "status" | "pending" | "output" | "error" | "beforeOperation" | "outcome">,
): McpJobView => {
  if (job.pending !== undefined)
    return {
      job_id: job.id,
      status: "input_required",
      pending_input: {
        ...job.pending.request,
        expires_at: new Date(job.pending.expiresAt).toISOString(),
      },
      next: {
        tool: "provide_input",
        arguments: { job_id: job.id, request_id: job.pending.request.id },
      },
    };
  return {
    job_id: job.id,
    status: job.status,
    ...(job.status === "completed" ? { output: job.output } : {}),
    // A write that may have applied keeps the output its script returned, unconfirmed.
    ...(job.status === "failed" && job.outcome?.unconfirmed !== undefined
      ? { output: job.outcome.unconfirmed.output }
      : {}),
    ...(job.status === "running"
      ? { next: { tool: "get_job", arguments: { job_id: job.id } } }
      : {}),
    ...(job.status === "failed" && job.outcome !== undefined
      ? { error: job.outcome.message, ...outcomeView(job.outcome.outcome) }
      : {}),
    ...(job.status === "failed" && job.outcome === undefined
      ? {
          error:
            job.beforeOperation === true
              ? (job.error ?? "Operation failed.")
              : `${job.error ?? "Operation failed."} A dispatched website action may have taken effect; this job will not be replayed.`,
        }
      : {}),
  };
};
const pendingAnswer = (job: Job, request: InputRequest, expiresAt: number) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const pending = {
        request,
        expiresAt,
        answer: yield* Deferred.make<InputAnswers, InputRequestFailure>(),
      };
      job.pending = pending;
      yield* signalChange(job);
      return pending;
    }),
    (pending) => Deferred.await(pending.answer),
    (pending) =>
      Effect.gen(function* () {
        if (job.pending === pending) delete job.pending;
        yield* signalChange(job);
      }),
  );
const jobAsker =
  (job: Job): InputAsker =>
  (request, bounds) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const expiresAt = Math.min(
        bounds?.sourceEndsAt ?? Number.POSITIVE_INFINITY,
        now + maximumInputWaitMs,
      );
      return yield* makeInputAsker((checked) =>
        job.inputPermit.withPermits(1)(pendingAnswer(job, checked, expiresAt)),
      )(request, {
        ...bounds,
        sourceEndsAt: expiresAt,
      });
    });
/**
 * A job's view from its kept record, when this server holds no live job for it. A record keeps no
 * output, so a finished job answers its status alone.
 */
const storedView = (record: LocalJobRecord): McpJobView => {
  // A run's outcome text already says what it did to the website, so no warning is added to it.
  if (record.status === "failed" && record.outcome !== undefined)
    return {
      job_id: record.id,
      status: "failed",
      ...(record.error === undefined ? {} : { error: record.error }),
      ...outcomeView(record.outcome),
    };
  const { output: _output, ...view } = snapshot({
    id: record.id,
    status: record.status,
    ...(record.lost === true
      ? { error: "The server stopped before this job finished." }
      : record.error === undefined
        ? {}
        : { error: record.error }),
    ...(record.beforeOperation === undefined ? {} : { beforeOperation: record.beforeOperation }),
  });
  return view;
};
const settle = (
  job: Job,
  kind: McpJobKind,
  work: Effect.Effect<unknown, Error, Scope.Scope>,
  recordOutcome: (job: Job, cause?: Cause.Cause<unknown>) => Effect.Effect<void>,
) =>
  Effect.scoped(work).pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        Effect.gen(function* () {
          job.status = Cause.isInterruptedOnly(cause) ? "cancelled" : "failed";
          job.error = mcpFailureMessage(cause, kind);
          const failure = Cause.squash(cause);
          if (failure instanceof SignInRunFailed) job.beforeOperation = true;
          if (failure instanceof RunOutcomeFailure) job.outcome = failure;
          job.finishedAt = yield* Clock.currentTimeMillis;
          yield* recordOutcome(job, cause);
          yield* signalChange(job);
        }),
      onSuccess: (output) =>
        Effect.gen(function* () {
          job.output = output;
          job.status = "completed";
          job.finishedAt = yield* Clock.currentTimeMillis;
          yield* recordOutcome(job);
          yield* signalChange(job);
        }),
    }),
  );
/**
 * Jobs survive individual tool calls, but never their owning stdio server scope. A job started with
 * a retry key also keeps a record in `store`, so the key rejoins it instead of acting again, and a
 * persistent store keeps that record across a restart.
 */
export const makeMcpJobs = (maxJobs = 1, kind: McpJobKind = "mint", store?: LocalJobStore) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const records = store ?? (yield* makeMemoryJobStore());
    const submitPermit = yield* Effect.makeSemaphore(1);
    const jobs = new Map<string, Job>();
    const prune = (now: number) => {
      for (const [id, job] of jobs)
        if (job.finishedAt !== undefined && now - job.finishedAt >= terminalRetentionMs)
          jobs.delete(id);
      const completed = [...jobs.values()].filter((job) => job.finishedAt !== undefined);
      for (const job of completed.slice(0, Math.max(0, jobs.size - 31))) jobs.delete(job.id);
    };
    const find = (id: string) =>
      Effect.gen(function* () {
        prune(yield* Clock.currentTimeMillis);
        const job = jobs.get(id);
        return job === undefined
          ? yield* Effect.fail(new McpJobFailure({ code: "unknown_job" }))
          : job;
      });
    const busy = () =>
      [...jobs.values()].filter((job) => job.finishedAt === undefined).length >= maxJobs;
    /** Writes a recorded job's outcome, and a failed run's journal, to its record. */
    const recordOutcome = (job: Job, cause?: Cause.Cause<unknown>) => {
      if (job.recorded !== true) return Effect.void;
      const failure = cause === undefined ? undefined : Cause.squash(cause);
      const journal =
        failure instanceof RunOutcomeFailure || failure instanceof LocalOperationFailure
          ? failure.journal
          : undefined;
      const outcome = job.outcome?.outcome;
      // A record that can't be written stays running, and reads as lost after a restart.
      return records
        .update(job.id, {
          status: job.status,
          ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
          ...(job.error === undefined ? {} : { error: job.error }),
          ...(job.beforeOperation === undefined ? {} : { beforeOperation: job.beforeOperation }),
          ...(outcome === undefined
            ? {}
            : {
                outcome: {
                  code: outcome.code,
                  writeStatus: outcome.writeStatus,
                  possibleCommit: outcome.possibleCommit,
                  retry: outcome.retry,
                },
              }),
          ...(journal === undefined
            ? {}
            : {
                effect: journal.effect,
                commits: journal.commits,
                ...(journal.confirmation === undefined
                  ? {}
                  : { confirmation: journal.confirmation }),
              }),
        })
        .pipe(Effect.ignore);
    };
    const launch = (
      id: string,
      work: (ask: InputAsker) => Effect.Effect<unknown, Error, Scope.Scope>,
      recorded: boolean,
    ) =>
      Effect.gen(function* () {
        const job: Job = {
          id,
          status: "running",
          changed: yield* Deferred.make<void>(),
          inputPermit: yield* Effect.makeSemaphore(1),
          ...(recorded ? { recorded: true as const } : {}),
        };
        jobs.set(job.id, job);
        job.fiber = yield* Effect.forkIn(
          settle(
            job,
            kind,
            Effect.suspend(() => work(jobAsker(job))),
            recordOutcome,
          ).pipe(Effect.interruptible),
          scope,
        );
        return snapshot(job);
      });
    /**
     * The shared retry-key rule over the job store. A key that names no job is refused while the
     * server is busy, but a key that names one rejoins it even then, so a retry finds its job.
     */
    const keyedStore: JobStore<RetrySubmission, LocalJobRecord, Error | McpJobFailure> = {
      insert: (submission) =>
        Effect.gen(function* () {
          if ((yield* records.lookup(submission)) !== undefined) return undefined;
          if (busy()) return yield* new McpJobFailure({ code: "busy" });
          return yield* records.insert(submission);
        }),
      findByRetryKey: records.findByRetryKey,
    };
    /**
     * Starts a job. A call with a retry key that names an earlier job with the same request
     * fingerprint rejoins it and starts nothing; the same key with another fingerprint is refused.
     */
    const start = (
      work: (ask: InputAsker) => Effect.Effect<unknown, Error, Scope.Scope>,
      submission?: RetrySubmission,
    ) =>
      submitPermit
        .withPermits(1)(
          Effect.gen(function* () {
            prune(yield* Clock.currentTimeMillis);
            if (submission?.retryKey === undefined) {
              if (busy()) return yield* Effect.fail(new McpJobFailure({ code: "busy" }));
              return yield* launch(randomUUID(), work, false);
            }
            const submitted = yield* submitJob(keyedStore, submission).pipe(
              Effect.catchTag("RetryConflict", () =>
                Effect.fail(new McpJobFailure({ code: "retry_conflict" })),
              ),
            );
            if (!submitted.rejoined) return yield* launch(submitted.job.id, work, true);
            const live = jobs.get(submitted.job.id);
            const view = live === undefined ? storedView(submitted.job) : snapshot(live);
            return { ...view, rejoined: true as const };
          }),
        )
        .pipe(Effect.uninterruptible);
    /** A job this server holds no live job for: its record, polled while another server runs it. */
    const recordedJob = (id: string, waitMs: number) =>
      Effect.gen(function* () {
        const until = (yield* Clock.currentTimeMillis) + waitMs;
        let record = yield* records.get(id);
        while (record?.status === "running" && (yield* Clock.currentTimeMillis) < until) {
          yield* Effect.sleep(250);
          record = yield* records.get(id);
        }
        return record === undefined
          ? yield* Effect.fail(new McpJobFailure({ code: "unknown_job" }))
          : storedView(record);
      });
    const get = (id: string, waitMs = 0) =>
      Effect.gen(function* () {
        prune(yield* Clock.currentTimeMillis);
        const job = jobs.get(id);
        if (job === undefined) return yield* recordedJob(id, waitMs);
        if (job.status === "running" && job.pending === undefined && waitMs > 0)
          yield* Effect.raceFirst(Deferred.await(job.changed), Effect.sleep(waitMs));
        return snapshot(job);
      });
    const provide = (id: string, requestId: string, answers: InputAnswers) =>
      Effect.gen(function* () {
        const job = yield* find(id);
        const pending = job.pending;
        const now = yield* Clock.currentTimeMillis;
        if (pending === undefined || pending.request.id !== requestId || now >= pending.expiresAt)
          return yield* Effect.fail(new McpJobFailure({ code: "stale_input" }));
        if (Either.isLeft(validateAnswer(pending.request, answers)))
          return yield* Effect.fail(new McpJobFailure({ code: "invalid_answers" }));
        // Remove the request before waking its fiber, so a second submission cannot answer it again.
        delete job.pending;
        yield* Deferred.succeed(pending.answer, answers);
        yield* signalChange(job);
        return snapshot(job);
      });
    const cancel = (id: string) =>
      Effect.gen(function* () {
        const job = yield* find(id);
        if (job.finishedAt === undefined && job.fiber !== undefined) {
          yield* Fiber.interrupt(job.fiber);
          job.status = "cancelled";
          job.finishedAt = yield* Clock.currentTimeMillis;
          delete job.pending;
          yield* recordOutcome(job);
          yield* signalChange(job);
        }
        return snapshot(job);
      });
    return { start, get, provide, cancel };
  });
export type McpJobs = Effect.Effect.Success<ReturnType<typeof makeMcpJobs>>;
