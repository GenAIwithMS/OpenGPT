import { randomUUID } from "node:crypto";
import { Clock, Effect, Either } from "effect";
import { LocalOperationFailure, runLocalOperation } from "../execution/local-operation.js";
import { defaultLiveTestCaseMs, MintFailure, type LiveTestHost } from "../mint/contracts.js";
import {
  batchReviewInput,
  runLiveTestCase,
  type LiveTestCaseRun,
  type LiveTestOutcome,
} from "../mint/live-tests.js";
import { InputRequestFailure } from "../runtime/input-request.js";
import { admitListCursor, sealListOutput } from "../runtime/list-cursor.js";
import { siteDomain } from "../runtime/same-site.js";
import type { MintState } from "./mint-state.js";
import { mintError } from "./errors.js";
import { mintListScope, refusedCursor } from "./list-cursors.js";

/** How long one case may run. */
const caseTimeoutMs = defaultLiveTestCaseMs;
const authoredSource = /^(?:src|explore|test|scratch)\//u;

/** What one local run of a case's input showed. Outputs stay in memory. */
const outcomeOf = (
  executed: Either.Either<{ readonly output: unknown }, unknown>,
): LiveTestOutcome => {
  if (Either.isRight(executed)) return { status: "completed", output: executed.right.output };
  const failure = executed.left;
  // The runner lost the child or could not start it: the host, not the tool, failed.
  if (!(failure instanceof LocalOperationFailure) || !failure.reported)
    return { status: "inconclusive", reason: "host" };
  if (failure.code === "Unavailable" || failure.code === "NoResponse")
    return { status: "inconclusive", reason: "asked" };
  if (failure.tag === "InvalidInput" || failure.code === "InvalidInput")
    return {
      status: "invalid_input",
      message: failure.message,
      ...(failure.refusal?.field === undefined ? {} : { field: failure.refusal.field }),
      ...(failure.refusal?.available === undefined
        ? {}
        : { available: failure.refusal.available }),
    };
  return {
    status: "failed",
    errorClass: failure.tag ?? failure.code ?? "Error",
    message: failure.message,
    ...(failure.frame === undefined ? {} : { frame: failure.frame }),
  };
};

/**
 * The local host's live tests: one Guardian review of the batch, whose input lists every case's
 * input marked `agent_chosen_batch`, then each case in turn on the build's own browser, its page
 * reset like any live test's first. It has one browser, so it runs one case at a time, each warm,
 * and none cold: the record shows that gap. It runs no
 * anti-bot handling, which is a hosted concern, and keeps no output past the batch.
 */
export const localLiveTests = (state: MintState): LiveTestHost => {
  const { workspace, context, start } = state;
  const { browser } = state.session;
  const sourcesNow = workspace.snapshot.pipe(
    Effect.map((snapshot) => snapshot.filter(([path]) => authoredSource.test(path))),
  );
  return {
    maxWorkers: 1,
    // Every case runs on the build's own browser, so a signed-in read's cases keep its session.
    signedInBatches: true,
    caseTimeoutMs,
    bindBatches: context.bindLiveTests,
    schemas: (entrypoint) =>
      Effect.gen(function* () {
        const result = yield* runLocalOperation({
          workspace,
          entrypoint,
          sources: yield* sourcesNow,
          input: {},
          browser,
          mode: "contract",
          target: "pureFiles",
        });
        return { input: result.schemas.input, output: result.schemas.output };
      }).pipe(Effect.mapError(mintError)),
    run: (batch) =>
      Effect.gen(function* () {
        const sources = yield* sourcesNow;
        const reviewed = yield* Effect.either(
          context.review(
            {
              entrypoint: `operation/${batch.entrypoint}`,
              sources: new Map(sources.map(([path, text]) => [`operation/${path}`, text])),
              input: batchReviewInput(batch.cases),
              currentExecution: {
                purpose: "test",
                target: "liveBrowser",
                input: "agent_chosen_batch",
              },
              startsOnFreshPage: true,
            },
            "not_sent",
          ),
        );
        if (Either.isLeft(reviewed)) {
          const failure = reviewed.left;
          if (failure instanceof MintFailure && failure.code === "ReviewDenied")
            return {
              status: "review_denied" as const,
              ...(failure.review?.reviewId === undefined
                ? {}
                : { reviewId: failure.review.reviewId }),
              rationale: failure.review?.rationale ?? "Guardian denied the batch.",
            };
          return yield* Effect.fail(failure);
        }
        const domain = siteDomain(context.siteOrigin);
        // A case's cursor is checked and its output's next cursor signed as an example step's
        // are, so a next-page case's page two runs from the position its page one returned.
        const listScope = () => mintListScope(state.session, context.siteOrigin, batch.entrypoint);
        const runInput = (input: Readonly<Record<string, unknown>>) =>
          Effect.gen(function* () {
            const admission = admitListCursor(input, listScope());
            if (!admission.ok) return outcomeOf(Either.left(refusedCursor(admission)));
            const reset = yield* Effect.either(
              start.before({ purpose: "test", target: "liveBrowser" }),
            );
            if (Either.isLeft(reset)) return { status: "inconclusive", reason: "host" } as const;
            const executed = yield* Effect.either(
              runLocalOperation({
                workspace,
                entrypoint: batch.entrypoint,
                sources,
                input,
                list: admission.list,
                browser,
                siteOrigin: context.siteOrigin,
                ...(domain === undefined ? {} : { siteDomain: domain }),
                timeoutMs: caseTimeoutMs,
                mode: "run",
                target: "browser",
                dispatchAtFirstCall: true,
                // A test asks nobody: a case whose script asks a question is not judged.
                ask: () => Effect.fail(new InputRequestFailure({ code: "Unavailable" })),
                signIn: state.sessionSignIn.hook(() => undefined),
              }).pipe(
                Effect.map((result) => ({
                  ...result,
                  output: sealListOutput(result.output, input, listScope()).output,
                })),
              ),
            );
            return outcomeOf(executed);
          });
        const cases: LiveTestCaseRun[] = [];
        for (const testCase of batch.cases) {
          const now = yield* Clock.currentTimeMillis;
          if (now + caseTimeoutMs > batch.deadlineAt) {
            cases.push({
              id: testCase.id,
              outcome: { status: "inconclusive", reason: "deadline" },
              durationMs: 0,
            });
            continue;
          }
          // One browser, which keeps the site data earlier steps left: every case runs warm.
          cases.push({
            ...(yield* runLiveTestCase(testCase, runInput)),
            lane: 0,
            start: "warm" as const,
          });
        }
        // One history entry for the batch.
        yield* context.recorded(
          { purpose: "test", target: "liveBrowser", input: "agent_chosen_batch" },
          Effect.succeed({
            executionId: randomUUID(),
            status: "completed" as const,
            effect: "possible" as const,
            observations: { liveTestCases: cases.length },
          }),
        );
        return {
          status: "ran" as const,
          reviewId: reviewed.right.reviewId,
          cases,
          lanes: 1,
        };
      }).pipe(Effect.mapError(mintError)),
  };
};
