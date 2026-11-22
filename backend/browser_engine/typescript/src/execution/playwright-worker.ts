import { existsSync, readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import { compileFunction } from "node:vm";
import { format } from "node:util";
import type { Browser, BrowserContext, CDPSession, Frame, Page } from "playwright";
import { Cause, Effect, Exit, Schema } from "effect";
import type { BrowserExecuteResponse } from "../runtime/browser-execution.js";

// Match the lease/screening entries: compiled packages need no hook; source tests resolve NodeNext imports.
if (import.meta.url.endsWith(".ts"))
  registerHooks({
    resolve: (specifier, context, nextResolve) => {
      if (context.parentURL?.endsWith(".ts") && /^\.\.?\/.*\.js$/.test(specifier)) {
        const source = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
        if (existsSync(fileURLToPath(source))) return nextResolve(source.href, context);
      }
      return nextResolve(specifier, context);
    },
    load: (url, context, nextLoad) =>
      url.startsWith("file:") && url.endsWith(".ts")
        ? {
            format: "module",
            shortCircuit: true,
            source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), {
              mode: "transform",
              sourceUrl: url,
            }),
          }
        : nextLoad(url, context),
  });
const { makeCredentialKeyboard } = await import("../destinations/credential-keyboard.js");
const { NativeWorkerOptions, NativeWorkerRequest } = await import("./playwright-protocol.js");

const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error("Native browser worker failed", { cause });
const promise = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: asError });
const outputLimit = 1_048_576;
/** A byte limit as errors name it: in MiB when it is a whole number of them, else in bytes. */
const limitLabel = (bytes: number) =>
  bytes % 1_048_576 === 0 ? `${bytes / 1_048_576} MiB` : `${bytes} bytes`;
const Target = Schema.Struct({
  targetInfo: Schema.Struct({ targetId: Schema.String, browserContextId: Schema.String }),
});
const identify = (context: BrowserContext, page: Page) =>
  Effect.gen(function* () {
    const session = yield* promise(() => context.newCDPSession(page));
    return yield* promise(() => session.send("Target.getTargetInfo")).pipe(
      Effect.flatMap((value) => Schema.decodeUnknown(Target)(value)),
      Effect.map((value) => value.targetInfo),
      Effect.mapError(asError),
      Effect.ensuring(promise(() => session.detach()).pipe(Effect.orDie)),
    );
  });

/**
 * The page of a CDP-attached browser's own context the worker drives: the one `targetId` names, or
 * with none the context's first page, opened when it has none. Playwright lists other clients'
 * contexts' pages under the default context too, so a page whose context the browser reports as
 * a created one (`Target.getBrowserContexts` lists every context but the default) is never taken:
 * its cookies and storage are not the ones `context` reads.
 */
const adoptPage = (browser: Browser, context: BrowserContext, targetId: string | undefined) =>
  Effect.gen(function* () {
    const session = yield* promise(() => browser.newBrowserCDPSession());
    const created = yield* promise(() => session.send("Target.getBrowserContexts")).pipe(
      Effect.map(({ browserContextIds }) => new Set(browserContextIds)),
      Effect.ensuring(promise(() => session.detach()).pipe(Effect.orDie)),
    );
    for (const candidate of context.pages()) {
      const target = yield* identify(context, candidate);
      if (created.has(target.browserContextId)) continue;
      if (targetId === undefined || target.targetId === targetId) return candidate;
    }
    if (targetId === undefined) return yield* promise(() => context.newPage());
    return yield* Effect.fail(new Error("CDP target not found in the browser's own context"));
  });

/**
 * A watched value's index and the URLs of the frames a completed typing call may have entered it
 * in, when the call started and once it completed, and for keys typed with nothing focused every
 * address a frame of the page loaded while the call ran.
 */
type Delivery = readonly [index: number, urls: readonly string[]];

/**
 * The frames a typing call types in, found before it, and for keys with nothing focused the
 * frames and addresses the page had while it ran, which `later` gives once it ended.
 */
interface Targets {
  readonly frames: readonly Frame[];
  readonly later?: () => { readonly frames: readonly Frame[]; readonly urls: readonly string[] };
}

/**
 * The frame the element `selector` names from `frame` is in, by Playwright's own lookup, the one
 * its actions use: frame locators, any-frame selectors and aria snapshot references included.
 * Undefined while there is no such element.
 */
const selectorFrames = async (
  frame: Frame,
  selector: string,
  strict: unknown,
): Promise<Targets | undefined> => {
  const element = await frame.$(selector, strict === true ? { strict } : undefined);
  if (element === null) return undefined;
  const owner = await element.ownerFrame();
  await element.dispose();
  return owner === null ? undefined : { frames: [owner] };
};

/**
 * The frames of `page` the keyboard types in: the one whose document holds the focused element, by
 * the browser's own `:focus` match, which Playwright runs apart from the page's scripts and only
 * the focused frame matches. With nothing focused, keys go to whichever document has the focus,
 * so every frame the page has before the call, gets or loads a document in while it runs, and has
 * once it ended, with each address it loaded.
 */
const focusedFrames = async (page: Page): Promise<Targets> => {
  for (const frame of page.frames()) {
    const focused = await frame.$(":focus").catch(() => null);
    if (focused === null) continue;
    await focused.dispose();
    return { frames: [frame] };
  }
  const seen = new Set(page.frames());
  const urls = new Set<string>();
  const attached = (frame: Frame) => seen.add(frame);
  const navigated = (frame: Frame) => {
    seen.add(frame);
    urls.add(frame.url());
  };
  page.on("frameattached", attached);
  page.on("framenavigated", navigated);
  return {
    frames: page.frames(),
    later: () => {
      page.off("frameattached", attached);
      page.off("framenavigated", navigated);
      for (const frame of page.frames()) seen.add(frame);
      return { frames: [...seen], urls: [...urls] };
    },
  };
};

/**
 * Wraps, for one script, the calls a handle may type through: a frame's `fill` and `type`, which a
 * page's and a locator's `fill`, `type` and `pressSequentially` go through, and the keyboard's
 * `type`. Before a call with a watched value as its text, it finds the frames the call types in:
 * the frame of the element its selector names for a frame's call, looked up again once the call
 * completed when there was none yet, and the focused frames for the keyboard's, with every frame
 * and address the page had while it ran when nothing was focused. Once the call completed, it
 * adds the value to `typed` with those frames' URLs then and now, read without waiting for any
 * page the typing started to load, unless one of them left the page meanwhile, as a frame the
 * page swapped out does. A call that throws adds nothing. The methods are shared
 * by every page, so the returned restore puts the originals back once the script ends.
 */
const watchTypingCalls = (
  page: Page,
  browser: Browser,
  values: readonly string[],
  typed: Delivery[],
) => {
  const keyboardFrames = (keyboard: unknown) => {
    const owner = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.keyboard === keyboard);
    return owner === undefined ? Promise.resolve(undefined) : focusedFrames(owner);
  };
  const elementFrames = (frame: unknown, args: readonly unknown[]) =>
    selectorFrames(
      frame as Frame,
      String(args[0]),
      args[2] !== null && typeof args[2] === "object" ? Reflect.get(args[2], "strict") : undefined,
    );
  const framePrototype = Object.getPrototypeOf(page.mainFrame()) as object;
  const sinks = [
    [framePrototype, "fill", 1, elementFrames, true],
    [framePrototype, "type", 1, elementFrames, true],
    [Object.getPrototypeOf(page.keyboard) as object, "type", 0, keyboardFrames, false],
  ] as const;
  const restores = sinks.map(([prototype, method, index, targets, again]) => {
    const own = Object.getOwnPropertyDescriptor(prototype, method);
    const original: unknown = Reflect.get(prototype, method);
    if (typeof original !== "function") return () => undefined;
    Object.defineProperty(prototype, method, {
      configurable: true,
      writable: true,
      value: async function (this: unknown, ...args: unknown[]) {
        const text = args[index];
        const at = typeof text === "string" ? values.indexOf(text) : -1;
        if (at < 0) return (await Reflect.apply(original, this, args)) as unknown;
        const before = await targets(this, args).catch(() => undefined);
        const started = before?.frames.map((frame) => frame.url()) ?? [];
        let during: ReturnType<NonNullable<Targets["later"]>> | undefined;
        let result: unknown;
        try {
          result = await Reflect.apply(original, this, args);
        } finally {
          during = before?.later?.();
        }
        const found =
          before ?? (again ? await targets(this, args).catch(() => undefined) : undefined);
        const frames = found && [...found.frames, ...(during?.frames ?? [])];
        const stayed = frames !== undefined && !frames.some((frame) => frame.isDetached());
        const urls = [...started, ...(during?.urls ?? []), ...(frames ?? []).map((f) => f.url())];
        if (stayed && frames.length > 0) typed.push([at, [...new Set(urls)]]);
        return result;
      },
    });
    return () =>
      own === undefined
        ? Reflect.deleteProperty(prototype, method)
        : Object.defineProperty(prototype, method, own);
  });
  return () => {
    for (const restore of restores.reverse()) restore();
  };
};

const script = (
  code: string,
  page: Page,
  context: BrowserContext,
  browser: Browser,
  resultLimit: number,
  watch?: readonly string[],
) =>
  Effect.gen(function* () {
    const typed: Delivery[] = [];
    const restore = watch === undefined ? undefined : watchTypingCalls(page, browser, watch, typed);
    let stdout = "";
    let stderr = "";
    let overflow = false;
    const append = (error: boolean, args: readonly unknown[]) => {
      const line = `${format(...args)}\n`;
      const existing = error ? stderr : stdout;
      if (Buffer.byteLength(existing) + Buffer.byteLength(line) > outputLimit) {
        overflow = true;
        throw new Error("Native script output exceeds 1 MiB");
      }
      if (error) stderr += line;
      else stdout += line;
    };
    const console = {
      log: (...args: unknown[]) => append(false, args),
      info: (...args: unknown[]) => append(false, args),
      debug: (...args: unknown[]) => append(false, args),
      warn: (...args: unknown[]) => append(true, args),
      error: (...args: unknown[]) => append(true, args),
    };
    const result = yield* Effect.tryPromise({
      try: async () => {
        const invoke = compileFunction(`return (async () => {\n${code}\n})();`, [
          "page",
          "context",
          "browser",
          "console",
        ]);
        const value: unknown = await Reflect.apply(invoke, undefined, [
          page,
          context,
          browser,
          console,
        ]);
        if (overflow) throw new Error("Native script output exceeds 1 MiB");
        if (value === undefined) return undefined;
        const json = JSON.stringify(value, (_key, item: unknown) => {
          if (
            typeof item === "bigint" ||
            typeof item === "function" ||
            typeof item === "symbol" ||
            (typeof item === "number" && !Number.isFinite(item))
          )
            throw new Error("Native script result is not JSON serializable");
          return item;
        });
        if (json === undefined) throw new Error("Native script result is not JSON serializable");
        if (Buffer.byteLength(json) > resultLimit)
          throw new Error(`Native script result exceeds ${limitLabel(resultLimit)}`);
        return JSON.parse(json) as unknown;
      },
      catch: asError,
    }).pipe(
      Effect.either,
      Effect.ensuring(Effect.sync(() => restore?.())),
    );
    const delivered = watch === undefined ? {} : { typed: [...typed] };
    if (result._tag === "Left") {
      const error = result.left;
      const stack = error.stack ?? error.message;
      return {
        success: false,
        error: error.message,
        stdout,
        stderr: `${stderr}${stack}`.slice(0, outputLimit),
        ...delivered,
      } satisfies BrowserExecuteResponse & { readonly typed?: readonly Delivery[] };
    }
    return {
      success: true,
      ...(result.right === undefined ? {} : { result: result.right }),
      stdout,
      stderr,
      ...delivered,
    } satisfies BrowserExecuteResponse & { readonly typed?: readonly Delivery[] };
  });

const credential = (
  request: Extract<typeof NativeWorkerRequest.Type, { readonly kind: "credential" }>,
  context: BrowserContext,
  primaryTargetId: string,
) =>
  Effect.gen(function* () {
    const wanted = request.target.targetId ?? primaryTargetId;
    let owner: Page | undefined;
    for (const page of context.pages()) {
      if ((yield* identify(context, page)).targetId === wanted) owner = page;
    }
    if (owner === undefined) return yield* Effect.fail(new Error("Credential page closed"));
    const owningPage = owner;
    const sessions = new Map<string, CDPSession>();
    return yield* Effect.gen(function* () {
      // Same-process frames have no independent CDP target; their DOM is covered by the page session.
      sessions.set("page", yield* promise(() => context.newCDPSession(owningPage)));
      for (const frame of owningPage.frames()) {
        if (frame === owningPage.mainFrame()) continue;
        const connected = yield* promise(() => context.newCDPSession(frame)).pipe(Effect.either);
        if (connected._tag === "Right") sessions.set(String(sessions.size), connected.right);
        else if (!connected.left.message.includes("does not have a separate CDP session"))
          return yield* Effect.fail(connected.left);
      }
      const keyboard = makeCredentialKeyboard({
        sessions: () => [...sessions.keys()],
        send: (method, params, id) => {
          const session = sessions.get(id);
          if (session === undefined)
            return Effect.runPromise(Effect.fail(new Error("Credential CDP session unavailable")));
          switch (method) {
            case "DOM.getDocument":
              return session.send(
                method,
                Schema.decodeUnknownSync(
                  Schema.Struct({ depth: Schema.Number, pierce: Schema.Boolean }),
                )(params),
              );
            case "DOM.resolveNode":
              return session.send(
                method,
                Schema.decodeUnknownSync(Schema.Struct({ backendNodeId: Schema.Number }))(params),
              );
            case "Runtime.callFunctionOn":
              return session.send(
                method,
                Schema.decodeUnknownSync(
                  Schema.Struct({
                    objectId: Schema.String,
                    functionDeclaration: Schema.String,
                    arguments: Schema.mutable(
                      Schema.Array(Schema.Struct({ value: Schema.Unknown })),
                    ),
                    returnByValue: Schema.Boolean,
                  }),
                )(params),
              );
            case "Runtime.releaseObject":
              return session.send(
                method,
                Schema.decodeUnknownSync(Schema.Struct({ objectId: Schema.String }))(params),
              );
            default:
              return Effect.runPromise(
                Effect.fail(new Error("Unsupported credential CDP command")),
              );
          }
        },
      });
      return yield* keyboard.insertText(
        request.target,
        request.text,
        { phone: request.phone, keys: request.keys },
      );
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          Effect.forEach([...sessions.values()], (session) => promise(() => session.detach()), {
            discard: true,
          }),
        ).pipe(Effect.orDie),
      ),
    );
  });

await Effect.runPromise(
  Effect.gen(function* () {
    const port = parentPort;
    if (port === null) return yield* Effect.fail(new Error("Native worker requires parent IPC"));
    const options = yield* Schema.decodeUnknown(NativeWorkerOptions)(workerData).pipe(
      Effect.mapError(asError),
    );
    const resultLimit = options.resultLimitBytes ?? outputLimit;
    const chromium = yield* promise(
      async () => ((await import(options.library)) as typeof import("playwright")).chromium,
    );
    const attached = options.cdp;
    const browser = yield* promise(() =>
      attached === undefined
        ? chromium.connect(options.endpoint, { timeout: options.startupTimeoutMs })
        : chromium.connectOverCDP(options.endpoint, { timeout: options.startupTimeoutMs }),
    );
    // Over CDP the worker drives the browser's own context and page and owns neither.
    const context =
      attached === undefined ? yield* promise(() => browser.newContext()) : browser.contexts()[0];
    if (context === undefined)
      return yield* Effect.fail(new Error("CDP browser has no default context"));
    const page =
      attached === undefined
        ? yield* promise(() => context.newPage())
        : yield* adoptPage(browser, context, attached.targetId);
    const target = yield* identify(context, page);
    if (attached !== undefined)
      browser.on("disconnected", () => port.postMessage({ kind: "disconnected" }));
    port.postMessage({
      kind: "ready",
      targetId: target.targetId,
      ...(attached === undefined ? { contextId: target.browserContextId } : {}),
    });
    const semaphore = yield* Effect.makeSemaphore(1);
    port.on("message", (value: unknown) => {
      const handle = Effect.gen(function* () {
        const request = yield* Schema.decodeUnknown(NativeWorkerRequest)(value).pipe(
          Effect.mapError(asError),
        );
        const response = yield* Effect.gen(function* () {
          if (request.kind === "execute")
            return yield* script(
              request.code,
              page,
              context,
              browser,
              resultLimit,
              request.watch,
            );
          return yield* credential(request, context, target.targetId);
        }).pipe(Effect.either);
        port.postMessage(
          response._tag === "Right"
            ? { kind: "response", id: request.id, value: response.right }
            : {
                kind: "failure",
                id: request.id,
                error:
                  request.kind === "credential"
                    ? "Credential insertion unavailable"
                    : response.left.message,
              },
        );
      }).pipe(semaphore.withPermits(1));
      Effect.runCallback(handle, {
        onExit: (exit) => {
          if (Exit.isSuccess(exit)) return;
          // Malformed IPC invalidates this worker rather than sending an uncorrelated response.
          port.close();
          queueMicrotask(() => {
            throw asError(Cause.squash(exit.cause));
          });
        },
      });
    });
  }),
);
