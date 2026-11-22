import { Effect } from "effect";
import { expect, it } from "vitest";
import type { AutofillStepReport } from "../../src/destinations/autofill-step.js";
import { makeAfterSubmit } from "../../src/standalone/after-submit.js";

// What the minter reads of each sign-in step's report never holds where the click went, which is
// the host's alone, on any path: controls saved, a failed step with the last saved controls, or a
// clicked step whose controls the page did not give.

const navigated = {
  from: "https://login.example.net",
  origins: ["https://login.example.net", "https://auth.example.org"],
  document: 1000.5,
  pathname: "/password",
};
const controls = {
  controls: [
    {
      role: "textbox",
      name: "Password",
      type: "password",
      required: true,
      visible: true,
      enabled: true,
    },
  ],
  total: 1,
};
const filled = (submit: "clicked" | "failed", withControls: boolean): AutofillStepReport => ({
  outcome: "filled",
  fields: [{ slot: "password", status: "filled" }],
  submit,
  url: "https://auth.example.org/password",
  navigated,
  ...(withControls ? { controls } : {}),
});

it("strips where the click went from every step result the minter reads", async () => {
  const afterSubmit = makeAfterSubmit({
    workspace: { install: () => Effect.void },
    screen: (value) => Effect.succeed(value),
  });
  const results = [];
  for (const report of [filled("clicked", true), filled("failed", false), filled("clicked", false)])
    results.push(await Effect.runPromise(afterSubmit(report)));
  expect(results.map((result) => Object.keys(result).sort())).toEqual([
    ["fields", "nextScreen", "outcome", "submit", "url"],
    ["fields", "lastScreen", "outcome", "submit", "url"],
    ["fields", "outcome", "submit", "url"],
  ]);
});
