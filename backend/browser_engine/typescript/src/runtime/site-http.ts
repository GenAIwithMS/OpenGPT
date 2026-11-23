import { Context, Data, Schema } from "effect";
import type { Effect } from "effect";
import type { Dispatch } from "./errors.js";
import type { FailureDetail } from "./failure-detail.js";

/**
 * The contract of an HTTP version: an operation whose only network capability is `SiteHttp`, the
 * site's HTTP as the host carries it. The host chooses the transport; the authored code chooses
 * the request. `makeSiteHttp` from `opengpt-browser-engine/core/runtime/site-http-host` builds the service over
 * a host's `HttpTransport`.
 */

export const HttpCapability = Schema.Literal(
  "chromium-network",
  "session-cookies",
  "assigned-proxy",
  "page-environment",
  "service-worker",
  "streaming",
  "buffered-response-v1",
);
export type HttpCapability = typeof HttpCapability.Type;

/** The largest response body `SiteHttp` buffers, and the default limit of a bounded request. */
export const maxSiteHttpResponseBytes = 8 * 1024 * 1024;

export const HttpResponseGap = Schema.Literal(
  "javascript_visible_headers_only",
  "redirect_chain_unavailable",
  "final_url_unavailable",
  "recorded_replay",
);
export type HttpResponseGap = typeof HttpResponseGap.Type;

export const SiteHttpRequest = Schema.Struct({
  url: Schema.String.pipe(
    Schema.filter((value) => {
      try {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash
        );
      } catch {
        return false;
      }
    }),
  ),
  method: Schema.Literal("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"),
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  // Text request bodies only. Binary responses remain bytes.
  body: Schema.optional(Schema.String),
  requires: Schema.optional(Schema.Array(HttpCapability)),
  timeoutMs: Schema.optional(Schema.Number.pipe(Schema.finite(), Schema.positive())),
  // A limit alone bounds the response; `buffered-response-v1` without one selects the default.
  maxResponseBytes: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.between(1, maxSiteHttpResponseBytes)),
  ),
});
export type SiteHttpRequest = typeof SiteHttpRequest.Type;

export const HttpFailureCode = Schema.Literal(
  "invalid_request",
  "unsupported_capability",
  "transport_failed",
  "invalid_response",
  "response_too_large",
  "capture_failed",
  "deadline_exceeded",
  // No longer produced: a relay refused a credential bound for another site. Kept so an older
  // host's answer decodes.
  "egress_denied",
  // Offline replay found no unconsumed recorded exchange for the request.
  "not_recorded",
);
export type HttpFailureCode = typeof HttpFailureCode.Type;

/**
 * The request check's rules. A request that breaks one fails before anything is sent, naming the
 * rule, so the code can be fixed and run again.
 */
export const HttpRequestRule = Schema.Literal(
  "request_invalid",
  "url_not_absolute",
  "url_has_credentials",
  "url_has_fragment",
  "method_unsupported",
  "body_on_get_or_head",
  "header_name_invalid",
  "header_value_not_text",
  "header_value_newline",
  "timeout_invalid",
  "max_response_bytes_out_of_range",
  "capability_unsupported",
);
export type HttpRequestRule = typeof HttpRequestRule.Type;

/** Which request-check rule refused a request, and the header or capability it was about. */
export interface HttpRequestRefusal {
  readonly rule: HttpRequestRule;
  readonly header?: string;
  readonly capability?: string;
  /** The transport that lacks `capability`. */
  readonly transport?: string;
  /** For `request_invalid`: what did not decode. */
  readonly detail?: string;
}

/** How to fix a request each rule refused, in one sentence. */
const refusalFixes: Record<HttpRequestRule, string> = {
  request_invalid:
    "send { url, method, headers?, body?, requires?, timeoutMs?, maxResponseBytes? } with text values",
  url_not_absolute: "use an absolute http(s) URL, or a site path that starts with one / when the host knows the site's origin",
  url_has_credentials: "leave user:password out of the URL",
  url_has_fragment: "leave the #fragment out of the URL",
  method_unsupported: "use GET, HEAD, POST, PUT, PATCH, DELETE or OPTIONS, in capitals",
  body_on_get_or_head: "leave body out of a GET or HEAD request, even an empty one",
  header_name_invalid:
    "send only plain header names; leave out HTTP/2 pseudo-headers such as :authority",
  header_value_not_text: "send each header value as a string",
  header_value_newline: "remove line breaks from the header value",
  timeout_invalid: "give timeoutMs as a positive number of milliseconds, or leave it out",
  max_response_bytes_out_of_range: `give maxResponseBytes as a whole number from 1 to ${maxSiteHttpResponseBytes}, or leave it out for that default`,
  capability_unsupported: "leave out the capability this host's transport lacks",
};

const refusalLine = (refusal: HttpRequestRefusal) =>
  [
    `refused by the request check, nothing was sent: ${refusal.rule}`,
    refusal.header === undefined ? "" : `(header ${JSON.stringify(refusal.header)})`,
    refusal.capability === undefined
      ? ""
      : `(capability ${JSON.stringify(refusal.capability)}${refusal.transport === undefined ? "" : ` on ${refusal.transport}`})`,
    refusal.detail === undefined ? "" : `(${refusal.detail})`,
    `(fix: ${refusalFixes[refusal.rule]})`,
  ]
    .filter((part) => part !== "")
    .join(" ");

export interface HttpFailureFields {
  readonly code: HttpFailureCode;
  readonly dispatch: Dispatch;
  /** The request check's refusal, for a request refused before anything was sent. */
  readonly refusal?: HttpRequestRefusal;
  readonly response?: {
    readonly status: number;
    readonly body: {
      readonly state: "unavailable";
      readonly reason: "limit_exceeded";
      readonly limitBytes: number;
    };
  };
  /** Host: the transport's own error, screened. A relay sends it on as `relay.detail`. */
  readonly failureDetail?: FailureDetail;
  /** The request that failed, as the code sent it. Its headers and body stay out. */
  readonly request?: { readonly method: string; readonly url: string };
  /** A host relay's own record of the failure, when the request went through one. */
  readonly relay?: RelayedFailure;
}

/**
 * What a host relay reports about a request it could not complete: the transport that failed,
 * after how long, the host's screened failure detail (sub-cause, operation, underlying error,
 * cause chain and stack), and the earlier attempt the page's fetch replaced, if any. Each is
 * optional so authored code and the host decode each other's answer across a release skew.
 */
export interface RelayedFailure {
  readonly transport?: string;
  readonly durationMs?: number;
  readonly detail?: unknown;
  readonly curlFailure?: unknown;
}

const field = (value: unknown, key: string): unknown => {
  if (typeof value !== "object" || value === null) return undefined;
  const found: unknown = Reflect.get(value, key);
  return found;
};

/** A failure detail's sub-cause, operation and underlying message, in one line. */
const detailLine = (detail: unknown) =>
  [
    field(detail, "subCause"),
    field(detail, "operation"),
    field(field(detail, "underlying"), "message"),
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(": ");

/** The earlier attempt a page fetch replaced: its code and cause. */
const curlLine = (curl: unknown) =>
  [field(curl, "code"), detailLine(field(curl, "detail"))]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(", ");

/** The relay's part: transport, duration, cause and the replaced attempt. */
const relayParts = (relay: RelayedFailure | undefined, hostDetail: FailureDetail | undefined) => {
  const detail = detailLine(relay?.detail ?? hostDetail);
  const curl = curlLine(relay?.curlFailure);
  return [
    relay?.transport === undefined ? "" : `over ${relay.transport}`,
    relay?.durationMs === undefined ? "" : `after ${Math.round(relay.durationMs)} ms`,
    detail === "" ? "" : `cause ${detail}`,
    curl === "" ? "" : `after curl failed (${curl})`,
  ];
};

/** The failure's code, dispatch, request, transport, timing and cause, for stderr and results. */
const describeHttpFailure = (fields: HttpFailureFields) =>
  [
    `${fields.code} (dispatch ${fields.dispatch})`,
    fields.refusal === undefined ? "" : refusalLine(fields.refusal),
    fields.request === undefined ? "" : `${fields.request.method} ${fields.request.url}`,
    fields.response === undefined ? "" : `answered ${fields.response.status}`,
    ...relayParts(fields.relay, fields.failureDetail),
  ]
    .filter((part) => part !== "")
    .join(" ")
    .slice(0, 4096);

/** A request `SiteHttp` could not complete, with whether it may have reached the site. */
export class HttpFailure extends Data.TaggedError("HttpFailure")<HttpFailureFields> {
  constructor(fields: HttpFailureFields) {
    super(fields);
    this.message = describeHttpFailure(fields);
  }
}

/** `saved-http` replays recorded exchanges offline; it never reaches a website. */
export type HttpTransportName = "kernel-curl" | "page-fetch" | "saved-http";

/** What a transport answers. `SiteHttp` adds the absolute URL it requested. */
export interface SiteHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, readonly string[]>>;
  readonly body: Uint8Array;
  readonly transport: HttpTransportName;
  /** Only the page's fetch knows where redirects ended; other transports report a gap. */
  readonly finalUrl?: string;
  readonly gaps: readonly HttpResponseGap[];
}

/**
 * A `SiteHttp` answer: the transport's response and `requestUrl`, the absolute URL that was
 * requested after a site-relative one was resolved, so code can build follow-up URLs from it.
 */
export interface SiteHttpResult extends SiteHttpResponse {
  readonly requestUrl: string;
  /**
   * The host found a bot-protection challenge page here in place of the site's answer. Absent
   * when the host has no challenge test, or found none.
   */
  readonly challenge?: true;
}

/** One way a host carries the site's HTTP, such as a browser's own network stack. */
export interface HttpTransport {
  readonly name: HttpTransportName;
  readonly capabilities: readonly HttpCapability[];
  readonly send: (
    request: SiteHttpRequest,
    options: {
      readonly signal: AbortSignal;
      readonly timeoutMs: number;
      readonly maxResponseBytes?: number;
    },
  ) => Promise<SiteHttpResponse>;
}

/** What `SiteHttp` hands the host's capture hook, before and after each request. */
export type HttpExchange =
  | { readonly phase: "request"; readonly request: SiteHttpRequest }
  | {
      readonly phase: "response";
      readonly request: SiteHttpRequest;
      readonly response: SiteHttpResponse;
    }
  | { readonly phase: "failure"; readonly request: SiteHttpRequest; readonly failure: HttpFailure };

export interface SiteHttpService {
  readonly capabilities: readonly HttpCapability[];
  /**
   * The job's site origin, such as `https://www.example.com`, the origin a site-relative URL
   * resolves against. Absent only where the host has no site, such as a fixture without a URL.
   */
  readonly siteOrigin: string | undefined;
  readonly request: (request: SiteHttpRequest) => Effect.Effect<SiteHttpResult, HttpFailure>;
}

/** The job's site HTTP. Its key stays fixed, so tools built against any release find it. */
export class SiteHttp extends Context.Tag("opengpt-browser-engine/SiteHttp")<SiteHttp, SiteHttpService>() {}
