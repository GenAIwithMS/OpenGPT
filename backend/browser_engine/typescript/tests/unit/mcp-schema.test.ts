import { describe, expect, it } from "vitest";
import { nestedInput, readHints, siteInput, writeHints } from "../../src/mcp/schema.js";

describe("MCP tool hints", () => {
  it("lets clients run a read tool without asking, and several at once", () => {
    expect(readHints).toEqual({
      readOnlyHint: true,
      openWorldHint: true,
      idempotentHint: true,
      destructiveHint: false,
    });
  });

  it("marks a tool that may change a website as neither read-only nor idempotent", () => {
    expect(writeHints).toEqual({
      readOnlyHint: false,
      openWorldHint: true,
      idempotentHint: false,
      destructiveHint: true,
    });
  });
});

describe("a tool's input as its call nests it", () => {
  const fields = {
    type: "object",
    properties: { note: { type: "string", description: "The note to save" } },
    required: ["note"],
    additionalProperties: false,
  };

  it("leaves out the field summary when the fields are listed beside it", () => {
    const nested = nestedInput("save_note", { schema: fields, definitions: {} });
    expect(nested).toEqual({ title: "save_note input", ...fields });
    expect(nested).not.toHaveProperty("description");
  });

  it("keeps the input's own description", () => {
    const schema = { ...fields, description: "What to save" };
    expect(nestedInput("save_note", { schema, definitions: {} })).toEqual({
      title: "save_note input",
      ...schema,
    });
  });

  it.each([
    {
      case: "takes no fields",
      input: {
        schema: { type: "object", properties: {}, additionalProperties: false },
        definitions: {},
      },
    },
    {
      case: "is a reference",
      input: { schema: { $ref: "#/$defs/Note" }, definitions: { Note: fields } },
    },
  ])("keeps the summary of an input that $case", ({ input }) => {
    const nested = nestedInput("save_note", input);
    expect(nested).toEqual(siteInput("save_note", input));
    expect(nested["description"]).toMatch(/^The operation's input|^This operation takes no input/u);
  });
});
