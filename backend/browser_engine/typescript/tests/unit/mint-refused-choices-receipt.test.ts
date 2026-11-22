import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import type { ExecutionEvidence } from "../../src/mint/contracts.js";
import { makeMintHarnessFixture, portableJobSession } from "../support/mint-fixtures.js";

// A repair whose fixed read refuses the caller's own value and lists the choices the page offers
// has shown the tool behaves correctly: maintenance cannot change the caller's input, so that
// example is its receipt. A first build, or a refusal without the choices, still needs a
// completed example.
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0)) await clean();
});
const repair = {
  mode: "maintenance",
  intent: "Read a product in the requested size",
  businessInput: { size: "M" },
  observations: [],
};
const fixture = makeMintHarnessFixture(cleanup, repair, portableJobSession);
const example = {
  purpose: "example",
  target: "pureFiles",
  entrypoint: "src/tool.ts",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 30,
};
const publication = {
  entrypoint: "src/tool.ts",
  executionId: "execution_one",
  metadata: { name: "product", description: "Read a product in the requested size" },
  coverage: "The example refused size M and listed the size the page offers.",
};
const refused = (refusal?: ExecutionEvidence["refusal"]): ExecutionEvidence => ({
  executionId: "execution_one",
  status: "failed",
  effect: "not_sent",
  observations: { error: "InvalidInput" },
  ...(refusal === undefined ? {} : { refusal }),
});

const publishOnce = async (evidence: ExecutionEvidence, request: object = repair) => {
  const answers: Record<string, unknown>[] = [];
  let publishes = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(example);
        answers.push(JSON.parse(yield* turn.actions.finish(publication)));
      }),
    {
      reviewAndExecute: () => Effect.succeed(evidence),
      publish: () =>
        Effect.sync(() => {
          publishes += 1;
          return { publicationRef: "published-revision", diagnostics: [] };
        }),
    },
  );
  const outcome = await f.run(request);
  return { answer: answers[0], publishes, outcome };
};

it("publishes a repair whose read example refused the caller's value with the page's choices", async () => {
  const { publishes, outcome } = await publishOnce(
    refused({ field: "size", available: ["One Size"] }),
  );
  expect(publishes).toBe(1);
  expect(outcome).toMatchObject({ build: "published", publicationRef: "published-revision" });
});

it.each([
  { case: "a repair's refusal without the page's choices", evidence: refused(), request: repair },
  {
    case: "a first build's refusal with the page's choices",
    evidence: refused({ field: "size", available: ["One Size"] }),
    request: { ...repair, mode: "mint" },
  },
  {
    case: "a write repair's refusal with the page's choices",
    evidence: refused({ field: "size", available: ["One Size"] }),
    request: { ...repair, effect: "write" },
  },
])("refuses $case as an incomplete receipt", async ({ evidence, request }) => {
  const { answer, publishes } = await publishOnce(evidence, request);
  expect(answer).toMatchObject({ status: "not_published", reason: "receipt_incomplete" });
  expect(publishes).toBe(0);
});
