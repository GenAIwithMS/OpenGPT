export { portableJobSession } from "./portable-mint.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import type { SandboxSession } from "@openai/agents/sandbox";
import { Cause, Effect, Exit } from "effect";
import type { Clock } from "effect";
import { MintFailure, MintServices } from "../../src/mint/contracts.js";
import type {
  AgentInputRequest,
  AllowedExecution,
  MintDependencies,
  MintTurn,
} from "../../src/mint/contracts.js";
import { runMint } from "../../src/mint/harness.js";
import type { makeOpenAIMinter as OpenAIMinterFactory } from "../../src/mint/openai.js";
import { Deadline } from "../../src/runtime/deadline.js";
import { portableMintProjection } from "./portable-mint.js";

type WorkspaceFactory<W extends SandboxSession & { close: () => Promise<void> }> = (
  entries: Readonly<Record<string, string>>,
) => W | Promise<W>;
/**
 * The allow a scripted host's fence passes: the label a Guardian review of a typical step of
 * this purpose gives. An act step writes, an authenticate step signs in and the rest read.
 */
export const fixtureAllow = (purpose: string): AllowedExecution => ({
  reviewId: `review_${purpose}`,
  action: purpose === "act" ? "write" : purpose === "authenticate" ? "authentication" : "read",
});
/** A Guardian read allow, for scripted steps whose label a test does not depend on. */
export const readAllow: AllowedExecution = { reviewId: "review_fixture", action: "read" };
const unanswered = (possibleCommit = false) =>
  new MintFailure({ code: "Unavailable", noResponse: { possibleCommit } });
export const makeMintHarnessFixture = <W extends SandboxSession & { close: () => Promise<void> }>(
  cleanup: (() => Promise<void>)[],
  request: unknown,
  openWorkspace: WorkspaceFactory<W>,
) => {
  return async function fixture(
    run: (turn: MintTurn) => Effect.Effect<void, MintFailure>,
    overrides: Partial<MintDependencies> = {},
  ) {
    const directory = await mkdtemp(join(tmpdir(), "opengpt-mint-unit-"));
    const workspace = await openWorkspace({
      "src/tool.ts": "export const privateExample = 'secret-canary';",
    });
    cleanup.push(async () => {
      await workspace.close();
      await rm(directory, { recursive: true, force: true });
    });
    const seen: unknown[] = [];
    let defect: unknown;
    const scriptedDependencies: MintDependencies = {
      workspace,
      projection: portableMintProjection(["secret-canary"]),
      instructions: "Synthetic instructions.",
      skills: [],
      model: {
        run: (turn) =>
          run(turn).pipe(
            Effect.as({ history: [] }),
            Effect.catchAllDefect((error) => {
              defect = error;
              return Effect.die(error);
            }),
          ),
      },
      reviewAndExecute: (input) =>
        Effect.sync(() => {
          seen.push(input);
          return {
            executionId: "execution_one",
            status: "completed",
            effect: "verified",
            resultRef: "private-result-ref",
            observations: { result: "secret-canary" },
          };
        }),
      preflight: () => Effect.succeed({ supported: true }),
      reviewQuestion: () =>
        Effect.succeed({
          outcome: "allow_business" as const,
          rationale: "Synthetic question is an ordinary business choice.",
        }),
      claimExample: Effect.void,
      authorizeResidual: Effect.fail(new MintFailure({ code: "ReconciliationRequired" })),
      publish: () => Effect.succeed({ publicationRef: "published-revision", diagnostics: [] }),
      // The caller never answers unless a test says otherwise: the minter hears no_answer, and a
      // question that decides what the build may do, or any in a write repair, ends it.
      askInput: () => Effect.fail(unanswered()),
      ...overrides,
    };
    // Scripted adapter outcomes stand in for review plus execution. A denied initial
    // review never enters the dispatch boundary; all other outcomes do.
    const scripted = scriptedDependencies.reviewAndExecute;
    const dependencies: MintDependencies = {
      ...scriptedDependencies,
      reviewAndExecute: (input, beforeDispatch = () => Effect.void) =>
        Effect.gen(function* () {
          let crossed = false;
          const dispatch = (allowed: AllowedExecution) =>
            beforeDispatch(allowed).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  crossed = true;
                }),
              ),
            );
          const result = yield* Effect.exit(scripted(input, dispatch));
          const rejected =
            Exit.isFailure(result) &&
            Cause.isFailType(result.cause) &&
            (result.cause.error.code === "ReviewDenied" ||
              (result.cause.error.code === "ReviewUnavailable" &&
                result.cause.error.reviewDispatch === "not_sent"));
          if (!rejected && !crossed) yield* dispatch(fixtureAllow(input.purpose));
          return yield* result;
        }),
    };
    return {
      dependencies,
      seen,
      directory,
      workspace,
      run: async (input: unknown = request) => {
        const result = await Effect.runPromise(
          runMint(input).pipe(Effect.provideService(MintServices, dependencies)),
        );
        if (defect !== undefined) throw defect;
        return result;
      },
    };
  };
};
export const makeMintContinuationFixture = <
  W extends SandboxSession & { close: () => Promise<void> },
>(
  cleanups: (() => Promise<void>)[],
  openWorkspace: WorkspaceFactory<W>,
  makeOpenAIMinter: typeof OpenAIMinterFactory,
) => {
  return async function fixture(
    response: (request: ModelRequest, index: number) => Promise<ModelResponse> | ModelResponse,
    overrides: Partial<MintDependencies> = {},
    request: {
      readonly effect?: "read" | "write" | "ask";
      readonly siteOrigin?: string;
      readonly mode?: "mint" | "maintenance";
      readonly observations?: unknown;
      readonly intent?: string;
      readonly businessInput?: unknown;
    } = {},
    limits?: Parameters<typeof makeOpenAIMinter>[2],
  ) {
    const directory = await mkdtemp(join(tmpdir(), "opengpt-model-continuation-"));
    const workspace = await openWorkspace({ "src/tool.ts": "export default {};" });

    cleanups.push(async () => {
      await workspace.close();

      await rm(directory, { recursive: true, force: true });
    });
    const requests: ModelRequest[] = [];
    let executed = 0;
    let published = 0;
    const asked: AgentInputRequest[] = [];
    const dependencies: MintDependencies = {
      workspace,
      projection: portableMintProjection(),
      instructions: "Synthetic instructions.",
      skills: [
        {
          name: "core",
          description: "Synthetic test contract",
          content: "Publish through finish_build or request legitimate missing input.",
        },
      ],
      deadline: Deadline.after(60_000),
      model: makeOpenAIMinter(
        {
          getModel: () => ({
            getResponse: async (request) => {
              requests.push(request);
              return response(request, requests.length - 1);
            },
            getStreamedResponse: () => {
              throw new Error("Unused stream");
            },
          }),
        },
        "medium",
        limits,
      ),
      preflight: () => Effect.succeed({ supported: true }),
      reviewQuestion: () =>
        Effect.succeed({
          outcome: "allow_business" as const,
          rationale: "Synthetic question is an ordinary business choice.",
        }),
      claimExample: Effect.void,
      authorizeResidual: Effect.fail(
        new MintFailure({ code: "ReconciliationRequired", reconciliationStage: "intent_input" }),
      ),
      reviewAndExecute: (input, beforeDispatch = () => Effect.void) =>
        beforeDispatch(fixtureAllow(input.purpose)).pipe(
          Effect.zipRight(
            Effect.sync(() => {
              executed++;
              return {
                executionId: "execution_one",
                status: "completed" as const,
                effect: "verified" as const,
                resultRef: "protected_result",
                observations: { value: "public" },
              };
            }),
          ),
        ),
      publish: () =>
        Effect.sync(() => {
          published++;
          return { publicationRef: "published_revision", diagnostics: [] };
        }),
      // Unanswered unless a test answers: the minter hears no_answer and goes on.
      askInput: (input) =>
        Effect.sync(() => {
          asked.push(input);
        }).pipe(
          Effect.zipRight(
            Effect.fail(
              new MintFailure({ code: "Unavailable", noResponse: { possibleCommit: false } }),
            ),
          ),
        ),
      ...overrides,
    };
    return {
      workspace,
      requests,
      counts: () => ({ executed, published, asked: asked.length }),
      asked,
      run: (signal?: AbortSignal, clock?: Clock.Clock) =>
        Effect.runPromise(
          runMint({
            mode: "mint",
            intent: "Read public data",
            businessInput: {},
            observations: [],
            ...request,
          }).pipe(
            Effect.provideService(MintServices, dependencies),
            clock === undefined ? (effect) => effect : Effect.withClock(clock),
          ),
          { signal },
        ),
    };
  };
};
