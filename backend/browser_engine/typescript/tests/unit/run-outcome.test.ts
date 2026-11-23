import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { contractJsonSchema } from "../../src/runtime/operation.js";
import {
  classifyRun,
  commitReportOf,
  commitRetryRefusal,
  confirmedRun,
  declaredRefusalOf,
  declaredRefusalReasons,
  possibleCommit,
  returnedRefusal,
  runError,
  runOutcomeCodes,
  runOutcomeRetry,
  runnerVerified,
  unconfirmedWrite,
  unenteredWrite,
  unreadableRefusal,
  validatedWriteNeeds,
  writeStatusOf,
  type RunEvidence,
} from "../../src/runtime/run-outcome.js";
import { classifiedOutcomes } from "../../src/runtime/failure-renderer-contract.js";

describe("commit evidence", () => {
  it.each([
    { report: undefined, evidence: "unreported" },
    { report: "not json", evidence: "unreported" },
    { report: { commits: [{ name: "Has Spaces", state: "sent" }] }, evidence: "unreported" },
    { report: { commits: [{ name: "save", state: "maybe" }] }, evidence: "unreported" },
    { report: { commits: [] }, evidence: "undeclared" },
    {
      report: {
        commits: [
          { name: "save", state: "not_sent" },
          { name: "place-order", state: "not_sent" },
        ],
      },
      evidence: "not_entered",
    },
    {
      report: {
        commits: [
          { name: "save", state: "not_sent" },
          { name: "place-order", state: "sent" },
        ],
      },
      evidence: "entered",
    },
    { report: { commits: [{ name: "save", state: "confirmed" }] }, evidence: "entered" },
    // Any short identifier is a mark name: underscores and either case pass, as hyphens do.
    { report: { commits: [{ name: "place_order", state: "sent" }] }, evidence: "entered" },
    { report: { commits: [{ name: "placeOrder", state: "sent" }] }, evidence: "entered" },
    // A space, a dot or more than 48 characters is not a mark name, so the report proves nothing.
    { report: { commits: [{ name: "place.order", state: "sent" }] }, evidence: "unreported" },
    { report: { commits: [{ name: `a${"b".repeat(48)}`, state: "sent" }] }, evidence: "unreported" },
  ])("reads $evidence from $report", ({ report, evidence }) => {
    expect(commitReportOf(report).evidence).toBe(evidence);
  });

  it("keeps the marks only when the report is readable", () => {
    expect(commitReportOf({ commits: [{ name: "save", state: "sent" }] })).toEqual({
      evidence: "entered",
      marks: [{ name: "save", state: "sent" }],
    });
    expect(commitReportOf({})).toEqual({ evidence: "unreported" });
  });

  it("keeps a mark named with underscores or capitals, as the script entered it", () => {
    const marks = [
      { name: "save_address", state: "confirmed" },
      { name: "placeOrder", state: "sent" },
    ];
    expect(commitReportOf({ commits: marks })).toEqual({ evidence: "entered", marks });
  });

  it.each([
    { evidence: "not_entered", refusal: undefined },
    { evidence: "entered", refusal: "commit_entered" },
    { evidence: "undeclared", refusal: "commit_undeclared" },
    { evidence: "unreported", refusal: "commit_unreported" },
  ] as const)("refuses a repeat after $evidence with $refusal", ({ evidence, refusal }) => {
    expect(commitRetryRefusal(evidence)).toBe(refusal);
  });
});

describe("a write that entered none of its declared commit steps", () => {
  const notSent = { name: "save", state: "not_sent" } as const;
  it.each([
    { case: "every declared mark unsent", effect: "may_have_dispatched", marks: [notSent], unentered: true },
    {
      case: "several declared marks, all unsent",
      effect: "may_have_dispatched",
      marks: [notSent, { name: "place-order", state: "not_sent" }],
      unentered: true,
    },
    {
      case: "one mark entered",
      effect: "may_have_dispatched",
      marks: [notSent, { name: "place-order", state: "sent" }],
      unentered: false,
    },
    { case: "no declared marks", effect: "may_have_dispatched", marks: [], unentered: false },
    { case: "no readable report", effect: "may_have_dispatched", marks: undefined, unentered: false },
    { case: "nothing dispatched", effect: "not_started", marks: [notSent], unentered: false },
    { case: "a recorded confirmation", effect: "verified", marks: [notSent], unentered: false },
  ] as const)("is $unentered with $case", ({ effect, marks, unentered }) => {
    expect(unenteredWrite(effect, marks)).toBe(unentered);
  });
});

describe("write confirmation", () => {
  const write = (writeConfirmation?: "message" | "readback" | "unverifiable") => ({
    effect: "write" as const,
    ...(writeConfirmation === undefined ? {} : { writeConfirmation }),
  });
  it.each([
    { revision: undefined, effect: "verified", confirmation: undefined, verified: true },
    { revision: { effect: "read" }, effect: "verified", confirmation: undefined, verified: true },
    { revision: write(), effect: "verified", confirmation: undefined, verified: true },
    { revision: write("message"), effect: "verified", confirmation: undefined, verified: false },
    { revision: write("message"), effect: "verified", confirmation: "message", verified: true },
    { revision: write("readback"), effect: "verified", confirmation: "readback", verified: true },
    {
      revision: write("message"),
      effect: "may_have_dispatched",
      confirmation: "message",
      verified: false,
    },
    { revision: write(), effect: "not_started", confirmation: undefined, verified: false },
  ] as const)(
    "runner effect $effect with confirmation $confirmation verifies: $verified",
    ({ revision, effect, confirmation, verified }) => {
      expect(runnerVerified(revision, effect, confirmation)).toBe(verified);
    },
  );

  it.each([
    { revision: undefined, effect: "may_have_dispatched", needs: "nothing" },
    { revision: { effect: "read" }, effect: "may_have_dispatched", needs: "nothing" },
    { revision: write("message"), effect: "verified", needs: "nothing" },
    { revision: write("message"), effect: "may_have_dispatched", needs: "confirmation_missing" },
    { revision: write(), effect: "may_have_dispatched", needs: "confirmation_missing" },
    { revision: write("unverifiable"), effect: "may_have_dispatched", needs: "unverifiable" },
    { revision: write("readback"), effect: "rejected", needs: "nothing" },
  ] as const)("a validated $effect write needs $needs", ({ revision, effect, needs }) => {
    expect(validatedWriteNeeds(revision, effect)).toBe(needs);
  });
});

const evidence = (fields: Partial<RunEvidence>): RunEvidence => ({
  status: "completed",
  effect: "not_started",
  output: "failed",
  tool_effect: "write",
  ...fields,
});

describe("run failures", () => {
  // The details keep their keys and order, since another host answers them as JSON.
  it.each([
    {
      run: evidence({ failure_reason: "no_response", effect: "may_have_dispatched" }),
      json: '{"code":"no_response","details":{"possible_commit":true}}',
    },
    {
      run: evidence({ failure_reason: "no_response", possible_commit: false }),
      json: '{"code":"no_response","details":{"possible_commit":false}}',
    },
    {
      run: evidence({
        failure_reason: "no_response",
        possible_commit: false,
        unanswered_question: "sign_in",
      }),
      json: '{"code":"no_response","details":{"possible_commit":false,"question":"sign_in"}}',
    },
    {
      run: evidence({
        failure_reason: "no_response",
        effect: "may_have_dispatched",
        unanswered_question: "other",
      }),
      json: '{"code":"no_response","details":{"possible_commit":true,"question":"other"}}',
    },
    {
      run: evidence({ failure_reason: "credentials_rejected", rejected_field: "password" }),
      json: '{"code":"credentials_rejected","details":{"possible_commit":false,"field":"password"}}',
    },
    {
      run: evidence({
        failure_reason: "invalid_input",
        effect: "rejected",
        refusal_reason: "The date must be in the future.",
      }),
      json: '{"code":"input_rejected","details":{"possible_commit":false,"reason":"The date must be in the future."}}',
    },
    {
      run: evidence({ failure_reason: "invalid_input", effect: "may_have_dispatched" }),
      json: '{"code":"input_rejected","details":{"possible_commit":true}}',
    },
    {
      run: evidence({ failure_reason: "login_identity_conflict" }),
      json: '{"code":"login_identity_conflict","details":{}}',
    },
    {
      run: evidence({ failure_reason: "login_check_unavailable" }),
      json: '{"code":"website_sign_in_unavailable","details":{}}',
    },
    {
      run: evidence({ failure_reason: "worker_lost", tool_effect: "read", effect: "unknown" }),
      json: '{"code":"worker_lost","details":{}}',
    },
    {
      run: evidence({ failure_reason: "worker_lost" }),
      json: '{"code":"worker_lost","details":{}}',
    },
    {
      run: evidence({ failure_reason: "worker_lost", effect: "may_have_dispatched" }),
      json: '{"code":"outcome_unknown","details":{}}',
    },
    {
      run: evidence({ effect: "may_have_dispatched", output: "valid" }),
      json: '{"code":"outcome_unknown","details":{}}',
    },
    // A write that recorded its confirmation landed, so its outcome is never unknown.
    {
      run: evidence({ status: "outcome_unknown", effect: "verified", output: "valid" }),
      json: '{"code":"execution_failed","details":{}}',
    },
    {
      run: evidence({ failure_reason: "worker_lost", effect: "verified" }),
      json: '{"code":"worker_lost","details":{}}',
    },
    {
      run: evidence({ status: "outcome_unknown", effect: "verified", tool_effect: undefined }),
      json: '{"code":"outcome_unknown","details":{}}',
    },
    {
      run: evidence({ effect: "verified", output: "invalid" }),
      json: '{"code":"invalid_output","details":{}}',
    },
    { run: evidence({}), json: '{"code":"execution_failed","details":{}}' },
    {
      run: evidence({ failure_reason: "something_new" }),
      json: '{"code":"execution_failed","details":{}}',
    },
  ])("answers $json", ({ run, json }) => {
    expect(JSON.stringify(runError(run))).toBe(json);
  });

  it.each([
    { run: evidence({ tool_effect: "read" }), status: null },
    { run: evidence({ tool_effect: undefined }), status: null },
    { run: evidence({ status: "outcome_unknown", effect: "verified" }), status: "applied" },
    { run: evidence({ status: "outcome_unknown", effect: "not_started" }), status: "may_have_applied" },
    { run: evidence({ effect: "may_have_dispatched" }), status: "may_have_applied" },
    { run: evidence({ effect: "unknown" }), status: "may_have_applied" },
    { run: evidence({ effect: "partial" }), status: "may_have_applied" },
    { run: evidence({ effect: "verified" }), status: "applied" },
    { run: evidence({ effect: "rejected" }), status: "not_applied" },
    { run: evidence({ effect: "not_started" }), status: "not_attempted" },
  ])("gives write status $status", ({ run, status }) => {
    expect(writeStatusOf(run)).toBe(status);
  });

  it.each([
    { run: evidence({ possible_commit: true }), possible: true },
    { run: evidence({ effect: "may_have_dispatched" }), possible: true },
    { run: evidence({ status: "outcome_unknown" }), possible: true },
    // An applied write changed the website, so its caller must never read it as safe to retry.
    { run: evidence({ effect: "verified" }), possible: true },
    { run: evidence({ effect: "verified", tool_effect: undefined }), possible: true },
    { run: evidence({ effect: "verified", tool_effect: "read" }), possible: false },
    { run: evidence({ effect: "rejected" }), possible: false },
  ])("possible commit is $possible", ({ run, possible }) => {
    expect(possibleCommit(run)).toBe(possible);
  });

  it.each([
    { run: evidence({ effect: "verified", output: "valid" }), confirmed: true },
    { run: evidence({ effect: "not_started", output: "valid" }), confirmed: true },
    {
      run: evidence({ status: "cleanup_pending", effect: "verified", output: "valid" }),
      confirmed: true,
    },
    {
      run: evidence({ effect: "verified", output: "invalid", output_drift: true }),
      confirmed: true,
    },
    { run: evidence({ effect: "may_have_dispatched", output: "valid" }), confirmed: false },
    { run: evidence({ effect: "verified", output: "invalid" }), confirmed: false },
    { run: evidence({ status: "outcome_unknown", effect: "verified", output: "valid" }), confirmed: false },
  ])("a run is confirmed: $confirmed", ({ run, confirmed }) => {
    expect(confirmedRun(run)).toBe(confirmed);
  });

  it.each([
    { run: evidence({ effect: "may_have_dispatched", output: "valid" }), kept: true },
    { run: evidence({ failure_reason: "worker_lost", output: "valid" }), kept: true },
    { run: evidence({ effect: "may_have_dispatched", output: "failed" }), kept: false },
    {
      run: evidence({ effect: "may_have_dispatched", output: "valid", tool_effect: "read" }),
      kept: false,
    },
    { run: evidence({ effect: "verified", output: "invalid" }), kept: false },
  ])("an unconfirmed write keeps its result: $kept", ({ run, kept }) => {
    expect(unconfirmedWrite(run)).toBe(kept);
  });
});

describe("run outcomes", () => {
  it("leaves a confirmed run unclassified", () => {
    expect(classifyRun(evidence({ effect: "verified", output: "valid" }))).toBeUndefined();
  });

  it("reports a write that returned without its confirmation as possibly applied", () => {
    expect(classifyRun(evidence({ effect: "may_have_dispatched", output: "valid" }))).toEqual({
      code: "outcome_unknown",
      details: {},
      writeStatus: "may_have_applied",
      possibleCommit: true,
      retry: "never",
    });
  });

  it("reports a write applied before its run failed as a possible commit, not a clean retry", () => {
    // The write read back its confirmation, then the job failed for another reason.
    const applied = { effect: "verified", output: "failed" } as const;
    expect(writeStatusOf(evidence(applied))).toBe("applied");
    expect(possibleCommit(evidence(applied))).toBe(true);
    for (const failure_reason of ["no_response", "credentials_rejected", "invalid_input"])
      expect(classifyRun(evidence({ ...applied, failure_reason }))).toMatchObject({
        details: { possible_commit: true },
        writeStatus: "applied",
        possibleCommit: true,
      });
  });

  // A recorded confirmation makes the write a result: whatever failed after it, the run reports
  // it applied and never runs it again, keeping why it failed.
  it.each([
    { failure_reason: undefined },
    { failure_reason: "no_response" },
    { failure_reason: "credentials_rejected" },
    { failure_reason: "invalid_input" },
    { failure_reason: "input_not_applied" },
    { failure_reason: "login_identity_conflict" },
    { failure_reason: "login_check_unavailable" },
    { failure_reason: "worker_lost" },
    { failure_reason: undefined, status: "outcome_unknown" },
    { failure_reason: undefined, output: "invalid" },
  ])("reports a confirmed write that then failed as applied, never to run again: %o", (fields) => {
    const outcome = classifyRun(evidence({ effect: "verified", output: "failed", ...fields }));
    expect(outcome).toMatchObject({ writeStatus: "applied", retry: "never" });
    expect(outcome?.code).not.toBe("outcome_unknown");
  });

  it("never offers a confirmed write another run", () => {
    for (const outcome of classifiedOutcomes())
      if (outcome.writeStatus === "applied") expect(outcome.retry).toBe("never");
  });

  it("reports a refused input that sent nothing as not applied and safe to correct", () => {
    expect(
      classifyRun(evidence({ failure_reason: "invalid_input", effect: "rejected" })),
    ).toEqual({
      code: "input_rejected",
      details: { possible_commit: false },
      writeStatus: "not_applied",
      possibleCommit: false,
      retry: "fix_input",
    });
  });

  it("claims a possible commit only for a code whose meaning allows one", () => {
    expect(
      classifyRun(
        evidence({ failure_reason: "worker_lost", tool_effect: "read", possible_commit: true }),
      ),
    ).toMatchObject({ code: "worker_lost", possibleCommit: false });
    expect(
      [
        ...new Set(
          classifiedOutcomes()
            .filter((outcome) => outcome.possibleCommit)
            .map((outcome) => outcome.code),
        ),
      ].sort(),
    ).toEqual(["credentials_rejected", "input_rejected", "no_response", "outcome_unknown"]);
    for (const outcome of classifiedOutcomes())
      if ("possible_commit" in outcome.details)
        expect(outcome.possibleCommit).toBe(outcome.details["possible_commit"]);
  });

  it("gives every code a retry class", () => {
    expect(Object.keys(runOutcomeRetry).sort()).toEqual([...runOutcomeCodes].sort());
  });

  it("produces exactly the listed codes over every evidence combination", () => {
    expect([...new Set(classifiedOutcomes().map((outcome) => outcome.code))].sort()).toEqual(
      [...runOutcomeCodes].sort(),
    );
  });
});

describe("an input the page did not apply", () => {
  const unapplied_input = { field: "zip", requested: "00001", step: "store_save" };
  const failed = (evidence: Partial<RunEvidence>): RunEvidence => ({
    status: "completed",
    effect: "not_started",
    output: "failed",
    tool_effect: "read",
    failure_reason: "input_not_applied",
    unapplied_input,
    ...evidence,
  });

  it.each([
    { name: "a read", evidence: {} },
    { name: "a write that sent nothing", evidence: { tool_effect: "write", effect: "rejected" } },
  ] as const)("may run again with the same request for $name", ({ evidence }) => {
    expect(classifyRun(failed(evidence))).toMatchObject({
      code: "input_not_applied",
      retry: "same_key",
      possibleCommit: false,
    });
  });

  it.each([
    {
      name: "a confirmed write",
      evidence: { tool_effect: "write", effect: "verified" },
      code: "execution_failed",
    },
    { name: "a run that judged a step may have committed", evidence: { possible_commit: true } },
    {
      name: "a write that may have dispatched",
      evidence: { tool_effect: "write", effect: "may_have_dispatched" },
      code: "outcome_unknown",
    },
  ] as const)("never offers $name a same-request retry", ({ evidence, ...expected }) => {
    const outcome = classifyRun(failed(evidence));
    expect(outcome?.code).not.toBe("input_not_applied");
    expect(outcome?.retry).not.toBe("same_key");
    if ("code" in expected) expect(outcome?.code).toBe(expected.code);
  });

  it("keeps the detail of a record an earlier release kept for a location", () => {
    const { unapplied_input: _, ...rest } = failed({});
    const old: RunEvidence = {
      ...rest,
      failure_reason: "location_not_applied",
      location: { field: "zip", requested: "00001", applied: "00002", step: "store_save" },
    };
    expect(classifyRun(old)).toMatchObject({
      code: "input_not_applied",
      retry: "same_key",
      details: { field: "zip", requested: "00001", applied: "00002", step: "store_save" },
    });
  });
});

describe("a refusal a write declares in its output", () => {
  const Placed = Schema.Struct({ status: Schema.Literal("placed"), orderNumber: Schema.String });
  const refused = <Reason extends string>(reason: Schema.Schema<Reason>) =>
    Schema.Struct({ status: Schema.Literal("refused"), reason, total: Schema.String });
  const overLimit = refused(Schema.Literal("over_price_limit", "out_of_stock"));
  const schemaOf = <A, I>(schema: Schema.Schema<A, I>) => contractJsonSchema(schema);

  it.each([
    { case: "a union branch", schema: schemaOf(Schema.Union(Placed, overLimit)) },
    {
      case: "a branch behind a local reference",
      schema: schemaOf(Schema.Union(Placed, overLimit.annotations({ identifier: "Refused" }))),
    },
    {
      case: "reasons each with their own description",
      schema: schemaOf(
        Schema.Union(
          Placed,
          refused(
            Schema.Union(
              Schema.Literal("over_price_limit").annotations({ description: "Over the limit" }),
              Schema.Literal("out_of_stock").annotations({ description: "Sold out" }),
            ),
          ),
        ),
      ),
    },
    {
      case: "one branch per reason",
      schema: schemaOf(
        Schema.Union(
          Placed,
          refused(Schema.Literal("over_price_limit")),
          refused(Schema.Literal("out_of_stock")),
        ),
      ),
    },
  ])("reads the reasons of $case", ({ schema }) => {
    expect([...declaredRefusalReasons(schema)].sort()).toEqual(["out_of_stock", "over_price_limit"]);
  });

  it.each([
    { case: "no refusal branch", schema: schemaOf(Placed) },
    { case: "a free-text reason", schema: schemaOf(Schema.Union(Placed, refused(Schema.String))) },
    {
      case: "a reason that is not a stable code",
      schema: schemaOf(Schema.Union(Placed, refused(Schema.Literal("Over the limit")))),
    },
    {
      case: "an optional reason",
      schema: schemaOf(
        Schema.Union(
          Placed,
          Schema.Struct({
            status: Schema.Literal("refused"),
            reason: Schema.optional(Schema.Literal("over_price_limit")),
          }),
        ),
      ),
    },
    {
      case: "a status that admits more than refused",
      schema: schemaOf(
        Schema.Struct({
          status: Schema.Literal("placed", "refused"),
          reason: Schema.Literal("over_price_limit"),
        }),
      ),
    },
    // Another branch that admits a "refused" status could be the one the output matched, so no
    // output of the schema proves itself a refusal.
    {
      case: "another branch whose free-text status admits refused",
      schema: schemaOf(
        Schema.Union(
          Schema.Struct({
            status: Schema.String,
            reason: Schema.String,
            orderNumber: Schema.String,
          }),
          overLimit,
        ),
      ),
    },
    {
      case: "another branch whose listed status includes refused",
      schema: schemaOf(
        Schema.Union(
          Schema.Struct({ status: Schema.Literal("placed", "refused"), orderNumber: Schema.String }),
          overLimit,
        ),
      ),
    },
    {
      case: "another branch that allows any extra property",
      schema: {
        anyOf: [
          {
            type: "object",
            required: ["orderNumber"],
            properties: { orderNumber: { type: "string" } },
          },
          schemaOf(overLimit),
        ],
      },
    },
    {
      case: "another branch whose pattern properties admit a status",
      schema: {
        anyOf: [
          {
            type: "object",
            properties: { orderNumber: { type: "string" } },
            patternProperties: { ".*": { type: "string" } },
            additionalProperties: false,
          },
          schemaOf(overLimit),
        ],
      },
    },
    { case: "a reference that does not resolve", schema: { $ref: "#/$defs/Missing" } },
    { case: "no schema", schema: undefined },
  ])("declares none with $case", ({ schema }) => {
    expect(declaredRefusalReasons(schema).size).toBe(0);
  });

  // Effect writes a union inside a union as a nested `anyOf`, and a refined string `status` as
  // its `pattern`, so a refusal is read from the shape a tool publishes.
  const notEligible = refused(Schema.Literal("not_eligible"));
  const rated = (status: Schema.Schema<string>) =>
    Schema.Struct({ status, premium: Schema.String });
  const patterned = (pattern: RegExp) => Schema.String.pipe(Schema.pattern(pattern));
  /** `levels` unions, each inside the one before, the innermost holding the last refusal. */
  const nestedRefusals = (levels: number) => {
    let inner: Schema.Schema.AnyNoContext = refused(Schema.Literal(`level_${levels}`));
    for (let level = levels; level > 0; level--)
      inner = Schema.Union(refused(Schema.Literal(`level_${level - 1}`)), inner);
    return inner;
  };

  it.each([
    {
      case: "refusals in a union inside the output's union",
      schema: schemaOf(Schema.Union(Placed, Schema.Union(notEligible, overLimit))),
      reasons: ["not_eligible", "out_of_stock", "over_price_limit"],
    },
    {
      case: "a described union inside the output's union",
      schema: schemaOf(
        Schema.Union(
          Placed,
          Schema.Union(notEligible, overLimit).annotations({ description: "Why it stopped" }),
        ),
      ),
      reasons: ["not_eligible", "out_of_stock", "over_price_limit"],
    },
    {
      case: "a union inside the output's union behind a local reference",
      schema: schemaOf(
        Schema.Union(
          Schema.Union(notEligible, overLimit).annotations({ identifier: "Refusal" }),
          Placed,
        ),
      ),
      reasons: ["not_eligible", "out_of_stock", "over_price_limit"],
    },
    {
      case: "another branch whose status pattern cannot match refused",
      schema: schemaOf(Schema.Union(rated(patterned(/^(?!refused$).+$/)), notEligible)),
      reasons: ["not_eligible"],
    },
    {
      case: "unions nested eight deep",
      schema: schemaOf(Schema.Union(Placed, nestedRefusals(8))),
      reasons: Array.from({ length: 9 }, (_, level) => `level_${level}`),
    },
  ])("reads the reasons of $case", ({ schema, reasons }) => {
    expect([...declaredRefusalReasons(schema)].sort()).toEqual(reasons);
  });

  it.each([
    {
      case: "another branch whose status is free text",
      schema: schemaOf(Schema.Union(rated(Schema.String), notEligible)),
    },
    {
      case: "another branch whose status pattern matches refused",
      schema: schemaOf(Schema.Union(rated(patterned(/.+/)), notEligible)),
    },
    {
      case: "a nested union that holds a branch whose status is free text",
      schema: schemaOf(Schema.Union(Placed, Schema.Union(rated(Schema.String), notEligible))),
    },
    {
      // Valid without the `u` flag, which a host's schema check uses, and invalid with it.
      case: "another branch whose status pattern is invalid",
      schema: schemaOf(Schema.Union(rated(patterned(/^(?!refused$)\-?.+$/)), notEligible)),
    },
    {
      case: "unions nested deeper than eight",
      schema: schemaOf(Schema.Union(Placed, nestedRefusals(9))),
    },
    {
      case: "a nested union beside a keyword that is not an annotation",
      schema: {
        anyOf: [schemaOf(Placed), { type: "object", anyOf: [schemaOf(notEligible)] }],
      },
    },
  ])("declares none with $case", ({ schema }) => {
    expect(declaredRefusalReasons(schema).size).toBe(0);
  });

  it.each([
    {
      case: "a nested union beside a branch whose status is free text",
      schema: schemaOf(Schema.Union(rated(Schema.String), Schema.Union(notEligible, overLimit))),
      unreadable: true,
    },
    {
      case: "a refusal with a free-text reason",
      schema: schemaOf(Schema.Union(Placed, refused(Schema.String))),
      unreadable: true,
    },
    {
      case: "a status that admits more than refused",
      schema: schemaOf(
        Schema.Struct({ status: Schema.Literal("placed", "refused"), reason: Schema.String }),
      ),
      unreadable: true,
    },
    {
      case: "refusals in a nested union beside listed statuses",
      schema: schemaOf(Schema.Union(Placed, Schema.Union(notEligible, overLimit))),
      unreadable: false,
    },
    {
      case: "a refusal beside a status pattern that cannot match refused",
      schema: schemaOf(Schema.Union(rated(patterned(/^(?!refused$).+$/)), notEligible)),
      unreadable: false,
    },
    // A schema that never lists a refused status means no refusal, whatever else it admits.
    { case: "no refused status", schema: schemaOf(rated(Schema.String)), unreadable: false },
    {
      case: "a reference that does not resolve",
      schema: { $ref: "#/$defs/Missing" },
      unreadable: false,
    },
    { case: "no schema", schema: undefined, unreadable: false },
  ])("finds an unreadable refusal in $case: $unreadable", ({ schema, unreadable }) => {
    expect(unreadableRefusal(schema)).toBe(unreadable);
  });

  const schema = schemaOf(Schema.Union(Placed, overLimit));
  it("finds a declared refusal only in an output that carries a declared reason", () => {
    expect(
      declaredRefusalOf(schema, { status: "refused", reason: "out_of_stock", total: "$1" }),
    ).toEqual({ reason: "out_of_stock" });
    expect(declaredRefusalOf(schema, { status: "refused", reason: "too_slow" })).toBeUndefined();
    expect(declaredRefusalOf(schema, { status: "placed", orderNumber: "A-1" })).toBeUndefined();
    expect(declaredRefusalOf(schema, "refused")).toBeUndefined();
  });

  const output = { status: "refused", reason: "over_price_limit", total: "$120" };
  it.each([
    { commits: "not_entered", runnerEffect: "may_have_dispatched", refusal: "over_price_limit" },
    { commits: "entered", runnerEffect: "may_have_dispatched", refusal: undefined },
    { commits: "undeclared", runnerEffect: "may_have_dispatched", refusal: undefined },
    { commits: "unreported", runnerEffect: "may_have_dispatched", refusal: undefined },
    // A write that recorded its confirmation applied, whatever it returned.
    { commits: "not_entered", runnerEffect: "verified", refusal: undefined },
  ] as const)(
    "counts a refusal with $commits commit steps and a $runnerEffect runner: $refusal",
    ({ commits, runnerEffect, refusal }) => {
      expect(
        returnedRefusal({ outputSchema: schema, output, commits, runnerEffect })?.reason,
      ).toBe(refusal);
    },
  );

  it("settles a write that returned its declared refusal as not applied, with no failure", () => {
    const refusedRun = evidence({
      effect: "rejected",
      output: "valid",
      declared_refusal: true,
    });
    expect(classifyRun(refusedRun)).toBeUndefined();
    expect(writeStatusOf(refusedRun)).toBe("not_applied");
    expect(possibleCommit(refusedRun)).toBe(false);
    // A rejected effect with valid output and no declared refusal is no settled result.
    expect(confirmedRun(evidence({ effect: "rejected", output: "valid" }))).toBe(false);
  });
});
