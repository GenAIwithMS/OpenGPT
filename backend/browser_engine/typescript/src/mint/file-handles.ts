import { Effect, Schema } from "effect";
import type { SourceFile } from "../runtime/file-transfer.js";
import { isAuthoredSourcePath } from "./operation-source.js";

/**
 * A file in the caller's input reaches the minting model as a handle, `{{file.fN}}`, with its
 * name, media type and size, never its bytes or the caller's reference. The build's input holds
 * the handle wherever the reference stood, so the operation's code passes it to `files.place` as
 * it would a caller's reference, and the host resolves it to the caller's file only there, in a
 * live step. Authored source never holds a handle: the file comes from the input, so a handle
 * anywhere in source refuses the step and the publication.
 */

const handleShape = /\{\{\s*file\./u;

/** Whether text holds a file handle or anything shaped like one. */
export const holdsFileHandle = (text: string) => handleShape.test(text);

/** A caller's file as the minting model sees it. */
export const MintFile = Schema.Struct({
  handle: Schema.String,
  name: Schema.String,
  media_type: Schema.String,
  size: Schema.NonNegativeInt,
});
export type MintFile = typeof MintFile.Type;

/** The handles one build issued, and the caller's reference behind each. */
export interface FileHandles {
  /** The files as the model sees them. */
  readonly files: readonly MintFile[];
  /** The caller's reference behind an issued handle, else undefined. */
  readonly resolve: (handle: string) => string | undefined;
}

/**
 * The caller's input with each file reference replaced by a new handle, and the handles. A
 * reference is any string `isReference` accepts; `open` reads its metadata, never its bytes. The
 * same reference twice gets one handle.
 */
export const issueFileHandles = (
  input: unknown,
  isReference: (value: string) => boolean,
  open: (reference: string) => Effect.Effect<SourceFile, Error>,
): Effect.Effect<{ readonly input: unknown; readonly handles: FileHandles }, Error> =>
  Effect.gen(function* () {
    const references = new Map<string, string>();
    const files: MintFile[] = [];
    const replace = (value: unknown): Effect.Effect<unknown, Error> =>
      Effect.gen(function* () {
        if (typeof value === "string" && isReference(value)) {
          const known = references.get(value);
          if (known !== undefined) return known;
          const source = yield* open(value);
          const handle = `{{file.f${files.length + 1}}}`;
          references.set(value, handle);
          files.push({ handle, name: source.name, media_type: source.media_type, size: source.size });
          return handle;
        }
        if (Array.isArray(value)) return yield* Effect.forEach(value, replace);
        if (typeof value === "object" && value !== null) {
          const entries = yield* Effect.forEach(Object.entries(value), ([key, item]) =>
            replace(item).pipe(Effect.map((replaced) => [key, replaced] as const)),
          );
          return Object.fromEntries(entries);
        }
        return value;
      });
    const replaced = yield* replace(input);
    const byHandle = new Map([...references].map(([reference, handle]) => [handle, reference]));
    return { input: replaced, handles: { files, resolve: (handle) => byHandle.get(handle) } };
  });

/**
 * Why a live step is refused before review for a file handle in its source, if it is. The step's
 * input already holds each handle where the caller's file stood, so code reads it from there.
 */
export const fileHandleRefusal = (
  files: ReadonlyMap<string, string>,
  step: { readonly target: string },
): string | undefined => {
  if (step.target !== "liveBrowser") return undefined;
  const path = [...files].find(
    ([candidate, source]) => isAuthoredSourcePath(candidate) && holdsFileHandle(source),
  )?.[0];
  return path === undefined
    ? undefined
    : `${path} holds a {{file.…}} handle. A caller's file reaches the tool only through its input, which already holds the handle where the file stood: type that field as FileInput and pass the input's value to files.place, never the handle written in source. Nothing was executed.`;
};
