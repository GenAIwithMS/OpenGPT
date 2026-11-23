import { Usage } from "@openai/agents";

const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** The SDK types token details as numbers, but it copies the provider's nested objects as given. */
const total = (details: readonly object[], read: (entry: object) => unknown) =>
  details.reduce((sum, entry) => sum + count(read(entry)), 0);

const field = (key: string) => (entry: object) => Reflect.get(entry, key);

/** A cache write's tokens at one lifetime, from the provider's `cache_write_tokens_details`, as
 * given or as `flatUsage` keeps it. */
const writtenFor = (key: "ttl_30m_tokens" | "ttl_12h_tokens") => (entry: object) => {
  const details: unknown = Reflect.get(entry, "cache_write_tokens_details");
  return typeof details === "object" && details !== null
    ? Reflect.get(details, key)
    : Reflect.get(entry, `cache_write_tokens_details.${key}`);
};

/** One entry's token details with numbers only: a nested count keeps its value as `<key>.<inner>`. */
const flatDetails = (details: object | undefined): Record<string, number> =>
  Object.fromEntries(
    Object.entries(details ?? {}).flatMap(([key, value]: [string, unknown]) =>
      typeof value === "number"
        ? [[key, value]]
        : typeof value === "object" && value !== null
          ? Object.entries(value).flatMap(([inner, count]: [string, unknown]) =>
              typeof count === "number" ? [[`${key}.${inner}`, count]] : [],
            )
          : [],
    ),
  );

/**
 * The usage with every token detail a number, as the SDK's saved run state requires. The SDK
 * copies the provider's details as given, so a nested count, such as the per-lifetime
 * `cache_write_tokens_details` of a request with a cache breakpoint, made the run state fail to
 * save. Read a call's own counts with `modelUsageCounts` first; it reads both forms.
 */
export const flatUsage = (usage: Usage): Usage =>
  new Usage({
    requests: usage.requests,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    inputTokensDetails: (usage.inputTokensDetails ?? []).map(flatDetails),
    outputTokensDetails: (usage.outputTokensDetails ?? []).map(flatDetails),
    requestUsageEntries: (usage.requestUsageEntries ?? []).map((entry) => ({
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      totalTokens: entry.totalTokens,
      inputTokensDetails: flatDetails(entry.inputTokensDetails),
      outputTokensDetails: flatDetails(entry.outputTokensDetails),
      ...(entry.endpoint === undefined ? {} : { endpoint: entry.endpoint }),
    })),
  });

/** One model call's token counts, as finite diagnostics: the cache hit rate is
 * `cachedTokens / inputTokens`, and `cacheWriteTokens` is what the call newly cached, split by
 * lifetime into `cacheWrite30mTokens` and `cacheWrite12hTokens` (a 12-hour write costs twice a
 * 30-minute one). Input the call neither read from nor wrote to the cache is
 * `inputTokens - cachedTokens - cacheWriteTokens`. */
export const modelUsageCounts = (usage: Usage) => ({
  inputTokens: usage.inputTokens,
  cachedTokens: total(usage.inputTokensDetails, field("cached_tokens")),
  cacheWriteTokens: total(usage.inputTokensDetails, field("cache_write_tokens")),
  cacheWrite30mTokens: total(usage.inputTokensDetails, writtenFor("ttl_30m_tokens")),
  cacheWrite12hTokens: total(usage.inputTokensDetails, writtenFor("ttl_12h_tokens")),
  outputTokens: usage.outputTokens,
  reasoningTokens: total(usage.outputTokensDetails, field("reasoning_tokens")),
});
