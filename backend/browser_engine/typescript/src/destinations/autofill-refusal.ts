import { Schema } from "effect";
import { failureDetail, withFailureContext } from "../runtime/failure-detail.js";
import type { FailureContextValue } from "../runtime/failure-detail.js";
import type {
  AutofillRefusal,
  AutofillStepReport,
  LocatedError,
  Targets,
} from "./autofill-step.js";
import { InsertionRefusal } from "./credential-keyboard.js";

/** Where a step call found a control's one visible match: that frame's URL, and how many it searched. */
export const FoundIn = Schema.Struct({ frameUrl: Schema.String, frames: Schema.Number });
/** Where a step call found each control of the step. */
export const FoundAt = Schema.Struct({
  fields: Schema.Array(FoundIn),
  submit: Schema.NullOr(FoundIn),
});
/** A search with no one visible match: the frames searched and each frame that matched. */
export const Searched = Schema.Struct({
  frames: Schema.Number,
  matches: Schema.Array(
    Schema.Struct({ frameUrl: Schema.String, count: Schema.Number, visible: Schema.Number }),
  ),
});

/** A refusal for `reason`, about the control `target` names, if any. */
export const refused = (
  reason: AutofillRefusal["reason"],
  target?: AutofillRefusal["target"],
): AutofillRefusal => ({
  outcome: "refused",
  reason,
  ...(target === undefined ? {} : { target }),
});

/** Value-free evidence of a refusal: finite facts, origins and counts, never a URL or a value. */
type RefusalEvidence = Readonly<Record<string, FailureContextValue | undefined>>;

/**
 * The opaque URLs named by what they are, a failed navigation's error page among them; page code
 * chooses any other scheme, so may fill it. Page code reports a URL by the same names.
 */
export const opaqueOrigins: readonly string[] = [
  "about:blank",
  "about:srcdoc",
  "data:",
  "javascript:",
  "blob:",
  "chrome-error:",
];

/**
 * A URL's origin alone, never its path or query. An opaque one is named only from a fixed set
 * (`opaqueOrigins`), any other `other`.
 */
export const urlOrigin = (url: string) => {
  const parsed = URL.parse(url);
  if (parsed === null) return "invalid";
  if (parsed.origin !== "null") return parsed.origin;
  const opaque = parsed.protocol === "about:" ? `about:${parsed.pathname}` : parsed.protocol;
  return opaqueOrigins.includes(opaque) ? opaque : "other";
};

/**
 * The origins evidence may name once the step typed something: the page's and each control's
 * frame, document and destinations, as judged at inspection. Page code may since have put a typed
 * value, whole or in part, in any other origin, such as an action's hostname.
 */
export const judgedOrigins = (inspection: {
  readonly page: string;
  readonly targets: typeof Targets.Type;
}): ReadonlySet<string> =>
  new Set([
    urlOrigin(inspection.page),
    ...[...inspection.targets.fields, inspection.targets.submit].flatMap((target) =>
      target === null
        ? []
        : [
            ...(target.ownerUrl === null ? [] : [urlOrigin(target.ownerUrl)]),
            urlOrigin(target.documentOrigin),
            ...target.actions.map(urlOrigin),
          ],
    ),
  ]);

/**
 * The origins evidence may name once the host typed into the page before the inspection
 * (`judgedBeforeTyping` given): the site's and its configured sign-in origins, which no page code
 * chose, and those the browser's inspections judged before anything was typed. The inspection may
 * itself have found a typed value in any other origin. Undefined while nothing
 * was typed.
 */
/** The site's and its configured sign-in origins, which no page code chose. */
export const configuredOrigins = (trust: {
  readonly siteOrigin: string;
  readonly authenticationOrigins: readonly string[];
}) => [trust.siteOrigin, ...trust.authenticationOrigins].map(urlOrigin);

export const namedAfterTyping = (trust: {
  readonly siteOrigin: string;
  readonly authenticationOrigins: readonly string[];
  readonly judgedBeforeTyping?: readonly string[] | undefined;
}): ReadonlySet<string> | undefined =>
  trust.judgedBeforeTyping === undefined
    ? undefined
    : new Set([...configuredOrigins(trust), ...trust.judgedBeforeTyping]);

/**
 * A URL's origin when `named` holds it or no set is given, else `other`. An opaque one's name
 * comes from `urlOrigin`'s fixed set, which page code cannot fill.
 */
export const namedOrigin = (url: string, named: ReadonlySet<string> | undefined) => {
  const origin = urlOrigin(url);
  return named === undefined || named.has(origin) || !origin.includes("//") ? origin : "other";
};

/**
 * Where a control sits and submits, by origin: its own frame, its document and each destination,
 * each named only when `named` holds it (`namedOrigin`).
 */
export const targetEvidence = (
  target: (typeof Targets.Type)["fields"][number] | null | undefined,
  named?: ReadonlySet<string>,
): RefusalEvidence =>
  target === undefined || target === null
    ? {}
    : {
        frameOrigin: target.ownerUrl === null ? "none" : namedOrigin(target.ownerUrl, named),
        documentOrigin: namedOrigin(target.documentOrigin, named),
        actionOrigins: target.actions.map((action) => namedOrigin(action, named)).join(" "),
      };

/** The control a refusal is about, among the step's controls a call found. */
export const foundFor = (at: typeof FoundAt.Type | undefined, target: AutofillRefusal["target"]) =>
  target === "submit" ? at?.submit : typeof target === "number" ? at?.fields[target] : undefined;

/**
 * The primary page then and the frame a control's one visible match was in, by origin, each named
 * only when `named` holds it (`namedOrigin`).
 */
export const foundEvidence = (
  url: string | undefined,
  found: typeof FoundIn.Type | null | undefined,
  named?: ReadonlySet<string>,
): RefusalEvidence => ({
  ...(url === undefined ? {} : { pageOrigin: namedOrigin(url, named) }),
  ...(found === undefined || found === null
    ? {}
    : { matchFrameOrigin: namedOrigin(found.frameUrl, named), framesSearched: found.frames }),
});

/**
 * A refusal that says which check fired: `check`, also its failure detail's phase, with value-free
 * evidence for the diagnostic archive and the step event.
 */
export const withCheck = (
  refusal: AutofillRefusal,
  check: string,
  evidence: RefusalEvidence = {},
): AutofillRefusal => ({
  ...refusal,
  failureDetail: failureDetail("autofill_step_failed", {
    phase: check,
    context: { check, ...evidence },
    helperFrames: 1,
  }),
});

/** Adds evidence to a refusal that says which check fired. */
export const withEvidence = (refusal: AutofillRefusal, evidence: RefusalEvidence) =>
  refusal.failureDetail === undefined
    ? refusal
    : { ...refusal, failureDetail: withFailureContext(refusal.failureDetail, evidence) };

/**
 * A step call's own refusal, with its evidence: a search with no one visible match counts each
 * frame's visible and total matches by origin, and a replaced popup is a change. Origins are named
 * only when `named` holds them.
 */
export const locatedRefusal = (answer: typeof LocatedError.Type, named?: ReadonlySet<string>) =>
  withCheck(
    {
      outcome: "refused",
      reason: answer.error === "target_changed" ? "credential_target_refused" : answer.error,
      target: answer.target,
    },
    answer.error === "target_changed" ? "change" : answer.error,
    {
      ...(answer.error === "target_changed" ? { changed: answer.target } : {}),
      ...(answer.question === "changed" ? { cause: "question_changed" } : {}),
      ...foundEvidence(answer.url, answer.located, named),
      ...(answer.searched === undefined
        ? {}
        : {
            framesSearched: answer.searched.frames,
            matches: answer.searched.matches
              .map(
                (match) => `${namedOrigin(match.frameUrl, named)} ${match.visible}/${match.count}`,
              )
              .join(", "),
          }),
    },
  );

/**
 * A fill whose host click ran, even one whose submission the guard then refused as it fired, or
 * whose answer was lost, may have sent what it filled: the page's own handlers ran on the click.
 * So may a fill whose page sent what was typed itself (`page`).
 */
export const maySend = (stepReport: AutofillStepReport) =>
  stepReport.outcome === "uncertain" ||
  (stepReport.outcome === "filled" &&
    (stepReport.submit === "clicked" ||
      stepReport.submit === "page" ||
      stepReport.clicked === true));

/** A failed fill's diagnostic phase when the call that lost its answer was a field's typing. */
export const lostTypingPhase = "typing";

/**
 * A fill whose lost answer was a field's typing call's: that field may hold its value, and the
 * host never clicked the submit, which it clicks only after every field.
 */
export const lostTyping = (stepReport: AutofillStepReport) =>
  stepReport.outcome === "uncertain" && stepReport.failureDetail.phase === lostTypingPhase;

/**
 * A host refusal while typing into an autofill sign-in screen, value-free. Two are identical
 * when every field is: the same check, cause, field and screen.
 */
export interface HostRefusal {
  /**
   * The check that refused, the phase of its `autofill_step_failed` failure detail (`withCheck`):
   * `typing_refused`, `not_focused`, `not_editable`, `change`, `destination`, `not_found`,
   * `ambiguous_match`, `popup_missing` or `popup_ambiguous`.
   */
  readonly check: string;
  /** The field's index in the step. */
  readonly field: number;
  /**
   * What the check found, when it says more than the check does: the finite cause of a native
   * insertion that inserted nothing, under the `typing_refused` check, or `question_changed`, a
   * private answer's question that no longer reads as the host inspected it, under the `change`
   * check. Never a binding key, a selector or a value.
   */
  readonly cause?: InsertionRefusal;
  /** What the field takes: its slot, or the identifier kinds it accepts joined by ` or `. */
  readonly slot: string;
  /** The screen as the step names it: its fields' selectors, its submit and its popup's origin. */
  readonly screen: {
    readonly fields: readonly string[];
    readonly submit?: string;
    readonly submitKey?: string;
    readonly popup?: string;
  };
}

/** Whether two host refusals are identical: the same check, cause, field and screen. */
export const sameHostRefusal = (one: HostRefusal, other: HostRefusal) => {
  const key = (refusal: HostRefusal) =>
    JSON.stringify([
      refusal.check,
      refusal.cause ?? null,
      refusal.field,
      refusal.slot,
      refusal.screen.fields,
      refusal.screen.submit ?? null,
      refusal.screen.submitKey ?? null,
      refusal.screen.popup ?? null,
    ]);
  return key(one) === key(other);
};

/** A sign-in screen as a step or its request names it: each field's slot or accepted kinds. */
interface NamedScreen {
  readonly popup?: { readonly origin: string } | undefined;
  readonly fields: readonly {
    readonly selector: string;
    readonly slot?: string;
    readonly accepts?: readonly string[] | undefined;
  }[];
  readonly submit?: string | undefined;
  readonly submitKey?: string | undefined;
}

const isInsertionRefusal = Schema.is(InsertionRefusal);

/**
 * The fill's refusal of a field of `step`, if its report is one: a check refused to type into the
 * field, or to keep typing once an earlier field was typed, so the host submitted nothing of the
 * screen. Only a fill's report counts; an inspection's refusal comes before any typing. A refused
 * submit, a failed call and a lost answer are not refusals of a field. A refused native insertion
 * keeps its finite cause, as does a private answer's question that changed.
 */
export const typingRefusal = (
  step: NamedScreen,
  report: AutofillStepReport,
): HostRefusal | undefined => {
  if (report.outcome === "uncertain" || report.failureDetail?.subCause !== "autofill_step_failed")
    return undefined;
  const check = report.failureDetail.context?.["check"];
  const field =
    report.outcome === "refused"
      ? report.target
      : report.submit === "not_attempted"
        ? report.fields.findIndex((filled) => filled.status === "failed")
        : undefined;
  const named = typeof field === "number" ? step.fields[field] : undefined;
  if (typeof check !== "string" || typeof field !== "number" || named === undefined)
    return undefined;
  const evidence = report.failureDetail.context;
  const cause = [evidence?.["insertion"], evidence?.["cause"]].find(isInsertionRefusal);
  return {
    check,
    field,
    ...(cause === undefined ? {} : { cause }),
    slot: named.slot ?? named.accepts?.join(" or ") ?? "identifier",
    screen: {
      fields: step.fields.map((each) => each.selector),
      ...(step.submit === undefined ? {} : { submit: step.submit }),
      ...(step.submitKey === undefined ? {} : { submitKey: step.submitKey }),
      ...(step.popup === undefined ? {} : { popup: step.popup.origin }),
    },
  };
};
