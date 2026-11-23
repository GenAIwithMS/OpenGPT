import { Schema } from "effect";
import { expect, it } from "vitest";
import { standard } from "../../src/mcp/schema.js";

// A tool input that takes one of two object shapes, as a lookup by id or a search does.
const lookupOrSearch = Schema.Union(
  Schema.Struct({ id: Schema.String }),
  Schema.Struct({ query: Schema.optional(Schema.String), limit: Schema.optional(Schema.Number) }),
);
const issues = (value: unknown) => {
  const result = standard(lookupOrSearch)["~standard"].validate(value);
  if (result instanceof Promise || !("issues" in result)) throw new Error("expected issues");
  return result.issues ?? [];
};

it("names a field that every shape of an input refuses once", () => {
  const refused = issues({ task: "books" });
  expect(refused.map((issue) => issue.path)).toEqual([["task"]]);
});
