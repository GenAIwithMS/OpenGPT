import { Effect, JSONSchema, Option, Schema } from "effect";
import type { Scope } from "effect";
import { ExecutionContext, finishCaptureAsEvidence } from "./context.js";
import type { EffectJournal } from "./context.js";
import {
  DeadlineExceeded,
  InvalidInput,
  inputIssues,
  InvalidOutput,
  WriteConfirmationRefused,
} from "./errors.js";
import type { CaptureUnavailable, EventUnavailable } from "./errors.js";
import type { operationErrors } from "./operation-failure.js";
import type { WebsiteAuthenticationFailed } from "./authentication.js";
import type { ScriptQuestionDeclarations } from "./script-input.js";
import type { KernelOperation, KernelOperationContext } from "./kernel-operation.js";
import { withListHost, type ListHost } from "./list-host.js";

/**
 * How a write operation proves its effect: it reads the confirmation the site shows, or reads back
 * the saved state, and records it: a Kernel script with `verified()` and no argument, declaring
 * `readback`, an HTTP implementation with `journal.confirmed`. `message` stays accepted for
 * revisions published before Kernel scripts stopped declaring it. `unverifiable` is for a site
 * that offers neither; its runs report the write as possibly completed.
 *
 * `commits` names the write's commit steps in order, such as `["save-address", "place-order"]`:
 * every step that can change the site (an autosave, a saved form step, the final submit). Each is
 * marked just before it dispatches: a Kernel script calls `enteringCommit(name)` right before the
 * execute call that sends it, an HTTP implementation `journal.enteringCommit(name)`. The host
 * treats a run as having sent nothing only when no mark was entered, and maintenance finishes
 * only the steps a failed run never reached.
 *
 * `commitsUnproven` names commit steps of `commits` after the last one the build's write session
 * entered, which the session never reached, as when the caller's facts ran out before them, such
 * as `["place-order"]` after a session that saved the address. Publication accepts them unentered
 * only after a step the session entered, and reports them as unproven until a run reaches them.
 * Runs ignore it.
 */
export interface WriteDeclaration {
  readonly confirmation: "message" | "readback" | "unverifiable";
  readonly commits?: readonly string[];
  readonly commitsUnproven?: readonly string[];
}

/**
 * A commit mark's name: a short identifier, a letter then letters, digits, hyphens or underscores,
 * such as `place-order`, `place_order` or `placeOrder`, never a runtime value.
 */
export const commitMarkPattern = /^[A-Za-z][A-Za-z0-9_-]*$/;
export const commitMarkMaxLength = 48;

export interface Operation<Input, EncodedInput, Output, EncodedOutput, Error, Services> {
  readonly name: string;
  readonly input: Schema.Schema<Input, EncodedInput>;
  readonly output: Schema.Schema<Output, EncodedOutput>;
  readonly run: (input: Input) => Effect.Effect<Output, Error, Services>;
  /** Present on every write operation. */
  readonly write?: WriteDeclaration;
  /** The questions `ScriptInput.ask` may put to the caller during a run, by id. */
  readonly questions?: ScriptQuestionDeclarations;
}

/**
 * An operation. With a contract and an async function, it is a Kernel script: the function gets
 * `kernel`, `sessionId`, `input`, `ask`, `waitPastChallenge` and the typed errors,
 * and makes its own `kernel.browsers.playwright.execute` calls.
 */
export function defineOperation<
  Input,
  EncodedInput,
  Output,
  EncodedOutput,
  const Questions extends ScriptQuestionDeclarations = Record<never, never>,
>(
  contract: {
    readonly name?: string;
    readonly input: Schema.Schema<Input, EncodedInput>;
    readonly output: Schema.Schema<Output, EncodedOutput>;
    /** The questions `ask` may put to the caller during a run, by id, with type and prompt. */
    readonly questions?: Questions;
    /** Present on every write script: how it confirms, recorded with `verified`. */
    readonly write?: WriteDeclaration;
  },
  run: (context: KernelOperationContext<Input, Questions>) => Promise<Output>,
): KernelOperation<Input, EncodedInput, Output, EncodedOutput>;
export function defineOperation<Input, EncodedInput, Output, EncodedOutput, Error, Services>(
  operation: Operation<Input, EncodedInput, Output, EncodedOutput, Error, Services>,
): Operation<Input, EncodedInput, Output, EncodedOutput, Error, Services>;
export function defineOperation<Input, EncodedInput, Output, EncodedOutput, Error, Services>(
  operation:
    | Operation<Input, EncodedInput, Output, EncodedOutput, Error, Services>
    | {
        readonly name?: string;
        readonly input: Schema.Schema<Input, EncodedInput>;
        readonly output: Schema.Schema<Output, EncodedOutput>;
        readonly questions?: ScriptQuestionDeclarations;
        readonly write?: WriteDeclaration;
      },
  run?: (context: KernelOperationContext<Input>) => Promise<Output>,
):
  | Operation<Input, EncodedInput, Output, EncodedOutput, Error, Services>
  | KernelOperation<Input, EncodedInput, Output, EncodedOutput> {
  if (run === undefined) {
    if (!("run" in operation)) throw new TypeError("An operation needs a run function");
    return operation;
  }
  // A tool published while identity checks existed may still pass login hooks here; they are
  // dropped, since the host signs in and checks no identity.
  return {
    kind: "kernel",
    name: operation.name ?? "operation",
    input: operation.input,
    output: operation.output,
    ...(operation.questions === undefined ? {} : { questions: operation.questions }),
    ...(operation.write === undefined ? {} : { write: operation.write }),
    run,
  };
}

/** The caller's input refusal a script throws, `errors.InvalidInput` from `opengpt-browser-engine/runtime`. */
type InputRefusal = InstanceType<typeof operationErrors.InvalidInput>;

/**
 * Whether a thrown value is the input refusal. It is matched by shape, not by class, so a refusal
 * from another copy of the runtime, such as one a tool bundles, matches too: an `Error` tagged
 * `InvalidInput` without the `operation` and `issues` that the runner's own schema `InvalidInput`
 * carries.
 */
const isInputRefusal = (value: unknown): value is InputRefusal =>
  value instanceof Error &&
  Reflect.get(value, "_tag") === "InvalidInput" &&
  !("operation" in value) &&
  !("issues" in value);

/** The `$id` Effect gives an empty struct, which it writes as TypeScript's `{}` type. */
const emptyStructId = "/schemas/%7B%7D";

const isJsonObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const withEmptyObjects = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(withEmptyObjects)
    : isJsonObject(value)
      ? withEmptyObjectsIn(value)
      : value;

const withEmptyObjectsIn = (
  node: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> =>
  node["$id"] === emptyStructId
    ? {
        ...Object.fromEntries(
          Object.entries(node).filter(([key]) => key !== "$id" && key !== "anyOf"),
        ),
        type: "object",
        required: [],
        properties: {},
        additionalProperties: false,
      }
    : Object.fromEntries(
        Object.entries(node).map(([key, child]) => [key, withEmptyObjects(child)]),
      );

/**
 * The JSON Schema an operation publishes for its input or output. Effect writes an empty struct
 * as TypeScript's `{}` type (any object or array), which admits arrays and is no tool input
 * schema. A no-input operation takes the empty object, written the way Effect writes every other
 * struct; annotations such as a description are kept.
 */
/**
 * An optional input field that defaults to `value`: a caller may leave it out, and the run then
 * gets `value`. Its published schema shows `value` as its `default`, which `Schema.optionalWith`'s
 * own default does not. Use it for a choice the build's request or the owner's answer settled as
 * how the tool behaves, such as a sort order, so callers may vary it and need not send it.
 */
export const defaultedInput = <A, I, R>(schema: Schema.Schema<A, I, R>, value: NoInfer<A>) =>
  Schema.optionalWith(schema.annotations({ default: value }), {
    default: () => value,
    exact: true,
  });

export const contractJsonSchema = <A, I, R>(schema: Schema.Schema<A, I, R>) =>
  withEmptyObjectsIn({ ...JSONSchema.make(schema) });

export const executeOperation = <Input, EncodedInput, Output, EncodedOutput, Error, Services>(
  operation: Operation<Input, EncodedInput, Output, EncodedOutput, Error, Services>,
  rawInput: unknown,
  /** `list`: set by a host that signs list cursors, as `withListHost` takes it. */
  options: { readonly list?: ListHost } = {},
): Effect.Effect<
  Output,
  | Error
  | InvalidInput
  | InputRefusal
  | InvalidOutput
  | DeadlineExceeded
  | CaptureUnavailable
  | EventUnavailable
  | WebsiteAuthenticationFailed,
  Services | ExecutionContext | Scope.Scope
> =>
  Effect.gen(function* () {
    const context = yield* ExecutionContext;
    // Declared first, so every exit reports which commit steps were never reached.
    const declared: unknown = operation.write?.commits;
    yield* context.journal.declareCommits(
      Array.isArray(declared) ? declared.filter((name) => typeof name === "string") : [],
    );
    // Every rejected path, not only the first, so one correction can fix them all.
    const input = yield* Schema.decodeUnknown(operation.input, { errors: "all" })(rawInput).pipe(
      Effect.mapError(
        (error) =>
          new InvalidInput({
            operation: operation.name,
            issues: inputIssues(operation.input, error),
          }),
      ),
    );
    const remainingMs = context.deadline.remainingMs();
    if (remainingMs <= 0) {
      return yield* new DeadlineExceeded({ phase: "execution", dispatch: "not_sent" });
    }
    return yield* Effect.gen(function* () {
      yield* Effect.acquireRelease(context.capture.start, () => finishCaptureAsEvidence(context));
      yield* context.events.emit("operation.started", { operation: operation.name });
      // A write declared unverifiable has nothing to confirm, so code that records a
      // confirmation, or marks itself verified, contradicts its declaration and fails.
      const journal: EffectJournal =
        operation.write?.confirmation === "unverifiable"
          ? {
              ...context.journal,
              confirmed: (recorded) =>
                Effect.fail(new WriteConfirmationRefused({ declared: "unverifiable", recorded })),
              verified: Effect.fail(
                new WriteConfirmationRefused({ declared: "unverifiable", recorded: "readback" }),
              ),
            }
          : context.journal;
      const runInput = options.list === undefined ? input : withListHost(input, options.list);
      const output = yield* Effect.suspend(() => operation.run(runInput)).pipe(
        // A runtime helper the run calls outside an Effect, such as `startList` refusing its
        // cursor, throws the caller's input refusal: the run fails with it, as a Kernel script's
        // does, rather than dying. Only a cause that is that one defect alone becomes the failure,
        // so a finalizer's or a concurrent fiber's error is never dropped.
        Effect.catchSomeCause((cause) =>
          cause._tag === "Die" && isInputRefusal(cause.defect)
            ? Option.some(Effect.fail(cause.defect))
            : Option.none(),
        ),
        Effect.provideService(ExecutionContext, { ...context, journal }),
      );
      const validated = yield* Schema.validate(operation.output)(output).pipe(
        Effect.mapError(
          (error) => new InvalidOutput({ operation: operation.name, cause: error, output }),
        ),
      );
      yield* context.events.emit("operation.output_validated", { operation: operation.name });
      return validated;
    }).pipe(
      Effect.raceFirst(
        context.deadline.awaitExpiry.pipe(
          Effect.zipRight(
            Effect.fail(new DeadlineExceeded({ phase: "execution", dispatch: "unknown" })),
          ),
        ),
      ),
    );
  });
