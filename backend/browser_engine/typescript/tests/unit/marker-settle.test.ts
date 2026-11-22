// Failure modes covered: a check gives up on a page that draws its marker after it loads, loads
// the page again on each check, reads a marker never drawn as absent before its window ends or
// waits past it, checks again after a failure other than a missing marker, or squeezes a short
// last wait into the end of its window.
import { Clock, Duration, Effect, Fiber, Option, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";
import type {
  AutofillSignedIn,
  AutofillSignedInCheck,
} from "../../src/destinations/autofill-step.js";
import { settledMarkerCheck, type MarkerSettle } from "../../src/destinations/marker-settle.js";

const signedIn = { signedIn: true, url: "https://shop.example/" } as const;
const missing = { signedIn: false, failed: "indicator_not_visible" } as const;
const marker = { selector: "#menu", openPath: "/" };

/** What a forked check settled to, if it did by now. */
const settledTo = <A>(fiber: Fiber.RuntimeFiber<A>) =>
  Fiber.poll(fiber).pipe(Effect.flatMap(Effect.transposeOption));
/** The check on a test clock moved on `ms`: what it settled to by then, if it did. */
const onTestClock = <A>(check: Effect.Effect<A>, ms: number) =>
  Effect.gen(function* () {
    const checking = yield* Effect.fork(check);
    yield* TestClock.adjust(Duration.millis(ms));
    return yield* settledTo(checking);
  }).pipe(Effect.provide(TestContext.TestContext), Effect.runPromise);

/** Answers each check in turn, a missing marker once the answers run out. */
const answers = (results: AutofillSignedInCheck[]) => {
  const opened: (string | undefined)[] = [];
  return {
    opened,
    check: (indicator: AutofillSignedIn) =>
      Effect.sync((): AutofillSignedInCheck => {
        opened.push(indicator.openPath);
        return results.shift() ?? missing;
      }),
  };
};

/** A page that draws its marker `drawnAfterMs` after the check opened it, if ever. */
const drawnLate = (drawnAfterMs?: number) => {
  let openedAt = 0;
  const checkedAt: number[] = [];
  return {
    checkedAt,
    check: (indicator: AutofillSignedIn) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (indicator.openPath !== undefined) openedAt = now;
        checkedAt.push(now - openedAt);
        return drawnAfterMs !== undefined && now - openedAt >= drawnAfterMs ? signedIn : missing;
      }),
  };
};

describe("a check that waits for a page to draw its marker", () => {
  // Three checks, half a second apart.
  const settle: MarkerSettle = { within: Duration.seconds(1), interval: Duration.millis(500) };
  const settled = async (fake: ReturnType<typeof answers>) =>
    Option.getOrThrow(
      await onTestClock(
        settledMarkerCheck(fake.check, marker, settle),
        Duration.toMillis(settle.within),
      ),
    );

  it("waits for a page that draws its marker after it loads, opening it once", async () => {
    const fake = answers([missing, signedIn]);
    expect(await settled(fake)).toEqual(signedIn);
    expect(fake.opened).toEqual(["/", undefined]);
  });

  it("reads a marker that never shows as missing once its window ends", async () => {
    const fake = answers([missing, missing, missing]);
    expect(await settled(fake)).toEqual(missing);
    expect(fake.opened).toEqual(["/", undefined, undefined]);
  });

  it("ends the wait at once on any failure but a missing marker", async () => {
    const formShows = answers([{ signedIn: false, failed: "password_field_visible" }]);
    expect(await settled(formShows)).toEqual({ signedIn: false, failed: "password_field_visible" });
    expect(formShows.opened).toEqual(["/"]);
    const unreadable = answers([{ signedIn: false, failed: "page_unavailable" }]);
    expect(await settled(unreadable)).toEqual({ signedIn: false, failed: "page_unavailable" });
    expect(unreadable.opened).toEqual(["/"]);
  });

  it("shows a marker the page draws 4 s after it loads", async () => {
    const page = drawnLate(4_000);
    expect(await onTestClock(settledMarkerCheck(page.check, marker), 4_000)).toEqual(
      Option.some(signedIn),
    );
    expect(page.checkedAt.at(-1)).toBe(4_000);
  });

  it("reads a marker the page never draws as missing 10 s after the load, not sooner", async () => {
    const never = drawnLate();
    const checking = Effect.gen(function* () {
      const fiber = yield* Effect.fork(settledMarkerCheck(never.check, marker));
      yield* TestClock.adjust(Duration.millis(9_999));
      const before = yield* settledTo(fiber);
      yield* TestClock.adjust(Duration.millis(1));
      return { before, after: yield* settledTo(fiber) };
    }).pipe(Effect.provide(TestContext.TestContext), Effect.runPromise);
    expect(await checking).toEqual({ before: Option.none(), after: Option.some(missing) });
    expect(never.checkedAt.at(-1)).toBe(10_000);
  });

  it("checks again only while a whole interval still fits in its window", async () => {
    const never = drawnLate();
    const uneven: MarkerSettle = { within: Duration.seconds(1), interval: Duration.millis(400) };
    expect(await onTestClock(settledMarkerCheck(never.check, marker, uneven), 1_000)).toEqual(
      Option.some(missing),
    );
    expect(never.checkedAt).toEqual([0, 400, 800]);
  });
});
