import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Manifest, skills } from "@openai/agents/sandbox";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { readScopedFile } from "../../src/filesystem/read.js";
import { loadAuthoringSkills } from "../../src/mint/skills.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "opengpt-scoped-read-"));
  directories.push(path);
  return path;
}

it.each([0, 1, 1024])(
  "returns only the %i file bytes in an owned backing buffer",
  async (length) => {
    const root = await directory();
    const expected = Uint8Array.from({ length }, (_, index) => index % 251);
    await writeFile(join(root, "source.bin"), expected);

    const actual = await readScopedFile(root, "source.bin");
    expect(actual).toEqual(expected);
    expect(actual.byteOffset).toBe(0);
    expect(actual.buffer.byteLength).toBe(length);
    const cloned = structuredClone(actual);
    expect(cloned).toEqual(expected);
    expect(cloned.buffer.byteLength).toBe(length);
  },
);

it("preserves complete bounded reads and rejects oversized files, traversal and symlinks", async () => {
  const root = await directory();
  await writeFile(join(root, "source.bin"), new Uint8Array([1, 2, 3, 4]));
  expect(await readScopedFile(root, "source.bin", 4)).toEqual(new Uint8Array([1, 2, 3, 4]));
  await expect(readScopedFile(root, "source.bin", 3)).rejects.toThrow("type_or_size");
  await expect(readScopedFile(root, "../source.bin")).rejects.toThrow("scope");
  await symlink(join(root, "source.bin"), join(root, "linked.bin"));
  await expect(readScopedFile(root, "linked.bin")).rejects.toThrow("ELOOP");
});

it("reads nested files but rejects a symlinked directory anywhere in the path", async () => {
  const root = await directory();
  const outside = await directory();
  await mkdir(join(root, "a", "b"), { recursive: true });
  await writeFile(join(root, "a", "b", "source.bin"), new Uint8Array([7]));
  await writeFile(join(outside, "source.bin"), new Uint8Array([9]));
  expect(await readScopedFile(root, "a/b/source.bin")).toEqual(new Uint8Array([7]));
  await symlink(outside, join(root, "escape"));
  await symlink(join(root, "a"), join(root, "inner"));
  await expect(readScopedFile(root, "escape/source.bin")).rejects.toThrow(/ELOOP|ENOTDIR/);
  await expect(readScopedFile(root, "inner/b/source.bin")).rejects.toThrow(/ELOOP|ENOTDIR/);
  await expect(readScopedFile(root, "a/b")).rejects.toThrow("type_or_size");
});

// procfs reports size 0, so the read must grow past the stat size and still enforce the limit.
it.skipIf(process.platform !== "linux")(
  "grows past a stale stat size and still rejects content over the limit",
  async () => {
    await expect(readScopedFile("/proc/self", "status", 16)).rejects.toThrow("size");
    const actual = await readScopedFile("/proc/self", "status", 1024 * 1024);
    const text = new TextDecoder().decode(actual);
    expect(text).toMatch(/^Name:\t/u);
    expect(text.endsWith("\n")).toBe(true);
    expect(actual.byteLength).toBeGreaterThan(16);
    expect(actual.byteOffset).toBe(0);
    expect(actual.buffer.byteLength).toBe(actual.byteLength);
  },
);

it("keeps real authoring files compact through the pinned SDK manifest clone", async () => {
  const catalog = await Effect.runPromise(
    loadAuthoringSkills(resolve("typescript/authoring")),
  );
  const prepared = skills({ skills: [...catalog] }).processManifest(
    new Manifest({ root: "/workspace" }),
  );
  const cloned = structuredClone(prepared.entries);
  let fileCount = 0;
  const inspect = (value: unknown): void => {
    if (value instanceof Uint8Array) {
      expect(value.buffer.byteLength).toBe(value.byteLength);
      expect(value.byteOffset).toBe(0);
      expect(value.byteLength).toBeGreaterThan(0);
      fileCount++;
    } else if (value !== null && typeof value === "object") {
      for (const nested of Object.values(value)) inspect(nested);
    }
  };
  inspect(cloned);
  expect(fileCount).toBeGreaterThanOrEqual(catalog.length);
});
