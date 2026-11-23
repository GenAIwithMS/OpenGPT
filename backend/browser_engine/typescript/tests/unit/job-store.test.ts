import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { Effect, Either } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { fingerprint } from "../../src/runtime/fingerprint.js";
import { RetryConflict, submitJob, type RetrySubmission } from "../../src/runtime/job-store.js";
import {
  localRequestFingerprint,
  localRetryKey,
  makeFileJobStore,
  makeMemoryJobStore,
  removeExpiredRecord,
  type LocalJobRecord,
} from "../../src/runtime/local-job-store.js";
import { describeJobStoreContract } from "../support/job-store-contract.js";

const folders: string[] = [];
const newFolder = async () => {
  const folder = await mkdtemp(join(tmpdir(), "opengpt-job-store-"));
  folders.push(folder);
  return folder;
};
afterAll(() => Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true }))));

const submission = (retry: { readonly retryKey?: string; readonly requestFingerprint: string }) =>
  retry satisfies RetrySubmission;
const isRetryConflict = (error: unknown) => error instanceof RetryConflict;

// Memory is the data, so one store stands for every open, as one process holds it.
const memory = Effect.runSync(Effect.scoped(makeMemoryJobStore()));
describeJobStoreContract("in-memory", {
  open: () => Effect.succeed((retry: RetrySubmission) => submitJob(memory, retry)),
  submission,
  jobId: (job) => job.id,
  isRetryConflict,
});

const contractFolder = await newFolder();
describeJobStoreContract("file", {
  open: () =>
    makeFileJobStore(contractFolder).pipe(
      Effect.map((store) => (retry: RetrySubmission) => submitJob(store, retry)),
    ),
  submission,
  jobId: (job) => job.id,
  isRetryConflict,
});

describe("the request fingerprint", () => {
  const key = new Uint8Array(32).fill(7);

  it("ignores object key order and separates its domains", () => {
    const one = fingerprint(key, "request", { tool: "save", input: { a: 1, b: [true, null] } });
    expect(fingerprint(key, "request", { input: { b: [true, null], a: 1 }, tool: "save" })).toBe(
      one,
    );
    expect(one).toMatch(/^[a-f0-9]{64}$/u);
    expect(fingerprint(key, "retry", { tool: "save", input: { a: 1, b: [true, null] } })).not.toBe(
      one,
    );
    expect(
      fingerprint(key, "request", { tool: "save", input: { a: 2, b: [true, null] } }),
    ).not.toBe(one);
  });

  // Hosts store these digests, so a change to them would make every stored retry key miss.
  it("gives the same digest it always gave for a fixed key and value", () => {
    expect(fingerprint(key, "request", { b: [true, null, 1.5, "x"], a: { d: 1, c: 2 } })).toBe(
      "c43dd34ac704dc270e55e3c082535b5616baad4da47fc411343f2beb38f0d3ad",
    );
    expect(fingerprint(key, "retry", { tool: "save", key: "booking-1" })).toBe(
      "e83cf16e604bac21f547bd6e50bc70c8435499ab3a8da0b19b0b9a1f84d9a254",
    );
    expect(localRetryKey("save", "k1")).toBe(
      "2b388852c1d44e44edc183585a2137a9e215298a15b2bf939492d898e7d4c76b",
    );
    expect(localRequestFingerprint("save", { a: 1 })).toBe(
      "3fe2748349083b3dd30a2a1eca9685c63f1ff577555d58a00ba17ece8d845a74",
    );
  });

  it("refuses a value that is not JSON data", () => {
    expect(() => fingerprint(key, "request", { input: Number.NaN })).toThrow(
      "Fingerprint input must be JSON data",
    );
  });

  it("scopes a local key and request to their tool", () => {
    expect(localRetryKey("save", "k1")).toBe(localRetryKey("save", "k1"));
    expect(localRetryKey("save", "k1")).not.toBe(localRetryKey("book", "k1"));
    expect(localRequestFingerprint("save", { a: 1, b: 2 })).toBe(
      localRequestFingerprint("save", { b: 2, a: 1 }),
    );
    expect(localRequestFingerprint("save", { a: 1 })).not.toBe(
      localRequestFingerprint("book", { a: 1 }),
    );
  });
});

/** The records a file store folder holds, read as a person would. */
const records = async (folder: string) =>
  Promise.all(
    (await readdir(folder))
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => ({
        name,
        record: JSON.parse(await readFile(join(folder, name), "utf8")) as LocalJobRecord,
      })),
  );

/** A process ID that no longer runs: a child that has already exited. */
const exitedProcessId = async () => {
  const child = spawn(process.execPath, ["-e", ""]);
  await once(child, "exit");
  if (child.pid === undefined) throw new Error("The child had no process ID");
  return child.pid;
};

describe("the local file store", () => {
  const keyed = { retryKey: "retry_a", requestFingerprint: "f".repeat(64) };

  it("keeps a keyed job's record across a restart, so get finds it by its ID", async () => {
    const folder = await newFolder();
    const first = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* makeFileJobStore(folder);
          const submitted = yield* submitJob(store, keyed);
          yield* store.update(submitted.job.id, {
            status: "completed",
            finishedAt: Date.now(),
            effect: "verified",
            commits: [{ name: "save", state: "confirmed" }],
            confirmation: "message",
          });
          return submitted.job;
        }),
      ),
    );
    const reopened = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* makeFileJobStore(folder);
          return yield* store.get(first.id);
        }),
      ),
    );
    expect(reopened).toMatchObject({
      id: first.id,
      requestFingerprint: keyed.requestFingerprint,
      status: "completed",
      effect: "verified",
      commits: [{ name: "save", state: "confirmed" }],
      confirmation: "message",
    });
    const [saved] = await records(folder);
    expect(saved?.record.retryKey).toBe("retry_a");
  });

  it("reads a job whose server process stopped while it ran as failed on open, and never as running", async () => {
    const folder = await newFolder();
    const job = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* makeFileJobStore(folder);
          return (yield* submitJob(store, keyed)).job;
        }),
      ),
    );
    const [saved] = await records(folder);
    if (saved === undefined) throw new Error("No record");
    await writeFile(
      join(folder, saved.name),
      JSON.stringify({ ...saved.record, owner: `${await exitedProcessId()}:stopped` }),
    );
    const reopened = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* makeFileJobStore(folder);
          const read = yield* store.get(job.id);
          const again = yield* submitJob(store, keyed);
          return { read, again };
        }),
      ),
    );
    expect(reopened.read).toMatchObject({ status: "failed", lost: true });
    expect(reopened.read?.finishedAt).toBeTypeOf("number");
    expect(reopened.again).toMatchObject({ rejoined: true, job: { id: job.id, status: "failed" } });
  });

  it("leaves a job running while the store that started it stays open", async () => {
    const folder = await newFolder();
    const read = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* makeFileJobStore(folder);
          const job = (yield* submitJob(owner, keyed)).job;
          const other = yield* makeFileJobStore(folder);
          return yield* other.get(job.id);
        }),
      ),
    );
    expect(read).toMatchObject({ status: "running" });
    expect(read?.lost).toBeUndefined();
  });

  it("deletes a finished record older than a day when it opens, freeing its key", async () => {
    const folder = await newFolder();
    const job = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* makeFileJobStore(folder);
          const submitted = yield* submitJob(store, keyed);
          yield* store.update(submitted.job.id, {
            status: "completed",
            finishedAt: Date.now() - 2 * 24 * 60 * 60_000,
          });
          return submitted.job;
        }),
      ),
    );
    const after = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* makeFileJobStore(folder);
          return {
            read: yield* store.get(job.id),
            again: yield* submitJob(store, { ...keyed, requestFingerprint: "e".repeat(64) }),
          };
        }),
      ),
    );
    expect(after.read).toBeUndefined();
    expect(after.again.rejoined).toBe(false);
  });

  it("never deletes a running job's record, however old, while its server runs", async () => {
    const folder = await newFolder();
    const read = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* makeFileJobStore(folder);
          const job = (yield* submitJob(owner, keyed)).job;
          const old = { ...job, createdAt: Date.now() - 3 * 24 * 60 * 60_000 };
          yield* Effect.promise(() =>
            writeFile(join(folder, `${job.id}.json`), JSON.stringify(old)),
          );
          const other = yield* makeFileJobStore(folder);
          return {
            read: yield* other.get(job.id),
            again: yield* submitJob(other, keyed),
          };
        }),
      ),
    );
    expect(read.read).toMatchObject({ status: "running" });
    expect(read.again).toMatchObject({ rejoined: true, job: { status: "running" } });
  });

  it("deletes a stray temporary file older than a day when it opens, and keeps a newer one", async () => {
    const folder = await newFolder();
    const old = join(folder, `.${randomUUID()}.${randomUUID()}.tmp`);
    const fresh = join(folder, `.${randomUUID()}.${randomUUID()}.tmp`);
    await writeFile(old, "{}");
    await writeFile(fresh, "{}");
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    await utimes(old, twoDaysAgo, twoDaysAgo);
    await Effect.runPromise(Effect.scoped(makeFileJobStore(folder)));
    expect(await readdir(folder)).toEqual([basename(fresh)]);
  });

  it("keeps a record another process wrote over an expired one a sweep is deleting", async () => {
    const folder = await newFolder();
    const id = randomUUID();
    const file = join(folder, `${id}.json`);
    const expired: LocalJobRecord = {
      version: 1,
      id,
      retryKey: "retry_a",
      requestFingerprint: "f".repeat(64),
      status: "completed",
      createdAt: 1,
      finishedAt: 2,
      owner: "1:first",
    };
    const newer: LocalJobRecord = {
      version: 1,
      id,
      retryKey: "retry_a",
      requestFingerprint: "f".repeat(64),
      status: "running",
      createdAt: Date.now(),
      owner: "2:second",
    };
    await writeFile(file, JSON.stringify(newer));
    await Effect.runPromise(removeExpiredRecord(file, expired));
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(newer);
    expect(await readdir(folder)).toEqual([basename(file)]);

    await Effect.runPromise(removeExpiredRecord(file, newer));
    expect(await readdir(folder)).toEqual([]);
    await Effect.runPromise(removeExpiredRecord(file, newer));
  });

  it("fails a keyed submission closed when its record can't be read", async () => {
    const folder = await newFolder();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* submitJob(yield* makeFileJobStore(folder), keyed);
        }),
      ),
    );
    const [saved] = await records(folder);
    if (saved === undefined) throw new Error("No record");
    await writeFile(join(folder, saved.name), "{not json");
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* makeFileJobStore(folder);
          return yield* Effect.either(submitJob(store, keyed));
        }),
      ),
    );
    expect(Either.isLeft(result)).toBe(true);
    expect(Either.isLeft(result) && result.left instanceof RetryConflict).toBe(false);
    expect(await readFile(join(folder, saved.name), "utf8")).toBe("{not json");
  });

  it("opens in a folder it can't write, and fails a keyed submission there before storing anything", async () => {
    const folder = await newFolder();
    await chmod(folder, 0o500);
    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* makeFileJobStore(join(folder, ".jobs"));
            return {
              read: yield* store.get(randomUUID()),
              keyed: yield* Effect.either(submitJob(store, keyed)),
            };
          }),
        ),
      );
      expect(result.read).toBeUndefined();
      expect(Either.isLeft(result.keyed)).toBe(true);
      expect(await readdir(folder)).toEqual([]);
    } finally {
      await chmod(folder, 0o700);
    }
  });

  it("stores one job when two processes submit one key at the same moment", async () => {
    const folder = await newFolder();
    const source = new URL("../../src/runtime/", import.meta.url).href;
    // Each child loads the TypeScript sources as the local operation child does, then waits for
    // `go` so both submit at once.
    const script = `
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
registerHooks({ resolve: (specifier, context, next) => {
  if (context.parentURL?.startsWith("file:") && /^\\.\\.?\\/.*\\.js$/.test(specifier)) {
    const source = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(source))) return next(source.href, context);
  }
  return next(specifier, context);
} });
const { Effect } = await import("effect");
const { submitJob } = await import(${JSON.stringify(`${source}job-store.ts`)});
const { makeFileJobStore } = await import(${JSON.stringify(`${source}local-job-store.ts`)});
const lines = createInterface({ input: process.stdin });
const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const store = yield* makeFileJobStore(${JSON.stringify(folder)});
  process.stdout.write("ready\\n");
  yield* Effect.promise(() => new Promise((resolve) => lines.once("line", resolve)));
  return yield* submitJob(store, ${JSON.stringify(keyed)});
})));
process.stdout.write(JSON.stringify({ id: result.job.id, rejoined: result.rejoined }) + "\\n");
lines.close();
`;
    const children = [0, 1].map(() => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        cwd: new URL("../../../", import.meta.url).pathname,
        stdio: ["pipe", "pipe", "inherit"],
      });
      const lines = createInterface({ input: child.stdout });
      const output: string[] = [];
      const ready = new Promise<void>((resolve) =>
        lines.on("line", (line) => {
          if (line === "ready") resolve();
          else output.push(line);
        }),
      );
      return { child, ready, output, exited: once(child, "exit") };
    });
    await Promise.all(children.map((child) => child.ready));
    for (const { child } of children) child.stdin.write("go\n");
    await Promise.all(children.map((child) => child.exited));
    const results = children.map(
      ({ output }) => JSON.parse(output.join("")) as { id: string; rejoined: boolean },
    );
    expect(results.map((result) => result.rejoined).sort()).toEqual([false, true]);
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect((await records(folder)).length).toBe(1);
  });
});
