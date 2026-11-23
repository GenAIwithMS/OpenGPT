import OpenAI from "openai";
import { OpenAIProvider, setDefaultModelProvider } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { lunaModel } from "../../src/models/models.js";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import type { GuardianModelOptions } from "../../src/guardian/openai.js";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { makeGuardian } from "../../src/guardian/review.js";
import type { GuardianDiagnostics, PendingExecution } from "../../src/guardian/review.js";

afterEach(() => setDefaultModelProvider(new OpenAIProvider()));

const pending: PendingExecution = {
  invocationId: "mint_effort",
  attemptId: "attempt_one",
  entrypoint: "operation/operation.mjs",
  screenedIntent: "Read the selected trip",
  screenedInput: "{}",
  screenedObservations: "Synthetic fixture",
  accountScope: "account_one",
  allowedOrigins: ["https://travel.example.test"],
  allowedEffects: ["read"],
};
const quick: PendingExecution = { ...pending, screenedInput: '{"quick":true}' };

const readCurrent = () =>
  Effect.succeed(
    JSON.stringify({
      kind: "untrusted_source",
      path: pending.entrypoint,
      byteOffset: 0,
      source: "export default 1",
      nextOffset: 16,
      hasMore: false,
    }),
  );

/** A Responses API that records each request body and allows every review in one call. */
const wire = () => {
  const bodies: Record<string, unknown>[] = [];
  const client = new OpenAI({
    apiKey: "synthetic-key",
    maxRetries: 0,
    fetch: async (_url, init) => {
      bodies.push(
        JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>,
      );
      return new Response(
        JSON.stringify({
          id: `resp_${bodies.length}`,
          object: "response",
          created_at: 1,
          status: "completed",
          model: lunaModel,
          output: [
            {
              type: "message",
              id: `msg_${bodies.length}`,
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    outcome: "allow",
                    rationale: "Current source was read",
                    action: "read",
                  }),
                  annotations: [],
                },
              ],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  setDefaultModelProvider(new OpenAIProvider({ openAIClient: client }));
  return bodies;
};

const recording = () => {
  const usage: unknown[] = [];
  const diagnostics: GuardianDiagnostics = {
    emit: (name, details) =>
      Effect.sync(() => {
        if (name === "guardian.usage") usage.push(details);
      }),
    retainModelTranscript: () => Effect.void,
    retainScreenedSource: () => Effect.void,
  };
  return { diagnostics, usage };
};

const reviewAll = (options: Omit<GuardianModelOptions, "executionEnvironment">) => {
  const { diagnostics, usage } = recording();
  const guardian = makeGuardian(
    makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, {
      executionEnvironment: nativeExecutionEnvironment,
      ...options,
    }),
    diagnostics,
    {},
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      for (const review of [pending, quick, pending])
        yield* guardian.review(review, readCurrent);
      return usage;
    }),
  );
};

type WireItem = { readonly type?: string; readonly role?: string; readonly reasoning?: unknown };
const itemsOf = (body: Record<string, unknown> | undefined) =>
  (body?.["input"] ?? []) as readonly WireItem[];

it("changes a review's reasoning effort with a configuration update, keeping the request's own and its prefix", async () => {
  const bodies = wire();
  const efforts = { "{}": undefined, '{"quick":true}': "low" } as const;
  const { diagnostics, usage } = recording();
  const guardian = makeGuardian(
    makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, {
      executionEnvironment: nativeExecutionEnvironment,
      specialize: (turn) => {
        const effort = efforts[turn.pending.screenedInput as keyof typeof efforts];
        return effort === undefined ? {} : { reasoningEffort: effort };
      },
    }),
    diagnostics,
    {},
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      for (const review of [pending, quick, quick, pending, pending])
        yield* guardian.review(review, readCurrent);
    }),
  );

  expect(bodies.map((body) => body.model)).toEqual(Array(5).fill(lunaModel));
  // The request's own effort never changes, so its hidden instructions and cached prefix hold.
  expect(bodies.map((body) => (body.reasoning as { effort?: string }).effort)).toEqual(
    Array(5).fill("medium"),
  );
  // Each request continues the one before it byte for byte: only items are appended.
  for (let index = 1; index < bodies.length; index++) {
    const before = itemsOf(bodies[index - 1]);
    expect(JSON.stringify(itemsOf(bodies[index]).slice(0, before.length))).toBe(
      JSON.stringify(before),
    );
  }
  // A configuration update comes right before the request of a review whose effort differs
  // from the conversation's, and only then: low for the first quick review, medium again after.
  const last = itemsOf(bodies.at(-1));
  const updates = last.flatMap((item, index) =>
    item.type === "configuration_update" ? [{ index, item }] : [],
  );
  expect(updates.map(({ item }) => item.reasoning)).toEqual([
    { effort: "low" },
    { effort: "medium" },
  ]);
  for (const { index } of updates) expect(last[index + 1]?.role).toBe("user");
  const requests = last.filter((item) => item.role === "user");
  expect(requests).toHaveLength(5);
  // The updates precede the second and the fourth review's requests.
  expect(updates.map(({ index }) => requests.indexOf(last[index + 1] ?? {}))).toEqual([1, 3]);
  expect(usage).toEqual(
    ["medium", "low", "low", "medium", "medium"].map((reasoningEffort) =>
      expect.objectContaining({ details: expect.objectContaining({ reasoningEffort }) }),
    ),
  );
});

it("reviews at medium effort when the host picks none", async () => {
  const bodies = wire();
  const usage = await reviewAll({});

  expect(bodies.map((body) => (body.reasoning as { effort?: string }).effort)).toEqual([
    "medium",
    "medium",
    "medium",
  ]);
  expect(usage).toEqual([
    expect.objectContaining({ details: expect.objectContaining({ reasoningEffort: "medium" }) }),
    expect.objectContaining({ details: expect.objectContaining({ reasoningEffort: "medium" }) }),
    expect.objectContaining({ details: expect.objectContaining({ reasoningEffort: "medium" }) }),
  ]);
});
