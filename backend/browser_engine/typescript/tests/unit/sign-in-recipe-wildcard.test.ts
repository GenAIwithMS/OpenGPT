// Failure modes covered: a later sign-in screen whose path holds a per-account segment, such as
// `/team/<team>/password`, publishes that segment, or a recipe that writes it as `*` matches no
// live page; a recipe without such a segment changes version or bytes; a host that predates
// version 7 replays one; a `*` that is not listed, a listed segment that is not `*` or is empty, a
// page with no literal segment left, a list on the first screen or a `*` in a marker path the host
// opens, written with or without a leading slash, decodes; a listed place takes an empty segment,
// another origin, another segment count or another unlisted segment; a writer puts the list
// anywhere but beside the page, or writes an empty list as version 7.
import { createHash } from "node:crypto";
import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  DismissAutofillRecipe,
  KeySubmitAutofillRecipe,
  LegacyAutofillRecipe,
  PopupAutofillRecipe,
  WorkspaceAutofillRecipe,
  pageMatches,
  pathMatches,
  autofillRecipe,
} from "../../src/destinations/autofill-recipe.js";
import {
  decodeSignInRecipe,
  signInRecipe,
  signInRecipeText,
} from "../../src/destinations/sign-in-recipe.js";
import { exactScreens } from "../../src/runtime/autofill-replay-screens.js";
import { sessionOnPage } from "../../src/runtime/session-sign-in.js";

const site = "https://portal.example.test";
const identifier = {
  page: `${site}/login`,
  fields: [{ selector: "#user", accepts: ["username"] }],
  submit: "#next",
} as const;
const password = {
  page: `${site}/team/*/password`,
  anySegments: [1],
  fields: [{ selector: "#password", slot: "password" }],
  submit: "#sign-in",
} as const;
const signedIn = { selector: "#account" };
const recipe = { version: 7, steps: [identifier, password], signedIn } as const;

describe("version 7", () => {
  it.each([
    ["a step whose page lists a segment", recipe],
    [
      "a workspace step that lists a segment",
      {
        version: 7,
        workspace: { parent: "example.test" },
        steps: [identifier, { origin: "workspace", ...password, page: "/team/*/password" }],
        signedIn,
      },
    ],
    [
      "a step whose first segment is listed beside a literal one",
      { ...recipe, steps: [identifier, { ...password, page: `${site}/*/password`, anySegments: [0] }] },
    ],
  ])("reads %s and writes it back byte for byte", (_name, value) => {
    const text = JSON.stringify(value, null, 2);
    const decoded = decodeSignInRecipe(text);
    expect(decoded).toEqual(JSON.parse(text));
    if (typeof decoded === "string") throw new Error(decoded);
    expect(signInRecipeText(decoded)).toBe(text);
  });

  it("is refused by a host that knows versions 1 to 6 only, and a version 6 step that lists a segment is refused", () => {
    const olderHost = Schema.Union(
      LegacyAutofillRecipe,
      PopupAutofillRecipe,
      WorkspaceAutofillRecipe,
      KeySubmitAutofillRecipe,
      DismissAutofillRecipe,
    );
    expect(Either.isLeft(Schema.decodeUnknownEither(olderHost)(recipe))).toBe(true);
    expect(decodeSignInRecipe(JSON.stringify({ ...recipe, version: 6 }))).toBe("invalid");
    expect(decodeSignInRecipe(JSON.stringify({ ...recipe, version: 9 }))).toBe("unknown_version");
  });

  it.each([
    ["a * segment it does not list", { ...recipe, steps: [identifier, { ...password, anySegments: undefined }] }],
    ["a listed segment that is no *", { ...recipe, steps: [identifier, { ...password, page: `${site}/team/a/password` }] }],
    ["a listed segment that is empty", { ...recipe, steps: [identifier, { ...password, page: `${site}/team//password` }] }],
    [
      "a list out of order",
      { ...recipe, steps: [identifier, { ...password, page: `${site}/*/*/password`, anySegments: [1, 0] }] },
    ],
    ["an empty list", { ...recipe, steps: [identifier, { ...password, page: `${site}/team/a/password`, anySegments: [] }] }],
    [
      "a list on the first screen, the page a run starts from",
      { ...recipe, steps: [{ ...identifier, page: `${site}/*/login`, anySegments: [0] }, password] },
    ],
    ["a * in the account page the host opens", { ...recipe, signedIn: { ...signedIn, openPath: "/team/*/home" } }],
    ["a * in the marker's path, which the host opens", { ...recipe, signedIn: { urlPath: "/team/*/home" } }],
    ["a * first in an account page with no leading slash", { ...recipe, signedIn: { ...signedIn, openPath: "*/home" } }],
    ["a * first in a marker path with no leading slash", { ...recipe, signedIn: { urlPath: "*/home" } }],
    ["a page whose only segment is listed", { ...recipe, steps: [identifier, { ...password, page: `${site}/*`, anySegments: [0] }] }],
    [
      "a page whose every segment is listed",
      { ...recipe, steps: [identifier, { ...password, page: `${site}/*/*`, anySegments: [0, 1] }] },
    ],
    ["a page whose other segment is empty", { ...recipe, steps: [identifier, { ...password, page: `${site}/*/`, anySegments: [0] }] }],
    ["a marker that lists segments", { ...recipe, signedIn: { urlPath: "/team/a/home", urlPathAnySegments: [1] } }],
  ])("refuses %s", (_name, value) => {
    expect(decodeSignInRecipe(JSON.stringify(value))).toBe("invalid");
  });
});

describe("signInRecipe", () => {
  const recordedIdentifier = {
    page: `${site}/login`,
    fields: [{ selector: "#user", slot: "username" as const, accepts: ["username"] as const }],
    submit: "#next",
  };
  const recordedPassword = {
    page: `${site}/team/a/password`,
    fields: [{ selector: "#password", slot: "password" as const }],
    submit: "#sign-in",
  };

  it("writes version 7 only when a step lists a segment, the list beside its page, in the bytes every host writes", () => {
    expect(signInRecipe([recordedIdentifier, recordedPassword], signedIn).version).toBe(1);
    const dismissed = { ...recordedIdentifier, dismiss: "#accept" };
    expect(signInRecipe([dismissed, recordedPassword], signedIn).version).toBe(6);
    const listed = { ...recordedPassword, page: `${site}/team/*/password`, anySegments: [1] };
    // A host that writes the recipe as `autofillRecipe` returns it writes the same bytes.
    const written = autofillRecipe([dismissed, listed], signedIn, {});
    expect(written.version).toBe(7);
    expect(Object.keys(written.steps[1] ?? {})).toEqual(["page", "anySegments", "fields", "submit"]);
    const text = signInRecipeText(signInRecipe([dismissed, listed], signedIn));
    expect(JSON.stringify(written, null, 2)).toBe(text);
    expect(decodeSignInRecipe(text)).toEqual(written);
  });

  it("writes an empty list as no list, in the version the recipe needs without it", () => {
    const empty = { ...recordedPassword, anySegments: [] };
    const written = autofillRecipe([recordedIdentifier, empty], signedIn, {});
    expect(written.version).toBe(1);
    expect(Object.keys(written.steps[1] ?? {})).toEqual(["page", "fields", "submit"]);
    expect(decodeSignInRecipe(signInRecipeText(signInRecipe([recordedIdentifier, empty], signedIn)))).toEqual(
      written,
    );
    const listed = { ...recordedPassword, page: `${site}/team/*/password`, anySegments: [1] };
    const mixed = signInRecipe([recordedIdentifier, empty, listed], signedIn);
    expect(mixed.version).toBe(7);
    expect(Object.keys(mixed.steps[1] ?? {})).toEqual(["page", "fields", "submit"]);
    expect(decodeSignInRecipe(signInRecipeText(mixed))).toEqual(mixed);
  });

  // sha256 of each recipe's text as version 6's host wrote it, before version 7.
  const id = {
    page: "https://example.test/login",
    fields: [
      { selector: "#user", slot: "email" as const, accepts: ["username", "email"] as const },
    ],
    submit: "#next",
    submittedBy: "host" as const,
  };
  const pw = {
    page: "https://example.test/login/password",
    fields: [{ selector: "#password", slot: "password" as const }],
    submit: "#sign-in",
  };
  const workspaceStep = { ...pw, origin: "workspace" as const, page: "/team/a/password" };
  const code = {
    page: "https://example.test/login/code",
    fields: [{ selector: "#code", slot: "code" as const }],
    submitKey: "Enter" as const,
  };
  const approval = { page: "https://example.test/login", fields: [], approval: "device" as const };
  const marker = { selector: "#account", urlPath: "/team/a/home", openPath: "/account" };
  const relation = { workspace: { parent: "example.test" } };
  it.each([
    [1, signInRecipe([id, pw], marker), "8186c707e2438c9df5a12a0c7a4a32f9cb876fcd792cc4a8f50574bd7de88395"],
    [2, signInRecipe([id, approval], signedIn), "0172321696a367f94ef7c75b012841fb09062efe1b9380560c94013253d4af0b"],
    [4, signInRecipe([id, workspaceStep], marker, relation), "d80128b85dc453ab19c3228fa16f0a3278b7d71eac4251e4e03219d05a837c50"],
    [5, signInRecipe([id, pw, code], { urlPath: "/home" }), "bf860cd29cb4584290ddab2274ed4db1db330a4cc4393d6c588ecdfa11a02206"],
    [
      6,
      signInRecipe([{ ...id, dismiss: "#consent-accept" }, pw], marker, relation),
      "f4de59fdae7c5189d1a6787f6f361b2796da611f4ec4d57492e5380647265b50",
    ],
  ])("keeps a version %i recipe's version and bytes", (version, written, sha256) => {
    expect(written.version).toBe(version);
    const text = signInRecipeText(written);
    expect(createHash("sha256").update(text, "utf8").digest("hex")).toBe(sha256);
    const decoded = decodeSignInRecipe(text);
    if (typeof decoded === "string") throw new Error(decoded);
    expect(signInRecipeText(decoded)).toBe(text);
  });
});

describe("pathMatches and pageMatches", () => {
  it("takes any one non-empty segment at a listed place, on the same origin, with as many segments and every other the same", () => {
    expect(pageMatches(`${site}/team/b/password`, password)).toBe(true);
    expect(pageMatches(`${site}/team/b/password/`, password)).toBe(true);
    expect(pageMatches("https://other.example.test/team/b/password", password)).toBe(false);
    expect(pageMatches(`${site}/team/b/c/password`, password)).toBe(false);
    expect(pageMatches(`${site}/team/password`, password)).toBe(false);
    expect(pageMatches(`${site}/team//password`, password)).toBe(false);
    expect(pageMatches(`${site}/group/b/password`, password)).toBe(false);
    expect(pageMatches(`${site}/team/b/code`, password)).toBe(false);
  });

  it("compares every segment as written without a list, a * included", () => {
    const literal = { page: `${site}/team/*/password` };
    expect(pageMatches(`${site}/team/b/password`, literal)).toBe(false);
    expect(pageMatches(`${site}/team/*/password`, literal)).toBe(true);
    expect(pageMatches(`${site}/team/b/password`, { page: `${site}/team/b/password` })).toBe(true);
    expect(pageMatches("/team/b/password", { page: "/team/b/password" })).toBe(false);
  });

  it("drops a trailing slash but the root's, as recorded screens compare paths", () => {
    expect(pathMatches("/team/b/password/", "/team/*/password", [1])).toBe(true);
    expect(pathMatches("/team/b/password", "/team/*/password/", [1])).toBe(true);
    expect(pathMatches("/", "/")).toBe(true);
    expect(pathMatches("/a", "/")).toBe(false);
  });
});

describe("where a recorded screen's page meets the live page", () => {
  const steps = [identifier, password];
  const off = { signedIn: false, failed: "indicator_not_visible" } as const;

  it("reads a page with any team in the listed place as the recorded screen", () => {
    expect(exactScreens(steps).onScreens(`${site}/team/b/password`)).toBe(true);
    expect(exactScreens(steps).onScreens("https://other.example.test/team/b/password")).toBe(false);
    const noPath = { steps, signedIn: {} };
    expect(sessionOnPage({ ...off, url: `${site}/team/b/password` }, noPath)).toBe("signed_out");
    expect(sessionOnPage({ ...off, url: `${site}/team/b/account` }, noPath)).toBe("unknown");
  });
});
