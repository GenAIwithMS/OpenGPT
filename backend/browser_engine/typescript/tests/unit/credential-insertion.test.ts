import { Effect } from "effect";
import { expect, it } from "vitest";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import type { AutofillInspection, AutofillStep } from "../../src/destinations/autofill-step.js";
import {
  type CredentialKeyboard,
  makeCredentialKeyboard,
} from "../../src/destinations/credential-keyboard.js";
import {
  CdpCommandRefused,
  fakeDevtoolsKeyboard,
  type SentCommand,
} from "../support/fake-devtools.js";

const site = "https://login.example.test";
const password = "synthetic-password";
const step: AutofillStep = { fields: [{ slot: "password", selector: "#password" }] };
const inspection: AutofillInspection = {
  page: `${site}/login`,
  targets: { fields: [], submit: null },
  siteOrigin: site,
  authenticationOrigins: [],
  screen: { origin: site, fields: [], submit: null, buttons: [] },
};

/** A document whose `marked` inputs carry the binding's marker. */
const document = (key: string, marked: number) => ({
  root: {
    backendNodeId: 1,
    children: [
      { backendNodeId: 2, attributes: ["type", "password"] },
      ...Array.from({ length: marked }, (_, index) => ({
        backendNodeId: 10 + index,
        attributes: ["type", "password", key, ""],
      })),
    ],
  },
});

/**
 * A focused field's fill over a fake private DevTools socket whose sessions each hold a document
 * with that many marked inputs. Nothing past the document reads may run.
 */
const fill = async (markedPerSession: readonly number[]) => {
  let bindingKey = "";
  const report = await Effect.runPromise(
    fillAutofillStep({
      step,
      values: [password],
      inspection,
      page: {
        targetId: "primary",
        execute: (code) =>
          Effect.sync(() => {
            bindingKey = /__opengpt_autofill_[0-9a-f-]{36}/.exec(code)?.[0] ?? bindingKey;
            return { focused: true, url: inspection.page };
          }),
      },
      keyboard: makeCredentialKeyboard({
        sessions: () => markedPerSession.map((_, index) => `session-${index}`),
        send: (method, _params, sessionId) => {
          if (method !== "DOM.getDocument") throw new Error(`Unexpected ${method}`);
          const index = Number(sessionId.slice("session-".length));
          return Promise.resolve(document(bindingKey, markedPerSession[index] ?? 0));
        },
      }),
    }),
  );
  return { report, bindingKey };
};

for (const { name, markedPerSession, cause } of [
  { name: "no session holds the binding", markedPerSession: [0, 0], cause: "binding_not_found" },
  { name: "two sessions hold it", markedPerSession: [1, 1], cause: "binding_ambiguous" },
  { name: "one session holds it twice", markedPerSession: [2], cause: "binding_ambiguous" },
] as const)
  it(`refuses native insertion as ${cause} when ${name}, naming no binding, selector or value`, async () => {
    const { report, bindingKey } = await fill(markedPerSession);
    expect(bindingKey).not.toBe("");
    expect(report).toMatchObject({
      outcome: "refused",
      reason: "credential_target_refused",
      target: 0,
      failureDetail: {
        phase: "typing_refused",
        context: { check: "typing_refused", insertion: cause },
      },
    });
    const recorded = JSON.stringify(report);
    for (const secret of [bindingKey, password, "#password"])
      expect(recorded).not.toContain(secret);
  });

/**
 * A focused password field's fill through `keyboard`, on a page whose step has no submit: every
 * call finds the field and takes the focus, and the submit's call finds none to click.
 */
const fillThrough = (keyboard: CredentialKeyboard) =>
  Effect.runPromise(
    fillAutofillStep({
      step,
      values: [password],
      inspection,
      page: {
        targetId: "primary",
        execute: (code) =>
          Effect.succeed(
            code.includes("guardKey")
              ? { submit: "none", url: inspection.page }
              : { focused: true, url: inspection.page },
          ),
      },
      keyboard,
    }),
  );
const methods = (sent: readonly SentCommand[]) =>
  sent.map(({ method, sessionId }) => `${sessionId} ${method}`);

// A tab's third-party frames each have their own DevTools session, and the browser may refuse to
// read one's document. The field is in the page's own document, so the host still types it.
it("types into the page's field when a third-party frame's session refuses its document read", async () => {
  const devtools = fakeDevtoolsKeyboard({ page: 1, "third-party-frame": 0 }, (command) =>
    command.sessionId === "third-party-frame" && command.method === "DOM.getDocument"
      ? new CdpCommandRefused(command.method, command.params)
      : undefined,
  );
  const report = await fillThrough(devtools.keyboard);
  expect(report).toMatchObject({
    outcome: "filled",
    fields: [{ slot: "password", status: "filled" }],
    submit: "none",
  });
  expect(methods(devtools.sent)).toEqual([
    "page DOM.getDocument",
    "third-party-frame DOM.getDocument",
    "page DOM.resolveNode",
    "page Runtime.callFunctionOn",
    "page Runtime.releaseObject",
  ]);
});

// Before the one call that carries the value, the host has typed nothing, so a refused command
// there refuses the field as typed nothing, and the agent may correct the step and send it again.
for (const { refused, insertion } of [
  { refused: "DOM.getDocument", insertion: "binding_not_found" },
  { refused: "DOM.resolveNode", insertion: "binding_unresolved" },
] as const)
  it(`refuses the field as typed nothing (${insertion}) when the browser refuses ${refused}`, async () => {
    const devtools = fakeDevtoolsKeyboard({ page: 1 }, (command) =>
      command.method === refused
        ? new CdpCommandRefused(command.method, command.params)
        : undefined,
    );
    const report = await fillThrough(devtools.keyboard);
    expect(report).toMatchObject({
      outcome: "refused",
      reason: "credential_target_refused",
      target: 0,
      failureDetail: { context: { check: "typing_refused", insertion } },
    });
    expect(report).not.toHaveProperty("typed");
    expect(methods(devtools.sent)).not.toContain("page Runtime.callFunctionOn");
    expect(JSON.stringify(report)).not.toContain(password);
  });

// A host's binding world that fails leaves the field unresolved before the value was sent.
it("refuses the field as typed nothing (binding_unresolved) when the host's binding world fails", async () => {
  const devtools = fakeDevtoolsKeyboard({ page: 1 }, undefined, {
    bindingWorld: () => Effect.fail(new Error("The frame's private world is unavailable")),
  });
  const report = await fillThrough(devtools.keyboard);
  expect(report).toMatchObject({
    outcome: "refused",
    reason: "credential_target_refused",
    target: 0,
    failureDetail: { context: { check: "typing_refused", insertion: "binding_unresolved" } },
  });
  expect(report).not.toHaveProperty("typed");
  expect(methods(devtools.sent)).toEqual(["page DOM.getDocument"]);
});

/** Documents the host cannot walk: an undecodable node, a frame without its id, too many nodes. */
const unwalkable = [
  { name: "a node it cannot decode", document: { root: { backendNodeId: "1" } } },
  {
    name: "a frame without its id",
    document: { root: { backendNodeId: 1, contentDocument: { backendNodeId: 2 } } },
  },
  {
    name: "more than 50,000 nodes",
    document: {
      root: {
        backendNodeId: 1,
        children: Array.from({ length: 50_000 }, (_, index) => ({ backendNodeId: 2 + index })),
      },
    },
  },
];

// A third-party frame's document the host cannot walk is skipped like one it cannot read, so the
// host still types the page's own field.
for (const { name, document } of unwalkable)
  it(`types into the page's field when a third-party frame's document has ${name}`, async () => {
    const devtools = fakeDevtoolsKeyboard({ page: 1, "third-party-frame": 0 }, undefined, {
      documents: { "third-party-frame": document },
    });
    const report = await fillThrough(devtools.keyboard);
    expect(report).toMatchObject({
      outcome: "filled",
      fields: [{ slot: "password", status: "filled" }],
      submit: "none",
    });
    expect(methods(devtools.sent)).toContain("page Runtime.callFunctionOn");
  });

// When the only document that could hold the field cannot be walked, the binding is not found, and
// the host types nothing.
it("refuses the field as typed nothing (binding_not_found) when no walkable document holds it", async () => {
  const devtools = fakeDevtoolsKeyboard({ page: 0, "third-party-frame": 1 }, undefined, {
    documents: { "third-party-frame": unwalkable[0]?.document },
  });
  const report = await fillThrough(devtools.keyboard);
  expect(report).toMatchObject({
    outcome: "refused",
    reason: "credential_target_refused",
    target: 0,
    failureDetail: { context: { check: "typing_refused", insertion: "binding_not_found" } },
  });
  expect(report).not.toHaveProperty("typed");
  expect(methods(devtools.sent)).toEqual([
    "page DOM.getDocument",
    "third-party-frame DOM.getDocument",
  ]);
});

// The call that carries the value may have typed it before its answer was lost, so the fill
// stays uncertain: refused by the browser, or answered outside the finite set.
for (const { name, devtools } of [
  {
    name: "the browser refuses the call that carries the value",
    devtools: () =>
      fakeDevtoolsKeyboard({ page: 1 }, (command) =>
        command.method === "Runtime.callFunctionOn"
          ? new CdpCommandRefused(command.method, command.params)
          : undefined,
      ),
  },
  {
    name: "that call answers outside the finite set",
    devtools: () => fakeDevtoolsKeyboard({ page: 1 }, undefined, { insertion: "unexpected" }),
  },
])
  it(`stays uncertain when ${name}`, async () => {
    const { keyboard, sent } = devtools();
    const report = await fillThrough(keyboard);
    expect(report).toMatchObject({ outcome: "uncertain", reason: "fill_call_failed", typed: true });
    expect(methods(sent)).toContain("page Runtime.callFunctionOn");
  });

// A refused command's diagnostics name the transport's finite reason and the command's method, so
// the next failure says which command the browser refused. Never the value, its parameters or the
// error's message, and a label that holds the value is dropped.
it("keeps a refused typing command's reason and method, never the value or its parameters", async () => {
  const refuseTyping = (reason?: string) =>
    fakeDevtoolsKeyboard({ page: 1 }, (command) => {
      if (command.method !== "Runtime.callFunctionOn") return undefined;
      const refusal = new CdpCommandRefused(command.method, command.params);
      return reason === undefined ? refusal : Object.assign(refusal, { reason });
    });
  const report = await fillThrough(refuseTyping().keyboard);
  expect(report).toMatchObject({
    outcome: "uncertain",
    failureDetail: {
      context: {
        errorName: "CdpCommandFailure",
        errorReason: "cdp_command_error",
        errorMethod: "Runtime.callFunctionOn",
      },
    },
  });
  const recorded = JSON.stringify(report);
  for (const secret of [password, "synthetic refusal", "arguments", "params"])
    expect(recorded).not.toContain(secret);

  const echoed = await fillThrough(refuseTyping(`rejected ${password.toUpperCase()}`).keyboard);
  expect(echoed).toMatchObject({
    failureDetail: { context: { errorMethod: "Runtime.callFunctionOn" } },
  });
  expect(echoed).not.toHaveProperty("failureDetail.context.errorReason");
  expect(JSON.stringify(echoed).toLowerCase()).not.toContain(password);
});
