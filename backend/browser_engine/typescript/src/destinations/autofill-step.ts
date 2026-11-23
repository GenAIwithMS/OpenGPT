import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { failureDetail } from "../runtime/failure-detail.js";
import type { FailureDetail } from "../runtime/failure-detail.js";
import type { HostExecute } from "../runtime/host-execute.js";
import { frameCrossing, unsupportedSelector } from "./autofill-locate-code.js";
import {
  autofillSignedInCode,
  autofillStepCode,
  type ControlIdentity,
  SignedInPage,
} from "./autofill-page-code.js";
import { openAutofillLogin } from "./autofill-page.js";
import {
  foundEvidence,
  foundFor,
  FoundAt,
  FoundIn,
  locatedRefusal,
  namedAfterTyping,
  namedOrigin,
  refused,
  Searched,
  targetEvidence,
  urlOrigin,
  withCheck,
  withEvidence,
} from "./autofill-refusal.js";
import { sameSite, siteDomain } from "../runtime/same-site.js";
import { trustableSignInUrl, trustedUrl } from "../runtime/sign-in-origins.js";
import { type CardSlot, isCardSlot, onPaymentFrameOrigin } from "./payment-frames.js";
import type { PageControls } from "./page-controls.js";
import { redirectCandidate, type SiteNavigation } from "./sign-in-redirect.js";
import type {
  AutofillPopup,
  DateControl,
  DateOfBirthFormat,
  SignInMethodChoice,
  RejectedMarker,
  SubmitKey,
} from "./autofill-contracts.js";

export { SiteNavigation } from "./sign-in-redirect.js";

/** A kind of sign-in identifier: what an identifier field may accept. */
export type IdentifierKind = "username" | "email" | "phone" | "account_number";
/** The order the host picks an accepted identifier kind in when the login holds several. */
export const identifierPreference: readonly IdentifierKind[] = [
  "username",
  "email",
  "phone",
  "account_number",
];
/**
 * A secret a site may check besides the password: the login's date of birth, ZIP or postal code,
 * or one of its recovery codes. It proves the account and never picks it.
 */
export type ExtraSecretSlot = "date_of_birth" | "zip" | "recovery_code" | "private_answer";
/** A secret field's slot: the password, a one-time code or an extra secret. */
export type SecretSlot = "password" | "code" | ExtraSecretSlot;
/** The kind of value a sign-in field takes; the host fills it from the login of that kind. */
export type AutofillSlot = IdentifierKind | SecretSlot;
/**
 * The kind of value a field the fill engine types takes: a sign-in field's, or a card-fill step's
 * part of a payment card, which the host fills from the caller's card answer.
 */
export type FillSlot = AutofillSlot | CardSlot;

/**
 * A field of a sign-in screen. An identifier field lists every kind it accepts (`accepts`, from the
 * minter: a "username or email" field accepts both), and `slot` is the kind the host sends there:
 * one the login holds, by `identifierPreference`, or one the owner gave. A secret field names its
 * slot alone.
 */
export interface AutofillField<Slot extends FillSlot = AutofillSlot> {
  readonly selector: string;
  readonly slot: Slot;
  /** Observed question in the answer field's frame; supported only for private_answer. */
  readonly questionSelector?: string | undefined;
  readonly accepts?: readonly IdentifierKind[] | undefined;
  /** How a `date_of_birth` field takes the date, or the one part of it a dropdown takes. */
  readonly format?: DateOfBirthFormat | undefined;
  /** The control a `date_of_birth` field was filled into, as the host found it. */
  readonly control?: DateControl | undefined;
  /**
   * The accepted kinds the login held when the host filled the field, as kinds only: its saved
   * record's (`vault`) and the owner's answers this attempt (`given`).
   */
  readonly available?:
    | { readonly vault: readonly IdentifierKind[]; readonly given: readonly IdentifierKind[] }
    | undefined;
}

/** A sign-in screen as the minter names it: an identifier field lists the kinds it accepts. */
export interface AutofillStepRequest {
  readonly popup?: AutofillPopup | undefined;
  readonly rejectedMarkers?: readonly RejectedMarker[] | undefined;
  readonly fields: readonly (
    | { readonly selector: string; readonly accepts: readonly IdentifierKind[] }
    | {
        readonly selector: string;
        readonly slot: SecretSlot;
        readonly questionSelector?: string | undefined;
        readonly format?: DateOfBirthFormat | undefined;
        readonly control?: DateControl | undefined;
      }
  )[];
  readonly submit?: string | undefined;
  /** Enter, pressed in the last field to submit its form, on a form with no submit control. */
  readonly submitKey?: SubmitKey | undefined;
  /** A two-factor method choice: every method offered, and `submit` the one picked. */
  readonly methods?:
    readonly { readonly method: SignInMethodChoice; readonly selector: string }[] | undefined;
  /** The own close, reject or accept control of a notice that covers the screen (`AutofillStep`). */
  readonly dismiss?: string | undefined;
}

/**
 * One sign-in screen: the fields the host fills and the control it clicks. A screen that advances
 * by itself names no submit; a method choice or a "Next" names only one. A screen whose form has
 * no submit control and submits on Enter names `submitKey` instead of a submit: the host presses
 * Enter in its last field, which submits that field's form, judged as a clicked submit's would be.
 */
export interface AutofillStep<Slot extends FillSlot = AutofillSlot> {
  readonly popup?: AutofillPopup | undefined;
  readonly rejectedMarkers?: readonly RejectedMarker[] | undefined;
  readonly fields: readonly AutofillField<Slot>[];
  readonly submit?: string | undefined;
  /** Enter, pressed in the last field to submit its form; never with `submit`. */
  readonly submitKey?: SubmitKey | undefined;
  /** A two-factor method choice: every method offered, and `submit` the one picked. */
  readonly methods?:
    readonly { readonly method: SignInMethodChoice; readonly selector: string }[] | undefined;
  /**
   * The own close, reject or accept control of a cookie, consent or similar notice that covers the screen,
   * which the host clicks before it types, when the page shows it, and again before it clicks the
   * submit once more when the notice caught that click. Never a submit or a control of the
   * sign-in's own form (`dismiss_refused`), unless it sits in a notice that covers one of the step's
   * controls: the host then cancels that click's submission, so it submits nothing.
   */
  readonly dismiss?: string | undefined;
  /**
   * `keyboard`: the host presses the submit from the keyboard rather than clicking it first, as a
   * recorded screen whose submit another element covered was sent (a recipe's `submitVia`). Never
   * the minter's: the host's click again of a `blocked` screen presses a covered submit from the
   * keyboard by itself.
   */
  readonly submitVia?: "keyboard" | undefined;
}

/** Whether the host submits the step itself: it clicks its submit or presses its submit key. */
export const hostSubmits = (step: {
  readonly submit?: string | undefined;
  readonly submitKey?: SubmitKey | undefined;
}) => step.submit !== undefined || step.submitKey !== undefined;

/** What the minter says shows the site signed in, which the host checks on the live page. */
export interface AutofillSignedIn {
  readonly selector?: string | undefined;
  readonly urlPath?: string | undefined;
  /** An account page on the site the host opens before it checks; the landing page otherwise. */
  readonly openPath?: string | undefined;
}

/** Where a control sits and its form and link destinations: what the host judges before typing. */
const Target = Schema.Struct({
  ownerUrl: Schema.NullOr(Schema.String),
  /** The origin of each frame between the control's own frame and the top document, nearest first. */
  ancestors: Schema.optional(Schema.Array(Schema.String)),
  /** Its form's `method` attribute, or a control's `formmethod` attribute, says GET. */
  explicitGet: Schema.optional(Schema.Boolean),
  documentOrigin: Schema.String,
  /** Its form's own action first, when it is in a form, then its link and each `formaction`. */
  actions: Schema.Array(Schema.String),
  /**
   * Its form's own action, the first of `actions`, is a script that does nothing (`javascript:`,
   * `javascript:void(0)`, `javascript:;`): the page's own code does whatever sending the form does.
   * A step call that finds it changed judges the controls again.
   */
  scriptAction: Schema.optional(Schema.Boolean),
  /**
   * Its own link destination, one of `actions`, is a script that does nothing: following it sends
   * nothing, and the page's own code does whatever the link does. A step call that finds it changed
   * judges the controls again.
   */
  scriptHref: Schema.optional(Schema.Boolean),
  methods: Schema.Array(Schema.String),
  /**
   * The method its form submits by with it: a submit button's own `formmethod` when it has one,
   * else the form's method; null outside a form. The submit's is the method of the submission the
   * host clicks.
   */
  submitMethod: Schema.optional(Schema.NullOr(Schema.String)),
  editable: Schema.Boolean,
  control: Schema.Literal("date", "text", "select", "combobox", "other"),
  empty: Schema.optional(Schema.Boolean),
});
type Target = typeof Target.Type;
/** A step's controls as the host judges them: each field's target and its submit's. */
export const Targets = Schema.Struct({
  fields: Schema.Array(Target),
  submit: Schema.NullOr(Target),
});

const Text = Schema.NullOr(Schema.String);
/** The tags a covering element reports as its own: any other is `other`. */
const coveringTags = [
  "a",
  "article",
  "aside",
  "button",
  "dialog",
  "div",
  "figure",
  "footer",
  "form",
  "header",
  "iframe",
  "img",
  "label",
  "li",
  "main",
  "nav",
  "p",
  "section",
  "span",
  "svg",
  "table",
  "ul",
] as const;
/** The ARIA roles a covering element reports as its own: any other is none. */
const coveringRoles = [
  "alert",
  "alertdialog",
  "banner",
  "complementary",
  "contentinfo",
  "dialog",
  "document",
  "form",
  "generic",
  "group",
  "main",
  "navigation",
  "none",
  "note",
  "presentation",
  "region",
  "status",
  "toolbar",
  "tooltip",
] as const;
/**
 * The element that sat over a submit and caught the host's click, by its tag and ARIA role, each
 * one of a fixed list: never its text, id, label or class names, which page code may write from
 * what the host typed.
 */
export const CoveringElement = Schema.Struct({
  tag: Schema.Literal(...coveringTags, "other"),
  role: Schema.NullOr(Schema.Literal(...coveringRoles)),
});
/** What page code read of a covering element: its tag and role attribute, as the page has them. */
export const ReadCoveringElement = Schema.Struct({ tag: Schema.String, role: Text });
const isCoveringTag = Schema.is(Schema.Literal(...coveringTags));
const isCoveringRole = Schema.is(Schema.Literal(...coveringRoles));
/** A covering element as the host reports it: a tag or role off its list is none of the page's. */
export const coveringElement = (
  read: typeof ReadCoveringElement.Type,
): typeof CoveringElement.Type => {
  const tag = read.tag.toLowerCase();
  const role = read.role?.trim().toLowerCase();
  return {
    tag: isCoveringTag(tag) ? tag : "other",
    role: role !== undefined && isCoveringRole(role) ? role : null,
  };
};
/** A control as Guardian judges it: its markup's own words, never a value. */
const Described = Schema.Struct({
  tag: Schema.String,
  role: Text,
  /** How its form submits (`get` or `post`, with any control's own `formmethod`). */
  formMethod: Text,
  type: Text,
  name: Text,
  id: Text,
  autocomplete: Text,
  inputmode: Text,
  label: Text,
  placeholder: Text,
  ariaLabel: Text,
  text: Text,
  /** Current visible question; inspection-only, never a recipe value. */
  questionText: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2_000))),
  /**
   * A recorded question the host could not read: in another frame, with no one visible match, or
   * with no text it reads. Inspection-only.
   */
  questionUnread: Schema.optional(Schema.Literal(true)),
  /**
   * A code field that is one of the screen's one-character boxes (an input whose `maxlength` is 1,
   * or one with no `maxlength` that the page's script limits, among like inputs in one parent
   * element or each alone in its own wrapper element in one parent), when the screen shows two or
   * more: its place among them (`box`, from 1) and how many it shows (`of`). Inspection-only, never
   * a recipe value; see `codeBoxesRefusal`.
   */
  codeBox: Schema.optional(Schema.Struct({ box: Schema.Number, of: Schema.Number })),
});

/** A control a step call could not find, or found moved to where the host refuses it. */
export const LocatedError = Schema.Struct({
  error: Schema.Literal(
    "not_found",
    "ambiguous_match",
    "target_changed",
    "not_editable",
    "popup_missing",
    "popup_ambiguous",
  ),
  target: Schema.Union(Schema.Number, Schema.Literal("submit", "popup")),
  /** A private answer's question no longer reads as the host inspected it. */
  question: Schema.optional(Schema.Literal("changed")),
  /** The primary page then, which a fill call reports once it typed. */
  url: Schema.optional(Schema.String),
  /** A fill call's: when the primary page's document began loading (`performance.timeOrigin`). */
  document: Schema.optional(Schema.Number),
  searched: Schema.optional(Searched),
  /** An inert submit: where it was found. */
  located: Schema.optional(FoundIn),
});
const Located = Schema.Union(
  LocatedError,
  Schema.Struct({
    fields: Schema.Array(Schema.Struct({ target: Target, described: Described })),
    submit: Schema.NullOr(Schema.Struct({ target: Target, described: Described })),
    located: Schema.optional(FoundAt),
    buttons: Schema.Array(Schema.String),
    /** A step's submit key: how many submit controls its last field's form shows. */
    keySubmit: Schema.optional(Schema.Struct({ submitControls: Schema.Number })),
    popupTargetId: Schema.optional(Schema.String),
    /** The other boxes of the row the step's one code field begins (`codeBoxRow`). */
    codeBoxRow: Schema.optional(Schema.Array(Schema.String)),
    url: Schema.String,
    /** When the primary page's document began loading (`performance.timeOrigin`). */
    document: Schema.optional(Schema.Number),
  }),
);
/** Why the host typed and clicked nothing. Nothing of the step reached the site. */
export type AutofillRefusal = {
  readonly outcome: "refused";
  readonly reason:
    | "not_found"
    | "ambiguous_match"
    | "selector_unsupported"
    | "not_editable"
    | "credential_target_refused"
    | "page_unavailable"
    | "typing_unavailable"
    | "popup_missing"
    | "popup_ambiguous"
    | "code_boxes_incomplete"
    | "dismiss_refused";
  /** The field (by its index in the step) or the submit control the refusal is about. */
  readonly target?: number | "submit" | "popup" | "dismiss";
  /**
   * `code_boxes_incomplete`: how many one-character code boxes the screen shows, and the place of
   * each box the step's code fields named, in the step's order. Counts only, never a value.
   */
  readonly codeBoxes?: { readonly boxes: number; readonly named: readonly number[] };
  /**
   * Host diagnostics only, never a value: the failed call's own error, or which check refused
   * (its `phase`) with origins and counts as evidence (`withCheck`).
   */
  readonly failureDetail?: FailureDetail;
};

/**
 * The step's controls as the host found them, before anything is typed: where each sits, for the
 * host's own check and the fill's recheck, and how each is labelled, for Guardian.
 */
export interface AutofillInspection {
  /** Host-only target binding for this inspection/fill; never persisted or published. */
  readonly popupTargetId?: string | undefined;
  /**
   * Host-only: the id the page keeps this inspection's controls under, with every form destination
   * as found, which the fill's calls compare against and its guard reads; never persisted.
   */
  readonly judgment?: string | undefined;
  /**
   * Host-only, set when the host had typed into the browser's page before this inspection, which
   * may then find a typed value in any origin: the origins the browser's inspections judged before
   * that, which evidence may name besides the site's and configured sign-in origins
   * (`namedAfterTyping`).
   */
  readonly judgedBeforeTyping?: readonly string[] | undefined;
  /** The guarded live address, for entry selection; never part of the recorded recipe. */
  readonly url?: string;
  /** The page the step's controls are on, origin and path only. */
  readonly page: string;
  readonly targets: typeof Targets.Type;
  /** What the host judged the targets against, which each fill call judges them against again. */
  readonly siteOrigin: string;
  readonly authenticationOrigins: readonly string[];
  /**
   * The host's own trust of more sign-in addresses for this sign-in step (`trustSignInUrl`), which
   * each fill call asks again.
   */
  readonly trustSignInUrl?: ((url: URL) => boolean) | undefined;
  /**
   * Host-only: the origin, scheme, host and port alone, of each address `trustSignInUrl` trusted
   * for this inspection, sorted, each once; absent when it trusted none. Each is within core's
   * floor (`trustableSignInUrl`), since the predicate is asked about nothing else, and none is on
   * the site or an `authenticationOrigins` entry, which it is never asked about.
   */
  readonly trustedSignInOrigins?: readonly string[] | undefined;
  /** The payment frame origins a card field may also sit in, for a card-fill step only. */
  readonly paymentFrameOrigins?: readonly string[] | undefined;
  /**
   * Host-only: the origin this inspection trusted because the sign-in carried its trust along the
   * site's own redirect and the host's review said yes (`inspectAutofillStep`'s `redirect`); it is
   * also in `authenticationOrigins`, so each fill call trusts it too.
   */
  readonly carriedSignInOrigin?: string | undefined;
  /**
   * Host-only: when the step names one code field and it is the first of a row of one-character
   * boxes that each take one by their `maxlength`, a selector for each other box of that row, in
   * order, that matches it alone, read from its id, name or `aria-label`; absent when one has none.
   * Read at run time for a code screen the recipe never recorded, never a recipe value.
   */
  readonly codeBoxRow?: readonly string[] | undefined;
  readonly screen: {
    /**
     * The origin of the frame the host found the step's controls in, its submit's or, when it
     * names no submit, its first field's, as the browser reports it: page code may redefine what
     * the document itself says its origin is.
     */
    readonly origin: string;
    readonly fields: readonly (typeof Described.Type & {
      readonly slot: FillSlot;
      readonly accepts?: readonly IdentifierKind[] | undefined;
      readonly format?: DateOfBirthFormat | undefined;
    })[];
    /**
     * The submit control as found; for a step with a submit key, its last field's form (tag
     * `form`), which the key submits, with that form's method.
     */
    readonly submit: typeof Described.Type | null;
    /**
     * A step's submit key: the key, the field it is pressed in (the last), and how many visible
     * submit controls that field's form has, which Guardian reads to judge the key as the submit.
     */
    readonly submitKey?:
      | { readonly key: SubmitKey; readonly field: number; readonly submitControls: number }
      | undefined;
    /** Visible native and ARIA actions, links included, for a step that names no submit. */
    readonly buttons: readonly string[];
  };
}

/**
 * Kernel's fill vocabulary: a field after the first failed one is never attempted. `changed`: a
 * phone field the host typed into kept other digits than the number's once the page reformatted
 * it, as under a country picker set to another country (`InsertionOptions.phone`), so the host
 * typed nothing after it and never clicked the submit. A keyboard that does not read back never
 * reports it.
 */
export type AutofillFieldStatus = "filled" | "failed" | "not_attempted" | "changed";

/**
 * What one host fill did, with no value in it. `filled` typed the fields in order and says what
 * became of the submit: `none` when the step names none, `page` when such a step's page sent what
 * was typed itself. `uncertain` lost the call's answer, so
 * the fields and the submit may have gone out. Nothing is ever retried by itself (Kernel's fill
 * rule too: a lost answer can follow writes that landed).
 */
export type AutofillStepReport =
  | AutofillRefusal
  | {
      readonly outcome: "filled";
      readonly fields: readonly {
        readonly slot: FillSlot;
        readonly status: AutofillFieldStatus;
      }[];
      /**
       * `clicked`: the host clicked the submit, or pressed the step's submit key in its last field,
       * counting a click or press that ran out of time while the next page loaded once a request
       * for the page's main frame went out, as a form's submission sends. With `via: "keyboard"`,
       * another element caught the host's click again of a `blocked` screen, or the step said to
       * (`submitVia`), and the host pressed Enter on that same submit instead, once focus landed
       * on it.
       * `failed`: the click or press threw before any such request went out.
       * `blocked`: another element sat over the submit and caught the host's click (`blockedBy`),
       * so nothing was sent; the fields still hold what was typed. A fill reports it so; a click
       * again does only when focus would not land on the submit for a press from the keyboard.
       * `refused`: after the fill the host refused a control where it then sat or submitted.
       * `stayed_disabled`: the submit stayed disabled after the fields were filled, through the
       * host's wait for the page to enable it, so the host never clicked it.
       * `page`: on a step with no submit, once every field was typed, the page moved on before the
       * host clicked anything, as a code widget that sends itself on its last box does: the step's
       * fields went away or were all disabled, its popup closed, the page's address moved to
       * another path, or a step of several fields came back with every field empty. What the step
       * filled may have gone out (`maySend`); the sign-in's own check decides what it did.
       */
      readonly submit:
        | "clicked"
        | "blocked"
        | "failed"
        | "not_attempted"
        | "refused"
        | "stayed_disabled"
        | "none"
        | "page";
      /**
       * The host clicked a submit that is `refused`: its guard stopped the submission as it fired,
       * after the page's own handlers ran on the click, so what the step filled may have gone out.
       */
      readonly clicked?: true;
      /** A `clicked` submit the host pressed from the keyboard: Enter on the submit itself. */
      readonly via?: "keyboard";
      /** What caught a `blocked` click, by its markup's own names, never its text or a value. */
      readonly blockedBy?: typeof CoveringElement.Type;
      /** The primary page after the submit settled, byte-exact like every URL. */
      readonly url: string;
      /** Host diagnostics only: why a field or the submit was refused once something was typed. */
      readonly failureDetail?: FailureDetail;
      /** Host-only: a value reached the page, even one a field no longer holds. */
      readonly typed?: true;
      /**
       * Host-only: the origins `trustSignInUrl` trusted when the fill judged again a control the
       * page moved, as `AutofillInspection.trustedSignInOrigins` names them.
       */
      readonly trustedSignInOrigins?: readonly string[];
      /**
       * Host-only, on a `clicked` submit of a fill whose host said what it typed before
       * (`typedBefore`): where the page went on its own from the click until it settled
       * (`SiteNavigation`), which the next step's inspection may carry the sign-in's trust along
       * (`inspectAutofillStep`'s `redirect`). The page chose all of it after typing: the host never
       * logs, keeps or forwards it, and strips it from any report it forwards, as to a minter.
       */
      readonly navigated?: SiteNavigation;
      /**
       * Host-only: the page's controls once a clicked submit settled, never a value, with names as
       * the page has them. The host screens them, shortens them (`presentControls`) and saves them
       * to a workspace file for the minter (`afterSubmitPath`) rather than showing them inline.
       */
      readonly controls?: PageControls;
    }
  | {
      readonly outcome: "uncertain";
      readonly reason: "fill_call_failed";
      /** Host-only: a value may have reached the page. */
      readonly typed?: true;
      /** Host-only: as a filled report's. */
      readonly trustedSignInOrigins?: readonly string[];
      /**
       * Host diagnostics only; finite facts alone when the failed call held a value, a date's or a
       * typing call's. A typing call's has the phase `typing` (`lostTyping`): the host never
       * clicked the submit.
       */
      readonly failureDetail: FailureDetail;
    };

/** The host's check of the minter's signed-in indicator on the live page. */
export type AutofillSignedInCheck =
  | { readonly signedIn: true; readonly url: string }
  | {
      readonly signedIn: false;
      readonly failed:
        | "indicator_not_visible"
        | "path_mismatch"
        | "password_field_visible"
        | "challenge_form_visible"
        | "selector_unsupported"
        | "off_site"
        | "page_unavailable";
      readonly url?: string;
      /**
       * A password field of the sign-in's own screens shows too, on a page that failed for the
       * marker first (`indicator_not_visible` or `path_mismatch`).
       */
      readonly passwordFieldVisible?: true;
      readonly failureDetail?: FailureDetail;
    };

export interface AutofillPage {
  readonly execute: HostExecute;
  readonly targetId: string;
}

/**
 * The host's predicate for more sign-in addresses, when `trust` has one and `step` is a sign-in's,
 * with no part of a payment card; else undefined.
 */
const signInUrlTrust = (
  trust: { readonly trustSignInUrl?: ((url: URL) => boolean) | undefined },
  step: AutofillStep<FillSlot>,
) => (step.fields.some((field) => isCardSlot(field.slot)) ? undefined : trust.trustSignInUrl);

/**
 * Whether the host trusts `value` for a sign-in step by its own predicate: never an address core
 * would not let it trust (`trustableSignInUrl`), which the predicate is never asked about. A
 * predicate that throws trusts nothing.
 */
const hostTrusts = (predicate: ((url: URL) => boolean) | undefined, value: string) => {
  if (predicate === undefined) return false;
  const url = URL.parse(value);
  if (url === null || !trustableSignInUrl(url)) return false;
  try {
    return predicate(url) === true;
    // error-reporting-allow: typed-recovery a host predicate that throws trusts nothing, so the step is refused as untrusted
  } catch {
    return false;
  }
};

/**
 * `predicate`, which also adds to `trusted` the origin of each address it trusts; undefined
 * without one. An address it does not trust, or throws on, adds nothing.
 */
export const notingHostTrust = (
  predicate: ((url: URL) => boolean) | undefined,
  trusted: Set<string>,
) =>
  predicate === undefined
    ? undefined
    : (url: URL) => {
        const trusts = predicate(url) === true;
        if (trusts) trusted.add(url.origin);
        return trusts;
      };

/** Whether an address a control reports is a script, whatever it runs. */
const isScriptAddress = (url: string) => URL.parse(url)?.protocol === "javascript:";

/**
 * The first control that sits or submits off the site and its configured sign-in origins, or a
 * field still to be typed (from index `from`) that takes no typing: where its own frame, document,
 * form actions and link destination are, naming only `named` origins once anything was typed. A
 * field for a part of a payment card may also sit in a frame on one of `paymentFrameOrigins`,
 * exactly; no other field ever counts one as trusted. A sign-in step's controls may also sit and
 * submit on an address the host's own `trustSignInUrl` trusts, within core's floor for it (see
 * `inspectAutofillStep`); a card-fill step's never do. A sign-in step's control whose form's own
 * action is a script that does nothing (`scriptAction`) is judged by its frame, document and other
 * destinations: navigating to such an action sends nothing, and the page's code, which can read the
 * field anyway, does the sending. A sign-in step's link whose own address is such a script
 * (`scriptHref`) is likewise judged by its frame, document and other destinations: following it
 * sends nothing. A sign-in step that types nothing, such as a sign-in provider chooser, on a
 * browser the host has typed nothing into yet (`judgedBeforeTyping` unset) judges its submit by its
 * frame, document and destinations other than scripts, whatever a script runs: no script can send
 * a typed value, and the next screen is inspected before anything is typed there.
 * A card-fill step's never is, nor any other script action or link.
 */
export const untrustedTarget = (
  targets: typeof Targets.Type,
  step: AutofillStep<FillSlot>,
  trust: {
    readonly siteOrigin: string;
    readonly authenticationOrigins: readonly string[];
    readonly paymentFrameOrigins?: readonly string[] | undefined;
    readonly trustSignInUrl?: ((url: URL) => boolean) | undefined;
    readonly judgedBeforeTyping?: readonly string[] | undefined;
  },
  from: number,
  named?: ReadonlySet<string>,
) => {
  const predicate = signInUrlTrust(trust, step);
  const signIn = !step.fields.some((field) => isCardSlot(field.slot));
  // Nothing typed on this browser yet either, so no script can carry a typed value anywhere.
  const typesNothing =
    signIn && step.fields.length === 0 && trust.judgedBeforeTyping === undefined;
  const trusted = (url: string, card: boolean) =>
    trustedUrl(trust.siteOrigin, trust.authenticationOrigins, url) ||
    (card && onPaymentFrameOrigin(url, trust.paymentFrameOrigins ?? [])) ||
    hostTrusts(predicate, url);
  const untrustedPart = (target: Target, action: string, card = false) => {
    if (!trusted(target.ownerUrl ?? "", card)) return "frame";
    if (!trusted(target.documentOrigin, card)) return "document_origin";
    // A sign-in step that types nothing sends nothing of the login: any script address among its
    // control's destinations is the page's own code, not where a value goes, and the screen its
    // click leads to is judged again before anything is typed there.
    if (typesNothing)
      return target.actions.every((url) => isScriptAddress(url) || trusted(url, card))
        ? undefined
        : action;
    // A sign-in form's own action that is a script doing nothing sends nothing itself; its other
    // destinations still count.
    const script = signIn && target.scriptAction === true && target.actions[0] === "javascript:";
    const destinations = script ? target.actions.slice(1) : target.actions;
    // So does a sign-in link's own address that is such a script. Every script address reads as
    // `javascript:` here, so dropping one leaves exactly the others, and each of them still counts.
    const link = signIn && target.scriptHref === true ? destinations.indexOf("javascript:") : -1;
    const sent = link === -1 ? destinations : destinations.filter((_, index) => index !== link);
    return sent.every((url) => trusted(url, card)) ? undefined : action;
  };
  /**
   * A card field's own checks: every frame above its own is on the site or on its own frame's
   * origin, so no frame off them wraps a payment frame; and off a payment frame, its form never
   * says GET (`explicitGet`), which would put the card in an address.
   */
  const cardPart = (target: Target) => {
    const own = urlOrigin(target.ownerUrl ?? "");
    const wrapping = (target.ancestors ?? []).find(
      (origin) => origin !== own && !trusted(origin, false),
    );
    if (wrapping !== undefined) return { part: "ancestor_frame", ancestorOrigin: namedOrigin(wrapping, named) };
    const inPaymentFrame = onPaymentFrameOrigin(target.ownerUrl ?? "", trust.paymentFrameOrigins ?? []);
    return !inPaymentFrame && target.explicitGet === true ? { part: "form_method" } : undefined;
  };
  const refusedAt = (
    index: number | "submit",
    target: Target,
    part: string,
    evidence: Readonly<Record<string, string>> = {},
  ) =>
    withCheck(refused("credential_target_refused", index), "destination", {
      part,
      ...targetEvidence(target, named),
      ...evidence,
    });
  for (const [index, target] of targets.fields.entries()) {
    const card = isCardSlot(step.fields[index]?.slot);
    const part = untrustedPart(target, "form_action", card);
    if (part !== undefined) return refusedAt(index, target, part);
    const carded = card ? cardPart(target) : undefined;
    if (carded !== undefined) {
      const { part: cardCheck, ...evidence } = carded;
      return refusedAt(index, target, cardCheck, evidence);
    }
    // A date also goes into an enabled select or dropdown, which takes a choice, not typing.
    const choosable =
      step.fields[index]?.slot === "date_of_birth" &&
      (target.control === "select" || target.control === "combobox");
    if (index >= from && !target.editable && !choosable)
      return withCheck(refused("not_editable", index), "not_editable", {
        control: target.control,
        ...targetEvidence(target, named),
      });
  }
  const part = targets.submit && untrustedPart(targets.submit, "submit_destination");
  return targets.submit && part ? refusedAt("submit", targets.submit, part) : undefined;
};

/**
 * A new sign-in origin the site's own redirect led to, for its host's review: the origin and path
 * of the screen the sign-in submitted, which the host trusted, the origin the page settled on with
 * that page's path and title, and each navigation between them in order. No path holds a query or
 * fragment, and none of it holds a value the sign-in typed (`reportedNavigation`), yet the page
 * chose it after the host typed, so the host screens it as it would the page's own text before it
 * shows or forwards it.
 */
export interface SignInRedirect {
  readonly from: string;
  readonly fromPathname?: string | undefined;
  readonly candidate: string;
  readonly candidatePathname?: string | undefined;
  readonly candidateTitle?: string | undefined;
  readonly chain: readonly string[];
}

/**
 * The origin a sign-in step's inspection may trust along the site's own redirect
 * (`inspectAutofillStep`'s `redirect`), once the host's review said yes; undefined otherwise.
 */
const carriedRedirect = (
  input: Parameters<typeof inspectAutofillStep>[0],
  found: { readonly url: string; readonly document?: number | undefined },
  targets: typeof Targets.Type,
  named: ReadonlySet<string> | undefined,
) =>
  Effect.gen(function* () {
    const { redirect, step } = input;
    // Only a primary tab's step, never a popup's. A card-fill step needs no rule of its own: its
    // page must be on the site's own registrable domain (`top_document`), already trusted, so the
    // live origin it could carry adds nothing to what its controls are judged against.
    if (redirect === undefined || step.popup !== undefined) return undefined;
    const predicate = signInUrlTrust(input, step);
    // The screen the sign-in left must be one the host trusted for it.
    const from = redirect.from;
    if (
      !trustedUrl(input.siteOrigin, input.authenticationOrigins, from) &&
      !hostTrusts(predicate, from)
    )
      return undefined;
    const candidate = redirectCandidate({
      from,
      navigated: redirect.navigated,
      live: { url: found.url, document: found.document },
    });
    if (candidate === undefined) return undefined;
    // Every control sits and submits on the new origin or one already trusted.
    const widened = {
      ...input,
      authenticationOrigins: [...input.authenticationOrigins, candidate],
      trustSignInUrl: predicate,
    };
    if (untrustedTarget(targets, step, widened, 0, named) !== undefined) return undefined;
    const { navigated } = redirect;
    const allowed = yield* redirect.review({
      from: navigated.from,
      ...(navigated.fromPathname === undefined ? {} : { fromPathname: navigated.fromPathname }),
      candidate,
      ...(navigated.pathname === undefined ? {} : { candidatePathname: navigated.pathname }),
      ...(navigated.title === undefined ? {} : { candidateTitle: navigated.title }),
      chain: navigated.origins,
    });
    return allowed ? candidate : undefined;
  });

/**
 * Finds the step's controls on the live browser's primary tab and judges where they submit, before
 * any value is typed. The contract is Kernel's vault fill, with our own
 * vault and our own fill: the minter found the fields, and this trusted controller authorizes the
 * destination. A credential goes only into a field whose frame, form actions and submit's link
 * destination are on the site's registrable domain or a configured sign-in origin; a sign-in
 * form's own action that is a script doing nothing, which sends nothing itself, is judged by where
 * the field sits and the form's other destinations, and a sign-in submit link whose own address is
 * such a script by where it sits and its other destinations. A sign-in step that types nothing,
 * before anything was typed on the browser, judges any script address of its submit that way,
 * whatever the script runs. A form that
 * submits by GET is allowed when it is clearly the login form, which Guardian judges; its values
 * land in a URL that stays byte-exact. Once the host typed into the page
 * (`judgedBeforeTyping` given), a refusal names only the origins `namedAfterTyping` allows.
 * A step with a part of a payment card (a card-fill step) is refused unless the primary tab's top
 * document is on the site, and its card fields may sit in a frame on `paymentFrameOrigins`.
 * `trustSignInUrl` lets a sign-in step's controls and popup also sit on an address the host's own
 * predicate trusts, asked only about one core's own floor allows; the inspection keeps it, so each
 * fill call judges again by the same rule, and names the origin of each address it trusted
 * (`trustedSignInOrigins`). Evidence names origins as before.
 */
export const inspectAutofillStep = (input: {
  readonly step: AutofillStep<FillSlot>;
  readonly page: AutofillPage;
  readonly siteOrigin: string;
  readonly authenticationOrigins: readonly string[];
  readonly paymentFrameOrigins?: readonly string[] | undefined;
  readonly judgedBeforeTyping?: readonly string[] | undefined;
  /**
   * The host's own trust of more sign-in addresses for a sign-in step, as when its user allowed the
   * sign-in to go wherever the site sends it: asked about each address of a control or popup off
   * the site and `authenticationOrigins` that core's own floor allows, never about a card-fill
   * step's. The floor: an https address with no user name or password, on a host with a
   * registrable domain under a listed public suffix; never plain http, an IP address, localhost, a
   * bare public suffix, a name only a private network resolves (under .localhost, .internal,
   * .local, .test or .invalid), or a host under .arpa or .onion. It is also asked after typing,
   * about addresses the page shaped, which may hold what was typed: the host must never log, keep
   * or forward a URL it is asked about, and answers from the URL alone. A predicate that throws
   * trusts nothing. Unset, only the site and `authenticationOrigins`.
   *
   * An inspection that passes names the origin of each address the predicate trusted
   * (`trustedSignInOrigins`), scheme, host and port alone, on a screen first reached after typing
   * too, where refusal evidence still names an origin no inspection judged `other`. The host chose
   * to trust that host with the sign-in, so it may keep the origin as the record of where the
   * sign-in went. Like any address the page shaped after typing, it may hold part of what was
   * typed, so the host screens it as it would the page's own text before it shows or forwards it.
   */
  readonly trustSignInUrl?: ((url: URL) => boolean) | undefined;
  /**
   * The sign-in's last submitted screen, for a host that lets a sign-in keep the trust it gave a
   * screen along the redirect the site starts from that screen's submit (`SignInRedirect`). Asked
   * only of a sign-in step's primary tab, with no popup, whose controls a destination check
   * refused: when `from` was trusted for this sign-in, the live page is where the site's own
   * navigation from the host's click on `from` settled with nothing navigating it since
   * (`redirectCandidate`), and every control sits and submits on that origin or one already
   * trusted, the host's `review` judges the new origin in context. Only its yes trusts the origin,
   * for this inspection and its fill (`carriedSignInOrigin`). Unset, or the review says no, the
   * step is refused as before.
   */
  readonly redirect?:
    | {
        /** The page of the screen the host last submitted in this sign-in. */
        readonly from: string;
        /** Where that submit's click went (`AutofillStepReport`'s `navigated`). */
        readonly navigated: SiteNavigation;
        readonly review: (redirect: SignInRedirect) => Effect.Effect<boolean>;
      }
    | undefined;
}): Effect.Effect<AutofillRefusal | AutofillInspection> =>
  Effect.gen(function* () {
    const { step, page, siteOrigin } = input;
    let { authenticationOrigins } = input;
    const predicate = signInUrlTrust(input, step);
    const trustedByHost = new Set<string>();
    const asking = notingHostTrust(predicate, trustedByHost);
    if (
      step.popup !== undefined &&
      !trustedUrl(siteOrigin, authenticationOrigins, step.popup.origin) &&
      !hostTrusts(asking, step.popup.origin)
    )
      return withCheck(refused("credential_target_refused"), "destination", {
        part: "popup",
        popupOrigin: urlOrigin(step.popup.origin),
      });
    const crossing = unsupportedSelector(step);
    if (crossing !== undefined)
      return withCheck(refused("selector_unsupported", crossing), "selector_unsupported");
    // This call's code holds no value, so its failure keeps its full detail.
    const judgment = randomUUID();
    const inspected = yield* page
      .execute(autofillStepCode(page.targetId, step, judgment), 15)
      .pipe(Effect.flatMap(Schema.decodeUnknown(Located)), Effect.either);
    if (inspected._tag === "Left")
      return {
        ...refused("page_unavailable"),
        failureDetail: failureDetail("autofill_step_failed", {
          operation: "autofill.inspect",
          error: inspected.left,
        }),
      };
    const found = inspected.right;
    const named = namedAfterTyping(input);
    if ("error" in found) return locatedRefusal(found, named);
    const top = URL.parse(found.url);
    if (
      step.fields.some((field) => isCardSlot(field.slot)) &&
      (top === null || !sameSite(siteOrigin, top))
    )
      return withCheck(refused("credential_target_refused"), "top_document", {
        part: "top_document",
        ...foundEvidence(found.url, undefined, named),
      });
    const targets = {
      fields: found.fields.map(({ target }) => target),
      submit: found.submit === null ? null : found.submit.target,
    };
    const untrusted = untrustedTarget(targets, step, { ...input, trustSignInUrl: asking }, 0, named);
    const carried =
      untrusted === undefined ? undefined : yield* carriedRedirect(input, found, targets, named);
    if (untrusted && carried === undefined)
      return withEvidence(
        untrusted,
        foundEvidence(found.url, foundFor(found.located, untrusted.target), named),
      );
    if (carried !== undefined) authenticationOrigins = [...authenticationOrigins, carried];
    // A submit key submits its last field's form, so a field in no form has nothing it submits.
    if (step.submitKey !== undefined && (targets.submit?.submitMethod ?? null) === null)
      return withCheck(refused("credential_target_refused", "submit"), "submit_key", {
        part: "no_form",
        ...foundEvidence(found.url, foundFor(found.located, "submit"), named),
      });
    const at = URL.parse(found.url);
    const frame = (found.submit ?? found.fields[0])?.target.ownerUrl;
    return {
      url: found.url,
      page: at === null ? "" : `${at.origin}${at.pathname}`,
      ...(found.popupTargetId === undefined ? {} : { popupTargetId: found.popupTargetId }),
      judgment,
      judgedBeforeTyping: input.judgedBeforeTyping,
      targets,
      siteOrigin,
      authenticationOrigins,
      ...(predicate === undefined ? {} : { trustSignInUrl: predicate }),
      ...(trustedByHost.size === 0 ? {} : { trustedSignInOrigins: [...trustedByHost].sort() }),
      ...(carried === undefined ? {} : { carriedSignInOrigin: carried }),
      ...(found.codeBoxRow === undefined ? {} : { codeBoxRow: found.codeBoxRow }),
      ...(input.paymentFrameOrigins === undefined
        ? {}
        : { paymentFrameOrigins: input.paymentFrameOrigins }),
      screen: {
        origin: frame ? urlOrigin(frame) : "",
        fields: found.fields.map(({ described }, index) => {
          const field = step.fields[index];
          return {
            ...described,
            slot: field?.slot ?? "username",
            ...(field?.accepts === undefined ? {} : { accepts: field.accepts }),
            ...(field?.format === undefined ? {} : { format: field.format }),
          };
        }),
        submit: found.submit === null ? null : found.submit.described,
        ...(step.submitKey === undefined || found.keySubmit === undefined
          ? {}
          : {
              submitKey: {
                key: step.submitKey,
                field: step.fields.length - 1,
                submitControls: found.keySubmit.submitControls,
              },
            }),
        buttons: found.buttons,
      },
    };
  });

/**
 * A code step that names only part of its screen's one-character code boxes, or names them out of
 * order: a refusal before anything is typed or reviewed, which says how many boxes the screen shows
 * and which ones the step named (`codeBoxes`), so the step can be sent again with every box. A code
 * split across boxes takes one character in each, so a step that leaves a box out can never send
 * the whole code. Undefined when the step's code fields that are boxes (`codeBox`, from the
 * inspection) are every box, first to last, or when none of its code fields is one.
 */
export const codeBoxesRefusal = (
  step: Pick<AutofillStep, "fields">,
  inspection: Pick<AutofillInspection, "screen">,
): AutofillRefusal | undefined => {
  const named = step.fields.flatMap((field, index) => {
    const box = field.slot === "code" ? inspection.screen.fields[index]?.codeBox : undefined;
    return box === undefined ? [] : [{ index, ...box }];
  });
  const first = named[0];
  if (first === undefined) return undefined;
  const boxes = Math.max(...named.map(({ of }) => of));
  if (named.length === boxes && named.every(({ box }, at) => box === at + 1)) return undefined;
  return {
    ...withCheck(refused("code_boxes_incomplete", first.index), "code_boxes", {
      boxes,
      named: named.length,
    }),
    codeBoxes: { boxes, named: named.map(({ box }) => box) },
  };
};

/** The site's registrable domain, or its host where it has none, for the marker's frames. */
const siteHost = (siteOrigin: string) =>
  siteDomain(siteOrigin) ?? URL.parse(siteOrigin)?.hostname ?? "";

/** Opens the account page the check names, on the site only; the check's failure when it cannot. */
const openAccountPage = (openPath: string | undefined, page: AutofillPage, siteOrigin: string) =>
  Effect.gen(function* () {
    if (openPath === undefined) return undefined;
    const account = URL.parse(openPath, siteOrigin);
    if (account === null || account.origin !== siteOrigin)
      return { signedIn: false as const, failed: "off_site" as const };
    // This call's code holds no value, so its failure keeps its full detail.
    const opened = yield* Effect.either(openAutofillLogin({ page, url: account.href }));
    if (opened._tag === "Right") return undefined;
    return {
      signedIn: false as const,
      failed: "page_unavailable" as const,
      failureDetail: failureDetail("autofill_step_failed", {
        operation: "autofill.signed_in.open",
        error: opened.left,
      }),
    };
  });

/**
 * A sign-in's recorded fields: selectors and, when present, slots of one-use challenges, with the
 * words, type, autocomplete, name and id that named each control when the host inspected it
 * (`identity`).
 */
export type AutofillScreens = readonly {
  readonly popup?: AutofillPopup | undefined;
  readonly fields: readonly {
    readonly selector: string;
    readonly slot?: AutofillSlot;
    readonly identity?: ControlIdentity | undefined;
  }[];
}[];

/**
 * Checks the minter's signed-in indicator on the live page: the selector is visible and the path
 * matches, the page is on the site, and no password field of the sign-in's own `screens` (the
 * recipe's in a run, the minter's in a mint) is left: one of their fields, or one in the form of a
 * visible one. It also refuses an explicitly recorded challenge field of the current sign-in's
 * `challengeScreens` (`screens` unless given) while the same control still shows and takes
 * typing, on the site or one of `authenticationOrigins`, a provider frame included. The same
 * control is one the same words name as named the field at inspection (its label, `aria-label`
 * and placeholder), with its type, autocomplete, name and id where recorded. A field recorded with
 * no such words counts for nothing, since the host cannot tell it from another control its
 * selector matches. A challenge the page renders again under other naming counts as another
 * control and stops counting: a label that now holds the site's error text, or an id or name the
 * page generates on each render, such as `:r3:` or `mat-input-3`. The check then fails open, and
 * the indicator still decides. A read-only or disabled control, an unconfigured off-site frame, a
 * frame inside a hidden one, and a control or frame the host cannot read in time, such as one that
 * detaches during the check, do not count. It does not classify unrecorded controls or infer a
 * challenge from the page route. Callers must inspect and record each authentication screen
 * before checking completion. Another form's password field does not count unless a recorded
 * selector matches in it. Screens with no field leave any visible password field failing it.
 */
export const checkAutofillSignedIn = (input: {
  readonly indicator: AutofillSignedIn;
  readonly page: AutofillPage;
  readonly siteOrigin: string;
  readonly screens: AutofillScreens;
  /** The current sign-in's screens, whose recorded challenges count; `screens` by default. */
  readonly challengeScreens?: AutofillScreens | undefined;
  /** The configured sign-in origins off the site, where a recorded challenge also counts. */
  readonly authenticationOrigins?: readonly string[] | undefined;
}): Effect.Effect<AutofillSignedInCheck> =>
  Effect.gen(function* () {
    const { indicator, page } = input;
    if (indicator.selector !== undefined && frameCrossing(indicator.selector))
      return { signedIn: false as const, failed: "selector_unsupported" as const };
    const opened = yield* openAccountPage(indicator.openPath, page, input.siteOrigin);
    if (opened !== undefined) return opened;
    // A screen with a frame-crossing selector never ran, so it holds none of the sign-in's fields.
    const signInFields = input.screens
      .filter((screen) => screen.popup === undefined)
      .flatMap((screen) => screen.fields.map((field) => field.selector))
      .filter((selector) => !frameCrossing(selector));
    const challengeFields = (input.challengeScreens ?? input.screens)
      .filter((screen) => screen.popup === undefined)
      .flatMap((screen) => screen.fields)
      .flatMap((field) =>
        (field.slot === "private_answer" || field.slot === "code" || field.slot === "recovery_code") &&
        !frameCrossing(field.selector) &&
        field.identity !== undefined &&
        (field.identity.label ?? field.identity.ariaLabel ?? field.identity.placeholder) !== null
          ? [{ selector: field.selector, identity: field.identity }]
          : [],
      );
    const read = yield* page
      .execute(
        autofillSignedInCode(
          page.targetId,
          indicator.selector,
          siteHost(input.siteOrigin),
          signInFields,
          input.screens.flatMap((screen) => (screen.popup === undefined ? [] : [screen.popup])),
          challengeFields,
          input.authenticationOrigins ?? [],
        ),
        15,
      )
      .pipe(Effect.flatMap(Schema.decodeUnknown(SignedInPage)), Effect.either);
    if (read._tag === "Left")
      return {
        signedIn: false as const,
        failed: "page_unavailable" as const,
        failureDetail: failureDetail("autofill_step_failed", {
          operation: "autofill.signed_in",
          error: read.left,
        }),
      };
    const { url, indicator: visible, passwordVisible, challengeFormVisible } = read.right;
    const parsed = URL.parse(url);
    if (parsed === null || !sameSite(input.siteOrigin, parsed))
      return { signedIn: false as const, failed: "off_site" as const, url };
    const form = passwordVisible ? { passwordFieldVisible: true as const } : {};
    if (visible === false)
      return { signedIn: false as const, failed: "indicator_not_visible" as const, url, ...form };
    if (indicator.urlPath !== undefined && parsed.pathname !== indicator.urlPath)
      return { signedIn: false as const, failed: "path_mismatch" as const, url, ...form };
    if (passwordVisible)
      return { signedIn: false as const, failed: "password_field_visible" as const, url };
    if (challengeFormVisible)
      return { signedIn: false as const, failed: "challenge_form_visible" as const, url };
    return { signedIn: true as const, url };
  });

export { openAutofillLogin };
