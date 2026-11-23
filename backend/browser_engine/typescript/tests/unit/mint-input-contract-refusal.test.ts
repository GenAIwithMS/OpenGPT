import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import {
  MintFailure,
  type BrokenInput,
  type MintDependencies,
  type PublicationDecision,
} from "../../src/mint/contracts.js";
import {
  inputContractChangedInstruction,
  registryRefusal,
} from "../../src/mint/registry-feedback.js";
import { makeMintHarnessFixture, portableJobSession } from "../support/mint-fixtures.js";

// A host compares the published tool's input schema with the publication's and refuses one that
// changes an input the tool already declares. The minter reads the fixed instruction and each
// broken input as data, restores the inputs, runs the example again with the edited code and
// publishes that execution.
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0)) await clean();
});
const request = {
  mode: "mint",
  intent: "Read an order with its price",
  businessInput: { order: "A-1" },
  observations: [],
};
const fixture = makeMintHarnessFixture(cleanup, request, portableJobSession);
const example = {
  purpose: "example",
  target: "pureFiles",
  entrypoint: "src/tool.ts",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 30,
};
const publicationOf = (executionId: string) => ({
  entrypoint: "src/tool.ts",
  executionId,
  metadata: { name: "order", description: "Read an order with its price" },
  coverage: "One example ran.",
});
const broken: readonly BrokenInput[] = [
  { field: "order", change: "changed" },
  { field: "region", change: "removed" },
  { field: "currency", change: "required" },
];
const refusal = (
  reason: NonNullable<MintFailure["reason"]>,
  payload: Pick<MintFailure, "brokenInputs" | "registryIssue" | "weakenedOutputs"> = {},
) => new MintFailure({ code: "PublicationUnavailable", reason, ...payload });
const decisionLog = () => {
  const recorded: PublicationDecision[] = [];
  const publicationDecisions: MintDependencies["publicationDecisions"] = {
    record: (decision) =>
      Effect.sync(() => {
        recorded.push(decision);
      }),
    list: Effect.sync(() => recorded),
  };
  return { recorded, publicationDecisions };
};

// The maintainer approved this instruction word for word, so any edit to it fails here first.
it("keeps the approved input contract instruction word for word", () => {
  const common =
    "Not published and not reviewed: this publication would refuse values that inputs the published tool already declares accept today, so calls that work now would stop working. brokenInputs names each one and how it changed. A requested change may add optional inputs, widen what an input accepts or add a default, and may narrow an input only to a limit the site itself states, such as its own maxlength or allowed range; it never removes an input or makes one required. Restore each named input so it accepts at least what the published tool's does, up to such a limit, keep every new input optional, ";
  expect(inputContractChangedInstruction(false)).toBe(
    `${common}run the example again with the edited code, and call finish_build with that execution.`,
  );
  expect(inputContractChangedInstruction(true)).toBe(
    `${common}and call finish_build again with the same executionId; never run the write again for this.`,
  );
});

// A write never runs again to fix its inputs: it restores them in the source and publishes its
// session's execution again, which the host records as a source correction.
it("tells a write refused for its inputs to publish the same execution, never running the write again", async () => {
  const { recorded, publicationDecisions } = decisionLog();
  const answers: Record<string, unknown>[] = [];
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute({ ...example, purpose: "act" });
        answers.push(JSON.parse(yield* turn.actions.finish(publicationOf("execution_one"))));
      }),
    {
      publicationDecisions,
      publish: () => Effect.fail(refusal("input_contract_changed", { brokenInputs: broken })),
    },
  );
  await f.run({ ...request, effect: "write" });
  expect(answers[0]).toMatchObject({
    status: "not_published",
    reason: "input_contract_changed",
    brokenInputs: broken,
  });
  const instruction = String(answers[0]?.["instruction"]);
  expect(instruction.endsWith(inputContractChangedInstruction(true))).toBe(true);
  expect(recorded[0]).toMatchObject({
    reason: "input_contract_changed",
    recovery: "correct_source",
  });
});

it("hands the minter a host's input contract refusal as exactly the fixed instruction and brokenInputs", async () => {
  const answers: Record<string, unknown>[] = [];
  let publishes = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(example);
        for (let call = 0; call < 2; call++)
          answers.push(JSON.parse(yield* turn.actions.finish(publicationOf("execution_one"))));
      }),
    {
      publish: () =>
        Effect.fail(
          publishes++ === 0
            ? refusal("registry_invalid_definition", { registryIssue: "definition_invalid" })
            : refusal("input_contract_changed", { brokenInputs: broken }),
        ),
    },
  );
  await f.run();
  // Every refusal opens with the same notice of what live execution is left. The registry's
  // refusal shows it before its own fixed instruction, and nothing else.
  const registryInstruction = registryRefusal("definition_invalid").instruction;
  const registryText = String(answers[0]?.["instruction"]);
  expect(registryText.endsWith(registryInstruction)).toBe(true);
  const notice = registryText.slice(0, -registryInstruction.length);
  expect(answers[1]).toStrictEqual({
    status: "not_published",
    code: "PublicationUnavailable",
    reason: "input_contract_changed",
    brokenInputs: broken,
    userInputRequired: false,
    instruction: notice + inputContractChangedInstruction(false),
    decisionId: expect.any(String),
  });
});

// Unlike a contract mismatch, which publishes the same execution once the schema is fixed, this
// refusal needs the edited code to run: a repeatable read runs its example again and publishes it.
it("lets the minter run the example again with edited code after the refusal and publish that execution", async () => {
  const { recorded, publicationDecisions } = decisionLog();
  const published: string[] = [];
  const answers: Record<string, unknown>[] = [];
  let executions = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(example);
        answers.push(JSON.parse(yield* turn.actions.finish(publicationOf("execution_one"))));
        const editor = turn.session.createEditor?.();
        if (!editor) return yield* new MintFailure({ code: "Unavailable" });
        expect(
          yield* Effect.promise(() =>
            editor.updateFile({
              type: "update_file",
              path: "src/tool.ts",
              diff: "@@\n-export const privateExample = 'secret-canary';\n+export default { name: 'restored' };\n",
            }),
          ),
        ).toMatchObject({ status: "completed" });
        answers.push(JSON.parse(yield* turn.actions.execute(example)));
        answers.push(JSON.parse(yield* turn.actions.finish(publicationOf("execution_two"))));
      }),
    {
      repeatableRead: true,
      publicationDecisions,
      reviewAndExecute: () =>
        Effect.sync(() => {
          executions++;
          return {
            executionId: executions === 1 ? "execution_one" : "execution_two",
            status: "completed" as const,
            effect: "verified" as const,
            resultRef: `private-result-${executions}`,
            observations: { result: "public" },
          };
        }),
      publish: (publication) =>
        Effect.suspend(() => {
          published.push(publication.executionId);
          return published.length === 1
            ? Effect.fail(refusal("input_contract_changed", { brokenInputs: broken }))
            : Effect.succeed({ publicationRef: "published-revision", diagnostics: [] });
        }),
    },
  );
  const outcome = await f.run();
  expect(answers[0]).toMatchObject({ status: "not_published", reason: "input_contract_changed" });
  expect(answers[1]).toMatchObject({ status: "completed", executionId: "execution_two" });
  expect(answers[2]).toMatchObject({ status: "published" });
  expect(published).toEqual(["execution_one", "execution_two"]);
  // The host's record tells a later review that a new example follows this refusal.
  expect(recorded).toEqual([
    expect.objectContaining({
      outcome: "refused",
      reason: "input_contract_changed",
      executionId: "execution_one",
      failedChecks: ["input_contract_changed"],
      recovery: "new_observation",
    }),
    expect.objectContaining({ outcome: "published", executionId: "execution_two" }),
  ]);
  expect(outcome).toMatchObject({ build: "published", publicationRef: "published-revision" });
});

// The new reason changes nothing for the contract refusals beside it: each keeps its own
// instruction, its own details and its source-fix recovery.
it("keeps the existing contract refusals as they were beside the input contract refusal", async () => {
  const { recorded, publicationDecisions } = decisionLog();
  const answers: Record<string, unknown>[] = [];
  const refusals = [
    refusal("output_obligation_weakened", {
      weakenedOutputs: [{ field: "price", change: "removed" }],
    }),
    refusal("contract_input_mismatch"),
    refusal("input_contract_changed", { brokenInputs: broken }),
  ];
  let publishes = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(example);
        for (let call = 0; call < refusals.length; call++)
          answers.push(JSON.parse(yield* turn.actions.finish(publicationOf("execution_one"))));
      }),
    {
      publicationDecisions,
      publish: () => Effect.fail(refusals[publishes++] ?? refusal("registry_unavailable")),
    },
  );
  await f.run();
  expect(recorded.map(({ reason, recovery }) => [reason, recovery])).toEqual([
    ["output_obligation_weakened", "correct_source"],
    ["contract_input_mismatch", "correct_source"],
    ["input_contract_changed", "new_observation"],
  ]);
  const [weakened, mismatch, changed] = answers.map((answer) => String(answer["instruction"]));
  expect(answers[0]).toMatchObject({ weakenedOutputs: [{ field: "price", change: "removed" }] });
  expect(weakened).toContain("loosens the registered tool's output contract: price was removed");
  expect(mismatch).toContain("never run the write or the example again");
  for (const [answer, instruction] of [
    [answers[0], weakened],
    [answers[1], mismatch],
  ] as const) {
    expect(answer).not.toHaveProperty("brokenInputs");
    expect(instruction).not.toContain(inputContractChangedInstruction(false));
  }
  expect(changed?.endsWith(inputContractChangedInstruction(false))).toBe(true);
});
