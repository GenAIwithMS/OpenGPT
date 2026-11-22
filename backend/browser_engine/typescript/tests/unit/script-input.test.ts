import { Cause, Effect, Either, Exit } from "effect";
import { describe, expect, it } from "vitest";
import type { InputAnswers, InputRequest } from "../../src/runtime/input-request.js";
import {
  makeScriptInput,
  type ScriptOption,
  type ScriptQuestionDeclarations,
} from "../../src/runtime/script-input.js";

const questions: ScriptQuestionDeclarations = {
  pick: { type: "choice", prompt: "Which entry?" },
  picks: { type: "multi_choice", prompt: "Which entries?" },
};

/** Asks one choice with `options`, answers it with `answer`, and returns what each side saw. */
const ask = (
  options: ReadonlyArray<ScriptOption>,
  answer: (request: InputRequest) => InputAnswers = (request) => {
    const first = request.questions[0];
    return { pick: first?.type === "choice" ? (first.options[0]?.id ?? "") : "" };
  },
  id: "pick" | "picks" = "pick",
) => {
  const sent: InputRequest[] = [];
  const result = Effect.runSync(
    Effect.either(
      makeScriptInput(questions, (request) =>
        Effect.sync(() => {
          sent.push(request);
          return answer(request);
        }),
      ).ask({ [id]: { options } }),
    ),
  );
  const question = sent[0]?.questions[0];
  const offered =
    question?.type === "choice" || question?.type === "multi_choice" ? question.options : undefined;
  return { result, offered };
};

const picked = (optionId: string) => () => ({ pick: optionId });

describe("a script question's options", () => {
  it("accepts a long value and returns it unchanged", () => {
    const value = `entry:${"v".repeat(994)}`;
    const { result, offered } = ask([
      { value, label: "First" },
      { value: "second", label: "Second" },
    ]);
    expect(value).toHaveLength(1000);
    expect(offered?.map((option) => option.label)).toEqual(["First", "Second"]);
    expect(result).toEqual(Either.right({ pick: value }));
  });

  it("shortens a long label to 255 characters and an ellipsis", () => {
    const label = "Synthetic note ".repeat(20);
    const { result, offered } = ask([{ value: "first", label }]);
    expect(label).toHaveLength(300);
    expect(offered?.[0]?.label).toBe(`${label.slice(0, 255)}…`);
    expect(offered?.[0]?.label).toHaveLength(256);
    expect(result).toEqual(Either.right({ pick: "first" }));
  });

  it("keeps a label of exactly 256 characters as it is", () => {
    const label = "x".repeat(256);
    expect(ask([{ value: "first", label }]).offered?.[0]?.label).toBe(label);
  });

  it("never splits a character written as a surrogate pair", () => {
    // 254 letters put the pair at code units 254 and 255, across the 255 cut.
    const label = `${"a".repeat(254)}😀${"b".repeat(50)}`;
    const shown = ask([{ value: "first", label }]).offered?.[0]?.label;
    expect(shown).toBe(`${"a".repeat(254)}…`);
    expect(shown?.isWellFormed()).toBe(true);
  });

  it("shortens long labels of a multiple choice too", () => {
    const label = "y".repeat(400);
    const { result, offered } = ask(
      [
        { value: "first", label },
        { value: "second", label: "Second" },
      ],
      () => ({ picks: ["o1", "o2"] }),
      "picks",
    );
    expect(offered?.map((option) => option.label)).toEqual([`${"y".repeat(255)}…`, "Second"]);
    expect(result).toEqual(Either.right({ picks: ["first", "second"] }));
  });

  it("tells apart two labels that read the same once shortened, by the value behind each", () => {
    const shared = "Same opening words ".repeat(14);
    const options = [
      { value: "first", label: `${shared} then the first ending` },
      { value: "second", label: `${shared} then the second ending` },
    ];
    const { result, offered } = ask(options, picked("o2"));
    expect(offered).toEqual([
      { id: "o1", label: `${shared.slice(0, 255)}…` },
      { id: "o2", label: `${shared.slice(0, 255)}…` },
    ]);
    expect(result).toEqual(Either.right({ pick: "second" }));
  });

  it("still refuses an empty value or label, a repeated value, and a field options don't take", () => {
    const refused = Either.left(expect.objectContaining({ code: "InvalidOptions" }));
    const long = "z".repeat(300);
    expect(ask([{ value: "", label: "Empty value" }]).result).toEqual(refused);
    expect(ask([{ value: "first", label: "" }]).result).toEqual(refused);
    expect(
      ask([
        { value: "same", label: "First" },
        { value: "same", label: "Second" },
      ]).result,
    ).toEqual(refused);
    expect(
      ask([
        { value: long, label: "First" },
        { value: long, label: "Second" },
      ]).result,
    ).toEqual(refused);
    expect(
      ask([{ value: "first", label: "First", note: "extra" } as unknown as ScriptOption]).result,
    ).toEqual(refused);
  });
});

describe("a script question that can't be asked", () => {
  /** The failure's message, or undefined when the question was asked. */
  const refusal = (
    options: ReadonlyArray<unknown>,
    id: "pick" | "picks" = "pick",
  ): string | undefined => {
    const { result } = ask(options as ReadonlyArray<ScriptOption>, undefined, id);
    if (Either.isRight(result)) return undefined;
    expect(result.left).toMatchObject({ _tag: "ScriptInputFailure", code: "InvalidOptions" });
    return result.left.message;
  };
  const first = { value: "entry-first-7f3a", label: "First entry 7f3a" };
  const second = { value: "entry-second-9c1d", label: "Second entry 9c1d" };

  it.each([
    [
      "an empty value",
      [first, { value: "", label: "Third entry 2b6e" }],
      "Script question pick could not be asked because option 2 has an empty value.",
    ],
    [
      "an empty label",
      [{ value: "entry-third-2b6e", label: "" }, second],
      "Script question pick could not be asked because option 1 has an empty label.",
    ],
    [
      "a repeated value",
      [first, second, { value: first.value, label: "Third entry 2b6e" }],
      "Script question pick could not be asked because option 3 repeats another option's value.",
    ],
    [
      "a field options don't take",
      [first, { ...second, note: "Extra note 4d8f" }],
      "Script question pick could not be asked because option 2 has a field options do not take.",
    ],
  ])("names the question and the option with %s", (_, options, message) => {
    expect(refusal(options)).toBe(message);
  });

  it("says the same for a multiple choice", () => {
    expect(refusal([first, second, { ...first, label: "Again" }], "picks")).toBe(
      "Script question picks could not be asked because option 3 repeats another option's value.",
    );
  });

  it("names the first option that fails", () => {
    expect(refusal([first, { value: "", label: "" }, { value: "", label: "Third" }])).toBe(
      "Script question pick could not be asked because option 2 has an empty value.",
    );
  });

  it("never says an option's value or label", () => {
    const extra = { value: "entry-extra-5e0b", label: "Extra entry 5e0b", note: "Note 6a2c" };
    const cases = [
      [first, { value: "", label: "Empty value 1f9e" }],
      [first, { value: "entry-empty-label-3d7c", label: "" }],
      [first, second, { value: second.value, label: "Repeat 8b4a" }],
      [first, extra],
    ];
    for (const options of cases) {
      const message = refusal(options);
      expect(message).toMatch(/^Script question pick could not be asked because option \d /);
      const said = options.flatMap((option) => Object.values(option)).filter((text) => text !== "");
      for (const text of said) expect(message).not.toContain(text);
    }
  });

  it("says nothing more for a failure no fixed reason covers", () => {
    expect(refusal([first, { value: 5, label: "Number value" }])).toBe("");
    expect(refusal([first, { ...second, maskedLabel: "m".repeat(65) }])).toBe("");
    expect(refusal([first, "entry-text"])).toBe("");
    expect(refusal([first, ["entry-list"]])).toBe("");
    expect(refusal([])).toBe("");
  });

  it("no longer fails on a label over 256 characters, which reaches the caller shortened", () => {
    expect(refusal([{ value: "first", label: "l".repeat(400) }])).toBeUndefined();
  });

  it("prints its message where Effect renders the failure", () => {
    const exit = Effect.runSyncExit(
      makeScriptInput(questions, () => Effect.succeed({})).ask({
        pick: { options: [first, { value: "", label: "Third entry 2b6e" }] },
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const printed = Cause.pretty(exit.cause);
      expect(printed).toContain(
        "ScriptInputFailure: Script question pick could not be asked because option 2 has an empty value.",
      );
      expect(printed).not.toContain("An error has occurred");
    }
  });
});

describe("a site-field question's label", () => {
  const declared: ScriptQuestionDeclarations = {
    extra: { type: "site_field" },
    pick: { type: "choice", prompt: "Which entry?" },
  };
  /** What the script input sends for `asked`, or why it sent nothing. */
  const sent = (asked: Parameters<ReturnType<typeof makeScriptInput>["ask"]>[0]) => {
    const requests: InputRequest[] = [];
    const result = Effect.runSync(
      Effect.either(
        makeScriptInput(declared, (request) =>
          Effect.sync(() => {
            requests.push(request);
            const [question] = request.questions;
            return { extra: question?.type === "choice" ? (question.options[0]?.id ?? "") : "J.D." };
          }),
        ).ask(asked),
      ),
    );
    return { result, question: requests[0]?.questions[0] };
  };

  it("asks the page's label as the prompt and returns the answer, or the picked option's value", () => {
    expect(sent({ extra: { label: "  Engraving text " } })).toEqual({
      result: Either.right({ extra: "J.D." }),
      question: { id: "extra", type: "text", prompt: "Engraving text" },
    });
    const { result } = sent({ extra: { label: "Engraving", options: [{ value: "initials-value", label: "Initials" }] } });
    expect(result).toEqual(Either.right({ extra: "initials-value" }));
  });

  it("shortens a label over 256 characters, as it does an option's", () => {
    const label = "Engraving detail ".repeat(20);
    expect(sent({ extra: { label } }).question?.prompt).toBe(`${label.slice(0, 255)}…`);
  });

  it("refuses a missing or empty label, and a label on a question that is not a site field", () => {
    const refused = Either.left(expect.objectContaining({ code: "InvalidOptions" }));
    expect(sent("extra").result).toEqual(refused);
    expect(sent({ extra: { label: "   " } }).result).toEqual(refused);
    expect(
      sent({ pick: { label: "Engraving", options: [{ value: "a", label: "A" }] } as never }).result,
    ).toEqual(refused);
  });
});
