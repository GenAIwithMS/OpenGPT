import { OpenAIProvider, setDefaultModelProvider, Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import {
  makeGuardian,
  ReviewFailure,
  type GuardianDiagnostics,
  type PendingExecution,
  type ReviewRetry,
} from "../../src/guardian/review.js";
import { decodePublicationDecision } from "../../src/guardian/publication.js";
import { makeSourceInspector } from "../../src/guardian/source.js";
import { failureDetail } from "../../src/runtime/failure-detail.js";

afterEach(() => {
  setDefaultModelProvider(new OpenAIProvider());
});

const native = { executionEnvironment: nativeExecutionEnvironment };
const toolPath = "operation/src/tool.mjs";
const capturePath = "captures/results/dom.html";
// A multi-byte character before the quoted text, so a character index is not its byte offset.
const toolSource = [
  "// Synthetic café catalog reader",
  "export const read = async (page) => {",
  "  const price = await page.locator('.price').textContent().catch(() => null);",
  "  return { price };",
  "};",
].join("\n");
const definition = JSON.stringify(
  {
    name: "read_item",
    description: "Read one catalog item",
    outputSchema: { type: "object", properties: { price: { type: ["string", "null"] } } },
  },
  null,
  2,
);
const card = (index: number) =>
  `<li class="card"><span class="maker">Synthetic Maker ${index}</span><a>Item ${index}</a></li>`;
// About 300 KB of page capture, with one card the review asks about in the middle.
const capture = [
  "<html><body><ul>",
  ...Array.from({ length: 1500 }, () => `<li class="filler">${"x".repeat(180)}</li>`),
  card(7),
  ...Array.from({ length: 1500 }, () => `<li class="filler">${"y".repeat(180)}</li>`),
  "</ul></body></html>",
].join("\n");
const files = new Map([
  [toolPath, toolSource],
  ["publication/definition.json", definition],
  [capturePath, capture],
]);
const pending: PendingExecution = {
  invocationId: "invocation_speed",
  attemptId: "attempt_speed",
  entrypoint: toolPath,
  screenedIntent: "Read the item's price",
  screenedInput: "{}",
  screenedObservations: "Prior example completed; publication does not repeat it.",
  accountScope: "account_speed",
  allowedOrigins: [],
  allowedEffects: ["Publish current package only"],
  publication: {
    files: [...files].map(([path, source]) => ({
      path,
      byteLength: Buffer.byteLength(source),
      published: !path.startsWith("captures/"),
      current: true,
      owner: path === toolPath ? ("minter" as const) : ("host" as const),
    })),
  },
};
const inspector = (texts: ReadonlyMap<string, string>) =>
  makeSourceInspector(
    (path) =>
      Effect.suspend(() => {
        const text = texts.get(path);
        return text === undefined
          ? Effect.fail(new ReviewFailure({ code: "SourceUnavailable" }))
          : Effect.succeed(new TextEncoder().encode(text));
      }),
    (_path, bytes) => Effect.succeed(new TextDecoder().decode(bytes)),
  );
const sources = inspector(files);

const message = (value: unknown): ModelResponse["output"][number] => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: JSON.stringify(value) }],
});
const read = (path: string, extra: Record<string, unknown> = {}, callId = `read_${path}`) => ({
  type: "function_call" as const,
  callId,
  name: "read_source",
  status: "completed" as const,
  arguments: JSON.stringify({ path, offset: 0, match: null, ...extra }),
});
/** Recorded model turns. */
const recorded = (turns: readonly { output: ModelResponse["output"] }[]) => {
  const requests: ModelRequest[] = [];
  setDefaultModelProvider({
    getModel: () => ({
      getResponse: async (request) => {
        requests.push(request);
        const turn = turns[requests.length - 1];
        if (turn === undefined) throw new Error("No recorded turn");
        return { usage: new Usage(), output: turn.output };
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  });
  return requests;
};
const reviewer = () =>
  makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native);
const deny = (quote: string, path = toolPath) => ({
  outcome: "deny",
  reason: "source_correction",
  rationale: "A needed value is nullable.",
  findings: [
    {
      path,
      quote,
      category: "schema_mismatch",
      explanation: "The price turns a failed read into null; read it or throw.",
      route: null,
    },
  ],
  label: null,
  action: null,
});
const allow = {
  outcome: "allow",
  reason: "approved",
  rationale: "The evidence supports the claims.",
  findings: null,
  label: null,
  action: null,
};
const byteRange = (text: string, quote: string) => {
  const at = text.indexOf(quote);
  const byteStart = Buffer.byteLength(text.slice(0, at));
  return { byteStart, byteEnd: byteStart + Buffer.byteLength(quote) };
};

describe("a publication finding Guardian anchors by quote", () => {
  // The second quote spans a line break the model retyped as a space.
  it.each([
    { quote: ".catch(() => null)", text: ".catch(() => null)" },
    { quote: "null);   return { price };", text: "null);\n  return { price };" },
  ])("resolves to the quoted text's UTF-8 range, with no reread: $quote", async ({ quote, text }) => {
    const requests = recorded([{ output: [read(toolPath)] }, { output: [message(deny(quote))] }]);
    const { decision } = await Effect.runPromise(
      makeGuardian(reviewer()).review(pending, sources),
    );
    expect(decision).toMatchObject({
      outcome: "deny",
      reason: "source_correction",
      findings: [{ path: toolPath, category: "schema_mismatch", ...byteRange(toolSource, text) }],
    });
    expect(requests).toHaveLength(2);
  });

  it("keeps the denial at the whole file when the quote is not in it", async () => {
    recorded([{ output: [message(deny("text the file does not hold"))] }]);
    const { decision } = await Effect.runPromise(
      makeGuardian(reviewer()).review(pending, sources),
    );
    expect(decision).toMatchObject({
      outcome: "deny",
      findings: [{ path: toolPath, byteStart: 0, byteEnd: Buffer.byteLength(toolSource) }],
    });
  });
});

describe("a publication finding whose path is not exactly an indexed one", () => {
  const definitionPath = "publication/definition.json";
  // A JSON-pointer fragment after the file, and a path missing or adding a leading directory.
  it.each([
    { written: `${definitionPath}#/outputSchema/properties/price`, file: definitionPath },
    { written: "src/tool.mjs", file: toolPath },
    { written: `operation/${definitionPath}`, file: definitionPath },
  ])("is anchored in the file it names: $written", async ({ written, file }) => {
    const quote = file === toolPath ? ".catch(() => null)" : '"type": [';
    const requests = recorded([{ output: [message(deny(quote, written))] }]);
    const { decision } = await Effect.runPromise(
      makeGuardian(reviewer()).review(pending, sources),
    );
    expect(decision).toMatchObject({
      outcome: "deny",
      findings: [{ path: file, ...byteRange(files.get(file) ?? "", quote) }],
    });
    expect(requests).toHaveLength(1);
  });
});

describe("a quoted finding's path that names no one indexed file", () => {
  /** The host's own messages to the model in a request, after the review's first. */
  const followUps = (request: ModelRequest | undefined) => {
    const input = request?.input;
    return (typeof input === "string" ? [] : (input ?? []))
      .flatMap((item) =>
        typeof item === "object" && "role" in item && item.role === "user"
          ? [typeof item.content === "string" ? item.content : JSON.stringify(item.content)]
          : [],
      )
      .slice(1);
  };
  const reviewIn = (texts: Readonly<Record<string, string>>, written: string, exact: string) => {
    const indexed = new Map([[toolPath, toolSource], ...Object.entries(texts)]);
    const scoped: PendingExecution = {
      ...pending,
      publication: {
        files: [...indexed].map(([path, text]) => ({
          path,
          byteLength: Buffer.byteLength(text),
          published: true,
          current: !path.startsWith("executed/"),
          owner: "minter" as const,
        })),
      },
    };
    const requests = recorded([
      { output: [message(deny("export", written))] },
      { output: [message(deny("export", exact))] },
    ]);
    const result = Effect.runPromise(makeGuardian(reviewer()).review(scoped, inspector(indexed)));
    return { requests, result };
  };

  // Two files share as many trailing segments with the path, a file shares not even its name, and
  // an empty indexed file is named exactly beside a historical file of the same name.
  it.each([
    {
      texts: {
        "operation/a/index.js": "export const a = 1;",
        "operation/b/index.js": "export {};",
      },
      written: "index.js#/x",
      exact: "operation/b/index.js",
    },
    { texts: {}, written: "operation/src/unrelated.mjs", exact: toolPath },
    {
      texts: { "operation/src/empty.mjs": "", "executed/src/empty.mjs": "export const e = 1;" },
      written: "operation/src/empty.mjs",
      exact: "executed/src/empty.mjs",
    },
  ])("gets the follow-up naming it, never a guessed file: $written", async (scenario) => {
    const { requests, result } = reviewIn(scenario.texts, scenario.written, scenario.exact);
    const { decision } = await result;
    expect(decision).toMatchObject({ findings: [{ path: scenario.exact }] });
    expect(requests).toHaveLength(2);
    expect(followUps(requests[1])[0]).toContain(scenario.written);
  });

  it("matches an indexed file whose name holds a #", async () => {
    const path = "operation/src/a#b.mjs";
    const text = "// Synthetic\nexport const b = 2;";
    const { requests, result } = reviewIn({ [path]: text }, path, toolPath);
    const { decision } = await result;
    expect(decision).toMatchObject({ findings: [{ path, ...byteRange(text, "export") }] });
    expect(requests).toHaveLength(1);
  });
});

describe("a publication decision that does not decode", () => {
  const quickRetry: ReviewRetry = { delays: ["1 millis"], budget: "1 minute" };
  const unknownPath = "operation/src/missing.mjs";
  const run = (turns: readonly { output: ModelResponse["output"] }[]) => {
    const requests = recorded(turns);
    const names: string[] = [];
    const record: GuardianDiagnostics["emit"] = (name) => Effect.sync(() => void names.push(name));
    const guardian = makeGuardian(
      { ...reviewer(), retry: quickRetry },
      { emit: record, retainModelTranscript: record, retainScreenedSource: () => Effect.void },
    );
    const result = Effect.runPromise(Effect.either(guardian.review(pending, sources)));
    return { requests, names, result };
  };
  /** The host's own messages to the model in a request, after the review's first. */
  const followUps = (request: ModelRequest | undefined) => {
    const input = request?.input;
    return (typeof input === "string" ? [] : (input ?? []))
      .flatMap((item) =>
        typeof item === "object" && "role" in item && item.role === "user"
          ? [typeof item.content === "string" ? item.content : JSON.stringify(item.content)]
          : [],
      )
      .slice(1);
  };

  it("gets one follow-up in the same review naming the error and the indexed paths", async () => {
    const { requests, names, result } = run([
      { output: [message(deny(".catch(() => null)", unknownPath))] },
      { output: [message(deny(".catch(() => null)"))] },
    ]);
    expect(await result).toMatchObject({
      _tag: "Right",
      right: { decision: { outcome: "deny", findings: [{ path: toolPath }] } },
    });
    expect(requests).toHaveLength(2);
    const [followUp, ...rest] = followUps(requests[1]);
    expect(rest).toEqual([]);
    expect(followUp).toContain(unknownPath);
    for (const path of files.keys()) expect(followUp).toContain(path);
    expect(names.filter((name) => name === "guardian.started")).toHaveLength(1);
    expect(names).not.toContain("guardian.review_retried");
  });

  it("gets the follow-up for a host's own decoder's refusal too", async () => {
    const refusal = "Synthetic host check: the rationale names no host marker.";
    const requests = recorded([
      { output: [message(deny(".catch(() => null)"))] },
      { output: [message({ ...deny(".catch(() => null)"), rationale: "host-marker" })] },
    ]);
    const guardian = makeGuardian(
      reviewer(),
      undefined,
      {},
      {
        decodePublication: (scope, raw) =>
          decodePublicationDecision(scope, raw).pipe(
            Effect.filterOrFail(
              (decision) => decision.rationale === "host-marker",
              () =>
                new ReviewFailure({
                  code: "InvalidDecision",
                  failureDetail: failureDetail("guardian_dependency_failed", {
                    error: new Error(refusal),
                  }),
                }),
            ),
          ),
      },
    );
    const { decision } = await Effect.runPromise(guardian.review(pending, sources));
    expect(decision).toMatchObject({ rationale: "host-marker" });
    expect(requests).toHaveLength(2);
    expect(followUps(requests[1])[0]).toContain(refusal);
  });

  it("ends the review when the answer to the follow-up does not decode either", async () => {
    // A third response the host would accept: reviewing again would reach it.
    const { requests, names, result } = run([
      { output: [message(deny(".catch(() => null)", unknownPath))] },
      { output: [message(deny(".catch(() => null)", unknownPath))] },
      { output: [message(deny(".catch(() => null)"))] },
    ]);
    expect(await result).toMatchObject({ _tag: "Left", left: { code: "InvalidDecision" } });
    expect(requests).toHaveLength(2);
    expect(names).not.toContain("guardian.review_retried");
    expect(names.filter((name) => name === "guardian.failed")).toHaveLength(1);
  });
});

describe("a large capture in a publication review", () => {
  it("is queried for the text a question needs, so only the matching slices reach Guardian", async () => {
    const requests = recorded([
      { output: [read(capturePath, { match: "Synthetic Maker" })] },
      { output: [message(allow)] },
    ]);
    await Effect.runPromise(makeGuardian(reviewer()).review(pending, sources));
    const input = requests[1]?.input;
    const results = (typeof input === "string" ? [] : (input ?? [])).flatMap((item) =>
      typeof item === "object" && item.type === "function_call_result"
        ? [JSON.stringify(item.output)]
        : [],
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toContain("Synthetic Maker 7");
    expect(Buffer.byteLength(results[0] ?? "")).toBeLessThan(8 * 1024);
  });
});
