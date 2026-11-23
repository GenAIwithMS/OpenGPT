import { Effect, Option, Schema } from "effect";
import { CredentialRejectedField } from "./authentication.js";
import type { SessionLoss } from "./authentication.js";
import { ChallengeFailure } from "./challenge.js";
import { CommitAlreadySent, WriteConfirmationRefused } from "./errors.js";
import type { Dispatch } from "./errors.js";
import type { BrowserActionTimeout } from "./browser-action-timeout.js";
import { DialogFailure } from "./dialogs.js";
import { ScriptInputFailure } from "./script-input.js";

/** Kernel's `stderr` for a failed call: the JavaScript stack of the call's own code. */
class KernelCallStack extends Error {
  override readonly name = "KernelCallStack";
  constructor(stderr: string) {
    super("Kernel call failed");
    this.stack = stderr.slice(0, 16_384);
  }
}

/**
 * What a site's answer was when code could not use it: the destination's own status or a body
 * that did not parse. `readText` and `readJson` attach it, so the agent's result says whether the
 * site answered and how, apart from a relay or provider failure.
 */
export interface HttpAnswerFailure {
  readonly class: "destination_status" | "parsing";
  readonly request: { readonly method: string; readonly url: string };
  readonly status: number;
  readonly contentType: string;
  readonly transport: string;
  readonly bytes: number;
}

/** The most choices a refusal lists, and the longest each may be. */
export const maximumRefusalChoices = 100;
export const maximumRefusalChoiceLength = 200;

/**
 * Which input a refusal names and every choice the page offers for it, exactly as shown. A host
 * tells the caller the choices, so the caller can pick one; a host that repairs has nothing to
 * check when the page listed them. An empty list beside the field says the page offers nothing
 * for that input.
 */
export interface InputRefusalDetail {
  readonly field?: string;
  readonly available?: readonly string[];
  /**
   * The refusal's kind as a short token, lowercase words joined by underscores, such as a
   * refused cursor's `expired`. Never page text.
   */
  readonly kind?: string;
}

/** A refusal's kind: lowercase words joined by underscores. */
const refusalKindPattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
const maximumRefusalKindLength = 40;

/** The detail as a host may carry it: a bounded field name and up to the most choices, each bounded. */
export const boundedRefusalDetail = (detail: unknown): InputRefusalDetail => {
  if (typeof detail !== "object" || detail === null) return {};
  const field: unknown = Reflect.get(detail, "field");
  const available: unknown = Reflect.get(detail, "available");
  const kind: unknown = Reflect.get(detail, "kind");
  const choices = Array.isArray(available)
    ? available
        .filter((choice): choice is string => typeof choice === "string" && choice.trim() !== "")
        .slice(0, maximumRefusalChoices)
        .map((choice) => choice.slice(0, maximumRefusalChoiceLength))
    : [];
  return {
    ...(typeof field === "string" && field.trim() !== ""
      ? { field: field.slice(0, maximumRefusalChoiceLength) }
      : {}),
    ...(choices.length > 0 ? { available: choices } : {}),
    ...(typeof kind === "string" &&
    kind.length <= maximumRefusalKindLength &&
    refusalKindPattern.test(kind)
      ? { kind }
      : {}),
  };
};

/** Whether a refusal's detail lists no choice at all: an array with no entries, not a missing one. */
const offersNone = (detail: unknown) => {
  const available: unknown =
    typeof detail === "object" && detail !== null ? Reflect.get(detail, "available") : undefined;
  return Array.isArray(available) && available.length === 0;
};

/**
 * The site refused a caller's value, such as a past date or an unknown airport code. It is the
 * caller's to correct, so the run fails as `InvalidInput`. Scripts throw it as
 * `errors.InvalidInput`, never for a page or control that changed, except for a secret field no
 * question may ask, such as a card number, that a step's first click showed without saving
 * anything (`blockingRequiredFields` with `unaskable: true`). When the value is not among the
 * choices the page offers, the script names the input and lists them:
 * `new errors.InvalidInput(message, { field: "size", available: ["One Size"] })`. The caller then
 * picks one of them, so nothing asks it for a replacement. A message that starts
 * "Caller input error:" marks an obvious refusal: the input alone breaks a rule of the task,
 * checked before any site action, or the page refused the value in its own words, which the
 * message quotes. A host may end such a run at once, with no repair and no question. An empty
 * list beside the field, `{ field, available: [] }`, says the page offers nothing for that input:
 * the error keeps it, though `boundedRefusalDetail` and the local host carry none. A refusal
 * without choices, of a free-form value the page lists no options for, may be checked by a host
 * that repairs, which asks the caller only when its check leaves real doubt.
 */
class InputRejected extends Error {
  override readonly name = "InvalidInput";
  readonly _tag = "InvalidInput";
  readonly field?: string;
  readonly available?: readonly string[];
  readonly kind?: string;
  constructor(message: string, detail?: InputRefusalDetail) {
    super(message.slice(0, 4096));
    const bounded = boundedRefusalDetail(detail);
    if (bounded.field !== undefined) this.field = bounded.field;
    if (bounded.available !== undefined) this.available = bounded.available;
    else if (bounded.field !== undefined && offersNone(detail)) this.available = [];
    if (bounded.kind !== undefined) this.kind = bounded.kind;
  }
}

/** The longest site message an unapplied input's detail may carry. */
export const maximumSiteMessageLength = 1000;

/**
 * An input the caller supplied that the page did not apply: the input's name, the caller's
 * value, what the page committed instead when it showed one, the tool's step that failed, and
 * the page's own words when it showed an error.
 */
export interface InputNotAppliedDetail {
  readonly field: string;
  readonly requested: string;
  readonly applied?: string;
  readonly step: string;
  readonly siteMessage?: string;
}

/** A part's text, a finite number such as a numeric ZIP code included. */
const boundedText = (value: unknown, limit: number) => {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  return typeof text === "string" && text.trim() !== "" ? text.trim().slice(0, limit) : undefined;
};

/**
 * The detail as a host may carry it, each part bounded; undefined when it lacks the field, the
 * requested value or the step.
 */
export const boundedInputDetail = (detail: unknown): InputNotAppliedDetail | undefined => {
  if (typeof detail !== "object" || detail === null) return undefined;
  const at = (key: string, limit = maximumRefusalChoiceLength) =>
    boundedText(Reflect.get(detail, key), limit);
  const [field, requested, applied, step, siteMessage] = [
    at("field"),
    at("requested"),
    at("applied"),
    at("step"),
    at("siteMessage", maximumSiteMessageLength),
  ];
  if (field === undefined || requested === undefined || step === undefined) return undefined;
  return {
    field,
    requested,
    ...(applied === undefined ? {} : { applied }),
    step,
    ...(siteMessage === undefined ? {} : { siteMessage }),
  };
};

/**
 * The page did not apply a valid value the caller supplied, such as a location, store, filter,
 * sort or date it ignored or reset, after the tool's bounded retries. The run fails rather than
 * return results computed without the caller's value. Scripts throw it as
 * `errors.InputNotApplied`, after reading the page's committed value back:
 * `new errors.InputNotApplied(message, { field: "sort", requested: input.sort, applied, step:
 * "apply_sort", siteMessage })`. `applied` is what the page kept, when it shows one;
 * `siteMessage` is the page's own error, when it showed one. A value the site does not offer is
 * the caller's to correct: that is `InvalidInput` with the values it offers.
 * `errors.LocationNotApplied` is a deprecated alias of this class, kept for published tools.
 */
class InputUnapplied extends Error {
  override readonly name = "InputNotApplied";
  readonly _tag = "InputNotApplied";
  readonly unapplied?: InputNotAppliedDetail;
  constructor(message: string, detail?: InputNotAppliedDetail) {
    super(message.slice(0, 4096));
    const bounded = boundedInputDetail(detail);
    if (bounded !== undefined) this.unapplied = bounded;
  }
}

/** A site refused a sign-in value; its field kind contains no credential or page text. */
export class CredentialsRejected extends Error {
  override readonly name = "CredentialsRejected";
  readonly _tag = "CredentialsRejected";
  constructor(readonly field: CredentialRejectedField) {
    super("Sign-in credential rejected");
    if (Option.isNone(Schema.decodeUnknownOption(CredentialRejectedField)(field)))
      throw new TypeError("Unknown sign-in field");
  }
}

/**
 * A Kernel script's own failure: a call returned `success: false`, or the page was not in the
 * state the script needs. `dispatch` says whether a website write may have gone out. A failed
 * call's `stderr` becomes the cause, so its stack reaches the failure detail. `sessionLoss` is set
 * by the runtime when the host could not sign the page in again (`ensureSignedIn`).
 */
export class OperationFailure extends Error {
  override readonly name = "OperationFailure";
  readonly _tag = "OperationFailure";
  readonly dispatch: Dispatch;
  readonly http?: HttpAnswerFailure;
  readonly sessionLoss?: SessionLoss;
  constructor(
    message: string,
    options: {
      readonly dispatch?: Dispatch;
      readonly cause?: unknown;
      readonly stderr?: string | undefined;
      readonly http?: HttpAnswerFailure;
      readonly sessionLoss?: SessionLoss;
    } = {},
  ) {
    const cause =
      options.cause ?? (options.stderr ? new KernelCallStack(options.stderr) : undefined);
    super(message.slice(0, 4096), cause === undefined ? {} : { cause });
    this.dispatch = options.dispatch ?? "unknown";
    if (options.http !== undefined) this.http = options.http;
    if (options.sessionLoss !== undefined) this.sessionLoss = options.sessionLoss;
  }
}

/** Preserve the cause and dispatch when a script fails outside its declared errors. */
const unexpectedScriptFailure = (error: unknown, dispatch: Dispatch) =>
  new OperationFailure(
    Effect.isEffect(error)
      ? "This browser script returned an Effect instead of its output, so the Effect never ran"
      : error instanceof Error
        ? error.message
        : String(error),
    { cause: error, dispatch },
  );

/** Typed failures a Kernel script's run may end with, as the runner reports them. */
export type ScriptFailure =
  | OperationFailure
  | InputRejected
  | InputUnapplied
  | CredentialsRejected
  | BrowserActionTimeout
  | ChallengeFailure
  | DialogFailure
  | ScriptInputFailure
  | WriteConfirmationRefused
  | CommitAlreadySent;

const passThrough = (error: unknown): error is ScriptFailure =>
  error instanceof OperationFailure ||
  error instanceof InputRejected ||
  error instanceof InputUnapplied ||
  error instanceof CredentialsRejected ||
  error instanceof ChallengeFailure ||
  error instanceof DialogFailure ||
  error instanceof ScriptInputFailure ||
  error instanceof WriteConfirmationRefused ||
  error instanceof CommitAlreadySent;

/** A throw that is not one of the script's typed errors becomes an `OperationFailure`. */
export const scriptFailure = (
  error: unknown,
  diagnose?: (error: unknown, dispatch: Dispatch) => OperationFailure,
  dispatch: Dispatch = "unknown",
): ScriptFailure =>
  passThrough(error)
    ? error
    : diagnose !== undefined
      ? diagnose(error, dispatch)
      : unexpectedScriptFailure(error, dispatch);

/**
 * The typed errors a Kernel script may throw, its context's `errors`. Each is a class, so construct
 * it with `new`: `throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr })`.
 * `ChallengeFailure` comes only from `waitPastChallenge`.
 */
export const operationErrors = {
  OperationFailure,
  ChallengeFailure,
  InvalidInput: InputRejected,
  InputNotApplied: InputUnapplied,
  /** Deprecated: the same class as `InputNotApplied`, kept so published tools that throw it still run. */
  LocationNotApplied: InputUnapplied,
  CredentialsRejected,
} as const;
