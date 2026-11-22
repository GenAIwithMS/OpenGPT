import { expect, test, type Page } from "@playwright/test";
import { Effect } from "effect";
import { localSignInLogin, makeSignInBrowser } from "../../src/standalone/authentication.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import {
  inspectAutofillStep,
  type AutofillSignedIn,
} from "../../src/destinations/autofill-step.js";
import type { CredentialKeyboard } from "../../src/destinations/credential-keyboard.js";
import type { SignInStep } from "../../src/mint/contracts.js";
import { makeSignInRecorder } from "../../src/mint/sign-in-recorder.js";
import type { InputAsker } from "../../src/runtime/input-request.js";
import { signInForRun } from "../../src/runtime/sign-in-replay.js";
import { expectNotCarried, hostKeyboard, hostPage } from "./autofill-host-page.js";

// The local host's sign-in on a page: its recorder fills each screen with the build's login, and
// asks for each private answer.

/** The login the build gives when a screen first needs it: one credential question's answer. */
const login = { username: "owner@bank.example.test", password: "synthetic-password" };

/**
 * The local host's sign-in on `page` for `site`, asking the owner through `ask`: `fill` runs a
 * screen, `check` the signed-in check on the screens so far, `signedIn` the sign-in's own check.
 */
const localSignIn = async (
  page: Page,
  site: string,
  ask: InputAsker,
  keyboard?: CredentialKeyboard,
) => {
  const browser = await hostPage(page);
  const secrets = makeRunSecrets();
  const signIn = makeSignInBrowser({
    page: browser,
    keyboard: keyboard ?? (await hostKeyboard(page)).keyboard,
    siteOrigin: site,
    authenticationOrigins: [],
    typing: { typed: false },
  });
  const owner: InputAsker = (request, bounds) =>
    request.questions.some((question) => question.type === "credential")
      ? Effect.succeed({ login: { type: "credential" as const, value: { ...login, saveLogin: false } } })
      : ask(request, bounds);
  const host = new URL(site).hostname;
  const held = localSignInLogin({ ask: owner, register: secrets.register, siteOrigin: site });
  const recorder = makeSignInRecorder({
    browser: signIn,
    login: held,
    ask,
    secrets,
    review: () => Effect.void,
    site: host,
    signedOutPages: () => [],
  });
  // The build's login is given before these screens, as an identifier screen would ask for it.
  await Effect.runPromise(held.values);
  return {
    browser,
    recorder,
    fill: (step: SignInStep) => recorder.step(step, undefined, Effect.void),
    check: (indicator: AutofillSignedIn) => {
      const { screens, challengeScreens } = recorder.screens();
      return signIn.confirm(indicator, screens, challengeScreens);
    },
  };
};

test("asks the current private-answer question again on a later sign-in step", async ({ page }) => {
  // Two independent protected CDP fills are required to prove the first answer is not reused.
  test.slow();
  const site = "https://bank.example.test";
  await page.route(`${site}/login`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<form><label>What was your first school?<input id="answer" name="securityAnswer"></label></form>',
    }),
  );
  await page.goto(`${site}/login`);
  const answers = ["synthetic-school-one", "synthetic-street-two"];
  const prompts: string[] = [];
  const auth = await localSignIn(
    page,
    site,
    makeInputAsker((request) =>
      Effect.sync(() => {
        prompts.push(request.questions[0]?.prompt ?? "");
        return { private_answer: answers[prompts.length - 1] };
      }),
    ),
  );
  const { browser } = auth;

  await Effect.runPromise(auth.fill({ fields: [{ selector: "#answer", slot: "private_answer" }] }));
  expect(await page.locator("#answer").inputValue()).toBe(answers[0]);
  await page.setContent(
    '<form><label>What street did you grow up on?<input id="answer" name="securityAnswer"></label></form>',
  );
  await Effect.runPromise(auth.fill({ fields: [{ selector: "#answer", slot: "private_answer" }] }));
  expect(await page.locator("#answer").inputValue()).toBe(answers[1]);
  expect(prompts).toHaveLength(2);
  expect(prompts[0]).toContain("first school");
  expect(prompts[1]).toContain("grow up on");
  for (const answer of answers) expectNotCarried(browser.calls, answer);
});

test("asks separately for two private answers on the same sign-in screen", async ({ page }) => {
  test.slow();
  const site = "https://bank.example.test";
  await page.route(`${site}/login`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<form><label>What was your first school?<input id="school" name="schoolAnswer"></label><label>What street did you grow up on?<input id="street" name="streetAnswer"></label></form>',
    }),
  );
  await page.goto(`${site}/login`);
  const answers = ["synthetic-school-one", "synthetic-street-two"];
  const prompts: string[] = [];
  const auth = await localSignIn(
    page,
    site,
    makeInputAsker((request) =>
      Effect.sync(() => {
        const answer = answers[prompts.length];
        prompts.push(request.questions[0]?.prompt ?? "");
        return { private_answer: answer };
      }),
    ),
  );
  const { browser } = auth;

  await Effect.runPromise(auth.fill({ fields: [
    { selector: "#school", slot: "private_answer" },
    { selector: "#street", slot: "private_answer" },
  ] }));
  expect(await page.locator("#school").inputValue()).toBe(answers[0]);
  expect(await page.locator("#street").inputValue()).toBe(answers[1]);
  expect(prompts).toHaveLength(2);
  expect(prompts[0]).toContain("first school");
  expect(prompts[1]).toContain("grow up on");
  for (const answer of answers) expectNotCarried(browser.calls, answer);
});


test("reads adjacent questions again while the private-answer label stays unchanged", async ({ page }) => {
  const site = "https://bank.example.test";
  await page.route(`${site}/login`, (route) => route.fulfill({ contentType: "text/html", body:
    '<p id="question">  First   pet\'s name? </p><label>Security answer<input id="answer"></label>' }));
  await page.goto(`${site}/login`);
  const prompts: string[] = [];
  const auth = await localSignIn(page, site, makeInputAsker((request) => Effect.sync(() => {
    prompts.push(request.questions[0]?.prompt ?? "");
    return { private_answer: "synthetic-private-answer" };
  })));
  const { browser } = auth;
  const step = { fields: [{ selector: "#answer", slot: "private_answer" as const, questionSelector: "#question" }] };
  await Effect.runPromise(auth.fill(step));
  await page.locator("#question").evaluate((element) => { element.textContent = "First school's name?"; });
  await Effect.runPromise(auth.fill(step));
  expect(prompts).toEqual([
    "bank.example.test asks this security question: First pet's name?",
    "bank.example.test asks this security question: First school's name?",
  ]);
  expectNotCarried(browser.calls, "synthetic-private-answer");
});

test("the local signed-in check refuses while a recorded private-answer field still shows", async ({ page }) => {
  const site = "https://bank.example.test";
  await page.route(`${site}/login`, (route) => route.fulfill({ contentType: "text/html", body:
    '<p id="identity">Signed in</p><form id="challenge"><label>Security answer<input id="answer"></label></form>' }));
  await page.goto(`${site}/login`);
  const auth = await localSignIn(page, site, makeInputAsker(() => Effect.succeed({ private_answer: "synthetic-private-answer" })));
  const { browser } = auth;
  await Effect.runPromise(auth.fill({ fields: [{ selector: "#answer", slot: "private_answer" }] }));
  expect(await Effect.runPromise(auth.check({ selector: "#identity" }))).toEqual({
    signedIn: false,
    failed: "challenge_form_visible",
    url: `${site}/login`,
  });
  await page.locator("#challenge").evaluate((element) => { element.remove(); });
  expect(await Effect.runPromise(auth.check({ selector: "#identity" }))).toEqual({
    signedIn: true,
    url: `${site}/login`,
  });
  expectNotCarried(browser.calls, "synthetic-private-answer");
});

test("question inspection omits uncertain text and never uses a different frame", async ({ page }) => {
  const site = "https://bank.example.test";
  await page.route(`${site}/login`, (route) => route.fulfill({ contentType: "text/html", body: "" }));
  await page.goto(`${site}/login`);
  const browser = await hostPage(page);
  const inspect = async (questionSelector: string) => {
    const result = await Effect.runPromise(inspectAutofillStep({
      step: { fields: [{ selector: "#answer", slot: "private_answer", questionSelector }] },
      page: browser, siteOrigin: site, authenticationOrigins: [],
    }));
    expect(result).not.toHaveProperty("outcome");
    if ("outcome" in result) throw new Error("Inspection refused");
    return result.screen.fields[0];
  };
  await page.setContent('<label>Security answer<input id="answer"></label><p id="question">  First \n pet? <input value="synthetic-secret"></p>');
  expect(await inspect("#question")).toHaveProperty("questionText", "First pet?");
  expect(await inspect("#missing")).not.toHaveProperty("questionText");
  await page.locator("#question").evaluate((element) => { element.setAttribute("hidden", ""); });
  expect(await inspect("#question")).not.toHaveProperty("questionText");
  await page.locator("#question").evaluate((element) => { element.removeAttribute("hidden"); element.after(element.cloneNode(true)); });
  expect(await inspect("#question")).not.toHaveProperty("questionText");
  expect(await inspect("#answer")).not.toHaveProperty("questionText");
  expect(await inspect("iframe >> #question")).not.toHaveProperty("questionText");
  await page.setContent('<p id="question">Main frame question</p><iframe srcdoc="<label>Security answer<input id=answer></label>"></iframe>');
  expect(await inspect("#question")).not.toHaveProperty("questionText");
  await page.setContent('<label>Security answer<input id="answer"></label><p id="question"></p>');
  await page.locator("#question").evaluate((element) => { element.textContent = "q".repeat(2001); });
  expect(await inspect("#question")).not.toHaveProperty("questionText");
});

for (const changeAt of ["protected prompting", "focus", "insertion"] as const) {
test(`does not fill an answer when its observed question changes during ${changeAt}`, async ({ page }) => {
  const site = "https://bank.example.test";
  await page.route(`${site}/login`, (route) => route.fulfill({ contentType: "text/html", body:
    '<p id="question">First pet?</p><label>Security answer<input id="answer"></label>' }));
  await page.goto(`${site}/login`);
  const { keyboard } = await hostKeyboard(page);
  const changeQuestion = () => page.locator("#question").evaluate((element) => {
    element.textContent = "First school?";
  });
  if (changeAt === "focus")
    await page.locator("#answer").evaluate((element) => {
      element.addEventListener("focus", () => {
        const question = document.getElementById("question");
        if (question) question.textContent = "First school?";
      });
    });
  const insertions: string[] = [];
  const auth = await localSignIn(
    page,
    site,
    makeInputAsker(() => Effect.promise(async () => {
      if (changeAt === "protected prompting") await changeQuestion();
      return { private_answer: "synthetic-first-pet" };
    })),
    {
      insertText: (target, text) =>
        (changeAt === "insertion" ? Effect.promise(changeQuestion) : Effect.void).pipe(
          Effect.flatMap(() => keyboard.insertText(target, text)),
          Effect.tap((answer) => { insertions.push(answer); }),
        ),
    },
  );
  const { browser } = auth;
  // A refused field fails the step as a host refusal that submitted nothing. Whenever the question
  // changed, the minter hears it as a change on the screen, not as a field that blocks typing.
  const failure = await Effect.runPromise(Effect.flip(auth.fill({ fields: [{ selector: "#answer", slot: "private_answer", questionSelector: "#question" }] })));
  expect(failure).toMatchObject({
    authentication: {
      code: "AutofillRefused",
      hostRefusal: { check: "change", field: 0, slot: "private_answer", cause: "question_changed" },
      nothingSubmitted: true,
    },
  });
  expect(insertions).toEqual(changeAt === "protected prompting" ? [] : ["question_changed"]);
  expect(await page.locator("#answer").inputValue()).toBe("");
  expectNotCarried(browser.calls, "synthetic-first-pet");
});
}

// A sign-in the check showed signed in is over, so its code screen's selector no longer counts. A
// later sign-in that skipped the code, as on a remembered device, lands on an account page whose
// gift-card box matches that selector, and the site is signed in.
test("a later sign-in's check ignores an earlier sign-in's code selector on an account control", async ({ page }) => {
  const site = "https://bank.example.test";
  const codePage =
    '<p id="identity">Signed in</p><form id="challenge" method="post" action="/verify"><label>Email<input id="email" name="email"></label><label>Verification code<input name="code"></label><button id="verify">Verify</button></form>';
  await page.route(`${site}/login`, (route) => route.fulfill({ contentType: "text/html", body: codePage }));
  await page.route(`${site}/verify`, (route) => route.fulfill({ contentType: "text/html", body: codePage }));
  await page.goto(`${site}/login`);
  const auth = await localSignIn(page, site, makeInputAsker(() => Effect.succeed({ code: "482913" })));
  const indicator = { selector: "#identity" };
  const signedIn = (step: SignInStep) =>
    Effect.runPromise(auth.fill(step)).then(({ result }) => result);
  // The form's post carries the email and the code, so the sign-in sent the login.
  await Effect.runPromise(auth.fill({
    fields: [{ selector: "#email", accepts: ["email"] }, { selector: 'input[name="code"]', slot: "code" }],
    submit: "#verify",
  }));
  await page.waitForURL(`${site}/verify`);
  expect(await signedIn({ signedIn: indicator })).toMatchObject({ failed: "challenge_form_visible" });
  await page.locator("#challenge").evaluate((element) => { element.remove(); });
  expect(await signedIn({ signedIn: indicator })).toMatchObject({ signedIn: true });
  await page.setContent('<form><label>Password<input id="password" type="password"></label></form>');
  await Effect.runPromise(auth.fill({ fields: [{ selector: "#password", slot: "password" }] }));
  await page.setContent('<p id="identity">Signed in</p><form><label>Gift card code<input name="code"></label><button>Redeem</button></form>');
  expect(await Effect.runPromise(auth.check(indicator))).toEqual({ signedIn: true, url: `${site}/verify` });
});

// A redeem box on the account page can share the code field's generic label and name. The id the
// host recorded when it inspected the code field tells them apart, and the code form itself still
// asks.
test("a recorded code field's id tells it from a redeem box with the same label and name", async ({ page }) => {
  const site = "https://bank.example.test";
  await page.route(`${site}/login`, (route) => route.fulfill({ contentType: "text/html", body:
    '<form><label>Code<input name="code" id="otp"></label><button>Verify</button></form>' }));
  await page.goto(`${site}/login`);
  const auth = await localSignIn(page, site, makeInputAsker(() => Effect.succeed({ code: "482913" })));
  const indicator = { selector: "#identity" };
  await Effect.runPromise(auth.fill({ fields: [{ selector: 'role=textbox[name="Code"]', slot: "code" }] }));
  await page.setContent('<p id="identity">Signed in</p><form><label>Code<input name="code" id="otp"></label></form>');
  expect(await Effect.runPromise(auth.check(indicator))).toMatchObject({ failed: "challenge_form_visible" });
  await page.setContent('<p id="identity">Signed in</p><form><label>Code<input name="code" id="redeem"></label><button>Redeem</button></form>');
  expect(await Effect.runPromise(auth.check(indicator))).toEqual({ signedIn: true, url: `${site}/login` });
});

// The prompt holds at most 2,000 characters, so a long question is cut to leave room for the
// site's name before it, and the owner is still asked.
test("asks a question too long for the prompt after the site's name, cut to fit", async ({ page }) => {
  const site = "https://bank.example.test";
  const question = `${"Which of these did you pick ".repeat(80).trim()}?`.slice(-1982);
  await page.route(`${site}/login`, (route) => route.fulfill({ contentType: "text/html", body:
    `<p id="question">${question}</p><label>Security answer<input id="answer"></label>` }));
  await page.goto(`${site}/login`);
  const prompts: string[] = [];
  const auth = await localSignIn(page, site, makeInputAsker((request) => Effect.sync(() => {
    prompts.push(request.questions[0]?.prompt ?? "");
    return { private_answer: "synthetic-private-answer" };
  })));
  await Effect.runPromise(auth.fill({ fields: [{ selector: "#answer", slot: "private_answer", questionSelector: "#question" }] }));
  expect(prompts).toHaveLength(1);
  expect(prompts[0]?.length).toBeLessThanOrEqual(2000);
  expect(
    prompts[0]?.startsWith(
      `bank.example.test asks this security question: ${question.slice(0, 1900)}`,
    ),
  ).toBe(true);
  expect(prompts[0]?.endsWith("…")).toBe(true);
  expect(await page.locator("#answer").inputValue()).toBe("synthetic-private-answer");
});

// A recorded question the host could not read, as with no one visible match, is said so in the
// prompt rather than left for the field's label to stand in for.
test("says in the prompt that a recorded question could not be read", async ({ page }) => {
  const site = "https://bank.example.test";
  await page.route(`${site}/login`, (route) => route.fulfill({ contentType: "text/html", body:
    '<p class="question">First pet?</p><p class="question">First school?</p><label>Security answer<input id="answer"></label>' }));
  await page.goto(`${site}/login`);
  const prompts: string[] = [];
  const auth = await localSignIn(page, site, makeInputAsker((request) => Effect.sync(() => {
    prompts.push(request.questions[0]?.prompt ?? "");
    return { private_answer: "synthetic-private-answer" };
  })));
  await Effect.runPromise(auth.fill({ fields: [{ selector: "#answer", slot: "private_answer", questionSelector: ".question" }] }));
  expect(prompts).toEqual([
    'Enter your bank.example.test security answer. The question it answers could not be read from the page. The answer field reads "Security answer".',
  ]);
});

/**
 * Fills a code screen through local sign-in, by `selector`, then checks the signed-in page
 * `account`, as a check right after the code screen does in the same sign-in.
 */
const codeThenAccount = async (
  page: Page,
  codeForm: string,
  selector: string,
  account: string,
) => {
  const site = "https://bank.example.test";
  await page.route(`${site}/login`, (route) => route.fulfill({ contentType: "text/html", body: codeForm }));
  await page.goto(`${site}/login`);
  const auth = await localSignIn(page, site, makeInputAsker(() => Effect.succeed({ code: "482913" })));
  await Effect.runPromise(auth.fill({ fields: [{ selector, slot: "code" }] }));
  await page.setContent(`<p id="identity">Signed in</p>${account}`);
  return Effect.runPromise(auth.check({ selector: "#identity" }));
};

// The check right after a code screen runs in the same sign-in. A control on the signed-in page
// that the code's selector also matches, such as one a role name pattern matches, is no challenge
// unless it is the same control: the same words name it, with the type and autocomplete
// inspection recorded.
const codeForm = '<form><label>Verification code<input name="code" autocomplete="one-time-code"></label><button type="button">Verify</button></form>';
const roleCodeForm = '<form><label>Code<input name="otp"></label><button type="button">Verify</button></form>';
for (const [name, form, selector, account, failed] of [
  ["an editable gift-card box", codeForm, 'input[name="code"]', '<form><label>Gift card code<input name="code"></label><button>Redeem</button></form>', undefined],
  ["a Promo code textbox", roleCodeForm, 'role=textbox[name=/code/i]', '<form><label>Promo code<input name="promo"></label><button>Apply</button></form>', undefined],
  ["the code form itself, still showing", codeForm, 'input[name="code"]', codeForm, "challenge_form_visible"],
  ["the role-named code field itself, still showing", roleCodeForm, 'role=textbox[name=/code/i]', roleCodeForm, "challenge_form_visible"],
] as const)
  test(`a check right after a code screen ${failed === undefined ? "passes" : "refuses"} with ${name} on the page`, async ({ page }) => {
    expect(await codeThenAccount(page, form, selector, account)).toEqual(
      failed === undefined
        ? { signedIn: true, url: "https://bank.example.test/login" }
        : { signedIn: false, failed, url: "https://bank.example.test/login" },
    );
  });

// A verified sign-in through a private answer records its question selector in a version 1
// recipe, with no question text, answer or login value in it.
test("records a sign-in through a security question as a version 1 recipe without its question or answer", async ({ page }) => {
  const site = "https://bank.example.test";
  await page.route(`${site}/login`, (route) => route.fulfill({ contentType: "text/html", body:
    '<form method="post" action="/session"><label>Email<input id="email" name="email"></label><label>Password<input id="password" name="password" type="password"></label><button id="sign-in">Sign in</button></form>' }));
  await page.route(`${site}/session`, (route) => route.fulfill({ contentType: "text/html", body:
    '<form method="post" action="/answer"><p id="question">First pet?</p><label>Security answer<input id="answer" name="answer"></label><button id="continue">Continue</button></form>' }));
  await page.route(`${site}/answer`, (route) => route.fulfill({ contentType: "text/html", body:
    '<p id="identity">Signed in</p>' }));
  await page.goto(`${site}/login`);
  const auth = await localSignIn(page, site, makeInputAsker(() => Effect.succeed({ private_answer: "synthetic-first-pet" })));
  await Effect.runPromise(auth.recorder.step({
    fields: [{ selector: "#email", accepts: ["email"] }, { selector: "#password", slot: "password" }],
    submit: "#sign-in",
  }, `${site}/login#top`, Effect.void));
  await page.waitForURL(`${site}/session`);
  await Effect.runPromise(auth.fill({
    fields: [{ selector: "#answer", slot: "private_answer", questionSelector: "#question" }],
    submit: "#continue",
  }));
  await page.waitForURL(`${site}/answer`);
  expect(await Effect.runPromise(auth.fill({ signedIn: { selector: "#identity" } }))).toMatchObject({ verified: true });
  const published = auth.recorder.published();
  expect(published).toEqual({
    recipe: {
      version: 1,
      steps: [
        {
          page: `${site}/login`,
          fields: [{ selector: "#email", accepts: ["email"] }, { selector: "#password", slot: "password" }],
          submit: "#sign-in",
          submittedBy: "host",
        },
        {
          page: `${site}/session`,
          fields: [{ selector: "#answer", slot: "private_answer", questionSelector: "#question" }],
          submit: "#continue",
          submittedBy: "host",
        },
      ],
      signedIn: { selector: "#identity" },
    },
    entryUrl: `${site}/login`,
  });
  const text = JSON.stringify(published);
  for (const held of ["First pet", "synthetic-first-pet", login.username, login.password, "Security answer"])
    expect(text).not.toContain(held);
});

// A run replays such a recipe, here the version 3 an earlier build wrote: it asks for the login and
// the private answer on each run, from the question the screen shows then, and keeps neither once
// the run's sign-in is done.
test("a run's replay asks the private answer on every run, from the question its screen shows then", async ({ page }) => {
  test.slow();
  const site = "https://bank.example.test";
  const shown = { question: "First pet?" };
  await page.route(`${site}/login`, (route) => route.fulfill({ contentType: "text/html", body:
    '<form method="post" action="/session"><label>Email<input id="email" name="email"></label><label>Password<input id="password" name="password" type="password"></label><button id="sign-in">Sign in</button></form>' }));
  await page.route(`${site}/session`, (route) => route.fulfill({ contentType: "text/html", body:
    `<form method="post" action="/answer"><p id="question">${shown.question}</p><label>Security answer<input id="answer" name="answer"></label><button id="continue">Continue</button></form>` }));
  await page.route(`${site}/answer`, (route) => route.fulfill({ contentType: "text/html", body:
    '<p id="identity">Signed in</p>' }));
  const recipe = {
    version: 3,
    steps: [
      {
        page: `${site}/login`,
        fields: [{ selector: "#email", accepts: ["email"] }, { selector: "#password", slot: "password" }],
        submit: "#sign-in",
        submittedBy: "host",
      },
      {
        page: `${site}/session`,
        fields: [{ selector: "#answer", slot: "private_answer", questionSelector: "#question" }],
        submit: "#continue",
        submittedBy: "host",
      },
    ],
    signedIn: { selector: "#identity" },
  } as const;
  const browser = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const prompts: string[] = [];
  const answers = ["synthetic-first-pet", "synthetic-first-school"];
  /** One run's sign-in, with its own owner and masked values, as each run has. */
  const run = () => {
    const secrets = makeRunSecrets();
    const ask = makeInputAsker((request) =>
      Effect.sync(() => {
        const question = request.questions[0];
        prompts.push(question?.type === "credential" ? "login" : (question?.prompt ?? ""));
        return question?.type === "credential"
          ? { login: { ...login, saveLogin: false } }
          : { private_answer: answers[prompts.filter((prompt) => prompt !== "login").length - 1] };
      }),
    );
    return Effect.runPromise(
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
        site: "bank.example.test",
        siteOrigin: site,
      }),
    );
  };
  expect(await run()).toEqual({ alreadySignedIn: false });
  shown.question = "First school?";
  expect(await run()).toEqual({ alreadySignedIn: false });
  expect(prompts).toEqual([
    "login",
    "bank.example.test asks this security question: First pet?",
    "login",
    "bank.example.test asks this security question: First school?",
  ]);
  for (const value of [...answers, login.password]) expectNotCarried(browser.calls, value);
});

// A run reads a recipe's recorded rejection markers only as shown or not: on the screen's own
// origin, in the page or a frame on that origin, never in another site's frame or on a page the
// screen isn't on, and never through a selector that chains into other content.
test("the local rejection marker check reads only whether a marker shows, on the screen's own origin", async ({ page }) => {
  const site = "https://bank.example.test";
  await page.route(`${site}/login`, (route) => route.fulfill({ contentType: "text/html", body:
    '<p id="password-error">Wrong password</p><p id="code-error" hidden>Wrong code</p><iframe id="own" src="https://bank.example.test/frame"></iframe><iframe id="other" src="https://other.example.test/frame"></iframe><iframe id="sign-in" src="https://login.bank.example.test/frame"></iframe>' }));
  await page.route(`${site}/frame`, (route) => route.fulfill({ contentType: "text/html", body: '<p id="frame-error">Wrong answer</p>' }));
  await page.route("https://other.example.test/frame", (route) => route.fulfill({ contentType: "text/html", body: '<p id="other-error">Wrong answer</p>' }));
  await page.route("https://login.bank.example.test/frame", (route) => route.fulfill({ contentType: "text/html", body: '<p id="sign-in-error">Wrong answer</p>' }));
  await page.goto(`${site}/login`);
  await page.frameLocator("#own").locator("#frame-error").waitFor();
  await page.frameLocator("#other").locator("#other-error").waitFor();
  await page.frameLocator("#sign-in").locator("#sign-in-error").waitFor();
  const browser = await hostPage(page);
  const signIn = makeSignInBrowser({
    page: browser,
    keyboard: (await hostKeyboard(page)).keyboard,
    siteOrigin: site,
    authenticationOrigins: [],
    typing: { typed: false },
  });
  const shows = (selector: string, screen = `${site}/login`, popup?: { opener: "primary"; origin: string }) =>
    Effect.runPromise(signIn.markerVisible(selector, screen, popup));
  expect(await shows("#password-error")).toBe(true);
  expect(await shows("#code-error")).toBe(false);
  expect(await shows("#frame-error")).toBe(true);
  expect(await shows("#other-error")).toBe(false);
  // A screen on another origin of the site, or off the site, shows no marker on this page, even
  // in a frame on the screen's origin.
  expect(await shows("#password-error", "https://login.bank.example.test/login")).toBe(false);
  expect(await shows("#sign-in-error", "https://login.bank.example.test/login")).toBe(false);
  expect(await shows("#sign-in-error")).toBe(false);
  expect(await shows("#password-error", "https://elsewhere.test/login")).toBe(false);
  // A recorded popup that is gone shows none.
  expect(await shows("#password-error", `${site}/login`, { opener: "primary", origin: site })).toBe(false);
  // A selector that chains into other content is never read.
  const calls = browser.calls.length;
  expect(await shows("#password-error >> nth=0")).toBe(false);
  expect(await shows("internal:text=\"Wrong password\"")).toBe(false);
  expect(browser.calls.length).toBe(calls);
  // Each read answered only whether the marker shows.
  for (const { answer } of browser.calls.slice(-9)) expect(typeof answer === "boolean" || JSON.stringify(answer).includes("popup_missing")).toBe(true);
});
