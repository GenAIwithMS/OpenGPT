import { Effect, Exit, Scope } from "effect";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import { MintFailure } from "../../src/mint/contracts.js";
import type { MintProjection } from "../../src/mint/projection.js";

/** Scripted mint tests own a local SDK session and close its resource scope. */
export const portableJobSession = async (entries: Readonly<Record<string, string>>) => {
  const scope = await Effect.runPromise(Scope.make());
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void));
  try {
    const workspace = await Effect.runPromise(
      createLocalWorkspace().pipe(Effect.provideService(Scope.Scope, scope)),
    );
    await Effect.runPromise(
      Effect.forEach(Object.entries(entries), ([path, value]) => workspace.write(path, value), {
        discard: true,
      }),
    );
    return Object.assign(workspace.session, {
      close,
      root: workspace.root,
      readFile: ({ path, maxBytes }: { path: string; maxBytes?: number }) =>
        Effect.runPromise(
          workspace.read(path, Math.min(maxBytes ?? 8 * 1024 * 1024, 8 * 1024 * 1024)),
        ),
    });
  } catch (error) {
    await close();
    throw error;
  }
};

/** Synthetic caller secrets exercise the public projection port without a hosted detector. */
export const portableMintProjection = (values: readonly string[] = []): MintProjection => {
  const secrets = makeRunSecrets();
  for (const value of values) secrets.register(value);
  return {
    text: (value) => Effect.sync(() => secrets.redact(value)),
    json: (value) =>
      secrets.json(value).pipe(Effect.mapError(() => new MintFailure({ code: "Unavailable" }))),
    source: (_path, value) => Effect.sync(() => secrets.redact(value)),
  };
};
