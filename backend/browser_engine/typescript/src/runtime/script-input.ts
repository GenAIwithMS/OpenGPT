import { randomUUID } from "node:crypto";
import { Context, Data, Effect, Either, Schema, SchemaAST } from "effect";
import { isCardSlot } from "../destinations/payment-frames.js";
import type { Deadline } from "./deadline.js";
import {
  ConfirmQuestion,
  InputRequest,
  QuestionId,
  questionIdPattern,
  SecretQuestion,
  TextQuestion,
  validateAnswer,
  type InputAnswers,
  type Question,
  type ValidAnswer,
} from "./input-request.js";

/**
 * A script asks its caller through the one input request (source `script`). It declares each
 * question once in its contract, so the publication review reads every prompt, and passes the
 * page's own options at ask time. Option values stay in the sandbox: the host sees opaque ids.
 */

const Prompt = ConfirmQuestion.fields.prompt;
const Selections = Schema.Int.pipe(Schema.between(0, 50));

export const ScriptQuestionDeclaration = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("choice"),
    prompt: Prompt,
    allowOther: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("multi_choice"),
    prompt: Prompt,
    /** At least one when absent. */
    minSelections: Schema.optional(Selections),
    /** Every offered option when absent; never more than the page offers. */
    maxSelections: Schema.optional(Selections),
  }),
  Schema.Struct({
    type: Schema.Literal("text"),
    prompt: Prompt,
    maxLength: TextQuestion.fields.maxLength,
  }),
  Schema.Struct({
    type: Schema.Literal("confirm"),
    prompt: Prompt,
    followUp: ConfirmQuestion.fields.followUp,
  }),
  Schema.Struct({
    type: Schema.Literal("secret"),
    prompt: Prompt,
    secretKind: SecretQuestion.fields.secretKind,
    maxLength: SecretQuestion.fields.maxLength,
  }),
  /**
   * A required field the site's form adds that no input covers. It has no prompt of its own: each
   * ask passes the field's label from the page, and its options when it is a select, so it is asked
   * as a text question or a choice and never as any other kind.
   */
  Schema.Struct({ type: Schema.Literal("site_field") }),
  // The pre-unification shape, `{ prompt }`, kept for published revisions: a single choice.
  Schema.Struct({ prompt: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(500)) }),
);
export type ScriptQuestionDeclaration = typeof ScriptQuestionDeclaration.Type;
const QuestionDeclarations = Schema.Record({
  key: QuestionId,
  value: ScriptQuestionDeclaration,
});
export const ScriptQuestionDeclarations = Schema.Unknown.pipe(
  // Check original keys before record construction can discard __proto__ or another invalid id.
  Schema.filter(
    (questions) =>
      typeof questions !== "object" ||
      questions === null ||
      Object.keys(questions).every((id) => questionIdPattern.test(id)),
    {
      message: () =>
        "question ids must start with a lowercase letter and contain only lowercase letters, digits, or underscores (up to 64 characters)",
    },
  ),
  Schema.compose(QuestionDeclarations),
).annotations({
  // Schema generation still describes the declarations rather than the unvalidated input.
  [SchemaAST.SurrogateAnnotationId]: QuestionDeclarations.ast,
});
export type ScriptQuestionDeclarations = Readonly<Record<string, ScriptQuestionDeclaration>>;

/** One option the page offers now. */
export const ScriptOption = Schema.Struct({
  /** What `ask` returns when the caller picks it. It never leaves the sandbox. */
  value: Schema.String.pipe(Schema.minLength(1)),
  /** The option as the site shows it. A long one reaches the caller shortened (`shownLabel`). */
  label: Schema.String.pipe(Schema.minLength(1)),
  /**
   * A detail of the caller's own account, such as a saved card, a passenger or an address. Its
   * full label appears only on the protected page; the API and MCP show it masked.
   */
  accountSpecific: Schema.optional(Schema.Boolean),
  /** How an account-specific option reads outside the protected page, like "Visa •••• 4242". */
  maskedLabel: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64))),
});
export type ScriptOption = typeof ScriptOption.Type;

/**
 * A question asked now: choices carry the page's options; nothing else carries any. A site field
 * carries its label from the page, with options when it is a select.
 */
interface AskSpec {
  readonly options?: ReadonlyArray<ScriptOption>;
  readonly label?: string;
}

/** What `ask` returns for one question, by its declaration. */
export type ScriptAnswerOf<Declaration> = Declaration extends { readonly type: "multi_choice" }
  ? readonly string[]
  : Declaration extends { readonly type: "confirm" }
    ? { readonly confirmed: boolean; readonly text?: string }
    : Declaration extends { readonly type: "text" | "secret" }
      ? string
      : "allowOther" extends keyof Declaration
        ? Declaration extends { readonly allowOther: false }
          ? string
          : string | { readonly other: string }
        : string;
/** Any answer `ask` returns, before its declaration narrows it. */
export type ScriptAnswer =
  | string
  | { readonly other: string }
  | readonly string[]
  | { readonly confirmed: boolean; readonly text?: string };

/**
 * What each asked question needs at ask time: the page's options for a choice, a site field's
 * label and any options from the page, else nothing.
 */
export type AskSpecOf<Declaration> = Declaration extends { readonly type: "site_field" }
  ? { readonly label: string; readonly options?: ReadonlyArray<ScriptOption> }
  : Declaration extends {
        readonly type: "text" | "secret" | "confirm";
      }
    ? { readonly options?: never }
    : { readonly options: ReadonlyArray<ScriptOption> };

/**
 * `NoResponse`: the caller did not answer in time, and the run fails as `no_response`.
 * `Undeclared`: an id the contract does not declare. `InvalidOptions`: options missing for a
 * choice, given for another type, duplicated, too many, or selection bounds they cannot meet, or a
 * site field's label missing, empty or given for another type.
 * The others mean the question could not be asked or its answer could not be used.
 *
 * `message`, when set, names the declared question, the option that stopped it by its number
 * from 1, and what is wrong with that option in fixed words. It never holds an option's value or
 * label. A failure the fixed words don't cover keeps only its code.
 */
export class ScriptInputFailure extends Data.TaggedError("ScriptInputFailure")<{
  readonly code: "Unavailable" | "NoResponse" | "Unauthorized" | "Undeclared" | "InvalidOptions";
  readonly message?: string;
}> {}

/** The runner's way to the host: the request out, the caller's raw answers back. */
export type ScriptQuestionHandler = (
  request: InputRequest,
) => Effect.Effect<InputAnswers, ScriptInputFailure>;

/** The sandbox's own side of one asked question: the option value behind each host id. */
interface Asked {
  readonly question: Question;
  readonly values: ReadonlyMap<string, string>;
}

const invalidOptions = () => new ScriptInputFailure({ code: "InvalidOptions" });

/** What can be wrong with one option, in the fixed words a run's error may carry. */
const optionProblem = {
  emptyValue: "has an empty value",
  emptyLabel: "has an empty label",
  repeatedValue: "repeats another option's value",
  extraField: "has a field options do not take",
} as const;
type OptionProblem = (typeof optionProblem)[keyof typeof optionProblem];

/** Names the declared question, the option by its number from 1 and the fixed words. */
const invalidOption = (id: string, index: number, problem: OptionProblem) =>
  new ScriptInputFailure({
    code: "InvalidOptions",
    message: `Script question ${id} could not be asked because option ${index + 1} ${problem}.`,
  });

const optionFields = new Set(Object.keys(ScriptOption.fields));
const decodeOption = Schema.decodeUnknownEither(ScriptOption, { onExcessProperty: "error" });
/** What the fixed words say is wrong with an option `ScriptOption` refuses, when they cover it. */
const problemOf = (option: unknown): OptionProblem | undefined => {
  if (typeof option !== "object" || option === null || Array.isArray(option)) return undefined;
  if (Object.keys(option).some((key) => !optionFields.has(key))) return optionProblem.extraField;
  if (Reflect.get(option, "value") === "") return optionProblem.emptyValue;
  if (Reflect.get(option, "label") === "") return optionProblem.emptyLabel;
  return undefined;
};
/** The failure for refused options, named after the first refused one when the words cover it. */
const refusedOptions = (id: string, given: unknown) => {
  if (!Array.isArray(given)) return invalidOptions();
  const index = given.findIndex((option) => Either.isLeft(decodeOption(option)));
  const problem = index < 0 ? undefined : problemOf(given[index]);
  return problem === undefined ? invalidOptions() : invalidOption(id, index, problem);
};

type GivenSpec = AskSpec | ReadonlyArray<ScriptOption>;
/** The pre-unification call passed a choice's options directly. */
const isOptionList = (spec: GivenSpec): spec is ReadonlyArray<ScriptOption> => Array.isArray(spec);

/**
 * The longest label the host takes (`InputOption`), and the longest site-field prompt, in UTF-16
 * code units as it counts them.
 */
export const longestLabel = 256;
/**
 * A label the host can show: one past `longestLabel` keeps its start and ends in "…". The cut
 * never splits a surrogate pair, so the start may be one code unit shorter. Options that read
 * the same once cut stay apart, since the host names each by its own id.
 */
const shownLabel = (label: string) => {
  if (label.length <= longestLabel) return label;
  const end = longestLabel - 1;
  const last = label.charCodeAt(end - 1);
  return `${label.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end)}…`;
};

/** The page's options with host-opaque ids, and the value behind each id. */
const offeredOptions = (id: string, given: ReadonlyArray<ScriptOption> | undefined) => {
  if (given === undefined) return Either.left(invalidOptions());
  const decoded = Schema.decodeUnknownEither(Schema.Array(ScriptOption), {
    onExcessProperty: "error",
  })(given);
  if (Either.isLeft(decoded)) return Either.left(refusedOptions(id, given));
  const options = decoded.right;
  const seen = new Set<string>();
  const repeated = options.findIndex(({ value }) => {
    if (seen.has(value)) return true;
    seen.add(value);
    return false;
  });
  if (repeated >= 0) return Either.left(invalidOption(id, repeated, optionProblem.repeatedValue));
  return Either.right({
    values: new Map(options.map((option, index) => [`o${index + 1}`, option.value])),
    offered: options.map((option, index) => ({
      id: `o${index + 1}`,
      label: shownLabel(option.label),
      ...(option.accountSpecific === undefined ? {} : { accountSpecific: option.accountSpecific }),
      ...(option.maskedLabel === undefined ? {} : { maskedLabel: option.maskedLabel }),
    })),
  });
};

/** Builds the host's question from a declaration and the options given now. */
const askedQuestion = (
  id: string,
  declaration: ScriptQuestionDeclaration,
  spec: GivenSpec,
): Either.Either<Asked, ScriptInputFailure> => {
  const given = isOptionList(spec) ? spec : spec.options;
  const label = isOptionList(spec) ? undefined : spec.label;
  // Only a site field takes a label from the page; every other prompt is the declared one.
  if (label !== undefined && !("type" in declaration && declaration.type === "site_field"))
    return Either.left(invalidOptions());
  /** A question that takes no options; giving any is a mistake. */
  const plain = (question: Question) =>
    given === undefined
      ? Either.right({ question, values: new Map<string, string>() })
      : Either.left(invalidOptions());
  if (!("type" in declaration))
    return Either.map(offeredOptions(id, given), ({ values, offered }) => ({
      question: { id, type: "choice" as const, prompt: declaration.prompt, options: offered },
      values,
    }));
  switch (declaration.type) {
    case "text":
      return plain({
        id,
        type: "text",
        prompt: declaration.prompt,
        ...(declaration.maxLength === undefined ? {} : { maxLength: declaration.maxLength }),
      });
    case "confirm":
      return plain({
        id,
        type: "confirm",
        prompt: declaration.prompt,
        ...(declaration.followUp === undefined ? {} : { followUp: declaration.followUp }),
      });
    case "secret":
      return plain({
        id,
        type: "secret",
        prompt: declaration.prompt,
        secretKind: declaration.secretKind,
        ...(declaration.maxLength === undefined ? {} : { maxLength: declaration.maxLength }),
      });
    case "multi_choice":
      return Either.flatMap(offeredOptions(id, given), ({ values, offered }) => {
        const minSelections = declaration.minSelections ?? 1;
        const maxSelections = Math.min(declaration.maxSelections ?? offered.length, offered.length);
        return minSelections > maxSelections
          ? Either.left(invalidOptions())
          : Either.right({
              question: {
                id,
                type: "multi_choice" as const,
                prompt: declaration.prompt,
                options: offered,
                minSelections,
                maxSelections,
              },
              values,
            });
      });
    case "choice":
      return Either.map(offeredOptions(id, given), ({ values, offered }) => ({
        question: {
          id,
          type: "choice" as const,
          prompt: declaration.prompt,
          options: offered,
          ...(declaration.allowOther === undefined ? {} : { allowOther: declaration.allowOther }),
        },
        values,
      }));
    case "site_field": {
      const prompt = shownLabel(typeof label === "string" ? label.trim() : "");
      if (prompt === "") return Either.left(invalidOptions());
      if (given === undefined)
        return Either.right({
          question: { id, type: "text" as const, prompt },
          values: new Map<string, string>(),
        });
      return Either.map(offeredOptions(id, given), ({ values, offered }) => ({
        question: { id, type: "choice" as const, prompt, options: offered },
        values,
      }));
    }
  }
};

/** The script's own value for one validated answer: option ids become the page's values. */
const scriptValue = (asked: Asked, answer: ValidAnswer): ScriptAnswer | undefined => {
  switch (answer.type) {
    // A script's question takes no note, and a multiple choice no own option.
    case "choice": {
      if (typeof answer.value === "string") return asked.values.get(answer.value);
      return "other" in answer.value ? { other: answer.value.other } : undefined;
    }
    case "multi_choice": {
      const selected = answer.value;
      if ("options" in selected) return undefined;
      const chosen = selected.flatMap((id) => {
        const value = asked.values.get(id);
        return value === undefined ? [] : [value];
      });
      return chosen.length === selected.length ? chosen : undefined;
    }
    case "confirm":
      return answer.value.text === undefined
        ? { confirmed: answer.value.confirmed }
        : { confirmed: answer.value.confirmed, text: answer.value.text };
    case "text":
    case "secret":
      return answer.value;
    case "credential":
      return undefined;
  }
};

type AskInput = string | ReadonlyArray<string> | Readonly<Record<string, GivenSpec>>;
const isIdList = (input: AskInput): input is ReadonlyArray<string> => Array.isArray(input);

/**
 * Asks the caller at any point of a run. The run waits with its browser open, its active budget
 * paused, and continues in place with the answer. `ask("id")` returns that question's answer;
 * `ask(["a", "b"])` and `ask({ seat: { options }, code: {} })` return one per id. A choice's
 * options come from the page at ask time; no other question takes any, except a site field, which
 * takes its label and, for a select, its options: `ask({ extra: { label, options } })`.
 */
export const makeScriptInput = (
  declared: ScriptQuestionDeclarations | undefined,
  handle: ScriptQuestionHandler | undefined,
  deadline?: Deadline,
) => {
  const askAll = (asked: Readonly<Record<string, GivenSpec>>) =>
    Effect.gen(function* () {
      const questions: Asked[] = [];
      for (const [id, spec] of Object.entries(asked)) {
        const declaration = declared && Object.hasOwn(declared, id) ? declared[id] : undefined;
        if (declaration === undefined) return yield* new ScriptInputFailure({ code: "Undeclared" });
        const built = askedQuestion(id, declaration, spec);
        if (Either.isLeft(built)) return yield* built.left;
        questions.push(built.right);
      }
      const request = yield* Schema.decodeUnknown(InputRequest)(
        { id: randomUUID(), source: "script", questions: questions.map((asked) => asked.question) },
        { onExcessProperty: "error" },
      ).pipe(Effect.mapError(invalidOptions));
      if (handle === undefined) return yield* new ScriptInputFailure({ code: "Unavailable" });
      const answers = yield* Effect.acquireUseRelease(
        Effect.sync(() => deadline?.suspend()),
        () => handle(request),
        (resume) => Effect.sync(() => resume?.()),
      );
      // A card answer reaches the script as the run's handle, never the card, so only the host
      // checks the card against its declared length.
      const valid = validateAnswer(
        {
          ...request,
          questions: request.questions.map((question) => {
            if (question.type !== "secret" || !isCardSlot(question.secretKind)) return question;
            const { maxLength: _checkedByHost, ...rest } = question;
            return rest;
          }),
        },
        answers,
      );
      if (Either.isLeft(valid)) return yield* new ScriptInputFailure({ code: "Unavailable" });
      const values: Record<string, ScriptAnswer> = {};
      for (const asked of questions) {
        const answer = valid.right[asked.question.id];
        const value = answer === undefined ? undefined : scriptValue(asked, answer);
        if (value === undefined) return yield* new ScriptInputFailure({ code: "Unavailable" });
        values[asked.question.id] = value;
      }
      return values;
    });
  const ask = (
    input: AskInput,
  ): Effect.Effect<ScriptAnswer | Readonly<Record<string, ScriptAnswer>>, ScriptInputFailure> => {
    if (typeof input === "string")
      return askAll({ [input]: {} }).pipe(
        Effect.flatMap((values) => {
          const value = values[input];
          return value === undefined
            ? Effect.fail(new ScriptInputFailure({ code: "Unavailable" }))
            : Effect.succeed(value);
        }),
      );
    if (isIdList(input)) return askAll(Object.fromEntries(input.map((id) => [id, {}])));
    return askAll(input);
  };
  return { ask };
};

export class ScriptInput extends Context.Tag("opengpt-browser-engine/ScriptInput")<
  ScriptInput,
  ReturnType<typeof makeScriptInput>
>() {}
