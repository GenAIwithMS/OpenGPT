import { Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect, Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { MintFailure, MintServices } from "../../src/mint/contracts.js";
import type { MintDependencies, MintEntryNavigation } from "../../src/mint/contracts.js";
import { runMint } from "../../src/mint/harness.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { Deadline } from "../../src/runtime/deadline.js";
import { portableJobSession, portableMintProjection } from "../support/portable-mint.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const usage = () => new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 });
// The minter ends the synthetic attempt blocked, which stops the model at once.
const reportBlocked: ModelResponse = {
  usage: usage(),
  output: [
    {
      type: "function_call",
      name: "report_blocked",
      callId: "blocked",
      arguments: JSON.stringify({
        reason: "site_lacks_capability",
        explanation: "The synthetic site offers nothing to read.",
        intent: "End the synthetic attempt.",
      }),
      status: "completed",
    },
  ],
};

const FirstInput = Schema.parseJson(
  Schema.Struct({
    screenedRequest: Schema.Unknown,
    hostEntryNavigation: Schema.optional(
      Schema.Struct({
        state: Schema.String,
        outcome: Schema.String,
        reason: Schema.optional(Schema.String),
        requestedUrl: Schema.String,
        instruction: Schema.String,
      }),
    ),
  }),
);

// The agent's first input, as the model receives it.
const firstInput = (request: ModelRequest | undefined) => {
  const input = request?.input;
  if (!Array.isArray(input)) throw new Error("Missing history");
  for (const item of input) {
    if (!("role" in item) || item.role !== "user") continue;
    const content: unknown = item.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((part: unknown) =>
                typeof part === "object" && part !== null && "text" in part ? String(part.text) : "",
              )
              .join("")
          : "";
    const decoded = Schema.decodeUnknownOption(FirstInput)(text);
    if (decoded._tag === "Some") return decoded.value;
  }
  throw new Error("Missing first input");
};

const attempt = async (overrides: Partial<MintDependencies>) => {
  const workspace = await portableJobSession({ "src/tool.ts": "export {};" });
  cleanups.push(async () => {
    await workspace.close();
  });
  const requests: ModelRequest[] = [];
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
          return reportBlocked;
        },
        getStreamedResponse: () => {
          throw new Error("Unused stream");
        },
      }),
    }),
    preflight: () => Effect.succeed({ supported: true }),
    reviewQuestion: () =>
      Effect.succeed({ outcome: "allow_business" as const, rationale: "Synthetic question." }),
    claimExample: Effect.die("The attempt must not claim the example"),
    authorizeResidual: Effect.fail(new MintFailure({ code: "ReconciliationRequired" })),
    reviewAndExecute: () => Effect.die("The attempt must not execute"),
    publish: () => Effect.die("The attempt must not publish"),
    ...overrides,
  };
  await Effect.runPromise(
    runMint({
      mode: "mint",
      intent: "Submit the synthetic form",
      businessInput: {},
      observations: [],
    }).pipe(Effect.provideService(MintServices, dependencies)),
  );
  return firstInput(requests[0]);
};

const entryUrl = "https://example.test/apply";

// A host that skipped the entry page because an earlier attempt already ran on the website says
// so, so the agent reads back before it writes.
it("tells the agent the host skipped the entry page after an earlier attempt", async () => {
  const skipped: MintEntryNavigation = {
    state: "not_opened",
    outcome: "skipped",
    reason: "prior_effect",
    requestedUrl: entryUrl,
  };
  const input = await attempt({ entryNavigation: () => skipped });
  expect(input.hostEntryNavigation).toMatchObject({
    state: "not_opened",
    outcome: "skipped",
    reason: "prior_effect",
    requestedUrl: entryUrl,
  });
});

it("gives no earlier-attempt reason for an entry page that failed to load", async () => {
  const failed: MintEntryNavigation = {
    state: "not_opened",
    outcome: "failed",
    requestedUrl: entryUrl,
  };
  const input = await attempt({ entryNavigation: () => failed });
  expect(input.hostEntryNavigation).toMatchObject({ state: "not_opened", outcome: "failed" });
  expect(input.hostEntryNavigation?.reason).toBeUndefined();
});
