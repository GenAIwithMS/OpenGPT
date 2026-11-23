import { posix } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { localRuntimeAssets } from "../../src/execution/local-runtime-assets.js";
import { loadStandaloneAuthoring, skillReferenceFiles } from "../../src/mint/skills.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import { sourceInspector } from "../../src/standalone/request-context.js";

/** Guardian's reads over a review's own files, with the local host's trusted SDK. */
const reader = async (sources: ReadonlyMap<string, string>, secrets = makeRunSecrets()) => {
  const trustedSources = new Map(await Effect.runPromise(localRuntimeAssets));
  const readSource = sourceInspector({ trustedSources, secrets }, sources);
  return {
    trustedSources,
    read: (path: string) =>
      Effect.runPromise(
        readSource(path, 0).pipe(
          Effect.match({
            onFailure: (failure) => ({ failure: failure.code }),
            onSuccess: (chunk) => ({ source: (JSON.parse(chunk) as { source: string }).source }),
          }),
        ),
      ),
    /** Which kind of file a failed read was, as the failure names it. */
    failedCategory: (path: string) =>
      Effect.runPromise(
        readSource(path, 0).pipe(
          Effect.match({
            onFailure: (failure) => failure.failureDetail?.context?.["pathCategory"],
            onSuccess: () => "read",
          }),
        ),
      ),
  };
};

describe("Guardian's source reads on the local host", () => {
  it("reads the SDK under operation/, where authored source imports it", async () => {
    const { trustedSources, read } = await reader(
      new Map([["operation/src/index.js", 'import "../../runtime/index.js";\n']]),
    );
    for (const path of ["runtime/index.js", "browser/form-controls.js"]) {
      const sdk = trustedSources.get(path);
      expect(sdk).toBeDefined();
      expect(await read(`operation/${path}`)).toEqual({ source: sdk });
      expect(await read(path)).toEqual({ source: sdk });
    }
  });

  it("reads the SDK's package path, and every module it loads, as the SDK's source", async () => {
    const { trustedSources, read } = await reader(
      new Map([["operation/src/tool-http.mjs", 'import "opengpt-browser-engine/runtime";\n']]),
    );
    const entry = trustedSources.get("browser/index.js");
    expect(entry).toBeDefined();
    for (const path of ["opengpt-browser-engine/runtime", "operation/opengpt-browser-engine/runtime"])
      expect(await read(path)).toEqual({ source: entry });
    // Every relative import the SDK makes, followed from its entry, is readable too.
    const pending = ["browser/index.js"];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const path = pending.pop() ?? "";
      if (seen.has(path)) continue;
      seen.add(path);
      const result = await read(path);
      expect(result, path).toHaveProperty("source");
      const text = "source" in result ? result.source : "";
      for (const [, specifier = ""] of text.matchAll(
        /(?:\bfrom|\bimport)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/gu,
      ))
        pending.push(posix.normalize(posix.join(posix.dirname(path), specifier)));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("reads the SDK's modules under opengpt-browser-engine/, and a TypeScript spelling as the JavaScript that runs", async () => {
    const { trustedSources, read } = await reader(new Map());
    const operation = trustedSources.get("runtime/operation.js");
    const entry = trustedSources.get("browser/index.js");
    expect(operation).toBeDefined();
    for (const path of [
      "opengpt-browser-engine/runtime/operation.js",
      "opengpt-browser-engine/runtime/operation.ts",
      "opengpt-browser-engine/runtime/operation.d.ts",
      "runtime/operation.ts",
      "operation/opengpt-browser-engine/runtime/operation.d.ts",
    ])
      expect(await read(path), path).toEqual({ source: operation });
    expect(await read("opengpt-browser-engine/browser/index.ts")).toEqual({ source: entry });
  });

  it("answers a guessed SDK path with where the SDK is, and still fails a missing authored file", async () => {
    const { trustedSources, read, failedCategory } = await reader(new Map());
    const entry = trustedSources.get("browser/index.js");
    for (const guess of [
      "opengpt-browser-engine/runtime/missing.ts",
      "runtime/form-controls.js",
      "operation/runtime/form-controls.js",
    ]) {
      const answer = await read(guess);
      expect("source" in answer && JSON.parse(answer.source), guess).toEqual({
        kind: "host_sdk_reference",
        state: "not_an_sdk_file",
        runtimeEntry: "opengpt-browser-engine/browser/index.js",
        resolvedFrom: "opengpt-browser-engine/runtime",
      });
    }
    expect(await read("opengpt-browser-engine/browser/index.js")).toEqual({ source: entry });
    expect(await read("operation/src/missing.mjs")).toEqual({ failure: "SourceUnavailable" });
    expect(await failedCategory("operation/src/missing.mjs")).toBe("workspace");
  });

  it("keeps a secret check's refusal of an SDK file out of the host's gaps", async () => {
    // The check refuses the same file on every read, so a retry could never clear it.
    const secrets = makeRunSecrets();
    secrets.register("defineOperation");
    const { read, failedCategory } = await reader(
      new Map([["operation/src/tool.mjs", "export const defineOperation = 1;\n"]]),
      secrets,
    );
    const paths = [
      "runtime/operation.js",
      "operation/opengpt-browser-engine/runtime/operation.js",
      "operation/src/tool.mjs",
    ];
    for (const path of paths) expect(await read(path), path).toEqual({ failure: "SourceUnavailable" });
    expect(await Promise.all(paths.map(failedCategory))).toEqual([undefined, undefined, undefined]);
  });

  it("reads an authored TypeScript file as written, never as the SDK's JavaScript", async () => {
    const { read } = await reader(
      new Map([["operation/runtime/operation.ts", "export const authored = 1;\n"]]),
    );
    expect(await read("operation/runtime/operation.ts")).toEqual({
      source: "export const authored = 1;\n",
    });
  });

  it("reads each of the minter's skills where the minter reads it", async () => {
    const { skills } = await Effect.runPromise(
      loadStandaloneAuthoring(fileURLToPath(new URL("../../authoring/", import.meta.url))),
    );
    const references = skillReferenceFiles(skills);
    // Each skill's text, and each of its reference files, all of which are text.
    expect(references.size).toBe(
      skills.reduce((count, skill) => count + 1 + Object.keys(skill.references ?? {}).length, 0),
    );
    const { read } = await reader(references);
    // The skill is long, so its first chunk starts it.
    const core = await read(".agents/core/SKILL.md");
    expect("source" in core && core.source.length > 0).toBe(true);
    expect(references.get(".agents/core/SKILL.md")?.startsWith("source" in core ? core.source : "-")).toBe(true);
  });

  it("reads an authored file before the SDK file at the same path", async () => {
    const { read } = await reader(
      new Map([["operation/runtime/index.js", "export const authored = true;\n"]]),
    );
    expect(await read("operation/runtime/index.js")).toEqual({
      source: "export const authored = true;\n",
    });
  });

  it("finds no file outside the review's files and the SDK", async () => {
    const { read } = await reader(new Map());
    for (const path of ["operation/src/missing.js", "executed/runtime/index.js"])
      expect(await read(path)).toEqual({ failure: "SourceUnavailable" });
  });

  it("ships every SDK module the SDK's own files import", async () => {
    const { trustedSources } = await reader(new Map());
    const missing: string[] = [];
    for (const [path, source] of trustedSources)
      for (const [, specifier] of source.matchAll(/\bfrom\s+["'](\.{1,2}\/[^"']+)["']/gu)) {
        const imported = new URL(specifier ?? "", `file:///sdk/${path}`).pathname.slice(5);
        if (!trustedSources.has(imported)) missing.push(`${path} -> ${imported}`);
      }
    expect(missing).toEqual([]);
  });
});
