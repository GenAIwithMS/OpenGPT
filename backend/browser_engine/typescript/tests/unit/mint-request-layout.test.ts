import { OpenAIProvider } from "@openai/agents";
import { Effect } from "effect";
import OpenAI from "openai";
import { afterEach, expect, it } from "vitest";
import type { MintDiagnostics } from "../../src/mint/diagnostics.js";
import type { MintDependencies } from "../../src/mint/contracts.js";
import { makeOpenAIMinter, prewarmMinterPrefix } from "../../src/mint/openai.js";
import { solModel } from "../../src/models/models.js";
import { makeMintContinuationFixture, portableJobSession } from "../support/mint-fixtures.js";

/*
 * The Responses request body the minter sends, as the provider receives it. Every job of a
 * release shares one prefix in the provider's prompt cache: the tools, then a developer message
 * holding the instructions and the host's static context, which ends at a 12-hour breakpoint.
 * What differs per job comes after it, and which tools a job may call is its tool_choice, which is
 * not part of the prefix.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);

type Body = Record<string, unknown> & { readonly input: readonly Record<string, unknown>[] };
type WireItem = Record<string, unknown>;

const usage = {
  input_tokens: 9_000,
  output_tokens: 40,
  total_tokens: 9_040,
  input_tokens_details: {
    cached_tokens: 6_000,
    cache_write_tokens: 2_500,
    cache_write_tokens_details: { ttl_30m_tokens: 500, ttl_12h_tokens: 2_000 },
  },
  output_tokens_details: { reasoning_tokens: 30 },
};

const functionCall = (name: string, args: object, callId = name): WireItem => ({
  type: "function_call",
  id: `fc_${callId}`,
  call_id: callId,
  name,
  arguments: JSON.stringify({ ...args, intent: `Synthetic ${name} purpose` }),
  status: "completed",
});

const blocked = functionCall("report_blocked", {
  reason: "site_lacks_capability",
  explanation: "The synthetic site offers nothing to read.",
});

/** An execute call as strict mode makes the model send it: every optional field present, null. */
const strictExample = {
  purpose: "example",
  target: "pureFiles",
  loginUrl: null,
  entrypoint: "src/tool.ts",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 30,
  testInput: null,
  signInStep: null,
  cardFillStep: null,
  exampleInput: null,
};

/** The real Responses client, answering each request from `script`, with each body captured. */
const wireProvider = (
  script: (index: number) => readonly WireItem[],
  responseFields: (index: number) => object = () => ({}),
) => {
  const bodies: Body[] = [];
  const client = new OpenAI({
    apiKey: "synthetic-key",
    maxRetries: 0,
    fetch: async (_url, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Body;
      bodies.push(body);
      return new Response(
        JSON.stringify({
          id: `resp_${bodies.length}`,
          object: "response",
          created_at: 1,
          status: "completed",
          model: solModel,
          output: script(bodies.length - 1),
          usage,
          ...responseFields(bodies.length - 1),
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  return { bodies, provider: new OpenAIProvider({ openAIClient: client }) };
};

/** A minter whose provider is the real Responses client, with each request body captured. */
const wireMinter = (
  script: (index: number) => readonly WireItem[],
  responseFields?: (index: number) => object,
) => {
  const { bodies, provider } = wireProvider(script, responseFields);
  return { bodies, model: makeOpenAIMinter(provider) };
};

/** A host with CAPTCHA telemetry and browser recovery, two tools a host may offer. */
const optionalTools = {
  captchaState: {
    read: () => Effect.succeed({ detected: false }),
    limit: 3,
    exhausted: { exhausted: true },
  },
  requestBrowserRecovery: () => Effect.die("The model never asks for a new browser here"),
} satisfies Partial<MintDependencies>;

const staticContext = ["Synthetic static reference A.", "Synthetic static reference B."];

const allowedNames = (body: Body | undefined) => {
  const choice = body?.["tool_choice"] as { tools?: { name?: string; type: string }[] } | undefined;
  return choice?.tools?.map((tool) => tool.name ?? tool.type);
};

/** The function call results a request carries, by call ID. */
const results = (body: Body | undefined) =>
  new Map(
    (body?.input ?? []).flatMap((item) =>
      item["type"] === "function_call_output"
        ? [[String(item["call_id"]), String(item["output"])] as const]
        : [],
    ),
  );

/** One job's first request body. */
const firstBody = async (
  host: Partial<MintDependencies>,
  request: Parameters<typeof fixture>[2] = {},
) => {
  const wire = wireMinter(() => [blocked]);
  const f = await fixture(() => Promise.reject(new Error("Unused")), { ...host, model: wire.model }, request);
  await f.run();
  expect(wire.bodies).toHaveLength(1);
  return wire.bodies[0] as Body;
};

it("starts every job's request with the same tools and static prefix, ending at a 12-hour breakpoint", async () => {
  const plain = await firstBody({ staticContext });
  const other = await firstBody(
    { staticContext, autofillSignIn: true, ...optionalTools },
    { mode: "maintenance", siteOrigin: "https://other.example.com" },
  );

  for (const body of [plain, other]) {
    // The instructions travel in the cached developer message, not the top-level field.
    expect(body["instructions"]).toBeUndefined();
    expect(body["prompt_cache_options"]).toEqual({ mode: "implicit" });
    const [prefix] = body.input;
    expect(prefix).toMatchObject({ type: "message", role: "developer" });
    const parts = prefix?.["content"] as { text: string; prompt_cache_breakpoint?: unknown }[];
    expect(parts.map((part) => part.text).slice(1)).toEqual(staticContext);
    expect(parts[0]?.text).toContain("Synthetic instructions.");
    // Only the last part carries the breakpoint, so it covers the instructions and the context.
    expect(parts.map((part) => part.prompt_cache_breakpoint)).toEqual([
      undefined,
      undefined,
      { mode: "explicit", ttl: "12h" },
    ]);
  }
  // Two different jobs: the same bytes up to and including the breakpoint item.
  expect(JSON.stringify(other.input[0])).toBe(JSON.stringify(plain.input[0]));
  expect(JSON.stringify(other["tools"])).toBe(JSON.stringify(plain["tools"]));
  // What differs is after it: the job's request, and the tools message saying what it offers.
  expect(JSON.stringify(other.input.slice(1))).not.toBe(JSON.stringify(plain.input.slice(1)));
  expect(allowedNames(plain)).not.toContain("captcha_state");
  expect(allowedNames(other)).toEqual(expect.arrayContaining(["captcha_state", "request_browser_recovery"]));
  for (const body of [plain, other])
    expect(allowedNames(body)).toEqual(
      expect.arrayContaining(["read_source", "execute", "finish_build", "apply_patch", "exec_command"]),
    );
  const toolsMessage = (body: Body) =>
    JSON.parse(String(body.input[2]?.["content"])) as {
      hostTools: { offered: string[]; notOffered: string[]; signIn: string };
    };
  expect(toolsMessage(plain).hostTools).toMatchObject({ signIn: "managed" });
  expect(toolsMessage(plain).hostTools.notOffered).toContain("captcha_state");
  expect(toolsMessage(other).hostTools).toMatchObject({ signIn: "host_autofill" });
  expect(toolsMessage(other).hostTools.offered).toContain("captcha_state");
});

it("refuses a tool the build does not offer and a signInStep on a managed sign-in, running nothing", async () => {
  const wire = wireMinter(
    (index) =>
      [
        [functionCall("captcha_state", {}, "captcha")],
        [
          functionCall(
            "execute",
            {
              ...strictExample,
              purpose: "authenticate",
              target: "liveBrowser",
              loginUrl: "https://example.com/login",
              signInStep: { signedIn: { selector: "role=link[name=\"Sign out\"]", urlPath: null, openPath: null } },
            },
            "sign_in",
          ),
        ],
        [blocked],
      ][index] ?? [blocked],
  );
  const f = await fixture(() => Promise.reject(new Error("Unused")), {
    model: wire.model,
    reviewAndExecute: () => Effect.die("A refused call never reaches review"),
  });
  await f.run();

  expect(wire.bodies).toHaveLength(3);
  expect(JSON.parse(results(wire.bodies[1]).get("captcha") ?? "{}")).toMatchObject({
    status: "tool_failed",
    reason: "tool_not_offered",
    effect: "not_sent",
  });
  expect(JSON.parse(results(wire.bodies[2]).get("sign_in") ?? "{}")).toMatchObject({
    status: "tool_failed",
    reason: "sign_in_step_not_offered",
    effect: "not_sent",
  });
  expect(f.counts().executed).toBe(0);
});

it("runs an execute call sent in strict form, with null for each absent field", async () => {
  const wire = wireMinter(
    (index) =>
      [
        [functionCall("execute", strictExample, "run")],
        [
          functionCall("finish_build", {
            entrypoint: "src/tool.ts",
            executionId: "execution_one",
            metadata: { name: "read_public", description: "Read public data" },
            coverage: "One actual example.",
          }),
        ],
      ][index] ?? [blocked],
  );
  const f = await fixture(() => Promise.reject(new Error("Unused")), { model: wire.model });
  const outcome = await f.run();

  expect(f.counts().executed).toBe(1);
  expect(JSON.parse(results(wire.bodies[1]).get("run") ?? "{}")).toMatchObject({
    status: "completed",
  });
  expect(outcome.build).toBe("published");
});

it("keeps the static prefix first, ahead of the compaction item, after the provider compacts", async () => {
  const compaction = { type: "compaction", id: "cmp_wire", encrypted_content: "synthetic-compacted" };
  const wire = wireMinter(
    (index) =>
      [
        [compaction, functionCall("read_source", { path: "src/tool.ts", offset: null, limit: null, paths: null }, "read")],
        [blocked],
      ][index] ?? [blocked],
  );
  const f = await fixture(() => Promise.reject(new Error("Unused")), { model: wire.model, staticContext });
  await f.run();

  const [before, after] = wire.bodies;
  expect(after?.input[1]).toMatchObject({ type: "compaction", id: "cmp_wire" });
  expect(JSON.stringify(after?.input[0])).toBe(JSON.stringify(before?.input[0]));
  expect(JSON.stringify(after?.["tools"])).toBe(JSON.stringify(before?.["tools"]));
});

it("reports each call's cache writes split by lifetime", async () => {
  const events: unknown[] = [];
  const record: MintDiagnostics["emit"] = (name, details) =>
    Effect.sync(() => {
      if (name === "mint.model") events.push(details);
    });
  const wire = wireMinter(() => [blocked]);
  const f = await fixture(() => Promise.reject(new Error("Unused")), {
    model: wire.model,
    diagnostics: { emit: record, retainModelTranscript: record },
  });
  await f.run();

  expect(events).toContainEqual(
    expect.objectContaining({
      phase: "model_usage",
      inputTokens: 9_000,
      cachedTokens: 6_000,
      cacheWriteTokens: 2_500,
      cacheWrite30mTokens: 500,
      cacheWrite12hTokens: 2_000,
    }),
  );
});

it("prewarms the exact static prefix a job sends, with the job's prompt cache key", async () => {
  const promptCacheKey = "synthetic-environment";
  const job = await firstBody({ staticContext, promptCacheKey });
  const prewarm = wireProvider(() => []);
  const counts = await Effect.runPromise(
    prewarmMinterPrefix(
      {
        // The settings the continuation fixture gives each job.
        instructions: "Synthetic instructions.",
        skills: [
          {
            name: "core",
            description: "Synthetic test contract",
            content: "Publish through finish_build or request legitimate missing input.",
          },
        ],
        staticContext,
        promptCacheKey,
      },
      prewarm.provider,
    ),
  );

  expect(prewarm.bodies).toHaveLength(1);
  const [body] = prewarm.bodies;
  expect(body?.["prompt_cache_options"]).toEqual({ mode: "implicit", prewarm: true });
  expect(job["prompt_cache_options"]).toEqual({ mode: "implicit" });
  expect(body?.["prompt_cache_key"]).toBe(promptCacheKey);
  expect(job["prompt_cache_key"]).toBe(promptCacheKey);
  // The prefix alone, the same in every byte as the job's, behind the same tools and settings.
  expect(body?.input).toHaveLength(1);
  expect(JSON.stringify(body?.input[0])).toBe(JSON.stringify(job.input[0]));
  expect(JSON.stringify(body?.["tools"])).toBe(JSON.stringify(job["tools"]));
  for (const field of ["model", "reasoning", "include", "parallel_tool_calls", "store"])
    expect(body?.[field]).toEqual(job[field]);
  expect(counts).toMatchObject({ cacheWriteTokens: 2_500, cacheWrite12hTokens: 2_000 });
});

it("sends no prompt cache key when the host gives none", async () => {
  const job = await firstBody({});
  expect(job).not.toHaveProperty("prompt_cache_key");
});

it("asks each request after the first to compare its cache reuse with the last response, and reports the verdict", async () => {
  const events: unknown[] = [];
  const record: MintDiagnostics["emit"] = (name, details) =>
    Effect.sync(() => {
      if (name === "mint.model") events.push(details);
    });
  const wire = wireMinter(
    (index) =>
      index === 0
        ? [functionCall("read_source", { path: "src/tool.ts", offset: null, limit: null, paths: null }, "read")]
        : [blocked],
    (index) =>
      index === 1
        ? {
            prompt_cache_diagnostics: {
              type: "cache_miss",
              reason: "tools_changed",
              cache_missed_tokens: 100,
              comparison_reusable_tokens: 5_000,
              detail: "Synthetic free text the host never records.",
            },
          }
        : {},
  );
  const f = await fixture(() => Promise.reject(new Error("Unused")), {
    model: wire.model,
    promptCacheKey: "synthetic-environment",
    diagnostics: { emit: record, retainModelTranscript: record },
  });
  await f.run();

  const [first, second] = wire.bodies;
  expect(first?.["prompt_cache_options"]).toEqual({ mode: "implicit" });
  expect(second?.["prompt_cache_options"]).toEqual({
    mode: "implicit",
    comparison_response_id: "resp_1",
  });
  const usageEvents = events.filter(
    (event) => typeof event === "object" && event !== null && Reflect.get(event, "phase") === "model_usage",
  );
  expect(usageEvents[0]).not.toHaveProperty("promptCacheDiagnostics");
  expect(Reflect.get(usageEvents[1] as object, "promptCacheDiagnostics")).toEqual({
    type: "cache_miss",
    reason: "tools_changed",
    cacheMissedTokens: 100,
    comparisonReusableTokens: 5_000,
  });
});
