import { expect, test } from "@playwright/test";
import { primaryPageCode } from "../../src/runtime/host-execute.js";
import { expectNotCarried } from "./autofill-host-page.js";

// A page's target id is 32 random hex digits, so a short typed value such as a card's security
// code turns up inside one by chance. This id holds "123".
const targetId = "0123456789ABCDEF0123456789ABCDEF";

test("a call's script doesn't carry a typed value that only turns up inside a page's target id", () => {
  expectNotCarried([{ script: `${primaryPageCode(targetId)}return 1;`, answer: undefined }], "123");
});

test("a call's script that binds a page by its target id still carries a value it holds", () => {
  const script = `${primaryPageCode(targetId)}await primary.keyboard.insertText("123");`;
  expect(() => expectNotCarried([{ script, answer: undefined }], "123")).toThrow();
});
