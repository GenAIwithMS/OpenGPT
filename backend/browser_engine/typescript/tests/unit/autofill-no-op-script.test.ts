import { expect, it } from "vitest";
import { locateCode, noOpScriptCode } from "../../src/destinations/autofill-locate-code.js";
import { submissionGuardCode } from "../../src/destinations/autofill-submission-guard.js";

const noOpScript = (0, eval)(noOpScriptCode) as (address: unknown) => boolean;

// Only a script action that does nothing is the page's own script submit. Any other script runs
// what its address says, so its form is judged as any form whose action is off the site.
it.each([
  "javascript:",
  "javascript:;",
  "javascript:void(0)",
  "javascript:void(0);",
  "javascript:void 0",
  "javascript:void 0;",
  "JAVASCRIPT:void(0)",
  " javascript: void ( 0 ) ; ",
  "java\tscript:void(0)",
  "java\nscript:vo\nid(0)",
  "javascript:%20void%280%29",
  // A line break after void is whitespace inside one expression: void (0), void 0.
  "javascript:void%0A(0)",
  "javascript:void%0A0",
  "javascript:void%0D%0A(0)",
  "javascript:void%E2%80%A8(0)",
  "javascript:void%C2%A00",
  "javascript:%EF%BB%BFvoid(0)",
])("counts %j as a script action that does nothing", (address) => {
  expect(noOpScript(address)).toBe(true);
});

it.each([
  "javascript:send()",
  "javascript:void(send())",
  "javascript:void(0);send()",
  "javascript:;send()",
  "javascript:void(1)",
  "javascript:void(0)//",
  "javascript:/**/void(0)",
  "javascript:void(0)?x=1",
  "javascript:void(0)#x",
  "javascript:%E0%A4%A",
  "javascript:%73end()",
  "javascript:%2576oid(0)",
  // Script is case-sensitive: these call a function of the page's own named Void or VOID.
  "javascript:Void(0)",
  "javascript:VOID(0)",
  // A line break inside the name splits it into two statements, the second a call of the page's
  // function named id; other whitespace inside it, or a zero-width space, is no script either.
  "javascript:vo%0Aid(0)",
  "javascript:voi%0Ad(0)",
  "javascript:v%0Aoid(0)",
  "javascript:vo%0D%0Aid(0)",
  "javascript:vo%E2%80%A8id(0)",
  "javascript:vo%C2%A0id(0)",
  "javascript:void%E2%80%8B(0)",
  "javascript:void0",
  "https://member.example.test/session",
  "data:,void(0)",
  "",
  null,
])("does not count %j as a script action that does nothing", (address) => {
  expect(noOpScript(address)).toBe(false);
});

// The destination check's page code and the submission guard judge a script action by one rule.
it("judges a script action by the same rule in the step call and the guard", () => {
  expect(locateCode).toContain(noOpScriptCode);
  expect(submissionGuardCode).toContain(noOpScriptCode);
});
