import { Effect } from "effect";
import { expect, it } from "vitest";
import { fillAutofillStep } from "../../src/destinations/autofill-fill.js";
import type { AutofillInspection, AutofillStep } from "../../src/destinations/autofill-step.js";
import { makeCredentialKeyboard } from "../../src/destinations/credential-keyboard.js";

const inspection: AutofillInspection = {
  page: "https://member.example.com/login",
  targets: { fields: [], submit: null },
  siteOrigin: "https://member.example.com",
  authenticationOrigins: [],
  screen: { origin: "https://member.example.com", fields: [], submit: null, buttons: [] },
};

const lostReply = (step: AutofillStep, values: readonly string[], siteMutation: () => void) =>
  Effect.runPromise(
    fillAutofillStep({
      step,
      values,
      inspection,
      page: {
        targetId: "primary",
        execute: () =>
          Effect.suspend(() => {
            siteMutation();
            return Effect.fail(new Error("The page executed, but its reply was lost"));
          }),
      },
      keyboard: { insertText: () => Effect.succeed("inserted" as const) },
    }),
  );

it("reports uncertainty when the first date fill ran but its reply was lost", async () => {
  let dateOnSite = "";
  const report = await lostReply(
    { fields: [{ slot: "date_of_birth", selector: "#birth-date" }] },
    ["1990-01-01"],
    () => {
      dateOnSite = "1990-01-01";
    },
  );
  expect(dateOnSite).toBe("1990-01-01");
  expect(report).toMatchObject({ outcome: "uncertain", reason: "fill_call_failed" });
});

it("reports uncertainty when a submit-only method choice ran but its reply was lost", async () => {
  let chosenMethod: string | undefined;
  const report = await lostReply({ fields: [], submit: "#text-message" }, [], () => {
    chosenMethod = "sms";
  });
  expect(chosenMethod).toBe("sms");
  expect(report).toMatchObject({ outcome: "uncertain", reason: "fill_call_failed" });
});

it("refuses an initial focus whose reply was lost before any credential reached the site", async () => {
  const report = await lostReply(
    { fields: [{ slot: "password", selector: "#password" }], submit: "#sign-in" },
    ["synthetic-password"],
    () => {},
  );
  expect(report).toMatchObject({ outcome: "refused", reason: "page_unavailable" });
});

it("keeps atomic insertion uncertain when it reached the site but its reply was lost", async () => {
  let siteValue = "";
  const report = await Effect.runPromise(
    fillAutofillStep({
      step: { fields: [{ slot: "password", selector: "#password" }] },
      values: ["synthetic-password"],
      inspection,
      page: {
        targetId: "primary",
        execute: () => Effect.succeed({ focused: true, url: inspection.page }),
      },
      keyboard: {
        insertText: (_target, value) =>
          Effect.suspend(() => {
            siteValue = value;
            return Effect.fail(new Error("Private insertion reply lost"));
          }),
      },
    }),
  );
  expect(siteValue).toBe("synthetic-password");
  expect(report).toMatchObject({ outcome: "uncertain", reason: "fill_call_failed" });
});

/** A DevTools stand-in holding one field marked with the binding key, in a child frame. */
const recordingCdp = () => {
  const sent: { readonly method: string; readonly params: Record<string, unknown> }[] = [];
  const cdp = {
    sessions: () => ["page"],
    send: (method: string, params: Record<string, unknown>) => {
      sent.push({ method, params });
      switch (method) {
        case "DOM.getDocument":
          return Promise.resolve({
            root: {
              backendNodeId: 1,
              children: [
                {
                  backendNodeId: 2,
                  frameId: "child-frame",
                  contentDocument: {
                    backendNodeId: 3,
                    children: [{ backendNodeId: 4, attributes: ["data-binding", ""] }],
                  },
                },
              ],
            },
          });
        case "DOM.resolveNode":
          return Promise.resolve({ object: { objectId: "field" } });
        case "Runtime.callFunctionOn":
          return Promise.resolve({ result: { value: "inserted" } });
        default:
          return Promise.resolve({});
      }
    },
  };
  return { cdp, sent };
};
const target = { bindingKey: "data-binding", documentOrigin: "https://member.example.com" };

it("types a credential in the bound field's main world with four DevTools commands", async () => {
  const { cdp, sent } = recordingCdp();
  expect(await Effect.runPromise(makeCredentialKeyboard(cdp).insertText(target, "s3cret"))).toBe(
    "inserted",
  );
  expect(sent.map(({ method }) => method)).toEqual([
    "DOM.getDocument",
    "DOM.resolveNode",
    "Runtime.callFunctionOn",
    "Runtime.releaseObject",
  ]);
  expect(sent[1]?.params).toEqual({ backendNodeId: 4 });
  expect(sent[2]?.params["arguments"]).toEqual([
    { value: "data-binding" },
    { value: "https://member.example.com" },
    { value: "s3cret" },
    { value: false },
  ]);
});

it("resolves the field in the execution context a host's binding world returns", async () => {
  const { cdp, sent } = recordingCdp();
  const bindings: unknown[] = [];
  const keyboard = makeCredentialKeyboard(cdp, undefined, (_cdp, binding) =>
    Effect.sync(() => {
      bindings.push(binding);
      return 42;
    }),
  );
  expect(await Effect.runPromise(keyboard.insertText(target, "s3cret"))).toBe("inserted");
  expect(bindings).toEqual([{ sessionId: "page", frameId: "child-frame" }]);
  expect(sent[1]).toEqual({
    method: "DOM.resolveNode",
    params: { backendNodeId: 4, executionContextId: 42 },
  });
});

it("types nothing when a host's binding world fails", async () => {
  const { cdp, sent } = recordingCdp();
  const keyboard = makeCredentialKeyboard(cdp, undefined, () =>
    Effect.fail(new Error("World unavailable")),
  );
  expect(await Effect.runPromise(keyboard.insertText(target, "s3cret"))).toBe("binding_unresolved");
  expect(sent.map(({ method }) => method)).toEqual(["DOM.getDocument"]);
});

// A page that keeps changing a control while the host waits for it to enable the submit is
// refused on the third change of the whole wait, not let off because each retry starts a new call.
it("refuses a page that keeps changing its controls while the submit stays disabled", async () => {
  const site = "https://member.example.com";
  const target = {
    ownerUrl: site,
    documentOrigin: site,
    actions: [`${site}/session`],
    methods: ["post"],
    submitMethod: "post",
    editable: true,
    control: "text" as const,
  };
  const submit = { ...target, editable: false, control: "other" as const };
  const step: AutofillStep = {
    fields: [{ slot: "password", selector: "#password" }],
    submit: "#continue",
  };
  let readOnly = false;
  let submitCalls = 0;
  const started = Date.now();
  const report = await Effect.runPromise(
    fillAutofillStep({
      step,
      values: ["synthetic-password"],
      inspection: {
        ...inspection,
        targets: { fields: [target], submit },
        screen: { ...inspection.screen, origin: site },
      },
      page: {
        targetId: "primary",
        execute: (code: string) =>
          Effect.sync(() => {
            if (!code.includes("guardKey")) return { focused: true, url: inspection.page };
            // Each retry first finds the password field toggled, then the submit still disabled.
            submitCalls++;
            if (submitCalls % 2 === 0) return { submit: "disabled", url: inspection.page };
            readOnly = !readOnly;
            return {
              changed: { fields: [{ ...target, editable: !readOnly }], submit },
              url: inspection.page,
            };
          }),
      },
      keyboard: { insertText: () => Effect.succeed("inserted" as const) },
      settleMs: 0,
    }),
  );
  expect(report).toMatchObject({
    outcome: "filled",
    fields: [{ slot: "password", status: "filled" }],
    submit: "refused",
    failureDetail: { phase: "change", context: { check: "change" } },
  });
  expect(submitCalls).toBe(5);
  expect(Date.now() - started).toBeLessThan(4_000);
}, 10_000);
