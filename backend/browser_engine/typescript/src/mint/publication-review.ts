import { Effect, Option, Schema } from "effect";
import { publicDefinitionPath } from "../guardian/publication.js";
import type { PendingExecution, ReviewTurn } from "../guardian/review.js";
import type { PublicationScope } from "../guardian/review-contracts.js";
import {
  inlineLocalRefs,
  UnresolvedSchemaReference,
  withLoneReferences,
} from "../registry/schema-references.js";
import type { ScriptQuestionDeclarations } from "../runtime/script-input.js";
import type { TaskChange } from "../guardian/task-update.js";
import { MintFailure } from "./contracts.js";
import { entrypointImportClosure } from "./operation-source.js";

/**
 * The local host's publication review on finish_build, after its own checks: one Guardian review
 * of the bundle that would ship, the public definition the host writes from the build's metadata
 * and schemas, and the example's screened output or, for a write, the act session that performed
 * it. The local host supplies the Guardian call through `PublicationReview`, and screens the
 * example's output before it reaches this module.
 */

type Json = Readonly<Record<string, unknown>>;

/** The host's record of a read example's output, for publication review only. */
export const exampleOutputPath = "publication/example-output.json";
/** A write session's evidence: each act step's source, then the named step's output. */
export const sessionOutputPath = "publication/session-output.json";
/** Where each act step's source sits: historical evidence of what ran, never what ships. */
const sessionStepsDirectory = "publication/session/";
export const sessionStepPath = (index: number, path: string) =>
  `${sessionStepsDirectory}${index}/${path}`;

// Publication review judges claims against this envelope, so an oversized one carries an
// explicitly truncated prefix rather than exhausting the review's bounded turns.
const maximumEvidenceBytes = 96 * 1024;

/** The state of the host's record of an example's output. */
export type ExampleOutputState =
  | "available"
  | "truncated"
  | "unavailable"
  | "withheld"
  | "not_retained";
/** Which execution produced the output, and the source it ran. */
export interface ExampleOutputSource {
  readonly kind?: "verified_example_output" | "write_session_output";
  readonly executionId: string;
  readonly executedEntrypoint: string;
  /** A read example's executed source digest; a write session's record names its step instead. */
  readonly executedSourceDigest?: string;
}
interface ExampleOutputEvidence {
  readonly state: ExampleOutputState;
  readonly text: string;
  /** The whole screened output, parsed, when it was JSON; never truncated. */
  readonly screened?: unknown;
}

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;

/** A UTF-16 prefix that never ends inside a surrogate pair, so it encodes to whole code points. */
const codePointPrefix = (text: string, length: number) => {
  const last = text.charCodeAt(length - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length);
};

/** Where the host's per-field digest of the example output's lists goes. */
export const outputDigestPath = "publication/output-digest.json";

const decodeJson = Schema.decodeUnknownOption(Schema.parseJson());
const parsedJson = (text: string): unknown => Option.getOrUndefined(decodeJson(text));

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface RecordList {
  readonly path: string;
  readonly records: readonly unknown[];
  /** For a nested list, how many parent records hold one; its records are all of theirs. */
  readonly parents?: number;
}

/** The list `value` itself when most of it is records, then the lists nested in its records. */
const arrayRecordLists = (
  value: readonly unknown[],
  path: string,
  depth: number,
  parents?: number,
): RecordList[] => {
  const records = value.filter(isRecord);
  const here =
    records.length >= 2 && records.length * 2 >= value.length
      ? [
          {
            path: path === "" ? "[]" : path,
            records: value,
            ...(parents === undefined ? {} : { parents }),
          },
        ]
      : [];
  return [...here, ...nestedLists(records, `${path}[]`, depth + 1)];
};

/**
 * The lists under each field of `records`, every parent's combined: `results[].offers` holds the
 * offers of every result, never only the first result's.
 */
const nestedLists = (
  records: readonly Readonly<Record<string, unknown>>[],
  prefix: string,
  depth: number,
): RecordList[] => {
  if (depth > 4) return [];
  const keys = [...new Set(records.flatMap((record) => Object.keys(record)))];
  return keys.flatMap((key) => {
    const values = records.map((record) => record[key]);
    const lists = values.filter((field) => Array.isArray(field));
    const objects = values.filter(isRecord);
    return [
      ...(lists.length === 0
        ? []
        : arrayRecordLists(lists.flat(), `${prefix}.${key}`, depth, lists.length)),
      ...(objects.length === 0 ? [] : nestedLists(objects, `${prefix}.${key}`, depth + 1)),
    ];
  });
};

/** Each list of two or more records in `value`, by its path (`results`, `results[].offers`). */
const recordLists = (value: unknown, path = "", depth = 0): RecordList[] => {
  if (depth > 4) return [];
  if (Array.isArray(value)) return arrayRecordLists(value, path, depth);
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, field]) =>
    recordLists(field, path === "" ? key : `${path}.${key}`, depth + 1),
  );
};

const sampleLimit = 3;
const sampleLength = 120;
const sampleOf = (field: unknown) =>
  typeof field === "string" && field.length > sampleLength
    ? `${field.slice(0, sampleLength)}…`
    : field;

const hasValue = (field: unknown) =>
  field !== null &&
  field !== undefined &&
  field !== "" &&
  !(Array.isArray(field) && field.length === 0);

/** One field's values across a list's records, summarized. */
const fieldDigest = (values: readonly unknown[]) => {
  const present = values.filter(hasValue);
  const distinct = new Map(present.map((field) => [JSON.stringify(field), field]));
  const lengths = present.flatMap((field) =>
    typeof field === "string" || Array.isArray(field) ? [field.length] : [],
  );
  return {
    withValue: present.length,
    distinct: distinct.size,
    ...(lengths.length === 0 ? {} : { length: [Math.min(...lengths), Math.max(...lengths)] }),
    samples: [...distinct.values()].slice(0, sampleLimit).map(sampleOf),
  };
};


/**
 * A per-field digest of every list of records in the screened example output: for each field,
 * how many records hold a value (not null, absent or empty), how many distinct values there are,
 * the range of string lengths or list sizes, and a few samples. It covers every record, past the
 * part of a large output the review's envelope keeps, so publication review can judge each field
 * across the whole list without querying the output record by record.
 */
export const outputDigest = (output: unknown): string | undefined => {
  const lists = recordLists(output);
  if (lists.length === 0) return undefined;
  return JSON.stringify(
    {
      note: "Host-built from the screened example output: every record of each list, including any past the part example-output.json keeps. A nested list's path has [] (results[].offers): its records are those lists of every parent record combined, and parents counts the parent records that hold one. withValue counts records whose field is not null, absent or empty; length is the range of string lengths or list sizes.",
      lists: lists.map(({ path, records, parents }) => {
        const keys = [
          ...new Set(records.filter(isRecord).flatMap((record) => Object.keys(record))),
        ];
        return {
          path,
          records: records.length,
          ...(parents === undefined ? {} : { parents }),
          fields: Object.fromEntries(
            keys.map((key) => [
              key,
              fieldDigest(records.map((record) => (isRecord(record) ? record[key] : undefined))),
            ]),
          ),
        };
      }),
    },
    null,
    2,
  );
};

/** What the review is told about the digest, when the host writes one. */
export const outputDigestNote = `${outputDigestPath} summarizes every field of each list in the example output across all its records, including records past what ${exampleOutputPath} keeps.`;

/** The largest file a publication review's request carries inline. */
const inlineFileBytes = 16 * 1024;

/**
 * The files a publication review reads first that fit in its request, by path: the public
 * definition, the entrypoint, the output digest and a read example's output, each when it is
 * there and holds at most 16 KiB. A write session's output is never one of them.
 */
export const inlinePublicationPaths = (review: {
  readonly definition: string;
  readonly entrypoint: string;
  /** The bundle, by path without the `operation/` prefix. */
  readonly files: ReadonlyMap<string, string>;
  readonly digest?: string | undefined;
  readonly exampleOutput?: string | undefined;
}): readonly string[] =>
  [
    [publicDefinitionPath, review.definition],
    [`operation/${review.entrypoint}`, review.files.get(review.entrypoint) ?? ""],
    ...(review.digest === undefined ? [] : [[outputDigestPath, review.digest] as const]),
    [exampleOutputPath, review.exampleOutput ?? ""],
  ]
    .filter(([, text]) => text !== "" && Buffer.byteLength(text) <= inlineFileBytes)
    .map(([path]) => path);

/** What the review is told about the inline files, when the host sends any. */
export const inlineFilesNote =
  "Each file in trusted_publication.inline, by its path, is exactly as read_source returns it, a JSON file parsed; there is no need to read those again, and any other file is read as usual.";

const InlineChunk = Schema.Struct({ hasMore: Schema.Literal(false), source: Schema.String });
/**
 * Each listed publication file as one complete `read_source` chunk returns it, through the same
 * screen and publication gate, a JSON file parsed so the request shows it as JSON. A file whose
 * read fails or needs more than one chunk is left for Guardian to read itself.
 */
const inlinePublicationFiles = (readSource: ReviewTurn["readSource"], paths: readonly string[]) =>
  Effect.forEach(paths, (path) =>
    readSource(path, 0).pipe(
      Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(InlineChunk))),
      Effect.map(({ source }): NonNullable<PublicationScope["inline"]> => [
        {
          path,
          content: path.endsWith(".json")
            ? Option.getOrElse(decodeJson(source), () => source)
            : source,
        },
      ]),
      // error-reporting-allow: typed-recovery a file the host cannot inline is still in the index for Guardian to read
      Effect.orElseSucceed(() => []),
    ),
  ).pipe(Effect.map((files) => files.flat()));

/**
 * A publication review's request with the listed files that fit inline (`inlinePublicationPaths`),
 * read through the review's own `readSource`. Unchanged when none of them reads whole, or for a
 * review with no publication index.
 */
export const withInlineFiles = (
  pending: PendingExecution,
  readSource: ReviewTurn["readSource"],
  paths: readonly string[] | undefined,
) => {
  const { publication } = pending;
  return publication === undefined || paths === undefined
    ? Effect.succeed(pending)
    : inlinePublicationFiles(readSource, paths).pipe(
        Effect.map((inline): PendingExecution => {
          const scope: PublicationScope = { ...publication, inline };
          return inline.length === 0 ? pending : { ...pending, publication: scope };
        }),
      );
};

/** The largest count below `exceeds` that `fits`, or 0, for a `fits` that holds up to a point. */
const largestFitting = (exceeds: number, fits: (count: number) => boolean) => {
  let fitting = 0;
  let over = exceeds;
  while (over - fitting > 1) {
    const middle = Math.floor((fitting + over) / 2);
    if (fits(middle)) fitting = middle;
    else over = middle;
  }
  return fitting;
};

/** The top-level list of records whose JSON is largest, which a large output cuts first. */
const largestTopLevelList = (value: unknown) => {
  const largest = recordLists(value).toSorted(
    (one, other) =>
      byteLength(JSON.stringify(other.records)) - byteLength(JSON.stringify(one.records)),
  )[0];
  return largest === undefined || largest.path.includes("[].") ? undefined : largest;
};

/** `value` with the list at `path` (as `recordLists` names it) cut to its first `kept` items. */
const withListPrefix = (value: unknown, path: string, kept: number): unknown => {
  if (path === "[]") return Array.isArray(value) ? value.slice(0, kept) : value;
  const [head, ...rest] = path.split(".");
  if (head === undefined || !isRecord(value)) return value;
  return rest.length === 0
    ? { ...value, [head]: Array.isArray(value[head]) ? value[head].slice(0, kept) : value[head] }
    : { ...value, [head]: withListPrefix(value[head], rest.join("."), kept) };
};
/** A plain array or object, which `lineJson` splits; JSON.stringify writes anything else. */
const isPlainContainer = (value: unknown): value is object => {
  if (typeof value !== "object" || value === null) return false;
  if (typeof (value as { readonly toJSON?: unknown }).toJSON === "function") return false;
  if (Array.isArray(value)) return true;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** JSON.stringify's text, or undefined for undefined, a function or a symbol. */
const wholeJson = (value: unknown) => JSON.stringify(value) as string | undefined;

/**
 * `value` as compact JSON, with each object key outside a list item and each item of such a list
 * on its own line, down to the record's output and the levels `recordLists` finds lists at. An
 * item, and anything deeper, stays whole on one line as JSON.stringify writes it, so the text
 * without its newlines is JSON.stringify's. A later publication round then diffs a rerun of the
 * same output as the few lines that changed.
 */
const lineJson = (value: unknown, depth: number): string | undefined => {
  if (depth > 5 || !isPlainContainer(value)) return wholeJson(value);
  if (!Array.isArray(value)) return lineObject(value, depth);
  if (value.length === 0) return "[]";
  return `[\n${Array.from(value, (item: unknown) => wholeJson(item) ?? "null").join(",\n")}\n]`;
};
const lineObject = (value: object, depth = 0): string =>
  `{${Object.entries(value)
    .flatMap(([key, field]) => {
      const text = lineJson(field, depth + 1);
      return text === undefined ? [] : [`${JSON.stringify(key)}:${text}`];
    })
    .join(",\n")}}`;

/**
 * The host's record of an example's output in `state`, with `fields` after it, such as the
 * `reason` a host gives for an output it could not read (`unavailable`). The record is compact
 * JSON, so the 96 KiB limit keeps as many of the output's records as it can, with each field and
 * each record of a top-level list on its own line (`lineJson`).
 */
export const exampleOutputRecord = (
  source: ExampleOutputSource,
  state: ExampleOutputState,
  fields: Json = {},
): ExampleOutputEvidence => ({
  state,
  text: lineObject({
    kind: source.kind ?? "verified_example_output",
    executionId: source.executionId,
    executedEntrypoint: source.executedEntrypoint,
    ...(source.executedSourceDigest === undefined
      ? {}
      : { executedSourceDigest: source.executedSourceDigest }),
    state,
    ...fields,
  }),
});

/**
 * The actual validated output the example or the named act step returned, bound to the source
 * that ran. `output` is that output as the host's screening leaves it, as JSON text, and
 * undefined when the host kept none. The record holds it as JSON, never a JSON string inside
 * JSON, so the review reads its values as the caller will. `credentialFree` is the host's
 * credential precheck: it sees the whole record first, since a cut inside a URL-embedded
 * credential would leave an unmatched prefix, and the cut record again. A record that fails it is
 * withheld. One past 96 KiB keeps the first whole records of its largest top-level list, with
 * `truncation` saying how many, or else a prefix of the output text that ends on a code point.
 * The result's `screened` is the whole output, parsed, for `outputDigest`.
 */
export const exampleOutputEvidence = (
  source: ExampleOutputSource,
  output: string | undefined,
  credentialFree: (text: string) => Effect.Effect<boolean>,
): Effect.Effect<ExampleOutputEvidence> =>
  Effect.gen(function* () {
    if (output === undefined) return exampleOutputRecord(source, "not_retained");
    const withheld = exampleOutputRecord(source, "withheld", { reason: "credential_precheck" });
    const screenedBytes = byteLength(output);
    // The output as JSON inside its envelope, never a JSON string inside JSON, so the review
    // reads its values as the caller will.
    const parsed = parsedJson(output);
    const readable = parsed ?? output;
    const complete = exampleOutputRecord(source, "available", { screenedBytes, output: readable });
    // Readable screening keeps URLs byte-exact, so the precheck must see the complete output:
    // a truncation point inside a URL-embedded credential would leave an unmatched prefix.
    if (!(yield* credentialFree(complete.text))) return withheld;
    const withScreened = <A extends object>(result: A) =>
      parsed === undefined ? result : { ...result, screened: parsed };
    if (byteLength(complete.text) <= maximumEvidenceBytes) return withScreened(complete);
    // A large list keeps its first records whole; the digest covers the rest.
    const largest = largestTopLevelList(parsed);
    if (largest !== undefined) {
      const cutAt = (kept: number) =>
        exampleOutputRecord(source, "truncated", {
          screenedBytes,
          truncation: { list: largest.path, kept, records: largest.records.length },
          output: withListPrefix(parsed, largest.path, kept),
        });
      const fitting = largestFitting(
        largest.records.length,
        (kept) => byteLength(cutAt(kept).text) <= maximumEvidenceBytes,
      );
      if (fitting > 0) {
        const cut = cutAt(fitting);
        return (yield* credentialFree(cut.text)) ? withScreened(cut) : withheld;
      }
    }
    const truncatedAt = (length: number) =>
      exampleOutputRecord(source, "truncated", {
        screenedBytes,
        output: codePointPrefix(output, length),
      });
    // Every UTF-16 unit serializes to at least one byte, so the prefix is shorter than the bound.
    const truncated = truncatedAt(
      largestFitting(
        Math.min(output.length, maximumEvidenceBytes) + 1,
        (length) => byteLength(truncatedAt(length).text) <= maximumEvidenceBytes,
      ),
    );
    return (yield* credentialFree(truncated.text)) ? withScreened(truncated) : withheld;
  });

/**
 * The index of a publication review's evidence: every bundle file under `operation/`, then each
 * publication file. The bundle and the public definition ship; the other publication files are
 * evidence for the review only. A write session's act-step source is historical; everything
 * else is current. The minter wrote the bundle, except the bundle files a host adds itself
 * (`hostWritten`), and the host every publication file. `references` are the files the review
 * may read on demand beside its evidence, such as the minter's skills: listed apart, by byte
 * length, and never in `files`.
 */
export const publicationScope = (
  files: ReadonlyMap<string, string>,
  publicationFiles: ReadonlyMap<string, string>,
  options: {
    readonly hostWritten?: ReadonlySet<string>;
    readonly references?: ReadonlyMap<string, string>;
  } = {},
): PublicationScope => {
  const references = options.references ?? new Map<string, string>();
  return {
    ...(references.size === 0
      ? {}
      : {
          references: [...references].map(([path, text]) => ({
            path,
            byteLength: byteLength(text),
          })),
        }),
    files: [
      ...[...files].map(([path, source]) => ({
        path: `operation/${path}`,
        byteLength: byteLength(source),
        published: true,
        current: true,
        owner: options.hostWritten?.has(path) === true ? ("host" as const) : ("minter" as const),
      })),
      ...[...publicationFiles].map(([path, source]) => ({
        path,
        byteLength: byteLength(source),
        published: path === publicDefinitionPath,
        current: !path.startsWith(sessionStepsDirectory),
        owner: "host" as const,
      })),
    ],
  };
};

/**
 * A write session's evidence files: each act step's entrypoint and the modules it imports, in
 * order, under `publication/session/<step>/`. A step's workspace also held files it never ran.
 */
export const sessionEvidenceFiles = (
  steps: readonly { readonly entrypoint: string; readonly files: ReadonlyMap<string, string> }[],
): ReadonlyMap<string, string> =>
  new Map(
    steps.flatMap((step, index) =>
      [...entrypointImportClosure(step.files, step.entrypoint)].map(
        ([path, source]) => [sessionStepPath(index, path), source] as const,
      ),
    ),
  );

/**
 * A published schema as the review reads it: every keyword and value as published, each
 * reference with a constraint beside it moved into `allOf` (`withLoneReferences`). The published
 * text declares Draft-07, which ignores a bound Effect writes beside a reference, while the tool
 * and its callers apply it.
 */
const reviewedSchema = (schema: unknown): unknown =>
  isRecord(schema) ? withLoneReferences(schema) : schema;

/**
 * The public definition as Guardian reads it, at `publication/definition.json`: the build's name
 * and description, then its input and output schemas (`reviewedSchema`) and declared questions.
 */
export const publicDefinition = (
  metadata: { readonly name: string; readonly description: string },
  schemas: {
    readonly input: unknown;
    readonly output: unknown;
    readonly questions?: ScriptQuestionDeclarations;
  },
) =>
  JSON.stringify(
    {
      name: metadata.name,
      description: metadata.description,
      inputSchema: reviewedSchema(schemas.input),
      outputSchema: reviewedSchema(schemas.output),
      ...(schemas.questions === undefined ? {} : { questions: schemas.questions }),
    },
    null,
    2,
  );

/** What a publication is judged against: the read example that ran, or the write session. */
type PublicationExample =
  | {
      readonly kind: "read";
      /** The example's entrypoint, served under `executed/`. */
      readonly entrypoint: string;
      readonly completed: boolean;
      /** The source changed after the example ran, so the schemas were read again offline. */
      readonly schemasReadOffline?: boolean;
    }
  | {
      readonly kind: "write";
      readonly writeConfirmation: "message" | "readback" | "unverifiable";
      /** The session ran the agent's exampleInput because the caller sent none. */
      readonly intentDerived: boolean;
    };

/** What the review is told about its evidence, part of the notes the host gives it. */
export const publicationEvidenceNote = (example: PublicationExample) =>
  example.kind === "read"
    ? `The actual ${example.completed ? "completed" : "failed"} example used executed/${example.entrypoint}; its actual screened output and provenance are in ${exampleOutputPath}. Judge the declared capability claims against that output, not against exploratory probe observations. Its input/output contract was extracted from the imported operation before running the business action.${example.schemasReadOffline === true ? " The source changed after the example ran, so the host read the input and output schemas and questions again offline from current source and checked that the example's own input and output decode against them." : ""} Inspect its baseline and current source for schema compatibility. Publish only if the JSON schemas in publication/definition.json still describe the current operation.`
    : `This is a write build. Its one real write ran as the act session under publication/session/: step N's source is under publication/session/N/, in order, and ${sessionOutputPath} holds the screened output of the step named for publication. The composed operation was never run. The host extracted its input/output contract and declared write confirmation (${example.writeConfirmation}) offline from current source, and ${example.intentDerived ? "the input the session ran, the agent's exampleInput read from the request and the owner's answers because the caller sent none," : "the caller's own input"} decodes against it. Judge the composed script against the session steps, their outputs and the captures: it must reproduce the same flow from its input, perform and return the confirmation or read-back it declares, and never resubmit or commit twice. 'unverifiable' is valid only if the session evidence shows the site offered no commit response the script can check, no confirmation and no read-back. Each confirm popup must keep the session step's literal decideDialog step name. Do not call for another run of the write.`;

/** The authority a publication review grants: publish what is under review, run nothing. */
const publicationAllowedEffect =
  "Publish the current operation bundle, including the files the host adds to it, and the public definition only; do not execute the business action again.";

/**
 * The local host's Guardian call for a publication review: `files` is the bundle, `evidence` the
 * publication files with the definition first, and `baseline` the source a read example ran, under
 * `executed/`. It returns the review's ID once Guardian allows; a denial fails as `ReviewDenied`
 * with Guardian's reason and findings.
 */
export type PublicationReview = (request: {
  readonly entrypoint: string;
  readonly files: ReadonlyMap<string, string>;
  readonly allowedEffects: readonly string[];
  readonly notes: string;
  readonly baseline?: ReadonlyMap<string, string>;
  readonly evidence: ReadonlyMap<string, string>;
  /**
   * Files the review may read but that are not its evidence, such as the minter's skills at
   * `.agents/<name>/SKILL.md`. They stay out of the publication index, so no finding names one.
   */
  readonly references?: ReadonlyMap<string, string>;
}) => Effect.Effect<string, MintFailure>;

/** What one finish_build would publish, and the evidence it is reviewed against. */
export interface PublicationCandidate {
  readonly entrypoint: string;
  /** The bundle that would ship, by path, without the `operation/` prefix. */
  readonly files: ReadonlyMap<string, string>;
  /** `publicDefinition`'s text. */
  readonly definition: string;
  /** The output or session evidence; the definition goes before it. */
  readonly evidence: ReadonlyMap<string, string>;
  readonly baseline?: ReadonlyMap<string, string>;
  /** Host text the review reads after the build's observations. */
  readonly notes: string;
  /** The published input schema, as JSON Schema. */
  readonly inputSchema: unknown;
  /** The published output schema, as JSON Schema, which `requested` output fields are checked against. */
  readonly outputSchema?: unknown;
  /** The names the build's request declares in structure (`RequestedNames`). */
  readonly requested?: RequestedNames;
  /** The agent's exampleInput the example or the write session ran because the caller sent none. */
  readonly intentDerivedInput?: Json;
  readonly write: boolean;
  /** Files the review may read beside its evidence (see `PublicationReview`). */
  readonly references?: ReadonlyMap<string, string>;
}

/**
 * The property names an input schema lists at its root, with a root `$ref` resolved and every
 * `anyOf`, `oneOf` or `allOf` branch counted. Undefined when neither the root nor a branch has
 * `properties` at all, or a reference cannot be resolved, so there is nothing to check against.
 */
const listedInputKeys = (schema: unknown) => {
  if (typeof schema !== "object" || schema === null) return undefined;
  let root: Record<string, unknown>;
  try {
    root = inlineLocalRefs({ ...schema });
  } catch (error) {
    if (error instanceof UnresolvedSchemaReference) return undefined;
    throw error;
  }
  const branches = [
    root,
    ...["anyOf", "oneOf", "allOf"].flatMap((key) => {
      const listed = root[key];
      return Schema.is(Schema.Array(Schema.Unknown))(listed) ? listed : [];
    }),
  ];
  const listings = branches.flatMap((branch) =>
    typeof branch === "object" && branch !== null && "properties" in branch
      ? [branch.properties]
      : [],
  );
  // A no-input tool's empty properties lists nothing, so every example key is missing from it.
  return listings.length === 0
    ? undefined
    : new Set(
        listings.flatMap((properties: unknown) =>
          typeof properties === "object" && properties !== null ? Object.keys(properties) : [],
        ),
      );
};

/**
 * The keys of the agent's `exampleInput` that the published input schema does not list: values
 * the tool fixes itself. None when the schema lists nothing to check against.
 */
export const unlistedExampleInputKeys = (
  inputSchema: unknown,
  intentDerivedInput: Json | undefined,
): readonly string[] => {
  const listed = listedInputKeys(inputSchema);
  return listed === undefined
    ? []
    : Object.keys(intentDerivedInput ?? {}).filter((key) => !listed.has(key));
};

/**
 * The host's own input feedback on an allowed candidate whose example or write session ran
 * `unlisted` keys, as an `example_input` finding at the definition's input schema.
 */
export const exampleInputFeedback = (
  candidate: { readonly definition: string; readonly write: boolean },
  unlisted: readonly string[],
  reviewId: string,
) => requestedNamesFeedback(candidate, { unlisted, inputs: [], outputs: [] }, reviewId);

/**
 * The names a build's request declares in structure, which the published schemas must hold. The
 * request's own words are prose and declare nothing here; the publication review judges them.
 */
export interface RequestedNames {
  /** The caller's own input as the effective task holds it: each top-level key names an input. */
  readonly input?: unknown;
  /** Output fields the task's updates declared, as paths such as `price.amount` or `items[].currency`. */
  readonly outputs?: readonly string[];
}

/**
 * The output fields a task's accepted updates declare, in order: each one an update added,
 * tightened or loosened but kept, less any a later update removed.
 */
export const requestedOutputFields = (
  updates: readonly { readonly changes: readonly TaskChange[] }[],
): readonly string[] => {
  const fields: string[] = [];
  for (const { changes } of updates)
    for (const change of changes) {
      if (change.setting !== "output") continue;
      const at = fields.indexOf(change.field);
      if (change.change === "remove") {
        if (at >= 0) fields.splice(at, 1);
      } else if (at < 0) fields.push(change.field);
    }
  return fields;
};

const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether a schema declares the field at `path`, its parts split on `.`, a part ending in `[]`
 * naming a list whose items hold the rest. Each union branch counts. Undefined when the schema
 * cannot answer: a node on the way declares no properties at all, such as a free-form object, or
 * takes keys it does not list, as a map does, or a reference does not resolve.
 */
const declaresPath = (schema: unknown, path: string): boolean | undefined => {
  if (!isJson(schema)) return undefined;
  let root: Json;
  try {
    root = inlineLocalRefs({ ...schema });
  } catch (error) {
    if (error instanceof UnresolvedSchemaReference) return undefined;
    throw error;
  }
  const branches = (node: unknown): Json[] => {
    if (!isJson(node)) return [];
    const union = ["anyOf", "oneOf", "allOf"].flatMap((key) => {
      const listed = node[key];
      return Array.isArray(listed) ? listed : [];
    });
    return [node, ...union.flatMap(branches)];
  };
  const visit = (node: unknown, parts: readonly string[]): boolean | undefined => {
    const [part, ...rest] = parts;
    if (part === undefined) return true;
    const list = part.endsWith("[]");
    const key = list ? part.slice(0, -2) : part;
    const listings = branches(node).flatMap((branch) =>
      isJson(branch["properties"]) ? [branch["properties"]] : [],
    );
    if (listings.length === 0) return undefined;
    const children = listings.flatMap((properties) =>
      Object.hasOwn(properties, key) ? [properties[key]] : [],
    );
    // A map, such as a record keyed by the site's own field names, may hold any key.
    if (children.length === 0)
      return branches(node).some(
        (branch) =>
          (branch["additionalProperties"] !== undefined &&
            branch["additionalProperties"] !== false) ||
          branch["patternProperties"] !== undefined,
      )
        ? undefined
        : false;
    const next = list
      ? children.flatMap((child) => branches(child).map((branch) => branch["items"]))
      : children;
    const found = next.map((child) => visit(child, rest));
    return found.includes(true) ? true : found.includes(undefined) ? undefined : false;
  };
  return visit(root, path.split(".").filter((part) => part !== ""));
};

/**
 * The names the request declares that the published schemas lack: each top-level key of the
 * caller's own input the input schema does not list, and each requested output field the output
 * schema does not declare. A name a schema cannot answer for is never reported.
 */
export const missingRequestedNames = (
  schemas: { readonly input: unknown; readonly output: unknown },
  requested: RequestedNames,
): { readonly inputs: readonly string[]; readonly outputs: readonly string[] } => ({
  inputs: isJson(requested.input)
    ? Object.keys(requested.input).filter((key) => declaresPath(schemas.input, key) === false)
    : [],
  outputs: (requested.outputs ?? []).filter(
    (field) => declaresPath(schemas.output, field) === false,
  ),
});

/** The byte range of a top-level key of the public definition, such as `"inputSchema"`. */
const definitionKey = (definition: string, key: string) => {
  const quoted = JSON.stringify(key);
  const byteStart = byteLength(definition.slice(0, Math.max(0, definition.indexOf(quoted))));
  return { byteStart, byteEnd: byteStart + byteLength(quoted) };
};

const quotedList = (names: readonly string[]) => names.map((name) => JSON.stringify(name)).join(", ");

/**
 * The host's feedback on an allowed candidate whose schemas miss what the build ran or its request
 * declares: `unlisted` example keys and `inputs` the caller's request named, as `example_input`
 * findings at the input schema, input feedback alone; and requested `outputs`, a `schema_mismatch`
 * at the output schema that makes the whole a source correction. Each says to support the name or
 * end the build blocked, never to drop it.
 */
export const requestedNamesFeedback = (
  candidate: { readonly definition: string; readonly write: boolean },
  missing: {
    readonly unlisted: readonly string[];
    readonly inputs: readonly string[];
    readonly outputs: readonly string[];
  },
  reviewId: string,
) => {
  const ran = candidate.write ? "write session" : "example";
  const inputText = [
    ...(missing.unlisted.length === 0
      ? []
      : [
          `The ${ran} ran with ${quotedList(missing.unlisted)} in its exampleInput, which the input schema does not list, so the tool fixes that value itself. Make each an input property.`,
        ]),
    ...(missing.inputs.length === 0
      ? []
      : [
          `The caller's request names the input ${quotedList(missing.inputs)}, which the input schema does not list, so the tool drops what the caller supplies there. Make each an input property the tool applies, or end the build with report_blocked saying why the site cannot take it; never leave it out.`,
        ]),
  ].join(" ");
  const outputText =
    missing.outputs.length === 0
      ? ""
      : `The task's updates declare the output ${quotedList(missing.outputs)}, which the output schema does not declare. Return each as the update says, or end the build with report_blocked saying why the site does not show it; never leave it out.`;
  const rationale = [inputText, outputText].filter((text) => text !== "").join(" ");
  return new MintFailure({
    code: "ReviewDenied",
    review: {
      outcome: "deny",
      reason: outputText === "" ? "input_feedback" : "source_correction",
      reviewId,
      rationale,
      findings: [
        ...(inputText === ""
          ? []
          : [
              {
                path: publicDefinitionPath,
                ...definitionKey(candidate.definition, "inputSchema"),
                category: "example_input" as const,
                explanation: inputText,
              },
            ]),
        ...(outputText === ""
          ? []
          : [
              {
                path: publicDefinitionPath,
                ...definitionKey(candidate.definition, "outputSchema"),
                category: "schema_mismatch" as const,
                explanation: outputText,
              },
            ]),
      ],
    },
  });
};

/**
 * Runs the publication review and returns the allowing review's ID. An intent-derived example
 * input key the published schema does not list is a value the tool fixes itself, and an input the
 * caller's request named that it does not list is one the tool drops: once Guardian allows, each
 * comes back as the host's own input feedback on the reviewed candidate, so, like Guardian's, the
 * minter gets rounds to fix it. A requested output field the output schema lacks comes back the
 * same way as a source correction.
 */
export const reviewPublication = (review: PublicationReview, candidate: PublicationCandidate) =>
  Effect.gen(function* () {
    const unlisted = unlistedExampleInputKeys(candidate.inputSchema, candidate.intentDerivedInput);
    const missing = missingRequestedNames(
      { input: candidate.inputSchema, output: candidate.outputSchema },
      candidate.requested ?? {},
    );
    const reviewId = yield* review({
      entrypoint: candidate.entrypoint,
      files: candidate.files,
      allowedEffects: [publicationAllowedEffect],
      notes: candidate.notes,
      ...(candidate.baseline === undefined ? {} : { baseline: candidate.baseline }),
      evidence: new Map([[publicDefinitionPath, candidate.definition], ...candidate.evidence]),
      ...(candidate.references === undefined ? {} : { references: candidate.references }),
    });
    if (unlisted.length === 0 && missing.inputs.length === 0 && missing.outputs.length === 0)
      return reviewId;
    return yield* requestedNamesFeedback(candidate, { unlisted, ...missing }, reviewId);
  });
