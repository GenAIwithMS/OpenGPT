import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { initialStoreState, storeProducts, storeRoutes, type StoreState } from "./shop-store.js";

export type { CartLine, PlacedOrder, ShippingAddress, StoreProduct } from "./shop-store.js";
export { storeProducts } from "./shop-store.js";

// The JSON search API serves the home goods, as it did before the storefront had apparel.
const products = storeProducts
  .filter((item) => item.department === "home")
  .map(({ id, name, priceMinor }) => ({ id, name, priceMinor }));
export const shopAccount = { username: "ada@example.test", password: "correct-horse-battery-9" };
/**
 * The accounts the team sign-in, `/team-sign-in`, takes, by their team: it sends each account on
 * to its own team's password screen, `/team/<team>/password`.
 */
export const teamAccounts = {
  a: shopAccount,
  b: { username: "dana@example.test", password: "river-lamp-quiet-4" },
} as const;
/** The code the shop asks for after the one-screen sign-in, when `loginCode` is set. */
export const shopCode = "482913";
/** How many help links the two-screen sign-in's password screen shows besides its 4 controls. */
export const shopHelpLinks = 40;
/**
 * A host on another site, whose identity service the shop's script sign-ins, `/identity-login` and
 * the identifier-first `/identity-steps`, send the login to. A browser maps it to the shop's
 * server, which answers it on the same port.
 */
export const identityHost = "accounts.identity.test";
/**
 * A host on a third site, whose analytics service `/identity-steps?analytics=on` tells the
 * identifier screen's email to, as a marketing tag does. A browser maps it to the shop's server.
 */
export const analyticsHost = "collect.analytics.test";
/** The workspaces the account belongs to, which `workspaceChooser` offers after the sign-in. */
export const shopWorkspaces = ["North Street", "Harbor"] as const;
/** An account the shop has locked: it answers 423 whatever the password. */
export const lockedShopAccount = {
  username: "grace@example.test",
  password: "locked-horse-battery-7",
};

/** Counters and switches for one controlled shop, with its storefront's carts and orders. */
interface ShopState extends StoreState {
  searchPageLoads: number;
  /** Loads of the code screen, by GET, that `loginCode` puts after the one-screen sign-in. */
  codePageLoads: number;
  /** Codes posted to the code screen. */
  codePosts: number;
  /** Whether each code posted to the code screen was `code`, whole, in order. */
  codeMatches: boolean[];
  apiRequests: number;
  curlApiRequests: number;
  cartPosts: number;
  loginPosts: number;
  /** Loads of the one-screen sign-in's page, `/login`, by GET. */
  loginPageLoads: number;
  /** Posts to the two-screen sign-in's session endpoint, whatever they carry. */
  sessionPosts: number;
  /** Posts of a login to the identity service on `identityHost`, its preflights left out. */
  identityPosts: number;
  /** Posts to the analytics service on `analyticsHost`, its preflights left out. */
  analyticsPosts: number;
  /** The notes the signed-in account saved on `/account/note`, in order. */
  accountNotes: string[];
  /** The HTTP version's contract: `error` and `changed` break it for curl traffic only. */
  api: "ok" | "error" | "changed";
  /** `refuse` makes the modeled Kernel curl fail before sending anything. */
  curl: "ok" | "refuse";
  /** `after_input` keeps the sign-in button disabled until both fields hold input. */
  loginSubmit: "enabled" | "after_input";
  /**
   * Whether the one-screen sign-in shows an error under its form, `#login-error`, once the shop
   * refused its login, as a recipe's rejection marker names it.
   */
  loginError: boolean;
  /**
   * The root page: `broken` drops its connection, so it never loads, and `hang` shows an image
   * whose request never answers, so its load never ends. `late` is an empty shell whose script
   * renders a header with an "Account" link, signed out too, `homeRenderMs` after it runs, and
   * `splash` is the same shell showing "Loading…" until then. `ticking` is the splash with a
   * counter beside it that changes every 200 ms and never stops, so the root never goes 1.5
   * seconds without a change.
   */
  home: "ok" | "broken" | "hang" | "late" | "splash" | "ticking";
  homeRenderMs: number;
  /**
   * How long after it runs the account page's script draws the account's element for a signed-in
   * session, as a client-rendered page does; 0 sends the element with the page.
   */
  accountRenderMs: number;
  /**
   * Whether the one-screen sign-in asks for `code` on a code screen, `/two-factor`, before it
   * signs the browser in. The screen's form posts the code back to it.
   */
  loginCode: boolean;
  /**
   * Whether the code screen's form has no button, so it submits only when Enter is pressed in its
   * one field, as the browser submits a form of one text field.
   */
  codeSubmitsOnEnter: boolean;
  /**
   * How many one-character boxes the code screen splits `code` across, one digit each, named
   * `code-1` onward, under a Verify button; 0 for its one code field. Each box moves the focus to
   * the next once it holds a digit, as such widgets do.
   */
  codeBoxes: number;
  /**
   * How each code box takes one character: `maxlength` by its `maxlength="1"`, `script` by the
   * widget's own script, as many one-time-code widgets do. A `script` box is a `tel` input with no
   * `maxlength`, drawn see-through over its digit; the widget keeps one character in each box,
   * spreads a code typed or pasted into one box across it and the boxes after it, and keeps the
   * whole code in a hidden field beside the boxes.
   */
  codeBoxLimit: "maxlength" | "script";
  /** The code the code screen takes: `shopCode`, or a longer one split across more boxes. */
  code: string;
  /**
   * What the one-screen sign-in shows a signed-in session: `form` its form, as any session sees
   * it, `account` a redirect to the account page, as many sites answer a signed-in visit (to the
   * workspace picker while `workspaceChooser` is on).
   */
  signedInLogin: "form" | "account";
  /**
   * Whether a signed-in session picks one of `shopWorkspaces` on `/choose-workspace` before the
   * account page shows the account: the sign-in lands there, and the page shows neither the
   * account nor a sign-in form, as an account or workspace picker does.
   */
  workspaceChooser: boolean;
  /**
   * Whether a signed-out visit to the orders or statements shows the sign-in form there, or only
   * a "Please sign in" notice, which shows neither the marker nor a form.
   */
  signedOutShowsForm: boolean;
  /**
   * A path whose next load by a signed-in browser signs it out, as a site that keeps its session
   * in the page does on a full load: that load expires the session cookie and shows the signed-out
   * page. Cleared once used. Only for a page that sets no cookie of its own, such as `/orders`.
   */
  signOutOn: string | undefined;
  /** The account's statements, in the order `/statements` lists them, 30 to a page. */
  statements: string[];
  /** Each load of `/statements`: the page asked for and whether the browser was signed in. */
  statementLoads: { readonly page: number; readonly signedIn: boolean }[];
  /** The team of each account the team sign-in signed in, in order. */
  teamSignIns: string[];
  /**
   * How many redirects the two-screen sign-in's session post goes through before the account page,
   * each answered `sessionHopMs` after it arrives, as a slow network makes a sign-in's redirects
   * after the site answered its post. 0 sends the post straight on to the account page.
   */
  sessionHops: number;
  sessionHopMs: number;
}

export interface Shop {
  readonly origin: string;
  readonly hostname: string;
  readonly port: number;
  readonly state: ShopState;
  readonly sessionValue: string;
  readonly csrfValue: string;
  /** The session cookie's value once signed in. */
  readonly signedInValue: string;
  readonly close: () => Promise<void>;
}

const html = (response: ServerResponse, body: string, headers: Record<string, string[]> = {}) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", ...headers });
  response.end(body);
};
const json = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};
const readBody = (request: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      text += chunk;
    });
    request.on("end", () => resolve(text));
    request.on("error", reject);
  });
const cookieOf = (request: IncomingMessage, name: string) =>
  new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(request.headers.cookie ?? "")?.[1];

type Route = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

/** The values one shop issues: its session, CSRF token and signed-in session. */
interface ShopSecrets {
  readonly sessionValue: string;
  readonly csrfValue: string;
  readonly signedIn: string;
  /** A sign-in that sent the password and waits for its code. */
  readonly pending: string;
  /** The token the identity service issues for the shop's account. */
  readonly identityToken: string;
}

/** A sign-in body's username and password, when it is an object that carries them. */
const credentialsOf = (text: string) => {
  const body: unknown = JSON.parse(text || "null");
  if (typeof body !== "object" || body === null) return {};
  return {
    username: "username" in body ? body.username : undefined,
    password: "password" in body ? body.password : undefined,
  };
};

const postOnly =
  (route: Route): Route =>
  (request, response) =>
    request.method === "POST" ? route(request, response) : json(response, 404, {});

/** The shop's routes by path; any other path answers 404. */
const shopRoutes = (
  state: ShopState,
  secrets: ShopSecrets,
  hanging: ServerResponse[],
): ReadonlyMap<string, Route> => {
  const { sessionValue, csrfValue, signedIn, pending, identityToken } = secrets;
  const sessionCookies = [
    `shop_session=${sessionValue}; Path=/; Secure; HttpOnly; SameSite=Lax`,
    `csrf_token=${csrfValue}; Path=/; Secure; SameSite=Lax`,
  ];
  // A page load keeps a signed-in session; a signed-out browser gets a fresh one.
  const cookiesFor = (request: IncomingMessage) =>
    cookieOf(request, "shop_session") === signedIn ? sessionCookies.slice(1) : sessionCookies;
  const lateHome = (shell: string, ticking: boolean) => `<title>Shop</title><div id="app">${shell}</div>${ticking ? `<p id="tick">0</p>` : ""}
<script>setTimeout(()=>{document.querySelector('#app').innerHTML='<nav><a id="account" href="/login">Account</a></nav>'},${state.homeRenderMs})${ticking ? `;let ticks=0;setInterval(()=>{document.querySelector('#tick').textContent=String(++ticks)},200)` : ""}</script>`;
  // The plain home shows the account link, the shop's signed-in marker, to a signed-in session.
  const home: Route = (request, response) => {
    if (state.home === "broken") return void response.destroy();
    if (state.home === "late" || state.home === "splash" || state.home === "ticking")
      return html(
        response,
        lateHome(state.home === "late" ? "" : "<p>Loading…</p>", state.home === "ticking"),
        { "set-cookie": cookiesFor(request) },
      );
    return html(
      response,
      `<title>Shop</title><meta name="csrf-token" content="${csrfValue}"><a href='/login'>Sign in</a>${cookieOf(request, "shop_session") === signedIn ? `<a id="account" href="/account">Account</a>` : ""}
<button id="add">Add to cart</button><p id="added"></p>
<script>document.querySelector('#add').addEventListener('click',async()=>{const token=document.querySelector('meta[name=csrf-token]').content;const response=await fetch('/api/cart',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':token},body:JSON.stringify({productId:'p-1'})});const data=await response.json();document.querySelector('#added').textContent=data.cartId??'refused'})</script>${state.home === "hang" ? `<img src="/hang" alt="">` : ""}`,
      { "set-cookie": cookiesFor(request) },
    );
  };
  // A request that never answers, until the shop closes.
  const hang: Route = (_request, response) => {
    hanging.push(response);
  };
  const search: Route = (request, response) => {
    state.searchPageLoads += 1;
    html(
      response,
      `<title>Search</title><ul id="results"></ul><script>
fetch('/api/products?q='+encodeURIComponent(new URLSearchParams(location.search).get('q')),{headers:{accept:'application/json'}})
.then(r=>r.json()).then(data=>{for(const item of data.items){const li=document.createElement('li');li.dataset.id=item.id;li.dataset.name=item.name;li.dataset.price=String(item.priceMinor);li.textContent=item.name;document.querySelector('#results').append(li)}});
</script>`,
      { "set-cookie": cookiesFor(request) },
    );
  };
  const productsApi: Route = (request, response) => {
    const curl = request.headers["x-modeled-transport"] === "kernel-curl";
    const session = cookieOf(request, "shop_session");
    state.apiRequests += 1;
    if (curl) state.curlApiRequests += 1;
    if (session !== sessionValue && session !== signedIn)
      return json(response, 401, { error: "signed out" });
    if (curl && state.api === "error") return json(response, 500, {});
    if (curl && state.api === "changed")
      return json(response, 200, {
        items: products.map((item) => ({ ...item, priceMinor: String(item.priceMinor) })),
      });
    return json(response, 200, { items: products });
  };
  const cart: Route = async (request, response) => {
    state.cartPosts += 1;
    await readBody(request);
    const token = request.headers["x-csrf-token"];
    if (token !== cookieOf(request, "csrf_token") || token === undefined)
      return json(response, 403, { error: "csrf" });
    return json(response, 200, { cartId: "c-9" });
  };
  const loginPage: Route = (request, response) => {
    state.loginPageLoads += 1;
    if (state.signedInLogin === "account" && cookieOf(request, "shop_session") === signedIn) {
      // With the workspace picker on, a signed-in visit lands on the picker, as the sign-in does.
      response.writeHead(303, { location: state.workspaceChooser ? "/choose-workspace" : "/account" });
      return void response.end();
    }
    return html(
      response,
      `<title>Sign in</title><form id="login"><input name="username"><input name="password" type="password"><button${state.loginSubmit === "after_input" ? " disabled" : ""}>Sign in</button></form>${state.loginError ? `<p id="login-error" hidden>Wrong username or password</p>` : ""}
<script>const csrf=document.cookie.match(/csrf_token=([^;]*)/)?.[1]??'';</script>${
        state.loginSubmit === "after_input"
          ? `
<script>const form=document.querySelector('#login');form.addEventListener('input',()=>{form.querySelector('button').disabled=!(form.username.value&&form.password.value)})</script>`
          : ""
      }
<script>document.querySelector('#login').addEventListener('submit',async event=>{event.preventDefault();const form=new FormData(event.target);const response=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({username:form.get('username'),password:form.get('password')})});if(response.ok)location.href=(await response.json()).next??'/account';${state.loginError ? `else document.querySelector('#login-error').hidden=false;` : ""}})</script>`,
      { "set-cookie": cookiesFor(request) },
    );
  };
  const login: Route = async (request, response) => {
    state.loginPosts += 1;
    const text = await readBody(request);
    const token = request.headers["x-csrf-token"];
    if (token === undefined || token !== cookieOf(request, "csrf_token"))
      return json(response, 403, { error: "csrf" });
    const submitted = credentialsOf(text);
    if (submitted.username === lockedShopAccount.username)
      return json(response, 423, { error: "account locked" });
    const matches =
      submitted.username === shopAccount.username && submitted.password === shopAccount.password;
    if (!matches) return json(response, 401, { error: "invalid credentials" });
    response.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": [
        state.loginCode
          ? `shop_pending=${pending}; Path=/; Secure; HttpOnly; SameSite=Lax`
          : `shop_session=${signedIn}; Path=/; Secure; HttpOnly; SameSite=Lax`,
      ],
    });
    response.end(
      JSON.stringify(
        state.loginCode
          ? { ok: true, next: "/two-factor" }
          : state.workspaceChooser
            ? { ok: true, next: "/choose-workspace" }
            : { ok: true },
      ),
    );
  };
  // The code screen: a GET shows its form, and the form's post with the code signs in. A wrong
  // code shows the form again under the error.
  const codeBoxes = () =>
    Array.from({ length: state.codeBoxes }, (_, at) => at + 1);
  const maxlengthBoxes = () =>
    `<form method="post" action="/two-factor"><p>Enter the code we sent you</p><div class="code">${codeBoxes()
      .map(
        (box) =>
          `<input id="code-${box}" name="code-${box}" maxlength="1" inputmode="numeric" aria-label="Digit ${box} of ${state.codeBoxes}"${box === 1 ? ' autocomplete="one-time-code"' : ""}>`,
      )
      .join("")}</div><button>Verify</button></form>
<script>
const boxes = [...document.querySelectorAll(".code input")];
boxes.forEach((box, at) => box.addEventListener("input", () => {
  if (box.value !== "" && boxes[at + 1]) boxes[at + 1].focus();
}));
</script>`;
  const scriptBoxes = () =>
    `<style>.code{position:relative;display:flex;gap:4px}.code input{width:32px;height:40px;opacity:0;margin:0;padding:0;border:0}.drawn{position:absolute;inset:0;display:flex;gap:4px;pointer-events:none}.drawn span{width:32px;height:40px;border:1px solid #888;box-sizing:border-box;text-align:center;line-height:40px}</style>
<form method="post" action="/two-factor"><p>Enter the code we sent you</p><div class="code"><input type="hidden" name="code">${codeBoxes()
      .map(
        (box) =>
          `<input id="code-${box}" name="code-${box}" type="tel" class="digit" inputmode="numeric" autocomplete="one-time-code" aria-label="Digit ${box} of ${state.codeBoxes}">`,
      )
      .join("")}<div class="drawn" aria-hidden="true">${codeBoxes()
      .map(() => "<span></span>")
      .join("")}</div></div><button>Verify</button></form>
<script>
const boxes = [...document.querySelectorAll(".code input.digit")];
const drawn = [...document.querySelectorAll(".drawn span")];
const whole = document.querySelector('.code input[type="hidden"]');
boxes.forEach((box, at) => box.addEventListener("input", () => {
  const typed = box.value.replace(/[^0-9]/g, "");
  const spread = typed.length > 1 ? [...typed].slice(0, boxes.length - at) : [typed.slice(-1)];
  spread.forEach((digit, offset) => { boxes[at + offset].value = digit; });
  const next = boxes[at + spread.length];
  if (typed !== "") (next ?? boxes[at + spread.length - 1]).focus();
  boxes.forEach((each, index) => { drawn[index].textContent = each.value; });
  whole.value = boxes.map((each) => each.value).join("");
}));
</script>`;
  const codeForm = () =>
    state.codeBoxes > 0
      ? state.codeBoxLimit === "maxlength"
        ? maxlengthBoxes()
        : scriptBoxes()
      : `<form method="post" action="/two-factor"><label>Code<input name="code" autocomplete="one-time-code"></label>${state.codeSubmitsOnEnter ? "" : "<button>Verify</button>"}</form>`;
  const twoFactor: Route = async (request, response) => {
    if (request.method !== "POST") {
      state.codePageLoads += 1;
      return html(response, `<title>Code</title>${codeForm()}`);
    }
    state.codePosts += 1;
    const posted = new URLSearchParams(await readBody(request));
    const code =
      state.codeBoxes > 0
        ? codeBoxes()
            .map((box) => posted.get(`code-${box}`) ?? "")
            .join("")
        : posted.get("code");
    state.codeMatches.push(code === state.code);
    if (code !== state.code || cookieOf(request, "shop_pending") !== pending)
      return html(response, `<title>Code</title><p id='wrong-code'>Wrong code</p>${codeForm()}`);
    response.writeHead(303, {
      location: state.workspaceChooser ? "/choose-workspace" : "/account",
      "set-cookie": [`shop_session=${signedIn}; Path=/; Secure; HttpOnly; SameSite=Lax`],
    });
    response.end();
  };
  // The workspace picker: a signed-in session picks a workspace, which the account page then shows.
  const workspaceOf = (request: IncomingMessage) => {
    const picked = decodeURIComponent(cookieOf(request, "shop_workspace") ?? "");
    return shopWorkspaces.find((workspace) => workspace === picked);
  };
  const chooseWorkspace: Route = async (request, response) => {
    if (cookieOf(request, "shop_session") !== signedIn)
      return html(response, "<title>Workspace</title><p id='signed-out'>Please sign in</p>");
    if (request.method !== "POST")
      return html(
        response,
        `<title>Choose a workspace</title><h1>Choose a workspace</h1><form method="post" action="/choose-workspace">${shopWorkspaces.map((workspace) => `<button name="workspace" value="${workspace}">${workspace}</button>`).join("")}</form>`,
      );
    const workspace = new URLSearchParams(await readBody(request)).get("workspace") ?? "";
    response.writeHead(303, {
      location: "/account",
      "set-cookie": [
        `shop_workspace=${encodeURIComponent(workspace)}; Path=/; Secure; HttpOnly; SameSite=Lax`,
      ],
    });
    response.end();
  };
  const account: Route = (request, response) =>
    html(
      response,
      cookieOf(request, "shop_session") !== signedIn
        ? "<title>Account</title><p id='signed-out'>Please sign in</p>"
        : state.workspaceChooser && workspaceOf(request) === undefined
          ? "<title>Account</title><a href='/choose-workspace'>Choose a workspace</a>"
          : state.workspaceChooser
            ? `<title>Account</title><p id="account">${shopAccount.username}</p><p id="workspace">${workspaceOf(request) ?? ""}</p>`
            : state.accountRenderMs === 0
          ? `<title>Account</title><p id="account">${shopAccount.username}</p>`
          : `<title>Account</title><main id="app"></main>
<script>setTimeout(()=>{const account=document.createElement('p');account.id='account';account.textContent=${JSON.stringify(shopAccount.username)};document.querySelector('#app').append(account)},${state.accountRenderMs})</script>`,
    );
  // A signed-out visit to a page behind the session shows the one-screen sign-in's form there,
  // which is how a host tells the page signed out rather than one without the marker.
  const signedOutNotice = (title: string) =>
    `<title>${title}</title><p id='signed-out'>Please sign in</p>${state.signedOutShowsForm ? `<form action="/login"><input name="username"><input name="password" type="password"><button>Sign in</button></form>` : ""}`;
  // The account's orders, behind the same session as its account page.
  const orders: Route = (request, response) =>
    html(
      response,
      cookieOf(request, "shop_session") === signedIn
        ? `<title>Orders</title><p id="account">${shopAccount.username}</p><p id="orders">2 orders</p>`
        : signedOutNotice("Orders"),
    );
  // The account's statements, 30 to a page with a Next link, behind the same session.
  const statements: Route = (request, response) => {
    const url = new URL(request.url ?? "/", "https://www.shop.test");
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
    const signedInNow = cookieOf(request, "shop_session") === signedIn;
    state.statementLoads.push({ page, signedIn: signedInNow });
    if (!signedInNow) return html(response, signedOutNotice("Statements"));
    const rows = state.statements.slice((page - 1) * 30, page * 30);
    const next = page * 30 < state.statements.length ? `/statements?page=${page + 1}` : null;
    return html(
      response,
      `<title>Statements</title><p id="account">${shopAccount.username}</p>
<ol id="statements">${rows.map((id) => `<li data-id="${id}">Statement ${id}</li>`).join("")}</ol>
${next === null ? "" : `<a rel="next" href="${next}">Next</a>`}`,
    );
  };
  // The sign-in's query goes on to the password screen: `hidden=N` puts N hidden text fields
  // ahead of its own field, `pad=N` puts N spaces ahead of the identifier its label echoes in
  // place of "Password for", `tag` marks its help links, so a test finds its own screen,
  // `echo=none` shows the identifier only in the hidden field, `stash=password` puts the
  // account's password in its form's action, as page code that kept a typed value could, and
  // `alert=1` shows an error naming the typed identifier beside a hidden one, and `alert=class` an
  // error known only by its class and id.
  const queryOf = (request: IncomingMessage) =>
    new URL(request.url ?? "/", "https://www.shop.test").searchParams;
  const identifierScreen: Route = (request, response) =>
    html(
      response,
      `<title>Sign in</title><form method="post" action="/sign-in/password?${queryOf(request).toString()}"><label>Email<input id="username" name="username" type="email" autocomplete="username"></label><button id="next">Next</button></form>`,
    );
  // The next screen echoes the typed identifier in its text, a label, a placeholder and a hidden
  // field. Loaded directly, it is a password-only screen with no identifier.
  const passwordScreen: Route = async (request, response) => {
    const typed =
      request.method === "POST"
        ? (new URLSearchParams(await readBody(request)).get("username") ?? "")
        : "";
    const links = Array.from(
      { length: shopHelpLinks },
      (_, index) => `<a href="/help/${index}">Help topic ${index} ${queryOf(request).get("tag") ?? ""}</a>`,
    ).join("");
    const pad = Number(queryOf(request).get("pad") ?? 0);
    const echo = queryOf(request).get("echo") !== "none";
    const label = !echo ? "Password" : pad > 0 ? `${" ".repeat(pad)}${typed}` : `Password for ${typed}`;
    const hidden = Array.from(
      { length: Number(queryOf(request).get("hidden") ?? 0) },
      (_, index) => `<input name="extra${index}" style="display:none">`,
    ).join("");
    const alerts: Readonly<Record<string, string>> = {
      "1": `<div role="alert">Check the password for ${typed}</div><p class="error-message" style="display:none">Hidden error</p>`,
      class: `<div id="login_error" class="login_form__error">Check the password for ${typed}</div>`,
    };
    const alert = alerts[queryOf(request).get("alert") ?? ""] ?? "";
    const action =
      queryOf(request).get("stash") === "password"
        ? `/sign-in/session?next=${encodeURIComponent(shopAccount.password)}`
        : "/sign-in/session";
    html(
      response,
      `<title>Password</title>${echo ? `<p>Signing in as ${typed}</p>` : ""}${alert}<form method="post" action="${action}"><input type="hidden" name="user" value="${typed}">${hidden}<label>${label}<input id="password" name="password" type="password" required placeholder="${echo ? typed : ""}"></label><input id="otp" style="display:none" aria-label="Code"><button id="sign-in">Sign in</button><button id="trouble" disabled>Trouble signing in</button></form><nav>${links}</nav>`,
    );
  };
  // The password screen's form posts here: the shop's account signs in, any other is refused.
  const passwordSession: Route = async (request, response) => {
    state.sessionPosts += 1;
    const form = new URLSearchParams(await readBody(request));
    if (form.get("user") !== shopAccount.username || form.get("password") !== shopAccount.password)
      return html(response, "<title>Password</title><p id='wrong-password'>Wrong password</p>");
    response.writeHead(state.sessionHops > 0 ? 302 : 303, {
      location: state.sessionHops > 0 ? `/sign-in/continue?hop=1` : "/account",
      "set-cookie": [`shop_session=${signedIn}; Path=/; Secure; HttpOnly; SameSite=Lax`],
    });
    response.end();
  };
  // Each redirect after the session post, while `sessionHops` asks for them.
  const sessionHop: Route = async (request, response) => {
    const hop = Number(queryOf(request).get("hop") ?? 0);
    await new Promise((resolve) => setTimeout(resolve, state.sessionHopMs));
    response.writeHead(302, {
      location: hop < state.sessionHops ? `/sign-in/continue?hop=${hop + 1}` : "/account",
    });
    response.end();
  };
  // The team sign-in's identifier screen, which sends a known account on to its team's password
  // screen, and that screen, which signs in its team's account.
  const teamSignIn: Route = async (request, response) => {
    if (request.method !== "POST")
      return html(
        response,
        `<title>Sign in</title><form method="post" action="/team-sign-in"><label>Email<input id="username" name="username" type="email" autocomplete="username"></label><button id="next">Next</button></form>`,
      );
    const username = new URLSearchParams(await readBody(request)).get("username");
    const team = Object.entries(teamAccounts).find(([, account]) => account.username === username);
    if (team === undefined) return html(response, "<title>Sign in</title><p>No such account</p>");
    response.writeHead(303, { location: `/team/${team[0]}/password` });
    response.end();
  };
  const teamPassword: Route = async (request, response) => {
    const team = new URL(request.url ?? "/", "https://www.shop.test").pathname.split("/")[2] ?? "";
    if (request.method !== "POST")
      return html(
        response,
        `<title>Password</title><form method="post"><label>Password<input id="password" name="password" type="password" autocomplete="current-password"></label><button id="sign-in">Sign in</button></form>`,
      );
    const password = new URLSearchParams(await readBody(request)).get("password");
    if (Object.entries(teamAccounts).every(([at, account]) => at !== team || account.password !== password))
      return html(response, "<title>Password</title><p id='wrong-password'>Wrong password</p>");
    state.teamSignIns.push(team);
    response.writeHead(303, {
      location: "/account",
      "set-cookie": [`shop_session=${signedIn}; Path=/; Secure; HttpOnly; SameSite=Lax`],
    });
    response.end();
  };
  // A sign-in whose script sends the login to an identity service on another site, then trades the
  // token it returns for the shop's session, as a single-page site on a hosted identity service
  // does. The form has no action and the shop's own origin never receives the password.
  const identityLogin: Route = (request, response) =>
    html(
      response,
      `<title>Sign in</title><form id="login"><label>Email<input name="username" type="email" autocomplete="username"></label><label>Password<input name="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form>
<script>const identity='https://${identityHost}:'+location.port;document.querySelector('#login').addEventListener('submit',async event=>{event.preventDefault();const form=new FormData(event.target);const signedIn=await fetch(identity+'/v1/sign-in?key=public',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:form.get('username'),password:form.get('password')})});if(!signedIn.ok)return;const {idToken}=await signedIn.json();const session=await fetch('/api/identity-session',{method:'POST',headers:{authorization:'Bearer '+idToken}});if(session.ok)location.href='/account'})</script>`,
      { "set-cookie": cookiesFor(request) },
    );
  /** A JSON post's field `key`, or undefined. */
  const field = (body: unknown, key: string) =>
    typeof body === "object" && body !== null && key in body
      ? (body as Readonly<Record<string, unknown>>)[key]
      : undefined;
  // The handle the identity service gives an identifier-first sign-in between its two screens.
  const identityState = `state-${identityToken.slice(4)}`;
  /**
   * An identity service endpoint: it answers its own preflight, and a JSON post with what
   * `answer` gives for its body, or a 400 when that is nothing.
   */
  const identityEndpoint =
    (answer: (body: unknown) => object | undefined): Route =>
    async (request, response) => {
      const cors = {
        "access-control-allow-origin": request.headers.origin ?? "*",
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "POST",
      };
      if (request.method === "OPTIONS") {
        response.writeHead(204, cors);
        return void response.end();
      }
      if (request.method !== "POST") return json(response, 404, {});
      state.identityPosts += 1;
      const answered = answer(JSON.parse((await readBody(request)) || "null"));
      response.writeHead(answered === undefined ? 400 : 200, {
        "content-type": "application/json",
        ...cors,
      });
      response.end(JSON.stringify(answered ?? { error: "invalid login" }));
    };
  // A token for the shop's account, for the whole login at once.
  const identitySignIn = identityEndpoint((body) =>
    field(body, "email") === shopAccount.username &&
    field(body, "password") === shopAccount.password
      ? { idToken: identityToken }
      : undefined,
  );
  // An identifier-first sign-in's first screen: the identifier alone, for a state handle.
  const identityIdentify = identityEndpoint((body) =>
    field(body, "identifier") === shopAccount.username ? { stateHandle: identityState } : undefined,
  );
  /** Whether a second screen's post carries the state handle and the account's password. */
  const answersChallenge = (body: unknown) =>
    field(body, "stateHandle") === identityState &&
    field(body, "password") === shopAccount.password;
  // Its second screen: the password alone with the state handle, for a token.
  const identityChallenge = identityEndpoint((body) =>
    answersChallenge(body) ? { idToken: identityToken } : undefined,
  );
  // The shop's own end of a second screen that posts the password to the site instead, with the
  // state handle and without the identifier: the shop's session.
  const identityPassword: Route = async (request, response) => {
    if (!answersChallenge(JSON.parse((await readBody(request)) || "null")))
      return json(response, 401, { error: "invalid login" });
    response.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": [`shop_session=${signedIn}; Path=/; Secure; HttpOnly; SameSite=Lax`],
    });
    response.end(JSON.stringify({ ok: true }));
  };
  // An analytics service that takes any JSON post, as a marketing tag's collector does. It answers
  // its own preflight and signs nobody in.
  const analyticsCollect: Route = async (request, response) => {
    const cors = {
      "access-control-allow-origin": request.headers.origin ?? "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "POST",
    };
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      return void response.end();
    }
    if (request.method !== "POST") return json(response, 404, {});
    state.analyticsPosts += 1;
    await readBody(request);
    response.writeHead(204, cors);
    response.end();
  };
  // An identifier-first sign-in on one page, as an embedded identity widget runs it: its first
  // screen sends the identifier to the identity service and shows the second, whose password goes
  // there too, or with `?password=site` to the shop, each with the state handle. With
  // `?analytics=on` the first screen also sends the email to the analytics service.
  const identitySteps: Route = (request, response) =>
    html(
      response,
      `<title>Sign in</title><form id="identify"><label>Email<input name="username" type="email" autocomplete="username"></label><button id="next">Next</button></form><form id="challenge" hidden><label>Password<input name="password" type="password" autocomplete="current-password"></label><button id="verify">Sign in</button></form>
<script>const identity='https://${identityHost}:'+location.port;const query=new URLSearchParams(location.search);const toSite=query.get('password')==='site';const analytics=query.get('analytics')==='on'?'https://${analyticsHost}:'+location.port:'';let stateHandle='';const post=(url,body)=>fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});document.querySelector('#identify').addEventListener('submit',async event=>{event.preventDefault();const email=new FormData(event.target).get('username');const [identified]=await Promise.all([post(identity+'/v1/identify',{identifier:email}),...(analytics?[post(analytics+'/v1/collect',{event:'identify',email})]:[])]);if(!identified.ok)return;({stateHandle}=await identified.json());event.target.hidden=true;document.querySelector('#challenge').hidden=false});document.querySelector('#challenge').addEventListener('submit',async event=>{event.preventDefault();const answer={stateHandle,password:new FormData(event.target).get('password')};if(toSite){if((await post('/api/identity-password',answer)).ok)location.href='/account';return}const answered=await post(identity+'/v1/challenge',answer);if(!answered.ok)return;const {idToken}=await answered.json();const session=await fetch('/api/identity-session',{method:'POST',headers:{authorization:'Bearer '+idToken}});if(session.ok)location.href='/account'})</script>`,
      { "set-cookie": cookiesFor(request) },
    );
  // Trades the identity service's token for the shop's session. It never sees the password.
  const identitySession: Route = (request, response) => {
    if (request.headers.authorization !== `Bearer ${identityToken}`)
      return json(response, 401, { error: "invalid token" });
    response.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": [`shop_session=${signedIn}; Path=/; Secure; HttpOnly; SameSite=Lax`],
    });
    response.end(JSON.stringify({ ok: true }));
  };
  // The account's note: a signed-out visit goes to the identity sign-in, a signed-in post saves it.
  const accountNote: Route = async (request, response) => {
    if (cookieOf(request, "shop_session") !== signedIn) {
      response.writeHead(303, { location: "/identity-login" });
      return void response.end();
    }
    if (request.method === "POST") {
      state.accountNotes.push(new URLSearchParams(await readBody(request)).get("note") ?? "");
      return html(response, `<title>Note</title><p id="saved">Saved</p>`);
    }
    return html(
      response,
      `<title>Note</title><p id="account">${shopAccount.username}</p><form method="post" action="/account/note"><label>Note<input id="note" name="note"></label><button id="save">Save</button></form>`,
    );
  };
  return new Map([
    ...storeRoutes({
      state,
      signedIn: (request) => cookieOf(request, "shop_session") === signedIn,
      cookiesFor,
      csrfOf: (request) => cookieOf(request, "csrf_token"),
    }),
    ["/", home],
    ["/sign-in", identifierScreen],
    ["/sign-in/password", passwordScreen],
    ["/sign-in/session", postOnly(passwordSession)],
    ["/sign-in/continue", sessionHop],
    ["/team-sign-in", teamSignIn],
    ["/team/*/password", teamPassword],
    ["/search", search],
    ["/api/products", productsApi],
    ["/api/cart", postOnly(cart)],
    ["/login", loginPage],
    ["/api/login", postOnly(login)],
    ["/account", account],
    ["/orders", orders],
    ["/statements", statements],
    ["/two-factor", twoFactor],
    ["/choose-workspace", chooseWorkspace],
    ["/hang", hang],
    ["/identity-login", identityLogin],
    ["/v1/sign-in", identitySignIn],
    ["/identity-steps", identitySteps],
    ["/v1/identify", identityIdentify],
    ["/v1/challenge", identityChallenge],
    ["/api/identity-password", postOnly(identityPassword)],
    ["/api/identity-session", postOnly(identitySession)],
    ["/v1/collect", analyticsCollect],
    ["/account/note", accountNote],
  ]);
};

/**
 * A controlled HTTPS shop: an HTML search page whose script calls a cookie-gated JSON API, a
 * CSRF-protected cart POST, a JSON sign-in endpoint, and a storefront (`shop-store.ts`) with
 * filtered catalog search, product options, guest and account carts, and checkout. The modeled curl marks its requests with
 * `x-modeled-transport`, which a real site cannot see, so the fixture can count them.
 */
export const startShop = async (directory: string): Promise<Shop> => {
  await promisify(execFile)("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(directory, "key.pem"),
    "-out",
    join(directory, "cert.pem"),
    "-subj",
    "/CN=www.shop.test",
    "-days",
    "1",
  ]);
  const state: ShopState = {
    searchPageLoads: 0,
    codePageLoads: 0,
    codePosts: 0,
    codeMatches: [],
    apiRequests: 0,
    curlApiRequests: 0,
    cartPosts: 0,
    loginPosts: 0,
    loginPageLoads: 0,
    sessionPosts: 0,
    identityPosts: 0,
    analyticsPosts: 0,
    accountNotes: [],
    api: "ok",
    curl: "ok",
    loginSubmit: "enabled",
    loginError: false,
    home: "ok",
    homeRenderMs: 300,
    accountRenderMs: 0,
    loginCode: false,
    codeSubmitsOnEnter: false,
    codeBoxes: 0,
    codeBoxLimit: "maxlength",
    code: shopCode,
    signedInLogin: "form",
    workspaceChooser: false,
    signedOutShowsForm: true,
    signOutOn: undefined,
    statements: Array.from({ length: 45 }, (_, index) => `S${index + 1}`),
    statementLoads: [],
    teamSignIns: [],
    sessionHops: 0,
    sessionHopMs: 0,
    ...initialStoreState(),
  };
  const sessionValue = `sess-${randomBytes(12).toString("hex")}`;
  const csrfValue = `csrf-${randomBytes(12).toString("hex")}`;
  const signedIn = `acct-${randomBytes(12).toString("hex")}`;
  const pending = `pend-${randomBytes(12).toString("hex")}`;
  const identityToken = `idt-${randomBytes(12).toString("hex")}`;
  const hanging: ServerResponse[] = [];
  const routes = shopRoutes(
    state,
    { sessionValue, csrfValue, signedIn, pending, identityToken },
    hanging,
  );
  const notFound: Route = (_request, response) => json(response, 404, {});
  const server = createServer(
    {
      key: await readFile(join(directory, "key.pem")),
      cert: await readFile(join(directory, "cert.pem")),
    },
    (request, response) => {
      void (async () => {
        const url = new URL(request.url ?? "/", "https://www.shop.test");
        if (state.signOutOn === url.pathname && cookieOf(request, "shop_session") === signedIn) {
          state.signOutOn = undefined;
          response.setHeader("set-cookie", "shop_session=; Path=/; Max-Age=0; Secure; HttpOnly");
          request.headers.cookie = (request.headers.cookie ?? "").replace(
            /(?:^|;\s*)shop_session=[^;]*/u,
            "",
          );
        }
        const route = url.pathname.replace(/^\/team\/[^/]+\/password$/u, "/team/*/password");
        await (routes.get(route) ?? notFound)(request, response);
      })().catch(() => {
        response.destroy();
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing shop port");
  return {
    origin: `https://www.shop.test:${address.port}`,
    hostname: "www.shop.test",
    port: address.port,
    state,
    sessionValue,
    csrfValue,
    signedInValue: signedIn,
    close: () => {
      for (const response of hanging) response.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
