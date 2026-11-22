import { Cause, Effect, Either, Exit, Option, Runtime } from "effect";
import { expect } from "vitest";

type Tagged = { readonly _tag: string };
type Expected = string | Readonly<Record<string, unknown>>;

const describeValue = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

const hasTag = <E extends Tagged, Tag extends E["_tag"]>(
  error: E,
  tag: Tag,
): error is Extract<E, { readonly _tag: Tag }> => error._tag === tag;

const assertExpected = (error: unknown, expected: Expected | undefined): void => {
  if (expected === undefined) return;
  if (typeof expected === "string") {
    expect(error).toHaveProperty("code", expected);
    return;
  }
  expect(error).toMatchObject(expected);
};

/**
 * Returns the failure of an Either after asserting it failed, so a success cannot pass
 * as a vacuous `Either.isLeft(result) && result.left.code` comparison.
 */
export const leftOf = <A, E>(result: Either.Either<A, E>): E => {
  if (Either.isRight(result)) {
    throw new Error(`Expected a failure, got success: ${describeValue(result.right)}`);
  }
  return result.left;
};

/**
 * Runs an Effect and asserts it fails with the expected error tag. A string `expected`
 * must equal the error's `code`; an object is matched with `toMatchObject`. Successes and
 * defects fail the assertion instead of passing as a generic rejection.
 */
export const expectFailure = async <A, E extends Tagged, Tag extends E["_tag"]>(
  effect: Effect.Effect<A, E>,
  tag: Tag,
  expected?: Expected,
): Promise<Extract<E, { readonly _tag: Tag }>> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    throw new Error(`Expected ${tag}, got success: ${describeValue(exit.value)}`);
  }
  const failure = Cause.failureOption(exit.cause);
  if (Option.isNone(failure)) {
    throw new Error(`Expected ${tag}, got ${Cause.pretty(exit.cause)}`);
  }
  const error = failure.value;
  if (!hasTag(error, tag)) {
    throw new Error(`Expected ${tag}, got ${error._tag}: ${describeValue(error)}`);
  }
  assertExpected(error, expected);
  return error;
};

/**
 * Awaits a Promise that must reject and returns what it rejected with. A rejection from
 * `Effect.runPromise` is unwrapped to the Effect failure, so callers can assert its tag and
 * fields instead of accepting any rejection.
 */
export const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return Runtime.isFiberFailure(error) ? Cause.squash(error[Runtime.FiberFailureCauseId]) : error;
  }
  throw new Error("Expected a rejection, got success");
};
