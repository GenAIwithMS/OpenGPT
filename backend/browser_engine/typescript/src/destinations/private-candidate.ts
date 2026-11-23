import { Schema } from "effect";

/** Names which admission check denied a private destination candidate. No URL part is retained. */
export const DestinationPrivateCandidateReason = Schema.Literal(
  "eligibility_unavailable",
  "origin_ineligible",
  "path_screen_failed",
  // No longer produced: admitted origins are not registered. Kept so older records decode.
  "site_register_failed",
  "review_context_screen_failed",
  // Destination reviews disabled: a request to another site carried a registered secret.
  "registered_secret",
  // Destination reviews disabled: the registered-secret screen itself failed.
  "secret_screen_failed",
);
export type DestinationPrivateCandidateReason = Schema.Schema.Type<
  typeof DestinationPrivateCandidateReason
>;

/** The worker denial, and the mint failures that carry it from an active or opening browser. */
const PrivateCandidateFailure = Schema.Struct({
  code: Schema.Literal("DestinationDenied", "ScopeDenied", "Unavailable"),
  destinationReason: Schema.Literal("private_candidate"),
  destinationPrivateCandidateReason: DestinationPrivateCandidateReason,
});

/** Retains only a finite reason that accompanies a private_candidate denial. */
export const destinationPrivateCandidateMetadata = (
  value: unknown,
):
  | {
      readonly destinationReason: "private_candidate";
      readonly destinationPrivateCandidateReason: DestinationPrivateCandidateReason;
    }
  | undefined => {
  try {
    const decoded = Schema.decodeUnknownOption(PrivateCandidateFailure)(value);
    return decoded._tag === "Some"
      ? {
          destinationReason: decoded.value.destinationReason,
          destinationPrivateCandidateReason: decoded.value.destinationPrivateCandidateReason,
        }
      : undefined;
    // error-reporting-allow: typed-recovery a failure whose fields throw on read has no finite reason; the caller holds the failure
  } catch {
    return undefined;
  }
};
