import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import { makePlaywrightExecutor } from "../execution/playwright-execute.js";
import { makeRunSecrets, registerSecretAnswer } from "../inputs/secrets.js";
import { localRuntimeAssets } from "../execution/local-runtime-assets.js";
import type { InputAsker } from "../runtime/input-request.js";
import type { SessionTyping } from "./authentication.js";
import type { BrowserEngineOptions } from "./contracts.js";
import { error, mintError } from "./errors.js";
export const makeSession = (options: BrowserEngineOptions) =>
  Effect.gen(function* () {
    if (options.browser !== undefined && "cdp" in options.browser)
      return yield* Effect.fail(
        new Error(
          "The local host doesn't attach over CDP: its runs close other tabs and reset site data in the browser. Use endpoint or a launched browser.",
        ),
      );
    const browser = yield* makePlaywrightExecutor(options.browser);
    const policy =
      options.policy ??
      (yield* Effect.tryPromise({
        try: () => readFile(new URL("../guardian/upstream-policy.md", import.meta.url), "utf8"),
        catch: error,
      }));
    const secrets = makeRunSecrets();
    yield* Effect.addFinalizer(() => Effect.sync(secrets.clear));
    const mutex = yield* Effect.makeSemaphore(1);
    const trustedSources = new Map(yield* localRuntimeAssets);
    const projection = {
      text: (value: string) => Effect.sync(() => secrets.redact(value)),
      json: (value: unknown) => secrets.json(value).pipe(Effect.mapError(mintError)),
      source: (_path: string, value: string) =>
        secrets.assertAbsent(value).pipe(Effect.as(value), Effect.mapError(mintError)),
    };
    const ask: InputAsker = (request, bounds) =>
      options.ask(request, bounds).pipe(
        Effect.tap((answers) =>
          Effect.sync(() => {
            for (const [id, answer] of Object.entries(answers)) {
              if (answer.type === "secret") {
                const question = request.questions.find((candidate) => candidate.id === id);
                registerSecretAnswer(
                  secrets,
                  question?.type === "secret" ? question.secretKind : undefined,
                  answer.value,
                );
              }
              if (answer.type === "credential") {
                if (answer.value.username !== undefined) secrets.register(answer.value.username);
                if (answer.value.password !== undefined) secrets.register(answer.value.password);
              }
            }
          }),
        ),
      );
    // One typing memory for the session's browser, across every build on it.
    const signInTyping: SessionTyping = { typed: false };
    return {
      options,
      browser,
      policy,
      secrets,
      mutex,
      trustedSources,
      projection,
      ask,
      signInTyping,
    };
  });
export type StandaloneSession = Effect.Effect.Success<ReturnType<typeof makeSession>>;
