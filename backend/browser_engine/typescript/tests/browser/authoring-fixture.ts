import type { Page } from "playwright";
import { Effect, Either, Scope } from "effect";
import { ExecutionContext, makeEffectJournal } from "../../src/runtime/context.js";
import type { EffectJournal } from "../../src/runtime/context.js";
import { Deadline } from "../../src/runtime/deadline.js";
import { siteDomain } from "../../src/runtime/same-site.js";
import type {
  DialogDecider,
  KernelExecuteClient,
  KernelOperation,
} from "../../src/runtime/kernel-operation.js";
import { makeLocalKernel } from "../../src/testing/local-kernel.js";
import { executeKernelOperation } from "../../src/runtime/kernel-operation-run.js";
import { makeScriptInput, ScriptInput } from "../../src/runtime/script-input.js";
import type { InputAnswers, InputRequest } from "../../src/runtime/input-request.js";
import type { FileChannel } from "../../src/runtime/files.js";
import type { ListHost } from "../../src/runtime/list-host.js";
import { makeRunFiles } from "../../src/runtime/file-transfer.js";
import { makeLocalFileHook } from "../../src/execution/local-files.js";
import { makeLocalDownloads } from "../../src/execution/local-downloads.js";

/**
 * The local host's file service on a test page, placing only `references` and keeping downloads
 * under `downloads`, until `scope` closes.
 */
export const localFiles = (
  page: Page,
  options: {
    readonly siteOrigin: string;
    readonly references: readonly string[];
    readonly downloads: string;
    readonly scope: Scope.Scope;
  },
) => {
  const local = makeLocalKernel(page);
  const execute = (code: string, timeoutSec?: number) =>
    Effect.promise(() =>
      local.browsers.playwright.execute("session-1", {
        code,
        ...(timeoutSec === undefined ? {} : { timeout_sec: timeoutSec }),
      }),
    );
  return Effect.runPromise(
    Effect.gen(function* () {
      const hook = yield* makeLocalFileHook({
        execute,
        downloads: makeLocalDownloads(options.downloads),
      });
      return yield* makeRunFiles({
        hook,
        execute,
        siteOrigin: options.siteOrigin,
        resolve: (reference) => (options.references.includes(reference) ? reference : undefined),
      });
    }).pipe(Scope.extend(options.scope)),
  );
};

// The authoring examples, run through the runtime as the local runner wires a run, on the saved-DOM
// stand-in for Kernel, which runs each call's code as Kernel does, with `page` in scope, here on a
// local page. The site domain is
// the host's, computed from the site origin as the sandbox's browser binding carries it.
export const runExample = async <Input, EncodedInput, Output, EncodedOutput>(
  page: Page,
  operation: KernelOperation<Input, EncodedInput, Output, EncodedOutput>,
  input: unknown,
  options: {
    readonly siteOrigin?: string;
    readonly deadlineMs?: number;
    readonly dialogs?: DialogDecider;
    readonly files?: FileChannel;
    /** The list position a host checked, as a host that signs cursors passes it. */
    readonly list?: ListHost;
    /** The caller's answers to the operation's declared questions; absent, nobody answers. */
    readonly answer?: (request: InputRequest) => InputAnswers;
    /** The run's journal, for a test that reads its marks while a question waits. */
    readonly journal?: EffectJournal;
  } = {},
) => {
  const calls: string[] = [];
  const domain = options.siteOrigin === undefined ? undefined : siteDomain(options.siteOrigin);
  const local = makeLocalKernel(page);
  const kernel: KernelExecuteClient = {
    browsers: {
      playwright: {
        execute: (sessionId, body, requestOptions) => {
          calls.push(body.code);
          return local.browsers.playwright.execute(sessionId, body, requestOptions);
        },
      },
    },
  };
  const journal = options.journal ?? (await Effect.runPromise(makeEffectJournal));
  const result = await Effect.runPromise(
    Effect.either(
      Effect.scoped(
        executeKernelOperation(operation, input, {
          kernel,
          sessionId: "session-1",
          ...(options.siteOrigin === undefined ? {} : { siteOrigin: options.siteOrigin }),
          ...(domain === undefined ? {} : { siteDomain: domain }),
          ...(options.dialogs === undefined ? {} : { dialogs: options.dialogs }),
          ...(options.files === undefined ? {} : { files: options.files }),
          ...(options.list === undefined ? {} : { list: options.list }),
        }).pipe(
          (run) =>
            options.answer === undefined
              ? run
              : Effect.provideService(
                  run,
                  ScriptInput,
                  makeScriptInput(operation.questions, (request) =>
                    Effect.sync(() => options.answer?.(request) ?? {}),
                  ),
                ),
          Effect.provideService(ExecutionContext, {
            deadline: Deadline.after(options.deadlineMs ?? 10_000),
            journal,
            events: { emit: () => Effect.void },
            capture: { start: Effect.void, finish: Effect.void },
          }),
        ),
      ),
    ),
  );
  return {
    result,
    calls,
    effect: await Effect.runPromise(journal.state),
    confirmation: await Effect.runPromise(journal.confirmation),
    commits: await Effect.runPromise(journal.commits),
  };
};

/** The typed failure, for matching its tag, message and dispatch. */
export const failure = (result: Either.Either<unknown, unknown>): unknown =>
  Either.isLeft(result) ? result.left : undefined;
