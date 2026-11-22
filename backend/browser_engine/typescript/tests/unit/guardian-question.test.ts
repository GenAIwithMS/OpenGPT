// Failure modes covered: the question review lacks the execution review's trusted context or
// screened evidence tool; its evidence reads are unbounded; a question review demands an
// entrypoint read; rewording never ends; answers, credential values or full account-specific
// labels reach the reviewer.
import { OpenAIProvider, setDefaultModelProvider, Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import { nativeExecutionEnvironment } from "../../src/guardian/execution-policy.js";
import { answersForReview, questionForReview } from "../../src/guardian/question.js";
import type { PendingQuestion } from "../../src/guardian/question.js";
import { ReviewFailure, makeGuardian } from "../../src/guardian/review.js";
import type { PendingExecution, Reviewer, ReviewTurn } from "../../src/guardian/review.js";
import { makeSourceInspector } from "../../src/guardian/source.js";
import type { InputRequest } from "../../src/runtime/input-request.js";

const native = { executionEnvironment: nativeExecutionEnvironment };

afterEach(() => setDefaultModelProvider(new OpenAIProvider()));

const observedPath = `/search?term=${"blue".repeat(700)}#results`;
const pending: PendingExecution = {
  invocationId: "question_job",
  attemptId: "question_attempt",
  entrypoint: "operation/operation.mjs",
  screenedIntent: "Book the cheapest plan the site offers for my team.",
  screenedInput: '{"team":"[private field withheld]"}',
  screenedObservations: "Entry page loaded.",
  accountScope: "account_a",
  allowedOrigins: ["https://plans.example.test"],
  allowedEffects: ["read plans"],
  mintContext: {
    repeatableRead: false,
    operationSources: ["operation/operation.mjs"],
    browser: "active",
    captureIndex: "captures/index.json",
    currentPage: {
      origin: "https://plans.example.test",
      path: observedPath,
      capture: "captures/pricing/capture.json",
    },
    executions: [
      {
        executionId: "explore_1",
        attempt: "current",
        purpose: "explore",
        target: "liveBrowser",
        status: "completed",
        effect: "verified",
      },
    ],
  },
};
const question: PendingQuestion = {
  questions: [
    {
      id: "plan",
      type: "choice",
      prompt: "Which plan?",
      options: [{ label: "Team" }, { label: "Business" }],
    },
    { id: "seats", type: "text", prompt: "How many seats?" },
  ],
  credentialsAvailable: false,
};

const message = (value: unknown): ModelResponse["output"][number] => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: JSON.stringify(value) }],
});
/** The host's JSON review input, the first user message of a request. */
const userText = (request: ModelRequest | undefined): string => {
  const input = request?.input;
  if (typeof input === "string") return input;
  const first = input?.find((item) => "role" in item && item.role === "user");
  const content = first !== undefined && "content" in first ? first.content : undefined;
  if (typeof content === "string") return content;
  throw new Error("No user input");
};

/** The policy the review's own message carries for its kind. */
const reviewPolicyOf = (request: ModelRequest | undefined) =>
  (JSON.parse(userText(request)) as { trusted_review: { policy: string } }).trusted_review.policy;

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

it("reviews a question with the execution context and the bounded capture reader", async () => {
  // Larger than one 64 KiB chunk: the reader must return a bounded first chunk.
  const capture = JSON.stringify({ plans: "Team $10 Business $20 ".repeat(5_000) });
  const captures = new Map([
    ["captures/index.json", '{"manifests":["captures/pricing/capture.json"]}'],
    ["captures/pricing/capture.json", capture],
  ]);
  const inspector = makeSourceInspector(
    (path) =>
      Effect.suspend(() => {
        const source = captures.get(path);
        return source === undefined
          ? Effect.fail(new ReviewFailure({ code: "SourceUnavailable" }))
          : Effect.succeed(new TextEncoder().encode(source));
      }),
    (_path, bytes) => Effect.succeed(new TextDecoder().decode(bytes)),
  );
  const reads: string[] = [];
  const requests = scripted([
    [
      {
        type: "function_call",
        callId: "call_1",
        name: "read_source",
        arguments: JSON.stringify({ path: "captures/pricing/capture.json", offset: 0 }),
        status: "completed",
      },
    ],
    [message({ outcome: "allow_business", rationale: "Plan choice needs the user." })],
  ]);
  const result = await Effect.runPromise(
    makeGuardian(makeOpenAIReviewer("{{ tenant_policy_config }}", false, native)).reviewQuestion(
      pending,
      question,
      (path, offset) =>
        inspector(path, offset).pipe(Effect.tap((chunk) => Effect.sync(() => reads.push(chunk)))),
    ),
  );
  expect(result.decision).toEqual({
    outcome: "allow_business",
    rationale: "Plan choice needs the user.",
  });
  expect(requests).toHaveLength(2);
  expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(["read_source"]);
  const input: unknown = JSON.parse(userText(requests[0]));
  expect(input).toMatchObject({
    trusted_authority: { allowedOrigins: ["https://plans.example.test"] },
    trusted_execution_context: {
      captureIndex: "captures/index.json",
      currentPage: {
        origin: "https://plans.example.test",
        path: observedPath,
        capture: "captures/pricing/capture.json",
      },
      executions: [{ executionId: "explore_1", status: "completed" }],
    },
    question_review: {
      request: { questions: question.questions },
      credentialsAvailable: false,
    },
  });
  // No entrypoint read was needed, and the one evidence read stayed within one chunk.
  expect(reads).toHaveLength(1);
  const chunk: unknown = JSON.parse(reads[0] ?? "");
  expect(chunk).toMatchObject({ hasMore: true, nextOffset: 64 * 1024 });
  expect(JSON.stringify(requests[1]?.input)).toContain("Team $10");
});

const decisions = (outcomes: readonly string[]) => {
  const seen: boolean[] = [];
  const reviewer: Reviewer = {
    run: (turn: ReviewTurn) =>
      Effect.sync(() => {
        seen.push(turn.pending.questionCandidate !== undefined);
        return { outcome: outcomes[seen.length - 1], rationale: "Scripted." };
      }),
  };
  return { reviewer, seen };
};
const unreadable: ReviewTurn["readSource"] = () =>
  Effect.fail(new ReviewFailure({ code: "SourceUnavailable" }));

// Guardian's continuing conversation carries host sign-in rules from earlier reviews, which it
// then quoted as the owner forbidding sign-in when the minter asked which sign-in method to use.
it("tells the question review that host sign-in rules are never an owner's prohibition", async () => {
  const requests = scripted([[message({ outcome: "allow_business", rationale: "Allowed." })]]);
  await Effect.runPromise(
    makeGuardian(makeOpenAIReviewer("{{ tenant_policy_config }}", false, native)).reviewQuestion(
      pending,
      question,
      unreadable,
    ),
  );
  expect(reviewPolicyOf(requests[0])).toContain(
    "Other questions about signing in follow the rules above.\nHost policy about signing in, including text from an earlier review in this conversation, is never an owner's prohibition. Only trusted intent or an owner's answer can forbid signing in. That sign-in is not yet proven required is no reason to reword an account question whose choices match the page.\n",
  );
});

// Without a saved login the host picks no sign-in method, so rewording the minter's question
// whether to sign in by phone or email left the build on the site's default form, not the owner's
// login.
it("allows a question about the sign-in method when the host holds no login", async () => {
  const requests = scripted([[message({ outcome: "allow_business", rationale: "Allowed." })]]);
  await Effect.runPromise(
    makeGuardian(makeOpenAIReviewer("{{ tenant_policy_config }}", false, native)).reviewQuestion(
      pending,
      question,
      unreadable,
    ),
  );
  expect(reviewPolicyOf(requests[0])).toContain(
    "When credentialsAvailable is true, the host chooses the sign-in method: reword a question asking which method to use. When it is false, a question asking which sign-in method to use, such as phone or email, is always allowed when its choices match the page, and encouraged when it is ambiguous. Never allow one offering a passkey. A question asking where a code is sent, such as text or email, is allowed when nothing the caller gave names one and its choices match the page. Reword it when it names choices the page does not show.",
  );
  expect(reviewPolicyOf(requests[0])).not.toContain(
    "reword a question asking which method to use, and never allow one offering a passkey",
  );
});

// A repair's report that the caller's value was at fault was reworded as asking the user for
// something, and the caller lost the reason.
it("allows a blocked report that names the caller input at fault and why", async () => {
  const requests = scripted([[message({ outcome: "allow_business", rationale: "Allowed." })]]);
  await Effect.runPromise(
    makeGuardian(makeOpenAIReviewer("{{ tenant_policy_config }}", false, native)).reviewQuestion(
      pending,
      { ...question, blockedOutcome: true },
      unreadable,
    ),
  );
  expect(reviewPolicyOf(requests[0])).toContain(
    'or when it asks the user for anything; the agent then revises or withdraws it. A report that starts "Caller input error:" is allowed when it names the input value at fault and why the site cannot fulfil it, in the site\'s own words where the site showed any. Saying what kind of value would work, such as a future date or a neighborhood the site lists, is part of that reason, not a request to the user. The rules below apply to questions, not to this report.\n',
  );
});

// A repair asked whether the caller's refused value was invalid or real, and the question review
// reworded it to offer a replacement value. The host keeps a repair's input fixed, so that answer
// could never apply.
it("keeps a repair's caller-input question to invalid or real", async () => {
  const requests = scripted([[message({ outcome: "allow_business", rationale: "Allowed." })]]);
  await Effect.runPromise(
    makeGuardian(makeOpenAIReviewer("{{ tenant_policy_config }}", false, native)).reviewQuestion(
      pending,
      question,
      unreadable,
    ),
  );
  expect(reviewPolicyOf(requests[0])).toContain(
    "\nA repair's caller-input question asks only whether the caller's value is invalid or real. Don't reword it to offer a replacement value, since a repair can't change the run's input.\n",
  );
  expect(reviewPolicyOf(requests[0])).toContain(
    "\n- without question_review.scriptAsk, the agent's own question while it builds, other than a repair's caller-input question: evidence ",
  );
});

// The question review rejected the read-or-write question as redundant when trusted intent already
// leaned read-only, and objected to the answer labels the host sets itself, so the build could
// never get past its required first question.
it("tells the question review the read-or-write question is required and its labels are the host's", async () => {
  const requests = scripted([[message({ outcome: "allow_business", rationale: "Allowed." })]]);
  await Effect.runPromise(
    makeGuardian(makeOpenAIReviewer("{{ tenant_policy_config }}", false, native)).reviewQuestion(
      pending,
      question,
      unreadable,
    ),
  );
  expect(reviewPolicyOf(requests[0])).toContain(
    "\n- the request is one choice between the host's two answers, keeping the build read-only or making it a write build: the build's first question, asked before any website access, whether the requested tool only looks things up or changes something on the website. Allow it when its prompt says plainly what the tool would do; reword it when the prompt asks for anything more, such as a value or private detail the user would type in their own words. The host requires this question and sets its two answer labels, so judge only the prompt and prefer allow when it plainly says what the tool would do, even when trusted intent already leans one way. A write build does the requested task once, for real, while it builds, so a prompt may say so.\n",
  );
});

// The question review saw no build effect, since its allowedEffects is empty on purpose, so it
// rejected the true statement that a write build publishes only after it does the task for real.
it.each(["read", "write"] as const)(
  "gives the question review a %s build's effect as host context",
  async (buildEffect) => {
    const requests = scripted([[message({ outcome: "allow_business", rationale: "Allowed." })]]);
    const candidate = await Effect.runPromise(
      questionForReview(
        { questions: [{ id: "blocked", type: "text", prompt: "Publishing needs one real run." }] },
        { credentialsAvailable: false, blockedOutcome: true, buildEffect },
        (text) => Effect.succeed(text),
      ),
    );
    await Effect.runPromise(
      makeGuardian(makeOpenAIReviewer("{{ tenant_policy_config }}", false, native)).reviewQuestion(
        pending,
        candidate,
        unreadable,
      ),
    );
    const input = JSON.parse(userText(requests[0])) as {
      question_review: { buildEffect?: unknown };
    };
    expect(input.question_review.buildEffect).toBe(buildEffect);
    expect(reviewPolicyOf(requests[0])).toContain(
      "\nWhen question_review.buildEffect is write, the build publishes only after it does the requested task once, for real, with the person's values. A question or report that says so is true, so prefer allow for that statement.\n",
    );
  },
);

it("leaves the build effect out of a question review whose host sends none", async () => {
  const requests = scripted([[message({ outcome: "allow_business", rationale: "Allowed." })]]);
  await Effect.runPromise(
    makeGuardian(makeOpenAIReviewer("{{ tenant_policy_config }}", false, native)).reviewQuestion(
      pending,
      question,
      unreadable,
    ),
  );
  const input = JSON.parse(userText(requests[0])) as { question_review: object };
  expect(input.question_review).not.toHaveProperty("buildEffect");
});

// Guardian judged a blocked report about a refused publication from the agent's words alone.
it("gives the question review the host's publication refusals as trusted evidence", async () => {
  const refusal = {
    decisionId: "decision_one",
    outcome: "refused",
    code: "PublicationUnavailable",
    reason: "write_not_submitted",
    executionId: "act_one",
    decidedAt: 1_000,
    failedChecks: ["write_not_submitted"],
    recovery: "write_completion",
  } as const;
  const requests = scripted([[message({ outcome: "allow_business", rationale: "Allowed." })]]);
  const candidate = await Effect.runPromise(
    questionForReview(
      {
        questions: [
          { id: "blocked", type: "text", prompt: "The site never took the request as asked." },
        ],
      },
      { credentialsAvailable: false, blockedOutcome: true, publicationDecisions: [refusal] },
      (text) => Effect.succeed(text),
    ),
  );
  await Effect.runPromise(
    makeGuardian(makeOpenAIReviewer("{{ tenant_policy_config }}", false, native)).reviewQuestion(
      pending,
      candidate,
      unreadable,
    ),
  );
  const input = JSON.parse(userText(requests[0])) as {
    question_review: { publicationDecisions?: unknown };
  };
  expect(input.question_review.publicationDecisions).toEqual([refusal]);
});

// A blocked report that cited an earlier denial was judged without it: the denial survived only in
// Guardian's own compacted conversation.
it("gives the blocked-explanation review the host's decision ledger as trusted evidence", async () => {
  const ledger = {
    denials: [
      {
        review: "execution",
        decidedAt: 1_000,
        outcome: "deny",
        reviewId: "review_one",
        rationale: "The call creates server-side state, so it is a write.",
      },
    ],
    testCounts: { pass: 0, fail: 2, inconclusive: 0 },
    testFailures: [
      { caseId: "case-1", verdict: "fail", toolReported: { errorClass: "SiteRefusal" } },
      { caseId: "case-2", verdict: "fail", toolReported: { errorClass: "SiteRefusal" } },
    ],
  } as const;
  const requests = scripted([[message({ outcome: "allow_business", rationale: "Allowed." })]]);
  const candidate = await Effect.runPromise(
    questionForReview(
      {
        questions: [
          { id: "blocked", type: "text", prompt: "Guardian refused the call the site requires." },
        ],
      },
      { credentialsAvailable: false, blockedOutcome: true, decisionLedger: ledger },
      (text) => Effect.succeed(text),
    ),
  );
  await Effect.runPromise(
    makeGuardian(makeOpenAIReviewer("{{ tenant_policy_config }}", false, native)).reviewQuestion(
      pending,
      candidate,
      unreadable,
    ),
  );
  const input = JSON.parse(userText(requests[0])) as {
    question_review: { decisionLedger?: unknown };
  };
  expect(input.question_review.decisionLedger).toEqual(ledger);
});

it("rejects a question candidate smuggled into an execution review", async () => {
  const { reviewer, seen } = decisions(["allow"]);
  const result = await Effect.runPromise(
    makeGuardian(reviewer)
      .review({ ...pending, questionCandidate: question }, unreadable)
      .pipe(Effect.either),
  );
  expect(result).toMatchObject({ _tag: "Left", left: { code: "InvalidDecision" } });
  expect(seen).toEqual([]);
});

it("reviews every string the caller will see, screened, but no host-held login detail", async () => {
  const request: Pick<InputRequest, "notice" | "questions"> = {
    notice: "Approve the sign-in on your phone.",
    questions: [
      {
        id: "card",
        type: "choice",
        prompt: "Which saved card?",
        options: [
          {
            id: "c1",
            label: "Visa ending 4242 for Jane Doe",
            accountSpecific: true,
            maskedLabel: "Visa ••42",
          },
          { id: "c2", label: "New card" },
        ],
      },
      {
        id: "dialog",
        type: "confirm",
        prompt: "Rename the report?",
        followUp: { prompt: "New name", defaultText: "Quarterly report" },
      },
      {
        id: "code",
        type: "secret",
        prompt: "Enter the code we texted",
        secretKind: "one_time_code",
      },
      {
        id: "login",
        type: "credential",
        prompt: "Sign in",
        fields: "password",
        reason: "invalid_credentials",
        username: "PRIVATE_USERNAME",
        allowSave: true,
        siteOrigin: "https://PRIVATE_ORIGIN.example.test",
      },
    ],
  };
  const screened = await Effect.runPromise(
    questionForReview(request, { credentialsAvailable: true }, (text) =>
      Effect.succeed(`screened(${text})`),
    ),
  );
  // Every string the caller will see went through the screen; ids and types stay as they were.
  const strings = (value: unknown, key = ""): Array<readonly [string, string]> =>
    typeof value === "string"
      ? [[key, value]]
      : Array.isArray(value)
        ? value.flatMap((item) => strings(item, key))
        : typeof value === "object" && value !== null
          ? Object.entries(value).flatMap(([name, item]) => strings(item, name))
          : [];
  const structural = new Set(["id", "type", "fields", "secretKind"]);
  const shown = strings(screened).filter(([key]) => !structural.has(key));
  expect(shown.filter(([, text]) => !text.startsWith("screened("))).toEqual([]);
  // The notice, four prompts, three option labels, the follow-up prompt and its default text.
  expect(shown).toHaveLength(10);
  expect(screened.questions.map((question) => [question.id, question.type])).toEqual([
    ["card", "choice"],
    ["dialog", "confirm"],
    ["code", "secret"],
    ["login", "credential"],
  ]);
  expect(screened.credentialsAvailable).toBe(true);
  // A host-raised login's username, site, reason and save choice never reach Guardian.
  expect(Object.keys(screened.questions[3] ?? {}).sort()).toEqual([
    "fields",
    "id",
    "prompt",
    "type",
  ]);
  expect(JSON.stringify(screened)).not.toContain("PRIVATE_");
  const requests = scripted([[message({ outcome: "authentication", rationale: "Login." })]]);
  await Effect.runPromise(
    makeGuardian(makeOpenAIReviewer("{{ tenant_policy_config }}", false, native)).reviewQuestion(
      pending,
      screened,
      unreadable,
    ),
  );
  const sent = userText(requests[0]);
  expect(sent).toContain("screened(New name)");
  expect(sent).toContain("screened(Quarterly report)");
  expect(sent).toContain("screened(Visa ending 4242 for Jane Doe)");
  expect(sent).toContain("screened(Visa ••42)");
  expect(sent).not.toMatch(/PRIVATE_/u);
});

// The review saw a multiple choice without its selection bounds, so it kept rewording the
// workspace guide's capability question, which allows zero picks through `minSelections` 0, and
// asked for the field the question already had.
it("gives the question review a multiple choice's selection bounds", async () => {
  const request: Pick<InputRequest, "notice" | "questions"> = {
    questions: [
      {
        id: "extras",
        type: "multi_choice",
        prompt: "Which optional features should the tool support, if any?",
        options: [
          { id: "sort", label: "Sort order" },
          { id: "price", label: "Price range" },
          { id: "brand", label: "Brand" },
        ],
        minSelections: 0,
        maxSelections: 3,
      },
      {
        id: "plan",
        type: "choice",
        prompt: "Which plan?",
        options: [
          { id: "team", label: "Team" },
          { id: "business", label: "Business" },
        ],
      },
    ],
  };
  const candidate = await Effect.runPromise(
    questionForReview(request, { credentialsAvailable: false }, (text) => Effect.succeed(text)),
  );
  expect(candidate.questions[0]).toMatchObject({ minSelections: 0, maxSelections: 3 });
  // A single choice has no bounds to show.
  expect(candidate.questions[1]).not.toHaveProperty("minSelections");
  expect(candidate.questions[1]).not.toHaveProperty("maxSelections");
  const requests = scripted([[message({ outcome: "allow_business", rationale: "Allowed." })]]);
  await Effect.runPromise(
    makeGuardian(makeOpenAIReviewer("{{ tenant_policy_config }}", false, native)).reviewQuestion(
      pending,
      candidate,
      unreadable,
    ),
  );
  const input = JSON.parse(userText(requests[0])) as {
    question_review: { request: { questions: readonly Record<string, unknown>[] } };
  };
  expect(input.question_review.request.questions[0]).toMatchObject({
    type: "multi_choice",
    minSelections: 0,
    maxSelections: 3,
  });
  expect(reviewPolicyOf(requests[0])).toContain(
    "a multiple choice's minSelections and maxSelections, the fewest and most options the user may pick",
  );
});

// Later reviews hear each plain answer with its question, as the minter does, and
// never a protected one, which only the broker or the credential store holds.
it("gives a review every plain answer, screened and masked, and no secret or login", async () => {
  const request: Pick<InputRequest, "questions"> = {
    questions: [
      {
        id: "plan",
        type: "choice",
        prompt: "Which plan?",
        options: [
          { id: "basic", label: "Basic" },
          {
            id: "team",
            label: "Team plan on account 4417",
            accountSpecific: true,
            maskedLabel: "Team plan",
          },
        ],
      },
      {
        id: "size",
        type: "choice",
        prompt: "Which size?",
        allowOther: true,
        options: [{ id: "small", label: "Small" }],
      },
      {
        id: "tier",
        type: "choice",
        prompt: "Which tier?",
        allowOther: true,
        options: [
          { id: "pro_monthly", label: "Pro" },
          { id: "pro_yearly", label: "Pro" },
        ],
      },
      {
        id: "extras",
        type: "multi_choice",
        prompt: "Which extras?",
        minSelections: 0,
        maxSelections: 2,
        options: [
          { id: "sso", label: "Single sign-on" },
          { id: "audit", label: "Audit log" },
        ],
      },
      {
        id: "go",
        type: "confirm",
        prompt: "Continue?",
        followUp: { prompt: "Team name?" },
      },
      { id: "code", type: "secret", secretKind: "one_time_code", prompt: "Code?" },
      {
        id: "login",
        type: "credential",
        prompt: "Sign in",
        fields: "username_password",
        reason: "missing_credentials",
        allowSave: false,
        siteOrigin: "https://plans.example.test",
      },
    ],
  };
  const reviewed = await Effect.runPromise(
    answersForReview(
      request,
      {
        plan: { type: "choice", value: "team" },
        size: { type: "choice", value: { other: "Twelve seats" } },
        // Own text repeating a label two options share stays text.
        tier: { type: "choice", value: { other: "Pro" } },
        extras: { type: "multi_choice", value: ["audit", "sso"] },
        go: { type: "confirm", value: { confirmed: true, text: "Platform" } },
        code: { type: "secret", value: "secret-canary-2718" },
        login: {
          type: "credential",
          value: { username: "owner@example.test", password: "password-canary", saveLogin: false },
        },
      },
      (text) => Effect.succeed(`<${text}>`),
    ),
  );
  expect(reviewed).toEqual([
    { id: "plan", question: "<Which plan?>", answer: "<Team plan>" },
    { id: "size", question: "<Which size?>", answer: "<Twelve seats>" },
    { id: "tier", question: "<Which tier?>", answer: "<Pro>" },
    { id: "extras", question: "<Which extras?>", answer: ["<Audit log>", "<Single sign-on>"] },
    { id: "go", question: "<Continue?>", answer: { confirmed: true, text: "<Platform>" } },
  ]);
});

it("gives a review the owner's own option and note beside their picks, as the owner's own words", async () => {
  const request: Pick<InputRequest, "questions"> = {
    questions: [
      {
        id: "store",
        type: "choice",
        prompt: "Which store?",
        allowOther: true,
        allowNote: true,
        options: [{ id: "main", label: "Main store at https://main.example.test" }],
      },
      {
        id: "regions",
        type: "multi_choice",
        prompt: "Which regions?",
        minSelections: 0,
        maxSelections: 1,
        allowOther: true,
        allowNote: true,
        options: [{ id: "north", label: "North" }],
      },
    ],
  };
  const reviewed = await Effect.runPromise(
    answersForReview(
      request,
      {
        store: {
          type: "choice",
          value: { option: "main", note: "Orders live at https://orders.tenant.example.org" },
        },
        regions: {
          type: "multi_choice",
          value: {
            options: ["north"],
            other: "Islands at https://islands.example.net",
            note: "Weekdays only",
          },
        },
      },
      (text) => Effect.succeed(`<${text}>`),
    ),
  );
  expect(reviewed).toEqual([
    {
      id: "store",
      question: "<Which store?>",
      answer: "<Main store at https://main.example.test>",
      note: "<Orders live at https://orders.tenant.example.org>",
    },
    {
      id: "regions",
      question: "<Which regions?>",
      answer: ["<North>"],
      other: "<Islands at https://islands.example.net>",
      note: "<Weekdays only>",
    },
  ]);
  // A later review carries them to Guardian, and their off-site links name where the owner's work
  // lives.
  const requests = scripted([[message({ outcome: "allow_business", rationale: "Allowed." })]]);
  await Effect.runPromise(
    makeGuardian(makeOpenAIReviewer("{{ tenant_policy_config }}", false, native)).reviewQuestion(
      { ...pending, answeredQuestions: reviewed },
      question,
      unreadable,
    ),
  );
  const input: unknown = JSON.parse(userText(requests[0]));
  expect(input).toMatchObject({
    trusted_authority: {
      answeredQuestions: [
        {
          id: "store",
          answer: "<Main store at https://main.example.test>",
          note: reviewed[0]?.note,
        },
        { id: "regions", answer: ["<North>"], other: reviewed[1]?.other, note: "<Weekdays only>" },
      ],
      ownerNamedOrigins: ["https://orders.tenant.example.org", "https://islands.example.net"],
    },
  });
});

it("takes an off-site origin named only in an option the owner picked or typed back as owner-named", async () => {
  const picked = "Our team's tenant at https://acme.tenant.example.org";
  const typedBack = "Our branch office at https://branch.example.net";
  const reviewed = await Effect.runPromise(
    answersForReview(
      {
        questions: [
          {
            id: "tenant",
            type: "choice",
            prompt: "Where do your orders live?",
            allowOther: true,
            allowNote: true,
            options: [
              { id: "tenant", label: picked },
              { id: "here", label: "On this site" },
            ],
          },
          {
            id: "offices",
            type: "multi_choice",
            prompt: "Which offices?",
            minSelections: 0,
            maxSelections: 2,
            allowOther: true,
            allowNote: true,
            options: [
              { id: "branch", label: typedBack },
              { id: "main", label: "Main office" },
            ],
          },
        ],
      },
      {
        tenant: { type: "choice", value: "tenant" },
        offices: { type: "multi_choice", value: { options: ["main"], note: typedBack } },
      },
      Effect.succeed,
    ),
  );
  const requests = scripted([[message({ outcome: "allow_business", rationale: "Allowed." })]]);
  await Effect.runPromise(
    makeGuardian(makeOpenAIReviewer("{{ tenant_policy_config }}", false, native)).reviewQuestion(
      { ...pending, answeredQuestions: reviewed },
      question,
      unreadable,
    ),
  );
  const input: unknown = JSON.parse(userText(requests[0]));
  // The picked option and the option typed back are the owner's words; the option nobody picked
  // names nothing.
  expect(input).toMatchObject({
    trusted_authority: {
      ownerNamedOrigins: ["https://acme.tenant.example.org", "https://branch.example.net"],
    },
  });
});

// A minter's confirm question beside a notice is the owner's answer to that question, and later
// reviews trust it like any other plain answer.
it("gives a review the owner's confirm answer beside a notice", async () => {
  const request: Pick<InputRequest, "notice" | "questions"> = {
    notice: "Nothing has been submitted yet.",
    questions: [{ id: "approve", type: "confirm", prompt: "Do you approve the site's terms?" }],
  };
  const reviewed = await Effect.runPromise(
    answersForReview(
      request,
      { approve: { type: "confirm", value: { confirmed: true } } },
      Effect.succeed,
    ),
  );
  expect(reviewed).toEqual([
    { id: "approve", question: "Do you approve the site's terms?", answer: { confirmed: true } },
  ]);
});
