import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { chromium } from "playwright";
import { Effect } from "effect";
import { makeInputAsker } from "../../src/inputs/callback.js";
import {
  InputRequestFailure,
  type InputAnswers,
  type InputRequest,
} from "../../src/runtime/input-request.js";
import { primaryPageCode } from "../../src/runtime/host-execute.js";
import { makeSession } from "../../src/standalone/session.js";
import { makeRunSignIn } from "../../src/standalone/session-sign-in.js";
import { shopSignIn } from "../support/session-sign-in-contract.js";
import { shopAccount, shopCode, startShop } from "./shop-fixture.js";

// A login the site rejected during an automatic sign-in is never sent again by the next one: the
// next sign-in asks for a correction before it types anything. A rejected code is asked fresh,
// with the login kept. The shop shows its error under the form, which the recipe records as the
// login screen's rejection marker, and the corrections a field gets, two, last until a sign-in
// verifies.

const shopRecipe = (origin: string, code: boolean) => ({
  version: 1 as const,
  steps: [
    {
      page: `${origin}${shopSignIn.loginPath}`,
      fields: [
        { selector: shopSignIn.username, accepts: ["username" as const] },
        { selector: shopSignIn.password, slot: "password" as const },
      ],
      submit: shopSignIn.submit,
      submittedBy: "host" as const,
      rejectedMarkers: [{ slot: "password" as const, selector: "#login-error" }],
    },
    ...(code
      ? [
          {
            page: `${origin}/two-factor`,
            fields: [{ selector: "input[name=code]", slot: "code" as const }],
            submit: "button",
            submittedBy: "host" as const,
          },
        ]
      : []),
  ],
  signedIn: { selector: shopSignIn.signedIn },
});

/**
 * Signs a run in from a signed-in browser with a login it never reads, then signs the shop out
 * twice and calls the script's sign-in after each. `answer` answers each question in order, by
 * its kind (a login question's reason, or `code`), with the password or code, or leaves it
 * unanswered with `undefined`. With `code`, the shop asks for a code after the login. Returns the
 * questions' kinds, the two answers, and the login and code posts each sign-in sent.
 */
const signedOutTwice = async (
  answer: (kind: string, nth: number) => string | undefined,
  code = false,
) => {
  const directory = await mkdtemp(join(tmpdir(), "opengpt-sign-in-rejected-"));
  const shop = await startShop(directory);
  const server = await chromium.launchServer({
    args: [
      `--host-resolver-rules=MAP ${shop.hostname} 127.0.0.1`,
      "--no-proxy-server",
      "--ignore-certificate-errors",
    ],
  });
  const asked: string[] = [];
  const ask = makeInputAsker((request: InputRequest) =>
    Effect.suspend((): Effect.Effect<InputAnswers, InputRequestFailure> => {
      const question = request.questions[0];
      const kind = question?.type === "credential" ? question.reason : (question?.id ?? "other");
      asked.push(kind);
      const given = answer(kind, asked.filter((seen) => seen === kind).length);
      if (given === undefined) return Effect.fail(new InputRequestFailure({ code: "NoResponse" }));
      if (question?.type !== "credential") return Effect.succeed({ [kind]: given });
      return Effect.succeed({
        login: { username: shopAccount.username, password: given, saveLogin: false },
      });
    }),
  );
  try {
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeSession({
            ask,
            browser: { endpoint: server.wsEndpoint() },
            policy: "Allow the controlled shop.",
          });
          const { browser } = session;
          const page = (code: string) =>
            browser.execute(`${primaryPageCode(browser.targetId)}\n${code}`, 30);
          // The browser starts signed in, and the shop sends a signed-in visit to its sign-in page
          // on to the account, so the run's own sign-in reads no login.
          yield* page(`await primary.goto(${JSON.stringify(`${shop.origin}/login`)});
await primary.fill("input[name=username]", ${JSON.stringify(shopAccount.username)});
await primary.fill("input[name=password]", ${JSON.stringify(shopAccount.password)});
await primary.click("button");
await primary.locator("#account").waitFor({ timeout: 10000 });`);
          shop.state.signedInLogin = "account";
          shop.state.loginError = true;
          const signIn = makeRunSignIn(
            session,
            { recipe: shopRecipe(shop.origin, code), entryUrl: `${shop.origin}/login` },
            shop.origin,
            [],
          );
          yield* signIn.before;
          expect(asked).toEqual([]);
          const hook = signIn.hook();
          const bound = () => ({ untilMs: Date.now() + 120_000, stop: new AbortController().signal });
          yield* hook(bound());
          shop.state.signOutOn = "/orders";
          shop.state.loginCode = code;
          const answers: unknown[] = [];
          const posts: number[] = [];
          const codePosts: number[] = [];
          for (const _ of [1, 2]) {
            const postsBefore = shop.state.loginPosts;
            const codesBefore = shop.state.codePosts;
            yield* page(`await primary.goto(${JSON.stringify(`${shop.origin}/orders`)});`);
            answers.push(yield* hook(bound()));
            posts.push(shop.state.loginPosts - postsBefore);
            codePosts.push(shop.state.codePosts - codesBefore);
          }
          return { asked, answers, posts, codePosts };
        }),
      ),
    );
  } finally {
    await server.close();
    await shop.close();
    await rm(directory, { recursive: true, force: true });
  }
};

const wrong = `${shopAccount.password}-wrong`;

test("an automatic sign-in after one whose login the site rejected asks for a correction before it types", async () => {
  test.setTimeout(180_000);
  // The first login the run reads is wrong. The first correction goes unanswered, and the next
  // one gives the right password.
  const run = await signedOutTwice((reason, nth) =>
    reason === "missing_credentials" ? wrong : nth === 1 ? undefined : shopAccount.password,
  );
  expect(run.answers).toEqual([
    { outcome: "refused", cause: "session_sign_in_failed" },
    { outcome: "signed_in", signedInAgain: true },
  ]);
  // The wrong login goes out once. The next sign-in asks for the correction first and sends
  // only it.
  expect(run.posts).toEqual([1, 1]);
  expect(run.asked).toEqual(["missing_credentials", "invalid_credentials", "invalid_credentials"]);
});

test("a correction that repeats the login the site rejected is asked again before anything is typed", async () => {
  test.setTimeout(180_000);
  // The first correction gives the rejected password again, and the one asked after it goes
  // unanswered.
  const run = await signedOutTwice((reason, nth) =>
    reason === "missing_credentials" || nth === 1 ? wrong : undefined,
  );
  // Both corrections are spent, so the next sign-in refuses before it types the rejected login.
  expect(run.answers).toEqual([
    { outcome: "refused", cause: "session_sign_in_failed" },
    { outcome: "refused", cause: "session_sign_in_failed" },
  ]);
  // The rejected password goes out only the first time.
  expect(run.posts).toEqual([1, 0]);
  expect(run.asked).toEqual(["missing_credentials", "invalid_credentials", "invalid_credentials"]);
});

test("corrections that keep repeating the login the site rejected refuse the sign-in, typing nothing", async () => {
  test.setTimeout(180_000);
  const run = await signedOutTwice((reason, nth) =>
    reason === "invalid_credentials" && nth === 1 ? undefined : wrong,
  );
  expect(run.answers).toEqual([
    { outcome: "refused", cause: "session_sign_in_failed" },
    { outcome: "refused", cause: "session_sign_in_failed" },
  ]);
  // The next sign-in's correction is the last of two, and it repeats the rejected password.
  expect(run.posts).toEqual([1, 0]);
  expect(run.asked).toEqual(["missing_credentials", "invalid_credentials", "invalid_credentials"]);
});

test("a code the site rejected during an automatic sign-in leaves the login as it was: the next sign-in asks only for a fresh code", async () => {
  test.setTimeout(180_000);
  // The login is right. The first code is wrong, and the code the screen then asks for again goes
  // unanswered. The next sign-in's code is right.
  const run = await signedOutTwice(
    (kind, nth) =>
      kind === "missing_credentials"
        ? shopAccount.password
        : kind === "code"
          ? nth === 1
            ? "000000"
            : nth === 2
              ? undefined
              : shopCode
          : undefined,
    true,
  );
  expect(run.answers).toEqual([
    { outcome: "refused", cause: "session_sign_in_failed" },
    { outcome: "signed_in", signedInAgain: true },
  ]);
  // The same login goes out again, with no correction asked, and then the fresh code.
  expect(run.asked).toEqual(["missing_credentials", "code", "code", "code"]);
  expect(run.posts).toEqual([1, 1]);
  expect(run.codePosts).toEqual([1, 1]);
});
