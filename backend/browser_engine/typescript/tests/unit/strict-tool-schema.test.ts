import { JSONSchema, Schema } from "effect";
import { expect, it } from "vitest";
import { strictToolSchema } from "../../src/mint/strict-tool-schema.js";

const Step = Schema.Union(
  Schema.Struct({ fields: Schema.Array(Schema.String), submit: Schema.optional(Schema.String) }),
  Schema.Struct({ approval: Schema.Literal("ask"), popup: Schema.optional(Schema.Boolean) }),
);
const Request = Schema.Struct({
  purpose: Schema.String,
  loginUrl: Schema.optional(Schema.String),
  step: Schema.optional(Step),
  rows: Schema.Array(Schema.Struct({ id: Schema.String, note: Schema.optional(Schema.String) })),
  limit: Schema.NullOr(Schema.Number),
});
const strict = strictToolSchema(JSONSchema.make(Request));

/** Every object property required and closed, at any depth: what strict mode takes. */
const everyObjectClosed = (schema: unknown): boolean => {
  if (Array.isArray(schema)) return schema.every(everyObjectClosed);
  if (typeof schema !== "object" || schema === null) return true;
  const node = schema as Record<string, unknown>;
  if (typeof node["properties"] === "object" && node["properties"] !== null) {
    const keys = Object.keys(node["properties"]).sort();
    const required = [...((node["required"] as string[] | undefined) ?? [])].sort();
    if (JSON.stringify(keys) !== JSON.stringify(required) || node["additionalProperties"] !== false)
      return false;
  }
  return Object.values(node).every(everyObjectClosed);
};

it("requires every property, nullable where it was optional, at every depth and in every branch", () => {
  expect(everyObjectClosed(strict.parameters)).toBe(true);
  const properties = strict.parameters["properties"] as Record<string, Record<string, unknown>>;
  expect(properties["loginUrl"]).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
  // A field that was already nullable and required keeps its own null.
  expect(JSON.stringify(properties["limit"])).toContain('"null"');
  expect(properties["limit"]?.["anyOf"]).toHaveLength(2);
});

it("drops the nulls that stand for absent fields, choosing a union's branch by its field names", () => {
  expect(
    strict.restore({
      purpose: "example",
      loginUrl: null,
      step: { approval: "ask", popup: null },
      rows: [
        { id: "a", note: null },
        { id: "b", note: "kept" },
      ],
      limit: null,
    }),
  ).toEqual({
    purpose: "example",
    step: { approval: "ask" },
    rows: [{ id: "a" }, { id: "b", note: "kept" }],
    limit: null,
  });
  expect(
    strict.restore({
      purpose: "example",
      loginUrl: "https://example.com/login",
      step: { fields: ["#user"], submit: null },
      rows: [],
      limit: 3,
    }),
  ).toEqual({
    purpose: "example",
    loginUrl: "https://example.com/login",
    step: { fields: ["#user"] },
    rows: [],
    limit: 3,
  });
  expect(Schema.decodeUnknownEither(Request)(strict.restore({
    purpose: "example",
    loginUrl: null,
    step: null,
    rows: [],
    limit: null,
  }))._tag).toBe("Right");
});

it("leaves a value that matches no branch for the decode to refuse", () => {
  const value = { purpose: "x", step: { other: 1 }, rows: [], limit: null };
  expect(strict.restore(value)).toEqual(value);
});

it("refuses a field that is both optional and nullable, whose null would be ambiguous", () => {
  const ambiguous = Schema.Struct({ value: Schema.optional(Schema.NullOr(Schema.String)) });
  expect(() => strictToolSchema(JSONSchema.make(ambiguous))).toThrow(/ambiguous/);
});
