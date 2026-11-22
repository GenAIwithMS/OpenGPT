import { Schema } from "effect";

const runnerErrorCodes = [
  "CredentialsRejected",
  "SourceLoadFailed",
  "InvalidInput",
  "InputNotApplied",
  // An older runtime's name for the same refusal.
  "LocationNotApplied",
  "InvalidOutput",
  "BrowserFailure",
  "DeadlineExceeded",
  "WebsiteAuthenticationFailed",
  "Interrupted",
  "Defect",
  "ExecutionFailed",
  "TargetPageMismatch",
  "TargetNotFound",
  "TargetAmbiguous",
  "TargetGuardMismatch",
  "TargetGuardUnavailable",
  "ConditionTimeout",
  "CaptureUnavailable",
  "EventUnavailable",
  "HttpFailure",
  "VariantSelectionFailed",
  "ChallengeFailure",
  "DialogFailure",
  "OfflineTrafficDenied",
  "OfflineFixtureUnavailable",
  "FixtureUnavailable",
  "CaptureFixtureUnavailable",
  "BrowserAttachFailure",
  "OperationFailure",
  "BrowserActionTimeout",
  "WriteConfirmationRefused",
  "CommitAlreadySent",
  "ScriptInputFailure",
] as const;
/** A reported runner code, or `unclassified` for anything else, which may be authored text. */
export const finiteRunnerErrorCode = (value: string | undefined) =>
  runnerErrorCodes.find((candidate) => candidate === value) ?? "unclassified";
/** An identity check's code: the runner's, the host's reading of an unreadable receipt, or unclassified. */
export const IdentityErrorCode = Schema.Literal(
  ...runnerErrorCodes,
  "invalid_json",
  "invalid_shape",
  "unclassified",
);
