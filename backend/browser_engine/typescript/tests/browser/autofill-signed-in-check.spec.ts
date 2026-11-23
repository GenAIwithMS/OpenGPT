import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import {
  checkAutofillSignedIn,
  type AutofillScreens,
} from "../../src/destinations/autofill-step.js";
import { hostPage } from "./autofill-host-page.js";

// The host's check that an autofill sign-in shows the site signed in, on local Chromium,
// which decides what shows. A password field still showing fails it only when it belongs to the
// sign-in's own screens: one of their fields, or in the form of one of them that shows. Another
// form's password field on the signed-in page does not count unless a recorded selector matches
// in it.
const site = "https://bank.example.test";
const widget = "https://vault.widget.example.net";
const marker = '<p id="identity">Signed in</p>';

/** The sign-in's screens as its recipe records them: the identifier, then the password. */
const screens = [
  { fields: [{ selector: "input[name=username]" }] },
  { fields: [{ selector: "#password" }] },
];

/**
 * A recorded challenge field: its selector and slot, and the words that named the control when the
 * host inspected it, with its name and id where given, which a control must share to count as that
 * field still asking.
 */
const recorded = (
  selector: string,
  slot: "code" | "private_answer",
  naming: {
    readonly label?: string;
    readonly ariaLabel?: string;
    readonly name?: string;
    readonly id?: string;
  },
) => ({
  fields: [
    {
      selector,
      slot,
      identity: {
        label: naming.label ?? null,
        ariaLabel: naming.ariaLabel ?? null,
        placeholder: null,
        type: null,
        autocomplete: null,
        name: naming.name ?? null,
        id: naming.id ?? null,
      },
    },
  ],
});

/**
 * Serves the signed-in page, each of `options.frames` at its path, and `frame` at any other path,
 * then runs the host's check on it.
 */
const checkPage = async (
  page: Page,
  body: string,
  frame: string | null,
  signIn: AutofillScreens,
  path = "/account",
  options: {
    readonly authenticationOrigins?: readonly string[];
    readonly challengeScreens?: AutofillScreens;
    readonly frames?: Readonly<Record<string, string>>;
  } = {},
) => {
  await page.route(/^https:\/\//u, (route) => {
    const at = new URL(route.request().url()).pathname;
    return route.fulfill({
      contentType: "text/html",
      body: at === path ? body : (options.frames?.[at] ?? frame ?? ""),
    });
  });
  await page.goto(`${site}${path}`);
  return Effect.runPromise(
    checkAutofillSignedIn({
      indicator: { selector: "#identity" },
      page: await hostPage(page),
      siteOrigin: site,
      screens: signIn,
      ...(options.authenticationOrigins === undefined
        ? {}
        : { authenticationOrigins: options.authenticationOrigins }),
      ...(options.challengeScreens === undefined ? {} : { challengeScreens: options.challengeScreens }),
    }),
  );
};

for (const [name, body, frame, failed, signIn] of [
  [
    "the identity marker inside an unfinished security-answer form",
    `<form><p id="identity">Signed in</p><label>Security answer<input name="securityAnswer" required></label><button>Continue</button></form>`,
    null,
    "challenge_form_visible",
    [...screens, recorded("input[name=securityAnswer]", "private_answer", { label: "Security answer" })],
  ],
  [
    "a header marker outside an unfinished security-answer form",
    `${marker}<form><label>Security answer<input name="securityAnswer" required></label><button>Continue</button></form>`,
    null,
    "challenge_form_visible",
    [...screens, recorded("input[name=securityAnswer]", "private_answer", { label: "Security answer" })],
  ],
  [
    "a header marker outside an unfinished verification-code form",
    `${marker}<form><label>Verification code<input name="verificationCode" required></label><button>Verify</button></form>`,
    null,
    "challenge_form_visible",
    [...screens, recorded("input[name=verificationCode]", "code", { label: "Verification code" })],
  ],
  [
    "an account search form that shares the page path",
    `${marker}<form method="get"><label>Search<input name="search"></label><button>Search</button></form>`,
    null,
    undefined,
  ],
  [
    "another form's password field, such as a change-password form",
    `${marker}<form action="/account/password" method="post"><label>Current password<input type="password" name="current"></label><label>New password<input type="password" name="new"></label><button>Change password</button></form>`,
    null,
    undefined,
  ],
  [
    "a change-password form that holds a hidden username matching the sign-in's field",
    `${marker}<form action="/account/password" method="post"><input name="username" autocomplete="username" hidden><label>New password<input type="password" name="new"></label><button>Change password</button></form>`,
    null,
    undefined,
  ],
  [
    "an inner service's own login in another site's frame",
    `${marker}<iframe src="${widget}/login"></iframe>`,
    `<form action="/session" method="post"><label>Vault user<input name="vault_user"></label><label>Vault password<input type="password" name="vault_password"></label><button>Open vault</button></form>`,
    undefined,
  ],
  [
    "the sign-in's own password field",
    `${marker}<form action="/session" method="post"><label>Password<input id="password" type="password"></label><button>Sign in</button></form>`,
    null,
    "password_field_visible",
  ],
  [
    "a password field in the same form as the sign-in's identifier field",
    `${marker}<form action="/session" method="post"><label>Username<input name="username"></label><label>Password<input id="pass" type="password"></label><button>Sign in</button></form>`,
    null,
    "password_field_visible",
  ],
  [
    "the sign-in's own password field in its sign-in frame",
    `${marker}<iframe src="${site}/login-frame"></iframe>`,
    `<form action="/session" method="post"><label>Password<input id="password" type="password"></label><button>Sign in</button></form>`,
    "password_field_visible",
  ],
  [
    "a password field in the form the sign-in's identifier field joins by its form attribute",
    `${marker}<label>Username<input name="username" form="login"></label><form id="login" action="/session" method="post"><label>Password<input id="pass" type="password"></label><button>Sign in</button></form>`,
    null,
    "password_field_visible",
  ],
] as const)
  test(`the signed-in check with ${name}`, async ({ page }) => {
    expect(await checkPage(page, body, frame, signIn ?? screens)).toEqual(
      failed === undefined
        ? { signedIn: true, url: `${site}/account` }
        : { signedIn: false, failed, url: `${site}/account` },
    );
  });

test("the signed-in check with no sign-in field to go by counts any password field", async ({
  page,
}) => {
  const changePassword = `${marker}<form action="/account/password" method="post"><label>New password<input type="password" name="new"></label><button>Change password</button></form>`;
  expect(await checkPage(page, changePassword, null, [{ fields: [] }])).toEqual({
    signedIn: false,
    failed: "password_field_visible",
    url: `${site}/account`,
  });
});

// A page without the marker says too whether the sign-in's own password field shows there, so a
// sign-in form that came back reads signed out where a screen such as an account picker can't tell.
test("the signed-in check without the marker says whether the sign-in's own password field shows", async ({
  page,
}) => {
  const form = `<form action="/session" method="post"><label>Password<input id="password" type="password"></label><button>Sign in</button></form>`;
  expect(await checkPage(page, form, null, screens, "/session-ended")).toEqual({
    signedIn: false,
    failed: "indicator_not_visible",
    url: `${site}/session-ended`,
    passwordFieldVisible: true,
  });
  await page.unrouteAll();
  const chooser = `<h1>Select an account</h1><ul><li><button>Account one</button></li><li><button>Account two</button></li></ul>`;
  expect(await checkPage(page, chooser, null, screens, "/choose-account")).toEqual({
    signedIn: false,
    failed: "indicator_not_visible",
    url: `${site}/choose-account`,
  });
});

test("an account search form containing the signed-in marker does not look like unfinished authentication", async ({ page }) => {
  const account = '<form action="/account/search"><p id="identity">Signed in</p><label>Search<input name="search"></label><button>Search</button></form>';
  expect(await checkPage(page, account, null, screens)).toEqual({
    signedIn: true,
    url: `${site}/account`,
  });
});

test("an unrelated support question on the account page does not block signed-in proof", async ({ page }) => {
  const account = `${marker}<form action="/support"><label>Support question<textarea name="question" required></textarea></label><button>Send</button></form>`;
  expect(await checkPage(page, account, null, screens)).toEqual({
    signedIn: true,
    url: `${site}/account`,
  });
});

test("an unrelated security settings form on the account page does not block signed-in proof", async ({ page }) => {
  const account = `${marker}<form action="/account/security"><label>Security answer<input name="securityAnswer" required></label><button>Update</button></form>`;
  expect(await checkPage(page, account, null, screens)).toEqual({
    signedIn: true,
    url: `${site}/account`,
  });
});

test("an account page below an auth URL prefix still accepts an unrelated security form", async ({ page }) => {
  const account = `${marker}<form action="/auth/account/security"><label>Security answer<input name="securityAnswer" required></label><button>Update</button></form>`;
  expect(await checkPage(page, account, null, screens, "/auth/account")).toEqual({
    signedIn: true,
    url: `${site}/auth/account`,
  });
});

test("an auth-named route does not classify an unrecorded account form as a challenge", async ({ page }) => {
  const challenge = `${marker}<form><label>Security answer<input name="securityAnswer" required></label><button>Continue</button></form>`;
  expect(await checkPage(page, challenge, null, screens, "/security-question")).toEqual({
    signedIn: true,
    url: `${site}/security-question`,
  });
});

test("a visible contenteditable security answer remains an unfinished challenge", async ({ page }) => {
  const account = `${marker}<form><div contenteditable="true" aria-label="Security answer"></div><button>Continue</button></form>`;
  expect(await checkPage(page, account, null, [...screens, recorded('[contenteditable="true"]', "private_answer", { ariaLabel: "Security answer" })])).toEqual({
    signedIn: false,
    failed: "challenge_form_visible",
    url: `${site}/account`,
  });
});

test("a recorded challenge field associated with its form by form attribute remains unfinished", async ({ page }) => {
  const account = `${marker}<form id="challenge"><button>Continue</button></form><label>Security answer<input id="answer" name="securityAnswer" form="challenge" required></label>`;
  expect(await checkPage(page, account, null, [...screens, recorded("#answer", "private_answer", { label: "Security answer" })])).toEqual({
    signedIn: false,
    failed: "challenge_form_visible",
    url: `${site}/account`,
  });
});

test("a recorded challenge field in a visible frame of a configured sign-in origin remains unfinished", async ({ page }) => {
  const account = `${marker}<iframe src="${widget}/security-question"></iframe>`;
  const challenge = '<form><label>Security answer<input id="challenge-answer" name="securityAnswer" required></label><button>Continue</button></form>';
  expect(await checkPage(page, account, challenge, [...screens, recorded("#challenge-answer", "private_answer", { label: "Security answer" })], "/account", { authenticationOrigins: [widget] })).toEqual({
    signedIn: false,
    failed: "challenge_form_visible",
    url: `${site}/account`,
  });
});

// Even the recorded control itself counts as the challenge still asking only while it takes
// typing, on the site or a configured sign-in origin, in a frame that shows with every frame above.
const codeScreen = [...screens, recorded('input[name="code"]', "code", { label: "Verification code" })];
test("a recorded code field in an unconfigured off-site frame does not block signed-in proof", async ({ page }) => {
  const account = `${marker}<iframe src="${widget}/verify"></iframe>`;
  const codeForm = '<form><label>Verification code<input name="code"></label><button>Verify</button></form>';
  expect(await checkPage(page, account, codeForm, codeScreen)).toEqual({
    signedIn: true,
    url: `${site}/account`,
  });
});

test("a read-only or disabled recorded code field does not block signed-in proof", async ({ page }) => {
  const account = `${marker}<label>Verification code<input name="code" readonly></label><label>Verification code<input name="code" disabled></label>`;
  expect(await checkPage(page, account, null, codeScreen)).toEqual({
    signedIn: true,
    url: `${site}/account`,
  });
});

test("a recorded challenge field in a frame inside a hidden frame does not block signed-in proof", async ({ page }) => {
  const account = `${marker}<iframe style="visibility:hidden" src="/outer"></iframe>`;
  const frames = {
    "/outer": '<iframe src="/inner"></iframe>',
    "/inner": '<form><label>Verification code<input name="code"></label><button>Verify</button></form>',
  };
  expect(await checkPage(page, account, null, codeScreen, "/account", { frames })).toEqual({
    signedIn: true,
    url: `${site}/account`,
  });
});

test("a challenge field in a hidden provider iframe does not block signed-in proof", async ({ page }) => {
  const account = `${marker}<iframe style="display:none" src="${widget}/security-question"></iframe>`;
  const challenge = '<form><label>Security answer<input id="challenge-answer" name="securityAnswer" required></label><button>Continue</button></form>';
  expect(await checkPage(page, account, challenge, [...screens, recorded("#challenge-answer", "private_answer", { label: "Security answer" })])).toEqual({
    signedIn: true,
    url: `${site}/account`,
  });
});

// A host that records no identity, as a recipe's screens record none, gets the check without the
// challenge part: a recorded code field still on the page does not count, and the sign-in's own
// password field still does.
test("a recorded code field with no inspected identity leaves the check as without one", async ({ page }) => {
  const code = { fields: [{ selector: "input[name=verificationCode]", slot: "code" as const }] };
  const form = '<form><label>Verification code<input name="verificationCode" required></label><button>Verify</button></form>';
  expect(await checkPage(page, `${marker}${form}`, null, [...screens, code])).toEqual({
    signedIn: true,
    url: `${site}/account`,
  });
  expect(
    await checkPage(page, `${marker}${form}<label>Password<input id="password" type="password"></label>`, null, [...screens, code]),
  ).toEqual({ signedIn: false, failed: "password_field_visible", url: `${site}/account` });
});

// `challengeScreens` names the current sign-in's screens, whose recorded challenges count. Left
// out, it is `screens`, so every recorded screen's challenges count.
test("the signed-in check counts the recorded challenges of `challengeScreens`, and of `screens` without it", async ({ page }) => {
  const account = `${marker}<form><label>Verification code<input name="code"></label><button>Verify</button></form>`;
  expect(await checkPage(page, account, null, codeScreen)).toEqual({
    signedIn: false,
    failed: "challenge_form_visible",
    url: `${site}/account`,
  });
  expect(await checkPage(page, account, null, codeScreen, "/account", { challengeScreens: screens })).toEqual({
    signedIn: true,
    url: `${site}/account`,
  });
});

// A redeem box can share a code field's generic label. The name and id inspection recorded tell
// them apart, and the code form itself, with the same name and id, still asks.
for (const [name, control, failed] of [
  ["another name and id", '<input name="redeem" id="redeem">', undefined],
  ["the same name and another id", '<input name="code" id="redeem">', undefined],
  ["the same name and id", '<input name="code" id="otp">', "challenge_form_visible"],
] as const)
  test(`the signed-in check with a control labelled as the recorded code field, with ${name}`, async ({ page }) => {
    const code = recorded('role=textbox[name="Code"]', "code", { label: "Code", name: "code", id: "otp" });
    expect(
      await checkPage(page, `${marker}<form><label>Code${control}</label><button>Apply</button></form>`, null, [...screens, code]),
    ).toEqual(
      failed === undefined
        ? { signedIn: true, url: `${site}/account` }
        : { signedIn: false, failed, url: `${site}/account` },
    );
  });

// A recorded control that detaches while the host reads it, or that the host cannot read in time,
// shows nothing: the check does not fail on what it cannot tell, and the marker still decides.
for (const [name, script] of [
  [
    "detaches as the host reads it",
    "new MutationObserver(() => document.querySelector('input[name=code]')?.remove()).observe(document.body, { attributes: true, subtree: true });",
  ],
  [
    "keeps the page busy past the host's limit as the host reads it",
    "new MutationObserver(() => { const end = Date.now() + 4000; while (Date.now() < end); }).observe(document.body, { attributes: true, subtree: true });",
  ],
] as const)
  test(`the signed-in check with a recorded code field that ${name}`, async ({ page }) => {
    const code = recorded("input[name=code]", "code", { label: "Code" });
    const body = `${marker}<form><label>Code<input name="code"></label><button>Verify</button></form><script>${script}</script>`;
    expect(await checkPage(page, body, null, [...screens, code])).toEqual({
      signedIn: true,
      url: `${site}/account`,
    });
  });
