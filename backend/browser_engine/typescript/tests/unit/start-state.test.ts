import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type {
  AutofillFieldStatus,
  AutofillSlot,
  AutofillStepReport,
  AutofillStepRequest,
  IdentifierKind,
} from "../../src/destinations/autofill-step.js";
import type { HostExecute } from "../../src/runtime/host-execute.js";
import {
  isFirstWriteStep,
  localStartHooks,
  makeStartTracker,
  startPage,
  startStateFor,
  stopLoadingCode,
  type StepPurpose,
} from "../../src/runtime/start-state.js";
import { makeBuildStart } from "../../src/standalone/mint-state.js";

const purposes: readonly StepPurpose[] = [
  "explore",
  "authenticate",
  "test",
  "example",
  "act",
  "inspect",
  "residual",
];

describe("startStateFor", () => {
  const fresh = { writeSessionStarted: false, signInStarted: false, signInVerified: false };
  const resetting = (purpose: StepPurpose) =>
    purpose === "example" || purpose === "test" || purpose === "act";
  it.each(purposes)("keeps the site data of a live %s before any sign-in started", (purpose) => {
    expect(startStateFor({ purpose, live: true, ...fresh })).toBe(
      resetting(purpose) ? "keep" : "none",
    );
  });
  it.each(purposes)("clears a live %s's site data while a sign-in is unverified", (purpose) => {
    expect(
      startStateFor({ purpose, live: true, ...fresh, signInStarted: true }),
    ).toBe(resetting(purpose) ? "clear" : "none");
  });
  it.each(purposes)("keeps a live %s's site data once a sign-in was verified", (purpose) => {
    expect(
      startStateFor({ purpose, live: true, ...fresh, signInStarted: true, signInVerified: true }),
    ).toBe(resetting(purpose) ? "keep" : "none");
  });
  it.each(purposes)("never resets a %s that does not run on the live browser", (purpose) => {
    for (const signInStarted of [false, true])
      for (const signInVerified of [false, true])
        expect(
          startStateFor({
            purpose,
            live: false,
            writeSessionStarted: false,
            signInStarted,
            signInVerified,
          }),
        ).toBe("none");
  });
  it("continues the page for a write session's later steps", () => {
    for (const signInStarted of [false, true])
      expect(
        startStateFor({
          purpose: "act",
          live: true,
          writeSessionStarted: true,
          signInStarted,
          signInVerified: false,
        }),
      ).toBe("none");
  });
  it("still resets examples and tests once a write session started", () => {
    const step = { live: true, ...fresh, writeSessionStarted: true };
    expect(startStateFor({ ...step, purpose: "example" })).toBe("keep");
    expect(startStateFor({ ...step, purpose: "test" })).toBe("keep");
  });
});

describe("isFirstWriteStep", () => {
  it("is the first act before a write session, and nothing else", () => {
    expect(isFirstWriteStep("act", false)).toBe(true);
    expect(isFirstWriteStep("act", true)).toBe(false);
    for (const purpose of purposes.filter((candidate) => candidate !== "act"))
      expect(isFirstWriteStep(purpose, false)).toBe(false);
  });
});

describe("makeStartTracker", () => {
  const live = (purpose: StepPurpose) => ({ purpose, live: true });
  /** A sign-in whose steps sent the login's identifier and its password. */
  const signIn = (
    tracker: Pick<ReturnType<typeof makeStartTracker>, "signIn" | "sent" | "verified">,
  ) => {
    tracker.signIn();
    tracker.sent("identifier");
    tracker.sent("proof");
    return tracker.verified();
  };
  it("keeps site data before a sign-in, clears it while one is open and keeps it once verified", () => {
    const tracker = makeStartTracker();
    expect(tracker.plan(live("explore"))).toBe("none");
    expect(tracker.plan(live("example"))).toBe("keep");
    expect(tracker.signInStarted).toBe(false);
    tracker.signIn();
    expect(tracker.signInStarted).toBe(true);
    expect(tracker.plan(live("example"))).toBe("clear");
    tracker.sent("identifier");
    tracker.sent("proof");
    expect(tracker.verified()).toBe(true);
    expect(tracker.signedIn).toBe(true);
    expect(tracker.plan(live("example"))).toBe("keep");
    expect(tracker.plan(live("test"))).toBe("keep");
  });
  it("counts a sign-in only once it sent an identifier and a password, code or approval", () => {
    const tracker = makeStartTracker();
    // A page that shows the account proves nothing before a sign-in step sent the login.
    expect(tracker.verified()).toBe(false);
    expect(tracker.plan(live("example"))).toBe("keep");
    tracker.signIn();
    tracker.sent("identifier");
    expect(tracker.submitted).toBe(false);
    expect(tracker.verified()).toBe(false);
    expect(tracker.plan(live("example"))).toBe("clear");
    tracker.signIn();
    tracker.sent("proof");
    expect(tracker.submitted).toBe(true);
    expect(tracker.verified()).toBe(true);
    expect(tracker.plan(live("example"))).toBe("keep");
  });
  it("keeps the session of a verified sign-in through a check again, which must send the login anew", () => {
    const tracker = makeStartTracker();
    signIn(tracker);
    // A confirmed sign-in is over: what it sent counts for no later check.
    expect(tracker.submitted).toBe(false);
    expect(tracker.verified()).toBe(false);
    // A check is a sign-in step too: it starts a new sign-in, unsettled until it verifies.
    tracker.signIn();
    expect(tracker.signedIn).toBe(false);
    expect(tracker.verified()).toBe(false);
    expect(tracker.plan(live("example"))).toBe("keep");
    tracker.sent("identifier");
    tracker.sent("proof");
    expect(tracker.verified()).toBe(true);
    expect(tracker.signedIn).toBe(true);
  });
  it("adds each screen of an open sign-in to what it sent", () => {
    const tracker = makeStartTracker();
    tracker.signIn();
    tracker.sent("identifier");
    tracker.signIn();
    tracker.sent("proof");
    expect(tracker.verified()).toBe(true);
  });
  it("forgets every sign-in when the host replaces the browser", () => {
    const open = makeStartTracker();
    open.signIn();
    open.sent("identifier");
    expect(open.plan(live("example"))).toBe("clear");
    open.browserReplaced();
    expect(open.signInStarted).toBe(false);
    expect(open.plan(live("example"))).toBe("keep");
    // What the old browser's sign-in sent counts for nothing on the new one.
    open.signIn();
    open.sent("proof");
    expect(open.submitted).toBe(false);
    expect(open.verified()).toBe(false);
    const verified = makeStartTracker();
    signIn(verified);
    verified.browserReplaced();
    expect(verified.signedIn).toBe(false);
    expect(verified.plan(live("example"))).toBe("keep");
    // A sign-in on the new browser is unverified again until its own check.
    verified.signIn();
    expect(verified.plan(live("example"))).toBe("clear");
  });
  it("clears until this build verifies a sign-in when one started on the browser before it", () => {
    let before = false;
    const tracker = makeStartTracker({ signInStartedBefore: () => before });
    expect(tracker.plan(live("example"))).toBe("keep");
    before = true;
    expect(tracker.signInStarted).toBe(true);
    expect(tracker.plan(live("example"))).toBe("clear");
    signIn(tracker);
    expect(tracker.plan(live("example"))).toBe("keep");
  });
  it("starts the write session once its first act is dispatched, not when it is planned", () => {
    const tracker = makeStartTracker();
    expect(tracker.plan(live("act"))).toBe("keep");
    // A plan whose reset failed leaves the next act to reset again.
    expect(tracker.plan(live("act"))).toBe("keep");
    tracker.dispatched(live("act"));
    expect(tracker.plan(live("act"))).toBe("none");
    // Replacing the browser leaves the write session as it was.
    tracker.browserReplaced();
    expect(tracker.plan(live("act"))).toBe("none");
  });
});

// The build's wiring on a modeled browser that names each call it receives.
const modeledBuild = (
  options: {
    readonly resetFailures?: number;
    readonly rootLoads?: boolean;
    /** Records the host keeping the page a reset left signed out, as the local mint state does. */
    readonly keepsSignedOutPage?: boolean;
    /**
     * Records the host's re-sign-in check after a reset that kept a verified sign-in's session;
     * `reopen` has it reset the page the same way once more, as after a sign-in.
     */
    readonly checksAfterReset?: "check" | "reopen";
    /** Whether a sign-in started on the browser before this build. */
    readonly signInStartedBefore?: () => boolean;
  } = {},
) => {
  const targetId = "primary-target";
  const calls: string[] = [];
  /** How many calls the build had made each time it left the page. */
  const left: number[] = [];
  let resetFailures = options.resetFailures ?? 0;
  const execute: HostExecute = (code) =>
    Effect.suspend((): Effect.Effect<unknown, Error> => {
      if (code === stopLoadingCode(targetId)) {
        calls.push("stop");
        return Effect.void;
      }
      if (code.includes("Storage.clearDataForOrigin")) {
        const siteData = /const siteData = "(\w+)"/u.exec(code)?.[1] ?? "?";
        if (resetFailures > 0) {
          resetFailures--;
          calls.push(`reset:${siteData} failed`);
          return Effect.fail(new Error("Reset failed"));
        }
        calls.push(`reset:${siteData}`);
        return Effect.void;
      }
      calls.push("root");
      return Effect.succeed(options.rootLoads ?? true);
    });
  const start = makeBuildStart(
    { execute, targetId },
    "https://site.test",
    Effect.sync(() => {
      calls.push("entry");
    }),
    () => {
      left.push(calls.length);
    },
    options.keepsSignedOutPage === true
      ? Effect.sync(() => {
          calls.push("keep signed-out page");
        })
      : undefined,
    options.checksAfterReset === undefined
      ? undefined
      : (reopen) =>
          Effect.sync(() => {
            calls.push("signed-in check");
          }).pipe(Effect.zipRight(options.checksAfterReset === "reopen" ? reopen : Effect.void)),
    options.signInStartedBefore,
  );
  const step = (purpose: StepPurpose, target: "liveBrowser" | "pureFiles" = "liveBrowser") =>
    Effect.runPromise(
      Effect.either(
        start.before({ purpose, target }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              calls.push("run");
            }),
          ),
        ),
      ),
    );
  /** A sign-in step that sent the login, and the host's check that verifies it. */
  const signIn = async () => {
    const outcome = await step("authenticate");
    start.sent(
      filled([
        ["username", "filled"],
        ["password", "filled"],
      ]),
      asked("username", "password"),
    );
    expect(start.verified()).toBe(true);
    return outcome;
  };
  return { start, step, signIn, calls, left };
};
/** A sign-in step's requested fields, one per slot. */
const asked = (...slots: readonly AutofillSlot[]): AutofillStepRequest["fields"] =>
  slots.map((slot) =>
    slot === "password" || slot === "code" || slot === "date_of_birth"
      ? { selector: `#${slot}`, slot }
      : { selector: `#${slot}`, accepts: [slot as IdentifierKind] },
  );
/** What a host fill reports: each field's slot and status, and its submit. */
const filled = (
  fields: readonly (readonly [AutofillSlot, AutofillFieldStatus])[],
  submit: "clicked" | "failed" | "not_attempted" | "refused" | "stayed_disabled" | "none" = "clicked",
): AutofillStepReport => ({
  outcome: "filled",
  fields: fields.map(([slot, status]) => ({ slot, status })),
  submit,
  url: "https://site.test/account",
});

describe("makeBuildStart", () => {
  it("resets before a live example but not an exploration, keeping the site data", async () => {
    const build = modeledBuild();
    await build.step("explore");
    await build.step("example");
    await build.step("explore");
    // The exploration runs on its retained page; the example resets first. A later exploration
    // continues the example's page rather than loading the request's URL again.
    expect(build.calls).toEqual(["entry", "run", "reset:keep", "root", "run", "run"]);
  });

  it("keeps the signed-out page of each reset before a sign-in and of a clearing one, never a signed-in one", async () => {
    const build = modeledBuild({ keepsSignedOutPage: true });
    await build.step("explore");
    await build.step("test");
    // A sign-in step that sent nothing yet: the next reset clears what it may have left.
    await build.step("authenticate");
    await build.step("example");
    build.start.sent(
      filled([
        ["username", "filled"],
        ["password", "filled"],
      ]),
      asked("username", "password"),
    );
    expect(build.start.verified()).toBe(true);
    await build.step("example");
    expect(build.calls).toEqual([
      "entry",
      "run",
      "reset:keep",
      "root",
      "keep signed-out page",
      "run",
      "run",
      "reset:clear",
      "root",
      "keep signed-out page",
      "run",
      "reset:keep",
      "root",
      "run",
    ]);
  });

  it("keeps no signed-out page when the reset fails", async () => {
    const build = modeledBuild({ keepsSignedOutPage: true, resetFailures: 1 });
    await build.step("explore");
    await build.step("example");
    expect(build.calls).toEqual(["entry", "run", "reset:keep failed"]);
  });

  it("clears until its own sign-in verifies on a browser where an earlier build signed in", async () => {
    const build = modeledBuild({ keepsSignedOutPage: true, signInStartedBefore: () => true });
    await build.step("example");
    await build.signIn();
    await build.step("example");
    expect(build.calls).toEqual([
      "reset:clear",
      "root",
      "keep signed-out page",
      "run",
      "run",
      "reset:keep",
      "root",
      "run",
    ]);
  });

  it("checks the session after each reset that kept a verified sign-in's, never before one or while a later sign-in is open", async () => {
    const build = modeledBuild({ checksAfterReset: "check" });
    await build.step("example");
    await build.signIn();
    await build.step("example");
    await build.step("test");
    // A sign-in step opens a new sign-in, unsettled until it verifies: the reset keeps the
    // browser's session, which the host does not check.
    await build.step("authenticate");
    await build.step("example");
    expect(build.calls).toEqual([
      "reset:keep",
      "root",
      "run",
      "run",
      "reset:keep",
      "root",
      "signed-in check",
      "run",
      "reset:keep",
      "root",
      "signed-in check",
      "run",
      "run",
      "reset:keep",
      "root",
      "run",
    ]);
  });

  it("lets the check reset the page the same way again", async () => {
    const build = modeledBuild({ checksAfterReset: "reopen" });
    await build.signIn();
    await build.step("test");
    expect(build.calls).toEqual([
      "entry",
      "run",
      "reset:keep",
      "root",
      "signed-in check",
      "reset:keep",
      "root",
      "run",
    ]);
  });

  it("stops a live example whose reset fails before its source runs", async () => {
    const build = modeledBuild({ resetFailures: 1 });
    const outcome = await build.step("example");
    expect(outcome).toMatchObject({ _tag: "Left", left: { code: "Unavailable" } });
    expect(build.calls).toEqual(["reset:keep failed"]);
  });

  it("leaves the last page before each reset, one that fails included", async () => {
    const build = modeledBuild({ resetFailures: 1 });
    await build.step("explore");
    await build.step("example");
    await build.step("example");
    await build.step("explore");
    expect(build.calls).toEqual([
      "entry",
      "run",
      "reset:keep failed",
      "reset:keep",
      "root",
      "run",
      "run",
    ]);
    // Before each reset, never before an exploration that keeps its page.
    expect(build.left).toEqual([2, 3]);
  });

  it("stops a root that fails to load and still runs the step", async () => {
    const build = modeledBuild({ rootLoads: false });
    expect((await build.step("example"))._tag).toBe("Right");
    expect(build.calls).toEqual(["reset:keep", "root", "stop", "run"]);
  });

  it("leaves an example's site data kept when a page showed the account before any sign-in", async () => {
    const build = modeledBuild();
    await build.step("explore");
    expect(build.start.submitted).toBe(false);
    expect(build.start.verified()).toBe(false);
    await build.step("example");
    expect(build.calls).toEqual(["entry", "run", "reset:keep", "root", "run"]);
  });

  it("counts what a fill typed, whatever became of a submit it could click, and an uncertain step's fields", async () => {
    const login = asked("username", "password");
    const uncertain = {
      outcome: "uncertain",
      reason: "fill_call_failed",
    } as unknown as AutofillStepReport;
    const counted: readonly (readonly [AutofillStepReport, AutofillStepRequest["fields"]])[] = [
      // The page may send what was typed itself, as a form that submits on its own does.
      ...(["clicked", "refused", "failed", "not_attempted", "none"] as const).map(
        (submit) =>
          [
            filled(
              [
                ["username", "filled"],
                ["password", "filled"],
              ],
              submit,
            ),
            login,
          ] as const,
      ),
      // A lost answer may have typed every field the step asked for.
      [uncertain, login],
    ];
    for (const [report, fields] of counted) {
      const build = modeledBuild();
      await build.step("authenticate");
      build.start.sent(report, fields);
      expect(build.start.submitted).toBe(true);
    }
    const uncounted: readonly (readonly [AutofillStepReport, AutofillStepRequest["fields"]])[] = [
      [
        filled([
          ["username", "filled"],
          ["password", "failed"],
        ]),
        login,
      ],
      // A submit the page kept disabled was never clicked, so nothing went out.
      [
        filled(
          [
            ["username", "filled"],
            ["password", "filled"],
          ],
          "stayed_disabled",
        ),
        login,
      ],
      [
        filled([
          ["username", "filled"],
          ["date_of_birth", "filled"],
        ]),
        asked("username", "date_of_birth"),
      ],
      [uncertain, asked("username")],
      [{ outcome: "refused", reason: "not_found" } as unknown as AutofillStepReport, login],
    ];
    for (const [report, fields] of uncounted) {
      const build = modeledBuild();
      await build.step("authenticate");
      build.start.sent(report, fields);
      expect(build.start.submitted).toBe(false);
    }
    // Screen by screen; or an approval after the login.
    const build = modeledBuild();
    await build.step("authenticate");
    build.start.sent(filled([["phone", "filled"]], "none"), asked("phone"));
    await build.step("authenticate");
    build.start.sent(filled([["code", "filled"]]), asked("code"));
    expect(build.start.submitted).toBe(true);
    const approval = modeledBuild();
    await approval.step("authenticate");
    approval.start.sent(filled([["account_number", "filled"]]), asked("account_number"));
    approval.start.approved();
    expect(approval.start.submitted).toBe(true);
    // Or a code the site sent, which the agent's explore typed into the code screen.
    const typed = modeledBuild();
    await typed.step("authenticate");
    typed.start.sent(filled([["username", "filled"]]), asked("username"));
    expect(typed.start.submitted).toBe(false);
    typed.start.typedCode();
    expect(typed.start.submitted).toBe(true);
  });

  it("resets a write session's first step only", async () => {
    const build = modeledBuild();
    await build.step("act");
    await build.step("act");
    expect(build.calls).toEqual(["reset:keep", "root", "run", "run"]);
  });

  it("resets a write session's first step again when the reset before it failed", async () => {
    const build = modeledBuild({ resetFailures: 1 });
    const outcomes = [];
    for (const purpose of ["act", "act", "act"] as const) outcomes.push(await build.step(purpose));
    expect(outcomes.map((outcome) => outcome._tag)).toEqual(["Left", "Right", "Right"]);
    expect(build.calls).toEqual(["reset:keep failed", "reset:keep", "root", "run", "run"]);
  });

  it("leaves the browser alone for a step that does not run on it", async () => {
    const build = modeledBuild();
    await build.step("example", "pureFiles");
    expect(build.calls).toEqual(["run"]);
  });
});

describe("startPage", () => {
  it("refuses to restore a session that was never saved, before any browser call", async () => {
    const calls: string[] = [];
    const execute: HostExecute = (code) =>
      Effect.sync(() => {
        calls.push(code);
        return true;
      });
    const outcome = await Effect.runPromise(
      Effect.either(
        startPage(
          execute,
          "primary-target",
          "https://site.test",
          { siteData: "restore", session: undefined },
          localStartHooks(execute, "primary-target"),
        ),
      ),
    );
    expect(outcome).toMatchObject({
      _tag: "Left",
      left: { message: "No saved session to restore" },
    });
    expect(calls).toEqual([]);
  });
});
