import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";

export const localSourceFileLimit = 8 * 1024 * 1024;
export const localSourceBundleLimit = 16 * 1024 * 1024;
export const localOutputLimit = 1024 * 1024;

export const localError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error("Local execution failed", { cause });
export const localPromise = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: localError });

export const localRelativePath = (path: string): string => {
  const relative = path.startsWith("/workspace/") ? path.slice(11) : path;
  if (
    !/^[A-Za-z0-9_./-]+$/.test(relative) ||
    relative.startsWith("/") ||
    relative.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    throw new Error("Path must be a plain relative workspace path");
  return relative;
};

export const localMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/** SDK paths never traverse a symlink, including a symlinked parent directory. */
export const localFilePath = (root: string, path: string, createParents = false) =>
  Effect.gen(function* () {
    const relative = yield* Effect.try({ try: () => localRelativePath(path), catch: localError });
    const parts = relative.split("/");
    let current = root;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      let status = yield* localPromise(() => lstat(current)).pipe(Effect.either);
      if (status._tag === "Left" && localMissing(status.left)) {
        if (index === parts.length - 1) return current;
        if (!createParents) return yield* Effect.fail(status.left);
        yield* localPromise(() => mkdir(current));
        status = yield* localPromise(() => lstat(current)).pipe(Effect.either);
      }
      if (status._tag === "Left") return yield* Effect.fail(status.left);
      if (status.right.isSymbolicLink())
        return yield* Effect.fail(new Error("Workspace symlinks are refused"));
      if (index < parts.length - 1 && !status.right.isDirectory())
        return yield* Effect.fail(new Error("Workspace parent is not a directory"));
    }
    return current;
  });
