import { test, expect } from "@playwright/test";
import {
  call,
  contextOf,
  execution,
  html,
  patch,
  probe,
  recordingGuardian,
  startSite,
  toolResult,
  type RecordedReview,
} from "./guardian-context-fixture.js";
import { executions, mint } from "./standalone-mint-fixture.js";

const capturePath = "captures/current-page.aria.yml";
/** The page capture Guardian read in `review`, all its chunks, as text. */
const captureOf = (review: RecordedReview | undefined) =>
  (review?.reads ?? [])
    .filter((read) => read["path"] === capturePath)
    .map((read) => String(read["source"]))
    .join("");
const secretQuestion = {
  intent: "Ask for the private code",
  questions: [{ id: "code", type: "secret", secretKind: "private_text", prompt: "Which code?" }],
};
const escaped = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

test("a secret the page shows with its whitespace collapsed, or form-encoded in its URL, never reaches Guardian", async () => {
  test.setTimeout(90_000);
  const secret = "correct  horse  battery";
  // The form sends the code in the URL, and the next page shows it back in a password field.
  const site = await startSite((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    if (url.pathname === "/done") {
      const code = url.searchParams.get("code") ?? "";
      html(
        response,
        `<title>Done</title><h1>Done</h1><input type="password" aria-label="Code" value="${escaped(code)}">`,
      );
      return;
    }
    html(
      response,
      `<title>Code</title><form method="get" action="/done"><input type="password" name="code" aria-label="Code"><button>Go</button></form>`,
    );
  });
  const guardian = recordingGuardian({ readPage: true });
  try {
    const { requests, last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      answer: () => ({ code: secret }),
      turns: [
        () =>
          patch({
            "explore/fill.mjs": probe(
              "await page.getByLabel('Code').fill('{{secret.s1}}'); return 1;",
            ),
            "explore/submit.mjs": probe(
              `await Promise.all([page.waitForURL("**/done**"), page.getByRole("button").click()]); return 1;`,
            ),
            "explore/look.mjs": probe(),
          }),
        () => [call("request_input", secretQuestion)],
        () => [call("execute", execution("explore", "explore/fill.mjs"), "fill")],
        () => [call("execute", execution("explore", "explore/submit.mjs"), "submit")],
        () => [call("execute", execution("explore", "explore/look.mjs"), "look")],
      ],
    });
    expect(toolResult(last, "submit"), JSON.stringify(toolResult(last, "submit"))).toMatchObject({
      status: "completed",
    });
    const look = executions(guardian.reviews)[2];
    expect(contextOf(look!)?.["currentPage"]).toMatchObject({ path: "/done?code=[private]" });
    expect(captureOf(look)).toContain('textbox "Code": [private]');
    // No form of the secret reaches Guardian or the minter: as given, as the page's snapshot
    // shows it, or as the form wrote it into the URL.
    for (const shown of [secret, "correct horse battery", "correct++horse++battery"]) {
      expect(JSON.stringify(guardian.reviews)).not.toContain(shown);
      expect(JSON.stringify(requests)).not.toContain(shown);
    }
  } finally {
    await site.close();
  }
});

test("a username with an apostrophe never reaches Guardian, in a quoted snapshot key or a URL's query", async () => {
  test.setTimeout(90_000);
  const username = "o'brien@example.com";
  // The form sends the login, the site redirects with it in the query as written, and the page's
  // heading holds ": ", so the snapshot single-quotes its key and doubles the apostrophe.
  const site = await startSite((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    if (url.pathname === "/signin") {
      response.statusCode = 302;
      response.setHeader("Location", `/account?u=${url.searchParams.get("login") ?? ""}`);
      response.end();
      return;
    }
    if (url.pathname === "/account") {
      html(
        response,
        `<title>Account</title><h1>Account: ${escaped(url.searchParams.get("u") ?? "")}</h1>`,
      );
      return;
    }
    html(
      response,
      `<title>Sign in</title><form method="get" action="/signin"><input name="login" aria-label="Login"><button>Go</button></form>`,
    );
  });
  const guardian = recordingGuardian({ readPage: true });
  try {
    const { requests, last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      answer: () => ({ code: username }),
      turns: [
        () =>
          patch({
            "explore/fill.mjs": probe(
              "await page.getByLabel('Login').fill('{{secret.s1}}'); return 1;",
            ),
            "explore/submit.mjs": probe(
              `await Promise.all([page.waitForURL("**/account**"), page.getByRole("button").click()]); return 1;`,
            ),
            "explore/look.mjs": probe(),
          }),
        () => [call("request_input", secretQuestion)],
        () => [call("execute", execution("explore", "explore/fill.mjs"), "fill")],
        () => [call("execute", execution("explore", "explore/submit.mjs"), "submit")],
        () => [call("execute", execution("explore", "explore/look.mjs"), "look")],
      ],
    });
    expect(toolResult(last, "submit"), JSON.stringify(toolResult(last, "submit"))).toMatchObject({
      status: "completed",
    });
    const look = executions(guardian.reviews)[2];
    expect(contextOf(look!)?.["currentPage"]).toMatchObject({ path: "/account?u=[private]" });
    expect(captureOf(look)).toContain(`'heading "Account: [private]" [level=1]'`);
    for (const shown of ["o'brien", "o''brien", "o%27brien"]) {
      expect(JSON.stringify(guardian.reviews)).not.toContain(shown);
      expect(JSON.stringify(requests)).not.toContain(shown);
    }
  } finally {
    await site.close();
  }
});

test("a secret the browser writes into a URL's path, with | encoded, never reaches Guardian", async () => {
  test.setTimeout(90_000);
  const secret = "a$b|c";
  // The site redirects to a path holding the login as written; the browser writes | as %7C there
  // and leaves $ as it is, which no query or encodeURIComponent form matches.
  const site = await startSite((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    if (url.pathname === "/signin") {
      response.statusCode = 302;
      response.setHeader("Location", `/u/${url.searchParams.get("login") ?? ""}`);
      response.end();
      return;
    }
    if (url.pathname.startsWith("/u/")) {
      html(response, "<title>Profile</title><h1>Profile</h1>");
      return;
    }
    html(
      response,
      `<title>Sign in</title><form method="get" action="/signin"><input name="login" aria-label="Login"><button>Go</button></form>`,
    );
  });
  const guardian = recordingGuardian({ readPage: true });
  try {
    const { requests, last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      answer: () => ({ code: secret }),
      turns: [
        () =>
          patch({
            "explore/fill.mjs": probe(
              "await page.getByLabel('Login').fill('{{secret.s1}}'); return 1;",
            ),
            "explore/submit.mjs": probe(
              `await Promise.all([page.waitForURL("**/u/**"), page.getByRole("button").click()]); return 1;`,
            ),
            "explore/look.mjs": probe(),
          }),
        () => [call("request_input", secretQuestion)],
        () => [call("execute", execution("explore", "explore/fill.mjs"), "fill")],
        () => [call("execute", execution("explore", "explore/submit.mjs"), "submit")],
        () => [call("execute", execution("explore", "explore/look.mjs"), "look")],
      ],
    });
    expect(toolResult(last, "submit"), JSON.stringify(toolResult(last, "submit"))).toMatchObject({
      status: "completed",
    });
    const look = executions(guardian.reviews)[2];
    expect(contextOf(look!)?.["currentPage"]).toMatchObject({ path: "/u/[private]" });
    for (const shown of [secret, "a$b%7Cc", "a$b%7cc"]) {
      expect(JSON.stringify(guardian.reviews)).not.toContain(shown);
      expect(JSON.stringify(requests)).not.toContain(shown);
    }
  } finally {
    await site.close();
  }
});

test("a page over the element limit is not captured, and the browser keeps working", async () => {
  test.setTimeout(90_000);
  const items = Array.from(
    { length: 4_000 },
    (_, index) => `<li><a href="/item/${index}">Item ${index}</a><button>Add</button></li>`,
  ).join("");
  const site = await startSite((_request, response) =>
    html(response, `<title>Catalog</title><ul>${items}</ul>`),
  );
  const guardian = recordingGuardian({ readPage: true });
  try {
    const { last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      turns: [
        () => patch({ "explore/look.mjs": probe() }),
        () => [call("execute", execution("explore", "explore/look.mjs"), "first")],
        () => [call("execute", execution("explore", "explore/look.mjs"), "second")],
      ],
    });
    expect(toolResult(last, "first")).toMatchObject({ status: "completed" });
    expect(toolResult(last, "second")).toMatchObject({ status: "completed" });
    const second = executions(guardian.reviews)[1];
    // Guardian still knows where the page is, and why it has no capture.
    expect(contextOf(second!)?.["currentPage"]).toMatchObject({ path: "/" });
    expect(captureOf(second)).toMatch(
      /^Page too large to capture: [\d,]+ elements, over the 10,000 the host reads\.$/u,
    );
    expect(captureOf(second)).not.toContain("Item 1");
  } finally {
    await site.close();
  }
});

test("a capture cut at 256 KiB keeps no prefix of a secret the cut split, even one given later", async () => {
  test.setTimeout(90_000);
  const secret = "fixture-private-value";
  // The snapshot reads "- paragraph: " and then the text, so the 256 KiB cut falls inside the
  // secret, after its first ten characters.
  const filler = "x".repeat(256 * 1024 - "- paragraph: ".length - 10);
  const site = await startSite((_request, response) =>
    html(response, `<title>Long</title><p>${filler}${secret} tail</p>`),
  );
  const guardian = recordingGuardian({ readPage: true });
  try {
    const { last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      answer: () => ({ code: secret }),
      turns: [
        () => patch({ "explore/look.mjs": probe() }),
        () => [call("execute", execution("explore", "explore/look.mjs"), "first")],
        // The owner gives the value only after the page was captured.
        () => [call("request_input", secretQuestion)],
        () => [call("execute", execution("explore", "explore/look.mjs"), "second")],
      ],
    });
    expect(toolResult(last, "second")).toMatchObject({ status: "completed" });
    const capture = captureOf(executions(guardian.reviews)[1]);
    expect(capture.endsWith("\n…[truncated at 256 KiB]")).toBe(true);
    expect(capture.slice(0, capture.lastIndexOf("\n…"))).toMatch(/x$/u);
    expect(JSON.stringify(guardian.reviews)).not.toContain("fixture-p");
  } finally {
    await site.close();
  }
});

test("a page that stays busy is not captured, and the browser outlives it", async () => {
  test.setTimeout(120_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>Busy</title><h1>Busy</h1>"),
  );
  const guardian = recordingGuardian({ readPage: true });
  try {
    const { last } = await mint({
      effect: "read",
      url: site.url,
      guardian,
      turns: [
        () =>
          patch({
            // The page's main thread stays busy for longer than the host waits for a capture.
            "explore/busy.mjs": probe(
              "await page.evaluate(() => { setTimeout(() => { const end = Date.now() + 25000; while (Date.now() < end); }, 0); }); await new Promise((resolve) => setTimeout(resolve, 300)); return 1;",
            ),
            // The next step waits for the page to answer again.
            "explore/after.mjs": probe().replace("timeout_sec:5", "timeout_sec:60"),
          }),
        () => [call("execute", execution("explore", "explore/busy.mjs"), "busy")],
        () => [
          call(
            "execute",
            execution("explore", "explore/after.mjs", { timeoutSeconds: 60 }),
            "after",
          ),
        ],
      ],
    });
    expect(toolResult(last, "busy")).toMatchObject({ status: "completed" });
    expect(toolResult(last, "after"), JSON.stringify(toolResult(last, "after"))).toMatchObject({
      status: "completed",
    });
    const after = executions(guardian.reviews)[1];
    expect(contextOf(after!)?.["currentPage"]).toMatchObject({ path: "/" });
    expect(captureOf(after)).toMatch(/^Page not captured: /u);
  } finally {
    await site.close();
  }
});
