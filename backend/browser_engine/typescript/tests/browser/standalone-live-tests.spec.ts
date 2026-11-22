import type { IncomingMessage, ServerResponse } from "node:http";
import { test, expect } from "@playwright/test";
import {
  call,
  message,
  currentOf,
  execution,
  executionIdOf,
  html,
  patch,
  publicationOf,
  readOf,
  recordingGuardian,
  startSite,
  toolResult,
} from "./guardian-context-fixture.js";
import { executions, mint } from "./standalone-mint-fixture.js";

// The local host runs a read's live test cases one at a time on its one browser, after one
// Guardian review of the batch: each case starts on a page reset like the example's, keeping the
// browser's site data, so every case runs warm; a failure names the line that threw, and the
// publication review reads the host's record of the cases.

/**
 * A search whose page reports the cookie a previous run left, then sets one; a query of
 * "broken" throws from the tool's own source.
 */
const searchTool = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"search_fixture",input:Schema.Struct({query:Schema.String}),output:Schema.Struct({results:Schema.Array(Schema.String),cookie:Schema.String})},
async ({kernel,sessionId,input}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:"return await page.evaluate(() => { const before = document.cookie; document.cookie = 'seen=1; path=/'; return before; });",timeout_sec:5});
  if(!response.success) throw new Error(String(response.error));
  if(input.query === "broken") throw new Error("The results list never appeared");
  return {results: input.query === "zzqx" ? [] : [input.query + " result"], cookie: String(response.result)};
});`;
const brokenLine = searchTool.split("\n").findIndex((line) => line.includes("never appeared")) + 1;

const cases = {
  cases: [
    { id: "first", purpose: "The example's input again.", input: { query: "lamp" }, expect: "result" },
    { id: "second", purpose: "The example's input from a reset page that kept the site data.", input: { query: "lamp" }, expect: "result" },
    { id: "nothing", purpose: "A query with no results.", input: { query: "zzqx" }, expect: "empty" },
    { id: "broken", purpose: "A query the tool fails on.", input: { query: "broken" }, expect: "result" },
  ],
};

test("runs a read's planned cases on reset pages after one review, and hands publication the record", async () => {
  // Chromium must run the cases: what the reset between them keeps is the page's own cookies. Four cases
  // run one after another, each in its own child process, then an example and a publication
  // review, so this takes about a minute, like the other standalone mint specs plus the cases.
  test.setTimeout(90_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>Search</title><h1>Search</h1>"),
  );
  try {
    const guardian = recordingGuardian();
    const { built, requests } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      intent: "Search the fixture catalog",
      // A batch needs time for its cases before the attempt's own margin.
      timeoutMs: 600_000,
      turns: [
        () => patch({ "src/tool.mjs": searchTool, "test/cases.json": JSON.stringify(cases) }),
        () => [
          call("live_tests", {
            intent: "Run every planned case",
            action: "run",
            entrypoint: "src/tool.mjs",
            cases: null,
            maxWorkers: 3,
          }),
        ],
        () => [
          call(
            "execute",
            execution("example", "src/tool.mjs", { exampleInput: '{"query":"lamp"}' }),
            "example",
          ),
        ],
        (request) => [
          call("finish_build", {
            intent: "Publish the search",
            entrypoint: "src/tool.mjs",
            executionId: executionIdOf(request, "example"),
            metadata: { name: "search_fixture", description: "Search the fixture catalog" },
            coverage: "One live example and the planned cases.",
          }),
        ],
      ],
    });

    const ran = toolResult(requests[2], "live_tests") as {
      readonly status: string;
      readonly lanes: number;
      readonly cases: readonly Readonly<Record<string, unknown>>[];
    };
    expect(ran.status).toBe("ran");
    // The local host has one browser.
    expect(ran.lanes).toBe(1);
    const byId = new Map(ran.cases.map((entry) => [entry["id"], entry]));
    // Each case starts on a reset page that keeps the cookie the previous case set, like the
    // example, and runs warm on the one browser.
    expect(byId.get("first")).toMatchObject({ status: "pass", start: "warm" });
    expect(byId.get("second")).toMatchObject({ status: "pass", start: "warm" });
    expect(String(byId.get("second")?.["excerpt"])).toContain('"cookie":"seen=1"');
    expect(byId.get("nothing")).toMatchObject({ status: "pass", got: "empty" });
    expect(byId.get("broken")).toMatchObject({
      status: "fail",
      frame: `src/tool.mjs:${brokenLine}`,
    });

    // One Guardian review covered the whole batch, with every case's id and input.
    const batch = executions(guardian.reviews).filter(
      (review) => currentOf(review)?.["input"] === "agent_chosen_batch",
    );
    expect(batch).toHaveLength(1);
    const submitted = batch[0]?.input["submitted_call"] as { readonly input: string };
    expect(JSON.parse(submitted.input)).toEqual({
      cases: cases.cases.map((entry) => ({ id: entry.id, input: entry.input })),
    });

    // One failing case of four does not refuse publication by itself: 75% clears the 70% bar,
    // and the review reads the host's record.
    expect(built.build).toBe("published");
    const review = guardian.reviews.find((entry) => entry.kind === "publication");
    expect(publicationOf(review ?? guardian.reviews[0]!)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "publication/tests.json", owner: "host", published: false }),
      ]),
    );
    const record = readOf(review, "publication/tests.json") ?? "";
    expect(record).toContain('"id": "broken"');
    // No case ran cold, which the record shows as a gap.
    expect(record).toContain('"coldPasses": 0');
    expect(record).toContain('"start": "warm"');
  } finally {
    await site.close();
  }
});

/**
 * A site that trusts a browser session: a page shows a challenge until the browser holds its trust
 * cookie, and its data request answers a JSON challenge unless the cookie and the trust token the
 * challenge left in local storage both come with it. Passing the challenge sets both.
 */
const trustSite = () => {
  const challenges = { pages: 0, data: 0 };
  const trusted = (cookie: string | undefined) => cookie?.split("; ").includes("trust=1") === true;
  return {
    challenges,
    handle: (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? "/", "http://site.test");
      if (url.pathname === "/api/search") {
        response.setHeader("Content-Type", "application/json");
        if (!trusted(request.headers.cookie) || request.headers["x-trust"] !== "token-1") {
          challenges.data += 1;
          response.statusCode = 403;
          response.end(JSON.stringify({ challenge: true }));
          return;
        }
        response.end(JSON.stringify({ results: [`${url.searchParams.get("q") ?? ""} result`] }));
        return;
      }
      if (trusted(request.headers.cookie)) {
        html(response, "<title>Search</title><h1>Search</h1>");
        return;
      }
      challenges.pages += 1;
      html(
        response,
        `<title>Checking your browser</title><button id="verify">Continue</button>
<script>document.querySelector("#verify").addEventListener("click", () => {
  document.cookie = "trust=1; path=/";
  localStorage.setItem("trust-token", "token-1");
  location.reload();
});</script>`,
      );
    },
  };
};
/** Passes the site's challenge as a person would: the fixture's stand-in for a solve. */
const passChallenge = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"pass_challenge",input:Schema.Struct({}),output:Schema.Struct({passed:Schema.Boolean})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:"await page.click('#verify'); await page.locator('h1').waitFor({ timeout: 5000 }); return true;",timeout_sec:10});
  if(!response.success) throw new Error(String(response.error));
  return {passed:true};
});`;
/** Searches through the site's data request, which a challenge blocks. */
const trustedSearch = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"trusted_search",input:Schema.Struct({query:Schema.String}),output:Schema.Struct({results:Schema.Array(Schema.String)})},
async ({kernel,sessionId,input}) => {
  const code = "const query = " + JSON.stringify(input.query) + "; return await page.evaluate(async (query) => { const answer = await fetch('/api/search?q=' + encodeURIComponent(query), { headers: { 'x-trust': localStorage.getItem('trust-token') ?? '' } }); return { status: answer.status, body: await answer.json() }; }, query);";
  const response = await kernel.browsers.playwright.execute(sessionId,{code,timeout_sec:10});
  if(!response.success) throw new Error(String(response.error));
  if(response.result.status !== 200) throw new Error("The site challenged the search");
  return {results: response.result.body.results};
});`;

test("a site's trust survives the resets before the example and each live test, which run warm", async () => {
  // Chromium must hold the trust cookie and the local storage token across the resets.
  test.setTimeout(90_000);
  const trust = trustSite();
  const site = await startSite((request, response) => trust.handle(request, response));
  try {
    const guardian = recordingGuardian();
    const trustCases = {
      cases: [
        { id: "example-again", purpose: "The example's input again.", input: { query: "lamp" }, expect: "result" },
        { id: "other", purpose: "Another query.", input: { query: "desk" }, expect: "result" },
      ],
    };
    const { built, requests } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      intent: "Search the fixture catalog",
      timeoutMs: 600_000,
      turns: [
        () =>
          patch({
            "explore/pass.mjs": passChallenge,
            "src/tool.mjs": trustedSearch,
            "test/cases.json": JSON.stringify(trustCases),
          }),
        () => [call("execute", execution("explore", "explore/pass.mjs"), "explore")],
        () => [
          call(
            "execute",
            execution("example", "src/tool.mjs", { exampleInput: '{"query":"lamp"}' }),
            "example",
          ),
        ],
        () => [
          call("live_tests", {
            intent: "Run every planned case",
            action: "run",
            entrypoint: "src/tool.mjs",
            cases: null,
            maxWorkers: 3,
          }),
        ],
        (request) => [
          call("finish_build", {
            intent: "Publish the search",
            entrypoint: "src/tool.mjs",
            executionId: executionIdOf(request, "example"),
            metadata: { name: "trusted_search", description: "Search the fixture catalog" },
            coverage: "One live example and the planned cases.",
          }),
        ],
      ],
    });

    // The exploration met the challenge once, at load, and passed it. Nothing after it was
    // challenged: the example's reset and each case's kept the trust the challenge granted.
    expect(trust.challenges).toEqual({ pages: 1, data: 0 });
    const ran = toolResult(requests[4], "live_tests") as {
      readonly status: string;
      readonly cases: readonly Readonly<Record<string, unknown>>[];
    };
    expect(ran.status).toBe("ran");
    expect(ran.cases).toEqual([
      expect.objectContaining({ id: "example-again", status: "pass", start: "warm" }),
      expect.objectContaining({ id: "other", status: "pass", start: "warm" }),
    ]);
    expect(built.build).toBe("published");
    // The local host has one browser, so no case ran cold: the record shows the gap.
    const review = guardian.reviews.find((entry) => entry.kind === "publication");
    expect(readOf(review, "publication/tests.json")).toContain('"coldPasses": 0');
  } finally {
    await site.close();
  }
});

/** A list tool on the runtime's cursor contract: five rows on one page, read in windows. */
const listTool = `import { Schema } from "effect";
import { defineOperation, finishList, listInputFields, listOutputFields, selectRows, startList } from "../runtime/index.js";
const Row = Schema.Struct({ id: Schema.String });
export default defineOperation({name:"list_fixture",input:Schema.Struct({query:Schema.String,...listInputFields}),output:Schema.Struct({results:Schema.Array(Row),...listOutputFields})},
async ({kernel,sessionId,input}) => {
  const list = startList(input, { mechanism: "offset" });
  const response = await kernel.browsers.playwright.execute(sessionId,{code:"return ['a','b','c','d','e']",timeout_sec:5});
  if(!response.success) throw new Error(String(response.error));
  const keyOf = (row) => row.id;
  const read = response.result.map((id) => ({ id }));
  const selected = selectRows(list, read, keyOf);
  const results = selected.rows.slice(0, list.limit);
  const last = results.at(-1);
  const more = selected.rows.length > results.length;
  const next = more && last !== undefined ? { offset: read.findIndex((row) => row.id === last.id) + 1 } : null;
  return { results, ...finishList(list, { rows: results, keyOf, next, hasMore: more, totalResults: read.length, listChanged: selected.listChanged }) };
});`;

test("runs a list case's page two from the cursor its page one returned, checked and signed by the host", async () => {
  // Chromium runs the case's two pages in their own child processes after one batch review.
  test.setTimeout(60_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>List</title><h1>List</h1>"),
  );
  try {
    const guardian = recordingGuardian();
    const { requests } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      intent: "List the fixture rows",
      timeoutMs: 600_000,
      turns: [
        () =>
          patch({
            "src/tool.mjs": listTool,
            "test/cases.json": JSON.stringify({
              cases: [
                {
                  id: "page-2",
                  purpose: "Page two through the cursor page one returned.",
                  input: { query: "rows", limit: 2 },
                  expect: "result",
                  next_page: true,
                },
              ],
            }),
          }),
        () => [
          call("live_tests", {
            intent: "Run the next-page case",
            action: "run",
            entrypoint: "src/tool.mjs",
            cases: null,
            maxWorkers: 1,
          }),
        ],
      ],
    });
    const ran = toolResult(requests[2], "live_tests") as {
      readonly status: string;
      readonly cases: readonly Readonly<Record<string, unknown>>[];
    };
    expect(ran.status).toBe("ran");
    // Page two continues after page one's last row: without the host's cursor, page one has no
    // next cursor and the case cannot run its next page.
    expect(ran.cases[0]).toMatchObject({ id: "page-2", status: "pass", got: "results (2)" });
    const excerpt = String(ran.cases[0]?.["excerpt"]);
    expect(excerpt).toContain('{"id":"c"},{"id":"d"}');
    expect(excerpt).not.toContain('"id":"a"');
  } finally {
    await site.close();
  }
});

test("refuses a case whose cursor the host never signed before the case touches the site", async () => {
  // Chromium runs the batch's review and the build's first page; the refused case runs nothing.
  test.setTimeout(60_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>List</title><h1>List</h1>"),
  );
  // Well formed, under a key this host does not hold: a hand-made or altered cursor.
  const forged = `pc1.unknownkey.${Buffer.from('{"v":1}').toString("base64url")}.${"A".repeat(43)}`;
  let before = 0;
  let after = 0;
  try {
    const guardian = recordingGuardian();
    const { requests } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      intent: "List the fixture rows",
      timeoutMs: 600_000,
      turns: [
        () =>
          patch({
            "src/tool.mjs": listTool,
            "test/cases.json": JSON.stringify({
              cases: [
                {
                  id: "forged",
                  purpose: "A cursor the host never signed.",
                  input: { query: "rows", cursor: forged },
                  expect: "result",
                },
              ],
            }),
          }),
        () => {
          before = site.requests.length;
          return [
            call("live_tests", {
              intent: "Run the case",
              action: "run",
              entrypoint: "src/tool.mjs",
              cases: null,
              maxWorkers: 1,
            }),
          ];
        },
        () => {
          after = site.requests.length;
          return [message("Done.")];
        },
      ],
    });
    const ran = toolResult(requests[2], "live_tests") as {
      readonly status: string;
      readonly cases: readonly Readonly<Record<string, unknown>>[];
    };
    expect(ran.status).toBe("ran");
    expect(ran.cases[0]).toMatchObject({
      id: "forged",
      status: "fail",
      got: "InvalidInput",
      refusal: { field: "cursor" },
    });
    // Refused before the case's page reset: the site saw no request for it.
    expect(after).toBe(before);
  } finally {
    await site.close();
  }
});

/**
 * A sorted search whose page resets a "rating" sort to its own default, and a store lookup on
 * the deprecated name whose page keeps another store: each refuses loudly rather than return
 * results computed without the caller's value.
 */
const unappliedTool = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"sorted_fixture",input:Schema.Struct({query:Schema.String,sort:Schema.Literal("relevance","rating"),zip:Schema.optional(Schema.String)}),output:Schema.Struct({results:Schema.Array(Schema.String)})},
async ({kernel,sessionId,input,errors}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:"return 'relevance'",timeout_sec:5});
  if(!response.success) throw new Error(String(response.error));
  if(input.zip !== undefined) throw new errors.LocationNotApplied("The page kept its own store", {field:"zip",requested:input.zip,applied:"00002",step:"set_store"});
  if(response.result !== input.sort) throw new errors.InputNotApplied("The page reset the sort to its own default", {field:"sort",requested:input.sort,applied:String(response.result),step:"apply_sort"});
  return {results:[input.query + " result"]};
});`;

test("passes a case that expects an error when the tool refuses an input the page did not apply", async () => {
  // Chromium runs the batch's review and both cases in their own child processes.
  test.setTimeout(60_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>Search</title><h1>Search</h1>"),
  );
  try {
    const guardian = recordingGuardian();
    const { requests } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      intent: "Search the fixture catalog in the caller's sort order",
      timeoutMs: 600_000,
      turns: [
        () =>
          patch({
            "src/tool.mjs": unappliedTool,
            "test/cases.json": JSON.stringify({
              cases: [
                {
                  id: "sort-reset",
                  purpose: "A sort the page resets to its default.",
                  input: { query: "lamp", sort: "rating" },
                  expect: "error",
                },
                {
                  id: "store-kept",
                  purpose: "A store the page does not switch to.",
                  input: { query: "lamp", sort: "relevance", zip: "00001" },
                  expect: "error",
                },
              ],
            }),
          }),
        () => [
          call("live_tests", {
            intent: "Run the refusal cases",
            action: "run",
            entrypoint: "src/tool.mjs",
            cases: null,
            maxWorkers: 1,
          }),
        ],
      ],
    });
    const ran = toolResult(requests[2], "live_tests") as {
      readonly status: string;
      readonly cases: readonly Readonly<Record<string, unknown>>[];
    };
    expect(ran.status).toBe("ran");
    const byId = new Map(ran.cases.map((entry) => [entry["id"], entry]));
    expect(byId.get("sort-reset")).toMatchObject({ status: "pass", got: "InputNotApplied" });
    // The deprecated name is the same refusal.
    expect(byId.get("store-kept")).toMatchObject({ status: "pass", got: "InputNotApplied" });
  } finally {
    await site.close();
  }
});
