import { expect, it } from "vitest";
import {
  signInRedirectTrusts,
  workspaceOriginDecision,
} from "../../src/guardian/sign-in-origin-reviews.js";

const rationale = "The site's own sign-in sent this account there.";

it.each([
  [{ outcome: "allow", label: "workspace" }, "workspace"],
  [{ outcome: "allow", label: "shared_host" }, "shared_host"],
  // An allow that does not say which kind of host it is trusts nothing.
  [{ outcome: "allow" }, "deny"],
  [{ outcome: "allow", label: "something_else" }, "deny"],
  [{ outcome: "deny" }, "deny"],
  [{ outcome: "deny", label: "workspace" }, "deny"],
  [{ outcome: "deny", label: "unrecognized" }, "deny"],
  [{ outcome: "allow", label: "unrecognized" }, "deny"],
] as const)("a workspace_origin decision %o is %s", (decision, expected) => {
  expect(workspaceOriginDecision({ rationale, ...decision })).toBe(expected);
});

it.each([
  [{ outcome: "allow", label: "identity_provider" }, true],
  // An allow that does not say what the host is trusts nothing.
  [{ outcome: "allow" }, false],
  [{ outcome: "allow", label: "unrecognized" }, false],
  [{ outcome: "deny", label: "identity_provider" }, false],
  [{ outcome: "deny", label: "unrecognized" }, false],
  [{ outcome: "escalate" }, false],
] as const)("a sign_in_redirect decision %o trusts the origin: %s", (decision, expected) => {
  expect(signInRedirectTrusts({ rationale, ...decision })).toBe(expected);
});
