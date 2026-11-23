/**
 * Execution results as the minting agent receives them. A result whose screened text fits in
 * `resultDigestThresholdBytes` comes back whole. A larger one is saved whole to a read-only
 * workspace file and comes back as a digest: its size, its shape with every array's length, its
 * first items and the file's path, which the agent reads with `read_source` or searches with `rg`.
 * A failed result's text, and every error or stack field of a completed one, stay whole up to a
 * fixed budget, so a digest rarely hides why something failed. A digest never exceeds
 * `resultDigestMaxBytes` or the result's own size; a result it cannot shrink comes back whole.
 */

/** The largest result, in UTF-8 bytes of its screened text, that comes back whole. */
export const resultDigestThresholdBytes = 16 * 1024;

/**
 * The parts of a digest and their budgets, in UTF-8 bytes: the shape, the preview, the error
 * fields (or a failed result's excerpt) and the envelope's fixed text and path. A digest never
 * exceeds `resultDigestMaxBytes`, which holds the parts' budgets with room to spare, and is never
 * larger than the result it stands for.
 */
const previewBytes = 4 * 1024;
const shapeBytes = 4 * 1024;
const errorBytes = 12 * 1024;
export const resultDigestMaxBytes = 24 * 1024;
/**
 * The most bytes any result reaches the agent in, whatever the path: the model provider rejects
 * a turn that carries far more. A result that cannot be digested comes back through
 * `boundedResult`, never whole above the threshold.
 */
export const resultHardCapBytes = 64 * 1024;
/** The longest key name a shape or an error path keeps. */
const maxKeyChars = 64;
/** The most error fields a digest lists. */
const maxErrorFields = 20;
/** The most fields an object's shape or preview lists. */
const maxFields = 40;
/** The most array items whose shapes merge into the array's item shape. */
const shapeSampleItems = 20;

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).byteLength;

/** `text` within `bytes` UTF-8 bytes, cut on a character, with a marker when it was cut. */
const cut = (text: string, bytes: number) => {
  const encoded = encoder.encode(text);
  if (encoded.byteLength <= bytes) return text;
  // A character the cut splits decodes to one replacement character, which is dropped.
  const kept = new TextDecoder().decode(encoded.subarray(0, bytes)).replace(/�$/u, "");
  return `${kept}…[cut at ${bytes} of ${encoded.byteLength} bytes]`;
};

const shortKey = (key: string) =>
  key.length <= maxKeyChars ? key : `${key.slice(0, maxKeyChars)}…`;

/**
 * A result the host could not save or digest: whole within the threshold, else its first
 * `resultDigestThresholdBytes` bytes with its size and a note that the rest was not kept.
 */
export const boundedResult = (text: string) => {
  const totalBytes = byteLength(text);
  if (totalBytes <= resultDigestThresholdBytes) return text;
  return JSON.stringify({
    kind: "result_truncated",
    totalBytes,
    note: `This result is ${totalBytes} bytes and the full output could not be saved, so only its first ${resultDigestThresholdBytes} bytes are shown. Run again with a narrower read if you need the rest.`,
    excerpt: cut(text, resultDigestThresholdBytes),
  });
};

/** Where a digested result is saved: one file per execution, so a takeover rewrites the same. */
export const resultDigestPath = (executionId: string) =>
  `captures/results/${executionId.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 120)}.json`;

type Shape =
  | string
  | {
      readonly type: "array";
      readonly length: number | string;
      readonly items?: Shape;
    }
  | {
      readonly type: "object";
      readonly fields: Readonly<Record<string, Shape>>;
      readonly moreFields?: number;
      readonly nullable?: true;
    };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const scalarType = (value: unknown) =>
  value === null ? "null" : typeof value === "number" ? "number" : typeof value;

const lengthRange = (left: number | string, right: number | string) => {
  const bounds = [left, right].flatMap((value) => String(value).split("-").map(Number));
  const low = Math.min(...bounds);
  const high = Math.max(...bounds);
  return low === high ? low : `${low}-${high}`;
};

const mergeShapes = (left: Shape, right: Shape): Shape => {
  if (typeof left === "string" && typeof right === "string")
    return left === right
      ? left
      : [...new Set([...left.split("|"), ...right.split("|")])].sort().join("|");
  if (left === "null" && typeof right !== "string")
    return { ...right, ...(right.type === "object" ? { nullable: true } : {}) };
  if (right === "null" && typeof left !== "string") return mergeShapes(right, left);
  if (typeof left === "string" || typeof right === "string" || left.type !== right.type)
    return "mixed";
  if (left.type === "array" && right.type === "array") {
    const items =
      left.items === undefined
        ? right.items
        : right.items === undefined
          ? left.items
          : mergeShapes(left.items, right.items);
    return {
      type: "array",
      length: lengthRange(left.length, right.length),
      ...(items === undefined ? {} : { items }),
    };
  }
  if (left.type !== "object" || right.type !== "object") return "mixed";
  const fields: Record<string, Shape> = { ...left.fields };
  let more = (left.moreFields ?? 0) + (right.moreFields ?? 0);
  for (const [key, shape] of Object.entries(right.fields)) {
    const known = fields[key];
    if (known !== undefined) fields[key] = mergeShapes(known, shape);
    else if (Object.keys(fields).length < maxFields) fields[key] = shape;
    else more += 1;
  }
  return {
    type: "object",
    fields,
    ...(more > 0 ? { moreFields: more } : {}),
    ...(left.nullable || right.nullable ? { nullable: true as const } : {}),
  };
};

/** The value's shape: each object's fields, each array's length and item shape, to `depth`. */
const shapeOf = (value: unknown, depth: number): Shape => {
  if (Array.isArray(value)) {
    if (depth <= 0) return { type: "array", length: value.length };
    const sampled = value.slice(0, shapeSampleItems).map((item) => shapeOf(item, depth - 1));
    const items = sampled.reduce<Shape | undefined>(
      (merged, shape) => (merged === undefined ? shape : mergeShapes(merged, shape)),
      undefined,
    );
    return { type: "array", length: value.length, ...(items === undefined ? {} : { items }) };
  }
  if (!isRecord(value)) return scalarType(value);
  const keys = Object.keys(value);
  if (depth <= 0) return { type: "object", fields: {}, moreFields: keys.length };
  const fields: Record<string, Shape> = {};
  for (const key of keys.slice(0, maxFields)) fields[shortKey(key)] = shapeOf(value[key], depth - 1);
  return {
    type: "object",
    fields,
    ...(keys.length > maxFields ? { moreFields: keys.length - maxFields } : {}),
  };
};

/** The deepest shape that fits its budget; at worst the top level's size alone. */
const boundedShape = (value: unknown): Shape => {
  for (const depth of [6, 4, 3, 2]) {
    const shape = shapeOf(value, depth);
    if (byteLength(JSON.stringify(shape)) <= shapeBytes) return shape;
  }
  return shapeOf(value, 0);
};

/** A copy with each array cut to its first `items` and each string to `chars`, each marked. */
const pruned = (value: unknown, items: number, chars: number, depth = 0): unknown => {
  if (typeof value === "string")
    return value.length <= chars
      ? value
      : `${value.slice(0, chars)}…[+${value.length - chars} chars]`;
  if (depth >= 8 && (Array.isArray(value) || isRecord(value))) return "…";
  if (Array.isArray(value)) {
    const kept = value.slice(0, items).map((item) => pruned(item, items, chars, depth + 1));
    return value.length > items ? [...kept, `…${value.length - items} more items`] : kept;
  }
  if (!isRecord(value)) return value;
  const keys = Object.keys(value);
  const copy: Record<string, unknown> = {};
  for (const key of keys.slice(0, maxFields))
    copy[key] = pruned(value[key], items, chars, depth + 1);
  if (keys.length > maxFields) copy["…"] = `${keys.length - maxFields} more fields`;
  return copy;
};

/** The first items of a completed result, as JSON when it fits the preview budget. */
const previewOf = (value: unknown) => {
  let text = "";
  for (const [items, chars] of [
    [5, 300],
    [3, 120],
    [1, 60],
  ] as const) {
    const preview = pruned(value, items, chars);
    text = JSON.stringify(preview);
    if (byteLength(text) <= previewBytes) return { preview };
  }
  return { previewText: cut(text, previewBytes) };
};

/** A completed result's error fields; a failed result's also include its message and reason. */
const errorKey = /error|stack|stderr|exception/iu;
const failureKey = /error|stack|stderr|exception|message|reason/iu;

/**
 * A result's error fields, outside arrays and to three levels deep, each whole while together
 * with their paths they fit the error budget, at most `maxErrorFields` of them. `omitted` counts
 * the fields left out.
 */
const errorFields = (value: unknown, errorKey: RegExp) => {
  const found: { path: string; text: string }[] = [];
  const visit = (current: unknown, path: string, depth: number) => {
    if (!isRecord(current) || depth > 3) return;
    for (const [key, field] of Object.entries(current)) {
      const at = path === "" ? shortKey(key) : `${path}.${shortKey(key)}`;
      if (errorKey.test(key) && field !== null && field !== undefined && field !== "") {
        const text = typeof field === "string" ? field : JSON.stringify(field);
        if (text !== undefined) found.push({ path: at, text });
      } else visit(field, at, depth + 1);
    }
  };
  visit(value, "", 1);
  let room = errorBytes;
  const kept: { path: string; text: string }[] = [];
  for (const entry of found) {
    room -= byteLength(entry.path);
    if (room <= 0 || kept.length >= maxErrorFields) break;
    const text = cut(entry.text, room);
    room -= byteLength(text);
    kept.push({ path: entry.path, text });
  }
  return { kept, omitted: found.length - kept.length };
};

/**
 * A parsed result's first items and its error fields. A failed result that names no error field
 * keeps its text up to the threshold instead.
 */
const detailOf = (value: unknown, text: string, failed: boolean) => {
  const { kept: errors, omitted } = errorFields(value, failed ? failureKey : errorKey);
  if (failed && errors.length === 0) return { excerpt: cut(text, errorBytes) };
  return {
    ...previewOf(value),
    ...(errors.length > 0 ? { errors } : {}),
    ...(omitted > 0 ? { omittedErrors: omitted } : {}),
  };
};

const parseJson = (text: string): { readonly value: unknown } | undefined => {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
};

/**
 * The screened result text as the agent receives it: unchanged when it fits the threshold, else
 * the digest that names `path`, with `file` the text to save there first. A JSON result is saved
 * indented, one value per line, so `rg` prints the matching lines instead of the whole result.
 */
export const digestResult = (
  text: string,
  options: { readonly path: string; readonly failed: boolean },
): { readonly text: string } | { readonly text: string; readonly file: string } => {
  const totalBytes = byteLength(text);
  if (totalBytes <= resultDigestThresholdBytes) return { text };
  const parsed = parseJson(text);
  const instruction = `This result is ${totalBytes} bytes, over the ${resultDigestThresholdBytes} bytes the host returns whole, so this is its digest: its shape with every array's length, its first items and its error fields whole up to a limit. The full result is in ${options.path}: read it with read_source (offset and limit) or search it with rg in exec_command, such as rg -n 'text' ${options.path}, before you rely on what the digest leaves out.`;
  const digest = {
    kind: "result_digest",
    totalBytes,
    path: options.path,
    instruction,
    ...(parsed === undefined ? {} : { shape: boundedShape(parsed.value) }),
    ...(parsed === undefined
      ? options.failed
        ? { excerpt: cut(text, errorBytes) }
        : { previewText: cut(text, previewBytes) }
      : detailOf(parsed.value, text, options.failed)),
  };
  const digestText = JSON.stringify(digest);
  // A digest that is not smaller than the result, or that exceeds its cap, is no help.
  if (byteLength(digestText) >= totalBytes || byteLength(digestText) > resultDigestMaxBytes)
    return { text: totalBytes <= resultHardCapBytes ? text : boundedResult(text) };
  return {
    text: digestText,
    file: parsed === undefined ? text : `${JSON.stringify(parsed.value, null, 2)}\n`,
  };
};
