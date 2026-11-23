import {
  applyOutputOverrides,
  lintOutput,
  lintSchemas,
  type FieldFill,
  outputCheckMeaning,
  type OutputFinding,
  type OutputOverride,
  type ReviewedOutputFinding,
} from "../runtime/output-lint.js";

/**
 * The output check at publication, the same for every host: the host runs it on the read example's
 * output at `finish_build`, refuses publication while a blocking finding stands without the
 * minter's override, and gives the publication review every finding, with each override and its
 * reason, in `outputNotesPath`.
 */

/** The host's notes on the example's output, host evidence for publication review only. */
export const outputNotesPath = "publication/output-notes.json";

export interface OutputNotes {
  /** Every finding, with the minter's reason where an override names it. */
  readonly findings: readonly ReviewedOutputFinding[];
  /** Findings that still refuse publication: blocking, with no override. */
  readonly blocking: readonly OutputFinding[];
  /** Whether any finding or override exists, so the notes file is worth the reviewer's read. */
  readonly any: boolean;
  /** The notes file's text, for `outputNotesPath`. */
  readonly text: string;
}

/**
 * The example output's findings with the minter's overrides applied. `controlLabels` are the
 * accessible names of the buttons and links on the page the example ended on, when the host kept
 * them. The notes carry no sample: the reviewer reads values in the example output itself. They
 * add `lintSchemas`' advisory findings on the declared schemas, which never block.
 */
export const outputNotes = (input: {
  readonly output: unknown;
  readonly outputSchema?: unknown;
  /** The tool's input schema, which `lintSchemas` compares each output field with. */
  readonly inputSchema?: unknown;
  readonly controlLabels?: readonly string[];
  readonly overrides?: readonly OutputOverride[];
  /** The fields of the tool's other tested runs on this source, as `hostEvidence.testedFields`. */
  readonly alsoTested?: readonly FieldFill[];
}): OutputNotes => {
  const findings = [
    ...lintOutput(input.output, {
      ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
      ...(input.controlLabels === undefined ? {} : { controlLabels: input.controlLabels }),
      ...(input.alsoTested === undefined ? {} : { alsoTested: input.alsoTested }),
    }),
    ...lintSchemas(input.inputSchema, input.outputSchema),
  ];
  const applied = applyOutputOverrides(findings, input.overrides);
  return {
    findings: applied.findings,
    blocking: applied.blocking,
    any: findings.length > 0 || (input.overrides?.length ?? 0) > 0,
    text: JSON.stringify(
      {
        findings: applied.findings.map((finding) => ({
          ...finding,
          meaning: outputCheckMeaning[finding.check],
        })),
        ...(applied.unmatched.length === 0 ? {} : { unmatchedOverrides: applied.unmatched }),
      },
      null,
      2,
    ),
  };
};

/** The refusal's instruction to the minter, naming each blocking finding by path and check. */
export const outputChecksRefusal = (blocking: readonly Pick<OutputFinding, "path" | "check" | "count">[]) =>
  `Not published: the example's output looks like it holds what no page shows a person: ${blocking
    .map(
      (finding) =>
        `${finding.path} ${outputCheckMeaning[finding.check]} (${finding.check}, ${finding.count} ${finding.count === 1 ? "value" : "values"})`,
    )
    .join(
      "; ",
    )}. Check each against the page. When the read took a hidden copy, a script, a style or markup, fix it in source: read rendered text with visibleText, visibleTexts or readRows instead of textContent, innerHTML or a hidden copy, then run the example again and call finish_build with that new executionId. When a value is correct as it is, such as code the tool is meant to return or the page's own displayed text that only resembles code, call finish_build again with the same executionId and outputOverrides naming each path and check with the reason; the publication reviewer checks every override against the captures.`;
