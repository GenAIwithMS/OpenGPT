import { solModel } from "../../src/models/models.js";
import { OpenAIProvider, Usage } from "@openai/agents";
import type { ModelResponse } from "@openai/agents";
import OpenAI from "openai";
import { Effect, Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import {
  makeOpenAIMinter,
  mintCompaction,
  mintCompactionThresholdTokens,
} from "../../src/mint/openai.js";
import type { MintDependencies } from "../../src/mint/contracts.js";
import type { MintDiagnostics } from "../../src/mint/diagnostics.js";
import {
  makeMintContinuationFixture,
  readAllow,
  portableJobSession,
} from "../support/mint-fixtures.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it("applies one compaction threshold that does not depend on the SDK model table", () => {
  for (const model of [solModel, "gpt-5.6-sol", "unknown-model"])
    expect(mintCompaction().samplingParams({ model })).toEqual({
      context_management: [
        { type: "compaction", compact_threshold: mintCompactionThresholdTokens },
      ],
    });
});

const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);

const execution = {
  purpose: "example",
  target: "pureFiles",
  entrypoint: "src/tool.ts",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 30,
};

// Asymmetric matchers are typed any; keep them unknown inside expected object literals.
const arrayContaining = (values: readonly unknown[]): unknown =>
  expect.arrayContaining([...values]);

const objectContaining = (value: Readonly<Record<string, unknown>>): unknown =>
  expect.objectContaining(value);

const Json = Schema.Record({ key: Schema.String, value: Schema.Unknown });

const functionCall = (name: string, input: unknown, callId: string) => ({
  type: "function_call" as const,
  name,
  callId,
  arguments: JSON.stringify(input),
  status: "completed" as const,
});

const respond = (...output: ModelResponse["output"]): ModelResponse => ({
  usage: new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
  output,
});

/** The minter ends the attempt blocked, which stops the model at once. */
const blocked = {
  reason: "site_lacks_capability",
  explanation: "The synthetic site offers nothing to read.",
  intent: "End the synthetic attempt.",
};

const reportBlocked = (callId = "blocked_one") => functionCall("report_blocked", blocked, callId);

/** Every executed request and every diagnostic the host emits, for one attempt. */
const recorded = () => {
  const executed: unknown[] = [];
  const emitted: { readonly name: string; readonly details: unknown }[] = [];
  const record: MintDiagnostics["emit"] = (name, details) =>
    Effect.sync(() => {
      emitted.push({ name, details });
    });
  const reviewAndExecute: MintDependencies["reviewAndExecute"] = (input, beforeDispatch) =>
    (beforeDispatch?.(readAllow) ?? Effect.void).pipe(
      Effect.zipRight(
        Effect.sync(() => {
          executed.push(input);
          return {
            executionId: "execution_one",
            status: "completed" as const,
            effect: "verified" as const,
            resultRef: "protected_result",
            observations: { value: "public" },
          };
        }),
      ),
    );
  const overrides: Partial<MintDependencies> = {
    diagnostics: { emit: record, retainModelTranscript: record },
    reviewAndExecute,
  };
  return { executed, emitted, overrides };
};

const terminalTrace = (emitted: readonly { readonly name: string; readonly details: unknown }[]) =>
  emitted.find(
    ({ name, details }) =>
      name === "mint.model" &&
      details !== null &&
      typeof details === "object" &&
      "phase" in details &&
      details.phase === "terminal",
  )?.details;

it("rejects a custom tool call without intent before dispatch while native tools stay exempt", async () => {
  const host = recorded();
  const f = await fixture(
    (_request, index) =>
      [
        respond(functionCall("execute", execution, "call_without_intent")),
        respond(functionCall("exec_command", { cmd: "ls" }, "call_native")),
        respond(reportBlocked()),
      ][index] ?? respond(reportBlocked("blocked_fallback")),
    host.overrides,
  );
  expect(await f.run()).toMatchObject({ build: "incomplete" });
  expect(host.executed.filter((input) => JSON.stringify(input).includes("src/tool.ts"))).toEqual(
    [],
  );
  expect(JSON.stringify(f.requests[1]?.input)).toContain("call_without_intent");
  const toolNames = (f.requests[0]?.tools ?? []).map((entry) =>
    "name" in entry ? entry.name : undefined,
  );
  expect(toolNames).toEqual(arrayContaining(["execute", "finish_build", "request_input"]));
  const schemas = new Map(
    (f.requests[0]?.tools ?? []).flatMap((entry) =>
      entry.type === "function" ? [[entry.name, entry.parameters] as const] : [],
    ),
  );
  for (const name of ["execute", "finish_build", "request_input"])
    expect(schemas.get(name)).toMatchObject({ required: arrayContaining(["intent"]) });
  for (const name of ["read_source", "exec_command"])
    expect(JSON.stringify(schemas.get(name) ?? {})).not.toContain('"intent"');
  // The refused call reached the next request as the model's own history.
  expect(f.requests[1]?.input).toEqual(
    arrayContaining([objectContaining({ type: "function_call", callId: "call_without_intent" })]),
  );
});

it("continues past the former 80-call cutoff across SDK segment ceilings", async () => {
  const host = recorded();
  const f = await fixture(
    (_request, index) =>
      index < 90
        ? respond(
            functionCall(
              "read_source",
              { path: "src/tool.ts", offset: null, limit: null },
              `read_${index}`,
            ),
          )
        : respond(reportBlocked()),
    host.overrides,
    {},
    { segmentTurns: 32 },
  );
  expect(await f.run()).toMatchObject({ build: "incomplete" });
  expect(f.requests).toHaveLength(91);
  expect(terminalTrace(host.emitted)).toBeUndefined();
}, 60_000);

it("stops at the in-memory model-call capacity backstop without a persisted budget", async () => {
  const host = recorded();
  const f = await fixture(
    (_request, index) =>
      respond(
        functionCall(
          "read_source",
          { path: "src/tool.ts", offset: null, limit: null },
          `read_${index}`,
        ),
      ),
    host.overrides,
    {},
    { segmentTurns: 4, modelCallCapacity: 6 },
  );
  expect(await f.run()).toMatchObject({ build: "incomplete" });
  expect(f.requests).toHaveLength(6);
  expect(terminalTrace(host.emitted)).toMatchObject({
    termination: { reason: "model_call_capacity" },
  });
});

/** A real OpenAIProvider over a fake Responses endpoint, recording each request body. */
const responsesProvider = (outputs: readonly unknown[][]) => {
  const bodies: Record<string, unknown>[] = [];
  const provider = new OpenAIProvider({
    openAIClient: new OpenAI({
      apiKey: "synthetic-key",
      maxRetries: 0,
      fetch: async (_url, init) => {
        const parsed: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
        bodies.push(Schema.decodeUnknownSync(Json)(parsed));
        const output = outputs[bodies.length - 1] ?? [];
        return new Response(
          JSON.stringify({
            id: `resp_${bodies.length}`,
            object: "response",
            created_at: 1,
            status: "completed",
            model: solModel,
            output,
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              total_tokens: 2,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 1 },
            },
          }),
          { headers: { "content-type": "application/json", "x-request-id": "req_synthetic" } },
        );
      },
    }),
  });
  return { provider, bodies };
};

it("requests encrypted reasoning and carries it across minter turns through the pinned SDK", async () => {
  const { provider, bodies } = responsesProvider([
    [
      {
        type: "reasoning",
        id: "rs_turn_one",
        summary: [{ type: "summary_text", text: "Read the source first." }],
        encrypted_content: "opaque-encrypted-turn-one",
      },
      {
        type: "function_call",
        id: "fc_one",
        call_id: "read_one",
        name: "read_source",
        arguments: JSON.stringify({ path: "src/tool.ts", offset: null, limit: null }),
        status: "completed",
      },
    ],
    [
      {
        type: "function_call",
        id: "fc_two",
        call_id: "blocked_one",
        name: "report_blocked",
        arguments: JSON.stringify(blocked),
        status: "completed",
      },
    ],
  ]);
  const f = await fixture(() => respond(reportBlocked()), {
    model: makeOpenAIMinter(provider, "medium"),
  });
  try {
    expect(await f.run()).toMatchObject({ build: "incomplete" });
  } finally {
    await provider.close();
  }
  expect(bodies).toHaveLength(2);
  for (const body of bodies) {
    expect(body["include"]).toEqual(["reasoning.encrypted_content"]);
    expect(body["store"]).toBe(false);
    expect(body["reasoning"]).toMatchObject({ summary: "auto" });
  }
  // The second stateless request sends the returned encrypted reasoning back.
  expect(JSON.stringify(bodies[1]?.["input"])).toContain("opaque-encrypted-turn-one");
});
