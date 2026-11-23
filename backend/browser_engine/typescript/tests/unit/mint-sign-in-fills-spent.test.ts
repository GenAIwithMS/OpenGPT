import { Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import type {
  AutofillInspection,
  AutofillSignedInCheck,
  AutofillStep,
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
 * The host fills a login's password at most twice in one sign-in. Once both fills went out and the
 * site still reads signed out, every further sign-in screen that needs the password is refused:
 * once it refused one, that is a host check refusing the step the build needs, so a host_refused
 * report ends the build as sign-in unavailable instead of being refused while the minter tries
 * recoveries that cannot sign in. Each scenario runs the real minter loop on recorded model responses, with the
 * standalone host's sign-in recorder over a synthetic site that never signs in.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);

const origin = "https://member.example.test";
const login = { username: "synthetic-owner", password: "synthetic-password" };
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
 * A synthetic site whose sign-in never completes: each fill types the fields and clicks the
 * submit, and the page stays on its login screen. `fills` counts the fills that reached the page.
 */
const signedOutSite = () => {
  let fills = 0;
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
          return {
            outcome: "filled" as const,
            fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
            submit: "clicked" as const,
            url: `${origin}/login`,
          };
        }),
      confirm: () =>
        Effect.succeed<AutofillSignedInCheck>({
          signedIn: false,
          failed: "indicator_not_visible",
          url: `${origin}/login`,
        }),
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
      const step = yield* recorder.step(signIn, undefined, beforeDispatch(hostAuthentication));
      return {
        executionId: `sign_in_${executions}`,
        status: "completed" as const,
        effect: "possible" as const,
        observations: { step: step.report, ...step.result },
      };
    }).pipe(Effect.mapError(mintError));
  return {
    fills: () => fills,
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
const authenticate = (callId: string) =>
  call("execute", callId, {
    purpose: "authenticate",
    target: "liveBrowser",
    entrypoint: "src/tool.ts",
    fixtureRefs: [],
    caseFilter: [],
    maxWorkers: 1,
    timeoutSeconds: 30,
    signInStep: passwordScreen,
  });
const hostRefused = (callId: string) =>
  call("report_blocked", callId, {
    reason: "host_refused",
    explanation: "The host will not fill the password again, so the site cannot be signed in.",
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

/** The tool answer the model read for `callId`. */
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
/** What a sign-in step's answer for `callId` observed: the screen's report and the next step. */
const stepAnswer = (request: ModelRequest | undefined, callId: string) => {
  const { observations } = answerTo(request, callId);
  return typeof observations === "string" ? (JSON.parse(observations) as unknown) : observations;
};

it("ends a host_refused report as sign-in unavailable once both password fills are spent", async () => {
  const site = signedOutSite();
  const run = await fixture(
    (_request, index) =>
      [
        authenticate("fill_1"),
        authenticate("fill_2"),
        authenticate("fill_3"),
        hostRefused("report"),
      ][index] ?? stop,
    site.dependencies,
    { effect: "read", siteOrigin: origin },
  );
  const outcome = await run.run();
  // Both fills reached the page; the third screen was refused and typed nothing.
  expect(site.fills()).toBe(2);
  expect(stepAnswer(run.requests[3], "fill_3")).toMatchObject({
    step: { outcome: "refused", reason: "credential_already_filled" },
  });
  // The report ended the build at once, with no further model call.
  expect(run.requests).toHaveLength(4);
  expect(outcome).not.toHaveProperty("blocked");
  expect(outcome).toMatchObject({
    build: "incomplete",
    recoveryReason: "sign_in_unavailable",
  });
  // The login reached the site twice and neither sign-in confirmed, so sign-in is what failed;
  // the record still names the refused refill the report stood on.
  const records = outcome.diagnostics.flatMap((entry) => {
    try {
      return [JSON.parse(entry) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
  expect(records).toContainEqual(
    expect.objectContaining({
      phase: "blocked",
      reason: "sign_in_unavailable",
      reported: "host_refused",
      hostRefusals: [{ source: "sign_in_refill" }],
    }),
  );
});

it("refuses a host_refused report while a password fill remains, and the next screen still fills", async () => {
  const site = signedOutSite();
  const run = await fixture(
    (_request, index) =>
      [authenticate("fill_1"), hostRefused("report"), authenticate("fill_2")][index] ?? stop,
    site.dependencies,
    { effect: "read", siteOrigin: origin },
  );
  const outcome = await run.run();
  expect(answerTo(run.requests[2], "report")).toMatchObject({
    status: "blocked_refused",
    reason: "host_not_refused",
  });
  // The minter signed in again, and the host filled the password a second time.
  expect(site.fills()).toBe(2);
  expect(stepAnswer(run.requests[3], "fill_2")).toMatchObject({
    step: { outcome: "filled", submit: "clicked" },
  });
  expect(outcome).not.toMatchObject({ recoveryReason: "sign_in_unavailable" });
});

// Spent fills alone are no refusal: the second fill may have signed in, or led to a code screen,
// so a host_refused report before the host refused any screen is refused as before.
it("refuses a host_refused report once both fills went out but no screen was refused", async () => {
  const site = signedOutSite();
  const run = await fixture(
    (_request, index) =>
      [authenticate("fill_1"), authenticate("fill_2"), hostRefused("report")][index] ?? stop,
    site.dependencies,
    { effect: "read", siteOrigin: origin },
  );
  const outcome = await run.run();
  expect(site.fills()).toBe(2);
  expect(answerTo(run.requests[3], "report")).toMatchObject({
    status: "blocked_refused",
    reason: "host_not_refused",
  });
  expect(outcome).not.toMatchObject({ recoveryReason: "sign_in_unavailable" });
});
