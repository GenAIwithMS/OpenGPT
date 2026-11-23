import { Schema } from "effect";
import { defineOperation, OperationFailure } from "../../src/browser/index.js";

export interface LayoutObservation {
  readonly loading: boolean;
  readonly tables: number;
  readonly lists: number;
}

/** Observations come from current structure, never customer values or page hashes. */
export const selectInvoiceLayout = (observed: LayoutObservation): "table" | "cards" => {
  if (observed.tables > 1 || observed.lists > 1)
    throw new OperationFailure("identity_mismatch", { dispatch: "not_sent" });
  if (observed.loading) throw new OperationFailure("loading", { dispatch: "not_sent" });
  if (observed.tables === 1 && observed.lists === 1)
    throw new OperationFailure("ambiguous", { dispatch: "not_sent" });
  if (observed.tables === 1) return "table";
  if (observed.lists === 1) return "cards";
  throw new OperationFailure("unsupported", { dispatch: "not_sent" });
};

// Two observed account layouts, old table and new cards, handled inside one script. The same
// call observes the layout and reads it; the choice is made from that observation.
export default defineOperation(
  {
    name: "read_invoice_ids",
    input: Schema.Struct({}),
    output: Schema.Struct({
      ids: Schema.Array(Schema.NonEmptyTrimmedString).annotations({
        description: "IDs of the account's invoices, in page order",
      }),
    }),
  },
  async ({ kernel, sessionId, errors }) => {
    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 30,
      code: `
        const table = page.getByRole("table", { name: "Invoices", exact: true });
        const cards = page.getByRole("list", { name: "Invoices", exact: true });
        const ids = async (container) =>
          (await container.count()) === 1
            ? container.locator("[data-invoice-id]").evaluateAll((nodes) =>
                nodes.map((node) => node.getAttribute("data-invoice-id")),
              )
            : [];
        return {
          observed: {
            loading: (await page.getByRole("progressbar").count()) > 0,
            tables: await table.count(),
            lists: await cards.count(),
          },
          table: await ids(table),
          cards: await ids(cards),
        };
      `,
    });
    if (!answer.success)
      throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
    const result = Schema.decodeUnknownSync(
      Schema.Struct({
        observed: Schema.Struct({
          loading: Schema.Boolean,
          tables: Schema.Number,
          lists: Schema.Number,
        }),
        table: Schema.Array(Schema.NullOr(Schema.String)),
        cards: Schema.Array(Schema.NullOr(Schema.String)),
      }),
    )(answer.result);
    const ids = result[selectInvoiceLayout(result.observed)];
    return {
      ids: Schema.decodeUnknownSync(Schema.Array(Schema.NonEmptyTrimmedString), { errors: "all" })(ids),
    };
  },
);
