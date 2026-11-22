import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Usage } from "@openai/agents";
import type { ModelProvider, ModelRequest, ModelResponse } from "@openai/agents";
import { Schema } from "effect";
import { instructionsOf } from "../support/guardian-requests.js";

type Output = ModelResponse["output"];
type Item = Output[number];

export const message = (text: string): Item => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text }],
});
export const call = (name: string, input: unknown, callId = name): Item => ({
  type: "function_call",
  name,
  callId,
  arguments: JSON.stringify(input),
  status: "completed",
});
/** One model turn that creates each file. */
export const patch = (files: Readonly<Record<string, string>>): Output =>
  Object.entries(files).map(([path, content], index) => ({
    type: "apply_patch_call",
    callId: `patch_${path.replaceAll(/[^a-z0-9]/giu, "_")}_${index}`,
    status: "completed",
    operation: {
      type: "create_file",
      path,
      diff:
        content
          .split("\n")
          .map((line) => `+${line}`)
          .join("\n") + "\n",
    },
  }));

/** A model that answers each request with `respond`, failing when it throws. */
export const scripted = (
  respond: (request: ModelRequest, index: number) => Output | Promise<Output>,
  requests: ModelRequest[] = [],
): ModelProvider => ({
  getModel: () => ({
    getResponse: async (request) => {
      requests.push(request);
      return { usage: new Usage(), output: await respond(request, requests.length - 1) };
    },
    getStreamedResponse: () => {
      throw new Error("Fixture does not stream");
    },
  }),
});

const Record = Schema.Record({ key: Schema.String, value: Schema.Unknown });
/** Every object in a value, parsing JSON text on the way down. */
export const objects = (value: unknown): readonly Readonly<Record<string, unknown>>[] => {
  if (typeof value === "string") {
    try {
      return objects(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value.flatMap(objects);
  if (typeof value !== "object" || value === null) return [];
  const record = Schema.decodeUnknownEither(Record)(value);
  return record._tag === "Left"
    ? []
    : [record.right, ...Object.values(record.right).flatMap(objects)];
};

const inputItems = (request: ModelRequest): readonly unknown[] =>
  typeof request.input === "string" ? [request.input] : request.input;

/** The parsed result the harness returned for one tool call, by its call id. */
export const toolResult = (
  request: ModelRequest | undefined,
  callId: string,
): Readonly<Record<string, unknown>> | undefined => {
  if (request === undefined) return undefined;
  const item = objects(inputItems(request)).find(
    (candidate) => candidate["type"] === "function_call_result" && candidate["callId"] === callId,
  );
  return item === undefined
    ? undefined
    : objects(item["output"]).find((value) => typeof value["status"] === "string");
};

/** The receipt id of an execute call's result. */
export const executionIdOf = (request: ModelRequest | undefined, callId: string) => {
  const id = toolResult(request, callId)?.["executionId"];
  if (typeof id !== "string") throw new Error(`No receipt for ${callId}`);
  return id;
};

/** One Guardian review as the reviewer model received it, and what it read. */
export interface RecordedReview {
  readonly input: Readonly<Record<string, unknown>>;
  /** `outcome`: the review of a build's outcome report, such as the minter's last answer. */
  readonly kind: "question" | "outcome" | "update" | "execution" | "publication";
  readonly reads: Readonly<Record<string, unknown>>[];
  /** The reviewer's instructions: its leading developer messages, joined. */
  readonly instructions: string;
}
/** A publication review's file index. */
export const publicationOf = (review: RecordedReview) =>
  (
    review.input["trusted_publication"] as
      { readonly files: readonly Readonly<Record<string, unknown>>[] } | undefined
  )?.files;
/** The text a review read of `path`, from its first chunk. */
export const readOf = (review: RecordedReview | undefined, path: string) => {
  const read = review?.reads.find((value) => value["path"] === path);
  return typeof read?.["source"] === "string" ? read["source"] : undefined;
};
export const contextOf = (review: RecordedReview) =>
  review.input["trusted_execution_context"] as Readonly<Record<string, unknown>> | undefined;
export const currentOf = (review: RecordedReview) =>
  contextOf(review)?.["currentExecution"] as Readonly<Record<string, unknown>> | undefined;
export const authorityOf = (review: RecordedReview) =>
  review.input["trusted_authority"] as Readonly<Record<string, unknown>>;
/** The build's request, which ends the instructions: the build's own developer message. */
export const intentOf = (review: RecordedReview) => {
  const marker = "\ntrusted_request: ";
  const at = review.instructions.lastIndexOf(marker);
  return at < 0
    ? undefined
    : (JSON.parse(review.instructions.slice(at + marker.length)) as { intent?: unknown }).intent;
};

/**
 * A scripted Guardian that records each review's input. An execution review reads its entrypoint
 * (and the whole current page's capture when `readPage` is set) before deciding; a publication
 * review reads the first chunk of every file it indexes; a question is allowed. `decide` returns
 * an outcome, or a publication review's whole decision; `decideUpdate` a task update's outcome,
 * allow unless it says otherwise. An execution outcome alone gets the action its step's purpose
 * implies.
 * `fail` makes a call throw, as a provider outage would.
 */
export const recordingGuardian = (
  options: {
    readonly decide?: (
      review: RecordedReview,
    ) => "allow" | "deny" | Readonly<Record<string, unknown>>;
    readonly decideUpdate?: (review: RecordedReview) => string;
    readonly readPage?: boolean;
    readonly fail?: (call: number) => Error | undefined;
  } = {},
) => {
  const reviews: RecordedReview[] = [];
  let calls = 0;
  const provider = scripted((request) => {
    const failure = options.fail?.(calls++);
    if (failure !== undefined) throw failure;
    const items = inputItems(request);
    const start = items.findLastIndex((item) =>
      objects(item).some((value) => "submitted_call" in value),
    );
    const input = objects(items[start]).find((value) => "submitted_call" in value);
    if (input === undefined) throw new Error("Guardian did not receive its review input");
    const results = objects(items.slice(start + 1)).filter(
      (value) => value["type"] === "function_call_result",
    );
    const question = "question_review" in input;
    const outcome =
      question &&
      (input["question_review"] as Readonly<Record<string, unknown>>)["blockedOutcome"] === true;
    const update = "update_review" in input;
    const publication = "trusted_publication" in input;
    if (results.length === 0)
      reviews.push({
        input,
        kind: outcome
          ? "outcome"
          : question
            ? "question"
            : update
              ? "update"
              : publication
                ? "publication"
                : "execution",
        reads: [],
        instructions: instructionsOf(request),
      });
    const review = reviews.at(-1);
    if (review === undefined) throw new Error("No review recorded");
    if (question)
      return [message(JSON.stringify({ outcome: "allow_business", rationale: "Fixture asks." }))];
    if (update)
      return [
        message(
          JSON.stringify({
            outcome: options.decideUpdate?.(review) ?? "allow",
            rationale: "Fixture update review.",
          }),
        ),
      ];
    review.reads.splice(
      0,
      review.reads.length,
      ...results.flatMap((result) =>
        objects(result["output"]).filter((value) => value["kind"] === "untrusted_source"),
      ),
    );
    const submitted = input["submitted_call"] as Readonly<Record<string, unknown>>;
    const page = (contextOf(review)?.["currentPage"] as Readonly<Record<string, unknown>>)?.[
      "capture"
    ];
    if (publication && results.length === 0)
      return (publicationOf(review) ?? []).map((file, index) =>
        call("read_source", { path: file["path"], offset: 0 }, `read_${calls}_${index}`),
      );
    // The entrypoint first, then with `readPage` the whole capture, one chunk after another.
    const last = review.reads.at(-1);
    const next = publication
      ? undefined
      : results.length === 0
        ? { path: String(submitted["entrypoint"]), offset: 0 }
        : options.readPage !== true || typeof page !== "string" || last === undefined
          ? undefined
          : last["path"] !== page
            ? results.length === 1
              ? { path: page, offset: 0 }
              : undefined
            : last["hasMore"] === true
              ? { path: page, offset: Number(last["nextOffset"]) }
              : undefined;
    if (next !== undefined) return [call("read_source", next, `read_${calls}_${results.length}`)];
    const decided = options.decide?.(review) ?? "allow";
    return [
      message(
        JSON.stringify(
          typeof decided === "string"
            ? {
                outcome: decided,
                rationale: "Recorded fixture review",
                ...actionFor(review.input),
              }
            : decided,
        ),
      ),
    ];
  });
  return { provider, reviews, calls: () => calls };
};

/**
 * The action label a fixture execution review gives a step by its purpose, as fields to spread
 * into its decision; other kinds of review get none.
 */
export const actionFor = (input: Readonly<Record<string, unknown>> | undefined) => {
  const review = input?.["trusted_review"] as Readonly<Record<string, unknown>> | undefined;
  if (review?.["kind"] !== "execution") return {};
  const context = input?.["trusted_execution_context"] as
    Readonly<Record<string, unknown>> | undefined;
  const purpose = (
    context?.["currentExecution"] as Readonly<Record<string, unknown>> | undefined
  )?.["purpose"];
  return {
    action: purpose === "act" ? "write" : purpose === "authenticate" ? "authentication" : "read",
  };
};

/** An outcome reviewer that ends every turn without assessing. */
export const quietReviewer: ModelProvider = scripted(() => [message("No assessment yet.")]);

/** A local site; `handle` answers each request, and every request line is logged. */
export const startSite = async (
  handle: (request: IncomingMessage, response: ServerResponse, body: string) => void,
) => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
      handle(request, response, body);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture address");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
};
export const html = (response: ServerResponse, body: string) => {
  response.setHeader("Content-Type", "text/html");
  response.end(body);
};

/** An execute call's arguments. */
export const execution = (
  purpose: string,
  entrypoint: string,
  extra: Readonly<Record<string, unknown>> = {},
) => ({
  purpose,
  target: "liveBrowser",
  entrypoint,
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 10,
  intent: `Run ${entrypoint} for ${purpose}`,
  ...extra,
});

/** A write path naming `marks` in order, as a write build's first act step declares it. */
export const writePath = (...marks: readonly string[]) => ({
  steps: marks.map((commit) => ({ commit, does: `Sends the ${commit} step` })),
  ends: "The site's confirmation of the task",
});

/** A read operation whose live step returns the page's main heading. */
export const headingOperation = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
import { heading } from "./heading.mjs";
export default defineOperation({name:"read_fixture",input:Schema.Struct({}),output:Schema.Struct({heading:Schema.String})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:"return await page.locator('h1').textContent();",timeout_sec:5});
  if(!response.success) throw new Error(String(response.error));
  return {heading:heading(response.result)};
});`;
/** A probe that returns the page title; `code` replaces its page code. */
export const probe = (code = "return await page.title();") => `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"probe",input:Schema.Unknown,output:Schema.Unknown},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:${JSON.stringify(code)},timeout_sec:5});
  if(!response.success) throw new Error(String(response.error));
  return {value:response.result};
});`;
