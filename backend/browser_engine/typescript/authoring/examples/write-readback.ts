import { Schema } from "effect";
import { confirmCommitCode, defineOperation, timeoutDefaults, waitCode } from "../../src/browser/index.js";

const SavedTask = Schema.Struct({
  id: Schema.NonEmptyTrimmedString.annotations({ description: "ID the site gave the saved task" }),
});
const Outcome = Schema.Union(
  Schema.Struct({ id: Schema.NonEmptyTrimmedString }),
  Schema.Struct({ failure: Schema.Literal("form_changed", "not_submitted", "not_saved") }),
);

// Observed contract: this authenticated account's form stages edits without autosave;
// POST /tasks returns 201 + Location /tasks/<id> naming the new task.
// The host has authorized creation and signed in. Adapt from site evidence.
export default defineOperation(
  {
    name: "create_task",
    input: Schema.Struct({
      title: Schema.NonEmptyString.pipe(Schema.pattern(/\S/u)).annotations({ description: "Title of the new task" }),
      assignee: Schema.NonEmptyString.pipe(Schema.pattern(/\S/u)).annotations({
        description: "Who the task is assigned to, as the form's Assignee field takes it",
      }),
    }),
    output: SavedTask,
    // The create request's own 201 with its Location confirms the write and names the new task,
    // so no page is read for the output.
    write: { confirmation: "readback", commits: ["create-task"] },
  },
  async ({
    kernel,
    sessionId,
    siteOrigin,
    siteDomain,
    input,
    verified,
    enteringCommit,
    remainingMs,
    errors,
  }) => {
    if (siteOrigin === undefined)
      throw new errors.OperationFailure("No site origin for a live run", { dispatch: "not_sent" });
    // Keep the Kernel call inside the operation deadline. A smaller call gets a smaller
    // reserve, while a full 60-second call leaves five seconds for a pending write to settle.
    const remaining = remainingMs();
    const outerReserveMs = Math.min(3_000, Math.max(500, remaining / 10));
    const timeoutSec = Math.min(60, Math.floor((remaining - outerReserveMs) / 1_000));
    if (timeoutSec <= 1)
      throw new errors.OperationFailure("Not enough time to submit safely", {
        dispatch: "not_sent",
      });
    const callReserveMs = Math.min(5_000, Math.max(500, timeoutSec * 100));
    // The one call below fills and submits the form, so the commit step is marked first.
    enteringCommit("create-task");
    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: timeoutSec,
      code: `
        ${waitCode}
        // On the site: any https host on the host's site domain, else the site origin alone.
        const siteDomain = ${JSON.stringify(siteDomain ?? null)};
        const onSite = (url) => siteDomain === null ? url.origin === ${JSON.stringify(siteOrigin)}
          : url.protocol === "https:" && (url.hostname === siteDomain || url.hostname.endsWith("." + siteDomain));
        const title = ${JSON.stringify(input.title.trim())};
        const assignee = ${JSON.stringify(input.assignee.trim())};
        const callDeadline = Date.now() + ${timeoutSec * 1_000 - callReserveMs};
        const timeLeft = () => Math.floor(callDeadline - Date.now());
        const actionTimeout = (maximum) => {
          const left = timeLeft() - 1000;
          if (left <= 0) throw new Error("Call budget exhausted");
          return Math.min(maximum, left);
        };
        const current = new URL(page.url());
        if (!onSite(current)) return { failure: "form_changed" };
        // The form posts to its own page's origin, which may be any host of the site.
        if (page.url() !== current.origin + "/tasks/new") return { failure: "form_changed" };
        const form = page.getByRole("form", { name: "New task", exact: true });
        if ((await form.getAttribute("action")) !== "/tasks" || (await form.getAttribute("method")) !== "post")
          return { failure: "form_changed" };
        await form.getByLabel("Title", { exact: true }).fill(title, { timeout: actionTimeout(${timeoutDefaults.action}) });
        await form.getByLabel("Assignee", { exact: true }).fill(assignee, { timeout: actionTimeout(${timeoutDefaults.action}) });
        // Notes the page's messages and flagged fields once the form is filled, just before the
        // click, so confirmCommit below counts only what the save adds.
        ${confirmCommitCode}
        const available = timeLeft();
        if (available <= 2000) return { failure: "not_submitted" };
        // Race the save response against the form's own refusal, in the same call as the click
        // that sends it: the wait listens before it clicks, runs the click once, and removes its
        // listeners when one answer wins. A detail page that was already open cannot supply this
        // receipt. The click settles inside the wait, so a pending write click cannot fire after
        // this call reports failure.
        const answer = await waitForOutcomeResult({
          invalid: { invalid: form },
          saved: {
            response: (response) => {
              const request = response.request();
              const fields = new URLSearchParams(request.postData() ?? "");
              return request.method() === "POST" && request.url() === current.origin + "/tasks" &&
                fields.get("title") === title && fields.get("assignee") === assignee;
            },
          },
        }, {
          action: () => form.getByRole("button", { name: "Create task", exact: true }).click({ noWaitAfter: true, timeout: Math.min(${timeoutDefaults.answerCap}, available - 1000) }),
          siteDomain: siteDomain ?? undefined,
          deadline: callDeadline,
        });
        // A field the form marked invalid stopped the save, or answered it: never resubmit.
        if (answer.outcome === "invalid") return { failure: "not_saved" };
        if ((await confirmCommit(answer, page)).state !== "done") return { failure: "not_saved" };
        const response = answer.response;
        const posted = new URL(response.url());
        const location = new URL(response.headers()["location"] ?? "", posted);
        const id = location.pathname.startsWith("/tasks/") ? location.pathname.slice("/tasks/".length) : "";
        if (response.status() !== 201 || location.origin !== posted.origin || !/^[^/]+$/.test(id))
          return { failure: "not_saved" };
        // The 201 with its Location confirmed the write and gave the new task's id. Return now:
        // the page it opens may still be loading, and nothing here waits for it.
        return { id };
      `,
    });
    // A failure after the click leaves the write uncertain. Never resubmit here.
    if (!answer.success)
      throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
    const result = Schema.decodeUnknownSync(Outcome)(answer.result);
    if ("failure" in result)
      throw new errors.OperationFailure(result.failure, {
        dispatch:
          result.failure === "form_changed" || result.failure === "not_submitted"
            ? "not_sent"
            : "sent",
      });
    // The 201 with its Location confirmed the write. Record it now, with no further call.
    verified();
    return { id: result.id };
  },
);
