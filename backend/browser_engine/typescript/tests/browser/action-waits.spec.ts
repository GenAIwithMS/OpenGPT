import { expect, test } from "@playwright/test";
import type { Page, Request } from "playwright";
import { waitCode } from "../../src/browser/wait.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";

// The runtime's outcome race and readiness wait, run as a Kernel call body runs them (`page` in
// scope) on synthetic pages. The pages copy the markup and timing of common toast, alert, modal,
// tour, overlay and validation patterns. Chromium must render them: visibility, hit testing,
// native dialogs and navigation are what the waits watch. Every budget is injected.
const call = async (page: Page, body: string) => {
  const answer = await makeLocalKernel(page).browsers.playwright.execute("session-1", {
    timeout_sec: 10,
    code: `${waitCode}\n${body}`,
  });
  return answer.success ? { result: answer.result } : { error: String(answer.error) };
};

const origin = "https://records.example.test";

interface Reply {
  readonly status?: number;
  readonly body?: string;
  readonly contentType?: string;
  readonly headers?: Record<string, string>;
  readonly delayMs?: number;
}

/** Serves `pages` by path (GET), answers everything else through `api`, and opens `/`. */
const site = async (
  page: Page,
  pages: Record<string, string>,
  api: (request: Request, path: string) => Reply | undefined = () => undefined,
) => {
  await page.context().route(`${origin}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const html = request.method() === "GET" ? pages[path] : undefined;
    const reply: Reply = html !== undefined ? { body: html, contentType: "text/html" } : (api(request, path) ?? { status: 404, body: "" });
    if (reply.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    await route.fulfill({
      status: reply.status ?? 200,
      contentType: reply.contentType ?? "application/json",
      body: reply.body ?? "",
      ...(reply.headers === undefined ? {} : { headers: reply.headers }),
    });
  });
  await page.goto(`${origin}/`);
};

/** A record form whose Save button runs `onSave` (page script) after posting to /api/records. */
const recordForm = (onSave: string, extra = "") => `
  <form id="record" aria-label="Edit record" novalidate>
    <label for="email">Email</label><input id="email" name="email" value="a@example.test">
    <button type="button" id="save">Save</button>
  </form>
  ${extra}
  <script>
    document.querySelector("#save").onclick = async () => { ${onSave} };
  </script>`;

interface Raced {
  readonly outcome?: string;
  readonly kind?: string;
  readonly evidence?: Record<string, unknown>;
  readonly reason?: string;
  readonly message?: string;
  readonly ms: number;
  readonly extra?: unknown;
}

/** Runs `waitForOutcomeResult(outcomes, options)` with Save as its action, and `after` on success. */
const race = async (page: Page, outcomes: string, options = "", after = "undefined"): Promise<Raced> => {
  const answer = await call(
    page,
    `const form = page.getByRole("form", { name: "Edit record" });
    const save = page.locator("#save");
    const started = Date.now();
    try {
      const result = await waitForOutcomeResult({ ${outcomes} }, {
        action: () => save.click(), noProgressMs: 600, timeout: 4000, unchangedMs: 300, ${options}
      });
      const extra = await (async (result) => ${after})(result);
      return { outcome: result.outcome, kind: result.kind, evidence: result.evidence, ms: Date.now() - started, extra };
    } catch (error) {
      if (error.reason === undefined) throw error;
      return { reason: error.reason, message: error.message, ms: Date.now() - started };
    }`,
  );
  if (answer.error !== undefined) throw new Error(answer.error);
  return answer.result as Raced;
};

// The common outcomes of a save, highest priority first.
const saveOutcomes = `
  invalid: { invalid: form },
  failed: page.getByRole("alert").filter({ hasText: /could not|error|failed/i }),
  saved: page.locator(".toast-success, [data-type='success'], .notistack-MuiContent-success"),
`;

test.describe("outcome race after an action", () => {
  test("a toastr-style toast that comes and goes between two looks is still caught as announced", async ({ page }) => {
    await site(
      page,
      {
        "/": recordForm(`
          setTimeout(() => {
            const box = document.createElement("div");
            box.id = "toast-container";
            box.className = "toast-top-right";
            box.innerHTML = '<div class="toast toast-success" aria-live="polite"><div class="toast-message">Record saved</div></div>';
            document.body.append(box);
            setTimeout(() => { box.firstChild.style.transition = "opacity 30ms"; box.firstChild.style.opacity = "0"; }, 30);
            setTimeout(() => box.remove(), 60);
          }, 50);`),
      },
    );
    const answer = await race(page, `failed: page.getByRole("alert"), saved: { announced: /saved/i },`);
    expect(answer).toMatchObject({ outcome: "saved", kind: "announced", evidence: { text: "Record saved" } });
  });

  test("an error and a success drawn in the same render resolve to the error listed first", async ({ page }) => {
    await site(page, {
      "/": recordForm(`
        setTimeout(() => {
          document.body.insertAdjacentHTML("beforeend",
            '<div class="alert alert-danger" role="alert">Changes could not be saved</div>' +
            '<div class="toast toast-success">Record saved</div>');
        }, 100);`),
    });
    expect(await race(page, saveOutcomes)).toMatchObject({
      outcome: "failed",
      evidence: { text: "Changes could not be saved" },
    });
  });

  test("a field-level validation error names the field and its message", async ({ page }) => {
    await site(page, {
      "/": recordForm(`
        setTimeout(() => {
          const email = document.querySelector("#email");
          email.setAttribute("aria-invalid", "true");
          email.setAttribute("aria-describedby", "email-error");
          email.insertAdjacentHTML("afterend", '<p id="email-error" class="Mui-error">Enter a valid email address</p>');
        }, 150);`),
    });
    expect(await race(page, saveOutcomes)).toMatchObject({
      outcome: "invalid",
      kind: "invalid",
      evidence: { fields: [{ field: "Email", message: "Enter a valid email address" }] },
    });
  });

  test("a bootstrap is-invalid field reads its message from the invalid-feedback beside it", async ({ page }) => {
    await site(page, {
      "/": `<form id="record" aria-label="Edit record" novalidate>
          <div><label for="title">Title</label><input id="title" class="form-control">
          <div class="invalid-feedback" style="display:none">Title is required</div></div>
          <button type="button" id="save">Save</button>
        </form>
        <script>
          document.querySelector("#save").onclick = () => setTimeout(() => {
            document.querySelector("#title").classList.add("is-invalid");
            document.querySelector(".invalid-feedback").style.display = "block";
          }, 80);
        </script>`,
    });
    expect(await race(page, saveOutcomes)).toMatchObject({
      outcome: "invalid",
      evidence: { fields: [{ field: "Title", message: "Title is required" }] },
    });
  });

  test("the browser's own required-field check, which sends nothing, is an invalid outcome", async ({ page }) => {
    await site(page, {
      "/": `<form id="record" aria-label="Edit record" action="/api/records" method="post">
          <label for="name">Name</label><input id="name" name="name" required>
          <button id="save">Save</button>
        </form>`,
    });
    const answer = await race(page, `${saveOutcomes} sent: { response: { method: "POST", url: "/api/records" } },`);
    expect(answer.outcome).toBe("invalid");
    expect(answer.evidence).toMatchObject({ fields: [{ field: "Name" }] });
    expect((answer.evidence?.["fields"] as { message: string }[])[0]?.message).not.toBe("");
  });

  test("invalid fields already flagged before the action, and unchanged, wait for the unchanged window", async ({
    page,
  }) => {
    await site(page, {
      "/": `<form id="record" aria-label="Edit record" novalidate>
          <label for="email">Email</label><input id="email" aria-invalid="true">
          <button type="button" id="save">Save</button>
        </form>`,
    });
    const answer = await race(page, saveOutcomes, "unchangedMs: 500");
    expect(answer.outcome).toBe("invalid");
    expect(answer.ms).toBeGreaterThanOrEqual(450);
  });

  test("a redirect to the saved record after a delay is a url outcome naming the URL", async ({ page }) => {
    await site(page, {
      "/": recordForm(`setTimeout(() => { location.href = "/records/42"; }, 400);`),
      "/records/42": `<h1>Record 42</h1>`,
    });
    expect(await race(page, `${saveOutcomes} opened: { url: /\\/records\\/\\d+$/ },`)).toMatchObject({
      outcome: "opened",
      kind: "url",
      evidence: { url: `${origin}/records/42` },
    });
  });

  test("an SPA route change with no document load is a url outcome", async ({ page }) => {
    await site(page, {
      "/": recordForm(`setTimeout(() => {
        history.pushState({}, "", "/records/7");
        document.querySelector("#record").replaceWith(Object.assign(document.createElement("h1"), { textContent: "Record 7" }));
      }, 250);`),
    });
    const answer = await race(page, `${saveOutcomes} opened: { url: (url) => url.pathname.startsWith("/records/") },`);
    expect(answer).toMatchObject({ outcome: "opened", evidence: { url: `${origin}/records/7` } });
  });

  test("a URL that already matched before the action counts only once the page navigates", async ({ page }) => {
    await site(page, {
      "/": recordForm(`
        await fetch("/api/records", { method: "POST", body: "{}" });
        setTimeout(() => document.body.insertAdjacentHTML("beforeend", '<div class="toast toast-success">Saved</div>'), 300);`),
    });
    // The form's own URL matches the pattern, but nothing navigated: the toast decides.
    const answer = await race(page, `opened: { url: "/" }, ${saveOutcomes}`);
    expect(answer.outcome).toBe("saved");
  });

  test("a full navigation mid-wait lands on a confirmation page whose banner decides", async ({ page }) => {
    await site(
      page,
      {
        "/": `<form id="record" aria-label="Edit record" action="/api/records" method="post">
            <input name="title" value="Quarterly report"><button id="save">Save</button></form>`,
      },
      (request, path) =>
        request.method() === "POST" && path === "/api/records"
          ? { contentType: "text/html", body: `<div class="alert alert-success" role="status">Record created</div>`, delayMs: 200 }
          : undefined,
    );
    const answer = await race(page, `${saveOutcomes} created: page.getByRole("status").filter({ hasText: "Record created" }),`);
    expect(answer).toMatchObject({ outcome: "created", evidence: { text: "Record created" } });
  });

  test("a server error page returned for the submit is a response outcome with its status", async ({ page }) => {
    await site(
      page,
      {
        "/": `<form id="record" aria-label="Edit record" action="/api/records" method="post">
            <input name="title" value="x"><button id="save">Save</button></form>`,
      },
      (request) =>
        request.method() === "POST"
          ? { status: 500, contentType: "text/html", body: "<h1>500 Internal Server Error</h1>" }
          : undefined,
    );
    const answer = await race(
      page,
      `${saveOutcomes} serverError: { response: { navigation: true, status: [500, 599] } },`,
    );
    expect(answer).toMatchObject({
      outcome: "serverError",
      kind: "response",
      evidence: { status: 500, method: "POST", url: `${origin}/api/records` },
    });
  });

  test("a slow commit response wins while a spinner shows, and the code can read its body", async ({ page }) => {
    await site(
      page,
      {
        "/": recordForm(
          `document.querySelector("#busy").hidden = false;
          const response = await fetch("/api/records", { method: "POST", body: JSON.stringify({ email: "a@example.test" }) });
          document.querySelector("#busy").hidden = true;`,
          `<div id="busy" class="spinner-border" role="status" hidden></div>`,
        ),
      },
      (request) =>
        request.method() === "POST"
          ? { status: 201, body: JSON.stringify({ id: "rec_81" }), delayMs: 1200 }
          : undefined,
    );
    const answer = await race(
      page,
      `${saveOutcomes} committed: { response: (response) => response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/records" },`,
      "",
      `({ body: await result.response.json(), serialized: JSON.parse(JSON.stringify(result)).response === undefined })`,
    );
    expect(answer).toMatchObject({
      outcome: "committed",
      evidence: { status: 201 },
      extra: { body: { id: "rec_81" }, serialized: true },
    });
    expect(answer.ms).toBeGreaterThanOrEqual(1100);
  });

  test("a commit response that navigates to a page still loading decides without reading that page", async ({
    page,
  }) => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await site(
      page,
      {
        "/": recordForm(`
          const response = await fetch("/api/records", { method: "POST", body: "{}" });
          location.href = response.headers.get("location");`),
      },
      (request) => (request.method() === "POST" ? { status: 201, headers: { location: "/records/77" } } : undefined),
    );
    // The record page answers only after the wait returned: Playwright cannot read the page while
    // that navigation is pending.
    await page.context().route(`${origin}/records/77`, async (route) => {
      await held;
      await route.fulfill({ contentType: "text/html", body: "<h1>Record 77</h1>" }).catch(() => undefined);
    });
    const answer = await race(
      page,
      `${saveOutcomes} committed: { response: { method: "POST", status: 201 } },`,
      "action: () => save.click({ noWaitAfter: true }),",
    );
    release();
    expect(answer).toMatchObject({ outcome: "committed", evidence: { status: 201 } });
  });

  test("a deadline ends the wait in time even while a slow submit holds the page", async ({ page }) => {
    await site(
      page,
      {
        "/": `<form id="record" aria-label="Edit record" action="/api/records" method="post">
            <input name="title" value="x"><button id="save">Save</button></form>`,
      },
      (request) => (request.method() === "POST" ? { contentType: "text/html", body: "<p>Saved</p>", delayMs: 6000 } : undefined),
    );
    const answer = await race(
      page,
      `${saveOutcomes} committed: { response: { method: "POST" } },`,
      "action: () => save.click({ noWaitAfter: true }), deadline: Date.now() + 1000, noProgressMs: 8000,",
    );
    // It ends within its half-second grace of the deadline, long before the submit's answer at 6 s.
    expect(answer.reason).toBe("outcome_timeout");
    expect(answer.ms).toBeLessThan(2500);
  });

  test("a response outcome names at least one thing to match", async ({ page }) => {
    await page.setContent("<p>page</p>");
    const answer = await call(page, `return await waitForOutcome({ saved: { response: {} } });`);
    expect(answer.error).toMatch(/needs a function of the response or \{ method, url, status, navigation \}, with at least one/u);
  });

  test("a batched GraphQL save never sends the named request, and the page's toast still decides", async ({
    page,
  }) => {
    await site(
      page,
      {
        "/": recordForm(`
          await fetch("/graphql", { method: "POST", body: JSON.stringify([{ operationName: "UpdateRecord" }, { operationName: "Audit" }]) });
          document.body.insertAdjacentHTML("beforeend",
            '<section aria-label="Notifications"><ol data-sonner-toaster><li data-sonner-toast data-type="success" role="status">Changes saved</li></ol></section>');`),
      },
      (_request, path) => (path === "/graphql" ? { body: JSON.stringify([{ data: {} }, { data: {} }]) } : undefined),
    );
    const answer = await race(
      page,
      `committed: { response: { method: "POST", url: "/api/updateRecord" } }, ${saveOutcomes}`,
    );
    expect(answer).toMatchObject({ outcome: "saved", evidence: { text: "Changes saved" } });
  });

  test("a bootstrap modal form that fades and closes is a gone outcome", async ({ page }) => {
    await site(page, {
      "/": `<div class="modal fade show" role="dialog" aria-modal="true" style="display:block">
          <form id="record" aria-label="Edit record"><input name="title"><button type="button" id="save">Save</button></form>
        </div>
        <script>
          document.querySelector("#save").onclick = () => setTimeout(() => {
            const modal = document.querySelector(".modal");
            modal.classList.remove("show");
            modal.style.transition = "opacity 150ms";
            modal.style.opacity = "0";
            setTimeout(() => { modal.style.display = "none"; modal.setAttribute("aria-hidden", "true"); }, 300);
          }, 100);
        </script>`,
    });
    const answer = await race(page, `${saveOutcomes} closed: { gone: page.getByRole("dialog"), stableMs: 200 },`);
    expect(answer).toMatchObject({ outcome: "closed", kind: "gone" });
    expect(answer.evidence?.["goneForMs"]).toBeGreaterThanOrEqual(200);
  });

  test("a form re-rendered in place is not taken for closed, and the validation it draws decides", async ({
    page,
  }) => {
    await site(page, {
      "/": recordForm(`
        const form = document.querySelector("#record");
        const copy = form.cloneNode(true);
        form.remove();
        setTimeout(() => {
          document.body.prepend(copy);
          copy.querySelector("#email").setAttribute("aria-invalid", "true");
          copy.querySelector("#email").setAttribute("aria-errormessage", "e1");
          copy.insertAdjacentHTML("beforeend", '<span id="e1">Email is already taken</span>');
        }, 120);`),
    });
    const answer = await race(page, `${saveOutcomes} closed: { gone: page.locator("#record"), stableMs: 300 },`);
    expect(answer).toMatchObject({
      outcome: "invalid",
      evidence: { fields: [{ field: "Email", message: "Email is already taken" }] },
    });
  });

  test("a SweetAlert2-style success dialog is read by role and title", async ({ page }) => {
    await site(page, {
      "/": recordForm(`setTimeout(() => document.body.insertAdjacentHTML("beforeend",
        '<div class="swal2-container swal2-center swal2-backdrop-show"><div class="swal2-popup swal2-modal swal2-icon-success swal2-show" role="dialog" aria-modal="true" aria-labelledby="swal2-title">' +
        '<h2 class="swal2-title" id="swal2-title">Saved!</h2><div class="swal2-html-container">Your record was updated.</div>' +
        '<div class="swal2-actions"><button class="swal2-confirm swal2-styled">OK</button></div></div></div>'), 200);`),
    });
    const answer = await race(
      page,
      `${saveOutcomes} confirmed: page.getByRole("dialog", { name: "Saved!" }),`,
    );
    expect(answer).toMatchObject({ outcome: "confirmed" });
    expect(answer.evidence?.["text"]).toContain("Your record was updated.");
  });

  test("notistack-style snackbars tell an error apart from a success by their variant", async ({ page }) => {
    await site(page, {
      "/": recordForm(`setTimeout(() => document.body.insertAdjacentHTML("beforeend",
        '<div class="notistack-SnackbarContainer"><div class="notistack-MuiContent notistack-MuiContent-error" role="alert">' +
        '<div id="notistack-snackbar">Save failed: server unavailable</div></div></div>'), 150);`),
    });
    expect(await race(page, saveOutcomes)).toMatchObject({
      outcome: "failed",
      evidence: { text: "Save failed: server unavailable" },
    });
  });

  test("a toast left from an earlier save, unchanged, does not count before the unchanged window", async ({
    page,
  }) => {
    await site(page, {
      "/": recordForm(
        `setTimeout(() => document.body.insertAdjacentHTML("beforeend",
          '<div class="alert alert-danger" role="alert">Changes could not be saved</div>'), 150);`,
        `<div class="toast toast-success">Record saved</div>`,
      ),
    });
    // The stale toast would win at the first look; the new error shows inside the window.
    expect(await race(page, saveOutcomes, "unchangedMs: 600")).toMatchObject({ outcome: "failed" });
  });

  test("a native alert after the action is a dialog outcome, left open for the code to handle", async ({ page }) => {
    await site(page, { "/": recordForm(`setTimeout(() => alert("Record saved"), 100);`) });
    const answer = await race(
      page,
      `${saveOutcomes} alerted: { dialog: "alert" },`,
      "",
      `(async () => { await result.dialog.accept(); return page.url(); })()`,
    );
    expect(answer).toMatchObject({
      outcome: "alerted",
      kind: "dialog",
      evidence: { type: "alert", message: "Record saved" },
      extra: `${origin}/`,
    });
  });

  test("an alert the click's own handler raises decides without hanging the click", async ({ page }) => {
    await site(page, { "/": recordForm(`alert("Record saved");`) });
    const answer = await race(
      page,
      `${saveOutcomes} alerted: { dialog: "alert" },`,
      "",
      `(async () => { await result.dialog.accept(); return page.evaluate(() => document.title + "ok"); })()`,
    );
    expect(answer).toMatchObject({ outcome: "alerted", evidence: { type: "alert", message: "Record saved" }, extra: "ok" });
  });

  test("a dialog that opens after another outcome won is still handed back, not left to freeze the page", async ({
    page,
  }) => {
    await site(
      page,
      { "/": recordForm(`await fetch("/api/records", { method: "POST", body: "{}" }); alert("Saved");`) },
      (request) => (request.method() === "POST" ? { status: 201, body: "{}" } : undefined),
    );
    const answer = await race(
      page,
      `committed: { response: { method: "POST", status: 201 } }, alerted: { dialog: true },`,
      "",
      `(async () => {
        // An alert that opened while the wait listened is handed back; one that opened after it
        // stopped listening was dismissed by Playwright. Either way the page stays readable.
        await result.dialog?.dismiss();
        return { readable: await page.evaluate(() => 1 + 1) };
      })()`,
    );
    expect(answer).toMatchObject({ outcome: "committed", extra: { readable: 2 } });
  });

  test("a native dialog no outcome names fails at once, naming its type", async ({ page }) => {
    await site(page, { "/": recordForm(`setTimeout(() => confirm("Discard changes?"), 100);`) });
    const answer = await call(
      page,
      `try {
        await waitForOutcomeResult({ alerted: { dialog: "alert" }, saved: page.locator(".toast-success") },
          { action: () => page.locator("#save").click(), noProgressMs: 2000, timeout: 4000 });
      } catch (error) {
        await error.dialog?.dismiss();
        return { reason: error.reason, message: error.message, held: error.dialog !== undefined };
      }`,
    );
    expect(answer.result).toMatchObject({
      reason: "outcome_unknown",
      held: true,
      message: expect.stringMatching(/a native confirm dialog opened that no outcome names$/u),
    });
  });

  test("a save that opens its receipt in a new tab is a popup outcome", async ({ page }) => {
    await site(page, {
      "/": recordForm(`window.open("/receipts/5", "_blank");`),
      "/receipts/5": "<h1>Receipt</h1>",
    });
    const answer = await race(page, `${saveOutcomes} receipt: { popup: true },`, "", `result.page.url()`);
    expect(answer).toMatchObject({ outcome: "receipt", kind: "popup", evidence: { url: `${origin}/receipts/5` } });
  });

  test("a check hook reads the app's own state and returns its value as evidence", async ({ page }) => {
    await site(page, {
      "/": recordForm(`window.store = { status: "saving" }; setTimeout(() => { window.store = { status: "saved", id: 12 }; }, 200);`),
    });
    const answer = await race(
      page,
      `${saveOutcomes} stored: { check: () => page.evaluate(() => window.store?.status === "saved" && window.store) },`,
    );
    expect(answer).toMatchObject({ outcome: "stored", kind: "check", evidence: { value: { status: "saved", id: 12 } } });
  });

  test("no outcome on a quiet page fails fast, naming what each outcome saw", async ({ page }) => {
    await site(page, { "/": recordForm(`await fetch("/api/ping");`) }, () => ({ body: "{}" }));
    const answer = await race(
      page,
      `${saveOutcomes} committed: { response: { method: "POST", url: "/api/records" } }, opened: { url: /records\\/\\d+/ },`,
    );
    // Its 4 s cap would have made it an outcome_timeout.
    expect(answer.reason).toBe("outcome_unknown");
    expect(answer.message).toMatch(
      /no outcome showing: invalid 0 invalid fields, failed 0 visible of 0, saved 0 visible of 0, committed no matching response of 1 seen, opened URL not matched; /u,
    );
  });

  test("a matcher that throws is reported as the code's own error, not a timeout", async ({ page }) => {
    await site(page, { "/": recordForm(`await fetch("/api/records", { method: "POST" });`) }, () => ({ body: "not json" }));
    const answer = await call(
      page,
      `try {
        await waitForOutcomeResult({ committed: { response: async (response) => (await response.json()).ok } },
          { action: () => page.locator("#save").click(), noProgressMs: 1000, timeout: 3000 });
        return "returned";
      } catch (error) {
        return { reason: error.reason ?? null, name: error.name };
      }`,
    );
    expect(answer.result).toEqual({ reason: null, name: "SyntaxError" });
  });

  test("the losing waiters leave no listeners on the page", async ({ page }) => {
    await site(page, {
      "/": recordForm(`setTimeout(() => document.body.insertAdjacentHTML("beforeend", '<div class="toast toast-success">Saved</div>'), 50);
        setTimeout(() => fetch("/api/late"), 300);`),
    });
    const answer = await call(
      page,
      `const before = ["response", "dialog", "popup", "framenavigated", "request"].map((event) => page.listenerCount(event));
      const result = await waitForOutcomeResult({
        saved: page.locator(".toast-success"), committed: { response: () => true }, alerted: { dialog: true },
        receipt: { popup: true }, opened: { url: "/done" },
      }, { action: () => page.locator("#save").click(), noProgressMs: 1000, timeout: 3000 });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const after = ["response", "dialog", "popup", "framenavigated", "request"].map((event) => page.listenerCount(event));
      return { outcome: result.outcome, same: JSON.stringify(before) === JSON.stringify(after) };`,
    );
    expect(answer.result).toEqual({ outcome: "saved", same: true });
  });

  test("waitForOutcome still returns the name alone, for every kind", async ({ page }) => {
    await site(page, { "/": recordForm(`history.pushState({}, "", "/records/3");`) });
    const answer = await call(
      page,
      `return await waitForOutcome({ saved: page.locator(".toast-success"), opened: { url: "/records/3" } },
        { action: () => page.locator("#save").click(), noProgressMs: 1000, timeout: 3000 });`,
    );
    expect(answer.result).toBe("opened");
  });

  test("an outcome that names no kind is refused at once", async ({ page }) => {
    await page.setContent("<p>page</p>");
    const answer = await call(page, `return await waitForOutcome({ saved: { toast: ".x" } });`);
    expect(answer.error).toMatch(/outcome "saved" needs a locator, or an object with exactly one of gone, invalid, url/u);
  });
});

/**
 * Runs `waitForReady(target, options)` and returns its result or its failure. A page's
 * `window.begin()` starts its timers once the wait's first look has read the page, so a blocker
 * it clears later is always seen, however slow the machine: the wait's `until` hook runs last in
 * each look. A test that passes its own `until` starts them before the wait instead.
 */
const ready = async (page: Page, target: string, options: string, after = "undefined") => {
  const own = options.includes("until:");
  const answer = await call(
    page,
    `${own ? "await page.evaluate(() => window.begin?.());" : ""}
    let begun = false;
    const firstLook = async () => {
      if (!begun) await page.evaluate(() => window.begin?.());
      begun = true;
      return true;
    };
    const started = Date.now();
    try {
      const result = await waitForReady(${target}, { noProgressMs: 600, timeout: 4000, ${own ? "" : "until: firstLook, "}${options} });
      const extra = await (async (result) => ${after})(result);
      return { ...result, ms: Date.now() - started, extra };
    } catch (error) {
      if (error.reason === undefined) throw error;
      return { reason: error.reason, message: error.message, ms: Date.now() - started };
    }`,
  );
  if (answer.error !== undefined) throw new Error(answer.error);
  return answer.result as {
    readonly afterMs?: number;
    readonly looks?: number;
    readonly waitedFor?: readonly string[];
    readonly dismissed?: number;
    readonly expanded?: boolean;
    readonly reason?: string;
    readonly message?: string;
    readonly ms: number;
    readonly extra?: unknown;
  };
};

test.describe("readiness before acting", () => {
  test("a control already ready passes at once", async ({ page }) => {
    await page.setContent(`<button>Save</button>`);
    const answer = await ready(page, `page.getByRole("button", { name: "Save" })`, "");
    expect(answer).toMatchObject({ looks: 2, waitedFor: [], dismissed: 0, expanded: false });
  });

  test("a button disabled until its field blurs fails naming the cause, and passes once it blurs", async ({ page }) => {
    await page.setContent(`
      <label for="code">Code</label><input id="code"><button disabled>Apply</button>
      <script>document.querySelector("#code").onblur = () => { document.querySelector("button").disabled = false; };</script>`);
    await page.getByLabel("Code").fill("SPRING");
    const stuck = await ready(page, `page.getByRole("button", { name: "Apply" })`, "");
    expect(stuck.reason).toBe("not_ready");
    expect(stuck.message).toMatch(/^not_ready after \d+ ms, 600 ms without progress: it is disabled; /u);
    await page.getByLabel("Code").press("Tab");
    expect(await ready(page, `page.getByRole("button", { name: "Apply" })`, "")).toMatchObject({ waitedFor: [] });
  });

  test("a blockUI-style overlay that fades out holds the wait until it is gone", async ({ page }) => {
    await page.setContent(`
      <button>Save</button>
      <div class="blockUI blockOverlay" style="position:fixed;inset:0;background:#000;opacity:0.6;cursor:wait;transition:opacity 200ms"></div>
      <script>
        const overlay = document.querySelector(".blockOverlay");
        window.begin = () => {
          setTimeout(() => { overlay.style.opacity = "0"; }, 200);
          setTimeout(() => overlay.remove(), 400);
        };
      </script>`);
    const answer = await ready(page, `page.getByRole("button", { name: "Save" })`, "stableMs: 200");
    expect(answer.waitedFor).toContain("covered");
    expect(answer.ms).toBeGreaterThanOrEqual(400);
  });

  test("a named loading overlay that only dims the page still holds the wait", async ({ page }) => {
    await page.setContent(`
      <button>Save</button>
      <div class="MuiBackdrop-root" aria-hidden="true" style="position:fixed;top:0;left:0;width:10px;height:10px"></div>
      <script>window.begin = () => setTimeout(() => document.querySelector(".MuiBackdrop-root").style.visibility = "hidden", 300);</script>`);
    const answer = await ready(page, `page.getByRole("button", { name: "Save" })`, `overlays: page.locator(".MuiBackdrop-root"), stableMs: 100`);
    expect(answer.waitedFor).toEqual(["overlay"]);
    expect(answer.ms).toBeGreaterThanOrEqual(300);
  });

  test("a spinner overlay that flickers counts as gone only once it stays gone", async ({ page }) => {
    await page.setContent(`
      <button>Save</button>
      <div id="spin" class="spinner-overlay" style="position:fixed;inset:0"></div>
      <script>
        const spin = document.querySelector("#spin");
        // Two requests in a row: the spinner hides for 60 ms between them.
        window.begin = () => { for (const [at, shown] of [[200, false], [260, true], [700, false], [760, true], [1200, false]])
          setTimeout(() => { spin.style.display = shown ? "block" : "none"; window.lastChange = performance.now(); }, at); };
      </script>`);
    const answer = await ready(
      page,
      `page.getByRole("button", { name: "Save" })`,
      "stableMs: 300, noProgressMs: 2000",
      `page.evaluate(() => performance.now() - window.lastChange)`,
    );
    expect(answer.waitedFor).toContain("covered");
    expect(answer.extra).toBeGreaterThanOrEqual(280);
  });

  test("a busy region around the control holds the wait", async ({ page }) => {
    await page.setContent(`
      <div id="panel" aria-busy="true"><button>Save</button></div>
      <script>window.begin = () => setTimeout(() => document.querySelector("#panel").setAttribute("aria-busy", "false"), 300);</script>`);
    const answer = await ready(page, `page.getByRole("button", { name: "Save" })`, "stableMs: 100");
    expect(answer.waitedFor).toEqual(["busy"]);
  });

  test("a save button showing its own spinner is busy until the spinner goes", async ({ page }) => {
    await page.setContent(`
      <button><span class="spinner-border spinner-border-sm" role="status" style="display:inline-block;width:1em;height:1em"></span> Save</button>
      <script>window.begin = () => setTimeout(() => document.querySelector(".spinner-border").remove(), 300);</script>`);
    const answer = await ready(page, `page.getByRole("button", { name: "Save" })`, "stableMs: 100");
    // The button narrows as its spinner goes, so it may also be seen moving.
    expect(answer.waitedFor).toContain("busy");
    expect(answer.ms).toBeGreaterThanOrEqual(300);
  });

  test("an Intro.js-style tour covering the page is closed with its skip button", async ({ page }) => {
    await page.setContent(`
      <button id="target">Save</button>
      <div class="introjs-overlay" style="position:fixed;inset:0;opacity:0.8;background:#000"></div>
      <div class="introjs-tooltipReferenceLayer" style="position:fixed;top:40px;left:40px">
        <div class="introjs-tooltip" role="dialog">
          <div class="introjs-tooltip-header"><h1 class="introjs-tooltip-title">Welcome</h1>
          <a class="introjs-skipbutton" role="button" tabindex="0">×</a></div>
          <div class="introjs-tooltiptext">Here is your dashboard.</div>
        </div>
      </div>
      <script>
        document.querySelector(".introjs-skipbutton").onclick = () => setTimeout(() => {
          document.querySelector(".introjs-overlay").remove();
          document.querySelector(".introjs-tooltipReferenceLayer").remove();
        }, 100);
      </script>`);
    const answer = await ready(page, `page.locator("#target")`, `dismiss: page.locator(".introjs-skipbutton"), stableMs: 100`);
    expect(answer).toMatchObject({ dismissed: 1 });
  });

  test("a Shepherd-style tour that opens after a second is closed before the next click", async ({ page }) => {
    await page.setContent(`
      <button id="target">Save</button><output id="clicks">0</output>
      <script>
        document.querySelector("#target").onclick = () => { document.querySelector("#clicks").textContent = "1"; };
        window.openTourLater = () => setTimeout(() => {
          document.body.insertAdjacentHTML("beforeend",
            '<svg class="shepherd-modal-overlay-container shepherd-modal-is-visible" style="position:fixed;inset:0;width:100vw;height:100vh"><path d="M0 0h9999v9999H0z"></path></svg>' +
            '<div class="shepherd-element shepherd-enabled" role="dialog" style="position:fixed;top:60px;left:60px">' +
            '<header class="shepherd-header"><h3 class="shepherd-title">What\\'s new</h3>' +
            '<button class="shepherd-cancel-icon" aria-label="Cancel Tour">×</button></header></div>');
          document.querySelector(".shepherd-cancel-icon").onclick = () => {
            document.querySelector(".shepherd-modal-overlay-container").remove();
            document.querySelector(".shepherd-element").remove();
          };
        }, 1000);
      </script>`);
    const answer = await ready(
      page,
      `page.locator("#target")`,
      `dismiss: page.getByRole("button", { name: "Cancel Tour" })`,
      `(async () => {
        await page.evaluate(() => window.openTourLater());
        // The tour covers the button by the time it is clicked.
        await page.waitForFunction(() => document.querySelector(".shepherd-element") !== null, null, { timeout: 3000 });
        await page.locator("#target").click({ timeout: 2000 });
        await result.release();
        return { clicks: await page.locator("#clicks").textContent(), tour: await page.locator(".shepherd-element").count() };
      })()`,
    );
    expect(answer).toMatchObject({ dismissed: 0, extra: { clicks: "1", tour: 0 } });
  });

  test("a cookie banner over the control is accepted, then the control is ready", async ({ page }) => {
    await page.setContent(`
      <button id="target" style="position:fixed;bottom:10px;left:10px">Continue</button>
      <div id="onetrust-banner-sdk" style="position:fixed;bottom:0;left:0;right:0;height:120px;background:#fff">
        <button id="onetrust-accept-btn-handler">Accept All Cookies</button></div>
      <script>document.querySelector("#onetrust-accept-btn-handler").onclick = () => { document.querySelector("#onetrust-banner-sdk").style.display = "none"; };</script>`);
    const answer = await ready(page, `page.locator("#target")`, `dismiss: page.locator("#onetrust-accept-btn-handler"), stableMs: 100`);
    expect(answer).toMatchObject({ dismissed: 1 });
  });

  test("a control inside a collapsed accordion section is expanded once, then ready", async ({ page }) => {
    await page.setContent(`
      <h3><button id="toggle" aria-expanded="false" aria-controls="billing">Billing</button></h3>
      <div id="billing" hidden><label for="zip">ZIP</label><input id="zip"></div>
      <script>
        document.querySelector("#toggle").onclick = (event) => {
          const open = event.target.getAttribute("aria-expanded") === "true";
          event.target.setAttribute("aria-expanded", String(!open));
          setTimeout(() => { document.querySelector("#billing").hidden = open; }, 150);
        };
      </script>`);
    const answer = await ready(page, `page.getByLabel("ZIP")`, `expand: page.locator("#toggle"), stableMs: 100`);
    expect(answer).toMatchObject({ expanded: true });
    expect(answer.waitedFor).toContain("collapsed");
    expect(await page.locator("#toggle").getAttribute("aria-expanded")).toBe("true");
  });

  test("a control inside a closed details element is expanded through its summary", async ({ page }) => {
    await page.setContent(`<details><summary>Advanced</summary><label>Timeout <input id="t"></label></details>`);
    const answer = await ready(page, `page.locator("#t")`, `expand: page.locator("summary"), stableMs: 50`);
    expect(answer).toMatchObject({ expanded: true });
  });

  test("a toggle that says collapsed is not clicked while its control already shows", async ({ page }) => {
    await page.setContent(`
      <button id="toggle" aria-expanded="false">Billing</button><input aria-label="ZIP">
      <script>document.querySelector("#toggle").onclick = () => { throw new Error("toggled"); };</script>`);
    expect(await ready(page, `page.getByLabel("ZIP")`, `expand: page.locator("#toggle")`)).toMatchObject({ expanded: false });
  });

  test("an open section whose control has not loaded yet is not toggled closed", async ({ page }) => {
    await page.setContent(`
      <button id="toggle">Billing</button><div id="billing"></div>
      <script>
        document.querySelector("#toggle").onclick = () => { document.querySelector("#billing").hidden = true; };
        window.begin = () => setTimeout(() => { document.querySelector("#billing").innerHTML = '<input aria-label="ZIP">'; }, 200);
      </script>`);
    const answer = await ready(page, `page.getByLabel("ZIP")`, `expand: page.locator("#toggle"), stableMs: 50`);
    expect(answer).toMatchObject({ expanded: false });
    expect(answer.waitedFor).toContain("absent");
  });

  test("a styled checkbox whose native input is transparent is ready", async ({ page }) => {
    await page.setContent(`
      <label class="switch" style="position:relative;display:inline-block;padding:4px">
        <input type="checkbox" style="opacity:0;position:absolute;inset:0;margin:0"> <span class="slider">Remember me</span>
      </label>`);
    expect(await ready(page, `page.getByRole("checkbox", { name: "Remember me" })`, "")).toMatchObject({ waitedFor: [] });
  });

  test("an expanded section is never toggled closed", async ({ page }) => {
    await page.setContent(`
      <button id="toggle" aria-expanded="true">Billing</button><div><input aria-label="ZIP"></div>
      <script>document.querySelector("#toggle").onclick = () => { throw new Error("toggled"); };</script>`);
    expect(await ready(page, `page.getByLabel("ZIP")`, `expand: page.locator("#toggle")`)).toMatchObject({ expanded: false, waitedFor: [] });
  });

  test("the page's own pending-request counter holds the wait until it reaches zero", async ({ page }) => {
    await page.setContent(`
      <button>Save</button>
      <script>
        window.jQuery = { active: 2 };
        window.begin = () => {
          setTimeout(() => { jQuery.active = 1; }, 150);
          setTimeout(() => { jQuery.active = 0; }, 350);
        };
      </script>`);
    const answer = await ready(
      page,
      `page.getByRole("button", { name: "Save" })`,
      `pending: () => window.jQuery?.active ?? 0, stableMs: 100`,
    );
    expect(answer.waitedFor).toEqual(["pending"]);
    expect(answer.ms).toBeGreaterThanOrEqual(350);
  });

  test("a drawer still sliding in is ready once it stops moving", async ({ page }) => {
    await page.setContent(`
      <aside id="drawer" style="position:fixed;top:0;left:-300px;width:280px;transition:left 400ms linear"><button>Apply filters</button></aside>
      <script>window.begin = () => requestAnimationFrame(() => requestAnimationFrame(() => { document.querySelector("#drawer").style.left = "0px"; }));</script>`);
    const answer = await ready(page, `page.getByRole("button", { name: "Apply filters" })`, "stableMs: 100");
    expect(answer.waitedFor).toContain("moving");
    expect(answer.ms).toBeGreaterThanOrEqual(350);
  });

  test("a deadline ends the readiness wait in time even while a slow submit holds the page", async ({ page }) => {
    await site(
      page,
      {
        "/": `<form action="/api/records" method="post"><input name="title" value="x"><button id="save">Save</button></form>`,
      },
      (request) => (request.method() === "POST" ? { contentType: "text/html", body: "<p>Saved</p>", delayMs: 6000 } : undefined),
    );
    await page.locator("#save").click({ noWaitAfter: true });
    const answer = await ready(page, `page.locator("#save")`, "deadline: Date.now() + 1000, noProgressMs: 8000");
    // It ends within its half-second grace of the deadline, long before the submit's answer at 6 s.
    expect(answer.reason).toBe("ready_timeout");
    expect(answer.ms).toBeLessThan(2500);
  });

  test("a read-only field is not ready to type into when editable is asked", async ({ page }) => {
    await page.setContent(`<input aria-label="Amount" readonly>`);
    const answer = await ready(page, `page.getByLabel("Amount")`, "editable: true");
    expect(answer.message).toMatch(/: it is read-only; /u);
  });

  test("a locator matching two visible controls fails as ambiguous", async ({ page }) => {
    await page.setContent(`<button>Save</button><button>Save</button>`);
    const answer = await ready(page, `page.getByRole("button", { name: "Save" })`, "");
    expect(answer.reason).toBe("ready_ambiguous");
    expect(answer.message).toMatch(/: 2 visible elements match; /u);
  });

  test("a control that never appears fails naming it absent, and a hidden one naming it hidden", async ({ page }) => {
    await page.setContent(`<button hidden>Save</button>`);
    expect((await ready(page, `page.getByRole("button", { name: "Pay" })`, "")).message).toMatch(/: no element matches; /u);
    expect((await ready(page, `page.locator("button")`, "")).message).toMatch(/: no match is visible; /u);
  });

  test("a control covered by an element that never leaves names what covers it", async ({ page }) => {
    await page.setContent(`
      <button>Save</button>
      <div id="chat-launcher" class="widget frame" style="position:fixed;inset:0"></div>`);
    const answer = await ready(page, `page.getByRole("button", { name: "Save" })`, "");
    expect(answer.message).toMatch(/: covered by div#chat-launcher\.widget\.frame; /u);
  });

  test("a custom until condition holds the wait until it is true", async ({ page }) => {
    // The app reports itself ready from its third check on.
    await page.setContent(`<button>Save</button><script>window.checks = 0;</script>`);
    const answer = await ready(
      page,
      `page.getByRole("button", { name: "Save" })`,
      `until: () => page.evaluate(() => ++window.checks >= 3), stableMs: 50`,
    );
    expect(answer.waitedFor).toEqual(["until"]);
    expect(answer.looks).toBeGreaterThanOrEqual(4);
  });

  test("waitReport lists the readiness wait beside the outcome wait", async ({ page }) => {
    await page.setContent(`<button onclick="this.insertAdjacentHTML('afterend', '<p role=status>Done</p>')">Go</button>`);
    const answer = await call(
      page,
      `const go = page.getByRole("button", { name: "Go" });
      await waitForReady(go);
      await waitForOutcome({ done: page.getByRole("status") }, { action: () => go.click() });
      return waitReport().map((record) => record.wait + ":" + (record.outcome ?? record.reason));`,
    );
    expect(answer.result).toEqual(["waitForReady:ready", "waitForOutcome:done"]);
  });
});
