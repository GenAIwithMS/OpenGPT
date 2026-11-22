// Failure modes covered: the local host's Guardian turns a deny into a retried outage when the
// review read an SDK file that holds a value the caller gave, which the local secret check refuses
// on every read, so the build waits out the outage retry and never hears the deny.
import { OpenAIProvider, setDefaultModelProvider, Usage } from "@openai/agents";
import type { ModelProvider, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { localRuntimeAssets } from "../../src/execution/local-runtime-assets.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import { requestContext } from "../../src/standalone/request-context.js";
import type { StandaloneSession } from "../../src/standalone/session.js";

afterEach(() => setDefaultModelProvider(new OpenAIProvider()));

const output = (item: ModelResponse["output"][number]): ModelResponse["output"] => [item];

/**
 * Guardian's model for each review attempt: it reads `sdkPath`, then denies the step. `calls`
 * counts its model calls across attempts.
 */
const readThenDeny = (sdkPath: string) => {
  const state = { calls: 0 };
  const provider: ModelProvider = {
    getModel: () => ({
      getResponse: () => {
        state.calls++;
        return Promise.resolve({
          usage: new Usage(),
          output:
            state.calls % 2 === 1
              ? output({
                  type: "function_call",
                  callId: `call_${state.calls}`,
                  name: "read_source",
                  arguments: JSON.stringify({ path: sdkPath, offset: 0 }),
                  status: "completed",
                })
              : output({
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [
                    {
                      type: "output_text",
                      text: JSON.stringify({
                        outcome: "deny",
                        rationale: "Clicking submit-order places an order: a write in a read build.",
                        reason: null,
                        findings: null,
                        publicReason: null,
                        label: null,
                        action: "write",
                        refusal: "correctable",
                      }),
                    },
                  ],
                }),
        });
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  };
  return { state, provider };
};

it("keeps the local Guardian's deny after a read of an SDK file the secret check refuses", { timeout: 15_000 }, async () => {
  const trustedSources = new Map(await Effect.runPromise(localRuntimeAssets));
  const sdkPath = "runtime/authentication.js";
  expect(trustedSources.get(sdkPath)).toContain("password");
  // A sign-in password the caller gave, which also appears in the SDK's own source.
  const secrets = makeRunSecrets();
  secrets.register("password");
  const { state, provider } = readThenDeny(sdkPath);
  // The parts of a local session a review uses; the browser is never opened.
  const session = {
    options: { ask: () => Effect.die("unused"), guardianProvider: provider },
    policy: "{{ tenant_policy_config }}",
    secrets,
    trustedSources,
    projection: {
      text: (value: string) => Effect.sync(() => secrets.redact(value)),
      json: (value: unknown) => Effect.succeed(value),
      source: (_path: string, value: string) => Effect.succeed(value),
    },
    browser: { execute: () => Effect.void },
  } as unknown as StandaloneSession;
  const reviewed = await Effect.runPromise(
    requestContext(session, {
      intent: "Search the catalogue",
      url: "https://catalogue.example.test/",
      effect: "read",
    }).pipe(
      Effect.flatMap((context) =>
        context.review({
          entrypoint: "operation/src/tool.mjs",
          sources: new Map([["operation/src/tool.mjs", "await page.click('#submit-order');\n"]]),
          input: {},
          currentExecution: { purpose: "explore", target: "liveBrowser" },
        }),
      ),
      Effect.either,
    ),
  );
  expect(reviewed).toMatchObject({
    _tag: "Left",
    left: { code: "ReviewDenied", review: { outcome: "deny" } },
  });
  // One attempt: the read and the decision, never an outage retry.
  expect(state.calls).toBe(2);
});
