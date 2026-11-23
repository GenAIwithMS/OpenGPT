// Failure modes covered: the local host leaves the agent's note on a step out of its execution
// review, or sends a value the caller gave privately through it unredacted.
import { OpenAIProvider, setDefaultModelProvider, Usage } from "@openai/agents";
import type { ModelProvider, ModelRequest } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { localRuntimeAssets } from "../../src/execution/local-runtime-assets.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import { requestContext } from "../../src/standalone/request-context.js";
import type { StandaloneSession } from "../../src/standalone/session.js";

afterEach(() => setDefaultModelProvider(new OpenAIProvider()));

/** Guardian's model: it records each request and allows the step as a read. */
const allowing = () => {
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    getModel: () => ({
      getResponse: (request) => {
        requests.push(request);
        return Promise.resolve({
          usage: new Usage(),
          output: [
            {
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    outcome: "allow",
                    rationale: "Reads the account page.",
                    reason: null,
                    findings: null,
                    publicReason: null,
                    label: null,
                    action: "read",
                    refusal: null,
                    refusalGround: null,
                    advice: null,
                  }),
                },
              ],
            },
          ],
        });
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  };
  return { requests, provider };
};

it("sends the agent's note on a step to its review with private values redacted", async () => {
  const secrets = makeRunSecrets();
  secrets.register("member-7731");
  const { requests, provider } = allowing();
  // The parts of a local session a review uses; the browser is never opened.
  const session = {
    options: { ask: () => Effect.die("unused"), guardianProvider: provider },
    policy: "{{ tenant_policy_config }}",
    secrets,
    trustedSources: new Map(await Effect.runPromise(localRuntimeAssets)),
    projection: {
      text: (value: string) => Effect.sync(() => secrets.redact(value)),
      json: (value: unknown) => Effect.succeed(value),
      source: (_path: string, value: string) => Effect.succeed(value),
    },
    browser: { execute: () => Effect.void },
  } as unknown as StandaloneSession;
  await Effect.runPromise(
    requestContext(session, {
      intent: "Read the account page",
      url: "https://account.example.test/",
      effect: "read",
    }).pipe(
      Effect.flatMap((context) =>
        context.review({
          entrypoint: "operation/src/tool.mjs",
          sources: new Map([["operation/src/tool.mjs", "await page.textContent('main');\n"]]),
          input: {},
          currentExecution: { purpose: "explore", target: "liveBrowser" },
          agentNote: "Read the account page for member-7731 to find the plan name.",
        }),
      ),
    ),
  );
  const input = requests[0]?.input;
  const items = Array.isArray(input) ? input : [{ role: "user", content: input }];
  const request = items.flatMap((item) =>
    "role" in item && item.role === "user" && typeof item.content === "string"
      ? [JSON.parse(item.content) as { submitted_call: { agentNote?: string } }]
      : [],
  )[0];
  const note = request?.submitted_call.agentNote;
  expect(note).toMatch(/^Read the account page for .+ to find the plan name\.$/u);
  expect(note).not.toContain("member-7731");
});
