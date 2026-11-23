import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Clock, Effect, Schema, type Scope } from "effect";
import { localPromise } from "../execution/local-path.js";
import { runOutcomeCodes } from "./run-outcome.js";
import { fingerprint } from "./fingerprint.js";
import type { JobStore, RetrySubmission } from "./job-store.js";

const CommitMark = Schema.Struct({
  name: Schema.String,
  state: Schema.Literal("not_sent", "sent", "confirmed"),
});
/** A failed run's outcome, as its job answers it: code, write status, possible commit, retry. */
const RecordedOutcome = Schema.Struct({
  code: Schema.Literal(...runOutcomeCodes),
  writeStatus: Schema.NullOr(
    Schema.Literal("not_attempted", "may_have_applied", "applied", "not_applied"),
  ),
  possibleCommit: Schema.Boolean,
  retry: Schema.Literal("never", "fix_input", "same_key", "new_key"),
});
/**
 * What the local host keeps of a job: its key, request fingerprint, ID and status, and the
 * outcome, commit marks and confirmation its failed run reported. It keeps no input and no output.
 */
export const LocalJobRecord = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.UUID,
  retryKey: Schema.optionalWith(Schema.String, { exact: true }),
  requestFingerprint: Schema.String,
  status: Schema.Literal("running", "completed", "failed", "cancelled"),
  createdAt: Schema.Number,
  finishedAt: Schema.optionalWith(Schema.Number, { exact: true }),
  error: Schema.optionalWith(Schema.String, { exact: true }),
  /** The job failed signing in, before its operation could act on the website. */
  beforeOperation: Schema.optionalWith(Schema.Literal(true), { exact: true }),
  /** The server running the job stopped before it finished, so its outcome is unknown. */
  lost: Schema.optionalWith(Schema.Literal(true), { exact: true }),
  effect: Schema.optionalWith(Schema.Literal("not_sent", "possible", "verified"), { exact: true }),
  commits: Schema.optionalWith(Schema.Array(CommitMark), { exact: true }),
  confirmation: Schema.optionalWith(Schema.Literal("message", "readback"), { exact: true }),
  outcome: Schema.optionalWith(RecordedOutcome, { exact: true }),
  /** The process ID and store instance that started the job, as `pid:instance`. */
  owner: Schema.String,
});
export type LocalJobRecord = typeof LocalJobRecord.Type;
export type LocalJobUpdate = Partial<
  Pick<
    LocalJobRecord,
    | "status"
    | "finishedAt"
    | "error"
    | "beforeOperation"
    | "effect"
    | "commits"
    | "confirmation"
    | "outcome"
  >
>;

/** A JobStore the local MCP host runs, with the reads and updates its jobs need. */
export interface LocalJobStore extends JobStore<RetrySubmission, LocalJobRecord, Error> {
  /** The record the submission's retry key names, or undefined when it names none. */
  readonly lookup: (
    submission: RetrySubmission,
  ) => Effect.Effect<LocalJobRecord | undefined, Error>;
  readonly get: (id: string) => Effect.Effect<LocalJobRecord | undefined, Error>;
  readonly update: (id: string, patch: LocalJobUpdate) => Effect.Effect<void, Error>;
  /** Records outlive this process, so a restarted server finds them. */
  readonly persistent: boolean;
}

/** A finished job's record is kept this long, and its retry key with it. */
const retentionMs = 24 * 60 * 60_000;
/** A store sweeps old records when it opens, and again at most this often while it runs. */
const sweepIntervalMs = 60 * 60_000;
/** The local key for fingerprints. It is fixed, so a key's digest never changes across restarts. */
const localKey = new TextEncoder().encode("opengpt local job store");

/** A caller's idempotency key, scoped to its tool, as a store keeps it. */
export const localRetryKey = (tool: string, key: string): string =>
  fingerprint(localKey, "retry", { tool, key });
/** The digest of a call's input, scoped to its tool. The store keeps it instead of the input. */
export const localRequestFingerprint = (tool: string, input: unknown): string =>
  fingerprint(localKey, "request", { tool, input: input ?? null });

/** The stores open in this process, so a record from another process is told apart. */
const openOwners = new Set<string>();
const openOwner = Effect.acquireRelease(
  Effect.sync(() => {
    const owner = `${process.pid}:${randomUUID()}`;
    openOwners.add(owner);
    return owner;
  }),
  (owner) => Effect.sync(() => openOwners.delete(owner)),
);
/**
 * Whether the server that started a job still runs: an open store in this process, or a live
 * process. A reused process ID reads as running, which never replays the job.
 */
const ownerRuns = (owner: string) => {
  const pid = Number(owner.split(":")[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return openOwners.has(owner);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

const newRecord = (
  id: string,
  submission: RetrySubmission,
  owner: string,
  createdAt: number,
): LocalJobRecord => ({
  version: 1,
  id,
  ...(submission.retryKey === undefined ? {} : { retryKey: submission.retryKey }),
  requestFingerprint: submission.requestFingerprint,
  status: "running",
  createdAt,
  owner,
});
const expired = (record: LocalJobRecord, now: number) =>
  record.finishedAt !== undefined && now - record.finishedAt >= retentionMs;
const missingRecord = () =>
  new Error("The job a retry key names was removed. Send the call again.");

/** Jobs kept in this process only, for a host with no folder to keep them in. */
export const makeMemoryJobStore = (): Effect.Effect<LocalJobStore, never, Scope.Scope> =>
  Effect.gen(function* () {
    const owner = yield* openOwner;
    const records = new Map<string, LocalJobRecord>();
    const keys = new Map<string, string>();
    const lookup = (submission: RetrySubmission) =>
      Effect.sync(() => {
        const id = submission.retryKey === undefined ? undefined : keys.get(submission.retryKey);
        return id === undefined ? undefined : records.get(id);
      });
    return {
      persistent: false,
      // Map reads and writes run without a yield between them, so the insert is atomic.
      insert: (submission) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) => {
            for (const [id, record] of records)
              if (expired(record, now)) {
                records.delete(id);
                if (record.retryKey !== undefined) keys.delete(record.retryKey);
              }
            if (submission.retryKey !== undefined && keys.has(submission.retryKey))
              return undefined;
            const record = newRecord(randomUUID(), submission, owner, now);
            records.set(record.id, record);
            if (submission.retryKey !== undefined) keys.set(submission.retryKey, record.id);
            return record;
          }),
        ),
      lookup,
      findByRetryKey: (submission) =>
        lookup(submission).pipe(
          Effect.flatMap((record) =>
            record === undefined ? Effect.fail(missingRecord()) : Effect.succeed(record),
          ),
        ),
      get: (id) => Effect.sync(() => records.get(id)),
      update: (id, patch) =>
        Effect.sync(() => {
          const record = records.get(id);
          if (record !== undefined) records.set(id, { ...record, ...patch });
        }),
    };
  });

const recordFile = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/u;
const isMissing = (error: Error) => "code" in error && error.code === "ENOENT";
const isTaken = (error: Error) => "code" in error && error.code === "EEXIST";
const decodeRecord = (text: string) =>
  Schema.decodeUnknown(Schema.parseJson(LocalJobRecord))(text).pipe(
    Effect.mapError((cause) => new Error("A local job record can't be read.", { cause })),
  );

/**
 * Deletes the expired record a sweep read from `file`. Another process may have deleted that record
 * and created a new one for the same key since, so the file is moved aside whole, read again, and
 * linked back unless it is still the record the sweep read.
 */
export const removeExpiredRecord = (file: string, swept: LocalJobRecord) =>
  Effect.gen(function* () {
    const aside = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
    const moved = yield* localPromise(() => rename(file, aside)).pipe(
      Effect.as(true),
      Effect.catchIf(isMissing, () => Effect.succeed(false)),
    );
    if (!moved) return;
    const current = yield* localPromise(() => readFile(aside, "utf8")).pipe(
      Effect.flatMap(decodeRecord),
      Effect.orElseSucceed(() => undefined),
    );
    if (current?.createdAt !== swept.createdAt || current.owner !== swept.owner)
      yield* localPromise(() => link(aside, file)).pipe(Effect.catchIf(isTaken, () => Effect.void));
    yield* localPromise(() => rm(aside, { force: true }));
  });

/** A keyed job's ID: a UUID drawn from its retry key, so each key has exactly one file name. */
const keyedJobId = (retryKey: string) => {
  const hex = createHash("sha256").update(retryKey).digest("hex");
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/**
 * Jobs kept as one JSON file each in `directory`, so a restarted server, or a second server on the
 * same tool, finds them. A keyed job's file is named for its key and created exclusively: the
 * record is written whole to a temporary file and then hard-linked into place, and the link fails
 * when the key's file exists. Two processes submitting one key at once therefore store one job.
 * Opening the store reads every record: a running job whose server stopped is marked lost, and a
 * finished record older than a day is deleted. The folder is created with the first record.
 */
export const makeFileJobStore = (
  directory: string,
): Effect.Effect<LocalJobStore, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const owner = yield* openOwner;
    const path = (id: string) => join(directory, `${id}.json`);
    const temporary = (id: string) => join(directory, `.${id}.${randomUUID()}.tmp`);
    const text = (record: LocalJobRecord) => `${JSON.stringify(record)}\n`;
    const read = (id: string) =>
      localPromise(() => readFile(path(id), "utf8")).pipe(
        Effect.flatMap(decodeRecord),
        Effect.map((record): LocalJobRecord | undefined => record),
        Effect.catchIf(isMissing, () => Effect.succeed(undefined)),
      );
    const write = (record: LocalJobRecord) =>
      Effect.gen(function* () {
        const next = temporary(record.id);
        yield* localPromise(() => writeFile(next, text(record), { mode: 0o600, flag: "wx" }));
        yield* localPromise(() => rename(next, path(record.id))).pipe(
          Effect.tapError(() => localPromise(() => rm(next, { force: true })).pipe(Effect.ignore)),
        );
      });
    /**
     * Creates the record's file only when none exists, answering whether it did. The folder is
     * made here, so a tool folder nobody may write still serves calls without a key.
     */
    const create = (record: LocalJobRecord) =>
      Effect.gen(function* () {
        yield* localPromise(() => mkdir(directory, { recursive: true, mode: 0o700 }));
        const next = temporary(record.id);
        yield* localPromise(() => writeFile(next, text(record), { mode: 0o600, flag: "wx" }));
        return yield* localPromise(() => link(next, path(record.id))).pipe(
          Effect.as(true),
          Effect.catchIf(isTaken, () => Effect.succeed(false)),
          Effect.ensuring(localPromise(() => rm(next, { force: true })).pipe(Effect.ignore)),
        );
      });
    /** A running record whose server stopped is lost: it is failed, finished and never resumed. */
    const current = (record: LocalJobRecord) =>
      Effect.gen(function* () {
        if (record.status !== "running" || ownerRuns(record.owner)) return record;
        const lost: LocalJobRecord = {
          ...record,
          status: "failed",
          lost: true,
          finishedAt: yield* Clock.currentTimeMillis,
        };
        yield* write(lost);
        return lost;
      });
    const get = (id: string) =>
      Schema.is(Schema.UUID)(id)
        ? read(id).pipe(
            Effect.flatMap((record) =>
              record === undefined ? Effect.succeed(undefined) : current(record),
            ),
          )
        : Effect.succeed(undefined);
    const lookup = (submission: RetrySubmission) =>
      submission.retryKey === undefined
        ? Effect.succeed(undefined)
        : get(keyedJobId(submission.retryKey));
    let sweptAt = 0;
    /** Marks lost jobs and deletes expired records and stray temporary files. */
    const sweep = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      sweptAt = now;
      const names = yield* localPromise(() => readdir(directory)).pipe(
        Effect.catchIf(isMissing, () => Effect.succeed([])),
      );
      for (const name of names) {
        if (recordFile.test(name)) {
          // An unreadable record stays, so its key keeps failing closed instead of acting again.
          const record = yield* get(name.slice(0, -".json".length)).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          if (record !== undefined && expired(record, now))
            yield* removeExpiredRecord(join(directory, name), record);
        } else if (name.endsWith(".tmp")) {
          const file = join(directory, name);
          const modified = yield* localPromise(() => stat(file)).pipe(
            Effect.map((stats) => stats.mtimeMs),
            Effect.orElseSucceed(() => now),
          );
          if (now - modified >= retentionMs) yield* localPromise(() => rm(file, { force: true }));
        }
      }
    });
    // A folder this process can't read or write leaves its keyed calls failing closed later.
    yield* sweep.pipe(Effect.ignore);
    return {
      persistent: true,
      insert: (submission) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (now - sweptAt >= sweepIntervalMs) yield* sweep.pipe(Effect.ignore);
          const id =
            submission.retryKey === undefined ? randomUUID() : keyedJobId(submission.retryKey);
          const record = newRecord(id, submission, owner, now);
          return (yield* create(record)) ? record : undefined;
        }),
      lookup,
      findByRetryKey: (submission) =>
        lookup(submission).pipe(
          Effect.flatMap((record) =>
            record === undefined ? Effect.fail(missingRecord()) : Effect.succeed(record),
          ),
        ),
      get,
      update: (id, patch) =>
        read(id).pipe(
          Effect.flatMap((record) =>
            record === undefined ? Effect.void : write({ ...record, ...patch }),
          ),
        ),
    };
  });
