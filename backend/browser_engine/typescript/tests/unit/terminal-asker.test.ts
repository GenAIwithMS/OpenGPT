import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { Effect, Either } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { makeTerminalAsker, OwnerCancelled } from "../../src/inputs/terminal.js";

const stdin = Object.getOwnPropertyDescriptor(process, "stdin");
afterEach(() => {
  if (stdin !== undefined) Object.defineProperty(process, "stdin", stdin);
  vi.restoreAllMocks();
});

it("reports the owner closing the input at a question as their own cancel, still NoResponse", async () => {
  const input = new PassThrough();
  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const asked = Effect.runPromise(
    Effect.either(
      makeTerminalAsker()({
        id: randomUUID(),
        source: "system",
        questions: [
          {
            id: "choice",
            type: "choice",
            prompt: "How should OpenGPT respond to this dialog?",
            options: [
              { id: "accept", label: "Accept" },
              { id: "dismiss", label: "Dismiss" },
            ],
          },
        ],
      }),
    ),
  );
  input.end();
  const answered = await asked;
  expect(Either.isLeft(answered) && answered.left).toBeInstanceOf(OwnerCancelled);
  expect(Either.isLeft(answered) && answered.left).toMatchObject({
    _tag: "InputRequestFailure",
    code: "NoResponse",
  });
});
