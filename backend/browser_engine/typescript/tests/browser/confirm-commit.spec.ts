import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { confirmCommitCode, waitCode } from "../../src/browser/wait.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";

// `confirmCommit` judges a write's final commit from the `{ response }` answer of the click's
// `waitForOutcomeResult` and the page, as a Kernel call body runs it (`page` in scope), pasted
// after `waitCode`. Each case is a synthetic record form whose Save posts to the site and then
// draws what the site drew. The page must render: visibility and the field marks are what the
// page check reads.
const origin = "https://records.example.test";

interface Reply {
  readonly status: number;
  readonly body?: string;
  readonly contentType?: string;
  readonly headers?: Record<string, string>;
}

interface Case {
  readonly name: string;
  readonly reply: Reply;
  /** Markup on the page before the click, beside the form. */
  readonly extra?: string;
  /** Page script run once the commit request answered, with `reply` the fetch Response. */
  readonly after?: string;
  /** Replaces Save's whole handler. */
  readonly click?: string;
  readonly outcome?: string;
  readonly expected: Record<string, unknown>;
}

const page = (each: Pick<Case, "extra" | "after" | "click">) => `
  <form id="record" aria-label="Edit record" novalidate>
    <label for="email" id="email-label">Email</label>
    <input id="email" name="email" value="a@example.test" aria-describedby="email-help">
    <span id="email-help"></span>
    <button type="button" id="save">Save</button>
  </form>
  ${each.extra ?? ""}
  <div id="messages"></div>
  <script>
    const say = (html) => document.querySelector("#messages").insertAdjacentHTML("beforeend", html);
    document.querySelector("#save").onclick = async () => {
      ${each.click ?? `const reply = await fetch("/api/records", { method: "POST", body: JSON.stringify({ email: "a@example.test" }) });
      ${each.after ?? ""}`}
    };
  </script>`;

// The commit call: waitCode, the commit paste just before the click's wait, then the check.
const commitCall = `${waitCode}
  const form = page.getByRole("form", { name: "Edit record" });
  ${confirmCommitCode}
  const answer = await waitForOutcomeResult({
    invalid: { invalid: form },
    saved: { response: { method: "POST", url: "/api/records" } },
  }, { action: () => page.locator("#save").click(), noProgressMs: 600, timeout: 4000, unchangedMs: 300 });
  return { outcome: answer.outcome, confirmed: await confirmCommit(answer, page) };`;

const run = async (browserPage: Page, code: string) => {
  const answer = await makeLocalKernel(browserPage).browsers.playwright.execute("session-1", {
    timeout_sec: 10,
    code,
  });
  if (!answer.success) throw new Error(String(answer.error));
  return answer.result;
};

/** Serves the form at `/`, answers the commit with `reply`, and runs the commit call. */
const confirm = async (browserPage: Page, each: Case) => {
  await browserPage.context().route(`${origin}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "GET")
      return route.fulfill({ status: 200, contentType: "text/html", body: page(each) });
    return route.fulfill({
      status: each.reply.status,
      contentType: each.reply.contentType ?? "application/json",
      body: each.reply.body ?? "",
      ...(each.reply.headers === undefined ? {} : { headers: each.reply.headers }),
    });
  });
  await browserPage.goto(`${origin}/`);
  return (await run(browserPage, commitCall)) as { outcome: string; confirmed: Record<string, unknown> };
};

const json = (value: unknown) => JSON.stringify(value);
const saved = { status: 200, body: json({ success: true }) };
const done = { state: "done", status: "completed" };
const notDone = { state: "not_done", status: "failed" };
const unclear = { state: "unclear", status: "unconfirmed" };

const cases: readonly Case[] = [
  { name: "a 200 whose body reports success true is done", reply: { status: 200, body: json({ success: true, id: "r-7" }) }, expected: done },
  { name: "a 200 whose body reports success false is not done", reply: { status: 200, body: json({ success: false }) }, expected: notDone },
  { name: "a 200 whose body reports success as an error word is not done", reply: { status: 200, body: json({ success: "error" }) }, expected: notDone },
  {
    name: "a 202 whose body says the work is queued is done, with the site's word",
    reply: { status: 202, body: json({ status: "Queued" }) },
    expected: { state: "done", status: "queued", status_label: "Queued" },
  },
  {
    name: "a 200 whose body lists errors is not done",
    reply: { status: 200, body: json({ data: null, errors: [{ message: "Email is already in use" }] }) },
    expected: notDone,
  },
  { name: "a 422 is not done", reply: { status: 422, body: json({ message: "Email is not valid" }) }, expected: notDone },
  {
    name: "a 200 followed by the page marking a field invalid is not done",
    reply: saved,
    // Drawn a moment after the response wins the wait, as a page that renders its answer late.
    after: `setTimeout(() => {
        document.querySelector("#email").setAttribute("aria-invalid", "true");
        document.querySelector("#email-help").textContent = "Enter a valid email";
      }, 200);`,
    expected: notDone,
  },
  {
    name: "a page alert whose text equals the body's message is still not done",
    reply: { status: 200, body: json({ success: true, message: "The start date must be after today." }) },
    after: `const body = await reply.json();
      say('<div role="alert" class="alert alert-danger">' + body.message + '</div>');`,
    expected: notDone,
  },
  {
    name: "a 200 followed by a message styled as an error is not done",
    reply: { status: 200, body: json({ id: "r-7" }) },
    after: `say('<span class="field-validation-error">Start date is required</span>');`,
    expected: notDone,
  },
  {
    name: "a body that wraps its JSON in a string still reports its failure",
    reply: { status: 200, body: json({ d: json({ Success: false, Message: "Rate unavailable" }) }) },
    expected: notDone,
  },
  {
    name: "an announcement only a screen reader hears leaves the commit done",
    reply: { status: 200, body: json({ Success: "True" }) },
    after: `say('<p role="alert" aria-live="assertive" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Record r-7</p>');`,
    expected: done,
  },
  {
    name: "a 201 whose Location names the new record is done at once",
    reply: { status: 201, body: "", headers: { location: "/records/r-7" } },
    expected: done,
  },
  {
    name: "a success toast drawn with the alert role leaves the commit done",
    reply: { status: 200, body: json({ success: true, message: "Record saved with no errors" }) },
    after: `say('<div role="alert" class="alert alert-success">Record saved</div>');`,
    expected: done,
  },
  { name: "a success value the body leaves ambiguous is unclear", reply: { status: 200, body: json({ success: "maybe" }) }, expected: unclear },
  {
    name: "an alert with neither error nor success styling or words is unclear",
    reply: saved,
    after: `say('<div role="alert">Your changes were sent to the reviewer.</div>');`,
    expected: unclear,
  },
  {
    name: "an answer with no commit response, where the form marked a field invalid, is not done",
    reply: saved,
    click: `document.querySelector("#email").setAttribute("aria-invalid", "true");
      document.querySelector("#email-help").textContent = "Enter a valid email";`,
    outcome: "invalid",
    expected: notDone,
  },
  // The page's own furniture, drawn again after the save, is no error: a required asterisk, a
  // Delete link, a count badge and a hint inside a label.
  {
    name: "a required asterisk styled as danger leaves the commit done",
    reply: saved,
    after: `document.querySelector("#email-label").insertAdjacentHTML("afterend", '<span class="text-danger">*</span>');`,
    expected: done,
  },
  {
    name: "a Delete link styled as danger leaves the commit done",
    reply: saved,
    after: `say('<a class="btn btn-danger" href="#delete">Delete record</a>');`,
    expected: done,
  },
  {
    name: "a danger badge holding a count leaves the commit done",
    reply: saved,
    after: `say('<span class="badge bg-danger">3</span>');`,
    expected: done,
  },
  {
    name: "a red required hint inside a label leaves the commit done",
    reply: saved,
    after: `document.querySelector("#email-label").innerHTML = 'Email <span class="text-danger">(required)</span>';`,
    expected: done,
  },
  {
    name: "an error message already on the page before the click, unchanged, leaves the commit done",
    reply: saved,
    extra: `<div class="alert alert-danger">Your last payment failed</div>`,
    expected: done,
  },
  {
    name: "an alert that reports a save beside a requirement is unclear",
    reply: saved,
    after: `say('<div role="alert">Record saved. A signed form is required before it takes effect.</div>');`,
    expected: unclear,
  },
  {
    name: "a message styled as an error with no words of one is unclear",
    reply: saved,
    after: `say('<div class="alert alert-danger">Rate unavailable for this class</div>');`,
    expected: unclear,
  },
  {
    name: "a validation summary longer than 500 characters is still read",
    reply: saved,
    after: `say('<div class="validation-summary-errors"><ul>' +
        Array.from({ length: 12 }, (_, i) => '<li>Contact ' + (i + 1) + ' date of birth is required for this record</li>').join("") +
        '</ul></div>');`,
    expected: notDone,
  },
  // A body that says it failed in other words, or that can't be read as JSON, proves nothing.
  {
    name: "a body message saying it was unable to save is unclear",
    reply: { status: 200, body: json({ message: "Unable to save the record. Please try again." }) },
    expected: unclear,
  },
  {
    name: "a body message naming a required value is unclear",
    reply: { status: 200, body: json({ message: "Account number is required" }) },
    expected: unclear,
  },
  {
    name: "a body message saying it could not be saved is unclear",
    reply: { status: 200, body: json({ Message: "The record could not be saved." }) },
    expected: unclear,
  },
  {
    name: "an XML body is unclear",
    reply: { status: 200, body: "<Result><Success>false</Success></Result>", contentType: "application/xml" },
    expected: unclear,
  },
  { name: "a body status of declined is unclear", reply: { status: 200, body: json({ status: "Declined" }) }, expected: unclear },
  // A page that draws its messages again keeps the ones it showed before the click.
  {
    name: "an error message drawn again with the same text after the save leaves the commit done",
    reply: saved,
    extra: `<div id="main"><div class="alert alert-danger">Your last payment failed</div></div>`,
    after: `document.querySelector("#main").innerHTML =
        '<div class="alert alert-danger">Your last payment failed</div><div class="alert alert-success" role="alert">Record saved</div>';`,
    expected: done,
  },
  {
    name: "a field still flagged as it was before the click is unclear",
    reply: saved,
    extra: `<script>
      document.querySelector("#email").setAttribute("aria-invalid", "true");
      document.querySelector("#email-help").textContent = "Enter a valid email";
    </script>`,
    expected: unclear,
  },
  // A write may itself reject or deny something, so those words prove nothing on their own.
  { name: "a body status of rejected is unclear", reply: { status: 200, body: json({ status: "rejected" }) }, expected: unclear },
  {
    name: "a toast saying a request was rejected is unclear",
    reply: saved,
    after: `say('<div role="alert" class="toast">Request rejected</div>');`,
    expected: unclear,
  },
  {
    name: "errors deep in a body still report the failure",
    reply: { status: 200, body: json({ data: { records: { save: { userErrors: [{ message: "Name is taken" }] } } } }) },
    expected: notDone,
  },
  { name: "an error field that says no error leaves the commit done", reply: { status: 200, body: json({ error: "No error" }) }, expected: done },
  {
    name: "an errors field holding only empty lists leaves the commit done",
    reply: { status: 200, body: json({ errors: { email: [] } }) },
    expected: done,
  },
  // A message whose text was on the page before counts again when more elements show it after.
  {
    name: "a refusal repeating a hint's text in one more element is not done",
    reply: { status: 200, body: json({ id: 1 }) },
    extra: `<span class="text-danger">Required</span>`,
    after: `say('<div class="invalid-feedback">Required</div>');`,
    expected: notDone,
  },
  {
    name: "a second alert identical to one shown before the click is not done",
    reply: { status: 200, body: json({ id: 1 }) },
    extra: `<div role="alert" class="alert alert-danger">Something went wrong. Please try again.</div>`,
    after: `say('<div role="alert" class="alert alert-danger">Something went wrong. Please try again.</div>');`,
    expected: notDone,
  },
  // Settings and record fields that only name errors say nothing about the save.
  {
    name: "a setting for what to do on an error leaves the commit done",
    reply: { status: 200, body: json({ id: 1, notifyOnError: true }) },
    expected: done,
  },
  {
    name: "a record's setting to continue on an error leaves the commit done",
    reply: { status: 200, body: json({ data: { record: { continueOnError: true } } }) },
    expected: done,
  },
  {
    name: "a deep record field holding a past sync error leaves the commit done",
    reply: { status: 200, body: json({ data: { account: { integration: { lastSyncError: "Token expired" } } } }) },
    expected: done,
  },
  {
    name: "a deep setting to stop on an error leaves the commit done",
    reply: { status: 200, body: json({ data: { project: { pipeline: { settings: { stopOnError: true } } } } }) },
    expected: done,
  },
  {
    name: "error fields holding nothing leave the commit done",
    reply: { status: 200, body: json({ data: { record: { lastRunErrors: [], validationErrors: null } } }) },
    expected: done,
  },
  {
    name: "an error flag that is true is not done",
    reply: { status: 200, body: json({ hasErrors: true }) },
    expected: notDone,
  },
];

/** Serves `pages` by path and query, or path alone, and answers each POST by its path. */
const localSite = async (
  pages: Record<string, string>,
  post: (path: string) => { status: number; headers?: Record<string, string> },
) => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST") {
      request.resume();
      request.on("end", () => {
        const answer = post(url.pathname);
        response.writeHead(answer.status, answer.headers);
        response.end();
      });
      return;
    }
    const html = pages[url.pathname + url.search] ?? pages[url.pathname];
    response.writeHead(html === undefined ? 404 : 200, { "content-type": "text/html" });
    response.end(html ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
};

const postForm = (action: string, extra = "") => `
  ${extra}
  <form method="post" action="${action}" aria-label="Edit record">
    <label for="name">Name</label><input id="name" name="name" value="Example">
    <button id="save">Save</button>
  </form>`;

const redirectCall = `${waitCode}${confirmCommitCode}
  const answer = await waitForOutcomeResult({ saved: { response: { method: "POST" } } }, {
    action: () => page.locator("#save").click({ noWaitAfter: true }), noProgressMs: 600, timeout: 4000,
  });
  return await confirmCommit(answer, page);`;

const banner = `<div class="alert alert-danger">Your last payment failed</div>`;
const dangerZone = `<section><h2>Close account</h2><p class="text-danger">This cannot be undone</p></section>`;

const redirects: readonly {
  name: string;
  start: string;
  pages: Record<string, string>;
  post: (path: string) => { status: number; headers?: Record<string, string> };
  expected: Record<string, unknown>;
}[] = [
  {
    name: "a form post answered with a redirect to the saved record is done",
    start: "/form",
    pages: { "/form": postForm("/records"), "/records/r-7": "<h1>Record r-7</h1>" },
    post: () => ({ status: 302, headers: { location: "/records/r-7" } }),
    expected: done,
  },
  {
    name: "a redirect to a page carrying the same account banner and a success alert is done",
    start: "/form",
    pages: {
      "/form": postForm("/records", banner),
      "/records/r-7": `${banner}<div class="alert alert-success" role="alert">Record saved</div><h1>Record r-7</h1>`,
    },
    post: () => ({ status: 302, headers: { location: "/records/r-7" } }),
    expected: done,
  },
  {
    name: "a redirect to a settings page whose danger zone was on the page before is done",
    start: "/settings/email",
    pages: { "/settings/email": postForm("/settings/email", dangerZone), "/settings": `<h1>Settings</h1>${dangerZone}` },
    post: () => ({ status: 302, headers: { location: "/settings" } }),
    expected: done,
  },
  {
    name: "a redirect back to the form with an error in its query and a plain message is unclear",
    start: "/form",
    pages: {
      "/form": postForm("/form"),
      "/form?error=reference_required": `<p class="flash">Reference number is required</p>${postForm("/form")}`,
    },
    post: () => ({ status: 302, headers: { location: "/form?error=reference_required" } }),
    expected: unclear,
  },
  {
    name: "a redirect back to the form it posted from is unclear",
    start: "/form",
    pages: { "/form": postForm("/form") },
    post: () => ({ status: 302, headers: { location: "/form" } }),
    expected: unclear,
  },
  {
    name: "a redirect back to the form with an error in its query and a new error message is not done",
    start: "/form",
    pages: {
      "/form": postForm("/form"),
      "/form?error=reference_required": `<div class="alert alert-danger">Reference number is required</div>${postForm("/form")}`,
    },
    post: () => ({ status: 302, headers: { location: "/form?error=reference_required" } }),
    expected: notDone,
  },
];

test.describe("confirmCommit", () => {
  for (const each of cases)
    test(each.name, async ({ page: browserPage }) => {
      const { outcome, confirmed } = await confirm(browserPage, each);
      expect(outcome).toBe(each.outcome ?? "saved");
      expect(confirmed).toMatchObject(each.expected);
      expect(confirmed["reason"]).toEqual(expect.any(String));
      if (each.expected["status_label"] === undefined) expect(confirmed).not.toHaveProperty("status_label");
    });

  // Form posts answered with a redirect, on a local server so the browser follows them.
  for (const each of redirects)
    test(each.name, async ({ page: browserPage }) => {
      const site = await localSite(each.pages, each.post);
      try {
        await browserPage.goto(`${site.origin}${each.start}`);
        expect(await run(browserPage, redirectCall)).toMatchObject(each.expected);
      } finally {
        site.close();
      }
    });

  test("a body that can't be read in time is unclear", async ({ page: browserPage }) => {
    // The site sends the response's headers at once and its body only later.
    const server = createServer((request, response) => {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(page({}));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      setTimeout(() => response.end(json({ success: true })), 2500).unref();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await browserPage.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
      const { outcome, confirmed } = (await run(browserPage, commitCall)) as {
        outcome: string;
        confirmed: Record<string, unknown>;
      };
      expect(outcome).toBe("saved");
      expect(confirmed).toMatchObject(unclear);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  // Tools paste waitCode beside helpers of their own. It declares no confirmCommit name, and the
  // commit paste declares only confirmCommit.
  test("a call that declares its own confirmCommit beside waitCode still runs", async ({ page: browserPage }) => {
    await browserPage.setContent("<p>Ready</p>");
    expect(await run(browserPage, `${waitCode}\nconst confirmCommit = () => "own";\nreturn confirmCommit();`)).toBe("own");
  });

  test("the commit paste declares no name but confirmCommit", async ({ page: browserPage }) => {
    await browserPage.setContent("<p>Ready</p>");
    expect(
      await run(
        browserPage,
        `${waitCode}${confirmCommitCode}
        const confirmCommitBody = 1, confirmCommitLook = 2, confirmCommitPage = 3, confirmCommitRead = 4;
        return typeof confirmCommit;`,
      ),
    ).toBe("function");
  });
});
