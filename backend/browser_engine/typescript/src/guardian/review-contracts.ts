import { Schema } from "effect";

/**
 * Host-owned index of a publication review's evidence, in UTF-8 bytes. `published` files ship with
 * the tool; the rest are host evidence for this review only. `current` files are the publication
 * as it stands; the others are historical source an earlier execution ran, such as a write
 * session's act steps. `owner` says who wrote a file: the minter edits its own, and nothing it
 * edits changes a host-written one. Guardian reads what the review needs; nothing must be read in
 * full.
 */
export interface PublicationScope {
  readonly files: readonly {
    readonly path: string;
    readonly byteLength: number;
    readonly published: boolean;
    readonly current: boolean;
    readonly owner: "host" | "minter";
  }[];
  /**
   * The inputs the tool's published revision declares, each by name with its description, when
   * this publication replaces a published tool. A host supplies it from its own record of that
   * revision, never from anything the minter wrote, so Guardian can tell a repair that keeps a
   * caller's earlier decision on how an input is used, a "By design:" description, word for word.
   * Absent, a repair gets no such allowance. The local host keeps no published revisions and
   * supplies none.
   */
  readonly publishedInputs?: readonly {
    readonly name: string;
    readonly description?: string;
  }[];
  /**
   * Files the review may read on demand that are not its evidence, such as the skills the minter
   * followed, each with its byte length. None ships and none is in `files`, so no finding names
   * one.
   */
  readonly references?: readonly { readonly path: string; readonly byteLength: number }[];
  /**
   * Small files of `files` the host sends in the request, so the review needs no turn to read
   * them: each by its path, exactly as `read_source` returns it, a JSON file parsed and any other
   * as its text.
   */
  readonly inline?: readonly { readonly path: string; readonly content: unknown }[];
}

/**
 * The business meaning of an execution, as Guardian's execution review labels it: `read`
 * observes without changing persistent business state; `write` changes it, an intermediate
 * change such as adding to a cart or saving a draft included; `authentication` signs in. Every
 * allowed execution carries one, and a host records it against the execution.
 */
export const guardianActions = ["read", "write", "authentication"] as const;
export const GuardianAction = Schema.Literal(...guardianActions);
export type GuardianAction = typeof GuardianAction.Type;

/**
 * What kind of refusal an execution review's deny or escalate is: `final` when no change to the
 * source, input or evidence within the request's authority would make the step acceptable, and
 * `correctable` otherwise. Only a `final` refusal lets the build end as a `policy` block. A deny
 * or escalate without one, from a reviewer that predates it, counts as `final`, as every
 * execution refusal did before.
 */
export const guardianRefusals = ["final", "correctable"] as const;
export const GuardianRefusal = Schema.Literal(...guardianRefusals);
export type GuardianRefusal = typeof GuardianRefusal.Type;

/**
 * A host fact an execution refusal may rest on, which the host checks against its own record:
 * `retry_permission`, that the step may not run again; `committed_write`, that the step would
 * commit a listed write again; `write_authority`, that the step's own authority grants no write;
 * `owner_confirmation`, that the step needs the owner's confirmation, which the agent asks for
 * with a confirm question that names this review. A refusal whose ground the host's record
 * contradicts, retry permission when trusted_execution_context.repeatableRead is true, a
 * committed write for a step the review labels a read, missing write authority for a step the
 * host gives write authority, or missing confirmation for the very step the owner confirmed
 * (`trusted_authority.ownerConfirmedStep`), is sent back once in the same review and is never
 * final. An older reviewer never names `write_authority` or `owner_confirmation`, so its refusals
 * stand as before.
 */
export const guardianRefusalGrounds = [
  "retry_permission",
  "committed_write",
  "write_authority",
  "owner_confirmation",
] as const;
export type GuardianRefusalGround = (typeof guardianRefusalGrounds)[number];

/**
 * Input findings are feedback for the minter; they never block a publication on their own.
 * `example_input` is the host's own check that each key of an intent-derived example's input is
 * a schema input, never Guardian's.
 */
export const inputFindingCategories = [
  "account_specific_enum",
  "input_option",
  "example_input",
] as const;
export const publicationFindingCategories = [
  "private_literal",
  "credential",
  "customer_data",
  "exfiltration",
  "unsafe_logging",
  "schema_mismatch",
  "unsupported_claim",
  "confirmation",
  // An input narrowed to the example's value, which blocks publication like a source correction.
  "example_value",
  // A safety default an earlier copy of the source set that the current source drops or weakens,
  // which blocks publication with reason privacy.
  "safety_default",
  ...inputFindingCategories,
] as const;
export const publicationReasons = [
  "approved",
  "privacy",
  "authority",
  "evidence",
  "source_correction",
  "unsupported_claim",
  "input_feedback",
  // Every finding is in a host-written file, which no source or metadata edit can fix.
  "host_owned",
] as const;

/**
 * A publication refusal no correction within the minter's authority gets past: the tool would
 * expose private data or send it off the site, or needs authority the build does not have. Every
 * other denial or escalation names a correction, such as evidence the minter gathers, so it never
 * ends a build as a `policy` block. Nor does `host_owned`, a defect in a file the host wrote: the
 * host ends that build as its own failure.
 */
export const unfixablePublicationReasons = [
  "privacy",
  "authority",
] as const satisfies readonly PublicationReason[];
export const unfixableFindingCategories = [
  "private_literal",
  "credential",
  "customer_data",
  "exfiltration",
  "unsafe_logging",
  "safety_default",
] as const satisfies readonly (typeof publicationFindingCategories)[number][];

/**
 * Whether a publication review's deny or escalation is a refusal a `policy` block may stand on:
 * an unfixable reason, or an unfixable finding under any reason. The outcome alone never decides
 * it: an escalation for missing evidence asks the minter to gather it, like a denial does.
 */
export const publicationRefusalUnfixable = (review: {
  readonly reason?: PublicationReason | undefined;
  readonly findings?: readonly { readonly category: string }[] | undefined;
}) =>
  unfixablePublicationReasons.some((reason) => reason === review.reason) ||
  (review.findings ?? []).some((finding) =>
    unfixableFindingCategories.some((category) => category === finding.category),
  );

/** The parts of one route in a host-generated routes.json that a finding can point at. */
export const routePointerParts = [
  "request_field",
  "response_field",
  "query",
  "path_segment",
  "session",
  "url",
] as const;
/**
 * Where in a host-generated file a finding is: the route by its `order`, which every review chunk
 * shows, and the part at fault, named exactly as the file writes it; `url` is the whole route and
 * names nothing. The host checks it against the file; a pointer it cannot match is no pointer.
 */
export const RoutePointer = Schema.Struct({
  order: Schema.Int.pipe(Schema.positive()),
  part: Schema.Literal(...routePointerParts),
  name: Schema.NullOr(Schema.String),
});
export type RoutePointer = typeof RoutePointer.Type;

/**
 * Text cut to `limit` characters, its last an ellipsis, never keeping half of a surrogate pair:
 * Guardian's text that outgrows its limit is kept, not lost with the decision.
 */
export const cutToLimit = (text: string, limit: number) => {
  if (text.length <= limit) return text;
  const high = text.charCodeAt(limit - 2);
  return `${text.slice(0, high >= 0xd800 && high <= 0xdbff ? limit - 2 : limit - 1)}…`;
};

/** The characters one finding's explanation may hold; the host cuts a longer one to fit. */
export const publicationExplanationLimit = 800;
export const PublicationFinding = Schema.Struct({
  path: Schema.String,
  byteStart: Schema.Int.pipe(Schema.nonNegative()),
  byteEnd: Schema.Int.pipe(Schema.positive()),
  category: Schema.Literal(...publicationFindingCategories),
  /**
   * What is wrong, the evidence and the fix, in words the minter acts on without the rest of the
   * review. It may quote the source, so it reaches the minter screened like the rationale.
   */
  explanation: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(publicationExplanationLimit),
  ),
  /** Only for a finding in a host-generated file; the model sends null for any other. */
  route: Schema.optionalWith(RoutePointer, { exact: true, nullable: true }),
});
export type PublicationFinding = typeof PublicationFinding.Type;
export const PublicationReason = Schema.Literal(...publicationReasons);
export type PublicationReason = typeof PublicationReason.Type;

export interface PublicationFileBlock {
  readonly file: string;
  readonly section?: string;
  readonly check: "registered_value" | "contextual_secret" | "provider_credential" | "invalid_text";
  readonly entity?: string;
  readonly valueSource?: string;
  readonly field?: string;
  readonly line?: number;
  readonly column?: number;
}
