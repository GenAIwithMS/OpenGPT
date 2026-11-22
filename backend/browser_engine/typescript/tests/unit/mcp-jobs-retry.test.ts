import { chmod, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Deferred, Effect, Ref } from "effect";
import { expect, it } from "vitest";
import { LocalOperationFailure } from "../../src/execution/local-operation.js";
import { makeFileJobStore } from "../../src/runtime/local-job-store.js";
import { makeMcpJobs, mcpFailureMessage, type McpJobs } from "../../src/standalone/mcp-jobs.js";
import { runOutcomeFailure } from "../../src/standalone/run-report.js";

/** Polls a job until it leaves running, as a caller polling get_job does. */
const finished = (jobs: McpJobs, id: string) =>
  Effect.gen(function* () {
    let view = yield* jobs.get(id, 200);
    for (let attempt = 0; attempt < 20 && view.status === "running"; attempt++)
      view = yield* jobs.get(id, 200);
    return view;
  });

/** Work that counts its runs, as each website write would. */
const countingWork = (runs: Ref.Ref<number>) => () =>
  Ref.updateAndGet(runs, (count) => count + 1).pipe(Effect.map((count) => ({ saved: count })));

it("runs the work again for a second call without a key once the first finished", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* makeMcpJobs(1, "run");
        const runs = yield* Ref.make(0);
        const first = yield* jobs.start(countingWork(runs));
        const firstView = yield* finished(jobs, first.job_id);
        const second = yield* jobs.start(countingWork(runs));
        const secondView = yield* finished(jobs, second.job_id);
        return { first, firstView, second, secondView, runs: yield* Ref.get(runs) };
      }),
    ),
  );
  expect(result.runs).toBe(2);
  expect(result.second.job_id).not.toBe(result.first.job_id);
  expect(result.firstView).toMatchObject({ status: "completed", output: { saved: 1 } });
  expect(result.secondView).toMatchObject({ status: "completed", output: { saved: 2 } });
});

it("refuses a call without a key as busy while another job runs", async () => {
  const message = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* makeMcpJobs(1, "run");
        const gate = yield* Deferred.make<void>();
        yield* jobs.start(() => Deferred.await(gate));
        const refused = yield* Effect.flip(jobs.start(() => Effect.succeed({ saved: true })));
        yield* Deferred.succeed(gate, undefined);
        return mcpFailureMessage(Cause.fail(refused), "run");
      }),
    ),
  );
  expect(message).toBe("The server is busy. Wait for or cancel its active job.");
});

const keyed = { retryKey: "retry_a", requestFingerprint: "a".repeat(64) };

it("rejoins the first job for a second call with the same key and request, and runs the work once", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* makeMcpJobs(1, "run");
        const runs = yield* Ref.make(0);
        const first = yield* jobs.start(countingWork(runs), keyed);
        yield* finished(jobs, first.job_id);
        const again = yield* jobs.start(countingWork(runs), keyed);
        return { first, again, view: yield* jobs.get(again.job_id), runs: yield* Ref.get(runs) };
      }),
    ),
  );
  expect(result.runs).toBe(1);
  expect(result.first.rejoined).toBeUndefined();
  expect(result.again).toMatchObject({ job_id: result.first.job_id, rejoined: true });
  expect(result.view).toMatchObject({ status: "completed", output: { saved: 1 } });
});

it("runs the work once for two calls with the same key sent in parallel", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* makeMcpJobs(1, "run");
        const runs = yield* Ref.make(0);
        const gate = yield* Deferred.make<void>();
        const work = () => Deferred.await(gate).pipe(Effect.zipRight(countingWork(runs)()));
        const views = yield* Effect.all([jobs.start(work, keyed), jobs.start(work, keyed)], {
          concurrency: "unbounded",
        });
        yield* Deferred.succeed(gate, undefined);
        yield* finished(jobs, views[0].job_id);
        return { views, runs: yield* Ref.get(runs) };
      }),
    ),
  );
  expect(result.runs).toBe(1);
  expect(result.views[1].job_id).toBe(result.views[0].job_id);
  expect(result.views.map((view) => view.rejoined === true).sort()).toEqual([false, true]);
});

it("rejoins a running job by its key while the server is busy, and refuses a new key as busy", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* makeMcpJobs(1, "run");
        const gate = yield* Deferred.make<void>();
        const first = yield* jobs.start(() => Deferred.await(gate), keyed);
        const again = yield* jobs.start(() => Effect.succeed({ saved: true }), keyed);
        const refused = yield* Effect.flip(
          jobs.start(() => Effect.succeed({ saved: true }), { ...keyed, retryKey: "retry_b" }),
        );
        yield* Deferred.succeed(gate, undefined);
        return { first, again, busy: mcpFailureMessage(Cause.fail(refused), "run") };
      }),
    ),
  );
  expect(result.again).toMatchObject({
    job_id: result.first.job_id,
    status: "running",
    rejoined: true,
  });
  expect(result.busy).toBe("The server is busy. Wait for or cancel its active job.");
});

it("refuses a key already used for a different request, and runs nothing for it", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* makeMcpJobs(1, "run");
        const runs = yield* Ref.make(0);
        const first = yield* jobs.start(countingWork(runs), keyed);
        yield* finished(jobs, first.job_id);
        const refused = yield* Effect.flip(
          jobs.start(countingWork(runs), { ...keyed, requestFingerprint: "b".repeat(64) }),
        );
        return {
          message: mcpFailureMessage(Cause.fail(refused), "run"),
          runs: yield* Ref.get(runs),
        };
      }),
    ),
  );
  expect(result.runs).toBe(1);
  expect(result.message).toBe(
    "This idempotency key was already used for a different request. Repeat the original request with that key, or use a new key for a new request.",
  );
});

it("rejoins a keyed job after a restart over the same folder, and answers its stored status", async () => {
  const folder = await mkdtemp(join(tmpdir(), "opengpt-browser-mcp-jobs-"));
  try {
    const first = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const jobs = yield* makeMcpJobs(1, "run", yield* makeFileJobStore(folder));
          const runs = yield* Ref.make(0);
          const started = yield* jobs.start(countingWork(runs), keyed);
          return yield* finished(jobs, started.job_id);
        }),
      ),
    );
    const after = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const jobs = yield* makeMcpJobs(1, "run", yield* makeFileJobStore(folder));
          const runs = yield* Ref.make(0);
          const again = yield* jobs.start(countingWork(runs), keyed);
          const view = yield* jobs.get(first.job_id);
          return { again, view, runs: yield* Ref.get(runs) };
        }),
      ),
    );
    expect(first).toMatchObject({ status: "completed", output: { saved: 1 } });
    expect(after.runs).toBe(0);
    expect(after.again).toMatchObject({ job_id: first.job_id, rejoined: true });
    // Output is not kept on disk, so a job finished before the restart answers its status only.
    expect(after.view).toEqual({ job_id: first.job_id, status: "completed" });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

it("reads a keyed job its stopped server left running as failed, and never runs it again", async () => {
  const folder = await mkdtemp(join(tmpdir(), "opengpt-browser-mcp-jobs-"));
  try {
    // Closing the scope is the server's graceful stop, on end of input or a signal.
    const started = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* makeFileJobStore(folder);
          const jobs = yield* makeMcpJobs(1, "run", store);
          return yield* jobs.start(() => Effect.never, keyed);
        }),
      ),
    );
    const [name] = (await readdir(folder)).filter((file) => file.endsWith(".json"));
    if (name === undefined) throw new Error("No record");
    // The stop interrupts the job without an outcome, so its record still says running.
    const record: unknown = JSON.parse(await readFile(join(folder, name), "utf8"));
    expect(record).toMatchObject({ id: started.job_id, status: "running" });
    expect(record).not.toHaveProperty("lost");
    const after = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const jobs = yield* makeMcpJobs(1, "run", yield* makeFileJobStore(folder));
          const runs = yield* Ref.make(0);
          const again = yield* jobs.start(countingWork(runs), keyed);
          return { again, view: yield* jobs.get(started.job_id), runs: yield* Ref.get(runs) };
        }),
      ),
    );
    expect(after.runs).toBe(0);
    expect(after.again).toMatchObject({ job_id: started.job_id, rejoined: true, status: "failed" });
    expect(after.view).toEqual({
      job_id: started.job_id,
      status: "failed",
      error:
        "The server stopped before this job finished. A dispatched website action may have taken effect; this job will not be replayed.",
    });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

it("keeps a failed keyed job's commit marks and confirmation in its record", async () => {
  const folder = await mkdtemp(join(tmpdir(), "opengpt-browser-mcp-jobs-"));
  try {
    const record = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* makeFileJobStore(folder);
          const jobs = yield* makeMcpJobs(1, "run", store);
          const started = yield* jobs.start(
            () =>
              Effect.fail(
                new LocalOperationFailure(
                  "The saved page did not load",
                  {
                    effect: "possible",
                    commits: [{ name: "save", state: "sent" }],
                  },
                  "NoResponse",
                ),
              ),
            keyed,
          );
          yield* finished(jobs, started.job_id);
          return yield* store.get(started.job_id);
        }),
      ),
    );
    expect(record).toMatchObject({
      status: "failed",
      effect: "possible",
      commits: [{ name: "save", state: "sent" }],
      error: "Operation failed (NoResponse).",
    });
    expect(record?.confirmation).toBeUndefined();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

it("keeps a keyed run's outcome and commit marks, and answers them after a restart", async () => {
  const folder = await mkdtemp(join(tmpdir(), "opengpt-browser-mcp-jobs-"));
  try {
    const first = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* makeFileJobStore(folder);
          const jobs = yield* makeMcpJobs(1, "run", store);
          const started = yield* jobs.start(
            () =>
              Effect.fail(
                runOutcomeFailure("write", "operation")(
                  new LocalOperationFailure(
                    "The saved page did not load",
                    { effect: "possible", commits: [{ name: "save", state: "sent" }] },
                    "NoResponse",
                  ),
                ),
              ),
            keyed,
          );
          const view = yield* finished(jobs, started.job_id);
          return { view, record: yield* store.get(started.job_id) };
        }),
      ),
    );
    expect(first.view).toMatchObject({
      status: "failed",
      code: "no_response",
      write_status: "may_have_applied",
      possible_commit: true,
      retry: "new_key",
    });
    expect(first.view.error).toMatch(/read the site back before any retry/u);
    expect(first.record).toMatchObject({
      status: "failed",
      effect: "possible",
      commits: [{ name: "save", state: "sent" }],
      error: first.view.error,
    });
    const after = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const jobs = yield* makeMcpJobs(1, "run", yield* makeFileJobStore(folder));
          const runs = yield* Ref.make(0);
          const again = yield* jobs.start(countingWork(runs), keyed);
          return { again, view: yield* jobs.get(first.view.job_id), runs: yield* Ref.get(runs) };
        }),
      ),
    );
    expect(after.runs).toBe(0);
    expect(after.again).toMatchObject({ rejoined: true, status: "failed" });
    // The stored view answers the outcome the live job did, with no warning added to it.
    expect(after.view).toEqual(first.view);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

it("runs calls without a key from a folder it can't write, and refuses a keyed call there before running it", async () => {
  const folder = await mkdtemp(join(tmpdir(), "opengpt-browser-mcp-jobs-"));
  await chmod(folder, 0o500);
  try {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const jobs = yield* makeMcpJobs(1, "run", yield* makeFileJobStore(join(folder, ".jobs")));
          const runs = yield* Ref.make(0);
          const plain = yield* jobs.start(countingWork(runs));
          const plainView = yield* finished(jobs, plain.job_id);
          const refused = yield* Effect.either(jobs.start(countingWork(runs), keyed));
          return { plainView, refused, runs: yield* Ref.get(runs) };
        }),
      ),
    );
    expect(result.plainView).toMatchObject({ status: "completed", output: { saved: 1 } });
    expect(result.refused._tag).toBe("Left");
    expect(result.runs).toBe(1);
    expect(await readdir(folder)).toEqual([]);
  } finally {
    await chmod(folder, 0o700);
    await rm(folder, { recursive: true, force: true });
  }
});
