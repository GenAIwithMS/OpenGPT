import { Schema } from "effect";

/** The messages between the native executor and its worker thread. Internal to the executor. */
export const NativeWorkerRequest = Schema.Union(
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("execute"),
    code: Schema.String,
    /**
     * Values to watch for: the worker answers which ones a typing call delivered, and in which
     * frame (`typed`).
     */
    watch: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("credential"),
    target: Schema.Struct({
      targetId: Schema.optional(Schema.String),
      bindingKey: Schema.String,
      documentOrigin: Schema.String,
    }),
    text: Schema.String,
    /** The keyboard's `InsertionOptions`: read a phone number back, and type by keys. */
    phone: Schema.optional(Schema.Literal(true)),
    keys: Schema.optional(Schema.Literal(true)),
  }),
);
export const NativeWorkerReply = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("ready"),
    targetId: Schema.String,
    /** The context the worker made and owns; absent for a page it adopted over CDP. */
    contextId: Schema.optional(Schema.String),
  }),
  /** The worker's own connection to a CDP-attached browser closed. */
  Schema.Struct({ kind: Schema.Literal("disconnected") }),
  Schema.Struct({ kind: Schema.Literal("response"), id: Schema.String, value: Schema.Unknown }),
  Schema.Struct({ kind: Schema.Literal("failure"), id: Schema.String, error: Schema.String }),
);
export const PlaywrightLibrary = Schema.Literal("playwright", "patchright");
export type PlaywrightLibrary = typeof PlaywrightLibrary.Type;
export const NativeWorkerOptions = Schema.Struct({
  endpoint: Schema.String,
  startupTimeoutMs: Schema.Number,
  library: PlaywrightLibrary,
  /** The most bytes of JSON a script's result may take; 1 MiB when absent. Output keeps 1 MiB. */
  resultLimitBytes: Schema.optional(Schema.Number),
  /** Attach over CDP and drive the browser's own context, at this page (its first when absent). */
  cdp: Schema.optional(Schema.Struct({ targetId: Schema.optional(Schema.String) })),
});
