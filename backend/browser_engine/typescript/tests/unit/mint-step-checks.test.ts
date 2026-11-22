import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { ExecutionRequest } from "../../src/mint/contracts.js";
import {
  exampleInputRefusal,
  preflightTestInput,
  repeatableReadFor,
  stepInput,
  testInputNotJson,
  writeSessionBoundary,
} from "../../src/mint/step-checks.js";

const request = (overrides: Partial<ExecutionRequest> = {}): ExecutionRequest => ({
  purpose: "example",
  target: "pureFiles",
  entrypoint: "src/tool.mjs",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 30,
  ...overrides,
});
const agentTest = (input: unknown) =>
  request({
    purpose: "test",
    target: "liveBrowser",
    testInput: typeof input === "string" ? input : JSON.stringify(input),
  });

describe("preflightTestInput", () => {
  const httpTest = (input: unknown) => ({ ...agentTest(input), entrypoint: "src/tool-http.mjs" });

  it("runs as many inputs as a read signed out chooses, on either version", () => {
    const scope = { buildEffect: "read" as const, signedIn: false };
    for (const amountMinor of [12, 45, 78, 91, 104]) {
      expect(preflightTestInput(agentTest({ amountMinor }), scope)).toBeUndefined();
      expect(preflightTestInput(httpTest({ amountMinor }), scope)).toBeUndefined();
    }
  });

  // A signed-in read runs a few inputs it chose, its combined filter case, only on a host that
  // supports signed-in live tests; the harness, not preflight, holds it to its bound.
  it("leaves a signed-in read's chosen inputs to the harness's bound on a host that supports them", () => {
    for (const scope of [
      { buildEffect: "read" as const, signedIn: true, signedInTests: true },
      { buildEffect: "read" as const, signedInTests: true },
    ]) {
      expect(preflightTestInput(agentTest({ amountMinor: 12 }), scope)).toBeUndefined();
      expect(preflightTestInput(httpTest({ amountMinor: 12 }), scope)).toBeUndefined();
    }
  });

  it("runs no input a signed-in read chooses on a host without signed-in tests, only the caller's", () => {
    for (const scope of [
      { buildEffect: "read" as const, signedIn: true },
      { buildEffect: "read" as const },
      { buildEffect: "read" as const, signedIn: true, signedInTests: false },
    ]) {
      for (const submitted of [agentTest({ amountMinor: 12 }), httpTest({ amountMinor: 12 })])
        expect(preflightTestInput(submitted, scope)).toEqual({
          supported: false,
          reason: expect.stringContaining("Nothing was executed."),
        });
      // A live test without testInput runs the caller's input: the HTTP version's one check.
      expect(
        preflightTestInput(request({ purpose: "test", target: "liveBrowser" }), scope),
      ).toBeUndefined();
    }
  });

  it.each([
    ["an example", request({ testInput: "{}" }), "read"],
    ["an offline test", request({ purpose: "test", testInput: "{}" }), "read"],
    [
      "a live explore",
      request({ purpose: "explore", target: "liveBrowser", testInput: "{}" }),
      "read",
    ],
    ["malformed JSON", agentTest("{x"), "read"],
    ["a write build's live test", agentTest({ amountMinor: 12 }), "write"],
  ] as const)("refuses an agent-chosen input on %s", (_, submitted, buildEffect) => {
    expect(preflightTestInput(submitted, { buildEffect, signedIn: false })).toMatchObject({
      supported: false,
      reason: expect.stringContaining("Nothing was executed."),
    });
  });
});

describe("exampleInputRefusal", () => {
  const exampleInput = JSON.stringify({ venue: "Venue X", date: "2026-10-04", partySize: 2 });
  const order = { item: "lamp", quantity: 2 };
  const notStarted = { started: false, input: undefined };
  const act = (input: unknown = order) =>
    request({ purpose: "act", target: "liveBrowser", exampleInput: JSON.stringify(input) });
  const scope = (
    buildEffect: "read" | "write",
    callerInput: unknown = {},
    writeSession: {
      readonly started: boolean;
      readonly input: Readonly<Record<string, unknown>> | undefined;
    } = notStarted,
  ) => ({ buildEffect, callerInput, writeSession });

  it("lets a read's example run the agent's reading of an empty caller input", () => {
    expect(exampleInputRefusal(request({ exampleInput }), scope("read"))).toBeUndefined();
    expect(exampleInputRefusal(request(), scope("write"))).toBeUndefined();
  });

  it("lets a write's first act step fix the session's input, and later steps repeat it", () => {
    expect(exampleInputRefusal(act(), scope("write"))).toBeUndefined();
    // A step Guardian denied never started the session, so a corrected input may follow.
    expect(exampleInputRefusal(act({ ...order, quantity: 1 }), scope("write"))).toBeUndefined();
    const running = { started: true, input: order };
    expect(exampleInputRefusal(act(), scope("write", {}, running))).toBeUndefined();
    expect(
      exampleInputRefusal(
        request({ purpose: "act", target: "liveBrowser" }),
        scope("write", {}, running),
      ),
    ).toBeUndefined();
  });

  it("lets a later act step fix the session's input after steps that ran on the caller's empty input", () => {
    // The session's earlier act steps passed none, so they ran the caller's empty input.
    const ranEmpty = { started: true, input: undefined };
    expect(exampleInputRefusal(act(), scope("write", {}, ranEmpty))).toBeUndefined();
  });

  it.each([
    ["the caller's own input", request({ exampleInput }), scope("read", { venue: "Venue Y" })],
    ["a write build's example", request({ exampleInput }), scope("write")],
    ["text that is not JSON", request({ exampleInput: '{"venue":' }), scope("read")],
    ["JSON that is not an input object", request({ exampleInput: "[2]" }), scope("read")],
    ["a test", request({ exampleInput, purpose: "test" }), scope("read")],
    [
      "an explore",
      request({ exampleInput, purpose: "explore", target: "liveBrowser" }),
      scope("read"),
    ],
    ["a read build's act step", act(), scope("read")],
    ["a write's act step beside the caller's own input", act(), scope("write", { item: "desk" })],
    ["a write's act step that is not an input object", act([order]), scope("write")],
    [
      "a session that runs another input",
      act({ ...order, quantity: 3 }),
      scope("write", {}, { started: true, input: order }),
    ],
  ] as const)("refuses exampleInput on %s", (_, submitted, given) => {
    const refusal = exampleInputRefusal(submitted, given);
    expect(refusal).toMatchObject({ supported: false });
    expect(refusal?.reason).toContain("exampleInput");
    expect(refusal?.reason).toContain("Nothing was executed.");
  });

  it("says why a session's step cannot change its input", () => {
    expect(
      exampleInputRefusal(
        act({ ...order, quantity: 3 }),
        scope("write", {}, { started: true, input: order }),
      )?.reason,
    ).toContain(
      "This write session already runs the exampleInput an earlier act step passed. Repeat it unchanged or omit it.",
    );
  });

  it("refuses exampleInput while a host repairs a published tool, which runs its failing case's input", () => {
    const repairing = { ...scope("read"), maintenance: true };
    expect(exampleInputRefusal(request({ exampleInput }), repairing)).toEqual({
      supported: false,
      reason:
        "exampleInput is not for maintenance, which repairs the tool on its failing case's own input. Correct or remove exampleInput and execute again. Nothing was executed.",
    });
    expect(
      exampleInputRefusal(act(), { ...scope("write"), maintenance: true })?.reason,
    ).toContain("exampleInput is not for maintenance");
    // The purpose comes first: a test is refused for its purpose, as without the flag.
    expect(
      exampleInputRefusal(request({ exampleInput, purpose: "test" }), repairing)?.reason,
    ).toContain("exampleInput is valid only on a read's example or a write's act step.");
    // A build that is not a repair runs as before.
    expect(
      exampleInputRefusal(request({ exampleInput }), { ...scope("read"), maintenance: false }),
    ).toBeUndefined();
  });
});

describe("testInputNotJson", () => {
  it("is the refusal a test input that is not JSON text gets", () => {
    expect(preflightTestInput(agentTest("{x"), { buildEffect: "read", executionHistory: [] })).toEqual({
      supported: false,
      reason: testInputNotJson,
    });
  });
});

describe("stepInput", () => {
  const run = (
    submitted: ExecutionRequest,
    callerInput: unknown,
    sessionInput?: Readonly<Record<string, unknown>>,
  ) => Effect.runPromise(Effect.either(stepInput(submitted, { callerInput, sessionInput })));
  it("runs a read's example on the input the agent read from the prompt, marked intent_derived", async () => {
    const reservation = { venue: "Venue X", date: "2026-10-04", partySize: 2 };
    expect(await run(request({ exampleInput: JSON.stringify(reservation) }), {})).toMatchObject({
      _tag: "Right",
      right: { input: reservation, mark: "intent_derived" },
    });
  });

  it("runs a write session's act steps on the input the first act step that passed one fixed", async () => {
    const order = { item: "lamp", quantity: 2 };
    const act = (extra: Partial<ExecutionRequest> = {}) =>
      request({ purpose: "act", target: "liveBrowser", ...extra });
    expect(await run(act({ exampleInput: JSON.stringify(order) }), {})).toMatchObject({
      _tag: "Right",
      right: { input: order, mark: "intent_derived" },
    });
    // A later step that omits it, or repeats it, runs the session's input.
    expect(await run(act(), {}, order)).toMatchObject({
      _tag: "Right",
      right: { input: order, mark: "intent_derived" },
    });
    expect(
      await Effect.runPromise(stepInput(act(), { callerInput: {}, sessionInput: undefined })),
    ).toEqual({
      input: {},
    });
  });

  it("runs a session's first act steps on the caller's empty input until one passes exampleInput, then that input", async () => {
    const order = { item: "lamp", quantity: 2 };
    const act = (extra: Partial<ExecutionRequest> = {}) =>
      request({ purpose: "act", target: "liveBrowser", ...extra });
    const writeScope = (session: { readonly started: boolean; readonly input?: typeof order }) => ({
      buildEffect: "write" as const,
      callerInput: {},
      writeSession: { started: session.started, input: session.input },
    });
    // Step 1 passes none and runs the caller's empty input, unmarked.
    expect(exampleInputRefusal(act(), writeScope({ started: false }))).toBeUndefined();
    expect(
      await Effect.runPromise(stepInput(act(), { callerInput: {}, sessionInput: undefined })),
    ).toEqual({ input: {} });
    // Step 2 is the first to pass one, so it fixes the session's input.
    const fixing = act({ exampleInput: JSON.stringify(order) });
    expect(exampleInputRefusal(fixing, writeScope({ started: true }))).toBeUndefined();
    expect(await run(fixing, {})).toMatchObject({
      _tag: "Right",
      right: { input: order, mark: "intent_derived" },
    });
    // Step 3 omits it and runs that input; step 4 passes another and is refused.
    expect(await run(act(), {}, order)).toMatchObject({
      _tag: "Right",
      right: { input: order, mark: "intent_derived" },
    });
    const changed = act({ exampleInput: JSON.stringify({ ...order, quantity: 3 }) });
    expect(
      exampleInputRefusal(changed, writeScope({ started: true, input: order }))?.reason,
    ).toContain("Repeat it unchanged or omit it");
  });

  it("runs an agent-chosen test input, marked agent_chosen, and otherwise the caller's input", async () => {
    expect(await run(agentTest({ amountMinor: 12 }), { amountMinor: 3700 })).toMatchObject({
      _tag: "Right",
      right: { input: { amountMinor: 12 }, mark: "agent_chosen" },
    });
    const plain = await Effect.runPromise(
      stepInput(request({ purpose: "test", target: "liveBrowser" }), {
        callerInput: { a: 1 },
        sessionInput: undefined,
      }),
    );
    expect(plain).toEqual({ input: { a: 1 } });
  });

  it("refuses a test input that is not JSON as an invalid request", async () => {
    expect(await run(agentTest("{x"), {})).toMatchObject({
      _tag: "Left",
      left: { code: "InvalidRequest" },
    });
  });
});

describe("writeSessionBoundary", () => {
  const live = (purpose: ExecutionRequest["purpose"]) =>
    request({ purpose, target: "liveBrowser" });
  it("keeps act steps to a write build's live session", () => {
    expect(
      writeSessionBoundary(live("act"), { buildEffect: "read", writeSessionStarted: false }),
    ).toContain("Purpose act is a live step");
    expect(
      writeSessionBoundary(request({ purpose: "act" }), {
        buildEffect: "write",
        writeSessionStarted: false,
      }),
    ).toBeDefined();
    expect(
      writeSessionBoundary(live("act"), { buildEffect: "write", writeSessionStarted: true }),
    ).toBeUndefined();
  });

  it("refuses a write build's live example and test, and live explores once its session started", () => {
    const write = { buildEffect: "write" as const, writeSessionStarted: false };
    expect(writeSessionBoundary(live("example"), write)).toContain("never as a live example");
    expect(writeSessionBoundary(live("test"), write)).toContain("never as a live example");
    expect(writeSessionBoundary(live("explore"), write)).toBeUndefined();
    expect(
      writeSessionBoundary(live("explore"), { ...write, writeSessionStarted: true }),
    ).toContain("live exploration is over");
    expect(writeSessionBoundary(request({ purpose: "test" }), write)).toBeUndefined();
    for (const purpose of ["example", "test", "explore"] as const)
      expect(
        writeSessionBoundary(live(purpose), { buildEffect: "read", writeSessionStarted: false }),
      ).toBeUndefined();
  });
});

describe("read/write switches", () => {
  it("treats a read build with no claimed example as repeatable", () => {
    expect(repeatableReadFor("read", false)).toBe(true);
    expect(repeatableReadFor("read", true)).toBe(false);
    expect(repeatableReadFor("write", false)).toBe(false);
    expect(repeatableReadFor(undefined, false)).toBe(false);
  });
});
