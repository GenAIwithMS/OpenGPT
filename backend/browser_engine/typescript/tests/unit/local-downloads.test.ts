import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, TestClock, TestContext } from "effect";
import { expect, it } from "vitest";
import {
  downloadLifetimeMs,
  makeLocalDownloads,
  sweepLeftoverDownloads,
} from "../../src/execution/local-downloads.js";

const minutes = (count: number) => count * 60_000;
const start = Date.parse("2026-03-01T10:00:00.000Z");
const run = <A>(effect: Effect.Effect<A, Error>) =>
  Effect.runPromise(
    TestClock.setTime(start).pipe(Effect.zipRight(effect), Effect.provide(TestContext.TestContext)),
  );
const file = (name: string) => ({ name, bytes: new TextEncoder().encode(`${name}\n`) });

it("keeps a download for 30 minutes and sweeps it at the next keep after that", async () => {
  const root = await mkdtemp(join(tmpdir(), "opengpt-downloads-qa-"));
  try {
    const kept = await run(
      Effect.gen(function* () {
        const downloads = makeLocalDownloads(root);
        const first = yield* downloads.keep(file("first.csv"));
        yield* TestClock.adjust(minutes(29));
        const second = yield* downloads.keep(file("second.csv"));
        const firstBefore = existsSync(fileURLToPath(first.download_url));
        yield* TestClock.adjust(minutes(2));
        yield* downloads.keep(file("third.csv"));
        return { first, second, firstBefore };
      }),
    );
    expect(kept.first.expires_at).toBe(new Date(start + downloadLifetimeMs).toISOString());
    expect(kept.firstBefore).toBe(true);
    expect(existsSync(fileURLToPath(kept.first.download_url))).toBe(false);
    expect(existsSync(fileURLToPath(kept.second.download_url))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("removes another process's download directory once it went 30 minutes unchanged", async () => {
  const parent = await mkdtemp(join(tmpdir(), "opengpt-leftovers-qa-"));
  const directory = (name: string, changedAt: number) =>
    mkdir(join(parent, name)).then(() =>
      utimes(join(parent, name), changedAt / 1000, changedAt / 1000),
    );
  try {
    await directory("opengpt-downloads-old", start - minutes(31));
    await directory("opengpt-downloads-recent", start - minutes(5));
    await directory("opengpt-downloads-own", start - minutes(60));
    await directory("unrelated-old", start - minutes(60));
    await run(sweepLeftoverDownloads(parent, join(parent, "opengpt-downloads-own")));
    expect(existsSync(join(parent, "opengpt-downloads-old"))).toBe(false);
    expect(existsSync(join(parent, "opengpt-downloads-recent"))).toBe(true);
    expect(existsSync(join(parent, "opengpt-downloads-own"))).toBe(true);
    expect(existsSync(join(parent, "unrelated-old"))).toBe(true);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
