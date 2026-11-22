import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { openLocalFile } from "../../src/execution/local-files.js";

it("reads a caller's file only at the size it had when opened, refusing one that grew since", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opengpt-local-files-qa-"));
  try {
    const path = join(directory, "receipt.txt");
    await writeFile(path, "Receipt 1042\n");
    const same = await Effect.runPromise(openLocalFile(pathToFileURL(path).href));
    expect(new TextDecoder().decode(await Effect.runPromise(same.read))).toBe("Receipt 1042\n");
    const grown = await Effect.runPromise(openLocalFile(pathToFileURL(path).href));
    await appendFile(path, "x".repeat(1 << 20));
    await expect(Effect.runPromise(grown.read)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
