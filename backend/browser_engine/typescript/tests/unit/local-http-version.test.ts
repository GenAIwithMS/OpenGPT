import { Effect } from "effect";
import { expect, it } from "vitest";
import { runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import { HttpFailure } from "../../src/runtime/site-http.js";
import type { HttpTransport, SiteHttpRequest } from "../../src/runtime/site-http.js";

// Authored tools import the SDK by its package path, `opengpt-browser-engine/runtime`, like a standard library.
// The local host stages that path for them and nothing else of the package.

const run = (options: {
  readonly entrypoint: string;
  readonly source: string;
  readonly input?: unknown;
  readonly http?: HttpTransport;
}) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* createLocalWorkspace();
        return yield* runLocalOperation({
          workspace,
          entrypoint: options.entrypoint,
          sources: [[options.entrypoint, options.source]],
          input: options.input ?? {},
          siteOrigin: "https://shop.example",
          ...(options.http === undefined ? { target: "pureFiles" as const } : { http: options.http }),
        }).pipe(Effect.either);
      }),
    ),
  );

/** A site that answers every request with one JSON body, recording what it was sent. */
const jsonSite = (body: unknown) => {
  const sent: SiteHttpRequest[] = [];
  const transport: HttpTransport = {
    name: "kernel-curl",
    capabilities: ["session-cookies"],
    send: (request) => {
      sent.push(request);
      return Promise.resolve({
        status: 200,
        headers: { "content-type": ["application/json"] },
        body: new TextEncoder().encode(JSON.stringify(body)),
        transport: "kernel-curl",
        gaps: [],
      });
    },
  };
  return { transport, sent };
};

const httpVersion = `import { Effect, Schema } from "effect";
import { defineHttpOperation, readJson } from "opengpt-browser-engine/runtime";
const Found = Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) });
export default defineHttpOperation({
  name: "find_products",
  input: Schema.Struct({ query: Schema.String }),
  output: Schema.Struct({ names: Schema.Array(Schema.String) }),
  run: (input, http) =>
    Effect.gen(function* () {
      const url = "/api/search?q=" + encodeURIComponent(input.query);
      const found = yield* readJson(http, { url, method: "GET" }, Found);
      return { names: found.items.map((item) => item.name) };
    }),
});`;

it("runs an HTTP version that imports the SDK by its package path", async () => {
  const site = jsonSite({ items: [{ name: "Brass lamp" }, { name: "Paper lamp" }] });
  const result = await run({
    entrypoint: "src/tool-http.mjs",
    source: httpVersion,
    input: { query: "lamp" },
    http: site.transport,
  });
  expect(result).toMatchObject({
    _tag: "Right",
    right: { output: { names: ["Brass lamp", "Paper lamp"] }, effect: "possible" },
  });
  // A site-relative URL resolves against the job's site.
  expect(site.sent.map((request) => request.url)).toEqual([
    "https://shop.example/api/search?q=lamp",
  ]);
}, 30_000);

it("fails an HTTP version with the failure its host's transport reported", async () => {
  const transport: HttpTransport = {
    name: "saved-http",
    capabilities: [],
    send: () => Promise.reject(new HttpFailure({ code: "not_recorded", dispatch: "not_sent" })),
  };
  const result = await run({
    entrypoint: "src/tool-http.mjs",
    source: httpVersion,
    input: { query: "lamp" },
    http: transport,
  });
  expect(result).toMatchObject({ _tag: "Left", left: { tag: "HttpFailure", code: "not_recorded" } });
}, 30_000);

it("refuses an HTTP version when the host gives it no transport, before anything is sent", async () => {
  const result = await run({ entrypoint: "src/tool-http.mjs", source: httpVersion });
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      message: expect.stringContaining("no HTTP transport"),
      journal: { effect: "not_sent" },
    },
  });
}, 30_000);

it("gives the package path and the workspace path the same SDK modules", async () => {
  const result = await run({
    entrypoint: "src/tool.mjs",
    source: `import { Schema } from "effect";
import * as packaged from "opengpt-browser-engine/runtime";
import * as workspace from "../../runtime/index.js";
export default packaged.defineOperation(
  { input: Schema.Struct({}), output: Schema.Struct({ same: Schema.Boolean }) },
  async () => ({
    same:
      packaged.OperationFailure === workspace.OperationFailure &&
      packaged.SiteHttp === workspace.SiteHttp,
  }),
);`,
  });
  expect(result).toMatchObject({ _tag: "Right", right: { output: { same: true } } });
}, 30_000);

it("refuses a Kernel script in an HTTP version's file before it runs", async () => {
  const site = jsonSite({});
  const result = await run({
    entrypoint: "src/tool-http.mjs",
    source: `import { Schema } from "effect";
import { defineOperation } from "opengpt-browser-engine/runtime";
export default defineOperation({ input: Schema.Struct({}), output: Schema.Struct({}) }, async () => ({}));`,
    http: site.transport,
  });
  expect(result).toMatchObject({
    _tag: "Left",
    left: { message: expect.stringContaining("defineHttpOperation") },
  });
  expect(site.sent).toHaveLength(0);
}, 30_000);

it("refuses an import of the package's internal modules", async () => {
  const result = await run({
    entrypoint: "src/tool.mjs",
    source: `import { Schema } from "effect";
import { defineOperation } from "opengpt-browser-engine/core/runtime/operation";
export default defineOperation({ input: Schema.Struct({}), output: Schema.Struct({}) }, async () => ({}));`,
  });
  expect(result).toMatchObject({
    _tag: "Left",
    left: { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" },
  });
}, 30_000);

/** A site that answers every request with one HTML page of `bytes` bytes. */
const pageSite = (bytes: number) => {
  const sent: SiteHttpRequest[] = [];
  const page = `<html><title>Lamps</title><body>${"x".repeat(Math.max(0, bytes - 45))}</body></html>`;
  const transport: HttpTransport = {
    name: "kernel-curl",
    capabilities: ["session-cookies"],
    send: (request) => {
      sent.push(request);
      return Promise.resolve({
        status: 200,
        headers: { "content-type": ["text/html"] },
        body: new TextEncoder().encode(page),
        transport: "kernel-curl",
        gaps: [],
      });
    },
  };
  return { transport, sent, bytes: page.length };
};

const boundedRead = `import { Effect, Schema } from "effect";
import { defineHttpOperation, readText } from "opengpt-browser-engine/runtime";
export default defineHttpOperation({
  name: "read_page",
  input: Schema.Struct({}),
  output: Schema.Struct({ bytes: Schema.Number }),
  run: (_input, http) =>
    Effect.gen(function* () {
      const { text } = yield* readText(http, {
        url: "/search?q=lamp",
        method: "GET",
        maxResponseBytes: 5_000_000,
      });
      return { bytes: text.length };
    }),
});`;

it("reads a large page with a response limit and nothing else declared", async () => {
  const site = pageSite(3_000_000);
  const result = await run({
    entrypoint: "src/tool-http.mjs",
    source: boundedRead,
    http: site.transport,
  });
  expect(result).toMatchObject({ _tag: "Right", right: { output: { bytes: site.bytes } } });
  expect(site.sent).toHaveLength(1);
}, 30_000);

it("fails a page over the response limit as too large, after sending it", async () => {
  const site = pageSite(6_000_000);
  const result = await run({
    entrypoint: "src/tool-http.mjs",
    source: boundedRead,
    http: site.transport,
  });
  expect(result).toMatchObject({
    _tag: "Left",
    left: { tag: "HttpFailure", code: "response_too_large" },
  });
  expect(site.sent).toHaveLength(1);
}, 30_000);

/**
 * A site whose server-rendered page holds its state only when the page's own fetch asks for it,
 * recording each request.
 */
const statefulPageSite = (options: { readonly direct: string; readonly page: string }) => {
  const sent: SiteHttpRequest[] = [];
  const transport: HttpTransport = {
    name: "kernel-curl",
    capabilities: ["session-cookies", "page-environment"],
    send: (request) => {
      sent.push(request);
      const fromPage = request.requires?.includes("page-environment") === true;
      return Promise.resolve({
        status: 200,
        headers: { "content-type": ["text/html"] },
        body: new TextEncoder().encode(fromPage ? options.page : options.direct),
        transport: fromPage ? "page-fetch" : "kernel-curl",
        gaps: [],
      });
    },
  };
  return { transport, sent };
};

const pageShell = `<html><head><title>Lamp search</title></head><body><main></main></body></html>`;
const pageWithState = `<html><head><title>Lamp search</title>
<script id="search-state" type="application/json">{"total":2}</script></head>
<body><ul><li><a href="/p/1">Brass   lamp</a></li><li><a href="/p/2">Paper &amp; lamp</a></li></ul></body></html>`;

const htmlVersion = `import { Effect, Schema } from "effect";
import { defineHttpOperation, parseHtml, readEmbeddedJson, readText } from "opengpt-browser-engine/runtime";
export default defineHttpOperation({
  name: "search_lamps",
  input: Schema.Struct({}),
  output: Schema.Struct({
    total: Schema.Number,
    links: Schema.Array(Schema.Struct({ name: Schema.String, href: Schema.String })),
  }),
  run: (_input, http) =>
    Effect.gen(function* () {
      const request = { url: "/search?q=lamp", method: "GET" };
      const state = yield* readEmbeddedJson(
        http,
        request,
        { id: "search-state" },
        Schema.Struct({ total: Schema.Number }),
      );
      const { text } = yield* readText(http, { ...request, requires: ["page-environment"] });
      const links = parseHtml(text)
        .select("li a[href]")
        .map((link) => ({ name: link.text(), href: link.attr("href") ?? "" }));
      return { total: state.total, links };
    }),
});`;

it("reads a page's embedded state over the page's fetch when curl's answer lacks it", async () => {
  const site = statefulPageSite({ direct: pageShell, page: pageWithState });
  const result = await run({
    entrypoint: "src/tool-http.mjs",
    source: htmlVersion,
    http: site.transport,
  });
  expect(result).toMatchObject({
    _tag: "Right",
    right: {
      output: {
        total: 2,
        links: [
          { name: "Brass lamp", href: "/p/1" },
          { name: "Paper & lamp", href: "/p/2" },
        ],
      },
    },
  });
  expect(site.sent.slice(0, 2).map((request) => request.requires ?? [])).toEqual([
    [],
    ["page-environment"],
  ]);
}, 30_000);

it("fails naming the missing block and the page's title when neither answer has it", async () => {
  const site = statefulPageSite({ direct: pageShell, page: pageShell });
  const result = await run({
    entrypoint: "src/tool-http.mjs",
    source: htmlVersion,
    http: site.transport,
  });
  expect(result).toMatchObject({ _tag: "Left", left: { tag: "OperationFailure" } });
  const message = result._tag === "Left" ? result.left.message : "";
  expect(message).toContain('<script id="search-state">');
  expect(message).toContain('"Lamp search"');
  expect(site.sent).toHaveLength(2);
}, 30_000);
