import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getDomain } from "tldts";
import { afterEach, describe, expect, it } from "vitest";
import {
  configureSiteIdentity,
  hostOnSiteSource,
  makeSiteIdentity,
  registrableDomain,
  sameSite,
  siteDomain,
  siteOf,
} from "../../src/runtime/same-site.js";
import { trustedUrl } from "../../src/runtime/sign-in-origins.js";

it.each([
  ["https://flights.example.com", "example.com"],
  ["https://example.com", "example.com"],
  ["https://app.example.co.uk", "example.co.uk"],
  // A private suffix keeps each user's page its own site.
  ["https://alice.github.io", "alice.github.io"],
  // A private suffix that tldts 7.4.16 added. Older suffix data made glideos.app the site.
  ["https://alice.glideos.app", "alice.glideos.app"],
  ["https://flights.site.invalid", "site.invalid"],
])("the site of %s is %s", (origin, domain) => {
  expect(siteDomain(origin)).toBe(domain);
  expect(sameSite(origin, new URL(`https://www.${domain}/travel`))).toBe(true);
  expect(sameSite(origin, new URL(`https://login.${domain}/`))).toBe(true);
  expect(sameSite(origin, new URL(`http://www.${domain}/`))).toBe(false);
});

it.each([
  "http://flights.example.com",
  "https://flights.example.com/travel",
  "https://127.0.0.1",
  "https://[::1]",
  "https://localhost",
  "https://github.io",
  "not a url",
])("%s names no site beyond its exact origin", (origin) => {
  expect(siteDomain(origin)).toBeUndefined();
});

it("keeps other users' pages on a private suffix apart", () => {
  expect(sameSite("https://alice.github.io", new URL("https://bob.github.io/"))).toBe(false);
  expect(sameSite("https://alice.glideos.app", new URL("https://bob.glideos.app/"))).toBe(false);
  expect(sameSite("https://alice.glideos.app", new URL("https://x.alice.glideos.app/"))).toBe(true);
  expect(sameSite("https://flights.example.com", new URL("https://example.org/"))).toBe(false);
});

// A host's own private suffixes (`configureSiteIdentity`) make each label below one its own site,
// the way the public list keeps each user's page on github.io apart.
describe("a host's added private suffixes", () => {
  afterEach(() => {
    configureSiteIdentity({});
  });

  it("keeps two subdomains under an added suffix apart, and each one's own subdomains with it", () => {
    configureSiteIdentity({ privateSuffixes: ["apps.example.test"] });
    expect(siteDomain("https://alpha.apps.example.test")).toBe("alpha.apps.example.test");
    expect(siteOf("beta.apps.example.test")).toBe("beta.apps.example.test");
    expect(siteOf(new URL("https://www.beta.apps.example.test/a"))).toBe("beta.apps.example.test");
    expect(
      sameSite("https://alpha.apps.example.test", new URL("https://beta.apps.example.test/")),
    ).toBe(false);
    expect(
      sameSite("https://alpha.apps.example.test", new URL("https://login.alpha.apps.example.test/")),
    ).toBe(true);
    // The parent domain stays one site with its other subdomains, apart from those under the suffix.
    expect(sameSite("https://example.test", new URL("https://www.example.test/"))).toBe(true);
    expect(sameSite("https://example.test", new URL("https://alpha.apps.example.test/"))).toBe(
      false,
    );
    // The suffix itself, like a bare public suffix, names no site beyond its own host.
    expect(siteDomain("https://apps.example.test")).toBeUndefined();
    expect(siteOf("apps.example.test")).toBe("apps.example.test");
  });

  it("matches hosts as the public list's lookup does: any case, trailing dots ignored", () => {
    configureSiteIdentity({ privateSuffixes: ["apps.example.test"] });
    expect(registrableDomain("WWW.Alpha.Apps.Example.Test.")).toBe("alpha.apps.example.test");
    expect(registrableDomain("apps.example.test.")).toBeUndefined();
  });

  it("reads a URL or host:port as the public list does, and no host name as no site", () => {
    configureSiteIdentity({ privateSuffixes: ["apps.example.test"] });
    expect(registrableDomain("alpha.apps.example.test:8443")).toBe("alpha.apps.example.test");
    expect(registrableDomain("https://alpha.apps.example.test/p")).toBe("alpha.apps.example.test");
    expect(registrableDomain("https://alpha.apps.example.test")).toBe("alpha.apps.example.test");
    expect(registrableDomain(".apps.example.test")).toBeUndefined();
    expect(registrableDomain(".alpha.apps.example.test")).toBeUndefined();
    expect(siteOf(".apps.example.test")).not.toBe("example.test");
  });

  it("takes the longest suffix, added or listed", () => {
    configureSiteIdentity({ privateSuffixes: ["apps.example.test", "eu.apps.example.test"] });
    expect(siteOf("alpha.eu.apps.example.test")).toBe("alpha.eu.apps.example.test");
    expect(siteOf("alpha.us.apps.example.test")).toBe("us.apps.example.test");
    // An added suffix below a listed private one still splits it further.
    configureSiteIdentity({ privateSuffixes: ["pages.alice.github.io"] });
    expect(siteOf("x.pages.alice.github.io")).toBe("x.pages.alice.github.io");
    expect(siteOf("www.alice.github.io")).toBe("alice.github.io");
    expect(siteOf("bob.github.io")).toBe("bob.github.io");
  });

  it("builds page code that agrees with sameSite", () => {
    configureSiteIdentity({ privateSuffixes: ["apps.example.test"] });
    const onParent = eval(hostOnSiteSource("example.test")) as (host: string) => boolean;
    expect(onParent("example.test")).toBe(true);
    expect(onParent("www.example.test")).toBe(true);
    expect(onParent("apps.example.test")).toBe(false);
    expect(onParent("alpha.apps.example.test")).toBe(false);
    expect(onParent("notexample.test")).toBe(false);
    const onAlpha = eval(hostOnSiteSource("alpha.apps.example.test")) as (host: string) => boolean;
    expect(onAlpha("login.alpha.apps.example.test")).toBe(true);
    expect(onAlpha("beta.apps.example.test")).toBe(false);
  });

  it("is an explicit value too, apart from the process's identity", () => {
    const identity = makeSiteIdentity({ privateSuffixes: ["apps.example.test"] });
    expect(identity.siteOf("alpha.apps.example.test")).toBe("alpha.apps.example.test");
    expect(siteOf("alpha.apps.example.test")).toBe("example.test");
  });

  it.each([
    ["com", "public_suffix"],
    ["co.uk", "public_suffix"],
    ["github.io", "public_suffix"],
    ["test", "public_suffix"],
    ["", "empty"],
    [" ", "invalid"],
    ["apps.example.test ", "invalid"],
    ["Apps.Example.Test", "invalid"],
    ["*.example.test", "invalid"],
    [".apps.example.test", "invalid"],
    ["apps.example.test.", "invalid"],
    ["apps..example.test", "invalid"],
    ["https://apps.example.test", "invalid"],
    ["apps.example.test:443", "invalid"],
    ["apps.example.test/path", "invalid"],
    ["-apps.example.test", "invalid"],
    ["192.0.2.1", "invalid"],
    ["localhost", "public_suffix"],
  ])("refuses %j as an added private suffix (%s)", (entry, reason) => {
    configureSiteIdentity({ privateSuffixes: ["apps.example.test"] });
    expect(() => configureSiteIdentity({ privateSuffixes: [entry] })).toThrow(
      expect.objectContaining({ _tag: "InvalidPrivateSuffix", entry, reason }),
    );
    // A refused list leaves the identity in force unchanged.
    expect(siteOf("alpha.apps.example.test")).toBe("alpha.apps.example.test");
  });

  it("refuses an entry that is not a string", () => {
    expect(() =>
      makeSiteIdentity({ privateSuffixes: [undefined as unknown as string] }),
    ).toThrow(expect.objectContaining({ reason: "empty" }));
  });
});

// With no added suffix, every result is the public list's alone, as before the module took a list.
it.each([
  "www.example.com",
  "example.co.uk",
  "a.b.example.co.uk",
  "alice.github.io",
  "github.io",
  "com",
  "localhost",
  "127.0.0.1",
  "[::1]",
  "foo.bar.ck",
  "www.ck",
  "x.a.apps.example.test",
  "WWW.Example.COM.",
  "not a host",
  "",
])("reads %j exactly as the public list does with no added suffix", (host) => {
  const listed = getDomain(host, { allowPrivateDomains: true });
  expect(registrableDomain(host)).toBe(listed ?? undefined);
  expect(siteOf(host)).toBe(listed ?? host);
  expect(makeSiteIdentity({ privateSuffixes: [] }).siteOf(host)).toBe(listed ?? host);
});

// Exact origins stay origins: a configured sign-in origin or the site's own exact origin is
// trusted by origin, whatever the site identity, and an added suffix never widens or narrows it.
it("leaves exact origin checks unchanged under an added suffix", () => {
  const check = () => ({
    configuredOrigin: trustedUrl(
      "https://alpha.apps.example.test",
      ["https://beta.apps.example.test"],
      "https://beta.apps.example.test/sign-in",
    ),
    // Another port of a configured origin on another site is another origin.
    otherPort: trustedUrl(
      "https://alpha.apps.example.test",
      ["https://login.example.net"],
      "https://login.example.net:8443/sign-in",
    ),
    ownOrigin: trustedUrl("https://alpha.apps.example.test", [], "https://alpha.apps.example.test/"),
    plainHttp: trustedUrl("https://alpha.apps.example.test", [], "http://alpha.apps.example.test/"),
  });
  const before = check();
  configureSiteIdentity({ privateSuffixes: ["apps.example.test"] });
  try {
    expect(check()).toEqual(before);
    expect(before).toEqual({
      configuredOrigin: true,
      otherPort: false,
      ownOrigin: true,
      plainHttp: false,
    });
  } finally {
    configureSiteIdentity({});
  }
});

const root = fileURLToPath(new URL("../../../", import.meta.url));
const sourceFiles = () =>
  execFileSync("git", ["ls-files", "typescript/src"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((path) => /\.(?:[cm]?[jt]s)$/u.test(path))
    .map((path) => ({ path, source: readFileSync(`${root}${path}`, "utf8") }));

// Site identity has one home, so a host's added suffixes reach every check.
it("computes site identity only in the same-site module", () => {
  const module = "typescript/src/runtime/same-site.ts";
  // Shipped page code a script runs in its own sandbox, with no suffix list: it matches the
  // siteDomain the host computed here and passed in, and guesses only when given none.
  const sandboxed = new Set(["typescript/src/browser/wait.ts", "typescript/src/browser/picker.ts"]);
  const suffixList = /\bfrom\s+["']tldts["']|\brequire\(\s*["']tldts["']\s*\)|\bimport\(\s*["']tldts["']\s*\)/u;
  const hostSuffixCheck = /\.endsWith\(\s*(?:["']\.["']\s*\+|`\.\$\{)/u;
  const offenders = sourceFiles().filter(
    ({ path, source }) =>
      path !== module &&
      (suffixList.test(source) || (!sandboxed.has(path) && hostSuffixCheck.test(source))),
  );
  expect(offenders.map(({ path }) => path)).toEqual([]);
});
