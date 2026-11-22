import { Effect } from "effect";
import { fillAutofillStep } from "./autofill-fill.js";
import { unsupportedSelector } from "./autofill-locate-code.js";
import {
  type AutofillInspection,
  type AutofillPage,
  type AutofillRefusal,
  type AutofillStep,
  type AutofillStepReport,
  inspectAutofillStep,
} from "./autofill-step.js";
import type { CredentialKeyboard, CredentialTypingMode } from "./credential-keyboard.js";
import {
  type CardSlot,
  isCardSlot,
  paymentFrameOrigins as listedOrigins,
} from "./payment-frames.js";
import type { InputRequest, ValidAnswers } from "../runtime/input-request.js";
import type { ScriptCardFillAnswer } from "../runtime/script-card-fill.js";

/**
 * A host card-fill step: the caller's card answers typed into a checkout's card fields the way a
 * sign-in step types a password. The minter names each field's selector and the card handle it
 * takes; the host checks every handle is a card answer's, finds each field in the frame that holds
 * it on the primary tab, refuses unless the page's top document is on the site and each field is
 * on the site or in a frame on an exact payment frame origin, has Guardian review the step and the
 * screen with handles only, then inserts each value natively into the field it bound. No value
 * ever enters page code, Guardian's input, the minter's context or the step's result, and the step
 * clicks nothing: the submit that books or buys is a later step under the write rules.
 */

/** A card-fill step as the minter names it: each field's own selector and its card handle. */
export interface CardFillFields {
  readonly fields: readonly { readonly selector: string; readonly handle: string }[];
}

/** What Guardian reviews of a card-fill step: handles and the screen's labels, never a value. */
export interface CardFillReview {
  readonly step: {
    readonly fields: readonly {
      readonly selector: string;
      readonly slot: CardSlot;
      readonly handle: string;
    }[];
  };
  /** The page the fields are on, origin and path only. */
  readonly page: string;
  readonly screen: AutofillInspection["screen"];
}

/**
 * What the step did, with no value in it. `refused` typed nothing. `filled` typed every field;
 * `failed` typed some and stopped; `uncertain` lost a typing call's answer, so a value may have
 * reached the page. `observations` is the minter's result.
 */
export type CardFillOutcome =
  | {
      readonly status: "refused";
      readonly observations: string;
      readonly report?: AutofillRefusal | undefined;
    }
  | {
      readonly status: "filled" | "failed" | "uncertain";
      readonly observations: string;
      readonly report: AutofillStepReport;
      /** Whether a value reached the page. */
      readonly typed: boolean;
    };

/** The handles' side the step reads: each handle's card part, and the values only to type them. */
export interface CardFillHandles {
  readonly kindOf: (handle: string) => CardSlot | undefined;
  readonly cardValues: (handles: readonly string[]) => readonly string[] | undefined;
}

const refusedWith = (message: string, report?: AutofillRefusal): CardFillOutcome => ({
  status: "refused",
  observations: JSON.stringify({ cardFill: "refused", message }),
  ...(report === undefined ? {} : { report }),
});

const notCardAnswer = (handle: string) =>
  refusedWith(
    `The host typed nothing: ${handle} is not a card answer. Only card number, expiry, security code and billing postal code answers go into a card-fill step.`,
  );

/** The one origin a refusal's evidence names, or undefined when it names none. */
const contextText = (refusal: AutofillRefusal, key: string) => {
  const value = refusal.failureDetail?.context?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
};

/**
 * The minter's result for an inspection the host refused: why, in words, when the field sat or
 * submitted off the site and the payment frame origins, or the page's top document left the site;
 * otherwise the refusal's reason and field alone.
 */
const inspectionRefused = (refusal: AutofillRefusal, origins: readonly string[]) => {
  const check = contextText(refusal, "check");
  if (check === "top_document")
    return refusedWith(
      "The host typed nothing: the page's top document is not on this site. Card answers go only into this site's own page or a payment frame on it, never a provider's page, a popup or a new tab.",
      refusal,
    );
  const field = typeof refusal.target === "number" ? refusal.target + 1 : undefined;
  const allowed = origins.join(", ");
  const inFrame = (origin: string | undefined) =>
    refusedWith(
      `The host typed nothing: field ${field} is in a frame ${origin === undefined || origin === "other" ? "off this site" : `on ${origin}`}. Card answers go only into this site's own page or a payment frame on ${allowed}.`,
      refusal,
    );
  if (check === "destination" && field !== undefined) {
    const part = contextText(refusal, "part");
    const actions = contextText(refusal, "actionOrigins");
    if (part === "ancestor_frame") return inFrame(contextText(refusal, "ancestorOrigin"));
    if (part === "form_method")
      return refusedWith(
        `The host typed nothing: field ${field}'s form sends by GET, which puts what it holds in the page's address. Card answers go only into a form that posts them or a payment frame on ${allowed}.`,
        refusal,
      );
    if (part === "form_action" && actions !== undefined)
      return refusedWith(
        `The host typed nothing: field ${field}'s form sends to ${actions
          .split(" ")
          .map((action) => (action === "other" ? "an origin off this site" : action))
          .join(", ")}. Card answers go only into this site's own page or a payment frame on ${allowed}.`,
        refusal,
      );
    // Once the host typed into the page, an origin it may not name is "other" (`namedOrigin`);
    // a field whose frame the refusal does not name is in a frame off this site.
    return inFrame(contextText(refusal, part === "frame" ? "frameOrigin" : "documentOrigin"));
  }
  // A field whose frame, a frame above it or its document moved between the host's check and its
  // typing: off this site, unless the refusal names the frame it moved to. Any other change, such
  // as where its form sends, keeps its reason and field.
  if (
    check === "change" &&
    field !== undefined &&
    /\.(?:ownerUrl|ancestors|documentOrigin)\b/u.test(contextText(refusal, "changed") ?? "")
  )
    return inFrame(contextText(refusal, "frameOrigin"));
  return {
    status: "refused" as const,
    observations: JSON.stringify({
      cardFill: "refused",
      reason: refusal.reason,
      ...(field === undefined ? {} : { field }),
    }),
    report: refusal,
  };
};

/** The minter's result for a fill: each field's part and status, never a value or an address. */
const filled = (report: AutofillStepReport, origins: readonly string[]): CardFillOutcome => {
  if (report.outcome === "refused") return inspectionRefused(report, origins);
  const typed = report.typed === true;
  if (report.outcome === "uncertain")
    return {
      status: "uncertain",
      observations: JSON.stringify({ cardFill: "uncertain", reason: report.reason }),
      report,
      typed,
    };
  const status = report.fields.every((field) => field.status === "filled") ? "filled" : "failed";
  return {
    status,
    observations: JSON.stringify({
      cardFill: status,
      fields: report.fields.map((field) => ({ slot: field.slot, status: field.status })),
      ...(report.submit === "page" ? { pageMoved: true } : {}),
    }),
    report,
    typed,
  };
};

/**
 * Runs one card-fill step on the primary tab: refuses before any page call a handle that is not a
 * card answer's and a selector that crosses frames, then inspects, has Guardian review the step
 * (`review`, which fails to stop it), runs `beforeTyping` and types each value. A refusal after
 * inspection typed nothing. `judgedBeforeTyping` is the origins the host's inspections judged
 * before it first typed into this page, when it did, which a refusal may name besides the site's.
 */
export const runCardFill = <E>(input: {
  readonly step: CardFillFields;
  readonly handles: CardFillHandles;
  readonly page: AutofillPage;
  readonly keyboard: CredentialKeyboard;
  readonly typing?: CredentialTypingMode;
  readonly siteOrigin: string;
  readonly paymentFrameOrigins?: readonly string[];
  readonly judgedBeforeTyping?: readonly string[] | undefined;
  readonly review: (source: CardFillReview) => Effect.Effect<void, E>;
  /**
   * Runs once Guardian allowed the step, before the first value is typed, with the step and the
   * fields as the host found them: a host notes them as typed into, or ends a recording.
   */
  readonly beforeTyping: (typing: {
    readonly step: AutofillStep<CardSlot>;
    readonly inspection: AutofillInspection;
  }) => Effect.Effect<void, E>;
}): Effect.Effect<CardFillOutcome, E> =>
  Effect.gen(function* () {
    const origins = input.paymentFrameOrigins ?? listedOrigins;
    const fields: { selector: string; slot: CardSlot; handle: string }[] = [];
    for (const field of input.step.fields) {
      const slot = input.handles.kindOf(field.handle);
      if (slot === undefined) return notCardAnswer(field.handle);
      fields.push({ selector: field.selector, slot, handle: field.handle });
    }
    const step: AutofillStep<CardSlot> = {
      fields: fields.map(({ selector, slot }) => ({ selector, slot })),
    };
    const crossing = unsupportedSelector(step);
    if (typeof crossing === "number")
      return refusedWith(
        `The host typed nothing: field ${crossing + 1}'s selector reaches into another frame. Give each field's own selector; the host finds the frame that holds it.`,
      );
    const values = input.handles.cardValues(fields.map((field) => field.handle));
    if (values === undefined) return notCardAnswer(fields[0]?.handle ?? "");
    const inspected = yield* inspectAutofillStep({
      step,
      page: input.page,
      siteOrigin: input.siteOrigin,
      authenticationOrigins: [],
      paymentFrameOrigins: origins,
      judgedBeforeTyping: input.judgedBeforeTyping,
    });
    if ("outcome" in inspected) return inspectionRefused(inspected, origins);
    yield* input.review({ step: { fields }, page: inspected.page, screen: inspected.screen });
    yield* input.beforeTyping({ step, inspection: inspected });
    const report = yield* fillAutofillStep({
      step,
      values,
      inspection: inspected,
      page: input.page,
      keyboard: input.keyboard,
      ...(input.typing === undefined ? {} : { typing: input.typing }),
      // The step clicks nothing, so the host waits for no page to send what it typed.
      settleMs: 0,
    });
    return filled(report, origins);
  });

/**
 * A run's card answers, which the host holds for that run alone: `ask` hands the script a handle in
 * place of each card answer, and the script's `fillCard` names the handles. Nothing keeps them
 * past the run.
 */
export const makeRunCardHandles = () => {
  const answers = new Map<string, { readonly value: string; readonly kind: CardSlot }>();
  return {
    /** A new handle for one card answer. */
    issue: (value: string, kind: CardSlot) => {
      const handle = `{{card.c${answers.size + 1}}}`;
      answers.set(handle, { value, kind });
      return handle;
    },
    kindOf: (handle: string) => answers.get(handle)?.kind,
    cardValues: (handles: readonly string[]) => {
      const values = handles.flatMap((handle) => {
        const answer = answers.get(handle);
        return answer === undefined ? [] : [answer.value];
      });
      return values.length === handles.length ? values : undefined;
    },
  } satisfies CardFillHandles & { readonly issue: (value: string, kind: CardSlot) => string };
};
export type RunCardHandles = ReturnType<typeof makeRunCardHandles>;

/**
 * A script's answers as the script receives them: each card answer replaced by a handle the run's
 * `fillCard` names, so a card never enters the script.
 */
export const scriptAnswers = (
  asked: InputRequest,
  answers: ValidAnswers,
  handles: RunCardHandles,
): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    Object.entries(answers).map(([id, answer]) => {
      const question = asked.questions.find((candidate) => candidate.id === id);
      return [
        id,
        question?.type === "secret" &&
        isCardSlot(question.secretKind) &&
        typeof answer.value === "string"
          ? handles.issue(answer.value, question.secretKind)
          : answer.value,
      ];
    }),
  );

/** A result's own words: a refusal's message, else the result as the minter reads it. */
const messageOf = (observations: string) => {
  try {
    const parsed: unknown = JSON.parse(observations);
    const message =
      typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "message") : undefined;
    return typeof message === "string" ? message : observations;
    // error-reporting-allow: parse-predicate a result that is not JSON is its own message
  } catch {
    return observations;
  }
};

/** What a script's `fillCard` gets back for a card fill: no value, no address. */
export const scriptCardFillAnswer = (outcome: CardFillOutcome): ScriptCardFillAnswer => {
  if (outcome.status === "filled" && "fields" in outcome.report)
    return {
      outcome: "filled",
      fields: outcome.report.fields.map(({ slot, status }) => ({ slot, status })),
    };
  return {
    outcome: outcome.status === "filled" ? "failed" : outcome.status,
    typed: outcome.status !== "refused" && outcome.typed,
    message: messageOf(outcome.observations).slice(0, 2_000),
  };
};
