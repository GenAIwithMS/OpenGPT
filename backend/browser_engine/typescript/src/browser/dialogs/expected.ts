import { createHash, randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { MintFailure } from "../../mint/contracts.js";
import type { IncidentStore } from "../../runtime/incidents.js";
import type { AskBounds, InputAsker, InputRequest } from "../../runtime/input-request.js";
import { DialogFailure, ExpectedConfirm } from "./contracts.js";
import type { DialogChoice, DialogFacts, DialogType } from "./contracts.js";

/** How many accepted confirms one published revision keeps. */
export const expectedConfirmLimit = 32;
export const ExpectedConfirms = Schema.Array(ExpectedConfirm).pipe(
  Schema.maxItems(expectedConfirmLimit),
);

/** The longest confirm message a revision keeps a record of. */
const messageLimit = 2_000;
const stepPattern = /^[A-Za-z0-9_-]{1,100}$/;

/** Whitespace differences never make an expected popup unexpected. Case and wording do. */
const normalizedMessage = (message: string) =>
  message.normalize("NFC").replace(/\s+/gu, " ").trim();

/**
 * A run's value, or the page's record identifier, that a confirm's message names. The digest
 * keeps where it came from, never the value: `input/<JSON pointer>` for a value of the run's
 * input, `page/path/<index>` or `page/query/<name>` for a part of the page's URL.
 */
type Slot = readonly [source: string, value: string];

/**
 * A confirm's message with each value it names replaced by the sorted sources that hold it,
 * page text between. Host-only: the digest of it is what a revision keeps.
 */
export type ConfirmTemplate = readonly (string | readonly string[])[];

/** A record identifier holds a digit, such as an order number or a generated name. */
const identifierPattern = /\p{N}/u;
/** A query value such as "50.00" or "1,200" is an amount the site set, not a record. */
const amountPattern = /^[\p{N}\s]*[.,][\p{N}.,\s]*$/u;

/**
 * The shortest value that becomes a slot: two characters when it holds a digit, such as "12",
 * three otherwise. A shorter value stays page text, so "1", "a" or a code such as "OR" never
 * turns a word or number the site wrote into a placeholder.
 */
const slotValueMinimum = (value: string) => (identifierPattern.test(value) ? 2 : 3);
/** A value shorter than this matches only in its own letter case, so "Can" never matches "can". */
const foldedValueMinimum = 4;
/** How many values of a run's input a confirm's template reads, in order. */
const inputSlotLimit = 256;
const inputDepthLimit = 16;

const pointerToken = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");

/** The run's string and number values, each named by its JSON pointer. */
const inputSlots = (input: unknown): Slot[] => {
  const slots: Slot[] = [];
  const visit = (value: unknown, pointer: string, depth: number) => {
    if (slots.length >= inputSlotLimit) return;
    if (typeof value === "string") slots.push([`input${pointer}`, value]);
    else if (typeof value === "number" && Number.isFinite(value))
      slots.push([`input${pointer}`, String(value)]);
    else if (depth < inputDepthLimit && Array.isArray(value))
      value.forEach((item, index) => visit(item, `${pointer}/${index}`, depth + 1));
    else if (depth < inputDepthLimit && typeof value === "object" && value !== null)
      for (const [key, item] of Object.entries(value))
        visit(item, `${pointer}/${pointerToken(key)}`, depth + 1);
  };
  visit(input, "", 0);
  return slots;
};

const decoded = (part: string) => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

/** The page URL's path segments and query values that look like the record it shows. */
const pageSlots = (url: URL): Slot[] => {
  const slots: Slot[] = [];
  url.pathname.split("/").forEach((segment, index) => {
    const value = decoded(segment);
    if (identifierPattern.test(value)) slots.push([`page/path/${index}`, value]);
  });
  const named = new Set<string>();
  for (const [name, value] of url.searchParams) {
    if (named.has(name)) continue;
    named.add(name);
    if (identifierPattern.test(value) && !amountPattern.test(value))
      slots.push([`page/query/${encodeURIComponent(name)}`, value]);
  }
  return slots;
};

const wordCharacter = /[\p{L}\p{M}\p{N}_]/u;
const escapedPattern = (value: string) => value.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&");
/** A value matches only as a whole token: never inside a longer word or number. */
const tokenPattern = (value: string, folded: boolean) => {
  const characters = [...value];
  return (
    `${wordCharacter.test(characters.at(0) ?? "") ? "(?<![\\p{L}\\p{M}\\p{N}_])" : ""}` +
    (folded ? `(?i:${escapedPattern(value)})` : escapedPattern(value)) +
    `${wordCharacter.test(characters.at(-1) ?? "") ? "(?![\\p{L}\\p{M}\\p{N}_])" : ""}`
  );
};

/**
 * The message with each whole-token occurrence of a slot's value replaced by the sources that
 * hold it, longest value first, or undefined when it names none. Values are normalized as the
 * message is, and one of four or more characters matches in any letter case.
 */
const confirmTemplate = (message: string, slots: readonly Slot[]): ConfirmTemplate | undefined => {
  const groups = new Map<
    string,
    { readonly value: string; readonly folded: boolean; readonly sources: Set<string> }
  >();
  for (const [source, raw] of slots) {
    // Whitespace collapses, but never a value far longer than any message to a short one.
    if (raw.length > messageLimit * 4) continue;
    const value = normalizedMessage(raw);
    if (value.length < slotValueMinimum(value) || value.length > message.length) continue;
    const folded = value.length >= foldedValueMinimum;
    const key = folded ? `folded:${value.toLowerCase()}` : `exact:${value}`;
    const group = groups.get(key) ?? { value, folded, sources: new Set<string>() };
    group.sources.add(source);
    groups.set(key, group);
  }
  const ordered = [...groups.entries()]
    .sort(([left, a], [right, b]) => b.value.length - a.value.length || (left < right ? -1 : 1))
    .map(([, group]) => ({
      value: group.value,
      folded: group.folded,
      sources: [...group.sources].sort(),
    }));
  if (ordered.length === 0) return undefined;
  const pattern = new RegExp(
    ordered.map(({ value, folded }) => `(${tokenPattern(value, folded)})`).join("|"),
    "gu",
  );
  const template: (string | readonly string[])[] = [];
  let end = 0;
  for (const match of message.matchAll(pattern)) {
    const slot = ordered[match.slice(1).findIndex((group) => group !== undefined)];
    if (slot === undefined) continue;
    template.push(message.slice(end, match.index), slot.sources);
    end = match.index + match[0].length;
  }
  if (template.length === 0) return undefined;
  template.push(message.slice(end));
  return template;
};

/**
 * A confirm popup as the host saw it: its normalized message, page origin and generated step,
 * and, when the message names a value of the run's input or the page's record identifier, its
 * `template`. Host-only and never stored; a revision keeps only its digest.
 */
export interface ObservedConfirm {
  readonly message: string;
  readonly origin: string;
  readonly step: string;
  readonly template?: ConfirmTemplate;
}

/**
 * The fields of a native dialog a confirm match reads: its type, and the generated action that
 * raised it, the step a script names to `decideDialog`, or null when no action is known.
 */
export interface DialogEvent {
  readonly type: DialogType;
  readonly candidateActionId: string | null;
}

/**
 * The popup a confirm is, or undefined when it cannot be expected: not a confirm, raised outside
 * a generated action (so no step is known), on a page that is not https, or with a message empty
 * or too long to keep. Such a popup is never expected, so a run always asks about it. `input` is
 * the input the execution that raised it ran with: a message that names one of its values, or an
 * identifier in the page's URL, gets a `template`, so a run about another record can match it.
 */
export const observedConfirmOf = (
  event: DialogEvent,
  facts: DialogFacts,
  input?: unknown,
): ObservedConfirm | undefined => {
  const step = event.candidateActionId;
  if (event.type !== "confirm" || step === null || !stepPattern.test(step)) return undefined;
  const url = URL.canParse(facts.pageUrl) ? new URL(facts.pageUrl) : undefined;
  if (url?.protocol !== "https:") return undefined;
  const message = normalizedMessage(facts.message);
  if (message.length === 0 || message.length > messageLimit) return undefined;
  const template = confirmTemplate(message, [...inputSlots(input), ...pageSlots(url)]);
  return {
    message,
    origin: url.origin,
    step,
    ...(template === undefined ? {} : { template }),
  };
};

const digestOf = (tuple: readonly unknown[]) =>
  createHash("sha256").update(JSON.stringify(tuple)).digest("hex");

/**
 * The record a revision keeps of an accepted popup: a SHA-256 digest, so the shared revision
 * holds no page text. A popup that names no value keeps the digest of its normalized message,
 * page origin and step. One whose message names a value of its execution's input or the page's
 * record identifier keeps the digest of its template instead, each value replaced by where it
 * came from, so a run matches it only when the same wording names that run's own values from
 * the same places. Matching is exact otherwise.
 */
export const expectedConfirmDigest = (popup: ObservedConfirm): ExpectedConfirm => ({
  digest:
    popup.template === undefined
      ? digestOf(["opengpt.expected_confirm.v1", popup.message, popup.origin, popup.step])
      : digestOf(["opengpt.expected_confirm.v2", popup.template, popup.origin, popup.step]),
});

/**
 * The digests a run's popup matches: its template's, when it has one, then its exact message's,
 * which a record of a popup that named no value, or one published before templates, holds.
 */
const candidateDigests = (popup: ObservedConfirm) => {
  const { template, ...exact } = popup;
  const digests = [expectedConfirmDigest(exact).digest];
  return template === undefined ? digests : [expectedConfirmDigest(popup).digest, ...digests];
};

/**
 * One browser's pool of expected confirms. Each record the mint kept accepts one matching popup
 * (the same message, page origin and step, with the run's own `input` values in place of the
 * build's), so a popup the mint saw once is accepted once.
 */
export const makeExpectedConfirms = (records: readonly ExpectedConfirm[], input?: unknown) => {
  const remaining = records.map((record) => record.digest);
  return {
    take: (event: DialogEvent, facts: DialogFacts) => {
      const observed = observedConfirmOf(event, facts, input);
      if (observed === undefined) return undefined;
      for (const digest of candidateDigests(observed)) {
        const index = remaining.indexOf(digest);
        if (index < 0) continue;
        remaining.splice(index, 1);
        return { digest };
      }
      return undefined;
    },
  };
};

/**
 * Keeps a confirm popup the current live execution accepted, host-only, in `live`. A write
 * example's become digests in its revision's expected confirms, which its runs accept without
 * asking. `input` is the input the execution ran with, so a confirm that names one of its values
 * is kept as a template. It never throws, so it never changes a dialog's resolution.
 */
export const keepAcceptedConfirm = (
  live: ObservedConfirm[],
  resolution: {
    readonly event: DialogEvent;
    readonly facts: DialogFacts;
    readonly decision: DialogChoice;
    readonly input?: unknown;
  },
) => {
  if (resolution.decision.choice !== "accept" || live.length >= expectedConfirmLimit) return;
  const confirm = observedConfirmOf(resolution.event, resolution.facts, resolution.input);
  if (confirm !== undefined) live.push(confirm);
};

/**
 * The confirm popups the current live execution accepted that its build keeps. Only a write
 * keeps them, and never one whose text holds a registered secret such as the login: its runs ask
 * about that popup instead. `screen` fails for such a message, or when it cannot screen it;
 * `unscreened` hears each failure, and the popup is dropped either way.
 */
export const acceptedConfirmsKept = <E>(input: {
  readonly write: boolean;
  readonly accepted: readonly ObservedConfirm[];
  readonly screen: (message: string) => Effect.Effect<void, E>;
  readonly unscreened?: (error: E) => Effect.Effect<unknown>;
}): Effect.Effect<ObservedConfirm[]> =>
  !input.write
    ? Effect.succeed([])
    : Effect.filter(input.accepted, (confirm) =>
        input.screen(confirm.message).pipe(
          Effect.as(true),
          Effect.catchAll((error) =>
            (input.unscreened?.(error) ?? Effect.void).pipe(Effect.as(false)),
          ),
        ),
      );

/**
 * A write session's record of the confirms its act steps accepted: their digests, which its
 * revision keeps for runs, and the steps they were accepted at, which its composed script must
 * name.
 */
export interface ConfirmSession {
  readonly acceptedConfirms: ExpectedConfirm[];
  readonly confirmSteps: Set<string>;
}

/** Adds an act step's kept confirms to its write session. */
export const recordConfirmSteps = (session: ConfirmSession, confirms: readonly ObservedConfirm[]) => {
  session.acceptedConfirms.push(...confirms.map(expectedConfirmDigest));
  for (const confirm of confirms) session.confirmSteps.add(confirm.step);
};

/** Whether any source holds the value as a quoted literal. */
const namesLiteral = (sources: readonly string[], value: string) =>
  sources.some((source) =>
    [`'${value}'`, `"${value}"`, `\`${value}\``].some((literal) => source.includes(literal)),
  );

/**
 * A run accepts a confirm popup without asking only at the action the mint accepted it at, so
 * the composed script must run each such action under the session's action id. Fails
 * `confirm_action_unmatched`, naming each step no source of the composed script (its entrypoint
 * and every file it imports) holds as a quoted literal.
 */
export const confirmActionUnmatched = (
  confirmSteps: Iterable<string>,
  composedSources: readonly string[],
): Effect.Effect<void, MintFailure> => {
  const confirmActionIds = [...confirmSteps].filter(
    (actionId) => !namesLiteral(composedSources, actionId),
  );
  return confirmActionIds.length > 0
    ? Effect.fail(
        new MintFailure({
          code: "PublicationUnavailable",
          reason: "confirm_action_unmatched",
          confirmActionIds,
        }),
      )
    : Effect.void;
};

/**
 * Nothing is confirmed on the caller's behalf. A beforeunload is accepted because dismissing
 * it would cancel the run's own navigation; leaving a page sends nothing.
 */
const defaultChoice = (type: DialogType): DialogChoice =>
  type === "beforeunload" ? { choice: "accept" } : { choice: "dismiss" };

/**
 * A published run's native dialogs. A write tool's `confirm` that its mint accepted (the same
 * message, page origin and step, `expectedConfirms`, with the run's own `input` values in place
 * of the build's) is accepted and recorded. Any other write
 * `confirm` goes to the caller, when live input is configured: confirming belongs to the action
 * the caller asked for. A tool published before the mint kept that record has none, so its
 * confirms keep asking. Every other dialog is decided at once by the safe default and recorded,
 * so a page alert never becomes a long caller decision, unless the host asks the caller about
 * every dialog the record does not settle (`askEveryDialog`).
 *
 * A host may judge a write `confirm` that matched no record before the caller is asked
 * (`judgeConfirm`), such as one whose wording first appears in this run. It gets the popup as
 * observed, its `template` naming where each of this run's values came from, and answers
 * `accept`, which accepts and records it, or `ask`. A judgment that fails or dies counts as
 * `ask`. A popup that cannot be expected, because no step is known or its page is not https, is
 * never judged. The popup's message is the page's own text, unmasked: a host that sends it
 * anywhere screens it first. The host bounds the judgment's time itself.
 */
export const makeRunDialogDecision = <Event extends DialogEvent>(input: {
  readonly readOnly: boolean;
  /** The confirms the published write's mint accepted. */
  readonly expectedConfirms?: readonly ExpectedConfirm[] | undefined;
  /** The run's input, whose values a recorded confirm's message may name. */
  readonly input?: unknown;
  readonly askCaller?: (event: Event) => Effect.Effect<DialogChoice, DialogFailure>;
  /** Judges a write's confirm that matched no record, before the caller is asked. */
  readonly judgeConfirm?: (
    event: Event,
    confirm: ObservedConfirm,
  ) => Effect.Effect<"accept" | "ask", unknown>;
  readonly incidents: IncidentStore;
  readonly askEveryDialog?: boolean;
}) => {
  const expected = makeExpectedConfirms(input.expectedConfirms ?? [], input.input);
  const accepted = (reason: "dialog_expected_confirm_accepted" | "dialog_judged_confirm_accepted") =>
    input.incidents
      .record({
        source: "host",
        kind: "dialog",
        reason,
        hostBug: false,
        severity: "info",
        subCause: "confirm_accept",
      })
      .pipe(Effect.as<DialogChoice>({ choice: "accept" }));
  const unexpected = (event: Event) =>
    input.askCaller ? input.askCaller(event) : settled(event);
  const settled = (event: Event) => {
    if (input.askEveryDialog === true && input.askCaller) return input.askCaller(event);
    const choice = defaultChoice(event.type);
    return input.incidents
      .record({
        source: "host",
        kind: "dialog",
        reason: "dialog_default_decision",
        hostBug: false,
        severity: "info",
        subCause: `${event.type}_${choice.choice}`,
      })
      .pipe(Effect.as(choice));
  };
  return (event: Event, facts: DialogFacts): Effect.Effect<DialogChoice, DialogFailure> => {
    if (event.type !== "confirm" || input.readOnly) return settled(event);
    if (expected.take(event, facts) !== undefined)
      return accepted("dialog_expected_confirm_accepted");
    const judge = input.judgeConfirm;
    const observed = judge === undefined ? undefined : observedConfirmOf(event, facts, input.input);
    if (judge === undefined || observed === undefined) return unexpected(event);
    return Effect.suspend(() => judge(event, observed)).pipe(
      Effect.catchAllCause(() => Effect.succeed("ask" as const)),
      Effect.flatMap((verdict) =>
        verdict === "accept"
          ? accepted("dialog_judged_confirm_accepted")
          : unexpected(event),
      ),
    );
  };
};

const promptLimit = 2000;

const dialogPrompt = (event: { readonly type: DialogType; readonly message: string }) => {
  const shown = event.message.trim() === "" ? "" : `: "${event.message}"`;
  const prompt =
    event.type === "beforeunload"
      ? "The website asks whether to leave the page. Leave it?"
      : event.type === "alert"
        ? `The website shows a message${shown}. Close it and continue?`
        : event.type === "prompt"
          ? `The website asks for text${shown}. Answer it?`
          : `The website asks you to confirm${shown}. Confirm?`;
  return prompt.length <= promptLimit ? prompt : `${prompt.slice(0, promptLimit - 1)}…`;
};

/**
 * A native dialog the host cannot decide itself, asked as one `confirm` question: yes accepts it,
 * with the caller's text for a prompt dialog, and no dismisses it. `event.message` is the dialog's
 * message as the caller may see it, with any secret already masked. `bounds` holds the dialog's
 * own end, when the host keeps one. A question whose window ends unanswered fails as `expired`.
 */
export const askDialogCaller = (
  ask: InputAsker,
  event: { readonly type: DialogType; readonly message: string },
  bounds?: AskBounds,
): Effect.Effect<DialogChoice, DialogFailure> =>
  Effect.gen(function* () {
    const questionId = "decision";
    const request: InputRequest = {
      id: randomUUID(),
      source: "system",
      questions: [
        {
          id: questionId,
          type: "confirm",
          prompt: dialogPrompt(event),
          ...(event.type === "prompt" ? { followUp: { prompt: "Text to enter" } } : {}),
        },
      ],
    };
    const answers = yield* ask(request, bounds).pipe(
      Effect.mapError(
        (error) =>
          new DialogFailure({
            reason:
              error._tag === "InputSuperseded"
                ? "stale_decision"
                : error.code === "Unauthorized"
                  ? "unauthorized"
                  : error.code === "NoResponse"
                    ? "expired"
                    : "unavailable",
          }),
      ),
    );
    const answer = answers[questionId];
    if (answer?.type !== "confirm") return yield* new DialogFailure({ reason: "unavailable" });
    if (!answer.value.confirmed) return { choice: "dismiss" as const };
    return answer.value.text === undefined
      ? { choice: "accept" as const }
      : { choice: "accept" as const, promptText: answer.value.text };
  });
