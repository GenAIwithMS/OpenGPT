import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import { chromium as patchright } from "patchright";
import { inspectAutofillStep, type AutofillStep } from "../../src/destinations/autofill-step.js";
import { fillAutofillStep, resubmitAutofillStep } from "../../src/destinations/autofill-fill.js";
import { expectNotCarried, hostKeyboard, hostPage } from "./autofill-host-page.js";

// A page built as one server form around everything, as some older sites are: its cookie notice
// sits inside that form and covers the sign-in, and the notice's only control is a button with no
// type, so a click of it would submit the form. Its own click handler stores the choice and hides
// the notice, and the sign-in posts the form from script. The notice shows again on every fresh
// browser. Chromium must lay out the notice over the sign-in and run the form's own submission.
const site = "https://portal.example.test";
const username = "synthetic-agent";
const password = "synthetic-in-form-password";
const signInStep: AutofillStep = {
  fields: [
    { selector: "#username", slot: "username" },
    { selector: "#password", slot: "password" },
  ],
  submit: "#login",
};
const dismissed: AutofillStep = { ...signInStep, dismiss: "#cookie-accept" };

/**
 * The sign-in page: `noticeStyle` places the notice, `noticeExtra` adds markup inside it,
 * `formExtra` adds markup to the form outside it, and `accepted` runs in the notice's click handler
 * once it stored the choice.
 */
const loginPage = ({
  noticeStyle = "position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:10",
  noticeExtra = "",
  formExtra = "",
  accepted = "",
} = {}) => `<form id="main" method="post" action="/login">
<input type="hidden" name="target" value="">
<div id="cookie-notice" role="dialog" aria-label="Cookie notice" style="${noticeStyle}">
<p>This site uses cookies.</p><button id="cookie-accept">Accept</button>${noticeExtra}</div>
<label>Username<input id="username" name="username"></label>
<label>Password<input id="password" name="password" type="password"></label>
<a id="login" href="#" onclick="event.preventDefault(); postBack('login')">Log in</a>
${formExtra}</form>
<script>
const notice = document.getElementById("cookie-notice");
if (localStorage.getItem("cookies") === "accepted") notice.style.display = "none";
document.getElementById("cookie-accept").addEventListener("click", () => {
  localStorage.setItem("cookies", "accepted");
  notice.style.display = "none";
  ${accepted}
});
function postBack(target) {
  const form = document.forms.main;
  form.elements.target.value = target;
  form.submit();
}
</script>`;

/**
 * Serves the sign-in page and keeps each form the site received. A form the notice's own code
 * posts gets the sign-in page back, as a server form's postback does.
 */
const serve = async (page: Page, body = loginPage()) => {
  const received: Record<string, string>[] = [];
  await page.route(`${site}/**`, async (route) => {
    if (route.request().method() === "POST") {
      const form = Object.fromEntries(new URLSearchParams(route.request().postData() ?? ""));
      received.push(form);
      await route.fulfill({
        contentType: "text/html",
        body: form["target"] === "accept" ? body : '<p id="account">Signed in</p>',
      });
    } else await route.fulfill({ contentType: "text/html", body });
  });
  await page.goto(`${site}/login`);
  return received;
};

/** The host's page and keyboard, counting each value the keyboard typed. */
const host = async (page: Page, { patchright = false } = {}) => {
  const typed: string[] = [];
  const { keyboard } = await hostKeyboard(page);
  return {
    page: await hostPage(page, [], { patchright }),
    typed,
    keyboard: {
      insertText: (...args: Parameters<typeof keyboard.insertText>) =>
        Effect.suspend(() => {
          typed.push(args[1]);
          return keyboard.insertText(...args);
        }),
    },
  };
};

const inspect = (hosted: Awaited<ReturnType<typeof host>>, step: AutofillStep) =>
  Effect.runPromise(
    inspectAutofillStep({ step, page: hosted.page, siteOrigin: site, authenticationOrigins: [] }),
  ).then((inspection) => {
    if ("outcome" in inspection) throw new Error(`Inspection refused: ${inspection.reason}`);
    return inspection;
  });

const fill = async (hosted: Awaited<ReturnType<typeof host>>, step: AutofillStep) =>
  Effect.runPromise(
    fillAutofillStep({
      step,
      values: [username, password],
      inspection: await inspect(hosted, step),
      page: hosted.page,
      keyboard: hosted.keyboard,
      settleMs: 1_000,
    }),
  );

const signedIn = { target: "login", username, password };
/** The form the notice's own code posts with submit(): the fields emptied, nothing typed. */
const acceptedEmpty = { target: "accept", username: "", password: "" };

/** The step sent again after its fill was blocked, as the host clicks a blocked screen again. */
const resubmit = async (hosted: Awaited<ReturnType<typeof host>>) =>
  Effect.runPromise(
    resubmitAutofillStep({
      step: dismissed,
      inspection: await inspect(hosted, dismissed),
      page: hosted.page,
      settleMs: 1_000,
    }),
  );

/** What the notice's own handler read of each field when it ran: lengths only. */
const seenAtAccept = `sessionStorage.setItem("seen", [document.getElementById("username").value.length, document.getElementById("password").value.length].join(","));`;

test("a covering notice's own control that would submit the sign-in form is clicked with its submission cancelled: the notice hides, nothing is sent, and the sign-in posts once", async ({
  page,
}) => {
  const received = await serve(page);
  const hosted = await host(page);
  await expect(page.locator("#cookie-notice")).toBeVisible();
  const report = await fill(hosted, dismissed);
  expect(report).toMatchObject({
    outcome: "filled",
    fields: [
      { slot: "username", status: "filled" },
      { slot: "password", status: "filled" },
    ],
    submit: "clicked",
  });
  expect(received).toEqual([signedIn]);
  expect(await page.evaluate(() => localStorage.getItem("cookies"))).toBe("accepted");
  expect(hosted.typed).toEqual([username, password]);
  expectNotCarried(hosted.page.calls, password);
});

// Kernel's browsers run Patchright, which evaluates in its own world by default.
test("on Patchright too, the covering notice's own control is clicked with its submission cancelled, and the sign-in posts once", async () => {
  const browser = await patchright.launch({ headless: true });
  try {
    // Patchright's page has Playwright's API, declared by its own copy of Playwright's types.
    const page = (await browser.newPage()) as unknown as Page;
    const received = await serve(page);
    const report = await fill(await host(page, { patchright: true }), dismissed);
    expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
    expect(received).toEqual([signedIn]);
    expect(await page.evaluate(() => localStorage.getItem("cookies"))).toBe("accepted");
  } finally {
    await browser.close();
  }
});

test("on Patchright too, a notice that caught the click after typing is dismissed with the fields emptied first, and its handler's own submit() sends nothing typed", async () => {
  const browser = await patchright.launch({ headless: true });
  try {
    const page = (await browser.newPage()) as unknown as Page;
    const received = await serve(page, loginPage({ accepted: `${seenAtAccept} postBack('accept');` }));
    const hosted = await host(page, { patchright: true });
    expect(await fill(hosted, signInStep)).toMatchObject({ outcome: "filled", submit: "blocked" });
    expect(await resubmit(hosted)).toMatchObject({ outcome: "filled", submit: "not_attempted" });
    expect(await page.evaluate(() => sessionStorage.getItem("seen"))).toBe("0,0");
    expect(received).toEqual([acceptedEmpty]);
    expect(await fill(hosted, dismissed)).toMatchObject({ outcome: "filled", submit: "clicked" });
    expect(received).toEqual([acceptedEmpty, signedIn]);
  } finally {
    await browser.close();
  }
});

test("a fresh browser shows the notice again, and the same step dismisses it and signs in with one post", async ({
  browser,
}) => {
  for (let run = 0; run < 2; run++) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const received = await serve(page);
      await expect(page.locator("#cookie-notice")).toBeVisible();
      const report = await fill(await host(page), dismissed);
      expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
      expect(received).toEqual([signedIn]);
      await expect(page.locator("#account")).toBeVisible();
    } finally {
      await context.close();
    }
  }
});

test("a notice that caught the sign-in's click after typing is dismissed with the fields emptied first and its submission cancelled; the screen filled again posts once", async ({
  page,
}) => {
  const received = await serve(page, loginPage({ accepted: seenAtAccept }));
  const hosted = await host(page);
  const blocked = await fill(hosted, signInStep);
  expect(blocked).toMatchObject({ outcome: "filled", submit: "blocked", blockedBy: { tag: "div", role: "dialog" } });
  expect(received).toEqual([]);

  // The click again finds the fields it emptied, so it clicks nothing, and the screen is filled
  // again, as a refill.
  const again = await resubmit(hosted);
  expect(again).toMatchObject({ outcome: "filled", submit: "not_attempted" });
  expect(await page.evaluate(() => sessionStorage.getItem("seen"))).toBe("0,0");
  expect(await page.evaluate(() => localStorage.getItem("cookies"))).toBe("accepted");
  expect(received).toEqual([]);

  const report = await fill(hosted, dismissed);
  expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
  expect(received).toEqual([signedIn]);
  expect(hosted.typed).toEqual([username, password, username, password]);
});

test("a notice drawn only once the fields hold input, inside the sign-in form, is dismissed with the fields emptied first, and the host types them again and submits once", async ({
  page,
}) => {
  const received = await serve(
    page,
    loginPage({ noticeStyle: "display:none", accepted: seenAtAccept }).replace(
      "</script>",
      `document.getElementById("password").addEventListener("input", () => {
  if (localStorage.getItem("cookies") !== "accepted")
    notice.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:10";
}, { once: true });
</script>`,
    ),
  );
  const hosted = await host(page);
  const report = await fill(hosted, dismissed);
  expect(report).toMatchObject({
    outcome: "filled",
    fields: [
      { slot: "username", status: "filled" },
      { slot: "password", status: "filled" },
    ],
    submit: "clicked",
  });
  expect(await page.evaluate(() => sessionStorage.getItem("seen"))).toBe("0,0");
  expect(received).toEqual([signedIn]);
  expect(hosted.typed).toEqual([username, password, username, password]);
  expectNotCarried(hosted.page.calls, password);
});

test("a notice whose own handler loads the page again is dismissed, and the fields are found again before typing", async ({
  page,
}) => {
  const loads: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "GET" && request.isNavigationRequest()) loads.push(request.url());
  });
  const received = await serve(page, loginPage({ accepted: "location.reload();" }));
  const hosted = await host(page);
  const report = await fill(hosted, dismissed);
  expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
  expect(loads).toEqual([`${site}/login`, `${site}/login`]);
  expect(received).toEqual([signedIn]);
  expect(hosted.typed).toEqual([username, password]);
});

for (const [named, accepted, early] of [
  // submit() fires no submit event, so the form goes out, with the fields the host emptied.
  ["posts the form from script with submit()", "postBack('accept');", [acceptedEmpty]],
  ["submits the form with requestSubmit()", "document.forms.main.requestSubmit();", []],
] as const) {
  test(`a notice whose own handler ${named} before typing sends nothing typed, and the step's own submit posts once`, async ({
    page,
  }) => {
    const received = await serve(page, loginPage({ accepted }));
    const hosted = await host(page);
    const report = await fill(hosted, dismissed);
    expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
    expect(received).toEqual([...early, signedIn]);
  });

  test(`a notice whose own handler ${named} after typing never sends what was typed, and the step's own submit later posts exactly once`, async ({
    page,
  }) => {
    const received = await serve(page, loginPage({ accepted: `${seenAtAccept} ${accepted}` }));
    const hosted = await host(page);
    expect(await fill(hosted, signInStep)).toMatchObject({ outcome: "filled", submit: "blocked" });
    expect(await resubmit(hosted)).toMatchObject({ outcome: "filled", submit: "not_attempted" });
    expect(await page.evaluate(() => sessionStorage.getItem("seen"))).toBe("0,0");
    expect(received).toEqual(early);
    expect(await fill(hosted, dismissed)).toMatchObject({ outcome: "filled", submit: "clicked" });
    expect(received).toEqual([...early, signedIn]);
    expect(hosted.typed).toEqual([username, password, username, password]);
  });
}

test("a notice whose own handler submits the form later, after the click, never sends what was typed: the fields were emptied before the click", async ({
  page,
}) => {
  const received = await serve(page, loginPage({ accepted: "setTimeout(() => postBack('accept'), 300);" }));
  const hosted = await host(page);
  expect(await fill(hosted, signInStep)).toMatchObject({ outcome: "filled", submit: "blocked" });
  expect(await resubmit(hosted)).toMatchObject({ outcome: "filled", submit: "not_attempted" });
  await expect.poll(() => received.length).toBe(1);
  // The page's own late submission is out of the host's reach, but carries nothing typed.
  expect(received).toEqual([acceptedEmpty]);
});

test("the cancelled submission is the dismiss click's alone: once the notice is gone, the form's own submit still posts", async ({
  page,
}) => {
  const received = await serve(
    page,
    loginPage().replace(
      `<a id="login" href="#" onclick="event.preventDefault(); postBack('login')">Log in</a>`,
      `<button id="login">Log in</button>`,
    ),
  );
  const report = await fill(await host(page), dismissed);
  expect(report).toMatchObject({ outcome: "filled", submit: "clicked" });
  expect(received).toEqual([{ target: "", username, password }]);
});

for (const [named, dismiss, options] of [
  ["the sign-in's submit", "#login", {}],
  ["a field of the sign-in", "#username", {}],
  [
    "a control of the sign-in form outside the notice that submits it",
    "#forgot",
    { formExtra: '<button id="forgot" name="forgot">Forgot password?</button>' },
  ],
  [
    "a link to another page inside the notice",
    "#privacy",
    { noticeExtra: '<a id="privacy" href="/privacy">Privacy</a>' },
  ],
  [
    "a control in the sign-in form of a notice that covers none of the step's controls",
    "#cookie-accept",
    { noticeStyle: "position:fixed;bottom:0;right:0;width:200px;height:60px;z-index:10;background:#fff" },
  ],
] as const)
  test(`a dismiss that names ${named} is still refused before anything is typed`, async ({ page }) => {
    const received = await serve(page, loginPage(options));
    const hosted = await host(page);
    const report = await fill(hosted, { ...signInStep, dismiss });
    expect(report).toMatchObject({ outcome: "refused", reason: "dismiss_refused" });
    expect(hosted.typed).toEqual([]);
    expect(received).toEqual([]);
    expect(page.url()).toBe(`${site}/login`);
  });
