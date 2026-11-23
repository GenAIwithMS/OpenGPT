import { Duration, Effect, Either } from "effect";
import { expect, it } from "vitest";
import type { AutofillInspection, AutofillSignedInCheck } from "../../src/destinations/autofill-step.js";
import type { SignInRecipe } from "../../src/destinations/sign-in-recipe.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import type { InputAnswers, Question } from "../../src/runtime/input-request.js";
import { sameSite } from "../../src/runtime/same-site.js";
import {
  signInForRun,
  SignInRunFailed,
  type SignInReplayBrowser,
  type WorkspaceOriginEvent,
} from "../../src/runtime/sign-in-replay.js";
import { localSignInLogin } from "../../src/standalone/authentication.js";

// A run's sign-in on a synthetic workspace SaaS: the identifier screen is on the shared host
// app.example.com, and the site then sends each account to its own workspace host for the
// password (acme. or globex.). Every host is synthetic.

const defaultSite = "https://app.example.com";
const site = defaultSite;
const acme = "https://acme.example.com";
const globex = "https://globex.example.com";
const evil = "https://evil.example.com";
const password = "synthetic-password";
const accounts: Record<string, string> = { "ada-owner": acme, "grace-owner": globex };

interface SiteOptions {
  /** Where the identifier screen sends the account for its password. */
  readonly passwordOn?: (username: string) => string;
  /** Leftover state: opening the entry lands on this page of another tenant. */
  readonly leftover?: string;
  /** Whether clearing the site's data removes the leftover state. */
  readonly clearable?: boolean;
  /** The session is already signed in on this workspace. */
  readonly signedInOn?: string;
  /** Where the correct password sends the session instead of its account page. */
  readonly afterPassword?: string;
  /** The site's own origin, when it is not the default one. */
  readonly origin?: string;
}

const screens: Record<string, readonly string[]> = {
  "/login": ["#username", "#next"],
  "/login/password": ["#password", "#sign-in"],
  "/login/continue": ["#continue"],
  "/home": [],
};

const fakeSite = (options: SiteOptions = {}) => {
  const site = options.origin ?? defaultSite;
  const state = {
    at: new URL(`${site}/login`),
    signedInOn: options.signedInOn,
    leftover: options.leftover,
  };
  const fills: string[] = [];
  const checkedOn: (string | undefined)[] = [];
  const opened: string[] = [];
  const trusted = (url: URL) => sameSite(site, url);
  // The site serves each screen with or without a trailing slash on its path.
  const path = () => (state.at.pathname.length > 1 ? state.at.pathname.replace(/\/$/u, "") : state.at.pathname);
  const shows = (selector: string) => (screens[path()] ?? []).includes(selector);
  const page = () => `${state.at.origin}${state.at.pathname}`;
  const browser: SignInReplayBrowser<Error> = {
    inspect: (step) =>
      Effect.sync(() => {
        const selectors = [...step.fields.map((field) => field.selector), ...(step.submit === undefined ? [] : [step.submit])];
        if (selectors.length === 0 || !selectors.every(shows)) return { outcome: "refused" as const, reason: "not_found" as const };
        if (!trusted(state.at)) return { outcome: "refused" as const, reason: "credential_target_refused" as const };
        const target = {
          ownerUrl: page(),
          documentOrigin: state.at.origin,
          actions: [page()],
          methods: ["post"],
          editable: true,
          control: "text" as const,
          empty: true,
        };
        const inspection: AutofillInspection = {
          url: page(),
          page: page(),
          targets: { fields: step.fields.map(() => target), submit: step.submit === undefined ? null : target },
          siteOrigin: site,
          authenticationOrigins: [],
          screen: {
            origin: state.at.origin,
            fields: step.fields.map((field) => ({
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
              slot: field.slot,
            })),
            submit: null,
            buttons: [],
          },
        };
        return inspection;
      }),
    fill: ({ step, values }) =>
      Effect.sync(() => {
        const filledOn = page();
        fills.push(filledOn);
        if (path() === "/login") {
          const username = values[0] ?? "";
          const next = options.passwordOn?.(username) ?? `${accounts[username] ?? site}/login/password`;
          state.at = new URL(next);
        } else if (path() === "/login/continue") {
          state.signedInOn = state.at.origin;
          state.at = new URL(`${state.at.origin}/home`);
        } else if (
          screens[path()]?.includes("#password") === true &&
          values[0] === password &&
          options.afterPassword !== undefined
        ) {
          state.at = new URL(options.afterPassword);
        } else if (screens[path()]?.includes("#password") === true && values[0] === password) {
          state.signedInOn = state.at.origin;
          state.at = new URL(`${state.at.origin}/home`);
        }
        return {
          outcome: "filled" as const,
          fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
          submit: "clicked" as const,
          url: state.at.href,
        };
      }),
    confirm: (indicator, _screens, _challenges, openOrigin) =>
      Effect.sync((): AutofillSignedInCheck => {
        if (indicator.openPath !== undefined) {
          checkedOn.push(openOrigin);
          state.at = new URL(indicator.openPath, openOrigin ?? site);
        }
        const url = state.at.href;
        return state.at.pathname === "/home" && state.at.origin === state.signedInOn
          ? { signedIn: true, url }
          : { signedIn: false, failed: "indicator_not_visible", url };
      }),
    authenticationOrigins: [],
    open: (url) =>
      Effect.sync(() => {
        opened.push(url);
        state.at =
          state.leftover !== undefined
            ? new URL(state.leftover)
            : state.signedInOn !== undefined
              ? new URL(`${state.signedInOn}/home`)
              : new URL(url);
      }),
    markerVisible: () => Effect.succeed(false),
    clearSiteData: () =>
      Effect.sync(() => {
        if (options.clearable === true) state.leftover = undefined;
      }),
  };
  return { browser, state, fills, checkedOn, opened };
};

const identifierStep = {
  page: `${site}/login`,
  fields: [{ selector: "#username", accepts: ["username" as const] }],
  submit: "#next",
};
const passwordStep = {
  page: `${site}/login/password`,
  fields: [{ selector: "#password", slot: "password" as const }],
  submit: "#sign-in",
};
const workspaceRecipe: SignInRecipe = {
  version: 4,
  workspace: { parent: "example.com" },
  steps: [
    identifierStep,
    {
      origin: "workspace",
      page: "/login/password",
      fields: [{ selector: "#password", slot: "password" }],
      submit: "#sign-in",
    },
  ],
  signedIn: { selector: "#account", openPath: "/home" },
};

const owner = (username: string) =>
  makeInputAsker((request) =>
    Effect.succeed(
      Object.fromEntries(
        request.questions.map((question: Question) => [
          question.id,
          question.type === "credential" ? { username, password, saveLogin: false } : "",
        ]),
      ) as InputAnswers,
    ),
  );

const signIn = (
  recipe: SignInRecipe,
  fake: ReturnType<typeof fakeSite>,
  username = "ada-owner",
  workspaceOrigin?: string,
  events: WorkspaceOriginEvent[] = [],
  at: { readonly siteOrigin?: string; readonly entryUrl?: string } = {},
) => {
  const siteOrigin = at.siteOrigin ?? site;
  const secrets = makeRunSecrets();
  const ask = owner(username);
  return Effect.runPromise(
    Effect.either(
      signInForRun({
        recipe,
        entryUrl: at.entryUrl ?? `${siteOrigin}/login`,
        browser: fake.browser,
        login: localSignInLogin({ ask, register: secrets.register, siteOrigin }),
        ask,
        secrets,
        markerSettle: { within: Duration.millis(20), interval: Duration.millis(5) },
        site: "app.example.com",
        siteOrigin,
        ...(workspaceOrigin === undefined ? {} : { workspaceOrigin }),
        onWorkspaceEvent: (event) => events.push(event),
        timing: { stepWaitMs: 60, pollMs: 2 },
      }),
    ),
  );
};

it("types the password on the workspace host the site sent this login to after its identifier", async () => {
  const fake = fakeSite();
  expect(await signIn(workspaceRecipe, fake)).toEqual(
    Either.right({ alreadySignedIn: false, workspaceOrigin: acme }),
  );
  expect(fake.fills).toEqual([`${site}/login`, `${acme}/login/password`]);
});

it("replays the same recipe on another account's own workspace", async () => {
  const fake = fakeSite();
  expect(await signIn(workspaceRecipe, fake, "grace-owner")).toEqual(
    Either.right({ alreadySignedIn: false, workspaceOrigin: globex }),
  );
  expect(fake.fills).toEqual([`${site}/login`, `${globex}/login/password`]);
});

it("admits the shared sign-in screen on the login's pinned workspace", async () => {
  // The site remembers the workspace and shows the identifier screen there.
  const fake = fakeSite({ leftover: `${acme}/login`, passwordOn: () => `${acme}/login/password` });
  const pinned = await signIn(workspaceRecipe, fake, "ada-owner", acme);
  expect(pinned).toEqual(Either.right({ alreadySignedIn: false, workspaceOrigin: acme }));
});

it("goes on to a workspace screen the site shows with a trailing slash on the login's pinned workspace", async () => {
  // The site skips the shared identifier screen and shows the password screen, recorded as
  // /login/password, at /login/password/ on the login's pinned workspace.
  const fake = fakeSite({ leftover: `${acme}/login/password/` });
  const events: WorkspaceOriginEvent[] = [];
  expect(await signIn(workspaceRecipe, fake, "ada-owner", acme, events)).toEqual(
    Either.right({ alreadySignedIn: false, workspaceOrigin: acme }),
  );
  expect(fake.fills).toEqual([`${acme}/login/password/`]);
  expect(events).toEqual([]);
});

it("refuses another tenant's sign-in screen before this login sent anything, once the site's data is cleared", async () => {
  const fake = fakeSite({ leftover: `${evil}/login` });
  const events: WorkspaceOriginEvent[] = [];
  expect(await signIn(workspaceRecipe, fake, "ada-owner", undefined, events)).toEqual(
    Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "workspace_unverified" })),
  );
  expect(fake.fills).toEqual([]);
  // The refused origin goes only to the host's private event.
  expect(events).toEqual([
    { kind: "unrecognized_sibling", origin: evil },
    { kind: "unrecognized_sibling", origin: evil },
  ]);
});

it("learns the workspace again when the site sends a pinned login to another one", async () => {
  const fake = fakeSite();
  const events: WorkspaceOriginEvent[] = [];
  expect(await signIn(workspaceRecipe, fake, "grace-owner", acme, events)).toEqual(
    Either.right({ alreadySignedIn: false, workspaceOrigin: globex }),
  );
  expect(events).toEqual([{ kind: "relearned", from: acme, to: globex }]);
});

it("reopens the entry once after clearing the site's data, and then signs in on the login's own workspace", async () => {
  const fake = fakeSite({ leftover: `${evil}/login`, clearable: true });
  expect(await signIn(workspaceRecipe, fake)).toEqual(
    Either.right({ alreadySignedIn: false, workspaceOrigin: acme }),
  );
  expect(fake.fills).toEqual([`${site}/login`, `${acme}/login/password`]);
});

it("refuses a workspace password screen the site showed before the identifier went out", async () => {
  const fake = fakeSite({ leftover: `${evil}/login/password` });
  expect(await signIn(workspaceRecipe, fake)).toEqual(
    Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "workspace_unverified" })),
  );
  expect(fake.fills).toEqual([]);
});

it("checks on the workspace a signed-in session is on, but pins nothing this login sent nothing for", async () => {
  // The session shows an unpinned workspace host and this replay sent nothing: the check runs
  // there, and the run goes on, but the host may be leftover cookies, so it is not the login's.
  const fake = fakeSite({ signedInOn: acme });
  expect(await signIn(workspaceRecipe, fake)).toEqual(Either.right({ alreadySignedIn: true }));
  expect(fake.checkedOn).toEqual([acme]);
  expect(fake.fills).toEqual([]);
});

it("keeps the pinned workspace a signed-in session is on", async () => {
  const fake = fakeSite({ signedInOn: acme });
  expect(await signIn(workspaceRecipe, fake, "ada-owner", acme)).toEqual(
    Either.right({ alreadySignedIn: true, workspaceOrigin: acme }),
  );
  expect(fake.checkedOn).toEqual([acme]);
});

it("learns one workspace host per replay, and refuses a second one the site shows after it", async () => {
  const recipe: SignInRecipe = {
    ...workspaceRecipe,
    steps: [
      ...workspaceRecipe.steps,
      { origin: "workspace", page: "/login/continue", fields: [], submit: "#continue" },
    ],
  };
  const events: WorkspaceOriginEvent[] = [];
  const fake = fakeSite({ afterPassword: `${globex}/login/continue` });
  expect(await signIn(recipe, fake, "ada-owner", undefined, events)).toEqual(
    Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "workspace_unverified" })),
  );
  expect(fake.fills.some((page) => page.startsWith(globex))).toBe(false);
  expect(events).toContainEqual({ kind: "unrecognized_sibling", origin: globex });
});

it("clears and replays once when a pinned login is shown another workspace before it sent anything", async () => {
  const fake = fakeSite({ leftover: `${globex}/login`, clearable: true });
  expect(await signIn(workspaceRecipe, fake, "ada-owner", acme)).toEqual(
    Either.right({ alreadySignedIn: false, workspaceOrigin: acme }),
  );
  expect(fake.fills).toEqual([`${site}/login`, `${acme}/login/password`]);
});

it("learns no workspace from an identifier sent on the pinned workspace instead of the shared host", async () => {
  // Only an identifier sent on a screen's own recorded origin anchors a new workspace: one typed
  // on the pinned workspace says nothing about where else the site may send this login.
  const fake = fakeSite({ leftover: `${acme}/login`, passwordOn: () => `${globex}/login/password` });
  expect(await signIn(workspaceRecipe, fake, "ada-owner", acme)).toEqual(
    Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "workspace_unverified" })),
  );
  expect(fake.fills.some((page) => page.startsWith(globex))).toBe(false);
});

it("opens no login URL that names another address, and types nothing", async () => {
  for (const entryUrl of [
    `${site}/login?next=https://evil.example.com/login/password`,
    `${site}/login?next=https%253A%252F%252Fevil.example.com`,
    `${site}/login#return=evil.example.com`,
  ]) {
    const fake = fakeSite({ passwordOn: () => `${evil}/login/password` });
    expect(await signIn(workspaceRecipe, fake, "ada-owner", undefined, [], { entryUrl })).toEqual(
      Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "entry_names_address" })),
    );
    expect(fake.opened).toEqual([]);
    expect(fake.fills).toEqual([]);
  }
  // A recipe without a workspace relation opens such a URL as before.
  const plain = fakeSite({ passwordOn: () => `${site}/login/password` });
  const entryUrl = `${site}/login?next=https://app.example.com/home`;
  const recipe: SignInRecipe = {
    version: 4,
    steps: [identifierStep, passwordStep],
    signedIn: workspaceRecipe.signedIn,
  };
  expect(await signIn(recipe, plain, "ada-owner", undefined, [], { entryUrl })).toEqual(
    Either.right({ alreadySignedIn: false }),
  );
});

it("signs in on a workspace host on the site's own non-default port", async () => {
  const portSite = "https://app.example.com:8443";
  const portAcme = "https://acme.example.com:8443";
  const fake = fakeSite({ origin: portSite, passwordOn: () => `${portAcme}/login/password` });
  const recipe: SignInRecipe = {
    ...workspaceRecipe,
    steps: [{ ...identifierStep, page: `${portSite}/login` }, ...workspaceRecipe.steps.slice(1)],
  };
  expect(await signIn(recipe, fake, "ada-owner", undefined, [], { siteOrigin: portSite })).toEqual(
    Either.right({ alreadySignedIn: false, workspaceOrigin: portAcme }),
  );
  expect(fake.fills).toEqual([`${portSite}/login`, `${portAcme}/login/password`]);
});

it("refuses a workspace step whose relation names another registrable domain", async () => {
  const fake = fakeSite();
  const recipe: SignInRecipe = { ...workspaceRecipe, workspace: { parent: "example.org" } };
  expect(await signIn(recipe, fake)).toEqual(
    Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "screen_origin_changed" })),
  );
  expect(fake.fills).toEqual([`${site}/login`]);
});
