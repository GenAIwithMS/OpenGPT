// Failure modes covered: a question or task update review is asked for the execution outcomes
// (allow, deny or escalate) beside its own, so the model returns one its kind refuses; a review
// that returns an outcome its kind refuses is retried with backoff as an outage, from the same
// input, for as long as the retry budget lasts, instead of being told once which outcomes count;
// a host kind's allow carries a label its policy gives only to a deny, and the host acts on it;
// a write build's task update review reads its empty allowedEffects as a read-only build; the
// reviews disagree about what an owner's answer authorizes.
import { OpenAIProvider, setDefaultModelProvider, Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import {
  guardianExecutionPolicy,
  nativeExecutionEnvironment,
} from "../../src/guardian/execution-policy.js";
import { answerSecurityExceptions } from "../../src/guardian/answer-exceptions.js";
import { guardianPublicationPolicy } from "../../src/guardian/publication.js";
import { guardianActions } from "../../src/guardian/review-contracts.js";
import { guardianOutcomes } from "../../src/guardian/review-layout.js";
import { makeGuardian, ReviewFailure as ReviewFailureClass } from "../../src/guardian/review.js";
import { workspaceOriginReview } from "../../src/guardian/sign-in-origin-reviews.js";
import type {
  GuardianDiagnostics,
  HostReview,
  PendingExecution,
  Reviewer,
  ReviewFailure,
  ReviewRetry,
} from "../../src/guardian/review.js";
import type { PendingQuestion } from "../../src/guardian/question.js";
import type { PendingTaskUpdate } from "../../src/guardian/task-update.js";

afterEach(() => setDefaultModelProvider(new OpenAIProvider()));

const native = { executionEnvironment: nativeExecutionEnvironment };
const quickRetry: ReviewRetry = { delays: ["1 millis"], budget: "1 minute" };

const pending: PendingExecution = {
  invocationId: "outcome_job",
  attemptId: "outcome_attempt",
  entrypoint: "operation/operation.mjs",
  screenedIntent: "Order the plan the owner picks from the plans the site lists.",
  screenedInput: "{}",
  screenedObservations: "Synthetic fixture",
  accountScope: "account_outcomes",
  allowedOrigins: ["https://plans.example.test"],
  allowedEffects: ["read"],
};
const question: PendingQuestion = {
  questions: [
    {
      id: "plan",
      type: "choice",
      prompt: "Which plan?",
      options: [{ label: "Basic" }, { label: "Plus" }],
    },
  ],
  credentialsAvailable: false,
};
const update: PendingTaskUpdate = {
  summary: "Order the Plus plan instead of the Basic plan.",
  changes: [{ setting: "input", values: { plan: "Plus" } }],
  recommend: "update",
  confirmation: [{ question: "Which plan?", answer: "Plus" }],
  effect: "read",
};
const source = JSON.stringify({
  kind: "untrusted_source",
  path: pending.entrypoint,
  byteOffset: 0,
  nextOffset: 22,
  hasMore: false,
  source: "export default () => 1;",
});
const readSource = () => Effect.succeed(source);

const decision = (outcome: string, action: string | null = null): ModelResponse["output"] => [
  {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [
      {
        type: "output_text",
        text: JSON.stringify({
          outcome,
          rationale: `Synthetic ${outcome}.`,
          reason: null,
          findings: null,
          label: null,
          action,
        }),
      },
    ],
  },
];

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

/** The host's review request: the first user message, the JSON review input. */
const reviewRequest = (request: ModelRequest | undefined) => {
  const input = request?.input;
  const items = typeof input === "string" ? [{ role: "user", content: input }] : (input ?? []);
  for (const item of items) {
    const content = "role" in item && item.role === "user" ? item.content : undefined;
    if (typeof content === "string" && content.startsWith("{"))
      return JSON.parse(content) as {
        trusted_review: { kind: string; policy: string; outcomes?: readonly string[] };
      };
  }
  throw new Error("No review request");
};

const recording = () => {
  const names: string[] = [];
  const record: GuardianDiagnostics["emit"] = (name) => Effect.sync(() => void names.push(name));
  const diagnostics: GuardianDiagnostics = {
    emit: record,
    retainModelTranscript: record,
    retainScreenedSource: () => Effect.void,
  };
  return { names, diagnostics };
};

type Guardian = ReturnType<typeof makeGuardian>;
type Review = (
  guardian: Guardian,
) => Effect.Effect<{ readonly decision: { readonly outcome: string } }, ReviewFailure>;

const kinds: Record<"question" | "update" | "execution", Review> = {
  question: (guardian) =>
    guardian.reviewQuestion(pending, question, readSource),
  update: (guardian) =>
    guardian.reviewTaskUpdate(pending, update, readSource),
  execution: (guardian) => guardian.review(pending, readSource),
};

const guardianWith = (diagnostics?: GuardianDiagnostics) =>
  makeGuardian(
    { ...makeOpenAIReviewer("{{ tenant_policy_config }}", false, native), retry: quickRetry },
    diagnostics,
  );

it.each([
  ["question", "allow", "reword"],
  ["update", "deny", "clarify"],
  ["execution", "reword", "deny"],
] as const)(
  "tells a %s review once, in the same review, that %s is not its outcome, and takes the next",
  async (kind, refused, accepted) => {
    const requests = scripted([decision(refused), decision(accepted)]);
    const { names, diagnostics } = recording();
    const reviewed = await Effect.runPromise(kinds[kind](guardianWith(diagnostics)));
    expect(reviewed.decision).toMatchObject({ outcome: accepted });
    expect(requests).toHaveLength(2);
    expect(names.filter((name) => name === "guardian.started")).toHaveLength(1);
    expect(names).not.toContain("guardian.review_retried");
  },
);

it.each([
  ["question", "allow", "reword"],
  ["update", "escalate", "allow"],
  ["execution", "allow_business", "deny"],
] as const)(
  "ends a %s review that returns %s again after the correction, without reviewing again",
  async (kind, refused, accepted) => {
    // A third response the host would accept: reviewing again would reach it.
    const requests = scripted([decision(refused), decision(refused), decision(accepted)]);
    const { names, diagnostics } = recording();
    const result = await Effect.runPromise(Effect.either(kinds[kind](guardianWith(diagnostics))));
    expect(result).toMatchObject({ _tag: "Left", left: { code: "InvalidOutcome" } });
    expect(requests).toHaveLength(2);
    expect(names).not.toContain("guardian.review_retried");
    expect(names.filter((name) => name === "guardian.failed")).toHaveLength(1);
  },
);

/** The host's last message in a request: a follow-up after the review's first output. */
const lastUserText = (request: ModelRequest | undefined) => {
  const input = request?.input;
  const items = typeof input === "string" ? [{ role: "user", content: input }] : (input ?? []);
  const texts = items.flatMap((item) =>
    "role" in item && item.role === "user" && typeof item.content === "string"
      ? [item.content]
      : [],
  );
  return texts.at(-1) ?? "";
};

// The correction said only which outcomes the kind returns, not which one it refused, and named
// none for what the reviewer seemed to want, so a reviewer that meant the agent should change or
// ask first answered with another kind's outcome again. Its failure named no outcome either.
it.each([
  [
    "execution",
    "reword",
    "The host did not accept this decision: reword is not an outcome an execution review returns. It returns only allow, deny, escalate, as trusted_review.outcomes lists. Decide this review again under its policy and return one of them. A step that should change before it runs, or that needs the caller first, is a deny or an escalate, as its policy says.",
    "The outcome reword is not one an execution review returns",
  ],
  [
    "question",
    "deny",
    "The host did not accept this decision: deny is not an outcome a question review returns. It returns only allow_business, authentication, reword, as trusted_review.outcomes lists. Decide this review again under its policy and return one of them. A request that should change before its caller sees it is a reword.",
    "The outcome deny is not one a question review returns",
  ],
  [
    "update",
    "escalate",
    "The host did not accept this decision: escalate is not an outcome an update review returns. It returns only allow, clarify, reword, new_mint, as trusted_review.outcomes lists. Decide this review again under its policy and return one of them. An update that needs the caller's confirmation and lacks it or gives it ambiguously is a clarify, and one that is wrong as written is a reword.",
    "The outcome escalate is not one an update review returns",
  ],
] as const)(
  "names the refused outcome in a %s review's correction and failure",
  async (kind, refused, correction, failure) => {
    const requests = scripted([decision(refused), decision(refused)]);
    const result = await Effect.runPromise(Effect.either(kinds[kind](guardianWith())));
    expect(lastUserText(requests[1])).toBe(correction);
    expect(result).toMatchObject({
      _tag: "Left",
      left: { code: "InvalidOutcome", failureDetail: { underlying: { message: failure } } },
    });
  },
);

/**
 * A reviewer that answers every review, and the follow-up the host sends after it, with one
 * outcome, keeping each follow-up the host sends.
 */
const answering = (outcome: string) => {
  const followUps: string[] = [];
  const reviewer: Reviewer = {
    run: (turn) =>
      Effect.sync(() => {
        const raw = { outcome, rationale: `Synthetic ${outcome}.` };
        const followUp = turn.followUp?.(raw);
        if (followUp !== undefined) followUps.push(followUp);
        return raw;
      }),
  };
  return { followUps, guardian: makeGuardian(reviewer) };
};

const publicationScope = {
  files: [
    {
      path: pending.entrypoint,
      byteLength: 22,
      published: true,
      current: true,
      owner: "minter" as const,
    },
  ],
};

// A recovery or publication review's correction named no outcome that holds a change first, and
// a host-defined kind's could have named one its own policy never gives.
it.each([
  [
    "recovery",
    (guardian: Guardian) => guardian.reviewRecovery(pending, "The browser froze.", readSource),
    "The host did not accept this decision: reword is not an outcome a recovery review returns. It returns only allow, deny, escalate, as trusted_review.outcomes lists. Decide this review again under its policy and return one of them. A request for a new browser that should not be granted is a deny.",
    "The outcome reword is not one a recovery review returns",
  ],
  [
    "publication",
    (guardian: Guardian) =>
      guardian.review({ ...pending, publication: publicationScope }, readSource),
    "The host did not accept this decision: reword is not an outcome a publication review returns. It returns only allow, deny, escalate, as trusted_review.outcomes lists. Decide this review again under its policy and return one of them. A tool that should change before it publishes is a deny.",
    "The outcome reword is not one a publication review returns",
  ],
  [
    "host-defined",
    (guardian: Guardian) => guardian.reviewHostKind(pending, tiered),
    "The host did not accept this decision: reword is not an outcome a synthetic_tier review returns. It returns only allow, deny, as trusted_review.outcomes lists. Decide this review again under its policy and return one of them.",
    "The outcome reword is not one a host review returns",
  ],
] as const)("corrects a %s review's refused outcome once, naming it", async (_kind, run, correction, failure) => {
  const { followUps, guardian } = answering("reword");
  const result = await Effect.runPromise(
    Effect.either(run(guardian) as Effect.Effect<unknown, ReviewFailure>),
  );
  expect(followUps).toEqual([correction]);
  expect(result).toMatchObject({
    _tag: "Left",
    left: { code: "InvalidOutcome", failureDetail: { underlying: { message: failure } } },
  });
});

// A private kind's readable records keep nothing of its exchange: no correction, and a failure
// that names no outcome.
it("fails a private host kind's refused outcome at once, naming no outcome", async () => {
  const { followUps, guardian } = answering("reword");
  const result = await Effect.runPromise(
    Effect.either(guardian.reviewHostKind(pending, { ...tiered, private: true })),
  );
  expect(followUps).toEqual([]);
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      code: "InvalidOutcome",
      failureDetail: { underlying: { message: "The outcome is not one a host review returns" } },
    },
  });
});

// Outcomes that are only outcome names: `allow` is also a verb every policy uses, and
// `authentication` is also an execution's action label.
const outcomeNames = guardianOutcomes.filter(
  (outcome) => outcome !== "allow" && !(guardianActions as readonly string[]).includes(outcome),
);

it.each([
  ["question", "reword"],
  ["update", "clarify"],
  ["execution", "deny"],
] as const)("asks a %s review only for the outcomes the host accepts from it", async (kind, any) => {
  const requests = scripted([decision(any)]);
  await Effect.runPromise(kinds[kind](guardianWith()));
  const { outcomes: offered, policy } = reviewRequest(requests[0]).trusted_review;
  expect(offered?.length).toBeGreaterThan(0);
  for (const outcome of guardianOutcomes) {
    const answered = scripted([
      decision(outcome, kind === "execution" ? "read" : null),
      decision(outcome, kind === "execution" ? "read" : null),
    ]);
    const result = await Effect.runPromise(Effect.either(kinds[kind](guardianWith())));
    if (offered?.includes(outcome)) {
      expect(result).toMatchObject({ _tag: "Right", right: { decision: { outcome } } });
      expect(answered).toHaveLength(1);
    } else {
      expect(result).toMatchObject({ _tag: "Left", left: { code: "InvalidOutcome" } });
      // The kind's own policy never names an outcome the host refuses from it.
      expect(policy?.length).toBeGreaterThan(0);
      if (kind !== "execution" && outcomeNames.includes(outcome))
        expect(policy).not.toMatch(new RegExp(`\\b${outcome}\\b`));
    }
  }
});

// A write build confirming a page default before its first act step: the host gives the review
// the build's effect and an empty allowedEffects, and the policy says the empty list, like the
// read-only effects of earlier exploration reviews, says nothing about the build's effect.
it("tells a write build's task update review that its empty allowedEffects says nothing of its effect", async () => {
  const requests = scripted([decision("allow")]);
  const reviewed = await Effect.runPromise(
    guardianWith().reviewTaskUpdate(
      { ...pending, allowedEffects: [] },
      { ...update, effect: "write" },
      readSource,
    ),
  );
  expect(reviewed.decision).toMatchObject({ outcome: "allow" });
  const request = reviewRequest(requests[0]) as unknown as {
    trusted_review: { policy: string };
    trusted_authority: { allowedEffects: readonly string[] };
    update_review: { effect: string };
  };
  expect(request.trusted_authority.allowedEffects).toEqual([]);
  expect(request.update_review.effect).toBe("write");
  expect(request.trusted_review.policy).toContain(
    "The host sets update_review.effect, not the agent. When it is write, the build is already a write build: no change needs to make it one, and the confirmation need not cover the write. In a task update review, trusted_authority.allowedEffects is empty on purpose, because an update performs no action on the site. That empty list, and the read-only allowedEffects of earlier exploration reviews, say nothing about the build's effect.",
  );
});

// The reviews disagreed about an owner's answer: a question review let the agent ask the owner to
// confirm a step, the next execution review refused the confirmed step, and the task update review
// refused the update that cited the answer. Every review that weighs an answer now names the same
// actions no answer authorizes.
it("names the same actions no answer authorizes in every review that weighs an owner's answer", async () => {
  const requests = scripted([decision("allow_business"), decision("allow")]);
  const g = guardianWith();
  await Effect.runPromise(g.reviewQuestion(pending, question, readSource));
  await Effect.runPromise(g.reviewTaskUpdate(pending, update, readSource));
  for (const policy of [
    reviewRequest(requests[0]).trusted_review.policy,
    reviewRequest(requests[1]).trusted_review.policy,
    guardianExecutionPolicy(nativeExecutionEnvironment),
    guardianPublicationPolicy,
  ])
    expect(policy).toContain(answerSecurityExceptions);
});

const labelled = (outcome: string, label: string): ModelResponse["output"] => [
  {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [
      {
        type: "output_text",
        text: JSON.stringify({
          outcome,
          rationale: `Synthetic ${outcome} ${label}.`,
          reason: null,
          findings: null,
          label,
          action: null,
        }),
      },
    ],
  },
];

// A host kind that ties its labels to its outcomes, readable so the host may correct it.
const tiered: HostReview = {
  kind: "synthetic_tier",
  policy: "Synthetic tier policy: allow with label open or listed, deny with label closed.",
  evidence: { origin: "https://acme.example.com" },
  outcomes: ["allow", "deny"],
  labels: ["open", "listed", "closed"],
  outcomeLabels: { allow: ["open", "listed"], deny: ["closed"] },
};

it("tells a host kind once, in the same review, that its outcome does not carry that label, and takes the next", async () => {
  const requests = scripted([labelled("allow", "closed"), labelled("allow", "listed")]);
  const { names, diagnostics } = recording();
  const reviewed = await Effect.runPromise(guardianWith(diagnostics).reviewHostKind(pending, tiered));
  expect(reviewed.decision).toMatchObject({ outcome: "allow", label: "listed" });
  expect(requests).toHaveLength(2);
  expect(names.filter((name) => name === "guardian.started")).toHaveLength(1);
  expect(names).not.toContain("guardian.review_retried");
});

it("ends a host kind that pairs an outcome with another outcome's label again after the correction", async () => {
  const requests = scripted([
    labelled("deny", "open"),
    labelled("deny", "open"),
    labelled("deny", "closed"),
  ]);
  const result = await Effect.runPromise(
    Effect.either(
      makeGuardian(makeOpenAIReviewer("{{ tenant_policy_config }}", false, native)).reviewHostKind(
        pending,
        tiered,
      ),
    ),
  );
  expect(result).toMatchObject({ _tag: "Left", left: { code: "InvalidDecision" } });
  expect(requests).toHaveLength(2);
});

it.each([
  [{ outcome: "allow", label: "workspace" }, true],
  [{ outcome: "allow", label: "shared_host" }, true],
  [{ outcome: "deny", label: "unrecognized" }, true],
  [{ outcome: "allow", label: "unrecognized" }, false],
  [{ outcome: "deny", label: "workspace" }, false],
  [{ outcome: "deny", label: "shared_host" }, false],
] as const)("a workspace_origin decision %o is accepted: %s", async (raw, accepted) => {
  const review = workspaceOriginReview({
    siteOrigin: "https://app.example.com",
    parent: "example.com",
    candidateOrigin: "https://acme.example.com",
    path: [],
    sentBefore: "identifier",
    intent: pending.screenedIntent,
  });
  const result = await Effect.runPromise(
    Effect.either(
      makeGuardian({
        run: () => Effect.succeed({ ...raw, rationale: "Synthetic decision." }),
      }).reviewHostKind(pending, review),
    ),
  );
  expect(result).toMatchObject(
    accepted
      ? { _tag: "Right", right: { decision: raw } }
      : { _tag: "Left", left: { code: "InvalidDecision" } },
  );
});

it("gives an outcome, a decode and two read corrections in one review, and no more", async () => {
  // The host's own read of the entrypoint fails, so an allow needs Guardian's read, which the
  // scripted model never does.
  let hostRead = true;
  const reader = () =>
    Effect.suspend(() => {
      const host = hostRead;
      hostRead = false;
      return host
        ? Effect.fail(new ReviewFailureClass({ code: "SourceUnavailable" }))
        : readSource();
    });
  const requests = scripted([
    decision("reword"),
    // An execution allow without an action label does not decode.
    decision("allow"),
    decision("allow", "read"),
    decision("allow", "read"),
    decision("allow", "read"),
    decision("allow", "read"),
  ]);
  const { names, diagnostics } = recording();
  const result = await Effect.runPromise(
    Effect.either(guardianWith(diagnostics).review(pending, reader)),
  );
  expect(result).toMatchObject({ _tag: "Left", left: { code: "EntrypointNotRead" } });
  expect(requests).toHaveLength(5);
  expect(names.filter((name) => name === "guardian.started")).toHaveLength(1);
  expect(names).not.toContain("guardian.review_retried");
});

it("reviews a private host kind's undecodable decision once more, with no follow-up", async () => {
  const labelled = (label: string): ModelResponse["output"] => [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: JSON.stringify({
            outcome: "allow",
            rationale: "Synthetic allow.",
            reason: null,
            findings: null,
            label,
            action: null,
          }),
        },
      ],
    },
  ];
  const request: HostReview = {
    kind: "synthetic_private_kind",
    policy: "Synthetic private policy.",
    evidence: {},
    outcomes: ["allow", "deny"],
    labels: ["synthetic_label_a", "synthetic_label_b"],
    private: true,
  };
  const run = async (responses: readonly ModelResponse["output"][]) => {
    const requests = scripted(responses);
    const { names, diagnostics } = recording();
    const result = await Effect.runPromise(
      Effect.either(guardianWith(diagnostics).reviewHostKind(pending, request, readSource)),
    );
    return { requests, names, result };
  };
  const recovered = await run([labelled("synthetic_label_c"), labelled("synthetic_label_a")]);
  expect(recovered.result).toMatchObject({
    _tag: "Right",
    right: { decision: { label: "synthetic_label_a" } },
  });
  expect(recovered.names.filter((name) => name === "guardian.started")).toHaveLength(2);

  // A third response the host would accept: a second retry would reach it.
  const failed = await run([
    labelled("synthetic_label_c"),
    labelled("synthetic_label_c"),
    labelled("synthetic_label_a"),
  ]);
  expect(failed.result).toMatchObject({ _tag: "Left", left: { code: "InvalidDecision" } });
  expect(failed.requests).toHaveLength(2);
  expect(failed.names.filter((name) => name === "guardian.started")).toHaveLength(2);
  expect(failed.names.filter((name) => name === "guardian.review_retried")).toHaveLength(1);
});
