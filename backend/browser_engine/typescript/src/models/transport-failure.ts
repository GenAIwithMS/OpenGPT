/**
 * Socket and DNS error codes that a repeat of the same request can get past: a reset, a broken
 * pipe, a timeout or a lookup that failed for now, including the HTTP client's own socket codes.
 */
const transientTransportCodes: ReadonlySet<unknown> = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/**
 * The connection to the provider was lost or timed out, found on the error or on a cause beneath
 * it. A response stream cut after its headers reaches a caller as a bare `TypeError: terminated`
 * whose cause holds the socket code, so the code, not the error's name or status, identifies it.
 */
export const transientTransportFailure = (error: unknown, depth = 0): boolean => {
  if (depth > 8 || error === null || typeof error !== "object") return false;
  if (transientTransportCodes.has(Reflect.get(error, "code"))) return true;
  const message: unknown = Reflect.get(error, "message");
  if (typeof message === "string" && message === "socket hang up") return true;
  return transientTransportFailure(Reflect.get(error, "cause"), depth + 1);
};
