import { randomUUID } from "node:crypto";
import {
  controlLabelsFromAriaSnapshot,
  lintOutput,
  lintSchemas,
  outputChecksNotice,
} from "../runtime/output-lint.js";
import { Effect, Either } from "effect";
import {
  runLocalOperation,
  LocalOperationFailure,
  type LocalOperationJournal,
  type LocalOperationOutput,
} from "../execution/local-operation.js";
import type { GuardianAction } from "../guardian/review-contracts.js";
import type { MintReviewFeedback } from "../mint/input-feedback.js";
import {
  hostAuthentication,
  type AllowedExecution,
  type MintDependencies,
  type ExecutionEvidence,
  type ExecutionRequest,
  type ScriptQuestionOutcome,
} from "../mint/contracts.js";
import { localCommandTimeoutMs } from "../execution/local-workspace.js";
import { localOutputLimit } from "../execution/local-path.js";
import {
  acceptedConfirmsKept,
  recordConfirmSteps,
  type ObservedConfirm,
} from "../browser/dialogs/expected.js";
import { keepingAcceptedConfirms, makeDialogDecider } from "../inputs/dialog.js";
import { questionForReview } from "../guardian/question.js";
import {
  draftQuestionDeclarationFailure,
  draftQuestionDeclarations,
} from "../mint/draft-questions.js";
import { secretHandleRefusal } from "../mint/secret-handles.js";
import { runCardFill } from "../destinations/card-fill.js";
import { paymentFrameOrigins } from "../destinations/payment-frames.js";
import { screenMintText } from "../mint/workspace.js";
import { fileHandleRefusal } from "../mint/file-handles.js";
import { fileReadbackRefusal } from "../mint/file-readback.js";
import { cardReadbackRefusal } from "../mint/card-readback.js";
import { makeLocalFileHook } from "../execution/local-files.js";
import { makeRunFiles } from "../runtime/file-transfer.js";
import { stepInput } from "../mint/step-checks.js";
import { admitListCursor, sealListOutput } from "../runtime/list-cursor.js";
import { mintListScope, refusedCursor } from "./list-cursors.js";
import { readBackFirst, sessionEnteredMarks, writePathRemaining } from "../mint/write-session.js";
import { commitEvidenceOf, type CommitEvidence } from "../runtime/run-outcome.js";
import { InputRequestFailure, type InputAsker } from "../runtime/input-request.js";
import { siteDomain } from "../runtime/same-site.js";
import { probeCallCode } from "../runtime/host-execute.js";
import type { BrowserExecute } from "../runtime/browser-execution.js";
import { trustedUrl } from "../runtime/sign-in-origins.js";
import type { MintState } from "./mint-state.js";
import {
  keptScriptAnswers,
  reusedScriptAnswers,
  scriptQuestionKeys,
} from "../mint/script-answer-reuse.js";
import { error, mintError } from "./errors.js";
import { mintSessionSignInFailure, type SessionSignInFailed } from "./session-sign-in.js";
import { sessionCardFill } from "./card-fill.js";
type Execution = Parameters<MintDependencies["reviewAndExecute"]>[0];
type BeforeDispatch = Parameters<MintDependencies["reviewAndExecute"]>[1];
/**
 * The allow a dispatch fence follows: the review and Guardian's action label. An execution allow
 * always carries one, as Guardian's review decodes it.
 */
const allowedOf = (reviewed: {
  readonly reviewId: string;
  readonly decision: { readonly action?: GuardianAction | undefined };
}): Effect.Effect<AllowedExecution, Error> =>
  reviewed.decision.action === undefined
    ? Effect.fail(new Error("Guardian's allow carried no action label"))
    : Effect.succeed({ reviewId: reviewed.reviewId, action: reviewed.decision.action });
const executeCommand = (
  state: MintState,
  execution: Extract<Execution, { purpose: "command" }>,
  beforeDispatch: BeforeDispatch,
) =>
  Effect.gen(function* () {
    const { workspace, context } = state;
    const { projection } = state.session;
    const id = randomUUID();

    const sources = new Map(
      (yield* workspace.snapshot).map(([path, text]) => [`operation/${path}`, text]),
    );
    sources.set("operation/command.sh", execution.command);
    const reviewed = yield* context.review(
      {
        entrypoint: "operation/command.sh",
        sources,
        input: {},
        currentExecution: {
          purpose: "command",
          target: "pureFiles",
          commandSandbox: {
            // The command runs in the workspace; its path on this machine is not Guardian's.
            cwd: ".",
            timeoutSeconds: localCommandTimeoutMs / 1000,
            maxOutputBytes: localOutputLimit,
          },
        },
      },
      "not_sent",
    );
    yield* allowedOf(reviewed).pipe(
      Effect.flatMap((allowed) => beforeDispatch?.(allowed) ?? Effect.void),
    );
    const exec = workspace.session.exec?.bind(workspace.session);
    if (exec === undefined)
      return yield* Effect.fail(new Error("Workspace command execution unavailable"));
    return yield* context.running(
      { purpose: "command", target: "pureFiles" },
      Effect.gen(function* () {
        const result = yield* Effect.tryPromise({
          try: () => exec({ cmd: execution.command }),
          catch: error,
        });
        return {
          executionId: id,
          status: result.exitCode === 0 ? ("completed" as const) : ("failed" as const),
          effect: "not_sent" as const,
          observations: yield* projection.json(result),
        };
      }),
    );
  });
/**
 * A sign-in step: a screen the recorder fills, an approval, a rejected value or a signed-in check.
 * Each belongs to the sign-in under way, and after a verified sign-in the first one starts a new
 * one. A screen's report reaches the minter as `step`, with its controls after a clicked submit.
 */
const executeAuthentication = (
  state: MintState,
  signIn: NonNullable<ExecutionRequest["signInStep"]>,
  loginUrl: string | undefined,
  beforeDispatch: BeforeDispatch,
) =>
  Effect.gen(function* () {
    const { start, recorder, afterSubmit, context, markers } = state;
    const { projection } = state.session;
    const id = randomUUID();

    yield* start.enter;
    start.signIn();
    if (!("signedIn" in signIn)) markers.signInStep();
    const step = yield* recorder.step(
      signIn,
      loginUrl,
      // The host fills the sign-in itself, after its own review of each screen.
      Effect.zipRight(markers.beforeTyping, beforeDispatch?.(hostAuthentication) ?? Effect.void),
    );
    if ("fields" in signIn && step.report !== undefined) start.sent(step.report, signIn.fields);
    if (step.approved === true) start.approved();
    const authenticated = step.verified === true && start.verified();
    const result =
      step.report === undefined
        ? step.result
        : { step: yield* afterSubmit(step.report), ...step.result };
    yield* context.observe;
    return {
      executionId: id,
      status: "completed" as const,
      effect: "possible" as const,
      observations: yield* projection.json(result),
      ...(authenticated
        ? {
            authentication: {
              state: "authenticated" as const,
              effect: "verified" as const,
            },
          }
        : {}),
    };
  });

const scriptQuestions = (
  state: MintState,
  entrypoint: string,
  input: unknown,
  sourceMap: ReadonlyMap<string, string>,
) => {
  const { context, mintAsk, scriptAnswers } = state;
  const { projection } = state.session;
  let scriptQuestion: ScriptQuestionOutcome | undefined;
  let unanswered = false;
  const scriptAsk: InputAsker = (candidate, bounds) =>
    Effect.gen(function* () {
      const question = yield* questionForReview(
        candidate,
        { credentialsAvailable: false, scriptAsk: true },
        projection.text,
      );
      const review = yield* context.reviewQuestion(
        { entrypoint: `operation/${entrypoint}`, sources: sourceMap, input },
        question,
      );
      if (review.decision.outcome !== "allow_business") {
        scriptQuestion = {
          requestId: candidate.id,
          outcome: review.decision.outcome,
          rationale: review.decision.rationale,
          reviewId: review.reviewId,
        };
        return yield* Effect.fail(new InputRequestFailure({ code: "Unauthorized" }));
      }
      // The same question asked again reuses the owner's answer, however long ago they gave it
      // and whether or not a step entered a commit since. Guardian reviewed this ask all the same,
      // and the reused answer reaches later reviews as a fresh one does. It is always the owner's
      // latest answer to its prompt (`forgetScriptAnswers`), so it never replaces a newer one in
      // Guardian's list.
      const keys = yield* scriptQuestionKeys(candidate, (text) => projection.text(text));
      const answers =
        reusedScriptAnswers(candidate, keys, scriptAnswers.kept) ??
        (yield* mintAsk(candidate, bounds).pipe(
          Effect.tap((fresh) =>
            Effect.sync(() => {
              scriptAnswers.kept = keptScriptAnswers(scriptAnswers.kept, keys, fresh);
            }),
          ),
        ));
      yield* context.answered(candidate, answers);
      return answers;
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof InputRequestFailure
          ? cause
          : new InputRequestFailure({ code: "Unavailable" }),
      ),
      Effect.tapError((cause) =>
        Effect.sync(() => {
          if (cause.code === "NoResponse") unanswered = true;
        }),
      ),
    );
  return {
    scriptAsk,
    get scriptQuestion() {
      return scriptQuestion;
    },
    get unanswered() {
      return unanswered;
    },
  };
};

/**
 * What an act step's effect journal shows about its write. The journal reads `not_sent` only
 * while the step made no browser call, so anything else may have reached the site: the step is
 * `possiblySent`. Whether it was a write is Guardian's label, `action`. A step whose child did
 * not report its own result has `unreported` commit evidence, and the marks it streamed count
 * only once a later step confirms. Only a failed step Guardian labelled a write asks the minter
 * to read back before writing again (`readBackFirst`). Marks showing no commit step entered
 * skip the ask only while the step made no browser call: this host records no requests that
 * would show a write the page sent before any mark was entered.
 */
const actOutcome = (
  executed: Either.Either<LocalOperationOutput, Error>,
  action: GuardianAction | undefined,
) => {
  const failure = Either.isLeft(executed) ? executed.left : undefined;
  const journal: LocalOperationJournal = Either.isRight(executed)
    ? executed.right
    : failure instanceof LocalOperationFailure
      ? failure.journal
      : { effect: "possible", commits: [] };
  const reported =
    Either.isRight(executed) || (failure instanceof LocalOperationFailure && failure.reported);
  const entered = journal.commits
    .filter((mark) => mark.state !== "not_sent")
    .map(({ name }) => name);
  const commit: CommitEvidence = reported ? commitEvidenceOf(journal.commits) : "unreported";
  return {
    marks: {
      ...(journal.confirmation === undefined ? {} : { confirmation: journal.confirmation }),
      ...(action === undefined ? {} : { action }),
      possiblySent: journal.effect !== "not_sent",
      enteredMarks: reported ? entered : [],
      ...(failure instanceof LocalOperationFailure && !reported ? { streamedMarks: entered } : {}),
    },
    writeSession:
      failure !== undefined && action === "write"
        ? readBackFirst(
            commit === "not_entered" && journal.effect !== "not_sent" ? undefined : commit,
          )
        : undefined,
  };
};

type Journal = Parameters<MintDependencies["reviewAndExecute"]>[2];
interface ReceiptInput {
  readonly state: MintState;
  readonly execution: Exclude<Execution, { purpose: "command" }>;
  readonly id: string;
  readonly sources: readonly (readonly [string, string])[];
  readonly input: unknown;
  readonly intentDerivedInput?: Readonly<Record<string, unknown>>;
  readonly reviewed: {
    readonly reviewId: string;
    readonly decision: {
      readonly outcome: "allow" | "deny" | "escalate";
      readonly rationale: string;
      readonly action?: GuardianAction | undefined;
      readonly advice?: string | undefined;
    };
  };
  readonly journal: Journal;
  /** A failed act step that may have committed its write: read back before writing again. */
  readonly writeSession?: { readonly verifyFirst: true; readonly notice: string };
  /** An act step's marks of the session's recorded write path not yet settled. */
  readonly writePathRemaining?: readonly string[];
  /** The step ran after the host sent a login no check verified; see `afterUnverifiedSignIn`. */
  readonly afterUnverifiedSignIn?: true;
}
/** The allow a receipt carries: Guardian's review, outcome, rationale and action label. */
const reviewFeedback = ({ reviewId, decision }: ReceiptInput["reviewed"]): MintReviewFeedback => ({
  reviewId,
  outcome: decision.outcome,
  rationale: decision.rationale,
  ...(decision.action === undefined ? {} : { action: decision.action }),
  ...(decision.advice === undefined ? {} : { advice: decision.advice }),
});
const failedReceipt = (
  receipt: ReceiptInput,
  failure: Error,
  questions: {
    readonly scriptQuestion: ScriptQuestionOutcome | undefined;
    readonly unanswered: boolean;
  },
) =>
  Effect.gen(function* () {
    const { state, execution, id, sources, input, intentDerivedInput, reviewed, journal } = receipt;
    const { runs } = state;
    const { secrets } = state.session;
    const { scriptQuestion, unanswered } = questions;
    const { writeSession, afterUnverifiedSignIn } = receipt;

    const failureJournal: LocalOperationJournal =
      failure instanceof LocalOperationFailure
        ? failure.journal
        : {
            effect: execution.target === "pureFiles" ? "not_sent" : "possible",
            commits: [],
          };
    runs.set(id, {
      sources,
      entrypoint: execution.entrypoint,
      input,
      ...(intentDerivedInput === undefined ? {} : { intentDerivedInput }),
      output: undefined,
      purpose: execution.purpose,
      journal: failureJournal,
      ...(reviewed.decision.action === undefined ? {} : { action: reviewed.decision.action }),
      ...(afterUnverifiedSignIn === undefined ? {} : { afterUnverifiedSignIn }),
    });
    const evidence: ExecutionEvidence = {
      executionId: id,
      status: "failed",
      effect: failureJournal.effect,
      ...(failureJournal.confirmation === undefined
        ? {}
        : { confirmation: failureJournal.confirmation }),
      ...(receipt.writePathRemaining === undefined
        ? {}
        : { writePathRemaining: receipt.writePathRemaining }),
      observations: {
        message: secrets.redact(failure.message),
        ...(failure instanceof LocalOperationFailure
          ? {
              code: failure.code,
              tag: failure.tag,
              ...(failure.sessionLoss === undefined ? {} : { sessionLoss: failure.sessionLoss }),
            }
          : {}),
        ...(writeSession === undefined ? {} : { writeSession }),
      },
      review: reviewFeedback(reviewed),
      ...(scriptQuestion === undefined ? {} : { scriptQuestion }),
      ...(unanswered || (failure instanceof LocalOperationFailure && failure.code === "NoResponse")
        ? { noResponse: { possibleCommit: execution.purpose === "act" } }
        : {}),
    };
    yield* journal?.record(evidence) ?? Effect.void;
    return evidence;
  });
const completedReceipt = (receipt: ReceiptInput, result: LocalOperationOutput) =>
  Effect.gen(function* () {
    const { state, execution, id, sources, input, intentDerivedInput, reviewed, journal } = receipt;
    const { afterUnverifiedSignIn } = receipt;
    const { runs } = state;
    const { projection } = state.session;

    // A live step's output is checked against the page it left: a value holding one of its
    // controls' labels was read collapsed.
    const capture =
      execution.target === "liveBrowser" ? state.context.observedCapture : undefined;
    const controlLabels =
      capture === undefined ? undefined : controlLabelsFromAriaSnapshot(capture);
    // An example's notice adds the advisory checks of the declared schemas.
    const outputChecks =
      result.output === undefined
        ? undefined
        : outputChecksNotice([
            ...lintOutput(result.output, {
              outputSchema: result.schemas.output,
              ...(controlLabels === undefined ? {} : { controlLabels }),
              samples: true,
            }),
            ...(execution.purpose === "example"
              ? lintSchemas(result.schemas.input, result.schemas.output)
              : []),
          ]);
    const evidence: ExecutionEvidence = {
      executionId: id,
      status: "completed",
      resultRef: `local:${id}`,
      effect: result.effect,
      ...(result.confirmation === undefined ? {} : { confirmation: result.confirmation }),
      ...(receipt.writePathRemaining === undefined
        ? {}
        : { writePathRemaining: receipt.writePathRemaining }),
      observations: yield* projection.json({
        output: result.output,
        stdout: result.stdout,
        stderr: result.stderr,
        inputSchema: result.schemas.input,
        outputSchema: result.schemas.output,
        ...(outputChecks === undefined ? {} : { outputChecks }),
      }),
      review: reviewFeedback(reviewed),
    };
    runs.set(id, {
      sources,
      entrypoint: execution.entrypoint,
      input,
      ...(intentDerivedInput === undefined ? {} : { intentDerivedInput }),
      output: result.output,
      ...(controlLabels === undefined ? {} : { controlLabels }),
      purpose: execution.purpose,
      journal: result,
      ...(reviewed.decision.action === undefined ? {} : { action: reviewed.decision.action }),
      ...(afterUnverifiedSignIn === undefined ? {} : { afterUnverifiedSignIn }),
    });
    yield* journal?.record(evidence) ?? Effect.void;
    return evidence;
  });

/** A step the host refuses before review: it runs nothing and leaves no history entry. */
const unsupported = (reason: string): ExecutionEvidence => ({
  executionId: randomUUID(),
  status: "unsupported",
  effect: "not_sent",
  observations: reason,
});

const authoredExecution = (
  state: MintState,
  execution: Exclude<Parameters<MintDependencies["reviewAndExecute"]>[0], { purpose: "command" }>,
  beforeDispatch: Parameters<MintDependencies["reviewAndExecute"]>[1],
  journal: Parameters<MintDependencies["reviewAndExecute"]>[2],
) =>
  Effect.gen(function* () {
    const { workspace, context, handles, start, mintAsk, writeSession } = state;
    const { browser, secrets } = state.session;
    const id = randomUUID();
    const sources = (yield* workspace.snapshot).filter(([path]) =>
      /^(src|explore|test|scratch)\//u.test(path),
    );
    const files = new Map(sources);
    const live = execution.target === "liveBrowser";
    // The step asks only what its entrypoint declares as a plain literal, read from its source,
    // never from what its running script reports.
    const entrypointSource = files.get(execution.entrypoint) ?? "";
    const refusal =
      secretHandleRefusal(handles, files, execution, context.siteOrigin) ??
      fileHandleRefusal(files, execution) ??
      fileReadbackRefusal(files, execution, state.fileHandles.files.length > 0) ??
      cardReadbackRefusal(files, execution, handles.issuedCard()) ??
      draftQuestionDeclarationFailure(execution.entrypoint, entrypointSource);
    if (refusal !== undefined) return unsupported(refusal);
    const selected = yield* stepInput(execution, {
      callerInput: context.input,
      sessionInput: writeSession.input,
    });
    const { input, mark } = selected;
    const sourceMap = new Map(sources.map(([path, text]) => [`operation/${path}`, text]));
    const reviewed = yield* context.review(
      {
        entrypoint: `operation/${execution.entrypoint}`,
        sources: sourceMap,
        input,
        currentExecution: {
          purpose: execution.purpose,
          target: execution.target,
          ...(mark === undefined ? {} : { input: mark }),
        },
        startsOnFreshPage: start.resets(execution),
        ...(execution.agentNote === undefined ? {} : { agentNote: execution.agentNote }),
        ...(execution.purpose !== "act" || execution.writePath === undefined
          ? {}
          : { writePath: execution.writePath }),
      },
      "not_sent",
    );
    // A code the site sent for the sign-in under way, which an explore typed on the site,
    // finished that sign-in: it counts as the proof, as a code the host fills does. Only a typing
    // call that delivered the code's value in a frame on the site or a configured sign-in origin
    // and completed counts, never the source text.
    const known = new Map(handles.snapshot().map(([handle, value]) => [handle, value]));
    const codes =
      execution.purpose === "explore" && live
        ? context.signInCodes().flatMap((handle) => known.get(handle) ?? [])
        : [];
    const signInOrigins = state.signInOrigins.all();
    // An exploration probe's own calls act with the action budget as their default timeout.
    const probing = (scriptBrowser: { readonly sessionId: string; readonly executeResponse: BrowserExecute }) =>
      execution.purpose === "explore" && live
        ? {
            sessionId: scriptBrowser.sessionId,
            executeResponse: ((code, timeoutSec) =>
              scriptBrowser.executeResponse(probeCallCode(code), timeoutSec)) satisfies BrowserExecute,
          }
        : scriptBrowser;
    const watch =
      codes.length === 0
        ? undefined
        : browser.watchTyping(codes, (url) => trustedUrl(context.siteOrigin, signInOrigins, url));
    yield* allowedOf(reviewed).pipe(
      Effect.flatMap((allowed) => beforeDispatch?.(allowed) ?? Effect.void),
    );
    // The open sign-in sent the login and no check verified it, so this live step may run signed
    // in, as an explore on the page that sign-in left does: a publication that rests on it, an
    // act step, an example or an explore, needs a recorded sign-in.
    const afterUnverifiedSignIn = live && start.submitted;
    if (execution.purpose === "act") {
      writeSession.started = true;
      // Guardian allowed the step on this input, so the session runs it from here on.
      if (selected.mark === "intent_derived") writeSession.input = selected.input;
      // Guardian allowed the path the step declared or revised, so the session runs it.
      if (execution.writePath !== undefined) writeSession.path = execution.writePath;
    }
    const questions = scriptQuestions(state, execution.entrypoint, input, sourceMap);
    const { scriptAsk } = questions;
    // The confirm popups the owner accepts during this execution, host-only.
    const accepted: ObservedConfirm[] = [];
    return yield* context.running(
      {
        purpose: execution.purpose,
        target: execution.target,
        ...(mark === "agent_chosen" ? { input: mark } : {}),
      },
      Effect.gen(function* () {
        yield* start.before(execution);
        /** Why the host could not sign in again while the script waited, the first time. */
        let signInFailure: SessionSignInFailed | undefined;
        // A live step places only the caller's files, by the handles its input holds. A download
        // it collects keeps only metadata and sha256, which the agent sees; no bytes are kept.
        const runFiles = live
          ? yield* makeRunFiles({
              hook: yield* makeLocalFileHook({ execute: browser.executeResponse }),
              execute: browser.executeResponse,
              siteOrigin: context.siteOrigin,
              resolve: state.fileHandles.resolve,
              ...(state.session.options.files?.limits === undefined
                ? {}
                : { limits: state.session.options.files.limits }),
            })
          : undefined;
        // A minter's page two runs with the cursor its page one returned, checked as a run's is.
        const listScope = () =>
          mintListScope(state.session, context.siteOrigin, execution.entrypoint);
        const admission = admitListCursor(input, listScope());
        const executed = yield* Effect.either(
          !admission.ok
            ? Effect.fail(refusedCursor(admission))
            : runLocalOperation({
                workspace,
                entrypoint: execution.entrypoint,
                // Only a live step receives a value; offline steps run the handle text as written.
                sources: live ? [...handles.fill(files, context.siteOrigin)] : sources,
                input,
                list: admission.list,
                browser: probing(
                  watch === undefined
                    ? browser
                    : { sessionId: browser.sessionId, executeResponse: watch.executeResponse },
                ),
                siteOrigin: context.siteOrigin,
                ...(siteDomain(context.siteOrigin) === undefined
                  ? {}
                  : { siteDomain: siteDomain(context.siteOrigin) ?? "" }),
                timeoutMs: execution.timeoutSeconds * 1000,
                mode: "run",
                target: live ? "browser" : "pureFiles",
                dispatchAtFirstCall: true,
                ask: scriptAsk,
                declaredQuestions: draftQuestionDeclarations(
                  execution.entrypoint,
                  entrypointSource,
                ),
                decideDialog: keepingAcceptedConfirms(
                  makeDialogDecider(mintAsk, secrets.redact),
                  accepted,
                  input,
                ),
                ...(live
                  ? {
                      signIn: state.sessionSignIn.hook((failure) => {
                        signInFailure ??= failure;
                      }),
                      cardFill: sessionCardFill(state.session, context.siteOrigin),
                    }
                  : {}),
                ...(runFiles === undefined ? {} : { files: runFiles }),
              }).pipe(
                Effect.map((result) => ({
                  ...result,
                  output: sealListOutput(result.output, input, listScope()).output,
                })),
              ),
        );
        if (watch !== undefined && watch.typed().size > 0) {
          start.typedCode();
          state.recorder.codeTyped();
          state.markers.signInStep();
        }
        if (live) {
          yield* context.observe;
          if (execution.purpose === "explore") state.markers.explored(context.observedUrl);
        }
        const act =
          execution.purpose === "act" ? actOutcome(executed, reviewed.decision.action) : undefined;
        // A write keeps the confirms its act steps accepted, for its runs to accept again.
        if (act !== undefined)
          recordConfirmSteps(
            writeSession,
            yield* acceptedConfirmsKept({ write: true, accepted, screen: secrets.assertAbsent }),
          );
        if (act !== undefined) writeSession.steps.push({ executionId: id, ...act.marks });
        // The marks of the session's recorded path not yet settled: until none is left, a
        // confirmation does not close the session.
        const pathLeft =
          act === undefined
            ? []
            : writePathRemaining(writeSession.path, sessionEnteredMarks(writeSession.steps));
        if (execution.purpose === "example" && executed._tag === "Right")
          context.setInputSchema(executed.right.schemas.input);
        const receipt = {
          state,
          execution,
          id,
          sources,
          input,
          ...(selected.mark === "intent_derived" ? { intentDerivedInput: selected.input } : {}),
          reviewed,
          journal,
          ...(act?.writeSession === undefined ? {} : { writeSession: act.writeSession }),
          ...(pathLeft.length === 0 ? {} : { writePathRemaining: pathLeft }),
          ...(afterUnverifiedSignIn ? { afterUnverifiedSignIn: true as const } : {}),
        };
        const evidence = yield* executed._tag === "Left"
          ? failedReceipt(receipt, executed.left, questions)
          : completedReceipt(receipt, executed.right);
        // A sign-in the host could not make while the script waited ends the request with why.
        if (signInFailure !== undefined) return yield* mintSessionSignInFailure(signInFailure);
        return evidence;
      }).pipe(Effect.scoped),
    );
  });
/**
 * A host card-fill step: the caller's card answers typed into the checkout's card fields on the
 * build's browser, once Guardian allowed the step and its screen, which hold handles only. It
 * clicks nothing; what it typed may reach the payment provider, so a step that typed is possible.
 */
const executeCardFill = (
  state: MintState,
  step: ExecutionRequest["cardFillStep"],
  beforeDispatch: BeforeDispatch,
) =>
  Effect.gen(function* () {
    const { context, handles } = state;
    const { browser, projection, signInTyping } = state.session;
    const id = randomUUID();
    if (step === undefined)
      return unsupported(
        "A card_fill execution names the card fields and their card handles in cardFillStep. Nothing was executed.",
      );
    const outcome = yield* runCardFill({
      step,
      handles,
      page: browser,
      keyboard: browser.keyboard,
      siteOrigin: context.siteOrigin,
      // Once the host typed into the page, a refusal names only the site's and the listed origins.
      judgedBeforeTyping: signInTyping.typed ? [...paymentFrameOrigins] : undefined,
      review: (source) =>
        screenMintText({ projection }, source).pipe(
          Effect.flatMap((text) =>
            context.review(
              {
                entrypoint: "operation/card-fill-step.json",
                sources: new Map([["operation/card-fill-step.json", text]]),
                input: {},
                currentExecution: { purpose: "card_fill", target: "liveBrowser" },
              },
              "not_sent",
            ),
          ),
          Effect.flatMap(allowedOf),
          Effect.flatMap((allowed) => beforeDispatch?.(allowed) ?? Effect.void),
        ),
      beforeTyping: () => Effect.void,
    });
    if (outcome.status !== "refused" && outcome.typed) signInTyping.typed = true;
    yield* context.observe;
    const typed = outcome.status !== "refused" && outcome.typed;
    return {
      executionId: id,
      status: outcome.status === "filled" ? ("completed" as const) : ("failed" as const),
      effect: typed || outcome.status === "uncertain" ? ("possible" as const) : ("not_sent" as const),
      observations: yield* projection.json(JSON.parse(outcome.observations)),
    };
  });

export const mintExecution =
  (state: MintState): MintDependencies["reviewAndExecute"] =>
  (execution, beforeDispatch, journal) => {
    const perform: Effect.Effect<ExecutionEvidence, Error> =
      execution.purpose === "command"
        ? executeCommand(state, execution, beforeDispatch)
        : execution.purpose === "card_fill"
          ? state.context.recorded(
              { purpose: "card_fill", target: "liveBrowser" },
              executeCardFill(state, execution.cardFillStep, beforeDispatch),
            )
          : execution.purpose === "authenticate" && execution.signInStep !== undefined
          ? state.context.recorded(
              { purpose: "authenticate", target: "liveBrowser" },
              executeAuthentication(
                state,
                execution.signInStep,
                execution.loginUrl,
                beforeDispatch,
              ),
            )
          : authoredExecution(state, execution, beforeDispatch, journal);
    return perform.pipe(Effect.mapError(mintError));
  };
