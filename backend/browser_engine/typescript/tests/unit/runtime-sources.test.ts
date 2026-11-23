import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getRuntimeSources,
  runtimeSourceEntry,
  runtimeSourcesManifestPath,
} from "../../src/execution/runtime-sources.js";

// The modules `opengpt-browser-engine/runtime` loads, which a host gives Guardian and the minter to read.

const relativeImports = (path: string, text: string) =>
  [...text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/gu)].map(
    ([, specifier = ""]) => posix.normalize(posix.join(posix.dirname(path), specifier)),
  );

describe("the runtime source set", () => {
  it("starts at the runtime's entry and holds every module it imports", () => {
    const sources = getRuntimeSources();
    expect(sources[0]?.[0]).toBe(runtimeSourceEntry);
    const paths = new Set(sources.map(([path]) => path));
    for (const [path, text] of sources)
      for (const imported of relativeImports(path, text)) expect(paths, path).toContain(imported);
  });

  // The build writes the set as data for hosts that read the package without running it. CI
  // builds before it tests, so a list out of step with the SDK fails there.
  it.skipIf(!existsSync(runtimeSourcesManifestPath))(
    "ships the set the built package computes, for this checkout's SDK",
    async () => {
      const shipped: unknown = JSON.parse(readFileSync(runtimeSourcesManifestPath, "utf8"));
      const built: unknown = await import(
        new URL("../../../dist/typescript/src/execution/runtime-sources.js", import.meta.url).href
      );
      const manifest: unknown = Reflect.get(Object(built), "runtimeSourcesManifest");
      expect(typeof manifest).toBe("function");
      if (typeof manifest === "function") expect(shipped).toEqual(manifest());
      expect(shipped).toMatchObject({
        root: "dist/typescript/src",
        entry: runtimeSourceEntry,
        modules: getRuntimeSources().map(([path]) => ({ path })),
      });
    },
  );
});
