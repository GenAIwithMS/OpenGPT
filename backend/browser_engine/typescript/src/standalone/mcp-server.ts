import {
  McpServer,
  type CallToolResult,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { join } from "node:path";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { Effect, Schema, type Scope } from "effect";
import {
  localRequestFingerprint,
  localRetryKey,
  makeFileJobStore,
  type LocalJobStore,
} from "../runtime/local-job-store.js";
import { nestedInput, readHints, standard, writeHints } from "../mcp/schema.js";
import { canonicalSchema } from "../registry/schema-references.js";
import { InputAnswers } from "../runtime/input-request.js";
import { fileFormat } from "../runtime/files.js";
import { createBrowserEngine } from "./engine.js";
import { type MintArtifact, type BrowserEngineOptions, type BrowserEngineRequest } from "./contracts.js";
import { Deployment, validateArtifact } from "./artifact-files.js";
import {
  makeMcpJobs,
  mcpFailureMessage,
  type McpJobKind,
  type McpJobs,
  type McpJobView,
} from "./mcp-jobs.js";

interface ServerOptions {
  readonly engine?: Omit<BrowserEngineOptions, "ask">;
  readonly maxJobs?: number;
  readonly waitMs?: number;
}
export interface BrowserEngineMcpOptions extends ServerOptions {
  readonly prepare: (
    request: BrowserEngineRequest,
    name: string,
  ) => Effect.Effect<
    (artifact: MintArtifact) => Effect.Effect<unknown, Error, Scope.Scope>,
    Error,
    Scope.Scope
  >;
}
export interface IntegrationMcpOptions extends ServerOptions {
  readonly artifact: MintArtifact;
  readonly deployment: Deployment;
  /**
   * The integration's folder. A job started with an idempotency_key keeps its record in `.jobs`
   * there, so a restarted server still finds it. Without a folder, such records live in memory.
   */
  readonly directory?: string;
}
const JobId = Schema.Struct({ job_id: Schema.UUID });
const GetJob = Schema.Struct({
  job_id: Schema.UUID,
  wait_seconds: Schema.optional(Schema.Number.pipe(Schema.between(0, 30))),
});
const ProvideInput = Schema.Struct({
  job_id: Schema.UUID,
  request_id: Schema.UUID,
  answers: InputAnswers,
});
const helperNames = ["mint", "get_job", "provide_input", "cancel_job"];
const MintRequest = Schema.Struct({
  name: Deployment.fields.name.pipe(Schema.filter((name) => !helperNames.includes(name))),
  ...Deployment.fields.request.fields,
  input: Schema.optional(Schema.Unknown),
});
const completedResult = (output: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(output) ?? "null" }],
  structuredContent:
    typeof output === "object" && output !== null && !Array.isArray(output)
      ? Object.fromEntries(Object.entries(output))
      : { result: output },
});
const jobResult = (view: McpJobView) => completedResult(view);
const toolResponse = (
  effect: Effect.Effect<CallToolResult, Error>,
  signal: AbortSignal,
  kind: McpJobKind,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.catchAllCause((cause) =>
        Effect.succeed({
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `${mcpFailureMessage(cause, kind)} Check the existing job status; do not repeat a possible website write.`,
            },
          ],
        }),
      ),
    ),
    { signal },
  );
const helperTools = (
  server: McpServer,
  jobs: McpJobs,
  waitMs: number,
  kind: McpJobKind,
  kept: boolean,
) => {
  server.registerTool(
    "get_job",
    {
      description: `Observe an existing job without starting or replaying work. Returns promptly when input is needed or the job finishes. ${
        kept
          ? "A job started with an idempotency_key is kept in the tool's folder for a day, so it is found after a restart, with its status but not its output. Other jobs are local and disappear when this MCP process stops."
          : "Jobs are local and disappear when this MCP process stops."
      }`,
      inputSchema: standard(GetJob),
      annotations: { readOnlyHint: true },
    },
    (input, context) =>
      toolResponse(
        jobs
          .get(input.job_id, input.wait_seconds === undefined ? waitMs : input.wait_seconds * 1000)
          .pipe(Effect.map(jobResult)),
        context.mcpReq.signal,
        kind,
      ),
  );
  server.registerTool(
    "provide_input",
    {
      description:
        'Answer the current job questions using its request_id and answers keyed by question ID. A choice is an option id; with allowOther, {"other": text} instead; with allowNote, {"option": id, "note": text}. A multi_choice is an array of option ids, or {"options": [ids]} with "other" (allowOther) or "note" (allowNote). Secret answers sent here are visible to your MCP client and model; ask the user before sending them. No login or secret is saved.',
      inputSchema: standard(ProvideInput),
      annotations: writeHints,
    },
    (input, context) =>
      toolResponse(
        jobs.provide(input.job_id, input.request_id, input.answers).pipe(Effect.map(jobResult)),
        context.mcpReq.signal,
        kind,
      ),
  );
  server.registerTool(
    "cancel_job",
    {
      description:
        "Cancel a local job and wait for resource cleanup. A website action already dispatched may have taken effect. Cancellation never retries it.",
      inputSchema: standard(JobId),
      annotations: writeHints,
    },
    (input, context) =>
      toolResponse(
        jobs.cancel(input.job_id).pipe(Effect.map(jobResult)),
        context.mcpReq.signal,
        kind,
      ),
  );
};
const makeServer = (
  name: string,
  options: ServerOptions,
  kind: McpJobKind,
  store?: LocalJobStore,
) =>
  Effect.gen(function* () {
    const maxJobs = options.maxJobs ?? 1;
    const waitMs = options.waitMs ?? 20_000;
    if (
      !Number.isInteger(maxJobs) ||
      maxJobs < 1 ||
      maxJobs > 16 ||
      !Number.isFinite(waitMs) ||
      waitMs < 0 ||
      waitMs > 30_000
    )
      return yield* Effect.fail(new Error("Invalid MCP job limits."));
    const jobs = yield* makeMcpJobs(maxJobs, kind, store);
    const server = new McpServer({ name, version: "1.0.0" }, { capabilities: { tools: {} } });
    yield* Effect.addFinalizer(() => Effect.promise(() => server.close()));
    helperTools(server, jobs, waitMs, kind, store?.persistent === true);
    return { server, jobs, waitMs };
  });
/** Discovery registers tools without creating Chromium or invoking a model. */
export const makeBrowserEngineMcp = (options: BrowserEngineMcpOptions) =>
  Effect.gen(function* () {
    const { server, jobs } = yield* makeServer("opengpt-browser-engine", options, "mint");
    server.registerTool(
      "mint",
      {
        description:
          "Mint a local, directly hostable MCP integration from a website and task. Choose read or write explicitly; ask the user before choosing write. name is a lowercase directory name using underscores within the configured output root. Starts once and returns a job ID; use get_job and provide_input to continue it.",
        inputSchema: standard(MintRequest),
        annotations: writeHints,
      },
      (input, context) =>
        toolResponse(
          jobs
            .start((ask) =>
              Effect.gen(function* () {
                const { name, ...request } = input;
                const publish = yield* options.prepare(request, name);
                const engine = yield* createBrowserEngine({ ...options.engine, ask });
                const result = yield* engine.mint(request);
                if (result.artifact === undefined)
                  return {
                    build: result.build,
                    summary: result.summary,
                    ...(result.untrustedSignInOrigins === undefined
                      ? {}
                      : { untrustedSignInOrigins: result.untrustedSignInOrigins }),
                  };
                const integration = yield* publish(result.artifact);
                return { build: result.build, integration };
              }),
            )
            .pipe(Effect.map(jobResult)),
          context.mcpReq.signal,
          "mint",
        ),
    );
    return server;
  });
const SchemaObject = Schema.Record({ key: Schema.String, value: Schema.Unknown });
/** A write's optional retry key, in the format and words other hosts give it. */
const idempotencyKey = {
  type: "string",
  pattern: "^[A-Za-z0-9_-]{1,200}$",
  description:
    "Optional. Your key for this call; reuse it only to retry the same call, which then answers the same job instead of acting on the website again.",
};
const writeRetry =
  "Send an idempotency_key with every write and reuse it only to retry that same call. A call without one is a new website action.";
/**
 * A schema for the validator: the file marker, `format: "file"`, is for hosts to read and checks
 * nothing, so it is left out rather than reported as a format the validator does not know.
 */
const withoutFileFormat = <Schema>(schema: Schema): Schema => {
  const strip = (node: unknown): unknown =>
    Array.isArray(node)
      ? node.map(strip)
      : typeof node === "object" && node !== null
        ? Object.fromEntries(
            Object.entries(node)
              .filter(([key, value]) => !(key === "format" && value === fileFormat))
              .map(([key, value]) => [key, strip(value)]),
          )
        : node;
  return strip(schema) as Schema;
};
interface BusinessCall {
  readonly input: unknown;
  readonly idempotency_key?: string;
}
/**
 * The integration tool's call schema: the operation's input nested under `input`, titled and
 * summarised, and validated as published, with a write's retry key beside it. A recursive input
 * keeps its references, with its definitions at the call schema's root, where they resolve.
 */
const businessInput = (
  name: string,
  inputSchema: unknown,
  outputSchema: unknown,
  write: boolean,
) =>
  Effect.gen(function* () {
    const input = yield* Schema.decodeUnknown(SchemaObject)(inputSchema).pipe(
      Effect.mapError((cause) => new Error("Invalid operation input schema.", { cause })),
    );
    const output = yield* Schema.decodeUnknown(SchemaObject)(outputSchema).pipe(
      Effect.mapError((cause) => new Error("Invalid operation output schema.", { cause })),
    );
    return yield* Effect.try({
      try: (): StandardSchemaWithJSON<BusinessCall, BusinessCall> => {
        const validator = new AjvJsonSchemaValidator();
        validator.getValidator(withoutFileFormat(output));
        const canonical = canonicalSchema(input);
        if (canonical === undefined) throw new Error("The input schema names a missing reference.");
        const json = {
          type: "object",
          ...(Object.keys(canonical.definitions).length > 0
            ? { $defs: canonical.definitions }
            : {}),
          properties: {
            input: nestedInput(name, canonical),
            ...(write ? { idempotency_key: idempotencyKey } : {}),
          },
          required: ["input"],
          additionalProperties: false,
        };
        const validate = validator.getValidator<BusinessCall>(withoutFileFormat(json));
        return {
          "~standard": {
            version: 1,
            vendor: "opengpt-browser-engine",
            jsonSchema: { input: () => json, output: () => json },
            validate: (value) => {
              const result = validate(value);
              // Ajv names each failing path and the schema rule it breaks, never the value.
              return result.valid
                ? { value: result.data }
                : {
                    issues: [
                      {
                        message: `Input does not match the operation schema: ${
                          result.errorMessage ?? "unknown error"
                        }.`,
                      },
                    ],
                  };
            },
          },
        };
      },
      catch: (cause) => new Error("Invalid operation schema.", { cause }),
    });
  });
export const makeIntegrationMcp = (options: IntegrationMcpOptions) =>
  Effect.gen(function* () {
    const artifact = yield* validateArtifact(options.artifact);
    const deployment = yield* Schema.decodeUnknown(Deployment)(options.deployment).pipe(
      Effect.mapError((cause) => new Error("Invalid integration deployment.", { cause })),
    );
    const write = deployment.request.effect === "write";
    const inputSchema = yield* businessInput(
      deployment.name,
      artifact.inputSchema,
      artifact.outputSchema,
      write,
    );
    // Only a write takes an idempotency_key, so only a write keeps its jobs in the folder.
    const store =
      options.directory === undefined || !write
        ? undefined
        : yield* makeFileJobStore(join(options.directory, ".jobs"));
    const { server, jobs, waitMs } = yield* makeServer(deployment.name, options, "run", store);
    if (helperNames.includes(deployment.name))
      return yield* Effect.fail(
        new Error("The integration tool name conflicts with a job helper."),
      );
    server.registerTool(
      deployment.name,
      {
        description: `${deployment.description}\nReturns the operation result, or a job ID when input or more time is needed. Continue that job with get_job/provide_input; never repeat a possible write to poll it.${write ? `\n${writeRetry}` : ""}`,
        inputSchema,
        annotations: write ? writeHints : readHints,
      },
      (input, context) =>
        toolResponse(
          Effect.gen(function* () {
            const key = input.idempotency_key;
            const started = yield* jobs.start(
              (ask) =>
                Effect.gen(function* () {
                  const engine = yield* createBrowserEngine({ ...options.engine, ask });
                  return yield* engine.run(artifact, {
                    ...deployment.request,
                    input: input.input,
                  });
                }),
              key === undefined
                ? undefined
                : {
                    retryKey: localRetryKey(deployment.name, key),
                    requestFingerprint: localRequestFingerprint(deployment.name, input.input),
                  },
            );
            const view = yield* jobs.get(started.job_id, waitMs);
            // A rejoined job that finished before a restart has no output to answer with.
            const result =
              view.status === "completed" && "output" in view
                ? completedResult(view.output)
                : jobResult(started.rejoined === true ? { ...view, rejoined: true } : view);
            // A run that failed, a write that may have applied included, is never a success, so
            // it is an error result whose job tells the client whether to resubmit.
            return view.status === "failed" ? { ...result, isError: true } : result;
          }),
          context.mcpReq.signal,
          "run",
        ),
    );
    return server;
  });
