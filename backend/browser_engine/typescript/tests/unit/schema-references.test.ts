import { Ajv, AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { JSONSchema, Schema } from "effect";
import { expect, it } from "vitest";
import { canonicalSchema, inlineLocalRefs } from "../../src/registry/schema-references.js";
import type { CanonicalSchema } from "../../src/registry/schema-references.js";

// Every surface reads a tool's schema in one canonical form; a run checks the published one. Each
// case's values must validate the same against both.
const valid = (schema: Record<string, unknown>, value: unknown) =>
  new AjvJsonSchemaValidator().getValidator(schema)(value).valid;
const standalone = (canonical: CanonicalSchema) =>
  Object.keys(canonical.definitions).length === 0
    ? canonical.schema
    : { ...canonical.schema, $defs: canonical.definitions };
const agrees = (published: Record<string, unknown>, values: readonly unknown[]) => {
  const canonical = canonicalSchema(published);
  if (canonical === undefined) throw new Error("expected a canonical schema");
  for (const value of values)
    expect(valid(standalone(canonical), value), JSON.stringify(value)).toBe(valid(published, value));
  return canonical;
};

it("inlines references that expand, and drops the dialect and definition containers", () => {
  const canonical = agrees(
    {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      $defs: { Code: { type: "string", minLength: 3 } },
      definitions: { Count: { type: "integer" } },
      properties: {
        code: { $ref: "#/$defs/Code" },
        count: { $ref: "#/definitions/Count" },
        copy: { $ref: "#/properties/code" },
      },
    },
    [
      { code: "abc", count: 2, copy: "xyz" },
      { code: "a", count: "2", copy: 1 },
    ],
  );
  expect(canonical).toEqual({
    schema: {
      type: "object",
      properties: {
        code: { type: "string", minLength: 3 },
        count: { type: "integer" },
        copy: { type: "string", minLength: 3 },
      },
    },
    definitions: {},
  });
});

it("keeps a recursive schema's references, each pointing at a root definition", () => {
  const tree = {
    type: "object",
    required: ["label"],
    properties: {
      label: { type: "string" },
      children: { type: "array", items: { $ref: "#" } },
    },
  };
  const values = [
    { label: "a", children: [{ label: "b", children: [] }] },
    { label: "a", children: [{ label: 2 }] },
  ];
  const root = agrees(tree, values);
  expect(root.schema).toMatchObject({
    properties: { children: { items: { $ref: "#/$defs/Root" } } },
  });
  expect(root.definitions["Root"]).toEqual(root.schema);

  const draft7 = agrees(
    {
      type: "object",
      definitions: {
        Node: { type: "object", properties: { next: { $ref: "#/definitions/Node" } } },
      },
      properties: { head: { $ref: "#/definitions/Node" } },
    },
    [{ head: { next: { next: {} } } }, { head: { next: 3 } }],
  );
  expect(draft7).toEqual({
    schema: { type: "object", properties: { head: { $ref: "#/$defs/Node" } } },
    definitions: {
      Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } },
    },
  });
});

it("names definitions apart when two containers share a name, and reads escaped pointers", () => {
  const canonical = agrees(
    {
      type: "object",
      $defs: { Item: { type: "object", properties: { more: { $ref: "#/$defs/Item" } } } },
      definitions: { Item: { type: "string" } },
      properties: {
        recursive: { $ref: "#/$defs/Item" },
        named: { $ref: "#/definitions/Item" },
        escaped: { $ref: "#/properties/a~1b%20c" },
        "a/b c": { type: "boolean" },
      },
    },
    [
      { recursive: { more: {} }, named: "x", escaped: true },
      { named: 1, escaped: "no" },
    ],
  );
  // A schema that recurses anywhere keeps all its references.
  expect(canonical.schema).toMatchObject({
    properties: {
      recursive: { $ref: "#/$defs/Item" },
      named: { $ref: "#/$defs/Item_2" },
      escaped: { $ref: "#/$defs/a_b_c" },
    },
  });
  expect(canonical.definitions).toMatchObject({
    Item_2: { type: "string" },
    a_b_c: { type: "boolean" },
  });
});

it("leaves data and property names alone", () => {
  const canonical = canonicalSchema({
    type: "object",
    properties: {
      definitions: { type: "string", examples: [{ $ref: "#/nowhere" }] },
      $ref: { const: { $ref: "#/nowhere" } },
    },
  });
  expect(canonical).toEqual({
    schema: {
      type: "object",
      properties: {
        definitions: { type: "string", examples: [{ $ref: "#/nowhere" }] },
        $ref: { const: { $ref: "#/nowhere" } },
      },
    },
    definitions: {},
  });
});

it("has no canonical form for a reference that names nothing in the schema", () => {
  for (const reference of [
    "#/$defs/Missing",
    "#/properties/missing",
    "https://schemas.example.invalid/item.json",
    "#anchor",
    "#/$defs/Item%zz",
    "#/$defs/%FF",
  ])
    expect(
      canonicalSchema({ type: "object", properties: { item: { $ref: reference } } }),
      reference,
    ).toBeUndefined();
  // A definition nested below the root is not where a root reference resolves.
  expect(
    canonicalSchema({
      type: "object",
      properties: {
        nested: {
          $defs: { Choice: { type: "string" } },
          properties: { choice: { $ref: "#/$defs/Choice" } },
        },
      },
    }),
  ).toBeUndefined();
});

it("keeps both of two constraints on one keyword, the referenced schema's and its own", () => {
  const published = {
    type: "object",
    $defs: {
      Trimmed: { type: "string", pattern: "^\\S(.*\\S)?$" },
      Named: {
        type: "object",
        properties: { name: { type: "string" } },
        additionalProperties: false,
      },
    },
    properties: {
      word: { $ref: "#/$defs/Trimmed", minLength: 1, pattern: "^[a-z ]*$" },
      code: { allOf: [{ $ref: "#/$defs/Trimmed" }], pattern: "^[a-z ]*$" },
      // `properties` beside the reference changes what `additionalProperties` admits.
      owner: { $ref: "#/$defs/Named", properties: { age: { type: "integer" } } },
    },
  };
  const values = [
    { word: "a b", code: "a b", owner: { name: "x" } },
    { word: " ab", code: "ab" },
    { word: "ab", code: "ab " },
    { word: "AB", code: "ab" },
    { owner: { age: 3 } },
    { owner: { name: 3 } },
  ];
  agrees(published, values);
  const inlined = inlineLocalRefs(published);
  for (const value of values)
    expect(valid(inlined, value), JSON.stringify(value)).toBe(valid(published, value));
});

it("keeps both of two refinements on one keyword of a named schema", () => {
  const Named = Schema.String.pipe(Schema.pattern(/^x/), Schema.annotations({ identifier: "Named" }));
  // Effect writes the earlier refinement's pattern in `allOf` beside the later one's.
  const published = { ...JSONSchema.make(Named.pipe(Schema.pattern(/a/), Schema.pattern(/b/))) };
  const values = ["xab", "xa", "xb", "ab", "x"];
  agrees(published, values);
  for (const value of values)
    expect(valid(inlineLocalRefs(published), value), value).toBe(valid(published, value));
});

it("never merges keywords that depend on each other into a schema that accepts otherwise", () => {
  const published = {
    type: "object",
    $defs: {
      Closed: { type: "object", additionalProperties: false },
      Named: { type: "object", properties: { name: { type: "string" } } },
      Pair: { type: "array", prefixItems: [{ type: "string" }], items: false },
      Listed: { type: "array", items: { type: "string" } },
      Tagged: { type: "array", contains: { const: "a" } },
      Coded: { if: { type: "string" }, then: { minLength: 2 } },
    },
    properties: {
      // The reference closes the object; the keyword beside it names a property.
      closed: { $ref: "#/$defs/Closed", properties: { name: { type: "string" } } },
      // The reverse: the reference names a property, the keyword beside it closes the object.
      named: { $ref: "#/$defs/Named", additionalProperties: false },
      pair: { $ref: "#/$defs/Pair", prefixItems: [{ type: "string" }, { type: "string" }] },
      listed: { $ref: "#/$defs/Listed", prefixItems: [{ type: "number" }] },
      // Alone, without `contains` or `if` beside them, these keywords assert nothing.
      tagged: { $ref: "#/$defs/Tagged", maxContains: 1 },
      coded: { $ref: "#/$defs/Coded", else: { minimum: 2 } },
    },
  };
  const values = [
    {},
    { closed: {} },
    { closed: { name: "x" } },
    { named: {} },
    { named: { name: "x" } },
    { named: { age: 1 } },
    { pair: ["a"] },
    { pair: ["a", "b"] },
    { listed: ["a"] },
    { listed: [1] },
    { tagged: ["a"] },
    { tagged: ["a", "a"] },
    { coded: "x" },
    { coded: "xy" },
    { coded: 1 },
  ];
  agrees(published, values);
  for (const value of values)
    expect(valid(inlineLocalRefs(published), value), JSON.stringify(value)).toBe(
      valid(published, value),
    );
});

it("never merges a Draft-07 tuple with items beside it into a schema that accepts more", () => {
  const draft7 = (schema: unknown, value: unknown) =>
    new Ajv({ strict: false, validateSchema: false, logger: false }).compile(
      schema as Record<string, unknown>,
    )(value);
  const published = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    $defs: {
      Pair: { type: "array", items: [{ type: "string" }], additionalItems: false },
      Listed: { type: "array", items: { type: "string" } },
    },
    properties: {
      pair: { $ref: "#/$defs/Pair", items: [{ type: "string" }, { type: "string" }] },
      listed: { $ref: "#/$defs/Listed", items: [{ type: "number" }] },
    },
  };
  const canonical = canonicalSchema(published);
  if (canonical === undefined) throw new Error("expected a canonical schema");
  for (const value of [
    { pair: ["a"] },
    { pair: ["a", "b"] },
    { listed: ["a"] },
    { listed: [1] },
  ]) {
    expect(draft7(standalone(canonical), value), JSON.stringify(value)).toBe(
      draft7(published, value),
    );
    expect(draft7(inlineLocalRefs(published), value), JSON.stringify(value)).toBe(
      draft7(published, value),
    );
  }
});
