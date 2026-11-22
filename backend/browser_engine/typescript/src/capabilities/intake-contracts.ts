import { Schema } from "effect";

export const IntakeReasonCode = Schema.Literal(
  "stateful_flow",
  "branching_form",
  "realtime_stream",
  /**
   * @deprecated A tool can return a downloaded file now, so this host never refuses for it. It
   * stays until hosts stop emitting it, and a later release removes it.
   */
  "file_download",
  "native_app_only",
  "long_running",
  "multi_account",
);
export type IntakeReasonCode = typeof IntakeReasonCode.Type;
