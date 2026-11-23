import { Effect, Exit } from "effect";
import { expect, it } from "vitest";
import {
  validateAnswer,
  type InputAsker,
  type InputRequest,
} from "../../src/runtime/input-request.js";
import { localSignInLogin } from "../../src/standalone/authentication.js";

// The local host's login request lets the owner go on without signing in, and their answer ends
// the sign-in as their decline, which the minter hears as a result, never as a failed sign-in.
it("offers a decline on the first login request and fails the sign-in with the owner's answer", async () => {
  const asked: InputRequest[] = [];
  const registered: string[] = [];
  const ask: InputAsker = (request) =>
    Effect.sync(() => {
      asked.push(request);
      return validateAnswer(request, { login: { declined: "public_only", saveLogin: false } });
    }).pipe(
      Effect.flatMap((answers) =>
        answers._tag === "Right" ? Effect.succeed(answers.right) : Effect.die(answers.left),
      ),
    );
  const login = localSignInLogin({
    ask,
    register: (value) => registered.push(value),
    siteOrigin: "https://www.example.test",
  });
  const exit = await Effect.runPromiseExit(login.values);
  expect(asked[0]?.questions[0]).toMatchObject({ type: "credential", allowDecline: true });
  expect(exit).toEqual(Exit.fail(expect.objectContaining({ loginDeclined: "public_only" })));
  expect(registered).toEqual([]);
  expect(login.held()).toBeUndefined();
});
