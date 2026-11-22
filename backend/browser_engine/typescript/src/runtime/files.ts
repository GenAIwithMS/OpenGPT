import { Data, Schema } from "effect";
import type { Effect } from "effect";

/**
 * Files in an operation's contract. A file never travels as bytes in an input, an output, a
 * script's code or its result. An input holds a reference the host resolves (`FileInput`); the
 * script hands it to `files.place`, and the host writes the bytes onto the browser's machine and
 * into the page's file input. A download the page starts is collected by the host
 * (`files.collect`), which keeps the bytes and gives the script a `FileOutput` to return.
 *
 * In an operation's published JSON Schema, every file field carries `format: "file"`: an input's
 * is a string reference, an output's an object with one `$file` property.
 */
export const fileFormat = "file";

/** The longest reference a host resolves. */
export const fileReferenceMaxLength = 2048;

/**
 * A caller's file, as an operation's input holds it: a reference the host resolves, such as an
 * upload handle. The script never reads the bytes; it passes the reference to `files.place`.
 */
export const FileInput = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(fileReferenceMaxLength),
).annotations({
  title: "File",
  description: "A file reference the host resolves, such as an upload handle",
  jsonSchema: { format: fileFormat },
});

/** A file name as hosts report it: one path segment, no control characters. */
export const FileName = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(255),
  Schema.filter((name) => !/[/\\\p{Cc}]/u.test(name) && name !== "." && name !== "..", {
    message: () => "a file name is one path segment without control characters",
  }),
);

/** A media type, `type/subtype` with optional parameters dropped. */
export const MediaType = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u),
);

/**
 * A file a run produced, as its output holds it. `id` names it at the host. `download_url`, when
 * the host serves the bytes, is where the caller fetches them, until `expires_at` when it expires.
 */
export const FileFields = Schema.Struct({
  id: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)),
  name: FileName,
  media_type: MediaType,
  size: Schema.NonNegativeInt,
  sha256: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/u)),
  download_url: Schema.optionalWith(Schema.String.pipe(Schema.maxLength(8192)), { exact: true }),
  expires_at: Schema.optionalWith(Schema.String.pipe(Schema.maxLength(64)), { exact: true }),
});
export type FileFields = typeof FileFields.Type;

/** An output field holding a file the run collected: `{ "$file": { id, name, ... } }`. */
export const FileOutput = Schema.Struct({ $file: FileFields }).annotations({
  title: "File",
  description: "A file the run downloaded; the host serves its bytes",
  jsonSchema: { format: fileFormat },
});
export type FileObject = typeof FileOutput.Type;

/** What `files.place` reports once the page's file input holds the file. */
export interface PlacedFile {
  readonly name: string;
  readonly media_type: string;
  readonly size: number;
}
export const PlacedFile = Schema.Struct({
  name: FileName,
  media_type: MediaType,
  size: Schema.NonNegativeInt,
});

/** Byte caps a host sets for files; `defaultFileLimits` unless the host chooses others. */
export interface FileLimits {
  /** The most bytes one file may hold. */
  readonly fileBytes: number;
  /** The most files a run may place and collect together. */
  readonly runFiles: number;
  /** The most bytes a run's placed and collected files may hold together. */
  readonly runBytes: number;
}
export const defaultFileLimits: FileLimits = {
  fileBytes: 25 * 1024 * 1024,
  runFiles: 10,
  runBytes: 50 * 1024 * 1024,
};

/**
 * Why the host refused a file. Never names the file's contents.
 *
 * - `unknown_reference`: the reference is not one of this run's files.
 * - `unavailable`: the host could not read, write or set the file.
 * - `too_large`: the file is larger than the host's per-file cap.
 * - `run_limit`: the run already placed or collected as many files, or bytes, as the host allows.
 * - `type_mismatch`: the file's bytes are not of the type it declares.
 * - `executable`: the file is a program.
 * - `not_accepted`: the file input's `accept` attribute does not take the file.
 * - `field_not_found`: the field locator matched no element, or more than one.
 * - `not_file_input`: the field is not a file input.
 * - `other_site`: the field's page is not on the tool's site.
 * - `no_download`: no download finished within the wait.
 * - `not_collected`: an output names a file this run did not collect.
 */
export const FileRefusalReason = Schema.Literal(
  "unknown_reference",
  "unavailable",
  "too_large",
  "run_limit",
  "type_mismatch",
  "executable",
  "not_accepted",
  "field_not_found",
  "not_file_input",
  "other_site",
  "no_download",
  "not_collected",
);
export type FileRefusalReason = typeof FileRefusalReason.Type;

/**
 * The host refused a file. `dispatched` is set when the refusal came after the host set the file
 * input, or may have, so an upload may have started; every other refusal reached no page.
 */
export class FileRefused extends Data.TaggedError("FileRefused")<{
  readonly reason: FileRefusalReason;
  readonly dispatched?: true;
}> {
  override get message() {
    return `The host refused the file: ${this.reason}`;
  }
}

/**
 * Which file input `files.place` fills, as data the host turns into a locator on the page: the
 * input's accessible label (`getByLabel`, exact unless `exact` is false), or a Playwright selector
 * such as `input[type=file][name=receipt]`. Never code.
 */
export type FileField =
  | { readonly label: string; readonly exact?: boolean }
  | { readonly selector: string };
export const FileField = Schema.Union(
  Schema.Struct({
    label: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1000)),
    exact: Schema.optionalWith(Schema.Boolean, { exact: true }),
  }),
  Schema.Struct({ selector: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2000)) }),
);

/**
 * The run's file service, as the runner binds it into a script's context. The host implements it
 * outside the script's process (`makeRunFiles`), so bytes never reach the script.
 */
export interface FileChannel {
  /**
   * Puts the file `reference` names into the one file input `field` names, and reports what the
   * input now holds.
   */
  readonly place: (request: {
    readonly reference: string;
    readonly field: FileField;
    readonly timeoutSec: number;
  }) => Effect.Effect<PlacedFile, FileRefused>;
  /** Starts capturing downloads; the returned slot names this capture. */
  readonly arm: () => Effect.Effect<string, FileRefused>;
  /** Waits for the slot's first finished download and keeps it for the caller. */
  readonly collect: (request: {
    readonly slot: string;
    readonly timeoutMs: number;
  }) => Effect.Effect<FileObject, FileRefused>;
}

/** The context's `files`: what an operation's script calls. */
export interface ScriptFiles {
  /**
   * Puts the caller's file into one file input on the tool's site and returns what the input now
   * holds. `reference` is the input's `FileInput` value, passed as given. `field` names the
   * `<input type="file">` as data, `{ label: "Receipt" }` or `{ selector: "input[name=receipt]" }`;
   * a hidden input is fine. In one page call the host finds that element, checks it is one file
   * input whose frame is on the tool's site and whose `accept` takes the file, and only then sets
   * it. It refuses a reference that is not one of this run's files, a file over its caps, bytes
   * that are not of the declared type, a program, and each failed check; a refusal the caller's
   * file caused throws `InvalidInput`, any other `OperationFailure`. Choosing a file can start an
   * upload, so a run that placed a file may have sent it. Never read a placed file back.
   */
  readonly place: (
    reference: string,
    options: { readonly field: FileField; readonly timeoutSec?: number },
  ) => Promise<PlacedFile>;
  /**
   * Runs `trigger`, the script's own execute calls that make the page start one download (a
   * click on an export link), with the host capturing downloads, and returns the downloaded
   * file for the output once it finished. It waits up to `timeoutMs` (30 s by default) after
   * the trigger for the download to finish. The bytes stay with the host; the returned object
   * carries only the file's metadata and sha256, and is returned as an output `FileOutput`. A
   * download over the host's per-file cap, or over what the run's caps leave, throws an
   * `OperationFailure` that names the cap, never `InvalidInput`: the page made the file, so the
   * limit is the host's and the caller has no other file to send.
   */
  readonly collect: (
    trigger: () => Promise<unknown>,
    options?: { readonly timeoutMs?: number },
  ) => Promise<FileObject>;
}

/** Whether `value` is shaped like a `FileOutput`, the only shape an output file takes. */
export const isFileObject = (value: unknown): value is FileObject =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.prototype.hasOwnProperty.call(value, "$file");
