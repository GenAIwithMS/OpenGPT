import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, expect } from "@playwright/test";
import { chromium } from "playwright";
import { Effect, Either, Schema } from "effect";
import { defineOperation } from "../../src/browser/index.js";
import { expectedConfirmDigest } from "../../src/browser/dialogs/expected.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeRunDialogDecider } from "../../src/inputs/dialog.js";
import { noIncidents } from "../../src/runtime/incidents.js";
import { InputRequestFailure, type InputRequest } from "../../src/runtime/input-request.js";
import { createBrowserEngine } from "../../src/standalone/engine.js";
import { RunOutcomeFailure } from "../../src/standalone/run-report.js";
import {
  call,
  executionIdOf,
  recordingGuardian,
  toolResult,
  writePath,
} from "./guardian-context-fixture.js";
import { act, mint } from "./standalone-mint-fixture.js";
import { runExample } from "./authoring-fixture.js";
import {
  confirmPopupCases,
  confirmPopupContractFailures,
  confirmPopupOutcomes,
  confirmPopupsOrigin,
  recordedConfirmPopups,
  serveConfirmPopups,
  type ConfirmPopupCaseName,
  type ConfirmPopupObservation,
} from "../support/confirm-popups-contract.js";

const orderHost = "www.order.test";

/**
 * A controlled HTTPS order page: its Place button raises a native confirm with `message`, where
 * `{name}` stands for the order name typed in the page, and only an accepted confirm posts the
 * order and shows "Order placed".
 */
const startOrderSite = async (directory: string) => {
  await promisify(execFile)("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(directory, "key.pem"),
    "-out",
    join(directory, "cert.pem"),
    "-subj",
    `/CN=${orderHost}`,
    "-days",
    "1",
  ]);
  const state = { message: "Place this order?", orders: 0 };
  const server = createServer(
    {
      key: await readFile(join(directory, "key.pem")),
      cert: await readFile(join(directory, "cert.pem")),
    },
    (request, response) => {
      if (request.method === "POST") {
        state.orders += 1;
        response.end("placed");
        return;
      }
      response.setHeader("Content-Type", "text/html");
      response.end(
        `<title>Order</title><input id="name"><button id="place">Place order</button><script>
document.querySelector("#place").onclick = () => {
  const name = document.querySelector("#name").value;
  if (confirm(${JSON.stringify(state.message)}.replaceAll("{name}", name)))
    fetch("/order", { method: "POST" }).then(() => {
      document.body.innerHTML = "<div id=placed>Order placed</div>";
    });
};
</script>`,
      );
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No order address");
  const browser = await chromium.launchServer({
    args: [
      `--host-resolver-rules=MAP ${orderHost} 127.0.0.1`,
      "--no-proxy-server",
      "--ignore-certificate-errors",
    ],
  });
  return {
    url: `https://${orderHost}:${address.port}/`,
    state,
    browser,
    close: async () => {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

/**
 * A write step that clicks Place, reports the confirm to decideDialog as step `place-order`,
 * applies the decision and reads the confirmation back.
 */
const placeOrder = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"place_order",input:Schema.Struct({}),output:Schema.Struct({placed:Schema.Boolean}),write:{confirmation:"message",commits:["place"]}},
async ({kernel,sessionId,decideDialog,enteringCommit,verified}) => {
  const raised = await kernel.browsers.playwright.execute(sessionId,{code:"const shown = new Promise((resolve) => page.once('dialog', (dialog) => { globalThis.dialog = dialog; resolve({ type: dialog.type(), message: dialog.message(), url: page.url() }); })); void page.locator('#place').click().catch(() => {}); return await shown;",timeout_sec:10});
  if(!raised.success) throw new Error("No confirm");
  const decision = await decideDialog({step:"place-order",...raised.result});
  enteringCommit("place");
  const answered = await kernel.browsers.playwright.execute(sessionId,{code:decision.choice === "accept" ? "await globalThis.dialog.accept(); await page.locator('#placed').waitFor(); return true;" : "await globalThis.dialog.dismiss(); return false;",timeout_sec:10});
  if(!answered.success) throw new Error("Order not confirmed");
  if(answered.result === true) verified({confirmation:"message"});
  return {placed:answered.result === true};
});`;

/** The order write for a named order: it types the input's name before it clicks Place. */
const placeNamedOrder = placeOrder
  .replace("input:Schema.Struct({})", "input:Schema.Struct({name:Schema.String})")
  .replace("async ({kernel,sessionId,", "async ({input,kernel,sessionId,")
  .replace(
    "const raised = ",
    "await kernel.browsers.playwright.execute(sessionId,{code:`await page.locator('#name').fill(${JSON.stringify(input.name)});`,timeout_sec:10});\n  const raised = ",
  );

/** The question a native dialog puts to the owner, while building, or the caller, in a run. */
const dialogQuestion = (request: InputRequest) =>
  request.questions.some(
    (question) => question.prompt.includes("respond to this dialog") || question.id === "decision",
  );
/** The answer to a dialog question: a build's choice, or a run's yes or no. */
const dialogAnswer = (request: InputRequest, choice: "accept" | "dismiss") =>
  request.questions.some((question) => question.id === "decision")
    ? { decision: { confirmed: choice === "accept" } }
    : { choice };

/** Mints the order write, the owner accepting its confirm, and returns the published artifact. */
const mintOrder = async (
  site: Awaited<ReturnType<typeof startOrderSite>>,
  named?: { readonly name: string },
) => {
  const { built, asked } = await mint({
    effect: "write",
    url: site.url,
    intent: "Place the order",
    guardian: recordingGuardian(),
    browser: { endpoint: site.browser.wsEndpoint() },
    answer: (request) => (dialogQuestion(request) ? { choice: "accept" } : {}),
    turns: [
      () => [
        {
          type: "apply_patch_call",
          callId: "patch_order",
          status: "completed",
          operation: {
            type: "create_file",
            path: "src/order.mjs",
            diff: `${(named === undefined ? placeOrder : placeNamedOrder)
              .split("\n")
              .map((line) => `+${line}`)
              .join("\n")}\n`,
          },
        },
      ],
      () => [call("execute", act("src/order.mjs", named ?? {}, writePath("place")), "place")],
      (request) => [
        call(
          "finish_build",
          {
            intent: "Return the order write without running it",
            entrypoint: "src/order.mjs",
            executionId: executionIdOf(request, "place"),
            metadata: { name: "place_order", description: "Place the order once" },
            coverage: "One confirmed act session that accepted the order confirm",
          },
          "publish",
        ),
      ],
    ],
  });
  expect(built.build, JSON.stringify(built)).toBe("published");
  expect(asked.filter(dialogQuestion)).toHaveLength(1);
  if (built.artifact === undefined) throw new Error(JSON.stringify(built));
  return built.artifact;
};

/** Runs the artifact as a write, answering every dialog question with `choice`. */
const runOrder = async (
  site: Awaited<ReturnType<typeof startOrderSite>>,
  artifact: Awaited<ReturnType<typeof mintOrder>>,
  choice: "accept" | "dismiss",
  input: Record<string, unknown> = {},
) => {
  const asked: InputRequest[] = [];
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* createBrowserEngine({
          browser: { endpoint: site.browser.wsEndpoint() },
          ask: makeInputAsker((request) =>
            Effect.sync(() => {
              asked.push(request);
              return dialogQuestion(request) ? dialogAnswer(request, choice) : {};
            }),
          ),
          timeoutMs: 60_000,
        });
        return yield* service.run(artifact, {
          url: site.url,
          intent: "Place the order",
          effect: "write",
          input,
        });
      }),
    ).pipe(Effect.either),
  );
  return { result, asked: asked.filter(dialogQuestion) };
};

const withOrderSite = async (
  use: (site: Awaited<ReturnType<typeof startOrderSite>>) => Promise<void>,
) => {
  const directory = await mkdtemp(join(tmpdir(), "opengpt-confirm-"));
  const site = await startOrderSite(directory);
  try {
    await use(site);
  } finally {
    await site.close();
    await rm(directory, { recursive: true, force: true });
  }
};

test("a write's run accepts the confirm its build accepted, and asks about a changed one", async () => {
  test.setTimeout(120_000);
  await withOrderSite(async (site) => {
    const artifact = await mintOrder(site);
    expect(site.state.orders).toBe(1);
    // The build kept the confirm the owner accepted as a digest of its message, origin and step.
    expect(artifact.acceptedConfirms).toEqual([
      expectedConfirmDigest({
        message: "Place this order?",
        origin: new URL(site.url).origin,
        step: "place-order",
      }),
    ]);
    const run = await runOrder(site, artifact, "dismiss");
    expect(run.result).toEqual(Either.right({ placed: true }));
    expect(run.asked).toEqual([]);
    expect(site.state.orders).toBe(2);
    // The page now asks something else at the same step: the caller decides, and dismisses.
    site.state.message = "Place this order and subscribe?";
    const changed = await runOrder(site, artifact, "dismiss");
    // The script entered its declared commit before the confirm and records no confirmation
    // after the dismissal, so the run reports the write as possibly applied, keeping its output.
    const declined = Either.isLeft(changed.result) ? changed.result.left : undefined;
    if (!(declined instanceof RunOutcomeFailure)) throw new Error(JSON.stringify(changed.result));
    expect(declined.outcome).toMatchObject({
      code: "outcome_unknown",
      writeStatus: "may_have_applied",
      possibleCommit: true,
    });
    expect(declined.unconfirmed).toEqual({ output: { placed: false } });
    expect(changed.asked).toHaveLength(1);
    expect(changed.asked[0]?.questions[0]?.prompt).toBe(
      'The website asks you to confirm: "Place this order and subscribe?". Confirm?',
    );
    expect(site.state.orders).toBe(2);
  });
});

test("a write's run accepts the confirm its build accepted when it names the run's own order", async () => {
  test.setTimeout(120_000);
  await withOrderSite(async (site) => {
    site.state.message = "Place order {name}?";
    const artifact = await mintOrder(site, { name: "Spring Order 1001" });
    expect(site.state.orders).toBe(1);
    // The confirm named the order the build's input gave, so the record keeps no order name.
    expect(artifact.acceptedConfirms).toHaveLength(1);
    expect(JSON.stringify(artifact)).not.toContain("Spring Order 1001?");
    const run = await runOrder(site, artifact, "dismiss", { name: "Summer Order 2002" });
    expect(run.result).toEqual(Either.right({ placed: true }));
    expect(run.asked).toEqual([]);
    expect(site.state.orders).toBe(2);
    // The same confirm with other wording still asks the caller.
    site.state.message = "Place order {name} and subscribe?";
    const changed = await runOrder(site, artifact, "dismiss", { name: "Summer Order 2002" });
    expect(changed.asked).toHaveLength(1);
    expect(site.state.orders).toBe(2);
  });
});

test("a write whose composed script raises its accepted confirm under another step is not published", async () => {
  test.setTimeout(120_000);
  await withOrderSite(async (site) => {
    const created = (path: string, content: string) => ({
      type: "apply_patch_call" as const,
      callId: `patch_${path}`,
      status: "completed" as const,
      operation: {
        type: "create_file" as const,
        path,
        diff: `${content
          .split("\n")
          .map((line) => `+${line}`)
          .join("\n")}\n`,
      },
    });
    const { built, last } = await mint({
      effect: "write",
      url: site.url,
      intent: "Place the order",
      guardian: recordingGuardian(),
      browser: { endpoint: site.browser.wsEndpoint() },
      answer: (request) => (dialogQuestion(request) ? { choice: "accept" } : {}),
      turns: [
        () => [
          created("src/order.mjs", placeOrder),
          created(
            "src/composed.mjs",
            placeOrder.replace('step:"place-order"', 'step:"submit-order"'),
          ),
        ],
        () => [call("execute", act("src/order.mjs", {}, writePath("place")), "place")],
        (request) => [
          call(
            "finish_build",
            {
              intent: "Return the order write without running it",
              entrypoint: "src/composed.mjs",
              executionId: executionIdOf(request, "place"),
              metadata: { name: "place_order", description: "Place the order once" },
              coverage: "One confirmed act session that accepted the order confirm",
            },
            "publish",
          ),
        ],
      ],
    });
    expect(site.state.orders).toBe(1);
    // A run would see the confirm under step submit-order and never match the record, so the
    // build refuses the composed script, as another host's does.
    expect(toolResult(last, "publish")).toMatchObject({
      status: "not_published",
      reason: "confirm_action_unmatched",
      confirmActionIds: ["place-order"],
    });
    expect(built.build).not.toBe("published");
  });
});

/**
 * Clicks the case's button as step `step`, inside its frame when it has one, and reports each of
 * its `raises` confirms, as a generated script does. It listens for the next confirm before it
 * answers the current one, so a confirm raised right after another is reported too.
 */
const clickAsStep = defineOperation(
  {
    name: "confirm_popup_case",
    input: Schema.Struct({
      selector: Schema.String,
      frame: Schema.optional(Schema.String),
      step: Schema.String,
      raises: Schema.Number,
    }),
    output: Schema.Array(Schema.Literal("accept", "dismiss", "unreported")),
  },
  async ({ kernel, sessionId, input, decideDialog }) => {
    const listen = `globalThis.nextDialog = new Promise((resolve) => page.once("dialog", (dialog) => {
      globalThis.dialog = dialog;
      resolve({ type: dialog.type(), message: dialog.message(), url: page.url() });
    }));`;
    const reported = `return await Promise.race([
      globalThis.nextDialog,
      new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);`;
    const target =
      input.frame === undefined ? "page" : `page.frameLocator(${JSON.stringify(input.frame)})`;
    const choices: ("accept" | "dismiss" | "unreported")[] = [];
    for (let index = 0; index < input.raises; index++) {
      const raised = await kernel.browsers.playwright.execute(sessionId, {
        timeout_sec: 10,
        code:
          index === 0
            ? `${listen}
               void ${target}.locator(${JSON.stringify(input.selector)}).click().catch(() => {});
               ${reported}`
            : reported,
      });
      if (!raised.success) throw new Error(String(raised.error));
      const shown = Schema.decodeUnknownSync(
        Schema.NullOr(
          Schema.Struct({
            type: Schema.Literal("alert", "confirm", "prompt", "beforeunload"),
            message: Schema.String,
            url: Schema.String,
          }),
        ),
      )(raised.result);
      if (shown === null) {
        choices.push("unreported");
        break;
      }
      const decision = await decideDialog({ step: input.step, ...shown });
      const answer = decision.choice === "accept" ? "accept()" : "dismiss()";
      const answered = await kernel.browsers.playwright.execute(sessionId, {
        timeout_sec: 10,
        code: `const current = globalThis.dialog;
               ${index + 1 < input.raises ? listen : ""}
               await current.${answer};`,
      });
      if (!answered.success) throw new Error(String(answered.error));
      choices.push(decision.choice);
    }
    return choices;
  },
);

test("the local run keeps the confirm popup contract", async ({ context }) => {
  test.setTimeout(90_000);
  await serveConfirmPopups(context);
  const observed = new Map<ConfirmPopupCaseName, ConfirmPopupObservation>();
  for (const entry of confirmPopupCases) {
    const page = await context.newPage();
    await page.goto(confirmPopupsOrigin);
    let asked = 0;
    // A caller who never answers: the question's window ends unanswered.
    const ask = makeInputAsker((request) => {
      if (dialogQuestion(request)) asked += 1;
      return Effect.fail(new InputRequestFailure({ code: "NoResponse" }));
    });
    const { result } = await runExample(
      page,
      clickAsStep,
      {
        selector: entry.selector,
        ...(entry.frame === undefined ? {} : { frame: entry.frame }),
        step: entry.step,
        raises: entry.raises,
      },
      {
        siteOrigin: confirmPopupsOrigin,
        dialogs: makeRunDialogDecider({
          ask,
          project: String,
          readOnly: entry.readOnly === true,
          expectedConfirms: recordedConfirmPopups,
          incidents: noIncidents,
        }),
      },
    );
    expect(Either.isRight(result), JSON.stringify(result)).toBe(true);
    observed.set(entry.name, { outcomes: await confirmPopupOutcomes(page, entry.name), asked });
    await page.close();
  }
  expect(Object.fromEntries(observed)).toEqual({
    recorded: { outcomes: ["accepted"], asked: 0 },
    repeated: { outcomes: ["accepted", "dismissed"], asked: 1 },
    unrecorded: { outcomes: ["dismissed"], asked: 1 },
    other_step: { outcomes: ["dismissed"], asked: 1 },
    iframe: { outcomes: ["dismissed"], asked: 1 },
    // The script reports the top page's address, so the other site's frame counts as the page.
    cross_origin_frame: { outcomes: ["accepted"], asked: 0 },
    // No script listens to the new window, so the browser dismisses its confirm.
    popup: { outcomes: ["dismissed"], asked: 0 },
    // A read run confirms nothing, so it decides without asking.
    read_only: { outcomes: ["dismissed"], asked: 0 },
  });
  expect(confirmPopupContractFailures(observed)).toEqual([]);
});

test("the confirm popup contract fails a host that accepts or leaves open what it should not", () => {
  const kept: readonly (readonly [ConfirmPopupCaseName, ConfirmPopupObservation])[] = [
    ["recorded", { outcomes: ["accepted"], asked: 0 }],
    ["repeated", { outcomes: ["accepted", "dismissed"], asked: 1 }],
    ["unrecorded", { outcomes: ["dismissed"], asked: 1 }],
    ["other_step", { outcomes: ["dismissed"], asked: 1 }],
    ["iframe", { outcomes: ["dismissed"], asked: 0 }],
    ["cross_origin_frame", { outcomes: ["accepted"], asked: 0 }],
    ["popup", { outcomes: ["dismissed"], asked: 0 }],
    ["read_only", { outcomes: ["dismissed"], asked: 0 }],
  ];
  expect(confirmPopupContractFailures(new Map(kept))).toEqual([]);
  expect(
    confirmPopupContractFailures(
      new Map([
        ...kept,
        ["recorded", { outcomes: ["accepted"], asked: 1 }],
        ["repeated", { outcomes: ["accepted", "accepted"], asked: 0 }],
        ["unrecorded", { outcomes: ["dismissed"], asked: 0 }],
        ["iframe", { outcomes: ["accepted"], asked: 0 }],
        ["popup", { outcomes: ["pending"], asked: 0 }],
        ["read_only", { outcomes: ["accepted"], asked: 0 }],
      ]),
    ),
  ).toEqual([
    "recorded: the recorded confirm must be accepted without asking (accepted, asked 1)",
    "repeated: the recorded confirm is accepted once, then must ask and end dismissed (accepted accepted, asked 0)",
    "unrecorded: an unrecorded confirm in the page must ask the caller first",
    "iframe: a confirm the record does not cover must end dismissed, never accepted",
    "popup: a confirm the record does not cover must end dismissed, never pending",
    "read_only: a confirm the record does not cover must end dismissed, never accepted",
  ]);
  // A host that reads the origin of the frame that showed the dialog must dismiss the other site's.
  expect(confirmPopupContractFailures(new Map(kept), { dialogOrigin: "frame" })).toEqual([
    "cross_origin_frame: a confirm the record does not cover must end dismissed, never accepted",
  ]);
  expect(
    confirmPopupContractFailures(
      new Map([...kept, ["cross_origin_frame", { outcomes: ["dismissed"], asked: 1 }]]),
      { dialogOrigin: "frame" },
    ),
  ).toEqual([]);
  expect(confirmPopupContractFailures(new Map(kept.slice(1)))).toEqual([
    "recorded: the case was not run",
  ]);
});
