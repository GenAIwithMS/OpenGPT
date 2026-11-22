import { randomUUID } from "node:crypto";
import { Effect, Either, Schema } from "effect";
import { failureDetail } from "../runtime/failure-detail.js";
import { type AutofillFillCall, autofillStepCode } from "./autofill-page-code.js";
import { frameCrossing, unsupportedSelector } from "./autofill-locate-code.js";
import { firedRefusal, guardedSubmit, GuardRefusal } from "./autofill-submission-guard.js";
import {
  configuredOrigins,
  FoundAt,
  foundEvidence,
  foundFor,
  FoundIn,
  judgedOrigins,
  locatedRefusal,
  lostTypingPhase,
  namedAfterTyping,
  refused,
  targetEvidence,
  withCheck,
  withEvidence,
} from "./autofill-refusal.js";
import {
  type AutofillFieldStatus,
  type AutofillInspection,
  type AutofillPage,
  type AutofillRefusal,
  type AutofillStep,
  type FillSlot,
  type AutofillStepReport,
  coveringElement,
  ReadCoveringElement,
  hostSubmits,
  LocatedError,
  notingHostTrust,
  Targets,
  untrustedTarget,
} from "./autofill-step.js";
import {
  type CredentialKeyboard,
  type CredentialTypingMode,
  type InsertionRefusal,
} from "./credential-keyboard.js";
import { PageControls } from "./page-controls.js";
import { PageNavigation, reportedNavigation } from "./sign-in-redirect.js";

/** One fill call's answer: a control that moved, an empty field the host typed, or its own. */
const FillAnswer = Schema.Union(
  LocatedError,
  /**
   * A typed field holds nothing, or, before a submit, a code box (`field`) does not hold exactly
   * one character.
   */
  Schema.Struct({
    checked: Schema.Literal(false),
    field: Schema.optional(Schema.Number),
    url: Schema.String,
  }),
  Schema.Struct({
    focused: Schema.Boolean,
    /** Why the field did not take the focus: the error focusing threw, or the tag that holds it. */
    unfocused: Schema.optional(
      Schema.Union(
        Schema.Struct({ focusError: Schema.String }),
        Schema.Struct({ activeTag: Schema.String }),
      ),
    ),
    located: Schema.optional(FoundIn),
    url: Schema.String,
    /** When the primary page's document began loading, read once the field took the focus. */
    document: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    dated: Schema.Boolean,
    url: Schema.String,
    document: Schema.optional(Schema.Number),
  }),
  /** The submit call found that the page sent what was typed itself (`pageSentCode`). */
  Schema.Struct({ pageSent: Schema.Literal(true), url: Schema.String }),
  Schema.Struct({
    /** `disabled`: the submit was disabled, so the call clicked nothing. */
    submit: Schema.Literal("clicked", "failed", "disabled", "none"),
    /** A `clicked` submit the call pressed from the keyboard. */
    via: Schema.optional(Schema.Literal("keyboard")),
    url: Schema.String,
    navigated: Schema.optional(PageNavigation),
    controls: Schema.optional(PageControls),
  }),
  /** Another element sat over the submit and caught the click, which never reached it. */
  Schema.Struct({
    submit: Schema.Literal("blocked"),
    blockedBy: ReadCoveringElement,
    url: Schema.String,
  }),
  /**
   * A `dismiss` call: what became of the covering notice's control. `emptied`: the call emptied
   * the step's fields before a click whose submission it cancelled.
   */
  Schema.Struct({
    dismiss: Schema.Literal("clicked", "not_shown", "ambiguous", "failed"),
    emptied: Schema.optional(Schema.Literal(true)),
    url: Schema.String,
  }),
  Schema.Struct({
    dismiss: Schema.Literal("refused"),
    part: Schema.Literal("sign_in_control", "sign_in_form", "submits_form", "opens_page"),
    url: Schema.String,
  }),
  GuardRefusal,
);
type FillAnswer = typeof FillAnswer.Type;
/** A call that found a control changed since the host last judged it did nothing: each as found. */
const Changed = Schema.Struct({
  changed: Targets,
  located: Schema.optional(FoundAt),
  url: Schema.String,
});
/**
 * A call the host refused, with the primary page then. `left`: a submit call of a step with a
 * submit found a field gone from the document the host typed in, which a new document may yet
 * replace (`screenGone`).
 */
type Stop = {
  readonly refusal: AutofillRefusal;
  readonly url?: string | undefined;
  readonly left?: true;
};
/** A fill call's answer once the host judged it: a refusal, or the call's own answer. */
type CallAnswer = Exclude<FillAnswer, typeof LocatedError.Type> | Stop;

const properties = [
  "ownerUrl",
  "ancestors",
  "documentOrigin",
  "editable",
  "control",
  "actions",
  "scriptAction",
  "scriptHref",
  "methods",
  "explicitGet",
  "submitMethod",
] as const;
/** Each control of two judgments: the field's index or `submit`, as judged before and now. */
const controls = (before: typeof Targets.Type, after: typeof Targets.Type) => [
  ...after.fields.map((now, index) => ({ at: index, was: before.fields[index], now })),
  { at: "submit" as const, was: before.submit, now: after.submit },
];
/**
 * Which properties of which controls differ between two judgments, by name only. The submit's
 * `editable` only follows whether it is disabled, which no call judges as a change.
 */
const changedProperties = (before: typeof Targets.Type, after: typeof Targets.Type) =>
  controls(before, after)
    .flatMap(({ at, was, now }) =>
      properties
        .filter((key) => !(at === "submit" && key === "editable"))
        .filter((key) => JSON.stringify(was?.[key]) !== JSON.stringify(now?.[key]))
        .map((key) => `${at}.${key}`),
    )
    .join(" ");
/**
 * The first control whose form changed how or where it submits, which is never judged again: a
 * switch to GET would put the values in a URL Guardian never judged, and the request watch counts
 * only the endpoints judged at inspection. Page code reports where a form submits by origin and
 * path alone, so an action's query or hash never counts as a change.
 */
const resubmitted = (
  before: typeof Targets.Type,
  after: typeof Targets.Type,
  named: ReadonlySet<string> | undefined,
) => {
  const moved = controls(before, after).find(
    ({ was, now }) =>
      JSON.stringify(was?.methods) !== JSON.stringify(now?.methods) ||
      (was?.explicitGet ?? false) !== (now?.explicitGet ?? false) ||
      was?.submitMethod !== now?.submitMethod ||
      JSON.stringify(was?.actions) !== JSON.stringify(now?.actions),
  );
  return (
    moved &&
    withCheck(
      refused("credential_target_refused", moved.at),
      "change",
      targetEvidence(moved.now, named),
    )
  );
};

/**
 * The step's code boxes, by field index: its code fields whose values are one character each, when
 * there are two or more, as the host splits one code across one-character boxes. Otherwise none.
 */
const codeBoxes = (step: AutofillStep<FillSlot>, values: readonly string[]) => {
  const boxes = step.fields.flatMap((field, index) =>
    field.slot === "code" && Array.from(values[index] ?? "").length === 1 ? [index] : [],
  );
  return boxes.length > 1 ? boxes : [];
};

/** What the fill has done so far. */
interface FillProgress {
  readonly statuses: AutofillFieldStatus[];
  /** Whether any value may have reached the page. */
  typed: boolean;
  /**
   * The fields the next call checks still hold something: the one the host typed last, or every
   * field it typed before a submit it clicks again.
   */
  check: readonly number[];
  /** The controls as the host last judged them; a call acts only when it finds them so. */
  judged: typeof Targets.Type;
  /** The id the page keeps `judged` under, as the call that found it kept it. */
  judgment: string | undefined;
  /** The id the page keeps where it was as each field was typed under (`pageSentCode`). */
  readonly typedAt: string;
  /**
   * The document the host typed the last field in, by when it began loading, which a submit call
   * that finds the screen gone compares against (`screenGone`).
   */
  typedIn: number | undefined;
  /** The origins `trustSignInUrl` trusted as the host judged again a control the page moved. */
  readonly trusted: Set<string>;
}

/** The report's `trustedSignInOrigins`, when the fill's own judgments trusted any. */
const trustedByHost = (progress: FillProgress) =>
  progress.trusted.size === 0 ? {} : { trustedSignInOrigins: [...progress.trusted].sort() };

const filledReport = (
  step: AutofillStep<FillSlot>,
  progress: FillProgress,
  submit: Extract<AutofillStepReport, { outcome: "filled" }>["submit"],
  url: string,
  refusal?: AutofillRefusal,
  clicked?: true,
): AutofillStepReport => ({
  outcome: "filled",
  fields: step.fields.map((field, index) => ({
    slot: field.slot,
    status: progress.statuses[index] ?? "not_attempted",
  })),
  submit,
  ...(clicked === undefined ? {} : { clicked }),
  url,
  ...(refusal?.failureDetail === undefined ? {} : { failureDetail: refusal.failureDetail }),
  ...(progress.typed ? { typed: true as const } : {}),
  ...trustedByHost(progress),
});

/** The labels a failed call that held a value keeps of its error, by their names in its context. */
const errorLabels = { code: "errorCode", reason: "errorReason", method: "errorMethod" } as const;

/**
 * An error's string labels, such as a DevTools command's finite reason and its method, each kept
 * only when no value of the step appears in it. Never the error's message or parameters.
 */
const valueFreeLabels = (error: Error, values: readonly string[]) => {
  const held = values.filter((value) => value !== "").map((value) => value.toLowerCase());
  const labels: Record<string, string> = {};
  for (const [key, name] of Object.entries(errorLabels)) {
    const label: unknown = Reflect.get(error, key);
    if (typeof label === "string" && !held.some((value) => label.toLowerCase().includes(value)))
      labels[name] = label;
  }
  return labels;
};

/**
 * A failed focus can refuse before typing. A date or submit can already have changed the site
 * even when it was the first call, so a lost reply stays uncertain. A date's call held the date,
 * and a typing call its value (`held`, the step's values), so their failures keep finite facts
 * only. A typing call's failure has the phase `lostTypingPhase`: the host clicks the submit only
 * after every field.
 */
const failedCall = (
  progress: FillProgress,
  error: Error,
  call: {
    readonly held?: readonly string[];
    readonly mayMutate: boolean;
    readonly typing?: true;
  },
): AutofillStepReport => {
  const detail =
    call.held === undefined
      ? failureDetail("autofill_step_failed", { operation: "autofill.fill", error })
      : failureDetail("autofill_step_failed", {
          operation: "autofill.fill",
          ...(call.typing === true ? { phase: lostTypingPhase } : {}),
          context: { errorName: error.name, ...valueFreeLabels(error, call.held) },
        });
  return progress.typed || call.mayMutate
    ? {
        outcome: "uncertain",
        reason: "fill_call_failed",
        failureDetail: detail,
        ...(progress.typed || call.held !== undefined ? { typed: true as const } : {}),
        ...trustedByHost(progress),
      }
    : { ...refused("page_unavailable"), failureDetail: detail };
};

/**
 * A control the host refused, or a field the host typed that holds nothing: a refusal before
 * anything was typed. After, the field about to be typed fails untyped, as a fill into it would, a
 * typed field left empty fails, as does a code box that holds other than one character when the
 * host is about to submit, and only the submit's recheck refuses the submit.
 */
const stopped = (
  step: AutofillStep<FillSlot>,
  progress: FillProgress,
  answer:
    | Stop
    | { readonly checked: false; readonly field?: number | undefined; readonly url: string },
  during: "field" | "submit",
): AutofillStepReport => {
  if ("checked" in answer) {
    const failed = answer.field ?? progress.check.at(-1);
    if (failed !== undefined) progress.statuses[failed] = "failed";
    return filledReport(step, progress, "not_attempted", answer.url);
  }
  if (!progress.typed) return answer.refusal;
  if (during === "submit")
    return filledReport(step, progress, "refused", answer.url ?? "", answer.refusal);
  progress.statuses.push("failed");
  return filledReport(step, progress, "not_attempted", answer.url ?? "", answer.refusal);
};

/**
 * The origins the guard's record may name: those judged at inspection, or, when the host typed into
 * the page before it, only those `namedAfterTyping` allows, since the inspection may itself have
 * found a typed value in any other, such as an action's host.
 */
const guardOrigins = (input: CallInput) =>
  namedAfterTyping(input.inspection) ?? judgedOrigins(input.inspection);

/**
 * The origins a refusal's evidence may name: any until something was typed into the page, then
 * only the guard's (`guardOrigins`), since page code may have put a typed value in another.
 */
const evidenceOrigins = (input: CallInput, progress: FillProgress) =>
  progress.typed || input.inspection.judgedBeforeTyping !== undefined
    ? guardOrigins(input)
    : undefined;

/** What a step's calls act on: its controls as inspected, on the page, without any value. */
interface CallInput {
  readonly step: AutofillStep<FillSlot>;
  readonly inspection: AutofillInspection;
  readonly page: AutofillPage;
  /**
   * How long the page may take to navigate after the submit, then to load; 5 s by default. A step
   * with no submit gives the page as long, at most `pageSendMs`, to send what was typed itself.
   */
  readonly settleMs?: number;
  /**
   * Whether the submit call reads the page's alerts just before its click, so its report counts
   * the ones after it that are new (`newAlerts`). The read waits for every frame, so only a host
   * that reads the count asks; a read that takes longer than `alertsBeforeMs` counts nothing.
   */
  readonly countNewAlerts?: boolean;
}

interface FillInput extends CallInput {
  readonly values: readonly string[];
  /**
   * Every value the host typed earlier in this sign-in on this browser, in any step: a clicked
   * submit reports where the page went (`navigated`) only when it is set and nothing the page
   * chose holds one of these or `values` (`reportedNavigation`). A first screen's is empty.
   */
  readonly typedBefore?: readonly string[];
  readonly keyboard: CredentialKeyboard;
  /** How each value is typed; `paste` by default. */
  readonly typing?: CredentialTypingMode;
}

/**
 * The host's judgment of the controls a call found changed, by inspection's rule, where only a
 * field still to be typed must take typing: a refusal, or undefined to call again. A form that
 * changed how or where it submits, beyond an action's query or hash, and a page that changed them
 * a third time (`changes`, counted across every call the host makes again for it) are refused.
 * Controls judged so are ones the host may act on, so the origins `trustSignInUrl` trusted for
 * them join the fill's (`progress.trusted`).
 */
const rejudge = (
  input: CallInput,
  progress: FillProgress,
  changed: typeof Targets.Type,
  call: AutofillFillCall,
  changes: number,
) => {
  // A dismiss call acts before the step's fields are typed or before its submit is clicked again,
  // so the controls it finds changed are judged as a submit's would be at that point.
  const target = call.kind === "submit" || call.kind === "dismiss" ? "submit" : call.index;
  const from =
    call.kind === "submit"
      ? input.step.fields.length
      : call.kind === "dismiss"
        ? progress.statuses.length
        : call.index;
  const judged = progress.judged;
  const named = evidenceOrigins(input, progress);
  const trusted = new Set<string>();
  const trust = {
    ...input.inspection,
    trustSignInUrl: notingHostTrust(input.inspection.trustSignInUrl, trusted),
  };
  const refusal =
    untrustedTarget(changed, input.step, trust, from, named) ??
    resubmitted(judged, changed, named) ??
    (changes >= 3
      ? withCheck(
          refused("credential_target_refused", target),
          "change",
          targetEvidence(target === "submit" ? changed.submit : changed.fields[target], named),
        )
      : undefined);
  if (refusal === undefined) for (const origin of trusted) progress.trusted.add(origin);
  return refusal;
};

/**
 * A submit call that found the screen gone once every field was typed: `sent` when the page took
 * it away itself. On a step with no submit, a field gone or its popup closed, as a code widget does
 * when it sends what its last box completed. On a step with a submit or a submit key, only a field
 * gone because a new document replaced the one the host typed the last field in (`typedIn`), as a
 * form that submits itself on its last input does: the host's click or key press never ran, so
 * nothing went out twice, and
 * the sign-in's next check decides what the page sent. A field gone from that same document is
 * `left`: a form that takes its fields away or puts a new path in the address with pushState
 * loaded no new document, so it stays a refusal unless one loads within the host's wait.
 */
const screenGone = (
  step: AutofillStep<FillSlot>,
  answer: typeof LocatedError.Type,
  typedIn: number | undefined,
): "sent" | "left" | undefined => {
  if (step.fields.length === 0) return undefined;
  const fieldGone = answer.error === "not_found" && typeof answer.target === "number";
  if (!hostSubmits(step))
    return fieldGone || answer.error === "popup_missing" ? "sent" : undefined;
  if (!fieldGone) return undefined;
  return typedIn !== undefined && answer.document !== undefined && answer.document !== typedIn
    ? "sent"
    : "left";
};

/**
 * One Kernel call of the fill, which first checks the field the host typed last. A call that finds
 * a control changed since the host last judged it does nothing, and the host judges the controls
 * it found again (`rejudge`), then calls again against that judgment, which the page kept as that
 * call found it: no call's code holds an address the page supplied. `changes` counts the changes
 * found, shared by every call the host makes again for the same action.
 */
const fillCall =
  (input: CallInput, progress: FillProgress, changes = { count: 0 }) =>
  (call: AutofillFillCall): Effect.Effect<Either.Either<CallAnswer, Error>> =>
    Effect.gen(function* () {
      for (;;) {
        const observed = randomUUID();
        const answered = yield* input.page
          .execute(
            autofillStepCode(input.page.targetId, input.step, observed, {
              call,
              popupTargetId: input.inspection.popupTargetId,
              judged: progress.judgment,
              check: progress.check,
              typedAt: progress.typedAt,
            }),
            call.kind === "focus" ? 15 : 30,
          )
          .pipe(
            Effect.flatMap(Schema.decodeUnknown(Schema.Union(FillAnswer, Changed))),
            Effect.either,
          );
        if (answered._tag === "Left") return Either.left(answered.left);
        const answer = answered.right;
        if ("error" in answer) {
          const gone =
            call.kind === "submit" ? screenGone(input.step, answer, progress.typedIn) : undefined;
          return Either.right<CallAnswer>(
            gone === "sent"
              ? { pageSent: true, url: answer.url ?? "" }
              : {
                  refusal: locatedRefusal(answer, evidenceOrigins(input, progress)),
                  url: answer.url,
                  ...(gone === "left" ? { left: true as const } : {}),
                },
          );
        }
        if (!("changed" in answer)) return Either.right(answer);
        const changed = changedProperties(progress.judged, answer.changed);
        changes.count++;
        const untrusted = rejudge(input, progress, answer.changed, call, changes.count);
        if (untrusted !== undefined)
          return Either.right<Stop>({
            refusal: withEvidence(untrusted, {
              changed,
              ...foundEvidence(
                answer.url,
                foundFor(answer.located, untrusted.target),
                evidenceOrigins(input, progress),
              ),
            }),
            url: answer.url,
          });
        progress.judged = answer.changed;
        progress.judgment = observed;
      }
    });

/**
 * How long the host waits for the page to enable a disabled submit once the fields are filled: the
 * 5 s each of its control actions (focus, fill, click) may take. Many sign-in forms enable their
 * submit only on input, some after a short check of what was typed.
 */
const submitEnableMs = 5_000;
/**
 * How long the host gives a step with no submit to send what was typed itself once every field is
 * filled, as a code widget may a moment after its last box: the step's settle wait, at most 2 s,
 * since a step that only shows more of the same screen has no submit either.
 */
const pageSendMs = 2_000;
/** How often the host calls the submit again while it waits on the page. */
const submitPollMs = 250;

/** A submit call that clicked nothing because the submit was disabled, or the step names none. */
const unclicked = (answered: Either.Either<CallAnswer, Error>, submit: "disabled" | "none") =>
  Either.isRight(answered) && "submit" in answered.right && answered.right.submit === submit;

/** A submit call that found a field gone from the document the host typed in (`screenGone`). */
const leftOnly = (answered: Either.Either<CallAnswer, Error>) =>
  Either.isRight(answered) && "left" in answered.right && answered.right.left === true;

/** A submit call that found the page sent what was typed itself. */
const pageSent = (answered: Either.Either<CallAnswer, Error>) =>
  Either.isRight(answered) && "pageSent" in answered.right;

/** A call that found a typed field empty, or a code box holding other than one character. */
const unchecked = (answered: Either.Either<CallAnswer, Error>) =>
  Either.isRight(answered) && "checked" in answered.right;

/** A step with a code field that the host submits (see `fillAutofillStep`). */
const codeSentBySite = (step: AutofillStep<FillSlot>) =>
  hostSubmits(step) && step.fields.some((field) => field.slot === "code");

/**
 * After a submit call of a step with a submit found its fields gone from the document the host
 * typed in (`left`, a refusal): looks again for up to `sendMs`, the step's settle wait at most
 * `pageSendMs`, in case a new document replaces it, as a form that hides itself while it sends what
 * was typed, then loads the site's answer, does; so after a code step's answer that may have raced
 * such a load (`codeSentBySite`, `first`). Each look only reads the page and never clicks, so a
 * look that fails, as one does while the page navigates, is a look lost. A look that finds the page
 * sent what was typed reports that (`page`). A look that finds the fields back leaves the first
 * answer standing, and so does the end of the wait. After a submit call's first answer but `left`,
 * a box that still fails its check is the screen that answer found, so the host looks again.
 */
const awaitNewDocument = (
  input: CallInput,
  progress: FillProgress,
  call: AutofillFillCall,
  first: Either.Either<CallAnswer, Error>,
  sendMs: number,
  changes: { count: number },
) =>
  Effect.gen(function* () {
    if (call.kind !== "submit") return first;
    const since = Date.now();
    const look: AutofillFillCall = { ...call, look: true };
    const raced = !leftOnly(first);
    while (Date.now() - since < sendMs) {
      yield* Effect.sleep(submitPollMs);
      const answered = yield* fillCall(input, progress, changes)(look);
      if (pageSent(answered)) return answered;
      if (Either.isRight(answered) && !leftOnly(answered) && !(raced && unchecked(answered)))
        return first;
    }
    return first;
  });

/** How long a step with fields gives its page to send what was typed itself (`pageSendMs`). */
const sendWindow = (input: CallInput) =>
  input.step.fields.length > 0 ? Math.min(input.settleMs ?? 5_000, pageSendMs) : 0;

/**
 * The step's submit call, judged against the controls as the host last judged them and guarded,
 * with `boxes`, the step's code boxes, each of which must hold exactly one character before the
 * click. `pressCovered`, on a click again only, presses the submit from the keyboard when another
 * element catches its click.
 */
const submitCall = (
  input: CallInput,
  progress: FillProgress,
  boxes: readonly number[],
  pressCovered = false,
) =>
  // A re-judge never changes a method, so the submission's method is the one judged now.
  guardedSubmit(input.step, progress.judged, {
    settleMs: input.settleMs ?? 5_000,
    inspection: input.inspection.judgment,
    // Once something was typed before inspection, only a secret inside an origin no page chose
    // Is no leak: the page may have put one in any path or query.
    exempt:
      input.inspection.judgedBeforeTyping === undefined
        ? null
        : configuredOrigins(input.inspection),
    codeBoxes: boxes,
    alertsBefore: input.countNewAlerts === true,
    pressCovered,
  });

/**
 * The step's submit call, made again while the page keeps the submit disabled, for up to
 * `submitEnableMs`, and while a step with fields and no submit has not seen the page send them
 * itself, for up to `pageSendMs` from the first call that found no submit. Each call judges every
 * control again before it clicks, and none clicks a disabled submit. The changes they find count
 * across the whole wait, so a page that keeps changing a control is refused however the changes
 * fall between the calls. On a step with no submit the call only reads the page, so one that fails
 * there, as when the page navigates or draws itself again while the call reads it, is a look lost:
 * the host looks again, at least once after it, even past the wait. When a later look finds the
 * page sent what was typed, the fill reports that; otherwise the first failure stands. On a step
 * with a submit whose fields are gone from the document the host typed in, the host looks again
 * without clicking (`awaitNewDocument`), as on a code step whose call raced its page
 * (`codeSentBySite`).
 */
const submitWhenEnabled = (input: CallInput, progress: FillProgress, call: AutofillFillCall) =>
  Effect.gen(function* () {
    const started = Date.now();
    const sendMs = sendWindow(input);
    const readsOnly = !hostSubmits(input.step) && sendMs > 0;
    let unsentSince: number | undefined;
    let lost: Either.Either<CallAnswer, Error> | undefined;
    let lastLost = false;
    const changes = { count: 0 };
    for (;;) {
      const answered = yield* fillCall(input, progress, changes)(call);
      const raced =
        codeSentBySite(input.step) && (Either.isLeft(answered) || unchecked(answered));
      if ((leftOnly(answered) || raced) && sendMs > 0)
        return yield* awaitNewDocument(input, progress, call, answered, sendMs, changes);
      const failed = readsOnly && Either.isLeft(answered);
      const unsent = unclicked(answered, "none") || failed;
      if (unsent) unsentSince ??= Date.now();
      const waiting = unclicked(answered, "disabled")
        ? Date.now() - started < submitEnableMs
        : unsent &&
          (Date.now() - (unsentSince ?? started) < sendMs || (failed && !lastLost));
      if (failed) lost ??= answered;
      lastLost = failed;
      if (!waiting) return lost === undefined || pageSent(answered) ? answered : lost;
      yield* Effect.sleep(submitPollMs);
    }
  });

/**
 * One field: a date's call fills it; any other field's call focuses it and binds its original node/document/frame; the host inserts its
 * value atomically. Undefined when the fill goes on to the next field, else the step's report.
 */
const fillField = (
  input: FillInput,
  progress: FillProgress,
  index: number,
): Effect.Effect<AutofillStepReport | undefined> =>
  Effect.gen(function* () {
    const field = input.step.fields[index];
    const value = input.values[index] ?? "";
    const bindingKey = `__opengpt_autofill_${randomUUID()}`;
    const format = field?.slot === "date_of_birth" ? (field.format ?? "YYYY-MM-DD") : undefined;
    const answered = yield* fillCall(
      input,
      progress,
    )(
      format === undefined
        ? { kind: "focus", index, bindingKey }
        : { kind: "date", index, iso: value, format },
    );
    if (answered._tag === "Left")
      return failedCall(progress, answered.left, {
        ...(format === undefined ? {} : { held: input.values }),
        mayMutate: format !== undefined,
      });
    const answer = answered.right;
    if ("refusal" in answer || "checked" in answer)
      return stopped(input.step, progress, answer, "field");
    progress.check = [];
    return yield* afterFieldCall(input, progress, index, answer, bindingKey);
  });

/**
 * A field that did not take the focus, or whose native insertion refused (`insertion`, its finite
 * cause), and why. A private answer's question that changed is a change on the screen, as when the
 * call found it changed before focusing.
 */
const untypedRefusal = (
  input: FillInput,
  progress: FillProgress,
  index: number,
  answer: Extract<CallAnswer, { readonly focused: boolean }>,
  insertion: InsertionRefusal | undefined,
) =>
  withCheck(
    refused("credential_target_refused", index),
    insertion === undefined
      ? "not_focused"
      : insertion === "question_changed"
        ? "change"
        : "typing_refused",
    {
      ...answer.unfocused,
      ...(insertion === undefined ? {} : { insertion }),
      ...(insertion === "question_changed" ? { cause: "question_changed" } : {}),
      ...targetEvidence(progress.judged.fields[index], evidenceOrigins(input, progress)),
      ...foundEvidence(answer.url, answer.located, evidenceOrigins(input, progress)),
    },
  );

/** What a field's own call found: a date filled, or a focused field the host now types. */
const afterFieldCall = (
  input: FillInput,
  progress: FillProgress,
  index: number,
  answer: Exclude<CallAnswer, Stop | { readonly checked: false }>,
  bindingKey: string,
): Effect.Effect<AutofillStepReport | undefined> =>
  Effect.gen(function* () {
    if ("dated" in answer) {
      // A date's call may have changed the field even when it failed.
      progress.typed = true;
      progress.typedIn = answer.document;
      progress.statuses.push(answer.dated ? "filled" : "failed");
      return answer.dated
        ? undefined
        : filledReport(input.step, progress, "not_attempted", answer.url);
    }
    if (!("focused" in answer)) return refused("page_unavailable");
    let insertion: InsertionRefusal | undefined;
    if (answer.focused) {
      const value = input.values[index] ?? "";
      const typing = yield* Effect.either(
        input.keyboard.insertText(
          {
            targetId: input.inspection.popupTargetId,
            bindingKey,
            documentOrigin: progress.judged.fields[index]?.documentOrigin ?? "",
          },
          value,
          input.step.fields[index]?.slot === "phone" ? { phone: true } : undefined,
        ),
      );
      if (typing._tag === "Left") {
        const lost = failedCall(progress, typing.left, {
          held: input.values,
          mayMutate: true,
          typing: true,
        });
        if (index < input.step.fields.length - 1 || !codeSentBySite(input.step)) return lost;
        // The page may have sent the code on this last digit (`codeSentBySite`).
        progress.typedIn = answer.document;
        const looked = yield* awaitNewDocument(
          input,
          progress,
          submitCall(input, progress, []),
          Either.left(typing.left),
          sendWindow(input),
          { count: 0 },
        );
        if (Either.isLeft(looked) || !("pageSent" in looked.right)) return lost;
        progress.typed = true;
        progress.statuses.push("filled");
        return filledReport(input.step, progress, "page", looked.right.url);
      }
      if (typing.right === "inserted") {
        progress.typed = true;
        progress.typedIn = answer.document;
        progress.statuses.push("filled");
        progress.check = [index];
        return undefined;
      }
      // The phone went in, but the field kept other digits: the host types and clicks nothing more.
      if (typing.right === "changed") {
        progress.typed = true;
        progress.typedIn = answer.document;
        progress.statuses.push("changed");
        return filledReport(input.step, progress, "not_attempted", answer.url);
      }
      insertion = typing.right;
    }
    const refusal = untypedRefusal(input, progress, index, answer, insertion);
    if (!progress.typed) return refusal;
    progress.statuses.push("failed");
    return filledReport(input.step, progress, "not_attempted", answer.url, refusal);
  });

/**
 * Fills the values into the step's fields, in order, and clicks its submit, on the stable primary tab or its inspected authentication popup,
 * judging every control again before each call acts. Kernel calls
 * focus and bind each field and click; the host inserts each value atomically into that original
 * node over its own encrypted DevTools socket (`keyboard`), so no value but a date of birth ever enters a Kernel call's script text or
 * its request to Kernel's REST API. It reports per-field outcomes and never a
 * value. Once anything was typed, a call that fails or finds a control refused can no longer say
 * nothing reached the site: a lost answer is `uncertain`, a control refused before a field's typing
 * fails that field, and one refused before the click, or a submission refused as it fires, refuses
 * the submit. That click ran, though, so the report says so (`clicked`): the page's own handlers
 * ran on it, and what the step filled may have gone out. A submit the page keeps disabled is never
 * clicked: the host waits for the page to enable it once the fields are filled. When it stays
 * disabled after the host typed a field, the host types every field again key by key
 * (`InsertionOptions.keys`), for a page that enables it only on key presses, and waits once more.
 * When it still stays disabled the report says so (`stayed_disabled`). A step whose code the host
 * typed one character per box into several code fields is submitted only once every box holds
 * exactly one character; otherwise that box fails and the submit is not attempted. A phone field is
 * read back once typed (`InsertionOptions.phone`): one that kept other digits than the number, as
 * under a country picker set to another country, is `changed`, and the fill types nothing more and
 * never clicks the submit. On a step with fields and no submit, a page that moves on once every
 * field is typed sent what was typed itself (`page`), never a refusal:
 * the step's fields went away or were all disabled, its popup closed, its address moved to another
 * path, or a step of several fields came back emptied. The host gives the page up to `pageSendMs`
 * to do so, and a submit call that fails meanwhile is followed by another look (`submitWhenEnabled`).
 * A step with a submit is the host's to click, whatever its page does meanwhile, unless a new
 * document took the place of the one the host typed the last field in, and the step's fields went
 * with it, before the click or within `pageSendMs` of a look that found them gone: the page sent
 * the form itself (`page`, `screenGone`, `awaitNewDocument`), and the host clicks nothing. A form
 * that locks, redraws itself or changes its address with pushState has sent nothing, and the host
 * waits on it or refuses as before. A code step gets the same looks once every box is typed, when
 * its submit call finds a box empty or fails, or the last box's typing loses its answer, as when
 * its page sends the code itself on the last digit and loads a new document while the host checks
 * the boxes (`codeSentBySite`). Its fields gone with a new document within `pageSendMs` is `page`,
 * with every box filled; else the report is as it would have been.
 * Guardian's refusals still come first: a control that moved off the site or changed how it
 * submits refuses the submit as before.
 * A step that names `dismiss` clicks that covering notice's own control first, when the page shows
 * it, and refuses the step with nothing typed when it is no such control (`dismissNotice`). A
 * click another element caught, which never reached the submit, is `blocked`, with that element
 * (`blockedBy`): nothing was sent and the fields still hold what was typed, so the minter can name
 * the element's own control as `dismiss` and send the screen again (`resubmitAutofillStep`), which
 * presses the submit from the keyboard only when its click is caught again. On a step that names
 * `dismiss`, a notice drawn only once the fields were typed is dismissed then, and the submit
 * clicked once more, with nothing typed again. A click that ran out of time while the next page
 * loaded, as one through a slow chain of redirects does, is `clicked` once a request for the page's
 * main frame went out, whatever the site answered, and the page gets the settle wait from there;
 * with no such request it is `failed`.
 */
export const fillAutofillStep = (input: FillInput): Effect.Effect<AutofillStepReport> =>
  Effect.gen(function* () {
    const { step } = input;
    if (input.typing === "keyboard")
      return withCheck(refused("typing_unavailable"), "typing_unavailable");
    const crossing = crossingSelector(step);
    if (crossing !== undefined)
      return withCheck(refused("selector_unsupported", crossing), "selector_unsupported");
    const progress: FillProgress = {
      statuses: [],
      typed: false,
      check: [],
      judged: input.inspection.targets,
      judgment: input.inspection.judgment,
      typedAt: randomUUID(),
      typedIn: undefined,
      trusted: new Set(),
    };
    const notice = yield* dismissNotice(input, progress);
    if (notice.refusal !== undefined) return notice.refusal;
    for (let index = 0; index < step.fields.length; index++) {
      const ended = yield* fillField(input, progress, index);
      if (ended !== undefined) return ended;
    }
    const boxes = codeBoxes(step, input.values);
    const typed =
      input.typedBefore === undefined ? undefined : [...input.typedBefore, ...input.values];
    const typeAgain = (fill: FillInput) =>
      Effect.gen(function* () {
        progress.statuses.length = 0;
        progress.check = [];
        for (let index = 0; index < step.fields.length; index++) {
          const ended = yield* fillField(fill, progress, index);
          if (ended !== undefined) return ended;
        }
        return yield* submitStep(fill, progress, boxes, typed);
      });
    const report = yield* submitStep(input, progress, boxes, typed);
    // The page may enable its submit only on key presses: the host types every field again by keys.
    if (
      report.outcome === "filled" &&
      report.submit === "stayed_disabled" &&
      typedFields(step, progress).length > 0
    )
      return yield* typeAgain({ ...input, keyboard: byKeys(input.keyboard) });
    if (!isBlocked(report) || step.dismiss === undefined) return report;
    const again = yield* dismissNotice(input, progress);
    // The dismiss emptied the fields before its click: the host types them all again.
    if (again.emptied) return yield* typeAgain(input);
    if (!again.dismissed) return report;
    progress.check = typedFields(step, progress);
    return yield* submitStep(input, progress, boxes, typed);
  });

/**
 * Clicks again the submit of a step whose fill the host reported `blocked`, typing nothing: the
 * fields still hold what that fill typed. It clicks the step's `dismiss` first, when the page shows
 * it, and refuses with nothing clicked when it is no covering notice's own control
 * (`dismissNotice`), or a control is gone or moved where the host refuses it. Then each field the
 * fill typed must still hold something (lengths only, never a value), and each box of a code split
 * across one-character boxes exactly one character, or that field fails and the submit is not
 * attempted; otherwise the submit is judged, guarded and clicked as the fill's own was, and the
 * report says what became of it. A click another element catches again, as one the dismiss did not
 * clear or one with nothing to dismiss, such as a fixed footer, is pressed from the keyboard
 * instead: the host focuses that same submit and presses Enter on it, only once focus landed on it,
 * under the same guard, and reports it `clicked` with `via: "keyboard"`; the element over it is
 * never clicked. When focus goes anywhere else it is `blocked` again.
 */
export const resubmitAutofillStep = (input: CallInput): Effect.Effect<AutofillStepReport> =>
  Effect.gen(function* () {
    const { step } = input;
    if (step.submit === undefined) return refused("not_found", "submit");
    const crossing = crossingSelector(step);
    if (crossing !== undefined)
      return withCheck(refused("selector_unsupported", crossing), "selector_unsupported");
    const progress: FillProgress = {
      statuses: step.fields.map(() => "filled"),
      typed: true,
      check: [],
      judged: input.inspection.targets,
      judgment: input.inspection.judgment,
      typedAt: randomUUID(),
      typedIn: undefined,
      trusted: new Set(),
    };
    const notice = yield* dismissNotice(input, progress);
    if (notice.refusal !== undefined) return notice.refusal;
    progress.check = typedFields(step, progress);
    const codeFields = step.fields.flatMap((field, index) => (field.slot === "code" ? [index] : []));
    return yield* submitStep(
      input,
      progress,
      codeFields.length > 1 ? codeFields : [],
      undefined,
      true,
    );
  });

/** The keyboard, typing each value key by key (`InsertionOptions.keys`). */
const byKeys = (keyboard: CredentialKeyboard): CredentialKeyboard => ({
  insertText: (target, text, options) => keyboard.insertText(target, text, { ...options, keys: true }),
});

/** The first of the step's selectors that reaches into another frame, its `dismiss` included. */
const crossingSelector = (step: AutofillStep<FillSlot>) =>
  unsupportedSelector(step) ??
  (step.dismiss !== undefined && frameCrossing(step.dismiss) ? ("dismiss" as const) : undefined);

/** A fill whose submit's click another element caught. */
const isBlocked = (report: AutofillStepReport) =>
  report.outcome === "filled" && report.submit === "blocked";

/**
 * The fields the host typed itself and that still count as filled, which a submit it clicks again
 * checks still hold something: never a date, which the authoring library fills into the page's
 * own controls.
 */
const typedFields = (step: AutofillStep<FillSlot>, progress: FillProgress) =>
  step.fields.flatMap((field, index) =>
    field.slot !== "date_of_birth" && progress.statuses[index] === "filled" ? [index] : [],
  );

/**
 * Clicks the step's `dismiss` when the page shows it (`dismissCode`). Before anything was typed, a
 * control the call refused, or one of the step's controls gone or moved where the host refuses it,
 * refuses the step (`dismiss_refused` for the dismiss itself); once something was typed it refuses
 * the click again instead, which the caller reports as it stands. A dismiss the page does not show,
 * whose click failed or whose answer was lost clicks nothing that sends, so the fill goes on.
 * `dismissed` says whether the call clicked it, and `emptied` whether it emptied the step's fields
 * first, as it does before a click whose submission it cancels, so what was typed must be typed
 * again.
 */
const dismissNotice = (
  input: CallInput,
  progress: FillProgress,
): Effect.Effect<{
  readonly dismissed: boolean;
  readonly emptied?: true;
  readonly refusal?: AutofillRefusal;
}> =>
  Effect.gen(function* () {
    const selector = input.step.dismiss;
    if (selector === undefined) return { dismissed: false };
    const answered = yield* fillCall(input, progress)({ kind: "dismiss", selector });
    if (Either.isLeft(answered)) return { dismissed: false };
    const answer = answered.right;
    if ("refusal" in answer) return { dismissed: false, refusal: answer.refusal };
    if (!("dismiss" in answer)) return { dismissed: false };
    if (answer.dismiss === "refused" || answer.dismiss === "ambiguous")
      return {
        dismissed: false,
        refusal: withCheck(refused("dismiss_refused", "dismiss"), "dismiss", {
          part: answer.dismiss === "refused" ? answer.part : "ambiguous_match",
          ...foundEvidence(answer.url, undefined, evidenceOrigins(input, progress)),
        }),
      };
    return {
      dismissed: answer.dismiss === "clicked",
      ...("emptied" in answer && answer.emptied === true ? { emptied: true as const } : {}),
    };
  });

/**
 * The step's submit, judged again, guarded and clicked once every field was typed
 * (`submitWhenEnabled`), and what became of it. `boxes` are the step's code boxes, each of which
 * must hold exactly one character before the click. A clicked submit reports where the page went
 * (`navigated`, `reportedNavigation`) only when `typed`, every value the sign-in typed on this
 * browser, is known: a click again, or a fill whose host did not say what it typed before
 * (`typedBefore`), never reports it. `pressCovered`, on a click again only, presses the submit from
 * the keyboard when another element catches its click.
 */
const submitStep = (
  input: CallInput,
  progress: FillProgress,
  boxes: readonly number[],
  typed: readonly string[] | undefined,
  pressCovered = false,
) =>
  Effect.gen(function* () {
    const { step } = input;
    const clicked = yield* submitWhenEnabled(
      input,
      progress,
      submitCall(input, progress, boxes, pressCovered),
    );
    if (clicked._tag === "Left")
      return failedCall(progress, clicked.left, { mayMutate: hostSubmits(step) });
    const answer = clicked.right;
    if ("pageSent" in answer) return filledReport(step, progress, "page", answer.url);
    if ("refusal" in answer || "checked" in answer)
      return stopped(step, progress, answer, "submit");
    if ("submission" in answer)
      return filledReport(
        step,
        progress,
        "refused",
        answer.url,
        firedRefusal(answer, guardOrigins(input)),
        true,
      );
    if (!("submit" in answer)) return refused("page_unavailable");
    if (answer.submit === "blocked")
      return {
        ...filledReport(step, progress, "blocked", answer.url),
        blockedBy: coveringElement(answer.blockedBy),
      };
    if (answer.submit === "disabled")
      return filledReport(
        step,
        progress,
        "stayed_disabled",
        answer.url,
        withCheck(refused("not_editable", "submit"), "submit_disabled", {
          waitedMs: submitEnableMs,
          ...foundEvidence(answer.url, undefined, evidenceOrigins(input, progress)),
        }),
      );
    const navigated =
      answer.submit !== "clicked" || answer.navigated === undefined || typed === undefined
        ? undefined
        : reportedNavigation({
            page: answer.navigated,
            url: answer.url,
            typed,
            trusted: [input.inspection.siteOrigin, ...input.inspection.authenticationOrigins],
          });
    return {
      ...filledReport(step, progress, answer.submit, answer.url),
      ...(answer.via === undefined ? {} : { via: answer.via }),
      ...(navigated === undefined ? {} : { navigated }),
      ...(answer.controls === undefined ? {} : { controls: answer.controls }),
    };
  });
