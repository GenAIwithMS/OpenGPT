import { Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import type { AutofillPage } from "../../src/destinations/autofill-step.js";
import type {
  CredentialKeyboard,
  InsertionRefusal,
} from "../../src/destinations/credential-keyboard.js";
import {
  hostAuthentication,
  MintFailure,
  type MintDependencies,
} from "../../src/mint/contracts.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { autofillRefusalFailure, signInFailureFeedback } from "../../src/mint/sign-in-failure.js";
import { makeSignInRecorder } from "../../src/mint/sign-in-recorder.js";
import { makeSignInBrowser } from "../../src/standalone/authentication.js";
import { mintError } from "../../src/standalone/errors.js";
import { makeMintContinuationFixture, readAllow } from "../support/mint-fixtures.js";
import { CdpCommandRefused, fakeDevtoolsKeyboard } from "../support/fake-devtools.js";
import { portableJobSession } from "../support/portable-mint.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);

const site = "https://member.example.test";
const login = `${site}/login`;
const target = {
  ownerUrl: login,
  documentOrigin: site,
  actions: [`${site}/session`],
  methods: ["post"],
  submitMethod: "post",
  editable: true,
  control: "text",
} as const;
const described = {
  tag: "input",
  role: null,
  formMethod: "post",
  type: "password",
  name: "password",
  id: "password",
  autocomplete: "current-password",
  inputmode: null,
  label: "Password",
  placeholder: null,
  ariaLabel: null,
  text: null,
};
/** The synthetic password screen as the host's inspection finds it. */
const inspected = {
  fields: [{ target, described }],
  submit: {
    target,
    described: { ...described, tag: "button", type: "submit", name: null, id: "sign-in" },
  },
  buttons: ["Sign in"],
  url: login,
};
/** How the field answers the host's focus: it takes the focus, or an overlay keeps it. */
const focusAnswers = {
  focused: { focused: true, url: login },
  not_focused: { focused: false, unfocused: { activeTag: "DIV" }, url: login },
} as const;
/** A refusal the screen gives: the field never takes the focus, or its native insertion's cause. */
type ScreenRefusal = "not_focused" | Exclude<InsertionRefusal, "question_changed">;

/** The login the build already holds, so a password screen may come first. */
const heldLogin = { username: "synthetic-owner", password: "synthetic-password" };
/** The standalone host's sign-in recorder on `page`. */
const recorderOn = (page: AutofillPage, keyboard: CredentialKeyboard) =>
  makeSignInRecorder({
    browser: makeSignInBrowser({
      page,
      keyboard,
      siteOrigin: site,
      authenticationOrigins: [],
      typing: { typed: false },
    }),
    login: {
      held: () => heldLogin,
      values: Effect.succeed(heldLogin),
      correct: () => Effect.succeed(heldLogin),
    },
    ask: () => Effect.dieMessage("The test asks the owner nothing"),
    secrets: { register: () => {}, assertAbsent: () => Effect.void },
    review: () => Effect.void,
    site: "member.example.test",
    signedOutPages: () => [],
  });

/**
 * A synthetic password screen behind the standalone host's sign-in: each authenticate inspects
 * it, then focuses the field. The field takes the focus and the host's native insertion refuses
 * with the given cause, or, for `not_focused`, an overlay keeps the focus. `bindingKeys` holds
 * each binding the host placed on the field. A `keyboard` given inserts in its own way instead.
 */
const passwordScreen = (refusals: readonly ScreenRefusal[], keyboard?: CredentialKeyboard) => {
  const answers = refusals.flatMap((refusal) => [
    inspected,
    refusal === "not_focused" ? focusAnswers.not_focused : focusAnswers.focused,
  ]);
  const insertions = refusals.filter((refusal) => refusal !== "not_focused");
  const bindingKeys: string[] = [];
  const recorder = recorderOn(
    {
      targetId: "primary",
      execute: () => Effect.sync(() => answers.shift() ?? { error: "not_found", target: 0 }),
    },
    {
      insertText: (target, text) =>
        Effect.suspend(() => {
          bindingKeys.push(target.bindingKey);
          return (
            keyboard?.insertText(target, text) ??
            Effect.succeed(insertions.shift() ?? "insertion_rejected")
          );
        }),
    },
  );
  let executions = 0;
  return {
    executions: () => executions,
    bindingKeys,
    reviewAndExecute: ((execution, beforeDispatch = () => Effect.void) =>
      Effect.gen(function* () {
        executions++;
        const signIn = "signInStep" in execution ? execution.signInStep : undefined;
        if (signIn === undefined || !("fields" in signIn))
          return yield* Effect.die("The test signs in by autofill only");
        const step = yield* recorder.step(signIn, undefined, beforeDispatch(hostAuthentication));
        return {
          executionId: `sign_in_${executions}`,
          status: "completed" as const,
          effect: "possible" as const,
          observations: { step: step.report, ...step.result },
        };
      }).pipe(Effect.mapError(mintError))) satisfies MintDependencies["reviewAndExecute"],
  };
};

const signInStep = {
  fields: [{ selector: "#password", slot: "password" }],
  submit: "#sign-in",
};
const authenticate = (callId: string): ModelResponse => ({
  usage: new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
  output: [
    {
      type: "function_call",
      name: "execute",
      callId,
      arguments: JSON.stringify({
        purpose: "authenticate",
        target: "liveBrowser",
        entrypoint: "src/tool.ts",
        fixtureRefs: [],
        caseFilter: [],
        maxWorkers: 1,
        timeoutSeconds: 30,
        intent: "Sign in to the synthetic member site",
        signInStep,
      }),
      status: "completed",
    },
  ],
});
const finalAnswer: ModelResponse = {
  usage: new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
  output: [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "The sign-in did not work." }],
    },
  ],
};

/** The execute answer the model read for `callId`. */
const answerTo = (request: ModelRequest | undefined, callId: string) => {
  const items = Array.isArray(request?.input) ? request.input : [];
  const item = items.find(
    (entry) => entry.type === "function_call_result" && entry.callId === callId,
  );
  const output = item?.type === "function_call_result" ? item.output : undefined;
  const text =
    typeof output === "string"
      ? output
      : output !== undefined && "text" in output
        ? output.text
        : "";
  return JSON.parse(text === "" ? "{}" : text) as Record<string, unknown>;
};
/** The host's message to the model after its final answer, if any. */
const continuation = (request: ModelRequest | undefined) =>
  JSON.stringify(Array.isArray(request?.input) ? request.input.at(-1) : undefined);

it("routes a typing refusal on the password field to the unresolved sign-in, saying what was refused and why", async () => {
  const screen = passwordScreen(["insertion_rejected"]);
  const run = await fixture(
    (_request, index) => (index === 0 ? authenticate("sign_in_1") : finalAnswer),
    { autofillSignIn: true, reviewAndExecute: screen.reviewAndExecute },
    { effect: "read", siteOrigin: site },
  );
  const outcome = await run.run();
  const answer = answerTo(run.requests[1], "sign_in_1");
  expect(answer).toMatchObject({
    status: "authentication_unavailable",
    code: "AutofillRefused",
    nextStep: "authenticate",
    credentialSent: false,
    authentication: {
      code: "AutofillRefused",
      hostRefusal: { check: "typing_refused", field: 0, slot: "password" },
    },
  });
  // What was refused and why, by kind, with no value in it.
  expect(answer["notice"]).toContain("refused to type the password into field 1");
  expect(answer["notice"]).toContain("did not land in it");
  expect(JSON.stringify(answer)).not.toContain("synthetic-password");
  // A final answer then gets the unresolved sign-in's continuation, with the same notice.
  const guidance = continuation(run.requests[2]);
  expect(guidance).toContain("The last sign-in failed and nothing has resolved it yet");
  expect(guidance).toContain("did not land in it");
  expect(outcome.recoveryReason).toBeUndefined();
});

it("ends sign-in as unavailable after three identical refusals in a row", async () => {
  const screen = passwordScreen(["insertion_rejected", "insertion_rejected", "insertion_rejected"]);
  const run = await fixture(
    (_request, index) => (index < 3 ? authenticate(`sign_in_${index + 1}`) : finalAnswer),
    { autofillSignIn: true, reviewAndExecute: screen.reviewAndExecute },
    { effect: "read", siteOrigin: site },
  );
  const outcome = await run.run();
  expect(screen.executions()).toBe(3);
  expect(answerTo(run.requests[2], "sign_in_2")).toMatchObject({ nextStep: "authenticate" });
  // The third ends the build at once: the model is not asked again.
  expect(run.requests).toHaveLength(3);
  expect(outcome).toMatchObject({ build: "incomplete", recoveryReason: "sign_in_unavailable" });
  expect(outcome.summary).toContain(
    "refused the same field of the same screen the same way 3 times",
  );
});

it("starts the count again when a different refusal breaks the run", async () => {
  const screen = passwordScreen(["insertion_rejected", "insertion_rejected", "not_focused"]);
  const run = await fixture(
    (_request, index) => (index < 3 ? authenticate(`sign_in_${index + 1}`) : finalAnswer),
    { autofillSignIn: true, reviewAndExecute: screen.reviewAndExecute },
    { effect: "read", siteOrigin: site },
  );
  const outcome = await run.run();
  expect(screen.executions()).toBe(3);
  const third = answerTo(run.requests[3], "sign_in_3");
  expect(third).toMatchObject({
    nextStep: "authenticate",
    authentication: { hostRefusal: { check: "not_focused", field: 0, slot: "password" } },
  });
  expect(third).not.toHaveProperty("buildOutcome");
  expect(third["notice"]).toContain("did not take the focus");
  expect(outcome.recoveryReason).not.toBe("sign_in_unavailable");
});

// A native insertion that inserted nothing says why: the focus moved, the field or page was
// replaced, the binding did not resolve, or the browser rejected the text. The agent hears the
// cause and a next step for it, never the binding, the selector or the value.
it("tells the agent why the host's insertion inserted nothing, by its cause", async () => {
  const causes = [
    "focus_moved",
    "document_changed",
    "binding_not_found",
    "insertion_rejected",
  ] as const;
  const notices: string[] = [];
  for (const cause of causes) {
    const screen = passwordScreen([cause]);
    const run = await fixture(
      (_request, index) => (index === 0 ? authenticate("sign_in_1") : finalAnswer),
      { autofillSignIn: true, reviewAndExecute: screen.reviewAndExecute },
      { effect: "read", siteOrigin: site },
    );
    await run.run();
    const answer = answerTo(run.requests[1], "sign_in_1");
    expect(answer).toMatchObject({
      code: "AutofillRefused",
      nextStep: "authenticate",
      credentialSent: false,
      authentication: { hostRefusal: { check: "typing_refused", field: 0, cause } },
    });
    const notice = String(answer["notice"]);
    expect(screen.bindingKeys).toHaveLength(1);
    for (const bindingKey of screen.bindingKeys)
      expect(JSON.stringify(answer)).not.toContain(bindingKey);
    expect(JSON.stringify(answer)).not.toContain("synthetic-password");
    expect(notice).not.toContain(signInStep.fields[0]?.selector);
    notices.push(notice);
  }
  // Each kind of cause points the agent its own way.
  expect(new Set(notices).size).toBe(causes.length);
});

it("does not count refusals with different insertion causes as one repeated refusal", async () => {
  const screen = passwordScreen(["focus_moved", "focus_moved", "insertion_rejected"]);
  const run = await fixture(
    (_request, index) => (index < 3 ? authenticate(`sign_in_${index + 1}`) : finalAnswer),
    { autofillSignIn: true, reviewAndExecute: screen.reviewAndExecute },
    { effect: "read", siteOrigin: site },
  );
  const outcome = await run.run();
  expect(screen.executions()).toBe(3);
  const third = answerTo(run.requests[3], "sign_in_3");
  expect(third).toMatchObject({
    nextStep: "authenticate",
    authentication: { hostRefusal: { check: "typing_refused", cause: "insertion_rejected" } },
  });
  expect(third).not.toHaveProperty("buildOutcome");
  expect(outcome.recoveryReason).not.toBe("sign_in_unavailable");
});

// The browser may refuse a DevTools command the host sends before the one call that carries the
// value, such as the read of a third-party frame's document. Nothing was typed, so the agent hears
// a refused field with no credential sent, and may sign in again.
it("lets the agent sign in again when the browser refuses a command before the value was sent", async () => {
  for (const { refused, cause } of [
    { refused: "DOM.getDocument", cause: "binding_not_found" },
    { refused: "DOM.resolveNode", cause: "binding_unresolved" },
  ] as const) {
    const devtools = fakeDevtoolsKeyboard({ page: 1 }, (command) =>
      command.method === refused
        ? new CdpCommandRefused(command.method, command.params)
        : undefined,
    );
    const screen = passwordScreen([cause], devtools.keyboard);
    const run = await fixture(
      (_request, index) => (index === 0 ? authenticate("sign_in_1") : finalAnswer),
      { autofillSignIn: true, reviewAndExecute: screen.reviewAndExecute },
      { effect: "read", siteOrigin: site },
    );
    await run.run();
    const answer = answerTo(run.requests[1], "sign_in_1");
    expect(answer).toMatchObject({
      code: "AutofillRefused",
      signInOutcome: "signed_out",
      nextStep: "authenticate",
      credentialSent: false,
      countsTowardSignInCap: false,
      authentication: { hostRefusal: { check: "typing_refused", field: 0, cause } },
    });
    expect(devtools.sent.map(({ method }) => method)).not.toContain("Runtime.callFunctionOn");
    expect(JSON.stringify(answer)).not.toContain("synthetic-password");
  }
});

/** The standalone recorder's step on a password screen whose page answers each call in turn. */
const stepThrough = (
  calls: readonly Effect.Effect<unknown, Error>[],
  keyboard: CredentialKeyboard,
) => {
  const pending = [...calls];
  return Effect.runPromise(
    recorderOn(
      {
        targetId: "primary",
        execute: () => pending.shift() ?? Effect.fail(new Error("The page has no more calls")),
      },
      keyboard,
    ).step(
      { fields: [{ selector: "#password", slot: "password" }], submit: "#sign-in" },
      undefined,
      Effect.void,
    ),
  );
};

// The call that carries the value lost its answer, so the field may hold it. The host clicks the
// submit only after every field, so it never clicked it.
it("tells the agent a lost typing answer may have left the value in the field, never submitted", async () => {
  const devtools = fakeDevtoolsKeyboard({ page: 1 }, (command) =>
    command.method === "Runtime.callFunctionOn"
      ? new CdpCommandRefused(command.method, command.params)
      : undefined,
  );
  const { report, result } = await stepThrough(
    [Effect.succeed(inspected), Effect.succeed(focusAnswers.focused)],
    devtools.keyboard,
  );
  expect(report).toMatchObject({ outcome: "uncertain", typed: true });
  expect(result["nextStep"]).toBe(
    "The host lost the answer of the call that typed a field, so that field may hold its value. The host never clicked the submit. It never retries a fill by itself. Explore read-only to see the page, then continue with the next signInStep.",
  );
});

// A submit's call may have clicked before its answer was lost, so the agent still hears that the
// fields and the submit may have reached the site.
it("tells the agent a lost submit answer may have sent the fields and the submit", async () => {
  const { report, result } = await stepThrough(
    [
      Effect.succeed(inspected),
      Effect.succeed(focusAnswers.focused),
      Effect.fail(new Error("The page clicked, but its reply was lost")),
    ],
    { insertText: () => Effect.succeed("inserted" as const) },
  );
  expect(report).toMatchObject({ outcome: "uncertain", typed: true });
  expect(result["nextStep"]).toBe(
    "The host lost the fill call's answer: the fields and the submit may have reached the site. It never retries a fill by itself. Explore read-only to see the page, then continue with the next signInStep, then inspect read-only and correct the sign-in steps from the page's evidence.",
  );
});

// A refusal whose sign-in cleanup the host could not confirm may have left the site signed in:
// the cleanup's own advice wins, and the agent is never told to sign in again.
it("keeps an unconfirmed cleanup's advice when the host also refused a field", async () => {
  let executions = 0;
  const run = await fixture(
    // The model follows the answer's next step: another authenticate only when it says so.
    (request, index) =>
      index === 0 || (index === 1 && answerTo(request, "sign_in_1")["nextStep"] === "authenticate")
        ? authenticate(`sign_in_${index + 1}`)
        : finalAnswer,
    {
      autofillSignIn: true,
      executionAvailability: () => "open",
      reviewAndExecute: (_execution, beforeDispatch = () => Effect.void) =>
        beforeDispatch(readAllow).pipe(
          Effect.zipRight(
            Effect.suspend(() => {
              executions++;
              const failure = autofillRefusalFailure(
                {
                  check: "typing_refused",
                  field: 0,
                  slot: "password",
                  screen: { fields: ["#password"], submit: "#sign-in" },
                },
                { nothingSubmitted: true },
              );
              return Effect.fail(
                new MintFailure({
                  ...failure,
                  authentication: {
                    ...(failure.authentication ?? {
                      phase: "credential_submit",
                      code: "AutofillRefused",
                    }),
                    cleanupCode: "StopUnconfirmed",
                  },
                }),
              );
            }),
          ),
        ),
    },
    { effect: "read", siteOrigin: site },
  );
  await run.run();
  expect(answerTo(run.requests[1], "sign_in_1")).toMatchObject({
    signInOutcome: "unknown",
    nextStep: "report_sign_in_unavailable",
  });
  expect(executions).toBe(1);
});

// A submit the page keeps disabled after the fields were filled is no refusal of a field: the host
// typed the password, typed it again key by key, never clicked, and the agent reads that the submit
// stayed disabled.
it("tells the agent a submit stayed disabled after the fields were filled, as no field refusal", async () => {
  const answers: unknown[] = [inspected];
  const executed: string[] = [];
  const typings: unknown[] = [];
  const recorder = recorderOn(
    {
      targetId: "primary",
      execute: (code) =>
        Effect.sync(() => {
          executed.push(code);
          return (
            answers.shift() ??
            (code.includes("field.focus(") ? focusAnswers.focused : { submit: "disabled", url: login })
          );
        }),
    },
    {
      insertText: (_target, _text, options) =>
        Effect.sync(() => {
          typings.push(options);
          return "inserted" as const;
        }),
    },
  );
  const started = Date.now();
  const { report } = await Effect.runPromise(
    recorder.step(
      { fields: [{ selector: "#password", slot: "password" }], submit: "#sign-in" },
      undefined,
      Effect.void,
    ),
  );
  expect(report).toEqual({
    outcome: "filled",
    fields: [{ slot: "password", status: "filled" }],
    submit: "stayed_disabled",
    url: login,
    failureDetail: expect.objectContaining({ phase: "submit_disabled" }),
    typed: true,
  });
  // The host asked the page again while it waited, typed again by keys, waited again, then stopped.
  expect(Date.now() - started).toBeGreaterThanOrEqual(10_000);
  expect(typings).toEqual([undefined, { keys: true }]);
  expect(executed.length).toBeGreaterThan(3);
  expect(JSON.stringify(report)).not.toContain("synthetic-password");
}, 20_000);

// A private answer's question that changed before the host typed is no field the page moved: the
// agent hears that the question changed, so it sends the screen again for the owner to answer.
it("tells the agent a changed security question, not a moved field, refused a private answer", () => {
  const feedback = (cause?: "question_changed") =>
    JSON.stringify(
      signInFailureFeedback({
        phase: "credential_submit",
        code: "AutofillRefused",
        nothingSubmitted: true,
        hostRefusal: {
          check: "change",
          field: 0,
          slot: "private_answer",
          screen: { fields: ["#answer"] },
          ...(cause === undefined ? {} : { cause }),
        },
      }),
    );
  expect(feedback("question_changed")).toContain("security question");
  expect(feedback("question_changed")).not.toContain("moved the field");
  expect(feedback()).toContain("moved the field");
});
