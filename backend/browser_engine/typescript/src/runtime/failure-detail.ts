import { Cause, Option, ParseResult, Runtime, Schema } from "effect";
import {
  authorizationCredential,
  awsAccessKeyIdPattern,
  bracketedValueSource,
  cookieCredentials,
  credentialNameSource,
  credentialPolicy,
  isCredentialAssignmentKey,
  isFreeTextSchemeCredential,
  isKeptAssignmentValue,
  isLiteralValue,
  isOrdinaryWord,
  isProviderKey,
  providerKeyPattern,
} from "../privacy/credential-policy.js";
import { isSecretKey } from "../privacy/secret-keys.js";
import { type UrlSpan, urlReaches, urlSpanAt, urlSpans } from "../privacy/url-spans.js";

/**
 * Detailed failure record shared by every host failure class. The finite fields (`subCause`,
 * `operation`, `phase`) may reach operational logs; everything else reaches the screened
 * diagnostic archive, where the privacy broker screens it again under the diagnostics area policy,
 * and, for a relayed HTTP failure only, the sandbox's answer through a host's HTTP relay.
 */

/** Stable, finite sub-causes. Add a new value rather than reusing one for a different check. */
const failureSubCauses = [
  // A host's CDP transport to its browser
  "cdp_endpoint_invalid",
  "cdp_connect_failed",
  "cdp_command_rejected",
  "cdp_command_timed_out",
  "cdp_command_pending_limit",
  "cdp_socket_error",
  "cdp_socket_closed",
  "cdp_send_failed",
  "cdp_frame_over_limit",
  "cdp_envelope_invalid",
  "cdp_transport_closed",
  "cdp_command_not_allowed",
  // A host's HTTP relay and direct sign-in
  "http_relay_transport_failed",
  "direct_login_transport_failed",
  // Host autofill sign-in (destinations/autofill-step.ts); a failed fill keeps no error text
  "autofill_step_failed",
  // A host's browser recorder
  "recorder_start_incomplete",
  "recorder_context_ambiguous",
  "recorder_primary_missing",
  "recorder_target_setup_failed",
  "recorder_event_unreadable",
  "recorder_foreign_target_unclosed",
  "recorder_target_undetached",
  "recorder_request_unseen",
  // Origin policy reads a hosted service may make before and while it browses
  "origin_route_blocked",
  "origin_policy_read_failed",
  "origin_policy_timeout",
  "origin_policy_snapshot_stale",
  "origin_url_invalid",
  // A hosted service's job browser
  "browser_origin_missing",
  "browser_initial_policy_failed",
  "browser_initial_origin_blocked",
  // The primary origin is on a site blocklist a hosted service may keep
  "browser_site_not_supported",
  "browser_entry_url_invalid",
  "browser_primary_page_crashed",
  "browser_primary_page_closed",
  "browser_gone",
  "browser_unresponsive",
  // The browser responded with a page-command failure, such as a script error or timeout.
  "browser_page_call_failed",
  // A mint browser lost a third time with no agent command since the first
  "browser_loss_repeated",
  // Startup and job authority a hosted service may check before and during a job
  "startup_job_read_failed",
  "startup_attempt_superseded",
  "startup_cancel_requested",
  "startup_job_stopping",
  "startup_job_stopped",
  "startup_maintenance_work_failed",
  "startup_original_read_failed",
  "startup_original_cancel_requested",
  // An attempt's unreadable authority check and the grace that bounds it
  "authority_check_unreadable",
  "authority_unavailable_past_grace",
  // The heartbeat, and its thread, that a hosted service may use to hold an attempt's lease
  "lease_attempt_inactive",
  "lease_watchdog_expired",
  "lease_thread_failed",
  "run_authority_check_unreadable",
  "mint_original_cancel_requested",
  "credentials_resolve_failed",
  // A run's in-place login question went unanswered, was refused, or could not be asked.
  "run_login_request_failed",
  "run_expired_auth_site_mismatch",
  // A run's lost page or browser and its retry
  "run_browser_loss_retried",
  "run_signed_in_session_cleared",
  // A session a mode or proxy change wiped again past the attempt's relogin cap
  "browser_relogin_spent",
  // A wiped session whose latest sign-in was never verified
  "browser_relogin_unverified",
  // A mint's authenticate after its attempt's sign-ins were spent: sign-in is unavailable in the
  // build
  "mint_sign_in_spent",
  "run_browser_loss_retry_declined",
  // A write mint's accepted confirm it could not screen for secrets, so never kept
  "mint_expected_confirm_unscreened",
  // A mint host's destination authority
  "mint_admission_generation_changed",
  // A publication whose attempt no longer holds its job, or whose job was told to stop
  "publication_attempt_stopped",
  // A mint host's managed-login identity check
  "identity_receipt_invalid",
  "identity_check_failed",
  // The site rejected the supplied credentials during managed login; not a dependency failure.
  "managed_login_credentials_rejected",
  // A run's autofill replay: the site showed the password screen again after it took the
  // password, or the replay did not sign in for another reason, which maintenance repairs.
  "autofill_credentials_rejected",
  "operation_credentials_rejected",
  "run_autofill_sign_in_failed",
  // A run's sign-in found an execution VM that could still reach its browser, so nothing was
  // filled.
  "run_sign_in_executor_attached",
  // A host resource that did not settle within its bound: the attempt's host close, and the
  // browser stop after a cancel or a lost lease
  "mint_host_settle_timeout",
  "mint_outside_stop_timeout",
  // A takeover's resource that stayed unavailable for the whole recovery wait
  "mint_recovery_wait_timeout",
  // A takeover's step whose outcome no later try can confirm
  "mint_recovery_unconfirmed",
  // The model provider refused a mint's call because the account's quota is spent (mint/openai.ts)
  "model_quota_exhausted",
  // Input request answers and views: the request's protected handoff was deleted or had
  // expired, so the request closed while it was read.
  "input_request_handoff_closed",
  // A host's authority reference and its recheck
  "host_authority_reference_invalid",
  "host_authority_recheck_failed",
  // A queued attempt's server renewal and a job whose
  // Dashboard session its owner ended by signing out before it started
  "authority_server_renewal_cap_reached",
  "authority_server_renewal_conflict",
  "authority_server_renewal_stopped",
  "authority_server_renewal_unavailable",
  "authority_session_signed_out",
  // A takeover that never settled ended its job as a lost lease
  "recovery_unsettled",
  // A browser create the provider kept answering with 429 past its wait budget
  "kernel_rate_limited",
  // Dependency failures wrapped by a host failure, by area. `site` names the mapping.
  "mint_execution_failed",
  "mint_host_dependency_failed",
  "worker_dependency_failed",
  "kernel_provider_failed",
  "profile_operation_failed",
  "capture_operation_failed",
  "executor_boundary_failed",
  "sandbox_workspace_failed",
  "credential_connector_failed",
  // A hosted service may refuse to start a credential worker: the Kubernetes API refused the
  // worker, by admission policy or webhook, a quota, a webhook that can't judge a dry run, or
  // otherwise (authorization, an invalid template)
  "admission_rejected",
  "quota_exceeded",
  "dry_run_unsupported",
  "kubernetes_create_rejected",
  // ...or the service refused before creating one
  "launcher_draining",
  "launcher_at_capacity",
  "launcher_tenant_at_capacity",
  "workload_mode_forbidden",
  "controller_operation_forbidden",
  "workload_identity_mismatch",
  "launch_superseded",
  // ...or the start's signed capability did not cover it
  "capability_refused",
  // A credential worker's call to start work that never arrived: DNS, connection or TLS failed,
  // as when network policy blocks the worker's egress
  "worker_launcher_unreachable",
  "job_storage_failed",
  "private_input_storage_failed",
  "deploybot_operation_failed",
  "gateway_dependency_failed",
  "guardian_dependency_failed",
  "application_dependency_failed",
  "provider_failed",
  "integration_dependency_failed",
  "dependency_failed",
  // A caller's mistake, not a dependency failure: bad arguments or input, an unknown resource.
  "invalid_input",
  "not_found",
  "unclassified",
] as const;
export type FailureSubCause = (typeof failureSubCauses)[number];

/**
 * Generous bounds that keep a record storable (one archive object, one log line well under
 * CloudWatch's 256 KiB event limit), never a cut to hide detail.
 */
const bounds = {
  message: 16 * 1024,
  chainMessage: 8 * 1024,
  chainDepth: 8,
  stackFrames: 48,
  frameLength: 1024,
  contextKeys: 128,
  contextValue: 16 * 1024,
  fieldValue: 4 * 1024,
  commands: 128,
  serialized: 128 * 1024,
} as const;
export const failureDetailBounds = bounds;

/** A route at the start of the text (`/v1/items?page=2`) is kept like a URL, ending as one does. */
const diagnosticUrlSpans = (text: string) => {
  const spans = urlSpans(text);
  if (!text.startsWith("/") || text.startsWith("//")) return spans;
  const route = urlSpanAt(text, 0);
  return [route, ...spans.filter((span) => span.start >= route.end)];
};

/**
 * What releases before URLs ended at field delimiters kept as URLs: each URL to the next space or
 * quote, and a leading route to the first space or quote. Sorted, and never a screening exemption.
 */
const legacyUrlSpans = (text: string): UrlSpan[] => {
  const reaches = urlReaches(text);
  if (!text.startsWith("/")) return reaches;
  const separator = text.search(/[\s"'<>`]/);
  const routeEnd = separator === -1 ? text.length : separator;
  return [{ start: 0, end: routeEnd }, ...reaches.filter((span) => span.start >= routeEnd)];
};

const withoutUrls = (text: string) => {
  let result = "";
  let cursor = 0;
  for (const span of diagnosticUrlSpans(text)) {
    result += text.slice(cursor, span.start);
    cursor = span.end;
  }
  return result + text.slice(cursor);
};

/**
 * The length of `text` outside its URLs, for the stored bounds. A URL is also measured as releases
 * before URLs ended at field delimiters measured it, so a record such a release bounded still
 * decodes.
 */
const lengthOutsideUrls = (text: string) => {
  const spans = diagnosticUrlSpans(text).concat(legacyUrlSpans(text));
  spans.sort((left, right) => left.start - right.start);
  let inside = 0;
  let covered = 0;
  for (const span of spans) {
    inside += Math.max(0, span.end - Math.max(span.start, covered));
    covered = Math.max(covered, span.end);
  }
  return text.length - inside;
};

const limitOutsideUrls = (text: string, max: number, tokenBoundary = false) => {
  if (text.length <= max) return { value: text, omitted: 0 };
  let value = "";
  let cursor = 0;
  let remaining = max;
  let omitted = 0;
  // The last character appended, kept apart: reading it from `value`, a string built by `+=`,
  // flattens that string each time, which is quadratic over many URLs.
  let last = "";
  const append = (piece: string) => {
    value += piece;
    if (piece !== "") last = piece.charAt(piece.length - 1);
  };
  const appendPlain = (plain: string) => {
    if (remaining >= plain.length) {
      append(plain);
      remaining -= plain.length;
      return;
    }
    const end = /[\uD800-\uDBFF]/.test(plain.charAt(remaining - 1)) ? remaining - 1 : remaining;
    const prefix = tokenBoundary ? plain.slice(0, end).replace(/\S*$/, "") : plain.slice(0, end);
    append(prefix);
    omitted += plain.length - prefix.length;
    remaining = 0;
  };
  // A URL's characters an older release would not count as URL, such as a balanced closer it
  // trimmed, are charged to the budget, so the result still fits that release's bound.
  const legacy = legacyUrlSpans(text);
  let next = 0;
  const outsideLegacy = (span: UrlSpan) => {
    while (next < legacy.length && (legacy[next]?.end ?? 0) <= span.start) next++;
    let inside = 0;
    for (let index = next; index < legacy.length; index++) {
      const range = legacy[index];
      if (range === undefined || range.start >= span.end) break;
      inside += Math.min(range.end, span.end) - Math.max(range.start, span.start);
    }
    return span.end - span.start - inside;
  };
  for (const span of diagnosticUrlSpans(text)) {
    appendPlain(text.slice(cursor, span.start));
    remaining = Math.max(0, remaining - outsideLegacy(span));
    if (omitted > 0 && last !== "" && !/\s/.test(last)) append(" ");
    append(text.slice(span.start, span.end));
    cursor = span.end;
  }
  appendPlain(text.slice(cursor));
  return { value, omitted };
};

const truncate = (text: string, max: number) => {
  const limited = limitOutsideUrls(text, max);
  return limited.omitted === 0 ? limited.value : `${limited.value}…[truncated ${limited.omitted}]`;
};

/**
 * A credential name (`privacy/credential-policy.ts`), quoted or bare and with any prefix,
 * followed by `=` or `:`. The key's word boundary is checked by `isCredentialAssignmentKey`.
 * After `=` a bracketed value (`password=[…]`) is one credential; after `:` a bracket opens a
 * JSON container, whose own leaves are screened where they are.
 */
const credentialAssignment = new RegExp(
  String.raw`([,;|\s"'{()\]]|^)((?:[A-Za-z0-9]+[-_])*[A-Za-z0-9]*(?:${credentialNameSource}))(\\?["']?\s*[=:]\s*)(${bracketedValueSource}|\\?"(?:\\.|[^"\\])*\\?"|\\?"(?:\\.|[^"\\\r\n])*\\?|'[^']*'|[^\s;,"')}][^\s;,"')}]*)`,
  "gi",
);
/** A Key Vault or Secrets Manager response holds the secret itself under `value`. */
const vaultResponse =
  /\.vault\.azure\.net|"SecretString"|secretsmanager|"contentType"\s*:\s*"[^"]*"\s*,\s*"id"/i;
const vaultValue = /(\\?")(value)(\\?"\s*:\s*)(\\"(?:(?!\\").)*\\"|"(?:\\.|[^"\\])*")/gi;
/** Largest non-URL input redacted; whole URLs are retained even beyond this bound. */
const redactionInputLimit = 64 * 1024;
/**
 * JSON fields that carry request credentials or vault secrets, including escaped JSON. A header
 * field holding one ordinary word (`"cookie":"accepted"`) is not a credential.
 */
const jsonCredential = new RegExp(
  String.raw`(\\?")(${[...credentialPolicy.jsonHeaderFields, ...credentialPolicy.vaultFields].join("|")})(\\?"\s*:\s*)(\\"(?:(?!\\").)*\\"|"(?:\\.|[^"\\])*"|"(?:\\.|[^"\\\r\n])*\\?)`,
  "gi",
);
const vaultField = new RegExp(`^(?:${credentialPolicy.vaultFields.join("|")})$`, "i");
const jsonCredentialValue = (key: string, value: string) => {
  const content = value.replace(/^\\?"|\\?"$/g, "");
  return vaultField.test(key) || (content !== "" && !isOrdinaryWord(content));
};
/**
 * Cookie header text: `Cookie: a=1; b=2`, `cookie: 'a=1'`, `Cookie a=1` or
 * `Set-Cookie: s=1; Path=/`, including quoted values and a comma-joined Set-Cookie
 * (`credential-policy.ts` `cookieCredentials`). Only the `name=value` run, or an opaque value
 * after `:`, is masked, so `cookie: invalid format` is prose.
 */
const cookieHeader = /\b(set-cookie|cookie)(\s*:\s*["']?|\s+)([^\r\n]*)/gi;
/** `cookie=value` outside a URL, unless the value is one ordinary word (`cookie=accepted`). */
const cookieAssignment = /\b(set-cookie|cookie)(\s*=\s*)([^\s;,"'&]+)/gi;
/**
 * Header text runs to the line end, a quote or a backslash (`authorization: 'Bearer …'` from
 * `util.inspect` included), keeping quoted auth-param values (`Digest response="…"`); only its
 * credential is masked.
 */
const authorizationHeader =
  /\b((?:proxy-)?authorization)(\s*[:=]\s*["']?)((?:[^\r\n"'\\]|(?<==[ \t]*)"[^"\r\n]*")*)/gi;
const quotedRedaction = (value: string) =>
  value.startsWith("\\") ? '\\"[redacted]\\"' : '"[redacted]"';
/** AWS access key IDs and provider API keys, by shape (`privacy/credential-policy.ts`). */
const awsAccessKeyId = awsAccessKeyIdPattern();
const providerKey = providerKeyPattern();

/**
 * Deterministic credential redaction before the archive's own screening. It removes only
 * real credentials: password-style and credential-named assignments, Authorization, Cookie
 * and Set-Cookie headers, bearer and basic values, JWTs, PEM private keys, provider API-key
 * shapes and vault secret values. Every URL stays byte-exact
 * (`privacy/url-spans.ts` locates them), and ordinary
 * names such as `token` or `auth` keep their values. Values are matched by shape
 * (`privacy/credential-policy.ts`), so prose such as "basic validation failed",
 * `password: required` or `authorization: missing for this route` is kept.
 */
export const redactDiagnosticText = (text: string, max: number = bounds.message): string =>
  // A caller that keeps the whole text (no output limit) gets the whole text screened, in chunks;
  // a bounded caller only ever needs the start, so its input is cut before redaction.
  max === Number.POSITIVE_INFINITY && text.length > redactionInputLimit
    ? redactInChunks(text)
    : redactBounded(text, max, redactionInputLimit);

/** Ends of the private-key block that starts before `end`, when it does not finish by then. */
const privateKeyEnd = (text: string, start: number, end: number): number | undefined => {
  const blocks = text.slice(start, end);
  const open = blocks.lastIndexOf("-----BEGIN ");
  if (open === -1 || !/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(blocks.slice(open)))
    return undefined;
  if (/-----END [A-Z ]*PRIVATE KEY-----/.test(blocks.slice(open))) return undefined;
  const close = /-----END [A-Z ]*PRIVATE KEY-----/.exec(text.slice(end));
  return close === null ? text.length : end + close.index + close[0].length;
};

/**
 * Screens text of any length without cutting it: chunks that end at whitespace, so no token is
 * split, and never inside a private-key block, which is screened whole.
 */
const redactInChunks = (text: string): string => {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + redactionInputLimit);
    if (end < text.length) {
      const boundary = Math.max(
        text.lastIndexOf("\n", end),
        text.lastIndexOf(" ", end),
        text.lastIndexOf("\t", end),
      );
      if (boundary > start) end = boundary + 1;
      else {
        // A credential assignment may be one very long token. Keep its entire value in one
        // screening pass; later chunks would otherwise lose the credential key before it.
        const nextWhitespace = /[ \t\r\n]/gu;
        nextWhitespace.lastIndex = end;
        const next = nextWhitespace.exec(text);
        end = next === null ? text.length : next.index + 1;
      }
      end = privateKeyEnd(text, start, end) ?? end;
    }
    parts.push(
      redactBounded(text.slice(start, end), Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY),
    );
    start = end;
  }
  return parts.join("");
};

const redactBounded = (text: string, max: number, inputLimit: number): string => {
  // A cut can split a token so its pattern no longer matches, so the trailing partial word
  // is removed with the cut, and redaction always runs before the output is truncated.
  const input = limitOutsideUrls(text, inputLimit, true).value;
  // URLs are set aside so no credential rule rewrites them.
  const urls: string[] = [];
  let protectedText = "";
  let cursor = 0;
  for (const span of diagnosticUrlSpans(input)) {
    protectedText += `${input.slice(cursor, span.start)}\uE000${urls.length}\uE000`;
    urls.push(input.slice(span.start, span.end));
    cursor = span.end;
  }
  protectedText += input.slice(cursor);
  const redacted = (
    vaultResponse.test(input)
      ? protectedText.replace(
          vaultValue,
          (_match, open: string, key: string, separator: string, value: string) =>
            `${open}${key}${separator}${quotedRedaction(value)}`,
        )
      : protectedText
  )
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      "[redacted_private_key]",
    )
    .replace(
      jsonCredential,
      (match: string, open: string, key: string, separator: string, value: string) =>
        jsonCredentialValue(key, value)
          ? `${open}${key}${separator}${quotedRedaction(value)}`
          : match,
    )
    .replace(
      authorizationHeader,
      (match: string, name: string, separator: string, value: string) => {
        const credential = authorizationCredential(value);
        return credential === undefined
          ? match
          : `${name}${separator}${value.slice(0, credential.start)}[redacted]${value.slice(credential.end)}`;
      },
    )
    .replace(cookieHeader, (match: string, name: string, separator: string, value: string) => {
      const cookie = cookieCredentials(value, /^set-/i.test(name));
      if (cookie === undefined) return match;
      const run = value.slice(cookie.run.start, cookie.run.end);
      // Without a colon (`Cookie a=1`), only a leading unspaced name=value pair is a header, so
      // prose such as `cookie count = 3` stays.
      if (!separator.includes(":") && (cookie.run.start > 0 || !/^[^\s=;,"'\\]+=/.test(run)))
        return match;
      return `${name}${separator}${value.slice(0, cookie.run.start)}[redacted]${value.slice(cookie.run.end)}`;
    })
    .replace(cookieAssignment, (match: string, name: string, separator: string, value: string) =>
      value.startsWith("[redacted") || isOrdinaryWord(value) || isLiteralValue(value)
        ? match
        : `${name}${separator}[redacted]`,
    )
    .replace(
      /\b(bearer|basic)(\s+)([A-Za-z0-9._~+/=-]+)/gi,
      (match: string, scheme: string, space: string, value: string) =>
        isFreeTextSchemeCredential(scheme, value) ? `${scheme}${space}[redacted]` : match,
    )
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, "[redacted_jwt]")
    .replace(/\beyJ[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*){0,2}(?=\s*$)/g, "[redacted_jwt]")
    .replace(awsAccessKeyId, "[redacted_aws_key]")
    .replace(providerKey, (match: string) =>
      isProviderKey(match) ? "[redacted_token]" : match,
    )
    .replace(
      credentialAssignment,
      (match: string, prefix: string, key: string, separator: string, value: string) =>
        value.startsWith("[redacted") ||
        !isCredentialAssignmentKey(key) ||
        isKeptAssignmentValue(key, separator, value, input)
          ? match
          : `${prefix}${key}${separator}[redacted]`,
    )
    .replace(/\uE000(\d+)\uE000/g, (_match, index: string) => urls[Number(index)] ?? "");
  return truncate(redacted, max);
};

/** The error beneath a failure: Chromium `{code,message}`, a pg SQLSTATE, an AWS error name. */
interface UnderlyingError {
  readonly source: "cdp" | "postgres" | "aws" | "node" | "effect" | "error" | "value";
  readonly name?: string;
  readonly code?: string | number;
  readonly message?: string;
  /** A nested failure's own sub-cause, when it carried one. */
  readonly subCause?: FailureSubCause;
  /** Finite primitive fields of a tagged error, secret-named keys excluded. */
  readonly fields?: Readonly<Record<string, string | number | boolean>>;
}

export interface CdpCommandRecord {
  readonly id: number;
  readonly method: string;
  /** `browser` for the root session, otherwise the Chromium session id. */
  readonly cdpSession: string;
  readonly targetType?: string;
  readonly state: "sent" | "acked" | "failed" | "timed_out" | "abandoned";
  /** Milliseconds from transport open to send. */
  readonly sentAtMs: number;
  readonly latencyMs?: number;
  readonly errorCode?: number;
  readonly errorMessage?: string;
}

export type FailureContextValue = string | number | boolean;

export interface FailureDetail {
  readonly subCause: FailureSubCause;
  /** Exact name of the failed operation or command, for example `Target.getTargets`. */
  readonly operation?: string;
  readonly phase?: string;
  readonly elapsedMs?: number;
  readonly underlying?: UnderlyingError;
  readonly causeChain?: readonly UnderlyingError[];
  readonly stack?: readonly string[];
  readonly context?: Readonly<Record<string, FailureContextValue>>;
  readonly cdpCommands?: readonly CdpCommandRecord[];
  /** The frame that built this detail, which is the mapping site when an error is wrapped. */
  readonly site?: string;
}

const Token = Schema.String.pipe(Schema.pattern(/^[A-Za-z][A-Za-z0-9_.:/-]{0,95}$/));
const BoundedText = (max: number) =>
  Schema.String.pipe(Schema.filter((value) => lengthOutsideUrls(value) <= max + 32));
const NonNegative = Schema.Number.pipe(Schema.finite(), Schema.nonNegative());
const ContextKey = Schema.String.pipe(Schema.pattern(/^[A-Za-z][A-Za-z0-9_]{0,95}$/));
const ContextValue = Schema.Union(
  BoundedText(bounds.contextValue),
  Schema.Number.pipe(Schema.finite()),
  Schema.Boolean,
);
const UnderlyingErrorSchema = Schema.Struct({
  source: Schema.Literal("cdp", "postgres", "aws", "node", "effect", "error", "value"),
  name: Schema.optionalWith(BoundedText(128), { exact: true }),
  code: Schema.optionalWith(Schema.Union(BoundedText(64), Schema.Number.pipe(Schema.finite())), {
    exact: true,
  }),
  message: Schema.optionalWith(BoundedText(bounds.message), { exact: true }),
  subCause: Schema.optionalWith(Schema.Literal(...failureSubCauses), { exact: true }),
  fields: Schema.optionalWith(Schema.Record({ key: ContextKey, value: ContextValue }), {
    exact: true,
  }),
});
const CdpCommandRecordSchema = Schema.Struct({
  id: Schema.Int.pipe(Schema.nonNegative()),
  method: Token,
  cdpSession: BoundedText(64),
  targetType: Schema.optionalWith(BoundedText(32), { exact: true }),
  state: Schema.Literal("sent", "acked", "failed", "timed_out", "abandoned"),
  sentAtMs: NonNegative,
  latencyMs: Schema.optionalWith(NonNegative, { exact: true }),
  errorCode: Schema.optionalWith(Schema.Int, { exact: true }),
  errorMessage: Schema.optionalWith(BoundedText(bounds.chainMessage), { exact: true }),
});
export const FailureDetailSchema = Schema.Struct({
  subCause: Schema.Literal(...failureSubCauses),
  site: Schema.optionalWith(BoundedText(bounds.frameLength), { exact: true }),
  operation: Schema.optionalWith(Token, { exact: true }),
  phase: Schema.optionalWith(Token, { exact: true }),
  elapsedMs: Schema.optionalWith(NonNegative, { exact: true }),
  underlying: Schema.optionalWith(UnderlyingErrorSchema, { exact: true }),
  causeChain: Schema.optionalWith(
    Schema.Array(UnderlyingErrorSchema).pipe(Schema.maxItems(bounds.chainDepth)),
    { exact: true },
  ),
  stack: Schema.optionalWith(
    Schema.Array(BoundedText(bounds.frameLength)).pipe(Schema.maxItems(bounds.stackFrames)),
    { exact: true },
  ),
  context: Schema.optionalWith(Schema.Record({ key: ContextKey, value: ContextValue }), {
    exact: true,
  }),
  cdpCommands: Schema.optionalWith(
    Schema.Array(CdpCommandRecordSchema).pipe(Schema.maxItems(bounds.commands)),
    { exact: true },
  ),
});

const absolutePath =
  /(?:file:\/\/)?(?:[A-Za-z]:)?(?:\/[^\s():/]+)*?\/((?:typescript\/src|typescript\/tests|dist|node_modules)\/[^\s():]+)/g;

/**
 * The lines after a stack's leading `Name: message` block. That block can quote input over
 * several lines (V8's JSON.parse excerpt keeps raw newlines), and a quoted line can look like
 * a frame, so frames are read only after the error's own message.
 */
const linesAfterMessage = (stack: string, message: string) => {
  const end = message === "" ? -1 : stack.indexOf(message);
  return end === -1
    ? stack.split("\n").slice(message === "" ? 1 : message.split("\n").length)
    : stack
        .slice(end + message.length)
        .split("\n")
        .slice(1);
};

/** Frames keep function names and repository-relative locations; absolute prefixes are removed. */
const boundedStack = (
  stack: string | undefined,
  message: string,
): readonly string[] | undefined => {
  if (stack === undefined) return undefined;
  const frames = linesAfterMessage(stack, message)
    .filter((line) => /^\s+at\s/.test(line))
    .slice(0, bounds.stackFrames)
    .map((line) =>
      truncate(
        line
          .trim()
          .replace(/^at\s+/, "")
          .replace(absolutePath, "$1")
          // Any remaining absolute path keeps only its file name.
          .replace(/(^|[\s(])(?:\/[^\s():/]+)+\/([^\s():/]+)/g, "$1…/$2")
          // A frame can name an eval'd URL or data string.
          .replace(/^[\s\S]*$/, (frame) => redactDiagnosticText(frame, bounds.frameLength)),
        bounds.frameLength,
      ),
    );
  return frames.length === 0 ? undefined : frames;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";
const object = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? value : undefined;

/**
 * Key names that end in a concrete credential role (`secretAccessKey`, `pgPassword`,
 * `x-api-key`), compared without separators. Generic names stay.
 */
const credentialRoleSuffix =
  /(?:password|passwd|passphrase|passcode|clientsecret|secretaccesskey|secretkey|accountkey|sharedaccesskey|privatekey|apikey|accesstoken|refreshtoken|idtoken|sessiontoken|authtoken|securitytoken|totpseed|credentials)$/;
/** Concrete credential roles only; loose `token`, `secret`, `pass` or `pin` keys stay. */
const credentialKey = (name: string) =>
  credentialRoleSuffix.test(name.replace(/[^a-z0-9]/gi, "").toLowerCase()) || isSecretKey(name);

const fieldKey = /^[A-Za-z][A-Za-z0-9_]{0,95}$/;

/**
 * A keyed value, kept and masked as its `key=value` text would be: a credential by structure
 * (`password=…`, `api_key=…`) loses its value, any other key keeps it. Keys are never dropped.
 */
const keyedText = (key: string, value: string, max: number) => {
  const alone = redactDiagnosticText(value, max);
  const prefix = `${key}=`;
  const keyed = redactDiagnosticText(`${prefix}${alone}`, max + prefix.length);
  return keyed.startsWith(prefix) ? keyed.slice(prefix.length) : alone;
};

/**
 * Finite primitive fields of an error, one nested level deep. `skipNested` names nested fields
 * already rendered elsewhere, such as a parse issue's `actual` value, which its message quotes.
 */
const primitiveFields = (
  value: Record<string, unknown>,
  skipNested: ReadonlySet<string> = new Set(),
) => {
  const fields: Record<string, FailureContextValue> = {};
  const skip = new Set([
    "_tag",
    "name",
    "message",
    "stack",
    "cause",
    "code",
    "failureDetail",
    "cdpError",
    "history",
  ]);
  const add = (key: string, nested: unknown, maskAs = key) => {
    if (!fieldKey.test(key)) return;
    if (typeof nested === "string") fields[key] = keyedText(maskAs, nested, bounds.fieldValue);
    else if (typeof nested === "number" && Number.isFinite(nested)) fields[key] = nested;
    else if (typeof nested === "boolean") fields[key] = nested;
  };
  try {
    for (const [key, nested] of Object.entries(value)) {
      if (skip.has(key)) continue;
      const inner = object(nested);
      if (inner && !Array.isArray(nested)) {
        for (const [innerKey, innerValue] of Object.entries(inner))
          if (!skipNested.has(`${key}.${innerKey}`))
            add(`${key}_${innerKey}`, innerValue, innerKey);
      } else add(key, nested);
    }
  } catch {
    // An exotic object loses only its fields.
  }
  return Object.keys(fields).length === 0 ? undefined : fields;
};

const sqlState = /^[0-9A-Z]{5}$/;

/** How deep `parseIssueSecrets` walks an issue tree, and the most values it collects. */
const parseSecretBounds = { depth: 32, values: 64 } as const;
/** A bare value shorter than this is not masked by value: it would garble the message. */
const minMaskedValueLength = 4;

/** The credential-named keys of a parse issue pointer's path. */
const credentialPathKeys = (path: unknown): readonly string[] =>
  (Array.isArray(path) ? path : [path]).filter(
    (key): key is string => typeof key === "string" && credentialKey(key),
  );

/**
 * The `actual` values a Schema parse issue tree holds beneath a credential-named key
 * (`["password"]`, `["credentials"]["user"]`), longest first. The error's own message prints a
 * key and its value on separate tree lines, so text redaction cannot pair them; these values are
 * masked by value instead. Every other key and value stays.
 */
const parseIssueSecrets = (issue: unknown): readonly string[] => {
  const found = new Set<string>();
  const collect = (actual: unknown, depth = 0) => {
    if (found.size >= parseSecretBounds.values || depth > parseSecretBounds.depth) return;
    if (typeof actual === "string" && actual !== "") {
      found.add(JSON.stringify(actual));
      if (actual.length >= minMaskedValueLength) found.add(actual);
    } else if (typeof actual === "number" || typeof actual === "bigint") {
      if (String(actual).length >= minMaskedValueLength) found.add(String(actual));
    } else if (isRecord(actual))
      for (const nested of Object.values(actual)) collect(nested, depth + 1);
  };
  const visit = (node: unknown, underCredential: boolean, depth: number) => {
    const value = object(node);
    if (value === undefined || depth > parseSecretBounds.depth) return;
    const keys = value["_tag"] === "Pointer" ? credentialPathKeys(value["path"]) : [];
    const actual = value["actual"];
    // A pointer's `actual` is the parent input; only the pointed-to value is its key's.
    if (underCredential) collect(actual);
    else if (isRecord(actual)) for (const key of keys) collect(actual[key]);
    const inner = value["issues"] ?? value["issue"];
    for (const child of Array.isArray(inner) ? inner : [inner])
      visit(child, underCredential || keys.length > 0, depth + 1);
  };
  visit(issue, false, 0);
  return [...found].sort((left, right) => right.length - left.length);
};

/**
 * V8 quotes about ten characters either side of a JSON syntax error, so the excerpt can start
 * inside a key (`..."assword": hunter2-ca"... is not valid JSON`), where the credential
 * assignment rule no longer sees a whole name. A key fragment of at least four characters that
 * ends a password name is still that name, and its value is masked.
 */
const jsonExcerptKeyFragment =
  /(\.\.\.)(\\?"?)([A-Za-z]{4,})(\\?"\s*:\s*)(\\?"(?:[^"\\]|\\.)*(?:\\?"|$)|[^\s,}\]"]+)/g;
const endsPasswordName = (fragment: string) =>
  credentialPolicy.passwordNames.some(
    (name) => name.length > fragment.length && name.endsWith(fragment.toLowerCase()),
  );
const maskJsonExcerptKeyFragments = (message: string) =>
  message.includes("is not valid JSON")
    ? message.replace(
        jsonExcerptKeyFragment,
        (match: string, dots: string, open: string, key: string, separator: string) =>
          endsPasswordName(key) ? `${dots}${open}${key}${separator}[redacted]` : match,
      )
    : message;

/**
 * An error's own message, whole. A Schema parse
 * error keeps every issue's path with the real key names, its kind and the `actual` value it
 * quotes, including a transformation's nested error such as `parseJson`'s JSON excerpt; values
 * beneath a credential-named key are masked by value. The caller applies the structural
 * credential redaction, and the archive's broker also screens registered secrets.
 */
const errorMessage = (
  value: Record<string, unknown>,
  parseError: ParseResult.ParseError | undefined,
) => {
  let message =
    parseError === undefined
      ? typeof value["message"] === "string"
        ? value["message"]
        : ""
      : parseError.message;
  if (parseError !== undefined)
    for (const secret of parseIssueSecrets(parseError.issue))
      message = message.split(secret).join("[redacted]");
  return maskJsonExcerptKeyFragments(message);
};

/** One level of an error, without its cause. Never throws. */
const describeUnderlying = (error: unknown): UnderlyingError => {
  try {
    if (typeof error === "string")
      return { source: "value", message: redactDiagnosticText(error, bounds.chainMessage) };
    const value = object(error);
    if (!value) return { source: "value", name: typeof error };
    const nameValue = typeof value["name"] === "string" ? value["name"] : undefined;
    const tag = typeof value["_tag"] === "string" ? value["_tag"] : undefined;
    const parseError = ParseResult.isParseError(error) ? error : undefined;
    const rawMessage = errorMessage(value, parseError);
    const message = rawMessage === "" ? undefined : redactDiagnosticText(rawMessage);
    const rawCode = value["code"];
    const code =
      typeof rawCode === "string"
        ? truncate(rawCode, 64)
        : typeof rawCode === "number" && Number.isFinite(rawCode)
          ? rawCode
          : undefined;
    const nested = object(value["failureDetail"]);
    const subCause = failureSubCauses.find((candidate) => candidate === nested?.["subCause"]);
    const cdp = object(value["cdpError"]);
    const metadata = object(value["$metadata"]);
    const source: UnderlyingError["source"] = cdp
      ? "cdp"
      : typeof rawCode === "string" &&
          sqlState.test(rawCode) &&
          ("severity" in value || "routine" in value)
        ? "postgres"
        : metadata || "$fault" in value
          ? "aws"
          : "syscall" in value || "errno" in value
            ? "node"
            : tag !== undefined
              ? "effect"
              : "error";
    const cdpCode = cdp?.["code"];
    const cdpMessage = cdp?.["message"];
    // Every field is kept, a pg error's `detail`, `where` and `hint` included. The message
    // already quotes a parse issue's `actual`, with credential-keyed values masked.
    const fields = primitiveFields(
      value,
      parseError === undefined ? undefined : new Set(["issue.actual"]),
    );
    return {
      source,
      ...((tag ?? nameValue) === undefined ? {} : { name: truncate(tag ?? nameValue ?? "", 128) }),
      ...(source === "cdp" && typeof cdpCode === "number"
        ? { code: cdpCode }
        : code === undefined
          ? {}
          : { code }),
      ...(source === "cdp" && typeof cdpMessage === "string"
        ? { message: redactDiagnosticText(cdpMessage) }
        : message === undefined
          ? {}
          : { message }),
      ...(subCause === undefined ? {} : { subCause }),
      ...(source === "aws" && typeof metadata?.["httpStatusCode"] === "number"
        ? { fields: { ...fields, httpStatusCode: metadata["httpStatusCode"] } }
        : fields === undefined
          ? {}
          : { fields }),
    };
  } catch {
    return { source: "value" };
  }
};

const causeOf = (error: unknown): unknown => {
  try {
    if (Runtime.isFiberFailure(error)) return squash(error[Runtime.FiberFailureCauseId]);
    const value = object(error);
    return value?.["cause"];
  } catch {
    return undefined;
  }
};

/** The failure a fiber failure carries, else the value itself. Never throws. */
const unwrapFiberFailure = (error: unknown): unknown => {
  try {
    return Runtime.isFiberFailure(error) ? squash(error[Runtime.FiberFailureCauseId]) : error;
    // error-reporting-allow: typed-recovery a value that throws on inspection is described as it is
  } catch {
    return error;
  }
};

const squash = (cause: Cause.Cause<unknown>): unknown =>
  Option.getOrUndefined(Cause.failureOption(cause)) ??
  Option.getOrUndefined(Cause.dieOption(cause)) ??
  (Cause.isInterrupted(cause) ? { _tag: "Interrupted" } : undefined);

/** Underlying error, bounded cause chain and stack of any thrown or failed value. */
export const describeError = (
  error: unknown,
): Pick<FailureDetail, "underlying" | "causeChain" | "stack"> => {
  try {
    const root = unwrapFiberFailure(error);
    if (root === undefined) return {};
    const chain: UnderlyingError[] = [];
    const seen: unknown[] = [root];
    let next = causeOf(root);
    const stackCandidates: unknown[] = [root];
    while (next !== undefined && next !== null && chain.length < bounds.chainDepth) {
      if (seen.includes(next)) break;
      seen.push(next);
      // A fiber failure only carries its Cause, which follows it in the chain and is described
      // there; its own message would repeat Effect's rendering of that Cause.
      const unwrapped = unwrapFiberFailure(next);
      if (unwrapped !== next) {
        next = unwrapped;
        continue;
      }
      stackCandidates.push(next);
      const described = describeUnderlying(next);
      chain.push(
        described.message === undefined
          ? described
          : { ...described, message: truncate(described.message, bounds.chainMessage) },
      );
      next = causeOf(next);
    }
    // The outermost value with a stack locates the failure most precisely.
    const stackSource = stackCandidates
      .map((candidate) => object(candidate))
      .find((candidate) => typeof candidate?.["stack"] === "string");
    const sourceStack = stackSource?.["stack"];
    const sourceMessage = stackSource?.["message"];
    const stack = boundedStack(
      typeof sourceStack === "string" ? sourceStack : undefined,
      typeof sourceMessage === "string" ? sourceMessage : "",
    );
    return {
      underlying: describeUnderlying(root),
      ...(chain.length === 0 ? {} : { causeChain: chain }),
      ...(stack === undefined ? {} : { stack }),
    };
  } catch {
    return {};
  }
};

const boundedContext = (
  context: Readonly<Record<string, FailureContextValue | undefined>> | undefined,
) => {
  if (context === undefined) return undefined;
  const result: Record<string, FailureContextValue> = {};
  for (const [key, value] of Object.entries(context)) {
    if (Object.keys(result).length >= bounds.contextKeys) break;
    if (value === undefined || !fieldKey.test(key)) continue;
    if (typeof value === "string") result[key] = keyedText(key, value, bounds.contextValue);
    else if (typeof value === "number") {
      if (Number.isFinite(value)) result[key] = value;
    } else result[key] = value;
  }
  return Object.keys(result).length === 0 ? undefined : result;
};

const byteSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const nonUrlByteSize = (value: unknown) =>
  Buffer.byteLength(
    JSON.stringify(value, (_key, nested: unknown) =>
      typeof nested === "string" ? withoutUrls(nested) : nested,
    ),
    "utf8",
  );

/**
 * Enforces the serialized UTF-8 bound. Least specific evidence goes first: oldest commands,
 * then frames, nested causes, the largest context values, error fields and finally the
 * underlying message itself.
 */
const fitSize = (detail: FailureDetail): FailureDetail => {
  let current = detail;
  const over = () => nonUrlByteSize(current) > bounds.serialized;
  while (over() && current.cdpCommands !== undefined) {
    const { cdpCommands, ...rest } = current;
    current = cdpCommands.length > 1 ? { ...rest, cdpCommands: cdpCommands.slice(1) } : rest;
  }
  if (over() && current.stack !== undefined) {
    const { stack, ...rest } = current;
    void stack;
    current = rest;
  }
  if (over() && current.causeChain !== undefined) {
    const { causeChain, ...rest } = current;
    void causeChain;
    current = rest;
  }
  while (over() && current.context !== undefined) {
    const entries = Object.entries(current.context);
    const largest = entries
      .filter(([, value]) => typeof value !== "string" || diagnosticUrlSpans(value).length === 0)
      .reduce<[string, FailureContextValue] | undefined>(
        (best, entry) =>
          best === undefined || byteSize(entry[1]) > byteSize(best[1]) ? entry : best,
        undefined,
      );
    if (largest === undefined) break;
    const remaining = entries.filter(([key]) => key !== largest?.[0]);
    const { context, ...rest } = current;
    void context;
    current = remaining.length === 0 ? rest : { ...rest, context: Object.fromEntries(remaining) };
  }
  if (over() && current.underlying?.fields !== undefined) {
    const { fields, ...underlying } = current.underlying;
    void fields;
    current = { ...current, underlying };
  }
  if (over() && current.underlying?.message !== undefined) {
    const { message, ...underlying } = current.underlying;
    current = { ...current, underlying: { ...underlying, message: truncate(message, 256) } };
  }
  if (over() && current.underlying !== undefined) {
    const { underlying, ...rest } = current;
    void underlying;
    current = rest;
  }
  return current;
};

/** Adds context to an existing detail, re-applying redaction and every bound. */
export const withFailureContext = (
  detail: FailureDetail,
  context: Readonly<Record<string, FailureContextValue | undefined>>,
): FailureDetail => {
  const merged = boundedContext({ ...context, ...detail.context });
  return archiveOnly(fitSize(merged === undefined ? detail : { ...detail, context: merged }));
};

/**
 * A detail nested in a failure object is invisible to JSON serialization: RPC encoders,
 * public responses and `JSON.stringify(failure)` omit it. Only `failureDetailMetadata` and
 * `failureDetailOf` project it, into the archive and the maintenance evidence files, and
 * a host's HTTP relay, into a relayed HTTP failure's answer to the sandbox,
 * which the agent's execution result carries. The detail itself, serialized at the top level,
 * keeps every field.
 */
const archiveOnly = (detail: FailureDetail): FailureDetail =>
  Object.defineProperty(detail, "toJSON", {
    value(this: FailureDetail, key: string) {
      return key === "" ? { ...this } : undefined;
    },
    enumerable: false,
  });

/** Build a bounded detail. `error` contributes the underlying error, cause chain and stack. */
export const failureDetail = (
  subCause: FailureSubCause,
  options: {
    readonly operation?: string;
    readonly phase?: string;
    readonly elapsedMs?: number;
    readonly error?: unknown;
    readonly context?: Readonly<Record<string, FailureContextValue | undefined>>;
    readonly cdpCommands?: readonly CdpCommandRecord[];
    /** Frames of a shared failure-building helper to skip, so `site` names its caller. */
    readonly helperFrames?: number;
  } = {},
): FailureDetail => {
  const described = options.error === undefined ? {} : describeError(options.error);
  // A wrapped failure that already carried detail keeps its own evidence beneath this one, also
  // when it arrives as the fiber failure `Effect.runPromise` throws.
  const inner = failureDetailMetadata(unwrapFiberFailure(options.error))?.failureDetail;
  const siteFrames = boundedStack(new Error("failure site").stack, "failure site")?.slice(1);
  const site = siteFrames
    ?.filter((frame) => !frame.includes("runtime/failure-detail."))
    .at(options.helperFrames ?? 0);
  const stack = inner?.stack ?? described.stack ?? siteFrames;
  const causeChain = [
    ...(inner?.underlying === undefined ? [] : [inner.underlying]),
    ...(inner?.causeChain ?? []),
    ...(described.causeChain ?? []),
  ].slice(0, bounds.chainDepth);
  const context = boundedContext(
    inner?.context === undefined ? options.context : { ...inner.context, ...options.context },
  );
  const commands = (options.cdpCommands ?? inner?.cdpCommands)?.slice(-bounds.commands);
  const operation =
    options.operation !== undefined && /^[A-Za-z][A-Za-z0-9_.:/-]{0,95}$/.test(options.operation)
      ? options.operation
      : undefined;
  const phase =
    options.phase !== undefined && /^[A-Za-z][A-Za-z0-9_.:/-]{0,95}$/.test(options.phase)
      ? options.phase
      : undefined;
  return archiveOnly(
    fitSize({
      subCause,
      ...(operation === undefined ? {} : { operation }),
      ...(phase === undefined ? {} : { phase }),
      ...(options.elapsedMs !== undefined &&
      Number.isFinite(options.elapsedMs) &&
      options.elapsedMs >= 0
        ? { elapsedMs: Math.round(options.elapsedMs) }
        : {}),
      ...(described.underlying === undefined ? {} : { underlying: described.underlying }),
      ...(causeChain.length === 0 ? {} : { causeChain }),
      ...(stack === undefined || stack.length === 0 ? {} : { stack }),
      ...(context === undefined ? {} : { context }),
      ...(commands === undefined || commands.length === 0 ? {} : { cdpCommands: commands }),
      ...(site === undefined ? {} : { site }),
    }),
  );
};

/**
 * Archive projection. Re-validates the bounded shape so only a detail built here, never an
 * arbitrary property of a failure, reaches a diagnostic event.
 */
export const failureDetailMetadata = (
  value: unknown,
): { readonly failureDetail: FailureDetail } | undefined => {
  try {
    const detail = object(value)?.["failureDetail"];
    if (detail === undefined) return undefined;
    const decoded = Schema.decodeUnknownOption(FailureDetailSchema, {
      onExcessProperty: "ignore",
    })(detail);
    return decoded._tag === "Some" ? { failureDetail: fitSize(decoded.value) } : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Archive projection for any failure, including one built before it carried detail: its own
 * class, code, finite fields and construction stack stand in as `unclassified`.
 */
export const failureDetailOf = (
  value: unknown,
): { readonly failureDetail: FailureDetail } | undefined => {
  const carried = failureDetailMetadata(value);
  if (carried !== undefined) return carried;
  const failure = object(value);
  if (failure === undefined || typeof failure["_tag"] !== "string") return undefined;
  const described = describeError(value);
  return {
    failureDetail: fitSize({
      subCause: "unclassified",
      ...(described.underlying === undefined ? {} : { underlying: described.underlying }),
      ...(described.causeChain === undefined ? {} : { causeChain: described.causeChain }),
      ...(described.stack === undefined ? {} : { stack: described.stack }),
    }),
  };
};

const rootCauseName = /^[A-Za-z][A-Za-z0-9_.:/-]{0,95}$/;
const rootCauseToken = (value: unknown) =>
  typeof value === "string" && rootCauseName.test(value) ? value : undefined;
const rootCauseCode = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : rootCauseToken(value);

/**
 * A failure's root cause for the agent's tool result: its sub-cause, operation, the underlying
 * error's class and code, and each wrapped cause's, outermost first. Codes only, never messages,
 * so a tool result that is not screened by known values stays safe. The agent acts on the root
 * cause, never on a wrapper's generic code.
 */
export const failureRootCause = (value: unknown) => {
  const detail = failureDetailMetadata(value)?.failureDetail;
  if (detail === undefined) return undefined;
  const operation = rootCauseToken(detail.operation);
  const errorName = rootCauseToken(detail.underlying?.name);
  const errorCode = rootCauseCode(detail.underlying?.code);
  const causeChain = (detail.causeChain ?? []).flatMap((cause) => {
    const name = rootCauseToken(cause.name);
    const code = rootCauseCode(cause.code);
    return name === undefined && code === undefined && cause.subCause === undefined
      ? []
      : [
          {
            ...(name === undefined ? {} : { name }),
            ...(code === undefined ? {} : { code }),
            ...(cause.subCause === undefined ? {} : { subCause: cause.subCause }),
          },
        ];
  });
  return {
    subCause: detail.subCause,
    ...(operation === undefined ? {} : { operation }),
    ...(errorName === undefined ? {} : { errorName }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(causeChain.length === 0 ? {} : { causeChain }),
  };
};
