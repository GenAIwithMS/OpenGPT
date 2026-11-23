import type { ExecutionBoundaryError } from "./boundary.js";
import type { IdentityErrorCode } from "../runtime/runner-codes.js";
import type { ManagedAuthErrorCode } from "../destinations/sign-in-provider-codes.js";
import type {
  RetainedProviderCode,
  RetainedProviderStage,
  RetainedProviderSchemaField,
  RetainedNetworkError,
} from "../runtime/provider-metadata.js";
import type { NoResponseError } from "../destinations/navigation-failure.js";
import type { HostRefusal } from "../destinations/autofill-refusal.js";
import type {
  CaptureCollectionDiagnostic,
  CaptureFailureReason,
  CaptureScreeningDiagnostic,
} from "../runtime/capture-diagnostic.js";
type ProviderAuthErrorCode = typeof ManagedAuthErrorCode.Type | "unknown";

// Provider fields remain readable only for retained checkpoints and historical diagnostics.
// New sign-ins use autofill or a direct HTTP step, never a provider flow.
type SignInFailureCode =
  | "AccountMismatch"
  /**
   * The site showed, once the login was sent, that the account is locked, suspended or disabled:
   * an account-level rejection, which no correction of a field gets past. Sign-in is unavailable
   * in the build, and it ends `account_locked`.
   */
  | "AccountLocked"
  | "AuthenticationFailed"
  /**
   * The host refused to type into a field of an autofill sign-in screen, or to keep typing it:
   * `hostRefusal` says which check refused, which field and on which screen. It submitted nothing
   * of that screen.
   */
  | "AutofillRefused"
  | "CredentialsRejected"
  | "CaptureUnavailable"
  /**
   * The sign-in went where credentials may not go: off the site's registrable domain and every
   * configured sign-in origin. The host typed nothing there and stopped the login.
   */
  | "CredentialTargetRefused"
  /** The login boundary could not verify where credentials would go, so it typed nothing. */
  | "CredentialTargetUnverified"
  /** The saved login could not be read from its store through the host's bounded retries. */
  | "CredentialsUnavailable"
  | "InputExpired"
  /** The login conflicts with the one this Personal account's site is locked to. */
  | "LoginIdentityConflict"
  /** The job's attempt or the login's durable row went to another owner; the build ends. */
  | "OwnershipLost"
  | "ProviderUncertain"
  /**
   * The attempt's managed-login journal holds no row for another login. Nothing was sent: the
   * login is refused before it starts.
   */
  | "SignInsSpent"
  | "StopUnconfirmed"
  /**
   * The managed-auth store stayed unavailable through its bounded retries. Unlike
   * `OwnershipLost`, nothing says another owner took the login, so the agent can get past it.
   */
  | "StorageUnavailable"
  | "UnsupportedInteraction";
export interface SignInDiagnostic {
  readonly phase:
    /** The host reading a saved login from its store, before anything else of the sign-in. */
    | "credential_resolve"
    /** The direct sign-in request, on the current browser. */
    | "direct_login"
    | "initial_identity"
    | "stop_current"
    | "connection_create"
    | "login_start"
    | "login_poll"
    | "credential_submit"
    | "replacement"
    | "final_identity"
    | "cleanup";
  readonly code: SignInFailureCode;
  readonly capturePhase?: "start" | "finish";
  readonly captureReason?: CaptureFailureReason;
  readonly captureCollection?: CaptureCollectionDiagnostic;
  readonly captureScreening?: typeof CaptureScreeningDiagnostic.Type;
  readonly providerCode?: RetainedProviderCode;
  readonly providerStatus?: number;
  readonly providerStage?: RetainedProviderStage;
  readonly providerSchemaField?: RetainedProviderSchemaField;
  readonly providerAuthCode?: ProviderAuthErrorCode;
  /** The site answered the failed login's latest page load 429, a rate limit. */
  readonly siteRateLimited?: true;
  /**
   * The failed login's latest page load failed in the provider's network layer: typed network or
   * provider evidence from the login browser's capture, read once before the login's cleanup.
   */
  readonly loginProxyFailure?: RetainedNetworkError | NoResponseError;
  /**
   * An iframe document of the login that the provider's network layer failed with provider
   * evidence. Once a sign-in started it moves nothing: context for the agent, never a verdict.
   */
  readonly loginFrameRefusal?: {
    readonly origin: string;
    readonly cause: RetainedNetworkError | NoResponseError;
  };
  /**
   * Set by the mint host once it replaced the browser after this failure, so the agent's answer
   * says the browser moved only when it did.
   */
  readonly hostMovedBrowser?: true;
  /** The provider's account of a failed or expired login flow; see `RetainedLoginFailureEvidence`. */
  readonly providerEvidence?: RetainedLoginFailureEvidence;
  /** One line for the agent and the caller: the provider's name, its code and its message. */
  readonly providerReason?: string;
  readonly cleanupCode?: SignInFailureCode;
  /**
   * The host confirmed the failed login's browsers stopped and its connection is gone, so nothing
   * of it still runs; `cleanupCode` says the opposite. Context for the agent.
   */
  readonly cleanupConfirmed?: true;
  /** The login failed after the provider submitted a field or choice to the site. */
  readonly afterSubmission?: true;
  /**
   * The sign-in failed before anything reached the site: no direct request was sent, and no
   * login of it submitted a field or choice or took an approval. No credential went out, so the
   * failure spends no sign-in allowance and the same sign-in may simply be tried again.
   */
  readonly nothingSubmitted?: true;
  /** For `AccountLocked`: what the site said of the account, `locked` or `suspended`. */
  readonly account?: "locked" | "suspended";
  /** For `AutofillRefused`: what the host refused to type, where, and which check refused it. */
  readonly hostRefusal?: HostRefusal;
  readonly identityErrorCode?: typeof IdentityErrorCode.Type;
  readonly execution?: Pick<
    ExecutionBoundaryError,
    "phase" | "reason" | "dispatch" | "stage" | "elapsedMs" | "providerStatus" | "providerCode"
  >;
}

interface RetainedLoginFailureEvidence {
  readonly flowStatus: "FAILED" | "EXPIRED";
  /** The provider's exact error code, also when it is outside `ManagedAuthErrorCode`. */
  readonly errorCode?: string;
  readonly message?: string;
  /** The error text the website itself showed, as the provider read it. */
  readonly website_error?: string | null;
  /** The step the flow reached, from the provider's login timeline. */
  readonly step?: string;
  readonly browserSessionId?: string;
  /** The provider's replay of the login browser; present only when the login was recorded. */
  readonly replayId?: string;
  readonly completedAt?: string;
  /** The last main-frame URL the host's capture saw on the login browser. */
  readonly lastObservedUrl?: string;
  /** Set when the provider's login timeline could not be read; the connection fields still apply. */
  readonly timelineUnavailable?: true;
  /** Prior submitted values were not available to screen provider prose after takeover. */
  readonly privateRedactionUnavailable?: true;
}

/** Unconfirmed cleanup or a possibly submitted sign-in requires inspection before further work. */
export const signInOutcomeUnknown = (diagnostic: SignInDiagnostic) =>
  diagnostic.cleanupCode !== undefined ||
  ((diagnostic.code === "CredentialTargetRefused" ||
    diagnostic.code === "CredentialTargetUnverified") &&
    diagnostic.afterSubmission === true) ||
  ((diagnostic.code === "ProviderUncertain" ||
    diagnostic.code === "CaptureUnavailable" ||
    diagnostic.code === "StorageUnavailable") &&
    diagnostic.nothingSubmitted !== true);
