import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schema, type Scope } from "effect";
import type { BrowserExecute } from "../runtime/browser-execution.js";
import type { FileHostHook, SourceFile } from "../runtime/file-transfer.js";
import { typeOfName } from "../runtime/file-types.js";
import { localError, localPromise } from "./local-path.js";
import type { LocalDownloads } from "./local-downloads.js";

/**
 * The local host's files. A caller names a file on this machine by its `file:` URL; the native
 * browser's Playwright code runs on this machine, so a placed file is written to a run directory
 * here and a download is saved there by the browser's own download event. A collected file is
 * kept in `downloads`, where the caller reads it from its `file:` URL until it expires, or kept
 * nowhere when there are none, as during a build, whose files only the run sees.
 */

/** Whether a value is a local file reference: a `file:` URL of an absolute path. */
export const isLocalFileReference = (value: unknown): value is string => {
  if (typeof value !== "string" || !value.startsWith("file://")) return false;
  const url = URL.parse(value);
  return url !== null && url.protocol === "file:" && url.host === "" && !url.search && !url.hash;
};

/** Every local file reference in a value, wherever it sits. */
export const localFileReferences = (value: unknown): ReadonlySet<string> => {
  const found = new Set<string>();
  const visit = (item: unknown) => {
    if (isLocalFileReference(item)) found.add(item);
    else if (Array.isArray(item)) item.forEach(visit);
    else if (typeof item === "object" && item !== null) Object.values(item).forEach(visit);
  };
  visit(value);
  return found;
};

/**
 * A file's bytes, reading at most one more than the `size` it had: a file that grew since is
 * refused rather than read whole.
 */
const readAtMost = async (path: string, size: number) => {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(size + 1);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    if (read !== size) throw new Error("The file changed while it was read");
    return new Uint8Array(buffer.buffer, buffer.byteOffset, size);
  } finally {
    await handle.close();
  }
};

/** The regular file a local reference names, with the type its name implies. */
export const openLocalFile = (reference: string): Effect.Effect<SourceFile, Error> =>
  Effect.gen(function* () {
    if (!isLocalFileReference(reference))
      return yield* Effect.fail(new Error("Not a local file reference"));
    const path = fileURLToPath(reference);
    const status = yield* localPromise(() => stat(path));
    if (!status.isFile()) return yield* Effect.fail(new Error("Not a regular file"));
    const name = basename(path);
    return {
      name,
      media_type: typeOfName(name),
      size: status.size,
      read: localPromise(() => readAtMost(path, status.size)),
    };
  });

const Saved = Schema.Union(
  Schema.Struct({
    saved: Schema.Literal(true),
    name: Schema.String,
    contentType: Schema.optional(Schema.String),
  }),
  Schema.Struct({ saved: Schema.Literal(false) }),
);

/**
 * Native page code that saves the first download any page of the context starts into `path`,
 * noting the `Content-Type` of each response so the download's own is known.
 */
const armCode = (slot: string, path: string) => `
const registry = (globalThis.__opengptDownloads ??= new Map());
const state = { listeners: [], types: new Map() };
const capture = (download) => {
  if (state.done !== undefined) return;
  const name = download.suggestedFilename();
  const contentType = state.types.get(download.url());
  state.done = download.saveAs(${JSON.stringify(path)}).then(() => ({ saved: true, name, ...(contentType === undefined ? {} : { contentType }) }), () => ({ saved: false }));
};
const typed = (response) => {
  const type = response.headers()["content-type"];
  if (type !== undefined) state.types.set(response.url(), type);
};
const watch = (page) => {
  page.on("download", capture);
  state.listeners.push(() => page.off("download", capture));
};
for (const page of context.pages()) watch(page);
context.on("page", watch);
context.on("response", typed);
state.listeners.push(() => context.off("page", watch), () => context.off("response", typed));
registry.set(${JSON.stringify(slot)}, state);
return true;`;

/** Native page code that waits up to `timeoutMs` for the slot's download, then ends its capture. */
const takeCode = (slot: string, timeoutMs: number) => `
const registry = globalThis.__opengptDownloads;
const state = registry?.get(${JSON.stringify(slot)});
if (state === undefined) return { saved: false };
const until = Date.now() + ${timeoutMs};
while (state.done === undefined && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
registry.delete(${JSON.stringify(slot)});
for (const stop of state.listeners) stop();
if (state.done === undefined) return { saved: false };
return await Promise.race([state.done, new Promise((resolve) => setTimeout(() => resolve({ saved: false }), Math.max(0, until - Date.now())))]);`;

/**
 * The native browser's file hook for one run, removing its run directory when the scope closes.
 * `execute` runs the host's page code on the run's browser.
 */
export const makeLocalFileHook = (options: {
  readonly execute: BrowserExecute;
  /** Where collected files are kept for the caller; none keeps no bytes. */
  readonly downloads?: LocalDownloads;
}): Effect.Effect<FileHostHook, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      localPromise(() => mkdtemp(join(tmpdir(), "opengpt-files-"))),
      (directory) =>
        localPromise(() => rm(directory, { recursive: true, force: true })).pipe(Effect.ignore),
    );
    const fresh = (kind: string) =>
      Effect.gen(function* () {
        const directory = join(root, kind, randomUUID());
        yield* localPromise(() => mkdir(directory, { recursive: true }));
        return directory;
      });
    const slots = new Map<string, string>();
    const run = (code: string, timeoutSec: number) =>
      options.execute(code, timeoutSec).pipe(
        Effect.flatMap((answer) =>
          answer.success ? Effect.succeed(answer.result) : Effect.fail(new Error(answer.error)),
        ),
      );
    return {
      open: openLocalFile,
      writeToBrowser: ({ name, bytes }) =>
        Effect.gen(function* () {
          const path = join(yield* fresh("placed"), name);
          yield* localPromise(() => writeFile(path, bytes, { flag: "wx" }));
          return path;
        }),
      armDownloads: () =>
        Effect.gen(function* () {
          const slot = randomUUID();
          const path = join(yield* fresh("downloads"), "download");
          slots.set(slot, path);
          yield* run(armCode(slot, path), 10);
          return slot;
        }),
      takeDownload: (slot, { timeoutMs, maxBytes }) =>
        Effect.gen(function* () {
          const path = slots.get(slot);
          slots.delete(slot);
          if (path === undefined) return yield* Effect.fail(new Error("Unknown download slot"));
          const timeoutSec = Math.min(300, Math.ceil(timeoutMs / 1000) + 5);
          const saved = yield* run(takeCode(slot, timeoutMs), timeoutSec).pipe(
            Effect.flatMap(Schema.decodeUnknown(Saved)),
            Effect.mapError(localError),
          );
          if (!saved.saved) return undefined;
          // The host reads only the path it chose, never one the page named.
          const status = yield* localPromise(() => lstat(path));
          if (!status.isFile()) return yield* Effect.fail(new Error("Download is not a file"));
          if (status.size > maxBytes) return { tooLarge: true as const };
          return {
            name: saved.name,
            bytes: yield* localPromise(() => readAtMost(path, status.size)),
            ...(saved.contentType === undefined ? {} : { media_type: saved.contentType }),
          };
        }),
      keep: (file) =>
        options.downloads === undefined
          ? Effect.succeed({ id: randomUUID() })
          : options.downloads.keep(file),
    } satisfies FileHostHook;
  });
