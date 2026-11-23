import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Clock, Effect } from "effect";
import { localPromise } from "./local-path.js";

/**
 * Where the local host keeps the files its runs downloaded, for the caller to read from their
 * `file:` URLs. Each one expires 30 minutes after it was kept, as a hosted download does, and is
 * deleted at the next sweep after that. The local host cannot see a caller read a `file:` URL,
 * so it never deletes one sooner.
 */
export const downloadLifetimeMs = 30 * 60_000;

export interface LocalDownloads {
  /** Keeps a file and returns its id, its `file:` URL and when it expires. */
  readonly keep: (file: {
    readonly name: string;
    readonly bytes: Uint8Array;
  }) => Effect.Effect<
    { readonly id: string; readonly download_url: string; readonly expires_at: string },
    Error
  >;
  /** Deletes every file kept `downloadLifetimeMs` ago or earlier. */
  readonly sweep: Effect.Effect<void, Error>;
}

/** The files this process keeps under `root`; each keep sweeps the expired ones first. */
export const makeLocalDownloads = (root: string): LocalDownloads => {
  const kept = new Map<string, { readonly directory: string; readonly keptAt: number }>();
  const sweep = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const [id, entry] of [...kept]) {
      if (now - entry.keptAt < downloadLifetimeMs) continue;
      kept.delete(id);
      yield* localPromise(() => rm(entry.directory, { recursive: true, force: true }));
    }
  });
  return {
    sweep,
    keep: ({ name, bytes }) =>
      Effect.gen(function* () {
        yield* sweep;
        const keptAt = yield* Clock.currentTimeMillis;
        const id = randomUUID();
        const directory = join(root, id);
        yield* localPromise(() => mkdir(directory, { recursive: true }));
        const path = join(directory, name);
        yield* localPromise(() => writeFile(path, bytes, { flag: "wx" }));
        kept.set(id, { directory, keptAt });
        return {
          id,
          download_url: pathToFileURL(path).href,
          expires_at: new Date(keptAt + downloadLifetimeMs).toISOString(),
        };
      }),
  };
};

const temporaryPrefix = "opengpt-downloads-";

/**
 * Deletes the temporary download directories of earlier processes that were last changed
 * `downloadLifetimeMs` ago or earlier, such as one a crash left behind.
 */
export const sweepLeftoverDownloads = (parent: string, keep: string) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const names = yield* localPromise(() => readdir(parent));
    for (const name of names) {
      const directory = join(parent, name);
      if (!name.startsWith(temporaryPrefix) || directory === keep) continue;
      const status = yield* localPromise(() => stat(directory)).pipe(Effect.option);
      if (status._tag === "Some" && now - status.value.mtimeMs >= downloadLifetimeMs)
        yield* localPromise(() => rm(directory, { recursive: true, force: true }));
    }
  });

let processDownloads: { readonly root: string; readonly store: LocalDownloads } | undefined;
const chosenDownloads = new Map<string, LocalDownloads>();
let sweeping = false;

/** Sweeps every store this process keeps files in, now and every minute after. */
const startSweeping = () => {
  if (sweeping) return;
  sweeping = true;
  const sweepAll = Effect.suspend(() =>
    Effect.all(
      [
        ...(processDownloads === undefined
          ? []
          : [
              processDownloads.store.sweep,
              sweepLeftoverDownloads(tmpdir(), processDownloads.root),
            ]),
        ...[...chosenDownloads.values()].map((store) => store.sweep),
      ],
      { discard: true, mode: "either" },
    ),
  );
  Effect.runFork(sweepAll);
  setInterval(() => Effect.runFork(sweepAll), 60_000).unref();
};

/**
 * The downloads a run keeps: under `directory` when the caller chose one, which the host never
 * removes, else in this process's own temporary directory, removed when the process exits. Both
 * expire files after `downloadLifetimeMs`, swept on each keep and every minute.
 */
export const localDownloads = (directory?: string): LocalDownloads => {
  if (directory === undefined && processDownloads === undefined) {
    const root = mkdtempSync(join(tmpdir(), temporaryPrefix));
    process.once("exit", () => rmSync(root, { recursive: true, force: true }));
    processDownloads = { root, store: makeLocalDownloads(root) };
  }
  if (directory !== undefined && !chosenDownloads.has(directory))
    chosenDownloads.set(directory, makeLocalDownloads(directory));
  startSweeping();
  const store =
    directory === undefined ? processDownloads?.store : chosenDownloads.get(directory);
  if (store === undefined) throw new Error("Local downloads unavailable");
  return store;
};
