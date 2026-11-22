import { OpenAIProvider, setDefaultModelProvider, Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect, Either } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  guardianExecutionPolicy,
  nativeExecutionEnvironment,
} from "../../src/guardian/execution-policy.js";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import { answersForReview } from "../../src/guardian/question.js";
import {
  decodePublicationDecision,
  guardianPublicationPolicy,
  publicationCallerDecisionPolicy,
  publicationDecisionPolicy,
  publicationPaidChoiceLimit,
  publicationLiveTestsPolicy,
  publicationOutputPolicy,
  publicationSafetyDefaultPolicy,
} from "../../src/guardian/publication.js";
import {
  makeGuardian,
  ReviewFailure,
  type GuardianDiagnostics,
  type PendingExecution,
  type Reviewer,
} from "../../src/guardian/review.js";
import {
  publicationFindingCategories,
  publicationReasons,
  unfixableFindingCategories,
  unfixablePublicationReasons,
} from "../../src/guardian/review-contracts.js";
import type { PublicationScope } from "../../src/guardian/review-contracts.js";
import { makeSourceInspector } from "../../src/guardian/source.js";
import { publicationScope } from "../../src/mint/publication-review.js";
import { instructionsOf } from "../support/guardian-requests.js";

afterEach(() => setDefaultModelProvider(new OpenAIProvider()));

const native = { executionEnvironment: nativeExecutionEnvironment };

const files = new Map([
  ["operation/src/tool.mjs", 'export const city = "Paris"; // synthetic é'],
  [
    "publication/definition.json",
    JSON.stringify({
      description: "Read reports",
      inputSchema: { examples: ["Synthetic example"] },
    }),
  ],
  ["publication/example-output.json", JSON.stringify({ output: { reports: [] } })],
]);
const pending: PendingExecution = {
  invocationId: "invocation_a",
  attemptId: "attempt_a",
  entrypoint: "operation/src/tool.mjs",
  screenedIntent: "Read public reports",
  screenedInput: "{}",
  screenedObservations: "Prior example completed; publication does not repeat it.",
  accountScope: "account_a",
  allowedOrigins: [],
  allowedEffects: ["Publish current package only"],
  publication: {
    files: [...files].map(([path, source]) => ({
      path,
      byteLength: Buffer.byteLength(source),
      published: true,
      current: true,
      owner: path.startsWith("publication/") ? ("host" as const) : ("minter" as const),
    })),
  },
};
const explanation =
  "The city output is a constant; read it from the page. Evidence: src/tool.mjs sets it.";
const entrypointLength = Buffer.byteLength(files.get("operation/src/tool.mjs") ?? "");
const sourcesOf = (sources: ReadonlyMap<string, string>) =>
  makeSourceInspector(
    (path) =>
      Effect.suspend(() => {
        const text = sources.get(path);
        return text === undefined
          ? Effect.fail(new ReviewFailure({ code: "SourceUnavailable" }))
          : Effect.succeed(new TextEncoder().encode(text));
      }),
    (_path, bytes) => Effect.succeed(new TextDecoder().decode(bytes)),
  );
const allow = {
  outcome: "allow",
  reason: "approved",
  rationale: "The reviewed evidence supports this publication decision",
  findings: [],
};
const inspectAll: Reviewer["run"] = (turn) =>
  Effect.gen(function* () {
    for (const file of turn.pending.publication?.files ?? []) {
      let offset = 0;
      while (true) {
        const raw: unknown = JSON.parse(yield* turn.readSource(file.path, offset));
        if (
          raw === null ||
          typeof raw !== "object" ||
          !("nextOffset" in raw) ||
          typeof raw.nextOffset !== "number" ||
          !("hasMore" in raw)
        )
          throw new Error("Invalid chunk");
        if (!raw.hasMore) break;
        offset = raw.nextOffset;
      }
    }
    return allow;
  });

describe("a publication decision", () => {
  // A host that decodes publication decisions itself keeps its own decoder.
  it("is decoded by a host's own decoder when the host gives one", async () => {
    const scopes: unknown[] = [];
    const reviewer: Reviewer = {
      run: (turn) =>
        inspectAll(turn).pipe(
          Effect.as({ outcome: "deny", reason: "host_specific", rationale: "Host raw." }),
        ),
    };
    const result = await Effect.runPromise(
      makeGuardian(
        reviewer,
        undefined,
        {},
        {
          decodePublication: (scope, raw) =>
            Effect.sync(() => {
              scopes.push(scope);
              return {
                outcome: "allow" as const,
                rationale: `Host decoded: ${(raw as { rationale: string }).rationale}`,
              };
            }),
        },
      ).review(pending, sourcesOf(files)),
    );
    expect(result.decision).toEqual({ outcome: "allow", rationale: "Host decoded: Host raw." });
    expect(scopes).toEqual([pending.publication]);
  });

  it("returns corrective locations for publication/definition.json and records them in the completion diagnostic", async () => {
    const path = "publication/definition.json";
    const findings = [{ path, byteStart: 0, byteEnd: 12, category: "private_literal", explanation }];
    const persisted: { name: string; details: unknown }[] = [];
    const diagnostics: GuardianDiagnostics = {
      emit: (name, details) =>
        Effect.sync(() => {
          persisted.push({ name, details });
        }),
      retainScreenedSource: () => Effect.void,
      retainModelTranscript: () => Effect.void,
    };
    const reviewer: Reviewer = {
      run: (turn) =>
        inspectAll(turn).pipe(
          Effect.as({
            outcome: "deny",
            reason: "privacy",
            findings,
            rationale: "Remove the literal",
          }),
        ),
    };
    const result = await Effect.runPromise(
      makeGuardian(reviewer, diagnostics).review(pending, sourcesOf(files)),
    );
    expect(result.decision).toEqual({
      outcome: "deny",
      reason: "privacy",
      rationale: "Remove the literal",
      findings,
    });
    expect(
      JSON.stringify(persisted.find((event) => event.name === "guardian.completed")),
    ).toContain(JSON.stringify(findings));
  });

  it.each([
    { path: "unknown", byteStart: 0, byteEnd: 1, category: "private_literal", explanation },
    { path: pending.entrypoint, byteStart: 0, byteEnd: 1, category: "PRIVATE_CANARY", explanation },
    { path: pending.entrypoint, byteStart: 0, byteEnd: 1, category: "private_literal" },
    {
      path: pending.entrypoint,
      byteStart: 0,
      byteEnd: 1,
      category: "private_literal",
      explanation: "",
    },
  ])("rejects invalid finding metadata: %j", async (finding) => {
    const reviewer: Reviewer = {
      run: () =>
        Effect.succeed({
          outcome: "deny",
          reason: "privacy",
          rationale: "The reviewed evidence supports this publication decision",
          findings: [finding],
        }),
    };
    expect(
      await Effect.runPromise(
        Effect.either(makeGuardian(reviewer).review(pending, sourcesOf(files))),
      ),
    ).toMatchObject({ _tag: "Left", left: { code: "InvalidDecision" } });
  });

  // A denial is a verdict: a finding whose range runs past its file or is empty still reaches the
  // minter, with its explanation, at the part of the file the range can name.
  it.each([
    { byteStart: 3, byteEnd: 9000, kept: { byteStart: 3, byteEnd: entrypointLength } },
    { byteStart: 5, byteEnd: 1, kept: { byteStart: 0, byteEnd: entrypointLength } },
  ])("keeps a denial whose only fault is a finding's byte range: %j", async (range) => {
    const { decision } = await Effect.runPromise(
      makeGuardian({
        run: () =>
          Effect.succeed({
            outcome: "deny",
            reason: "source_correction",
            rationale: "One output is a constant.",
            findings: [
              {
                path: pending.entrypoint,
                byteStart: range.byteStart,
                byteEnd: range.byteEnd,
                category: "schema_mismatch",
                explanation,
              },
            ],
          }),
      }).review(pending, sourcesOf(files)),
    );
    expect(decision).toEqual({
      outcome: "deny",
      reason: "source_correction",
      rationale: "One output is a constant.",
      findings: [
        { path: pending.entrypoint, ...range.kept, category: "schema_mismatch", explanation },
      ],
    });
  });

  // A denial that names every problem keeps its findings and its rationale's first 4,000
  // characters, rather than failing as InvalidDecision and losing them.
  it("keeps a denial whose rationale is too long, cut to 4,000 characters", async () => {
    const rationale = "The source hard-codes a private value. ".repeat(120);
    const finding = {
      path: pending.entrypoint,
      byteStart: 0,
      byteEnd: 1,
      category: "private_literal",
      explanation,
    };
    const { decision } = await Effect.runPromise(
      makeGuardian({
        run: () =>
          Effect.succeed({ outcome: "deny", reason: "privacy", rationale, findings: [finding] }),
      }).review(pending, sourcesOf(files)),
    );
    expect(decision).toMatchObject({ outcome: "deny", reason: "privacy", findings: [finding] });
    expect(decision.rationale).toBe(`${rationale.slice(0, 3999)}…`);
  });

  // An explanation longer than a finding may hold keeps its start rather than failing the denial,
  // and never ends on half of a character.
  it.each([
    { text: "x".repeat(900), kept: `${"x".repeat(799)}…` },
    { text: `${"x".repeat(798)}😀${"x".repeat(50)}`, kept: `${"x".repeat(798)}…` },
  ])("cuts an overlong explanation to 800 characters: $kept.length", async ({ text, kept }) => {
    const { decision } = await Effect.runPromise(
      makeGuardian({
        run: () =>
          Effect.succeed({
            outcome: "deny",
            reason: "source_correction",
            rationale: "One output is a constant.",
            findings: [
              {
                path: pending.entrypoint,
                byteStart: 0,
                byteEnd: 1,
                category: "schema_mismatch",
                explanation: text,
              },
            ],
          }),
      }).review(pending, sourcesOf(files)),
    );
    expect(decision.findings?.[0]?.explanation).toBe(kept);
  });

  // A denial's short public reason is the caller's, apart from the private rationale; an allow
  // has none to give.
  it.each([
    { outcome: "deny", reason: "privacy", kept: "The tool could not be published safely." },
    { outcome: "allow", reason: "approved", kept: undefined },
  ])("keeps a public reason only on a denial: $outcome", async ({ outcome, reason, kept }) => {
    const { decision } = await Effect.runPromise(
      makeGuardian({
        run: () =>
          Effect.succeed({
            outcome,
            reason,
            rationale: "The source hard-codes a private value.",
            findings:
              outcome === "deny"
                ? [
                    {
                      path: pending.entrypoint,
                      byteStart: 0,
                      byteEnd: 1,
                      category: "private_literal",
                      explanation,
                    },
                  ]
                : [],
            publicReason: " The tool could not be published safely. ",
          }),
      }).review(pending, sourcesOf(files)),
    );
    expect(decision.publicReason).toBe(kept);
  });

  // Guardian's shared output format sends null for a field a kind does not use.
  it("reads a null findings list as none and an allow without a reason as approved", async () => {
    const { decision } = await Effect.runPromise(
      makeGuardian({
        run: () =>
          Effect.succeed({ outcome: "allow", reason: null, rationale: "Fine.", findings: null }),
      }).review(pending, sourcesOf(files)),
    );
    expect(decision).toEqual({
      outcome: "allow",
      reason: "approved",
      rationale: "Fine.",
      findings: [],
    });
  });

  const definitionFinding = (category: string) => ({
    path: "publication/definition.json",
    byteStart: 0,
    byteEnd: 1,
    category,
    explanation,
  });
  const decide = (decision: Record<string, unknown>) =>
    Effect.runPromise(
      Effect.either(
        makeGuardian({
          run: (turn) =>
            inspectAll(turn).pipe(
              Effect.as({ rationale: "The source needs the indicated correction", ...decision }),
            ),
        }).review(pending, sourcesOf(files)),
      ),
    );

  it("requires an in-index unsupported_claim finding for an unsupported-claim denial", async () => {
    expect(
      await decide({
        outcome: "deny",
        reason: "unsupported_claim",
        findings: [definitionFinding("schema_mismatch")],
      }),
    ).toMatchObject({ _tag: "Left", left: { code: "InvalidDecision" } });
  });

  it("cannot approve with an unsupported-claim reason", async () => {
    expect(
      await decide({ outcome: "allow", reason: "unsupported_claim", findings: [] }),
    ).toMatchObject({ _tag: "Left", left: { code: "InvalidDecision" } });
  });

  it("returns input feedback made only of input findings with its reason", async () => {
    const findings = ["account_specific_enum", "input_option", "example_input"].map(
      definitionFinding,
    );
    expect(
      await decide({
        outcome: "escalate",
        reason: "input_feedback",
        rationale: "Expose the account-specific choice as caller input",
        findings,
      }),
    ).toMatchObject({
      _tag: "Right",
      right: {
        decision: {
          outcome: "escalate",
          reason: "input_feedback",
          rationale: "Expose the account-specific choice as caller input",
          findings,
        },
      },
    });
  });

  it.each([
    { outcome: "escalate", reason: "input_feedback", findings: [] },
    {
      outcome: "escalate",
      reason: "input_feedback",
      findings: [definitionFinding("account_specific_enum"), definitionFinding("private_literal")],
    },
    {
      outcome: "escalate",
      reason: "input_feedback",
      findings: [definitionFinding("input_option"), definitionFinding("private_literal")],
    },
    // An input narrowed to the example's value blocks publication; it is never input feedback.
    { outcome: "deny", reason: "input_feedback", findings: [definitionFinding("example_value")] },
    { outcome: "allow", reason: "input_feedback", findings: [definitionFinding("input_option")] },
  ])("rejects input feedback that is empty, blocking or approving: %j", async (decision) => {
    expect(await decide(decision)).toMatchObject({
      _tag: "Left",
      left: { code: "InvalidDecision" },
    });
  });

  it("keeps an input finding beside a blocking reason, which still decides", async () => {
    const findings = [
      definitionFinding("private_literal"),
      definitionFinding("account_specific_enum"),
    ];
    expect(await decide({ outcome: "deny", reason: "privacy", findings })).toMatchObject({
      _tag: "Right",
      right: { decision: { outcome: "deny", reason: "privacy", findings } },
    });
  });

  // A host_owned denial tells the minter it cannot fix the findings, so none may be in its files
  // or in the public definition, which follows from its source and build metadata.
  it.each([
    { path: "publication/example-output.json", decided: "Right" },
    { path: "publication/definition.json", decided: "Left" },
    { path: "operation/src/tool.mjs", decided: "Left" },
  ])("decides a host_owned denial with a finding in $path: $decided", async ({ path, decided }) => {
    const findings = [{ path, byteStart: 0, byteEnd: 1, category: "private_literal", explanation }];
    expect(await decide({ outcome: "deny", reason: "host_owned", findings })).toMatchObject(
      decided === "Right"
        ? { _tag: "Right", right: { decision: { reason: "host_owned", findings } } }
        : { _tag: "Left", left: { code: "InvalidDecision" } },
    );
  });

  // The live test record is the host's copy of the minter's cases and their results on its
  // source: the minter fixes a finding there through its cases or source, so it goes back as a
  // correction, never as a host fault that ends the build.
  it("decides a finding in the live test record as the minter's, never host_owned", async () => {
    const record = JSON.stringify({ kind: "host_live_tests", cases: [], retired: [] });
    const withRecord = new Map([...files, ["publication/tests.json", record]]);
    const recordPending: PendingExecution = {
      ...pending,
      publication: {
        files: [
          ...(pending.publication?.files ?? []),
          {
            path: "publication/tests.json",
            byteLength: Buffer.byteLength(record),
            published: false,
            current: true,
            owner: "host",
          },
        ],
      },
    };
    const findings = [
      {
        path: "publication/tests.json",
        byteStart: 0,
        byteEnd: 1,
        category: "unsupported_claim",
        explanation,
      },
    ];
    const decideOnRecord = (reason: string) =>
      Effect.runPromise(
        Effect.either(
          makeGuardian({
            run: (turn) =>
              inspectAll(turn).pipe(
                Effect.as({ outcome: "deny", reason, rationale: "No case tests it", findings }),
              ),
          }).review(recordPending, sourcesOf(withRecord)),
        ),
      );
    expect(await decideOnRecord("host_owned")).toMatchObject({
      _tag: "Left",
      left: { code: "InvalidDecision" },
    });
    expect(await decideOnRecord("evidence")).toMatchObject({
      _tag: "Right",
      right: { decision: { reason: "evidence", findings } },
    });
  });

  it("accepts a confirmation finding as a source correction", async () => {
    const findings = [definitionFinding("confirmation")];
    expect(await decide({ outcome: "deny", reason: "source_correction", findings })).toMatchObject({
      _tag: "Right",
      right: { decision: { reason: "source_correction", findings } },
    });
  });
});

// A temporary, narrow exception: a site may ask for a choice on its own sign-in page, such as a
// location, which the host's sign-in makes and keeps in its sign-in recipe. Until such choices
// become declared sign-in inputs, an input design finding about one is set aside. Nothing else
// in the recipe or any other host-written file is: a broken, incorrect or unsafe tool still
// fails publication exactly as before.
describe("a finding about a choice on the site's sign-in pages", () => {
  const recipe = JSON.stringify({
    version: 1,
    steps: [{ page: "https://portal.example/login", fields: [], submit: "#sign-in" }],
    signedIn: { selector: "#account" },
  });
  const entry = 'export { default } from "./src/tool.mjs";';
  // Paths a looser match on the recipe's name would also accept; only the exact one is the recipe.
  const lookalikes = [
    "operation/sub/auth-fill.json",
    "xoperation/auth-fill.json",
    "auth-fill.json",
    "operation/auth-fill.json.bak",
  ];
  const withHostFiles = new Map([
    ...files,
    ["operation/auth-fill.json", recipe],
    ["operation/operation.mjs", entry],
    ...lookalikes.map((path) => [path, recipe] as const),
  ]);
  const hostFile = (path: string, text: string) => ({
    path,
    byteLength: Buffer.byteLength(text),
    published: true,
    current: true,
    owner: "host" as const,
  });
  const hostPending: PendingExecution = {
    ...pending,
    publication: {
      files: [
        ...(pending.publication?.files ?? []),
        hostFile("operation/auth-fill.json", recipe),
        hostFile("operation/operation.mjs", entry),
        ...lookalikes.map((path) => hostFile(path, recipe)),
      ],
    },
  };
  // The same bundle with the recipe marked as the minter's, which the minter can then fix.
  const minterRecipePending: PendingExecution = {
    ...hostPending,
    publication: {
      files: (hostPending.publication?.files ?? []).map((file) =>
        file.path === "operation/auth-fill.json" ? { ...file, owner: "minter" as const } : file,
      ),
    },
  };
  const at = (path: string, category: string) => ({
    path,
    byteStart: 0,
    byteEnd: 1,
    category,
    explanation,
  });
  const inRecipe = (category: string) => at("operation/auth-fill.json", category);
  const rationale = "The sign-in picks a location the caller does not choose.";
  const review = (
    decision: Record<string, unknown>,
    diagnostics?: GuardianDiagnostics,
    reviewed: PendingExecution = hostPending,
  ) =>
    Effect.runPromise(
      makeGuardian(
        {
          run: (turn) =>
            inspectAll(turn).pipe(
              Effect.as({
                rationale,
                publicReason: "The tool could not be published yet.",
                ...decision,
              }),
            ),
        },
        diagnostics,
      ).review(reviewed, sourcesOf(withHostFiles)),
    ).then(({ decision: decided }) => decided);

  it.each([
    { reason: "input_feedback", category: "input_option" },
    { reason: "source_correction", category: "example_value" },
    { reason: "host_owned", category: "input_option" },
  ])(
    "allows a $reason denial whose only finding is a sign-in page $category",
    async ({ reason, category }) => {
      const decided = await review({ outcome: "deny", reason, findings: [inRecipe(category)] });
      expect(decided).toMatchObject({
        outcome: "allow",
        reason: "approved",
        findings: [],
        excusedSignInChoices: [inRecipe(category)],
      });
      expect(decided.publicReason).toBeUndefined();
    },
  );

  it("records the excused sign-in choice in the completion diagnostic", async () => {
    const persisted: { name: string; details: unknown }[] = [];
    await review(
      { outcome: "deny", reason: "input_feedback", findings: [inRecipe("input_option")] },
      {
        emit: (name, details) =>
          Effect.sync(() => {
            persisted.push({ name, details });
          }),
        retainScreenedSource: () => Effect.void,
        retainModelTranscript: () => Effect.void,
      },
    );
    expect(persisted.find((event) => event.name === "guardian.completed")?.details).toMatchObject({
      details: { outcome: "allow", excusedSignInChoices: [inRecipe("input_option")] },
    });
  });

  it("keeps the minter's findings blocking beside an excused sign-in choice", async () => {
    const source = at(pending.entrypoint, "schema_mismatch");
    expect(
      await review({
        outcome: "deny",
        reason: "source_correction",
        findings: [source, inRecipe("input_option")],
      }),
    ).toMatchObject({
      outcome: "deny",
      reason: "source_correction",
      findings: [source],
      excusedSignInChoices: [inRecipe("input_option")],
    });
  });

  // With the sign-in choice set aside, only input feedback is left, which gives the minter rounds
  // to fix it rather than refusing the build.
  it("leaves input feedback when only input findings in the minter's files remain", async () => {
    const definition = at("publication/definition.json", "input_option");
    expect(
      await review({
        outcome: "deny",
        reason: "source_correction",
        findings: [definition, inRecipe("example_value")],
      }),
    ).toMatchObject({
      outcome: "deny",
      reason: "input_feedback",
      findings: [definition],
      excusedSignInChoices: [inRecipe("example_value")],
    });
  });

  // A broken, incorrect or unsafe tool is never excused, wherever the finding sits. Much of the
  // recipe records the minter's own sign-in choices, which it fixes by signing in again, so a
  // denial a correction gets past keeps its reason there too.
  it.each([
    { reason: "source_correction", finding: inRecipe("schema_mismatch") },
    { reason: "unsupported_claim", finding: inRecipe("unsupported_claim") },
    { reason: "source_correction", finding: inRecipe("confirmation") },
    { reason: "host_owned", finding: inRecipe("credential") },
    { reason: "source_correction", finding: at("operation/operation.mjs", "schema_mismatch") },
    { reason: "source_correction", finding: at("operation/operation.mjs", "confirmation") },
  ])(
    "keeps a $reason denial for $finding.category in $finding.path exactly as returned",
    async ({ reason, finding }) => {
      const decided = await review({ outcome: "deny", reason, findings: [finding] });
      expect(decided).toMatchObject({ outcome: "deny", reason, findings: [finding] });
      expect(decided).not.toHaveProperty("excusedSignInChoices");
    },
  );

  // An input design finding about anything but a sign-in page choice still stands: one in
  // another host-written file and one in the minter's files.
  it.each([
    { reason: "input_feedback", finding: at("operation/operation.mjs", "input_option") },
    { reason: "source_correction", finding: at("operation/operation.mjs", "example_value") },
    { reason: "input_feedback", finding: at("publication/definition.json", "input_option") },
    { reason: "source_correction", finding: at(pending.entrypoint, "example_value") },
  ])(
    "keeps a $reason denial for $finding.category in $finding.path that is no sign-in page choice",
    async ({ reason, finding }) => {
      const decided = await review({ outcome: "deny", reason, findings: [finding] });
      expect(decided).toMatchObject({ outcome: "deny", reason, findings: [finding] });
      expect(decided).not.toHaveProperty("excusedSignInChoices");
    },
  );

  // A refusal for privacy or authority in the recipe is one no correction gets past, and the
  // exception never touches it: it blocks as the host's own, host_owned.
  it.each([
    { reason: "privacy", finding: inRecipe("customer_data") },
    { reason: "authority", finding: inRecipe("input_option") },
  ])(
    "blocks a $reason denial for $finding.category in $finding.path as host_owned",
    async ({ reason, finding }) => {
      const decided = await review({ outcome: "deny", reason, findings: [finding] });
      expect(decided).toMatchObject({ outcome: "deny", reason: "host_owned", findings: [finding] });
      expect(decided).not.toHaveProperty("excusedSignInChoices");
    },
  );

  // Only a denial is ever relaxed: an escalation asks for a person's decision and passes through
  // untouched, whatever its findings.
  it.each([
    { reason: "source_correction", category: "input_option" },
    { reason: "input_feedback", category: "input_option" },
    { reason: "source_correction", category: "example_value" },
  ])(
    "keeps a $reason escalation whose only finding is a sign-in page $category",
    async ({ reason, category }) => {
      const decided = await review({ outcome: "escalate", reason, findings: [inRecipe(category)] });
      expect(decided).toMatchObject({ outcome: "escalate", reason, findings: [inRecipe(category)] });
      expect(decided).not.toHaveProperty("excusedSignInChoices");
    },
  );

  // A recipe the minter owns is the minter's to fix, so its finding blocks like any other.
  it("keeps an input finding in a sign-in recipe the minter owns blocking", async () => {
    const decided = await review(
      { outcome: "deny", reason: "input_feedback", findings: [inRecipe("input_option")] },
      undefined,
      minterRecipePending,
    );
    expect(decided).toMatchObject({
      outcome: "deny",
      reason: "input_feedback",
      findings: [inRecipe("input_option")],
    });
    expect(decided).not.toHaveProperty("excusedSignInChoices");
  });

  it.each(lookalikes)(
    "keeps an input finding in %s, which is not the host's sign-in recipe, blocking",
    async (path) => {
      const finding = at(path, "input_option");
      const decided = await review({ outcome: "deny", reason: "input_feedback", findings: [finding] });
      expect(decided).toMatchObject({ outcome: "deny", reason: "input_feedback", findings: [finding] });
      expect(decided).not.toHaveProperty("excusedSignInChoices");
    },
  );

  // The host's evidence under publication/ records what the minter's source did, so a finding
  // there still names the source to change and keeps blocking.
  it("keeps a finding in the host's example output blocking", async () => {
    const output = at("publication/example-output.json", "schema_mismatch");
    expect(
      await review({ outcome: "deny", reason: "source_correction", findings: [output] }),
    ).toMatchObject({ outcome: "deny", reason: "source_correction", findings: [output] });
  });
});

// The minter edits no bundle file the host writes, such as its sign-in recipe, though much of the
// recipe records the minter's own sign-in choices, which it fixes by signing in again. So a refusal
// no correction gets past, whose every finding is in such a file, ends the build as the host's own
// failure. The host sets that reason itself: a reviewer that names another one would let the
// minter end the build on it as its own policy block.
describe("a denial whose every finding is in a bundle file the host wrote", () => {
  const recipe = JSON.stringify({
    version: 1,
    steps: [{ page: "https://portal.example/team/sample/login", fields: [], submit: "#sign-in" }],
    signedIn: { selector: "#account" },
  });
  const bundle = new Map([
    ["src/tool.mjs", "export default {};"],
    ["auth-fill.json", recipe],
  ]);
  const evidence = new Map([
    ["publication/definition.json", '{"name":"read_reports"}'],
    ["publication/tests.json", '{"cases":[]}'],
  ]);
  // The index as a host that marks the files it adds to the bundle builds it, and as one that
  // marks none, as the local host does.
  const marked = publicationScope(bundle, evidence, { hostWritten: new Set(["auth-fill.json"]) });
  const unmarked = publicationScope(bundle, evidence);
  const at = (path: string, category: string) => ({
    path,
    byteStart: 0,
    byteEnd: 1,
    category,
    explanation,
  });
  const inRecipe = at("operation/auth-fill.json", "private_literal");
  const inSource = at("operation/src/tool.mjs", "private_literal");
  const rationale = "The recipe's path names a team.";
  const decode = (scope: PublicationScope, decision: Record<string, unknown>) =>
    Effect.runPromise(
      Effect.either(decodePublicationDecision(scope, { rationale, findings: [], ...decision })),
    );

  it("marks the sign-in recipe as the host's only when the host says it wrote it", () => {
    expect(marked.files.find((file) => file.path === "operation/auth-fill.json")?.owner).toBe(
      "host",
    );
    expect(unmarked.files.find((file) => file.path === "operation/auth-fill.json")?.owner).toBe(
      "minter",
    );
  });

  it.each(["source_correction", "privacy", "authority", "evidence"])(
    "decodes a %s denial whose only finding is a private literal in the host's sign-in recipe as host_owned",
    async (reason) => {
      const decided = await decode(marked, { outcome: "deny", reason, findings: [inRecipe] });
      expect(decided).toMatchObject({
        _tag: "Right",
        right: { outcome: "deny", reason: "host_owned", findings: [inRecipe] },
      });
      // The rationale keeps the reason the review gave, so the record shows the host set it.
      expect(Either.getOrThrow(decided).rationale).toContain(reason);
      expect(Either.getOrThrow(decided).rationale).toContain(rationale);
    },
  );

  // A signed-in marker that also shows signed out is the minter's own choice, recorded in the
  // recipe, which it fixes by signing in again, so the denial goes back to it.
  it("keeps a source_correction denial for a signed-in marker in the host's sign-in recipe", async () => {
    const marker = {
      ...at("operation/auth-fill.json", "schema_mismatch"),
      explanation:
        "The signed-in marker also shows on the signed-out page. Sign in again with one only a signed-in page shows.",
    };
    expect(
      await decode(marked, { outcome: "deny", reason: "source_correction", findings: [marker] }),
    ).toMatchObject({
      _tag: "Right",
      right: { outcome: "deny", reason: "source_correction", rationale, findings: [marker] },
    });
  });

  // Any other denial a correction gets past keeps its reason too.
  it.each([
    { reason: "source_correction", category: "confirmation" },
    { reason: "unsupported_claim", category: "unsupported_claim" },
    { reason: "evidence", category: "schema_mismatch" },
  ])(
    "keeps a $reason denial for a $category finding in the host's sign-in recipe",
    async ({ reason, category }) => {
      const finding = at("operation/auth-fill.json", category);
      expect(await decode(marked, { outcome: "deny", reason, findings: [finding] })).toMatchObject({
        _tag: "Right",
        right: { outcome: "deny", reason, rationale, findings: [finding] },
      });
    },
  );

  // A sign-in page choice beside it is still set aside, and the rest blocks as host_owned.
  it("sets a sign-in page choice aside and decodes the rest as host_owned", async () => {
    const choice = at("operation/auth-fill.json", "input_option");
    expect(
      await decode(marked, {
        outcome: "deny",
        reason: "source_correction",
        findings: [choice, inRecipe],
      }),
    ).toMatchObject({
      _tag: "Right",
      right: {
        outcome: "deny",
        reason: "host_owned",
        findings: [inRecipe],
        excusedSignInChoices: [choice],
      },
    });
  });

  it("keeps a denial host_owned when the review already named it", async () => {
    expect(
      await decode(marked, { outcome: "deny", reason: "host_owned", findings: [inRecipe] }),
    ).toMatchObject({
      _tag: "Right",
      right: { outcome: "deny", reason: "host_owned", rationale, findings: [inRecipe] },
    });
  });

  // Any finding the minter can fix keeps the review's reason, so the denial goes back to it.
  it.each([
    { where: "a file the minter wrote", findings: [inRecipe, inSource] },
    { where: "the public definition", findings: [at("publication/definition.json", "private_literal")] },
    { where: "the live test record", findings: [at("publication/tests.json", "unsupported_claim")] },
    {
      where: "the recipe and the public definition",
      findings: [inRecipe, at("publication/definition.json", "private_literal")],
    },
  ])("keeps a source_correction denial with a finding in $where", async ({ findings }) => {
    expect(
      await decode(marked, { outcome: "deny", reason: "source_correction", findings }),
    ).toMatchObject({
      _tag: "Right",
      right: { outcome: "deny", reason: "source_correction", rationale, findings },
    });
  });

  it("keeps a denial whose recipe a host never marked as its own", async () => {
    expect(
      await decode(unmarked, { outcome: "deny", reason: "source_correction", findings: [inRecipe] }),
    ).toMatchObject({
      _tag: "Right",
      right: { outcome: "deny", reason: "source_correction", rationale, findings: [inRecipe] },
    });
  });

  // Input feedback never blocks publication on its own, a denial with no finding names no file,
  // and an escalation asks for a person's decision, so each keeps the review's reason.
  it.each([
    {
      outcome: "deny",
      reason: "input_feedback",
      findings: [at("operation/auth-fill.json", "account_specific_enum")],
    },
    { outcome: "deny", reason: "evidence", findings: [] },
    { outcome: "escalate", reason: "source_correction", findings: [inRecipe] },
  ])("keeps a $outcome for $reason with $findings.length findings", async (decision) => {
    expect(await decode(marked, decision)).toMatchObject({
      _tag: "Right",
      right: { ...decision, rationale },
    });
  });
});

describe("the publication policy", () => {
  // Hosts with their own publication policy compose the same decision policy.
  it("says the host sets host_owned itself for a denial in the host's bundle files", () => {
    const rule =
      "The host itself sets reason host_owned on a deny it cannot send back for a fix, one for privacy or authority or with a private_literal, credential, customer_data, exfiltration, unsafe_logging or safety_default finding, whose every finding is in an owner: host file under operation/, so when the minter's source causes such a problem, also put a finding on that source.";
    expect(publicationDecisionPolicy).toContain(
      `approved only with allow and no findings. ${rule} Site naming`,
    );
    expect(guardianPublicationPolicy.split(rule)).toHaveLength(2);
    // It names every refusal the host counts as one no correction gets past.
    for (const name of [...unfixablePublicationReasons, ...unfixableFindingCategories])
      expect(rule).toContain(name);
  });

  it("is the core text, naming the files the host writes", () => {
    const policy = guardianPublicationPolicy;
    expect(policy.split("\n")).toHaveLength(18);
    expect(
      policy.startsWith("This is the existing publication review, not an execution request.\n"),
    ).toBe(true);
    expect(policy).toContain(
      "Every owner: host file is written by the host, which the minter cannot edit: any entry file the host adds to the bundle and every publication/ file (the definition, the example or session output, the session steps and the live test record). No file must be read in full:",
    );
    expect(policy).toContain(
      "never ask for a source correction or another run for it. When such a file shows a problem the minter's source causes, the finding keeps its ordinary reason and the rationale names the source to change.",
    );
    expect(policy).not.toContain("  ");
  });

  // A caller's place, venue or company name matches in its usual forms, so neither the review of
  // a live step nor the publication review asks a tool to require an exact match.
  it("gives the execution and publication reviews the same fuzzy proper-noun rule", () => {
    const rule =
      "A tool matches the caller's proper nouns, such as places, venues and company names, with a fuzzy match that accepts the usual forms of the same name. Never ask a tool to require an exact match. When more than one option matches a caller's value equally, the tool either takes the first in the site's order and returns the one it used, as the site labels it, or lists them for the caller to choose one, in a question or a refusal whose options each select exactly one of them. Which of the two is the tool's own choice, never a finding or a reason to deny. A tool that takes the first and does not return the one it used is a schema_mismatch finding with reason source_correction.";
    expect(guardianPublicationPolicy.split(rule)).toHaveLength(2);
    expect(guardianExecutionPolicy(nativeExecutionEnvironment)).toContain(`\n${rule}\n`);
  });

  // Of several equal matches, taking the first or letting the caller choose is the tool's own
  // choice. Only taking the first without returning the match it used is a finding, and one the
  // publication review can return.
  it("finds a tool that takes the first of equal matches without returning it, never the choice", () => {
    const choice = "Which of the two is the tool's own choice, never a finding or a reason to deny.";
    const missing =
      "A tool that takes the first and does not return the one it used is a schema_mismatch finding with reason source_correction.";
    expect(guardianPublicationPolicy.split(`${choice} ${missing}`)).toHaveLength(2);
    expect(publicationFindingCategories).toContain("schema_mismatch");
    expect(publicationReasons).toContain("source_correction");
  });

  // A repair is judged on what it changed: an unchanged line is denied only when a failing run or
  // example shows it broken. Hosts with their own publication policy get it with the live tests.
  it("judges a repair on the lines it changed, beside the maintenance rule for live tests", () => {
    const rule =
      "In a repair, prefer denying only for lines the repair changed, or for unchanged lines that a failing run or example shows broken. Note other doubts about unchanged lines without denying, except a privacy or credential finding.";
    expect(publicationLiveTestsPolicy).toContain(
      `A claim those runs' output, source or captures contradict is still a finding. ${rule}`,
    );
    expect(guardianPublicationPolicy).toContain(`\n${publicationLiveTestsPolicy}\n`);
  });

  // One case that uses an input covers it, so the review asks for no case per option value.
  // Hosts with their own publication policy get it with the live tests.
  it("counts an input as tested by one case that uses it, not one per value", () => {
    expect(publicationLiveTestsPolicy).toContain(
      "a declared input when no case uses it, or changes it from its default,",
    );
    expect(publicationLiveTestsPolicy).toContain(
      "its other values, such as each option of a sort, need no case of their own and no notTested entry",
    );
  });

  // A list whose site rarely shows an empty state can still publish: its untested empty result is
  // no gap, while its next page still is.
  it("counts a list's next page as a gap, not its empty result", () => {
    expect(publicationLiveTestsPolicy).toContain(", a list's next page, another record,");
    expect(publicationLiveTestsPolicy).not.toContain("a list's empty result");
  });

  // A build cannot make a site's list change, and core fills and tests its own paging fields, so an
  // unchanged list is no gap.
  it("counts core's list fields as core's, so an unchanged list is no gap", () => {
    const rule =
      "The paging fields core's listOutputFields adds (next_cursor, next_cursor_expires_at, has_more, total_results, list_changed and next_cursor_unavailable) are core's own contract, filled by core's readList and tested in core: a passing next-page case tests the tool's paging, and a list that never changed between a case's calls is no gap, since a build cannot make a site's list change; prefer noting it in the rationale only.";
    expect(publicationLiveTestsPolicy).toContain(` ${rule} `);
  });

  // A site's own "Remember me" choice left at its default keeps the owner's session for later
  // runs. It is not a safety default, so neither review denies the host's sign-in step over it.
  it("leaves a site's own Remember me choice at its default in both reviews", () => {
    const rule =
      "Prefer leaving a site's own \"Remember me\" or \"Keep me signed in\" choice at its default on the tool's own sign-in. It keeps the account owner's session, which later runs rely on, and it is not a safety default. Never deny the host's own sign-in step over that choice.";
    expect(publicationSafetyDefaultPolicy.endsWith(` ${rule}`)).toBe(true);
    expect(guardianExecutionPolicy(nativeExecutionEnvironment)).toContain(`\n${rule}\n`);
  });

  // An edit that drops a tool's unchecking of a preselected partner comparison box is not a fix,
  // and the box is never an input of the tool.
  it("keeps a safety default the source sets, and never asks for it as an input", () => {
    expect(guardianPublicationPolicy).toContain(`\n${publicationSafetyDefaultPolicy}\n`);
    expect(guardianPublicationPolicy).toContain(
      "must be an input of the tool, except a safety default, which is never an input,",
    );
  });

  // The local host's precheck screens only the build's own caller-supplied values and secret
  // handles, so the policy never tells Guardian the files passed a credential check: Guardian
  // looks for hard-coded keys, tokens and passwords itself.
  it("names no data-vendor exception the local host cannot evidence", () => {
    expect(guardianPublicationPolicy).not.toContain("except the data-vendor read");
    expect(guardianPublicationPolicy).toContain(
      "sending it to any other off-site origin escalates, with no data-vendor exception on this host.",
    );
  });

  it("credits no credential precheck the local host does not run", () => {
    const policy = guardianPublicationPolicy;
    expect(policy).not.toContain("passed a deterministic credential precheck");
    expect(policy).toContain(
      "The local precheck covered only this build's own caller-supplied values and secret handles; it did not screen for provider credentials or other secrets, so inspect every published file for hard-coded API keys, tokens and passwords. Inspect the published files for hardcoded customer/private data,",
    );
  });

  // A composed write that confirms from its own commit request's response, checked, is
  // confirming; one that takes any request, any status or an unread error body is not.
  it("accepts a write confirmed from its own commit request, and refuses a loose check", () => {
    const policy = guardianPublicationPolicy;
    expect(policy).toContain(
      "perform and return the confirmation or read-back it declares, and never resubmit or commit twice. A second click on a marked step is not a resubmission when the marked call returned `blockingRequiredFields`' fields and the script called `notCommitted` for that step once, after `blockingRequiredFields` returned them and before entering it again, and entered it again once they were answered; a `notCommitted` without that, or a second one for the same step, is a confirmation finding. A `notCommitted` for a step right after the marked call of the step's first click got `unaskable` from `blockingRequiredFields`, followed by `InvalidInput` and no further click, is no finding. Nor is a `notCommitted` for a step right after the site's own answer to its click refused it as a whole and showed nothing was created, such as a commit response reporting an expired quote and no record, followed by a refusal with the site's words, or by one refresh, a check of the fresh quote against the caller's limits and one more entered click. A script that confirms from its commit request is confirming, not missing a read-back: in the same call as the final commit click it waits for the site's response on the route the session's commit used, requires a 2xx or 3xx status and no error in a body it can read, checks the page for an error or validation message (a 201 whose Location names the new record needs no page check), and only then calls verified(). It is a confirmation finding when the script accepts any request or any status, takes a 200 from an endpoint that can report errors in its body without checking that body, or skips the page's error check.",
    );
    expect(policy).toContain(
      "'unverifiable' is valid only if the session evidence shows the site offered no commit response the script can check, no confirmation and no read-back.",
    );
  });

  // The click's proof lets the step go back once before it is entered again: before the
  // site-field question, as the skills teach, or after the answers, as tools published before do.
  it("accepts a step put back after the fields that stopped its click, before or after asking them", () => {
    expect(guardianPublicationPolicy).toContain(
      "and a check run again after a marked call returned `blockingRequiredFields`' fields and they were answered, before that step's next enteringCommit.",
    );
    expect(guardianPublicationPolicy).not.toContain("just before entering it again");
    const execution = guardianExecutionPolicy(nativeExecutionEnvironment);
    expect(execution).toContain(
      "A second click on a marked step is not submitting the task a second time when the marked call returned blockingRequiredFields' fields and the step called notCommitted for that step once, after blockingRequiredFields returned them and before entering it again, and entered it again once they were answered.",
    );
    expect(execution).not.toContain("just before entering it again");
  });

  // A write that follows the site's own substitute for an unoffered option is right only when the
  // caller's task, in the trusted request or a confirmed task update, asks for whatever the site
  // ends up with; nothing the minter wrote is such an ask.
  it("accepts a write that follows the site's substitute only on the caller's own ask", () => {
    expect(publicationOutputPolicy).toContain(
      "For any other input, the fix is to throw InputNotApplied with the requested and applied value, or InvalidInput with the values the site offers when it does not offer the caller's value. Neither the description nor an answer in trusted_authority.answeredQuestions excuses it. A write that follows the site's preselected substitute for an option the page doesn't offer is no finding when the caller's own task, in trusted_request.intent or a caller-confirmed update in trusted_authority.taskUpdates, asks for whatever the site ends up with and the output returns the value the site used; nothing the minter wrote, in notes, observations, source or the definition, such as an output field or its description, counts as that ask. When the site shows no results,",
    );
    expect(guardianPublicationPolicy).toContain(publicationOutputPolicy);
  });
});

const message = (value: unknown): ModelResponse["output"][number] => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: JSON.stringify(value) }],
});
const read = (path: string, offset = 0, callId = `read_${path}_${offset}`) => ({
  type: "function_call" as const,
  callId,
  name: "read_source",
  status: "completed" as const,
  arguments: JSON.stringify({ path, offset }),
});
const scripted = (respond: (index: number) => ModelResponse["output"]) => {
  const requests: ModelRequest[] = [];
  setDefaultModelProvider({
    getModel: () => ({
      getResponse: async (request) => {
        requests.push(request);
        return { usage: new Usage(), output: respond(requests.length - 1) };
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  });
  return requests;
};
/** The review request the host sent: the first user message that is one. */
const reviewRequest = (request: ModelRequest | undefined): Record<string, unknown> => {
  const input = request?.input;
  const items = typeof input === "string" ? [{ role: "user", content: input }] : (input ?? []);
  for (const item of items) {
    const content = "role" in item && item.role === "user" ? item.content : undefined;
    if (typeof content === "string" && content.startsWith("{"))
      return JSON.parse(content) as Record<string, unknown>;
  }
  throw new Error("No review request");
};
/** The policy the review's own message carries for its kind. */
const policyOf = (request: ModelRequest | undefined) =>
  (reviewRequest(request)["trusted_review"] as { readonly policy: string }).policy;

describe("the OpenAI publication reviewer", () => {
  it.each([
    ["the local host, with no specialize", undefined, ["trusted_publication"]],
    [
      "a host that adds input but no policy",
      () => ({ input: { trusted_host_record: { synthetic: true } } }),
      ["trusted_host_record", "trusted_publication"],
    ],
  ])(
    "gives %s the outcome policy and the core publication policy, and the index before the environment",
    async (_host, specialize, fields) => {
      const requests = scripted(() => [message(allow)]);
      await Effect.runPromise(
        makeGuardian(
          makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, {
            ...native,
            ...(specialize === undefined ? {} : { specialize }),
          }),
        ).review(pending, sourcesOf(files)),
      );
      const policy = policyOf(requests[0]);
      expect(policy).toContain(
        "Return the structured outcome allow, deny or escalate and a concise rationale.",
      );
      expect(policy).toContain(guardianPublicationPolicy);
      // The review carries its own policy; the shared instructions hold none of it.
      expect(instructionsOf(requests[0])).not.toContain(guardianPublicationPolicy);
      const request = reviewRequest(requests[0]);
      const keys = Object.keys(request);
      const at = keys.indexOf("trusted_authority");
      expect(keys.slice(at, at + fields.length + 2)).toEqual([
        "trusted_authority",
        ...fields,
        "trusted_execution_environment",
      ]);
      expect(request["trusted_publication"]).toEqual(pending.publication);
    },
  );

  // A host that registers its own publication policy keeps exactly what it sends: the policy
  // replaces the core one in the review's own message, and no file index or turn limit is added
  // to its review.
  it("keeps a host's registered publication policy, input and turn limit as it sends them", async () => {
    const requests = scripted((index) => [read(pending.entrypoint, 0, `read_${index}`)]);
    const result = await Effect.runPromise(
      Effect.either(
        makeGuardian(
          makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, {
            ...native,
            policies: { publication: "Synthetic host publication policy." },
            specialize: (turn) =>
              turn.pending.publication === undefined
                ? {}
                : { input: { trusted_host_record: { synthetic: true } } },
          }),
        ).review(pending, sourcesOf(files)),
      ),
    );
    const policy = policyOf(requests[0]);
    expect(policy).toContain("Synthetic host publication policy.");
    expect(policy).not.toContain(guardianPublicationPolicy);
    expect(instructionsOf(requests[0])).not.toContain("Synthetic host publication policy.");
    const request = reviewRequest(requests[0]);
    const keys = Object.keys(request);
    const at = keys.indexOf("trusted_authority");
    expect(keys.slice(at, at + 3)).toEqual([
      "trusted_authority",
      "trusted_host_record",
      "trusted_execution_environment",
    ]);
    expect(request).not.toHaveProperty("trusted_publication");
    expect(result).toMatchObject({ _tag: "Left", left: { code: "TurnLimitExceeded" } });
    // Its 12 turns, then the one final turn that must decide.
    expect(requests).toHaveLength(13);
  });

  // A host that still sends its publication policy with each review, the deprecated way, keeps
  // it: the review's request carries it in place of the core policy, with no file index and
  // the 12-turn default.
  it("keeps a host's own per-review publication policy, input and turn limit as it sends them", async () => {
    const requests = scripted((index) => [read(pending.entrypoint, 0, `read_${index}`)]);
    const result = await Effect.runPromise(
      Effect.either(
        makeGuardian(
          makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, {
            ...native,
            specialize: (turn) =>
              turn.pending.publication === undefined
                ? {}
                : {
                    policy: "Synthetic host publication policy.",
                    input: { trusted_host_record: { synthetic: true } },
                  },
          }),
        ).review(pending, sourcesOf(files)),
      ),
    );
    const policy = policyOf(requests[0]);
    expect(policy.split("\n\n").at(-1)).toBe("Synthetic host publication policy.");
    expect(policy).not.toContain(guardianPublicationPolicy);
    const request = reviewRequest(requests[0]);
    const keys = Object.keys(request);
    const at = keys.indexOf("trusted_authority");
    expect(keys.slice(at, at + 3)).toEqual([
      "trusted_authority",
      "trusted_host_record",
      "trusted_execution_environment",
    ]);
    expect(request).not.toHaveProperty("trusted_publication");
    expect(result).toMatchObject({ _tag: "Left", left: { code: "TurnLimitExceeded" } });
    // Its 12 turns, then the one final turn that must decide.
    expect(requests).toHaveLength(13);
  });

  // Guardian lets a "By design:" input, a limited use such as a postal code that only lists
  // nearby stores, count as applied on two facts the host alone controls: the caller's answer to
  // the input's design question, bound to it by the question's id, and on a repair the host's
  // record of the published revision's inputs. The review gets the answer under its id and the
  // record exactly when the host supplies one, beside the shared rule that reads them.
  it.each([
    [
      "a repair whose host supplies the published revision's inputs",
      [
        {
          name: "postalCode",
          description: "By design: used only to find nearby stores; it does not change the selected store.",
        },
        { name: "query" },
      ],
    ],
    ["a build whose host supplies none", undefined],
  ])(
    "gives %s the caller's design answer by its id, and the published inputs only as supplied",
    async (_case, publishedInputs) => {
      const prompt = "Should the postal code set the store, or only list nearby stores?";
      const answeredQuestions = await Effect.runPromise(
        answersForReview(
          {
            questions: [
              {
                id: "input_use_postal_code",
                type: "choice",
                prompt,
                options: [
                  { id: "set_store", label: "Set the store from it" },
                  { id: "nearby_only", label: "Only list nearby stores" },
                ],
              },
            ],
          },
          { input_use_postal_code: { type: "choice", value: "nearby_only" } },
          Effect.succeed,
        ),
      );
      const publication = {
        files: pending.publication?.files ?? [],
        ...(publishedInputs === undefined ? {} : { publishedInputs }),
      };
      const requests = scripted(() => [message(allow)]);
      await Effect.runPromise(
        makeGuardian(
          makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native),
        ).review({ ...pending, answeredQuestions, publication }, sourcesOf(files)),
      );
      const request = reviewRequest(requests[0]);
      expect(request["trusted_authority"]).toMatchObject({
        answeredQuestions: [
          { id: "input_use_postal_code", question: prompt, answer: "Only list nearby stores" },
        ],
      });
      expect(request["trusted_publication"]).toEqual(publication);
      if (publishedInputs === undefined)
        expect(request["trusted_publication"]).not.toHaveProperty("publishedInputs");
      expect(policyOf(requests[0])).toContain(publicationOutputPolicy);
    },
  );

  // A caller who settles how the tool behaves, such as blank fields as empty strings, does so in
  // the build's request, an answer or a task update. The publication review gets all three
  // beside the rule that honours that decision, and a host that composes its own publication
  // policy from the shared output rules gets the rule with them.
  it("gives the publication review the caller's design decisions and the rule that honours them", async () => {
    const intent = "Read each order. Return a blank field as an empty string.";
    const prompt = "How should the tool return a field the record leaves blank?";
    const answeredQuestions = await Effect.runPromise(
      answersForReview(
        {
          questions: [
            {
              id: "blank_fields",
              type: "choice",
              prompt,
              options: [
                { id: "empty", label: "As an empty string" },
                { id: "null", label: "As null with a reason" },
              ],
            },
          ],
        },
        { blank_fields: { type: "choice", value: "empty" } },
        Effect.succeed,
      ),
    );
    const requests = scripted(() => [message(allow)]);
    await Effect.runPromise(
      makeGuardian(
        makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native),
      ).review({ ...pending, screenedIntent: intent, answeredQuestions }, sourcesOf(files)),
    );
    expect(instructionsOf(requests[0])).toContain(`trusted_request: ${JSON.stringify({ intent })}`);
    expect(reviewRequest(requests[0])["trusted_authority"]).toMatchObject({
      answeredQuestions: [{ id: "blank_fields", question: prompt, answer: "As an empty string" }],
    });
    expect(policyOf(requests[0])).toContain(publicationCallerDecisionPolicy);
    expect(publicationOutputPolicy).toContain(publicationCallerDecisionPolicy);
  });

  // One caller's "always" answer must not make a published write take a paid add-on, an upsell,
  // a payment method or a delivery address for every later caller. Both rules that could excuse
  // such a choice, the input schema review and the caller decision rule, carry the same limit.
  it("limits a caller's decision on a write's paid or payment choices in both rules that read it", () => {
    expect(publicationCallerDecisionPolicy).toContain(publicationPaidChoiceLimit);
    const inputReview = guardianPublicationPolicy
      .split("\n")
      .find((line) => line.startsWith("Review the public input schema"));
    expect(inputReview).toContain(publicationPaidChoiceLimit);
  });

  it("gives an execution review no publication policy or index", async () => {
    const requests = scripted((index) =>
      index === 0
        ? [read(pending.entrypoint)]
        : [message({ outcome: "allow", rationale: "Fine.", action: "read" })],
    );
    const { publication: _publication, ...execution } = pending;
    await Effect.runPromise(
      makeGuardian(
        makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native),
      ).review(execution, sourcesOf(files)),
    );
    expect(policyOf(requests[0])).not.toContain(guardianPublicationPolicy);
    expect(reviewRequest(requests[0])).not.toHaveProperty("trusted_publication");
  });

  it.each([false, true])(
    "finishes a multi-file publication review or reports its 32-turn limit, repeatUnavailable=%s",
    async (repeatUnavailable) => {
      const source = 'export const value = "PRIVATE_SOURCE_CANARY";';
      const manifest = Array.from({ length: 13 }, (_, index) => ({
        path: `operation/src/file-${index}.mjs`,
        byteLength: Buffer.byteLength(source),
        published: true,
        current: true,
        owner: "minter" as const,
      }));
      const request: PendingExecution = {
        ...pending,
        entrypoint: manifest[0]?.path ?? "missing",
        publication: { files: manifest },
      };
      const requests = scripted((index) => {
        const file = manifest[index];
        return repeatUnavailable || file !== undefined
          ? [
              read(
                repeatUnavailable ? "operation/src/unavailable.mjs" : (file?.path ?? ""),
                0,
                `read_${index}`,
              ),
            ]
          : [message(allow)];
      });
      const events: { name: string; details: unknown }[] = [];
      const diagnostics: GuardianDiagnostics = {
        emit: (name, details) =>
          Effect.sync(() => {
            events.push({ name, details });
          }),
        retainScreenedSource: () => Effect.void,
        retainModelTranscript: () => Effect.void,
      };
      const result = await Effect.runPromise(
        Effect.either(
          makeGuardian(
            makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native),
            diagnostics,
          ).review(request, sourcesOf(new Map(manifest.map((file) => [file.path, source])))),
        ),
      );
      expect(result).toMatchObject(
        repeatUnavailable
          ? { _tag: "Left", left: { code: "TurnLimitExceeded" } }
          : { _tag: "Right", right: { decision: { outcome: "allow" } } },
      );
      // A review that never decides gets its 32 turns and the one final turn.
      expect(requests).toHaveLength(repeatUnavailable ? 33 : 14);
      expect(events.find((event) => event.name === "guardian.started")).toMatchObject({
        details: { details: { manifestFiles: 13 } },
      });
    },
  );

  // A host can require a site name and summary on a site's first publication, even for a tool
  // that never opens the site, such as a parser that only transforms its input. That naming files
  // the tool under the site and is no claim that the tool uses it; a description that promises
  // site behavior the source lacks is still an unsupported claim.
  it("tells the review that host-required site naming is no claim the tool uses the site", async () => {
    const offline = new Map([
      [
        "operation/src/tool.mjs",
        "export const parse = (text) => ({ lines: text.split(/\\n/u) });",
      ],
      [
        "publication/definition.json",
        JSON.stringify({
          name: "parse_receipt_text",
          description: "Split pasted receipt text into lines",
          site: {
            name: "Example Store",
            summary: "An online store that sells synthetic household goods.",
          },
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
        }),
      ],
    ]);
    const requests = scripted(() => [message(allow)]);
    await Effect.runPromise(
      makeGuardian(
        makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native),
      ).review(
        {
          ...pending,
          publication: {
            files: [...offline].map(([path, source]) => ({
              path,
              byteLength: Buffer.byteLength(source),
              published: true,
              current: true,
              owner: path.startsWith("publication/") ? ("host" as const) : ("minter" as const),
            })),
          },
        },
        sourcesOf(offline),
      ),
    );
    const naming =
      "is no unsupported_claim for its site naming alone. The tool's own name, description or a declared variant that promises site behavior the source lacks still is.";
    // A host with its own publication policy composes the same decision policy.
    expect(publicationDecisionPolicy).toContain(naming);
    const policy = policyOf(requests[0]);
    expect(policy).toContain(naming);
    expect(policy).toContain(
      "unsupported_claim with an in-manifest unsupported_claim finding at the overclaiming definition text when the name, description or a declared variant promises what the source does not do,",
    );
  });

  it("keeps a host's own turn limit for a publication review", async () => {
    const requests = scripted((index) => [read(pending.entrypoint, 0, `read_${index}`)]);
    const result = await Effect.runPromise(
      Effect.either(
        makeGuardian(
          makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, {
            ...native,
            specialize: () => ({ maxTurns: 3 }),
          }),
        ).review(pending, sourcesOf(files)),
      ),
    );
    expect(result).toMatchObject({ _tag: "Left", left: { code: "TurnLimitExceeded" } });
    expect(requests).toHaveLength(4);
  });

  it.each([
    { reason: "unsupported_claim", category: "unsupported_claim" },
    { reason: "input_feedback", category: "account_specific_enum" },
    { reason: "source_correction", category: "example_value" },
    { reason: "privacy", category: "safety_default" },
  ])(
    "accepts a $reason decision with a $category finding through the reviewer output schema",
    async ({ reason, category }) => {
      const requests = scripted(() => [
        message({
          outcome: "deny",
          reason,
          rationale: "The schema encodes a private account-specific choice",
          findings: [
            { path: "publication/definition.json", byteStart: 0, byteEnd: 1, category, explanation },
          ],
        }),
      ]);
      const result = await Effect.runPromise(
        makeGuardian(
          makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native),
        ).review(pending, sourcesOf(files)),
      );
      expect(result.decision).toMatchObject({
        outcome: "deny",
        reason,
        findings: [{ path: "publication/definition.json", category }],
      });
      expect(JSON.stringify(requests[0]?.outputType)).toContain(category);
    },
  );

  it("completes a review whose model reads one chunk past the end of a large file", async () => {
    const source = `export const value = "${"x".repeat(70_000)}";`;
    const path = "operation/src/large.mjs";
    const request: PendingExecution = {
      ...pending,
      entrypoint: path,
      publication: {
        files: [
          {
            path,
            byteLength: Buffer.byteLength(source),
            published: true,
            current: true,
            owner: "minter",
          },
        ],
      },
    };
    const reads = [[0], [65_536, 131_072]];
    const requests = scripted((index) => {
      const offsets = reads[index];
      return offsets === undefined
        ? [message(allow)]
        : offsets.map((offset, at) => read(path, offset, `read_${index}_${at}`));
    });
    const result = await Effect.runPromise(
      Effect.either(
        makeGuardian(
          makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native),
        ).review(request, sourcesOf(new Map([[path, source]]))),
      ),
    );
    expect(result).toMatchObject({ _tag: "Right", right: { decision: { outcome: "allow" } } });
    expect(requests).toHaveLength(3);
  });
});
