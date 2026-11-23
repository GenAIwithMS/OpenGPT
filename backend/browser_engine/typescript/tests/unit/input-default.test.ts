import { Effect, Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { defaultedInput } from "../../src/browser/index.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import { runLocalOperation } from "../../src/execution/local-operation.js";
import { contractJsonSchema } from "../../src/runtime/operation.js";

// A build answer about how a tool behaves, such as sorting by price, is the tool's default: an
// optional input a caller may leave out, whose published schema shows the answered value.
describe("an input that defaults to a build answer", () => {
  const Sort = Schema.Literal("price", "name", "newest");
  const input = Schema.Struct({
    query: Schema.String,
    sort: defaultedInput(Sort, "price"),
    apply_rules: defaultedInput(Schema.Boolean, true),
  });

  it("is optional and publishes the answered value as its default", () => {
    const schema = contractJsonSchema(input) as {
      required: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.required).toEqual(["query"]);
    expect(schema.properties["sort"]).toMatchObject({ enum: ["price", "name", "newest"], default: "price" });
    expect(schema.properties["apply_rules"]).toMatchObject({ type: "boolean", default: true });
  });

  it("applies the default when the caller leaves it out, and the caller's value otherwise", () => {
    const decode = Schema.decodeUnknownSync(input);
    expect(decode({ query: "lamp" })).toEqual({ query: "lamp", sort: "price", apply_rules: true });
    expect(decode({ query: "lamp", sort: "newest", apply_rules: false })).toEqual({
      query: "lamp",
      sort: "newest",
      apply_rules: false,
    });
    expect(Either.isLeft(Schema.decodeUnknownEither(input)({ query: "lamp", sort: "rating" }))).toBe(
      true,
    );
  });

  it("reaches a script's run as its default and its published schema", async () => {
    const source = `import { Schema } from "effect";
import { defaultedInput, defineOperation } from "../runtime/index.js";
export default defineOperation({name:"search",input:Schema.Struct({query:Schema.String,sort:defaultedInput(Schema.Literal("price","name"),"price")}),output:Schema.Unknown}, async ({ input }) => input);`;
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workspace = yield* createLocalWorkspace();
          return yield* runLocalOperation({
            workspace,
            entrypoint: "src/tool.mjs",
            sources: [["src/tool.mjs", source]],
            input: { query: "lamp" },
            target: "pureFiles",
          });
        }),
      ),
    );
    expect(result.output).toEqual({ query: "lamp", sort: "price" });
    expect(result.schemas.input).toMatchObject({ properties: { sort: { default: "price" } } });
  });
});
