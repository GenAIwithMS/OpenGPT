import { expect, test } from "vitest";
import { mintSourceSyntaxFailure } from "../../src/mint/operation-source.js";

test("syntax check reports only position and never evaluates submitted code", () => {
  const source = "globalThis.untrusted = true;\nexport default ); // private-canary";
  const failure = mintSourceSyntaxFailure(source, "src/tool.mjs");
  expect(failure).toContain("line 2, column 16");
  expect(failure).not.toContain("private-canary");
  expect(mintSourceSyntaxFailure("export default {value: 1};", "src/tool.mjs")).toBeUndefined();
  expect(mintSourceSyntaxFailure("/* 😀 */ export default );", "src/tool.mjs")).toContain(
    "line 1, column 25",
  );
  expect(
    mintSourceSyntaxFailure("const value: number = 1; export default value;", "src/tool.ts"),
  ).toBeUndefined();
  expect(Object.hasOwn(globalThis, "untrusted")).toBe(false);
});

test("syntax check gives the minter a fixed refusal with the position", () => {
  expect(mintSourceSyntaxFailure("export default );", "src/tool.mjs")).toBe(
    "Submitted entrypoint has invalid source syntax at line 1, column 16. Correct the source before execution. No code was executed.",
  );
});

// Each expected position is where the parser places the error for the same source and path.
test.each([
  ["a stray parenthesis", "export default );", "src/tool.mjs", "line 1, column 16"],
  ["an error on a later line", "const a = 1;\nconst b = ;\n", "src/tool.mjs", "line 2, column 11"],
  ["Windows line endings", "const a = 1;\r\nconst b = ;\r\n", "src/tool.mjs", "line 2, column 11"],
  [
    "an emoji and accents before the error",
    "const s = 'é😀';\nconst t = '😀'; )",
    "src/tool.mjs",
    "line 2, column 17",
  ],
  ["a byte order mark", "﻿export default );", "src/tool.mjs", "line 1, column 17"],
  [
    "a hashbang line",
    "#!/usr/bin/env node\nexport default );",
    "src/tool.mjs",
    "line 2, column 16",
  ],
  [
    "a type annotation in JavaScript",
    "let typed: number = 1;\nexport default typed;",
    "src/tool.mjs",
    "line 1, column 10",
  ],
  [
    "a type annotation in TypeScript",
    "let typed: number = 1;\nexport default typed;",
    "src/tool.ts",
    undefined,
  ],
  [
    "a type assertion in a .mts module",
    "const y = 1;\nconst x = <number>y;",
    "src/tool.mts",
    undefined,
  ],
  [
    "an export name with a lone surrogate",
    'const a = 1; export { a as "\\uD800" };',
    "src/tool.mjs",
    "line 1, column 28",
  ],
  ["an HTML-like comment in a module", "x = 1;\n--> comment", "src/tool.mjs", "line 2, column 3"],
  ["an unterminated template", "const s = `open\nstill open", "src/tool.mjs", "line 1, column 11"],
  [
    "an error at the end of a long line",
    `const a = [${"1,".repeat(5_000)};`,
    "src/tool.mjs",
    "line 1, column 10012",
  ],
  [
    "top-level await",
    "const value = await Promise.resolve(1);\nexport default value;",
    "src/tool.mjs",
    undefined,
  ],
  ["a redeclared binding", "const a = 1;\nconst a = 2;", "src/tool.mjs", undefined],
  [
    "two default exports",
    "export default 1;\nexport default 2;",
    "src/tool.mjs",
    "line 1, column 8",
  ],
  [
    "assigning arguments in strict code",
    "export default function () { arguments = 1; }",
    "src/tool.mjs",
    undefined,
  ],
  ["an empty file", "", "src/tool.mjs", undefined],
  ["a JSON file's path", '{"a": 1}', "src/data.json", "line 1, column 5"],
] as const)("syntax check places %s", (_name, source, path, position) => {
  const failure = mintSourceSyntaxFailure(source, path);
  expect(/line \d+, column \d+/u.exec(failure ?? "")?.[0]).toBe(position);
});
