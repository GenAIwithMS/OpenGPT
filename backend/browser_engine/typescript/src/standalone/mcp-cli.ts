#!/usr/bin/env node
import { modelOptions, readModelConfig } from "../models/provider-config.js";
import { realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Effect, Exit, Scope } from "effect";
import { localError, localPromise } from "../execution/local-path.js";
import { readIntegration } from "./artifact-files.js";
import { prepareIntegration } from "./mcp-package.js";
import { makeIntegrationMcp, makeBrowserEngineMcp } from "./mcp-server.js";
import type { BrowserEngineOptions } from "./contracts.js";

const usage = `OpenGPT MCP

  opengpt-browser-mcp mint [--root DIRECTORY]
  opengpt-browser-mcp serve --artifact DIRECTORY

Options
  --endpoint URL     Attach to native Playwright
  --headed           Show local Chromium

The mint root defaults to ./integrations. Supply model credentials in the environment to
mint. Serving makes no model request and needs no model credentials.
Stdout is reserved for MCP. Human questions use provide_input through your MCP client.
`;

const waitForDisconnect = Effect.async<void>((resume) => {
  const done = () => resume(Effect.void);
  process.stdin.once("end", done);
  process.stdin.once("close", done);
  process.stdin.once("error", done);
  process.once("SIGINT", done);
  process.once("SIGTERM", done);
  if (process.stdin.readableEnded || process.stdin.destroyed) done();
  return Effect.sync(() => {
    process.stdin.off("end", done);
    process.stdin.off("close", done);
    process.stdin.off("error", done);
    process.off("SIGINT", done);
    process.off("SIGTERM", done);
  });
});

export const runMcpCli = (
  args: readonly string[] = process.argv.slice(2),
  options: Omit<BrowserEngineOptions, "ask"> = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { values, positionals } = yield* Effect.try({
        try: () =>
          parseArgs({
            args: [...args],
            allowPositionals: true,
            options: {
              help: { type: "boolean", short: "h" },
              root: { type: "string" },
              artifact: { type: "string" },
              endpoint: { type: "string" },
              headed: { type: "boolean" },
            },
          }),
        catch: localError,
      });
      if (values.help) {
        process.stderr.write(usage);
        return;
      }
      const mode = positionals[0];
      if (positionals.length !== 1 || (mode !== "mint" && mode !== "serve"))
        return yield* Effect.fail(new Error("Choose mint or serve. See --help."));
      const engine = {
        ...options,
        browser: {
          ...options.browser,
          ...(values.headed === undefined ? {} : { headless: !values.headed }),
          ...(values.endpoint === undefined ? {} : { endpoint: values.endpoint }),
        },
      };
      const directory = values.artifact === undefined ? undefined : resolve(values.artifact);
      const integration =
        mode === "serve"
          ? yield* directory === undefined
              ? Effect.fail(new Error("--artifact is required."))
              : readIntegration(directory)
          : undefined;
      const scope = yield* Effect.scope;
      const create = () =>
        integration === undefined
          ? makeBrowserEngineMcp({
              engine,
              prepare: (request, name) =>
                prepareIntegration({
                  root: resolve(values.root ?? "integrations"),
                  name,
                  request,
                }),
            })
          : makeIntegrationMcp({
              ...integration,
              ...(directory === undefined ? {} : { directory }),
              engine,
            });
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          serveStdio(() => Effect.runPromise(Effect.provideService(create(), Scope.Scope, scope)), {
            onerror: () => process.stderr.write("OpenGPT MCP transport failed.\n"),
          }),
        ),
        (server) => localPromise(() => server.close()).pipe(Effect.orDie),
      );
      yield* waitForDisconnect;
    }),
  );

export const startMcpCli = (
  args: readonly string[] = process.argv.slice(2),
  options: Omit<BrowserEngineOptions, "ask"> = {},
): void => {
  Effect.runCallback(runMcpCli(args, options), {
    onExit: (result) => {
      if (Exit.isFailure(result)) {
        process.stderr.write("OpenGPT MCP failed. Check its local configuration.\n");
        process.exitCode = 1;
      }
    },
  });
};

/** npm links a bin to this file, so the entry path counts once its links are resolved. */
const isEntrypoint = (path: string | undefined) => {
  if (path === undefined) return false;
  try {
    return pathToFileURL(realpathSync(path)).href === import.meta.url;
  } catch {
    return false;
  }
};

// The backend passes its model provider on a pipe (see models/provider-config.ts).
if (isEntrypoint(process.argv[1])) startMcpCli(process.argv.slice(2), modelOptions(readModelConfig()));
