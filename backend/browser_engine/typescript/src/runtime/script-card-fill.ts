import { Schema } from "effect";

/**
 * A published script's card fill (`fillCard`): the script names each card field's selector and
 * the card answer `ask` returned for it, which is a handle, never the card itself. The host types
 * the caller's card into those fields under the card-fill step's checks and returns only what it
 * did, with no value in it.
 */

/** A run's card handle as `ask` returns it for a card question. */
export const runCardHandlePattern = /^\{\{card\.c[1-9]\d{0,3}\}\}$/u;

/** One card field: its own selector and the card handle it takes. */
const CardField = Schema.Struct({
  selector: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1_000)),
  handle: Schema.String.pipe(Schema.pattern(runCardHandlePattern)),
});

/** What a script sends: one to four card fields, each handle once. */
export const ScriptCardFillRequest = Schema.Struct({
  fields: Schema.Array(CardField).pipe(
    Schema.minItems(1),
    Schema.maxItems(4),
    Schema.filter(
      (fields) => new Set(fields.map((field) => field.handle)).size === fields.length,
      { message: () => "name each card handle once" },
    ),
  ),
});
export type ScriptCardFillRequest = typeof ScriptCardFillRequest.Type;

/** Each field's card part and how its typing went, as the host reports it. */
const FieldReport = Schema.Struct({
  slot: Schema.String.pipe(Schema.maxLength(32)),
  status: Schema.String.pipe(Schema.maxLength(64)),
});

/**
 * The host's answer: `filled` typed every field. `refused` typed nothing; `failed` and `uncertain`
 * may have typed some, as `typed` says. `message` is why, with no value in it.
 */
export const ScriptCardFillAnswer = Schema.Union(
  Schema.Struct({
    outcome: Schema.Literal("filled"),
    fields: Schema.Array(FieldReport).pipe(Schema.maxItems(4)),
  }),
  Schema.Struct({
    outcome: Schema.Literal("refused", "failed", "uncertain"),
    typed: Schema.Boolean,
    message: Schema.String.pipe(Schema.maxLength(2_000)),
  }),
);
export type ScriptCardFillAnswer = typeof ScriptCardFillAnswer.Type;
