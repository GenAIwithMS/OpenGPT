// Failure modes covered: an execution refusal's kind, final or correctable, is lost before the
// host reads it, so every refusal unlocks a policy block; a missing or unknown kind from an older
// or confused reviewer fails the decision instead of counting as none.
import { OpenAIProvider, setDefaultModelProvider, Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { ReviewFailure, makeGuardian } from "../../src/guardian/review.js";
import type { PendingExecution } from "../../src/guardian/review.js";
import { makeSourceInspector } from "../../src/guardian/source.js";

afterEach(() => setDefaultModelProvider(new OpenAIProvider()));

const pending: PendingExecution = {
  invocationId: "refusal_job",
  attemptId: "refusal_attempt",
  entrypoint: "operation/read.mjs",
  screenedIntent: "Read the synthetic price list",
  screenedInput: "{}",
  screenedObservations: "Synthetic fixture",
  accountScope: "account_refusal",
  allowedOrigins: ["https://prices.example.test"],
  allowedEffects: ["Synthetic step authority"],
};
const reader = makeSourceInspector(
  (path) =>
    path === "operation/read.mjs"
      ? Effect.succeed(new TextEncoder().encode("export default 'read prices';"))
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
          publicReason: null,
          label: null,
          action: null,
          refusal: null,
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
const guardian = () =>
  makeGuardian({
    ...makeOpenAIReviewer("{{ tenant_policy_config }}", false, {
      executionEnvironment: nativeExecutionEnvironment,
    }),
    retry: { delays: ["1 millis"], budget: "1 minute" },
  });

it.each([
  { outcome: "deny", refusal: "final" },
  { outcome: "deny", refusal: "correctable" },
  { outcome: "escalate", refusal: "final" },
  { outcome: "escalate", refusal: "correctable" },
] as const)("keeps the $refusal kind of an execution $outcome", async ({ outcome, refusal }) => {
  const requests = scripted([decision({ outcome, rationale: "Remove the extra click.", refusal })]);
  const reviewed = await Effect.runPromise(guardian().review(pending, reader));
  expect(reviewed.decision).toEqual({ outcome, rationale: "Remove the extra click.", refusal });
  expect(requests).toHaveLength(1);
});

// An older or confused reviewer's refusal still decides the step: it counts as having no kind,
// which the host reads as final, as every refusal was before.
it.each([{ refusal: null }, { refusal: "maybe" }, { refusal: undefined }])(
  "reads a deny with refusal $refusal as one without a kind, in the same review",
  async ({ refusal }) => {
    const requests = scripted([decision({ outcome: "deny", rationale: "Not allowed.", refusal })]);
    const reviewed = await Effect.runPromise(guardian().review(pending, reader));
    expect(reviewed.decision).toEqual({ outcome: "deny", rationale: "Not allowed." });
    expect(requests).toHaveLength(1);
  },
);

it("drops a refusal kind from an allow", async () => {
  scripted([
    decision({ outcome: "allow", rationale: "Reads prices.", action: "read", refusal: "final" }),
  ]);
  const reviewed = await Effect.runPromise(guardian().review(pending, reader));
  expect(reviewed.decision).toEqual({ outcome: "allow", rationale: "Reads prices.", action: "read" });
});
