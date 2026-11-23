import { test, expect } from "@playwright/test";
import {
  call,
  execution,
  executionIdOf,
  html,
  message,
  patch,
  recordingGuardian,
  scripted,
  startSite,
  toolResult,
} from "./guardian-context-fixture.js";
import { mint } from "./standalone-mint-fixture.js";

/** A site whose search form posts the query and answers with a results page. */
const searchSite = () => {
  const posts: string[] = [];
  return {
    posts,
    start: () =>
      startSite((request, response, body) => {
        if (request.method === "POST") {
          posts.push(body);
          html(response, `<title>Results</title><ul id="results"><li>Synthetic result</li></ul>`);
          return;
        }
        html(
          response,
          `<title>Search</title><form method="post" action="/search"><input name="q"><button>Search</button></form>`,
        );
      }),
  };
};

const searchTool = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"search_fixture",input:Schema.Struct({}),output:Schema.Struct({results:Schema.Array(Schema.String)})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:"await page.fill('input[name=q]', 'synthetic'); await page.click('button'); await page.waitForSelector('#results'); return await page.locator('#results li').allTextContents();",timeout_sec:10});
  if(!response.success) throw new Error(String(response.error));
  return {results:response.result};
});`;

// Fails when the execution review carries no action label, or when a step that posts a form is
// taken for a write: Guardian labels the search a read, so the build publishes as a read with no
// write for the outcome reviewer.
test("a read-only search that posts its query publishes as a read", async () => {
  test.setTimeout(60_000);
  const fixture = searchSite();
  const site = await fixture.start();
  const guardian = recordingGuardian();
  const reviewerRequests: unknown[] = [];
  const reviewer = scripted(() => [message("No assessment yet.")], reviewerRequests as never[]);
  try {
    const { built, last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      reviewer,
      intent: "Search the fixture for the synthetic query",
      turns: [
        () => patch({ "src/tool.mjs": searchTool }),
        () => [call("execute", execution("example", "src/tool.mjs"), "example")],
        (request) => [
          call(
            "finish_build",
            {
              intent: "Return the search integration",
              entrypoint: "src/tool.mjs",
              executionId: executionIdOf(request, "example"),
              metadata: { name: "search_fixture", description: "Search the fixture" },
              coverage: "One live example",
            },
            "finish",
          ),
        ],
      ],
    });
    expect(fixture.posts).toEqual(["q=synthetic"]);
    expect(toolResult(last, "example")).toMatchObject({
      status: "completed",
      review: { outcome: "allow", action: "read" },
    });
    expect(built.build, JSON.stringify(built)).toBe("published");
    expect(built.writes).toBeUndefined();
    expect(reviewerRequests).toEqual([]);
  } finally {
    await site.close();
  }
});
