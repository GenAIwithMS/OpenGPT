import { MintFailure } from "../mint/contracts.js";
import { failureDetail } from "../runtime/failure-detail.js";
import { LocalOperationFailure } from "../execution/local-operation.js";
import { InputRequestFailure } from "../runtime/input-request.js";
import { OwnerCancelled } from "../inputs/terminal.js";
export const error = (cause: unknown) =>
  cause instanceof Error ? cause : new Error("OpenGPT operation failed", { cause });
export const mintError = (cause: unknown) =>
  cause instanceof MintFailure
    ? cause
    : new MintFailure({
        code: "Unavailable",
        failureDetail: failureDetail("mint_host_dependency_failed", {
          operation: "standalone",
          error: cause,
        }),
      });

/**
 * The minter's question failed: one the caller left unanswered fails as `noResponse`, so the
 * harness decides whether it goes back to the minter or ends the build, and one the owner
 * cancelled also as `ownerCancelled`, which always ends it; anything else as `mintError`.
 */
export const askError = (cause: unknown) =>
  cause instanceof InputRequestFailure && cause.code === "NoResponse"
    ? new MintFailure({
        code: "Unavailable",
        noResponse: { possibleCommit: false },
        ...(cause instanceof OwnerCancelled ? { ownerCancelled: true as const } : {}),
        failureDetail: failureDetail("mint_host_dependency_failed", {
          operation: "standalone.ask",
          error: cause,
        }),
      })
    : mintError(cause);

/** Contract extraction reports the original schema refusal to finish_build. */
export const publicationError = (cause: unknown) => {
  if (cause instanceof LocalOperationFailure) {
    const code = [cause.code, cause.tag].find(
      (value) => value === "InvalidInput" || value === "InvalidOutput",
    );
    if (code === "InvalidInput" || code === "InvalidOutput")
      return new MintFailure({
        code: "PublicationUnavailable",
        reason: code === "InvalidInput" ? "contract_input_mismatch" : "contract_output_mismatch",
        ...(code === "InvalidInput" && cause.inputIssues !== undefined
          ? { inputIssues: cause.inputIssues }
          : {}),
        failureDetail: failureDetail("mint_host_dependency_failed", {
          operation: "standalone.publish.contract",
          error: cause,
        }),
      });
  }
  return mintError(cause);
};
