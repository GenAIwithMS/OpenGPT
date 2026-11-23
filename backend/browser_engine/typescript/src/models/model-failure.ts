import { Cause, Option, Runtime } from "effect";
import { redactDiagnosticText } from "../runtime/failure-detail.js";

export interface ModelFailureMetadata {
  readonly kind: string;
  readonly code?: string;
  /** The error's message, after the structural credential redaction. */
  readonly message?: string;
  readonly httpStatus?: number;
  readonly causeCode?: string;
  /** A provider response's own code, beside its HTTP status. */
  readonly providerCode?: string;
  readonly requestId?: string;
  /** The SDK's mark that the failed call is unsafe to send again. */
  readonly unsafeToReplay?: boolean;
  /** The SDK's mark that the provider's response had started before the call failed. */
  readonly responseStarted?: boolean;
  readonly interrupted?: boolean;
}

const safeField = (value: unknown, key: string): unknown => {
  try {
    return value !== null && (typeof value === "object" || typeof value === "function")
      ? Reflect.get(value, key)
      : undefined;
    // error-reporting-allow: parse-predicate a field whose getter throws is absent from the finite metadata
  } catch {
    return undefined;
  }
};
/** Longest name, code or request id kept; a message keeps `failureDetail`'s own bound. */
const maxToken = 256;
const text = (value: unknown, max = maxToken) =>
  typeof value === "string" && value !== "" ? redactDiagnosticText(value, max) : undefined;
/** The first code a nested cause carries, such as a socket's `UND_ERR_SOCKET`. */
const nestedCauseCode = (error: unknown): string | undefined => {
  const seen = new Set<object>();
  let nested = safeField(error, "cause");
  for (let depth = 0; depth < 8 && nested !== null && typeof nested === "object"; depth++) {
    if (seen.has(nested)) break;
    seen.add(nested);
    const code = text(safeField(nested, "code"));
    if (code !== undefined) return code;
    nested = safeField(nested, "cause");
  }
  return undefined;
};

/**
 * A model call's failure as a small diagnostic record: its class, code, provider fields and
 * message, as it reported them. An SDK error names its class, such as RateLimitError; a nested
 * cause gives its first code; text passes only the structural credential redaction.
 */
export const modelFailureMetadata = (error: unknown): ModelFailureMetadata => {
  try {
    if (Runtime.isFiberFailure(error))
      return modelCauseMetadata(error[Runtime.FiberFailureCauseId]);
    const object = typeof error === "object" && error !== null ? error : {};
    const tag = text(safeField(object, "_tag"));
    const rawName = text(safeField(object, "name"));
    const rawStatus = safeField(object, "status");
    const constructor = error instanceof Error ? safeField(object, "constructor") : undefined;
    const constructorName =
      typeof constructor === "function" ? text(safeField(constructor, "name")) : undefined;
    // An SDK error names itself `Error`; its constructor carries the class, such as RateLimitError.
    const kind =
      tag ??
      (rawName !== undefined && rawName !== "Error" ? rawName : undefined) ??
      constructorName ??
      rawName ??
      (typeof error === "string" ? "string" : "unclassified");
    const code = text(safeField(object, "code"));
    const message = text(
      typeof error === "string" ? error : safeField(object, "message"),
      16 * 1024,
    );
    const causeCode = nestedCauseCode(object);
    const requestId = text(safeField(object, "requestID") ?? safeField(object, "request_id"));
    const unsafeToReplay = safeField(object, "unsafeToReplay");
    const responseStarted = safeField(object, "responseStarted");
    const httpStatus =
      typeof rawStatus === "number" && Number.isSafeInteger(rawStatus) ? rawStatus : undefined;
    return {
      kind,
      ...(code === undefined ? {} : { code }),
      ...(message === undefined ? {} : { message }),
      // A provider response's own code, beside its HTTP status.
      ...(code === undefined || httpStatus === undefined ? {} : { providerCode: code }),
      ...(causeCode === undefined ? {} : { causeCode }),
      ...(requestId === undefined ? {} : { requestId }),
      ...(httpStatus === undefined ? {} : { httpStatus }),
      ...(typeof unsafeToReplay === "boolean" ? { unsafeToReplay } : {}),
      ...(typeof responseStarted === "boolean" ? { responseStarted } : {}),
    };
    // error-reporting-allow: typed-recovery an error whose fields throw on read is classified as unclassified, which callers record
  } catch {
    return { kind: "unclassified" };
  }
};
export const modelCauseMetadata = (cause: Cause.Cause<unknown>): ModelFailureMetadata => {
  const failure = Cause.failureOption(cause);
  const defect = Cause.dieOption(cause);
  return {
    ...(Option.isSome(failure)
      ? modelFailureMetadata(failure.value)
      : Option.isSome(defect)
        ? modelFailureMetadata(defect.value)
        : { kind: Cause.isInterrupted(cause) ? "interrupted" : "unclassified" }),
    interrupted: Cause.isInterrupted(cause),
  };
};
