import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { lunaModel, solModel } from "../../src/models/models.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const codeFiles = (...directories: ReadonlyArray<string>) =>
  execFileSync("git", ["ls-files", ...directories], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((path) => /\.(?:[cm]?[jt]s|json)$/.test(path))
    .map((path) => ({ path, source: readFileSync(`${root}${path}`, "utf8") }));

it("names OpenAI model IDs only in the models file", () => {
  const offenders = codeFiles("typescript/src", "tools").filter(
    ({ path, source }) => path !== "typescript/src/models/models.ts" && /\bgpt-\d/.test(source),
  );
  expect(offenders.map(({ path }) => path)).toEqual([]);
});

// Tests may still pin an older ID on purpose, such as a model the proof meter must reject.
it("refers to the current models in tests only through their constants", () => {
  const current = [solModel, lunaModel].map((id) => id.replaceAll(".", "\\."));
  const literal = new RegExp(`["'\`](?:${current.join("|")})["'\`]`);
  const offenders = codeFiles("typescript/tests").filter(({ source }) => literal.test(source));
  expect(offenders.map(({ path }) => path)).toEqual([]);
});
