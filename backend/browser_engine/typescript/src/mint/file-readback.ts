import { isAuthoredSourcePath } from "./operation-source.js";

/**
 * A file's bytes stay with the host: `files.place` sets a file input and `files.collect` keeps a
 * download, and authored code sees only metadata. Code that reads a placed or downloaded file
 * back would put its bytes in the result, and during a build in the model's context and traces,
 * so the host refuses such source before a live step runs and before it publishes.
 *
 * The check is a static scan of the source text, code strings included. In every build it
 * refuses saving a download and reading a file's contents (`FileReader`, `readAs*`,
 * `getAsFile`, object URLs, `createReadStream`). In a build that holds a caller's file or uses
 * the file API it also refuses setting a file input or a file chooser itself, taking a download
 * outside the host, `DataTransfer`, reading an input's files, `FormData`, request bodies and any request routing,
 * which could send the site's own upload, file included, elsewhere. It does not see property
 * names built at run time, a route set up through such a name, or a second fetch of a
 * download's address. Guardian's file-handle rule and its off-site rule are the backstop.
 */

const quote = String.raw`\\?["'\x60]`;
/** Ways to move or read files outside the host, refused in any live step or published source. */
const alwaysRefused: readonly (readonly [RegExp, string])[] = [
  [/\.saveAs\s*\(/u, "saves a download (use files.collect)"],
  [/\bcreateReadStream\b/u, "reads a file"],
  [/\bFileReader\b/u, "reads a file's contents"],
  [/\breadAs(?:DataURL|Text|ArrayBuffer|BinaryString)\b/u, "reads a file's contents"],
  [/\bgetAsFile\b/u, "reads a file's contents"],
  [/\bcreateObjectURL\b/u, "reads a file's contents"],
];
/**
 * Array methods a `FileList` lacks: JSON's `files` list may call them, an input's files cannot.
 * Indexing (`data.files[0]`) stays refused, since an input's files are read that way too.
 */
const arrayMethods =
  "map|filter|forEach|some|every|find|findIndex|findLast|reduce|flatMap|includes|indexOf|slice|join|concat|at|sort|toSorted|push|flat";
/** Ways to read a placed file back or move a file, refused in source of a build that has files. */
const refusedWithFiles: readonly (readonly [RegExp, string])[] = [
  // Without files a build may still set an input from its own bytes, as tools built before
  // files.place did from base64 input; that pattern is deprecated, so their repairs still run.
  [/\bsetInputFiles\b/u, "sets a file input itself (use files.place)"],
  [new RegExp(String.raw`\bfilechooser\b`, "u"), "handles a file chooser (use files.place)"],
  [
    new RegExp(String.raw`(?:waitForEvent|\bon|\bonce|addListener)\s*\(\s*${quote}download`, "u"),
    "handles a download (use files.collect)",
  ],
  [/\bDataTransfer\b/u, "moves files between inputs"],
  [
    new RegExp(
      String.raw`\.files\b(?!\s*\??\.\s*(?:length|place|collect|${arrayMethods})\b)`,
      "u",
    ),
    "reads an input's files",
  ],
  [new RegExp(String.raw`\[\s*${quote}files${quote}\s*\]`, "u"), "reads an input's files"],
  [/\bFormData\b/u, "reads a form's files"],
  [/\bpostData(?:Buffer|JSON)?\b/u, "reads a request body, which can carry a file"],
  [
    /\b(?:route|unroute|unrouteAll|routeFromHAR|routeWebSocket)\s*\(/u,
    "routes the page's requests, which can send its upload elsewhere",
  ],
];
const usesFiles = /\bfiles\s*\.\s*(?:place|collect)\b|\bFile(?:Input|Output)\b/u;

const lineAt = (source: string, offset: number) => source.slice(0, offset).split("\n").length;

/**
 * The first authored file and line that reads a file back, with what it does, if any. The file
 * rules apply in full when `handlesFiles` (the build holds a caller's file) or when some
 * authored source uses the file API.
 */
export const fileReadback = (
  files: ReadonlyMap<string, string>,
  handlesFiles: boolean,
): { readonly path: string; readonly line: number; readonly does: string } | undefined => {
  const authored = [...files].filter(([path]) => isAuthoredSourcePath(path));
  const withFiles = handlesFiles || authored.some(([, source]) => usesFiles.test(source));
  const rules = withFiles ? [...alwaysRefused, ...refusedWithFiles] : alwaysRefused;
  for (const [path, source] of authored)
    for (const [pattern, does] of rules) {
      const match = pattern.exec(source);
      if (match !== null) return { path, line: lineAt(source, match.index), does };
    }
  return undefined;
};

/** The rule a refusal states after its file, line and what the code does. */
export const fileReadbackRule =
  "a file's bytes stay with the host: files.place puts a caller's file into a file input and files.collect keeps a download, and code never sets a file input, handles a download or reads a placed or downloaded file back (an input's .files items, FileReader, FormData, DataTransfer, a request body)";

/** Why a live step is refused before review for reading a file back, if it is. */
export const fileReadbackRefusal = (
  files: ReadonlyMap<string, string>,
  step: { readonly target: string },
  handlesFiles: boolean,
): string | undefined => {
  if (step.target !== "liveBrowser") return undefined;
  const found = fileReadback(files, handlesFiles);
  return found === undefined
    ? undefined
    : `${found.path} line ${found.line} ${found.does}: ${fileReadbackRule}. Nothing was executed.`;
};
