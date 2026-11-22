import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { describe, expect, it } from "vitest";
import {
  awsAccessKeyIdPattern,
  credentialPolicy,
  isCredentialAssignmentKey,
  isProviderKey,
  isRandomKeyBody,
  providerKeyPattern,
} from "../../src/privacy/credential-policy.js";
import { publicationBlockFeedback } from "../../src/mint/publication-block.js";
import { redactDiagnosticText } from "../../src/runtime/failure-detail.js";
import { providerKeyRefusal } from "../../src/standalone/mint-publication.js";

/** A synthetic key, built at run time so no secret scanner reads a literal one. */
const fake = (prefix: string, body: string) => prefix + body;

// One list of credential names and key shapes serves every host's masking and publication gates.
describe("the credential list", () => {
  it.each(["secret_string", "SecretString", "awsSecretBinary", "secret-binary"])(
    "names a vault secret %s as a credential",
    (key) => {
      expect(isCredentialAssignmentKey(key)).toBe(true);
    },
  );

  it("redacts a vault secret assignment in diagnostics", () => {
    expect(redactDiagnosticText("secret_string=hunter2hunter2")).toBe("secret_string=[redacted]");
  });

  it.each([
    ["after an underscore", `KEY_${fake("AKIA", "ABCDEFGHIJKLMNOP")}`],
    ["before an underscore", `${fake("ASIA", "ABCDEFGHIJKLMNOP")}_old`],
  ])("finds an AWS access key ID %s", (_, text) => {
    expect(text.match(awsAccessKeyIdPattern())?.[0]).toMatch(/^A[KS]IAABCDEFGHIJKLMNOP$/u);
    expect(redactDiagnosticText(text)).not.toMatch(/A[KS]IAABCDEFGHIJKLMNOP/u);
  });
});

// A key body that may hold `-`, `+`, `/` or `=` never runs into a listed key written straight
// after it: each key is found whole, so no part of either is left readable.
describe("keys written one after another", () => {
  const signing = fake("whsec_", "FAKEsyntheticSigning0000");
  const github = fake("ghp_", "FAKEsynthetic0000abcdefghi");
  const slack = fake("xoxb-", "FAKE0000012345");
  const payment = fake("sk_live_", "FAKEsynthetic0000");
  it.each([
    ["a GitHub token after a slash", `see ${signing}/${github} ok`, github],
    ["a Slack token after a slash", `see ${signing}/${slack} ok`, slack],
    ["a payment key after a plus", `see ${signing}+${payment} ok`, payment],
  ])("finds %s whole, and masks both keys", (_, text, second) => {
    const found = [...text.matchAll(providerKeyPattern())]
      .map((match) => match[0])
      .filter(isProviderKey);
    expect(found).toEqual([signing, second]);
    const redacted = redactDiagnosticText(text);
    expect(redacted).toBe(
      `see [redacted_token]${text.charAt(4 + signing.length)}[redacted_token] ok`,
    );
  });

  it("keeps a key whole where no key follows a hyphen inside it", () => {
    const key = fake("sk-proj-", "FAKEsynthetic0000modelkey1-bl_x9");
    expect(`use ${key} now`.match(providerKeyPattern())?.[0]).toBe(key);
  });
});

/** The provider keys a text holds, as `providerKeyPattern` and `isProviderKey` find them. */
const providerKeys = (text: string) =>
  [...text.matchAll(providerKeyPattern())].map((match) => match[0]).filter(isProviderKey);

// A key body that can hold `-` can also hold another key's shape after it. That shape is the
// rest of the same key unless the body could not read it whole, so the key stays one key and
// none of it is left readable.
describe("a key whose body holds another key's shape", () => {
  const model = fake("sk-proj-", "AbCdEf0123456789XyZwQq-");
  it.each([
    ["an analytics key shape", `${model}${fake("bl_", "Q1w2E3r4T5y6U7i8O9p0As_tail-Rest0123456789")}`],
    ["a GitHub token shape", `${model}${fake("ghp_", "Q1w2E3r4T5y6U7i8O9p0As_tail-Rest0123456789")}`],
    ["a model key slug", `${model}${fake("sk-", "hynix-ddr5-memory-kit-2026x")}`],
    ["a short body before it", fake("sk-proj-", "AbC12-bl_Q1w2E3r4T5y6U7i8O9p0As_tail")],
    ["a slug after it", fake("sk-proj-", "A1B2C3D4E5F6G7H8-sk-onboarding-step-for-2026")],
    [
      "a Slack token shape",
      `${fake("sk-ant-", "api03-Ab0123456789cdEFghIJ-")}${fake("xoxb-", "1234567890-abcdEFGH_tail_secret")}`,
    ],
  ])("keeps a key holding %s as one key, masked whole", (_, key) => {
    const text = `key ${key} end`;
    expect(providerKeys(text)).toEqual([key]);
    expect(redactDiagnosticText(text)).toBe("key [redacted_token] end");
  });

  it.each([
    ["an analytics key shape", fake("bl_", "abcdefghijklmnopqrstu")],
    ["an analytics personal key shape", fake("phx_", "abcdefghijklmnopqrstuvwx")],
  ])("refuses a short key followed by %s as one key", (_, shape) => {
    const key = `${fake("sk-", "A1B2C3D4E5F6G7H8-")}${shape}`;
    const text = `const key = "${key}";`;
    expect(providerKeys(text)).toEqual([key]);
    expect(providerKeyRefusal("src/tool.mjs", text)?.publicationBlock).toMatchObject({
      check: "provider_credential",
      line: 1,
      column: 14,
    });
  });

  it("still finds two keys where the first body could not read the second", () => {
    const signing = fake("whsec_", "FAKEsyntheticSigning0000");
    const github = fake("ghp_", "FAKEsynthetic0000abcdefghi");
    const text = `${signing}/${github} ok`;
    expect(providerKeys(text)).toEqual([signing, github]);
    expect(redactDiagnosticText(text)).toBe("[redacted_token]/[redacted_token] ok");
  });

  it("masks a short Slack token shape written straight before a GitHub token", () => {
    const github = fake("ghp_", "FAKEsynthetic0000abcdefghi");
    const text = `x ${fake("xoxb-", "abcdef")}-${github} y`;
    expect(redactDiagnosticText(text)).toBe("x [redacted_token]-[redacted_token] y");
  });

  it("masks a model key slug that holds a Slack token", () => {
    const text = `see ${fake("sk-", "onboarding-step-for-twenty-")}${fake("xoxb-", "1234567890")} ok`;
    expect(redactDiagnosticText(text)).toBe("see [redacted_token] ok");
  });

  it("starts a key at the same word start as a letter, digit or underscore lookbehind", () => {
    const pattern = providerKeyPattern();
    const lookbehind = new RegExp(
      pattern.source.replace(/^\\b/u, "(?<![A-Za-z0-9_])"),
      pattern.flags,
    );
    expect(lookbehind.source).not.toBe(pattern.source);
    const key = fake("ghp_", "FAKEsynthetic0000abcdefghi");
    for (const before of ["", " ", "-", "/", "é", "ſ", "K", "_", "a", "0", "\ud800"]) {
      const text = `${before}${key} ${before}${fake("xoxb-", "FAKE0000012345")}`;
      const starts = (found: RegExp) => [...text.matchAll(found)].map((match) => match.index);
      expect(starts(pattern)).toEqual(starts(lookbehind));
    }
  });

  it("takes a signing secret with base64 padding into the key before it", () => {
    const key = `${fake("sk-", "A1B2C3D4E5F6G7H8IJKL-")}${fake("whsec_", "ABCDEFGH12345678+abc/def=")}`;
    expect(redactDiagnosticText(`x ${key} y`)).toBe("x [redacted_token] y");
  });

  it("ends a signing secret read into a key before the next signing secret", () => {
    const first = `${fake("sk-", "A1B2C3D4E5F6G7H8IJKL-")}${fake("whsec_", "ABCDEFGH12345678")}`;
    const second = fake("whsec_", "QRSTUVWX12345678+abc/def=");
    const text = `key ${first}=${second} end`;
    expect(providerKeys(text)).toEqual([first, second]);
    expect(redactDiagnosticText(text)).toBe("key [redacted_token]=[redacted_token] end");
  });

  it.each([
    [
      "at the start of its body",
      fake("xoxb-", fake("sk-", "xoxb-1234567890_Tail0123456789abcdefXYZ")),
    ],
    [
      "after a hyphen",
      `${fake("xoxa-", "AAAAAAAAAA-")}${fake("xoxb-", fake("sk-", "A1B2C3D4E5F6G7H8_tail"))}`,
    ],
  ])("reads a model key into a Slack token shape %s, masked whole", (_, key) => {
    const text = `key ${key} end`;
    expect(providerKeys(text)).toEqual([key]);
    expect(redactDiagnosticText(text)).toBe("key [redacted_token] end");
  });

  it.each([
    [
      "after a Slack token hyphen",
      `${fake("xoxa-", "AAAAAAAAAA-")}${fake("sk-", fake("whsec_", "ABCDEFGH12+/ijklmnopqrstuv=="))}`,
    ],
    [
      "at the start of a Slack token body",
      fake(
        "xoxb-",
        fake("sk-proj-", fake("whsec_", "xJEj5VQ/KmMOLFb+Qa2tmsqp3mjmiafEpvucV6SaTSl9T1cB1yacewg4j")),
      ),
    ],
  ])("reads in a signing secret that starts a model key body, %s", (_, key) => {
    const text = `key ${key} end`;
    expect(providerKeys(text)).toEqual([key]);
    expect(redactDiagnosticText(text)).toBe("key [redacted_token] end");
  });

  it("reads a long run of key shapes in time that grows with its length, not its square", () => {
    const fastest = (text: string) => {
      let best = Number.POSITIVE_INFINITY;
      for (let round = 0; round < 5; round += 1) {
        const started = performance.now();
        providerKeys(text);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    const short = fastest(fake("xoxb-", "-sk-".repeat(2500)));
    const long = fastest(fake("xoxb-", "-sk-".repeat(10000)));
    // Four times the text should take about four times as long, not sixteen.
    expect(long / Math.max(short, 1)).toBeLessThan(10);
  });

  it("gives each run back whole when a pattern built on its source fails after a key", () => {
    const source = providerKeyPattern().source;
    const run = "a".repeat(28);
    const texts = [
      `${fake("sk-", run)}!`,
      `${fake("xoxb-", run)}!`,
      `${fake("whsec_", run.toUpperCase())}!`,
      `${fake("xoxb-", run)}-${fake("ghp_", "A".repeat(20))}`,
    ];
    for (const after of ["$", "(?![\\w-])"]) {
      const composed = new RegExp(`(?:${source})${after}`, "u");
      for (const text of texts) {
        const started = performance.now();
        composed.test(text);
        // Trying every split of a 28-letter run takes about 15 s; giving it back whole takes well
        // under a millisecond.
        expect(performance.now() - started).toBeLessThan(1000);
      }
    }
  });

  it("starts keys after no word character when a listed prefix does not start with one", async () => {
    expect(providerKeyPattern().source.startsWith("\\b")).toBe(true);
    const file = new URL("../../src/privacy/credential-policy.ts", import.meta.url);
    const source = await readFile(file, "utf8");
    const changed = source.replace('prefixes: ["bl_"]', 'prefixes: ["bl_", "$tok_"]');
    expect(changed).not.toBe(source);
    const policy = (await import(
      `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(changed))}`
    )) as typeof import("../../src/privacy/credential-policy.js");
    const pattern = policy.providerKeyPattern();
    expect(pattern.source.startsWith("(?<!\\w)")).toBe(true);
    const key = fake("$tok_", "ABCDEFGH12345678abcd");
    const found = (text: string, search: RegExp) =>
      [...text.matchAll(search)].map((match) => [match.index, match[0]]);
    expect(found(` ${key}`, pattern)).toEqual([[1, key]]);
    expect(found(`a${key}`, pattern)).toEqual([]);
    const wordBoundary = new RegExp(pattern.source.replace("(?<!\\w)", "\\b"), "gu");
    expect(found(` ${key}`, wordBoundary)).toEqual([]);
  });
});

// Every body read to its last character, each key checked as `isProviderKey` checks it: a key
// found this way is masked whole by the policy's own pattern too. Only the one separator between
// two keys written back to back stays, as above, where the first body could not read the second
// key's prefix.
describe("masking never falls below a body read to its last character", () => {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const shapes = credentialPolicy.providerKeys.flatMap((shape) =>
    shape.prefixes.map((prefix) => ({ prefix, shape })),
  );
  const wholeBodies = new RegExp(
    `(?<![A-Za-z0-9_])(?:${shapes
      .map(({ prefix, shape }) => `${escape(prefix)}[${shape.body}]{${String(shape.minBody)},}`)
      .join("|")})`,
    "gu",
  );
  const wholeBodyKey = (match: string) => {
    const found = shapes.find(({ prefix }) => match.startsWith(prefix));
    return (
      found !== undefined &&
      (!("random" in found.shape) || isRandomKeyBody(match.slice(found.prefix.length)))
    );
  };
  const spans = (text: string, pattern: RegExp, keep: (match: string) => boolean) =>
    [...text.matchAll(pattern)]
      .filter((match) => keep(match[0]))
      .map((match) => ({ start: match.index, end: match.index + match[0].length, key: match[0] }));
  const shapeOf = (key: string) => shapes.find(({ prefix }) => key.startsWith(prefix));
  const reads = (body: string, text: string) => new RegExp(`^[${body}]*$`, "u").test(text);

  // Key shapes written together with separators, lengths around each minimum.
  let seed = 7919;
  const next = () => {
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed / 4294967296;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const alphanumeric = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const sets = [
    alphanumeric,
    `${alphanumeric}-_`,
    `${alphanumeric}+/=`,
    `${alphanumeric}-`,
    `${alphanumeric}_`,
    "abcdefghijklmnopqrstuvwxyz",
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  ];
  const prefixes = shapes.map(({ prefix }) => prefix);
  const text = () => {
    let written = pick(["", " ", "-", "/"]);
    const parts = 2 + Math.floor(next() * 5);
    for (let part = 0; part < parts; part += 1) {
      if (part > 0) written += pick(["-", "-", "-", "+", "/", "=", "_", " ", ""]);
      const set = pick(sets);
      written += pick(prefixes);
      for (let length = Math.floor(next() * 34); length > 0; length -= 1) written += pick([...set]);
    }
    return written;
  };

  it("masks every character the whole-body form masks, on 4,000 texts", () => {
    const less: string[] = [];
    for (let count = 0; count < 4000; count += 1) {
      const written = text();
      const mine = spans(written, providerKeyPattern(), isProviderKey);
      const masked = new Set(mine.flatMap(({ start, end }) => range(start, end)));
      // One separator between two keys, where the first body could not read the second prefix.
      const joint = (index: number) => {
        const first = shapeOf(mine.find(({ end }) => end === index)?.key ?? "");
        const second = shapeOf(mine.find(({ start }) => start === index + 1)?.key ?? "");
        return (
          "-+/=".includes(written.charAt(index)) &&
          first !== undefined &&
          second !== undefined &&
          !reads(first.shape.body, second.prefix)
        );
      };
      const lost = spans(written, wholeBodies, wholeBodyKey)
        .flatMap(({ start, end }) => range(start, end))
        .filter((index) => !masked.has(index) && !joint(index));
      if (lost.length > 0) less.push(written);
    }
    expect({ texts: less.length, first: less.slice(0, 3) }).toEqual({ texts: 0, first: [] });
  });
});

const range = (start: number, end: number) =>
  Array.from({ length: end - start }, (_, offset) => start + offset);

// The local publication precheck refuses a hard-coded provider key, naming the file and where.
describe("providerKeyRefusal", () => {
  it.each([
    ["a live payment key", fake("sk_live_", "FAKEsynthetic0000")],
    ["a test restricted key", fake("rk_test_", "FAKEsynthetic0000")],
    ["a webhook signing secret", fake("whsec_", "FAKEsyntheticSigning0000")],
    ["an analytics personal key", fake("phx_", "FAKEsynthetic0000personal1")],
    ["a model provider key", fake("sk-proj-", "FAKEsynthetic0000modelkey1")],
    ["a GitHub token", fake("ghp_", "FAKEsynthetic0000abcd")],
    ["an AWS access key ID", fake("AKIA", "FAKEFAKEFAKE0000")],
  ])("refuses %s, naming the file and position, never the key", (_, key) => {
    const text = `export const tool = 1;\nconst key = "${key}";\n`;
    const refused = providerKeyRefusal("src/tool.mjs", text);
    expect(refused).toMatchObject({
      code: "PublicationUnavailable",
      reason: "source_screening",
      publicationBlock: {
        file: "src/tool.mjs",
        check: "provider_credential",
        entity: "API_TOKEN",
        line: 2,
        column: 14,
      },
    });
    expect(JSON.stringify(refused)).not.toContain(key);
    const feedback = publicationBlockFeedback(
      refused?.publicationBlock ?? { file: "", check: "invalid_text" },
    );
    expect(feedback.instruction).toContain(
      "Not published: src/tool.mjs (line 2, column 14) holds a provider API key or private key.",
    );
  });

  it.each([
    ["a placeholder", 'const token = "ghp_example";'],
    ["a slug", 'const sku = "sk-hynix-ddr5-memory-kit";'],
    ["an identifier", 'const name = "bl_workspace_configuration_value";'],
  ])("keeps %s", (_, text) => {
    expect(providerKeyRefusal("src/tool.mjs", text)).toBeUndefined();
  });
});
