/**
 * A tool's JSON Schema in the form the Responses API's strict mode takes, and the inverse for
 * the arguments the model sends. Strict mode requires every property of every object, so an
 * optional property becomes required and nullable, and the model sends null for it. The SDK's
 * own conversion refuses a union whose branches have optional properties, since it cannot tell
 * which branch a value took; here the branch is the one whose property names match the value's,
 * which strict mode makes exact: an object always carries every property of its branch.
 */

type Json = Readonly<Record<string, unknown>>;

/** How to undo the conversion on one value: which properties null stands in for an absence. */
type Shape =
  | {
      readonly kind: "object";
      readonly properties: ReadonlyMap<
        string,
        { readonly optional: boolean; readonly shape: Shape }
      >;
    }
  | { readonly kind: "array"; readonly items: Shape }
  | { readonly kind: "union"; readonly branches: readonly Shape[] }
  | { readonly kind: "leaf" };

const leaf: Shape = { kind: "leaf" };

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a schema already lets null through, which would make a null ambiguous. */
const acceptsNull = (schema: Json): boolean =>
  schema["type"] === "null" ||
  (Array.isArray(schema["type"]) && schema["type"].includes("null")) ||
  (Array.isArray(schema["anyOf"]) &&
    schema["anyOf"].some((branch) => isRecord(branch) && acceptsNull(branch)));

const convert = (schema: Json, path: string): { schema: Json; shape: Shape } => {
  const { $schema: _dialect, ...rest } = schema;
  if (Array.isArray(rest["oneOf"]))
    throw new Error(`Strict tool schema: oneOf at ${path} is not supported; use anyOf`);
  if (Array.isArray(rest["anyOf"])) {
    const branches = rest["anyOf"].map((branch, index) => {
      if (!isRecord(branch)) throw new Error(`Strict tool schema: bad anyOf at ${path}`);
      return convert(branch, `${path}.anyOf[${index}]`);
    });
    return {
      schema: { ...rest, anyOf: branches.map((branch) => branch.schema) },
      shape: { kind: "union", branches: branches.map((branch) => branch.shape) },
    };
  }
  if (isRecord(rest["properties"])) {
    if (isRecord(rest["additionalProperties"]))
      throw new Error(`Strict tool schema: open record at ${path} cannot be strict`);
    const required = new Set(
      Array.isArray(rest["required"])
        ? rest["required"].filter((key): key is string => typeof key === "string")
        : [],
    );
    const properties = new Map<string, { optional: boolean; shape: Shape }>();
    const converted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest["properties"])) {
      if (!isRecord(value)) throw new Error(`Strict tool schema: bad property ${path}.${key}`);
      const inner = convert(value, `${path}.${key}`);
      const optional = !required.has(key);
      if (optional && acceptsNull(inner.schema))
        throw new Error(
          `Strict tool schema: ${path}.${key} is optional and nullable, so null would be ambiguous`,
        );
      converted[key] = optional ? { anyOf: [inner.schema, { type: "null" }] } : inner.schema;
      properties.set(key, { optional, shape: inner.shape });
    }
    return {
      schema: {
        ...rest,
        properties: converted,
        required: Object.keys(converted),
        additionalProperties: false,
      },
      shape: { kind: "object", properties },
    };
  }
  if (isRecord(rest["items"])) {
    const items = convert(rest["items"], `${path}[]`);
    return { schema: { ...rest, items: items.schema }, shape: { kind: "array", items: items.shape } };
  }
  return { schema: rest, shape: leaf };
};

const sameNames = (shape: Shape, value: Json) => {
  if (shape.kind !== "object") return false;
  const names = Object.keys(value);
  return names.length === shape.properties.size && names.every((name) => shape.properties.has(name));
};

const restore = (value: unknown, shape: Shape): unknown => {
  if (shape.kind === "array")
    return Array.isArray(value) ? value.map((item) => restore(item, shape.items)) : value;
  if (shape.kind === "union") {
    if (!isRecord(value)) return value;
    const branch = shape.branches.find((candidate) => sameNames(candidate, value));
    return branch === undefined ? value : restore(value, branch);
  }
  if (shape.kind !== "object" || !isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]): (readonly [string, unknown])[] => {
      const property = shape.properties.get(key);
      if (property === undefined) return [[key, item]];
      if (item === null && property.optional) return [];
      return [[key, restore(item, property.shape)]];
    }),
  );
};

/**
 * `jsonSchema`, an object schema with every `$ref` already inlined, in strict form, with
 * `restore`, which turns arguments sent against it back into a value of the original schema:
 * each null that stands for an absent optional property is dropped. A value that matches no
 * branch of a union comes back unchanged, for the caller's own decode to refuse.
 */
export const strictToolSchema = (jsonSchema: object) => {
  if (!isRecord(jsonSchema) || !isRecord(jsonSchema["properties"]))
    throw new Error("Strict tool schema: the root must be an object schema");
  const { schema, shape } = convert(jsonSchema, "$");
  return { parameters: schema, restore: (value: unknown) => restore(value, shape) };
};
