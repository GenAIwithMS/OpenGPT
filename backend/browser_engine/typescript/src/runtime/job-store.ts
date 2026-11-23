import { Data, Effect } from "effect";

/**
 * What a job is submitted with to be found again. A retry key names one job for its caller, and a
 * submission without one always creates a new job. The fingerprint stands for the request as sent.
 */
export interface RetrySubmission {
  readonly retryKey?: string | undefined;
  readonly requestFingerprint: string;
}

/** A stored job keeps the fingerprint of the request that created it. */
export interface StoredJob {
  readonly requestFingerprint: string;
}

/**
 * Where a host keeps its jobs: in memory, in files beside a tool, or in a database. The local
 * host's stores are in `local-job-store.ts`, and another host plugs in its own.
 */
export interface JobStore<
  Submission extends RetrySubmission,
  Job extends StoredJob,
  E = never,
  R = never,
> {
  /**
   * Stores a new job for the submission unless its retry key already names one, and answers
   * undefined when it does. It is one atomic step, never a read and then a write, so two
   * concurrent submissions of one key store one job between them.
   */
  readonly insert: (submission: Submission) => Effect.Effect<Job | undefined, E, R>;
  /** The job the submission's retry key already names. */
  readonly findByRetryKey: (submission: Submission) => Effect.Effect<Job, E, R>;
}

export interface SubmittedJob<Job> {
  readonly job: Job;
  /** The retry key already named this job, so the submission started nothing new. */
  readonly rejoined: boolean;
}

/** The retry key already names a job for a different request, or for a different caller. */
export class RetryConflict extends Data.TaggedError("RetryConflict") {}

/**
 * The retry-key rule every host shares. A submission whose key names no job creates one. The same
 * key with the same request fingerprint rejoins the job the key names, so a repeated call never
 * acts again. The same key with a different fingerprint is refused with `RetryConflict`. A host
 * that tells callers apart passes `sameCaller`, and a key used by another caller is refused too.
 */
export const submitJob = <Submission extends RetrySubmission, Job extends StoredJob, E, R>(
  store: JobStore<Submission, Job, E, R>,
  submission: Submission,
  sameCaller: (job: Job, submission: Submission) => boolean = () => true,
): Effect.Effect<SubmittedJob<Job>, E | RetryConflict, R> =>
  Effect.gen(function* () {
    const inserted = yield* store.insert(submission);
    if (inserted !== undefined) return { job: inserted, rejoined: false };
    const job = yield* store.findByRetryKey(submission);
    if (!sameCaller(job, submission) || job.requestFingerprint !== submission.requestFingerprint)
      return yield* new RetryConflict();
    return { job, rejoined: true };
  });
