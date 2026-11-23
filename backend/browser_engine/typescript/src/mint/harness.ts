import type { MintReportContext } from "./diagnostics.js";
import type { RunnerResultDefect } from "../execution/boundary.js";
import { destinationPrivateCandidateMetadata } from "../destinations/private-candidate.js";
import { policyFailureMetadata } from "../runtime/policy-metadata.js";
import {
  failureDetail,
  failureDetailMetadata,
  failureRootCause,
} from "../runtime/failure-detail.js";
import {
  maximumHostRefusals,
  maximumSignInDenials,
  repeatedDenialNotice,
  signInAnswer,
  signInFailureFeedback,
  signInFeedbackOf,
  signInRootCode,
  signInUnavailableSummary,
  unresolvedSignInGuidance,
} from "./sign-in-failure.js";
import type { SignInDiagnostic } from "../execution/sign-in-diagnostics.js";
import { type HostRefusal, sameHostRefusal } from "../destinations/autofill-refusal.js";
import { authorityCheckMetadata } from "../auth/authority-metadata.js";
import {
  diagnosticRetentionReason,
  diagnosticScreeningReason,
  diagnosticStorageFailure,
} from "../models/model-diagnostic-failure.js";
import { createHash, randomUUID } from "node:crypto";
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Either,
  Exit,
  FiberSet,
  Option,
  Schema,
  Scope,
} from "effect";
import {
  AgentRequest,
  blockedExplanationLimit,
  BlockedReport,
  BuildBlocked,
  CaptureRequest,
  defaultLiveTestCaseMs,
  ExecutionRefusal,
  ExecutionRequest,
  type HostRefusalBasis,
  HostRefusalSource,
  isReadOrWriteChoice,
  LiveTestsRequest,
  MintFailure,
  MintRequest,
  MintServices,
  PublicationRequest,
  publicReasonLimit,
  SignedInMarkerCheckRequest,
  TaskUpdateRequest,
  withOwnWords,
} from "./contracts.js";
import { answersForReview, type AnsweredQuestion } from "../guardian/question.js";
import type { ReviewedLiveTestBatch } from "../guardian/review.js";
import {
  cutToLimit,
  publicationRefusalUnfixable,
  type PublicationFinding,
} from "../guardian/review-contracts.js";
import {
  taskUpdateForReview,
  type PendingTaskUpdate,
  type TaskChange,
  type TaskUpdateConfirmer,
} from "../guardian/task-update.js";
import { siteDomain } from "../runtime/same-site.js";
import { validateSignedInMarker } from "../destinations/signed-in-marker.js";
import { isCardSlot } from "../destinations/payment-frames.js";
import { finiteCaptureGap, finiteRunnerFailure } from "./runner-failure.js";
import { isSecretHandle } from "./secret-handles.js";
import { fileReadbackRule } from "./file-readback.js";
import { cardReadbackRule } from "./card-readback.js";
import { citesCallerRequest, citesConfirmedUpdate } from "./caller-citation.js";
import type {
  AcceptedTaskUpdate,
  AllowedExecution,
  AgentInputRequest,
  BuildAssumption,
  TaskState,
  TaskUpdateStatus,
  ExecutionEvidence,
  MintActions,
  MintOutcome,
  MintStopReason,
  MintHarnessSnapshot,
  DecisionLedger,
  LedgerDenial,
  LedgerTestFailure,
  LiveTestHost,
  PublicationDecision,
  PublicationRecovery,
  SpentSignIn,
  UnansweredQuestion,
  WeakenedOutput,
} from "./contracts.js";
import { pickedOption, type LoginDecline, type ValidAnswers } from "../runtime/input-request.js";
import {
  bufferedHistoryArchive,
  makeOutcomeReviewer,
  memoryHistoryArchive,
  minterHistory,
} from "./outcome-review.js";
import { readImportClosure } from "./operation-source.js";
import { boundedResult, digestResult, resultDigestPath } from "./result-digest.js";
import { contentDigest } from "./step-checks.js";
import { writePathNotice } from "./write-session.js";
import {
  caseDigest,
  caseView,
  cursorPairOf,
  decodeCasesFile,
  judgeCase,
  liveTestCasesPath,
  failingCasesRefusal,
  failingLiveTestCases,
  liveTestsEvidence,
  liveTestsEvidencePath,
  liveTestsEvidenceProblem,
  liveTestsShortfall,
  liveTestVersion,
  LiveTestOutputChecks,
  maximumBatchCases,
  outputExcerpt,
  pendingFailureCases,
  primaryListOf,
  reviewPassPercent,
  signedInTestInputLimit,
  signedInTestInputRefusal,
  uncountedTestInputs,
  type LiveTestCasesFile,
  type LiveTestRecord,
  type LiveTestVersion,
  type LiveTestVersionResults,
} from "./live-tests.js";
import type {
  LiveMinterHistory,
  OutcomeEvidence,
  WriteExecutionStatus,
} from "./outcome-review-contracts.js";
import type { SiteAccessDiagnostic } from "./site-access-contracts.js";
import type { ModelDiagnosticTiming } from "../models/model-diagnostic-timing.js";
import type { RuntimeRecordInput } from "../models/model-runtime-record.js";
import { inputContractChangedInstruction, registryRefusal } from "./registry-feedback.js";
import { publicationBlockFeedback, workspacePath } from "./publication-block.js";
import { outputChecksRefusal } from "./output-notes.js";
import { fieldFill, lintOutput, type FieldFill } from "../runtime/output-lint.js";
import {
  inputFeedbackInstruction,
  maximumInputFeedbackRounds,
  unresolvedInputFeedbackSummary,
} from "./input-feedback.js";
import type { MintCompletion } from "./input-feedback.js";
import {
  makeMintWorkspace,
  questionOnlyWorkspace,
  relativeSourcePath,
  screenMintText,
} from "./workspace.js";

/**
 * The output fields this build's accepted updates added and none removed since. The registered
 * contract never had them, so changing or removing one takes nothing its callers receive.
 */
const addedOutputFields = (updates: readonly { readonly changes: readonly TaskChange[] }[]) => {
  const added = new Set<string>();
  for (const { changes } of updates)
    for (const change of changes) {
      if (change.setting !== "output") continue;
      if (change.change === "add") added.add(change.field);
      else if (change.change === "remove") added.delete(change.field);
    }
  return added;
};

/**
 * Whether a maintenance update only adds or tightens output fields, or changes one this build
 * added (`addedOutputFields`): callers keep everything the registered contract gives them, so
 * nobody needs to confirm it.
 */
const keepsContract = (update: TaskUpdateRequest, added: ReadonlySet<string>) =>
  update.changes.every(
    (change) =>
      change.setting === "output" &&
      (change.change === "add" || change.change === "tighten" || added.has(change.field)),
  );

/** Each loosened field and how, for the minter; a host refusal that names none reads as a sentence. */
const weakenedOutputsText = (weakened: readonly WeakenedOutput[]) =>
  weakened.length === 0
    ? ""
    : `: ${weakened
        .map(({ field, change }) =>
          change === "removed"
            ? `${field} was removed`
            : change === "optional"
              ? `${field} became optional`
              : change === "nullable"
                ? `${field} became nullable`
                : `${field} admits more values than before`,
        )
        .join("; ")}`;

const effectQuestionInstruction =
  "Before any website access, ask the person whether this build only looks things up or changes something on the website. Call request_input once with exactly one choice question whose options have the ids read and write: the prompt says in one or two plain sentences what the finished tool would do, and your best guess comes first; filling in or advancing a form that saves data on the site (an application, profile or checkout form) counts as a change, while searching or filtering does not. A write build does the requested task once, for real, with the person's values, while it builds (it may take several steps), and ends by reading the site's confirmation. No other tool is available until the person answers.";

/**
 * The host's own labels for the two answers of the effect question. The agent writes the prompt,
 * which Guardian reviews, but never what an answer says, so a label cannot present `write` as
 * keeping the build read-only.
 */
const effectAnswerLabels: Readonly<Record<string, string>> = {
  read: "Keep it read-only: only look things up",
  write: "Make it a write build: let it change the website",
};
const withEffectAnswerLabels = <
  Q extends { readonly type: string; readonly options?: readonly { readonly id: string }[] },
>(
  questions: readonly Q[],
): Q[] =>
  questions.map((question) =>
    question.type !== "choice" || question.options === undefined
      ? question
      : {
          ...question,
          options: question.options.map((option) => {
            const label = effectAnswerLabels[option.id];
            return label === undefined ? option : { id: option.id, label };
          }),
        },
  );

/**
 * A saved login another of the account's jobs holds, still held after the host waited for it in
 * place: nothing was sent, no sign-in was spent, and the login itself is fine. Never a credentials
 * problem.
 */
const loginInUseAnswer = {
  code: "login_in_use",
  fields: {
    signInOutcome: "signed_out",
    nextStep: "authenticate",
    credentialSent: false,
    countsTowardSignInCap: false,
  },
  notice:
    "The host started no sign-in: the saved login is in use by another of the account's jobs, which holds it until that job ends, and it was still in use after the host waited for it. This is not a credentials problem: nothing was sent, this does not count toward the attempt's sign-in limit, and no other login is needed, so do not ask the caller for one. Work that needs no sign-in may go on; call execute purpose authenticate again later, and the host binds the same login once it is free.",
} as const;

/** A failed or refused sign-in's answer, or a held login's; undefined for any other failure. */
const signInOrLoginInUseAnswer = (
  error: MintFailure,
  feedback: ReturnType<typeof signInFeedbackOf>,
  ending: Parameters<typeof signInAnswer>[2],
) =>
  feedback !== undefined
    ? signInAnswer(error, feedback, ending)
    : error.reason === "login_in_use"
      ? loginInUseAnswer
      : undefined;

/** A task update request's identity: the same request has the same digest. */
const taskUpdateDigest = (request: TaskUpdateRequest) =>
  createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex");

/**
 * Live tests the host refuses while Guardian's denial of the latest publication stands, as a
 * `host_refused` report reads them: the attempt ran out of live tests and no batch fits now.
 * While the host's reserve past its batch cap is still open (`reserveOpen`), the tests are not
 * spent: `reservedFor` names the cases it would run now, and `failedOnSource` those that failed on
 * the current source, which it takes once the code changes.
 */
interface LiveTestsRefusal {
  readonly reserveOpen: boolean;
  readonly reservedFor: readonly string[];
  readonly failedOnSource: readonly string[];
}

type AgentQuestion = (typeof AgentRequest.Type)["questions"][number];
/** The agent's question as its caller reads it, with each caller-visible text redacted. */
const callerVisibleQuestion = (
  question: AgentQuestion,
  redact: (text: string) => string,
): AgentQuestion => {
  const prompt = redact(question.prompt);
  if (question.type === "choice" || question.type === "multi_choice")
    return {
      ...question,
      prompt,
      options: question.options.map((option) => ({
        ...option,
        label: redact(option.label),
        ...(option.maskedLabel === undefined ? {} : { maskedLabel: redact(option.maskedLabel) }),
      })),
    };
  if (question.type === "confirm" && question.followUp !== undefined) {
    const { defaultText } = question.followUp;
    return {
      ...question,
      prompt,
      followUp: {
        prompt: redact(question.followUp.prompt),
        // The caller's form shows it as the field's default.
        ...(defaultText === undefined ? {} : { defaultText: redact(defaultText) }),
      },
    };
  }
  return { ...question, prompt };
};
/** The agent's request as its caller reads it: its notice and every question. */
const callerVisibleRequest = <R extends typeof AgentRequest.Type>(
  request: R,
  redact: (text: string) => string,
): R => ({
  ...request,
  ...(request.notice === undefined ? {} : { notice: redact(request.notice) }),
  questions: request.questions.map((question) => callerVisibleQuestion(question, redact)),
});
/**
 * The agent's confirm questions that ask the owner to confirm a step an execution review refused
 * (`confirmsReview`), each with that review's id.
 */
const confirmsReviewMarks = (request: typeof AgentRequest.Type) =>
  request.questions.flatMap((question) =>
    question.type === "confirm" && question.confirmsReview !== undefined
      ? [{ questionId: question.id, reviewId: question.confirmsReview }]
      : [],
  );
/** The ids of the agent's confirm questions that ask whether to end the build (`endsBuild`). */
const endsBuildIds = (request: typeof AgentRequest.Type): ReadonlySet<string> =>
  new Set(
    request.questions.flatMap((question) =>
      question.type === "confirm" && question.endsBuild === true ? [question.id] : [],
    ),
  );
const decodeAgentRequestJson = Schema.decodeUnknownEither(Schema.parseJson(AgentRequest));

/** How the minter removes an account reference from the named part of a tool's definition. */
const definitionFix = (section: string | undefined) =>
  section === "loginUrl"
    ? "Run authenticate again with the site's plain sign-in page as loginUrl, then call finish_build again with the same executionId."
    : section === "name" || section === "description" || section === "supportedVariants"
      ? `Rewrite the ${section} in finish_build's metadata without it and call finish_build again with the same executionId.`
      : section === "site"
        ? "Rewrite siteName and siteSummary in finish_build's metadata without it and call finish_build again with the same executionId."
        : section === "inputSchema" || section === "outputSchema" || section === "questions"
          ? "Edit the operation's schemas and questions in its source without it, then call finish_build again with the same executionId."
          : "Remove it from the metadata, the operation's schemas and questions, and the login URL, then call finish_build again with the same executionId.";

/**
 * Whether the agent's request sets whether the caller may answer in their own words, which is the
 * host's to set on every choice.
 */
const setsOwnWords = (input: unknown) =>
  Option.isSome(
    Schema.decodeUnknownOption(
      Schema.Struct({
        questions: Schema.Array(Schema.Unknown).pipe(
          Schema.filter((questions) =>
            questions.some(
              (question) =>
                typeof question === "object" &&
                question !== null &&
                ("allowOther" in question || "allowNote" in question),
            ),
          ),
        ),
      }),
    )(input),
  );

/**
 * The option the owner picked on the effect question, undefined when they answered in their own
 * words instead.
 */
const readOrWritePick = (submitted: AgentInputRequest, answers: ValidAnswers) => {
  const given = answers[submitted.questions[0]?.id ?? ""];
  return given?.type === "choice" ? pickedOption(given.value) : undefined;
};

/**
 * An answer as the model receives it: the value alone, keyed by question id. A `secret` answer is
 * the host's handle; anything else in its place could be the secret itself, so nothing is returned.
 */
const answersForModel = (answers: ValidAnswers) =>
  Object.values(answers).some((answer) => answer.type === "secret" && !isSecretHandle(answer.value))
    ? Effect.fail(
        new MintFailure({
          code: "Unavailable",
          failureDetail: failureDetail("mint_host_dependency_failed", {
            operation: "askInput",
            context: { check: "secret_answer_without_handle" },
          }),
        }),
      )
    : Effect.succeed(
        Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, answer.value])),
      );
/**
 * What an execution whose runner left no readable result means for the agent: an execution-host
 * fault. It says nothing about the website, the browser or its egress, so it is no reason to
 * change browser mode or proxy.
 */
const runnerResultNotice = (runner: RunnerResultDefect) =>
  `The operation runner ended without a readable result (execution.runnerResult.cause: ${runner.cause}${runner.signal === undefined ? `, exit status ${runner.exitCode}` : `, ended by ${runner.signal}`}). This is an execution-host fault, not evidence about the website, the browser or its proxy; stderr, when present, is the runner's own account. The execution may have run, so its effect is possible. `;

/** How many of the latest publication refusals a question or blocked-explanation review reads. */
const reviewedPublicationRefusals = 8;
/**
 * How many Guardian refusals in a row of a write build's act step, correctable ones included, with
 * no act step Guardian allowed between, let the minter end the build as a policy block: a loop on
 * a refusal it cannot get past ends with its reviewed explanation instead of an unexplained stop.
 */
const actRefusalsForPolicy = 5;
/**
 * How many of the latest live test batches an execution review reads (`LiveTestHost.bindBatches`),
 * beside older ones whose failures still stand.
 */
const reviewedLiveTestBatches = 4;
/**
 * The bounds of a blocked explanation review's decision ledger: the latest denials, each one's
 * rationale and finding explanations capped, the latest failing live test cases, and the latest
 * host refusals and no-match cases.
 */
const ledgerBounds = {
  denials: 12,
  rationaleChars: 800,
  /** A publication refusal's instruction, kept whole: its last step is what a review checks. */
  instructionChars: 1_600,
  findings: 4,
  findingChars: 300,
  testFailures: 20,
  hostRefusals: 8,
  noMatchCases: 8,
  messageChars: 300,
  errorClassChars: 120,
  gotChars: 120,
} as const;
const capped = (text: string, chars: number) =>
  text.length <= chars ? text : `${text.slice(0, chars - 1)}…`;
/** The HTTP version's file, whose live tests the publication record shows beside the Playwright version's. */
const httpVersionPath = "src/tool-http.mjs";
/** Refusals of a write the session did not demonstrate as its build declares it. */
const writeCompletionReasons: ReadonlySet<string> = new Set([
  "write_not_submitted",
  "commit_marks_undeclared",
  "commit_marks_unentered",
  "write_path_unfinished",
  "write_path_undeclared",
  "confirmation_undeclared",
  "confirmation_unrecorded",
  // A read's execution after the build became a write: the write itself is still to do.
  "example_before_effect_change",
]);
/** A contract that rejects what ran: a write not demonstrated as declared, or a read's source fix. */
const contractReasons: ReadonlySet<string> = new Set([
  "contract_input_mismatch",
  "contract_output_mismatch",
]);
/** Refusals that need a new live read, test or sign-in, never a completed write again. */
const newObservationReasons: ReadonlySet<string> = new Set([
  "http_implementation_untested",
  "http_implementation_stale",
  "example_output_unavailable",
  "destination_validation",
  "read_back_required",
  "login_url_one_time",
  "login_url_contains_credential",
  "sign_in_version_refused",
  // An execution on the site the build moved away from: a fresh example on the current site.
  "example_before_site_change",
  // Restored inputs change the code, which needs its own example.
  "input_contract_changed",
  // Too few cases pass on the published source: fix, then run them again.
  "live_tests_below_threshold",
  // A counted case fails on the published source: fix the code and run the cases again, or retire it.
  "live_test_cases_failing",
]);
/**
 * Publication refusals the host asks about only once in an attempt: finishing again, or passing
 * `httpVersion` for an HTTP version, publishes. They are advice, not a host check refusing a step.
 */
const askedOnceReasons: ReadonlySet<string> = new Set([
  "http_implementation_untested",
  "http_implementation_stale",
  "login_url_one_time",
]);
/**
 * The host's publication refusals whose instruction here names a step that fixes them within the
 * attempt and never says to end the build: an edit of the metadata or source, a fresh example, or
 * a sign-in run again. A `host_refused` report right after one is refused once per reason with
 * that step, and a second is taken, so a minter that still cannot get past it can stop.
 */
const namedStepReasons: ReadonlySet<string> = new Set([
  "variants_unsupported",
  "contract_input_mismatch",
  "contract_output_mismatch",
  "confirmation_undeclared",
  "commit_marks_undeclared",
  "write_path_undeclared",
  "confirm_action_unmatched",
  "refusal_unreadable",
  "output_checks_blocked",
  "site_metadata_required",
  "tool_name_taken",
  "definition_login_reference",
  "secret_handle",
  "file_handle",
  "file_readback",
  "card_readback",
  "session_token_literal",
  "session_token_placeholder",
  "login_url_contains_credential",
  "metadata_contains_credential",
  "sign_in_version_refused",
]);
/**
 * Refusals a host adds beside core's own, for which core has only its generic instruction: the
 * host names the step in the refusal's review rationale. One names its step only when it carries
 * a rationale, and only then is a `host_refused` report sent back to it.
 */
const rationaleStepReasons: ReadonlySet<string> = new Set(["no_match_case_untested"]);
/** How many host-refused submissions an attempt remembers, the latest kept, to tell a repeat. */
const rememberedRefusedSubmissions = 8;
/** An execution request for a sign-in step, read before it decodes. */
const isAuthenticate = Schema.is(Schema.Struct({ purpose: Schema.Literal("authenticate") }));
/** How the minter goes on after a refusal that is neither an outage nor Guardian's. */
const refusalRecovery = (reason: string | undefined, write: boolean): PublicationRecovery =>
  reason !== undefined &&
  (writeCompletionReasons.has(reason) || (write && contractReasons.has(reason)))
    ? "write_completion"
    : reason !== undefined &&
        newObservationReasons.has(reason) &&
        // A write restores its inputs in the source and publishes its session's execution again.
        !(write && reason === "input_contract_changed")
      ? "new_observation"
      : "correct_source";
/** A refusal the harness makes before publication runs, as its decision. */
const hostRefusalDecision = (
  reason: string,
  executionId: string | undefined,
  write: boolean,
  code: MintFailure["code"] = "PublicationUnavailable",
): Omit<PublicationDecision, "decisionId" | "decidedAt"> => ({
  outcome: "refused",
  code,
  reason,
  ...(executionId === undefined ? {} : { executionId }),
  failedChecks: [reason],
  recovery: refusalRecovery(reason, write),
});
/**
 * Sign-ins the host itself refused: it typed nothing where the login would go somewhere
 * credentials may not, or somewhere it could not verify. An autofill refusal of another check,
 * such as a field the selector did not find or matched twice, is the minter's to correct.
 */
const hostSignInRefusalCode = (
  error: MintFailure,
): Extract<HostRefusalSource, { source: "sign_in_step" }>["code"] | undefined => {
  const code = error.authentication?.code;
  return code === "CredentialTargetRefused" ||
    code === "CredentialTargetUnverified" ||
    (code === "AutofillRefused" && error.authentication?.hostRefusal?.check === "destination")
    ? code
    : undefined;
};
const hostSignInRefusal = (error: MintFailure) => hostSignInRefusalCode(error) !== undefined;
/** A task update refusal's reason as a closed code: one core names, else `other`. */
const taskUpdateRefusalCode = (
  reason: string,
): Extract<HostRefusalSource, { source: "task_update" }>["reason"] =>
  reason === "intake_refused" ||
  reason === "duplicate_tool" ||
  reason === "site_unavailable" ||
  reason === "change_unsupported"
    ? reason
    : "other";
/**
 * The standing host refusals a checkpoint kept (`MintHarnessSnapshot.hostRefusalSources`), read
 * entry by entry: a source this worker cannot decode, such as one a later release added, reads as
 * none (`unrecorded`), and a checkpoint that kept none, from an older worker, as one unrecorded
 * refusal.
 */
const restoredHostRefusals = (kept: unknown) => {
  const entries = Array.isArray(kept) ? (kept as readonly unknown[]) : [];
  const restored = entries.map((entry) => {
    const record = typeof entry === "object" && entry !== null ? entry : {};
    return {
      refusal: Option.getOrUndefined(
        Schema.decodeUnknownOption(HostRefusalSource)(Reflect.get(record, "refusal")),
      ),
      beforeSignIn: Reflect.get(record, "beforeSignIn") === true,
    };
  });
  return restored.length > 0 ? restored : [{ refusal: undefined, beforeSignIn: false }];
};
/**
 * Whether a host refusal a `host_refused` report stands on is apart from an unconfirmed sign-in,
 * so the report keeps its reason: a sign-in screen the host refused at its destination check,
 * which a later password or code screen that passes clears; a sign-in step the host refused with
 * no login sent since (`beforeSignIn` false); and a task update the host refused. A publication or
 * live tests refused while the sign-in never confirmed may be its consequence, such as a recipe
 * nothing verified, as may a refused refill, and a refusal an older checkpoint kept without its
 * source is unknown: none of them keeps the reason.
 */
const hostRefusalApartFromSignIn = (refusal: HostRefusalBasis, beforeSignIn: boolean) =>
  refusal.source === "sign_in_destination" ||
  refusal.source === "task_update" ||
  (refusal.source === "sign_in_step" && !beforeSignIn);
/**
 * A failure's code as diagnostics and publication evidence name it. A review whose outcome
 * Guardian kept refusing fails as `ReviewUnavailable`, but it is a verdict that did not form, not
 * an outage, so it is named `InvalidOutcome`.
 */
const failureCode = (error: MintFailure) =>
  error.reviewFailure === "InvalidOutcome" ? "InvalidOutcome" : error.code;
/** The finite checks behind a publication refusal: never a value, path or rationale. */
const refusalChecks = (error: MintFailure) => [
  ...new Set(
    [
      error.reason,
      error.reviewFailure === "InvalidOutcome" ? error.reviewFailure : undefined,
      error.review?.reason,
      error.registryIssue,
      error.publicationBlock?.check,
      error.destinationEvidenceGap,
      ...(error.review?.findings ?? []).map(({ category }) => category),
    ].filter((check) => check !== undefined),
  ),
];

const Count = Schema.Int.pipe(Schema.between(0, Number.MAX_SAFE_INTEGER));
/** Fresh verified examples allowed per attempt after publication finds an unreadable output. */
const maximumUnavailableOutputReruns = 2;
const VisibleReceipt = Schema.Struct({
  authentication: Schema.optional(
    Schema.Struct({
      state: Schema.Literal("authenticated", "failed"),
      effect: Schema.Literal("possible", "verified"),
    }),
  ),
  executionId: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{1,200}$/)),
  status: Schema.Literal("completed", "failed", "unsupported", "needs_input"),
  effect: Schema.Literal("not_sent", "possible", "verified"),
  confirmation: Schema.optional(Schema.Literal("message", "readback")),
  withheldConfirmation: Schema.optional(Schema.Literal("message", "readback")),
  preflight: Schema.optional(Schema.Literal("rejected_before_claim")),
  checks: Schema.optional(
    Schema.Struct({
      passed: Count,
      failed: Count,
      skipped: Count,
      unsupported: Count,
      liveSiteTouched: Schema.Boolean,
    }),
  ),
});

/**
 * Adds the host's pending notices (browser state that changed after an earlier call returned) to
 * a JSON tool result, so the agent hears them on its next host tool call of any kind. A result that
 * is not a JSON object, such as a source read, or a failed call keeps them for the next one.
 */
const decodeJsonObject = Schema.decodeUnknownEither(
  Schema.parseJson(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
);

/** The entrypoint a recovered execute call's arguments name, if any. */
const submittedEntrypoint = (args: string): string | undefined => {
  const parsed = decodeJsonObject(args);
  if (parsed._tag === "Left") return undefined;
  const entrypoint = parsed.right["entrypoint"];
  return typeof entrypoint === "string" ? entrypoint : undefined;
};

const withHostNotices = (
  actions: MintActions,
  drain: (() => readonly object[] | undefined) | undefined,
): MintActions => {
  if (drain === undefined) return actions;
  const attach = (result: string): string => {
    // A result that is not a JSON object, such as a source read, keeps its notices for the next.
    const parsed = decodeJsonObject(result);
    if (parsed._tag === "Left") return result;
    const notices = drain();
    if (notices === undefined) return result;
    return JSON.stringify({ ...parsed.right, hostNotices: notices });
  };
  const wrap =
    <A extends readonly unknown[]>(action: (...args: A) => Effect.Effect<string, MintFailure>) =>
    (...args: A) =>
      action(...args).pipe(Effect.map(attach));
  return {
    ...actions,
    ...(actions.retainCapture === undefined ? {} : { retainCapture: wrap(actions.retainCapture) }),
    execute: wrap(actions.execute),
    finish: wrap(actions.finish),
    requestInput: wrap(actions.requestInput),
    ...(actions.reportBlocked === undefined ? {} : { reportBlocked: wrap(actions.reportBlocked) }),
    ...(actions.updateTask === undefined ? {} : { updateTask: wrap(actions.updateTask) }),
    ...(actions.captchaState === undefined ? {} : { captchaState: wrap(actions.captchaState) }),
    ...(actions.liveTests === undefined ? {} : { liveTests: wrap(actions.liveTests) }),
    ...(actions.requestBrowserRecovery === undefined
      ? {}
      : { requestBrowserRecovery: wrap(actions.requestBrowserRecovery) }),
    ...(actions.checkSignedInMarker === undefined
      ? {}
      : { checkSignedInMarker: wrap(actions.checkSignedInMarker) }),
    ...(actions.abandonSignIn === undefined
      ? {}
      : { abandonSignIn: wrap(actions.abandonSignIn) }),
  };
};

/** The paths an input schema rejected, as a sentence, or nothing when the host has none. */
const inputIssueText = (issues: MintFailure["inputIssues"]) =>
  issues === undefined || issues.length === 0
    ? ""
    : ` It rejected ${issues
        .map(
          ({ path, issue }) =>
            `${path === "" ? "the input itself" : JSON.stringify(path)} (${issue})`,
        )
        .join(", ")}.`;

/** What the agent does about a question its script asked that reached nobody. */
const scriptQuestionInstruction: Readonly<
  Record<NonNullable<ExecutionEvidence["scriptQuestion"]>["outcome"], string>
> = {
  reword:
    "Guardian did not allow the question this script asked, so nobody was asked and the script's ask failed. Revise the script's declared question using the rationale, then execute again; the revised question is reviewed again. Do not ask for a value you were already given or that the site shows: read a value the caller's input or the request gives from the tool's input (when the caller's input is empty, pass it in exampleInput on the example, or on each write act step that needs it), and use the {{secret.<id>}} handle of a protected answer you already hold.",
  authentication:
    "The script's question asks for a website login, which only the host requests, so nobody was asked. Remove it from the script's questions and sign in with execute purpose authenticate instead.",
  invalid:
    "The host could not accept the script's question as asked, so nobody was asked. Check its declaration and options, then execute again.",
  unavailable:
    "The host could not review or deliver the script's question, so nobody was asked; nothing is wrong with the question. You may execute again once; if it fails the same way, end the attempt and say the question could not be asked.",
  unanswered:
    "The caller was asked the script's question and gave no answer before it expired, so the script's ask failed. Decide how to go on without it: run the example again with an input that does not need the answer, narrow the tool, or end the build with report_blocked (reason question_unanswered when only the caller's answer would let it go on). No answer is never consent: it authorizes no write. Verify the site's current state before any further write. After two questions have gone unanswered, the next one left unanswered ends the build.",
};

/** What the minter reads when its own question expired unanswered. */
const noAnswerInstruction =
  "No answer was given before the question expired. Decide how to proceed without it: continue with a sensible default and list it in finish_build assumptions, narrow the tool so it does not need the answer, or end the build with report_blocked (reason question_unanswered when only the caller's answer would let it go on). No answer is never consent: it authorizes no write, sign-in or change of task, so never cite this question in confirmedBy. Ask again only when the answer is essential: after two questions have gone unanswered, the next one left unanswered ends the build.";

/**
 * How many unanswered questions go back to the minter in one build, the minter's own and its
 * scripts' together. A question's wait pauses the build's active time, so a minter that kept asking
 * an absent caller would hold its browser and login for as long as the job may live; the next
 * unanswered question ends the build as no_response instead.
 */
const noAnswerHandBackLimit = 2;

const siteAccessDiagnostic = (evidence: ExecutionEvidence): SiteAccessDiagnostic | undefined => {
  try {
    if (evidence.status !== "failed") return undefined;
    const candidate: unknown = evidence.siteAccess;
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate))
      return undefined;
    const code: unknown = Reflect.get(candidate, "code");
    const basis: unknown = Reflect.get(candidate, "evidence");
    if (code === "site_bot_challenge" && basis === "screened_page_and_response_headers")
      return { code, evidence: basis };
    if (code === "site_rate_limited" && basis === "response_headers")
      return { code, evidence: basis };
  } catch {
    // Optional model-visible provenance cannot replace the primary execution receipt.
  }
  return undefined;
};

/**
 * What the agent does after a write step whose confirmation the host withheld with its result:
 * the write went out, so it is never repeated; a step that only reads the confirmation back
 * confirms the session, and the withheld step publishes only when no read-back is possible.
 */
const withheldConfirmationInstruction =
  "This step read the write's confirmation, so the write went out, but the host did not accept its result, so it confirms nothing yet. Never repeat the write: entering its commit steps again is refused. Fix the source if the host said why, then run one act step that only reads the confirmation or the saved state back and records it, and publish against that step. Only if no step can read it back, call finish_build naming this step with readBackUnavailable saying why; it then publishes with no output kept.";

/** Copy known receipt fields without invoking an optional hostile accessor. */
const safeExecutionEvidence = (evidence: ExecutionEvidence): ExecutionEvidence => {
  const siteAccess = siteAccessDiagnostic(evidence);
  return {
    executionId: evidence.executionId,
    status: evidence.status,
    effect: evidence.effect,
    observations: evidence.observations,
    ...(evidence.review === undefined ? {} : { review: evidence.review }),
    ...(evidence.authentication === undefined ? {} : { authentication: evidence.authentication }),
    ...(evidence.terminalFailure === undefined
      ? {}
      : { terminalFailure: evidence.terminalFailure }),
    ...(evidence.noResponse === undefined ? {} : { noResponse: evidence.noResponse }),
    ...(evidence.preflight === undefined ? {} : { preflight: evidence.preflight }),
    ...(evidence.resultRef === undefined ? {} : { resultRef: evidence.resultRef }),
    ...(evidence.confirmation === undefined ? {} : { confirmation: evidence.confirmation }),
    // A recorded confirmation wins: a step carries a withheld one only in its place.
    ...(evidence.withheldConfirmation === undefined || evidence.confirmation !== undefined
      ? {}
      : { withheldConfirmation: evidence.withheldConfirmation }),
    ...(evidence.writePathRemaining === undefined || evidence.writePathRemaining.length === 0
      ? {}
      : { writePathRemaining: evidence.writePathRemaining }),
    ...(evidence.checks === undefined ? {} : { checks: evidence.checks }),
    ...(siteAccess === undefined ? {} : { siteAccess }),
    ...Option.match(Schema.decodeUnknownOption(ExecutionRefusal)(evidence.refusal), {
      onNone: () => ({}),
      onSome: (refusal) => ({ refusal }),
    }),
  };
};

const decode = <A, I>(schema: Schema.Schema<A, I>, input: unknown) =>
  Schema.decodeUnknown(schema)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      (error) =>
        new MintFailure({
          failureDetail: failureDetail("mint_host_dependency_failed", {
            operation: "Schema.decodeUnknown",
            error,
          }),
          code: "InvalidRequest",
        }),
    ),
  );

const diagnosticUnavailable = (error: unknown) =>
  new MintFailure({
    code: "Unavailable",
    diagnosticRetentionReason: diagnosticRetentionReason(error),
    diagnosticStorageFailure: diagnosticStorageFailure(error),
  });

type JsonTypeTree =
  | { readonly type: "null" | "string" | "number" | "boolean" }
  | { readonly type: "object"; readonly fields: Record<string, JsonTypeTree> }
  | { readonly type: "array"; readonly elementTypes: JsonTypeTree[] };

const jsonTypeTree = (value: unknown): JsonTypeTree => {
  const visit = (current: unknown): JsonTypeTree => {
    if (current === null) return { type: "null" };
    if (typeof current === "string") return { type: "string" };
    if (typeof current === "boolean") return { type: "boolean" };
    if (typeof current === "number" && Number.isFinite(current)) return { type: "number" };
    if (Array.isArray(current)) {
      const elements = new Map<string, JsonTypeTree>();
      for (const value of current) {
        const tree = visit(value);
        elements.set(JSON.stringify(tree), tree);
      }
      return {
        type: "array",
        elementTypes: [...elements]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([, tree]) => tree),
      };
    }
    if (typeof current !== "object") throw new Error("Invalid JSON input");
    const fields: Record<string, JsonTypeTree> = {};
    for (const key of Object.keys(current).sort())
      Object.defineProperty(fields, key, {
        value: visit(Reflect.get(current, key)),
        enumerable: true,
        configurable: true,
      });
    return { type: "object", fields };
  };
  return visit(value);
};

/** What the minter does once the owner declined to sign in, by why they declined. */
const loginDeclinedInstruction = (decline: LoginDecline) =>
  `The owner chose not to sign in: ${decline === "no_account" ? "they have no account on this site" : "they want only what the site shows without signing in"}. This is their answer, not an error. Never ask for a login again and never call execute purpose authenticate in this build. Build the part of the request the site shows without signing in. If that part is missing, or much less than the request asks for, ask the owner with request_input before you build: say that without signing in the site shows only what you found, name it, and offer to continue with that or stop. If they choose to stop, or the build cannot go on without signing in, end with report_blocked reason owner_declined.`;

/**
 * What a write does once it runs signed out, as a guest of a site that offers its task without an
 * account: its act steps, where a read runs its example and live tests.
 */
const signedOutWrite =
  "Do the write as a guest through purpose act steps, then publish without signing in. Build only the part of the request the site offers signed out";

/** What the minter hears about signing in once the build gave it up. */
const signInAbandonedInstruction = (effect: "read" | "write" | "ask") =>
  `This build gave up signing in and runs signed out: no sign-in runs and no login is asked for. Never call execute purpose authenticate again. ${effect === "write" ? signedOutWrite : "Explore, run the example and live tests, and publish from the part of the request the site shows signed out"}; when that part is missing or much less than asked, ask the owner with request_input whether to continue with it or stop.`;

/** The answer every authenticate gets once the owner declined to sign in. */
const loginDeclinedAnswer = (decline: LoginDecline) =>
  JSON.stringify({
    status: "login_declined",
    declined: decline,
    userInputRequired: false,
    instruction: loginDeclinedInstruction(decline),
  });

/**
 * The typed ending of an unpublished outcome its own fields name, or undefined: a published build,
 * and a blocked ending with its own record (`new_mint_recommended`, `not_supported_yet`), have
 * none. An ending the harness names when it records it (`account_locked`,
 * `final_text_without_tool`) is set there and kept.
 */
const stopReasonOf = (
  outcome: Pick<
    MintOutcome,
    "build" | "blocked" | "recoveryReason" | "rejectedCredential" | "hostFailure" | "stopReason"
  >,
  noResponse: MintOutcome["noResponse"],
  modelFailure: MintFailure | undefined,
): MintStopReason | undefined => {
  if (outcome.build === "published") return undefined;
  if (outcome.stopReason !== undefined) return outcome.stopReason;
  const blocked = outcome.blocked?.reason;
  if (blocked !== undefined)
    return blocked === "new_mint_recommended" || blocked === "not_supported_yet"
      ? undefined
      : blocked;
  if (noResponse !== undefined) return "question_unanswered";
  // A login check the host could not run is the host's, not the sign-in's.
  if (outcome.recoveryReason === "login_check_unavailable") return "host_unavailable";
  if (outcome.recoveryReason !== undefined || outcome.rejectedCredential !== undefined)
    return "sign_in_failed";
  if (outcome.hostFailure === "model_quota_exhausted") return "model_quota_exhausted";
  if (outcome.hostFailure !== undefined) return "host_unavailable";
  if (modelFailure?.turnBudgetSpent === true) return "turn_budget_spent";
  return undefined;
};

const loginRequestInstruction = (login: "held" | "supplied" | "inspect" | "unavailable") =>
  login === "inspect"
    ? "Inspect the website's current sign-in screen, then call execute purpose authenticate with target liveBrowser and signInStep describing its observed fields. The host asks privately for only the missing fields after verifying them. Never ask for credentials yourself."
    : login === "unavailable"
      ? "This asks for a website login, which only the host requests, and this build cannot be given one. Do not ask for it again; continue without it or end the attempt and say why."
      : "This asks for a website login, which only the host requests. The host now holds a login for this site: call execute purpose authenticate with target liveBrowser. Never ask for passwords, usernames or logins yourself.";

/**
 * What a minter hears, on a host that publishes on the site's own no (`publishOnRefusal`), when
 * its write session has not yet shown a write: that no to the example's valid inputs is the
 * example's answer, and how to publish on it.
 */
const siteRefusalPublication =
  "If the site said in its own words that it declines the example's valid inputs before any save (not a field error on your fill, a failed page or a challenge), such as a product it does not offer for these facts, that no is the example's answer: the act step returns it right after reading it, before entering any commit mark, as a refusal its output schema declares (`status` `\"refused\"`, a listed `reason` and `site_message`). Compose the whole path the request asks for, with that refusal in its output schema, list every save step in write.commits and again in write.commitsUnproven each one the session never reached, and call finish_build naming that act step. Keep the caller's facts as given.";

/** One coding flow. Durable dispatch claims, leases, authority and cleanup belong to the host. */
export const runMint = (input: unknown): Effect.Effect<MintOutcome, MintFailure, MintServices> =>
  Effect.scoped(
    Effect.gen(function* () {
      const request = yield* decode(MintRequest, input);
      yield* Effect.try({
        try: () =>
          JSON.stringify(request, (key, value: unknown) => {
            if (key === "website_auth" || key === "websiteAuth") throw new Error("private_input");
            return value;
          }),
        catch: (error) =>
          new MintFailure({
            failureDetail: failureDetail("mint_host_dependency_failed", {
              operation: "JSON.stringify",
              phase: "request_validation",
              error,
            }),
            code: "InvalidRequest",
          }),
      });
      const dependencies = yield* MintServices;
      const redactCallerText = dependencies.redactCallerText ?? ((text: string) => text);
      const reportFailure = (error: unknown, details: MintReportContext) =>
        dependencies.reporting?.failure(error, details) ?? Effect.void;
      const reportBestEffort = (effect: Effect.Effect<void, Error>, details: MintReportContext) =>
        dependencies.reporting?.bestEffort(effect, details) ??
        effect.pipe(
          Effect.catchAll((error) =>
            diagnose({
              operation: details.operation,
              ...(details.phase === undefined ? {} : { phase: details.phase }),
              ...failureDetailMetadata(
                new MintFailure({
                  code: "Unavailable",
                  failureDetail: failureDetail("mint_host_dependency_failed", {
                    operation: details.operation,
                    ...(details.phase === undefined ? {} : { phase: details.phase }),
                    error,
                  }),
                }),
              ),
            }),
          ),
        );
      const recovered = dependencies.agentRecovery?.initial?.harness;
      const finished: { build?: MintOutcome["build"] } = {};
      yield* Effect.addFinalizer((exit) =>
        dependencies.attemptFinished === undefined
          ? Effect.void
          : dependencies.attemptFinished(
              Exit.isFailure(exit)
                ? Cause.isInterruptedOnly(exit.cause)
                  ? "interrupted"
                  : "failed"
                : finished.build === "published"
                  ? finished.build
                  : "incomplete",
            ),
      );
      // An unanswered Dashboard build only asks its effect question. It is always the first turn.
      const effectQuestion = request.effect === "ask";
      if (effectQuestion && dependencies.capabilityQuestion)
        return yield* new MintFailure({ code: "ScopeDenied" });
      const toolScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(toolScope, Exit.void));
      const runTool = yield* FiberSet.makeRuntimePromise().pipe(
        Effect.provideService(Scope.Scope, toolScope),
      );
      const initialPrompt = yield* screenMintText(dependencies, {
        ...request,
        siteOrigin: undefined,
      });
      const businessInputTypes = dependencies.capabilityQuestion
        ? undefined
        : yield* Effect.gen(function* () {
            const types = yield* Effect.try({
              try: () => jsonTypeTree(request.businessInput),
              catch: (error) =>
                new MintFailure({
                  failureDetail: failureDetail("mint_host_dependency_failed", {
                    operation: "jsonTypeTree",
                    phase: "business_input_types",
                    error,
                  }),
                  code: "InvalidRequest",
                }),
            });
            const screened = yield* screenMintText(dependencies, types);
            return yield* Effect.try({
              try: () => JSON.parse(screened) as unknown,
              catch: (error) =>
                new MintFailure({
                  failureDetail: failureDetail("mint_host_dependency_failed", {
                    operation: "JSON.parse",
                    phase: "business_input_types",
                    error,
                  }),
                  code: "Unavailable",
                }),
            });
          });
      // The job's own site origin is routing data the agent may see (decided 2026-09-26).
      const site =
        request.siteOrigin === undefined
          ? { available: false as const }
          : {
              available: true as const,
              siteOrigin: request.siteOrigin,
              loginRouting: "kernel_domain_discovery" as const,
              instruction:
                "The host already owns this exact site origin; do not ask the user to repeat it. Never use opaque or withheld text as a URL. Pass loginUrl on authenticate with the sign-in page you observed; the host uses it exactly as given, query and one-time values included. Without it, sign-in starts from the page the browser is on, else Kernel discovery.",
            };
      const serial = yield* Effect.makeSemaphore(1);
      const prompt = initialPrompt;
      const executions: ExecutionEvidence[] = [
        ...new Map(
          [
            ...(recovered?.executions ??
              (dependencies.initialExample ? [dependencies.initialExample] : [])),
            ...(dependencies.priorReadExecutions ?? []),
          ].map((entry) => [entry.executionId, entry]),
        ).values(),
      ];
      const diagnostics: string[] = [...(recovered?.diagnostics ?? [])];
      let unavailableOutputRefusals = recovered?.unavailableOutputRefusals ?? 0;
      const purposes = new Map<string, ExecutionRequest["purpose"] | "command">(
        (
          recovered?.purposes ??
          (dependencies.initialExample
            ? [
                {
                  executionId: dependencies.initialExample.executionId,
                  purpose: "example" as const,
                },
              ]
            : [])
        ).map((entry) => [entry.executionId, entry.purpose]),
      );
      for (const receipt of dependencies.priorReadExecutions ?? [])
        purposes.set(receipt.executionId, "example");
      /** The task revision each execution ran under, when an update had applied before it. */
      const revisions = new Map<string, number>(
        (recovered?.purposes ?? []).flatMap((entry) =>
          entry.taskRevision === undefined ? [] : [[entry.executionId, entry.taskRevision]],
        ),
      );
      let example: ExecutionEvidence | undefined =
        recovered?.exampleId === undefined
          ? executions.findLast((entry) => purposes.get(entry.executionId) === "example")
          : executions.find((entry) => entry.executionId === recovered.exampleId);
      let exampleClaimed =
        (recovered?.exampleClaimed ?? false) || (dependencies.exampleClaimed ?? false);
      // The effective task: the original request with each update the host applied. A takeover
      // restores it from the checkpoint.
      let taskState: TaskState = recovered?.taskState ?? {
        revision: 0,
        effect: request.effect === "write" ? "write" : "read",
        ...(request.siteOrigin === undefined ? {} : { siteOrigin: request.siteOrigin }),
        businessInput: request.businessInput,
        updates: [],
      };
      // The build's effect and read authority. A `mint_update` the caller confirmed may turn a
      // read build into a write build mid-build, which switches both in place.
      let buildEffect = taskState.effect === "write" ? ("write" as const) : request.effect;
      let repeatableRead = buildEffect !== "write" && dependencies.repeatableRead === true;
      /** The caller's answers this build may cite as confirmation, by question id. */
      const answeredQuestions = new Map<string, AnsweredQuestion>(
        (recovered?.answeredQuestions ?? []).map(({ id, answer }) => [id, answer]),
      );
      /**
       * The review each confirm question the minter marked with `confirmsReview` named, by the
       * question's id, once asked: an id names one review, so an answer under it binds to that one.
       */
      const confirmAsks = new Map<string, string>();
      /**
       * Whether the owner's latest request_input kept an answer Guardian reads, with no other call
       * through the turn's actions since: what `owner_ended` stands on. A secret or sign-in answer
       * is never kept.
       */
      let ownerAnsweredLast = false;
      /**
       * The ids of answered questions that asked whether to end the build (`endsBuild`), and whether
       * the owner's latest answers said no to each such question there, which means keep going. A
       * takeover reads answers from before it as plain confirms; a question the build resumes on
       * keeps its mark.
       */
      const endsBuildQuestions = new Set<string>();
      let ownerKeptGoing = false;
      // A write build's one live session: its first act step takes the example claim and the
      // step that records the site's confirmation closes it. A takeover restores this session;
      // an unrelated attempt with an existing claim keeps it closed.
      let writeSession: "none" | "open" | "closed" =
        recovered?.writeSession ?? (exampleClaimed ? "closed" : "none");
      const availabilityMetadata = () => {
        const executionAvailability = dependencies.executionAvailability?.();
        return executionAvailability === undefined ? {} : { executionAvailability };
      };
      const availabilityInstruction = () => {
        if (executionClosed)
          return "Live execution has ended for this attempt, but its eligible retained receipt can still be published: call finish_build with that receipt's executionId while the source it ran is unchanged; do not execute again. Any source correction, the schemas included, needs a fresh example, which needs live execution, so end with report_blocked reason host_unavailable, never policy. request_input is still available when publication needs something only the user knows. ";
        switch (dependencies.executionAvailability?.()) {
          case "host_unavailable":
            return "The execution host is unavailable. End this attempt; preserve existing receipts and unresolved effects. Source edits or user input cannot restore this host. ";
          case "open":
          case undefined:
            return "Fresh reads require both existing authority and an available host; repeatableRead is not a promise of lifecycle capacity. ";
        }
      };
      // The trusted host notice about its entry page. It lives in the request
      // context, never the agent instructions, and is repeated only when it changes,
      // the host's own instruction included. The host supplies it only for a fresh
      // entry, never for a resumed page.
      let shownEntryState: string | undefined;
      const entryNotice = () => {
        const current = dependencies.entryNavigation?.();
        if (current === undefined) return undefined;
        const notice =
          current.state === "replaced"
            ? {
                state: current.state,
                requestedUrl: current.requestedUrl,
                page: current.page,
                reason: current.reason,
                instruction:
                  current.reason === "recovery"
                    ? current.page === undefined
                      ? "The host replaced the browser in this same attempt after a failure (see that execution's proxyNotice or browserRecovery), on a new, empty profile. Read page.url() before acting and navigate from there."
                      : "The host replaced the browser in this same attempt after a failure (see that execution's proxyNotice or browserRecovery) and, because this is a read, reopened the last page the site served the previous browser; page is where it landed. The new browser has a new, empty profile. Read page.url() and the page before acting and continue from there."
                    : current.page === undefined
                      ? "The host signed in on a new browser from the site's saved profile, in this same attempt. Read page.url() before acting and navigate from there."
                      : "The host signed in on a new browser from the site's saved profile, in this same attempt, and opened it on page: the page you were on, or the login page when that did not load. Read page.url() before acting and continue from there.",
                ...(current.instruction === undefined ? {} : { instruction: current.instruction }),
              }
            : current.state === "opened"
              ? {
                  state: current.state,
                  outcome: current.outcome,
                  requestedUrl: current.requestedUrl,
                  resolvedUrl: current.resolvedUrl,
                  ...(current.status === null ? {} : { status: current.status }),
                  instruction:
                    current.outcome === "ready"
                      ? "The trusted host already loaded this exact requested page before you started; the browser is at resolvedUrl. Do not navigate to the entry URL again or guess a homepage; start from the current page."
                      : (current.instruction ??
                        "The trusted host already loaded the requested page before you started, but the site answered with an HTTP error status. Inspect the current page before assuming its content; do not navigate to the entry URL again."),
                }
              : current.reason === "prior_effect"
                ? {
                    state: current.state,
                    outcome: current.outcome,
                    reason: current.reason,
                    requestedUrl: current.requestedUrl,
                    instruction:
                      "The host did not open the requested page, because an earlier attempt of this build already ran on the website. The browser is not on requestedUrl; read page.url() before acting. Navigate to requestedUrl yourself when the task needs it, after reading back whether a write an earlier attempt may have made already happened.",
                  }
                : {
                    state: current.state,
                    outcome: current.outcome,
                    requestedUrl: current.requestedUrl,
                    instruction:
                      "Host entry navigation did not reach the requested page. Do not assume the browser is on requestedUrl; read page.url() before acting.",
                  };
        // The caller's own page URLs are shown exactly; they are never masked.
        return current.state === "opened" && current.egressProxy !== undefined
          ? {
              ...notice,
              egressProxy: current.egressProxy,
            }
          : notice;
      };
      const changedEntryNotice = (): { readonly hostEntryNavigation?: object } => {
        const current = dependencies.entryNavigation?.();
        const state =
          current === undefined
            ? undefined
            : `${current.state}:${"outcome" in current ? current.outcome : ""}:${"reason" in current ? current.reason : ""}:${"page" in current ? (current.page ?? "") : ""}:${"instruction" in current ? (current.instruction ?? "") : ""}`;
        if (state === undefined || state === shownEntryState) return {};
        const notice = entryNotice();
        shownEntryState = state;
        return notice === undefined ? {} : { hostEntryNavigation: notice };
      };
      const executionContext = () =>
        Effect.gen(function* () {
          const retainedExecutions = yield* Effect.forEach(executions, (entry) =>
            decode(VisibleReceipt, {
              executionId: entry.executionId,
              status: entry.status,
              effect: entry.effect,
            }).pipe(
              Effect.map((receipt) => ({
                ...receipt,

                purpose: purposes.get(entry.executionId),
                repairPublicationAllowed:
                  dependencies.canPublishRepair?.(entry.executionId) === true,
              })),
            ),
          );
          return {
            repeatableRead,
            ...availabilityMetadata(),
            exampleClaimed,
            ...(writeSession === "none" ? {} : { writeSession }),
            retainedExecutions,
            instruction:
              availabilityInstruction() +
              "These are host-owned execution references, distinct from invocation and attempt IDs. Do not ask the user for internal receipt IDs. Failed receipts do not establish a successful current result. With repeatableRead:true and an available live host, use purpose explore for current read-only observations and purpose example for a fresh reviewed execution of the corrected read under the original input/account after confirmed executor cleanup. Purpose inspect is the separate reconciliation protocol for prior uncertain effects, not the generic browser-probe mode. Otherwise preserve the dispatch fence and reconcile current state; repairPublicationAllowed permits future source review, not replay or a claim that the original action failed.",
          };
        });
      let terminal: MintHarnessSnapshot["terminal"] = recovered?.terminal;
      /**
       * The last sign-in's failure while no later authenticate has started, and whether a final
       * answer already got its guidance back.
       */
      let unresolvedSignIn:
        | {
            readonly failure: SignInDiagnostic;
            readonly spent: SpentSignIn | undefined;
            guided: boolean;
          }
        | undefined;
      /**
       * The build's latest sign-in is unconfirmed: a sign-in step that may have sent the login,
       * with no later check that confirmed it, on the build's current site. A step that sent
       * nothing, a check that found the site not signed in included, leaves it as it was; a
       * takeover keeps it, and a move to another site clears it.
       */
      let signInUnconfirmed = recovered?.signInUnconfirmed === true;
      /**
       * Updates `signInUnconfirmed` once an authenticate ends, by what it did; a confirmed sign-in
       * also clears `signInRefusalOnly`.
       */
      const noteSignIn = (
        exit: Exit.Exit<ExecutionEvidence, MintFailure>,
        crossedDispatch: boolean,
      ) => {
        if (Exit.isSuccess(exit)) {
          const { authentication, effect } = exit.value;
          if (authentication?.state === "authenticated") {
            signInUnconfirmed = false;
            signInRefusalOnly = false;
          } else if (effect !== "not_sent") {
            signInUnconfirmed = true;
            loginSentSinceHostRefusals();
          }
          return;
        }
        // One that failed past its dispatch fence may have sent the login, unless it says it
        // sent nothing: a login the owner declined, a screen the host refused before anything
        // went out, or a stop before anything reached the site.
        const failure = Cause.isFailType(exit.cause) ? exit.cause.error : undefined;
        if (
          crossedDispatch &&
          failure?.loginDeclined === undefined &&
          failure?.authentication?.nothingSubmitted !== true &&
          failure?.execution?.dispatch !== "not_sent"
        ) {
          signInUnconfirmed = true;
          // The host's own refusal of this authenticate is no later login sent after it.
          if (!(failure !== undefined && hostSignInRefusal(failure))) loginSentSinceHostRefusals();
        }
      };
      /**
       * The host's identical refusals in a row while typing into a sign-in screen: the latest
       * and how many. An authenticate that ends any other way clears it.
       */
      let hostRefusals: { readonly refusal: HostRefusal; readonly count: number } | undefined;
      /** `hostRefusals` before the running authenticate, which a refusal of its own extends. */
      let priorHostRefusals: typeof hostRefusals;
      /**
       * Guardian's correctable denials in a row of one unchanged sign-in step: the step as sent
       * and how many. An authenticate that ends any other way clears it; a step that runs nothing,
       * such as one the host refuses before review, leaves it as it was.
       */
      let signInDenials: { readonly step: string; readonly count: number } | undefined;
      /** `signInDenials` before the running authenticate, which a denial of its own extends. */
      let priorSignInDenials: typeof signInDenials;
      /** The running execute's sign-in step as sent, serialized; undefined for any other. */
      let sentSignInStep: string | undefined;
      /**
       * Sign-in is unavailable in this build: the answer that said so, which a later authenticate
       * gets again, and the outcome the build ends with. A retained receipt that may still
       * publish holds the outcome back until the model stops.
       */
      let signInUnavailable: MintHarnessSnapshot["signInUnavailable"] =
        recovered?.signInUnavailable;
      /** The model gave a final answer while sign-in was unavailable, which stops it. */
      let modelStoppedForSignIn = false;
      // A question to the build's owner went unanswered; the build ends as no_response.
      let noResponse = recovered?.noResponse;
      let unavailableCauseRecorded = recovered?.unavailableCauseRecorded ?? false;
      // Resubmissions after a review outage, per kind; recorded for diagnosis only. The host
      // already retried each review with backoff, so only an outage that outlasts
      // `reviewOutageBudgetMs` with no review completing ends the attempt.
      const reviewUnavailableRetries = {
        execution: 0,
        publication: 0,
        question: 0,
        update: 0,
        ...recovered?.reviewUnavailableRetries,
      };
      /** When the current run of review outages began; cleared by any completed review. */
      let reviewOutageStartedAt = recovered?.reviewOutageStartedAt;
      /**
       * Reviews that ended `InvalidOutcome` in this attempt. Guardian already corrected each once
       * in the review, so a second ends the attempt even while other reviews complete.
       */
      let invalidOutcomes = recovered?.invalidOutcomes ?? 0;
      /** The pending review outage is a blocked explanation's, which report_blocked resubmits. */
      let blockedReviewUnavailable = recovered?.blockedReviewUnavailable === true;
      const reviewCompleted = Effect.sync(() => {
        reviewOutageStartedAt = undefined;
        blockedReviewUnavailable = false;
      });
      /** A failure that shows Guardian decided: a deny, or an execution it allowed. */
      const reviewDecided = (error: MintFailure) =>
        error.code === "ReviewDenied" ||
        error.review !== undefined ||
        error.execution !== undefined;
      /**
       * Guardian refused an execution with a refusal it did not mark `correctable`, or refused a
       * publication for a reason no correction gets past, in this attempt. A publication denial
       * that names a correction is not one, nor is a correctable execution refusal.
       */
      let guardianRefused = recovered?.guardianRefused === true;
      /**
       * Every refusal `guardianRefused` stands on is Guardian's of an authenticate step, and no
       * sign-in on the current site confirmed after it: the build never got past signing in, so a
       * blocked report that stands only on it ends as sign-in unavailable. Once cleared, it stays
       * cleared for the rest of the attempt: a later refusal of a sign-in leaves `guardianRefused`
       * standing on the earlier one too, so the report keeps its own ending.
       */
      let signInRefusalOnly = recovered?.signInRefusalOnly === true;
      /**
       * Guardian's refusals of an act step in a row in this attempt, deny or escalate, with no act
       * step it allowed since. At `actRefusalsForPolicy` a policy block stands on them. A takeover
       * starts the count again.
       */
      let actRefusalsInRow = 0;
      /**
       * A host check refused a step the build needs in this attempt: a publication its checks
       * refused, a sign-in the host refused, or a task update the host refused. A `host_refused`
       * block stands on it. A later finish_build that gets past the host's checks to Guardian's
       * review clears it, setting `hostRefusalPassed`.
       */
      let hostRefused = recovered?.hostRefused === true;
      /**
       * Each host check whose refusal `hostRefused` stands on, in the order they refused, once each
       * (`MintHarnessSnapshot.hostRefusalSources`): the check, undefined when a checkpoint kept the
       * refusal without a source this worker can read (`unrecorded`), and whether a later
       * authenticate may have sent the login since (`beforeSignIn`), after which a sign-in step's
       * refusal is no longer the latest sign-in event.
       */
      let standingHostRefusals: {
        readonly refusal: HostRefusalSource | undefined;
        beforeSignIn: boolean;
      }[] = hostRefused ? restoredHostRefusals(recovered?.hostRefusalSources) : [];
      /**
       * Records a host check's refusal of a step the build needs. The same check refusing again
       * moves to the end, as a refusal after any login sent since.
       */
      const refuseByHost = (refusal: HostRefusalSource) => {
        hostRefused = true;
        const key = JSON.stringify(refusal);
        standingHostRefusals = [
          ...standingHostRefusals.filter((standing) => JSON.stringify(standing.refusal) !== key),
          { refusal, beforeSignIn: false },
        ];
      };
      /** A later authenticate may have sent the login after every host refusal standing now. */
      const loginSentSinceHostRefusals = () => {
        for (const standing of standingHostRefusals) standing.beforeSignIn = true;
      };
      /**
       * A host check refused a step earlier in this attempt, and a later finish_build got past the
       * host's checks to Guardian's review, so no host refusal stands until another is recorded.
       */
      let hostRefusalPassed = recovered?.hostRefusalPassed === true;
      /**
       * The reasons of host refusals whose named step a `host_refused` report was already sent
       * back to (`namedStepReasons`), so the next report on the same reason is taken. Kept in
       * memory only: a takeover may send one report back once more.
       */
      const namedStepsOffered = new Set<string>();
      /**
       * The latest screened instruction each refusal in `namedStepReasons` gave the minter, which
       * a `host_refused` report sent back to its step repeats.
       */
      const namedStepInstructions = new Map<string, string>();
      /**
       * The screened review rationale the latest host refusal of each reason in
       * `namedStepReasons` or `rationaleStepReasons` carried, which a `host_refused` report sent
       * back to its step repeats. A refusal that carries none removes its reason's.
       */
      const namedStepRationales = new Map<string, string>();
      /**
       * The latest finish_build sent again, unchanged, a submission the host had already refused,
       * after a finish_build got past that refusal to Guardian's review: the same refusal, which
       * set no host refusal again. The next finish_build clears it.
       */
      let hostRefusalRepeated = false;
      /**
       * The host's latest answer to `signInDestinationRefused`, read after each authenticate: it
       * refused a sign-in screen at its destination check, as a step result, and nothing it
       * counts cleared that since. A `host_refused` block stands on it. A takeover restores it, so
       * a successor whose host kept no record of the refusal still has it until its own next
       * authenticate.
       */
      let signInDestinationRefused = recovered?.signInDestinationRefused === true;
      /**
       * This build's Guardian denials, the oldest first to go past the bound, for the blocked
       * explanation's review; a takeover restores them. A checkpoint from an older worker kept
       * none, so the ledger is partial from then on.
       */
      const ledgerDenials: LedgerDenial[] = [...(recovered?.decisionLedger?.denials ?? [])];
      let omittedLedgerDenials = recovered?.decisionLedger?.omittedDenials ?? 0;
      const ledgerPartial =
        recovered !== undefined &&
        (recovered.decisionLedger === undefined || recovered.decisionLedger.partial === true);
      const recordDenial = (denial: Omit<LedgerDenial, "decidedAt" | "omittedFindings">) =>
        Effect.gen(function* () {
          const findings = denial.findings ?? [];
          ledgerDenials.push({
            ...denial,
            decidedAt: yield* Clock.currentTimeMillis,
            rationale: capped(denial.rationale, ledgerBounds.rationaleChars),
            ...(findings.length === 0
              ? {}
              : {
                  findings: findings
                    .slice(0, ledgerBounds.findings)
                    .map((finding) => capped(finding, ledgerBounds.findingChars)),
                }),
            ...(findings.length > ledgerBounds.findings
              ? { omittedFindings: findings.length - ledgerBounds.findings }
              : {}),
          });
          const over = ledgerDenials.length - ledgerBounds.denials;
          if (over > 0) {
            ledgerDenials.splice(0, over);
            omittedLedgerDenials += over;
          }
        });
      /**
       * The host's refusals of a live test batch or an execution in this attempt, the latest kept,
       * for the same review. A takeover starts them again.
       */
      const ledgerHostRefusals: NonNullable<DecisionLedger["hostRefusals"]>[number][] = [];
      const recordHostRefusal = (tool: "live_tests" | "execute", code: string, reason: unknown) =>
        Effect.gen(function* () {
          const screened = yield* screenMintText(dependencies, reason).pipe(
            Effect.orElseSucceed(() => "[reason withheld]"),
          );
          ledgerHostRefusals.push({
            tool,
            code,
            reason: capped(screened, ledgerBounds.rationaleChars),
            atUtc: new Date(yield* Clock.currentTimeMillis).toISOString(),
          });
          if (ledgerHostRefusals.length > ledgerBounds.hostRefusals) ledgerHostRefusals.shift();
        });
      /** Unanswered questions handed back to the minter in this build, up to the limit. */
      let noAnswerHandBacks = recovered?.noAnswerHandBacks ?? 0;
      /**
       * The host obtained a login partway (`requestLogin` answered `supplied` or `held`): an
       * unanswered question asked after it ends the build instead of going back.
       */
      let loginHeld = recovered?.loginHeld === true;
      /** The owner declined a login: no sign-in runs, and every authenticate hears why. */
      let loginDeclined = recovered?.loginDeclined;
      /** The build gave up signing in; see `MintHarnessSnapshot.signInAbandoned`. */
      let signInAbandoned = recovered?.signInAbandoned === true;
      let destinationEvidenceRefusals = recovered?.destinationEvidenceRefusals ?? 0;
      let inputFeedbackRounds = recovered?.inputFeedbackRounds ?? 0;
      /** The last input-feedback review found a tool already public, which never falls back. */
      let inputFeedbackPublicTool = recovered?.inputFeedbackPublicTool ?? false;
      /** The screened coverage of the last candidate Guardian returned input feedback for. */
      let inputFeedbackCoverage = recovered?.inputFeedbackCoverage ?? "";
      /** The last completed publication review's input feedback, while no later review replaced it. */
      let inputFeedbackReview = recovered?.inputFeedbackReview;
      /** Guardian's finite reason when the latest publication was a completed denial. */
      let publicationDenial = recovered?.publicationDenial;
      const destinationEvidenceInstruction = {
        no_route_evidence:
          "This example recorded no route of its own, so there is no route evidence to publish with.",
        sign_in_route_evidence:
          "No verified sign-in's routes cover this example: no sign-in ran in this build, the example ran with a different selected login URL than the sign-in used, or the sign-in recorded no routes. Call execute with purpose authenticate to sign in, then run the example again.",
        inconsistent_route_evidence:
          "The recorded route evidence is inconsistent, for example more than 64 routes.",
        receipt_mismatch: "The recorded route evidence belongs to other source than this receipt.",
        unknown: "The recorded route evidence cannot support publication.",
      };
      // Executions the provider failed, for diagnosis; like review outages, only an outage that
      // outlasts its budget with no execution completing closes live execution.
      let providerUnavailableRetries = recovered?.providerUnavailableRetries ?? 0;
      let providerOutageStartedAt = recovered?.providerOutageStartedAt;
      const reviewOutageBudgetMs = dependencies.reviewOutageBudgetMs ?? 15 * 60_000;
      const unavailableHostTerminal = () => {
        const cause = dependencies.unavailableHostCause?.();
        if (!unavailableCauseRecorded) {
          unavailableCauseRecorded = true;
          // The terminal diagnostics always name the host's own first cause, so a stop after the
          // last successful tool call is never recorded without one.
          const stopped = dependencies.hostUnavailableCause?.();
          if (cause !== undefined)
            for (const entry of cause.diagnostics) diagnostics.push(JSON.stringify(entry));
          else
            diagnostics.push(
              JSON.stringify({
                phase: "host",
                hostFailure: "host_unavailable",
                cause: stopped,
              }),
            );
        }
        return {
          build: "incomplete" as const,
          // A policy failure of background traffic is the site's doing, not infrastructure's.
          ...(cause === undefined ? { hostFailure: "host_unavailable" as const } : {}),
          summary:
            cause === undefined
              ? "Execution infrastructure is unavailable. Preserve recorded effects and reconcile possible dispatch before further execution."
              : `Execution infrastructure is unavailable because background browser traffic failed a policy check${cause.reason === undefined ? "" : ` (${cause.reason})`}. Diagnostics list any earlier execution failure first; the later check does not explain that earlier failure. Preserve recorded effects and reconcile possible dispatch before further execution.`,
        };
      };
      /**
       * Publishes the last candidate whose review found only input feedback, privately and
       * flagged, and settles the build. Nothing publishes for a tool that is already public or
       * when that publication fails; the build then ends incomplete, naming which. A host with no
       * fallback ends the build incomplete with the last review's categories and rationale.
       */
      const settleUnresolvedInputFeedback = Effect.gen(function* () {
        const fallback = dependencies.inputFeedbackFallback;
        // With no fallback the build ends unpublished, with the last review's findings.
        if (fallback === undefined) {
          if (inputFeedbackReview !== undefined)
            terminal = {
              build: "incomplete",
              summary: unresolvedInputFeedbackSummary(undefined, inputFeedbackReview),
            };
          return false;
        }
        const outcome = yield* Effect.either(fallback.publish);
        if (outcome._tag === "Left") {
          terminal = { build: "incomplete", summary: unresolvedInputFeedbackSummary(outcome.left) };
          yield* recordDecision({
            outcome: "refused",
            code: outcome.left.code,
            reason: "input_feedback_unresolved",
            failedChecks: refusalChecks(outcome.left),
            recovery: "ended",
          });
          yield* diagnose({
            phase: "publication",
            reason: "input_feedback_unresolved",
            code: outcome.left.code,
            failureReason: outcome.left.reason,
          });
          return false;
        }
        const published = outcome.right;
        if (published === undefined) {
          // A later review dropped the candidate; that review's own outcome stands. A public
          // tool keeps its published revision, flagged for its next maintenance.
          if (inputFeedbackPublicTool) {
            yield* fallback.flagPublished;
            terminal = {
              build: "incomplete",
              summary: unresolvedInputFeedbackSummary("public_tool"),
            };
          }
          return false;
        }
        for (const gap of published.diagnostics) {
          const diagnostic = JSON.stringify(gap);
          if (!diagnostics.includes(diagnostic)) diagnostics.push(diagnostic);
        }
        terminal = {
          build: "published",
          publicationRef: published.publicationRef,
          summary: `${inputFeedbackCoverage} Published for this account only and flagged: Guardian's input feedback (${published.categories.join(", ")}) was not resolved.`,
        };
        yield* recordDecision({
          outcome: "published",
          code: "Published",
          failedChecks: [],
          recovery: "none",
        });
        return true;
      });
      // Publication reads workspace files and retained results, never the browser or executor.
      // Once live execution ends, a retained publishable receipt keeps the attempt open for
      // source correction and finish_build instead of ending it.
      let executionClosed = recovered?.executionClosed ?? false;
      // A read repair's example that refused the caller's own value, listing the choices the
      // page offers, shows the tool now behaves correctly; maintenance cannot change the input.
      const refusedWithChoices = (entry: ExecutionEvidence) =>
        request.mode === "maintenance" &&
        buildEffect !== "write" &&
        purposes.get(entry.executionId) === "example" &&
        entry.status === "failed" &&
        (entry.refusal?.available.length ?? 0) > 0;
      const publishableReceipt = () =>
        executions.some(
          (entry) =>
            refusedWithChoices(entry) ||
            ((purposes.get(entry.executionId) === "example" ||
              purposes.get(entry.executionId) === "act") &&
              entry.status === "completed" &&
              entry.resultRef !== undefined) ||
            (purposes.get(entry.executionId) === "act" &&
              (entry.confirmation !== undefined || entry.withheldConfirmation !== undefined)) ||
            dependencies.canPublishRepair?.(entry.executionId) === true,
        );
      const hostIsUnavailable = () => dependencies.executionAvailability?.() === "host_unavailable";
      /** Ends live execution; the attempt itself ends only without a publishable receipt. */
      const closeExecution = () => {
        if (terminal === undefined && publishableReceipt()) executionClosed = true;
        else terminal ??= unavailableHostTerminal();
      };
      const stopUnavailableHost = (afterModel = false) => {
        if (!hostIsUnavailable()) return false;
        if (!afterModel && terminal === undefined && publishableReceipt()) {
          executionClosed = true;
          return false;
        }
        const unavailable = unavailableHostTerminal();
        terminal ??= unavailable;
        return true;
      };
      const stopRevokedAttempt = () => {
        if (!dependencies.attemptRevoked?.()) return false;
        if (terminal === undefined) {
          terminal = {
            build: "incomplete",
            summary:
              "This attempt stopped or lost its lease. Earlier execution receipts and unresolved effects remain retained; no further model or tool work is allowed.",
          };
          diagnostics.push(JSON.stringify({ phase: "attempt", reason: "stopped" }));
        }
        return true;
      };
      const active = (use: "execution" | "publication" = "execution") =>
        Effect.suspend(() =>
          terminal
            ? Effect.fail(new MintFailure({ code: "AlreadyExecuted" }))
            : stopUnavailableHost()
              ? Effect.fail(new MintFailure({ code: "Unavailable" }))
              : stopRevokedAttempt()
                ? Effect.fail(new MintFailure({ code: "ScopeDenied" }))
                : use === "execution" && executionClosed
                  ? Effect.fail(
                      new MintFailure({ code: "Unavailable", reason: "executor_unavailable" }),
                    )
                  : Effect.void,
        );
      const screenRationale = (rationale: string) =>
        screenMintText(dependencies, rationale).pipe(
          Effect.catchAll((error) =>
            Effect.succeed(
              `Guardian feedback delivery failed during credential screening (${error.code}); consult the protected review trace.`,
            ),
          ),
        );
      /**
       * A review as the minter reads it: the rationale and each finding's explanation screened
       * like any Guardian text, and each finding's file as the minter's workspace names it.
       */
      const minterFindings = (findings: readonly PublicationFinding[]) =>
        Effect.forEach(findings, (finding) =>
          screenRationale(finding.explanation).pipe(
            Effect.map((explanation) => ({
              ...finding,
              file: workspacePath(finding.path),
              explanation,
            })),
          ),
        );
      const minterReview = <
        Review extends {
          readonly rationale: string;
          readonly findings?: readonly PublicationFinding[] | undefined;
        },
      >(
        review: Review,
      ) =>
        Effect.gen(function* () {
          const rationale = yield* screenRationale(review.rationale);
          return review.findings === undefined
            ? { ...review, rationale }
            : { ...review, rationale, findings: yield* minterFindings(review.findings) };
        });
      const screenAssumptions = (proposedAssumptions: PublicationRequest["assumptions"] = []) =>
        Effect.gen(function* () {
          // An assumption that screening would change may carry private data: drop it.
          const assumptions: BuildAssumption[] = [];
          for (const entry of proposedAssumptions ?? []) {
            const subject = yield* screenMintText(dependencies, entry.subject);
            const choice = yield* screenMintText(dependencies, entry.choice);
            if (subject === entry.subject && choice === entry.choice)
              assumptions.push({ kind: "site_default", subject, choice });
          }
          return assumptions;
        });
      const publicationResult = (
        published: MintCompletion,
        coverage: string,
        assumptions: readonly BuildAssumption[] = [],
      ) =>
        Effect.gen(function* () {
          terminal = {
            build: "published",
            ...(published.publicationRef === undefined
              ? {}
              : { publicationRef: published.publicationRef }),
            ...("artifact" in published ? { artifact: published.artifact } : {}),
            summary: coverage,
            ...(assumptions.length === 0 ? {} : { assumptions }),
          };
          return JSON.stringify({
            status: "published",
            ...(published.review === undefined
              ? {}
              : {
                  review: {
                    ...published.review,
                    rationale: yield* screenRationale(published.review.rationale),
                  },
                }),
            ...(published.shareability === undefined
              ? {}
              : {
                  shareability: {
                    ...published.shareability,
                    rationale: yield* screenRationale(published.shareability.rationale),
                  },
                }),
            instruction:
              "Build published for future calls. The current invocation outcome is returned separately; do not execute the example again.",
          });
        });
      /**
       * Records the answer to the host's own question of a question-only turn. Returns the agent's
       * instruction instead when the owner answered the effect question in their own words, which
       * decides nothing.
       */
      const recordInputAnswer = (submitted: AgentInputRequest, answers: ValidAnswers) =>
        Effect.gen(function* () {
          const value = answers[submitted.questions[0]?.id ?? ""]?.value;
          let summary: string;
          if (effectQuestion) {
            const effect = readOrWritePick(submitted, answers);
            if (effect === undefined && value !== undefined)
              return "The owner answered in their own words instead of choosing read or write, so the build's effect is not decided. Ask the read-or-write question again with request_input, its prompt reflecting what they said.";
            if (effect !== "read" && effect !== "write")
              return yield* new MintFailure({ code: "InvalidRequest" });
            if (!dependencies.recordBuildEffect)
              return yield* new MintFailure({ code: "Unavailable" });
            yield* dependencies.recordBuildEffect(effect);
            summary = `The owner chose a ${effect} build.`;
          } else if (dependencies.capabilityQuestion !== undefined) {
            const answer = value;
            if (typeof answer !== "string" || !dependencies.capabilityAnswered)
              return yield* new MintFailure({ code: "Unavailable" });
            yield* dependencies.capabilityAnswered(answer);
            summary = "The owner answered the capability question.";
          } else return undefined;
          terminal ??= { build: "incomplete", summary };
          return undefined;
        });
      /**
       * Keeps each answered question as Guardian reads it, by id, so a later `mint_update` can cite
       * the caller's real answer as confirmation. A protected answer is never kept.
       */
      const keepAnswers = (
        submitted: AgentInputRequest,
        answers: ValidAnswers,
        endsBuild: ReadonlySet<string>,
      ) =>
        Effect.forEach(submitted.questions, (question) =>
          answersForReview({ questions: [question] }, answers, (text) =>
            screenMintText(dependencies, text),
          ).pipe(
            Effect.tap(([entry]) =>
              Effect.sync(() => {
                if (entry === undefined) return;
                answeredQuestions.delete(question.id);
                answeredQuestions.set(question.id, entry);
                if (endsBuild.has(question.id)) endsBuildQuestions.add(question.id);
                else endsBuildQuestions.delete(question.id);
                ownerAnsweredLast = true;
              }),
            ),
          ),
        );
      /**
       * `reported`: the answer came to a question the minter had ended the build on with
       * report_blocked, which a resumed attempt rejoins with it, so the build goes on.
       */
      const inputResult = (
        submitted: AgentInputRequest,
        answers: ValidAnswers,
        endsBuild: ReadonlySet<string>,
        reported = false,
      ) =>
        Effect.gen(function* () {
          const askAgain = yield* recordInputAnswer(submitted, answers);
          yield* keepAnswers(submitted, answers, endsBuild);
          const stopAnswers = submitted.questions.flatMap((question) =>
            endsBuild.has(question.id) ? [answers[question.id]] : [],
          );
          ownerKeptGoing =
            stopAnswers.length > 0 &&
            stopAnswers.every((answer) => answer?.type === "confirm" && !answer.value.confirmed);
          const visibleAnswers = yield* answersForModel(answers);
          acceptedAnswers.push({
            questions: submitted.questions.map((question) => question.prompt),
            answers: visibleAnswers,
          });
          yield* reviewer.taskUpdated("The caller answered a question.");
          const cardQuestion = (id: string) =>
            submitted.questions.some(
              (question) =>
                question.id === id && question.type === "secret" && isCardSlot(question.secretKind),
            );
          const secretIds = Object.entries(answers)
            .filter(([, answer]) => answer.type === "secret")
            .map(([id]) => id);
          const card = secretIds.some(cardQuestion);
          // A card answer never goes into source, so the source handle rule is only for the rest.
          const handles = secretIds.some((id) => !cardQuestion(id));
          const withdrawn = reported
            ? "The caller answered the question you reported unanswered, so the build has not ended. "
            : "";
          if (askAgain !== undefined)
            return JSON.stringify({
              status: "answered",
              answers: visibleAnswers,
              instruction: `${withdrawn}${askAgain}`,
            });
          return JSON.stringify({
            status: "answered",
            answers: visibleAnswers,
            instruction: `${withdrawn}The caller answered. Continue in this attempt with these answers; verify the current page before acting on them, and before any further write.${handles ? " A secret answer is a handle such as {{secret.s1}}, never the value, which you never see. Write the handle exactly as given, as the whole string literal passed as the value to fill, type or pressSequentially, or as a field of a request to this site, in the Playwright code of a kernel.browsers.playwright.execute call in explore, test or act source; the host fills in the value when it runs that source live, and masks it in what comes back. It refuses a handle anywhere else, such as in a variable, a concatenation, a transform, a return value or a navigation. Offline targets get the handle text unchanged. An example and published source never hold a handle: a value the finished tool needs at run time is a declared secret question it asks with ask." : ""}${card ? " A card answer (card_number, card_expiry, card_cvc, billing_postal_code) is never written in source: run an execution with purpose card_fill, target liveBrowser, entrypoint operation/card-fill-step.json and cardFillStep naming each card field's own selector, on the page or inside the payment provider's frame, with the card handle for it; the host types the values and clicks nothing." : ""}`,
          });
        });
      /**
       * A browser execution's screened result as the agent receives it: whole when it fits the
       * threshold, else saved whole through the host's `saveResult` and digested. A command's
       * output, a host without `saveResult` and a save that fails keep the whole result within
       * the threshold and otherwise its first part, never more than the hard cap.
       */
      const deliveredObservations = (
        evidence: ExecutionEvidence,
        purpose: ExecutionRequest["purpose"] | "command",
        observations: string,
      ) =>
        Effect.gen(function* () {
          const save = dependencies.saveResult;
          if (save === undefined || purpose === "command") return boundedResult(observations);
          const path = resultDigestPath(evidence.executionId);
          // A result the digest cannot be built for, such as one nested too deeply, comes back bounded.
          const attempted = yield* Effect.try(() =>
            digestResult(observations, { path, failed: evidence.status !== "completed" }),
          ).pipe(Effect.either);
          if (attempted._tag === "Left") {
            yield* diagnose({
              phase: "execution",
              reason: "result_not_digested",
              executionId: evidence.executionId,
            });
            return boundedResult(observations);
          }
          const digest = attempted.right;
          if (!("file" in digest)) return digest.text;
          const saved = yield* Effect.either(
            Effect.suspend(() => save(path, digest.file)).pipe(
              Effect.catchAllDefect((error) =>
                Effect.fail(
                  new MintFailure({
                    code: "Unavailable",
                    failureDetail: failureDetail("mint_host_dependency_failed", {
                      operation: "saveResult",
                      error,
                    }),
                  }),
                ),
              ),
            ),
          );
          if (saved._tag === "Right") return digest.text;
          yield* diagnose({
            phase: "execution",
            reason: "result_not_saved",
            executionId: evidence.executionId,
            code: saved.left.code,
          });
          return boundedResult(observations);
        });
      /** `handedBack`: the execution's unanswered script question went back to the minter. */
      const visible = (
        evidence: ExecutionEvidence,
        purpose: ExecutionRequest["purpose"] | "command",
        handedBack = false,
      ) =>
        Effect.gen(function* () {
          const siteAccess = siteAccessDiagnostic(evidence);
          const withheld = safeExecutionEvidence(evidence).withheldConfirmation;
          const receipt = yield* decode(VisibleReceipt, {
            executionId: evidence.executionId,
            status: evidence.status,
            effect: evidence.effect,
            ...(evidence.authentication ? { authentication: evidence.authentication } : {}),
            ...(evidence.confirmation === undefined ? {} : { confirmation: evidence.confirmation }),
            ...(withheld === undefined ? {} : { withheldConfirmation: withheld }),
            ...(evidence.preflight === undefined ? {} : { preflight: evidence.preflight }),
            ...(evidence.checks === undefined ? {} : { checks: evidence.checks }),
          });
          // Receipt identifiers are host control metadata, never generated observations.
          // Screening the whole envelope can corrupt IDs and make completion impossible.
          const parsed = yield* Effect.try((): unknown =>
            typeof evidence.observations === "string"
              ? JSON.parse(evidence.observations)
              : evidence.observations,
          ).pipe(Effect.option);
          const observations =
            parsed._tag === "Some"
              ? yield* dependencies.projection.json(parsed.value).pipe(
                  Effect.map((value) => JSON.stringify(value)),
                  Effect.mapError(
                    (error) =>
                      new MintFailure({
                        failureDetail: failureDetail("mint_host_dependency_failed", {
                          operation: "screenJsonObservation",
                          error: error,
                          context: {
                            executionId: evidence.executionId,
                            executionStatus: evidence.status,
                          },
                        }),
                        code: "Unavailable",
                      }),
                  ),
                )
              : yield* screenMintText(dependencies, evidence.observations);
          const delivered = yield* deliveredObservations(evidence, purpose, observations);
          // A script question left unanswered goes back to the agent, which decides how to go on.
          const scriptQuestion =
            evidence.scriptQuestion === undefined && handedBack
              ? { outcome: "unanswered" as const }
              : evidence.scriptQuestion;
          const pathLeft = purpose === "act" ? evidence.writePathRemaining : undefined;
          return JSON.stringify({
            ...receipt,
            ...(withheld === undefined ? {} : { instruction: withheldConfirmationInstruction }),
            ...(pathLeft === undefined || pathLeft.length === 0
              ? {}
              : { writePath: writePathNotice(pathLeft, evidence.confirmation !== undefined) }),
            ...(evidence.review === undefined
              ? {}
              : {
                  review: {
                    ...evidence.review,
                    rationale: yield* screenRationale(evidence.review.rationale),
                    ...(evidence.review.advice === undefined
                      ? {}
                      : { advice: yield* screenRationale(evidence.review.advice) }),
                  },
                }),
            siteAccess,
            ...(scriptQuestion === undefined
              ? {}
              : {
                  scriptQuestion: {
                    ...scriptQuestion,
                    ...("rationale" in scriptQuestion
                      ? { rationale: yield* screenRationale(scriptQuestion.rationale) }
                      : {}),
                    instruction: scriptQuestionInstruction[scriptQuestion.outcome],
                  },
                }),
            repeatableRead,
            ...availabilityMetadata(),
            ...changedEntryNotice(),
            observations: delivered,
          });
        });
      const record = (
        evidence: ExecutionEvidence,
        purpose: ExecutionRequest["purpose"] | "command",
      ) => {
        const safe = safeExecutionEvidence(evidence);
        const referenceOnly = {
          ...safe,
          observations:
            "Private observations are available through the screened execution response.",
        };
        // An execution recorded again, as a resumed attempt's rejoined call is, replaces its entry.
        const recorded = executions.findIndex((entry) => entry.executionId === evidence.executionId);
        if (recorded === -1) executions.push(referenceOnly);
        else executions[recorded] = referenceOnly;
        purposes.set(evidence.executionId, purpose);
        if (taskState.revision > 0) revisions.set(evidence.executionId, taskState.revision);
        if (purpose === "example") example = referenceOnly;
        // The step that recorded the site's confirmation is the build's own write result, once
        // the session entered every mark of its recorded write path; until then it runs on.
        if (
          purpose === "act" &&
          safe.confirmation !== undefined &&
          safe.writePathRemaining === undefined
        ) {
          example = referenceOnly;
          writeSession = "closed";
        }
        if (safe.siteAccess !== undefined)
          diagnostics.push(JSON.stringify({ phase: "site_access", ...safe.siteAccess }));
      };
      const executionResult = (
        evidence: ExecutionEvidence,
        purpose: ExecutionRequest["purpose"] | "command",
      ) =>
        Effect.gen(function* () {
          record(evidence, purpose);
          const handedBack = evidence.noResponse !== undefined && handsBackNoAnswer();
          if (handedBack) yield* questionHandedBack();
          const receipt = yield* visible(evidence, purpose, handedBack);
          if (evidence.terminalFailure === "ChallengeFailure" && !stopUnavailableHost())
            terminal ??= {
              build: "incomplete",
              summary:
                "The live operation reported a challenge failure. No build was published. Recorded effects and receipts are preserved.",
            };
          // The owner never answered the example's question. The minter decides how to go on,
          // with the execution's `scriptQuestion` saying so, unless the question could gate a
          // write repair's write, the build is signed in or holds a login, or it already handed
          // back its limit: then the build ends as no_response.
          if (evidence.noResponse !== undefined && !handedBack && !stopUnavailableHost()) {
            const asked = evidence.scriptQuestion?.requestId;
            yield* suspendUnanswered({
              step: "execution",
              executionId: evidence.executionId,
              ...(asked === undefined ? {} : { requestId: asked }),
              possibleCommit: evidence.noResponse.possibleCommit,
            });
            noResponse ??= evidence.noResponse;
            terminal ??= {
              build: "incomplete",
              summary:
                "The build's example asked a question that was not answered in time, so the build stopped. No build was published. Recorded effects and receipts are preserved.",
            };
          }
          return receipt;
        });
      /** Restore the host's durable claim before exposing an adopted execution receipt. */
      const recoveredExecutionResult = (
        evidence: ExecutionEvidence,
        purpose: ExecutionRequest["purpose"] | "command",
        entrypoint: string | undefined,
      ) =>
        Effect.gen(function* () {
          if (
            (purpose === "example" || purpose === "act") &&
            evidence.preflight !== "rejected_before_claim"
          ) {
            exampleClaimed = true;
            if (purpose === "act" && writeSession === "none") writeSession = "open";
          }
          // A write that ran before a takeover, which the restored reviewer does not yet track.
          // The recovered call's arguments name its entrypoint, so its repeat is refused too.
          if (
            evidence.review?.action === "write" &&
            !reviewer.tracked().some((write) => write.executionId === evidence.executionId)
          )
            yield* reviewer.write(
              yield* trackedWrite(
                evidence.executionId,
                evidence.review.reviewId,
                purpose,
                entrypoint,
                evidence.status,
                evidence,
              ),
            );
          return yield* executionResult(evidence, purpose);
        });
      /** A diagnostic copy that could not be written, kept as a gap in the outcome. */
      const recordDiagnosticGap = (event: string) => (error: MintFailure) =>
        Effect.gen(function* () {
          diagnostics.push(
            JSON.stringify({
              phase: "diagnostics",
              reason: "diagnostic_gap",
              event,
              code: error.code,
              diagnosticRetentionReason: error.diagnosticRetentionReason,
              diagnosticStorageFailure: error.diagnosticStorageFailure,
            }),
          );
          yield* reportFailure(error, {
            component: "mint",
            operation: "diagnostics.emit",
            phase: event,
            subCause: "mint_host_dependency_failed",
            correlation: dependencies.reportCorrelation ?? "process",
          });
        });
      // Screening serializes through JSON, which leaves out undefined fields.
      const diagnose = (value: unknown) =>
        screenMintText(dependencies, value).pipe(
          Effect.tap((safe) =>
            Effect.sync(() => {
              diagnostics.push(safe);
            }),
          ),
          Effect.ignore,
        );
      /** A host evidence call whose defect, such as a thrown error, is a failure like any other. */
      const hostEvidence = <A>(evidence: Effect.Effect<A, MintFailure>) =>
        evidence.pipe(
          Effect.catchAllDefect((error) =>
            Effect.fail(
              new MintFailure({
                code: "Unavailable",
                failureDetail: failureDetail("mint_host_dependency_failed", {
                  operation: "publicationDecisions",
                  error,
                }),
              }),
            ),
          ),
        );
      /**
       * The build's latest publication refusals the host holds, as a question or blocked-explanation
       * review's option, so Guardian reads what the host refused. A list the host could not read is
       * a recorded gap, and the review goes on without it.
       */
      const publicationRefusals = hostEvidence(
        Effect.suspend(() => dependencies.publicationDecisions?.list ?? Effect.succeed([])),
      ).pipe(
        Effect.map((decisions) =>
          decisions
            .filter(({ outcome }) => outcome === "refused")
            .slice(-reviewedPublicationRefusals),
        ),
        Effect.catchAll((error) =>
          recordDiagnosticGap("publication_decisions")(error).pipe(
            Effect.as<readonly PublicationDecision[]>([]),
          ),
        ),
        Effect.map((refusals) => (refusals.length === 0 ? {} : { publicationDecisions: refusals })),
      );
      /**
       * The build's effect as a question or blocked-explanation review's option, read when the
       * review starts, so an update to a write build counts. None before the owner chose one.
       */
      const decidedBuildEffect = () => (buildEffect === "ask" ? {} : { buildEffect });
      /**
       * Keeps one publication decision through the host's hook. A decision that ended the build
       * leaves nothing to recover. Evidence the host could not keep, a thrown error included, is a
       * recorded gap.
       */
      const recordDecision = (pending: Omit<PublicationDecision, "decisionId" | "decidedAt">) =>
        Effect.gen(function* () {
          const decision: PublicationDecision = {
            ...pending,
            decisionId: randomUUID(),
            decidedAt: yield* Clock.currentTimeMillis,
            ...(pending.outcome === "refused" && terminal !== undefined
              ? { recovery: "ended" as const }
              : {}),
          };
          const log = dependencies.publicationDecisions;
          if (log !== undefined)
            yield* hostEvidence(Effect.suspend(() => log.record(decision))).pipe(
              Effect.catchAll(recordDiagnosticGap("publication_decision")),
            );
          return decision;
        });
      /** The decision the running `finish_build` made, recorded once it answers. */
      let pendingDecision: Omit<PublicationDecision, "decisionId" | "decidedAt"> | undefined;
      const takePendingDecision = () => {
        const pending = pendingDecision;
        pendingDecision = undefined;
        return pending;
      };
      /**
       * Records the publication decision `finish_build` made as host evidence, and names it in the
       * answer so the minter can cite it. Evidence the host could not keep is a recorded gap.
       */
      const recordPublicationDecision = <R>(answer: Effect.Effect<string, MintFailure, R>) =>
        Effect.gen(function* () {
          takePendingDecision();
          const settled = yield* Effect.either(answer);
          const pending = takePendingDecision();
          if (pending === undefined) return yield* settled;
          const parsed = settled._tag === "Left" ? undefined : decodeJsonObject(settled.right);
          // A refusal keeps the instruction its answer gave the minter, so a later review reads
          // what the refusal requires: screened as the ledger's host refusals are, and capped. A
          // screen that fails keeps none.
          const told = parsed?._tag === "Right" ? parsed.right.instruction : undefined;
          const instruction =
            pending.outcome !== "refused" || typeof told !== "string"
              ? undefined
              : yield* screenMintText(dependencies, told).pipe(
                  Effect.map((screened) => capped(screened.trim(), ledgerBounds.instructionChars)),
                  Effect.orElseSucceed(() => undefined),
                );
          if (pending.reason !== undefined && namedStepReasons.has(pending.reason)) {
            if (instruction === undefined || instruction === "")
              namedStepInstructions.delete(pending.reason);
            else namedStepInstructions.set(pending.reason, instruction);
          }
          const decision = yield* recordDecision(
            instruction === undefined || instruction === "" ? pending : { ...pending, instruction },
          );
          if (settled._tag === "Left") return yield* settled;
          return parsed === undefined || parsed._tag === "Left"
            ? settled.right
            : JSON.stringify({ ...parsed.right, decisionId: decision.decisionId });
        });
      const diagnoseExecution = (
        submitted: Parameters<typeof dependencies.reviewAndExecute>[0],
        details: Readonly<Record<string, unknown>>,
        /** Archive-only detail; never copied into the harness's own diagnostics. */
        failure?: unknown,
      ) => {
        const policy = policyFailureMetadata(details);
        const authority = authorityCheckMetadata(details);
        const privateCandidate = destinationPrivateCandidateMetadata(details);
        const code = details.code;
        const retained =
          (policy !== undefined || authority !== undefined || privateCandidate !== undefined) &&
          (code === "ScopeDenied" || code === "Unavailable")
            ? (dependencies.diagnostics
                ?.emit("mint.policy_failed", {
                  code,
                  ...policy,
                  ...authority,
                  ...privateCandidate,
                  ...failureDetailMetadata(failure),
                })
                .pipe(Effect.ignore) ?? Effect.void)
            : failureDetailMetadata(failure) !== undefined
              ? // Every other execution failure with detail is retained for diagnosis.
                (dependencies.diagnostics
                  ?.emit("mint.execution_failed", {
                    code,
                    ...(typeof details.rootCode === "string" ? { rootCode: details.rootCode } : {}),
                    ...(typeof details.reason === "string" ? { reason: details.reason } : {}),
                    ...failureDetailMetadata(failure),
                  })
                  .pipe(Effect.ignore) ?? Effect.void)
              : Effect.void;
        return diagnose({
          phase: "execution",
          purpose: submitted.purpose,
          target: submitted.target,
          ...(submitted.purpose === "command"
            ? {}
            : {
                fixtureCount: submitted.fixtureRefs.length,
                filterCount: submitted.caseFilter.length,
                maxWorkers: submitted.maxWorkers,
              }),
          ...details,
        }).pipe(Effect.zipRight(retained));
      };
      /**
       * Whether the unanswered build may have committed: yes unless it never dispatched or the
       * site rejected it, so any write example or residual not proven `not_sent` counts.
       */
      const possibleCommit = () =>
        buildEffect === "write" &&
        executions.some((entry) => {
          const purpose = purposes.get(entry.executionId);
          return (
            (purpose === "example" || purpose === "residual") &&
            entry.effect !== "not_sent" &&
            // A read example from before the build became a write committed nothing.
            (revisions.get(entry.executionId) ?? 0) >= latestRevisionChanging("effect")
          );
        });
      /** The revision of the latest accepted update that changed `setting`; 0 for none. */
      const latestRevisionChanging = (setting: TaskChange["setting"]) =>
        Math.max(
          0,
          ...taskState.updates
            .filter((update) => update.changes.some((change) => change.setting === setting))
            .map((update) => update.revision),
        );
      /**
       * Why the host refuses a task update before review, as its reason and the agent's next step,
       * or undefined. A recommended new build is never refused here: it changes nothing.
       */
      const taskUpdateRefusal = (
        submitted: TaskUpdateRequest,
      ): { readonly reason: string; readonly instruction: string } | undefined => {
        const settings = new Set(submitted.changes.map((change) => change.setting));
        // A repair keeps the published tool's task. Only a change to its contract may apply: a
        // requirement, the purpose or an output field.
        if (
          request.mode === "maintenance" &&
          (submitted.recommend === "new_mint" ||
            [...settings].some(
              (setting) =>
                setting !== "requirement" && setting !== "purpose" && setting !== "output",
            ))
        )
          return {
            reason: "maintenance_setting",
            instruction:
              "Maintenance repairs the published tool under its own task. Only a change to its contract may apply, as a requirement, purpose or output change; its input, effect, site and login stay, and it never becomes a new build. Repair it as it is, or end the attempt and say in the summary what the caller now wants.",
          };
        if (request.mode !== "maintenance" && settings.has("output"))
          return {
            reason: "output_outside_maintenance",
            instruction:
              "An output change alters a published tool's registered contract, so only maintenance makes one. This build sets its own output schema: change it in the source.",
          };
        // Removing a field callers receive has the higher bar: a stated reason Guardian judges.
        const unexplained = submitted.changes.find(
          (change) =>
            change.setting === "output" && change.change === "remove" && change.reason === undefined,
        );
        if (unexplained !== undefined && unexplained.setting === "output")
          return {
            reason: "output_removal_reason",
            instruction: `Removing ${unexplained.field} takes away a value the tool's callers receive, so it needs a reason, and nothing changed. If the site still shows the value, keep the field and fix the extraction instead. Otherwise add reason to that change: why the field must go, from what the site shows now and where you looked, which Guardian checks against the captures. Then call mint_update again.`,
          };
        if (submitted.recommend === "new_mint") return undefined;
        if (settings.has("effect")) {
          if (buildEffect === "write")
            return {
              reason: "already_write",
              instruction:
                "This build is already a write build. Perform the task through purpose act steps, as .agents/writes/SKILL.md describes.",
            };
          if (taskState.siteOrigin === undefined)
            return {
              reason: "offline_build",
              instruction: "An offline build has no website to change. Finish it as a read.",
            };
        }
        if (settings.has("site")) {
          if (taskState.siteOrigin === undefined)
            return {
              reason: "offline_build",
              instruction: "An offline build has no website to move. Finish it offline.",
            };
          // A host that can't move builds would refuse the move only after the caller confirmed
          // it and Guardian allowed it, so it is refused here, before the host asks for the
          // caller's confirmation or Guardian reviews it.
          if (dependencies.siteMoveUnsupported === true)
            return {
              reason: "site_move_unsupported",
              instruction:
                "This host can't move this build to another site, so nothing changed. A new build is the way: call mint_update with recommend new_mint and a suggestedRequest for a build on the other site, or finish under the current site.",
            };
          if (writeSession === "open")
            return {
              reason: "write_session_open",
              instruction:
                "This build's write session is open, and its write may have committed on the current site. Finish or read back that write first; the site cannot change under it.",
            };
          // Publication needs an example from the new site, so the build must still be able to
          // run one there.
          if (executionClosed || (exampleClaimed && !repeatableRead))
            return {
              reason: "no_live_example_left",
              instruction:
                "This build can no longer run a live example, so nothing it publishes could be proven on another site. Finish under the current site, or call mint_update with recommend new_mint and a suggestedRequest for a build on the other site.",
            };
        }
        const input = taskState.businessInput;
        if (
          settings.has("input") &&
          (typeof input !== "object" || input === null || Array.isArray(input))
        )
          return {
            reason: "input_not_an_object",
            instruction:
              "This build's input is not an object of named values, so an input change cannot name what it sets. Change a requirement or the purpose instead.",
          };
        return undefined;
      };
      /**
       * Why a request is refused before anyone reviews it, if it is: the effect question is one
       * read-or-write choice, and the capability question is the host's own text question.
       */
      const requestShapeRefusal = (
        submitted: AgentInputRequest,
      ): { readonly reason: string; readonly instruction: string } | undefined => {
        const [only] = submitted.questions;
        const readOrWrite = isReadOrWriteChoice(submitted);
        if (effectQuestion && !readOrWrite)
          return {
            reason: "effect_question_shape",
            instruction:
              "Ask exactly one choice question whose options have the ids read and write, with no other option and no notice.",
          };
        if (
          !effectQuestion &&
          dependencies.capabilityQuestion !== undefined &&
          (submitted.questions.length !== 1 ||
            only?.type !== "text" ||
            only.prompt !== dependencies.capabilityQuestion)
        )
          return {
            reason: "capability_question_shape",
            instruction:
              "Ask exactly the host's capability question as one text question with that prompt.",
          };
        return undefined;
      };
      /**
       * Whether the build is signed in or holds a login now: one bound from the start, one the
       * host obtained in place, or one a sign-in in this build sent.
       */
      const signedInOrHoldsLogin = () =>
        dependencies.websiteCredentialsAvailable === true ||
        loginHeld ||
        executions.some(
          (entry) =>
            entry.authentication !== undefined ||
            (purposes.get(entry.executionId) === "authenticate" && entry.effect !== "not_sent"),
        );
      /**
       * Whether an unanswered question goes back to the minter as no answer, which then decides
       * how the build goes on, decided for each question when it goes unanswered. Not when the
       * question decides what the build may do: the read-or-write and capability questions, any
       * question in a write repair, which could gate its write, and any asked while the build is
       * signed in or holds a login, which acts as the account's owner. Nor once the build handed
       * back `noAnswerHandBackLimit` questions.
       */
      const handsBackNoAnswer = () =>
        request.effect !== "ask" &&
        dependencies.capabilityQuestion === undefined &&
        !(request.mode === "maintenance" && buildEffect === "write") &&
        !signedInOrHoldsLogin() &&
        noAnswerHandBacks < noAnswerHandBackLimit;
      /**
       * The minter's latest question handed back as no answer, while no other question was asked
       * or handed back since: a report that ends the build on it may be suspended instead
       * (`suspendHandedBack`).
       */
      let handedBackQuestion: string | undefined;
      /**
       * Counts a question handed back and records it, with the id of the minter's own question;
       * a script's question has none.
       */
      const questionHandedBack = (requestId?: string) =>
        Effect.sync(() => {
          noAnswerHandBacks += 1;
          handedBackQuestion = requestId;
        }).pipe(
          Effect.zipRight(
            reportBestEffort(
              dependencies.diagnostics?.emit("mint.question_handed_back", {}) ?? Effect.void,
              {
                component: "mint",
                operation: "diagnostics.emit",
                phase: "mint.question_handed_back",
                correlation: dependencies.reportCorrelation ?? "process",
              },
            ),
          ),
        );
      /**
       * The minter's question went unanswered and the build goes on. It stays unanswered: no
       * `mint_update` can cite it, and no review reads an answer from it.
       */
      const noAnswer = (requestId: string | undefined) =>
        questionHandedBack(requestId).pipe(
          Effect.as(
            JSON.stringify({
              status: "no_answer",
              userInputRequired: false,
              instruction: noAnswerInstruction,
            }),
          ),
        );
      /** Completed once the host suspended the build: the model run then stops with no outcome. */
      const suspended = yield* Deferred.make<void>();
      /** Set once the model run ended: only a running model can be stopped for a suspension. */
      let modelRunEnded = false;
      /**
       * Offers the host to suspend the build on a question its owner left unanswered, where the
       * build would otherwise end as no_response, or, through `suspendHandedBack`, where the
       * minter ends it on a question handed back. Once the host suspended it, this never returns:
       * the run stops, and the call that asked, or the report, stays unreturned for a resumed
       * attempt to rejoin.
       */
      const suspendUnanswered = (
        question: UnansweredQuestion,
        hook: "suspendUnanswered" | "suspendHandedBack" = "suspendUnanswered",
      ) =>
        Effect.gen(function* () {
          const suspend = dependencies[hook];
          if (suspend === undefined || terminal !== undefined || modelRunEnded) return;
          const decision = yield* suspend(question).pipe(
            Effect.catchAllDefect((error) =>
              Effect.fail(
                new MintFailure({
                  code: "Unavailable",
                  failureDetail: failureDetail("mint_host_dependency_failed", {
                    operation: hook,
                    error,
                  }),
                }),
              ),
            ),
            // The build ends as it would without the hook.
            Effect.catchAll((error) =>
              diagnose({ phase: "suspend_unanswered", code: failureCode(error) }).pipe(
                Effect.zipRight(
                  reportFailure(error, {
                    component: "mint",
                    operation: hook,
                    phase: "suspend_unanswered",
                    subCause: "mint_host_dependency_failed",
                    correlation: dependencies.reportCorrelation ?? "process",
                  }),
                ),
                Effect.as("not_suspended" as const),
              ),
            ),
          );
          if (decision !== "suspended") return;
          // A model run that ended meanwhile can no longer be stopped: the build ends instead.
          if (modelRunEnded) {
            yield* diagnose({ phase: "suspend_unanswered", reason: "model_run_ended" });
            return;
          }
          yield* Deferred.succeed(suspended, undefined);
          return yield* Effect.never;
        });
      /** The id of the question the minter is asking, while it waits for the answer. */
      let askingId: string | undefined;
      /**
       * Whether that question asks whether to end the build (`endsBuild`). Its later answer could
       * not keep that mark through a rejoined report, so such a question is never offered to
       * `suspendHandedBack`.
       */
      let askingEndsBuild = false;
      /**
       * The build's owner left a question that decides what it may do unanswered: it ends, unless
       * the host suspends it to resume later.
       */
      const unanswered = (
        error: MintFailure,
        step: string,
        question: Omit<UnansweredQuestion, "possibleCommit">,
      ) =>
        Effect.gen(function* () {
          const possible = error.noResponse?.possibleCommit === true || possibleCommit();
          // An owner's cancel is a choice to stop, never one to resume from.
          if (error.ownerCancelled !== true)
            yield* suspendUnanswered({ ...question, possibleCommit: possible });
          noResponse ??= { possibleCommit: possible };
          terminal ??= {
            build: "incomplete",
            summary: `A question to the build's owner while ${step} was not answered in time, so the build stopped. No build was published. Recorded effects and receipts are preserved.`,
          };
          return JSON.stringify({
            status: "no_response",
            instruction: "The build's owner did not answer in time. The host is ending this build.",
          });
        });
      /**
       * The minter's own question went unanswered, whether asked live or rejoined by a takeover:
       * it goes back to the minter as no answer where it may, and otherwise the build ends, unless
       * the host suspends it. An owner's cancel is a choice to stop, never a question to decide
       * without. `requestId` is the question's id when the harness knows it, which a takeover's
       * replayed call does not.
       */
      const questionUnanswered = (
        error: MintFailure,
        requestId: string | undefined,
        endsBuild: boolean,
      ) =>
        error.ownerCancelled !== true && handsBackNoAnswer()
          ? noAnswer(endsBuild ? undefined : requestId)
          : unanswered(error, "asking a question", {
              step: "question",
              ...(requestId === undefined ? {} : { requestId }),
            });
      const reviewFeedback = (error: MintFailure, signIn: boolean) =>
        Effect.gen(function* () {
          // A refusal Guardian marked correctable names a fix, so no policy block stands on it.
          // One without a kind, from an older reviewer, counts as final, as it did before.
          if (error.review?.refusal !== "correctable") {
            signInRefusalOnly = signIn && (signInRefusalOnly || !guardianRefused);
            guardianRefused = true;
          }
          const rationale = error.review
            ? yield* screenMintText(dependencies, error.review.rationale)
            : "Guardian rejected this submission; rationale unavailable.";
          yield* recordDenial({
            review: "execution",
            ...(error.review === undefined
              ? {}
              : {
                  outcome: error.review.outcome,
                  ...(error.review.reviewId === undefined
                    ? {}
                    : { reviewId: error.review.reviewId }),
                }),
            rationale,
          });
          // The same sign-in step denied again and again: sign-in is unavailable in this build,
          // and it ends with that outcome, not the loop guard.
          const repeated = signIn && countSignInDenial(error);
          const ending =
            !repeated || terminal !== undefined
              ? ("none" as const)
              : publishableReceipt()
                ? ("after_publication" as const)
                : ("now" as const);
          const answer = JSON.stringify({
            status: "review_rejected",
            code: "ReviewDenied",
            exampleClaimed,
            repeatableRead,
            ...availabilityMetadata(),
            ...(error.review
              ? {
                  outcome: error.review.outcome,
                  reviewId: error.review.reviewId,
                  ...(error.review.refusal === undefined ? {} : { refusal: error.review.refusal }),
                }
              : {}),
            rationale,
            ...(repeated
              ? {
                  nextStep: "report_sign_in_unavailable",
                  spentSignIn: "guardian_denials_repeated",
                  ...(ending === "none" ? {} : { buildOutcome: "sign_in_unavailable" }),
                }
              : {}),
            notice:
              availabilityInstruction() +
              (repeated
                ? repeatedDenialNotice(ending)
                : (repeatableRead
                    ? "This invocation permits fresh reviewed reads only while live execution remains available and after confirmed executor cleanup; preserve earlier receipts. "
                    : exampleClaimed
                      ? "The example is already claimed; never repeat it. "
                      : "This example has not been claimed. Correct undispatched source and submit it for fresh review. ") +
                  "Correct the submitted source or collect missing evidence through an authorized safe observation, then submit for fresh review. Request user input only for missing authority or information the user must supply. This feedback grants no new authority. Preserve prior effects; do not repeat a claimed example or uncertain write/login."),
          });
          if (ending !== "none")
            yield* endForUnavailableSignIn(
              new MintFailure({ ...error, spentSignIn: "guardian_denials_repeated" }),
              answer,
              {
                ...(error.review?.reviewId === undefined
                  ? {}
                  : { reviewId: error.review.reviewId }),
                rationale,
              },
            );
          return answer;
        }).pipe(
          Effect.catchAll(() =>
            Effect.succeed(
              JSON.stringify({
                status: "review_rejected",
                code: "ReviewDenied",
                exampleClaimed,
                ...availabilityMetadata(),
                rationale: "Review feedback unavailable.",
                notice:
                  availabilityInstruction() +
                  "Preserve prior effects; do not repeat a claimed example.",
              }),
            ),
          ),
        );
      /**
       * Counts Guardian's correctable denial of the running sign-in step. True for the
       * `maximumSignInDenials`th in a row of the same step, which spends the attempt's sign-ins.
       */
      const countSignInDenial = (error: MintFailure) => {
        const step = sentSignInStep;
        if (step === undefined || error.review?.refusal !== "correctable") return false;
        const prior = priorSignInDenials;
        const count = prior?.step === step ? prior.count + 1 : 1;
        signInDenials = { step, count };
        return count >= maximumSignInDenials;
      };
      /** Whether reviews have been unavailable for the whole outage budget, which ends the attempt. */
      const reviewRetryExhausted = () =>
        Effect.map(Clock.currentTimeMillis, (now) => {
          reviewOutageStartedAt ??= now;
          return now - reviewOutageStartedAt >= reviewOutageBudgetMs;
        });
      /**
       * Counts a review that ended `InvalidOutcome`: Guardian, already corrected once in the
       * review, returned no outcome its kind allows. A verdict that did not form, not an outage:
       * it neither starts the outage budget nor counts as an outage retry. True for the second in
       * the attempt, which ends it.
       */
      const invalidOutcomeRepeated = () => {
        invalidOutcomes += 1;
        return invalidOutcomes > 1;
      };
      /** What the agent may change instead of resubmitting a review Guardian could not decide. */
      const invalidOutcomeSubject = {
        execution: "the execution's source",
        publication: "the build before calling finish_build again",
        question: "the request",
        update: "the update",
      };
      /** An `InvalidOutcome` answer that ends the attempt; its terminal outcome is already set. */
      const invalidOutcomeEnded = (instruction: string) =>
        JSON.stringify({
          status: "review_invalid_outcome",
          reviewFailure: "InvalidOutcome",
          retryable: false,
          userInputRequired: false,
          ...availabilityMetadata(),
          instruction,
        });
      /**
       * The agent's answer for a review that ended `InvalidOutcome`. A host that became
       * unavailable during the review ends the attempt with its own cause. Otherwise the first goes
       * back to the agent to revise or withdraw, never to resubmit unchanged, so it is not
       * `retryable`; once live execution has closed, an execution goes on through its retained
       * receipt instead. The second ends the attempt incomplete without a host failure, since no
       * outage caused it and running the attempt again would repeat it. Its ending is the typed
       * stop `host_unavailable`, the host's and not the task's, with a `review` diagnostic naming
       * the review kind, so no host reads it as a missing publication.
       */
      const invalidOutcomeAnswer = (kind: keyof typeof invalidOutcomeSubject) =>
        Effect.gen(function* () {
          if (stopUnavailableHost())
            return invalidOutcomeEnded(
              "Guardian returned no decision its review allows, so nothing was approved, and the host became unavailable, so the attempt has ended. Preserve recorded effects and receipts.",
            );
          if (invalidOutcomeRepeated()) {
            // Another outcome already ended the attempt; it stands, and nothing claims otherwise.
            if (terminal === undefined) {
              terminal = {
                build: "incomplete",
                stopReason: "host_unavailable",
                summary:
                  "Guardian returned no decision its review allows, again, so the host ended the attempt without publishing. Nothing it was reviewing was approved; recorded effects and receipts are preserved.",
              };
              yield* diagnose({
                phase: "review",
                reason: "review_unavailable",
                code: "InvalidOutcome",
                review: kind,
              });
            }
            return invalidOutcomeEnded(
              "Guardian again returned no decision its review allows, so the attempt has ended and nothing was approved. Preserve recorded effects and receipts.",
            );
          }
          const next =
            kind === "execution" && executionClosed
              ? "Live execution has ended, so this execution cannot be resubmitted or revised; publish an eligible retained receipt with finish_build, or ask with request_input when publication needs something only the user knows."
              : `Revise ${invalidOutcomeSubject[kind]} so what is under review is plain, or withdraw it and continue another way; do not submit it again unchanged.`;
          return JSON.stringify({
            status: "review_invalid_outcome",
            reviewFailure: "InvalidOutcome",
            userInputRequired: false,
            ...availabilityMetadata(),
            instruction: `Guardian returned no decision this review allows, even after the host named the outcomes it may return, so nothing was approved. This is not a deny and not an outage. ${next} A second such result ends the attempt.`,
          });
        });
      /**
       * A spent model quota is a host failure no retry gets past, whether the minter's call or
       * Guardian's hit it, since both use the same provider account.
       * Operators see it like any other host failure, with the provider's error beneath the
       * finite code.
       */
      const endForSpentModelQuota = (failure: MintFailure, phase: "model" | "review") =>
        Effect.gen(function* () {
          // Another outcome already ended the attempt; it stands, and nothing claims otherwise.
          if (terminal !== undefined) return terminal.hostFailure === "model_quota_exhausted";
          terminal = {
            build: "incomplete",
            hostFailure: "model_quota_exhausted",
            summary:
              "The model provider refused this attempt's calls because the account's model quota is spent, so the host ended the attempt without publishing. Retrying cannot help until the quota is restored. Recorded effects and receipts are preserved.",
          };
          yield* diagnose({
            phase,
            hostFailure: "model_quota_exhausted",
            code: failure.code,
            rootCause: failureRootCause(failure),
          });
          yield* reportFailure(failure, {
            component: "mint",
            operation: phase === "model" ? "model.run" : "guardian.review",
            phase,
            subCause: "model_quota_exhausted",
            correlation: dependencies.reportCorrelation ?? "process",
            ...(dependencies.diagnostics === undefined ? {} : { sink: dependencies.diagnostics }),
          });
          return true;
        });
      /** Guardian's review found the quota spent; the reply names only the outcome that stands. */
      const spentQuotaReview = (error: MintFailure) =>
        endForSpentModelQuota(error, "review").pipe(
          Effect.map((ended) =>
            JSON.stringify({
              status: "review_unavailable",
              code: error.code,
              reviewFailure: error.reviewFailure,
              ...(ended ? { hostFailure: "model_quota_exhausted" } : {}),
              retryable: false,
              userInputRequired: false,
              instruction: ended
                ? "Guardian could not review because the model provider's quota is spent; nothing was approved and waiting does not restore it. End this attempt; preserve recorded effects and receipts."
                : "Guardian could not review, and nothing was approved; this attempt has already ended with its recorded outcome. Preserve recorded effects and receipts.",
            }),
          ),
        );
      /**
       * A review Guardian could not complete, as the agent reads it. `next` is how the attempt goes
       * on, with the live execution it still has; without it the attempt ends. `retention` adds why
       * the review's evidence could not be kept.
       */
      const reviewUnavailableAnswer = (
        error: MintFailure,
        notice: string,
        {
          retention = true,
          next,
        }: {
          readonly retention?: boolean;
          readonly next?: { readonly retryable: boolean; readonly retriesRemaining?: number };
        } = {},
      ) =>
        // JSON.stringify leaves out each field that is undefined.
        JSON.stringify({
          status: "review_unavailable",
          code: "ReviewUnavailable",
          reviewFailure: error.reviewFailure,
          reviewPhase: error.reviewPhase,
          reviewDispatch: error.reviewDispatch,
          ...(retention
            ? {
                ...(error.diagnosticRetentionReason === undefined
                  ? {}
                  : { diagnosticRetentionReason: diagnosticRetentionReason(error) }),
                diagnosticScreeningReason: diagnosticScreeningReason(error),
                diagnosticStorageFailure: diagnosticStorageFailure(error),
              }
            : {}),
          ...next,
          userInputRequired: false,
          ...(next === undefined ? {} : availabilityMetadata()),
          notice: next === undefined ? notice : availabilityInstruction() + notice,
        });
      /**
       * A review that Guardian could not complete is not a deny. The host already retried it with
       * backoff; the agent may resubmit while reviews have been unavailable for less than the
       * outage budget, and any completed review starts the budget again. A review whose evidence
       * could not be retained is such an outage too. Past the budget, `exhausted` ends the attempt,
       * as it does at once for a request over Guardian's model input limit (`InputTooLarge`), which
       * fails the same way when resubmitted.
       */
      const reviewUnavailableRetry =
        (
          kind: keyof typeof reviewUnavailableRetries,
          exhausted: (error: MintFailure) => Effect.Effect<string>,
        ) =>
        (error: MintFailure) =>
          Effect.gen(function* () {
            if (error.reviewFailure === "InvalidOutcome") return yield* invalidOutcomeAnswer(kind);
            // This outage is another review's, which is resubmitted before report_blocked.
            blockedReviewUnavailable = false;
            if (error.modelOutage === "quota_exhausted") return yield* spentQuotaReview(error);
            const retentionFailure = error.reviewPhase === "diagnostic_retention";
            if (
              stopUnavailableHost() ||
              error.reviewFailure === "InputTooLarge" ||
              (yield* reviewRetryExhausted())
            )
              return yield* exhausted(error);
            // Live execution ended during this review: the execution cannot be resubmitted, but the
            // retained receipt can still be published and a question still asked.
            if (kind === "execution" && executionClosed)
              return reviewUnavailableAnswer(
                error,
                "Guardian review did not complete and nothing was approved; this execution cannot be resubmitted.",
                { retention: false, next: { retryable: false } },
              );
            reviewUnavailableRetries[kind] += 1;
            return reviewUnavailableAnswer(
              error,
              "Guardian review did not complete. This is not a deny or escalation, and nothing was approved. " +
                reviewRetryInstruction[kind] +
                (retentionFailure
                  ? " The host could not keep this review's evidence and recorded the gap."
                  : " The host already retried this review with backoff before answering.") +
                " Resubmitting is safe; if Guardian stays unavailable long enough, the host ends the attempt. Do not change site code to work around review infrastructure.",
              { next: { retryable: true } },
            );
          });
      const reviewRetryInstruction = {
        execution:
          "You may resubmit the same execution for a fresh review. reviewDispatch not_sent means this submission did not run; without it, treat the submission as possibly executed and reconcile before any further effect. Never repeat a claimed example.",
        publication:
          "Nothing was published. Call finish_build again with the same executionId for a fresh publication review; the retained example is not executed again.",
        question:
          "No question was created. Submit the same request_input again for a fresh question review; do not ask it in prose or invent a clarification.",
        update:
          "Nothing changed. Submit the same mint_update again for a fresh review; the task stays as it was until an update applies.",
      };
      const reviewUnavailableFeedback = (error: MintFailure) =>
        Effect.sync(() => {
          terminal = {
            build: "incomplete",
            hostFailure: "review_unavailable",
            summary:
              "Guardian review could not complete. No review approval was obtained; recorded effects and claimed examples remain preserved.",
          };
          return reviewUnavailableAnswer(
            error,
            "Review did not complete; this is not a Guardian deny or escalation decision. End this attempt without publication. Do not change site code to repair review infrastructure or automatically retry execution. Preserve prior effects and claimed examples; reconcile possibly executed operations before any further effect. Missing user authority or credentials has not been established.",
          );
        });
      /**
       * A publication dependency the host retried and that stayed unavailable: the registry, its
       * source store, or a screening or source read that named no file to fix. `path_screening`
       * stays a refusal: it can mean a source path holds a credential, which the minter fixes.
       */
      const publicationOutage = (error: MintFailure) =>
        error.reason === "registry_unavailable" ||
        error.reason === "source_storage" ||
        error.reason === "source_read" ||
        (error.publicationBlock === undefined &&
          (error.reason === "evidence_screening" ||
            error.reason === "source_screening" ||
            error.reason === "schema_screening")) ||
        (error.code === "Unavailable" && error.reason === undefined);
      /**
       * A publication refusal the minter can act on: `details` names what was refused, and
       * `instruction` follows what live execution is still available.
       */
      const notPublished = (
        code: MintFailure["code"],
        reason: string | undefined,
        details: object,
        instruction: string,
      ) =>
        // JSON.stringify leaves out each field that is undefined.
        JSON.stringify({
          status: "not_published",
          code,
          reason,
          ...details,
          ...availabilityMetadata(),
          userInputRequired: false,
          instruction: availabilityInstruction() + instruction,
        });
      /**
       * A registry refusal of a reviewed publication. A check the minter's metadata or source
       * decides goes back to it to fix, with no cap; any other refusal ends the attempt with its
       * reason. A registry outage the host's retries did not clear may be tried again until the
       * publication outage budget runs out.
       */
      const registryFeedback = (error: MintFailure) =>
        Effect.gen(function* () {
          const outage = publicationOutage(error);
          const refusal = outage
            ? {
                fixable: !(stopUnavailableHost() || (yield* reviewRetryExhausted())),
                instruction:
                  "Publication infrastructure (the tool registry, its source store or the host's screening) stayed unavailable through the host's retries, so nothing was published. Call finish_build again with the same executionId; the retained example is not executed again.",
              }
            : registryRefusal(error.registryIssue, error.registryProblem);
          if (!refusal.fixable)
            terminal = {
              build: "incomplete",
              ...(outage || error.registryIssue === undefined
                ? { hostFailure: "publication_unavailable" as const }
                : {}),
              summary: `Not published: ${refusal.instruction} The existing execution outcomes and protected results remain retained.`,
            };
          return notPublished(
            error.code,
            error.reason,
            {
              registryIssue: error.registryIssue,
              registryProblem: error.registryProblem,
              ...failureDetailMetadata(error),
              fixRequired: refusal.fixable && !outage,
              ...(outage ? { retryable: refusal.fixable } : {}),
            },
            refusal.instruction +
              (refusal.fixable ? "" : " This attempt ends here; preserve the recorded receipt."),
          );
        });
      const unavailableExecutionHost = (error: MintFailure) =>
        error.code === "Unavailable" &&
        error.reason === "executor_unavailable" &&
        error.execution === undefined &&
        error.authentication === undefined;
      const screenedRunnerFailure = (error: MintFailure) => {
        try {
          return finiteRunnerFailure(error.runnerFailure);
          // error-reporting-allow: parse-predicate an unreadable runnerFailure getter supplies no trusted finite metadata
        } catch {
          return undefined;
        }
      };
      const screenedCaptureGap = (error: MintFailure) => {
        try {
          return finiteCaptureGap(error.captureGap);
          // error-reporting-allow: parse-predicate an unreadable captureGap getter supplies no trusted finite metadata
        } catch {
          return undefined;
        }
      };
      const screenedRunnerChannels = ({ runnerChannels }: MintFailure) =>
        runnerChannels === undefined
          ? {}
          : {
              stdout: runnerChannels.stdout,
              stderr: runnerChannels.stderr,
              events: runnerChannels.events,
            };
      /** Whether a provider outage may still be resubmitted, starting its window if new. */
      const providerOutageOpen = (now: number) => {
        providerUnavailableRetries += 1;
        providerOutageStartedAt ??= now;
        return now - providerOutageStartedAt < reviewOutageBudgetMs;
      };
      const executionFeedback = (error: MintFailure) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) => providerFeedback(error, now));
      /**
       * Counts a host refusal while typing into a sign-in screen. The `maximumHostRefusals`th
       * identical one in a row spends the attempt's sign-ins: sign-in is unavailable in the build.
       */
      const countHostRefusal = (error: MintFailure) => {
        const refusal = error.authentication?.hostRefusal;
        if (refusal === undefined) return error;
        const prior = priorHostRefusals;
        const count =
          prior !== undefined && sameHostRefusal(prior.refusal, refusal) ? prior.count + 1 : 1;
        hostRefusals = { refusal, count };
        return count < maximumHostRefusals || error.spentSignIn !== undefined
          ? error
          : new MintFailure({ ...error, spentSignIn: "host_refusals_repeated" });
      };
      const providerFeedback = (failed: MintFailure, now: number) => {
        const error = countHostRefusal(failed);
        const signInRefusal = hostSignInRefusalCode(error);
        if (signInRefusal !== undefined)
          refuseByHost({
            source: "sign_in_step",
            code: signInRefusal,
            ...(error.authentication?.hostRefusal?.check === undefined
              ? {}
              : { check: error.authentication.hostRefusal.check }),
          });
        const runnerFailure = screenedRunnerFailure(error);
        // A capture the host could not produce or screen is a gap: the result is withheld, the
        // effect possible, and the build goes on.
        const captureGap =
          screenedCaptureGap(error) ??
          runnerFailure?.captureGap ??
          (error.code === "CaptureUnavailable" ? ("capture_publication" as const) : undefined);
        const hostStopped = stopUnavailableHost() || unavailableExecutionHost(error);
        // The executor stop settles before this failure arrives, and a stop that failed makes
        // the host unavailable. So an available host here means the stop was confirmed. The host
        // already retried what it could, so the agent may resubmit until the outage outlasts its
        // budget.
        const providerRetry =
          !hostStopped &&
          error.execution?.reason === "provider_unavailable" &&
          providerOutageOpen(now);
        if (!providerRetry && (hostStopped || error.execution?.reason === "provider_unavailable"))
          closeExecution();
        const openCaptureGapNotice =
          captureGap !== undefined &&
          dependencies.executionAvailability?.() === "open" &&
          !hostStopped &&
          !executionClosed &&
          terminal === undefined
            ? "This command may have completed, but its capture observation is unavailable. The execution host remains open. You may make a new bounded observation of the current page and continue the request under ordinary review. Do not replay the previous command automatically or treat the missing capture as proof of success. Read back an uncertain write before any further write, never repeat a claimed example, and publish only from an eligible retained receipt."
            : undefined;
        const providerNotice = providerRetry
          ? {
              retryable: true,
              effect: error.execution?.dispatch === "not_sent" ? "not_sent" : "possible",
              providerNotice:
                error.execution?.dispatch === "not_sent"
                  ? "The execution provider was unavailable before this execution was dispatched, so it did not run. The host already retried; you may submit it again. If the provider stays unavailable long enough, live execution closes."
                  : "The execution provider failed after dispatch, and the host confirmed the executor stopped. The execution may have run: its effect is possible. Reconcile current state before claiming success or repeating any write; never repeat a claimed example. If the provider stays unavailable long enough, live execution closes.",
            }
          : {};
        // A failed sign-in names its own root cause and next step, never the wrapper's code.
        const feedback = signInFeedbackOf(error);
        // Until the agent signs in again, a final answer gets the way past it back once.
        if (error.authentication !== undefined && !hostStopped)
          unresolvedSignIn = {
            failure: error.authentication,
            spent: error.spentSignIn,
            guided: false,
          };
        // No further sign-in can run: the build ends with that outcome, not the loop guard.
        // A stop or cleanup the host could not confirm ends live work on its own terms.
        const ending =
          hostStopped ||
          terminal !== undefined ||
          error.authentication?.cleanupCode !== undefined ||
          feedback?.nextStep !== "report_sign_in_unavailable"
            ? ("none" as const)
            : publishableReceipt()
              ? ("after_publication" as const)
              : ("now" as const);
        const signIn = signInOrLoginInUseAnswer(error, feedback, ending);
        const rootCause = failureRootCause(error);
        return dependencies.projection
          .json({
            status: signIn === undefined ? "execution_unavailable" : "authentication_unavailable",
            code: signIn?.code ?? error.code,
            ...signIn?.fields,
            reason: error.reason,
            // A sign-in's diagnostic is its root cause; anything else names the one beneath.
            ...(signIn !== undefined || rootCause === undefined ? {} : { rootCause }),
            ...availabilityMetadata(),
            ...(error.destinationReason === "observation_unavailable"
              ? { destinationReason: error.destinationReason }
              : {}),
            execution: error.execution,
            workspace: error.workspace,
            runnerFailure,
            captureGap,
            // The runner's own output, when there is no capture view to carry it.
            ...screenedRunnerChannels(error),
            authentication: error.authentication,
            ...providerNotice,
            userInputRequired: false,
            notice:
              openCaptureGapNotice ??
              (error.execution?.workspace === undefined
                ? availabilityInstruction() +
                  (error.execution?.runnerResult === undefined
                    ? ""
                    : runnerResultNotice(error.execution.runnerResult)) +
                  (signIn?.notice ??
                    "Host execution failed; this does not establish missing credentials or a missing user answer. Preserve prior effects and the claimed example; reconcile uncertain website state before any further effect.")
                : error.execution.workspace.reason === "digest_mismatch"
                  ? `Nothing ran: the job sandbox's copy of ${(error.execution.workspace.mismatched ?? []).join(", ")} did not match the source Guardian reviewed. The host writes those files again before the next execution; submit the same execution again.`
                  : `Nothing ran: the host could not copy ${error.execution.workspace.fileCount} workspace file(s) inside the job sandbox for this execution. Submit it again; if it fails the same way, report that the execution sandbox is unavailable.`),
          })
          .pipe(
            Effect.map((value) => JSON.stringify(value)),
            Effect.catchAll(() =>
              Effect.succeed(
                JSON.stringify({
                  status: "execution_unavailable",
                  code: "Unavailable",
                  ...availabilityMetadata(),
                  userInputRequired: false,
                  notice:
                    availabilityInstruction() +
                    "Execution diagnostics unavailable; missing credentials were not established. Preserve prior effects; do not repeat a claimed example.",
                }),
              ),
            ),
            Effect.tap((answer) =>
              ending === "none" ? Effect.void : endForUnavailableSignIn(error, answer),
            ),
          );
      };
      /**
       * Records that sign-in is unavailable in this build, with the failed sign-in's root cause:
       * the build ends with that outcome at once, or once the model stops when a retained receipt
       * may still publish. A later authenticate gets the same answer. `detail` joins the record,
       * such as the review and rationale of Guardian's last denial of a repeated step.
       */
      const endForUnavailableSignIn = (
        error: MintFailure,
        answer: string,
        detail: Readonly<Record<string, string>> = {},
      ) =>
        Effect.gen(function* () {
          const failure = error.authentication;
          const outcome = {
            build: "incomplete" as const,
            // A Personal conflict keeps its own actionable status; the worker words a saved
            // login's with its masked username.
            recoveryReason:
              failure?.code === "LoginIdentityConflict"
                ? ("login_identity_conflict" as const)
                : ("sign_in_unavailable" as const),
            // The site refused the account itself: only its owner can unlock it.
            ...(failure?.code === "AccountLocked" ? { stopReason: "account_locked" as const } : {}),
            summary: signInUnavailableSummary(failure, error.spentSignIn, error.sessionLoss),
          };
          signInUnavailable = { answer, outcome };
          if (!publishableReceipt()) terminal ??= outcome;
          yield* diagnose({
            phase: "sign_in",
            reason: "sign_in_unavailable",
            ...(failure === undefined
              ? {}
              : {
                  code: signInRootCode(failure),
                  authenticationCode: failure.code,
                  authenticationPhase: failure.phase,
                  credentialSent: failure.nothingSubmitted !== true,
                }),
            spentSignIn: error.spentSignIn,
            sessionLoss: error.sessionLoss,
            ...detail,
          });
        });
      /**
       * An execution whose diagnostics the host could not keep: a recorded gap, however many, and
       * the build goes on. Its observations stay withheld and its effect is possible.
       */
      const diagnosticUnavailableFeedback = (error: MintFailure) =>
        Effect.sync(() =>
          JSON.stringify({
            status: "diagnostic_unavailable",
            code: "Unavailable",
            diagnosticRetentionReason: diagnosticRetentionReason(error),
            diagnosticStorageFailure: diagnosticStorageFailure(error),
            retryable: true,
            effect: "possible",
            userInputRequired: false,
            notice:
              "The host could not safely retain this execution's diagnostics and recorded the gap, so no unscreened observations are available for it. The website action may have completed: treat its effect as possible and reconcile before claiming success; never repeat a claimed example. Continue the build. Site code changes, credentials and user clarification cannot repair this infrastructure failure.",
          }),
        );
      /** The entrypoint each execution ran, so a repeat of a write's step can be recognized. */
      const entrypoints = new Map<string, string>();
      /** Every finish_build result as the minter received it, for the outcome reviewer. */
      const publications: string[] = [];
      /** The caller's accepted answers and approved changes, in order, for the outcome reviewer. */
      const acceptedAnswers: unknown[] = [];
      /**
       * The digest of what `entrypoint`'s import closure holds in the workspace now, without
       * paths; undefined when it cannot be read, and a failed read is reported to the host.
       */
      const stepDigest = (entrypoint: string) =>
        Effect.tryPromise({
          try: async () => {
            const files = await readImportClosure(async (path) => {
              if ((await session.pathExists?.(path)) === false) return undefined;
              const text: unknown = await session.readFile?.({ path });
              return typeof text === "string" ? text : undefined;
            }, entrypoint);
            return files.size === 0 ? undefined : contentDigest(files);
          },
          catch: (error) => error,
        }).pipe(
          Effect.catchAll((error) =>
            reportFailure(error, {
              component: "mint",
              operation: "stepDigest",
              phase: "source_digest",
              subCause: "mint_host_dependency_failed",
              correlation: dependencies.reportCorrelation ?? "process",
            }).pipe(Effect.as(undefined)),
          ),
        );
      /** A write Guardian labelled, as the outcome reviewer tracks it. */
      const trackedWrite = (
        executionId: string,
        reviewId: string | undefined,
        purpose: string,
        entrypoint: string | undefined,
        status: WriteExecutionStatus,
        evidence: ExecutionEvidence,
      ) =>
        Effect.gen(function* () {
          const sourceDigest = entrypoint === undefined ? undefined : yield* stepDigest(entrypoint);
          return {
            executionId,
            ...(reviewId === undefined ? {} : { reviewId }),
            purpose,
            ...(entrypoint === undefined ? {} : { entrypoint }),
            ...(sourceDigest === undefined ? {} : { sourceDigest }),
            status,
            effect: evidence.effect,
            ...(evidence.confirmation === undefined ? {} : { confirmation: evidence.confirmation }),
          };
        });
      /**
       * Tells the outcome reviewer about an execution that ran: a write Guardian labelled is
       * tracked and wakes it, and a later live execution wakes it while a write is unresolved,
       * since it may hold a readback.
       */
      const observeExecution = (
        submitted: Parameters<typeof dependencies.reviewAndExecute>[0],
        evidence: ExecutionEvidence,
        allowed: AllowedExecution | undefined,
        status: WriteExecutionStatus,
      ) =>
        Effect.gen(function* () {
          if (evidence.status === "unsupported") return;
          if (submitted.purpose !== "command")
            entrypoints.set(evidence.executionId, submitted.entrypoint);
          const action = evidence.review?.action ?? allowed?.action;
          const reviewId =
            evidence.review?.reviewId ??
            (allowed !== undefined && "reviewId" in allowed ? allowed.reviewId : undefined);
          if (action === "write" && submitted.purpose !== "command")
            return yield* reviewer.write(
              yield* trackedWrite(
                evidence.executionId,
                reviewId,
                submitted.purpose,
                submitted.entrypoint,
                status,
                evidence,
              ),
            );
          if (submitted.target === "liveBrowser")
            yield* reviewer.execution({
              executionId: evidence.executionId,
              purpose: submitted.purpose,
              ...(action === undefined ? {} : { action }),
              status,
            });
        });
      /**
       * Why a step is refused as a repeat of a write: it runs an earlier write's entrypoint, or
       * the same source under another name, after that write may have reached the site, and the
       * outcome reviewer, caught up with no readback outstanding, has not assessed every such
       * write `not_done`. This is the one place the minter waits for the reviewer, and an outage
       * leaves the write unresolved, so it is not repeated.
       */
      const repeatedWriteRefusal = (
        submitted: Parameters<typeof dependencies.reviewAndExecute>[0],
      ) =>
        Effect.gen(function* () {
          if (submitted.purpose === "command" || submitted.target !== "liveBrowser")
            return undefined;
          const sent = reviewer.tracked().filter((write) => write.effect !== "not_sent");
          if (sent.length === 0) return undefined;
          const digest = yield* stepDigest(submitted.entrypoint);
          const earlier = sent.filter(
            (write) =>
              write.entrypoint === submitted.entrypoint ||
              (digest !== undefined && write.sourceDigest === digest),
          );
          if (earlier.length === 0) return undefined;
          const settled = yield* reviewer.settle(earlier.map((write) => write.executionId));
          if (
            settled.current &&
            settled.assessments.every((assessment) => assessment?.outcome === "not_done")
          )
            return undefined;
          const writes = earlier.map((write) => write.executionId).join(", ");
          // With no outcome reviewer, nothing can clear the write, so the refusal lasts the
          // attempt, and a copy of the step is the double write this guard prevents.
          if (dependencies.outcomeReview === undefined)
            return `This step repeats a write that may already have changed the site (${writes}). No outcome review runs here, so ${submitted.entrypoint} stays refused for the rest of this attempt. Never run a copy of it to send the write again: read back what happened in a new file that changes nothing. A write whose outcome stays unknown is reported as possibly applied. Nothing was executed.`;
          const applied = settled.assessments.some((assessment) => assessment?.outcome === "done");
          // A read-back that reuses the write's file is refused as this same repeat.
          const newFile = earlier.some((write) => write.entrypoint === submitted.entrypoint)
            ? ` Write the read-back as a new file. A step that runs ${submitted.entrypoint} stays refused as this repeat only until the outcome review finds the earlier write did not happen; then run ${submitted.entrypoint} itself again, not a copy, since a repair publishes only the entrypoint its confirming step ran.`
            : "";
          return (
            (applied
              ? `This step repeats a write that already changed the site (${writes}), as the outcome review found. Never run it again: continue with the next step, read back the result, or publish. Nothing was executed.`
              : `This step repeats a write that may already have changed the site (${writes}), and no review has shown it did not. A write is never repeated unless its outcome review finds it did not happen. Read back the account or page in a step that changes nothing, so the review can settle it, or publish: a write whose outcome stays unknown is reported as possibly applied. Nothing was executed.`) +
            newFile
          );
        });
      const reviewedExecution: typeof dependencies.reviewAndExecute = (
        submitted,
        onDispatch = () => Effect.void,
      ) =>
        dependencies
          .reviewAndExecute(
            submitted,
            submitted.purpose === "example" ||
              (submitted.purpose === "act" && writeSession === "none")
              ? (allowed) =>
                  Effect.uninterruptible(
                    dependencies.claimExample.pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          exampleClaimed = true;
                          if (submitted.purpose === "act") writeSession = "open";
                        }),
                      ),
                      Effect.zipRight(onDispatch(allowed)),
                    ),
                  )
              : submitted.purpose === "act"
                ? // Later steps continue the session's started claim; the journal never claims again.
                  (allowed) => Effect.uninterruptible(onDispatch(allowed))
                : onDispatch,
          )
          .pipe(
            // A refusal the host returned before any review or dispatch shows neither Guardian
            // nor the provider working, so it leaves both outage windows running.
            Effect.tap((evidence) =>
              evidence.status === "unsupported"
                ? Effect.void
                : reviewCompleted.pipe(
                    Effect.zipRight(
                      Effect.sync(() => {
                        providerOutageStartedAt = undefined;
                      }),
                    ),
                  ),
            ),
            Effect.tapError((error) => (reviewDecided(error) ? reviewCompleted : Effect.void)),
            Effect.map((evidence) => {
              // The script question's correction is for this result only, never the ledger.
              const receipt = {
                ...safeExecutionEvidence(evidence),
                ...(evidence.scriptQuestion === undefined
                  ? {}
                  : { scriptQuestion: evidence.scriptQuestion }),
              };
              // Only this harness's preflight can authorize correcting request mechanics.
              delete receipt.preflight;
              return receipt;
            }),
            Effect.tapError((error) =>
              diagnoseExecution(
                submitted,
                {
                  code: failureCode(error),
                  // The root cause's own code, beneath the host's wrapper.
                  rootCode:
                    error.authentication === undefined
                      ? undefined
                      : signInRootCode(error.authentication),
                  reason: error.reason,
                  destinationReason: error.destinationReason,
                  ...policyFailureMetadata(error),
                  ...authorityCheckMetadata(error),
                  ...destinationPrivateCandidateMetadata(error),
                  reconciliationStage: error.reconciliationStage,
                  review: error.review,
                  reviewFailure: error.reviewFailure,
                  reviewPhase: error.reviewPhase,
                  reviewDispatch: error.reviewDispatch,
                  diagnosticRetentionReason: error.diagnosticRetentionReason,
                  diagnosticScreeningReason: diagnosticScreeningReason(error),
                  diagnosticStorageFailure: error.diagnosticStorageFailure,
                  execution: error.execution,
                  authentication: error.authentication,
                },
                error,
              ),
            ),
            Effect.tap((evidence) =>
              evidence.status === "unsupported"
                ? diagnoseExecution(submitted, {
                    status: evidence.status,
                    reason: evidence.observations,
                  })
                : Effect.void,
            ),
          );
      /**
       * Answers a reviewed execution's failure the agent can act on: a review deny or outage, a
       * retention failure, a capture the host could not produce, the host's own unavailability,
       * or what `executionFailed` picks out.
       */
      const executionFailureFeedback =
        (executionFailed: (error: MintFailure) => boolean, signIn = false) =>
        <A, R>(execution: Effect.Effect<A, MintFailure, R>) =>
          execution.pipe(
            Effect.catchIf(
              (error) => error.code === "ReviewDenied",
              (error) => reviewFeedback(error, signIn),
            ),
            Effect.catchIf(
              (error) => error.code === "ReviewUnavailable",
              reviewUnavailableRetry("execution", reviewUnavailableFeedback),
            ),
            Effect.catchIf(
              (error) => error.diagnosticRetentionReason !== undefined,
              diagnosticUnavailableFeedback,
            ),
            Effect.catchIf(
              (error) =>
                dependencies.executionAvailability?.() === "host_unavailable" ||
                unavailableExecutionHost(error) ||
                error.code === "CaptureUnavailable" ||
                executionFailed(error),
              executionFeedback,
            ),
          );
      const command = (command: string) =>
        serial.withPermits(1)(
          Effect.gen(function* () {
            if (effectQuestion) return yield* new MintFailure({ code: "ScopeDenied" });
            yield* active();
            const evidence = yield* reviewedExecution({
              purpose: "command",
              target: "pureFiles",
              command,
            });
            record(evidence, "command");
            return yield* visible(evidence, "command");
          }).pipe(
            executionFailureFeedback(
              (error) => error.execution !== undefined || error.authentication !== undefined,
            ),
          ),
        );
      const workspace = yield* Effect.try({
        try: () =>
          makeMintWorkspace(dependencies, command, runTool, (run) =>
            runTool(
              serial.withPermits(1)(
                active("publication").pipe(
                  Effect.zipRight(Effect.promise(run).pipe(Effect.uninterruptible)),
                ),
              ),
            ),
          ),
        catch: (error) =>
          new MintFailure({
            failureDetail: failureDetail("mint_host_dependency_failed", {
              operation: "makeMintWorkspace",
              error,
            }),
            code: "Unavailable",
          }),
      });
      const session = effectQuestion ? questionOnlyWorkspace(workspace) : workspace;
      // A host-enforced question turn authorizes no execution, source read or publication.
      const questionOnly = effectQuestion || Boolean(dependencies.capabilityQuestion);
      let captchaChecks = recovered?.captchaChecks ?? 0;
      /**
       * The ending a blocked report takes, or why the agent may not end blocked now, as its tool
       * result. Something it can still get past is not impossible as asked, and the screened
       * explanation keeps its bound, which screening's longer markers can break, so a takeover's
       * checkpoint still reads it.
       */
      const blockedEnding = (
        reason: (typeof BuildBlocked.Type)["reason"],
        screenedExplanation: string,
        now: number,
        liveTestsRefusal: LiveTestsRefusal | undefined,
        intent: string | undefined,
      ):
        | {
            readonly reason: (typeof BuildBlocked.Type)["reason"];
            readonly basis?: "live_tests_spent";
            /** What a `host_refused` ending stood on, each host check in force. */
            readonly hostRefusals?: readonly HostRefusalBasis[];
            /**
             * A `host_refused` ending stands on a host refusal apart from an unconfirmed sign-in
             * (`hostRefusalApartFromSignIn`), so it keeps its reason.
             */
            readonly apartFromSignIn?: true;
          }
        | { readonly refusal: string } => {
        const refused = (
          reason: string,
          instruction: string,
          details: Readonly<Record<string, unknown>> = {},
        ) => ({
          refusal: JSON.stringify({
            status: "blocked_refused",
            reason,
            ...details,
            userInputRequired: false,
            instruction,
          }),
        });
        // A failed sign-in the agent can still get past waits for it, unless the owner declined
        // to sign in: then nothing is left to resolve, and refusing the ending would leave the
        // minter no way to stop. (Once sign-in is unavailable, the report ends the build with
        // that result before it gets here.)
        if (unresolvedSignIn !== undefined && loginDeclined === undefined && !signInAbandoned)
          return refused(
            "sign_in_unresolved",
            "The last sign-in failed and is unresolved. Resolve it as its result says, with authenticate once its cause is fixed, before deciding the task is impossible as asked.",
          );
        // Another review's outage is resubmitted first, until it outlasts its budget.
        if (
          reviewOutageStartedAt !== undefined &&
          !blockedReviewUnavailable &&
          now - reviewOutageStartedAt < reviewOutageBudgetMs
        )
          return refused(
            "review_unavailable_pending",
            "A Guardian review was unavailable and may be resubmitted. Submit that same call again first; an unavailable review is not a reason the task is impossible.",
          );
        if (screenedExplanation.length > blockedExplanationLimit)
          return refused(
            "explanation_too_long",
            "Private values in the explanation made it longer than 500 characters once screened. Shorten it, leave private values out, and call report_blocked again.",
          );
        // Each ending stands on its basis on record. A policy block stands on Guardian's final
        // refusal of an execution, or its publication refusal no correction gets past (an
        // escalation for missing evidence is not one), or `actRefusalsForPolicy` refusals in a
        // row of the act step, unless the host's own guidance names the ending; the minter's
        // reading of its own instructions is none. A host_refused block
        // stands on a host check's refusal the host recorded in this attempt that no later
        // finish_build got past to Guardian's review, or on a sign-in screen the host refused
        // because the password's fills are spent, while they still are, or at its destination
        // check, until a later screen that takes a password or code passed it or a sign-in
        // verified. Neither of those two answers is cleared by a finish_build. It also stands on
        // live tests the host refuses while Guardian's denial of the latest publication stands
        // (`liveTestsRefusal`): the attempt ran out of them, no batch fits, and the host's reserve
        // is closed, so nothing left in the attempt can clear a failure the denial rests on. While
        // the reserve is open, the report waits for it, even when no case is pending until the code
        // changes. A host refusal of a submission the host already refused, sent again unchanged
        // after a later finish_build got past that refusal, is no new refusal and sets none. When
        // the latest host refusal names a step that fixes it, in core's instruction
        // (`namedStepReasons`) or a host's rationale (`rationaleStepReasons`), the first report on
        // its reason goes back with that step, and the next is taken. The owner's no to a
        // confirm question, or to a login, is `owner_declined`; a question handed back unanswered
        // is `question_unanswered`: no answer is no consent, so the minter may end the build
        // safely instead of going on past what it asked. A policy report that stands only on
        // one of those takes its name, so neither ever ends as policy. `owner_ended` needs the
        // owner's latest answer with nothing run since, so a build that went on from an answer
        // never ends as the owner's choice.
        // A no to a question that asked whether to end the build means keep going, never
        // `owner_declined`; while Guardian's denial of the last publication stands, a policy report
        // on it is refused, so the minter's stop ends with that denial.
        const declined = (ending: boolean) =>
          [...answeredQuestions].some(
            ([id, { answer }]) =>
              endsBuildQuestions.has(id) === ending &&
              typeof answer === "object" &&
              "confirmed" in answer &&
              !answer.confirmed,
          );
        const ownerRefused = loginDeclined !== undefined || declined(false);
        const stopDeclined = declined(true);
        const keptGoing = (ending: "owner_declined" | "owner_ended") =>
          refused(
            "owner_kept_going",
            `The owner's no answered whether to end the build, which means keep going, so it is not ${ending} and the build has not ended.${publicationDenial === undefined ? "" : " If Guardian's latest decision asks for evidence nobody can supply, stop: the build ends with Guardian's decision."}`,
          );
        const unanswered = noAnswerHandBacks > 0;
        const refillRefused = dependencies.signInRefillRefused?.() === true;
        const hostCheckRefusing = hostRefused || refillRefused || signInDestinationRefused;
        const liveTestsSpent = liveTestsRefusal !== undefined && !liveTestsRefusal.reserveOpen;
        const hostRefusing = hostCheckRefusing || liveTestsSpent;
        if (reason === "owner_declined" && !ownerRefused && stopDeclined)
          return keptGoing(reason);
        if (reason === "owner_declined" && !ownerRefused)
          return refused(
            "owner_not_declined",
            "The owner declined nothing in this build: no confirm question was answered no, and no login was declined, so the build has not ended. Use owner_declined only after the owner says no to a step the build needs. Ask the owner with request_input when only they can decide.",
          );
        if (reason === "question_unanswered" && !unanswered)
          return refused(
            "no_question_unanswered",
            "No question went unanswered in this build, so the build has not ended. Use question_unanswered only after a question you asked came back as no answer and the build cannot go on without it.",
          );
        if (reason === "owner_ended" && ownerAnsweredLast && ownerKeptGoing)
          return keptGoing(reason);
        if (reason === "owner_ended" && !ownerAnsweredLast)
          return refused(
            "owner_not_ended",
            "The owner gave no answer since this build's last step that could end it, so the build has not ended. Use owner_ended only right after the owner chose in an answer to end the build.",
          );
        if (reason === "host_refused" && !hostRefusing && liveTestsRefusal?.reserveOpen === true) {
          const { reservedFor, failedOnSource } = liveTestsRefusal;
          return refused(
            "live_tests_reserved",
            `The host still keeps one reserved live test batch for the cases a failure is pending on, so the build has not ended.${reservedFor.length === 0 ? "" : ` It runs now: ${reservedFor.join(", ")}.`}${failedOnSource.length === 0 ? "" : ` It runs once you change the code after their failure: ${failedOnSource.join(", ")}.`}${reservedFor.length === 0 && failedOnSource.length === 0 ? ` A case is pending when its input, expectation and next page are a failing result's; ${liveTestsEvidencePath} names each failure that still counts.` : ""} Prefer to fix the code where a case fails, then run those cases together in that one batch, run the example last and call finish_build again.${reservedFor.length === 0 && failedOnSource.length === 0 ? ` If ${liveTestsEvidencePath} names no failure that still counts, the denial rests on something else, so prefer to fix what the denial names, then call finish_build again.` : ""} host_refused stands on refused live tests only once no batch is left.`,
            { reservedFor, failedOnSource },
          );
        }
        // A caller_input ending stands on its intent citing the caller's own request: a field the
        // task's input holds, or words of the request's instruction. A task update the owner
        // confirmed in an answer is that request too, as the effective task every later review
        // reads, so the intent may cite it instead, by its revision or its words: a stop condition
        // the owner picked, which the build then checked and met, ends as the caller's own rule.
        if (
          reason === "caller_input" &&
          !citesCallerRequest(intent, request.intent, taskState.businessInput) &&
          !citesConfirmedUpdate(intent, taskState.updates)
        )
          return refused(
            "caller_input_not_cited",
            "caller_input needs the caller's own request, or a task update the owner confirmed, as its basis, so the build has not ended. In intent, name the request field or the update's revision that stops the build, or quote the words of the caller's instruction or of that update, then call report_blocked again. Prefer another reason when the site or a host check stopped it.",
          );
        if (reason === "host_refused" && !hostRefusing && hostRefusalPassed && hostRefusalRepeated)
          return refused(
            "host_refusal_repeated",
            "Your last finish_build sent again, unchanged, a submission the host refused before a later finish_build got past that refusal to Guardian's review, so it is no new refusal and the build has not ended. Prefer fixing what Guardian's latest decision names, then calling finish_build again. Use host_refused only when a host check still refuses a step and nothing left in this attempt can fix it.",
          );
        if (reason === "host_refused" && !hostRefusing && hostRefusalPassed)
          return refused(
            "host_refusal_passed",
            "A host check refused a step earlier in this attempt, but a later finish_build got past it, so the build has not ended. Fix the findings the latest refusal names and call finish_build again. Use host_refused only when a host check still refuses a step and nothing left in this attempt can fix it.",
          );
        if (reason === "host_refused" && !hostRefusing)
          return refused(
            "host_not_refused",
            "No host check refused a step in this attempt, so the build has not ended. host_refused needs a host check that refused a step the build needs, such as finish_build, a sign-in form or a site change, or live tests the host refuses with no batch left while Guardian's denial of the last publication stands.",
          );
        // The latest host refusal names its own fix, and neither sign-in screen answer stands
        // beside it: the first report on its reason goes back with that step, and the next is
        // taken. Spent live tests never stand beside it: they need Guardian's denial of the latest
        // publication, and a host refusal of a later one ends that denial.
        const latestHostRefusal = hostRefused ? standingHostRefusals.at(-1)?.refusal : undefined;
        const namedStep =
          latestHostRefusal?.source === "publication" &&
          latestHostRefusal.reason !== undefined &&
          (namedStepReasons.has(latestHostRefusal.reason) ||
            (rationaleStepReasons.has(latestHostRefusal.reason) &&
              namedStepRationales.has(latestHostRefusal.reason)))
            ? latestHostRefusal.reason
            : undefined;
        if (
          reason === "host_refused" &&
          namedStep !== undefined &&
          !namedStepsOffered.has(namedStep) &&
          !refillRefused &&
          !signInDestinationRefused
        ) {
          namedStepsOffered.add(namedStep);
          const told = namedStepReasons.has(namedStep)
            ? namedStepInstructions.get(namedStep)
            : undefined;
          const rationale = namedStepRationales.get(namedStep);
          return refused(
            "host_refusal_names_step",
            "The host's last refusal, refusedReason, names a step that fixes it in its instruction or rationale, so the build has not ended. Prefer doing that step and calling finish_build again; if publication still cannot pass, you may report host_refused again.",
            {
              refusedReason: namedStep,
              ...(told === undefined ? {} : { refusalInstruction: told }),
              ...(rationale === undefined ? {} : { refusalRationale: rationale }),
            },
          );
        }
        if (
          reason === "policy" &&
          !guardianRefused &&
          actRefusalsInRow < actRefusalsForPolicy &&
          dependencies.policyBlockAllowed?.(screenedExplanation) !== true
        ) {
          if (ownerRefused) return { reason: "owner_declined" };
          if (unanswered) return { reason: "question_unanswered" };
          if (stopDeclined && publicationDenial !== undefined) return keptGoing("owner_declined");
          return refused(
            "policy_not_refused",
            "Nothing in this attempt refused this: Guardian made no final refusal of an execution, and refused no publication for privacy or authority or for a finding no correction gets past. Use host_refused when a host check refused a step the build needs and nothing left in this attempt can fix it. A publication denial or escalation that names a correction or missing evidence is not a refusal: fix every finding and gather each missing item its rationale names, then call finish_build again. Your instructions are not a refusal either, so the build has not ended. Continue through the page's own controls. Ask the owner with request_input when only they can decide; their no is owner_declined, their choice to end the build is owner_ended, and a question left unanswered is question_unanswered. Use site_lacks_capability only when the site does not offer what the task needs.",
          );
        }
        if (reason !== "host_refused") return { reason };
        // A host_refused report names each host check it stands on, for the record; one that
        // stands only on refused live tests names them as its basis too.
        // A refusal kept without a source this worker reads is `unrecorded`.
        const standing = hostRefused
          ? standingHostRefusals.map(({ refusal, beforeSignIn }) => ({
              refusal: refusal ?? { source: "unrecorded" as const },
              beforeSignIn,
            }))
          : [];
        const others: HostRefusalBasis[] = [
          ...(refillRefused ? [{ source: "sign_in_refill" as const }] : []),
          ...(signInDestinationRefused ? [{ source: "sign_in_destination" as const }] : []),
          ...(liveTestsSpent ? [{ source: "live_tests_spent" as const }] : []),
        ];
        const apart =
          standing.some(({ refusal, beforeSignIn }) =>
            hostRefusalApartFromSignIn(refusal, beforeSignIn),
          ) || others.some((refusal) => hostRefusalApartFromSignIn(refusal, false));
        return {
          reason,
          ...(liveTestsSpent && !hostCheckRefusing ? { basis: "live_tests_spent" as const } : {}),
          hostRefusals: [...standing.map(({ refusal }) => refusal), ...others],
          ...(apart ? { apartFromSignIn: true as const } : {}),
        };
      };
      /**
       * Guardian's question review of a blocked explanation before any caller reads it, with the
       * host's publication refusals and the build's decision ledger. `allow_business` shows it;
       * an unavailable review is offered back for resubmission under the review outage budget
       * (`retry`), and past it, or for any other failure, leaves the reason's fixed sentence alone,
       * never the agent's words; any other outcome goes back to the agent with its rationale.
       */
      const reviewBlockedExplanation = (explanation: string) => {
        const review = dependencies.reviewQuestion;
        return review === undefined
          ? Effect.succeed({ outcome: "unavailable" as const })
          : publicationRefusals.pipe(
              Effect.flatMap((publicationDecisions) =>
                Effect.suspend(() => {
                  const ledger = decisionLedger();
                  return review(
                    { questions: [{ id: "blocked", type: "text", prompt: explanation }] },
                    {
                      blockedOutcome: true,
                      ...publicationDecisions,
                      ...(ledger === undefined ? {} : { decisionLedger: ledger }),
                      ...decidedBuildEffect(),
                    },
                  );
                }),
              ),
              Effect.tap(() => reviewCompleted),
              Effect.catchAll((error) =>
                Effect.gen(function* () {
                  yield* diagnose({
                    phase: "blocked_review",
                    code: failureCode(error),
                    reviewFailure: error.reviewFailure,
                    reviewPhase: error.reviewPhase,
                  });
                  // No outcome a question review allows: the agent revises or withdraws the
                  // explanation once, and a second ends blocked with the reason alone.
                  if (error.reviewFailure === "InvalidOutcome")
                    return invalidOutcomeRepeated()
                      ? { outcome: "unavailable" as const }
                      : {
                          outcome: "invalid_outcome" as const,
                          rationale:
                            "Guardian returned no decision a question review allows, so it neither allowed nor reworded the explanation. Make it plain and consistent with the evidence.",
                        };
                  // A spent quota, a request over the model's input limit or an outage past its
                  // budget still ends blocked: the caller reads the reason alone.
                  if (
                    error.code !== "ReviewUnavailable" ||
                    error.modelOutage === "quota_exhausted" ||
                    error.reviewFailure === "InputTooLarge" ||
                    (yield* reviewRetryExhausted())
                  )
                    return { outcome: "unavailable" as const };
                  blockedReviewUnavailable = true;
                  reviewUnavailableRetries.question += 1;
                  return { outcome: "retry" as const, error };
                }),
              ),
            );
      };
      /**
       * The minter's last final answer as its caller may read it, when it stopped without a tool
       * call: the pipeline a blocked explanation takes (credential screen, host-private
       * redaction, Guardian's question review of a blocked outcome), cut to the explanation's
       * bound, and kept only when Guardian allowed it. The model is gone, so nothing is offered
       * back: any other outcome or failure keeps nothing.
       */
      const reviewedStopExplanation = (text: string | undefined) =>
        Effect.gen(function* () {
          const review = dependencies.reviewQuestion;
          if (text === undefined || text.trim() === "" || review === undefined) return undefined;
          const screened = cutToLimit(
            redactCallerText(yield* screenMintText(dependencies, text)).trim(),
            blockedExplanationLimit,
          );
          if (screened === "") return undefined;
          const decision = yield* review(
            { questions: [{ id: "blocked", type: "text", prompt: screened }] },
            { blockedOutcome: true, ...(yield* publicationRefusals), ...decidedBuildEffect() },
          ).pipe(
            Effect.timeoutFail({
              duration: dependencies.stopExplanationReviewMs ?? 60_000,
              onTimeout: () => new MintFailure({ code: "ReviewUnavailable" }),
            }),
          );
          return decision.outcome === "allow_business" ? screened : undefined;
        }).pipe(
          // Nothing about the explanation may change how the build ended: a failed screen or
          // review, a defect included, keeps nothing. Only an interruption goes on.
          Effect.catchAllCause((cause) =>
            Cause.isInterruptedOnly(cause)
              ? Effect.failCause(cause)
              : diagnose({
                  phase: "stop_explanation",
                  code: Option.match(Cause.failureOption(cause), {
                    onNone: () => "Defect",
                    onSome: failureCode,
                  }),
                }).pipe(Effect.as(undefined)),
          ),
        );
      /** A `mint_update` result for the agent: its status and what the host says. */
      const taskUpdateAnswer = (
        status: TaskUpdateStatus,
        fields: Readonly<Record<string, unknown>>,
      ): string => JSON.stringify({ status, userInputRequired: false, ...fields });
      /** The task an update makes: the current one with its changes applied in order. */
      const nextTaskState = (
        changes: readonly TaskChange[],
        accepted: AcceptedTaskUpdate,
      ): TaskState => {
        let { effect, siteOrigin, businessInput } = taskState;
        for (const change of changes) {
          if (change.setting === "effect") effect = change.effect;
          else if (change.setting === "site") siteOrigin = change.origin;
          else if (change.setting === "input") {
            const values: Record<string, unknown> = { ...(businessInput as object) };
            for (const [key, value] of Object.entries(change.values))
              if (value === null) Reflect.deleteProperty(values, key);
              else
                Object.defineProperty(values, key, {
                  value,
                  enumerable: true,
                  configurable: true,
                  writable: true,
                });
            businessInput = values;
          }
        }
        return {
          revision: accepted.revision,
          effect,
          ...(siteOrigin === undefined ? {} : { siteOrigin }),
          businessInput,
          updates: [...taskState.updates, accepted],
        };
      };
      /**
       * Ends the build blocked with a recommended new build: the reviewed summary and suggested
       * request, which its caller reads. Text that screening lengthened past the limit stays out.
       */
      const recommendNewMint = (update: PendingTaskUpdate, by: "minter" | "guardian") =>
        Effect.gen(function* () {
          const shown = (text: string | undefined) =>
            text !== undefined && text.length <= blockedExplanationLimit ? text : undefined;
          const explanation = shown(update.summary);
          const suggestedRequest = shown(update.suggestedRequest);
          terminal = {
            build: "incomplete",
            blocked: {
              reason: "new_mint_recommended",
              ...(explanation === undefined ? {} : { explanation }),
              ...(suggestedRequest === undefined ? {} : { suggestedRequest }),
            },
            summary: `The build is blocked (new_mint_recommended): ${update.summary}`,
          };
          yield* diagnose({ phase: "blocked", reason: "new_mint_recommended", recommendedBy: by });
          return taskUpdateAnswer("new_mint_recommended", {
            notice:
              by === "guardian"
                ? "Guardian found that this change belongs in a new build, so this build ended blocked. Its caller reads your summary and suggested request; nothing more runs in this attempt."
                : "The build ended blocked with your recommendation of a new build. Its caller reads your summary and suggested request; nothing more runs in this attempt.",
          });
        });
      /** What the agent does after an update the host applied, by what it changed. */
      const updatedInstruction = (changes: readonly TaskChange[]) => {
        const settings = new Set(changes.map((change) => change.setting));
        return [
          "The host applied the update. Continue in this attempt under the effective task: the original request with this and every earlier accepted update, which every later review reads. Executions already recorded keep the task they ran under, and a write that may have committed is never repeated.",
          ...(settings.has("site")
            ? [
                "The build now targets task.siteOrigin: the host rebound its site, sign-in and publication there. Navigate there yourself; pages, captures and sign-ins from the earlier site are evidence about that site only. Sign in with execute purpose authenticate if the task needs it there.",
              ]
            : []),
          ...(settings.has("input")
            ? [
                "The changed input values are the host-bound input from now on: an example or act step runs them, and the tool's input schema takes them.",
              ]
            : []),
          ...(changes.some((change) => change.setting === "login" && change.change === "signed_out")
            ? [
                `The task now runs signed out: never call execute purpose authenticate again. ${buildEffect === "write" ? signedOutWrite : "Explore, run the example and live tests, and publish without signing in, from the part of the request the site shows signed out"}.`,
              ]
            : []),
          ...(settings.has("effect")
            ? [
                "This build is now a write build, and every later execution is reviewed under write authority. Read .agents/writes/SKILL.md, and .agents/forms/SKILL.md for a form, before the next step. The write is the whole task the request asks for, done once through purpose act steps; it may take several steps, and drafts, autosaves and step saves along the way are part of it. Before the first act step, ask with request_input for any value the task needs that the input does not settle. The first act step starts with navigation to the site origin (keeping the browser's cookies and site storage), so it must navigate to any deeper task page it needs; what you observed so far stays valid evidence. From now on a live example or live test is refused, and so is a live explore once the session starts.",
              ]
            : []),
        ].join(" ");
      };
      /** The `updated` result: the effective task as it now stands, and what to do next. */
      const updatedAnswer = (changes: readonly TaskChange[], notice: string | undefined) =>
        Effect.gen(function* () {
          const domain =
            taskState.siteOrigin === undefined ? undefined : siteDomain(taskState.siteOrigin);
          return taskUpdateAnswer("updated", {
            task: {
              revision: taskState.revision,
              effect: buildEffect === "write" ? "write" : "read",
              ...(taskState.siteOrigin === undefined ? {} : { siteOrigin: taskState.siteOrigin }),
              ...(domain === undefined ? {} : { siteDomain: domain }),
            },
            repeatableRead,
            ...(notice === undefined
              ? {}
              : { notice: yield* screenMintText(dependencies, notice) }),
            instruction: updatedInstruction(changes),
          });
        });
      /** Who may confirm a maintenance contract change; a failure or no hook means nobody. */
      const maintenanceConfirmer = (
        dependencies.taskUpdateConfirmer?.() ?? Effect.succeed("none" as const)
      ).pipe(
        // A host outside the type, such as a script returning another word, names nobody.
        Effect.map((confirmer): TaskUpdateConfirmer =>
          confirmer === "owner" || confirmer === "owner_request" ? confirmer : "none",
        ),
        Effect.catchAll((error) =>
          reportFailure(error, {
            component: "mint",
            operation: "taskUpdateConfirmer",
            phase: "task_update",
            subCause: "mint_host_dependency_failed",
            correlation: dependencies.reportCorrelation ?? "process",
          }).pipe(Effect.as("none" as const)),
        ),
      );
      /**
       * The task revision at which Guardian's new_mint on a same-task update went back to the
       * minter to ask the caller. A takeover forgets it, so the caller may be asked once more.
       */
      let newBuildAskedAt: number | undefined;
      /** Guardian's review of a confirmed update, then the host's application of an allowed one. */
      const reviewAndApplyTaskUpdate = (
        submitted: TaskUpdateRequest,
        /** The confirmer the gate already asked the host about, so one update asks once. */
        asked?: TaskUpdateConfirmer,
      ) =>
        Effect.gen(function* () {
          const review = dependencies.reviewTaskUpdate;
          const apply = dependencies.applyTaskUpdate;
          if (review === undefined || apply === undefined)
            return yield* new MintFailure({ code: "Unavailable" });
          const confirmation = submitted.confirmedBy.flatMap((id) => {
            const answer = answeredQuestions.get(id);
            return answer === undefined ? [] : [answer];
          });
          // The caller may read the summary and suggested request, so host-private values go first.
          const update = yield* taskUpdateForReview(
            {
              summary: redactCallerText(submitted.summary),
              changes: submitted.changes,
              recommend: submitted.recommend,
              ...(submitted.suggestedRequest === undefined
                ? {}
                : { suggestedRequest: redactCallerText(submitted.suggestedRequest) }),
            },
            {
              confirmation,
              effect: buildEffect === "write" ? "write" : "read",
              ...(yield* publicationRefusals),
              // Who can confirm, as the host says; a change that only adds or tightens output
              // fields reaches review even when nobody can.
              ...(request.mode === "maintenance"
                ? { maintenance: { confirmer: asked ?? (yield* maintenanceConfirmer) } }
                : {}),
              // So Guardian knows a site change here can only be a new build.
              ...(dependencies.siteMoveUnsupported === true
                ? { siteMoveUnsupported: true as const }
                : {}),
            },
            {
              text: (text) => screenMintText(dependencies, text),
              json: (value) => dependencies.projection.json(value),
            },
          );
          // Screening can lengthen the suggested request past what the ending keeps, which would
          // end the build with nothing for the caller to send, so the minter shortens it first.
          if (
            submitted.recommend === "new_mint" &&
            update.suggestedRequest !== undefined &&
            update.suggestedRequest.length > blockedExplanationLimit
          )
            return taskUpdateAnswer("update_invalid", {
              reason: "suggested_request_too_long",
              instruction:
                "Private values in suggestedRequest made it longer than 500 characters once screened. Shorten it, leave private values out, and call mint_update again.",
            });
          const decision = yield* review({ update, current: taskState });
          yield* reviewCompleted;
          yield* active("publication");
          const rationale = yield* screenRationale(decision.rationale);
          yield* reportBestEffort(
            dependencies.diagnostics?.emit("mint.task_update_reviewed", {
              ...(decision.reviewId === undefined ? {} : { reviewId: decision.reviewId }),
              outcome: decision.outcome,
              recommend: submitted.recommend,
              settings: submitted.changes.map((change) => change.setting),
              confirmations: confirmation.length,
            }) ?? Effect.void,
            {
              component: "mint",
              operation: "diagnostics.emit",
              phase: "mint.task_update_reviewed",
              correlation: dependencies.reportCorrelation ?? "process",
            },
          );
          // Guardian's new_mint on the minter's same-task update asks the caller first: they asked
          // for this task, and only the minter's own recommendation writes a new build's request.
          // Another one before an update applies is the same change, which the caller was already
          // asked about, so the minter rewords it instead of asking them again.
          const sameTaskNewBuild =
            decision.outcome === "new_mint" && submitted.recommend === "update";
          const askedBefore = sameTaskNewBuild && newBuildAskedAt === taskState.revision;
          if (sameTaskNewBuild) newBuildAskedAt = taskState.revision;
          if (decision.outcome === "reword" || askedBefore)
            return taskUpdateAnswer("reword", {
              rationale,
              instruction:
                "Nothing changed, and the build continues under the current task. Revise the update using the rationale and call mint_update again, or continue without it.",
            });
          if (decision.outcome === "clarify" || sameTaskNewBuild)
            return taskUpdateAnswer("clarification_required", {
              source: "guardian",
              rationale,
              instruction:
                "Nothing changed. Ask the caller with request_input about what the rationale says is unconfirmed, naming the change plainly, then call mint_update again naming the questions they answered in confirmedBy.",
            });
          // Only the minter's own recommendation ends the build, so it carries its suggested request.
          if (submitted.recommend === "new_mint")
            return yield* recommendNewMint(
              update,
              decision.outcome === "new_mint" ? "guardian" : "minter",
            );
          const accepted: AcceptedTaskUpdate = {
            revision: taskState.revision + 1,
            summary: update.summary,
            changes: update.changes,
            confirmation,
            requestDigest: taskUpdateDigest(submitted),
            ...(decision.reviewId === undefined ? {} : { reviewId: decision.reviewId }),
          };
          // The host binds the values the agent gave; reviews read the screened copy in `accepted`.
          const next = nextTaskState(submitted.changes, accepted);
          // The host stores this checkpoint with its own bindings in one step, so a takeover
          // restores either the whole update or none of it.
          const applied = yield* Effect.either(
            apply({
              current: taskState,
              next,
              update: accepted,
              harness: captureHarness(next),
            }),
          );
          if (applied._tag === "Left") {
            yield* reportFailure(applied.left, {
              component: "mint",
              operation: "applyTaskUpdate",
              phase: "task_update",
              subCause: "mint_host_dependency_failed",
              correlation: dependencies.reportCorrelation ?? "process",
            });
            return taskUpdateAnswer("update_refused", {
              reason: "host_failed",
              code: applied.left.code,
              ...failureDetailMetadata(applied.left),
              instruction:
                "Guardian allowed the update, but the host could not apply it, so nothing changed. failureDetail says which step failed. You may call mint_update again once; otherwise continue under the current task, or end the attempt and say in the summary that the caller confirmed a change the host could not apply.",
            });
          }
          const result = applied.right;
          if (result.outcome === "clarification_required")
            return taskUpdateAnswer("clarification_required", {
              source: "host",
              reason: result.reason,
              notice: yield* screenMintText(dependencies, result.notice),
              instruction:
                "Guardian allowed the update, but the host needs something only the caller can give before it applies, so nothing changed yet. Follow the notice, then call mint_update again.",
            });
          if (result.outcome === "refused") {
            // The host refused to apply the update, such as a site change, by its own check. The
            // harness's refusals before review, and one the host failed to apply, are no host
            // check refusing a step.
            refuseByHost({ source: "task_update", reason: taskUpdateRefusalCode(result.reason) });
            return taskUpdateAnswer("update_refused", {
              reason: result.reason,
              notice: yield* screenMintText(dependencies, result.notice),
              instruction:
                "The host cannot apply this update to this build, so nothing changed. Continue under the current task, or call mint_update with recommend new_mint if the caller's change needs a new build.",
            });
          }
          const effectChanged = next.effect === "write" && buildEffect !== "write";
          const siteChanged = next.siteOrigin !== taskState.siteOrigin;
          taskState = next;
          // The first site's unconfirmed sign-in says nothing of the next site.
          if (siteChanged) {
            signInUnconfirmed = false;
            signInRefusalOnly = false;
          }
          // The task now runs signed out: a failed sign-in no longer holds anything back, and no
          // sign-in runs until a later update asks for one, which the owner then confirmed.
          for (const change of accepted.changes)
            if (change.setting === "login") {
              if (change.change === "signed_out") {
                signInAbandoned = true;
                unresolvedSignIn = undefined;
              } else {
                signInAbandoned = false;
                loginDeclined = undefined;
              }
            }
          // An applied update changes the remaining work, which may settle an unresolved write.
          yield* reviewer.taskUpdated(
            `The caller confirmed a task update (revision ${next.revision}): ${accepted.summary}`,
          );
          if (effectChanged) {
            buildEffect = "write";
            repeatableRead = false;
            // A read example's claim was the read's, and a read ran no write session: the write
            // session takes its own claim.
            exampleClaimed = false;
            writeSession = "none";
          }
          yield* reportBestEffort(
            dependencies.diagnostics?.emit("mint.task_updated", {
              revision: taskState.revision,
              settings: submitted.changes.map((change) => change.setting),
              effectChanged,
              siteChanged,
              priorExecutions: purposes.size,
              priorLiveExecutions: executions.filter((entry) => entry.effect !== "not_sent").length,
            }) ?? Effect.void,
            {
              component: "mint",
              operation: "diagnostics.emit",
              phase: "mint.task_updated",
              correlation: dependencies.reportCorrelation ?? "process",
            },
          );
          return yield* updatedAnswer(submitted.changes, result.notice);
        });
      /**
       * Each live test case's latest result on each version, by case id; a takeover restores
       * them. A batch on the HTTP version never replaces or stales the Playwright version's
       * results, nor the reverse. A record from an older release names no entrypoint: it is the
       * Playwright version's.
       */
      const liveTestRecords: Record<LiveTestVersion, Map<string, LiveTestRecord>> = {
        playwright: new Map(),
        http: new Map(),
      };
      // The HTTP version's results have a field of their own: a record in liveTests that names
      // no entrypoint, as an older release writes it, is the Playwright version's.
      const recoveredLiveTests = [
        ...(recovered?.liveTests ?? []),
        ...(recovered?.liveTestsHttp ?? []),
      ];
      for (const record of recoveredLiveTests)
        if (record.retired !== true)
          liveTestRecords[liveTestVersion(record.entrypoint)].set(record.id, record);
      const recordsFor = (entrypoint: string) => liveTestRecords[liveTestVersion(entrypoint)];
      /**
       * Failing results the minter replaced by changing their case, so the publication review
       * still sees them. Bounded for each version: the oldest go first.
       */
      const liveTestReplaced: LiveTestRecord[] = recoveredLiveTests.filter(
        (record) => record.retired === true,
      );
      /**
       * This attempt's judged live test batches that an execution review may still read, oldest
       * first, each with the digest of the source it ran and the failing cases a later pass on the
       * same entrypoint and source released. In memory: a takeover starts without them.
       */
      const batchHistory: {
        readonly batch: Omit<ReviewedLiveTestBatch, "sourceUnchanged">;
        readonly released: Set<string>;
      }[] = [];
      /**
       * The failures a batch holds that still stand: cases that did not pass in it and have not
       * passed since in a batch on the same entrypoint and source. A pass elsewhere, or an
       * inconclusive rerun, releases nothing.
       */
      const standingFailures = ({ batch, released }: (typeof batchHistory)[number]) =>
        batch.cases.filter((ran) => ran.verdict !== "pass" && !released.has(ran.id));
      /**
       * What a review reads, given each entrypoint's current digest: the latest
       * `reviewedLiveTestBatches` batches, and for each entrypoint, case and verdict that still
       * fails, the newest batch holding it on the entrypoint's current source, else the newest
       * holding it. So passing reruns of some cases never push a failure of another out of view,
       * and a failure on a source the workspace returns to is still there.
       */
      const reviewedBatches = (current: ReadonlyMap<string, string | undefined>) => {
        const onCurrent = ({ batch }: (typeof batchHistory)[number]) =>
          batch.sourceDigest === current.get(batch.entrypoint);
        const holders = new Map<string, (typeof batchHistory)[number]>();
        for (const entry of batchHistory)
          for (const ran of standingFailures(entry)) {
            const key = `${entry.batch.entrypoint}\n${ran.id}\n${ran.verdict}`;
            const held = holders.get(key);
            if (held === undefined || onCurrent(entry) || !onCurrent(held)) holders.set(key, entry);
          }
        const shown = new Set([...batchHistory.slice(-reviewedLiveTestBatches), ...holders.values()]);
        return batchHistory.filter((entry) => shown.has(entry)).map((entry) => entry.batch);
      };
      /**
       * Records a judged batch, its passes releasing earlier failures on the same source. A batch
       * outside the latest few is dropped once every failure it holds is released or held by a
       * newer batch on the same source, which one pass would release with it.
       */
      const recordBatch = (batch: (typeof batchHistory)[number]["batch"]) => {
        const passed = batch.cases.filter((ran) => ran.verdict === "pass").map((ran) => ran.id);
        for (const earlier of batchHistory)
          if (
            earlier.batch.entrypoint === batch.entrypoint &&
            earlier.batch.sourceDigest === batch.sourceDigest
          )
            for (const id of passed) earlier.released.add(id);
        batchHistory.push({ batch, released: new Set() });
        const sourceKeys = (entry: (typeof batchHistory)[number]) =>
          standingFailures(entry).map(
            (ran) =>
              `${entry.batch.entrypoint}\n${entry.batch.sourceDigest}\n${ran.id}\n${ran.verdict}`,
          );
        const latest = new Set(batchHistory.slice(-reviewedLiveTestBatches));
        for (let index = batchHistory.length - 1; index >= 0; index -= 1) {
          const entry = batchHistory[index];
          if (entry === undefined || latest.has(entry)) continue;
          const newer = new Set(batchHistory.slice(index + 1).flatMap(sourceKeys));
          if (sourceKeys(entry).every((key) => newer.has(key))) batchHistory.splice(index, 1);
        }
      };
      let batchesJudged = 0;
      dependencies.liveTests?.bindBatches?.(
        Effect.suspend(() =>
          Effect.forEach(
            [...new Set(batchHistory.map(({ batch }) => batch.entrypoint))],
            (entrypoint) => stepDigest(entrypoint).pipe(Effect.map((digest) => [entrypoint, digest] as const)),
          ),
        ).pipe(
          Effect.map((digests) => {
            const current = new Map(digests);
            return reviewedBatches(current).map(
              (batch): ReviewedLiveTestBatch => ({
                ...batch,
                entrypoint: `operation/${batch.entrypoint}`,
                sourceUnchanged:
                  current.get(batch.entrypoint) !== undefined &&
                  current.get(batch.entrypoint) === batch.sourceDigest,
              }),
            );
          }),
        ),
      );
      /**
       * The blocked explanation review's decision ledger: this attempt's denials and host
       * refusals, each case's latest verdict counted, the latest cases that did not pass, a
       * replaced failure included, and each no-match case's latest verdict. Undefined when there
       * is nothing to record.
       */
      const decisionLedger = (): DecisionLedger | undefined => {
        const latest = [...liveTestRecords.playwright.values(), ...liveTestRecords.http.values()];
        const failing = [...liveTestReplaced, ...latest].filter(
          (record) => record.verdict !== "pass",
        );
        const noMatch = latest
          .filter((record) => record.expect === "empty" || record.noMatch === true)
          .slice(-ledgerBounds.noMatchCases);
        if (
          !ledgerPartial &&
          ledgerDenials.length === 0 &&
          ledgerHostRefusals.length === 0 &&
          latest.length === 0 &&
          liveTestReplaced.length === 0
        )
          return undefined;
        const shown = failing.slice(-ledgerBounds.testFailures);
        const count = (verdict: LiveTestRecord["verdict"]) =>
          latest.filter((record) => record.verdict === verdict).length;
        return {
          ...(ledgerPartial ? { partial: true as const } : {}),
          denials: [...ledgerDenials],
          ...(omittedLedgerDenials === 0 ? {} : { omittedDenials: omittedLedgerDenials }),
          ...(latest.length === 0
            ? {}
            : {
                testCounts: {
                  pass: count("pass"),
                  fail: count("fail"),
                  inconclusive: count("inconclusive"),
                },
              }),
          testFailures: shown.map((record): LedgerTestFailure => {
            // What the tool threw is its own account. `got` repeats its error class when it threw,
            // and is otherwise the host's reading of the result.
            const toolReported = {
              ...(record.errorClass === undefined
                ? {}
                : { errorClass: capped(record.errorClass, ledgerBounds.errorClassChars) }),
              // Screened when the batch recorded it.
              ...(record.message === undefined
                ? {}
                : { message: capped(record.message, ledgerBounds.messageChars) }),
            };
            return {
              caseId: record.id,
              ...(record.entrypoint === undefined ? {} : { entrypoint: record.entrypoint }),
              verdict: record.verdict === "fail" ? "fail" : "inconclusive",
              ...(record.errorClass === undefined
                ? { got: capped(record.got, ledgerBounds.gotChars) }
                : {}),
              ...(Object.keys(toolReported).length === 0 ? {} : { toolReported }),
              ...(record.retired === true ? { retired: true as const } : {}),
            };
          }),
          ...(failing.length > shown.length
            ? { omittedTestFailures: failing.length - shown.length }
            : {}),
          ...(ledgerHostRefusals.length === 0 ? {} : { hostRefusals: [...ledgerHostRefusals] }),
          ...(noMatch.length === 0
            ? {}
            : {
                noMatchCases: noMatch.map((record) => ({
                  caseId: record.id,
                  verdict: record.verdict,
                  // Screened when the batch recorded it.
                  ...(record.excerpt === undefined
                    ? {}
                    : { excerpt: capped(record.excerpt, ledgerBounds.messageChars) }),
                })),
              }),
        };
      };
      /**
       * Whether the attempt ran out of time for live tests: a batch refused for time, or a case
       * stopped by a batch deadline the attempt's own end set. A batch's ten-minute cap never
       * counts, so the size of a batch cannot set it.
       */
      let liveTestsOutOfTime = recovered?.liveTestsOutOfTime === true;
      /**
       * The distinct inputs (`testInputKey`) this attempt's signed-in read ran live tests on,
       * through live_tests or an execute testInput, bounded by `signedInTestInputLimit`.
       */
      const signedInTestInputs: string[] = [...(recovered?.signedInTestInputs ?? [])];
      /** Each case's latest screened output, by version and case id: this attempt's runs only. */
      const liveTestOutputs = new Map<string, unknown>();
      const outputKey = (entrypoint: string, id: string) => `${liveTestVersion(entrypoint)}\n${id}`;
      /**
       * Each case's latest output fields, by version and case id, as paths and counts with no
       * value, and the source it ran: this attempt's runs only. A field no case on the same source
       * filled is flagged on each, and on the example at publication.
       */
      const liveTestFills = new Map<
        string,
        { readonly sourceDigest: string; readonly fill: FieldFill }
      >();
      const fillsOnSource = (entrypoint: string, sourceDigest: string | undefined, except?: string) =>
        [...liveTestFills]
          .filter(
            ([key, entry]) =>
              key !== except &&
              key.startsWith(`${liveTestVersion(entrypoint)}\n`) &&
              entry.sourceDigest === sourceDigest,
          )
          .map(([, entry]) => entry.fill);
      /** Whether a passing example's receipt already carried the test plan. */
      let testPlanSent = recoveredLiveTests.length > 0;
      /**
       * Whether this read signed in. A read signed out runs as many live tests as it needs; a
       * signed-in read runs them on at most `signedInTestInputLimit` distinct inputs, on its own
       * signed-in browser, and its publication record holds only what ran signed in. Read at each
       * use, so a read that signs in mid-build, a repair included, is held to that bound from then
       * on. Only a sign-in on the current site counts, as on the host.
       */
      const signedIn = () =>
        executions.some(
          (entry) =>
            entry.authentication?.state === "authenticated" &&
            // A sign-in on the site an update moved the build away from is that site's.
            (revisions.get(entry.executionId) ?? 0) >= latestRevisionChanging("site"),
        );
      /**
       * Whether the host runs a signed-in read's batches on the build's own signed-in browser
       * (`LiveTestHost.signedInBatches`). Without it a signed-in read runs no live tests, as before.
       */
      const signedInTestsSupported = dependencies.liveTests?.signedInBatches === true;
      /**
       * A write never runs live tests: its act session is the one run that proves it. A signed-in
       * read runs them only on a host that supports signed-in batches.
       */
      const liveTestsOffered = () =>
        dependencies.liveTests !== undefined &&
        buildEffect === "read" &&
        (signedInTestsSupported || !signedIn());
      /**
       * A case's latest result on `entrypoint`'s version, as this read counts it now: once it
       * signed in, only a result run signed in, since one from before tested another session.
       */
      const countedRecord = (entrypoint: string, id: string) => {
        const record = recordsFor(entrypoint).get(id);
        return record === undefined || !signedIn() || record.signedIn === true ? record : undefined;
      };
      /** The agent's cases file as it stands, or why it cannot be used. */
      const readCasesFile = Effect.promise(async () => {
        try {
          if ((await session.pathExists?.(liveTestCasesPath)) !== true)
            return decodeCasesFile(undefined);
          const text: unknown = await session.readFile?.({ path: liveTestCasesPath });
          return decodeCasesFile(typeof text === "string" ? text : undefined);
        } catch {
          return Either.left(`${liveTestCasesPath} could not be read.`);
        }
      });
      /** Schemas the host read, by entrypoint and source digest, so one source is read once. */
      const liveTestSchemas = new Map<string, { readonly input: unknown; readonly output: unknown }>();
      /**
       * What judging and paging a batch read from `entrypoint`'s current schemas: the cursor pair
       * and where a list read's results sit, or why the host could not read them.
       */
      const liveTestShape = (entrypoint: string) =>
        Effect.gen(function* () {
          const host = dependencies.liveTests;
          if (host === undefined) return { problem: "This host runs no live test batches." };
          const key = `${entrypoint}\n${(yield* stepDigest(entrypoint)) ?? ""}`;
          const known = liveTestSchemas.get(key);
          const schemas =
            known === undefined ? yield* Effect.either(host.schemas(entrypoint)) : Either.right(known);
          if (Either.isLeft(schemas))
            return {
              problem: `The host could not read ${entrypoint}'s input and output schemas offline, so it judged each result as a single record and can run no next page. Make the source import cleanly and declare both schemas, then run the cases again.`,
            };
          liveTestSchemas.set(key, schemas.right);
          const { input, output } = schemas.right;
          return {
            cursor: cursorPairOf(input, output),
            list: primaryListOf(input, output),
            inputSchema: input,
            outputSchema: output,
          };
        });
      const emptyCases: LiveTestCasesFile = { cases: [] };
      /** What a signed-in read designs, in place of a read signed out's suite. */
      const signedInPlanInstruction = `This read signed in, so it runs live tests on at most ${signedInTestInputLimit} distinct inputs beyond its example, as the testing skill says: one combined case in ${liveTestCasesPath} that sets every optional input and filter the example left unset, with values the site shows (a picker's options, or values in the example's own rows, never a person's or record's name, number or email). Choose each value so at least one example row fails it while some rows still pass every filter, since a value every example row already satisfies passes even when the tool ignores it, and name in purpose the row each value excludes. Set next_page true when the tool pages. Add a second case only for inputs that cannot be set with the others, and one no-match case, a made-up key for an input that takes a record's own id, key or URL, else a query or filter the site has no results for (testing skill). Then run it with live_tests action run and check that every row it returns satisfies each input it set, that the excluded rows are gone, and that page two holds new rows. Running it again after a fix, or on src/tool-http.mjs, is free.`;
      /** What the agent reads about its tests: its cases and their results. */
      const liveTestPlanView = (
        entrypoint: string,
        options: { readonly show?: readonly string[]; readonly ran?: readonly string[] } = {},
      ) =>
        Effect.gen(function* () {
          const read = yield* readCasesFile;
          const file = Either.isRight(read) ? read.right : emptyCases;
          const digest = yield* stepDigest(entrypoint);
          const cases = file.cases.map((testCase) => ({
            ...caseView(testCase, countedRecord(entrypoint, testCase.id), digest),
            ...(options.show?.includes(testCase.id) &&
            liveTestOutputs.has(outputKey(entrypoint, testCase.id))
              ? { output: liveTestOutputs.get(outputKey(entrypoint, testCase.id)) }
              : {}),
          }));
          const shown =
            options.ran === undefined
              ? cases
              : cases.filter((testCase) => options.ran?.includes(testCase.id));
          return {
            kind: "host_live_tests",
            entrypoint,
            ...(Either.isLeft(read) ? { casesFileProblem: read.left } : {}),
            cases: shown,
            ...(options.ran === undefined ? {} : { otherCases: file.cases.length - options.ran.length }),
            ...(shown.some((testCase) => "outputChecks" in testCase)
              ? {
                  outputChecksInstruction:
                    "The host checked every value each case returned, as it checks the example's. Check each finding against the page. Fix a wrong value at the read in source: read rendered text with visibleText, visibleTexts or readRows, expand collapsed text before reading it and read it back, and scope rows to the main list; never clean a string afterwards. A repeated item ID is often a sponsored copy of an organic result: first check whether the rows are variants or line items that share an ID on purpose, and return a copy once only when it is the same item. A field empty in every case's records was usually read from a collapsed section or a guessed key. A value that is correct as it is needs no change. A case's findings never refuse publication by themselves, but a blocking one (script, css, markup, template_residue) in the example's output refuses finish_build until fixed or overridden.",
                }
              : {}),
            ...(file.notTested === undefined ? {} : { notTested: file.notTested }),
            instruction:
              cases.length === 0
                ? signedIn()
                  ? signedInPlanInstruction
                  : `Design a handful of cases in ${liveTestCasesPath} from what you saw on the site, as the testing skill says: one case that sets together every input the example left unset, the example's input once more, no results, the next page, and another case only where a different layout or real variant needs it. Then call live_tests with action run.`
                : cases.every((testCase) => testCase.status === "pass")
                  ? "Every case passes on the current source. Check what the outputs mean (filters applied to every item, rows each filter excludes gone, page two holding new rows, the order, the applied location), add a case for anything the tool claims that no case tests yet, then make your last edit, run every case again, run the example last and call finish_build."
                  : `Fix the code for each failing case at its frame. Fix everything this batch revealed before you run again, then rerun the failing cases and every case the fixes can touch, together in one batch named in cases, on each version you ship whose source the fixes changed. Add a case for anything the tool claims that no case tests yet, then, after your last edit, run every case once with cases null. Publication review reads ${liveTestsEvidencePath}, the host's record of these results on the source you publish, against what the tool claims.`,
          };
        });
      /**
       * The batch's end: ten minutes at most, and two minutes before the attempt's deadline;
       * `attemptBound` when the attempt's end, not the cap, set it.
       */
      const liveTestDeadline = Effect.map(Clock.currentTimeMillis, (now) => {
        const remaining = dependencies.deadline?.remainingMs() ?? Number.POSITIVE_INFINITY;
        const attemptLeft = remaining - 2 * 60_000;
        return {
          deadlineAt: now + Math.min(10 * 60_000, attemptLeft),
          attemptBound: attemptLeft <= 10 * 60_000,
        };
      });
      /**
       * Whether a batch ending at `deadlineAt` has time for one case on `host`, as long as one case
       * may take there (`LiveTestHost.caseTimeoutMs`). A host that caps its batches raises that
       * limit past any deadline once its last batch ran, so no batch fits from then on.
       */
      const liveTestBatchFits = (host: LiveTestHost, deadlineAt: number) =>
        Effect.map(
          Clock.currentTimeMillis,
          (now) => deadlineAt - now >= (host.caseTimeoutMs ?? defaultLiveTestCaseMs),
        );
      /**
       * The cases a batch on the host's reserve may run once no batch fits
       * (`LiveTestHost.reservedCaseTimeoutMs`): those a failure is pending on, when a batch ending
       * at `deadlineAt` has time for one case there; none without a reserve.
       */
      const reservedBatchCases = (
        host: LiveTestHost,
        deadlineAt: number,
        file: LiveTestCasesFile,
        entrypoint: string,
        digest: string,
      ) =>
        Effect.map(liveTestReserveOpen(host, deadlineAt), (open) =>
          open
            ? pendingFailureCases(file, recordsFor(entrypoint), replacedOn(entrypoint), digest)
            : [],
        );
      /**
       * Whether the host still keeps its reserve past its batch cap
       * (`LiveTestHost.reservedCaseTimeoutMs`) with time for it before a batch's end at
       * `deadlineAt`: it has not run, and a re-test of a failure can still run in it.
       */
      const liveTestReserveOpen = (host: LiveTestHost, deadlineAt: number) =>
        Effect.map(Clock.currentTimeMillis, (now) => {
          const reserved = host.reservedCaseTimeoutMs;
          return reserved !== undefined && deadlineAt - now >= reserved;
        });
      /** The failing results the minter replaced on `entrypoint`'s version. */
      const replacedOn = (entrypoint: string) => {
        const version = liveTestVersion(entrypoint);
        return liveTestReplaced.filter((record) => liveTestVersion(record.entrypoint) === version);
      };
      /**
       * The cases in `file` with a failing result of `entrypoint`'s version on `digest`, its own
       * latest or a retired one, as `pendingFailureCases` matches them: the ones the host's reserve
       * leaves out until the source changes, since a pass on the source a case failed on excuses
       * nothing.
       */
      const failedOnSourceCases = (file: LiveTestCasesFile, entrypoint: string, digest: string) => {
        const failedHere = new Set(
          [...recordsFor(entrypoint).values(), ...replacedOn(entrypoint)]
            .filter((record) => record.verdict === "fail" && record.sourceDigest === digest)
            .map((record) => record.caseDigest),
        );
        return file.cases
          .filter((testCase) => failedHere.has(caseDigest(testCase)))
          .map((testCase) => testCase.id);
      };
      const runLiveTests = (request: LiveTestsRequest) =>
        Effect.gen(function* () {
          const host = dependencies.liveTests;
          if (host === undefined) return yield* new MintFailure({ code: "Unavailable" });
          const read = yield* readCasesFile;
          if (Either.isLeft(read))
            return JSON.stringify({
              kind: "host_live_tests",
              status: "invalid_cases",
              problem: read.left,
              instruction: `Fix ${liveTestCasesPath}, then run again. Nothing was executed.`,
            });
          const file = read.right;
          const unknown = (request.cases ?? []).filter(
            (id) => !file.cases.some((testCase) => testCase.id === id),
          );
          if (unknown.length > 0)
            return JSON.stringify({
              kind: "host_live_tests",
              status: "unknown_cases",
              cases: unknown,
              instruction: `Name only case ids ${liveTestCasesPath} lists, or pass cases null to run them all. Nothing was executed.`,
            });
          const selected =
            request.cases === null
              ? file.cases
              : file.cases.filter((testCase) => request.cases?.includes(testCase.id));
          if (selected.length === 0 || selected.length > maximumBatchCases)
            return JSON.stringify({
              kind: "host_live_tests",
              status: "batch_size",
              instruction:
                selected.length === 0
                  ? `${liveTestCasesPath} has no cases to run. Design them there first, as the testing skill says. Nothing was executed.`
                  : `A batch runs at most ${maximumBatchCases} cases; name the ones to run in cases. Nothing was executed.`,
            });
          // Fixed for the batch: a sign-in cannot start while it holds the execution permit.
          const signedInBatch = signedIn();
          const overLimit = signedInBatch
            ? signedInTestInputRefusal(
                signedInTestInputs,
                selected.map((testCase) => testCase.input),
              )
            : undefined;
          if (overLimit !== undefined)
            return JSON.stringify({
              kind: "host_live_tests",
              status: "limit",
              limit: signedInTestInputLimit,
              inputsRun: signedInTestInputs.length,
              instruction: overLimit,
            });
          const shape = yield* liveTestShape(request.entrypoint);
          const cursor = "cursor" in shape ? shape.cursor : undefined;
          if (selected.some((testCase) => testCase.next_page === true) && cursor === undefined)
            return JSON.stringify({
              kind: "host_live_tests",
              status: "no_cursor",
              instruction:
                "A next_page case needs the list fields in the tool's schemas: the string input cursor and output next_cursor, which listInputFields and listOutputFields from opengpt-browser-engine/runtime give. Add them, or drop next_page. Nothing was executed.",
            });
          const digest = yield* stepDigest(request.entrypoint);
          if (digest === undefined)
            return JSON.stringify({
              kind: "host_live_tests",
              status: "source_unreadable",
              instruction: `The host could not read ${request.entrypoint} and its imports. Nothing was executed.`,
            });
          const { deadlineAt, attemptBound } = yield* liveTestDeadline;
          // A batch with less time left than one case may take could only end every case
          // inconclusive, so it runs nothing. A host's reserve past its batch cap still runs the
          // cases a failure is pending on, so the review sees them on the source it judges.
          if (!(yield* liveTestBatchFits(host, deadlineAt))) {
            // No regular batch fits from here on, whether or not the reserve runs this one.
            liveTestsOutOfTime = true;
            const reserved = yield* reservedBatchCases(
              host,
              deadlineAt,
              file,
              request.entrypoint,
              digest,
            );
            if (!selected.every((testCase) => reserved.includes(testCase.id))) {
              // With time left past the batch's ten minutes, the host's own batch cap stopped it.
              const stopped = attemptBound
                ? "Too little of this attempt is left to run a batch"
                : "This attempt has run every live test batch its host allows";
              // A reserve the host still keeps can re-test a failure once the code changes, so only
              // a closed one makes a denial that rests on a failure the end of the build.
              const reserveOpen =
                reserved.length > 0 || (yield* liveTestReserveOpen(host, deadlineAt));
              const failedHere =
                reserveOpen && reserved.length === 0
                  ? failedOnSourceCases(file, request.entrypoint, digest)
                  : [];
              const publishNext =
                "run the example last and publish, and say in coverage which cases did not run; the host's record says time ran out.";
              return JSON.stringify({
                kind: "host_live_tests",
                status: "no_time",
                ...(reserved.length === 0 ? {} : { reservedFor: reserved }),
                instruction:
                  reserved.length > 0
                    ? `${stopped}, except one reserved batch for only the cases a failure is still pending on: ${reserved.join(", ")}. Prefer to make your last edit, then run those cases together in that one batch, and no other case, named in cases, so publication review reads their results on the source you publish. Then ${publishNext} Nothing was executed.`
                    : reserveOpen
                      ? `${stopped}, except one reserved batch for the cases a failure is pending on.${failedHere.length === 0 ? "" : ` A case that failed on this source joins it once you change the code: ${failedHere.join(", ")}. Prefer to fix the code where it fails, then run those cases together in that one batch.`} Otherwise, ${publishNext} Nothing was executed.`
                      : `${stopped}. Run the example last and publish, and say in coverage which cases did not run; the host's record says time ran out. If publication review then denies for a failure only a new batch could clear, prefer report_blocked with reason host_refused, naming the refused live tests and the finding. Nothing was executed.`,
              });
            }
          }
          // A signed-in read's cases run on the build's own signed-in browser, one at a time.
          const workers = signedInBatch
            ? 1
            : Math.max(1, Math.min(request.maxWorkers ?? host.maxWorkers, host.maxWorkers));
          const result = yield* host.run({
            ...(signedInBatch ? { signedIn: true as const } : {}),
            entrypoint: request.entrypoint,
            sourceDigest: digest,
            cases: selected.map((testCase) => ({
              id: testCase.id,
              input: testCase.input,
              ...(testCase.next_page === true && cursor !== undefined ? { nextPage: cursor } : {}),
            })),
            workers,
            deadlineAt,
          }).pipe(
            // The host's gate refused the batch, such as a cap on live runs.
            Effect.tapError((error) =>
              error.recoveryGate === undefined
                ? Effect.void
                : recordHostRefusal("live_tests", error.code, error.recoveryGate.reason),
            ),
          );
          if (result.status === "review_denied") {
            const rationale = yield* screenRationale(result.rationale);
            yield* recordDenial({
              review: "live_tests",
              ...(result.reviewId === undefined ? {} : { reviewId: result.reviewId }),
              rationale,
            });
            return JSON.stringify({
              kind: "host_live_tests",
              status: "review_denied",
              ...(result.reviewId === undefined ? {} : { reviewId: result.reviewId }),
              rationale,
              instruction:
                "Guardian denied this batch, so nothing ran. Fix what the rationale names (often an input that names or guesses a private value, or a case that would change the site), then run again.",
            });
          }
          if (signedInBatch)
            signedInTestInputs.push(
              ...uncountedTestInputs(
                signedInTestInputs,
                selected.map((testCase) => testCase.input),
              ),
            );
          // The source the batch ran: a change while it ran leaves its results stale.
          const after = yield* stepDigest(request.entrypoint);
          const sourceDigest = after === digest ? digest : "changed_while_running";
          const verdicts: Record<string, number> = {};
          const judgedRuns = result.cases.flatMap((run) => {
            const testCase = selected.find((entry) => entry.id === run.id);
            if (testCase === undefined) return [];
            const judged = judgeCase(testCase, run, "list" in shape ? shape.list : undefined);
            const previous = recordsFor(request.entrypoint).get(run.id);
            // An inconclusive rerun, such as a challenge or a site block, tested nothing about
            // the tool, so a failure it follows on the same source and case keeps counting, with
            // the output it returned.
            const keepsFailure =
              judged.verdict === "inconclusive" &&
              previous?.verdict === "fail" &&
              previous.caseDigest === caseDigest(testCase) &&
              previous.sourceDigest === sourceDigest;
            return [{ run, testCase, judged, keepsFailure }];
          });
          // Every case's fields first, so each case's output check counts the whole batch.
          for (const { run, judged } of judgedRuns.filter((entry) => !entry.keepsFailure))
            if (judged.output === undefined)
              liveTestFills.delete(outputKey(request.entrypoint, run.id));
            else
              liveTestFills.set(outputKey(request.entrypoint, run.id), {
                sourceDigest,
                fill: fieldFill(judged.output),
              });
          for (const { run, testCase, judged, keepsFailure } of judgedRuns) {
            verdicts[judged.verdict] = (verdicts[judged.verdict] ?? 0) + 1;
            if (attemptBound && judged.verdict === "inconclusive" && judged.got === "deadline")
              liveTestsOutOfTime = true;
            if (keepsFailure) continue;
            const screened =
              judged.output === undefined
                ? undefined
                : yield* dependencies.projection
                    .json(judged.output)
                    .pipe(Effect.orElseSucceed(() => "[output withheld: screening failed]"));
            const outputAt = outputKey(request.entrypoint, run.id);
            if (screened === undefined) liveTestOutputs.delete(outputAt);
            else liveTestOutputs.set(outputAt, screened);
            const message =
              judged.message === undefined
                ? undefined
                : yield* screenMintText(dependencies, judged.message).pipe(
                    Effect.orElseSucceed(() => "[message withheld]"),
                  );
            const excerpt = outputExcerpt(screened);
            // The same output check an example gets, on the output the verdict judged; a sample
            // is a value from it, so it is screened like the output.
            const findings =
              judged.output === undefined
                ? []
                : lintOutput(judged.output, {
                    ...("outputSchema" in shape ? { outputSchema: shape.outputSchema } : {}),
                    alsoTested: fillsOnSource(request.entrypoint, sourceDigest, outputAt),
                    samples: true,
                  });
            const outputChecks =
              findings.length === 0
                ? undefined
                : yield* dependencies.projection.json(findings).pipe(
                    Effect.flatMap((value) =>
                      Schema.decodeUnknown(LiveTestOutputChecks)(value),
                    ),
                    Effect.orElseSucceed(() =>
                      findings.map(({ sample: _sample, ...finding }) => finding),
                    ),
                  );
            const digestOfCase = caseDigest(testCase);
            const records = recordsFor(request.entrypoint);
            const version = liveTestVersion(request.entrypoint);
            const previous = records.get(run.id);
            // A failure the run replaces stays in the record: the case changed after it, or it
            // passed when run again on the same source and case, which shows it is flaky.
            const flaky =
              previous?.caseDigest === digestOfCase &&
              previous.sourceDigest === sourceDigest &&
              judged.verdict === "pass";
            if (
              previous !== undefined &&
              previous.verdict === "fail" &&
              (previous.caseDigest !== digestOfCase || flaky) &&
              !liveTestReplaced.some(
                (entry) =>
                  liveTestVersion(entry.entrypoint) === version &&
                  entry.id === previous.id &&
                  entry.caseDigest === previous.caseDigest &&
                  entry.sourceDigest === previous.sourceDigest,
              )
            ) {
              liveTestReplaced.push({ ...previous, retired: true, ...(flaky ? { flaky: true } : {}) });
              const ofVersion = liveTestReplaced.filter(
                (entry) => liveTestVersion(entry.entrypoint) === version,
              );
              for (const dropped of ofVersion.slice(0, Math.max(0, ofVersion.length - maximumBatchCases)))
                liveTestReplaced.splice(liveTestReplaced.indexOf(dropped), 1);
            }
            records.set(run.id, {
              id: run.id,
              entrypoint: request.entrypoint,
              caseDigest: digestOfCase,
              sourceDigest,
              verdict: judged.verdict,
              got: judged.got,
              ...(judged.detail === undefined ? {} : { detail: judged.detail }),
              ...(judged.errorClass === undefined ? {} : { errorClass: judged.errorClass }),
              ...(message === undefined ? {} : { message }),
              ...(judged.frame === undefined ? {} : { frame: judged.frame }),
              ...(judged.refusal === undefined ? {} : { refusal: judged.refusal }),
              ...(excerpt === undefined ? {} : { excerpt }),
              ...(outputChecks === undefined ? {} : { outputChecks }),
              durationMs: Math.max(0, Math.round(run.durationMs)),
              ...(run.lane === undefined ? {} : { lane: run.lane }),
              ...(run.start === undefined ? {} : { start: run.start }),
              input: testCase.input,
              purpose: testCase.purpose,
              expect: testCase.expect,
              ...(testCase.next_page === true ? { nextPage: true } : {}),
              ...(testCase.noMatch === true ? { noMatch: true } : {}),
              ...(signedInBatch ? { signedIn: true as const } : {}),
            });
          }
          batchesJudged += 1;
          recordBatch({
            batchId: result.reviewId ?? `live-tests-${batchesJudged}`,
            entrypoint: request.entrypoint,
            sourceDigest,
            cases: judgedRuns.map(({ run, judged }) => ({
              id: run.id,
              verdict: judged.verdict,
              ...(run.start === undefined ? {} : { start: run.start }),
            })),
          });
          yield* reportBestEffort(
            dependencies.diagnostics?.emit("mint.live_tests", {
              cases: selected.length,
              lanes: result.lanes,
              challengeStops: result.challengeStops ?? 0,
              ...verdicts,
            }) ?? Effect.void,
            {
              component: "mint",
              operation: "diagnostics.emit",
              phase: "mint.live_tests",
              correlation: dependencies.reportCorrelation ?? "process",
            },
          );
          return JSON.stringify({
            status: "ran",
            ...(result.reviewId === undefined ? {} : { reviewId: result.reviewId }),
            lanes: result.lanes,
            ...(sourceDigest === digest
              ? {}
              : {
                  notice:
                    "The source changed while the batch ran, so these results describe other code. Run the cases again.",
                }),
            ...("problem" in shape ? { schemaProblem: shape.problem } : {}),
            ...(yield* liveTestPlanView(request.entrypoint, {
              ran: selected.map((testCase) => testCase.id),
            })),
          });
        });
      /**
       * The publication review's record of a read's live tests, and its coverage line. It lists
       * only the versions that ship: the published entrypoint's, and the HTTP version beside a
       * published Playwright version while its file exists, unless finish_build ruled it out
       * (`httpRuledOut`). A version that does not ship is neither recorded nor judged. A
       * signed-in read's record holds only results run signed in, and it has none until one ran.
       */
      const liveTestsForPublication = (entrypoint: string, httpRuledOut: boolean) =>
        Effect.gen(function* () {
          if (dependencies.liveTests === undefined || buildEffect !== "read") return undefined;
          const signedInRead = signedIn();
          const counted = (record: LiveTestRecord) => !signedInRead || record.signedIn === true;
          if (
            signedInRead &&
            ![
              ...liveTestRecords.playwright.values(),
              ...liveTestRecords.http.values(),
              ...liveTestReplaced,
            ].some(counted)
          )
            return undefined;
          const recordsOf = (version: LiveTestVersion) =>
            new Map([...liveTestRecords[version]].filter(([, record]) => counted(record)));
          const read = yield* readCasesFile;
          const published = liveTestVersion(entrypoint);
          // The input schema each version publishes, which marks a retired input it rejects.
          const inputSchemaOf = (path: string) =>
            Effect.map(liveTestShape(path), (shape) =>
              "inputSchema" in shape ? { inputSchema: shape.inputSchema } : {},
            );
          const replacedOf = (version: LiveTestVersion) =>
            liveTestReplaced.filter(
              (record) => liveTestVersion(record.entrypoint) === version && counted(record),
            );
          const versions: LiveTestVersionResults[] = [
            {
              version: published,
              entrypoint,
              sourceDigest: yield* stepDigest(entrypoint),
              records: recordsOf(published),
              replaced: replacedOf(published),
              ...(yield* inputSchemaOf(entrypoint)),
            },
          ];
          if (published === "playwright" && !httpRuledOut) {
            // The conventional file while the workspace has it: a deleted HTTP version does not
            // ship, and a scratch `*-http.mjs` the latest results ran is not the version that
            // ships. A host that cannot tell keeps the file the latest results ran.
            const ran = [...replacedOf("http"), ...recordsOf("http").values()]
              .map((record) => record.entrypoint)
              .filter((path) => path !== undefined)
              .at(-1);
            const shipping = yield* Effect.promise(async () => {
              try {
                return await session.pathExists?.(httpVersionPath);
              } catch {
                return undefined;
              }
            });
            const httpEntrypoint =
              shipping === true ? httpVersionPath : shipping === undefined ? ran : undefined;
            if (httpEntrypoint !== undefined)
              versions.push({
                version: "http",
                entrypoint: httpEntrypoint,
                sourceDigest: yield* stepDigest(httpEntrypoint),
                records: recordsOf("http"),
                replaced: replacedOf("http"),
                ...(yield* inputSchemaOf(httpEntrypoint)),
              });
          }
          return liveTestsEvidence({
            file: Either.isRight(read) ? read.right : emptyCases,
            ...(Either.isLeft(read) ? { fileProblem: read.left } : {}),
            versions,
            outOfTime: liveTestsOutOfTime,
            ...(signedInRead ? { signedIn: true } : {}),
          });
        }).pipe(
          // A record the host could not build says so, rather than vanishing from the review.
          Effect.catchAllCause((cause) =>
            Cause.isInterruptedOnly(cause)
              ? Effect.failCause(cause)
              : Effect.succeed(
                  liveTestsEvidenceProblem(
                    "an error stopped it; judge coverage from the example and the minter's account",
                  ),
                ),
          ),
        );
      /** Captures retained in this attempt, as evidence a later submission may rest on. */
      let capturesRetained = 0;
      /**
       * What the last publication Guardian denied rested on: the request, the digests of the
       * entrypoint's and the HTTP version's import closures and of each flagged file, and the
       * evidence the host holds. The same again is refused before a second review. Kept in memory
       * only, so a takeover drops it.
       */
      let deniedSubmission:
        | {
            readonly paths: readonly string[];
            readonly key: string;
            readonly liveTests: readonly LiveTestRecord[];
          }
        | undefined;
      const currentLiveTests = () => [
        ...liveTestRecords.playwright.values(),
        ...liveTestRecords.http.values(),
        ...liveTestReplaced,
      ];
      /**
       * Live tests the host refuses while Guardian's denial of the latest publication stands, for
       * a `host_refused` report: the attempt ran out of live tests (`liveTestsOutOfTime`), no
       * batch fits now, and the latest publication review was a denial. Whether the host's reserve
       * is still open decides it alone; the cases file is read only to name the cases the reserve
       * would run now and those it takes once the code changes, on any version this attempt
       * tested, so a file that cannot be read never makes the tests spent. Undefined while a batch
       * fits, with no denial standing, or before the attempt ran out.
       */
      const liveTestsRefusedForDenial: Effect.Effect<LiveTestsRefusal | undefined> = Effect.gen(
        function* () {
          const host = dependencies.liveTests;
          if (host === undefined || !liveTestsOutOfTime || publicationDenial === undefined)
            return undefined;
          const { deadlineAt } = yield* liveTestDeadline;
          if (yield* liveTestBatchFits(host, deadlineAt)) return undefined;
          if (!(yield* liveTestReserveOpen(host, deadlineAt)))
            return { reserveOpen: false, reservedFor: [], failedOnSource: [] };
          const read = yield* readCasesFile;
          const entrypoints = new Set(
            currentLiveTests().flatMap((record) =>
              record.entrypoint === undefined ? [] : [record.entrypoint],
            ),
          );
          const named = Either.isLeft(read)
            ? []
            : yield* Effect.forEach(entrypoints, (entrypoint) =>
                stepDigest(entrypoint).pipe(
                  Effect.flatMap((digest) =>
                    digest === undefined
                      ? Effect.succeed({ now: [], afterEdit: [] })
                      : Effect.map(
                          reservedBatchCases(host, deadlineAt, read.right, entrypoint, digest),
                          (now) => ({
                            now,
                            afterEdit: failedOnSourceCases(read.right, entrypoint, digest),
                          }),
                        ),
                  ),
                ),
              );
          const reservedFor = [...new Set(named.flatMap(({ now }) => now))];
          return {
            reserveOpen: true,
            reservedFor,
            failedOnSource: [
              ...new Set(named.flatMap(({ afterEdit }) => afterEdit)),
            ].filter((id) => !reservedFor.includes(id)),
          };
        },
      );
      const submissionKey = (proposed: PublicationRequest, paths: readonly string[]) =>
        Effect.forEach(paths, stepDigest).pipe(
          Effect.map((digests) =>
            JSON.stringify({
              proposed,
              digests,
              executions: executions.length,
              revision: taskState.revision,
              answers: answeredQuestions.size,
              captures: capturesRetained,
            }),
          ),
        );
      /** A submission as `deniedSubmission` keeps it, for telling the same one again. */
      const submissionSnapshot = (proposed: PublicationRequest, paths: readonly string[]) =>
        Effect.map(submissionKey(proposed, paths), (key) => ({
          paths,
          key,
          liveTests: currentLiveTests(),
        }));
      /** Whether `proposed` is `kept` again, with nothing it rests on changed since. */
      const sameSubmission = (
        kept: NonNullable<typeof deniedSubmission>,
        proposed: PublicationRequest,
      ) =>
        Effect.gen(function* () {
          const liveTests = currentLiveTests();
          return (
            liveTests.length === kept.liveTests.length &&
            liveTests.every((record, index) => record === kept.liveTests[index]) &&
            (yield* submissionKey(proposed, kept.paths)) === kept.key
          );
        });
      const unchangedSinceDenial = (proposed: PublicationRequest) =>
        deniedSubmission === undefined
          ? Effect.succeed(false)
          : sameSubmission(deniedSubmission, proposed);
      /**
       * The latest submissions the host's own publication checks refused, up to
       * `rememberedRefusedSubmissions`. Kept in memory only, as `deniedSubmission` is.
       */
      let hostRefusedSubmissions: NonNullable<typeof deniedSubmission>[] = [];
      const actions: MintActions = {
        retainCapture: (input) =>
          serial.withPermits(1)(
            Effect.gen(function* () {
              if (questionOnly) return yield* new MintFailure({ code: "ScopeDenied" });
              yield* active();
              const submitted = yield* decode(CaptureRequest, input);
              if ((submitted.kind === "full") !== (submitted.requestId === null))
                return yield* new MintFailure({ code: "InvalidRequest" });
              if (!dependencies.retainCapture)
                return yield* new MintFailure({ code: "CaptureUnavailable" });
              const retained = yield* dependencies.retainCapture(submitted);
              capturesRetained++;
              return retained;
            }),
          ),
        readSource: (path, range) =>
          questionOnly
            ? Effect.fail(new MintFailure({ code: "ScopeDenied" }))
            : Effect.tryPromise({
                try: async () => {
                  const relative = relativeSourcePath(path);
                  const offset = range?.offset ?? 0;
                  const limit =
                    range?.limit ?? (relative.startsWith("captures/") ? 24_000 : undefined);
                  if (
                    !Number.isSafeInteger(offset) ||
                    offset < 0 ||
                    (limit !== undefined &&
                      (!Number.isSafeInteger(limit) || limit < 1 || limit > 64_000))
                  )
                    throw new MintFailure({ code: "InvalidRequest" });
                  // This attempt's own capture the workspace does not hold is not saved yet, not
                  // refused. Another attempt's retained capture keeps its read's own result.
                  const own = dependencies.reportCorrelation;
                  if (
                    own !== undefined &&
                    relative.startsWith(`captures/${own.jobId}/attempts/${own.attemptId}/`) &&
                    !(await session.pathExists?.(relative))
                  )
                    throw new MintFailure({
                      code: "CaptureUnavailable",
                      reason: "capture_not_saved",
                    });
                  // Screen the complete source before slicing so partial secrets cannot evade screening.
                  let result: unknown;
                  try {
                    result = await session.readFile?.({ path: relative });
                  } catch (error) {
                    // The index and route summary arrive with the first published capture. Only a
                    // failed read counts, so a maintenance mint's retained index still reads.
                    if (
                      (relative === "captures/index.json" || relative === "captures/routes.json") &&
                      !(await session.pathExists?.("captures/index.json"))
                    )
                      throw new MintFailure({
                        code: "CaptureUnavailable",
                        reason: "capture_not_saved",
                      });
                    throw error;
                  }
                  if (typeof result !== "string") throw new MintFailure({ code: "Unavailable" });
                  if (offset > result.length) throw new MintFailure({ code: "InvalidRequest" });
                  const end =
                    limit === undefined ? result.length : Math.min(result.length, offset + limit);
                  return JSON.stringify({
                    kind: "untrusted_source",
                    path: relative,
                    source: result.slice(offset, end),
                    offset,
                    total: result.length,
                    offsetUnit: "UTF-16 code units",
                    nextOffset: end < result.length ? end : null,
                  });
                },
                catch: (error) =>
                  error instanceof MintFailure && error.reason === "capture_not_saved"
                    ? error
                    : new MintFailure({
                        failureDetail: failureDetail("mint_host_dependency_failed", {
                          operation: "session.readFile",
                          error,
                          context: { path, offset: range?.offset, limit: range?.limit },
                        }),
                        code: "ScopeDenied",
                      }),
              }),
        execute: (input, agentNote) =>
          serial.withPermits(1)(
            Effect.gen(function* () {
              if (questionOnly) return yield* new MintFailure({ code: "ScopeDenied" });
              // Once sign-in is unavailable, another authenticate gets the same answer; once the
              // owner declined to sign in, it gets theirs.
              const authenticating = isAuthenticate(input);
              if (signInUnavailable !== undefined && authenticating)
                return signInUnavailable.answer;
              if (loginDeclined !== undefined && authenticating)
                return loginDeclinedAnswer(loginDeclined);
              if (signInAbandoned && authenticating)
                return JSON.stringify({
                  status: "sign_in_abandoned",
                  userInputRequired: false,
                  instruction: signInAbandonedInstruction(buildEffect),
                });
              yield* active();
              const submitted = yield* decode(ExecutionRequest, input);
              sentSignInStep =
                submitted.purpose === "authenticate" && submitted.signInStep !== undefined
                  ? JSON.stringify(submitted.signInStep)
                  : undefined;
              yield* Effect.try({
                try: () => relativeSourcePath(submitted.entrypoint),
                catch: (error) =>
                  new MintFailure({
                    failureDetail: failureDetail("mint_host_dependency_failed", {
                      operation: "relativeSourcePath",
                      error,
                      context: {
                        entrypoint: submitted.entrypoint,
                        purpose: submitted.purpose,
                        target: submitted.target,
                      },
                    }),
                    code: "ScopeDenied",
                  }),
              });
              if (submitted.target === "liveBrowser" && submitted.maxWorkers !== 1)
                return yield* new MintFailure({ code: "InvalidRequest" });
              if (submitted.purpose === "example" && exampleClaimed && !repeatableRead)
                return yield* new MintFailure({ code: "AlreadyExecuted" });
              if (
                submitted.purpose === "act" &&
                (writeSession === "closed" || (writeSession === "none" && exampleClaimed))
              )
                return yield* new MintFailure({ code: "AlreadyExecuted" });
              const repeated = yield* repeatedWriteRefusal(submitted);
              const preflighted =
                repeated === undefined
                  ? yield* dependencies
                      .preflight(submitted)
                      .pipe(
                        Effect.tapError((error) =>
                          diagnoseExecution(submitted, { code: error.code }),
                        ),
                      )
                  : { supported: false as const, reason: repeated };
              // A signed-in read's live test on an input it chose counts toward its bound, shared
              // with live_tests; one the host already refused never reaches it.
              const signedInTestInput =
                preflighted.supported &&
                submitted.testInput !== undefined &&
                submitted.purpose === "test" &&
                submitted.target === "liveBrowser" &&
                buildEffect === "read" &&
                signedInTestsSupported &&
                signedIn()
                  ? Option.getOrUndefined(
                      Schema.decodeUnknownOption(Schema.parseJson())(submitted.testInput),
                    )
                  : undefined;
              const overLimit =
                signedInTestInput === undefined
                  ? undefined
                  : signedInTestInputRefusal(signedInTestInputs, [signedInTestInput]);
              const availability =
                overLimit === undefined
                  ? preflighted
                  : { supported: false as const, reason: overLimit };
              // A refused preflight records no host refusal: it refuses the minter's own request,
              // such as a wrong target or a missing sign-in step, which the minter can fix.
              if (!availability.supported) {
                const evidence: ExecutionEvidence = {
                  executionId: randomUUID(),
                  status: "unsupported",
                  effect: "not_sent",
                  ...(submitted.purpose === "example"
                    ? { preflight: "rejected_before_claim" as const }
                    : {}),
                  observations: availability.reason,
                };
                yield* diagnoseExecution(submitted, {
                  status: evidence.status,
                  reason: availability.reason,
                });
                record(evidence, submitted.purpose);
                return yield* visible(evidence, submitted.purpose);
              }
              if (submitted.purpose === "residual") yield* dependencies.authorizeResidual;
              if (submitted.purpose === "authenticate") {
                unresolvedSignIn = undefined;
                priorHostRefusals = hostRefusals;
                hostRefusals = undefined;
                priorSignInDenials = signInDenials;
                signInDenials = undefined;
              }
              const effectful =
                submitted.purpose === "example" ||
                submitted.purpose === "act" ||
                submitted.purpose === "residual";
              let crossedDispatchBoundary = false;
              /** The allow the host's dispatch fence followed, with Guardian's action label. */
              let allowed: AllowedExecution | undefined;
              const evidence = yield* reviewedExecution(
                agentNote === undefined ? submitted : { ...submitted, agentNote },
                (fenced) =>
                  Effect.sync(() => {
                    crossedDispatchBoundary = true;
                    allowed = fenced;
                    // Guardian allowed it and it is going out: the input counts from now on.
                    if (signedInTestInput !== undefined)
                      signedInTestInputs.push(
                        ...uncountedTestInputs(signedInTestInputs, [signedInTestInput]),
                      );
                  }),
              ).pipe(
                Effect.onExit((result) =>
                  Effect.suspend(() => {
                    // An act step Guardian allowed starts the run of refusals again; one it
                    // refused adds to it.
                    if (submitted.purpose === "act") {
                      if (crossedDispatchBoundary) actRefusalsInRow = 0;
                      else if (
                        Exit.isFailure(result) &&
                        Cause.isFailType(result.cause) &&
                        result.cause.error.code === "ReviewDenied"
                      )
                        actRefusalsInRow++;
                    }
                    if (submitted.purpose === "authenticate") {
                      noteSignIn(result, crossedDispatchBoundary);
                      // A screen the host refused at its destination check comes back as the
                      // step's result, so the host's own record is the basis, read as it stands
                      // after this sign-in step.
                      if (dependencies.signInDestinationRefused !== undefined)
                        signInDestinationRefused = dependencies.signInDestinationRefused();
                    }
                    if (
                      (!effectful && submitted.purpose !== "authenticate") ||
                      Exit.isSuccess(result)
                    )
                      return Effect.void;
                    // The owner declined the login before anything was sent: no sign-in ran.
                    if (
                      Cause.isFailType(result.cause) &&
                      result.cause.error.loginDeclined !== undefined
                    )
                      return Effect.void;
                    // A defect or interruption can occur after dispatch just like a typed failure.
                    const reviewPreventedExecution =
                      Cause.isFailType(result.cause) &&
                      (result.cause.error.code === "ReviewDenied" ||
                        (result.cause.error.code === "ReviewUnavailable" &&
                          result.cause.error.reviewDispatch === "not_sent"));
                    // The host stopped after the dispatch fence but before anything reached the
                    // site, such as a sandbox copy of the source that did not match the review:
                    // no write went out, so none is tracked, fenced or reconciled.
                    const hostNotSent =
                      Cause.isFailType(result.cause) &&
                      result.cause.error.execution?.dispatch === "not_sent";
                    const ran = crossedDispatchBoundary && !hostNotSent;
                    const lost: ExecutionEvidence = {
                      executionId: `unresolved_${randomUUID()}`,
                      status: "failed",
                      effect:
                        submitted.purpose === "example" || submitted.purpose === "act"
                          ? ran
                            ? "possible"
                            : "not_sent"
                          : reviewPreventedExecution ||
                              hostNotSent ||
                              submitted.purpose === "authenticate"
                            ? "not_sent"
                            : "possible",
                      ...(submitted.purpose === "authenticate" && !reviewPreventedExecution
                        ? {
                            authentication: {
                              state: "failed" as const,
                              // Possible only while the sign-in's outcome is unknown.
                              effect:
                                Cause.isFailType(result.cause) &&
                                (result.cause.error.code === "CredentialsRejected" ||
                                  (result.cause.error.authentication !== undefined &&
                                    signInFailureFeedback(result.cause.error.authentication)
                                      .signInOutcome === "signed_out"))
                                  ? ("verified" as const)
                                  : ("possible" as const),
                            },
                          }
                        : {}),
                      observations:
                        "Execution did not produce a result. Reconcile using the host's durable execution journal.",
                    };
                    record(lost, submitted.purpose);
                    // Only an execution that crossed its dispatch fence and was sent ran; a write
                    // whose result was lost is exactly what the outcome reviewer settles.
                    return ran
                      ? observeExecution(submitted, lost, allowed, "result_lost")
                      : Effect.void;
                  }),
                ),
              );
              yield* observeExecution(submitted, evidence, allowed, evidence.status);
              if (evidence.status === "unsupported")
                yield* recordHostRefusal("execute", evidence.status, evidence.observations);
              const result = yield* executionResult(evidence, submitted.purpose);
              // The first passing example settles the schemas: its receipt reminds the agent to
              // design and run its cases.
              if (
                submitted.purpose !== "example" ||
                evidence.status !== "completed" ||
                testPlanSent ||
                !liveTestsOffered()
              )
                return result;
              testPlanSent = true;
              const read = yield* readCasesFile;
              const planned = Either.isRight(read) ? read.right.cases.length : 0;
              const parsed = yield* Effect.option(
                Effect.try(() => JSON.parse(result) as Readonly<Record<string, unknown>>),
              );
              return Option.isNone(parsed)
                ? result
                : JSON.stringify({
                    ...parsed.value,
                    testPlan: {
                      plannedCases: planned,
                      instruction: signedIn()
                        ? `Your example passed, so the tool's schemas are settled. ${signedInPlanInstruction} Fix the code until it passes, then make your last edit, run it again and run the example last.`
                        : `Your example passed, so the tool's schemas are settled. Design the cases in ${liveTestCasesPath} as the testing skill says, from what you saw on the site: one case that combines the inputs the example left unset, each set to a value at least one example row fails while some rows still pass, the example's input once more, a query with no results, the next page, and another case only where a different page layout or a real variant needs it. Run them with live_tests action run and fix every failing case, fixing everything a batch reveals before you run again. Then make your last edit, run every case again and run the example last.`,
                    },
                  });
            }).pipe(
              // The owner never answered a sign-in request: the build ends as no_response.
              Effect.catchIf(
                (error) => error.noResponse !== undefined && !stopUnavailableHost(),
                (error) => unanswered(error, "signing in to the website", { step: "sign_in" }),
              ),
              // The owner declined the login the sign-in asked for: their answer, not a failed
              // sign-in, so the minter builds without signing in and nothing is left unresolved.
              Effect.catchIf(
                (error) => error.loginDeclined !== undefined,
                (error) =>
                  Effect.gen(function* () {
                    const decline = error.loginDeclined ?? "public_only";
                    loginDeclined = decline;
                    unresolvedSignIn = undefined;
                    yield* diagnose({
                      phase: "sign_in",
                      reason: "login_declined",
                      declined: decline,
                    });
                    return loginDeclinedAnswer(decline);
                  }),
              ),
              // The host already asked for a correction in place, and the site refused it too.
              Effect.catchIf(
                (error) => error.code === "CredentialsRejected",
                (error) => {
                  terminal ??= {
                    build: "incomplete",
                    rejectedCredential: error.rejectedCredential ?? "password",
                    summary:
                      "The website rejected a sign-in value and the bounded correction flow ended. No build was published. Recorded effects and receipts are preserved.",
                  };
                  return Effect.succeed(
                    JSON.stringify({
                      status: "credentials_rejected",
                      field: error.rejectedCredential ?? "password",
                      userInputRequired: false,
                      instruction:
                        "The website rejected the login again after the host asked for a correction. The host is ending this build; never ask for credentials yourself.",
                    }),
                  );
                },
              ),
              executionFailureFeedback(
                (error) =>
                  screenedRunnerFailure(error) !== undefined ||
                  screenedCaptureGap(error) !== undefined ||
                  error.execution !== undefined ||
                  error.authentication !== undefined ||
                  error.spentSignIn !== undefined ||
                  error.sessionLoss !== undefined ||
                  error.reason === "login_in_use",
                isAuthenticate(input),
              ),
            ),
          ),
        finish: (input) =>
          serial.withPermits(1)(
            Effect.gen(function* () {
              if (questionOnly) return yield* new MintFailure({ code: "ScopeDenied" });
              yield* active("publication");
              hostRefusalRepeated = false;
              const write = buildEffect === "write";
              const proposed = yield* decode(PublicationRequest, input).pipe(
                Effect.tapError(() =>
                  Effect.sync(() => {
                    pendingDecision = hostRefusalDecision(
                      "request_invalid",
                      undefined,
                      write,
                      "InvalidRequest",
                    );
                  }),
                ),
              );
              if (proposed.httpVersion !== undefined && buildEffect === "write") {
                const reason = "http_version_on_write";
                pendingDecision = hostRefusalDecision(reason, undefined, true);
                yield* diagnose({ phase: "publication", code: "PublicationUnavailable", reason });
                return JSON.stringify({
                  status: "not_published",
                  code: "PublicationUnavailable",
                  reason,
                  userInputRequired: false,
                  instruction:
                    "httpVersion is only for a read published without an HTTP version. A write's HTTP version is tested offline against its session's recorded exchanges. Call finish_build again without httpVersion.",
                  executionContext: yield* executionContext(),
                });
              }
              yield* Effect.try({
                try: () => relativeSourcePath(proposed.entrypoint),
                catch: (error) =>
                  new MintFailure({
                    failureDetail: failureDetail("mint_host_dependency_failed", {
                      operation: "relativeSourcePath",
                      error,
                      context: {
                        entrypoint: proposed.entrypoint,
                        executionId: proposed.executionId,
                      },
                    }),
                    code: "ScopeDenied",
                  }),
              }).pipe(
                Effect.tapError(() =>
                  Effect.sync(() => {
                    pendingDecision = hostRefusalDecision(
                      "entrypoint_out_of_scope",
                      undefined,
                      write,
                      "ScopeDenied",
                    );
                  }),
                ),
              );
              const evidence = executions.find(
                (entry) => entry.executionId === proposed.executionId,
              );
              // A build that moved to another site publishes only what ran on that site, and a
              // build that became a write only what its write session did.
              const ranAt = evidence === undefined ? 0 : (revisions.get(evidence.executionId) ?? 0);
              const stale =
                evidence === undefined
                  ? undefined
                  : ranAt < latestRevisionChanging("site")
                    ? ({
                        reason: "example_before_site_change",
                        instruction:
                          "This execution ran before the build moved to its current site, so it proves nothing there. Run a fresh reviewed example on the current site, then call finish_build with that new executionId.",
                      } as const)
                    : ranAt < latestRevisionChanging("effect")
                      ? ({
                          reason: "example_before_effect_change",
                          instruction:
                            "This execution ran while the build was a read, so it is not the write the task now asks for. Perform the write through purpose act steps, then call finish_build with the step that confirmed it.",
                        } as const)
                      : undefined;
              if (stale !== undefined) {
                pendingDecision = hostRefusalDecision(stale.reason, evidence?.executionId, write);
                yield* diagnose({
                  phase: "publication",
                  code: "PublicationUnavailable",
                  reason: stale.reason,
                });
                return JSON.stringify({
                  status: "not_published",
                  code: "PublicationUnavailable",
                  reason: stale.reason,
                  userInputRequired: false,
                  instruction: stale.instruction,
                  executionContext: yield* executionContext(),
                });
              }
              const repair = dependencies.canPublishRepair?.(proposed.executionId) === true;
              const actStep =
                evidence !== undefined && purposes.get(evidence.executionId) === "act";
              // A step whose confirmation the host withheld with its result confirms nothing: a
              // later step that only reads the confirmation back publishes the session, and this
              // one does only when no read-back is possible.
              const withheld = actStep && evidence.withheldConfirmation !== undefined;
              if (withheld && (writeSession === "closed" || !proposed.readBackUnavailable)) {
                const reason = "read_back_required";
                pendingDecision = hostRefusalDecision(
                  reason,
                  evidence.executionId,
                  buildEffect === "write",
                );
                yield* diagnose({ phase: "publication", code: "PublicationUnavailable", reason });
                return JSON.stringify({
                  status: "not_published",
                  code: "PublicationUnavailable",
                  reason,
                  userInputRequired: false,
                  instruction:
                    writeSession === "closed"
                      ? "A later act step confirmed this write session. Publish against that step."
                      : withheldConfirmationInstruction,
                  executionContext: yield* executionContext(),
                });
              }
              // The step that read the site's confirmation publishes its session even when its
              // own output failed: the write happened once, and publication never runs it again.
              const confirmedWrite = actStep && (evidence.confirmation !== undefined || withheld);
              if (
                !evidence ||
                (!repair &&
                  !confirmedWrite &&
                  !refusedWithChoices(evidence) &&
                  (evidence.status !== "completed" || !evidence.resultRef)) ||
                purposes.get(evidence.executionId) === "authenticate" ||
                purposes.get(evidence.executionId) === "test" ||
                purposes.get(evidence.executionId) === "command" ||
                // A write maintenance's inspection or residual step is its repair receipt.
                (!repair &&
                  (purposes.get(evidence.executionId) === "inspect" ||
                    purposes.get(evidence.executionId) === "residual"))
              ) {
                const reason = !evidence
                  ? "missing_receipt"
                  : evidence.status !== "completed"
                    ? "receipt_incomplete"
                    : !evidence.resultRef
                      ? "missing_protected_result"
                      : "wrong_execution_purpose";
                pendingDecision = hostRefusalDecision(
                  reason,
                  evidence?.executionId,
                  buildEffect === "write",
                );
                yield* diagnose({
                  phase: "publication",
                  code: "PublicationUnavailable",
                  reason,
                });
                return JSON.stringify({
                  status: "not_published",
                  code: "PublicationUnavailable",
                  reason,
                  userInputRequired: false,
                  executionContext: yield* executionContext(),
                });
              }
              // Guardian denied this same submission, and a second review would deny it again.
              if (yield* unchangedSinceDenial(proposed)) {
                const reason = "unchanged_since_denial";
                pendingDecision = hostRefusalDecision(reason, evidence.executionId, write);
                yield* diagnose({ phase: "publication", code: "PublicationUnavailable", reason });
                return JSON.stringify({
                  status: "not_published",
                  code: "PublicationUnavailable",
                  reason,
                  userInputRequired: false,
                  instruction:
                    "Not published: nothing changed since Guardian denied this submission, so it was not reviewed again. Fix that denial's findings, or end as its instruction says.",
                  executionContext: yield* executionContext(),
                });
              }
              const minterCoverage = yield* screenMintText(dependencies, proposed.coverage);
              const assumptions = yield* screenAssumptions(proposed.assumptions);
              const readBackUnavailable = withheld
                ? yield* screenMintText(dependencies, proposed.readBackUnavailable ?? "")
                : undefined;
              const httpVersion =
                proposed.httpVersion === undefined
                  ? undefined
                  : {
                      ...proposed.httpVersion,
                      note: yield* screenMintText(dependencies, proposed.httpVersion.note),
                    };
              const outputOverrides =
                proposed.outputOverrides === undefined
                  ? undefined
                  : yield* Effect.forEach(proposed.outputOverrides, (override) =>
                      screenMintText(dependencies, override.reason).pipe(
                        Effect.map((reason) => ({ ...override, reason })),
                      ),
                    );
              // The host's own record of a read's live tests on this source goes to the review
              // as evidence, and its line to coverage. It refuses publication by itself only
              // when the published version's cases pass below the bar on its source, or, on a
              // host that holds the review for it, when any of them fails there: the review
              // would hold it back on those failures anyway, so it is not started. Once the
              // attempt ran out of time for live tests, or no further batch fits, as after a
              // host's batch cap, no case can run again, so the review decides on the record as
              // it is.
              const liveTests = yield* liveTestsForPublication(
                proposed.entrypoint,
                proposed.httpVersion?.outcome === "ruled_out",
              );
              const testsCanRunAgain =
                liveTests !== undefined &&
                dependencies.liveTests !== undefined &&
                !liveTestsOutOfTime &&
                (yield* liveTestBatchFits(
                  dependencies.liveTests,
                  (yield* liveTestDeadline).deadlineAt,
                ));
              const shortfall =
                liveTests === undefined || !testsCanRunAgain
                  ? undefined
                  : liveTestsShortfall(
                      liveTests.record.versions,
                      liveTestVersion(proposed.entrypoint),
                    );
              if (shortfall !== undefined) {
                const reason = "live_tests_below_threshold";
                pendingDecision = hostRefusalDecision(reason, evidence.executionId, write);
                yield* diagnose({ phase: "publication", code: "PublicationUnavailable", reason });
                return JSON.stringify({
                  status: "not_published",
                  code: "PublicationUnavailable",
                  reason,
                  userInputRequired: false,
                  instruction: `Publication review not started: only ${shortfall.passed} of ${shortfall.counted} live test cases${shortfall.entrypoint === undefined ? "" : ` on ${shortfall.entrypoint}`} pass on this source (${shortfall.percent}%), and review starts at ${reviewPassPercent}%. Fix the code where a case fails, or the case where it is wrong, run every case again, then call finish_build.`,
                  executionContext: yield* executionContext(),
                });
              }
              // A host that holds the review while a counted case fails on this source has the
              // minter fix the code or retire the case first: the review would hold publication
              // back on that case anyway. It lifts with the bar, once no case can run again.
              const failing =
                liveTests === undefined ||
                !testsCanRunAgain ||
                dependencies.liveTests?.holdReviewOnFailingCases !== true
                  ? undefined
                  : failingLiveTestCases(liveTests.record, liveTestVersion(proposed.entrypoint));
              if (failing !== undefined) {
                const reason = "live_test_cases_failing";
                pendingDecision = hostRefusalDecision(reason, evidence.executionId, write);
                yield* diagnose({ phase: "publication", code: "PublicationUnavailable", reason });
                return JSON.stringify({
                  status: "not_published",
                  code: "PublicationUnavailable",
                  reason,
                  userInputRequired: false,
                  instruction: failingCasesRefusal(failing),
                  executionContext: yield* executionContext(),
                });
              }
              const coverage =
                liveTests === undefined
                  ? minterCoverage
                  : `${minterCoverage}\n${liveTests.coverage}`;
              const publication = yield* dependencies
                .publish(
                  {
                    entrypoint: proposed.entrypoint,
                    executionId: proposed.executionId,
                    metadata: proposed.metadata,
                    coverage,
                    ...(readBackUnavailable === undefined ? {} : { readBackUnavailable }),
                    ...(httpVersion === undefined ? {} : { httpVersion }),
                    ...(outputOverrides === undefined ? {} : { outputOverrides }),
                  },
                  evidence,
                  ...(liveTests === undefined
                    ? []
                    : [
                        {
                          liveTests: liveTests.record,
                          testedFields: fillsOnSource(
                            proposed.entrypoint,
                            yield* stepDigest(proposed.entrypoint),
                          ),
                        },
                      ]),
                )
                .pipe(Effect.either);
              const reviewId =
                publication._tag === "Right"
                  ? publication.right.review?.reviewId
                  : publication.left.review?.reviewId;
              const reason =
                publication._tag === "Right"
                  ? undefined
                  : (publication.left.reason ?? publication.left.review?.reason);
              pendingDecision = {
                outcome: publication._tag === "Right" ? "published" : "refused",
                code: publication._tag === "Right" ? "Published" : publication.left.code,
                ...(reason === undefined ? {} : { reason }),
                executionId: evidence.executionId,
                ...(reviewId === undefined ? {} : { reviewId }),
                failedChecks: publication._tag === "Right" ? [] : refusalChecks(publication.left),
                recovery:
                  publication._tag === "Right"
                    ? "none"
                    : publication.left.reviewFailure === "InvalidOutcome"
                      ? "correct_source"
                      : publication.left.code === "ReviewUnavailable" ||
                          publication.left.code === "CaptureUnavailable" ||
                          publicationOutage(publication.left)
                        ? "retry"
                        : publication.left.code === "ReviewDenied"
                          ? "guardian_feedback"
                          : refusalRecovery(reason, buildEffect === "write"),
              };
              // The host's own publication checks refused it, as a sign-in that fails on a new
              // browser: neither Guardian's decision nor an outage. An output the example could not
              // make available is an infrastructure gap, and a refusal the host asks only once,
              // such as a one-time login URL or an untested HTTP version, is advice: finishing
              // again publishes.
              const hostChecksRefused =
                publication._tag === "Left" &&
                publication.left.code === "PublicationUnavailable" &&
                !publicationOutage(publication.left) &&
                publication.left.reason !== "example_output_unavailable" &&
                !askedOnceReasons.has(publication.left.reason ?? "");
              // A submission the host already refused, sent again with nothing changed after a
              // later finish_build got past that refusal, is refused the same way again: no new
              // host refusal, so a minter cannot make a basis for host_refused by repeating one.
              const refusedSubmission = hostChecksRefused
                ? yield* submissionSnapshot(proposed, [proposed.entrypoint, httpVersionPath])
                : undefined;
              hostRefusalRepeated =
                refusedSubmission !== undefined &&
                !hostRefused &&
                (yield* Effect.exists(hostRefusedSubmissions, (kept) =>
                  sameSubmission(kept, proposed),
                ));
              if (refusedSubmission !== undefined)
                hostRefusedSubmissions = [...hostRefusedSubmissions, refusedSubmission].slice(
                  -rememberedRefusedSubmissions,
                );
              if (hostChecksRefused && !hostRefusalRepeated)
                refuseByHost({
                  source: "publication",
                  code: publication.left.code,
                  ...(publication.left.reason === undefined
                    ? {}
                    : { reason: publication.left.reason }),
                });
              if (publication._tag === "Right" || reviewDecided(publication.left)) {
                yield* reviewCompleted;
                // A completed review replaces the input feedback an earlier one returned.
                inputFeedbackReview = undefined;
                // This finish_build got past the host's checks to Guardian's review, so an earlier
                // host refusal no longer stands: what Guardian decided is what the build answers.
                if (hostRefused && !hostChecksRefused) {
                  hostRefused = false;
                  standingHostRefusals = [];
                  hostRefusalPassed = true;
                }
              }
              const denial = publication._tag === "Left" ? publication.left.review : undefined;
              const deniedCategory = denial?.findings?.[0]?.category;
              if (
                publication._tag === "Left" &&
                publication.left.code === "ReviewDenied" &&
                denial !== undefined &&
                publicationRefusalUnfixable(denial)
              ) {
                guardianRefused = true;
                signInRefusalOnly = false;
              }
              if (publication._tag === "Left" && publication.left.code === "ReviewDenied") {
                const paths = [
                  ...new Set([
                    proposed.entrypoint,
                    httpVersionPath,
                    ...(denial?.findings ?? []).map((finding) => workspacePath(finding.path)),
                  ]),
                ];
                deniedSubmission = yield* submissionSnapshot(proposed, paths);
              }
              // Guardian's public reason reaches the caller screened like the caller's other
              // text: credentials and host-private values out, cut to its bound. A screen that
              // fails keeps nothing, and the denial stands without it.
              const publicReason =
                denial?.publicReason === undefined
                  ? undefined
                  : yield* screenMintText(dependencies, denial.publicReason).pipe(
                      Effect.map((screened) =>
                        cutToLimit(redactCallerText(screened).trim(), publicReasonLimit),
                      ),
                      Effect.orElseSucceed(() => undefined),
                    );
              publicationDenial =
                publication._tag === "Left" && publication.left.code === "ReviewDenied"
                  ? {
                      ...(denial?.reason === undefined ? {} : { reason: denial.reason }),
                      ...(deniedCategory === undefined ? {} : { category: deniedCategory }),
                      ...(publicReason === undefined || publicReason === ""
                        ? {}
                        : { publicReason }),
                    }
                  : undefined;
              const publicationDiagnostics =
                publication._tag === "Right"
                  ? publication.right.diagnostics
                  : (publication.left.publicationDiagnostics ?? []);
              for (const gap of publicationDiagnostics) {
                const diagnostic = JSON.stringify(gap);
                if (!diagnostics.includes(diagnostic)) diagnostics.push(diagnostic);
              }
              if (publication._tag === "Left") {
                const error = publication.left;
                const outputUnavailable =
                  error.code === "PublicationUnavailable" &&
                  error.reason === "example_output_unavailable";
                if (outputUnavailable) unavailableOutputRefusals++;
                // Each refusal permits one fresh verified example; a third unavailable output, or
                // an example that cannot be repeated, is an infrastructure failure.
                const outputUnrecoverable =
                  outputUnavailable &&
                  (!repeatableRead ||
                    executionClosed ||
                    unavailableOutputRefusals > maximumUnavailableOutputReruns);
                const hostUnavailable =
                  stopUnavailableHost() ||
                  outputUnrecoverable ||
                  (error.code === "PublicationUnavailable" &&
                    (error.reason === "executor_unavailable" ||
                      error.reason === "registry_publication"));
                if (hostUnavailable)
                  terminal = {
                    build: "incomplete",
                    hostFailure: "publication_unavailable",
                    summary: outputUnrecoverable
                      ? "The host could not read the retained output of a verified example, so publication review had nothing to judge. The existing execution outcomes remain recorded."
                      : "Publication infrastructure is unavailable. The existing execution outcomes and protected results remain retained independently of future code publication.",
                  };
                // The review as the minter reads it, screened once for every reply below.
                const review =
                  error.review === undefined ? undefined : yield* minterReview(error.review);
                if (
                  error.code === "PublicationUnavailable" &&
                  error.reason !== undefined &&
                  (namedStepReasons.has(error.reason) || rationaleStepReasons.has(error.reason))
                ) {
                  // Screened on its own, so a screen that fails keeps no rationale rather than
                  // the delivery notice the minter's copy of the review takes in its place.
                  const rationale =
                    error.review === undefined
                      ? ""
                      : yield* screenMintText(dependencies, error.review.rationale).pipe(
                          Effect.map((screened) =>
                            capped(screened.trim(), ledgerBounds.instructionChars),
                          ),
                          Effect.orElseSucceed(() => ""),
                        );
                  if (rationale === "") namedStepRationales.delete(error.reason);
                  else namedStepRationales.set(error.reason, rationale);
                }
                if (review !== undefined)
                  yield* recordDenial({
                    review: "publication",
                    outcome: review.outcome,
                    ...(review.reason === undefined ? {} : { reason: review.reason }),
                    ...(review.reviewId === undefined ? {} : { reviewId: review.reviewId }),
                    rationale: review.rationale,
                    ...(review.findings === undefined
                      ? {}
                      : { findings: review.findings.map(({ explanation }) => explanation) }),
                  });
                // Screening serializes through JSON, which leaves out undefined fields.
                const diagnostic = yield* screenMintText(dependencies, {
                  phase: "publication",
                  code: failureCode(error),
                  reason: error.reason,
                  screening: error.screening,
                  publicationBlock: error.publicationBlock,
                  destinationEvidenceGap: error.destinationEvidenceGap,
                  ...(review === undefined ? {} : { review }),
                  reviewPhase: error.reviewPhase,
                  reviewFailure: error.reviewFailure,
                  diagnosticRetentionReason: error.diagnosticRetentionReason,
                  diagnosticScreeningReason: diagnosticScreeningReason(error),
                  diagnosticStorageFailure: error.diagnosticStorageFailure,
                }).pipe(Effect.either);
                if (diagnostic._tag === "Right") diagnostics.push(diagnostic.right);
                if (error.code === "ReviewUnavailable")
                  return yield* reviewUnavailableRetry(
                    "publication",
                    reviewUnavailableFeedback,
                  )(error);
                if (
                  error.reason === "registry_invalid_definition" ||
                  error.reason === "registry_conflict" ||
                  publicationOutage(error)
                )
                  return yield* registryFeedback(error);
                if (hostUnavailable)
                  return JSON.stringify({
                    status: "publication_unavailable",
                    code: error.code,
                    ...availabilityMetadata(),
                    reason: outputUnrecoverable ? "example_output_unrecoverable" : error.reason,
                    diagnostic:
                      diagnostic._tag === "Right"
                        ? diagnostic.right
                        : "Publication diagnostic unavailable.",
                    userInputRequired: false,
                    instruction:
                      "Publication infrastructure is unavailable. End this attempt without retrying finish_build or execution. Preserve all existing receipts and protected results; source edits or a fabricated user question cannot restore this dependency.",
                  });
                // Capture evidence publication needs is a gap, never a reason to run a write again.
                // Like any publication dependency, it may be tried again until the outage budget
                // runs out.
                if (error.code === "CaptureUnavailable") {
                  const retryable = !(stopUnavailableHost() || (yield* reviewRetryExhausted()));
                  if (!retryable)
                    terminal = {
                      build: "incomplete",
                      hostFailure: "publication_unavailable",
                      summary:
                        "Not published: the capture evidence publication needs stayed unavailable. The existing execution outcomes and protected results remain retained.",
                    };
                  return notPublished(
                    error.code,
                    error.reason,
                    { captureGap: screenedCaptureGap(error), retryable },
                    retryable
                      ? "Not published yet: the capture evidence publication needs is unavailable, and the host recorded the gap. The existing example and result remain recorded. Call finish_build again with the same executionId. If it stays unavailable, gather what publication needs through a new read-only observation; never run a write that may have committed again to regenerate capture."
                      : "Not published: the capture evidence publication needs stayed unavailable through the publication outage budget. This attempt ends here; preserve the recorded receipt.",
                  );
                }
                if (error.code !== "PublicationUnavailable" && error.code !== "ReviewDenied")
                  return yield* error;
                // Input feedback never fails the mint at once: the minter gets bounded rounds to
                // fix it. Then a host's fallback publishes the last reviewed candidate, privately
                // and flagged, or with no fallback the build ends unpublished with the findings.
                if (error.review?.reason === "input_feedback") {
                  inputFeedbackRounds++;
                  inputFeedbackCoverage = coverage;
                  const fallback = dependencies.inputFeedbackFallback;
                  const privateFallback = fallback?.kept() === true;
                  inputFeedbackPublicTool = fallback !== undefined && !privateFallback;
                  const findings = error.review.findings ?? [];
                  const inRounds = inputFeedbackRounds <= maximumInputFeedbackRounds;
                  // The minter reads the screened rationale in each round, and a build with no
                  // fallback ends on it; a fallback's last round never reads it.
                  const rationale =
                    inRounds || fallback === undefined
                      ? yield* screenRationale(error.review.rationale)
                      : undefined;
                  if (fallback === undefined && rationale !== undefined)
                    inputFeedbackReview = {
                      categories: [...new Set(findings.map(({ category }) => category))],
                      rationale,
                    };
                  if (inRounds && rationale !== undefined)
                    return notPublished(
                      error.code,
                      "input_feedback",
                      {
                        findings: yield* minterFindings(findings),
                        rationale,
                        reviewId: error.review.reviewId,
                        feedbackRoundsRemaining: maximumInputFeedbackRounds - inputFeedbackRounds,
                      },
                      inputFeedbackInstruction(maximumInputFeedbackRounds - inputFeedbackRounds, {
                        write: buildEffect === "write",
                        ...(fallback === undefined ? {} : { privateFallback }),
                      }),
                    );
                  if (yield* settleUnresolvedInputFeedback)
                    return "Build published for this account only and flagged with Guardian's unresolved input feedback. The current invocation outcome is returned separately; do not execute again.";
                  terminal ??= { build: "incomplete", summary: unresolvedInputFeedbackSummary() };
                  return JSON.stringify({
                    status: "not_published",
                    code: error.code,
                    reason: "input_feedback_unresolved",
                    userInputRequired: false,
                    instruction: "Nothing was published. End this attempt; do not execute again.",
                  });
                }
                // Every finding is in a file the host wrote, which no edit of the minter's fixes:
                // a defect of the host's, so the host ends the build as its own failure, never as
                // the minter's policy block.
                if (error.review?.reason === "host_owned") {
                  terminal ??= {
                    build: "incomplete",
                    hostFailure: "publication_unavailable",
                    summary:
                      "Not published: Guardian's publication review found a defect in a file the host wrote, which no source edit can fix. The existing execution outcomes and protected results remain retained.",
                  };
                  return notPublished(
                    error.code,
                    "host_owned",
                    {
                      findings: yield* minterFindings(error.review.findings ?? []),
                      rationale: yield* screenRationale(error.review.rationale),
                      reviewId: error.review.reviewId,
                    },
                    "Not published: every finding is in a host-owned file, which cannot be fixed from source. The host ends this attempt as its own failure; do not edit source for it, run anything again or call finish_build again.",
                  );
                }
                // A gate refusal names its file and what matched there. It is the minter's to fix,
                // never a review outage to retry.
                if (error.publicationBlock !== undefined) {
                  const feedback = publicationBlockFeedback(error.publicationBlock);
                  // The file goes out as the minter knows it, under `file` below.
                  const block = Object.fromEntries(
                    Object.entries(error.publicationBlock).filter(([key]) => key !== "file"),
                  );
                  return notPublished(
                    error.code,
                    error.reason,
                    {
                      file: feedback.file,
                      ...block,
                      retryable: false,
                      fixRequired: feedback.fixable,
                    },
                    feedback.instruction,
                  );
                }
                // Nothing to publish ends the repair here, so no continuation prompt asks for an edit.
                if (error.reason === "repair_unchanged") {
                  terminal ??= {
                    build: "incomplete",
                    summary:
                      "The repair changed none of the registered revision's source, so nothing was published and the registered revision stays current. Recorded effects and receipts are preserved.",
                  };
                  return JSON.stringify({
                    status: "not_published",
                    code: error.code,
                    reason: error.reason,
                    userInputRequired: false,
                    instruction:
                      "Not published: the source this repair would publish is byte for byte the registered revision's, so there is nothing to publish. A new name or description alone is not a repair. The registered revision stays current and this repair ends here; do not call finish_build again.",
                  });
                }
                // Deterministic, before any review: the minter fixes the extraction, or the owner
                // confirms a contract change. It is neither a review nor an outage.
                if (error.reason === "output_obligation_weakened")
                  return notPublished(
                    error.code,
                    error.reason,
                    { weakenedOutputs: error.weakenedOutputs ?? [] },
                    `Not published and not reviewed: this repair loosens the registered tool's output contract${weakenedOutputsText(error.weakenedOutputs ?? [])}. A repair keeps every output the registered tool returns, at least as required and as strictly typed; it may add or tighten fields. ${
                      buildEffect === "write"
                        ? "Keep the schema as registered and fix the extraction from what the session already read, then call finish_build again with the same executionId; never run the write again for this."
                        : "Keep the schema as registered and fix the extraction so it returns each value, then run the example again and call finish_build with that new executionId."
                    } If the site no longer shows a value, propose mint_update with an output change for that field, which the tool's owner must confirm, and a reason when it removes the field; once it is updated, call finish_build again with the same executionId. Otherwise end with report_blocked, reason site_lacks_capability, naming the field.`,
                  );
                // A host's own comparison with the published tool's inputs: exactly its fixed
                // instruction, with each broken input as data.
                if (error.reason === "input_contract_changed")
                  return notPublished(
                    error.code,
                    error.reason,
                    { brokenInputs: error.brokenInputs ?? [] },
                    inputContractChangedInstruction(buildEffect === "write"),
                  );
                if (error.reason === "tool_name_taken")
                  return notPublished(
                    error.code,
                    error.reason,
                    {},
                    `Not published and not reviewed: ${registryRefusal("tool_name_taken").instruction}`,
                  );
                if (error.reason === "site_metadata_required")
                  return notPublished(
                    error.code,
                    error.reason,
                    {},
                    "Not published and not reviewed: this is the first tool of this site's integration, which takes its name from this publication. Add siteName, the site's everyday name as people say it (such as Example Flights, 1 to 60 characters), and siteSummary, one sentence on what the site is, not what this tool does (1 to 160 characters), to finish_build's metadata, and call finish_build again with the same executionId. Both are public: write them from what the site shows anyone, never from this account or session.",
                  );
                if (error.reason === "output_checks_blocked")
                  return notPublished(
                    error.code,
                    error.reason,
                    { outputFindings: error.outputFindings ?? [] },
                    outputChecksRefusal(error.outputFindings ?? []),
                  );
                if (error.reason === "variants_unsupported")
                  return notPublished(
                    error.code,
                    error.reason,
                    {},
                    "Not published: this Kernel script declares supportedVariants, and only Effect runs dispatch variants, so every call would fail with InvalidOutput. Either remove supportedVariants from the tool's metadata (keep one script that handles the variation itself) and call finish_build again with the same executionId; the recorded example and result stay valid and nothing needs to run again. Or, if variants are essential, make it an offline tool: execute a new example with target pureFiles, then call finish_build with that new executionId. The same executionId is refused again while its receipt is a Kernel script.",
                  );
                if (
                  error.reason === "http_implementation_untested" ||
                  error.reason === "http_implementation_stale"
                )
                  return notPublished(
                    error.code,
                    error.reason,
                    {},
                    (error.reason === "http_implementation_stale"
                      ? "Not published yet: src/tool-http.mjs changed since its last passing live test, and a test counts only for the source it ran. Run execute purpose test, target liveBrowser, entrypoint src/tool-http.mjs on the current file, or restore the version that passed, then call finish_build again with the same executionId."
                      : "Not published yet: this read has no HTTP version that passed a live test. Read .agents/http-mcp/SKILL.md from the top, find where the example's data comes from (step 1), write src/tool-http.mjs and test it live with execute purpose test, target liveBrowser, entrypoint src/tool-http.mjs. Fix and test again until its output matches the example's; a request refused before sending never counts. A read signed out then runs its cases as a batch on it with live_tests, as on src/tool.mjs (testing skill); a signed-in read checks it once, against the example. Then call finish_build again with the same executionId.") +
                      " If it can't port, call finish_build again with httpVersion naming the signal from the skill's \"When it can't port\", the requestId it rests on and a short note; don't write or run a stub. The host asks only once.",
                  );
                if (error.reason === "login_url_one_time")
                  return notPublished(
                    error.code,
                    error.reason,
                    { ...error.publicationFeedback },
                    "Not published yet: the login URL this tool would publish (the loginUrl you passed to authenticate, or the page the browser was on when you passed none) is one authorization request: an identity provider's authorize URL, or a URL carrying one-time authorization values (oneTimeParameters names the authorize path and those values). They are spent once this sign-in ends, so later runs that reopen it would start from stale values. The host changed nothing. Navigate the browser to the site's stable sign-in entry, the page a person would bookmark or the site's own login link before it redirected, run authenticate again with that page's address as loginUrl, then call finish_build again with the same executionId. If no stable entry exists, call finish_build again and the host publishes the URL as it is, flagged. The host asks only once.",
                  );
                if (
                  error.reason === "login_url_contains_credential" ||
                  error.reason === "metadata_contains_credential"
                )
                  return notPublished(
                    error.code,
                    error.reason,
                    { ...error.publicationFeedback },
                    "Not published: each part named in parts holds a registered credential (credentialKinds names the kind, never the value). A published tool never carries one, and the host changes nothing itself. For loginUrl, run authenticate again with a login URL that has no credential in it, the site's plain sign-in page. For name, description, siteName or siteSummary, rewrite the text without it. Then call finish_build again with the same executionId. The host refuses every time until the credential is gone; the build is not over.",
                  );
                if (error.reason === "sign_in_version_refused")
                  return notPublished(
                    error.code,
                    error.reason,
                    { signInFindings: error.publicationFeedback?.signInFindings ?? [] },
                    "Not published: the sign-in this tool would publish fails the host's sign-in version check. signInFindings names each rule and the part of the sign-in recipe or login URL it refused, never a value. The host changed nothing. Run authenticate again so the sign-in records without those parts: start from the site's stable sign-in page as loginUrl, name no account in a selector, page or marker, leave out any step or account page that signs out, and use a signed-in marker that only signed-in pages show. Then call finish_build again with the same executionId. The host refuses every time until the sign-in passes.",
                  );
                if (error.reason === "definition_login_reference") {
                  const section = error.screening?.section;
                  return notPublished(
                    error.code,
                    error.reason,
                    { section },
                    `Not published: the tool's ${section ?? "definition"} quotes this build's account reference, an opaque value the host gave this build to identify its login (such as an inspection's accountScope). It means nothing to a caller and is never published. ${definitionFix(section)} The existing example and result remain recorded.`,
                  );
                }
                if (error.reason === "secret_handle") {
                  const path = error.screening?.path ?? "the source";
                  return notPublished(
                    error.code,
                    error.reason,
                    { path: error.screening?.path },
                    `Not published: ${path} holds a {{secret.…}} handle. A handle works only in this build's own executions, where the host fills in the caller's answer; published code never holds a handle or a value. Declare the value as a secret question in the operation's questions and read it with ask at run time, as .agents/caller-input/SKILL.md shows, then call finish_build again.`,
                  );
                }
                if (error.reason === "file_handle")
                  return notPublished(
                    error.code,
                    error.reason,
                    {},
                    "Not published: the source holds a {{file.…}} handle, which names a caller's file only in this build. A tool takes each file from its input: type the field as FileInput and pass the input's value to files.place. Remove the handle from the source, then call finish_build again.",
                  );
                if (error.reason === "file_readback")
                  return notPublished(
                    error.code,
                    error.reason,
                    {},
                    `Not published: the source moves or reads a file outside the host's file service. Rule: ${fileReadbackRule}. Remove that code, then call finish_build again.`,
                  );
                if (error.reason === "card_readback")
                  return notPublished(
                    error.code,
                    error.reason,
                    {},
                    `Not published: the source fills a card and could read it back. Rule: ${cardReadbackRule}. Remove that code, then call finish_build again.`,
                  );
                if (
                  error.reason === "session_token_literal" ||
                  error.reason === "session_token_placeholder"
                ) {
                  const path = error.screening?.path ?? "the source";
                  const placeholder = error.reason === "session_token_placeholder";
                  return notPublished(
                    error.code,
                    error.reason,
                    { path: error.screening?.path, section: error.screening?.section },
                    placeholder
                      ? `Not published: ${path} still reads [session token withheld] where an earlier release withheld a live token, so it no longer matches what ran. Do not paste a token back in: edit the source to read the token at run time from the response, cookie or page that issues it, then call finish_build again; the existing example and result remain recorded.`
                      : error.screening?.section === "loginUrl"
                        ? "Not published: the login URL holds a literal session token observed during sign-in. Run authenticate again with the site's stable sign-in page URL, without the token, then call finish_build again with the same executionId. The host keeps the URL unchanged for your HTTP work and does not end this build."
                        : `Not published: ${path} holds a literal session token from captures/session-tokens.json. Published code never contains a token. Edit the source to read the token at run time from the response, cookie or page that issues it, then call finish_build again; the existing example and result remain recorded. Your workspace keeps the token for your own HTTP work. If the file is src/tool-http.mjs, run its live test again first, because the edit invalidates the last one.`,
                  );
                }
                if (error.reason === "confirm_action_unmatched")
                  return notPublished(
                    error.code,
                    error.reason,
                    { confirmActionIds: error.confirmActionIds ?? [] },
                    "Not published: the session accepted confirm popups reported to decideDialog under these step names, and the composed script does not report them under the same names. Reuse each step literal exactly, for example by importing the step's helper, so runs accept the same popups without asking; then call finish_build again with the same executionId. Never run the write again.",
                  );
                if (error.reason === "write_not_submitted")
                  return notPublished(
                    error.code,
                    error.reason,
                    {},
                    `Not published: this build has not demonstrated the requested write. ${error.publishesOnRefusal === true ? `${siteRefusalPublication} Otherwise, continue` : "Continue"} the remaining authorized work, and never run a write that completed again. If a step may already have committed, read back first, in a new act step that only reads the page or the account: if the write happened, record it with verified() in that step and call finish_build naming it. The host runs a step that may have committed only once, unless the outcome review finds it did not happen; a repeat is refused until then. If the site offers no read-back that can tell, never submit again: publish the write as unverifiable against the step that could have committed. If the caller's inputs cannot work on the site as given, ask the owner with request_input whether to revise them. A path that skipped the write does not show a working write tool.`,
                  );
                if (error.reason === "write_path_unfinished")
                  return notPublished(
                    error.code,
                    error.reason,
                    { writePathMarks: error.writePathMarks ?? [] },
                    "Not published: the write session has not settled every commit mark of its recorded write path; writePathMarks names the ones not yet settled (a step that lost its result may have entered them). The session stays open until they are. Read back first where a receipt says so: a read-back that confirms the write settles the marks a lost step entered. Then run only steps that never ran, on the page as it stands, and call finish_build naming the step that confirmed the path's end. Never redo a step that finished or may have. When the page shows the path must change, such as a step the site skips for this input, declare the revised path in writePath on the next act step. When the site refuses to go on, or nothing can settle a mark, end with report_blocked.",
                  );
                if (error.reason === "write_path_undeclared")
                  return notPublished(
                    error.code,
                    error.reason,
                    { writePathMarks: error.writePathMarks ?? [] },
                    "Not published: the composed script leaves out commit marks of the session's recorded write path from write.commits; writePathMarks names them. Run every step of the path in the composed script, marked by the same helper the session used, declare every mark in order, and call finish_build again with the same executionId. Never run the write again.",
                  );
                if (error.reason === "refusal_unreadable")
                  return notPublished(
                    error.code,
                    error.reason,
                    {},
                    "Not published: the output schema has a `status` of `refused` that the host can't read as a declared refusal, so this refusal would end as an unknown outcome. Put each refusal shape in the output's top-level union, and give every other branch a listed `status`. Each refusal shape requires `status` `\"refused\"` and a `reason` from a listed set of stable lowercase codes. Then call finish_build again with the same executionId. The host reads the schema offline; never run the write again for this.",
                  );
                if (
                  error.reason === "confirmation_undeclared" ||
                  error.reason === "commit_marks_undeclared" ||
                  error.reason === "commit_marks_unentered" ||
                  error.reason === "confirmation_unrecorded" ||
                  error.reason === "contract_input_mismatch" ||
                  error.reason === "contract_output_mismatch"
                )
                  return notPublished(
                    error.code,
                    error.reason,
                    error.reason === "contract_input_mismatch" && error.inputIssues !== undefined
                      ? { inputIssues: error.inputIssues }
                      : {},
                    (error.reason === "confirmation_undeclared"
                      ? "Not published: the composed script declares no write confirmation. Add write: {confirmation: 'message' | 'readback' | 'unverifiable'} to its defineOperation, matching what the session read, and call finish_build again with the same executionId."
                      : error.reason === "commit_marks_undeclared"
                        ? "Not published: the composed script names none of its commit steps. List every step that can change the site (an autosave, a saved form step, the final submit) in order as write.commits, such as commits: ['save-address', 'place-order'], using short lowercase hyphenated names, and mark each with the context's enteringCommit(name) right before the execute call that can send it (an HTTP implementation calls journal.enteringCommit(name) before that request). Opening a form and typing into its fields are not commit steps unless the site's requests show they save the caller's change; a lookup, suggestion, validation or analytics request saves nothing. Then call finish_build again with the same executionId."
                        : error.reason === "commit_marks_unentered"
                          ? `Not published: the composed script declares a commit step that no act step of the session entered, so nothing shows its marks follow the real commit. Declare exactly the marks the session's act steps entered, marked by the same helper the composed script uses, and call finish_build again with the same executionId. If the session stopped before later save steps because the caller's facts ran out, declare those steps in commitsUnproven; publication records them as unproven until a run reaches them. Keep them in commits too, after the entered ones. ${error.publishesOnRefusal === true ? `If the session's steps entered none because the site said no to the example's valid inputs before any save, the act step named for publication must return that no as a refusal its output schema declares, and every commit step goes in commitsUnproven as well as in commits; then call finish_build again with the same executionId. If they entered none for any other reason, it cannot publish` : "If the session's steps entered none, it cannot publish"}: never run the write again for this; end the build and say its commit steps were not marked.`
                          : error.reason === "confirmation_unrecorded"
                            ? "Not published: the declared write confirmation does not match the session. Name the act step that recorded the declared confirmation, or declare what the session actually read; a session that recorded a confirmation is never unverifiable. Then call finish_build again."
                            : error.reason === "contract_input_mismatch"
                              ? `Not published: the script's input schema rejects the input the example or session ran: the caller's own, or the exampleInput you passed when the caller's was empty (in maintenance, the original invocation's).${inputIssueText(error.inputIssues)} Correct the schema, or the code that reads that input, so this input decodes, then call finish_build again with the same executionId. Keep each input the tool needs required; make one optional only when the tool can work without it.`
                              : request.mode === "maintenance" && buildEffect !== "write"
                                ? "Not published: the script's output schema rejects the output this repair's example returned. A field the registered tool returns stays in the schema as registered. Fix the extraction so it returns that field, then run the example again and call finish_build with that new executionId. If the site no longer shows the field, propose mint_update with an output change for it, which the tool's owner must confirm, and a reason when it removes the field, or end with report_blocked, reason site_lacks_capability, naming the field."
                                : request.mode === "maintenance"
                                  ? "Not published: the script's output schema rejects the output this repair's write session returned. A field the registered tool returns stays in the schema as registered. Fix the extraction from what the session already read, then call finish_build again with the same executionId. If the site no longer shows the field, propose mint_update with an output change for it, which the tool's owner must confirm, and a reason when it removes the field, or end with report_blocked, reason site_lacks_capability, naming the field."
                                  : "Not published: the script's output schema rejects the output this read's example returned. Correct the schema so that output decodes: a field the example did not return must be optional or removed. Then call finish_build again with the same executionId.") +
                      (error.reason === "contract_output_mismatch" &&
                      request.mode === "maintenance" &&
                      buildEffect !== "write"
                        ? ""
                        : " The host extracts the contract offline; never run the write or the example again for this."),
                  );
                if (error.reason === "destination_validation") {
                  // Publication uses the route evidence the host recorded while the example ran.
                  // Source edits and another finish_build on the same receipt cannot change it,
                  // so only one fresh reviewed read gets a chance before the attempt ends.
                  destinationEvidenceRefusals++;
                  const freshRead =
                    repeatableRead && !executionClosed && destinationEvidenceRefusals === 1;
                  if (!freshRead)
                    terminal = {
                      build: "incomplete",
                      summary:
                        "Publication could not use the route evidence the host recorded for the example, and no fresh example can replace it in this attempt. The existing execution outcomes and protected results remain retained.",
                    };
                  return notPublished(
                    error.code,
                    error.reason,
                    {
                      destinationEvidenceGap: error.destinationEvidenceGap,
                      repeatableRead: freshRead,
                    },
                    "Not published: publication uses the route evidence the host recorded while this example ran. " +
                      destinationEvidenceInstruction[error.destinationEvidenceGap ?? "unknown"] +
                      " Source edits and another finish_build against this executionId cannot change it. " +
                      (freshRead
                        ? "Run one fresh reviewed execute with purpose example of the same source under the original input/account/budget, restoring the sign-in's login URL first if it changed, then call finish_build with the new executionId. Another refusal ends this attempt."
                        : "No fresh example can replace it in this attempt, which ends here. Preserve the recorded receipt."),
                  );
                }
                if (outputUnavailable)
                  return notPublished(
                    error.code,
                    error.reason,
                    {
                      rerunsRemaining: maximumUnavailableOutputReruns - unavailableOutputRefusals,
                      repeatableRead: true,
                    },
                    "Not published and not reviewed: the host could not read the retained output of this example, so there was nothing to judge. Run a fresh reviewed execute with purpose example of the same source under the original input/account so its result is retained, then call finish_build with that new executionId. Do not edit source for this reason. This is bounded; another unavailable output after the remaining re-runs ends publication.",
                  );
                return notPublished(
                  error.code,
                  error.reason,
                  {
                    expectedEntrypoint: error.expectedEntrypoint,
                    untrustedSignInOrigins: error.untrustedSignInOrigins,
                    ...(review === undefined ? {} : { review }),
                    diagnostic:
                      diagnostic._tag === "Right"
                        ? diagnostic.right
                        : "Publication diagnostic unavailable.",
                    repeatableRead,
                  },
                  (error.code === "ReviewDenied" && error.review?.reason === "evidence"
                    ? "Not published yet: Guardian needs more evidence to judge this publication, and the rationale names each missing item. Gather each one within your authority, such as running the live tests or cases it names so their results reach the test record, or exploring the site's own controls for a capture it names, and fix every finding, then call finish_build again. A retired failure in publication/tests.json clears only by a way its clearedBy lists: running the same cases again on the same source clears none. Missing evidence is not a refusal and never a reason for a policy block. The existing example and result remain recorded."
                    : error.code === "ReviewDenied" && error.review !== undefined
                      ? "Not published: Guardian blocked this publication. Each finding's explanation says what is wrong, the evidence and the fix, at its file and byte range. Fix every finding and each missing item the rationale names, then call finish_build again with the same executionId. The existing example and result remain recorded."
                      : "Not published. The existing example and result remain recorded. Source edits and another finish_build publication review may continue; this does not guarantee the failure is repairable.") +
                    " A fresh reviewed example read requires an available live host and host repeatableRead:true within the same input/account after confirmed executor cleanup. Otherwise never repeat the example or a write step that may have committed.",
                );
              }
              return yield* publicationResult(publication.right, coverage, assumptions);
            }).pipe(recordPublicationDecision),
          ),
        // One open request at a time: the execution permit is held while the caller decides.
        requestInput: (input) =>
          serial.withPermits(1)(
            Effect.gen(function* () {
              // Asking needs no live execution: it stays open after execution closed and while a
              // write's outcome is uncertain. The agent still verifies before writing again.
              yield* active("publication");
              if (setsOwnWords(input))
                return JSON.stringify({
                  status: "question_invalid",
                  reason: "own_words_are_the_hosts",
                  userInputRequired: false,
                  instruction:
                    "Remove allowOther and allowNote from every question and ask again: the host lets the caller answer every choice and multi_choice in their own words.",
                });
              const decoded = yield* decode(AgentRequest, input);
              // The marks stay the host's own: the caller reads a plain confirm, and Guardian is
              // told which held step a confirm question asks about.
              const endsBuild = endsBuildIds(decoded);
              const confirms = confirmsReviewMarks(decoded);
              const unheld = confirms.filter(
                ({ reviewId }) =>
                  !ledgerDenials.some(
                    (denial) => denial.review === "execution" && denial.reviewId === reviewId,
                  ),
              );
              if (unheld.length > 0 && !ledgerPartial)
                return JSON.stringify({
                  status: "question_refused",
                  reason: "confirms_unknown_review",
                  userInputRequired: false,
                  instruction: `confirmsReview names the reviewId of an execution step Guardian refused in this build, and ${unheld.map(({ reviewId }) => reviewId).join(", ")} is none. Set it to the reviewId from that step's review_rejected result, or leave it out, and ask again.`,
                });
              // A yes binds to the one review its question named: an id the owner already answered,
              // or one asked for another review, would let an earlier answer stand for this ask.
              const reused = confirms.filter(
                ({ questionId, reviewId }) =>
                  answeredQuestions.has(questionId) ||
                  (confirmAsks.get(questionId) ?? reviewId) !== reviewId,
              );
              if (reused.length > 0)
                return JSON.stringify({
                  status: "question_refused",
                  reason: "confirms_question_reused",
                  userInputRequired: false,
                  instruction: `A confirm question with confirmsReview needs an id of its own: ${reused.map(({ questionId }) => questionId).join(", ")} already holds an answer or asked about another refusal. Give it a new id and ask again.`,
                });
              const proposed = callerVisibleRequest(
                {
                  ...decoded,
                  questions: decoded.questions.map((question) => {
                    if (question.type !== "confirm") return question;
                    const { endsBuild: _mark, confirmsReview: _confirms, ...asked } = question;
                    return asked;
                  }),
                },
                redactCallerText,
              );
              const submitted = {
                ...proposed,
                questions: (effectQuestion
                  ? withEffectAnswerLabels(proposed.questions)
                  : proposed.questions
                ).map(withOwnWords),
              };
              const refusal = requestShapeRefusal(submitted);
              if (refusal !== undefined)
                return JSON.stringify({
                  status: "question_refused",
                  reason: refusal.reason,
                  userInputRequired: false,
                  instruction: refusal.instruction,
                });
              if (!dependencies.askInput)
                return yield* new MintFailure({
                  code: "Unavailable",
                  reason: "executor_unavailable",
                });
              // The capability question is the host's own, so it cannot collect private data. Every
              // request the agent writes, the effect question included, is reviewed before the
              // caller sees it: the caller may answer any of its choices in their own words.
              let reviewId: string | undefined;
              // One id from proposal on: its review, the request the caller sees and its end.
              const requestId = randomUUID();
              if (dependencies.capabilityQuestion === undefined) {
                if (!dependencies.reviewQuestion)
                  return yield* new MintFailure({
                    code: "ReviewUnavailable",
                    reviewFailure: "Unavailable",
                  });
                const review = yield* dependencies.reviewQuestion(submitted, {
                  requestId,
                  ...(yield* publicationRefusals),
                  ...decidedBuildEffect(),
                  ...(confirms.length === 0 ? {} : { confirms }),
                });
                yield* reviewCompleted;
                reviewId = review.reviewId;
                // When the question came relative to the work before it, without reading the
                // model's reasoning: how much ran first and whether sign-in was tried.
                const priorPurposes = [...purposes.values()];
                yield* reportBestEffort(
                  dependencies.diagnostics?.emit("mint.input_requested", {
                    requestId,
                    ...(reviewId === undefined ? {} : { reviewId }),
                    questionCount: submitted.questions.length,
                    reviewOutcome: review.outcome,
                    priorExecutions: priorPurposes.length,
                    priorLiveExecutions: executions.filter((entry) => entry.effect !== "not_sent")
                      .length,
                    ...(priorPurposes.at(-1) === undefined
                      ? {}
                      : { lastExecutionPurpose: priorPurposes.at(-1) }),
                    authenticateAttempted: priorPurposes.includes("authenticate"),
                  }) ?? Effect.void,
                  {
                    component: "mint",
                    operation: "diagnostics.emit",
                    phase: "mint.input_requested",
                    correlation: dependencies.reportCorrelation ?? "process",
                  },
                );
                const rationale = yield* screenMintText(dependencies, review.rationale);
                // A read-or-write choice never asks for a login, so a login verdict means reword it.
                if (review.outcome === "authentication" && !effectQuestion) {
                  // The build gave up signing in: nobody is asked for a login.
                  if (signInAbandoned)
                    return JSON.stringify({
                      status: "login_request",
                      login: "abandoned",
                      rationale,
                      userInputRequired: false,
                      instruction: signInAbandonedInstruction(buildEffect),
                    });
                  // The owner already declined to sign in: they are not asked again.
                  const login =
                    loginDeclined ??
                    (dependencies.requestLogin
                      ? yield* dependencies.requestLogin()
                      : ("unavailable" as const));
                  if (login === "supplied" || login === "held") loginHeld = true;
                  if (login === "no_account" || login === "public_only") {
                    loginDeclined = login;
                    // An earlier failed sign-in is no longer the minter's to resolve, so its
                    // guidance never contradicts the owner's answer.
                    unresolvedSignIn = undefined;
                    yield* diagnose({
                      phase: "sign_in",
                      reason: "login_declined",
                      declined: login,
                    });
                    return JSON.stringify({
                      status: "login_request",
                      login: "declined",
                      declined: login,
                      rationale,
                      userInputRequired: false,
                      instruction: loginDeclinedInstruction(login),
                    });
                  }
                  if (login === "in_use")
                    return JSON.stringify({
                      status: "login_request",
                      login,
                      code: loginInUseAnswer.code,
                      ...loginInUseAnswer.fields,
                      rationale,
                      userInputRequired: false,
                      instruction: loginInUseAnswer.notice,
                    });
                  return JSON.stringify({
                    status: "login_request",
                    login,
                    rationale,
                    userInputRequired: false,
                    instruction: loginRequestInstruction(login),
                  });
                }
                // The read-or-write question is the turn's only move, so it is never withdrawn.
                if (review.outcome !== "allow_business")
                  return JSON.stringify({
                    status: "question_rejected",
                    rationale,
                    userInputRequired: false,
                    instruction: effectQuestion
                      ? "Reword the question using the rationale and call request_input again. This read-or-write question is required, and no other tool opens until the person answers it. The host sets its two answer labels, so change only the prompt."
                      : "Reword the question using the rationale, or withdraw it and continue. Do not ask again for a value you were already given or that the site shows. A reworded question is reviewed again.",
                  });
              }
              for (const { questionId, reviewId } of confirms) confirmAsks.set(questionId, reviewId);
              askingId = requestId;
              askingEndsBuild = endsBuild.size > 0;
              handedBackQuestion = undefined;
              const answers = yield* dependencies.askInput(submitted, {
                requestId,
                ...(reviewId === undefined ? {} : { reviewId }),
              });
              return yield* inputResult(submitted, answers, endsBuild);
            }).pipe(
              Effect.catchIf(
                (error) => error.noResponse !== undefined,
                (error) => questionUnanswered(error, askingId, askingEndsBuild),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  askingId = undefined;
                  askingEndsBuild = false;
                }),
              ),
              // error-reporting-allow: typed-recovery an invalid request is the model's to correct, told as its result
              Effect.catchIf(
                (error) => error.code === "InvalidRequest",
                () =>
                  Effect.succeed(
                    JSON.stringify({
                      status: "question_invalid",
                      userInputRequired: false,
                      instruction:
                        "The request was not valid: use unique lowercase question ids, unique option ids, at most eight questions and selection bounds that fit the options. Correct it and ask again.",
                    }),
                  ),
              ),
              Effect.catchIf(
                (error) => error.code === "ReviewUnavailable",
                (error) =>
                  diagnose({
                    phase: "question_review",
                    code: failureCode(error),
                    reviewFailure: error.reviewFailure,
                    reviewPhase: error.reviewPhase,
                  }).pipe(
                    Effect.zipRight(
                      reviewUnavailableRetry("question", () =>
                        Effect.sync(() => {
                          terminal ??= {
                            build: "incomplete",
                            hostFailure: "review_unavailable",
                            summary:
                              "The proposed question could not be reviewed. No user input request was created; prior execution outcomes remain retained.",
                          };
                          return JSON.stringify({
                            status: "question_review_unavailable",
                            code: "ReviewUnavailable",
                            userInputRequired: false,
                            instruction:
                              "Question review is unavailable. End this attempt; do not ask the question in prose or resubmit execution.",
                          });
                        }),
                      )(error),
                    ),
                  ),
              ),
            ),
          ),
        // The minter's own ending for a task impossible as asked: a
        // terminal outcome distinct from failure, with a typed reason and a screened explanation
        // its caller reads. It runs nothing and holds the permit only to order it with the rest.
        ...(questionOnly
          ? {}
          : {
              reportBlocked: (input: unknown) =>
                serial.withPermits(1)(
                  Effect.gen(function* () {
                    yield* active("publication");
                    const report = yield* decode(BlockedReport, input);
                    // The host's own end, not the task's: no explanation reaches the caller, so
                    // none is reviewed, and the outcome names the host's cause.
                    if (report.reason === "host_unavailable") {
                      if (!hostIsUnavailable())
                        return JSON.stringify({
                          status: "blocked_refused",
                          reason: "host_available",
                          userInputRequired: false,
                          instruction:
                            "The host still offers live execution, so host_unavailable does not apply. Run what the build needs, such as the example again, then call finish_build.",
                        });
                      terminal ??= unavailableHostTerminal();
                      yield* diagnose({ phase: "blocked", reason: "host_unavailable" });
                      return JSON.stringify({
                        status: "host_unavailable",
                        notice:
                          "The build ended because the host has no live execution for what it still needs. It ends as the host's failure, not as blocked; nothing more runs in this attempt.",
                      });
                    }
                    // Sign-in is unavailable in this build, and a retained receipt held its
                    // ending back: the minter stops, and the build ends with the sign-in's own
                    // result, which names the cause better than any blocked reason.
                    const endedForSignIn = JSON.stringify({
                      status: "sign_in_unavailable",
                      notice:
                        "Sign-in is unavailable in this build, so it ends with that result and its cause instead of a blocked reason; nothing more runs in this attempt.",
                    });
                    if (signInUnavailable !== undefined) {
                      terminal ??= signInUnavailable.outcome;
                      yield* diagnose({ phase: "blocked", reason: "sign_in_unavailable" });
                      return endedForSignIn;
                    }
                    const explanation = redactCallerText(
                      yield* screenMintText(dependencies, report.explanation),
                    );
                    // Read only for a report that may stand on it.
                    const liveTestsRefusal =
                      report.reason === "host_refused"
                        ? yield* liveTestsRefusedForDenial
                        : undefined;
                    const ending = blockedEnding(
                      report.reason,
                      explanation,
                      yield* Clock.currentTimeMillis,
                      liveTestsRefusal,
                      report.intent,
                    );
                    if ("refusal" in ending) return ending.refusal;
                    // An ending the checks above accepted, while the build's latest sign-in
                    // never confirmed, or while the only refusal on record is Guardian's final
                    // refusal of a sign-in step: the site never got as far as judging the task, so it
                    // cannot have declined it or lacked it, and a policy or host check that
                    // stopped it stopped a sign-in. With no failed sign-in pending, whose own
                    // refusal above asks the agent to resolve it, the build ends as sign-in
                    // unavailable, worded by what the host saw, and its caller is never told to
                    // change the request. The owner's own no, a question they left unanswered and
                    // their choice to end the build keep their endings, a policy report renamed to
                    // one included. A host refusal a later finish_build got past is still a
                    // refusal on record.
                    // A host_refused report keeps its reason when a host check stopped the build
                    // apart from the sign-in (`hostRefusalApartFromSignIn`), such as a sign-in
                    // screen refused at its destination after the login went out. One that stands
                    // only on what may follow from the unconfirmed sign-in, such as a refused
                    // refill or a publication of a recipe nothing verified, ends as sign-in
                    // unavailable, its record naming the checks.
                    const hostRefusals = "hostRefusals" in ending ? ending.hostRefusals : undefined;
                    if (
                      ending.reason !== "owner_declined" &&
                      ending.reason !== "question_unanswered" &&
                      ending.reason !== "owner_ended" &&
                      !("apartFromSignIn" in ending && ending.apartFromSignIn === true) &&
                      (signInUnconfirmed ||
                        (signInRefusalOnly && !hostRefused && !hostRefusalPassed)) &&
                      unresolvedSignIn === undefined &&
                      loginDeclined === undefined &&
                      !signInAbandoned
                    ) {
                      const sessionLoss = dependencies.signInSessionLoss?.();
                      terminal ??= {
                        build: "incomplete",
                        recoveryReason: "sign_in_unavailable",
                        summary: signInUnavailableSummary(undefined, undefined, sessionLoss),
                      };
                      yield* diagnose({
                        phase: "blocked",
                        reason: "sign_in_unavailable",
                        reported: report.reason,
                        ...(hostRefusals === undefined ? {} : { hostRefusals }),
                        ...(sessionLoss === undefined ? {} : { sessionLoss }),
                      });
                      return endedForSignIn;
                    }
                    const submitted = { ...report, reason: ending.reason };
                    const review = yield* reviewBlockedExplanation(explanation);
                    yield* active("publication");
                    if (review.outcome === "retry")
                      return reviewUnavailableAnswer(
                        review.error,
                        "Guardian could not review the explanation, so the build has not ended and nothing reached the caller. Call report_blocked again for a fresh review. If Guardian stays unavailable long enough, the build ends blocked and the caller reads only the reason's fixed sentence.",
                        { next: { retryable: true } },
                      );
                    // Guardian asked for other words: the agent revises or withdraws its
                    // explanation, and the build goes on. A reword never ends a build.
                    if (review.outcome !== "allow_business" && review.outcome !== "unavailable") {
                      yield* diagnose({
                        phase: "blocked",
                        reason: submitted.reason,
                        explanationReview: review.outcome,
                      });
                      return JSON.stringify({
                        status: "blocked_explanation_rejected",
                        reason: submitted.reason,
                        rationale: yield* screenRationale(review.rationale),
                        userInputRequired: false,
                        instruction:
                          "Guardian did not allow this explanation to reach the caller, so the build has not ended. Revise the explanation using the rationale and call report_blocked again, which is reviewed again, or withdraw it and continue the build.",
                      });
                    }
                    // The owner may still answer the question the minter gave up on: the host
                    // may suspend the build to resume with it, and the report never returns.
                    if (
                      submitted.reason === "question_unanswered" &&
                      handedBackQuestion !== undefined
                    )
                      yield* suspendUnanswered(
                        {
                          step: "question",
                          requestId: handedBackQuestion,
                          possibleCommit: possibleCommit(),
                        },
                        "suspendHandedBack",
                      );
                    const shown = review.outcome === "allow_business";
                    const blocked = {
                      reason: submitted.reason,
                      ...(shown ? { explanation } : {}),
                    };
                    // A report that stood on refused live tests names them and the standing
                    // denial; the outcome keeps the denial's reason and category.
                    const basis = "basis" in ending ? ending.basis : undefined;
                    const denialParts = [publicationDenial?.reason, publicationDenial?.category]
                      .filter((part) => part !== undefined)
                      .join(", ");
                    const spentTests =
                      basis === "live_tests_spent"
                        ? ` The host runs no further live test batch in this attempt, and Guardian's denial of the last publication${denialParts === "" ? "" : ` (${denialParts})`} still stands.`
                        : "";
                    // The summary carries the explanation only where the caller may read it.
                    terminal = {
                      build: "incomplete",
                      blocked,
                      summary: shown
                        ? `The build is blocked (${blocked.reason}): ${explanation}${spentTests}`
                        : `The build is blocked (${blocked.reason}).${spentTests}`,
                    };
                    yield* diagnose({
                      phase: "blocked",
                      reason: blocked.reason,
                      ...(basis === undefined ? {} : { basis }),
                      ...(hostRefusals === undefined ? {} : { hostRefusals }),
                      explanationReview: review.outcome,
                    });
                    return JSON.stringify({
                      status: "blocked",
                      reason: blocked.reason,
                      explanationShown: shown,
                      notice: shown
                        ? "The build ended blocked. Its caller reads the reason and your explanation; nothing more runs in this attempt."
                        : "The build ended blocked. Guardian could not review your explanation, so the caller reads only the reason's fixed sentence; nothing more runs in this attempt.",
                    });
                  }),
                ),
            }),
        // The minter's change to the task's settings, once the caller confirmed it. It runs
        // nothing on the site and holds the permit only to order it with the rest.
        ...(questionOnly ||
        dependencies.reviewTaskUpdate === undefined ||
        dependencies.applyTaskUpdate === undefined
          ? {}
          : {
              updateTask: (input: unknown) =>
                serial.withPermits(1)(
                  Effect.gen(function* () {
                    yield* active("publication");
                    const decoded = yield* Effect.either(decode(TaskUpdateRequest, input));
                    if (decoded._tag === "Left")
                      return taskUpdateAnswer("update_invalid", {
                        instruction:
                          "The update was not valid: give a summary, one to eight changes, the ids of the answered questions that confirm it in confirmedBy (empty when the request already settles the change), and recommend update or new_mint. Correct it and call mint_update again.",
                      });
                    const submitted = decoded.right;
                    if (
                      submitted.recommend === "new_mint" &&
                      submitted.suggestedRequest === undefined
                    )
                      return taskUpdateAnswer("update_invalid", {
                        instruction:
                          "A recommended new build needs suggestedRequest: the request the caller could submit for it, in one or two plain sentences. Add it and call mint_update again.",
                      });
                    // The same update again, as after a takeover, is already applied.
                    if (taskState.updates.at(-1)?.requestDigest === taskUpdateDigest(submitted))
                      return yield* updatedAnswer(
                        submitted.changes,
                        "This update was already applied; nothing changed again.",
                      );
                    const refusal = taskUpdateRefusal(submitted);
                    if (refusal !== undefined) return taskUpdateAnswer("update_refused", refusal);
                    let askedConfirmer: TaskUpdateConfirmer | undefined;
                    if (request.mode === "maintenance" &&
                      !keepsContract(submitted, addedOutputFields(taskState.updates))) {
                      // Only the tool's owner confirms a change that takes from the registered
                      // contract; adding or tightening an output field takes nothing away.
                      const confirmer = yield* maintenanceConfirmer;
                      askedConfirmer = confirmer;
                      if (confirmer !== "owner" && confirmer !== "owner_request")
                        return taskUpdateAnswer("update_refused", {
                          reason: "owner_unavailable",
                          instruction:
                            "No one who owns this tool can confirm a change that loosens or removes an output, or changes a requirement or the purpose, now, so nothing changed. Keep the registered contract (adding or tightening a field needs no confirmation). Prefer leaving out the part of the request that needs this change: remove any code or output field you added only for it, publish the rest, and name the part you left out in coverage. End with report_blocked, reason site_lacks_capability, naming the field, only when no part of the request can be published.",
                        });
                      // The owner's own request may confirm what it names, which Guardian judges.
                      if (confirmer === "owner" && submitted.confirmedBy.length === 0)
                        return taskUpdateAnswer("clarification_required", {
                          source: "host",
                          reason: "confirmation_required",
                          instruction:
                            "A change to the published tool's contract needs its owner's confirmation, and nothing changed. Ask with request_input, naming the change and what the site no longer shows, then call mint_update again naming the questions answered in confirmedBy.",
                        });
                    }
                    if (
                      submitted.recommend === "update" &&
                      submitted.confirmedBy.length === 0 &&
                      submitted.changes.some(
                        (change) =>
                          change.setting === "site" ||
                          change.setting === "login" ||
                          change.setting === "effect",
                      )
                    )
                      return taskUpdateAnswer("clarification_required", {
                        source: "host",
                        reason: "confirmation_required",
                        instruction:
                          "A change of the site, the login or the effect widens what this build may do, so it needs the caller's confirmation and nothing changed. Ask the caller with request_input, then call mint_update again naming the questions they answered in confirmedBy.",
                      });
                    const unanswered = submitted.confirmedBy.filter(
                      (id) => !answeredQuestions.has(id),
                    );
                    if (unanswered.length > 0)
                      return taskUpdateAnswer("clarification_required", {
                        source: "host",
                        unanswered,
                        instruction:
                          "confirmedBy names questions the caller has not answered in this build, so nothing confirms the update and nothing changed. Ask the caller with request_input, then call mint_update again naming the questions they answered.",
                      });
                    return yield* reviewAndApplyTaskUpdate(submitted, askedConfirmer);
                  }).pipe(
                    Effect.catchIf(
                      (error) => error.code === "ReviewUnavailable",
                      (error) =>
                        diagnose({
                          phase: "task_update_review",
                          code: failureCode(error),
                          reviewFailure: error.reviewFailure,
                          reviewPhase: error.reviewPhase,
                        }).pipe(
                          Effect.zipRight(
                            reviewUnavailableRetry("update", () =>
                              Effect.sync(() => {
                                terminal ??= {
                                  build: "incomplete",
                                  hostFailure: "review_unavailable",
                                  summary:
                                    "The proposed task update could not be reviewed, so the task did not change. Prior execution outcomes remain retained.",
                                };
                                return taskUpdateAnswer("review_unavailable", {
                                  code: "ReviewUnavailable",
                                  instruction:
                                    "Task update review is unavailable. End this attempt; the task did not change.",
                                });
                              }),
                            )(error),
                          ),
                        ),
                    ),
                  ),
                ),
            }),
        // Read-only provider state. It takes no execution permit, dispatches no browser
        // action and grants no authority; unsupported hosts do not offer the tool.
        ...(dependencies.captchaState === undefined || questionOnly
          ? {}
          : {
              captchaState: (input: unknown) => {
                const read = dependencies.captchaState;
                return Effect.gen(function* () {
                  if (read === undefined) return yield* new MintFailure({ code: "Unavailable" });
                  yield* active();
                  yield* decode(Schema.Struct({}), input);
                  if (captchaChecks >= read.limit)
                    return JSON.stringify({ kind: "host_captcha_state", ...read.exhausted });
                  captchaChecks += 1;
                  const state = yield* read.read();
                  return JSON.stringify({ kind: "host_captcha_state", ...state });
                });
              },
            }),
        // A troubleshooting request for a new browser. It holds the execution permit, so
        // no execution runs while the browser changes, and it is never part of the published tool.
        ...(dependencies.requestBrowserRecovery === undefined || questionOnly
          ? {}
          : {
              requestBrowserRecovery: (input: unknown) =>
                serial.withPermits(1)(
                  Effect.gen(function* () {
                    const request = dependencies.requestBrowserRecovery;
                    if (request === undefined)
                      return yield* new MintFailure({ code: "Unavailable" });
                    yield* active();
                    const { rationale } = yield* decode(
                      Schema.Struct({
                        rationale: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4000)),
                      }),
                      input,
                    );
                    return JSON.stringify({
                      kind: "host_browser_recovery",
                      ...(yield* request(rationale)),
                    });
                  }),
                ),
            }),
        // The minter gives up signing in, so the build goes on signed out. The host decides
        // whether it may; Guardian does not review it. It holds the execution permit, ordered
        // with the steps around it.
        ...(dependencies.abandonSignIn === undefined || questionOnly
          ? {}
          : {
              abandonSignIn: (_input: unknown) =>
                serial.withPermits(1)(
                  Effect.gen(function* () {
                    const abandon = dependencies.abandonSignIn;
                    if (abandon === undefined)
                      return yield* new MintFailure({ code: "Unavailable" });
                    yield* active();
                    const result = yield* abandon();
                    yield* diagnose({
                      phase: "sign_in",
                      reason: "abandon_sign_in",
                      outcome: result.outcome,
                      ...(result.outcome === "refused" ? { refusal: result.reason } : {}),
                    });
                    if (result.outcome === "refused")
                      return JSON.stringify({
                        status: "abandon_sign_in_refused",
                        reason: result.reason,
                        ...(result.notice === undefined
                          ? {}
                          : { notice: yield* screenMintText(dependencies, result.notice) }),
                        userInputRequired: false,
                        instruction:
                          "The host did not let this build give up signing in, so nothing changed. Resolve the sign-in as its last result says, or end the build if nothing can.",
                      });
                    unresolvedSignIn = undefined;
                    signInAbandoned = true;
                    return JSON.stringify({
                      status: "sign_in_abandoned",
                      userInputRequired: false,
                      instruction: signInAbandonedInstruction(buildEffect),
                    });
                  }),
                ),
            }),
        // The agent tests a signed-in marker before it sends it. The host may reload the page,
        // so the check holds the execution permit; it signs nothing in and sends no value. A host
        // without the check says so, and the agent compares the pages itself.
        ...(questionOnly
          ? {}
          : {
              checkSignedInMarker: (input: unknown) =>
                serial.withPermits(1)(
                  Effect.gen(function* () {
                    yield* active();
                    const marker = yield* decode(SignedInMarkerCheckRequest, input);
                    const check = dependencies.checkSignedInMarker;
                    if (check === undefined)
                      return JSON.stringify({
                        kind: "host_signed_in_marker",
                        status: "unavailable",
                        notice:
                          "This host cannot test a marker. Confirm yourself that it is absent on the signed-out pages you explored before signing in, and present on the signed-in page and on another page you visited signed in.",
                      });
                    const result = yield* check(marker);
                    const verdict = validateSignedInMarker({ marker, check: result });
                    return JSON.stringify({
                      kind: "host_signed_in_marker",
                      // A pass the signed-out page could not confirm is not a plain pass.
                      status: !verdict.accepted
                        ? "refused"
                        : result.signedOutSnapshot === "unchecked"
                          ? "passed_unchecked"
                          : "passed",
                      ...result,
                      ...(verdict.accepted ? {} : { refusals: verdict.refusals }),
                      ...(verdict.warnings.length === 0 ? {} : { warnings: verdict.warnings }),
                    });
                  }),
                ),
            }),
        // A read's live tests: the cases the agent designed and their results, and batches
        // run in parallel browsers after one Guardian review. It holds the execution permit, since
        // a batch uses the build's own browser too.
        ...(dependencies.liveTests === undefined || questionOnly
          ? {}
          : {
              liveTests: (input: unknown) =>
                serial.withPermits(1)(
                  Effect.gen(function* () {
                    yield* active();
                    const request = yield* decode(LiveTestsRequest, input);
                    yield* Effect.try({
                      try: () => relativeSourcePath(request.entrypoint),
                      catch: () => new MintFailure({ code: "ScopeDenied" }),
                    });
                    if (!liveTestsOffered())
                      return JSON.stringify({
                        kind: "host_live_tests",
                        status: "unavailable",
                        instruction:
                          buildEffect === "write"
                            ? "A write build runs no live tests: its act session is the one run that proves it. Compose the script from the session and publish."
                            : "This read signed in, and this host runs no signed-in live tests, so its example alone proves the tool. Check src/tool-http.mjs once against the example's input, if you wrote one (execute purpose test, target liveBrowser, no testInput), run the example last, after your last edit, and publish.",
                      });
                    if (request.action === "plan")
                      return JSON.stringify(
                        yield* liveTestPlanView(request.entrypoint, {
                          show: request.cases ?? [],
                        }),
                      );
                    return yield* runLiveTests(request);
                  }),
                ),
            }),
      };
      /** The minter's history from before a compaction, which its run state no longer holds. */
      const historyArchive =
        dependencies.outcomeReview?.historyArchive === undefined
          ? memoryHistoryArchive()
          : bufferedHistoryArchive(dependencies.outcomeReview.historyArchive, (error) =>
              Effect.sync(() => {
                diagnostics.push(
                  JSON.stringify({
                    phase: "diagnostics",
                    reason: "history_archive_gap",
                    code: error.code,
                  }),
                );
              }),
            );
      /** What the minter's run state holds, which the model registers before its first request. */
      let liveHistory: (() => LiveMinterHistory) | undefined;
      /** Done once the model registered its run state, or ended without doing so. */
      const historyRegistered = yield* Deferred.make<void>();
      /** Each piece of the harness's evidence as the outcome reviewer reads it. */
      const recordChunk = (ref: string, text: string, range: { offset: number; limit: number }) => {
        const end = Math.min(text.length, range.offset + range.limit);
        return {
          ref,
          text: text.slice(range.offset, end),
          offset: range.offset,
          total: text.length,
          nextOffset: end < text.length ? end : null,
        };
      };
      /** A workspace file through the minter's own screened source read. */
      const workspaceChunk = (
        ref: string,
        path: string,
        range: { offset: number; limit: number },
      ) =>
        actions
          .readSource(path, { offset: range.offset, limit: Math.min(range.limit, 64_000) })
          .pipe(
            Effect.map((read) => {
              const chunk = decodeJsonObject(read);
              if (chunk._tag === "Left") return undefined;
              const source = chunk.right["source"];
              const total = chunk.right["total"];
              const next = chunk.right["nextOffset"];
              return typeof source !== "string" || typeof total !== "number"
                ? undefined
                : {
                    ref,
                    text: source,
                    offset: range.offset,
                    total,
                    nextOffset: typeof next === "number" ? next : null,
                  };
            }),
            // A file the workspace does not hold is a record the reviewer cannot read, not a failure.
            Effect.catchAll(() => Effect.succeed(undefined)),
          );
      const executionRecord = (entry: ExecutionEvidence) => ({
        ...entry,
        purpose: purposes.get(entry.executionId),
        ...(entrypoints.has(entry.executionId)
          ? { entrypoint: entrypoints.get(entry.executionId) }
          : {}),
        note: "The screened result the minter received is in its history: search_history for this executionId.",
      });
      const baseEvidence: OutcomeEvidence = {
        list: (kind) =>
          Effect.gen(function* () {
            if (kind === "execution")
              return executions.map((entry) => ({
                ref: `execution:${entry.executionId}`,
                kind,
                summary: JSON.stringify({
                  purpose: purposes.get(entry.executionId),
                  action: entry.review?.action,
                  status: entry.status,
                  effect: entry.effect,
                  confirmation: entry.confirmation,
                }),
              }));
            if (kind === "source")
              return [...new Set(entrypoints.values())].map((path) => ({
                ref: `source:${path}`,
                kind,
                summary:
                  "An entrypoint an execution ran; read any other workspace path the same way.",
              }));
            if (kind === "capture") {
              const index = yield* workspaceChunk(
                "capture:captures/index.json",
                "captures/index.json",
                {
                  offset: 0,
                  limit: 1,
                },
              );
              return index === undefined
                ? []
                : [
                    {
                      ref: "capture:captures/index.json",
                      kind,
                      summary: "The capture index; read it for the screened captures it lists.",
                    },
                  ];
            }
            return publications.map((_publication, index) => ({
              ref: `publication:${index + 1}`,
              kind,
              summary: "A finish_build result as the minter received it.",
            }));
          }),
        read: (ref, range) =>
          Effect.suspend(() => {
            const separator = ref.indexOf(":");
            const kind = ref.slice(0, separator);
            const id = ref.slice(separator + 1);
            if (separator < 1 || id === "") return Effect.succeed(undefined);
            if (kind === "execution") {
              const entry = executions.find((candidate) => candidate.executionId === id);
              return Effect.succeed(
                entry === undefined
                  ? undefined
                  : recordChunk(ref, JSON.stringify(executionRecord(entry)), range),
              );
            }
            if (kind === "publication") {
              const publication = publications[Number(id) - 1];
              return Effect.succeed(
                publication === undefined ? undefined : recordChunk(ref, publication, range),
              );
            }
            if (kind === "source" || (kind === "capture" && id.startsWith("captures/")))
              return workspaceChunk(ref, id, range);
            return Effect.succeed(undefined);
          }),
        task: () =>
          Effect.succeed({
            request: initialPrompt,
            answers: [...acceptedAnswers],
            state: {
              // The effective task after confirmed updates, in its screened form.
              task: {
                revision: taskState.revision,
                effect: taskState.effect,
                ...(taskState.siteOrigin === undefined ? {} : { siteOrigin: taskState.siteOrigin }),
                updates: taskState.updates,
              },
              buildEffect,
              writeSession,
              exampleClaimed,
              executionClosed,
              published: terminal?.build === "published",
            },
          }),
      };
      const reviewer = yield* makeOutcomeReviewer({
        host: dependencies.outcomeReview,
        evidence: dependencies.outcomeReview?.evidence?.(baseEvidence) ?? baseEvidence,
        history: minterHistory(
          historyArchive,
          () => liveHistory?.(),
          Deferred.await(historyRegistered),
        ),
        ...(recovered?.outcomeWrites === undefined
          ? {}
          : { recoveredWrites: recovered.outcomeWrites }),
      });
      dependencies.outcomeReview?.bindWrites?.(reviewer.outcomes);
      /** The outcome reviewer's readback requests, beside the host's own notices. */
      const drainNotices = () => {
        const notices = [
          ...(dependencies.drainHostNotices?.() ?? []),
          ...reviewer.observationRequests().map((observation) => ({
            kind: "outcome_review_observation",
            ...observation,
            instruction:
              "The outcome reviewer asks for this readback to settle whether that write changed the site. When it can be read without changing anything, run it as a read step; never repeat the write to answer it.",
          })),
        ];
        return notices.length === 0 ? undefined : notices;
      };
      const published = () => terminal?.build === "published";
      // Any call through the turn's actions but a question or a blocked report is work after the
      // owner's latest answer, so `owner_ended` no longer stands on it. Cleared before and after, so
      // a call queued behind the question still counts. Sandbox commands and file edits are not
      // actions and leave it as it is.
      const working =
        <A extends readonly unknown[]>(
          action: (...args: A) => Effect.Effect<string, MintFailure>,
        ) =>
        (...args: A) =>
          Effect.suspend(() => {
            ownerAnsweredLast = false;
            return action(...args);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ownerAnsweredLast = false;
              }),
            ),
          );
      const reviewedActions: MintActions = {
        ...actions,
        ...(actions.retainCapture === undefined
          ? {}
          : { retainCapture: working(actions.retainCapture) }),
        readSource: working(actions.readSource),
        execute: working(actions.execute),
        requestInput: (input) =>
          Effect.suspend(() => {
            ownerAnsweredLast = false;
            return actions.requestInput(input);
          }),
        ...(actions.updateTask === undefined ? {} : { updateTask: working(actions.updateTask) }),
        ...(actions.captchaState === undefined
          ? {}
          : { captchaState: working(actions.captchaState) }),
        ...(actions.liveTests === undefined ? {} : { liveTests: working(actions.liveTests) }),
        ...(actions.requestBrowserRecovery === undefined
          ? {}
          : { requestBrowserRecovery: working(actions.requestBrowserRecovery) }),
        ...(actions.checkSignedInMarker === undefined
          ? {}
          : { checkSignedInMarker: working(actions.checkSignedInMarker) }),
        ...(actions.abandonSignIn === undefined
          ? {}
          : { abandonSignIn: working(actions.abandonSignIn) }),
        // A published build with a write unresolved gives the reviewer its last turn;
        // publication itself never waits for it.
        finish: (input) =>
          working(actions.finish)(input).pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                publications.push(result);
              }),
            ),
            // Only a published build gives the reviewer its final turn; a refused publication
            // leaves the minter working and the reviewer on its ordinary turns.
            Effect.tap(() => (published() ? reviewer.finishing : Effect.void)),
          ),
      };
      const hostIncidentsBeforeStart = yield* dependencies.drainStartIncidents?.() ??
        Effect.succeed(undefined);
      const retainRuntimeRecord = dependencies.diagnostics?.retainRuntimeRecord;
      const observeModelTrace = dependencies.diagnostics?.observeModelTrace;
      /** The harness checkpoint, with `task` as its effective task. */
      /** One version's results for the checkpoint, under `field`, or nothing when it has none. */
      const liveTestsCheckpoint = (
        version: LiveTestVersion,
        field: "liveTests" | "liveTestsHttp",
      ): Partial<MintHarnessSnapshot> => {
        const records = [
          ...liveTestReplaced.filter((record) => liveTestVersion(record.entrypoint) === version),
          ...liveTestRecords[version].values(),
        ];
        return records.length === 0 ? {} : { [field]: records };
      };
      const captureHarness = (task: TaskState = taskState): MintHarnessSnapshot => ({
        executions: [...executions],
        // Replaced failures come first, so an older worker that keys records by id keeps the
        // latest. The HTTP version's results go in their own field, which an older worker drops.
        ...liveTestsCheckpoint("playwright", "liveTests"),
        ...liveTestsCheckpoint("http", "liveTestsHttp"),
        ...(liveTestsOutOfTime ? { liveTestsOutOfTime: true } : {}),
        ...(signedInTestInputs.length === 0 ? {} : { signedInTestInputs: [...signedInTestInputs] }),
        ...(reviewer.tracked().length === 0 ? {} : { outcomeWrites: reviewer.tracked() }),
        purposes: [...purposes].map(([executionId, purpose]) => {
          const taskRevision = revisions.get(executionId);
          return { executionId, purpose, ...(taskRevision === undefined ? {} : { taskRevision }) };
        }),
        diagnostics: [...diagnostics],
        ...(example === undefined ? {} : { exampleId: example.executionId }),
        // A build becoming a write leaves its read example's claim behind.
        ...(task.effect === "write" && buildEffect !== "write"
          ? { exampleClaimed: false, writeSession: "none" as const }
          : { exampleClaimed, writeSession }),
        unavailableOutputRefusals,
        ...(terminal === undefined ? {} : { terminal }),
        ...(noResponse === undefined ? {} : { noResponse }),
        unavailableCauseRecorded,
        reviewUnavailableRetries: { ...reviewUnavailableRetries },
        ...(reviewOutageStartedAt === undefined ? {} : { reviewOutageStartedAt }),
        ...(invalidOutcomes === 0 ? {} : { invalidOutcomes }),
        decisionLedger: {
          denials: [...ledgerDenials],
          ...(omittedLedgerDenials === 0 ? {} : { omittedDenials: omittedLedgerDenials }),
          ...(ledgerPartial ? { partial: true as const } : {}),
        },
        ...(blockedReviewUnavailable ? { blockedReviewUnavailable: true as const } : {}),
        ...(guardianRefused ? { guardianRefused: true as const } : {}),
        ...(signInRefusalOnly ? { signInRefusalOnly: true as const } : {}),
        ...(hostRefused ? { hostRefused: true as const } : {}),
        ...(hostRefused && standingHostRefusals.length > 0
          ? {
              hostRefusalSources: standingHostRefusals.map(({ refusal, beforeSignIn }) => ({
                ...(refusal === undefined ? {} : { refusal }),
                ...(beforeSignIn ? { beforeSignIn: true as const } : {}),
              })),
            }
          : {}),
        ...(hostRefusalPassed ? { hostRefusalPassed: true as const } : {}),
        ...(signInDestinationRefused ? { signInDestinationRefused: true as const } : {}),
        ...(noAnswerHandBacks === 0 ? {} : { noAnswerHandBacks }),
        ...(loginHeld ? { loginHeld: true as const } : {}),
        ...(loginDeclined === undefined ? {} : { loginDeclined }),
        ...(signInAbandoned ? { signInAbandoned: true as const } : {}),
        ...(signInUnconfirmed ? { signInUnconfirmed: true as const } : {}),
        destinationEvidenceRefusals,
        inputFeedbackRounds,
        inputFeedbackPublicTool,
        inputFeedbackCoverage,
        providerUnavailableRetries,
        ...(providerOutageStartedAt === undefined ? {} : { providerOutageStartedAt }),
        // Deprecated and unread; written only so an older worker can restore this checkpoint.
        diagnosticRetentionRetries: 0,
        executionClosed,
        captchaChecks,
        ...(task.revision === 0 ? {} : { taskState: task }),
        ...(answeredQuestions.size === 0
          ? {}
          : {
              answeredQuestions: [...answeredQuestions].map(([id, answer]) => ({ id, answer })),
            }),
        ...(signInUnavailable === undefined ? {} : { signInUnavailable }),
        ...(publicationDenial === undefined ? {} : { publicationDenial }),
        ...(inputFeedbackReview === undefined ? {} : { inputFeedbackReview }),
      });
      const agentRecovery = dependencies.agentRecovery;
      yield* agentRecovery?.bindHarness?.(captureHarness) ?? Effect.void;
      const modelResult = yield* dependencies.model
        .run({
          runTool,
          ...(agentRecovery === undefined
            ? {}
            : {
                recovery: {
                  ...(agentRecovery.recoverTool === undefined
                    ? {}
                    : {
                        recoverTool: (call) =>
                          Effect.gen(function* () {
                            const rejoined = yield* Effect.either(
                              agentRecovery.recoverTool?.(call) ?? Effect.succeed(undefined),
                            );
                            if (rejoined._tag === "Left") {
                              const error = rejoined.left;
                              if (call.name !== "request_input" || error.noResponse === undefined)
                                return yield* Effect.fail(error);
                              // A rejoined question that went unanswered, such as one that expired
                              // before the takeover, goes on as the live question would have.
                              return { result: yield* questionUnanswered(error, undefined, false) };
                            }
                            const recoveredTool = rejoined.right;
                            if (recoveredTool === undefined) return undefined;
                            if (recoveredTool.input !== undefined) {
                              const { request: asked, answers } = recoveredTool.input;
                              // The started call still holds the mark the host kept to itself.
                              const started = decodeAgentRequestJson(call.arguments);
                              const result = yield* inputResult(
                                asked,
                                answers,
                                started._tag === "Right" ? endsBuildIds(started.right) : new Set(),
                                call.name === "report_blocked",
                              );
                              return { result: recoveredTool.result ?? result };
                            }
                            if (recoveredTool.publication !== undefined) {
                              const result = yield* publicationResult(
                                recoveredTool.publication.published,
                                yield* screenMintText(
                                  dependencies,
                                  recoveredTool.publication.coverage,
                                ),
                                yield* screenAssumptions(recoveredTool.publication.assumptions),
                              );
                              return { result: recoveredTool.result ?? result };
                            }
                            const execution = recoveredTool.execution;
                            if (execution === undefined) return { result: recoveredTool.result };
                            const result = yield* recoveredExecutionResult(
                              execution.evidence,
                              execution.purpose,
                              submittedEntrypoint(call.arguments),
                            );
                            return { result: recoveredTool.result ?? result };
                          }),
                      }),
                  ...(agentRecovery.initial === undefined
                    ? {}
                    : {
                        initial: agentRecovery.initial.agent,
                        ...(agentRecovery.initial.resumeMessage === undefined
                          ? {}
                          : { resumeMessage: agentRecovery.initial.resumeMessage }),
                      }),
                  save: (agent) => agentRecovery.save(agent, captureHarness()),
                },
              }),
          ...(effectQuestion ? { effectQuestion: true as const } : {}),
          ...(dependencies.autofillSignIn ? { autofillSignIn: true as const } : {}),
          input: JSON.stringify({
            ...(effectQuestion
              ? { effectQuestion: { instruction: effectQuestionInstruction } }
              : {}),
            screenedRequest: dependencies.capabilityQuestion
              ? {
                  instruction:
                    "Ask exactly this question through request_input as one text question with this prompt. No other action is authorized until the answer is reassessed.",
                  question: dependencies.capabilityQuestion,
                }
              : prompt,
            businessInputTypes,
            site,
            ...changedEntryNotice(),
            hostIncidentsBeforeStart,
            executionContext: yield* executionContext(),
            websiteAuthentication: {
              credentialsAvailable: dependencies.websiteCredentialsAvailable === true,
              instruction:
                dependencies.websiteCredentialsAvailable === true
                  ? `Credential values are private host input. When the task needs the account (AGENTS.md, 'Sign in only when the task needs it'), discover the login entry, then call execute purpose authenticate with its loginUrl${dependencies.autofillSignIn ? " and a signInStep for each sign-in screen" : ""} before the business example. You cannot request credentials; if the site cannot be reached, report that instead of starting sign-in. Codes and other sign-in steps during authenticate go to the caller through the host: a text, email or authenticator code that is part of signing in is a code field of the signInStep, never a request_input question.`
                  : "No website credentials are bound to this invocation. If the requested operation works signed out, proceed with its business flow and example without discovering a login or calling authenticate. If the task needs an account or the site presents a login wall, discover the actual login entry and pass it as loginUrl to execute purpose authenticate before dependent business work; the host asks the caller for a login and continues within the same call. You cannot request credentials; if the site cannot be reached, report that instead of starting sign-in. Codes and other sign-in steps during authenticate go to the caller through the host: a text, email or authenticator code that is part of signing in is a code field of the signInStep, never a request_input question.",
            },
          }),
          ...(dependencies.deadline ? { deadline: dependencies.deadline } : {}),
          session,
          instructions: dependencies.instructions,
          ...(dependencies.staticContext === undefined
            ? {}
            : { staticContext: dependencies.staticContext }),
          ...(dependencies.promptCacheKey === undefined
            ? {}
            : { promptCacheKey: dependencies.promptCacheKey }),
          skills: dependencies.skills,
          ...(dependencies.hostToolDescriptions === undefined
            ? {}
            : { hostToolDescriptions: dependencies.hostToolDescriptions }),
          ...(dependencies.compactionSkillsNote === undefined
            ? {}
            : { compactionSkillsNote: dependencies.compactionSkillsNote }),
          actions: withHostNotices(
            dependencies.retainCapture === undefined
              ? (({ retainCapture: _capture, ...available }) => available)(reviewedActions)
              : reviewedActions,
            drainNotices,
          ),
          history: {
            archive: historyArchive,
            live: (read) => {
              liveHistory = read;
              Deferred.unsafeDone(historyRegistered, Exit.void);
            },
          },
          screen: (value) => screenMintText(dependencies, value),
          isComplete: () =>
            stopUnavailableHost() ||
            stopRevokedAttempt() ||
            terminal !== undefined ||
            modelStoppedForSignIn,
          reportTrace: (value, timing) => {
            const retained = (
              dependencies.diagnostics?.[timing !== undefined ? "retainModelTranscript" : "emit"](
                "mint.model",
                value,
                timing === undefined
                  ? undefined
                  : {
                      modelTiming: timing,
                      ...(observeModelTrace === undefined ? {} : { lifecycleObserved: true }),
                      // With traced records the readable copy is a projection: it is never
                      // dropped for ordinary diagnostics, and a failed write is a recorded gap.
                      ...(retainRuntimeRecord === undefined ? {} : { required: true }),
                    },
              ) ?? Effect.void
            ).pipe(Effect.mapError(diagnosticUnavailable));
            // Readable copies and trace events are diagnosis: a failed write is a recorded gap and
            // the build goes on. The raw record of each model call (`retainRuntimeRecord`) is the
            // required trace, and stays fail closed.
            return retained.pipe(Effect.catchAll(recordDiagnosticGap("mint.model")));
          },
          ...(retainRuntimeRecord === undefined
            ? {}
            : {
                retainRuntimeRecord: (record: RuntimeRecordInput) =>
                  retainRuntimeRecord(record).pipe(Effect.mapError(diagnosticUnavailable)),
              }),
          ...(observeModelTrace === undefined
            ? {}
            : {
                observeTrace: (timing: ModelDiagnosticTiming) => {
                  Effect.runFork(observeModelTrace("mint.model", timing));
                },
              }),
          reportDiagnostic: (value) =>
            screenMintText(dependencies, value).pipe(
              Effect.tap((safe) =>
                Effect.sync(() => {
                  diagnostics.push(safe);
                }),
              ),
              Effect.asVoid,
            ),
          unresolvedGuidance: () =>
            Effect.suspend(() => {
              // Sign-in is unavailable and the model answered without publishing its retained
              // receipt: the model stops here, never after more prompts. Its outcome is settled
              // after the model stops, in the usual order: a flagged input-feedback publication,
              // then the host's own stop, then the sign-in outcome.
              if (signInUnavailable !== undefined) {
                modelStoppedForSignIn = true;
                return Effect.succeed(undefined);
              }
              const pending = unresolvedSignIn;
              if (
                pending === undefined ||
                pending.guided ||
                terminal !== undefined ||
                stopUnavailableHost()
              )
                return Effect.succeed(undefined);
              pending.guided = true;
              return screenMintText(
                dependencies,
                unresolvedSignInGuidance(pending.failure, pending.spent),
              );
            }),
        })
        .pipe(
          Effect.exit,
          // A build the host suspended stops its model run here, before any further call starts.
          Effect.raceFirst(Deferred.await(suspended).pipe(Effect.as(undefined))),
          Effect.ensuring(
            Effect.sync(() => {
              modelRunEnded = true;
            }),
          ),
          Effect.ensuring(Scope.close(toolScope, Exit.void)),
          // A model that ended before registering its run state leaves the archive to read.
          Effect.ensuring(Deferred.done(historyRegistered, Exit.void)),
        );
      // Suspended to resume later: no outcome is decided or recorded, and the run ends interrupted.
      if (modelResult === undefined) return yield* Effect.interrupt;
      const modelFailure = Exit.isFailure(modelResult)
        ? Option.getOrUndefined(Cause.failureOption(modelResult.cause))
        : undefined;
      if (
        terminal === undefined &&
        (modelFailure?.diagnosticRetentionReason === "storage" ||
          modelFailure?.diagnosticRetentionReason === "serialization")
      ) {
        // A model call's raw record, the required trace, could not be retained, so the model
        // adapter blocked the next call: raw traces stay fail closed, while readable copies and
        // diagnostic retention are recorded gaps. Report the storage outcome, not a site or model
        // failure.
        terminal = {
          build: "incomplete",
          hostFailure: "diagnostic_retention",
          summary:
            "Required model trace retention failed, so the host stopped new model and tool work. Preserve recorded effects and receipts; this does not establish a website, browser or model failure.",
        };
        yield* diagnose({
          phase: "model_trace",
          code: modelFailure.code,
          diagnosticRetentionReason: modelFailure.diagnosticRetentionReason,
          diagnosticStorageFailure: modelFailure.diagnosticStorageFailure,
        });
      }
      // A minter that stopped without fixing Guardian's input feedback still publishes its last
      // reviewed candidate, privately and flagged, where the host has a fallback; without one the
      // build ends with the review's findings. Publication needs no browser or executor, but an
      // attempt that lost its lease publishes nothing.
      if (terminal === undefined && inputFeedbackRounds > 0 && !stopRevokedAttempt())
        yield* settleUnresolvedInputFeedback;
      // Background traffic can poison the host after the last tool call and completion check.
      // Name that cause instead of the generic stop, but never replace a terminal outcome.
      if (terminal === undefined) stopUnavailableHost(true);
      if (terminal === undefined) stopRevokedAttempt();
      // Sign-in stayed unavailable and the retained receipt never published.
      if (terminal === undefined && signInUnavailable !== undefined)
        terminal = signInUnavailable.outcome;
      // Live execution ended and the model stopped without publishing its retained receipt.
      if (terminal === undefined && executionClosed) terminal = unavailableHostTerminal();
      if (
        terminal === undefined &&
        Exit.isSuccess(modelResult) &&
        modelResult.value.stopReason === "repeated_final_without_tool"
      ) {
        const stopExplanation = yield* reviewedStopExplanation(modelResult.value.finalText);
        terminal = {
          build: "incomplete",
          stopReason: "final_text_without_tool",
          ...(stopExplanation === undefined ? {} : { stopExplanation }),
          summary:
            "The minter kept answering without a tool call after the host asked it to continue, so the host ended this attempt. No build was published. Recorded effects and receipts are preserved.",
        };
        yield* diagnose({
          phase: "continuation",
          reason: "repeated_final_without_tool",
          explanationShown: stopExplanation !== undefined,
        });
      }
      if (terminal === undefined && modelFailure?.modelOutage === "quota_exhausted")
        yield* endForSpentModelQuota(modelFailure, "model");
      // The outcome is already decided; its diagnostic copy never blocks returning it.
      yield* dependencies.diagnostics
        ?.emit("mint.model_finished", {
          state: Exit.isSuccess(modelResult) ? "completed" : "failed",
          diagnostics,
          executions,
          ...(dependencies.hostAnomalies === undefined
            ? {}
            : { anomalies: dependencies.hostAnomalies() }),
        })
        .pipe(
          Effect.mapError(diagnosticUnavailable),
          Effect.catchAll(recordDiagnosticGap("mint.model_finished")),
        ) ?? Effect.void;
      // The reviewer's final turn, when finish_build left a write unresolved, ends here; whatever
      // it decided stands, and an unresolved write is reported as possibly applied.
      const writes = yield* reviewer.close;
      const currentInvocation = dependencies.currentInvocation?.();
      finished.build = terminal?.build ?? "incomplete";
      // An unpublished build whose last publication Guardian denied says so, with its reason.
      const denied = finished.build === "incomplete" ? publicationDenial : undefined;
      const ended = terminal ?? {
        build: "incomplete" as const,
        // The provider or the run's record failed, as opposed to the agent running out of
        // calls, turns or time, or choosing to stop.
        ...(modelFailure?.modelOutage === "unavailable"
          ? { hostFailure: "model_unavailable" as const }
          : {}),
        summary:
          denied === undefined
            ? "Minting stopped before publication; inspect recorded execution outcomes before continuing."
            : `Guardian's publication review denied the last publication (${[denied.reason, denied.category].filter((part) => part !== undefined).join(", ")}), and minting stopped before a corrected one was published; inspect recorded execution outcomes before continuing.`,
      };
      const stopReason = stopReasonOf(ended, noResponse, modelFailure);
      return {
        ...ended,
        ...(stopReason === undefined ? {} : { stopReason }),
        ...(denied === undefined ? {} : { publicationDenial: denied }),
        ...(noResponse === undefined ? {} : { noResponse }),
        ...(example ? { example } : {}),
        ...(currentInvocation === undefined ? {} : { currentInvocation }),
        executions,
        ...(writes.length === 0 ? {} : { writes }),
        diagnostics,
      };
    }),
  );
