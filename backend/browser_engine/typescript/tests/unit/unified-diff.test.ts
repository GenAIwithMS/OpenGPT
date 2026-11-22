import { describe, expect, it } from "vitest";
import { unifiedDiff } from "../../src/guardian/unified-diff.js";

interface Line {
  readonly text: string;
  readonly newline: boolean;
}
const linesOf = (text: string): Line[] => {
  if (text === "") return [];
  const parts = text.split("\n");
  const newline = parts.at(-1) === "";
  if (newline) parts.pop();
  return parts.map((part, index) => ({ text: part, newline: newline || index < parts.length - 1 }));
};
const marker = "\\ No newline at end of file";

/**
 * Applies a unified diff to `before`, checking every context and removed line against it, as
 * `patch` would. Throws on a hunk that does not match.
 */
const apply = (before: string, diff: string): string => {
  const source = linesOf(before);
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const out: Line[] = [];
  let at = 0;
  let index = 2;
  while (index < lines.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/u.exec(lines[index] ?? "");
    if (header === null) throw new Error(`Bad hunk header: ${lines[index]}`);
    const beforeCount = header[2] === undefined ? 1 : Number(header[2]);
    const beforeStart = Number(header[1]) - (beforeCount === 0 ? 0 : 1);
    while (at < beforeStart) out.push(source[at++] as Line);
    index++;
    while (index < lines.length && !(lines[index] ?? "").startsWith("@@")) {
      const line = lines[index] ?? "";
      const bare = lines[index + 1] === marker;
      const kind = line[0];
      const text = line.slice(1);
      if (kind !== "+") {
        const kept = source[at++];
        if (kept?.text !== text || kept.newline === bare)
          throw new Error(`Context mismatch at ${at}: ${text}`);
      }
      if (kind !== "-") out.push({ text, newline: !bare });
      index += bare ? 2 : 1;
    }
  }
  while (at < source.length) out.push(source[at++] as Line);
  return out.map((line) => `${line.text}${line.newline ? "\n" : ""}`).join("");
};

/** A deterministic generator, so a failing case can be replayed. */
const generator = (seed: number) => {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
};

describe("a unified diff", () => {
  it("is empty for the same text", () => {
    expect(unifiedDiff("a.txt", "one\ntwo\n", "one\ntwo\n")).toBe("");
  });

  it("keeps three lines of context and numbers each hunk from its first line", () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
    const after = before.replace("line 10\n", "line ten\n");
    expect(unifiedDiff("a.txt", before, after)).toBe(
      [
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -7,7 +7,7 @@",
        " line 7",
        " line 8",
        " line 9",
        "-line 10",
        "+line ten",
        " line 11",
        " line 12",
        " line 13",
        "",
      ].join("\n"),
    );
  });

  it("splits changes far apart into separate hunks and joins near ones", () => {
    const before = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
    const after = before
      .replace("line 2\n", "line two\n")
      .replace("line 5\n", "line five\n")
      .replace("line 30\n", "line thirty\n");
    const hunks = (unifiedDiff("a.txt", before, after) ?? "")
      .split("\n")
      .filter((line) => line.startsWith("@@"));
    expect(hunks).toEqual(["@@ -1,8 +1,8 @@", "@@ -27,7 +27,7 @@"]);
  });

  it("marks a last line without a newline, and an insertion into an empty file", () => {
    expect(unifiedDiff("a.txt", "one\ntwo", "one\ntwo\n")).toBe(
      [
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1,2 +1,2 @@",
        " one",
        "-two",
        "\\ No newline at end of file",
        "+two",
        "",
      ].join("\n"),
    );
    expect(unifiedDiff("a.txt", "", "new\n")).toBe(
      ["--- a/a.txt", "+++ b/a.txt", "@@ -0,0 +1 @@", "+new", ""].join("\n"),
    );
  });

  it("reproduces the new text when applied, for random edits", () => {
    const random = generator(7);
    const words = ["alpha", "beta", "gamma", "delta", "", "  indented"];
    const text = (length: number) =>
      Array.from({ length }, () => words[Math.floor(random() * words.length)]).join("\n");
    for (let round = 0; round < 300; round++) {
      const before = text(Math.floor(random() * 30)) + (random() < 0.5 ? "\n" : "");
      const lines = before.split("\n");
      for (let edit = Math.floor(random() * 6); edit > 0; edit--) {
        const at = Math.floor(random() * (lines.length + 1));
        if (random() < 0.5) lines.splice(at, 1);
        else lines.splice(at, 0, words[Math.floor(random() * words.length)] ?? "");
      }
      const after = lines.join("\n");
      const diff = unifiedDiff("a.txt", before, after);
      expect(diff, JSON.stringify({ before, after })).toBeDefined();
      expect(apply(before, diff ?? ""), JSON.stringify({ before, after, diff })).toBe(after);
    }
  });

  it("gives up on a change too large to be worth a diff", () => {
    const before = Array.from({ length: 3000 }, (_, index) => `old ${index}`).join("\n");
    const after = Array.from({ length: 3000 }, (_, index) => `new ${index}`).join("\n");
    expect(unifiedDiff("a.txt", before, after)).toBeUndefined();
  });
});
