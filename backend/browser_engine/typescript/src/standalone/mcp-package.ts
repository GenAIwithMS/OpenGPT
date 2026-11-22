import { mkdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { createLocalWorkspace } from "../execution/local-workspace.js";
import {
  localFilePath,
  localPromise,
  localError,
  localRelativePath,
} from "../execution/local-path.js";
import type { MintArtifact, BrowserEngineRequest } from "./contracts.js";
import { Deployment, writeArtifact } from "./artifact-files.js";

const launcher = `import { fileURLToPath } from 'node:url';
const runtime = process.argv[2];
if (!runtime) throw new Error('Start this integration with the command and arguments in its mcp.json.');
const { startMcpCli } = await import(runtime);
startMcpCli(['serve', '--artifact', fileURLToPath(new URL('.', import.meta.url))]);
`;
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/**
 * Top-level names authored source may not use, compared in lower case. They cover the packaging
 * files, the sign-in recipe, the TOML that 0.1.2 wrote and its docs told users to copy into Codex,
 * the folder that keeps keyed job records, and the project config an MCP client might load from
 * this folder.
 */
const reserved = new Set([
  "deployment.json",
  "auth-fill.json",
  "mcp.mjs",
  "mcp.json",
  "readme.md",
  "codex-mcp.toml",
  ".jobs",
  ".mcp.json",
  ".vscode",
  ".cursor",
  ".codex",
  ".gemini",
  ".claude",
]);

/** Only the local operator's configuration chooses the root; tool arguments choose one slug. */
export const prepareIntegration = (options: {
  readonly root: string;
  readonly name: string;
  readonly request: BrowserEngineRequest;
  readonly description?: string;
}) =>
  Effect.gen(function* () {
    const deployment = yield* Schema.decodeUnknown(Deployment)({
      name: options.name,
      description: options.description ?? options.request.intent,
      request: {
        url: options.request.url,
        intent: options.request.intent,
        effect: options.request.effect,
        ...(options.request.authenticationOrigins === undefined
          ? {}
          : {
              authenticationOrigins: options.request.authenticationOrigins,
            }),
      },
    }).pipe(Effect.mapError(localError));
    yield* localPromise(() => mkdir(resolve(options.root), { recursive: true }));
    const root = yield* localPromise(() => realpath(resolve(options.root)));
    const directory = yield* localFilePath(root, deployment.name);
    let completed = false;
    yield* Effect.acquireRelease(
      localPromise(() => mkdir(directory)),
      () =>
        completed
          ? Effect.void
          : localPromise(() => rm(directory, { recursive: true, force: true })).pipe(Effect.orDie),
    );
    return (artifact: MintArtifact) =>
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => {
            if (
              artifact.files.some((file) =>
                reserved.has((localRelativePath(file.path).split("/")[0] ?? "").toLowerCase()),
              )
            )
              throw new Error("Artifact source collides with an integration packaging file");
          },
          catch: localError,
        });
        yield* writeArtifact(directory, artifact);
        // A sign-in's origins join the request's, after them, so every call signs in the same way.
        const origins = [
          ...new Set([
            ...(deployment.request.authenticationOrigins ?? []),
            ...(artifact.signIn?.authenticationOrigins ?? []),
          ]),
        ];
        const deployed =
          origins.length === 0
            ? deployment
            : { ...deployment, request: { ...deployment.request, authenticationOrigins: origins } };
        const workspace = yield* createLocalWorkspace({ root: directory });
        const launcherPath = join(directory, "mcp.mjs");
        const configPath = join(directory, "mcp.json");
        const runtime = new URL("./mcp-cli.js", import.meta.url).href;
        const args = [launcherPath, runtime];
        const configuration = {
          mcpServers: { [deployment.name]: { command: process.execPath, args } },
        };
        const command = [process.execPath, ...args].map(shellQuote).join(" ");
        yield* workspace.write("deployment.json", `${JSON.stringify(deployed, null, 2)}\n`);
        yield* workspace.write("mcp.mjs", launcher);
        yield* workspace.write("mcp.json", `${JSON.stringify(configuration, null, 2)}\n`);
        yield* workspace.write(
          "README.md",
          `# ${deployment.name}

This integration runs on your computer as a local MCP stdio server. mcp.json holds its server
entry in the standard mcpServers format. The entry starts your Node with this directory's
launcher and your installed OpenGPT runtime.

## Add it to your MCP client

- Claude Code

  \`\`\`sh
  claude mcp add ${deployment.name} -- ${command}
  \`\`\`

- Codex

  \`\`\`sh
  codex mcp add ${deployment.name} -- ${command}
  \`\`\`

- Gemini CLI

  \`\`\`sh
  gemini mcp add ${deployment.name} ${command}
  \`\`\`

- Cursor, VS Code, Claude Desktop and other clients that read an mcpServers JSON file take the
  entry from mcp.json.

## Model key

The server needs no model key. Guardian reviewed this integration when it was minted, so a call
runs it without another review and makes no model request. This directory and mcp.json hold no
key.

## Call it

Call ${deployment.name} with its discovered input schema. Each call starts at the site root of
the URL in deployment.json and opens any deeper page itself. The authority there only sets the
tool's read-only and destructive hints. A run doesn't check authority or intent, and edits to
src/ or deployment.json aren't reviewed. A run that signs in replays its sign-in only on the site
and the sign-in origins in deployment.json.

A call that needs an answer or more time returns a job ID. Continue that job with get_job,
provide_input and cancel_job. Polling never resubmits an operation.

Answers sent through provide_input are visible to your MCP client and its model provider.
Restarting the server stops live jobs.

Send an idempotency_key with each write. A call that repeats the key and input answers the
first job and writes nothing, even after a restart. The .jobs folder keeps each keyed job's
status for a day, with no input or output.

## Paths

The launcher uses your installed OpenGPT runtime and local Chromium. The launcher source is
portable. mcp.json names your current Node and OpenGPT installation. Update those paths if you
move either installation or this directory.
`,
        );
        completed = true;
        return { directory, configPath, launcherPath };
      });
  });
