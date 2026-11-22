import { Schema } from "effect";

export { DialogChoice, DialogFailure, DialogType } from "../../runtime/dialogs.js";
/**
 * A write mint's accepted confirm popup, stored with the published revision so a later run of
 * the same write accepts the same popup at the same step without asking.
 * The revision is shared, so it keeps only a SHA-256 digest of the popup's normalized message,
 * page origin and generated step, never the page's own text (`expectedConfirmDigest` in
 * `expected.ts`). A message that names a value of the step's input or the page's record
 * identifier is digested with each such value replaced by where it came from.
 */
export const ExpectedConfirm = Schema.Struct({
  digest: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/)),
});
export type ExpectedConfirm = typeof ExpectedConfirm.Type;
/** Host-only facts about a held dialog. Never sent to the page, the caller or a model. */
export interface DialogFacts {
  /** The dialog's own message, unscreened. */
  readonly message: string;
  /** The URL of the page that showed it, when it showed. */
  readonly pageUrl: string;
}
