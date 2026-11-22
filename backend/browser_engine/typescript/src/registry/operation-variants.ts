import { Schema } from "effect";
const Identifier = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{1,200}$/));
export const SupportedOperationVariant = Schema.Struct({
  id: Identifier,
  entrypoint: Schema.String.pipe(Schema.pattern(/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:m?js)$/)),
  enabled: Schema.Boolean,
});
