import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { YieldableError } from "effect/Cause";
import type { SignInMethodChoice } from "../destinations/autofill-contracts.js";
import type { FailureContextValue } from "./failure-detail.js";
import type { InputAsker, InputRequest, Question, ValidAnswers } from "./input-request.js";
import {
  kindNames,
  parsedAnswer,
  type AnsweredLoginField,
  type AnsweredLoginFields,
  type Asked,
} from "./login-values.js";
import type { RegisteredEntity, SecretBroker } from "./autofill-state.js";

// What the host asks the owner during an autofill sign-in and how it reads the answer: the
// question for each kind of value and its parse.

export type { Asked } from "./login-values.js";

/** The entity a value the host asked or computed is registered under, for its placeholder. */
const entities = {
  email: "EMAIL",
  phone: "PHONE",
  account_number: "ACCOUNT_NUMBER",
  date_of_birth: "DATE_OF_BIRTH",
  zip: "ZIP",
  recovery_code: "RECOVERY_CODE",
  code: "ONE_TIME_CODE",
  private_answer: "SECURITY_ANSWER",
} as const satisfies Record<string, RegisteredEntity>;
export type Registered = keyof typeof entities;
/** A value an ask returns for a field the login does not hold; a security answer has its own. */
type AskedSlot = Exclude<Registered, "private_answer">;

/** The longest prompt a question may have, as the input request allows. */
const promptLimit = 2_000;

/** `text` cut to `room` characters with an ellipsis, never leaving half a surrogate pair. */
const cutTo = (text: string, room: number) =>
  text.length <= room ? text : `${text.slice(0, room - 1).replace(/[\uD800-\uDBFF]$/u, "")}…`;

/**
 * The code question's prompt. With the screen's own instruction for the code (`instruction`), such
 * as to call a number or approve in an app, it quotes that, cut to fit, so the owner does what the
 * site asks; without one it names the code the site sent.
 */
const codePrompt = (site: string, notice: string | undefined, instruction: string | undefined) => {
  const lead = notice === undefined ? "" : `${notice} `;
  if (instruction === undefined)
    return notice === undefined
      ? `Enter the sign-in code ${site} sent you.`
      : `${lead}Enter the newest sign-in code ${site} sent you.`;
  const opening = `${lead}${site} shows this on its sign-in screen: “`;
  const closing = `” Follow it, then enter the ${notice === undefined ? "" : "newest "}code here.`;
  return `${opening}${cutTo(instruction, promptLimit - opening.length - closing.length)}${closing}`;
};

/** The question for a value the login does not hold; a code's with its screen's instruction. */
const question = (
  asked: Asked,
  site: string,
  notice?: string,
  instruction?: string,
): Question => {
  const withNotice = (prompt: string) => (notice === undefined ? prompt : `${notice} ${prompt}`);
  // A code asked with a notice is asked again, so it asks for the newest code the site sent.
  // Nothing tells the host the site sent another: after a refusal with no resend, the newest is
  // the refused code, which the host never fills again.
  if (asked === "code")
    return {
      id: "code",
      type: "secret",
      secretKind: "one_time_code",
      prompt: codePrompt(site, notice, instruction),
    };
  if (asked === "recovery_code")
    return {
      id: "recovery_code",
      type: "secret",
      // Not a one-time code: a host that reads texted codes must never answer it with one.
      secretKind: "private_text",
      prompt: withNotice(`Enter one of your ${site} recovery codes.`),
    };
  if (asked === "date_of_birth")
    return {
      id: "date_of_birth",
      type: "secret",
      secretKind: "private_text",
      prompt: withNotice(
        `What's the date of birth on your ${site} account? Enter it as YYYY-MM-DD.`,
      ),
    };
  if (asked === "zip")
    return {
      id: "zip",
      type: "secret",
      secretKind: "private_text",
      prompt: withNotice(`What's the ZIP or postal code on your ${site} account?`),
    };
  return {
    id: asked.join("_or_"),
    type: "text",
    maxLength: 320,
    prompt: withNotice(
      `What's the ${asked.map((kind) => kindNames[kind]).join(" or ")} for your ${site} account?`,
    ),
  };
};

/** Why the host could not get a value: the caller's question went unanswered or failed. */
export class Unanswered {
  constructor(
    readonly cause: unknown,
    /**
     * The field whose in-place corrections ran out, for `field_corrections_exhausted`, or the
     * security answer (`private_answer`) the owner did not give.
     */
    readonly field?: string,
  ) {}
}

/**
 * A host's offer to keep an answer with the login it signs in with: the yes/no it adds to an ask
 * for an identifier, a date of birth or a ZIP (`field`), and to a sign-in method choice
 * (`method`), and what it hears of each answered ask, with or without its offer. A host that keeps
 * no logins offers none.
 */
export interface SaveOffer {
  readonly field: Question;
  readonly method?: Question | undefined;
  readonly answered: (
    answered: { readonly field: AnsweredLoginField } | { readonly method: SignInMethodChoice },
    answers: ValidAnswers,
  ) => void;
}

/** A request's binding of its value question to the save offer it carries, if it carries one. */
export const savedLoginFieldSaveOffer = (
  questions: readonly Question[],
): Pick<InputRequest, "savedLoginFieldSave"> => {
  const saveOffer = questions.find((question) => question.type === "confirm");
  return saveOffer === undefined
    ? {}
    : {
        savedLoginFieldSave: {
          valueQuestionIds: [questions[0]?.id ?? "code"],
          consentQuestionId: saveOffer.id,
        },
      };
};

/** The questions an ask sends: with a host's save offer for a field a saved login may keep. */
const askedQuestions = (
  asked: Asked,
  site: string,
  notice: string | undefined,
  offered: Question | undefined,
  instruction: string | undefined,
): Question[] => [
  question(asked, site, notice, instruction),
  ...(offered !== undefined && asked !== "code" && asked !== "recovery_code" ? [offered] : []),
];

/**
 * The question for a security answer: the question the page shows, cut to fit; else that the
 * recorded question could not be read; else the answer field's label. Only the first may be saved.
 */
const answerQuestion = (site: string, shown: ShownAnswerField | undefined): Question => {
  const label = shown?.label ?? shown?.ariaLabel ?? shown?.placeholder ?? null;
  const prompt = (() => {
    if (shown?.questionText !== undefined && shown.questionUnread !== true) {
      const lead = `${site} asks this security question: `;
      return `${lead}${cutTo(shown.questionText, promptLimit - lead.length)}`;
    }
    if (shown?.questionUnread === true)
      return `Enter your ${site} security answer. The question it answers could not be read from the page.${label === null ? "" : ` The answer field reads "${label.slice(0, 200)}".`}`;
    return label === null
      ? `Enter your ${site} security answer.`
      : `Enter your ${site} answer for "${label.slice(0, 200)}".`;
  })();
  return { id: "private_answer", type: "secret", secretKind: "private_text", prompt };
};

/**
 * What the inspection read of a security answer's field: its question and its own words. A code
 * field's `questionText` is the screen's own instruction for the code.
 */
export interface ShownAnswerField {
  readonly questionText?: string | undefined;
  readonly questionUnread?: true | undefined;
  readonly label: string | null;
  readonly ariaLabel: string | null;
  readonly placeholder: string | null;
}

/** The caller's own failure for a host dependency that did not answer. */
export type AutofillValueFailure<E> = (
  operation: string,
  detail: {
    readonly error?: unknown;
    readonly context?: Readonly<Record<string, FailureContextValue | undefined>>;
  },
) => E;

/** A code without the spaces and hyphens it is often written with (`123 456`). */
export const bareCode = (code: string) => code.replaceAll(/[\s-]/gu, "");

/** Whether a code fills `boxes` code fields one character each, without its spaces and hyphens. */
export const fitsCodeBoxes = (code: string, boxes: number) =>
  Array.from(bareCode(code)).length === boxes;

/** Whether a kept code answer does not fill its screen's code fields one character each. */
const misfitCode = (kept: { readonly value: string } | undefined, codeBoxes?: number) =>
  kept !== undefined && codeBoxes !== undefined && !fitsCodeBoxes(kept.value, codeBoxes);

/**
 * Why a step of several code fields got no code: the code the owner or the host gave does not
 * fill them one character each, so none was typed. It is the owner's to correct, never the
 * tool's.
 */
export const codeDoesNotFit = "code_does_not_fit_boxes";

/**
 * Asks the owner, in place, for a value the login does not hold, as the same `system` source as
 * every login ask, and registers the answer with the broker. An answer the field cannot take is
 * asked again, twice at most: for a code, also one that does not fill its screen's code fields one
 * character each (`codeBoxes`), whose third ends the step unanswered (`codeDoesNotFit`). An
 * identifier, date of birth or ZIP is kept for the attempt (`given`), and a host's save offer
 * (`saveOffer`) hears the answers; a code is not kept.
 */
export const makeLoginFieldAsk = <E extends YieldableError>(dependencies: {
  readonly broker: Pick<SecretBroker, "register">;
  readonly unavailable: AutofillValueFailure<E>;
  readonly site: string;
  readonly given: { current: AnsweredLoginFields };
  readonly saveOffer?: SaveOffer | undefined;
}) => {
  const { given, saveOffer } = dependencies;
  const fail = (operation: string, context: Readonly<Record<string, FailureContextValue>>) =>
    Effect.fail(dependencies.unavailable(operation, { context }));
  const register = (slot: Registered, value: string) =>
    dependencies.broker
      .register({ kind: "secret", entity: entities[slot], value })
      .pipe(Effect.mapError((error) => dependencies.unavailable("broker.register", { error })));
  /** The answer as the record keeps it, typed and kept: masked both ways, and remembered. */
  const keep = (
    kept: { readonly slot: AskedSlot; readonly value: string },
    typed: string,
    answers: ValidAnswers,
  ) =>
    Effect.gen(function* () {
      yield* register(kept.slot, typed);
      if (kept.value !== typed) yield* register(kept.slot, kept.value);
      // One-digit boxes take a code without its spaces and hyphens, as the site then sends it.
      const bare = bareCode(typed);
      if (kept.slot === "code" && bare !== typed && bare !== "") yield* register(kept.slot, bare);
      if (kept.slot === "code" || kept.slot === "recovery_code") return;
      given.current = { ...given.current, [kept.slot]: kept.value };
      saveOffer?.answered({ field: kept.slot }, answers);
    });
  const ask = (
    asker: InputAsker,
    asked: Asked,
    notice?: string,
    offerSave = false,
    attempt = 0,
    /** A code's screen's code fields, when it has several, such as one-character boxes. */
    codeBoxes?: number,
    /** A code screen's own instruction for the code, as the host read it (`codeInstruction`). */
    instruction?: string,
  ): Effect.Effect<Unanswered | { slot: AskedSlot; value: string }, E> =>
    Effect.gen(function* () {
      const questions = askedQuestions(
        asked,
        dependencies.site,
        notice,
        offerSave ? saveOffer?.field : undefined,
        asked === "code" ? instruction : undefined,
      );
      const response = yield* Effect.either(
        asker({
          id: randomUUID(),
          source: "system",
          questions,
          ...savedLoginFieldSaveOffer(questions),
        }),
      );
      if (response._tag === "Left") return new Unanswered(response.left);
      const answer = response.right[questions[0]?.id ?? "code"];
      if (answer?.type !== "text" && answer?.type !== "secret")
        return yield* fail("autofill.ask", { check: "answer_shape" });
      const kept = parsedAnswer(asked, answer.value);
      const misfit = misfitCode(kept, codeBoxes);
      if (kept === undefined || misfit) {
        if (attempt < 2)
          return yield* ask(asker, asked, notice, offerSave, attempt + 1, codeBoxes, instruction);
        return misfit
          ? new Unanswered(codeDoesNotFit)
          : yield* fail("autofill.ask", { check: "answer_kind" });
      }
      yield* keep(kept, answer.value, response.right);
      return kept;
    });
  /**
   * Asks the owner, in place, for the answer to the security question a screen shows, as the same
   * `system` source as every login ask, and registers it with the broker. It is never kept for the
   * attempt (`given`): the caller holds it only for its fill, and with a host's save offer, its
   * owner's yes (`consented`).
   */
  const askAnswer = (
    asker: InputAsker,
    shown: ShownAnswerField | undefined,
    offerSave: boolean,
    attempt = 0,
  ): Effect.Effect<Unanswered | { value: string; consented: boolean }, E> =>
    Effect.gen(function* () {
      const offered = offerSave ? saveOffer?.field : undefined;
      const questions = [
        answerQuestion(dependencies.site, shown),
        ...(offered === undefined ? [] : [offered]),
      ];
      const response = yield* Effect.either(
        asker({
          id: randomUUID(),
          source: "system",
          questions,
          ...savedLoginFieldSaveOffer(questions),
        }),
      );
      // The field names what went unanswered, so the failure says a security answer was missing.
      if (response._tag === "Left") return new Unanswered(response.left, "private_answer");
      const answer = response.right["private_answer"];
      if (answer?.type !== "secret") return yield* fail("autofill.ask", { check: "answer_shape" });
      if (answer.value.trim() === "")
        return attempt < 2
          ? yield* askAnswer(asker, shown, offerSave, attempt + 1)
          : yield* fail("autofill.ask", { check: "answer_kind" });
      yield* register("private_answer", answer.value);
      const save = offered === undefined ? undefined : response.right[offered.id];
      return { value: answer.value, consented: save?.type === "confirm" && save.value.confirmed };
    });
  return { register, ask, askAnswer, fail };
};
