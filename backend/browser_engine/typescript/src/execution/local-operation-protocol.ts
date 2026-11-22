import { Schema } from "effect";
import { InputRequest } from "../runtime/input-request.js";
import { DialogReport } from "../runtime/kernel-operation.js";
import { maximumInputIssuePath, maximumInputIssues } from "../runtime/errors.js";
import { ScriptQuestionDeclarations } from "../runtime/script-input.js";
import { FileField, fileReferenceMaxLength } from "../runtime/files.js";
import {
  maximumRefusalChoiceLength,
  maximumRefusalChoices,
  maximumSiteMessageLength,
} from "../runtime/operation-failure.js";
import { HttpCapability, HttpResponseGap, SiteHttpRequest } from "../runtime/site-http.js";
import { ListDraft } from "../runtime/list-page.js";
import { ScriptCardFillRequest } from "../runtime/script-card-fill.js";

const HttpTransportName = Schema.Literal("kernel-curl", "page-fetch", "saved-http");
/** The host transport's answer to a child's `http` request, as `SiteHttpResponse`. */
export const LocalHttpAnswer = Schema.Struct({
  status: Schema.Int,
  headers: Schema.Record({ key: Schema.String, value: Schema.Array(Schema.String) }),
  body: Schema.Uint8ArrayFromSelf,
  transport: HttpTransportName,
  finalUrl: Schema.optionalWith(Schema.String, { exact: true }),
  gaps: Schema.Array(HttpResponseGap),
});

const InputIssue = Schema.Struct({
  path: Schema.String.pipe(Schema.maxLength(maximumInputIssuePath)),
  issue: Schema.Literal("missing", "invalid"),
});

const RefusalText = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(maximumRefusalChoiceLength),
);
/** A script's refusal: the input it names, the choices the page offers for it and its kind. */
export const InputRefusal = Schema.Struct({
  field: Schema.optionalWith(RefusalText, { exact: true }),
  available: Schema.optionalWith(
    Schema.Array(RefusalText).pipe(Schema.minItems(1), Schema.maxItems(maximumRefusalChoices)),
    { exact: true },
  ),
  kind: Schema.optionalWith(
    Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u), Schema.maxLength(40)),
    { exact: true },
  ),
});

/** A script's `InputNotApplied`: the input it could not apply and what the page kept. */
export const InputNotApplied = Schema.Struct({
  field: RefusalText,
  requested: RefusalText,
  applied: Schema.optionalWith(RefusalText, { exact: true }),
  step: RefusalText,
  siteMessage: Schema.optionalWith(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(maximumSiteMessageLength)),
    { exact: true },
  ),
});

const Id = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200));
export const LocalOperationStart = Schema.Struct({
  kind: Schema.Literal("start"),
  entrypoint: Schema.String,
  input: Schema.Unknown,
  retainedOutput: Schema.optionalWith(Schema.Struct({ value: Schema.Unknown }), { exact: true }),
  sessionId: Schema.String,
  siteOrigin: Schema.optionalWith(Schema.String, { exact: true }),
  siteDomain: Schema.optionalWith(Schema.String, { exact: true }),
  timeoutMs: Schema.Number.pipe(Schema.positive(), Schema.finite()),
  mode: Schema.Literal("run", "contract"),
  validateInput: Schema.optionalWith(Schema.Boolean, { exact: true }),
  /** An output that fails its schema returns as the result, flagged as drift, not as a failure. */
  keepDriftedOutput: Schema.optionalWith(Schema.Literal(true), { exact: true }),
  /** A run with no browser, such as a parser: it never marks a possible dispatch. */
  offline: Schema.optionalWith(Schema.Literal(true), { exact: true }),
  /** A mint step: it counts as possibly sent from its first browser call, not from its start. */
  dispatchAtFirstCall: Schema.optionalWith(Schema.Literal(true), { exact: true }),
  /** The host signs the page in again when the script's `ensureSignedIn` finds it signed out. */
  signIn: Schema.optionalWith(Schema.Literal(true), { exact: true }),
  /** The host types the run's card answers for the script's `fillCard`. */
  cardFill: Schema.optionalWith(Schema.Literal(true), { exact: true }),
  /**
   * The host signs list cursors: the position the caller's cursor holds, once the host checked
   * it, which the run gets beside its input (`withListHost`).
   */
  list: Schema.optionalWith(
    Schema.Struct({ position: Schema.optionalWith(ListDraft, { exact: true }) }),
    { exact: true },
  ),
  /** The host places and collects files for the script's `files`. */
  files: Schema.optionalWith(Schema.Literal(true), { exact: true }),
  /** The host carries an HTTP version's `SiteHttp` requests over this transport. */
  http: Schema.optionalWith(
    Schema.Struct({ name: HttpTransportName, capabilities: Schema.Array(HttpCapability) }),
    { exact: true },
  ),
});
export const LocalOperationReply = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("reply"), id: Id, value: Schema.Unknown }),
  Schema.Struct({
    kind: Schema.Literal("failure"),
    id: Id,
    error: Schema.String,
    code: Schema.optionalWith(Schema.String, { exact: true }),
  }),
);
const JournalFields = {
  effect: Schema.Literal("not_started", "may_have_dispatched", "verified"),
  confirmation: Schema.optionalWith(Schema.Literal("message", "readback"), { exact: true }),
  commits: Schema.Array(
    Schema.Struct({ name: Schema.String, state: Schema.Literal("not_sent", "sent", "confirmed") }),
  ),
};
const WriteDeclaration = Schema.Struct({
  confirmation: Schema.Literal("message", "readback", "unverifiable"),
  commits: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
  commitsUnproven: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
});
export const LocalOperationMessage = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("execute"),
    id: Id,
    sessionId: Schema.String,
    body: Schema.Struct({
      code: Schema.String.pipe(Schema.maxLength(1_048_576)),
      timeout_sec: Schema.optionalWith(Schema.Int.pipe(Schema.between(1, 300)), { exact: true }),
    }),
  }),
  Schema.Struct({ kind: Schema.Literal("ask"), id: Id, request: InputRequest }),
  Schema.Struct({ kind: Schema.Literal("dialog"), id: Id, report: DialogReport }),
  Schema.Struct({ kind: Schema.Literal("sign_in"), id: Id }),
  /** `fillCard`: the host types the card answers behind the handles into the named fields. */
  Schema.Struct({ kind: Schema.Literal("card_fill"), id: Id, step: ScriptCardFillRequest }),
  /** `files.place`: the host puts the referenced file into the located file input. */
  Schema.Struct({
    kind: Schema.Literal("file_place"),
    id: Id,
    reference: Schema.String.pipe(Schema.maxLength(fileReferenceMaxLength)),
    field: FileField,
    timeoutSec: Schema.Int.pipe(Schema.between(1, 300)),
  }),
  /** `files.collect`, before its trigger: the host starts capturing downloads. */
  Schema.Struct({ kind: Schema.Literal("file_arm"), id: Id }),
  /** `files.collect`, after its trigger: the host keeps the slot's download. */
  Schema.Struct({
    kind: Schema.Literal("file_collect"),
    id: Id,
    slot: Id,
    timeoutMs: Schema.Number.pipe(Schema.between(0, 300_000)),
  }),
  /** One `SiteHttp` request the child validated, for the host's transport to send. */
  Schema.Struct({
    kind: Schema.Literal("http"),
    id: Id,
    request: SiteHttpRequest,
    timeoutMs: Schema.Number.pipe(Schema.positive(), Schema.finite()),
    maxResponseBytes: Schema.optionalWith(Schema.Int.pipe(Schema.positive()), { exact: true }),
  }),
  Schema.Struct({ kind: Schema.Literal("cancel"), id: Id }),
  Schema.Struct({ kind: Schema.Literal("journal"), ...JournalFields }),
  Schema.Struct({
    kind: Schema.Literal("result"),
    output: Schema.optionalWith(Schema.Unknown, { exact: true }),
    /** The output failed the operation's output schema; the host keeps it as drift. */
    outputDrift: Schema.optionalWith(Schema.Literal(true), { exact: true }),
    inputSchema: Schema.Unknown,
    outputSchema: Schema.Unknown,
    write: Schema.optionalWith(WriteDeclaration, { exact: true }),
    /** A contract extraction's declared questions, which the public definition lists. */
    questions: Schema.optionalWith(ScriptQuestionDeclarations, { exact: true }),
    inputDecodes: Schema.optionalWith(Schema.Literal(true), { exact: true }),
    ...JournalFields,
  }),
  Schema.Struct({
    kind: Schema.Literal("error"),
    error: Schema.String,
    code: Schema.optionalWith(Schema.String, { exact: true }),
    tag: Schema.optionalWith(Schema.String, { exact: true }),
    /** The host could not sign the page in again (`ensureSignedIn`). */
    sessionLoss: Schema.optionalWith(Schema.Literal("session_not_kept"), { exact: true }),
    /** The authored source line that threw, such as `src/tool.mjs:12`, when the stack names one. */
    frame: Schema.optionalWith(Schema.String.pipe(Schema.maxLength(300)), { exact: true }),
    inputIssues: Schema.optionalWith(
      Schema.Array(InputIssue).pipe(Schema.maxItems(maximumInputIssues)),
      { exact: true },
    ),
    refusal: Schema.optionalWith(InputRefusal, { exact: true }),
    unapplied: Schema.optionalWith(InputNotApplied, { exact: true }),
    ...JournalFields,
  }),
);
export type LocalOperationMessage = typeof LocalOperationMessage.Type;
export type LocalOperationResult = Extract<LocalOperationMessage, { readonly kind: "result" }>;
