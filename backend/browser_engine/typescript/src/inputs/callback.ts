import { Clock, Effect, Either, Schema } from "effect";
import {
  InputRequest,
  InputRequestFailure,
  InputSuperseded,
  validateAnswer,
} from "../runtime/input-request.js";
import type { InputAnswers, InputAsker } from "../runtime/input-request.js";

/** Adapt raw caller answers to the same validation used by hosted input surfaces. */
export const makeInputAsker =
  (
    answer: (request: InputRequest) => Effect.Effect<InputAnswers, InputRequestFailure>,
  ): InputAsker =>
  (request, bounds) =>
    Effect.gen(function* () {
      const checked = yield* Schema.decodeUnknown(InputRequest)(request).pipe(
        Effect.mapError((cause) => new InputRequestFailure({ code: "Invalid", cause })),
      );
      const collect = answer(checked).pipe(
        Effect.flatMap((value) => {
          const valid = validateAnswer(checked, value);
          return Either.isRight(valid)
            ? Effect.succeed(valid.right)
            : Effect.fail(
                new InputRequestFailure({ code: "Invalid", operation: "validateAnswer" }),
              );
        }),
      );
      const timed =
        bounds?.sourceEndsAt === undefined
          ? collect
          : collect.pipe(
              Effect.timeoutFail({
                duration: Math.max(0, bounds.sourceEndsAt - (yield* Clock.currentTimeMillis)),
                onTimeout: () => new InputRequestFailure({ code: "NoResponse" }),
              }),
            );
      return yield* bounds?.superseded === undefined
        ? timed
        : Effect.raceFirst(
            timed,
            bounds.superseded.pipe(Effect.andThen(Effect.fail(new InputSuperseded()))),
          );
    });
