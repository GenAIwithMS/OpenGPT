import type { ListDraft } from "./list-page.js";

// The host channel a list's checked position reaches a run on. It has no other imports, so every
// runtime module that starts a run can attach it.

/**
 * What a host that signs cursors gives a run beside its input: the position the caller's cursor
 * holds, once the host checked it, or none on a first page. A run without it refuses any cursor
 * that would continue a runtime list and returns no next cursor, since nothing would sign it.
 */
export interface ListHost {
  readonly position?: ListDraft;
}

/**
 * The key the host channel rides under on a run's decoded input. JSON and the structured clone a
 * host sends input through cannot carry a symbol key, so no caller's input can set it.
 */
const listHostKey = Symbol.for("opengpt.list.host");

/**
 * The run's input with the host's checked list position beside it; for a host's runtime only.
 * The key is not enumerable, so code that walks the input's own keys, such as
 * `new URLSearchParams(input)`, never sees it.
 */
export const withListHost = <Input>(input: Input, host: ListHost): Input => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const hosted = { ...input };
  Object.defineProperty(hosted, listHostKey, { value: host, enumerable: false });
  return hosted;
};

/** The host channel a run's input carries, when its host signs cursors. */
export const listHostOf = (input: unknown): ListHost | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const host: unknown = Reflect.get(input, listHostKey);
  return typeof host === "object" && host !== null ? (host as ListHost) : undefined;
};

