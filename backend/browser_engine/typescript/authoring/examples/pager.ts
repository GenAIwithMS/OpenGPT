import { Schema } from "effect";
import {
  defineOperation,
  listInputFields,
  listOutputFields,
  pagedListReader,
  readList,
  startList,
} from "../../src/browser/index.js";

// A list read with the runtime's pager. `pagedListReader` gives `readList` its site actions:
// `start` opens the list as the first call does, and the pager finds the list's Next, page numbers,
// "Load more" control or scroll, steps it, waits for each step by what it changed, reads the rows
// with `waitForRows` and the site's total from its summary. A later call starts the list again and
// reaches the cursor's page by the site's own link when it has one, else by its page numbers, or
// replays its steps. The selectors are site logic: replace them with what the build observed, and
// name a control in `listPager` only when the pager does not find the right one on its own. While
// building, `return await pager.detect();` after `start` reports the mechanism to name.

const Item = Schema.Struct({
  id: Schema.NonEmptyTrimmedString.annotations({ description: "The record's ID on the site" }),
  name: Schema.NonEmptyTrimmedString.annotations({ description: "The record's name as the site shows it" }),
});

export default defineOperation(
  {
    name: "list_records",
    input: Schema.Struct({ ...listInputFields }),
    output: Schema.Struct({
      records: Schema.Array(Item).annotations({ description: "Records in the site's order" }),
      ...listOutputFields,
    }),
  },
  async ({ kernel, sessionId, siteOrigin, siteDomain, input, remainingMs, errors }) => {
    // Before any browser work: the limit, and on a later page the position the cursor holds.
    const list = startList(input, { mechanism: "pages" });
    if (siteOrigin === undefined)
      throw new errors.OperationFailure("No site origin for a live run", { dispatch: "not_sent" });
    // One Kernel call per read, inside the run's own deadline.
    const execute = async (code: string) => {
      const timeoutSec = Math.min(60, Math.floor(remainingMs() / 1_000) - 1);
      if (timeoutSec < 1) throw new errors.OperationFailure("No time left to read the list");
      const answer = await kernel.browsers.playwright.execute(sessionId, { timeout_sec: timeoutSec, code });
      if (!answer.success)
        throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
      return answer.result;
    };
    const page = await readList(
      list,
      pagedListReader({
        mechanism: "pages",
        execute,
        // The rows, each row's identity and values, and the site's own empty message.
        setup: `const pager = listPager({
          rows: page.locator("#rows > tr"),
          key: { attribute: "data-id" },
          fields: { name: ".name" },
          empty: page.locator("#rows .empty"),
          ...${JSON.stringify(siteDomain === undefined ? {} : { siteDomain })},
        });`,
        start: `await page.goto(${JSON.stringify(new URL("/records", siteOrigin).href)}, { waitUntil: "domcontentloaded", timeout: waitLimits.navigation });`,
        row: (row) => Schema.decodeUnknownSync(Item)({ id: row.key, name: row.name }),
        keyOf: (item) => item.id,
        remainingMs,
      }),
    );
    return { records: page.rows, ...page.output };
  },
);
