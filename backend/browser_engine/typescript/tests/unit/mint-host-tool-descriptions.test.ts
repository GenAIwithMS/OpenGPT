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

// The minter ends the synthetic attempt blocked, which stops the model at once.
const reportBlocked: ModelResponse = {
  usage: new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
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

/** A host with CAPTCHA telemetry and browser recovery, the two tools a host may describe. */
const hostTools = {
  captchaState: {
    read: () => Effect.succeed({ detected: false }),
    limit: 3,
    exhausted: { exhausted: true },
  },
  requestBrowserRecovery: () => Effect.die("The model never asks for a new browser here"),
} satisfies Partial<MintDependencies>;

/** The tool descriptions in the model's first request, by tool name. */
const offeredTools = async (host: Partial<MintDependencies>) => {
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
    claimExample: Effect.die("The synthetic attempt never claims the example"),
    authorizeResidual: Effect.fail(new MintFailure({ code: "ReconciliationRequired" })),
    reviewAndExecute: () => Effect.die("The synthetic attempt never executes"),
    publish: () => Effect.die("The synthetic attempt never publishes"),
    ...host,
  };
  await Effect.runPromise(
    runMint({
      mode: "mint",
      intent: "Read public data",
      businessInput: {},
      observations: [],
    }).pipe(Effect.provideService(MintServices, dependencies)),
  );
  // Every build sends every tool; the request's allowed_tools names those this build may call.
  const choice: unknown = requests[0]?.modelSettings.providerData?.["tool_choice"];
  const allowed =
    typeof choice === "object" && choice !== null && "tools" in choice && Array.isArray(choice.tools)
      ? new Set(choice.tools.map((tool: { readonly name?: string }) => tool.name))
      : undefined;
  return new Map(
    (requests[0]?.tools ?? []).flatMap((tool) =>
      tool.type === "function" && (allowed === undefined || allowed.has(tool.name))
        ? [[tool.name, tool.description] as const]
        : [],
    ),
  );
};

/*
 * A host that ships its own guidance for its optional tools describes them itself, and the model
 * sees exactly that text. A host that gives none gets generic text that sends the model to no
 * skill the package lacks. Without the host's tools, neither is offered.
 */
it("gives the model a host's tool descriptions in place of the generic ones", async () => {
  const hostText = {
    captchaState: "Host text for the CAPTCHA state.",
    requestBrowserRecovery: "Host text for a new browser.",
  };
  const described = await offeredTools({ ...hostTools, hostToolDescriptions: hostText });
  expect(described.get("captcha_state")).toBe(hostText.captchaState);
  expect(described.get("request_browser_recovery")).toBe(hostText.requestBrowserRecovery);

  const generic = await offeredTools(hostTools);
  for (const name of ["captcha_state", "request_browser_recovery"]) {
    expect(generic.get(name)).toEqual(expect.any(String));
    expect(generic.get(name)).not.toBe(described.get(name));
    expect(generic.get(name)).not.toContain(".agents/");
  }

  // A host may describe one tool and leave the other generic.
  const partial = await offeredTools({
    ...hostTools,
    hostToolDescriptions: { captchaState: hostText.captchaState },
  });
  expect(partial.get("captcha_state")).toBe(hostText.captchaState);
  expect(partial.get("request_browser_recovery")).toBe(generic.get("request_browser_recovery"));
});

it("offers neither optional tool without the host's tools, even with descriptions", async () => {
  const tools = await offeredTools({
    hostToolDescriptions: { captchaState: "Unused.", requestBrowserRecovery: "Unused." },
  });
  expect(tools.has("request_input")).toBe(true);
  expect(tools.has("captcha_state")).toBe(false);
  expect(tools.has("request_browser_recovery")).toBe(false);
});
