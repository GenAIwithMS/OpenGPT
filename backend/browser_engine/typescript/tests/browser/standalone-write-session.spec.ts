import { test, expect } from "@playwright/test";
import {
  call,
  contextOf,
  currentOf,
  execution,
  executionIdOf,
  patch,
  probe,
  recordingGuardian,
  toolResult,
  writePath,
  type RecordedReview,
} from "./guardian-context-fixture.js";
import {
  act,
  draftOnlyTool,
  effectsOf,
  executions,
  getQuoteStep,
  mint,
  noteSite,
  quotePath,
  quoteSite,
  quoteTool,
  readNote,
  saveDraftStep,
  saveNote,
  saveSite,
  saveStep,
} from "./standalone-mint-fixture.js";

/** The note site's write path: its one save. */
const savePath = writePath("save");
const submittedInput = (review: RecordedReview | undefined) =>
  (review?.input["submitted_call"] as Readonly<Record<string, unknown>> | undefined)?.["input"];
const finish = (entrypoint: string, executionId: string, callId: string) =>
  call(
    "finish_build",
    {
      intent: "Return the composed write without running it",
      entrypoint,
      executionId,
      metadata: { name: "save_note", description: "Save the requested note once" },
      coverage: "One confirmed act session on the note the request gave",
    },
    callId,
  );

test("Guardian's denial of a request-derived input records nothing, and the corrected input runs the session", async () => {
  test.setTimeout(90_000);
  const fixture = noteSite();
  const site = await fixture.start();
  const stated = JSON.stringify({ note: "kept" });
  // Guardian allows an act step only on the note the request states.
  const guardian = recordingGuardian({
    decide: (review) =>
      currentOf(review)?.["purpose"] !== "act" || submittedInput(review) === stated
        ? "allow"
        : "deny",
  });
  try {
    const { last } = await mint({
      effect: "write",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "src/read.mjs": readNote, "src/save.mjs": saveNote }),
        () => [call("execute", act("src/read.mjs", { note: "invented" }, savePath), "invented")],
        () => [call("execute", act("src/read.mjs", stated, savePath), "corrected")],
        () => [call("execute", act("src/save.mjs"), "save")],
      ],
    });
    expect(JSON.stringify(toolResult(last, "invented"))).toContain("ReviewDenied");
    expect(toolResult(last, "corrected")).toMatchObject({ status: "completed" });
    expect(toolResult(last, "save")).toMatchObject({ status: "completed" });
    // The denied input was never recorded: the corrected one, not the denied one, runs.
    const acts = executions(guardian.reviews);
    expect(acts.map(submittedInput)).toEqual([
      JSON.stringify({ note: "invented" }),
      stated,
      stated,
    ]);
    expect(acts.map((review) => currentOf(review)?.["input"])).toEqual([
      "intent_derived",
      "intent_derived",
      "intent_derived",
    ]);
    expect(fixture.saved).toEqual(["kept"]);
  } finally {
    await site.close();
  }
});

test("publication refuses a contract that rejects the session's input, and publishes once it decodes it", async () => {
  test.setTimeout(90_000);
  const fixture = noteSite();
  const site = await fixture.start();
  const guardian = recordingGuardian();
  try {
    const { built, last } = await mint({
      effect: "write",
      url: site.url,
      guardian,
      turns: [
        () =>
          patch({
            "src/save.mjs": saveNote,
            // The session ran a text note; this contract declares a number.
            "src/numbered.mjs": saveNote.replace(
              "input:Schema.Struct({note:Schema.String})",
              "input:Schema.Struct({note:Schema.Number})",
            ),
            "src/tool.mjs": saveNote,
          }),
        () => [call("execute", act("src/save.mjs", { note: "kept" }, savePath), "save")],
        (request) => [finish("src/numbered.mjs", executionIdOf(request, "save"), "mismatch")],
        (request) => [finish("src/tool.mjs", executionIdOf(request, "save"), "publish")],
      ],
    });
    expect(toolResult(last, "save")).toMatchObject({ status: "completed" });
    expect(built.build, JSON.stringify(built)).toBe("published");
    expect(toolResult(last, "mismatch")).toMatchObject({
      status: "not_published",
      reason: "contract_input_mismatch",
    });
    expect(fixture.saved).toEqual(["kept"]);
  } finally {
    await site.close();
  }
});

/**
 * The note tool composed with refusals before its save, grouped in a union inside its output's,
 * beside a saved branch whose `status` is `status`.
 */
const refusingSaveNote = (status: string) =>
  saveNote
    .replace(
      "output:Schema.Struct({saved:Schema.Boolean})",
      `output:Schema.Union(Schema.Struct({status:${status},saved:Schema.Boolean}),Schema.Union(...["note_empty","note_too_long"].map((reason) => Schema.Struct({status:Schema.Literal("refused"),reason:Schema.Literal(reason),site_message:Schema.String}))))`,
    )
    .replace(
      'enteringCommit("save");',
      'if(input.note === "") return {status:"refused",reason:"note_empty",site_message:"A note is required"};\n  enteringCommit("save");',
    )
    .replace("return {saved:true};", 'return {status:"saved",saved:true};');

test("publication refuses a composed write whose listed refusals the host can't read, and publishes once it reads them", async () => {
  test.setTimeout(90_000);
  const fixture = noteSite();
  const site = await fixture.start();
  const guardian = recordingGuardian();
  try {
    const { built, last } = await mint({
      effect: "write",
      url: site.url,
      guardian,
      turns: [
        () =>
          patch({
            "src/save.mjs": saveNote,
            // A free-text status beside the refusals could be `refused` too.
            "src/unreadable.mjs": refusingSaveNote("Schema.String"),
            "src/tool.mjs": refusingSaveNote('Schema.Literal("saved")'),
          }),
        () => [call("execute", act("src/save.mjs", { note: "kept" }, savePath), "save")],
        (request) => [finish("src/unreadable.mjs", executionIdOf(request, "save"), "unreadable")],
        (request) => [finish("src/tool.mjs", executionIdOf(request, "save"), "publish")],
      ],
    });
    expect(toolResult(last, "unreadable")).toMatchObject({
      status: "not_published",
      reason: "refusal_unreadable",
      instruction: expect.stringContaining(
        "the output schema has a `status` of `refused` that the host can't read as a declared refusal",
      ),
    });
    expect(built.build, JSON.stringify(built)).toBe("published");
    expect(fixture.saved).toEqual(["kept"]);
  } finally {
    await site.close();
  }
});

test("the first act step that passes exampleInput fixes the session's input after steps on the caller's empty input", async () => {
  test.setTimeout(90_000);
  const fixture = noteSite();
  const site = await fixture.start();
  const guardian = recordingGuardian();
  const stated = JSON.stringify({ note: "kept" });
  try {
    const { built, last } = await mint({
      effect: "write",
      url: site.url,
      guardian,
      turns: [
        () =>
          patch({
            "src/look.mjs": probe(),
            "src/save.mjs": saveNote,
            "src/read.mjs": readNote,
            "src/tool.mjs": saveNote,
          }),
        // The first act step needs no input, so it runs the caller's empty one.
        () => [call("execute", act("src/look.mjs", undefined, savePath), "look")],
        // The first step that passes exampleInput fixes the session's input.
        () => [call("execute", act("src/read.mjs", stated), "read")],
        // A step that passes another is refused, and one that omits it runs it.
        () => [call("execute", act("src/save.mjs", { note: "other" }), "changed")],
        () => [call("execute", act("src/save.mjs"), "save")],
        (request) => [finish("src/tool.mjs", executionIdOf(request, "save"), "publish")],
      ],
    });
    for (const id of ["look", "read", "save"])
      expect(toolResult(last, id), id).toMatchObject({ status: "completed" });
    expect(toolResult(last, "changed")).toMatchObject({ status: "unsupported" });
    expect(JSON.stringify(toolResult(last, "changed"))).toContain(
      "already runs the exampleInput an earlier act step passed",
    );
    expect(fixture.saved).toEqual(["kept"]);
    // Publication decodes the session's input, so the published tool requires it.
    expect(built.build, JSON.stringify(built)).toBe("published");
    expect(built.artifact?.inputSchema).toMatchObject({ required: ["note"] });
    const reviewed = executions(guardian.reviews);
    expect(reviewed.map((review) => currentOf(review)?.["purpose"])).toEqual([
      "act",
      "act",
      "act",
      "contract",
    ]);
    expect(reviewed.map(submittedInput)).toEqual(["{}", stated, stated, stated]);
    expect(reviewed.map((review) => currentOf(review)?.["input"])).toEqual([
      undefined,
      "intent_derived",
      "intent_derived",
      undefined,
    ]);
  } finally {
    await site.close();
  }
});

test("a build with nothing to recover refuses inspect and residual before review", async () => {
  test.setTimeout(90_000);
  const fixture = saveSite();
  const site = await fixture.start();
  const guardian = recordingGuardian();
  try {
    const { last } = await mint({
      effect: "write",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "src/act.mjs": saveStep }),
        () => [call("execute", execution("inspect", "src/act.mjs"), "inspect")],
        () => [call("execute", execution("residual", "src/act.mjs"), "residual")],
      ],
    });
    for (const purpose of ["inspect", "residual"]) {
      expect(toolResult(last, purpose), purpose).toMatchObject({ status: "unsupported" });
      expect(JSON.stringify(toolResult(last, purpose)), purpose).toContain(
        `${purpose} is for a write maintenance recovering a possible write; this build has none to recover.`,
      );
    }
    expect(executions(guardian.reviews)).toEqual([]);
    expect(fixture.writes()).toBe(0);
  } finally {
    await site.close();
  }
});

test("a step whose entrypoint does not parse is refused before review, naming only the position", async () => {
  test.setTimeout(90_000);
  const fixture = saveSite();
  const site = await fixture.start();
  const guardian = recordingGuardian();
  try {
    const { last } = await mint({
      effect: "write",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "src/broken.mjs": "export default ); // private-canary" }),
        () => [call("execute", act("src/broken.mjs"), "broken")],
      ],
    });
    const receipt = toolResult(last, "broken");
    expect(receipt).toMatchObject({ status: "unsupported", effect: "not_sent" });
    expect(JSON.stringify(receipt)).toContain(
      "Submitted entrypoint has invalid source syntax at line 1, column 16. Correct the source before execution. No code was executed.",
    );
    expect(JSON.stringify(receipt)).not.toContain("private-canary");
    expect(executions(guardian.reviews)).toEqual([]);
    expect(fixture.writes()).toBe(0);
  } finally {
    await site.close();
  }
});

test("a write session refuses an authenticate step that would run the agent's own source", async () => {
  test.setTimeout(90_000);
  const fixture = saveSite();
  const site = await fixture.start();
  const guardian = recordingGuardian();
  try {
    const { last } = await mint({
      effect: "write",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "src/act.mjs": saveStep, "src/look.mjs": probe() }),
        // Before the session starts, an authored sign-in still runs.
        () => [call("execute", execution("authenticate", "src/look.mjs"), "before")],
        () => [call("execute", act("src/look.mjs", undefined, savePath), "started")],
        () => [call("execute", execution("authenticate", "src/act.mjs"), "during")],
      ],
    });
    expect(toolResult(last, "before")).toMatchObject({ status: "completed" });
    expect(toolResult(last, "started")).toMatchObject({ status: "completed" });
    expect(toolResult(last, "during")).toMatchObject({ status: "unsupported" });
    expect(JSON.stringify(toolResult(last, "during"))).toContain(
      "only through a signInStep the host fills",
    );
    expect(fixture.writes()).toBe(0);
    const [before, started] = executions(guardian.reviews);
    expect(executions(guardian.reviews)).toHaveLength(2);
    expect(effectsOf(before)[0]).toMatch(/^Signing in on the site's own sign-in page/u);
    expect(currentOf(started!)?.["purpose"]).toBe("act");
  } finally {
    await site.close();
  }
});

const submittedPathOf = (review: RecordedReview | undefined) =>
  (review?.input["submitted_call"] as Readonly<Record<string, unknown>> | undefined)?.["writePath"];
const quoteIntent =
  "Get a quote for the applicant on the quote form: save the applicant, then get the quote";
const finishQuote = (entrypoint: string, executionId: string, callId: string) =>
  call(
    "finish_build",
    {
      intent: "Return the composed quote write without running it",
      entrypoint,
      executionId,
      metadata: { name: "quote_applicant", description: "Get a quote for an applicant" },
      coverage: "One act session through the saved draft to the quote",
    },
    callId,
  );

// The write build's one session saved a draft and read the site's draft notice as its
// confirmation. That confirmation used to close the session, so the quote the request asks for
// never ran, publication asked for it, and no step could run it. Fails when that confirmation
// closes the session before every mark of the declared path is entered, or when Guardian does not
// see the path before the first step and on every step and review after it.
test("a write session declared through to the quote runs on past the draft's confirmation and publishes the whole path", async () => {
  test.setTimeout(90_000);
  const fixture = quoteSite();
  const site = await fixture.start();
  const guardian = recordingGuardian();
  try {
    const { built, last } = await mint({
      effect: "write",
      url: site.url,
      intent: quoteIntent,
      input: { applicant: "Avery" },
      guardian,
      turns: [
        () =>
          patch({
            "src/draft.mjs": saveDraftStep,
            "src/quote.mjs": getQuoteStep,
            "src/tool.mjs": quoteTool,
          }),
        () => [call("execute", act("src/draft.mjs", undefined, quotePath), "draft")],
        () => [call("execute", act("src/quote.mjs"), "quote")],
        (request) => [finishQuote("src/tool.mjs", executionIdOf(request, "quote"), "publish")],
      ],
    });
    // The draft's confirmation leaves the session open, naming the step still to run.
    expect(toolResult(last, "draft")).toMatchObject({
      status: "completed",
      confirmation: "message",
      writePath: { remaining: ["get-quote"] },
    });
    expect(toolResult(last, "quote")).toMatchObject({ status: "completed", confirmation: "message" });
    expect(toolResult(last, "quote")).not.toHaveProperty("writePath");
    expect(built.build, JSON.stringify(built)).toBe("published");
    expect(fixture.drafts).toEqual(["Avery"]);
    expect(fixture.quotes).toEqual(["Avery"]);
    // Guardian judged the declared path on the first step, before anything was sent, and every
    // later review, publication's included, reads the path the host recorded.
    const [first, second, contract] = executions(guardian.reviews);
    expect(submittedPathOf(first)).toEqual(quotePath);
    expect(contextOf(first!)).not.toHaveProperty("writePath");
    expect(submittedPathOf(second)).toBeUndefined();
    expect(contextOf(second!)?.["writePath"]).toEqual(quotePath);
    expect(currentOf(contract!)?.["purpose"]).toBe("contract");
    const publication = guardian.reviews.find((review) => review.kind === "publication");
    expect(contextOf(publication!)?.["writePath"]).toEqual(quotePath);
  } finally {
    await site.close();
  }
});

// Fails when a write session can start without a declared path: nothing would then hold the
// session to the whole task before its first save.
test("a write build's first act step without a write path is refused before review, sending nothing", async () => {
  test.setTimeout(90_000);
  const fixture = quoteSite();
  const site = await fixture.start();
  const guardian = recordingGuardian();
  try {
    const { last } = await mint({
      effect: "write",
      url: site.url,
      intent: quoteIntent,
      input: { applicant: "Avery" },
      guardian,
      turns: [
        () => patch({ "src/draft.mjs": saveDraftStep }),
        () => [call("execute", act("src/draft.mjs"), "draft")],
      ],
    });
    expect(toolResult(last, "draft")).toMatchObject({ status: "unsupported", effect: "not_sent" });
    expect(JSON.stringify(toolResult(last, "draft"))).toContain(
      "A write build's first act step declares writePath before anything is sent",
    );
    expect(executions(guardian.reviews)).toEqual([]);
    expect(fixture.drafts).toEqual([]);
  } finally {
    await site.close();
  }
});

// A quote that waits for an underwriter's approval cannot be reached in one session, and a build
// never gets a second. Fails when Guardian does not judge the path before the first save, or when
// the build can end only after writing.
test("a path no single session can reach is denied before the first save, and the build ends without writing", async () => {
  test.setTimeout(90_000);
  const fixture = quoteSite();
  const site = await fixture.start();
  const waits = {
    ...quotePath,
    ends: "The quote, once an underwriter approves the saved draft the next business day",
  };
  // Guardian denies a path whose outcome waits for someone else, as its policy says.
  const guardian = recordingGuardian({
    decide: (review) =>
      JSON.stringify(submittedPathOf(review) ?? "").includes("underwriter approves")
        ? {
            outcome: "deny",
            rationale:
              "The quote waits for an underwriter's approval the next business day, which no single write session can reach.",
            action: "write",
          }
        : "allow",
  });
  try {
    const { built, last } = await mint({
      effect: "write",
      url: site.url,
      intent: "Save the applicant and get the underwriter-approved quote",
      input: { applicant: "Avery" },
      guardian,
      turns: [
        () => patch({ "src/draft.mjs": saveDraftStep }),
        () => [call("execute", act("src/draft.mjs", undefined, waits), "draft")],
        () => [
          call(
            "report_blocked",
            {
              intent: "End before writing: the quote cannot be reached in one session",
              reason: "site_lacks_capability",
              explanation:
                "The quote waits for an underwriter's approval the next business day, so no single write session can reach it. Nothing was saved.",
            },
            "blocked",
          ),
        ],
      ],
    });
    expect(JSON.stringify(toolResult(last, "draft"))).toContain("ReviewDenied");
    expect(submittedPathOf(executions(guardian.reviews)[0])).toEqual(waits);
    expect(built.blocked).toMatchObject({ reason: "site_lacks_capability" });
    expect(built.build).not.toBe("published");
    expect(fixture.drafts).toEqual([]);
    expect(fixture.quotes).toEqual([]);
  } finally {
    await site.close();
  }
});

// Fails when publication takes a composed script that leaves a step of the recorded path out, so
// the published tool would stop where the session did not.
test("publication refuses a composed script that leaves a mark of the recorded path out, and publishes the whole path", async () => {
  test.setTimeout(90_000);
  const fixture = quoteSite();
  const site = await fixture.start();
  const guardian = recordingGuardian();
  try {
    const { built, last } = await mint({
      effect: "write",
      url: site.url,
      intent: quoteIntent,
      input: { applicant: "Avery" },
      guardian,
      turns: [
        () =>
          patch({
            "src/draft.mjs": saveDraftStep,
            "src/quote.mjs": getQuoteStep,
            "src/draft-only.mjs": draftOnlyTool,
            "src/tool.mjs": quoteTool,
          }),
        () => [call("execute", act("src/draft.mjs", undefined, quotePath), "draft")],
        // Publishing against the draft, before the quote ran, asks for the quote step.
        (request) => [finishQuote("src/tool.mjs", executionIdOf(request, "draft"), "early")],
        () => [call("execute", act("src/quote.mjs"), "quote")],
        (request) => [finishQuote("src/draft-only.mjs", executionIdOf(request, "quote"), "short")],
        (request) => [finishQuote("src/tool.mjs", executionIdOf(request, "quote"), "publish")],
      ],
    });
    expect(toolResult(last, "early")).toMatchObject({
      status: "not_published",
      reason: "write_path_unfinished",
      writePathMarks: ["get-quote"],
    });
    expect(toolResult(last, "short")).toMatchObject({
      status: "not_published",
      reason: "write_path_undeclared",
      writePathMarks: ["get-quote"],
    });
    expect(built.build, JSON.stringify(built)).toBe("published");
    expect(fixture.drafts).toEqual(["Avery"]);
    expect(fixture.quotes).toEqual(["Avery"]);
  } finally {
    await site.close();
  }
});
