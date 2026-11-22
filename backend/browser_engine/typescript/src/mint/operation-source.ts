import { posix } from "node:path";
import { parseSync } from "oxc-parser";
import { sourceSyntax } from "../runtime/source-syntax.js";

/**
 * Why a step's entrypoint cannot run: its source does not parse. Inert syntax only: no imports,
 * dependency resolution or generated code execution. A host refuses the step before review.
 */
export const mintSourceSyntaxFailure = (source: string, path: string): string | undefined => {
  try {
    const lang = sourceSyntax(path) === "typescript" ? "ts" : "js";
    const error = parseSync(`operation.${lang}`, source, { lang, sourceType: "module" }).errors[0];
    if (!error) return undefined;
    // Parser excerpts may contain secrets. Retain only the position and a fixed reason.
    const offset = error.labels[0]?.start ?? 0;
    const prefix = source.slice(0, offset);
    const line = prefix.split("\n").length;
    const column = offset - prefix.lastIndexOf("\n");
    return `Submitted entrypoint has invalid source syntax at line ${line}, column ${column}. Correct the source before execution. No code was executed.`;
    // A parser that throws gets the fixed unparsed-source answer, which quotes no source.
  } catch {
    return "Submitted entrypoint source could not be parsed. Correct the source before execution. No code was executed.";
  }
};

const publishableSourcePath = /^(src|explore|test|scratch)\/.+\.(?:m?js|ts|json)$/;
/** A file the agent authors and an execution may import: operation source, never skills or captures. */
export const isAuthoredSourcePath = (path: string) => publishableSourcePath.test(path);

/**
 * Names whose use lets module code load or run a file its import statements do not name:
 * `require`, `eval`, the `Function` constructor (reached as any function's `constructor`), a
 * worker, the process or global object, or reflection over them.
 */
const loaderNames = new Set([
  "require",
  "createRequire",
  "eval",
  "Function",
  "constructor",
  "Worker",
  "SharedWorker",
  "globalThis",
  "global",
  "process",
  "Reflect",
]);
/**
 * The names the save rule also treats as loaders: a CommonJS module's wrapper arguments hold its
 * `require`, as `arguments[1]`, wherever the name reaches the wrapper's (see `usesLoader`). Only
 * the local save rule reads this set.
 */
const savedLoaderNames: ReadonlySet<string> = new Set([...loaderNames, "arguments"]);
/** Node built-ins that run, spawn or read and load code. */
const loaderModules = new Set([
  "child_process",
  "cluster",
  "fs",
  "fs/promises",
  "inspector",
  "inspector/promises",
  "module",
  "process",
  "repl",
  "test",
  "vm",
  "wasi",
  "worker_threads",
]);

/** A relative specifier Node resolves to exactly its own path: no query, fragment or escape. */
const plainRelative = (request: string) =>
  (request.startsWith("./") || request.startsWith("../")) && !/[?#%\\]/u.test(request);
/** A package or built-in that cannot name a workspace file or load one. */
const plainPackage = (request: string) => {
  const name = request.replace(/^node:/u, "");
  return /^(?:@[\w.-]+\/)?[\w.-][\w./-]*$/u.test(name) && !loaderModules.has(name);
};

const keyedMembers = new Set(["MethodDefinition", "Property", "PropertyDefinition"]);
const field = (node: object, key: string): unknown =>
  key in node ? Reflect.get(node, key) : undefined;
/** The name a member expression reads: `name` in `x.name`, or the string in `x["name"]`. */
const memberKey = (node: object): unknown => {
  const property = field(node, "property");
  if (typeof property !== "object" || property === null) return undefined;
  if (field(node, "computed") === true) return field(property, "value");
  return field(property, "type") === "Identifier" ? field(property, "name") : undefined;
};
/** Expressions whose value is their `expression`'s: parentheses, a chain, a TypeScript cast. */
const passThrough = new Set([
  "ParenthesizedExpression",
  "ChainExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);
/** Whether an expression's value is a call's result. */
const callResult = (node: unknown): boolean => {
  if (typeof node !== "object" || node === null) return false;
  const type = field(node, "type");
  if (type === "CallExpression") return true;
  return typeof type === "string" && passThrough.has(type) && callResult(field(node, "expression"));
};
/**
 * Whether a node is one of `names` itself: an identifier, or a member's property name or computed
 * key string (`x.constructor`, `x["constructor"]`). As a property, `arguments` is a value's own
 * field, so it counts only off a call's result: a stack frame's `getFunction()` can return a
 * CommonJS module's wrapper, whose `arguments` hold its `require`.
 */
const loaderName = (node: object, type: unknown, names: ReadonlySet<string>): boolean => {
  if (type === "Identifier") {
    const name = field(node, "name");
    return typeof name === "string" && names.has(name);
  }
  if (type !== "MemberExpression") return false;
  const key = memberKey(node);
  return (
    typeof key === "string" &&
    names.has(key) &&
    (key !== "arguments" || callResult(field(node, "object")))
  );
};
/**
 * Nodes inside which `arguments` is not a CommonJS wrapper's: a function that binds its own (an
 * arrow function reads its parent's), and a TypeScript type or abstract member, which never runs.
 */
const otherArguments = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "TSPropertySignature",
  "TSMethodSignature",
  "TSAbstractPropertyDefinition",
  "TSAbstractMethodDefinition",
]);
/**
 * Whether the syntax tree uses a loader name (see `loaderName`). A class's own `constructor`
 * method, another plain key it or an object literal declares, and any other string, the page code
 * a template literal holds included, are not uses. Nor is `arguments` inside `otherArguments`.
 */
const usesLoader = (node: unknown, names: ReadonlySet<string>): boolean => {
  if (Array.isArray(node)) return node.some((entry) => usesLoader(entry, names));
  if (typeof node !== "object" || node === null) return false;
  const type = field(node, "type");
  if (typeof type === "string" && keyedMembers.has(type) && field(node, "computed") === false)
    return usesLoader(field(node, "value"), names);
  if (loaderName(node, type, names)) return true;
  if (type === "Identifier" || type === "Literal") return false;
  // `loaderName` checked the property's name; only the object can hold another use.
  if (type === "MemberExpression" && field(node, "computed") === false)
    return usesLoader(field(node, "object"), names);
  const inner =
    typeof type === "string" && otherArguments.has(type) && names.has("arguments")
      ? new Set([...names].filter((name) => name !== "arguments"))
      : names;
  return Object.values(node).some((value) => usesLoader(value, inner));
};

/**
 * A module's module requests, or undefined when a dynamic import's request is not a string
 * literal. Given `loader` names, it also answers undefined for a module that could load a file
 * those requests do not name: a request with a query, fragment or percent escape, a package
 * import (`#name`), an absolute or URL request, a loader built-in, or one of those names in its
 * code.
 */
const moduleRequests = (
  source: string,
  path: string,
  loader?: ReadonlySet<string>,
): readonly string[] | undefined => {
  try {
    const lang = sourceSyntax(path) === "typescript" ? "ts" : "js";
    const parsed = parseSync(`module.${lang}`, source, { lang, sourceType: "module" });
    if (parsed.errors.length > 0) return undefined;
    const requests = [
      ...parsed.module.staticImports.map((entry) => entry.moduleRequest.value),
      ...parsed.module.staticExports.flatMap((entry) =>
        entry.entries.flatMap((exported) =>
          exported.moduleRequest === null ? [] : [exported.moduleRequest.value],
        ),
      ),
    ];
    for (const dynamic of parsed.module.dynamicImports) {
      const literal = source.slice(dynamic.moduleRequest.start, dynamic.moduleRequest.end);
      const request: unknown = /^(["'])[^"'\\]*\1$/.test(literal)
        ? literal.slice(1, -1)
        : undefined;
      if (typeof request !== "string") return undefined;
      requests.push(request);
    }
    if (loader === undefined) return requests;
    return requests.every((request) => plainRelative(request) || plainPackage(request)) &&
      !usesLoader(parsed.program, loader)
      ? requests
      : undefined;
    // error-reporting-allow: parse-predicate an unparseable module keeps every candidate file
  } catch {
    return undefined;
  }
};

/** Relative module requests, or undefined when a request cannot be resolved statically. */
const relativeModuleRequests = (source: string, path: string): readonly string[] | undefined =>
  moduleRequests(source, path)?.filter(
    (request) => request.startsWith("./") || request.startsWith("../"),
  );

/**
 * The workspace files a published operation can load: all of src/, the named entrypoints, and
 * any explore, test or scratch module they import. Probes nothing imports stay out of the bundle
 * and its screening. A module whose imports cannot be resolved statically keeps every candidate.
 */
export const operationSourceFiles = (
  workspace: ReadonlyMap<string, string>,
  entrypoints: readonly string[],
): Map<string, string> => {
  const candidates = [...workspace].filter(([path]) => publishableSourcePath.test(path));
  const included = new Map<string, string>();
  const pending = [
    ...candidates.filter(([path]) => path.startsWith("src/")).map(([path]) => path),
    ...entrypoints,
  ];
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    const source = workspace.get(path);
    if (included.has(path) || source === undefined) continue;
    included.set(path, source);
    if (path.endsWith(".json")) continue;
    const requests = relativeModuleRequests(source, path);
    if (requests === undefined) return new Map([...candidates, ...included]);
    for (const request of requests) {
      const resolved = posix.normalize(posix.join(posix.dirname(path), request));
      if (publishableSourcePath.test(resolved)) pending.push(resolved);
    }
  }
  return included;
};

/** The folders a local build saves files from: its operation source and its probes. */
const savedSourcePath = /^(src|explore|test|scratch)\//u;

/** Extensions Node loads whose imports the walker cannot read: WebAssembly and native addons. */
const opaqueModulePath = /\.(?:wasm|node)$/u;

/**
 * A path as a file system that ignores letter case and Unicode normalization compares it, as
 * macOS does by default.
 */
const folded = (path: string) => posix.normalize(path).normalize("NFC").toLowerCase();

/** A request for Playwright's internal modules, which can run a test config and files it names. */
const playwrightInternals = (request: string) =>
  request.toLowerCase().startsWith("playwright/lib/");

/**
 * Whether a saved package manifest could map the package's own name to a saved file: it declares
 * `exports`, or does not parse. A manifest without them, such as `{}`, maps nothing.
 */
const mapsOwnName = (source: string) => {
  try {
    const manifest: unknown = JSON.parse(source);
    return typeof manifest !== "object" || manifest === null || "exports" in manifest;
    // error-reporting-allow: parse-predicate a manifest that does not parse could map anything
  } catch {
    return true;
  }
};

/**
 * Every file under src/ and the entrypoint, with the saved candidates they import, transitively,
 * whatever their extension; an extensionless file, which Node loads as ESM in a module scope, is
 * read as JavaScript. An import of another path, such as the host's runtime, is not followed.
 * Undefined, and the walk stops, when Node could load a saved file those imports do not name: a
 * saved manifest outside src/ maps the package's own name, a saved folder holds `node_modules`, or
 * one of the files is a WebAssembly module or native addon, could load a file its imports do not
 * name (see `moduleRequests`), imports Playwright's internal modules, or does not parse. Paths
 * compare in any letter case and Unicode normalization.
 */
const importedCandidates = (
  candidates: ReadonlyMap<string, string>,
  entrypoint: string,
): Map<string, string> | undefined => {
  if (
    [...candidates].some(
      ([path, source]) =>
        folded(path).split("/").includes("node_modules") ||
        // Node keeps a manifest's exports inside its folder: one under src/ maps only src/ files.
        (posix.basename(folded(path)) === "package.json" &&
          !path.startsWith("src/") &&
          mapsOwnName(source)),
    )
  )
    return undefined;
  const files = new Map<string, string>();
  const spellings = Map.groupBy(candidates.keys(), folded);
  const pending = [...[...candidates.keys()].filter((path) => path.startsWith("src/")), entrypoint];
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    const source = candidates.get(path);
    if (files.has(path) || source === undefined) continue;
    files.set(path, source);
    if (opaqueModulePath.test(path)) return undefined;
    if (sourceSyntax(path) === undefined && posix.extname(path) !== "") continue;
    const requests = moduleRequests(source, path, savedLoaderNames);
    if (requests === undefined || requests.some(playwrightInternals)) return undefined;
    for (const request of requests.filter(plainRelative))
      pending.push(...(spellings.get(folded(posix.join(posix.dirname(path), request))) ?? []));
  }
  return files;
};

/**
 * The saved files the operation could run: those `entrypoint` reaches through its imports (see
 * `importedCandidates`), or every file under the four folders when Node could load a saved file
 * those imports do not name. The check that published code holds no secret handle reads these.
 */
export const runnableOperationFiles = (
  workspace: ReadonlyMap<string, string>,
  entrypoint: string,
): Map<string, string> => {
  const candidates = new Map([...workspace].filter(([path]) => savedSourcePath.test(path)));
  return importedCandidates(candidates, entrypoint) ?? candidates;
};

/**
 * The files a local build saves for `entrypoint`: the files it could run (see
 * `runnableOperationFiles`), which are every file under src/, the entrypoint and the files under
 * explore/, test/ or scratch/ that they import, or every file under the four folders when Node
 * could load one those imports do not name. A package manifest anywhere in the workspace, in any
 * letter case, keeps every file under the four folders as a precaution.
 */
export const savedOperationFiles = (
  workspace: ReadonlyMap<string, string>,
  entrypoint: string,
): Map<string, string> =>
  [...workspace.keys()].some((path) => posix.basename(folded(path)) === "package.json")
    ? new Map([...workspace].filter(([path]) => savedSourcePath.test(path)))
    : runnableOperationFiles(workspace, entrypoint);

/**
 * One entrypoint and the workspace modules it imports, transitively; unlike the published bundle
 * it leaves out unrelated `src/` files. A module whose imports cannot be resolved statically keeps
 * every candidate file. The write-step digests and checks read this closure: a file the step
 * loads another way is not in it.
 */
export const entrypointImportClosure = (
  workspace: ReadonlyMap<string, string>,
  entrypoint: string,
): Map<string, string> => {
  const included = new Map<string, string>();
  const pending = [entrypoint];
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    const source = workspace.get(path);
    if (included.has(path) || source === undefined) continue;
    included.set(path, source);
    if (path.endsWith(".json")) continue;
    const requests = relativeModuleRequests(source, path);
    if (requests === undefined)
      return new Map([...workspace].filter(([candidate]) => publishableSourcePath.test(candidate)));
    for (const request of requests)
      pending.push(posix.normalize(posix.join(posix.dirname(path), request)));
  }
  return included;
};

/**
 * The entrypoint's static import closure read one file at a time, for a host that cannot list its
 * workspace: each file `read` returns, following relative imports into authored source only, as
 * the published bundle does. The SDK a tool imports by relative path is the host's and fixed
 * within a job, often outside the workspace, so it is never read. A module that could load a file
 * its imports do not name contributes only what its imports name.
 */
export const readImportClosure = async (
  read: (path: string) => Promise<string | undefined>,
  entrypoint: string,
): Promise<Map<string, string>> => {
  const included = new Map<string, string>();
  const pending = [entrypoint];
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    if (included.has(path)) continue;
    const source = await read(path);
    if (source === undefined) continue;
    included.set(path, source);
    if (path.endsWith(".json")) continue;
    for (const request of relativeModuleRequests(source, path) ?? []) {
      const resolved = posix.normalize(posix.join(posix.dirname(path), request));
      if (publishableSourcePath.test(resolved)) pending.push(resolved);
    }
  }
  return included;
};

/**
 * The operation files Guardian is told an execution loads: the entrypoint's static import closure,
 * a lower bound. A module that could load a file its imports do not name (see `moduleRequests`),
 * or a workspace package manifest, which can map a bare or `#` specifier to any file, keeps every
 * candidate file beside what was reached.
 */
export const executedSourceClosure = (
  workspace: ReadonlyMap<string, string>,
  entrypoint: string,
): ReadonlyMap<string, string> => {
  const included = new Map<string, string>();
  const everyCandidate = () =>
    new Map([
      ...included,
      ...[...workspace].filter(([candidate]) => publishableSourcePath.test(candidate)),
    ]);
  const pending = [entrypoint];
  if ([...workspace.keys()].some((path) => posix.basename(path) === "package.json")) {
    const entry = workspace.get(entrypoint);
    if (entry !== undefined) included.set(entrypoint, entry);
    return everyCandidate();
  }
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    const source = workspace.get(path);
    if (included.has(path) || source === undefined) continue;
    included.set(path, source);
    if (path.endsWith(".json")) continue;
    const requests = moduleRequests(source, path, loaderNames);
    if (requests === undefined) return everyCandidate();
    for (const request of requests.filter(plainRelative))
      pending.push(posix.normalize(posix.join(posix.dirname(path), request)));
  }
  return included;
};
