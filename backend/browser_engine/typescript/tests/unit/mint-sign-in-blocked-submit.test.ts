import { Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import type {
  AutofillInspection,
  AutofillSignedInCheck,
  AutofillStep,
  AutofillStepReport,
} from "../../src/destinations/autofill-step.js";
import {
  hostAuthentication,
  type MintDependencies,
  type SignInStep,
} from "../../src/mint/contracts.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { makeSignInRecorder } from "../../src/mint/sign-in-recorder.js";
import { mintError } from "../../src/standalone/errors.js";
import { makeMintContinuationFixture } from "../support/mint-fixtures.js";
import { portableJobSession } from "../support/portable-mint.js";

/*
 * A cookie or consent notice sits over a sign-in screen's submit and catches the host's click, so
 * nothing is sent. The host says so (`blocked`), and the same screen sent again, with the notice's
 * own control as `dismiss`, is clicked again without typing anything: no fill is spent, so the
 * host never refuses the screen as filled too often, and the recipe keeps the dismiss for runs.
 * Each scenario runs the real minter loop on recorded model responses, with the standalone host's
 * sign-in recorder over a synthetic site.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);

const origin = "https://member.example.test";
const login = { username: "synthetic-owner", password: "synthetic-password" };
const accept = "#consent-accept";
const target = {
  ownerUrl: `${origin}/login`,
  documentOrigin: origin,
  actions: [`${origin}/session`],
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
  name: null,
  id: null,
  autocomplete: null,
  inputmode: null,
  label: "Password",
  placeholder: null,
  ariaLabel: null,
  text: null,
};

/**
 * A synthetic site whose consent notice covers the sign-in submit until its own accept control is
 * clicked. `fills` counts the fills that typed, `resubmits` the clicks again that typed nothing.
 * With `reloads`, the click again that accepts the notice loads the page again, which empties the
 * password field, so that click sends nothing.
 */
const coveredSite = ({ reloads = false } = {}) => {
  let fills = 0;
  let resubmits = 0;
  let covered = true;
  let signedIn = false;
  const click = (step: AutofillStep): AutofillStepReport => {
    if (step.dismiss === accept) covered = false;
    const fields = step.fields.map((field) => ({ slot: field.slot, status: "filled" as const }));
    if (covered)
      return {
        outcome: "filled",
        fields,
        submit: "blocked",
        blockedBy: { tag: "div", role: "dialog" },
        url: `${origin}/login`,
      };
    signedIn = true;
    return { outcome: "filled", fields, submit: "clicked", url: `${origin}/account` };
  };
  const recorder = makeSignInRecorder({
    browser: {
      inspect: (step: AutofillStep) =>
        Effect.succeed<AutofillInspection>({
          url: `${origin}/login`,
          page: `${origin}/login`,
          targets: { fields: step.fields.map(() => target), submit: target },
          siteOrigin: origin,
          authenticationOrigins: [],
          screen: {
            origin,
            fields: step.fields.map((field) => ({ ...described, slot: field.slot })),
            submit: described,
            buttons: [],
          },
        }),
      fill: ({ step }) =>
        Effect.sync(() => {
          fills += 1;
          return click(step);
        }),
      resubmit: ({ step }) =>
        Effect.sync((): AutofillStepReport => {
          resubmits += 1;
          if (!reloads) return click(step);
          covered = false;
          return {
            outcome: "filled",
            fields: [
              { slot: "username", status: "filled" },
              { slot: "password", status: "failed" },
            ],
            submit: "not_attempted",
            url: `${origin}/login`,
          };
        }),
      confirm: () =>
        Effect.sync(
          (): AutofillSignedInCheck =>
            signedIn
              ? { signedIn: true, url: `${origin}/account` }
              : { signedIn: false, failed: "indicator_not_visible", url: `${origin}/login` },
        ),
      authenticationOrigins: [],
      open: () => Effect.void,
      markerVisible: () => Effect.succeed(false),
    },
    login: {
      held: () => login,
      values: Effect.succeed(login),
      correct: () => Effect.succeed(login),
    },
    ask: () => Effect.dieMessage("The test asks the owner nothing"),
    secrets: { register: () => {}, assertAbsent: () => Effect.void },
    review: () => Effect.void,
    site: "member.example.test",
    signedOutPages: () => [],
  });
  let executions = 0;
  const reviewAndExecute: MintDependencies["reviewAndExecute"] = (
    execution,
    beforeDispatch = () => Effect.void,
  ) =>
    Effect.gen(function* () {
      executions += 1;
      const signIn = "signInStep" in execution ? execution.signInStep : undefined;
      if (signIn === undefined) return yield* Effect.die("The test signs in by autofill only");
      const step = yield* recorder.step(
        signIn,
        `${origin}/login`,
        beforeDispatch(hostAuthentication),
      );
      return {
        executionId: `sign_in_${executions}`,
        status: "completed" as const,
        effect: "possible" as const,
        observations: { step: step.report, ...step.result },
      };
    }).pipe(Effect.mapError(mintError));
  return {
    fills: () => fills,
    resubmits: () => resubmits,
    published: () => recorder.published(),
    dependencies: {
      autofillSignIn: true,
      reviewAndExecute,
      signInRefillRefused: () => recorder.passwordRefillRefused(),
    } satisfies Partial<MintDependencies>,
  };
};

const usage = () => new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 });
const call = (name: string, callId: string, input: object): ModelResponse => ({
  usage: usage(),
  output: [
    {
      type: "function_call",
      name,
      callId,
      arguments: JSON.stringify({ ...input, intent: `Synthetic ${name} purpose` }),
      status: "completed",
    },
  ],
});
const passwordScreen: SignInStep = {
  fields: [
    { selector: "#user", accepts: ["username"] },
    { selector: "#password", slot: "password" },
  ],
  submit: "#sign-in",
};
const authenticate = (callId: string, signInStep: SignInStep) =>
  call("execute", callId, {
    purpose: "authenticate",
    target: "liveBrowser",
    entrypoint: "src/tool.ts",
    fixtureRefs: [],
    caseFilter: [],
    maxWorkers: 1,
    timeoutSeconds: 30,
    signInStep,
  });
const stop: ModelResponse = {
  usage: usage(),
  output: [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Stopping." }],
    },
  ],
};

/** What a sign-in step's answer for `callId` observed: the screen's report and the next step. */
const stepAnswer = (request: ModelRequest | undefined, callId: string) => {
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
  const { observations } = JSON.parse(text === "" ? "{}" : text) as Record<string, unknown>;
  return typeof observations === "string" ? (JSON.parse(observations) as unknown) : observations;
};

it("a notice that catches the submit's click is reported blocked, and the screen sent again with its dismiss is clicked again without typing, signs in and records the dismiss", async () => {
  const site = coveredSite();
  const run = await fixture(
    (_request, index) =>
      [
        authenticate("fill", passwordScreen),
        authenticate("again", { ...passwordScreen, dismiss: accept }),
        authenticate("check", { signedIn: { selector: "#account" } }),
      ][index] ?? stop,
    site.dependencies,
    { effect: "read", siteOrigin: origin },
  );
  await run.run();
  expect(stepAnswer(run.requests[1], "fill")).toMatchObject({
    step: { outcome: "filled", submit: "blocked", blockedBy: { tag: "div", role: "dialog" } },
    nextStep: expect.stringContaining("dismiss"),
  });
  expect(stepAnswer(run.requests[2], "again")).toMatchObject({
    step: { outcome: "filled", submit: "clicked" },
  });
  expect(stepAnswer(run.requests[3], "check")).toMatchObject({ signedIn: true });
  // The password was typed once: the click again typed nothing.
  expect(site.fills()).toBe(1);
  expect(site.resubmits()).toBe(1);
  expect(site.published()?.recipe).toMatchObject({
    version: 6,
    steps: [{ submit: "#sign-in", dismiss: accept, submittedBy: "host" }],
  });
});

it("the blocked screen sent again and again types nothing, so the host never refuses it as filled too often", async () => {
  const site = coveredSite();
  const run = await fixture(
    (_request, index) =>
      [
        authenticate("fill", passwordScreen),
        authenticate("again_1", passwordScreen),
        authenticate("again_2", passwordScreen),
        authenticate("again_3", { ...passwordScreen, dismiss: accept }),
      ][index] ?? stop,
    site.dependencies,
    { effect: "read", siteOrigin: origin },
  );
  await run.run();
  for (const [index, callId] of ["again_1", "again_2"].entries())
    expect(stepAnswer(run.requests[index + 2], callId)).toMatchObject({
      step: { outcome: "filled", submit: "blocked" },
    });
  expect(stepAnswer(run.requests[4], "again_3")).toMatchObject({
    step: { outcome: "filled", submit: "clicked" },
  });
  expect(site.fills()).toBe(1);
  expect(site.resubmits()).toBe(3);
});

it("a blocked screen whose password the dismiss emptied is filled again in the same step as a refill, so the password is still typed twice at most", async () => {
  const site = coveredSite({ reloads: true });
  const run = await fixture(
    (_request, index) =>
      [
        authenticate("fill_1", passwordScreen),
        authenticate("again", { ...passwordScreen, dismiss: accept }),
        authenticate("fill_2", passwordScreen),
      ][index] ?? stop,
    site.dependencies,
    { effect: "read", siteOrigin: origin },
  );
  await run.run();
  // The click again found the password empty and clicked nothing, so the host typed it once more.
  expect(site.resubmits()).toBe(1);
  expect(stepAnswer(run.requests[2], "again")).toMatchObject({
    step: { outcome: "filled", submit: "clicked" },
  });
  expect(stepAnswer(run.requests[3], "fill_2")).toMatchObject({
    step: { outcome: "refused", reason: "credential_already_filled" },
  });
  expect(site.fills()).toBe(2);
});

it("a blocked screen whose password the dismiss emptied publishes that screen once, with its dismiss, as the host's", async () => {
  const site = coveredSite({ reloads: true });
  const run = await fixture(
    (_request, index) =>
      [
        authenticate("fill", passwordScreen),
        authenticate("again", { ...passwordScreen, dismiss: accept }),
        authenticate("check", { signedIn: { selector: "#account" } }),
      ][index] ?? stop,
    site.dependencies,
    { effect: "read", siteOrigin: origin },
  );
  await run.run();
  expect(stepAnswer(run.requests[3], "check")).toMatchObject({ signedIn: true });
  expect(site.fills()).toBe(2);
  const recipe = site.published()?.recipe;
  expect(recipe).toMatchObject({ version: 6 });
  expect(recipe?.steps).toEqual([
    expect.objectContaining({ submit: "#sign-in", dismiss: accept, submittedBy: "host" }),
  ]);
});
