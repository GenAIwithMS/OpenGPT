import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  type CardFillOutcome,
  makeRunCardHandles,
  scriptCardFillAnswer,
} from "../../src/destinations/card-fill.js";
import type { CardSlot } from "../../src/destinations/payment-frames.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import {
  LocalOperationFailure,
  type LocalOperationOptions,
  runLocalOperation,
} from "../../src/execution/local-operation.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import {
  cardReadback,
  cardReadbackRefusal,
  cardReadbackRule,
} from "../../src/mint/card-readback.js";
import { failureDetail } from "../../src/runtime/failure-detail.js";
import type { ScriptCardFillRequest } from "../../src/runtime/script-card-fill.js";
import type { ScriptQuestionDeclarations } from "../../src/runtime/script-input.js";

const operation = (contract: string, body: string) => `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation(${contract}, ${body});`;

const card = "4242424242424242";
const questions = {
  card: { type: "secret", secretKind: "card_number", prompt: "Card number?" },
  cvc: { type: "secret", secretKind: "card_cvc", prompt: "Security code?" },
  code: { type: "secret", secretKind: "one_time_code", prompt: "Code the site sent?" },
} as const satisfies ScriptQuestionDeclarations;
const booking = operation(
  `{name:"book",input:Schema.Unknown,output:Schema.Unknown,questions:${JSON.stringify(questions)}}`,
  `async ({ ask, fillCard }) => {
    const answer = await ask(["card", "cvc", "code"]);
    const filled = await fillCard({ fields: [
      { selector: "#number", handle: answer.card },
      { selector: "#cvc", handle: answer.cvc },
    ] });
    return { answer, filled };
  }`,
);

const filledOutcome = (slots: readonly CardSlot[]): CardFillOutcome => ({
  status: "filled",
  observations: JSON.stringify({ cardFill: "filled" }),
  report: {
    outcome: "filled",
    fields: slots.map((slot) => ({ slot, status: "filled" })),
    submit: "none",
    url: "https://shop.example.test/checkout",
    typed: true,
  },
  typed: true,
});

/** One run of `source` on a live page that takes no call, with the host's card fill `cardFill`. */
const run = (
  source: string,
  cardFill?: LocalOperationOptions["cardFill"],
  declared: ScriptQuestionDeclarations = questions,
) => {
  const asked: unknown[] = [];
  const ask = makeInputAsker((request) =>
    Effect.sync(() => {
      asked.push(request);
      const given: Record<string, string> = { card, cvc: "123", code: "551204" };
      return Object.fromEntries(request.questions.map(({ id }) => [id, given[id] ?? ""]));
    }),
  );
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* createLocalWorkspace();
        return yield* Effect.either(
          runLocalOperation({
            workspace,
            entrypoint: "src/tool.mjs",
            sources: [["src/tool.mjs", source]],
            input: {},
            browser: {
              sessionId: "session_1",
              executeResponse: () => Effect.fail(new Error("The script made no page call")),
            },
            siteOrigin: "https://shop.example.test",
            target: "browser",
            ask,
            declaredQuestions: declared,
            ...(cardFill === undefined ? {} : { cardFill }),
          }),
        );
      }),
    ),
  ).then((result) => ({ result, asked }));
};

describe("a script's card questions and fillCard", () => {
  it("hands the script a handle for each card answer and has the host type the card", async () => {
    const seen: {
      step: ScriptCardFillRequest;
      kinds: (CardSlot | undefined)[];
      values: readonly string[] | undefined;
    }[] = [];
    const { result, asked } = await run(booking, ({ step, handles }) =>
      Effect.sync(() => {
        const named = step.fields.map((field) => field.handle);
        seen.push({ step, kinds: named.map(handles.kindOf), values: handles.cardValues(named) });
        return filledOutcome(["card_number", "card_cvc"]);
      }),
    );
    expect(asked).toHaveLength(1);
    expect(Either.isRight(result)).toBe(true);
    if (Either.isLeft(result)) return;
    // The script holds handles for the card's parts; another secret reaches it as ever.
    expect(result.right.output).toEqual({
      answer: { card: "{{card.c1}}", cvc: "{{card.c2}}", code: "551204" },
      filled: {
        fields: [
          { slot: "card_number", status: "filled" },
          { slot: "card_cvc", status: "filled" },
        ],
      },
    });
    expect(JSON.stringify(result.right)).not.toContain(card);
    // The host types the values behind exactly the handles the script named.
    expect(seen).toEqual([
      {
        step: {
          fields: [
            { selector: "#number", handle: "{{card.c1}}" },
            { selector: "#cvc", handle: "{{card.c2}}" },
          ],
        },
        kinds: ["card_number", "card_cvc"],
        values: [card, "123"],
      },
    ]);
  });

  it("checks a card answer's declared length on the host, not against its handle", async () => {
    // A handle such as {{card.c2}} is longer than a security code's declared 4 characters.
    const short = {
      card: { type: "secret", secretKind: "card_number", prompt: "Card number?", maxLength: 19 },
      cvc: { type: "secret", secretKind: "card_cvc", prompt: "Security code?", maxLength: 4 },
    } as const satisfies ScriptQuestionDeclarations;
    const source = operation(
      `{name:"book",input:Schema.Unknown,output:Schema.Unknown,questions:${JSON.stringify(short)}}`,
      `async ({ ask }) => ({ answer: await ask(["card", "cvc"]) })`,
    );
    const { result } = await run(source, () => Effect.succeed(filledOutcome(["card_number"])), short);
    if (Either.isLeft(result)) throw result.left;
    expect(result.right.output).toEqual({
      answer: { card: "{{card.c1}}", cvc: "{{card.c2}}" },
    });
  });

  it("fails the run with the host's reason, as not sent, when the host typed nothing", async () => {
    const { result } = await run(booking, () =>
      Effect.succeed({
        status: "refused",
        observations: JSON.stringify({
          cardFill: "refused",
          message: "The host typed nothing: the page's top document is not on this site.",
        }),
      }),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isRight(result)) return;
    expect(result.left).toBeInstanceOf(LocalOperationFailure);
    expect(result.left.message).toBe(
      "The host typed nothing: the page's top document is not on this site.",
    );
    expect(result.left.message).not.toContain(card);
  });

  it("keeps the card out of a run with no card fill, whose fillCard throws", async () => {
    const { result } = await run(booking);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isRight(result)) return;
    expect(result.left.message).toBe("This run has no card fill");
  });

  it("refuses a step that names a handle twice or is not a card handle, before the host", async () => {
    let called = false;
    const twice = booking.replace(`handle: answer.cvc`, `handle: answer.card`);
    const { result } = await run(twice, () =>
      Effect.sync(() => {
        called = true;
        return filledOutcome(["card_number"]);
      }),
    );
    expect(called).toBe(false);
    expect(Either.isLeft(result) && result.left.message).toBe(
      "fillCard takes one to four fields, each its own selector and a card handle ask returned, each handle once",
    );
    const plain = booking.replace(`handle: answer.cvc`, `handle: answer.code`);
    const second = await run(plain, () =>
      Effect.sync(() => {
        called = true;
        return filledOutcome(["card_number"]);
      }),
    );
    expect(called).toBe(false);
    expect(Either.isLeft(second.result)).toBe(true);
  });
});

describe("a run's card handles", () => {
  it("issues a handle per card answer and gives values only for handles it issued", () => {
    const handles = makeRunCardHandles();
    const number = handles.issue(card, "card_number");
    const expiry = handles.issue("12 / 34", "card_expiry");
    expect([number, expiry]).toEqual(["{{card.c1}}", "{{card.c2}}"]);
    expect(handles.kindOf(expiry)).toBe("card_expiry");
    expect(handles.kindOf("{{card.c3}}")).toBeUndefined();
    expect(handles.cardValues([expiry, number])).toEqual(["12 / 34", card]);
    expect(handles.cardValues([number, "{{card.c9}}"])).toBeUndefined();
  });

  it("answers a script with slots and statuses, or the reason with no value", () => {
    expect(scriptCardFillAnswer(filledOutcome(["card_number"]))).toEqual({
      outcome: "filled",
      fields: [{ slot: "card_number", status: "filled" }],
    });
    expect(
      scriptCardFillAnswer({
        status: "uncertain",
        observations: JSON.stringify({ cardFill: "uncertain", reason: "fill_call_failed" }),
        report: {
          outcome: "uncertain",
          reason: "fill_call_failed",
          typed: true,
          failureDetail: failureDetail("autofill_step_failed", { phase: "typing" }),
        },
        typed: true,
      }),
    ).toEqual({
      outcome: "uncertain",
      typed: true,
      message: JSON.stringify({ cardFill: "uncertain", reason: "fill_call_failed" }),
    });
  });
});

describe("source that could read a typed card back", () => {
  const fills = `const answer = {};\nawait fillCard({ fields: [{ selector: "#number", handle: answer.card }] });`;
  const rule = cardReadbackRule;
  it.each([
    ["inputValue", `return await page.locator("#number").inputValue();`, "reads a field's value"],
    ["getProperty", `return await (await page.$("#number")).getProperty("value");`, "reads a field's value"],
    ["jsonValue", `return await field.jsonValue();`, "reads a field's value"],
    ["getAttribute(\"value\")", `return await page.locator("#number").getAttribute("value");`, "reads a field's value"],
    ["getAttribute of a name built at run time", `return await page.locator("#number").getAttribute(name);`, "reads a field's value"],
    ["page.content()", `return await page.content();`, "reads the page's markup"],
    ["innerHTML", `return await page.locator("form").innerHTML();`, "reads the page's markup"],
    ["outerHTML", `return await field.evaluate((e) => e.outerHTML);`, "reads the page's markup"],
    ["$eval", `return await page.$eval("#number", (e) => e.value);`, "runs code in the page"],
    ["evaluate", `return await frame.evaluate(() => 1);`, "runs code in the page"],
    ["waitForFunction", `await page.waitForFunction(() => document.title !== "");`, "runs code in the page"],
    ["addStyleTag", `await page.addStyleTag({ content: "input[value^='4']{background:url(x)}" });`, "plants code in the page"],
    ["newCDPSession", `await page.context().newCDPSession(page);`, "opens a DevTools session"],
    ["newBrowserCDPSession", `await browser.newBrowserCDPSession();`, "opens a DevTools session"],
    ["ariaSnapshot", `return await page.locator("body").ariaSnapshot();`, "reads an accessibility snapshot"],
    ["a screenshot", `return (await page.screenshot()).toString("base64");`, "takes a screenshot"],
    ["page[\"pdf\"]()", `return await page["pdf"]();`, "prints the page"],
    ["tracing", `await context.tracing.start({ screenshots: true, snapshots: true });`, "records the page"],
    ["startTracing", `await browser.startTracing(page, { screenshots: true });`, "records the page"],
    ["a screencast", `await page.screencast({ path: "pay.webm" });`, "records the page"],
    ["routeFromHAR", `await context.routeFromHAR("pay.har", { update: true });`, "records the page"],
    ["an octal escape", String.raw`return await page["\145valuate"](() => 1);`, "runs code in the page"],
    ["a \\u escape in a name", String.raw`return await page.\u0065valuate(() => 1);`, "runs code in the page"],
    ["a \\x escape in a string-named member", String.raw`return await page["\x70df"]();`, "prints the page"],
    ["a request body", `page.on("request", (r) => r.postData());`, "reads a request body"],
  ])("refuses %s in a file beside a fillCard", (_, code, does) => {
    const files = new Map([
      ["src/tool.mjs", fills],
      ["explore/look.mjs", code],
    ]);
    expect(cardReadback(files, false)).toEqual({ path: "explore/look.mjs", line: 1, does });
    expect(cardReadbackRefusal(files, { target: "liveBrowser" }, false)).toBe(
      `explore/look.mjs line 1 ${does}: ${rule}. Nothing was executed.`,
    );
    expect(cardReadbackRefusal(files, { target: "savedDOM" }, true)).toBeUndefined();
  });

  it.each([
    ["an alias", `const { fillCard: type } = context;\nawait type(step);`],
    ["a string-named member", `await context["fillCard"](step);`],
    ["an escaped name", String.raw`await context["\u0066illCard"](step);`],
  ])("finds a fillCard reached through %s", (_, call) => {
    const files = new Map([
      ["src/tool.mjs", call],
      ["explore/look.mjs", `return await page.content();`],
    ]);
    expect(cardReadback(files, false)?.does).toBe("reads the page's markup");
  });

  it("scans every file Node could run, and no other", () => {
    const fillsAnd = (path: string, code: string) =>
      cardReadback(new Map([["src/tool.mjs", fills], [path, code]]), false);
    expect(fillsAnd("src/helper.cjs", "module.exports = (page) => page.content();")?.path).toBe(
      "src/helper.cjs",
    );
    expect(fillsAnd("explore/look.mts", "await page.evaluate(() => 1);")?.path).toBe("explore/look.mts");
    expect(fillsAnd("scratch/notes.md", "Use page.evaluate to read the total.")).toBeUndefined();
    expect(fillsAnd("src/fixture.json", '{"evaluate": true}')).toBeUndefined();
  });

  it("applies to every live step once the build has the caller's card, fillCard or not", () => {
    const files = new Map([["explore/look.mjs", `return await page.locator("#number").inputValue();`]]);
    expect(cardReadback(files, false)).toBeUndefined();
    expect(cardReadbackRefusal(files, { target: "liveBrowser" }, false)).toBeUndefined();
    expect(cardReadbackRefusal(files, { target: "liveBrowser" }, true)).toBe(
      `explore/look.mjs line 1 reads a field's value: ${rule}. Nothing was executed.`,
    );
  });

  it("refuses nothing in source that never fills a card, or fills one and only acts", () => {
    expect(
      cardReadback(new Map([["src/tool.mjs", `await page.locator("#q").inputValue();`]]), false),
    ).toBeUndefined();
    expect(
      cardReadback(
        new Map([
          [
            "src/tool.mjs",
            `${fills}\nawait page.getByRole("button", { name: "Pay" }).click();\nconst label = await page.locator("#n").getAttribute("aria-label");\nconst receipt = "invoice.pdf";`,
          ],
        ]),
        false,
      ),
    ).toBeUndefined();
  });

  it("joins a line continuation in a string, and names the line the code starts on", () => {
    const files = new Map([
      ["src/tool.mjs", fills],
      ["explore/look.mjs", `const a = 1;\nconst name = "ev\\\naluate";\nawait page[name](() => 1);`],
    ]);
    expect(cardReadback(files, false)).toEqual({
      path: "explore/look.mjs",
      line: 2,
      does: "runs code in the page",
    });
  });

  it("reads only the authored folders, so a skill that names fillCard turns nothing on", () => {
    const files = new Map([
      [".agents/caller-input/SKILL.md", "Pass the handles to the context's `fillCard`."],
      ["explore/look.mjs", `return await page.locator("#number").inputValue();`],
    ]);
    expect(cardReadback(files, false)).toBeUndefined();
    expect(
      cardReadback(new Map([["src/tool.mjs", fills], ["notes/look.mjs", "await page.evaluate(() => 1);"]]), false),
    ).toBeUndefined();
  });
});
