import { Effect, type Scope } from "effect";
import type { OpenGPT, BrowserEngineOptions } from "./contracts.js";
import { makeSession } from "./session.js";
import { requestContext } from "./request-context.js";
import { mintRequest } from "./mint-host.js";
import { runOperation } from "./run-operation.js";
import { issueFileHandles } from "../mint/file-handles.js";
import { isLocalFileReference, openLocalFile } from "../execution/local-files.js";
export { Artifact } from "./contracts.js";
export type {
  OpenGPT,
  BrowserEngineOptions,
  BrowserEngineRequest,
  MintArtifact,
  MintOutcome,
  LocalMintOutcome,
} from "./contracts.js";
/** A scoped session owns its browser, so a minted operation can run in the same signed-in session. */
export const createBrowserEngine = (
  options: BrowserEngineOptions,
): Effect.Effect<OpenGPT, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const session = yield* makeSession(options);
    const mint: OpenGPT["mint"] = (request) =>
      session.mutex.withPermits(1)(
        Effect.scoped(
          Effect.gen(function* () {
            // The build sees each of the caller's files as a handle, never its reference.
            const issued = yield* issueFileHandles(
              request.input ?? {},
              isLocalFileReference,
              openLocalFile,
            );
            const handled = { ...request, input: issued.input };
            const context = yield* requestContext(session, handled);
            return yield* mintRequest(session, context, handled, issued.handles);
          }),
        ),
      );
    const run: OpenGPT["run"] = (artifact, request) =>
      session.mutex.withPermits(1)(Effect.scoped(runOperation(session, artifact, request)));
    return { mint, run };
  });
