import type { PublicationFileBlock } from "../guardian/review.js";

const valueSources: Readonly<Record<string, string>> = {
  explicit: "the caller's own credentials",
  context_cookie: "a cookie the site set",
  http_cookie: "a cookie the site set",
  http_header: "a credential header the site used",
  http_url: "a credential in a site URL",
  http_body: "a credential field in a site request or response",
  structured: "a credential field in a site response",
  stream: "a credential field in a site stream",
  page_field: "a credential field on a site page",
};

/** What the gate matched, in words, without the value. */
const matched = (block: PublicationFileBlock) => {
  switch (block.check) {
    case "registered_value":
      return `a private value the host registered (${block.entity ?? "credential"}, from ${valueSources[block.valueSource ?? ""] ?? "the site"})`;
    case "contextual_secret":
      return "a credential value the site issued, in a credential field or parameter";
    case "provider_credential":
      return "a provider API key or private key";
    case "invalid_text":
      return block.entity === "NUL"
        ? "a NUL character"
        : `text that does not parse as ${block.entity === "JSON" ? "JSON" : "source"}`;
  }
};

/**
 * A refused public definition. Which part holds the value decides the fix: metadata changes on
 * the same receipt, and schemas in source, which the host reads again offline.
 */
const definitionFeedback = (block: PublicationFileBlock) => {
  const file = "publication/definition.json";
  const part = block.section ?? "its name, description, site, schemas or supported variants";
  const metadata =
    block.section === "name" ||
    block.section === "description" ||
    block.section === "site" ||
    block.section === "supportedVariants";
  const fix = metadata
    ? "Change it in finish_build's metadata, then call finish_build again with the same executionId."
    : "Fix the schema in source, then call finish_build again with the same executionId; the host reads it again offline from current source and never reruns the example.";
  const field = block.field === undefined ? "" : `, field "${block.field}"`;
  return {
    file,
    fixable: true,
    instruction: `Not published: the tool's public definition (${part}${field}) holds ${matched(block)}. Public metadata and schemas never name an account-specific or secret value: describe it generically and take the value as free-form input. ${fix}`,
  };
};

/** Guardian reads the workspace under `operation/`; the minter knows a file by its workspace path. */
export const workspacePath = (path: string) => path.replace(/^operation\//u, "");

/**
 * The minter's feedback for a publication gate refusal: the file, what matched and where, and what
 * to change. `fixable` is false for a file the minter cannot change: a write session step that
 * already ran, or evidence the host wrote itself. Neither case closes the build.
 */
export const publicationBlockFeedback = (
  block: PublicationFileBlock,
): {
  readonly file: string;
  readonly fixable: boolean;
  readonly instruction: string;
} => {
  const file = workspacePath(block.file);
  const where = [
    block.line === undefined
      ? undefined
      : `line ${block.line}${block.column === undefined ? "" : `, column ${block.column}`}`,
    block.field === undefined ? undefined : `field "${block.field}"`,
  ]
    .filter((part) => part !== undefined)
    .join(", ");
  const found = `${file}${where === "" ? "" : ` (${where})`} holds ${matched(block)}`;
  const reread =
    "read it at run time from the caller's input, a secret question read with ask (.agents/caller-input/SKILL.md), or the response, cookie or page that issues it";
  if (file.startsWith("publication/session/"))
    return {
      file,
      fixable: false,
      instruction: `Not published: ${found}. That step already ran as the build's one write, so its source cannot change and the write is never repeated. Report which step embedded the value; the host must correct this publication evidence.`,
    };
  if (file === "publication/definition.json") return definitionFeedback(block);
  if (file.startsWith("publication/"))
    return {
      file,
      fixable: false,
      instruction: `Not published: ${found}. The host wrote this file from its own evidence, so no source edit changes it. Report the publication evidence problem; the host logged the refusal for its operators.`,
    };
  return {
    file,
    fixable: true,
    instruction: `Not published: ${found}. Published code never embeds it: remove the literal and ${reread}. Then call finish_build again with the same executionId. If the file is src/tool-http.mjs, run its live test again first, because the edit invalidates the last one.`,
  };
};
