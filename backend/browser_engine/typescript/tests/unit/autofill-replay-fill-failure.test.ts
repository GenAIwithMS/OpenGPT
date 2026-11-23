import { expect, it } from "vitest";
import type { AutofillStepReport } from "../../src/destinations/autofill-step.js";
import { fillFailure } from "../../src/runtime/autofill-replay-steps.js";

// A screen with code boxes and no submit whose page sent the code itself once the last box was
// filled reports `submit: page`: the screen is done, as after the host's click.

type Submit = Extract<AutofillStepReport, { readonly outcome: "filled" }>["submit"];

const boxes = (submit: Submit): AutofillStepReport => ({
  outcome: "filled",
  fields: Array.from({ length: 6 }, () => ({ slot: "code" as const, status: "filled" as const })),
  submit,
  url: "https://login.example.test/verify",
});

it("completes a screen whose page sent what the host filled itself", () => {
  expect(fillFailure(boxes("page"))).toBeUndefined();
});

it("still fails a screen whose submit never went out", () => {
  expect(fillFailure(boxes("stayed_disabled"))).toBe("submit_stayed_disabled");
});
