import { describe, expect, it } from "vitest";
import { Either, Schema } from "effect";
import { ScriptQuestionDeclarations } from "../../src/runtime/script-input.js";

describe("script question declarations", () => {
  const question = { type: "text", prompt: "Which page?", maxLength: 100 };

  it.each(["pageTitle", "paragraphText", "Page_title", "1_page", "page-title"])(
    "rejects an invalid id instead of projecting it away: %s",
    (id) => {
      const decoded = Schema.decodeUnknownEither(ScriptQuestionDeclarations)({
        page_title: question,
        [id]: question,
      });
      expect(Either.isLeft(decoded)).toBe(true);
    },
  );

  it("rejects an invalid own prototype key before decoding the record", () => {
    const input: unknown = JSON.parse(
      '{"page_title":{"type":"text","prompt":"Which page?"},"__proto__":{"type":"text","prompt":"Which page?"}}',
    );
    expect(Either.isLeft(Schema.decodeUnknownEither(ScriptQuestionDeclarations)(input))).toBe(true);
  });

  it("keeps ordinary question-value decoding", () => {
    const decoded = Schema.decodeUnknownEither(ScriptQuestionDeclarations)({
      page_title: { ...question, extra: "ignored" },
    });
    expect(decoded).toEqual(Either.right({ page_title: question }));
  });

  it("preserves explicitly strict question-value decoding", () => {
    const decoded = Schema.decodeUnknownEither(ScriptQuestionDeclarations, {
      onExcessProperty: "error",
    })({ page_title: { ...question, extra: "refused" } });
    expect(Either.isLeft(decoded)).toBe(true);
  });

  it("preserves every valid id", () => {
    const decoded = Schema.decodeUnknownEither(ScriptQuestionDeclarations)({
      page_title: question,
      paragraph_text: question,
    });
    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isRight(decoded))
      expect(Object.keys(decoded.right)).toEqual(["page_title", "paragraph_text"]);
  });
});
