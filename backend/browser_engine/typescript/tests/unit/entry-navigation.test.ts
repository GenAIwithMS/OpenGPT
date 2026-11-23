import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { mintEntryNavigation } from "../../src/mint/contracts.js";
import type { HostExecute } from "../../src/runtime/host-execute.js";
import { entryNavigationCode, loadEntry, stopLoadingCode } from "../../src/runtime/start-state.js";
import { requestSite } from "../../src/standalone/request-context.js";
import type { StandaloneSession } from "../../src/standalone/session.js";

// How the host's load of the request's page is read, and what the build's model is told of it.

const entryUrl = "https://site.invalid/claims?plan=ppo#member";

/** A browser that answers every call with `answer`, recording each call's code. */
const answering = (answer: unknown) => {
  const calls: { readonly code: string; readonly timeoutSec: number | undefined }[] = [];
  const execute: HostExecute = (code, timeoutSec) =>
    Effect.sync(() => {
      calls.push({ code, timeoutSec });
      return answer;
    });
  return { execute, calls };
};
const load = (execute: HostExecute, url = entryUrl) =>
  Effect.runPromise(loadEntry(execute, "page_1", url, 30_000));
const failedWith = (name: string, message: string, url: string | null = "about:blank") =>
  answering({ ok: false, name, message, url }).execute;

describe("loadEntry", () => {
  it("loads the page in one call on the primary tab, within its timeout and a margin", async () => {
    const { execute, calls } = answering({
      ok: true,
      response: { status: 200, headers: {}, method: "GET", redirected: true },
      redirects: [{ url: "https://site.invalid/claims", status: 302 }],
      truncated: false,
      url: "https://site.invalid/claims/new",
    });
    const outcome = await load(execute);
    expect(calls).toEqual([
      {
        code: entryNavigationCode("page_1", new URL(entryUrl).href, 30_000),
        timeoutSec: 35,
      },
    ]);
    expect(outcome).toEqual({
      outcome: "ready",
      requestedUrl: entryUrl,
      resolvedUrl: "https://site.invalid/claims/new",
      redirects: [{ url: "https://site.invalid/claims", status: 302 }],
      redirectsTruncated: false,
      status: 200,
      durationMs: expect.any(Number),
    });
  });

  it("reads an error status as the site's answer, and a load with no response as ready", async () => {
    const answered = (response: unknown) =>
      answering({ ok: true, response, redirects: [], truncated: false, url: entryUrl }).execute;
    expect(
      await load(answered({ status: 503, headers: {}, method: "GET", redirected: false })),
    ).toMatchObject({ outcome: "http_error", status: 503, resolvedUrl: entryUrl });
    // A same-document navigation, such as to another fragment, has no response.
    expect(await load(answered(null))).toMatchObject({ outcome: "ready", status: null });
  });

  it("names a load that ran out of time, and keeps where the tab was", async () => {
    const outcome = await load(
      failedWith("TimeoutError", "page.goto: Timeout 30000ms exceeded.", "about:blank"),
    );
    expect(outcome).toEqual({
      outcome: "timeout",
      requestedUrl: entryUrl,
      resolvedUrl: "about:blank",
      redirects: [],
      redirectsTruncated: false,
      status: null,
      durationMs: expect.any(Number),
      failure: {
        kind: "timeout",
        name: "TimeoutError",
        message: "page.goto: Timeout 30000ms exceeded.",
      },
    });
  });

  it.each([
    ["net::ERR_NAME_NOT_RESOLVED", "dns"],
    ["net::ERR_CONNECTION_REFUSED", "refused"],
    ["net::ERR_EMPTY_RESPONSE", "reset"],
    ["net::ERR_CERT_AUTHORITY_INVALID", "tls"],
    ["net::ERR_BLOCKED_BY_CLIENT", "blocked"],
    ["net::ERR_ABORTED", "aborted"],
    ["Target page, context or browser has been closed", "closed"],
    ["Something else went wrong", "other"],
  ])("reads %s as a failed load of kind %s", async (message, kind) => {
    expect(await load(failedWith("Error", `page.goto: ${message}`))).toMatchObject({
      outcome: "failed",
      status: null,
      failure: { kind, name: "Error" },
    });
  });

  it("keeps the requested page as where the tab was when it can't say", async () => {
    expect(await load(failedWith("Error", "Target closed", null))).toMatchObject({
      outcome: "failed",
      resolvedUrl: entryUrl,
      failure: { kind: "closed" },
    });
  });

  it("answers a browser call that failed as a failed load, never a failure", async () => {
    const outcome = await load(() => Effect.fail(new Error("net::ERR_CONNECTION_RESET")));
    expect(outcome).toMatchObject({
      outcome: "failed",
      resolvedUrl: entryUrl,
      failure: { kind: "reset" },
    });
  });

  it("keeps a URL whole when it crosses the ordinary message limit", async () => {
    const failedUrl = `https://site.invalid/error?detail=${"x".repeat(900)}`;
    const error = new Error(`${"a".repeat(2000)} ${failedUrl} trailing explanation`);
    const outcome = await load(() => Effect.fail(error));
    if (outcome.outcome === "skipped") throw new Error("Entry was unexpectedly skipped");
    expect(outcome.failure?.message).toContain(failedUrl);
    expect(outcome.failure?.message).not.toContain("trailing explanation");
  });

  it("still bounds error text without a URL, and an error's name", async () => {
    const outcome = await load(() =>
      Effect.fail(Object.assign(new Error("x".repeat(3_000)), { name: "N".repeat(300) })),
    );
    if (outcome.outcome === "skipped") throw new Error("Entry was unexpectedly skipped");
    expect(outcome.failure?.message).toHaveLength(2_048);
    expect(outcome.failure?.name).toHaveLength(200);
  });
});

describe("mintEntryNavigation", () => {
  it("is absent before the entry is attempted and carries only the finite outcome after", () => {
    expect(mintEntryNavigation(entryUrl, undefined)).toBeUndefined();
    expect(mintEntryNavigation(entryUrl, "open_failed")).toEqual({
      state: "not_opened",
      outcome: "failed",
      requestedUrl: entryUrl,
    });
    const base = {
      requestedUrl: entryUrl,
      redirects: [],
      redirectsTruncated: false,
      durationMs: 5,
    };
    expect(
      mintEntryNavigation(entryUrl, {
        ...base,
        outcome: "http_error",
        resolvedUrl: `${entryUrl}x`,
        status: 503,
      }),
    ).toEqual({
      state: "opened",
      outcome: "http_error",
      requestedUrl: entryUrl,
      resolvedUrl: `${entryUrl}x`,
      redirects: [],
      status: 503,
    });
    expect(
      mintEntryNavigation(entryUrl, {
        ...base,
        outcome: "failed",
        resolvedUrl: "about:blank",
        status: null,
        failure: { kind: "refused", name: "Error", message: "net::ERR_CONNECTION_REFUSED" },
      }),
    ).toEqual({
      state: "not_opened",
      outcome: "failed",
      requestedUrl: entryUrl,
      resolvedUrl: "about:blank",
      redirects: [],
    });
    expect(mintEntryNavigation(entryUrl, { outcome: "skipped" })).toEqual({
      state: "not_opened",
      outcome: "skipped",
      requestedUrl: entryUrl,
    });
  });

  it("shows the caller's own page as given, and every redirect the load followed", () => {
    const redirects = [
      { url: "https://site.invalid/claims", status: 301 },
      { url: "https://site.invalid/claims/", status: 302 },
    ];
    expect(
      mintEntryNavigation(entryUrl, {
        outcome: "ready",
        requestedUrl: entryUrl,
        resolvedUrl: "https://site.invalid/claims/new",
        redirects,
        redirectsTruncated: false,
        status: 200,
        durationMs: 40,
      }),
    ).toEqual({
      state: "opened",
      outcome: "ready",
      requestedUrl: entryUrl,
      resolvedUrl: "https://site.invalid/claims/new",
      redirects,
      status: 200,
    });
  });
});

describe("requestSite", () => {
  /** The local host's load of the request's page on `execute`, and what the build is told. */
  const navigated = async (execute: HostExecute) => {
    const session = { browser: { execute, targetId: "page_1" } } as unknown as StandaloneSession;
    const site = await Effect.runPromise(requestSite(session, { url: entryUrl }));
    await Effect.runPromise(site.navigate);
    return site.entryNavigation();
  };
  const refused = {
    ok: false,
    name: "Error",
    message: "page.goto: net::ERR_CONNECTION_REFUSED",
    url: "about:blank",
  };

  it("stops the tab's loading after a load that failed, so its error page can't cut off the next load", async () => {
    const { execute, calls } = answering(refused);
    expect(await navigated(execute)).toMatchObject({ state: "not_opened", outcome: "failed" });
    expect(calls).toEqual([
      { code: entryNavigationCode("page_1", new URL(entryUrl).href, 30_000), timeoutSec: 35 },
      { code: stopLoadingCode("page_1"), timeoutSec: 10 },
    ]);
  });

  it("leaves a load that ran out of time, or that the site answered, as it is", async () => {
    const answered = (status: number) => ({
      ok: true,
      response: { status, headers: {}, method: "GET", redirected: false },
      redirects: [],
      truncated: false,
      url: entryUrl,
    });
    for (const answer of [
      {
        ok: false,
        name: "TimeoutError",
        message: "page.goto: Timeout 30000ms exceeded.",
        url: null,
      },
      answered(200),
      answered(404),
    ]) {
      const { execute, calls } = answering(answer);
      await navigated(execute);
      expect(calls).toHaveLength(1);
    }
  });

  it("keeps a failed load's outcome when the browser can't stop the tab either", async () => {
    const calls: string[] = [];
    const execute: HostExecute = (code) =>
      Effect.suspend(() => {
        calls.push(code);
        return calls.length === 1
          ? Effect.succeed(refused)
          : Effect.fail(new Error("Target closed"));
      });
    expect(await navigated(execute)).toMatchObject({ state: "not_opened", outcome: "failed" });
    expect(calls).toEqual([
      entryNavigationCode("page_1", new URL(entryUrl).href, 30_000),
      stopLoadingCode("page_1"),
    ]);
  });
});
