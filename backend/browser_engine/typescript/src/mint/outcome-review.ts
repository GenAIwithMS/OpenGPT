import { Clock, Duration, Effect, Fiber, Queue, Schema, Stream, SubscriptionRef } from "effect";
import type { Scope } from "effect";
import { guardianOutageRetry } from "../guardian/review.js";
import type { GuardianSessionSnapshot } from "../guardian/session.js";
import type { GuardianAction } from "../guardian/review-contracts.js";
import {
  ListRecordsInput,
  ReadHistoryInput,
  ReadRecordInput,
  RequestObservationInput,
  SearchHistoryInput,
  SubmitAssessmentInput,
} from "./outcome-review-contracts.js";
import type { AgentInputItem } from "@openai/agents";
import type { MintFailure } from "./contracts.js";
import type {
  LiveMinterHistory,
  MinterHistoryArchive,
  ObservationRequest,
  OutcomeAssessment,
  OutcomeEvidence,
  OutcomeReviewEvent,
  OutcomeReviewEventInput,
  OutcomeReviewHost,
  OutcomeReviewSnapshot,
  OutcomeReviewTools,
  OutcomeWrite,
  WriteExecutionStatus,
  WriteOutcome,
} from "./outcome-review-contracts.js";

/** A write's entrypoint and digest, from whichever record has them. */
const pathOf = (saved: OutcomeWrite | undefined, recovered: OutcomeWrite) => {
  const entrypoint = saved?.entrypoint ?? recovered.entrypoint;
  const sourceDigest = saved?.sourceDigest ?? recovered.sourceDigest;
  return {
    ...(entrypoint === undefined ? {} : { entrypoint }),
    ...(sourceDigest === undefined ? {} : { sourceDigest }),
  };
};

/** History items one search reads at a time. */
const searchPage = 200;

/** A history archive in memory: a host without a durable one keeps it for the attempt. */
export const memoryHistoryArchive = (): MinterHistoryArchive => {
  const items: AgentInputItem[] = [];
  return {
    append: (offset, appended) =>
      Effect.sync(() => {
        items.splice(offset, items.length - offset, ...appended);
      }),
    length: Effect.sync(() => items.length),
    read: (offset, limit) => Effect.sync(() => items.slice(offset, offset + limit)),
  };
};

/** The minter's whole history as the outcome reviewer reads it, oldest first. */
export interface MinterHistory {
  readonly length: Effect.Effect<number, MintFailure>;
  readonly read: (offset: number, limit: number) => Effect.Effect<readonly unknown[], MintFailure>;
}

/** What a history item the host could not store reads as, so later offsets stay right. */
export const historyGapText =
  "[history gap: the host could not store this item of the minter's history, so it is missing; its absence is no evidence either way]";
const historyGaps = (count: number): AgentInputItem[] =>
  Array.from({ length: Math.max(0, count) }, () => ({
    type: "message" as const,
    role: "system" as const,
    content: historyGapText,
  }));

/**
 * The minter's whole history: the archive up to where the run state starts, and the run state
 * from there. Reads wait until the model has registered its run state, so a restored turn never
 * reads the archive alone; `live` is undefined until then.
 */
export const minterHistory = (
  archive: MinterHistoryArchive,
  live: () => LiveMinterHistory | undefined,
  registered: Effect.Effect<void>,
): MinterHistory => {
  const held = registered.pipe(
    Effect.map(() => live() ?? { offset: 0, items: [] as readonly AgentInputItem[] }),
  );
  return {
    length: Effect.map(held, (current) => current.offset + current.items.length),
    read: (offset, limit) =>
      Effect.gen(function* () {
        const current = yield* held;
        const end = offset + limit;
        const wanted = Math.max(0, Math.min(end, current.offset) - offset);
        const stored = wanted === 0 ? [] : yield* archive.read(offset, wanted);
        // What the archive lacks below the run state, as after a lost write to it, is a gap.
        const archived = [...stored, ...historyGaps(wanted - stored.length)];
        const fromLive =
          end > current.offset
            ? current.items.slice(Math.max(0, offset - current.offset), end - current.offset)
            : [];
        return [...archived, ...fromLive];
      }),
  };
};

/**
 * A host's durable archive behind an in-memory buffer: a range whose durable append failed stays
 * readable here, is recorded as a gap and is stored again with the next append or read. A storage
 * failure never ends the build.
 */
export const bufferedHistoryArchive = (
  durable: MinterHistoryArchive,
  recordGap: (error: MintFailure) => Effect.Effect<void>,
): MinterHistoryArchive => {
  /** Ranges not yet stored durably, oldest first and contiguous. */
  let pending: { offset: number; items: readonly AgentInputItem[] }[] = [];
  let failing = false;
  /** Where the durable archive ends, once known. */
  let durableEnd: number | undefined;
  const flush = Effect.gen(function* () {
    while (pending.length > 0) {
      const [next] = pending;
      if (next === undefined) return;
      const stored = yield* Effect.either(
        Effect.gen(function* () {
          durableEnd ??= yield* durable.length;
          // A range an earlier attempt could not store is missing: marked, so offsets hold.
          const start = Math.min(durableEnd, next.offset);
          yield* durable.append(start, [...historyGaps(next.offset - start), ...next.items]);
          durableEnd = next.offset + next.items.length;
        }),
      );
      if (stored._tag === "Left") {
        if (!failing) yield* recordGap(stored.left);
        failing = true;
        durableEnd = undefined;
        return;
      }
      failing = false;
      pending = pending.slice(1);
    }
  });
  const pendingStart = () => pending[0]?.offset ?? Number.POSITIVE_INFINITY;
  return {
    append: (offset, items) =>
      Effect.suspend(() => {
        pending = [...pending.filter((range) => range.offset < offset), { offset, items }].map(
          (range) =>
            range.offset + range.items.length > offset && range.offset < offset
              ? { offset: range.offset, items: range.items.slice(0, offset - range.offset) }
              : range,
        );
        return flush;
      }),
    length: Effect.gen(function* () {
      yield* flush;
      const last = pending.at(-1);
      return last === undefined ? yield* durable.length : last.offset + last.items.length;
    }),
    read: (offset, limit) =>
      Effect.gen(function* () {
        yield* flush;
        const end = offset + limit;
        const start = Math.min(end, pendingStart());
        const items: AgentInputItem[] = [
          ...(offset < start ? yield* durable.read(offset, start - offset) : []),
        ];
        // Each buffered range sits at its own offset: what neither store holds before it, as a
        // range lost with an earlier attempt, is a gap.
        let at = offset + items.length;
        for (const range of pending) {
          const from = Math.max(offset, range.offset);
          const to = Math.min(end, range.offset + range.items.length);
          if (from >= to) continue;
          items.push(...historyGaps(from - at));
          items.push(...range.items.slice(from - range.offset, to - range.offset));
          at = to;
        }
        return items;
      }),
  };
};

/** What one history item reads as, at most this many characters. */
const historyItemChars = 8_000;
/** What one read_history result holds at most, in characters. */
const historyReadChars = 48_000;
/** The text around a search match. */
const excerptChars = 300;

const text = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join("");
  if (typeof value !== "object" || value === null) return "";
  const own: unknown = Reflect.get(value, "text");
  if (typeof own === "string") return own;
  const output: unknown = Reflect.get(value, "output");
  if (output !== undefined) return text(output);
  return text(Reflect.get(value, "content"));
};

/**
 * One minter history item as the reviewer reads it: what the item says, without encrypted
 * reasoning or provider data. A compaction item says what it is: the turns before it are still
 * in the history.
 */
export const historyItemText = (item: unknown): string => {
  if (typeof item !== "object" || item === null) return String(item);
  const type: unknown = Reflect.get(item, "type");
  const role: unknown = Reflect.get(item, "role");
  const name: unknown = Reflect.get(item, "name");
  const body =
    type === "compaction"
      ? "[compaction: the model's later requests carried a summary in place of the items before this one; those items are all still in this history]"
      : type === "function_call"
        ? `${String(name)}(${String(Reflect.get(item, "arguments"))})`
        : type === "function_call_result"
          ? `${String(name)} result: ${text(item)}`
          : type === "reasoning"
            ? text(Reflect.get(item, "content")) || "[reasoning]"
            : role !== undefined
              ? text(item)
              : JSON.stringify(item, (key, value: unknown) =>
                  key === "providerData" || key === "encrypted_content" ? undefined : value,
                );
  const label = typeof role === "string" ? role : typeof type === "string" ? type : "item";
  const whole = `${label}: ${body}`;
  return whole.length <= historyItemChars
    ? whole
    : `${whole.slice(0, historyItemChars)}…[cut at ${historyItemChars} characters]`;
};

const decoded = <A, I>(schema: Schema.Schema<A, I>, input: unknown) =>
  Schema.decodeUnknownEither(schema)(input);
const invalid = (detail: string) => JSON.stringify({ status: "invalid", detail });

/** Unresolved: never assessed, or assessed `unknown`, which a later readback may still settle. */
const settled = (assessment: OutcomeAssessment | undefined) =>
  assessment !== undefined && assessment.outcome !== "unknown";

export const writeOutcomeOf = (
  write: OutcomeWrite,
  assessment: OutcomeAssessment | undefined,
): WriteOutcome => ({
  write,
  status:
    assessment?.outcome === "done"
      ? "applied"
      : assessment?.outcome === "not_done"
        ? "not_applied"
        : "may_have_applied",
  ...(assessment === undefined ? {} : { assessment }),
});

const reviewerInstruction =
  "Assess each unresolved write from the evidence: search and read the minter's history (its earlier turns, from before any compaction, included), the host's records and the task. Submit one assessment per write you can settle, citing the history offsets and record refs it rests on: done when evidence shows the intended change happened, a commit request that went through with no error after it included, not_done when evidence that covers the change's account, scope and time shows it did not, unknown when the evidence cannot tell. A loading failure, a sign-in failure or an incomplete search never shows absence. A newer assessment replaces an older one. If only a fresh readback could settle a write, ask the minter for it with request_observation and end the turn; its result arrives in a later turn. End the turn with a short final message once you have done what the evidence allows.";
const finalInstruction =
  "This is the final turn: the minter called finish_build. Assess every unresolved write you can from the evidence collected so far. A write you leave unresolved is reported as may have applied, and nothing is corrected after the build ends.";

interface Status {
  readonly running: boolean;
  /** The last turn failed, and the reviewer waits to retry it. */
  readonly outage: boolean;
  readonly cursor: number;
}

/** The outcome reviewer of one mint, as the harness drives it. */
export interface OutcomeReviewer {
  /** Tracks a write-labelled execution that returned, failed or lost its result, and wakes. */
  readonly write: (write: OutcomeWrite) => Effect.Effect<void>;
  /** A later execution, which wakes the reviewer only while a write is unresolved. */
  readonly execution: (execution: {
    readonly executionId: string;
    readonly purpose: string;
    readonly action?: GuardianAction;
    readonly status: WriteExecutionStatus;
  }) => Effect.Effect<void>;
  /** A change to the remaining work, which wakes the reviewer only while a write is unresolved. */
  readonly taskUpdated: (change: string) => Effect.Effect<void>;
  /** finish_build ran: with a write unresolved, the attempt's end gives one final turn. */
  readonly finishing: Effect.Effect<void>;
  /**
   * The newest assessments of `executionIds` once the reviewer has seen every event so far, or
   * at once while it is in an outage or absent. Only repeating a write waits on this.
   */
  readonly settle: (executionIds: readonly string[]) => Effect.Effect<{
    readonly assessments: readonly (OutcomeAssessment | undefined)[];
    /**
     * The reviewer saw every event so far without an outage, and no readback it asked for about
     * these writes is still unanswered: only then may an assessment allow a repeat.
     */
    readonly current: boolean;
  }>;
  /** Readbacks the reviewer asked for since the last call, for the minter's next tool result. */
  readonly observationRequests: () => readonly Pick<
    ObservationRequest,
    "executionId" | "request"
  >[];
  /** Every tracked write, oldest first. */
  readonly tracked: () => readonly OutcomeWrite[];
  /** Every tracked write with its newest assessment. */
  readonly outcomes: () => readonly WriteOutcome[];
  /**
   * Ends the reviewer as the attempt ends. After finish_build with a write unresolved, a turn in
   * progress finishes and one final turn sees whatever it did not, without retry; otherwise a
   * turn in progress is stopped. Returns every write with its newest assessment.
   */
  readonly close: Effect.Effect<readonly WriteOutcome[]>;
}

/**
 * The outcome reviewer's schedule for one mint: tracked writes, the events that wake it and one
 * turn at a time on its continuing conversation. Events that arrive during a turn are coalesced
 * into the next. A failed turn is retried after a wait, without limit, and never invents an
 * outcome. The minter never waits for it except to repeat a write (`settle`), and publication
 * never does: an unresolved write is reported `may_have_applied`. Without a host, writes are
 * tracked and never assessed.
 */
export const makeOutcomeReviewer = (options: {
  readonly host: OutcomeReviewHost | undefined;
  readonly evidence: OutcomeEvidence;
  /** The minter's whole history, turns before a compaction included. */
  readonly history: MinterHistory;
  /**
   * The writes the harness's own recovery checkpoint tracked. The reviewer's saved state is
   * best-effort, so a write it lacks is tracked again from here, and one it has keeps the
   * checkpoint's entrypoint and digest.
   */
  readonly recoveredWrites?: readonly OutcomeWrite[];
}): Effect.Effect<OutcomeReviewer, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { host, evidence } = options;
    const initial = host?.initial;
    const events: OutcomeReviewEvent[] = [...(initial?.events ?? [])];
    let cursor = initial?.cursor ?? 0;
    const writes = new Map<string, OutcomeWrite>(
      (initial?.writes ?? []).map((write) => [write.executionId, write]),
    );
    /** Recovered writes the reviewer's saved state never saw, each a new event for it. */
    const unseen: OutcomeWrite[] = [];
    for (const recovered of options.recoveredWrites ?? []) {
      const saved = writes.get(recovered.executionId);
      if (saved === undefined) unseen.push(recovered);
      writes.set(recovered.executionId, { ...recovered, ...saved, ...pathOf(saved, recovered) });
    }
    const assessments = new Map<string, OutcomeAssessment>(
      (initial?.assessments ?? []).map((assessment) => [assessment.executionId, assessment]),
    );
    const observationRequests: ObservationRequest[] = [...(initial?.observationRequests ?? [])];
    let finishRequested = initial?.finishRequested ?? false;
    let conversation: GuardianSessionSnapshot | undefined = initial?.conversation;
    const lastSeq = () => events.at(-1)?.seq ?? 0;
    const status = yield* SubscriptionRef.make<Status>({ running: false, outage: false, cursor });
    /** Wakes the worker when an event arrives or the reviewer closes. */
    const wake = yield* Queue.sliding<void>(1);
    let closing = false;
    const report = (event: Readonly<Record<string, unknown>>) =>
      host?.report?.(event) ?? Effect.void;
    /** Assessments are numbered one at a time, so two calls never share a version. */
    const assessing = yield* Effect.makeSemaphore(1);
    for (const write of unseen)
      events.push({ kind: "write", write, seq: lastSeq() + 1 } as OutcomeReviewEvent);

    const snapshot = (): OutcomeReviewSnapshot => ({
      version: 1,
      conversation: conversation ?? {
        version: 1,
        sdkVersion: "0.18.0",
        history: [],
        incomplete: false,
      },
      events: [...events],
      cursor,
      writes: [...writes.values()],
      assessments: [...assessments.values()],
      observationRequests: [...observationRequests],
      finishRequested,
    });
    /** A failed save waits for the next change; it never ends a turn or the build. */
    const save = Effect.suspend(() =>
      host === undefined
        ? Effect.void
        : host
            .save(snapshot())
            .pipe(Effect.catchAll((error) => report({ phase: "save_failed", code: error.code }))),
    );
    /** Saves asked for outside an Effect, run by a fiber of the reviewer's own scope. */
    const saveRequests = yield* Queue.sliding<void>(1);
    yield* Effect.forkScoped(Effect.forever(Queue.take(saveRequests).pipe(Effect.zipRight(save))));
    const unresolved = () =>
      [...writes.values()].filter((write) => !settled(assessments.get(write.executionId)));
    /** A readback the reviewer asked for about `executionId` that no newer assessment answered. */
    const awaitingReadback = (executionId: string) =>
      observationRequests.some(
        (request) =>
          request.executionId === executionId &&
          (assessments.get(executionId)?.version ?? 0) <= request.assessedVersion,
      );
    const notify = (event: OutcomeReviewEventInput) =>
      Effect.gen(function* () {
        // Each event kind's fields are its own; the sequence number is the host's.
        events.push({ ...event, seq: lastSeq() + 1 } as OutcomeReviewEvent);
        yield* save;
        yield* Queue.offer(wake, undefined);
      });
    const tools: OutcomeReviewTools = {
      searchHistory: (input) =>
        Effect.gen(function* () {
          const request = decoded(SearchHistoryInput, input);
          if (request._tag === "Left") return invalid("query and limit (1 to 20) are required");
          const words = request.right.query.toLowerCase().split(/\s+/u).filter(Boolean);
          const total = yield* options.history.length;
          const matches: { offset: number; excerpt: string }[] = [];
          for (
            let page = 0;
            page < total && matches.length < request.right.limit;
            page += searchPage
          ) {
            const items = yield* options.history.read(page, Math.min(searchPage, total - page));
            for (let index = 0; index < items.length; index++) {
              const itemText = historyItemText(items[index]);
              const lower = itemText.toLowerCase();
              if (!words.every((word) => lower.includes(word))) continue;
              const at = lower.indexOf(words[0] ?? "");
              const start = Math.max(0, at - excerptChars / 2);
              matches.push({
                offset: page + index,
                excerpt: itemText.slice(start, start + excerptChars),
              });
              if (matches.length >= request.right.limit) break;
            }
          }
          return JSON.stringify({
            status: "ok",
            total,
            matches,
            instruction:
              "Read a match's surroundings with read_history from a few items before its offset.",
          });
        }),
      readHistory: (input) =>
        Effect.gen(function* () {
          const request = decoded(ReadHistoryInput, input);
          if (request._tag === "Left") return invalid("offset and limit (1 to 50) are required");
          const { offset, limit } = request.right;
          const total = yield* options.history.length;
          const items = yield* options.history.read(
            offset,
            Math.max(0, Math.min(limit, total - offset)),
          );
          const read: { offset: number; text: string }[] = [];
          let chars = 0;
          let next = offset;
          for (const item of items) {
            const itemText = historyItemText(item);
            if (read.length > 0 && chars + itemText.length > historyReadChars) break;
            read.push({ offset: next, text: itemText });
            chars += itemText.length;
            next++;
          }
          return JSON.stringify({
            status: "ok",
            total,
            items: read,
            nextOffset: next < total ? next : null,
          });
        }),
      listRecords: (input) =>
        Effect.gen(function* () {
          const request = decoded(ListRecordsInput, input);
          if (request._tag === "Left")
            return invalid("kind is execution, source, capture or publication");
          return JSON.stringify({
            status: "ok",
            records: yield* evidence.list(request.right.kind),
          });
        }),
      readRecord: (input) =>
        Effect.gen(function* () {
          const request = decoded(ReadRecordInput, input);
          if (request._tag === "Left") return invalid("ref, offset and limit are required");
          const { ref, offset, limit } = request.right;
          const chunk = yield* evidence.read(ref, { offset, limit });
          return chunk === undefined
            ? JSON.stringify({ status: "not_found", ref })
            : JSON.stringify({ status: "ok", ...chunk });
        }),
      readTask: () =>
        evidence.task().pipe(Effect.map((task) => JSON.stringify({ status: "ok", ...task }))),
      submitAssessment: (input) =>
        assessing.withPermits(1)(
          Effect.gen(function* () {
            const request = decoded(SubmitAssessmentInput, input);
            if (request._tag === "Left")
              return invalid(
                "executionId, outcome (done, not_done or unknown), explanation and evidence are required",
              );
            const write = writes.get(request.right.executionId);
            if (write === undefined)
              return invalid(
                "executionId names no write this build tracks; list the writes in the turn's message",
              );
            const assessment: OutcomeAssessment = {
              ...request.right,
              version: (assessments.get(write.executionId)?.version ?? 0) + 1,
              assessedAt: yield* Clock.currentTimeMillis,
            };
            // Recorded before it counts, so no assessment is reported that the journal lacks.
            yield* host?.recordAssessment(assessment, write) ?? Effect.void;
            assessments.set(write.executionId, assessment);
            // A newer assessment answers the readbacks asked before it.
            for (let index = observationRequests.length - 1; index >= 0; index--)
              if (
                observationRequests[index]?.executionId === write.executionId &&
                (observationRequests[index]?.assessedVersion ?? 0) < assessment.version
              )
                observationRequests.splice(index, 1);
            yield* save;
            return JSON.stringify({ status: "recorded", version: assessment.version });
          }),
        ),
      requestObservation: (input) =>
        Effect.gen(function* () {
          const request = decoded(RequestObservationInput, input);
          if (request._tag === "Left") return invalid("executionId and request are required");
          if (!writes.has(request.right.executionId))
            return invalid("executionId names no write this build tracks");
          observationRequests.push({
            ...request.right,
            assessedVersion: assessments.get(request.right.executionId)?.version ?? 0,
          });
          yield* save;
          return JSON.stringify({
            status: "queued",
            instruction:
              "The minter sees the request with its next tool result. Its readback arrives in a later turn.",
          });
        }),
    };

    /** The wake message for one turn: its events and every write still unresolved. */
    const turnInput = (batch: readonly OutcomeReviewEvent[], final: boolean) =>
      JSON.stringify({
        outcome_review_turn: {
          events: batch,
          unresolvedWrites: unresolved().map((write) => ({
            ...write,
            ...(assessments.get(write.executionId) === undefined
              ? {}
              : { assessment: assessments.get(write.executionId) }),
          })),
          final,
          instruction: final ? `${reviewerInstruction} ${finalInstruction}` : reviewerInstruction,
        },
      });

    /** One attempt at a turn over every event after the cursor; true when it completed. */
    const attempt = (model: OutcomeReviewHost["model"]) =>
      Effect.gen(function* () {
        const batch = events.filter((event) => event.seq > cursor);
        const through = batch.at(-1)?.seq ?? cursor;
        const final = batch.some((event) => event.kind === "finish");
        yield* SubscriptionRef.update(status, (current) => ({ ...current, running: true }));
        yield* report({ phase: "turn_started", events: batch.length, final });
        const result = yield* Effect.either(
          model.turn({
            input: turnInput(batch, final),
            final,
            conversation: {
              initial: conversation,
              save: (next) =>
                Effect.suspend(() => {
                  conversation = next;
                  return save;
                }),
            },
            tools,
          }),
        );
        if (result._tag === "Right") cursor = through;
        yield* report(
          result._tag === "Right"
            ? { phase: "turn_completed", cursor }
            : { phase: "turn_failed", code: result.left.code },
        );
        yield* save;
        yield* SubscriptionRef.set(status, {
          running: false,
          outage: result._tag === "Left",
          cursor,
        });
        return result._tag === "Right";
      });

    /** Waits until the status satisfies `done`; the current status counts. */
    const until = (done: (current: Status) => boolean) =>
      status.changes.pipe(Stream.filter(done), Stream.take(1), Stream.runDrain);

    const delays = (host?.retryDelays ?? guardianOutageRetry.delays).map((delay) =>
      Duration.decode(delay),
    );
    /** Runs turns while events wait; after a failure, waits and runs again, without limit. */
    const worker = (model: OutcomeReviewHost["model"]) =>
      Effect.gen(function* () {
        let failures = 0;
        for (;;) {
          if (closing) return;
          if (lastSeq() <= cursor) {
            yield* Queue.take(wake);
            continue;
          }
          if (yield* attempt(model)) {
            failures = 0;
            continue;
          }
          const wait = delays[Math.min(failures, delays.length - 1)] ?? Duration.seconds(60);
          failures++;
          yield* report({ phase: "turn_retry_wait", waitMs: Duration.toMillis(wait) });
          yield* Effect.sleep(wait);
        }
      });
    const fiber = host === undefined ? undefined : yield* Effect.forkScoped(worker(host.model));
    const outcomes = () =>
      [...writes.values()].map((write) =>
        writeOutcomeOf(write, assessments.get(write.executionId)),
      );

    return {
      write: (write) =>
        Effect.suspend(() => {
          writes.set(write.executionId, write);
          return notify({ kind: "write", write });
        }),
      execution: (execution) =>
        Effect.suspend(() =>
          unresolved().length === 0 ? Effect.void : notify({ kind: "execution", ...execution }),
        ),
      taskUpdated: (change) =>
        Effect.suspend(() =>
          unresolved().length === 0 ? Effect.void : notify({ kind: "task_updated", change }),
        ),
      finishing: Effect.suspend(() => {
        if (unresolved().length === 0) return Effect.void;
        finishRequested = true;
        return notify({ kind: "finish" });
      }),
      settle: (executionIds) =>
        Effect.gen(function* () {
          const target = lastSeq();
          if (fiber !== undefined)
            yield* until(
              (current) => !current.running && (current.cursor >= target || current.outage),
            );
          const current = yield* SubscriptionRef.get(status);
          return {
            assessments: executionIds.map((id) => assessments.get(id)),
            current:
              fiber !== undefined &&
              !current.outage &&
              current.cursor >= target &&
              !executionIds.some(awaitingReadback),
          };
        }),
      observationRequests: () => {
        const taken = observationRequests.filter((request) => request.delivered !== true);
        if (taken.length === 0) return [];
        for (let index = 0; index < observationRequests.length; index++) {
          const request = observationRequests[index];
          if (request !== undefined && request.delivered !== true)
            observationRequests[index] = { ...request, delivered: true };
        }
        Queue.unsafeOffer(saveRequests, undefined);
        return taken.map(({ executionId, request }) => ({ executionId, request }));
      },
      tracked: () => [...writes.values()],
      outcomes,
      close: Effect.gen(function* () {
        closing = true;
        if (fiber === undefined || host === undefined) return outcomes();
        if (finishRequested && unresolved().length > 0) {
          // A turn in progress finishes; a wait between failed turns does not hold the end.
          yield* until((current) => !current.running);
          yield* Fiber.interrupt(fiber);
          if (lastSeq() > cursor) yield* attempt(host.model);
        } else yield* Fiber.interrupt(fiber);
        return outcomes();
      }),
    } satisfies OutcomeReviewer;
  });
