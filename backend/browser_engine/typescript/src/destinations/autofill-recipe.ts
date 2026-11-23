import { Option, Schema } from "effect";
import {
  AutofillApproval,
  AutofillPopup,
  DateControl,
  DateOfBirthFormat,
  IdentifierKinds,
  maximumCodeBoxes,
  maximumStepFields,
  RejectedMarker,
  SecretSlots,
  SignInMethodChoice,
  stepFieldsFit,
  stepFieldsMessage,
  SubmitKey,
} from "./autofill-contracts.js";
import type { AutofillField } from "./autofill-step.js";
export {
  AutofillPopup,
  RejectedMarker,
  SignInMethodChoice,
  SignInMethod,
} from "./autofill-contracts.js";

/** The bundle file a minted tool's sign-in recipe ships as, beside its source. */
export const autofillRecipePath = "auth-fill.json";

const Selector = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1_000));
/**
 * A recorded field: an identifier field by every kind it accepts, which each run resolves against
 * its own login, or a secret field by its slot.
 */
const RecipeField = Schema.Union(
  Schema.Struct({
    selector: Selector,
    accepts: Schema.Array(IdentifierKinds).pipe(Schema.minItems(1), Schema.maxItems(4)),
  }),
  Schema.Struct({
    selector: Selector,
    slot: SecretSlots,
    format: Schema.optional(DateOfBirthFormat),
    control: Schema.optional(DateControl),
    /** A security answer's question, which each replay reads again; never the answer. */
    questionSelector: Schema.optional(Selector),
  }),
);

/**
 * One recorded sign-in screen: the page it ran on (origin and path), the fields the host filled by
 * slot, and the control that submitted them, clicked by the host or, after a missed host click, by
 * the minter. A two-factor method choice records every method the screen offered, each with the
 * control that picks it, and its `submit` is the one the mint picked.
 */
const RecipeStep = Schema.Struct({
  rejectedMarkers: Schema.optional(
    Schema.Array(RejectedMarker).pipe(Schema.maxItems(maximumStepFields)),
  ),
  page: Schema.String.pipe(Schema.maxLength(2_000)),
  fields: Schema.Array(RecipeField).pipe(
    Schema.maxItems(maximumStepFields + maximumCodeBoxes),
    Schema.filter(stepFieldsFit, { message: () => stepFieldsMessage }),
  ),
  submit: Schema.optional(Selector),
  submittedBy: Schema.optional(Schema.Literal("host", "minter")),
  methods: Schema.optional(
    Schema.Array(Schema.Struct({ method: SignInMethodChoice, selector: Selector })).pipe(
      Schema.minItems(1),
      Schema.maxItems(8),
    ),
  ),
});

/**
 * A verified autofill sign-in, value-free: selectors, slots, submits and pages, and the indicator
 * the minter found and the host checked. A run replays it with the host's own fill. `version` is
 * what a host checks before replaying: a host that does not know it refuses the recipe rather than
 * dropping step metadata or typing into a different page.
 */
export const LegacyAutofillRecipe = Schema.Struct({
  version: Schema.Literal(1),
  steps: Schema.Array(RecipeStep).pipe(Schema.minItems(1), Schema.maxItems(12)),
  /**
   * The deterministic check that the sign-in worked: a marker on the page it lands on, or on the
   * account page `openPath` the host opens first.
   */
  signedIn: Schema.Struct({
    selector: Schema.optional(Selector),
    urlPath: Schema.optional(Schema.String.pipe(Schema.maxLength(2_000))),
    openPath: Schema.optional(Schema.String.pipe(Schema.maxLength(2_000))),
  }),
});
/**
 * A version 2 step may also name `matchSelector` on a device approval: the element its screen shows
 * a number in for the owner to pick on their device, which a replay reads again and shows the owner
 * when it is 1 to 3 digits. It rides in every version from 2 without one of its own. A host that
 * predates it ignores it in a version 2 recipe and refuses a version 4 to 8 recipe that has it, as
 * a host that predates `refills` refuses one with that.
 */
const PopupRecipeStep = Schema.Struct({
  ...RecipeStep.fields,
  popup: Schema.optional(AutofillPopup),
  approval: Schema.optional(AutofillApproval),
  matchSelector: Schema.optional(Selector),
});
/** Version 2 keeps a host that does not know it from dropping popup metadata and filling the primary tab. */
export const PopupAutofillRecipe = Schema.Struct({
  ...LegacyAutofillRecipe.fields,
  version: Schema.Literal(2),
  steps: Schema.Array(PopupRecipeStep).pipe(Schema.minItems(1), Schema.maxItems(12)),
});
/**
 * A version 2 step that may run on the login's own workspace host: with `origin: "workspace"`, its
 * `page` is a path only, and each run resolves it against the workspace origin it verified.
 */
const WorkspaceRecipeStep = Schema.Struct({
  origin: Schema.optional(Schema.Literal("workspace")),
  ...PopupRecipeStep.fields,
});
/** A lower-case host name, as a registrable domain is written. */
const HostName = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(253),
  Schema.pattern(/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/u),
);
const absolutePage = (page: string) => URL.parse(page) !== null;
/**
 * A canonical pathname, which the URL parser keeps unchanged: it starts with one "/", and has no
 * host, backslash, query, fragment, dot segment or character the parser rewrites.
 */
const pathOnlyPage = (page: string) => URL.parse(page, "https://h.invalid")?.pathname === page;
/**
 * Version 4: a sign-in that may move to a per-account workspace host on the site's registrable
 * domain (`workspace`). It names no tenant: `workspace.parent` is the site's own registrable
 * domain, and a workspace step names a path only. A host checks them against the tool's site
 * origin at use, never here. A host that does not know version 4 refuses it, and a version 4
 * recipe with a key this host does not know is refused, so no host drops what a writer adds.
 */
/** Version 4's and 5's checks of their workspace steps' pages against the recipe's workspace. */
const workspacePages = <
  Recipe extends {
    readonly workspace?: unknown;
    readonly steps: readonly { readonly origin?: "workspace" | undefined; readonly page: string }[];
  },
>(
  recipe: Schema.Schema<Recipe, Recipe>,
) =>
  recipe.pipe(
    Schema.filter(
      (recipe) =>
        recipe.steps.every((step) =>
          step.origin === "workspace" ? pathOnlyPage(step.page) : absolutePage(step.page),
        ) || "a workspace step's page is a path, and any other step's an absolute URL",
    ),
    Schema.filter(
      (recipe) =>
        recipe.workspace !== undefined ||
        recipe.steps.every((step) => step.origin !== "workspace") ||
        "a workspace step needs the recipe's workspace",
    ),
  );
export const WorkspaceAutofillRecipe = workspacePages(
  Schema.Struct({
    ...LegacyAutofillRecipe.fields,
    version: Schema.Literal(4),
    workspace: Schema.optional(Schema.Struct({ parent: HostName })),
    steps: Schema.Array(WorkspaceRecipeStep).pipe(Schema.minItems(1), Schema.maxItems(12)),
  }).annotations({ parseOptions: { onExcessProperty: "error" } }),
);
/** The secret a later screen may ask for again, beside a second factor: the password. */
export const RefillSlot = Schema.Literal("password");
/** A second factor: the one-time values a screen that asks for the password again also takes. */
export const isSecondFactor = (slot: string) => slot === "code" || slot === "recovery_code";
/**
 * A version 5 step: a version 4 step that may submit with a key (`submitKey`): Enter pressed in
 * its last field submits that field's form, on a screen whose form has no submit control. Such a
 * step fills a field and names no submit or method choice. It may also list `refills`, the
 * secrets an earlier screen of the sign-in took that this screen asks for again, as a site that
 * wants the password re-entered with a one-time code does: only a screen that takes the refilled
 * field and a second factor may list one.
 */
const keyStepFields = {
  ...WorkspaceRecipeStep.fields,
  submitKey: Schema.optional(SubmitKey),
  refills: Schema.optional(Schema.Array(RefillSlot).pipe(Schema.minItems(1), Schema.maxItems(1))),
};
/** Version 5's checks of a step's `submitKey` and `refills`, which version 6 keeps. */
const keyStepRules = <
  Step extends {
    readonly fields: readonly ({ readonly slot: string } | { readonly accepts: unknown })[];
    readonly submit?: string | undefined;
    readonly submitKey?: SubmitKey | undefined;
    readonly methods?: unknown;
    readonly refills?: readonly string[] | undefined;
  },
  Encoded,
>(
  step: Schema.Schema<Step, Encoded>,
) =>
  step.pipe(
    Schema.filter(
      (step) =>
        step.submitKey === undefined ||
        (step.submit === undefined && step.methods === undefined && step.fields.length > 0) ||
        "a submitKey step fills a field and names no submit or method choice",
    ),
    Schema.filter(
      (step) =>
        step.refills === undefined ||
        (step.fields.some((field) => "slot" in field && isSecondFactor(field.slot)) &&
          step.refills.every((slot) =>
            step.fields.some((field) => "slot" in field && field.slot === slot),
          )) ||
        "a step's refills name a field it takes, and it takes a code or recovery code",
    ),
  );
const KeyRecipeStep = keyStepRules(Schema.Struct(keyStepFields));
/**
 * Version 5: version 4 whose steps may submit with a key (`submitKey`) or refill a secret
 * (`refills`). A host that does not know version 5 refuses it, so it never replays such a step
 * without submitting it or without the refill; a version 5 recipe with a key this host does not
 * know is refused too, as a version 5 host that predates `refills` refuses one that has it.
 */
export const KeySubmitAutofillRecipe = workspacePages(
  Schema.Struct({
    ...LegacyAutofillRecipe.fields,
    version: Schema.Literal(5),
    workspace: Schema.optional(Schema.Struct({ parent: HostName })),
    steps: Schema.Array(KeyRecipeStep).pipe(Schema.minItems(1), Schema.maxItems(12)),
  }).annotations({ parseOptions: { onExcessProperty: "error" } }),
);
/**
 * A version 6 step: a version 5 step that may name `dismiss`, the own close, reject or accept control of a
 * cookie, consent or similar notice that covered the screen, which the host clicked there. A
 * replay clicks it before it types, when the page shows it, and again before it clicks the submit
 * once more when the notice caught that click; a page that does not show it skips it. It is never
 * the step's submit, a method or one of its fields.
 */
const DismissRecipeStep = keyStepRules(
  Schema.Struct({ ...keyStepFields, dismiss: Schema.optional(Selector) }),
).pipe(
  Schema.filter(
    (step) =>
      step.dismiss === undefined ||
      (step.dismiss !== step.submit &&
        !step.fields.some((field) => field.selector === step.dismiss) &&
        !(step.methods ?? []).some((method) => method.selector === step.dismiss)) ||
      "a step's dismiss is none of its own controls",
  ),
);
/**
 * Version 6: version 5 whose steps may name `dismiss`. A host that does not know version 6 refuses
 * it, so it never replays such a step without dismissing the notice that covers it; a version 6
 * recipe with a key this host does not know is refused too. A recipe with no `dismiss` is written
 * as before, in the lowest version it needs, so a host that predates version 6 replays it unchanged.
 */
export const DismissAutofillRecipe = workspacePages(
  Schema.Struct({
    ...LegacyAutofillRecipe.fields,
    version: Schema.Literal(6),
    workspace: Schema.optional(Schema.Struct({ parent: HostName })),
    steps: Schema.Array(DismissRecipeStep).pipe(Schema.minItems(1), Schema.maxItems(12)),
  }).annotations({ parseOptions: { onExcessProperty: "error" } }),
);
/** A path's segments, counted from 0 after its first "/", as `anySegments` lists them. */
const segmentsOf = (path: string) => path.split("/").slice(1);
/**
 * Whether `listed` names, in order and once each, exactly the segments of `path` written as `*`,
 * and a path that writes one keeps a literal non-empty segment, so it never matches every page
 * with as many segments.
 */
const starsListed = (path: string, listed: readonly number[] = []) => {
  const segments = segmentsOf(path);
  const stars = segments.flatMap((segment, at) => (segment === "*" ? [at] : []));
  return (
    stars.length === listed.length &&
    stars.every((at, index) => listed[index] === at) &&
    (stars.length === 0 || segments.some((segment) => segment !== "" && segment !== "*"))
  );
};
/** Whether a path writes a segment as `*`, as written or as an origin resolves it. */
const writesStar = (path: string) =>
  [path, URL.parse(path, "https://h.invalid")?.pathname ?? ""].some((form) =>
    form.split("/").includes("*"),
  );
const SegmentList = Schema.Array(Schema.Int.pipe(Schema.nonNegative())).pipe(
  Schema.minItems(1),
  Schema.maxItems(16),
);
/**
 * A version 7 step: a version 6 step that may list `anySegments`, the segments of its page's path,
 * counted from 0 after its first "/", that it writes as `*`, such as a later screen at
 * `/team/<team>/password` where each account's team differs. Runs never open a recorded page, so a
 * replay reads such a screen on the same origin, with as many segments, any one non-empty segment
 * at each listed place and every other the same (`pageMatches`).
 */
const WildcardRecipeStep = Schema.extend(
  DismissRecipeStep,
  Schema.Struct({ anySegments: Schema.optional(SegmentList) }),
).pipe(
  Schema.filter(
    (step) =>
      starsListed(URL.parse(step.page, "https://h.invalid")?.pathname ?? "", step.anySegments) ||
      "a step's anySegments list, in order, exactly its page's * segments, beside a literal one",
  ),
);
/** Version 7's marker: a host opens its paths, so neither writes a segment as `*`. */
const WildcardSignedIn = LegacyAutofillRecipe.fields.signedIn.pipe(
  Schema.filter(
    (marker) =>
      [marker.urlPath, marker.openPath].every((path) => path === undefined || !writesStar(path)) ||
      "no segment of the marker's urlPath or openPath is *",
  ),
);
/**
 * Version 7: version 6 whose steps may write path segments as `*`, never the first step, whose
 * page is where a run starts when the build gave no login URL. A host that does not know version 7
 * refuses it, so it never reads a `*` as a literal segment. A recipe that lists no segment is
 * written as before, in the lowest version it needs.
 */
export const WildcardAutofillRecipe = workspacePages(
  Schema.Struct({
    ...LegacyAutofillRecipe.fields,
    version: Schema.Literal(7),
    workspace: Schema.optional(Schema.Struct({ parent: HostName })),
    steps: Schema.Array(WildcardRecipeStep).pipe(Schema.minItems(1), Schema.maxItems(12)),
    signedIn: WildcardSignedIn,
  }).annotations({ parseOptions: { onExcessProperty: "error" } }),
).pipe(
  Schema.filter(
    (recipe) =>
      recipe.steps[0]?.anySegments === undefined || "the first step lists no anySegments",
  ),
);
/**
 * A version 8 step: a version 7 step that may say `submitVia: "keyboard"`. Another element sat over
 * its submit when the host sent it, such as a fixed footer, and the host pressed that same submit
 * from the keyboard. A replay presses it so first, once focus lands on it, and clicks it
 * otherwise. Only a step that names a submit says it.
 */
const KeyboardRecipeStep = Schema.extend(
  WildcardRecipeStep,
  Schema.Struct({ submitVia: Schema.optional(Schema.Literal("keyboard")) }),
).pipe(
  Schema.filter(
    (step) =>
      step.submitVia === undefined || step.submit !== undefined || "a submitVia step names a submit",
  ),
);
/**
 * Version 8: version 7 whose steps may say `submitVia`. A host that does not know version 8
 * refuses it, so it never replays such a step by clicking a submit another element covers. A
 * recipe with no `submitVia` is written as before, in the lowest version it needs.
 */
export const KeyboardSubmitAutofillRecipe = workspacePages(
  Schema.Struct({
    ...LegacyAutofillRecipe.fields,
    version: Schema.Literal(8),
    workspace: Schema.optional(Schema.Struct({ parent: HostName })),
    steps: Schema.Array(KeyboardRecipeStep).pipe(Schema.minItems(1), Schema.maxItems(12)),
    signedIn: WildcardSignedIn,
  }).annotations({ parseOptions: { onExcessProperty: "error" } }),
).pipe(
  Schema.filter(
    (recipe) =>
      recipe.steps[0]?.anySegments === undefined || "the first step lists no anySegments",
  ),
);
export const AutofillRecipe = Schema.Union(
  LegacyAutofillRecipe,
  PopupAutofillRecipe,
  WorkspaceAutofillRecipe,
  KeySubmitAutofillRecipe,
  DismissAutofillRecipe,
  WildcardAutofillRecipe,
  KeyboardSubmitAutofillRecipe,
);
export type AutofillRecipe = typeof AutofillRecipe.Type;
export type AutofillRecipeStep = typeof KeyboardRecipeStep.Type;

/**
 * Whether a live path is a recorded screen's: as many segments, each the same, except that each
 * listed place (`anySegments`, counted from 0 after the first "/") takes any one non-empty
 * segment. A trailing slash but the root's is dropped from both.
 */
export const pathMatches = (
  live: string,
  recorded: string,
  anySegments: readonly number[] = [],
) => {
  const parts = (path: string) => (path.length <= 1 ? path : path.replace(/\/$/u, "")).split("/");
  const here = parts(live);
  const there = parts(recorded);
  return (
    here.length === there.length &&
    there.every((part, at) => (anySegments.includes(at - 1) ? here[at] !== "" : here[at] === part))
  );
};

/**
 * Whether a live page is a recorded screen's page: the same origin, and a path that
 * `pathMatches` the screen's. A page that is no absolute URL, such as a workspace screen's path
 * while the replay knows no workspace origin, matches none.
 */
export const pageMatches = (
  live: string,
  recorded: { readonly page: string; readonly anySegments?: readonly number[] | undefined },
) => {
  const here = URL.parse(live);
  const there = URL.parse(recorded.page);
  return (
    here !== null &&
    there !== null &&
    here.origin === there.origin &&
    pathMatches(here.pathname, there.pathname, recorded.anySegments)
  );
};

/** Where a version 4 recipe's sign-in may go besides the site's own host. */
export interface AutofillRecipeOrigins {
  readonly workspace?: { readonly parent: string } | undefined;
}

/** The bundle's recipe, or undefined when it has none or one this host cannot replay. */
export const publishedAutofillRecipe = (
  bundle: ReadonlyMap<string, string>,
): AutofillRecipe | undefined => {
  const text = bundle.get(autofillRecipePath);
  return text === undefined
    ? undefined
    : Option.getOrUndefined(Schema.decodeUnknownOption(Schema.parseJson(AutofillRecipe))(text));
};

/**
 * One screen of a sign-in as a host ran it, value-free: what a run replays. `submittedBy` is
 * `minter` when the host's click failed and the minter clicked it itself.
 */
interface RecordedRecipeStep {
  /** `workspace` for a screen on the login's workspace host, whose `page` is then a path. */
  readonly origin?: "workspace" | undefined;
  readonly popup?: AutofillRecipeStep["popup"] | undefined;
  readonly approval?: AutofillRecipeStep["approval"] | undefined;
  /** A device approval's element that shows the number the owner picks on their device. */
  readonly matchSelector?: string | undefined;
  readonly rejectedMarkers?: AutofillRecipeStep["rejectedMarkers"] | undefined;
  /** With each identifier field's accepted kinds, never a value. */
  readonly fields: readonly AutofillField[];
  readonly submit?: string | undefined;
  /** The key pressed in the last field to submit its form, on a form with no submit control. */
  readonly submitKey?: SubmitKey | undefined;
  readonly submittedBy?: "host" | "minter" | undefined;
  /** `keyboard` when the host pressed the step's covered submit from the keyboard. */
  readonly submitVia?: "keyboard" | undefined;
  /** A two-factor method choice's recorded methods. */
  readonly methods?: AutofillRecipeStep["methods"] | undefined;
  /** The secrets an earlier screen took that this one asks for again with a second factor. */
  readonly refills?: AutofillRecipeStep["refills"] | undefined;
  /** The covering notice's own control the host clicked on this screen. */
  readonly dismiss?: string | undefined;
  /** The page the step ran on, origin and path only. */
  readonly page: string;
  /** The segments of `page`'s path written as `*`, which any one segment matches. */
  readonly anySegments?: readonly number[] | undefined;
}

const isIdentifierKind = Schema.is(IdentifierKinds);

/**
 * A recorded screen as the recipe ships it: an identifier field by the kinds it accepts, never the
 * kind this login sent, which each run resolves against its own login.
 */
export const recipeStep = (step: RecordedRecipeStep): AutofillRecipeStep => ({
  ...(step.origin === undefined ? {} : { origin: step.origin }),
  page: step.page,
  ...((step.anySegments ?? []).length === 0 ? {} : { anySegments: step.anySegments }),
  ...(step.approval === undefined ? {} : { approval: step.approval }),
  ...(step.matchSelector === undefined ? {} : { matchSelector: step.matchSelector }),
  ...(step.popup === undefined ? {} : { popup: step.popup }),
  ...(step.rejectedMarkers === undefined ? {} : { rejectedMarkers: step.rejectedMarkers }),
  fields: step.fields.map((field) =>
    !isIdentifierKind(field.slot)
      ? {
          selector: field.selector,
          slot: field.slot,
          ...(field.format === undefined ? {} : { format: field.format }),
          ...(field.control === undefined ? {} : { control: field.control }),
          // A replay reads the question again; the recipe never holds an answer.
          ...(field.questionSelector === undefined
            ? {}
            : { questionSelector: field.questionSelector }),
        }
      : { selector: field.selector, accepts: field.accepts ?? [field.slot] },
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
 * A verified sign-in's recipe: version 8 only when a step says `submitVia`, else version 7 only
 * when a step lists segments written as `*`
 * (`anySegments`; an empty list is none and is left out), else version 6 only when a step names
 * `dismiss`, else version 5 only when a step submits with a key or refills a secret (`refills`),
 * else version 4 only when its sign-in may move to a workspace host (`origins.workspace`, or a
 * workspace step), else version 2 only with a popup or an approval, else version 1. A security
 * answer's question selector rides in any of them. Versions 4 to 8 write `workspace` before
 * `steps`.
 */
export const autofillRecipe = <SignedIn>(
  steps: readonly RecordedRecipeStep[],
  signedIn: SignedIn,
  origins: AutofillRecipeOrigins = {},
) => {
  const lists = steps.some((step) => (step.anySegments ?? []).length > 0);
  const pressed = steps.some((step) => step.submitVia !== undefined);
  if (pressed || lists || steps.some((step) => step.dismiss !== undefined))
    return {
      version: pressed ? (8 as const) : lists ? (7 as const) : (6 as const),
      ...(origins.workspace === undefined
        ? {}
        : { workspace: { parent: origins.workspace.parent } }),
      steps: steps.map(recipeStep),
      signedIn,
    };
  if (steps.some((step) => step.submitKey !== undefined || step.refills !== undefined))
    return {
      version: 5 as const,
      ...(origins.workspace === undefined
        ? {}
        : { workspace: { parent: origins.workspace.parent } }),
      steps: steps.map(recipeStep),
      signedIn,
    };
  if (origins.workspace === undefined && steps.every((step) => step.origin === undefined))
    return {
      version: steps.some((step) => step.popup !== undefined || step.approval !== undefined)
        ? (2 as const)
        : (1 as const),
      steps: steps.map(recipeStep),
      signedIn,
    };
  return {
    version: 4 as const,
    ...(origins.workspace === undefined ? {} : { workspace: { parent: origins.workspace.parent } }),
    steps: steps.map(recipeStep),
    signedIn,
  };
};
