import { Effect, Either } from "effect";
import { expect, it } from "vitest";
import { makeRunLogin } from "../../src/runtime/run-login.js";

const login = { username: "synthetic-user", password: "synthetic-password" };

it("reads a saved login once per attempt, keeping a failed read failed and registering before returning", async () => {
  let reads = 0;
  const registered: string[] = [];
  const failing = await Effect.runPromise(
    makeRunLogin<string>({
      passwordless: false,
      read: Effect.suspend(() => {
        reads += 1;
        return Effect.fail("unavailable");
      }),
      register: () => Effect.void,
    }),
  );
  expect(failing.held()).toBeUndefined();
  const tries = [failing.values, failing.values, failing.values];
  for (const values of tries)
    expect(await Effect.runPromise(Effect.either(values))).toEqual(Either.left("unavailable"));
  expect(reads).toBe(1);

  const reading = await Effect.runPromise(
    makeRunLogin<string>({
      passwordless: false,
      read: Effect.suspend(() => {
        reads += 1;
        return Effect.succeed(login);
      }),
      register: (values) =>
        Effect.sync(() => {
          registered.push(values.password ?? "");
        }),
    }),
  );
  expect(await Effect.runPromise(reading.values)).toEqual(login);
  expect(await Effect.runPromise(reading.values)).toEqual(login);
  expect(reads).toBe(2);
  expect(registered).toEqual([login.password]);
  expect(reading.held()).toEqual(login);
});
