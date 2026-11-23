import { Effect, Schema } from "effect";
import type { PublicationDecision } from "../mint/contracts.js";
import type { AnsweredQuestion } from "./question.js";

/** Text a task update carries, which its caller may read. */
const UpdateText = Schema.String.pipe(Schema.pattern(/\S/), Schema.maxLength(500));

/** An `http:` or `https:` origin exactly as `URL.origin` writes it, without path or credentials. */
const SiteOrigin = Schema.String.pipe(
  Schema.maxLength(2048),
  Schema.filter(
    (value) => {
      const url = URL.parse(value);
      return url !== null && (url.protocol === "https:" || url.protocol === "http:")
        ? url.origin === value
        : false;
    },
    { message: () => "an http or https origin, such as https://app.example.com, with no path" },
  ),
);

/**
 * One task setting a `mint_update` changes:
 * - `input`: business input values by top-level key; `null` removes one.
 * - `requirement`: a requirement, constraint or prerequisite of the task added, dropped or revised.
 * - `purpose`: what the finished tool is for, restated.
 * - `effect`: a read build becomes a write build. Nothing turns a write back into a read.
 * - `site`: the build moves to another site origin of the same product's workflow.
 * - `login`: the task now needs a sign-in, or a different login than the one it has, or it runs
 *   signed out (`signed_out`): the owner chose the part the site shows without signing in.
 * - `output`: in maintenance only, one output field of the published tool's registered contract,
 *   by path, such as `price.amount` or `items[].currency`, with `text` saying the change as the
 *   caller reads it. `add` adds a field and `tighten` makes one stricter (optional or nullable to
 *   required, or a narrower type): callers keep everything they received, so neither needs
 *   anyone's confirmation. `optional`, `nullable` and `widen` loosen a field the site no longer
 *   shows as before, and `remove` drops one with a `reason` the host requires; the tool's owner
 *   confirms each of these.
 */
export const TaskChange = Schema.Union(
  Schema.Struct({
    setting: Schema.Literal("input"),
    values: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  }),
  Schema.Struct({
    setting: Schema.Literal("requirement"),
    change: Schema.Literal("add", "drop", "revise"),
    text: UpdateText,
  }),
  Schema.Struct({ setting: Schema.Literal("purpose"), text: UpdateText }),
  Schema.Struct({ setting: Schema.Literal("effect"), effect: Schema.Literal("write") }),
  Schema.Struct({ setting: Schema.Literal("site"), origin: SiteOrigin }),
  Schema.Struct({
    setting: Schema.Literal("login"),
    change: Schema.Literal("sign_in", "different_login", "signed_out"),
    text: Schema.optional(UpdateText),
  }),
  Schema.Struct({
    setting: Schema.Literal("output"),
    field: Schema.String.pipe(Schema.pattern(/\S/), Schema.maxLength(200)),
    change: Schema.Literal("add", "tighten", "optional", "nullable", "remove", "widen"),
    text: UpdateText,
    /** Why the field must go, from what the site shows; required for `remove`. */
    reason: Schema.optional(UpdateText),
  }),
);
export type TaskChange = typeof TaskChange.Type;

/**
 * Guardian's decision on a proposed task update:
 * - `allow`: the caller confirmed it and it stays within the protections; an update applies, and a
 *   recommended new build ends this one.
 * - `clarify`: the caller's confirmation is missing or ambiguous; the minter asks first.
 * - `reword`: the proposal is wrong as written; the minter revises it, and the build continues.
 * - `new_mint`: the change is a different task or another product's workflow, which belongs in a
 *   new build.
 */
export const TaskUpdateDecision = Schema.Struct({
  outcome: Schema.Literal("allow", "clarify", "reword", "new_mint"),
  rationale: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1000)),
});
export type TaskUpdateDecision = typeof TaskUpdateDecision.Type;

/**
 * Who can confirm a maintenance change to a published tool's registered contract. `owner`: the
 * host checked that the person who answers the build's questions is the tool's owner.
 * `owner_request`: the same, and the maintenance is the owner's own request to change the tool,
 * which trusted intent states, so an output change that request plainly names is confirmed by it.
 * `none`: nobody can confirm, so only an update that adds or tightens output fields applies.
 */
export type TaskUpdateConfirmer = "owner" | "owner_request" | "none";

/** A task update as Guardian reviews it: every string screened, as the caller would read it. */
export interface PendingTaskUpdate {
  readonly summary: string;
  readonly changes: readonly TaskChange[];
  /** The minter's own judgment: update this build, or end it and recommend a new one. */
  readonly recommend: "update" | "new_mint";
  /** The request the caller could submit as a separate build. */
  readonly suggestedRequest?: string;
  /**
   * The answered questions the minter cites as the caller's confirmation, exactly as the host
   * recorded them: the screened prompt and answer. A picked option's label is the minting model's
   * wording, and the caller's pick of it is their confirmation of what it says.
   */
  readonly confirmation: readonly AnsweredQuestion[];
  /** Host fact: the build's current effect. */
  readonly effect: "read" | "write";
  /**
   * Host evidence: the build's latest publication refusals, as the host recorded them, so a change
   * proposed after one is judged against the refusal itself. Absent when there are none.
   */
  readonly publicationDecisions?: readonly PublicationDecision[];
  /**
   * Host fact, in maintenance only: the update changes a published tool's registered contract,
   * and `confirmer` says who can confirm it.
   */
  readonly maintenance?: { readonly confirmer: TaskUpdateConfirmer };
  /** Host fact: the host can't move this build to another site, so a site change needs a new build. */
  readonly siteMoveUnsupported?: true;
}

/**
 * One update the host accepted, as every later review reads it beside the intent: the effective
 * task is the intent with each accepted update applied in order. `revision` counts from 1; an
 * execution that ran before it ran under the revision it names.
 */
export interface ReviewedTaskUpdate {
  readonly revision: number;
  readonly summary: string;
  readonly changes: readonly TaskChange[];
  readonly confirmation: readonly AnsweredQuestion[];
}

/** Projects a proposed update for review, screening every string and input value. */
export const taskUpdateForReview = <E>(
  update: Omit<
    PendingTaskUpdate,
    "confirmation" | "effect" | "maintenance" | "siteMoveUnsupported"
  >,
  facts: Pick<
    PendingTaskUpdate,
    "confirmation" | "effect" | "publicationDecisions" | "maintenance" | "siteMoveUnsupported"
  >,
  screen: {
    readonly text: (value: string) => Effect.Effect<string, E>;
    readonly json: (value: unknown) => Effect.Effect<unknown, E>;
  },
): Effect.Effect<PendingTaskUpdate, E> =>
  Effect.gen(function* () {
    const { text } = screen;
    const changes = yield* Effect.forEach(update.changes, (change) =>
      change.setting === "input"
        ? screen.json(change.values).pipe(
            Effect.map((values): TaskChange => ({
              setting: "input",
              values:
                typeof values === "object" && values !== null && !Array.isArray(values)
                  ? (values as Readonly<Record<string, unknown>>)
                  : {},
            })),
          )
        : change.setting === "output"
          ? Effect.all({
              field: text(change.field),
              text: text(change.text),
              ...(change.reason === undefined ? {} : { reason: text(change.reason) }),
            }).pipe(Effect.map((screened): TaskChange => ({ ...change, ...screened })))
          : "text" in change && change.text !== undefined
            ? text(change.text).pipe(Effect.map((screened) => ({ ...change, text: screened })))
            : Effect.succeed(change),
    );
    return {
      summary: yield* text(update.summary),
      changes,
      recommend: update.recommend,
      ...(update.suggestedRequest === undefined
        ? {}
        : { suggestedRequest: yield* text(update.suggestedRequest) }),
      confirmation: facts.confirmation,
      effect: facts.effect,
      // Written by the harness, which screened each instruction: nothing to screen.
      ...(facts.publicationDecisions === undefined || facts.publicationDecisions.length === 0
        ? {}
        : { publicationDecisions: facts.publicationDecisions }),
      ...(facts.maintenance === undefined ? {} : { maintenance: facts.maintenance }),
      ...(facts.siteMoveUnsupported === true ? { siteMoveUnsupported: true as const } : {}),
    };
  });
