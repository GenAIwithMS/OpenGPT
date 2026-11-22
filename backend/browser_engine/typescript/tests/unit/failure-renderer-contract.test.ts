import { describe, expect, it } from "vitest";
import {
  classifyRun,
  runOutcomeCodes,
  type FailureRenderer,
  type RunOutcome,
} from "../../src/runtime/run-outcome.js";
import {
  classifiedOutcomes,
  failureRendererIssues,
} from "../../src/runtime/failure-renderer-contract.js";
import { localFailureRenderer } from "../../src/standalone/failure-text.js";

describe("the local failure renderer", () => {
  it("meets the shared renderer contract", () => {
    expect(failureRendererIssues(localFailureRenderer)).toEqual([]);
  });

  it("promises no repair and no idempotency key, which the local host lacks", () => {
    for (const outcome of classifiedOutcomes()) {
      const { message, remediation } = localFailureRenderer.render(outcome);
      expect(`${message} ${remediation}`).not.toMatch(/repair|idempoten|same key|new key/iu);
    }
  });

  it("tells every possible commit to read the site back before any retry", () => {
    const possible = classifiedOutcomes().filter((outcome) => outcome.possibleCommit);
    expect(new Set(possible.map((outcome) => outcome.code)).size).toBeGreaterThan(3);
    for (const outcome of possible)
      expect(localFailureRenderer.render(outcome).remediation).toMatch(
        /read the site back before any retry/iu,
      );
  });

  it("never tells a write the website confirmed to run again, whatever ended it after", () => {
    for (const failure_reason of ["no_response", "invalid_input", "credentials_rejected"]) {
      const outcome = classifyRun({
        status: "completed",
        effect: "verified",
        output: "failed",
        tool_effect: "write",
        failure_reason,
      });
      expect(outcome).toMatchObject({ writeStatus: "applied", possibleCommit: true });
      if (outcome === undefined) continue;
      const { remediation } = localFailureRenderer.render(outcome);
      expect(remediation).toBe(
        "The website confirmed the action, so running the tool again would repeat it. Read the site back before any retry.",
      );
      expect(remediation).not.toMatch(/run (?:it|the tool) again|correct the/iu);
    }
  });

  // `possibleCommit` follows the code and `writeStatus` the evidence, so a code that carries no
  // possible commit can still describe a write that may have applied.
  it("tells every write that may have applied to read the site back, whatever its code", () => {
    const mayHaveApplied = classifiedOutcomes().filter(
      (outcome) => outcome.writeStatus === "may_have_applied",
    );
    expect(mayHaveApplied.some((outcome) => !outcome.possibleCommit)).toBe(true);
    for (const outcome of mayHaveApplied) {
      const { message, remediation } = localFailureRenderer.render(outcome);
      expect(remediation).toMatch(/read the site back before any retry/iu);
      expect(`${message} ${remediation}`).not.toMatch(/nothing changed/iu);
    }
  });
});

/** A renderer that words every code with the advice and the code's own retry class. */
const wellFormed: FailureRenderer = {
  codes: runOutcomeCodes,
  readBackAdvice: "Read the site back before any retry.",
  render: (outcome) => ({
    message: `The run ended as ${outcome.code}.`,
    remediation: "Read the site back before any retry.",
    retry: outcome.retry,
  }),
};
const breaking = (
  render: FailureRenderer["render"],
  codes: FailureRenderer["codes"] = runOutcomeCodes,
) =>
  failureRendererIssues({ ...wellFormed, codes, render });

describe("the renderer contract", () => {
  it("passes a well-formed renderer", () => {
    expect(failureRendererIssues(wellFormed)).toEqual([]);
  });

  it("fails a renderer that does not handle a code", () => {
    expect(breaking(wellFormed.render, runOutcomeCodes.slice(1))).toContainEqual(
      expect.stringContaining(`${runOutcomeCodes[0]}: not handled`),
    );
  });

  it("fails a renderer that throws on a code", () => {
    expect(
      breaking((outcome) => {
        if (outcome.code === "worker_lost") throw new Error("No entry");
        return wellFormed.render(outcome);
      }),
    ).toContainEqual(expect.stringMatching(/^worker_lost .*: render threw No entry$/u));
  });

  it("fails empty text", () => {
    expect(
      breaking((outcome) => ({ ...wellFormed.render(outcome), message: " " })),
    ).toContainEqual(expect.stringContaining("empty message"));
  });

  it("fails the same text for two codes", () => {
    expect(
      breaking((outcome) => ({ ...wellFormed.render(outcome), message: "The run failed early." })),
    ).toContainEqual(expect.stringContaining("same text as"));
  });

  it("fails a possible commit without the read-back advice", () => {
    expect(
      breaking((outcome: RunOutcome) => ({
        ...wellFormed.render(outcome),
        remediation: "Run it again.",
      })),
    ).toContainEqual(expect.stringContaining("no read-back advice"));
  });

  it("fails a write that may have applied without the read-back advice", () => {
    expect(
      breaking((outcome: RunOutcome) =>
        outcome.possibleCommit
          ? wellFormed.render(outcome)
          : { ...wellFormed.render(outcome), remediation: "Run it again." },
      ),
    ).toContainEqual(
      expect.stringMatching(
        /^\w+ \(possible_commit false, write_status may_have_applied\): no read-back advice$/u,
      ),
    );
  });

  it("fails a retry class the wording does not keep", () => {
    expect(
      breaking((outcome) => ({ ...wellFormed.render(outcome), retry: "same_key" })),
    ).toContainEqual(expect.stringContaining("retry same_key, expected"));
  });

  it("fails a bare failed or succeeded", () => {
    expect(breaking((outcome) => ({ ...wellFormed.render(outcome), message: "Failed." })))
      .toContainEqual(expect.stringContaining("bare"));
    expect(
      breaking((outcome) => ({
        ...wellFormed.render(outcome),
        message: `${outcome.code}.`,
        remediation: "Succeeded",
      })),
    ).toContainEqual(expect.stringContaining("bare"));
  });
});
