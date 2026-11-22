/**
 * A line diff in unified format, for a later publication review to read what changed in a file
 * since its earlier round rather than the whole file again.
 */

/** Lines of context kept around each change, as `diff -u` keeps. */
const contextLines = 3;
/** The most edits the diff searches for; past it the change is too large to be worth a diff. */
const maximumEdits = 1000;

/** One line and whether a newline ends it; only a file's last line may lack one. */
interface Line {
  readonly text: string;
  readonly newline: boolean;
}

const linesOf = (text: string): Line[] => {
  if (text === "") return [];
  const parts = text.split("\n");
  const newline = parts.at(-1) === "";
  if (newline) parts.pop();
  return parts.map((part, index) => ({
    text: part,
    newline: newline || index < parts.length - 1,
  }));
};

const same = (a: Line, b: Line) => a.text === b.text && a.newline === b.newline;

type Edit =
  | { readonly kind: "equal"; readonly before: number; readonly after: number }
  | { readonly kind: "delete"; readonly before: number }
  | { readonly kind: "insert"; readonly after: number };

/**
 * The shortest edit script from `before` to `after` by Myers' O(ND) search, or undefined when it
 * needs more than `maximumEdits` edits. Each round keeps only the diagonals it reached, so the
 * trace holds O(D²) offsets rather than O(D·N).
 */
const editScript = (before: readonly Line[], after: readonly Line[]): Edit[] | undefined => {
  const n = before.length;
  const m = after.length;
  const limit = Math.min(n + m, maximumEdits);
  // v[k + offset] is the furthest x reached on diagonal k.
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && same(before[x] as Line, after[y] as Line)) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return undefined;
  // Walk back from the end through each round's saved diagonals.
  const edits: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const saved = trace[d] as Int32Array;
    // saved[i] holds diagonal i - d - 1 as it stood before round d.
    const at = (k: number) => saved[k + d + 1] ?? 0;
    const k = x - y;
    if (d === 0) {
      while (x > 0 && y > 0) edits.push({ kind: "equal", before: --x, after: --y });
      break;
    }
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) edits.push({ kind: "equal", before: --x, after: --y });
    if (down) edits.push({ kind: "insert", after: --y });
    else edits.push({ kind: "delete", before: --x });
  }
  return edits.reverse();
};

const noNewline = "\\ No newline at end of file";
const shown = (prefix: string, line: Line) =>
  line.newline ? [`${prefix}${line.text}`] : [`${prefix}${line.text}`, noNewline];
const range = (start: number, count: number) =>
  count === 1 ? `${start}` : `${count === 0 ? start - 1 : start},${count}`;

/**
 * The unified diff from `before` to `after` under `path`, with three lines of context; empty
 * when they are the same text. Undefined when the change needs more edits than the diff searches,
 * which only a change larger than the file's own text would.
 */
export const unifiedDiff = (path: string, before: string, after: string): string | undefined => {
  if (before === after) return "";
  const old = linesOf(before);
  const current = linesOf(after);
  const edits = editScript(old, current);
  if (edits === undefined) return undefined;
  const changed = edits.flatMap((edit, index) => (edit.kind === "equal" ? [] : [index]));
  const hunks: { start: number; end: number }[] = [];
  for (const index of changed) {
    const start = Math.max(0, index - contextLines);
    const end = Math.min(edits.length, index + contextLines + 1);
    const last = hunks.at(-1);
    if (last !== undefined && start <= last.end) last.end = Math.max(last.end, end);
    else hunks.push({ start, end });
  }
  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (const { start, end } of hunks) {
    const slice = edits.slice(start, end);
    // A hunk's line numbers count from the first line on each side it touches or would follow.
    let beforeStart = 0;
    let afterStart = 0;
    for (const edit of edits.slice(0, start)) {
      if (edit.kind !== "insert") beforeStart++;
      if (edit.kind !== "delete") afterStart++;
    }
    const beforeCount = slice.filter((edit) => edit.kind !== "insert").length;
    const afterCount = slice.filter((edit) => edit.kind !== "delete").length;
    out.push(`@@ -${range(beforeStart + 1, beforeCount)} +${range(afterStart + 1, afterCount)} @@`);
    for (const edit of slice)
      out.push(
        ...(edit.kind === "equal"
          ? shown(" ", current[edit.after] as Line)
          : edit.kind === "delete"
            ? shown("-", old[edit.before] as Line)
            : shown("+", current[edit.after] as Line)),
      );
  }
  return `${out.join("\n")}\n`;
};
