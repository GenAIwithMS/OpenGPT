import { Effect, Schema } from "effect";
import { ExpectedConfirms } from "../browser/dialogs/expected.js";
import { autofillRecipePath } from "../destinations/autofill-recipe.js";
import { decodeSignInRecipe, signInRecipeText } from "../destinations/sign-in-recipe.js";
import { createLocalWorkspace } from "../execution/local-workspace.js";
import { localError, localRelativePath } from "../execution/local-path.js";
import { ScriptQuestionDeclarations } from "../runtime/script-input.js";
import { SignInRunFailed } from "../runtime/sign-in-replay.js";
import { Artifact, PageUrl, SignInOrigin, type MintArtifact } from "./contracts.js";

const Metadata = Schema.Struct({
  entrypoint: Schema.String,
  files: Schema.Array(Schema.String),
  inputSchema: Schema.Unknown,
  outputSchema: Schema.Unknown,
  /**
   * Where the build's sign-in recipe is (`auth-fill.json`), where its runs start and the build's
   * https sign-in origins.
   */
  signIn: Schema.optionalWith(
    Schema.Struct({
      recipe: Schema.Literal(autofillRecipePath),
      entryUrl: PageUrl,
      authenticationOrigins: Schema.optionalWith(Schema.Array(SignInOrigin), { exact: true }),
    }),
    { exact: true },
  ),
  /** The questions publication reviewed, the only ones a run asks. */
  questions: Schema.optionalWith(ScriptQuestionDeclarations, { exact: true }),
  /** The confirm popups a write's build accepted, as digests its runs accept without asking. */
  acceptedConfirms: Schema.optionalWith(ExpectedConfirms, { exact: true }),
});
/** The artifact's own files beside its source, which no source path may name. */
const metadataFiles = new Set(["integration.json", autofillRecipePath]);
const HttpUrl = Schema.String.pipe(
  Schema.filter((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
    );
  }),
);
export const Deployment = Schema.Struct({
  name: Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9_]{0,63}$/)),
  description: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4096)),
  request: Schema.Struct({
    url: HttpUrl,
    intent: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(16384)),
    effect: Schema.Literal("read", "write"),
    authenticationOrigins: Schema.optionalWith(Schema.Array(HttpUrl), { exact: true }),
  }),
});
export type Deployment = typeof Deployment.Type;

export const validateArtifact = (value: unknown) =>
  Schema.decodeUnknown(Artifact)(value).pipe(
    Effect.tap((artifact) =>
      Effect.try({
        try: () => {
          const paths = artifact.files.map((file) => localRelativePath(file.path));
          if (paths.some((path) => metadataFiles.has(path.split("/")[0]?.toLowerCase() ?? "")))
            throw new Error("Artifact source collides with its metadata file");
          if (
            new Set(paths).size !== paths.length ||
            !paths.includes(localRelativePath(artifact.entrypoint))
          )
            throw new Error("Artifact requires unique files and a listed entrypoint");
        },
        catch: localError,
      }),
    ),
    Effect.mapError(localError),
  );

export const readArtifact = (directory: string) =>
  Effect.gen(function* () {
    const workspace = yield* createLocalWorkspace({ root: directory });
    const metadata = yield* workspace
      .read("integration.json")
      .pipe(
        Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(Metadata))),
        Effect.mapError(localError),
      );
    const files = yield* Effect.forEach(metadata.files, (path) =>
      workspace.read(path).pipe(Effect.map((content) => ({ path, content }))),
    );
    const { signIn, ...source } = metadata;
    if (signIn === undefined) return yield* validateArtifact({ ...source, files });
    // A recipe this host cannot read fails the artifact: it never runs signed out instead.
    const text = yield* workspace
      .read(signIn.recipe)
      .pipe(
        Effect.mapError(() => new SignInRunFailed({ code: "MissingRecipe", reason: "missing" })),
      );
    const recipe = decodeSignInRecipe(text);
    if (recipe === "invalid" || recipe === "unknown_version")
      return yield* new SignInRunFailed({ code: "MissingRecipe", reason: recipe });
    return yield* validateArtifact({ ...source, files, signIn: { ...signIn, recipe } });
  });

export const writeArtifact = (directory: string, artifact: MintArtifact) =>
  Effect.gen(function* () {
    const checked = yield* validateArtifact(artifact);
    const workspace = yield* createLocalWorkspace({ root: directory });
    for (const file of checked.files) yield* workspace.write(file.path, file.content);
    if (checked.signIn !== undefined)
      yield* workspace.write(autofillRecipePath, signInRecipeText(checked.signIn.recipe));
    yield* workspace.write(
      "integration.json",
      `${JSON.stringify(
        {
          entrypoint: checked.entrypoint,
          files: checked.files.map((file) => file.path),
          inputSchema: checked.inputSchema,
          outputSchema: checked.outputSchema,
          ...(checked.signIn === undefined
            ? {}
            : { signIn: { ...checked.signIn, recipe: autofillRecipePath } }),
          ...(checked.questions === undefined ? {} : { questions: checked.questions }),
          ...(checked.acceptedConfirms === undefined
            ? {}
            : { acceptedConfirms: checked.acceptedConfirms }),
        },
        null,
        2,
      )}\n`,
    );
  });

export const readIntegration = (directory: string) =>
  Effect.gen(function* () {
    const workspace = yield* createLocalWorkspace({ root: directory });
    const deployment = yield* workspace
      .read("deployment.json")
      .pipe(
        Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(Deployment))),
        Effect.mapError(localError),
      );
    return { artifact: yield* readArtifact(directory), deployment };
  });
