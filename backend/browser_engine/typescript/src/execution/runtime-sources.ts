import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";

/** The module `opengpt-browser-engine/runtime` names, relative to the package's source root. */
export const runtimeSourceEntry = "browser/index.js";

const root = new URL("../", import.meta.url);
const fromSource = import.meta.url.endsWith(".ts");

/** One SDK module as it runs: JavaScript, with a source checkout's types stripped. */
const readModule = (path: string) => {
  const filename = fromSource ? path.replace(/\.js$/u, ".ts") : path;
  const text = readFileSync(fileURLToPath(new URL(filename, root)), "utf8");
  return fromSource ? stripTypeScriptTypes(text, { mode: "transform", sourceUrl: filename }) : text;
};

/** The SDK modules a module loads, by their paths from the source root. */
const relativeImports = (path: string, text: string) => {
  const parsed = parseSync(path, text, { lang: "js", sourceType: "module" });
  if (parsed.errors.length > 0) throw new Error(`The SDK module ${path} does not parse`);
  const requests = [
    ...parsed.module.staticImports.map((entry) => entry.moduleRequest.value),
    ...parsed.module.staticExports.flatMap((entry) =>
      entry.entries.flatMap((exported) =>
        exported.moduleRequest === null ? [] : [exported.moduleRequest.value],
      ),
    ),
    ...parsed.module.dynamicImports.flatMap((dynamic) => {
      const literal = text.slice(dynamic.moduleRequest.start, dynamic.moduleRequest.end);
      return /^(["'])[^"'\\]*\1$/u.test(literal) ? [literal.slice(1, -1)] : [];
    }),
  ];
  return requests
    .filter((request) => request.startsWith("./") || request.startsWith("../"))
    .map((request) => posix.normalize(posix.join(posix.dirname(path), request)));
};

let computed: readonly (readonly [string, string])[] | undefined;

/**
 * Every module `opengpt-browser-engine/runtime` loads, as `[path, JavaScript text]`, the entry first. Each path
 * is relative to the package's source root, such as `runtime/operation.js`, so the modules' own
 * relative imports resolve among them. A host places them under one folder for Guardian's source
 * reads and the minter's workspace, and maps a bare `opengpt-browser-engine/runtime` to `runtimeSourceEntry`
 * there. The set follows the imports, so it changes as the SDK does.
 */
export const getRuntimeSources = (): readonly (readonly [string, string])[] => {
  if (computed !== undefined) return computed;
  const modules = new Map<string, string>();
  const pending = [runtimeSourceEntry];
  for (let path = pending.shift(); path !== undefined; path = pending.shift()) {
    if (modules.has(path)) continue;
    const text = readModule(path);
    modules.set(path, text);
    pending.push(...relativeImports(path, text));
  }
  computed = [...modules];
  return computed;
};

/** Where the built package keeps `runtimeSourcesManifest`, from the package root. */
export const runtimeSourcesManifestPath = "dist/runtime-sources.json";

/**
 * `getRuntimeSources` as data: the folder the paths are relative to, from the package root, the
 * entry, and each module's path and JavaScript text. The build writes it from the built package
 * to `runtimeSourcesManifestPath`, so a host can read the set from a package it never runs.
 */
export const runtimeSourcesManifest = () => ({
  version: 1,
  root: "dist/typescript/src",
  entry: runtimeSourceEntry,
  modules: getRuntimeSources().map(([path, text]) => ({ path, text })),
});
