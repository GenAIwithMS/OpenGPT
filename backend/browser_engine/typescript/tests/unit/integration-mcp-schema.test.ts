import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Effect, Either } from "effect";
import { expect, it } from "vitest";
import { makeIntegrationMcp } from "../../src/standalone/mcp-server.js";

const deployment = {
  name: "tree_tool",
  description: "Reads a tree of categories.",
  request: { url: "https://example.test/", intent: "Read the category tree", effect: "read" },
} as const;
const artifactWith = (inputSchema: Record<string, unknown>) => ({
  entrypoint: "src/main.mjs",
  files: [{ path: "src/main.mjs", content: "export default {};" }],
  inputSchema,
  outputSchema: { type: "object" },
});

/** The integration's tool as an MCP client lists it, and a call's answer to `input`. */
const served = (inputSchema: Record<string, unknown>, input?: unknown) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* makeIntegrationMcp({ artifact: artifactWith(inputSchema), deployment });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "test", version: "1.0.0" });
        yield* Effect.promise(() => server.connect(serverTransport));
        yield* Effect.promise(() => client.connect(clientTransport));
        yield* Effect.addFinalizer(() => Effect.promise(() => client.close()));
        const listed = yield* Effect.promise(() => client.listTools());
        const called =
          input === undefined
            ? undefined
            : yield* Effect.promise(() =>
                client
                  .callTool({ name: deployment.name, arguments: { input } })
                  .then((result): unknown => result, (error: unknown) => ({ refused: String(error) })),
              );
        return { tool: listed.tools.find((tool) => tool.name === deployment.name), called };
      }),
    ),
  );

const tree = {
  type: "object",
  description: "The branch to read.",
  required: ["label"],
  properties: {
    label: { type: "string", description: "The category's own name, as the site shows it." },
    children: { type: "array", items: { $ref: "#" } },
  },
  additionalProperties: false,
};

// An input whose fields are listed beside it keeps only its own description: a summary of the same
// fields would repeat them.
it("serves a recursive input with its definitions at the call schema's root, titled and described", async () => {
  const { tool, called } = await served(tree, { label: 7 });
  expect(tool?.inputSchema).toEqual({
    type: "object",
    $defs: {
      Root: {
        ...tree,
        properties: { ...tree.properties, children: { type: "array", items: { $ref: "#/$defs/Root" } } },
      },
    },
    properties: {
      input: {
        title: "tree_tool input",
        ...tree,
        properties: { ...tree.properties, children: { type: "array", items: { $ref: "#/$defs/Root" } } },
        description: "The branch to read.",
      },
    },
    required: ["input"],
    additionalProperties: false,
  });
  // The definitions resolve where the call schema puts them, so a bad value is still refused.
  expect(JSON.stringify(called)).toContain("Input does not match the operation schema");
});

it("inlines an input whose references all expand, and describes one with no fields", async () => {
  const listed = await served({
    type: "object",
    $defs: { Code: { type: "string", minLength: 3 } },
    required: ["code"],
    properties: { code: { $ref: "#/$defs/Code" } },
  });
  expect(listed.tool?.inputSchema).toEqual({
    type: "object",
    properties: {
      input: {
        title: "tree_tool input",
        type: "object",
        required: ["code"],
        properties: { code: { type: "string", minLength: 3 } },
      },
    },
    required: ["input"],
    additionalProperties: false,
  });
  const empty = await served({ type: "object", properties: {}, additionalProperties: false });
  expect(empty.tool?.inputSchema).toMatchObject({
    properties: { input: { description: "This operation takes no input fields. Send {}." } },
  });
});

it("refuses to serve an input whose reference names nothing in the schema", async () => {
  const refused = await Effect.runPromise(
    Effect.either(
      Effect.scoped(
        makeIntegrationMcp({
          artifact: artifactWith({
            type: "object",
            properties: { item: { $ref: "#/$defs/Missing" } },
          }),
          deployment,
        }),
      ),
    ),
  );
  if (Either.isRight(refused)) throw new Error("A dangling reference was served");
  expect(refused.left.message).toBe("Invalid operation schema.");
});
