import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Usage } from "@openai/agents";
import type { AgentInputItem, ModelProvider, ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { MintFailure } from "../../src/mint/contracts.js";
import type { ExecutionEvidence, MintDependencies } from "../../src/mint/contracts.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { makeOpenAIOutcomeReviewer } from "../../src/mint/outcome-review-openai.js";
import type {
  MinterHistoryArchive,
  OutcomeAssessment,
  OutcomeReviewHost,
  OutcomeReviewSnapshot,
} from "../../src/mint/outcome-review-contracts.js";
import type { MintAgentSnapshot, MintRecoveryFactory } from "../../src/mint/recovery-contracts.js";
import type { MintHarnessSnapshot } from "../../src/mint/contracts.js";
import { makeMintContinuationFixture } from "../support/mint-fixtures.js";
import { portableJobSession } from "../support/portable-mint.js";
import { instructionsOf } from "../support/guardian-requests.js";

// The outcome reviewer through the mint harness: the real minter and the real reviewer, each on
// a scripted model, with a scripted host standing in for Guardian review and execution.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);

const usage = () => new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 });
type Item = ModelResponse["output"][number];
const functionCall = (name: string, input: object, callId = name): Item => ({
  type: "function_call",
  name,
  callId,
  arguments: JSON.stringify(input),
  status: "completed",
});
const message = (text: string): Item => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text }],
});
const respond = (...output: Item[]): ModelResponse => ({ usage: usage(), output });
/** A minter tool call; the harness's own tools carry a declared intent. */
const minter = (name: string, input: object, callId = name) =>
  respond(functionCall(name, { ...input, intent: `Synthetic ${name} purpose` }, callId));

const step = (entrypoint: string, purpose = "act") => ({
  purpose,
  target: "liveBrowser",
  entrypoint,
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 30,
});
const publication = (executionId: string) => ({
  entrypoint: "src/book.ts",
  executionId,
  metadata: { name: "book_table", description: "Book a table" },
  coverage: "One booking made through the session's act step.",
});

/** The reviewer's turn message, from its latest request. */
const turnOf = (request: ModelRequest) => {
  const items = Array.isArray(request.input) ? request.input : [];
  for (const item of [...items].reverse()) {
    if (!("role" in item) || item.role !== "user" || typeof item.content !== "string") continue;
    const parsed: unknown = JSON.parse(item.content);
    const turn: unknown =
      typeof parsed === "object" && parsed !== null
        ? Reflect.get(parsed, "outcome_review_turn")
        : undefined;
    if (typeof turn === "object" && turn !== null)
      return turn as {
        readonly final: boolean;
        readonly unresolvedWrites: readonly { readonly executionId: string }[];
      };
  }
  throw new Error("The reviewer received no turn message");
};
/** The output of the reviewer's tool call `callId`, parsed. */
const toolOutput = (request: ModelRequest, callId: string): Record<string, unknown> => {
  const items = Array.isArray(request.input) ? request.input : [];
  const result = items.find(
    (item) => item.type === "function_call_result" && item.callId === callId,
  );
  if (result === undefined || result.type !== "function_call_result")
    throw new Error(`No result for ${callId}`);
  const output = result.output;
  const text = typeof output === "string" ? output : "text" in output ? String(output.text) : "";
  return JSON.parse(text) as Record<string, unknown>;
};

/** A scripted reviewer model: `respond` answers each request, by its index. */
const scriptedReviewer = (
  respondTo: (request: ModelRequest, index: number) => ModelResponse | Promise<ModelResponse>,
) => {
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    getModel: () => ({
      getResponse: async (request) => {
        requests.push(request);
        return respondTo(request, requests.length - 1);
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  };
  return { provider, requests };
};

/** The outcome review a host supplies, recording what it saves and journals. */
const reviewHost = (provider: ModelProvider, retryDelays?: OutcomeReviewHost["retryDelays"]) => {
  const recorded: OutcomeAssessment[] = [];
  const saved: OutcomeReviewSnapshot[] = [];
  const host: OutcomeReviewHost = {
    model: makeOpenAIOutcomeReviewer({ modelProvider: provider, turnTimeout: "10 seconds" }),
    save: (snapshot) =>
      Effect.sync(() => {
        saved.push(snapshot);
      }),
    recordAssessment: (assessment) =>
      Effect.sync(() => {
        recorded.push(assessment);
      }),
    ...(retryDelays === undefined ? {} : { retryDelays }),
  };
  return { host, recorded, saved };
};

/** A scripted host step that Guardian allowed as `action`, then ran with `evidence`. */
const allowedStep =
  (
    run: (entrypoint: string) => Effect.Effect<ExecutionEvidence, MintFailure>,
    action: (entrypoint: string) => "read" | "write" = () => "write",
  ): MintDependencies["reviewAndExecute"] =>
  (submitted, beforeDispatch = () => Effect.void) =>
    Effect.gen(function* () {
      const entrypoint = submitted.purpose === "command" ? "command" : submitted.entrypoint;
      const label = action(entrypoint);
      yield* beforeDispatch({ reviewId: `review_${entrypoint}`, action: label });
      const evidence = yield* run(entrypoint);
      return {
        ...evidence,
        review: {
          reviewId: `review_${entrypoint}`,
          outcome: "allow" as const,
          rationale: "Synthetic review",
          action: label,
        },
      };
    });

// Fails before the reviewer, when the lost write's result leaves no outcome review and a second
// run of the same step goes to the website again.
it("keeps a write whose result was lost unknown and never runs it again", async () => {
  const reviewer = scriptedReviewer((request, index) =>
    index === 0
      ? respond(
          functionCall("submit_assessment", {
            executionId: turnOf(request).unresolvedWrites[0]?.executionId,
            outcome: "unknown",
            explanation: "The submission's response was lost and nothing reads the booking back.",
            evidence: ["history:2"],
          }),
        )
      : respond(message("Assessed.")),
  );
  const review = reviewHost(reviewer.provider);
  let dispatched = 0;
  const f = await fixture(
    (_request, index) =>
      [
        minter("execute", step("src/book.ts"), "first"),
        minter("execute", step("src/book.ts"), "again"),
      ][index] ?? respond(message("The booking's outcome is unknown.")),
    {
      reviewAndExecute: allowedStep(() =>
        Effect.suspend(() => {
          dispatched++;
          // The booking went out, and its response never came back.
          return Effect.fail(new MintFailure({ code: "Unavailable" }));
        }),
      ),
      outcomeReview: review.host,
    },
    { effect: "write" },
  );
  const outcome = await f.run();

  expect(dispatched).toBe(1);
  expect(toolOutput(f.requests[2] as ModelRequest, "again")).toMatchObject({
    status: "unsupported",
  });
  expect(outcome.writes).toEqual([
    {
      write: expect.objectContaining({ status: "result_lost", entrypoint: "src/book.ts" }),
      status: "may_have_applied",
      assessment: expect.objectContaining({ outcome: "unknown", version: 1 }),
    },
  ]);
  expect(review.recorded).toMatchObject([{ outcome: "unknown" }]);
});

// Fails when a step the host reports as never sent is tracked as a lost write: its resubmission
// is refused as a repeat, and the build ends with a write that may have applied.
it("runs a write step again after the host reports the first submission was never sent", async () => {
  const reviewer = scriptedReviewer(() => respond(message("Nothing to assess.")));
  const review = reviewHost(reviewer.provider);
  const runs: string[] = [];
  const f = await fixture(
    (_request, index) =>
      [
        minter("execute", step("src/book.ts"), "first"),
        minter("execute", step("src/book.ts"), "again"),
        minter("finish_build", publication("booked")),
      ][index] ?? respond(message("Booked.")),
    {
      reviewAndExecute: allowedStep((entrypoint) =>
        Effect.suspend(() => {
          runs.push(entrypoint);
          // The job sandbox's copy of the step did not match the reviewed source, so the host
          // stopped before anything reached the site.
          return runs.length === 1
            ? Effect.fail(
                new MintFailure({
                  code: "Unavailable",
                  reason: "executor_unavailable",
                  execution: {
                    phase: "execute",
                    reason: "invalid_request",
                    dispatch: "not_sent",
                    stage: "operation_files",
                    workspace: {
                      operation: "stage",
                      reason: "digest_mismatch",
                      fileCount: 1,
                      mismatched: ["src/book.ts"],
                    },
                  },
                }),
              )
            : Effect.succeed({
                executionId: "booked",
                status: "completed" as const,
                effect: "possible" as const,
                confirmation: "message",
                resultRef: "booking_result",
                observations: { page: "Table booked." },
              });
        }),
      ),
      outcomeReview: review.host,
    },
    { effect: "write" },
  );
  const outcome = await f.run();

  expect(toolOutput(f.requests[1] as ModelRequest, "first")).toMatchObject({
    status: "execution_unavailable",
  });
  expect(runs).toEqual(["src/book.ts", "src/book.ts"]);
  expect(toolOutput(f.requests[2] as ModelRequest, "again")).toMatchObject({
    executionId: "booked",
    status: "completed",
  });
  // Only the step that ran is a write; the one never sent is no write at all.
  expect(outcome.writes?.map((entry) => entry.write.executionId)).toEqual(["booked"]);
  expect(outcome).toMatchObject({ build: "published" });
});

// Fails when a write's digest follows the host runtime's relative import out of the workspace:
// the workspace refuses that path, so the digest was undefined and a copy of the step under
// another name ran the write again.
it("tracks a write's source by content when it imports the host runtime, and refuses a copy of it", async () => {
  const sdkStep = `import { defineOperation } from "../../runtime/index.js";\nexport default defineOperation;\n`;
  const dispatched: string[] = [];
  const f = await fixture(
    (_request, index) =>
      [
        minter("execute", step("src/book.mjs"), "first"),
        minter("execute", step("src/book-copy.mjs"), "copy"),
        minter("execute", step("src/book-changed.mjs"), "changed"),
      ][index] ?? respond(message("Stopped.")),
    {
      reviewAndExecute: allowedStep((entrypoint) =>
        Effect.sync(() => {
          dispatched.push(entrypoint);
          return {
            executionId: `write_${entrypoint}`,
            status: "completed" as const,
            effect: "possible" as const,
            resultRef: "booking_result",
            observations: { page: "Table booked." },
          };
        }),
      ),
      outcomeReview: reviewHost(scriptedReviewer(() => respond(message("Waiting."))).provider).host,
    },
    { effect: "write" },
  );
  const root = (f.workspace as unknown as { root: string }).root;
  for (const [path, text] of Object.entries({
    "src/book.mjs": sdkStep,
    "src/book-copy.mjs": sdkStep,
    "src/book-changed.mjs": `${sdkStep}// Changed.\n`,
  }))
    await writeFile(join(root, path), text);
  const outcome = await f.run();

  // Each write is tracked with its source's digest, and a changed source has another digest.
  const digests = (outcome.writes ?? []).map(({ write }) => [
    write.entrypoint,
    write.sourceDigest,
  ]);
  expect(digests).toEqual([
    ["src/book.mjs", expect.any(String)],
    ["src/book-changed.mjs", expect.any(String)],
  ]);
  expect(digests[0]?.[1]).not.toBe(digests[1]?.[1]);
  // The copy is the same source, so it is refused as a repeat; the changed source runs.
  expect(dispatched).toEqual(["src/book.mjs", "src/book-changed.mjs"]);
  expect(toolOutput(f.requests[2] as ModelRequest, "copy")).toMatchObject({
    status: "unsupported",
  });
});

/** A build that runs the write step `src/book.ts` twice, with or without an outcome review. */
const repeatedWrite = async (outcomeReview?: OutcomeReviewHost) => {
  let dispatched = 0;
  const f = await fixture(
    (_request, index) =>
      [
        minter("execute", step("src/book.ts"), "first"),
        minter("execute", step("src/book.ts"), "again"),
      ][index] ?? respond(message("Stopped.")),
    {
      reviewAndExecute: allowedStep(() =>
        Effect.sync(() => {
          dispatched++;
          return {
            executionId: "booked",
            status: "completed" as const,
            effect: "possible" as const,
            resultRef: "booking_result",
            observations: { page: "Request received." },
          };
        }),
      ),
      ...(outcomeReview === undefined ? {} : { outcomeReview }),
    },
    { effect: "write" },
  );
  await f.run();
  const refusal = toolOutput(f.requests[2] as ModelRequest, "again");
  return { dispatched, refusal, reason: JSON.stringify(refusal) };
};

// Fails when the refusal tells an agent with no outcome review to wait for one: it can never
// come, so the agent sends the write again through a copy of the step.
it("refuses a repeat for the rest of the attempt when no outcome review runs", async () => {
  const { dispatched, refusal, reason } = await repeatedWrite();

  expect(dispatched).toBe(1);
  expect(refusal).toMatchObject({ status: "unsupported" });
  expect(reason).toMatch(/src\/book\.ts stays refused for the rest of this attempt/u);
  expect(reason).toMatch(/Never run a copy of it/u);
  expect(reason).not.toMatch(
    /until the outcome review|unless its outcome review|review can settle/u,
  );
});

// Fails when the refusal with an outcome review does not say to run the step itself once the
// review finds the write did not happen, so the agent reaches for a copy instead.
it("tells the agent to rerun the write's own step once the outcome review clears it", async () => {
  const review = reviewHost(scriptedReviewer(() => respond(message("Waiting."))).provider);
  const { dispatched, refusal, reason } = await repeatedWrite(review.host);

  expect(dispatched).toBe(1);
  expect(refusal).toMatchObject({ status: "unsupported" });
  expect(reason).toMatch(/until the outcome review finds the earlier write did not happen/u);
  expect(reason).toMatch(/run src\/book\.ts itself again, not a copy/u);
  expect(reason).not.toMatch(/for the rest of this attempt/u);
});

// Fails when the reviewer cannot see minter history from before a compaction: the request the
// minter sends after it no longer carries the confirmation.
it("finds a write's confirmation in minter history from before a compaction", async () => {
  const compacted = Promise.withResolvers<void>();
  const reviewer = scriptedReviewer(async (request, index) => {
    if (index === 0) {
      // The reviewer's first turn starts once the minter's context was compacted.
      await compacted.promise;
      return respond(
        functionCall("search_history", { query: "SYN-1042", limit: 5 }, "search"),
        functionCall("search_history", { query: "[compaction:", limit: 5 }, "compaction"),
      );
    }
    if (index === 1) {
      const found = toolOutput(request, "search") as {
        matches: readonly { offset: number }[];
      };
      return respond(
        functionCall("submit_assessment", {
          executionId: turnOf(request).unresolvedWrites[0]?.executionId,
          outcome: "done",
          explanation: "The booking step's result shows the confirmation number.",
          evidence: found.matches.map((match) => `history:${match.offset}`),
        }),
      );
    }
    return respond(message("Assessed."));
  });
  const review = reviewHost(reviewer.provider);
  const f = await fixture(
    (_request, index) => {
      if (index === 0) return minter("execute", step("src/book.ts"), "book");
      // The provider compacts the context in this turn; later requests start at its item.
      if (index === 1)
        return respond(
          { type: "compaction", id: "cmp_synthetic", encrypted_content: "synthetic-summary" },
          functionCall(
            "execute",
            { ...step("src/notes.ts", "explore"), target: "pureFiles", intent: "Check notes" },
            "notes",
          ),
        );
      if (index === 2) {
        compacted.resolve();
        return minter("finish_build", publication("booking_1"));
      }
      return respond(message("Published."));
    },
    {
      reviewAndExecute: allowedStep(
        (entrypoint) =>
          Effect.succeed(
            entrypoint === "src/book.ts"
              ? {
                  executionId: "booking_1",
                  status: "completed",
                  effect: "possible",
                  resultRef: "booking_result",
                  observations: { page: "Table booked. Confirmation number SYN-1042." },
                }
              : {
                  executionId: "notes_1",
                  status: "completed",
                  effect: "not_sent",
                  observations: { notes: "none" },
                },
          ),
        (entrypoint) => (entrypoint === "src/book.ts" ? "write" : "read"),
      ),
      outcomeReview: review.host,
    },
    { effect: "write" },
  );
  const outcome = await f.run();

  expect(outcome.build).toBe("published");
  // The minter's request after the compaction no longer carries the confirmation.
  expect(JSON.stringify(f.requests[2]?.input)).not.toContain("SYN-1042");
  expect(outcome.writes).toEqual([
    expect.objectContaining({
      status: "applied",
      assessment: expect.objectContaining({ outcome: "done" }),
    }),
  ]);
  // The confirmation it cites comes before the compaction in the minter's history.
  const offsets = (callId: string) =>
    (
      toolOutput(reviewer.requests[1] as ModelRequest, callId) as {
        matches: readonly { offset: number }[];
      }
    ).matches.map((match) => match.offset);
  const [compaction] = offsets("compaction");
  const cited = review.recorded[0]?.evidence.map((reference) => Number(reference.split(":")[1]));
  expect(compaction).toBeDefined();
  expect(cited?.length).toBeGreaterThan(0);
  for (const offset of cited ?? []) expect(offset).toBeLessThan(compaction ?? 0);
});

// Fails when the reviewer is not told that a write's own commit request, answered 2xx or 3xx with
// no error after it, shows the write happened, so it would ask for a readback the write doesn't
// need. A host that lists state-changing requests records each one's response status.
it("settles a write done from its own commit request's status in the step's result", async () => {
  const reviewer = scriptedReviewer((request, index) => {
    if (index === 0)
      return respond(functionCall("search_history", { query: "statuses", limit: 5 }, "search"));
    if (index === 1) {
      const found = toolOutput(request, "search") as {
        matches: readonly { offset: number }[];
      };
      return respond(
        functionCall("submit_assessment", {
          executionId: turnOf(request).unresolvedWrites[0]?.executionId,
          outcome: "done",
          explanation:
            "The save step's own POST on the site's note route returned 201, and the page showed no error after it.",
          evidence: found.matches.map((match) => `history:${match.offset}`),
        }),
      );
    }
    return respond(message("Assessed."));
  });
  const review = reviewHost(reviewer.provider);
  const f = await fixture(
    (_request, index) =>
      [
        minter("execute", step("src/save.ts"), "save"),
        minter("finish_build", publication("save_1")),
      ][index] ?? respond(message("Published.")),
    {
      reviewAndExecute: allowedStep(() =>
        Effect.succeed({
          executionId: "save_1",
          status: "completed",
          effect: "possible",
          resultRef: "save_result",
          observations: {
            page: "Note saved.",
            stateChangingRequests: [
              {
                method: "POST",
                origin: "https://notes.example",
                path: "/notes",
                resourceType: "fetch",
                count: 1,
                statuses: [201],
                unanswered: 0,
              },
            ],
          },
        }),
      ),
      outcomeReview: review.host,
    },
    { effect: "write" },
  );
  const outcome = await f.run();

  expect(outcome.build).toBe("published");
  expect(outcome.writes).toEqual([
    expect.objectContaining({
      status: "applied",
      assessment: expect.objectContaining({ outcome: "done" }),
    }),
  ]);
  // The step's listed status reached the reviewer through the minter's history.
  expect(review.recorded[0]?.evidence.length).toBeGreaterThan(0);
  const instructions = instructionsOf(reviewer.requests[0]);
  expect(instructions).toContain(
    "or the write's commit request: in the step that clicked the final commit control, a request to the site's own origin on the route the session's commit used, listed in that step's stateChangingRequests with a 2xx or 3xx status, and no error after it in its readable response or on the page.",
  );
  // A request the site queued counts, a 200 whose body reports an error is a failed commit, and a
  // commit step with no request settles nothing by itself.
  expect(instructions).toContain(
    "counts only when the step's result shows that body held none. A 200 whose body reports an error, as GraphQL can, does not count as done, and is not_done only when it meets the not_done bar below. A 202, or a 2xx whose body says the work is queued, counts too.",
  );
  expect(instructions).toContain(
    "or a commit step with no commit request recorded, which a websocket or GET commit can explain.",
  );
});

// Fails when a reviewer outage holds the build or invents an outcome for the write.
it("leaves a write unresolved through a reviewer outage, and the build publishes", async () => {
  const reviewer = scriptedReviewer(() => {
    throw new Error("Synthetic provider outage");
  });
  const review = reviewHost(reviewer.provider, ["20 millis"]);
  const f = await fixture(
    (_request, index) =>
      [
        minter("execute", step("src/book.ts"), "book"),
        minter("finish_build", publication("booking_1")),
      ][index] ?? respond(message("Published.")),
    {
      reviewAndExecute: allowedStep(() =>
        Effect.succeed({
          executionId: "booking_1",
          status: "completed",
          effect: "possible",
          confirmation: "message",
          resultRef: "booking_result",
          observations: { page: "Table booked." },
        }),
      ),
      outcomeReview: review.host,
    },
    { effect: "write" },
  );
  const outcome = await f.run();

  expect(outcome.build).toBe("published");
  expect(outcome.writes).toEqual([
    { write: expect.objectContaining({ executionId: "booking_1" }), status: "may_have_applied" },
  ]);
  expect(review.recorded).toEqual([]);
  expect(reviewer.requests.length).toBeGreaterThan(0);
  // The final turn at finish_build ran and failed too; the write stays unresolved in the
  // reviewer's saved state for a host to report.
  expect(review.saved.at(-1)).toMatchObject({ finishRequested: true, assessments: [] });
});

// Fails when the reviewer runs a turn per event, or two turns at once, instead of one turn at a
// time with the events that arrived during a turn coalesced into the next.
it("coalesces the events that arrive during a turn into the next turn", async () => {
  const firstStarted = Promise.withResolvers<void>();
  const firstTurn = Promise.withResolvers<void>();
  const secondTurn = Promise.withResolvers<void>();
  let running = 0;
  let overlapped = false;
  const turns: (readonly unknown[])[] = [];
  const reviewer = scriptedReviewer(async (request) => {
    const turn = turnOf(request) as unknown as { readonly events: readonly unknown[] };
    running++;
    if (running > 1) overlapped = true;
    turns.push(turn.events);
    if (turns.length === 1) {
      firstStarted.resolve();
      await firstTurn.promise;
    } else secondTurn.resolve();
    running--;
    return respond(message("Waiting for a readback."));
  });
  const review = reviewHost(reviewer.provider);
  const f = await fixture(
    async (_request, index) => {
      if (index === 0) return minter("execute", step("src/add-to-cart.ts"), "cart");
      if (index === 1) {
        await firstStarted.promise;
        return minter("execute", step("src/save-draft.ts"), "draft");
      }
      if (index === 2) return minter("execute", step("src/read-cart.ts"), "read");
      if (index === 3) {
        firstTurn.resolve();
        await secondTurn.promise;
      }
      return respond(message("Stopped."));
    },
    {
      reviewAndExecute: allowedStep(
        (entrypoint) =>
          Effect.succeed({
            executionId: entrypoint.replace(/\W/gu, "_"),
            status: "completed",
            effect: "possible",
            resultRef: `${entrypoint}_result`,
            observations: { page: "Done." },
          }),
        (entrypoint) => (entrypoint === "src/read-cart.ts" ? "read" : "write"),
      ),
      outcomeReview: review.host,
    },
    { effect: "write" },
  );
  await f.run();

  expect(overlapped).toBe(false);
  expect(turns.map((events) => events.length)).toEqual([1, 2]);
  expect(turns[1]).toEqual([
    expect.objectContaining({ kind: "write" }),
    expect.objectContaining({ kind: "execution", action: "read" }),
  ]);
});

// Fails when the minter's history from before a compaction lives only in the attempt's memory: a
// takeover restores the run state, which starts at the compaction, and the confirmation is gone.
it("finds a confirmation from before a compaction after a takeover", async () => {
  /** The host's durable archive, which outlives the attempt. */
  const archived: AgentInputItem[] = [];
  const historyArchive: MinterHistoryArchive = {
    append: (offset, items) =>
      Effect.sync(() => {
        archived.splice(offset, items.length, ...structuredClone(items));
      }),
    length: Effect.sync(() => archived.length),
    read: (offset, limit) =>
      Effect.sync(() => structuredClone(archived.slice(offset, offset + limit))),
  };
  /** The host's checkpoints: each saved before a model call, as a recovery store does. */
  const checkpoints: { agent: MintAgentSnapshot; harness: MintHarnessSnapshot }[] = [];
  const recoveryFactory: MintRecoveryFactory = (store) =>
    Effect.succeed({
      model: (state, counters, invoke) =>
        store
          .save({ version: 1, sdkVersion: "0.18.0", sdkState: state(), ...counters, tools: [] })
          .pipe(Effect.zipRight(invoke)),
      tool: (_call, invoke) => invoke,
    });
  const minterRequests: ModelRequest[] = [];
  const minterProvider: ModelProvider = {
    getModel: () => ({
      getResponse: async (request) => {
        minterRequests.push(request);
        const index = minterRequests.length - 1;
        if (index === 0) return minter("execute", step("src/book.ts"), "book");
        // The provider compacts the context; the next segment starts at its item.
        if (index === 1)
          return respond(
            { type: "compaction", id: "cmp_synthetic", encrypted_content: "synthetic-summary" },
            functionCall(
              "execute",
              { ...step("src/notes.ts", "explore"), target: "pureFiles", intent: "Check notes" },
              "notes",
            ),
          );
        // The worker is lost after the new segment's checkpoint.
        if (index === 2) throw new Error("Synthetic worker loss");
        if (index === 3) return minter("finish_build", publication("booking_1"));
        return respond(message("Published."));
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  };
  const minterModel = () =>
    makeOpenAIMinter(minterProvider, "medium", { segmentTurns: 2 }, { recoveryFactory });
  const reviewer = scriptedReviewer((request) => {
    const turn = turnOf(request);
    if (!turn.final) return respond(message("No assessment yet."));
    const items = Array.isArray(request.input) ? request.input : [];
    if (!items.some((item) => item.type === "function_call_result"))
      return respond(functionCall("search_history", { query: "SYN-1042", limit: 5 }, "search"));
    if (!items.some((item) => item.type === "function_call_result" && item.callId === "assess")) {
      const found = toolOutput(request, "search") as { matches: readonly { offset: number }[] };
      return respond(
        functionCall(
          "submit_assessment",
          {
            executionId: turn.unresolvedWrites[0]?.executionId,
            outcome: found.matches.length > 0 ? "done" : "unknown",
            explanation:
              found.matches.length > 0
                ? "The booking step's result shows the confirmation number."
                : "No confirmation is in the history.",
            evidence: found.matches.map((match) => `history:${match.offset}`),
          },
          "assess",
        ),
      );
    }
    return respond(message("Assessed."));
  });
  const review = reviewHost(reviewer.provider);
  const steps = allowedStep(
    (entrypoint) =>
      Effect.succeed(
        entrypoint === "src/book.ts"
          ? {
              executionId: "booking_1",
              status: "completed",
              effect: "possible",
              resultRef: "booking_result",
              observations: { page: "Table booked. Confirmation number SYN-1042." },
            }
          : {
              executionId: "notes_1",
              status: "completed",
              effect: "not_sent",
              observations: { notes: "none" },
            },
      ),
    (entrypoint) => (entrypoint === "src/book.ts" ? "write" : "read"),
  );
  const agentRecovery = {
    save: (agent: MintAgentSnapshot, harness: MintHarnessSnapshot) =>
      Effect.sync(() => {
        checkpoints.push({ agent, harness });
      }),
  };
  const first = await fixture(
    () => respond(message("Unused.")),
    {
      model: minterModel(),
      reviewAndExecute: steps,
      agentRecovery,
      outcomeReview: { ...review.host, historyArchive },
    },
    { effect: "write" },
  );
  await first.run().catch(() => undefined);
  expect(minterRequests).toHaveLength(3);

  // A new worker takes over from the last checkpoint, with the reviewer's saved state.
  const checkpoint = checkpoints.at(-1);
  const reviewState = review.saved.at(-1);
  if (checkpoint === undefined || reviewState === undefined) throw new Error("No checkpoint");
  const second = await fixture(
    () => respond(message("Unused.")),
    {
      model: minterModel(),
      reviewAndExecute: steps,
      agentRecovery: { ...agentRecovery, initial: checkpoint },
      outcomeReview: {
        ...review.host,
        historyArchive,
        initial: reviewState,
      },
    },
    { effect: "write" },
  );
  const outcome = await second.run();

  expect(outcome.build).toBe("published");
  // The restored run state starts at the compaction: the confirmation is not in it.
  expect(JSON.stringify(minterRequests[3]?.input)).not.toContain("SYN-1042");
  expect(outcome.writes).toEqual([
    expect.objectContaining({
      status: "applied",
      assessment: expect.objectContaining({ outcome: "done" }),
    }),
  ]);
});

// Fails when a range the archive could not store shifts every later offset after a takeover, or
// reads as if nothing were missing.
it("marks history the archive could not store as a gap after a takeover, keeping offsets while it still fails", async () => {
  /** The host's durable archive, which outlives the attempt and fails to store throughout. */
  const archived: AgentInputItem[] = [];
  const historyArchive: MinterHistoryArchive = {
    append: () => Effect.fail(new MintFailure({ code: "Unavailable" })),
    length: Effect.sync(() => archived.length),
    read: (offset, limit) =>
      Effect.sync(() => structuredClone(archived.slice(offset, offset + limit))),
  };
  /** The host's checkpoints: each saved before a model call, as a recovery store does. */
  const checkpoints: { agent: MintAgentSnapshot; harness: MintHarnessSnapshot }[] = [];
  const recoveryFactory: MintRecoveryFactory = (store) =>
    Effect.succeed({
      model: (state, counters, invoke) =>
        store
          .save({ version: 1, sdkVersion: "0.18.0", sdkState: state(), ...counters, tools: [] })
          .pipe(Effect.zipRight(invoke)),
      tool: (_call, invoke) => invoke,
    });
  const minterRequests: ModelRequest[] = [];
  const minterProvider: ModelProvider = {
    getModel: () => ({
      getResponse: async (request) => {
        minterRequests.push(request);
        const index = minterRequests.length - 1;
        if (index === 0) return minter("execute", step("src/book.ts"), "book");
        // The provider compacts the context; the next segment starts at its item.
        if (index === 1)
          return respond(
            { type: "compaction", id: "cmp_synthetic", encrypted_content: "synthetic-summary" },
            functionCall(
              "execute",
              { ...step("src/notes.ts", "explore"), target: "pureFiles", intent: "Check notes" },
              "notes",
            ),
          );
        // The worker is lost after the new segment's checkpoint.
        if (index === 2) throw new Error("Synthetic worker loss");
        // After the takeover the provider compacts again, and a final text starts a new segment.
        if (index === 3)
          return respond(
            { type: "compaction", id: "cmp_synthetic_2", encrypted_content: "synthetic-summary" },
            functionCall(
              "execute",
              { ...step("src/notes.ts", "explore"), target: "pureFiles", intent: "Check notes" },
              "notes_again",
            ),
          );
        if (index === 4) return respond(message("Notes checked."));
        if (index === 5) return minter("finish_build", publication("booking_1"));
        return respond(message("Published."));
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  };
  const minterModel = () =>
    makeOpenAIMinter(minterProvider, "medium", { segmentTurns: 2 }, { recoveryFactory });
  const reviewer = scriptedReviewer((request) => {
    const turn = turnOf(request);
    if (!turn.final) return respond(message("No assessment yet."));
    const items = Array.isArray(request.input) ? request.input : [];
    if (!items.some((item) => item.type === "function_call_result"))
      return respond(
        functionCall("search_history", { query: "[compaction:", limit: 5 }, "compaction"),
        functionCall("search_history", { query: "SYN-1042", limit: 5 }, "search"),
        functionCall("read_history", { offset: 0, limit: 2 }, "start"),
      );
    if (!items.some((item) => item.type === "function_call_result" && item.callId === "assess"))
      return respond(
        functionCall(
          "submit_assessment",
          {
            executionId: turn.unresolvedWrites[0]?.executionId,
            outcome: "unknown",
            explanation: "The booking's result is in a part of the history the host lost.",
            evidence: ["history:0"],
          },
          "assess",
        ),
      );
    return respond(message("Assessed."));
  });
  const review = reviewHost(reviewer.provider);
  const steps = allowedStep(
    (entrypoint) =>
      Effect.succeed(
        entrypoint === "src/book.ts"
          ? {
              executionId: "booking_1",
              status: "completed",
              effect: "possible",
              resultRef: "booking_result",
              observations: { page: "Table booked. Confirmation number SYN-1042." },
            }
          : {
              executionId: "notes_1",
              status: "completed",
              effect: "not_sent",
              observations: { notes: "none" },
            },
      ),
    (entrypoint) => (entrypoint === "src/book.ts" ? "write" : "read"),
  );
  const agentRecovery = {
    save: (agent: MintAgentSnapshot, harness: MintHarnessSnapshot) =>
      Effect.sync(() => {
        checkpoints.push({ agent, harness });
      }),
  };
  const first = await fixture(
    () => respond(message("Unused.")),
    {
      model: minterModel(),
      reviewAndExecute: steps,
      agentRecovery,
      outcomeReview: { ...review.host, historyArchive },
    },
    { effect: "write" },
  );
  await first.run().catch(() => undefined);
  expect(minterRequests).toHaveLength(3);

  // A new worker takes over from the last checkpoint, with the reviewer's saved state; the
  // range the first attempt could not store is lost with it, and storing still fails.
  const checkpoint = checkpoints.at(-1);
  const reviewState = review.saved.at(-1);
  if (checkpoint === undefined || reviewState === undefined) throw new Error("No checkpoint");
  const second = await fixture(
    () => respond(message("Unused.")),
    {
      model: minterModel(),
      reviewAndExecute: steps,
      agentRecovery: { ...agentRecovery, initial: checkpoint },
      outcomeReview: {
        ...review.host,
        historyArchive,
        initial: reviewState,
      },
    },
    { effect: "write" },
  );
  const outcome = await second.run();

  expect(outcome.build).toBe("published");
  // The restored run state starts at the compaction, at the checkpoint's history offset.
  const start = checkpoint.agent.historyOffset ?? 0;
  expect(start).toBeGreaterThan(0);
  const final = reviewer.requests.at(-2) as ModelRequest;
  const offsets = (callId: string) =>
    (toolOutput(final, callId) as { matches: readonly { offset: number }[] }).matches.map(
      (match) => match.offset,
    );
  const compactions = offsets("compaction");
  expect(compactions).toHaveLength(2);
  expect(compactions[0]).toBe(start);
  // The second compaction's range is only buffered, and still reads at its own offsets.
  expect(compactions[1]).toBeGreaterThan(start);
  expect(offsets("search")).toEqual([]);
  const read = toolOutput(final, "start") as {
    total: number;
    items: readonly { offset: number; text: string }[];
  };
  expect(read.items.map((item) => item.offset)).toEqual([0, 1]);
  for (const item of read.items) expect(item.text).toContain("history gap");
  expect(outcome.diagnostics.some((entry) => entry.includes("history_archive_gap"))).toBe(true);
});

/**
 * A recovery store as a host keeps one: a checkpoint before each model call and around each tool
 * call. Restored from `initial`, it replays the saved response and rejoins a tool call that
 * started but never returned through the host's `recoverTool`.
 */
const recoveryStore = () => {
  const checkpoints: { agent: MintAgentSnapshot; harness: MintHarnessSnapshot }[] = [];
  const factory =
    (initial?: MintAgentSnapshot): MintRecoveryFactory =>
    (store) =>
      Effect.sync(() => {
        let replay = initial?.response;
        let current: MintAgentSnapshot | undefined = initial;
        const persist = (next: MintAgentSnapshot) =>
          Effect.suspend(() => {
            current = next;
            return store.save(next);
          });
        const tools = () => current?.tools ?? [];
        return {
          model: (state, counters, invoke) =>
            Effect.gen(function* () {
              if (replay !== undefined) {
                const response = replay as ModelResponse;
                replay = undefined;
                return response;
              }
              const saved: MintAgentSnapshot = {
                version: 1,
                sdkVersion: "0.18.0",
                sdkState: state(),
                ...counters,
                tools: [],
              };
              yield* persist(saved);
              const response = yield* invoke;
              yield* persist({ ...saved, response });
              return response;
            }),
          tool: (call, invoke) =>
            Effect.gen(function* () {
              const prior = tools().find((entry) => entry.callId === call.callId);
              const returned = (result: unknown) =>
                persist({
                  ...(current as MintAgentSnapshot),
                  tools: [
                    ...tools().filter((entry) => entry.callId !== call.callId),
                    { ...call, state: "returned", result },
                  ],
                }).pipe(Effect.as(result));
              if (prior?.state === "returned") return prior.result;
              if (prior?.state === "started") {
                const recovered = yield* store.recoverTool?.(call) ?? Effect.succeed(undefined);
                if (recovered === undefined)
                  return yield* Effect.fail(new MintFailure({ code: "Unavailable" }));
                return yield* returned(recovered.result);
              }
              yield* persist({
                ...(current as MintAgentSnapshot),
                tools: [...tools(), { ...call, state: "started" }],
              });
              return yield* returned(yield* invoke);
            }),
        };
      });
  return {
    checkpoints,
    factory,
    agentRecovery: {
      save: (agent: MintAgentSnapshot, harness: MintHarnessSnapshot) =>
        Effect.sync(() => {
          checkpoints.push({ agent, harness });
        }),
    },
  };
};

/** A minter on `provider` whose recovery is `store`'s, restored from `initial` when given. */
const recoverableMinter = (
  provider: ModelProvider,
  store: ReturnType<typeof recoveryStore>,
  initial?: MintAgentSnapshot,
) => makeOpenAIMinter(provider, "medium", {}, { recoveryFactory: store.factory(initial) });

/** A scripted minter model that answers with `respond`, by its request index. */
const scriptedMinter = (respondTo: (index: number) => ModelResponse | Promise<ModelResponse>) => {
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    getModel: () => ({
      getResponse: async (request) => {
        requests.push(request);
        return respondTo(requests.length - 1);
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  };
  return { provider, requests };
};

/** A booking whose result the host's journal holds, labelled a write by Guardian. */
const bookingEvidence: ExecutionEvidence = {
  executionId: "booking_1",
  status: "completed",
  effect: "possible",
  resultRef: "booking_result",
  observations: { page: "Table booked." },
  review: {
    reviewId: "review_src/book.ts",
    outcome: "allow",
    rationale: "Synthetic review",
    action: "write",
  },
};

// Fails when a write recovered after a takeover is tracked without its entrypoint: its result was
// never checkpointed, and the restored minter's repeat of the same step runs it again.
it("refuses a repeat of a write whose result a takeover recovered", async () => {
  const store = recoveryStore();
  let dispatched = 0;
  const minterModel = scriptedMinter((index) =>
    index === 0
      ? minter("execute", step("src/book.ts"), "first")
      : index === 1
        ? minter("execute", step("src/book.ts"), "again")
        : respond(message("Stopped.")),
  );
  const stopped = new AbortController();
  const first = await fixture(
    () => respond(message("Unused.")),
    {
      model: recoverableMinter(minterModel.provider, store),
      // The booking goes out, and the worker is lost before its result is checkpointed.
      reviewAndExecute: allowedStep(() =>
        Effect.suspend(() => {
          dispatched++;
          return Effect.never;
        }),
      ),
      agentRecovery: store.agentRecovery,
      outcomeReview: reviewHost(scriptedReviewer(() => respond(message("Waiting."))).provider).host,
    },
    { effect: "write" },
  );
  const lost = first.run(stopped.signal).catch(() => undefined);
  await expect.poll(() => dispatched).toBe(1);

  const checkpoint = store.checkpoints.at(-1);
  if (checkpoint === undefined) throw new Error("No checkpoint");
  const second = await fixture(
    () => respond(message("Unused.")),
    {
      model: recoverableMinter(minterModel.provider, store, checkpoint.agent),
      reviewAndExecute: allowedStep(() =>
        Effect.sync(() => {
          dispatched++;
          return bookingEvidence;
        }),
      ),
      agentRecovery: {
        ...store.agentRecovery,
        initial: checkpoint,
        // The host's journal holds the booking's result.
        recoverTool: () =>
          Effect.succeed({ execution: { purpose: "act", evidence: bookingEvidence } }),
      },
      outcomeReview: reviewHost(scriptedReviewer(() => respond(message("Waiting."))).provider).host,
    },
    { effect: "write" },
  );
  const outcome = await second.run();
  stopped.abort();
  await lost;

  expect(dispatched).toBe(1);
  expect(toolOutput(minterModel.requests.at(-1) as ModelRequest, "again")).toMatchObject({
    status: "unsupported",
  });
  expect(outcome.writes).toEqual([
    expect.objectContaining({
      write: expect.objectContaining({ executionId: "booking_1", entrypoint: "src/book.ts" }),
    }),
  ]);
});

// Fails when only the reviewer's own best-effort save tracks a write: that save failed, so after a
// takeover the write is untracked and its repeat runs.
it("tracks a write across a takeover when the reviewer's save failed", async () => {
  const store = recoveryStore();
  let dispatched = 0;
  let takenOver = false;
  const minterModel = scriptedMinter(async (index) => {
    if (index === 0) return minter("execute", step("src/book.ts"), "first");
    // The worker is lost while it waits for its next model response.
    if (!takenOver) return new Promise<never>(() => undefined);
    if (index <= 2) return minter("execute", step("src/book.ts"), "again");
    return respond(message("Stopped."));
  });
  const failingReview = () => {
    const review = reviewHost(scriptedReviewer(() => respond(message("Waiting."))).provider);
    return {
      ...review.host,
      save: () => Effect.fail(new MintFailure({ code: "Unavailable" })),
    } satisfies OutcomeReviewHost;
  };
  const book = allowedStep(() =>
    Effect.sync(() => {
      dispatched++;
      return bookingEvidence;
    }),
  );
  const stopped = new AbortController();
  const first = await fixture(
    () => respond(message("Unused.")),
    {
      model: recoverableMinter(minterModel.provider, store),
      reviewAndExecute: book,
      agentRecovery: store.agentRecovery,
      outcomeReview: failingReview(),
    },
    { effect: "write" },
  );
  const lost = first.run(stopped.signal).catch(() => undefined);
  await expect.poll(() => minterModel.requests.length).toBe(2);

  takenOver = true;
  const checkpoint = store.checkpoints.at(-1);
  if (checkpoint === undefined) throw new Error("No checkpoint");
  const second = await fixture(
    () => respond(message("Unused.")),
    {
      model: recoverableMinter(minterModel.provider, store, checkpoint.agent),
      reviewAndExecute: book,
      agentRecovery: { ...store.agentRecovery, initial: checkpoint },
      outcomeReview: failingReview(),
    },
    { effect: "write" },
  );
  const outcome = await second.run();
  stopped.abort();
  await lost;

  expect(dispatched).toBe(1);
  expect(outcome.writes).toEqual([
    expect.objectContaining({
      write: expect.objectContaining({ executionId: "booking_1" }),
      status: "may_have_applied",
    }),
  ]);
});
