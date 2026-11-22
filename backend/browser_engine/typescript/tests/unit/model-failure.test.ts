import { APIConnectionError, APIError } from "openai";
import { Cause, Effect, Runtime } from "effect";
import { describe, expect, it } from "vitest";
import { modelCauseMetadata, modelFailureMetadata } from "../../src/models/model-failure.js";

/** The provider's error for `status`, as the SDK builds it from a response with a request id. */
const providerError = (status: number, error: Readonly<Record<string, unknown>>) =>
  APIError.generate(status, { error }, undefined, new Headers({ "x-request-id": "req_synthetic" }));
const socketClosed = () =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
  });
/** An error `depth` causes above one that carries a code. */
const nested = (depth: number): unknown => {
  let cause: unknown = Object.assign(new Error("innermost"), { code: "INNER_CODE" });
  for (let level = 0; level < depth; level++)
    cause = Object.assign(new Error(`level ${level}`), { cause });
  return Object.assign(new Error("outer"), { cause });
};

describe("modelFailureMetadata", () => {
  it("names an SDK error by its class, with its request id, status, code and message", () => {
    expect(
      modelFailureMetadata(
        providerError(429, {
          message: "Rate limit reached for requests per min.",
          type: "requests",
          code: "rate_limit_exceeded",
          param: null,
        }),
      ),
    ).toStrictEqual({
      kind: "RateLimitError",
      code: "rate_limit_exceeded",
      message: "429 Rate limit reached for requests per min.",
      providerCode: "rate_limit_exceeded",
      requestId: "req_synthetic",
      httpStatus: 429,
    });
  });

  it("reads the code a nested cause carries, such as a closed socket's", () => {
    expect(modelFailureMetadata(new APIConnectionError({ cause: socketClosed() }))).toStrictEqual({
      kind: "APIConnectionError",
      message: "Connection error.",
      causeCode: "UND_ERR_SOCKET",
    });
    expect(modelFailureMetadata(nested(3))).toMatchObject({ causeCode: "INNER_CODE" });
    // Eight causes deep at most, and a cycle ends the search.
    expect(modelFailureMetadata(nested(8))).not.toHaveProperty("causeCode");
    const one: { message: string; cause?: unknown } = { message: "one" };
    one.cause = { message: "two", cause: one };
    expect(modelFailureMetadata(Object.assign(new Error("cyclic"), { cause: one }))).toStrictEqual({
      kind: "Error",
      message: "cyclic",
    });
  });

  it("keeps whether a failed call is unsafe to replay and whether its response started", () => {
    const error = new APIConnectionError({ message: "Connection closed.", cause: socketClosed() });
    Object.defineProperties(error, {
      unsafeToReplay: { value: true },
      responseStarted: { value: false },
    });
    expect(modelFailureMetadata(error)).toStrictEqual({
      kind: "APIConnectionError",
      message: "Connection closed.",
      causeCode: "UND_ERR_SOCKET",
      unsafeToReplay: true,
      responseStarted: false,
    });
  });

  it("redacts a credential in the message and keeps the provider codes a host reads", () => {
    const rejected = modelFailureMetadata(
      providerError(401, {
        message: "Incorrect API key provided: sk_live_FAKEabcdefghijkl",
        type: "invalid_request_error",
        code: "invalid_api_key",
        param: null,
      }),
    );
    expect(rejected).toMatchObject({
      kind: "AuthenticationError",
      code: "invalid_api_key",
      providerCode: "invalid_api_key",
      httpStatus: 401,
    });
    expect(rejected.message).toMatch(/^401 Incorrect API key provided: /u);
    expect(rejected.message).not.toContain("FAKEabcdefghijkl");
    expect(
      modelFailureMetadata(
        providerError(429, {
          message: "Quota.",
          type: "insufficient_quota",
          code: "insufficient_quota",
        }),
      ),
    ).toMatchObject({ code: "insufficient_quota", providerCode: "insufficient_quota" });
    // A code without an HTTP status is no provider code.
    expect(
      modelFailureMetadata(Object.assign(new Error("Spent quota"), { code: "insufficient_quota" })),
    ).toStrictEqual({ kind: "Error", code: "insufficient_quota", message: "Spent quota" });
  });

  it("reads a string error as kind string with its text as the message", () => {
    expect(modelFailureMetadata("socket hang up")).toStrictEqual({
      kind: "string",
      message: "socket hang up",
    });
    expect(modelFailureMetadata(null)).toStrictEqual({ kind: "unclassified" });
  });

  it("classifies an error that throws when it is read", () => {
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error("unreadable");
        },
        has: () => {
          throw new Error("unreadable");
        },
        getPrototypeOf: () => {
          throw new Error("unreadable");
        },
      },
    );
    expect(modelFailureMetadata(hostile)).toStrictEqual({ kind: "unclassified" });
  });

  it("reads a fiber failure through its cause", () => {
    const thrown = (() => {
      try {
        Effect.runSync(Effect.fail(providerError(500, { message: "Server error." })));
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(Runtime.isFiberFailure(thrown)).toBe(true);
    expect(modelFailureMetadata(thrown)).toStrictEqual({
      kind: "InternalServerError",
      message: "500 Server error.",
      requestId: "req_synthetic",
      httpStatus: 500,
      interrupted: false,
    });
    expect(modelCauseMetadata(Cause.die("socket hang up"))).toStrictEqual({
      kind: "string",
      message: "socket hang up",
      interrupted: false,
    });
  });
});
