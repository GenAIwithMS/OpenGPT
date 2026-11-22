import { OpenAIProvider, setDefaultModelProvider, Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import { makeGuardian, ReviewFailure, type PendingExecution } from "../../src/guardian/review.js";
import { GuardianSessionSnapshot } from "../../src/guardian/session.js";
import { makeSourceInspector } from "../../src/guardian/source.js";
import { publicationDeltaPolicy } from "../../src/guardian/publication-delta.js";
import { instructionsOf } from "../support/guardian-requests.js";

afterEach(() => {
  setDefaultModelProvider(new OpenAIProvider());
});

const native = { executionEnvironment: nativeExecutionEnvironment };
const toolPath = "operation/src/tool.mjs";
const helperPath = "operation/src/format.mjs";
const definitionPath = "publication/definition.json";
const outputPath = "publication/example-output.json";

// Long enough that a one-line change's diff is shorter than the file.
const fields = ["brand", "rating", "availability", "seller", "badge", "sku", "size", "color"];
const toolSource = (priceRead: string) =>
  [
    "// Synthetic catalog reader",
    'import { money } from "./format.mjs";',
    ...fields.map(
      (field) => `const read_${field} = (page) => page.locator('.${field}').textContent();`,
    ),
    "export const read = async (page) => {",
    "  const title = await page.locator('h1').textContent();",
    priceRead,
    `  const details = { ${fields.map((field) => `${field}: await read_${field}(page)`).join(", ")} };`,
    "  return { title, price: money(price), ...details };",
    "};",
    ...fields.map(
      (field) => `export const ${field}Label = ${JSON.stringify(`The item's ${field}`)};`,
    ),
    "",
  ].join("\n");
const nullablePrice =
  "  const price = await page.locator('.price').textContent().catch(() => null);";
const strictPrice = "  const price = await page.locator('.price').textContent();";
// A helper long enough that seeing its body in a request means it was sent in full.
const helperSource = [
  "// Formats a price exactly as the page shows it.",
  ...Array.from({ length: 30 }, (_, index) => `// helper detail line ${index} unique-helper-body`),
  "export const money = (text) => text.trim();",
  "",
].join("\n");
const definition = (priceType: unknown) =>
  JSON.stringify(
    {
      name: "read_item",
      description: "Read one catalog item's title and price",
      inputSchema: { type: "object", properties: {} },
      outputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "The item's title as the page shows it" },
          price: { type: priceType },
          ...Object.fromEntries(
            fields.map((field) => [field, { type: "string", description: `The item's ${field}` }]),
          ),
        },
      },
    },
    null,
    2,
  );
const exampleOutput = JSON.stringify({
  state: "available",
  output: '{"title":"Lamp","price":"$5"}',
});

type Files = ReadonlyMap<string, string>;
const roundOne: Files = new Map([
  [toolPath, toolSource(nullablePrice)],
  [helperPath, helperSource],
  [definitionPath, definition(["string", "null"])],
  [outputPath, exampleOutput],
]);
const roundTwo: Files = new Map([
  [toolPath, toolSource(strictPrice)],
  [helperPath, helperSource],
  [definitionPath, definition("string")],
  [outputPath, exampleOutput],
]);

const pendingFor = (files: Files, extra: Partial<PendingExecution> = {}): PendingExecution => ({
  invocationId: "invocation_delta",
  attemptId: "attempt_delta",
  entrypoint: toolPath,
  screenedIntent: "Read the item's title and price",
  screenedInput: "{}",
  screenedObservations: "The example completed.",
  accountScope: "account_delta",
  allowedOrigins: ["https://catalog.example.test"],
  allowedEffects: ["Publish the current operation bundle only"],
  publication: {
    files: [...files].map(([path, source]) => ({
      path,
      byteLength: Buffer.byteLength(source),
      published: !path.startsWith("publication/") || path === definitionPath,
      current: true,
      owner: path.startsWith("operation/") ? ("minter" as const) : ("host" as const),
    })),
  },
  ...extra,
});
const reader = (files: Files) =>
  makeSourceInspector(
    (path) =>
      Effect.suspend(() => {
        const text = files.get(path);
        return text === undefined
          ? Effect.fail(new ReviewFailure({ code: "SourceUnavailable" }))
          : Effect.succeed(new TextEncoder().encode(text));
      }),
    (_path, bytes) => Effect.succeed(new TextDecoder().decode(bytes)),
  );

const message = (value: unknown): ModelResponse["output"][number] => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: JSON.stringify(value) }],
});
const readCall = (path: string, callId = `read_${path}`): ModelResponse["output"][number] => ({
  type: "function_call",
  callId,
  name: "read_source",
  status: "completed",
  arguments: JSON.stringify({ path, offset: 0, match: null }),
});
const searchCall = (path: string, match: string): ModelResponse["output"][number] => ({
  type: "function_call",
  callId: `search_${path}`,
  name: "read_source",
  status: "completed",
  arguments: JSON.stringify({ path, offset: 0, match }),
});
const compaction: ModelResponse["output"][number] = {
  type: "compaction",
  id: "cmp_publication",
  encrypted_content: "opaque-compacted-publication-context",
};
const deny = {
  outcome: "deny",
  reason: "source_correction",
  rationale: "The price is a needed value, yet a failed read becomes null.",
  findings: [
    {
      path: toolPath,
      quote: ".catch(() => null)",
      category: "schema_mismatch",
      explanation: "A failed price read returns null; read the price or throw.",
      route: null,
    },
    {
      path: definitionPath,
      quote: '"null"',
      category: "schema_mismatch",
      explanation: "The output schema lets the needed price be null; make it a string.",
      route: null,
    },
  ],
  label: null,
  action: null,
};
const allow = {
  outcome: "allow",
  reason: "approved",
  rationale: "The price is read and required.",
  findings: null,
  label: null,
  action: null,
};

/** Recorded model turns, in order; each request is kept. */
const recorded = (turns: readonly ModelResponse["output"][]) => {
  const requests: ModelRequest[] = [];
  setDefaultModelProvider({
    getModel: () => ({
      getResponse: async (request) => {
        requests.push(request);
        const output = turns[requests.length - 1];
        if (output === undefined) throw new Error("No recorded turn");
        return { usage: new Usage(), output };
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

/** The newest review request in a model request, parsed. */
const reviewRequest = (request: ModelRequest | undefined): Record<string, unknown> => {
  const input = request?.input;
  const items = typeof input === "string" ? [] : (input ?? []);
  const requests = items.flatMap((item) =>
    typeof item === "object" &&
    "role" in item &&
    item.role === "user" &&
    typeof item.content === "string" &&
    item.content.startsWith("{")
      ? [item.content]
      : [],
  );
  const last = requests.at(-1);
  if (last === undefined) throw new Error("No review request");
  return JSON.parse(last) as Record<string, unknown>;
};

const DeltaFile = Schema.Struct({
  path: Schema.String,
  status: Schema.Literal(
    "unchanged",
    "unchanged_unread",
    "changed",
    "added",
    "removed",
    "not_compared",
  ),
  digest: Schema.optional(Schema.String),
  previousDigest: Schema.optional(Schema.String),
  byteLength: Schema.optional(Schema.Number),
  diff: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  index: Schema.optional(Schema.Unknown),
});
const Delta = Schema.Struct({
  priorReview: Schema.Struct({
    outcome: Schema.String,
    reason: Schema.optional(Schema.String),
    rationale: Schema.String,
    findings: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        category: Schema.String,
        explanation: Schema.String,
        quote: Schema.optional(Schema.String),
        byteStart: Schema.Number,
        byteEnd: Schema.Number,
      }),
    ),
  }),
  files: Schema.Array(DeltaFile),
  changedContext: Schema.optional(Schema.Array(Schema.String)),
});
const deltaOf = (request: ModelRequest | undefined) =>
  Schema.decodeUnknownSync(Delta)(reviewRequest(request)["publication_delta"]);
const fileIn = (delta: typeof Delta.Type, path: string) => {
  const file = delta.files.find((entry) => entry.path === path);
  if (file === undefined) throw new Error(`No delta entry for ${path}`);
  return file;
};

describe("a publication reviewed again in the same build", () => {
  it("does not count a file Guardian only searched as read in a later round", async () => {
    const requests = recorded([
      [readCall(toolPath), searchCall(helperPath, "export"), readCall(definitionPath)],
      [message(deny)],
      [readCall(toolPath, "read_tool_again")],
      [message(allow)],
    ]);
    const guardian = makeGuardian(reviewer(), undefined, {});
    await Effect.runPromise(guardian.review(pendingFor(roundOne), reader(roundOne)));
    await Effect.runPromise(guardian.review(pendingFor(roundTwo), reader(roundTwo)));
    // The search showed only slices around each match, so the helper is judged as in a first
    // review; the definition Guardian read whole changed, and is diffed as before.
    expect(fileIn(deltaOf(requests[2]), helperPath).status).toBe("unchanged_unread");
    expect(fileIn(deltaOf(requests[2]), definitionPath).status).toBe("changed");
  });

  it("still sends a search's reads through a host's own readSource wrapper", async () => {
    recorded([[searchCall(helperPath, "export")], [message(deny)]]);
    const wrapped: string[] = [];
    const base = reviewer();
    const hostReviewer = {
      ...base,
      run: (turn: Parameters<typeof base.run>[0]) =>
        base.run({
          ...turn,
          readSource: (path: string, offset: number) => {
            wrapped.push(path);
            return turn.readSource(path, offset);
          },
        }),
    };
    await Effect.runPromise(
      makeGuardian(hostReviewer, undefined, {}).review(pendingFor(roundOne), reader(roundOne)),
    );
    expect(wrapped).toContain(helperPath);
  });

  it("sends the prior decision and only what changed, and a first round as before", async () => {
    const requests = recorded([
      [readCall(toolPath), readCall(helperPath), readCall(definitionPath)],
      [message(deny)],
      [readCall(toolPath, "read_tool_again")],
      [message(allow)],
    ]);
    const guardian = makeGuardian(reviewer(), undefined, {});
    const first = await Effect.runPromise(guardian.review(pendingFor(roundOne), reader(roundOne)));
    expect(first.decision.outcome).toBe("deny");
    // A first round carries no delta: the reviewer reads the full files it needs.
    expect(reviewRequest(requests[0])).not.toHaveProperty("publication_delta");
    expect(JSON.stringify(requests[1]?.input)).toContain("unique-helper-body");

    const second = await Effect.runPromise(guardian.review(pendingFor(roundTwo), reader(roundTwo)));
    expect(second.decision).toMatchObject({ outcome: "allow", reason: "approved" });
    const delta = deltaOf(requests[2]);
    expect(delta.priorReview).toMatchObject({
      outcome: "deny",
      reason: "source_correction",
      rationale: deny.rationale,
      findings: [
        {
          path: toolPath,
          category: "schema_mismatch",
          explanation: deny.findings[0]?.explanation,
          quote: ".catch(() => null)",
        },
        { path: definitionPath, category: "schema_mismatch", quote: '"null"' },
      ],
    });
    const tool = fileIn(delta, toolPath);
    expect(tool.status).toBe("changed");
    expect(tool.digest).not.toBe(tool.previousDigest);
    expect(tool.diff?.split("\n")).toEqual(
      expect.arrayContaining([`-${nullablePrice}`, `+${strictPrice}`]),
    );
    expect(tool.content).toBeUndefined();
    expect(fileIn(delta, definitionPath)).toMatchObject({ status: "changed" });
    expect(fileIn(delta, definitionPath).diff).toContain('+        "type": "string"');
    // The unchanged helper is listed by digest, never sent again.
    const helper = fileIn(delta, helperPath);
    expect(helper).toMatchObject({ status: "unchanged" });
    expect(helper.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(helper.diff).toBeUndefined();
    expect(helper.content).toBeUndefined();
    // No review read the example output, so the delta does not let Guardian leave it alone.
    expect(fileIn(delta, outputPath).status).toBe("unchanged_unread");
    const secondRequest = (requests[2]?.input ?? []) as readonly unknown[];
    expect(JSON.stringify(secondRequest.at(-1))).not.toContain("unique-helper-body");
    // The reviewer may still read any file it needs.
    expect(reviewRequest(requests[2])).toHaveProperty("trusted_publication.files");
    // Only the later round is told to review it as a delta.
    const policyOf = (request: ModelRequest | undefined) =>
      String(Reflect.get(Object(reviewRequest(request)["trusted_review"]), "policy"));
    expect(policyOf(requests[0])).not.toContain(publicationDeltaPolicy);
    expect(policyOf(requests[2])).toContain(publicationDeltaPolicy);
    expect(instructionsOf(requests[2])).not.toContain(publicationDeltaPolicy);
  });

  it("reaches a host that sends its own publication policy and index", async () => {
    const requests = recorded([[message(deny)], [message(allow)]]);
    const hosted = makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, {
      ...native,
      specialize: (turn) =>
        turn.pending.publication === undefined
          ? {}
          : {
              policy: "Synthetic host publication policy.",
              input: { trusted_publication: turn.pending.publication },
            },
    });
    const guardian = makeGuardian(hosted, undefined, {});
    await Effect.runPromise(guardian.review(pendingFor(roundOne), reader(roundOne)));
    await Effect.runPromise(guardian.review(pendingFor(roundTwo), reader(roundTwo)));
    expect(fileIn(deltaOf(requests[1]), toolPath).status).toBe("changed");
    const policy = String(
      Reflect.get(Object(reviewRequest(requests[1])["trusted_review"]), "policy"),
    );
    expect(policy).toContain("Synthetic host publication policy.");
    expect(policy).toContain(publicationDeltaPolicy);
  });

  it("still gets the prior findings after a compaction folded the earlier round away", async () => {
    const requests = recorded([
      [readCall(toolPath)],
      [compaction, message(deny)],
      [message(allow)],
    ]);
    const guardian = makeGuardian(reviewer(), undefined, {});
    await Effect.runPromise(guardian.review(pendingFor(roundOne), reader(roundOne)));
    await Effect.runPromise(guardian.review(pendingFor(roundTwo), reader(roundTwo)));
    const input = JSON.stringify(requests[2]?.input);
    // The earlier request is gone from the conversation; only the compaction stands for it.
    expect(input).toContain("opaque-compacted-publication-context");
    expect(input).not.toContain("unique-helper-body");
    const delta = deltaOf(requests[2]);
    expect(delta.priorReview.findings.map((finding) => finding.quote)).toEqual([
      ".catch(() => null)",
      '"null"',
    ]);
    expect(fileIn(delta, toolPath).status).toBe("changed");
  });

  it("keeps the prior round across a takeover that resumes the saved conversation", async () => {
    const requests = recorded([[readCall(helperPath)], [message(deny)], [message(allow)]]);
    const first = makeGuardian(reviewer(), undefined, {});
    await Effect.runPromise(first.review(pendingFor(roundOne), reader(roundOne)));
    const replacement = makeGuardian(reviewer(), undefined, {
      initial: Schema.decodeUnknownSync(GuardianSessionSnapshot)(
        JSON.parse(JSON.stringify(first.session?.snapshot())),
      ),
    });
    await Effect.runPromise(replacement.review(pendingFor(roundTwo), reader(roundTwo)));
    const delta = deltaOf(requests[2]);
    expect(delta.priorReview.outcome).toBe("deny");
    expect(fileIn(delta, helperPath).status).toBe("unchanged");
    expect(fileIn(delta, toolPath).status).toBe("changed");
  });

  it("compares each round with the one before it, so a file left alone once shows when it changes", async () => {
    const roundThree: Files = new Map([
      ...roundTwo,
      [helperPath, helperSource.replace("text.trim()", "text.trim().replace(/\\s+/gu, ' ')")],
    ]);
    const requests = recorded([
      [readCall(helperPath), readCall(toolPath)],
      [message(deny)],
      [readCall(toolPath, "read_tool_again")],
      [message(deny)],
      [message(allow)],
    ]);
    const guardian = makeGuardian(reviewer(), undefined, {});
    await Effect.runPromise(guardian.review(pendingFor(roundOne), reader(roundOne)));
    await Effect.runPromise(guardian.review(pendingFor(roundTwo), reader(roundTwo)));
    await Effect.runPromise(guardian.review(pendingFor(roundThree), reader(roundThree)));
    expect(fileIn(deltaOf(requests[2]), helperPath).status).toBe("unchanged");
    const third = deltaOf(requests[4]);
    expect(fileIn(third, helperPath).status).toBe("changed");
    expect(fileIn(third, helperPath).diff).toContain(
      "+export const money = (text) => text.trim().replace(",
    );
    // The tool did not change since the second round, which read it.
    expect(fileIn(third, toolPath).status).toBe("unchanged");
  });

  it("lists added, removed and re-indexed files, and context that changed", async () => {
    const addedPath = "operation/src/parse.mjs";
    const changedFiles: Files = new Map([
      [toolPath, toolSource(strictPrice)],
      [definitionPath, definition("string")],
      [outputPath, exampleOutput],
      [addedPath, "export const parse = (text) => text;\n"],
    ]);
    const requests = recorded([[message(deny)], [message(allow)]]);
    const guardian = makeGuardian(reviewer(), undefined, {});
    await Effect.runPromise(guardian.review(pendingFor(roundOne), reader(roundOne)));
    const later = pendingFor(changedFiles, {
      answeredQuestions: [
        { id: "price_format", question: "Which price?", answer: "The sale price" },
      ],
    });
    const reindexed: PendingExecution = {
      ...later,
      publication: {
        files: (later.publication?.files ?? []).map((file) =>
          file.path === outputPath ? { ...file, current: false } : file,
        ),
      },
    };
    await Effect.runPromise(guardian.review(reindexed, reader(changedFiles)));
    const delta = deltaOf(requests[1]);
    expect(fileIn(delta, addedPath)).toMatchObject({
      status: "added",
      content: "export const parse = (text) => text;\n",
    });
    expect(fileIn(delta, helperPath)).toMatchObject({ status: "removed" });
    expect(fileIn(delta, outputPath)).toMatchObject({
      status: "unchanged_unread",
      index: { current: { from: true, to: false } },
    });
    expect(delta.changedContext).toEqual(["trusted_authority.answeredQuestions"]);
  });

  it("sends a changed file whole when its diff would be longer, and only names one too large to send", async () => {
    const largePath = "publication/tests.json";
    const large = (marker: string) =>
      JSON.stringify({ cases: Array.from({ length: 4000 }, (_, index) => `${marker}-${index}`) });
    const before: Files = new Map([
      ...roundOne,
      ["operation/src/tiny.mjs", "export const a = 1;\n"],
      [largePath, large("before")],
    ]);
    const after: Files = new Map([
      ...roundOne,
      ["operation/src/tiny.mjs", "export const b = 2;\n"],
      [largePath, large("after")],
    ]);
    const requests = recorded([[message(deny)], [message(allow)]]);
    const guardian = makeGuardian(reviewer(), undefined, {});
    await Effect.runPromise(guardian.review(pendingFor(before), reader(before)));
    await Effect.runPromise(guardian.review(pendingFor(after), reader(after)));
    const delta = deltaOf(requests[1]);
    expect(fileIn(delta, "operation/src/tiny.mjs")).toMatchObject({
      status: "changed",
      content: "export const b = 2;\n",
    });
    expect(fileIn(delta, "operation/src/tiny.mjs").diff).toBeUndefined();
    const tests = fileIn(delta, largePath);
    expect(tests.status).toBe("changed");
    expect(tests.diff).toBeUndefined();
    expect(tests.content).toBeUndefined();
    expect(JSON.stringify(reviewRequest(requests[1]))).not.toContain("after-3999");
  });
});

describe("what a later round may leave alone", () => {
  it("names unchanged files no review read, and carries a read forward only while the file is unchanged", async () => {
    const requests = recorded([
      [readCall(definitionPath)],
      [message(deny)],
      [readCall(helperPath)],
      [message(deny)],
      [message(deny)],
      [message(allow)],
    ]);
    const guardian = makeGuardian(reviewer(), undefined, {});
    await Effect.runPromise(guardian.review(pendingFor(roundOne), reader(roundOne)));
    await Effect.runPromise(guardian.review(pendingFor(roundTwo), reader(roundTwo)));
    await Effect.runPromise(guardian.review(pendingFor(roundTwo), reader(roundTwo)));
    await Effect.runPromise(guardian.review(pendingFor(roundTwo), reader(roundTwo)));
    const second = deltaOf(requests[2]);
    expect(fileIn(second, helperPath).status).toBe("unchanged_unread");
    expect(fileIn(second, outputPath).status).toBe("unchanged_unread");
    const third = deltaOf(requests[4]);
    // Read in the second round and unchanged since.
    expect(fileIn(third, helperPath).status).toBe("unchanged");
    // Read in the first round, changed in the second and not read since.
    expect(fileIn(third, definitionPath).status).toBe("unchanged_unread");
    expect(fileIn(third, toolPath).status).toBe("unchanged_unread");
    // A read stays credited across rounds that read nothing, while the file stays unchanged.
    expect(fileIn(deltaOf(requests[5]), helperPath).status).toBe("unchanged");
  });

  it("does not compare a file too large to read whole, even when only its tail changed", async () => {
    const largePath = "captures/results/dom.html";
    const body = "x".repeat(5 * 1024 * 1024);
    const before: Files = new Map([...roundOne, [largePath, `${body}tail-before`]]);
    const after: Files = new Map([...roundOne, [largePath, `${body}tail-after!`]]);
    // Encodes each text once, so the many chunk reads stay fast.
    const cachedReader = (files: Files) => {
      const bytes = new Map(
        [...files].map(([path, text]) => [path, new TextEncoder().encode(text)]),
      );
      return makeSourceInspector(
        (path) => {
          const found = bytes.get(path);
          return found === undefined
            ? Effect.fail(new ReviewFailure({ code: "SourceUnavailable" }))
            : Effect.succeed(found);
        },
        (_path, read) => Effect.succeed(new TextDecoder().decode(read)),
      );
    };
    const requests = recorded([[message(deny)], [message(allow)]]);
    const guardian = makeGuardian(reviewer(), undefined, {});
    await Effect.runPromise(guardian.review(pendingFor(before), cachedReader(before)));
    await Effect.runPromise(guardian.review(pendingFor(after), cachedReader(after)));
    expect(fileIn(deltaOf(requests[1]), largePath).status).toBe("not_compared");
  });

  it("restores a snapshot whose round a later release wrote, and reviews the next round as a first one", async () => {
    const requests = recorded([[message(deny)], [message(allow)]]);
    const first = makeGuardian(reviewer(), undefined, {});
    await Effect.runPromise(first.review(pendingFor(roundOne), reader(roundOne)));
    const saved = JSON.parse(JSON.stringify(first.session?.snapshot())) as {
      publicationRound: { decision: { findings: { category: string }[] } };
    };
    const finding = saved.publicationRound.decision.findings[0];
    if (finding === undefined) throw new Error("No finding kept");
    finding.category = "a_category_from_a_later_release";
    const restored = Schema.decodeUnknownSync(GuardianSessionSnapshot)(saved);
    const replacement = makeGuardian(reviewer(), undefined, { initial: restored });
    await Effect.runPromise(replacement.review(pendingFor(roundTwo), reader(roundTwo)));
    expect(reviewRequest(requests[1])).not.toHaveProperty("publication_delta");
  });

  it.each([
    ["the completion could not be saved", "save" as const],
    ["the decision did not decode", "decode" as const],
  ])("keeps the previous round when a review fails because %s", async (_name, failure) => {
    let failSave = false;
    // A decision that does not decode gets one follow-up, which does not decode either.
    const requests = recorded([
      [message(deny)],
      ...(failure === "decode"
        ? [[message({ outcome: "allow" })], [message({ outcome: "allow" })]]
        : [[message(allow)]]),
      [message(allow)],
    ]);
    const guardian = makeGuardian(reviewer(), undefined, {
      save: (snapshot) =>
        failSave && !snapshot.incomplete
          ? Effect.fail(new Error("Synthetic save failure"))
          : Effect.void,
    });
    await Effect.runPromise(guardian.review(pendingFor(roundOne), reader(roundOne)));
    failSave = failure === "save";
    const failed = await Effect.runPromise(
      Effect.either(guardian.review(pendingFor(roundTwo), reader(roundTwo))),
    );
    expect(failed._tag).toBe("Left");
    failSave = false;
    await Effect.runPromise(guardian.review(pendingFor(roundTwo), reader(roundTwo)));
    // The third round is compared with the first, the last one that completed.
    const delta = deltaOf(requests.at(-1));
    expect(delta.priorReview.outcome).toBe("deny");
    expect(fileIn(delta, toolPath).status).toBe("changed");
  });

  it("names step results and the entrypoint among the context that changed", async () => {
    const requests = recorded([[message(deny)], [message(allow)]]);
    const guardian = makeGuardian(reviewer(), undefined, {});
    await Effect.runPromise(guardian.review(pendingFor(roundOne), reader(roundOne)));
    await Effect.runPromise(
      guardian.review(
        pendingFor(roundTwo, {
          entrypoint: helperPath,
          stepResults: [{ executionId: "execution_two", result: "{}" }],
        }),
        reader(roundTwo),
      ),
    );
    expect(deltaOf(requests[1]).changedContext).toEqual([
      "submitted_call.entrypoint",
      "untrusted_step_results",
    ]);
  });
});
