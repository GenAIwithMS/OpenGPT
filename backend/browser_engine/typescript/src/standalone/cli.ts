#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Cause, Effect, Exit, Schema } from "effect";
import { readArtifact, writeArtifact } from "./artifact-files.js";
import { createBrowserEngine } from "./engine.js";
import type { BrowserEngineOptions } from "./contracts.js";
import { RunOutcomeFailure } from "./run-report.js";
import { makeTerminalAsker } from "../inputs/terminal.js";

const usage = `OpenGPT

  opengpt-browser-engine mint --url URL --intent TEXT --out DIRECTORY [--input JSON]
  opengpt-browser-engine run --artifact DIRECTORY --url URL [--input JSON]

Options
  --endpoint URL          Attach to a native Playwright websocket endpoint
  --headed                Show locally launched Chromium
  --effect read|write|ask  Mint authority (default ask)
  --timeout-seconds N      Session budget (default 1200)

Set OPENAI_API_KEY before minting. A run makes no model request and needs no key.
A run ignores --intent and --effect. Questions are asked in this terminal.
`;

const selectedEffect = (supplied: string | undefined) =>
  Schema.decodeUnknown(Schema.Literal("read", "write", "ask"))(supplied ?? "ask").pipe(
    Effect.mapError(() => new Error("Choose a supported --effect. See --help.")),
  );
const selectedTimeout = (supplied: string | undefined) =>
  Effect.try(() => {
    const timeoutMs = Number(supplied ?? "1200") * 1000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new Error("--timeout-seconds must be positive.");
    return timeoutMs;
  });

const readOptions = (args: readonly string[]) =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try(() =>
      parseArgs({
        args: [...args],
        allowPositionals: true,
        options: {
          help: { type: "boolean", short: "h" },
          url: { type: "string" },
          intent: { type: "string" },
          out: { type: "string" },
          artifact: { type: "string" },
          input: { type: "string" },
          endpoint: { type: "string" },
          headed: { type: "boolean" },
          effect: { type: "string" },
          "timeout-seconds": { type: "string" },
        },
      }),
    );
    const { values, positionals } = parsed;
    const command = positionals[0];
    if (values.help || command === undefined) {
      return undefined;
    }
    if ((command !== "mint" && command !== "run") || positionals.length !== 1)
      return yield* Effect.fail(new Error("Use mint or run. See --help."));
    if (values.url === undefined) return yield* Effect.fail(new Error("--url is required."));
    if (command === "mint" && values.intent === undefined)
      return yield* Effect.fail(new Error("--intent is required to mint."));
    // Guardian checked the intent and authority when the artifact was minted, so a run ignores both.
    const effect = command === "mint" ? yield* selectedEffect(values.effect) : undefined;
    const timeoutMs = yield* selectedTimeout(values["timeout-seconds"]);
    const input = yield* Effect.try({
      try: () => JSON.parse(values.input ?? "{}") as unknown,
      catch: (cause) => new Error("--input must be valid JSON.", { cause }),
    });
    return {
      values,
      command,
      timeoutMs,
      request: {
        url: values.url,
        intent: values.intent ?? "",
        input,
        ...(effect === undefined ? {} : { effect }),
      },
    };
  });

/**
 * The terminal CLI. `overrides` holds what a caller that starts it sets, such as model providers;
 * the CLI sets the terminal asker, and the browser and session budget from `args`.
 */
const runCli = (
  args: readonly string[],
  overrides: Omit<BrowserEngineOptions, "ask" | "browser" | "timeoutMs">,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const options = yield* readOptions(args);
      if (options === undefined) {
        process.stdout.write(usage);
        return;
      }
      const { values, command, timeoutMs, request } = options;
      const engine = yield* createBrowserEngine({
        ...overrides,
        ask: makeTerminalAsker(),
        timeoutMs,
        browser: {
          headless: !values.headed,
          ...(values.endpoint === undefined ? {} : { endpoint: values.endpoint }),
        },
      });
      if (command === "run") {
        if (values.artifact === undefined)
          return yield* Effect.fail(new Error("--artifact is required."));
        const artifact = yield* readArtifact(resolve(values.artifact));
        const output = yield* engine
          .run(artifact, {
            url: request.url,
            intent: request.intent,
            input: request.input,
          })
          .pipe(
            // A write that may have applied still prints what its script returned; the error
            // that follows says it is unconfirmed.
            Effect.tapError((failure) =>
              Effect.sync(() => {
                if (failure instanceof RunOutcomeFailure && failure.unconfirmed !== undefined)
                  process.stdout.write(
                    `${JSON.stringify(failure.unconfirmed.output, null, 2)}\n`,
                  );
              }),
            ),
          );
        process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
        return;
      }
      if (values.out === undefined) return yield* Effect.fail(new Error("--out is required."));
      const outputDirectory = resolve(values.out);
      // Creating the destination first prevents a long mint from overwriting an existing project.
      yield* Effect.tryPromise(() => mkdir(dirname(outputDirectory), { recursive: true }));
      yield* Effect.tryPromise({
        try: () => mkdir(outputDirectory),
        catch: (cause) => new Error("--out must name a new directory.", { cause }),
      });
      const result = yield* engine.mint(request);
      if (result.artifact === undefined) {
        process.stderr.write(`${result.summary}\n`);
        process.exitCode = 1;
        return;
      }
      const artifact = result.artifact;
      yield* writeArtifact(outputDirectory, artifact);
      process.stdout.write(`Saved ${artifact.entrypoint} and its schemas to ${outputDirectory}\n`);
    }),
  );

/**
 * Runs the terminal CLI on `args` and sets the exit code: 1 when the command fails or a mint
 * saves nothing. `options` lets a caller start it with its own model providers, as
 * `startMcpCli` does for the MCP CLI. The browser tests start the compiled CLI this way with
 * recorded providers, since no test may call a real model.
 */
export const startCli = (
  args: readonly string[] = process.argv.slice(2),
  options: Omit<BrowserEngineOptions, "ask" | "browser" | "timeoutMs"> = {},
): void => {
  const cancel = Effect.runCallback(runCli(args, options), {
    onExit: (result) => {
      if (Exit.isFailure(result)) {
        const failure = Cause.squash(result.cause);
        process.stderr.write(
          `${failure instanceof Error ? failure.message : "OpenGPT failed."}\n`,
        );
        process.exitCode = 1;
      }
    },
  });
  process.once("SIGINT", () => cancel());
  process.once("SIGTERM", () => cancel());
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

if (isEntrypoint(process.argv[1])) startCli();
