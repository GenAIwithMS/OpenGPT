import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { askDialogCaller } from "../../src/browser/dialogs/expected.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import {
  InputRequestFailure,
  InputSuperseded,
  type AskBounds,
  type InputAsker,
  type InputRequest,
} from "../../src/runtime/input-request.js";

/** An asker that answers the dialog's question with `answer`, keeping each request it got. */
const answering = (answer: { readonly confirmed: boolean; readonly text?: string }) => {
  const asked: { request: InputRequest; bounds: AskBounds | undefined }[] = [];
  const ask: InputAsker = (request, bounds) => {
    asked.push({ request, bounds });
    return makeInputAsker(() => Effect.succeed({ decision: answer }))(request, bounds);
  };
  return { ask, asked };
};
const decide = (
  ask: InputAsker,
  type: "alert" | "confirm" | "prompt" | "beforeunload",
  message = "Place this order?",
  bounds?: AskBounds,
) => Effect.runPromise(Effect.either(askDialogCaller(ask, { type, message }, bounds)));

describe("a page dialog put to the caller", () => {
  it.each([
    { type: "confirm", prompt: 'The website asks you to confirm: "Place this order?". Confirm?' },
    { type: "alert", prompt: 'The website shows a message: "Place this order?". Close it and continue?' },
    { type: "prompt", prompt: 'The website asks for text: "Place this order?". Answer it?' },
    { type: "beforeunload", prompt: "The website asks whether to leave the page. Leave it?" },
  ] as const)("asks one yes or no question about a $type", async ({ type, prompt }) => {
    const { ask, asked } = answering({ confirmed: false });
    await decide(ask, type);
    expect(asked.map(({ request }) => request.questions)).toEqual([
      [
        {
          id: "decision",
          type: "confirm",
          prompt,
          ...(type === "prompt" ? { followUp: { prompt: "Text to enter" } } : {}),
        },
      ],
    ]);
    expect(asked[0]?.request).toMatchObject({ source: "system" });
    expect(asked[0]?.request).not.toHaveProperty("notice");
  });

  it("leaves out an empty message and cuts a long question", async () => {
    const empty = answering({ confirmed: false });
    await decide(empty.ask, "confirm", "  ");
    expect(empty.asked[0]?.request.questions[0]?.prompt).toBe(
      "The website asks you to confirm. Confirm?",
    );
    const long = answering({ confirmed: false });
    await decide(long.ask, "alert", "x".repeat(3_000));
    const prompt = long.asked[0]?.request.questions[0]?.prompt ?? "";
    expect(prompt).toHaveLength(2_000);
    expect(prompt.endsWith("…")).toBe(true);
  });

  it.each([
    { answer: { confirmed: false }, type: "confirm", choice: { choice: "dismiss" } },
    { answer: { confirmed: true }, type: "confirm", choice: { choice: "accept" } },
    {
      answer: { confirmed: true, text: "gift note" },
      type: "prompt",
      choice: { choice: "accept", promptText: "gift note" },
    },
  ] as const)("turns $answer into $choice", async ({ answer, type, choice }) => {
    expect(await decide(answering(answer).ask, type)).toEqual(Either.right(choice));
  });

  it("asks within the bounds it is given", async () => {
    const { ask, asked } = answering({ confirmed: true });
    const bounds = { sourceEndsAt: Date.now() + 60_000 };
    await decide(ask, "confirm", "Place this order?", bounds);
    expect(asked[0]?.bounds).toBe(bounds);
  });

  it.each([
    { failure: new InputRequestFailure({ code: "NoResponse" }), reason: "expired" },
    { failure: new InputRequestFailure({ code: "Unauthorized" }), reason: "unauthorized" },
    { failure: new InputSuperseded(), reason: "stale_decision" },
    { failure: new InputRequestFailure({ code: "Unavailable" }), reason: "unavailable" },
    { failure: new InputRequestFailure({ code: "Refused" }), reason: "unavailable" },
    { failure: new InputRequestFailure({ code: "Invalid" }), reason: "unavailable" },
  ])("fails as $reason when the question fails that way", async ({ failure, reason }) => {
    const decided = await decide(() => Effect.fail(failure), "confirm");
    expect(Either.isLeft(decided) && decided.left).toMatchObject({ _tag: "DialogFailure", reason });
  });

  it("fails as unavailable when the answer is not the dialog's", async () => {
    const decided = await decide(() => Effect.succeed({}), "confirm");
    expect(Either.isLeft(decided) && decided.left).toMatchObject({
      _tag: "DialogFailure",
      reason: "unavailable",
    });
  });
});
