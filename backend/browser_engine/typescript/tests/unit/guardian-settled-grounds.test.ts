// Failure modes covered: an execution refusal that rests on a fact the host already settled
// stands, so a read example the host lets run again is refused for lacking retry permission,
// and a read-only look-up of a confirmed write's own result is refused as a repeat of that write;
// the host's pushback lets a second write or an unrelated read through; and a refusal that
// keeps resting on a settled fact ends the build as a policy block. An act step whose own authority
// grants the write is refused for lacking write authority, as an earlier read-only step lacked it.
import { OpenAIProvider, setDefaultModelProvider, Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { ReviewFailure, makeGuardian } from "../../src/guardian/review.js";
import type { PendingExecution } from "../../src/guardian/review.js";
import { makeSourceInspector } from "../../src/guardian/source.js";

afterEach(() => setDefaultModelProvider(new OpenAIProvider()));

type MintContext = NonNullable<PendingExecution["mintContext"]>;

const context: MintContext = {
  repeatableRead: false,
  operationSources: ["operation/step.mjs"],
  browser: "active",
  executions: [],
};

/** A read build's corrected example, after its first example ran and stopped. */
const correctedExample: PendingExecution = {
  invocationId: "grounds_job",
  attemptId: "grounds_attempt",
  entrypoint: "operation/step.mjs",
  screenedIntent: "List the synthetic catalog's items in a category",
  screenedInput: '{"category":"lamps"}',
  screenedObservations: "Synthetic fixture",
  accountScope: "account_grounds",
  allowedOrigins: ["https://catalog.example.test"],
  allowedEffects: ["Read the catalog"],
  mintContext: {
    ...context,
    repeatableRead: true,
    currentExecution: { purpose: "example", target: "liveBrowser" },
    executions: [
      {
        executionId: "exec_example_1",
        attempt: "current",
        purpose: "example",
        target: "liveBrowser",
        status: "completed",
        effect: "verified",
        executorStopped: true,
      },
    ],
  },
};

/** A write build's step after its create step committed and the outcome review found it done. */
const afterConfirmedWrite: PendingExecution = {
  invocationId: "grounds_job",
  attemptId: "grounds_attempt",
  entrypoint: "operation/step.mjs",
  screenedIntent: "Create a synthetic project named Alpha and return its ID",
  screenedInput: '{"name":"Alpha"}',
  screenedObservations: "Synthetic fixture",
  accountScope: "account_grounds",
  allowedOrigins: ["https://projects.example.test"],
  allowedEffects: ["Create the named project"],
  writeAuthority: true,
  mintContext: {
    ...context,
    currentExecution: { purpose: "act", target: "liveBrowser" },
    executions: [
      {
        executionId: "exec_act_1",
        attempt: "current",
        purpose: "act",
        target: "liveBrowser",
        status: "completed",
        effect: "verified",
        executorStopped: true,
      },
    ],
    writes: [
      {
        executionId: "exec_act_1",
        purpose: "act",
        entrypoint: "operation/create.mjs",
        outcome: "done",
      },
    ],
  },
};

/**
 * A write build's act step, whose own allowed effects grant the write, as Guardian reviews it in
 * the same conversation right after a read-only explore step.
 */
const actWithAuthority: PendingExecution = {
  invocationId: "grounds_job",
  attemptId: "grounds_attempt",
  entrypoint: "operation/step.mjs",
  screenedIntent: "Send the synthetic quote form once with the caller's values",
  screenedInput: '{"email":"quote@example.test"}',
  screenedObservations: "Synthetic fixture",
  accountScope: "account_grounds",
  allowedOrigins: ["https://quotes.example.test"],
  allowedEffects: ["Send the quote form once with the caller's values"],
  writeAuthority: true,
  mintContext: { ...context, currentExecution: { purpose: "act", target: "liveBrowser" } },
};

/** A read-only explore step of the same build, with no write authority. */
const exploreWithoutAuthority: PendingExecution = {
  invocationId: "grounds_job",
  attemptId: "grounds_attempt",
  entrypoint: "operation/step.mjs",
  screenedIntent: "Send the synthetic quote form once with the caller's values",
  screenedInput: '{"email":"quote@example.test"}',
  screenedObservations: "Synthetic fixture",
  accountScope: "account_grounds",
  allowedOrigins: ["https://quotes.example.test"],
  allowedEffects: ["Read the quote form's pages; no writes"],
  mintContext: { ...context, currentExecution: { purpose: "explore", target: "liveBrowser" } },
};

const reader = makeSourceInspector(
  (path) =>
    path === "operation/step.mjs"
      ? Effect.succeed(new TextEncoder().encode("export default 'synthetic step';"))
      : Effect.fail(new ReviewFailure({ code: "SourceUnavailable" })),
  (_path, bytes) => Effect.succeed(new TextDecoder().decode(bytes)),
);

const decision = (value: Record<string, unknown>): ModelResponse["output"] => [
  {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [
      {
        type: "output_text",
        text: JSON.stringify({
          reason: null,
          findings: null,
          publicReason: null,
          label: null,
          action: null,
          refusal: null,
          refusalGround: null,
          ...value,
        }),
      },
    ],
  },
];
/** Guardian's model, answering each request with the next scripted output. */
const scripted = (responses: readonly ModelResponse["output"][]) => {
  const requests: ModelRequest[] = [];
  setDefaultModelProvider({
    getModel: () => ({
      getResponse: async (request) => {
        const output = responses[requests.length];
        requests.push(request);
        if (output === undefined) throw new Error("No scripted response");
        return { usage: new Usage(), output };
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  });
  return requests;
};
const guardian = () =>
  makeGuardian({
    ...makeOpenAIReviewer("{{ tenant_policy_config }}", false, {
      executionEnvironment: nativeExecutionEnvironment,
    }),
    retry: { delays: ["1 millis"], budget: "1 minute" },
  });

it("allows a corrected read example the host lets run again, once told the refusal's ground is settled", async () => {
  const requests = scripted([
    decision({
      outcome: "deny",
      rationale: "Running the example again needs retry permission.",
      refusal: "final",
      refusalGround: "retry_permission",
    }),
    decision({ outcome: "allow", rationale: "Reads the category list.", action: "read" }),
  ]);
  const reviewed = await Effect.runPromise(guardian().review(correctedExample, reader));
  expect(reviewed.decision).toEqual({
    outcome: "allow",
    rationale: "Reads the category list.",
    action: "read",
  });
  expect(requests).toHaveLength(2);
});

it("allows a read-only look-up of a confirmed write's own result, once told the refusal's ground is settled", async () => {
  const requests = scripted([
    decision({
      outcome: "deny",
      rationale: "After the create, only the page as it stands may be read.",
      action: "read",
      refusal: "correctable",
      refusalGround: "committed_write",
    }),
    decision({ outcome: "allow", rationale: "Looks up the new project's ID.", action: "read" }),
  ]);
  const reviewed = await Effect.runPromise(guardian().review(afterConfirmedWrite, reader));
  expect(reviewed.decision).toEqual({
    outcome: "allow",
    rationale: "Looks up the new project's ID.",
    action: "read",
  });
  expect(requests).toHaveLength(2);
});

it("keeps a refusal that rests on a settled ground correctable, never final, when the review keeps it", async () => {
  const requests = scripted([
    decision({
      outcome: "deny",
      rationale: "Running the example again needs retry permission.",
      refusal: "final",
      refusalGround: "retry_permission",
    }),
    decision({
      outcome: "deny",
      rationale: "Running the example again needs retry permission.",
      refusal: "final",
      refusalGround: "retry_permission",
    }),
  ]);
  const reviewed = await Effect.runPromise(guardian().review(correctedExample, reader));
  expect(reviewed.decision).toEqual({
    outcome: "deny",
    rationale: "Running the example again needs retry permission.",
    refusal: "correctable",
  });
  expect(requests).toHaveLength(2);
});

it("still refuses a step that would commit a confirmed write a second time", async () => {
  const requests = scripted([
    decision({
      outcome: "deny",
      rationale: "This submits the create form again.",
      action: "write",
      refusal: "correctable",
      refusalGround: "committed_write",
    }),
  ]);
  const reviewed = await Effect.runPromise(guardian().review(afterConfirmedWrite, reader));
  expect(reviewed.decision).toEqual({
    outcome: "deny",
    rationale: "This submits the create form again.",
    action: "write",
    refusal: "correctable",
  });
  expect(requests).toHaveLength(1);
});

it("still refuses an unrelated read after a confirmed write", async () => {
  const requests = scripted([
    decision({
      outcome: "deny",
      rationale: "Opens the account's billing pages, which the task does not concern.",
      action: "read",
      refusal: "correctable",
    }),
  ]);
  const reviewed = await Effect.runPromise(guardian().review(afterConfirmedWrite, reader));
  expect(reviewed.decision).toEqual({
    outcome: "deny",
    rationale: "Opens the account's billing pages, which the task does not concern.",
    action: "read",
    refusal: "correctable",
  });
  expect(requests).toHaveLength(1);
});

it("keeps a retry-permission refusal when the host grants no retry", async () => {
  const requests = scripted([
    decision({
      outcome: "deny",
      rationale: "Running the example again needs retry permission.",
      refusal: "final",
      refusalGround: "retry_permission",
    }),
  ]);
  const reviewed = await Effect.runPromise(
    guardian().review(
      {
        ...correctedExample,
        mintContext: { ...correctedExample.mintContext!, repeatableRead: false },
      },
      reader,
    ),
  );
  expect(reviewed.decision).toEqual({
    outcome: "deny",
    rationale: "Running the example again needs retry permission.",
    refusal: "final",
  });
  expect(requests).toHaveLength(1);
});

it("keeps the committed-write refusal when the review answers the pushback with a write allow", async () => {
  const requests = scripted([
    decision({
      outcome: "deny",
      rationale: "This would submit the create form again.",
      action: "read",
      refusal: "final",
      refusalGround: "committed_write",
    }),
    decision({ outcome: "allow", rationale: "Submits the form.", action: "write" }),
  ]);
  const reviewed = await Effect.runPromise(guardian().review(afterConfirmedWrite, reader));
  expect(reviewed.decision).toEqual({
    outcome: "deny",
    rationale: "This would submit the create form again.",
    action: "read",
    refusal: "correctable",
  });
  expect(requests).toHaveLength(2);
});

it("keeps refusing an unrelated read that the review refuses again on its own ground after the pushback", async () => {
  const requests = scripted([
    decision({
      outcome: "deny",
      rationale: "Opens the account's billing pages after the create.",
      action: "read",
      refusal: "correctable",
      refusalGround: "committed_write",
    }),
    decision({
      outcome: "deny",
      rationale: "Opens the account's billing pages, which the task does not concern.",
      action: "read",
      refusal: "correctable",
    }),
  ]);
  const reviewed = await Effect.runPromise(guardian().review(afterConfirmedWrite, reader));
  expect(reviewed.decision).toEqual({
    outcome: "deny",
    rationale: "Opens the account's billing pages, which the task does not concern.",
    action: "read",
    refusal: "correctable",
  });
  expect(requests).toHaveLength(2);
});

it("sends back an escalation on a settled ground too", async () => {
  const requests = scripted([
    decision({
      outcome: "escalate",
      rationale: "Ask the host for retry permission.",
      refusal: "correctable",
      refusalGround: "retry_permission",
    }),
    decision({ outcome: "allow", rationale: "Reads the category list.", action: "read" }),
  ]);
  const reviewed = await Effect.runPromise(guardian().review(correctedExample, reader));
  expect(reviewed.decision).toEqual({
    outcome: "allow",
    rationale: "Reads the category list.",
    action: "read",
  });
  expect(requests).toHaveLength(2);
});

it("allows an act step whose own authority grants the write, once told a missing-write-authority refusal is settled", async () => {
  const requests = scripted([
    decision({
      outcome: "deny",
      rationale: "The allowed effects prohibit all writes, so sending the form is out of authority.",
      action: "write",
      refusal: "final",
      refusalGround: "write_authority",
    }),
    decision({ outcome: "allow", rationale: "Sends the quote form once.", action: "write" }),
  ]);
  const reviewed = await Effect.runPromise(guardian().review(actWithAuthority, reader));
  expect(reviewed.decision).toEqual({
    outcome: "allow",
    rationale: "Sends the quote form once.",
    action: "write",
  });
  expect(requests).toHaveLength(2);
});

it("keeps a missing-write-authority refusal correctable, never final, on a step with write authority", async () => {
  const refusal = decision({
    outcome: "deny",
    rationale: "The allowed effects prohibit all writes, so sending the form is out of authority.",
    action: "write",
    refusal: "final",
    refusalGround: "write_authority",
  });
  const requests = scripted([refusal, refusal]);
  const reviewed = await Effect.runPromise(guardian().review(actWithAuthority, reader));
  expect(reviewed.decision).toEqual({
    outcome: "deny",
    rationale: "The allowed effects prohibit all writes, so sending the form is out of authority.",
    action: "write",
    refusal: "correctable",
  });
  expect(requests).toHaveLength(2);
});

it("keeps a missing-write-authority refusal final on a step without write authority", async () => {
  const requests = scripted([
    decision({
      outcome: "deny",
      rationale: "This explore sends the quote form, and the step may only read.",
      action: "write",
      refusal: "final",
      refusalGround: "write_authority",
    }),
  ]);
  for (const step of [exploreWithoutAuthority, { ...exploreWithoutAuthority, writeAuthority: false }]) {
    requests.length = 0;
    const reviewed = await Effect.runPromise(guardian().review(step, reader));
    expect(reviewed.decision).toEqual({
      outcome: "deny",
      rationale: "This explore sends the quote form, and the step may only read.",
      action: "write",
      refusal: "final",
    });
    expect(requests).toHaveLength(1);
  }
});
