import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { applyDiff, type Editor } from "@openai/agents";
import { Manifest, type Entry, type SandboxSession } from "@openai/agents/sandbox";
import { Effect, Either, type Scope } from "effect";
import { createLocalProcess, type LocalProcess } from "./local-process.js";
import {
  localError,
  localFilePath,
  localMissing,
  localPromise,
  localRelativePath,
  localSourceBundleLimit,
  localSourceFileLimit,
} from "./local-path.js";

/** How long a workspace command may run unless the workspace sets its own limit. */
export const localCommandTimeoutMs = 30_000;
export interface LocalWorkspaceOptions {
  readonly root?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly commandTimeoutMs?: number;
}
export interface LocalWorkspace {
  readonly root: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly session: SandboxSession;
  readonly read: (path: string, maximumBytes?: number) => Effect.Effect<string, Error>;
  readonly write: (path: string, text: string) => Effect.Effect<void, Error>;
  readonly list: Effect.Effect<readonly string[], Error>;
  readonly snapshot: Effect.Effect<readonly (readonly [string, string])[], Error>;
  readonly install: (path: string, text: string) => Effect.Effect<void, Error>;
  readonly close: Effect.Effect<void, Error>;
}

const readLocalFile = (root: string, path: string, maximumBytes = localSourceFileLimit) =>
  Effect.gen(function* () {
    if (!Number.isInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > localSourceFileLimit)
      return yield* Effect.fail(new Error("Workspace read limit must be between 1 and 8 MiB"));
    const target = yield* localFilePath(root, path);
    const file = yield* localPromise(() => open(target, constants.O_RDONLY | constants.O_NOFOLLOW));
    return yield* Effect.gen(function* () {
      const stat = yield* localPromise(() => file.stat());
      if (!stat.isFile() || stat.size > maximumBytes)
        return yield* Effect.fail(new Error("Workspace file is not regular or exceeds read limit"));
      const bytes = yield* localPromise(() => file.readFile());
      if (bytes.length > maximumBytes)
        return yield* Effect.fail(new Error("Workspace file exceeds read limit"));
      return yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: localError,
      });
    }).pipe(Effect.ensuring(localPromise(() => file.close()).pipe(Effect.orDie)));
  });

/**
 * An edit refused before it changed anything, named by the stage it stopped at and an errno code:
 * `diff` for a patch that does not apply, `open` for a file that exists, is missing or would pass
 * a size or file-count limit. The mint workspace tells the agent the edit was not applied, and why.
 */
const refusedEdit = (stage: "open" | "diff", code: string, message?: string) =>
  Object.assign(new Error(message ?? `Workspace edit refused (${code})`), { stage, code });

const localFileCountLimit = 4096;
const fileCountRefusal = () =>
  refusedEdit("open", "EMFILE", `A workspace may hold at most ${localFileCountLimit} files`);

const listLocalFiles = (root: string, relative = ""): Effect.Effect<readonly string[], Error> =>
  Effect.gen(function* () {
    const files: string[] = [];
    for (const entry of yield* localPromise(() =>
      readdir(join(root, relative), { withFileTypes: true }),
    )) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      yield* localFilePath(root, path);
      if (entry.isDirectory()) files.push(...(yield* listLocalFiles(root, path)));
      else if (entry.isFile()) files.push(path);
      else return yield* Effect.fail(new Error("Workspace contains a non-regular file"));
      if (files.length > localFileCountLimit) return yield* Effect.fail(fileCountRefusal());
    }
    return files.sort();
  });

const writeLocalFile = (
  root: string,
  path: string,
  text: string,
  installed: ReadonlySet<string> = new Set(),
) =>
  Effect.gen(function* () {
    const relative = yield* Effect.try({ try: () => localRelativePath(path), catch: localError });
    const bytes = Buffer.byteLength(text);
    if (bytes > localSourceFileLimit)
      return yield* Effect.fail(
        refusedEdit(
          "open",
          "EFBIG",
          `A workspace file may hold at most ${localSourceFileLimit} bytes`,
        ),
      );
    // Every limit is checked before anything changes, a new parent folder included.
    const files = yield* listLocalFiles(root);
    if (files.length >= localFileCountLimit && !files.includes(relative))
      return yield* Effect.fail(fileCountRefusal());
    let total = bytes;
    for (const file of files) {
      if (file === relative || installed.has(file)) continue;
      total += (yield* localPromise(() => lstat(join(root, file)))).size;
      if (total > localSourceBundleLimit)
        return yield* Effect.fail(
          refusedEdit(
            "open",
            "EFBIG",
            `All workspace files together may hold at most ${localSourceBundleLimit} bytes`,
          ),
        );
    }
    const target = yield* localFilePath(root, path, true);
    const temporary = join(dirname(target), `.opengpt-${randomUUID()}`);
    const handle = yield* localPromise(() =>
      open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      ),
    );
    return yield* localPromise(() => handle.writeFile(text, "utf8")).pipe(
      Effect.ensuring(localPromise(() => handle.close()).pipe(Effect.orDie)),
      Effect.zipRight(localFilePath(root, path)),
      Effect.zipRight(localPromise(() => rename(temporary, target))),
      Effect.ensuring(localPromise(() => rm(temporary, { force: true })).pipe(Effect.orDie)),
    );
  });

const makeLocalEditor = (options: {
  readonly root: string;
  readonly read: LocalWorkspace["read"];
  readonly write: LocalWorkspace["write"];
  readonly lock: Effect.Semaphore;
  readonly writable: (path: string) => Effect.Effect<void, Error>;
}): Editor => {
  const patched = (current: string, diff: string, mode: "create" | "default") =>
    Effect.try({
      try: () => applyDiff(current, diff, mode),
      catch: (error) =>
        refusedEdit("diff", "EINVAL", error instanceof Error ? error.message : undefined),
    });
  /** A file that is not there was not changed. */
  const present = <A>(run: Effect.Effect<A, Error>) =>
    run.pipe(
      Effect.mapError((error) => (localMissing(error) ? refusedEdit("open", "ENOENT") : error)),
    );
  const remove = (path: string) =>
    options
      .writable(path)
      .pipe(Effect.zipRight(localFilePath(options.root, path)))
      .pipe(Effect.flatMap((target) => localPromise(() => unlink(target))));
  // Rejects with the edit's own error, so a refusal reaches the caller with its stage and code.
  const edit = (run: Effect.Effect<void, Error>) =>
    Effect.runPromise(
      run.pipe(
        options.lock.withPermits(1),
        Effect.as({ status: "completed" as const }),
        Effect.either,
      ),
    ).then((result) => Either.getOrThrowWith(result, (error) => error));
  return {
    createFile: (operation) =>
      edit(
        Effect.gen(function* () {
          // Looked up without creating parent folders, so a refused create leaves none behind.
          const existing = yield* localFilePath(options.root, operation.path).pipe(
            Effect.flatMap((target) => localPromise(() => lstat(target))),
            Effect.either,
          );
          if (existing._tag === "Right") return yield* Effect.fail(refusedEdit("open", "EEXIST"));
          if (!localMissing(existing.left)) return yield* Effect.fail(existing.left);
          yield* options.write(operation.path, yield* patched("", operation.diff, "create"));
        }),
      ),
    updateFile: (operation) =>
      edit(
        Effect.gen(function* () {
          yield* options.writable(operation.path);
          const text = yield* patched(
            yield* present(options.read(operation.path)),
            operation.diff,
            "default",
          );
          const destination = operation.moveTo ?? operation.path;
          yield* options.write(destination, text);
          if (localRelativePath(destination) !== localRelativePath(operation.path))
            yield* remove(operation.path);
        }),
      ),
    deleteFile: (operation) => edit(present(remove(operation.path))),
  };
};

const materializeLocalEntry = (
  root: string,
  path: string,
  entry: Entry,
  write: LocalWorkspace["write"],
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    if (entry.type === "file") {
      const text = yield* Effect.try({
        try: () =>
          typeof entry.content === "string"
            ? entry.content
            : new TextDecoder("utf-8", { fatal: true }).decode(entry.content),
        catch: localError,
      });
      yield* write(path, text);
      return;
    }
    if (entry.type !== "dir")
      return yield* Effect.fail(new Error(`Unsupported local manifest entry: ${entry.type}`));
    const target = yield* localFilePath(root, path, true);
    yield* localPromise(() => mkdir(target, { recursive: true }));
    for (const [name, child] of Object.entries(entry.children ?? {}))
      yield* materializeLocalEntry(root, `${path}/${name}`, child, write);
  });

const workspaceCommand =
  (
    root: string,
    environment: Readonly<Record<string, string>>,
    alive: Effect.Effect<void, Error>,
    timeoutMs: number,
    register: (process: LocalProcess) => Effect.Effect<void, Error, Scope.Scope>,
  ) =>
  (args: Parameters<NonNullable<SandboxSession["exec"]>>[0]) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* alive;
        if (args.tty) return yield* Effect.fail(new Error("Local workspace PTY is unsupported"));
        const cwd =
          args.workdir === undefined || args.workdir === "/workspace"
            ? root
            : yield* localFilePath(root, args.workdir);
        const process = yield* createLocalProcess({
          command: args.shell ?? "/bin/sh",
          args: [args.login ? "-lc" : "-c", args.cmd],
          cwd,
          environment,
        });
        yield* register(process);
        const started = performance.now();
        const result = yield* process.result.pipe(
          Effect.timeoutFail({
            duration: timeoutMs,
            onTimeout: () => new Error("Local command timed out; execution was not replayed"),
          }),
        );
        return {
          ...result,
          output: result.stdout + result.stderr,
          wallTimeSeconds: (performance.now() - started) / 1000,
        };
      }),
    );

const workspaceSession = (ports: {
  root: string;
  read: LocalWorkspace["read"];
  write: LocalWorkspace["write"];
  lock: Effect.Semaphore;
  writable: (path: string) => Effect.Effect<void, Error>;
  materialize: (path: string, entry: Entry) => Effect.Effect<void, Error>;
  command: ReturnType<typeof workspaceCommand>;
  close: LocalWorkspace["close"];
}): SandboxSession => {
  const { root, read, write, lock, writable, materialize, command, close } = ports;
  const state = { manifest: new Manifest({ root: "/workspace" }), workspaceReady: true };
  return {
    state,
    supportsPty: () => false,
    createEditor: () => makeLocalEditor({ root, read, write, lock, writable }),
    // A caller may ask for one byte past its own limit to detect an oversized file; a file past
    // this workspace's limit fails to read either way.
    readFile: ({ path, maxBytes }) =>
      Effect.runPromise(
        read(path, maxBytes === undefined ? undefined : Math.min(maxBytes, localSourceFileLimit)),
      ),
    pathExists: (path) =>
      Effect.runPromise(
        localFilePath(root, path).pipe(
          Effect.flatMap((target) => localPromise(() => lstat(target))),
          Effect.map(() => true),
          Effect.catchAll((cause) =>
            localMissing(cause) ? Effect.succeed(false) : Effect.fail(cause),
          ),
        ),
      ),
    materializeEntry: ({ path, entry }) => Effect.runPromise(materialize(path, entry)),
    applyManifest: (manifest) =>
      Effect.runPromise(
        Effect.forEach(
          Object.entries(manifest.entries),
          ([path, entry]) => materialize(path, entry),
          { discard: true },
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              state.manifest = manifest;
            }),
          ),
        ),
      ),
    exec: (args) => Effect.runPromise(command(args)),
    execCommand: (args) =>
      Effect.runPromise(command(args).pipe(Effect.map((result) => result.output))),
    close: () => Effect.runPromise(close),
  };
};

const prepareWorkspaceRoot = (selected: string | undefined) =>
  Effect.gen(function* () {
    if (selected === undefined)
      return {
        root: yield* localPromise(() => mkdtemp(join(tmpdir(), "opengpt-workspace-"))),
        temporary: true,
      };
    yield* localPromise(() => mkdir(selected, { recursive: true }));
    return { root: yield* localPromise(() => realpath(selected)), temporary: false };
  });

/** SDK tools edit and execute in the same caller-owned workspace through the original contract. */
export const createLocalWorkspace = (
  options: LocalWorkspaceOptions = {},
): Effect.Effect<LocalWorkspace, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const { root, temporary } = yield* prepareWorkspaceRoot(options.root);
    const environment = { ...(options.environment ?? {}) };
    let closed = false;
    const active = new Set<LocalProcess>();
    const register = (process: LocalProcess) =>
      Effect.suspend(() => {
        if (closed)
          return process.close.pipe(
            Effect.zipRight(Effect.fail(new Error("Local workspace closed"))),
          );
        active.add(process);
        return Effect.addFinalizer(() =>
          Effect.sync(() => {
            active.delete(process);
          }),
        );
      });
    const lock = yield* Effect.makeSemaphore(1);
    const alive = Effect.suspend(() =>
      closed ? Effect.fail(new Error("Local workspace closed")) : Effect.void,
    );
    const read: LocalWorkspace["read"] = (path, maxBytes) =>
      alive.pipe(Effect.zipRight(readLocalFile(root, path, maxBytes)));
    const installed = new Set<string>();
    const writable = (path: string) =>
      Effect.try({
        try: () => {
          if (installed.has(localRelativePath(path)))
            throw new Error("Trusted runtime files are readonly");
        },
        catch: localError,
      });
    const write: LocalWorkspace["write"] = (path, text) =>
      alive.pipe(
        Effect.zipRight(writable(path)),
        Effect.zipRight(writeLocalFile(root, path, text, installed)),
      );
    const install: LocalWorkspace["install"] = (path, text) =>
      alive.pipe(
        Effect.zipRight(writeLocalFile(root, path, text, installed)),
        Effect.tap(() =>
          Effect.sync(() => {
            installed.add(localRelativePath(path));
          }),
        ),
      );
    const list = alive.pipe(Effect.zipRight(listLocalFiles(root)));
    const snapshot = list.pipe(
      Effect.flatMap((files) =>
        Effect.forEach(
          files.filter((path) => !installed.has(path)),
          (path) => read(path).pipe(Effect.map((text) => [path, text] as const)),
        ),
      ),
    );
    const close = Effect.sync(() => {
      closed = true;
    }).pipe(
      Effect.zipRight(
        Effect.forEach(active, (process) => process.close, {
          discard: true,
          concurrency: "unbounded",
        }),
      ),
      Effect.zipRight(
        temporary ? localPromise(() => rm(root, { recursive: true, force: true })) : Effect.void,
      ),
    );
    yield* Effect.addFinalizer(() => close.pipe(Effect.orDie));
    const command = workspaceCommand(
      root,
      environment,
      alive,
      options.commandTimeoutMs ?? localCommandTimeoutMs,
      register,
    );
    const materialize = (path: string, entry: Entry) =>
      materializeLocalEntry(root, path, entry, write).pipe(lock.withPermits(1));
    const session = workspaceSession({
      root,
      read,
      write,
      lock,
      writable,
      materialize,
      command,
      close,
    });
    return { root, environment, session, read, write, list, snapshot, install, close };
  });
