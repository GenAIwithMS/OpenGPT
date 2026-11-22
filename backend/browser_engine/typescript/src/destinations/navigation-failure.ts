const noResponseErrors = [
  "ERR_EMPTY_RESPONSE",
  "ERR_CONNECTION_RESET",
  "ERR_CONNECTION_CLOSED",
  "ERR_CONNECTION_REFUSED",
  "ERR_CONNECTION_TIMED_OUT",
  "ERR_TUNNEL_CONNECTION_FAILED",
  "ERR_PROXY_CONNECTION_FAILED",
  "ERR_PROXY_CERTIFICATE_INVALID",
  "ERR_PROXY_AUTH_UNSUPPORTED",
  "ERR_PROXY_AUTH_REQUESTED",
  "ERR_PROXY_HTTP_1_1_REQUIRED",
  "ERR_PROXY_UNABLE_TO_CONNECT_TO_DESTINATION",
] as const;
/**
 * Chromium's name for a load that got no HTTP response. `error_page_at_attach` is a page already
 * on Chromium's error page when capture attached, before capture saw any load of its own.
 */
export type NoResponseError = (typeof noResponseErrors)[number] | "error_page_at_attach";
