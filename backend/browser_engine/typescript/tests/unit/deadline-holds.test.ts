import { expect, it } from "vitest";
import { Deadline } from "../../src/runtime/deadline.js";

it("suspends each human hold without resetting the unused active budget", () => {
  let now = 0;
  const deadline = Deadline.after(1_200_000, () => now);
  now = 50_000;
  const resume = deadline.suspend();
  now += 180_000;
  expect(deadline.remainingMs()).toBe(1_150_000);
  resume();
  resume();
  now += 20_000;
  const resumeAgain = deadline.suspend();
  now += 180_000;
  resumeAgain();
  expect(deadline.remainingMs()).toBe(1_130_000);
  now += 1_130_001;
  expect(deadline.remainingMs()).toBe(0);
});

it("keeps an outer mint hold after a nested request hold releases and preserves finite children", () => {
  let now = 0;
  const deadline = Deadline.after(1_200_000, () => now);
  const releaseMint = deadline.suspend();
  now = 1_300_000;
  const releaseRequest = deadline.suspend();
  now = 3_700_000;
  releaseRequest();
  expect(deadline.remainingMs()).toBe(1_200_000);
  const child = deadline.child(500);
  now += 501;
  expect(child.remainingMs()).toBe(0);
  expect(deadline.remainingMs()).toBe(1_200_000);
  releaseMint();
  releaseMint();
  now += 1_200_001;
  expect(deadline.remainingMs()).toBe(0);
});
