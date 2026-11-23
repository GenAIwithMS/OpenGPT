import { fileURLToPath } from "node:url";
import { Effect, Scope } from "effect";
import { createLocalWorkspace } from "../execution/local-workspace.js";
import { seedLocalRuntime } from "../execution/local-runtime-assets.js";
import type { LocalOperationJournal } from "../execution/local-operation.js";
import type { PlaywrightExecutor } from "../execution/playwright-execute.js";
import type { ConfirmSession } from "../browser/dialogs/expected.js";
import {
  identifierPreference,
  type FillSlot,
  type AutofillStepReport,
  type AutofillStepRequest,
} from "../destinations/autofill-step.js";
import { MintFailure, type ExecutionRequest, type WritePath } from "../mint/contracts.js";
import { makeSecretHandles } from "../mint/secret-handles.js";
import type { FileHandles } from "../mint/file-handles.js";
import { makeSignInRecorder } from "../mint/sign-in-recorder.js";
import type { GuardianAction } from "../guardian/review-contracts.js";
import type { OutcomeAssessment } from "../mint/outcome-review-contracts.js";
import type { WriteSessionMarks } from "../mint/write-session.js";
import { loadStandaloneAuthoring } from "../mint/skills.js";
import { screenMintText } from "../mint/workspace.js";
import { Deadline } from "../runtime/deadline.js";
import { failureDetail } from "../runtime/failure-detail.js";
import type { InputAsker } from "../runtime/input-request.js";
import { mintSessionSignIns, signedInAtEntry } from "../runtime/session-sign-in.js";
import {
  localStartHooks,
  makeStartTracker,
  startPage,
} from "../runtime/start-state.js";
import { makeAfterSubmit } from "./after-submit.js";
import { localSignInLogin, makeSignInBrowser, repeatedLoginFailure } from "./authentication.js";
import { makeMarkerChecks } from "./signed-in-marker.js";
import {
  makeBoundableAsk,
  makeLocalSessionSignIn,
  makeRejectableLogin,
  mintSessionSignInFailure,
} from "./session-sign-in.js";
import type { KeptScriptAnswer } from "../mint/script-answer-reuse.js";
import type { StandaloneSession } from "./session.js";
import type { RequestContext } from "./request-context.js";
import type { BrowserEngineRequest } from "./contracts.js";
const identifiers: ReadonlySet<FillSlot> = new Set(identifierPreference);
/** What the host does with a sign-in step Guardian allows, for its review. */
const signInStepNote =
  "The host fills the login's values, which never appear in this review, into the fields the step names and clicks the named submit on the sign-in screen of the authorized site.";
/** A step that could not start its page: the browser call failed, so nothing ran. */
const unavailable = (operation: string) => (error: unknown) =>
  new MintFailure({
    code: "Unavailable",
    failureDetail: failureDetail("mint_host_dependency_failed", { operation, error }),
  });
/**
 * Where a build's live steps start. The first step that is not reset loads the request's URL once.
 * A live example, a live test and a write session's first step reset the page and load the site
 * root, keeping the browser's cookies and site storage unless a sign-in started and was never
 * verified; see `startStateFor`. A check counts the build signed in only once a sign-in step sent
 * the login (see `sent`). `leavePage` runs before each reset, so the page the last step left is
 * never taken for the reset step's page, even when the reset fails. `afterSignedOutReset` runs
 * once a reset left the page signed out: one that cleared the browser's cookies and site storage,
 * or any reset before a sign-in started on the browser (`signInStartedBefore` counts one an
 * earlier build on it started). `afterSignedInReset` runs once a reset kept the session of a
 * verified sign-in, which the reset's load may have signed out; it may reset the page the same
 * way again with `reopen`. A reset while a later sign-in is unsettled runs neither.
 */
export const makeBuildStart = (
  browser: Pick<PlaywrightExecutor, "execute" | "targetId">,
  siteOrigin: string,
  enterRequest: Effect.Effect<void, Error>,
  leavePage: () => void,
  afterSignedOutReset: Effect.Effect<void> = Effect.void,
  afterSignedInReset: (
    reopen: Effect.Effect<void, MintFailure>,
  ) => Effect.Effect<void, MintFailure> = () => Effect.void,
  signInStartedBefore: () => boolean = () => false,
) => {
  const tracker = makeStartTracker({ signInStartedBefore });
  const hooks = localStartHooks(browser.execute, browser.targetId);
  let entered = false;
  const enter = Effect.suspend(() =>
    entered
      ? Effect.void
      : enterRequest.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              entered = true;
            }),
          ),
        ),
  );
  return {
    /** Loads the request's URL, unless a live step already loaded a page. */
    enter,
    /** A sign-in step; see `makeStartTracker`. */
    signIn: tracker.signIn,
    /**
     * What a host fill step may have sent. The host can't see the request itself, so every field
     * the fill typed counts, whatever became of its submit: the page may send what was typed
     * itself. A submit the page kept disabled was never clicked, so that step sent nothing. A fill
     * whose answer was lost counts every field the step asked for. The signed-in check stays the
     * gate.
     */
    sent: (report: AutofillStepReport, requested: AutofillStepRequest["fields"]) => {
      const slots =
        report.outcome === "filled" && report.submit !== "stayed_disabled"
          ? report.fields.filter((field) => field.status === "filled").map((field) => field.slot)
          : report.outcome === "uncertain"
            ? requested.map((field) => ("slot" in field ? field.slot : "username"))
            : [];
      for (const slot of slots) {
        if (identifiers.has(slot)) tracker.sent("identifier");
        if (slot === "password" || slot === "code") tracker.sent("proof");
      }
    },
    /** The user completed the sign-in's approval. */
    approved: () => tracker.sent("proof"),
    /**
     * An explore made a completed typing call on the site with a code the site sent for the
     * sign-in under way.
     */
    typedCode: () => tracker.sent("proof"),
    /** Whether the current sign-in sent the login. */
    get submitted() {
      return tracker.submitted;
    },
    /** The site showed the build signed in. Returns whether it counted. */
    verified: tracker.verified,
    /** Whether `step` starts on a reset page, not the one the last step left. Changes nothing. */
    resets: (step: Pick<ExecutionRequest, "purpose" | "target">) =>
      tracker.plan({ purpose: step.purpose, live: step.target === "liveBrowser" }) !== "none",
    /** Resets the page or enters the site, before `step` runs. */
    before: (step: Pick<ExecutionRequest, "purpose" | "target">) =>
      Effect.gen(function* () {
        const live = step.target === "liveBrowser";
        const planned = { purpose: step.purpose, live };
        if (step.purpose === "authenticate") tracker.signIn();
        const start = tracker.plan(planned);
        if (start === "none") {
          if (live) yield* enter;
        } else {
          const siteData = start === "clear" ? "clear" : "keep";
          leavePage();
          const reset = Effect.suspend(() =>
            startPage(browser.execute, browser.targetId, siteOrigin, { siteData }, hooks),
          ).pipe(Effect.mapError(unavailable("standalone.startPage")));
          yield* reset;
          entered = true;
          if (siteData === "clear" || !tracker.signInStarted) yield* afterSignedOutReset;
          else if (tracker.signedIn) yield* afterSignedInReset(reset);
        }
        tracker.dispatched(planned);
      }),
  };
};
export const mintState = (
  session: StandaloneSession,
  context: RequestContext,
  request: BrowserEngineRequest,
  /** The handles the request's input holds where the caller's files stood. */
  fileHandles: FileHandles,
) =>
  Effect.gen(function* () {
    const { options, ask, browser, secrets } = session;
    const workspace = yield* createLocalWorkspace();
    yield* seedLocalRuntime(workspace);
    const authoring = yield* loadStandaloneAuthoring(
      fileURLToPath(new URL("../../authoring/", import.meta.url)),
    );
    for (const [path, text] of authoring.files) yield* workspace.write(path, text);
    const handles = makeSecretHandles();
    const deadline = Deadline.after(options.timeoutMs);
    const mintAsk: InputAsker = (candidate, bounds) =>
      Effect.acquireUseRelease(
        Effect.sync(() => deadline.suspend()),
        () => ask(candidate, bounds),
        (resume) => Effect.sync(resume),
      );
    const runs = new Map<
      string,
      {
        readonly sources: readonly (readonly [string, string])[];
        readonly entrypoint: string;
        readonly input: unknown;
        /** The agent's exampleInput the step ran because the caller sent none. */
        readonly intentDerivedInput?: Readonly<Record<string, unknown>>;
        readonly output: unknown;
        /** The names of the expand controls on the page the step left, for the output check. */
        readonly controlLabels?: readonly string[];
        readonly purpose: ExecutionRequest["purpose"];
        readonly journal: LocalOperationJournal;
        /** Guardian's label of the step's website effect. */
        readonly action?: GuardianAction;
        /**
         * An act or example step dispatched once the build's open sign-in sent the login and before
         * any check verified it: the host cannot tell whether it ran signed in.
         */
        readonly afterUnverifiedSignIn?: true;
      }
    >();
    /** The outcome reviewer's newest assessment of each write, by execution. */
    const assessments = new Map<string, OutcomeAssessment>();
    /**
     * The build's one write session: whether its first act step dispatched, and the agent's
     * `exampleInput` it runs when the caller sent none (fixed by the first act step that passed
     * one), its recorded write path (the latest one an allowed act step that dispatched carried),
     * its act steps in order for publication's checks, and the confirm popups its act steps
     * accepted.
     */
    const writeSession: {
      started: boolean;
      input: Readonly<Record<string, unknown>> | undefined;
      path: WritePath | undefined;
      readonly steps: (WriteSessionMarks & { readonly executionId: string })[];
    } & ConfirmSession = {
      started: false,
      input: undefined,
      path: undefined,
      steps: [],
      acceptedConfirms: [],
      confirmSteps: new Set(),
    };
    /** The owner's answers to scripts' questions that the same question asked again reuses. */
    const scriptAnswers: { kept: readonly KeptScriptAnswer[] } = { kept: [] };
    /** Each one-time login URL publication already asked about, so finishing again publishes it. */
    const oneTimeLoginUrlsAsked = new Set<string>();
    const afterSubmit = makeAfterSubmit({ workspace, screen: secrets.json });
    // The build's automatic sign-ins, counted for the whole attempt: a task update that moves
    // the build to another site starts no new allowance.
    const signInsSpent = { attempt: 0, scope: 0 };
    /**
     * Everything bound to the build's site: the sign-in browser and recorder, the marker checks
     * and the build's start. A task update that moves the build to another site binds them anew.
     */
    const bindSite = (siteOrigin: string, authenticationOrigins: readonly string[]) =>
      Effect.gen(function* () {
        /** The site's sign-in origins: the request's. */
        const signInOrigins = { all: (): readonly string[] => authenticationOrigins };
        const signInBrowser = makeSignInBrowser({
          page: browser,
          keyboard: browser.keyboard,
          siteOrigin: siteOrigin,
          authenticationOrigins,
          typing: session.signInTyping,
        });
        // The site as the owner's questions name it: its host, without `www.`.
        const site = new URL(siteOrigin).hostname.replace(/^www\./u, "");
        // One login and one set of value questions for the build's sign-ins, the automatic ones
        // too, whose questions a script's bound limits.
        const signInAsks = makeBoundableAsk(mintAsk);
        // A login value an automatic sign-in sent and the site rejected is not sent again, by any
        // sign-in.
        const login = makeRejectableLogin(
          localSignInLogin({
            ask: signInAsks.ask,
            register: secrets.register,
            siteOrigin: siteOrigin,
          }),
          repeatedLoginFailure,
        );
        const recorder = makeSignInRecorder({
          browser: signInBrowser,
          login: login.login,
          ask: signInAsks.ask,
          secrets,
          // The screen may show a value the caller gave, such as the typed email on a password
          // screen; it reaches Guardian masked. The source check still refuses any value left.
          review: (step, inspection) =>
            screenMintText(
              { projection: session.projection },
              { step, screen: inspection.screen },
            ).pipe(
              Effect.flatMap((source) =>
                context.review(
                  {
                    entrypoint: "operation/sign-in-step.json",
                    sources: new Map([["operation/sign-in-step.json", source]]),
                    input: {},
                    currentExecution: { purpose: "authenticate", target: "liveBrowser" },
                    note: signInStepNote,
                  },
                  "not_sent",
                ),
              ),
              Effect.asVoid,
            ),
          site,
          signedOutPages: () => markers.signedOutPages(),
        });
        const markers = makeMarkerChecks({
          page: browser,
          siteOrigin: siteOrigin,
          // The live check on the build's screens; it ends no sign-in.
          check: (indicator) => {
            const { screens, challengeScreens } = recorder.screens();
            return signInBrowser.confirm(indicator, screens, challengeScreens);
          },
          typing: session.signInTyping,
          loginSent: () => start.submitted || context.signedIn,
          writeSessionStarted: () => writeSession.started,
          observe: context.observe,
        });
        /** Set once the entry page's own load signed a fresh sign-in out again. */
        const lostOnLoad = { current: false };
        const start = makeBuildStart(
          browser,
          siteOrigin,
          context.navigate,
          context.leavePage,
          markers.afterSignedOutReset,
          // A reset reloads the site, which signs out a site that keeps its session only in page
          // memory: the host signs in again before the step can reach the browser.
          (reopen) =>
            signedInAtEntry({
              ensureSignedIn: sessionSignIn
                .ensureSignedIn("signed_out_at_start")
                .pipe(Effect.mapError(mintSessionSignInFailure)),
              reopen,
              lostOnLoad,
            }).pipe(Effect.asVoid),
          // Builds in a session share its browser: once the host typed a sign-in value in it, an
          // earlier build's sign-in may still hold the browser.
          () => session.signInTyping.typed,
        );
        // The build's automatic sign-ins with the sign-in it recorded and verified last.
        const sessionSignIn = makeLocalSessionSignIn({
          browser: signInBrowser,
          recorded: recorder.published,
          login,
          asks: signInAsks,
          secrets,
          site,
          siteOrigin: siteOrigin,
          limits: mintSessionSignIns,
          scope: "check",
          spent: signInsSpent,
          // Only a read build's sign-in may end on a page that can't tell; a write's, one a task
          // update made a write since, or one whose effect the build decides, needs its marker.
          allowCantTell: () => request.effect === "read" && context.buildEffect === "read",
        });
        return { recorder, markers, start, sessionSignIn, signInOrigins };
      });
    context.bindWritePath(() => writeSession.path);
    let bound = yield* bindSite(context.siteOrigin, context.authenticationOrigins);
    // A later binding lives as long as the first: until the request's scope closes.
    const scope = yield* Effect.scope;
    return {
      session,
      context,
      request,
      workspace,
      authoring,
      handles,
      fileHandles,
      deadline,
      mintAsk,
      runs,
      assessments,
      writeSession,
      scriptAnswers,
      oneTimeLoginUrlsAsked,
      afterSubmit,
      get recorder() {
        return bound.recorder;
      },
      get markers() {
        return bound.markers;
      },
      get start() {
        return bound.start;
      },
      get sessionSignIn() {
        return bound.sessionSignIn;
      },
      get signInOrigins() {
        return bound.signInOrigins;
      },
      /**
       * Binds the build to another site, for a task update the host applies, with no sign-in
       * origins of its own; nothing switches unless it succeeds.
       */
      rebindSite: (siteOrigin: string) =>
        bindSite(siteOrigin, []).pipe(
          Scope.extend(scope),
          Effect.map((rebound) => {
            bound = rebound;
          }),
        ),
    };
  });
export type MintState = Effect.Effect.Success<ReturnType<typeof mintState>>;
