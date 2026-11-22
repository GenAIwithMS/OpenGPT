// Failure modes covered: the intent the minting agent gives an execute call never reaches the
// host's execution review, so Guardian judges the step without the agent's own account of it; the
// advice Guardian attaches to an allow never reaches the agent, so a doubt about which value the
// request asks for surfaces only as a later denial.
import { Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { MintFailure, MintServices } from "../../src/mint/contracts.js";
import type { MintDependencies } from "../../src/mint/contracts.js";
import { runMint } from "../../src/mint/harness.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { Deadline } from "../../src/runtime/deadline.js";
import { portableJobSession, portableMintProjection } from "../support/portable-mint.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const usage = () => new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 });
const call = (name: string, args: unknown, callId = name): ModelResponse => ({
  usage: usage(),
  output: [
    { type: "function_call", name, callId, arguments: JSON.stringify(args), status: "completed" },
  ],
});
// The minter ends the synthetic attempt blocked, which stops the model at once.
const reportBlocked = call("report_blocked", {
  reason: "site_lacks_capability",
  explanation: "The synthetic site offers nothing to read.",
  intent: "End the synthetic attempt.",
});

const toolResult = (request: ModelRequest | undefined, callId: string) => {
  const input = request?.input;
  if (!Array.isArray(input)) throw new Error("Missing history");
  return JSON.stringify(
    input.find((item) => item.type === "function_call_result" && item.callId === callId),
  );
};

it("reviews a step with the agent's intent as its note and returns the allow's advice", async () => {
  const workspace = await portableJobSession({ "src/tool.ts": "export {};" });
  cleanups.push(async () => {
    await workspace.close();
  });
  const intent = "Read the record number column, which the request defines as each item's number.";
  const advice = "The page also shows a form identifier; the request's definition fits the column.";
  const requests: ModelRequest[] = [];
  const notes: (string | undefined)[] = [];
  const dependencies: MintDependencies = {
    workspace,
    projection: portableMintProjection(),
    instructions: "Synthetic instructions.",
    skills: [{ name: "core", description: "Synthetic", content: "Synthetic contract." }],
    deadline: Deadline.after(60_000),
    model: makeOpenAIMinter({
      getModel: () => ({
        getResponse: async (request) => {
          requests.push(request);
          return requests.length === 1
            ? call(
                "execute",
                {
                  purpose: "explore",
                  target: "pureFiles",
                  entrypoint: "src/tool.ts",
                  fixtureRefs: [],
                  caseFilter: [],
                  maxWorkers: 1,
                  timeoutSeconds: 30,
                  intent,
                },
                "step",
              )
            : reportBlocked;
        },
        getStreamedResponse: () => {
          throw new Error("Unused stream");
        },
      }),
    }),
    preflight: () => Effect.succeed({ supported: true }),
    reviewQuestion: () =>
      Effect.succeed({ outcome: "allow_business" as const, rationale: "Synthetic question." }),
    claimExample: Effect.die("An explore step must not claim the example"),
    authorizeResidual: Effect.fail(new MintFailure({ code: "ReconciliationRequired" })),
    reviewAndExecute: (request) =>
      Effect.sync(() => {
        notes.push(request.agentNote);
        return {
          executionId: "execution_one",
          status: "completed" as const,
          effect: "not_sent" as const,
          observations: { rows: 2 },
          review: {
            reviewId: "review_one",
            outcome: "allow" as const,
            rationale: "Reads the synthetic rows.",
            action: "read" as const,
            advice,
          },
        };
      }),
    publish: () => Effect.die("The attempt must not publish"),
  };
  await Effect.runPromise(
    runMint({
      mode: "mint",
      intent: "Return each listed item with its record number",
      businessInput: {},
      observations: [],
    }).pipe(Effect.provideService(MintServices, dependencies)),
  );
  expect(notes).toEqual([intent]);
  expect(toolResult(requests[1], "step")).toContain(advice);
});
