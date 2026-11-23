import { Effect, Either } from "effect";
import { expect, it } from "vitest";
import { makeInputAsker } from "../../src/inputs/callback.js";
import {
  keepingAcceptedConfirms,
  makeDialogDecider,
  makeRunDialogDecider,
  watchingUnanswered,
} from "../../src/inputs/dialog.js";
import {
  expectedConfirmDigest,
  recordConfirmSteps,
  type ObservedConfirm,
} from "../../src/browser/dialogs/expected.js";
import type { ExpectedConfirm } from "../../src/browser/dialogs/contracts.js";
import { noIncidents, type DialogIncident } from "../../src/runtime/incidents.js";
import { OwnerCancelled } from "../../src/inputs/terminal.js";
import { InputRequestFailure, type InputRequest } from "../../src/runtime/input-request.js";
import type { DialogReport } from "../../src/runtime/kernel-operation.js";

const report = (type: DialogReport["type"], message = "Place this order?") => ({
  interactionId: "interaction-1",
  step: "place-order",
  type,
  message,
  url: "https://shop.example/cart",
});

/** An asker that answers every dialog question with `choice`, and a prompt's text with `text`. */
const answering = (choice: "accept" | "dismiss", text = "typed") => {
  const asked: InputRequest[] = [];
  const ask = makeInputAsker((request) =>
    Effect.sync(() => {
      asked.push(request);
      return request.questions[0]?.id === "text" ? { text } : { choice };
    }),
  );
  return { ask, asked };
};

it("asks the caller about every dialog type and returns the caller's choice", async () => {
  for (const type of ["alert", "confirm", "prompt", "beforeunload"] as const) {
    const { ask, asked } = answering("dismiss");
    const decide = makeDialogDecider(ask, (text) => text.replaceAll("order", "[private]"));
    expect(await Effect.runPromise(decide(report(type)))).toEqual({ choice: "dismiss" });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.notice).toBe(
      `${type} from https://shop.example/cart\nPlace this [private]?`,
    );
  }
});

it("accepts a confirm the caller accepts, and asks a prompt's text after an accept", async () => {
  const confirm = answering("accept");
  expect(await Effect.runPromise(makeDialogDecider(confirm.ask, String)(report("confirm")))).toEqual(
    { choice: "accept" },
  );
  const prompt = answering("accept", "gift note");
  expect(await Effect.runPromise(makeDialogDecider(prompt.ask, String)(report("prompt")))).toEqual({
    choice: "accept",
    promptText: "gift note",
  });
  expect(prompt.asked).toHaveLength(2);
});

const failing = (failure: InputRequestFailure) => makeInputAsker(() => Effect.fail(failure));
/** Every way a question can fail other than its window ending unanswered. */
const unusable = [
  new OwnerCancelled({ code: "NoResponse" }),
  new InputRequestFailure({ code: "Unavailable" }),
  new InputRequestFailure({ code: "Refused" }),
  new InputRequestFailure({ code: "Unauthorized" }),
  new InputRequestFailure({ code: "Invalid" }),
];

it("fails as expired when the answer never comes, and as unavailable otherwise", async () => {
  const decided = await Effect.runPromise(
    Effect.either(
      makeDialogDecider(failing(new InputRequestFailure({ code: "NoResponse" })), String)(
        report("confirm"),
      ),
    ),
  );
  expect(Either.isLeft(decided) && decided.left).toMatchObject({
    _tag: "DialogFailure",
    reason: "expired",
  });
  for (const failure of unusable) {
    const refused = await Effect.runPromise(
      Effect.either(makeDialogDecider(failing(failure), String)(report("confirm"))),
    );
    expect(Either.isLeft(refused) && refused.left, failure.code).toMatchObject({
      _tag: "DialogFailure",
      reason: "unavailable",
    });
  }
});

const recorded = expectedConfirmDigest({
  message: "Place this order?",
  origin: "https://shop.example",
  step: "place-order",
});
/** An asker that answers a run's dialog question yes or no, keeping each request it got. */
const confirming = (confirmed: boolean) => {
  const asked: InputRequest[] = [];
  const ask = makeInputAsker((request) =>
    Effect.sync(() => {
      asked.push(request);
      return { decision: { confirmed } };
    }),
  );
  return { ask, asked };
};
const runDecider = (
  ask: ReturnType<typeof answering>["ask"],
  options: {
    readonly readOnly?: boolean;
    readonly incidents?: DialogIncident[];
    readonly project?: (text: string) => string;
  } = {},
) =>
  makeRunDialogDecider({
    ask,
    project: options.project ?? String,
    readOnly: options.readOnly ?? false,
    expectedConfirms: [recorded],
    incidents:
      options.incidents === undefined
        ? noIncidents
        : {
            record: (incident) =>
              Effect.sync(() => {
                options.incidents?.push(incident);
              }),
          },
  });

it("accepts the confirm a write's build accepted, at its step, without asking", async () => {
  const { ask, asked } = confirming(false);
  const incidents: DialogIncident[] = [];
  const decide = runDecider(ask, { incidents });
  expect(await Effect.runPromise(decide(report("confirm", "Place  this order?")))).toEqual({
    choice: "accept",
  });
  expect(asked).toEqual([]);
  expect(incidents).toMatchObject([{ reason: "dialog_expected_confirm_accepted" }]);
  // One record accepts one popup: the same confirm again asks.
  expect(await Effect.runPromise(decide(report("confirm")))).toEqual({ choice: "dismiss" });
  expect(asked).toHaveLength(1);
});

it("asks one yes or no question about a write's other confirms, in its masked words", async () => {
  const { ask, asked } = confirming(true);
  const decide = runDecider(ask, { project: (text) => text.replaceAll("item", "[private]") });
  for (const shown of [
    report("confirm", "Remove this item?"),
    { ...report("confirm"), step: "remove-item" },
    { ...report("confirm"), url: "https://other.example/cart" },
  ])
    expect(await Effect.runPromise(decide(shown))).toEqual({ choice: "accept" });
  expect(asked).toHaveLength(3);
  expect(asked[0]?.questions).toEqual([
    {
      id: "decision",
      type: "confirm",
      prompt: 'The website asks you to confirm: "Remove this [private]?". Confirm?',
    },
  ]);
  // A tool published without a record asks about every confirm, as before.
  const older = confirming(false);
  const unrecorded = makeRunDialogDecider({
    ask: older.ask,
    project: String,
    readOnly: false,
    expectedConfirms: undefined,
    incidents: noIncidents,
  });
  expect(await Effect.runPromise(unrecorded(report("confirm")))).toEqual({ choice: "dismiss" });
  expect(older.asked).toHaveLength(1);
});

it("gives every other dialog the safe default without asking", async () => {
  const incidents: DialogIncident[] = [];
  const { ask, asked } = confirming(true);
  const decide = runDecider(ask, { incidents });
  for (const [shown, choice] of [
    [report("alert"), "dismiss"],
    [report("prompt"), "dismiss"],
    [report("beforeunload"), "accept"],
  ] as const)
    expect(await Effect.runPromise(decide(shown))).toEqual({ choice });
  // A read tool never accepts from the record, and confirms nothing.
  const read = runDecider(ask, { readOnly: true, incidents });
  expect(await Effect.runPromise(read(report("confirm")))).toEqual({ choice: "dismiss" });
  expect(asked).toEqual([]);
  expect(incidents.map((incident) => [incident.reason, incident.subCause])).toEqual([
    ["dialog_default_decision", "alert_dismiss"],
    ["dialog_default_decision", "prompt_dismiss"],
    ["dialog_default_decision", "beforeunload_accept"],
    ["dialog_default_decision", "confirm_dismiss"],
  ]);
});

it("dismisses, never accepts, a confirm whose answer never comes", async () => {
  const incidents: DialogIncident[] = [];
  const unanswered = makeInputAsker(() =>
    Effect.fail(new InputRequestFailure({ code: "NoResponse" })),
  );
  const decide = runDecider(unanswered, { incidents });
  expect(await Effect.runPromise(decide(report("confirm", "Remove this item?")))).toEqual({
    choice: "dismiss",
  });
  expect(incidents.map((incident) => [incident.reason, incident.subCause])).toEqual([
    ["dialog_decision_expired", "confirm_dismiss"],
  ]);
});

it("fails the step, as before, when the owner cancels or the question cannot be asked", async () => {
  for (const failure of unusable) {
    const incidents: DialogIncident[] = [];
    const decided = await Effect.runPromise(
      Effect.either(
        runDecider(failing(failure), { incidents })(report("confirm", "Remove this item?")),
      ),
    );
    expect(Either.isLeft(decided) && decided.left, failure.code).toMatchObject({
      _tag: "DialogFailure",
      reason: failure.code === "Unauthorized" ? "unauthorized" : "unavailable",
    });
    expect(incidents).toEqual([]);
  }
});

it("keeps the confirms the owner accepts while building, as the page showed them", async () => {
  const accepted: ObservedConfirm[] = [];
  const { ask } = answering("accept");
  const decide = keepingAcceptedConfirms(makeDialogDecider(ask, String), accepted);
  await Effect.runPromise(decide(report("confirm")));
  await Effect.runPromise(decide(report("alert")));
  await Effect.runPromise(decide({ ...report("confirm"), url: "http://shop.example/cart" }));
  expect(accepted).toEqual([
    { message: "Place this order?", origin: "https://shop.example", step: "place-order" },
  ]);
  const dismissing = answering("dismiss");
  const none: ObservedConfirm[] = [];
  await Effect.runPromise(
    keepingAcceptedConfirms(makeDialogDecider(dismissing.ask, String), none)(report("confirm")),
  );
  expect(none).toEqual([]);
});

it("accepts a build's confirm that named its record when a run names another", async () => {
  const submit = (name: string) => ({
    ...report("confirm", `Finalize ${name}?`),
    step: "submit-document",
    url: "https://records.example/orders",
  });
  // While building, the owner accepts the confirm for the record the step's input names.
  const accepted: ObservedConfirm[] = [];
  const building = keepingAcceptedConfirms(
    makeDialogDecider(answering("accept").ask, String),
    accepted,
    { document: "Spring Order 1001" },
  );
  await Effect.runPromise(building(submit("Spring Order 1001")));
  const session = { acceptedConfirms: [] as ExpectedConfirm[], confirmSteps: new Set<string>() };
  recordConfirmSteps(session, accepted);
  const run = (input: unknown) => {
    const caller = confirming(false);
    const decide = makeRunDialogDecider({
      ask: caller.ask,
      project: String,
      readOnly: false,
      expectedConfirms: session.acceptedConfirms,
      input,
      incidents: noIncidents,
    });
    return { decide, asked: caller.asked };
  };
  // A run for another record gets the same confirm naming its own record: accepted, not asked.
  const other = run({ document: "Summer Order 2002" });
  expect(await Effect.runPromise(other.decide(submit("Summer Order 2002")))).toEqual({
    choice: "accept",
  });
  expect(other.asked).toEqual([]);
  // A confirm naming a record the run was not asked about, or with other wording, still asks.
  const elsewhere = run({ document: "Summer Order 2002" });
  expect(await Effect.runPromise(elsewhere.decide(submit("Winter Order 3003")))).toEqual({
    choice: "dismiss",
  });
  const cancel = run({ document: "Summer Order 2002" });
  expect(
    await Effect.runPromise(
      cancel.decide({
        ...submit("Summer Order 2002"),
        message: "Void Summer Order 2002?",
      }),
    ),
  ).toEqual({ choice: "dismiss" });
  expect([...elsewhere.asked, ...cancel.asked]).toHaveLength(2);
});

// A run's report needs to know a pop-up's question went unanswered; a cancel is the owner's choice.
it.each([
  {
    case: "a question left unanswered",
    error: new InputRequestFailure({ code: "NoResponse" }),
    unanswered: true,
  },
  {
    case: "the owner's cancel",
    error: new OwnerCancelled({ code: "NoResponse" }),
    unanswered: false,
  },
  {
    case: "an unavailable question",
    error: new InputRequestFailure({ code: "Unavailable" }),
    unanswered: false,
  },
])("watches the asker for $case", ({ error, unanswered }) => {
  const dialogs = watchingUnanswered(() => Effect.fail(error));
  expect(dialogs.unanswered()).toBe(false);
  const asked = Effect.runSync(
    Effect.either(dialogs.ask({ id: "dialog-1", source: "system", questions: [] })),
  );
  expect(asked).toEqual(Either.left(error));
  expect(dialogs.unanswered()).toBe(unanswered);
});
