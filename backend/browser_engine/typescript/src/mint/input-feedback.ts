import type { Effect } from "effect";
import type { ExpectedConfirm } from "../browser/dialogs/contracts.js";
import type { SignInRecipe } from "../destinations/sign-in-recipe.js";
import { publicationCostlyChoice, publicationCostlyChoiceDefault } from "../guardian/publication.js";
import type { GuardianAction, PublicationFinding } from "../guardian/review-contracts.js";
import type { ScriptQuestionDeclarations } from "../runtime/script-input.js";
import type { MintFailure, PublicationDiagnosticGap } from "./contracts.js";

/** Credential-screened Guardian feedback for a completed model decision. */
export interface MintReviewFeedback {
  readonly reviewId: string;
  readonly outcome: "allow" | "deny" | "escalate";
  readonly rationale: string;
  /** An execution review's label of what the step does on the website; see `GuardianAction`. */
  readonly action?: GuardianAction;
  /**
   * An allow's note for the agent, such as a doubt about which page value the request asks for.
   * It never blocks the step; publication review judges the output.
   */
  readonly advice?: string;
}

/** A build the registry published: its reference and the publication diagnostics it left. */
export interface PublishedBuild {
  readonly review?: MintReviewFeedback;
  readonly shareability?: {
    readonly visibility: "public" | "private";
    readonly reason: string;
    readonly rationale: string;
  };
  readonly publicationRef: string;
  readonly diagnostics: readonly PublicationDiagnosticGap[];
}
/** A build published despite input feedback the minter left unfixed, with that feedback. */
export interface UnresolvedInputFeedbackBuild extends PublishedBuild {
  readonly publicationRef: string;
  readonly categories: readonly PublicationFinding["category"][];
}
/** The host's private fallback for input feedback the minter leaves unfixed. */
export interface InputFeedbackFallback {
  /**
   * Whether a reviewed candidate is kept for the fallback. After an input-feedback review it is
   * false only for a tool that is already public, which cannot fall back to private.
   */
  readonly kept: () => boolean;
  /**
   * Publishes the kept candidate, at most once: private to this tenant and flagged, without
   * another review. Undefined when none is kept.
   */
  readonly publish: Effect.Effect<UnresolvedInputFeedbackBuild | undefined, MintFailure>;
  /**
   * For a tool that is already public: records, at most once, the diagnostic that flags its
   * published revision with the last review's input findings, which the next maintenance of the
   * tool sees. Nothing when no such feedback is outstanding.
   */
  readonly flagPublished: Effect.Effect<void>;
}

/** Guardian input-feedback rounds returned to the minter before the build's ending. */
export const maximumInputFeedbackRounds = 2;

const unresolvedOutcome = (roundsRemaining: number, privateFallback: boolean | undefined) => {
  const outcome =
    privateFallback === undefined
      ? "the build ends unpublished and reports Guardian's findings to the owner"
      : privateFallback
        ? "the host publishes the last reviewed version privately to this account and flags it"
        : "nothing new is published, because this tool is already public and cannot fall back to a private version; its existing version stays";
  return roundsRemaining === 0
    ? `This was the last feedback round: if the next review still finds input problems, ${outcome}.`
    : `If input findings remain after ${roundsRemaining} more feedback round${roundsRemaining === 1 ? "" : "s"}, or the build ends first, ${outcome}.`;
};

/**
 * What the minter is told to fix, and what happens once its rounds run out. It is feedback, never
 * the end of the build: a write's schemas are extracted offline from current source, and so are
 * a read's once its source changes. `privateFallback` is whether a host's fallback publishes the
 * last reviewed version privately, false for a tool already public; it is absent for a build
 * with no fallback, which ends unpublished.
 */
export const inputFeedbackInstruction = (
  roundsRemaining: number,
  build: { readonly write: boolean; readonly privateFallback?: boolean },
) =>
  `Not published yet: publication review found input problems in this tool's public schema or the code that fills it. An account_specific_enum finding is an account-specific value (a passenger, loyalty or member number, saved card or address, account ID) listed as an enum member, example or default: make that input free-form. An input_option finding is ${publicationCostlyChoice}, on the write's path, that the tool settles by itself or whose input defaults to anything other than ${publicationCostlyChoiceDefault}: make it a required input or a declared question, or an optional input whose default is one of those. An optional input left unset keeps the page's default. An example_input finding is a key of the example's exampleInput that the input schema does not list: make it an input property. ${build.write ? "A write's schema is read offline from current source: correct the source, then call finish_build again with the same executionId. Never run the write again." : "The host reads a read's schemas offline from current source once it changes: correct the schema and the code that sets that input there, then call finish_build again with the same executionId. The example's own input and output must still decode against them. Do not run the example again for this."} ${unresolvedOutcome(roundsRemaining, build.privateFallback)}`;

/** The last input-feedback review, as a build that ends on it reports it. */
export interface InputFeedbackReview {
  readonly categories: readonly PublicationFinding["category"][];
  readonly rationale: string;
}

/**
 * Why a build that ends on unresolved input feedback published nothing new. With no fallback it
 * reports the last review's categories and rationale; a fallback's cause says what it did.
 */
export const unresolvedInputFeedbackSummary = (
  cause?: "public_tool" | MintFailure,
  review?: InputFeedbackReview,
) => {
  if (cause === undefined && review !== undefined)
    return `Not built: Guardian's input feedback on this tool's schema was not resolved (${review.categories.join(", ")}). Guardian's rationale: ${review.rationale}`;
  const why =
    cause === undefined
      ? ""
      : cause === "public_tool"
        ? " The tool is already public, so it cannot fall back to a private version, and its existing version stays."
        : ` Publishing the last reviewed version privately failed (${cause.code}${cause.reason === undefined ? "" : `: ${cause.reason}`}).`;
  return `Guardian's input feedback on this tool's schema was not resolved, so nothing new was published.${why} Recorded effects and receipts are preserved.`;
};

/** Current reviewed source and extracted contracts returned by a local build. */
export interface MintArtifact {
  readonly files: readonly { readonly path: string; readonly content: string }[];
  readonly entrypoint: string;
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
  /**
   * The build's verified sign-in, value-free: its recipe, the address its runs start from and,
   * when a host records them, the build's sign-in origins.
   */
  readonly signIn?: {
    readonly recipe: SignInRecipe;
    readonly entryUrl: string;
    readonly authenticationOrigins?: readonly string[];
  };
  /**
   * The questions publication reviewed, the only ones a run asks its caller, and `{}` when there
   * are none. An artifact saved before builds recorded them asks only what its entrypoint
   * declares as a plain literal.
   */
  readonly questions?: ScriptQuestionDeclarations;
  /** The confirm popups a write's build accepted, as digests its runs accept without asking. */
  readonly acceptedConfirms?: readonly ExpectedConfirm[];
}

/** Completion uses the same review/receipt loop in each composition. */
export type MintCompletion =
  | PublishedBuild
  | (Omit<PublishedBuild, "publicationRef"> & {
      readonly publicationRef?: never;
      readonly artifact: MintArtifact;
    });
