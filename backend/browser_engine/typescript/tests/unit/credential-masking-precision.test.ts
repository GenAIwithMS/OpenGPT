import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { failureDetail, redactDiagnosticText } from "../../src/runtime/failure-detail.js";
import { credentials, prose, urls } from "../support/credential-masking-corpus.js";

describe("credential masking precision", () => {
  it("masks real credentials by structure and keeps prose, identifiers and URLs byte for byte", () => {
    for (const [text, secret, surfaces] of credentials) {
      if (surfaces.includes("diagnostic"))
        expect(redactDiagnosticText(text), text).not.toContain(secret);
    }
    // A comma followed by a space and no `name=` is prose, not a joined cookie.
    expect(redactDiagnosticText("Cookie: a=1, then retry")).toBe("Cookie: [redacted], then retry");
    for (const text of [...prose, ...urls]) expect(redactDiagnosticText(text), text).toBe(text);
  });
});

/*
 * One adversarial corpus runs through every credential-masking sink. A sink can fail the policy
 * (structure only, never English words) in these ways, each covered by rows:
 * 1. A structural secret survives in one of its forms: Authorization (Bearer, Basic, Digest,
 *    SigV4, unschemed, JSON, `util.inspect` quotes), Cookie and Set-Cookie (quoted, comma inside a
 *    value, comma-joined, Expires dates, spaced `=`, opaque), JWT, provider key prefixes, AWS key
 *    IDs and credential-named assignments (prefixed, camelCase, quoted, bracketed).
 * 2. Prose is masked: a scheme word, header or credential name followed by ordinary words, a
 *    loose field name (`token`, `secret`, `pass`, `pin`) with its value, an identifier that only
 *    starts like a provider key, or an earlier mask masked again.
 * 3. Any part of a URL changes, including userinfo and database password queries.
 * 4. Masking a credential takes the prose after it (`Cookie: a=1, then retry`).
 * 5. Two sinks disagree on a row: every sink must reach the row's decision, and a recorded gap
 *    must still reproduce, so a fix removes its entry instead of leaving a stale exception.
 * 6. Serialization reintroduces a secret: failure-detail JSON escapes.
 */
const Sink = Schema.Literal("diagnostic", "failureDetail");
type Sink = typeof Sink.Type;
const CanaryRow = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  secrets: Schema.optional(Schema.Array(Schema.String)),
  kept: Schema.optional(Schema.Array(Schema.String)),
  gaps: Schema.optional(Schema.partial(Schema.Record({ key: Sink, value: Schema.String }))),
});
type CanaryRow = typeof CanaryRow.Type;
const corpus = Schema.decodeUnknownSync(
  Schema.parseJson(
    Schema.Struct({ about: Schema.String, sinks: Schema.Array(Sink), rows: Schema.Array(CanaryRow) }),
  ),
)(readFileSync(new URL("../support/credential-masking-rows.json", import.meta.url), "utf8"));

/** Every way `output` breaks the row's decision; empty when the sink follows the policy. */
const violations = (row: CanaryRow, output: string): string[] => {
  if (row.secrets === undefined) return output === row.text ? [] : [`prose changed: ${output}`];
  return [
    ...row.secrets
      .filter((secret) => output.includes(secret))
      .map((secret) => `secret kept: ${secret}`),
    ...(row.kept ?? [])
      .filter((context) => !output.includes(context))
      .map((context) => `context lost: ${context}`),
  ];
};

/** A sink's outcome for each row, against the row's decision and its recorded gaps. */
const disagreements = (sink: Sink, run: (text: string, row: CanaryRow) => string): string[] => {
  const found: string[] = [];
  for (const row of corpus.rows) {
    const problems = violations(row, run(row.text, row));
    const gap = row.gaps?.[sink];
    if (gap === undefined && problems.length > 0)
      found.push(`${row.id} (${sink}): ${problems.join("; ")}`);
    if (gap !== undefined && problems.length === 0)
      found.push(`${row.id} (${sink}): recorded gap no longer reproduces, remove it: ${gap}`);
  }
  return found;
};

describe("credential canary corpus", () => {
  it("names every sink and keeps row ids unique", () => {
    expect(corpus.sinks).toEqual(["diagnostic", "failureDetail"]);
    const ids = corpus.rows.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of corpus.rows) {
      for (const sink of Object.keys(row.gaps ?? {})) expect(corpus.sinks, row.id).toContain(sink);
      for (const secret of row.secrets ?? []) expect(row.text, row.id).toContain(secret);
      for (const context of row.kept ?? []) expect(row.text, row.id).toContain(context);
    }
  });

  it("diagnostic text: redactDiagnosticText", () => {
    expect(disagreements("diagnostic", (text) => redactDiagnosticText(text))).toEqual([]);
  });

  it("failure-detail JSON: an error message and a context value, serialized", () => {
    expect(
      disagreements("failureDetail", (text, row) => {
        const detail = failureDetail("unclassified", {
          error: new Error(text),
          context: { note: text },
        });
        const serialized = JSON.stringify(detail);
        const message = detail.underlying?.message ?? "";
        // The whole record, in any escape, must be free of the row's secrets, and the message
        // and the context value must agree.
        const leaked = (row.secrets ?? []).some(
          (secret) =>
            serialized.includes(secret) || serialized.includes(JSON.stringify(secret).slice(1, -1)),
        );
        return leaked || message !== detail.context?.["note"] ? serialized : message;
      }),
    ).toEqual([]);
  });
});
