import { createHash, randomUUID } from "node:crypto";
import { Effect, Either, type Scope } from "effect";
import { describe, expect, it } from "vitest";
import type { SubmittedJob } from "../../src/runtime/job-store.js";

/**
 * What a host gives the shared JobStore contract. Every store it opens reads the same data, so a
 * second open stands for a restart of the server, or for a second server process beside the first.
 */
export interface JobStoreContract<Submission, Job> {
  /**
   * Opens a store over the shared data and answers its submit, which runs the shared retry-key rule
   * (`submitJob`) on that store. Closing the scope closes the store.
   */
  readonly open: () => Effect.Effect<
    (submission: Submission) => Effect.Effect<SubmittedJob<Job>, unknown>,
    unknown,
    Scope.Scope
  >;
  /** A submission this host accepts, with this retry key (none when absent) and fingerprint. */
  readonly submission: (retry: {
    readonly retryKey?: string;
    readonly requestFingerprint: string;
  }) => Submission;
  readonly jobId: (job: Job) => string;
  /** The host's refusal of a retry key already used for a different request. */
  readonly isRetryConflict: (error: unknown) => boolean;
}

/** A fresh retry key: letters and digits, as every host's key format accepts. */
const newKey = () => `key${randomUUID().replaceAll("-", "")}`;
/** A fresh request fingerprint: 64 lowercase hex digits, as every host's fingerprint has. */
const newFingerprint = () => createHash("sha256").update(randomUUID()).digest("hex");

/**
 * The shared JobStore contract: the same retry key and request fingerprint rejoin the first job,
 * in parallel, across two stores and after a restart; the same key with another fingerprint is
 * refused; any other submission creates a new job. A host runs it on its own store.
 */
export const describeJobStoreContract = <Submission, Job>(
  name: string,
  contract: JobStoreContract<Submission, Job>,
): void => {
  const run = <A>(effect: Effect.Effect<A, unknown, Scope.Scope>) =>
    Effect.runPromise(Effect.scoped(effect));
  const ids = (results: readonly SubmittedJob<Job>[]) =>
    results.map((result) => contract.jobId(result.job));

  describe(`${name} JobStore contract`, () => {
    it("stores one job for one key and fingerprint sent twice in parallel, and rejoins the second", () =>
      run(
        Effect.gen(function* () {
          const submit = yield* contract.open();
          const submission = contract.submission({
            retryKey: newKey(),
            requestFingerprint: newFingerprint(),
          });
          const results = yield* Effect.all([submit(submission), submit(submission)], {
            concurrency: "unbounded",
          });
          expect(results.map((result) => result.rejoined).sort()).toEqual([false, true]);
          expect(new Set(ids(results)).size).toBe(1);
        }),
      ));

    it("stores one job for one key sent at once to two stores over the same data", () =>
      run(
        Effect.gen(function* () {
          const first = yield* contract.open();
          const second = yield* contract.open();
          const submission = contract.submission({
            retryKey: newKey(),
            requestFingerprint: newFingerprint(),
          });
          const results = yield* Effect.all([first(submission), second(submission)], {
            concurrency: "unbounded",
          });
          expect(results.map((result) => result.rejoined).sort()).toEqual([false, true]);
          expect(new Set(ids(results)).size).toBe(1);
        }),
      ));

    it("refuses a key already used for a request with another fingerprint", () =>
      run(
        Effect.gen(function* () {
          const submit = yield* contract.open();
          const retryKey = newKey();
          yield* submit(contract.submission({ retryKey, requestFingerprint: newFingerprint() }));
          const refused = yield* Effect.either(
            submit(contract.submission({ retryKey, requestFingerprint: newFingerprint() })),
          );
          expect(Either.isLeft(refused) && contract.isRetryConflict(refused.left)).toBe(true);
        }),
      ));

    it("still rejoins and still refuses after a restart over the same data", () =>
      run(
        Effect.gen(function* () {
          const retryKey = newKey();
          const requestFingerprint = newFingerprint();
          const first = yield* Effect.scoped(
            Effect.gen(function* () {
              const submit = yield* contract.open();
              return yield* submit(contract.submission({ retryKey, requestFingerprint }));
            }),
          );
          const submit = yield* contract.open();
          const again = yield* submit(contract.submission({ retryKey, requestFingerprint }));
          expect(again.rejoined).toBe(true);
          expect(contract.jobId(again.job)).toBe(contract.jobId(first.job));
          const refused = yield* Effect.either(
            submit(contract.submission({ retryKey, requestFingerprint: newFingerprint() })),
          );
          expect(Either.isLeft(refused) && contract.isRetryConflict(refused.left)).toBe(true);
        }),
      ));

    it("creates a new job for another key, and for each submission without a key", () =>
      run(
        Effect.gen(function* () {
          const submit = yield* contract.open();
          const requestFingerprint = newFingerprint();
          const results = [
            yield* submit(contract.submission({ retryKey: newKey(), requestFingerprint })),
            yield* submit(contract.submission({ retryKey: newKey(), requestFingerprint })),
            yield* submit(contract.submission({ requestFingerprint })),
            yield* submit(contract.submission({ requestFingerprint })),
          ];
          expect(results.map((result) => result.rejoined)).toEqual([false, false, false, false]);
          expect(new Set(ids(results)).size).toBe(4);
        }),
      ));
  });
};
