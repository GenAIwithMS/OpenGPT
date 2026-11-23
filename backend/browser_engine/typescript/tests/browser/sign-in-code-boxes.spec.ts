import { expect, test, type Page } from "@playwright/test";
import { Effect } from "effect";
import { localSignInLogin, makeSignInBrowser } from "../../src/standalone/authentication.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import { signInForRun } from "../../src/runtime/sign-in-replay.js";
import { expectNotCarried, hostKeyboard, hostPage } from "./autofill-host-page.js";

// A run's sign-in whose code screen is six one-character boxes with no form and no button, whose
// own script sends the code once every box holds a digit. The run asks for the code once, types
// one digit in each box, and counts the code as sent once the boxes' screen sent itself.

const site = "https://bank.example.test";
const host = "bank.example.test";
const code = "246810";
const login = { username: "owner@bank.example.test", password: "synthetic-password" };
// A sign-in screen, then six boxes filled one focus and one insertion at a time, and a refused
// code's wait for the account: more than the default 30 s allows on a busy machine.
test.describe.configure({ timeout: 120_000 });

const boxes = [1, 2, 3, 4, 5, 6]
  .map(
    (box) =>
      `<input id="otp-${box}" name="d${box}" class="otp" maxlength="1" inputmode="numeric" aria-label="Digit ${box}"${box === 1 ? ' autocomplete="one-time-code"' : ""}>`,
  )
  .join("");

/**
 * The code screen: once every box holds a digit, the widget puts a "Verifying" line in place of
 * the boxes, or with `quiet` sends nothing and draws its boxes again, empty, a moment later. An
 * accepted code shows the account; a refused one draws the boxes again, empty, under an error.
 */
const widget = (quiet: boolean) => `<main id="view">${boxes}</main><p id="error"></p>
<script>
const view = document.getElementById("view");
const boxes = () => [...document.querySelectorAll(".otp")];
let sending = false;
const again = (error) => {
  sending = false;
  view.innerHTML = ${JSON.stringify(boxes)};
  document.getElementById("error").textContent = error;
  listen();
  boxes()[0].focus();
};
const listen = () => boxes().forEach((box, index) => box.addEventListener("input", () => {
  const next = boxes()[index + 1];
  if (box.value !== "" && next) next.focus();
  const typed = boxes().map((each) => each.value).join("");
  if (sending || !/^[0-9]{6}$/.test(typed)) return;
  sending = true;
  view.replaceChildren(Object.assign(document.createElement("p"), { id: "verifying", textContent: "Verifying" }));
  if (${JSON.stringify(quiet)}) {
    setTimeout(() => again("Try again"), 500);
    return;
  }
  fetch("/api/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: typed }) })
    .then((response) => {
      if (response.ok) view.innerHTML = '<p id="account">Signed in</p>';
      else again("Wrong code");
    });
}));
listen();
</script>`;

/**
 * The site: a sign-in form at /login that posts to /session, whose page sends the browser on to
 * the code screen at /verify. It keeps each code the widget sends and each sign-in form post.
 */
const serve = async (page: Page, quiet = false) => {
  const sent: string[] = [];
  const posted: string[] = [];
  await page.route(`${site}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === "/api/code") {
      const body: unknown = JSON.parse(request.postData() ?? "{}");
      const typed: unknown = Reflect.get(Object(body), "code");
      sent.push(typeof typed === "string" ? typed : "");
      await route.fulfill({ status: typed === code ? 200 : 400, contentType: "application/json", body: "{}" });
    } else if (request.method() === "POST" && path === "/session") {
      posted.push(request.postData() ?? "");
      await route.fulfill({ contentType: "text/html", body: '<script>location.replace("/verify")</script>' });
    } else if (path === "/verify")
      await route.fulfill({ contentType: "text/html", body: widget(quiet) });
    else
      await route.fulfill({
        contentType: "text/html",
        body: '<form method="post" action="/session"><label>Email<input id="email" name="email"></label><label>Password<input id="password" name="password" type="password"></label><button id="sign-in">Sign in</button></form>',
      });
  });
  return { sent, posted };
};

const recipe = {
  version: 2,
  steps: [
    {
      page: `${site}/login`,
      fields: [{ selector: "#email", accepts: ["email"] }, { selector: "#password", slot: "password" }],
      submit: "#sign-in",
      submittedBy: "host",
    },
    {
      page: `${site}/verify`,
      fields: [1, 2, 3, 4, 5, 6].map((box) => ({ selector: `#otp-${box}`, slot: "code" as const })),
    },
  ],
  signedIn: { selector: "#account" },
} as const;

/**
 * One run's sign-in with the recipe, answering each code ask with the next of `codes`, and every
 * ask after those with the last, as an owner asked again for the code just given would.
 */
const run = async (
  page: Page,
  codes: readonly string[],
  replayed: typeof recipe | typeof formRecipe = recipe,
) => {
  const browser = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const secrets = makeRunSecrets();
  const prompts: string[] = [];
  const queue = [...codes];
  const ask = makeInputAsker((request) =>
    Effect.sync(() => {
      const question = request.questions[0];
      prompts.push(question?.type === "credential" ? "login" : (question?.prompt ?? ""));
      return question?.type === "credential"
        ? { login: { ...login, saveLogin: false } }
        : { [question?.id ?? "code"]: (queue.length > 1 ? queue.shift() : queue[0]) ?? "" };
    }),
  );
  const result = await Effect.runPromise(
    Effect.either(
      signInForRun({
        recipe: replayed,
        entryUrl: `${site}/login`,
        browser: makeSignInBrowser({
          page: browser,
          keyboard,
          siteOrigin: site,
          authenticationOrigins: [],
          typing: { typed: false },
        }),
        login: localSignInLogin({ ask, register: secrets.register, siteOrigin: site }),
        ask,
        secrets,
        site: host,
        siteOrigin: site,
        timing: { stepWaitMs: 8_000, pollMs: 250 },
      }),
    ),
  );
  for (const value of [...codes, login.password]) expectNotCarried(browser.calls, value);
  return { result, prompts };
};

const codePrompt = `Enter the sign-in code ${host} sent you.`;
const refusedPrompt = `The site refused the last code. Enter the newest sign-in code ${host} sent you.`;

test("a run signs in through six code boxes that send themselves, asking for the code once, and the site gets it once", async ({
  page,
}) => {
  const { sent, posted } = await serve(page);
  const { result, prompts } = await run(page, [code]);
  expect(result).toMatchObject({ _tag: "Right", right: { alreadySignedIn: false } });
  expect(prompts).toEqual(["login", codePrompt]);
  expect(sent).toEqual([code]);
  expect(posted).toHaveLength(1);
  await expect(page.locator("#account")).toBeVisible();
});

test("a run asks for one new code, saying the site refused the last, when six code boxes that sent a wrong code show again", async ({
  page,
}) => {
  const { sent } = await serve(page);
  const { result, prompts } = await run(page, ["135791", code]);
  expect(result).toMatchObject({ _tag: "Right", right: { alreadySignedIn: false } });
  expect(prompts).toEqual(["login", codePrompt, refusedPrompt]);
  expect(sent).toEqual(["135791", code]);
});

test("a run takes six code boxes that only seemed to send a code and show again as a refused code, and the site gets none", async ({
  page,
}) => {
  const { sent } = await serve(page, true);
  const { result, prompts } = await run(page, [code, "135791"]);
  // The boxes went away after the last digit, so the code counts as sent: the run cannot tell a
  // widget that sent nothing from a site that refused the code. A code is tried at most twice.
  expect(result).toMatchObject({
    _tag: "Left",
    left: { code: "CredentialsRejected", reason: "code" },
  });
  expect(prompts).toEqual(["login", codePrompt, refusedPrompt, refusedPrompt]);
  expect(sent).toEqual([]);
});

test("a run types nothing into six code boxes for a code that does not fit them", async ({ page }) => {
  const { sent } = await serve(page);
  const { result, prompts } = await run(page, ["12345"]);
  expect(result).toMatchObject({
    _tag: "Left",
    left: { code: "NeedsInput", reason: "sign_in_value" },
  });
  // A code that does not fit the boxes is asked twice more, then the step goes unanswered.
  expect(prompts).toEqual(["login", codePrompt, codePrompt, codePrompt]);
  expect(sent).toEqual([]);
  for (const box of [1, 2, 3, 4, 5, 6]) await expect(page.locator(`#otp-${box}`)).toHaveValue("");
});

/**
 * A code screen of six one-character boxes in a form with a Verify button, each posted as its own
 * field. With `losesFirst`, the widget empties the first box once the last takes its digit, as a
 * widget that draws its boxes again from stale state does. It keeps each code the form posts.
 */
const serveForm = async (page: Page, losesFirst: boolean) => {
  const posted: string[] = [];
  const form = `<form method="post" action="/verify-code">${boxes}<button id="verify">Verify</button></form>
<script>
const boxes = [...document.querySelectorAll(".otp")];
boxes.forEach((box, index) => box.addEventListener("input", () => {
  if (box.value !== "" && boxes[index + 1]) boxes[index + 1].focus();
  if (${JSON.stringify(losesFirst)} && index === boxes.length - 1) boxes[0].value = "";
}));
</script>`;
  await page.route(`${site}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === "/verify-code") {
      const body = new URLSearchParams(request.postData() ?? "");
      const typed = [1, 2, 3, 4, 5, 6].map((box) => body.get(`d${box}`) ?? "").join("");
      posted.push(typed);
      await route.fulfill({
        contentType: "text/html",
        body: typed === code ? '<p id="account">Signed in</p>' : `<p id="error">Wrong code</p>${form}`,
      });
    } else if (request.method() === "POST" && path === "/session")
      await route.fulfill({ contentType: "text/html", body: '<script>location.replace("/verify")</script>' });
    else if (path === "/verify") await route.fulfill({ contentType: "text/html", body: form });
    else
      await route.fulfill({
        contentType: "text/html",
        body: '<form method="post" action="/session"><label>Email<input id="email" name="email"></label><label>Password<input id="password" name="password" type="password"></label><button id="sign-in">Sign in</button></form>',
      });
  });
  return posted;
};

const formRecipe = {
  ...recipe,
  steps: [recipe.steps[0], { ...recipe.steps[1], submit: "#verify", submittedBy: "host" }],
} as const;

test("a run signs in through six code boxes a form posts as separate fields, asking for the code once", async ({
  page,
}) => {
  const posted = await serveForm(page, false);
  const { result, prompts } = await run(page, [code], formRecipe);
  expect(result).toMatchObject({ _tag: "Right", right: { alreadySignedIn: false } });
  expect(prompts).toEqual(["login", codePrompt]);
  expect(posted).toEqual([code]);
  await expect(page.locator("#account")).toBeVisible();
});

test("a run never clicks Verify on six code boxes once the page emptied one of them", async ({ page }) => {
  const posted = await serveForm(page, true);
  const { result, prompts } = await run(page, [code], formRecipe);
  expect(result).toMatchObject({
    _tag: "Left",
    left: { code: "RecipeFailed", reason: "fill_failed" },
  });
  expect(prompts).toEqual(["login", codePrompt]);
  expect(posted).toEqual([]);
  await expect(page.locator("#otp-1")).toHaveValue("");
  await expect(page.locator("#otp-6")).not.toHaveValue("");
});
