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

// The minting agent decides when a new browser can help and asks for one with its reason;
// the host reviews and replaces. A recorded model turn calls the tool through the minter.
it("hands the agent's reason to the host and returns what the host did", async () => {
  const workspace = await portableJobSession({ "src/tool.ts": "export {};" });
  cleanups.push(async () => {
    await workspace.close();
  });
  const reason = "The specialty list stays empty and its lookup failed at the proxy.";
  const requests: ModelRequest[] = [];
  const reasons: string[] = [];
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
            ? call("request_browser_recovery", { intent: reason }, "recover")
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
    claimExample: Effect.die("A recovery request must not claim the example"),
    authorizeResidual: Effect.fail(new MintFailure({ code: "ReconciliationRequired" })),
    reviewAndExecute: () => Effect.die("A recovery request must not execute"),
    publish: () => Effect.die("A recovery request must not publish"),
    requestBrowserRecovery: (rationale) =>
      Effect.sync(() => {
        reasons.push(rationale);
        return {
          outcome: "replaced" as const,
          notice: "The host replaced the browser, as you asked.",
          reviewId: "review-1",
        };
      }),
  };
  await Effect.runPromise(
    runMint({
      mode: "mint",
      intent: "Read public data",
      businessInput: {},
      observations: [],
    }).pipe(Effect.provideService(MintServices, dependencies)),
  );
  expect(reasons).toEqual([reason]);
  const result = toolResult(requests[1], "recover");
  expect(result).toContain("host_browser_recovery");
  expect(result).toContain("replaced");
});
