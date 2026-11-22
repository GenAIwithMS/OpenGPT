/**
 * The provider refused a model call because the account's quota or billing limit is spent: a 429
 * that waiting does not clear. Found on the provider's error or on a cause beneath an SDK wrapper.
 */
export const providerQuotaExhausted = (error: unknown, depth = 0): boolean =>
  depth <= 8 &&
  error !== null &&
  typeof error === "object" &&
  (Reflect.get(error, "code") === "insufficient_quota" ||
    providerQuotaExhausted(Reflect.get(error, "cause"), depth + 1));
