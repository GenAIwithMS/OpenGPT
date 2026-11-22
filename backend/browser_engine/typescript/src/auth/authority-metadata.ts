const authorityCheckStages = [
  "reference",
  "live_identity",
  "identity_binding",
  "integration",
  "permission",
  "grant",
  "caller_freshness",
  "outside_reference",
  "authority_version",
  "original_cancellation",
] as const;
export type AuthorityCheckStage = (typeof authorityCheckStages)[number];

export const authorityCheckReasons = [
  "authentication_failed:authentication_failed",
  "authentication_failed:fresh_authentication_required",
  "authentication_failed:missing_bearer",
  "authentication_failed:jwt_rejected",
  "authentication_failed:jwt_expired",
  "authentication_failed:claims_rejected",
  "authentication_failed:session_profile_rejected",
  "authentication_failed:session_inactive",
  "authentication_failed:verification_timeout",
  "authentication_failed:provider_record_missing",
  "account_access_denied:account_inactive",
  "account_access_denied:account_ambiguous",
  "account_access_denied:account_unsupported",
  "account_access_denied:account_not_found",
  "account_access_denied:environment_access_denied",
  "account_authority_unavailable:invalid_configuration",
  "account_authority_unavailable:invalid_request",
  "account_authority_unavailable:unauthorized_service",
  "account_authority_unavailable:method_not_allowed",
  "account_authority_unavailable:rate_limited",
  "account_authority_unavailable:service_unavailable",
  "account_authority_unavailable:transport_unavailable",
  "account_authority_unavailable:timeout",
  "account_authority_unavailable:invalid_response",
  "authorization_denied:Denied",
  "authorization_denied:StaleGrant",
  "authorization_denied:ReauthenticationRequired",
  "authorization_denied:LiveConsentCheckUnavailable",
  "grant_store_unavailable",
  "unclassified",
  "version_changed",
  "cancel_requested",
] as const;
export type AuthorityCheckReason = (typeof authorityCheckReasons)[number];

export interface AuthorityCheckDetail {
  readonly stage: AuthorityCheckStage;
  readonly reason: AuthorityCheckReason;
  /** Only on a `caller_freshness` failure checked with a server renewal policy: why it did not
   * renew, and the live account's type when the check resolved one. */
  readonly serverRenewal?: {
    readonly refusal: "disabled" | "cap_reached" | "not_eligible";
    readonly accountType?: "Personal" | "Business";
  };
}

const isAuthorityCheckDetail = (value: {
  readonly stage: unknown;
  readonly reason: unknown;
}): value is AuthorityCheckDetail =>
  typeof value.stage === "string" &&
  authorityCheckStages.some((stage) => stage === value.stage) &&
  typeof value.reason === "string" &&
  authorityCheckReasons.some((reason) => reason === value.reason);

/** Project the existing finite account/grant detail without retaining an error payload. */
export const authorityCheckMetadata = (
  value: unknown,
):
  | {
      readonly authorityStage: AuthorityCheckStage;
      readonly authorityReason: AuthorityCheckReason;
      readonly originalAuthorityFailureCode?: "AuthorityChanged";
    }
  | undefined => {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      !("authorityStage" in value) ||
      !("authorityReason" in value)
    )
      return undefined;
    const detail = { stage: value.authorityStage, reason: value.authorityReason };
    if (!isAuthorityCheckDetail(detail)) return undefined;
    const originalAuthorityFailureCode =
      ("code" in value && value.code === "AuthorityChanged") ||
      ("originalAuthorityFailureCode" in value &&
        value.originalAuthorityFailureCode === "AuthorityChanged")
        ? ("AuthorityChanged" as const)
        : undefined;
    return {
      authorityStage: detail.stage,
      authorityReason: detail.reason,
      ...(originalAuthorityFailureCode === undefined ? {} : { originalAuthorityFailureCode }),
    };
  } catch {
    return undefined;
  }
};
