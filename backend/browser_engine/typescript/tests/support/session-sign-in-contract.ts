import type { Shop } from "../browser/shop-fixture.js";
import type { SessionSignInAnswer, SessionSignInBound } from "../../src/runtime/session-sign-in.js";

// The contract any host's re-sign-in (the host side of a script's `ensureSignedIn`) keeps, on the
// controlled shop (`opengpt-browser-engine/testing/shop-fixture`). Each case throws when the host breaks it, so
// any test runner can run it. A host runs every case on a new shop, with a browser it signed in
// to the shop with its own record of the shop's one-screen sign-in (`shopSignIn`), and hands the
// case the page a script holds.

/** The shop's one-screen sign-in, which a host records and replays as its own sign-in. */
export const shopSignIn = {
  /** The sign-in's entry page and only screen. */
  loginPath: "/login",
  username: "input[name=username]",
  password: "input[name=password]",
  submit: "button",
  /** The marker the shop's home, account and orders pages show to a signed-in session. */
  signedIn: "#account",
  /** The page the cases open, whose load the shop can sign out. */
  pagePath: "/orders",
} as const;

/** A host's re-sign-in as a script holds it, on a browser the host signed in to the shop. */
export interface SessionSignInUnderTest {
  /**
   * The host's side of the script's own `ensureSignedIn`, on the page the script holds. The host
   * has already answered the runtime's automatic first call.
   */
  readonly signIn: (bound: SessionSignInBound) => Promise<SessionSignInAnswer>;
  /** Loads `url` on the page the script holds, as the script's own call would. */
  readonly load: (url: string) => Promise<void>;
  /** Whether the page the script holds shows the shop's signed-in marker. */
  readonly signedInHere: () => Promise<boolean>;
  /** The address of the page the script holds. */
  readonly url: () => Promise<string>;
}

export interface SessionSignInContractCase {
  readonly name: string;
  readonly run: (shop: Shop, host: SessionSignInUnderTest) => Promise<void>;
}

const check = (holds: boolean, broken: string, seen?: unknown) => {
  if (!holds)
    throw new Error(
      `Re-sign-in contract broken: ${broken}${seen === undefined ? "" : ` (saw ${JSON.stringify(seen)})`}`,
    );
};

/** A bound the sign-in is well inside. */
const openBound = (): SessionSignInBound => ({
  untilMs: Date.now() + 10 * 60_000,
  stop: new AbortController().signal,
});

/** The shop's page, after a load that signed the browser out. */
const signedOutPage = async (shop: Shop, host: SessionSignInUnderTest) => {
  shop.state.signOutOn = shopSignIn.pagePath;
  await host.load(`${shop.origin}${shopSignIn.pagePath}`);
  check(!(await host.signedInHere()), "the shop's sign-out did not take: the case cannot start");
};

/** What the shop saw of sign-ins: login page loads and login posts. */
const signIns = (shop: Shop) => ({
  pageLoads: shop.state.loginPageLoads,
  posts: shop.state.loginPosts,
});

export const sessionSignInContract: readonly SessionSignInContractCase[] = [
  {
    name: "signs in again on the same page when a page load signed it out, typing the login once",
    run: async (shop, host) => {
      await signedOutPage(shop, host);
      const before = signIns(shop);
      const answer = await host.signIn(openBound());
      check(
        answer.outcome === "signed_in" && answer.signedInAgain,
        "a signed-out page must be signed in again and answered signedInAgain: true",
        answer,
      );
      check(
        shop.state.loginPosts === before.posts + 1,
        "the login must go out exactly once",
        signIns(shop),
      );
      await host.load(`${shop.origin}${shopSignIn.pagePath}`);
      check(
        await host.signedInHere(),
        "the page the script holds must be signed in afterwards, on the same browser",
      );
    },
  },
  {
    name: "answers that it did not sign in again on a page still signed in, and types nothing",
    run: async (shop, host) => {
      await host.load(`${shop.origin}${shopSignIn.pagePath}`);
      check(await host.signedInHere(), "the host's browser must start signed in");
      const before = signIns(shop);
      const where = await host.url();
      const answer = await host.signIn(openBound());
      check(
        answer.outcome === "signed_in" && !answer.signedInAgain,
        "a page still signed in must be answered signedInAgain: false",
        answer,
      );
      const after = signIns(shop);
      check(
        after.posts === before.posts && after.pageLoads === before.pageLoads,
        "nothing may be typed or opened on a page still signed in",
        after,
      );
      check((await host.url()) === where, "the page the script holds must stay where it was");
    },
  },
  {
    name: "types nothing and opens no page once the script's bound passed",
    run: async (shop, host) => {
      await signedOutPage(shop, host);
      const before = signIns(shop);
      const answer = await host.signIn({
        untilMs: Date.now() - 1,
        stop: new AbortController().signal,
      });
      check(answer.outcome === "refused", "a sign-in past its bound must be refused", answer);
      const after = signIns(shop);
      check(
        after.posts === before.posts && after.pageLoads === before.pageLoads,
        "nothing may be typed or opened past the bound",
        after,
      );
    },
  },
  {
    name: "types nothing and opens no page once the script's stop was raised",
    run: async (shop, host) => {
      await signedOutPage(shop, host);
      const before = signIns(shop);
      const stop = new AbortController();
      stop.abort();
      const answer = await host.signIn({ untilMs: Date.now() + 10 * 60_000, stop: stop.signal });
      check(answer.outcome === "refused", "a stopped sign-in must be refused", answer);
      const after = signIns(shop);
      check(
        after.posts === before.posts && after.pageLoads === before.pageLoads,
        "nothing may be typed or opened once stopped",
        after,
      );
    },
  },
  {
    name: "refuses with session_not_kept once its sign-ins are spent, typing no more",
    run: async (shop, host) => {
      for (let attempt = 1; attempt <= 5; attempt++) {
        await signedOutPage(shop, host);
        const before = signIns(shop);
        const answer = await host.signIn(openBound());
        if (answer.outcome === "refused") {
          check(
            answer.cause === "session_not_kept",
            "spent sign-ins must be refused as session_not_kept",
            answer,
          );
          check(shop.state.loginPosts === before.posts, "a spent sign-in may type nothing");
          return;
        }
        check(answer.signedInAgain, "a sign-in within the allowance must sign in again", answer);
      }
      check(false, "a host may make at most four automatic sign-ins in a row");
    },
  },
];
