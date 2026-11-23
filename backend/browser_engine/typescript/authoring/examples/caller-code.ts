import { Schema } from "effect";
import { defineOperation, waitCode } from "../../src/browser/index.js";

// A code the site sends during the action splits the flow into two calls. The first call stops
// where the site asks for the code; the script asks the caller for it, and the second call gets
// the code in its code. The page, cookies and any open dialog stay the same between the calls.
export default defineOperation(
  {
    name: "confirm_address_change",
    input: Schema.Struct({}),
    output: Schema.Struct({
      confirmed: Schema.Literal(true).annotations({
        description: "True once the site confirms the address change",
      }),
    }),
    // A secret: only the caller has it, and it stays out of traces, logs and the minting model.
    questions: {
      code: {
        type: "secret",
        secretKind: "one_time_code",
        prompt: "Enter the verification code the website just sent you.",
      },
    },
  },
  async ({ kernel, sessionId, siteOrigin, siteDomain, ask, errors }) => {
    if (siteOrigin === undefined)
      throw new errors.OperationFailure("No site origin for a live run", { dispatch: "not_sent" });
    const sent = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 60,
      code: `
        // On the site: any https host on the host's site domain, else the site origin alone.
        const siteDomain = ${JSON.stringify(siteDomain ?? null)};
        const onSite = (url) => siteDomain === null ? url.origin === ${JSON.stringify(siteOrigin)}
          : url.protocol === "https:" && (url.hostname === siteDomain || url.hostname.endsWith("." + siteDomain));
        ${waitCode}
        const current = new URL(page.url());
        if (!onSite(current)) return false;
        // The code field shows once the site sent the code; a page that stops progressing without
        // it fails in seconds.
        const send = page.getByRole("button", { name: "Send code", exact: true });
        await waitForOutcome(
          { field: page.getByLabel("Verification code", { exact: true }) },
          { action: () => send.click({ timeout: waitLimits.action }) },
        );
        return true;
      `,
    });
    if (!sent.success)
      throw new errors.OperationFailure(String(sent.error), { stderr: sent.stderr });
    if (sent.result !== true)
      throw new errors.OperationFailure("Unexpected page", { dispatch: "not_sent" });
    // The deadline pauses while the caller finds the code; no answer fails the run as no_response.
    const code = await ask("code");
    const confirmed = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 60,
      code: `
        ${waitCode}
        await page.getByLabel("Verification code", { exact: true }).fill(${JSON.stringify(code)}, { timeout: waitLimits.action });
        // The confirm is sent once; a page that shows no confirmation is reported unconfirmed.
        const confirm = page.getByRole("button", { name: "Confirm", exact: true });
        const done = page.getByRole("status", { name: "Address change confirmed", exact: true });
        return await waitForOutcome({ done }, { action: () => confirm.click({ timeout: waitLimits.action }) }).then(
          () => true,
          (error) => {
            if (error.name !== "OutcomeWaitFailure") throw error;
            return false;
          },
        );
      `,
    });
    if (!confirmed.success)
      throw new errors.OperationFailure(String(confirmed.error), {
        dispatch: "sent",
        stderr: confirmed.stderr,
      });
    if (confirmed.result !== true)
      throw new errors.OperationFailure("The change was not confirmed", { dispatch: "sent" });
    return { confirmed: true as const };
  },
);
