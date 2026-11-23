import { Effect, Schema } from "effect";
import { InvalidInput, InvalidOutput, inputIssues } from "./errors.js";
import type { KernelOperation } from "./kernel-operation.js";

/** Contract validation for a Kernel script run: its input decoded, its output validated. */
export const decodeKernelOperationInput = <Input, EncodedInput, Output, EncodedOutput>(
  operation: Pick<KernelOperation<Input, EncodedInput, Output, EncodedOutput>, "name" | "input">,
  rawInput: unknown,
) =>
  // Every rejected path, not only the first, so one correction can fix them all.
  Schema.decodeUnknown(operation.input, { errors: "all" })(rawInput).pipe(
    Effect.mapError(
      (error) =>
        new InvalidInput({
          operation: operation.name,
          issues: inputIssues(operation.input, error),
        }),
    ),
  );

export const validateKernelOperationOutput = <Input, EncodedInput, Output, EncodedOutput>(
  operation: KernelOperation<Input, EncodedInput, Output, EncodedOutput>,
  output: unknown,
) =>
  Schema.validate(operation.output)(output).pipe(
    Effect.mapError((cause) => new InvalidOutput({ operation: operation.name, cause, output })),
  );
