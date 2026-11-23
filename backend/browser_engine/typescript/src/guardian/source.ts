import { posix } from "node:path";
import { Effect } from "effect";
import { failureDetail } from "../runtime/failure-detail.js";
import { sourceChunkOf } from "./review-layout.js";
import { ReviewFailure } from "./review.js";
import type { ReviewTurn } from "./review.js";

/** A read at an offset the model supplied that no chunk can start at; context holds only it. */
const offsetFailure = (
  operation: "guardian.source.offset_invalid" | "guardian.source.offset_mid_character",
  offset: number,
) =>
  new ReviewFailure({
    code: "SourceUnavailable",
    failureDetail: failureDetail("invalid_input", { operation, context: { offset } }),
  });

export type SourceProjection = (
  path: string,
  bytes: Uint8Array,
) => Effect.Effect<string, ReviewFailure>;
export const sourceChunk = (
  path: string,
  text: string,
  offset: number,
): Effect.Effect<string, ReviewFailure> =>
  Effect.gen(function* () {
    if (!Number.isSafeInteger(offset) || offset < 0)
      return yield* offsetFailure("guardian.source.offset_invalid", offset);
    const screened = { text };
    // Offsets address the screened UTF-8 view, not raw private source bytes.
    const visible = new TextEncoder().encode(screened.text);
    // A read at or past the end is the empty final chunk, not a failure: models sometimes
    // precompute offsets and read one chunk beyond the last.
    if (offset >= visible.byteLength)
      return JSON.stringify({
        kind: "untrusted_source",
        path,
        byteOffset: visible.byteLength,
        nextOffset: visible.byteLength,
        hasMore: false,
        source: "",
      });
    if (((visible[offset] ?? 0) & 0xc0) === 0x80)
      return yield* offsetFailure("guardian.source.offset_mid_character", offset);
    let nextOffset = Math.min(offset + 64 * 1024, visible.byteLength);
    while (nextOffset > offset && ((visible[nextOffset] ?? 0) & 0xc0) === 0x80) nextOffset--;
    return JSON.stringify({
      kind: "untrusted_source",
      path,
      byteOffset: offset,
      nextOffset,
      hasMore: nextOffset < visible.byteLength,
      source: new TextDecoder().decode(visible.subarray(offset, nextOffset)),
    });
  });
export const makeSourceInspector =
  (
    read: (path: string) => Effect.Effect<Uint8Array, ReviewFailure>,
    project: SourceProjection,
  ): ReviewTurn["readSource"] =>
  (path, offset) =>
    Effect.gen(function* () {
      if (!Number.isSafeInteger(offset) || offset < 0)
        return yield* offsetFailure("guardian.source.offset_invalid", offset);
      const bytes = yield* read(path);
      const text = yield* project(path, bytes);
      return yield* sourceChunk(path, text, offset);
    });

/** The most chunks of one file the host reads to anchor a quote or answer a query: 4 MiB. */
const wholeSourceChunks = 64;

/** A file's screened text up to 4 MiB, and whether that is the whole file. */
const sourceUpToBound = (
  read: ReviewTurn["readSource"],
  path: string,
): Effect.Effect<{ readonly text: string; readonly complete: boolean }, ReviewFailure> =>
  Effect.gen(function* () {
    let text = "";
    let offset = 0;
    for (let index = 0; index < wholeSourceChunks; index++) {
      const chunk = sourceChunkOf(yield* read(path, offset));
      const source = chunk?.value["source"];
      if (chunk === undefined || typeof source !== "string")
        return yield* new ReviewFailure({ code: "SourceUnavailable" });
      text += source;
      if (!chunk.hasMore || chunk.nextOffset <= offset) return { text, complete: true };
      offset = chunk.nextOffset;
    }
    return { text, complete: false };
  });

/**
 * A file's whole screened text through a reviewer's chunked reader: what Guardian would see by
 * following `nextOffset`, up to 4 MiB.
 */
export const wholeSource = (
  read: ReviewTurn["readSource"],
  path: string,
): Effect.Effect<string, ReviewFailure> =>
  sourceUpToBound(read, path).pipe(Effect.map(({ text }) => text));

/**
 * A file's whole screened text, or undefined when it is longer than the 4 MiB the host reads, so
 * a caller comparing files never mistakes a prefix for the file.
 */
export const completeSource = (
  read: ReviewTurn["readSource"],
  path: string,
): Effect.Effect<string | undefined, ReviewFailure> =>
  sourceUpToBound(read, path).pipe(
    Effect.map(({ text, complete }) => (complete ? text : undefined)),
  );

/** `text` as a pattern that matches it literally. */
export const literalPattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const utf8Length = (text: string) => new TextEncoder().encode(text).byteLength;
const lowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/** Characters kept on each side of a query's match, and the most slices one query returns. */
const matchContext = 300;
const maximumMatches = 20;

/**
 * The slices of a file around each case-insensitive occurrence of `match`, each with the UTF-8
 * byte offset it starts at, so Guardian can query a large capture rather than read it whole.
 * Overlapping slices merge; past 20 slices the result says how many matches there were.
 */
export const sourceMatches = (read: ReviewTurn["readSource"], path: string, match: string) =>
  wholeSource(read, path).pipe(
    Effect.map((text) => {
      const slices: { start: number; end: number }[] = [];
      let matchCount = 0;
      for (const found of text.matchAll(new RegExp(literalPattern(match), "giu"))) {
        matchCount++;
        let start = Math.max(0, found.index - matchContext);
        let end = Math.min(text.length, found.index + found[0].length + matchContext);
        // Never split a surrogate pair, so each slice and its offset are whole characters.
        if (lowSurrogate(text.charCodeAt(start))) start--;
        if (lowSurrogate(text.charCodeAt(end))) end++;
        const last = slices.at(-1);
        if (last !== undefined && start <= last.end) last.end = Math.max(last.end, end);
        else if (slices.length < maximumMatches) slices.push({ start, end });
      }
      return JSON.stringify({
        kind: "untrusted_source_matches",
        path,
        match,
        byteLength: utf8Length(text),
        matchCount,
        matches: slices.map(({ start, end }) => ({
          byteOffset: utf8Length(text.slice(0, start)),
          source: text.slice(start, end),
        })),
      });
    }),
  );

/** SDK files as Guardian's view keys them, and the module Node loads for `opengpt-browser-engine/runtime`. */
export interface SdkFiles {
  readonly files: ReadonlyMap<string, string>;
  readonly runtimeEntry: string | undefined;
}

/** The bare import an authored tool uses for the package's tool API. */
const runtimePackageImport = "opengpt-browser-engine/runtime";
/** The module `opengpt-browser-engine/runtime` names, among the package's runtime modules under `opengpt-browser-engine/`. */
const runtimePackageEntry = "opengpt-browser-engine/browser/index.js";

/**
 * Guardian's view of an operation as its execution loads it: the SDK at its own path and the
 * operation's files under `operation/`. Guardian may ask for the SDK a tool imports as
 * `../../runtime/index.js` under `operation/` too; an operation file of its own at that path
 * still wins. When the SDK holds the package's runtime modules under `opengpt-browser-engine/`, a bare
 * `opengpt-browser-engine/runtime` reads the module that import loads.
 */
export const operationReviewSources = (
  sdkFiles: ReadonlyMap<string, string>,
  files: ReadonlyMap<string, string>,
) => {
  const sources = new Map(sdkFiles);
  const runtimeEntry = sdkFiles.get(runtimePackageEntry);
  if (runtimeEntry !== undefined) sources.set(runtimePackageImport, runtimeEntry);
  for (const [path, source] of [...sources]) sources.set(`operation/${path}`, source);
  for (const [path, source] of files) sources.set(`operation/${path}`, source);
  return sources;
};

/**
 * Whether a review path names a file the host ships: one of its SDK files, at its own path or
 * under `operation/`, or the bare `opengpt-browser-engine/runtime` when it ships the package's runtime modules.
 * Its reviews always hold those files, so a failed read of one is the host's gap; any other path,
 * an SDK folder's included, is one the agent wrote or Guardian guessed, and stays Guardian's to
 * judge.
 */
export const hostProvidedSource =
  (sdkFiles: ReadonlyMap<string, string>) =>
  (path: string): boolean => {
    const sdkPath = path.replace(/^operation\//u, "");
    return (
      sdkFiles.has(sdkPath) ||
      (sdkPath === runtimePackageImport && sdkFiles.has(runtimePackageEntry))
    );
  };

/** The SDK's folders: the built SDK's, the public package's, and `opengpt-browser-engine/` for its modules. */
const sdkFolder = /^(?:(?:runtime|browser|testing)\/|node_modules\/opengpt-browser-engine\/|opengpt-browser-engine\/)/u;

/**
 * The JavaScript an SDK path spelled as TypeScript names: `opengpt-browser-engine/runtime/operation.ts` or
 * `.d.ts` is `opengpt-browser-engine/runtime/operation.js`, the module that runs. Undefined for any other path,
 * so an authored TypeScript file is read as written.
 */
export const sdkJavaScriptPath = (path: string): string | undefined =>
  sdkFolder.test(path.replace(/^operation\//u, "")) && /\.ts$/u.test(path)
    ? path.replace(/(?:\.d)?\.ts$/u, ".js")
    : undefined;

/**
 * Where to read instead, for a path under an SDK folder that names no SDK file, such as a guessed
 * layout: the module Node loads for `opengpt-browser-engine/runtime`, and the one SDK module with the same file
 * name when only one has it. Any other path has none, so a missing authored file still fails.
 */
export const sdkReference = (sdk: SdkFiles) => {
  const byName = new Map<string, string[]>();
  for (const path of sdk.files.keys())
    if (path.endsWith(".js"))
      byName.set(posix.basename(path), [...(byName.get(posix.basename(path)) ?? []), path]);
  return (requested: string) => {
    const path = requested.replace(/^operation\//u, "").replace(/(?:\.d)?\.ts$/u, ".js");
    if (!sdkFolder.test(path) || sdk.files.has(path)) return undefined;
    const sameName = byName.get(posix.basename(path)) ?? [];
    return {
      kind: "host_sdk_reference",
      state: "not_an_sdk_file",
      ...(sdk.runtimeEntry === undefined
        ? {}
        : { runtimeEntry: sdk.runtimeEntry, resolvedFrom: "opengpt-browser-engine/runtime" }),
      ...(sameName.length === 1 ? { sameFileName: sameName[0] } : {}),
    };
  };
};

/** A host-authored answer in place of a file's content: one chunk, with nothing more to read. */
export const hostReference = (path: string, reference: object) =>
  JSON.stringify({
    kind: "untrusted_source",
    path,
    byteOffset: 0,
    nextOffset: 0,
    hasMore: false,
    source: JSON.stringify(reference),
  });
