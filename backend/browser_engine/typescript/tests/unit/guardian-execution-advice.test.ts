// Failure modes covered: an execution review denies a step over which page value the request's
// output means, because the publication-only capability rule reaches execution and recovery
// reviews; an execution allow loses the advice that carries that doubt, or a deny keeps advice
// beside its rationale; the agent's own description of the step never reaches the review, reaches
// it without bound, or reaches it as trusted host data.
import { OpenAIProvider, setDefaultModelProvider, Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { capabilityCompletionPolicy, makeOpenAIReviewer } from "../../src/guardian/openai.js";
import { agentNoteLimit } from "../../src/guardian/openai-input.js";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { ReviewFailure, makeGuardian } from "../../src/guardian/review.js";
import type { PendingExecution } from "../../src/guardian/review.js";
import { makeSourceInspector } from "../../src/guardian/source.js";

afterEach(() => setDefaultModelProvider(new OpenAIProvider()));

const pending: PendingExecution = {
  invocationId: "advice_job",
  attemptId: "advice_attempt",
  entrypoint: "operation/read.mjs",
  screenedIntent: "Return each listed item with its record number",
  screenedInput: "{}",
  screenedObservations: "Synthetic fixture",
  accountScope: "account_advice",
  allowedOrigins: ["https://records.example.test"],
  allowedEffects: ["read"],
};
const reader = makeSourceInspector(
  (path) =>
    path === "operation/read.mjs"
      ? Effect.succeed(new TextEncoder().encode("export default 'read the rows';"))
      : Effect.fail(new ReviewFailure({ code: "SourceUnavailable" })),
  (_path, bytes) => Effect.succeed(new TextDecoder().decode(bytes)),
);

const decision = (value: Record<string, unknown>): ModelResponse["output"] => [
  {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [
      {
        type: "output_text",
        text: JSON.stringify({
          reason: null,
          findings: null,
          label: null,
          action: null,
          advice: null,
          ...value,
        }),
      },
    ],
  },
];
/** Guardian's model, answering each request with the next scripted output. */
const scripted = (responses: readonly ModelResponse["output"][]) => {
  const requests: ModelRequest[] = [];
  setDefaultModelProvider({
    getModel: () => ({
      getResponse: async (request) => {
        const output = responses[requests.length];
        requests.push(request);
        if (output === undefined) throw new Error("No scripted response");
        return { usage: new Usage(), output };
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  });
  return requests;
};
const reviewer = () =>
  makeOpenAIReviewer("{{ tenant_policy_config }}", false, {
    executionEnvironment: nativeExecutionEnvironment,
  });
const guardian = () =>
  makeGuardian({ ...reviewer(), retry: { delays: ["1 millis"], budget: "1 minute" } });

/** The host's review request: the last user message that is one. */
const reviewRequest = (request: ModelRequest | undefined) => {
  const input = request?.input;
  const items = typeof input === "string" ? [{ role: "user", content: input }] : (input ?? []);
  for (const item of [...items].reverse()) {
    const content = "role" in item && item.role === "user" ? item.content : undefined;
    if (typeof content === "string" && content.startsWith("{"))
      return JSON.parse(content) as {
        readonly trusted_review: { readonly policy: string };
        readonly submitted_call: Record<string, unknown>;
      } & Record<string, unknown>;
  }
  throw new Error("No review request");
};

const doubt =
  "The page shows two numbers per row; the request's definition fits the second. Confirm with the owner if unsure.";

it("allows an execution whose review carries advice, and hands the advice back with it", async () => {
  scripted([
    decision({ outcome: "allow", rationale: "Reads the rows.", action: "read", advice: doubt }),
  ]);
  const reviewed = await Effect.runPromise(guardian().review(pending, reader));
  expect(reviewed.decision).toEqual({
    outcome: "allow",
    rationale: "Reads the rows.",
    action: "read",
    advice: doubt,
  });
});

it("keeps advice off a deny, whose rationale carries what to change", async () => {
  scripted([
    decision({
      outcome: "deny",
      rationale: "Clicks delete on every row.",
      action: "write",
      refusal: "correctable",
      advice: doubt,
    }),
  ]);
  const reviewed = await Effect.runPromise(guardian().review(pending, reader));
  expect(reviewed.decision.outcome).toBe("deny");
  expect(reviewed.decision).not.toHaveProperty("advice");
});

it("sends the capability rule only with a publication review", async () => {
  const requests = scripted([
    decision({ outcome: "allow", rationale: "Reads the rows.", action: "read" }),
    decision({ outcome: "allow", rationale: "A new browser may help." }),
    decision({ outcome: "allow", rationale: "Publishable." }),
  ]);
  await Effect.runPromise(guardian().review(pending, reader));
  await Effect.runPromise(guardian().reviewRecovery(pending, "The page stopped loading.", reader));
  // The publication's decision does not matter here, only the policy its request carries.
  await Effect.runPromiseExit(
    reviewer().run({
      reviewId: "advice_publication",
      pending: {
        ...pending,
        publication: {
          files: [
            {
              path: "operation/read.mjs",
              byteLength: 30,
              published: true,
              current: true,
              owner: "minter",
            },
          ],
        },
      },
      readSource: (path, offset) => reader(path, offset),
    }),
  );
  const [execution, recovery, publication] = requests.map(
    (request) => reviewRequest(request).trusted_review.policy,
  );
  expect(execution).not.toContain(capabilityCompletionPolicy);
  expect(recovery).not.toContain(capabilityCompletionPolicy);
  expect(publication).toContain(capabilityCompletionPolicy);
});

it("carries the agent's note on the step as untrusted call data, cut to its limit", async () => {
  const requests = scripted([
    decision({ outcome: "allow", rationale: "Reads the rows.", action: "read" }),
    decision({ outcome: "allow", rationale: "Reads the rows.", action: "read" }),
  ]);
  const note = "Read the record number column, which the request defines as the item's number.";
  await Effect.runPromise(guardian().review({ ...pending, agentNote: note }, reader));
  await Effect.runPromise(
    guardian().review({ ...pending, agentNote: `${"long note ".repeat(80)}end` }, reader),
  );
  const [short, long] = requests.map(reviewRequest);
  expect(short?.submitted_call.agentNote).toBe(note);
  // Never in a trusted section of the request.
  const trusted = Object.entries(short ?? {}).filter(([key]) => key.startsWith("trusted_"));
  expect(JSON.stringify(trusted)).not.toContain(note);
  const cut = long?.submitted_call.agentNote;
  expect(typeof cut).toBe("string");
  expect((cut as string).length).toBeLessThanOrEqual(agentNoteLimit);
  expect(cut).toMatch(/^long note /u);
  expect(cut).not.toContain("end");
});
