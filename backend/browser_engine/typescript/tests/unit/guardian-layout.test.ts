// Failure modes covered: switching review kinds changes the instructions, tools or output format
// and resends the conversation uncached; a build's request is left out of the cached instructions
// or repeated in every review message; a review that never reads the host's wrapper fails
// although the agent's own file is in view; a skipped entrypoint read retries the whole review
// with backoff; a compaction in the middle of a review keeps an earlier read; an unchanged source
// is not marked as already read; session reviews drop their model diagnostics and token counts;
// a host-defined private kind's exchange reaches later readable records, also through a later
// review's failed run; a private kind's rejected label, its configured labels or its model error
// text reach a readable failure record, its retry included; a failed private review drops its
// final timing.
import { createHash } from "node:crypto";
import { OpenAIProvider, setDefaultModelProvider, Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { ReviewFailure, guardianOutageRetry, makeGuardian } from "../../src/guardian/review.js";
import type {
  GuardianDiagnostics,
  HostReview,
  PendingExecution,
} from "../../src/guardian/review.js";
import { makeSourceInspector } from "../../src/guardian/source.js";
import type { ModelObserverFactory } from "../../src/models/model-observer.js";
import type { ModelDiagnosticTiming } from "../../src/models/model-diagnostic-timing.js";
import { conversationOf, instructionsOf } from "../support/guardian-requests.js";

afterEach(() => setDefaultModelProvider(new OpenAIProvider()));

const native = { executionEnvironment: nativeExecutionEnvironment };

const pending: PendingExecution = {
  invocationId: "layout_job",
  attemptId: "layout_attempt",
  entrypoint: "operation/operation.mjs",
  screenedIntent: "Read the listed opening hours",
  screenedInput: "{}",
  screenedObservations: "Synthetic fixture",
  accountScope: "account_layout",
  allowedOrigins: ["https://hours.example.test"],
  allowedEffects: ["read"],
};

/** A synthetic host-defined kind, as a host would define one for its own review. */
const listing = (evidence: unknown): HostReview => ({
  kind: "catalog_listing",
  policy: "Synthetic listing policy: allow to list, deny to keep it unlisted.",
  evidence,
  outcomes: ["allow", "deny"],
  labels: ["listable", "owner_specific"],
  private: true,
});

const sourcesOf = (files: Map<string, string>) =>
  makeSourceInspector(
    (path) =>
      Effect.suspend(() => {
        const text = files.get(path);
        return text === undefined
          ? Effect.fail(new ReviewFailure({ code: "SourceUnavailable" }))
          : Effect.succeed(new TextEncoder().encode(text));
      }),
    (_path, bytes) => Effect.succeed(new TextDecoder().decode(bytes)),
  );
const files = () =>
  new Map([
    ["operation/operation.mjs", 'import { hours } from "./src/helper.mjs"; export default hours;'],
    ["operation/src/helper.mjs", "export const hours = () => 'synthetic-hours';"],
    ["operation/wrapped.mjs", "// host wrapper"],
  ]);

const decision = (value: Record<string, unknown>): ModelResponse["output"][number] => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [
    {
      type: "output_text",
      text: JSON.stringify({ reason: null, findings: null, label: null, action: null, ...value }),
    },
  ],
});
const allow = decision({ outcome: "allow", rationale: "Reads the hours only.", action: "read" });
const read = (id: string, path: string): ModelResponse["output"][number] => ({
  type: "function_call",
  callId: id,
  name: "read_source",
  status: "completed",
  arguments: JSON.stringify({ path, offset: 0 }),
});
const compact: ModelResponse["output"][number] = {
  type: "compaction",
  id: "cmp_layout",
  encrypted_content: "opaque-compacted-context",
};

const scripted = (responses: readonly ModelResponse["output"][], usage = () => new Usage()) => {
  const requests: ModelRequest[] = [];
  setDefaultModelProvider({
    getModel: () => ({
      getResponse: async (request) => {
        const output = responses[requests.length];
        requests.push(request);
        if (output === undefined) throw new Error("No scripted response");
        return { usage: usage(), output };
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  });
  return requests;
};

/** The host's review request: the last user message that is one. */
const reviewRequest = (request: ModelRequest | undefined): Record<string, unknown> => {
  const input = request?.input;
  const items = typeof input === "string" ? [{ role: "user", content: input }] : (input ?? []);
  for (const item of [...items].reverse()) {
    const content = "role" in item && item.role === "user" ? item.content : undefined;
    if (typeof content === "string" && content.startsWith("{"))
      return JSON.parse(content) as Record<string, unknown>;
  }
  throw new Error("No review request");
};

/** What the provider caches as the request's fixed prefix, as one stable hash. */
const prefixHash = (request: ModelRequest) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        instructions: instructionsOf(request),
        tools: request.tools,
        outputType: request.outputType,
        modelSettings: request.modelSettings,
      }),
    )
    .digest("hex");

const recording = () => {
  const events: { name: string; details: unknown }[] = [];
  const transcripts: unknown[] = [];
  const diagnostics: GuardianDiagnostics = {
    emit: (name, details) =>
      Effect.sync(() => {
        events.push({ name, details });
      }),
    retainModelTranscript: (_name, details) =>
      Effect.sync(() => {
        transcripts.push(details);
      }),
    retainScreenedSource: () => Effect.void,
    // A private kind's finite model timing, recorded with the readable events.
    observeModelTrace: (name, timing, correlation) =>
      Effect.sync(() => {
        events.push({ name: `observed:${name}`, details: { timing, correlation } });
      }),
  };
  return { diagnostics, events, transcripts };
};

it("keeps instructions, tools and output format identical across all six review kinds", async () => {
  const requests = scripted([
    [allow],
    [decision({ outcome: "allow_business", rationale: "Only the owner knows the branch." })],
    [decision({ outcome: "clarify", rationale: "The owner has not confirmed the branch." })],
    [allow],
    [
      decision({
        outcome: "allow",
        rationale: "Nothing private ships.",
        reason: "approved",
        findings: [],
      }),
    ],
    [decision({ outcome: "deny", rationale: "Names one owner.", label: "owner_specific" })],
  ]);
  const guardian = makeGuardian(
    makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native),
    undefined,
    {},
  );
  const reader = sourcesOf(files());
  const execution = await Effect.runPromise(guardian.review(pending, reader));
  const question = await Effect.runPromise(
    guardian.reviewQuestion(
      pending,
      {
        questions: [{ id: "branch", type: "text", prompt: "Which branch?" }],
        credentialsAvailable: false,
      },
      reader,
    ),
  );
  const update = await Effect.runPromise(
    guardian.reviewTaskUpdate(
      pending,
      {
        summary: "Read the north branch's hours instead.",
        changes: [{ setting: "input", values: { branch: "north" } }],
        recommend: "update",
        confirmation: [],
        effect: "read",
      },
      reader,
    ),
  );
  const recovery = await Effect.runPromise(
    guardian.reviewRecovery(pending, "Synthetic stalled browser", reader),
  );
  const publication = await Effect.runPromise(
    guardian.review(
      {
        ...pending,
        publication: {
          files: [
            {
              path: "operation/operation.mjs",
              byteLength: 64,
              published: true,
              current: true,
              owner: "minter",
            },
          ],
        },
      },
      reader,
    ),
  );
  const hosted = await Effect.runPromise(
    guardian.reviewHostKind(pending, listing({ primaryOrigin: "https://hours.example.test" })),
  );

  expect(requests).toHaveLength(6);
  expect(new Set(requests.map(prefixHash)).size).toBe(1);
  // Each review continues the one before it, so the provider can reuse the cached history.
  for (let index = 1; index < requests.length; index++) {
    const before = requests[index - 1]?.input ?? [];
    const after = requests[index]?.input ?? [];
    expect(after.slice(0, before.length)).toEqual(before);
  }
  expect(
    requests.map((request) => (reviewRequest(request).trusted_review as { kind: string }).kind),
  ).toEqual(["execution", "question", "update", "recovery", "publication", "catalog_listing"]);
  expect(execution.decision).toEqual({
    outcome: "allow",
    rationale: "Reads the hours only.",
    action: "read",
  });
  expect(question.decision).toEqual({
    outcome: "allow_business",
    rationale: "Only the owner knows the branch.",
  });
  expect(update.decision.outcome).toBe("clarify");
  expect(recovery.decision.outcome).toBe("allow");
  expect(publication.decision).toMatchObject({
    outcome: "allow",
    reason: "approved",
    findings: [],
  });
  expect(hosted.decision).toEqual({
    outcome: "deny",
    label: "owner_specific",
    rationale: "Names one owner.",
  });
});

it("sends a build's request once, after the instructions every build shares", async () => {
  const build = async (screenedIntent: string) => {
    const requests = scripted([
      [allow],
      [decision({ outcome: "allow_business", rationale: "Only the owner knows the table." })],
      [compact, read("after_compaction", "operation/operation.mjs")],
      [allow],
      [decision({ outcome: "allow", rationale: "Nothing private ships.", reason: "approved" })],
    ]);
    const guardian = makeGuardian(
      makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native),
      undefined,
      {},
    );
    const reader = sourcesOf(files());
    const ofBuild = { ...pending, screenedIntent };
    await Effect.runPromise(guardian.review(ofBuild, reader));
    await Effect.runPromise(
      guardian.reviewQuestion(
        ofBuild,
        {
          questions: [{ id: "table", type: "text", prompt: "Which table?" }],
          credentialsAvailable: false,
        },
        reader,
      ),
    );
    await Effect.runPromise(guardian.review(ofBuild, reader));
    await Effect.runPromise(
      guardian.review(
        {
          ...ofBuild,
          publication: {
            files: [
              {
                path: "operation/operation.mjs",
                byteLength: 64,
                published: true,
                current: true,
                owner: "minter",
              },
            ],
          },
        },
        reader,
      ),
    );
    return requests;
  };
  const tables =
    "Read the rows of the named table in a table app. If the table doesn't exist, tell callers which tables do.";
  const hours = "Read the listed opening hours";
  const first = await build(tables);
  const second = await build(hours);

  // Every review of the build, a compaction included, starts with the same two developer
  // messages: the instructions every build shares, then the build's own with its request. The
  // provider keeps both in the cached prefix, and a compaction leaves them in place.
  expect(first).toHaveLength(5);
  expect(new Set(first.map(prefixHash)).size).toBe(1);
  const leading = (request: ModelRequest | undefined) =>
    (Array.isArray(request?.input) ? request.input : []).slice(0, 2);
  for (const request of first) expect(leading(request)).toEqual(leading(first[0]));
  expect(conversationOf(first[3])[0]).toMatchObject({ type: "compaction" });
  const [shared, own] = leading(first[0]);
  expect(JSON.stringify(own)).toContain(
    JSON.stringify(`trusted_request: ${JSON.stringify({ intent: tables })}`).slice(1, -1),
  );
  // No review message repeats it, so the conversation carries it once.
  for (const request of first)
    expect(JSON.stringify(conversationOf(request))).not.toContain("tell callers");
  // Another build sends the shared instructions byte for byte, so every build reads them from
  // the cache, and only its own message differs.
  const [otherShared, otherOwn] = leading(second[0]);
  expect(JSON.stringify(otherShared)).toBe(JSON.stringify(shared));
  expect(JSON.stringify(shared)).not.toContain("tell callers");
  expect(JSON.stringify(otherOwn)).not.toContain("tell callers");
});

it("refuses an outcome the review kind may not return", async () => {
  const execution = await Effect.runPromise(
    Effect.either(
      makeGuardian({
        run: () => Effect.succeed({ outcome: "reword", rationale: "Wrong kind." }),
      }).review(pending, sourcesOf(files())),
    ),
  );
  expect(execution).toMatchObject({ _tag: "Left", left: { code: "InvalidOutcome" } });
  for (const [raw, code] of [
    [
      { outcome: "escalate", rationale: "Not one of this kind's outcomes.", label: "listable" },
      "InvalidOutcome",
    ],
    [
      { outcome: "allow", rationale: "Not one of this kind's labels.", label: "unlisted_code" },
      "InvalidDecision",
    ],
  ] as const) {
    const hosted = await Effect.runPromise(
      Effect.either(
        makeGuardian({ run: () => Effect.succeed(raw) }).reviewHostKind(pending, listing({})),
      ),
    );
    expect(hosted).toMatchObject({ _tag: "Left", left: { code } });
  }
});

it("allows in one model call with the agent's file in view and the host wrapper unread", async () => {
  const requests = scripted([[allow]]);
  const reads: string[] = [];
  const reader = sourcesOf(files());
  const reviewed = await Effect.runPromise(
    makeGuardian(
      makeOpenAIReviewer("{{ tenant_policy_config }}", false, native),
      undefined,
      {},
    ).review(
      {
        ...pending,
        hostWrapper: {
          path: "operation/wrapped.mjs",
          description: "Loads the entrypoint and runs it with the caller's input.",
        },
      },
      (path, offset) =>
        reader(path, offset).pipe(Effect.tap(() => Effect.sync(() => reads.push(path)))),
    ),
  );
  expect(reviewed.decision.outcome).toBe("allow");
  expect(requests).toHaveLength(1);
  expect(reads).toEqual(["operation/operation.mjs"]);
  const call = reviewRequest(requests[0]).submitted_call as {
    entrypointSource?: { source?: string };
  };
  expect(call.entrypointSource?.source).toBe(files().get("operation/operation.mjs"));
});

it("ends an allow without the entrypoint in view as EntrypointNotRead after two rounds, without retrying", async () => {
  const requests = scripted([[compact, allow], [allow], [allow]]);
  const { diagnostics, events } = recording();
  const result = await Effect.runPromise(
    Effect.either(
      makeGuardian(
        {
          ...makeOpenAIReviewer("{{ tenant_policy_config }}", false, native),
          retry: guardianOutageRetry,
        },
        diagnostics,
        {},
      ).review(pending, sourcesOf(files())),
    ),
  );
  expect(result).toMatchObject({ _tag: "Left", left: { code: "EntrypointNotRead" } });
  expect(requests).toHaveLength(3);
  expect(events.map((event) => event.name)).not.toContain("guardian.review_retried");
});

it("asks for the entrypoint again after a compaction in the review and accepts a ./ path", async () => {
  const requests = scripted([
    [compact, allow],
    [read("reread", "./operation/operation.mjs")],
    [allow],
  ]);
  const reviewed = await Effect.runPromise(
    makeGuardian(
      makeOpenAIReviewer("{{ tenant_policy_config }}", false, native),
      undefined,
      {},
    ).review(pending, sourcesOf(files())),
  );
  expect(reviewed.decision.outcome).toBe("allow");
  expect(requests).toHaveLength(3);
});

it("asks for the entrypoint in the same review when the host could not include it", async () => {
  const requests = scripted([[allow], [read("late", "operation/operation.mjs")], [allow]]);
  const reader = sourcesOf(files());
  let entrypointReads = 0;
  const reviewed = await Effect.runPromise(
    makeGuardian(makeOpenAIReviewer("{{ tenant_policy_config }}", false, native)).review(
      pending,
      (path, offset) =>
        path === pending.entrypoint && ++entrypointReads === 1
          ? Effect.fail(new ReviewFailure({ code: "SourceUnavailable" }))
          : reader(path, offset),
    ),
  );
  expect(reviewed.decision.outcome).toBe("allow");
  expect(requests).toHaveLength(3);
  expect(entrypointReads).toBe(2);
});

it("marks an executed source unchanged since Guardian read it, and not once it changes", async () => {
  const requests = scripted([
    [read("helper_1", "operation/src/helper.mjs")],
    [allow],
    [allow],
    [read("helper_2", "operation/src/helper.mjs")],
    [allow],
  ]);
  const workspace = files();
  const executed: PendingExecution = {
    ...pending,
    mintContext: {
      repeatableRead: false,
      operationSources: [...workspace.keys()],
      executedSources: ["operation/operation.mjs", "operation/src/helper.mjs"],
      browser: "active",
      executions: [],
    },
  };
  const guardian = makeGuardian(
    makeOpenAIReviewer("{{ tenant_policy_config }}", false, native),
    undefined,
    {},
  );
  const reader = sourcesOf(workspace);
  await Effect.runPromise(guardian.review(executed, reader));
  await Effect.runPromise(guardian.review({ ...executed, screenedInput: '{"day":2}' }, reader));
  workspace.set("operation/src/helper.mjs", "export const hours = () => 'changed-hours';");
  await Effect.runPromise(guardian.review({ ...executed, screenedInput: '{"day":3}' }, reader));
  const unchanged = (request: ModelRequest | undefined) =>
    (reviewRequest(request).trusted_review as { unchangedSources?: string[] }).unchangedSources;
  expect(requests).toHaveLength(5);
  expect(unchanged(requests[0])).toBeUndefined();
  expect(unchanged(requests[2])).toEqual(["operation/src/helper.mjs"]);
  expect(unchanged(requests[3])).toBeUndefined();
});

/** One read_source call that names several files. */
const readMany = (
  id: string,
  files: readonly { path: string; offset?: number; match?: string }[],
): ModelResponse["output"][number] => ({
  type: "function_call",
  callId: id,
  name: "read_source",
  status: "completed",
  arguments: JSON.stringify({
    path: null,
    offset: null,
    match: null,
    paths: files.map(({ path, offset = 0, match = null }) => ({ path, offset, match })),
  }),
});
/** The output a later model request shows for one tool call, parsed. */
const callOutput = (request: ModelRequest | undefined, callId: string): string | undefined => {
  const input = request?.input;
  const item = (typeof input === "string" ? [] : (input ?? [])).find(
    (entry) => entry.type === "function_call_result" && entry.callId === callId,
  );
  const output = item?.type === "function_call_result" ? item.output : undefined;
  return typeof output === "string" ? output : (output as { text?: string } | undefined)?.text;
};
const callResult = (request: ModelRequest | undefined, callId: string): unknown => {
  const text = callOutput(request, callId);
  return text === undefined ? undefined : JSON.parse(text);
};

it("reads several files in one call, each with its own result, and counts each as read", async () => {
  const requests = scripted([
    [
      readMany("several", [
        { path: "operation/src/helper.mjs" },
        { path: "operation/missing.mjs" },
        { path: "operation/wrapped.mjs", match: "wrapper" },
        { path: "./operation/wrapped.mjs" },
      ]),
    ],
    [allow],
    [allow],
  ]);
  const workspace = files();
  const executed: PendingExecution = {
    ...pending,
    mintContext: {
      repeatableRead: false,
      operationSources: [...workspace.keys()],
      executedSources: [
        "operation/operation.mjs",
        "operation/src/helper.mjs",
        "operation/wrapped.mjs",
      ],
      browser: "active",
      executions: [],
    },
  };
  const guardian = makeGuardian(
    makeOpenAIReviewer("{{ tenant_policy_config }}", false, native),
    undefined,
    {},
  );
  const reader = sourcesOf(workspace);
  await Effect.runPromise(guardian.review(executed, reader));
  expect(callResult(requests[1], "several")).toMatchObject({
    kind: "untrusted_sources",
    files: [
      {
        kind: "untrusted_source",
        path: "operation/src/helper.mjs",
        source: workspace.get("operation/src/helper.mjs"),
      },
      { path: "operation/missing.mjs", status: "unavailable" },
      { kind: "untrusted_source_matches", path: "operation/wrapped.mjs", matchCount: 1 },
      { kind: "untrusted_source", path: "operation/wrapped.mjs", hasMore: false },
    ],
  });
  // The next review relies on both files the one call read whole.
  await Effect.runPromise(guardian.review({ ...executed, screenedInput: '{"day":2}' }, reader));
  expect(
    (reviewRequest(requests[2]).trusted_review as { unchangedSources?: string[] }).unchangedSources,
  ).toEqual(["operation/src/helper.mjs", "operation/wrapped.mjs"]);
});

it("leaves the files past a call's size limit unread, and out of the next review's unchanged sources", async () => {
  const large = ["one", "two", "three", "four", "five"].map((name) => `operation/src/${name}.mjs`);
  const requests = scripted([
    [readMany("large", large.map((path) => ({ path })))],
    [allow],
    [allow],
  ]);
  const workspace = files();
  for (const path of large) workspace.set(path, `// ${path}\n${"x".repeat(60_000)}`);
  const executed: PendingExecution = {
    ...pending,
    mintContext: {
      repeatableRead: false,
      operationSources: [...workspace.keys()],
      executedSources: ["operation/operation.mjs", ...large],
      browser: "active",
      executions: [],
    },
  };
  const guardian = makeGuardian(
    makeOpenAIReviewer("{{ tenant_policy_config }}", false, native),
    undefined,
    {},
  );
  const reader = sourcesOf(workspace);
  await Effect.runPromise(guardian.review(executed, reader));
  // Four results pass 200,000 characters, so the fifth file never starts.
  expect(callResult(requests[1], "large")).toMatchObject({
    kind: "untrusted_sources",
    files: [
      ...large.slice(0, 4).map((path) => ({ kind: "untrusted_source", path, hasMore: false })),
      { path: large[4], status: "not_read" },
    ],
  });
  await Effect.runPromise(guardian.review({ ...executed, screenedInput: '{"day":2}' }, reader));
  expect(
    (reviewRequest(requests[2]).trusted_review as { unchangedSources?: string[] }).unchangedSources,
  ).toEqual(large.slice(0, 4));
});

it.each([
  [
    "names more files than one call reads",
    {
      path: null,
      offset: null,
      match: null,
      paths: Array.from({ length: 11 }, (_, index) => ({
        path: `operation/src/file-${index}.mjs`,
        offset: 0,
        match: null,
      })),
    },
  ],
  [
    "sets both path and paths",
    {
      path: "operation/src/helper.mjs",
      offset: 0,
      match: null,
      paths: [{ path: "operation/wrapped.mjs", offset: 0, match: null }],
    },
  ],
])("tells Guardian how to fix a read_source call that %s, without reading", async (_, call) => {
  const requests = scripted([
    [
      {
        type: "function_call",
        callId: "malformed",
        name: "read_source",
        status: "completed",
        arguments: JSON.stringify(call),
      },
    ],
    [allow],
  ]);
  const reader = sourcesOf(files());
  const reads: string[] = [];
  await Effect.runPromise(
    makeGuardian(makeOpenAIReviewer("{{ tenant_policy_config }}", false, native)).review(
      pending,
      (path, offset) => {
        reads.push(path);
        return reader(path, offset);
      },
    ),
  );
  // Only the host's own read of the entrypoint for the request.
  expect(reads).toEqual([pending.entrypoint]);
  const output = callOutput(requests[1], "malformed");
  expect(output).toBeDefined();
  expect(output).not.toMatch(/source unavailable/iu);
});

it("accepts an allow whose entrypoint Guardian read within a several-file call", async () => {
  const requests = scripted([
    [allow],
    [
      readMany("late_several", [
        { path: "operation/src/helper.mjs" },
        { path: "operation/operation.mjs" },
      ]),
    ],
    [allow],
  ]);
  const reader = sourcesOf(files());
  let entrypointReads = 0;
  const reviewed = await Effect.runPromise(
    makeGuardian(makeOpenAIReviewer("{{ tenant_policy_config }}", false, native)).review(
      pending,
      (path, offset) =>
        path === pending.entrypoint && ++entrypointReads === 1
          ? Effect.fail(new ReviewFailure({ code: "SourceUnavailable" }))
          : reader(path, offset),
    ),
  );
  expect(reviewed.decision.outcome).toBe("allow");
  expect(requests).toHaveLength(3);
  expect(entrypointReads).toBe(2);
});

it("reports model diagnostics and token counts for session reviews", async () => {
  scripted(
    [[allow]],
    () =>
      new Usage({
        requests: 1,
        inputTokens: 1000,
        outputTokens: 50,
        inputTokensDetails: { cached_tokens: 900, cache_write_tokens: 40 },
        outputTokensDetails: { reasoning_tokens: 30 },
      }),
  );
  const timing: ModelDiagnosticTiming = {
    phase: "completed",
    sequence: 0,
    occurredAtUtc: "2026-01-01T00:00:00.000Z",
    occurredMonotonicMs: 0,
    queueMs: 0,
  };
  const observerFactory: ModelObserverFactory = (persist) => {
    const persisted: Promise<void>[] = [];
    return {
      attach: () => undefined,
      tool: (_call, invoke) => invoke(),
      provider: (provider) => provider,
      started: () => undefined,
      skillsInstalled: () => undefined,
      segment: () => undefined,
      completed: () => {
        persisted.push(persist({ phase: "completed" }, timing));
      },
      failed: () => undefined,
      takeNativeCall: () => undefined,
      durabilityFailure: () => undefined,
      terminal: () => ({ phase: "terminal", timing, value: {} }),
      flush: async () => {
        await Promise.all(persisted);
      },
    };
  };
  const { diagnostics, events, transcripts } = recording();
  await Effect.runPromise(
    makeGuardian(
      makeOpenAIReviewer("{{ tenant_policy_config }}", false, { ...native, observerFactory }),
      diagnostics,
      {},
    ).review(pending, sourcesOf(files())),
  );
  expect(transcripts).toHaveLength(1);
  expect(events.find((event) => event.name === "guardian.usage")?.details).toMatchObject({
    details: {
      modelCalls: 1,
      inputTokens: 1000,
      cachedTokens: 900,
      cacheWriteTokens: 40,
      outputTokens: 50,
      reasoningTokens: 30,
    },
  });
});

it("reports each wait for the session as an interval", async () => {
  scripted([[allow], [allow]]);
  const { diagnostics, events } = recording();
  const guardian = makeGuardian(
    makeOpenAIReviewer("{{ tenant_policy_config }}", false, native),
    diagnostics,
    {},
  );
  const reader = sourcesOf(files());
  await Effect.runPromise(
    Effect.all(
      [
        guardian.review(pending, reader),
        guardian.review({ ...pending, screenedInput: "{}" }, reader),
      ],
      { concurrency: "unbounded" },
    ),
  );
  const waits = events
    .filter((event) => event.name === "guardian.session_wait")
    .map(
      (event) =>
        event.details as { kind: string; startedAtUtc: string; endedAtUtc: string; waitMs: number },
    );
  expect(waits).toHaveLength(2);
  for (const wait of waits) {
    expect(wait.kind).toBe("execution");
    expect(Date.parse(wait.endedAtUtc) - Date.parse(wait.startedAtUtc)).toBe(wait.waitMs);
  }
});

it.each(["default", "mapped", "bare"] as const)(
  "keeps an included entrypoint in view when retaining its screened copy fails (%s mapping)",
  async (mapping) => {
    const requests = scripted([[allow]]);
    const { diagnostics, events } = recording();
    const reviewed = await Effect.runPromise(
      Effect.either(
        makeGuardian(
          makeOpenAIReviewer("{{ tenant_policy_config }}", false, native),
          {
            ...diagnostics,
            retainScreenedSource: () => Effect.fail(new Error("Synthetic retention outage")),
          },
          {},
          mapping === "default"
            ? {}
            : {
                diagnosticFailure: () =>
                  new ReviewFailure({
                    code: "Unavailable",
                    ...(mapping === "mapped" ? { diagnosticRetentionReason: "storage" } : {}),
                  }),
              },
        ).review(pending, sourcesOf(files())),
      ),
    );
    expect(reviewed).toMatchObject({ _tag: "Right", right: { decision: { outcome: "allow" } } });
    expect(requests).toHaveLength(1);
    const call = reviewRequest(requests[0]).submitted_call as {
      entrypointSource?: { source?: string };
    };
    expect(call.entrypointSource?.source).toBe(files().get("operation/operation.mjs"));
    expect(events.map((event) => event.name)).toContain("guardian.source_failed");
  },
);

it("ends EntrypointNotRead, without retrying, when the entrypoint can't be included and is never read", async () => {
  const requests = scripted([[allow], [allow], [allow]]);
  const { diagnostics, events } = recording();
  const result = await Effect.runPromise(
    Effect.either(
      makeGuardian(
        {
          ...makeOpenAIReviewer("{{ tenant_policy_config }}", false, native),
          retry: guardianOutageRetry,
        },
        diagnostics,
        {},
      ).review(pending, () => Effect.fail(new ReviewFailure({ code: "SourceUnavailable" }))),
    ),
  );
  expect(result).toMatchObject({ _tag: "Left", left: { code: "EntrypointNotRead" } });
  expect(requests).toHaveLength(3);
  expect(events.map((event) => event.name)).not.toContain("guardian.review_retried");
});

it.each([false, true])(
  "keeps a private host kind's exchange out of later reviews' readable model records but in the model's history (compacted: %s)",
  async (compacted) => {
    const requests = scripted([
      [
        ...(compacted ? [compact] : []),
        decision({
          outcome: "deny",
          rationale: "Names synthetic-private-rationale-marker.",
          label: "owner_specific",
        }),
      ],
      [allow],
    ]);
    const timing: ModelDiagnosticTiming = {
      phase: "completed",
      sequence: 0,
      occurredAtUtc: "2026-01-01T00:00:00.000Z",
      occurredMonotonicMs: 0,
      queueMs: 0,
    };
    // A readable projection of everything the observer sees: each request and the final history.
    const observerFactory: ModelObserverFactory = (persist) => {
      const persisted: Promise<void>[] = [];
      const seen: unknown[] = [];
      return {
        attach: () => undefined,
        tool: (_call, invoke) => invoke(),
        provider: (provider) => ({
          getModel: async (name) => {
            const model = await provider.getModel(name);
            return {
              getResponse: (request: ModelRequest) => {
                seen.push(request.input);
                return model.getResponse(request);
              },
              getStreamedResponse: (request: ModelRequest) => model.getStreamedResponse(request),
            };
          },
        }),
        started: () => undefined,
        skillsInstalled: () => undefined,
        segment: () => undefined,
        completed: (history) => {
          persisted.push(persist({ requests: seen, history }, timing));
        },
        failed: () => undefined,
        takeNativeCall: () => undefined,
        durabilityFailure: () => undefined,
        terminal: () => ({ phase: "terminal", timing, value: {} }),
        flush: async () => {
          await Promise.all(persisted);
        },
      };
    };
    const { diagnostics, transcripts } = recording();
    const guardian = makeGuardian(
      makeOpenAIReviewer("{{ tenant_policy_config }}", false, { ...native, observerFactory }),
      diagnostics,
      {},
    );
    const hosted = await Effect.runPromise(
      guardian.reviewHostKind(
        pending,
        listing({ primaryOrigin: "https://synthetic-private-evidence-marker.example.test" }),
      ),
    );
    expect(hosted.decision.outcome).toBe("deny");
    expect(transcripts).toHaveLength(0);
    await Effect.runPromise(guardian.review(pending, sourcesOf(files())));
    expect(transcripts).toHaveLength(1);
    const readable = JSON.stringify(transcripts);
    expect(readable).not.toContain("synthetic-private-evidence-marker");
    expect(readable).not.toContain("synthetic-private-rationale-marker");
    // The model still continues the whole conversation, so its cached prefix holds. A compaction
    // in the private review leaves only its final output after the compacted context.
    const sent = JSON.stringify(requests[1]?.input);
    expect(sent).toContain("synthetic-private-rationale-marker");
    if (compacted) expect(conversationOf(requests[1])[0]).toMatchObject({ type: "compaction" });
    else {
      expect(sent).toContain("synthetic-private-evidence-marker");
      expect(requests[1]?.input.slice(0, requests[0]?.input.length)).toEqual(requests[0]?.input);
    }
  },
);

it.each([
  { failure: "a label outside the kind's labels", code: "InvalidDecision" },
  { failure: "a model call whose error names its output", code: "Unavailable" },
] as const)(
  "describes a private host kind's failure without its output or the kind's labels ($failure)",
  async ({ code }) => {
    setDefaultModelProvider({
      getModel: () => ({
        getResponse: async () => {
          if (code === "Unavailable")
            throw new Error("Synthetic provider error: synthetic-rejected-label-marker");
          return {
            usage: new Usage(),
            output: [
              decision({
                outcome: "deny",
                rationale: "Synthetic rationale.",
                label: "synthetic-rejected-label-marker",
              }),
            ],
          };
        },
        getStreamedResponse: () => {
          throw new Error("Unused stream");
        },
      }),
    });
    const timing: ModelDiagnosticTiming = {
      phase: "completed",
      sequence: 0,
      occurredAtUtc: "2026-01-01T00:00:00.000Z",
      occurredMonotonicMs: 0,
      queueMs: 0,
    };
    // Everything the observer is handed, persisted as a readable record would be.
    const observerFactory: ModelObserverFactory = (persist) => {
      const persisted: Promise<void>[] = [];
      return {
        attach: () => undefined,
        tool: (_call, invoke) => invoke(),
        provider: (provider) => provider,
        started: () => undefined,
        skillsInstalled: () => undefined,
        segment: () => undefined,
        completed: (history) => {
          persisted.push(persist({ history }, timing));
        },
        failed: (error) => {
          persisted.push(persist({ error: String(error) }, timing));
        },
        takeNativeCall: () => undefined,
        durabilityFailure: () => undefined,
        terminal: () => ({ phase: "terminal", timing, value: {} }),
        flush: async () => {
          await Promise.all(persisted);
        },
      };
    };
    const { diagnostics, events, transcripts } = recording();
    const result = await Effect.runPromise(
      Effect.either(
        makeGuardian(
          {
            ...makeOpenAIReviewer("{{ tenant_policy_config }}", false, {
              ...native,
              observerFactory,
            }),
            // One retry: the second wait alone outlasts the budget.
            retry: { delays: ["1 millis", "1 second"], budget: "1 second" },
          },
          diagnostics,
        ).reviewHostKind(pending, {
          ...listing({}),
          labels: ["synthetic-private-label-marker-a", "synthetic-private-label-marker-b"],
        }),
      ),
    );
    expect(result).toMatchObject({ _tag: "Left", left: { code } });
    expect(events.map((event) => event.name)).toContain("guardian.review_retried");
    // Each attempt's timing and the model's finite timing are kept, and are checked below too.
    const failed = events.filter((event) => event.name === "guardian.failed");
    expect(failed.length).toBeGreaterThan(0);
    for (const event of failed)
      expect(event.details).toMatchObject({ details: { timing: { attempt: expect.any(Number) } } });
    expect(events.map((event) => event.name)).toContain("observed:guardian.model");
    const failure = result._tag === "Left" ? result.left : undefined;
    const readable = JSON.stringify({
      events,
      transcripts,
      failure,
      detail: failure?.failureDetail,
      message: String(failure),
    });
    expect(readable).not.toContain("synthetic-rejected-label-marker");
    expect(readable).not.toContain("synthetic-private-label-marker");
  },
);

it("forwards a failed private host kind's final timing without its error or detail", async () => {
  setDefaultModelProvider({
    getModel: () => ({
      getResponse: async () => {
        throw new Error("Synthetic provider error: synthetic-error-marker");
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  });
  const at = (phase: ModelDiagnosticTiming["phase"], sequence: number): ModelDiagnosticTiming => ({
    phase,
    sequence,
    occurredAtUtc: "2026-01-01T00:00:00.000Z",
    occurredMonotonicMs: sequence * 25,
    queueMs: 0,
  });
  const final = at("terminal", 2);
  const observerFactory: ModelObserverFactory = (persist) => {
    const persisted: Promise<void>[] = [];
    return {
      attach: () => undefined,
      tool: (_call, invoke) => invoke(),
      provider: (provider) => provider,
      started: () => undefined,
      skillsInstalled: () => undefined,
      segment: () => undefined,
      completed: () => undefined,
      failed: (error) => {
        persisted.push(persist({ error: String(error) }, at("failed", 1)));
      },
      takeNativeCall: () => undefined,
      durabilityFailure: () => undefined,
      terminal: () => ({
        phase: "terminal",
        timing: final,
        value: { note: "synthetic-terminal-detail-marker" },
      }),
      flush: async () => {
        await Promise.all(persisted);
      },
    };
  };
  const { diagnostics, events, transcripts } = recording();
  const result = await Effect.runPromise(
    Effect.either(
      makeGuardian(
        makeOpenAIReviewer("{{ tenant_policy_config }}", false, { ...native, observerFactory }),
        diagnostics,
      ).reviewHostKind(pending, listing({})),
    ),
  );
  expect(result).toMatchObject({ _tag: "Left", left: { code: "Unavailable" } });
  const observed = events
    .filter((event) => event.name === "observed:guardian.model")
    .map((event) => (event.details as { timing: ModelDiagnosticTiming }).timing);
  expect(observed).toContainEqual(final);
  const readable = JSON.stringify({ events, transcripts });
  expect(readable).not.toContain("synthetic-error-marker");
  expect(readable).not.toContain("synthetic-terminal-detail-marker");
});

it("keeps an earlier private host kind's exchange out of a later review's failed run", async () => {
  scripted([
    [
      decision({
        outcome: "deny",
        rationale: "Names synthetic-private-rationale-marker.",
        label: "owner_specific",
      }),
    ],
    [read("call_turn_limit", "operation/src/helper.mjs")],
    // The turn after the limit offers no read; a model that still asks for one gets no decision.
    [read("call_final_turn", "operation/src/helper.mjs")],
  ]);
  const timing: ModelDiagnosticTiming = {
    phase: "completed",
    sequence: 0,
    occurredAtUtc: "2026-01-01T00:00:00.000Z",
    occurredMonotonicMs: 0,
    queueMs: 0,
  };
  // An observer that keeps a failed run's history in its readable record.
  const observerFactory: ModelObserverFactory = (persist) => {
    const persisted: Promise<void>[] = [];
    return {
      attach: () => undefined,
      tool: (_call, invoke) => invoke(),
      provider: (provider) => provider,
      started: () => undefined,
      skillsInstalled: () => undefined,
      segment: () => undefined,
      completed: () => undefined,
      failed: (error) => {
        const state: unknown =
          typeof error === "object" && error !== null ? Reflect.get(error, "state") : undefined;
        persisted.push(
          persist(
            {
              error: String(error),
              history:
                typeof state === "object" && state !== null
                  ? Reflect.get(state, "history")
                  : undefined,
            },
            timing,
          ),
        );
      },
      takeNativeCall: () => undefined,
      durabilityFailure: () => undefined,
      terminal: () => ({ phase: "terminal", timing, value: {} }),
      flush: async () => {
        await Promise.all(persisted);
      },
    };
  };
  const { diagnostics, events, transcripts } = recording();
  const guardian = makeGuardian(
    makeOpenAIReviewer("{{ tenant_policy_config }}", false, {
      ...native,
      observerFactory,
      specialize: (turn) => (turn.pending.hostReview === undefined ? { maxTurns: 1 } : {}),
    }),
    diagnostics,
    {},
  );
  const hosted = await Effect.runPromise(
    guardian.reviewHostKind(
      pending,
      listing({ primaryOrigin: "https://synthetic-private-evidence-marker.example.test" }),
    ),
  );
  expect(hosted.decision.outcome).toBe("deny");
  const later = await Effect.runPromise(
    Effect.either(guardian.review(pending, sourcesOf(files()))),
  );
  expect(later).toMatchObject({ _tag: "Left", left: { code: "TurnLimitExceeded" } });
  // The later review's failure record keeps its own history, with the private one withheld.
  const readable = JSON.stringify({ events, transcripts });
  expect(readable).toContain("call_turn_limit");
  expect(readable).not.toContain("synthetic-private-evidence-marker");
  expect(readable).not.toContain("synthetic-private-rationale-marker");
});

// The host's correction of a refused outcome is a plain user message, which ends a private
// exchange in readable records, so the private kind's later rationale showed in clear there.
it("ends a private host kind's refused outcome at once, so no correction reaches a readable record", async () => {
  const requests: ModelRequest[] = [];
  setDefaultModelProvider({
    getModel: () => ({
      getResponse: async (request) => {
        requests.push(request);
        const input = typeof request.input === "string" ? [] : request.input;
        const last = input.at(-1);
        const content = last !== undefined && "content" in last ? last.content : undefined;
        const kind =
          typeof content === "string" && content.startsWith("{")
            ? (reviewRequest(request).trusted_review as { kind: string }).kind
            : "follow-up";
        const output =
          kind === "catalog_listing"
            ? decision({ outcome: "escalate", rationale: "Refused.", label: "listable" })
            : kind === "follow-up"
              ? decision({
                  outcome: "deny",
                  rationale: "Names synthetic-private-rationale-marker.",
                  label: "owner_specific",
                })
              : allow;
        return { usage: new Usage(), output: [output] };
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  });
  const timing: ModelDiagnosticTiming = {
    phase: "completed",
    sequence: 0,
    occurredAtUtc: "2026-01-01T00:00:00.000Z",
    occurredMonotonicMs: 0,
    queueMs: 0,
  };
  // An observer that keeps each completed run's history in its readable record.
  const observerFactory: ModelObserverFactory = (persist) => {
    const persisted: Promise<void>[] = [];
    return {
      attach: () => undefined,
      tool: (_call, invoke) => invoke(),
      provider: (provider) => provider,
      started: () => undefined,
      skillsInstalled: () => undefined,
      segment: () => undefined,
      completed: (history) => {
        persisted.push(persist({ history }, timing));
      },
      failed: () => undefined,
      takeNativeCall: () => undefined,
      durabilityFailure: () => undefined,
      terminal: () => ({ phase: "terminal", timing, value: {} }),
      flush: async () => {
        await Promise.all(persisted);
      },
    };
  };
  const { diagnostics, events, transcripts } = recording();
  const guardian = makeGuardian(
    makeOpenAIReviewer("{{ tenant_policy_config }}", false, { ...native, observerFactory }),
    diagnostics,
    {},
  );
  const hosted = await Effect.runPromise(
    Effect.either(guardian.reviewHostKind(pending, listing({ primaryOrigin: "synthetic" }))),
  );
  expect(hosted).toMatchObject({ _tag: "Left", left: { code: "InvalidOutcome" } });
  expect(requests).toHaveLength(1);
  const later = await Effect.runPromise(guardian.review(pending, sourcesOf(files())));
  expect(later.decision.outcome).toBe("allow");
  const readable = JSON.stringify({ events, transcripts });
  expect(readable).toContain("Reads the hours only.");
  expect(readable).not.toContain("synthetic-private-rationale-marker");
});
