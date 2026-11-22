import { Effect, ParseResult, Schema } from "effect";
import { defineOperation } from "./operation.js";
import type { Operation, WriteDeclaration } from "./operation.js";
import { OperationFailure } from "./operation-failure.js";
import type { HttpAnswerFailure } from "./operation-failure.js";
import type { ScriptQuestionDeclarations } from "./script-input.js";
import { SiteHttp } from "./site-http.js";
import type { HttpFailure, SiteHttpRequest, SiteHttpResult, SiteHttpService } from "./site-http.js";

/**
 * An HTTP version: `run` gets the decoded input and the job's `SiteHttp`, and returns an Effect.
 * It is `defineOperation`'s object form with `SiteHttp` already taken, so an HTTP version is never
 * written as a Kernel script (`defineOperation(contract, async fn)`), which has no `SiteHttp`.
 */
export const defineHttpOperation = <
  Input,
  EncodedInput,
  Output,
  EncodedOutput,
  Error,
  Services,
>(operation: {
  readonly name: string;
  readonly input: Schema.Schema<Input, EncodedInput>;
  readonly output: Schema.Schema<Output, EncodedOutput>;
  readonly write?: WriteDeclaration;
  readonly questions?: ScriptQuestionDeclarations;
  readonly run: (input: Input, http: SiteHttpService) => Effect.Effect<Output, Error, Services>;
}): Operation<Input, EncodedInput, Output, EncodedOutput, Error, Services | SiteHttp> =>
  defineOperation({
    ...operation,
    run: (input: Input) => Effect.flatMap(SiteHttp, (http) => operation.run(input, http)),
  });

/** Methods a read may send again: they change nothing on the site. */
export const safeMethods = new Set<SiteHttpRequest["method"]>(["GET", "HEAD", "OPTIONS"]);
const snippetLength = 300;

const headerOf = (response: Pick<SiteHttpResult, "headers">, name: string) =>
  Object.entries(response.headers)
    .find(([key]) => key.toLowerCase() === name)?.[1]
    .join(", ") ?? "";

const textOf = (body: Uint8Array) => new TextDecoder().decode(body);

/**
 * Whether the host found a bot-protection challenge page in this answer, in place of the site's
 * answer. The host decides, from its own knowledge of challenge pages; a host without that
 * knowledge finds none. A site's own error page is its answer.
 */
export const isBotChallenge = (response: Pick<SiteHttpResult, "challenge">): boolean =>
  response.challenge === true;

/**
 * Sends one request. When the host found a bot challenge page in the answer to a safe read, sends
 * it once more through the page's own fetch (`requires: ["page-environment"]`), which runs in the
 * site's page with the cookies the browser earned there. Returns whichever answer came last;
 * check it with `isBotChallenge` if it matters.
 */
export const requestPastChallenge = (
  http: SiteHttpService,
  request: SiteHttpRequest,
): Effect.Effect<SiteHttpResult, HttpFailure> =>
  Effect.gen(function* () {
    const first = yield* http.request(request);
    // A replay moves on to the page's answer the live test recorded after the challenge.
    if (
      first.transport === "page-fetch" ||
      !safeMethods.has(request.method) ||
      request.requires?.includes("page-environment") === true ||
      !isBotChallenge(first)
    )
      return first;
    return yield* http.request({
      ...request,
      requires: [...(request.requires ?? []), "page-environment"],
    });
  });

/** One line that says what came back, for an error the agent can act on. */
export const described = (request: SiteHttpRequest, response: SiteHttpResult) => {
  const snippet = textOf(response.body.subarray(0, snippetLength * 4))
    .replace(/\s+/g, " ")
    .slice(0, snippetLength);
  return `${request.method} ${response.requestUrl} answered ${response.status} ${
    headerOf(response, "content-type") || "(no content type)"
  } over ${response.transport}, ${response.body.byteLength} bytes: ${snippet}`;
};

/** The answer's facts, for the agent's result: the site answered, and how. */
export const answer = (
  kind: HttpAnswerFailure["class"],
  request: SiteHttpRequest,
  response: SiteHttpResult,
): HttpAnswerFailure => ({
  class: kind,
  request: { method: request.method, url: response.requestUrl },
  status: response.status,
  contentType: headerOf(response, "content-type"),
  transport: response.transport,
  bytes: response.body.byteLength,
});

export const unexpected = (message: string, http: HttpAnswerFailure, cause?: unknown) =>
  new OperationFailure(message, {
    dispatch: "sent",
    http,
    ...(cause === undefined ? {} : { cause }),
  });

/**
 * A text answer from the site: `requestPastChallenge`, then a 2xx status and no challenge page
 * required. It succeeds with `{ text, response }`, so destructure it:
 * `const { text } = yield* readText(http, request)`. Anything else fails with an
 * `OperationFailure` that says what came back.
 */
export const readText = (
  http: SiteHttpService,
  request: SiteHttpRequest,
): Effect.Effect<
  { readonly text: string; readonly response: SiteHttpResult },
  HttpFailure | OperationFailure
> =>
  Effect.gen(function* () {
    const response = yield* requestPastChallenge(http, request);
    if (isBotChallenge(response))
      return yield* Effect.fail(
        unexpected(
          `A bot challenge page came back instead of the site's answer${response.transport === "page-fetch" ? ", even over the page's fetch" : ""}. ${described(request, response)}`,
          answer("destination_status", request, response),
        ),
      );
    if (response.status < 200 || response.status > 299)
      return yield* Effect.fail(
        unexpected(described(request, response), answer("destination_status", request, response)),
      );
    return { text: textOf(response.body), response };
  });

/**
 * A JSON answer decoded with `schema`: `readText` with `Accept: application/json` unless the
 * request sets its own, then JSON parsing and schema decoding. Each failure names the URL, status,
 * content type and transport, and what did not parse or decode.
 */
export const readJson = <A, I, R>(
  http: SiteHttpService,
  request: SiteHttpRequest,
  schema: Schema.Schema<A, I, R>,
): Effect.Effect<A, HttpFailure | OperationFailure, R> =>
  Effect.gen(function* () {
    const accepts = Object.keys(request.headers ?? {}).some(
      (name) => name.toLowerCase() === "accept",
    );
    const { text, response } = yield* readText(
      http,
      accepts
        ? request
        : { ...request, headers: { ...request.headers, accept: "application/json" } },
    );
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: (cause) =>
        unexpected(
          `The answer is not JSON. ${described(request, response)}`,
          answer("parsing", request, response),
          cause,
        ),
    });
    return yield* Schema.decodeUnknown(schema)(parsed).pipe(
      Effect.mapError((error) =>
        unexpected(
          `${request.method} ${response.requestUrl} answered JSON that does not match the schema: ${ParseResult.TreeFormatter.formatErrorSync(error)}`,
          answer("parsing", request, response),
          error,
        ),
      ),
    );
  });
