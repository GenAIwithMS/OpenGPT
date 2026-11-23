import type { MintDiagnostics, MintReporting } from "./diagnostics.js";
import type { MintProjection } from "./projection.js";
import { CredentialRejectedField } from "../runtime/authentication.js";
import type { SessionLoss } from "../runtime/authentication.js";
import type { BrowserRecoverySummary } from "../runtime/provider-metadata.js";
import type { CapabilityReview } from "../capabilities/review-contracts.js";
import { IntakeReasonCode } from "../capabilities/intake-contracts.js";
import type { FailureDetail } from "../runtime/failure-detail.js";
import type { InputIssue } from "../runtime/errors.js";
import { outputChecks, type FieldFill, type OutputFinding } from "../runtime/output-lint.js";
import type { DestinationPrivateCandidateReason } from "../destinations/private-candidate.js";
import type { SignedInMarkerCheck } from "../destinations/signed-in-marker.js";
import type { DestinationReason } from "./destination-reason.js";
import {
  LiveTestRecord,
  type LiveTestBatchCase,
  type LiveTestCaseRun,
} from "./live-tests.js";
import type { AuthorityCheckReason, AuthorityCheckStage } from "../auth/authority-metadata.js";
import type {
  OriginalPolicyFailureCode,
  PolicyFailureCheck,
  PolicyFailureReason,
  PolicyFailureContext,
  PolicyFailureSource,
  PolicyFailureUrlCategory,
} from "../runtime/policy-metadata.js";
import { Context, Data, Schema, type Effect } from "effect";
import { commitMarkMaxLength, commitMarkPattern } from "../runtime/operation.js";
import type { SiteAccessDiagnostic } from "./site-access-contracts.js";
import type { SignInVersionFinding } from "./sign-in-version.js";
import {
  AutofillPopup,
  AutofillApproval,
  DateOfBirthFormat,
  IdentifierKinds,
  maximumCodeBoxes,
  maximumStepFields,
  RejectedMarker,
  SecretSlots,
  SignInMethodChoice,
  stepFieldsFit,
  stepFieldsMessage,
  SubmitKey,
} from "../destinations/autofill-contracts.js";
import type { SandboxSession, SkillDescriptor } from "@openai/agents/sandbox";
import type { AgentInputItem } from "@openai/agents";
import type { Deadline } from "../runtime/deadline.js";
import type { EntryNavigationOutcome } from "../runtime/start-state.js";
import type { ModelDiagnosticTiming } from "../models/model-diagnostic-timing.js";
import type { RuntimeRecordInput } from "../models/model-runtime-record.js";
import type {
  MintAgentRecovery,
  MintAgentSnapshot,
  RecoveryToolCall,
} from "./recovery-contracts.js";

import type { CurrentInvocation } from "./invocation.js";
import { SiteNaming } from "../registry/site-naming.js";
import { SupportedOperationVariant } from "../registry/operation-variants.js";
import type { RegistryIssue } from "../registry/issues.js";
import type { ExecutionBoundaryError } from "../execution/boundary.js";
import type { SignInDiagnostic } from "../execution/sign-in-diagnostics.js";
import {
  AnsweredQuestion,
  type ConfirmedStepQuestion,
  type QuestionDecision,
} from "../guardian/question.js";
import { MintFile } from "./file-handles.js";
import {
  TaskChange,
  type PendingTaskUpdate,
  type ReviewedTaskUpdate,
  type TaskUpdateConfirmer,
  type TaskUpdateDecision,
} from "../guardian/task-update.js";
import {
  ConfirmQuestion,
  LoginDecline,
  ProposedChoiceQuestion,
  ProposedMultiChoiceQuestion,
  SecretQuestion,
  TextQuestion,
} from "../runtime/input-request.js";
import type { InputRequest, ValidAnswers } from "../runtime/input-request.js";
import type {
  PublicationFileBlock,
  ReviewedLiveTestBatch,
  ReviewFailure,
} from "../guardian/review.js";
import type { RunnerFailure } from "./runner-failure.js";
import type { HostAnomalySummary, MintAttemptOutcome } from "./incident-contracts.js";
import type {
  InputFeedbackFallback,
  InputFeedbackReview,
  PublishedBuild,
  MintArtifact,
  MintCompletion,
  MintReviewFeedback,
} from "./input-feedback.js";
import {
  GuardianAction,
  PublicationFinding,
  PublicationReason,
  type GuardianRefusal,
} from "../guardian/review-contracts.js";
import {
  OutcomeWrite,
  type LiveMinterHistory,
  type MinterHistoryArchive,
  type OutcomeReviewHost,
  type WriteOutcome,
} from "./outcome-review-contracts.js";
import { CaptureScreeningDiagnostic } from "../runtime/capture-diagnostic.js";
import type {
  diagnosticRetentionReason,
  diagnosticScreeningReason,
  diagnosticStorageFailure,
} from "../models/model-diagnostic-failure.js";

/** A runner's stdout, stderr and events, already screened with the job's broker for the agent. */
export interface RunnerChannels {
  readonly stdout: unknown;
  readonly stderr: unknown;
  readonly events: unknown;
}

/**
 * What spent an attempt's sign-ins: its one extra sign-in after a verified one, the sign-ins it
 * allows on a recovery's new profile, the retries the host allows of a sign-in that submitted the
 * login but never verified and was not rejected, the host's identical refusals in a row while
 * typing into a sign-in screen (`maximumHostRefusals`), which no correction of the step got past,
 * Guardian's correctable denials in a row of one unchanged sign-in step (`maximumSignInDenials`),
 * or the caller's refusal to trust the origin off the site that the site's sign-in sent the login
 * to, so no sign-in of the site can verify.
 */
export type SpentSignIn =
  | "relogin_spent"
  | "fresh_profile_sign_ins_spent"
  | "sign_in_retry_spent"
  | "host_refusals_repeated"
  | "guardian_denials_repeated"
  | "sign_in_origin_untrusted";

export type { SessionLoss };

/**
 * One registered output field a repair loosens and how, by path (`items[].price.amount`; the
 * root is `output`, its items `output[]`). The host that publishes repairs compares the schemas.
 */
export interface WeakenedOutput {
  readonly field: string;
  readonly change: "removed" | "optional" | "nullable" | "widened";
}

/**
 * One input a publication changes against the published tool's inputs, and how: `removed` (the
 * tool declares it and the publication drops it), now `required` (an input the tool declares as
 * optional, or a new input), or otherwise `changed`. The host that refuses such a publication
 * compares the input schemas.
 */
export interface BrokenInput {
  readonly field: string;
  readonly change: "removed" | "required" | "changed";
}

/**
 * A closed code as core writes one: snake_case (`autofill_recipe_not_verified`) or PascalCase
 * (`CredentialTargetRefused`), at most 64 characters, so no page text fits. Each code comes from
 * a closed type where it is set (a `MintFailure` reason, a sign-in failure code, a host check);
 * the checkpoint checks its shape rather than listing every code, so a code a later release adds
 * still reads.
 */
const ClosedCode = Schema.String.pipe(
  Schema.pattern(/^(?:[a-z][a-z0-9]*(?:_[a-z0-9]+)*|[A-Z][A-Za-z0-9]*)$/u),
  Schema.maxLength(64),
);
/**
 * The host check that refused a step the build needs, which a `host_refused` ending stands on, by
 * closed codes alone, never page text:
 * - `publication`: the host's own publication checks refused a finish_build, with the failure's
 *   code and its reason;
 * - `sign_in_step`: the host refused a sign-in step, with the sign-in's code and the check that
 *   refused it;
 * - `task_update`: the host refused to apply a task update, with its reason, or `other` for one
 *   core does not name.
 */
export const HostRefusalSource = Schema.Union(
  Schema.Struct({
    source: Schema.Literal("publication"),
    // Only the host's own publication checks set it, which fail as this code.
    code: Schema.Literal("PublicationUnavailable"),
    reason: Schema.optionalWith(ClosedCode, { exact: true }),
  }),
  Schema.Struct({
    source: Schema.Literal("sign_in_step"),
    code: Schema.Literal(
      "CredentialTargetRefused",
      "CredentialTargetUnverified",
      "AutofillRefused",
    ),
    check: Schema.optionalWith(ClosedCode, { exact: true }),
  }),
  Schema.Struct({
    source: Schema.Literal("task_update"),
    reason: Schema.Literal(
      "intake_refused",
      "duplicate_tool",
      "site_unavailable",
      "change_unsupported",
      "other",
    ),
  }),
);
export type HostRefusalSource = typeof HostRefusalSource.Type;

/**
 * What a `host_refused` ending stood on, in the blocked diagnostic: the source that set the
 * attempt's host refusal (`HostRefusalSource`), a sign-in screen the host refused because the
 * password's fills are spent (`sign_in_refill`), one it refused at its destination check
 * (`sign_in_destination`), live tests the host refuses with no batch left (`live_tests_spent`), and
 * a refusal an older worker's checkpoint kept without its source (`unrecorded`).
 */
export type HostRefusalBasis =
  | HostRefusalSource
  | {
      readonly source:
        | "sign_in_refill"
        | "sign_in_destination"
        | "live_tests_spent"
        | "unrecorded";
    };

export class MintFailure extends Data.TaggedError("MintFailure")<{
  readonly rejectedCredential?: typeof CredentialRejectedField.Type;
  /** Sub-cause, operation, underlying error, stack and context; see ERROR-LOGGING-STANDARD.md. */
  readonly failureDetail?: FailureDetail;
  /**
   * A job sandbox workspace call that did not complete: which operation, which workspace path,
   * why and how long it took. The paths are the agent's own workspace files and captures.
   */
  readonly workspace?: {
    readonly operation: string;
    readonly path?: string;
    readonly fileCount?: number;
    readonly reason?: string;
    readonly elapsedMs?: number;
  };
  readonly authorityStage?: AuthorityCheckStage;
  readonly authorityReason?: AuthorityCheckReason;
  readonly originalAuthorityFailureCode?: "AuthorityChanged";
  readonly originalPolicyFailureCode?: OriginalPolicyFailureCode;
  readonly policyFailureSource?: PolicyFailureSource;
  readonly policyFailureCheck?: PolicyFailureCheck;
  readonly policyFailureReason?: PolicyFailureReason;
  readonly policyFailureContext?: PolicyFailureContext;
  readonly policyFailureUrlCategory?: PolicyFailureUrlCategory;
  readonly destinationReason?: DestinationReason;
  readonly destinationPrivateCandidateReason?: DestinationPrivateCandidateReason;
  readonly publicationDiagnostics?: readonly PublicationDiagnosticGap[];
  /**
   * What the model provider did to end the attempt: `unavailable` when it stayed unavailable
   * through the host's retries (or the run's own record could not be stored), `quota_exhausted`
   * when it refused the call because the account's quota is spent, which no retry gets past. Only
   * this marks a model failure as a host failure; spent model calls, the SDK turn ceiling or an
   * expired deadline end the attempt as the agent's own outcome.
   */
  readonly modelOutage?: "unavailable" | "quota_exhausted";
  /** The attempt spent the model calls it may make: the build ends `turn_budget_spent`. */
  readonly turnBudgetSpent?: true;
  /**
   * The owner declined the login a sign-in asked for: they have no account on the site
   * (`no_account`), or want only what the site shows signed out (`public_only`). The minter
   * hears it as a result and builds the public part of the request without signing in.
   */
  readonly loginDeclined?: LoginDecline;
  /** The session's `decideDialog` step names a `confirm_action_unmatched` refusal names. */
  readonly confirmActionIds?: readonly string[];
  /** The commit marks of the recorded write path a `write_path_*` refusal names, in path order. */
  readonly writePathMarks?: readonly string[];
  /**
   * Set on a `write_not_submitted` or `commit_marks_unentered` refusal when the host passed
   * `checkWriteSession` its `publishOnRefusal` and the step named for publication entered no commit
   * mark and recorded no confirmation, so the minter hears how to publish on the site's own no to
   * the example. Absent otherwise, and the minter hears what it always has.
   */
  readonly publishesOnRefusal?: true;
  /** Where the input schema rejected the input a `contract_input_mismatch` refusal names. */
  readonly inputIssues?: readonly InputIssue[];
  /** For `output_checks_blocked`, each blocking finding by path, check and count; never a value. */
  readonly outputFindings?: readonly Pick<OutputFinding, "path" | "check" | "count">[];
  /** Which host-recorded route evidence a `destination_validation` refusal lacked. */
  readonly destinationEvidenceGap?:
    | "no_route_evidence"
    | "sign_in_route_evidence"
    | "inconsistent_route_evidence"
    | "receipt_mismatch";
  readonly authentication?: SignInDiagnostic;
  /**
   * Why no further sign-in may run in this attempt, set by the host on a sign-in that failed, or
   * was refused, once the attempt's sign-ins are spent: the build ends `sign_in_unavailable`.
   */
  readonly spentSignIn?: SpentSignIn;
  /**
   * The origins off the site and its sign-in origins that a sign-in no check verified sent the
   * login to, each an exact origin, which a publication refused as `autofill_recipe_not_verified`
   * names to the minter.
   */
  readonly untrustedSignInOrigins?: readonly string[];
  /**
   * Set by the host when the site lost its signed-in session, as on a page load, and the host
   * could not sign in again: the build ends `sign_in_unavailable` with this cause.
   */
  readonly sessionLoss?: SessionLoss;
  /** The build's owner left a request unanswered; the build ends as `no_response`. */
  readonly noResponse?: { readonly possibleCommit: boolean };
  /**
   * With `noResponse`: the owner cancelled the request, as with Ctrl-C at a terminal, rather than
   * letting its window end. The build ends as `no_response`; the question never goes back to the
   * minter as no answer.
   */
  readonly ownerCancelled?: true;
  /**
   * What a takeover was still waiting on when its recovery wait ran out, such as
   * `sandbox_attachment_unconfirmed`: the build ends with `hostFailure: recovery_timeout`.
   */
  readonly recoveryTimeout?: string;
  /**
   * What a takeover could not confirm about its predecessor's last step, such as
   * `remote_execution_unconfirmed`. No later try can confirm it, so the build ends at once with
   * `hostFailure: recovery_unconfirmed`.
   */
  readonly recoveryUnconfirmed?: string;
  readonly diagnosticRetentionReason?: ReturnType<typeof diagnosticRetentionReason>;
  readonly diagnosticScreeningReason?: ReturnType<typeof diagnosticScreeningReason>;
  readonly diagnosticStorageFailure?: ReturnType<typeof diagnosticStorageFailure>;
  readonly reviewFailure?: ReviewFailure["code"];
  readonly reviewPhase?: ReviewFailure["reviewPhase"];
  /** Proves this submission stopped before execution; says nothing about prior effects. */
  readonly reviewDispatch?: "not_sent";
  /**
   * Why a maintenance recovery gate refused: its reason, what it expected and what it got, and
   * the earliest time a retry can pass it, so the agent fixes or waits instead of guessing.
   */
  readonly recoveryGate?: {
    readonly reason: string;
    readonly expected?: string;
    readonly got?: string;
    /** ISO time; absent when no wait alone can pass the gate. */
    readonly retryAfter?: string;
  };
  readonly reconciliationStage?:
    | "execution_receipt"
    | "observation_schema"
    | "lookup_origin"
    | "account_scope"
    | "intent_input"
    | "resource_binding"
    /** Maintenance recovery stopped and asked its caller. */
    | "inspection_contradicted"
    | "residual_cap";
  /**
   * What the caller answered when maintenance asked them at a `RecoveryEscalation` stage. The
   * caller's own words: context for the agent, never an approval to redo a write.
   */
  readonly callerGuidance?: string;
  readonly code:
    | "InvalidRequest"
    | "Unavailable"
    | "ScopeDenied"
    | "ReviewDenied"
    | "ReviewUnavailable"
    | "AlreadyExecuted"
    | "ReconciliationRequired"
    | "PublicationUnavailable"
    | "CaptureUnavailable"
    | "CredentialsRejected";
  /** Finite host metadata only; never provider messages, bodies, paths or credentials. */
  readonly execution?: Pick<
    ExecutionBoundaryError,
    | "phase"
    | "reason"
    | "dispatch"
    | "stage"
    | "elapsedMs"
    | "providerStatus"
    | "providerCode"
    | "workspace"
    | "runnerResult"
  >;
  /** Closed, host-derived facts from a runner that already finished before capture failed. */
  readonly runnerFailure?: RunnerFailure;
  /** A capture step that failed, so the host returns no capture view for this execution. */
  readonly captureGap?: "secret_discovery" | "capture_publication";
  /** The runner's stdout, stderr and events when there is no capture view to carry them. */
  readonly runnerChannels?: RunnerChannels;
  readonly reason?:
    | "executor_unavailable"
    | "missing_execution_receipt"
    | "result_reference_mismatch"
    | "entrypoint_mismatch"
    | "source_read"
    | "missing_current_entrypoint"
    | "source_validation"
    | "source_screening"
    | "path_screening"
    | "schema_screening"
    | "metadata_decode"
    | "metadata_validation"
    | "destination_validation"
    | "destination_variants"
    /** A Kernel-script tool declares `supportedVariants`, which only Effect runs dispatch; fixable. */
    | "variants_unsupported"
    /** A write repair's bundle is the registered revision's, so it has nothing to publish. */
    | "repair_unchanged"
    /** The saved login to sign in with stayed held by another job through the host's wait. */
    | "login_in_use"
    /**
     * A shared browser sign-in repair cannot publish without a verified replacement recipe, nor a
     * local build that rests on a step it ran after a sign-in no check verified.
     */
    | "autofill_recipe_not_verified"
    | "source_storage"
    | "registry_publication"
    /** The registry refused the definition; `registryIssue` names the check, often fixable. */
    | "registry_invalid_definition"
    /** The tool or catalog moved underneath the publication, and it was not committed over it. */
    | "registry_conflict"
    /** The registry stayed unavailable through the host's retries; publishing may be tried again. */
    | "registry_unavailable"
    | "example_output_unavailable"
    /** A read's HTTP implementation never passed a live test; the minter is asked once. */
    | "http_implementation_untested"
    /** A read's HTTP implementation changed since its passing live test; asked once too. */
    | "http_implementation_stale"
    /** A write session's composed script declares no `write.confirmation`. */
    | "confirmation_undeclared"
    /** A write session's composed script names none of its commit steps in `write.commits`. */
    | "commit_marks_undeclared"
    /**
     * The composed script declares a commit step no act step of the session ever entered, and
     * `write.commitsUnproven` does not name it as one after the last mark the session entered.
     */
    | "commit_marks_unentered"
    /**
     * The session has not settled every commit mark of its recorded write path;
     * `writePathMarks` names the ones not yet settled (a step that lost its result may have
     * entered them).
     */
    | "write_path_unfinished"
    /**
     * The composed script leaves marks of the session's recorded write path out of
     * `write.commits`; `writePathMarks` names them.
     */
    | "write_path_undeclared"
    /** The session step named for publication did not record the confirmation the script declares. */
    | "confirmation_unrecorded"
    /**
     * The composed write's output schema lists a `refused` status the host cannot read as a
     * declared refusal (`unreadableRefusal`), so a run that returns one would end as an unknown
     * outcome.
     */
    | "refusal_unreadable"
    /** The composed script's input schema rejects the caller's own values. */
    | "contract_input_mismatch"
    /** A read's current output schema rejects the output its example returned. */
    | "contract_output_mismatch"
    /** The composed script does not run a confirm popup's action under the session's action id. */
    | "confirm_action_unmatched"
    /** The session did not demonstrate the requested write. */
    | "write_not_submitted"
    /** Authored source holds a literal session token from the token view; recoverable. */
    | "session_token_literal"
    /** Authored source holds the placeholder a withheld history shows instead of a token. */
    | "session_token_placeholder"
    /** Source to publish holds a `{{secret.…}}` handle, which only the build's own executions fill. */
    | "secret_handle"
    /** Source to publish holds a `{{file.…}}` handle, which names a file only in this build. */
    | "file_handle"
    /** Source to publish sets a file input, handles a download or reads a file back itself. */
    | "file_readback"
    /** Source to publish calls `fillCard` and could read a typed card back. */
    | "card_readback"
    /** The live page URL the sign-in used carries one-time authorization values; asked once. */
    | "login_url_one_time"
    /** The login URL to publish carries a registered credential; refused every time. */
    | "login_url_contains_credential"
    /**
     * The sign-in to publish fails the sign-in version check (`checkSignInVersion`);
     * `publicationFeedback.signInFindings` names each rule and part. Refused every time.
     */
    | "sign_in_version_refused"
    /** The name, description, site name or summary to publish carries a registered credential. */
    | "metadata_contains_credential"
    /** The site's integration has no name yet, and the metadata names no `siteName` and `siteSummary`. */
    | "site_metadata_required"
    /** Another enabled tool in the integration this would join has the same tool name. */
    | "tool_name_taken"
    /** The definition to publish quotes the build's account reference; refused every time. */
    | "definition_login_reference"
    /** The publication gate refused a file Guardian's review reads; `publicationBlock` names it. */
    | "evidence_screening"
    /** A `read_source` of a capture the workspace does not hold: it is not saved yet. */
    | "capture_not_saved"
    /** A repair loosens its registered tool's output contract; `weakenedOutputs` names each field. */
    | "output_obligation_weakened"
    /**
     * The host refused a publication that changes inputs the published tool already declares;
     * `brokenInputs` names each one.
     */
    | "input_contract_changed"
    /**
     * The example's output holds code, styles, markup or template leftovers the minter did not
     * override with a reason; `outputFindings` names each path and check.
     */
    | "output_checks_blocked";
  /** For `output_obligation_weakened`, each registered output field the repair loosens and how. */
  readonly weakenedOutputs?: readonly WeakenedOutput[];
  /** For `input_contract_changed`, each declared input the publication changes and how. */
  readonly brokenInputs?: readonly BrokenInput[];
  /** What login URL and metadata feedback names: parts, parameter names and credential kinds, never values. */
  readonly publicationFeedback?: {
    readonly oneTimeParameters?: readonly string[];
    readonly parts?: readonly {
      readonly part: "loginUrl" | "name" | "description" | "siteName" | "siteSummary";
      readonly credentialKinds: readonly string[];
    }[];
    /** For `sign_in_version_refused`, each rule and the part of the sign-in it refused. */
    readonly signInFindings?: readonly SignInVersionFinding[];
  };
  /**
   * What the publication gate refused and where, for `source_screening`, `schema_screening`
   * and `evidence_screening`; never the refused value.
   */
  readonly publicationBlock?: PublicationFileBlock;
  /** For `entrypoint_mismatch`, the entrypoint the named execution's receipt ran. */
  readonly expectedEntrypoint?: string;
  /** For a registry refusal, the check that refused the publication. */
  readonly registryIssue?: RegistryIssue;
  /** For a refused login URL, why no sign-in can start from it; never the URL itself. */
  readonly registryProblem?: string;
  readonly screening?: {
    readonly category: "authored_source" | "entrypoint_wrapper" | "schema";
    /** Included only after the source path passes publication privacy screening. */
    readonly path?: string;
    /** The host-built definition field that needs correction, when one is known. */
    readonly section?: string;
    readonly replacements: number;
  };
  /** Screened by the trusted host; never a raw provider error. */
  readonly review?: {
    readonly outcome: "deny" | "escalate";
    /** A publication review's reason; `input_feedback` is the one that never blocks for good. */
    readonly reason?: PublicationReason;
    /** The Guardian review that returned this publication decision. */
    readonly reviewId?: string;
    readonly rationale: string;
    readonly findings?: readonly PublicationFinding[];
    /**
     * A publication review's short reason its caller may read, apart from the private rationale;
     * the harness screens it before a build's result carries it (`PublicationDenial`).
     */
    readonly publicReason?: string;
    /**
     * An execution review's refusal kind (`GuardianRefusal`). Absent from an older reviewer, it
     * counts as `final`, as every execution refusal did before.
     */
    readonly refusal?: GuardianRefusal;
  };
}> {}

export const MintRequest = Schema.Struct({
  mode: Schema.Literal("mint", "maintenance"),
  intent: Schema.String.pipe(Schema.minLength(1)),
  businessInput: Schema.Unknown,
  observations: Schema.Unknown,
  siteOrigin: Schema.optional(Schema.String.pipe(Schema.maxLength(2048))),
  /**
   * The caller's files: each one's `{{file.fN}}` handle, which `businessInput` holds where the file
   * stood, with its name, media type and size. Never its bytes.
   */
  files: Schema.optional(Schema.Array(MintFile)),
  /** `ask` means the owner has not answered yet. Nothing executes or publishes until they do. */
  effect: Schema.optionalWith(Schema.Literal("read", "write", "ask"), {
    default: () => "read" as const,
  }),
});
export type MintRequest = typeof MintRequest.Type;

const SignInSelector = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1_000));
const SignedInUrlPath = Schema.String.pipe(Schema.pattern(/^\/[^?#]{0,1999}$/));
const SignedInOpenPath = Schema.String.pipe(Schema.pattern(/^\/[^#]{0,1999}$/));
/**
 * A signed-in marker the minting agent asks the host to test before it sends it
 * (`check_signed_in_marker`): its selector, with the path and account page `signedIn` takes.
 */
export const SignedInMarkerCheckRequest = Schema.Struct({
  selector: SignInSelector,
  urlPath: Schema.optional(SignedInUrlPath),
  openPath: Schema.optional(SignedInOpenPath),
});
export type SignedInMarkerCheckRequest = typeof SignedInMarkerCheckRequest.Type;
/**
 * One sign-in screen for host autofill (autofill enabled): the
 * fields the host fills from the held login, each with the kind of value it takes, and the control
 * that submits them, which the host clicks. A screen without a button (a password field that
 * appears once the identifier is filled) names no submit; a method choice names only a submit. A
 * screen whose form has no submit control and submits on Enter names `submitKey` instead, and the
 * host presses Enter in its last field. A screen a cookie or tracking consent banner covers names
 * that banner's own close, reject or accept control as `dismiss`, in that order of preference,
 * which the host clicks first, when it shows. `signedIn` names what shows the site signed in,
 * which the host checks on the page itself.
 */
export const SignInStep = Schema.Union(
  Schema.Struct({
    popup: Schema.optional(AutofillPopup),
    rejectedMarkers: Schema.optional(
      Schema.Array(RejectedMarker).pipe(Schema.maxItems(maximumStepFields)),
    ),
    fields: Schema.Array(
      Schema.Union(
        // An identifier field lists every kind it accepts; the host picks what it sends.
        Schema.Struct({
          selector: SignInSelector,
          accepts: Schema.Array(IdentifierKinds).pipe(
            Schema.minItems(1),
            Schema.filter((kinds) => new Set(kinds).size === kinds.length, {
              message: () => "list each accepted kind once",
            }),
          ),
        }),
        // A date of birth names how the field takes it, or the one part a dropdown takes. A
        // private answer names its question, and a code the screen's own instruction for it.
        Schema.Struct({
          selector: SignInSelector,
          slot: SecretSlots,
          format: Schema.optional(DateOfBirthFormat),
          questionSelector: Schema.optional(SignInSelector),
        }).pipe(
          Schema.filter(
            (field) =>
              field.questionSelector === undefined ||
              field.slot === "private_answer" ||
              field.slot === "code",
            { message: () => "only a private answer or a code names a question selector" },
          ),
        ),
      ),
    ).pipe(
      Schema.maxItems(maximumStepFields + maximumCodeBoxes),
      Schema.filter(stepFieldsFit, { message: () => stepFieldsMessage }),
    ),
    submit: Schema.optional(SignInSelector),
    /**
     * Enter, pressed in the last field to submit that field's form, on a screen whose form has no
     * submit control and submits on Enter. Never with `submit`.
     */
    submitKey: Schema.optional(SubmitKey),
    /**
     * A two-factor method choice: every method the screen offers, each with the control that
     * picks it, and `submit` the one to pick now. Runs pick again from these.
     */
    methods: Schema.optional(
      Schema.Array(Schema.Struct({ method: SignInMethodChoice, selector: SignInSelector })).pipe(
        Schema.minItems(1),
        Schema.maxItems(8),
      ),
    ),
    /**
     * The own control of a cookie or tracking consent banner that shows on this screen: its close
     * or dismiss control, else one that rejects what is not essential, else accept when that is
     * the only way out. The host clicks it before it types, when the page shows it, and runs do the
     * same. After the host reports `submit: blocked`, send the same step again with it: the host
     * clicks it, then clicks the submit once more, typing nothing unless the dismiss emptied a
     * field. Never a submit, a field or a control of the sign-in's own form.
     */
    dismiss: Schema.optional(SignInSelector),
  }).pipe(
    Schema.filter((step) => step.fields.length > 0 || step.submit !== undefined, {
      message: () => "a sign-in step fills a field or clicks a control",
    }),
    Schema.filter(
      (step) =>
        step.dismiss === undefined ||
        (step.dismiss !== step.submit &&
          !step.fields.some((field) => field.selector === step.dismiss) &&
          !(step.methods ?? []).some((option) => option.selector === step.dismiss)),
      { message: () => "dismiss names the covering notice's own control, none of the step's" },
    ),
    Schema.filter(
      (step) =>
        step.submitKey === undefined ||
        (step.submit === undefined && step.methods === undefined && step.fields.length > 0),
      {
        message: () =>
          "a submitKey step fills a field and names no submit: the key submits its last field's form",
      },
    ),
    Schema.filter(
      (step) =>
        step.methods === undefined ||
        (step.fields.length === 0 &&
          step.methods.some((option) => option.selector === step.submit)),
      {
        message: () =>
          "a method choice fills no field, and its submit is the selector of one of its methods",
      },
    ),
  ),
  Schema.Struct({
    approval: AutofillApproval,
    popup: Schema.optional(AutofillPopup),
    matchSelector: Schema.optional(
      SignInSelector.annotations({
        description:
          "On a device approval screen that shows a number the owner must pick on their device, the visible element that shows it; the host shows that number in the owner's confirmation",
      }),
    ),
  }),
  // The site showed that the login's password or code was wrong: the host asks the owner
  // for a correction in place and never sends the rejected value again. Or, once the login was
  // sent, it showed the account itself locked or suspended (`account`), at the visible element
  // `selector` names, which the host checks shows: no correction gets past that, and the build
  // ends `account_locked`.
  Schema.Struct({
    rejected: Schema.Union(
      Schema.Struct({ slot: CredentialRejectedField }),
      Schema.Struct({
        account: Schema.Literal("locked", "suspended"),
        selector: SignInSelector.annotations({
          description:
            "The visible element whose text says the account is locked or suspended (disabled or closed counts as suspended)",
        }),
      }),
    ),
  }),
  Schema.Struct({
    signedIn: Schema.Struct({
      selector: Schema.optional(SignInSelector),
      urlPath: Schema.optional(SignedInUrlPath),
      /**
       * An account page on the site the host opens first, when the page the sign-in lands on
       * shows no marker itself; the selector or path is checked there.
       */
      openPath: Schema.optional(SignedInOpenPath),
    }).pipe(
      Schema.filter(
        (signedIn) => signedIn.selector !== undefined || signedIn.urlPath !== undefined,
        {
          message: () => "name a selector or a URL path that shows the site signed in",
        },
      ),
    ),
  }),
);
export type SignInStep = typeof SignInStep.Type;

/**
 * A host card-fill step: the payment card fields on the checkout showing now, each with the card
 * handle the host types into it. It clicks nothing. Each handle is a card answer's, named once.
 */
export const CardFillStep = Schema.Struct({
  fields: Schema.Array(
    Schema.Struct({
      selector: SignInSelector,
      handle: Schema.String.pipe(Schema.pattern(/^\{\{secret\.s[1-9]\d*\}\}$/u)),
    }),
  ).pipe(
    Schema.minItems(1),
    Schema.maxItems(4),
    Schema.filter((fields) => new Set(fields.map((field) => field.handle)).size === fields.length, {
      message: () => "name each card handle once",
    }),
  ),
});
export type CardFillStep = typeof CardFillStep.Type;

/** A commit mark's name, as a script's `enteringCommit` takes it and its contract declares it. */
const CommitMarkName = Schema.String.pipe(
  Schema.maxLength(commitMarkMaxLength),
  Schema.pattern(commitMarkPattern),
);
/** The most steps a write path names. */
export const writePathStepLimit = 32;
/**
 * A write build's whole path, which its first `act` step declares before anything is sent: each
 * step that saves or submits on the site, by the commit mark its helper enters, in order, and what
 * the last one leaves the caller with. Guardian reviews it against the request by the rule the
 * publication review judges the finished tool by, the host keeps the path its review allowed, and
 * the session runs until every mark on it is entered. A later `act` step may revise it, keeping
 * each mark the session already entered.
 */
export const WritePath = Schema.Struct({
  steps: Schema.Array(
    Schema.Struct({
      commit: CommitMarkName.annotations({
        description:
          "The commit mark this step's helper enters with enteringCommit, as the composed script declares it in write.commits",
      }),
      does: Schema.String.pipe(Schema.pattern(/\S/), Schema.maxLength(200)).annotations({
        description: "What the step saves or submits, in a few words, such as 'saves the applicant page'",
      }),
    }),
  ).pipe(
    Schema.minItems(1),
    Schema.maxItems(writePathStepLimit),
    Schema.filter((steps) => new Set(steps.map((step) => step.commit)).size === steps.length, {
      message: () => "name each commit mark once",
    }),
  ),
  ends: Schema.String.pipe(Schema.pattern(/\S/), Schema.maxLength(300)).annotations({
    description:
      "What the last step leaves the caller with: the outcome the request asks for, such as the quote or decline the site returns, or the order's confirmation",
  }),
});
export type WritePath = typeof WritePath.Type;

export const ExecutionRequest = Schema.Struct({
  /**
   * `act` is a step of a write build's one live write session; see the writes skill. `card_fill`
   * types the caller's card answers with `cardFillStep`.
   */
  purpose: Schema.Literal(
    "explore",
    "authenticate",
    "test",
    "example",
    "act",
    "inspect",
    "residual",
    "card_fill",
  ),
  target: Schema.Literal("pureFiles", "savedHTTP", "savedDOM", "liveBrowser"),
  loginUrl: Schema.optional(Schema.String),
  entrypoint: Schema.String,
  fixtureRefs: Schema.Array(Schema.String),
  caseFilter: Schema.Array(Schema.String),
  maxWorkers: Schema.Number.pipe(Schema.int(), Schema.between(1, 16)),
  timeoutSeconds: Schema.Number.pipe(Schema.int(), Schema.between(1, 1200)),
  /** JSON text, since the model's strict tool schema cannot express an arbitrary object. */
  testInput: Schema.optional(
    Schema.String.pipe(Schema.minLength(2), Schema.maxLength(16_384)).annotations({
      description:
        "Only with purpose test and target liveBrowser on a read build: the tool's input you chose, as JSON text, to show the tool works for values other than the caller's, such as another route or passenger count. Public values only. A read signed out runs as many as it needs. A signed-in read runs at most four distinct inputs beyond its example in a build or repair (testing skill); running one again is free. Where the host offers live_tests, run planned cases in batches with it instead. Omit it to run the caller's input.",
    }),
  ),
  /** Only on authenticate, and only where the host offers autofill sign-in. */
  signInStep: Schema.optional(SignInStep),
  /** Only on card_fill. */
  cardFillStep: Schema.optional(
    CardFillStep.annotations({
      description:
        "Only with purpose card_fill, target liveBrowser and entrypoint operation/card-fill-step.json: the payment card fields on the checkout showing now, each the field's own selector, on the site's page or inside the payment provider's frame (the host finds the frame that holds it), and the card handle a request_input answer gave you for it. The host types the caller's card into them and clicks nothing.",
    }),
  ),
  /**
   * Only when the caller's input is empty (`{}`), on a read build's example or a write build's
   * act step: the tool's input as JSON text, which the agent writes from the request and the
   * owner's answers. The example, or each act step that passes it, runs it. In a write session,
   * the first act step that passes it fixes it, whichever step that is: its later act steps
   * repeat it unchanged, or omit it where the host keeps the session's input and runs it on them.
   */
  exampleInput: Schema.optional(Schema.String),
  /**
   * On a write build's first `act` step: the build's whole write path (`WritePath`). On a later
   * `act` step: a revision of it, which keeps every mark the session already entered.
   */
  writePath: Schema.optional(
    WritePath.annotations({
      description:
        "Required on a write build's first act step, before anything is sent: the whole path its one write session and the published tool take, through to the outcome the request asks for. steps lists, in order, each step that saves or submits on the site, by the commit mark its helper enters; ends says what the last step leaves the caller with. Guardian reviews it as publication will review the tool, and the session runs until every mark on it is entered. On a later act step, only to revise the path when the page shows it must change; keep every mark already entered.",
    }),
  ),
});
export type ExecutionRequest = typeof ExecutionRequest.Type;
/** The execute tool's input where the host offers no autofill sign-in: no `signInStep`. */
export const ManagedSignInExecutionRequest = ExecutionRequest.omit("signInStep");

/**
 * What a host provides for a read's live tests. The minting agent designs cases in
 * `test/cases.json` from what it saw on the site, and runs them in batches on the Playwright
 * version or the HTTP version (`entrypoint`); the harness keeps each version's results apart. A
 * read signed out runs as many as it needs. A signed-in read runs a few, on at most
 * `signedInTestInputLimit` distinct inputs in a build or repair, as batches marked `signedIn`,
 * only on a host that declares `signedInBatches`. A
 * write runs none: its act session is the one run that proves it.
 */
export interface LiveTestHost {
  /**
   * The current source's declared input and output JSON Schemas for `entrypoint`, read offline
   * without running the operation: the harness reads a list's cursor and results from them.
   */
  readonly schemas: (
    entrypoint: string,
  ) => Effect.Effect<{ readonly input: unknown; readonly output: unknown }, MintFailure>;
  /**
   * Runs one batch on the workspace's current source, whose digest is `batch.sourceDigest`. It
   * MUST first have Guardian review the whole batch once, as a live test of a read whose
   * `currentExecution.input` is `agent_chosen_batch` and whose submitted input lists every case's
   * input, and run nothing unless Guardian allows it. Then it runs each case like an example:
   * a fresh script process on a page reset to the site's origin that keeps the browser's site
   * data, in the build's browser or on separate browsers opened like it, never in tabs of one
   * browser. A host may run cases on up to its own `maxWorkers` browsers at once, whatever
   * `batch.workers` says. A host with more than one browser runs at least one
   * case first on a new browser with an empty profile, and marks each case run's `start`: `cold`
   * for a case that ran first on such a browser, `warm` for one that ran on a browser that kept
   * site data from earlier steps. A host with one browser runs every case warm, and the record
   * shows that no case passed cold. A batch marked `signedIn` belongs to a signed-in read: the
   * host runs each of its cases on the build's own signed-in browser, one at a time and warm,
   * never on a new browser, which would hold no session. `runLiveTestCase` runs a case and its next page. A
   * case a host problem, a challenge, a site block or the deadline stopped is `inconclusive`; a
   * case not run by `batch.deadlineAt` (epoch milliseconds) is `inconclusive` with reason
   * `deadline`. A host may record the batch as one history entry marked `agent_chosen_batch`, as
   * the local host does; none is required.
   */
  readonly run: (batch: LiveTestBatch) => Effect.Effect<LiveTestBatchResult, MintFailure>;
  /** The most browsers this host runs a batch on at once, the build's own included. */
  readonly maxWorkers: number;
  /**
   * The host runs a batch marked `signedIn` as that field says: every case on the build's own
   * signed-in browser, warm, never on a new browser. Only then does the harness give a signed-in
   * read live tests, on at most `signedInTestInputLimit` distinct inputs, and only then should the
   * host's preflight pass `signedInTests: true` to `preflightTestInput`. Absent, a signed-in read
   * runs no live tests, as before this field existed.
   */
  readonly signedInBatches?: true;
  /**
   * The host asks the minter to fix or retire every failing case before publication review.
   * `finish_build` of a read is then refused before review, as `PublicationUnavailable` with
   * reason `live_test_cases_failing`, while any counted case of the version it publishes fails on
   * that version's source (`failingLiveTestCases`), naming the cases; no Guardian call is made.
   * It does not apply once no case can run again, under the same check that lifts the 70% bar
   * (`liveTestsShortfall`). Absent, a read whose cases reach the bar goes to review with its
   * failing cases, as before this field existed.
   */
  readonly holdReviewOnFailingCases?: true;
  /**
   * How long one case may run on this host, in milliseconds; `defaultLiveTestCaseMs` when
   * absent. The harness refuses a batch as `no_time`, running nothing, when less than this is
   * left before the batch's deadline, since no case could finish.
   */
  readonly caseTimeoutMs?: number;
  /**
   * How long one case may run in the one batch a host that caps its batches keeps in reserve past
   * its cap, in milliseconds, while that batch has not run; absent otherwise. Once no batch fits
   * under `caseTimeoutMs`, the harness still runs a batch whose every case is one a failure is
   * pending on (`pendingFailureCases`), when this much is left before the batch's deadline, and its
   * `no_time` refusal of any other batch names those cases (`reservedFor`). The host counts such a
   * batch as its reserve. Whether tests can run again before publication still follows
   * `caseTimeoutMs` alone. Absent, a capped host refuses every batch past its cap, as before this
   * field existed.
   */
  readonly reservedCaseTimeoutMs?: number | undefined;
  /**
   * Receives a reader of this attempt's latest live test batches as the harness judged them, for
   * the host's Guardian execution reviews (`mintContext.liveTests`), so a review can confirm from
   * host facts that a suite passed on the source it judges. Each read checks whether every
   * batch's source is still the workspace's.
   */
  readonly bindBatches?: (read: Effect.Effect<readonly ReviewedLiveTestBatch[]>) => void;
}

/** How long one live test case may run when its host names no limit of its own. */
export const defaultLiveTestCaseMs = 60_000;

/** One batch of a read's live test cases. */
export interface LiveTestBatch {
  readonly entrypoint: string;
  readonly sourceDigest: string;
  readonly cases: readonly LiveTestBatchCase[];
  /**
   * How many cases the harness asks to run at once, each on its own browser; 1 to the host's
   * `maxWorkers`. A host may run cases on up to its own `maxWorkers` browsers at once, whatever
   * this says.
   */
  readonly workers: number;
  /** When the batch must end, in epoch milliseconds. */
  readonly deadlineAt: number;
  /**
   * The read signed in: run every case on the build's own signed-in browser, warm, never on a new
   * browser. The harness then asks for one worker.
   */
  readonly signedIn?: true;
}

export type LiveTestBatchResult =
  | {
      readonly status: "ran";
      readonly reviewId?: string;
      readonly cases: readonly LiveTestCaseRun[];
      /** How many browsers the cases ran on. */
      readonly lanes: number;
      /** Browsers the host closed after a challenge; their cases moved to the build's browser. */
      readonly challengeStops?: number;
    }
  | { readonly status: "review_denied"; readonly reviewId?: string; readonly rationale: string };

/**
 * The live_tests tool: `plan` shows the cases in `test/cases.json` and each case's latest result
 * (with full outputs for the cases named in `cases`); `run` runs the named cases, or every case when `cases` is null, as one batch
 * after one Guardian review, on separate browsers where the host has them. A host may run cases on
 * up to its own `maxWorkers` browsers at once, whatever the request's `maxWorkers` says.
 */
export const LiveTestsRequest = Schema.Struct({
  action: Schema.Literal("plan", "run"),
  entrypoint: Schema.String,
  cases: Schema.NullOr(
    Schema.Array(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64))).pipe(
      Schema.maxItems(50),
    ),
  ),
  maxWorkers: Schema.NullOr(Schema.Number.pipe(Schema.int(), Schema.between(1, 3))),
});
export type LiveTestsRequest = typeof LiveTestsRequest.Type;

export const CaptureRequest = Schema.Struct({
  kind: Schema.Literal("full", "response"),
  requestId: Schema.NullOr(Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{1,100}$/))),
});
export type CaptureRequest = typeof CaptureRequest.Type;

/**
 * Why a script's question reached nobody, as the agent is told. `reword` and `authentication` are
 * Guardian's corrections, with its rationale, which the agent answers by revising the script's
 * declared question. `invalid` is a request the host could not accept, and `unavailable` a review
 * or delivery the host could not finish. `unanswered` is a question the caller was asked and left
 * unanswered (with `noResponse`), which the agent hears when the build goes on; the harness adds it
 * when the host gives none. The originating cause stays in the host's failure report.
 */
export type ScriptQuestionOutcome =
  | {
      readonly requestId: string;
      readonly outcome: "reword" | "authentication";
      readonly reviewId?: string;
      readonly rationale: string;
    }
  | {
      readonly requestId: string;
      readonly outcome: "invalid" | "unavailable";
    }
  | {
      readonly requestId?: string;
      readonly outcome: "unanswered";
    };

/** An execution's refusal of the caller's value: the input and the page's choices for it. */
export const ExecutionRefusal: Schema.Schema<NonNullable<ExecutionEvidence["refusal"]>> =
  Schema.Struct({
    field: Schema.optionalWith(Schema.String, { exact: true }),
    available: Schema.Array(Schema.String),
  });

export interface ExecutionEvidence {
  readonly review?: MintReviewFeedback;
  readonly authentication?: {
    readonly state: "authenticated" | "failed";
    readonly effect: "possible" | "verified";
  };
  readonly executionId: string;
  readonly status: "completed" | "failed" | "unsupported" | "needs_input";
  readonly effect: "not_sent" | "possible" | "verified";
  /**
   * The confirmation a write session step recorded; it closes the session, unless
   * `writePathRemaining` names marks of the recorded write path not yet settled.
   */
  readonly confirmation?: "message" | "readback";
  /**
   * The confirmation a write session step read when the host did not accept its result, such as
   * one that returned a credential. It leaves the session open, so a later step that only reads
   * the confirmation back can confirm it. The step publishes only when publication says no
   * read-back is possible (`readBackUnavailable`). The write went out, so a host that sets it
   * must treat the commit marks this step entered as settled for every later act step (pass them
   * as `settledCommits` to `makeEffectJournalWith`), so entering one again fails with
   * `CommitAlreadySent`. Ignored when `confirmation` is set.
   */
  readonly withheldConfirmation?: "message" | "readback";
  /**
   * Trusted host marker on a write build's act step: the commit marks of the session's recorded
   * write path not yet settled, in path order (a step that lost its result may have entered
   * them). While it names any, a confirmation the step recorded does not close the session, which
   * runs on through them. The host treats the commit marks a confirming step entered as settled
   * for every later act step, as for a withheld confirmation.
   */
  readonly writePathRemaining?: readonly string[];
  /** Screened, finite supporting observation; never a replacement execution failure. */
  readonly siteAccess?: SiteAccessDiagnostic;
  /** Trusted host marker from a failed live runner result after cleanup and retention. */
  readonly terminalFailure?: "ChallengeFailure";
  /** Trusted host marker: the example asked the build's owner, who did not answer in time. */
  readonly noResponse?: { readonly possibleCommit: boolean };
  /**
   * Trusted host marker: why the question this execution's script asked reached nobody. Only the
   * agent's result carries it; the execution ledger and checkpoints never hold it.
   */
  readonly scriptQuestion?: ScriptQuestionOutcome;
  /** Emitted only by the harness when capability preflight rejects before a claim. */
  readonly preflight?: "rejected_before_claim";
  /**
   * Trusted host marker: the script refused the caller's value with `InvalidInput`, naming the
   * input and listing every choice the page offers for it. A read repair's example that ends
   * this way is its publication receipt, since maintenance cannot change the caller's input.
   */
  readonly refusal?: { readonly field?: string; readonly available: readonly string[] };
  readonly resultRef?: string;
  /** Private output is screened before returning to the agent. */
  readonly observations: unknown;
  readonly checks?: {
    readonly passed: number;
    readonly failed: number;
    readonly skipped: number;
    readonly unsupported: number;
    readonly liveSiteTouched: boolean;
  };
}

/** Private recovery codec; observations remain opaque protected values. */
export const ExecutionEvidence: Schema.Schema<ExecutionEvidence> = Schema.Struct({
  review: Schema.optionalWith(
    Schema.Struct({
      reviewId: Schema.String,
      outcome: Schema.Literal("allow", "deny", "escalate"),
      rationale: Schema.String,
      action: Schema.optionalWith(GuardianAction, { exact: true }),
    }),
    { exact: true },
  ),
  authentication: Schema.optionalWith(
    Schema.Struct({
      state: Schema.Literal("authenticated", "failed"),
      effect: Schema.Literal("possible", "verified"),
    }),
    { exact: true },
  ),
  executionId: Schema.String,
  status: Schema.Literal("completed", "failed", "unsupported", "needs_input"),
  effect: Schema.Literal("not_sent", "possible", "verified"),
  confirmation: Schema.optionalWith(Schema.Literal("message", "readback"), { exact: true }),
  withheldConfirmation: Schema.optionalWith(Schema.Literal("message", "readback"), {
    exact: true,
  }),
  writePathRemaining: Schema.optionalWith(Schema.Array(CommitMarkName), { exact: true }),
  siteAccess: Schema.optionalWith(
    Schema.Union(
      Schema.Struct({
        code: Schema.Literal("site_bot_challenge"),
        evidence: Schema.Literal("screened_page_and_response_headers"),
      }),
      Schema.Struct({
        code: Schema.Literal("site_rate_limited"),
        evidence: Schema.Literal("response_headers"),
      }),
    ),
    { exact: true },
  ),
  terminalFailure: Schema.optionalWith(Schema.Literal("ChallengeFailure"), { exact: true }),
  noResponse: Schema.optionalWith(Schema.Struct({ possibleCommit: Schema.Boolean }), {
    exact: true,
  }),
  scriptQuestion: Schema.optionalWith(
    Schema.Union(
      Schema.Struct({
        requestId: Schema.String,
        outcome: Schema.Literal("reword", "authentication"),
        reviewId: Schema.optionalWith(Schema.String, { exact: true }),
        rationale: Schema.String,
      }),
      Schema.Struct({
        requestId: Schema.String,
        outcome: Schema.Literal("invalid", "unavailable"),
      }),
      Schema.Struct({
        requestId: Schema.optionalWith(Schema.String, { exact: true }),
        outcome: Schema.Literal("unanswered"),
      }),
    ),
    { exact: true },
  ),
  preflight: Schema.optionalWith(Schema.Literal("rejected_before_claim"), { exact: true }),
  refusal: Schema.optionalWith(ExecutionRefusal, { exact: true }),
  resultRef: Schema.optionalWith(Schema.String, { exact: true }),
  observations: Schema.Unknown,
  checks: Schema.optionalWith(
    Schema.Struct({
      passed: Schema.NonNegativeInt,
      failed: Schema.NonNegativeInt,
      skipped: Schema.NonNegativeInt,
      unsupported: Schema.NonNegativeInt,
      liveSiteTouched: Schema.Boolean,
    }),
    { exact: true },
  ),
});

/** Why a read's HTTP version can't port. */
export const HttpVersionSignal = Schema.Literal(
  "per_request_hash_or_page_id",
  "bot_wall_on_page_fetch",
  "unobtainable_session_token",
  "streaming_response",
  "location_not_applicable",
  "site_refused_on_both_transports",
);
export type HttpVersionSignal = typeof HttpVersionSignal.Type;

/**
 * The minter's decision not to publish an HTTP version of a read: the signal, the captured request
 * it rests on, and a short note. It answers the host's ask for an HTTP version; the host records it
 * beside its own evidence and decides publication from its own records.
 */
export const HttpVersionDecision = Schema.Struct({
  outcome: Schema.Literal("ruled_out"),
  signal: HttpVersionSignal,
  requestId: Schema.optional(
    Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_.:-]{1,100}$/)).annotations({
      description: "The captures/routes.json requestId of the request the signal rests on",
    }),
  ),
  note: Schema.String.pipe(Schema.pattern(/\S/), Schema.maxLength(500)).annotations({
    description: "What showed the signal, in one or two sentences",
  }),
});
export type HttpVersionDecision = typeof HttpVersionDecision.Type;

export const PublicationRequest = Schema.Struct({
  entrypoint: Schema.String,
  executionId: Schema.String,
  metadata: Schema.Struct({
    name: Schema.String,
    description: Schema.String,
    /** Required only while the site's integration has no name yet; a later one is ignored. */
    siteName: Schema.optional(
      SiteNaming.fields.name.annotations({
        description: "The site's everyday name, as people say it, such as Example Flights",
      }),
    ),
    siteSummary: Schema.optional(
      SiteNaming.fields.summary.annotations({
        description: "One sentence on what the site is, not what this tool does",
      }),
    ),
    supportedVariants: Schema.optional(
      Schema.Array(SupportedOperationVariant).pipe(Schema.minItems(1), Schema.maxItems(32)),
    ),
  }),
  coverage: Schema.String,
  /**
   * Why no step can read a write's confirmation back, when the step named here read it but the
   * host did not accept its result. Only then does that step publish, with no output kept.
   */
  readBackUnavailable: Schema.optional(
    Schema.String.pipe(Schema.pattern(/\S/), Schema.maxLength(500)).annotations({
      description:
        "Only for a write step whose result the host did not accept after it read the confirmation: why no act step can read that confirmation or the saved state back, such as the site showing neither again",
    }),
  ),
  /**
   * A read with no HTTP version: why it can't port. Give it instead of writing, running and
   * deleting a version that can't work.
   */
  httpVersion: Schema.optional(
    HttpVersionDecision.annotations({
      description:
        "Only for a read published without src/tool-http.mjs: the signal from the http-mcp skill's \"When it can't port\" that rules an HTTP version out, the captured requestId it rests on, and a short note",
    }),
  ),
  /**
   * Site defaults the build took instead of asking: only non-credential, non-write, reversible
   * choices. The host keeps each one that passes privacy screening unchanged.
   */
  assumptions: Schema.optional(
    Schema.Array(
      Schema.Struct({
        subject: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
        choice: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
      }),
    ).pipe(Schema.maxItems(8)),
  ),
  /**
   * Output check findings the minter says are wrong about a correct value, each with why: the
   * tool's intended output, such as code, or page text that only resembles code. A blocking one no
   * longer refuses publication, and the publication review checks every override and its reason.
   */
  outputOverrides: Schema.optional(
    Schema.Array(
      Schema.Struct({
        path: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(300)).annotations({
          description: "The finding's field path exactly as the host reported it",
        }),
        check: Schema.Literal(...outputChecks).annotations({
          description: "The finding's check exactly as the host reported it",
        }),
        reason: Schema.String.pipe(Schema.pattern(/\S/), Schema.maxLength(500)).annotations({
          description:
            "Why the value is correct as returned: the tool's intended output, such as code on a tool that returns code, or the page's own displayed text that only resembles code",
        }),
      }),
    ).pipe(Schema.maxItems(16)),
  ),
});
export type PublicationRequest = typeof PublicationRequest.Type;

/**
 * How the minter ends a build its task makes impossible as asked:
 * - `site_lacks_capability`: the site does not offer what the task needs.
 * - `site_declined`: the site offers what the task needs but declines this example's own facts,
 *   such as an applicant it will not quote; the explanation names the reason the site gave.
 * - `site_unavailable`: the site is temporarily down for the failing input: its own pages show a
 *   maintenance or outage page, or fail with a 5xx answer from its own service, while the tool's
 *   code and the caller's input are unchanged, never a 5xx answer only to the request the tool
 *   made, since that request can be wrong. Nothing is wrong with the task, so a host may offer a
 *   retry later.
 * - `policy`: Guardian refused an execution with refusal `final`, or refused a publication for a
 *   reason no correction gets past (`publicationRefusalUnfixable`), in this attempt, and nothing
 *   within authority gets past it. An execution refusal Guardian marked `correctable` is never one.
 * - `owner_declined`: the owner explicitly said no to a step the build needs: a confirm question
 *   answered no, or a login request declined.
 * - `question_unanswered`: a question the build needed went unanswered, and the build cannot go
 *   on without its answer.
 * - `owner_ended`: the owner chose in an answer to end the build, such as after confirming that a
 *   fact it needs is unknown. Never the caller's error or the site's refusal.
 * - `host_refused`: a host check, not Guardian and not the site, refused a step the build needs in
 *   this attempt, such as a publication, a sign-in form or a site change, and nothing left in the
 *   attempt can fix it. The host records those refusals itself. It also stands on live tests the
 *   host refuses, with no batch left, while Guardian's denial of the latest publication stands.
 * - `caller_input`: the caller's own request stops the build: what it states conflicts with itself
 *   or its cited sources, a file it needs is missing, or it rules out going on, such as a stop
 *   condition it set that cannot be met. A missing fact the caller could supply is asked instead.
 *   A stop the site caused on its own, such as an expired quote, a block, an outage or a site
 *   error, is not `caller_input`, even when the request says to stop on it.
 *   Its basis is the report's `intent` citing the request: a field its input holds or words of its
 *   instruction (`citesCallerRequest`), or a task update the owner confirmed in an answer, by its
 *   revision or its words (`citesConfirmedUpdate`), such as a stop condition the owner picked that
 *   the build then met. The explanation says what the caller should supply or change. Optional:
 *   no host has to handle it until its core reports it.
 * The host refuses each ending without its basis on record. A `policy` report whose only basis is
 * the owner's no or an unanswered question ends as `owner_declined` or `question_unanswered`. A
 * target on another registrable domain is never a reason by itself: Guardian reviews such work.
 */
export const blockedExplanationLimit = 500;
export const BuildBlocked = Schema.Struct({
  reason: Schema.Literal(
    "site_lacks_capability",
    "site_declined",
    "site_unavailable",
    "policy",
    "owner_declined",
    "question_unanswered",
    "owner_ended",
    "host_refused",
    "caller_input",
  ),
  explanation: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(blockedExplanationLimit)),
});
/**
 * What the minter sends `report_blocked`: a blocked ending's reason, or `host_unavailable` when the
 * host has ended live execution and what the build still needs, such as a fresh example a review
 * asked for, cannot run without it. That one ends the attempt as the host's failure, never as a
 * block: nothing about the task is impossible, so the caller never reads it as one. Once sign-in
 * is unavailable in the build, any report, `policy` included, ends the build with the sign-in's
 * own result instead of the reason it names. So does any ending the report's checks accept but
 * `owner_declined`, `question_unanswered` or `owner_ended` while the build's latest sign-in never
 * confirmed and no failed one is pending: the site never got as far as judging the task.
 */
export const BlockedReport = Schema.Struct({
  reason: Schema.Literal(
    "site_lacks_capability",
    "site_declined",
    "site_unavailable",
    "policy",
    "owner_declined",
    "question_unanswered",
    "owner_ended",
    "host_refused",
    "caller_input",
    "host_unavailable",
  ),
  explanation: BuildBlocked.fields.explanation,
  /**
   * The `report_blocked` call's own intent: its evidence, which a `caller_input` ending needs to
   * cite the caller's request. Carried in the report, so a host that wraps the action keeps it.
   */
  intent: Schema.optional(Schema.String),
});
/**
 * A blocked build as recorded and shown: its reason, and its screened explanation only when
 * Guardian's question review allowed the caller to read it. `new_mint_recommended` is the ending of
 * a `mint_update` whose change belongs in a new build: the reviewed summary of the change and the
 * request the caller could submit for that build.
 */
const BuildBlockedOutcome = Schema.Union(
  Schema.Struct({
    reason: BuildBlocked.fields.reason,
    explanation: Schema.optionalWith(BuildBlocked.fields.explanation, { exact: true }),
  }),
  Schema.Struct({
    reason: Schema.Literal("new_mint_recommended"),
    explanation: Schema.optionalWith(BuildBlocked.fields.explanation, { exact: true }),
    suggestedRequest: Schema.optionalWith(BuildBlocked.fields.explanation, { exact: true }),
  }),
);
type BuildBlockedOutcome = typeof BuildBlockedOutcome.Type;
/**
 * A build the intake capability screen refused before any work: it needs a
 * capability OpenGPT does not have yet. Only the worker sets it; the minter cannot report it.
 * `explanation` is OpenGPT's fixed sentence for the reason; `suggestion` is the screen's checked
 * suggestion, absent when it had none that passed.
 */
const NotSupportedYet = Schema.Struct({
  reason: Schema.Literal("not_supported_yet"),
  reason_code: IntakeReasonCode,
  explanation: BuildBlocked.fields.explanation,
  suggestion: Schema.optionalWith(BuildBlocked.fields.explanation, { exact: true }),
});
/** A blocked build as its job records and shows it: the minter's ending or the intake refusal. */
export const JobBuildBlocked = Schema.Union(BuildBlockedOutcome, NotSupportedYet);
export type JobBuildBlocked = typeof JobBuildBlocked.Type;

/**
 * The minter's `mint_update`: a change to the task's settings that the caller confirmed. It runs
 * after `request_input` when confirmation is needed; `confirmedBy` names the answered questions
 * whose answers confirm it, the caller's pick of an option the minter wrote included. Guardian
 * reviews it, then the host applies an accepted update (`applyTaskUpdate`). `recommend` is the
 * minter's own judgment: `update` keeps the same task and workflow; `new_mint` ends this build
 * blocked and hands the caller `suggestedRequest` for a new one.
 */
export const TaskUpdateRequest = Schema.Struct({
  summary: Schema.String.pipe(Schema.pattern(/\S/), Schema.maxLength(blockedExplanationLimit)),
  changes: Schema.Array(TaskChange).pipe(Schema.minItems(1), Schema.maxItems(8)),
  confirmedBy: Schema.Array(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64))).pipe(
    Schema.maxItems(8),
  ),
  recommend: Schema.Literal("update", "new_mint"),
  suggestedRequest: Schema.optional(
    Schema.String.pipe(Schema.pattern(/\S/), Schema.maxLength(blockedExplanationLimit)),
  ),
});
export type TaskUpdateRequest = typeof TaskUpdateRequest.Type;

/**
 * Every `status` a `mint_update` result carries:
 * - `updated`: Guardian allowed it and the host applied it; the result carries the effective task.
 * - `clarification_required`: Guardian found the caller's confirmation missing or ambiguous, or
 *   found a `recommend: "update"` a new build for the first time since the task last changed, or
 *   the host needs something only the caller has, such as a login for the new site. Nothing
 *   changed.
 * - `reword`: Guardian's feedback, or its new build call on another `recommend: "update"` before
 *   the task changed, after the caller was asked once; nothing changed and the build continues.
 * - `new_mint_recommended`: the minter recommended a new build and Guardian did not object. This
 *   build ends blocked with the recommendation and its suggested request.
 * - `review_unavailable`: the review did not complete; resubmit within the review outage budget.
 * - `update_refused`: the harness or host cannot apply this change to this build, such as a site
 *   change once the build cannot run another live example. Nothing changed.
 * - `review_invalid_outcome`: the review returned an outcome its kind does not accept, even after one
 *   correction. Nothing changed; revise or withdraw the update. A second one in an attempt ends it
 *   incomplete.
 * - `update_invalid`: the request does not decode, a recommended new build has no suggested request,
 *   or screening made its suggested request longer than 500 characters
 *   (`suggested_request_too_long`). Nothing changed.
 */
export const taskUpdateStatuses = [
  "updated",
  "clarification_required",
  "reword",
  "new_mint_recommended",
  "review_unavailable",
  "review_invalid_outcome",
  "update_refused",
  "update_invalid",
] as const;
export type TaskUpdateStatus = (typeof taskUpdateStatuses)[number];

/**
 * One update the host accepted, with the Guardian review that allowed it and the digest of the
 * request that made it, by which the harness knows the same request again, as after a takeover.
 */
export interface AcceptedTaskUpdate extends ReviewedTaskUpdate {
  readonly reviewId?: string;
  readonly requestDigest: string;
}

/**
 * The effective task: the original request with every accepted update applied in order. The
 * intent itself never changes; `updates` carries what changed. `revision` is 0 for the original
 * request and counts accepted updates.
 */
export interface TaskState {
  readonly revision: number;
  readonly effect: "read" | "write";
  readonly siteOrigin?: string;
  readonly businessInput: unknown;
  readonly updates: readonly AcceptedTaskUpdate[];
}

/** A proposed update as the host's Guardian reviews it, against the current effective task. */
export interface TaskUpdateCandidate {
  readonly update: PendingTaskUpdate;
  readonly current: TaskState;
}

/** What the host gets to apply: the update Guardian accepted and the task it makes. */
export interface TaskUpdateApplication {
  readonly current: TaskState;
  /** The effective task after the update, as the harness computed it from `update.changes`. */
  readonly next: TaskState;
  readonly update: AcceptedTaskUpdate;
  /**
   * The harness checkpoint with the update applied (`taskState` is `next`). The host stores it
   * as the attempt's harness snapshot in the same step as its own bindings, so a takeover restores
   * the whole update or none of it; the harness takes the update on only once the host answers
   * `applied`.
   */
  readonly harness: MintHarnessSnapshot;
}

/**
 * How the host answered an accepted update. `notice` is host-authored text the minter reads.
 * - `applied`: the host bound `next` exactly as given and stored `harness` with it.
 * - `clarification_required`: the update needs something only the caller can give before it can
 *   apply, such as a login for the new site the caller has not saved (`login_required`).
 * - `refused`: the host cannot apply it to this build: intake screening refuses the effective task
 *   (`intake_refused`), an existing tool already does it (`duplicate_tool`), the new site cannot
 *   be bound (`site_unavailable`), or the host does not support the change (`change_unsupported`).
 * Nothing changes on either refusal.
 */
export type TaskUpdateHostResult =
  | { readonly outcome: "applied"; readonly notice?: string }
  | {
      readonly outcome: "clarification_required";
      readonly reason: "login_required" | (string & {});
      readonly notice: string;
    }
  | {
      readonly outcome: "refused";
      readonly reason:
        | "intake_refused"
        | "duplicate_tool"
        | "site_unavailable"
        | "change_unsupported"
        | (string & {});
      readonly notice: string;
    };

/**
 * Infrastructure outcomes that end a build incomplete through no choice of the agent. Maintenance
 * requeues such a repair within bounds, except a final one; an agent's own conclusion never
 * carries one. The exception is `publication_unavailable` beside `publicationDenial.reason`
 * `host_owned`: Guardian found a defect in a file the host wrote, which recurs on every build
 * until the host fixes it, so a host treats that outcome as final and never requeues or retries it.
 */
const mintHostFailures = [
  "host_unavailable",
  "publication_unavailable",
  "review_unavailable",
  "capture_unavailable",
  "diagnostic_retention",
  "model_unavailable",
  "model_quota_exhausted",
  // A takeover that could not rejoin its job's resources within the recovery wait.
  "recovery_timeout",
  // A takeover that could not confirm how its predecessor's last step ended.
  "recovery_unconfirmed",
] as const;
type MintHostFailure = (typeof mintHostFailures)[number];

/** The characters Guardian's public reason for a publication denial may hold once screened. */
export const publicReasonLimit = 300;
/**
 * Guardian's finite reason for denying a publication, as a build's result carries it, and its
 * short public reason when it wrote one: a sentence its caller may read, screened like any text
 * that reaches the caller. Its rationale stays private.
 */
export const PublicationDenial = Schema.Struct({
  reason: Schema.optionalWith(PublicationReason, { exact: true }),
  category: Schema.optionalWith(PublicationFinding.fields.category, { exact: true }),
  publicReason: Schema.optionalWith(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(publicReasonLimit)),
    { exact: true },
  ),
});
export type PublicationDenial = typeof PublicationDenial.Type;

/**
 * Why an unpublished build stopped, as one typed code, so a host never reads every ending as a
 * missing publication:
 * - `final_text_without_tool`: the minter answered without a tool call three times in a row.
 * - `turn_budget_spent`: the attempt spent the model calls it may make.
 * - `model_quota_exhausted`: the model provider refused a call because the quota is spent.
 * - `sign_in_failed`: the site could not be signed in, or rejected the login.
 * - `account_locked`: the site said the account is locked, suspended or disabled.
 * - `question_unanswered`: a question the build needed went unanswered.
 * - `owner_declined`: the owner said no to a step the build needs.
 * - `owner_ended`: the owner chose in an answer to end the build.
 * - `site_lacks_capability`, `site_declined`, `site_unavailable`, `policy`, `host_refused`,
 *   `caller_input`: the minter's blocked ending of the same name.
 * - `host_unavailable`: the host, not the task, ended the build, such as when Guardian twice returned
 *   no outcome its review allows (`InvalidOutcome`).
 */
export const mintStopReasons = [
  "final_text_without_tool",
  "turn_budget_spent",
  "model_quota_exhausted",
  "sign_in_failed",
  "account_locked",
  "question_unanswered",
  "owner_declined",
  "owner_ended",
  "site_lacks_capability",
  "site_declined",
  "site_unavailable",
  "policy",
  "host_refused",
  "caller_input",
  "host_unavailable",
] as const;
export const MintStopReason = Schema.Literal(...mintStopReasons);
export type MintStopReason = typeof MintStopReason.Type;

export type MintOutcome = {
  readonly rejectedCredential?: typeof CredentialRejectedField.Type;
  readonly capability_review?: CapabilityReview;
  readonly build: "published" | "incomplete";
  /** Set by the harness only when infrastructure, not the agent, ended the build. */
  readonly hostFailure?: MintHostFailure;
  /**
   * Set by the trusted worker or harness, never by model diagnostics. `sign_in_unavailable`: a
   * sign-in failed or was refused once no further sign-in could run in the attempt.
   */
  readonly recoveryReason?:
    | "reauthentication_required"
    | "login_identity_conflict"
    | "login_check_unavailable"
    | "sign_in_unavailable";
  /**
   * Set by the harness when the minter ended the build blocked: its task is impossible as asked,
   * for a typed reason, with the screened explanation when Guardian allowed its caller to read
   * it; or by the worker when the intake screen refused it as not supported yet. Not a failure.
   */
  readonly blocked?: JobBuildBlocked;
  /**
   * Set by the harness when the example's question went unanswered: the build ends as
   * `no_response`, saying whether a step may already have changed the site.
   */
  readonly noResponse?: { readonly possibleCommit: boolean };
  /**
   * Set by the worker on an unpublished build one of whose live write steps committed or may
   * have, so its caller is told to check the website before trying again.
   */
  readonly possibleCommit?: true;
  readonly publicationRef?: string;
  readonly artifact?: MintArtifact;
  /**
   * Set by the harness when an unpublished build's last publication was a Guardian denial:
   * Guardian's finite reason and its first finding's category, never its rationale.
   */
  readonly publicationDenial?: PublicationDenial;
  /** Site defaults the build took instead of asking, as screened entries without private data. */
  readonly assumptions?: readonly BuildAssumption[];
  /**
   * Set by the harness on an unpublished build whose ending it can name; see `mintStopReasons`.
   * Absent on a published build, and on an ending none of them names.
   */
  readonly stopReason?: MintStopReason;
  /**
   * The minter's last answer when it stopped without a tool call (`final_text_without_tool`),
   * screened for credentials and host-private values and kept only when Guardian's question
   * review allowed its caller to read it, as a blocked explanation is.
   */
  readonly stopExplanation?: string;
  /** Host-only references: preserve first execution independently of build success. */
  readonly example?: ExecutionEvidence;
  readonly currentInvocation?: CurrentInvocation;
  readonly executions: readonly ExecutionEvidence[];
  /**
   * Every execution Guardian labelled `write`, with the outcome reviewer's newest assessment.
   * A write the reviewer never settled is `may_have_applied`; publication never waited for it.
   */
  readonly writes?: readonly WriteOutcome[];
  readonly summary: string;
  readonly diagnostics: readonly string[];
};

/** The host's answer to `abandon_sign_in` (`MintDependencies.abandonSignIn`). */
export type AbandonSignInResult =
  | { readonly outcome: "abandoned" }
  | {
      readonly outcome: "refused";
      /** Such as `write_build`, `sign_in_required` or `signed_in`. */
      readonly reason: "write_build" | "sign_in_required" | "signed_in" | (string & {});
      /** What the minter reads about the refusal; screened before it does. */
      readonly notice?: string;
    };

/** One site default a build took instead of asking. */
export interface BuildAssumption {
  readonly kind: "site_default";
  readonly subject: string;
  readonly choice: string;
}

/**
 * A confirm question as the minting agent proposes it. `endsBuild` marks one that asks whether to
 * end the build: its yes is the owner's choice to end it (`owner_ended`), and its no means keep
 * going, never a declined step (`owner_declined`). `confirmsReview` marks one that asks the owner
 * to confirm the step an execution review refused for want of that confirmation, by that review's
 * `reviewId`: the review of the question is told, and the owner's yes then authorizes exactly that
 * step. The host keeps both marks to itself, so the request the caller reads is a plain confirm.
 */
export const ProposedConfirmQuestion = Schema.Struct({
  ...ConfirmQuestion.fields,
  endsBuild: Schema.optional(Schema.Boolean),
  confirmsReview: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200))),
});

/**
 * What the agent may ask with request_input: typed questions of every kind but a login, which
 * only the host raises. The request's own checks (unique ids, bounds) run when the host asks it.
 * The caller may answer any choice in their own words, so the agent never decides it
 * (`withOwnWords`).
 */
export const AgentRequest = Schema.Struct({
  questions: Schema.Array(
    Schema.Union(
      ProposedChoiceQuestion,
      ProposedMultiChoiceQuestion,
      TextQuestion,
      ProposedConfirmQuestion,
      SecretQuestion,
    ),
  ).pipe(Schema.minItems(1), Schema.maxItems(8)),
  notice: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(16_384))),
});

/** What the agent asks: the request without the host's id and source. */
export type AgentInputRequest = Pick<InputRequest, "notice" | "questions">;

/**
 * A question as the host asks it for the minting agent: the caller may answer every choice and
 * multiple choice in their own words, with their own text instead of an option (or beside a
 * multiple choice's picks) or a note beside the options they pick, whatever the agent proposed.
 */
export const withOwnWords = <Q extends { readonly type: string }>(question: Q): Q =>
  question.type === "choice" || question.type === "multi_choice"
    ? { ...question, allowOther: true, allowNote: true }
    : question;

/** One choice question whose only options are `read` and `write`, with no notice: the shape of the effect question. */
export const isReadOrWriteChoice = (submitted: AgentInputRequest): boolean => {
  const [only] = submitted.questions;
  return (
    only?.type === "choice" &&
    submitted.questions.length === 1 &&
    submitted.notice === undefined &&
    only.options
      .map((option) => option.id)
      .sort()
      .join(",") === "read,write"
  );
};

export interface MintActions {
  readonly retainCapture?: (input: unknown) => Effect.Effect<string, MintFailure>;
  readonly readSource: (
    path: string,
    range?: { readonly offset?: number; readonly limit?: number },
  ) => Effect.Effect<string, MintFailure>;
  /**
   * Reviews and runs one step. `agentNote` is the agent's own description of it, its execute
   * call's intent, which Guardian reads as untrusted context and never as authority.
   */
  readonly execute: (input: unknown, agentNote?: string) => Effect.Effect<string, MintFailure>;
  readonly finish: (input: unknown) => Effect.Effect<string, MintFailure>;
  /** Asks the caller in place and returns their answers; the attempt continues. */
  readonly requestInput: (input: unknown) => Effect.Effect<string, MintFailure>;
  /** Ends the build blocked (`BuildBlocked`); absent on a question-only turn. */
  readonly reportBlocked?: (input: unknown) => Effect.Effect<string, MintFailure>;
  /**
   * Changes the task's settings (`TaskUpdateRequest`), with a `TaskUpdateStatus` result; absent on
   * a question-only turn and where the host has no task update hooks.
   */
  readonly updateTask?: (input: unknown) => Effect.Effect<string, MintFailure>;
  /** Read-only CAPTCHA state for the host's current browser; absent when unsupported. */
  readonly captchaState?: (input: unknown) => Effect.Effect<string, MintFailure>;
  /** The agent's troubleshooting request for a new browser; absent where the host has none. */
  readonly requestBrowserRecovery?: (input: unknown) => Effect.Effect<string, MintFailure>;
  /** Tests a signed-in marker; reports the check unavailable where the host has none. */
  readonly checkSignedInMarker?: (input: unknown) => Effect.Effect<string, MintFailure>;
  /** A read's planned live tests (`LiveTestsRequest`); absent where the host runs none. */
  readonly liveTests?: (input: unknown) => Effect.Effect<string, MintFailure>;
  /** Gives up signing in, so the build goes on signed out; absent where the host has no hook. */
  readonly abandonSignIn?: (input: unknown) => Effect.Effect<string, MintFailure>;
}

/**
 * A host's descriptions of the optional tools it offers, such as which of its own skills to read
 * first. A tool the host describes gets that text instead of the generic description.
 */
export interface HostToolDescriptions {
  readonly captchaState?: string;
  readonly requestBrowserRecovery?: string;
  readonly checkSignedInMarker?: string;
  readonly abandonSignIn?: string;
}

export interface MintTurn {
  readonly recovery?: MintAgentRecovery;
  /**
   * The minter's whole history for the outcome reviewer, turns before a compaction included. The
   * model stores in `archive` the items before a compaction as a new run segment leaves them out,
   * and registers with `live` a reader of what its run state holds, once, before its first
   * request. The harness's archive buffers a range it could not store durably and records the
   * gap, so its append never needs to end the attempt.
   */
  readonly history?: {
    readonly archive: MinterHistoryArchive;
    readonly live: (read: () => LiveMinterHistory) => void;
  };
  /** Attempt-scoped bridge for SDK Promise callbacks; closes and joins before returning an outcome. */
  readonly runTool: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  readonly input: string;
  /** Host-enforced first turn of an unanswered Dashboard build: only request_input is offered. */
  readonly effectQuestion?: true;
  /** The site signs in by host autofill: `execute` offers `signInStep` on authenticate. */
  readonly autofillSignIn?: true;
  readonly deadline?: Deadline;
  readonly session: SandboxSession;
  /** The workspace AGENTS.md: the always-on context the model receives as its instructions. */
  readonly instructions: string;
  /** `MintDependencies.staticContext`: host text sent right after the instructions. */
  readonly staticContext?: readonly string[];
  /** `MintDependencies.promptCacheKey`: sent as `prompt_cache_key` on every request. */
  readonly promptCacheKey?: string;
  readonly skills: readonly SkillDescriptor[];
  readonly actions: MintActions;
  readonly hostToolDescriptions?: HostToolDescriptions;
  /**
   * The host's own wording of the note the minter gets after a compaction, given the skills it
   * read with `read_source` before it, in catalog order, never none. Absent, the minter's default
   * note.
   */
  readonly compactionSkillsNote?: (skills: readonly string[]) => string;
  readonly screen: (value: unknown) => Effect.Effect<string, MintFailure>;
  readonly isComplete: () => boolean;
  readonly reportDiagnostic: (value: unknown) => Effect.Effect<void, MintFailure>;
  readonly reportTrace?: (
    value: unknown,
    timing?: ModelDiagnosticTiming,
  ) => Effect.Effect<void, MintFailure>;
  /** Required traced original model/tool record. Resolves only once its archive
   * reference is usable; failure must stop further provider or tool dispatch. */
  readonly retainRuntimeRecord?: (record: RuntimeRecordInput) => Effect.Effect<void, MintFailure>;
  /** Finite lifecycle timing for telemetry. Never blocks or fails the model loop. */
  readonly observeTrace?: (timing: ModelDiagnosticTiming) => void;
  /**
   * Screened guidance for a final answer with no tool call while something the agent can get past
   * is unresolved, such as a failed sign-in, or undefined. The harness gives it once per failure,
   * so the loop returns it before the repeated-final guard can end the attempt. A sign-in the build cannot get past records its outcome here instead, which
   * `isComplete` then reports, so the loop ends without another prompt.
   */
  readonly unresolvedGuidance?: () => Effect.Effect<string | undefined, MintFailure>;
}

export interface MintModel {
  readonly run: (turn: MintTurn) => Effect.Effect<
    {
      readonly history: readonly AgentInputItem[];
      /** The model kept giving final answers with no tool call, so the loop stopped. */
      readonly stopReason?: "repeated_final_without_tool";
      /** With `stopReason`: the model's last final answer, unscreened. */
      readonly finalText?: string;
    },
    MintFailure
  >;
}

type MintExecutionAvailability = "open" | "host_unavailable";

/** Fixed keys with literal, boolean or numeric values only. */
export type FiniteDiagnostic = Readonly<Record<string, string | number | boolean>>;
/** Host-owned entry navigation state for a fresh attempt; never generated by the model. */
export type MintEntryNavigation =
  | {
      readonly state: "opened";
      readonly outcome: "ready" | "http_error";
      readonly requestedUrl: string;
      readonly resolvedUrl: string;
      readonly redirects: readonly { readonly url: string; readonly status: number | null }[];
      readonly status: number | null;
      /** Kernel's egress proxy, not the site, answered the entry at least once. A retry that
       * fails keeps the proxy response, so an unopened entry never carries this. */
      readonly egressProxy?: {
        readonly responder: string;
        readonly error: string;
        readonly retries: number;
        readonly outcome: "recovered" | "persisted" | "not_retried";
        readonly reason?: string;
        readonly retryInterrupted?: true;
        readonly notice: string;
      };
      readonly instruction?: string;
    }
  | {
      readonly state: "not_opened";
      readonly outcome: "failed" | "timeout" | "skipped";
      /** `prior_effect`: the host skipped the entry because an earlier attempt of this job already ran on the website. */
      readonly reason?: "prior_effect";
      readonly requestedUrl: string;
      readonly resolvedUrl?: string;
      readonly redirects?: readonly { readonly url: string; readonly status: number | null }[];
    }
  /**
   * The browser was replaced: by managed authentication (`sign_in`), where `page` is the page the
   * agent was on, when it was on the site and loaded, else the login page; or by a recovery
   * (`recovery`), where `page` is the page a read's replacement reopened: the last page the site
   * served the browser it replaced. A host may give its own reason and explain it in
   * `instruction`.
   */
  | {
      readonly state: "replaced";
      readonly reason: "sign_in" | "recovery" | (string & {});
      readonly requestedUrl?: string;
      readonly page?: string;
      /** Host-authored explanation of the browser replacement. */
      readonly instruction?: string;
    };

/**
 * The entry state the minter reads, from how the host's load of the caller's page went
 * (`EntryNavigationOutcome`), or `open_failed` when the host's browser did not open. The caller's
 * own page URLs are shown to the model exactly as given; they are intentionally not screened or
 * masked. Undefined until the host has attempted the entry.
 */
export const mintEntryNavigation = (
  entryUrl: string,
  outcome: EntryNavigationOutcome | "open_failed" | undefined,
): MintEntryNavigation | undefined => {
  if (outcome === undefined) return undefined;
  if (outcome === "open_failed")
    return { state: "not_opened", outcome: "failed", requestedUrl: entryUrl };
  if (outcome.outcome === "ready" || outcome.outcome === "http_error")
    return {
      state: "opened",
      outcome: outcome.outcome,
      requestedUrl: entryUrl,
      resolvedUrl: outcome.resolvedUrl,
      redirects: outcome.redirects,
      status: outcome.status,
    };
  return {
    state: "not_opened",
    outcome: outcome.outcome,
    requestedUrl: entryUrl,
    ...(outcome.outcome === "skipped"
      ? {}
      : { resolvedUrl: outcome.resolvedUrl, redirects: outcome.redirects }),
  };
};

/** The durable journal of one logical example execution. */
export interface ExampleJournal {
  readonly record: (evidence: ExecutionEvidence) => Effect.Effect<void, MintFailure>;
  readonly stopped: Effect.Effect<void, MintFailure>;
}

/**
 * One Guardian denial or escalation in this build: which review decided it, its outcome and
 * reason, and the rationale and finding explanations Guardian wrote, screened as they are for the
 * minter and capped.
 */
export interface LedgerDenial {
  readonly review: "execution" | "live_tests" | "publication";
  /** When the harness received it, in epoch milliseconds. */
  readonly decidedAt: number;
  readonly outcome?: "deny" | "escalate";
  /** A publication review's finite reason. */
  readonly reason?: string;
  readonly reviewId?: string;
  readonly rationale: string;
  readonly findings?: readonly string[];
  /** Findings past the ledger's bound, left out. */
  readonly omittedFindings?: number;
}

export const LedgerDenial: Schema.Schema<LedgerDenial> = Schema.Struct({
  review: Schema.Literal("execution", "live_tests", "publication"),
  decidedAt: Schema.NonNegativeInt,
  outcome: Schema.optionalWith(Schema.Literal("deny", "escalate"), { exact: true }),
  reason: Schema.optionalWith(Schema.String, { exact: true }),
  reviewId: Schema.optionalWith(Schema.String, { exact: true }),
  rationale: Schema.String,
  findings: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
  omittedFindings: Schema.optionalWith(Schema.NonNegativeInt, { exact: true }),
});

export interface MintHarnessSnapshot {
  readonly executions: readonly ExecutionEvidence[];
  /**
   * Each live test case's latest result on the Playwright version, so a takeover keeps them.
   * Optional, so a rollout's old and new workers each restore the other's checkpoint.
   */
  readonly liveTests?: readonly LiveTestRecord[];
  /**
   * The same for the HTTP version. A field of its own, so a worker from an older release, which
   * keeps no HTTP results, drops them rather than restoring them as the Playwright version's.
   */
  readonly liveTestsHttp?: readonly LiveTestRecord[];
  /**
   * Whether the attempt ran out of time for live tests: a batch refused for time, or a case
   * stopped by a batch deadline the attempt's end set.
   */
  readonly liveTestsOutOfTime?: boolean;
  /**
   * The distinct inputs a signed-in read ran live tests on in this attempt (`testInputKey`), so a
   * takeover keeps its count against `signedInTestInputLimit`. A worker from an older release
   * drops it, and runs no live test for a signed-in read.
   */
  readonly signedInTestInputs?: readonly string[];
  /**
   * The writes Guardian labelled that the outcome reviewer tracks, with their entrypoints and
   * source digests, so a takeover tracks them, and refuses their repeats, even when the
   * reviewer's own best-effort save failed.
   */
  readonly outcomeWrites?: readonly OutcomeWrite[];
  readonly purposes: readonly {
    readonly executionId: string;
    readonly purpose: ExecutionRequest["purpose"] | "command";
    /** The task revision it ran under, once an update had applied; absent for the original. */
    readonly taskRevision?: number;
  }[];
  readonly diagnostics: readonly string[];
  readonly exampleId?: string;
  readonly exampleClaimed: boolean;
  readonly writeSession: "none" | "open" | "closed";
  readonly unavailableOutputRefusals: number;
  readonly terminal?: Pick<
    MintOutcome,
    | "build"
    | "publicationRef"
    | "artifact"
    | "assumptions"
    | "summary"
    | "recoveryReason"
    | "hostFailure"
    | "rejectedCredential"
    | "stopReason"
    | "stopExplanation"
  > & {
    /** Only the minter's blocked ending; the intake refusal ends a build before any harness. */
    readonly blocked?: BuildBlockedOutcome;
  };
  readonly noResponse?: { readonly possibleCommit: boolean };
  readonly unavailableCauseRecorded: boolean;
  readonly reviewUnavailableRetries: {
    readonly execution: number;
    readonly publication: number;
    readonly question: number;
    /** Optional, so a rollout's old and new workers each restore the other's checkpoint. */
    readonly update?: number;
  };
  /** When the current run of review outages began, in epoch milliseconds. */
  readonly reviewOutageStartedAt?: number;
  /**
   * Reviews in this attempt that ended `InvalidOutcome`; a second ends the attempt. Optional, so
   * a rollout's old and new workers each restore the other's checkpoint.
   */
  readonly invalidOutcomes?: number;
  /**
   * The decision ledger's denials so far. Optional, so a rollout's old and new workers each
   * restore the other's checkpoint; one restored without it marks the ledger partial.
   */
  readonly decisionLedger?: {
    readonly denials: readonly LedgerDenial[];
    readonly omittedDenials?: number;
    readonly partial?: true;
  };
  /**
   * The current review outage is a blocked explanation's, which `report_blocked` resubmits.
   * Optional, so an older worker ignores it and a newer one restores an older checkpoint.
   */
  readonly blockedReviewUnavailable?: true;
  /**
   * Guardian refused an execution with a refusal it did not mark `correctable`, or refused a
   * publication for a reason no correction gets past (`publicationRefusalUnfixable`), in this
   * attempt: the refusal a `policy` block needs. A publication denial that names a correction, or
   * an execution refusal marked `correctable`, never sets it. A checkpoint from an older worker
   * set it on any execution refusal, which a newer one restores as it is.
   */
  readonly guardianRefused?: true;
  /**
   * A host check refused a step the build needs in this attempt: a publication its checks refused,
   * a sign-in the host refused, or a task update the host refused. The refusal a `host_refused`
   * block needs. A later finish_build that got past the host's checks to Guardian's review clears
   * it. Optional, so an older worker ignores it and a newer one restores an older checkpoint.
   */
  readonly hostRefused?: true;
  /**
   * Each host check whose refusal `hostRefused` stands on, in the order they refused, as
   * `{ refusal, beforeSignIn }`: the check (`HostRefusalSource`), and `beforeSignIn: true` once a
   * later authenticate may have sent the login, so a sign-in step's refusal no longer keeps a
   * `host_refused` ending apart from an unconfirmed sign-in. Optional, so an older worker ignores
   * it and a newer one restores an older checkpoint without it. Unknown here and decoded
   * leniently when restored, entry by entry: a `source` or reason a later release adds would
   * otherwise fail an older worker's decode of the whole checkpoint during a rollout, so an entry
   * it cannot read restores as no source (`unrecorded`).
   */
  readonly hostRefusalSources?: unknown;
  /**
   * A host check refused a step earlier in this attempt, and a later finish_build got past the
   * host's checks to Guardian's review, clearing `hostRefused`: a `host_refused` block is refused
   * as `host_refusal_passed` until a host check refuses a step again. Optional, so an older worker
   * ignores it and a newer one restores an older checkpoint.
   */
  readonly hostRefusalPassed?: true;
  /**
   * The host's latest answer to `signInDestinationRefused`, read after the attempt's latest
   * authenticate: it refused a sign-in screen at its destination check, and no sign-in verified
   * and no later screen that takes a password or code passed that check since. A `host_refused`
   * block stands on it. Optional, so
   * an older worker ignores it and a newer one restores an older checkpoint.
   */
  readonly signInDestinationRefused?: true;
  /**
   * Unanswered questions handed back to the minter as no answer in this build, which a
   * `question_unanswered` block stands on. Optional so a rollout's old and new workers each restore the other's
   * checkpoint.
   */
  readonly noAnswerHandBacks?: number;
  /**
   * The host obtained a login partway (`requestLogin` answered `supplied` or `held`), so a
   * question left unanswered after it ends the build. Optional for the same reason.
   */
  readonly loginHeld?: true;
  /**
   * The owner declined a login request (`LoginDecline`): no sign-in runs in this build, and an
   * `owner_declined` block may stand on it. Optional for the same reason.
   */
  readonly loginDeclined?: LoginDecline;
  /**
   * The build gave up signing in (`abandon_sign_in`, or an applied `login` `signed_out` update):
   * no sign-in runs and no login is asked for until an accepted `login` `sign_in` or
   * `different_login` update. Optional for the same reason.
   */
  readonly signInAbandoned?: true;
  /**
   * The build's latest sign-in on its current site may have sent the login and nothing confirmed
   * it, which ends a blocked report as sign-in unavailable. Optional for the same reason.
   */
  readonly signInUnconfirmed?: true;
  /**
   * Every refusal `guardianRefused` stands on is Guardian's of an authenticate step, with no
   * confirmed sign-in on the current site since, which ends a blocked report that stands on no
   * host refusal as sign-in unavailable. Optional for the same reason.
   */
  readonly signInRefusalOnly?: true;
  readonly destinationEvidenceRefusals: number;
  readonly inputFeedbackRounds: number;
  readonly inputFeedbackPublicTool: boolean;
  readonly inputFeedbackCoverage: string;
  readonly providerUnavailableRetries: number;
  /** When the current run of execution-provider outages began, in epoch milliseconds. */
  readonly providerOutageStartedAt?: number;
  /**
   * Deprecated: nothing reads it. The harness always writes 0 only so an older worker, whose
   * schema requires it, can restore a newer checkpoint across a release. Remove it once no older
   * release runs.
   */
  readonly diagnosticRetentionRetries?: number;
  readonly executionClosed: boolean;
  readonly captchaChecks: number;
  /**
   * The effective task once an update applied; absent while the original request stands. Optional
   * beside the fields every worker version reads, so a rollout's old and new workers each restore
   * the other's checkpoint; an older checkpoint has none.
   */
  readonly taskState?: TaskState;
  /**
   * The caller's answers to this build's questions as Guardian reads them, by question id, latest
   * last: what `mint_update` may cite as confirmation. Optional for the same reason.
   */
  readonly answeredQuestions?: readonly {
    readonly id: string;
    readonly answer: AnsweredQuestion;
  }[];
  /**
   * Sign-in is unavailable in this build and its outcome waits while a retained receipt may still
   * publish: the answer a later authenticate gets again, and that outcome. Optional, so a
   * rollout's old and new workers each restore the other's checkpoint.
   */
  readonly signInUnavailable?: {
    readonly answer: string;
    readonly outcome: NonNullable<MintHarnessSnapshot["terminal"]>;
  };
  /** The attempt's last publication was a Guardian denial; optional for the same reason. */
  readonly publicationDenial?: PublicationDenial;
  /**
   * The last completed publication review returned input feedback: its categories and screened
   * rationale, kept only for a build with no fallback, which ends with them. Optional for the
   * same reason.
   */
  readonly inputFeedbackReview?: InputFeedbackReview;
}

/** The effective task as a harness checkpoint keeps it. */
const TaskStateSchema: Schema.Schema<TaskState> = Schema.Struct({
  revision: Schema.NonNegativeInt,
  effect: Schema.Literal("read", "write"),
  siteOrigin: Schema.optionalWith(Schema.String, { exact: true }),
  businessInput: Schema.Unknown,
  updates: Schema.Array(
    Schema.Struct({
      revision: Schema.Int.pipe(Schema.positive()),
      summary: Schema.String,
      changes: Schema.Array(TaskChange),
      confirmation: Schema.Array(AnsweredQuestion),
      reviewId: Schema.optionalWith(Schema.String, { exact: true }),
      requestDigest: Schema.String,
    }),
  ),
});

/** How a build ended, as a harness checkpoint keeps it. */
const HarnessTerminal = Schema.Struct({
  rejectedCredential: Schema.optionalWith(CredentialRejectedField, { exact: true }),
  build: Schema.Literal("published", "incomplete"),
  summary: Schema.String,
  publicationRef: Schema.optionalWith(Schema.String, { exact: true }),
  artifact: Schema.optionalWith(
    Schema.Struct({
      files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
      entrypoint: Schema.String,
      inputSchema: Schema.Unknown,
      outputSchema: Schema.Unknown,
    }),
    { exact: true },
  ),
  assumptions: Schema.optionalWith(
    Schema.Array(
      Schema.Struct({
        kind: Schema.Literal("site_default"),
        subject: Schema.String,
        choice: Schema.String,
      }),
    ),
    { exact: true },
  ),
  recoveryReason: Schema.optionalWith(
    Schema.Literal(
      "reauthentication_required",
      "login_identity_conflict",
      "login_check_unavailable",
      "sign_in_unavailable",
    ),
    { exact: true },
  ),
  hostFailure: Schema.optionalWith(Schema.Literal(...mintHostFailures), { exact: true }),
  // Optional, and dropped as an excess field by an older worker's decode, so a rollout's old and
  // new workers each restore the other's checkpoint, except a terminal whose blocked reason is
  // one an older worker does not know (`owner_declined`, `question_unanswered`, `site_declined`,
  // `host_refused`, `owner_ended`, `site_unavailable`, `caller_input`): that one does not decode
  // there.
  blocked: Schema.optionalWith(BuildBlockedOutcome, { exact: true }),
  // Optional, and dropped by an older worker's decode.
  stopReason: Schema.optionalWith(MintStopReason, { exact: true }),
  stopExplanation: Schema.optionalWith(Schema.String, { exact: true }),
});

export const MintHarnessSnapshot: Schema.Schema<MintHarnessSnapshot> = Schema.Struct({
  executions: Schema.Array(ExecutionEvidence),
  liveTests: Schema.optionalWith(Schema.Array(LiveTestRecord), { exact: true }),
  liveTestsHttp: Schema.optionalWith(Schema.Array(LiveTestRecord), { exact: true }),
  liveTestsOutOfTime: Schema.optionalWith(Schema.Boolean, { exact: true }),
  signedInTestInputs: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
  outcomeWrites: Schema.optionalWith(Schema.Array(OutcomeWrite), { exact: true }),
  purposes: Schema.Array(
    Schema.Struct({
      executionId: Schema.String,
      purpose: Schema.Union(ExecutionRequest.fields.purpose, Schema.Literal("command")),
      taskRevision: Schema.optionalWith(Schema.Int.pipe(Schema.positive()), { exact: true }),
    }),
  ),
  diagnostics: Schema.Array(Schema.String),
  exampleId: Schema.optionalWith(Schema.String, { exact: true }),
  exampleClaimed: Schema.Boolean,
  writeSession: Schema.Literal("none", "open", "closed"),
  unavailableOutputRefusals: Schema.NonNegativeInt,
  terminal: Schema.optionalWith(HarnessTerminal, { exact: true }),
  noResponse: Schema.optionalWith(Schema.Struct({ possibleCommit: Schema.Boolean }), {
    exact: true,
  }),
  unavailableCauseRecorded: Schema.Boolean,
  reviewUnavailableRetries: Schema.Struct({
    execution: Schema.NonNegativeInt,
    publication: Schema.NonNegativeInt,
    question: Schema.NonNegativeInt,
    update: Schema.optionalWith(Schema.NonNegativeInt, { exact: true }),
  }),
  reviewOutageStartedAt: Schema.optionalWith(Schema.NonNegativeInt, { exact: true }),
  invalidOutcomes: Schema.optionalWith(Schema.NonNegativeInt, { exact: true }),
  decisionLedger: Schema.optionalWith(
    Schema.Struct({
      denials: Schema.Array(LedgerDenial),
      omittedDenials: Schema.optionalWith(Schema.NonNegativeInt, { exact: true }),
      partial: Schema.optionalWith(Schema.Literal(true), { exact: true }),
    }),
    { exact: true },
  ),
  blockedReviewUnavailable: Schema.optionalWith(Schema.Literal(true), { exact: true }),
  guardianRefused: Schema.optionalWith(Schema.Literal(true), { exact: true }),
  hostRefused: Schema.optionalWith(Schema.Literal(true), { exact: true }),
  hostRefusalSources: Schema.optionalWith(Schema.Unknown, { exact: true }),
  hostRefusalPassed: Schema.optionalWith(Schema.Literal(true), { exact: true }),
  signInDestinationRefused: Schema.optionalWith(Schema.Literal(true), { exact: true }),
  noAnswerHandBacks: Schema.optionalWith(Schema.NonNegativeInt, { exact: true }),
  loginHeld: Schema.optionalWith(Schema.Literal(true), { exact: true }),
  loginDeclined: Schema.optionalWith(LoginDecline, { exact: true }),
  signInAbandoned: Schema.optionalWith(Schema.Literal(true), { exact: true }),
  signInUnconfirmed: Schema.optionalWith(Schema.Literal(true), { exact: true }),
  signInRefusalOnly: Schema.optionalWith(Schema.Literal(true), { exact: true }),
  destinationEvidenceRefusals: Schema.NonNegativeInt,
  inputFeedbackRounds: Schema.NonNegativeInt,
  inputFeedbackPublicTool: Schema.Boolean,
  inputFeedbackCoverage: Schema.String,
  providerUnavailableRetries: Schema.NonNegativeInt,
  providerOutageStartedAt: Schema.optionalWith(Schema.NonNegativeInt, { exact: true }),
  // Deprecated, written as 0 for older workers and ignored on read; see the interface.
  diagnosticRetentionRetries: Schema.optionalWith(Schema.NonNegativeInt, { exact: true }),
  executionClosed: Schema.Boolean,
  captchaChecks: Schema.NonNegativeInt,
  taskState: Schema.optionalWith(TaskStateSchema, { exact: true }),
  answeredQuestions: Schema.optionalWith(
    Schema.Array(Schema.Struct({ id: Schema.String, answer: AnsweredQuestion })),
    { exact: true },
  ),
  signInUnavailable: Schema.optionalWith(
    Schema.Struct({ answer: Schema.String, outcome: HarnessTerminal }),
    { exact: true },
  ),
  publicationDenial: Schema.optionalWith(PublicationDenial, { exact: true }),
  inputFeedbackReview: Schema.optionalWith(
    Schema.Struct({
      categories: Schema.Array(PublicationFinding.fields.category),
      rationale: Schema.String,
    }),
    { exact: true },
  ),
});

/**
 * How the minter can go on after a publication decision:
 * - `none`: it published.
 * - `retry`: a publication dependency stayed unavailable; call `finish_build` again.
 * - `correct_source`: fix the source, contract or metadata, then call again without running the
 *   write or example again.
 * - `new_observation`: run a read or a live test first, never a completed write again.
 * - `guardian_feedback`: act on Guardian's rationale and findings.
 * - `write_completion`: the requested write was not demonstrated; continue the remaining
 *   authorized work or ask about revising incompatible inputs.
 * - `ended`: the decision ended the build.
 */
export type PublicationRecovery =
  | "none"
  | "retry"
  | "correct_source"
  | "new_observation"
  | "guardian_feedback"
  | "write_completion"
  | "ended";

/**
 * One publication decision, a refusal or a publication, as typed host evidence. The harness
 * writes it, never the agent, so a review reads what the host decided instead of the agent's
 * account of it. Every field but `instruction` is finite host metadata: no source, output or
 * rationale text.
 */
export interface PublicationDecision {
  /** The harness's reference for this decision, unique in the build; tool results carry it. */
  readonly decisionId: string;
  readonly outcome: "published" | "refused";
  /** `Published`, or the refusal's `MintFailure` code. */
  readonly code: MintFailure["code"] | "Published";
  /**
   * The refusal's finite reason: a `MintFailure` reason such as `write_not_submitted`, Guardian's
   * publication reason, or one of the harness's own, such as `missing_receipt`.
   */
  readonly reason?: string;
  /** The retained execution the publication named, when the build holds it. */
  readonly executionId?: string;
  /** The Guardian publication review that decided it, when one did. */
  readonly reviewId?: string;
  /** When the harness decided, in epoch milliseconds. */
  readonly decidedAt: number;
  /**
   * The finite checks that refused it: the reason, a registry issue, the publication gate's check,
   * a route evidence gap, `InvalidOutcome` for a review whose outcome Guardian kept refusing and
   * Guardian's finding categories. Empty for a publication.
   */
  readonly failedChecks: readonly string[];
  readonly recovery: PublicationRecovery;
  /**
   * A refusal's instruction as `finish_build` gave it to the minter, the host's own account of
   * what the refusal requires, screened and capped. Absent for a publication, a refusal the
   * answer carried no instruction for, and a decision recorded before hosts kept it.
   */
  readonly instruction?: string;
}

/**
 * Where a host keeps publication decisions as indexed evidence. The harness records each decision
 * as it makes it, and lists them for the reviews of a blocked explanation and of a question.
 */
export interface PublicationDecisionLog {
  /** Keeps one decision, indexed by `decisionId`. A failure is a recorded gap; the build goes on. */
  readonly record: (decision: PublicationDecision) => Effect.Effect<void, MintFailure>;
  /** This build's decisions so far, oldest first, a takeover's predecessor's included. */
  readonly list: Effect.Effect<readonly PublicationDecision[], MintFailure>;
}

/**
 * A live test case whose latest result did not pass. The verdict is the host's judgment; what the
 * case threw is only what the agent's tool code reported, screened and capped.
 */
export interface LedgerTestFailure {
  /** The agent's own name for the case. */
  readonly caseId: string;
  /** The entrypoint the case ran, which names its version. */
  readonly entrypoint?: string;
  readonly verdict: "fail" | "inconclusive";
  /** The host's reading of a result the tool returned or the host stopped, when it threw nothing. */
  readonly got?: string;
  /** The error class and message the tool threw: the tool's account, never a host fact. */
  readonly toolReported?: { readonly errorClass?: string; readonly message?: string };
  /** A failure the minter replaced by changing the case, or that passed when run again. */
  readonly retired?: true;
}

/**
 * The harness's own record of what this build's reviews decided and its live tests showed, for
 * the review of a blocked explanation, so the review does not depend on what Guardian's
 * conversation still holds. Bounded: the latest denials and failing cases, with counts of what
 * the bound left out.
 */
export interface DecisionLedger {
  readonly denials: readonly LedgerDenial[];
  readonly omittedDenials?: number;
  /**
   * The attempt restored a checkpoint that kept no ledger, so earlier denials may be missing: an
   * absent denial proves nothing.
   */
  readonly partial?: true;
  /** Each case's latest verdict, counted over both versions. */
  readonly testCounts?: {
    readonly pass: number;
    readonly fail: number;
    readonly inconclusive: number;
  };
  readonly testFailures: readonly LedgerTestFailure[];
  readonly omittedTestFailures?: number;
  /**
   * The host's latest refusals of a live test batch or an execution, such as a cap on live runs:
   * the tool refused, the failure code or status, the screened reason and when, in ISO time.
   */
  readonly hostRefusals?: readonly {
    readonly tool: "live_tests" | "execute";
    readonly code: string;
    readonly reason: string;
    readonly atUtc: string;
  }[];
  /**
   * Each no-match case's latest verdict, a pass included: a case that expects no results, or one
   * marked `noMatch`, with a short screened excerpt of its output.
   */
  readonly noMatchCases?: readonly {
    readonly caseId: string;
    readonly verdict: LiveTestRecord["verdict"];
    readonly excerpt?: string;
  }[];
}

/**
 * A question the build's owner left unanswered where the build would otherwise end as
 * `no_response`, offered to `MintDependencies.suspendUnanswered`, or the minter's own question it
 * ended the build on, offered to `MintDependencies.suspendHandedBack`.
 */
export interface UnansweredQuestion {
  /**
   * Where it was asked: `question` is the minter's own `request_input`, the read-or-write and
   * capability questions included; `sign_in` is a question a sign-in asked; `execution` is a
   * question an execution's script asked.
   */
  readonly step: "question" | "sign_in" | "execution";
  /** The id the question was asked under, when the harness knows it. */
  readonly requestId?: string;
  /** The execution whose script asked it (`execution` only). */
  readonly executionId?: string;
  /** Whether the build may have changed the website, as the ended build's `noResponse` says. */
  readonly possibleCommit: boolean;
}

export interface MintDependencies {
  readonly agentRecovery?: {
    readonly initial?: {
      readonly agent: MintAgentSnapshot;
      readonly harness: MintHarnessSnapshot;
      /**
       * Told to the restored minter once, as a user message before its next model call, such as
       * why it stopped and what may have changed meanwhile. When the snapshot holds a saved model
       * response, that response's tool calls replay first and the message follows their results,
       * so every call keeps its result. The host's own text, sent as written.
       * It joins the conversation with the next model call, so only checkpoints from that call on
       * hold it: their `modelCalls` is above the restored snapshot's. A takeover that restores an
       * earlier checkpoint, such as one written as a replayed call returned, passes it again; one
       * that restores a later checkpoint must not, or the minter reads it twice.
       */
      readonly resumeMessage?: string;
    };
    readonly bindHarness?: (capture: () => MintHarnessSnapshot) => Effect.Effect<void, MintFailure>;
    /**
     * Rejoins or reads a tool call a takeover found started but not returned. A recovered
     * execution's evidence must carry the `review` the host journaled, `action` included: a write
     * is tracked, and its repeat refused, only when its evidence says Guardian labelled it one.
     * A `request_input` call it fails with `noResponse`, such as a question that expired before
     * the takeover, goes on as an unanswered live question does (`suspendUnanswered`).
     */
    readonly recoverTool?: (call: RecoveryToolCall) => Effect.Effect<
      | {
          readonly execution?: {
            readonly purpose: ExecutionRequest["purpose"] | "command";
            readonly evidence: ExecutionEvidence;
          };
          readonly publication?: {
            readonly published: PublishedBuild;
            readonly coverage: string;
            readonly assumptions?: PublicationRequest["assumptions"];
          };
          readonly input?: { readonly request: AgentInputRequest; readonly answers: ValidAnswers };
          readonly result?: unknown;
        }
      | undefined,
      MintFailure
    >;
    readonly save: (
      agent: MintAgentSnapshot,
      harness: MintHarnessSnapshot,
    ) => Effect.Effect<void, MintFailure>;
  };
  /** Attempt-local lifecycle capacity, never execution authority. */
  readonly executionAvailability?: () => MintExecutionAvailability;
  /** Trusted worker fence after this exact attempt's lease is lost; never model input. */
  readonly attemptRevoked?: () => boolean;
  /**
   * Why the host first stopped offering live work, a finite cause such as
   * `browser_loss_unrecoverable`; undefined while it still offers it.
   */
  readonly hostUnavailableCause?: () => string | undefined;
  /** Finite host records, oldest first, behind a host_unavailable stop that no tool call observed. */
  readonly unavailableHostCause?: () =>
    | {
        readonly reason?: NonNullable<DestinationReason> | PolicyFailureReason;
        readonly diagnostics: readonly FiniteDiagnostic[];
      }
    | undefined;
  /**
   * Fresh-attempt entry page state for the request context, not the agent
   * instructions. Absent without an entry URL or after possible effects.
   */
  readonly entryNavigation?: () => MintEntryNavigation | undefined;
  /**
   * Screened host incidents queued before the first tool call (the entry window). Draining
   * hands them to the first model request instead of the first tool result.
   */
  readonly drainStartIncidents?: () => Effect.Effect<object | undefined>;
  /**
   * Host-authored notices about browser state that changed after a tool call returned, such as a
   * challenge Kernel's solver cleared. Draining hands them to the next tool result.
   */
  readonly drainHostNotices?: () => readonly object[] | undefined;
  /** Suspected OpenGPT bugs this attempt continued past: a count and the first eight. */
  readonly hostAnomalies?: () => HostAnomalySummary;
  /** Records how the attempt ended, once, for its closed anomaly record. */
  readonly attemptFinished?: (outcome: MintAttemptOutcome) => Effect.Effect<void>;
  /** Host-enforced intake question; no execution or publication tool is available this turn. */
  readonly capabilityQuestion?: string;
  /** Host-resolved availability only. Credentials never enter the model request. */
  readonly websiteCredentialsAvailable?: boolean;
  /** See `MintTurn.autofillSignIn`. */
  readonly autofillSignIn?: true;
  /**
   * Proposed screened request only; missing reviewer fails closed. Never receives an answer.
   * `requestId` is the id the request is asked under if allowed, so its lifecycle events join.
   */
  readonly reviewQuestion?: (
    request: AgentInputRequest,
    options?: {
      /** The agent's `report_blocked` explanation, reviewed before its caller reads it. */
      readonly blockedOutcome?: true;
      readonly requestId?: string;
      /**
       * The build's latest publication refusals, from `publicationDecisions`, so the review reads
       * what the host refused instead of the agent's account of it. Absent when there are none.
       */
      readonly publicationDecisions?: readonly PublicationDecision[];
      /**
       * A blocked explanation's review only: the build's Guardian denials and failing live test
       * cases, already screened. A host that forwards it lets the review judge the report against
       * them; an older host leaves it out.
       */
      readonly decisionLedger?: DecisionLedger;
      /**
       * The build's effect from the harness's own task state, once decided: absent on the
       * read-or-write question's turn. A host that forwards it lets the review know a write build
       * does the task once, for real, before it publishes; an older host leaves it out.
       */
      readonly buildEffect?: "read" | "write";
      /**
       * The agent's confirm questions that ask the owner to confirm a step an execution review of
       * this build refused (`confirmsReview`), each with that review's id. A host that forwards it
       * to `questionForReview` lets Guardian bind the owner's yes to exactly that step; an older
       * host leaves it out, and the answer reaches later reviews only as an answered question.
       */
      readonly confirms?: readonly ConfirmedStepQuestion[];
    },
  ) => Effect.Effect<QuestionDecision & { readonly reviewId?: string }, MintFailure>;
  /**
   * Asks the caller in place (source `agent`) while the attempt keeps its browser and lease.
   * A `secret` answer's value is the host's handle (`{{secret.sN}}`), never the secret: the host
   * fills it into a live execution's source after review. An unanswered request fails with
   * `noResponse`. `reviewId` names the Guardian review that allowed it and `requestId` the id it
   * was reviewed under (a fresh one when absent), for its lifecycle events.
   */
  readonly askInput?: (
    request: AgentInputRequest,
    ids?: { readonly reviewId?: string; readonly requestId?: string },
  ) => Effect.Effect<ValidAnswers, MintFailure>;
  /**
   * Lets the host suspend the build, to resume it later, where an unanswered question would
   * otherwise end it as `no_response`. The harness calls it only there: never for a question it
   * hands back to the minter as no answer (`suspendHandedBack` covers those), and never for one
   * the owner cancelled.
   * - `suspended`: the host has made the state it resumes from durable. The run stops at once
   *   with no outcome: the tool call that asked never returns, so the minter's checkpoint keeps
   *   it started; no further model call starts; and the run ends interrupted, as
   *   `attemptFinished` reports. A resumed attempt restores `agentRecovery.initial` and rejoins
   *   that call through `agentRecovery.recoverTool`, such as with the answer the owner gave
   *   meanwhile. Recovered evidence that still carries `noResponse` is unanswered again, and so
   *   is a rejoined question that `recoverTool` fails with `noResponse`: it is offered with no
   *   `requestId`, which the harness never learned, for the host to match to the question it
   *   rejoined.
   * - `not_suspended`, or a failure, which is recorded: the build ends as `no_response`. So does
   *   `suspended` when the model run ended while the hook ran, which is recorded too.
   * Absent, every such build ends as `no_response`.
   */
  readonly suspendUnanswered?: (
    question: UnansweredQuestion,
  ) => Effect.Effect<"suspended" | "not_suspended", MintFailure>;
  /**
   * Lets the host suspend the build where the minter ends it with `report_blocked` reason
   * `question_unanswered` after its own question went back to it as no answer. The harness offers
   * the latest such question (`step` `question`), when no other question was asked since, and
   * never one that asks whether to end the build (`endsBuild`); the host declines one it no
   * longer holds open. It answers as `suspendUnanswered` does, except that the
   * call that stays unreturned is the report: a resumed attempt rejoins it through
   * `agentRecovery.recoverTool` with the owner's answer as `input`, and the minter reads that
   * answer as the report's result, with the build going on. Absent, or on any answer but
   * `suspended`, the build ends blocked as before.
   */
  readonly suspendHandedBack?: (
    question: UnansweredQuestion,
  ) => Effect.Effect<"suspended" | "not_suspended", MintFailure>;
  /**
   * Removes host-private values, such as the build's account reference, from text the agent
   * writes for its caller: each request's notice, prompts and option labels, and its blocked
   * explanation. Applied before review; the agent's own transcript keeps what it wrote. Absent,
   * the text is shown as written.
   */
  readonly redactCallerText?: (text: string) => string;
  /**
   * Raises the system login request Guardian routed a question to. `held` means the host already
   * has a login; `unavailable` means this job may not ask for one. The model never sees values.
   */
  readonly requestLogin?: () => Effect.Effect<
    "supplied" | "held" | "unavailable" | "in_use" | "inspect" | LoginDecline,
    MintFailure
  >;
  /** Records the owner's answer to the effect question on the build, once. */
  readonly recordBuildEffect?: (effect: "read" | "write") => Effect.Effect<void, MintFailure>;
  /**
   * Guardian's review of a `mint_update` against the current effective task. The host runs it as
   * its own Guardian review of kind `update` (`makeGuardian(...).reviewTaskUpdate`), with the same
   * trusted authority every other review of the build reads. A review that does not complete
   * fails with `ReviewUnavailable`, which the harness answers within the review outage budget.
   * Absent, together with `applyTaskUpdate`, the minter is not offered `mint_update`.
   */
  readonly reviewTaskUpdate?: (
    candidate: TaskUpdateCandidate,
  ) => Effect.Effect<TaskUpdateDecision & { readonly reviewId?: string }, MintFailure>;
  /**
   * Applies an update Guardian allowed (`TaskUpdateHostResult`). Before it answers `applied`, the
   * host must, in one step that applies all or nothing:
   * - store `harness`, the checkpoint with the update applied, as the attempt's harness snapshot,
   *   with its own bindings, so a takeover restores the whole update or none of it; a takeover
   *   that restores it answers the same `mint_update` again as `updated` without another review;
   * - for a `site` change, rebind everything that depends on the site to the new origin: the
   *   authorized origins every review reads, the browser's entry and sign-in origin, the
   *   publication site, and any private input, scheduling, quota or run-environment key bound to
   *   it;
   * - rerun intake screening and the duplicate check on the effective task, when it has them, and
   *   answer `refused` when either refuses;
   * - resolve the login the effective task needs (a new site, a read becoming a write that needs
   *   a sign-in, or a `login` change), answering `clarification_required` when the caller must
   *   supply or choose one first, such as when the account's one-login-per-site rule leaves no
   *   usable login for the new site;
   * - for an `effect` change, record the build's effect as `write`, so every later execution is
   *   reviewed under write authority and the write build rules. The write session takes its own
   *   example claim: the harness calls `claimExample` again when its first act step starts, so
   *   the host must accept that claim even when a live read example already claimed one.
   * From then on every Guardian review of the build reads the effective task: the original intent
   * with `PendingExecution.taskUpdates` and the rebound `allowedOrigins`. The host never erases
   * recorded executions, claims, unresolved writes or Guardian decisions, and each recorded
   * execution keeps the task revision it ran under. It may refuse any update it cannot apply.
   */
  readonly applyTaskUpdate?: (
    application: TaskUpdateApplication,
  ) => Effect.Effect<TaskUpdateHostResult, MintFailure>;
  /**
   * The host can't move a build to another site: `applyTaskUpdate` would refuse every `site`
   * change. The harness then refuses a `site` change as `site_move_unsupported` when the minter
   * proposes it, before the host asks for the caller's confirmation or Guardian reviews it, and
   * points it to a new build; every update review reads it as a host fact
   * (`PendingTaskUpdate.siteMoveUnsupported`). Absent, a `site` change is confirmed and reviewed,
   * and the host applies or refuses it, as before.
   */
  readonly siteMoveUnsupported?: true;
  /**
   * In maintenance, who can confirm a `mint_update` to the published tool's registered contract:
   * `owner` when the person the repair's questions reach may manage the tool, `owner_request`
   * when, in addition, the maintenance is that owner's own request to change the tool, otherwise
   * `none`. The harness asks it before review; `none`, a failure or an absent hook refuses an
   * update that loosens the contract as `owner_unavailable`, so a repair without the owner keeps
   * it. With `owner_request`, an update that cites no answer goes to Guardian, which accepts the
   * owner's request as confirmation of an output change the request plainly names.
   */
  readonly taskUpdateConfirmer?: () => Effect.Effect<TaskUpdateConfirmer, MintFailure>;
  /** Receives the owner's answer to the host's capability question. */
  readonly capabilityAnswered?: (answer: string) => Effect.Effect<void, MintFailure>;
  readonly diagnostics?: MintDiagnostics;
  readonly reporting?: MintReporting;
  /** The hosted job and attempt, for failure reports; absent outside a hosted job. */
  readonly reportCorrelation?: { readonly jobId: string; readonly attemptId: string };
  readonly deadline?: Deadline;
  /** How long reviews may stay unavailable before the attempt ends; 15 minutes by default. */
  readonly reviewOutageBudgetMs?: number;
  /**
   * How long Guardian's review of the minter's last answer (`stopExplanation`) may take before
   * the build ends without it; one minute by default.
   */
  readonly stopExplanationReviewMs?: number;
  readonly exampleClaimed?: boolean;
  /** Host-bound accepted/registered read authority; source still requires Guardian approval. */
  readonly repeatableRead?: boolean;
  /**
   * Whether the host's own guidance names this `policy` ending, so it needs no refusal on record,
   * such as a repair's verdict that the caller's input caused its run's failure. It gets the
   * screened explanation. Without it, `policy` needs a Guardian deny or escalation in the
   * attempt; a report that stands only on the owner's no or an unanswered question takes that
   * ending's own name.
   */
  readonly policyBlockAllowed?: (explanation: string) => boolean;
  /** Trusted registered invocation receipt, loaded from its durable recovery record. */
  readonly initialExample?: ExecutionEvidence;
  readonly priorReadExecutions?: readonly ExecutionEvidence[];
  /** Host-owned state, independent of model prose and publication. */
  readonly currentInvocation?: () => CurrentInvocation | undefined;
  readonly canPublishRepair?: (executionId: string) => boolean;
  /** Host-created SDK workspace, no credentials, no external grants. Host owns cleanup. */
  readonly workspace: SandboxSession;
  /** Same-attempt artifacts already screened and published by the host collector.
   * Generated source cannot populate this read-only view. */
  readonly readPublishedCapture?: (path: string) => Effect.Effect<string | undefined, MintFailure>;
  /**
   * The host's transient token view, masked for explicit secrets only. Its cookie, CSRF and
   * authorization values are its content, so the model's source screen must not withhold them.
   */
  readonly readSessionTokens?: (path: string) => string | undefined;
  /**
   * Saves an execution result too large to return whole (`resultDigestThresholdBytes`) as the
   * read-only workspace file `path`, under `captures/results/`, which `read_source` and offline
   * commands read; the agent then receives the result's digest naming it. The text is already
   * screened for the model. A host without it returns every result whole.
   */
  readonly saveResult?: (path: string, text: string) => Effect.Effect<void, MintFailure>;
  /** Host-selected original attempt evidence. Content is fetched only for a requested indexed path. */
  readonly readRetainedCapture?: (path: string) => Effect.Effect<string | undefined>;
  /** Host-only selection/retrieval; never refetches a historical website response. */
  readonly retainCapture?: (request: CaptureRequest) => Effect.Effect<string, MintFailure>;
  /** Host-bound, read-only CAPTCHA state for the current live browser. Never dispatches a
   * browser action, triggers a solve or extends a deadline. Absent when the host has no CAPTCHA
   * telemetry; then the minter tool is not offered. */
  readonly captchaState?: {
    readonly read: () => Effect.Effect<object, MintFailure>;
    readonly limit: number;
    readonly exhausted: object;
  };
  /**
   * The minting agent's troubleshooting request for a new browser, with its reason.
   * Guardian reviews the reason; on allow the host's recovery policy replaces the live browser.
   * It runs no code, repeats nothing and is never part of the published operation.
   */
  readonly requestBrowserRecovery?: (
    rationale: string,
  ) => Effect.Effect<MintBrowserRecoveryResult, MintFailure>;
  /**
   * Tests a signed-in marker before the agent sends it with `authenticate`: whether the
   * signed-out snapshot the host saved before the sign-in sent anything shows it
   * (`evaluateSignedInMarker` matches it), whether the live page shows it now, after the host
   * loads `openPath` (or the site's origin) again, and on another page the agent visited signed
   * in. It never signs in or sends a value. Absent, the tool reports the check unavailable.
   */
  readonly checkSignedInMarker?: (
    marker: SignedInMarkerCheckRequest,
  ) => Effect.Effect<SignedInMarkerCheck, MintFailure>;
  /**
   * Runs a read's planned live tests in batches (`LiveTestHost`). Absent, the minter is offered
   * no live_tests tool, and a read tests one input at a time with execute.
   */
  readonly liveTests?: LiveTestHost;
  /**
   * The minter's `abandon_sign_in`: it gives up signing in, so the build goes on signed out. The
   * host decides whether it may: it refuses a write build, a task that needs the site signed in
   * and a build whose sign-in already verified, with a reason and a notice. Guardian does not
   * review it. On `abandoned` the harness drops the unresolved sign-in, so explore, the example,
   * live tests and publication go on signed out. Absent, the minter is offered no such tool.
   */
  readonly abandonSignIn?: () => Effect.Effect<AbandonSignInResult, MintFailure>;
  /**
   * The host's own reading of the build's latest sign-in when nothing confirmed it:
   * `session_not_kept` when the site accepted the login but the signed-in session did not survive
   * the page load after it. A blocked ending the report's checks accept while that sign-in is
   * unconfirmed, other than the owner's `owner_declined`, `question_unanswered` or `owner_ended`,
   * ends the build as sign-in unavailable, worded by this answer. Absent, or undefined, the ending says the site
   * could not be signed in.
   */
  readonly signInSessionLoss?: () => SessionLoss | undefined;
  /**
   * Whether the host refused a sign-in screen because the sign-in under way already filled the
   * login's password as often as the host allows (`credential_already_filled`, a step result,
   * not a failure), and the password is still spent: no sign-in verified and no corrected login
   * started its fills again since, so the host refuses every further screen that needs it. A
   * `host_refused` block stands on it as on any host refusal of a sign-in. Absent, the harness
   * knows only the refusals it was handed as failures.
   */
  readonly signInRefillRefused?: () => boolean;
  /**
   * Whether the host refused a sign-in screen at its destination check, typing nothing because a
   * field, its form or its submit would send the login somewhere credentials may not go (an
   * inspection's `credential_target_refused`, a step result, not a failure), and no sign-in
   * verified and no later screen that takes a password or code passed that check since. A screen
   * with no such field, such as an identifier screen, says nothing of where the password would
   * go, so it leaves the refusal standing. No change to the step's selectors gets
   * past it, so a `host_refused` block stands on it as on any host refusal of a sign-in. The
   * harness reads it after each authenticate and keeps the latest answer in its checkpoint
   * (`signInDestinationRefused`), so a successor whose host kept no record of the refusal still
   * has it. Absent, the harness knows only the refusals it was handed as failures.
   */
  readonly signInDestinationRefused?: () => boolean;
  /** The host's own descriptions of its optional tools, in place of the generic ones. */
  readonly hostToolDescriptions?: HostToolDescriptions;
  /**
   * The host's own wording of the note the minter gets after a compaction, given the skills it
   * read with `read_source` before it, in catalog order, never none. Absent, the minter's default
   * note.
   */
  readonly compactionSkillsNote?: (skills: readonly string[]) => string;
  readonly projection: MintProjection;
  /** The workspace AGENTS.md, installed at the workspace root and given as the instructions. */
  readonly instructions: string;
  /**
   * The host's static reference text, each entry sent in order right after the instructions,
   * with the instructions' authority, and inside the prefix every job of the release shares in
   * the provider's prompt cache for 12 hours. Each entry must be the same in every byte for every
   * job of a release: host-authored orientation or reference that no job, caller, site or answer
   * changes. Anything per job goes in the job's own messages instead; it would also split the
   * shared prefix.
   */
  readonly staticContext?: readonly string[];
  /**
   * Sent as `prompt_cache_key` on every minter request, so the provider keeps the cache
   * accounting of requests with one key apart from others, such as one key per environment. A
   * prewarm of the minter's prefix (`prewarmMinterPrefix`) must send the same key. Absent, no key.
   */
  readonly promptCacheKey?: string;
  readonly skills: readonly SkillDescriptor[];
  readonly model: MintModel;
  /** Validate available host facilities before reserving the one-use example claim. No execution. */
  readonly preflight: (
    request: ExecutionRequest,
  ) => Effect.Effect<
    { readonly supported: true } | { readonly supported: false; readonly reason: string },
    MintFailure
  >;
  /** Each call MUST perform fresh Guardian review, await beforeDispatch after approval,
   * and only then allocate execution resources/import authored code. Never swallow a
   * failed dispatch fence or invoke it before the initial review succeeds. Pass the fence the
   * allow it follows, so every dispatch carries an action label: Guardian's review and label,
   * or the host's own authentication allow for a sign-in screen the host fills itself. A
   * successful result carries Guardian's allow, label included, as `review`. */
  readonly reviewAndExecute: (
    request: (
      | ExecutionRequest
      | {
          readonly purpose: "command";
          readonly target: "pureFiles";
          readonly command: string;
        }
    ) &
      StepNote,
    beforeDispatch?: (allowed: AllowedExecution) => Effect.Effect<void, MintFailure>,
    exampleJournal?: ExampleJournal,
  ) => Effect.Effect<ExecutionEvidence, MintFailure>;
  /**
   * Persist before example/residual dispatch. Host binds input/account/authority, never tool args.
   * A build normally claims once. After a confirmed `effect` update turns a read into a write, the
   * write session's first act step claims again even when a live read example already claimed:
   * accept that second claim. A host that meters builds counts one when it publishes, not per
   * claim.
   */
  readonly claimExample: Effect.Effect<void, MintFailure>;
  readonly authorizeResidual: Effect.Effect<void, MintFailure>;
  /** Review current source and validate/screen public definition before atomic registry publication. */
  readonly publish: (
    request: PublicationRequest,
    evidence: ExecutionEvidence,
    /**
     * Host evidence for the publication review. `liveTests` is the harness's record of a read's
     * live tests on the source it publishes: the host gives it to the review as the host-owned,
     * unpublished file `publication/tests.json`. Never a reason to refuse publication by itself.
     * `testedFields` holds each of those cases' output fields as paths and counts, no value: the
     * host passes them to `outputNotes` as `alsoTested`, so a field no tested run filled is noted.
     */
    hostEvidence?: { readonly liveTests?: object; readonly testedFields?: readonly FieldFill[] },
  ) => Effect.Effect<MintCompletion, MintFailure>;
  /** Absent when this host never publishes past unresolved input feedback. */
  readonly inputFeedbackFallback?: InputFeedbackFallback;
  /**
   * The outcome reviewer's model, persistence and journal. Absent, writes are never assessed:
   * each stays unresolved, is never repeated and is reported `may_have_applied`.
   */
  readonly outcomeReview?: OutcomeReviewHost;
  /** Host evidence of each publication decision; absent, reviews get none. */
  readonly publicationDecisions?: PublicationDecisionLog;
}

/**
 * The agent's own description of a step, its execute call's intent. A host passes it to the
 * step's execution review as `PendingExecution.agentNote`, screened like the input: untrusted
 * context, never authority. Absent for a step the agent did not describe, such as a command.
 */
export interface StepNote {
  readonly agentNote?: string;
}

/**
 * The allow a dispatch fence follows, so every dispatch carries an action label: a Guardian
 * execution review and its label, or the host's own allow for a sign-in screen it fills itself
 * after its own review, which is always `authentication`.
 */
export type AllowedExecution =
  | { readonly reviewId: string; readonly action: GuardianAction }
  | { readonly host: true; readonly action: "authentication" };
/** The host's allow for a sign-in screen it fills itself. */
export const hostAuthentication: AllowedExecution = { host: true, action: "authentication" };

/** What a browser recovery request did, as the agent reads it. */
export type MintBrowserRecoveryResult =
  | {
      /**
       * No replacement is possible now, and Guardian was not asked: no live browser, the
       * attempt's proxies and modes are spent, the policy pins a signed-in browser's egress, or
       * the latest evidence keeps the browser.
       */
      readonly outcome: "unavailable";
      readonly reason:
        | "no_browser"
        | "no_proxy_left"
        | "egress_pinned"
        | "site_refused"
        | "proxy_rate_limited"
        | "retained";
      readonly notice: string;
    }
  | {
      readonly outcome: "denied";
      readonly notice: string;
      readonly review: {
        readonly outcome: "deny" | "escalate";
        readonly reviewId: string;
        readonly rationale: string;
      };
    }
  | {
      /** `lost`: the switch failed part way, and the old browser and its page are gone. */
      readonly outcome: "replaced" | "kept" | "lost";
      readonly notice: string;
      readonly reviewId: string;
      /** Guardian's note on its allow, which never blocks the recovery. */
      readonly advice?: string;
      readonly browserRecovery?: BrowserRecoverySummary;
    };

export const PublicationDiagnosticGap = Schema.Union(
  Schema.Struct({
    phase: Schema.Literal("publication_capture"),
    state: Schema.Literal("withheld"),
    reason: Schema.Literal(
      "screening_failed",
      "storage_failed",
      "capacity_exhausted",
      "byte_limit",
      "capture_unavailable",
    ),
    screening: Schema.optional(CaptureScreeningDiagnostic),
  }),
  Schema.Struct({
    phase: Schema.Literal("publication_capture"),
    state: Schema.Literal("pending"),
    reason: Schema.Literal("background_processing"),
  }),
);
export type PublicationDiagnosticGap = typeof PublicationDiagnosticGap.Type;

export class MintServices extends Context.Tag("@opengpt-browser-engine/MintServices")<
  MintServices,
  MintDependencies
>() {}
