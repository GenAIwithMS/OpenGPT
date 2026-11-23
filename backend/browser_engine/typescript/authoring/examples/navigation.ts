import { Schema } from "effect";
import { defineOperation, waitCode } from "../../src/browser/index.js";

const RecordId = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{1,100}$/));
const Detail = Schema.Union(
  Schema.Struct({ title: Schema.NonEmptyTrimmedString }),
  Schema.Struct({ refused: Schema.NonEmptyTrimmedString }),
  Schema.Struct({
    failure: Schema.Literal(
      "search_unavailable",
      "results_unavailable",
      "result_ambiguous",
      "detail_unavailable",
      "identity_mismatch",
      "interstitial_unowned",
      "target_mismatch",
    ),
  }),
);

// Page code, after waitCode: the record's title once the detail shows it filled in and holding.
// A heading still empty or loading when the page stops progressing throws values_loading, which
// the host retries once like a timeout; it is never turned into a missing title.
const readTitleCode = `
  const readTitle = async (detail) => {
    const { values } = await waitForValues({ title: detail.getByRole("heading", { level: 1 }) });
    return { title: values.title };
  };
`;

// Reaches the record through the site's own controls: its search, then the result's own link.
// This site's search loads a results page that is busy until it lists each record as a link named
// by its ID, or says none match, and shows an alert when the search fails. Adapt every role, name
// and attribute from your own session's evidence.
export const detailNavigation = defineOperation(
  {
    name: "read_record_detail",
    input: Schema.Struct({
      record_id: RecordId.annotations({
        description: "ID of the record to read, as the site shows it",
        examples: ["record_42"],
      }),
    }),
    output: Schema.Struct({
      record_id: RecordId.annotations({ description: "ID of the record read" }),
      title: Schema.NonEmptyTrimmedString.annotations({ description: "The record's title" }),
    }),
  },
  async ({ kernel, sessionId, siteOrigin, siteDomain, input, errors }) => {
    if (siteOrigin === undefined)
      throw new errors.OperationFailure("No site origin for a live run", { dispatch: "not_sent" });
    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 120,
      code: `
        ${waitCode}
        ${readTitleCode}
        // On the site: any https host on the host's site domain, else the site origin alone.
        const siteDomain = ${JSON.stringify(siteDomain ?? null)};
        const onSite = (url) => siteDomain === null ? url.origin === ${JSON.stringify(siteOrigin)}
          : url.protocol === "https:" && (url.hostname === siteDomain || url.hostname.endsWith("." + siteDomain));
        const recordId = ${JSON.stringify(input.record_id)};
        // The outcome a wait settles on, or the one that stayed ambiguous. A page that showed no
        // answer throws outcome_unknown or outcome_timeout, which the host retries once.
        const settle = async (outcomes, options) => {
          try {
            return { shown: await waitForOutcome(outcomes, options) };
          } catch (error) {
            if (error.name !== "OutcomeWaitFailure" || error.reason !== "outcome_ambiguous") throw error;
            return { ambiguous: error.outcome };
          }
        };
        // The entry page holds no caller input. Type the identifier into the site's own search.
        await page.goto(${JSON.stringify(siteOrigin)}, { waitUntil: "domcontentloaded", timeout: waitLimits.navigation });
        const search = page.getByRole("search").getByRole("searchbox", { name: "Record ID", exact: true });
        if ((await search.count()) !== 1) return { failure: "search_unavailable" };
        await search.fill(recordId, { timeout: waitLimits.action });
        // The search has finished only when the site shows its answer to this search, once its
        // results stop being busy: its error, its own word that nothing matches, or one matching
        // link. Pressing Enter is the wait's action, so nothing shown before it is the answer.
        const results = page
          .getByRole("region", { name: "Search results", exact: true })
          .and(page.locator(':not([aria-busy="true"])'));
        const links = results.getByRole("link", { name: recordId, exact: true });
        const searched = await settle({
          failed: page.getByRole("alert"),
          none: results.getByRole("status").filter({ hasText: /^No matching records$/ }),
          found: links,
        }, { action: () => search.press("Enter", { timeout: waitLimits.action }) });
        // Only the site's own empty result says the record does not exist.
        if (searched.shown === "none") return { refused: "The site's search lists no record with this ID" };
        if (searched.shown !== "found")
          return { failure: searched.ambiguous === "found" ? "result_ambiguous" : "results_unavailable" };
        const resultsUrl = page.url();
        // The final page is checked against the link's own href, a URL the site produced.
        const target = new URL(await links.getAttribute("href"), resultsUrl);
        if (!onSite(target)) return { failure: "target_mismatch" };
        const targetPath = target.pathname;
        const detail = page.getByRole("region", { name: "Record details", exact: true });
        const interstitial = page.getByRole("region", { name: "Continue to record", exact: true });
        const proceed = interstitial.getByRole("button", { name: "Continue", exact: true });
        // Wait for the record's page, then check that the site, path and the page's own record
        // id all match the request.
        const offTarget = () => {
          const current = new URL(page.url());
          return !onSite(current) || current.pathname !== targetPath;
        };
        const reached = async (outcomes) => {
          // A page already off the target fails at once; one that moves there while loading fails after.
          if (offTarget()) return "target_mismatch";
          const { shown } = await settle(outcomes);
          if (offTarget()) return "target_mismatch";
          if (shown === undefined) return "detail_unavailable";
          const shownId = await (shown === "detail" ? detail : interstitial).getAttribute("data-record-id");
          if (shownId !== recordId) return "identity_mismatch";
          if (shown === "interstitial" && (await proceed.count()) !== 1) return "interstitial_unowned";
          return shown;
        };
        await links.click({ timeout: waitLimits.action });
        await page.waitForURL((url) => url.href !== resultsUrl, { waitUntil: "domcontentloaded", timeout: waitLimits.navigation });
        let state = await reached({ detail, interstitial });
        // Continue only through an interstitial whose own identity matches the request.
        if (state === "interstitial") {
          await proceed.click({ timeout: waitLimits.action });
          state = await reached({ detail });
        }
        if (state !== "detail") return { failure: state };
        return await readTitle(detail);
      `,
    });
    if (!answer.success)
      throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
    const result = Schema.decodeUnknownSync(Detail)(answer.result);
    if ("refused" in result) throw new errors.InvalidInput(result.refused, { field: "record_id" });
    if ("failure" in result) throw new errors.OperationFailure(result.failure);
    return { record_id: input.record_id, title: result.title };
  },
);

// A details tool whose input is the record's page URL, such as a link the caller copied from the
// site, opens it unchanged: never rebuilt, trimmed or reached through the site's search. Only an
// https URL on the tool's site is opened, and the page's own record id is read back.
export const detailFromUrl = defineOperation(
  {
    name: "read_record_detail_from_url",
    input: Schema.Struct({
      record_url: Schema.String.annotations({
        description: "The record's page URL on the site, as the caller copied it",
        examples: ["https://records.example.com/records/record_42"],
      }),
    }),
    output: Schema.Struct({
      record_id: RecordId.annotations({ description: "ID of the record the page shows" }),
      title: Schema.NonEmptyTrimmedString.annotations({ description: "The record's title" }),
    }),
  },
  async ({ kernel, sessionId, siteOrigin, siteDomain, input, errors }) => {
    if (siteOrigin === undefined)
      throw new errors.OperationFailure("No site origin for a live run", { dispatch: "not_sent" });
    const requested = URL.parse(input.record_url);
    const onSite = (url: URL) =>
      siteDomain === undefined
        ? url.origin === siteOrigin
        : url.protocol === "https:" &&
          (url.hostname === siteDomain || url.hostname.endsWith(`.${siteDomain}`));
    if (requested === null || requested.protocol !== "https:" || !onSite(requested))
      throw new errors.InvalidInput("record_url must be an https page on this site", {
        field: "record_url",
      });
    // The record the link names, as the site's own links name it; the page must show the same one.
    const expected = requested.pathname.split("/").at(-1) ?? "";
    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 120,
      code: `
        ${waitCode}
        ${readTitleCode}
        const siteDomain = ${JSON.stringify(siteDomain ?? null)};
        const onSite = (url) => siteDomain === null ? url.origin === ${JSON.stringify(siteOrigin)}
          : url.protocol === "https:" && (url.hostname === siteDomain || url.hostname.endsWith("." + siteDomain));
        const expected = ${JSON.stringify(expected)};
        // The caller's URL exactly as given.
        await page.goto(${JSON.stringify(input.record_url)}, { waitUntil: "domcontentloaded", timeout: waitLimits.navigation });
        const detail = page.getByRole("region", { name: "Record details", exact: true });
        const interstitial = page.getByRole("region", { name: "Continue to record", exact: true });
        const proceed = interstitial.getByRole("button", { name: "Continue", exact: true });
        // The site's own page for an unknown record.
        const missing = page.getByRole("heading", { name: "Record not found", exact: true });
        // The site may serve the record under another of its routes; its own record id decides.
        // A page that shows none of these answers and stops progressing throws outcome_unknown,
        // which the host retries once, in seconds rather than after a fixed wait.
        const settle = async (outcomes, options) => {
          if (!onSite(new URL(page.url()))) return { state: "target_mismatch" };
          let shown;
          try {
            shown = await waitForOutcome(outcomes, options);
          } catch (error) {
            if (error.name !== "OutcomeWaitFailure" || error.reason !== "outcome_ambiguous") throw error;
            return { state: "ambiguous" };
          }
          if (!onSite(new URL(page.url()))) return { state: "target_mismatch" };
          if (shown === "missing") return { state: "missing" };
          return { state: shown, id: await (shown === "detail" ? detail : interstitial).getAttribute("data-record-id") };
        };
        let seen = await settle({ missing, detail, interstitial });
        if (seen.state === "interstitial" && seen.id === expected && (await proceed.count()) === 1)
          seen = await settle({ missing, detail }, { action: () => proceed.click({ timeout: waitLimits.action }) });
        if (seen.state === "missing") return { refused: "The site has no record at this URL" };
        if (seen.state === "target_mismatch") return { failure: "target_mismatch" };
        if (seen.state !== "detail" && seen.state !== "interstitial") return { failure: "detail_unavailable" };
        if (seen.id !== expected) return { failure: "identity_mismatch" };
        if (seen.state !== "detail") return { failure: "interstitial_unowned" };
        return await readTitle(detail);
      `,
    });
    if (!answer.success)
      throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
    const result = Schema.decodeUnknownSync(Detail)(answer.result);
    if ("refused" in result) throw new errors.InvalidInput(result.refused, { field: "record_url" });
    if ("failure" in result) throw new errors.OperationFailure(result.failure);
    return { record_id: expected, title: result.title };
  },
);

// The site's own results URL for a search, kept as data. The build proved it: for two different
// queries it opened the same results the site's own search controls showed, on the same path
// those controls land on. Fill each param from the named input field; never vary the template.
const resultsRoute = { path: "/search", params: { q: "query" } } as const;

const Found = Schema.Union(
  Schema.Struct({
    rows: Schema.Array(Schema.Struct({ key: Schema.NonEmptyTrimmedString, name: Schema.NonEmptyTrimmedString })),
    more: Schema.Boolean,
  }),
  Schema.Struct({
    failure: Schema.Literal(
      "search_unavailable",
      "query_mismatch",
      "search_failed",
    ),
  }),
);

// Reaches a search's results by the site's own results URL, and checks that the page answers this
// search: one of its expected answers shows and its search box holds the query. A landing on any
// other page, no answer, or another query's results means the URL no longer works this way, so
// the run opens the site and uses its search controls once instead. Adapt every role, name,
// attribute and the route from your own session's evidence.
export const searchThenRead = defineOperation(
  {
    name: "search_rooms",
    input: Schema.Struct({
      query: Schema.NonEmptyString.pipe(Schema.pattern(/\S/u)).annotations({
        description: "Text to search rooms for",
        examples: ["room"],
      }),
      limit: Schema.Int.pipe(Schema.between(1, 50)).annotations({
        description: "Most rooms to return, in the site's order",
      }),
    }),
    output: Schema.Struct({
      rooms: Schema.Array(
        Schema.Struct({
          id: Schema.NonEmptyTrimmedString.annotations({ description: "The room's ID on the site" }),
          name: Schema.NonEmptyTrimmedString.annotations({ description: "The room's name" }),
        }),
      ),
      more: Schema.Boolean.annotations({ description: "Whether the site lists more rooms" }),
    }),
  },
  async ({ kernel, sessionId, siteOrigin, siteDomain, input, errors }) => {
    if (siteOrigin === undefined)
      throw new errors.OperationFailure("No site origin for a live run", { dispatch: "not_sent" });
    const resultsUrl = new URL(resultsRoute.path, siteOrigin);
    resultsUrl.search = new URLSearchParams(
      Object.entries(resultsRoute.params).map(([param, field]) => [param, input[field]]),
    ).toString();
    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 120,
      code: `
        ${waitCode}
        // On the site: any https host on the host's site domain, else the site origin alone.
        const siteDomain = ${JSON.stringify(siteDomain ?? null)};
        const onSite = (url) => siteDomain === null ? url.origin === ${JSON.stringify(siteOrigin)}
          : url.protocol === "https:" && (url.hostname === siteDomain || url.hostname.endsWith("." + siteDomain));
        const query = ${JSON.stringify(input.query.trim())};
        // The site's own requests, on every host of its domain, count as progress.
        const site = siteDomain === null ? {} : { siteDomain };
        const results = page.getByRole("list", { name: "Rooms", exact: true });
        // Every answer the site gives a search, highest priority first.
        const answers = {
          failed: page.getByRole("alert"),
          empty: page.getByRole("status").filter({ hasText: /^No matching rooms$/ }),
          results,
        };
        const searchBox = page.getByRole("search").getByRole("searchbox", { name: "Search rooms", exact: true });
        // The answer the template's page showed, or undefined when it showed none: then the
        // controls run instead.
        const answered = async (options) => {
          try {
            return await waitForOutcome(answers, { ...site, ...options });
          } catch (error) {
            if (error.name !== "OutcomeWaitFailure") throw error;
            return undefined;
          }
        };
        // The query the page says it answers: its search box's committed value.
        const shownQuery = async () =>
          (await searchBox.count()) === 1 ? (await searchBox.inputValue({ timeout: waitLimits.action })).trim() : null;
        // The site's own search, run once from its entry page.
        const throughControls = async () => {
          await page.goto(${JSON.stringify(new URL("/", siteOrigin).href)}, { waitUntil: "domcontentloaded", timeout: waitLimits.navigation });
          if ((await searchBox.count()) !== 1) return "search_unavailable";
          await searchBox.fill(query, { timeout: waitLimits.action });
          // No fallback after the fallback: a page that shows no answer throws, and the host retries.
          const shown = await waitForOutcome(answers, { ...site, action: () => searchBox.press("Enter", { timeout: waitLimits.action }) });
          return (await shownQuery()) === query ? shown : "query_mismatch";
        };
        await page.goto(${JSON.stringify(resultsUrl.href)}, { waitUntil: "domcontentloaded", timeout: waitLimits.navigation });
        const landed = new URL(page.url());
        let shown = onSite(landed) && landed.pathname === ${JSON.stringify(resultsRoute.path)} ? await answered() : undefined;
        if (shown === undefined || (await shownQuery()) !== query) shown = await throughControls();
        if (shown === "failed") return { failure: "search_failed" };
        if (shown === "empty") return { rows: [], more: false };
        if (shown !== "results") return { failure: shown };
        // Rows still loading when the page stops progressing throw values_loading for the host.
        return await waitForRows(results.getByRole("listitem"), { name: ".name" }, {
          count: ${input.limit},
          key: { attribute: "data-room-id" },
          region: results,
          ...site,
        });
      `,
    });
    if (!answer.success)
      throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
    const result = Schema.decodeUnknownSync(Found)(answer.result);
    if ("failure" in result) throw new errors.OperationFailure(result.failure);
    return { rooms: result.rows.map(({ key, name }) => ({ id: key, name })), more: result.more };
  },
);

// A bounded first-page read. A fast exploration load does not remove the readiness wait.
export default defineOperation(
  {
    name: "read_catalog_heading",
    input: Schema.Struct({}),
    output: Schema.Struct({
      heading: Schema.NonEmptyTrimmedString.annotations({ description: "The catalog page's heading" }),
    }),
  },
  async ({ kernel, sessionId, siteOrigin, siteDomain, errors, waitPastChallenge }) => {
    if (siteOrigin === undefined)
      throw new errors.OperationFailure("No site origin for a live run", { dispatch: "not_sent" });
    const site = new URL(siteOrigin);
    const readHeading = `
      // On the site: any https host on the host's site domain, else the site origin alone.
      const siteDomain = ${JSON.stringify(siteDomain ?? null)};
      const onSite = (url) => siteDomain === null ? url.origin === ${JSON.stringify(siteOrigin)}
        : url.protocol === "https:" && (url.hostname === siteDomain || url.hostname.endsWith("." + siteDomain));
      const current = new URL(page.url());
      if (!onSite(current)) return { failure: "unsupported_page" };
      if (current.pathname !== "/catalog") return { failure: "unsupported_page" };
      const text = (await page.getByRole("heading", { name: "Catalog", exact: true }).innerText()).trim();
      return text === "Catalog" ? { heading: text } : { failure: "unsupported_page" };
    `;
    const first = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 60,
      code: `
        ${waitCode}
        await page.goto(${JSON.stringify(`${site.origin}/catalog`)}, { waitUntil: "domcontentloaded", timeout: waitLimits.navigation });
        // This site's observed verification page says "Verifying your browser". It wins over the
        // heading when both show.
        const shown = await waitForOutcome({
          challenge: page.getByText("Verifying your browser", { exact: true }),
          heading: page.getByRole("heading", { name: "Catalog", exact: true }),
        });
        if (shown === "challenge") return { challenge: true };
        ${readHeading}
      `,
    });
    if (!first.success)
      throw new errors.OperationFailure(String(first.error), { stderr: first.stderr });
    let answer: unknown = first.result;
    if (typeof answer === "object" && answer !== null && "challenge" in answer) {
      // Give Kernel's solver its window. This throws ChallengeFailure when the page stays
      // blocked; the host then moves to a new browser mode on an empty profile. Never
      // click or reload it.
      await waitPastChallenge({
        ready: `return await page.getByRole("heading", { name: "Catalog", exact: true }).isVisible();`,
      });
      const next = await kernel.browsers.playwright.execute(sessionId, {
        timeout_sec: 30,
        code: readHeading,
      });
      if (!next.success)
        throw new errors.OperationFailure(String(next.error), { stderr: next.stderr });
      answer = next.result;
    }
    const result = Schema.decodeUnknownSync(
      Schema.Union(
        Schema.Struct({ heading: Schema.NonEmptyTrimmedString }),
        Schema.Struct({ failure: Schema.Literal("unsupported_page") }),
      ),
    )(answer);
    if ("failure" in result)
      throw new errors.OperationFailure(result.failure, { dispatch: "not_sent" });
    return result;
  },
);
