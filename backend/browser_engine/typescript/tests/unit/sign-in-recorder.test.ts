import { Duration, Effect, Exit } from "effect";
import { expect, it } from "vitest";
import type {
  AutofillInspection,
  AutofillPage,
  AutofillSignedInCheck,
  AutofillStep,
  AutofillStepReport,
} from "../../src/destinations/autofill-step.js";
import type { SignedOutSnapshot } from "../../src/destinations/signed-in-marker.js";
import { MintFailure, type SignInStep } from "../../src/mint/contracts.js";
import { makeSignInRecorder } from "../../src/mint/sign-in-recorder.js";
import type { WebsiteCredentials } from "../../src/runtime/authentication.js";
import type { InputAsker, InputRequest } from "../../src/runtime/input-request.js";
import { makeSignInBrowser } from "../../src/standalone/authentication.js";

const site = "example.test";
const origin = "https://www.example.test";
const account = { username: "ada-owner", password: "synthetic-password" } as const;

const target = {
  ownerUrl: `${origin}/login`,
  documentOrigin: origin,
  actions: [`${origin}/session`],
  methods: ["post"],
  submitMethod: "post",
  editable: true,
  control: "text",
} as const;
const described = {
  tag: "input",
  role: null,
  formMethod: "post",
  type: "text",
  name: null,
  id: null,
  autocomplete: null,
  inputmode: null,
  label: "Field",
  placeholder: null,
  ariaLabel: null,
  text: null,
};

interface Options {
  /** The login the build already holds. */
  readonly held?: WebsiteCredentials;
  /** The logins the owner gives as corrections, in order. */
  readonly corrections?: readonly WebsiteCredentials[];
  /** What each fill reports; every field filled and the submit clicked by default. */
  readonly report?: (step: AutofillStep) => AutofillStepReport;
  /** The live address the host finds a screen at. */
  readonly liveUrl?: string;
  /** The page the host finds a screen on, origin and path. */
  readonly page?: string;
  /** Whether the page still shows a recorded challenge of the current sign-in. */
  readonly challengeAsks?: boolean;
  /** The questions each inspected private-answer field shows, in order. */
  readonly questions?: string[];
  /** The owner's answers to each question by id, in order. */
  readonly answers?: Record<string, string[]>;
  readonly approve?: boolean;
  /** The selectors that show on the page now, which a rejection's marker names. */
  readonly visible?: readonly string[];
  /** A selector the page shows once the first fill clicked its submit, as a site's message does. */
  readonly toast?: string;
  /** The pages the build saw signed out. */
  readonly signedOutPages?: readonly SignedOutSnapshot[];
  /** How many checks the page answers before it draws the marker. */
  readonly lateMarker?: number;
  /** The one-character code boxes the screen shows, by the code fields' order. */
  readonly codeBoxes?: number;
}

/** A recorder over a synthetic site, with what it asked, filled, reviewed and checked. */
const harness = (options: Options = {}) => {
  let current = options.held;
  const corrections = [...(options.corrections ?? [])];
  const asked: InputRequest[] = [];
  const logins: string[] = [];
  const filled: { readonly step: AutofillStep; readonly values: readonly string[] }[] = [];
  /** The very value lists each fill was given, as the recorder holds them after. */
  const given: (readonly string[])[] = [];
  const reviewed: AutofillStep[] = [];
  const confirmed: unknown[] = [];
  const questions = [...(options.questions ?? [])];
  const answers = Object.fromEntries(
    Object.entries(options.answers ?? {}).map(([id, values]) => [id, [...values]]),
  );
  let hidden = options.lateMarker ?? 0;
  /** The selectors the page shows now; a test takes one away as the site's message goes. */
  const shown = new Set(options.visible ?? []);
  const inspect = (step: AutofillStep) =>
    Effect.sync((): AutofillInspection => {
      let box = 0;
      return {
        url: options.liveUrl ?? `${origin}/login`,
        page: options.page ?? `${origin}/login`,
        targets: { fields: step.fields.map(() => target), submit: target },
        siteOrigin: origin,
        authenticationOrigins: [],
        screen: {
          origin,
          fields: step.fields.map((field) => ({
            ...described,
            slot: field.slot,
            ...(field.slot === "private_answer" && questions.length > 0
              ? { questionText: questions.shift() ?? "" }
              : {}),
            ...(field.slot === "code" && options.codeBoxes !== undefined
              ? { codeBox: { box: (box += 1), of: options.codeBoxes } }
              : {}),
          })),
          submit: described,
          buttons: [],
        },
      };
    });
  const browser = {
    inspect,
    fill: ({ step, values }: { readonly step: AutofillStep; readonly values: readonly string[] }) =>
      Effect.sync(() => {
        filled.push({ step, values: [...values] });
        given.push(values);
        if (options.toast !== undefined && filled.length === 1) shown.add(options.toast);
        return (
          options.report?.(step) ?? {
            outcome: "filled" as const,
            fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
            submit: "clicked" as const,
            url: `${origin}/next`,
          }
        );
      }),
    confirm: (
      indicator: unknown,
      screens: readonly unknown[],
      challengeScreens: readonly unknown[],
    ) =>
      Effect.sync((): AutofillSignedInCheck => {
        confirmed.push({ indicator, screens, challengeScreens });
        if (hidden > 0) {
          hidden -= 1;
          return { signedIn: false, failed: "indicator_not_visible", url: `${origin}/account` };
        }
        return options.challengeAsks === true && challengeScreens.length > 0
          ? { signedIn: false, failed: "challenge_form_visible", url: `${origin}/account` }
          : { signedIn: true, url: `${origin}/account` };
      }),
    authenticationOrigins: [],
    open: () => Effect.void,
    markerVisible: (selector: string) => Effect.succeed(shown.has(selector)),
  };
  const ask: InputAsker = (request) =>
    Effect.sync(() => {
      asked.push(request);
      return Object.fromEntries(
        request.questions.map((question) => [
          question.id,
          question.type === "confirm"
            ? { type: "confirm" as const, value: { confirmed: options.approve ?? true } }
            : {
                type: question.type === "text" ? ("text" as const) : ("secret" as const),
                value: answers[question.id]?.shift() ?? "",
              },
        ]),
      );
    });
  const recorder = makeSignInRecorder({
    browser,
    login: {
      held: () => current,
      values: Effect.sync(() => {
        logins.push("missing_credentials");
        current = account;
        return account;
      }),
      correct: (field, held, triesLeft) =>
        Effect.sync(() => {
          logins.push(`invalid_credentials:${field}:${triesLeft}`);
          current = corrections.shift() ?? held;
          return current;
        }),
    },
    ask,
    secrets: { register: () => {}, assertAbsent: () => Effect.void },
    review: (step) =>
      Effect.sync(() => {
        reviewed.push(step);
      }),
    site,
    signedOutPages: () => options.signedOutPages ?? [],
    markerSettle: { within: Duration.millis(200), interval: Duration.millis(10) },
  });
  /** Runs `use` with the recorder. */
  const run = <A, E>(use: (made: typeof recorder) => Effect.Effect<A, E>) =>
    Effect.runPromise(use(recorder));
  return { run, asked, logins, filled, given, reviewed, confirmed, shown };
};

const identifierAndPassword: SignInStep = {
  fields: [
    { selector: "#user", accepts: ["username"] },
    { selector: "#password", slot: "password" },
  ],
  submit: "#sign-in",
};
const identifierOnly: SignInStep = {
  fields: [{ selector: "#user", accepts: ["username"] }],
  submit: "#next",
};
const passwordOnly: SignInStep = {
  fields: [{ selector: "#password", slot: "password" }],
  submit: "#sign-in",
};
/** The login screen with the site's error for a wrong password recorded. */
const markedLogin: SignInStep = {
  ...identifierAndPassword,
  rejectedMarkers: [{ slot: "password", selector: "#wrong-password" }],
};
const signedIn: SignInStep = { signedIn: { selector: "#account-menu" } };
const rejectedPassword: SignInStep = { rejected: { slot: "password" } };

/** A page the build saw signed out, which shows `body`. */
const signedOutPage = (body: string): SignedOutSnapshot => ({
  url: `${origin}/`,
  dom: `<!doctype html><html><body>${body}</body></html>`,
});

it("records a value-free recipe once a clicked submit sent the login, entered from the login URL", async () => {
  const host = harness();
  const published = await host.run((recorder) =>
    Effect.gen(function* () {
      const screen = yield* recorder.step(
        identifierAndPassword,
        `${origin}/login?next=%2Faccount#top`,
        Effect.void,
      );
      expect(screen.report).toMatchObject({ outcome: "filled", submit: "clicked" });
      expect(screen.result["nextStep"]).toContain("clicked the submit");
      const checked = yield* recorder.step(signedIn, undefined, Effect.void);
      expect(checked).toMatchObject({ verified: true, result: { signedIn: true } });
      return recorder.published();
    }),
  );
  expect(published).toEqual({
    recipe: {
      version: 1,
      steps: [
        {
          page: `${origin}/login`,
          fields: [
            { selector: "#user", accepts: ["username"] },
            { selector: "#password", slot: "password" },
          ],
          submit: "#sign-in",
          submittedBy: "host",
        },
      ],
      signedIn: { selector: "#account-menu" },
    },
    entryUrl: `${origin}/login?next=%2Faccount`,
  });
  expect(JSON.stringify(published)).not.toContain(account.username);
  expect(JSON.stringify(published)).not.toContain(account.password);
  // One login question for the build, asked once the screen was reviewed.
  expect(host.logins).toEqual(["missing_credentials"]);
  expect(host.reviewed).toHaveLength(1);
});

it("enters from the first screen's live address, without its fragment, when no login URL was given", async () => {
  const host = harness({ liveUrl: `${origin}/login?flow=web#state` });
  const published = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      yield* recorder.step(signedIn, undefined, Effect.void);
      return recorder.published();
    }),
  );
  expect(published?.entryUrl).toBe(`${origin}/login?flow=web`);
});

it("enters from a login URL without the credentials or fragment it held", async () => {
  const host = harness();
  const published = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(
        identifierAndPassword,
        "https://visitor:synthetic-secret@www.example.test/login?next=%2F#top",
        Effect.void,
      );
      yield* recorder.step(signedIn, undefined, Effect.void);
      return recorder.published();
    }),
  );
  expect(published?.entryUrl).toBe(`${origin}/login?next=%2F`);
});

it("refuses a screen whose address names the account before anything is asked or typed", async () => {
  const host = harness({ held: account, page: `${origin}/accounts/${account.username}/sign-in` });
  const result = await host.run((recorder) =>
    Effect.gen(function* () {
      const refused = yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      expect(recorder.published()).toBeUndefined();
      return refused;
    }),
  );
  expect(result.result).toMatchObject({
    step: { outcome: "refused", reason: "page_names_contact" },
  });
  expect(host.filled).toEqual([]);
  expect(host.asked).toEqual([]);
});

it("keeps a sign-in open through a marker check while its recorded challenge still asks", async () => {
  const host = harness({ held: account, challengeAsks: true });
  const result = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      // A marker check reads the screens, as `check_signed_in_marker` does, and ends nothing.
      expect(recorder.screens().challengeScreens).toHaveLength(1);
      expect(recorder.screens().challengeScreens).toHaveLength(1);
      const checked = yield* recorder.step(signedIn, undefined, Effect.void);
      expect(recorder.published()).toBeUndefined();
      return checked;
    }),
  );
  expect(result.verified).toBeUndefined();
  expect(result.result).toMatchObject({ signedIn: false, failed: "challenge_form_visible" });
});

it("refuses a signed-in check before a screen sent the login's password or code, in the shared words", async () => {
  const host = harness();
  const checked = await host.run((recorder) =>
    Effect.gen(function* () {
      // The identifier went out, but no password or code yet.
      yield* recorder.step(identifierOnly, undefined, Effect.void);
      const result = yield* recorder.step(signedIn, undefined, Effect.void);
      expect(recorder.published()).toBeUndefined();
      return result;
    }),
  );
  expect(checked.verified).toBeUndefined();
  expect(checked.result).toEqual({
    signedIn: false,
    failed: "credentials_not_submitted",
    nextStep:
      "No screen on this browser was submitted after the host filled the login's identifier with a password, code, or protected approval, so the host cannot take this page as signed in yet. Send each sign-in screen's signInStep (its fields and submit) first, then signedIn, then inspect read-only and correct the sign-in steps from the page's evidence.",
  });
  expect(host.confirmed).toEqual([]);
});

it("counts a screen as sent once the host clicked its submit, whatever the page's requests carried", async () => {
  const host = harness();
  const checked = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierOnly, undefined, Effect.void);
      yield* recorder.step(passwordOnly, undefined, Effect.void);
      return yield* recorder.step(signedIn, undefined, Effect.void);
    }),
  );
  expect(checked).toMatchObject({ verified: true, result: { signedIn: true } });
  expect(host.confirmed).toHaveLength(1);
});

it("counts a screen as sent once the minter goes on after the host's click failed", async () => {
  const host = harness({
    report: (step) => ({
      outcome: "filled",
      fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
      submit: "failed",
      url: `${origin}/login`,
    }),
  });
  const published = await host.run((recorder) =>
    Effect.gen(function* () {
      const screen = yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      expect(screen.result["nextStep"]).toContain("its click of the submit failed");
      // The minter clicked that one submit itself, then checks.
      expect((yield* recorder.step(signedIn, undefined, Effect.void)).verified).toBe(true);
      return recorder.published();
    }),
  );
  expect(published?.recipe.steps[0]).toMatchObject({ submittedBy: "minter" });
});

// A refused step shows the minter went on from the screen before, as a method chooser shows
// only once the login screen was sent, so that screen's password counts as sent before the
// refusal. A corrected login then never fills the same password a third time.
it.each<[string, SignInStep]>([
  [
    "masked method",
    {
      fields: [],
      submit: "#sms",
      methods: [{ method: "sms", selector: "button:has-text('Text ***-***-1234')" }],
    },
  ],
  ["[private] selector", { fields: [], submit: "button:has-text('Continue as [private]')" }],
])("counts the screen before as sent when a %s step is refused, so a corrected login's third fill of the same password is refused", async (_, refusedStep) => {
  let fills = 0;
  const host = harness({
    held: account,
    visible: ["#no-account"],
    corrections: [
      { ...account, username: "ada-corrected" },
      { ...account, username: "ada-second" },
    ],
    // The host's click fails on the first screen, and goes through on every later one.
    report: (step) => ({
      outcome: "filled",
      fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
      submit: (fills += 1) === 1 ? "failed" : "clicked",
      url: `${origin}/login`,
    }),
  });
  const login: SignInStep = {
    ...identifierAndPassword,
    rejectedMarkers: [{ slot: "username", selector: "#no-account" }],
  };
  const rejectedUsername: SignInStep = { rejected: { slot: "username" } };
  const third = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(login, undefined, Effect.void);
      const refused = yield* recorder.step(refusedStep, undefined, Effect.void);
      expect(refused.result).toMatchObject({
        step: { outcome: "refused", reason: "selector_names_contact" },
      });
      for (let round = 0; round < 2; round++) {
        if (round > 0) yield* recorder.step(login, undefined, Effect.void);
        const corrected = yield* recorder.step(rejectedUsername, undefined, Effect.void);
        expect(corrected.result).toMatchObject({ corrected: true });
      }
      return yield* recorder.step(login, undefined, Effect.void);
    }),
  );
  // The password went out on two fills, so the third login screen types nothing.
  expect(third.result).toMatchObject({
    step: { outcome: "refused", reason: "credential_already_filled" },
  });
  expect(host.filled.map(({ values }) => values)).toEqual([
    [account.username, account.password],
    ["ada-corrected", account.password],
  ]);
});

it("confirms an approval after a sent identifier, records it as version 2, and verifies with it", async () => {
  const host = harness();
  const published = await host.run((recorder) =>
    Effect.gen(function* () {
      const early = yield* recorder.step({ approval: "device" }, undefined, Effect.void);
      expect(early.result).toMatchObject({ approved: false, failed: "identifier_not_submitted" });
      yield* recorder.step(identifierOnly, undefined, Effect.void);
      const approved = yield* recorder.step({ approval: "device" }, undefined, Effect.void);
      expect(approved).toMatchObject({ approved: true, result: { approved: true } });
      expect((yield* recorder.step(signedIn, undefined, Effect.void)).verified).toBe(true);
      return recorder.published();
    }),
  );
  expect(host.asked.at(-1)?.questions).toEqual([
    {
      id: "approved",
      type: "confirm",
      prompt: "Approve the site's sign-in request on your device, then confirm here.",
    },
  ]);
  expect(published?.recipe).toMatchObject({
    version: 2,
    steps: [{ submit: "#next" }, { page: `${origin}/login`, fields: [], approval: "device" }],
  });
});

it("refuses a marker a signed-out page shows, and a sign-in page's path, before reading the page, keeping the sign-in open", async () => {
  const host = harness({ signedOutPages: [signedOutPage(`<nav id="site-menu">Menu</nav>`)] });
  await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierAndPassword, `${origin}/login`, Effect.void);
      const shown = yield* recorder.step(
        { signedIn: { selector: "#site-menu" } },
        undefined,
        Effect.void,
      );
      expect(shown.result).toEqual({
        signedIn: false,
        failed: "marker_matches_signed_out_page",
        nextStep:
          "This marker also shows on a page the host saw signed out, so it cannot tell a signed-in page from a signed-out one. The host checks this marker after resets, at every operation start, after page loads in the middle of a run and on whatever page a failure lands on, so pick a site-wide element only a signed-in user sees, such as the global header's account menu or a sign-out control, preferring an aria-label, role or visible text to generated class names. Test it with check_signed_in_marker until every check passes, then send signedIn again.",
      });
      const path = yield* recorder.step(
        { signedIn: { urlPath: "/login" } },
        undefined,
        Effect.void,
      );
      expect(path.result).toMatchObject({ signedIn: false, failed: "marker_is_login_path" });
      expect(host.confirmed).toEqual([]);
      expect(recorder.published()).toBeUndefined();
      // The sign-in stayed open: another marker verifies it with nothing filled again.
      expect((yield* recorder.step(signedIn, undefined, Effect.void)).verified).toBe(true);
    }),
  );
  expect(host.filled).toHaveLength(1);
});

it("refuses an indicator, a selector or a page that names the account, typing nothing", async () => {
  const host = harness({ held: account });
  await host.run((recorder) =>
    Effect.gen(function* () {
      const named = yield* recorder.step(
        {
          fields: [{ selector: `[data-user="${account.username}"]`, accepts: ["username"] }],
          submit: "#next",
        },
        undefined,
        Effect.void,
      );
      expect(named.result).toMatchObject({
        step: { outcome: "refused", reason: "selector_names_contact", target: 0 },
      });
      const masked = yield* recorder.step(
        {
          fields: [],
          submit: "#sms",
          methods: [{ method: "sms", selector: "button:has-text('Text ***-***-1234')" }],
        },
        undefined,
        Effect.void,
      );
      expect(masked.result).toMatchObject({ step: { reason: "selector_names_contact" } });
      expect(host.filled).toEqual([]);
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      const indicator = yield* recorder.step(
        { signedIn: { selector: `text=${account.username}` } },
        undefined,
        Effect.void,
      );
      expect(indicator.result).toMatchObject({ failed: "indicator_holds_identity" });
    }),
  );
});

/** What the minter reads when a recorded selector names the account. */
const selectorsNotice =
  'A screen\'s selectors and submit publish with the tool, so they never name this account\'s username, email, phone or account number (such as a "Continue as …" button or a data attribute holding it). Name each control by its role, label or a stable attribute, and send the step again.';

it("refuses a recorded selector holding [private], the mask the minter sees for every value it was given, typing nothing", async () => {
  const host = harness({ held: account });
  await host.run((recorder) =>
    Effect.gen(function* () {
      // The page said "No account found for [private]", and the minter recorded that as the
      // username's error.
      const marker = yield* recorder.step(
        {
          ...identifierAndPassword,
          rejectedMarkers: [{ slot: "username", selector: "text=No account found for [private]" }],
        },
        undefined,
        Effect.void,
      );
      expect(marker.result).toEqual({
        step: { outcome: "refused", reason: "selector_names_contact", target: 0 },
        nextStep: selectorsNotice,
      });
      for (const step of [
        { fields: [{ selector: "input[value='[private]']", accepts: ["username"] }] },
        { fields: [{ selector: "#user", accepts: ["username"] }], submit: "#go-[private]" },
        {
          fields: [
            {
              selector: "#answer",
              slot: "private_answer",
              questionSelector: "text=Hello [private]",
            },
          ],
          submit: "#next",
        },
        {
          fields: [],
          submit: "#send",
          methods: [{ method: "email", selector: "text=Email [private]" }],
        },
      ] satisfies SignInStep[]) {
        const refused = yield* recorder.step(step, undefined, Effect.void);
        expect(refused.result).toMatchObject({
          step: { outcome: "refused", reason: "selector_names_contact" },
        });
      }
      expect(host.filled).toEqual([]);
      expect(host.reviewed).toEqual([]);
      // The `[password]`, `[code]` and `[recovery_code]` placeholders are refused by the shared guard as before.
      const placeholder = yield* recorder.step(
        {
          fields: [{ selector: "#user", accepts: ["username"] }],
          submit: "button:has-text('[password]')",
        },
        undefined,
        Effect.void,
      );
      expect(placeholder.result).toMatchObject({
        step: { outcome: "refused", reason: "selector_names_contact" },
      });
      expect(host.filled).toEqual([]);
    }),
  );
});

it("refuses a signed-in check holding [private] before it reads the page", async () => {
  const host = harness({ held: account });
  const result = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      return yield* recorder.step(
        { signedIn: { selector: "text=Hi [private]" } },
        undefined,
        Effect.void,
      );
    }),
  );
  expect(result.result).toEqual({
    signedIn: false,
    failed: "indicator_holds_identity",
    nextStep:
      "The signed-in check names this account's own identity, which publishes with the tool and fails for every other login. Name a marker every signed-in account shows, such as a sign-out control or the account menu, never the account's name, email or number, then inspect read-only and correct the sign-in steps from the page's evidence.",
  });
  expect(host.confirmed).toEqual([]);
});

it.each([
  ["path", { urlPath: "/accounts/[private]" }],
  ["account page", { selector: "#account-menu", openPath: "/accounts/[private]/settings" }],
])("refuses a signed-in check whose %s holds [private] before it reads the page", async (_, check) => {
  const host = harness({ held: account });
  const result = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      const refused = yield* recorder.step({ signedIn: check }, undefined, Effect.void);
      expect(recorder.published()).toBeUndefined();
      return refused;
    }),
  );
  expect(result.verified).toBeUndefined();
  expect(result.result).toMatchObject({ signedIn: false, failed: "indicator_holds_identity" });
  expect(host.confirmed).toEqual([]);
});

it("refuses a password screen before any identifier screen while the build holds no login", async () => {
  const host = harness();
  const result = await host.run((recorder) => recorder.step(passwordOnly, undefined, Effect.void));
  expect(result.result).toMatchObject({
    step: { outcome: "refused", reason: "login_identifier_unobserved" },
  });
  expect(host.logins).toEqual([]);
  expect(host.filled).toEqual([]);
});

it("records a screen that asks for the password again with a code as a version 5 refill, and a refill without a code as none", async () => {
  const host = harness({ held: account, answers: { code: ["482913"] } });
  const published = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      yield* recorder.step(
        {
          fields: [
            { selector: "#password", slot: "password" },
            { selector: "#code", slot: "code" },
          ],
          submit: "#sign-in",
        },
        undefined,
        Effect.void,
      );
      expect((yield* recorder.step(signedIn, undefined, Effect.void)).verified).toBe(true);
      return recorder.published();
    }),
  );
  expect(published?.recipe).toMatchObject({
    version: 5,
    steps: [
      { fields: [{ selector: "#user" }, { selector: "#password" }] },
      {
        fields: [
          { selector: "#password", slot: "password" },
          { selector: "#code", slot: "code" },
        ],
        refills: ["password"],
      },
    ],
  });
  expect(published?.recipe.steps[0]).not.toHaveProperty("refills");

  const plain = harness({ held: account });
  const again = await plain.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      yield* recorder.step(passwordOnly, undefined, Effect.void);
      yield* recorder.step(signedIn, undefined, Effect.void);
      return recorder.published();
    }),
  );
  expect(again?.recipe.version).toBe(1);
  expect(again?.recipe.steps[1]).not.toHaveProperty("refills");
});

it("records no refill on a screen that asks for the password again after a code already went out", async () => {
  const host = harness({ held: account, answers: { code: ["482913", "135790"] } });
  const published = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      yield* recorder.step(
        { fields: [{ selector: "#otp", slot: "code" }], submit: "#verify" },
        undefined,
        Effect.void,
      );
      yield* recorder.step(
        {
          fields: [
            { selector: "#password", slot: "password" },
            { selector: "#code", slot: "code" },
          ],
          submit: "#sign-in",
        },
        undefined,
        Effect.void,
      );
      yield* recorder.step(signedIn, undefined, Effect.void);
      return recorder.published();
    }),
  );
  expect(published?.recipe.version).toBe(1);
  expect(published?.recipe.steps.some((step) => "refills" in step)).toBe(false);
});

it("fills a password twice at most in one sign-in, and a ZIP once", async () => {
  const host = harness({ held: account, answers: { zip: ["94110"] } });
  await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      yield* recorder.step(passwordOnly, undefined, Effect.void);
      const third = yield* recorder.step(passwordOnly, undefined, Effect.void);
      expect(third.result).toMatchObject({
        step: { outcome: "refused", reason: "credential_already_filled", target: 0 },
      });
      const zip = { fields: [{ selector: "#zip", slot: "zip" as const }], submit: "#go" };
      yield* recorder.step(zip, undefined, Effect.void);
      expect((yield* recorder.step(zip, undefined, Effect.void)).result).toMatchObject({
        step: { reason: "credential_already_filled" },
      });
    }),
  );
  expect(host.filled).toHaveLength(3);
});

it("takes a rejected password only once its recorded marker shows, and corrects it twice with the tries left", async () => {
  const host = harness({
    visible: ["#wrong-password"],
    corrections: [
      { ...account, password: "corrected-password" },
      { ...account, password: "second-correction" },
    ],
  });
  const exit = await host.run((recorder) =>
    Effect.gen(function* () {
      for (const expected of ["corrected-password", "second-correction"]) {
        yield* recorder.step(markedLogin, undefined, Effect.void);
        const correction = yield* recorder.step(rejectedPassword, undefined, Effect.void);
        expect(correction.result).toEqual({
          corrected: true,
          nextStep:
            "The owner gave a corrected login. Start the sign-in screens again from the login page: send each screen's signInStep, then signedIn.",
        });
        expect(expected).toBeDefined();
      }
      yield* recorder.step(markedLogin, undefined, Effect.void);
      return yield* Effect.exit(recorder.step(rejectedPassword, undefined, Effect.void));
    }),
  );
  // Each corrected login starts a new sign-in, filled with its own password.
  expect(host.filled.map(({ values }) => values[1])).toEqual([
    account.password,
    "corrected-password",
    "second-correction",
  ]);
  expect(host.logins).toEqual([
    "missing_credentials",
    "invalid_credentials:password:2",
    "invalid_credentials:password:1",
  ]);
  expect(exit).toEqual(
    Exit.fail(
      expect.objectContaining({ code: "CredentialsRejected", rejectedCredential: "password" }),
    ),
  );
});

it("takes no verdict on a reported rejection no recorded marker shows, and asks nobody", async () => {
  const host = harness({ held: account });
  const result = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(markedLogin, undefined, Effect.void);
      return yield* recorder.step(rejectedPassword, undefined, Effect.void);
    }),
  );
  expect(result.result).toEqual({
    rejected: false,
    reason: "no_rejection_marker",
    nextStep:
      "No recorded error marker for the password shows on the page, so the host neither marks the login nor asks its owner. If the page shows the site's error for that field, send that screen's signInStep again with the error as its rejectedMarkers, then report the rejection again. Otherwise explore read-only to see the page, then inspect read-only and correct the sign-in steps from the page's evidence.",
  });
  expect(host.logins).toEqual([]);
});

it("takes a rejected password whose recorded marker showed right after the host's submit, though it went before the report", async () => {
  const host = harness({
    toast: "#wrong-password",
    corrections: [{ ...account, password: "corrected-password" }],
  });
  const result = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(markedLogin, undefined, Effect.void);
      // The site's message showed for a few seconds and went before the minter reported it.
      host.shown.clear();
      return yield* recorder.step(rejectedPassword, undefined, Effect.void);
    }),
  );
  expect(result.result).toMatchObject({ corrected: true });
  expect(host.logins).toEqual(["missing_credentials", "invalid_credentials:password:2"]);
});

it("keeps the markers it read right after a submit only until the next screen", async () => {
  const host = harness({ held: account, toast: "#wrong-password" });
  const result = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(markedLogin, undefined, Effect.void);
      host.shown.clear();
      // The next screen's submit showed no error, so the earlier message no longer counts.
      yield* recorder.step(passwordOnly, undefined, Effect.void);
      return yield* recorder.step(rejectedPassword, undefined, Effect.void);
    }),
  );
  expect(result.result).toMatchObject({ rejected: false, reason: "no_rejection_marker" });
  expect(host.logins).toEqual([]);
});

it("refuses a rejection of a value this sign-in never sent", async () => {
  const host = harness();
  const early = await host.run((recorder) =>
    recorder.step(rejectedPassword, undefined, Effect.void),
  );
  expect(early.result).toEqual({
    step: { outcome: "refused", reason: "nothing_rejected", target: 0 },
    nextStep:
      "No password was sent in this sign-in, so there is nothing for the site to have rejected. Explore read-only to see the page, then send the next signInStep.",
  });
});

it("ends the build when the correction repeats the rejected password", async () => {
  const host = harness({ visible: ["#wrong-password"], corrections: [account] });
  const exit = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(markedLogin, undefined, Effect.void);
      return yield* Effect.exit(recorder.step(rejectedPassword, undefined, Effect.void));
    }),
  );
  expect(Exit.isFailure(exit) && exit.cause._tag === "Fail" && exit.cause.error).toBeInstanceOf(
    MintFailure,
  );
  expect(exit).toEqual(
    Exit.fail(
      expect.objectContaining({ code: "CredentialsRejected", rejectedCredential: "password" }),
    ),
  );
  expect(host.filled).toHaveLength(1);
});

it("asks a new code after the site rejected one, and ends once three were rejected", async () => {
  const host = harness({ held: account, answers: { code: ["111111", "222222", "333333"] } });
  const code = { fields: [{ selector: "#code", slot: "code" as const }], submit: "#verify" };
  const exit = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      for (let round = 0; round < 2; round++) {
        yield* recorder.step(code, undefined, Effect.void);
        expect(
          (yield* recorder.step({ rejected: { slot: "code" } }, undefined, Effect.void)).result,
        ).toEqual({
          rejected: "code",
          nextStep:
            "The host will ask the owner for a new code at the next code step. Send the code screen's signInStep again.",
        });
      }
      yield* recorder.step(code, undefined, Effect.void);
      return yield* Effect.exit(
        recorder.step({ rejected: { slot: "code" } }, undefined, Effect.void),
      );
    }),
  );
  expect(host.filled.slice(1).map(({ values }) => values[0])).toEqual([
    "111111",
    "222222",
    "333333",
  ]);
  expect(host.asked.map(({ questions }) => questions[0]?.prompt)).toEqual([
    "Enter the sign-in code example.test sent you.",
    "The site refused the last code. Enter the newest sign-in code example.test sent you.",
    "The site refused the last code. Enter the newest sign-in code example.test sent you.",
  ]);
  expect(exit).toEqual(
    Exit.fail(expect.objectContaining({ code: "CredentialsRejected", rejectedCredential: "code" })),
  );
});

// A page that says the account is locked is no field the owner can correct: once the login went
// out and the element that says so shows, the sign-in ends as an account-level rejection.
it("ends the sign-in as AccountLocked once the site visibly refused the account the login named", async () => {
  const host = harness({
    visible: ["#locked", "#site-menu"],
    signedOutPages: [signedOutPage(`<nav id="site-menu">Menu</nav>`)],
  });
  const locked = (selector: string): SignInStep => ({ rejected: { account: "locked", selector } });
  const exit = await host.run((recorder) =>
    Effect.gen(function* () {
      const early = yield* recorder.step(locked("#locked"), undefined, Effect.void);
      expect(early.result).toEqual({
        rejected: false,
        reason: "nothing_rejected",
        nextStep:
          "No screen of an open sign-in on this browser submitted the login, so the site cannot have refused its account. Send the sign-in screens' signInSteps first, then inspect read-only and correct the sign-in steps from the page's evidence.",
      });
      yield* recorder.step(identifierOnly, undefined, Effect.void);
      // The identifier alone is no login the site could refuse the account for.
      expect((yield* recorder.step(locked("#locked"), undefined, Effect.void)).result).toMatchObject(
        { reason: "nothing_rejected" },
      );
      yield* recorder.step(passwordOnly, undefined, Effect.void);
      const everywhere = yield* recorder.step(locked("#site-menu"), undefined, Effect.void);
      expect(everywhere.result).toEqual({
        rejected: false,
        reason: "marker_matches_signed_out_page",
        nextStep:
          "This marker also shows on a page the host saw signed out, before the login was sent, so it cannot tell a lock message from the rest of the site. Report the account again with a selector of the message itself, then inspect read-only and correct the sign-in steps from the page's evidence.",
      });
      const hidden = yield* recorder.step(locked("#other"), undefined, Effect.void);
      expect(hidden.result).toEqual({
        rejected: false,
        reason: "no_rejection_marker",
        nextStep:
          "The marker does not show on the page the sign-in led to, so the host takes no verdict on the account. Explore read-only to see the page, and report the account again with a selector of the message it shows, then inspect read-only and correct the sign-in steps from the page's evidence.",
      });
      return yield* Effect.exit(recorder.step(locked("#locked"), undefined, Effect.void));
    }),
  );
  expect(exit).toEqual(
    Exit.fail(
      expect.objectContaining({
        authentication: expect.objectContaining({ code: "AccountLocked", account: "locked" }),
      }),
    ),
  );
  expect(host.logins).toEqual(["missing_credentials"]);
});

// A phone field the site's country picker preset to another country keeps other digits than the
// number: the fill stops before its submit, and the agent hears the number's calling code, so it
// sets the picker and sends the step again. Nobody is asked to correct the number.
it("tells the agent the calling code of a phone the field changed, asking nobody and sending nothing", async () => {
  let sends = 0;
  const host = harness({
    held: { ...account, phone: "+7 912 345-67-89" },
    report: (step) => {
      sends += 1;
      return {
        outcome: "filled",
        fields: step.fields.map((field) => ({
          slot: field.slot,
          status: sends === 1 ? ("changed" as const) : ("filled" as const),
        })),
        submit: sends === 1 ? "not_attempted" : "clicked",
        url: `${origin}/login`,
        ...(sends === 1 ? { typed: true as const } : {}),
      };
    },
  });
  const phoneScreen: SignInStep = {
    fields: [{ selector: "#phone", accepts: ["phone"] }],
    submit: "#next",
  };
  const [changed, again] = await host.run((recorder) =>
    Effect.all([
      recorder.step(phoneScreen, undefined, Effect.void),
      recorder.step(phoneScreen, undefined, Effect.void),
    ]),
  );
  expect(changed.result["nextStep"]).toBe(
    "The phone field kept different digits than the number the host typed, as when the site's country picker is set to another country. Nothing was submitted and nobody was asked. The number's country calling code is +7. If the screen has a country picker, prefer setting it to that country with an explore step, then send this signInStep again.",
  );
  expect(JSON.stringify(changed.result)).not.toContain("912");
  expect(again.report).toMatchObject({ submit: "clicked" });
  expect(host.asked).toEqual([]);
  expect(host.filled.map(({ values }) => values)).toEqual([
    ["+7 912 345-67-89"],
    ["+7 912 345-67-89"],
  ]);
});

it("refuses a code step that names only some of the screen's one-character boxes, asking nothing", async () => {
  const host = harness({ held: account, codeBoxes: 6, answers: { code: ["482913"] } });
  const result = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      return yield* recorder.step(
        { fields: [1, 2, 3].map((box) => ({ selector: `#otp-${box}`, slot: "code" as const })) },
        undefined,
        Effect.void,
      );
    }),
  );
  expect(result.report).toMatchObject({ outcome: "refused", reason: "code_boxes_incomplete" });
  expect(result.result["nextStep"]).toContain("splits its code across 6 one-character boxes");
  expect(host.asked).toEqual([]);
  expect(host.filled).toHaveLength(1);
});

it("asks a code screen of one-character boxes for its code once, types a character in each, and verifies once its page sent it", async () => {
  const host = harness({
    held: account,
    codeBoxes: 6,
    answers: { code: ["482 913"] },
    report: (step) => ({
      outcome: "filled",
      fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
      submit: step.fields.some((field) => field.slot === "code") ? "page" : "clicked",
      url: `${origin}/next`,
    }),
  });
  const boxes: SignInStep = {
    fields: [1, 2, 3, 4, 5, 6].map((box) => ({ selector: `#otp-${box}`, slot: "code" as const })),
  };
  const checked = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierOnly, undefined, Effect.void);
      const screen = yield* recorder.step(boxes, undefined, Effect.void);
      expect(screen.result["nextStep"]).toContain("the page may have sent them itself");
      return yield* recorder.step(signedIn, undefined, Effect.void);
    }),
  );
  expect(checked).toMatchObject({ verified: true, result: { signedIn: true } });
  expect(
    host.asked.flatMap((request) => request.questions).filter((question) => question.id === "code"),
  ).toHaveLength(1);
  expect(host.filled.at(-1)?.values).toEqual(["4", "8", "2", "9", "1", "3"]);
});

it.each([6, 7, 8])("asks a code screen of %i one-character boxes for its code once, types a character in each, and verifies once the host's click sent it", async (count) => {
  const digits = "4829135706".slice(0, count);
  const host = harness({ held: account, codeBoxes: count, answers: { code: [digits] } });
  const boxes: SignInStep = {
    fields: Array.from({ length: count }, (_, at) => ({ selector: `#otp-${at + 1}`, slot: "code" as const })),
    submit: "#verify",
  };
  const published = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierOnly, undefined, Effect.void);
      yield* recorder.step(boxes, undefined, Effect.void);
      const checked = yield* recorder.step(signedIn, undefined, Effect.void);
      expect(checked).toMatchObject({ verified: true, result: { signedIn: true } });
      return recorder.published();
    }),
  );
  expect(host.asked.flatMap((r) => r.questions).filter((q) => q.id === "code")).toHaveLength(1);
  expect(host.filled.at(-1)?.values).toEqual(Array.from(digits));
  expect(published?.recipe.steps[1]).toEqual({
    page: `${origin}/login`, fields: boxes.fields, submit: "#verify", submittedBy: "host",
  });
});

it.each([7, 8])("keeps a %i-box code unsent when its last box did not fill, so the check does not verify", async (count) => {
  const digits = "4829135706".slice(0, count);
  const host = harness({
    held: account,
    codeBoxes: count,
    answers: { code: [digits] },
    report: (step) => {
      const codes = step.fields.some((field) => field.slot === "code");
      return {
        outcome: "filled",
        fields: step.fields.map((field, at) => ({
          slot: field.slot,
          status: codes && at === step.fields.length - 1 ? ("failed" as const) : ("filled" as const),
        })),
        submit: codes ? ("not_attempted" as const) : ("clicked" as const),
        url: `${origin}/next`,
      };
    },
  });
  const boxes: SignInStep = {
    fields: Array.from({ length: count }, (_, at) => ({ selector: `#otp-${at + 1}`, slot: "code" as const })),
    submit: "#verify",
  };
  const checked = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierOnly, undefined, Effect.void);
      yield* Effect.either(recorder.step(boxes, undefined, Effect.void));
      return yield* Effect.either(recorder.step(signedIn, undefined, Effect.void));
    }),
  );
  expect(host.filled).toHaveLength(2);
  expect(JSON.stringify(checked)).not.toContain('"verified":true');
  expect(host.confirmed).toEqual([]);
});

it("records a private answer's question selector in version 1, never its question or answer", async () => {
  const host = harness({
    held: account,
    questions: ["What was your first pet's name?"],
    answers: { private_answer: ["synthetic-answer"] },
  });
  const published = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      yield* recorder.step(
        {
          fields: [{ selector: "#answer", slot: "private_answer", questionSelector: "#question" }],
          submit: "#continue",
        },
        undefined,
        Effect.void,
      );
      yield* recorder.step(signedIn, undefined, Effect.void);
      return recorder.published();
    }),
  );
  expect(published?.recipe.version).toBe(1);
  expect(published?.recipe.steps[1]?.fields).toEqual([
    { selector: "#answer", slot: "private_answer", questionSelector: "#question" },
  ]);
  expect(host.asked.at(-1)?.questions[0]?.prompt).toBe(
    "example.test asks this security question: What was your first pet's name?",
  );
  const text = JSON.stringify(published);
  for (const secret of ["first pet", "synthetic-answer", account.password, "Field"])
    expect(text).not.toContain(secret);
});

it("discards a private answer from the values it filled once the fill is over", async () => {
  const host = harness({
    held: account,
    questions: ["What was your first pet's name?"],
    answers: { private_answer: ["synthetic-answer"] },
  });
  await host.run((recorder) =>
    recorder.step(
      {
        fields: [
          { selector: "#user", accepts: ["username"] },
          { selector: "#answer", slot: "private_answer", questionSelector: "#question" },
        ],
        submit: "#continue",
      },
      undefined,
      Effect.void,
    ),
  );
  // The fill typed the answer, and the list the host filled from no longer holds it.
  expect(host.filled[0]?.values).toEqual([account.username, "synthetic-answer"]);
  expect(host.given[0]).toEqual([account.username, ""]);
});

it("publishes only the latest verified sign-in, and none once a later one reached the page", async () => {
  const unreached = (step: AutofillStep): AutofillStepReport => ({
    outcome: "filled",
    fields: step.fields.map((field) => ({ slot: field.slot, status: "not_attempted" as const })),
    submit: "not_attempted",
    url: `${origin}/login`,
  });
  let reach = true;
  const host = harness({
    held: account,
    report: (step) =>
      reach
        ? {
            outcome: "filled",
            fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
            submit: "clicked",
            url: `${origin}/next`,
          }
        : unreached(step),
  });
  await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      yield* recorder.step(signedIn, undefined, Effect.void);
      expect(recorder.published()).toBeDefined();
      // A later first screen that reached nothing leaves the verified one published.
      reach = false;
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      expect(recorder.published()).toBeDefined();
      // A later sign-in's screen reached the page, so the verified one no longer describes it.
      reach = true;
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      expect(recorder.published()).toBeUndefined();
    }),
  );
});

it("takes a code an exploration typed as the proof after a sent identifier", async () => {
  const host = harness();
  const result = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierOnly, undefined, Effect.void);
      expect((yield* recorder.step(signedIn, undefined, Effect.void)).verified).toBeUndefined();
      recorder.codeTyped();
      return yield* recorder.step(signedIn, undefined, Effect.void);
    }),
  );
  expect(result.verified).toBe(true);
});

it("waits for a marker the page draws late before it takes the check's answer", async () => {
  const host = harness({ held: account, lateMarker: 2 });
  const checked = await host.run((recorder) =>
    Effect.gen(function* () {
      yield* recorder.step(identifierAndPassword, undefined, Effect.void);
      return yield* recorder.step(signedIn, undefined, Effect.void);
    }),
  );
  expect(checked).toMatchObject({ verified: true, result: { signedIn: true } });
  expect(host.confirmed).toHaveLength(3);
});

it("judges a later build's first screen as typed into once an earlier build typed on the session's page", async () => {
  // The password screen as the host's inspection finds it, then its field taking the focus.
  const located = {
    fields: [{ target, described: { ...described, type: "password", id: "password" } }],
    submit: { target, described: { ...described, tag: "button", type: "submit", id: "sign-in" } },
    buttons: ["Sign in"],
    url: `${origin}/login`,
  };
  const page = (answers: unknown[]): AutofillPage => ({
    targetId: "primary",
    execute: () => Effect.sync(() => answers.shift() ?? { error: "not_found", target: 0 }),
  });
  const typing = { typed: false };
  const browserOn = (answers: unknown[]) =>
    makeSignInBrowser({
      page: page(answers),
      // The insertion reached the page, but its answer was lost.
      keyboard: { insertText: () => Effect.fail(new Error("Insertion reply lost")) },
      siteOrigin: origin,
      authenticationOrigins: [],
      typing,
    });
  const step = {
    fields: [{ selector: "#password", slot: "password" as const }],
    submit: "#sign-in",
  };
  const earlier = browserOn([located, { focused: true, url: `${origin}/login` }]);
  const inspected = await Effect.runPromise(earlier.inspect(step));
  if ("outcome" in inspected) throw new Error("Inspection refused");
  expect(inspected.judgedBeforeTyping).toBeUndefined();
  const report = await Effect.runPromise(
    earlier.fill({ step, values: ["synthetic-password"], inspection: inspected }),
  );
  expect(report).toMatchObject({ outcome: "uncertain", typed: true });
  expect(typing.typed).toBe(true);
  // A later build's browser on the same session starts as typed into.
  const later = await Effect.runPromise(browserOn([located]).inspect(step));
  expect(later).toMatchObject({ judgedBeforeTyping: [] });
});
