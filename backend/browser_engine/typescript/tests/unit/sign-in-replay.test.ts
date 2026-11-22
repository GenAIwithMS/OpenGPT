import { Duration, Effect, Either } from "effect";
import { expect, it } from "vitest";
import type {
  AutofillInspection,
  AutofillSignedInCheck,
  AutofillStep,
  AutofillStepReport,
} from "../../src/destinations/autofill-step.js";
import type { SignInRecipe } from "../../src/destinations/sign-in-recipe.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import {
  type InputAnswers,
  type InputRequest,
  InputRequestFailure,
  type Question,
} from "../../src/runtime/input-request.js";
import {
  signInForRun,
  SignInRunFailed,
  type SignInReplayBrowser,
} from "../../src/runtime/sign-in-replay.js";
import { parseHtml } from "../../src/runtime/html.js";
import { makeAutofillRetryState } from "../../src/runtime/autofill-correction.js";
import { localSignInLogin } from "../../src/standalone/authentication.js";

// A run's sign-in against a synthetic site: a login screen, then an optional method choice, code
// screen or security question, and an account page that shows `#account` once signed in. Each
// fill sends the page's form request carrying what it filled, as a browser would.

interface Login {
  readonly username: string;
  readonly password: string;
}

const origin = "https://www.example.test";
const site = "example.test";
const account: Login = { username: "ada-owner", password: "synthetic-password" };
const code = "482913";
const question = "What was the name of your first pet?";
const answer = "synthetic-pet";

interface SiteOptions {
  /** The session is signed in before the run. */
  readonly signedIn?: boolean;
  /** A signed-in session that opens the login page lands on the account page. */
  readonly redirectWhenSignedIn?: boolean;
  /** The login screen shows `#login-error` after a wrong password. */
  readonly marker?: boolean;
  readonly method?: boolean;
  readonly code?: boolean;
  readonly question?: boolean;
  /** The security question the screen shows on the next load. */
  readonly questions?: string[];
  /** The login screen sits on another origin of the site than the recipe recorded. */
  readonly loginOrigin?: string;
  /** The login screen shows `#username-error` after a wrong username. */
  readonly usernameMarker?: boolean;
  /** The entry page fails to load. */
  readonly entryFails?: boolean;
  /**
   * Where the last screen lands: the account page (by default); a chooser the site shows before
   * any page with the marker, as an account picker; the account page without a session, as a
   * sign-in that failed quietly; or the code screen again with its field gone.
   */
  readonly landing?: "account" | "chooser" | "account_signed_out" | "code_spent";
  /** The chooser's origin, the site's own by default. */
  readonly chooserOrigin?: string;
  /** The code screen's origin, the site's own by default. */
  readonly codeOrigin?: string;
  /**
   * Code screens the recipe never recorded, each as its markup, shown in turn after the login. The
   * right code moves to the next, and past the last the sign-in lands.
   */
  readonly unrecorded?: readonly string[];
  /** The unrecorded screens' origin, the site's own by default. */
  readonly unrecordedOrigin?: string;
  /**
   * How a fill on an unrecorded screen goes, when not as asked: the host refuses it before typing,
   * or types the code and never clicks the submit.
   */
  readonly unrecordedFill?: "refused" | "unclicked";
  /** Markup the login screen shows beside its fields once it refused a login, as a CAPTCHA. */
  readonly captcha?: string;
  /** A recovery code screen's markup, shown after the login, which refuses every code. */
  readonly recovery?: string;
  /** The sign-in origins the run configured off the site. */
  readonly authenticationOrigins?: readonly string[];
}

const pages = {
  login: ["#username", "#password", "#sign-in"],
  method: ["#by-text", "#by-app"],
  code: ["#code", "#verify"],
  question: ["#question", "#answer", "#continue"],
  account: [] as string[],
  chooser: ["#pick"],
  unrecorded: [] as string[],
  recovery: [] as string[],
} as const;
type Page = keyof typeof pages;

/** A synthetic site and what the run did on it. */
const fakeSite = (options: SiteOptions = {}) => {
  const state = {
    page: "login" as Page,
    signedIn: options.signedIn === true,
    loginError: false,
    usernameError: false,
    codeError: false,
    question: options.questions?.[0] ?? question,
    loads: 0,
    codeSpent: false,
    unrecorded: 0,
    captcha: false,
  };
  const fills: { readonly page: Page; readonly values: readonly string[] }[] = [];
  const opened: string[] = [];
  const pageOrigin = (page: Page) =>
    page === "login"
      ? (options.loginOrigin ?? origin)
      : page === "chooser"
        ? (options.chooserOrigin ?? origin)
        : page === "code"
          ? (options.codeOrigin ?? origin)
          : page === "unrecorded"
            ? (options.unrecordedOrigin ?? origin)
            : origin;
  /** The markup the page shows, parsed, whose one match of a selector is its control. */
  const markup = () => {
    const html =
      state.page === "unrecorded"
        ? options.unrecorded?.[state.unrecorded]
        : state.page === "recovery"
          ? options.recovery
          : state.page === "login" && state.captcha
            ? options.captcha
            : undefined;
    return html === undefined ? undefined : parseHtml(`<html><body>${html}</body></html>`);
  };
  const shows = (selector: string) =>
    markup()?.select(selector).length === 1 ||
    (!(state.page === "code" && state.codeSpent) &&
      (pages[state.page] as readonly string[]).includes(selector));
  const navigate = (page: Page) => {
    state.page = page;
    state.question = options.questions?.[state.loads++] ?? state.question;
  };
  /** The sign-in's last screen went through. */
  const land = () => {
    if (options.landing === "code_spent") {
      state.codeSpent = true;
      return navigate("code");
    }
    state.signedIn = options.landing !== "account_signed_out";
    navigate(options.landing === "chooser" ? "chooser" : "account");
  };
  const afterLogin = (): Page =>
    options.method
      ? "method"
      : options.code
        ? "code"
        : options.question
          ? "question"
          : options.recovery !== undefined
            ? "recovery"
            : options.unrecorded !== undefined
              ? "unrecorded"
              : "account";
  const browser: SignInReplayBrowser<Error> = {
    inspect: (step) =>
      Effect.sync((): AutofillInspection | { readonly outcome: "refused"; readonly reason: "not_found" } => {
        const selectors = [...step.fields.map((field) => field.selector), ...(step.submit === undefined ? [] : [step.submit])];
        if (selectors.length === 0 || !selectors.every(shows)) return { outcome: "refused", reason: "not_found" };
        const at = pageOrigin(state.page);
        const target = {
          ownerUrl: `${at}/${state.page}`,
          documentOrigin: at,
          actions: [`${at}/${state.page}`],
          methods: ["post"],
          editable: true,
          control: "text" as const,
          empty: !(state.page === "login" && state.loginError),
        };
        return {
          url: `${at}/${state.page}`,
          page: `${at}/${state.page}`,
          targets: { fields: step.fields.map(() => target), submit: step.submit === undefined ? null : target },
          siteOrigin: origin,
          authenticationOrigins: [],
          screen: {
            origin: at,
            fields: step.fields.map((field) => ({
              tag: "input",
              role: null,
              formMethod: "post",
              type: "text",
              name: markup()?.selectOne(field.selector)?.attr("name") ?? null,
              id: markup()?.selectOne(field.selector)?.attr("id") ?? null,
              autocomplete: markup()?.selectOne(field.selector)?.attr("autocomplete") ?? null,
              inputmode: null,
              label: "Field",
              placeholder: null,
              ariaLabel: null,
              text: null,
              slot: field.slot,
              ...(field.slot === "private_answer" ? { questionText: state.question } : {}),
            })),
            submit: null,
            buttons: [],
          },
        };
      }),
    fill: ({ step, values }) =>
      Effect.sync((): AutofillStepReport => {
        const page = state.page;
        if (page === "unrecorded" && options.unrecordedFill === "refused")
          return { outcome: "refused", reason: "not_editable" };
        fills.push({ page, values: [...values] });
        if (page === "unrecorded" && options.unrecordedFill === "unclicked")
          return {
            outcome: "filled",
            fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
            submit: "failed",
            url: `${origin}/${page}`,
          };
        if (page === "login") {
          const right = values[0] === account.username && values[1] === account.password;
          state.loginError = !right && options.marker === true;
          state.usernameError = values[0] !== account.username && options.usernameMarker === true;
          state.captcha ||= !right && options.captcha !== undefined;
          if (right && afterLogin() === "account") land();
          else if (right) navigate(afterLogin());
        } else if (page === "method") navigate("code");
        else if (page === "code") {
          state.codeError = values[0] !== code;
          if (!state.codeError) land();
        } else if (page === "unrecorded") {
          if (values[0] === code && ++state.unrecorded >= (options.unrecorded?.length ?? 0)) land();
        } else if (page === "question" && values[0] === answer) land();
        else navigate(page);
        return {
          outcome: "filled" as const,
          fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
          submit: "clicked" as const,
          url: `${origin}/${state.page}`,
        };
      }),
    confirm: (indicator) =>
      Effect.sync((): AutofillSignedInCheck => {
        if (indicator.openPath !== undefined) navigate("account");
        const at = pageOrigin(state.page);
        const url = `${at}/${state.page}`;
        if (state.signedIn && state.page === "account") return { signedIn: true, url };
        const onSite = new URL(at).hostname.endsWith(site);
        return { signedIn: false, failed: onSite ? "indicator_not_visible" : "off_site", url };
      }),
    authenticationOrigins: options.authenticationOrigins ?? [],
    open: (url) =>
      options.entryFails === true
        ? Effect.fail(new Error(`net::ERR_NAME_NOT_RESOLVED at ${url}`))
        : Effect.sync(() => {
            opened.push(url);
            state.loginError = false;
            state.usernameError = false;
            navigate(state.signedIn && options.redirectWhenSignedIn === true ? "account" : "login");
          }),
    markerVisible: (selector) =>
      Effect.sync(
        () =>
          (selector === "#login-error" && state.page === "login" && state.loginError) ||
          (selector === "#username-error" && state.page === "login" && state.usernameError) ||
          (selector === "#code-error" && state.page === "code" && state.codeError),
      ),
  };
  return { browser, state, fills, opened };
};

const loginStep = {
  page: `${origin}/login`,
  fields: [
    { selector: "#username", accepts: ["username" as const] },
    { selector: "#password", slot: "password" as const },
  ],
  submit: "#sign-in",
  submittedBy: "host" as const,
};
const recipeOf = (...later: SignInRecipe["steps"][number][]): SignInRecipe => ({
  version: 1,
  steps: [loginStep, ...later],
  signedIn: { selector: "#account" },
});
/**
 * The login screen with its recorded error marker: only a marker the site shows proves it
 * rejected the password, so only then is a corrected login asked.
 */
const markedLoginStep = {
  ...loginStep,
  rejectedMarkers: [{ slot: "password" as const, selector: "#login-error" }],
};
const markedRecipeOf = (...later: SignInRecipe["steps"][number][]): SignInRecipe => ({
  ...recipeOf(...later),
  steps: [markedLoginStep, ...later],
});

/** The owner's answers: logins in order, then codes and security answers. */
const owner = (answers: { readonly logins?: Login[]; readonly codes?: string[]; readonly answers?: string[]; readonly method?: string; readonly fail?: boolean } = {}) => {
  const asked: InputRequest[] = [];
  const logins = [...(answers.logins ?? [account])];
  const codes = [...(answers.codes ?? [code])];
  const privateAnswers = [...(answers.answers ?? [answer])];
  const ask = makeInputAsker((request) =>
    Effect.suspend(() => {
      asked.push(request);
      if (answers.fail === true) return Effect.fail(new InputRequestFailure({ code: "NoResponse" }));
      const reply = (question: Question) => {
        if (question.type === "credential") {
          const login = logins.shift() ?? account;
          return { ...login, saveLogin: false };
        }
        if (question.type === "choice") return answers.method ?? question.options[0]?.id;
        if (question.type === "confirm") return { confirmed: true };
        if (question.id === "code") return codes.shift() ?? code;
        return privateAnswers.shift() ?? answer;
      };
      return Effect.succeed(
        Object.fromEntries(request.questions.map((question) => [question.id, reply(question)])) as InputAnswers,
      );
    }),
  );
  return { ask, asked };
};

const signIn = (
  recipe: SignInRecipe,
  fake: ReturnType<typeof fakeSite>,
  ask: ReturnType<typeof owner>["ask"],
  entryUrl = `${origin}/login`,
  allowCantTell = true,
) => {
  const secrets = makeRunSecrets();
  return Effect.runPromise(
    Effect.either(
      signInForRun({
        recipe,
        entryUrl,
        browser: fake.browser,
        login: localSignInLogin({ ask, register: secrets.register, siteOrigin: origin }),
        ask,
        secrets,
        markerSettle: { within: Duration.millis(20), interval: Duration.millis(5) },
        site,
        siteOrigin: origin,
        timing: { stepWaitMs: 60, pollMs: 2 },
        ...(allowCantTell ? { allowCantTell } : {}),
      }),
    ),
  );
};
const kinds = (asked: readonly InputRequest[]) =>
  asked.map(({ questions }) =>
    questions.map((question) => (question.type === "credential" ? `credential:${question.reason}` : question.id)).join(","),
  );

it("checks without values first and asks nothing when the session is already signed in", async () => {
  const fake = fakeSite({ signedIn: true, redirectWhenSignedIn: true });
  const { ask, asked } = owner();
  expect(await signIn(recipeOf(), fake, ask)).toEqual(Either.right({ alreadySignedIn: true }));
  expect(asked).toEqual([]);
  expect(fake.fills).toEqual([]);
  expect(fake.opened).toEqual([`${origin}/login`]);
});

it("asks one login question once the check finds the sign-in screen, then replays with it", async () => {
  const fake = fakeSite();
  const { ask, asked } = owner();
  expect(await signIn(recipeOf(), fake, ask)).toEqual(Either.right({ alreadySignedIn: false }));
  expect(kinds(asked)).toEqual(["credential:missing_credentials"]);
  expect(asked[0]?.questions[0]).toMatchObject({ type: "credential", allowSave: false, siteOrigin: origin });
  expect(fake.fills).toEqual([{ page: "login", values: [account.username, account.password] }]);
  // The check and the replay each open the entry page.
  expect(fake.opened).toHaveLength(2);
});

it("corrects a rejected password without sending it again, asking again for a correction that repeats it", async () => {
  const fake = fakeSite({ marker: true });
  const wrong = { ...account, password: "synthetic-wrong" };
  const { ask, asked } = owner({ logins: [wrong, wrong, account] });
  expect(await signIn(markedRecipeOf(), fake, ask)).toEqual(Either.right({ alreadySignedIn: false }));
  expect(kinds(asked)).toEqual([
    "credential:missing_credentials",
    "credential:invalid_credentials",
    "credential:invalid_credentials",
  ]);
  // The correction names the username and the tries left, and the repeated password is never filled.
  expect(asked[1]?.questions[0]).toMatchObject({ username: account.username });
  expect(asked[1]?.questions[0]?.prompt).toContain("You have 2 tries left.");
  expect(asked[2]?.questions[0]?.prompt).toContain("This is your last try.");
  expect(fake.fills.map(({ values }) => values[1])).toEqual([wrong.password, account.password]);
});

it("fails RecipeFailed when the login screen shows again after its password with no recorded error marker", async () => {
  const fake = fakeSite();
  const wrong = { ...account, password: "synthetic-wrong" };
  const { ask, asked } = owner({ logins: [wrong, account] });
  expect(await signIn(recipeOf(), fake, ask)).toEqual(
    Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "credential_screen_returned" })),
  );
  // Nothing proves the site rejected the login, so no correction is asked.
  expect(kinds(asked)).toEqual(["credential:missing_credentials"]);
  expect(fake.fills).toHaveLength(1);
});

it("fails CredentialsRejected once both corrections of the password were rejected", async () => {
  const fake = fakeSite({ marker: true });
  const logins = ["one", "two", "three", "four"].map((suffix) => ({ ...account, password: `synthetic-${suffix}` }));
  const { ask, asked } = owner({ logins });
  const result = await signIn(
    { ...recipeOf(), steps: [{ ...loginStep, rejectedMarkers: [{ slot: "password", selector: "#login-error" }] }] },
    fake,
    ask,
  );
  expect(result).toEqual(Either.left(new SignInRunFailed({ code: "CredentialsRejected", reason: "password" })));
  expect(kinds(asked)).toEqual([
    "credential:missing_credentials",
    "credential:invalid_credentials",
    "credential:invalid_credentials",
  ]);
  expect(fake.fills.map(({ values }) => values[1])).toEqual(logins.slice(0, 3).map(({ password }) => password));
  // The failure holds no value.
  expect(JSON.stringify(Either.isLeft(result) ? result.left : null)).not.toContain("synthetic-");
});

it("asks for a correction before it types when an earlier sign-in of the run had the login rejected", async () => {
  const fake = fakeSite({ marker: true });
  const wrong = { ...account, password: "synthetic-wrong" };
  // The login, a correction left unanswered, then the right login.
  const answers: (Login | undefined)[] = [wrong, undefined, account];
  const asked: InputRequest[] = [];
  const ask = makeInputAsker((request) =>
    Effect.suspend(() => {
      asked.push(request);
      const login = answers.shift();
      return login === undefined
        ? Effect.fail(new InputRequestFailure({ code: "NoResponse" }))
        : Effect.succeed({ login: { ...login, saveLogin: false } } as InputAnswers);
    }),
  );
  const secrets = makeRunSecrets();
  const login = localSignInLogin({ ask, register: secrets.register, siteOrigin: origin });
  const retryState = makeAutofillRetryState();
  const run = () =>
    Effect.runPromise(
      Effect.either(
        signInForRun({
          recipe: markedRecipeOf(),
          entryUrl: `${origin}/login`,
          browser: fake.browser,
          login,
          ask,
          secrets,
          markerSettle: { within: Duration.millis(20), interval: Duration.millis(5) },
          site,
          siteOrigin: origin,
          timing: { stepWaitMs: 60, pollMs: 2 },
          retryState,
        }),
      ),
    );
  expect(await run()).toEqual(Either.left(new SignInRunFailed({ code: "NeedsInput", reason: "login" })));
  expect(await run()).toEqual(Either.right({ alreadySignedIn: false }));
  expect(kinds(asked)).toEqual([
    "credential:missing_credentials",
    "credential:invalid_credentials",
    "credential:invalid_credentials",
  ]);
  // The second sign-in spends the last correction before it types, so the rejected password goes
  // out once.
  expect(asked[2]?.questions[0]?.prompt).toContain("This is your last try.");
  expect(fake.fills.map(({ values }) => values[1])).toEqual([wrong.password, account.password]);
});

it("asks for the code a code screen needs, and a fresh one for a rejected code, never the rejected one", async () => {
  const fake = fakeSite({ code: true });
  const { ask, asked } = owner({ codes: ["111111", "111111", code] });
  const codeStep = { page: `${origin}/code`, fields: [{ selector: "#code", slot: "code" as const }], submit: "#verify", rejectedMarkers: [{ slot: "code" as const, selector: "#code-error" }] };
  expect(await signIn(recipeOf(codeStep), fake, ask)).toEqual(Either.right({ alreadySignedIn: false }));
  expect(kinds(asked)).toEqual(["credential:missing_credentials", "code", "code", "code"]);
  expect(asked[2]?.questions[0]?.prompt).toBe(
    `The site refused the last code. Enter the newest sign-in code ${site} sent you.`,
  );
  expect(fake.fills.filter(({ page }) => page === "code").map(({ values }) => values[0])).toEqual(["111111", code]);
});

it("asks a recipe's method choice and clicks the recorded control of the method picked", async () => {
  const fake = fakeSite({ method: true, code: true });
  const { ask, asked } = owner({ method: "option_1" });
  const methodStep = {
    page: `${origin}/method`,
    fields: [],
    submit: "#by-text",
    methods: [
      { method: "sms" as const, selector: "#by-text" },
      { method: "totp" as const, selector: "#by-app" },
    ],
  };
  const codeStep = { page: `${origin}/code`, fields: [{ selector: "#code", slot: "code" as const }], submit: "#verify" };
  expect(await signIn(recipeOf(methodStep, codeStep), fake, ask)).toEqual(Either.right({ alreadySignedIn: false }));
  expect(kinds(asked)).toEqual(["credential:missing_credentials", "method", "code"]);
  expect(asked[1]?.questions[0]).toMatchObject({
    type: "choice",
    prompt: `How should ${site} confirm it's you?`,
    options: [
      { id: "option_0", label: "Text message" },
      { id: "option_1", label: "Authenticator app" },
    ],
  });
});

/** A code screen, on the site's own origin unless `at` says otherwise. */
const codeScreenAt = (at = origin) => ({
  page: `${at}/code`,
  fields: [{ selector: "#code", slot: "code" as const }],
  submit: "#verify",
});

it("signs in when the code lands on a chooser the site shows before any page with the marker", async () => {
  const fake = fakeSite({ code: true, landing: "chooser" });
  const { ask, asked } = owner();
  expect(await signIn(recipeOf(codeScreenAt()), fake, ask)).toEqual(
    Either.right({ alreadySignedIn: false }),
  );
  expect(kinds(asked)).toEqual(["credential:missing_credentials", "code"]);
  // The sign-in types nothing on the chooser: the operation makes the pick.
  expect(fake.fills.map(({ page }) => page)).toEqual(["login", "code"]);
  expect(fake.state.page).toBe("chooser");
});

it("fails the sign-in check on a chooser unless the sign-in allows a page that can't tell, as only a read's does", async () => {
  const fake = fakeSite({ code: true, landing: "chooser" });
  expect(
    await signIn(recipeOf(codeScreenAt()), fake, owner().ask, `${origin}/login`, false),
  ).toEqual(Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "sign_in_check_failed" })));
  expect(fake.state.page).toBe("chooser");
});

it("asks for a corrected password when the login screen shows its error, then signs in on the chooser", async () => {
  const fake = fakeSite({ code: true, landing: "chooser", marker: true });
  const wrong = { ...account, password: "synthetic-wrong" };
  const { ask, asked } = owner({ logins: [wrong, account] });
  expect(await signIn(markedRecipeOf(codeScreenAt()), fake, ask)).toEqual(
    Either.right({ alreadySignedIn: false }),
  );
  expect(kinds(asked)).toEqual([
    "credential:missing_credentials",
    "credential:invalid_credentials",
    "code",
  ]);
  expect(fake.fills.map(({ page }) => page)).toEqual(["login", "login", "code"]);
});

it("reads a marker that names a path as signed out on that path only", async () => {
  const recipe: SignInRecipe = {
    ...recipeOf(codeScreenAt()),
    signedIn: { selector: "#account", urlPath: "/account" },
  };
  // Off its path, a chooser can't tell, and the sign-in goes on.
  expect(await signIn(recipe, fakeSite({ code: true, landing: "chooser" }), owner().ask)).toEqual(
    Either.right({ alreadySignedIn: false }),
  );
  // On its path, a missing marker is a sign-in that did not work.
  expect(
    await signIn(recipe, fakeSite({ code: true, landing: "account_signed_out" }), owner().ask),
  ).toEqual(Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "sign_in_check_failed" })));
});

it("signs in on a chooser off the site, and fails where a recorded sign-in screen off the site shows again", async () => {
  expect(
    await signIn(
      recipeOf(codeScreenAt()),
      fakeSite({ code: true, landing: "chooser", chooserOrigin: "https://pick.example.org" }),
      owner().ask,
    ),
  ).toEqual(Either.right({ alreadySignedIn: false }));
  // The code screen sits on a sign-in origin off the site, and comes back without its field.
  const identity = "https://id.example.org";
  expect(
    await signIn(
      recipeOf(codeScreenAt(identity)),
      fakeSite({ code: true, codeOrigin: identity, landing: "code_spent" }),
      owner().ask,
    ),
  ).toEqual(Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "sign_in_check_failed" })));
});

const questionStep = {
  page: `${origin}/question`,
  fields: [{ selector: "#answer", slot: "private_answer" as const, questionSelector: "#question" }],
  submit: "#continue",
  submittedBy: "host" as const,
};

// Version 1 is how every host writes a question selector now; version 3 is how this host wrote it before.
it.each([1, 3] as const)("asks a security answer on every run, from the question the screen shows then (version %i)", async (version) => {
  const recipe: SignInRecipe = { ...recipeOf(), version, steps: [loginStep, questionStep] };
  const prompts: string[] = [];
  for (const shown of ["What was the name of your first pet?", "Which city were you born in?"]) {
    const fake = fakeSite({ question: true, questions: [question, shown] });
    const { ask, asked } = owner();
    expect(await signIn(recipe, fake, ask)).toEqual(Either.right({ alreadySignedIn: false }));
    expect(kinds(asked)).toEqual(["credential:missing_credentials", "private_answer"]);
    prompts.push(asked[1]?.questions[0]?.prompt ?? "");
    expect(fake.fills.at(-1)).toEqual({ page: "question", values: [answer] });
  }
  expect(prompts).toEqual([
    `${site} asks this security question: What was the name of your first pet?`,
    `${site} asks this security question: Which city were you born in?`,
  ]);
});

it("fails the sign-in check when the security question shows again after its answer", async () => {
  const fake = fakeSite({ question: true });
  const { ask } = owner({ answers: ["synthetic-wrong-pet"] });
  const recipe: SignInRecipe = { ...recipeOf(), version: 3, steps: [loginStep, questionStep] };
  expect(await signIn(recipe, fake, ask)).toEqual(
    Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "sign_in_check_failed" })),
  );
  expect(fake.fills.filter(({ page }) => page === "question")).toHaveLength(1);
});

it("fails RecipeFailed when a recorded screen shows on another origin than the recipe's", async () => {
  const fake = fakeSite({ loginOrigin: "https://login.example.test" });
  const { ask, asked } = owner();
  expect(await signIn(recipeOf(), fake, ask)).toEqual(
    Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "screen_origin_changed" })),
  );
  expect(fake.fills).toEqual([]);
  expect(kinds(asked)).toEqual(["credential:missing_credentials"]);
});

it.each([
  ["an unknown version", { ...recipeOf(), version: 9 }, "unknown_version"],
  ["a recipe without steps", { ...recipeOf(), steps: [] }, "invalid"],
])("refuses %s with MissingRecipe before opening anything", async (_case, recipe, reason) => {
  const fake = fakeSite();
  const { ask, asked } = owner();
  expect(await signIn(recipe as SignInRecipe, fake, ask)).toEqual(
    Either.left(new SignInRunFailed({ code: "MissingRecipe", reason })),
  );
  expect(fake.opened).toEqual([]);
  expect(asked).toEqual([]);
});

it("refuses an entry page off the site before opening anything", async () => {
  const fake = fakeSite();
  const { ask } = owner();
  expect(await signIn(recipeOf(), fake, ask, "https://elsewhere.test/login")).toEqual(
    Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "entry_off_site" })),
  );
  expect(fake.opened).toEqual([]);
});

it("fails NeedsInput when the owner leaves the login question unanswered", async () => {
  const fake = fakeSite();
  const { ask } = owner({ fail: true });
  expect(await signIn(recipeOf(), fake, ask)).toEqual(
    Either.left(new SignInRunFailed({ code: "NeedsInput", reason: "login" })),
  );
  expect(fake.fills).toEqual([]);
});

it("says what each failure means without naming a value", () => {
  expect(new SignInRunFailed({ code: "CredentialsRejected", reason: "date_of_birth" }).message).toBe(
    "The website rejected the date of birth given for this sign-in, and the run sends it no more. Run the tool again with the right value.",
  );
  expect(new SignInRunFailed({ code: "RecipeFailed", reason: "screen_origin_changed" }).message).toBe(
    "The saved sign-in no longer matches the website (screen origin changed). Build the tool again to record its sign-in.",
  );
  expect(new SignInRunFailed({ code: "MissingRecipe", reason: "unknown_version" }).message).toBe(
    "The tool's saved sign-in can't be read (unknown version), so the tool doesn't run signed out. Build the tool again.",
  );
  // A changed security question or a page that didn't load is no fault of the recipe.
  expect(new SignInRunFailed({ code: "NeedsInput", reason: "question_changed" }).message).not.toContain(
    "Build the tool again",
  );
  expect(new SignInRunFailed({ code: "RecipeFailed", reason: "entry_page_unavailable" }).message).not.toContain(
    "Build the tool again",
  );
});

it("fills a recorded step's identifier with the kind the login holds", async () => {
  const fake = fakeSite();
  const { ask } = owner();
  const accepts: AutofillStep["fields"][number]["accepts"] = ["email", "username"];
  const recipe = { ...recipeOf(), steps: [{ ...loginStep, fields: [{ selector: "#username", accepts }, loginStep.fields[1]] }] } as SignInRecipe;
  expect(await signIn(recipe, fake, ask)).toEqual(Either.right({ alreadySignedIn: false }));
  expect(fake.fills).toEqual([{ page: "login", values: [account.username, account.password] }]);
});

const codeScreen = {
  page: `${origin}/code`,
  fields: [{ selector: "#code", slot: "code" as const }],
  submit: "#verify",
};
/** What each fill of the login screen sent, in order. */
const loginFills = (fake: ReturnType<typeof fakeSite>) =>
  fake.fills.filter(({ page }) => page === "login").map(({ values }) => values);

it("never fills a password the login screen rejected before a later screen, even when a correction repeats it", async () => {
  const fake = fakeSite({ code: true, marker: true });
  const wrong = { ...account, password: "synthetic-wrong" };
  const { ask, asked } = owner({ logins: [wrong, wrong, account] });
  expect(await signIn(markedRecipeOf(codeScreen), fake, ask)).toEqual(Either.right({ alreadySignedIn: false }));
  // The code screen never showed: the login screen came back with its error, so the password it
  // took was rejected, and the correction that repeated it was asked again instead of filled.
  expect(kinds(asked)).toEqual([
    "credential:missing_credentials",
    "credential:invalid_credentials",
    "credential:invalid_credentials",
    "code",
  ]);
  expect(loginFills(fake).map((values) => values[1])).toEqual([wrong.password, account.password]);
});

it("never fills a username its recorded marker rejected, even when a correction repeats it", async () => {
  const fake = fakeSite({ usernameMarker: true });
  const wrong = { username: "synthetic-wrong-user", password: account.password };
  const { ask, asked } = owner({ logins: [wrong, wrong, account] });
  const recipe: SignInRecipe = {
    ...recipeOf(),
    steps: [{ ...loginStep, rejectedMarkers: [{ slot: "username", selector: "#username-error" }] }],
  };
  expect(await signIn(recipe, fake, ask)).toEqual(Either.right({ alreadySignedIn: false }));
  expect(kinds(asked)).toEqual([
    "credential:missing_credentials",
    "credential:invalid_credentials",
    "credential:invalid_credentials",
  ]);
  expect(loginFills(fake).map((values) => values[0])).toEqual([wrong.username, account.username]);
});

it("fails RecipeFailed, value-free, when the entry page does not load", async () => {
  const fake = fakeSite({ entryFails: true });
  const { ask, asked } = owner();
  const result = await signIn(recipeOf(), fake, ask);
  expect(result).toEqual(
    Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "entry_page_unavailable" })),
  );
  expect(Either.isLeft(result) && result.left.message).toBe(
    "The sign-in page didn't load, so the run stopped before the tool ran. Check that the website is reachable, then run the tool again.",
  );
  expect(asked).toEqual([]);
  expect(fake.fills).toEqual([]);
});

// A site may ask for a code the recipe never saw, after the password. Once its screens ran and no
// code went out, the replay looks once for a one-time-code field and answers it as a recorded code
// screen, with the same code question.

/** A code screen's form: one field with these attributes and its submit. */
const codeForm = (attributes: string) =>
  `<form><input ${attributes}><button type="submit">Verify</button></form>`;
const checkFailed = Either.left(
  new SignInRunFailed({ code: "RecipeFailed", reason: "sign_in_check_failed" }),
);

it("answers a code screen the recipe never recorded with the code question, then signs in", async () => {
  const fake = fakeSite({ unrecorded: [codeForm('name="otp" inputmode="numeric" maxlength="6"')] });
  const { ask, asked } = owner();
  expect(await signIn(recipeOf(), fake, ask)).toEqual(Either.right({ alreadySignedIn: false }));
  expect(kinds(asked)).toEqual(["credential:missing_credentials", "code"]);
  expect(fake.fills).toEqual([
    { page: "login", values: [account.username, account.password] },
    { page: "unrecorded", values: [code] },
  ]);
});

it("takes a promo code field for no sign-in code field", async () => {
  const promo = '<form><input name="promo_code"><button type="submit">Apply</button></form>';
  const fake = fakeSite({
    unrecorded: [promo + codeForm('id="verification-code" inputmode="numeric" maxlength="6"')],
  });
  const { ask, asked } = owner();
  expect(await signIn(recipeOf(), fake, ask)).toEqual(Either.right({ alreadySignedIn: false }));
  expect(kinds(asked)).toEqual(["credential:missing_credentials", "code"]);
  expect(fake.fills.map(({ page }) => page)).toEqual(["login", "unrecorded"]);
});

it("looks for an unrecorded code field only on a recorded screen's origin", async () => {
  const screen = codeForm('autocomplete="one-time-code"');
  // Another origin of the site, where no recorded screen ran.
  const elsewhere = fakeSite({ unrecorded: [screen], unrecordedOrigin: `https://accounts.${site}` });
  const first = owner();
  expect(await signIn(recipeOf(), elsewhere, first.ask, undefined, false)).toEqual(checkFailed);
  expect(kinds(first.asked)).toEqual(["credential:missing_credentials"]);
  expect(elsewhere.fills.map(({ page }) => page)).toEqual(["login"]);
  // A sign-in origin the run configured, where no recorded screen ran: the page can't tell.
  const provider = "https://id.example-sign-in.test";
  const configured = fakeSite({
    unrecorded: [screen],
    unrecordedOrigin: provider,
    authenticationOrigins: [provider],
  });
  const second = owner();
  expect(await signIn(recipeOf(), configured, second.ask)).toEqual(
    Either.right({ alreadySignedIn: false }),
  );
  expect(kinds(second.asked)).toEqual(["credential:missing_credentials"]);
  expect(configured.fills.map(({ page }) => page)).toEqual(["login"]);
});

it("looks for an unrecorded code field once, and fills no second code screen", async () => {
  const fake = fakeSite({ unrecorded: [codeForm('name="otp"'), codeForm('name="mfa_token"')] });
  const { ask, asked } = owner();
  expect(await signIn(recipeOf(), fake, ask, undefined, false)).toEqual(checkFailed);
  expect(kinds(asked)).toEqual(["credential:missing_credentials", "code"]);
  expect(fake.fills.map(({ page }) => page)).toEqual(["login", "unrecorded"]);
});

it("answers a field marked one-time-code whatever its name, such as email_otp", async () => {
  const fake = fakeSite({ unrecorded: [codeForm('name="email_otp" autocomplete="one-time-code"')] });
  const { ask, asked } = owner();
  expect(await signIn(recipeOf(), fake, ask)).toEqual(Either.right({ alreadySignedIn: false }));
  expect(kinds(asked)).toEqual(["credential:missing_credentials", "code"]);
  expect(fake.fills).toEqual([
    { page: "login", values: [account.username, account.password] },
    { page: "unrecorded", values: [code] },
  ]);
});

for (const [kind, attributes] of [
  ["a voucher box", 'name="voucher_code" inputmode="numeric" maxlength="6"'],
  ["a card's security code named cardCode", 'name="cardCode" inputmode="numeric" maxlength="4"'],
  ["a box autocompleted cc-csc", 'id="code" autocomplete="cc-csc" inputmode="numeric" maxlength="4"'],
  ["a box autocompleted cc-exp", 'id="code" autocomplete="cc-exp" inputmode="numeric" maxlength="4"'],
  ["a PIN box named pinCode", 'name="pinCode" inputmode="numeric" maxlength="6"'],
  ["a PIN box named pin_code", 'name="pin_code" inputmode="numeric" maxlength="6"'],
  ["a postal PIN box named pincode", 'name="pincode" inputmode="numeric" maxlength="6"'],
  ["a postal PIN box named PINCode", 'name="PINCode" inputmode="numeric" maxlength="6"'],
  ["a text box named code with no short numeric shape", 'name="code" type="text"'],
  ["a code box autocompleted tel-national", 'name="code" autocomplete="tel-national" inputmode="numeric" maxlength="6"'],
  ["a CAPTCHA box named captcha_code", 'name="captcha_code" inputmode="numeric" maxlength="6"'],
  ["a nine-digit box named code", 'name="code" inputmode="numeric" maxlength="9"'],
  ["a numeric code box autocompleted postal-code", 'name="code" autocomplete="postal-code" inputmode="numeric" maxlength="6"'],
  ["a password box named otp", 'type="password" name="otp"'],
] as const)
  it(`types no code into ${kind} on the page a read's sign-in lands on that can't tell`, async () => {
    const fake = fakeSite({ unrecorded: [codeForm(attributes)] });
    const { ask, asked } = owner();
    expect(await signIn(recipeOf(), fake, ask)).toEqual(Either.right({ alreadySignedIn: false }));
    expect(kinds(asked)).toEqual(["credential:missing_credentials"]);
    expect(fake.fills.map(({ page }) => page)).toEqual(["login"]);
  });

it("types no code into a CAPTCHA's numeric box on a login screen shown again after a wrong password", async () => {
  const captcha = codeForm('name="verificationCode" inputmode="numeric" maxlength="4"');
  const fake = fakeSite({ captcha, marker: true });
  const wrong = { ...account, password: "synthetic-wrong" };
  const { ask, asked } = owner({ logins: [wrong, account] });
  expect(await signIn(markedRecipeOf(), fake, ask)).toEqual(Either.right({ alreadySignedIn: false }));
  expect(kinds(asked)).toEqual([
    "credential:missing_credentials",
    "credential:invalid_credentials",
  ]);
  // The wrong password went out once, and nothing went into the CAPTCHA's box.
  expect(fake.fills).toEqual([
    { page: "login", values: [account.username, wrong.password] },
    { page: "login", values: [account.username, account.password] },
  ]);
});

it("types no code into a recorded recovery code screen shown again after its code", async () => {
  const fake = fakeSite({
    recovery:
      '<form><input id="recovery" name="recovery_code" inputmode="numeric" maxlength="8"><button type="submit" id="verify-recovery">Verify</button></form>',
  });
  const recoveryStep = {
    page: `${origin}/recovery`,
    fields: [{ selector: "#recovery", slot: "recovery_code" as const }],
    submit: "#verify-recovery",
  };
  const { ask, asked } = owner();
  expect(await signIn(recipeOf(recoveryStep), fake, ask, undefined, false)).toEqual(checkFailed);
  expect(kinds(asked)).toEqual(["credential:missing_credentials", "recovery_code"]);
  expect(fake.fills.map(({ page }) => page)).toEqual(["login", "recovery"]);
});

it("leaves the sign-in to the full check when an unrecorded code screen's fill typed nothing", async () => {
  const fake = fakeSite({ unrecorded: [codeForm('name="otp"')], unrecordedFill: "refused" });
  const { ask, asked } = owner();
  expect(await signIn(recipeOf(), fake, ask)).toEqual(Either.right({ alreadySignedIn: false }));
  expect(kinds(asked)).toEqual(["credential:missing_credentials", "code"]);
  expect(fake.fills.map(({ page }) => page)).toEqual(["login"]);
});

it("fails the sign-in when an unrecorded code screen's code was typed and never submitted", async () => {
  const fake = fakeSite({ unrecorded: [codeForm('name="otp"')], unrecordedFill: "unclicked" });
  const { ask } = owner();
  expect(await signIn(recipeOf(), fake, ask)).toEqual(
    Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "submit_failed" })),
  );
  expect(fake.fills.map(({ page }) => page)).toEqual(["login", "unrecorded"]);
});

it("answers an unmarked box named otpInput, whose letters p, i, n make no word of their own", async () => {
  const fake = fakeSite({
    unrecorded: [codeForm('name="otpInput" inputmode="numeric" maxlength="6"')],
  });
  const { ask, asked } = owner();
  expect(await signIn(recipeOf(), fake, ask)).toEqual(Either.right({ alreadySignedIn: false }));
  expect(kinds(asked)).toEqual(["credential:missing_credentials", "code"]);
  expect(fake.fills).toEqual([
    { page: "login", values: [account.username, account.password] },
    { page: "unrecorded", values: [code] },
  ]);
});

it("answers only the marked one-time-code field on a page that has one, never an unmarked otp box", async () => {
  const fake = fakeSite({
    unrecorded: [
      '<form><input name="sms_otp" autocomplete="one-time-code"><input name="otp"><button type="submit">Verify</button></form>',
    ],
  });
  const { ask, asked } = owner();
  expect(await signIn(recipeOf(), fake, ask)).toEqual(Either.right({ alreadySignedIn: false }));
  expect(kinds(asked)).toEqual(["credential:missing_credentials", "code"]);
  expect(fake.fills).toEqual([
    { page: "login", values: [account.username, account.password] },
    { page: "unrecorded", values: [code] },
  ]);
});

for (const [where, accountOrigin] of [
  ["its own origin", origin],
  ["another origin of the site", `https://accounts.${site}`],
] as const)
  it(`types no code into an account page on ${where}, a configured sign-in origin no recorded screen ran on`, async () => {
    // The recorded screens ran on an identity provider, and the run's sign-in origins also hold the
    // site's, as a host's list may.
    const provider = "https://id.example-sign-in.test";
    const fake = fakeSite({
      loginOrigin: provider,
      unrecorded: [codeForm('name="code" inputmode="numeric" maxlength="6"')],
      unrecordedOrigin: accountOrigin,
      authenticationOrigins: [provider, accountOrigin],
    });
    const recipe = { ...recipeOf(), steps: [{ ...loginStep, page: `${provider}/login` }] };
    const { ask, asked } = owner();
    expect(await signIn(recipe, fake, ask, `${provider}/login`)).toEqual(
      Either.right({ alreadySignedIn: false }),
    );
    expect(kinds(asked)).toEqual(["credential:missing_credentials"]);
    expect(fake.fills.map(({ page }) => page)).toEqual(["login"]);
  });
