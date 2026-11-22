import { Effect, Option } from "effect";
import type { Scope } from "effect";
import { ExecutionContext, finishCaptureAsEvidence } from "./context.js";
import type { EffectJournal } from "./context.js";
import { DeadlineExceeded } from "./errors.js";
import type { CaptureUnavailable, EventUnavailable, InvalidInput, InvalidOutput } from "./errors.js";
import { runKernelScript } from "./kernel-operation.js";
import type { KernelExecuteClient, KernelOperation } from "./kernel-operation.js";
import {
  decodeKernelOperationInput,
  validateKernelOperationOutput,
} from "./kernel-operation-validation.js";
import type { WriteDeclaration } from "./operation.js";
import type { ScriptFailure } from "./operation-failure.js";
import { ScriptInput } from "./script-input.js";
import { withListHost } from "./list-host.js";

// How a host runs an operation's script: under the execution context's deadline, capture, events
// and journal, over the runtime's script run (`runKernelScript`).

/**
 * The job's browser a script runs on, as the runner binds it. An offline run cannot reach a
 * site, so it never marks a possible effect or signs in.
 */
type ScriptBrowser = Omit<
  Parameters<typeof runKernelScript>[2],
  "deadline" | "journal" | "scriptInput"
>;

/** The browser client, each call marked as a possible dispatch, so no call follows `verified`. */
const journaledKernel = (
  kernel: KernelExecuteClient,
  journal: EffectJournal,
): KernelExecuteClient => ({
  browsers: {
    playwright: {
      execute: (sessionId, body, options) => {
        Effect.runSync(journal.enteringDispatch);
        return kernel.browsers.playwright.execute(sessionId, body, options);
      },
    },
  },
});

/**
 * A live run's browser: every call goes through the journal, so the effect after `verified` stays
 * verified only while no call follows it. An offline run's stays as it is.
 */
const liveBrowser = <
  Browser extends { readonly kernel: KernelExecuteClient; readonly offline?: boolean },
>(
  browser: Browser,
  journal: EffectJournal,
) =>
  browser.offline === true
    ? browser
    : { ...browser, kernel: journaledKernel(browser.kernel, journal), journal };

/** The write's declared commit step names, only strings, in order. */
const declaredCommits = (write: WriteDeclaration | undefined): readonly string[] => {
  const declared: unknown = write?.commits;
  return Array.isArray(declared) ? declared.filter((n): n is string => typeof n === "string") : [];
};

/**
 * Runs an operation's script under the execution deadline: input decoded, capture bracketed,
 * output validated. The whole run may have dispatched, so the journal is marked before it starts
 * and again at each execute call, and only the script's `verified` after its read-back settles it.
 * `first` is for a host that has its own implementation of the operation: it runs after the login
 * hooks in place of the script and gets the script's run as its fallback. The local host never
 * passes it.
 */
export const executeKernelOperation = <
  Input,
  EncodedInput,
  Output,
  EncodedOutput,
  FirstError = never,
  FirstServices = never,
>(
  operation: KernelOperation<Input, EncodedInput, Output, EncodedOutput>,
  rawInput: unknown,
  browser: ScriptBrowser,
  first?: (
    script: Effect.Effect<Output, ScriptFailure>,
    input: Input,
  ) => Effect.Effect<Output, FirstError, FirstServices>,
): Effect.Effect<
  Output,
  | ScriptFailure
  | InvalidInput
  | InvalidOutput
  | DeadlineExceeded
  | CaptureUnavailable
  | EventUnavailable
  | FirstError,
  ExecutionContext | Scope.Scope | FirstServices
> =>
  Effect.gen(function* () {
    const execution = yield* ExecutionContext;
    // Declared first, so every exit reports which commit steps were never reached.
    yield* execution.journal.declareCommits(declaredCommits(operation.write));
    const decoded = yield* decodeKernelOperationInput(operation, rawInput);
    // A host that signs list cursors puts the checked position beside the input, never in it.
    const input = browser.list === undefined ? decoded : withListHost(decoded, browser.list);
    if (execution.deadline.remainingMs() <= 0)
      return yield* new DeadlineExceeded({ phase: "execution", dispatch: "not_sent" });
    return yield* Effect.gen(function* () {
      yield* Effect.acquireRelease(execution.capture.start, () =>
        finishCaptureAsEvidence(execution),
      );
      yield* execution.events.emit("operation.started", { operation: operation.name });
      const live = liveBrowser(browser, execution.journal);
      if (browser.offline !== true) yield* execution.journal.enteringDispatch;
      // The runner provides the caller's questions; only the script itself may ask.
      const scriptInput = yield* Effect.serviceOption(ScriptInput);
      const script = runKernelScript(operation, input, {
        ...live,
        deadline: execution.deadline,
        ...(Option.isSome(scriptInput) ? { scriptInput: scriptInput.value } : {}),
      });
      const output = yield* first === undefined ? script : first(script, input);
      const validated = yield* validateKernelOperationOutput(operation, output);
      yield* execution.events.emit("operation.output_validated", { operation: operation.name });
      return validated;
    }).pipe(
      Effect.raceFirst(
        execution.deadline.awaitExpiry.pipe(
          Effect.zipRight(
            Effect.fail(new DeadlineExceeded({ phase: "execution", dispatch: "unknown" })),
          ),
        ),
      ),
    );
  });
