import { posix } from "node:path";
import type { AgentOutputType } from "@openai/agents";
import { Effect } from "effect";
import {
  guardianActions,
  guardianRefusalGrounds,
  guardianRefusals,
  publicationFindingCategories,
  publicationReasons,
  routePointerParts,
} from "./review-contracts.js";
import type { PendingExecution, ReviewFailure } from "./review.js";

/**
 * Every Guardian review kind shares one request layout: the same instructions, tool and output
 * format. Only the per-review user message differs, so a mint's conversation stays cached when
 * it moves from one kind of review to another.
 */
export type ReviewKind = "execution" | "question" | "update" | "recovery" | "publication" | "host";

export const reviewKindOf = (pending: PendingExecution): ReviewKind =>
  pending.hostReview !== undefined
    ? "host"
    : pending.publication !== undefined
      ? "publication"
      : pending.questionCandidate !== undefined
        ? "question"
        : pending.updateCandidate !== undefined
          ? "update"
          : pending.recoveryCandidate !== undefined
            ? "recovery"
            : "execution";

/** Every outcome the shared format offers; a host-defined kind allows a subset of them. */
export const guardianOutcomes = [
  "allow",
  "deny",
  "escalate",
  "allow_business",
  "authentication",
  "reword",
  "clarify",
  "new_mint",
] as const;
export type GuardianOutcome = (typeof guardianOutcomes)[number];

/** The outcomes each built-in kind may return. The host refuses any other. */
const reviewOutcomes = {
  execution: ["allow", "deny", "escalate"],
  recovery: ["allow", "deny", "escalate"],
  publication: ["allow", "deny", "escalate"],
  question: ["allow_business", "authentication", "reword"],
  update: ["allow", "clarify", "reword", "new_mint"],
} as const satisfies Record<Exclude<ReviewKind, "host">, readonly GuardianOutcome[]>;

/**
 * The outcomes the review may return, as its request lists them in `trusted_review.outcomes`
 * and the host checks them.
 */
export const reviewOutcomesOf = (pending: PendingExecution): readonly GuardianOutcome[] => {
  const kind = reviewKindOf(pending);
  return kind === "host" ? (pending.hostReview?.outcomes ?? []) : reviewOutcomes[kind];
};

/** Whether a decision's outcome is one its review may return. */
export const outcomeAccepted = (pending: PendingExecution, raw: unknown): boolean =>
  typeof raw === "object" &&
  raw !== null &&
  (reviewOutcomesOf(pending) as readonly unknown[]).includes(Reflect.get(raw, "outcome"));

/** The decision fields besides outcome and rationale that each kind uses. */
const reviewFields: Record<ReviewKind, readonly string[]> = {
  execution: ["action", "refusal", "refusalGround", "advice"],
  recovery: ["advice"],
  question: [],
  update: [],
  publication: ["reason", "findings", "publicReason"],
  host: ["label"],
};

/**
 * One strict output format for every kind: the union of their outcomes and fields. A field a
 * kind does not use is null; the host drops it and checks the outcome against the kind.
 */
export const guardianDecisionFormat: AgentOutputType = {
  type: "json_schema",
  name: "guardian_decision",
  strict: true,
  schema: {
    type: "object",
    properties: {
      outcome: {
        type: "string",
        enum: [...guardianOutcomes],
      },
      rationale: { type: "string" },
      reason: {
        anyOf: [{ type: "null" }, { type: "string", enum: [...publicationReasons] }],
      },
      // A publication denial's short reason for the caller, apart from the private rationale.
      publicReason: { anyOf: [{ type: "null" }, { type: "string" }] },
      // A host-defined kind's finite code, one its policy lists; the host checks it.
      label: { anyOf: [{ type: "null" }, { type: "string" }] },
      // An execution review's label of what the code does on the website.
      action: { anyOf: [{ type: "null" }, { type: "string", enum: [...guardianActions] }] },
      // An execution deny or escalate's refusal kind: final or correctable.
      refusal: { anyOf: [{ type: "null" }, { type: "string", enum: [...guardianRefusals] }] },
      // The host fact an execution deny or escalate rests on, which the host checks.
      refusalGround: {
        anyOf: [{ type: "null" }, { type: "string", enum: [...guardianRefusalGrounds] }],
      },
      // An execution or recovery allow's optional note for the agent, which never blocks the step.
      advice: { anyOf: [{ type: "null" }, { type: "string" }] },
      findings: {
        anyOf: [
          { type: "null" },
          {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                // A line or two copied from the text at fault; the host places it at its first
                // occurrence, or on the whole file.
                quote: { type: "string" },
                category: {
                  type: "string",
                  // The host's own example-input check is never Guardian's.
                  enum: publicationFindingCategories.filter(
                    (category) => category !== "example_input",
                  ),
                },
                explanation: { type: "string" },
                route: {
                  anyOf: [
                    { type: "null" },
                    {
                      type: "object",
                      properties: {
                        order: { type: "integer", minimum: 1 },
                        part: { type: "string", enum: [...routePointerParts] },
                        name: { type: ["string", "null"] },
                      },
                      required: ["order", "part", "name"],
                      additionalProperties: false,
                    },
                  ],
                },
              },
              required: ["path", "quote", "category", "explanation", "route"],
              additionalProperties: false,
            },
          },
        ],
      },
    },
    required: [
      "outcome",
      "rationale",
      "reason",
      "findings",
      "publicReason",
      "label",
      "action",
      "refusal",
      "refusalGround",
      "advice",
    ],
    additionalProperties: false,
  },
};

/**
 * The kind's own decision from the shared format: other kinds' fields and null placeholders
 * dropped. Undefined when the outcome is not one the kind may return.
 */
export const decisionForKind = (pending: PendingExecution, raw: unknown): unknown => {
  if (typeof raw !== "object" || raw === null) return raw;
  const kind = reviewKindOf(pending);
  if (!outcomeAccepted(pending, raw)) return undefined;
  const fields = new Set(["outcome", "rationale", ...reviewFields[kind]]);
  return Object.fromEntries(
    Object.entries(raw).filter(
      ([key, value]) => fields.has(key) && (value !== null || !reviewFields[kind].includes(key)),
    ),
  );
};

/** A source path as the host compares it: `./x`, `x` and `a/../x` name one file. */
export const sourcePath = (path: string): string => {
  const normal = posix.normalize(path);
  return normal.startsWith("./") ? normal.slice(2) : normal;
};

interface SourceChunk {
  readonly path: string;
  readonly byteOffset: number;
  readonly nextOffset: number;
  readonly hasMore: boolean;
  /** The chunk as one canonical JSON text, for comparing reads of the same bytes. */
  readonly canonical: string;
  readonly value: Readonly<Record<string, unknown>>;
}

/** One `read_source` result, when it is a source chunk the host can compare. */
export const sourceChunkOf = (observation: unknown): SourceChunk | undefined => {
  let value: unknown = observation;
  if (typeof observation === "string")
    try {
      value = JSON.parse(observation);
      // error-reporting-allow: parse-predicate a result that is not JSON is not a comparable chunk
    } catch {
      return undefined;
    }
  if (typeof value !== "object" || value === null) return undefined;
  const chunk = value as Record<string, unknown>;
  const { path, byteOffset, nextOffset, hasMore } = chunk;
  return chunk.kind === "untrusted_source" &&
    typeof path === "string" &&
    typeof byteOffset === "number" &&
    typeof nextOffset === "number" &&
    typeof hasMore === "boolean"
    ? {
        path: sourcePath(path),
        byteOffset,
        nextOffset,
        hasMore,
        canonical: JSON.stringify(chunk),
        value: chunk,
      }
    : undefined;
};

/**
 * The source chunks one `read_source` result carries: its chunk, or each file's chunk of a
 * several-file call.
 */
const sourceChunksOf = (observation: string | undefined): readonly SourceChunk[] => {
  if (observation === undefined) return [];
  const single = sourceChunkOf(observation);
  if (single !== undefined) return [single];
  let value: unknown;
  try {
    value = JSON.parse(observation);
    // error-reporting-allow: parse-predicate a result that is not JSON carries no chunk
  } catch {
    return [];
  }
  if (typeof value !== "object" || value === null) return [];
  const files: unknown = Reflect.get(value, "files");
  return Reflect.get(value, "kind") === "untrusted_sources" && Array.isArray(files)
    ? files.flatMap((file) => sourceChunkOf(file) ?? [])
    : [];
};

const resultText = (output: unknown): string | undefined => {
  if (typeof output === "string") return output;
  if (typeof output !== "object" || output === null) return undefined;
  if (Array.isArray(output)) {
    const texts = output.map(resultText);
    return texts.every((text) => text !== undefined) ? texts.join("") : undefined;
  }
  const text: unknown = Reflect.get(output, "text");
  return typeof text === "string" ? text : undefined;
};

/** Source chunks Guardian has in view, by path and byte offset, each as canonical JSON. */
export type SourceLedger = ReadonlyMap<string, ReadonlyMap<number, string>>;

/**
 * What Guardian already read in a conversation: every source chunk a `read_source` result, each
 * file of a several-file one included, or a request's included entrypoint carries. A session's
 * history starts at its last compaction, so this is what Guardian read since then.
 */
export const sourceLedger = (history: readonly unknown[]): SourceLedger => {
  const ledger = new Map<string, Map<number, string>>();
  const keep = (chunk: SourceChunk | undefined) => {
    if (chunk === undefined) return;
    const chunks = ledger.get(chunk.path) ?? new Map<number, string>();
    chunks.set(chunk.byteOffset, chunk.canonical);
    ledger.set(chunk.path, chunks);
  };
  for (const item of history) {
    if (typeof item !== "object" || item === null) continue;
    const type: unknown = Reflect.get(item, "type");
    if (type === "function_call_result" && Reflect.get(item, "name") === "read_source")
      for (const chunk of sourceChunksOf(resultText(Reflect.get(item, "output")))) keep(chunk);
    else if (Reflect.get(item, "role") === "user") {
      const request = sourceChunkRequest(resultText(Reflect.get(item, "content")));
      keep(request);
    }
  }
  return ledger;
};

/** The entrypoint chunk a review request included, when the message is a review request. */
const sourceChunkRequest = (content: string | undefined): SourceChunk | undefined => {
  if (content === undefined || !content.startsWith("{")) return undefined;
  try {
    const request: unknown = JSON.parse(content);
    if (typeof request !== "object" || request === null) return undefined;
    const call: unknown = Reflect.get(request, "submitted_call");
    return typeof call === "object" && call !== null
      ? sourceChunkOf(Reflect.get(call, "entrypointSource"))
      : undefined;
    // error-reporting-allow: parse-predicate a message that is not JSON includes no source
  } catch {
    return undefined;
  }
};

/** A file larger than this many chunks is read again rather than compared. */
const comparedChunks = 32;

/**
 * The paths whose current content is byte-identical, chunk for chunk, to what the ledger holds.
 * Only paths Guardian already read are compared; a read that fails leaves its path out.
 */
export const unchangedSources = (
  ledger: SourceLedger,
  paths: readonly string[],
  read: (path: string, offset: number) => Effect.Effect<string, ReviewFailure>,
): Effect.Effect<readonly string[]> =>
  Effect.forEach(
    [...new Set(paths)].filter((path) => ledger.has(sourcePath(path))),
    (path) =>
      Effect.gen(function* () {
        const seen = ledger.get(sourcePath(path));
        let offset = 0;
        for (let index = 0; index < comparedChunks; index++) {
          const current = sourceChunkOf(yield* read(path, offset));
          if (current === undefined || seen?.get(offset) !== current.canonical) return [];
          if (!current.hasMore) return [path];
          if (current.nextOffset <= offset) return [];
          offset = current.nextOffset;
        }
        return [];
      }).pipe(
        // error-reporting-allow: typed-recovery a source the host cannot compare is read again
        Effect.catchAll(() => Effect.succeed([])),
      ),
    { concurrency: 4 },
  ).pipe(Effect.map((found) => found.flat()));

const privateReviewRequest = (item: unknown): boolean => {
  if (typeof item !== "object" || item === null || Reflect.get(item, "role") !== "user")
    return false;
  const content: unknown = Reflect.get(item, "content");
  if (typeof content !== "string" || !content.startsWith("{")) return false;
  try {
    const request: unknown = JSON.parse(content);
    const review: unknown =
      typeof request === "object" && request !== null
        ? Reflect.get(request, "trusted_review")
        : undefined;
    return typeof review === "object" && review !== null && Reflect.get(review, "private") === true;
    // error-reporting-allow: parse-predicate a message that is not JSON is no review request
  } catch {
    return false;
  }
};

/**
 * A conversation as readable records may show it: each private review's exchange, its
 * request and everything up to the next request, replaced by one placeholder message. The
 * model still receives the whole conversation; `restore` maps placeholders back to it.
 */
export const withholdPrivateReviews = <Item>(
  items: readonly Item[],
  placeholder: (index: number) => Item,
  /** The items before the first request continue a private review a compaction cut. */
  leadingPrivate = false,
): { readonly items: Item[]; readonly withheld: ReadonlyMap<string, readonly Item[]> } => {
  const shown: Item[] = [];
  const withheld = new Map<string, Item[]>();
  let segment: Item[] | undefined;
  if (leadingPrivate) {
    const stand = placeholder(0);
    segment = [];
    withheld.set(JSON.stringify(stand), segment);
    shown.push(stand);
  }
  for (const item of items) {
    const request =
      typeof item === "object" && item !== null && Reflect.get(item, "role") === "user";
    if (request) segment = undefined;
    if (request && privateReviewRequest(item)) {
      const stand = placeholder(withheld.size);
      segment = [];
      withheld.set(JSON.stringify(stand), segment);
      shown.push(stand);
    }
    if (segment === undefined) shown.push(item);
    else segment.push(item);
  }
  return { items: shown, withheld };
};

/**
 * Whether the items a compaction keeps, up to the next request, belong to a private
 * review: the last request among the items it drops says, or else the earlier answer stands.
 */
export const leadingPrivateAfter = (dropped: readonly unknown[], before: boolean): boolean => {
  for (const item of [...dropped].reverse())
    if (typeof item === "object" && item !== null && Reflect.get(item, "role") === "user")
      return privateReviewRequest(item);
  return before;
};
