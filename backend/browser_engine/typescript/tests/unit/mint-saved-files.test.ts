import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import {
  executedSourceClosure,
  runnableOperationFiles,
  savedOperationFiles,
} from "../../src/mint/operation-source.js";

/** The paths a local build saves from `files` for `entrypoint`, sorted. */
const saved = (files: Readonly<Record<string, string>>, entrypoint = "src/tool.mjs") =>
  [...savedOperationFiles(new Map(Object.entries(files)), entrypoint).keys()].sort();

const workspace = {
  "src/tool.mjs": 'import { query } from "./query.mjs";\nexport default query;',
  "src/query.mjs": "export const query = 1;",
  "explore/look.mjs": "export const look = 1;",
  "test/check.mjs": "export const check = 1;",
  "scratch/notes.txt": "notes",
  "skills/publication/SKILL.md": "not source",
  "captures/page.html": "<p>capture</p>",
};
/** Every file under src/, explore/, test/ and scratch/ in `workspace`. */
const everyCandidate = [
  "explore/look.mjs",
  "scratch/notes.txt",
  "src/query.mjs",
  "src/tool.mjs",
  "test/check.mjs",
];

describe("the files a local build saves", () => {
  it("keeps every file under src/, whatever its extension, and no probe nothing imports", () => {
    expect(
      saved({
        ...workspace,
        "src/query.graphql": "query { reports }",
        "src/util.cjs": "module.exports = { pad: (value) => value };",
        "src/shape.mts": "export const shape = 1;",
        "src/labels.txt": "Reports",
      }),
    ).toEqual([
      "src/labels.txt",
      "src/query.graphql",
      "src/query.mjs",
      "src/shape.mts",
      "src/tool.mjs",
      "src/util.cjs",
    ]);
  });

  it("follows the entrypoint's imports into explore/, test/ and scratch/, whatever their extension", () => {
    expect(
      saved({
        ...workspace,
        "src/tool.mjs": [
          'import { pad } from "../explore/pad.cjs";',
          'import { shape } from "../scratch/shape.mts";',
          'const data = await import("../test/data.json", { with: { type: "json" } });',
          "export default [pad, shape, data];",
        ].join("\n"),
        "explore/pad.cjs": "module.exports = { pad: (value) => value };",
        "scratch/shape.mts": 'export { shape } from "./shape-value.mts";',
        "scratch/shape-value.mts": "export const shape = 1;",
        "test/data.json": "{}",
      }),
    ).toEqual([
      "explore/pad.cjs",
      "scratch/shape-value.mts",
      "scratch/shape.mts",
      "src/query.mjs",
      "src/tool.mjs",
      "test/data.json",
    ]);
  });

  // Node loads an extensionless file in a module scope as ESM, so its own imports are followed.
  it("follows the imports of an extensionless module", () => {
    expect(
      saved({
        ...workspace,
        "src/tool.mjs": 'import { helper } from "../explore/helper";\nexport default helper;',
        "explore/helper": 'import { other } from "./other.js";\nexport const helper = other;',
        "explore/other.js": "export const other = 1;",
      }),
    ).toEqual(["explore/helper", "explore/other.js", "src/query.mjs", "src/tool.mjs"]);
  });

  it("keeps every candidate file when an extensionless file is not JavaScript", () => {
    expect(saved({ ...workspace, "src/NOTES": "Read the reports page first." })).toEqual(
      [...everyCandidate, "src/NOTES"].sort(),
    );
  });

  it("does not follow an import of the host's runtime or a file outside the four folders", () => {
    expect(
      saved({
        ...workspace,
        "src/tool.mjs": [
          'import { defineOperation } from "../runtime/index.js";',
          'import { note } from "../skills/note.mjs";',
          "export default defineOperation(note);",
        ].join("\n"),
        "skills/note.mjs": "export const note = 1;",
      }),
    ).toEqual(["src/query.mjs", "src/tool.mjs"]);
  });

  it("keeps an entrypoint outside src/ with the files it imports", () => {
    expect(
      saved(
        { ...workspace, "explore/run.mjs": 'export { look } from "./look.mjs";' },
        "explore/run.mjs",
      ),
    ).toEqual(["explore/look.mjs", "explore/run.mjs", "src/query.mjs", "src/tool.mjs"]);
  });

  it.each([
    [
      "reads a file with fs",
      'import { readFileSync } from "node:fs";\nexport default readFileSync(new URL("../explore/data.json", import.meta.url), "utf8");',
    ],
    [
      "loads a module with createRequire",
      'import { createRequire } from "node:module";\nexport default createRequire(import.meta.url)("../explore/look.mjs");',
    ],
    ["imports a package path", 'import data from "#data";\nexport default data;'],
    [
      "imports a computed path",
      'const name = "look";\nexport default await import(`../explore/${name}.mjs`);',
    ],
  ])("keeps every candidate file when a saved module %s", (_case, source) => {
    expect(saved({ ...workspace, "src/tool.mjs": source })).toEqual(everyCandidate);
  });

  it("keeps every candidate file when a module the entrypoint imports uses a loader", () => {
    expect(
      saved({
        ...workspace,
        "src/tool.mjs": 'import { look } from "../explore/look.mjs";\nexport default look;',
        "explore/look.mjs": 'import fs from "node:fs";\nexport const look = fs.readFileSync;',
      }),
    ).toEqual(everyCandidate);
  });

  it("keeps every candidate file when the workspace has a package manifest", () => {
    expect(saved({ ...workspace, "src/package.json": '{"imports":{"#q":"./query.mjs"}}' })).toEqual(
      [...everyCandidate, "src/package.json"].sort(),
    );
  });

  // macOS file systems ignore letter case and Unicode normalization by default.
  it("keeps every candidate file when a package manifest's name differs in letter case", () => {
    expect(saved({ ...workspace, "scratch/Package.JSON": "{}" })).toEqual(
      [...everyCandidate, "scratch/Package.JSON"].sort(),
    );
  });

  it("follows an import whose path differs in letter case or Unicode normalization", () => {
    expect(
      saved({
        ...workspace,
        "src/tool.mjs":
          'import { look } from "../Explore/LOOK.mjs";\nimport { cafe } from "../explore/caf\u00e9.mjs";\nexport default [look, cafe];',
        "explore/cafe\u0301.mjs": "export const cafe = 1;",
      }),
    ).toEqual(["explore/cafe\u0301.mjs", "explore/look.mjs", "src/query.mjs", "src/tool.mjs"]);
  });
});

/** The paths of saved files the operation could run, sorted. */
const runnable = (files: Readonly<Record<string, string>>, entrypoint = "src/tool.mjs") =>
  [...runnableOperationFiles(new Map(Object.entries(files)), entrypoint).keys()].sort();
/** Whether a path is under one of the four folders a local build saves from. */
const isCandidate = (path: string) => /^(src|explore|test|scratch)\//u.test(path);
/** A probe that holds a secret handle. */
const handleProbe = 'export const look = "{{secret.s1}}";';

describe("the saved files the operation could run", () => {
  it("are the saved files when every one is reached through imports", () => {
    const files = {
      ...workspace,
      "src/tool.mjs": 'import { pad } from "../explore/pad.cjs";\nexport default pad;',
      "explore/pad.cjs": "module.exports = { pad: 1 };",
    };
    expect(runnable(files)).toEqual(saved(files));
  });

  // A manifest saves every candidate as a precaution. One without exports names no file for the
  // package's own name, so a probe no import names is not run.
  it("leave out a probe saved only beside a package manifest without exports", () => {
    const files = { ...workspace, "scratch/package.json": "{}" };
    expect(saved(files)).toContain("explore/look.mjs");
    expect(runnable(files)).toEqual(["src/query.mjs", "src/tool.mjs"]);
  });

  it.each([
    [
      "reads a file with fs",
      'import { readFileSync } from "node:fs";\nexport default readFileSync(new URL("../explore/data.json", import.meta.url), "utf8");',
    ],
    ["imports a package path", 'import data from "#data";\nexport default data;'],
    [
      "imports a computed path",
      'const name = "look";\nexport default await import(`../explore/${name}.mjs`);',
    ],
  ])("are every saved file when a module the operation runs %s", (_case, source) => {
    expect(runnable({ ...workspace, "src/tool.mjs": source })).toEqual(everyCandidate);
  });
  // Each is a way Node loads a saved file that no import the walker follows names.
  it.each([
    [
      "a saved manifest's exports serve an import of the package's own name",
      {
        "src/tool.mjs": 'import { run } from "../explore/run.mjs";\nexport default run;',
        "explore/package.json": '{"name":"probes","exports":{"./look":"./look.mjs"}}',
        "explore/run.mjs": 'export { look as run } from "probes/look";',
      },
    ],
    ["a saved manifest does not parse", { "scratch/package.json": '{"name":' }],
    [
      "a saved folder holds node_modules",
      {
        "src/tool.mjs": 'import { look } from "../explore/run.mjs";\nexport default look;',
        "explore/run.mjs": 'export { look } from "helper";',
        "explore/node_modules/helper/index.js": 'export { look } from "../../look.mjs";',
      },
    ],
    [
      "the operation reaches a WebAssembly module",
      {
        "src/tool.mjs": 'import { look } from "../explore/look.wasm";\nexport default look;',
        "explore/look.wasm": "\u0000asm",
      },
    ],
    ["the operation reaches a native addon", { "src/addon.node": "native" }],
    [
      "a CommonJS module calls its wrapper's require through arguments",
      {
        "src/tool.mjs": 'import look from "./look.cjs";\nexport default look;',
        "src/look.cjs": 'module.exports = arguments[1]("../explore/look.mjs");',
      },
    ],
    [
      "an arrow function in a CommonJS module reaches its wrapper's require through arguments",
      {
        "src/tool.mjs": 'import look from "./look.cjs";\nexport default look;',
        "src/look.cjs": 'module.exports = (() => arguments[1]("../explore/look.mjs"))();',
      },
    ],
    [
      "a saved manifest named in another letter case declares exports",
      {
        "src/tool.mjs": 'import { run } from "../explore/run.mjs";\nexport default run;',
        "explore/PACKAGE.JSON": '{"name":"probes","exports":{"./look":"./look.mjs"}}',
        "explore/run.mjs": 'export { look as run } from "probes/look";',
      },
    ],
    [
      "a saved folder holds node_modules in another letter case",
      {
        "src/tool.mjs": 'import { look } from "../explore/run.mjs";\nexport default look;',
        "explore/run.mjs": 'export { look } from "helper";',
        "explore/Node_Modules/helper/index.js": 'export { look } from "../../look.mjs";',
      },
    ],
    [
      "the operation imports Playwright's internal modules, which run a test config",
      {
        "src/tool.mjs":
          'import { program } from "playwright/lib/program";\nexport default () => program.parseAsync(["node", "pw", "test", "-c", "scratch/pw.config.mjs"]);',
        "scratch/pw.config.mjs": 'export default { testDir: "../explore" };',
      },
    ],
    [
      "the operation imports Playwright's internal modules in another letter case",
      {
        "src/tool.mjs":
          'const { runAllTestsWithConfig } = await import("Playwright/lib/runner");\nexport default runAllTestsWithConfig;',
      },
    ],
  ])("are every saved file when %s", (_case, files) => {
    const all = { ...workspace, ...files };
    const every = Object.keys(all)
      .filter((path) => /^(src|explore|test|scratch)\//u.test(path))
      .sort();
    expect(runnable(all)).toEqual(every);
  });

  // A function's own arguments are its callers' values, never a CommonJS wrapper's require.
  it("leave out a probe when a module reads a function's own arguments", () => {
    const files = {
      ...workspace,
      "src/tool.mjs": [
        "function first() {",
        "  return arguments[0];",
        "}",
        "const list = { all() { return [...arguments]; } };",
        "export default [first, list];",
      ].join("\n"),
      "explore/look.mjs": 'export const look = "{{secret.s1}}";',
    };
    expect(runnable(files)).toEqual(["src/query.mjs", "src/tool.mjs"]);
    expect(saved(files)).toEqual(["src/query.mjs", "src/tool.mjs"]);
  });

  // A stack frame's getFunction() can return a CommonJS module's wrapper, whose own arguments hold
  // its require. Read straight off a call's result, a property named arguments still counts.
  it.each([
    ["off a call", "src/look.cjs", "frame.getFunction().arguments[1]"],
    ["off an optional call", "src/look.cjs", "frame.getFunction?.().arguments[1]"],
    ["off an optional call in parentheses", "src/look.cjs", "(frame?.getFunction()).arguments[1]"],
    ["off a call in parentheses", "src/look.cjs", "(frame.getFunction()).arguments[1]"],
    ["by a computed key", "src/look.cjs", 'frame.getFunction()["arguments"][1]'],
    ["off a non-null call", "src/look.cts", "frame.getFunction()!.arguments[1]"],
    ["off a call cast with as", "src/look.cts", "(frame.getFunction() as any).arguments[1]"],
    [
      "off a call cast with satisfies",
      "src/look.cts",
      "(frame.getFunction() satisfies unknown).arguments[1]",
    ],
    [
      "off a call cast with angle brackets",
      "src/look.cts",
      "(<any>frame.getFunction()).arguments[1]",
    ],
  ])(
    "are every saved file when a CommonJS module reads its wrapper's arguments %s",
    (_case, path, read) => {
      const all = {
        ...workspace,
        "src/tool.mjs": `import look from "./${posix.basename(path)}";\nexport default look;`,
        [path]: [
          "Error.prepareStackTrace = (_, frames) => frames;",
          "const frame = new Error().stack[0];",
          `module.exports = ${read}("../explore/look.mjs");`,
        ].join("\n"),
      };
      expect(runnable(all)).toEqual(Object.keys(all).filter(isCandidate).sort());
    },
  );

  // As a property or key, arguments names a value's own field, never a CommonJS wrapper's
  // arguments; a TypeScript type or abstract member never runs. The first two are shaped like the
  // package's own Guardian reviewer and MCP job code.
  it.each([
    [
      "reads a tool call's arguments through optional chaining in a top-level arrow",
      "src/tool.mjs",
      [
        "export const reviewer = (diagnostics) => ({",
        "  execute: async (input, _context, details) =>",
        '    diagnostics.tool({ name: "read_source", arguments: details?.toolCall?.arguments ?? JSON.stringify(input) }),',
        "});",
      ].join("\n"),
    ],
    [
      "declares a TypeScript field named arguments",
      "src/tool.ts",
      [
        "export interface JobView {",
        "  readonly job_id: string;",
        "  readonly next?: { readonly tool: string; readonly arguments: Record<string, unknown> };",
        "}",
        'export default (id: string): JobView => ({ job_id: id, next: { tool: "get_job", arguments: { job_id: id } } });',
      ].join("\n"),
    ],
    [
      "reads a member named arguments at the top level",
      "src/tool.mjs",
      'const call = { function: { arguments: "[]" } };\nexport default JSON.parse(call.function.arguments);',
    ],
    [
      "reads a computed key named arguments",
      "src/tool.mjs",
      'export default (call) => call["arguments"];',
    ],
    [
      "declares a TypeScript method signature named arguments",
      "src/tool.ts",
      "export interface Call { arguments(): string }\nexport default (call: Call) => call.arguments();",
    ],
    [
      "declares an abstract field named arguments",
      "src/tool.ts",
      "export default abstract class Call { abstract arguments: string; }",
    ],
    [
      "declares an abstract method named arguments",
      "src/tool.ts",
      "export default abstract class Call { abstract arguments(): string; }",
    ],
  ])("leave out a probe when a module %s", (_case, path, source) => {
    const all = { ...workspace, [path]: source, "explore/look.mjs": handleProbe };
    expect(runnable(all, path)).toEqual(
      Object.keys(all)
        .filter((file) => file.startsWith("src/"))
        .sort(),
    );
  });

  // Node keeps a manifest's exports inside its own folder, so one under src/ maps only files under
  // src/, which are read anyway.
  it.each([
    ["declares exports", '{"name":"op","exports":{"./query":"./query.mjs"}}'],
    ["does not parse", '{"name":'],
  ])("leave out a probe beside a manifest under src/ that %s", (_case, manifest) => {
    const files = {
      ...workspace,
      "src/tool.mjs": 'import { query } from "op/query";\nexport default query;',
      "src/package.json": manifest,
      "explore/look.mjs": handleProbe,
    };
    expect(runnable(files)).toEqual(["src/package.json", "src/query.mjs", "src/tool.mjs"]);
  });
});

describe("the operation files Guardian is told an execution loads", () => {
  // The package exports this closure for other hosts: the save rule's own loaders leave it narrow.
  it.each([
    [
      "a CommonJS module calls its wrapper's require through arguments",
      {
        "src/tool.mjs": 'import look from "./look.cjs";\nexport default look;',
        "src/look.cjs": 'module.exports = arguments[1]("../explore/look.mjs");',
      },
      ["src/look.cjs", "src/tool.mjs"],
    ],
    [
      "the operation imports Playwright's internal modules",
      {
        "src/tool.mjs":
          'import { program } from "playwright/lib/program";\nexport default program;',
      },
      ["src/tool.mjs"],
    ],
  ])("are the entrypoint's imports when %s", (_case, files, expected) => {
    const closure = executedSourceClosure(
      new Map(Object.entries({ ...workspace, ...files })),
      "src/tool.mjs",
    );
    expect([...closure.keys()].sort()).toEqual(expected);
  });
});
