import { cp, mkdir, writeFile } from "node:fs/promises";
import { Effect } from "effect";

const copy = (from: string, to: string) =>
  Effect.tryPromise(() => cp(from, to, { recursive: true }));

/** The runtime source set, computed by the built package itself, as static data beside it. */
const writeRuntimeSources = Effect.gen(function* () {
  const built = new URL("../dist/typescript/src/execution/runtime-sources.js", import.meta.url);
  const sources: unknown = yield* Effect.tryPromise(() => import(built.href));
  const manifest: unknown = Reflect.get(Object(sources), "runtimeSourcesManifest");
  const path: unknown = Reflect.get(Object(sources), "runtimeSourcesManifestPath");
  if (typeof manifest !== "function" || typeof path !== "string")
    return yield* Effect.fail(new Error("The built package has no runtime source manifest"));
  const data: unknown = manifest();
  yield* Effect.tryPromise(() => writeFile(path, `${JSON.stringify(data, null, 2)}\n`));
});

Effect.runPromise(
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      mkdir("dist/typescript/src/guardian", { recursive: true }),
    );
    yield* copy("typescript/authoring", "dist/typescript/authoring");
    yield* copy(
      "typescript/src/guardian/upstream-policy.md",
      "dist/typescript/src/guardian/upstream-policy.md",
    );
    yield* writeRuntimeSources;
  }),
).catch((error: unknown) => {
  process.stderr.write(`Could not copy package assets: ${String(error)}\n`);
  process.exitCode = 1;
});
