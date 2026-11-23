import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { chromium } from "playwright";
import { Usage } from "@openai/agents";
import type { ModelProvider, ModelRequest, ModelResponse } from "@openai/agents";
import { Effect, Either, Schema } from "effect";
import { createBrowserEngine } from "../../src/standalone/engine.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { InputRequestFailure, type InputRequest } from "../../src/runtime/input-request.js";
import { OwnerCancelled } from "../../src/inputs/terminal.js";
import type { MintArtifact } from "../../src/standalone/contracts.js";
import { readArtifact, writeArtifact } from "../../src/standalone/artifact-files.js";
import { listCursorKeys } from "../../src/runtime/list-cursor.js";
import {
  actionFor,
  authorityOf,
  quietReviewer,
  recordingGuardian,
} from "./guardian-context-fixture.js";
import {
  analyticsHost,
  identityHost,
  startShop,
  shopAccount,
  shopWorkspaces,
  shopCode,
  teamAccounts,
  type Shop,
} from "./shop-fixture.js";

// How a local build signs in, on the shop's one-screen and two-screen sign-ins: what the host
// asks, what the build publishes of its sign-in, what a later run does, what a second screen's
// submit may carry, and what Guardian reads of a screen that shows a typed value. Scripted models
// drive each build.

type Output = ModelResponse["output"];
const call = (name: string, input: unknown, callId = name): Output[number] => ({
  type: "function_call",
  name,
  callId,
  arguments: JSON.stringify(input),
  status: "completed",
});
const message = (text: string): Output[number] => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text }],
});
const objects = (value: unknown): readonly Record<string, unknown>[] => {
  if (typeof value === "string") {
    try {
      return objects(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value.flatMap(objects);
  if (typeof value !== "object" || value === null) return [];
  const record = Schema.decodeUnknownEither(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  )(value);
  return record._tag === "Left"
    ? []
    : [record.right, ...Object.values(record.right).flatMap(objects)];
};
/** Answers each model request with `respond`, keeping every request. */
const provider = (
  respond: (request: ModelRequest, index: number) => Output,
  requests: ModelRequest[] = [],
): ModelProvider => ({
  getModel: () => ({
    getResponse: async (request) => {
      requests.push(request);
      return { usage: new Usage(), output: respond(request, requests.length - 1) };
    },
    getStreamedResponse: () => {
      throw new Error("Fixture does not stream");
    },
  }),
});
/** Allows every review after reading the reviewed source, as the review loop requires. */
const guardian = () => {
  let sourcePending = false;
  return provider((request, index) => {
    const current = objects(request.input)
      .filter((item) => "submitted_call" in item)
      .at(-1);
    if (current !== undefined && "question_review" in current)
      return [message(JSON.stringify({ outcome: "allow_business", rationale: "Fixture" }))];
    if (sourcePending) {
      sourcePending = false;
      return [
        message(
          JSON.stringify({ outcome: "allow", rationale: "Fixture review", ...actionFor(current) }),
        ),
      ];
    }
    sourcePending = true;
    const pending = objects(current).find((item) => typeof item["entrypoint"] === "string");
    if (pending === undefined) throw new Error("Guardian did not receive its review input");
    return [call("read_source", { path: pending["entrypoint"], offset: 0 }, `source_${index}`)];
  });
};
const execute = (purpose: string, extra: object, callId: string) =>
  call(
    "execute",
    {
      purpose,
      target: "liveBrowser",
      entrypoint: "src/tool.mjs",
      fixtureRefs: [],
      caseFilter: [],
      maxWorkers: 1,
      timeoutSeconds: 20,
      intent: "Read whether the shop shows the account",
      ...extra,
    },
    callId,
  );
const signInStep = (step: unknown, callId: string) =>
  execute("authenticate", { signInStep: step }, callId);
/** Reports whether the shop's account page shows the signed-in account. */
const readAccount = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"read_account",input:Schema.Struct({}),output:Schema.Struct({signedIn:Schema.Boolean})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:"await page.goto(new URL('/account', page.url()).href); return (await page.locator('#account').count()) > 0;",timeout_sec:15});
  if(!response.success) throw new Error(String(response.error));
  return {signedIn:response.result === true};
});`;
const patch: Output = [
  {
    type: "apply_patch_call",
    callId: "patch_tool",
    status: "completed",
    operation: {
      type: "create_file",
      path: "src/tool.mjs",
      diff: `${readAccount
        .split("\n")
        .map((line) => `+${line}`)
        .join("\n")}\n`,
    },
  },
];
/** The result the host returned for the minter's call `callId`, as the minter read it. */
const toolResult = (requests: readonly ModelRequest[], callId: string) => {
  const result = objects(requests.at(-1)?.input).find(
    (item) => item["type"] === "function_call_result" && item["callId"] === callId,
  );
  if (result === undefined) throw new Error(`No ${callId} result`);
  return result;
};
/**
 * Answers the login question with the shop account, a correction with a new password, a code
 * question with the shop's code, or `code`, and any other with the account's username, and
 * confirms a notice.
 */
const answers = (asked: InputRequest[], code = shopCode) =>
  makeInputAsker((request) =>
    Effect.sync(() => {
      asked.push(request);
      return Object.fromEntries(
        request.questions.map((question) => [
          question.id,
          question.type === "confirm"
            ? { confirmed: true }
            : question.type === "credential"
              ? {
                  username: shopAccount.username,
                  password:
                    question.reason === "invalid_credentials"
                      ? `${shopAccount.password}-corrected`
                      : shopAccount.password,
                  saveLogin: false,
                }
              : question.id === "code"
                ? code
                : shopAccount.username,
        ]),
      );
    }),
  );
/** The one login question a build asks, when its first sign-in screen needs the login. */
const loginQuestion = (origin: string) =>
  expect.objectContaining({
    id: "login",
    type: "credential",
    fields: "username_password",
    reason: "missing_credentials",
    allowSave: false,
    siteOrigin: origin,
    prompt: "Sign in to the website so this request can continue.",
  });

/** Another host the shop's server answers for, as a sign-in site on its own origin. */
const signInHost = "login.shop.test";
/** A shop and a browser that resolves its hosts, closed after `use`. */
const withShop = async (use: (shop: Shop, endpoint: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "opengpt-sign-in-"));
  const shop = await startShop(directory);
  const browser = await chromium.launchServer({
    args: [
      `--host-resolver-rules=MAP ${shop.hostname} 127.0.0.1, MAP ${signInHost} 127.0.0.1, MAP ${identityHost} 127.0.0.1, MAP ${analyticsHost} 127.0.0.1`,
      "--no-proxy-server",
      "--ignore-certificate-errors",
    ],
  });
  try {
    await use(shop, browser.wsEndpoint());
  } finally {
    await browser.close();
    await shop.close();
    await rm(directory, { recursive: true, force: true });
  }
};

test("a local build asks for its login once and publishes its sign-in without a value; a run in its session asks nothing, and a run in a new session asks once and signs in", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium, a scripted build with a host sign-in, then two runs",
  });
  test.setTimeout(60_000);
  await withShop(async (shop, endpoint) => {
    const mintRequests: ModelRequest[] = [];
    const minter = provider((request, index) => {
      const steps: Output[] = [
        patch,
        [
          signInStep(
            {
              fields: [
                { selector: "input[name=username]", accepts: ["username"] },
                { selector: "input[name=password]", slot: "password" },
              ],
              submit: "button",
            },
            "sign_in",
          ),
        ],
        [signInStep({ signedIn: { selector: "#account" } }, "signed_in")],
        [execute("example", {}, "example")],
      ];
      if (index < steps.length) return steps[index] ?? [];
      if (index > steps.length) return [message("Built.")];
      const receipt = objects(request.input)
        .filter((item) => typeof item["executionId"] === "string")
        .at(-1);
      if (receipt === undefined) throw new Error("No execution receipt to finish with");
      return [
        call("finish_build", {
          intent: "Return the account reader",
          entrypoint: "src/tool.mjs",
          executionId: receipt["executionId"],
          metadata: { name: "read_account", description: "Read whether the account shows" },
          coverage: "One live example, signed in",
        }),
      ];
    }, mintRequests);
    const asked: InputRequest[] = [];
    const request = { url: `${shop.origin}/account`, intent: "Read the account", input: {} };
    const artifact = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createBrowserEngine({
            browser: { endpoint },
            minterProvider: minter,
            guardianProvider: guardian(),
            outcomeReviewerProvider: quietReviewer,
            ask: answers(asked),
            timeoutMs: 30_000,
          });
          const built = yield* service.mint({
            ...request,
            url: `${shop.origin}/login`,
            effect: "read",
          });
          expect(built.build, JSON.stringify(built)).toBe("published");
          if (built.artifact === undefined) throw new Error(JSON.stringify(built));
          // The minting session's own browser stays signed in, so its run checks the sign-in
          // without a value, lands on the account page and asks nothing.
          shop.state.signedInLogin = "account";
          expect(yield* service.run(built.artifact, request)).toEqual({ signedIn: true });
          return built.artifact;
        }),
      ),
    );
    // One login question for the screen, with nothing saved.
    expect(asked.map(({ questions }) => questions)).toEqual([[loginQuestion(shop.origin)]]);
    expect(asked[0]?.notice).toBe("OpenGPT needs a login for this website to continue.");
    expect(shop.state.loginPosts).toBe(1);
    // The host clicked the screen's submit after filling the login, which counts as sending it, so
    // the check verified the sign-in, and the build publishes its screens and check, value-free,
    // entered from the screen's address.
    expect(artifact.signIn).toEqual({
      recipe: {
        version: 1,
        steps: [
          {
            page: `${shop.origin}/login`,
            fields: [
              { selector: "input[name=username]", accepts: ["username"] },
              { selector: "input[name=password]", slot: "password" },
            ],
            submit: "button",
            submittedBy: "host",
          },
        ],
        signedIn: { selector: "#account" },
      },
      entryUrl: `${shop.origin}/login`,
    });
    expect(JSON.stringify(artifact)).not.toContain(shopAccount.password);
    expect(JSON.stringify(artifact.signIn)).not.toContain(shopAccount.username);
    expect(JSON.stringify(mintRequests)).not.toContain(shopAccount.password);
    // The written folder holds the recipe and no value, and a new session runs from it.
    const folder = await mkdtemp(join(tmpdir(), "opengpt-sign-in-artifact-"));
    try {
      await Effect.runPromise(Effect.scoped(writeArtifact(folder, artifact as MintArtifact)));
      const written = await Promise.all(
        (await readdir(folder, { recursive: true, withFileTypes: true }))
          .filter((entry) => entry.isFile())
          .map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")),
      );
      expect(written.join("\n")).toContain('"submittedBy": "host"');
      for (const value of [shopAccount.username, shopAccount.password])
        expect(written.join("\n")).not.toContain(value);
      const restored = await Effect.runPromise(Effect.scoped(readArtifact(folder)));
      // A new session starts signed out: its run asks for the login once, signs in with the
      // recipe and runs signed in.
      const runAsked: InputRequest[] = [];
      const output = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* createBrowserEngine({
              browser: { endpoint },
              ask: answers(runAsked),
              timeoutMs: 30_000,
            });
            return yield* service.run(restored, request);
          }),
        ),
      );
      expect(output).toEqual({ signedIn: true });
      expect(runAsked.map(({ questions }) => questions)).toEqual([[loginQuestion(shop.origin)]]);
      expect(shop.state.loginPosts).toBe(2);
      expect(await readdir(folder, { recursive: true })).toEqual(
        expect.arrayContaining(["integration.json", "auth-fill.json"]),
      );
      const after = await Promise.all(
        (await readdir(folder, { recursive: true, withFileTypes: true }))
          .filter((entry) => entry.isFile())
          .map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")),
      );
      expect(after).toEqual(written);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});

// A code screen whose form has no button submits when Enter is pressed in its one field. The
// minter names the key in place of a submit, the host presses it, and the published step keeps it,
// so a run presses it too.
test("a local build whose code screen has no button submits it with Enter, publishes that step, and a run in a new session signs in through it", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium, a scripted build with a password and a code screen, then a run",
  });
  test.setTimeout(90_000);
  await withShop(async (shop, endpoint) => {
    shop.state.loginCode = true;
    shop.state.codeSubmitsOnEnter = true;
    const mintRequests: ModelRequest[] = [];
    const minter = provider((request, index) => {
      const steps: Output[] = [
        patch,
        [signInFields()],
        [
          signInStep(
            { fields: [{ selector: "input[name=code]", slot: "code" }], submitKey: "Enter" },
            "code",
          ),
        ],
        [signInStep({ signedIn: { selector: "#account" } }, "signed_in")],
        [execute("example", {}, "example")],
      ];
      if (index < steps.length) return steps[index] ?? [];
      if (index > steps.length) return [message("Built.")];
      const receipt = objects(request.input)
        .filter((item) => typeof item["executionId"] === "string")
        .at(-1);
      if (receipt === undefined) throw new Error("No execution receipt to finish with");
      return [
        call("finish_build", {
          intent: "Return the account reader",
          entrypoint: "src/tool.mjs",
          executionId: receipt["executionId"],
          metadata: { name: "read_account", description: "Read whether the account shows" },
          coverage: "One live example, signed in",
        }),
      ];
    }, mintRequests);
    const request = { url: `${shop.origin}/account`, intent: "Read the account", input: {} };
    const built = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createBrowserEngine({
            browser: { endpoint },
            minterProvider: minter,
            guardianProvider: guardian(),
            outcomeReviewerProvider: quietReviewer,
            ask: answers([]),
            timeoutMs: 30_000,
          });
          return yield* service.mint({ ...request, url: `${shop.origin}/login`, effect: "read" });
        }),
      ),
    );
    expect(built.build, JSON.stringify(built)).toBe("published");
    if (built.artifact === undefined) throw new Error(JSON.stringify(built));
    expect(shop.state.codePosts).toBe(1);
    expect(built.artifact.signIn).toEqual({
      recipe: {
        version: 5,
        steps: [
          ...loginRecipe(shop.origin).steps,
          {
            page: `${shop.origin}/two-factor`,
            fields: [{ selector: "input[name=code]", slot: "code" }],
            submitKey: "Enter",
            submittedBy: "host",
          },
        ],
        signedIn: { selector: "#account" },
      },
      entryUrl: `${shop.origin}/login`,
    });
    expect(JSON.stringify(mintRequests)).not.toContain(shopCode);
    const runAsked: InputRequest[] = [];
    const output = await runInNewSession(
      endpoint,
      answers(runAsked),
      built.artifact as MintArtifact,
      request.url,
    );
    expect(output).toEqual(Either.right({ signedIn: true }));
    expect(reasons(runAsked)).toEqual(["missing_credentials", "code"]);
    expect(shop.state.codePosts).toBe(2);
  });
});

// A code screen that splits its code across six one-character boxes, one digit each, whose form
// posts each box as its own field: boxes a `maxlength="1"` limits, or see-through boxes with no
// `maxlength` whose widget's script keeps one character in each. A code step that names only part
// of the boxes can never send the whole code, so the host sends it back with how many boxes the
// screen shows, before Guardian or the owner sees it; the step that names every box in order is
// reviewed with each box's place, asks for the code once, types a digit in each box and signs in,
// and a run in a new session signs in through the same boxes.
for (const [limit, partial] of [
  ["maxlength", [1]],
  ["script", [1, 2, 3, 4, 5]],
] as const)
  test(`a local build whose code screen has six one-character boxes limited by ${limit} sends back a step that names boxes ${partial.join(", ")}, signs in once the step names all six in order, and a run in a new session signs in through them`, async () => {
    test.info().annotations.push({
      type: "slow",
      description: "Original SDKs, Chromium, a scripted build with a password and a six-box code screen, then a run",
    });
    test.setTimeout(90_000);
    await withShop(async (shop, endpoint) => {
      shop.state.loginCode = true;
      shop.state.codeBoxes = 6;
      shop.state.codeBoxLimit = limit;
      const boxes = [1, 2, 3, 4, 5, 6].map((box) => ({ selector: `#code-${box}`, slot: "code" }));
      const mintRequests: ModelRequest[] = [];
      const minter = provider((request, index) => {
        const steps: Output[] = [
          patch,
          [signInFields()],
          [signInStep({ fields: boxes.slice(0, partial.length), submit: "button" }, "part_of_the_boxes")],
          [signInStep({ fields: boxes, submit: "button" }, "every_box")],
          [signInStep({ signedIn: { selector: "#account" } }, "signed_in")],
          [execute("example", {}, "example")],
        ];
        if (index < steps.length) return steps[index] ?? [];
        if (index > steps.length) return [message("Built.")];
        const receipt = objects(request.input)
          .filter((item) => typeof item["executionId"] === "string")
          .at(-1);
        if (receipt === undefined) throw new Error("No execution receipt to finish with");
        return [
          call("finish_build", {
            intent: "Return the account reader",
            entrypoint: "src/tool.mjs",
            executionId: receipt["executionId"],
            metadata: { name: "read_account", description: "Read whether the account shows" },
            coverage: "One live example, signed in",
          }),
        ];
      }, mintRequests);
      // Guardian's sign-in rule: a code split across boxes is allowed only with every box, in order,
      // each with its place among the screen's boxes.
      const signInSource = (review: { reads: readonly Readonly<Record<string, unknown>>[] }) => {
        const read = review.reads.find((value) => value["path"] === "operation/sign-in-step.json");
        return typeof read?.["source"] === "string"
          ? (JSON.parse(read["source"]) as {
              step: { fields: { slot?: string }[] };
              screen: { fields: { codeBox?: { box: number; of: number } }[] };
            })
          : undefined;
      };
      const reviewer = recordingGuardian({
        decide: (review) => {
          const reviewed = signInSource(review);
          const codes = reviewed?.step.fields.filter((field) => field.slot === "code").length ?? 0;
          const placed = reviewed?.screen.fields.filter((field) => field.codeBox !== undefined).length;
          return codes === 0 || (codes === shop.state.codeBoxes && placed === codes) ? "allow" : "deny";
        },
      });
      const asked: InputRequest[] = [];
      const request = { url: `${shop.origin}/account`, intent: "Read the account", input: {} };
      const built = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* createBrowserEngine({
              browser: { endpoint },
              minterProvider: minter,
              guardianProvider: reviewer.provider,
              outcomeReviewerProvider: quietReviewer,
              ask: answers(asked),
              timeoutMs: 30_000,
            });
            return yield* service.mint({ ...request, url: `${shop.origin}/login`, effect: "read" });
          }),
        ),
      );
      expect(built.build, JSON.stringify(built)).toBe("published");
      if (built.artifact === undefined) throw new Error(JSON.stringify(built));
      // The step that names part of the boxes is sent back, typing nothing and asking nobody for
      // the code.
      expect(objects(toolResult(mintRequests, "part_of_the_boxes"))).toContainEqual(
        expect.objectContaining({
          outcome: "refused",
          reason: "code_boxes_incomplete",
          target: 0,
          codeBoxes: { boxes: 6, named: partial },
        }),
      );
      // Guardian reviewed the code screen once, with all six boxes, each with its place among them.
      const codeReviews = reviewer.reviews
        .map(signInSource)
        .filter((reviewed) => reviewed?.step.fields.some((field) => field.slot === "code"));
      expect(codeReviews).toHaveLength(1);
      expect(codeReviews[0]?.screen.fields.map((field) => field.codeBox)).toEqual(
        [1, 2, 3, 4, 5, 6].map((box) => ({ box, of: 6 })),
      );
      // One login, one code, one code post with the whole code.
      expect(reasons(asked)).toEqual(["missing_credentials", "code"]);
      expect(shop.state.codeMatches).toEqual([true]);
      expect(built.artifact.signIn).toEqual({
        recipe: {
          version: 1,
          steps: [
            ...loginRecipe(shop.origin).steps,
            {
              page: `${shop.origin}/two-factor`,
              fields: boxes,
              submit: "button",
              submittedBy: "host",
            },
          ],
          signedIn: { selector: "#account" },
        },
        entryUrl: `${shop.origin}/login`,
      });
      expect(JSON.stringify(mintRequests)).not.toContain(shopCode);
      const runAsked: InputRequest[] = [];
      const output = await runInNewSession(
        endpoint,
        answers(runAsked),
        built.artifact as MintArtifact,
        request.url,
      );
      expect(output).toEqual(Either.right({ signedIn: true }));
      expect(reasons(runAsked)).toEqual(["missing_credentials", "code"]);
      expect(shop.state.codeMatches).toEqual([true, true]);
    });
  });

// A code screen that splits a longer code across more one-character boxes than a sign-in step's
// other fields may number, whose form posts each box as its own field. The step that names every
// box decodes, is reviewed with each box's place, asks for the code once, types a digit in each
// box, counts the code as sent once the form posts the boxes, publishes a recipe that names every
// box, and a run in a new session signs in through the same boxes.
for (const count of [7, 8])
  test(`a local build whose code screen has ${count} one-character boxes signs in through a step that names all ${count}, and a run in a new session signs in through them`, async () => {
    test.info().annotations.push({
      type: "slow",
      description: `Original SDKs, Chromium, a scripted build with a password and a ${count}-box code screen, then a run`,
    });
    test.setTimeout(90_000);
    await withShop(async (shop, endpoint) => {
      const code = "4829135706".slice(0, count);
      shop.state.loginCode = true;
      shop.state.codeBoxes = count;
      shop.state.code = code;
      const places = Array.from({ length: count }, (_, at) => at + 1);
      const boxes = places.map((box) => ({ selector: `#code-${box}`, slot: "code" }));
      const mintRequests: ModelRequest[] = [];
      const minter = provider((request, index) => {
        const steps: Output[] = [
          patch,
          [signInFields()],
          [signInStep({ fields: boxes, submit: "button" }, "every_box")],
          [signInStep({ signedIn: { selector: "#account" } }, "signed_in")],
          [execute("example", {}, "example")],
        ];
        if (index < steps.length) return steps[index] ?? [];
        if (index > steps.length) return [message("Built.")];
        const receipt = objects(request.input)
          .filter((item) => typeof item["executionId"] === "string")
          .at(-1);
        if (receipt === undefined) throw new Error("No execution receipt to finish with");
        return [
          call("finish_build", {
            intent: "Return the account reader",
            entrypoint: "src/tool.mjs",
            executionId: receipt["executionId"],
            metadata: { name: "read_account", description: "Read whether the account shows" },
            coverage: "One live example, signed in",
          }),
        ];
      }, mintRequests);
      const signInSource = (review: { reads: readonly Readonly<Record<string, unknown>>[] }) => {
        const read = review.reads.find((value) => value["path"] === "operation/sign-in-step.json");
        return typeof read?.["source"] === "string"
          ? (JSON.parse(read["source"]) as {
              step: { fields: { slot?: string }[] };
              screen: { fields: { codeBox?: { box: number; of: number } }[] };
            })
          : undefined;
      };
      const reviewer = recordingGuardian({ decide: () => "allow" });
      const asked: InputRequest[] = [];
      const request = { url: `${shop.origin}/account`, intent: "Read the account", input: {} };
      const built = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* createBrowserEngine({
              browser: { endpoint },
              minterProvider: minter,
              guardianProvider: reviewer.provider,
              outcomeReviewerProvider: quietReviewer,
              ask: answers(asked, code),
              timeoutMs: 30_000,
            });
            return yield* service.mint({ ...request, url: `${shop.origin}/login`, effect: "read" });
          }),
        ),
      );
      expect(built.build, JSON.stringify(built)).toBe("published");
      if (built.artifact === undefined) throw new Error(JSON.stringify(built));
      // Guardian reviewed the code screen once, with every box, each with its place among them.
      const codeReviews = reviewer.reviews
        .map(signInSource)
        .filter((reviewed) => reviewed?.step.fields.some((field) => field.slot === "code"));
      expect(codeReviews).toHaveLength(1);
      expect(codeReviews[0]?.screen.fields.map((field) => field.codeBox)).toEqual(
        places.map((box) => ({ box, of: count })),
      );
      // One login, one code, one code post with the whole code.
      expect(reasons(asked)).toEqual(["missing_credentials", "code"]);
      expect(shop.state.codeMatches).toEqual([true]);
      expect(built.artifact.signIn).toEqual({
        recipe: {
          version: 1,
          steps: [
            ...loginRecipe(shop.origin).steps,
            {
              page: `${shop.origin}/two-factor`,
              fields: boxes,
              submit: "button",
              submittedBy: "host",
            },
          ],
          signedIn: { selector: "#account" },
        },
        entryUrl: `${shop.origin}/login`,
      });
      expect(JSON.stringify(mintRequests)).not.toContain(code);
      const runAsked: InputRequest[] = [];
      const output = await runInNewSession(
        endpoint,
        answers(runAsked, code),
        built.artifact as MintArtifact,
        request.url,
      );
      expect(output).toEqual(Either.right({ signedIn: true }));
      expect(reasons(runAsked)).toEqual(["missing_credentials", "code"]);
      expect(shop.state.codeMatches).toEqual([true, true]);
    });
  });

// A cancel at the terminal is the owner's choice to stop, not a question left unanswered: a
// signed-out build ends at once instead of going on without the answer.
test("a local build whose owner cancels the minter's question ends as no response and the minter is not asked to go on", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs and Chromium for a scripted build that asks one question",
  });
  test.setTimeout(60_000);
  await withShop(async (shop, endpoint) => {
    const mintRequests: ModelRequest[] = [];
    const minter = provider(
      (_request, index) =>
        index === 0
          ? [
              call(
                "request_input",
                {
                  questions: [{ id: "format", type: "text", prompt: "Which format?" }],
                  intent: "Only the caller knows this.",
                },
                "format",
              ),
            ]
          : [message("Going on without it.")],
      mintRequests,
    );
    const asked: InputRequest[] = [];
    const built = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createBrowserEngine({
            browser: { endpoint },
            minterProvider: minter,
            guardianProvider: guardian(),
            outcomeReviewerProvider: quietReviewer,
            ask: (request) =>
              Effect.sync(() => {
                asked.push(request);
              }).pipe(Effect.zipRight(Effect.fail(new OwnerCancelled({ code: "NoResponse" })))),
            timeoutMs: 30_000,
          });
          return yield* service.mint({
            url: `${shop.origin}/login`,
            intent: "Read the account summary",
            input: {},
            effect: "read",
          });
        }),
      ),
    );
    expect(built, JSON.stringify(built)).toMatchObject({
      build: "incomplete",
      noResponse: { possibleCommit: false },
    });
    expect(asked).toHaveLength(1);
    expect(mintRequests).toHaveLength(1);
  });
});

// Each unanswered question is decided by the build's state when it goes unanswered: asked signed
// out, it goes back to the minter as no answer; asked once the build signed in, it ends the build.
test("a local build hands back the question it asked signed out and ends as no response on the one it asked after signing in", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium and a scripted build that signs in between two questions",
  });
  test.setTimeout(60_000);
  await withShop(async (shop, endpoint) => {
    const mintRequests: ModelRequest[] = [];
    const question = (id: string, prompt: string) =>
      call(
        "request_input",
        { questions: [{ id, type: "text", prompt }], intent: "Only the caller knows this." },
        id,
      );
    const steps: Output[] = [
      [question("format", "Which format should the account summary use?")],
      [
        signInStep(
          {
            fields: [
              { selector: "input[name=username]", accepts: ["username"] },
              { selector: "input[name=password]", slot: "password" },
            ],
            submit: "button",
          },
          "sign_in",
        ),
      ],
      [signInStep({ signedIn: { selector: "#account" } }, "signed_in")],
      [question("period", "Which period should the account summary cover?")],
    ];
    const minter = provider(
      (_request, index) => steps[index] ?? [message("Stopping.")],
      mintRequests,
    );
    const asked: InputRequest[] = [];
    const login = answers(asked);
    // The caller answers the host's login question and leaves the minter's questions unanswered.
    const ask: typeof login = (request, bounds) =>
      request.source === "agent"
        ? Effect.sync(() => {
            asked.push(request);
          }).pipe(Effect.zipRight(Effect.fail(new InputRequestFailure({ code: "NoResponse" }))))
        : login(request, bounds);
    const built = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createBrowserEngine({
            browser: { endpoint },
            minterProvider: minter,
            guardianProvider: guardian(),
            outcomeReviewerProvider: quietReviewer,
            ask,
            timeoutMs: 30_000,
          });
          return yield* service.mint({
            url: `${shop.origin}/login`,
            intent: "Read the account summary",
            input: {},
            effect: "read",
          });
        }),
      ),
    );
    expect(built, JSON.stringify(built)).toMatchObject({
      build: "incomplete",
      noResponse: { possibleCommit: false },
    });
    expect(asked.map(({ questions }) => questions[0]?.id)).toEqual(["format", "login", "period"]);
    // The first question went back as no answer, and the build went on to sign in.
    expect(JSON.stringify(mintRequests[1]?.input)).toContain('\\"status\\":\\"no_answer\\"');
    expect(shop.state.loginPosts).toBe(1);
    // The second ended the build: the minter was not asked to go on.
    expect(mintRequests).toHaveLength(steps.length);
  });
});

/** Opens the account's note page and reports whether it shows the note form, signed in. */
const openNote = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"open_note",input:Schema.Struct({note:Schema.String}),output:Schema.Struct({signedIn:Schema.Boolean})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:"await page.goto(new URL('/account/note', page.url()).href); return (await page.locator('#note').count()) > 0;",timeout_sec:15});
  if(!response.success) throw new Error(String(response.error));
  return {signedIn:response.result === true};
});`;
/** Saves the input's note on the account's note page once, and confirms it. */
const saveAccountNote = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"save_note",input:Schema.Struct({note:Schema.String}),output:Schema.Struct({saved:Schema.Boolean}),write:{confirmation:"message",commits:["save"]}},
async ({kernel,sessionId,input,enteringCommit,verified}) => {
  const opened = await kernel.browsers.playwright.execute(sessionId,{code:"await page.goto(new URL('/account/note', page.url()).href); return (await page.locator('#note').count()) > 0;",timeout_sec:15});
  if(!opened.success || opened.result !== true) throw new Error("The note page is signed out");
  enteringCommit("save");
  const saved = await kernel.browsers.playwright.execute(sessionId,{code:"await page.locator('#note').fill(" + JSON.stringify(input.note) + "); await page.locator('#save').click(); await page.locator('#saved').waitFor(); return true;",timeout_sec:15});
  if(!saved.success || saved.result !== true) throw new Error("Save not confirmed");
  verified({confirmation:"message"});
  return {saved:true};
});`;
/** The identity sign-in's one screen. */
const identitySignIn = {
  fields: [
    { selector: "input[name=username]", accepts: ["username"] },
    { selector: "input[name=password]", slot: "password" },
  ],
  submit: "button",
};
/** The result of the minter's call `callId` in `request`'s history, or undefined. */
const resultOf = (request: ModelRequest, callId: string) =>
  objects(request.input).find(
    (item) => item["type"] === "function_call_result" && item["callId"] === callId,
  );
/** The identifier-first sign-in's two screens, on `/identity-steps`. */
const identitySteps = [
  { fields: [{ selector: "input[name=username]", accepts: ["username"] }], submit: "#next" },
  { fields: [{ selector: "input[name=password]", slot: "password" }], submit: "#verify" },
];
/**
 * A write build's minter for the account note: it signs in with `signIn`'s screens, the identity
 * sign-in's one by default, checks when `check` says so, and opens the note page in its first act
 * step. When that page was signed out, it signs in again on the identity sign-in the page sent it
 * to. Then it saves the note and finishes on that step. With `stopAfterCheck` it stops after the
 * check instead.
 */
const noteMinter = (
  requests: ModelRequest[],
  check: boolean,
  signIn: readonly unknown[] = [identitySignIn],
  stopAfterCheck = false,
) => {
  // Each step carries the note's one-save write path; the first one that runs records it.
  const act = (entrypoint: string, callId: string) =>
    execute(
      "act",
      {
        entrypoint,
        intent: "Save the note to the account",
        writePath: {
          steps: [{ commit: "save", does: "Saves the note" }],
          ends: "The site's confirmation of the saved note",
        },
      },
      callId,
    );
  const save = act("src/tool.mjs", "save");
  const finish = (request: ModelRequest): Output => {
    if (resultOf(request, "save") === undefined) return [save];
    const receipt = objects(resultOf(request, "save")).find(
      (item) => typeof item["executionId"] === "string",
    );
    if (receipt === undefined) throw new Error("No save receipt to finish with");
    return [
      call("finish_build", {
        intent: "Save the note to the account",
        entrypoint: "src/tool.mjs",
        executionId: receipt["executionId"],
        metadata: { name: "save_note", description: "Save a note to the account" },
        coverage: "One confirmed act session, signed in",
      }),
    ];
  };
  const created = (path: string, text: string, callId: string): Output[number] => ({
    type: "apply_patch_call",
    callId,
    status: "completed",
    operation: {
      type: "create_file",
      path,
      diff: `${text
        .split("\n")
        .map((line) => `+${line}`)
        .join("\n")}\n`,
    },
  });
  const turns: ((request: ModelRequest) => Output)[] = [
    () => [
      created("src/check.mjs", openNote, "patch_note"),
      created("src/tool.mjs", saveAccountNote, "patch_tool"),
    ],
    ...signIn.map(
      (step, index) => () => [signInStep(step, index === 0 ? "sign_in" : `sign_in_${index + 1}`)],
    ),
    ...(check ? [() => [signInStep({ signedIn: { selector: "#account" } }, "signed_in")]] : []),
    ...(stopAfterCheck
      ? []
      : [
          () => [act("src/check.mjs", "open_note")],
          (request: ModelRequest) =>
            objects(resultOf(request, "open_note")).some((item) => item["signedIn"] === true)
              ? [save]
              : [signInStep(identitySignIn, "sign_in_again")],
          finish,
        ]),
  ];
  return provider((request, index) => {
    const turn = turns[index];
    if (turn !== undefined) return turn(request);
    if (stopAfterCheck) return [message("Stopping here.")];
    // The save's receipt came one turn late when the first act step had to sign in again.
    if (resultOf(request, "finish_build") === undefined) return finish(request);
    return [message("Done.")];
  }, requests);
};
/** The account note's write request, on the shop's sign-in at `path`, the identity sign-in's. */
const noteRequest = (shop: Shop, path = "/identity-login") => ({
  url: `${shop.origin}${path}`,
  intent: "Save the note to the account",
  input: { note: "kept" },
  effect: "write" as const,
});
/**
 * Mints the account note's write build as `noteMinter` plays it, from the sign-in at `path` with
 * `signIn`'s screens, with what the build asked.
 */
const buildNote = (
  shop: Shop,
  endpoint: string,
  options: {
    readonly check: boolean;
    readonly authenticationOrigins?: readonly string[];
    readonly path?: string;
    readonly signIn?: readonly unknown[];
    readonly stopAfterCheck?: boolean;
    readonly guardian?: ModelProvider;
  },
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const requests: ModelRequest[] = [];
        const asked: InputRequest[] = [];
        const service = yield* createBrowserEngine({
          browser: { endpoint },
          minterProvider: noteMinter(
            requests,
            options.check,
            options.signIn,
            options.stopAfterCheck,
          ),
          guardianProvider: options.guardian ?? guardian(),
          outcomeReviewerProvider: quietReviewer,
          ask: answers(asked),
          timeoutMs: 60_000,
        });
        const built = yield* service.mint({
          ...noteRequest(shop, options.path),
          ...(options.authenticationOrigins === undefined
            ? {}
            : { authenticationOrigins: options.authenticationOrigins }),
        });
        const last = requests.at(-1);
        if (last === undefined) throw new Error("No minter request");
        return { built, last, asked };
      }),
    ),
  );
/** Runs the note tool once in a new session, answering the login; what it asked comes back. */
const runNote = (
  endpoint: string,
  artifact: MintArtifact,
  request: ReturnType<typeof noteRequest> & { readonly authenticationOrigins?: readonly string[] },
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const asked: InputRequest[] = [];
        const service = yield* createBrowserEngine({
          browser: { endpoint },
          ask: answers(asked),
          timeoutMs: 30_000,
        });
        return { output: yield* service.run(artifact, request), asked };
      }),
    ),
  );
/** The identity sign-in's recipe as a build publishes it. */
const identityRecipe = (shop: Shop) => ({
  version: 1,
  steps: [
    {
      page: `${shop.origin}/identity-login`,
      fields: identitySignIn.fields,
      submit: "button",
      submittedBy: "host",
    },
  ],
  signedIn: { selector: "#account" },
});
test("a local write build that never checks a sign-in whose script sends the login to another site publishes nothing without a recorded sign-in; with that site as a sign-in origin up front it asks nothing more, publishes its sign-in, and a run in a new session signs in", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium, two scripted write builds with host sign-ins, then a run",
  });
  test.setTimeout(180_000);
  await withShop(async (shop, endpoint) => {
    const identityOrigin = `https://${identityHost}:${shop.port}`;
    // No check runs, so the host asks for nothing beyond the login. The first act step starts
    // signed out; the minter signs in again on the
    // page it was sent to, and its next act step saves the note. The build does not publish that
    // write.
    const unverified = await buildNote(shop, endpoint, { check: false });
    const { last } = unverified;
    expect(objects(resultOf(last, "open_note"))).toContainEqual({ signedIn: false });
    expect(resultOf(last, "sign_in_again")).toBeDefined();
    expect(shop.state.identityPosts).toBe(2);
    expect(shop.state.accountNotes).toEqual(["kept"]);
    expect(unverified.built.build, JSON.stringify(unverified.built)).not.toBe("published");
    expect(unverified.built.artifact).toBeUndefined();
    // The refusal and the outcome name no origin the login went to.
    expect(objects(resultOf(last, "finish_build"))).toContainEqual(
      expect.objectContaining({
        status: "not_published",
        reason: "autofill_recipe_not_verified",
      }),
    );
    expect(JSON.stringify(resultOf(last, "finish_build"))).not.toContain(identityHost);
    expect(unverified.built.untrustedSignInOrigins).toBeUndefined();
    expect(unverified.asked.map(({ questions }) => questions)).toEqual([
      [loginQuestion(shop.origin)],
    ]);
    expect(JSON.stringify(unverified.built)).not.toContain(shopAccount.password);

    // With the identity service as a sign-in origin, the check verifies without a question, the first act step starts from the saved session and the
    // build publishes its sign-in, value-free, with that origin.
    const verified = await buildNote(shop, endpoint, {
      check: true,
      authenticationOrigins: [identityOrigin],
    });
    expect(verified.built.build, JSON.stringify(verified.built)).toBe("published");
    expect(verified.built.untrustedSignInOrigins).toBeUndefined();
    expect(verified.asked.map(({ questions }) => questions)).toEqual([[loginQuestion(shop.origin)]]);
    expect(shop.state.identityPosts).toBe(3);
    expect(shop.state.accountNotes).toEqual(["kept", "kept"]);
    const artifact = verified.built.artifact;
    if (artifact === undefined) throw new Error("No artifact");
    expect(artifact.signIn).toEqual({
      recipe: identityRecipe(shop),
      entryUrl: `${shop.origin}/identity-login`,
      authenticationOrigins: [identityOrigin],
    });
    expect(JSON.stringify(artifact)).not.toContain(shopAccount.password);

    // A new session starts signed out: its run asks for the login once, signs in through the
    // identity service with the recipe and saves the note.
    const ran = await runNote(endpoint, artifact, {
      ...noteRequest(shop),
      authenticationOrigins: [identityOrigin],
    });
    expect(ran.output).toEqual({ saved: true });
    expect(ran.asked.map(({ questions }) => questions)).toEqual([[loginQuestion(shop.origin)]]);
    expect(shop.state.identityPosts).toBe(4);
    expect(shop.state.accountNotes).toEqual(["kept", "kept", "kept"]);
  });
});

test("a local build whose sign-in script sends the login to another site verifies once the host clicked its submit, asks for nothing beyond the login, publishes its sign-in without that site, and a run in a new session signs in", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium, a scripted write build with a host sign-in, then a run",
  });
  test.setTimeout(120_000);
  await withShop(async (shop, endpoint) => {
    const reviewer = recordingGuardian();
    const { built, last, asked } = await buildNote(shop, endpoint, {
      check: true,
      guardian: reviewer.provider,
    });
    expect(asked.map(({ questions }) => questions)).toEqual([[loginQuestion(shop.origin)]]);
    // The host filled the login and clicked the submit, so the check verified with nothing typed
    // again, the first act step started from the saved session and the note was saved once.
    expect(objects(resultOf(last, "signed_in"))).toContainEqual(
      expect.objectContaining({ state: "authenticated" }),
    );
    expect(objects(resultOf(last, "open_note"))).toContainEqual({ signedIn: true });
    expect(resultOf(last, "sign_in_again")).toBeUndefined();
    expect(shop.state.identityPosts).toBe(1);
    expect(shop.state.accountNotes).toEqual(["kept"]);
    expect(built.build, JSON.stringify(built)).toBe("published");
    expect(built.untrustedSignInOrigins).toBeUndefined();
    const artifact = built.artifact;
    if (artifact === undefined) throw new Error("No artifact");
    expect(artifact.signIn).toEqual({
      recipe: identityRecipe(shop),
      entryUrl: `${shop.origin}/identity-login`,
    });
    // Every review, the act steps' and the publication's included, allows only the shop, never
    // the identity service or its site.
    const purposes = reviewer.reviews.map(
      (review) =>
        (
          (review.input["trusted_execution_context"] as Readonly<Record<string, unknown>> | undefined)?.[
            "currentExecution"
          ] as Readonly<Record<string, unknown>> | undefined
        )?.["purpose"],
    );
    expect(purposes).toContain("act");
    expect(reviewer.reviews.map(({ kind }) => kind)).toContain("publication");
    for (const review of reviewer.reviews) {
      const authority = authorityOf(review);
      expect(authority["allowedOrigins"]).toEqual([shop.origin]);
      expect(JSON.stringify(authority["allowedSites"])).not.toContain("identity.test");
    }
    // A run asks only for the login and signs in with the recipe.
    const ran = await runNote(endpoint, artifact, noteRequest(shop));
    expect(ran.output).toEqual({ saved: true });
    expect(ran.asked.map(({ questions }) => questions)).toEqual([[loginQuestion(shop.origin)]]);
    expect(shop.state.identityPosts).toBe(2);
    expect(shop.state.accountNotes).toEqual(["kept", "kept"]);
  });
});

/** The identifier-first sign-in's recipe as a build publishes it, from `path`. */
const identityStepsRecipe = (shop: Shop, path: string) => ({
  version: 1,
  steps: identitySteps.map((step) => ({
    page: `${shop.origin}${path}`,
    fields: step.fields,
    submit: step.submit,
    submittedBy: "host",
  })),
  signedIn: { selector: "#account" },
});

test("a local build whose identifier-first sign-in sends each screen's value alone to another site verifies once the host clicked both submits, publishes both screens without that site, and a run in a new session signs in", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium, a scripted write build with a two-screen host sign-in, then a run",
  });
  test.setTimeout(120_000);
  await withShop(async (shop, endpoint) => {
    const { built, last, asked } = await buildNote(shop, endpoint, {
      check: true,
      path: "/identity-steps",
      signIn: identitySteps,
    });
    expect(asked.map(({ questions }) => questions)).toEqual([[loginQuestion(shop.origin)]]);
    // The identifier went there on the first screen and the password on the second, and the
    // check verifies with nothing typed again.
    expect(objects(resultOf(last, "signed_in"))).toContainEqual(
      expect.objectContaining({ state: "authenticated" }),
    );
    expect(objects(resultOf(last, "open_note"))).toContainEqual({ signedIn: true });
    expect(shop.state.identityPosts).toBe(2);
    expect(shop.state.accountNotes).toEqual(["kept"]);
    expect(built.build, JSON.stringify(built)).toBe("published");
    expect(built.untrustedSignInOrigins).toBeUndefined();
    const artifact = built.artifact;
    if (artifact === undefined) throw new Error("No artifact");
    expect(artifact.signIn).toEqual({
      recipe: identityStepsRecipe(shop, "/identity-steps"),
      entryUrl: `${shop.origin}/identity-steps`,
    });
    const ran = await runNote(endpoint, artifact, noteRequest(shop, "/identity-steps"));
    expect(ran.output).toEqual({ saved: true });
    expect(ran.asked.map(({ questions }) => questions)).toEqual([[loginQuestion(shop.origin)]]);
    expect(shop.state.identityPosts).toBe(4);
    expect(shop.state.accountNotes).toEqual(["kept", "kept"]);
  });
});

test("a local build whose identifier-first sign-in sends the identifier to another site and the password alone to the site verifies once the host clicked both submits, naming no origin", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium, a scripted build with a two-screen host sign-in",
  });
  test.setTimeout(90_000);
  await withShop(async (shop, endpoint) => {
    const { built, last, asked } = await buildNote(shop, endpoint, {
      check: true,
      path: "/identity-steps?password=site&analytics=on",
      signIn: identitySteps,
      stopAfterCheck: true,
    });
    expect(asked.map(({ questions }) => questions)).toEqual([[loginQuestion(shop.origin)]]);
    // The site's request carried the password without the identifier, and the email also went to
    // an analytics service: the host's clicks after each fill are what count.
    expect(shop.state.analyticsPosts).toBe(1);
    expect(objects(resultOf(last, "signed_in"))).toContainEqual(
      expect.objectContaining({ state: "authenticated" }),
    );
    expect(built.untrustedSignInOrigins).toBeUndefined();
    expect(built.summary).not.toContain(identityHost);
    expect(built.summary).not.toContain(analyticsHost);
  });
});

/** The identifier-first sign-in's screens, with a signed-in check sent before the password's. */
const earlyCheckSteps = [
  identitySteps[0],
  { signedIn: { selector: "#account" } },
  identitySteps[1],
];

test("a local build whose check before the password screen fails as nothing submitted yet, naming no origin the email went to, verifies after the password screen and publishes neither origin", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium, a scripted write build with a two-screen host sign-in",
  });
  test.setTimeout(120_000);
  await withShop(async (shop, endpoint) => {
    const { built, last, asked } = await buildNote(shop, endpoint, {
      check: true,
      path: "/identity-steps?analytics=on",
      signIn: earlyCheckSteps,
    });
    expect(asked.map(({ questions }) => questions)).toEqual([[loginQuestion(shop.origin)]]);
    const early = objects(resultOf(last, "sign_in_2")).find(
      (item) => item["failed"] === "credentials_not_submitted",
    );
    expect(early).toBeDefined();
    expect(early?.["untrustedSignInOrigins"]).toBeUndefined();
    expect(shop.state.analyticsPosts).toBe(1);
    expect(shop.state.identityPosts).toBe(2);
    expect(objects(resultOf(last, "signed_in"))).toContainEqual(
      expect.objectContaining({ state: "authenticated" }),
    );
    expect(shop.state.accountNotes).toEqual(["kept"]);
    expect(built.build, JSON.stringify(built)).toBe("published");
    expect(built.untrustedSignInOrigins).toBeUndefined();
    expect(built.artifact?.signIn?.authenticationOrigins).toBeUndefined();
    expect(JSON.stringify(built.artifact)).not.toContain(analyticsHost);
    expect(JSON.stringify(built.artifact)).not.toContain(identityHost);
  });
});

test("a local build that stops after a check before the password screen fails it as nothing submitted and names no origin the email went to", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium, a scripted build with a two-screen host sign-in",
  });
  test.setTimeout(90_000);
  await withShop(async (shop, endpoint) => {
    const { built, last, asked } = await buildNote(shop, endpoint, {
      check: true,
      path: "/identity-steps?analytics=on",
      signIn: [identitySteps[0]],
      stopAfterCheck: true,
    });
    expect(asked.map(({ questions }) => questions)).toEqual([[loginQuestion(shop.origin)]]);
    expect(objects(resultOf(last, "signed_in"))).toContainEqual(
      expect.objectContaining({ failed: "credentials_not_submitted" }),
    );
    expect(built.build).toBe("incomplete");
    expect(built.artifact).toBeUndefined();
    expect(built.untrustedSignInOrigins).toBeUndefined();
    expect(built.summary).not.toContain(identityHost);
    expect(built.summary).not.toContain(analyticsHost);
  });
});

/** Opens the shop's identity sign-in page and reports whether its form shows. */
const openIdentityLogin = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"open_login",input:Schema.Struct({}),output:Schema.Struct({opened:Schema.Boolean})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:"await page.goto(new URL('/identity-login', page.url()).href); return (await page.locator('#login').count()) > 0;",timeout_sec:15});
  if(!response.success) throw new Error(String(response.error));
  return {opened:response.result === true};
});`;
/** The account reader's source, with the identity sign-in's opener beside it. */
const readerPatch: Output = [
  ...patch,
  {
    type: "apply_patch_call",
    callId: "patch_login",
    status: "completed",
    operation: {
      type: "create_file",
      path: "src/open-login.mjs",
      diff: `${openIdentityLogin
        .split("\n")
        .map((line) => `+${line}`)
        .join("\n")}\n`,
    },
  },
];
/** The identity sign-in's check. */
const identityCheck = (callId: string) => signInStep({ signedIn: { selector: "#account" } }, callId);
/**
 * Mints the account reader as a read from the identity sign-in: the minter plays `turns`, then
 * finishes on the receipt of its call `example`. What the build returned comes back, with the
 * minter's last request.
 */
const readBuild = (
  shop: Shop,
  endpoint: string,
  turns: readonly Output[],
  authenticationOrigins?: readonly string[],
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const requests: ModelRequest[] = [];
        const minter = provider((request, index) => {
          if (index < turns.length) return turns[index] ?? [];
          if (resultOf(request, "finish_build") !== undefined) return [message("Done.")];
          const receipt = objects(resultOf(request, "example")).find(
            (item) => typeof item["executionId"] === "string",
          );
          if (receipt === undefined) throw new Error("No example receipt to finish with");
          return [
            call("finish_build", {
              intent: "Return the account reader",
              entrypoint: "src/tool.mjs",
              executionId: receipt["executionId"],
              metadata: { name: "read_account", description: "Read whether the account shows" },
              coverage: "One live example",
            }),
          ];
        }, requests);
        const service = yield* createBrowserEngine({
          browser: { endpoint },
          minterProvider: minter,
          guardianProvider: guardian(),
          outcomeReviewerProvider: quietReviewer,
          ask: answers([]),
          timeoutMs: 30_000,
        });
        const built = yield* service.mint({
          url: `${shop.origin}/identity-login`,
          intent: "Read the account",
          input: {},
          effect: "read",
          ...(authenticationOrigins === undefined ? {} : { authenticationOrigins }),
        });
        const last = requests.at(-1);
        if (last === undefined) throw new Error("No minter request");
        return { built, last };
      }),
    ),
  );
/** The identity sign-in's one-screen recipe, as a read from `/identity-login` publishes it. */
const identityLoginSignIn = (shop: Shop) => ({
  recipe: {
    version: 1,
    steps: [
      {
        page: `${shop.origin}/identity-login`,
        fields: identitySignIn.fields,
        submit: "button",
        submittedBy: "host",
      },
    ],
    signedIn: { selector: "#account" },
  },
  entryUrl: `${shop.origin}/identity-login`,
});

test("a local read build whose example or explore ran after a sign-in no check verified publishes nothing without a recorded sign-in, and names no origin the login went to", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium, two scripted read builds with host sign-ins",
  });
  test.setTimeout(120_000);
  await withShop(async (shop, endpoint) => {
    const refusal = expect.objectContaining({
      status: "not_published",
      reason: "autofill_recipe_not_verified",
    });
    // The example started over from a cleared browser, after a sign-in that sent the login and
    // that no check verified. It read the account signed out, and the read still fails closed.
    // No check runs, so the host asks nothing, and neither the refusal nor the outcome names the
    // origin the login went to.
    const example = await readBuild(shop, endpoint, [
      patch,
      [signInStep(identitySignIn, "sign_in")],
      [execute("example", {}, "example")],
    ]);
    expect(objects(resultOf(example.last, "example"))).toContainEqual({ signedIn: false });
    expect(example.built.build, JSON.stringify(example.built)).not.toBe("published");
    expect(example.built.artifact).toBeUndefined();
    expect(objects(resultOf(example.last, "finish_build"))).toContainEqual(refusal);
    expect(JSON.stringify(resultOf(example.last, "finish_build"))).not.toContain(identityHost);
    expect(example.built.untrustedSignInOrigins).toBeUndefined();
    // An explore keeps the page that sign-in left, which the site's own token exchange signed
    // in, so it read the account signed in, and the build still fails closed.
    const explore = await readBuild(shop, endpoint, [
      patch,
      [signInStep(identitySignIn, "sign_in")],
      [execute("explore", {}, "example")],
    ]);
    expect(objects(resultOf(explore.last, "example"))).toContainEqual({ signedIn: true });
    expect(resultOf(explore.last, "signed_in")).toBeUndefined();
    expect(explore.built.build, JSON.stringify(explore.built)).not.toBe("published");
    expect(explore.built.artifact).toBeUndefined();
    expect(objects(resultOf(explore.last, "finish_build"))).toContainEqual(refusal);
    expect(JSON.stringify(resultOf(explore.last, "finish_build"))).not.toContain(identityHost);
    expect(explore.built.untrustedSignInOrigins).toBeUndefined();
  });
});

test("a local read build publishes an explore that ran after a sign-in no check had verified yet, once a later check verifies that sign-in, with its recipe", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium, a scripted read build with a host sign-in",
  });
  test.setTimeout(90_000);
  await withShop(async (shop, endpoint) => {
    const identityOrigin = `https://${identityHost}:${shop.port}`;
    const { built, last } = await readBuild(
      shop,
      endpoint,
      [
        patch,
        [signInStep(identitySignIn, "sign_in")],
        [execute("explore", {}, "example")],
        [identityCheck("signed_in")],
      ],
      [identityOrigin],
    );
    expect(objects(resultOf(last, "example"))).toContainEqual({ signedIn: true });
    expect(objects(resultOf(last, "signed_in"))).toContainEqual(
      expect.objectContaining({ state: "authenticated" }),
    );
    expect(built.build, JSON.stringify(built)).toBe("published");
    // The tool saves the origin given up front with its sign-in.
    expect(built.artifact?.signIn).toEqual({
      ...identityLoginSignIn(shop),
      authenticationOrigins: [identityOrigin],
    });
  });
});

test("a local read build whose explore ran after a second sign-in that no check verified publishes nothing, though its first sign-in verified", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium, a scripted read build with two host sign-ins",
  });
  test.setTimeout(90_000);
  await withShop(async (shop, endpoint) => {
    const identityOrigin = `https://${identityHost}:${shop.port}`;
    const { built, last } = await readBuild(
      shop,
      endpoint,
      [
        readerPatch,
        [signInStep(identitySignIn, "sign_in")],
        [identityCheck("signed_in")],
        [execute("explore", { entrypoint: "src/open-login.mjs" }, "open_login")],
        [signInStep(identitySignIn, "sign_in_again")],
        [execute("explore", {}, "example")],
      ],
      [identityOrigin],
    );
    expect(objects(resultOf(last, "signed_in"))).toContainEqual(
      expect.objectContaining({ state: "authenticated" }),
    );
    expect(objects(resultOf(last, "open_login"))).toContainEqual({ opened: true });
    expect(objects(resultOf(last, "sign_in_again"))).toContainEqual(
      expect.objectContaining({ outcome: "filled", submit: "clicked" }),
    );
    expect(objects(resultOf(last, "example"))).toContainEqual({ signedIn: true });
    // The later sign-in reached the site, so the first one's recipe is no longer the build's.
    expect(built.build, JSON.stringify(built)).not.toBe("published");
    expect(built.artifact).toBeUndefined();
    expect(objects(resultOf(last, "finish_build"))).toContainEqual(
      expect.objectContaining({
        status: "not_published",
        reason: "autofill_recipe_not_verified",
      }),
    );
    expect(built.untrustedSignInOrigins).toBeUndefined();
  });
});

/** The account reader with a published sign-in, as a written folder holds it. */
const accountReader = (signIn?: { readonly recipe: unknown; readonly entryUrl: string }) =>
  ({
    entrypoint: "src/tool.mjs",
    files: [{ path: "src/tool.mjs", content: readAccount }],
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    ...(signIn === undefined ? {} : { signIn }),
  }) as MintArtifact;
/** The one-screen sign-in as a build publishes it. */
const loginRecipe = (origin: string) => ({
  version: 1,
  steps: [
    {
      page: `${origin}/login`,
      fields: [
        { selector: "input[name=username]", accepts: ["username"] },
        { selector: "input[name=password]", slot: "password" },
      ],
      submit: "button",
      submittedBy: "host",
    },
  ],
  signedIn: { selector: "#account" },
});
/**
 * The one-screen sign-in with the error the shop shows under its form for a login it refused
 * (`loginError`) as its rejection marker: only a marker proves the site rejected the password.
 */
const markedLoginRecipe = (origin: string) => {
  const login = loginRecipe(origin);
  return {
    ...login,
    steps: login.steps.map((step) => ({
      ...step,
      rejectedMarkers: [{ slot: "password", selector: "#login-error" }],
    })),
  };
};
/** Runs `artifact` once in a new session, answering with `ask`; its failure comes back. */
const runInNewSession = (
  endpoint: string,
  ask: ReturnType<typeof makeInputAsker>,
  artifact: MintArtifact,
  url: string,
  effect?: "read" | "write",
  input: unknown = {},
) =>
  Effect.runPromise(
    Effect.either(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createBrowserEngine({ browser: { endpoint }, ask, timeoutMs: 30_000 });
          return yield* service.run(artifact, {
            url,
            intent: "Read the account",
            input,
            ...(effect === undefined ? {} : { effect }),
          });
        }),
      ),
    ),
  );
/** Answers each login question with the shop's username and the next of `passwords`. */
const loginAnswers = (asked: InputRequest[], passwords: string[]) =>
  makeInputAsker((request) =>
    Effect.sync(() => {
      asked.push(request);
      return Object.fromEntries(
        request.questions.map((question) => [
          question.id,
          question.type === "credential"
            ? {
                username: shopAccount.username,
                password: passwords.shift() ?? shopAccount.password,
                saveLogin: false,
              }
            : shopAccount.username,
        ]),
      );
    }),
  );
const reasons = (asked: readonly InputRequest[]) =>
  asked.flatMap(({ questions }) =>
    questions.map((question) => (question.type === "credential" ? question.reason : question.id)),
  );

test("a run corrects a rejected password without sending it again, asking again for a correction that repeats it", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Chromium and a run whose rejected sign-in waits out the recorded marker",
  });
  test.setTimeout(120_000);
  await withShop(async (shop, endpoint) => {
    shop.state.loginError = true;
    const wrong = `${shopAccount.password}-wrong`;
    const asked: InputRequest[] = [];
    const result = await runInNewSession(
      endpoint,
      loginAnswers(asked, [wrong, wrong, shopAccount.password]),
      accountReader({ recipe: markedLoginRecipe(shop.origin), entryUrl: `${shop.origin}/login` }),
      `${shop.origin}/account`,
    );
    expect(result).toEqual(Either.right({ signedIn: true }));
    // The login, then a correction naming the username; the correction that repeated the
    // rejected password was asked again rather than sent.
    expect(reasons(asked)).toEqual([
      "missing_credentials",
      "invalid_credentials",
      "invalid_credentials",
    ]);
    expect(asked[1]?.questions[0]).toMatchObject({ username: shopAccount.username });
    expect(shop.state.loginPosts).toBe(2);
  });
});

/** Reads the shop's orders, then asks the host to keep it signed in and reads them again if it signed in again. */
const readOrders = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"read_orders",input:Schema.Struct({}),output:Schema.Struct({first:Schema.Boolean,signedInAgain:Schema.Boolean,second:Schema.Boolean})},
async ({kernel,sessionId,ensureSignedIn}) => {
  const read = async () => {
    const response = await kernel.browsers.playwright.execute(sessionId,{code:"await page.goto(new URL('/orders', page.url()).href); return (await page.locator('#orders').count()) > 0;",timeout_sec:15});
    if(!response.success) throw new Error(String(response.error));
    return response.result === true;
  };
  const first = await read();
  const { signedInAgain } = await ensureSignedIn();
  const second = signedInAgain ? await read() : first;
  return { first, signedInAgain, second };
});`;
const ordersReader = (origin: string) =>
  ({
    entrypoint: "src/tool.mjs",
    files: [{ path: "src/tool.mjs", content: readOrders }],
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    signIn: { recipe: loginRecipe(origin), entryUrl: `${origin}/login` },
  }) as MintArtifact;

test("a run whose site signs it out on a load in the middle of the script signs in again on the same page and carries on", async () => {
  test.setTimeout(120_000);
  await withShop(async (shop, endpoint) => {
    shop.state.signOutOn = "/orders";
    const asked: InputRequest[] = [];
    const result = await runInNewSession(
      endpoint,
      loginAnswers(asked, []),
      ordersReader(shop.origin),
      `${shop.origin}/orders`,
    );
    expect(result).toEqual(Either.right({ first: false, signedInAgain: true, second: true }));
    // The login the run read before the script, typed once more through the recorded sign-in.
    expect(reasons(asked)).toEqual(["missing_credentials"]);
    expect(shop.state.loginPosts).toBe(2);
  });
});

test("a run that stays signed in through the script signs in once and types nothing more", async () => {
  test.setTimeout(120_000);
  await withShop(async (shop, endpoint) => {
    const asked: InputRequest[] = [];
    const result = await runInNewSession(
      endpoint,
      loginAnswers(asked, []),
      ordersReader(shop.origin),
      `${shop.origin}/orders`,
    );
    expect(result).toEqual(Either.right({ first: true, signedInAgain: false, second: true }));
    expect(reasons(asked)).toEqual(["missing_credentials"]);
    expect(shop.state.loginPosts).toBe(1);
  });
});

test("a run whose page signs it out and shows only a notice can't tell, so it signs in no more and its script finds the page signed out", async () => {
  test.setTimeout(120_000);
  await withShop(async (shop, endpoint) => {
    shop.state.signOutOn = "/orders";
    shop.state.signedOutShowsForm = false;
    const asked: InputRequest[] = [];
    const result = await runInNewSession(
      endpoint,
      loginAnswers(asked, []),
      ordersReader(shop.origin),
      `${shop.origin}/orders`,
    );
    // The notice shows neither the marker nor the sign-in's form and is none of its screens, so
    // `ensureSignedIn` carries on and the script's own check is what sees the session gone.
    expect(result).toEqual(Either.right({ first: false, signedInAgain: false, second: false }));
    expect(reasons(asked)).toEqual(["missing_credentials"]);
    expect(shop.state.loginPosts).toBe(1);
  });
});

/** Picks the input's workspace on the shop's workspace picker, then reads the account it shows. */
const readWorkspaceAccount = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"read_workspace_account",input:Schema.Struct({workspace:Schema.String}),output:Schema.Struct({account:Schema.String,workspace:Schema.String})},
async ({kernel,sessionId,input}) => {
  const code = "await page.goto(new URL('/choose-workspace', page.url()).href); await page.getByRole('button', { name: " + JSON.stringify(input.workspace) + ", exact: true }).click(); await page.locator('#account').waitFor(); return { account: await page.locator('#account').textContent(), workspace: await page.locator('#workspace').textContent() };";
  const response = await kernel.browsers.playwright.execute(sessionId,{code,timeout_sec:15});
  if(!response.success) throw new Error(String(response.error));
  return response.result;
});`;
/** The one-screen sign-in and the code screen after it, as a build publishes them. */
const codeRecipe = (origin: string) => {
  const login = loginRecipe(origin);
  return {
    ...login,
    steps: [
      ...login.steps,
      {
        page: `${origin}/two-factor`,
        fields: [{ selector: "input[name=code]", slot: "code" }],
        submit: "button",
        submittedBy: "host",
      },
    ],
  };
};

/** The workspace reader with the code sign-in, as a build publishes it for the shop. */
const workspaceReader = (origin: string) =>
  ({
    entrypoint: "src/tool.mjs",
    files: [{ path: "src/tool.mjs", content: readWorkspaceAccount }],
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    signIn: { recipe: codeRecipe(origin), entryUrl: `${origin}/login` },
  }) as MintArtifact;

test("a read run whose sign-in lands on a workspace picker without the marker carries on, and its operation picks the workspace and reads the account", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Chromium and a sign-in that waits out the recorded marker on the picker",
  });
  test.setTimeout(120_000);
  await withShop(async (shop, endpoint) => {
    shop.state.loginCode = true;
    shop.state.workspaceChooser = true;
    const asked: InputRequest[] = [];
    const workspace = shopWorkspaces[1];
    const result = await runInNewSession(
      endpoint,
      answers(asked),
      workspaceReader(shop.origin),
      `${shop.origin}/account`,
      "read",
      { workspace },
    );
    expect(result).toEqual(Either.right({ account: shopAccount.username, workspace }));
    // The login and the code once each: the picker never read as signed out.
    expect(reasons(asked)).toEqual(["missing_credentials", "code"]);
    expect(shop.state.loginPosts).toBe(1);
    expect(shop.state.codePosts).toBe(1);
  });
});

test("a write run whose sign-in lands on a workspace picker without the marker fails its sign-in, as a write's sign-in needs the marker", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Chromium and a sign-in that waits out the recorded marker on the picker",
  });
  test.setTimeout(120_000);
  await withShop(async (shop, endpoint) => {
    shop.state.loginCode = true;
    shop.state.workspaceChooser = true;
    const asked: InputRequest[] = [];
    const result = await runInNewSession(
      endpoint,
      answers(asked),
      workspaceReader(shop.origin),
      `${shop.origin}/account`,
      "write",
      { workspace: shopWorkspaces[1] },
    );
    expect(Either.isLeft(result) ? result.left : result).toMatchObject({
      _tag: "SignInRunFailed",
      code: "RecipeFailed",
      reason: "sign_in_check_failed",
    });
    expect(reasons(asked)).toEqual(["missing_credentials", "code"]);
    expect(shop.state.loginPosts).toBe(1);
  });
});

// The value-free check opens the recorded entry page, and a signed-in session lands on the picker:
// none of the sign-in's screens shows, and the page left them and the entry page and stayed put
// without the marker, so a read's sign-in ends there as can't tell and its operation runs.
// Nothing more is typed or asked.
test("a second read run on the same session, whose sign-in page sends a signed-in visit to the workspace picker, carries on from the picker without typing the login again", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Chromium and two runs whose sign-ins wait out the recorded marker on the picker",
  });
  test.setTimeout(180_000);
  await withShop(async (shop, endpoint) => {
    shop.state.loginCode = true;
    shop.state.workspaceChooser = true;
    shop.state.signedInLogin = "account";
    const asked: InputRequest[] = [];
    const [first, second] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createBrowserEngine({
            browser: { endpoint },
            ask: answers(asked),
            timeoutMs: 30_000,
          });
          const runOnce = (workspace: string) =>
            Effect.either(
              service.run(workspaceReader(shop.origin), {
                url: `${shop.origin}/account`,
                intent: "Read the account",
                input: { workspace },
                effect: "read",
              }),
            );
          return [yield* runOnce(shopWorkspaces[0]), yield* runOnce(shopWorkspaces[1])] as const;
        }),
      ),
    );
    expect(first).toEqual(
      Either.right({ account: shopAccount.username, workspace: shopWorkspaces[0] }),
    );
    expect(second).toEqual(
      Either.right({ account: shopAccount.username, workspace: shopWorkspaces[1] }),
    );
    expect(reasons(asked)).toEqual(["missing_credentials", "code"]);
    expect(shop.state.loginPosts).toBe(1);
    expect(shop.state.codePosts).toBe(1);
  });
});

/**
 * Lists the account's statements a page at a time through `readList`: a site page is opened by
 * the site's own link, and a load that shows the page signed out asks the host to sign in again
 * and opens it once more.
 */
const listStatements = `import { Schema } from "effect";
import { defineOperation, listInputFields, listOutputFields, readList, startList } from "../runtime/index.js";
export default defineOperation({name:"list_statements",input:Schema.Struct({...listInputFields}),output:Schema.Struct({statements:Schema.Array(Schema.String),...listOutputFields})},
async ({kernel,sessionId,siteOrigin,input,ensureSignedIn}) => {
  const list = startList(input, { mechanism: "pages" });
  const read = async (href, count) => {
    const response = await kernel.browsers.playwright.execute(sessionId,{timeout_sec:15,code:\`
      await page.goto(\${JSON.stringify(href)}, { waitUntil: "domcontentloaded" });
      if ((await page.locator("#signed-out").count()) > 0) return null;
      const ids = await page.locator("#statements > li").evaluateAll((rows) => rows.map((row) => row.dataset.id));
      const next = page.locator("a[rel=next]");
      const nextHref = (await next.count()) === 1 ? await next.getAttribute("href") : null;
      return { href: page.url(), ids: ids.slice(0, \${count}), more: ids.length > \${count}, next: nextHref === null ? null : new URL(nextHref, page.url()).href };\`});
    if(!response.success) throw new Error(String(response.error));
    return response.result;
  };
  const open = async (href, count) => {
    let found = await read(href, count);
    if (found === null && (await ensureSignedIn()).signedInAgain) found = await read(href, count);
    if (found === null) throw new Error("The statements page is signed out");
    return { rows: found.ids.map((id) => ({ id })), more: found.more, hasNext: found.next !== null, href: found.href, next: found.next };
  };
  const page = await readList(list, {
    keyOf: (row) => row.id,
    open: (position, count) => open(position?.href ?? new URL("/statements", siteOrigin).href, count),
    more: (segment, count) => open(segment.href, count),
    next: (segment, count) => open(segment.next, count),
  });
  return { statements: page.rows.map((row) => row.id), ...page.output };
});`;

test("a signed-in list's page two signs in through the host before it reaches its position, and its cursor holds no login or session", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Chromium and two list runs, each in a new session that signs in",
  });
  test.setTimeout(120_000);
  await withShop(async (shop, endpoint) => {
    const keys = listCursorKeys({ current: { id: "k1", secret: new Uint8Array(32).fill(5) } });
    const artifact = {
      entrypoint: "src/tool.mjs",
      files: [{ path: "src/tool.mjs", content: listStatements }],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      signIn: { recipe: loginRecipe(shop.origin), entryUrl: `${shop.origin}/login` },
    } as MintArtifact;
    const asked: InputRequest[] = [];
    // Each page in a new session, as separate served calls run: nothing of page one's sign-in stays.
    const listPage = (input: Record<string, unknown>) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* createBrowserEngine({
              browser: { endpoint },
              ask: loginAnswers(asked, []),
              timeoutMs: 30_000,
              listCursors: { keys },
            });
            return yield* service.run(artifact, {
              url: `${shop.origin}/statements`,
              intent: "List the account's statements",
              effect: "read",
              input,
            });
          }),
        ),
      ) as Promise<{
        readonly statements: readonly string[];
        readonly next_cursor: string | null;
        readonly has_more: boolean;
      }>;
    const statements = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, index) => `S${from + index}`);

    const first = await listPage({ limit: 20 });
    expect(first.statements).toEqual(statements(1, 20));
    expect(shop.state.loginPosts).toBe(1);
    const cursor = first.next_cursor ?? "";
    // The cursor holds the site's link and the position, never the login or the session.
    const body = Buffer.from(cursor.split(".")[2] ?? "", "base64url").toString("utf8");
    expect(body).toContain("/statements");
    for (const secret of [
      shopAccount.username,
      shopAccount.password,
      shop.sessionValue,
      shop.signedInValue,
    ])
      expect(`${cursor}\n${body}`).not.toContain(secret);

    const loadsBefore = shop.state.statementLoads.length;
    const second = await listPage({ limit: 20, cursor });
    // The rest of site page one, then site page two's first rows: twenty, no gap, no repeat.
    expect(second.statements).toEqual(statements(21, 40));
    expect(second.has_more).toBe(true);
    // Page two signed in through the host before the script ran, and opened the list signed in.
    expect(shop.state.loginPosts).toBe(2);
    expect(reasons(asked)).toEqual(["missing_credentials", "missing_credentials"]);
    expect(shop.state.statementLoads.slice(loadsBefore)).toEqual([
      { page: 1, signedIn: true },
      { page: 2, signedIn: true },
    ]);
  });
});

/** Signs the page out and reads the orders six times, asking the host to sign in again each time. */
const signOutEachRound = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"read_orders",input:Schema.Struct({}),output:Schema.Struct({signIns:Schema.Number})},
async ({kernel,sessionId,ensureSignedIn}) => {
  let signIns = 0;
  for (let round = 0; round < 6; round++) {
    const response = await kernel.browsers.playwright.execute(sessionId,{code:"await context.clearCookies(); await page.goto(new URL('/orders', page.url()).href); return true;",timeout_sec:15});
    if(!response.success) throw new Error(String(response.error));
    const { signedInAgain } = await ensureSignedIn();
    if (signedInAgain) signIns++;
  }
  return { signIns };
});`;

test("a build's script whose site keeps signing out ends the request with the session not kept once its sign-ins are spent", async () => {
  test.setTimeout(120_000);
  await withShop(async (shop, endpoint) => {
    const mintRequests: ModelRequest[] = [];
    const asked: InputRequest[] = [];
    const minter = provider(
      (_request, index) =>
        (
          [
            [create("src/tool.mjs", signOutEachRound, "patch_tool")],
            [
              signInStep(
                {
                  fields: [
                    { selector: "input[name=username]", accepts: ["username"] },
                    { selector: "input[name=password]", slot: "password" },
                  ],
                  submit: "button",
                },
                "sign_in",
              ),
            ],
            [signInStep({ signedIn: { selector: "#account" } }, "signed_in")],
            [execute("example", {}, "example")],
          ] satisfies Output[]
        )[index] ?? [message("Built.")],
      mintRequests,
    );
    const built = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createBrowserEngine({
            browser: { endpoint },
            minterProvider: minter,
            guardianProvider: guardian(),
            ask: answers(asked),
            timeoutMs: 60_000,
          });
          return yield* service.mint({
            url: `${shop.origin}/login`,
            intent: "Read the orders",
            input: {},
            effect: "read",
          });
        }),
      ),
    );
    // The build's sign-in, then the four automatic sign-ins a build allows, each with the login
    // the build holds. The fifth is refused, which ends the example's request, and the build,
    // with the session the site did not keep.
    expect(shop.state.loginPosts).toBe(5);
    expect(asked.map(({ questions }) => questions)).toEqual([[loginQuestion(shop.origin)]]);
    expect(built).toMatchObject({ build: "incomplete", recoveryReason: "sign_in_unavailable" });
    expect(built.diagnostics).toContainEqual(
      JSON.stringify({
        phase: "sign_in",
        reason: "sign_in_unavailable",
        sessionLoss: "session_not_kept",
      }),
    );
    // No turn followed the example's request.
    expect(mintRequests).toHaveLength(4);
  });
});

test("a served read whose site keeps signing out reports the sign-in unavailable once its sign-ins are spent", async () => {
  test.setTimeout(120_000);
  await withShop(async (shop, endpoint) => {
    const asked: InputRequest[] = [];
    const result = await runInNewSession(
      endpoint,
      loginAnswers(asked, []),
      { ...ordersReader(shop.origin), files: [{ path: "src/tool.mjs", content: signOutEachRound }] },
      `${shop.origin}/orders`,
      "read",
    );
    // The run's sign-in, then the three automatic sign-ins a run allows. The fourth is refused,
    // and the read reports the sign-in unavailable, to run again with the same request.
    expect(shop.state.loginPosts).toBe(4);
    expect(reasons(asked)).toEqual(["missing_credentials"]);
    expect(Either.isLeft(result) && result.left).toMatchObject({
      _tag: "RunOutcomeFailure",
      outcome: {
        code: "website_sign_in_unavailable",
        writeStatus: null,
        possibleCommit: false,
        retry: "same_key",
      },
    });
  });
});

test("a 0.2.0 folder without a sign-in runs as it always did, asking nothing", async () => {
  await withShop(async (shop, endpoint) => {
    const folder = await mkdtemp(join(tmpdir(), "opengpt-sign-in-artifact-"));
    try {
      // integration.json as 0.2.0 wrote it: no signIn, and no recipe beside it.
      await Effect.runPromise(Effect.scoped(writeArtifact(folder, accountReader())));
      expect((await readdir(folder)).sort()).toEqual(["integration.json", "src"]);
      const asked: InputRequest[] = [];
      const result = await runInNewSession(
        endpoint,
        answers(asked),
        await Effect.runPromise(Effect.scoped(readArtifact(folder))),
        `${shop.origin}/account`,
      );
      expect(result).toEqual(Either.right({ signedIn: false }));
      expect(asked).toEqual([]);
      expect(shop.state.loginPosts).toBe(0);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});

test("a recipe of a version this host does not know is refused before the run signs in or runs", async () => {
  await withShop(async (shop, endpoint) => {
    const asked: InputRequest[] = [];
    const result = await runInNewSession(
      endpoint,
      answers(asked),
      accountReader({
        recipe: { ...loginRecipe(shop.origin), version: 9 },
        entryUrl: `${shop.origin}/login`,
      }),
      `${shop.origin}/account`,
    );
    expect(Either.isLeft(result) && result.left).toMatchObject({
      _tag: "SignInRunFailed",
      code: "MissingRecipe",
      reason: "unknown_version",
    });
    expect(asked).toEqual([]);
    expect(shop.state.loginPosts).toBe(0);
  });
});

/** The team sign-in's recipe, version 7: its password screen's team segment is written as `*`. */
const teamRecipe = (origin: string) => ({
  version: 7,
  steps: [
    {
      page: `${origin}/team-sign-in`,
      fields: [{ selector: "#username", accepts: ["username"] }],
      submit: "#next",
      submittedBy: "host",
    },
    {
      page: `${origin}/team/*/password`,
      anySegments: [1],
      fields: [{ selector: "#password", slot: "password" }],
      submit: "#sign-in",
      submittedBy: "host",
    },
  ],
  signedIn: { selector: "#account" },
});

test("one version 7 recipe signs in two logins whose password screens sit on their own teams' paths", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Chromium and two runs through two recorded sign-in screens",
  });
  test.setTimeout(120_000);
  await withShop(async (shop, endpoint) => {
    for (const account of [teamAccounts.a, teamAccounts.b]) {
      const asked: InputRequest[] = [];
      const login = makeInputAsker((request) =>
        Effect.sync(() => {
          asked.push(request);
          return Object.fromEntries(
            request.questions.map((question) => [question.id, { ...account, saveLogin: false }]),
          );
        }),
      );
      const result = await runInNewSession(
        endpoint,
        login,
        accountReader({ recipe: teamRecipe(shop.origin), entryUrl: `${shop.origin}/team-sign-in` }),
        `${shop.origin}/account`,
      );
      expect(result).toEqual(Either.right({ signedIn: true }));
      expect(reasons(asked)).toEqual(["missing_credentials"]);
    }
    // Each login's password went to its own team's path.
    expect(shop.state.teamSignIns).toEqual(["a", "b"]);
  });
});

test("a run's second screen whose form posts to a URL holding the password is refused after the first screen's typing", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Chromium and a run through two recorded sign-in screens",
  });
  test.setTimeout(60_000);
  await withShop(async (shop, endpoint) => {
    // The password screen's form posts to a URL that holds the password, as page code that kept
    // a typed value could make it.
    const entryUrl = `${shop.origin}/sign-in?echo=none&stash=password`;
    const asked: InputRequest[] = [];
    const result = await runInNewSession(
      endpoint,
      answers(asked),
      accountReader({
        recipe: {
          version: 1,
          steps: [
            {
              page: `${shop.origin}/sign-in`,
              fields: [{ selector: "#username", accepts: ["email"] }],
              submit: "#next",
              submittedBy: "host",
            },
            {
              page: `${shop.origin}/sign-in/password`,
              fields: [{ selector: "#password", slot: "password" }],
              submit: "#sign-in",
              submittedBy: "host",
            },
          ],
          signedIn: { selector: "#account" },
        },
        entryUrl,
      }),
      `${shop.origin}/account`,
    );
    // The host typed on the identifier screen, so the password screen's guard refuses the submit
    // to the URL holding the password as it fires: the run fails and the operation never runs.
    expect(reasons(asked)).toEqual(["missing_credentials"]);
    expect(Either.isLeft(result) && result.left).toMatchObject({
      _tag: "SignInRunFailed",
      code: "RecipeFailed",
      reason: "submit_refused",
    });
    expect(shop.state.sessionPosts).toBe(0);
    expect(String(Either.isLeft(result) && result.left.message)).not.toContain(
      shopAccount.password,
    );
  });
});

test("a run's password screen whose post the site answers through redirects slower than the host's click signs in", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Chromium and a run through two recorded sign-in screens, the second's post answered through 6.4 s of redirects",
  });
  test.setTimeout(90_000);
  await withShop(async (shop, endpoint) => {
    // The site answers the password post at once and signs the browser in, then four redirects of
    // 1.6 s each reach the account page, past the 5 s the host's click waits for its navigation.
    shop.state.sessionHops = 4;
    shop.state.sessionHopMs = 1_600;
    const asked: InputRequest[] = [];
    const result = await runInNewSession(
      endpoint,
      answers(asked),
      accountReader({
        recipe: {
          version: 1,
          steps: [
            {
              page: `${shop.origin}/sign-in`,
              fields: [{ selector: "#username", accepts: ["email"] }],
              submit: "#next",
              submittedBy: "host",
            },
            {
              page: `${shop.origin}/sign-in/password`,
              fields: [{ selector: "#password", slot: "password" }],
              submit: "#sign-in",
              submittedBy: "host",
            },
          ],
          signedIn: { selector: "#account" },
        },
        entryUrl: `${shop.origin}/sign-in`,
      }),
      `${shop.origin}/account`,
    );
    expect(result).toEqual(Either.right({ signedIn: true }));
    expect(reasons(asked)).toEqual(["missing_credentials"]);
    // The password went out once.
    expect(shop.state.sessionPosts).toBe(1);
  });
});

test("a login URL that holds the login's email is refused at publication, naming the login URL and never the email, and a new sign-in from a URL without it publishes", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium and a scripted build with two host sign-ins",
  });
  test.setTimeout(90_000);
  await withShop(async (shop, endpoint) => {
    const mintRequests: ModelRequest[] = [];
    const asked: InputRequest[] = [];
    const authenticate = (loginUrl: string, callId: string) =>
      execute(
        "authenticate",
        {
          signInStep: {
            fields: [
              { selector: "input[name=username]", accepts: ["username"] },
              { selector: "input[name=password]", slot: "password" },
            ],
            submit: "button",
          },
          loginUrl,
        },
        callId,
      );
    let executionId: unknown;
    const finish = (request: ModelRequest, callId: string): Output => {
      executionId ??= objects(request.input)
        .filter((item) => typeof item["executionId"] === "string")
        .at(-1)?.["executionId"];
      if (executionId === undefined) throw new Error("No execution receipt to finish with");
      return [
        call(
          "finish_build",
          {
            intent: "Return the account reader",
            entrypoint: "src/tool.mjs",
            executionId,
            metadata: { name: "read_account", description: "Read whether the account shows" },
            coverage: "One live example, signed in",
          },
          callId,
        ),
      ];
    };
    const minter = provider((request, index) => {
      const steps: (Output | ((request: ModelRequest) => Output))[] = [
        [...patch, create("explore/login.mjs", openPage("open_login", "/login"), "patch_login")],
        [
          authenticate(
            `${shop.origin}/login?email=${encodeURIComponent(shopAccount.username)}`,
            "sign_in",
          ),
        ],
        [signInStep({ signedIn: { selector: "#account" } }, "signed_in")],
        [execute("example", {}, "example")],
        (current) => finish(current, "finish_refused"),
        // As the refusal says: a new sign-in from a login URL without the email.
        [
          execute(
            "explore",
            { entrypoint: "explore/login.mjs", intent: "Open the sign-in page" },
            "explore_login",
          ),
        ],
        [authenticate(`${shop.origin}/login`, "sign_in_again")],
        [signInStep({ signedIn: { selector: "#account" } }, "signed_in_again")],
        (current) => finish(current, "finish_published"),
      ];
      const step = steps[index];
      return step === undefined
        ? [message("Built.")]
        : typeof step === "function"
          ? step(request)
          : step;
    }, mintRequests);
    const built = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createBrowserEngine({
            browser: { endpoint },
            minterProvider: minter,
            guardianProvider: guardian(),
            outcomeReviewerProvider: quietReviewer,
            ask: answers(asked),
            timeoutMs: 30_000,
          });
          return yield* service.mint({
            url: `${shop.origin}/login`,
            intent: "Read the account",
            input: {},
            effect: "read",
          });
        }),
      ),
    );
    const result = toolResult(mintRequests, "finish_refused");
    const refused = objects(result).find((item) => item["status"] === "not_published");
    expect(refused).toMatchObject({
      reason: "login_url_contains_credential",
      parts: [{ part: "loginUrl", credentialKinds: ["credential"] }],
    });
    expect(String(refused?.["instruction"])).toContain("For loginUrl, run authenticate again");
    // The refusal never holds the email.
    expect(JSON.stringify(result)).not.toContain(shopAccount.username);
    expect(JSON.stringify(result)).not.toContain(encodeURIComponent(shopAccount.username));
    // The second sign-in publishes, entered from the URL without the email, with one login asked.
    expect(built.build, JSON.stringify(built)).toBe("published");
    expect(built.artifact?.signIn?.entryUrl).toBe(`${shop.origin}/login`);
    expect(JSON.stringify(built.artifact)).not.toContain(shopAccount.username);
    expect(JSON.stringify(built.artifact)).not.toContain(encodeURIComponent(shopAccount.username));
    expect(shop.state.loginPosts).toBe(2);
    expect(asked.map(({ questions }) => questions)).toEqual([[loginQuestion(shop.origin)]]);
    expect(JSON.stringify(mintRequests)).not.toContain(shopAccount.password);
  });
});

/**
 * A read build that signs in on the shop's one-screen sign-in with `loginUrl` as its login URL,
 * runs its example and finishes, then goes on as `more` says; what the minter read and the build.
 */
const loginUrlBuild = async (
  shop: Shop,
  endpoint: string,
  loginUrl: string,
  more: readonly (Output | ((request: ModelRequest) => Output))[],
  authenticationOrigins?: readonly string[],
) => {
  const mintRequests: ModelRequest[] = [];
  const asked: InputRequest[] = [];
  const minter = provider((request, index) => {
    const steps: (Output | ((request: ModelRequest) => Output))[] = [
      [...patch, create("explore/login.mjs", openPage("open_login", "/login"), "patch_login")],
      [loginUrlSignIn(loginUrl, "sign_in")],
      [signInStep({ signedIn: { selector: "#account" } }, "signed_in")],
      [execute("example", {}, "example")],
      (current) => finishRead(current, "finish_first"),
      ...more,
    ];
    const step = steps[index];
    return step === undefined
      ? [message("Built.")]
      : typeof step === "function"
        ? step(request)
        : step;
  }, mintRequests);
  const built = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* createBrowserEngine({
          browser: { endpoint },
          minterProvider: minter,
          guardianProvider: guardian(),
          outcomeReviewerProvider: quietReviewer,
          ask: answers(asked),
          timeoutMs: 30_000,
        });
        return yield* service.mint({
          url: `${shop.origin}/login`,
          intent: "Read the account",
          input: {},
          effect: "read",
          ...(authenticationOrigins === undefined ? {} : { authenticationOrigins }),
        });
      }),
    ),
  );
  return { built, mintRequests, asked };
};
/** The shop's one-screen sign-in, recorded with `loginUrl` as the login URL to publish. */
const loginUrlSignIn = (loginUrl: string, callId: string) =>
  execute(
    "authenticate",
    {
      signInStep: {
        fields: [
          { selector: "input[name=username]", accepts: ["username"] },
          { selector: "input[name=password]", slot: "password" },
        ],
        submit: "button",
      },
      loginUrl,
    },
    callId,
  );
/** `finish_build` for the account reader, on the example's execution receipt. */
const finishRead = (request: ModelRequest, callId: string): Output => {
  const receipt = objects(
    objects(request.input).find(
      (item) => item["type"] === "function_call_result" && item["callId"] === "example",
    ),
  ).find((item) => typeof item["executionId"] === "string");
  if (receipt === undefined) throw new Error("No example receipt to finish with");
  return [
    call(
      "finish_build",
      {
        intent: "Return the account reader",
        entrypoint: "src/tool.mjs",
        executionId: receipt["executionId"],
        metadata: { name: "read_account", description: "Read whether the account shows" },
        coverage: "One live example, signed in",
      },
      callId,
    ),
  ];
};

test("a sign-in whose login URL is on another site is refused at publication by the sign-in version check, naming the rule and part and never a value, and a new sign-in from the site's own page publishes", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium and a scripted build with two host sign-ins",
  });
  test.setTimeout(90_000);
  await withShop(async (shop, endpoint) => {
    const offSite = `https://${identityHost}:${shop.port}/login`;
    const { built, mintRequests } = await loginUrlBuild(shop, endpoint, offSite, [
      [
        execute(
          "explore",
          { entrypoint: "explore/login.mjs", intent: "Open the sign-in page" },
          "explore_login",
        ),
      ],
      [loginUrlSignIn(`${shop.origin}/login`, "sign_in_again")],
      [signInStep({ signedIn: { selector: "#account" } }, "signed_in_again")],
      (current) => finishRead(current, "finish_published"),
    ]);
    const result = toolResult(mintRequests, "finish_first");
    const refused = objects(result).find((item) => item["status"] === "not_published");
    expect(refused).toMatchObject({
      code: "PublicationUnavailable",
      reason: "sign_in_version_refused",
      signInFindings: [{ rule: "foreign_origin", part: "entryUrl" }],
    });
    expect(String(refused?.["instruction"])).toContain(
      "Not published: the sign-in this tool would publish fails the host's sign-in version check. signInFindings names each rule and the part of the sign-in recipe or login URL it refused, never a value. The host changed nothing. Run authenticate again so the sign-in records without those parts: start from the site's stable sign-in page as loginUrl, name no account in a selector, page or marker, leave out any step or account page that signs out, and use a signed-in marker that only signed-in pages show. Then call finish_build again with the same executionId. The host refuses every time until the sign-in passes.",
    );
    // The refusal names no value: neither the login URL nor its host, nor the login.
    for (const value of [identityHost, shopAccount.username, shopAccount.password])
      expect(JSON.stringify(result)).not.toContain(value);
    expect(built.build, JSON.stringify(built)).toBe("published");
    expect(built.artifact?.signIn?.entryUrl).toBe(`${shop.origin}/login`);
  });
});

test("a sign-in whose login URL is on a sign-in origin the request declares is refused at publication too", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium and a scripted build with a host sign-in",
  });
  test.setTimeout(60_000);
  await withShop(async (shop, endpoint) => {
    const identityOrigin = `https://${identityHost}:${shop.port}`;
    const { built, mintRequests } = await loginUrlBuild(
      shop,
      endpoint,
      `${identityOrigin}/login`,
      [],
      [identityOrigin],
    );
    // The request trusts the origin for sign-in, but a published sign-in starts on the site.
    expect(
      objects(toolResult(mintRequests, "finish_first")).find(
        (item) => item["status"] === "not_published",
      ),
    ).toMatchObject({
      reason: "sign_in_version_refused",
      signInFindings: [{ rule: "foreign_origin", part: "entryUrl" }],
    });
    expect(built.build, JSON.stringify(built)).not.toBe("published");
    expect(built.artifact).toBeUndefined();
  });
});

test("a one-time login URL is asked about once, and finishing again publishes it as it is", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium and a scripted build with a host sign-in",
  });
  test.setTimeout(60_000);
  await withShop(async (shop, endpoint) => {
    // A random state of hex digits, as most are, holds four digits in a row.
    const oneTime = `${shop.origin}/login?state=8f14e45fceea1670`;
    const { built, mintRequests } = await loginUrlBuild(shop, endpoint, oneTime, [
      (current) => finishRead(current, "finish_again"),
    ]);
    expect(
      objects(toolResult(mintRequests, "finish_first")).find(
        (item) => item["status"] === "not_published",
      ),
    ).toMatchObject({ reason: "login_url_one_time", oneTimeParameters: ["state"] });
    expect(built.build, JSON.stringify(built)).toBe("published");
    expect(built.artifact?.signIn?.entryUrl).toBe(oneTime);
  });
});

test("a second sign-in screen whose form posts to a URL holding the password is refused after the first screen's typing", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium and two host sign-in steps through a form navigation",
  });
  test.setTimeout(60_000);
  await withShop(async (shop, endpoint) => {
    const mintRequests: ModelRequest[] = [];
    const minter = provider((_request, index) => {
      if (index === 0)
        return [
          signInStep(
            { fields: [{ selector: "#username", accepts: ["email"] }], submit: "#next" },
            "identifier",
          ),
        ];
      if (index === 1)
        return [
          signInStep(
            { fields: [{ selector: "#password", slot: "password" }], submit: "#sign-in" },
            "password",
          ),
        ];
      return [message("Stopping here.")];
    }, mintRequests);
    const asked: InputRequest[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createBrowserEngine({
            browser: { endpoint },
            minterProvider: minter,
            guardianProvider: guardian(),
            outcomeReviewerProvider: quietReviewer,
            ask: answers(asked),
            timeoutMs: 30_000,
          });
          yield* service.mint({
            // The password screen's form posts to a URL that holds the password, as page code
            // that kept a typed value could make it; the host cannot tell.
            url: `${shop.origin}/sign-in?echo=none&stash=password`,
            intent: "Read the account",
            effect: "read",
            input: {},
          });
        }),
      ),
    );
    // The identifier screen asks for the login, and the password screen fills the same one.
    expect(asked.map(({ questions }) => questions)).toEqual([[loginQuestion(shop.origin)]]);
    expect(objects(toolResult(mintRequests, "identifier"))).toContainEqual(
      expect.objectContaining({ outcome: "filled", submit: "clicked" }),
    );
    // The host typed into the page on the first screen, so the second screen's guard no longer
    // trusts a URL the page chose to hold the password: it refuses the submit as it fires.
    expectRefusedSubmit(shop, mintRequests);
  });
});

/** The password step typed, but its guard refused the submit to the URL holding the password. */
const expectRefusedSubmit = (shop: Shop, mintRequests: readonly ModelRequest[]) => {
  const result = objects(toolResult(mintRequests, "password"));
  expect(result).toContainEqual(
    expect.objectContaining({ outcome: "filled", submit: "refused", clicked: true }),
  );
  expect(result).toContainEqual(
    expect.objectContaining({ changed: "submission.action", submissionActionOrigin: shop.origin }),
  );
  expect(shop.state.sessionPosts).toBe(0);
  expect(JSON.stringify(mintRequests)).not.toContain(shopAccount.password);
};

test("a later build in the same session refuses a password screen before its own identifier screen", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium and two scripted builds in one session",
  });
  test.setTimeout(60_000);
  await withShop(async (shop, endpoint) => {
    // Each build sends its one screen, then stops.
    let screen: "identifier" | "password" = "identifier";
    const mintRequests: ModelRequest[] = [];
    const minter = provider(
      (request) =>
        objects(request.input).some((item) => item["type"] === "function_call_result")
          ? [message("Stopping here.")]
          : [
              signInStep(
                screen === "identifier"
                  ? { fields: [{ selector: "#username", accepts: ["email"] }], submit: "#next" }
                  : { fields: [{ selector: "#password", slot: "password" }], submit: "#sign-in" },
                screen,
              ),
            ],
      mintRequests,
    );
    const asked: InputRequest[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createBrowserEngine({
            browser: { endpoint },
            minterProvider: minter,
            guardianProvider: guardian(),
            outcomeReviewerProvider: quietReviewer,
            ask: answers(asked),
            timeoutMs: 30_000,
          });
          const request = { intent: "Read the account", effect: "read" as const, input: {} };
          yield* service.mint({ ...request, url: `${shop.origin}/sign-in?echo=none` });
          // The second build starts on a password-only screen, whose form would post to a URL
          // that holds the password, before any identifier screen of its own.
          screen = "password";
          yield* service.mint({
            ...request,
            url: `${shop.origin}/sign-in/password?echo=none&stash=password`,
          });
        }),
      ),
    );
    // Each build asks for its own login once a screen needs it. The later build holds none when
    // its first screen asks for a password, so the host refuses that screen: it asks nothing and
    // types nothing.
    expect(asked.map(({ questions }) => questions)).toEqual([[loginQuestion(shop.origin)]]);
    expect(objects(toolResult(mintRequests, "password"))).toContainEqual(
      expect.objectContaining({ outcome: "refused", reason: "login_identifier_unobserved" }),
    );
    expect(shop.state.sessionPosts).toBe(0);
    expect(JSON.stringify(mintRequests)).not.toContain(shopAccount.password);
  });
});

test("a password screen that shows the typed email signs in, and Guardian reads that screen with the email masked", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium and three host sign-in steps through a form navigation",
  });
  test.setTimeout(60_000);
  await withShop(async (shop, endpoint) => {
    const mintRequests: ModelRequest[] = [];
    const minter = provider((_request, index) => {
      const steps: Output[] = [
        [
          signInStep(
            { fields: [{ selector: "#username", accepts: ["email"] }], submit: "#next" },
            "identifier",
          ),
        ],
        [
          signInStep(
            { fields: [{ selector: "#password", slot: "password" }], submit: "#sign-in" },
            "password",
          ),
        ],
        [signInStep({ signedIn: { selector: "#account" } }, "signed_in")],
      ];
      return steps[index] ?? [message("Stopping here.")];
    }, mintRequests);
    const reviewer = recordingGuardian();
    const asked: InputRequest[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createBrowserEngine({
            browser: { endpoint },
            minterProvider: minter,
            guardianProvider: reviewer.provider,
            outcomeReviewerProvider: quietReviewer,
            ask: answers(asked),
            timeoutMs: 30_000,
          });
          // The password screen shows the typed email in its text, label and placeholder.
          yield* service.mint({
            url: `${shop.origin}/sign-in`,
            intent: "Read the account",
            effect: "read",
            input: {},
          });
        }),
      ),
    );
    expect(asked.map(({ questions }) => questions)).toEqual([[loginQuestion(shop.origin)]]);
    expect(objects(toolResult(mintRequests, "password"))).toContainEqual(
      expect.objectContaining({ outcome: "filled", submit: "clicked" }),
    );
    expect(shop.state.sessionPosts).toBe(1);
    expect(objects(toolResult(mintRequests, "signed_in"))).toContainEqual(
      expect.objectContaining({ signedIn: true }),
    );
    // Guardian read the password screen, with the email it shows masked.
    const passwordReview = reviewer.reviews.find((review) =>
      review.reads.some(
        (read) =>
          read["path"] === "operation/sign-in-step.json" &&
          String(read["source"]).includes("#password"),
      ),
    );
    const screen = String(passwordReview?.reads.map((read) => read["source"]).join("\n"));
    expect(screen).toContain("[private]");
    expect(screen).not.toContain(shopAccount.username);
    // Its review says the host fills the login's values, which the review never shows.
    expect(String(passwordReview?.input["untrusted_observations"])).toContain(
      "never appear in this review",
    );
    for (const text of [JSON.stringify(mintRequests), JSON.stringify(reviewer.reviews)]) {
      expect(text).not.toContain(shopAccount.username);
      expect(text).not.toContain(shopAccount.password);
    }
  });
});

/** An exploration that opens `path` on the shop. */
const openPage = (name: string, path: string) => `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:${JSON.stringify(name)},input:Schema.Struct({}),output:Schema.Struct({done:Schema.Boolean})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:${JSON.stringify(
    `await page.goto(new URL(${JSON.stringify(path)}, page.url()).href); return true;`,
  )},timeout_sec:15});
  if(!response.success) throw new Error(String(response.error));
  return {done:true};
});`;
/** Returns the address the primary tab shows. */
const readWhere = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"read_where",input:Schema.Struct({}),output:Schema.Struct({where:Schema.String})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:"const url = new URL(page.url()); return url.pathname + url.search;",timeout_sec:15});
  if(!response.success) throw new Error(String(response.error));
  return {where:String(response.result)};
});`;
const create = (path: string, content: string, callId: string): Output[number] => ({
  type: "apply_patch_call",
  callId,
  status: "completed",
  operation: {
    type: "create_file",
    path,
    diff: `${content
      .split("\n")
      .map((line) => `+${line}`)
      .join("\n")}\n`,
  },
});
/** The explorations the marker tests run: the search page, the account page and where it is. */
const markerFiles: Output = [
  create("explore/search.mjs", openPage("open_search", "/search?q=lamp"), "patch_search"),
  create("explore/account.mjs", openPage("open_account", "/account"), "patch_account"),
  create("explore/where.mjs", readWhere, "patch_where"),
];
const explore = (name: "search" | "account" | "where", callId = `explore_${name}`) =>
  execute(
    "explore",
    { entrypoint: `explore/${name}.mjs`, intent: `Run the ${name} exploration` },
    callId,
  );
const signInFields = (callId = "sign_in") =>
  signInStep(
    {
      fields: [
        { selector: "input[name=username]", accepts: ["username"] },
        { selector: "input[name=password]", slot: "password" },
      ],
      submit: "button",
    },
    callId,
  );
const checkMarker = (marker: object, callId: string) =>
  call("check_signed_in_marker", { intent: "Test the signed-in marker", ...marker }, callId);
/** The host's answer to the minter's marker check `callId`. */
const markerResult = (requests: readonly ModelRequest[], callId: string) =>
  objects(toolResult(requests, callId)).find((item) => item["kind"] === "host_signed_in_marker");
/**
 * Mints the shop in one session, one build for each of `builds`: each from its `url`, a read
 * unless its `effect` says otherwise, with a minter that plays its `steps`, one per model request.
 * Returns each build's requests.
 */
const markerSession = async (
  endpoint: string,
  builds: readonly {
    readonly url: string;
    readonly effect?: "read" | "write";
    readonly steps: readonly (Output | (() => Output))[];
  }[],
  outcomeReviewer: ModelProvider = quietReviewer,
) => {
  const requests: ModelRequest[][] = builds.map(() => []);
  let build = 0;
  const minter = provider((request) => {
    const own = requests[build] ?? [];
    own.push(request);
    const step = builds[build]?.steps[own.length - 1] ?? [message("Stopping here.")];
    return typeof step === "function" ? step() : step;
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* createBrowserEngine({
          browser: { endpoint },
          minterProvider: minter,
          guardianProvider: guardian(),
          outcomeReviewerProvider: outcomeReviewer,
          ask: answers([]),
          timeoutMs: 45_000,
        });
        for (const [index, { url, effect = "read" }] of builds.entries()) {
          build = index;
          yield* service.mint({ url, intent: "Read the account", effect, input: {} });
        }
      }),
    ),
  );
  return requests;
};
/** Mints a read of the shop from `url` with a minter that plays `steps`, one per model request. */
const markerBuild = async (
  endpoint: string,
  url: string,
  steps: readonly (Output | (() => Output))[],
) => (await markerSession(endpoint, [{ url, steps }]))[0] ?? [];

test("the local minter's marker check before the signedIn step compares a page explored once the login was sent", async () => {
  test.info().annotations.push({
    type: "slow",
    description:
      "Original SDKs, Chromium, a host sign-in, two marker checks and three explorations",
  });
  test.setTimeout(60_000);
  await withShop(async (shop, endpoint) => {
    // The skill's order: sign in, explore signed in, test the marker, then send it.
    const mintRequests = await markerBuild(endpoint, `${shop.origin}/login`, [
      markerFiles,
      [signInFields()],
      [explore("search")],
      [explore("account")],
      // The search page, explored after the login was sent, lacks the account page's element.
      [checkMarker({ selector: "#account", openPath: "/account" }, "account")],
      // The sign-in page the host saw before typing shows it.
      [checkMarker({ selector: "body" }, "shared")],
      // Sent anyway, the signedIn step refuses it too, and the sign-in stays open.
      [signInStep({ signedIn: { selector: "body" } }, "signed_in_shared")],
      [signInStep({ signedIn: { selector: "#account" } }, "signed_in")],
      [explore("where")],
    ]);
    expect(markerResult(mintRequests, "account")).toEqual({
      kind: "host_signed_in_marker",
      status: "refused",
      signedOutSnapshot: "absent",
      signedInNow: true,
      freshLoad: true,
      secondPage: false,
      refusals: ["marker_missing_on_second_page"],
    });
    expect(markerResult(mintRequests, "shared")).toEqual({
      kind: "host_signed_in_marker",
      status: "refused",
      signedOutSnapshot: "matches",
      signedInNow: true,
      freshLoad: true,
      secondPage: true,
      refusals: ["marker_matches_signed_out_page"],
    });
    expect(objects(toolResult(mintRequests, "signed_in_shared"))).toContainEqual(
      expect.objectContaining({ signedIn: false, failed: "marker_matches_signed_out_page" }),
    );
    expect(objects(toolResult(mintRequests, "signed_in"))).toContainEqual(
      expect.objectContaining({ signedIn: true }),
    );
    // The checks left the agent on the account page, where it was.
    expect(objects(toolResult(mintRequests, "explore_where"))).toContainEqual({
      where: "/account",
    });
    // The checks only loaded pages: one sign-in, and no value reached the minter.
    expect(shop.state.loginPosts).toBe(1);
    expect(JSON.stringify(mintRequests)).not.toContain(shopAccount.password);
  });
});

test("the local minter's marker check after the signedIn step compares the signed-out sign-in page, a fresh load and another signed-in page", async () => {
  test.info().annotations.push({
    type: "slow",
    description:
      "Original SDKs, Chromium, a host sign-in, four marker checks and three explorations",
  });
  test.setTimeout(60_000);
  await withShop(async (shop, endpoint) => {
    const mintRequests = await markerBuild(endpoint, `${shop.origin}/login`, [
      [signInFields()],
      [signInStep({ signedIn: { selector: "#account" } }, "signed_in")],
      // The sign-in page the host saw before typing shows it too.
      [checkMarker({ selector: "body" }, "shared")],
      [checkMarker({ selector: "#account", openPath: "/account" }, "account")],
      // XPath is beyond the signed-out page's match, so that page leaves it unchecked.
      [checkMarker({ selector: "xpath=//p[@id='account']", openPath: "/account" }, "xpath")],
      markerFiles,
      [explore("search")],
      [explore("account")],
      // The search page, visited signed in, doesn't show the account page's own element.
      [checkMarker({ selector: "#account", openPath: "/account" }, "second")],
      [explore("where")],
    ]);
    expect(objects(toolResult(mintRequests, "signed_in"))).toContainEqual(
      expect.objectContaining({ signedIn: true }),
    );
    expect(markerResult(mintRequests, "shared")).toEqual(
      expect.objectContaining({
        status: "refused",
        signedOutSnapshot: "matches",
        signedInNow: true,
        freshLoad: true,
        refusals: ["marker_matches_signed_out_page"],
      }),
    );
    // The shared check loaded the root, then went back to the account page, which shows the
    // marker now. No other page was visited signed in yet, so there is no second page.
    expect(markerResult(mintRequests, "account")).toEqual({
      kind: "host_signed_in_marker",
      status: "passed",
      signedOutSnapshot: "absent",
      signedInNow: true,
      freshLoad: true,
    });
    expect(markerResult(mintRequests, "xpath")).toEqual({
      kind: "host_signed_in_marker",
      status: "passed_unchecked",
      signedOutSnapshot: "unchecked",
      signedInNow: true,
      freshLoad: true,
      warnings: ["signed_out_page_unchecked"],
    });
    expect(markerResult(mintRequests, "second")).toEqual({
      kind: "host_signed_in_marker",
      status: "refused",
      signedOutSnapshot: "absent",
      signedInNow: true,
      freshLoad: true,
      secondPage: false,
      refusals: ["marker_missing_on_second_page"],
    });
    expect(objects(toolResult(mintRequests, "explore_where"))).toContainEqual({
      where: "/account",
    });
    expect(shop.state.loginPosts).toBe(1);
    expect(JSON.stringify(mintRequests)).not.toContain(shopAccount.password);
  });
});

test("the local minter's marker check waits for a loaded page that draws the marker seconds later", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium, a host sign-in and a marker check that waits 4 seconds",
  });
  test.setTimeout(60_000);
  await withShop(async (shop, endpoint) => {
    const mintRequests = await markerBuild(endpoint, `${shop.origin}/login`, [
      [signInFields()],
      [signInStep({ signedIn: { selector: "#account" } }, "signed_in")],
      () => {
        // The account page, loaded again, draws its element 4 seconds after its script runs. A
        // check that loaded it again would start that wait over and never see the element.
        shop.state.accountRenderMs = 4_000;
        return [checkMarker({ selector: "#account", openPath: "/account" }, "account")];
      },
    ]);
    expect(markerResult(mintRequests, "account")).toEqual({
      kind: "host_signed_in_marker",
      status: "passed",
      signedOutSnapshot: "absent",
      signedInNow: true,
      freshLoad: true,
    });
  });
});

test("a later build in the same session keeps no signed-in page as a signed-out page", async () => {
  test.info().annotations.push({
    type: "slow",
    description:
      "Original SDKs, Chromium and two scripted builds with host sign-ins in one session",
  });
  test.setTimeout(90_000);
  await withShop(async (shop, endpoint) => {
    const [, later] = await markerSession(endpoint, [
      {
        url: `${shop.origin}/login`,
        steps: [
          [signInFields()],
          [signInStep({ signedIn: { selector: "#account" } }, "signed_in")],
        ],
      },
      {
        // The session is still signed in, so the account page shows the account, and the first
        // sign-in step finds no form there.
        url: `${shop.origin}/account`,
        steps: [
          [signInFields()],
          [create("explore/login.mjs", openPage("open_login", "/login"), "patch_login")],
          [
            execute(
              "explore",
              { entrypoint: "explore/login.mjs", intent: "Open the sign-in page" },
              "explore_login",
            ),
          ],
          [signInFields("sign_in_again")],
          [checkMarker({ selector: "#account", openPath: "/account" }, "account")],
        ],
      },
    ]);
    if (later === undefined) throw new Error("No later build");
    expect(objects(toolResult(later, "sign_in"))).toContainEqual(
      expect.objectContaining({ outcome: "refused", reason: "not_found" }),
    );
    // The account page the later build started on was signed in, so it is no signed-out page.
    // The build has none, and the marker passes unchecked.
    expect(markerResult(later, "account")).toEqual({
      kind: "host_signed_in_marker",
      status: "passed_unchecked",
      signedOutSnapshot: "unchecked",
      signedInNow: true,
      freshLoad: true,
      warnings: ["signed_out_page_unchecked"],
    });
    expect(shop.state.loginPosts).toBe(2);
  });
});

/** A shop write's path: one order, as a write build's first act step declares it. */
const shopPath = {
  steps: [{ commit: "place-order", does: "Places the order" }],
  ends: "The shop's order confirmation",
};

test("the local minter's marker check loads no page once the write session started", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium, a host sign-in, two act steps and a marker check",
  });
  test.setTimeout(60_000);
  await withShop(async (shop, endpoint) => {
    let searchLoads: number | undefined;
    const [build] = await markerSession(endpoint, [
      {
        url: `${shop.origin}/login`,
        effect: "write",
        steps: [
          [
            create("src/search.mjs", openPage("open_search", "/search?q=lamp"), "patch_search"),
            create("src/account.mjs", openPage("open_account", "/account"), "patch_account"),
          ],
          [signInFields()],
          [signInStep({ signedIn: { selector: "#account" } }, "signed_in")],
          // An act step leaves the search page, whose load a site could take as an action.
          [
            execute(
              "act",
              { entrypoint: "src/search.mjs", intent: "Search the shop", writePath: shopPath },
              "act_search",
            ),
          ],
          [
            execute(
              "act",
              { entrypoint: "src/account.mjs", intent: "Open the account" },
              "act_account",
            ),
          ],
          () => {
            searchLoads = shop.state.searchPageLoads;
            return [checkMarker({ selector: "#account", openPath: "/account" }, "account")];
          },
        ],
      },
    ]);
    if (build === undefined) throw new Error("No build");
    expect(objects(toolResult(build, "act_account"))).toContainEqual(
      expect.objectContaining({ status: "completed" }),
    );
    expect(searchLoads).toBe(1);
    // The next act step continues the page as it is, so the check loads nothing: not the
    // marker's page, and not the search page the earlier act step left.
    expect(shop.state.searchPageLoads).toBe(1);
    expect(objects(toolResult(build, "account"))).toContainEqual(
      expect.objectContaining({ status: "tool_failed", code: "Unavailable" }),
    );
  });
});

// Catches a host-filled sign-in screen reaching the outcome reviewer without its action label:
// the dispatch fence must carry the host's own `authentication` allow, not nothing.
test("a sign-in screen the host fills while a write is unresolved reaches the outcome reviewer labelled authentication", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium, an act step, a host sign-in and an outcome review turn",
  });
  test.setTimeout(60_000);
  await withShop(async (shop, endpoint) => {
    const reviewerRequests: ModelRequest[] = [];
    const reviewer = provider(() => [message("No assessment yet.")], reviewerRequests);
    const [build] = await markerSession(
      endpoint,
      [
        {
          url: `${shop.origin}/login`,
          effect: "write",
          steps: [
            [create("src/login.mjs", openPage("open_login", "/login"), "patch_login")],
            // Guardian labels the act step a write, which stays unresolved: the reviewer never
            // assesses.
            [
              execute(
                "act",
                { entrypoint: "src/login.mjs", intent: "Open the sign-in page", writePath: shopPath },
                "act_login",
              ),
            ],
            [signInFields()],
            // A repeat of the write waits for the reviewer to take every event so far.
            [
              execute(
                "act",
                { entrypoint: "src/login.mjs", intent: "Open the sign-in page" },
                "act_again",
              ),
            ],
          ],
        },
      ],
      reviewer,
    );
    if (build === undefined) throw new Error("No build");
    expect(objects(toolResult(build, "act_login"))).toContainEqual(
      expect.objectContaining({ status: "completed" }),
    );
    expect(shop.state.loginPosts).toBe(1);
    const events = objects(reviewerRequests.map((request) => request.input))
      .flatMap((value) => {
        const turn = value["outcome_review_turn"] as { readonly events?: unknown } | undefined;
        return turn === undefined ? [] : objects(turn.events);
      })
      .filter((event) => event["kind"] === "execution");
    expect(events).toContainEqual(
      expect.objectContaining({ purpose: "authenticate", action: "authentication" }),
    );
  });
});

/** A live test of where the page is, which resets the browser and loads the site's root first. */
const testWhere = execute(
  "test",
  { entrypoint: "explore/where.mjs", intent: "Read where a live test starts" },
  "test_where",
);

test("a sign-in screen on another origin and a root that failed to load are no signed-out pages", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium, a live test, a host sign-in and a marker check",
  });
  test.setTimeout(60_000);
  await withShop(async (shop, endpoint) => {
    shop.state.home = "broken";
    const signInSite = `https://${signInHost}:${shop.port}/login`;
    const mintRequests = await markerBuild(endpoint, `${shop.origin}/login`, [
      [
        ...markerFiles,
        create("explore/sign-in-site.mjs", openPage("open_sign_in", signInSite), "patch_sign_in"),
      ],
      // The test's reset loads the root, which fails and leaves a blank page.
      [testWhere],
      [
        execute(
          "explore",
          { entrypoint: "explore/sign-in-site.mjs", intent: "Open the sign-in site" },
          "explore_sign_in",
        ),
      ],
      [signInFields()],
      [checkMarker({ selector: "#account", openPath: "/account" }, "account")],
    ]);
    expect(objects(toolResult(mintRequests, "sign_in"))).toContainEqual(
      expect.objectContaining({ outcome: "filled", submit: "clicked" }),
    );
    // Neither page could show the shop's own pages signed out, so the check has none.
    expect(markerResult(mintRequests, "account")).toEqual(
      expect.objectContaining({
        signedOutSnapshot: "unchecked",
        warnings: ["signed_out_page_unchecked"],
      }),
    );
  });
});

for (const [home, renderMs, shell] of [
  ["late", 300, "an empty shell"],
  ["splash", 300, "a splash screen that shows Loading…"],
  ["splash", 1500, "a splash screen that shows Loading… for 1.5 seconds"],
  // It never goes 1.5 seconds without a change, so the host reads it when its wait ends.
  ["ticking", 1000, "a splash screen beside a counter that never stops"],
] as const)
  test(`a client-rendered root counts as signed out once it renders past ${shell}`, async () => {
    test.info().annotations.push({
      type: "slow",
      description: "Original SDKs, Chromium, a live test, a host sign-in and a marker check",
    });
    test.setTimeout(60_000);
    await withShop(async (shop, endpoint) => {
      shop.state.home = home;
      shop.state.homeRenderMs = renderMs;
      const mintRequests = await markerBuild(endpoint, `${shop.origin}/login`, [
        [
          ...markerFiles,
          create("explore/login.mjs", openPage("open_login", "/login"), "patch_login"),
        ],
        // The test's reset loads the root, which renders its header only after it loads.
        [testWhere],
        [
          execute(
            "explore",
            { entrypoint: "explore/login.mjs", intent: "Open the sign-in page" },
            "explore_login",
          ),
        ],
        [signInFields()],
        [checkMarker({ selector: "#account", openPath: "/account" }, "account")],
      ]);
      // The rendered root shows its Account link signed out too.
      expect(markerResult(mintRequests, "account")).toEqual({
        kind: "host_signed_in_marker",
        status: "refused",
        signedOutSnapshot: "matches",
        signedInNow: true,
        freshLoad: true,
        refusals: ["marker_matches_signed_out_page"],
      });
    });
  });

for (const [home, renderMs, root, selector] of [
  ["ticking", 5000, "keeps changing and renders its header after the wait", "#account"],
  ["hang", 0, "never ends its load", "#account"],
  // Read as soon as it shows its header, a root may still show more, such as the account page's
  // own element.
  ["late", 2500, "shows nothing until its document went quiet", "p#account"],
] as const)
  test(`a root that ${root} proves no marker absent`, async () => {
    test.info().annotations.push({
      type: "slow",
      description:
        "Original SDKs, Chromium and two scripted builds with host sign-ins in one session",
    });
    test.setTimeout(90_000);
    await withShop(async (shop, endpoint) => {
      shop.state.home = home;
      shop.state.homeRenderMs = renderMs;
      const [, later] = await markerSession(endpoint, [
        // This build types the login, so the next keeps no sign-in screen's page.
        {
          url: `${shop.origin}/login`,
          steps: [
            [signInFields()],
            [signInStep({ signedIn: { selector: "#account" } }, "signed_in")],
          ],
        },
        {
          url: `${shop.origin}/login`,
          steps: [
            [
              ...markerFiles,
              create("explore/login.mjs", openPage("open_login", "/login"), "patch_login"),
            ],
            // The test's reset signs the browser out and loads the root: the build's only
            // signed-out page.
            [testWhere],
            [
              execute(
                "explore",
                { entrypoint: "explore/login.mjs", intent: "Open the sign-in page" },
                "explore_login",
              ),
            ],
            [signInFields()],
            [checkMarker({ selector, openPath: "/account" }, "account")],
          ],
        },
      ]);
      if (later === undefined) throw new Error("No later build");
      expect(objects(toolResult(later, "test_where"))).toContainEqual({ where: "/" });
      // The host never saw the root settle, and it lacked the marker when read, so it proves
      // nothing absent and the marker passes unchecked.
      expect(markerResult(later, "account")).toEqual({
        kind: "host_signed_in_marker",
        status: "passed_unchecked",
        signedOutSnapshot: "unchecked",
        signedInNow: true,
        freshLoad: true,
        warnings: ["signed_out_page_unchecked"],
      });
      expect(shop.state.loginPosts).toBe(2);
    });
  });

test("a root whose load never ends is kept within the wait, and the browser keeps working", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium, a live test, an exploration, a host sign-in and a check",
  });
  test.setTimeout(60_000);
  await withShop(async (shop, endpoint) => {
    // The root shows an image whose request never answers, so neither its load nor a quiet
    // network ever comes.
    shop.state.home = "hang";
    const mintRequests = await markerBuild(endpoint, `${shop.origin}/login`, [
      [
        ...markerFiles,
        create("explore/login.mjs", openPage("open_login", "/login"), "patch_login"),
      ],
      [testWhere],
      [
        execute(
          "explore",
          { entrypoint: "explore/login.mjs", intent: "Open the sign-in page" },
          "explore_login",
        ),
      ],
      [signInFields()],
      [checkMarker({ selector: "#account", openPath: "/account" }, "account")],
    ]);
    expect(objects(toolResult(mintRequests, "test_where"))).toContainEqual({ where: "/" });
    // The host gave up its waits in time, so the browser still runs the next steps.
    expect(objects(toolResult(mintRequests, "explore_login"))).toContainEqual(
      expect.objectContaining({ executionId: expect.any(String), status: "completed" }),
    );
    expect(markerResult(mintRequests, "account")).toEqual({
      kind: "host_signed_in_marker",
      status: "passed",
      signedOutSnapshot: "absent",
      signedInNow: true,
      freshLoad: true,
    });
    expect(JSON.stringify(mintRequests)).not.toContain("invalidated");
  });
});

/** An exploration that posts an empty form to the shop's search page, as a search form may. */
const postSearch = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"post_search",input:Schema.Struct({}),output:Schema.Struct({done:Schema.Boolean})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:${JSON.stringify(
    `await Promise.all([page.waitForURL("**/search?q=lamp"), page.evaluate(() => { const form = document.createElement("form"); form.method = "post"; form.action = "/search?q=lamp"; document.body.append(form); form.submit(); })]); return true;`,
  )},timeout_sec:15});
  if(!response.success) throw new Error(String(response.error));
  return {done:true};
});`;

test("the local minter's marker check leaves a form's answer where its loads left the tab", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium, a host sign-in, two explorations and a marker check",
  });
  test.setTimeout(60_000);
  await withShop(async (shop, endpoint) => {
    let searchLoads: number | undefined;
    const mintRequests = await markerBuild(endpoint, `${shop.origin}/login`, [
      [...markerFiles, create("explore/post-search.mjs", postSearch, "patch_post_search")],
      [signInFields()],
      [signInStep({ signedIn: { selector: "#account" } }, "signed_in")],
      [
        execute(
          "explore",
          { entrypoint: "explore/post-search.mjs", intent: "Post the search form" },
          "explore_post_search",
        ),
      ],
      () => {
        searchLoads = shop.state.searchPageLoads;
        return [checkMarker({ selector: "#results" }, "results")];
      },
      [explore("where")],
    ]);
    expect(searchLoads).toBe(1);
    expect(markerResult(mintRequests, "results")).toEqual(
      expect.objectContaining({ signedInNow: true, freshLoad: false }),
    );
    // The search page answered the form's post, so its address alone would send a GET in its
    // place: the host leaves the tab on the root it loaded.
    expect(shop.state.searchPageLoads).toBe(1);
    expect(objects(toolResult(mintRequests, "explore_where"))).toContainEqual({ where: "/" });
  });
});

/** Types the code the agent was given into the shop's code screen, then submits it. */
const typeCode = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"type_code",input:Schema.Struct({}),output:Schema.Struct({done:Schema.Boolean})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:${JSON.stringify(
    "await page.locator('input[name=code]').fill('{{secret.s1}}'); await Promise.all([page.waitForURL('**/account'), page.locator('button').click()]); return true;",
  )},timeout_sec:15});
  if(!response.success) throw new Error(String(response.error));
  return {done:true};
});`;
/** How the code screen's sign-in finishes: a code sign-in step, or a code an exploration types. */
const codeEntries: readonly (readonly [string, readonly Output[]])[] = [
  [
    "a code sign-in step",
    [
      [
        signInStep(
          { fields: [{ selector: "input[name=code]", slot: "code" }], submit: "button" },
          "code",
        ),
      ],
    ],
  ],
  [
    "a code an exploration types",
    [
      [
        call(
          "request_input",
          {
            intent: "Ask for the code the shop sent to finish signing in",
            questions: [
              {
                id: "code",
                type: "secret",
                secretKind: "one_time_code",
                prompt: "Enter the code the shop sent you to finish signing in.",
              },
            ],
          },
          "ask_code",
        ),
      ],
      // Written once the code's handle is issued.
      [create("explore/type-code.mjs", typeCode, "patch_type_code")],
      [
        execute(
          "explore",
          { entrypoint: "explore/type-code.mjs", intent: "Type the code the shop sent" },
          "code",
        ),
      ],
    ],
  ],
];

for (const [entry, codeSteps] of codeEntries)
  test(`${entry} forgets the code screen explored before it, so the marker check never loads it`, async () => {
    test.info().annotations.push({
      type: "slow",
      description: "Original SDKs, Chromium, a host sign-in with a code screen and a marker check",
    });
    test.setTimeout(60_000);
    await withShop(async (shop, endpoint) => {
      shop.state.loginCode = true;
      let codeLoads: number | undefined;
      const mintRequests = await markerBuild(endpoint, `${shop.origin}/login`, [
        markerFiles,
        // The password goes first: the login is sent, and the shop shows its code screen.
        [signInFields()],
        [explore("where", "explore_code_screen")],
        ...codeSteps,
        [explore("account")],
        () => {
          codeLoads = shop.state.codePageLoads;
          return [checkMarker({ selector: "#account", openPath: "/account" }, "account")];
        },
        [signInStep({ signedIn: { selector: "#account" } }, "signed_in")],
      ]);
      expect(objects(toolResult(mintRequests, "explore_code_screen"))).toContainEqual({
        where: "/two-factor",
      });
      expect(objects(toolResult(mintRequests, "code"))).toContainEqual(
        expect.objectContaining({ executionId: expect.any(String), status: "completed" }),
      );
      expect(codeLoads).toBe(1);
      // The code finished the sign-in, so the code screen explored before it is no signed-in
      // page: the check has no other page than the account page it loads fresh.
      expect(markerResult(mintRequests, "account")).toEqual({
        kind: "host_signed_in_marker",
        status: "passed",
        signedOutSnapshot: "absent",
        signedInNow: true,
        freshLoad: true,
      });
      expect(shop.state.codePageLoads).toBe(1);
      expect(objects(toolResult(mintRequests, "signed_in"))).toContainEqual(
        expect.objectContaining({ signedIn: true }),
      );
      expect(JSON.stringify(mintRequests)).not.toContain(shopCode);
    });
  });

for (const [entry, step] of [
  ["a rejected value", { rejected: { slot: "password" } }],
  ["an approval", { approval: "device" }],
] as const)
  test(`${entry} forgets the pages explored before it, so the marker check never loads them`, async () => {
    test.info().annotations.push({
      type: "slow",
      description: "Original SDKs, Chromium, a host sign-in, two explorations and a marker check",
    });
    test.setTimeout(60_000);
    await withShop(async (shop, endpoint) => {
      let searchLoads: number | undefined;
      const mintRequests = await markerBuild(endpoint, `${shop.origin}/login`, [
        markerFiles,
        [signInFields()],
        [explore("search")],
        // The sign-in goes on: the pages explored before this step may be screens of it.
        [signInStep(step, "sign_in_step")],
        [explore("account")],
        () => {
          searchLoads = shop.state.searchPageLoads;
          return [checkMarker({ selector: "#account", openPath: "/account" }, "account")];
        },
      ]);
      expect(objects(toolResult(mintRequests, "sign_in_step"))).toContainEqual(
        expect.objectContaining({ executionId: expect.any(String), status: "completed" }),
      );
      expect(searchLoads).toBe(1);
      // The search page was explored before the step, so the check has no other page.
      expect(markerResult(mintRequests, "account")).toEqual({
        kind: "host_signed_in_marker",
        status: "passed",
        signedOutSnapshot: "absent",
        signedInNow: true,
        freshLoad: true,
      });
      expect(shop.state.searchPageLoads).toBe(1);
    });
  });
