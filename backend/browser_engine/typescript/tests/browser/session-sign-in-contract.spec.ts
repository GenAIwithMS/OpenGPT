import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "@playwright/test";
import { chromium } from "playwright";
import { Effect } from "effect";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { primaryPageCode } from "../../src/runtime/host-execute.js";
import { makeSession } from "../../src/standalone/session.js";
import { makeRunSignIn } from "../../src/standalone/session-sign-in.js";
import { sessionSignInContract, shopSignIn } from "../support/session-sign-in-contract.js";
import { shopAccount, startShop } from "./shop-fixture.js";

// The re-sign-in contract on the local host's adapter: a run's sign-in on the controlled shop,
// on local Chromium, with the shop's sign-in recorded as a run's published recipe.

/** The shop's one-screen sign-in as the local recorder publishes it. */
const shopRecipe = (origin: string) => ({
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
    },
  ],
  signedIn: { selector: shopSignIn.signedIn },
});

/** Answers the login question with the shop's account. */
const ask = makeInputAsker((request) =>
  Effect.succeed(
    Object.fromEntries(
      request.questions.map((question) => [
        question.id,
        { username: shopAccount.username, password: shopAccount.password, saveLogin: false },
      ]),
    ),
  ),
);

for (const contract of sessionSignInContract)
  test(contract.name, async () => {
    test.setTimeout(180_000);
    const directory = await mkdtemp(join(tmpdir(), "opengpt-sign-in-contract-"));
    const shop = await startShop(directory);
    const server = await chromium.launchServer({
      args: [
        `--host-resolver-rules=MAP ${shop.hostname} 127.0.0.1`,
        "--no-proxy-server",
        "--ignore-certificate-errors",
      ],
    });
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* makeSession({
              ask,
              browser: { endpoint: server.wsEndpoint() },
              policy: "Allow the controlled shop.",
            });
            const { browser } = session;
            const signIn = makeRunSignIn(
              session,
              { recipe: shopRecipe(shop.origin), entryUrl: `${shop.origin}${shopSignIn.loginPath}` },
              shop.origin,
              [],
            );
            yield* signIn.before;
            const hook = signIn.hook();
            // The runtime's automatic first call, before the script runs.
            yield* hook({ untilMs: Date.now() + 60_000, stop: new AbortController().signal });
            const page = (code: string) =>
              Effect.runPromise(browser.execute(`${primaryPageCode(browser.targetId)}\n${code}`, 30));
            yield* Effect.promise(() =>
              contract.run(shop, {
                signIn: (bound) => Effect.runPromise(hook(bound)),
                load: async (url) => {
                  await page(
                    `await primary.goto(${JSON.stringify(url)}, { waitUntil: "domcontentloaded" });`,
                  );
                },
                signedInHere: async () =>
                  (await page(
                    `return (await primary.locator(${JSON.stringify(shopSignIn.signedIn)}).count()) > 0;`,
                  )) === true,
                url: async () => String(await page("return primary.url();")),
              }),
            );
          }),
        ),
      );
    } finally {
      await server.close();
      await shop.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
