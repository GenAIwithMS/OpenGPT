// The local host's publication review sends its small files inline, as read_source returns them,
// so Guardian decides without a turn to read each; a large file, or one the secret check refuses,
// is left for Guardian to read.
import { OpenAIProvider, setDefaultModelProvider, Usage } from "@openai/agents";
import type { ModelProvider, ModelRequest } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { localRuntimeAssets } from "../../src/execution/local-runtime-assets.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import { inlineFilesNote } from "../../src/mint/publication-review.js";
import { requestContext } from "../../src/standalone/request-context.js";
import type { StandaloneSession } from "../../src/standalone/session.js";

afterEach(() => setDefaultModelProvider(new OpenAIProvider()));

/** Guardian's model: it allows each review at once and keeps each request. */
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
                    rationale: "The evidence supports the publication.",
                    reason: "approved",
                    findings: [],
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

/** The review input a request carries: the JSON message that holds the submitted call. */
const reviewInput = (request: ModelRequest | undefined): Readonly<Record<string, unknown>> => {
  const items =
    request === undefined
      ? []
      : typeof request.input === "string"
        ? [request.input]
        : request.input;
  const texts = items.flatMap((item) => {
    if (typeof item === "string") return [item];
    const content: unknown = Reflect.get(Object(item), "content");
    if (typeof content === "string") return [content];
    return Array.isArray(content)
      ? content.flatMap((part: unknown) => {
          const text: unknown = Reflect.get(Object(part), "text");
          return typeof text === "string" ? [text] : [];
        })
      : [];
  });
  for (const text of texts) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && "submitted_call" in parsed)
        return parsed as Readonly<Record<string, unknown>>;
    } catch {
      // Not the review input.
    }
  }
  throw new Error("The request holds no review input");
};

const definition = JSON.stringify({ name: "read_totals", description: "Read the totals" }, null, 2);
const exampleOutput = JSON.stringify({ state: "available", output: { total: 3 } });
const large = `export default 1;\n${"// a long comment line\n".repeat(1000)}`;

/** One local publication review of `files` against `evidence`, and the request Guardian got. */
const publish = async (
  files: ReadonlyMap<string, string>,
  evidence: ReadonlyMap<string, string>,
  secret?: string,
) => {
  const trustedSources = new Map(await Effect.runPromise(localRuntimeAssets));
  const secrets = makeRunSecrets();
  if (secret !== undefined) secrets.register(secret);
  const { requests, provider } = allowing();
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
  const reviewId = await Effect.runPromise(
    requestContext(session, {
      intent: "Read the totals",
      url: "https://totals.example.test/",
      effect: "read",
    }).pipe(
      Effect.flatMap((context) =>
        context.reviewPublication({
          entrypoint: "src/tool.mjs",
          files,
          allowedEffects: ["Publish the current operation bundle only."],
          notes: "Evidence note. Coverage: one example",
          evidence,
        }),
      ),
    ),
  );
  expect(typeof reviewId).toBe("string");
  const input = reviewInput(requests[0]);
  return {
    publication: input["trusted_publication"] as Readonly<Record<string, unknown>>,
    observations: String(input["untrusted_observations"]),
  };
};

it(
  "sends the local publication review its small files inline and says they need no read",
  { timeout: 15_000 },
  async () => {
    const { publication, observations } = await publish(
      new Map([
        ["src/tool.mjs", "export default 1;\n"],
        ["src/help.mjs", "export const help = 1;\n"],
      ]),
      new Map([
        ["publication/definition.json", definition],
        ["publication/example-output.json", exampleOutput],
      ]),
    );
    expect(publication["inline"]).toEqual([
      {
        path: "publication/definition.json",
        content: { name: "read_totals", description: "Read the totals" },
      },
      { path: "operation/src/tool.mjs", content: "export default 1;\n" },
      {
        path: "publication/example-output.json",
        content: { state: "available", output: { total: 3 } },
      },
    ]);
    expect(Object.keys(publication)).toEqual(["files", "inline"]);
    expect(observations.split("\n").at(-1)).toBe(
      `${inlineFilesNote} Evidence note. Coverage: one example`,
    );
  },
);

it(
  "leaves a large file and one the secret check refuses for Guardian to read",
  { timeout: 15_000 },
  async () => {
    const { publication, observations } = await publish(
      new Map([["src/tool.mjs", large]]),
      new Map([
        ["publication/definition.json", definition],
        [
          "publication/example-output.json",
          JSON.stringify({ state: "available", output: "Hunter-2-secret" }),
        ],
      ]),
      "Hunter-2-secret",
    );
    expect(publication["inline"]).toEqual([
      {
        path: "publication/definition.json",
        content: { name: "read_totals", description: "Read the totals" },
      },
    ]);
    expect(observations.split("\n").at(-1)?.startsWith(inlineFilesNote)).toBe(true);
  },
);

it("says nothing of inline files when none fits", { timeout: 15_000 }, async () => {
  const { publication, observations } = await publish(
    new Map([["src/tool.mjs", large]]),
    new Map([
      ["publication/definition.json", JSON.stringify({ name: "read_totals", description: large })],
    ]),
  );
  expect(publication).not.toHaveProperty("inline");
  expect(observations).not.toContain("trusted_publication.inline");
  expect(observations.split("\n").at(-1)).toBe("Evidence note. Coverage: one example");
});
