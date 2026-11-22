import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Effect, Either, Ref, Schema } from "effect";
import type { BrowserExecute } from "./browser-execution.js";
import { acceptsSource, bytesMatchType, isProgram, sniffedType } from "./file-types.js";
import {
  defaultFileLimits,
  FileField,
  FileName,
  FileRefused,
  isFileObject,
  MediaType,
  type FileChannel,
  type FileLimits,
  type FileObject,
  type FileRefusalReason,
  type PlacedFile,
} from "./files.js";
import { hostOnSiteSource, siteDomain } from "./same-site.js";

/** A caller's file as the host found it: its metadata now, its bytes when read. */
export interface SourceFile {
  readonly name: string;
  /** The declared media type, or the one the name implies. */
  readonly media_type: string;
  readonly size: number;
  /** All the file's bytes; the host reads them only once the file passed the size caps. */
  readonly read: Effect.Effect<Uint8Array, Error>;
}

/** A finished download a host read back from the browser's machine. */
export type TakenDownload =
  | {
      readonly name: string;
      readonly bytes: Uint8Array;
      /** The `Content-Type` the server sent with the download, when the host saw it. */
      readonly media_type?: string;
    }
  /** The download is larger than the most the host may read. */
  | { readonly tooLarge: true };

/**
 * Where a host keeps file bytes; it implements this and `makeRunFiles` does the rest. The browser's
 * machine is wherever the page's Playwright code runs: the local machine for the native browser, a
 * browser VM for a hosted browser, reached through its filesystem API. Bytes never pass through a
 * script's code, its result or the script's own process.
 */
export interface FileHostHook {
  /** The caller's file a reference names. Fails when there is none. */
  readonly open: (reference: string) => Effect.Effect<SourceFile, Error>;
  /**
   * Writes bytes onto the browser's machine as a file named exactly `name`, in a directory no other
   * file uses, and returns its absolute path there, which the page's `setInputFiles` reads.
   */
  readonly writeToBrowser: (file: {
    readonly name: string;
    readonly bytes: Uint8Array;
  }) => Effect.Effect<string, Error>;
  /**
   * Directs the browser's downloads into a new directory only this capture uses and returns a
   * slot naming it. A hosted browser sets its download directory (Chromium's
   * `Browser.setDownloadBehavior`); the native browser saves each download Playwright reports.
   */
  readonly armDownloads: () => Effect.Effect<string, Error>;
  /**
   * The first download that finished in the slot, waiting up to `timeoutMs`, with its suggested
   * name, its bytes, never more than `maxBytes` of them, and the server's `Content-Type` when the
   * host saw it; undefined when none finished in time. It ends the slot's capture either way.
   * The file's type comes from its first bytes, else that `Content-Type`, never its name.
   */
  readonly takeDownload: (
    slot: string,
    bounds: { readonly timeoutMs: number; readonly maxBytes: number },
  ) => Effect.Effect<TakenDownload | undefined, Error>;
  /**
   * Keeps a collected file for the run's caller and returns its id, and when the host serves the
   * bytes, where and until when.
   */
  readonly keep: (file: {
    readonly name: string;
    readonly media_type: string;
    readonly size: number;
    readonly sha256: string;
    readonly bytes: Uint8Array;
  }) => Effect.Effect<
    { readonly id: string; readonly download_url?: string; readonly expires_at?: string },
    Error
  >;
}

/** A run's file service: the channel its script calls, and the check of its output. */
export interface RunFiles extends FileChannel {
  /** Fails unless every `$file` object in `output` is a file this run collected, unchanged. */
  readonly checkOutput: (output: unknown) => Effect.Effect<void, FileRefused>;
}

/** A refusal before any page call: nothing reached the page. */
const refuse = (reason: FileRefusalReason) => Effect.fail(new FileRefused({ reason }));

/** A name a browser can be given: the host's, else a plain fallback. */
const safeName = (name: string, fallback: string) =>
  Either.isRight(Schema.decodeUnknownEither(FileName)(name)) ? name : fallback;

/** A server's `Content-Type` as a media type without parameters, when it is a valid one. */
const serverType = (contentType: string | undefined) => {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  return type !== undefined && Either.isRight(Schema.decodeUnknownEither(MediaType)(type))
    ? type
    : undefined;
};

const Placement = Schema.Union(
  Schema.Struct({
    refused: Schema.Literal("field_not_found", "not_file_input", "other_site", "not_accepted"),
  }),
  Schema.Struct({
    chosen: Schema.Array(Schema.Struct({ name: Schema.String, size: Schema.Number })),
  }),
);

/** The page locator a field names, written by the host from data, never the script's code. */
const fieldLocator = (field: FileField) =>
  "label" in field
    ? `page.getByLabel(${JSON.stringify(field.label)}, { exact: ${field.exact !== false} })`
    : `page.locator(${JSON.stringify(field.selector)})`;

/**
 * Page code that finds the one element `field` names and, only when it is a file input whose
 * frame is on the site and whose `accept` takes the file, sets that same element to `path`, then
 * reads back the names and sizes it holds. The frame's address comes from Playwright, not from
 * the page. A frame is on the site at the site's own origin, or on an https host of its
 * registrable domain.
 */
const placeCode = (options: {
  readonly field: FileField;
  readonly path: string;
  readonly file: { readonly name: string; readonly mediaType: string };
  readonly siteOrigin: string;
  readonly siteDomain: string | undefined;
  readonly timeoutMs: number;
}) => `
const accepts = ${acceptsSource};
const field = ${fieldLocator(options.field)};
try { await field.first().waitFor({ state: "attached", timeout: ${options.timeoutMs} }); } catch { return { refused: "field_not_found" }; }
if ((await field.count()) !== 1) return { refused: "field_not_found" };
const element = await field.elementHandle({ timeout: ${options.timeoutMs} });
try {
  const facts = await element.evaluate((node) => ({ file: node instanceof HTMLInputElement && node.type === "file", accept: node.getAttribute("accept") ?? "" }));
  if (!facts.file) return { refused: "not_file_input" };
  const frame = await element.ownerFrame();
  const address = (() => { try { return new URL(frame === null ? "" : frame.url()); } catch { return null; } })();
  const onSiteHost = ${options.siteDomain === undefined ? "() => false" : hostOnSiteSource(options.siteDomain)};
  const onSite = address !== null && (address.origin === ${JSON.stringify(options.siteOrigin)} || (address.protocol === "https:" && onSiteHost(address.hostname)));
  if (!onSite) return { refused: "other_site" };
  if (!accepts(facts.accept, ${JSON.stringify(options.file)})) return { refused: "not_accepted" };
  await element.setInputFiles(${JSON.stringify(options.path)}, { timeout: ${options.timeoutMs} });
  return { chosen: await element.evaluate((node) => [...node.files].map((file) => ({ name: file.name, size: file.size }))) };
} finally {
  await element.dispose();
}`;

/**
 * One run's files over a host's hook. A script's reference is resolved by `resolve`, which names
 * the hook's reference for each one the run may use, such as the references in its input. A file
 * goes only into one `<input type="file">` on the tool's site, after its size, type, the input's
 * `accept` and the run's caps allow it; a program never moves. A download is kept only within
 * the caps and when it is no program. `execute` runs the host's own page code on the run's browser.
 */
export const makeRunFiles = (options: {
  readonly hook: FileHostHook;
  readonly execute: BrowserExecute;
  readonly siteOrigin: string | undefined;
  readonly resolve: (reference: string) => string | undefined;
  readonly limits?: FileLimits;
}): Effect.Effect<RunFiles> =>
  Effect.gen(function* () {
    const limits = options.limits ?? defaultFileLimits;
    const used = yield* Ref.make({ files: 0, bytes: 0 });
    const collected = yield* Ref.make<readonly FileObject[]>([]);
    const slots = new Set<string>();
    /** Whether one more file of `size` bytes fits the run's caps. */
    const fits = (size: number) =>
      Ref.get(used).pipe(
        Effect.map(
          (current) =>
            current.files + 1 <= limits.runFiles && current.bytes + size <= limits.runBytes,
        ),
      );
    /** Counts a placed or collected file against the run's caps. */
    const count = (size: number) =>
      Ref.update(used, (current) => ({ files: current.files + 1, bytes: current.bytes + size }));
    const run = (code: string, timeoutSec: number) =>
      options.execute(code, timeoutSec).pipe(
        Effect.flatMap((answer) =>
          answer.success ? Effect.succeed(answer.result) : Effect.fail(new Error(answer.error)),
        ),
      );
    const place: RunFiles["place"] = ({ reference, field, timeoutSec }) =>
      Effect.gen(function* () {
        // The field is data the host writes into its own locator; anything else is refused.
        if (Either.isLeft(Schema.decodeUnknownEither(FileField)(field)))
          return yield* refuse("field_not_found");
        const resolved = options.resolve(reference);
        if (resolved === undefined) return yield* refuse("unknown_reference");
        const siteOrigin = options.siteOrigin;
        if (siteOrigin === undefined) return yield* refuse("other_site");
        const source = yield* options.hook
          .open(resolved)
          .pipe(Effect.mapError(() => new FileRefused({ reason: "unavailable" })));
        if (source.size > limits.fileBytes) return yield* refuse("too_large");
        if (!(yield* fits(source.size))) return yield* refuse("run_limit");
        const bytes = yield* source.read.pipe(
          Effect.mapError(() => new FileRefused({ reason: "unavailable" })),
        );
        if (bytes.byteLength !== source.size) return yield* refuse("unavailable");
        const name = safeName(source.name, "file");
        if (isProgram(bytes, name)) return yield* refuse("executable");
        if (!bytesMatchType(bytes, source.media_type)) return yield* refuse("type_mismatch");
        const path = yield* options.hook
          .writeToBrowser({ name, bytes })
          .pipe(Effect.mapError(() => new FileRefused({ reason: "unavailable" })));
        // From here the page call may set the input, so a failure may have started an upload.
        const sent = (reason: FileRefusalReason) =>
          Effect.fail(new FileRefused({ reason, dispatched: true }));
        const placement = yield* run(
          placeCode({
            field,
            path,
            file: { name, mediaType: source.media_type },
            siteOrigin,
            siteDomain: siteDomain(siteOrigin),
            timeoutMs: timeoutSec * 1000,
          }),
          timeoutSec * 2 + 5,
        ).pipe(
          Effect.flatMap(Schema.decodeUnknown(Placement)),
          Effect.catchAll(() => sent("unavailable")),
        );
        // A check that failed in the page refused before the input was set.
        if ("refused" in placement) return yield* refuse(placement.refused);
        if (!placement.chosen.some((file) => file.name === name && file.size === bytes.byteLength))
          return yield* sent("unavailable");
        yield* count(bytes.byteLength);
        return {
          name,
          media_type: source.media_type,
          size: bytes.byteLength,
        } satisfies PlacedFile;
      });
    const arm: RunFiles["arm"] = () =>
      options.hook.armDownloads().pipe(
        Effect.tap((slot) => Effect.sync(() => slots.add(slot))),
        Effect.mapError(() => new FileRefused({ reason: "unavailable" })),
      );
    const collect: RunFiles["collect"] = ({ slot, timeoutMs }) =>
      Effect.gen(function* () {
        if (!slots.delete(slot)) return yield* refuse("unknown_reference");
        const current = yield* Ref.get(used);
        const room = Math.min(limits.fileBytes, limits.runBytes - current.bytes);
        const taken = yield* options.hook
          .takeDownload(slot, { timeoutMs, maxBytes: Math.max(0, room) })
          .pipe(Effect.mapError(() => new FileRefused({ reason: "unavailable" })));
        if (taken === undefined) return yield* refuse("no_download");
        if ("tooLarge" in taken) return yield* refuse(room < limits.fileBytes ? "run_limit" : "too_large");
        const name = safeName(taken.name, "download");
        if (isProgram(taken.bytes, name)) return yield* refuse("executable");
        if (!(yield* fits(taken.bytes.byteLength))) return yield* refuse("run_limit");
        yield* count(taken.bytes.byteLength);
        // The bytes decide the type when they prove one, else the server's; never the name.
        const media_type =
          sniffedType(taken.bytes) ?? serverType(taken.media_type) ?? "application/octet-stream";
        const sha256 = createHash("sha256").update(taken.bytes).digest("hex");
        const size = taken.bytes.byteLength;
        const kept = yield* options.hook
          .keep({ name, media_type, size, sha256, bytes: taken.bytes })
          .pipe(Effect.mapError(() => new FileRefused({ reason: "unavailable" })));
        const file: FileObject = {
          $file: {
            id: kept.id,
            name,
            media_type,
            size,
            sha256,
            ...(kept.download_url === undefined ? {} : { download_url: kept.download_url }),
            ...(kept.expires_at === undefined ? {} : { expires_at: kept.expires_at }),
          },
        };
        yield* Ref.update(collected, (files) => [...files, file]);
        return file;
      });
    const checkOutput: RunFiles["checkOutput"] = (output) =>
      Ref.get(collected).pipe(
        Effect.flatMap((files) =>
          outputFiles(output).every((claimed) =>
            files.some((file) => isDeepStrictEqual(file, claimed)),
          )
            ? Effect.void
            : refuse("not_collected"),
        ),
      );
    return { place, arm, collect, checkOutput };
  });

/** Every `$file` object in an output, wherever it sits. */
export const outputFiles = (output: unknown): readonly unknown[] => {
  if (Array.isArray(output)) return output.flatMap(outputFiles);
  if (typeof output !== "object" || output === null) return [];
  if (isFileObject(output)) return [output];
  return Object.values(output).flatMap(outputFiles);
};
