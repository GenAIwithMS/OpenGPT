/**
 * File type checks from a file's first bytes, its name and a declared media type. They read
 * bytes only: nothing here decompresses, opens or renders a file.
 */

/** A signature: bytes at an offset, `undefined` matching any byte. */
type Signature = readonly [offset: number, bytes: readonly (number | undefined)[]];
const ascii = (text: string) => [...text].map((character) => character.charCodeAt(0));

/** Programs: Windows, ELF and Mach-O binaries, and scripts that name their interpreter. */
const programSignatures: readonly Signature[] = [
  [0, ascii("MZ")],
  [0, [0x7f, ...ascii("ELF")]],
  [0, [0xfe, 0xed, 0xfa, 0xce]],
  [0, [0xfe, 0xed, 0xfa, 0xcf]],
  [0, [0xce, 0xfa, 0xed, 0xfe]],
  [0, [0xcf, 0xfa, 0xed, 0xfe]],
  [0, [0xca, 0xfe, 0xba, 0xbe]],
  [0, ascii("#!")],
];

/** Names of programs and installers whose bytes need not carry a signature. */
const programExtensions = new Set([
  "apk",
  "app",
  "bat",
  "cmd",
  "com",
  "cpl",
  "dll",
  "exe",
  "jar",
  "msi",
  "ps1",
  "scr",
  "sh",
  "vbs",
]);

/** Types a file's first bytes prove, with every declared type those bytes may carry. */
const knownTypes: readonly {
  readonly type: string;
  readonly signatures: readonly Signature[];
  readonly carries: readonly string[];
}[] = [
  { type: "application/pdf", signatures: [[0, ascii("%PDF-")]], carries: [] },
  {
    type: "image/png",
    signatures: [[0, [0x89, ...ascii("PNG"), 0x0d, 0x0a, 0x1a, 0x0a]]],
    carries: [],
  },
  { type: "image/jpeg", signatures: [[0, [0xff, 0xd8, 0xff]]], carries: ["image/jpg"] },
  { type: "image/gif", signatures: [[0, ascii("GIF87a")], [0, ascii("GIF89a")]], carries: [] },
  {
    type: "image/webp",
    signatures: [[0, [...ascii("RIFF"), undefined, undefined, undefined, undefined, ...ascii("WEBP")]]],
    carries: [],
  },
  {
    type: "image/tiff",
    signatures: [
      [0, [0x49, 0x49, 0x2a, 0x00]],
      [0, [0x4d, 0x4d, 0x00, 0x2a]],
    ],
    carries: [],
  },
  { type: "image/heic", signatures: [[4, ascii("ftypheic")], [4, ascii("ftypmif1")]], carries: ["image/heif"] },
  {
    type: "application/zip",
    signatures: [[0, ascii("PK\x03\x04")], [0, ascii("PK\x05\x06")]],
    // Office and other formats that are zip containers.
    carries: [
      "application/x-zip-compressed",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.oasis.opendocument.text",
      "application/vnd.oasis.opendocument.spreadsheet",
      "application/vnd.oasis.opendocument.presentation",
      "application/epub+zip",
    ],
  },
  { type: "application/gzip", signatures: [[0, [0x1f, 0x8b]]], carries: ["application/x-gzip"] },
  {
    type: "application/x-cfb",
    signatures: [[0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]]],
    // Legacy Office documents and Outlook messages share the compound file format.
    carries: [
      "application/msword",
      "application/vnd.ms-excel",
      "application/vnd.ms-powerpoint",
      "application/vnd.ms-outlook",
    ],
  },
  { type: "application/vnd.rar", signatures: [[0, ascii("Rar!\x1a\x07")]], carries: ["application/x-rar-compressed"] },
  {
    type: "application/x-7z-compressed",
    signatures: [[0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]]],
    carries: [],
  },
];

/** Media types by file extension, for names whose type the caller did not declare. */
const extensionTypes: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  heif: "image/heif",
  svg: "image/svg+xml",
  zip: "application/zip",
  gz: "application/gzip",
  rar: "application/vnd.rar",
  "7z": "application/x-7z-compressed",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
  msg: "application/vnd.ms-outlook",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  epub: "application/epub+zip",
  txt: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  md: "text/markdown",
  rtf: "application/rtf",
  ics: "text/calendar",
  vcf: "text/vcard",
};

const matches = (bytes: Uint8Array, [offset, expected]: Signature) =>
  bytes.length >= offset + expected.length &&
  expected.every((byte, index) => byte === undefined || bytes[offset + index] === byte);

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
};

/** A declared media type without parameters, lowercased. */
const essence = (mediaType: string) => mediaType.split(";")[0]?.trim().toLowerCase() ?? "";

/** Whether the bytes or the name make the file a program, which the host never moves. */
export const isProgram = (bytes: Uint8Array, name: string) =>
  programSignatures.some((signature) => matches(bytes, signature)) ||
  programExtensions.has(extensionOf(name));

/** The type the file's first bytes prove, if they prove one. */
export const sniffedType = (bytes: Uint8Array): string | undefined =>
  knownTypes.find(({ signatures }) => signatures.some((signature) => matches(bytes, signature)))
    ?.type;

/** The media type a name's extension implies, or `application/octet-stream`. */
export const typeOfName = (name: string) =>
  extensionTypes[extensionOf(name)] ?? "application/octet-stream";

/**
 * Whether the bytes may be the declared type. Bytes that prove a type must be that type or one it
 * carries (a zip may be a .docx), unless the declaration is the generic octet stream. A type with a
 * signature that the bytes lack is refused, so a "PDF" whose bytes are not a PDF is not one. A type
 * without a signature, such as text or CSV, is taken as declared.
 */
export const bytesMatchType = (bytes: Uint8Array, declared: string) => {
  const type = essence(declared);
  if (type === "application/octet-stream") return true;
  const sniffed = knownTypes.find(({ signatures }) =>
    signatures.some((signature) => matches(bytes, signature)),
  );
  if (sniffed !== undefined) return sniffed.type === type || sniffed.carries.includes(type);
  return !knownTypes.some((known) => known.type === type || known.carries.includes(type));
};

/**
 * Whether a file input's `accept` attribute takes a file with this name and media type: an
 * empty attribute takes any file; otherwise one entry must match, an extension such as `.pdf`
 * against the name, `image/*` against the type's top level, or a full media type. It uses
 * nothing outside itself, so the host's page code runs this same function (`acceptsSource`).
 */
export const accepts = (
  accept: string,
  file: { readonly name: string; readonly mediaType: string },
): boolean => {
  const entries = accept
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
  if (entries.length === 0) return true;
  const type = (file.mediaType.split(";")[0] ?? "").trim().toLowerCase();
  const name = file.name.toLowerCase();
  return entries.some((entry) =>
    entry.startsWith(".")
      ? name.endsWith(entry)
      : entry.endsWith("/*")
        ? type.startsWith(entry.slice(0, -1))
        : entry === type,
  );
};

/** `accepts` as JavaScript source, for page code that checks an input's `accept` itself. */
export const acceptsSource = accepts.toString();
