import { Effect } from "effect";
import { localError } from "./local-path.js";
import type { LocalWorkspace } from "./local-workspace.js";
import { getRuntimeSources } from "./runtime-sources.js";

/**
 * Trusted SDK assets are separate from the exact reviewed authored-source snapshot: every module
 * `opengpt-browser-engine/runtime` loads, at its path from the source root, and the workspace's own
 * `runtime/index.js` over them. Native mint workspaces and execution children share it.
 */
export const localRuntimeAssets: Effect.Effect<readonly (readonly [string, string])[], Error> =
  Effect.try({
    try: () => [
      ...getRuntimeSources(),
      // Authored operations keep their established ../../runtime/index.js import.
      ["runtime/index.js", 'export * from "../browser/index.js";\n'] as const,
    ],
    catch: localError,
  });
export const seedLocalRuntime = (workspace: LocalWorkspace) =>
  localRuntimeAssets.pipe(
    Effect.flatMap((files) =>
      Effect.forEach(files, ([path, text]) => workspace.install(path, text), { discard: true }),
    ),
  );
