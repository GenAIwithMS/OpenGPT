import { createHash } from "node:crypto";
import { Effect } from "effect";
import { LocalOperationFailure, type LocalOperationOutput } from "../execution/local-operation.js";
import {
  admitListCursor,
  randomListCursorKeys,
  sealListOutput,
  type ListCursorKeys,
  type ListCursorScope,
} from "../runtime/list-cursor.js";
import type { CursorRefusal } from "../runtime/list-page.js";
import type { MintArtifact } from "../mint/input-feedback.js";
import type { BrowserEngineRequest } from "./contracts.js";
import { runOutcomeFailure } from "./run-report.js";
import type { StandaloneSession } from "./session.js";

// The local host's list cursors. Without keys of its own, a process signs with a random key it
// keeps while it runs, so a served MCP's cursors work across its calls and end with it.

let processKeys: ListCursorKeys | undefined;

/** The keys this process signs with: the caller's, else one random key per process. */
export const localListCursorKeys = (configured: ListCursorKeys | undefined) =>
  configured ?? (processKeys ??= randomListCursorKeys());

/** A local tool's cursor scope on its site, dated now. */
export const localListScope = (
  session: Pick<StandaloneSession, "options">,
  operation: string,
  siteOrigin: string,
): ListCursorScope => ({
  keys: localListCursorKeys(session.options.listCursors?.keys),
  operation,
  siteOrigin,
  now: session.options.listCursors?.now?.() ?? Date.now(),
});

/**
 * A minter step's cursor scope: the build's site and the entrypoint it runs. A live test case's
 * page two takes the cursor its page one returned, checked as an example step's is.
 */
export const mintListScope = (
  session: Pick<StandaloneSession, "options">,
  siteOrigin: string,
  entrypoint: string,
) => localListScope(session, `mint\0${siteOrigin}\0${entrypoint}`, siteOrigin);

/** An artifact's cursors are bound to its site and its files, which a new build replaces. */
const artifactScope = (
  session: StandaloneSession,
  artifact: MintArtifact,
  siteOrigin: string,
): ListCursorScope => {
  const files = createHash("sha256");
  for (const { path, content } of [...artifact.files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  ))
    files.update(path).update("\0").update(content).update("\0");
  return localListScope(
    session,
    `${siteOrigin}\0${artifact.entrypoint}\0${files.digest("hex")}`,
    siteOrigin,
  );
};

/** A refused cursor as the local runner's own refused input: nothing reached the site. */
export const refusedCursor = (admission: {
  readonly reason: CursorRefusal;
  readonly message: string;
}) =>
  new LocalOperationFailure(
    admission.message,
    { effect: "not_sent", commits: [] },
    "InvalidInput",
    "InvalidInput",
    undefined,
    { refusal: { field: "cursor", kind: admission.reason } },
  );

/**
 * What a run of `artifact` gets beside its input: the position its cursor holds, once checked. A
 * refused cursor fails the run as a refused input before anything reaches the site.
 */
export const admitArtifactCursor = (
  session: StandaloneSession,
  artifact: MintArtifact,
  siteOrigin: string,
  request: Pick<BrowserEngineRequest, "input"> & { readonly effect?: "read" | "write" },
) =>
  Effect.suspend(() => {
    const admission = admitListCursor(
      request.input ?? {},
      artifactScope(session, artifact, siteOrigin),
    );
    return admission.ok
      ? Effect.succeed(admission.list)
      : Effect.fail(runOutcomeFailure(request.effect, "operation")(refusedCursor(admission)));
  });

/**
 * The run's output with its next cursor signed for the caller. A next position the host could
 * not sign leaves `next_cursor` null, with `next_cursor_unavailable` saying why.
 */
export const sealArtifactOutput = (
  session: StandaloneSession,
  artifact: MintArtifact,
  siteOrigin: string,
  request: Pick<BrowserEngineRequest, "input">,
  result: LocalOperationOutput,
): LocalOperationOutput => ({
  ...result,
  output: sealListOutput(
    result.output,
    request.input ?? {},
    artifactScope(session, artifact, siteOrigin),
  ).output,
});
