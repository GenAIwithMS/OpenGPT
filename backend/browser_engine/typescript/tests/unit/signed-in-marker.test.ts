import { describe, expect, it } from "vitest";
import {
  evaluateSignedInMarker,
  generatedClassWarning,
  loginPathRefusal,
  matchSignedOutSnapshots,
  signedOutMatchRefusal,
  validateSignedInMarker,
} from "../../src/destinations/signed-in-marker.js";

/** A signed-out page as an explore checkpoint keeps it: the serialized, masked document. */
const signedOutHome = {
  url: "https://shop.example.test/",
  dom: `<!doctype html>
<html><head><title>Example shop</title><style>.promo { color: red; }</style>
<script>window.account = "<a class='account'>Account</a>";</script></head>
<body><header class="site-header"><a href="/sign-in">Account</a>
<nav aria-label="Main"><a href="/catalog">Catalog</a></nav>
<div class="css-1q2w3e"><span>Help</span></div>
<button aria-label="Account menu" hidden="">Menu</button>
<div style="display: none"><a data-testid="sign-out" href="/sign-out">Sign out</a></div>
<template><a class="account-menu" href="/account">Your account</a></template>
</header><main><p>Welcome &amp; browse</p></main></body></html>`,
};
const signedOutLogin = {
  url: "https://shop.example.test/sign-in",
  dom: `<!doctype html><html><head></head><body><header class="site-header"><a href="/sign-in">Account</a></header>
<form action="/sign-in" method="post"><label>Email <input type="email" name="email" value="[masked]"></label>
<input type="password" name="password" value="[masked]"><button type="submit">Sign in</button></form></body></html>`,
};
const signedOut = [signedOutHome, signedOutLogin];
const passed = { signedIn: true, url: "https://shop.example.test/account" } as const;
const failed = { signedIn: false, failed: "indicator_not_visible" } as const;

describe("matchSignedOutSnapshots", () => {
  it("finds a marker the signed-out page shows", () => {
    for (const selector of [
      "text=Account",
      'a:has-text("Account")',
      "header.site-header a",
      'role=link[name="account"]',
    ])
      expect(matchSignedOutSnapshots({ selector }, signedOut), selector).toBe("matches");
  });

  // Playwright reads a role name's `i` or `s` flag after a space too, and in either case.
  it("reads a role name's case flag written after a space or in capitals", () => {
    for (const selector of [
      'role=link[name="account" i]',
      'role=link[name="Account" s]',
      'role=link[name="account"I]',
      'role=link[name="Account" S]',
    ])
      expect(matchSignedOutSnapshots({ selector }, signedOut), selector).toBe("matches");
  });

  it("does not count what the signed-out page hides or never renders", () => {
    for (const selector of [
      '[aria-label="Account menu"]',
      '[data-testid="sign-out"]',
      "data-testid=sign-out",
      "text=Sign out",
      ".account-menu",
      "a.account",
      "text=Your account",
    ])
      expect(matchSignedOutSnapshots({ selector }, signedOut), selector).toBe("absent");
  });

  it("matches a path alone against the signed-out page's path", () => {
    expect(matchSignedOutSnapshots({ urlPath: "/sign-in" }, signedOut)).toBe("matches");
    expect(matchSignedOutSnapshots({ urlPath: "/account" }, signedOut)).toBe("absent");
    // Both parts must show on the same page.
    expect(matchSignedOutSnapshots({ selector: "nav", urlPath: "/sign-in" }, signedOut)).toBe(
      "absent",
    );
  });

  it("leaves a selector it cannot read, or a missing snapshot, unchecked", () => {
    expect(matchSignedOutSnapshots({ selector: "xpath=//a" }, signedOut)).toBe("unchecked");
    expect(matchSignedOutSnapshots({ selector: "header >> text=Account" }, signedOut)).toBe(
      "unchecked",
    );
    expect(matchSignedOutSnapshots({ selector: "header" }, [])).toBe("unchecked");
  });
});

describe("role names on the signed-out page", () => {
  /** One signed-out page with this body. */
  const page = (body: string) => [
    {
      url: "https://shop.example.test/",
      dom: `<!doctype html><html><head></head><body>${body}</body></html>`,
    },
  ];
  const match = (selector: string, body: string) =>
    matchSignedOutSnapshots({ selector }, page(body));

  it("builds a name from the content's own text alternatives", () => {
    for (const [selector, body] of [
      ['role=link[name="Account"]', '<a href="/sign-in"><img alt="Account"></a>'],
      ['role=button[name="Account"]', '<button><svg aria-label="Account"></svg></button>'],
      [
        'role=button[name="Account"]',
        "<button><svg><title>Account</title><path></path></svg></button>",
      ],
      [
        'role=button[name="Account menu"]',
        '<button><span aria-label="Account menu"></span></button>',
      ],
      [
        'role=link[name="Your account"s]',
        '<a href="/account"><span>Your</span> <b>account</b></a>',
      ],
    ] as const)
      expect(match(selector, body), body).toBe("matches");
  });

  it("reads a title only when nothing else names the element", () => {
    for (const [selector, body] of [
      ['role=link[name="Account"s]', '<a href="/sign-in" title="Sign in here">Account</a>'],
      ['role=button[name="Account"s]', '<button title="Open menu">Account</button>'],
      [
        'role=button[name="Open menu"s]',
        '<button title="Open menu"><span class="icon"></span></button>',
      ],
      ['role=navigation[name="Account"s]', '<nav title="Account"><a href="/a">Home</a></nav>'],
    ] as const)
      expect(match(selector, body), body).toBe("matches");
    expect(
      match('role=navigation[name="Account"]', '<nav aria-label="Main" title="Account"></nav>'),
    ).toBe("absent");
  });

  it("still checks other roles on a page with an input it cannot map", () => {
    const login =
      '<form><label>PIN <input type="password" name="pin"></label>' +
      '<input type="date" name="born"><button type="submit">Sign in</button></form>';
    expect(match("role=navigation", login)).toBe("absent");
    expect(match('role=button[name="Account menu"]', login)).toBe("absent");
    expect(match('role=button[name="Sign in"]', login)).toBe("matches");
    // Either input may be a text box, so a text box marker cannot be decided here.
    expect(match("role=textbox", login)).toBe("unchecked");
    expect(match('role=button[name="Upload"]', '<input type="file" name="upload">')).toBe(
      "unchecked",
    );
  });

  it("leaves out content the page hides from the name", () => {
    expect(
      match(
        'role=button[name="Menu"s]',
        '<button><span aria-hidden="true">Open</span><span hidden>Account</span>Menu</button>',
      ),
    ).toBe("matches");
  });

  it("names an element by aria-labelledby before aria-label", () => {
    const body =
      '<nav aria-label="Main" aria-labelledby="nav-title"><h2 id="nav-title">Account</h2></nav>';
    expect(match('role=navigation[name="Account"]', body)).toBe("matches");
    expect(match('role=navigation[name="Main"]', body)).toBe("absent");
  });

  it("names a landmark only from its author, never its content", () => {
    expect(match('role=navigation[name="Account"]', '<nav><a href="/a">Account</a></nav>')).toBe(
      "absent",
    );
  });

  it("leaves roles and names it cannot compute unchecked", () => {
    for (const [selector, body] of [
      ['role=region[name="Account"]', '<section aria-label="Account">Account</section>'],
      ["role=article", "<article>Account</article>"],
      ["role=group", "<fieldset><legend>Account</legend></fieldset>"],
      ['role=textbox[name="Account"]', "<label>Account <input></label>"],
      ["role=textbox", '<input type="password" name="password">'],
      ["role=textbox", '<input type="date" name="when">'],
      [
        'role=button[name="Account"]',
        "<button>Account <select><option>A</option></select></button>",
      ],
    ] as const)
      expect(match(selector, body), selector).toBe("unchecked");
    // A name it can compute that differs is still absent.
    expect(match('role=button[name="Account"]', "<button>Help</button>")).toBe("absent");
  });
});

describe("evaluateSignedInMarker", () => {
  it("reports a marker the signed-out page shows", () => {
    const check = evaluateSignedInMarker({
      marker: { selector: "text=Account" },
      signedOutSnapshots: signedOut,
      signedInNow: passed,
      freshLoad: passed,
    });
    expect(check).toEqual({ signedOutSnapshot: "matches", signedInNow: true, freshLoad: true });
    expect(validateSignedInMarker({ marker: { selector: "text=Account" }, check })).toEqual({
      accepted: false,
      refusals: ["marker_matches_signed_out_page"],
      warnings: [],
    });
  });

  it("passes a site-wide marker only a signed-in user sees", () => {
    const marker = { selector: 'header [aria-label="Account menu"]', openPath: "/account" };
    const check = evaluateSignedInMarker({
      marker,
      signedOutSnapshots: signedOut,
      signedInNow: passed,
      freshLoad: passed,
      secondPage: passed,
    });
    expect(check).toEqual({
      signedOutSnapshot: "absent",
      signedInNow: true,
      freshLoad: true,
      secondPage: true,
    });
    expect(validateSignedInMarker({ marker, check, loginPath: "/sign-in" })).toEqual({
      accepted: true,
      warnings: [],
    });
  });

  it("refuses a marker that does not survive a fresh load or another page", () => {
    const marker = { selector: '[data-testid="welcome-banner"]' };
    const check = evaluateSignedInMarker({
      marker,
      signedOutSnapshots: signedOut,
      signedInNow: passed,
      freshLoad: failed,
      secondPage: failed,
    });
    expect(check).toMatchObject({
      signedOutSnapshot: "absent",
      freshLoad: false,
      secondPage: false,
    });
    const verdict = validateSignedInMarker({ marker, check });
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted)
      expect(verdict.refusals).toEqual([
        "marker_lost_on_fresh_load",
        "marker_missing_on_second_page",
      ]);
  });
});

describe("marker validation", () => {
  it("refuses a match on the signed-out snapshot", () => {
    expect(signedOutMatchRefusal({ signedOutSnapshot: "matches" })).toBe(
      "marker_matches_signed_out_page",
    );
    expect(signedOutMatchRefusal({ signedOutSnapshot: "absent" })).toBeUndefined();
  });

  it("refuses a path alone that is the login page's path", () => {
    expect(
      loginPathRefusal({ urlPath: "/sign-in" }, "https://shop.example.test/sign-in?next=/"),
    ).toBe("marker_is_login_path");
    expect(loginPathRefusal({ urlPath: "/sign-in/" }, "/sign-in")).toBe("marker_is_login_path");
    expect(loginPathRefusal({ urlPath: "/account" }, "/sign-in")).toBeUndefined();
    // A selector checked on that path is not a path alone.
    expect(
      loginPathRefusal({ selector: "header nav", urlPath: "/sign-in" }, "/sign-in"),
    ).toBeUndefined();
    expect(
      validateSignedInMarker({ marker: { urlPath: "/sign-in" }, loginPath: "/sign-in" }),
    ).toMatchObject({ accepted: false, refusals: ["marker_is_login_path"] });
  });

  it("warns when a selector relies only on generated class names", () => {
    for (const selector of [".css-1q2w3e", "div.sc-bdVaJa > span", "header .Header_menu__3kd9F"])
      expect(generatedClassWarning(selector), selector).toBe(
        "selector_relies_on_generated_classes",
      );
    for (const selector of [
      '[aria-label="Account menu"]',
      ".account-menu",
      '.css-1q2w3e[aria-label="Account menu"]',
      'role=button[name="Account"]',
      ".btn-primary2",
    ])
      expect(generatedClassWarning(selector), selector).toBeUndefined();
    expect(
      validateSignedInMarker({
        marker: { selector: ".css-1q2w3e" },
        check: { signedOutSnapshot: "absent", signedInNow: true, freshLoad: true },
      }),
    ).toEqual({ accepted: true, warnings: ["selector_relies_on_generated_classes"] });
  });

  it("warns when the signed-out page could not be checked", () => {
    expect(
      validateSignedInMarker({
        marker: { selector: "xpath=//a" },
        check: { signedOutSnapshot: "unchecked", signedInNow: true, freshLoad: true },
      }),
    ).toEqual({ accepted: true, warnings: ["signed_out_page_unchecked"] });
  });
});
