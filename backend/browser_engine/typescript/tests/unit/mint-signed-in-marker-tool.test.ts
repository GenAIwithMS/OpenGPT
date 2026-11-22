import { Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { MintFailure, MintServices } from "../../src/mint/contracts.js";
import type { MintDependencies } from "../../src/mint/contracts.js";
import { runMint } from "../../src/mint/harness.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { Deadline } from "../../src/runtime/deadline.js";
import { portableJobSession, portableMintProjection } from "../support/portable-mint.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const usage = () => new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 });
const call = (name: string, args: unknown, callId = name): ModelResponse => ({
  usage: usage(),
  output: [
    { type: "function_call", name, callId, arguments: JSON.stringify(args), status: "completed" },
  ],
});
// The minter ends the synthetic attempt blocked, which stops the model at once.
const reportBlocked = call("report_blocked", {
  reason: "site_lacks_capability",
  explanation: "The synthetic site offers nothing to read.",
  intent: "End the synthetic attempt.",
});

/** The tool result the model saw for `callId`, decoded. */
const toolOutput = (request: ModelRequest | undefined, callId: string): unknown => {
  const input = request?.input;
  if (!Array.isArray(input)) throw new Error("Missing history");
  const item = input.find(
    (entry) => entry.type === "function_call_result" && entry.callId === callId,
  );
  if (item?.type !== "function_call_result") throw new Error("Missing tool result");
  const output = item.output;
  const text =
    typeof output === "string" ? output : output && "text" in output ? output.text : undefined;
  if (typeof text !== "string") throw new Error("Unexpected tool output");
  return JSON.parse(text);
};

/** One recorded model turn calls the marker check, then the attempt ends. */
const checkMarker = async (marker: object, host: Partial<MintDependencies>) => {
  const workspace = await portableJobSession({ "src/tool.ts": "export {};" });
  cleanups.push(async () => {
    await workspace.close();
  });
  const requests: ModelRequest[] = [];
  const dependencies: MintDependencies = {
    workspace,
    projection: portableMintProjection(),
    instructions: "Synthetic instructions.",
    skills: [{ name: "core", description: "Synthetic", content: "Synthetic contract." }],
    deadline: Deadline.after(60_000),
    model: makeOpenAIMinter({
      getModel: () => ({
        getResponse: async (request) => {
          requests.push(request);
          return requests.length === 1
            ? call(
                "check_signed_in_marker",
                { ...marker, intent: "Test the account menu as the signed-in marker." },
                "marker",
              )
            : reportBlocked;
        },
        getStreamedResponse: () => {
          throw new Error("Unused stream");
        },
      }),
    }),
    preflight: () => Effect.succeed({ supported: true }),
    reviewQuestion: () =>
      Effect.succeed({ outcome: "allow_business" as const, rationale: "Synthetic question." }),
    claimExample: Effect.die("A marker check must not claim the example"),
    authorizeResidual: Effect.fail(new MintFailure({ code: "ReconciliationRequired" })),
    reviewAndExecute: () => Effect.die("A marker check must not execute"),
    publish: () => Effect.die("A marker check must not publish"),
    ...host,
  };
  await Effect.runPromise(
    runMint({
      mode: "mint",
      intent: "Read account data",
      businessInput: {},
      observations: [],
    }).pipe(Effect.provideService(MintServices, dependencies)),
  );
  return toolOutput(requests[1], "marker");
};

it("reports the check unavailable on a host without it", async () => {
  expect(await checkMarker({ selector: "header nav" }, {})).toMatchObject({
    kind: "host_signed_in_marker",
    status: "unavailable",
  });
});

it("hands the marker to the host and refuses one the signed-out page shows", async () => {
  const markers: object[] = [];
  const host: Partial<MintDependencies> = {
    checkSignedInMarker: (marker) =>
      Effect.sync(() => {
        markers.push(marker);
        return marker.selector === "text=Account"
          ? { signedOutSnapshot: "matches", signedInNow: true, freshLoad: true }
          : { signedOutSnapshot: "absent", signedInNow: true, freshLoad: true, secondPage: true };
      }),
  };
  expect(await checkMarker({ selector: "text=Account" }, host)).toMatchObject({
    kind: "host_signed_in_marker",
    status: "refused",
    signedOutSnapshot: "matches",
    refusals: ["marker_matches_signed_out_page"],
  });
  const menu = { selector: 'header [aria-label="Account menu"]', openPath: "/account" };
  expect(await checkMarker(menu, host)).toMatchObject({
    kind: "host_signed_in_marker",
    status: "passed",
    signedOutSnapshot: "absent",
    secondPage: true,
  });
  expect(markers).toEqual([{ selector: "text=Account" }, menu]);
});

it("does not report a plain pass when the signed-out page went unchecked", async () => {
  const host: Partial<MintDependencies> = {
    checkSignedInMarker: () =>
      Effect.succeed({ signedOutSnapshot: "unchecked", signedInNow: true, freshLoad: true }),
  };
  expect(await checkMarker({ selector: "role=region" }, host)).toMatchObject({
    kind: "host_signed_in_marker",
    status: "passed_unchecked",
    warnings: ["signed_out_page_unchecked"],
  });
});
