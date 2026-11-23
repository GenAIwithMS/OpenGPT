import { describe, expect, it } from "vitest";
import {
  maximumRedirectHops,
  redirectCandidate,
  reportedNavigation,
  titleLimit,
} from "../../src/destinations/sign-in-redirect.js";

// Core's gates before a host's review of a new sign-in origin the site's own redirect led to.

const from = "https://login.example.net/login";
const site = "https://login.example.net";
const idp = "https://auth.example.org";
const document = 1000.5;
const chain = [site, idp];
const hops = (count: number) => [
  ...Array.from({ length: count - 1 }, (_, index) => `https://hop${index}.example.com`),
  idp,
];

describe("redirectCandidate", () => {
  it.each([
    ["a two-navigation chain", chain],
    ["a chain of exactly the most navigations", hops(maximumRedirectHops)],
  ])("names the origin %s settled on when the live page is still that document", (_, origins) => {
    expect(
      redirectCandidate({
        from,
        navigated: { from: site, origins, document },
        live: { url: `${idp}/password`, document },
      }),
    ).toBe(idp);
  });

  it.each([
    ["no navigation", { from: site, origins: [], document }, `${idp}/password`, document],
    ["no settled document", { from: site, origins: chain }, `${idp}/password`, document],
    ["a later document", { from: site, origins: chain, document }, `${idp}/password`, document + 1],
    [
      "a live page elsewhere than the chain's end",
      { from: site, origins: chain, document },
      "https://other.example.com/",
      document,
    ],
    [
      "a hop over plain http",
      { from: site, origins: ["http://login.example.net", idp], document },
      `${idp}/password`,
      document,
    ],
    ["the screen's own origin", { from: site, origins: [site], document }, `${from}#next`, document],
    [
      "a name only a private network resolves",
      { from: site, origins: ["https://auth.example.test"], document },
      "https://auth.example.test/",
      document,
    ],
    [
      "an IP address",
      { from: site, origins: ["https://192.0.2.10"], document },
      "https://192.0.2.10/",
      document,
    ],
    [
      "one navigation more than the most",
      { from: site, origins: hops(maximumRedirectHops + 1), document },
      `${idp}/password`,
      document,
    ],
    [
      "a navigation that started from another page than the screen it left",
      { from: "https://elsewhere.example.com", origins: chain, document },
      `${idp}/password`,
      document,
    ],
  ] as const)("carries nothing for %s", (_, navigated, url, liveDocument) => {
    expect(
      redirectCandidate({ from, navigated, live: { url, document: liveDocument } }),
    ).toBeUndefined();
  });
});

describe("reportedNavigation", () => {
  const report = (
    options: {
      readonly clicked?: string;
      readonly origins?: readonly string[];
      readonly url?: string;
      readonly title?: string;
      readonly typed?: readonly string[];
    } = {},
  ) =>
    reportedNavigation({
      page: {
        clicked: options.clicked ?? `${from}?step=identify`,
        origins: options.origins ?? chain,
        document,
        ...(options.title === undefined ? {} : { title: options.title }),
      },
      url: options.url ?? `${idp}/password?client=web#top`,
      typed: options.typed ?? ["jane.doe@example.com"],
      trusted: [site],
    });

  it("names where the click left from and went, each path without its query or fragment", () => {
    expect(report({ title: "  Sign in to your account  " })).toEqual({
      from: site,
      fromPathname: "/login",
      origins: chain,
      document,
      pathname: "/password",
      title: "Sign in to your account",
    });
  });

  it.each([
    ["as typed", "https://jane.doe.example.com.example.org", "jane.doe"],
    ["split across a host's labels", "https://ja.ne-d.oe.example.org", "jane.doe"],
    ["with its @ as a dot", "https://jane-doe.example.com.example.org", "jane-doe@example.com"],
    ["in another case", "https://syntheticuser.example.org", "SyntheticUser"],
    ["as an internationalized name's punycode", "https://xn--jos-dma.example.org", "josé"],
  ])("reports nothing when a host of the chain holds a typed value %s", (_, hop, value) => {
    expect(
      report({ origins: [site, hop], url: `${hop}/password`, typed: [value] }),
    ).toBeUndefined();
  });

  it("reports nothing when a host holds a value typed on an earlier screen", () => {
    const hop = "https://synthetic-user.example.org";
    expect(
      report({ origins: [site, hop], url: `${hop}/`, typed: ["synthetic-user", "a-password"] }),
    ).toBeUndefined();
  });

  it.each([
    ["a query parameter", `${from}?next=https://auth.example.org/password`],
    ["a percent-encoded query parameter", `${from}?next=https%3A%2F%2Fauth.example.org%2F`],
    ["a twice-encoded query parameter", `${from}?next=https%253A%252F%252Fauth.example.org`],
    ["a fragment", `${from}#return=auth.example.org`],
    ["its path", `${site}/out/auth.example.org/password`],
    ["an intermediate hop", `${from}?next=https://hop.example.com`],
    ["a fullwidth host", `${from}?next=%EF%BD%81uth.example.org`],
    ["a host with ideographic full stops", `${from}?next=auth%E3%80%82example%E3%80%82org`],
    ["a host with escaped dots", `${from}?next=auth%5C.example%5C.org`],
  ])("reports nothing when the clicked page's own address names a hop in %s", (_, clicked) => {
    expect(report({ clicked, origins: [site, "https://hop.example.com", idp] })).toBeUndefined();
  });

  it("still reports when the clicked page's address names only itself or a trusted origin", () => {
    expect(
      report({ clicked: `${from}?return=https%3A%2F%2Flogin.example.net%2Fhome` }),
    ).toMatchObject({ from: site, origins: chain });
  });

  it("checks a title whole before it cuts it, so a typed value across the cut leaves no piece", () => {
    const value = "synthetic-long-identifier";
    // The value starts 10 code points before the cut, and an astral character sits before it.
    const title = `${"\u{1F512}"}${"x".repeat(titleLimit - 11)} ${value}`;
    expect(report({ title, typed: [value] })).not.toHaveProperty("title");
    const kept = report({ title, typed: ["unrelated-value"] })?.title ?? "";
    expect(Array.from(kept)).toHaveLength(titleLimit);
    expect(kept.startsWith("\u{1F512}")).toBe(true);
  });

  it("leaves out a path or title that holds a typed value, and reports the rest", () => {
    expect(
      report({
        clicked: `${site}/login/jane.doe%40example.com`,
        url: `${idp}/u/jane.doe@example.com`,
        title: "Welcome back, Jane.Doe@example.com",
      }),
    ).toEqual({ from: site, origins: chain, document });
  });
});
