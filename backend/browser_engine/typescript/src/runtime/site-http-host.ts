import { Effect, ParseResult, Schema } from "effect";
import type { ExecutionServices } from "./context.js";
import { timeoutDefaults } from "./deadline.js";
import type { Dispatch } from "./errors.js";
import {
  HttpCapability,
  HttpFailure,
  maxSiteHttpResponseBytes,
  SiteHttpRequest,
} from "./site-http.js";
import type {
  HttpExchange,
  HttpRequestRefusal,
  HttpTransport,
  SiteHttpResponse,
  SiteHttpResult,
  SiteHttpService,
} from "./site-http.js";

const responseTooLarge = (status: number, limitBytes: number | undefined): HttpFailure =>
  limitBytes === undefined
    ? new HttpFailure({ code: "invalid_response", dispatch: "unknown" })
    : new HttpFailure({
        code: "response_too_large",
        dispatch: "sent",
        response: {
          status,
          body: { state: "unavailable", reason: "limit_exceeded", limitBytes },
        },
      });

/**
 * Whether a live host carries this request over the page's own fetch: the documented route for a
 * request that requires the page's environment or its service worker. A replay stays a replay.
 */
const pageRoute = (transport: HttpTransport, request: SiteHttpRequest) =>
  transport.name !== "saved-http" &&
  request.requires?.some(
    (capability) => capability === "page-environment" || capability === "service-worker",
  ) === true;

/** The transport a request starts on, which `http.request_started` names. */
const startingTransport = (transport: HttpTransport, request: SiteHttpRequest) =>
  pageRoute(transport, request) ? "page-fetch" : transport.name;

/** A limit alone bounds the response; the buffered contract alone selects the default limit. */
const responseLimit = (request: SiteHttpRequest): number | undefined =>
  request.maxResponseBytes ??
  (request.requires?.includes("buffered-response-v1") === true
    ? maxSiteHttpResponseBytes
    : undefined);

const methods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const capabilities = new Set<unknown>(HttpCapability.literals);
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const absoluteUrl = (value: unknown): URL | undefined => {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
};

const safeIdentifier = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;

/** An invalid header name described without quoting it: it may be a pasted header line. */
const describeInvalidHeaderName = (name: string): string => {
  const at = [...name].findIndex((char) => !headerName.test(char));
  return `a header name of ${name.length} characters whose character ${at + 1} is not allowed in a name`;
};

/**
 * The first request-check rule the request breaks, checked in the order the fields are written,
 * or undefined. The transport's capabilities are checked after the request decodes.
 */
const requestRefusal = (input: unknown): HttpRequestRefusal | undefined => {
  if (typeof input !== "object" || input === null) return { rule: "request_invalid" };
  const request = input as Readonly<Record<string, unknown>>;
  const url = absoluteUrl(request.url);
  if (url === undefined) return { rule: "url_not_absolute" };
  if (url.username !== "" || url.password !== "") return { rule: "url_has_credentials" };
  if (url.hash !== "") return { rule: "url_has_fragment" };
  if (typeof request.method !== "string" || !methods.has(request.method))
    return { rule: "method_unsupported" };
  if ((request.method === "GET" || request.method === "HEAD") && request.body !== undefined)
    return { rule: "body_on_get_or_head" };
  const headers = request.headers;
  if (headers !== undefined) {
    if (typeof headers !== "object" || headers === null || Array.isArray(headers))
      return { rule: "request_invalid", detail: "headers is not an object of strings" };
    for (const [name, value] of Object.entries(headers)) {
      if (!headerName.test(name))
        return { rule: "header_name_invalid", detail: describeInvalidHeaderName(name) };
      if (typeof value !== "string") return { rule: "header_value_not_text", header: name };
      if (/[\r\n]/.test(value)) return { rule: "header_value_newline", header: name };
    }
  }
  const timeoutMs = request.timeoutMs;
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
  )
    return { rule: "timeout_invalid" };
  const limit = request.maxResponseBytes;
  if (
    limit !== undefined &&
    (typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > maxSiteHttpResponseBytes)
  )
    return { rule: "max_response_bytes_out_of_range" };
  const requires = request.requires;
  if (requires !== undefined) {
    if (!Array.isArray(requires))
      return { rule: "request_invalid", detail: "requires is not a list of capabilities" };
    const unknown: unknown = requires.find((capability) => !capabilities.has(capability));
    if (unknown !== undefined) {
      return typeof unknown === "string" && safeIdentifier.test(unknown)
        ? { rule: "capability_unsupported", capability: unknown }
        : { rule: "capability_unsupported", detail: "a capability that is not a plain identifier" };
    }
  }
  return undefined;
};

/** The refused request's method and URL, without the URL's user:password, query or fragment. */
const refusedRequest = (input: unknown) => {
  if (typeof input !== "object" || input === null) return {};
  const method: unknown = Reflect.get(input, "method");
  const raw: unknown = Reflect.get(input, "url");
  if (typeof method !== "string" || typeof raw !== "string") return {};
  const url = absoluteUrl(raw);
  if (url !== undefined) {
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
  }
  const shown = url?.href ?? (raw.includes("@") ? "" : (raw.split(/[?#]/, 1)[0] ?? ""));
  return shown === ""
    ? {}
    : { request: { method: method.slice(0, 16), url: shown.slice(0, 2048) } };
};

/** A request the request check refused: nothing was sent. */
const refused = (input: unknown, refusal: HttpRequestRefusal) =>
  new HttpFailure({
    code: refusal.rule === "capability_unsupported" ? "unsupported_capability" : "invalid_request",
    dispatch: "not_sent",
    refusal,
    ...refusedRequest(input),
  });

/** A path on the site itself, such as `/api/cart?id=1`; never a scheme-relative `//host`. */
const isSitePath = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//");

/**
 * Resolves a site-relative request URL against the site origin. Without an origin, a relative URL
 * stays invalid and fails before dispatch.
 */
const withSiteOrigin = (input: unknown, siteOrigin: string | undefined): unknown => {
  if (siteOrigin === undefined || typeof input !== "object" || input === null || !("url" in input))
    return input;
  const url: unknown = input.url;
  return isSitePath(url) ? { ...input, url: new URL(url, `${siteOrigin}/`).href } : input;
};

/**
 * Builds the job's `SiteHttp` over a host's transport. Each request is checked against the
 * request rules and the transport's capabilities before anything is sent, and a refusal names
 * the rule it broke; bounded by the execution's
 * deadline, captured, announced as `http.request_started` and `http.response_received` events,
 * and marked in the effect journal as possibly dispatched just before it is sent.
 */
export const makeSiteHttp = (options: {
  readonly transport: HttpTransport;
  readonly context: ExecutionServices;
  // Private exchange values must be screened before this callback persists or publishes them.
  readonly capture: (exchange: HttpExchange) => Effect.Effect<void, HttpFailure>;
  /** The site a relative request URL means; absent, only absolute URLs are accepted. */
  readonly siteOrigin?: string;
  /**
   * The host's test for a bot-protection challenge page in place of the site's answer. A result
   * it finds carries `challenge: true`, which `isBotChallenge`, `requestPastChallenge`, `readText`
   * and `readJson` act on. Without it, no answer is a challenge.
   */
  readonly isChallenge?: (response: SiteHttpResponse) => boolean;
}): SiteHttpService => ({
  capabilities: options.transport.capabilities,
  siteOrigin: options.siteOrigin,
  request: (raw) =>
    Effect.gen(function* () {
      const input = withSiteOrigin(raw, options.siteOrigin);
      const refusal = requestRefusal(input);
      if (refusal !== undefined) return yield* refused(input, refusal);
      const request = yield* Schema.decodeUnknown(SiteHttpRequest)(input).pipe(
        Effect.mapError((error) =>
          refused(input, {
            rule: "request_invalid",
            // Field paths only: a decoding message would quote the value, which may be private.
            detail: `fields ${[
              ...new Set(
                ParseResult.ArrayFormatter.formatErrorSync(error).map(
                  (issue) => issue.path.join(".") || "(request)",
                ),
              ),
            ]
              .join(", ")
              .slice(0, 512)}`,
          }),
        ),
      );
      const missing = request.requires?.find(
        (capability) => !options.transport.capabilities.includes(capability),
      );
      if (missing !== undefined)
        return yield* refused(input, {
          rule: "capability_unsupported",
          capability: missing,
          transport: options.transport.name,
        });
      const deadline = options.context.deadline.child(request.timeoutMs ?? timeoutDefaults.http);
      const maxResponseBytes = responseLimit(request);
      const capture = (exchange: HttpExchange, dispatch: Dispatch) =>
        options
          .capture(exchange)
          .pipe(Effect.mapError(() => new HttpFailure({ code: "capture_failed", dispatch })));
      yield* capture({ phase: "request", request }, "not_sent");
      yield* options.context.events
        .emit("http.request_started", {
          transport: startingTransport(options.transport, request),
          method: request.method,
          reason: pageRoute(options.transport, request)
            ? "page_environment_required"
            : "configured_compatible_transport",
        })
        .pipe(
          Effect.mapError(() => new HttpFailure({ code: "capture_failed", dispatch: "not_sent" })),
        );
      if (deadline.remainingMs() <= 0)
        return yield* new HttpFailure({ code: "deadline_exceeded", dispatch: "not_sent" });
      yield* options.context.journal.enteringDispatch;
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          options.transport.send(request, {
            signal,
            timeoutMs: Math.max(1, deadline.remainingMs()),
            ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
          }),
        catch: (error) =>
          error instanceof HttpFailure
            ? error
            : new HttpFailure({ code: "transport_failed", dispatch: "unknown" }),
      }).pipe(
        Effect.filterOrFail(
          (value) => maxResponseBytes === undefined || value.body.byteLength <= maxResponseBytes,
          (value) => responseTooLarge(value.status, maxResponseBytes),
        ),
        Effect.timeoutFail({
          duration: deadline.remainingMs(),
          onTimeout: () => new HttpFailure({ code: "deadline_exceeded", dispatch: "unknown" }),
        }),
        Effect.tapError((failure) =>
          capture({ phase: "failure", request, failure }, failure.dispatch),
        ),
      );
      yield* capture({ phase: "response", request, response }, "sent");
      yield* options.context.events
        .emit("http.response_received", {
          transport: response.transport,
          status: response.status,
          bytes: response.body.byteLength,
        })
        .pipe(Effect.mapError(() => new HttpFailure({ code: "capture_failed", dispatch: "sent" })));
      const result: SiteHttpResult = { ...response, requestUrl: request.url };
      return options.isChallenge?.(response) === true ? { ...result, challenge: true } : result;
    }),
});
