import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  LocalOperationFailure,
  type LocalOperationJournal,
  type LocalOperationOutput,
} from "../../src/execution/local-operation.js";
import type { WriteDeclaration } from "../../src/runtime/operation.js";
import { InputRequestFailure } from "../../src/runtime/input-request.js";
import { SignInRunFailed } from "../../src/runtime/sign-in-replay.js";
import {
  beforeOperationFailure,
  returnedRun,
  runOutcomeFailure,
  RunOutcomeFailure,
} from "../../src/standalone/run-report.js";

const readBack = /read the site back before any retry/iu;
const nothingSent: LocalOperationJournal = { effect: "not_sent", commits: [] };
const commitNotEntered: LocalOperationJournal = {
  effect: "possible",
  commits: [{ name: "save", state: "not_sent" }],
};
const commitSent: LocalOperationJournal = {
  effect: "possible",
  commits: [{ name: "save", state: "sent" }],
};
/** A write that recorded its confirmation before entering its declared commit. */
const confirmedUnentered: LocalOperationJournal = {
  effect: "verified",
  confirmation: "message",
  commits: [{ name: "save", state: "not_sent" }],
};
const confirmedWrite: LocalOperationJournal = {
  effect: "verified",
  confirmation: "message",
  commits: [{ name: "save", state: "confirmed" }],
};

const returned = (
  journal: LocalOperationJournal,
  write?: WriteDeclaration,
): LocalOperationOutput => ({
  output: { saved: true },
  schemas: { input: {}, output: {} },
  stdout: "",
  stderr: "",
  ...journal,
  ...(write === undefined ? {} : { write }),
});
const settle = (declared: "read" | "write" | undefined, result: LocalOperationOutput) =>
  Effect.runSync(Effect.either(returnedRun(declared, result)));
const failureOf = (declared: "read" | "write" | undefined, result: LocalOperationOutput) => {
  const settled = settle(declared, result);
  if (Either.isRight(settled)) throw new Error("Expected a failed run");
  return settled.left;
};

describe("a run that returned", () => {
  it("returns a read's output", () => {
    expect(settle("read", returned({ effect: "possible", commits: [] }))).toEqual(
      Either.right({ saved: true }),
    );
  });

  it("returns a confirmed write's output", () => {
    expect(
      settle("write", returned(confirmedWrite, { confirmation: "message", commits: ["save"] })),
    ).toEqual(Either.right({ saved: true }));
  });

  it("returns an undeclared script's output as a read when no effect was given", () => {
    expect(settle(undefined, returned({ effect: "possible", commits: [] }))).toEqual(
      Either.right({ saved: true }),
    );
  });

  // A served integration passes its tool's effect, and `opengpt-browser-engine run` passes none (above).
  it("fails a write tool whose script declares no write and never calls verified()", () => {
    expect(failureOf("write", returned({ effect: "possible", commits: [] })).outcome).toEqual({
      code: "outcome_unknown",
      details: {},
      writeStatus: "may_have_applied",
      possibleCommit: true,
      retry: "never",
    });
  });

  it("fails a write that returned without its confirmation, keeping its output", () => {
    const failure = failureOf(
      undefined,
      returned(commitSent, { confirmation: "message", commits: ["save"] }),
    );
    expect(failure).toBeInstanceOf(RunOutcomeFailure);
    expect(failure.outcome).toMatchObject({
      code: "outcome_unknown",
      writeStatus: "may_have_applied",
      possibleCommit: true,
      retry: "never",
    });
    expect(failure.unconfirmed).toEqual({ output: { saved: true } });
    expect(failure.message).toMatch(/without recording its confirmation/u);
    expect(failure.message).toMatch(readBack);
  });

  it("fails a write whose bare verified() is not the confirmation it declared", () => {
    const failure = failureOf(
      "write",
      returned({ effect: "verified", commits: [{ name: "save", state: "sent" }] }, {
        confirmation: "readback",
      }),
    );
    expect(failure.outcome).toMatchObject({ code: "outcome_unknown", writeStatus: "may_have_applied" });
  });

  it("keeps an unconfirmed write's journal for a keyed job's record", () => {
    const failure = failureOf(
      "write",
      returned(commitSent, { confirmation: "message", commits: ["save"] }),
    );
    expect(failure.journal).toEqual(commitSent);
  });

  it("fails an unverifiable write as possibly completed", () => {
    const failure = failureOf("write", returned(commitSent, { confirmation: "unverifiable" }));
    expect(failure.outcome).toMatchObject({
      code: "outcome_unknown",
      writeStatus: "may_have_applied",
      possibleCommit: true,
    });
    expect(failure.message).toMatch(/offers no confirmation/u);
    expect(failure.message).toMatch(readBack);
  });
});

// A write's output that failed its schema was produced after the write, so the run returns it
// as drift: as its result once the write is confirmed, else as an unconfirmed write's output. A
// read's is no result.
describe("a write whose output failed its schema", () => {
  const drifted = (journal: LocalOperationJournal, write?: WriteDeclaration) => ({
    ...returned(journal, write),
    output: { saved: "yes" },
    outputDrift: true as const,
  });
  const declaration = { confirmation: "message", commits: ["save"] } as const;

  it("returns a confirmed write's drifted output as its result", () => {
    expect(settle("write", drifted(confirmedWrite, declaration))).toEqual(
      Either.right({ saved: "yes" }),
    );
  });

  it("returns the drifted output of a write that sent nothing", () => {
    expect(settle("write", drifted(nothingSent, declaration))).toEqual(
      Either.right({ saved: "yes" }),
    );
  });

  it("keeps an unconfirmed write's drifted output, possibly applied", () => {
    const failure = failureOf("write", drifted(commitSent, declaration));
    expect(failure.outcome).toMatchObject({
      code: "outcome_unknown",
      writeStatus: "may_have_applied",
      possibleCommit: true,
    });
    expect(failure.unconfirmed).toEqual({ output: { saved: "yes" } });
    expect(failure.message).toMatch(readBack);
  });

  it("fails a write whose declared commits all stayed unsent as invalid, not applied", () => {
    const failure = failureOf("write", drifted(commitNotEntered, declaration));
    expect(failure.outcome).toMatchObject({
      code: "invalid_output",
      writeStatus: "not_applied",
      possibleCommit: false,
    });
    expect(failure.unconfirmed).toBeUndefined();
    expect(failure.message).not.toMatch(readBack);
  });

  // This host keeps no log of what the page sent after a pop-up's question went unanswered.
  it("keeps the drifted output of a write after an unanswered pop-up, possibly applied", () => {
    const settled = Effect.runSync(
      Effect.either(returnedRun("write", drifted(commitNotEntered, declaration), true)),
    );
    if (Either.isRight(settled)) throw new Error("Expected a failed run");
    expect(settled.left.outcome).toMatchObject({
      code: "outcome_unknown",
      writeStatus: "may_have_applied",
      possibleCommit: true,
    });
    expect(settled.left.unconfirmed).toEqual({ output: { saved: "yes" } });
  });

  // Any other run's drifted output is no result: it fails as its invalid output always did.
  it.each([
    {
      case: "a read",
      declared: "read" as const,
      outcome: { code: "invalid_output", writeStatus: null, possibleCommit: false },
    },
    // No effect named and no write declared: the run may have changed anything.
    {
      case: "an undeclared script",
      declared: undefined,
      outcome: { code: "outcome_unknown", writeStatus: null, possibleCommit: true },
    },
  ])("fails $case's drifted output as before", ({ declared, outcome }) => {
    const failure = failureOf(declared, drifted({ effect: "possible", commits: [] }));
    expect(failure.outcome).toMatchObject(outcome);
    expect(failure.unconfirmed).toBeUndefined();
    expect(failure).toEqual(
      runOutcomeFailure(declared, "operation")(
        new LocalOperationFailure(
          "InvalidOutput",
          { effect: "possible", commits: [] },
          "InvalidOutput",
        ),
      ),
    );
  });
});

// A pop-up's question the caller left unanswered was dismissed and the run went on. This host
// keeps no log of what the page sent, so a failure after it is no_response, as the hosted runner
// reports it, and the commit marks prove nothing.
describe("a run that failed after its caller left a pop-up's question unanswered", () => {
  const fail = (error: unknown) => runOutcomeFailure("write", "operation", true)(error);

  it.each([
    {
      case: "a script error whose commit was never entered",
      error: new LocalOperationFailure("The save button was missing", commitNotEntered),
      outcome: { code: "no_response", writeStatus: "may_have_applied", possibleCommit: true },
    },
    {
      case: "a refused input whose commit was never entered",
      error: new LocalOperationFailure("No such seat", commitNotEntered, "InvalidInput"),
      outcome: { code: "no_response", writeStatus: "may_have_applied", possibleCommit: true },
    },
    {
      case: "a failure with no journal",
      error: new Error("Local operation child did not exit after result"),
      outcome: { code: "no_response", writeStatus: "may_have_applied", possibleCommit: true },
    },
    {
      case: "a script error before it called the browser",
      error: new LocalOperationFailure("The cart was empty", nothingSent),
      outcome: { code: "no_response", writeStatus: "not_attempted", possibleCommit: false },
    },
  ])("reports $case as no_response", ({ error, outcome }) => {
    expect(fail(error).outcome).toMatchObject(outcome);
  });
});

describe("a run that failed in its operation", () => {
  const fail = (declared: "read" | "write" | undefined, error: unknown) =>
    runOutcomeFailure(declared, "operation")(error);

  it.each([
    {
      case: "a confirmed write with invalid output",
      error: new LocalOperationFailure("InvalidOutput", confirmedWrite, "InvalidOutput"),
      outcome: { code: "invalid_output", writeStatus: "applied", possibleCommit: false },
    },
    {
      case: "a refused input whose commit was never entered",
      error: new LocalOperationFailure(
        "The date must be in the future.",
        commitNotEntered,
        "InvalidInput",
      ),
      outcome: {
        code: "input_rejected",
        details: { possible_commit: false, reason: "The date must be in the future." },
        writeStatus: "not_applied",
        possibleCommit: false,
        retry: "fix_input",
      },
    },
    {
      case: "a refused input after its commit was sent",
      error: new LocalOperationFailure("InvalidInput", commitSent, "InvalidInput"),
      outcome: {
        code: "input_rejected",
        details: { possible_commit: true },
        writeStatus: "may_have_applied",
        possibleCommit: true,
      },
    },
    {
      case: "a script error before anything was dispatched",
      error: new LocalOperationFailure("Fixture failure", nothingSent),
      outcome: { code: "execution_failed", writeStatus: "not_attempted", possibleCommit: false },
    },
    // The commit marks decide, whatever failed the write: one whose child reported every
    // declared commit step unsent changed nothing.
    {
      case: "a script error after a browser step, whose commit was never entered",
      error: new LocalOperationFailure("Fixture failure", commitNotEntered),
      outcome: { code: "execution_failed", writeStatus: "not_applied", possibleCommit: false },
    },
    {
      case: "invalid output after a browser step, whose commit was never entered",
      error: new LocalOperationFailure("InvalidOutput", commitNotEntered, "InvalidOutput"),
      outcome: { code: "invalid_output", writeStatus: "not_applied", possibleCommit: false },
    },
    // Only the child's own final report proves its marks unsent. The host's deadline, a child
    // that exited or a result with host requests pending leaves the last streamed journal, which
    // may miss a mark entered just before.
    {
      case: "an expired deadline after a browser step, whose commit was never entered",
      error: new LocalOperationFailure(
        "Local operation deadline expired; execution was not replayed",
        commitNotEntered,
        undefined,
        undefined,
        undefined,
        { reported: false },
      ),
      outcome: { code: "outcome_unknown", writeStatus: "may_have_applied", possibleCommit: true },
    },
    {
      case: "a child that exited before reporting, whose commit was never entered",
      error: new LocalOperationFailure(
        "Local operation child exited 1; completion uncertain",
        commitNotEntered,
        undefined,
        undefined,
        undefined,
        { reported: false },
      ),
      outcome: { code: "outcome_unknown", writeStatus: "may_have_applied", possibleCommit: true },
    },
    // A question left unanswered says nothing about what the page sent before it, and this host
    // has no request log to tell, so the write stays possibly applied.
    {
      case: "an unanswered question after a browser step, whose commit was never entered",
      error: new LocalOperationFailure("NoResponse", commitNotEntered, "NoResponse"),
      outcome: {
        code: "no_response",
        details: { possible_commit: true },
        writeStatus: "may_have_applied",
        possibleCommit: true,
      },
    },
    // A refusal makes unentered marks prove nothing applied only while the write may have
    // dispatched. A recorded confirmation keeps the write applied, as the other host's job view
    // does, so the caller reads the site back before any retry.
    {
      case: "a refused input after a recorded confirmation, whose commit was never entered",
      error: new LocalOperationFailure(
        "The date must be in the future.",
        confirmedUnentered,
        "InvalidInput",
      ),
      outcome: { code: "input_rejected", writeStatus: "applied", possibleCommit: true },
    },
    {
      case: "a rejected login after a recorded confirmation, whose commit was never entered",
      error: new LocalOperationFailure("password", confirmedUnentered, "CredentialsRejected"),
      outcome: { code: "credentials_rejected", writeStatus: "applied", possibleCommit: true },
    },
    {
      case: "a sign-in failure raised during the operation",
      error: new SignInRunFailed({ code: "CredentialsRejected", reason: "password" }),
      outcome: { code: "outcome_unknown", writeStatus: "may_have_applied", possibleCommit: true },
    },
    {
      case: "an unanswered question before anything was dispatched",
      error: new LocalOperationFailure("NoResponse", nothingSent, "NoResponse"),
      outcome: {
        code: "no_response",
        details: { possible_commit: false },
        writeStatus: "not_attempted",
        retry: "new_key",
      },
    },
    {
      case: "an unanswered question after a commit was sent",
      error: new LocalOperationFailure("NoResponse", commitSent, "NoResponse"),
      outcome: {
        code: "no_response",
        details: { possible_commit: true },
        writeStatus: "may_have_applied",
        possibleCommit: true,
      },
    },
    {
      case: "an expired deadline after a commit was sent",
      error: new LocalOperationFailure(
        "Local operation deadline expired; execution was not replayed",
        commitSent,
      ),
      outcome: { code: "outcome_unknown", writeStatus: "may_have_applied", possibleCommit: true },
    },
    {
      case: "a failure with no journal",
      error: new Error("Local operation child did not exit after result"),
      outcome: { code: "outcome_unknown", writeStatus: "may_have_applied", possibleCommit: true },
    },
  ])("classifies $case", ({ error, outcome }) => {
    const failure = fail("write", error);
    expect(failure.outcome).toMatchObject(outcome);
    if (failure.outcome.possibleCommit) expect(failure.message).toMatch(readBack);
    else expect(failure.message).not.toMatch(readBack);
  });

  it("names the tool's own reason for a refused input", () => {
    expect(
      fail("write", new LocalOperationFailure("The date must be in the future.", commitNotEntered, "InvalidInput"))
        .message,
    ).toBe(
      "The tool or the website refused a value in the input. The date must be in the future. Nothing changed on the website. Correct the input and run it again.",
    );
  });

  it("gives a failed read no possible website change", () => {
    const failure = fail("read", new LocalOperationFailure("Fixture failure", commitSent));
    expect(failure.outcome).toMatchObject({
      code: "execution_failed",
      writeStatus: null,
      possibleCommit: false,
    });
  });

  it.each([
    { declared: undefined, outcome: { code: "outcome_unknown", writeStatus: null, possibleCommit: true } },
    {
      declared: "read",
      outcome: { code: "execution_failed", writeStatus: null, possibleCommit: false },
    },
  ] as const)(
    "fails a $declared tool's sign-in failure during the operation closed",
    ({ declared, outcome }) => {
      expect(
        fail(declared, new SignInRunFailed({ code: "RecipeFailed", reason: "submit_refused" }))
          .outcome,
      ).toMatchObject(outcome);
    },
  );

  it("keeps the operation's journal for a keyed job's record", () => {
    expect(fail("write", new LocalOperationFailure("Fixture failure", commitSent)).journal).toEqual(
      commitSent,
    );
    expect(fail("write", new Error("Fixture failure")).journal).toBeUndefined();
  });

  it("fails closed when the tool's effect is unknown", () => {
    expect(
      fail(undefined, new LocalOperationFailure("Fixture failure", { effect: "possible", commits: [] }))
        .outcome,
    ).toMatchObject({ code: "outcome_unknown", writeStatus: null, possibleCommit: true });
  });

  it("counts declared commit marks as a write when the tool's effect is unknown", () => {
    expect(fail(undefined, new LocalOperationFailure("Fixture failure", commitSent)).outcome)
      .toMatchObject({ code: "outcome_unknown", writeStatus: "may_have_applied" });
  });
});

// The host refused a sign-in the script waited for in `ensureSignedIn`: its sign-ins were spent,
// or the sign-in failed. Either way the operation reports the session not kept.
describe("a run that can't sign in again", () => {
  const fail = (declared: "read" | "write" | undefined, journal: LocalOperationJournal) =>
    runOutcomeFailure(declared, "operation")(
      new LocalOperationFailure(
        "The host could not keep the site signed in",
        journal,
        "OperationFailure",
        "OperationFailure",
        undefined,
        { sessionLoss: "session_not_kept" },
      ),
    );
  /** A run's journal once a browser step ran, with no commit marks declared. */
  const stepRan: LocalOperationJournal = { effect: "possible", commits: [] };
  const signInUnavailable = {
    code: "website_sign_in_unavailable",
    details: {},
    possibleCommit: false,
    retry: "same_key",
  };

  it("reports a read as the sign-in unavailable, to retry with the same request", () => {
    const failure = fail("read", stepRan);
    expect(failure.outcome).toEqual({ ...signInUnavailable, writeStatus: null });
    expect(failure.message).toBe(
      "The website did not keep the run signed in, and signing in again was unavailable, so the run stopped. Nothing changed on the website. Run it again in a few minutes.",
    );
    expect(failure.journal).toEqual(stepRan);
  });

  // A write counts as unapplied only when its journal shows no commit step entered, as for a
  // refused input or login. Any other write may have applied, so a retry could repeat it, and a
  // commit step the journal shows entered keeps a run labelled a read from that retry too.
  it.each([
    {
      case: "a run labelled a read whose journal shows a commit step entered",
      declared: "read",
      journal: commitSent,
      outcome: { code: "execution_failed", writeStatus: null, possibleCommit: false, retry: "never" },
    },
    // A mark name no authored mark could have is no report, so it proves nothing about commits.
    {
      case: "a run labelled a read whose journal reports its commit marks unreadably",
      declared: "read",
      journal: { effect: "possible", commits: [{ name: "Place Order", state: "sent" }] },
      outcome: { code: "execution_failed", writeStatus: null, possibleCommit: false, retry: "never" },
    },
    {
      case: "a write that entered none of its declared commit steps",
      declared: "write",
      journal: commitNotEntered,
      outcome: { ...signInUnavailable, writeStatus: "not_applied" },
    },
    {
      case: "a write that sent nothing",
      declared: "write",
      journal: nothingSent,
      outcome: { ...signInUnavailable, writeStatus: "not_attempted" },
    },
    {
      case: "an undeclared tool's run that declared commit steps and entered none",
      declared: undefined,
      journal: commitNotEntered,
      outcome: { ...signInUnavailable, writeStatus: "not_applied" },
    },
    {
      case: "an undeclared tool's run that sent nothing",
      declared: undefined,
      journal: nothingSent,
      outcome: { ...signInUnavailable, writeStatus: null },
    },
    {
      case: "a write that entered a commit step",
      declared: "write",
      journal: commitSent,
      outcome: {
        code: "outcome_unknown",
        writeStatus: "may_have_applied",
        possibleCommit: true,
        retry: "never",
      },
    },
    {
      case: "a write that declared no commit steps after a browser step ran",
      declared: "write",
      journal: stepRan,
      outcome: {
        code: "outcome_unknown",
        writeStatus: "may_have_applied",
        possibleCommit: true,
        retry: "never",
      },
    },
    {
      case: "an undeclared tool's run without commit steps after a browser step ran",
      declared: undefined,
      journal: stepRan,
      outcome: { code: "outcome_unknown", writeStatus: null, possibleCommit: true, retry: "never" },
    },
    {
      case: "a write that recorded its confirmation",
      declared: "write",
      journal: confirmedUnentered,
      outcome: {
        code: "execution_failed",
        writeStatus: "applied",
        possibleCommit: false,
        retry: "never",
      },
    },
  ] as const)("reports $case", ({ declared, journal, outcome }) => {
    const failure = fail(declared, journal);
    expect(failure.outcome).toMatchObject(outcome);
    if (failure.outcome.possibleCommit) expect(failure.message).toMatch(readBack);
    else expect(failure.message).not.toMatch(readBack);
  });
});

describe("a run that failed before its operation", () => {
  const fail = beforeOperationFailure("write");

  it("keeps a sign-in failure as the typed failure a caller catches", () => {
    const signIn = new SignInRunFailed({ code: "CredentialsRejected", reason: "password" });
    expect(fail(signIn)).toBe(signIn);
  });

  it.each([
    { error: new InputRequestFailure({ code: "NoResponse" }), code: "no_response" },
    { error: new InputRequestFailure({ code: "Unavailable" }), code: "execution_failed" },
    { error: new Error("Invalid URL"), code: "execution_failed" },
  ])("reports $code with nothing changed", ({ error, code }) => {
    const failure = fail(error);
    if (!(failure instanceof RunOutcomeFailure)) throw new Error("Expected a run outcome");
    expect(failure.outcome).toMatchObject({
      code,
      writeStatus: "not_attempted",
      possibleCommit: false,
    });
    expect(failure.message).toMatch(/Nothing changed on the website/u);
    expect(failure.message).not.toMatch(readBack);
  });

  it("passes an outcome already classified through unchanged", () => {
    const classified = runOutcomeFailure("write", "operation")(
      new LocalOperationFailure("Fixture failure", commitSent),
    );
    expect(fail(classified)).toBe(classified);
  });
});
