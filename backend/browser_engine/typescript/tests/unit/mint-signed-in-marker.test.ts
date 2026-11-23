import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { AutofillSignedIn } from "../../src/destinations/autofill-step.js";
import { markerRefusalFor, refuseMarker } from "../../src/mint/signed-in-marker.js";

// The refusals a sign-in's `signedIn` meets before the host reads the page: a marker a signed-out
// page shows, and a sign-in page's path alone.

const page = (body: string, url = "https://shop.example/login") => ({
  url,
  dom: `<!doctype html>\n<html><head><title>Sign in</title></head><body>${body}</body></html>`,
});
const loginPage = page(
  `<header><a href="/login">Account</a><nav aria-label="Main"><a href="/deals">Deals</a></nav></header>
  <form><label>Email <input name="email"></label><button>Sign in</button></form>
  <div hidden><button aria-label="Your account">Menu</button></div>
  <div style="visibility: hidden"><span class="greeting">Hi <b style="visibility: visible">there</b></span></div>
  <details><summary>Help</summary><p class="help-text">Reset your password</p></details>
  <ul class="css-1q2w3e4"><li>Item</li></ul>`,
);

describe("the refusals decided before the page is read", () => {
  it.each([
    {
      marker: { selector: "text=Account" },
      refusal: "marker_matches_signed_out_page",
    },
    { marker: { urlPath: "/verify/" }, refusal: "marker_is_login_path" },
    { marker: { urlPath: "/verify" }, refusal: "marker_is_login_path" },
    // A selector with a sign-in path is judged by its selector.
    { marker: { selector: "[aria-label='Your account']", urlPath: "/login" }, refusal: undefined },
    { marker: { selector: "[aria-label='Your account']" }, refusal: undefined },
    { marker: { urlPath: "/orders" }, refusal: undefined },
  ] satisfies { marker: AutofillSignedIn; refusal: string | undefined }[])(
    "refuses $marker with $refusal",
    ({ marker, refusal }) => {
      expect(markerRefusalFor(marker, [loginPage], ["/login", "/verify"]).refusal).toBe(refusal);
    },
  );

  it("compares nothing with no signed-out page, and leaves the marker unchecked", () => {
    expect(markerRefusalFor({ selector: "text=Account" }, [], [])).toEqual({
      signedOut: "unchecked",
      refusal: undefined,
    });
  });

  it("tells the minter why, what the host checks the marker on, and what to pick instead", async () => {
    const refused = await Effect.runPromise(
      refuseMarker({ reportCorrelation: undefined }, "marker_is_login_path"),
    );
    expect(JSON.parse(new TextDecoder().decode(refused.result))).toMatchObject({
      websiteEffect: "not_started",
      output: {
        value: {
          signedIn: false,
          failed: "marker_is_login_path",
          nextStep:
            "This path is a sign-in page's, where a signed-out browser is, and a single-page app keeps one path either way. The host checks this marker after resets, at every operation start, after page loads in the middle of a run and on whatever page a failure lands on, so pick a site-wide element only a signed-in user sees, such as the global header's account menu or a sign-out control, preferring an aria-label, role or visible text to generated class names. Test it with check_signed_in_marker until every check passes, then send signedIn again.",
        },
      },
    });
  });
});
