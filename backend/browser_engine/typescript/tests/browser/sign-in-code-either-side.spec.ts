import { expect, test, type Page } from "@playwright/test";
import { Effect } from "effect";
import { localSignInLogin, makeSignInBrowser } from "../../src/standalone/authentication.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import { signInForRun } from "../../src/runtime/sign-in-replay.js";
import { expectNotCarried, hostKeyboard, hostPage } from "./autofill-host-page.js";

// A site that asks for a sign-in code only some of the time: the code screen may show at a run
// when the recipe recorded none. The run takes it as it takes any code screen its recipe never
// recorded, and the marker decides.

const site = "https://app.example.test";
const host = "app.example.test";
const code = "246810";
const login = { username: "owner@app.example.test", password: "synthetic-password" };
// A sign-in screen, a recorded screen's wait, the marker's wait and a code: more than the default
// 30 s allows on a busy machine.
test.describe.configure({ timeout: 120_000 });

/**
 * The code screen at /verify: one code field in no form and with no button, whose own script sends
 * the code once it holds six digits, then loads the account as a new document.
 */
const codeScreen = `<label>Code<input id="otc" name="otc" autocomplete="one-time-code" inputmode="numeric" maxlength="6"></label>
<script>
document.getElementById("otc").addEventListener("input", (event) => {
  if (!/^[0-9]{6}$/.test(event.target.value)) return;
  fetch("/api/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: event.target.value }) })
    .then((response) => { if (response.ok) location.assign("/account"); });
});
</script>`;

/**
 * The code screen at /verify as a row of six one-character boxes in no form and with no button:
 * the first is marked as a one-time code, all share one name, and each has its own label. Its own
 * script moves to the next box as each takes a digit and, once every box holds one, sends the
 * code, then loads the account as a new document.
 */
const boxRow = `${[1, 2, 3, 4, 5, 6]
  .map(
    (box) =>
      `<input name="digit" maxlength="1" inputmode="numeric" aria-label="Digit ${box}"${box === 1 ? ' autocomplete="one-time-code"' : ""}>`,
  )
  .join("")}
<script>
const boxes = [...document.querySelectorAll("input")];
boxes.forEach((box, index) => box.addEventListener("input", () => {
  if (box.value !== "" && boxes[index + 1]) boxes[index + 1].focus();
  const typed = boxes.map((each) => each.value).join("");
  if (!/^[0-9]+$/.test(typed) || typed.length !== boxes.length) return;
  fetch("/api/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: typed }) })
    .then((response) => { if (response.ok) location.assign("/account"); });
}));
</script>`;

/**
 * The site: a sign-in form at /login that posts to /session, whose page sends the browser on to
 * the code screen at /verify (`verify`). It keeps each code it receives.
 */
const serve = async (page: Page, verify = codeScreen) => {
  const received: string[] = [];
  const account = '<p id="account">Signed in</p>';
  await page.route(`${site}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === "/api/code") {
      const body: unknown = JSON.parse(request.postData() ?? "{}");
      const typed: unknown = Reflect.get(Object(body), "code");
      received.push(typeof typed === "string" ? typed : "");
      await route.fulfill({ status: typed === code ? 200 : 400, contentType: "application/json", body: "{}" });
    } else if (request.method() === "POST" && path === "/session")
      await route.fulfill({ contentType: "text/html", body: '<script>location.replace("/verify")</script>' });
    else if (path === "/verify") await route.fulfill({ contentType: "text/html", body: verify });
    else if (path === "/account") await route.fulfill({ contentType: "text/html", body: account });
    else
      await route.fulfill({
        contentType: "text/html",
        body: '<form method="post" action="/session"><label>Email<input id="email" name="email"></label><label>Password<input id="password" name="password" type="password"></label><button id="sign-in">Sign in</button></form>',
      });
  });
  return received;
};

const loginScreen = {
  page: `${site}/login`,
  fields: [{ selector: "#email", accepts: ["email"] }, { selector: "#password", slot: "password" }],
  submit: "#sign-in",
  submittedBy: "host",
} as const;
/** A recipe the build recorded with no code screen. */
const noCodeRecipe = { version: 2, steps: [loginScreen], signedIn: { selector: "#account" } } as const;

/** One run's sign-in with `recipe`, answering the login ask and each code ask with `code`. */
const run = async (page: Page, recipe: typeof noCodeRecipe) => {
  const browser = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const secrets = makeRunSecrets();
  const prompts: string[] = [];
  const ask = makeInputAsker((request) =>
    Effect.sync(() => {
      const question = request.questions[0];
      prompts.push(question?.type === "credential" ? "login" : (question?.prompt ?? ""));
      return question?.type === "credential"
        ? { login: { ...login, saveLogin: false } }
        : { [question?.id ?? "code"]: code };
    }),
  );
  const result = await Effect.runPromise(
    Effect.either(
      signInForRun({
        recipe,
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
  for (const value of [code, login.password]) expectNotCarried(browser.calls, value);
  return { result, prompts };
};

const codePrompt = `Enter the sign-in code ${host} sent you.`;

test("a run whose recipe recorded no code screen types the code into one code field with no button that sends itself, and signs in", async ({
  page,
}) => {
  const received = await serve(page);
  const { result, prompts } = await run(page, noCodeRecipe);
  expect(result).toMatchObject({ _tag: "Right", right: { alreadySignedIn: false } });
  expect(prompts).toEqual(["login", codePrompt]);
  expect(received).toEqual([code]);
  await expect(page.locator("#account")).toBeVisible();
});

test("a run whose recipe recorded no code screen types the code one digit per box into a row of six one-character boxes that sends itself, and signs in", async ({
  page,
}) => {
  const received = await serve(page, boxRow);
  const { result, prompts } = await run(page, noCodeRecipe);
  expect(result).toMatchObject({ _tag: "Right", right: { alreadySignedIn: false } });
  expect(prompts).toEqual(["login", codePrompt]);
  expect(received).toEqual([code]);
  await expect(page.locator("#account")).toBeVisible();
});
