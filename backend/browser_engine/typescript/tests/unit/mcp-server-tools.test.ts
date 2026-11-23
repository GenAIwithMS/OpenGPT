import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { Effect, type Scope } from "effect";
import { expect, it } from "vitest";
import { makeIntegrationMcp, makeBrowserEngineMcp } from "../../src/standalone/mcp-server.js";

const artifact = {
  entrypoint: "src/tool.mjs",
  files: [{ path: "src/tool.mjs", content: "export default {};" }],
  inputSchema: {
    type: "object",
    properties: { note: { type: "string" } },
    required: ["note"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { saved: { type: "boolean" } },
    required: ["saved"],
    additionalProperties: false,
  },
};
const deployment = (effect: "read" | "write") => ({
  name: `${effect}_fixture`,
  description: "Operate a local fixture",
  request: { url: "http://127.0.0.1:9/", intent: "Operate a local fixture", effect },
});

/** Connects an MCP client to a served integration, without starting a browser or a run. */
const connected = (effect: "read" | "write", directory?: string) =>
  Effect.gen(function* () {
    const server = yield* makeIntegrationMcp({
      artifact,
      deployment: deployment(effect),
      ...(directory === undefined ? {} : { directory }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    yield* Effect.promise(() => server.connect(serverTransport));
    const client = new Client({ name: "opengpt-unit", version: "1.0.0" });
    yield* Effect.acquireRelease(
      Effect.promise(() => client.connect(clientTransport)),
      () => Effect.promise(() => client.close()),
    );
    return client;
  });

/** Lists a served integration's tools over MCP without starting a browser or a run. */
const listed = (effect: "read" | "write") =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* makeIntegrationMcp({ artifact, deployment: deployment(effect) });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        yield* Effect.promise(() => server.connect(serverTransport));
        const client = new Client({ name: "opengpt-unit", version: "1.0.0" });
        yield* Effect.acquireRelease(
          Effect.promise(() => client.connect(clientTransport)),
          () => Effect.promise(() => client.close()),
        );
        const { tools } = yield* Effect.promise(() => client.listTools());
        const tool = tools.find((candidate) => candidate.name === `${effect}_fixture`);
        if (tool === undefined) throw new Error("The integration tool is not listed");
        return tool;
      }),
    ),
  );

it("marks a write tool as neither idempotent nor read-only", async () => {
  const tool = await listed("write");
  expect(tool.annotations).toEqual({
    readOnlyHint: false,
    openWorldHint: true,
    idempotentHint: false,
    destructiveHint: true,
  });
});

it("marks a read tool as read-only and idempotent, so clients may run several at once", async () => {
  const tool = await listed("read");
  expect(tool.annotations).toEqual({
    readOnlyHint: true,
    openWorldHint: true,
    idempotentHint: true,
    destructiveHint: false,
  });
});

/** Every tool a server lists, over MCP, without starting a browser or a run. */
const listedTools = (server: Effect.Effect<McpServer, Error, Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const served = yield* server;
        yield* Effect.promise(() => served.connect(serverTransport));
        const client = new Client({ name: "opengpt-unit", version: "1.0.0" });
        yield* Effect.acquireRelease(
          Effect.promise(() => client.connect(clientTransport)),
          () => Effect.promise(() => client.close()),
        );
        return (yield* Effect.promise(() => client.listTools())).tools;
      }),
    ),
  );
const writeHints = {
  readOnlyHint: false,
  openWorldHint: true,
  idempotentHint: false,
  destructiveHint: true,
};

it("marks a job's answer and cancel tools as writes, and its read as read-only", async () => {
  const tools = await listedTools(makeIntegrationMcp({ artifact, deployment: deployment("read") }));
  const hints = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
  expect(hints["get_job"]).toEqual({ readOnlyHint: true });
  expect(hints["provide_input"]).toEqual(writeHints);
  expect(hints["cancel_job"]).toEqual(writeHints);
});

it("marks the mint tool as a write", async () => {
  const tools = await listedTools(
    makeBrowserEngineMcp({ prepare: () => Effect.die("A listing prepares nothing") }),
  );
  expect(tools.find((tool) => tool.name === "mint")?.annotations).toEqual(writeHints);
});

it("describes a tool's input by its own description, its fields listed beside it", async () => {
  const tool = await listed("read");
  const input = tool.inputSchema.properties?.["input"];
  expect(input).toMatchObject({
    title: "read_fixture input",
    properties: { note: { type: "string" } },
  });
  expect(input).not.toHaveProperty("description");
});

it("gives a read tool only its input", async () => {
  const tool = await listed("read");
  expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(["input"]);
  expect(tool.description).not.toContain("idempotency_key");
});

it("lets a write tool take an optional idempotency_key and says to send one with every write", async () => {
  const tool = await listed("write");
  expect(tool.inputSchema.required).toEqual(["input"]);
  expect(tool.inputSchema.properties?.["idempotency_key"]).toEqual({
    type: "string",
    pattern: "^[A-Za-z0-9_-]{1,200}$",
    description:
      "Optional. Your key for this call; reuse it only to retry the same call, which then answers the same job instead of acting on the website again.",
  });
  expect(tool.description).toContain(
    "Send an idempotency_key with every write and reuse it only to retry that same call. A call without one is a new website action.",
  );
});

it("refuses a malformed idempotency_key before any job starts", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* connected("write");
        return yield* Effect.promise(() =>
          client.callTool({
            name: "write_fixture",
            arguments: { input: { note: "a" }, idempotency_key: "has spaces" },
          }),
        );
      }),
    ),
  );
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("idempotency_key");
});

it("serves a read tool from a folder without keeping its jobs there or naming an idempotency_key", async () => {
  const folder = await mkdtemp(join(tmpdir(), "opengpt-read-tool-"));
  try {
    const tools = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* connected("read", folder);
          return (yield* Effect.promise(() => client.listTools())).tools;
        }),
      ),
    );
    const getJob = tools.find((tool) => tool.name === "get_job");
    expect(getJob?.description).toContain(
      "Jobs are local and disappear when this MCP process stops.",
    );
    expect(JSON.stringify(tools)).not.toContain("idempotency_key");
    expect(await readdir(folder)).toEqual([]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

it("serves a write tool from a folder it can't write, and refuses a keyed call there before it acts", async () => {
  const folder = await mkdtemp(join(tmpdir(), "opengpt-read-only-tool-"));
  await chmod(folder, 0o500);
  try {
    const { names, result } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* connected("write", folder);
          const { tools } = yield* Effect.promise(() => client.listTools());
          const result = yield* Effect.promise(() =>
            client.callTool({
              name: "write_fixture",
              arguments: { input: { note: "a" }, idempotency_key: "booking-1" },
            }),
          );
          return { names: tools.map((tool) => tool.name), result };
        }),
      ),
    );
    expect(names).toContain("write_fixture");
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("do not repeat a possible website write");
    expect(await readdir(folder)).toEqual([]);
  } finally {
    await chmod(folder, 0o700);
    await rm(folder, { recursive: true, force: true });
  }
});
