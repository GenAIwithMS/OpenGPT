import { describe, expect, it } from "vitest";
import {
  admitScreenOrigin,
  entryNamesAddress,
  signedInCheckOrigin,
  workspaceHost,
  workspaceRelation,
  workspaceToPin,
  type ScreenOriginContext,
} from "../../src/runtime/workspace-origin.js";

const site = "https://app.example.com";
const parent = "example.com";

describe("workspaceHost", () => {
  it.each([
    "https://acme.example.com",
    "https://globex.example.com",
    "https://a.b.example.com",
    // An internationalized host in its canonical punycode form.
    "https://xn--bcher-kva.example.com",
    // The URL parser keeps a trailing dot, and the public suffix list reads the same domain.
    "https://acme.example.com.",
    // The apex is another host on the site's registrable domain.
    "https://example.com",
  ])("accepts the same-site sibling %s", (candidate) => {
    expect(workspaceHost(site, parent, candidate)).toBe(true);
  });

  it("accepts a sibling of a site whose host is its registrable domain", () => {
    expect(workspaceHost("https://example.com", parent, "https://acme.example.com")).toBe(true);
  });

  it("accepts a sibling on the port of a site on a non-default port, and no other port", () => {
    const portSite = "https://app.example.com:8443";
    expect(workspaceHost(portSite, parent, "https://acme.example.com:8443")).toBe(true);
    expect(workspaceHost(portSite, parent, "https://acme.example.com")).toBe(false);
    expect(workspaceHost(portSite, parent, "https://acme.example.com:9443")).toBe(false);
  });

  it.each([
    ["the site's own host", site, site, parent],
    ["an http origin", site, "http://acme.example.com", parent],
    ["an origin with user info", site, "https://user@acme.example.com", parent],
    ["an origin with a path", site, "https://acme.example.com/login", parent],
    ["a trailing slash", site, "https://acme.example.com/", parent],
    ["another registrable domain", site, "https://acme.example.org", parent],
    ["a look-alike domain", site, "https://acme.notexample.com", parent],
    ["another user's page on a private suffix", "https://a.github.io", "https://b.github.io", "a.github.io"],
    ["a site whose host is a bare suffix", "https://github.io", "https://b.github.io", "github.io"],
    ["a parent that is not the site's", site, "https://acme.example.com", "example.org"],
    ["a parent that is a suffix of the site's", site, "https://acme.example.com", "com"],
    ["text that is not an origin", site, "acme.example.com", parent],
    // The parser writes a unicode host as punycode, so the text is not its exact origin.
    ["a raw unicode host", site, "https://bücher.example.com", parent],
    ["the site's own host on another port", site, "https://app.example.com:8443", parent],
    ["a sibling with an explicit port", site, "https://acme.example.com:8443", parent],
  ])("refuses %s", (_case, siteOrigin, candidate, relationParent) => {
    expect(workspaceHost(siteOrigin, relationParent, candidate)).toBe(false);
  });
});

describe("a recipe's workspace relation for its site", () => {
  it("keeps a workspace relation only on the site's own registrable domain", () => {
    expect(workspaceRelation({ version: 4, workspace: { parent } }, site)).toEqual({ parent });
    expect(workspaceRelation({ version: 4, workspace: { parent: "example.org" } }, site)).toBeUndefined();
    expect(workspaceRelation({ version: 4, workspace: { parent: "github.io" } }, "https://github.io")).toBeUndefined();
    expect(workspaceRelation({ version: 1 }, site)).toBeUndefined();
  });
});

describe("admitScreenOrigin", () => {
  const relation = { parent };
  const context = (overrides: Partial<ScreenOriginContext> = {}): ScreenOriginContext => ({
    siteOrigin: site,
    relation,
    pinned: undefined,
    candidate: undefined,
    identifierSent: false,
    ...overrides,
  });
  const shared = { page: `${site}/login` };
  const workspace = { origin: "workspace" as const, page: "/login/password" };

  it("admits an exact screen on its own origin, or on the login's pinned workspace", () => {
    expect(admitScreenOrigin(context(), shared, site)).toEqual({ admitted: true });
    expect(
      admitScreenOrigin(context({ pinned: "https://acme.example.com" }), shared, "https://acme.example.com"),
    ).toEqual({ admitted: true });
  });

  it("refuses a workspace host on an exact screen when no workspace is pinned", () => {
    expect(admitScreenOrigin(context(), shared, "https://evil.example.com")).toEqual({
      admitted: false,
      reason: "workspace_unverified",
      sibling: true,
    });
    expect(admitScreenOrigin(context({ relation: undefined }), shared, "https://evil.example.com")).toEqual(
      { admitted: false, reason: "screen_origin_changed", sibling: true },
    );
  });

  it("refuses another workspace than the pinned one as unverified until the identifier went out", () => {
    // Before this login sent anything, another workspace may be one the site remembers: the run
    // clears and replays once. After its identifier went out, the recorded screen moved.
    const pinned = context({ pinned: "https://acme.example.com" });
    expect(admitScreenOrigin(pinned, shared, "https://evil.example.com")).toEqual({
      admitted: false,
      reason: "workspace_unverified",
      sibling: true,
    });
    expect(
      admitScreenOrigin({ ...pinned, identifierSent: true }, shared, "https://evil.example.com"),
    ).toEqual({ admitted: false, reason: "screen_origin_changed", sibling: true });
  });

  it("learns a workspace host only after the identifier went out on an exact screen", () => {
    expect(
      admitScreenOrigin(context({ identifierSent: true }), workspace, "https://acme.example.com"),
    ).toEqual({ admitted: true, learned: "https://acme.example.com" });
    expect(admitScreenOrigin(context(), workspace, "https://acme.example.com")).toEqual({
      admitted: false,
      reason: "workspace_unverified",
      sibling: true,
    });
    expect(
      admitScreenOrigin(context({ candidate: "https://acme.example.com" }), workspace, "https://acme.example.com"),
    ).toEqual({ admitted: true });
  });

  it("learns at most one workspace host per replay", () => {
    const learned = context({ identifierSent: true, candidate: "https://acme.example.com" });
    expect(admitScreenOrigin(learned, workspace, "https://globex.example.com")).toEqual({
      admitted: false,
      reason: "workspace_unverified",
      sibling: true,
    });
  });

  it("refuses a workspace screen without a valid relation, and off the site", () => {
    expect(
      admitScreenOrigin(
        context({ relation: undefined, identifierSent: true }),
        workspace,
        "https://acme.example.com",
      ),
    ).toMatchObject({ admitted: false, reason: "screen_origin_changed" });
    expect(
      admitScreenOrigin(context({ identifierSent: true }), workspace, "https://acme.example.org"),
    ).toEqual({ admitted: false, reason: "screen_origin_changed", sibling: false });
  });
});

describe("signedInCheckOrigin", () => {
  const base = {
    siteOrigin: site,
    relation: { parent },
    pinned: undefined,
    candidate: undefined,
    current: undefined,
    credentialsSent: false,
  };

  it("opens the account page where this login's workspace is", () => {
    expect(signedInCheckOrigin({ ...base, relation: undefined, current: "https://acme.example.com" })).toBe(site);
    expect(signedInCheckOrigin({ ...base, candidate: "https://acme.example.com" })).toBe(
      "https://acme.example.com",
    );
    expect(signedInCheckOrigin({ ...base, current: "https://acme.example.com" })).toBe(
      "https://acme.example.com",
    );
    // Another workspace than the pinned one counts only after this replay sent the credentials.
    const pinned = { ...base, pinned: "https://acme.example.com", current: "https://globex.example.com" };
    expect(signedInCheckOrigin(pinned)).toBe("https://acme.example.com");
    expect(signedInCheckOrigin({ ...pinned, credentialsSent: true })).toBe("https://globex.example.com");
    expect(signedInCheckOrigin(base)).toBe(site);
  });

  it("pins only a workspace host this login's own sign-in explains", () => {
    const acme = "https://acme.example.com";
    const globex = "https://globex.example.com";
    expect(workspaceToPin({ ...base, candidate: acme })).toBe(acme);
    expect(workspaceToPin({ ...base, pinned: acme, current: acme })).toBe(acme);
    expect(workspaceToPin({ ...base, pinned: acme, current: globex, credentialsSent: true })).toBe(globex);
    expect(workspaceToPin({ ...base, current: acme, credentialsSent: true })).toBe(acme);
    // A session that merely shows an unpinned workspace host runs its check there, never pins it.
    expect(signedInCheckOrigin({ ...base, current: acme })).toBe(acme);
    expect(workspaceToPin({ ...base, current: acme })).toBeUndefined();
    expect(workspaceToPin({ ...base, current: site, credentialsSent: true })).toBeUndefined();
    expect(workspaceToPin({ ...base, relation: undefined, candidate: acme })).toBeUndefined();
  });
});

describe("entryNamesAddress", () => {
  it.each([
    `${site}/login`,
    `${site}/login?lang=en&step=1`,
    `${site}/login?next=%2Fhome`,
    `${site}/login#password`,
    // A host on another domain that is not an address the site could follow.
    `${site}/login?ref=newsletter`,
    `${site}/signin/identifier`,
    `${site}/u/login/identifier?state=abc123`,
  ])("lets %s open", (url) => {
    expect(entryNamesAddress(url, parent)).toBe(false);
  });

  it.each([
    `${site}/login?next=https://evil.example.com/login`,
    `${site}/login?next=//evil.example.net`,
    `${site}/login?next=https%3A%2F%2Fevil.example.net`,
    `${site}/login?next=https%25253A%25252F%25252Fevil.example.net`,
    `${site}/login?next=%5Cevil.example.net`,
    `${site}/login?tenant=evil.example.com`,
    `${site}/login?tenant=EVIL.Example.COM`,
    `${site}/login#next=acme.example.com`,
    `${site}/login?next=example.com`,
    // An address in the path, or written with another full stop.
    `${site}/r/evil.example.com/login`,
    `${site}/r/https%3A%2F%2Fevil.example.net/login`,
    `${site}/login?tenant=evil\u3002example\u3002com`,
    `${site}/login?tenant=evil\uFF0Eexample\uFF0Ecom`,
    `${site}/login?tenant=evil\uFF61example\uFF61com`,
    // Fullwidth letters a URL parser would read as ASCII.
    `${site}/login?next=\uFF45\uFF56\uFF49\uFF4C\uFF0E\uFF45\uFF58\uFF41\uFF4D\uFF50\uFF4C\uFF45\uFF0E\uFF43\uFF4F\uFF4D`,
    // More layers of encoding than a host reads through, or text that does not decode.
    `${site}/login?next=%2525252525252F`,
    `${site}/login?next=%E0%A4%A`,
    "not a url",
  ])("refuses %s", (url) => {
    expect(entryNamesAddress(url, parent)).toBe(true);
  });
});
