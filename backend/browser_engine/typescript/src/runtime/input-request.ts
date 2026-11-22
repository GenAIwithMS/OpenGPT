import { Data, Either, Schema, type Effect } from "effect";

/**
 * One way for a running mint, maintenance or run to ask its caller. A
 * request's questions are shown and answered together. A notice (something the person must do
 * outside the form) is a request whose one question is the `confirm` "Did you do it?". Every
 * surface (Dashboard, MCP, REST) answers through `validateAnswer`.
 */

/** A question's key in the request and in the answer. */
export const questionIdPattern = /^[a-z][a-z0-9_]{0,63}$/;
export const QuestionId = Schema.String.pipe(Schema.pattern(questionIdPattern));
/** The host's opaque name for an offered option; a script's or provider's own value stays private. */
const OptionId = Schema.String.pipe(Schema.pattern(/^[a-z0-9_]{1,64}$/));

const Label = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256));
const Prompt = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2000));
const maximumOptions = 50;
const maximumQuestions = 8;
/** The longest free-text or secret answer any question accepts. */
export const maximumAnswerLength = 16_384;
const Length = Schema.Int.pipe(Schema.between(1, maximumAnswerLength));

export const InputOption = Schema.Struct({
  id: OptionId,
  label: Label,
  /**
   * A detail of the caller's own account, such as a saved card or a passenger. Its full label
   * appears only on the protected page; the API and MCP show `maskedLabel`.
   */
  accountSpecific: Schema.optional(Schema.Boolean),
  maskedLabel: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64))),
});
export type InputOption = typeof InputOption.Type;

/** An option's label off the owner's protected page: an account-specific one shows masked. */
export const publicOptionLabel = (option: InputOption) =>
  option.accountSpecific === true ? (option.maskedLabel ?? "••••") : option.label;

/** How the MCP form lists an offered option in a free-text field's description. */
export const listedOption = (option: InputOption, label: string) => `${option.id} (${label})`;

/** Folds case, accents and spacing, as `chooseOption` does, without its punctuation step. */
const foldedAnswer = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * The offered options a choice's own text repeats: text the owner was shown for it, its label,
 * masked label or listed MCP form entry ("id (label)"), ignoring accents, spacing and letter
 * case. A free-text field lists the options, so an owner may type or paste one back instead of
 * picking it. A bare id never counts: the Dashboard hides ids, so text equal to one (an owner's
 * carrier "O2" against a hidden `o2`) is the owner's own answer.
 */
export const optionsRepeatedBy = (options: readonly InputOption[], text: string) => {
  const said = foldedAnswer(text);
  return options.filter((option) =>
    [option.label, option.maskedLabel].some(
      (shown) =>
        shown !== undefined &&
        [shown, listedOption(option, shown)].some((offered) => foldedAnswer(offered) === said),
    ),
  );
};

const Options = Schema.Array(InputOption).pipe(
  Schema.minItems(1),
  Schema.maxItems(maximumOptions),
  Schema.filter((options) => new Set(options.map((option) => option.id)).size === options.length, {
    message: () => "option ids must be unique",
  }),
);

const base = { id: QuestionId, prompt: Prompt };
const choiceFields = { ...base, type: Schema.Literal("choice"), options: Options };
const multiChoiceFields = {
  ...base,
  type: Schema.Literal("multi_choice"),
  options: Options,
  minSelections: Schema.Int.pipe(Schema.between(0, maximumOptions)),
  maxSelections: Schema.Int.pipe(Schema.between(1, maximumOptions)),
};
const selectionsFitOptions = (question: {
  readonly minSelections: number;
  readonly maxSelections: number;
  readonly options: readonly InputOption[];
}) =>
  question.minSelections <= question.maxSelections &&
  question.maxSelections <= question.options.length;
const selectionsMessage = { message: () => "selection bounds must fit the options" };
/**
 * What the caller may write in their own words on a choice or a multiple choice. Every question
 * the minting agent asks allows both (`withOwnWords`); a script's choice allows its own text only
 * when it declares it, and a host question allows neither.
 */
const ownWords = {
  /**
   * The caller may answer with their own text: a choice's `{ other }` instead of an offered
   * option, a multiple choice's `other` as an option of their own beside or instead of the picks.
   * A multiple choice's `other` counts toward `minSelections`, never `maxSelections`, and stays
   * the caller's text even when it repeats an option.
   */
  allowOther: Schema.optional(Schema.Boolean),
  /** The caller may add `note`, their own clarification, beside the options they pick. */
  allowNote: Schema.optional(Schema.Boolean),
};
export const ChoiceQuestion = Schema.Struct({ ...choiceFields, ...ownWords });
export const MultiChoiceQuestion = Schema.Struct({ ...multiChoiceFields, ...ownWords }).pipe(
  Schema.filter(selectionsFitOptions, selectionsMessage),
);
/**
 * A choice as the minting agent proposes it: whether the caller may answer in their own words is
 * the host's to say, never the agent's.
 */
export const ProposedChoiceQuestion = Schema.Struct(choiceFields);
/** A multiple choice as the minting agent proposes it (see `ProposedChoiceQuestion`). */
export const ProposedMultiChoiceQuestion = Schema.Struct(multiChoiceFields).pipe(
  Schema.filter(selectionsFitOptions, selectionsMessage),
);
export const TextQuestion = Schema.Struct({
  ...base,
  type: Schema.Literal("text"),
  maxLength: Schema.optional(Length),
});
export const ConfirmQuestion = Schema.Struct({
  ...base,
  type: Schema.Literal("confirm"),
  /** A native prompt dialog's text, sent only when the caller confirms. */
  followUp: Schema.optional(
    Schema.Struct({
      prompt: Prompt,
      defaultText: Schema.optional(Schema.String.pipe(Schema.maxLength(maximumAnswerLength))),
    }),
  ),
});
/**
 * A one-time code, a TOTP code, other private text or a part of a payment card; masked everywhere
 * downstream. A card part's handle goes only into a host card-fill step, never into source.
 */
export const SecretQuestion = Schema.Struct({
  ...base,
  type: Schema.Literal("secret"),
  secretKind: Schema.Literal(
    "one_time_code",
    "totp",
    "private_text",
    "card_number",
    "card_expiry",
    "card_cvc",
    "billing_postal_code",
  ),
  maxLength: Schema.optional(Length),
});
export type SecretKind = typeof SecretQuestion.Type.secretKind;
/** A website login. Only the host raises it, and its answer goes only to the credential store. */
// These bounds also apply to caller-supplied credentials without a saved-login service.
const maximumCredentialUsernameLength = 1024;
const maximumCredentialPasswordLength = 16384;

export const CurrentLoginStep = Schema.Struct({
  identifierKinds: Schema.Array(
    Schema.Literal("username", "email", "phone", "account_number"),
  ).pipe(Schema.maxItems(4)),
  password: Schema.Boolean,
});
export type CurrentLoginStep = typeof CurrentLoginStep.Type;

export const CredentialQuestion = Schema.Struct({
  ...base,
  type: Schema.Literal("credential"),
  fields: Schema.Literal("username_password", "password"),
  reason: Schema.Literal("missing_credentials", "invalid_credentials", "credentials_expired"),
  /** The expected username, shown masked outside the owner's protected page. */
  username: Schema.optional(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(maximumCredentialUsernameLength)),
  ),
  currentStep: Schema.optional(CurrentLoginStep),
  allowSave: Schema.Boolean,
  siteOrigin: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2048)),
  /**
   * The gateway's offer on an eligible login (`passwordlessEligible`): the site may send a sign-in
   * code instead, so the answer may leave out the password. Saving requires `allowCodeSave`.
   */
  allowPasswordless: Schema.optional(Schema.Boolean),
  /** A verified mint may save a username-only login with explicit owner consent. */
  allowCodeSave: Schema.optional(Schema.Boolean),
  /**
   * The owner may answer without a login (`CredentialAnswer.declined`): they have no account on
   * the site, or want only what it shows signed out. Absent, a login is the only answer.
   */
  allowDecline: Schema.optional(Schema.Boolean),
});

/**
 * Whether a login may begin with only its username: a new unsaved login, never a saved login's
 * repair, which keeps its username and replaces only the password. The gateway also refuses such
 * an answer unless it accepts username-only logins (`allowPasswordless`).
 */
export const passwordlessEligible = (question: typeof CredentialQuestion.Type) =>
  question.currentStep === undefined &&
  question.fields === "username_password" &&
  question.allowSave;

export const Question = Schema.Union(
  ChoiceQuestion,
  MultiChoiceQuestion,
  TextQuestion,
  ConfirmQuestion,
  SecretQuestion,
  CredentialQuestion,
);
export type Question = typeof Question.Type;

/** Who raised the request; it decides deterministically where the answer goes. */
export const InputSource = Schema.Literal("kernel_auth", "agent", "script", "system");
export type InputSource = typeof InputSource.Type;

export const InputRequest = Schema.Struct({
  id: Schema.UUID,
  source: InputSource,
  /** Host-private binding of an existing login-field save offer to its actual questions. */
  savedLoginFieldSave: Schema.optional(
    Schema.Struct({
      valueQuestionIds: Schema.Array(QuestionId).pipe(
        Schema.minItems(1),
        Schema.maxItems(maximumQuestions),
      ),
      consentQuestionId: QuestionId,
    }),
  ),
  notice: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(16_384))),
  questions: Schema.Array(Question).pipe(
    Schema.minItems(1),
    Schema.maxItems(maximumQuestions),
    Schema.filter(
      (questions) => new Set(questions.map((question) => question.id)).size === questions.length,
      { message: () => "question ids must be unique" },
    ),
  ),
}).pipe(
  Schema.filter(
    (request) =>
      request.source === "system" ||
      !request.questions.some((question) => question.type === "credential"),
    { message: () => "only the host asks for a login" },
  ),
  Schema.filter(
    (request) => {
      const save = request.savedLoginFieldSave;
      if (save === undefined) return true;
      if (request.source !== "system" && request.source !== "kernel_auth") return false;
      const consent = request.questions.find((question) => question.id === save.consentQuestionId);
      return (
        consent?.type === "confirm" &&
        consent.followUp === undefined &&
        new Set(save.valueQuestionIds).size === save.valueQuestionIds.length &&
        save.valueQuestionIds.every((id) =>
          request.questions.some(
            (question) =>
              question.id === id && ["text", "secret", "choice"].includes(question.type),
          ),
        )
      );
    },
    { message: () => "a field-save offer must name the host's value questions and consent" },
  ),
);
export type InputRequest = typeof InputRequest.Type;

/** The question every notice asks once the person has acted outside the form. */
const noticeQuestionId = "done";
/** A notice: `message` says what to do outside the form; the person then confirms yes or no. */
export const noticeRequest = (id: string, source: InputSource, message: string): InputRequest => ({
  id,
  source,
  notice: message,
  questions: [{ id: noticeQuestionId, type: "confirm", prompt: "Did you do it?" }],
});

const Text = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(maximumAnswerLength));
const ChoiceAnswer = Schema.Union(
  OptionId,
  Schema.Struct({ other: Text }),
  Schema.Struct({ option: OptionId, note: Schema.optional(Text) }),
);
const MultiChoiceAnswer = Schema.Union(
  Schema.Array(OptionId),
  Schema.Struct({
    options: Schema.Array(OptionId),
    other: Schema.optional(Text),
    note: Schema.optional(Text),
  }),
);
const ConfirmAnswer = Schema.Struct({
  confirmed: Schema.Boolean,
  text: Schema.optional(Schema.String.pipe(Schema.maxLength(maximumAnswerLength))),
});
/**
 * The owner's answer to a login request when they will not give one: they have no account on the
 * site (`no_account`), or want only what the site shows signed out (`public_only`).
 */
export const LoginDecline = Schema.Literal("no_account", "public_only");
export type LoginDecline = typeof LoginDecline.Type;

export const CredentialAnswer = Schema.Struct({
  identifierKind: Schema.optional(Schema.Literal("username", "email", "phone", "account_number")),
  username: Schema.optional(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(maximumCredentialUsernameLength)),
  ),
  password: Schema.optional(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(maximumCredentialPasswordLength)),
  ),
  saveLogin: Schema.Boolean,
  /**
   * The owner declined to give a login, where the question offers it (`allowDecline`): the
   * answer then holds no identifier or password and saves nothing.
   */
  declined: Schema.optional(LoginDecline),
});
export type CredentialAnswer = typeof CredentialAnswer.Type;

/** The caller's answer to every question of one request, keyed by question id. */
export const InputAnswers = Schema.Record({ key: QuestionId, value: Schema.Unknown });
export type InputAnswers = Readonly<Record<string, unknown>>;

/**
 * A choice's validated answer: an offered option's id, the caller's own text instead of one, or
 * an option with the caller's note.
 */
export type ChoiceValue =
  string | { readonly other: string } | { readonly option: string; readonly note: string };
/**
 * A multiple choice's validated answer: the picked options' ids, or with the caller's own option
 * (`other`) or note beside them.
 */
export type MultiChoiceValue =
  | readonly string[]
  | {
      readonly options: readonly string[];
      readonly other?: string;
      readonly note?: string;
    };

/** The offered option a choice's answer picks, if it picks one rather than giving own text. */
export const pickedOption = (value: ChoiceValue): string | undefined =>
  typeof value === "string" ? value : "option" in value ? value.option : undefined;

/** A validated answer, typed by its question. */
export type ValidAnswer =
  | { readonly type: "choice"; readonly value: ChoiceValue }
  | { readonly type: "multi_choice"; readonly value: MultiChoiceValue }
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "confirm"; readonly value: typeof ConfirmAnswer.Type }
  | { readonly type: "secret"; readonly value: string }
  | { readonly type: "credential"; readonly value: CredentialAnswer };
export type ValidAnswers = Readonly<Record<string, ValidAnswer>>;

export class InvalidAnswer extends Data.TaggedError("InvalidAnswer")<{
  readonly questionId?: string;
  readonly reason:
    | "missing_answer"
    | "unexpected_answer"
    | "malformed"
    | "unoffered_option"
    | "other_not_allowed"
    | "note_not_allowed"
    | "selection_bounds"
    | "too_long"
    | "username_not_allowed"
    | "password_required";
}> {}

const decodeAs = <A, I>(schema: Schema.Schema<A, I>, value: unknown) =>
  Schema.decodeUnknownEither(schema, { onExcessProperty: "error" })(value);

const validateOne = (
  question: Question,
  value: unknown,
): Either.Either<ValidAnswer, InvalidAnswer> => {
  const invalid = (reason: InvalidAnswer["reason"]) =>
    Either.left(new InvalidAnswer({ questionId: question.id, reason }));
  const offered = (id: string) =>
    question.type === "choice" || question.type === "multi_choice"
      ? question.options.some((option) => option.id === id)
      : false;
  switch (question.type) {
    case "choice": {
      const decoded = decodeAs(ChoiceAnswer, value);
      if (Either.isLeft(decoded)) return invalid("malformed");
      const answer = decoded.right;
      if (typeof answer === "string" || "option" in answer) {
        const option = typeof answer === "string" ? answer : answer.option;
        const note = typeof answer === "string" ? undefined : answer.note;
        if (!offered(option)) return invalid("unoffered_option");
        if (note !== undefined && question.allowNote !== true) return invalid("note_not_allowed");
        return Either.right({
          type: "choice",
          value: note === undefined ? option : { option, note },
        });
      }
      if (question.allowOther !== true) return invalid("other_not_allowed");
      // Own text that repeats exactly one offered option picks it.
      const [repeated, ...more] = optionsRepeatedBy(question.options, answer.other);
      return Either.right({
        type: "choice",
        value: repeated !== undefined && more.length === 0 ? repeated.id : { other: answer.other },
      });
    }
    case "multi_choice": {
      const decoded = decodeAs(MultiChoiceAnswer, value);
      if (Either.isLeft(decoded)) return invalid("malformed");
      const {
        options: selected,
        other,
        note,
      } = "options" in decoded.right ? decoded.right : { options: decoded.right };
      if (new Set(selected).size !== selected.length) return invalid("malformed");
      if (!selected.every(offered)) return invalid("unoffered_option");
      if (other !== undefined && question.allowOther !== true) return invalid("other_not_allowed");
      if (note !== undefined && question.allowNote !== true) return invalid("note_not_allowed");
      // An option of the caller's own counts toward the least they must choose.
      const chosen = selected.length + (other === undefined ? 0 : 1);
      if (chosen < question.minSelections || selected.length > question.maxSelections)
        return invalid("selection_bounds");
      return Either.right({
        type: "multi_choice",
        value:
          other === undefined && note === undefined
            ? selected
            : {
                options: selected,
                ...(other === undefined ? {} : { other }),
                ...(note === undefined ? {} : { note }),
              },
      });
    }
    case "text":
    case "secret": {
      const decoded = decodeAs(Text, value);
      if (Either.isLeft(decoded)) return invalid("malformed");
      if (decoded.right.length > (question.maxLength ?? maximumAnswerLength))
        return invalid("too_long");
      return Either.right({ type: question.type, value: decoded.right });
    }
    case "confirm": {
      const decoded = decodeAs(ConfirmAnswer, value);
      if (Either.isLeft(decoded)) return invalid("malformed");
      if (decoded.right.text !== undefined && (!question.followUp || !decoded.right.confirmed))
        return invalid("unexpected_answer");
      return Either.right({ type: "confirm", value: decoded.right });
    }
    case "credential": {
      const decoded = decodeAs(CredentialAnswer, value);
      if (Either.isLeft(decoded)) return invalid("malformed");
      // A decline is the whole answer: no login, nothing saved, and only where it is offered.
      if (decoded.right.declined !== undefined) {
        if (question.allowDecline !== true) return invalid("unexpected_answer");
        const { username, password, identifierKind, saveLogin } = decoded.right;
        if (username !== undefined || password !== undefined || identifierKind !== undefined)
          return invalid("unexpected_answer");
        if (saveLogin) return invalid("unexpected_answer");
        return Either.right({ type: "credential", value: decoded.right });
      }
      if (question.fields === "password" && decoded.right.username !== undefined)
        return invalid("username_not_allowed");
      if (question.fields === "username_password" && decoded.right.username === undefined)
        return invalid("malformed");
      if (decoded.right.saveLogin && !question.allowSave) return invalid("unexpected_answer");
      if (question.currentStep !== undefined) {
        const { identifierKinds, password } = question.currentStep;
        const kind =
          decoded.right.identifierKind ??
          (identifierKinds.length === 1 ? identifierKinds[0] : undefined);
        if (identifierKinds.length > 0 && (kind === undefined || !identifierKinds.includes(kind)))
          return invalid("unoffered_option");
        if (identifierKinds.length === 0 && decoded.right.identifierKind !== undefined)
          return invalid("unexpected_answer");
        if (password && decoded.right.password === undefined) return invalid("password_required");
        if (!password && decoded.right.password !== undefined) return invalid("unexpected_answer");
        return Either.right({ type: "credential", value: decoded.right });
      }
      if (decoded.right.identifierKind !== undefined) return invalid("unexpected_answer");
      if (
        decoded.right.password === undefined &&
        (!passwordlessEligible(question) ||
          (decoded.right.saveLogin && question.allowCodeSave !== true))
      )
        return invalid("password_required");
      return Either.right({ type: "credential", value: decoded.right });
    }
  }
};

/** The one validator of an answer against its request: every question, nothing else. */
export const validateAnswer = (
  request: InputRequest,
  answers: unknown,
): Either.Either<ValidAnswers, InvalidAnswer> => {
  const decoded = decodeAs(InputAnswers, answers);
  if (Either.isLeft(decoded)) return Either.left(new InvalidAnswer({ reason: "malformed" }));
  const given = decoded.right;
  const unexpected = Object.keys(given).find(
    (id) => !request.questions.some((question) => question.id === id),
  );
  if (unexpected !== undefined)
    return Either.left(new InvalidAnswer({ questionId: unexpected, reason: "unexpected_answer" }));
  const valid: Record<string, ValidAnswer> = {};
  for (const question of request.questions) {
    if (!Object.hasOwn(given, question.id))
      return Either.left(new InvalidAnswer({ questionId: question.id, reason: "missing_answer" }));
    const checked = validateOne(question, given[question.id]);
    if (Either.isLeft(checked)) return Either.left(checked.left);
    valid[question.id] = checked.right;
  }
  return Either.right(valid);
};

/**
 * Whether a question's answer is protected: a secret or a website login, which goes only to the
 * broker or the credential store. Every other answer is a plain business answer.
 */
export const isProtectedQuestion = (question: Question) =>
  question.type === "secret" || question.type === "credential";

/**
 * The longest any request waits: Kernel waits about ten minutes for one
 * step's input, and nothing parks, so every source shares this one bound.
 */
export const maximumInputWaitMs = 10 * 60_000;

/**
 * `NoResponse`: the window ended unanswered, and the job fails as `no_response`. The others
 * mean the request could not be asked or its answer could not be used.
 */
/**
 * `Refused`: Guardian did not allow the request, so nobody was asked. `Invalid`: the host could not
 * accept the request as asked. `Unavailable`: the host could not review, deliver or read it.
 */
export class InputRequestFailure extends Data.TaggedError("InputRequestFailure")<{
  readonly code: "NoResponse" | "Unavailable" | "Unauthorized" | "Invalid" | "Refused";
  /** The host step that failed, for the full failure record. */
  readonly operation?: string;
  /** The failure behind it, kept for the full failure record. */
  readonly cause?: unknown;
  /**
   * The host's own sentence when it could not answer a question itself and asked nobody, such as
   * a code text that never came. Only an autofill sign-in waits on one: a mint's screen refuses
   * with it, telling the minter, and a run's replay fails on it.
   */
  readonly hostReason?: string;
}> {}

/** Bounds a source puts on one request. */
export interface AskBounds {
  /** The source's own end, such as a provider step's expiry or a native dialog's. */
  readonly sourceEndsAt?: number;
  /**
   * Completes when the source no longer needs the answer, as when Kernel moves past the step;
   * the request then closes and the asker fails with `InputSuperseded`.
   */
  readonly superseded?: Effect.Effect<void, InputRequestFailure>;
  /**
   * Told once the request is open to its caller, with its deadline: a new one once published, a
   * rejoined one with the expiry it already had. A request its saved answers settle never opens.
   */
  readonly opened?: (request: {
    readonly requestId: string;
    readonly expiresAt: string;
    readonly rejoined: boolean;
  }) => Effect.Effect<void>;
}

export class InputSuperseded extends Data.TaggedError("InputSuperseded")<{}> {}

/** The one way a job asks its caller. It resolves with every question answered, or fails. */
export type InputAsker = ((
  request: InputRequest,
  bounds?: AskBounds,
) => Effect.Effect<ValidAnswers, InputRequestFailure | InputSuperseded>) & {
  /**
   * Reads back the secrets the caller already gave to these requests of the job, registering
   * them with the job's broker, for a worker that took over a step they answered. Returns the
   * secret values.
   */
  readonly recoverSecrets?: (
    requestIds: readonly string[],
  ) => Effect.Effect<readonly string[], InputRequestFailure>;
};
