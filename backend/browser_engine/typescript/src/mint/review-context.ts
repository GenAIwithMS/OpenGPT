import { DateTime, Effect } from "effect";
import type {
  GuardianDecision,
  PendingExecution,
  ReviewedLiveTestBatch,
  ReviewFailure,
} from "../guardian/review.js";
import { failureDetailMetadata } from "../runtime/failure-detail.js";
import { MintFailure, type WritePath } from "./contracts.js";
import { executedSourceClosure } from "./operation-source.js";
import type { MintProjection } from "./projection.js";
import { screenMintText } from "./workspace.js";
import type { WriteOutcome } from "./outcome-review-contracts.js";

/**
 * What a host tells Guardian about one mint review beyond the submitted call: the step's own
 * authority, the files it loads, the page the build last saw, recent step results and the
 * build's dated observations. Each host supplies its own facts through `MintReviewHost`; the
 * rules that turn those facts into the review's context live here, so every host applies them
 * the same way.
 */

export type MintReviewContext = NonNullable<PendingExecution["mintContext"]>;
export type CurrentExecution = NonNullable<MintReviewContext["currentExecution"]>;
export type ExecutionEntry = MintReviewContext["executions"][number];
export type ObservedPage = NonNullable<MintReviewContext["currentPage"]>;
export type StepResult = NonNullable<PendingExecution["stepResults"]>[number];

/** The facts a host knows about its build at the moment of a review. */
export interface MintReviewHost {
  /** Whether this build may run its read example again; see `repeatableReadFor`. */
  readonly repeatableRead: () => boolean;
  readonly browser: () => MintReviewContext["browser"];
  /** Where the host last observed the active browser's page, with its readable capture. */
  readonly observedPage: () => ObservedPage | undefined;
  /** This attempt's executions so far, a running one included. */
  readonly executions: () => readonly ExecutionEntry[];
  /** The input schema the latest example or contract run declared; undefined before either. */
  readonly inputSchema: () => unknown;
  /**
   * The handles answering code questions the agent asked during this attempt's unverified
   * sign-in; empty once a sign-in is verified. Only execution reviews carry them.
   */
  readonly signInCodes: () => readonly string[];
  /** This build's tracked writes and their newest assessments; only execution reviews carry them. */
  readonly writes?: () => readonly WriteOutcome[];
  /**
   * This attempt's latest judged live test batches (`LiveTestHost.bindBatches`), undefined until
   * the harness binds them; only execution reviews carry them.
   */
  readonly liveTests?: () => Effect.Effect<readonly ReviewedLiveTestBatch[]> | undefined;
  /** A write build's recorded write path, once an allowed act step that carried one dispatched. */
  readonly writePath?: () => WritePath | undefined;
}

/** A write path as a review reads it: each step's and the ending's text screened, marks as is. */
export const screenedWritePath = (
  projection: MintProjection,
  path: WritePath,
): Effect.Effect<WritePath, MintFailure> =>
  Effect.gen(function* () {
    const steps = yield* Effect.forEach(path.steps, ({ commit, does }) =>
      projection.text(does, "review").pipe(Effect.map((screened) => ({ commit, does: screened }))),
    );
    return { steps, ends: yield* projection.text(path.ends, "review") };
  });

/**
 * What Guardian may approve for an anonymous read or exploration. Opening the public sign-in
 * page, including the site's own redirects to its sign-in origin and its own sign-in link or
 * button, is discovery; entering or submitting any credential is the host-owned sign-in step,
 * never authored exploration. After the host signed in, a context step that asks for no
 * credential and verifies no one, such as choosing a company, is navigation. A read keeps the
 * limits the request states; context it gives, such as today's date, is no filter.
 */
export const explorationAllowedEffect =
  "Authorized repeatable reads, navigation, observation and transient search/query interactions, including query submission when its read semantics are established. Respect constraints the request states, such as a date range, filter, sort or limit. Context it gives, such as the current date or the caller's location, is not a constraint unless the request applies it. Navigating to and observing the site's public sign-in pages, including the site's own redirects to its sign-in origin, is allowed. Clicking the site's own sign-in link or button to open its sign-in screen or dialog is navigation, even when the page says results need a login. Entering or submitting a username, email, phone number, password or code, submitting a sign-in step, or switching accounts is not: credential submission belongs only to the host-owned authenticate step. After the host has signed in, entering the caller's own input into a context step that asks for no username, email, phone number, password, code, date of birth, ZIP or security answer and does not verify who the user is, such as choosing a supplier, company, client or language, and continuing past it is navigation, not a sign-in step or an account switch. No autosave, holds, drafts, uploads, business commitments, account changes or other writes, even for exploration/test setup.";

/**
 * What Guardian may approve for a write build's `act` step. The write is the whole task the
 * request asks for, which may take several write steps; saves along the way are part of it, and
 * only redoing the task or a finished commit is out.
 */
const writeSessionAllowedEffect =
  "The caller's requested task, done once with the caller's values across this session's steps. The task may take several write steps: steps may navigate, fill, select, advance, save and submit toward it, and drafts, autosaves and step saves along the way are part of it. Never redo the whole task or a step that already finished; a step may run again only when a fresh read of the page shows it did not finish, or the task cannot complete without it. After the final submission a step may only read the task's confirmation or saved state, on any page of the authorized site, such as the record the task created or changed and its ID, or finish the same request's remaining sub-steps; never submit the task a second time. An add-on, pre-selected paid option, saved payment or private detail is enabled, accepted or declined only as the caller's input or answer says; when neither settles it, the step stops before choosing it.";

/**
 * The same, for a session that runs the agent's `exampleInput` because the caller sent none: the
 * input is the agent's reading of the request, so it settles nothing the request or an answered
 * question does not.
 */
const intentDerivedWriteSessionAllowedEffect =
  "The caller's requested task, done once across this session's steps with the input the agent read from the trusted intent and the owner's answered questions, because the caller sent no input. Every value in that input must be stated by the trusted intent or an answered question; deny a step whose input holds any other value, such as a quantity, amount, recipient or date the agent chose itself. Values the page supplies, such as a site option the request selects, a default, a form token or a suggestion, follow the general policy as before. The task may take several write steps: steps may navigate, fill, select, advance, save and submit toward it, and drafts, autosaves and step saves along the way are part of it. Never redo the whole task or a step that already finished; a step may run again only when a fresh read of the page shows it did not finish, or the task cannot complete without it. After the final submission a step may only read the task's confirmation or saved state, on any page of the authorized site, such as the record the task created or changed and its ID, or finish the same request's remaining sub-steps; never submit the task a second time. An add-on, optional purchase, pre-selected paid option, saved payment or private detail is enabled, accepted or declined only as the trusted intent or an answered question says, never as that input alone says; when neither settles it, the step stops before choosing it.";

/**
 * What Guardian may approve for a sign-in step on the site's own page: one the host fills from a
 * `signInStep`, or the agent's own source that writes the caller's secret handles.
 */
const signInAllowedEffect =
  "Signing in on the site's own sign-in page: the step enters the login and codes the caller supplied privately, either filled by the host or written as secret handles in the step's source, submits them, and checks whether the account is signed in. Nothing else on the site may change.";

/**
 * What Guardian may approve for a host card-fill step: the caller's card typed into the site's own
 * checkout, which submits nothing by itself.
 */
const cardFillAllowedEffect =
  "Typing the caller's payment card into the card fields of the site's own checkout, for the booking or purchase the caller asked for: the host types the card answers the caller gave privately and clicks nothing. Nothing on the site is submitted, booked or bought by this step.";

const offlineAllowedEffect =
  "Offline local files, source checks and computation only. No live website, credentials or network.";

/**
 * The authority one step's review grants: its own kind of work, never the build's whole effect.
 * A write session on the agent's reading of the request gets the stricter session text.
 */
export const allowedEffectsFor = (
  step: Pick<CurrentExecution, "purpose" | "target" | "input">,
): readonly string[] => [
  step.target !== "liveBrowser"
    ? offlineAllowedEffect
    : step.purpose === "act"
      ? step.input === "intent_derived"
        ? intentDerivedWriteSessionAllowedEffect
        : writeSessionAllowedEffect
      : step.purpose === "authenticate"
        ? signInAllowedEffect
        : step.purpose === "card_fill"
          ? cardFillAllowedEffect
          : explorationAllowedEffect,
];

/**
 * The context of one review. An execution review names its step; a question review names none
 * and carries no executed files or input schema. `step.sources` and `step.entrypoint` carry the
 * `operation/` prefix Guardian reads them under.
 */
export const mintReviewContext = (
  host: MintReviewHost,
  projection: MintProjection,
  step: {
    readonly sources: ReadonlyMap<string, string>;
    readonly entrypoint: string;
    readonly currentExecution?: CurrentExecution;
    /** The step starts on a fresh page, so the page left open is not the one it reads. */
    readonly startsOnFreshPage?: boolean;
  },
): Effect.Effect<MintReviewContext, MintFailure> =>
  Effect.gen(function* () {
    const { currentExecution } = step;
    const reviewsSource = currentExecution !== undefined && currentExecution.purpose !== "command";
    const browser = host.browser();
    const page = host.observedPage();
    const schema = reviewsSource ? host.inputSchema() : undefined;
    const signInCodes = currentExecution === undefined ? [] : host.signInCodes();
    const writes = currentExecution === undefined ? [] : (host.writes?.() ?? []);
    const readLiveTests = currentExecution === undefined ? undefined : host.liveTests?.();
    const liveTests = readLiveTests === undefined ? undefined : yield* readLiveTests;
    const recordedPath = host.writePath?.();
    const writePath =
      recordedPath === undefined ? undefined : yield* screenedWritePath(projection, recordedPath);
    return {
      repeatableRead: host.repeatableRead(),
      operationSources: [...step.sources.keys()],
      ...(reviewsSource
        ? { executedSources: executedOperationSources(step.sources, step.entrypoint) }
        : {}),
      ...(schema === undefined
        ? {}
        : { inputSchema: yield* screenMintText({ projection }, schema) }),
      ...(currentExecution === undefined ? {} : { currentExecution }),
      browser,
      ...(signInCodes.length === 0 ? {} : { signInCodes: [...signInCodes] }),
      ...(writePath === undefined ? {} : { writePath }),
      ...(page === undefined || browser !== "active" || step.startsOnFreshPage === true
        ? {}
        : { currentPage: page }),
      executions: [...host.executions()],
      ...(writes.length === 0 ? {} : { writes: trackedWrites(writes) }),
      // Empty once bound, so a review after a takeover sees that no batch is on record now.
      ...(liveTests === undefined ? {} : { liveTests: [...liveTests] }),
    };
  });

/**
 * The build's tracked writes as an execution review sees them: each write's execution, purpose
 * and entrypoint, with the outcome review's newest assessment, `unassessed` before the first.
 */
export const trackedWrites = (writes: readonly WriteOutcome[]) =>
  writes.map(({ write, assessment }) => ({
    executionId: write.executionId,
    purpose: write.purpose,
    ...(write.entrypoint === undefined ? {} : { entrypoint: write.entrypoint }),
    outcome: assessment?.outcome ?? ("unassessed" as const),
  }));

/** The operation files an execution loads: its entrypoint's import closure, keeping the prefix. */
const executedOperationSources = (
  sources: ReadonlyMap<string, string>,
  entrypoint: string,
): readonly string[] => {
  const prefix = "operation/";
  const files = new Map(
    [...sources]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, text]) => [path.slice(prefix.length), text]),
  );
  return [...executedSourceClosure(files, entrypoint.slice(prefix.length)).keys()].map(
    (path) => `${prefix}${path}`,
  );
};

/** A step result as Guardian gets it: within 4 KiB, cut on a character with a marker. */
export const cappedStepResult = (result: string) => {
  const bytes = new TextEncoder().encode(result);
  if (bytes.byteLength <= 4096) return result;
  const marker = "…[truncated at 4 KiB]";
  // A character the cut splits decodes to one replacement character, which is dropped.
  const kept = new TextDecoder().decode(bytes.subarray(0, 4096 - Buffer.byteLength(marker)));
  return `${kept.replace(/\uFFFD$/u, "")}${marker}`;
};

/**
 * The results of an attempt's last six steps as the agent received them, each capped, which
 * every execution review carries as untrusted evidence. Question reviews carry none.
 */
export const makeStepResults = () => {
  const results: StepResult[] = [];
  return {
    record: (executionId: string, observations: unknown) => {
      const text = typeof observations === "string" ? observations : JSON.stringify(observations);
      results.push({ executionId, result: cappedStepResult(text ?? "") });
      results.splice(0, results.length - 6);
    },
    forReview: (current: CurrentExecution | undefined): { stepResults?: readonly StepResult[] } =>
      current === undefined ? {} : { stepResults: [...results] },
  };
};

/**
 * Where a page is, as Guardian reads it: its origin, and its path with query and fragment. A
 * blank page keeps its name; a page with no origin of its own, such as a browser error page,
 * gives none.
 */
export const pageLocation = (url: URL): { origin: string; path: string } | undefined =>
  url.href === "about:blank"
    ? { origin: "about:blank", path: "" }
    : url.origin === "null"
      ? undefined
      : { origin: url.origin, path: `${url.pathname}${url.search}${url.hash}` };

/** The host's clock as the minter and Guardian read it: today's date and the time, in UTC. */
export const currentDateObservations = (now: DateTime.Utc) => ({
  todayUtc: DateTime.formatIsoDateUtc(now),
  nowUtc: DateTime.formatIso(now),
});

/** What a contract extraction does, for Guardian's review of it. */
export const contractExtractionNote =
  "Contract extraction for publication: it imports the script offline, reads its declared input and output schemas and any write confirmation, and decodes the host-bound input, and a read example's own output, with those schemas. It never calls operation.run.";

/**
 * A review Guardian could not complete, as the harness reads it: unavailable, never a refusal.
 * `dispatch` is `not_sent` for a review that ran before its step could start.
 */
export const reviewFailureOf = (error: ReviewFailure, dispatch?: "not_sent") =>
  new MintFailure({
    code: "ReviewUnavailable",
    reviewFailure: error.code,
    ...(error.modelQuotaExhausted === true ? { modelOutage: "quota_exhausted" as const } : {}),
    ...failureDetailMetadata(error),
    ...(error.reviewPhase === undefined ? {} : { reviewPhase: error.reviewPhase }),
    ...(dispatch === undefined ? {} : { reviewDispatch: dispatch }),
  });

/**
 * Guardian denied or escalated the step: a refusal the agent reads with its rationale, an
 * execution review's refusal kind, and a publication review's reason and findings.
 */
export const reviewDenied = (
  reviewId: string,
  decision: Pick<
    GuardianDecision,
    "rationale" | "reason" | "findings" | "publicReason" | "refusal"
  > & {
    readonly outcome: "deny" | "escalate";
  },
) =>
  new MintFailure({
    code: "ReviewDenied",
    review: {
      outcome: decision.outcome,
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      rationale: decision.rationale,
      reviewId,
      ...(decision.findings === undefined ? {} : { findings: decision.findings }),
      ...(decision.publicReason === undefined ? {} : { publicReason: decision.publicReason }),
      ...(decision.refusal === undefined ? {} : { refusal: decision.refusal }),
    },
  });
