import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, expect } from "@playwright/test";
import { chromium } from "playwright";
import { Usage } from "@openai/agents";
import type { ModelProvider, ModelRequest, ModelResponse } from "@openai/agents";
import { Effect, Schema } from "effect";
import { createBrowserEngine } from "../../src/standalone/engine.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import type { MintArtifact } from "../../src/standalone/contracts.js";
import { actionFor, quietReviewer } from "./guardian-context-fixture.js";
import type { InputRequest } from "../../src/runtime/input-request.js";

// Where each live step of a local build starts: its page, tabs, cookies and storage. A local
// fixture site records what every probe saw, and scripted models drive the build.

type Output = ModelResponse["output"];
const call = (name: string, input: unknown, callId = name): Output[number] => ({
  type: "function_call",
  name,
  callId,
  arguments: JSON.stringify(input),
  status: "completed",
});
const message = (text: string): Output[number] => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text }],
});
const objects = (value: unknown): readonly Record<string, unknown>[] => {
  if (typeof value === "string") {
    try {
      return objects(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value.flatMap(objects);
  if (typeof value !== "object" || value === null) return [];
  const record = Schema.decodeUnknownEither(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  )(value);
  return record._tag === "Left"
    ? []
    : [record.right, ...Object.values(record.right).flatMap(objects)];
};
const provider = (respond: (request: ModelRequest, index: number) => Output): ModelProvider => {
  let index = 0;
  return {
    getModel: () => ({
      getResponse: async (request) => ({ usage: new Usage(), output: respond(request, index++) }),
      getStreamedResponse: () => {
        throw new Error("Fixture does not stream");
      },
    }),
  };
};
/** Allows every review after reading the reviewed source, as the review loop requires. */
const guardian = () => {
  let sourcePending = false;
  return provider((request, index) => {
    const current = objects(request.input)
      .filter((item) => "submitted_call" in item)
      .at(-1);
    if (current !== undefined && "question_review" in current)
      return [message(JSON.stringify({ outcome: "allow_business", rationale: "Fixture" }))];
    if (sourcePending) {
      sourcePending = false;
      return [
        message(
          JSON.stringify({ outcome: "allow", rationale: "Fixture review", ...actionFor(current) }),
        ),
      ];
    }
    sourcePending = true;
    const pending = objects(current).find((item) => typeof item["entrypoint"] === "string");
    if (pending === undefined) throw new Error("Guardian did not receive its review input");
    return [call("read_source", { path: pending["entrypoint"], offset: 0 }, `source_${index}`)];
  });
};
const patch = (files: Readonly<Record<string, string>>): Output =>
  Object.entries(files).map(([path, content], index) => ({
    type: "apply_patch_call",
    callId: `patch_${index}`,
    status: "completed",
    operation: {
      type: "create_file",
      path,
      diff:
        content
          .split("\n")
          .map((line) => `+${line}`)
          .join("\n") + "\n",
    },
  }));
/** The write path every act step here carries: the form's one save. */
const formPath = {
  steps: [{ commit: "save", does: "Saves the form" }],
  ends: "The site's confirmation of the saved form",
};
const execution = (
  purpose: string,
  entrypoint: string,
  extra: object = {},
  callId = `${purpose}_${entrypoint}`,
) =>
  call(
    "execute",
    {
      purpose,
      target: "liveBrowser",
      entrypoint,
      fixtureRefs: [],
      caseFilter: [],
      maxWorkers: 1,
      timeoutSeconds: 20,
      intent: `Run ${entrypoint}`,
      ...(purpose === "act" ? { writePath: formPath } : {}),
      ...extra,
    },
    callId,
  );
const finish = (request: ModelRequest): Output => {
  const receipt = objects(request.input)
    .filter((item) => typeof item["executionId"] === "string")
    .at(-1);
  if (receipt === undefined) throw new Error("No execution receipt to finish with");
  return [
    call("finish_build", {
      intent: "Return the probe",
      entrypoint: "src/tool.mjs",
      executionId: receipt["executionId"],
      metadata: { name: "probe", description: "Report where the page starts" },
      coverage: "One live example",
    }),
  ];
};

/** One browser call in an operation module, which fails the run when the call fails. */
const operation = (name: string, code: string) => `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:${JSON.stringify(name)},input:Schema.Struct({}),output:Schema.Struct({done:Schema.Boolean})},
async ({kernel,sessionId}) => {
  const response = await kernel.browsers.playwright.execute(sessionId,{code:${JSON.stringify(code)},timeout_sec:15});
  if(!response.success) throw new Error(String(response.error));
  return {done:true};
});`;
/** Reports the page's path, tabs, cookies and storage to the site, then runs `then`. */
const probe = (step: string, then = "") => `
const state = await page.evaluate(() => ({
  path: location.pathname,
  explored: localStorage.getItem("explored"),
  token: localStorage.getItem("token"),
  tab: sessionStorage.getItem("explored"),
}));
const cookies = (await context.cookies()).map((cookie) => cookie.name).sort();
const report = JSON.stringify({ step: ${JSON.stringify(step)}, ...state, cookies, tabs: context.pages().length });
await page.evaluate((body) => fetch("/probe", { method: "POST", body }), report);
${then}
return true;`;
/** Leaves a cookie, site storage, tab storage and a second tab, then goes deeper. */
const explore = operation(
  "explore",
  `await page.evaluate(() => {
  document.cookie = "explored=yes; path=/";
  localStorage.setItem("explored", "yes");
  sessionStorage.setItem("explored", "yes");
});
await context.newPage();
await page.goto(new URL("/deep", page.url()).href);
return true;`,
);

interface Probe {
  readonly step: string;
  readonly path: string;
  readonly explored: string | null;
  readonly token: string | null;
  readonly tab: string | null;
  readonly cookies: readonly string[];
  readonly tabs: number;
}
const account = { username: "member@example.test", password: "fixture-password-41" };
/** The code the site sends during a passwordless sign-in. */
const signInCode = "482913";
const hostname = "www.start.test";
/** Another site the same server answers for, which a page on the site may frame. */
const elsewhere = "www.elsewhere.test";
const page = (response: ServerResponse, text: string) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(text);
};
const body = (request: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      text += chunk;
    });
    request.on("end", () => resolve(text));
  });

/**
 * A local HTTPS site with a deep page, a sign-in and a probe the operations report to. Its
 * root sets no cookie, so a reset's root load keeps whatever session the reset left. The same
 * server answers as another site, whose code field a page on the site frames.
 */
const startSite = async () => {
  const directory = await mkdtemp(join(tmpdir(), "opengpt-start-state-"));
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
    `/CN=${hostname}`,
    "-days",
    "1",
  ]);
  const visits: string[] = [];
  const probes: Probe[] = [];
  const state: {
    /** A path whose next signed-in load signs the session out, as an expired session would. */
    signOutOn: string | undefined;
    /**
     * Whether pages other than the account page show the signed-in marker to a signed-in session,
     * as a site-wide account menu would. Without it, only `/account` shows it.
     */
    markerOnEveryPage: boolean;
    /** Accepted sign-ins by password. */
    logins: number;
    /** Where the sign-in form goes once the site accepts the login. */
    landing: string;
  } = { signOutOn: undefined, markerOnEveryPage: true, logins: 0, landing: "/account" };
  const server = createServer(
    {
      key: await readFile(join(directory, "key.pem")),
      cert: await readFile(join(directory, "cert.pem")),
    },
    (request, response) => {
      void (async () => {
        const path = new URL(request.url ?? "/", `https://${hostname}`).pathname;
        if (request.method === "POST" && path === "/probe") {
          probes.push(JSON.parse(await body(request)) as Probe);
          response.end();
          return;
        }
        // A passwordless sign-in: the identifier, then the code the site sent.
        if (request.method === "POST" && path === "/api/identify") {
          const sent = JSON.parse(await body(request)) as { readonly username?: unknown };
          response.writeHead(sent.username === account.username ? 200 : 401);
          response.end("{}");
          return;
        }
        if (request.method === "POST" && path === "/api/verify") {
          const sent = JSON.parse(await body(request)) as { readonly code?: unknown };
          const matches = sent.code === signInCode;
          response.writeHead(matches ? 200 : 401, {
            "content-type": "application/json",
            ...(matches ? { "set-cookie": "member=signed; Path=/; Secure; HttpOnly" } : {}),
          });
          response.end("{}");
          return;
        }
        if (request.method === "POST" && path === "/api/login") {
          const sent: unknown = JSON.parse(await body(request));
          const matches = JSON.stringify(sent) === JSON.stringify(account);
          if (matches) state.logins += 1;
          response.writeHead(matches ? 200 : 401, {
            "content-type": "application/json",
            ...(matches ? { "set-cookie": "member=signed; Path=/; Secure; HttpOnly" } : {}),
          });
          response.end("{}");
          return;
        }
        visits.push(path);
        // A page that moved, one the site does not have, and one whose connection the site drops.
        if (path === "/moved") {
          response.writeHead(302, { location: "/entry" });
          response.end();
          return;
        }
        if (path === "/missing") {
          response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
          response.end("<title>Not found</title><h1>Not found</h1>");
          return;
        }
        if (path === "/dropped") {
          response.destroy();
          return;
        }
        const signedOutHere =
          path === state.signOutOn && request.headers.cookie?.includes("member=signed") === true;
        if (signedOutHere) {
          state.signOutOn = undefined;
          response.setHeader("set-cookie", "member=; Path=/; Max-Age=0; Secure; HttpOnly");
          request.headers.cookie = request.headers.cookie?.replace("member=signed", "");
        }
        const signedIn = request.headers.cookie?.includes("member=signed") === true;
        // A load that signs the session out shows the sign-in form, as a site whose session expired
        // does.
        if (path === "/login" || signedOutHere)
          return page(
            response,
            `<title>Sign in</title><form id="login"><input name="username"><input name="password" type="password"><button>Sign in</button></form>
<script>document.querySelector('#login').addEventListener('submit',async event=>{event.preventDefault();const form=new FormData(event.target);const sent=await fetch('/api/login',{method:'POST',body:JSON.stringify({username:form.get('username'),password:form.get('password')})});if(sent.ok){localStorage.setItem('token','member');location.href='${state.landing}'}})</script>`,
          );
        // An account picker the site shows before its pages: no marker and no sign-in form.
        if (path === "/choose")
          return page(response, `<title>Choose an account</title><p>Pick an account</p>`);
        // A sign-in that submits itself once the password is typed, and removes its own form.
        if (path === "/login-self")
          return page(
            response,
            `<title>Sign in</title><form id="login"><input name="username"><input name="password" type="password"><button>Sign in</button></form>
<script>const form=document.querySelector('#login');form.password.addEventListener('input',()=>form.requestSubmit());form.addEventListener('submit',async event=>{event.preventDefault();const data=new FormData(form);form.replaceWith(Object.assign(document.createElement('p'),{textContent:'Signing in'}));const sent=await fetch('/api/login',{method:'POST',body:JSON.stringify({username:data.get('username'),password:data.get('password')})});if(sent.ok){localStorage.setItem('token','member');location.href='/account'}})</script>`,
          );
        if (path === "/login-code")
          return page(
            response,
            `<title>Sign in</title><form id="identify"><input name="username"><button>Continue</button></form><form id="verify" hidden><input name="code" autocomplete="one-time-code"><button id="verify-button">Verify</button></form>
<script>document.querySelector('#identify').addEventListener('submit',async event=>{event.preventDefault();const sent=await fetch('/api/identify',{method:'POST',body:JSON.stringify({username:new FormData(event.target).get('username')})});if(sent.ok){event.target.hidden=true;document.querySelector('#verify').hidden=false}});document.querySelector('#verify').addEventListener('submit',async event=>{event.preventDefault();const sent=await fetch('/api/verify',{method:'POST',body:JSON.stringify({code:new FormData(event.target).get('code')})});if(sent.ok){localStorage.setItem('token','member');location.href='/account'}})</script>`,
          );
        // A code screen that sends itself the moment the sixth digit is typed.
        if (path === "/verify-code") {
          const sent = new URL(request.url ?? "/", "https://fixture").searchParams.get("code");
          const matches = sent === signInCode;
          response.writeHead(302, {
            location: matches ? "/account" : "/login-code-self",
            ...(matches ? { "set-cookie": "member=signed; Path=/; Secure; HttpOnly" } : {}),
          });
          response.end();
          return;
        }
        if (path === "/login-code-self")
          return page(
            response,
            `<title>Sign in</title><form id="identify"><input name="username"><button>Continue</button></form><form id="verify" action="/verify-code" hidden><input name="code" autocomplete="one-time-code"></form>
<script>document.querySelector('#identify').addEventListener('submit',async event=>{event.preventDefault();const sent=await fetch('/api/identify',{method:'POST',body:JSON.stringify({username:new FormData(event.target).get('username')})});if(sent.ok){event.target.hidden=true;document.querySelector('#verify').hidden=false}});const verify=document.querySelector('#verify');verify.code.addEventListener('input',()=>{if(verify.code.value.length===6)verify.submit()})</script>`,
          );
        if (path === "/framed")
          return page(
            response,
            `<title>Framed</title><iframe src="https://${elsewhere}:${request.socket.localPort}/code-frame"></iframe>`,
          );
        if (path === "/code-frame") return page(response, `<title>Code</title><input name="code">`);
        if (path === "/account")
          return page(
            response,
            request.headers.cookie?.includes("member=signed")
              ? `<title>Account</title><p id="account">Signed in</p>`
              : `<title>Account</title><p id="signed-out">Please sign in</p>`,
          );
        // Every other page shows the signed-in marker to a signed-in session, as a site-wide
        // account menu would.
        return page(
          response,
          `<title>${path}</title><h1>${path}</h1>${signedIn && state.markerOnEveryPage ? `<p id="account">Signed in</p>` : ""}`,
        );
      })().catch(() => response.destroy());
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture address");
  const browser = await chromium.launchServer({
    args: [
      `--host-resolver-rules=MAP ${hostname} 127.0.0.1, MAP ${elsewhere} 127.0.0.1`,
      "--no-proxy-server",
      "--ignore-certificate-errors",
    ],
  });
  return {
    origin: `https://${hostname}:${address.port}`,
    elsewhere: `https://${elsewhere}:${address.port}`,
    endpoint: browser.wsEndpoint(),
    state,
    visits,
    probes,
    probe: (step: string) => {
      const found = probes.find((entry) => entry.step === step);
      if (found === undefined) throw new Error(`No ${step} probe in ${JSON.stringify(probes)}`);
      return found;
    },
    close: async () => {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
};
type Site = Awaited<ReturnType<typeof startSite>>;

/** Mints with the scripted steps, then runs the published probe on `runUrl` when given. */
const build = (
  site: Site,
  request: {
    readonly url: string;
    readonly effect: "read" | "write" | "ask";
    readonly authenticationOrigins?: readonly string[];
  },
  steps: readonly ((request: ModelRequest) => Output)[],
  runUrl?: string,
  asked: InputRequest[] = [],
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* createBrowserEngine({
          browser: { endpoint: site.endpoint },
          minterProvider: provider((model, index) => steps[index]?.(model) ?? [message("Done.")]),
          guardianProvider: guardian(),
          outcomeReviewerProvider: quietReviewer,
          ask: makeInputAsker((request) =>
            Effect.sync(() => {
              asked.push(request);
              return Object.fromEntries(
                request.questions.map((question) => [
                  question.id,
                  question.type === "credential"
                    ? { ...account, saveLogin: false }
                    : question.type === "choice"
                      ? (question.options[0]?.id ?? "")
                      : question.id === "code"
                        ? signInCode
                        : account.password,
                ]),
              );
            }),
          ),
          // Each build runs several resets and live steps; under a loaded machine 40 s was tight.
          timeoutMs: 60_000,
        });
        const built = yield* service.mint({
          ...request,
          intent: "Report where the page starts",
          input: {},
        });
        if (runUrl === undefined) return built;
        const artifact: MintArtifact | undefined = built.artifact;
        if (artifact === undefined) throw new Error(JSON.stringify(built));
        yield* service.run(artifact, { url: runUrl, intent: "Report", input: {} });
        return built;
      }),
    ),
  ).finally(site.close);

const readSteps = (signIn: boolean) => [
  () =>
    patch({
      "explore/look.mjs": explore,
      "src/tool.mjs": operation("probe", probe("example")),
    }),
  ...(signIn
    ? [
        () =>
          [
            execution(
              "authenticate",
              "src/tool.mjs",
              {
                signInStep: {
                  fields: [
                    { selector: "input[name=username]", accepts: ["username"] },
                    { selector: "input[name=password]", slot: "password" },
                  ],
                  submit: "button",
                },
              },
              "sign_in",
            ),
          ] as Output,
        () =>
          [
            execution(
              "authenticate",
              "src/tool.mjs",
              { signInStep: { signedIn: { selector: "#account" } } },
              "signed_in",
            ),
          ] as Output,
      ]
    : []),
  () => [execution("explore", "explore/look.mjs")] as Output,
  () => [execution("example", "src/tool.mjs")] as Output,
  finish,
];

test("a signed-out build's example starts at the site root with the site data exploration left, and a run starts at the root", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  const built = await build(
    site,
    { url: `${site.origin}/entry`, effect: "read" },
    readSteps(false),
    `${site.origin}/entry`,
  );
  expect(built.build).toBe("published");
  // The request's URL loads before the build starts. The reset's blank root sends no request,
  // so the example and the run each load the root once.
  expect(site.visits).toEqual(["/entry", "/deep", "/", "/"]);
  const [example, run] = site.probes;
  // The reset closed the second tab and reloaded the root, and kept exploration's cookie, site
  // storage and tab storage.
  expect(example).toMatchObject({
    path: "/",
    cookies: ["explored"],
    explored: "yes",
    tab: "yes",
    tabs: 1,
  });
  // A run in the same scope shares the browser and clears nothing; it loads the root.
  expect(run).toMatchObject({ path: "/", cookies: ["explored"], explored: "yes", tabs: 1 });
});

test("a signed-in build's example starts at the root on the browser's signed-in session", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  const built = await build(
    site,
    { url: `${site.origin}/login`, effect: "read" },
    readSteps(true),
    `${site.origin}/deep`,
  );
  expect(built.build).toBe("published");
  // The run first checks its sign-in from the entry page. This site shows its form to a signed-in
  // session too, so the run signs in again (the check's load, then the replay's) before the root.
  expect(site.visits).toEqual([
    "/login",
    "/account",
    "/deep",
    "/",
    "/login",
    "/login",
    "/account",
    "/",
  ]);
  const [example, run] = site.probes;
  // The browser keeps the sign-in's cookie and storage, and exploration's too.
  expect(example).toMatchObject({
    path: "/",
    cookies: ["explored", "member"],
    explored: "yes",
    token: "member",
    tab: "yes",
    tabs: 1,
  });
  // A run keeps the browser's session and loads the root, whatever the request's path.
  expect(run).toMatchObject({
    path: "/",
    cookies: ["explored", "member"],
    token: "member",
    tabs: 1,
  });
});

test("a signed-in build whose reset's load signs it out signs in again before its example, which starts at the root", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  const [patched, signIn, check, explored, example, finished] = readSteps(true);
  if (!patched || !signIn || !check || !explored || !example || !finished)
    throw new Error("Unexpected read steps");
  const built = await build(site, { url: `${site.origin}/login`, effect: "read" }, [
    patched,
    signIn,
    check,
    explored,
    (request) => {
      // The example's reset loads the root, and that load signs the session out.
      site.state.signOutOn = "/";
      return example(request);
    },
    finished,
  ]);
  expect(built.build).toBe("published");
  // The host found the root signed out after the reset, as the root showed the sign-in form. Its
  // check that types nothing loaded the sign-in page, which showed its form, so it signed in again
  // with the login the build holds and reset once more. The root then showed the marker.
  expect(site.visits).toEqual([
    "/login",
    "/account",
    "/deep",
    "/",
    "/login",
    "/login",
    "/account",
    "/",
  ]);
  expect(site.probe("example")).toMatchObject({
    path: "/",
    cookies: ["explored", "member"],
    explored: "yes",
    token: "member",
    tab: "yes",
    tabs: 1,
  });
});

// The reset's load signs the session out, and the sign-in again lands on an account picker, which
// shows neither the marker nor the sign-in form. Only a read build's sign-in may end on a page that
// can't tell; a write's needs its marker, since nothing checks the session again before it commits.
const pickerAfterReset = (site: Site, effect: "read" | "write") => {
  const [, signIn, check, explored] = readSteps(true);
  if (!signIn || !check || !explored) throw new Error("Unexpected read steps");
  const step = effect === "read" ? "example" : "act";
  const entrypoint = effect === "read" ? "src/tool.mjs" : "src/act.mjs";
  return build(site, { url: `${site.origin}/login`, effect }, [
    () =>
      patch({
        "explore/look.mjs": explore,
        "src/tool.mjs": operation("probe", probe("example")),
        "src/act.mjs": operation("first_step", probe("act")),
      }),
    signIn,
    check,
    explored,
    () => {
      site.state.signOutOn = "/";
      site.state.landing = "/choose";
      return [execution(step, entrypoint)];
    },
    ...(effect === "read" ? [finish] : []),
  ]).then(
    (built) => ({ built }),
    (error: unknown) => ({ error }),
  );
};

test("a local write build whose sign-in again lands on an account picker fails its sign-in", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  const ended = await pickerAfterReset(site, "write");
  // The host signed in again from the root's form, and the site sent it to the picker. The write's
  // sign-in needs its marker, so the act never ran.
  expect(site.visits.slice(-3)).toEqual(["/login", "/login", "/choose"]);
  expect(site.state.logins).toBe(2);
  expect(site.probes.map(({ step }) => step)).toEqual([]);
  const diagnostics =
    "built" in ended ? (ended.built.diagnostics ?? []).map((line): unknown => JSON.parse(line)) : [];
  expect(diagnostics).toContainEqual(
    expect.objectContaining({ phase: "execution", purpose: "act", code: "Unavailable" }),
  );
});

// A read build the caller makes a write, after it signed in as a read: its sign-in again needs the
// marker from then on, as a write build's does.
test("a local read build that a task update makes a write fails its sign-in again on an account picker", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  const [, signIn, check, explored] = readSteps(true);
  if (!signIn || !check || !explored) throw new Error("Unexpected read steps");
  const ended = await build(site, { url: `${site.origin}/login`, effect: "read" }, [
    () =>
      patch({
        "explore/look.mjs": explore,
        "src/act.mjs": operation("first_step", probe("act")),
      }),
    signIn,
    check,
    explored,
    () => [
      call(
        "request_input",
        {
          intent: "Ask whether the build may save",
          questions: [
            {
              id: "save",
              type: "choice",
              prompt: "Saving the report changes the site. May this build save it?",
              options: [
                { id: "save", label: "Yes, save the report" },
                { id: "look", label: "No, only look" },
              ],
            },
          ],
        },
        "ask",
      ),
    ],
    () => [
      call(
        "mint_update",
        {
          intent: "Make the build a write, as the caller confirmed",
          summary: "Save the report on the site instead of only reading it.",
          changes: [{ setting: "effect", effect: "write" }],
          confirmedBy: ["save"],
          recommend: "update",
        },
        "update",
      ),
    ],
    () => {
      site.state.signOutOn = "/";
      site.state.landing = "/choose";
      return [execution("act", "src/act.mjs")];
    },
  ]).then(
    (built) => ({ built }),
    (error: unknown) => ({ error }),
  );
  expect(site.visits.slice(-3)).toEqual(["/login", "/login", "/choose"]);
  expect(site.state.logins).toBe(2);
  expect(site.probes.map(({ step }) => step)).toEqual([]);
  const diagnostics =
    "built" in ended ? (ended.built.diagnostics ?? []).map((line): unknown => JSON.parse(line)) : [];
  expect(diagnostics).toContainEqual(
    expect.objectContaining({ phase: "execution", purpose: "act", code: "Unavailable" }),
  );
});

test("a local read build whose sign-in again lands on an account picker goes on from there", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  const ended = await pickerAfterReset(site, "read");
  expect(site.visits.slice(4, 7)).toEqual(["/login", "/login", "/choose"]);
  expect(site.state.logins).toBe(2);
  expect(site.probe("example")).toMatchObject({ cookies: ["explored", "member"] });
  expect("built" in ended && ended.built.build).toBe("published");
});

test("a marker only the account page shows can't tell on the root after each reset, so the build goes on with its one sign-in", async () => {
  test.setTimeout(150_000);
  const site = await startSite();
  // A marker with no path and no page to open, which the root never shows, on a site whose
  // sign-in page shows its form to a signed-in session too.
  site.state.markerOnEveryPage = false;
  const [, signIn, check, explored] = readSteps(true);
  if (!signIn || !check || !explored) throw new Error("Unexpected read steps");
  const logins: number[] = [];
  const counted = (respond: (request: ModelRequest) => Output) => (request: ModelRequest) => {
    logins.push(site.state.logins);
    return respond(request);
  };
  const asked: InputRequest[] = [];
  const built = await build(
    site,
    { url: `${site.origin}/login`, effect: "read" },
    [
      () =>
        patch({
          "explore/look.mjs": explore,
          "test/check.mjs": operation("check", probe("test")),
          "src/tool.mjs": operation("probe", probe("example")),
        }),
      signIn,
      check,
      explored,
      counted(() => [execution("test", "test/check.mjs", {}, "test_1")]),
      counted(() => [execution("test", "test/check.mjs", {}, "test_2")]),
      counted(() => [execution("test", "test/check.mjs", {}, "test_3")]),
      counted(() => [execution("example", "src/tool.mjs")]),
      counted(finish),
    ],
    undefined,
    asked,
  );
  // Each reset loads the root, which shows neither the marker nor the sign-in form: it can't
  // tell, so the host signs in no more, and each step starts at the root on the build's one
  // sign-in, whose session the probes see.
  expect(logins).toEqual([1, 1, 1, 1, 1]);
  expect(site.visits).toEqual(["/login", "/account", "/deep", "/", "/", "/", "/"]);
  expect(site.probes.map(({ step, path, cookies }) => ({ step, path, cookies }))).toEqual([
    { step: "test", path: "/", cookies: ["explored", "member"] },
    { step: "test", path: "/", cookies: ["explored", "member"] },
    { step: "test", path: "/", cookies: ["explored", "member"] },
    { step: "example", path: "/", cookies: ["explored", "member"] },
  ]);
  expect(asked.map(({ questions }) => questions.map(({ id }) => id))).toEqual([["login"]]);
  expect(built.build).toBe("published");
});

test("a signed-in build that moves to another site replays nothing of the old site's sign-in there, and starts the new site signed out", async () => {
  test.setTimeout(150_000);
  const site = await startSite();
  const [, signIn, check, explored] = readSteps(true);
  if (!signIn || !check || !explored) throw new Error("Unexpected read steps");
  // The probe also reports the site it ran on.
  const whereProbe = probe("example").replace(
    "path: location.pathname,",
    "path: location.pathname,\n  host: location.hostname,",
  );
  let visitsAtMove = 0;
  const asked: InputRequest[] = [];
  const built = await build(
    site,
    { url: `${site.origin}/login`, effect: "read" },
    [
      () =>
        patch({
          "explore/look.mjs": explore,
          "src/tool.mjs": operation("probe", whereProbe),
        }),
      signIn,
      check,
      explored,
      () => [
        call(
          "request_input",
          {
            intent: "Ask where the reports live",
            questions: [
              {
                id: "site",
                type: "choice",
                prompt: `Your reports live on ${site.elsewhere}. Build the tool there?`,
                options: [
                  { id: "move", label: `Yes, use ${site.elsewhere}` },
                  { id: "stay", label: "No, stay here" },
                ],
              },
            ],
          },
          "ask",
        ),
      ],
      () => [
        call(
          "mint_update",
          {
            intent: "Move the build where the caller's reports live",
            summary: `Build the tool on ${site.elsewhere}, where the caller's reports live.`,
            changes: [{ setting: "site", origin: site.elsewhere }],
            confirmedBy: ["site"],
            recommend: "update",
          },
          "update",
        ),
      ],
      () => {
        visitsAtMove = site.visits.length;
        return [execution("example", "src/tool.mjs")];
      },
      finish,
    ],
    undefined,
    asked,
  );
  // The build signed in on the first site once.
  expect(site.state.logins).toBe(1);
  // On the new site, the example started at its root, signed out: no session restored, and no
  // sign-in of the first site's replayed or asked for.
  expect(site.visits.slice(visitsAtMove)).toEqual(["/"]);
  expect(site.probe("example")).toMatchObject({
    host: new URL(site.elsewhere).hostname,
    path: "/",
    token: null,
    explored: null,
  });
  expect(site.probe("example").cookies).not.toContain("member");
  expect(asked.flatMap(({ questions }) => questions.map(({ id }) => id))).toEqual([
    "login",
    "site",
  ]);
  expect(built.diagnostics ?? []).not.toContainEqual(expect.stringContaining("session_not_kept"));
  // The tool it published carries no sign-in: the one it recorded was the first site's.
  expect(built).toMatchObject({ build: "published" });
  expect(built.artifact).not.toHaveProperty("signIn");
});

test("a later build in the same session starts its example signed out after an earlier build signed in", async () => {
  test.setTimeout(150_000);
  const site = await startSite();
  // Each build answers from its own steps; both share the session's browser.
  const phases = [
    readSteps(true),
    [
      () => patch({ "src/tool.mjs": operation("probe", probe("later")) }),
      () => [execution("example", "src/tool.mjs")] as Output,
      finish,
    ],
  ];
  const phase = { current: 0, step: 0 };
  const [first, later] = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* createBrowserEngine({
          browser: { endpoint: site.endpoint },
          minterProvider: provider(
            (model) => phases[phase.current]?.[phase.step++]?.(model) ?? [message("Done.")],
          ),
          guardianProvider: guardian(),
          outcomeReviewerProvider: quietReviewer,
          ask: makeInputAsker((request) =>
            Effect.succeed(
              Object.fromEntries(
                request.questions.map((question) => [
                  question.id,
                  question.type === "credential" ? { ...account, saveLogin: false } : account.password,
                ]),
              ),
            ),
          ),
          timeoutMs: 60_000,
        });
        const signedIn = yield* service.mint({
          url: `${site.origin}/login`,
          effect: "read",
          intent: "Report where the page starts",
          input: {},
        });
        phase.current = 1;
        phase.step = 0;
        const anonymous = yield* service.mint({
          url: `${site.origin}/entry`,
          effect: "read",
          intent: "Report where the page starts",
          input: {},
        });
        return [signedIn, anonymous] as const;
      }),
    ),
  ).finally(site.close);
  expect(first.build).toBe("published");
  expect(site.probe("example")).toMatchObject({ cookies: ["explored", "member"], token: "member" });
  // The later build never signed in, but the browser still holds the earlier build's session:
  // its example's reset clears it, so the example reads the site signed out.
  expect(later.build).toBe("published");
  expect(site.probe("later")).toMatchObject({ path: "/", cookies: [], token: null, tabs: 1 });
});

/** What the build's model was told about the request's page, from one request's input. */
const entryNotices = (request: ModelRequest) =>
  objects(request.input).flatMap((item) =>
    "hostEntryNavigation" in item ? [item["hostEntryNavigation"]] : [],
  );
/** What each model request was told about the request's page, and the pages the site served. */
const watched = (site: Site, steps: readonly ((request: ModelRequest) => Output)[]) => {
  const seen: { readonly visits: readonly string[]; readonly notices: readonly unknown[] }[] = [];
  return {
    seen,
    steps: steps.map((step) => (request: ModelRequest) => {
      seen.push({ visits: [...site.visits], notices: entryNotices(request) });
      return step(request);
    }),
  };
};

test("the request's page loads before the build starts, and its first request says where it landed", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  const { seen, steps } = watched(site, [
    () =>
      patch({
        "explore/look.mjs": operation("look", probe("explore")),
        "src/tool.mjs": operation("probe", probe("example")),
      }),
    () => [execution("explore", "explore/look.mjs")],
    () => [execution("example", "src/tool.mjs")],
    finish,
  ]);
  const built = await build(site, { url: `${site.origin}/moved`, effect: "read" }, steps);
  expect(built.build).toBe("published");
  const notice = {
    state: "opened",
    outcome: "ready",
    requestedUrl: `${site.origin}/moved`,
    resolvedUrl: `${site.origin}/entry`,
    status: 200,
    instruction: expect.any(String),
  };
  // The page had loaded, through its redirect, before the build's first request.
  expect(seen[0]).toEqual({ visits: ["/moved", "/entry"], notices: [notice] });
  // The first live step finds it open and loads nothing again; the build is told once.
  expect(site.visits.slice(0, 2)).toEqual(["/moved", "/entry"]);
  expect(site.probe("explore")).toMatchObject({ path: "/entry" });
  expect(seen.at(-1)?.notices).toEqual([notice]);
});

test("a request's page the site answers with an error status is the build's to read", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  const { seen, steps } = watched(site, [
    () => patch({ "explore/look.mjs": operation("look", probe("explore")) }),
    () => [execution("explore", "explore/look.mjs")],
    () => [message("Done.")],
  ]);
  await build(site, { url: `${site.origin}/missing`, effect: "read" }, steps);
  expect(seen[0]).toEqual({
    visits: ["/missing"],
    notices: [
      {
        state: "opened",
        outcome: "http_error",
        requestedUrl: `${site.origin}/missing`,
        resolvedUrl: `${site.origin}/missing`,
        status: 404,
        instruction: expect.any(String),
      },
    ],
  });
  expect(site.probe("explore")).toMatchObject({ path: "/missing" });
});

test("a request's page that does not load is no failed start: the build runs, and is told", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  const { seen, steps } = watched(site, [
    () =>
      patch({
        "explore/look.mjs": operation(
          "look",
          `await page.goto(${JSON.stringify(`${site.origin}/deep`)});${probe("explore")}`,
        ),
      }),
    () => [execution("explore", "explore/look.mjs")],
    () => [message("Done.")],
  ]);
  await build(site, { url: `${site.origin}/dropped`, effect: "read" }, steps);
  expect(seen[0]).toEqual({
    visits: ["/dropped"],
    notices: [
      {
        state: "not_opened",
        outcome: "failed",
        requestedUrl: `${site.origin}/dropped`,
        instruction: expect.any(String),
      },
    ],
  });
  // The step runs on whatever page the tab shows, and the page is not loaded again.
  expect(site.visits.slice(0, 2)).toEqual(["/dropped", "/deep"]);
  expect(site.probe("explore")).toMatchObject({ path: "/deep" });
});

test("a build that asks its effect first loads the request's page only once the caller answered", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  const asked: InputRequest[] = [];
  /** Each model request: whether it is the effect question's, and what it was told and saw. */
  const seen: {
    readonly question: boolean;
    readonly visits: readonly string[];
    readonly notices: readonly unknown[];
  }[] = [];
  const buildSteps = [
    () => patch({ "explore/look.mjs": operation("look", probe("explore")) }),
    () => [execution("explore", "explore/look.mjs")],
  ];
  const respond = (request: ModelRequest): Output => {
    const question = objects(request.input).some((item) => "effectQuestion" in item);
    seen.push({ question, visits: [...site.visits], notices: entryNotices(request) });
    if (!question) return buildSteps.shift()?.() ?? [message("Done.")];
    if (seen.filter((entry) => entry.question).length > 1) return [message("Done.")];
    return [
      call("request_input", {
        intent: "Ask whether the build only looks things up",
        questions: [
          {
            id: "effect",
            type: "choice",
            prompt: "The tool reports where the page starts. Should it only look?",
            options: [
              { id: "read", label: "Only look" },
              { id: "write", label: "Change the site" },
            ],
          },
        ],
      }),
    ];
  };
  await build(
    site,
    { url: `${site.origin}/entry`, effect: "ask" },
    Array.from({ length: 8 }, () => respond),
    undefined,
    asked,
  );
  expect(asked.flatMap(({ questions }) => questions.map(({ id }) => id))).toEqual(["effect"]);
  // The question's run loads nothing; the build's run starts on the loaded page.
  const firstOfBuild = seen.findIndex(({ question }) => !question);
  expect(firstOfBuild).toBeGreaterThan(0);
  for (const { visits, notices } of seen.slice(0, firstOfBuild)) {
    expect(visits).toEqual([]);
    expect(notices).toEqual([]);
  }
  expect(seen[firstOfBuild]).toEqual({
    question: false,
    visits: ["/entry"],
    notices: [expect.objectContaining({ state: "opened", outcome: "ready", status: 200 })],
  });
  expect(site.visits.slice(0, 1)).toEqual(["/entry"]);
  expect(site.probe("explore")).toMatchObject({ path: "/entry" });
});

test("a write session's first step starts at the root with the browser's site data, and the next continues", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  await build(site, { url: `${site.origin}/entry`, effect: "write" }, [
    () =>
      patch({
        "explore/look.mjs": explore,
        "src/act.mjs": operation(
          "first_step",
          probe("first", 'await page.goto(new URL("/form", page.url()).href);'),
        ),
        "src/next.mjs": operation("next_step", probe("next")),
      }),
    () => [execution("explore", "explore/look.mjs")],
    () => [execution("act", "src/act.mjs")],
    () => [execution("act", "src/next.mjs")],
  ]);
  expect(site.visits[0]).toBe("/entry");
  expect(site.probe("first")).toMatchObject({
    path: "/",
    cookies: ["explored"],
    explored: "yes",
    tab: "yes",
    tabs: 1,
  });
  // A later step continues the page the previous step left.
  expect(site.probe("next")).toMatchObject({ path: "/form", cookies: ["explored"], tabs: 1 });
});

test("each live test starts at the root with the browser's site data, as the example does", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  const built = await build(site, { url: `${site.origin}/entry`, effect: "read" }, [
    () =>
      patch({
        "explore/look.mjs": explore,
        // The test leaves a second tab and goes deeper, which the example's reset undoes.
        "test/check.mjs": operation("check", probe("test")),
        "src/tool.mjs": operation("probe", probe("example")),
      }),
    () => [execution("explore", "explore/look.mjs")],
    () => [execution("test", "test/check.mjs")],
    () => [execution("test", "explore/look.mjs", {}, "test_leaves_state")],
    () => [execution("example", "src/tool.mjs")],
    finish,
  ]);
  expect(built.build).toBe("published");
  expect(site.probe("test")).toMatchObject({
    path: "/",
    cookies: ["explored"],
    explored: "yes",
    tabs: 1,
  });
  expect(site.probe("example")).toMatchObject({
    path: "/",
    cookies: ["explored"],
    explored: "yes",
    tab: "yes",
    tabs: 1,
  });
});

test("a page that shows the account before any sign-in leaves the example signed out", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  const checked: Record<string, unknown>[] = [];
  await build(site, { url: `${site.origin}/entry`, effect: "read" }, [
    () =>
      patch({
        // Exploration sets the site's member cookie itself, so its account page shows the account.
        "explore/look.mjs": operation(
          "look",
          `await page.evaluate(() => { document.cookie = "member=signed; path=/"; });
await page.goto(new URL("/account", page.url()).href);
return true;`,
        ),
        "src/tool.mjs": operation("probe", probe("example")),
      }),
    () => [execution("explore", "explore/look.mjs")],
    () => [
      execution(
        "authenticate",
        "src/tool.mjs",
        { signInStep: { signedIn: { selector: "#account" } } },
        "signed_in",
      ),
    ],
    (request) => {
      checked.push(...objects(request.input).filter((item) => "signedIn" in item));
      return [execution("example", "src/tool.mjs")];
    },
    finish,
  ]);
  // No sign-in step sent the login, so the host does not take the page as signed in.
  expect(checked).toContainEqual(
    expect.objectContaining({ signedIn: false, failed: "credentials_not_submitted" }),
  );
  expect(site.probe("example")).toMatchObject({ path: "/", cookies: [], tabs: 1 });
});

test("a sign-in whose page submits its own form still counts, and the example keeps it", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  const seen: Record<string, unknown>[] = [];
  const steps = readSteps(true).map((respond) => (request: ModelRequest) => {
    seen.push(...objects(request.input).filter((item) => "submit" in item || "signedIn" in item));
    return respond(request);
  });
  await build(site, { url: `${site.origin}/login-self`, effect: "read" }, steps);
  // The page sent the login itself as a new document, so the host found no submit to click after
  // typing and reports that the page sent it.
  expect(seen).toContainEqual(expect.objectContaining({ outcome: "filled", submit: "page" }));
  expect(seen).not.toContainEqual(expect.objectContaining({ submit: "refused" }));
  expect(seen).toContainEqual(expect.objectContaining({ signedIn: true }));
  expect(site.visits.slice(0, 2)).toEqual(["/login-self", "/account"]);
  expect(site.probe("example")).toMatchObject({
    path: "/",
    cookies: ["explored", "member"],
    explored: "yes",
    token: "member",
    tabs: 1,
  });
});

test("a build whose first live step is its example starts at the root", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  await build(site, { url: `${site.origin}/entry`, effect: "read" }, [
    () => patch({ "src/tool.mjs": operation("probe", probe("example")) }),
    () => [execution("example", "src/tool.mjs")],
    finish,
  ]);
  // The request's URL loads before the build starts, then the example's reset loads the root.
  expect(site.visits).toEqual(["/entry", "/"]);
  expect(site.probe("example")).toMatchObject({ path: "/", cookies: [], tabs: 1 });
});

test("a write build whose first live step is its act starts at the root", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  await build(site, { url: `${site.origin}/entry`, effect: "write" }, [
    () => patch({ "src/act.mjs": operation("first_step", probe("first")) }),
    () => [execution("act", "src/act.mjs")],
  ]);
  // The request's URL loads before the build starts, then the act's reset loads the root.
  expect(site.visits).toEqual(["/entry", "/"]);
  expect(site.probe("first")).toMatchObject({ path: "/", cookies: [], tabs: 1 });
});

test("a check again after a confirmed sign-in is refused and the example keeps the browser's session", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  const checked: Record<string, unknown>[] = [];
  const [patched, signIn, check, explored, example, finished] = readSteps(true);
  if (!patched || !signIn || !check || !explored || !example || !finished)
    throw new Error("Unexpected read steps");
  await build(site, { url: `${site.origin}/login`, effect: "read" }, [
    patched,
    signIn,
    check,
    explored,
    () => [
      execution(
        "authenticate",
        "src/tool.mjs",
        { signInStep: { signedIn: { selector: "#account" } } },
        "signed_in_again",
      ),
    ],
    (request) => {
      checked.push(...objects(request.input).filter((item) => "failed" in item));
      return example(request);
    },
    finished,
  ]);
  // The check starts a new sign-in that sent nothing, so it is refused, like any first check.
  expect(checked).toContainEqual(
    expect.objectContaining({ signedIn: false, failed: "credentials_not_submitted" }),
  );
  // Nothing saved describes the browser any more: the example keeps its cookies and storage.
  expect(site.probe("example")).toMatchObject({
    path: "/",
    cookies: ["explored", "member"],
    explored: "yes",
    token: "member",
    tabs: 1,
  });
});

/** Types the code the agent was given into the code screen, then waits for the account page. */
const typeCode = operation(
  "code",
  "await page.locator('input[name=code]').fill('{{secret.s1}}'); await page.locator('#verify-button').click(); await page.locator('#account').waitFor({ timeout: 5000 }); return true;",
);
/** Makes the page show an account without any sign-in: a cookie of its own, then the page. */
const forge = `await page.evaluate(() => { document.cookie = "member=signed; path=/"; localStorage.setItem("token", "member"); });
await page.goto(new URL("/account", page.url()).href);`;

/**
 * A passwordless sign-in: the host fills the identifier, the agent asks for the code the site
 * sent, writes `files` once the code's handle is issued, runs `explores`, then checks, explores
 * and runs its example.
 */
const passwordlessSteps = (
  files: Readonly<Record<string, string>>,
  explores: readonly string[],
): readonly ((request: ModelRequest) => Output)[] => [
  () =>
    patch({
      "explore/look.mjs": explore,
      "src/tool.mjs": operation("probe", probe("example")),
    }),
  () =>
    [
      execution(
        "authenticate",
        "src/tool.mjs",
        {
          signInStep: {
            fields: [{ selector: "#identify input[name=username]", accepts: ["username"] }],
            submit: "#identify button",
          },
        },
        "sign_in",
      ),
    ] as Output,
  // The code the site sent for this sign-in, asked by the agent.
  () =>
    [
      call("request_input", {
        intent: "Ask for the code the site sent to finish signing in",
        questions: [
          {
            id: "code",
            type: "secret",
            secretKind: "one_time_code",
            prompt: "Enter the code the site sent you to finish signing in.",
          },
        ],
      }),
    ] as Output,
  // Written once its handle is issued: a handle the attempt never issued refuses every execution.
  () => patch(files).map((item, index) => ({ ...item, callId: `patch_code_${index}` })),
  ...explores.map((entrypoint) => () => [execution("explore", entrypoint)] as Output),
  () =>
    [
      execution(
        "authenticate",
        "src/tool.mjs",
        { signInStep: { signedIn: { selector: "#account" } } },
        "signed_in",
      ),
    ] as Output,
  () => [execution("explore", "explore/look.mjs")] as Output,
  () => [execution("example", "src/tool.mjs")] as Output,
  finish,
];

test("a code the agent types into a passwordless sign-in's code screen counts as its proof", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  const built = await build(
    site,
    { url: `${site.origin}/login-code`, effect: "read" },
    passwordlessSteps({ "explore/code.mjs": typeCode }, ["explore/code.mjs"]),
  );
  expect(built.build, JSON.stringify({ built, visits: site.visits })).toBe("published");
  // The check counted the sign-in, so the example keeps the browser's session.
  expect(site.probe("example")).toMatchObject({
    path: "/",
    cookies: ["explored", "member"],
    explored: "yes",
    token: "member",
    tabs: 1,
  });
});

/** Code that holds a handle may not evaluate in the page, so this sets the cookie on the context. */
const forgeByContext =
  "await context.addCookies([{ name: 'member', value: 'signed', url: new URL(page.url()).origin }]); await page.goto(new URL('/account', page.url()).href);";
/** An operation module that runs `code` in the page once, after `before` in the module. */
const module = (code: string, before = "", imports = "") => `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
${imports}
export default defineOperation({name:"forge",input:Schema.Struct({}),output:Schema.Struct({done:Schema.Boolean})},
async ({kernel,sessionId}) => {
  ${before}
  const response = await kernel.browsers.playwright.execute(sessionId,{code:${JSON.stringify(code)},timeout_sec:15});
  if(!response.success) throw new Error(String(response.error));
  return {done:true};
});`;
const forgeOperation = operation("forge", `${forge}\nreturn true;`);
/** Types the code into the other site's field, framed by a page on the site, then forges. */
const typeInFrame = `await page.goto(new URL('/framed', page.url()).href); await page.frameLocator('iframe').locator('input[name=code]').fill('{{secret.s1}}'); ${forgeByContext} return true;`;

for (const [name, files, explores] of [
  [
    "sits in a file that never ran",
    { "explore/code.mjs": typeCode, "explore/forge.mjs": forgeOperation },
    ["explore/forge.mjs"],
  ],
  [
    "sits in a file that never ran, beside an explore with a computed import",
    {
      "explore/code.mjs": typeCode,
      "explore/forge.mjs": module(
        `${forge}\nreturn true;`,
        'const target = ["./no", "ne.mjs"].join(""); if (sessionId === "") await import(target);',
      ),
    },
    ["explore/forge.mjs"],
  ],
  [
    "sits in a file that never ran, in a workspace with a package.json",
    {
      "explore/code.mjs": typeCode,
      "explore/forge.mjs": forgeOperation,
      "scratch/package.json": "{}",
    },
    ["explore/forge.mjs"],
  ],
  [
    "sits in a helper the explore imports but never calls",
    {
      "explore/helper.mjs": `export const typeCode = (kernel, sessionId) => kernel.browsers.playwright.execute(sessionId, { code: ${JSON.stringify("await page.locator('input[name=code]').fill('{{secret.s1}}'); await page.locator('#verify-button').click(); return true;")}, timeout_sec: 15 });`,
      "explore/forge.mjs": module(
        `${forge}\nreturn true;`,
        "void typeCode;",
        'import { typeCode } from "./helper.mjs";',
      ),
    },
    ["explore/forge.mjs"],
  ],
  [
    "was typed into a page of the explore's own off the site",
    {
      "explore/code.mjs": operation(
        "code",
        `const site = page.url(); await page.goto('data:text/html,<input name=code>'); await page.locator('input[name=code]').fill('{{secret.s1}}'); await page.goto(site); ${forgeByContext} return true;`,
      ),
    },
    ["explore/code.mjs"],
  ],
  [
    "was typed into another site's frame on the site's page",
    { "explore/code.mjs": operation("code", typeInFrame) },
    ["explore/code.mjs"],
  ],
  [
    "never reached a field, in a fill whose failure the explore caught",
    {
      "explore/code.mjs": operation(
        "code",
        `try { await page.locator('#no-such-field').fill('{{secret.s1}}', { timeout: 1000 }); } catch {} ${forgeByContext} return true;`,
      ),
    },
    ["explore/code.mjs"],
  ],
  [
    "comes after the explore failed",
    {
      "explore/code.mjs": operation(
        "code",
        `${forgeByContext} throw new Error('Stopped before the code'); await page.locator('input[name=code]').fill('{{secret.s1}}');`,
      ),
    },
    ["explore/code.mjs"],
  ],
] as const)
  test(`a sign-in code that ${name} is no proof, so a page showing an account leaves the example signed out`, async () => {
    test.setTimeout(90_000);
    const site = await startSite();
    const built = await build(
      site,
      { url: `${site.origin}/login-code`, effect: "read" },
      passwordlessSteps(files, explores),
    );
    expect(built.build, JSON.stringify({ built, visits: site.visits })).toBe("published");
    // The check was refused, so the build never signed in and the example starts clean.
    expect(site.probe("example")).toMatchObject({
      path: "/",
      cookies: [],
      explored: null,
      token: null,
      tabs: 1,
    });
  });

test("a code typed into a frame on a configured sign-in origin counts as typed on the site", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  const built = await build(
    site,
    {
      url: `${site.origin}/login-code`,
      effect: "read",
      authenticationOrigins: [site.elsewhere],
    },
    passwordlessSteps({ "explore/code.mjs": operation("code", typeInFrame) }, ["explore/code.mjs"]),
  );
  expect(built.build, JSON.stringify({ built, visits: site.visits })).toBe("published");
  // The same explore as the frame above, but that origin is where this site signs in.
  expect(site.probe("example")).toMatchObject({
    path: "/",
    cookies: ["explored", "member"],
    explored: "yes",
    token: null,
    tabs: 1,
  });
});

test("a code typed into a code screen that sends itself at once counts as its proof", async () => {
  test.setTimeout(90_000);
  const site = await startSite();
  const built = await build(
    site,
    { url: `${site.origin}/login-code-self`, effect: "read" },
    passwordlessSteps(
      {
        "explore/code.mjs": operation(
          "code",
          "await page.locator('input[name=code]').fill('{{secret.s1}}'); await page.locator('#account').waitFor({ timeout: 5000 }); return true;",
        ),
      },
      ["explore/code.mjs"],
    ),
  );
  expect(built.build, JSON.stringify({ built, visits: site.visits })).toBe("published");
  expect(site.probe("example")).toMatchObject({
    path: "/",
    cookies: ["explored", "member"],
    explored: "yes",
    token: null,
    tabs: 1,
  });
});
