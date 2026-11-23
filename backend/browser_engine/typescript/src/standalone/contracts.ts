import type { ModelProvider } from "@openai/agents";
import { type Effect, Schema } from "effect";
import { ExpectedConfirms } from "../browser/dialogs/expected.js";
import { SignInRecipe } from "../destinations/sign-in-recipe.js";
import type { MintOutcome } from "../mint/contracts.js";
import type { MintArtifact } from "../mint/input-feedback.js";
import type { PlaywrightOptions } from "../execution/playwright-execute.js";
import type { InputAsker } from "../runtime/input-request.js";
import type { FileLimits } from "../runtime/files.js";
import type { ListCursorKeys } from "../runtime/list-cursor.js";
import { ScriptQuestionDeclarations } from "../runtime/script-input.js";
export interface BrowserEngineOptions {
  readonly ask: InputAsker;
  /**
   * The browser the host launches or attaches to. It never attaches over CDP (`cdp`): its runs
   * close other tabs and reset site data, which would change a browser it doesn't own. Its browser
   * calls keep the executor's 1 MiB result limit (`resultLimitBytes`).
   */
  readonly browser?: Omit<PlaywrightOptions, "cdp" | "resultLimitBytes">;
  readonly minterProvider?: ModelProvider;
  readonly guardianProvider?: ModelProvider;
  /** The outcome reviewer's model provider, which judges whether each write took effect. */
  readonly outcomeReviewerProvider?: ModelProvider;
  readonly policy?: string;
  readonly timeoutMs?: number;
  /**
   * Files a run places and collects. A caller names its own file by a `file:` URL in the input.
   * A run keeps each downloaded file for 30 minutes and returns its `file:` URL: under
   * `downloads` when given, else in this process's temporary directory, which is removed when
   * the process exits. `limits` caps the bytes (`defaultFileLimits`).
   */
  readonly files?: { readonly downloads?: string; readonly limits?: FileLimits };
  /**
   * How a list tool's cursors are signed and timed. `keys` sign them; without keys, this process
   * signs with a random key, so its cursors work until it exits. `now` is the clock that dates
   * them, `Date.now` by default. A cursor works for ten minutes, and a run refuses one this host did
   * not sign for that tool and those inputs before it signs in or loads a page.
   */
  readonly listCursors?: { readonly keys?: ListCursorKeys; readonly now?: () => number };
}

export interface BrowserEngineRequest {
  readonly intent: string;
  readonly url: string;
  readonly input?: unknown;
  readonly effect?: "read" | "write" | "ask";
  readonly authenticationOrigins?: readonly string[];
}

/**
 * A local mint's outcome. A build no longer sets `untrustedSignInOrigins`: it refuses a sign-in
 * form that submits off the site and `authenticationOrigins` before anything is typed, and counts
 * a screen as sent by its clicked submit. The field stays so older callers still type-check.
 */
export type LocalMintOutcome = MintOutcome & {
  readonly untrustedSignInOrigins?: readonly string[];
};

export interface OpenGPT {
  readonly mint: (request: BrowserEngineRequest) => Effect.Effect<LocalMintOutcome, Error>;
  /**
   * Runs a minted artifact on `url` with no Guardian review and no model request. Guardian
   * reviewed the artifact when it was minted. `intent`, `effect` and `authenticationOrigins` are
   * not checked here, so run only artifacts you minted or trust. Its sign-in types the login on
   * the site, the request's `authenticationOrigins` and the ones the artifact saved in
   * `signIn.authenticationOrigins`, which its build's request declared (a tool an older version
   * built may also hold ones its caller trusted when asked). A read or a confirmed write returns
   * its output. A failed sign-in fails with `SignInRunFailed`, and any other run with
   * `RunOutcomeFailure`, which says what it did to the website and how to retry.
   */
  readonly run: (
    artifact: MintArtifact,
    request: Omit<BrowserEngineRequest, "effect"> & { readonly effect?: "read" | "write" },
  ) => Effect.Effect<unknown, Error>;
}

/** A web page a run can open: an http or https URL with no credentials and no fragment. */
export const PageUrl = Schema.String.pipe(
  Schema.filter((value) => {
    const url = URL.parse(value);
    return (
      url !== null &&
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  }),
);
/** A sign-in origin a tool saves: an https origin exactly as `URL.origin` writes it. */
export const SignInOrigin = Schema.String.pipe(
  Schema.filter((value) => {
    const url = URL.parse(value);
    return url !== null && url.protocol === "https:" && url.origin === value;
  }),
);
export const Artifact = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
  entrypoint: Schema.String,
  inputSchema: Schema.Unknown,
  outputSchema: Schema.Unknown,
  /**
   * The verified sign-in a build recorded: its value-free recipe, where its runs start and the
   * build's https sign-in origins, when it has any.
   */
  signIn: Schema.optionalWith(
    Schema.Struct({
      recipe: SignInRecipe,
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
export type { MintArtifact, MintOutcome };
