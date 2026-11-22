import { Effect } from "effect";
import { expect, it } from "vitest";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import type { AutofillInspection, AutofillStep } from "../../src/destinations/autofill-step.js";
import { makeCredentialKeyboard } from "../../src/destinations/credential-keyboard.js";
import { stepDiagnostic } from "../../src/runtime/autofill-replay-steps.js";

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
  it(`records a refused native insertion as ${cause} when ${name}, naming no binding, selector or value`, async () => {
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
    const event = stepDiagnostic(step, report);
    expect(event).toMatchObject({
      outcome: "refused",
      reason: "credential_target_refused",
      check: "typing_refused",
      insertion: cause,
    });
    const recorded = JSON.stringify([report, event]);
    for (const secret of [bindingKey, password, "#password"])
      expect(recorded).not.toContain(secret);
  });
