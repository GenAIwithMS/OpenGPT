import { Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect, Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { refused, withCheck } from "../../src/destinations/autofill-refusal.js";
import type {
  AutofillInspection,
  AutofillRefusal,
  AutofillSignedInCheck,
  AutofillStep,
} from "../../src/destinations/autofill-step.js";
import {
  hostAuthentication,
  MintFailure,
  MintHarnessSnapshot,
  type MintDependencies,
  type SignInStep,
} from "../../src/mint/contracts.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { makeSignInRecorder } from "../../src/mint/sign-in-recorder.js";
import { mintError } from "../../src/standalone/errors.js";
import {
  makeMintContinuationFixture,
  makeMintHarnessFixture,
} from "../support/mint-fixtures.js";
import { portableJobSession } from "../support/portable-mint.js";

/*
 * The host types nothing into a sign-in screen whose field, form or submit would send the login
 * somewhere credentials may not go: its destination check refuses the screen before typing, and
 * the refusal comes back as the step's result, not as a failure. No change to the step's selectors
 * gets past that check, so a host_refused report stands on it and ends the build as the host's
 * refusal, instead of being refused while the minter tries recoveries that cannot pass it. A
 * refusal the minter can correct, such as a selector that found nothing, is no host refusal, and a
 * later screen that passed the check clears it. Each scenario runs the real minter loop on recorded
 * model responses, with the standalone host's sign-in recorder over a synthetic site.
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

/** The site's sign-in form, whose form posts the login to another site's host. */
const outsideForm = "#outside-password";
/** A selector the page shows nothing for. */
const missingField = "#missing-password";

/** The host's inspection of a screen, by the password field the step names. */
const inspection = (step: AutofillStep): AutofillInspection | AutofillRefusal => {
  const passwordField = step.fields.find((field) => field.slot === "password")?.selector;
  if (passwordField === outsideForm)
    return withCheck(refused("credential_target_refused", 0), "destination", {
      part: "form_action",
    });
  if (passwordField === missingField) return withCheck(refused("not_found", 1), "not_found");
  return {
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
  };
};

/**
 * A synthetic site whose sign-in never completes: a screen that passes the host's inspection is
 * filled and submitted, and the page stays on its login screen. `fills` counts the fills that
 * reached the page.
 */
const signInSite = () => {
  let fills = 0;
  const recorder = makeSignInRecorder({
    browser: {
      inspect: (step: AutofillStep) => Effect.succeed(inspection(step)),
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
        // A screen refused before anything was typed sent nothing, as a hosted host reports it.
        effect: step.report?.outcome === "refused" ? ("not_sent" as const) : ("possible" as const),
        observations: { step: step.report, ...step.result },
      };
    }).pipe(Effect.mapError(mintError));
  return {
    fills: () => fills,
    dependencies: {
      autofillSignIn: true,
      reviewAndExecute,
      signInDestinationRefused: () => recorder.destinationRefused(),
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
/** A sign-in screen whose password field is `passwordField`. */
const screen = (passwordField: string): SignInStep => ({
  fields: [
    { selector: "#user", accepts: ["username"] },
    { selector: passwordField, slot: "password" },
  ],
  submit: "#sign-in",
});
const authenticateStep = {
  purpose: "authenticate",
  target: "liveBrowser",
  entrypoint: "src/tool.ts",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 30,
} as const;
const authenticate = (callId: string, passwordField: string) =>
  call("execute", callId, { ...authenticateStep, signInStep: screen(passwordField) });
const hostRefusedReport = {
  reason: "host_refused",
  explanation:
    "The host would not type the login into the site's sign-in form, because the form sends it to another site.",
} as const;
const hostRefused = (callId: string) => call("report_blocked", callId, hostRefusedReport);
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

/** The outcome's diagnostics that are JSON records. */
const diagnosticsOf = (outcome: { readonly diagnostics?: readonly string[] }) =>
  (outcome.diagnostics ?? []).flatMap((entry) => {
    try {
      return [JSON.parse(entry) as Record<string, unknown>];
    } catch {
      return [];
    }
  });

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

it("ends a host_refused report as the host's refusal once the host refused a screen at its destination check", async () => {
  const site = signInSite();
  const run = await fixture(
    (_request, index) =>
      [authenticate("outside", outsideForm), hostRefused("report")][index] ?? stop,
    site.dependencies,
    { effect: "read", siteOrigin: origin },
  );
  const outcome = await run.run();
  // The screen was refused before anything was typed, as a step result.
  expect(site.fills()).toBe(0);
  expect(stepAnswer(run.requests[1], "outside")).toMatchObject({
    step: { outcome: "refused", reason: "credential_target_refused" },
  });
  // The report ended the build at once, with no further model call.
  expect(run.requests).toHaveLength(2);
  expect(outcome).toMatchObject({
    build: "incomplete",
    blocked: { reason: "host_refused" },
    stopReason: "host_refused",
  });
});

// A sign-in that already sent the login and never confirmed would end any other report as sign-in
// unavailable, but a host_refused report keeps its reason: the host's own check refused the next
// screen, and the ending says so, with which check it stood on.
it("keeps a host_refused report as the host's refusal after an unconfirmed sign-in sent the login", async () => {
  const site = signInSite();
  const run = await fixture(
    (_request, index) =>
      [authenticate("first", "#password"), authenticate("outside", outsideForm), hostRefused("report")][
        index
      ] ?? stop,
    site.dependencies,
    { effect: "read", siteOrigin: origin },
  );
  const outcome = await run.run();
  expect(site.fills()).toBe(1);
  expect(outcome).toMatchObject({
    build: "incomplete",
    blocked: { reason: "host_refused" },
    stopReason: "host_refused",
  });
  expect(outcome).not.toHaveProperty("recoveryReason");
  expect(diagnosticsOf(outcome)).toContainEqual(
    expect.objectContaining({
      phase: "blocked",
      reason: "host_refused",
      hostRefusals: [{ source: "sign_in_destination" }],
    }),
  );
});

it("refuses a host_refused report when the only refusal was a selector the minter can correct", async () => {
  const site = signInSite();
  const run = await fixture(
    (_request, index) =>
      [authenticate("missing", missingField), hostRefused("report")][index] ?? stop,
    site.dependencies,
    { effect: "read", siteOrigin: origin },
  );
  const outcome = await run.run();
  expect(stepAnswer(run.requests[1], "missing")).toMatchObject({
    step: { outcome: "refused", reason: "not_found" },
  });
  expect(answerTo(run.requests[2], "report")).toMatchObject({
    status: "blocked_refused",
    reason: "host_not_refused",
  });
  expect(outcome).not.toHaveProperty("blocked");
});

// A selector that found nothing after the refused form leaves the refused form as it was, so the
// report still stands on it.
it("keeps a destination refusal through a later refusal the minter can correct", async () => {
  const site = signInSite();
  const run = await fixture(
    (_request, index) =>
      [
        authenticate("outside", outsideForm),
        authenticate("missing", missingField),
        hostRefused("report"),
      ][index] ?? stop,
    site.dependencies,
    { effect: "read", siteOrigin: origin },
  );
  const outcome = await run.run();
  expect(run.requests).toHaveLength(3);
  expect(outcome).toMatchObject({ blocked: { reason: "host_refused" } });
});

// The minter found another sign-in form on the site that passed the check, and the host typed into
// it: the refused form no longer stops the build.
it("refuses a host_refused report once a later screen passed the destination check", async () => {
  const site = signInSite();
  const run = await fixture(
    (_request, index) =>
      [
        authenticate("outside", outsideForm),
        authenticate("own_form", "#password"),
        hostRefused("report"),
      ][index] ?? stop,
    site.dependencies,
    { effect: "read", siteOrigin: origin },
  );
  const outcome = await run.run();
  expect(site.fills()).toBe(1);
  expect(answerTo(run.requests[3], "report")).toMatchObject({
    status: "blocked_refused",
    reason: "host_not_refused",
  });
  expect(outcome).not.toMatchObject({ blocked: { reason: "host_refused" } });
});

// A screen that takes no password or code, such as the site's own identifier screen, says nothing
// about where the login's password would go, so passing the check leaves the refused form standing.
it("keeps a destination refusal through a later identifier screen that passed the check", async () => {
  const site = signInSite();
  const identifierScreen: SignInStep = {
    fields: [{ selector: "#user", accepts: ["username"] }],
    submit: "#continue",
  };
  const run = await fixture(
    (_request, index) =>
      [
        authenticate("outside", outsideForm),
        call("execute", "identifier", { ...authenticateStep, signInStep: identifierScreen }),
        hostRefused("report"),
      ][index] ?? stop,
    site.dependencies,
    { effect: "read", siteOrigin: origin },
  );
  const outcome = await run.run();
  // The identifier screen passed and was sent; the report still stood on the refused form and
  // ended the build at once as the host's refusal, though the identifier went out unconfirmed.
  expect(site.fills()).toBe(1);
  expect(run.requests).toHaveLength(3);
  expect(outcome).toMatchObject({ build: "incomplete", blocked: { reason: "host_refused" } });
});

const scripted = makeMintHarnessFixture(
  cleanups,
  { mode: "mint", intent: "Read the account page", businessInput: {}, observations: [] },
  portableJobSession,
);
const freshAgent = {
  version: 1,
  sdkVersion: "0.18.0",
  sdkState: "",
  modelCalls: 0,
  finalsWithoutTool: 0,
  tools: [],
} as const;

/**
 * The reply to a takeover's host_refused report after its predecessor's host refused a sign-in
 * screen at its destination check, from the predecessor's checkpoint as `edit` leaves it. The
 * takeover's host is new and has refused nothing.
 */
const hostRefusedAfterTakeover = async (edit: (checkpoint: Record<string, unknown>) => void) => {
  let capture: (() => MintHarnessSnapshot) | undefined;
  const site = signInSite();
  const first = await scripted(
    (turn) =>
      Effect.asVoid(
        turn.actions.execute({ ...authenticateStep, signInStep: screen(outsideForm) }),
      ),
    {
      ...site.dependencies,
      agentRecovery: {
        bindHarness: (bound) =>
          Effect.sync(() => {
            capture = bound;
          }),
        save: () => Effect.void,
      },
    },
  );
  await first.run();
  const checkpoint = JSON.parse(JSON.stringify(capture?.())) as Record<string, unknown>;
  edit(checkpoint);
  const harness = Schema.decodeUnknownSync(MintHarnessSnapshot)(checkpoint);
  const replies: unknown[] = [];
  const takeover = await scripted(
    (turn) =>
      Effect.gen(function* () {
        const reportBlocked = turn.actions.reportBlocked;
        if (reportBlocked === undefined) throw new Error("Missing report_blocked");
        replies.push(JSON.parse(yield* reportBlocked(hostRefusedReport)));
      }),
    {
      ...signInSite().dependencies,
      agentRecovery: { initial: { agent: freshAgent, harness }, save: () => Effect.void },
    },
  );
  await takeover.run();
  return replies;
};

// The checkpoint keeps the host's latest answer, so a successor whose host kept no record of the
// refusal still ends the build on it; a checkpoint from an older worker, which kept none, grants no
// host_refused ending.
it.each([
  { checkpoint: "this worker's", edit: () => undefined, status: "blocked" },
  {
    checkpoint: "an older worker's",
    edit: (checkpoint: Record<string, unknown>) => {
      delete checkpoint["signInDestinationRefused"];
    },
    status: "blocked_refused",
  },
])(
  "keeps a destination refusal across a takeover from $checkpoint checkpoint",
  async ({ edit, status }) => {
    expect(await hostRefusedAfterTakeover(edit)).toEqual([expect.objectContaining({ status })]);
  },
);

/**
 * A takeover's host_refused report after its predecessor's host refused a sign-in step outright,
 * having typed nothing, from the predecessor's checkpoint as `edit` leaves it: the reply, and the
 * takeover's outcome.
 */
const afterRefusedSignInTakeover = async (edit: (checkpoint: Record<string, unknown>) => void) => {
  let capture: (() => MintHarnessSnapshot) | undefined;
  const refusedSignIn = new MintFailure({
    code: "Unavailable",
    authentication: {
      phase: "credential_submit",
      code: "CredentialTargetRefused",
      nothingSubmitted: true,
    },
  });
  const first = await scripted(
    (turn) =>
      Effect.asVoid(
        Effect.either(turn.actions.execute({ ...authenticateStep, signInStep: screen("#password") })),
      ),
    {
      autofillSignIn: true,
      reviewAndExecute: () => Effect.fail(refusedSignIn),
      agentRecovery: {
        bindHarness: (bound) =>
          Effect.sync(() => {
            capture = bound;
          }),
        save: () => Effect.void,
      },
    },
  );
  await first.run();
  const checkpoint = JSON.parse(JSON.stringify(capture?.())) as Record<string, unknown>;
  edit(checkpoint);
  const harness = Schema.decodeUnknownSync(MintHarnessSnapshot)(checkpoint);
  const replies: unknown[] = [];
  const takeover = await scripted(
    (turn) =>
      Effect.gen(function* () {
        const reportBlocked = turn.actions.reportBlocked;
        if (reportBlocked === undefined) throw new Error("Missing report_blocked");
        replies.push(JSON.parse(yield* reportBlocked(hostRefusedReport)));
      }),
    {
      ...signInSite().dependencies,
      agentRecovery: { initial: { agent: freshAgent, harness }, save: () => Effect.void },
    },
  );
  const outcome = await takeover.run();
  return { checkpoint, replies, outcome };
};

// A takeover keeps which host check refused the step, and a checkpoint from an older worker, which
// kept the refusal without it, names it `unrecorded`. A source a later release adds, which this
// worker cannot read, restores as unrecorded too, and never fails the checkpoint's decode.
it.each([
  {
    checkpoint: "this worker's",
    edit: () => undefined,
    recorded: { source: "sign_in_step", code: "CredentialTargetRefused" },
  },
  {
    checkpoint: "an older worker's",
    edit: (checkpoint: Record<string, unknown>) => {
      delete checkpoint["hostRefusalSources"];
    },
    recorded: { source: "unrecorded" },
  },
  {
    checkpoint: "a later release's",
    edit: (checkpoint: Record<string, unknown>) => {
      checkpoint["hostRefusalSources"] = [
        { refusal: { source: "a_later_check", code: "LaterCode" } },
      ];
    },
    recorded: { source: "unrecorded" },
  },
])(
  "records the host check a host_refused ending stood on across a takeover from $checkpoint checkpoint",
  async ({ edit, recorded }) => {
    const { checkpoint, replies, outcome } = await afterRefusedSignInTakeover(edit);
    expect(checkpoint["hostRefused"]).toBe(true);
    expect(replies).toEqual([expect.objectContaining({ status: "blocked" })]);
    expect(
      diagnosticsOf(outcome as { readonly diagnostics?: readonly string[] }),
    ).toContainEqual(
      expect.objectContaining({ phase: "blocked", reason: "host_refused", hostRefusals: [recorded] }),
    );
  },
);

/**
 * A takeover's reply to a host_refused report after its predecessor's host refused a sign-in step,
 * typing nothing, and a later screen then sent the login, which nothing confirmed; from the
 * predecessor's checkpoint as `edit` leaves it.
 */
const afterLoginSentTakeover = async (edit: (checkpoint: Record<string, unknown>) => void) => {
  let capture: (() => MintHarnessSnapshot) | undefined;
  let executions = 0;
  const refusedSignIn = new MintFailure({
    code: "Unavailable",
    authentication: {
      phase: "credential_submit",
      code: "CredentialTargetRefused",
      nothingSubmitted: true,
    },
  });
  const first = await scripted(
    (turn) =>
      Effect.gen(function* () {
        for (const field of ["#outside", "#password"])
          yield* Effect.either(
            turn.actions.execute({ ...authenticateStep, signInStep: screen(field) }),
          );
      }),
    {
      autofillSignIn: true,
      reviewAndExecute: (_execution, beforeDispatch = () => Effect.void) =>
        executions++ === 0
          ? Effect.fail(refusedSignIn)
          : beforeDispatch(hostAuthentication).pipe(
              Effect.as({
                executionId: "sign_in_sent",
                status: "completed" as const,
                effect: "possible" as const,
                observations: { step: { outcome: "filled", submit: "clicked" } },
              }),
            ),
      agentRecovery: {
        bindHarness: (bound) =>
          Effect.sync(() => {
            capture = bound;
          }),
        save: () => Effect.void,
      },
    },
  );
  await first.run();
  const checkpoint = JSON.parse(JSON.stringify(capture?.())) as Record<string, unknown>;
  edit(checkpoint);
  const harness = Schema.decodeUnknownSync(MintHarnessSnapshot)(checkpoint);
  const replies: unknown[] = [];
  const takeover = await scripted(
    (turn) =>
      Effect.gen(function* () {
        const reportBlocked = turn.actions.reportBlocked;
        if (reportBlocked === undefined) throw new Error("Missing report_blocked");
        replies.push(JSON.parse(yield* reportBlocked(hostRefusedReport)));
      }),
    {
      ...signInSite().dependencies,
      agentRecovery: { initial: { agent: freshAgent, harness }, save: () => Effect.void },
    },
  );
  await takeover.run();
  return { checkpoint, replies };
};

// The checkpoint keeps that a login went out after the host's refusal, so a successor ends the
// report as sign-in unavailable, as its predecessor would have; without that mark, the refusal
// would read as the latest sign-in event and keep the report's reason.
it.each([
  { checkpoint: "as kept", edit: () => undefined, status: "sign_in_unavailable" },
  {
    checkpoint: "without the mark that a login went out since",
    edit: (checkpoint: Record<string, unknown>) => {
      const sources = checkpoint["hostRefusalSources"] as Record<string, unknown>[];
      for (const source of sources) delete source["beforeSignIn"];
    },
    status: "blocked",
  },
])(
  "ends a takeover's host_refused report after a login sent since a refused sign-in step, from the checkpoint $checkpoint",
  async ({ edit, status }) => {
    const { checkpoint, replies } = await afterLoginSentTakeover(edit);
    expect(checkpoint["signInUnconfirmed"]).toBe(true);
    expect(replies).toEqual([expect.objectContaining({ status })]);
  },
);
