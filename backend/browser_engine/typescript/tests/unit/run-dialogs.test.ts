import { Effect } from "effect";
import { expect, it } from "vitest";
import type { DialogChoice, DialogType } from "../../src/browser/dialogs/contracts.js";
import {
  expectedConfirmDigest,
  makeRunDialogDecision,
  type DialogEvent,
  type ObservedConfirm,
} from "../../src/browser/dialogs/expected.js";
import { noIncidents, type DialogIncident } from "../../src/runtime/incidents.js";

const event = (type: DialogType, candidateActionId: string | null = "action_1"): DialogEvent => ({
  type,
  candidateActionId,
});
const facts = { message: "Controlled dialog", pageUrl: "https://controlled.test/page" };
const recorded = expectedConfirmDigest({
  message: "Controlled dialog",
  origin: "https://controlled.test",
  step: "action_1",
});

const decision = (options: {
  readonly readOnly: boolean;
  readonly expected?: boolean;
  readonly ask?: boolean;
  readonly askEveryDialog?: boolean;
}) => {
  const incidents: DialogIncident[] = [];
  const asked: DialogType[] = [];
  const decide = makeRunDialogDecision({
    readOnly: options.readOnly,
    ...(options.expected === true ? { expectedConfirms: [recorded] } : {}),
    ...(options.ask === false
      ? {}
      : {
          askCaller: (shown: DialogEvent) =>
            Effect.sync((): DialogChoice => {
              asked.push(shown.type);
              return { choice: "accept" };
            }),
        }),
    incidents: {
      record: (incident) =>
        Effect.sync(() => {
          incidents.push(incident);
        }),
    },
    ...(options.askEveryDialog === true ? { askEveryDialog: true } : {}),
  });
  return { decide, incidents, asked };
};
const types = ["alert", "confirm", "prompt", "beforeunload"] as const;

it("decides a read-only tool's dialogs itself: nothing is confirmed, navigation may leave", async () => {
  const run = decision({ readOnly: true, expected: true });
  const decisions = await Effect.runPromise(
    Effect.forEach(types, (type) => run.decide(event(type), facts)),
  );
  expect(decisions).toEqual([
    { choice: "dismiss" },
    { choice: "dismiss" },
    { choice: "dismiss" },
    { choice: "accept" },
  ]);
  expect(run.asked).toEqual([]);
  expect(run.incidents).toEqual([
    {
      source: "host",
      kind: "dialog",
      reason: "dialog_default_decision",
      hostBug: false,
      severity: "info",
      subCause: "alert_dismiss",
    },
    expect.objectContaining({ reason: "dialog_default_decision", subCause: "confirm_dismiss" }),
    expect.objectContaining({ reason: "dialog_default_decision", subCause: "prompt_dismiss" }),
    expect.objectContaining({ reason: "dialog_default_decision", subCause: "beforeunload_accept" }),
  ]);
});

it("accepts a write's recorded confirm once and records it, then asks about the repeat", async () => {
  const run = decision({ readOnly: false, expected: true });
  expect(await Effect.runPromise(run.decide(event("confirm"), facts))).toEqual({
    choice: "accept",
  });
  expect(run.asked).toEqual([]);
  expect(run.incidents).toEqual([
    {
      source: "host",
      kind: "dialog",
      reason: "dialog_expected_confirm_accepted",
      hostBug: false,
      severity: "info",
      subCause: "confirm_accept",
    },
  ]);
  await Effect.runPromise(run.decide(event("confirm"), facts));
  expect(run.asked).toEqual(["confirm"]);
});

it("asks the caller about a write's other confirms and defaults the rest", async () => {
  const run = decision({ readOnly: false, expected: true });
  await Effect.runPromise(run.decide(event("confirm", "action_2"), facts));
  await Effect.runPromise(run.decide(event("confirm", null), facts));
  await Effect.runPromise(run.decide(event("alert"), facts));
  expect(run.asked).toEqual(["confirm", "confirm"]);
  expect(run.incidents.map((incident) => incident.subCause)).toEqual(["alert_dismiss"]);
});

it("defaults a write's unrecorded confirm when nobody can be asked", async () => {
  const run = decision({ readOnly: false, ask: false, askEveryDialog: true });
  expect(await Effect.runPromise(run.decide(event("confirm"), facts))).toEqual({
    choice: "dismiss",
  });
  expect(run.incidents.map((incident) => incident.subCause)).toEqual(["confirm_dismiss"]);
});

it("asks about every dialog the record does not settle when the host asks about all", async () => {
  const write = decision({ readOnly: false, expected: true, askEveryDialog: true });
  for (const type of types) await Effect.runPromise(write.decide(event(type), facts));
  // The recorded confirm is the one dialog nobody is asked about.
  expect(write.asked).toEqual(["alert", "prompt", "beforeunload"]);
  expect(write.incidents.map((incident) => incident.reason)).toEqual([
    "dialog_expected_confirm_accepted",
  ]);
  const read = decision({ readOnly: true, expected: true, askEveryDialog: true });
  for (const type of types) await Effect.runPromise(read.decide(event(type), facts));
  expect(read.asked).toEqual(types);
  expect(read.incidents).toEqual([]);
});

it("records nothing locally and decides the same as a recording store", async () => {
  for (const reason of [
    "dialog_expected_confirm_accepted",
    "dialog_default_decision",
    "dialog_decision_expired",
  ] as const)
    expect(
      await Effect.runPromise(
        noIncidents
          .record({
            source: "host",
            kind: "dialog",
            reason,
            hostBug: false,
            severity: "info",
            subCause: "confirm_dismiss",
          })
          .pipe(Effect.timeout("10 millis")),
      ),
    ).toBeUndefined();
  const recording = decision({ readOnly: false, expected: true, ask: false });
  const silent = makeRunDialogDecision({
    readOnly: false,
    expectedConfirms: [recorded],
    incidents: noIncidents,
  });
  const shown = [event("confirm"), event("alert"), event("confirm"), event("beforeunload")];
  const decided = (decide: typeof silent) =>
    Effect.runPromise(Effect.forEach(shown, (dialog) => decide(dialog, facts)));
  expect(await decided(silent)).toEqual(await decided(recording.decide));
  expect(recording.incidents).toHaveLength(4);
});

const judged = (
  verdict: (confirm: ObservedConfirm) => Effect.Effect<"accept" | "ask", unknown>,
  options: { readonly readOnly?: boolean; readonly ask?: boolean } = {},
) => {
  const incidents: DialogIncident[] = [];
  const asked: DialogType[] = [];
  const seen: ObservedConfirm[] = [];
  const decide = makeRunDialogDecision({
    readOnly: options.readOnly ?? false,
    expectedConfirms: [recorded],
    input: { documentId: "DOC-2002" },
    ...(options.ask === false
      ? {}
      : {
          askCaller: (shown: DialogEvent) =>
            Effect.sync((): DialogChoice => {
              asked.push(shown.type);
              return { choice: "dismiss" };
            }),
        }),
    judgeConfirm: (_shown: DialogEvent, confirm: ObservedConfirm) =>
      Effect.suspend(() => {
        seen.push(confirm);
        return verdict(confirm);
      }),
    incidents: {
      record: (incident) =>
        Effect.sync(() => {
          incidents.push(incident);
        }),
    },
  });
  return { decide, incidents, asked, seen };
};
const novel = { message: "Permanently submit DOC-2002?", pageUrl: "https://controlled.test/page" };

it("accepts a write's new confirm the host judges, with this run's values slotted, before asking", async () => {
  const run = judged(() => Effect.succeed("accept"));
  expect(await Effect.runPromise(run.decide(event("confirm"), novel))).toEqual({
    choice: "accept",
  });
  expect(run.asked).toEqual([]);
  expect(run.seen).toEqual([
    {
      message: "Permanently submit DOC-2002?",
      origin: "https://controlled.test",
      step: "action_1",
      template: ["Permanently submit ", ["input/documentId"], "?"],
    },
  ]);
  expect(run.incidents).toEqual([
    {
      source: "host",
      kind: "dialog",
      reason: "dialog_judged_confirm_accepted",
      hostBug: false,
      severity: "info",
      subCause: "confirm_accept",
    },
  ]);
});

it("asks the caller when the host's judgment asks, fails or dies", async () => {
  for (const verdict of [
    () => Effect.succeed("ask" as const),
    () => Effect.fail(new Error("judge unavailable")),
    () => Effect.die(new Error("judge broke")),
    () => Effect.succeed("yes" as unknown as "accept" | "ask"),
  ]) {
    const run = judged(verdict);
    expect(await Effect.runPromise(run.decide(event("confirm"), novel))).toEqual({
      choice: "dismiss",
    });
    expect(run.asked).toEqual(["confirm"]);
    expect(run.seen).toHaveLength(1);
    expect(run.incidents).toEqual([]);
  }
});

it("never judges a recorded confirm, a read's confirm, another dialog or a confirm with no known step", async () => {
  const run = judged(() => Effect.succeed("accept"));
  await Effect.runPromise(run.decide(event("confirm"), facts));
  await Effect.runPromise(run.decide(event("alert"), novel));
  expect(await Effect.runPromise(run.decide(event("confirm", null), novel))).toEqual({
    choice: "dismiss",
  });
  await Effect.runPromise(
    run.decide(event("confirm"), { ...novel, pageUrl: "http://controlled.test/page" }),
  );
  expect(run.asked).toEqual(["confirm", "confirm"]);
  const read = judged(() => Effect.succeed("accept"), { readOnly: true });
  await Effect.runPromise(read.decide(event("confirm"), novel));
  expect([...run.seen, ...read.seen]).toEqual([]);
});

it("defaults a write's new confirm the host's judgment asks about when nobody can be asked", async () => {
  const run = judged(() => Effect.succeed("ask"), { ask: false });
  expect(await Effect.runPromise(run.decide(event("confirm"), novel))).toEqual({
    choice: "dismiss",
  });
  expect(run.seen).toHaveLength(1);
  expect(run.incidents.map((incident) => incident.subCause)).toEqual(["confirm_dismiss"]);
});
