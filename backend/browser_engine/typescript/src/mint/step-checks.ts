import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Effect, Option, Schema } from "effect";
import { failureDetail } from "../runtime/failure-detail.js";
import { type ExecutionRequest, MintFailure, type MintRequest } from "./contracts.js";

/**
 * The checks a host runs on one submitted step before Guardian reviews it, and the read/write
 * state they read: which input the step runs, whether a write build's session admits it, and
 * whether a read build may run its example again or become a write. Each answers from facts the host passes in.
 */

/** A host's refusal of a step, which runs nothing. */
interface Refusal {
  readonly supported: false;
  readonly reason: string;
}
const refused = (reason: string): Refusal => ({ supported: false, reason });

/** Why an agent-chosen test input that is not JSON text never runs. */
export const testInputNotJson =
  "testInput must be the tool's input as JSON text. Nothing was executed.";
const JsonText = Schema.parseJson();

/**
 * Preflight's refusal of a step's `testInput`, if any: an input the agent chose runs only as a
 * read's live test (purpose test, target liveBrowser), as JSON text, on the Playwright or the HTTP
 * version alike. A write never runs one: its act session is the one run that proves it. A read
 * signed out runs as many as it needs. A signed-in read runs a few, only
 * on a host that supports signed-in live tests (`signedInTests`, beside
 * `LiveTestHost.signedInBatches`): the harness holds it to `signedInTestInputLimit` distinct
 * inputs, counted with its live_tests batches. Otherwise a signed-in read runs none. The host
 * passes the build's state as it is now; a host that does not say the read is signed out is
 * treated as signed in.
 */
export const preflightTestInput = (
  submitted: ExecutionRequest,
  scope: {
    readonly buildEffect: MintRequest["effect"] | undefined;
    /** Whether the read signed in. `false`, a read signed out, runs inputs the agent chose. */
    readonly signedIn?: boolean;
    /**
     * The host runs a signed-in read's live tests on the build's own signed-in browser and
     * declares `LiveTestHost.signedInBatches`, so a signed-in read's chosen inputs reach the
     * harness's bound. Absent, a signed-in read runs none.
     */
    readonly signedInTests?: boolean;
    /**
     * @deprecated Ignored: the harness counts a signed-in read's inputs, and no count limits a
     * read signed out. Kept so existing callers compile; it will be removed.
     */
    readonly executionHistory?: readonly {
      readonly input?: "agent_chosen" | "agent_chosen_batch";
      readonly entrypoint?: string;
    }[];
  },
): Refusal | undefined => {
  if (submitted.testInput === undefined) return undefined;
  if (submitted.purpose !== "test" || submitted.target !== "liveBrowser")
    return refused(
      "testInput is only for a read's live test: purpose test, target liveBrowser. An example or a write's act step runs the caller's input (or exampleInput when that input is empty), and an offline test and every other purpose run the caller's input. Nothing was executed.",
    );
  if (scope.buildEffect !== "read")
    return refused(
      "A write build never runs a live test or an input you chose; its session runs the caller's input, or, when that input is empty, the exampleInput that the first act step to pass one fixed. Nothing was executed.",
    );
  if (Option.isNone(Schema.decodeUnknownOption(JsonText)(submitted.testInput)))
    return refused(testInputNotJson);
  if (scope.signedIn === false || scope.signedInTests === true) return undefined;
  return refused(
    `This host runs live tests on an input you chose only for a read signed out. ${scope.signedIn === true ? "This read signed in, so it" : "This host does not say this read is signed out, so it"} proves the tool with its example alone: run the example again after a fix, and check src/tool-http.mjs once against the example's input (omit testInput). Nothing was executed.`,
  );
};

type InputObject = Readonly<Record<string, unknown>>;
const ExampleInput = Schema.parseJson(Schema.Record({ key: Schema.String, value: Schema.Unknown }));
/**
 * The input a step runs in place of the caller's empty one: the agent's `exampleInput`, a JSON
 * object it wrote from the request and the owner's answers. A read's example runs it, and so does
 * a write's act session from the step that first passes it. Undefined when the step carries
 * none, or text that is not a JSON object, which preflight refuses.
 */
const intentDerivedInput = (submitted: ExecutionRequest): InputObject | undefined =>
  submitted.exampleInput === undefined
    ? undefined
    : Option.getOrUndefined(Schema.decodeUnknownOption(ExampleInput)(submitted.exampleInput));

/** The write session the `exampleInput` rule reads: the input it runs, once a step fixed one. */
interface SessionInput {
  readonly input: InputObject | undefined;
}

/** The build an `exampleInput` would run in. */
interface ExampleInputScope {
  readonly buildEffect: MintRequest["effect"] | undefined;
  readonly callerInput: unknown;
  /**
   * Set by a host while it repairs a published tool, which runs on its failing case's own input.
   * The local host never repairs one, so it never sets it.
   */
  readonly maintenance?: boolean;
}

/** Why this purpose, build or caller input takes no `exampleInput`, if it takes none. */
const exampleInputPlaceRefusal = (
  purpose: ExecutionRequest["purpose"],
  scope: ExampleInputScope,
) => {
  const act = purpose === "act";
  if (purpose !== "example" && !act)
    return "exampleInput is valid only on a read's example or a write's act step.";
  if (scope.maintenance === true)
    return "exampleInput is not for maintenance, which repairs the tool on its failing case's own input.";
  if (scope.buildEffect !== (act ? "write" : "read"))
    return act
      ? "exampleInput is valid on act steps only in a write build."
      : "A write build passes exampleInput on its act steps, never on an example.";
  const { callerInput } = scope;
  const empty =
    typeof callerInput === "object" &&
    callerInput !== null &&
    !Array.isArray(callerInput) &&
    Object.keys(callerInput).length === 0;
  return empty
    ? undefined
    : `The caller supplied input, and the ${act ? "session" : "example"} runs it as it is.`;
};

/** Why an act step's `exampleInput` differs from the one input its session runs, if it does. */
const sessionInputRefusal = (decoded: InputObject, session: SessionInput) =>
  session.input !== undefined && !isDeepStrictEqual(decoded, session.input)
    ? "This write session already runs the exampleInput an earlier act step passed. Repeat it unchanged or omit it."
    : undefined;

/**
 * Preflight's refusal of a step's `exampleInput`, if any: the agent's reading of the request runs
 * only where the caller gave it nothing to run, as a read's example or a write's act session. A
 * session runs one input: the first act step that passes it fixes it, whichever step that is, and
 * a later step repeats it unchanged or omits it. Act steps before it run the caller's empty input.
 */
export const exampleInputRefusal = (
  submitted: ExecutionRequest,
  scope: ExampleInputScope & { readonly writeSession: SessionInput },
): Refusal | undefined => {
  if (submitted.exampleInput === undefined) return undefined;
  const decoded = intentDerivedInput(submitted);
  const refusal =
    exampleInputPlaceRefusal(submitted.purpose, scope) ??
    (decoded === undefined
      ? "exampleInput must be JSON text of the tool's input object."
      : submitted.purpose === "act"
        ? sessionInputRefusal(decoded, scope.writeSession)
        : undefined);
  return refusal === undefined
    ? undefined
    : refused(`${refusal} Correct or remove exampleInput and execute again. Nothing was executed.`);
};

/**
 * The input a step runs, with its mark for Guardian and the history: a read's live test on an
 * input the agent chose is `agent_chosen`; a read's example, or a write's act step, on the agent's
 * reading of an empty caller input is `intent_derived`, and an act step that omits it runs the
 * one its session fixed, if an earlier step fixed one; every other step runs the caller's input
 * unmarked. Preflight already refused a misplaced input.
 */
export const stepInput = (
  submitted: ExecutionRequest,
  scope: { readonly callerInput: unknown; readonly sessionInput: InputObject | undefined },
): Effect.Effect<
  | { readonly input: unknown; readonly mark?: "agent_chosen" }
  | { readonly input: InputObject; readonly mark: "intent_derived" },
  MintFailure
> => {
  if (submitted.testInput !== undefined)
    return Schema.decodeUnknown(JsonText)(submitted.testInput).pipe(
      Effect.map((input) => ({ input, mark: "agent_chosen" as const })),
      Effect.mapError(
        (error) =>
          new MintFailure({
            code: "InvalidRequest",
            failureDetail: failureDetail("mint_host_dependency_failed", {
              operation: "stepInput",
              error,
              context: { reason: testInputNotJson },
            }),
          }),
      ),
    );
  const derived =
    submitted.purpose === "example"
      ? intentDerivedInput(submitted)
      : submitted.purpose === "act"
        ? (scope.sessionInput ?? intentDerivedInput(submitted))
        : undefined;
  return Effect.succeed(
    derived === undefined
      ? { input: scope.callerInput }
      : { input: derived, mark: "intent_derived" as const },
  );
};

/** The sha256 digest of a set of source files, whatever order they come in. */
export const sourceDigest = (files: ReadonlyMap<string, string>) =>
  createHash("sha256")
    .update(JSON.stringify([...files].sort(([left], [right]) => left.localeCompare(right))))
    .digest("hex");

/**
 * The sha256 digest of what a set of source files holds, without their paths, so the same step
 * copied under another name has the same digest.
 */
export const contentDigest = (files: ReadonlyMap<string, string>) =>
  createHash("sha256")
    .update(JSON.stringify([...files.values()].sort()))
    .digest("hex");

/** Why a write build refuses this step now; undefined when it may run. */
export const writeSessionBoundary = (
  submitted: ExecutionRequest,
  scope: {
    readonly buildEffect: MintRequest["effect"] | undefined;
    readonly writeSessionStarted: boolean;
  },
): string | undefined => {
  if (submitted.purpose === "act")
    return scope.buildEffect === "write" && submitted.target === "liveBrowser"
      ? undefined
      : "Purpose act is a live step (target liveBrowser) of a write build's one write session. A read explores, then runs its example.";
  if (scope.buildEffect !== "write" || submitted.target !== "liveBrowser") return undefined;
  if (submitted.purpose === "example" || submitted.purpose === "test")
    return "A write build performs its action once, through purpose act steps, never as a live example or a live test: its act session is the one run that proves it. Read .agents/writes/SKILL.md.";
  if (submitted.purpose === "explore" && scope.writeSessionStarted)
    return "This write build's session has started, so live exploration is over. Continue with the next act step on the page as it is.";
  return undefined;
};

/** A read build that has not claimed its example may run its read example again. */
export const repeatableReadFor = (
  buildEffect: MintRequest["effect"] | undefined,
  exampleClaimed: boolean,
) => buildEffect === "read" && !exampleClaimed;
