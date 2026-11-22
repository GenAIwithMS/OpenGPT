import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { createServer as createTlsServer } from "node:https";
import { promisify } from "node:util";
import { test, expect } from "@playwright/test";
import { chromium } from "playwright";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { startShop, shopAccount, shopHelpLinks } from "./shop-fixture.js";
import { Usage } from "@openai/agents";
import type { ModelProvider, ModelRequest, ModelResponse } from "@openai/agents";
import { Effect, Schema } from "effect";
import { createBrowserEngine } from "../../src/standalone/engine.js";
import { RunOutcomeFailure } from "../../src/standalone/run-report.js";
import { CalendarDate } from "../../src/browser/index.js";
import { contractJsonSchema } from "../../src/runtime/operation.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import type { InputRequest } from "../../src/runtime/input-request.js";
import { InputRequest as InputRequestSchema } from "../../src/runtime/input-request.js";
import { makeMcpJobs } from "../../src/standalone/mcp-jobs.js";
import { pageControlsLimit, pageControlTextLimit } from "../../src/destinations/page-controls.js";
import { prepareIntegration } from "../../src/standalone/mcp-package.js";
import { writeArtifact } from "../../src/standalone/artifact-files.js";
import {
  actionFor,
  call as fixtureCall,
  currentOf,
  execution as fixtureExecution,
  executionIdOf,
  headingOperation,
  html,
  patch as patchFiles,
  probe,
  quietReviewer,
  recordingGuardian,
  startSite,
} from "./guardian-context-fixture.js";
import { mint as mintWith } from "./standalone-mint-fixture.js";
import { loadStandaloneAuthoring } from "../../src/mint/skills.js";
import { getAuthoringDirectory } from "../../src/assets.js";
import { instructionsOf } from "../support/guardian-requests.js";
import {
  guardianExecutionPolicy,
  nativeExecutionEnvironment,
} from "../../src/guardian/execution-policy.js";

/** A write fixture's path: its one save, as a write build's first act step declares it. */
const savePath = {
  steps: [{ commit: "save", does: "Saves the fixture" }],
  ends: "The site's confirmation of the save",
};

const message = (text: string): ModelResponse["output"][number] => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text }],
});
const call = (name: string, input: unknown, callId = name): ModelResponse["output"][number] => ({
  type: "function_call",
  name,
  callId,
  arguments: JSON.stringify(input),
  status: "completed",
});
const provider = (
  respond: (request: ModelRequest, index: number) => ModelResponse["output"],
  requests: ModelRequest[],
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
/**
 * The minter's instructions as the model receives them: the text of the developer message that
 * leads every request's input, where they travel instead of the top-level instructions field.
 */
const minterInstructions = (request: ModelRequest | undefined) => {
  const [leading] = Array.isArray(request?.input) ? request.input : [];
  const message = leading?.type === "unknown" ? leading.providerData : undefined;
  if (message?.["type"] !== "message" || message["role"] !== "developer") return "";
  return objects(message["content"])
    .map((part) => part["text"])
    .filter((text) => typeof text === "string")
    .join("\n\n");
};
/** The standalone host tells Guardian it runs natively. A hosted review gets the hosted policy. */
const reviewedNative = (request: ModelRequest) =>
  objects(request.input).find((item) => "trusted_execution_environment" in item)?.[
    "trusted_execution_environment"
  ] === "native";
const guardian = (
  requests: ModelRequest[],
  outcome: "allow" | "deny" | ((request: ModelRequest) => "allow" | "deny") = "allow",
) => {
  let sourcePending = false;
  return provider((request, index) => {
    const current = objects(request.input)
      .filter((item) => "submitted_call" in item)
      .at(-1);
    if (current !== undefined && "question_review" in current)
      return [
        message(
          JSON.stringify({ outcome: "allow_business", rationale: "Caller chooses read authority" }),
        ),
      ];
    if (sourcePending) {
      sourcePending = false;
      const decided = typeof outcome === "function" ? outcome(request) : outcome;
      return [
        message(
          JSON.stringify({
            outcome: reviewedNative(request) ? decided : "deny",
            rationale: "Recorded fixture review",
            ...actionFor(current),
          }),
        ),
      ];
    }
    sourcePending = true;
    const submission = objects(request.input)
      .filter((item) => "submitted_call" in item)
      .at(-1);
    const pending = objects(submission).find((item) => typeof item["entrypoint"] === "string");
    if (pending === undefined)
      throw new Error("Guardian did not receive its original review input");
    return [call("read_source", { path: pending["entrypoint"], offset: 0 }, `source_${index}`)];
  }, requests);
};
const operation = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
import { heading } from "./heading.mjs";
export default defineOperation({name:"read_fixture",input:Schema.Struct({}),output:Schema.Struct({heading:Schema.String})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:"return await page.locator('h1').textContent();",timeout_sec:2});
  if(!response.success) throw new Error(String(response.error));
  return {heading:heading(response.result)};
});`;
const patch = (authentication = false): ModelResponse["output"] =>
  [
    [
      "src/tool.mjs",
      authentication
        ? // A live example starts at the site root, so the script opens its own page.
          operation.replace(
            "return await page.locator('h1').textContent();",
            "await page.goto(new URL('/account', page.url()).href); return await page.title();",
          )
        : operation,
    ],
    ["src/heading.mjs", "export const heading = (value) => String(value).trim();"],
  ].map(([path, content], index) => ({
    type: "apply_patch_call",
    callId: `patch_${index}`,
    status: "completed",
    operation: {
      type: "create_file",
      path: path ?? "",
      diff:
        (content ?? "")
          .split("\n")
          .map((line) => `+${line}`)
          .join("\n") + "\n",
    },
  }));
const execution = {
  purpose: "example",
  target: "liveBrowser",
  entrypoint: "src/tool.mjs",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 10,
  intent: "Read the fixture heading",
};
const minter = (requests: ModelRequest[], authentication = false) =>
  provider((request, index) => {
    const steps: ModelResponse["output"][] = [];
    if (!authentication)
      steps.push([
        call("request_input", {
          intent: "Ask caller whether this tool reads or changes the site",
          questions: [
            {
              id: "effect",
              type: "choice",
              prompt: "Should this tool read the site or change it?",
              options: [
                { id: "read", label: "Read" },
                { id: "write", label: "Change" },
              ],
            },
          ],
        }),
      ]);
    steps.push(patch(authentication));
    if (authentication)
      steps.push(
        [
          call(
            "execute",
            {
              ...execution,
              purpose: "authenticate",
              signInStep: {
                fields: [
                  { selector: "input[name=username]", accepts: ["username"] },
                  { selector: "input[name=password]", slot: "password" },
                ],
                submit: "button",
              },
            },
            "sign_in",
          ),
        ],
        [
          call(
            "execute",
            {
              ...execution,
              purpose: "authenticate",
              signInStep: { signedIn: { selector: "#account" } },
            },
            "signed_in",
          ),
        ],
      );
    steps.push([call("execute", execution, "example")]);
    if (index < steps.length) return steps[index] ?? [];
    if (index === steps.length) {
      const receipts = objects(request.input).filter(
        (item) => typeof item["executionId"] === "string",
      );
      const receipt = receipts.at(-1);
      if (receipt === undefined) throw new Error("Original execute tool did not return a receipt");
      return [
        call("finish_build", {
          intent: "Return the fixture integration",
          entrypoint: "src/tool.mjs",
          executionId: receipt["executionId"],
          metadata: { name: "read_fixture", description: "Read local fixture heading" },
          coverage: "Actual native browser example",
        }),
      ];
    }
    return [message("Built the fixture integration.")];
  }, requests);

for (const [authentication, submitAfterInput] of [
  [false, false],
  [true, false],
  [true, true],
] as const) {
  test(`original SDKs mint a multi-file ${authentication ? "authenticated" : "public"} integration${submitAfterInput ? " whose sign-in button enables only after input" : ""} and run it`, async () => {
    test.info().annotations.push({
      type: "slow",
      description:
        "Original SDKs, Chromium and local operation lifecycles; default-effect answer waits11s beyond its injected10s active budget to verify caller waiting is excluded",
    });
    test.setTimeout(45_000);
    const log: string[] = [];
    const server = createServer((request, response) => {
      log.push(request.url ?? "");
      response.setHeader("Content-Type", "text/html");
      response.end(
        authentication && !request.headers.cookie?.includes("signed=yes")
          ? `<label>User<input id="username" autocomplete="username"></label><label>Password<input id="password" type="password" autocomplete="current-password"></label><button id="signin" onclick="document.cookie='signed=yes;path=/';document.body.innerHTML='<div id=signed-in>Signed in</div><h1>Account fixture</h1>';fetch('/signed-in')">Sign in</button>`
          : `<h1>${authentication ? "Account" : "Public"} fixture</h1>`,
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No fixture address");
    const fixtureURL = `http://127.0.0.1:${address.port}/`;
    const directory = await mkdtemp(join(tmpdir(), "opengpt-standalone-"));
    const shop = authentication ? await startShop(directory) : undefined;
    if (shop !== undefined && submitAfterInput) shop.state.loginSubmit = "after_input";
    const url = shop === undefined ? fixtureURL : `${shop.origin}/login`;
    const remote =
      shop === undefined
        ? undefined
        : await chromium.launchServer({
            args: [
              `--host-resolver-rules=MAP ${shop.hostname} 127.0.0.1`,
              "--no-proxy-server",
              "--ignore-certificate-errors",
            ],
          });
    const mintRequests: ModelRequest[] = [];
    const reviewRequests: ModelRequest[] = [];
    const asked: InputRequest[] = [];
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* createBrowserEngine({
              ...(remote === undefined ? {} : { browser: { endpoint: remote.wsEndpoint() } }),
              minterProvider: minter(mintRequests, authentication),
              guardianProvider: guardian(reviewRequests),
              outcomeReviewerProvider: quietReviewer,
              ask: makeInputAsker((request) =>
                Effect.sleep(authentication ? 0 : 11_000).pipe(
                  Effect.zipRight(
                    Effect.sync(() => {
                      asked.push(request);
                      return Object.fromEntries(
                        request.questions.map((question) => [
                          question.id,
                          question.id === "effect"
                            ? "read"
                            : question.type === "credential"
                              ? { ...shopAccount, saveLogin: false }
                              : shopAccount.password,
                        ]),
                      );
                    }),
                  ),
                ),
              ),
              timeoutMs: authentication ? 30_000 : 10_000,
            });
            const built = yield* service.mint({
              url,
              intent: "Read the fixture heading",
              ...(authentication ? { effect: "read" as const } : {}),
              input: {},
            });
            expect(
              built.build,
              JSON.stringify({
                built,
                toolResults: objects(mintRequests.at(-1)?.input).filter(
                  (item) => item["type"] === "function_call_result",
                ),
              }),
            ).toBe("published");
            expect(built.artifact?.files.map((file) => file.path)).toEqual(
              expect.arrayContaining(["src/tool.mjs", "src/heading.mjs"]),
            );
            if (built.artifact === undefined) throw new Error(JSON.stringify(built));
            const modelRequests = [mintRequests.length, reviewRequests.length];
            // The run checks its sign-in first: a signed-in session's visit to the sign-in page
            // lands on the account page, so the minting session's run asks nothing.
            if (shop !== undefined) shop.state.signedInLogin = "account";
            expect(
              yield* service.run(built.artifact, {
                url: shop === undefined ? url : `${shop.origin}/account`,
                intent: "Read the fixture heading",
                input: {},
              }),
            ).toEqual({ heading: authentication ? "Account" : "Public fixture" });
            // Guardian reviewed the source while minting. The run makes no model request.
            expect([mintRequests.length, reviewRequests.length]).toEqual(modelRequests);
            expect(JSON.stringify(built)).not.toContain(shopAccount.password);
          }),
        ),
      );
      expect(asked).toHaveLength(1);
      expect(JSON.stringify(mintRequests)).not.toContain(shopAccount.password);
      expect(JSON.stringify(reviewRequests)).not.toContain(shopAccount.password);
      if (shop !== undefined) {
        expect(shop.state.loginPosts).toBe(1);
        // Guardian judged the sign-in step against the screen the host observed: the page's
        // origin and what the submit is, never whether the page has enabled it yet.
        const reviewed = objects(reviewRequests.map((request) => request.input)).find(
          (item) => "step" in item && "screen" in item,
        );
        expect(reviewed?.["screen"]).toMatchObject({
          origin: shop.origin,
          submit: { tag: "button", text: "Sign in" },
        });
        expect(JSON.stringify(reviewed)).not.toContain("enabled");
      }
    } finally {
      await remote?.close();
      await shop?.close();
      await rm(directory, { recursive: true, force: true });
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
}

/** Records and fails any model request, as a host without a model key or provider would. */
const unreachableModel = (calls: string[], role: string): ModelProvider => ({
  getModel: () => {
    calls.push(role);
    throw new Error(`Unexpected ${role} model request during a run`);
  },
});

test("a run makes no Guardian or model call and returns the operation's output", async () => {
  let hits = 0;
  const calls: string[] = [];
  const server = createServer((_request, response) => {
    hits++;
    response.setHeader("Content-Type", "text/html");
    response.end("<h1>Run fixture</h1>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture address");
  try {
    const output = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createBrowserEngine({
            ask: makeInputAsker(() => Effect.succeed({})),
            minterProvider: unreachableModel(calls, "minter"),
            guardianProvider: unreachableModel(calls, "guardian"),
            outcomeReviewerProvider: quietReviewer,
            timeoutMs: 10_000,
          });
          return yield* service.run(
            {
              entrypoint: "src/tool.mjs",
              files: [
                { path: "src/tool.mjs", content: operation },
                {
                  path: "src/heading.mjs",
                  content: "export const heading = (value) => String(value).trim();",
                },
              ],
              inputSchema: {},
              outputSchema: {},
            },
            {
              url: `http://127.0.0.1:${address.port}/`,
              intent: "Read fixture",
              effect: "read",
              input: {},
            },
          );
        }),
      ),
    );
    expect(output).toEqual({ heading: "Run fixture" });
    expect(calls).toEqual([]);
    expect(hits).toBeGreaterThan(0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("a run asks only the questions its artifact recorded, or that its entrypoint declares as a literal", async () => {
  // Five runs, each in its own browser session.
  test.setTimeout(90_000);
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<h1>Run fixture</h1>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture address");
  const note = { type: "text" as const, prompt: "Which note should I keep?" };
  const asking = (questions: string) => `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
const computed = {note:{type:"text",prompt:"Which note should I keep?"}};
export default defineOperation({name:"ask_note",input:Schema.Struct({}),output:Schema.Struct({note:Schema.String}),questions:${questions}},
async ({ ask }) => ({ note: await ask("note") }));`;
  const literal = asking(JSON.stringify({ note }));
  const calls: string[] = [];
  const run = (
    content: string,
    questions?: Readonly<Record<string, unknown>>,
    effect?: "read",
  ) => {
    const asked: InputRequest[] = [];
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createBrowserEngine({
            ask: makeInputAsker((request) =>
              Effect.sync(() => {
                asked.push(request);
                return { note: "kept" };
              }),
            ),
            minterProvider: unreachableModel(calls, "minter"),
            guardianProvider: unreachableModel(calls, "guardian"),
            timeoutMs: 10_000,
          });
          return yield* Effect.either(
            service.run(
              {
                entrypoint: "src/tool.mjs",
                files: [{ path: "src/tool.mjs", content }],
                inputSchema: {},
                outputSchema: {},
                ...(questions === undefined ? {} : { questions }),
              } as Parameters<typeof service.run>[0],
              {
                url: `http://127.0.0.1:${address.port}/`,
                intent: "Read fixture",
                input: {},
                ...(effect === undefined ? {} : { effect }),
              },
            ),
          );
        }),
      ),
    ).then((result) => ({ result, asked }));
  };
  try {
    // Publication recorded the question: the run asks it.
    const recorded = await run(literal, { note });
    expect(recorded.result._tag === "Right" && recorded.result.right).toEqual({ note: "kept" });
    expect(recorded.asked).toHaveLength(1);
    // The script asks something other than what publication recorded: its ask fails as
    // Undeclared, so the run fails with nobody asked. A run that names no effect can't rule out
    // a website action, so its outcome is unknown.
    const differs = await run(literal, { note: { ...note, prompt: "Which note?" } });
    expect(differs.result._tag === "Left" && differs.result.left).toMatchObject({
      _tag: "RunOutcomeFailure",
      outcome: { code: "outcome_unknown", retry: "never" },
    });
    expect(differs.asked).toEqual([]);
    // A served read tool names its effect, so the same refused ask fails as a read that changed
    // nothing.
    const served = await run(literal, { note: { ...note, prompt: "Which note?" } }, "read");
    expect(served.result._tag === "Left" && served.result.left).toMatchObject({
      _tag: "RunOutcomeFailure",
      outcome: { code: "execution_failed", possibleCommit: false, retry: "never" },
    });
    expect(served.asked).toEqual([]);
    // An artifact saved without its questions asks what its entrypoint declares as a literal.
    const saved = await run(literal);
    expect(saved.result._tag).toBe("Right");
    expect(saved.asked).toHaveLength(1);
    const computed = await run(asking("computed"));
    expect(computed.result._tag === "Left" && computed.result.left).toMatchObject({
      _tag: "RunOutcomeFailure",
      outcome: { code: "outcome_unknown", retry: "never" },
    });
    expect(computed.asked).toEqual([]);
    expect(calls).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("terminal CLI help requires no provider credentials", async () => {
  const child = spawn(process.execPath, ["dist/typescript/src/standalone/cli.js", "--help"], {
    env: { PATH: process.env["PATH"] ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const closed: readonly unknown[] = await once(child, "close");
  const code = closed[0];
  expect(code, errors).toBe(0);
  expect(output).toContain("opengpt-browser-engine mint --url URL");
  expect(output).toContain("A run ignores --intent and --effect.");
});

/** Runs the built terminal CLI with only PATH, so it has no model key or provider. */
const terminal = async (args: readonly string[]) => {
  const child = spawn(process.execPath, ["dist/typescript/src/standalone/cli.js", ...args], {
    env: { PATH: process.env["PATH"] ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const closed: readonly unknown[] = await once(child, "close");
  return { code: closed[0], stdout, stderr };
};

test("terminal run needs no model key, provider or intent", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<h1>Terminal fixture</h1>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture address");
  const directory = await mkdtemp(join(tmpdir(), "opengpt-cli-run-"));
  const url = `http://127.0.0.1:${address.port}/`;
  try {
    await Effect.runPromise(
      Effect.scoped(
        writeArtifact(join(directory, "artifact"), {
          entrypoint: "src/tool.mjs",
          files: [
            { path: "src/tool.mjs", content: operation },
            {
              path: "src/heading.mjs",
              content: "export const heading = (value) => String(value).trim();",
            },
          ],
          inputSchema: {},
          outputSchema: {},
        }),
      ),
    );
    // A run ignores --effect, so even the mint-only value ask is accepted.
    const ran = await terminal([
      "run",
      "--artifact",
      join(directory, "artifact"),
      "--url",
      url,
      "--effect",
      "ask",
    ]);
    expect(ran.code, ran.stderr).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual({ heading: "Terminal fixture" });
    const minted = await terminal(["mint", "--url", url, "--out", join(directory, "minted")]);
    expect(minted.code).toBe(1);
    expect(minted.stderr).toContain("--intent is required to mint.");
    expect(await readdir(directory)).toEqual(["artifact"]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("terminal EOF ends an ordinary unanswered question", async () => {
  const script = `import { Effect } from "effect";
import { makeTerminalAsker } from "./dist/typescript/src/inputs/terminal.js";
const result = await Effect.runPromise(Effect.either(makeTerminalAsker()({id:"11111111-1111-4111-8111-111111111111",source:"system",questions:[{id:"name",type:"text",prompt:"Name?"}]})));
console.log(result._tag === "Left" ? result.left.code : "unexpected_answer");`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { PATH: process.env["PATH"] ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const closed: readonly unknown[] = await once(child, "close");
  expect(closed[0]).toBe(0);
  expect(output.trim()).toBe("NoResponse");
});

test("confirmed native write finishes a composed artifact after invalid output without replay", async () => {
  test.info().annotations.push({
    type: "slow",
    description:
      "Original model SDKs, native write confirmation and offline contract child; a real POST proves no write replay",
  });
  let writes = 0;
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/save") {
      writes++;
      response.end("saved");
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<button id="save" onclick="fetch('/save',{method:'POST'}).then(() => document.body.innerHTML='<div id=saved>Saved</div>')">Save</button>`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No write fixture address");
  const act = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"save_fixture",input:Schema.Struct({}),output:Schema.Struct({saved:Schema.Boolean}),write:{confirmation:"message",commits:["save"]}},
async ({kernel,sessionId,enteringCommit,verified}) => {
  enteringCommit("save");
  const result = await kernel.browsers.playwright.execute(sessionId,{code:"await page.locator('#save').click(); await page.locator('#saved').waitFor(); return true;",timeout_sec:2});
  if(!result.success || result.result !== true) throw new Error("Save not confirmed");
  verified({confirmation:"message"});
  return {saved:"invalid_output_after_confirmed_commit"};
});`;
  const final = act.replace('"invalid_output_after_confirmed_commit"', "true");
  const requests: ModelRequest[] = [];
  const patchSource = (path: string, content: string, id: string): ModelResponse["output"] => [
    {
      type: "apply_patch_call",
      callId: id,
      status: "completed",
      operation: {
        type: "create_file",
        path,
        diff:
          content
            .split("\n")
            .map((line) => `+${line}`)
            .join("\n") + "\n",
      },
    },
  ];
  const model = provider((request, index) => {
    if (index === 0) return patchSource("src/act.mjs", act, "act_source");
    if (index === 1)
      return [
        call(
          "execute",
          {
            ...execution,
            purpose: "act",
            entrypoint: "src/act.mjs",
            intent: "Save exactly once",
            writePath: savePath,
          },
          "act_once",
        ),
      ];
    if (index === 2) return patchSource("src/final.mjs", final, "composed_source");
    if (index === 3) {
      const receipt = objects(request.input)
        .filter((item) => typeof item["executionId"] === "string")
        .at(-1);
      if (receipt === undefined) throw new Error("Confirmed act receipt missing");
      return [
        call("finish_build", {
          intent: "Return composed write without executing it",
          entrypoint: "src/final.mjs",
          executionId: receipt["executionId"],
          metadata: { name: "save_fixture", description: "Save the fixture once" },
          coverage:
            "One live confirmed act; its invalid output was repaired in the composed contract",
        }),
      ];
    }
    return [message("Return the existing confirmed write artifact.")];
  }, requests);
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createBrowserEngine({
            minterProvider: model,
            guardianProvider: guardian([]),
            outcomeReviewerProvider: quietReviewer,
            ask: makeInputAsker(() => Effect.succeed({})),
          });
          const built = yield* service.mint({
            url: `http://127.0.0.1:${address.port}/`,
            intent: "Save the fixture once",
            effect: "write",
            input: {},
          });
          expect(
            built.build,
            JSON.stringify({
              built,
              results: objects(requests.at(-1)?.input).filter(
                (item) => item["type"] === "function_call_result",
              ),
            }),
          ).toBe("published");
          expect(built.artifact?.entrypoint).toBe("src/final.mjs");
          expect(built.executions).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ status: "failed", effect: "verified" }),
            ]),
          );
          expect(writes).toBe(1);
        }),
      ),
    );
    expect(writes).toBe(1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("a write runs the values the request gives, asks only the missing choice, and names the rejected input path without a second write", async () => {
  test.info().annotations.push({
    type: "slow",
    description:
      "Original model SDKs, native write, a script question and the offline contract child; a real POST proves no write replay",
  });
  test.setTimeout(60_000);
  const saved: string[] = [];
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/save") {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        saved.push(body);
        response.end("saved");
      });
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<button id="save" onclick="fetch('/save',{method:'POST',body:document.body.dataset.order}).then(() => document.body.innerHTML='<div id=saved>Saved</div>')">Save</button>`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No write fixture address");
  // The request gives the item and quantity; the delivery speed is the caller's to choose.
  const supplied = { item: "lamp", quantity: 2 };
  const act = (quantity: string) => `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"order_fixture",input:Schema.Struct({item:Schema.String,quantity:${quantity}}),output:Schema.Struct({saved:Schema.Boolean}),questions:{delivery:{type:"choice",prompt:"Which delivery speed?"}},write:{confirmation:"message",commits:["save"]}},
async ({kernel,sessionId,input,ask,enteringCommit,verified}) => {
  const answer = await ask({delivery:{options:[{value:"standard",label:"Standard"},{value:"express",label:"Express"}]}});
  const order = JSON.stringify({item:input.item,quantity:input.quantity,delivery:answer.delivery});
  enteringCommit("save");
  const result = await kernel.browsers.playwright.execute(sessionId,{code:"await page.evaluate((order) => { document.body.dataset.order = order; }, " + JSON.stringify(order) + "); await page.locator('#save').click(); await page.locator('#saved').waitFor(); return true;",timeout_sec:10});
  if(!result.success || result.result !== true) throw new Error("Save not confirmed");
  verified({confirmation:"message"});
  return {saved:true};
});`;
  const requests: ModelRequest[] = [];
  const results: unknown[] = [];
  const patchSource = (path: string, content: string, id: string): ModelResponse["output"] => [
    {
      type: "apply_patch_call",
      callId: id,
      status: "completed",
      operation: {
        type: "create_file",
        path,
        diff:
          content
            .split("\n")
            .map((line) => `+${line}`)
            .join("\n") + "\n",
      },
    },
  ];
  const finish = (request: ModelRequest): ModelResponse["output"] => {
    const receipt = objects(request.input)
      .filter((item) => typeof item["executionId"] === "string")
      .find((item) => item["effect"] === "verified");
    if (receipt === undefined) throw new Error("Confirmed act receipt missing");
    return [
      call(
        "finish_build",
        {
          intent: "Return the composed write without executing it",
          entrypoint: "src/final.mjs",
          executionId: receipt["executionId"],
          metadata: { name: "order_fixture", description: "Order an item once" },
          coverage: "One live confirmed act on the values the request gave",
        },
        `finish_${requests.length}`,
      ),
    ];
  };
  const lastResult = (request: ModelRequest) =>
    objects(request.input)
      .filter((item) => item["type"] === "function_call_result")
      .at(-1);
  const model = provider((request, index) => {
    if (index === 0) return patchSource("src/act.mjs", act("Schema.Number"), "act_source");
    if (index === 1)
      return [
        call(
          "execute",
          {
            ...execution,
            purpose: "act",
            entrypoint: "src/act.mjs",
            intent: "Order the requested item exactly once",
            exampleInput: JSON.stringify(supplied),
            writePath: savePath,
          },
          "act_once",
        ),
      ];
    // The composed script declares the quantity as text, which the session's input is not.
    if (index === 2) return patchSource("src/final.mjs", act("Schema.String"), "composed_source");
    if (index === 3) return finish(request);
    if (index === 4) {
      results.push(lastResult(request));
      return [
        {
          type: "apply_patch_call",
          callId: "corrected_source",
          status: "completed",
          operation: {
            type: "update_file",
            path: "src/final.mjs",
            diff: '@@\n-export default defineOperation({name:"order_fixture",input:Schema.Struct({item:Schema.String,quantity:Schema.String}),output:Schema.Struct({saved:Schema.Boolean}),questions:{delivery:{type:"choice",prompt:"Which delivery speed?"}},write:{confirmation:"message",commits:["save"]}},\n+export default defineOperation({name:"order_fixture",input:Schema.Struct({item:Schema.String,quantity:Schema.Number}),output:Schema.Struct({saved:Schema.Boolean}),questions:{delivery:{type:"choice",prompt:"Which delivery speed?"}},write:{confirmation:"message",commits:["save"]}},\n',
          },
        },
      ];
    }
    if (index === 5) return finish(request);
    return [message("Return the confirmed write artifact.")];
  }, requests);
  const asked: InputRequest[] = [];
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createBrowserEngine({
            minterProvider: model,
            guardianProvider: guardian([]),
            outcomeReviewerProvider: quietReviewer,
            ask: makeInputAsker((request) =>
              Effect.sync(() => {
                asked.push(request);
                return Object.fromEntries(
                  request.questions.map((question) => [
                    question.id,
                    question.type === "choice" ? (question.options[0]?.id ?? "") : "",
                  ]),
                );
              }),
            ),
          });
          const built = yield* service.mint({
            url: `http://127.0.0.1:${address.port}/`,
            intent: "Order 2 brass lamps, delivered at the speed I choose",
            effect: "write",
            input: {},
          });
          expect(built.build, JSON.stringify(built)).toBe("published");
          expect(built.artifact?.inputSchema).toMatchObject({
            required: expect.arrayContaining(["item", "quantity"]),
          });
        }),
      ),
    );
    // The first finish_build names the rejected path and reruns nothing.
    expect(objects(results[0]).find((item) => "inputIssues" in item)).toMatchObject({
      status: "not_published",
      reason: "contract_input_mismatch",
      inputIssues: [{ path: "quantity", issue: "invalid" }],
    });
    // Only the delivery speed was asked; the request's values ran as the session's input.
    expect(asked.flatMap((request) => request.questions.map((question) => question.id))).toEqual([
      "delivery",
    ]);
    expect(saved.map((body) => JSON.parse(body))).toEqual([
      { item: "lamp", quantity: 2, delivery: "standard" },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

// A tiny runtime override supplies recorded providers to the actual compiled stdio entrypoint.
// Saved launchers import the same module through their existing runtime-URL argument.
const mcpRuntime = async (
  directory: string,
  outputs: readonly (ModelResponse["output"] | null)[] = [],
  options: { deny?: boolean; endpoint?: string; timeoutMs?: number } = {},
) => {
  const file = join(directory, "recorded-runtime.mjs");
  const ledger = join(directory, "model-calls.txt");
  const runtime = pathToFileURL(resolve("dist/typescript/src/standalone/mcp-cli.js")).href;
  await writeFile(
    file,
    `import { startMcpCli as start } from ${JSON.stringify(runtime)};
import { Usage } from ${JSON.stringify(import.meta.resolve("@openai/agents"))};
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const outputs=${JSON.stringify(outputs)};
const objects=(value)=>{if(typeof value==='string'){try{return objects(JSON.parse(value));}catch{return [];}}if(Array.isArray(value))return value.flatMap(objects);if(value===null||typeof value!=='object')return [];return [value,...Object.values(value).flatMap(objects)];};
const response=(output)=>({usage:new Usage(),output});
const message=(value)=>({type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(value)}]});
process.once('SIGTERM',()=>appendFileSync(${JSON.stringify(ledger)},'sigterm\\n'));
let index=0;let sourcePending=false;
const minterProvider={getModel:()=>({getResponse:async(request)=>{
appendFileSync(${JSON.stringify(ledger)},'minter\\n');
const recorded=outputs[index++];
if(recorded===undefined)throw new Error('Unexpected recorded minter request');
if(recorded!==null)return response(recorded);
const receipt=objects(request.input).filter(item=>typeof item.executionId==='string').at(-1);
if(!receipt)throw new Error('Missing actual execution receipt');
return response([{type:'function_call',name:'finish_build',callId:'finish',status:'completed',arguments:JSON.stringify({intent:'Return the actual integration',entrypoint:'src/tool.mjs',executionId:receipt.executionId,metadata:{name:'read_fixture',description:'Read local fixture'},coverage:'Actual native example'})}]);
},getStreamedResponse:()=>{throw new Error('Unused stream');}})};
const action=(current)=>{if(current?.trusted_review?.kind!=='execution')return {};const purpose=current.trusted_execution_context?.currentExecution?.purpose;return {action:purpose==='act'?'write':purpose==='authenticate'?'authentication':'read'};};
const outcomeReviewerProvider={getModel:()=>({getResponse:async()=>response([{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'No assessment yet.'}]}]),getStreamedResponse:()=>{throw new Error('Unused stream');}})};
const guardianProvider={getModel:()=>({getResponse:async(request)=>{
appendFileSync(${JSON.stringify(ledger)},'guardian\\n');
const current=objects(request.input).filter(item=>'submitted_call'in item).at(-1);
if(current&&'question_review'in current)return response([message({outcome:'allow_business',rationale:'Caller answers a fixture question'})]);
if(sourcePending){sourcePending=false;return response([message({outcome:${JSON.stringify(options.deny ? "deny" : "allow")},rationale:'Original Guardian fixture review',...action(current)})]);}
sourcePending=true;return response([{type:'function_call',name:'read_source',callId:'source_'+index,status:'completed',arguments:JSON.stringify({path:objects(current).find(item=>typeof item.entrypoint==='string').entrypoint,offset:0})}]);
},getStreamedResponse:()=>{throw new Error('Unused stream');}})};
export const startMcpCli=(args)=>start(args,{policy:'Synthetic fixture policy {{ tenant_policy_config }}',minterProvider,guardianProvider,outcomeReviewerProvider,timeoutMs:${options.timeoutMs ?? 30_000},browser:${JSON.stringify(options.endpoint === undefined ? {} : { endpoint: options.endpoint })}});
if(process.argv[2]==='mint'||process.argv[2]==='serve')startMcpCli(process.argv.slice(2));
`,
  );
  return { file, ledger };
};
const stdioMcp = async (args: string[]) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    env: { PATH: process.env["PATH"] ?? "" },
    stderr: "pipe",
  });
  const client = new Client({ name: "opengpt-browser-qa", version: "1.0.0" });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  try {
    await client.connect(transport);
  } catch (cause) {
    await transport.close();
    throw new Error(stderr, { cause });
  }
  return { client, transport, stderr: () => stderr };
};
const McpView = Schema.Struct({
  job_id: Schema.String,
  status: Schema.String,
  pending_input: Schema.optional(InputRequestSchema),
  output: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
});
const viewOf = (result: unknown) =>
  Schema.decodeUnknownSync(McpView)(
    objects(result).find(
      (value) => typeof value["job_id"] === "string" && typeof value["status"] === "string",
    ),
  );
const observeMcp = async (client: Client, id: string, status: string) => {
  for (let attempt = 0; attempt < 40; attempt++) {
    const view = viewOf(
      await client.callTool({ name: "get_job", arguments: { job_id: id, wait_seconds: 1 } }),
    );
    if (view.status === status) return view;
    if (["failed", "cancelled", "completed"].includes(view.status))
      throw new Error(JSON.stringify(view));
  }
  throw new Error(`MCP job did not reach ${status}`);
};

test("MCP stdio discovers tools before browser or model activity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opengpt-browser-mcp-discovery-"));
  const fixture = await mcpRuntime(directory, [], { endpoint: "ws://127.0.0.1:1/unavailable" });
  const connection = await stdioMcp([fixture.file, "mint", "--root", directory]);
  try {
    const listed = await connection.client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "cancel_job",
      "get_job",
      "mint",
      "provide_input",
    ]);
    await expect(readFile(fixture.ledger, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await connection.client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("opengpt-browser-mcp starts through a linked bin, as npm and npx install it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opengpt-browser-mcp-bin-"));
  const bin = join(directory, "opengpt-browser-mcp");
  await symlink(resolve("dist/typescript/src/standalone/mcp-cli.js"), bin);
  const connection = await stdioMcp([bin, "mint", "--root", join(directory, "integrations")]);
  try {
    const listed = await connection.client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "cancel_job",
      "get_job",
      "mint",
      "provide_input",
    ]);
  } finally {
    await connection.client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP mint input continues once into saved launcher and fresh business MCP", async () => {
  test.info().annotations.push({
    type: "slow",
    description:
      "Real original SDK mint, stdio child processes and a caller wait beyond the injected active budget",
  });
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "opengpt-browser-mcp-mint-"));
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<h1>Public fixture</h1>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing MCP fixture address");
  const url = `http://127.0.0.1:${address.port}/`;
  const fixture = await mcpRuntime(
    directory,
    [
      patch(),
      [
        call("request_input", {
          intent: "Ask caller for the fixture note",
          questions: [
            { id: "note", type: "text", prompt: "Which note should accompany this fixture?" },
          ],
        }),
      ],
      [call("execute", execution)],
      null,
    ],
    { timeoutMs: 10_000 },
  );
  const mint = await stdioMcp([fixture.file, "mint", "--root", directory]);
  try {
    const started = viewOf(
      await mint.client.callTool({
        name: "mint",
        arguments: {
          name: "read_fixture",
          url,
          intent: "Read public fixture",
          effect: "read",
          input: {},
        },
      }),
    );
    const pending = await observeMcp(mint.client, started.job_id, "input_required").catch(
      async (cause) => {
        throw new Error((await readFile(fixture.ledger, "utf8")) + mint.stderr(), { cause });
      },
    );
    const question = pending.pending_input;
    if (question === undefined) throw new Error("Missing actual MCP question");
    const invalid = await mint.client.callTool({
      name: "provide_input",
      arguments: { job_id: started.job_id, request_id: question.id, answers: { note: 42 } },
    });
    expect(invalid.isError).toBe(true);
    await Effect.runPromise(Effect.sleep(11_000));
    await mint.client.callTool({
      name: "provide_input",
      arguments: {
        job_id: started.job_id,
        request_id: question.id,
        answers: { note: "Approved fixture" },
      },
    });
    const stale = await mint.client.callTool({
      name: "provide_input",
      arguments: {
        job_id: started.job_id,
        request_id: question.id,
        answers: { note: "Duplicate" },
      },
    });
    expect(stale.isError).toBe(true);
    const completed = await observeMcp(mint.client, started.job_id, "completed");
    expect(objects(completed.output).find((value) => value["build"] === "published")).toBeDefined();
    const saved = join(directory, "read_fixture");
    expect(JSON.parse(await readFile(join(saved, "deployment.json"), "utf8"))).toMatchObject({
      name: "read_fixture",
      request: { url, effect: "read" },
    });
    expect(JSON.parse(await readFile(join(saved, "mcp.json"), "utf8"))).toEqual({
      mcpServers: {
        read_fixture: {
          command: process.execPath,
          args: [
            join(saved, "mcp.mjs"),
            pathToFileURL(resolve("dist/typescript/src/standalone/mcp-cli.js")).href,
          ],
        },
      },
    });
    const metadata: unknown = JSON.parse(await readFile(join(saved, "integration.json"), "utf8"));
    expect(metadata).toMatchObject({
      files: expect.arrayContaining(["src/tool.mjs", "src/heading.mjs"]),
    });
    const generated = await stdioMcp([join(saved, "mcp.mjs"), pathToFileURL(fixture.file).href]);
    try {
      expect((await generated.client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        "cancel_job",
        "get_job",
        "provide_input",
        "read_fixture",
      ]);
      const malformed = await generated.client.callTool({
        name: "read_fixture",
        arguments: { input: "wrong" },
      });
      expect(malformed.isError).toBe(true);
      const minted = await readFile(fixture.ledger, "utf8");
      const result = await generated.client.callTool({
        name: "read_fixture",
        arguments: { input: {} },
      });
      expect(
        objects(result).find((value) => value["heading"] === "Public fixture"),
        generated.stderr(),
      ).toBeDefined();
      // The served run adds no model request to the ledger the mint wrote.
      expect(await readFile(fixture.ledger, "utf8")).toBe(minted);
    } finally {
      await generated.client.close();
    }
  } finally {
    await mint.client.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("a served integration with a recorded sign-in asks for the login on each call and keeps no value in its folder", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Stdio child process serving from mcp.json, Chromium and two signed-in calls",
  });
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "opengpt-browser-mcp-sign-in-"));
  const shop = await startShop(directory);
  const remote = await chromium.launchServer({
    args: [
      `--host-resolver-rules=MAP ${shop.hostname} 127.0.0.1`,
      "--no-proxy-server",
      "--ignore-certificate-errors",
    ],
  });
  const readAccount = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"read_account",input:Schema.Struct({}),output:Schema.Struct({signedIn:Schema.Boolean})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:"await page.goto(new URL('/account', page.url()).href); return (await page.locator('#account').count()) > 0;",timeout_sec:15});
  if(!response.success) throw new Error(String(response.error));
  return {signedIn:response.result === true};
});`;
  try {
    // The integration as a build that signed in publishes it: the recipe beside integration.json.
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const publish = yield* prepareIntegration({
            root: directory,
            name: "read_account",
            request: { url: `${shop.origin}/account`, intent: "Read the account", effect: "read" },
          });
          yield* publish({
            entrypoint: "src/tool.mjs",
            files: [{ path: "src/tool.mjs", content: readAccount }],
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            outputSchema: {
              type: "object",
              properties: { signedIn: { type: "boolean" } },
              required: ["signedIn"],
              additionalProperties: false,
            },
            signIn: {
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
            },
          });
        }),
      ),
    );
    const saved = join(directory, "read_account");
    const files = async () =>
      Promise.all(
        (await readdir(saved, { recursive: true, withFileTypes: true }))
          .filter((entry) => entry.isFile())
          .map(async (entry) => [
            join(entry.parentPath, entry.name),
            await readFile(join(entry.parentPath, entry.name), "utf8"),
          ]),
      );
    const before = await files();
    // Served as mcp.json starts it, in a new process, with the recorded runtime in place of the
    // installed one so it uses the fixture's browser.
    const launcher = Schema.decodeUnknownSync(
      Schema.Struct({
        mcpServers: Schema.Struct({
          read_account: Schema.Struct({
            command: Schema.String,
            args: Schema.Array(Schema.String),
          }),
        }),
      }),
    )(JSON.parse(await readFile(join(saved, "mcp.json"), "utf8"))).mcpServers.read_account;
    expect(launcher.command).toBe(process.execPath);
    const fixture = await mcpRuntime(directory, [], { endpoint: remote.wsEndpoint() });
    const served = await stdioMcp([launcher.args[0] ?? "", pathToFileURL(fixture.file).href]);
    try {
      // Each call runs in a new browser context, so each asks for the login once and signs in.
      for (const call of [1, 2]) {
        const started = viewOf(
          await served.client.callTool({ name: "read_account", arguments: { input: {} } }),
        );
        const pending =
          started.status === "input_required"
            ? started
            : await observeMcp(served.client, started.job_id, "input_required");
        expect(pending.pending_input?.questions, served.stderr()).toEqual([
          expect.objectContaining({
            id: "login",
            type: "credential",
            reason: "missing_credentials",
          }),
        ]);
        await served.client.callTool({
          name: "provide_input",
          arguments: {
            job_id: started.job_id,
            request_id: pending.pending_input?.id ?? "",
            answers: { login: { ...shopAccount, saveLogin: false } },
          },
        });
        const completed = await observeMcp(served.client, started.job_id, "completed");
        expect(completed.output).toEqual({ signedIn: true });
        expect(shop.state.loginPosts).toBe(call);
      }
    } finally {
      await served.client.close();
    }
    // The folder is as published: the recipe and source, and no login value.
    const after = await files();
    expect(after).toEqual(before);
    expect(after.map(([path]) => path)).toContain(join(saved, "auth-fill.json"));
    for (const [, text] of after)
      for (const value of [shopAccount.username, shopAccount.password])
        expect(text).not.toContain(value);
  } finally {
    await remote.close();
    await shop.close();
    await rm(directory, { recursive: true, force: true });
  }
});

/** Saves an integration as `opengpt-browser-mcp mint` writes it, from `src/tool.mjs` or a set of files. */
const saveMcpFixture = (
  root: string,
  name: string,
  url: string,
  effect: "read" | "write",
  source: string | Readonly<Record<string, string>>,
  inputSchema: unknown = { type: "object", properties: {}, additionalProperties: false },
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const publish = yield* prepareIntegration({
          root,
          name,
          request: { url, intent: "Operate local fixture", effect },
        });
        yield* publish({
          entrypoint: "src/tool.mjs",
          files: Object.entries(
            typeof source === "string" ? { "src/tool.mjs": source } : source,
          ).map(([path, content]) => ({ path, content })),
          inputSchema,
          outputSchema: {
            type: "object",
            properties:
              effect === "write" ? { saved: { type: "boolean" } } : { heading: { type: "string" } },
            required: [effect === "write" ? "saved" : "heading"],
            additionalProperties: false,
          },
        });
        return join(root, name);
      }),
    ),
  );

test("MCP write polls and answers never resubmit and EOF closes its owned context", async () => {
  test.info().annotations.push({
    type: "slow",
    description:
      "Actual stdio SDK and three distinct native write lifecycles including cancellation and EOF",
  });
  test.setTimeout(60_000);
  let writes = 0;
  const server = createServer((request, response) => {
    if (request.method === "POST") {
      writes++;
      response.end("saved");
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<button id="save" onclick="fetch('/save',{method:'POST'}).then(()=>document.body.innerHTML='<div id=saved>Saved</div>')">Save</button>`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing write address");
  const browserServer = await chromium.launchServer();
  const observer = await chromium.connect(browserServer.wsEndpoint());
  const cdp = await observer.newBrowserCDPSession();
  const contexts = async () => (await cdp.send("Target.getBrowserContexts")).browserContextIds;
  const directory = await mkdtemp(join(tmpdir(), "opengpt-browser-mcp-write-"));
  const source = `import {Schema} from "effect";
import {defineOperation} from "../runtime/index.js";
export default defineOperation({name:"save_fixture",input:Schema.Struct({}),output:Schema.Struct({saved:Schema.Boolean}),write:{confirmation:"message",commits:["save"]},questions:{continue:{type:"confirm",prompt:"Continue after this confirmed save?"}}},async({kernel,sessionId,enteringCommit,verified,ask})=>{
enteringCommit("save");const result=await kernel.browsers.playwright.execute(sessionId,{code:"await page.locator('#save').click(); await page.locator('#saved').waitFor(); return true;",timeout_sec:2});
if(!result.success||result.result!==true)throw new Error("Save not confirmed");verified({confirmation:"message"});await ask({continue:{}});return {saved:true};});`;
  const saved = await saveMcpFixture(
    directory,
    "save_fixture",
    `http://127.0.0.1:${address.port}/`,
    "write",
    source,
  );
  const fixture = await mcpRuntime(directory, [], { endpoint: browserServer.wsEndpoint() });
  const connection = await stdioMcp([join(saved, "mcp.mjs"), pathToFileURL(fixture.file).href]);
  try {
    const first = viewOf(
      await connection.client.callTool({ name: "save_fixture", arguments: { input: {} } }),
    );
    expect(first.status, connection.stderr()).toBe("input_required");
    expect(writes).toBe(1);
    for (let i = 0; i < 3; i++)
      expect(
        viewOf(
          await connection.client.callTool({
            name: "get_job",
            arguments: { job_id: first.job_id, wait_seconds: 0 },
          }),
        ).status,
      ).toBe("input_required");
    expect(writes).toBe(1);
    if (!first.pending_input) throw new Error("No save question");
    await connection.client.callTool({
      name: "provide_input",
      arguments: {
        job_id: first.job_id,
        request_id: first.pending_input.id,
        answers: { continue: { confirmed: true } },
      },
    });
    expect((await observeMcp(connection.client, first.job_id, "completed")).output).toEqual({
      saved: true,
    });
    expect(writes).toBe(1);
    const second = viewOf(
      await connection.client.callTool({ name: "save_fixture", arguments: { input: {} } }),
    );
    expect(second.status).toBe("input_required");
    expect(writes).toBe(2);
    expect(
      viewOf(
        await connection.client.callTool({
          name: "cancel_job",
          arguments: { job_id: second.job_id },
        }),
      ).status,
    ).toBe("cancelled");
    expect(await contexts()).toEqual([]);
    expect(writes).toBe(2);
    const third = viewOf(
      await connection.client.callTool({ name: "save_fixture", arguments: { input: {} } }),
    );
    expect(third.status).toBe("input_required");
    expect(writes).toBe(3);
    expect((await contexts()).length).toBe(1);
    await connection.client.close();
    expect(await contexts()).toEqual([]);
    expect(writes).toBe(3);
    // The ledger would record a SIGTERM or any model request. A served run makes no model request.
    await expect(readFile(fixture.ledger, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await connection.client.close();
    await cdp.detach();
    await observer.close();
    await browserServer.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("an MCP write repeated with its idempotency_key acts once, across a restart and two servers", async () => {
  test.info().annotations.push({
    type: "slow",
    description:
      "Actual stdio SDK, three server processes on one tool folder and four native write lifecycles",
  });
  test.setTimeout(90_000);
  let writes = 0;
  const server = createServer((request, response) => {
    if (request.method === "POST") {
      writes++;
      response.end("saved");
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<button id="save" onclick="fetch('/save',{method:'POST'}).then(()=>document.body.innerHTML='<div id=saved>Saved</div>')">Save</button>`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing write address");
  const browserServer = await chromium.launchServer();
  const directory = await mkdtemp(join(tmpdir(), "opengpt-browser-mcp-retry-"));
  const source = `import {Schema} from "effect";
import {defineOperation} from "../runtime/index.js";
export default defineOperation({name:"save_fixture",input:Schema.Struct({note:Schema.String}),output:Schema.Struct({saved:Schema.Boolean}),write:{confirmation:"message",commits:["save"]}},async({kernel,sessionId,enteringCommit,verified})=>{
enteringCommit("save");const result=await kernel.browsers.playwright.execute(sessionId,{code:"await page.locator('#save').click(); await page.locator('#saved').waitFor(); return true;",timeout_sec:2});
if(!result.success||result.result!==true)throw new Error("Save not confirmed");verified({confirmation:"message"});return {saved:true};});`;
  const saved = await saveMcpFixture(
    directory,
    "save_fixture",
    `http://127.0.0.1:${address.port}/`,
    "write",
    source,
    {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
      additionalProperties: false,
    },
  );
  const fixture = await mcpRuntime(directory, [], { endpoint: browserServer.wsEndpoint() });
  const serve = () => stdioMcp([join(saved, "mcp.mjs"), pathToFileURL(fixture.file).href]);
  const save = (connection: Awaited<ReturnType<typeof serve>>, args: Record<string, unknown>) =>
    connection.client.callTool({ name: "save_fixture", arguments: args });
  const first = { input: { note: "first" }, idempotency_key: "booking-1" };
  const connections: Awaited<ReturnType<typeof serve>>[] = [];
  try {
    let connection = await serve();
    connections.push(connection);
    const listed = await connection.client.listTools();
    expect(
      listed.tools.find((tool) => tool.name === "save_fixture")?.inputSchema.properties,
    ).toHaveProperty("idempotency_key");
    expect((await save(connection, first)).structuredContent, connection.stderr()).toEqual({
      saved: true,
    });
    expect(writes).toBe(1);
    // The same key and input answer the first job's result again, and the site sees no request.
    expect((await save(connection, first)).structuredContent).toEqual({ saved: true });
    expect(writes).toBe(1);
    const changed = await save(connection, { ...first, input: { note: "changed" } });
    expect(changed.isError).toBe(true);
    expect(JSON.stringify(changed.content)).toContain(
      "This idempotency key was already used for a different request.",
    );
    expect(writes).toBe(1);

    // After a restart the key still names its job: the call rejoins it and acts on nothing.
    await connection.client.close();
    connection = await serve();
    connections.push(connection);
    const rejoined = await save(connection, first);
    expect(rejoined.structuredContent).toMatchObject({ status: "completed", rejoined: true });
    expect(writes).toBe(1);
    const job = viewOf(rejoined);
    expect(
      viewOf(
        await connection.client.callTool({ name: "get_job", arguments: { job_id: job.job_id } }),
      ).status,
    ).toBe("completed");
    expect(await readdir(join(saved, ".jobs"))).toHaveLength(1);

    // Two servers on one tool folder, called at once with one key, write once between them.
    const other = await serve();
    connections.push(other);
    const second = { input: { note: "second" }, idempotency_key: "booking-2" };
    const both = await Promise.all([save(connection, second), save(other, second)]);
    expect(both.map((result) => result.isError ?? false)).toEqual([false, false]);
    expect(writes).toBe(2);
    expect(both.map((result) => JSON.stringify(result.structuredContent)).join()).toContain(
      '"rejoined":true',
    );

    // A call without a key is still a new website action.
    expect((await save(connection, { input: { note: "first" } })).structuredContent).toEqual({
      saved: true,
    });
    expect(writes).toBe(3);
    await expect(readFile(fixture.ledger, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    for (const connection of connections) await connection.client.close();
    await browserServer.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP malformed saved schema fails before models and a served run calls no model", async () => {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits++;
    response.setHeader("Content-Type", "text/html");
    response.end("<h1>Served</h1>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing serve address");
  const directory = await mkdtemp(join(tmpdir(), "opengpt-browser-mcp-serve-"));
  const url = `http://127.0.0.1:${address.port}/`;
  const source = operation.replace(
    'import { heading } from "./heading.mjs";',
    "const heading=value=>String(value);",
  );
  try {
    const malformed = await saveMcpFixture(directory, "invalid_fixture", url, "read", source, {
      type: "not_a_json_schema_type",
    });
    const invalidRuntime = await mcpRuntime(directory);
    await expect(
      stdioMcp([join(malformed, "mcp.mjs"), pathToFileURL(invalidRuntime.file).href]),
    ).rejects.toThrow();
    await expect(readFile(invalidRuntime.ledger, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(hits).toBe(0);
    const saved = await saveMcpFixture(directory, "served_fixture", url, "read", source);
    // The recorded Guardian denies every review and the ledger records any model request.
    const fixture = await mcpRuntime(directory, [], { deny: true });
    const connection = await stdioMcp([join(saved, "mcp.mjs"), pathToFileURL(fixture.file).href]);
    try {
      const result = await connection.client.callTool({
        name: "served_fixture",
        arguments: { input: {} },
      });
      expect(result.isError, connection.stderr()).toBeFalsy();
      expect(result.structuredContent).toEqual({ heading: "Served" });
      expect(hits).toBeGreaterThan(0);
      await expect(readFile(fixture.ledger, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await connection.client.close();
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP refuses an impossible calendar date and the tool's own date rule before its search", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Actual stdio SDK over one invalid and two native runs",
  });
  test.setTimeout(60_000);
  const searches: string[] = [];
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/search") === true) searches.push(request.url);
    response.end("<h1>Stays</h1>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing stays address");
  const directory = await mkdtemp(join(tmpdir(), "opengpt-browser-mcp-dates-"));
  const url = `http://127.0.0.1:${address.port}/`;
  // A synthetic stay search: CalendarDate checks each date is real, and the tool checks the
  // task's own rule, that the stay ends after it starts, before it sends the search.
  const source = `import { Schema } from "effect";
import { CalendarDate, defineOperation } from "../runtime/index.js";
export default defineOperation({name:"search_stays",input:Schema.Struct({check_in:CalendarDate,check_out:CalendarDate}),output:Schema.Struct({heading:Schema.String})},
async ({kernel,sessionId,input,errors}) => {
  if (input.check_out <= input.check_in) throw new errors.InvalidInput("check_out must be after check_in");
  const query = new URLSearchParams(input).toString();
  const response = await kernel.browsers.playwright.execute(sessionId,{code:"await page.goto(new URL('/search?" + query + "', page.url()).href); return await page.locator('h1').textContent();",timeout_sec:5});
  if(!response.success) throw new Error(String(response.error));
  return {heading:String(response.result)};
});`;
  try {
    const saved = await saveMcpFixture(
      directory,
      "search_stays",
      url,
      "read",
      source,
      contractJsonSchema(Schema.Struct({ check_in: CalendarDate, check_out: CalendarDate })),
    );
    const fixture = await mcpRuntime(directory);
    const connection = await stdioMcp([join(saved, "mcp.mjs"), pathToFileURL(fixture.file).href]);
    const search = (input: Record<string, string>) =>
      connection.client
        .callTool({ name: "search_stays", arguments: { input } })
        .catch((error: unknown) => ({ isError: true, content: [{ text: String(error) }] }));
    try {
      const impossible = await search({ check_in: "2026-02-30", check_out: "2026-03-02" });
      expect(impossible.isError).toBe(true);
      expect(JSON.stringify(impossible)).toMatch(/check_in.*format.*date/);
      await expect(readFile(fixture.ledger, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const reversed = viewOf(await search({ check_in: "2026-03-05", check_out: "2026-03-01" }));
      expect(reversed.status, connection.stderr()).toBe("failed");
      expect(reversed.error).toContain("check_out must be after check_in");

      const valid = await search({ check_in: "2026-03-01", check_out: "2026-03-05" });
      expect(objects(valid).find((value) => value["heading"] === "Stays")).toBeDefined();
      expect(searches).toEqual(["/search?check_in=2026-03-01&check_out=2026-03-05"]);
    } finally {
      await connection.client.close();
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("a generated integration serves and runs with no model key or provider", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<h1>Keyless</h1>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing keyless address");
  const directory = await mkdtemp(join(tmpdir(), "opengpt-browser-mcp-keyless-"));
  const source = operation.replace(
    'import { heading } from "./heading.mjs";',
    "const heading=value=>String(value);",
  );
  try {
    const saved = await saveMcpFixture(
      directory,
      "keyless_fixture",
      `http://127.0.0.1:${address.port}/`,
      "read",
      source,
    );
    // The installed runtime with its default configuration. stdioMcp passes only PATH, so the
    // server has no model key and no injected provider.
    const runtime = pathToFileURL(resolve("dist/typescript/src/standalone/mcp-cli.js")).href;
    const connection = await stdioMcp([join(saved, "mcp.mjs"), runtime]);
    try {
      expect((await connection.client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        "cancel_job",
        "get_job",
        "keyless_fixture",
        "provide_input",
      ]);
      const result = await connection.client.callTool({
        name: "keyless_fixture",
        arguments: { input: {} },
      });
      expect(result.isError, JSON.stringify(result) + connection.stderr()).toBeFalsy();
      expect(result.structuredContent).toEqual({ heading: "Keyless" });
    } finally {
      await connection.client.close();
    }
    // A read's failure names no model, because a run makes no model request, and no possible
    // website change, because a read holds no write authority.
    const failing = await saveMcpFixture(
      directory,
      "failing_fixture",
      `http://127.0.0.1:${address.port}/`,
      "read",
      source.replace("const response =", 'throw new Error("Fixture failure"); const response ='),
    );
    const failed = await stdioMcp([join(failing, "mcp.mjs"), runtime]);
    try {
      const result = await failed.client.callTool({
        name: "failing_fixture",
        arguments: { input: {} },
      });
      expect(result.structuredContent, failed.stderr()).toMatchObject({
        status: "failed",
        error:
          "The run did not produce a validated result. Nothing changed on the website. Check the local browser and the tool, then run it again.",
        code: "execution_failed",
        write_status: null,
        possible_commit: false,
        retry: "never",
      });
    } finally {
      await failed.client.close();
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("a write that never records its confirmation reports possibly applied from run and MCP, with its output", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "A native write through the library and the served stdio MCP; a real POST each",
  });
  test.setTimeout(60_000);
  let writes = 0;
  const calls: string[] = [];
  const server = createServer((request, response) => {
    if (request.method === "POST") {
      writes++;
      response.end("saved");
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<button id="save" onclick="fetch('/save',{method:'POST'}).then(()=>document.body.innerHTML='<div id=saved>Saved</div>')">Save</button>`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing write address");
  const url = `http://127.0.0.1:${address.port}/`;
  // The script declares a message confirmation and enters its commit, but never calls verified().
  const source = `import {Schema} from "effect";
import {defineOperation} from "../runtime/index.js";
export default defineOperation({name:"save_fixture",input:Schema.Struct({}),output:Schema.Struct({saved:Schema.Boolean}),write:{confirmation:"message",commits:["save"]}},async({kernel,sessionId,enteringCommit})=>{
enteringCommit("save");const result=await kernel.browsers.playwright.execute(sessionId,{code:"await page.locator('#save').click(); await page.locator('#saved').waitFor(); return true;",timeout_sec:2});
if(!result.success||result.result!==true)throw new Error("Save not reached");return {saved:true};});`;
  const directory = await mkdtemp(join(tmpdir(), "opengpt-unconfirmed-write-"));
  const error =
    "The write returned without recording its confirmation, so it may have changed the website. Read the site back before any retry to see whether the action happened, and run the tool again only if it did not.";
  try {
    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createBrowserEngine({
            ask: makeInputAsker(() => Effect.succeed({})),
            minterProvider: unreachableModel(calls, "minter"),
            guardianProvider: unreachableModel(calls, "guardian"),
            timeoutMs: 10_000,
          });
          return yield* service.run(
            {
              entrypoint: "src/tool.mjs",
              files: [{ path: "src/tool.mjs", content: source }],
              inputSchema: {},
              outputSchema: {},
            },
            { url, intent: "Save the fixture once", effect: "write", input: {} },
          );
        }),
      ).pipe(Effect.flip),
    );
    expect(failure).toBeInstanceOf(RunOutcomeFailure);
    expect(failure).toMatchObject({
      message: error,
      outcome: {
        code: "outcome_unknown",
        writeStatus: "may_have_applied",
        possibleCommit: true,
        retry: "never",
      },
      unconfirmed: { output: { saved: true } },
    });
    expect(writes).toBe(1);
    const saved = await saveMcpFixture(directory, "save_fixture", url, "write", source);
    const runtime = pathToFileURL(resolve("dist/typescript/src/standalone/mcp-cli.js")).href;
    const connection = await stdioMcp([join(saved, "mcp.mjs"), runtime]);
    try {
      const result = await connection.client.callTool({
        name: "save_fixture",
        arguments: { input: {} },
      });
      // A failed run, a write that may have applied included, is never a success: an error result
      // whose job still tells the client whether to resubmit.
      expect(result.isError, JSON.stringify(result) + connection.stderr()).toBe(true);
      expect(result.structuredContent).toEqual({
        job_id: expect.any(String),
        status: "failed",
        output: { saved: true },
        error,
        code: "outcome_unknown",
        write_status: "may_have_applied",
        possible_commit: true,
        retry: "never",
      });
      expect(writes).toBe(2);
    } finally {
      await connection.client.close();
    }
    // The terminal prints the unconfirmed output, then the outcome, and exits 1.
    await Effect.runPromise(
      Effect.scoped(
        writeArtifact(join(directory, "artifact"), {
          entrypoint: "src/tool.mjs",
          files: [{ path: "src/tool.mjs", content: source }],
          inputSchema: {},
          outputSchema: {},
        }),
      ),
    );
    const ran = await terminal(["run", "--artifact", join(directory, "artifact"), "--url", url]);
    expect(ran.code, ran.stderr).toBe(1);
    expect(JSON.parse(ran.stdout)).toEqual({ saved: true });
    expect(ran.stderr.trim()).toBe(error);
    expect(writes).toBe(3);
    expect(calls).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("a write that recorded its confirmation and then failed reports it applied and never to run again, from run and MCP", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Three native writes through the library and one through the served stdio MCP; a real POST each",
  });
  test.setTimeout(120_000);
  let writes = 0;
  const calls: string[] = [];
  const server = createServer((request, response) => {
    if (request.method === "POST") {
      writes++;
      response.end("saved");
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<button id="save" onclick="fetch('/save',{method:'POST'}).then(()=>document.body.innerHTML='<div id=saved>Saved</div>')">Save</button>`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing write address");
  const url = `http://127.0.0.1:${address.port}/`;
  // The save is confirmed and recorded with verified(); a later check on another field then
  // fails, as the tool's own refusal or as a plain error, with no browser call after it. A browser
  // call after verified() reopens the write, so a failure after it is no longer confirmed.
  const reason = "The note field differs from the one read before the save.";
  const source = `import {Schema} from "effect";
import {defineOperation} from "../runtime/index.js";
export default defineOperation({name:"save_fixture",input:Schema.Struct({then:Schema.Literal("refuse","throw","reread")}),output:Schema.Struct({saved:Schema.Boolean}),write:{confirmation:"readback",commits:["save"]}},async({kernel,sessionId,input,enteringCommit,verified,errors})=>{
enteringCommit("save");const result=await kernel.browsers.playwright.execute(sessionId,{code:"await page.locator('#save').click(); await page.locator('#saved').waitFor(); return true;",timeout_sec:2});
if(!result.success||result.result!==true)throw new Error("Save not reached");verified();
if(input.then==="refuse")throw new errors.InvalidInput(${JSON.stringify(reason)});
if(input.then==="reread")await kernel.browsers.playwright.execute(sessionId,{code:"return document.body.innerText;",timeout_sec:2});
throw new Error("Unexpected change after the save");});`;
  const directory = await mkdtemp(join(tmpdir(), "opengpt-confirmed-write-"));
  const run = (then: "refuse" | "throw" | "reread") =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createBrowserEngine({
            ask: makeInputAsker(() => Effect.succeed({})),
            minterProvider: unreachableModel(calls, "minter"),
            guardianProvider: unreachableModel(calls, "guardian"),
            timeoutMs: 10_000,
          });
          return yield* service.run(
            {
              entrypoint: "src/tool.mjs",
              files: [{ path: "src/tool.mjs", content: source }],
              inputSchema: {},
              outputSchema: {},
            },
            { url, intent: "Save the fixture once", effect: "write", input: { then } },
          );
        }),
      ).pipe(Effect.flip),
    );
  try {
    // The commit report a keyed job's record keeps shows the commit step confirmed.
    const confirmed = { effect: "verified", commits: [{ name: "save", state: "confirmed" }] };
    const refused = await run("refuse");
    expect(refused).toBeInstanceOf(RunOutcomeFailure);
    expect(refused).toMatchObject({
      outcome: { details: { reason }, writeStatus: "applied", retry: "never" },
      journal: confirmed,
    });
    const thrown = await run("throw");
    expect(thrown).toBeInstanceOf(RunOutcomeFailure);
    expect(thrown).toMatchObject({
      outcome: { code: "execution_failed", writeStatus: "applied", retry: "never" },
      journal: confirmed,
    });
    const reread = await run("reread");
    expect(reread).toBeInstanceOf(RunOutcomeFailure);
    expect(reread).toMatchObject({
      outcome: { writeStatus: "may_have_applied" },
      journal: { effect: "possible", commits: [{ name: "save", state: "sent" }] },
    });
    expect(writes).toBe(3);
    const saved = await saveMcpFixture(directory, "save_fixture", url, "write", source, {
      type: "object",
      properties: { then: { type: "string", enum: ["refuse", "throw", "reread"] } },
      required: ["then"],
      additionalProperties: false,
    });
    const runtime = pathToFileURL(resolve("dist/typescript/src/standalone/mcp-cli.js")).href;
    const connection = await stdioMcp([join(saved, "mcp.mjs"), runtime]);
    try {
      const result = await connection.client.callTool({
        name: "save_fixture",
        arguments: { input: { then: "refuse" } },
      });
      // A failed run is an MCP error even when its write landed; the structured content says the
      // write applied and must never run again.
      expect(result.isError, JSON.stringify(result) + connection.stderr()).toBe(true);
      expect(result.structuredContent).toMatchObject({
        status: "failed",
        code: "input_rejected",
        error: expect.stringContaining(reason),
        write_status: "applied",
        retry: "never",
      });
      expect(writes).toBe(4);
    } finally {
      await connection.client.close();
    }
    expect(calls).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

/*
 * A saved integration imports the SDK at `sdk` from src/ and at `nested` from a module in src/lib/.
 * Under 0.2.0's executor, an entrypoint in src/ reached the SDK one level up and a nested module two
 * levels up; the workspace guide documents one level more. Integrations saved either way run
 * through `opengpt-browser-engine run` and serve through their saved `mcp.mjs`.
 */
for (const { title, sdk, nested } of [
  {
    title: "an integration saved with 0.2.0's one-level-up SDK imports still runs and serves",
    sdk: "../runtime/index.js",
    nested: "../../runtime/index.js",
  },
  {
    title: "an integration saved with the documented SDK import runs and serves",
    sdk: "../../runtime/index.js",
    nested: "../../../runtime/index.js",
  },
])
  test(title, async () => {
    test.setTimeout(60_000);
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end("<h1>  Saved fixture  </h1>");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No fixture address");
    const url = `http://127.0.0.1:${address.port}/`;
    const root = await mkdtemp(join(tmpdir(), "opengpt-saved-imports-"));
    try {
      const directory = await saveMcpFixture(root, "read_saved", url, "read", {
        "src/tool.mjs": operation
          .replace('"../runtime/index.js"', JSON.stringify(sdk))
          .replace('"./heading.mjs"', '"./lib/heading.mjs"'),
        "src/lib/heading.mjs": `import { defineOperation } from ${JSON.stringify(nested)};
export const heading = (value) => (typeof defineOperation === "function" ? String(value).trim() : "");`,
      });
      const ran = await terminal(["run", "--artifact", directory, "--url", url]);
      expect(ran.code, ran.stderr).toBe(0);
      expect(JSON.parse(ran.stdout)).toEqual({ heading: "Saved fixture" });
      const runtime = pathToFileURL(resolve("dist/typescript/src/standalone/mcp-cli.js")).href;
      const served = await stdioMcp([join(directory, "mcp.mjs"), runtime]);
      try {
        expect((await served.client.listTools()).tools.map((tool) => tool.name)).toContain(
          "read_saved",
        );
        const result = await served.client.callTool({
          name: "read_saved",
          arguments: { input: {} },
        });
        expect(result, served.stderr()).toMatchObject({
          structuredContent: { heading: "Saved fixture" },
        });
      } finally {
        await served.client.close();
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    }
  });

test("MCP concurrent original input callbacks remain answerable", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* makeMcpJobs(1);
        const request = (id: string): InputRequest => ({
          id,
          source: "script",
          questions: [{ id: "note", type: "text", prompt: "A fixture note?" }],
        });
        const started = yield* jobs.start((ask) =>
          Effect.all(
            [
              ask(request("11111111-1111-4111-8111-111111111111")),
              ask(request("22222222-2222-4222-8222-222222222222")),
            ],
            { concurrency: "unbounded" },
          ),
        );
        for (let count = 0; count < 2; count++) {
          const pending = yield* jobs.get(started.job_id, 500);
          expect(pending.status).toBe("input_required");
          if (!pending.pending_input) throw new Error("Concurrent question orphaned");
          yield* jobs.provide(started.job_id, pending.pending_input.id, { note: "Answered" });
        }
        let final = yield* jobs.get(started.job_id, 500);
        for (let count = 0; count < 5 && final.status === "running"; count++)
          final = yield* jobs.get(started.job_id, 500);
        expect(final.status).toBe("completed");
      }),
    ),
  );
});

test("original owner intent authorizes a named off-site tenant while an unnamed tenant is refused", async () => {
  test.info().annotations.push({
    type: "slow",
    description:
      "Original Guardian source review of a minting example and native browser navigation to the existing TLS shop on another registrable domain",
  });
  const directory = await mkdtemp(join(tmpdir(), "opengpt-owner-origin-"));
  const shop = await startShop(directory);
  let productHits = 0;
  const server = createServer((_request, response) => {
    productHits++;
    response.end("Product site");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No product fixture address");
  const remote = await chromium.launchServer({
    args: [
      `--host-resolver-rules=MAP ${shop.hostname} 127.0.0.1`,
      "--no-proxy-server",
      "--ignore-certificate-errors",
    ],
  });
  const target = `${shop.origin}/search`;
  const browserCode = `await page.goto(${JSON.stringify(target)}); return await page.title();`;
  const source = `import {Schema} from "effect";import {defineOperation} from "../runtime/index.js";
export default defineOperation({name:"tenant_title",input:Schema.Struct({}),output:Schema.Struct({title:Schema.String})},async({kernel,sessionId})=>{const result=await kernel.browsers.playwright.execute(sessionId,{code:${JSON.stringify(browserCode)},timeout_sec:3});if(!result.success)throw new Error(String(result.error));return {title:result.result};});`;
  const Authority = Schema.Struct({
    allowedOrigins: Schema.Array(Schema.String),
    ownerNamedOrigins: Schema.optional(Schema.Array(Schema.String)),
  });
  try {
    for (const named of [false, true]) {
      let inspected = false;
      const decisions: string[] = [];
      const reviewer = provider((request, index) => {
        const current = objects(request.input)
          .filter((item) => "submitted_call" in item)
          .at(-1);
        if (current === undefined) throw new Error("Missing original Guardian execution input");
        // The review of the minter's last answer for its caller decides nothing here.
        if ("question_review" in current)
          return [message(JSON.stringify({ outcome: "reword", rationale: "Not needed." }))];
        if (!inspected) {
          inspected = true;
          const submitted = Schema.decodeUnknownSync(Schema.Struct({ entrypoint: Schema.String }))(
            current["submitted_call"],
          );
          return [
            call(
              "read_source",
              { path: submitted.entrypoint, offset: 0 },
              `tenant_source_${index}`,
            ),
          ];
        }
        const authority = Schema.decodeUnknownSync(Authority)(current["trusted_authority"]);
        const readSource = objects(request.input).find(
          (item) => typeof item["source"] === "string" && item["source"].includes(shop.origin),
        );
        const allowed =
          reviewedNative(request) &&
          readSource !== undefined &&
          [...authority.allowedOrigins, ...(authority.ownerNamedOrigins ?? [])].includes(
            shop.origin,
          );
        decisions.push(allowed ? "allow" : "deny");
        return [
          message(
            JSON.stringify({
              outcome: allowed ? "allow" : "deny",
              rationale: allowed
                ? "The owner named their tenant for this read"
                : "The tenant was not named by the owner",
              ...actionFor(current),
            }),
          ),
        ];
      }, []);
      // The minter writes the source, asks for one live example and then stops.
      const minterRequests: ModelRequest[] = [];
      const minter = provider((_request, index) => {
        if (index === 0)
          return [
            {
              type: "apply_patch_call",
              callId: "tenant_source",
              status: "completed",
              operation: {
                type: "create_file",
                path: "src/tool.mjs",
                diff:
                  source
                    .split("\n")
                    .map((line) => `+${line}`)
                    .join("\n") + "\n",
              },
            },
          ];
        if (index === 1)
          return [call("execute", { ...execution, intent: "Read the tenant page title" })];
        return [message("Stopped after the tenant example.")];
      }, minterRequests);
      const searchLoads = shop.state.searchPageLoads;
      const productLoads = productHits;
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* createBrowserEngine({
              browser: { endpoint: remote.wsEndpoint() },
              minterProvider: minter,
              guardianProvider: reviewer,
              outcomeReviewerProvider: quietReviewer,
              ask: makeInputAsker(() => Effect.succeed({})),
              timeoutMs: 10_000,
            });
            return yield* Effect.either(
              service.mint({
                url: `http://127.0.0.1:${address.port}/`,
                intent: named
                  ? `Read the page title of our tenant at ${target}.`
                  : "Read the tenant page title",
                effect: "read",
                input: {},
              }),
            );
          }),
        ),
      );
      expect(decisions, JSON.stringify(minterRequests.at(-1)?.input)).toEqual([
        named ? "allow" : "deny",
      ]);
      if (named) {
        expect(shop.state.searchPageLoads).toBe(searchLoads + 1);
      } else {
        expect(shop.state.searchPageLoads).toBe(searchLoads);
        // The host loaded the request's page before the build started; the denied step loaded
        // nothing.
        expect(productHits).toBe(productLoads + 1);
      }
    }
  } finally {
    await remote.close();
    await shop.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

// What the local host sends its two models: Guardian the native execution policy, and the minter
// the workspace guide with every section rendered.
test("a local mint sends Guardian the native policy and the minter the rendered workspace guide", async () => {
  test.setTimeout(45_000);
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<h1>Public fixture</h1>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture address");
  const mintRequests: ModelRequest[] = [];
  const reviewRequests: ModelRequest[] = [];
  try {
    const built = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createBrowserEngine({
            minterProvider: minter(mintRequests),
            guardianProvider: guardian(reviewRequests),
            outcomeReviewerProvider: quietReviewer,
            ask: makeInputAsker((request) =>
              Effect.succeed(
                Object.fromEntries(request.questions.map((question) => [question.id, "read"])),
              ),
            ),
            timeoutMs: 20_000,
          });
          return yield* service.mint({
            url: `http://127.0.0.1:${address.port}/`,
            intent: "Read the fixture heading",
            input: {},
          });
        }),
      ),
    );
    expect(built.build).toBe("published");
    // Reviews share one conversation, so a request also carries the earlier question review.
    // Its own kind is that of its last submitted call.
    const executionReviews = reviewRequests.filter((request) => {
      const current = objects(request.input)
        .filter((item) => "submitted_call" in item)
        .at(-1);
      return current !== undefined && !("question_review" in current);
    });
    expect(executionReviews.length).toBeGreaterThan(0);
    for (const request of executionReviews) {
      expect(reviewedNative(request)).toBe(true);
      const policy = instructionsOf(request);
      for (const native of [
        "Operations use Kernel-shaped browser execute calls supplied by native Playwright",
        "attempts to bypass the reviewed execution path",
        "Offline targets (pureFiles, savedDOM, savedHTTP) authorize local fixture computation only",
        "runs through the user's local shell with the user's operating-system permissions",
        "Sign-in is handled by the host through its protected autofill of the observed sign-in screens",
        "waitPastChallenge is only a passive readiness wait. The native host supplies no automatic CAPTCHA solver.",
        "confirms only executor cleanup",
      ])
        expect(policy).toContain(native);
      expect(policy).toContain(guardianExecutionPolicy(nativeExecutionEnvironment));
    }
    const guide = await Effect.runPromise(loadStandaloneAuthoring(getAuthoringDirectory()));
    expect(mintRequests.length).toBeGreaterThan(0);
    for (const request of mintRequests) {
      expect(minterInstructions(request)).toContain(guide.instructions);
      expect(minterInstructions(request)).not.toContain("opengpt:");
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("a sign-in code asked during sign-in is typed into the code screen; a later action code is not marked", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs drive a two-screen native sign-in and two explores in Chromium",
  });
  test.setTimeout(60_000);
  const codesReceived: string[] = [];
  const body = async (request: AsyncIterable<unknown>) => {
    let text = "";
    for await (const chunk of request) text += String(chunk);
    return new URLSearchParams(text);
  };
  const directory = await mkdtemp(join(tmpdir(), "opengpt-sign-in-code-"));
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
    "/CN=www.codes.test",
    "-days",
    "1",
  ]);
  const tls = {
    key: await readFile(join(directory, "key.pem")),
    cert: await readFile(join(directory, "cert.pem")),
  };
  const server = createTlsServer(tls, (request, response) => {
    void (async () => {
      const cookie = request.headers.cookie ?? "";
      if (request.method === "POST" && request.url === "/login") {
        await body(request);
        response.writeHead(303, { "Set-Cookie": "stage=code; Path=/", Location: "/" });
        return response.end();
      }
      if (request.method === "POST" && request.url === "/code") {
        const code = (await body(request)).get("code") ?? "";
        codesReceived.push(code);
        response.writeHead(303, {
          ...(code === "135790" ? { "Set-Cookie": "signed=yes; Path=/" } : {}),
          Location: "/",
        });
        return response.end();
      }
      response.setHeader("Content-Type", "text/html");
      response.end(
        cookie.includes("signed=yes")
          ? `<title>Account</title><h1>Account</h1><div id="account">Your orders</div><form><label>Confirmation code<input name="confirm" autocomplete="one-time-code"></label></form>`
          : cookie.includes("stage=code")
            ? `<title>Verify</title><form method="post" action="/code"><label>We texted you a code<input name="code" autocomplete="one-time-code" inputmode="numeric"></label><button>Verify</button></form>`
            : `<title>Sign in</title><form method="post" action="/login"><label>User<input name="username" autocomplete="username"></label><label>Password<input name="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form>`,
      );
    })();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture address");
  const remote = await chromium.launchServer({
    args: [
      "--host-resolver-rules=MAP www.codes.test 127.0.0.1",
      "--no-proxy-server",
      "--ignore-certificate-errors",
    ],
  });
  /** A probe whose one browser call runs `code`. */
  const probe = (code: string) => `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"probe",input:Schema.Struct({}),output:Schema.Unknown},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:${JSON.stringify(code)},timeout_sec:5});
  if(!response.success) throw new Error(String(response.error));
  return response.result;
});`;
  const files: readonly (readonly [string, string])[] = [
    [
      "explore/code.mjs",
      probe(
        "await page.locator('input[name=code]').fill('{{secret.s1}}'); await page.getByRole('button', { name: 'Verify' }).click(); await page.locator('#account').waitFor({ timeout: 3000 }); return page.url();",
      ),
    ],
  ];
  // Written once its handle is issued: a handle the attempt never issued refuses every execution.
  const confirm = probe(
    "await page.locator('input[name=confirm]').fill('{{secret.s2}}'); return null;",
  );
  const created = (entries: readonly (readonly [string, string])[]): ModelResponse["output"] =>
    entries.map(([path, content]) => ({
      type: "apply_patch_call",
      callId: `patch_${path}`,
      status: "completed",
      operation: {
        type: "create_file",
        path,
        diff:
          content
            .split("\n")
            .map((line) => `+${line}`)
            .join("\n") + "\n",
      },
    }));
  const secretQuestion = (id: string, prompt: string) =>
    call(
      "request_input",
      {
        intent: prompt,
        questions: [{ id, type: "secret", secretKind: "one_time_code", prompt }],
      },
      id,
    );
  const explore = (entrypoint: string) =>
    call("execute", { ...execution, purpose: "explore", entrypoint }, entrypoint);
  const steps: ModelResponse["output"][] = [
    created(files),
    [
      call(
        "execute",
        {
          ...execution,
          purpose: "authenticate",
          signInStep: {
            fields: [
              { selector: "input[name=username]", accepts: ["username"] },
              { selector: "input[name=password]", slot: "password" },
            ],
            submit: "button",
          },
        },
        "sign_in",
      ),
    ],
    [secretQuestion("code", "Enter the code the site texted you to finish signing in.")],
    [explore("explore/code.mjs")],
    [
      call(
        "execute",
        {
          ...execution,
          purpose: "authenticate",
          signInStep: { signedIn: { selector: "#account" } },
        },
        "signed_in",
      ),
    ],
    [secretQuestion("confirm", "Enter the confirmation code the site sent for this action.")],
    created([["explore/confirm.mjs", confirm]]),
    [explore("explore/confirm.mjs")],
  ];
  const mintRequests: ModelRequest[] = [];
  // The scenario ends after the second probe; final text without a tool call ends the attempt.
  const minterProvider = provider(
    (_request, index) => steps[index] ?? [message("Stopping after the probes.")],
    mintRequests,
  );
  /** The trusted context of each execution review, by the entrypoint it reviewed. */
  const contexts = new Map<string, Record<string, unknown>>();
  const reviewRequests: ModelRequest[] = [];
  const guardianProvider = guardian(reviewRequests, (request) => {
    const current = objects(request.input)
      .filter((item) => "submitted_call" in item)
      .at(-1);
    const entrypoint = objects(current?.["submitted_call"]).at(0)?.["entrypoint"];
    const context = objects(current?.["trusted_execution_context"]).at(0) ?? {};
    if (typeof entrypoint === "string") contexts.set(entrypoint, context);
    // The recorded Guardian follows the policy: typing a handle into the sign-in form is allowed
    // only for a code the host lists as asked during this sign-in.
    if (entrypoint !== "operation/explore/code.mjs") return "allow";
    const listed = context["signInCodes"];
    return Array.isArray(listed) && listed.includes("{{secret.s1}}") ? "allow" : "deny";
  });
  const answers: Record<string, string> = {
    username: "ada@example.test",
    password: "fixture-password-4417",
    code: "135790",
    confirm: "246802",
  };
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createBrowserEngine({
            browser: { endpoint: remote.wsEndpoint() },
            minterProvider,
            guardianProvider,
            outcomeReviewerProvider: quietReviewer,
            ask: makeInputAsker((request) =>
              Effect.succeed(
                Object.fromEntries(
                  request.questions.map((question) => [
                    question.id,
                    question.type === "credential"
                      ? { username: answers.username, password: answers.password, saveLogin: false }
                      : (answers[question.id] ?? ""),
                  ]),
                ),
              ),
            ),
            timeoutMs: 45_000,
          });
          yield* service.mint({
            url: `https://www.codes.test:${address.port}/`,
            intent: "Read my account page title",
            effect: "read",
            input: {},
          });
        }),
      ),
    );
    // The site took the code the caller supplied for this sign-in, typed by the agent's probe.
    expect(codesReceived).toEqual(["135790"]);
    expect(contexts.get("operation/explore/code.mjs")?.["signInCodes"]).toEqual(["{{secret.s1}}"]);
    // A code asked after the sign-in was verified is an action's code, reviewed as before.
    expect(contexts.get("operation/explore/confirm.mjs")).toBeDefined();
    expect(contexts.get("operation/explore/confirm.mjs")?.["signInCodes"]).toBeUndefined();
    for (const value of Object.values(answers).slice(1))
      expect(JSON.stringify([mintRequests, reviewRequests])).not.toContain(value);
  } finally {
    await remote.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

const SavedControls = Schema.parseJson(
  Schema.Struct({
    controls: Schema.Array(
      Schema.Struct({
        role: Schema.String,
        name: Schema.NullOr(Schema.String),
        type: Schema.NullOr(Schema.String),
        required: Schema.Boolean,
        visible: Schema.Boolean,
        enabled: Schema.Boolean,
      }),
    ),
    total: Schema.Number,
  }),
);
const LastScreen = Schema.Struct({
  lastScreen: Schema.Struct({
    path: Schema.Literal("captures/after-submit/1.json"),
    controls: Schema.Array(Schema.Unknown),
    truncated: Schema.optional(Schema.String),
  }),
});

/**
 * A synthetic 169-character identifier, longer than a control's shown name, so cutting a name
 * before screening would leave a long piece of it.
 */
const longIdentifier = `${Array.from({ length: 156 }, (_, index) => "abcdefghijklmnopqrstuvwxyz0123456789"[(index * 7) % 36]).join("")}@example.test`;
/** Every 12-character piece of `value` that `text` contains. */
const piecesIn = (text: string, value: string) =>
  Array.from({ length: value.length - 11 }, (_, at) => value.slice(at, at + 12)).filter((piece) =>
    text.includes(piece),
  );

/**
 * A mint that signs in on the shop's two-screen sign-in: the identifier step, a read of the saved
 * controls, then (with `failNext`) a step whose field the next screen lacks. It answers the login
 * question with `identifier` as the username, and any other with `identifier`, and returns the
 * file as saved on disk after the first submit, and each tool result by call id.
 */
const twoScreenSignIn = async (options: {
  readonly identifier: string;
  readonly loginPath: string;
  readonly failNext: boolean;
}) => {
  const directory = await mkdtemp(join(tmpdir(), "opengpt-after-submit-"));
  const shop = await startShop(directory);
  // Marks this sign-in's help links, so the test finds its own saved file among parallel tests'.
  const tag = `tag${randomUUID().slice(0, 8)}`;
  const remote = await chromium.launchServer({
    args: [
      `--host-resolver-rules=MAP ${shop.hostname} 127.0.0.1`,
      "--no-proxy-server",
      "--ignore-certificate-errors",
    ],
  });
  // The minter reads the saved file on its next turn; the test reads it from disk then.
  const savedFile = () =>
    readdirSync(tmpdir())
      .filter((entry) => entry.startsWith("opengpt-workspace-"))
      .map((entry) => join(tmpdir(), entry, "captures/after-submit/1.json"))
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path, "utf8"))
      .find((text) => text.includes(tag));
  let saved: string | undefined;
  const mintRequests: ModelRequest[] = [];
  const signInStep = (step: unknown, callId: string) =>
    call("execute", { ...execution, purpose: "authenticate", signInStep: step }, callId);
  const minter = provider((_request, index) => {
    if (index === 0)
      return [
        signInStep(
          { fields: [{ selector: "#username", accepts: ["email"] }], submit: "#next" },
          "identifier",
        ),
      ];
    if (index === 1) {
      saved = savedFile();
      return [
        call(
          "read_source",
          { path: "captures/after-submit/1.json", offset: null, limit: null },
          "read_controls",
        ),
      ];
    }
    if (index === 2 && options.failNext)
      return [
        signInStep(
          { fields: [{ selector: "#pin", slot: "password" }], submit: "#sign-in" },
          "wrong_screen",
        ),
      ];
    return [message("Stopping here.")];
  }, mintRequests);
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* createBrowserEngine({
            browser: { endpoint: remote.wsEndpoint() },
            minterProvider: minter,
            guardianProvider: guardian([]),
            outcomeReviewerProvider: quietReviewer,
            ask: makeInputAsker((request) =>
              Effect.succeed(
                Object.fromEntries(
                  request.questions.map((question) => [
                    question.id,
                    question.type === "credential"
                      ? {
                          username: options.identifier,
                          password: "synthetic-password",
                          saveLogin: false,
                        }
                      : options.identifier,
                  ]),
                ),
              ),
            ),
            timeoutMs: 30_000,
          });
          yield* service.mint({
            url: `${shop.origin}${options.loginPath}${options.loginPath.includes("?") ? "&" : "?"}tag=${tag}`,
            intent: "Read the account heading",
            effect: "read",
            input: {},
          });
        }),
      ),
    );
  } finally {
    await remote.close();
    await shop.close();
    await rm(directory, { recursive: true, force: true });
  }
  const toolResult = (callId: string) => {
    const result = objects(mintRequests.at(-1)?.input).find(
      (item) => item["type"] === "function_call_result" && item["callId"] === callId,
    );
    if (result === undefined) throw new Error(`No ${callId} result`);
    return result;
  };
  return { saved, toolResult, mintRequests };
};

test("a two-screen sign-in saves the next screen's controls and inlines them when the next step fails", async () => {
  test.info().annotations.push({
    type: "slow",
    description:
      "Original SDKs, Chromium and two host autofill steps through a real form navigation",
  });
  test.setTimeout(45_000);
  const email = shopAccount.username;
  const { saved, toolResult, mintRequests } = await twoScreenSignIn({
    identifier: email,
    loginPath: "/sign-in",
    failNext: true,
  });
  // The file is saved after the first submit, with the next screen's controls and no value.
  expect(saved).toBeDefined();
  const file = Schema.decodeUnknownSync(SavedControls)(saved);
  expect(saved).not.toContain(email);
  expect(file.controls).toContainEqual(
    expect.objectContaining({ type: "password", required: true, visible: true, enabled: true }),
  );
  expect(file.controls).toContainEqual(
    expect.objectContaining({ role: "button", name: "Trouble signing in", enabled: false }),
  );
  expect(file.controls).toContainEqual(expect.objectContaining({ name: "Code", visible: false }));
  expect(file.total).toBe(shopHelpLinks + 4);
  // The step result names the file and adds no control list.
  const identifier = JSON.stringify(toolResult("identifier"));
  expect(identifier).toContain("captures/after-submit/1.json");
  expect(identifier).not.toContain("Help topic");
  // Where the click went is the host's alone: no step result the minter reads holds it.
  for (const callId of ["identifier", "wrong_screen"])
    expect(objects(toolResult(callId)).filter((item) => "navigated" in item)).toEqual([]);
  // The minter reads it like any other workspace file.
  const read = JSON.stringify(toolResult("read_controls"));
  expect(read).toContain("Help topic 0");
  expect(read).not.toContain(email);
  // A step that cannot find its screen carries the saved controls inline, capped.
  const failed = objects(toolResult("wrong_screen")).find((item) => "lastScreen" in item);
  const lastScreen = Schema.decodeUnknownSync(LastScreen)(failed).lastScreen;
  expect(lastScreen.controls).toHaveLength(30);
  expect(lastScreen.truncated).toBeDefined();
  expect(JSON.stringify(mintRequests)).not.toContain(email);
});

test("a long typed identifier the next screen echoes in a label never appears in its saved or inline controls, even in part", async () => {
  test.info().annotations.push({
    type: "slow",
    description:
      "Original SDKs, Chromium and two host autofill steps through a real form navigation",
  });
  test.setTimeout(45_000);
  const identifier = longIdentifier;
  const { saved, toolResult, mintRequests } = await twoScreenSignIn({
    identifier,
    loginPath: "/sign-in",
    failNext: true,
  });
  expect(saved).toBeDefined();
  const failed = JSON.stringify(
    objects(toolResult("wrong_screen")).find((item) => "lastScreen" in item),
  );
  expect(failed).toContain("Password for");
  for (const text of [saved ?? "", failed, JSON.stringify(mintRequests)])
    expect(piecesIn(text, identifier)).toEqual([]);
});

test("a label padded so a typed identifier crosses the text limit leaves the field unnamed, with no piece of the identifier", async () => {
  test.info().annotations.push({
    type: "slow",
    description:
      "Original SDKs, Chromium and two host autofill steps through a real form navigation",
  });
  test.setTimeout(45_000);
  // Only the identifier's first 64 characters fit under the limit.
  const { saved, toolResult, mintRequests } = await twoScreenSignIn({
    identifier: longIdentifier,
    loginPath: `/sign-in?pad=${pageControlTextLimit - 64}`,
    failNext: true,
  });
  const file = Schema.decodeUnknownSync(SavedControls)(saved);
  expect(file.controls).toContainEqual(
    expect.objectContaining({ type: "password", name: null, visible: true }),
  );
  const failed = objects(toolResult("wrong_screen")).find((item) => "lastScreen" in item);
  expect(Schema.decodeUnknownSync(LastScreen)(failed).lastScreen.controls).toContainEqual(
    expect.objectContaining({ type: "password", name: null }),
  );
  for (const text of [saved ?? "", JSON.stringify(failed), JSON.stringify(mintRequests)])
    expect(piecesIn(text, longIdentifier)).toEqual([]);
});

const SavedAlerts = Schema.parseJson(
  Schema.Struct({ alerts: Schema.optional(Schema.Array(Schema.String)) }),
);

// A screen's error can be gone by the time the agent looks, so the host keeps its visible alert
// lines with the controls it saves after the submit, screened like control names: the typed
// identifier the error names never reaches the file, and a hidden error is not kept. An error the
// page marks only by its class and id counts too.
for (const { alert, shown } of [
  { alert: "1", shown: "an alert" },
  { alert: "class", shown: "an error class" },
])
  test(`a submit's visible error text is saved with the next screen's controls, without the typed identifier: ${shown}`, async () => {
    test.info().annotations.push({
      type: "slow",
      description: "Original SDKs, Chromium and a host autofill step through a real form navigation",
    });
    test.setTimeout(45_000);
    const email = shopAccount.username;
    const { saved, mintRequests } = await twoScreenSignIn({
      identifier: email,
      loginPath: `/sign-in?alert=${alert}`,
      failNext: false,
    });
    expect(saved).toBeDefined();
    const alerts = Schema.decodeUnknownSync(SavedAlerts)(saved).alerts ?? [];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("Check the password for");
    expect(saved).not.toContain(email);
    expect(saved).not.toContain("Hidden error");
    expect(JSON.stringify(mintRequests)).not.toContain(email);
  });

test("a next screen whose first hundred controls are hidden still saves its visible sign-in field", async () => {
  test.info().annotations.push({
    type: "slow",
    description: "Original SDKs, Chromium and a host autofill step through a real form navigation",
  });
  test.setTimeout(45_000);
  const { saved } = await twoScreenSignIn({
    identifier: shopAccount.username,
    loginPath: `/sign-in?hidden=${pageControlsLimit}`,
    failNext: false,
  });
  const file = Schema.decodeUnknownSync(SavedControls)(saved);
  expect(file.total).toBe(pageControlsLimit + shopHelpLinks + 4);
  expect(file.controls).toHaveLength(pageControlsLimit);
  expect(file.controls[0]).toEqual(
    expect.objectContaining({ type: "password", required: true, visible: true, enabled: true }),
  );
});

test("finish_build runs a contract review, then one publication review, and saves what the operation can load", async () => {
  test.setTimeout(60_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>Fixture</title><h1>Public fixture</h1>"),
  );
  const guardian = recordingGuardian();
  // What the minter had read of the publication skill when it called finish_build.
  let skillRead: Record<string, unknown> | undefined;
  try {
    const { built, requests } = await mintWith({
      effect: "read",
      url: site.url,
      guardian,
      turns: [
        () =>
          patchFiles({
            "src/tool.mjs": headingOperation,
            "src/heading.mjs":
              'import { trim } from "../explore/trim.mjs";\nexport const heading = (value) => trim(String(value));',
            "explore/trim.mjs": "export const trim = (value) => value.trim();",
            "src/query.graphql": "query { heading }",
            "src/labels.cjs": "module.exports = { heading: 'Heading' };",
            "explore/look.mjs": probe(),
            "scratch/notes.mjs": "export const notes = 1;",
          }),
        () => [fixtureCall("execute", fixtureExecution("example", "src/tool.mjs"), "example")],
        () => [
          fixtureCall(
            "read_source",
            { path: ".agents/publication/SKILL.md", offset: null, limit: null },
            "publication_skill",
          ),
        ],
        (request) => {
          skillRead = objects(request.input).find(
            (item) =>
              item["kind"] === "untrusted_source" &&
              item["path"] === ".agents/publication/SKILL.md",
          );
          return [
            fixtureCall("finish_build", {
              intent: "Return the fixture integration",
              entrypoint: "src/tool.mjs",
              executionId: executionIdOf(request, "example"),
              metadata: { name: "read_fixture", description: "Read the fixture heading" },
              coverage: "One live example",
            }),
          ];
        },
      ],
    });
    expect(built.build, JSON.stringify(built)).toBe("published");
    // After its example, the build's reviews are the offline contract run's, then publication's.
    const example = guardian.reviews.findIndex(
      (review) => currentOf(review)?.["purpose"] === "example",
    );
    const after = guardian.reviews.slice(example + 1);
    expect(after.map((review) => review.kind)).toEqual(["execution", "publication"]);
    expect(currentOf(after[0]!)?.["purpose"]).toBe("contract");
    expect(guardian.reviews.filter((review) => "trusted_publication" in review.input)).toEqual([
      after[1],
    ]);
    // Every src/ file is saved, whatever its extension, with the entrypoint and the files it
    // imports; other probes are not.
    expect(built.artifact?.files.map((file) => file.path).sort()).toEqual([
      "explore/trim.mjs",
      "src/heading.mjs",
      "src/labels.cjs",
      "src/query.graphql",
      "src/tool.mjs",
    ]);
    // The builder's instructions send it to the publication skill before its first
    // finish_build. The skill it reads there is every host's shared text, and the list on top of
    // its instructions names the private fallback publication the local host lacks.
    expect(minterInstructions(requests[0])).toContain(
      "Read .agents/publication/SKILL.md before your first `finish_build`",
    );
    expect(minterInstructions(requests[0])).toContain("- Private fallback publication");
    expect(String(skillRead?.["source"])).toContain("# Publishing a build");
    expect(String(skillRead?.["source"]).replace(/\s+/g, " ")).toContain(
      "After the last round the host publishes privately and flags it",
    );
  } finally {
    await site.close();
  }
});
