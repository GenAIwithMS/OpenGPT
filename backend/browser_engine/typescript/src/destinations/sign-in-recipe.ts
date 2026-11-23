import { Effect, Either, Option, Schema } from "effect";
import type {
  AutofillApproval,
  AutofillPopup,
  RejectedMarker,
  SubmitKey,
} from "./autofill-contracts.js";
import {
  autofillRecipe,
  autofillRecipePath,
  DismissAutofillRecipe,
  KeyboardSubmitAutofillRecipe,
  KeySubmitAutofillRecipe,
  LegacyAutofillRecipe,
  PopupAutofillRecipe,
  publishedAutofillRecipe,
  WildcardAutofillRecipe,
  WorkspaceAutofillRecipe,
  type AutofillRecipeOrigins,
  type AutofillRecipeStep,
} from "./autofill-recipe.js";
import type {
  AutofillField,
  AutofillInspection,
  AutofillRefusal,
  AutofillScreens,
  AutofillSignedIn,
  AutofillSignedInCheck,
  AutofillStep,
  AutofillStepReport,
} from "./autofill-step.js";
import type { CredentialRejectedField, WebsiteCredentials } from "../runtime/authentication.js";
import { recordedScreenPage } from "../runtime/workspace-origin.js";

/**
 * Version 3, which this host wrote for a private answer's question selector before it wrote that
 * selector in version 1 or 2 as other hosts do. It is read as this host wrote it, so those tools
 * still run, and never written.
 */
export const SignInRecipeV3 = Schema.Struct({
  ...PopupAutofillRecipe.fields,
  version: Schema.Literal(3),
}).pipe(
  Schema.filter(
    (recipe) =>
      recipe.steps.every((step) =>
        step.fields.every((field) => !("questionSelector" in field) || field.slot === "private_answer"),
      ),
    { message: () => "only a private answer names a question selector" },
  ),
);
/**
 * A recipe this host reads: version 1, 2, 4, 5, 6, 7 or 8 as every host writes it, or this host's
 * version 3.
 */
export const SignInRecipe = Schema.Union(
  LegacyAutofillRecipe,
  PopupAutofillRecipe,
  SignInRecipeV3,
  WorkspaceAutofillRecipe,
  KeySubmitAutofillRecipe,
  DismissAutofillRecipe,
  WildcardAutofillRecipe,
  KeyboardSubmitAutofillRecipe,
);
export type SignInRecipe = typeof SignInRecipe.Type;
export type SignInRecipeStep = AutofillRecipeStep;

/** A recorded step's page on the given workspace origin, or as recorded. */
export const resolvedPage = (step: SignInRecipeStep, workspace: string | undefined) =>
  step.origin === "workspace" && workspace === undefined
    ? undefined
    : recordedScreenPage(step, workspace);

const knownVersions: readonly unknown[] = [1, 2, 3, 4, 5, 6, 7, 8];

/**
 * A published recipe file read back: the recipe, `unknown_version` for a version this host does
 * not know, else `invalid`. Version 1, 2, 4, 5, 6, 7 and 8 decode as every host reads them;
 * version 3 is read only here.
 */
export const decodeSignInRecipe = (text: string): SignInRecipe | "invalid" | "unknown_version" => {
  const shared = publishedAutofillRecipe(new Map([[autofillRecipePath, text]]));
  if (shared !== undefined) return shared;
  const parsed = Schema.decodeUnknownEither(Schema.parseJson())(text);
  if (Either.isLeft(parsed) || typeof parsed.right !== "object" || parsed.right === null)
    return "invalid";
  const version: unknown = Reflect.get(parsed.right, "version");
  if (typeof version === "number" && !knownVersions.includes(version)) return "unknown_version";
  if (version !== 3) return "invalid";
  return Option.getOrElse(
    Schema.decodeUnknownOption(SignInRecipeV3)(parsed.right),
    () => "invalid" as const,
  );
};

/**
 * One screen of a sign-in as the host ran it, value-free: what a run replays. `submittedBy` is
 * `minter` when the host's click failed and the minter clicked it itself.
 */
export interface RecordedSignInStep {
  /** `workspace` for a screen on the login's workspace host, whose `page` is then a path. */
  readonly origin?: "workspace" | undefined;
  readonly popup?: AutofillPopup | undefined;
  readonly approval?: AutofillApproval | undefined;
  /** A device approval's element that shows the number the owner picks on their device. */
  readonly matchSelector?: string | undefined;
  readonly rejectedMarkers?: readonly RejectedMarker[] | undefined;
  /** With each identifier field's accepted kinds, never a value. */
  readonly fields: readonly AutofillField[];
  readonly submit?: string | undefined;
  /** The key pressed in the last field to submit its form, on a form with no submit control. */
  readonly submitKey?: SubmitKey | undefined;
  readonly submittedBy?: "host" | "minter" | undefined;
  /** `keyboard` when the host pressed the step's covered submit from the keyboard. */
  readonly submitVia?: "keyboard" | undefined;
  /** A two-factor method choice's recorded methods. */
  readonly methods?: AutofillStep["methods"];
  /** The secrets an earlier screen took that this one asks for again with a second factor. */
  readonly refills?: SignInRecipeStep["refills"];
  /** The covering notice's own control the host clicked on this screen. */
  readonly dismiss?: string | undefined;
  /** The page the step ran on, origin and path only. */
  readonly page: string;
  /** The segments of `page`'s path written as `*`, which any one segment matches. */
  readonly anySegments?: readonly number[] | undefined;
}

/**
 * A verified sign-in's recipe, as `autofillRecipe` writes it, with only the signed-in indicator's
 * parts that are set, and version 4's workspace relation when given.
 */
export const signInRecipe = (
  steps: readonly RecordedSignInStep[],
  signedIn: AutofillSignedIn,
  origins: AutofillRecipeOrigins = {},
): SignInRecipe =>
  autofillRecipe(
    steps,
    {
      ...(signedIn.selector === undefined ? {} : { selector: signedIn.selector }),
      ...(signedIn.urlPath === undefined ? {} : { urlPath: signedIn.urlPath }),
      ...(signedIn.openPath === undefined ? {} : { openPath: signedIn.openPath }),
    },
    origins,
  );

/** A recipe screen in `recipeStep`'s key order, whatever order it was read in. */
const inStepOrder = (step: SignInRecipeStep): SignInRecipeStep => ({
  ...(step.origin === undefined ? {} : { origin: step.origin }),
  page: step.page,
  ...(step.anySegments === undefined ? {} : { anySegments: step.anySegments }),
  ...(step.approval === undefined ? {} : { approval: step.approval }),
  ...(step.matchSelector === undefined ? {} : { matchSelector: step.matchSelector }),
  ...(step.popup === undefined ? {} : { popup: step.popup }),
  ...(step.rejectedMarkers === undefined ? {} : { rejectedMarkers: step.rejectedMarkers }),
  fields: step.fields.map((field) =>
    "accepts" in field
      ? { selector: field.selector, accepts: field.accepts }
      : {
          selector: field.selector,
          slot: field.slot,
          ...(field.format === undefined ? {} : { format: field.format }),
          ...(field.control === undefined ? {} : { control: field.control }),
          ...(field.questionSelector === undefined
            ? {}
            : { questionSelector: field.questionSelector }),
        },
  ),
  ...(step.refills === undefined ? {} : { refills: step.refills }),
  ...(step.submit === undefined ? {} : { submit: step.submit }),
  ...(step.submitKey === undefined ? {} : { submitKey: step.submitKey }),
  ...(step.submittedBy === undefined ? {} : { submittedBy: step.submittedBy }),
  ...(step.submitVia === undefined ? {} : { submitVia: step.submitVia }),
  ...(step.methods === undefined ? {} : { methods: step.methods }),
  ...(step.dismiss === undefined ? {} : { dismiss: step.dismiss }),
});

/**
 * A recipe as `auth-fill.json` holds it: `version`, then version 4's to 8's `workspace`, then each
 * screen in `recipeStep`'s key order (a workspace screen's `origin` first), indented two spaces,
 * with no final newline. The same recipe is the same bytes from any
 * host that writes it this way.
 */
export const signInRecipeText = (recipe: SignInRecipe) =>
  JSON.stringify(
    {
      version: recipe.version,
      ...((recipe.version !== 4 &&
        recipe.version !== 5 &&
        recipe.version !== 6 &&
        recipe.version !== 7 &&
        recipe.version !== 8) ||
      recipe.workspace === undefined
        ? {}
        : { workspace: { parent: recipe.workspace.parent } }),
      steps: recipe.steps.map(inStepOrder),
      signedIn: {
        ...(recipe.signedIn.selector === undefined ? {} : { selector: recipe.signedIn.selector }),
        ...(recipe.signedIn.urlPath === undefined ? {} : { urlPath: recipe.signedIn.urlPath }),
        ...(recipe.signedIn.openPath === undefined ? {} : { openPath: recipe.signedIn.openPath }),
      },
    },
    null,
    2,
  );

/** The browser a sign-in runs on, as the recorder uses it. */
export interface SignInBrowser<E> {
  /** Finds the step's controls and judges where they submit, before anything is typed. */
  readonly inspect: (step: AutofillStep) => Effect.Effect<AutofillRefusal | AutofillInspection, E>;
  /** Fills the step's values into the inspected controls and clicks its submit. */
  readonly fill: (input: {
    readonly step: AutofillStep;
    readonly values: readonly string[];
    readonly inspection: AutofillInspection;
  }) => Effect.Effect<AutofillStepReport>;
  /**
   * Clicks again the submit of a screen whose fill reported `blocked`, typing nothing, after the
   * step's `dismiss` when it names one. A browser without it has the screen filled again.
   */
  readonly resubmit?: (input: {
    readonly step: AutofillStep;
    readonly inspection: AutofillInspection;
  }) => Effect.Effect<AutofillStepReport>;
  /**
   * Checks the minter's signed-in indicator on the page: `screens` are every screen the build
   * filled, `challengeScreens` the current sign-in's, whose recorded challenges count.
   * `openOrigin`, a same-site origin such as the login's workspace origin, is where the
   * indicator's `openPath` opens; the site origin when absent.
   */
  readonly confirm: (
    indicator: AutofillSignedIn,
    screens: AutofillScreens,
    challengeScreens: AutofillScreens,
    openOrigin?: string,
  ) => Effect.Effect<AutofillSignedInCheck, E>;
  /** The configured sign-in origins off the site. */
  readonly authenticationOrigins: readonly string[];
}

/** Where a sign-in's login comes from. */
export interface SignInLogin<E> {
  /** The login already given, if any. */
  readonly held: () => WebsiteCredentials | undefined;
  /** The login, asked for once when none is held. */
  readonly values: Effect.Effect<WebsiteCredentials, E>;
  /**
   * A corrected login after the site rejected `field` of `held`; `triesLeft`, this one included,
   * when the sign-in bounds its corrections.
   */
  readonly correct: (
    field: CredentialRejectedField,
    held: WebsiteCredentials,
    triesLeft?: number,
  ) => Effect.Effect<WebsiteCredentials, E>;
}
