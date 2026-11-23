import { Effect } from "effect";
import { expect, it } from "vitest";
import {
  LocalOperationFailure,
  type LocalOperationJournal,
} from "../../src/execution/local-operation.js";
import { makeMcpJobs } from "../../src/standalone/mcp-jobs.js";
import { runOutcomeFailure } from "../../src/standalone/run-report.js";

/*
 * What a served run's failed job says. A run classifies its failure from its journal, so the job
 * names a finite code, what the write did to the website, whether a step may have committed and
 * how to retry, and only a possible commit is told to read the site back.
 */
const failedJob = (kind: "mint" | "run", error: Error) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* makeMcpJobs(1, kind);
        const started = yield* jobs.start(() => Effect.fail(error));
        let current = yield* jobs.get(started.job_id, 500);
        for (let attempt = 0; attempt < 5 && current.status === "running"; attempt++)
          current = yield* jobs.get(started.job_id, 500);
        return current;
      }),
    ),
  );

const nothingSent: LocalOperationJournal = { effect: "not_sent", commits: [] };
const commitNotEntered: LocalOperationJournal = {
  effect: "possible",
  commits: [{ name: "save", state: "not_sent" }],
};
const confirmedWrite: LocalOperationJournal = {
  effect: "verified",
  confirmation: "message",
  commits: [{ name: "save", state: "confirmed" }],
};
const readBack = "A step may already have changed the website, so read the site back before any retry.";

it.each([
  {
    case: "a refused input before anything was dispatched",
    failure: new LocalOperationFailure(
      "The date must be in the future.",
      nothingSent,
      "InvalidInput",
      "InvalidInput",
    ),
    view: {
      error:
        "The tool or the website refused a value in the input. The date must be in the future. Nothing changed on the website. Correct the input and run it again.",
      code: "input_rejected",
      write_status: "not_attempted",
      possible_commit: false,
      retry: "fix_input",
    },
  },
  {
    case: "a refused input whose declared commit was never entered",
    failure: new LocalOperationFailure(
      "The date must be in the future.",
      commitNotEntered,
      "InvalidInput",
      "InvalidInput",
    ),
    view: {
      error:
        "The tool or the website refused a value in the input. The date must be in the future. Nothing changed on the website. Correct the input and run it again.",
      code: "input_rejected",
      write_status: "not_applied",
      possible_commit: false,
      retry: "fix_input",
    },
  },
  {
    case: "an unanswered question before anything was dispatched",
    failure: new LocalOperationFailure(
      "NoResponse",
      nothingSent,
      "NoResponse",
      "ScriptInputFailure",
    ),
    view: {
      error:
        "The run asked a question that was not answered in time, so it stopped. Nothing changed on the website. Run it again and answer its question.",
      code: "no_response",
      write_status: "not_attempted",
      possible_commit: false,
      retry: "new_key",
    },
  },
  {
    case: "invalid output after a confirmed write",
    failure: new LocalOperationFailure(
      "InvalidOutput",
      confirmedWrite,
      "InvalidOutput",
      "InvalidOutput",
    ),
    view: {
      error:
        "The run's result did not match the tool's output schema. The website confirmed the action, so running the tool again would repeat it. Build the tool again before relying on its result.",
      code: "invalid_output",
      write_status: "applied",
      possible_commit: false,
      retry: "never",
    },
  },
  {
    case: "a script error before anything was dispatched",
    failure: new LocalOperationFailure("Fixture failure", nothingSent),
    view: {
      error:
        "The run did not produce a validated result. Nothing changed on the website. Check the local browser and the tool, then run it again.",
      code: "execution_failed",
      write_status: "not_attempted",
      possible_commit: false,
      retry: "never",
    },
  },
  {
    case: "an expired deadline after a commit was entered",
    failure: new LocalOperationFailure(
      "Local operation deadline expired; execution was not replayed",
      { effect: "possible", commits: [{ name: "save", state: "sent" }] },
    ),
    view: {
      error:
        "The run did not confirm whether its website action took effect, so it may have changed the website. Read the site back before any retry to see whether the action happened, and run the tool again only if it did not.",
      code: "outcome_unknown",
      write_status: "may_have_applied",
      possible_commit: true,
      retry: "never",
    },
  },
])("a write run's job reports $case with its outcome", async ({ failure, view }) => {
  const job = await failedJob("run", runOutcomeFailure("write", "operation")(failure));
  expect(job).toEqual({ job_id: job.job_id, status: "failed", ...view });
});

it("tells a refused input that may have committed to read the site back first", async () => {
  const job = await failedJob(
    "run",
    runOutcomeFailure("write", "operation")(
      new LocalOperationFailure("InvalidInput", {
        effect: "possible",
        commits: [{ name: "save", state: "sent" }],
      }, "InvalidInput"),
    ),
  );
  expect(job).toMatchObject({
    code: "input_rejected",
    write_status: "may_have_applied",
    possible_commit: true,
    error: `The tool or the website refused a value in the input. ${readBack} Then correct the input and run it again.`,
  });
});

it("keeps the warning for a failure no run classified, such as a mint's", async () => {
  const job = await failedJob(
    "mint",
    new LocalOperationFailure("InvalidOutput", confirmedWrite, "InvalidOutput"),
  );
  expect(job).toEqual({
    job_id: job.job_id,
    status: "failed",
    error:
      "Operation failed (InvalidOutput). A dispatched website action may have taken effect; this job will not be replayed.",
  });
});
