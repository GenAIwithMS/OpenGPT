import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/**
 * Sizes the buffer from the descriptor, not the limit: zero-filling a limit-sized buffer on every
 * read dominated source screening. It grows only if the file grows after stat, and stops one byte
 * past the limit, which proves an oversized file.
 */
const readComplete = async (handle: FileHandle, size: number, maximumBytes: number) => {
  let buffer = Buffer.alloc(Math.min(size, maximumBytes) + 1);
  let length = 0;
  for (;;) {
    if (length === buffer.length) {
      if (length > maximumBytes) break;
      const grown = Buffer.alloc(Math.min(buffer.length * 2, maximumBytes + 1));
      buffer.copy(grown, 0, 0, length);
      buffer = grown;
    }
    const read = await handle.read(buffer, length, buffer.length - length, length);
    if (read.bytesRead === 0) break;
    length += read.bytesRead;
  }
  return { buffer, length };
};

/**
 * Opens each part below the held root, pushing every descriptor onto `handles` for the caller
 * to close. Linux opens each part relative to the held parent descriptor, so a concurrent rename
 * or symlink replacement cannot redirect inspection outside the root. macOS `/dev/fd` entries
 * cannot be traversed, so local development opens each part by path, refusing symlinks (macOS
 * O_NOFOLLOW_ANY rejects one anywhere in the path), and then proves every held descriptor is
 * still the entry at its path.
 */
const openBelow = async (directory: string, parts: readonly string[], handles: FileHandle[]) => {
  const descriptorRelative = process.platform === "linux";
  // Node does not export macOS O_NOFOLLOW_ANY (sys/fcntl.h); the kernel rejects it combined with
  // O_NOFOLLOW (EINVAL), so it replaces that flag.
  const noFollow = process.platform === "darwin" ? 0x2000_0000 : constants.O_NOFOLLOW;
  const paths = [directory];
  for (const [index, part] of parts.entries()) {
    const path = join(paths[index] ?? directory, part);
    const parent = handles[index];
    handles.push(
      await open(
        descriptorRelative ? `/proc/self/fd/${parent?.fd}/${part}` : path,
        constants.O_RDONLY |
          noFollow |
          constants.O_NONBLOCK |
          (index < parts.length - 1 ? constants.O_DIRECTORY : 0),
      ),
    );
    paths.push(path);
  }
  if (descriptorRelative) return;
  for (const [index, held] of handles.entries()) {
    const [opened, current] = await Promise.all([held.stat(), lstat(paths[index] ?? "")]);
    if (opened.dev !== current.dev || opened.ino !== current.ino) throw new Error("scope");
  }
};

/** Hold ancestor descriptors so renamed directories and symlinks cannot redirect a read. */
export async function readScopedFile(
  root: string,
  path: string,
  maximumBytes = 8 * 1024 * 1024,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error("size");
  if (isAbsolute(path)) throw new Error("scope");
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || part.includes("\\")))
    throw new Error("scope");
  const directory = await realpath(root);
  const handles: FileHandle[] = [];
  try {
    handles.push(
      await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
    );
    await openBelow(directory, parts, handles);
    const handle = handles[handles.length - 1];
    if (handle === undefined) throw new Error("scope");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximumBytes) throw new Error("type_or_size");
    // Read a bounded complete file before screening: secrets may cross any
    // chunk boundary. Oversized source is unavailable, never partially safe.
    const { buffer, length } = await readComplete(handle, stat.size, maximumBytes);
    if (length > maximumBytes) throw new Error("size");
    // SDK manifest clones copy an entire backing buffer, including unused capacity.
    // Return owned exact-size bytes so small files cannot retain/multiply the read limit.
    return new Uint8Array(buffer.subarray(0, length));
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
  }
}
