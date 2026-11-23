import { Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { MintFailure } from "../../src/mint/contracts.js";
import type { MintDependencies } from "../../src/mint/contracts.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { makeMintContinuationFixture } from "../support/mint-fixtures.js";
import { portableJobSession } from "../support/portable-mint.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);

const usage = () => new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 });
const intentTools = new Set(["execute", "finish_build", "request_input", "report_blocked"]);
const call = (name: string, input: object, callId = name): ModelResponse => ({
  usage: usage(),
  output: [
    {
      type: "function_call",
      name,
      callId,
      arguments: JSON.stringify(
        intentTools.has(name) && !("intent" in input)
          ? { ...input, intent: `Synthetic ${name} purpose` }
          : input,
      ),
      status: "completed",
    },
  ],
});
const prose = (): ModelResponse => ({
  usage: usage(),
  output: [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "I stopped." }],
    },
  ],
});
const execution = (purpose: "explore" | "example") => ({
  purpose,
  target: "pureFiles",
  entrypoint: "src/tool.ts",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 30,
});
const toolResult = (request: ModelRequest | undefined, callId: string) => {
  const input = request?.input;
  if (!Array.isArray(input)) throw new Error("Missing history");
  return JSON.stringify(
    input.find((item) => item.type === "function_call_result" && item.callId === callId),
  );
};

/** A synthetic host-private value the agent read and might repeat to its caller. */
const reference = "acct_ref_example";
const redactCallerText = (text: string) => text.replaceAll(reference, "[account reference]");

/** The agent quotes the value in every caller-visible part of a request, then in a blocked ending. */
const quotingAgent = (_request: ModelRequest, index: number) =>
  index === 0
    ? call("execute", execution("explore"))
    : index === 1
      ? call("request_input", {
          notice: `Orders are listed under ${reference}.`,
          questions: [
            {
              id: "order",
              type: "choice",
              prompt: `Is order 1 under ${reference} the one to keep?`,
              options: [
                { id: "keep", label: `Keep it (${reference})` },
                {
                  id: "saved",
                  label: "Saved card",
                  accountSpecific: true,
                  maskedLabel: `Card ${reference}`,
                },
              ],
            },
            {
              id: "note",
              type: "confirm",
              prompt: "Add a note to the order?",
              followUp: { prompt: `The note for ${reference}`, defaultText: `From ${reference}` },
            },
          ],
        })
      : index === 2
        ? call("report_blocked", {
            reason: "site_lacks_capability",
            explanation: `Order 1 already exists for ${reference}.`,
          })
        : prose();

it.each([
  { name: "a host redaction", hook: { redactCallerText }, shown: "[account reference]" },
  { name: "no host redaction", hook: {}, shown: reference },
])(
  "shows the caller each request field and the blocked explanation after $name",
  async ({ hook, shown }) => {
    const answered: unknown[] = [];
    const overrides: Partial<MintDependencies> = {
      ...hook,
      askInput: (input) =>
        Effect.sync(() => {
          answered.push(input);
          return {
            order: { type: "choice" as const, value: "keep" },
            note: { type: "confirm" as const, value: { confirmed: false } },
          };
        }),
    };
    const f = await fixture(quotingAgent, overrides);
    const outcome = await f.run();
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({
      notice: `Orders are listed under ${shown}.`,
      questions: [
        {
          prompt: `Is order 1 under ${shown} the one to keep?`,
          options: [{ label: `Keep it (${shown})` }, { maskedLabel: `Card ${shown}` }],
        },
        { followUp: { prompt: `The note for ${shown}`, defaultText: `From ${shown}` } },
      ],
    });
    expect(outcome.blocked).toEqual({
      reason: "site_lacks_capability",
      explanation: `Order 1 already exists for ${shown}.`,
    });
    // The agent's own transcript keeps what it wrote; only what the caller reads changes.
    expect(JSON.stringify(f.requests[2]?.input)).toContain(reference);
  },
);

it.each([
  { section: "loginUrl", fix: "Run authenticate again with the site's plain sign-in page" },
  { section: "description", fix: "Rewrite the description in finish_build's metadata" },
  { section: "site", fix: "Rewrite siteName and siteSummary in finish_build's metadata" },
  { section: "inputSchema", fix: "Edit the operation's schemas and questions in its source" },
  { section: undefined, fix: "Remove it from the metadata, the operation's schemas" },
])(
  "tells the agent how to remove an account reference from the definition's $section",
  async ({ section, fix }) => {
    const attempts: string[] = [];
    const f = await fixture(
      (_request, index) =>
        index === 0
          ? call("execute", execution("example"))
          : index === 1
            ? call("finish_build", {
                entrypoint: "src/tool.ts",
                executionId: "execution_one",
                metadata: { name: "read_public", description: "Read public data" },
                coverage: "One actual example.",
              })
            : prose(),
      {
        publish: (request) =>
          Effect.sync(() => attempts.push(request.executionId)).pipe(
            Effect.zipRight(
              Effect.fail(
                new MintFailure({
                  code: "PublicationUnavailable",
                  reason: "definition_login_reference",
                  screening: {
                    category: "schema",
                    path: "publication/definition.json",
                    ...(section === undefined ? {} : { section }),
                    replacements: 0,
                  },
                }),
              ),
            ),
          ),
      },
    );
    await f.run();
    expect(attempts).toEqual(["execution_one"]);
    const result = JSON.parse(JSON.parse(toolResult(f.requests[2], "finish_build")).output.text);
    expect(result).toMatchObject({
      status: "not_published",
      reason: "definition_login_reference",
      ...(section === undefined ? {} : { section }),
    });
    expect(result.instruction).toContain(fix);
    expect(result.instruction).toContain("the same executionId");
  },
);
