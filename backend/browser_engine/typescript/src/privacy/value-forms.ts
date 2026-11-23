/**
 * The forms a known secret value can be written in: as given, and as a page, a URL, a form body,
 * JSON or base64 writes it. A host masks and refuses a registered value in these forms.
 */

/**
 * A value as given, percent-encoded, form-encoded (`+` for a space and `!'()~` percent-encoded),
 * base64-encoded and JSON-escaped, each once.
 */
export const observedForms = (value: string): readonly string[] => {
  const json = JSON.stringify(value);
  return [
    ...new Set([
      value,
      encodeURIComponent(value),
      // HTML forms and URLSearchParams: `+` for a space and `!'()~` percent-encoded.
      new URLSearchParams({ v: value }).toString().slice(2),
      Buffer.from(value).toString("base64"),
      json.slice(1, -1),
    ]),
  ];
};

/**
 * A quoted value in a page's accessibility snapshot, escaped as Playwright's YAML writer does: a
 * backslash, a double quote and `\b\f\n\r\t` as escapes, and every other control character as
 * `\xNN`.
 */
const yamlValueEscaped = (form: string) =>
  form.replace(/[\\"\x00-\x1f\x7f-\x9f]/gu, (character) => {
    switch (character) {
      case "\\":
        return "\\\\";
      case '"':
        return '\\"';
      case "\b":
        return "\\b";
      case "\f":
        return "\\f";
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "\t":
        return "\\t";
      default:
        return `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`;
    }
  });

/**
 * The characters Chromium percent-encodes in each part of a URL it shows (`page.url()`), beyond
 * control characters, space and anything outside ASCII, which every part encodes.
 */
const urlPartEncoded = { query: `"#<>'`, path: '"#<>?^`{|}', fragment: '"<>`' };
/**
 * Each byte as one part of a URL writes it: escaped when it is a control character, space,
 * non-ASCII byte or one of the part's `encoded` characters, in uppercase hex.
 */
const byteForms = (encoded: string) =>
  Array.from({ length: 256 }, (_, byte) =>
    byte <= 0x20 || byte >= 0x7f || encoded.includes(String.fromCharCode(byte))
      ? `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
      : String.fromCharCode(byte),
  );
const urlPartBytes = {
  query: byteForms(urlPartEncoded.query),
  path: byteForms(urlPartEncoded.path),
  fragment: byteForms(urlPartEncoded.fragment),
};
const utf8 = new TextEncoder();
/**
 * `form` as a browser writes it into one part of a URL: without tabs and line breaks, which a
 * URL drops, with `\` turned into `/` in a path, then percent-encoded in UTF-8.
 */
const urlPartForm = (form: string, part: keyof typeof urlPartEncoded) => {
  const bytes = urlPartBytes[part];
  let encoded = "";
  for (const character of (part === "path" ? form.replaceAll("\\", "/") : form).replace(
    /[\t\n\r]/gu,
    "",
  )) {
    const code = character.charCodeAt(0);
    if (code < 0x80) encoded += bytes[code];
    else for (const byte of utf8.encode(character)) encoded += bytes[byte];
  }
  return encoded;
};
const lowercaseHex = (encoded: string) =>
  encoded.includes("%")
    ? encoded.replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase())
    : encoded;

/**
 * Under this many characters a form is short: a host may count it in source only as a whole
 * token, since a short value, such as a favorite color or a six-digit code, turns up inside a
 * longer word or a timestamp by chance.
 */
const shortForm = 8;

/**
 * Each form a page or URL can show `value` in, each with whether it is short (`shortForm`). The
 * value as given, trimmed, and with its whitespace collapsed as an accessibility snapshot shows it;
 * each of them as written, JSON-escaped, escaped as a snapshot's quoted value, and with each `'`
 * doubled as a snapshot's quoted key holds a name; and percent-encoded as `encodeURIComponent` and
 * a form write it, and as Chromium writes it into a URL's query, path and fragment, in uppercase
 * and lowercase hex. Last, the value base64-encoded. A value that cannot be encoded, such as one
 * holding a lone surrogate, keeps every other form. Each form counts by the length of the shown
 * value it came from.
 */
export const shownForms = (value: string): (readonly [string, boolean])[] => {
  const shown = [
    value,
    value.trim(),
    value
      .replace(/[\u200b\u00ad]/gu, "")
      .trim()
      .replace(/\s+/gu, " "),
  ];
  // The three shown values are usually equal, and each distinct one is encoded once.
  const encoded = new Map<string, (readonly [string, boolean])[]>();
  const forms = shown.flatMap((form) => {
    const known = encoded.get(form);
    if (known !== undefined) return known;
    if (form.length === 0) return [];
    const json = JSON.stringify(form).slice(1, -1);
    const forms = [
      form,
      json,
      yamlValueEscaped(form),
      form.replaceAll("'", "''"),
      json.replaceAll("'", "''"),
    ];
    if (form.isWellFormed()) {
      const percent = [
        encodeURIComponent(form),
        new URLSearchParams([["", form]]).toString().slice(1),
        urlPartForm(form, "query"),
        urlPartForm(form, "path"),
        urlPartForm(form, "fragment"),
      ];
      forms.push(...percent, ...percent.map(lowercaseHex));
    }
    const short = form.length < shortForm;
    const result = forms.map((shownForm) => [shownForm, short] as const);
    encoded.set(form, result);
    return result;
  });
  return value.length === 0
    ? forms
    : [...forms, [Buffer.from(value).toString("base64"), value.length < shortForm] as const];
};

/** One run of percent escapes decoded, or undefined when it is not UTF-8. */
const decodedEscapes = (run: string): string | undefined => {
  try {
    return decodeURIComponent(run);
    // error-reporting-allow: parse-predicate an escape run that is not UTF-8 stays as written
  } catch {
    return undefined;
  }
};

/** A `+` or a run of percent escapes. */
const formEscape = /\+|(?:%[0-9a-f]{2})+/giu;

/**
 * Form and percent decoding, so a value sent by any other percent-encoder is seen as sent:
 * `+` is a space, and each run of escapes that is valid UTF-8 is decoded. Undefined when the
 * text has nothing to decode.
 */
export const formDecoded = (text: string): string | undefined => {
  if (!text.includes("%") && !text.includes("+")) return undefined;
  const decoded = text.replace(formEscape, (run) =>
    run === "+" ? " " : (decodedEscapes(run) ?? run),
  );
  return decoded === text ? undefined : decoded;
};
