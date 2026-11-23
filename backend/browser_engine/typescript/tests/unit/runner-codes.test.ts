import { expect, it } from "vitest";
import { finiteRunnerFailure } from "../../src/mint/runner-failure.js";

// A finished runner's code survives the host's finite projection only when the host knows it.

const failed = (errorCode: string) =>
  finiteRunnerFailure({
    status: "failed",
    effect: "not_sent",
    captureGap: "capture_publication",
    errorCode,
  })?.errorCode;

it("keeps an unapplied input's code, and an older runtime's name for it", () => {
  expect(failed("InputNotApplied")).toBe("InputNotApplied");
  expect(failed("LocationNotApplied")).toBe("LocationNotApplied");
  expect(failed("The page said something")).toBe("unclassified");
});
