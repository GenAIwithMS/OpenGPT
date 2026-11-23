import { Schema } from "effect";

const PolicyFailure = Schema.Struct({
  code: Schema.Literal("AuthorityChanged", "DestinationDenied", "ScopeDenied", "Unavailable"),
  originalPolicyFailureCode: Schema.optional(
    Schema.Literal("AuthorityChanged", "DestinationDenied"),
  ),
  policyFailureSource: Schema.Literal(
    "destination_boundary",
    "origin_boundary",
    "mint_destination_authorize",
  ),
  policyFailureCheck: Schema.Literal(
    "destination_before_review",
    "destination_after_review",
    "destination_popup_recheck",
    "origin_startup",
    "origin_poll",
    "origin_route",
    "mint_admission",
  ),
  policyFailureReason: Schema.Literal(
    "origin_blocked",
    "revision_changed",
    "policy_read_failed",
    "policy_invalid_input",
    "policy_unavailable",
    "policy_check_defect",
    "policy_snapshot_stale",
    "policy_timeout",
    "policy_pool_wait_timeout",
    "policy_query_timeout",
    "invalid_origin",
    "inspection_failed",
    "route_failed",
    "authorization_failed",
    "generation_changed",
  ),
});

/** Names what an origin-boundary invalid_origin failure judged. The URL itself stays in the
 * failure detail for the screened archive, never in this finite metadata. */
const InvalidOriginUrl = Schema.Struct({
  policyFailureContext: Schema.Literal(
    "route_request",
    "popup_primary",
    "popup_primary_origin",
    "primary_frame",
    "secondary_frame",
    "primary_origin",
  ),
  policyFailureUrlCategory: Schema.Literal(
    "malformed",
    "http",
    "about",
    "chrome_error",
    "chrome_extension",
    "other_protocol",
    "userinfo",
  ),
});

export type PolicyFailureSource = typeof PolicyFailure.Type.policyFailureSource;
export type PolicyFailureCheck = typeof PolicyFailure.Type.policyFailureCheck;
export type PolicyFailureReason = typeof PolicyFailure.Type.policyFailureReason;
export type PolicyFailureContext = typeof InvalidOriginUrl.Type.policyFailureContext;
export type PolicyFailureUrlCategory = typeof InvalidOriginUrl.Type.policyFailureUrlCategory;
export type OriginalPolicyFailureCode = "AuthorityChanged" | "DestinationDenied";

const sourceByCheck: Record<PolicyFailureCheck, PolicyFailureSource> = {
  destination_before_review: "destination_boundary",
  destination_after_review: "destination_boundary",
  destination_popup_recheck: "destination_boundary",
  origin_startup: "origin_boundary",
  origin_poll: "origin_boundary",
  origin_route: "origin_boundary",
  mint_admission: "mint_destination_authorize",
};

const reasonsBySource: Record<PolicyFailureSource, readonly PolicyFailureReason[]> = {
  destination_boundary: [
    "origin_blocked",
    "revision_changed",
    "policy_read_failed",
    "policy_invalid_input",
    "policy_unavailable",
    "policy_snapshot_stale",
    "policy_check_defect",
  ],
  origin_boundary: [
    "origin_blocked",
    "policy_read_failed",
    "policy_snapshot_stale",
    "policy_timeout",
    "policy_pool_wait_timeout",
    "policy_query_timeout",
    "invalid_origin",
    "inspection_failed",
    "route_failed",
  ],
  mint_destination_authorize: ["authorization_failed", "generation_changed"],
};

/** The checks that can judge each URL context, exactly as the origin boundary emits them. */
const checksByContext: Record<PolicyFailureContext, readonly PolicyFailureCheck[]> = {
  route_request: ["origin_route"],
  popup_primary: ["origin_startup", "origin_poll", "origin_route"],
  popup_primary_origin: ["origin_startup", "origin_poll", "origin_route"],
  primary_frame: ["origin_startup", "origin_poll"],
  secondary_frame: ["origin_startup", "origin_poll"],
  primary_origin: ["origin_startup", "origin_poll"],
};

/** A URL pair that is invalid, inconsistent or unreadable loses only itself. */
const invalidOriginUrl = (
  value: unknown,
  check: PolicyFailureCheck,
): typeof InvalidOriginUrl.Type | undefined => {
  try {
    const decoded = Schema.decodeUnknownOption(InvalidOriginUrl)(value);
    return decoded._tag === "Some" &&
      checksByContext[decoded.value.policyFailureContext].includes(check)
      ? decoded.value
      : undefined;
  } catch {
    return undefined;
  }
};

/** Retain only finite, internally valid metadata; never copy raw failure properties. */
export const policyFailureMetadata = (
  value: unknown,
):
  | {
      readonly originalPolicyFailureCode: OriginalPolicyFailureCode;
      readonly policyFailureSource: PolicyFailureSource;
      readonly policyFailureCheck: PolicyFailureCheck;
      readonly policyFailureReason: PolicyFailureReason;
      readonly policyFailureContext?: PolicyFailureContext;
      readonly policyFailureUrlCategory?: PolicyFailureUrlCategory;
    }
  | undefined => {
  try {
    const decoded = Schema.decodeUnknownOption(PolicyFailure)(value);
    if (decoded._tag === "None") return undefined;
    const {
      code,
      originalPolicyFailureCode,
      policyFailureSource,
      policyFailureCheck,
      policyFailureReason,
    } = decoded.value;
    const originalCode =
      code === "AuthorityChanged" || code === "DestinationDenied"
        ? code
        : originalPolicyFailureCode;
    if (
      originalCode === undefined ||
      sourceByCheck[policyFailureCheck] !== policyFailureSource ||
      !reasonsBySource[policyFailureSource].includes(policyFailureReason) ||
      (originalCode === "DestinationDenied") !==
        (policyFailureSource === "destination_boundary" &&
          (policyFailureReason === "policy_read_failed" ||
            policyFailureReason === "policy_invalid_input" ||
            policyFailureReason === "policy_unavailable" ||
            policyFailureReason === "policy_snapshot_stale" ||
            policyFailureReason === "policy_check_defect"))
    )
      return undefined;
    const metadata = {
      originalPolicyFailureCode: originalCode,
      policyFailureSource,
      policyFailureCheck,
      policyFailureReason,
    };
    if (policyFailureSource !== "origin_boundary" || policyFailureReason !== "invalid_origin")
      return metadata;
    const url = invalidOriginUrl(value, policyFailureCheck);
    return url === undefined ? metadata : { ...metadata, ...url };
  } catch {
    return undefined;
  }
};
