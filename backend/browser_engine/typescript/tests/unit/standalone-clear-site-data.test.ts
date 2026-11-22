// Failure mode covered: a replay that found another workspace's sign-in clears the browser's data
// once before it opens the entry again, and the local host wiped every site's cookies and storage
// in the browser, not only the tool's site's.
import { Effect } from "effect";
import { expect, it } from "vitest";
import { makeSignInBrowser } from "../../src/standalone/authentication.js";

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...args: string[]
) => (...values: unknown[]) => Promise<unknown>;

/**
 * A modeled browser that runs the host's Playwright code: one tab on `at`, a cookie jar, the
 * origins holding storage, and each origin's tab session storage.
 */
const modeledBrowser = (at: string) => {
  let cookies = [
    { name: "sid", domain: ".example.com" },
    { name: "workspace", domain: "acme.example.com" },
    { name: "other", domain: ".example.net" },
    { name: "neighbour", domain: "b.github.io" },
  ];
  const storage = new Set([
    "https://app.example.com",
    "https://acme.example.com",
    "https://id.example.net",
    "https://b.github.io",
  ]);
  const tabStorage = new Set(["https://acme.example.com", "https://id.example.net"]);
  let url = at;
  const routes = new Set<string>();
  const session = {
    send: async (method: string, params?: { readonly origin?: string }) => {
      if (method === "Target.getTargetInfo") return { targetInfo: { targetId: "primary" } };
      if (method === "Storage.clearDataForOrigin" && params?.origin !== undefined)
        storage.delete(params.origin);
      return {};
    },
    detach: async () => undefined,
  };
  const tab = {
    url: () => url,
    frames: () => [{ url: () => url }],
    route: async (pattern: string) => void routes.add(pattern),
    unroute: async (pattern: string) => void routes.delete(pattern),
    goto: async (next: string) => {
      // Only the host's inert documents and a blank tab load here, never the website.
      const inert = [...routes].some((pattern) => next.startsWith(pattern.slice(0, -"/**".length)));
      if (next !== "about:blank" && !inert) throw new Error(`The website loaded: ${next}`);
      url = next;
    },
    evaluate: async () => void tabStorage.delete(new URL(url).origin),
  };
  const context = {
    pages: () => [tab],
    newCDPSession: async () => session,
    storageState: async () => ({
      cookies,
      origins: [...storage].map((origin) => ({ origin, localStorage: [] })),
    }),
    clearCookies: async (filter: { readonly domain: string }) => {
      cookies = cookies.filter((cookie) => cookie.domain !== filter.domain);
    },
  };
  const page = {
    targetId: "primary",
    execute: (code: string) =>
      Effect.tryPromise({
        try: () => new AsyncFunction("page", "context", "browser", code)(tab, context, undefined),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }),
  };
  return {
    page,
    state: () => ({
      cookies: cookies.map((cookie) => cookie.domain),
      storage: [...storage],
      tabStorage: [...tabStorage],
      url,
    }),
  };
};

it("clears only the site's own cookies and storage, and leaves the tab blank", async () => {
  const browser = modeledBrowser("https://acme.example.com/login");
  const signIn = makeSignInBrowser({
    page: browser.page,
    keyboard: { insertText: () => Effect.die("The test types nothing") },
    siteOrigin: "https://app.example.com",
    authenticationOrigins: [],
    typing: { typed: false },
  });
  await Effect.runPromise(signIn.clearSiteData?.() ?? Effect.die("No clearSiteData"));
  expect(browser.state()).toEqual({
    // Another site's cookies and storage survive, a private-suffix neighbour's included.
    cookies: [".example.net", "b.github.io"],
    storage: ["https://id.example.net", "https://b.github.io"],
    tabStorage: ["https://id.example.net"],
    url: "about:blank",
  });
});
