import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { questionForReview } from "../guardian/question.js";
import {
  MintFailure,
  MintServices,
  type ExecutionRequest,
  type MintDependencies,
  type PublicationDecisionLog,
} from "../mint/contracts.js";
import { runMint } from "../mint/harness.js";
import { mintSourceSyntaxFailure } from "../mint/operation-source.js";
import { makeOpenAIMinter } from "../mint/openai.js";
import { makeOpenAIOutcomeReviewer } from "../mint/outcome-review-openai.js";
import {
  exampleInputRefusal,
  preflightTestInput,
  writeSessionBoundary,
} from "../mint/step-checks.js";
import { sessionEnteredMarks, writePathRefusal } from "../mint/write-session.js";
import type { BrowserEngineRequest } from "./contracts.js";
import type { StandaloneSession } from "./session.js";
import type { RequestContext } from "./request-context.js";
import { mintState, type MintState } from "./mint-state.js";
import { mintExecution } from "./mint-execution.js";
import { mintPublication } from "./mint-publication.js";
import { localLiveTests } from "./mint-live-tests.js";
import { askError, mintError } from "./errors.js";
import { memoryPublicationDecisions } from "./publication-decisions.js";
import { forgetScriptAnswers } from "../mint/script-answer-reuse.js";
import type { FileHandles } from "../mint/file-handles.js";
import { secretKindsOf } from "../mint/secret-handles.js";
/**
 * Steps the local host refuses before review. It keeps no write maintenance, so it has no
 * possible write to inspect or finish. And once a write session started, a sign-in runs only as
 * a signInStep the host fills: an authenticate step without one would run the agent's own source
 * on the site outside the session's act steps.
 */
const localStepRefusal = (
  execution: ExecutionRequest,
  writeSessionStarted: boolean,
): { readonly supported: false; readonly reason: string } | undefined =>
  execution.purpose === "inspect" || execution.purpose === "residual"
    ? {
        supported: false,
        reason: `${execution.purpose} is for a write maintenance recovering a possible write; this build has none to recover.`,
      }
    : writeSessionStarted &&
        execution.purpose === "authenticate" &&
        execution.target === "liveBrowser" &&
        execution.signInStep === undefined
      ? {
          supported: false,
          reason:
            "This write session already started, so it signs in only through a signInStep the host fills: an authenticate step without one would run your own source on the site outside the session's act steps. Nothing was executed.",
        }
      : undefined;
const mintDependencies = (state: MintState, publicationDecisions: PublicationDecisionLog) => {
  const { workspace, authoring, deadline, context, mintAsk, handles } = state;
  const { projection, options } = state.session;
  const dependencies: MintDependencies = {
    workspace: workspace.session,
    // Read-only, like the host's other captures, and never staged as source.
    saveResult: (path, text) => workspace.install(path, text).pipe(Effect.mapError(mintError)),
    instructions: authoring.instructions,
    skills: authoring.skills,
    projection,
    model: makeOpenAIMinter(options.minterProvider),
    deadline,
    autofillSignIn: true,
    requestLogin: () => Effect.succeed("inspect"),
    reviewQuestion: (candidate, facts) =>
      Effect.gen(function* () {
        const pendingQuestion = yield* questionForReview(
          candidate,
          { credentialsAvailable: false, ...facts },
          projection.text,
        );
        const result = yield* context.reviewQuestion(
          { entrypoint: "question", sources: new Map(), input: context.input },
          pendingQuestion,
        );
        return { ...result.decision, reviewId: result.reviewId };
      }).pipe(Effect.mapError(mintError)),
    askInput: (candidate, ids) =>
      mintAsk({
        ...candidate,
        id: ids?.requestId ?? randomUUID(),
        source: "agent",
      }).pipe(
        Effect.tap((answers) =>
          context.answered(
            { ...candidate, id: ids?.requestId ?? "question", source: "agent" },
            answers,
          ),
        ),
        // The owner's newer answer to a prompt a script asked replaces the one it kept.
        Effect.tap(() =>
          Effect.forEach(candidate.questions, (question) => projection.text(question.prompt)).pipe(
            Effect.map((prompts) => {
              state.scriptAnswers.kept = forgetScriptAnswers(state.scriptAnswers.kept, prompts);
            }),
          ),
        ),
        Effect.map((answers) => handles.issue(answers, secretKindsOf(candidate.questions))),
        Effect.tap((issued) => Effect.sync(() => context.askedByAgent(candidate, issued))),
        Effect.mapError(askError),
      ),
    recordBuildEffect: (effect) => Effect.sync(() => context.setBuildEffect(effect)),
    entryNavigation: context.entryNavigation,
    reviewTaskUpdate: (candidate) =>
      context.reviewTaskUpdate(candidate).pipe(
        Effect.map((result) => ({ ...result.decision, reviewId: result.reviewId })),
        Effect.mapError(mintError),
      ),
    applyTaskUpdate: (application) =>
      context.applyTaskUpdate(application, (siteOrigin) => state.rebindSite(siteOrigin)).pipe(
        // An answer the owner gave for the task as it was never stands for the updated task.
        Effect.tap(() =>
          Effect.sync(() => {
            state.scriptAnswers.kept = [];
          }),
        ),
        Effect.mapError(mintError),
      ),
    repeatableRead: context.repeatableRead(),
    // A repeatable read's example claims nothing, so it may run again.
    claimExample: Effect.suspend(() =>
      context.repeatableRead()
        ? Effect.void
        : context.claimed
          ? Effect.fail(new MintFailure({ code: "ScopeDenied" }))
          : Effect.sync(context.claim),
    ),
    authorizeResidual: Effect.fail(new MintFailure({ code: "ScopeDenied" })),
    preflight: (execution) =>
      Effect.gen(function* () {
        // An entrypoint that does not parse is refused before review, as it could never load. A
        // sign-in step runs the host's own code, and a missing entrypoint fails when it runs.
        if (execution.purpose !== "authenticate") {
          const source = new Map(yield* workspace.snapshot).get(execution.entrypoint);
          const syntax =
            source === undefined
              ? undefined
              : mintSourceSyntaxFailure(source, execution.entrypoint);
          if (syntax !== undefined) return { supported: false as const, reason: syntax };
        }
        if (execution.target !== "pureFiles" && execution.target !== "liveBrowser")
          return {
            supported: false as const,
            reason: "Standalone execution supports pureFiles and liveBrowser.",
          };
        const { buildEffect } = context;
        const refusal =
          localStepRefusal(execution, state.writeSession.started) ??
          preflightTestInput(execution, {
            buildEffect,
            signedIn: context.signedIn,
            signedInTests: true,
          }) ??
          exampleInputRefusal(execution, {
            buildEffect,
            callerInput: context.input,
            writeSession: state.writeSession,
          });
        if (refusal !== undefined) return refusal;
        const boundary =
          writeSessionBoundary(execution, {
            buildEffect,
            writeSessionStarted: state.writeSession.started,
          }) ??
          (buildEffect === "write"
            ? writePathRefusal(execution, {
                started: state.writeSession.started,
                path: state.writeSession.path,
                enteredMarks: sessionEnteredMarks(state.writeSession.steps),
              })
            : undefined);
        return boundary === undefined
          ? { supported: true as const }
          : { supported: false as const, reason: boundary };
      }).pipe(Effect.mapError(mintError)),
    reviewAndExecute: mintExecution(state),
    checkSignedInMarker: (marker) => state.markers.check(marker),
    signInRefillRefused: () => state.recorder.passwordRefillRefused(),
    signInDestinationRefused: () => state.recorder.destinationRefused(),
    liveTests: localLiveTests(state),
    publish: mintPublication(state),
    // The local host keeps no recovery checkpoint; its write completion reads the assessments.
    outcomeReview: {
      model: makeOpenAIOutcomeReviewer(
        options.outcomeReviewerProvider === undefined
          ? {}
          : { modelProvider: options.outcomeReviewerProvider },
      ),
      save: () => Effect.void,
      bindWrites: context.bindWrites,
      recordAssessment: (assessment) =>
        Effect.sync(() => {
          state.assessments.set(assessment.executionId, assessment);
        }),
    },
    publicationDecisions,
  };
  return dependencies;
};
export const mintRequest = (
  session: StandaloneSession,
  context: RequestContext,
  request: BrowserEngineRequest,
  fileHandles: FileHandles,
) =>
  Effect.gen(function* () {
    const state = yield* mintState(session, context, request, fileHandles);
    // The request's runs share its publication decisions.
    const publicationDecisions = memoryPublicationDecisions();
    const mintRequest = {
      mode: "mint",
      intent: request.intent,
      businessInput: request.input ?? {},
      observations: context.observations,
      siteOrigin: context.siteOrigin,
      effect: request.effect ?? "ask",
      // The caller's files, as handles with their metadata; the input holds the handles.
      ...(fileHandles.files.length === 0 ? {} : { files: fileHandles.files }),
    } as const;
    // Each run reads the build's read/write state as it stands when the run starts.
    if (context.buildEffect === undefined) {
      const asked = yield* runMint(mintRequest).pipe(
        Effect.provideService(MintServices, mintDependencies(state, publicationDecisions)),
      );
      if (context.buildEffect === undefined) return asked;
    }
    // The request's page loads before the build's run, never during the effect question, so the
    // run's first request says how it loaded and a first step that does not reset starts there.
    yield* state.start.enter;
    const outcome = yield* runMint({ ...mintRequest, effect: context.buildEffect }).pipe(
      Effect.provideService(MintServices, mintDependencies(state, publicationDecisions)),
    );
    return outcome;
  });
