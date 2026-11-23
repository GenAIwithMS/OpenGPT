import { createHmac } from "node:crypto";

/** JSON text that is the same for any object key order. Throws for a value that is not JSON data. */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new Error("Fingerprint input must be JSON data");
};

/**
 * A keyed digest of JSON data that is the same for any object key order. `domain` keeps a
 * request's digest apart from a retry key's. Throws for a value that is not JSON data.
 */
export const fingerprint = (key: Uint8Array, domain: "request" | "retry", value: unknown): string =>
  createHmac("sha256", key).update(domain).update("\0").update(canonicalJson(value)).digest("hex");
