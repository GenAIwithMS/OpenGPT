import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { afterEach, expect, it } from "vitest";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import type { ModelObserverFactory } from "../../src/models/model-observer.js";
import { makeMintContinuationFixture, portableJobSession } from "../support/mint-fixtures.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);

const respond = (name: string, input: unknown, callId: string): ModelResponse => ({
  usage: new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
  output: [
    {
      type: "function_call",
      name,
      callId,
      arguments: JSON.stringify(input),
      status: "completed",
    },
  ],
});

const blocked = respond(
  "report_blocked",
  {
    reason: "site_lacks_capability",
    explanation: "The synthetic site offers nothing to read.",
    intent: "End the synthetic attempt.",
  },
  "blocked",
);

interface ObservedTool {
  readonly name: string;
  readonly readPath?: string;
  readonly arguments: string;
  readonly outcome: "returned" | "failed";
}

/**
 * A host observer that records each traced tool dispatch, as a host that counts skill reads sees
 * it: one call per dispatch, with the path it reads and whether the read returned.
 */
const recordingObserver = (afterRead?: (readPath: string) => Promise<void>) => {
  const tools: ObservedTool[] = [];
  const started: string[] = [];
  const observerFactory: ModelObserverFactory = () => ({
    attach: () => undefined,
    tool: async (call, invoke) => {
      const record = {
        name: call.name,
        arguments: call.arguments,
        ...(call.readPath === undefined ? {} : { readPath: call.readPath }),
      };
      if (call.readPath !== undefined) started.push(call.readPath);
      try {
        const result = await invoke();
        tools.push({ ...record, outcome: "returned" });
        if (call.readPath !== undefined) await afterRead?.(call.readPath);
        return result;
      } catch (error) {
        tools.push({ ...record, outcome: "failed" });
        throw error;
      }
    },
    provider: (provider) => provider,
    started: () => undefined,
    skillsInstalled: () => undefined,
    segment: () => undefined,
    completed: () => undefined,
    failed: () => undefined,
    takeNativeCall: () => undefined,
    durabilityFailure: () => undefined,
    terminal: () => ({
      phase: "terminal",
      timing: {
        phase: "terminal",
        sequence: 0,
        occurredAtUtc: new Date().toISOString(),
        occurredMonotonicMs: performance.now(),
        queueMs: 0,
      },
      value: {},
    }),
    flush: async () => undefined,
  });
  return { tools, started, observerFactory };
};

/** Runs the scripted responses, then ends the attempt blocked, recording every model request. */
const scripted = async (
  responses: readonly ModelResponse[],
  afterRead?: (readPath: string) => Promise<void>,
) => {
  const sent: ModelRequest[] = [];
  const observer = recordingObserver(afterRead);
  const f = await fixture(() => blocked, {
    model: makeOpenAIMinter(
      {
        getModel: () => ({
          getResponse: async (request) => {
            sent.push(request);
            return responses[sent.length - 1] ?? blocked;
          },
          getStreamedResponse: () => {
            throw new Error("Unused stream");
          },
        }),
      },
      "medium",
      {},
      { observerFactory: observer.observerFactory },
    ),
  });
  return {
    root: f.workspace.root,
    sent,
    reads: () => observer.tools.filter(({ name }) => name === "read_source"),
    /** Every read whose dispatch began, whether or not it finished. */
    started: () => [...observer.started],
    start: (signal: AbortSignal) => f.run(signal),
    run: async () => expect(await f.run()).toMatchObject({ build: "incomplete" }),
  };
};

/** The JSON a tool call returned, as the next model request carries it. */
const toolResult = (requests: readonly ModelRequest[], callId: string): unknown => {
  const item = requests
    .flatMap((request) => (Array.isArray(request.input) ? request.input : []))
    .find((entry) => entry.type === "function_call_result" && entry.callId === callId);
  const output = item !== undefined && "output" in item ? item.output : undefined;
  const text =
    typeof output === "string"
      ? output
      : typeof output === "object" && output !== null && "text" in output
        ? output.text
        : undefined;
  if (typeof text !== "string") throw new Error(`Missing result of ${callId}`);
  return JSON.parse(text);
};

const skill = ".agents/core/SKILL.md";

it("reads several files in one call, in order, each as its own host read", async () => {
  const f = await scripted([
    respond("read_source", { path: "src/tool.ts", offset: null, limit: null }, "one"),
    respond(
      "read_source",
      {
        path: null,
        offset: null,
        limit: null,
        paths: [
          { path: skill, offset: null, limit: null },
          { path: "src/tool.ts", offset: 7, limit: 7 },
          { path: "src/missing.ts", offset: null, limit: null },
        ],
      },
      "several",
    ),
  ]);
  await f.run();
  const schema = f.sent[0]?.tools?.find((entry) => entry.name === "read_source");
  expect(schema).toMatchObject({
    parameters: {
      properties: {
        path: { type: ["string", "null"] },
        paths: { anyOf: [{ type: "array", minItems: 1, maxItems: 10 }, { type: "null" }] },
      },
      required: ["path", "offset", "limit", "paths"],
    },
  });
  // A call that names one path, recorded before paths existed, reads exactly as before.
  expect(toolResult(f.sent, "one")).toEqual({
    kind: "untrusted_source",
    path: "src/tool.ts",
    source: "export default {};",
    offset: 0,
    total: 18,
    offsetUnit: "UTF-16 code units",
    nextOffset: null,
  });
  expect(toolResult(f.sent, "several")).toEqual({
    kind: "untrusted_sources",
    files: [
      expect.objectContaining({
        kind: "untrusted_source",
        path: skill,
        source: expect.stringContaining("Publish through finish_build"),
        nextOffset: null,
      }),
      {
        kind: "untrusted_source",
        path: "src/tool.ts",
        source: "default",
        offset: 7,
        total: 18,
        offsetUnit: "UTF-16 code units",
        nextOffset: 14,
      },
      expect.objectContaining({
        path: "src/missing.ts",
        status: "tool_failed",
        code: "ScopeDenied",
        instruction: expect.stringContaining("Source read failed."),
      }),
    ],
  });
  // Each file is its own traced read with its own path, so only a read that returned counts.
  expect(f.reads().map(({ readPath, outcome }) => ({ readPath, outcome }))).toEqual([
    { readPath: "src/tool.ts", outcome: "returned" },
    { readPath: skill, outcome: "returned" },
    { readPath: "src/tool.ts", outcome: "returned" },
    { readPath: "src/missing.ts", outcome: "failed" },
  ]);
  expect(JSON.parse(f.reads()[2]?.arguments ?? "{}")).toEqual({
    path: "src/tool.ts",
    offset: 7,
    limit: 7,
  });
});

it("leaves the rest of the files unread once a call's results reach the size limit", async () => {
  const f = await scripted([
    respond(
      "read_source",
      {
        path: null,
        offset: null,
        limit: null,
        paths: [
          { path: "src/tool.ts", offset: null, limit: null },
          { path: "src/large.txt", offset: null, limit: null },
          { path: skill, offset: null, limit: null },
          { path: "src/tool.ts", offset: null, limit: null },
        ],
      },
      "several",
    ),
  ]);
  // A file that starts under the limit reads whole, as a call naming only it would.
  await writeFile(join(f.root, "src/large.txt"), "x".repeat(200_000));
  await f.run();
  expect(toolResult(f.sent, "several")).toEqual({
    kind: "untrusted_sources",
    files: [
      expect.objectContaining({ path: "src/tool.ts", source: "export default {};" }),
      expect.objectContaining({ path: "src/large.txt", total: 200_000, nextOffset: null }),
      { path: skill, status: "not_read", reason: "call_size_limit" },
      { path: "src/tool.ts", status: "not_read", reason: "call_size_limit" },
    ],
  });
  // A file left unread is never read, so it never counts as read.
  expect(f.reads().map(({ readPath }) => readPath)).toEqual(["src/tool.ts", "src/large.txt"]);
});

it("stops a several-file call's reads once the call is cancelled", async () => {
  const controller = new AbortController();
  let running: Promise<unknown> | undefined;
  const settled = () =>
    Promise.race([
      (running ?? Promise.resolve()).then(
        () => undefined,
        () => undefined,
      ),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  const f = await scripted(
    [
      respond(
        "read_source",
        {
          path: null,
          offset: null,
          limit: null,
          paths: [
            { path: "src/tool.ts", offset: null, limit: null },
            { path: skill, offset: null, limit: null },
            { path: "src/tool.ts", offset: 7, limit: 7 },
          ],
        },
        "several",
      ),
    ],
    async (readPath) => {
      if (readPath !== "src/tool.ts" || controller.signal.aborted) return;
      // The run is cancelled while the call's first file is being read.
      controller.abort();
      await settled();
    },
  );
  running = f.start(controller.signal);
  await settled();
  // Give a call that kept going the time to start its next read.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(f.started()).toEqual(["src/tool.ts"]);
});

const skillRead = { path: skill, offset: null, limit: null };

it.each([
  ["both path and paths", { path: "src/tool.ts", paths: [skillRead] }],
  ["neither path nor paths", { path: null, paths: null }],
  ["a top-level range with paths", { path: null, offset: 3, paths: [skillRead] }],
  ["an empty paths list", { path: null, paths: [] }],
  ["more than 10 paths", { path: null, paths: Array.from({ length: 11 }, () => skillRead) }],
])("refuses %s before reading anything", async (_case, request) => {
  const f = await scripted([
    respond("read_source", { offset: null, limit: null, ...request }, "refused"),
  ]);
  await f.run();
  expect(toolResult(f.sent, "refused")).toMatchObject({
    status: "tool_failed",
    code: "InvalidRequest",
  });
  expect(f.reads()).toEqual([]);
});
