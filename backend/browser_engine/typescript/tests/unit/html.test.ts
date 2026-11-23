import { Effect, Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { embeddedJson, parseHtml, readEmbeddedJson } from "../../src/browser/index.js";
import { makeEffectJournal } from "../../src/runtime/context.js";
import { Deadline } from "../../src/runtime/deadline.js";
import { HttpFailure } from "../../src/runtime/site-http.js";
import type {
  HttpTransport,
  SiteHttpRequest,
  SiteHttpResponse,
} from "../../src/runtime/site-http.js";
import { makeSiteHttp } from "../../src/runtime/site-http-host.js";

// Reading a site's HTML answer with `parseHtml` and `embeddedJson`, and `readEmbeddedJson` over a
// synthetic site, as a host builds `SiteHttp` with `makeSiteHttp`.

const page = `<!doctype html>
<html><head><title>Lamps &amp; Lights</title>
<script type="application/ld+json">
<!--
{"@context":"https://schema.org","@type":"Product","name":"Brass lamp"}
-->
</script>
<script type="application/ld+json">//<![CDATA[
{"@type":"BreadcrumbList"}
//]]></script>
<script id="app-state" type="application/json">
  {"products":[{"id":"p-1","name":"Brass lamp","price":42}]};
</script>
</head><body>
<div id="root" data-state="{&quot;query&quot;:&quot;lamp&quot;,&quot;note&quot;:&quot;5 &lt; 6&quot;}"></div>
<ul class="results">
  <li><a href="/p/1">Brass
     lamp</a></li>
  <li><a href="/p/2">Paper &amp; lamp</a></li>
  <li><span>no link</span></li>
</ul>
</body></html>`;

describe("parseHtml", () => {
  it("selects nodes with CSS and reads their decoded text and attributes", () => {
    const document = parseHtml(page);
    expect(
      document.select("li a[href]").map((link) => ({ text: link.text(), href: link.attr("href") })),
    ).toEqual([
      { text: "Brass lamp", href: "/p/1" },
      { text: "Paper & lamp", href: "/p/2" },
    ]);
    expect(document.title()).toBe("Lamps & Lights");
    expect(document.selectOne("table")).toBeUndefined();
    expect(document.selectOne("li span")?.attr("href")).toBeUndefined();
  });

  it("scopes a node's selection to its descendants and serializes the node", () => {
    const document = parseHtml(page);
    const results = document.selectOne("ul.results");
    expect(results?.select("span").map((span) => span.text())).toEqual(["no link"]);
    expect(results?.selectOne("ul")).toBeUndefined();
    const link = parseHtml(results?.selectOne("a")?.html() ?? "").selectOne("a");
    expect(link?.attr("href")).toBe("/p/1");
    expect(link?.text()).toBe("Brass lamp");
  });

  it("has no title when the page has none", () => {
    expect(parseHtml("<p>Hello</p>").title()).toBeUndefined();
  });
});

describe("embeddedJson", () => {
  it("decodes a script block by its id, without its whitespace and trailing semicolon", () => {
    expect(embeddedJson(page, { id: "app-state" })).toEqual(
      Either.right({ products: [{ id: "p-1", name: "Brass lamp", price: 42 }] }),
    );
  });

  it("decodes every block of a script type, inside comment and CDATA wrappers", () => {
    expect(embeddedJson(page, { type: "ld+json" })).toEqual(
      Either.right([
        { "@context": "https://schema.org", "@type": "Product", name: "Brass lamp" },
        { "@type": "BreadcrumbList" },
      ]),
    );
    expect(embeddedJson(page, { type: "json" })).toEqual(
      Either.right([{ products: [{ id: "p-1", name: "Brass lamp", price: 42 }] }]),
    );
  });

  it("decodes JSON held in an attribute, with its entities decoded", () => {
    expect(embeddedJson(page, { attribute: "data-state" })).toEqual(
      Either.right({ query: "lamp", note: "5 < 6" }),
    );
    expect(
      embeddedJson(`<i data-props="none"></i><i data-props='{"size":"M"}'></i>`, {
        attribute: "data-props",
      }),
    ).toEqual(Either.right({ size: "M" }));
  });

  it("reads state a script assigns, as an object literal or a JSON.parse string", () => {
    const assigned = `<html><head><title>Lamps</title>
<script src="/app.js"></script>
<script>var other = 1; window.__APP_STATE__ = {"query":"lamp","items":[{"id":"p-1","name":"Brass \\"lamp\\" {large}"}],"note":"a};b"};
window.__APP_STATE__.ready = true;</script>
<script>self.__PAGE_DATA = JSON.parse("{\\"page\\":2,\\"label\\":\\"caf\\u00e9 \\\\\\\\ \\u2603\\"}");</script>
<script>globalThis["__LIST__"]=[1,[2,3],{"k":"]"}]</script>
</head></html>`;
    expect(embeddedJson(assigned, { assignment: "__APP_STATE__" })).toEqual(
      Either.right({
        query: "lamp",
        items: [{ id: "p-1", name: 'Brass "lamp" {large}' }],
        note: "a};b",
      }),
    );
    expect(embeddedJson(assigned, { assignment: "__PAGE_DATA" })).toEqual(
      Either.right({ page: 2, label: "caf\u00e9 \\ \u2603" }),
    );
    expect(embeddedJson(assigned, { assignment: "__LIST__" })).toEqual(
      Either.right([1, [2, 3], { k: "]" }]),
    );
    const missing = embeddedJson(assigned, { assignment: "__NEXT__" });
    expect(missing).toMatchObject({ left: { reason: "missing" } });
    expect(Either.isLeft(missing) && missing.left.message).toMatch(/__NEXT__.*"Lamps"/);
    // A comparison or a longer name is not the assignment.
    expect(
      embeddedJson(`<script>if (x.__S == 1) {} var my__S = {"a":1};</script>`, {
        assignment: "__S",
      }),
    ).toMatchObject({ left: { reason: "missing" } });
    // A literal that is not JSON is there but unparsable.
    expect(
      embeddedJson(`<script>window.__S = {a: 1};</script>`, { assignment: "__S" }),
    ).toMatchObject({ left: { reason: "unparsable" } });
  });

  it("scans a script with many unclosed assignments in linear time", () => {
    for (const repeated of ["__S = {", 'window.__S = ["x']) {
      const script = `<script>${repeated.repeat(100_000)}</script>`;
      const started = performance.now();
      expect(embeddedJson(script, { assignment: "__S" })).toMatchObject({
        left: { reason: "missing" },
      });
      // A quadratic scan takes minutes here; a linear one, well under a second.
      expect(performance.now() - started).toBeLessThan(5_000);
    }
  });

  it("prefers the last assignment that parses, in a script of a JavaScript type", () => {
    const filled = `<script>window.__S = {}; /* filled below */ window.__S = {"items":[1,2]};</script>
<script type="text/template">window.__S = {"template":true}</script>
<script>notwindow["__S"] = {"other":true}</script>`;
    expect(embeddedJson(filled, { assignment: "__S" })).toEqual(Either.right({ items: [1, 2] }));
    expect(
      embeddedJson(`<script type="module">window["__S"] = [3]</script>`, { assignment: "__S" }),
    ).toEqual(Either.right([3]));
  });

  it("reads only an attribute the element has, never an inherited name", () => {
    const document = parseHtml(`<div data-a="1"></div>`);
    expect(document.selectOne("div")?.attr("constructor")).toBeUndefined();
    expect(document.selectOne("div")?.attr("__proto__")).toBeUndefined();
    expect(embeddedJson(`<div data-a="1"></div>`, { attribute: "constructor" })).toMatchObject({
      left: { reason: "missing" },
    });
  });

  it("names the selector and the page title when the block is missing or empty", () => {
    const missing = embeddedJson(page, { id: "cart-state" });
    expect(missing).toMatchObject({ left: { _tag: "EmbeddedJsonFailure", reason: "missing" } });
    expect(Either.isLeft(missing) && missing.left.message).toMatch(
      /<script id="cart-state">.*"Lamps & Lights"/,
    );
    const empty = embeddedJson(`<title>Cart</title><script id="cart-state"> </script>`, {
      id: "cart-state",
    });
    expect(empty).toMatchObject({ left: { reason: "missing" } });
    expect(Either.isLeft(empty) && empty.left.message).toMatch(/<script id="cart-state">.*"Cart"/);
    const noType = embeddedJson("<p>Hello</p>", { type: "ld+json" });
    expect(noType).toMatchObject({ left: { reason: "missing" } });
    expect(Either.isLeft(noType) && noType.left.message).toContain(
      '<script type="application/ld+json">',
    );
  });

  it("says when the block is there but is not JSON", () => {
    const broken = embeddedJson(`<title>Cart</title><script id="cart-state">{items:</script>`, {
      id: "cart-state",
    });
    expect(broken).toMatchObject({ left: { reason: "unparsable" } });
    expect(Either.isLeft(broken) && broken.left.message).toMatch(
      /<script id="cart-state">.*"Cart"/,
    );
    expect(
      embeddedJson(`<i data-props="none"></i>`, { attribute: "data-props" }),
    ).toMatchObject({ left: { reason: "unparsable" } });
  });
});

const htmlAnswer = (text: string, transport: SiteHttpResponse["transport"]) => ({
  status: 200,
  headers: { "content-type": ["text/html"] },
  body: new TextEncoder().encode(text),
  transport,
  gaps: [],
});

/** A site that answers curl with `direct` and the page's fetch with `page`, recording requests. */
const site = async (options: {
  readonly direct: string;
  readonly page: string;
  readonly capabilities?: HttpTransport["capabilities"];
  /** A replay of one recorded answer, which a second request finds no recording for. */
  readonly replay?: true;
  /** The page's fetch fails before the site answers. */
  readonly pageFails?: true;
}) => {
  const sent: SiteHttpRequest[] = [];
  const transport: HttpTransport = {
    name: options.replay === true ? "saved-http" : "kernel-curl",
    capabilities: options.capabilities ?? ["session-cookies", "page-environment"],
    send: (request) => {
      sent.push(request);
      if (options.replay === true)
        return sent.length === 1
          ? Promise.resolve(htmlAnswer(options.direct, "saved-http"))
          : Promise.reject(new HttpFailure({ code: "not_recorded", dispatch: "not_sent" }));
      if (request.requires?.includes("page-environment") === true && options.pageFails === true)
        return Promise.reject(new HttpFailure({ code: "transport_failed", dispatch: "unknown" }));
      return Promise.resolve(
        request.requires?.includes("page-environment") === true
          ? htmlAnswer(options.page, "page-fetch")
          : htmlAnswer(options.direct, "kernel-curl"),
      );
    },
  };
  const journal = await Effect.runPromise(makeEffectJournal);
  const http = makeSiteHttp({
    transport,
    context: {
      journal,
      deadline: Deadline.after(),
      capture: { start: Effect.void, finish: Effect.void },
      events: { emit: () => Effect.void },
    },
    capture: () => Effect.void,
    siteOrigin: "https://shop.example",
  });
  return { http, sent };
};

const shell = `<html><head><title>Lamps</title></head><body><div id="root"></div></body></html>`;
const State = Schema.Struct({
  products: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
});

describe("readEmbeddedJson", () => {
  it("reads the block over the page's fetch once when the first answer lacks it", async () => {
    const shop = await site({ direct: shell, page });
    const state = await Effect.runPromise(
      readEmbeddedJson(
        shop.http,
        { url: "/search?q=lamp", method: "GET" },
        { id: "app-state" },
        State,
      ),
    );
    expect(state.products.map((product) => product.name)).toEqual(["Brass lamp"]);
    expect(shop.sent.map((request) => request.requires ?? [])).toEqual([[], ["page-environment"]]);
  });

  it("fails as parsing, naming the selector and title, when neither answer has it", async () => {
    const shop = await site({ direct: shell, page: shell });
    const failure = await Effect.runPromise(
      Effect.flip(
        readEmbeddedJson(shop.http, { url: "/search", method: "GET" }, { id: "app-state" }, State),
      ),
    );
    expect(failure).toMatchObject({
      _tag: "OperationFailure",
      http: { class: "parsing", transport: "page-fetch", status: 200 },
    });
    expect(failure.message).toContain('<script id="app-state">');
    expect(failure.message).toContain('"Lamps"');
    expect(failure.message).toContain("https://shop.example/search");
    expect(shop.sent).toHaveLength(2);
  });

  it("fails a replay's missing block as parsing, and never asks the replay for another answer", async () => {
    const shop = await site({ direct: shell, page, replay: true });
    const failure = await Effect.runPromise(
      Effect.flip(
        readEmbeddedJson(shop.http, { url: "/search", method: "GET" }, { id: "app-state" }, State),
      ),
    );
    expect(failure).toMatchObject({
      _tag: "OperationFailure",
      http: { class: "parsing", transport: "saved-http" },
    });
    expect(failure.message).toContain('<script id="app-state">');
    expect(shop.sent).toHaveLength(1);
  });

  it("keeps the missing block's parsing failure when the page's fetch fails", async () => {
    const shop = await site({ direct: shell, page, pageFails: true });
    const failure = await Effect.runPromise(
      Effect.flip(
        readEmbeddedJson(shop.http, { url: "/search", method: "GET" }, { id: "app-state" }, State),
      ),
    );
    expect(failure).toMatchObject({
      _tag: "OperationFailure",
      http: { class: "parsing", transport: "kernel-curl" },
    });
    expect(failure.message).toContain('<script id="app-state">');
    expect(failure.message).toContain("transport_failed");
    expect(shop.sent).toHaveLength(2);
  });

  it("never sends a write again", async () => {
    const shop = await site({ direct: shell, page });
    const failure = await Effect.runPromise(
      Effect.flip(
        readEmbeddedJson(
          shop.http,
          { url: "/cart", method: "POST", body: "{}" },
          { id: "app-state" },
          State,
        ),
      ),
    );
    expect(failure).toMatchObject({ _tag: "OperationFailure", http: { class: "parsing" } });
    expect(shop.sent).toHaveLength(1);
  });

  it("does not ask for the page's fetch from a host that cannot carry it", async () => {
    const shop = await site({ direct: shell, page, capabilities: ["session-cookies"] });
    const failure = await Effect.runPromise(
      Effect.flip(
        readEmbeddedJson(shop.http, { url: "/search", method: "GET" }, { id: "app-state" }, State),
      ),
    );
    expect(failure).toMatchObject({ _tag: "OperationFailure", http: { class: "parsing" } });
    expect(shop.sent).toHaveLength(1);
  });

  it("fails a block that does not match the schema as parsing, sending nothing more", async () => {
    const shop = await site({ direct: page, page });
    const failure = await Effect.runPromise(
      Effect.flip(
        readEmbeddedJson(
          shop.http,
          { url: "/search", method: "GET" },
          { id: "app-state" },
          Schema.Struct({ total: Schema.Number }),
        ),
      ),
    );
    expect(failure).toMatchObject({ _tag: "OperationFailure", http: { class: "parsing" } });
    expect(failure.message).toContain("total");
    expect(shop.sent).toHaveLength(1);
  });
});
