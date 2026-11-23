import { test, expect } from "@playwright/test";
import {
  authorityOf,
  call,
  contextOf,
  currentOf,
  execution,
  executionIdOf,
  headingOperation,
  html,
  intentOf,
  objects,
  patch,
  probe,
  recordingGuardian,
  startSite,
  toolResult,
  writePath,
  type RecordedReview,
} from "./guardian-context-fixture.js";
import {
  act,
  effectsOf,
  executions,
  historyOf,
  mint,
  noteSite,
  readNote,
  saveNote,
  saveSite,
  saveStep,
  type Turn,
} from "./standalone-mint-fixture.js";

const sourcesOf = (review: RecordedReview, key: string) =>
  [...((contextOf(review)?.[key] as readonly string[] | undefined) ?? [])].sort();
const stepResultsOf = (review: RecordedReview | undefined) =>
  review?.input["untrusted_step_results"] as
    readonly { readonly executionId: string; readonly result: string }[] | undefined;
const offline =
  "Offline local files, source checks and computation only. No live website, credentials or network.";
const dated = {
  todayUtc: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u),
  nowUtc: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
};
const observationsOf = (review: RecordedReview | undefined) =>
  String(review?.input["untrusted_observations"]).split("\n");
/** The minter's question whether the build may save, and the update it makes once confirmed. */
const saveQuestion = {
  intent: "Ask whether the build may save",
  questions: [
    {
      id: "save",
      type: "choice",
      prompt: "Saving the note changes the site. May this build save it?",
      options: [
        { id: "save", label: "Yes, save the note" },
        { id: "look", label: "No, only look" },
      ],
    },
  ],
};
const toWrite = (confirmedBy: readonly string[]) => ({
  intent: "Make the build a write, as the caller confirmed",
  summary: "Save the note on the site instead of only reading it.",
  changes: [{ setting: "effect", effect: "write" }],
  confirmedBy,
  recommend: "update",
});
test("a read build's reviews carry each step's own context", async () => {
  test.setTimeout(90_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>Fixture</title><h1>Public fixture</h1>"),
  );
  const guardian = recordingGuardian();
  try {
    const { built, requests, last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      answer: () => ({ note: "plain" }),
      turns: [
        () =>
          patch({
            "src/tool.mjs": headingOperation,
            "src/heading.mjs": "export const heading = (value) => String(value).trim();",
            "src/unused.mjs": "export const unused = 1;",
            "explore/look.mjs": probe(),
          }),
        () => [
          call("request_input", {
            intent: "Ask which note to keep",
            questions: [{ id: "note", type: "text", prompt: "Which note should I keep?" }],
          }),
        ],
        () => [call("exec_command", { cmd: "ls src" }, "command")],
        () => [call("execute", execution("explore", "explore/look.mjs"), "explore")],
        () => [call("execute", execution("test", "src/tool.mjs", { testInput: "{}" }), "test")],
        () => [call("execute", execution("example", "src/tool.mjs"), "example_1")],
        () => [call("execute", execution("example", "src/tool.mjs"), "example_2")],
        (request) => [
          call("finish_build", {
            intent: "Return the fixture integration",
            entrypoint: "src/tool.mjs",
            executionId: executionIdOf(request, "example_2"),
            metadata: { name: "read_fixture", description: "Read the fixture heading" },
            coverage: "One live example",
          }),
        ],
      ],
    });
    expect(built.build, JSON.stringify(built)).toBe("published");
    // The minter's request carries the host's date.
    const screened = objects(requests[0]?.input).find(
      (value) => "intent" in value && "observations" in value,
    );
    expect(screened?.["observations"]).toEqual(dated);

    // A question review has no step: no effects, no current execution and no step results. The
    // request's page loaded before the build started, so the browser is already active.
    const question = guardian.reviews.find((review) => review.kind === "question");
    expect(effectsOf(question)).toEqual([]);
    expect(contextOf(question!)).toMatchObject({ repeatableRead: true, browser: "active" });
    expect(contextOf(question!)).not.toHaveProperty("currentExecution");
    expect(question?.input).not.toHaveProperty("untrusted_step_results");

    const reviewed = executions(guardian.reviews);
    expect(reviewed.map((review) => currentOf(review)?.["purpose"])).toEqual([
      "command",
      "explore",
      "test",
      "example",
      "example",
      "contract",
    ]);
    const [command, explore, liveTest, example1, example2, contract] = reviewed;
    for (const review of reviewed) {
      expect(contextOf(review)?.["repeatableRead"]).toBe(true);
      expect(JSON.parse(observationsOf(review)[0] ?? "")).toEqual(dated);
      expect(stepResultsOf(review)).toEqual(expect.any(Array));
    }
    // Each step gets the authority its own kind of work needs.
    expect(effectsOf(command)).toEqual([offline]);
    expect(effectsOf(contract)).toEqual([offline]);
    for (const review of [explore, liveTest, example1, example2]) {
      expect(effectsOf(review)[0]).toMatch(/^Authorized repeatable reads/u);
      // Each read review is told the request's context, such as today's date, is not a filter.
      expect(effectsOf(review)[0]).toContain(
        "Respect constraints the request states, such as a date range, filter, sort or limit. Context it gives, such as the current date or the caller's location, is not a constraint unless the request applies it.",
      );
    }

    // The command runs before any live step, with its sandbox's facts.
    expect(currentOf(command!)).toEqual({
      purpose: "command",
      target: "pureFiles",
      // The working directory is the workspace itself, never the host's path to it.
      commandSandbox: { cwd: ".", timeoutSeconds: 30, maxOutputBytes: 1_048_576 },
    });
    expect(contextOf(command!)).not.toHaveProperty("executedSources");
    expect(contextOf(command!)?.["browser"]).toBe("active");
    // Executed sources are the entrypoint's imports, not the whole workspace.
    expect(sourcesOf(explore!, "executedSources")).toEqual(["operation/explore/look.mjs"]);
    expect(sourcesOf(explore!, "operationSources")).toContain("operation/src/unused.mjs");
    // No live step has observed a page yet, so Guardian is shown none.
    expect(contextOf(explore!)?.["browser"]).toBe("active");
    expect(contextOf(explore!)).not.toHaveProperty("currentPage");
    // A live test and an example start on a reset page, so Guardian is not shown the page the
    // last step left; it still gets the last results.
    expect(contextOf(liveTest!)?.["browser"]).toBe("active");
    for (const review of [liveTest, example1, example2])
      expect(contextOf(review!)).not.toHaveProperty("currentPage");
    expect(sourcesOf(liveTest!, "executedSources")).toEqual([
      "operation/src/heading.mjs",
      "operation/src/tool.mjs",
    ]);
    expect(currentOf(liveTest!)).toEqual({
      purpose: "test",
      target: "liveBrowser",
      input: "agent_chosen",
    });
    expect(stepResultsOf(liveTest)).toHaveLength(2);
    // The input schema comes from the latest example or contract run.
    for (const review of [command, explore, liveTest, example1])
      expect(contextOf(review!)).not.toHaveProperty("inputSchema");
    expect(String(contextOf(example2!)?.["inputSchema"])).toContain("object");
    expect(String(contextOf(contract!)?.["inputSchema"])).toContain("object");
    expect(observationsOf(contract).slice(1).join("\n")).toContain("never calls operation.run");
    expect(
      historyOf(example2).map(
        (entry) =>
          `${String(entry["purpose"])}:${String(entry["status"])}${entry["input"] === undefined ? "" : `:${String(entry["input"])}`}`,
      ),
    ).toEqual([
      "command:completed",
      "explore:completed",
      "test:completed:agent_chosen",
      "example:completed",
    ]);

    // A read build may run its example again.
    expect(toolResult(last, "test")).toMatchObject({ status: "completed" });
    expect(toolResult(last, "example_2")).toMatchObject({ status: "completed" });
    expect(JSON.stringify(objects(last?.input))).not.toContain("AlreadyExecuted");
  } finally {
    await site.close();
  }
});

// A "By design:" input, a limited use such as a postal code that only lists nearby stores, counts
// as applied only on the caller's answer to that input's design question. The publication review
// hears that answer under the question's id, which binds it to its input, and no published
// revision's inputs, since the local host keeps none.
test("a publication review hears the caller's design answer by its question's id", async () => {
  test.setTimeout(90_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>Fixture</title><h1>Public fixture</h1>"),
  );
  const guardian = recordingGuardian();
  const prompt = "Should the postal code set the store, or only list nearby stores?";
  try {
    const { built } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      answer: () => ({ input_use_postal_code: "nearby_only" }),
      turns: [
        () => patch({
            "src/tool.mjs": headingOperation,
            "src/heading.mjs": "export const heading = (value) => String(value).trim();",
          }),
        () => [
          call("request_input", {
            intent: "Ask how the tool should use the postal code",
            questions: [
              {
                id: "input_use_postal_code",
                type: "choice",
                prompt,
                options: [
                  { id: "set_store", label: "Set the store from it" },
                  { id: "nearby_only", label: "Only list nearby stores" },
                ],
              },
            ],
          }),
        ],
        () => [call("execute", execution("example", "src/tool.mjs"), "example")],
        (request) => [
          call("finish_build", {
            intent: "Return the fixture integration",
            entrypoint: "src/tool.mjs",
            executionId: executionIdOf(request, "example"),
            metadata: { name: "read_fixture", description: "Read the fixture heading" },
            coverage: "One live example",
          }),
        ],
      ],
    });
    expect(built.build, JSON.stringify(built)).toBe("published");
    const publication = guardian.reviews.filter((review) => review.kind === "publication");
    expect(publication).toHaveLength(1);
    expect(authorityOf(publication[0]!)["answeredQuestions"]).toEqual([
      { id: "input_use_postal_code", question: prompt, answer: "Only list nearby stores" },
    ]);
    expect(publication[0]?.input["trusted_publication"]).not.toHaveProperty("publishedInputs");
  } finally {
    await site.close();
  }
});

test("a step that starts on a reset page is shown no page, and the next step the page it left", async () => {
  test.setTimeout(90_000);
  const site = await startSite((request, response) =>
    html(
      response,
      `<title>Fixture</title><h1>${new URL(request.url ?? "/", "http://fixture.invalid").pathname}</h1>`,
    ),
  );
  const guardian = recordingGuardian();
  try {
    const { last } = await mint({
      effect: "read",
      url: `${site.origin}/entry`,
      guardian,
      turns: [
        () =>
          patch({
            "src/tool.mjs": headingOperation,
            "src/heading.mjs": "export const heading = (value) => String(value).trim();",
            "explore/deeper.mjs": probe(
              "await page.goto(new URL('/deep', page.url()).href); return page.url();",
            ),
            "explore/look.mjs": probe(),
          }),
        () => [call("execute", execution("example", "src/tool.mjs"), "example")],
        () => [call("execute", execution("explore", "explore/deeper.mjs"), "deeper")],
        () => [call("execute", execution("explore", "explore/look.mjs"), "look")],
        () => [call("execute", execution("test", "src/tool.mjs", { testInput: "{}" }), "test")],
      ],
    });
    for (const id of ["example", "deeper", "look", "test"])
      expect(toolResult(last, id), id).toMatchObject({ status: "completed" });
    const [example, deeper, look, liveTest] = executions(guardian.reviews);
    expect(executions(guardian.reviews).map((review) => currentOf(review)?.["purpose"])).toEqual([
      "example",
      "explore",
      "explore",
      "test",
    ]);
    // The example is the first live step. The request's page loaded before the build started, so
    // the browser is active, but the example starts on a reset page and is shown none.
    expect(contextOf(example!)?.["browser"]).toBe("active");
    expect(contextOf(example!)).not.toHaveProperty("currentPage");
    // It reset the page and loaded the site root, which the next explore continues from.
    expect(contextOf(deeper!)).toMatchObject({
      browser: "active",
      currentPage: { origin: site.origin, path: "/" },
    });
    expect(contextOf(look!)).toMatchObject({
      browser: "active",
      currentPage: { origin: site.origin, path: "/deep" },
    });
    // A live test starts on a reset page again, so it is shown none.
    expect(contextOf(liveTest!)?.["browser"]).toBe("active");
    expect(contextOf(liveTest!)).not.toHaveProperty("currentPage");
  } finally {
    await site.close();
  }
});

test("Guardian reads the page the build last observed, with private values redacted", async () => {
  test.setTimeout(90_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>Account</title><h1>Account</h1><p>Code fixture-private-value</p>"),
  );
  const guardian = recordingGuardian({ readPage: true });
  try {
    await mint({
      effect: "read",
      url: site.url,
      guardian,
      answer: () => ({ code: "fixture-private-value" }),
      turns: [
        () => patch({ "explore/look.mjs": probe() }),
        () => [
          call("request_input", {
            intent: "Ask for the private code",
            questions: [
              { id: "code", type: "secret", secretKind: "private_text", prompt: "Which code?" },
            ],
          }),
        ],
        () => [call("execute", execution("explore", "explore/look.mjs"), "first")],
        () => [call("execute", execution("explore", "explore/look.mjs"), "second")],
      ],
    });
    const [first, second] = executions(guardian.reviews);
    // The minter's own request_input is not a script's question.
    const asked = guardian.reviews.find((review) => review.kind === "question");
    expect(asked?.input["question_review"]).not.toHaveProperty("scriptAsk");
    expect(contextOf(first!)).not.toHaveProperty("currentPage");
    expect(contextOf(second!)?.["currentPage"]).toEqual({
      origin: site.origin,
      path: "/",
      capture: "captures/current-page.aria.yml",
    });
    const capture = second!.reads.find((read) => read["path"] === "captures/current-page.aria.yml");
    expect(String(capture?.["source"])).toContain("Account");
    expect(String(capture?.["source"])).toContain("[private]");
    expect(JSON.stringify(guardian.reviews)).not.toContain("fixture-private-value");
  } finally {
    await site.close();
  }
});

test("a question a running step asks shows Guardian that step running", async () => {
  test.setTimeout(90_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>Fixture</title><h1>Public fixture</h1>"),
  );
  const guardian = recordingGuardian();
  try {
    const { last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      answer: () => ({ note: "plain" }),
      turns: [
        () =>
          patch({
            "explore/ask.mjs": `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"ask_note",input:Schema.Unknown,output:Schema.Unknown,questions:{note:{type:"text",prompt:"Which note should I keep?"}}},
async ({ ask }) => ({ note: await ask("note") }));`,
          }),
        () => [call("execute", execution("explore", "explore/ask.mjs"), "ask")],
      ],
    });
    expect(toolResult(last, "ask")).toMatchObject({ status: "completed" });
    const question = guardian.reviews.find((review) => review.kind === "question");
    // A script's own question, which Guardian judges as one a published tool asks at run time.
    expect(question?.input["question_review"]).toMatchObject({ scriptAsk: true });
    expect(effectsOf(question)).toEqual([]);
    expect(historyOf(question)).toEqual([
      expect.objectContaining({ purpose: "explore", status: "running", effect: "possible" }),
    ]);
  } finally {
    await site.close();
  }
});

const approvalPrompt = "Do you approve the site terms for this booking?";
const approvalQuestions = `{approve:{type:"confirm",prompt:${JSON.stringify(approvalPrompt)}}}`;
/** A write step whose script asks the owner to approve the site's terms, then runs `then`. */
const approvingStep = (then: string) => `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"approve_terms",input:Schema.Unknown,output:Schema.Unknown,questions:${approvalQuestions},write:{confirmation:"message",commits:["submit"]}},
async ({ ask, enteringCommit }) => { ${then} });`;
const askThenFail = "await ask('approve'); throw new Error('Failed before its commit.');";
/**
 * Mints a write whose first step asks and then runs `first`, after the turns `between` a later
 * step runs `later`, and a last step explores; every question is answered yes.
 */
const laterAsk = async (steps: {
  readonly first: string;
  readonly later: string;
  readonly between?: readonly Turn[];
}) => {
  const site = await startSite((_request, response) =>
    html(response, "<title>Fixture</title><h1>Public fixture</h1>"),
  );
  const guardian = recordingGuardian();
  try {
    const minted = await mint({
      effect: "write",
      url: site.url,
      guardian,
      answer: () => ({ approve: { confirmed: true } }),
      turns: [
        () =>
          patch({
            "src/tool.mjs": approvingStep(steps.first),
            "src/again.mjs": approvingStep(steps.later),
            "explore/look.mjs": probe(),
          }),
        () => [call("execute", act("src/tool.mjs", undefined, writePath("submit")), "first")],
        ...(steps.between ?? []),
        () => [call("execute", act("src/again.mjs"), "later")],
        () => [call("execute", execution("explore", "explore/look.mjs"), "look")],
      ],
    });
    expect(toolResult(minted.last, "first")).toMatchObject({ status: "failed" });
    expect(toolResult(minted.last, "later")).toMatchObject({ status: "completed" });
    const scriptAsks = minted.asked.filter((request) => request.source === "script");
    return { ...minted, guardian, scriptAsks };
  } finally {
    await site.close();
  }
};

test("a later step reuses the owner's answer to its script's question", async () => {
  test.setTimeout(90_000);
  const { scriptAsks, guardian } = await laterAsk({
    first: askThenFail,
    later: "return { approve: await ask('approve') };",
  });
  expect(scriptAsks).toHaveLength(1);
  // Guardian reviewed the later step's ask, and later reviews hold the owner's answer it reused.
  expect(guardian.reviews.filter((review) => review.kind === "question")).toHaveLength(2);
  expect(authorityOf(executions(guardian.reviews).at(-1)!)["answeredQuestions"]).toEqual([
    { id: "approve", question: approvalPrompt, answer: { confirmed: true } },
  ]);
});

test("a later step reuses the owner's answer even after an earlier step entered its commit", async () => {
  test.setTimeout(90_000);
  const { scriptAsks } = await laterAsk({
    first: "await ask('approve'); enteringCommit('submit'); throw new Error('Failed after it.');",
    later: "return { approve: await ask('approve') };",
  });
  expect(scriptAsks).toHaveLength(1);
});

test("a step reuses the owner's answer each time its script asks the same question", async () => {
  test.setTimeout(90_000);
  const { scriptAsks, guardian, last } = await laterAsk({
    first: askThenFail,
    later:
      "const first = await ask('approve'); enteringCommit('submit'); return { first, second: await ask('approve') };",
  });
  expect(scriptAsks).toHaveLength(1);
  // Guardian reviewed each of the three asks.
  expect(guardian.reviews.filter((review) => review.kind === "question")).toHaveLength(3);
  // Both asks got the owner's yes.
  const observed: unknown = JSON.parse(String(toolResult(last, "later")?.["observations"]));
  expect(observed).toMatchObject({
    output: { first: { confirmed: true }, second: { confirmed: true } },
  });
});

test("a later step asks the owner again once the owner answered its prompt anew", async () => {
  test.setTimeout(90_000);
  const { asked, scriptAsks } = await laterAsk({
    first: askThenFail,
    later: "return { approve: await ask('approve') };",
    between: [
      () => [
        call("request_input", {
          intent: "Ask the caller about the terms",
          questions: [{ id: "approve", type: "confirm", prompt: approvalPrompt }],
        }),
      ],
    ],
  });
  expect(asked.map((request) => request.source)).toEqual(["script", "agent", "script"]);
  expect(scriptAsks).toHaveLength(2);
});

test("a script's question after a task update asks the owner again", async () => {
  test.setTimeout(90_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>Fixture</title><h1>Public fixture</h1>"),
  );
  const guardian = recordingGuardian();
  try {
    const { last, asked } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      answer: (request) =>
        request.source === "script" ? { approve: { confirmed: true } } : { save: "save" },
      turns: [
        () =>
          patch({
            "explore/ask.mjs": `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"approve_terms",input:Schema.Unknown,output:Schema.Unknown,questions:${approvalQuestions}},
async ({ ask }) => ({ approve: await ask("approve") }));`,
          }),
        () => [call("execute", execution("explore", "explore/ask.mjs"), "before")],
        () => [call("request_input", saveQuestion, "ask")],
        () => [call("mint_update", toWrite(["save"]), "update")],
        () => [call("execute", execution("explore", "explore/ask.mjs"), "after")],
      ],
    });
    expect(toolResult(last, "update")).toMatchObject({ status: "updated" });
    expect(toolResult(last, "after")).toMatchObject({ status: "completed" });
    expect(asked.map((request) => request.source)).toEqual(["script", "agent", "script"]);
  } finally {
    await site.close();
  }
});

test("a step asks only what its entrypoint declares as a plain literal", async () => {
  test.setTimeout(90_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>Fixture</title><h1>Public fixture</h1>"),
  );
  const guardian = recordingGuardian();
  try {
    const { last, asked } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      answer: () => ({ note: "plain" }),
      turns: [
        () =>
          patch({
            // The running module declares the question, but the host reads no literal it can trust.
            "explore/computed.mjs": `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
const questions = {note:{type:"text",prompt:"Which note should I keep?"}};
export default defineOperation({name:"ask_note",input:Schema.Unknown,output:Schema.Unknown,questions},
async ({ ask }) => ({ note: await ask("note") }));`,
            "explore/invalid.mjs": `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"ask_note",input:Schema.Unknown,output:Schema.Unknown,questions:{Note:{type:"text",prompt:"Which note should I keep?"}}},
async ({ ask }) => ({ note: await ask("Note") }));`,
          }),
        () => [call("execute", execution("explore", "explore/computed.mjs"), "computed")],
        () => [call("execute", execution("explore", "explore/invalid.mjs"), "invalid")],
      ],
    });
    // The computed declaration ran, but its ask reached neither Guardian nor the owner.
    expect(toolResult(last, "computed")).toMatchObject({ status: "failed" });
    expect(JSON.stringify(toolResult(last, "computed"))).toContain("Undeclared");
    expect(guardian.reviews.filter((review) => review.kind === "question")).toEqual([]);
    expect(asked).toEqual([]);
    // An invalid literal id is refused before review, and nothing runs.
    expect(toolResult(last, "invalid")).toMatchObject({
      status: "unsupported",
      observations: expect.stringContaining('Invalid script question id: "Note".'),
    });
    expect(executions(guardian.reviews)).toHaveLength(1);
  } finally {
    await site.close();
  }
});

test("a question a step asks after its page reset never shows Guardian the page the last step left", async () => {
  test.setTimeout(90_000);
  const site = await startSite((request, response) =>
    html(
      response,
      `<title>Fixture</title><h1>${new URL(request.url ?? "/", "http://fixture.invalid").pathname}</h1>`,
    ),
  );
  const guardian = recordingGuardian();
  try {
    const { last } = await mint({
      effect: "read",
      url: `${site.origin}/entry`,
      guardian,
      answer: () => ({ note: "plain" }),
      turns: [
        () =>
          patch({
            "explore/deeper.mjs": probe(
              "await page.goto(new URL('/deep', page.url()).href); return page.url();",
            ),
            "src/tool.mjs": `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"ask_note",input:Schema.Unknown,output:Schema.Unknown,questions:{note:{type:"text",prompt:"Which note should I keep?"}}},
async ({ ask }) => ({ note: await ask("note") }));`,
          }),
        () => [call("execute", execution("explore", "explore/deeper.mjs"), "deeper")],
        () => [call("execute", execution("example", "src/tool.mjs"), "example")],
      ],
    });
    expect(toolResult(last, "deeper")).toMatchObject({ status: "completed" });
    expect(toolResult(last, "example")).toMatchObject({ status: "completed" });
    // The example reset the page before it asked, so the explore's page at /deep is gone.
    const question = guardian.reviews.find((review) => review.kind === "question");
    expect(historyOf(question)).toContainEqual(
      expect.objectContaining({ purpose: "example", status: "running" }),
    );
    expect(contextOf(question!)?.["browser"]).toBe("active");
    expect(contextOf(question!)).not.toHaveProperty("currentPage");
  } finally {
    await site.close();
  }
});

test("a read build signed out runs five live tests on inputs it chose and its example on the input it read", async () => {
  test.setTimeout(90_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>Fixture</title><h1>Public fixture</h1>"),
  );
  const guardian = recordingGuardian();
  const chosen = (value: number) =>
    execution("test", "src/tool.mjs", { testInput: `{"page":${value}}` });
  try {
    const { last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      turns: [
        () =>
          patch({
            "src/tool.mjs": headingOperation,
            "src/heading.mjs": "export const heading = (value) => String(value).trim();",
          }),
        () => [call("execute", chosen(1), "test_1")],
        () => [call("execute", chosen(2), "test_2")],
        () => [call("execute", chosen(3), "test_3")],
        () => [call("execute", chosen(4), "test_4")],
        () => [call("execute", chosen(5), "test_5")],
        () => [call("execute", execution("test", "src/tool.mjs", { testInput: "{x" }), "not_json")],
        () => [
          call(
            "execute",
            execution("example", "src/tool.mjs", { testInput: "{}" }),
            "example_test",
          ),
        ],
        () => [
          call(
            "execute",
            execution("example", "src/tool.mjs", { exampleInput: '{"venue":"Venue X"}' }),
            "example",
          ),
        ],
      ],
    });
    expect(toolResult(last, "test_1")).toMatchObject({ status: "completed" });
    expect(toolResult(last, "test_2")).toMatchObject({ status: "completed" });
    expect(toolResult(last, "test_3")).toMatchObject({ status: "completed" });
    expect(toolResult(last, "test_4")).toMatchObject({ status: "completed" });
    // A read signed out has no limit on live tests on inputs it chose.
    expect(toolResult(last, "test_5")).toMatchObject({ status: "completed" });
    for (const [id, reason] of [
      ["not_json", "testInput must be the tool's input as JSON text"],
      ["example_test", "testInput is only for a read's live test"],
    ] as const) {
      expect(toolResult(last, id), id).toMatchObject({ status: "unsupported" });
      expect(JSON.stringify(toolResult(last, id)), id).toContain(reason);
    }
    expect(toolResult(last, "example")).toMatchObject({ status: "completed" });
    const reviewed = executions(guardian.reviews);
    expect(reviewed.map((review) => currentOf(review)?.["input"])).toEqual([
      "agent_chosen",
      "agent_chosen",
      "agent_chosen",
      "agent_chosen",
      "agent_chosen",
      "intent_derived",
    ]);
    const example = reviewed.at(-1);
    expect((example?.input["submitted_call"] as Record<string, unknown>)["input"]).toBe(
      '{"venue":"Venue X"}',
    );
    expect(historyOf(example).map((entry) => entry["input"])).toEqual([
      "agent_chosen",
      "agent_chosen",
      "agent_chosen",
      "agent_chosen",
      "agent_chosen",
    ]);
  } finally {
    await site.close();
  }
});

test("a confirmed update turns a read build into a write build, and later reviews read it", async () => {
  test.setTimeout(90_000);
  const fixture = saveSite();
  const site = await fixture.start();
  const guardian = recordingGuardian();
  try {
    const { last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      // The caller picks the option the minter wrote.
      answer: () => ({ save: "save" }),
      turns: [
        () => patch({ "src/act.mjs": saveStep, "src/look.mjs": probe() }),
        () => [call("execute", execution("explore", "src/look.mjs"), "explore")],
        () => [call("request_input", saveQuestion, "ask")],
        () => [call("mint_update", toWrite(["save"]), "update")],
        () => [call("execute", execution("act", "src/act.mjs", { writePath: writePath("save") }), "act")],
        () => [call("execute", execution("act", "src/look.mjs"), "read_back")],
      ],
    });
    expect(toolResult(last, "update")).toMatchObject({
      status: "updated",
      task: { revision: 1, effect: "write" },
    });
    expect(toolResult(last, "act")).toMatchObject({ status: "completed" });
    expect(fixture.writes()).toBe(1);
    // Guardian reviewed the update with the caller's pick of the minter's option as confirmation.
    const update = guardian.reviews.find((review) => review.kind === "update");
    expect(update?.input["update_review"]).toMatchObject({
      changes: [{ setting: "effect", effect: "write" }],
      confirmation: [{ question: saveQuestion.questions[0]?.prompt, answer: "Yes, save the note" }],
      effect: "read",
    });
    const [explore, act, readBack] = executions(guardian.reviews);
    expect(contextOf(explore!)?.["repeatableRead"]).toBe(true);
    expect(contextOf(act!)?.["repeatableRead"]).toBe(false);
    expect(effectsOf(act)[0]).toMatch(/^The caller's requested task, done once/u);
    // The write is reviewed under the effective task: the intent and the accepted update.
    expect(intentOf(act!)).toBe("Read the fixture heading");
    expect(authorityOf(act!)["taskUpdates"]).toEqual([
      {
        revision: 1,
        summary: "Save the note on the site instead of only reading it.",
        changes: [{ setting: "effect", effect: "write" }],
        confirmation: [
          {
            id: "save",
            question: saveQuestion.questions[0]?.prompt,
            answer: "Yes, save the note",
          },
        ],
      },
    ]);
    expect(authorityOf(explore!)).not.toHaveProperty("taskUpdates");
    // The explore ran under the original request and the write under the update.
    expect(historyOf(readBack).map((entry) => [entry["purpose"], entry["taskRevision"]])).toEqual([
      ["explore", undefined],
      ["act", 1],
    ]);
  } finally {
    await site.close();
  }
});

test("a read build that ran its live example becomes a write and runs the write", async () => {
  test.setTimeout(90_000);
  const fixture = saveSite();
  const site = await fixture.start();
  const guardian = recordingGuardian();
  try {
    const { last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      answer: () => ({ save: "save" }),
      turns: [
        () => patch({ "src/act.mjs": saveStep, "src/look.mjs": probe() }),
        () => [call("execute", execution("example", "src/look.mjs"), "example")],
        () => [call("request_input", saveQuestion, "ask")],
        () => [call("mint_update", toWrite(["save"]), "update")],
        () => [call("execute", execution("act", "src/act.mjs", { writePath: writePath("save") }), "act")],
      ],
    });
    expect(toolResult(last, "example")).toMatchObject({ status: "completed" });
    expect(toolResult(last, "update")).toMatchObject({
      status: "updated",
      task: { revision: 1, effect: "write" },
    });
    // The read example's claim does not block the write session's own.
    expect(toolResult(last, "act")).toMatchObject({ status: "completed" });
    expect(fixture.writes()).toBe(1);
  } finally {
    await site.close();
  }
});

test("a confirmed site change moves the build to the other site", async () => {
  test.setTimeout(90_000);
  const original = await startSite((_request, response) =>
    html(response, "<title>Original</title><h1>Original</h1>"),
  );
  const sister = await startSite((_request, response) =>
    html(response, "<title>Sister</title><h1>Sister</h1>"),
  );
  const guardian = recordingGuardian();
  try {
    const { last } = await mint({
      effect: "read",
      url: original.url,
      guardian,
      answer: () => ({ site: "move" }),
      turns: [
        () => patch({ "src/look.mjs": probe() }),
        () => [call("execute", execution("explore", "src/look.mjs"), "before")],
        () => [
          call(
            "request_input",
            {
              intent: "Ask where the notes live",
              questions: [
                {
                  id: "site",
                  type: "choice",
                  prompt: `Your notes live on ${sister.origin}. Build the tool there?`,
                  options: [
                    { id: "move", label: `Yes, use ${sister.origin}` },
                    { id: "stay", label: "No, stay here" },
                  ],
                },
              ],
            },
            "ask",
          ),
        ],
        () => [
          call(
            "mint_update",
            {
              intent: "Move the build where the caller's notes live",
              summary: `Build the tool on ${sister.origin}, where the caller's notes live.`,
              changes: [{ setting: "site", origin: sister.origin }],
              confirmedBy: ["site"],
              recommend: "update",
            },
            "update",
          ),
        ],
        () => [call("execute", execution("explore", "src/look.mjs"), "explore")],
      ],
    });
    expect(toolResult(last, "update")).toMatchObject({
      status: "updated",
      task: { revision: 1, siteOrigin: sister.origin },
    });
    // The build worked on the original site, then entered the new one, and the review after the
    // change authorizes that site alone.
    expect(JSON.stringify(toolResult(last, "before"))).toContain("Original");
    expect(JSON.stringify(toolResult(last, "explore"))).toContain("Sister");
    const [before, explore] = executions(guardian.reviews);
    expect(authorityOf(before!)["allowedOrigins"]).toEqual([original.origin]);
    expect(authorityOf(explore!)["allowedOrigins"]).toEqual([sister.origin]);
    expect(authorityOf(explore!)["taskUpdates"]).toMatchObject([
      { revision: 1, changes: [{ setting: "site", origin: sister.origin }] },
    ]);
  } finally {
    await original.close();
    await sister.close();
  }
});

test("a write build refuses a repeat of a write no outcome review showed did not happen, and live tests and explores in its session", async () => {
  test.setTimeout(90_000);
  const fixture = saveSite();
  const site = await fixture.start();
  const guardian = recordingGuardian();
  try {
    const { last } = await mint({
      effect: "write",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "src/act.mjs": saveStep, "src/look.mjs": probe() }),
        () => [call("execute", execution("act", "src/act.mjs", { writePath: writePath("save") }), "act_1")],
        () => [call("execute", execution("act", "src/act.mjs"), "act_2")],
        () => [call("execute", execution("test", "src/look.mjs"), "test")],
        () => [call("execute", execution("explore", "src/look.mjs"), "explore")],
        () => [call("execute", execution("act", "src/look.mjs"), "read_back")],
        // A read-back does not license the repeat: only an outcome review that finds the write
        // did not happen does, and this reviewer never assesses.
        () => [call("execute", execution("act", "src/act.mjs"), "act_3")],
      ],
    });
    expect(fixture.writes()).toBe(1);
    for (const id of ["act_1", "read_back"])
      expect(toolResult(last, id), id).toMatchObject({ status: "completed" });
    for (const [id, reason] of [
      ["act_2", "repeats a write"],
      ["test", "never as a live example or a live test"],
      ["explore", "live exploration is over"],
      ["act_3", "repeats a write"],
    ] as const) {
      expect(toolResult(last, id), id).toMatchObject({ status: "unsupported" });
      expect(JSON.stringify(toolResult(last, id)), id).toContain(reason);
    }
    const acts = executions(guardian.reviews);
    expect(acts.map((review) => currentOf(review)?.["purpose"])).toEqual(["act", "act"]);
    expect(effectsOf(acts[0])[0]).toMatch(/^The caller's requested task, done once/u);
  } finally {
    await site.close();
  }
});

// Fails when the repeat guard keys only on the step's path, so a copy of the write under another
// name runs it again, or when Guardian's execution review does not see the earlier write.
test("a write build refuses a copy of a write, and Guardian sees the write before a rewrite of it", async () => {
  test.setTimeout(90_000);
  const fixture = saveSite();
  const site = await fixture.start();
  // Guardian denies a step that would commit an unassessed write's change again.
  const guardian = recordingGuardian({
    decide: (review) =>
      currentOf(review)?.["purpose"] === "act" &&
      Array.isArray(contextOf(review)?.["writes"]) &&
      (contextOf(review)?.["writes"] as readonly unknown[]).length > 0
        ? { outcome: "deny", rationale: "It would save the same change again.", action: "write" }
        : "allow",
  });
  try {
    const { last } = await mint({
      effect: "write",
      url: site.url,
      guardian,
      turns: [
        () =>
          patch({
            "src/act.mjs": saveStep,
            "src/act-copy.mjs": saveStep,
            "src/act-rewritten.mjs": `// The same save, rewritten.\n${saveStep}`,
          }),
        () => [call("execute", execution("act", "src/act.mjs", { writePath: writePath("save") }), "act_1")],
        () => [call("execute", execution("act", "src/act-copy.mjs"), "act_copy")],
        () => [call("execute", execution("act", "src/act-rewritten.mjs"), "act_rewritten")],
      ],
    });
    expect(fixture.writes()).toBe(1);
    expect(toolResult(last, "act_1")).toMatchObject({ status: "completed" });
    // The copy is refused before review; the rewrite reaches Guardian, which sees the write.
    expect(toolResult(last, "act_copy")).toMatchObject({ status: "unsupported" });
    expect(toolResult(last, "act_rewritten")).not.toMatchObject({ status: "completed" });
    const acts = executions(guardian.reviews);
    expect(acts).toHaveLength(2);
    expect(contextOf(acts[0] as RecordedReview)?.["writes"]).toBeUndefined();
    expect(contextOf(acts[1] as RecordedReview)?.["writes"]).toEqual([
      {
        executionId: expect.any(String) as unknown,
        purpose: "act",
        entrypoint: "src/act.mjs",
        outcome: "unassessed",
      },
    ]);
  } finally {
    await site.close();
  }
});

test("a write session runs the input its first act step read from the request, and publishes against it", async () => {
  test.setTimeout(90_000);
  const fixture = noteSite();
  const site = await fixture.start();
  const guardian = recordingGuardian();
  try {
    const { built, last } = await mint({
      effect: "write",
      url: site.url,
      guardian,
      turns: [
        () =>
          patch({ "src/read.mjs": readNote, "src/save.mjs": saveNote, "src/tool.mjs": saveNote }),
        () => [call("execute", act("src/read.mjs", { note: "kept" }, writePath("save")), "read")],
        () => [call("execute", act("src/save.mjs", { note: "other" }), "changed")],
        () => [call("execute", act("src/save.mjs"), "save")],
        (request) => [
          call("finish_build", {
            intent: "Return the composed write without running it",
            entrypoint: "src/tool.mjs",
            executionId: executionIdOf(request, "save"),
            metadata: { name: "save_note", description: "Save the requested note once" },
            coverage: "One confirmed act session on the note the request gave",
          }),
        ],
      ],
    });
    expect(built.build, JSON.stringify(built)).toBe("published");
    expect(built.artifact?.inputSchema).toMatchObject({ required: ["note"] });
    expect(fixture.saved).toEqual(["kept"]);
    expect(toolResult(last, "read")).toMatchObject({ status: "completed" });
    expect(toolResult(last, "changed")).toMatchObject({ status: "unsupported" });
    expect(JSON.stringify(toolResult(last, "changed"))).toContain("Repeat it unchanged or omit it");
    const reviewed = executions(guardian.reviews);
    expect(reviewed.map((review) => currentOf(review)?.["purpose"])).toEqual([
      "act",
      "act",
      "contract",
    ]);
    for (const review of reviewed) {
      expect((review.input["submitted_call"] as Record<string, unknown>)["input"]).toBe(
        '{"note":"kept"}',
      );
    }
    for (const review of reviewed.slice(0, 2)) {
      expect(currentOf(review)?.["input"]).toBe("intent_derived");
      expect(effectsOf(review)[0]).toContain("must be stated by the trusted intent");
    }
  } finally {
    await site.close();
  }
});

test("a write session refuses exampleInput that is not an object, and takes it on a step after one without it", async () => {
  test.setTimeout(90_000);
  const fixture = noteSite();
  const site = await fixture.start();
  const guardian = recordingGuardian();
  try {
    const { last } = await mint({
      effect: "write",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "src/look.mjs": probe(), "src/read.mjs": readNote }),
        () => [call("execute", act("src/look.mjs", "[1]"), "not_object")],
        () => [call("execute", act("src/look.mjs", undefined, writePath("save")), "started")],
        () => [call("execute", act("src/read.mjs", { note: "late" }), "late")],
      ],
    });
    expect(toolResult(last, "started")).toMatchObject({ status: "completed" });
    expect(toolResult(last, "not_object")).toMatchObject({ status: "unsupported" });
    expect(JSON.stringify(toolResult(last, "not_object"))).toContain(
      "exampleInput must be JSON text of the tool's input object",
    );
    // A later step may be the first to pass it: it runs, reviewed as intent_derived.
    expect(toolResult(last, "late")).toMatchObject({ status: "completed" });
    const reviews = executions(guardian.reviews);
    expect(reviews).toHaveLength(2);
    expect(currentOf(reviews[0]!)).not.toHaveProperty("input");
    expect(currentOf(reviews[1]!)?.["input"]).toBe("intent_derived");
  } finally {
    await site.close();
  }
});

test("a write session runs the caller's own input and refuses exampleInput beside it", async () => {
  test.setTimeout(90_000);
  const fixture = noteSite();
  const site = await fixture.start();
  const guardian = recordingGuardian();
  try {
    const { last } = await mint({
      effect: "write",
      url: site.url,
      guardian,
      input: { note: "given" },
      turns: [
        () => patch({ "src/read.mjs": readNote }),
        () => [call("execute", act("src/read.mjs", { note: "other" }), "beside")],
        () => [call("execute", act("src/read.mjs", undefined, writePath("save")), "read")],
      ],
    });
    expect(toolResult(last, "beside")).toMatchObject({ status: "unsupported" });
    expect(JSON.stringify(toolResult(last, "beside"))).toContain(
      "The caller supplied input, and the session runs it as it is.",
    );
    expect(toolResult(last, "read")).toMatchObject({ status: "completed" });
    const [review] = executions(guardian.reviews);
    expect((review?.input["submitted_call"] as Record<string, unknown>)["input"]).toBe(
      '{"note":"given"}',
    );
    expect(effectsOf(review)[0]).toMatch(
      /^The caller's requested task, done once with the caller's values/u,
    );
  } finally {
    await site.close();
  }
});

test("secret handle problems are refused before Guardian reviews the source", async () => {
  test.setTimeout(90_000);
  const site = await startSite((_request, response) =>
    html(response, `<title>Code</title><h1>Code</h1><input id="code">`),
  );
  const guardian = recordingGuardian();
  try {
    const { last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      answer: () => ({ code: "fixture-private-value" }),
      turns: [
        () =>
          patch({
            "explore/leak.mjs": `const handle = "{{secret.s1}}";\nconsole.log(handle);\nexport default {};`,
          }),
        () => [
          call("request_input", {
            intent: "Ask for the private code",
            questions: [
              { id: "code", type: "secret", secretKind: "private_text", prompt: "Which code?" },
            ],
          }),
        ],
        () => [call("execute", execution("explore", "explore/leak.mjs"), "misplaced")],
        // The check reads every authored file, so the unissued handle comes after.
        () =>
          patch({
            "explore/unknown.mjs": probe(
              `await page.locator('#code').fill("{{secret.s9}}"); return 1;`,
            ),
          }),
        () => [call("execute", execution("explore", "explore/unknown.mjs"), "unissued")],
      ],
    });
    expect(executions(guardian.reviews)).toEqual([]);
    expect(toolResult(last, "misplaced")).toMatchObject({ status: "unsupported" });
    expect(JSON.stringify(toolResult(last, "misplaced"))).toContain("explore/leak.mjs line 1: ");
    expect(toolResult(last, "unissued")).toMatchObject({ status: "unsupported" });
    expect(JSON.stringify(toolResult(last, "unissued"))).toContain("{{secret.s9}}");
  } finally {
    await site.close();
  }
});

test("a step Guardian denies never runs", async () => {
  test.setTimeout(90_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>Fixture</title><h1>Public fixture</h1>"),
  );
  const guardian = recordingGuardian({ decide: () => "deny" });
  let before: readonly string[] = [];
  try {
    const { last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "explore/look.mjs": probe() }),
        () => {
          before = [...site.requests];
          return [call("execute", execution("explore", "explore/look.mjs"), "explore")];
        },
      ],
    });
    expect(executions(guardian.reviews)).toHaveLength(1);
    expect(JSON.stringify(toolResult(last, "explore"))).toContain("ReviewDenied");
    // The host loaded the request's page before the build started; the denied step loaded nothing.
    expect(before).toEqual(["GET /"]);
    expect(site.requests).toEqual(before);
  } finally {
    await site.close();
  }
});

test("a command Guardian denies never runs", async () => {
  test.setTimeout(90_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>Fixture</title><h1>Public fixture</h1>"),
  );
  let commands = 0;
  const guardian = recordingGuardian({
    decide: (review) =>
      currentOf(review)?.["purpose"] === "command" && commands++ === 0 ? "deny" : "allow",
  });
  try {
    const { last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      turns: [
        () => [call("exec_command", { cmd: "touch denied-marker" }, "denied")],
        () => [call("exec_command", { cmd: "ls -a" }, "listed")],
      ],
    });
    expect(executions(guardian.reviews)).toHaveLength(2);
    expect(JSON.stringify(toolResult(last, "denied"))).toContain("ReviewDenied");
    expect(toolResult(last, "listed")).toMatchObject({ status: "completed" });
    expect(JSON.stringify(toolResult(last, "listed"))).toContain("AGENTS.md");
    expect(JSON.stringify(toolResult(last, "listed"))).not.toContain("denied-marker");
  } finally {
    await site.close();
  }
});

test("a Guardian outage is retried before the step runs", async () => {
  test.setTimeout(90_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>Fixture</title><h1>Public fixture</h1>"),
  );
  const guardian = recordingGuardian({
    fail: (index) => (index === 0 ? new Error("Synthetic provider outage") : undefined),
  });
  try {
    const { last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "explore/look.mjs": probe() }),
        () => [call("execute", execution("explore", "explore/look.mjs"), "explore")],
      ],
    });
    expect(guardian.calls()).toBeGreaterThan(1);
    expect(toolResult(last, "explore")).toMatchObject({ status: "completed" });
  } finally {
    await site.close();
  }
});

test("a spent Guardian model quota ends the build as a host failure without a retry", async () => {
  test.setTimeout(90_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>Fixture</title><h1>Public fixture</h1>"),
  );
  const guardian = recordingGuardian({
    fail: () => Object.assign(new Error("Synthetic spent quota"), { code: "insufficient_quota" }),
  });
  try {
    const { built } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "explore/look.mjs": probe() }),
        () => [call("execute", execution("explore", "explore/look.mjs"), "explore")],
      ],
    });
    expect(guardian.calls()).toBe(1);
    expect(built).toMatchObject({ build: "incomplete", hostFailure: "model_quota_exhausted" });
  } finally {
    await site.close();
  }
});
