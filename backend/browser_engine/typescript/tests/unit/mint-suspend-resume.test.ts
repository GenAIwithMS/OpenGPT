import { Usage } from "@openai/agents";
import type { AgentInputItem, ModelProvider, ModelRequest, ModelResponse } from "@openai/agents";
import { Cause, Deferred, Effect, Exit, Fiber, Runtime } from "effect";
import { afterEach, expect, it } from "vitest";
import { MintFailure, MintServices } from "../../src/mint/contracts.js";
import type {
  AgentInputRequest,
  MintDependencies,
  MintHarnessSnapshot,
  UnansweredQuestion,
} from "../../src/mint/contracts.js";
import { runMint } from "../../src/mint/harness.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import type { MintAgentSnapshot, MintRecoveryFactory } from "../../src/mint/recovery-contracts.js";
import { makeMintContinuationFixture, makeMintHarnessFixture } from "../support/mint-fixtures.js";
import { portableJobSession } from "../support/portable-mint.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const usage = () => new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 });

const prose = (text = "Stopped."): ModelResponse => ({
  usage: usage(),
  output: [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    },
  ],
});

const call = (name: string, input: Record<string, unknown>, callId = name): ModelResponse => ({
  usage: usage(),
  output: [
    {
      type: "function_call",
      name,
      callId,
      arguments: JSON.stringify({ ...input, intent: `Synthetic ${name} purpose` }),
      status: "completed",
    },
  ],
});

const question = { questions: [{ id: "report", type: "text", prompt: "Which public report?" }] };

const execution = {
  purpose: "example",
  target: "pureFiles",
  entrypoint: "src/tool.ts",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 30,
};

const publication = {
  entrypoint: "src/tool.ts",
  executionId: "execution_one",
  metadata: { name: "read_public", description: "Read public data" },
  coverage: "One actual example.",
};

const resumeMessage =
  "This build was paused and its owner resumed it. Inspect the page before continuing.";

/** The minter's script: ask, then run the example and publish once the answer is in. */
const script = (index: number) =>
  [
    call("request_input", question, "ask"),
    call("execute", execution, "run"),
    call("finish_build", publication, "publish"),
  ][index] ?? prose();

/** One scripted model shared by an attempt and the attempt that resumes it. */
const scriptedModel = (respond: (index: number) => ModelResponse) => {
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    getModel: () => ({
      getResponse: async (request) => {
        requests.push(request);
        return respond(requests.length - 1);
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  };
  return { provider, requests };
};

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
              yield* persist({ ...saved, response: JSON.parse(JSON.stringify(response)) });
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
    save: (agent: MintAgentSnapshot, harness: MintHarnessSnapshot) =>
      Effect.sync(() => {
        checkpoints.push({ agent, harness });
      }),
  };
};

const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);

/** Whether a run ended interrupted, with no outcome. */
const interrupted = (error: unknown) =>
  Runtime.isFiberFailure(error) && Cause.isInterruptedOnly(error[Runtime.FiberFailureCauseId]);

const inputOf = (request: ModelRequest | undefined): AgentInputItem[] =>
  Array.isArray(request?.input) ? request.input : [];

const isResumeMessage = (item: AgentInputItem) =>
  "role" in item && item.role === "user" && JSON.stringify(item).includes(resumeMessage);

/**
 * A signed-in build asks a question its owner leaves unanswered, which ends such a build as
 * no_response. With the suspend hook the host suspends it instead, and a later attempt resumes it.
 */
const suspendedBuild = async () => {
  const store = recoveryStore();
  const model = scriptedModel(script);
  const offered: UnansweredQuestion[] = [];
  const finished: string[] = [];
  const first = await fixture(() => prose(), {
    model: makeOpenAIMinter(model.provider, "medium", {}, { recoveryFactory: store.factory() }),
    agentRecovery: { save: store.save },
    websiteCredentialsAvailable: true,
    suspendUnanswered: (unanswered) =>
      Effect.sync(() => {
        offered.push(unanswered);
        return "suspended" as const;
      }),
    attemptFinished: (outcome) =>
      Effect.sync(() => {
        finished.push(outcome);
      }),
  });
  const ended = await first.run().then(
    (outcome) => ({ outcome }),
    (error: unknown) => ({ error }),
  );
  return { store, model, offered, finished, ended, asked: first.asked };
};

it("suspends a build whose unanswered question would end it, recording no outcome", async () => {
  const { store, model, offered, finished, ended, asked } = await suspendedBuild();

  expect("error" in ended && interrupted(ended.error)).toBe(true);
  expect(offered).toEqual([
    { step: "question", requestId: expect.any(String), possibleCommit: false },
  ]);
  expect(finished).toEqual(["interrupted"]);
  expect(asked).toHaveLength(1);
  // The call that asked stays started, with no result, and no later model call was made.
  expect(model.requests).toHaveLength(1);
  const last = store.checkpoints.at(-1);
  expect(last?.agent.tools).toEqual([expect.objectContaining({ callId: "ask", state: "started" })]);
  expect(JSON.stringify(store.checkpoints)).not.toContain("no_response");
  expect(last?.harness.terminal).toBeUndefined();
  expect(last?.harness.noResponse).toBeUndefined();
});

it("resumes a suspended build with the owner's answer, then the host's message, and publishes", async () => {
  const suspended = await suspendedBuild();
  const checkpoint = suspended.store.checkpoints.at(-1);
  if (checkpoint === undefined) throw new Error("No checkpoint");
  const request = suspended.asked[0] as AgentInputRequest;
  const resumed = await fixture(() => prose(), {
    model: makeOpenAIMinter(
      suspended.model.provider,
      "medium",
      {},
      { recoveryFactory: suspended.store.factory(checkpoint.agent) },
    ),
    agentRecovery: {
      save: suspended.store.save,
      initial: { ...checkpoint, resumeMessage },
      // The owner answered while the build was suspended.
      recoverTool: (call) =>
        Effect.succeed(
          call.callId === "ask"
            ? { input: { request, answers: { report: { type: "text", value: "Annual" } } } }
            : undefined,
        ),
    },
    websiteCredentialsAvailable: true,
    suspendUnanswered: () => Effect.die("A resumed build with its answer is not suspended again"),
  });

  expect(await resumed.run()).toMatchObject({
    build: "published",
    publicationRef: "published_revision",
  });
  expect(resumed.counts()).toEqual({ executed: 1, published: 1, asked: 0 });
  // The saved response replayed, so the resumed attempt's first model call is the next one.
  const next = inputOf(suspended.model.requests[1]);
  const answer = next.findIndex(
    (item) => item.type === "function_call_result" && item.callId === "ask",
  );
  expect(JSON.stringify(next[answer])).toContain('\\"status\\":\\"answered\\"');
  expect(JSON.stringify(next[answer])).toContain("Annual");
  // The message follows the answer, as the last item before the model's next turn.
  expect(next.findIndex(isResumeMessage)).toBe(next.length - 1);
  expect(next.findIndex(isResumeMessage)).toBeGreaterThan(answer);
  // It joined the conversation once, and later calls keep it in place.
  expect(inputOf(suspended.model.requests[2]).filter(isResumeMessage)).toHaveLength(1);
});

// A takeover's new process skips the skill install, and its workspace session starts with a
// manifest that lists no skill files, so the instructions' filesystem section used to lose them and
// the first request after the takeover missed the whole cached prefix.
it("sends a resumed build the same static prefix and tools as before the takeover", async () => {
  const suspended = await suspendedBuild();
  const checkpoint = suspended.store.checkpoints.at(-1);
  if (checkpoint === undefined) throw new Error("No checkpoint");
  const request = suspended.asked[0] as AgentInputRequest;
  const resumed = await fixture(() => prose(), {
    model: makeOpenAIMinter(
      suspended.model.provider,
      "medium",
      {},
      { recoveryFactory: suspended.store.factory(checkpoint.agent) },
    ),
    agentRecovery: {
      save: suspended.store.save,
      initial: checkpoint,
      recoverTool: (call) =>
        Effect.succeed(
          call.callId === "ask"
            ? { input: { request, answers: { report: { type: "text", value: "Annual" } } } }
            : undefined,
        ),
    },
    websiteCredentialsAvailable: true,
  });

  expect(await resumed.run()).toMatchObject({ build: "published" });
  const [fresh, ...afterTakeover] = suspended.model.requests;
  expect(afterTakeover.length).toBeGreaterThan(0);
  const prefix = (sent: ModelRequest | undefined) => JSON.stringify(inputOf(sent)[0]);
  expect(prefix(fresh)).toContain(".agents/core");
  for (const sent of afterTakeover) {
    expect(prefix(sent)).toBe(prefix(fresh));
    expect(sent.systemInstructions).toBe(fresh?.systemInstructions);
    expect(JSON.stringify(sent.tools)).toBe(JSON.stringify(fresh?.tools));
  }
});

// Fails when the replay limit assumes the saved turn is in progress: the message would then come
// before the replayed response instead of after its results.
it("puts the host's message after a replayed response whose turn was not in progress", async () => {
  const suspended = await suspendedBuild();
  const checkpoint = suspended.store.checkpoints.at(-1);
  if (checkpoint === undefined) throw new Error("No checkpoint");
  const state = JSON.parse(checkpoint.agent.sdkState) as Record<string, unknown>;
  expect(state.currentTurnInProgress).toBe(true);
  const agent = {
    ...checkpoint.agent,
    sdkState: JSON.stringify({ ...state, currentTurnInProgress: false }),
  };
  const request = suspended.asked[0] as AgentInputRequest;
  const resumed = await fixture(() => prose(), {
    model: makeOpenAIMinter(
      suspended.model.provider,
      "medium",
      {},
      { recoveryFactory: suspended.store.factory(agent) },
    ),
    agentRecovery: {
      save: suspended.store.save,
      initial: { ...checkpoint, agent, resumeMessage },
      recoverTool: (call) =>
        Effect.succeed(
          call.callId === "ask"
            ? { input: { request, answers: { report: { type: "text", value: "Annual" } } } }
            : undefined,
        ),
    },
    websiteCredentialsAvailable: true,
  });

  expect(await resumed.run()).toMatchObject({ build: "published" });
  const next = inputOf(suspended.model.requests[1]);
  const answer = next.findIndex(
    (item) => item.type === "function_call_result" && item.callId === "ask",
  );
  expect(answer).toBeGreaterThan(-1);
  expect(next.findIndex(isResumeMessage)).toBe(next.length - 1);
});

it("tells a minter restored before a model call the host's message first", async () => {
  const suspended = await suspendedBuild();
  // The checkpoint the first attempt saved before its first model call holds no response.
  const checkpoint = suspended.store.checkpoints[0];
  if (checkpoint === undefined || checkpoint.agent.response !== undefined)
    throw new Error("Expected a pre-call checkpoint");
  const model = scriptedModel((index) => script(index + 1));
  const resumed = await fixture(() => prose(), {
    model: makeOpenAIMinter(
      model.provider,
      "medium",
      {},
      { recoveryFactory: suspended.store.factory(checkpoint.agent) },
    ),
    agentRecovery: { save: suspended.store.save, initial: { ...checkpoint, resumeMessage } },
  });

  expect(await resumed.run()).toMatchObject({ build: "published" });
  const first = inputOf(model.requests[0]);
  expect(first.findIndex(isResumeMessage)).toBe(first.length - 1);
  expect(inputOf(model.requests[1]).filter(isResumeMessage)).toHaveLength(1);
});

it("sends a restored minter no message when the host gives none", async () => {
  const suspended = await suspendedBuild();
  const checkpoint = suspended.store.checkpoints[0];
  if (checkpoint === undefined) throw new Error("No checkpoint");
  const model = scriptedModel((index) => script(index + 1));
  const resumed = await fixture(() => prose(), {
    model: makeOpenAIMinter(
      model.provider,
      "medium",
      {},
      { recoveryFactory: suspended.store.factory(checkpoint.agent) },
    ),
    agentRecovery: { save: suspended.store.save, initial: checkpoint },
  });

  expect(await resumed.run()).toMatchObject({ build: "published" });
  // Each request holds only the build's own user messages: its request and its tools message.
  for (const sent of model.requests)
    expect(inputOf(sent).filter((item) => "role" in item && item.role === "user")).toHaveLength(2);
});

it.each<{
  readonly name: string;
  readonly hook?: MintDependencies["suspendUnanswered"];
  readonly cancelled?: true;
  readonly offered: number;
}>([
  { name: "without the hook", offered: 0 },
  {
    name: "when the host does not suspend it",
    hook: () => Effect.succeed("not_suspended" as const),
    offered: 1,
  },
  {
    name: "when the host fails to suspend it",
    hook: () => Effect.fail(new MintFailure({ code: "Unavailable" })),
    offered: 1,
  },
  {
    name: "when the owner cancelled the question",
    hook: () => Effect.succeed("suspended" as const),
    cancelled: true,
    offered: 0,
  },
])("ends the build as no_response $name", async ({ hook, cancelled, offered }) => {
  let offers = 0;
  const f = await fixture((_request, index) => script(index), {
    websiteCredentialsAvailable: true,
    ...(hook === undefined
      ? {}
      : {
          suspendUnanswered: (unanswered) =>
            Effect.sync(() => {
              offers++;
            }).pipe(Effect.zipRight(hook(unanswered))),
        }),
    ...(cancelled
      ? {
          askInput: () =>
            Effect.fail(
              new MintFailure({
                code: "Unavailable",
                noResponse: { possibleCommit: false },
                ownerCancelled: true,
              }),
            ),
        }
      : {}),
  });

  expect(await f.run()).toMatchObject({
    build: "incomplete",
    noResponse: { possibleCommit: false },
  });
  expect(offers).toBe(offered);
  expect(f.counts()).toMatchObject({ executed: 0, published: 0 });
  // The build ended at the question: the minter made no further model call.
  expect(f.requests).toHaveLength(1);
});

it("never offers a question it hands back to the minter as no answer", async () => {
  let offers = 0;
  const f = await fixture((_request, index) => script(index), {
    suspendUnanswered: () =>
      Effect.sync(() => {
        offers++;
        return "suspended" as const;
      }),
  });

  expect(await f.run()).toMatchObject({ build: "published" });
  expect(offers).toBe(0);
});

// Fails when the minter's report on a question handed back ends the build though the host could
// suspend it: the owner's later answer then had no build to resume.
it("offers the host a build its minter ends on a handed-back question, and resumes it with the owner's answer", async () => {
  const report = { reason: "question_unanswered", explanation: "Only the owner knows which one." };
  const givesUp = (index: number) =>
    [
      call("request_input", question, "ask"),
      call("report_blocked", report, "report"),
      call("execute", execution, "run"),
      call("finish_build", publication, "publish"),
    ][index] ?? prose();

  // A host without the hook ends it blocked, as before, and its other hook is never offered it.
  let offers = 0;
  const today = await fixture((_request, index) => givesUp(index), {
    suspendUnanswered: () =>
      Effect.sync(() => {
        offers++;
        return "suspended" as const;
      }),
  });
  expect(await today.run()).toMatchObject({
    build: "incomplete",
    blocked: { reason: "question_unanswered" },
  });
  expect(offers).toBe(0);

  const store = recoveryStore();
  const model = scriptedModel(givesUp);
  const offered: UnansweredQuestion[] = [];
  const first = await fixture(() => prose(), {
    model: makeOpenAIMinter(model.provider, "medium", {}, { recoveryFactory: store.factory() }),
    agentRecovery: { save: store.save },
    suspendHandedBack: (unanswered) =>
      Effect.sync(() => {
        offered.push(unanswered);
        return "suspended" as const;
      }),
  });
  const ended = await first.run().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(interrupted(ended)).toBe(true);
  expect(offered).toEqual([
    { step: "question", requestId: expect.any(String), possibleCommit: false },
  ]);
  const checkpoint = store.checkpoints.at(-1);
  if (checkpoint === undefined) throw new Error("No checkpoint");
  expect(checkpoint.agent.tools).toContainEqual(
    expect.objectContaining({ callId: "report", state: "started" }),
  );
  expect(checkpoint.harness.terminal).toBeUndefined();

  // The owner answered while it was suspended: the report rejoins the answer and the build goes on.
  const request = first.asked[0] as AgentInputRequest;
  const resumed = await fixture(() => prose(), {
    model: makeOpenAIMinter(
      model.provider,
      "medium",
      {},
      { recoveryFactory: store.factory(checkpoint.agent) },
    ),
    agentRecovery: {
      save: store.save,
      initial: checkpoint,
      recoverTool: (recovered) =>
        Effect.succeed(
          recovered.callId === "report"
            ? { input: { request, answers: { report: { type: "text", value: "Annual" } } } }
            : undefined,
        ),
    },
  });
  expect(await resumed.run()).toMatchObject({ build: "published" });
  const rejoined = inputOf(model.requests[2]).find(
    (item) => item.type === "function_call_result" && item.callId === "report",
  );
  expect(JSON.stringify(rejoined)).toContain('\\"status\\":\\"answered\\"');
  expect(JSON.stringify(rejoined)).toContain("Annual");
});

/** A takeover's host rejoins the started question and finds it expired, unanswered. */
const expiredRejoin = () =>
  Effect.fail(new MintFailure({ code: "Unavailable", noResponse: { possibleCommit: false } }));

/**
 * A takeover restores the suspended build's last checkpoint, whose question is still started, and
 * its host's rejoin of that question finds it expired.
 */
const takeover = async (
  suspended: Awaited<ReturnType<typeof suspendedBuild>>,
  overrides: Partial<MintDependencies>,
) => {
  const checkpoint = suspended.store.checkpoints.at(-1);
  if (checkpoint === undefined) throw new Error("No checkpoint");
  return fixture(() => prose(), {
    model: makeOpenAIMinter(
      suspended.model.provider,
      "medium",
      {},
      { recoveryFactory: suspended.store.factory(checkpoint.agent) },
    ),
    agentRecovery: { save: suspended.store.save, initial: checkpoint, recoverTool: expiredRejoin },
    ...overrides,
  });
};

// Fails when a takeover's rejoined question that expired unanswered fails the model run, which
// ends the build with no recorded cause, instead of being offered for a suspension.
it("offers the host a takeover's rejoined question that expired unanswered", async () => {
  const suspended = await suspendedBuild();
  const offered: UnansweredQuestion[] = [];
  const resumed = await takeover(suspended, {
    websiteCredentialsAvailable: true,
    suspendUnanswered: (unanswered) =>
      Effect.sync(() => {
        offered.push(unanswered);
        return "suspended" as const;
      }),
  });

  const ended = await resumed.run().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(interrupted(ended)).toBe(true);
  // The harness never learned the replayed question's id: the host knows which one it rejoined.
  expect(offered).toEqual([{ step: "question", possibleCommit: false }]);
  // The call stays started for the next resume, and no further model call was made.
  expect(suspended.model.requests).toHaveLength(1);
  const last = suspended.store.checkpoints.at(-1);
  expect(last?.agent.tools).toEqual([expect.objectContaining({ callId: "ask", state: "started" })]);
  expect(last?.harness.noResponse).toBeUndefined();
});

const request = {
  mode: "mint",
  intent: "Read public data",
  businessInput: {},
  observations: [],
};

const harnessFixture = makeMintHarnessFixture(cleanups, request, portableJobSession);

it.each<{
  readonly step: UnansweredQuestion["step"];
  readonly overrides: Partial<MintDependencies>;
  readonly expected: UnansweredQuestion;
}>([
  {
    step: "sign_in",
    overrides: {
      reviewAndExecute: () =>
        Effect.fail(
          new MintFailure({ code: "Unavailable", noResponse: { possibleCommit: false } }),
        ),
    },
    expected: { step: "sign_in", possibleCommit: false },
  },
  {
    step: "execution",
    overrides: {
      websiteCredentialsAvailable: true,
      reviewAndExecute: () =>
        Effect.succeed({
          executionId: "asked",
          status: "failed" as const,
          effect: "not_sent" as const,
          noResponse: { possibleCommit: false },
          scriptQuestion: { requestId: "script_question", outcome: "unanswered" as const },
          observations: "The script's question expired unanswered.",
        }),
    },
    expected: {
      step: "execution",
      executionId: "asked",
      requestId: "script_question",
      possibleCommit: false,
    },
  },
])("suspends on a $step question its owner left unanswered", async (variant) => {
  const offered: UnansweredQuestion[] = [];
  let returned = false;
  const signIn = { ...execution, purpose: "authenticate", target: "liveBrowser" };
  const f = await harnessFixture(
    (turn) =>
      turn.actions
        .execute(variant.step === "sign_in" ? signIn : execution)
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              returned = true;
            }),
          ),
          Effect.asVoid,
        ),
    {
      ...variant.overrides,
      suspendUnanswered: (unanswered) =>
        Effect.sync(() => {
          offered.push(unanswered);
          return "suspended" as const;
        }),
    },
  );

  const exit = await Effect.runPromiseExit(
    runMint(request).pipe(Effect.provideService(MintServices, f.dependencies)),
  );
  expect(Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)).toBe(true);
  expect(offered).toEqual([variant.expected]);
  // The call that asked never returns to the minter.
  expect(returned).toBe(false);
});

/** The execution question a signed-in build's example asked and its owner left unanswered. */
const unansweredExample = {
  executionId: "asked",
  status: "failed" as const,
  effect: "not_sent" as const,
  noResponse: { possibleCommit: false },
  observations: "The script's question expired unanswered.",
};

/** An agent checkpoint the scripted model never reads. */
const unreadAgent: MintAgentSnapshot = {
  version: 1,
  sdkVersion: "0.18.0",
  sdkState: "",
  modelCalls: 0,
  finalsWithoutTool: 0,
  tools: [],
};

// Fails when a rejoined execution is recorded beside the entry the suspended attempt's harness
// checkpoint already holds.
it("records a rejoined execution once when the host saved the harness inside its hook", async () => {
  let capture: (() => MintHarnessSnapshot) | undefined;
  let saved: MintHarnessSnapshot | undefined;
  const first = await harnessFixture(
    (turn) => turn.actions.execute(execution).pipe(Effect.asVoid),
    {
      websiteCredentialsAvailable: true,
      reviewAndExecute: () => Effect.succeed(unansweredExample),
      agentRecovery: {
        save: () => Effect.void,
        bindHarness: (bound) =>
          Effect.sync(() => {
            capture = bound;
          }),
      },
      // The host saves the harness state it resumes from as it suspends.
      suspendUnanswered: () =>
        Effect.sync(() => {
          saved = capture?.();
          return "suspended" as const;
        }),
    },
  );
  const suspended = await Effect.runPromiseExit(
    runMint(request).pipe(Effect.provideService(MintServices, first.dependencies)),
  );
  expect(Exit.isFailure(suspended) && Cause.isInterruptedOnly(suspended.cause)).toBe(true);
  if (saved === undefined) throw new Error("No harness saved");

  // The resumed attempt rejoins the call; the owner's answer reached the step meanwhile.
  const { noResponse: _unanswered, ...answered } = unansweredExample;
  const resumed = await harnessFixture(
    (turn) =>
      Effect.asVoid(
        turn.recovery?.recoverTool?.({
          callId: "run",
          name: "execute",
          arguments: JSON.stringify(execution),
          native: false,
        }) ?? Effect.succeed(undefined),
      ),
    {
      websiteCredentialsAvailable: true,
      agentRecovery: {
        save: () => Effect.void,
        initial: { agent: unreadAgent, harness: saved },
        recoverTool: () => Effect.succeed({ execution: { purpose: "example", evidence: answered } }),
      },
    },
  );
  const outcome = await resumed.run();
  expect(outcome.executions.filter((entry) => entry.executionId === "asked")).toHaveLength(1);
});

// Fails when a suspension that arrives after the model run ended is taken: the call that asked
// then never returns, though nothing stops the run any more.
it("ends the question as no_response when the model run ended before the host suspended it", async () => {
  const release = Effect.runSync(Deferred.make<void>());
  let asking: Fiber.RuntimeFiber<string, MintFailure> | undefined;
  const f = await harnessFixture(
    (turn) =>
      // A model whose run ends while its question is still open.
      Effect.forkDaemon(
        turn.actions.requestInput({
          questions: [{ id: "report", type: "text", prompt: "Which public report?" }],
        }),
      ).pipe(
        Effect.tap((fiber) =>
          Effect.sync(() => {
            asking = fiber;
          }),
        ),
        Effect.asVoid,
      ),
    {
      websiteCredentialsAvailable: true,
      suspendUnanswered: () => Deferred.await(release).pipe(Effect.as("suspended" as const)),
    },
  );
  await f.run();
  await Effect.runPromise(Deferred.succeed(release, undefined));
  if (asking === undefined) throw new Error("No question asked");
  const answered = await Effect.runPromise(
    Fiber.join(asking).pipe(Effect.timeout("1 second"), Effect.option),
  );
  expect(answered._tag).toBe("Some");
  expect(JSON.parse(answered._tag === "Some" ? answered.value : "{}")).toMatchObject({
    status: "no_response",
  });
});
