import { Schema } from "effect";
import { LoginFields, SignInMethods } from "../destinations/login-fields.js";

export type CapabilityContract = (typeof CapabilityReviewSchema.Type.tools)[number];
export interface CapabilityReview {
  readonly status: "duplicate" | "uncertain";
  readonly site_origin: string;
  readonly tools: readonly CapabilityContract[];
  readonly recommendation: "use_existing_or_repair" | "clarify_capability";
}
export const CapabilityReviewSchema = Schema.Struct({
  status: Schema.Literal("duplicate"),
  site_origin: Schema.String.pipe(Schema.maxLength(4096)),
  tools: Schema.Array(
    Schema.Struct({
      id: Schema.String.pipe(Schema.maxLength(200)),
      name: Schema.String.pipe(Schema.maxLength(500)),
      description: Schema.String.pipe(Schema.maxLength(10_000)),
      site_origin: Schema.NullOr(Schema.String.pipe(Schema.maxLength(4096))),
      input_schema: Schema.Unknown,
      output_schema: Schema.Unknown,
      effect: Schema.Literal("read", "write"),
      login_required: Schema.Boolean,
      login_fields: Schema.optional(LoginFields),
      sign_in_methods: Schema.optional(SignInMethods),
      enabled: Schema.Boolean,
    }),
  ).pipe(Schema.minItems(1), Schema.maxItems(10)),
  recommendation: Schema.Literal("use_existing_or_repair"),
});
