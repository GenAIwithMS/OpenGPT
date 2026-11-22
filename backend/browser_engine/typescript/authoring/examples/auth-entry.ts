import { Schema } from "effect";
import { defineOperation, timeoutDefaults } from "../../src/browser/index.js";

const Entry = Schema.Struct({
  origin: Schema.String.annotations({ description: "Origin of the member login page" }),
  pathname: Schema.String.annotations({ description: "Path of the member login page" }),
  controls: Schema.Array(
    Schema.Struct({
      tag: Schema.String.annotations({ description: "The control's tag name, such as input" }),
      type: Schema.String.annotations({
        description: "The control's type attribute, empty when it has none",
      }),
    }),
  ).annotations({ description: "The login form's input and button controls, without values" }),
  coverage: Schema.Literal("observed_login_form").annotations({
    description: "What the read reached: the login form itself",
  }),
});

// Second anonymous probe: these selectors/path come from prior page evidence, which
// showed "Log in" links for employers and members; the member one is in "Members".
// Adapt the schema to the real host-bound business input, not probe arguments.
export default defineOperation(
  {
    name: "inspect_member_login_entry",
    input: Schema.Struct({}),
    output: Entry,
  },
  async ({ kernel, sessionId, siteOrigin, siteDomain, errors }) => {
    if (siteOrigin === undefined)
      throw new errors.OperationFailure("No site origin for a live run", { dispatch: "not_sent" });
    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 60,
      code: `
        const until = Date.now() + ${timeoutDefaults.navigation};
        const remaining = () => Math.max(1, until - Date.now());
        // On the site: any https host on the host's site domain, else the site origin alone.
        const siteDomain = ${JSON.stringify(siteDomain ?? null)};
        const onSite = (url) => siteDomain === null ? url.origin === ${JSON.stringify(siteOrigin)}
          : url.protocol === "https:" && (url.hostname === siteDomain || url.hostname.endsWith("." + siteDomain));
        const current = new URL(page.url());
        if (!onSite(current)) return null;
        // Never .first() of a broad text match: scope to the evidenced container and to
        // visible links (collapsed menus hold hidden duplicates), then require exactly one.
        const entry = page
          .getByRole("navigation", { name: "Members", exact: true })
          .getByRole("link", { name: "Log in", exact: true })
          .filter({ visible: true });
        if ((await entry.count()) !== 1) return null;
        const href = await entry.getAttribute("href");
        if (href === null) return null;
        const destination = new URL(href, current);
        if (destination.protocol !== "https:" || destination.username || destination.password || destination.pathname !== "/member/login") return null;
        // The host enforces same registrable domain or independently approved SSO authority.
        // Observed links and this example cannot authorize unrelated sites.
        await entry.click({ timeout: remaining() });
        await page.waitForURL((url) => url.protocol === "https:" && url.pathname === "/member/login", { waitUntil: "domcontentloaded", timeout: remaining() });
        const readEntry = async () => {
          // A signInStep names a control with a selector string instead of a locator call, such as
          // role=textbox[name="Username" s] for this field: exact is a locator option, not an attribute.
          const form = page.getByRole("form", { name: "Member login", exact: true });
          await form.getByLabel("Username", { exact: true }).waitFor({ state: "visible", timeout: remaining() });
          const final = new URL(page.url());
          if (final.protocol !== "https:" || final.username || final.password || final.pathname !== "/member/login") return null;
          // Report control kinds only, never field values.
          const controls = await form.locator("input, button").evaluateAll((elements) =>
            elements.map((element) => ({
              tag: element.tagName.toLowerCase(),
              type: element.getAttribute("type") ?? "",
            })),
          );
          return { origin: final.origin, pathname: final.pathname, controls, coverage: "observed_login_form" };
        };
        while (true) {
          try { return await readEntry(); }
          catch (error) {
            if (!String(error).includes("Execution context was destroyed") || Date.now() >= until) throw error;
            // The click is outside recovery: reacquire the new document's locators and read only.
            await page.waitForLoadState("domcontentloaded", { timeout: remaining() });
          }
        }
      `,
    });
    if (!answer.success)
      throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
    if (answer.result === null)
      throw new errors.OperationFailure("The member login entry is unavailable");
    return Schema.decodeUnknownSync(Entry)(answer.result);
  },
);
