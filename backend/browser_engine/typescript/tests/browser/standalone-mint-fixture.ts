import type { ModelProvider, ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { createBrowserEngine } from "../../src/standalone/engine.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import type { InputRequest } from "../../src/runtime/input-request.js";
import type { PlaywrightOptions } from "../../src/execution/playwright-execute.js";
import {
  authorityOf,
  contextOf,
  execution,
  html,
  message,
  probe,
  quietReviewer,
  recordingGuardian,
  scripted,
  startSite,
  writePath,
  type RecordedReview,
} from "./guardian-context-fixture.js";

export type Turn = (request: ModelRequest) => ModelResponse["output"];

/**
 * Mints against `url` with a minter that plays `turns`, one per model request, and the recorded
 * Guardian; `answer` answers each question the build asks.
 */
export const mint = async (options: {
  readonly effect: "read" | "write";
  readonly url: string;
  readonly turns: readonly Turn[];
  readonly guardian: ReturnType<typeof recordingGuardian>;
  /** The outcome reviewer; by default one that never assesses. */
  readonly reviewer?: ModelProvider;
  readonly answer?: (request: InputRequest) => Record<string, unknown>;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly intent?: string;
  readonly browser?: PlaywrightOptions;
  /** The attempt's time limit; 60 s by default. */
  readonly timeoutMs?: number;
}) => {
  const requests: ModelRequest[] = [];
  const asked: InputRequest[] = [];
  const minter = scripted(
    (request, index) => options.turns[index]?.(request) ?? [message("Done.")],
    requests,
  );
  const built = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* createBrowserEngine({
          ...(options.browser === undefined ? {} : { browser: options.browser }),
          minterProvider: minter,
          guardianProvider: options.guardian.provider,
          outcomeReviewerProvider: options.reviewer ?? quietReviewer,
          ask: makeInputAsker((request) =>
            Effect.sync(() => {
              asked.push(request);
              return options.answer?.(request) ?? {};
            }),
          ),
          timeoutMs: options.timeoutMs ?? 60_000,
        });
        return yield* service.mint({
          url: options.url,
          intent: options.intent ?? "Read the fixture heading",
          effect: options.effect,
          input: options.input ?? {},
        });
      }),
    ),
  );
  return { built, requests, asked, last: requests.at(-1) };
};
export const executions = (reviews: readonly RecordedReview[]) =>
  reviews.filter((review) => review.kind === "execution");
export const effectsOf = (review: RecordedReview | undefined) =>
  (review === undefined ? [] : authorityOf(review)["allowedEffects"]) as readonly string[];
export const historyOf = (review: RecordedReview | undefined) =>
  ((review === undefined ? [] : contextOf(review)?.["executions"]) ?? []) as readonly Readonly<
    Record<string, unknown>
  >[];

/** A site whose Save button posts once per click, and how many posts it received. */
export const saveSite = () => {
  let writes = 0;
  return {
    writes: () => writes,
    start: () =>
      startSite((request, response) => {
        if (request.method === "POST") {
          writes++;
          response.end("saved");
          return;
        }
        html(
          response,
          `<title>Save</title><button id="save" onclick="fetch('/save',{method:'POST'}).then(()=>document.title='Saved')">Save</button>`,
        );
      }),
  };
};
/** A step that clicks Save and waits for the save to finish. */
export const saveStep = probe(
  "await page.locator('#save').click(); await page.waitForFunction(() => document.title === 'Saved'); return true;",
);

/** A site whose Save button posts the note the page holds, and what it received. */
export const noteSite = () => {
  const saved: string[] = [];
  return {
    saved,
    start: () =>
      startSite((request, response, body) => {
        if (request.method === "POST") {
          saved.push(body);
          response.end("saved");
          return;
        }
        html(
          response,
          `<title>Note</title><button id="save" onclick="fetch('/save',{method:'POST',body:document.body.dataset.note}).then(()=>document.body.innerHTML='<div id=saved>Saved</div>')">Save</button>`,
        );
      }),
  };
};
/**
 * A quote form saved in two steps: Save keeps the applicant as a draft and shows a draft notice,
 * and only then Get quote quotes the saved draft.
 * It keeps every draft and quote it received.
 */
export const quoteSite = () => {
  const drafts: string[] = [];
  const quotes: string[] = [];
  return {
    drafts,
    quotes,
    start: () =>
      startSite((request, response, body) => {
        if (request.method === "POST" && request.url === "/draft") {
          drafts.push(body);
          response.end("saved");
          return;
        }
        if (request.method === "POST" && request.url === "/quote") {
          quotes.push(body);
          response.end(`Q-${1000 + quotes.length}`);
          return;
        }
        html(
          response,
          `<title>Quote</title><button id="save" onclick="fetch('/draft',{method:'POST',body:document.body.dataset.applicant}).then(()=>{document.querySelector('#status').textContent='Draft saved';document.querySelector('#quote').hidden=false;})">Save</button><button id="quote" hidden onclick="fetch('/quote',{method:'POST',body:document.body.dataset.applicant}).then((r)=>r.text()).then((q)=>{document.querySelector('#status').textContent='Quote '+q;})">Get quote</button><div id="status"></div>`,
        );
      }),
  };
};
/** The quote form's whole write path: the saved draft, then the quote. */
export const quotePath = {
  steps: [
    { commit: "save-draft", does: "Saves the applicant as a draft" },
    { commit: "get-quote", does: "Asks the site to quote the saved draft" },
  ],
  ends: "The quote the site returns for the applicant",
};
/** Fills the applicant in, saves the draft and waits for the draft notice. */
const saveDraftCall =
  'enteringCommit("save-draft"); const saved = await kernel.browsers.playwright.execute(sessionId,{code:"await page.evaluate((a) => { document.body.dataset.applicant = a; }, " + JSON.stringify(input.applicant) + "); await page.locator(\'#save\').click(); await page.waitForFunction(() => document.querySelector(\'#status\').textContent === \'Draft saved\'); return true;",timeout_sec:10}); if(!saved.success || saved.result !== true) throw new Error("Draft not saved");';
/** Asks for the quote on the saved draft and reads it. */
const getQuoteCall =
  'enteringCommit("get-quote"); const quoted = await kernel.browsers.playwright.execute(sessionId,{code:"await page.locator(\'#quote\').click(); await page.waitForFunction(() => document.querySelector(\'#status\').textContent.startsWith(\'Quote \')); return await page.locator(\'#status\').textContent();",timeout_sec:10}); if(!quoted.success) throw new Error("No quote");';
/** A quote form script declaring `commits`, whose body runs `body`. */
const quoteScript = (name: string, commits: readonly string[], body: string) => `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"${name}",input:Schema.Struct({applicant:Schema.String}),output:Schema.Unknown,write:{confirmation:"message",commits:${JSON.stringify(commits)}}},
async ({kernel,sessionId,input,enteringCommit,verified}) => { ${body} });`;
/** The session's first step: it saves the draft and, reading the draft notice, confirms it. */
export const saveDraftStep = quoteScript(
  "save_draft",
  ["save-draft", "get-quote"],
  `${saveDraftCall} verified({confirmation:"message"}); return {draft:"saved"};`,
);
/** The session's next step: it gets the quote on the saved draft and confirms it. */
export const getQuoteStep = quoteScript(
  "get_quote",
  ["save-draft", "get-quote"],
  `${getQuoteCall} verified({confirmation:"message"}); return {quote:String(quoted.result).slice(6)};`,
);
/** The composed script: the whole path from the caller's applicant to the quote. */
export const quoteTool = quoteScript(
  "quote_applicant",
  ["save-draft", "get-quote"],
  `${saveDraftCall} ${getQuoteCall} verified({confirmation:"message"}); return {quote:String(quoted.result).slice(6)};`,
);
/** A composed script that leaves the path's quote step out of its declared marks. */
export const draftOnlyTool = quoteScript(
  "save_applicant",
  ["save-draft"],
  `${saveDraftCall} verified({confirmation:"message"}); return {draft:"saved"};`,
);

/** A write step that saves its input's note once and confirms it. */
export const saveNote = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"save_note",input:Schema.Struct({note:Schema.String}),output:Schema.Struct({saved:Schema.Boolean}),write:{confirmation:"message",commits:["save"]}},
async ({kernel,sessionId,input,enteringCommit,verified}) => {
  enteringCommit("save");
  const result = await kernel.browsers.playwright.execute(sessionId,{code:"await page.evaluate((note) => { document.body.dataset.note = note; }, " + JSON.stringify(input.note) + "); await page.locator('#save').click(); await page.locator('#saved').waitFor(); return true;",timeout_sec:10});
  if(!result.success || result.result !== true) throw new Error("Save not confirmed");
  verified({confirmation:"message"});
  return {saved:true};
});`;
export const readNote = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"read_note",input:Schema.Struct({note:Schema.String}),output:Schema.Unknown},
async ({input}) => ({note:input.note}));`;
/** An act step, with the session's `exampleInput` and, on its first step, its write path. */
export const act = (
  entrypoint: string,
  exampleInput?: unknown,
  path?: ReturnType<typeof writePath>,
) =>
  execution("act", entrypoint, {
    ...(exampleInput === undefined
      ? {}
      : {
          exampleInput:
            typeof exampleInput === "string" ? exampleInput : JSON.stringify(exampleInput),
        }),
    ...(path === undefined ? {} : { writePath: path }),
  });
