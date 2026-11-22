import { test, expect } from "@playwright/test";
import {
  call,
  execution,
  executionIdOf,
  html,
  patch,
  readOf,
  recordingGuardian,
  startSite,
  toolResult,
  type RecordedReview,
} from "./guardian-context-fixture.js";
import { mint } from "./standalone-mint-fixture.js";

const notesPath = "publication/output-notes.json";
const publications = (reviews: readonly RecordedReview[]) =>
  reviews.filter((review) => review.kind === "publication");
/** The output checks an execute call's screened observations carried, if any. */
const outputChecksOf = (request: Parameters<typeof toolResult>[0], callId: string) => {
  const observations = toolResult(request, callId)?.["observations"];
  const parsed: unknown = typeof observations === "string" ? JSON.parse(observations) : undefined;
  return typeof parsed === "object" && parsed !== null
    ? (Reflect.get(parsed, "outputChecks") as
        | { readonly findings: readonly Readonly<Record<string, unknown>>[] }
        | undefined)
    : undefined;
};
const finish = (
  request: Parameters<typeof executionIdOf>[0],
  callId: string,
  example: string,
  extra: Readonly<Record<string, unknown>> = {},
) => [
  call(
    "finish_build",
    {
      intent: "Return the room's details",
      entrypoint: "src/tool.mjs",
      executionId: executionIdOf(request, example),
      metadata: { name: "read_room", description: "Read the room's name and details" },
      coverage: "One live example",
      ...extra,
    },
    callId,
  ),
];

/**
 * A room page whose details block is rendered once and kept again, hidden, with its own style
 * rules: reading the hidden copy's whole text returns the rules with the words.
 */
const roomSite = () =>
  startSite((_request, response) =>
    html(
      response,
      `<title>Fixture</title><h1>Garden room</h1>
      <div id=details-copy hidden><style>.details{color:#333;font-size:14px}</style>Sleeps two, garden view</div>
      <div id=details>Sleeps two, garden view</div>`,
    ),
  );
const roomTool = (detailsCode: string) => `import { Schema } from "effect";
import { defineOperation, visibleTextCode } from "../runtime/index.js";
export default defineOperation({name:"read_room",input:Schema.Struct({}),output:Schema.Struct({name:Schema.NonEmptyTrimmedString,details:Schema.NonEmptyTrimmedString})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:visibleTextCode+${JSON.stringify(
    `\nreturn [await visibleText(page.locator('h1')), ${detailsCode}];`,
  )},timeout_sec:5});
  if(!response.success) throw new Error(String(response.error));
  const [name, details] = response.result;
  return {name, details};
});`;

test("an example that read style rules into a value is refused at finish_build before review, and the corrected read publishes", async () => {
  test.setTimeout(60_000);
  const site = await roomSite();
  const guardian = recordingGuardian();
  const hiddenRead = roomTool(
    "await page.locator('#details-copy').evaluate((element) => element.textContent)",
  );
  // The same locator matches both copies; visibleText reads the one a person sees.
  const renderedRead = roomTool("await visibleText(page.locator('#details, #details-copy'))");
  try {
    const { built, requests } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "src/tool.mjs": hiddenRead }),
        () => [call("execute", execution("example", "src/tool.mjs"), "first")],
        (request) => finish(request, "finish_first", "first"),
        () => [
          {
            type: "apply_patch_call",
            callId: "read_rendered_details",
            status: "completed",
            operation: {
              type: "update_file",
              path: "src/tool.mjs",
              diff: `@@\n-${hiddenRead.split("\n")[4]}\n+${renderedRead.split("\n")[4]}\n`,
            },
          },
        ],
        () => [call("execute", execution("example", "src/tool.mjs"), "second")],
        (request) => finish(request, "finish_second", "second"),
      ],
    });
    // The run's own answer already names the value and what is wrong with it.
    expect(outputChecksOf(requests[2], "first")?.findings).toContainEqual(
      expect.objectContaining({ path: "details", check: "css", blocking: true }),
    );
    const refused = toolResult(requests[3], "finish_first");
    expect(refused).toMatchObject({
      status: "not_published",
      reason: "output_checks_blocked",
      outputFindings: [{ path: "details", check: "css", count: 1 }],
    });
    expect(String(refused?.["instruction"])).toContain("outputOverrides");
    expect(outputChecksOf(requests[5], "second")).toBeUndefined();
    expect(built.build, JSON.stringify(built)).toBe("published");
    // Only the corrected example reached the publication review, and it had nothing to note.
    expect(publications(guardian.reviews)).toHaveLength(1);
    expect(readOf(publications(guardian.reviews)[0], notesPath)).toBeUndefined();
  } finally {
    await site.close();
  }
});

test("a value that is code on purpose publishes with the minter's override, which the publication review reads", async () => {
  test.setTimeout(60_000);
  const site = await startSite((_request, response) =>
    html(
      response,
      "<title>Fixture</title><h1>Sum a list</h1><pre id=snippet>const total = values.reduce((sum, value) => sum + value, 0);</pre>",
    ),
  );
  const tool = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"read_snippet",input:Schema.Struct({}),output:Schema.Struct({title:Schema.NonEmptyTrimmedString,code:Schema.NonEmptyTrimmedString})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:"return [await page.locator('h1').innerText(), await page.locator('#snippet').innerText()];",timeout_sec:5});
  if(!response.success) throw new Error(String(response.error));
  const [title, code] = response.result;
  return {title, code};
});`;
  const reason = "The page publishes code samples, and the sample's code is what the tool returns";
  const guardian = recordingGuardian();
  try {
    const { built, requests } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "src/tool.mjs": tool }),
        () => [call("execute", execution("example", "src/tool.mjs"), "example")],
        (request) => finish(request, "finish_plain", "example"),
        (request) =>
          finish(request, "finish_override", "example", {
            outputOverrides: [{ path: "code", check: "script", reason }],
          }),
      ],
    });
    expect(toolResult(requests[3], "finish_plain")).toMatchObject({
      reason: "output_checks_blocked",
      outputFindings: [{ path: "code", check: "script" }],
    });
    expect(built.build, JSON.stringify(built)).toBe("published");
    const [review] = publications(guardian.reviews);
    expect(publications(guardian.reviews)).toHaveLength(1);
    expect(JSON.parse(readOf(review, notesPath) ?? "{}")).toMatchObject({
      findings: [{ path: "code", check: "script", blocking: false, override: reason }],
    });
  } finally {
    await site.close();
  }
});

test("text read with its page's 'more' control in it is flagged to the minter and noted for the publication review", async () => {
  test.setTimeout(60_000);
  const site = await startSite((_request, response) =>
    html(
      response,
      "<title>Fixture</title><h1>Lake room</h1><p id=about>A quiet room near the lake, with a reading chair <button>Show more</button></p>",
    ),
  );
  const tool = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"read_room",input:Schema.Struct({}),output:Schema.Struct({name:Schema.NonEmptyTrimmedString,about:Schema.NonEmptyTrimmedString})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:"return [await page.locator('h1').innerText(), await page.locator('#about').innerText()];",timeout_sec:5});
  if(!response.success) throw new Error(String(response.error));
  const [name, about] = response.result;
  return {name, about};
});`;
  const guardian = recordingGuardian();
  try {
    const { built, requests } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "src/tool.mjs": tool }),
        () => [call("execute", execution("example", "src/tool.mjs"), "example")],
        (request) => finish(request, "finish", "example"),
      ],
    });
    expect(outputChecksOf(requests[2], "example")?.findings).toContainEqual(
      expect.objectContaining({ path: "about", check: "collapsed_text", blocking: false }),
    );
    // A flag that does not block reaches the reviewer as a lead, and publication goes on.
    expect(built.build, JSON.stringify(built)).toBe("published");
    const [review] = publications(guardian.reviews);
    expect(JSON.parse(readOf(review, notesPath) ?? "{}")).toMatchObject({
      findings: [{ path: "about", check: "collapsed_text", blocking: false }],
    });
  } finally {
    await site.close();
  }
});

test("page text that only resembles code, beside navigation links, publishes with nothing to note", async () => {
  test.setTimeout(60_000);
  const site = await startSite((_request, response) =>
    html(
      response,
      `<title>Fixture</title>
      <nav><a href="/women">Women</a> <a href="/sale">Sale</a> <button>More</button></nav>
      <h1>Running Shoes for Women</h1>
      <p id=specs>Dimensions (L x W x H): 10 x 5 x 3 in; Weight (lbs): 2.5; Material (outer): nylon; Color (main): black</p>
      <p id=care>size: M; color: navy; fit: slim; care: hand wash</p>
      <p id=returns>Return policy: 30 days (unopened); 15 days (opened); exchanges (any time); see terms (below)</p>`,
    ),
  );
  const tool = `import { Schema } from "effect";
import { defineOperation, visibleTextCode } from "../runtime/index.js";
export default defineOperation({name:"read_shoe",input:Schema.Struct({}),output:Schema.Struct({name:Schema.NonEmptyTrimmedString,specs:Schema.NonEmptyTrimmedString,care:Schema.NonEmptyTrimmedString,returns:Schema.NonEmptyTrimmedString})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:visibleTextCode+"\\nreturn [await visibleText(page.locator('h1')), await visibleText(page.locator('#specs')), await visibleText(page.locator('#care')), await visibleText(page.locator('#returns'))];",timeout_sec:5});
  if(!response.success) throw new Error(String(response.error));
  const [name, specs, care, returns] = response.result;
  return {name, specs, care, returns};
});`;
  const guardian = recordingGuardian();
  try {
    const { built, requests } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "src/tool.mjs": tool }),
        () => [call("execute", execution("example", "src/tool.mjs"), "example")],
        (request) => finish(request, "finish", "example"),
      ],
    });
    expect(outputChecksOf(requests[2], "example")).toBeUndefined();
    expect(built.build, JSON.stringify(built)).toBe("published");
    expect(readOf(publications(guardian.reviews)[0], notesPath)).toBeUndefined();
  } finally {
    await site.close();
  }
});
