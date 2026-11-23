import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test, expect } from "@playwright/test";
import {
  call,
  execution,
  executionIdOf,
  html,
  patch,
  publicationOf,
  readOf,
  recordingGuardian,
  startSite,
  toolResult,
  type RecordedReview,
} from "./guardian-context-fixture.js";
import { act, mint, noteSite, readNote, saveNote } from "./standalone-mint-fixture.js";

/** The note site's write path: its one save, as a write build's first act step declares it. */
const savePath = {
  steps: [{ commit: "save", does: "Saves the note" }],
  ends: "The site's confirmation of the save",
};

const definitionPath = "publication/definition.json";
const publications = (reviews: readonly RecordedReview[]) =>
  reviews.filter((review) => review.kind === "publication");
const observationsOf = (review: RecordedReview | undefined) =>
  String(review?.input["untrusted_observations"]);
const byteRange = (text: string, value: string) => {
  const start = Buffer.byteLength(text.slice(0, text.indexOf(value)));
  return { byteStart: start, byteEnd: start + Buffer.byteLength(value) };
};
const headingSite = () =>
  startSite((_request, response) =>
    html(response, "<title>Fixture</title><h1>Public fixture</h1>"),
  );
const finish = (request: Parameters<typeof executionIdOf>[0], callId: string, example: string) => [
  call(
    "finish_build",
    {
      intent: "Return the fixture integration",
      entrypoint: "src/tool.mjs",
      executionId: executionIdOf(request, example),
      metadata: { name: "read_fixture", description: "Read the fixture heading" },
      coverage: "One live example",
    },
    callId,
  ),
];

/** A read of the fixture's heading that takes no input and declares no questions. */
const headingTool = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"read_fixture",input:Schema.Struct({}),output:Schema.Struct({heading:Schema.String})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:"return await page.locator('h1').textContent();",timeout_sec:5});
  if(!response.success) throw new Error(String(response.error));
  return {heading:String(response.result).trim()};
});`;

/** A read whose input `account` is fixed to one account's value. */
const accountTool = (account: string) => `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"read_fixture",input:Schema.Struct({account:${account}}),output:Schema.Struct({heading:Schema.String})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:"return await page.locator('h1').textContent();",timeout_sec:5});
  if(!response.success) throw new Error(String(response.error));
  return {heading:String(response.result).trim()};
});`;

test("a publication review that finds personal data in the source stops the build with its findings", async () => {
  test.setTimeout(60_000);
  const site = await headingSite();
  const tool = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
const contact = "jane.roe@example.com";
export default defineOperation({name:"read_fixture",input:Schema.Struct({}),output:Schema.Struct({heading:Schema.String,contact:Schema.String})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:"return await page.locator('h1').textContent();",timeout_sec:5});
  if(!response.success) throw new Error(String(response.error));
  return {heading:String(response.result).trim(),contact};
});`;
  const finding = {
    path: "operation/src/tool.mjs",
    ...byteRange(tool, "jane.roe@example.com"),
    category: "customer_data",
    explanation: "The source hard-codes one person's email address; take it from the input.",
  };
  const guardian = recordingGuardian({
    decide: (review) =>
      review.kind === "publication"
        ? {
            outcome: "deny",
            reason: "privacy",
            rationale: "The source hard-codes one person's email address.",
            findings: [finding],
          }
        : "allow",
  });
  try {
    const { built, last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "src/tool.mjs": tool }),
        () => [call("execute", execution("example", "src/tool.mjs"), "example")],
        (request) => finish(request, "finish", "example"),
      ],
    });
    expect(built.build, JSON.stringify(built)).not.toBe("published");
    expect(built.artifact).toBeUndefined();
    expect(publications(guardian.reviews)).toHaveLength(1);
    expect(toolResult(last, "finish")).toMatchObject({
      status: "not_published",
      code: "ReviewDenied",
      review: {
        outcome: "deny",
        reason: "privacy",
        rationale: "The source hard-codes one person's email address.",
        findings: [finding],
      },
    });
  } finally {
    await site.close();
  }
});

// A blocking denial tells the minter what each finding is, where it is in its own workspace and
// what fixes it, so one revision fixes them all without running the example again.
test("a publication denial explains each finding at its workspace path, and the fixed source publishes", async () => {
  test.setTimeout(60_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>Fixture</title><h1>Public fixture</h1><p id=stock>In stock</p>"),
  );
  const stockTool = (stock: string) => `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"read_fixture",input:Schema.Struct({}),output:Schema.Struct({heading:Schema.String,stock:Schema.NullOr(Schema.String)})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:"return [await page.locator('h1').textContent(), await page.locator('#stock').textContent()];",timeout_sec:5});
  if(!response.success) throw new Error(String(response.error));
  return {heading:String(response.result[0]).trim(),stock:${stock}};
});`;
  const constant = stockTool("null");
  const explanation =
    "The stock output is always null, but the example page's #stock element shows In stock. Read it from that element.";
  const guardian = recordingGuardian({
    decide: (review) => {
      if (review.kind !== "publication") return "allow";
      const source = readOf(review, "operation/src/tool.mjs") ?? "";
      return source.includes("stock:null")
        ? {
            outcome: "deny",
            reason: "source_correction",
            rationale: "One output is a constant where the page shows the value.",
            findings: [
              {
                path: "operation/src/tool.mjs",
                ...byteRange(source, "stock:null"),
                category: "schema_mismatch",
                explanation,
              },
            ],
          }
        : { outcome: "allow", reason: "approved", rationale: "Every output is read." };
    },
  });
  try {
    const { built, last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "src/tool.mjs": constant }),
        () => [call("execute", execution("example", "src/tool.mjs"), "example")],
        (request) => finish(request, "finish_1", "example"),
        () => [
          {
            type: "apply_patch_call",
            callId: "read_stock",
            status: "completed",
            operation: {
              type: "update_file",
              path: "src/tool.mjs",
              diff: `@@\n-${constant.split("\n").at(-2)}\n+${stockTool("String(response.result[1]).trim()").split("\n").at(-2)}\n`,
            },
          },
        ],
        (request) => finish(request, "finish_2", "example"),
      ],
    });
    const denial = toolResult(last, "finish_1");
    expect(denial).toMatchObject({
      status: "not_published",
      code: "ReviewDenied",
      review: {
        reason: "source_correction",
        findings: [
          {
            path: "operation/src/tool.mjs",
            file: "src/tool.mjs",
            category: "schema_mismatch",
            explanation,
          },
        ],
      },
    });
    expect(String(denial?.["instruction"])).toContain(
      "Fix every finding and each missing item the rationale names, then call finish_build again with the same executionId.",
    );
    expect(built.build, JSON.stringify(built)).toBe("published");
    expect(publications(guardian.reviews)).toHaveLength(2);
  } finally {
    await site.close();
  }
});

test("finish_build refuses a saved file of any extension that holds a secret handle", async () => {
  test.setTimeout(60_000);
  const site = await headingSite();
  const guardian = recordingGuardian();
  try {
    const { built, last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      turns: [
        () =>
          patch({
            "src/tool.mjs": headingTool,
            "src/query.graphql": 'query { account(code: "{{secret.s1}}") { name } }',
          }),
        () => [call("execute", execution("example", "src/tool.mjs"), "example")],
        (request) => finish(request, "finish", "example"),
      ],
    });
    expect(built.build, JSON.stringify(built)).not.toBe("published");
    expect(built.artifact).toBeUndefined();
    expect(toolResult(last, "finish")).toMatchObject({
      status: "not_published",
      code: "PublicationUnavailable",
      reason: "secret_handle",
    });
    expect(publications(guardian.reviews)).toHaveLength(0);
  } finally {
    await site.close();
  }
});

// Code beside a fillCard that could read a typed card back never publishes, though nothing ran it.
test("finish_build refuses source that fills a card and could read it back", async () => {
  test.setTimeout(60_000);
  const site = await headingSite();
  const guardian = recordingGuardian();
  try {
    const { built, last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "src/tool.mjs": headingTool }),
        () => [call("execute", execution("example", "src/tool.mjs"), "example")],
        // After the example: an export nothing runs fills a card and reads the page's markup.
        () => [
          {
            type: "apply_patch_call",
            callId: "patch_pay",
            status: "completed",
            operation: {
              type: "update_file",
              path: "src/tool.mjs",
              diff: `@@\n-});\n+});\n+export const pay = async ({ fillCard }, page) => {\n+  await fillCard({ fields: [{ selector: "#number", handle: "{{card.c1}}" }] });\n+  return page.content();\n+};\n`,
            },
          },
        ],
        (request) => finish(request, "finish", "example"),
      ],
    });
    expect(built.build, JSON.stringify(built)).not.toBe("published");
    const refused = toolResult(last, "finish");
    expect(refused).toMatchObject({
      status: "not_published",
      code: "PublicationUnavailable",
      reason: "card_readback",
    });
    expect(JSON.stringify(refused)).toContain(
      "Not published: the source fills a card and could read it back. Rule: a card stays with the host",
    );
    expect(publications(guardian.reviews)).toHaveLength(0);
  } finally {
    await site.close();
  }
});

// A tool saved with no questions recorded is one saved before builds recorded them, which a run
// reads from its source. A new tool that declares none records an empty set instead.
test("a published read that declares no questions records an empty question set", async () => {
  const site = await headingSite();
  try {
    const { built } = await mint({
      effect: "read",
      url: site.url,
      guardian: recordingGuardian(),
      turns: [
        () => patch({ "src/tool.mjs": headingTool }),
        () => [call("execute", execution("example", "src/tool.mjs"), "example")],
        (request) => finish(request, "finish", "example"),
      ],
    });
    expect(built.build, JSON.stringify(built)).toBe("published");
    expect(built.artifact?.questions).toEqual({});
  } finally {
    await site.close();
  }
});

test("a read's publication review gets a digest of each list in its output and lists its references", async () => {
  const site = await startSite((_request, response) =>
    html(
      response,
      "<title>Fixture</title><ul><li>Garden room</li><li>Harbour room</li><li>Attic room</li></ul>",
    ),
  );
  const guardian = recordingGuardian();
  try {
    const { built } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      turns: [
        () =>
          patch({
            "src/tool.mjs": `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"read_rooms",input:Schema.Struct({}),output:Schema.Struct({rooms:Schema.Array(Schema.Struct({name:Schema.String}))})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:"return await page.locator('li').allTextContents();",timeout_sec:5});
  if(!response.success) throw new Error(String(response.error));
  return {rooms:response.result.map((name) => ({name}))};
});`,
          }),
        () => [call("execute", execution("example", "src/tool.mjs"), "example")],
        (request) => finish(request, "finish", "example"),
      ],
    });
    expect(built.build, JSON.stringify(built)).toBe("published");
    const [review] = publications(guardian.reviews);
    expect(JSON.parse(readOf(review, "publication/example-output.json") ?? "{}")).toMatchObject({
      state: "available",
      output: { rooms: [{ name: "Garden room" }, { name: "Harbour room" }, { name: "Attic room" }] },
    });
    expect(JSON.parse(readOf(review, "publication/output-digest.json") ?? "{}")).toMatchObject({
      lists: [{ path: "rooms", records: 3, fields: { name: { withValue: 3, distinct: 3 } } }],
    });
    expect(observationsOf(review)).toContain(
      "publication/output-digest.json summarizes every field of each list in the example output across all its records, including records past what publication/example-output.json keeps.",
    );
    const references = (
      review?.input["trusted_publication"] as
        | { readonly references?: readonly { readonly path: string }[] }
        | undefined
    )?.references;
    expect(references?.length).toBeGreaterThan(0);
    expect(references?.every(({ path }) => path.startsWith(".agents/"))).toBe(true);
    expect(publicationOf(review!)?.some((file) => String(file["path"]).startsWith(".agents/"))).toBe(
      false,
    );
  } finally {
    await site.close();
  }
});

test("an account-specific enum Guardian returns as input feedback is fixed and published", async () => {
  test.setTimeout(60_000);
  const site = await headingSite();
  const guardian = recordingGuardian({
    decide: (review) => {
      if (review.kind !== "publication") return "allow";
      const definition = readOf(review, definitionPath) ?? "";
      return definition.includes("acct-4417")
        ? {
            outcome: "escalate",
            reason: "input_feedback",
            rationale: "The account input lists this account's own number as its only value.",
            findings: [
              {
                path: definitionPath,
                ...byteRange(definition, "acct-4417"),
                category: "account_specific_enum",
                explanation: "The account input lists one account's number; make it free-form.",
              },
            ],
          }
        : { outcome: "allow", reason: "approved", rationale: "Nothing private ships." };
    },
  });
  try {
    const { built, last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      input: { account: "acct-4417" },
      turns: [
        () => patch({ "src/tool.mjs": accountTool('Schema.Literal("acct-4417")') }),
        () => [call("execute", execution("example", "src/tool.mjs"), "example")],
        (request) => finish(request, "finish_1", "example"),
        () => [
          {
            type: "apply_patch_call",
            callId: "free_form",
            status: "completed",
            operation: {
              type: "update_file",
              path: "src/tool.mjs",
              diff: `@@\n-${accountTool('Schema.Literal("acct-4417")').split("\n")[2]}\n+${accountTool("Schema.String").split("\n")[2]}\n`,
            },
          },
        ],
        (request) => finish(request, "finish_2", "example"),
      ],
    });
    expect(built.build, JSON.stringify(built)).toBe("published");
    expect(built.artifact?.inputSchema).toMatchObject({
      properties: { account: { type: "string" } },
    });
    expect(JSON.stringify(built.artifact?.inputSchema)).not.toContain("acct-4417");
    // The first review's input feedback goes back to the minter with the rounds it has left and
    // what happens after them on a host with no fallback.
    const feedback = toolResult(last, "finish_1");
    expect(feedback).toMatchObject({
      status: "not_published",
      reason: "input_feedback",
      feedbackRoundsRemaining: 1,
      findings: [{ path: definitionPath, category: "account_specific_enum" }],
    });
    expect(String(feedback?.["instruction"])).toContain(
      "the build ends unpublished and reports Guardian's findings to the owner",
    );
    const [first, second] = publications(guardian.reviews);
    expect(publications(guardian.reviews)).toHaveLength(2);
    // Each review reads the example's actual output as JSON, bound to the source that ran.
    expect(JSON.parse(readOf(first, "publication/example-output.json") ?? "{}")).toMatchObject({
      kind: "verified_example_output",
      executedEntrypoint: "executed/src/tool.mjs",
      state: "available",
      output: { heading: "Public fixture" },
    });
    expect(readOf(second, definitionPath)).not.toContain("acct-4417");
    expect(observationsOf(second)).toContain("The source changed after the example ran");
  } finally {
    await site.close();
  }
});

// An input the caller's request supplies is never silently dropped: the example ignores a key its
// schema lacks, so the host names it after Guardian allows, and the tool that takes it publishes.
test("an input the caller's request names that the schema drops comes back as input feedback", async () => {
  test.setTimeout(60_000);
  const site = await headingSite();
  const guardian = recordingGuardian({ decide: () => "allow" });
  const notesTool = headingTool.replace(
    "input:Schema.Struct({})",
    "input:Schema.Struct({notes:Schema.optional(Schema.String)})",
  );
  try {
    const { built, last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      input: { notes: "Window seat" },
      turns: [
        () => patch({ "src/tool.mjs": headingTool }),
        () => [call("execute", execution("example", "src/tool.mjs"), "example")],
        (request) => finish(request, "finish_1", "example"),
        () => [
          {
            type: "apply_patch_call",
            callId: "take_notes",
            status: "completed",
            operation: {
              type: "update_file",
              path: "src/tool.mjs",
              diff: `@@\n-${headingTool.split("\n")[2]}\n+${notesTool.split("\n")[2]}\n`,
            },
          },
        ],
        (request) => finish(request, "finish_2", "example"),
      ],
    });
    expect(built.build, JSON.stringify(built)).toBe("published");
    expect(built.artifact?.inputSchema).toMatchObject({ properties: { notes: { type: "string" } } });
    const feedback = toolResult(last, "finish_1");
    expect(feedback).toMatchObject({
      status: "not_published",
      reason: "input_feedback",
      findings: [{ path: definitionPath, category: "example_input" }],
    });
    expect(JSON.stringify(feedback)).toContain('\\"notes\\"');
    expect(publications(guardian.reviews)).toHaveLength(2);
  } finally {
    await site.close();
  }
});

// A runtime override starts the actual compiled terminal CLI with recorded providers: the minter
// submits the build three times, changing it each time, and Guardian returns input feedback on
// each.
const cliRuntime = async (directory: string) => {
  const file = join(directory, "recorded-cli.mjs");
  const ledger = join(directory, "ledger.txt");
  const runtime = pathToFileURL(resolve("dist/typescript/src/standalone/cli.js")).href;
  await writeFile(
    file,
    `import { startCli } from ${JSON.stringify(runtime)};
import { Usage } from ${JSON.stringify(import.meta.resolve("@openai/agents"))};
import { appendFileSync } from 'node:fs';

const ledger=${JSON.stringify(ledger)};
const tool=${JSON.stringify(accountTool('Schema.Literal("acct-4417")'))};
const objects=(value)=>{if(typeof value==='string'){try{return objects(JSON.parse(value));}catch{return [];}}if(Array.isArray(value))return value.flatMap(objects);if(value===null||typeof value!=='object')return [];return [value,...Object.values(value).flatMap(objects)];};
const response=(output)=>({usage:new Usage(),output});
const message=(value)=>({type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:typeof value==='string'?value:JSON.stringify(value)}]});
const call=(name,input,callId)=>({type:'function_call',name,callId,status:'completed',arguments:JSON.stringify(input)});
const resultOf=(request,callId)=>objects(objects(request.input).find(item=>item.type==='function_call_result'&&item.callId===callId)?.output).find(item=>typeof item.status==='string'||typeof item.executionId==='string');
let turn=0;
const minterProvider={getModel:()=>({getResponse:async(request)=>{
const index=turn++;
if(index===0)return response([{type:'apply_patch_call',callId:'patch',status:'completed',operation:{type:'create_file',path:'src/tool.mjs',diff:tool.split('\\n').map(line=>'+'+line).join('\\n')+'\\n'}}]);
if(index===1)return response([call('execute',{purpose:'example',target:'liveBrowser',entrypoint:'src/tool.mjs',fixtureRefs:[],caseFilter:[],maxWorkers:1,timeoutSeconds:10,intent:'Run the example'},'example')]);
if(index<=4){if(index>2)appendFileSync(ledger,'finish '+JSON.stringify(resultOf(request,'finish_'+(index-1)))+'\\n');return response([call('finish_build',{intent:'Return the fixture integration',entrypoint:'src/tool.mjs',executionId:resultOf(request,'example').executionId,metadata:{name:'read_fixture',description:'Read the fixture heading, revision '+index},coverage:'One live example'},'finish_'+index)]);}
return response([message('Done.')]);
},getStreamedResponse:()=>{throw new Error('Unused stream');}})};
const action=(current)=>{if(current?.trusted_review?.kind!=='execution')return {};const purpose=current.trusted_execution_context?.currentExecution?.purpose;return {action:purpose==='act'?'write':purpose==='authenticate'?'authentication':'read'};};
const outcomeReviewerProvider={getModel:()=>({getResponse:async()=>response([message('No assessment yet.')]),getStreamedResponse:()=>{throw new Error('Unused stream');}})};
const guardianProvider={getModel:()=>({getResponse:async(request)=>{
const items=typeof request.input==='string'?[request.input]:request.input;
const start=items.findLastIndex(item=>objects(item).some(value=>'submitted_call' in value));
const current=objects(items[start]).find(value=>'submitted_call' in value);
if('trusted_publication' in current){appendFileSync(ledger,'publication\\n');return response([message({outcome:'escalate',reason:'input_feedback',rationale:'The account input lists one account number as its only value.',findings:[{path:'publication/definition.json',byteStart:0,byteEnd:1,category:'account_specific_enum',explanation:'Make the account input free-form.'}]})]);}
if(objects(items.slice(start+1)).some(value=>value.type==='function_call_result'))return response([message({outcome:'allow',rationale:'Fixture review',...action(current)})]);
return response([call('read_source',{path:current.submitted_call.entrypoint,offset:0},'read')]);
},getStreamedResponse:()=>{throw new Error('Unused stream');}})};
startCli(process.argv.slice(2),{policy:'Synthetic fixture policy {{ tenant_policy_config }}',minterProvider,guardianProvider,outcomeReviewerProvider});
`,
  );
  return { file, ledger };
};

test("input feedback that outlasts its two rounds ends the CLI build unpublished with exit 1", async () => {
  test.setTimeout(90_000);
  const site = await headingSite();
  const directory = await mkdtemp(join(tmpdir(), "opengpt-cli-publication-"));
  const out = join(directory, "out");
  try {
    const { file, ledger } = await cliRuntime(directory);
    const child = spawn(
      process.execPath,
      [
        file,
        "mint",
        "--url",
        site.url,
        "--intent",
        "Read the fixture heading",
        "--input",
        JSON.stringify({ account: "acct-4417" }),
        "--effect",
        "read",
        "--out",
        out,
      ],
      { env: { PATH: process.env["PATH"] ?? "" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const [code] = (await once(child, "close")) as [number | null];
    expect(code, stderr).toBe(1);
    expect(stderr).toContain(
      "Not built: Guardian's input feedback on this tool's schema was not resolved (account_specific_enum). Guardian's rationale: The account input lists one account number as its only value.",
    );
    const lines = (await readFile(ledger, "utf8")).trim().split("\n");
    expect(lines.filter((line) => line === "publication")).toHaveLength(3);
    const results = lines
      .filter((line) => line.startsWith("finish "))
      .map((line) => JSON.parse(line.slice("finish ".length)) as Record<string, unknown>);
    // The first two reviews leave rounds to fix the feedback; the third ends the build at once.
    expect(results.map((result) => [result["reason"], result["feedbackRoundsRemaining"]])).toEqual([
      ["input_feedback", 1],
      ["input_feedback", 0],
    ]);
    expect(await readdir(out)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await site.close();
  }
});

test("a write's publication review reads each act step under publication/session/", async () => {
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
        () => [call("execute", act("src/read.mjs", { note: "kept" }, savePath), "read")],
        () => [call("execute", act("src/save.mjs"), "save")],
        (request) => [
          call("finish_build", {
            intent: "Return the composed write without running it",
            entrypoint: "src/tool.mjs",
            executionId: executionIdOf(request, "save"),
            metadata: { name: "save_note", description: "Save the requested note once" },
            coverage: "One confirmed act session",
          }),
        ],
      ],
    });
    expect(built.build, JSON.stringify(built)).toBe("published");
    expect(fixture.saved).toEqual(["kept"]);
    const [review] = publications(guardian.reviews);
    expect(publications(guardian.reviews)).toHaveLength(1);
    const index = (publicationOf(review!) ?? []).map((file) => [
      file["path"],
      file["published"],
      file["current"],
      file["owner"],
    ]);
    // Every src/ file ships, in the bundle's order; then the host's files, the definition first.
    expect(index.slice(0, 3).sort()).toEqual(
      ["read", "save", "tool"].map((name) => [`operation/src/${name}.mjs`, true, true, "minter"]),
    );
    expect(index.slice(3)).toEqual([
      [definitionPath, true, true, "host"],
      ["publication/session-output.json", false, true, "host"],
      ["publication/session/0/src/read.mjs", false, false, "host"],
      ["publication/session/1/src/save.mjs", false, false, "host"],
    ]);
    expect(readOf(review, "publication/session/1/src/save.mjs")).toBe(saveNote);
    expect(JSON.parse(readOf(review, "publication/session-output.json") ?? "{}")).toEqual({
      kind: "write_session_output",
      executionId: executionIdOf(last, "save"),
      executedEntrypoint: "publication/session/1/src/save.mjs",
      state: "available",
      screenedBytes: Buffer.byteLength(JSON.stringify({ saved: true })),
      output: { saved: true },
    });
    expect(observationsOf(review)).toContain("This is a write build.");
    expect(observationsOf(review)).toContain("the agent's exampleInput");
  } finally {
    await site.close();
  }
});
