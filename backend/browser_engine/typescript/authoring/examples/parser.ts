import { Schema } from "effect";
import { defineOperation } from "../../src/browser/index.js";

const Invoice = Schema.Struct({
  id: Schema.NonEmptyTrimmedString.annotations({ description: "The site's invoice ID" }),
  total_minor: Schema.Int.annotations({ description: "Invoice total in minor units (cents)" }),
  currency: Schema.Literal("USD").annotations({ description: "Currency of the total" }),
});
const Body = Schema.Struct({
  invoices: Schema.Array(Invoice).annotations({ description: "Invoices in the body, in order" }),
  complete: Schema.Boolean.annotations({ description: "True when the body lists every invoice" }),
});

// An offline Kernel script: it makes no execute call, so it runs with no browser.
export default defineOperation(
  {
    name: "parse_invoices",
    input: Schema.Struct({
      body: Schema.String.annotations({ description: "Invoice list response body, as JSON text" }),
    }),
    output: Body,
  },
  async ({ input }) => {
    const response = Schema.decodeUnknownSync(Schema.parseJson(Body))(input.body);
    return { invoices: response.invoices, complete: response.complete };
  },
);
