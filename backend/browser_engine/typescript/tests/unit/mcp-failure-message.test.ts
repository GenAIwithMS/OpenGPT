import { APIError } from "openai";
import { Cause, Effect } from "effect";
import { expect, it } from "vitest";
import { SignInRunFailed } from "../../src/runtime/sign-in-replay.js";
import { makeMcpJobs, mcpFailureMessage } from "../../src/standalone/mcp-jobs.js";

const mintFallback =
  "Operation failed. Check the local model, browser and integration configuration.";
const runFallback = "Operation failed. Check the local browser and integration configuration.";

it("keeps minting's fallback failure message", () => {
  const cause = Cause.fail(new Error("Unclassified failure"));
  expect(mcpFailureMessage(cause)).toBe(mintFallback);
  expect(mcpFailureMessage(cause, "mint")).toBe(mintFallback);
});

it("gives a run's fallback failure no model, because a run makes no model request", () => {
  const message = mcpFailureMessage(Cause.fail(new Error("Unclassified failure")), "run");
  expect(message).toBe(runFallback);
  expect(message).not.toContain("model");
});

it("names a model key the provider rejects, and a rate limit, from the provider's own error", () => {
  const authentication =
    "Model provider authentication failed. Check the server's model configuration.";
  const rejected = { message: "Incorrect API key provided: sk_live_FAKEabcdefghijkl" };
  expect(
    mcpFailureMessage(
      Cause.fail(
        APIError.generate(
          401,
          { error: { ...rejected, code: "invalid_api_key" } },
          undefined,
          new Headers(),
        ),
      ),
    ),
  ).toBe(authentication);
  // The provider's code survives the message's credential redaction, with no status beside it.
  expect(
    mcpFailureMessage(
      Cause.fail(Object.assign(new Error(rejected.message), { code: "invalid_api_key" })),
    ),
  ).toBe(authentication);
  expect(
    mcpFailureMessage(
      Cause.fail(
        APIError.generate(
          429,
          { error: { message: "Rate limit reached." } },
          undefined,
          new Headers(),
        ),
      ),
    ),
  ).toBe("Model provider quota or rate limit was reached.");
});

it("reports a failed run job with the run message", async () => {
  const view = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* makeMcpJobs(1, "run");
        const started = yield* jobs.start(() => Effect.fail(new Error("Unclassified failure")));
        let current = yield* jobs.get(started.job_id, 500);
        for (let attempt = 0; attempt < 5 && current.status === "running"; attempt++)
          current = yield* jobs.get(started.job_id, 500);
        return current;
      }),
    ),
  );
  expect(view).toMatchObject({
    status: "failed",
    error: `${runFallback} A dispatched website action may have taken effect; this job will not be replayed.`,
  });
});

it("says why a run's sign-in failed and what to do, naming the field and never a value", () => {
  expect(
    mcpFailureMessage(
      Cause.fail(new SignInRunFailed({ code: "CredentialsRejected", reason: "password" })),
      "run",
    ),
  ).toBe(
    "Sign-in failed (CredentialsRejected): The website rejected the password given for this sign-in, and the run sends it no more. Run the tool again with the right value.",
  );
  expect(
    mcpFailureMessage(
      Cause.fail(new SignInRunFailed({ code: "MissingRecipe", reason: "unknown_version" })),
      "run",
    ),
  ).toBe(
    "Sign-in failed (MissingRecipe): The tool's saved sign-in can't be read (unknown version), so the tool doesn't run signed out. Build the tool again.",
  );
});

it("reports a run job whose sign-in failed without warning of a website action, since the operation never ran", async () => {
  const view = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* makeMcpJobs(1, "run");
        const started = yield* jobs.start(() =>
          Effect.fail(new SignInRunFailed({ code: "CredentialsRejected", reason: "password" })),
        );
        let current = yield* jobs.get(started.job_id, 500);
        for (let attempt = 0; attempt < 5 && current.status === "running"; attempt++)
          current = yield* jobs.get(started.job_id, 500);
        return current;
      }),
    ),
  );
  expect(view).toMatchObject({
    status: "failed",
    error:
      "Sign-in failed (CredentialsRejected): The website rejected the password given for this sign-in, and the run sends it no more. Run the tool again with the right value.",
  });
});
