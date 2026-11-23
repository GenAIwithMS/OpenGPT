import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { readJson, readText } from "../../src/browser/index.js";
import { makeEffectJournal } from "../../src/runtime/context.js";
import { Deadline } from "../../src/runtime/deadline.js";
import { HttpFailure } from "../../src/runtime/site-http.js";
import type {
  HttpExchange,
  HttpTransport,
  SiteHttpRequest,
  SiteHttpResponse,
} from "../../src/runtime/site-http.js";
import { makeSiteHttp } from "../../src/runtime/site-http-host.js";

// `SiteHttp` over a synthetic site, as a host builds it with `makeSiteHttp`.

const html = (status: number, text: string, transport: SiteHttpResponse["transport"]) => ({
  status,
  headers: { "content-type": ["text/html"] },
  body: new TextEncoder().encode(text),
  transport,
  gaps: [],
});
const json = (value: unknown, transport: SiteHttpResponse["transport"]) => ({
  status: 200,
  headers: { "content-type": ["application/json"] },
  body: new TextEncoder().encode(JSON.stringify(value)),
  transport,
  gaps: [],
});

/** The synthetic challenge page this test's host knows. */
const challengePage = "<html><title>Checking your browser</title></html>";
const isChallenge = (response: SiteHttpResponse) =>
  new TextDecoder().decode(response.body).includes("Checking your browser");

/**
 * A site that answers the transport's default path with `direct` and a request that needs the
 * page's environment with `page`, recording each request.
 */
const site = async (options: {
  readonly direct: SiteHttpResponse;
  readonly page?: SiteHttpResponse;
  readonly isChallenge?: (response: SiteHttpResponse) => boolean;
  readonly capture?: (exchange: HttpExchange) => Effect.Effect<void, HttpFailure>;
  readonly deadline?: Deadline;
  readonly capabilities?: HttpTransport["capabilities"];
}) => {
  const sent: SiteHttpRequest[] = [];
  const events: { readonly name: string; readonly data: unknown }[] = [];
  const transport: HttpTransport = {
    name: "kernel-curl",
    capabilities: options.capabilities ?? [
      "session-cookies",
      "page-environment",
      "buffered-response-v1",
    ],
    send: (request) => {
      sent.push(request);
      return Promise.resolve(
        request.requires?.includes("page-environment") === true && options.page !== undefined
          ? options.page
          : options.direct,
      );
    },
  };
  const journal = await Effect.runPromise(makeEffectJournal);
  const http = makeSiteHttp({
    transport,
    context: {
      journal,
      deadline: options.deadline ?? Deadline.after(),
      capture: { start: Effect.void, finish: Effect.void },
      events: {
        emit: (name, data) =>
          Effect.sync(() => {
            events.push({ name, data });
          }),
      },
    },
    capture: options.capture ?? (() => Effect.void),
    siteOrigin: "https://shop.example",
    ...(options.isChallenge === undefined ? {} : { isChallenge: options.isChallenge }),
  });
  return { http, sent, events, dispatched: () => Effect.runPromise(journal.state) };
};

describe("the transport a request starts on", () => {
  it("announces the page's fetch for a request that needs the page, and curl otherwise", async () => {
    const shop = await site({ direct: json({}, "kernel-curl"), page: json({}, "page-fetch") });
    await Effect.runPromise(shop.http.request({ url: "/a", method: "GET" }));
    await Effect.runPromise(
      shop.http.request({ url: "/a", method: "GET", requires: ["page-environment"] }),
    );
    expect(
      shop.events
        .filter((event) => event.name === "http.request_started")
        .map((event) => (event.data as { transport: string }).transport),
    ).toEqual(["kernel-curl", "page-fetch"]);
  });
});

describe("bot challenges the host recognizes", () => {
  it("sends a challenged read once more over the page's fetch and reads that answer", async () => {
    const shop = await site({
      direct: html(403, challengePage, "kernel-curl"),
      page: json({ id: "88" }, "page-fetch"),
      isChallenge,
    });
    const read = await Effect.runPromise(
      readJson(shop.http, { url: "/api/p/88", method: "GET" }, Schema.Struct({ id: Schema.String })),
    );
    expect(read).toEqual({ id: "88" });
    expect(shop.sent.map((request) => request.requires ?? [])).toEqual([[], ["page-environment"]]);
  });

  it("fails a read the page's fetch was challenged on too, saying so", async () => {
    const shop = await site({
      direct: html(200, challengePage, "kernel-curl"),
      page: html(200, challengePage, "page-fetch"),
      isChallenge,
    });
    const failure = await Effect.runPromise(
      Effect.flip(readText(shop.http, { url: "/p/1", method: "GET" })),
    );
    expect(failure).toMatchObject({ _tag: "OperationFailure" });
    expect(failure.message).toContain("even over the page's fetch");
  });

  it("never sends a challenged write again", async () => {
    const shop = await site({ direct: html(403, challengePage, "kernel-curl"), isChallenge });
    const failure = await Effect.runPromise(
      Effect.flip(readText(shop.http, { url: "/cart", method: "POST", body: "{}" })),
    );
    expect(failure).toMatchObject({ _tag: "OperationFailure" });
    expect(shop.sent).toHaveLength(1);
  });

  it("reads every answer as the site's own when the host has no challenge test", async () => {
    const shop = await site({ direct: html(200, challengePage, "kernel-curl") });
    const read = await Effect.runPromise(readText(shop.http, { url: "/p/1", method: "GET" }));
    expect(read.text).toBe(challengePage);
    expect(shop.sent).toHaveLength(1);
  });
});

describe("requests SiteHttp refuses or bounds", () => {
  const request = (shop: Awaited<ReturnType<typeof site>>, sent: unknown) =>
    Effect.runPromise(Effect.either(shop.http.request(sent as SiteHttpRequest)));

  it("refuses a malformed request before anything is sent, naming the rule it broke", async () => {
    const cases: readonly (readonly [unknown, string, Record<string, string>?])[] = [
      [{ url: "//elsewhere.example/a", method: "GET" }, "url_not_absolute"],
      [{ url: "ftp://shop.example/a", method: "GET" }, "url_not_absolute"],
      [{ url: "https://user:secret@shop.example/a", method: "GET" }, "url_has_credentials"],
      [{ url: "/a#reviews", method: "GET" }, "url_has_fragment"],
      [{ url: "/a", method: "TRACE" }, "method_unsupported"],
      [{ url: "/a", method: "GET", body: "" }, "body_on_get_or_head"],
      [{ url: "/a", method: "HEAD", body: "x" }, "body_on_get_or_head"],
      [
        { url: "/a", method: "GET", headers: { ":authority": "shop.example" } },
        "header_name_invalid",
      ],
      [
        { url: "/a", method: "GET", headers: { accept: "text/html\r\nx: y" } },
        "header_value_newline",
        { header: "accept" },
      ],
      [{ url: "/a", method: "GET", headers: { accept: 1 } }, "header_value_not_text"],
      [{ url: "/a", method: "GET", timeoutMs: 0 }, "timeout_invalid"],
      [{ url: "/a", method: "GET", maxResponseBytes: 0 }, "max_response_bytes_out_of_range"],
      [
        { url: "/a", method: "GET", maxResponseBytes: 9 * 1024 * 1024 },
        "max_response_bytes_out_of_range",
      ],
      [
        { url: "/a", method: "GET", requires: ["streaming"] },
        "capability_unsupported",
        { capability: "streaming", transport: "kernel-curl" },
      ],
    ];
    for (const [sent, rule, context] of cases) {
      const shop = await site({ direct: json({}, "kernel-curl") });
      const result = await request(shop, sent);
      expect(result, rule).toMatchObject({
        left: { _tag: "HttpFailure", dispatch: "not_sent", refusal: { rule, ...context } },
      });
      expect(result._tag === "Left" ? result.left.message : "", rule).toContain(
        `refused by the request check, nothing was sent: ${rule}`,
      );
      expect(shop.sent, rule).toHaveLength(0);
      expect(await shop.dispatched(), rule).toBe("not_started");
    }
  });

  it("keeps a URL's credentials out of the refusal", async () => {
    const shop = await site({ direct: json({}, "kernel-curl") });
    const result = await request(shop, { url: "https://user:secret@shop.example/a", method: "GET" });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result._tag === "Left" ? result.left.message : "").not.toContain("secret");
  });

  it("never echoes request text that may hold a secret in a refusal", async () => {
    const cases: readonly (readonly [string, unknown, string, string])[] = [
      [
        "a header line sent as a header name",
        { url: "/a", method: "GET", headers: { "authorization: Bearer tok123": "x" } },
        "header_name_invalid",
        "tok123",
      ],
      [
        "a fragment",
        { url: "https://shop.example/a?id=1#access_token=tok123", method: "GET" },
        "url_has_fragment",
        "tok123",
      ],
      [
        "a query value on a refused request",
        { url: "https://shop.example/a?key=tok123", method: "TRACE" },
        "method_unsupported",
        "tok123",
      ],
      [
        "a capability that is not an identifier",
        { url: "/a", method: "GET", requires: ["Bearer tok123"] },
        "capability_unsupported",
        "tok123",
      ],
      [
        "a body that is not text",
        { url: "/a", method: "POST", body: { token: "tok123" } },
        "request_invalid",
        "tok123",
      ],
      [
        "headers that are not an object",
        { url: "/a", method: "GET", headers: ["tok123"] },
        "request_invalid",
        "tok123",
      ],
      [
        "requires that is not a list",
        { url: "/a", method: "GET", requires: "tok123" },
        "request_invalid",
        "tok123",
      ],
      ["a request that is not an object", "tok123", "request_invalid", "tok123"],
    ];
    for (const [label, sent, rule, secret] of cases) {
      const shop = await site({ direct: json({}, "kernel-curl") });
      const result = await request(shop, sent);
      expect(result, label).toMatchObject({
        left: { _tag: "HttpFailure", dispatch: "not_sent", refusal: { rule } },
      });
      expect(JSON.stringify(result), label).not.toContain(secret);
      expect(result._tag === "Left" ? result.left.message : "", label).toContain(rule);
      expect(shop.sent, label).toHaveLength(0);
    }
  });

  it("names the field a non-text body breaks, not its value", async () => {
    const shop = await site({ direct: json({}, "kernel-curl") });
    const result = await request(shop, { url: "/a", method: "POST", body: { token: "tok123" } });
    expect(result._tag === "Left" ? result.left.message : "").toContain("body");
  });

  it("bounds a response with a limit alone, on a transport without the buffered contract", async () => {
    const shop = await site({
      direct: json({ items: "x".repeat(64) }, "kernel-curl"),
      capabilities: ["session-cookies"],
    });
    expect(await request(shop, { url: "/a", method: "GET", maxResponseBytes: 4_096 })).toMatchObject(
      { right: { status: 200 } },
    );
    expect(await request(shop, { url: "/a", method: "GET", maxResponseBytes: 16 })).toMatchObject({
      left: { code: "response_too_large", dispatch: "sent", response: { body: { limitBytes: 16 } } },
    });
  });

  it("fails a body over the requested limit as sent, with its status and no bytes", async () => {
    const shop = await site({ direct: json({ items: "x".repeat(64) }, "kernel-curl") });
    expect(
      await request(shop, {
        url: "/a",
        method: "GET",
        maxResponseBytes: 16,
        requires: ["buffered-response-v1"],
      }),
    ).toMatchObject({
      left: {
        code: "response_too_large",
        dispatch: "sent",
        response: { status: 200, body: { state: "unavailable", limitBytes: 16 } },
      },
    });
    expect(await shop.dispatched()).toBe("may_have_dispatched");
  });

  it("sends nothing once capture before the request used up the deadline", async () => {
    let now = 0;
    const shop = await site({
      direct: json({}, "kernel-curl"),
      deadline: Deadline.after(20, () => now),
      capture: () =>
        Effect.sync(() => {
          now = 21;
        }),
    });
    expect(await request(shop, { url: "/a", method: "POST" })).toMatchObject({
      left: { code: "deadline_exceeded", dispatch: "not_sent" },
    });
    expect(shop.sent).toHaveLength(0);
  });

  it("fails a capture failure as not sent before the request and sent after the answer", async () => {
    for (const phase of ["request", "response"] as const) {
      const shop = await site({
        direct: json({}, "kernel-curl"),
        capture: (exchange) =>
          exchange.phase === phase
            ? Effect.fail(new HttpFailure({ code: "capture_failed", dispatch: "unknown" }))
            : Effect.void,
      });
      expect(await request(shop, { url: "/a", method: "POST" })).toMatchObject({
        left: { code: "capture_failed", dispatch: phase === "request" ? "not_sent" : "sent" },
      });
      expect(shop.sent).toHaveLength(phase === "request" ? 0 : 1);
    }
  });
});
