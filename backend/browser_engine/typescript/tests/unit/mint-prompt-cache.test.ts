import { Usage } from "@openai/agents";
import type { AgentInputItem, ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import type { MintDiagnostics } from "../../src/mint/diagnostics.js";
import {
  mintCompactionLimitTokens,
  mintIdleCompactionTokens,
} from "../../src/mint/idle-compaction.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { makeMintContinuationFixture, readAllow } from "../support/mint-fixtures.js";
import { portableJobSession } from "../support/portable-mint.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);

const usage = (inputTokens: number, cachedTokens = 0) =>
  new Usage({
    requests: 1,
    inputTokens,
    outputTokens: 40,
    totalTokens: inputTokens + 40,
    inputTokensDetails: [{ cached_tokens: cachedTokens, cache_write_tokens: 128 }],
    outputTokensDetails: [{ reasoning_tokens: 30 }],
  });
const call = (
  name: string,
  input: object,
  inputTokens = 2_000,
  callId = name,
  context: "all_turns" | "current_turn" = "all_turns",
): ModelResponse => ({
  usage: usage(inputTokens, 1_024),
  providerData: { reasoning: { context } },
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
const example = {
  purpose: "example",
  target: "pureFiles",
  entrypoint: "src/tool.ts",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 30,
};
const finish = {
  entrypoint: "src/tool.ts",
  executionId: "execution_one",
  metadata: { name: "read_public", description: "Read public data" },
  coverage: "One actual example.",
};
const executed = {
  executionId: "execution_one",
  status: "completed" as const,
  effect: "verified" as const,
  resultRef: "protected_result",
  observations: { value: "public" },
};
const compactedItem = {
  type: "compaction" as const,
  id: "cmp_synthetic",
  encrypted_content: "synthetic-compacted-context",
};
const compacted = (): ModelResponse => ({
  usage: usage(205_000, 204_800),
  output: [compactedItem],
});

/** The Responses API's explicit compaction request ends its input with this item. */
const isCompaction = (request: ModelRequest) => {
  const input = request.input;
  const last = Array.isArray(input) ? input.at(-1) : undefined;
  return last?.type === "unknown" && last.providerData?.type === "compaction_trigger";
};
/** The static prefix every request starts with: the cached developer message. */
const isStaticPrefix = (item: AgentInputItem | undefined) =>
  item?.type === "unknown" &&
  item.providerData?.["type"] === "message" &&
  item.providerData["role"] === "developer";
/** A request's conversation: its input after the static prefix. */
const items = (request: ModelRequest | undefined): AgentInputItem[] => {
  const input = Array.isArray(request?.input) ? request.input : [];
  return isStaticPrefix(input[0]) ? input.slice(1) : input;
};
const turns = (requests: readonly ModelRequest[]) => requests.filter((r) => !isCompaction(r));

const deferred = <A = void>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const settle = () => new Promise<void>((done) => setImmediate(done));

const recordingDiagnostics = () => {
  const events: { name: string; details: unknown }[] = [];
  const record: MintDiagnostics["emit"] = (name, details) =>
    Effect.sync(() => {
      events.push({ name, details });
    });
  const diagnostics: MintDiagnostics = { emit: record, retainModelTranscript: record };
  return { events, diagnostics };
};

it("asks for reasoning from all turns and records the effective context and token counts per call", async () => {
  const { events, diagnostics } = recordingDiagnostics();
  const f = await fixture(
    (_request, index) =>
      index === 0
        ? call("execute", example, 1_200, "execute", "current_turn")
        : call("finish_build", finish, 1_500),
    { diagnostics },
  );
  const outcome = await f.run();

  expect(outcome.build).toBe("published");
  expect(f.requests).toHaveLength(2);
  for (const request of f.requests)
    expect(request.modelSettings.reasoning).toMatchObject({
      effort: "medium",
      context: "all_turns",
    });
  const usageEvents = events.flatMap(({ name, details }) =>
    name === "mint.model" &&
    typeof details === "object" &&
    details !== null &&
    Reflect.get(details, "phase") === "model_usage"
      ? [details]
      : [],
  );
  expect(usageEvents).toEqual([
    expect.objectContaining({
      call: 1,
      purpose: "turn",
      inputTokens: 1_200,
      cachedTokens: 1_024,
      cacheWriteTokens: 128,
      reasoningTokens: 30,
      outputTokens: 40,
      reasoningContext: "current_turn",
    }),
    expect.objectContaining({
      call: 2,
      purpose: "turn",
      inputTokens: 1_500,
      reasoningContext: "all_turns",
    }),
  ]);
});

it("compacts a long history while the minter waits on an execution, without blocking a turn", async () => {
  const order: string[] = [];
  const executionStarted = deferred();
  const compactionReturned = deferred();
  // Each side waits for the other, bounded so a minter that never compacts while it waits
  // finishes the run and fails the assertions instead of hanging.
  const awaitOther = (other: Promise<void>) => Promise.race([other, settle().then(settle)]);
  const f = await fixture(
    async (request, index) => {
      if (isCompaction(request)) {
        order.push("compaction_requested");
        await awaitOther(executionStarted.promise);
        order.push("compaction_returned");
        compactionReturned.resolve();
        return compacted();
      }
      order.push(`turn_${index}`);
      return index === 0
        ? call("execute", example, mintIdleCompactionTokens + 1_000)
        : call("finish_build", finish, 30_000);
    },
    {
      reviewAndExecute: (_input, beforeDispatch = () => Effect.void) =>
        beforeDispatch(readAllow).pipe(
          Effect.zipRight(
            Effect.promise(async () => {
              order.push("execution_started");
              executionStarted.resolve();
              await awaitOther(compactionReturned.promise);
              await settle();
              order.push("execution_finished");
              return executed;
            }),
          ),
        ),
    },
  );
  const outcome = await f.run();

  expect(outcome.build).toBe("published");
  expect(order).toEqual([
    "turn_0",
    "compaction_requested",
    "execution_started",
    "compaction_returned",
    "execution_finished",
    "turn_2",
  ]);
  const [first, next] = turns(f.requests);
  const compaction = f.requests.find(isCompaction);
  // The compaction request is the first turn's request plus the trigger, so it reads that
  // turn's cached prefix.
  expect(items(compaction).slice(0, -1)).toEqual(items(first));
  expect(compaction?.modelSettings).toEqual(first?.modelSettings);
  // Every request, the compaction's included, leads with the same static prefix, ahead of the
  // compaction item once there is one.
  const prefixes = f.requests.map((request) =>
    Array.isArray(request.input) ? JSON.stringify(request.input[0]) : "",
  );
  expect(isStaticPrefix(Array.isArray(next?.input) ? next.input[0] : undefined)).toBe(true);
  expect(new Set(prefixes).size).toBe(1);
  // The next turn sends the compacted window, then everything after the compacted prefix.
  const sent = items(next);
  expect(sent[0]).toMatchObject(compactedItem);
  expect(JSON.stringify(sent)).not.toContain("Read public data");
  expect(sent.slice(1).map((item) => item.type)).toEqual(["function_call", "function_call_result"]);
});

it("sends the next turn uncompacted while a compaction is still running, then applies it", async () => {
  const release = deferred();
  const returned = deferred();
  let executions = 0;
  const f = await fixture(
    async (request) => {
      if (isCompaction(request)) {
        await release.promise;
        returned.resolve();
        return compacted();
      }
      const turn = turns(f.requests).length - 1;
      if (turn === 1) release.resolve();
      return turn === 0
        ? call("execute", example, mintIdleCompactionTokens + 1_000, "execute_1")
        : turn === 1
          ? call("execute", example, mintIdleCompactionTokens + 2_000, "execute_2")
          : call("finish_build", finish, 40_000);
    },
    {
      reviewAndExecute: (_input, beforeDispatch = () => Effect.void) =>
        beforeDispatch(readAllow).pipe(
          Effect.zipRight(
            Effect.promise(async () => {
              executions++;
              if (executions === 2) {
                await Promise.race([returned.promise, settle().then(settle)]);
                await settle();
              }
              return executed;
            }),
          ),
        ),
    },
  );
  const outcome = await f.run();

  expect(outcome.build).toBe("published");
  expect(f.requests.filter(isCompaction)).toHaveLength(1);
  const [first, second, third] = turns(f.requests);
  // The second turn did not wait for the running compaction.
  expect(items(second).slice(0, items(first).length)).toEqual(items(first));
  // The third turn replaces the first turn's input with the compacted window and keeps every
  // later exchange in order.
  const sent = items(third);
  expect(sent[0]).toMatchObject(compactedItem);
  const between = items(second).slice(items(first).length);
  expect(sent.slice(1, 1 + between.length)).toEqual(between);
  expect(
    sent.flatMap((item) => (item.type === "function_call_result" ? [item.callId] : [])),
  ).toEqual(["execute_1", "execute_2"]);
});

// A compaction that lands while a turn is out is applied to the next request. Before then, that
// turn still reports the long input it was sent with, which used to start a second compaction of
// the same old context, whose result the first one's window then made useless.
it("starts no second compaction while a landed one waits for the next request", async () => {
  const release = deferred();
  const f = await fixture(async (request) => {
    if (isCompaction(request)) {
      await release.promise;
      return compacted();
    }
    const turn = turns(f.requests).length - 1;
    if (turn === 1) {
      // The first compaction lands while this turn is out.
      release.resolve();
      await settle();
      await settle();
    }
    return turn === 0
      ? call("execute", example, mintIdleCompactionTokens + 1_000, "execute_1")
      : turn === 1
        ? call("execute", example, mintIdleCompactionTokens + 2_000, "execute_2")
        : call("finish_build", finish, 30_000);
  });
  const outcome = await f.run();

  expect(outcome.build).toBe("published");
  expect(f.requests.filter(isCompaction)).toHaveLength(1);
  const [, , third] = turns(f.requests);
  expect(items(third)[0]).toMatchObject(compactedItem);
});

// A turn that goes out while a compaction runs sends the whole history, so without a bound a few
// such turns could carry a request past the model's long-context price boundary.
it("holds a request near the long-context boundary until the running compaction lands", async () => {
  const order: string[] = [];
  const turnOneReturned = deferred();
  const f = await fixture(async (request) => {
    if (isCompaction(request)) {
      await turnOneReturned.promise;
      await new Promise((done) => setTimeout(done, 20));
      order.push("compaction_returned");
      return compacted();
    }
    const turn = turns(f.requests).length - 1;
    order.push(`turn_${turn}`);
    if (turn === 1) turnOneReturned.resolve();
    return turn === 0
      ? call("execute", example, mintIdleCompactionTokens + 1_000, "execute_1")
      : turn === 1
        ? call("execute", example, mintCompactionLimitTokens - 10, "execute_2")
        : call("finish_build", finish, 30_000);
  });
  const outcome = await f.run();

  expect(outcome.build).toBe("published");
  expect(order).toEqual(["turn_0", "turn_1", "compaction_returned", "turn_2"]);
  const [, , third] = turns(f.requests);
  expect(items(third)[0]).toMatchObject(compactedItem);
});

it("compacts the last request first when one turn alone would carry the next past the limit", async () => {
  const f = await fixture((request) => {
    if (isCompaction(request)) return compacted();
    return turns(f.requests).length === 1
      ? {
          ...call("execute", example, 200_000),
          usage: new Usage({
            requests: 1,
            inputTokens: 200_000,
            outputTokens: mintCompactionLimitTokens - 200_000,
            totalTokens: mintCompactionLimitTokens,
          }),
        }
      : call("finish_build", finish, 30_000);
  });
  const outcome = await f.run();

  expect(outcome.build).toBe("published");
  const [first, second] = turns(f.requests);
  const compaction = f.requests.find(isCompaction);
  expect(items(compaction).slice(0, -1)).toEqual(items(first));
  expect(f.requests.indexOf(compaction as ModelRequest)).toBeLessThan(
    f.requests.indexOf(second as ModelRequest),
  );
  expect(items(second)[0]).toMatchObject(compactedItem);
});

// The provider's own backstop compaction starts the SDK's next input at its compaction item, so
// the input the compacting turn reported no longer describes what the next request sends.
it("starts no compaction of the old history after the provider compacted a turn", async () => {
  const f = await fixture((_request, index) =>
    index === 0
      ? {
          ...call("execute", example, mintCompactionLimitTokens + 8_500),
          output: [compactedItem, ...call("execute", example).output],
        }
      : call("finish_build", finish, 30_000),
  );
  const outcome = await f.run();

  expect(outcome.build).toBe("published");
  expect(f.requests.some(isCompaction)).toBe(false);
  expect(f.requests).toHaveLength(2);
  expect(items(f.requests[1])[0]).toMatchObject(compactedItem);
});

it("leaves a short history to the provider and never compacts it", async () => {
  const f = await fixture((_request, index) =>
    index === 0 ? call("execute", example, 50_000) : call("finish_build", finish, 52_000),
  );
  const outcome = await f.run();
  expect(outcome.build).toBe("published");
  expect(f.requests.some(isCompaction)).toBe(false);
});

const skillCatalog = ["core", "publication", "search"].map((name) => ({
  name,
  description: `Synthetic ${name} skill`,
  content: `Synthetic ${name} rules.`,
}));
const skillPage = (name: string) => `.agents/${name}/SKILL.md`;
const readSource = (path: string, callId: string, inputTokens = 2_000): ModelResponse => ({
  usage: usage(inputTokens, 1_024),
  output: [
    {
      type: "function_call",
      name: "read_source",
      callId,
      arguments: JSON.stringify({ path, offset: null, limit: null, paths: null }),
      status: "completed",
    },
  ],
});
/** A read_source call the host refuses before reading: it names a path and paths together. */
const refusedRead = (path: string, callId: string): ModelResponse => ({
  usage: usage(2_000, 1_024),
  output: [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: `I already read ${skillPage("search")}.` }],
    },
    {
      type: "function_call",
      name: "read_source",
      callId,
      arguments: JSON.stringify({
        path,
        offset: null,
        limit: null,
        paths: [{ path, offset: null, limit: null }],
      }),
      status: "completed",
    },
  ],
});
/** The host's own note in these tests: just the skill names it is given. */
const namesNote = (skills: readonly string[]) => `skills read: ${JSON.stringify(skills)}`;
const noteItems = (request: ModelRequest | undefined) =>
  items(request).filter(
    (item) =>
      item.type === "message" &&
      item.role === "user" &&
      typeof item.content === "string" &&
      item.content.startsWith("skills read: "),
  );
const listedSkills = (request: ModelRequest | undefined): unknown =>
  noteItems(request).map((item) =>
    item.type === "message" && typeof item.content === "string"
      ? JSON.parse(item.content.slice("skills read: ".length))
      : undefined,
  );

it("tells the model after an idle compaction which skills it read, with the same bytes on each later request", async () => {
  const executionStarted = deferred();
  const compactionReturned = deferred();
  const awaitOther = (other: Promise<void>) => Promise.race([other, settle().then(settle)]);
  const f = await fixture(
    async (request) => {
      if (isCompaction(request)) {
        await awaitOther(executionStarted.promise);
        compactionReturned.resolve();
        return compacted();
      }
      const turn = turns(f.requests).length - 1;
      return [
        () => readSource(skillPage("core"), "read_core"),
        // Neither a read the host refused nor the model's own claim is a read.
        () => refusedRead(skillPage("publication"), "read_publication"),
        // A path that is not a skill of the catalog is no skill read, even when it parses as one.
        () => readSource(skillPage("unlisted"), "read_unlisted"),
        () => call("execute", example, mintIdleCompactionTokens + 1_000),
        // Read after the compacted prefix: still in view, so not listed.
        () => readSource(skillPage("search"), "read_search", 30_000),
        () => call("finish_build", finish, 32_000),
      ][turn]!();
    },
    {
      skills: skillCatalog,
      compactionSkillsNote: namesNote,
      reviewAndExecute: (_input, beforeDispatch = () => Effect.void) =>
        beforeDispatch(readAllow).pipe(
          Effect.zipRight(
            Effect.promise(async () => {
              executionStarted.resolve();
              await awaitOther(compactionReturned.promise);
              await settle();
              return executed;
            }),
          ),
        ),
    },
  );
  const outcome = await f.run();

  expect(outcome.build).toBe("published");
  const sent = turns(f.requests);
  expect(sent).toHaveLength(6);
  // Nothing before the compaction carries a note.
  for (const request of sent.slice(0, 4)) expect(noteItems(request)).toEqual([]);
  const [afterCompaction, later] = sent.slice(4);
  // The compacted window is the compaction item, then the note.
  expect(items(afterCompaction)[0]).toMatchObject(compactedItem);
  expect(items(afterCompaction)[1]).toEqual(noteItems(afterCompaction)[0]);
  expect(listedSkills(afterCompaction)).toEqual([["core"]]);
  // The next request keeps the window's bytes, so its cached prefix holds.
  expect(JSON.stringify(items(later).slice(0, 2))).toBe(
    JSON.stringify(items(afterCompaction).slice(0, 2)),
  );
  expect(listedSkills(later)).toEqual([["core"]]);
});

it("names the skills read in the minter's own note when the host gives none", async () => {
  const executionStarted = deferred();
  const compactionReturned = deferred();
  const awaitOther = (other: Promise<void>) => Promise.race([other, settle().then(settle)]);
  const f = await fixture(
    async (request) => {
      if (isCompaction(request)) {
        await awaitOther(executionStarted.promise);
        compactionReturned.resolve();
        return compacted();
      }
      const turn = turns(f.requests).length - 1;
      return [
        () => readSource(skillPage("search"), "read_search"),
        () => readSource(`/workspace/${skillPage("core")}`, "read_core"),
        () => call("execute", example, mintIdleCompactionTokens + 1_000),
        () => call("finish_build", finish, 30_000),
      ][turn]!();
    },
    {
      skills: skillCatalog,
      reviewAndExecute: (_input, beforeDispatch = () => Effect.void) =>
        beforeDispatch(readAllow).pipe(
          Effect.zipRight(
            Effect.promise(async () => {
              executionStarted.resolve();
              await awaitOther(compactionReturned.promise);
              await settle();
              return executed;
            }),
          ),
        ),
    },
  );
  const outcome = await f.run();

  expect(outcome.build).toBe("published");
  const last = items(turns(f.requests).at(-1));
  expect(last[0]).toMatchObject(compactedItem);
  const note = last[1];
  if (note?.type !== "message" || typeof note.content !== "string")
    throw new Error("No note after the compaction");
  expect(note.role).toBe("user");
  expect(note.content).toContain("core");
  expect(note.content).toContain("search");
  expect(note.content).not.toContain("publication");
});

it("inserts the note once after the provider's own compaction and keeps it on each later request", async () => {
  const f = await fixture(
    (_request, index) =>
      [
        () => readSource(skillPage("core"), "read_core"),
        () => refusedRead(skillPage("publication"), "read_publication"),
        // The provider compacted inside this request, below the idle watermark.
        (): ModelResponse => ({
          ...call("execute", example, 5_000),
          output: [compactedItem, ...call("execute", example).output],
        }),
        () => readSource(skillPage("search"), "read_search"),
        () => call("finish_build", finish),
      ][index]!(),
    { skills: skillCatalog, compactionSkillsNote: namesNote },
  );
  const outcome = await f.run();

  expect(outcome.build).toBe("published");
  expect(f.requests.some(isCompaction)).toBe(false);
  expect(f.requests).toHaveLength(5);
  for (const request of f.requests.slice(0, 3)) expect(noteItems(request)).toEqual([]);
  const [afterCompaction, later] = f.requests.slice(3);
  for (const request of [afterCompaction, later]) {
    expect(items(request)[0]).toMatchObject(compactedItem);
    expect(items(request)[1]).toEqual(noteItems(request)[0]);
    // Once: the skills read before the compacting request, not the read after it.
    expect(listedSkills(request)).toEqual([["core"]]);
  }
  expect(JSON.stringify(items(later).slice(0, 2))).toBe(
    JSON.stringify(items(afterCompaction).slice(0, 2)),
  );
});

it("sends no note after a compaction when no skill was read", async () => {
  const f = await fixture(
    (_request, index) =>
      [
        () => readSource("src/tool.ts", "read_tool"),
        () => refusedRead(skillPage("core"), "read_core"),
        (): ModelResponse => ({
          ...call("execute", example, 5_000),
          output: [compactedItem, ...call("execute", example).output],
        }),
        () => call("finish_build", finish),
      ][index]!(),
    { skills: skillCatalog },
  );
  const outcome = await f.run();

  expect(outcome.build).toBe("published");
  const last = items(f.requests.at(-1));
  expect(last[0]).toMatchObject(compactedItem);
  expect(last.slice(1).map((item) => item.type)).toEqual([
    "function_call",
    "function_call_result",
  ]);
});
