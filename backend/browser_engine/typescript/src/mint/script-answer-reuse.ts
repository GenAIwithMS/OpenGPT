import { Effect, Either, Schema } from "effect";
import {
  InvalidAnswer,
  validateAnswer,
  type InputRequest,
  type ValidAnswers,
} from "../runtime/input-request.js";

/** The question types whose answers a later step may reuse: never a code, a secret or a login. */
const ReusableType = Schema.Literal("choice", "multi_choice", "text", "confirm");
const reusable = Schema.is(ReusableType);

/**
 * What a later ask must match to reuse an answer: the same id, type, screened prompt, and screened
 * options or a confirm's screened follow-up.
 */
const KeptQuestion = Schema.Struct({
  id: Schema.String,
  type: ReusableType,
  prompt: Schema.String,
  options: Schema.optional(
    Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
  ),
  followUp: Schema.optional(
    Schema.Struct({ prompt: Schema.String, defaultText: Schema.optional(Schema.String) }),
  ),
});
type KeptQuestion = typeof KeptQuestion.Type;

/**
 * One answer the owner gave a script's question in this build, which a later step may reuse:
 * the screened question and the answer as the asker returned it.
 */
export const KeptScriptAnswer = Schema.Struct({
  question: KeptQuestion,
  answer: Schema.Struct({ type: Schema.String, value: Schema.Unknown }),
});
export type KeptScriptAnswer = typeof KeptScriptAnswer.Type;

const KeptAnswers = Schema.Record({
  key: Schema.String,
  value: Schema.Struct({ type: Schema.String, value: Schema.Unknown }),
});
/**
 * Validates kept answers, each `{ type, value }`, by the same rules as the caller's own answer
 * values.
 */
export const validateKeptAnswers = (
  request: InputRequest,
  kept: unknown,
): Either.Either<ValidAnswers, InvalidAnswer> => {
  const decoded = Schema.decodeUnknownEither(KeptAnswers)(kept);
  return Either.isLeft(decoded)
    ? Either.left(new InvalidAnswer({ reason: "malformed" }))
    : validateAnswer(
        request,
        Object.fromEntries(Object.entries(decoded.right).map(([id, answer]) => [id, answer.value])),
      );
};

/**
 * Each question's match key, its texts screened as the owner saw them, or undefined for a question
 * no later step may reuse: a code, a secret or a login.
 */
export const scriptQuestionKeys = <E>(
  asked: InputRequest,
  screen: (text: string) => Effect.Effect<string, E>,
) =>
  Effect.forEach(asked.questions, (question) =>
    Effect.gen(function* () {
      const { type } = question;
      if (!reusable(type)) return undefined;
      const key = { id: question.id, type, prompt: yield* screen(question.prompt) };
      if (question.type === "choice" || question.type === "multi_choice") {
        const options = yield* Effect.forEach(question.options, (option) =>
          screen(option.label).pipe(Effect.map((label) => ({ id: option.id, label }))),
        );
        return { ...key, options } satisfies KeptQuestion;
      }
      if (question.type !== "confirm" || question.followUp === undefined)
        return key satisfies KeptQuestion;
      const { prompt, defaultText } = question.followUp;
      const followUp = {
        prompt: yield* screen(prompt),
        ...(defaultText === undefined ? {} : { defaultText: yield* screen(defaultText) }),
      };
      return { ...key, followUp } satisfies KeptQuestion;
    }),
  );

const sameQuestion = (left: KeptQuestion, right: KeptQuestion) =>
  JSON.stringify(left) === JSON.stringify(right);

/**
 * The kept answers a script's ask may reuse, as a fresh answer's shape, or undefined to ask the
 * owner. Every question needs a kept answer to the same question, still valid for the question as
 * asked now. Any step may reuse it, the one that got it included, as often as the question comes
 * back and however long ago the owner gave it.
 */
export const reusedScriptAnswers = (
  asked: InputRequest,
  keys: readonly (KeptQuestion | undefined)[],
  kept: readonly KeptScriptAnswer[],
): ValidAnswers | undefined => {
  const found: Record<string, KeptScriptAnswer["answer"]> = {};
  for (const key of keys) {
    const entry =
      key === undefined
        ? undefined
        : kept.find((candidate) => sameQuestion(candidate.question, key));
    if (key === undefined || entry === undefined) return undefined;
    found[key.id] = entry.answer;
  }
  const valid = validateKeptAnswers(asked, found);
  return Either.isLeft(valid) ? undefined : valid.right;
};

/**
 * The kept answers without any to these screened prompts. Only the owner's latest answer to a
 * prompt stands, as in Guardian's trusted answers, so an answer the owner gave since to a question
 * with the same prompt, whoever asked it, means the next script ask asks again.
 */
export const forgetScriptAnswers = (
  kept: readonly KeptScriptAnswer[],
  prompts: readonly string[],
): readonly KeptScriptAnswer[] => kept.filter((entry) => !prompts.includes(entry.question.prompt));

/**
 * The kept answers once the owner answered a script's question afresh: its reusable answers
 * replace any kept for the same prompt.
 */
export const keptScriptAnswers = (
  kept: readonly KeptScriptAnswer[],
  keys: readonly (KeptQuestion | undefined)[],
  answers: ValidAnswers,
): readonly KeptScriptAnswer[] => {
  const latest = keys.flatMap((key): KeptScriptAnswer[] => {
    const answer = key === undefined ? undefined : answers[key.id];
    return key === undefined || answer === undefined ? [] : [{ question: key, answer }];
  });
  return [
    ...forgetScriptAnswers(
      kept,
      latest.map((entry) => entry.question.prompt),
    ),
    ...latest,
  ];
};
