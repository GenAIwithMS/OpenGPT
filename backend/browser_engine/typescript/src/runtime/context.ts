import { Context, Effect, Ref } from "effect";
import { CommitAlreadySent } from "./errors.js";
import type { CaptureUnavailable, EventUnavailable, WriteConfirmationRefused } from "./errors.js";
import type { Deadline } from "./deadline.js";

export interface EventSink {
  // The host stamps correlation fields and screens details before publication.
  readonly emit: (name: string, details: unknown) => Effect.Effect<void, EventUnavailable>;
}

export interface CaptureLifecycle {
  readonly start: Effect.Effect<void, CaptureUnavailable>;
  /** Collect final evidence and register discovered secrets, then await retain/discard. */
  readonly prepareRelease?: Effect.Effect<void, CaptureUnavailable>;
  readonly finish: Effect.Effect<void, CaptureUnavailable>;
  /** Optional success-only retention; cap screened files before any storage write. */
  readonly finishSampled?: (maxBytes: number) => Effect.Effect<void, CaptureUnavailable>;
  /** Await only after starting finish; success means final batch secrets are registered. */
  readonly releasePrepared?: Effect.Effect<void, CaptureUnavailable>;
  /** Complete a prepared finalization without rendering or storing capture artifacts. */
  readonly discard?: Effect.Effect<void, CaptureUnavailable>;
}

/**
 * Capture is evidence, never the run's result: a capture that cannot finish becomes a recorded
 * gap event and the operation's own outcome stands. The event sink failing too changes nothing.
 */
export const finishCaptureAsEvidence = (context: {
  readonly capture: CaptureLifecycle;
  readonly events: EventSink;
}) =>
  context.capture.finish.pipe(
    Effect.catchAll((error) =>
      context.events
        .emit("capture.finish_gap", {
          phase: error.phase,
          ...(error.captureReason === undefined ? {} : { reason: error.captureReason }),
          ...(error.captureCollection === undefined ? {} : { collection: error.captureCollection }),
          ...(error.captureScreening === undefined ? {} : { screening: error.captureScreening }),
          ...(error.captureReleasePreparation === undefined
            ? {}
            : { releasePreparation: error.captureReleasePreparation }),
        })
        // error-reporting-allow: typed-recovery the capture failure is what the gap event names; a sink that cannot take it leaves the operation's own outcome as the record
        .pipe(Effect.ignore),
    ),
  );

export type WebsiteEffect = "not_started" | "may_have_dispatched" | "verified";
/** How a write confirmed its effect: a confirmation the site showed, or a read-back of the saved state. */
export type WriteConfirmation = "message" | "readback";
/**
 * One named commit step of a write: `not_sent` until the step is about to dispatch, `sent` from
 * then on (it may have reached the site), `confirmed` once the write's confirmation was read.
 */
export type CommitMarkState = "not_sent" | "sent" | "confirmed";
export interface CommitMark {
  readonly name: string;
  readonly state: CommitMarkState;
}

export interface EffectJournal {
  readonly state: Effect.Effect<WebsiteEffect>;
  readonly enteringDispatch: Effect.Effect<void>;
  /** Completion evidence with no kind; a write records its kind with `confirmed`. */
  readonly verified: Effect.Effect<void, WriteConfirmationRefused>;
  /** The write read the site's confirmation or read back its saved state. It also sets `verified`,
   * so a host that reads only `state` still sees a confirmed write as verified. */
  readonly confirmed: (kind: WriteConfirmation) => Effect.Effect<void, WriteConfirmationRefused>;
  readonly confirmation: Effect.Effect<WriteConfirmation | undefined>;
  /**
   * Just before a write's named commit step dispatches. The mark reads `sent` from here on, even
   * if the step then fails, because the site may already have the request; like
   * `enteringDispatch`, it also marks the effect as possibly dispatched. A settled step, which
   * maintenance may not redo, fails with `CommitAlreadySent` instead, leaving the journal as it was.
   */
  readonly enteringCommit: (name: string) => Effect.Effect<void, CommitAlreadySent>;
  /**
   * The page proved that the named step's latest click saved nothing, such as one that left the
   * same step showing with a required field flagged empty: the mark reads `not_sent` again, as
   * before that `enteringCommit`. A step goes back once a run, and only when this run entered it
   * from `not_sent` with no confirmation since; any other call for an entered step, a second call
   * for the same step, or, once `declareCommits` named any step, a call for one it did not name
   * fails with `CommitAlreadySent` and leaves it as it was. A step never entered stays `not_sent`.
   * A host journal made before this existed has none, and a script's call then fails the same way.
   */
  readonly notCommitted?: (name: string) => Effect.Effect<void, CommitAlreadySent>;
  /** The operation's declared marks, in order; `executeOperation` records them before it runs. */
  readonly declareCommits: (names: readonly string[]) => Effect.Effect<void>;
  /** Every mark: the declared ones in order, then any entered without a declaration. */
  readonly commits: Effect.Effect<readonly CommitMark[]>;
}

/**
 * A journal whose `settledCommits` cannot be entered: during maintenance, the steps the original
 * confirmed and the sent ones its read-back did not find missing.
 */
export const makeEffectJournalWith = (options: {
  readonly settledCommits?: readonly string[];
}): Effect.Effect<EffectJournal> =>
  Effect.gen(function* () {
    const settled = new Set(options.settledCommits ?? []);
    const state = yield* Ref.make<WebsiteEffect>("not_started");
    const confirmation = yield* Ref.make<WriteConfirmation | undefined>(undefined);
    const commits = yield* Ref.make<readonly CommitMark[]>([]);
    // Each entered step's state just before its latest entering; a confirmation clears them all.
    const enteredFrom = yield* Ref.make<ReadonlyMap<string, CommitMarkState>>(new Map());
    // The steps already put back once this run, and the ones the operation declared.
    const reverted = yield* Ref.make<ReadonlySet<string>>(new Set());
    const declared = yield* Ref.make<ReadonlySet<string>>(new Set());
    const withMark = (name: string, next: (current: CommitMarkState) => CommitMarkState) =>
      Ref.update(commits, (marks) =>
        marks.some((mark) => mark.name === name)
          ? marks.map((mark) => (mark.name === name ? { name, state: next(mark.state) } : mark))
          : [...marks, { name, state: next("not_sent") }],
      );
    return {
      state: Ref.get(state),
      // A later dispatch reopens the effect, so a confirmation recorded before it no longer holds,
      // and the commit steps it covered read sent again.
      enteringDispatch: Ref.set(state, "may_have_dispatched").pipe(
        Effect.zipRight(Ref.set(confirmation, undefined)),
        Effect.zipRight(
          Ref.update(commits, (marks) =>
            marks.map((mark) => (mark.state === "confirmed" ? { ...mark, state: "sent" } : mark)),
          ),
        ),
      ),
      verified: Ref.set(state, "verified"),
      // The confirmation covers the whole write, so every commit step it followed is confirmed.
      confirmed: (kind) =>
        Ref.set(confirmation, kind).pipe(
          Effect.zipRight(
            Ref.update(commits, (marks) =>
              marks.map((mark) => (mark.state === "sent" ? { ...mark, state: "confirmed" } : mark)),
            ),
          ),
          Effect.zipRight(Ref.set(enteredFrom, new Map())),
          Effect.zipRight(Ref.set(state, "verified")),
        ),
      confirmation: Ref.get(confirmation),
      // Entering a step again commits again, so even a confirmed mark reads sent.
      enteringCommit: (name) =>
        settled.has(name)
          ? Effect.fail(new CommitAlreadySent({ name }))
          : Effect.gen(function* () {
              const before = (yield* Ref.get(commits)).find((mark) => mark.name === name)?.state;
              yield* Ref.update(enteredFrom, (from) => new Map(from).set(name, before ?? "not_sent"));
              yield* withMark(name, () => "sent");
              yield* Ref.set(state, "may_have_dispatched");
            }),
      // Back to unsent once, only from the one entering that found it unsent, and for a declared
      // step when the operation declares any (a build's act step declares none); never past a
      // confirmation.
      notCommitted: (name) =>
        Effect.gen(function* () {
          const known = yield* Ref.get(declared);
          if ((yield* Ref.get(reverted)).has(name) || (known.size > 0 && !known.has(name)))
            return yield* Effect.fail(new CommitAlreadySent({ name }));
          const current = (yield* Ref.get(commits)).find((mark) => mark.name === name)?.state;
          if (current === undefined || current === "not_sent") return;
          if (current !== "sent" || (yield* Ref.get(enteredFrom)).get(name) !== "not_sent")
            return yield* Effect.fail(new CommitAlreadySent({ name }));
          yield* Ref.update(reverted, (names) => new Set(names).add(name));
          yield* Ref.update(enteredFrom, (from) => {
            const next = new Map(from);
            next.delete(name);
            return next;
          });
          yield* withMark(name, () => "not_sent");
        }),
      declareCommits: (names) =>
        Ref.update(declared, (known) => new Set([...known, ...names])).pipe(
          Effect.zipRight(
            Effect.forEach(names, (name) => withMark(name, (current) => current), { discard: true }),
          ),
        ),
      commits: Ref.get(commits),
    };
  });

export const makeEffectJournal: Effect.Effect<EffectJournal> = makeEffectJournalWith({});

export interface ExecutionServices {
  readonly deadline: Deadline;
  readonly events: EventSink;
  readonly capture: CaptureLifecycle;
  readonly journal: EffectJournal;
}

export class ExecutionContext extends Context.Tag("opengpt-browser-engine/ExecutionContext")<
  ExecutionContext,
  ExecutionServices
>() {}
