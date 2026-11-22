import type { Agent, AgentInputItem, AgentOutputType } from "@openai/agents";
import { RunContext, RunState } from "@openai/agents";
import { Effect, Schema } from "effect";
import type { ReviewTurn } from "./review.js";
import { separateSuffixes, siteDomain } from "../runtime/same-site.js";
import { paymentFrameOrigins } from "../destinations/payment-frames.js";
import { ownerNamedOrigins } from "./owner-named-origins.js";
import { guardianModel } from "./model.js";
import type { GuardianReasoningEffort } from "./model.js";
import { guardianCompaction } from "./session.js";
import { configurationUpdate } from "../models/cached-instructions.js";
import { withReasoningContinuity } from "../models/reasoning-settings.js";
import { reviewKindOf, reviewOutcomesOf } from "./review-layout.js";
import { cutToLimit } from "./review-contracts.js";

/** The most characters of the agent's note on a step that an execution review reads. */
export const agentNoteLimit = 500;

/** JSON.stringify leaves an undefined key out, so an empty list never reaches the model. */
const absentWhenEmpty = <T>(list: readonly T[]) => (list.length === 0 ? undefined : list);

/**
 * The per-review user message. Everything that differs between review kinds is here, its policy
 * included, never in the instructions, tools or output format, so switching kinds keeps the
 * conversation cached.
 */
export const guardianReviewInput = (
  turn: ReviewTurn,
  policy: string,
  extra: Readonly<Record<string, unknown>> = {},
) =>
  JSON.stringify({
    trusted_review: {
      kind: turn.pending.hostReview?.kind ?? reviewKindOf(turn.pending),
      policy,
      // The outcomes the host accepts from this review, the same list it checks the decision with.
      outcomes: reviewOutcomesOf(turn.pending),
      // Marks the exchange so later readable records withhold it, even after a takeover.
      ...(turn.pending.hostReview?.private === true ? { private: true } : {}),
      ...(turn.pending.hostWrapper === undefined ? {} : { hostWrapper: turn.pending.hostWrapper }),
      ...(turn.sources?.unchangedSources === undefined
        ? {}
        : { unchangedSources: turn.sources.unchangedSources }),
    },
    // The intent is in the build's own instructions (trusted_request), the same for every review.
    trusted_authority: {
      allowedOrigins: turn.pending.allowedOrigins,
      // Derived from the screened origins, so no new text reaches the model.
      allowedSites: turn.pending.allowedOrigins.flatMap((origin) => {
        const registrableDomain = siteDomain(origin);
        if (registrableDomain === undefined) return [];
        // The host's own private suffixes below the site: the policy's "a host the list gives a
        // registrable domain of its own" covers each host under one. Named only when there is
        // one, so the input is unchanged without.
        const addedPrivateSuffixes = separateSuffixes(registrableDomain);
        return [
          {
            scheme: "https",
            registrableDomain,
            ...(addedPrivateSuffixes.length === 0 ? {} : { addedPrivateSuffixes }),
          },
        ];
      }),
      allowedEffects: turn.pending.allowedEffects,
      answeredQuestions: absentWhenEmpty(
        (turn.pending.answeredQuestions ?? []).map(({ id, question, answer, other, note }) => ({
          ...(id === undefined ? {} : { id }),
          question,
          answer,
          ...(other === undefined ? {} : { other }),
          ...(note === undefined ? {} : { note }),
        })),
      ),
      ownerNamedOrigins: absentWhenEmpty(ownerNamedOrigins(turn.pending)),
      taskUpdates: absentWhenEmpty(turn.pending.taskUpdates ?? []),
      // Guardian's own finding that the owner confirmed exactly this step.
      ...(turn.sources?.ownerConfirmedStep === undefined
        ? {}
        : { ownerConfirmedStep: turn.sources.ownerConfirmedStep }),
      // The exact frame origins a host card-fill step may type a card answer into.
      ...(reviewKindOf(turn.pending) === "execution" ? { paymentFrameOrigins } : {}),
    },
    ...extra,
    // A later publication round: the prior round's decision and what changed since it.
    ...(turn.sources?.publicationDelta === undefined
      ? {}
      : { publication_delta: turn.sources.publicationDelta }),
    ...(turn.pending.questionCandidate === undefined
      ? {}
      : {
          question_review: {
            request: {
              questions: turn.pending.questionCandidate.questions,
              ...(turn.pending.questionCandidate.notice === undefined
                ? {}
                : { notice: turn.pending.questionCandidate.notice }),
            },
            credentialsAvailable: turn.pending.questionCandidate.credentialsAvailable,
            ...(turn.pending.questionCandidate.blockedOutcome === true
              ? { blockedOutcome: true }
              : {}),
            ...(turn.pending.questionCandidate.publicationDecisions === undefined
              ? {}
              : { publicationDecisions: turn.pending.questionCandidate.publicationDecisions }),
            ...(turn.pending.questionCandidate.decisionLedger === undefined
              ? {}
              : { decisionLedger: turn.pending.questionCandidate.decisionLedger }),
            ...(turn.pending.questionCandidate.scriptAsk === true ? { scriptAsk: true } : {}),
            ...(turn.pending.questionCandidate.buildEffect === undefined
              ? {}
              : { buildEffect: turn.pending.questionCandidate.buildEffect }),
            // The confirm questions that ask the owner to confirm a step a review held.
            ...(turn.sources?.heldStepQuestions === undefined
              ? {}
              : { confirmsHeldSteps: turn.sources.heldStepQuestions }),
          },
        }),
    ...(turn.pending.updateCandidate === undefined
      ? {}
      : { update_review: turn.pending.updateCandidate }),
    ...(turn.pending.hostReview === undefined
      ? {}
      : { host_review: turn.pending.hostReview.evidence }),
    submitted_call: {
      entrypoint: turn.pending.entrypoint,
      input: turn.pending.screenedInput,
      // The agent's own words about the step: untrusted call data, like the input beside it.
      ...(turn.pending.agentNote === undefined || reviewKindOf(turn.pending) !== "execution"
        ? {}
        : { agentNote: cutToLimit(turn.pending.agentNote, agentNoteLimit) }),
      // The write path the step declares or revises: untrusted call data, like the note.
      ...(turn.pending.writePath === undefined || reviewKindOf(turn.pending) !== "execution"
        ? {}
        : { writePath: turn.pending.writePath }),
      ...(turn.sources?.entrypoint === undefined
        ? {}
        : { entrypointSource: turn.sources.entrypoint }),
    },
    ...(turn.pending.mintContext === undefined
      ? {}
      : { trusted_execution_context: turn.pending.mintContext }),
    untrusted_observations: turn.pending.screenedObservations,
    untrusted_step_results: turn.pending.stepResults,
  });

/**
 * One review's model settings, the same for every review. The request's reasoning effort can
 * change the provider's hidden instructions, and with them the whole cached prefix, so it stays
 * the same: a review at another effort says so with a configuration update in its input (see
 * `guardianReviewState`). Only a session request that must leave its compaction to the provider
 * carries the effort as its own instead (see `makeGuardianSession`). Every request caches
 * implicitly after the instructions' own breakpoint, so each call reads the conversation the call
 * before it wrote: the earlier reviews of a session, and a review's own earlier turns, with or
 * without one. `promptCacheKey` is the host's key for the provider's cache accounting, the same
 * on every request.
 */
export const guardianReviewSettings = (session: boolean, promptCacheKey?: string) =>
  withReasoningContinuity({
    ...guardianModel.modelSettings,
    reasoning: {
      ...guardianModel.modelSettings.reasoning,
      ...(session ? { context: "all_turns" as const } : {}),
    },
    promptCacheOptions: { mode: "implicit" },
    parallelToolCalls: true,
    providerData: {
      ...(session ? guardianCompaction().samplingParams({ model: guardianModel.model }) : {}),
      ...(promptCacheKey === undefined ? {} : { prompt_cache_key: promptCacheKey }),
    },
  });

/**
 * The review's starting state. `effort`, when the review runs at another reasoning effort than
 * the conversation does, adds a configuration update before the request.
 */
export const guardianReviewState = <TContext, TOutput extends AgentOutputType>(
  turn: ReviewTurn,
  input: string,
  agent: Agent<TContext, TOutput>,
  maxTurns = 12,
  effort?: GuardianReasoningEffort,
) =>
  Effect.gen(function* () {
    const continuedInput: string | AgentInputItem[] = turn.session
      ? yield* turn.session.input(input, false, effort)
      : effort === undefined
        ? input
        : [configurationUpdate(effort), { role: "user", type: "message", content: input }];
    return new RunState(new RunContext<TContext>(), continuedInput, agent, maxTurns);
  });

/** The same review continued with the host's follow-up after the reviewer's last output. */
export const guardianFollowUpState = <TContext, TOutput extends AgentOutputType>(
  turn: ReviewTurn,
  history: readonly AgentInputItem[],
  followUp: string,
  agent: Agent<TContext, TOutput>,
  maxTurns = 12,
) =>
  Effect.gen(function* () {
    const continuedInput = turn.session
      ? yield* turn.session.input(followUp, true)
      : [...history, { role: "user" as const, type: "message" as const, content: followUp }];
    return new RunState(new RunContext<TContext>(), continuedInput, agent, maxTurns);
  });

/** The most files one `read_source` call names in `paths`. */
export const sourceReadMaxFiles = 10;
/** One file's read: a chunk at an offset, or with `match` the slices around each occurrence. */
export const SourceRead = Schema.Struct({
  path: Schema.String,
  offset: Schema.Int.pipe(Schema.nonNegative()),
  /** A word or phrase to find: the result is the slices around each match, not a chunk. */
  match: Schema.optional(Schema.NullOr(Schema.String)),
});
export type SourceRead = typeof SourceRead.Type;
/**
 * One `read_source` call: a single file in `path`, `offset` and `match`, or several in `paths`
 * with the single-file fields null. A call recorded before `read_source` took several files has
 * no `paths`, and may have no `match`.
 */
export const SourceInput = Schema.Struct({
  path: Schema.NullOr(Schema.String),
  offset: Schema.optional(Schema.NullOr(Schema.Int.pipe(Schema.nonNegative()))),
  match: Schema.optional(Schema.NullOr(Schema.String)),
  paths: Schema.optional(
    Schema.NullOr(
      Schema.Array(SourceRead).pipe(Schema.minItems(1), Schema.maxItems(sourceReadMaxFiles)),
    ),
  ),
});
/**
 * The files one `read_source` call reads, in order, and whether it listed them in `paths`, or what
 * to change in a call the host cannot read: a message for the model, since nothing was read.
 */
export const sourceReadsOf = (
  input: unknown,
):
  | { readonly files: readonly SourceRead[]; readonly several: boolean }
  | { readonly problem: string } => {
  const decoded = Schema.decodeUnknownEither(SourceInput)(input);
  if (decoded._tag === "Left") {
    const paths: unknown =
      typeof input === "object" && input !== null ? Reflect.get(input, "paths") : undefined;
    return {
      problem:
        Array.isArray(paths) && paths.length > sourceReadMaxFiles
          ? `Nothing was read: read_source reads at most ${sourceReadMaxFiles} files per call. Split paths into several calls of up to ${sourceReadMaxFiles} files each.`
          : `Nothing was read: read_source takes path, a non-negative integer offset and match or null for one file, or paths listing 1 to ${sourceReadMaxFiles} such files with path, offset and match null. Correct the arguments and call it again.`,
    };
  }
  const args = decoded.right;
  const several = args.paths ?? null;
  if (several === null)
    return args.path === null
      ? {
          problem: `Nothing was read: name a file in path, or list up to ${sourceReadMaxFiles} files in paths.`,
        }
      : {
          files: [{ path: args.path, offset: args.offset ?? 0, match: args.match ?? null }],
          several: false,
        };
  return args.path !== null || (args.offset ?? null) !== null || (args.match ?? null) !== null
    ? {
        problem:
          "Nothing was read: read one file with path, offset and match, or several with paths and path, offset and match null, not both in one call.",
      }
    : { files: several, several: true };
};
