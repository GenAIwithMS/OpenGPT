import { Effect, Schema } from "effect";
import type { DecisionLedger, PublicationDecision } from "../mint/contracts.js";
import {
  type InputOption,
  type InputRequest,
  isProtectedQuestion,
  publicOptionLabel,
  type Question,
  type SecretKind,
  type ValidAnswers,
} from "../runtime/input-request.js";

export const QuestionDecision = Schema.Struct({
  outcome: Schema.Literal("allow_business", "authentication", "reword"),
  rationale: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1000)),
});
export type QuestionDecision = typeof QuestionDecision.Type;

/** One offered option as the caller sees it: the full label, and the masked one the API shows. */
interface ReviewedOption {
  readonly label: string;
  readonly accountSpecific?: true;
  readonly maskedLabel?: string;
}

/**
 * What Guardian sees of one proposed question: every string the caller will see, screened like
 * the rest (prompt, option labels including account-specific ones and their masked labels, and a
 * confirm dialog's follow-up), and a multiple choice's selection bounds. Never an answer, a
 * credential value, a provider field id, or a host-held login's username or site.
 */
interface ReviewedQuestion {
  readonly id: string;
  readonly type: Question["type"];
  readonly prompt: string;
  readonly options?: readonly ReviewedOption[];
  /** A multiple choice's fewest picks; 0 lets the user pick none. */
  readonly minSelections?: number;
  /** A multiple choice's most picks. */
  readonly maxSelections?: number;
  readonly followUp?: { readonly prompt: string; readonly defaultText?: string };
  readonly secretKind?: SecretKind;
  readonly fields?: "username_password" | "password";
}

/** One proposed input request, reviewed as a whole. Its questions are shown together. */
export interface PendingQuestion {
  readonly questions: readonly ReviewedQuestion[];
  readonly notice?: string;
  /** Host fact only. No credential values or authentication result are exposed. */
  readonly credentialsAvailable: boolean;
  /**
   * Host fact: not a question but the agent's report that the task is impossible as asked, which
   * the caller reads as the build's outcome (`report_blocked`); its one prompt is the report.
   */
  readonly blockedOutcome?: true;
  /**
   * Host evidence: the build's latest publication refusals, as the host recorded them, so a
   * report or question about one is judged against the refusal itself.
   */
  readonly publicationDecisions?: readonly PublicationDecision[];
  /**
   * Host evidence for a blocked report: the build's Guardian denials and failing live test cases,
   * as the harness recorded them, so the report is judged against them and not against what the
   * review's conversation still holds.
   */
  readonly decisionLedger?: DecisionLedger;
  /**
   * Host fact: the operation's script asks this through `ask` while it runs, not the minting
   * agent through `request_input`.
   */
  readonly scriptAsk?: true;
  /**
   * Host fact: the build's effect, once decided, so the review knows a write build does the task
   * once, for real, before it publishes. Its allowedEffects stays empty on purpose.
   */
  readonly buildEffect?: "read" | "write";
  /**
   * Host fact: the agent's confirm questions that ask the owner to confirm a step an execution
   * review held for that confirmation (`refusalGround` `owner_confirmation`), each with the id of
   * that review. Guardian binds the owner's yes to exactly that step.
   */
  readonly confirms?: readonly ConfirmedStepQuestion[];
}

/** A confirm question that asks the owner to confirm the step execution review `reviewId` held. */
export interface ConfirmedStepQuestion {
  readonly questionId: string;
  readonly reviewId: string;
}

const reviewedOption = <E>(
  option: InputOption,
  screen: (text: string) => Effect.Effect<string, E>,
): Effect.Effect<ReviewedOption, E> =>
  Effect.gen(function* () {
    const label = yield* screen(option.label);
    if (option.accountSpecific !== true) return { label };
    const masked = option.maskedLabel === undefined ? undefined : yield* screen(option.maskedLabel);
    return {
      label,
      accountSpecific: true,
      ...(masked === undefined ? {} : { maskedLabel: masked }),
    };
  });

/**
 * Projects a request for review, screening every caller-visible string through `screen`, so
 * Guardian reviews exactly what the caller will see. Only a host-raised login's username and site
 * stay out; the agent never writes them.
 */
export const questionForReview = <E>(
  request: Pick<InputRequest, "notice" | "questions">,
  facts: {
    readonly credentialsAvailable: boolean;
    readonly blockedOutcome?: true;
    readonly publicationDecisions?: readonly PublicationDecision[];
    readonly decisionLedger?: DecisionLedger;
    readonly scriptAsk?: true;
    readonly buildEffect?: "read" | "write";
    readonly confirms?: readonly ConfirmedStepQuestion[];
  },
  screen: (text: string) => Effect.Effect<string, E>,
): Effect.Effect<PendingQuestion, E> =>
  Effect.gen(function* () {
    const questions = yield* Effect.forEach(request.questions, (question) =>
      Effect.gen(function* () {
        const prompt = yield* screen(question.prompt);
        const base = { id: question.id, type: question.type, prompt };
        switch (question.type) {
          case "choice":
            return {
              ...base,
              options: yield* Effect.forEach(question.options, (option) =>
                reviewedOption(option, screen),
              ),
            };
          case "multi_choice":
            // The bounds are validated numbers, not caller text: nothing to screen.
            return {
              ...base,
              options: yield* Effect.forEach(question.options, (option) =>
                reviewedOption(option, screen),
              ),
              minSelections: question.minSelections,
              maxSelections: question.maxSelections,
            };
          case "confirm": {
            const followUp = question.followUp;
            if (followUp === undefined) return base;
            const followUpPrompt = yield* screen(followUp.prompt);
            const defaultText =
              followUp.defaultText === undefined ? undefined : yield* screen(followUp.defaultText);
            return {
              ...base,
              followUp: {
                prompt: followUpPrompt,
                ...(defaultText === undefined ? {} : { defaultText }),
              },
            };
          }
          case "secret":
            return { ...base, secretKind: question.secretKind };
          case "credential":
            return { ...base, fields: question.fields };
          case "text":
            return base;
        }
      }),
    );
    const notice = request.notice === undefined ? undefined : yield* screen(request.notice);
    return {
      questions,
      ...(notice === undefined ? {} : { notice }),
      credentialsAvailable: facts.credentialsAvailable,
      ...(facts.blockedOutcome === true ? { blockedOutcome: true as const } : {}),
      // Written by the harness, which screened each instruction: nothing to screen.
      ...(facts.publicationDecisions === undefined || facts.publicationDecisions.length === 0
        ? {}
        : { publicationDecisions: facts.publicationDecisions }),
      // Written by the harness from text it already screened for the minter.
      ...(facts.decisionLedger === undefined ? {} : { decisionLedger: facts.decisionLedger }),
      ...(facts.scriptAsk === true ? { scriptAsk: true as const } : {}),
      ...(facts.buildEffect === undefined ? {} : { buildEffect: facts.buildEffect }),
      // Question ids and review ids are the host's keys, never caller text: nothing to screen.
      ...(facts.confirms === undefined || facts.confirms.length === 0
        ? {}
        : {
            confirms: facts.confirms.map(({ questionId, reviewId }) => ({ questionId, reviewId })),
          }),
    };
  });

/**
 * One question the owner answered through the host's question flow, as every later Guardian
 * review sees it: the question's id, the screened prompt and the screened answer. A choice is its
 * option's label (an account-specific option's masked label, as the API shows it) or the owner's
 * own text, a multiple choice its labels with `other`, an option of the owner's own, and either
 * may carry `note`, the owner's clarification of their pick. A confirm is whether the owner confirmed, with any text.
 * Every answer is the owner's words: an option the minting model wrote, once the owner picks it or
 * types it back, is their confirmation of what it says (`ownerNamedOrigins`).
 */
export const AnsweredQuestion = Schema.Struct({
  /** The question's id, which binds an answer to what it decides, such as `input_use_<input>`. */
  id: Schema.optionalWith(Schema.String, { exact: true }),
  question: Schema.String,
  answer: Schema.Union(
    Schema.String,
    Schema.Array(Schema.String),
    Schema.Struct({
      confirmed: Schema.Boolean,
      text: Schema.optionalWith(Schema.String, { exact: true }),
    }),
  ),
  other: Schema.optionalWith(Schema.String, { exact: true }),
  note: Schema.optionalWith(Schema.String, { exact: true }),
});
export type AnsweredQuestion = typeof AnsweredQuestion.Type;

/**
 * The answers to one request as Guardian sees them, each under its question's id, screening every
 * string through `screen`; an id is the request's own key, never caller text. Protected answers
 * (`isProtectedQuestion`: secrets and logins) never appear, not even their prompts. Every other
 * answer does, a confirm beside a notice included.
 */
export const answersForReview = <E>(
  request: Pick<InputRequest, "notice" | "questions">,
  answers: ValidAnswers,
  screen: (text: string) => Effect.Effect<string, E>,
): Effect.Effect<readonly AnsweredQuestion[], E> =>
  Effect.forEach(
    request.questions.filter((question) => !isProtectedQuestion(question)),
    (question) =>
      Effect.gen(function* () {
        const given = answers[question.id];
        if (given === undefined) return [];
        const label = (id: string) => {
          const option =
            question.type === "choice" || question.type === "multi_choice"
              ? question.options.find((offered) => offered.id === id)
              : undefined;
          return screen(option === undefined ? id : publicOptionLabel(option));
        };
        // The owner's own option beside a multiple choice's picks, and their note beside a pick.
        const beside =
          given.type === "multi_choice" && "options" in given.value
            ? given.value
            : given.type === "choice" && typeof given.value !== "string" && "note" in given.value
              ? { note: given.value.note }
              : {};
        const other = "other" in beside ? beside.other : undefined;
        const note = "note" in beside ? beside.note : undefined;
        const answer: AnsweredQuestion["answer"] | undefined =
          given.type === "text"
            ? yield* screen(given.value)
            : given.type === "choice"
              ? yield* typeof given.value === "string"
                  ? label(given.value)
                  : "other" in given.value
                    ? screen(given.value.other)
                    : label(given.value.option)
              : given.type === "multi_choice"
                ? yield* Effect.forEach(
                    "options" in given.value ? given.value.options : given.value,
                    label,
                  )
                : given.type === "confirm"
                  ? {
                      confirmed: given.value.confirmed,
                      ...(given.value.text === undefined
                        ? {}
                        : { text: yield* screen(given.value.text) }),
                    }
                  : undefined;
        return answer === undefined
          ? []
          : [
              {
                id: question.id,
                question: yield* screen(question.prompt),
                answer,
                ...(other === undefined ? {} : { other: yield* screen(other) }),
                ...(note === undefined ? {} : { note: yield* screen(note) }),
              },
            ];
      }),
  ).pipe(Effect.map((entries) => entries.flat()));
