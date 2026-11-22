import { createHash } from "node:crypto";
import { Ajv } from "@modelcontextprotocol/server/validators/ajv";
import { Clock, Effect, Either, Schema } from "effect";
import { outputCheckMeaning, outputChecks, type OutputCheck } from "../runtime/output-lint.js";

/**
 * Live tests of a read: the cases the minting agent designs in `test/cases.json`, each case's
 * verdict, and the record the publication review reads. Pure, except `runLiveTestCase`, which a
 * host calls once per case.
 *
 * The agent designs the cases from what it saw on the site, with real values the site offers,
 * and says what each one establishes. The host runs a batch after one Guardian review, each case
 * on a fresh page that keeps its browser's site data, in parallel browsers where the host has
 * them, and the agent sees every result. Each case run says whether it started warm or cold (see
 * `LiveTestStart`).
 * The publication review reads the record and judges the cases against what the tool claims. The
 * rules here that hold publication back are `liveTestsShortfall`: a version whose cases mostly
 * fail on the source it publishes is not sent to review at all; and, on a host that asks for it,
 * `failingLiveTestCases`: no review starts while any of its counted cases fails there.
 *
 * The same cases run on both versions of a read: the Playwright version (`src/tool.mjs`) and the
 * HTTP version (`src/tool-http.mjs`). Each version keeps its own result for each case, so a batch
 * on one never replaces or stales the other's.
 */

/** Where the agent writes its cases. */
export const liveTestCasesPath = "test/cases.json";
/** Where the host writes the record of its live tests for the publication review. */
export const liveTestsEvidencePath = "publication/tests.json";
/** The most cases one batch runs: a payload bound, not a limit on testing. */
export const maximumBatchCases = 50;
/**
 * The most distinct inputs a signed-in read runs live tests on in one build or repair, beyond its
 * example, chosen as the testing skill says: its combined case first, then the cases that cover the
 * most, such as one made-up key for an input that takes a record's own key. Running a counted input
 * again, after a fix or on the HTTP version, is free. A read signed out has no such limit.
 */
export const signedInTestInputLimit = 4;

/**
 * A test input's identity for the signed-in limit: its JSON with object keys sorted, so the same
 * input written in another key order is the same input. Array order counts.
 */
export const testInputKey = (input: unknown): string => canonical(input);

/**
 * The distinct inputs among `inputs`, as keys, that `counted` does not hold yet, in their first
 * order. A batch that names one input in several cases counts it once.
 */
export const uncountedTestInputs = (
  counted: readonly string[],
  inputs: readonly unknown[],
): readonly string[] =>
  [...new Set(inputs.map(testInputKey))].filter((key) => !counted.includes(key));

/**
 * Why a signed-in read may not run live tests on `inputs` now, or undefined when it may: it has
 * already run `counted` distinct inputs, and these would take it past `signedInTestInputLimit`.
 */
export const signedInTestInputRefusal = (
  counted: readonly string[],
  inputs: readonly unknown[],
): string | undefined => {
  const added = uncountedTestInputs(counted, inputs).length;
  if (added === 0 || counted.length + added <= signedInTestInputLimit) return undefined;
  const left = Math.max(0, signedInTestInputLimit - counted.length);
  return `A signed-in read runs live tests on at most ${signedInTestInputLimit} distinct inputs in a build or repair, beyond its example, as the testing skill says. It has run ${counted.length}, and this would add ${added}${left === 0 ? "" : `; ${left} more may run`}. Running an input it already ran again, after a fix or on src/tool-http.mjs, is free. Merge the inputs into the cases already run, or list the rest under notTested and in coverage. Nothing was executed.`;
};

/** Which version of a read a case ran on. */
export type LiveTestVersion = "playwright" | "http";
/**
 * The version an entrypoint is: `http` for a `*-http.mjs` file, else `playwright`. A record from
 * an older release names no entrypoint, and is the Playwright version's.
 */
export const liveTestVersion = (entrypoint: string | undefined): LiveTestVersion =>
  entrypoint?.endsWith("-http.mjs") === true ? "http" : "playwright";

type Json = Readonly<Record<string, unknown>>;
type Input = Readonly<Record<string, unknown>>;

const CaseId = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u));
const Text = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(600));

/** What a case expects the tool to do. */
export const LiveTestExpectation = Schema.Literal("result", "empty", "invalid_input", "error");
export type LiveTestExpectation = typeof LiveTestExpectation.Type;

/** One case the agent designed. */
export const LiveTestCase = Schema.Struct({
  id: CaseId,
  /** What the case establishes, such as "a second store whose results page has no pickup column". */
  purpose: Text,
  input: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  expect: LiveTestExpectation,
  /** Run page 1, then the next page through the cursor page 1 returned. */
  next_page: Schema.optionalWith(Schema.Boolean, { exact: true }),
  /**
   * The case is the tool's no-match case although it expects a result: its input matches nothing,
   * and the tool, a count or total, honestly answers it with 0. Like `purpose`, it describes the
   * case, so it leaves the case's digest, and its result, unchanged.
   */
  noMatch: Schema.optionalWith(Schema.Boolean, { exact: true }),
});
export type LiveTestCase = typeof LiveTestCase.Type;

/** Something the tool claims that the agent chose not to test, and why. */
export const LiveTestNotTested = Schema.Struct({ what: Text, reason: Text });
export type LiveTestNotTested = typeof LiveTestNotTested.Type;

export const LiveTestCasesFile = Schema.Struct({
  cases: Schema.Array(LiveTestCase).pipe(Schema.maxItems(200)),
  notTested: Schema.optionalWith(Schema.Array(LiveTestNotTested).pipe(Schema.maxItems(100)), {
    exact: true,
  }),
});
export type LiveTestCasesFile = typeof LiveTestCasesFile.Type;

/** The agent's cases file, or why it cannot be used. */
export const decodeCasesFile = (
  text: string | undefined,
): Either.Either<LiveTestCasesFile, string> => {
  if (text === undefined) return Either.right({ cases: [] });
  const decoded = Schema.decodeUnknownEither(Schema.parseJson(LiveTestCasesFile))(text, {
    errors: "first",
  });
  if (Either.isLeft(decoded))
    return Either.left(
      `${liveTestCasesPath} is not a valid cases file: ${decoded.left.message.slice(0, 600)}`,
    );
  const seen = new Set<string>();
  for (const { id } of decoded.right.cases) {
    if (seen.has(id)) return Either.left(`${liveTestCasesPath} lists case id ${id} twice.`);
    seen.add(id);
  }
  return Either.right(decoded.right);
};

// ---------------------------------------------------------------------------------------------
// What the runner and the verdicts read from the tool's schemas: its cursor and its list.

/** The input field that takes a cursor and the output field that returns it. */
export interface CursorPair {
  readonly inputField: string;
  readonly outputField: string;
}

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A schema with a local `$ref` replaced by its definition, siblings kept over it. */
const resolved = (schema: unknown, root: Json): Json => {
  if (!isRecord(schema)) return {};
  const reference = schema["$ref"];
  if (typeof reference !== "string" || !reference.startsWith("#/")) return schema;
  const target = reference
    .slice(2)
    .split("/")
    .reduce<unknown>((node, part) => (isRecord(node) ? node[part] : undefined), root);
  const { $ref: _, ...siblings } = schema;
  return { ...resolved(target, root), ...siblings };
};

/** The non-null branches of a schema; a single one for a schema that is not a union. */
const branchesOf = (schema: Json, root: Json): readonly Json[] => {
  const union = schema["anyOf"] ?? schema["oneOf"];
  if (!Array.isArray(union)) return [schema];
  return union
    .map((branch) => resolved(branch, root))
    .flatMap((branch) => branchesOf(branch, root))
    .filter((branch) => branch["type"] !== "null");
};

/** Whether a schema allows null: by its type, a union branch that does, or `nullable`. */
const allowsNull = (schema: Json, root: Json): boolean => {
  const type = schema["type"];
  if (type === "null" || (Array.isArray(type) && type.includes("null")) || schema["nullable"] === true)
    return true;
  const union = schema["anyOf"] ?? schema["oneOf"];
  return Array.isArray(union) && union.some((branch) => allowsNull(resolved(branch, root), root));
};

const typeOf = (branch: Json) => {
  const type = branch["type"];
  return typeof type === "string"
    ? type
    : Array.isArray(type)
      ? type.find((entry) => entry !== "null")
      : undefined;
};

interface Field {
  readonly name: string;
  readonly required: boolean;
  readonly types: readonly string[];
  /** An array whose items are objects, or not described. */
  readonly listOfRecords: boolean;
  readonly nullable: boolean;
}

/** An array branch whose items are objects, or say nothing about their type. */
const holdsRecords = (branch: Json, root: Json) => {
  if (typeOf(branch) !== "array") return false;
  if (!isRecord(branch["items"])) return true;
  const items = branchesOf(resolved(branch["items"], root), root);
  return items.some(
    (item) => typeOf(item) === "object" || isRecord(item["properties"]) || typeOf(item) === undefined,
  );
};

/** An object schema's properties, its local references resolved. */
const objectFields = (raw: unknown): readonly Field[] => {
  if (!isRecord(raw)) return [];
  const root = raw;
  const schema = branchesOf(resolved(raw, root), root).find((branch) =>
    isRecord(branch["properties"]),
  );
  const properties = schema?.["properties"];
  if (schema === undefined || !isRecord(properties)) return [];
  const required = new Set(
    Array.isArray(schema["required"])
      ? schema["required"].filter((name) => typeof name === "string")
      : [],
  );
  return Object.entries(properties).map(([name, property]) => {
    const field = resolved(property, root);
    const branches = branchesOf(field, root);
    return {
      name,
      required: required.has(name),
      types: branches.map((branch) => typeOf(branch) ?? "any"),
      listOfRecords: branches.some((branch) => holdsRecords(branch, root)),
      nullable: allowsNull(field, root),
    };
  });
};

/** A field whose every type is a string, the only type the host's list cursor takes. */
const stringField = (field: Field) =>
  field.types.length > 0 && field.types.every((type) => type === "string");

/**
 * The cursor a paged list takes and returns: the runtime's `cursor` input and `next_cursor` output
 * (`listInputFields` and `listOutputFields`), both strings. Tools never make or read a cursor of
 * their own, so a continuation under another name, such as `page_token`, or of another type is
 * never read as one, and neither is a boolean such as `has_next_page`.
 */
export const cursorPairOf = (inputSchema: unknown, outputSchema: unknown): CursorPair | undefined => {
  const input = objectFields(inputSchema).find(
    (field) => field.name === "cursor" && stringField(field),
  );
  const output = objectFields(outputSchema).find(
    (field) => field.name === "next_cursor" && stringField(field),
  );
  return input === undefined || output === undefined
    ? undefined
    : { inputField: input.name, outputField: output.name };
};

const freeTextName = /^(?:q|query|search|search_?term|keywords?|terms?|text)$/iu;
const recordName =
  /(?:^|_)(?:url|link|href|id|sku|slug|asin|listing|product|item|record|code|handle)(?:$|_)/iu;
/** An input that picks where to shop, such as `store_id`, never a record. */
const selectorName =
  /(?:^|_)(?:retailer|store|seller|merchant|vendor|marketplace|market|region|shop|warehouse|branch)(?:$|_)/iu;
/** What a list's results usually sit under. */
const listName = /^(?:results?|items|products|listings?|hits|entries|records|rows|matches|data|list)$/iu;
/** Words split from a name such as `productUrl` or `store_id`. */
const words = (name: string) => name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();

/** An input that names one record, such as a product URL, so its read is a details read. */
const isRecordInput = (field: Field) =>
  recordName.test(words(field.name)) &&
  !selectorName.test(words(field.name)) &&
  !freeTextName.test(field.name);

/** Where a list read's results sit: `field` of the output, or the output itself when absent. */
export interface PrimaryList {
  readonly field?: string;
  /** The output schema allows null at `field`. */
  readonly nullable?: true;
  /** The output's other declared fields, set with `nullable`: what a null list's record is judged by. */
  readonly others?: readonly string[];
}

/**
 * The list a read returns, judged by its shape, or undefined for a details read. An output that
 * is an array is the list. Otherwise the list is an array of records beside the cursor, or, for a
 * tool no input of which names a record, the array named like results, or its only array of
 * records. A details record keeps its images, variants or reviews as values, never as its list.
 */
export const primaryListOf = (inputSchema: unknown, outputSchema: unknown): PrimaryList | undefined => {
  if (isRecord(outputSchema)) {
    const root = resolved(outputSchema, outputSchema);
    if (branchesOf(root, outputSchema).some((branch) => typeOf(branch) === "array")) return {};
  }
  const fields = objectFields(outputSchema);
  const at = (list: Field): PrimaryList =>
    list.nullable
      ? {
          field: list.name,
          nullable: true,
          others: fields.filter((field) => field.name !== list.name).map((field) => field.name),
        }
      : { field: list.name };
  const arrays = fields.filter((field) => field.listOfRecords);
  const named = fields.find((field) => field.types.includes("array") && listName.test(field.name));
  const cursor = cursorPairOf(inputSchema, outputSchema);
  if (cursor !== undefined) {
    const list = named ?? arrays[0];
    return list === undefined ? undefined : at(list);
  }
  const inputs = objectFields(inputSchema);
  const details =
    inputs.some((field) => field.required && isRecordInput(field)) &&
    !inputs.some((field) => freeTextName.test(field.name));
  if (details) return undefined;
  if (named !== undefined) return at(named);
  return arrays.length === 1 && arrays[0] !== undefined ? at(arrays[0]) : undefined;
};

// ---------------------------------------------------------------------------------------------
// Running a case, and its verdict.

/** One case as a host runs it. */
export interface LiveTestBatchCase {
  readonly id: string;
  readonly input: Input;
  /** Present when the case also runs the next page. */
  readonly nextPage?: CursorPair;
}

/**
 * What Guardian's review of a batch reads in `submitted_call.input`: each case's id and input,
 * and, for a case that also runs its next page, the input field the host sets to page 1's cursor.
 */
export const batchReviewInput = (cases: readonly LiveTestBatchCase[]) => ({
  cases: cases.map((testCase) => ({
    id: testCase.id,
    input: testCase.input,
    ...(testCase.nextPage === undefined
      ? {}
      : { next_page: { cursorInput: testCase.nextPage.inputField } }),
  })),
});

export type LiveTestInconclusiveReason =
  /** The site challenged the browser and the host stopped the case. */
  | "challenge"
  /** The browser or the host failed, not the tool. */
  | "host"
  /** The batch's deadline came before the case could run. */
  | "deadline"
  /** The script asked a question, which nobody answers during a test. */
  | "asked"
  /** Page 1 returned no cursor, so there was no next page to run. */
  | "no_next_page"
  /**
   * The site blocked the browser's egress, such as an edge refusal of the page's own data call
   * or a bot vendor's block page, so the case tested nothing about the tool.
   */
  | "site_block";

/** What one run of a case's input showed. Outputs stay with the host until judged. */
export type LiveTestOutcome =
  | { readonly status: "completed"; readonly output: unknown }
  | {
      readonly status: "invalid_input";
      readonly message?: string;
      readonly field?: string;
      readonly available?: readonly string[];
    }
  | {
      readonly status: "failed";
      readonly errorClass: string;
      readonly message?: string;
      /** The authored source line that threw, such as `src/tool.mjs:88`. */
      readonly frame?: string;
    }
  | { readonly status: "inconclusive"; readonly reason: LiveTestInconclusiveReason };

/**
 * How a case's browser started. `cold`: the case ran first on a new browser with an empty profile,
 * as a caller the site remembers nothing about meets it. `warm`: it ran on a browser that kept the
 * site data earlier steps left, such as the build's own browser or a lane after its first case.
 */
export const LiveTestStart = Schema.Literal("warm", "cold");
export type LiveTestStart = typeof LiveTestStart.Type;

/** One case's runs, as a host returns them. */
export interface LiveTestCaseRun {
  readonly id: string;
  readonly outcome: LiveTestOutcome;
  /** The next page's run, for a `next_page` case whose page 1 completed. */
  readonly followUp?: LiveTestOutcome;
  readonly durationMs: number;
  /** Which of the batch's browsers ran it: 0 is the build's own. */
  readonly lane?: number;
  /** How its browser started; a host sets it on every case it ran. */
  readonly start?: LiveTestStart;
}

/** Runs one case and, for a `next_page` case, its next page, through a host's `run`. */
export const runLiveTestCase = <E, R>(
  testCase: LiveTestBatchCase,
  run: (input: Input) => Effect.Effect<LiveTestOutcome, E, R>,
): Effect.Effect<LiveTestCaseRun, E, R> =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const outcome = yield* run(testCase.input);
    const { nextPage } = testCase;
    let followUp: LiveTestOutcome | undefined;
    if (nextPage !== undefined && outcome.status === "completed") {
      const cursor = isRecord(outcome.output) ? outcome.output[nextPage.outputField] : undefined;
      followUp =
        cursor === undefined || cursor === null || cursor === ""
          ? { status: "inconclusive", reason: "no_next_page" }
          : yield* run({ ...testCase.input, [nextPage.inputField]: cursor });
    }
    const ended = yield* Clock.currentTimeMillis;
    return {
      id: testCase.id,
      outcome,
      ...(followUp === undefined ? {} : { followUp }),
      durationMs: ended - started,
    };
  });

export type LiveTestVerdict = "pass" | "fail" | "inconclusive";

export interface JudgedCase {
  readonly verdict: LiveTestVerdict;
  /** What the run did, in a few words: `results (12)`, `empty`, `InvalidInput`, `TimeoutError`. */
  readonly got: string;
  /** Why it failed or was inconclusive, or a note on a pass. */
  readonly detail?: string;
  readonly errorClass?: string;
  readonly message?: string;
  readonly frame?: string;
  readonly refusal?: { readonly field?: string; readonly available?: readonly string[] };
  /** The output the verdict judged, for an excerpt; absent when the run returned none. */
  readonly output?: unknown;
}

/** The lists an output holds: its own top-level arrays, or itself when it is one. */
const listsOf = (output: unknown): readonly (readonly unknown[])[] =>
  Array.isArray(output)
    ? [output]
    : isRecord(output)
      ? Object.values(output).filter((value): value is unknown[] => Array.isArray(value))
      : [];

const counted = (items: readonly unknown[]) =>
  items.length === 0
    ? { empty: true, got: "empty" }
    : { empty: false, got: `results (${items.length})` };

/** A value that says something: not null, an empty string or an empty list. */
const filled = (value: unknown) =>
  value !== null &&
  value !== undefined &&
  value !== "" &&
  !(Array.isArray(value) && value.length === 0);

interface Shape {
  readonly empty: boolean;
  readonly got: string;
  /** A record whose nullable list is null: a result, and also the no results an empty case expects. */
  readonly nullList?: true;
  /** What a result case's failure says in place of the default. */
  readonly detail?: string;
}

/**
 * Whether an output holds results: a list read's by its results list, a details read's by its
 * values, so a record whose images or variants happen to be empty is still a result. A list the
 * output schema allows to be null is judged, when null, by the record's other declared values.
 */
const resultShape = (output: unknown, list: PrimaryList | undefined): Shape => {
  if (output === null || output === undefined) return { empty: true, got: "no output" };
  if (list !== undefined) {
    const { field } = list;
    const items = field === undefined ? output : isRecord(output) ? output[field] : undefined;
    if (Array.isArray(items)) return counted(items);
    if (field === undefined || !isRecord(output) || items !== null)
      return { empty: true, got: field === undefined ? "no list" : `no ${field} list` };
    return list.nullable === true && (list.others ?? []).some((name) => filled(output[name]))
      ? { empty: false, got: `a result (no ${field})`, nullList: true }
      : {
          empty: true,
          got: `no ${field} list`,
          detail: `The tool returned a record whose ${field} is null. If the site lists no ${field} for this input, expect empty for this case, or choose an input the site lists ${field} for.`,
        };
  }
  if (Array.isArray(output)) return counted(output);
  if (isRecord(output))
    return Object.values(output).some(filled)
      ? { empty: false, got: "a result" }
      : { empty: true, got: "no values" };
  return { empty: false, got: "a result" };
};

/** A list read's rows in an output, or undefined when it holds no such list. */
const rowsOf = (output: unknown, list: PrimaryList): readonly unknown[] | undefined => {
  const items = list.field === undefined ? output : isRecord(output) ? output[list.field] : undefined;
  return Array.isArray(items) ? items : undefined;
};

/**
 * Whether a list's page two holds rows and every one of them was already on page one, as when the
 * tool ignored the cursor and read page one again. A page two with one new row moves on.
 */
const repeatsPageOne = (run: LiveTestCaseRun, list: PrimaryList | undefined) => {
  if (list === undefined || run.outcome.status !== "completed") return false;
  if (run.followUp?.status !== "completed") return false;
  const first = rowsOf(run.outcome.output, list);
  const second = rowsOf(run.followUp.output, list);
  if (first === undefined || second === undefined || second.length === 0) return false;
  const seen = new Set(first.map(canonical));
  return second.every((row) => seen.has(canonical(row)));
};

const inconclusiveDetail: Readonly<Record<LiveTestInconclusiveReason, string>> = {
  challenge: "The site challenged this browser; the host stopped the case. It does not count against the tool.",
  host: "The browser or the host failed, not the tool. Run the case again.",
  deadline: "The batch ran out of time before this case ran. Run it again.",
  asked: "The script asked a question, which nobody answers during a test. A read that needs an answer from its caller declares the question; run cases that do not need one.",
  no_next_page: "Page 1 returned no cursor, so the host could not run a next page. Use a query with more than one page of results, or fix how the tool returns its cursor.",
  site_block: "The site blocked this browser's network egress, by refusing the page's own data call or with a bot vendor's block page, so the case tested nothing about the tool. It is an egress problem, not a script failure: do not change the script for it. Run the case again later.",
};

/**
 * The failures a tool throws on purpose to refuse loudly, the only ones a case that expects
 * `error` passes on. Any other throw, an `OperationFailure` that wraps an unexpected exception
 * included, is a bug.
 */
const declaredRefusals: ReadonlySet<string> = new Set([
  "InputNotApplied",
  // An older runtime's name for the same refusal.
  "LocationNotApplied",
]);

/**
 * A case's verdict from its runs and what it expected. `list` is where a list read's results sit
 * (`primaryListOf`); undefined judges a details read by its values.
 */
export const judgeCase = (
  testCase: Pick<LiveTestCase, "expect">,
  run: LiveTestCaseRun,
  list: PrimaryList | undefined,
): JudgedCase => {
  const outcome =
    run.outcome.status === "completed" && run.followUp !== undefined ? run.followUp : run.outcome;
  const page = run.followUp !== undefined && outcome === run.followUp ? "Page 2: " : "";
  switch (outcome.status) {
    case "inconclusive":
      return {
        verdict: "inconclusive",
        got: outcome.reason,
        detail: `${page}${inconclusiveDetail[outcome.reason]}`,
      };
    case "completed": {
      const shape = resultShape(outcome.output, list);
      const base = { got: shape.got, output: outcome.output };
      if (testCase.expect === "result")
        return shape.empty
          ? {
              ...base,
              verdict: "fail",
              detail: `${page}${shape.detail ?? `Expected results, but the tool returned ${shape.got}.`}`,
            }
          : repeatsPageOne(run, list)
            ? {
                ...base,
                verdict: "fail",
                detail: `${page}Every row page 2 returned was already on page 1: the tool read page 1 again instead of the page the cursor names. Fix how the tool applies its cursor.`,
              }
            : { ...base, verdict: "pass" };
      if (testCase.expect === "empty")
        return shape.empty || shape.nullList === true
          ? { ...base, verdict: "pass" }
          : { ...base, verdict: "fail", detail: `${page}Expected no results, but the tool returned ${shape.got}.` };
      return {
        ...base,
        verdict: "fail",
        detail:
          testCase.expect === "invalid_input"
            ? `${page}Expected InvalidInput for a value the site does not offer, but the tool returned ${shape.got}. Never substitute another value.`
            : `${page}Expected a loud failure, but the tool returned ${shape.got}.`,
      };
    }
    case "invalid_input": {
      const refusal = {
        ...(outcome.field === undefined ? {} : { field: outcome.field }),
        ...(outcome.available === undefined ? {} : { available: outcome.available.slice(0, 20) }),
      };
      const base = {
        got: "InvalidInput",
        errorClass: "InvalidInput",
        ...(outcome.message === undefined ? {} : { message: outcome.message.slice(0, 600) }),
        ...(Object.keys(refusal).length === 0 ? {} : { refusal }),
      };
      if (testCase.expect === "invalid_input" || testCase.expect === "error")
        return {
          ...base,
          verdict: "pass",
          ...(outcome.available === undefined || outcome.available.length === 0
            ? { detail: "The refusal lists no choices (available). Where the page offers choices, list them." }
            : {}),
        };
      return {
        ...base,
        verdict: "fail",
        detail: `${page}The tool refused this input with InvalidInput. If the site offers this value, fix the code; never narrow the schema to pass.`,
      };
    }
    case "failed": {
      const base = {
        got: outcome.errorClass,
        errorClass: outcome.errorClass,
        ...(outcome.message === undefined ? {} : { message: outcome.message.slice(0, 600) }),
        ...(outcome.frame === undefined ? {} : { frame: outcome.frame }),
      };
      if (testCase.expect === "error" && declaredRefusals.has(outcome.errorClass))
        return { ...base, verdict: "pass" };
      const threw = `The tool threw ${outcome.errorClass}${outcome.frame === undefined ? "" : ` at ${outcome.frame}`}.`;
      return {
        ...base,
        verdict: "fail",
        detail:
          testCase.expect === "error"
            ? `${page}${threw} A case that expects error passes only on a declared refusal (${[...declaredRefusals].join(", ")}); any other throw is a bug in the tool. Fix the code at that line.`
            : `${page}${threw} Fix the code at that line.`,
      };
    }
  }
};

// ---------------------------------------------------------------------------------------------
// Results the harness keeps, and what the agent and the publication review read.

/** JSON with object keys sorted, so equal values have equal text. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    isRecord(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => (left < right ? -1 : 1)))
      : entry,
  );

/**
 * A digest of what a case runs and expects, so an edited case's earlier result is stale. Its
 * purpose is a description: rewording it leaves the result standing.
 */
export const caseDigest = (testCase: LiveTestCase) =>
  createHash("sha256")
    .update(canonical([testCase.input, testCase.expect, testCase.next_page === true]))
    .digest("hex")
    .slice(0, 16);

/** One output check finding on a case's output, as the shared output check reports it. */
export interface LiveTestOutputCheck {
  readonly path: string;
  readonly check: OutputCheck;
  readonly count: number;
  readonly blocking: boolean;
  /** One matched value, screened. */
  readonly sample?: string;
  readonly partial?: true;
}

export const LiveTestOutputChecks: Schema.Schema<readonly LiveTestOutputCheck[]> = Schema.Array(
  Schema.Struct({
    path: Schema.String,
    check: Schema.Literal(...outputChecks),
    count: Schema.NonNegativeInt,
    blocking: Schema.Boolean,
    sample: Schema.optionalWith(Schema.String, { exact: true }),
    partial: Schema.optionalWith(Schema.Literal(true), { exact: true }),
  }),
);

/** One case's latest result, as the harness keeps it across a takeover. */
export interface LiveTestRecord {
  readonly id: string;
  /**
   * The entrypoint the case ran, whose version (`liveTestVersion`) keeps this result apart from
   * the other version's. Absent in a record from an older release: the Playwright version's.
   */
  readonly entrypoint?: string;
  readonly caseDigest: string;
  /** The digest of the source it ran. */
  readonly sourceDigest: string;
  readonly verdict: LiveTestVerdict;
  readonly got: string;
  readonly detail?: string;
  readonly errorClass?: string;
  readonly message?: string;
  readonly frame?: string;
  readonly refusal?: { readonly field?: string; readonly available?: readonly string[] };
  /** A short screened excerpt of the output. */
  readonly excerpt?: string;
  /** The output check's findings on the output the verdict judged. */
  readonly outputChecks?: readonly LiveTestOutputCheck[];
  readonly durationMs: number;
  readonly lane?: number;
  readonly start?: LiveTestStart;
  /** The case as it ran, so a result outlives the case's removal or edit. */
  readonly input?: Input;
  readonly purpose?: string;
  readonly expect?: LiveTestExpectation;
  readonly nextPage?: true;
  readonly noMatch?: true;
  /** A failing result the minter replaced by changing the case; kept for the publication review. */
  readonly retired?: true;
  /** A retired failure whose case, unchanged, passed when run again on the same source. */
  readonly flaky?: true;
  /**
   * The case ran while the read was signed in. A signed-in read's publication record holds only
   * such results; ones from before its sign-in tested another session.
   */
  readonly signedIn?: true;
}

export const LiveTestRecord: Schema.Schema<LiveTestRecord> = Schema.Struct({
  id: Schema.String,
  entrypoint: Schema.optionalWith(Schema.String, { exact: true }),
  caseDigest: Schema.String,
  sourceDigest: Schema.String,
  verdict: Schema.Literal("pass", "fail", "inconclusive"),
  got: Schema.String,
  detail: Schema.optionalWith(Schema.String, { exact: true }),
  errorClass: Schema.optionalWith(Schema.String, { exact: true }),
  message: Schema.optionalWith(Schema.String, { exact: true }),
  frame: Schema.optionalWith(Schema.String, { exact: true }),
  refusal: Schema.optionalWith(
    Schema.Struct({
      field: Schema.optionalWith(Schema.String, { exact: true }),
      available: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
    }),
    { exact: true },
  ),
  excerpt: Schema.optionalWith(Schema.String, { exact: true }),
  outputChecks: Schema.optionalWith(LiveTestOutputChecks, { exact: true }),
  durationMs: Schema.NonNegativeInt,
  lane: Schema.optionalWith(Schema.NonNegativeInt, { exact: true }),
  start: Schema.optionalWith(LiveTestStart, { exact: true }),
  input: Schema.optionalWith(Schema.Record({ key: Schema.String, value: Schema.Unknown }), {
    exact: true,
  }),
  purpose: Schema.optionalWith(Schema.String, { exact: true }),
  expect: Schema.optionalWith(LiveTestExpectation, { exact: true }),
  nextPage: Schema.optionalWith(Schema.Literal(true), { exact: true }),
  noMatch: Schema.optionalWith(Schema.Literal(true), { exact: true }),
  retired: Schema.optionalWith(Schema.Literal(true), { exact: true }),
  flaky: Schema.optionalWith(Schema.Literal(true), { exact: true }),
  signedIn: Schema.optionalWith(Schema.Literal(true), { exact: true }),
});

/** The first few items of an output, as compact text, for an excerpt. */
export const outputExcerpt = (output: unknown, limit = 600): string | undefined => {
  if (output === undefined) return undefined;
  const lists = listsOf(output);
  const shown =
    Array.isArray(output)
      ? output.slice(0, 2)
      : isRecord(output) && lists.length > 0
        ? Object.fromEntries(
            Object.entries(output).map(([key, value]) => [
              key,
              Array.isArray(value) ? value.slice(0, 2) : value,
            ]),
          )
        : output;
  const text = JSON.stringify(shown) ?? "";
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
};

/** A case's status against the current source and the case as written now. */
export type CaseStatus = "not_run" | "stale" | LiveTestVerdict;

export const caseStatus = (
  testCase: LiveTestCase,
  record: LiveTestRecord | undefined,
  sourceDigest: string | undefined,
): CaseStatus => {
  if (record === undefined) return "not_run";
  if (record.caseDigest !== caseDigest(testCase) || record.sourceDigest !== sourceDigest)
    return "stale";
  return record.verdict;
};

/**
 * The cases in `file` a failure is pending on, for a host's reserved batch
 * (`LiveTestHost.reservedCaseTimeoutMs`): each case whose input, expectation and next page are a
 * failing result's of this version, its own latest or a retired one, as `excusedBy` matches a
 * retired failure, and that has not passed since on `sourceDigest`, the version's current source.
 * A case with such a failure on `sourceDigest` itself is left out until the source changes: a pass
 * on the source it failed on is flaky, and excuses nothing.
 */
export const pendingFailureCases = (
  file: LiveTestCasesFile,
  records: ReadonlyMap<string, LiveTestRecord>,
  replaced: readonly LiveTestRecord[],
  sourceDigest: string,
): readonly string[] => {
  const failing = [...records.values(), ...replaced].filter((record) => record.verdict === "fail");
  const failedHere = new Set(
    failing.filter((record) => record.sourceDigest === sourceDigest).map((record) => record.caseDigest),
  );
  const failed = new Set(
    failing.map((record) => record.caseDigest).filter((digest) => !failedHere.has(digest)),
  );
  return file.cases
    .filter(
      (testCase) =>
        failed.has(caseDigest(testCase)) &&
        caseStatus(testCase, records.get(testCase.id), sourceDigest) !== "pass",
    )
    .map((testCase) => testCase.id);
};

/** One case as the agent and the publication review read it. */
export const caseView = (
  testCase: LiveTestCase,
  record: LiveTestRecord | undefined,
  sourceDigest: string | undefined,
) => {
  const status = caseStatus(testCase, record, sourceDigest);
  return {
    id: testCase.id,
    purpose: testCase.purpose,
    expect: testCase.expect,
    ...(testCase.next_page === true ? { next_page: true } : {}),
    ...(testCase.noMatch === true ? { noMatch: true } : {}),
    status,
    ...(record === undefined
      ? {}
      : {
          ...(status === "stale"
            ? {
                lastVerdict: record.verdict,
                staleBecause:
                  record.caseDigest !== caseDigest(testCase)
                    ? "the case changed after it ran"
                    : "the source changed after it ran",
                ...(record.input === undefined ? {} : { lastInput: record.input }),
              }
            : {}),
          got: record.got,
          ...(record.detail === undefined ? {} : { detail: record.detail }),
          ...(record.errorClass === undefined ? {} : { errorClass: record.errorClass }),
          ...(record.message === undefined ? {} : { message: record.message }),
          ...(record.frame === undefined ? {} : { frame: record.frame }),
          ...(record.refusal === undefined ? {} : { refusal: record.refusal }),
          ...(record.excerpt === undefined ? {} : { excerpt: record.excerpt }),
          ...(record.outputChecks === undefined
            ? {}
            : {
                outputChecks: record.outputChecks.map((finding) => ({
                  ...finding,
                  meaning: outputCheckMeaning[finding.check],
                })),
              }),
          durationMs: record.durationMs,
          ...(record.lane === undefined ? {} : { lane: record.lane }),
          ...(record.start === undefined ? {} : { start: record.start }),
        }),
  };
};

/**
 * Where a published input schema bounds a value an input supplied, and by which rule: `path` is a
 * JSON pointer into the input, such as `/query`, and `keyword` the JSON Schema keyword it breaks,
 * such as `maxLength`. A property the schema does not take points at that property's own name.
 */
export interface OutsideSchema {
  readonly path: string;
  readonly keyword: string;
}

/** A JSON pointer segment for a property name. */
const pointerSegment = (name: string) => name.replaceAll("~", "~0").replaceAll("/", "~1");

/**
 * Keywords under which a subschema applies only on a condition, such as one branch of `anyOf`. An
 * error there, and the combinator's own, can stand for something the input lacks, such as a field
 * one branch requires, so it never shows the schema bounding a value the input supplied.
 */
const conditionalKeywords = new Set([
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "dependencies",
  "dependentSchemas",
]);
/** Keywords whose next schema path segment is a property or definition name, not a keyword. */
const namingKeywords = new Set(["properties", "patternProperties", "$defs", "definitions"]);

const underCondition = (schemaPath: string) => {
  const segments = schemaPath.split("/");
  return segments.some(
    (segment, index) =>
      conditionalKeywords.has(segment) && !namingKeywords.has(segments[index - 1] ?? ""),
  );
};

/**
 * A check of inputs against a tool's published input schema (`outsideSchema`), or undefined when
 * there is no schema or it cannot be compiled, which leaves every input inside it. It marks an
 * input only where an error points at a value the input supplied: a bound on that value, such as
 * `maxLength`, `pattern`, `enum`, `type` or `minimum`, or `additionalProperties` on a property it
 * gave. A field the schema newly requires, an error at the input's root, and one under a
 * conditional subschema hold whatever the supplied values are, so they mark nothing. Every error
 * is read, not only the first. It uses the classic (draft-07) Ajv engine the MCP SDK ships, with
 * formats unchecked, since a tool's own decoding does not check them; the SDK's server validator
 * reports only a message, so it cannot name the path.
 */
const publishedInputCheck = (
  inputSchema: unknown,
): ((input: unknown) => OutsideSchema | undefined) | undefined => {
  if (!isRecord(inputSchema)) return undefined;
  const compile = () => {
    try {
      return new Ajv({
        strict: false,
        allErrors: true,
        validateSchema: false,
        validateFormats: false,
        logger: false,
      }).compile(inputSchema);
    } catch {
      return undefined;
    }
  };
  const validate = compile();
  if (validate === undefined) return undefined;
  return (input) => {
    if (validate(input)) return undefined;
    for (const error of validate.errors ?? []) {
      if (underCondition(error.schemaPath)) continue;
      const params: Readonly<Record<string, unknown>> = error.params;
      const extra = params["additionalProperty"];
      if (error.keyword === "additionalProperties" && typeof extra === "string")
        return { path: `${error.instancePath}/${pointerSegment(extra)}`, keyword: error.keyword };
      // A bound's instancePath points at the value it judged, which the input supplied.
      if (error.instancePath !== "" && error.keyword !== "required")
        return { path: error.instancePath, keyword: error.keyword };
    }
    return undefined;
  };
};

/**
 * What a passing record's run returned, when the record alone fixes it: a refusal, by the error
 * class its verdict kept. A completed run's output is not kept, so it is undefined, and a completed
 * run's pass excuses only a case with the same expectation, though a record whose nullable list
 * is null passes both `result` and `empty` under `judgeCase`.
 */
const refusalOutcome = (record: LiveTestRecord): LiveTestOutcome | undefined => {
  if (record.errorClass === undefined) return undefined;
  // A failed run's InvalidInput throw never passes, so a passing record's InvalidInput is a refusal.
  return record.errorClass === "InvalidInput"
    ? { status: "invalid_input" }
    : { status: "failed", errorClass: record.errorClass };
};

/** Whether a passing record's recorded refusal would pass a case that expects `expectation`. */
const refusalSatisfies = (expectation: LiveTestExpectation, record: LiveTestRecord) => {
  const outcome = refusalOutcome(record);
  return (
    outcome !== undefined &&
    judgeCase({ expect: expectation }, { id: record.id, outcome, durationMs: 0 }, undefined)
      .verdict === "pass"
  );
};

/** A way a retired failure that still counts can stop counting. */
type ClearingWay = "changedExpectationBy" | "excusedBy" | "outsideSchema";

/**
 * The site's own answer for the input that a `changedExpectationBy` lead needs a capture of, by
 * the lead's expectation: its results, its no-results state or its own controls refusing it. A
 * lead marked `noMatch` expects a result, a count or total of zero, so it needs the site's
 * no-results state.
 */
type SiteAnswer = "results" | "no_results" | "refusal";

const siteAnswerFor = (lead: {
  readonly expect: LiveTestExpectation;
  readonly noMatch?: boolean;
}): SiteAnswer =>
  lead.expect === "result"
    ? lead.noMatch === true
      ? "no_results"
      : "results"
    : lead.expect === "empty"
      ? "no_results"
      : "refusal";

/**
 * The response statuses that show a site refusing an input itself, for its shape or size. Never
 * 401, 403, 404, 405 or 429, which answer access, a missing page, a method or a rate.
 */
const siteRefusalStatuses = [400, 413, 414, 422] as const;

/** What a capture of each site answer must show, for the record's `clearedBy` note. */
const siteAnswerCapture: Readonly<Record<SiteAnswer, string>> = {
  results:
    "the site's own results for this exact input: a page reached through the site's own controls or a URL they produce, that reads back the input as the site applied it and lists the site's results for it",
  no_results:
    "the site's own no-results state for this exact input: a page reached through the site's own controls or a URL they produce, that reads back the input as the site applied it",
  refusal:
    "the site's own controls refusing this exact input: its own validation message for it on its own form, or, where the captures hold the site's responses, a 400, 413, 414 or 422 response to the request its own form sent with it; never the request this tool made, and never a 401, 403, 404, 405 or 429, a 5xx or a timeout",
};

/**
 * How a retired failure that still counts can stop counting, for the record's `clearedBy`: the
 * ways open to it, the site answer its `changedExpectationBy` lead needs a capture of, and a note.
 * `outsideSchema` is a way only when the host read the version's input schema.
 */
const clearedBy = (
  record: LiveTestRecord,
  lead:
    | { readonly id: string; readonly expect: LiveTestExpectation; readonly noMatch?: boolean }
    | undefined,
  schemaRead: boolean,
) => {
  const ways: ClearingWay[] = [
    "changedExpectationBy",
    "excusedBy",
    ...(schemaRead ? ["outsideSchema" as const] : []),
  ];
  const others = [
    record.expect === undefined
      ? "a case of this input that passes after a source change, with the expectation this case had (excusedBy)"
      : `a case of this input that passes after a source change, with the answer this case expected (${record.expect})${record.expect === "error" ? " or a refusal that expectation accepts" : ""} (excusedBy)`,
    ...(schemaRead
      ? [
          "a bound in the published input schema on a value this input supplies, only where the site itself bounds that value (outsideSchema)",
        ]
      : []),
  ].join("; or ");
  if (lead === undefined)
    return {
      ways,
      note: `No passing case of this input expects another answer. Clears by ${others}; or a passing case of this input whose new expectation a capture shows the site giving: its own results, its own no-results state or its own controls refusing it (changedExpectationBy).`,
    };
  const siteAnswer = siteAnswerFor(lead);
  return {
    ways,
    siteAnswer,
    ...(siteAnswer === "refusal" ? { refusalStatuses: siteRefusalStatuses } : {}),
    note: `changedExpectationBy ${lead.id} clears it with a capture of ${siteAnswerCapture[siteAnswer]}; never a challenge, sign-in, blocked or loading page; named in ${lead.id}'s purpose or the coverage text. Otherwise ${others}.`,
  };
};

/**
 * Results the cases file no longer shows: a case the minter deleted, with its last result, and
 * a failing result the minter replaced by changing the case. `inputSchema` is the version's
 * published input schema, when the host could read it.
 */
const retiredViews = (
  file: LiveTestCasesFile,
  records: ReadonlyMap<string, LiveTestRecord>,
  replaced: readonly LiveTestRecord[],
  sourceDigest: string | undefined,
  inputSchema: unknown,
) => {
  const current = new Map(file.cases.map((testCase) => [testCase.id, caseDigest(testCase)]));
  const deleted = [...records.values()].filter((record) => !current.has(record.id));
  const changed = replaced.filter(
    (record) => record.flaky === true || current.get(record.id) !== record.caseDigest,
  );
  const outside = publishedInputCheck(inputSchema);
  // What a current case runs and expects, for the cases that pass on the published source.
  const runs = (input: unknown, expect: unknown, nextPage: boolean) =>
    canonical([input, expect, nextPage]);
  const passing = file.cases.flatMap((testCase) => {
    const record = records.get(testCase.id);
    return record !== undefined && caseStatus(testCase, record, sourceDigest) === "pass"
      ? [
          {
            id: testCase.id,
            runs: runs(testCase.input, testCase.expect, testCase.next_page === true),
            input: canonical([testCase.input, testCase.next_page === true]),
            expect: testCase.expect,
            noMatch: testCase.noMatch === true,
            record,
          },
        ]
      : [];
  });
  /**
   * A failure on earlier source that a case passing on the published source runs again with the
   * same input, and either the same expectation or a refusal that the failure's own expectation
   * accepts under `judgeCase`, such as an InvalidInput for a case that expected error. Never one
   * on the published source, which is flaky or unfixed.
   */
  const excusedBy = (record: LiveTestRecord) => {
    if (record.sourceDigest === sourceDigest || record.input === undefined) return undefined;
    const ran = runs(record.input, record.expect, record.nextPage === true);
    const same = passing.find((entry) => entry.runs === ran);
    if (same !== undefined || record.expect === undefined) return same?.id;
    const { expect: expectation } = record;
    const input = canonical([record.input, record.nextPage === true]);
    return passing.find(
      (entry) => entry.input === input && refusalSatisfies(expectation, entry.record),
    )?.id;
  };
  /**
   * A failure on any source that a case passing on the published source runs again with the same
   * input and another expectation. It is a lead, never an excuse by itself: the publication review
   * excuses the failure only when a capture shows the site's own answer for that input matching
   * the new expectation.
   */
  const changedExpectationBy = (record: LiveTestRecord) => {
    if (record.input === undefined || record.expect === undefined) return undefined;
    const input = canonical([record.input, record.nextPage === true]);
    return passing.find((entry) => entry.input === input && entry.expect !== record.expect);
  };
  return [
    ...deleted.map((record) => [record, "deleted from the cases file"] as const),
    ...changed.map(
      (record) =>
        [
          record,
          record.flaky === true
            ? "failed, then passed when run again unchanged on the same source: flaky"
            : current.has(record.id)
              ? "changed after it failed"
              : "changed after it failed, then deleted",
        ] as const,
    ),
  ].map(([record, because]) => {
    const failed = record.verdict === "fail";
    const bound =
      failed && record.input !== undefined && outside !== undefined
        ? outside(record.input)
        : undefined;
    const excuse = failed && bound === undefined ? excusedBy(record) : undefined;
    const counts = failed && bound === undefined && excuse === undefined;
    const lead = counts ? changedExpectationBy(record) : undefined;
    return {
      id: record.id,
      retiredBecause: because,
      ...(record.flaky === true ? { flaky: true } : {}),
      ...(bound === undefined ? {} : { outsideSchema: bound }),
      ...(excuse === undefined ? {} : { excusedBy: excuse }),
      ...(lead === undefined ? {} : { changedExpectationBy: lead.id }),
      ...(counts ? { clearedBy: clearedBy(record, lead, outside !== undefined) } : {}),
      ...(record.purpose === undefined ? {} : { purpose: record.purpose }),
      ...(record.expect === undefined ? {} : { expect: record.expect }),
      ...(record.input === undefined ? {} : { input: record.input }),
      lastVerdict: record.verdict,
      onPublishedSource: record.sourceDigest === sourceDigest,
      got: record.got,
      ...(record.detail === undefined ? {} : { detail: record.detail }),
      ...(record.errorClass === undefined ? {} : { errorClass: record.errorClass }),
      ...(record.frame === undefined ? {} : { frame: record.frame }),
      ...(record.excerpt === undefined ? {} : { excerpt: record.excerpt }),
    };
  });
};

const outOfTimeNote =
  "The attempt ran out of time for live tests: a batch was refused for time, or a case ended at the deadline.";

/** Case counts in a fixed order: pass, fail and inconclusive always, stale and not_run when any. */
const countsOf = (statuses: readonly CaseStatus[]) => {
  const count = (status: CaseStatus) => statuses.filter((entry) => entry === status).length;
  return {
    pass: count("pass"),
    fail: count("fail"),
    inconclusive: count("inconclusive"),
    ...(count("stale") === 0 ? {} : { stale: count("stale") }),
    ...(count("not_run") === 0 ? {} : { not_run: count("not_run") }),
  };
};

/** One version's results, for the publication record. */
export interface LiveTestVersionResults {
  readonly version: LiveTestVersion;
  /** The entrypoint whose current source the statuses are judged against, if the build has one. */
  readonly entrypoint?: string;
  /** That entrypoint's current source digest; undefined leaves every result stale or not run. */
  readonly sourceDigest: string | undefined;
  /** This version's latest result for each case, by case id. */
  readonly records: ReadonlyMap<string, LiveTestRecord>;
  /** This version's failing results the minter replaced by changing their case. */
  readonly replaced?: readonly LiveTestRecord[];
  /**
   * The input schema this version publishes, as the host read it from that source; absent when
   * it could not, which marks no retired input `outsideSchema`.
   */
  readonly inputSchema?: unknown;
}

const versionName = (version: LiveTestVersion) =>
  version === "http" ? "HTTP version" : "Playwright version";

/**
 * The host's record of a read's live tests on the source it publishes, for the publication
 * review (`publication/tests.json`), and the line it adds to coverage. Each case shows its result
 * on each version in `versions`, judged against that version's own current source.
 */
export const liveTestsEvidence = (options: {
  readonly file: LiveTestCasesFile;
  readonly fileProblem?: string;
  /** The Playwright version's results, and the HTTP version's when the build has one. */
  readonly versions: readonly LiveTestVersionResults[];
  /** The attempt ran out of time for live tests. */
  readonly outOfTime?: boolean;
  /**
   * The read signed in, so it ran live tests on at most `signedInTestInputLimit` inputs, and
   * `versions` holds only results run signed in.
   */
  readonly signedIn?: boolean;
}) => {
  const { file, versions } = options;
  const outOfTime = options.outOfTime === true;
  const signedIn = options.signedIn === true;
  const cases = file.cases.map((testCase) => ({
    id: testCase.id,
    purpose: testCase.purpose,
    expect: testCase.expect,
    ...(testCase.next_page === true ? { next_page: true } : {}),
    ...(testCase.noMatch === true ? { noMatch: true } : {}),
    input: testCase.input,
    results: Object.fromEntries(
      versions.map((entry) => {
        const {
          id: _id,
          purpose: _purpose,
          expect: _expect,
          next_page: _nextPage,
          noMatch: _noMatch,
          outputChecks: findings,
          ...view
        } = caseView(testCase, entry.records.get(testCase.id), entry.sourceDigest);
        return [
          entry.version,
          {
            ...view,
            // Compact for the review: it reads the values in the excerpt and the captures.
            ...(findings === undefined
              ? {}
              : {
                  outputChecks: findings.map(({ path, check, count, blocking }) => ({
                    path,
                    check,
                    count,
                    blocking,
                  })),
                }),
          },
        ];
      }),
    ),
  }));
  const notTested = file.notTested ?? [];
  const retired = versions.flatMap((entry) =>
    retiredViews(
      file,
      entry.records,
      entry.replaced ?? [],
      entry.sourceDigest,
      entry.inputSchema,
    ).map((view) => ({
      version: entry.version,
      ...view,
    })),
  );
  const nothing =
    options.fileProblem === undefined &&
    cases.length === 0 &&
    notTested.length === 0 &&
    retired.length === 0;
  const versionViews = versions.map((entry) => ({
    version: entry.version,
    ...(entry.entrypoint === undefined ? {} : { entrypoint: entry.entrypoint }),
    ...(entry.sourceDigest === undefined ? {} : { sourceDigest: entry.sourceDigest }),
    counts: countsOf(
      file.cases.map((testCase) =>
        caseStatus(testCase, entry.records.get(testCase.id), entry.sourceDigest),
      ),
    ),
    // The cases that passed on a new browser with an empty profile, on the published source.
    coldPasses: file.cases.filter(
      (testCase) =>
        entry.records.get(testCase.id)?.start === "cold" &&
        caseStatus(testCase, entry.records.get(testCase.id), entry.sourceDigest) === "pass",
    ).length,
  }));
  const retiredFailures = retired.filter((entry) => entry.lastVerdict === "fail").length;
  const stillCounting = retired.filter((entry) => "clearedBy" in entry).length;
  const summary = nothing
    ? "Host live tests on the published source: none designed or run; beyond the example, nothing was tested live."
    : `Host live tests on the published source${signedIn ? `, signed in (at most ${signedInTestInputLimit} inputs)` : ""}: ${cases.length} case${cases.length === 1 ? "" : "s"}.${versionViews
        .map(
          (entry) =>
            ` ${versionName(entry.version)}${entry.entrypoint === undefined ? "" : ` (${entry.entrypoint})`}: ${Object.entries(
              entry.counts,
            )
              .map(([status, count]) => `${count} ${status}`)
              .join(", ")}${entry.coldPasses === 0 ? "; none passed cold" : `; ${entry.coldPasses} passed cold`}.`,
        )
        .join("")}${
        retired.length === 0
          ? ""
          : ` ${retired.length} retired case${retired.length === 1 ? "" : "s"} (${retiredFailures} last failed).${
              retiredFailures === 0
                ? ""
                : ` ${stillCounting} of those failures still count${stillCounting === 1 ? "s" : ""}.`
            }`
      }`;
  return {
    record: {
      kind: "host_live_tests",
      note: nothing
        ? "Written by the host, never by the minter. The minter designed and ran no live test case, so beyond the example nothing was tested live."
        : "Written by the host from its own runs, never by the minter. The same cases run on each version of the tool: playwright, the Kernel script, and http, the HTTP version, for each version that ships: a version that does not ship, such as an HTTP version the minter ruled out, is not listed. versions names each version's entrypoint, the source digest its results are judged against, and its counts. Each case's results hold its result on each version, from that version's own batches: one version's run never counts for the other. Each case ran in a fresh script process on a page reset to the site's origin, after one Guardian review of its batch; purpose is the minter's account of what the case establishes. noMatch marks the case the minter gives as the tool's no-match case although it expects a result: its input matches nothing, and the tool, a count or total, answers it with 0. A result's start says how its browser started: cold, first on a new browser with an empty profile, as a caller the site remembers nothing about meets it; warm, on a browser that kept the site data earlier steps left. versions counts each version's coldPasses, the cases that passed cold; a host with one browser runs no case cold. status is against that version's source being published: stale means the source or the case changed after the case ran, and not_run means no batch ran it on that version. outputChecks lists the host's output check findings on a case's output. notTested lists what the minter chose not to test, and why. retired lists, by version, cases the minter deleted, failures it replaced by changing the case, and failures that passed when the unchanged case ran again on the same source (flaky), with their last result. A retired failure stops counting when the host marks it outsideSchema or names its excusedBy. outsideSchema means that version's published input schema bounds a value the failure's input supplied, at path (a JSON pointer into the input) by keyword (the JSON Schema rule it breaks), so the tool no longer claims that input; a field the schema newly requires never marks it. excusedBy names a case that passes the same input on that version's published source after the source changed, with the same expectation or with a refusal the failure's own expectation accepts, such as InvalidInput for a case that expected error. changedExpectationBy names a case that passes the same input with another expectation on that version's published source, for a failure on any source; it excuses nothing by itself. clearedBy, on each retired failure that still counts, says what can clear it: ways, the ways open to it; siteAnswer, when it has a changedExpectationBy, the site's own answer for that input a capture must show (results, no_results or refusal), with refusalStatuses for a refusal; and a note.",
      ...(signedIn
        ? {
            signedIn: true,
            signedInNote: `This read signed in. It runs live tests on at most ${signedInTestInputLimit} distinct inputs beyond its example, each on the build's own signed-in browser, so none runs cold. Results list only cases run signed in; a case not_run, and notTested, is disclosure, not a gap.`,
          }
        : {}),
      ...(outOfTime ? { outOfTime: true } : {}),
      ...(options.fileProblem === undefined ? {} : { casesFileProblem: options.fileProblem }),
      versions: versionViews,
      cases,
      notTested,
      retired,
    },
    coverage: `${summary}${outOfTime ? ` ${outOfTimeNote}` : ""}${
      options.fileProblem === undefined ? "" : ` ${options.fileProblem}`
    }`,
  };
};

/**
 * The share of the published version's counted cases, in percent, that must pass on its source
 * before the harness sends a read's publication to review. Below it the review would hold
 * publication back on the failing cases anyway, so it is not started. The bar sits below every
 * case so that a case that is itself wrong, and not yet corrected, does not hold back the rest.
 */
export const reviewPassPercent = 70;

/** The published version, when its live tests on its source pass below `reviewPassPercent`. */
export interface LiveTestsShortfall {
  readonly version: LiveTestVersion;
  readonly entrypoint?: string;
  /** Counted cases that pass. */
  readonly passed: number;
  /** Counted cases: those that pass or fail. */
  readonly counted: number;
  /** `passed` of `counted` in whole percent, rounded down, so 69.6% reads 69%. */
  readonly percent: number;
}

/**
 * Whether the version `finish_build` publishes, `published`, passes below `reviewPassPercent` on
 * its source, from the publication record's `versions`; undefined when it reaches the bar.
 *
 * Its counted cases are the cases in `test/cases.json` as written now whose latest result on that
 * version's published source is a pass or a fail, its `counts` in the record. Nothing else counts
 * either way: an inconclusive result (a challenge, a site block, a host fault, the deadline) tested
 * nothing about the tool; a stale or not_run case has no result on that source; and a retired case
 * is no longer one of the cases. A version with no counted case reaches the bar: the review judges
 * its coverage as before. Only the published version is held to it: the publication review
 * judges an HTTP version beside a published Playwright version from its own results, as before.
 * The harness does not apply the bar once the attempt ran out of time for live tests, or when no
 * further batch fits, as after a host's batch cap, since no case can run again then.
 */
export const liveTestsShortfall = (
  versions: readonly {
    readonly version: LiveTestVersion;
    readonly entrypoint?: string;
    readonly counts: { readonly pass: number; readonly fail: number };
  }[],
  published: LiveTestVersion,
): LiveTestsShortfall | undefined => {
  const entry = versions.find((candidate) => candidate.version === published);
  if (entry === undefined) return undefined;
  const passed = entry.counts.pass;
  const counted = passed + entry.counts.fail;
  // Whole numbers, so 7 of 10 reaches 70% exactly.
  if (counted === 0 || passed * 100 >= counted * reviewPassPercent) return undefined;
  return {
    version: entry.version,
    ...(entry.entrypoint === undefined ? {} : { entrypoint: entry.entrypoint }),
    passed,
    counted,
    percent: Math.floor((passed * 100) / counted),
  };
};

/** The published version's counted cases that fail on its source. */
export interface LiveTestsFailing {
  readonly version: LiveTestVersion;
  readonly entrypoint?: string;
  /** The failing cases' ids, in the cases file's order. */
  readonly ids: readonly string[];
}

/**
 * The counted cases of the version `finish_build` publishes, `published`, that fail on its source,
 * from the publication record; undefined when none does. They are the failing cases among those
 * `liveTestsShortfall` counts: cases in `test/cases.json` as written now whose latest result on
 * that version's published source is a fail. An inconclusive, stale or not_run case is not one,
 * and neither is a retired case, which the review judges from the record's `retired`. Only the
 * published version is read, as for the bar. On a host that sets
 * `LiveTestHost.holdReviewOnFailingCases`, the harness starts no publication review while any
 * such case remains, unless no case can run again.
 */
export const failingLiveTestCases = (
  record: {
    readonly versions: readonly { readonly version: LiveTestVersion; readonly entrypoint?: string }[];
    readonly cases: readonly {
      readonly id: string;
      readonly results: Readonly<Record<string, { readonly status: string }>>;
    }[];
  },
  published: LiveTestVersion,
): LiveTestsFailing | undefined => {
  const entry = record.versions.find((candidate) => candidate.version === published);
  if (entry === undefined) return undefined;
  const ids = record.cases
    .filter((testCase) => testCase.results[published]?.status === "fail")
    .map((testCase) => testCase.id);
  if (ids.length === 0) return undefined;
  return {
    version: entry.version,
    ...(entry.entrypoint === undefined ? {} : { entrypoint: entry.entrypoint }),
    ids,
  };
};

/** The most failing cases `failingCasesRefusal` names; it counts the rest. */
export const maximumNamedFailingCases = 10;

/** What the minter is told when `finish_build` names failing cases instead of starting review. */
export const failingCasesRefusal = (failing: LiveTestsFailing): string => {
  const named = failing.ids.slice(0, maximumNamedFailingCases);
  const more = failing.ids.length - named.length;
  const list =
    more > 0
      ? `${named.join(", ")} and ${more} more`
      : named.length === 1
        ? named.join("")
        : `${named.slice(0, -1).join(", ")} and ${named.at(-1) ?? ""}`;
  const one = failing.ids.length === 1;
  return `Publication review not started: live test case${one ? "" : "s"} ${list}${failing.entrypoint === undefined ? "" : ` on ${failing.entrypoint}`} fail${one ? "s" : ""} on this source, and the review holds publication back on a failing case. Prefer fixing the code where a case fails; retire a case, by changing or deleting it in ${liveTestCasesPath}, only where the case itself is wrong. After a code fix, run every case again; then call finish_build.`;
};

/** The record when the host could not build it, so the publication review knows why it is bare. */
export const liveTestsEvidenceProblem = (problem: string) => ({
  record: {
    kind: "host_live_tests",
    note: "Written by the host, never by the minter.",
    problem,
    versions: [],
    cases: [],
    notTested: [],
    retired: [],
  },
  coverage: `Host live tests on the published source: the host could not build its record (${problem}).`,
});
