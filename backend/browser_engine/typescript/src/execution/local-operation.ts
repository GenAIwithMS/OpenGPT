import { stageSources } from "./local-operation-stage.js";
import { serialize } from "node:v8";
import { fileURLToPath } from "node:url";
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Schema } from "effect";
import type { BrowserExecute } from "../runtime/browser-execution.js";
import { Deadline } from "../runtime/deadline.js";
import type { InputAsker } from "../runtime/input-request.js";
import type { DialogDecider } from "../runtime/kernel-operation.js";
import type { WriteDeclaration } from "../runtime/operation.js";
import type { CommitMark } from "../runtime/context.js";
import type { InputIssue } from "../runtime/errors.js";
import type {
  InputRefusalDetail,
  InputNotAppliedDetail,
} from "../runtime/operation-failure.js";
import type { ScriptQuestionDeclarations } from "../runtime/script-input.js";
import { asksAsDeclared } from "./declared-questions.js";
import {
  type CardFillOutcome,
  type RunCardHandles,
  makeRunCardHandles,
  scriptAnswers,
  scriptCardFillAnswer,
} from "../destinations/card-fill.js";
import type { ScriptCardFillRequest } from "../runtime/script-card-fill.js";
import {
  sessionSignInAnswerMs,
  sessionSignInFillMs,
  sessionSignInSettleMs,
  type SessionSignInAnswer,
  type SessionSignInHook,
} from "../runtime/session-sign-in.js";
import { createLocalProcess, type LocalProcess, type LocalProcessResult } from "./local-process.js";
import { localError, localOutputLimit } from "./local-path.js";
import { LocalOperationMessage, type LocalOperationResult } from "./local-operation-protocol.js";
import type { LocalWorkspace } from "./local-workspace.js";
import { FileRefused } from "../runtime/files.js";
import { outputFiles, type RunFiles } from "../runtime/file-transfer.js";
import { HttpFailure, type HttpTransport } from "../runtime/site-http.js";
import type { ListHost } from "../runtime/list-page.js";

export interface LocalOperationOptions {
  readonly workspace: LocalWorkspace;
  readonly entrypoint: string;
  readonly sources: readonly (readonly [string, string])[];
  readonly input?: unknown;
  readonly retainedOutput?: { readonly value: unknown };
  readonly browser?: { readonly sessionId: string; readonly executeResponse: BrowserExecute };
  readonly siteOrigin?: string;
  readonly siteDomain?: string;
  readonly timeoutMs?: number;
  readonly mode?: "run" | "contract";
  readonly validateInput?: boolean;
  /**
   * A run whose output fails its schema returns that output as its result, with `outputDrift`,
   * rather than failing `InvalidOutput`: a write already happened when it returned. Its files
   * are checked as any result's are.
   */
  readonly keepDriftedOutput?: boolean;
  readonly target?: "browser" | "pureFiles";
  /**
   * A mint step: the run counts as possibly sent from its first browser call, so a step that
   * stopped before one reads `not_sent`. Without it, a live run counts from its start.
   */
  readonly dispatchAtFirstCall?: boolean;
  readonly ask?: InputAsker;
  /**
   * The questions the host read itself: a build step's literal declarations, or the ones
   * publication reviewed. The host puts a script's request to its caller only when every question
   * matches one of them (`asksAsDeclared`); otherwise the script's `ask` fails as `Undeclared` and
   * nobody is asked. Absent, no script question is asked.
   */
  readonly declaredQuestions?: ScriptQuestionDeclarations;
  readonly decideDialog?: DialogDecider;
  /**
   * The host's sign-in for a script's `ensureSignedIn`, on the same browser. Absent, the script's
   * `ensureSignedIn` answers that it did not sign in again.
   */
  readonly signIn?: SessionSignInHook;
  /**
   * The host's card fill for a script's `fillCard`, on the same browser: it types the card answers
   * behind the step's handles, which this run's `ask` issued in place of each card answer. Absent,
   * `fillCard` throws, and a card answer still reaches the script only as a handle.
   */
  readonly cardFill?: (input: {
    readonly step: ScriptCardFillRequest;
    readonly handles: RunCardHandles;
  }) => Effect.Effect<CardFillOutcome, Error>;
  /**
   * Set when this host signs list cursors: the position the caller's cursor holds, once
   * `admitListCursor` checked it. Absent, a run refuses any cursor that would continue a runtime
   * list and returns no next cursor.
   */
  readonly list?: ListHost;
  /**
   * The run's files, for the script's `files`. Absent, `files` throws; either way an output naming
   * a `$file` this run did not collect fails the run.
   */
  readonly files?: RunFiles;
  /**
   * The transport an HTTP version's `SiteHttp` sends over, as `makeSiteHttp` uses it. Absent, an
   * HTTP version fails before it sends anything; a Kernel script never uses it.
   */
  readonly http?: HttpTransport;
}
export interface LocalOperationJournal {
  readonly effect: "not_sent" | "possible" | "verified";
  readonly confirmation?: "message" | "readback";
  readonly commits: readonly CommitMark[];
}
export class LocalOperationFailure extends Error {
  override readonly name = "LocalOperationFailure";
  /**
   * The child reported this failure with its final journal. False when the host lost the
   * result, as at a deadline or a child exit: the journal is then the last one the child
   * streamed as it ran.
   */
  readonly reported: boolean;
  /** The host could not sign the page in again while the script waited in `ensureSignedIn`. */
  readonly sessionLoss?: "session_not_kept";
  /** The input a script's `InvalidInput` named and the choices the page offers for it. */
  readonly refusal?: InputRefusalDetail;
  /** The input a script's `InputNotApplied` named and what the page kept instead. */
  readonly unapplied?: InputNotAppliedDetail;
  /** The authored source line that threw, such as `src/tool.mjs:12`, when the child named one. */
  readonly frame?: string;
  constructor(
    message: string,
    readonly journal: LocalOperationJournal,
    readonly code?: string,
    readonly tag?: string,
    /** Where the operation's input schema rejected its input, on an `InvalidInput`. */
    readonly inputIssues?: readonly InputIssue[],
    options: {
      readonly reported?: boolean;
      readonly sessionLoss?: "session_not_kept";
      readonly refusal?: InputRefusalDetail;
      readonly unapplied?: InputNotAppliedDetail;
      readonly frame?: string;
    } = {},
  ) {
    super(message);
    this.reported = options.reported ?? true;
    if (options.sessionLoss !== undefined) this.sessionLoss = options.sessionLoss;
    if (options.refusal !== undefined) this.refusal = options.refusal;
    if (options.unapplied !== undefined) this.unapplied = options.unapplied;
    if (options.frame !== undefined) this.frame = options.frame;
  }
}
export interface LocalOperationOutput extends LocalOperationJournal {
  readonly output: unknown;
  /** The declared schemas, and in contract mode the declared questions. */
  readonly schemas: {
    readonly input: unknown;
    readonly output: unknown;
    readonly questions?: ScriptQuestionDeclarations;
  };
  readonly stdout: string;
  readonly stderr: string;
  readonly write?: WriteDeclaration;
  readonly inputDecodes?: true;
  /** The output failed its schema and was kept (`keepDriftedOutput`). */
  readonly outputDrift?: true;
}

const sendToChild = (process: LocalProcess, message: object) =>
  Effect.async<void, Error>((resume) => {
    if (!process.child.connected || process.child.send === undefined) {
      resume(Effect.fail(new Error("Local child IPC disconnected")));
      return;
    }
    process.child.send(message, (error) =>
      resume(error === null ? Effect.void : Effect.fail(localError(error))),
    );
  });
const failureCode = (error: Error) =>
  "code" in error && typeof error.code === "string" ? error.code : undefined;
const suspended = <A, E>(deadline: Deadline, run: Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => deadline.suspend()),
    () => run,
    (resume) => Effect.sync(resume),
  );
/**
 * One script's `ensureSignedIn`, answered within the sign-in's bounds: no step of the host's
 * sign-in starts after the filling bound, and past the answer bound the host stops it, waits for
 * its last step to end and refuses. An interrupted request (the script ended or the child exited)
 * stops the sign-in the same way.
 */
export const answerSessionSignIn = (
  signIn: SessionSignInHook,
  bounds: { readonly fillMs: number; readonly answerMs: number; readonly settleMs: number } = {
    fillMs: sessionSignInFillMs,
    answerMs: sessionSignInAnswerMs,
    settleMs: sessionSignInSettleMs,
  },
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const stop = new AbortController();
    const signingIn = yield* Effect.forkDaemon(
      signIn({ untilMs: now + bounds.fillMs, stop: stop.signal }),
    );
    // Stop the sign-in at its next step and wait for it to end, so nothing after this shares the
    // browser with it.
    const settle = Effect.sync(() => stop.abort()).pipe(
      Effect.zipRight(Fiber.await(signingIn).pipe(Effect.timeoutOption(bounds.settleMs))),
      Effect.zipRight(Fiber.interrupt(signingIn)),
    );
    const raced = yield* Effect.raceFirst(
      Fiber.join(signingIn).pipe(Effect.map((answer) => ({ answer }))),
      Effect.sleep(bounds.answerMs).pipe(Effect.as({ expired: true as const })),
    ).pipe(Effect.onInterrupt(() => settle));
    if ("answer" in raced) return raced.answer;
    yield* settle;
    return { outcome: "refused", cause: "session_sign_in_failed" } satisfies SessionSignInAnswer;
  });
const handleRequest = (
  options: LocalOperationOptions,
  deadline: Deadline,
  message: Exclude<LocalOperationMessage, { kind: "result" | "error" | "cancel" | "journal" }>,
  cardHandles: RunCardHandles,
): Effect.Effect<unknown, Error> =>
  Effect.suspend<unknown, Error, never>(() => {
    if (message.kind === "execute") {
      if (options.mode === "contract" || options.target === "pureFiles")
        return Effect.fail(
          new Error("Browser access is unavailable for this local operation mode"),
        );
      if (options.browser === undefined || message.sessionId !== options.browser.sessionId)
        return Effect.fail(new Error("Local operation browser session mismatch"));
      return options.browser.executeResponse(message.body.code, message.body.timeout_sec);
    }
    if (
      message.kind === "file_place" ||
      message.kind === "file_arm" ||
      message.kind === "file_collect"
    ) {
      const files = options.files;
      if (files === undefined || options.mode === "contract" || options.target === "pureFiles")
        return Effect.fail(new Error("Local operation files are unavailable"));
      const answer: Effect.Effect<unknown, FileRefused> =
        message.kind === "file_place"
          ? files.place(message)
          : message.kind === "file_arm"
            ? files.arm()
            : files.collect(message);
      // The refusal's reason crosses to the script as its code; nothing of the file does.
      return answer.pipe(
        Effect.mapError((refused) =>
          Object.assign(new Error(refused.message), {
            code: `FileRefused:${refused.reason}${refused.dispatched === true ? ":dispatched" : ""}`,
          }),
        ),
      );
    }
    if (message.kind === "http") {
      const transport = options.http;
      if (transport === undefined || options.mode === "contract")
        return Effect.fail(new Error("Local operation HTTP is unavailable"));
      const { request, timeoutMs, maxResponseBytes } = message;
      return Effect.tryPromise({
        try: (signal) =>
          transport.send(request, {
            signal,
            timeoutMs,
            ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
          }),
        // The transport's failure crosses to the child as its code and dispatch.
        catch: (error) =>
          error instanceof HttpFailure
            ? Object.assign(new Error(error.message), {
                code: `HttpFailure:${error.code}:${error.dispatch}`,
              })
            : localError(error),
      });
    }
    if (message.kind === "sign_in")
      return options.signIn === undefined
        ? Effect.fail(new Error("Local operation sign-in is unavailable"))
        : suspended(deadline, answerSessionSignIn(options.signIn));
    if (message.kind === "ask") {
      if (options.ask === undefined)
        return Effect.fail(new Error("Local operation input is unavailable"));
      // The child runs minted code, so only the declarations the host read decide what is asked.
      if (!asksAsDeclared(message.request, options.declaredQuestions ?? {}))
        return Effect.fail(
          Object.assign(new Error("Local operation asked beyond its declared questions"), {
            code: "Undeclared",
          }),
        );
      return suspended(deadline, options.ask(message.request)).pipe(
        // ScriptInput validates raw answers in the child; the host has already typed them.
        Effect.map((answers) => scriptAnswers(message.request, answers, cardHandles)),
      );
    }
    if (message.kind === "card_fill") {
      const cardFill = options.cardFill;
      if (
        cardFill === undefined ||
        options.browser === undefined ||
        options.mode === "contract" ||
        options.target === "pureFiles"
      )
        return Effect.fail(new Error("Local operation card fill is unavailable"));
      return suspended(deadline, cardFill({ step: message.step, handles: cardHandles })).pipe(
        Effect.map(scriptCardFillAnswer),
      );
    }
    return options.decideDialog === undefined
      ? Effect.fail(new Error("Local operation dialog decision is unavailable"))
      : suspended(deadline, options.decideDialog({ ...message.report, interactionId: message.id }));
  });

const handleTerminalMessage = (
  message: Extract<LocalOperationMessage, { kind: "result" | "error" | "cancel" }>,
  completed: Deferred.Deferred<LocalOperationResult, Error>,
  pending: Map<string, Fiber.RuntimeFiber<void, never>>,
) => {
  if (message.kind === "result") {
    Effect.runSync(
      pending.size === 0
        ? Deferred.succeed(completed, message)
        : Deferred.fail(
            completed,
            new Error(
              "Local operation returned while host requests were pending; completion uncertain",
            ),
          ),
    );
    return;
  }
  if (message.kind === "error") {
    Effect.runSync(
      Deferred.fail(
        completed,
        new LocalOperationFailure(
          message.error,
          operationJournal(message),
          message.code,
          message.tag,
          message.inputIssues,
          {
            // A host request still out may yet reach the page, so this is no final report.
            ...(pending.size === 0 ? {} : { reported: false }),
            ...(message.sessionLoss === undefined ? {} : { sessionLoss: message.sessionLoss }),
            ...(message.refusal === undefined ? {} : { refusal: message.refusal }),
            ...(message.unapplied === undefined ? {} : { unapplied: message.unapplied }),
            ...(message.frame === undefined ? {} : { frame: message.frame }),
          },
        ),
      ),
    );
    return;
  }
  if (message.kind === "cancel") {
    const fiber = pending.get(message.id);
    if (fiber !== undefined) Effect.runCallback(Fiber.interrupt(fiber));
    return;
  }
};

const decodeMessage = (raw: unknown) =>
  Effect.try({
    try: () => {
      if (serialize(raw).byteLength > localOutputLimit)
        throw new Error("Local operation IPC exceeds output limit");
      return raw;
    },
    catch: localError,
  }).pipe(Effect.flatMap(Schema.decodeUnknown(LocalOperationMessage)), Effect.mapError(localError));

const receiveOperation = (
  process: LocalProcess,
  options: LocalOperationOptions,
  deadline: Deadline,
) =>
  Effect.gen(function* () {
    const completed = yield* Deferred.make<LocalOperationResult, Error>();
    const pending = new Map<string, Fiber.RuntimeFiber<void, never>>();
    // The run's card answers, which only its own `fillCard` names; nothing keeps them past it.
    const cardHandles = makeRunCardHandles();
    let finished = false;
    let current: LocalOperationJournal = { effect: "not_sent", commits: [] };
    const listener = (raw: unknown) => {
      if (finished) return;
      const decoded = Effect.runSync(decodeMessage(raw).pipe(Effect.either));
      if (decoded._tag === "Left") {
        finished = true;
        Effect.runSync(Deferred.fail(completed, decoded.left));
        return;
      }
      const message = decoded.right;
      if (message.kind === "journal" || message.kind === "error" || message.kind === "result")
        current = operationJournal(message);
      if (message.kind === "journal") return;
      if (message.kind === "result" || message.kind === "error" || message.kind === "cancel") {
        if (message.kind !== "cancel") finished = true;
        handleTerminalMessage(message, completed, pending);
        return;
      }
      if (pending.has(message.id)) {
        Effect.runSync(Deferred.fail(completed, new Error("Duplicate local operation request")));
        return;
      }
      const task = handleRequest(options, deadline, message, cardHandles).pipe(
        Effect.exit,
        Effect.flatMap((exit) => {
          if (Exit.isSuccess(exit))
            return sendToChild(process, { kind: "reply", id: message.id, value: exit.value });
          const error = localError(Cause.squash(exit.cause));
          const code = failureCode(error);
          return sendToChild(process, {
            kind: "failure",
            id: message.id,
            error: error.message,
            ...(code === undefined ? {} : { code }),
          });
        }),
        Effect.catchAll((error) => Deferred.fail(completed, error)),
        Effect.asVoid,
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(message.id);
          }),
        ),
      );
      pending.set(message.id, Effect.runFork(task));
    };
    process.child.on("message", listener);
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        process.child.off("message", listener);
        yield* Effect.forEach(
          pending.values(),
          (fiber) =>
            Fiber.interrupt(fiber).pipe(
              Effect.flatMap((exit) =>
                Exit.isFailure(exit) && !Cause.isInterruptedOnly(exit.cause)
                  ? Effect.die(localError(Cause.squash(exit.cause)))
                  : Effect.void,
              ),
            ),
          {
            discard: true,
            concurrency: "unbounded",
          },
        );
      }),
    );
    const completion = Deferred.await(completed);
    const exited = process.result.pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? completion
          : Effect.fail(
              new Error(
                `Local operation child exited ${result.exitCode ?? result.signal}; completion uncertain`,
              ),
            ),
      ),
    );
    return {
      completed: completion.pipe(Effect.raceFirst(exited)),
      pending,
      journal: Effect.sync(() => current),
    };
  });

const operationJournal = (
  result: Pick<LocalOperationResult, "effect" | "commits" | "confirmation">,
): LocalOperationJournal => ({
  effect:
    result.effect === "not_started"
      ? "not_sent"
      : result.effect === "may_have_dispatched"
        ? "possible"
        : "verified",
  commits: result.commits,
  ...(result.confirmation === undefined ? {} : { confirmation: result.confirmation }),
});
const operationOutput = (
  result: LocalOperationResult,
  output: LocalProcessResult,
): LocalOperationOutput => {
  return {
    output: result.output,
    schemas: {
      input: result.inputSchema,
      output: result.outputSchema,
      ...(result.questions === undefined ? {} : { questions: result.questions }),
    },
    stdout: output.stdout,
    stderr: output.stderr,
    ...operationJournal(result),
    ...(result.write === undefined ? {} : { write: result.write }),
    ...(result.inputDecodes === undefined ? {} : { inputDecodes: result.inputDecodes }),
    ...(result.outputDrift === undefined ? {} : { outputDrift: result.outputDrift }),
  };
};

/** Fails the run when its output holds a `$file` the run's files did not collect. */
const checkOutputFiles = (files: RunFiles | undefined, result: LocalOperationResult) =>
  (files === undefined
    ? outputFiles(result.output).length === 0
      ? Effect.void
      : Effect.fail(new FileRefused({ reason: "not_collected" }))
    : files.checkOutput(result.output)
  ).pipe(
    Effect.mapError(
      (refused) =>
        new LocalOperationFailure(refused.message, operationJournal(result), "FileRefused"),
    ),
  );

/** Executes one immutable reviewed snapshot through the original operation runtime, without replay. */
export const runLocalOperation = (
  options: LocalOperationOptions,
): Effect.Effect<LocalOperationOutput, Error> =>
  Effect.scoped(
    Effect.gen(function* () {
      const timeoutMs = options.timeoutMs ?? 20 * 60_000;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        return yield* Effect.fail(new Error("Local operation timeout must be positive and finite"));
      const deadline = Deadline.after(timeoutMs);
      const staged = yield* stageSources(options);
      const process = yield* createLocalProcess({
        command: globalThis.process.execPath,
        args: [
          fileURLToPath(
            new URL(
              import.meta.url.endsWith(".ts")
                ? "./local-operation-child.ts"
                : "./local-operation-child.js",
              import.meta.url,
            ),
          ),
        ],
        cwd: staged.directory,
        environment: options.workspace.environment,
        ipc: true,
      });
      const response = yield* receiveOperation(process, options, deadline);
      yield* sendToChild(process, {
        kind: "start",
        entrypoint: staged.entrypoint,
        input: options.input,
        ...(options.retainedOutput === undefined ? {} : { retainedOutput: options.retainedOutput }),
        sessionId: options.browser?.sessionId ?? "offline",
        timeoutMs,
        mode: options.mode ?? "run",
        ...(options.validateInput === undefined ? {} : { validateInput: options.validateInput }),
        ...(options.keepDriftedOutput === true ? { keepDriftedOutput: true } : {}),
        ...(options.target === "pureFiles" || options.browser === undefined
          ? { offline: true }
          : {}),
        ...(options.dispatchAtFirstCall === true ? { dispatchAtFirstCall: true } : {}),
        ...(options.siteOrigin === undefined ? {} : { siteOrigin: options.siteOrigin }),
        ...(options.siteDomain === undefined ? {} : { siteDomain: options.siteDomain }),
        ...(options.files !== undefined ? { files: true } : {}),
        ...(options.list === undefined ? {} : { list: options.list }),
        ...(options.http === undefined || options.mode === "contract"
          ? {}
          : { http: { name: options.http.name, capabilities: options.http.capabilities } }),
        ...(options.signIn !== undefined &&
        options.browser !== undefined &&
        options.mode !== "contract" &&
        options.target !== "pureFiles"
          ? { signIn: true }
          : {}),
        ...(options.cardFill !== undefined &&
        options.browser !== undefined &&
        options.mode !== "contract" &&
        options.target !== "pureFiles"
          ? { cardFill: true }
          : {}),
      });
      const result = yield* response.completed.pipe(
        Effect.raceFirst(
          deadline.awaitExpiry.pipe(
            Effect.zipRight(
              Effect.fail(
                new Error("Local operation deadline expired; execution was not replayed"),
              ),
            ),
          ),
        ),
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            const failure =
              error instanceof LocalOperationFailure
                ? error
                : new LocalOperationFailure(
                    error.message,
                    yield* response.journal,
                    failureCode(error),
                    undefined,
                    undefined,
                    { reported: false },
                  );
            yield* process.close;
            const channels = yield* process.result.pipe(Effect.either);
            return yield* Effect.fail(
              Object.assign(
                failure,
                channels._tag === "Right"
                  ? { stdout: channels.right.stdout, stderr: channels.right.stderr }
                  : { cause: channels.left },
              ),
            );
          }),
        ),
      );
      // Only a file this run collected may stand in its output; a script cannot name another.
      yield* checkOutputFiles(options.files, result).pipe(
        Effect.tapError(() => process.close),
      );
      yield* process.close;
      const output = yield* process.result.pipe(
        Effect.raceFirst(
          deadline.awaitExpiry.pipe(
            Effect.zipRight(
              Effect.fail(new Error("Local operation child did not exit after result")),
            ),
          ),
        ),
      );
      return operationOutput(result, output);
    }),
  );
