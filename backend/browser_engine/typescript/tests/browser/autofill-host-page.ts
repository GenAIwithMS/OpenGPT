import { expect } from "@playwright/test";
import type { Page, CDPSession } from "playwright";
import { runInThisContext } from "node:vm";
import { Effect, Schema } from "effect";
import type { AutofillPage } from "../../src/destinations/autofill-step.js";
import { isolatedLocatorPage, isolatedWorldName } from "./isolated-locator-page.js";
import { makeCredentialKeyboard } from "../../src/destinations/credential-keyboard.js";
import type { CredentialBindingWorld } from "../../src/destinations/credential-keyboard.js";

/** Every URL a report's failure detail names is an origin alone: no path, query or fragment. */
export const expectOriginsOnly = (report: object) => {
  const detail: unknown = Reflect.get(report, "failureDetail");
  const text = JSON.stringify({ ...Object(detail) });
  for (const url of text.match(/[a-z]+:\/\/[^\s",]+/g) ?? [])
    expect(url).toBe(new URL(url).origin);
};

/** One Kernel call the host made: its script, as a worker posts it to Kernel, and its answer. */
export interface HostCall {
  readonly script: string;
  readonly answer: unknown;
}

/** The values the host's keyboard typed on each page, which no later call's script may hold. */
const typed = new WeakMap<Page, Set<string>>();

/** Whether `text` holds `value` as typed, percent-encoded, or in a host's lower case. */
const holds = (text: string, value: string) => {
  const read = text.toLowerCase();
  return [value, encodeURIComponent(value)].some((form) =>
    read.includes(form.toLowerCase()),
  );
};

/**
 * A script without its random keys, call ids and the target ids of the pages it binds (32
 * uppercase hex digits), inside which a short code could turn up.
 */
const withoutIds = (script: string) =>
  script
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      "",
    )
    .replace(/\b[0-9A-F]{32}\b/g, "");

/** No call's script or answer holds `value` in any form a page could copy it into a URL. */
export const expectNotCarried = (calls: readonly HostCall[], value: string) => {
  expect(calls.length).toBeGreaterThan(0);
  for (const { script, answer } of calls) {
    expect(holds(withoutIds(script), value)).toBe(false);
    expect(holds(JSON.stringify(answer) ?? "", value)).toBe(false);
  }
};

/**
 * The host's call on a local page: Kernel's `page`, `context` and `browser`, as on a worker. It
 * keeps every call, and fails the test, without changing what the call does, when a script holds a
 * value the host's keyboard already typed on the page (no value but a date of
 * birth enters a Kernel call's script). Configured origins the host sends (`configured`), which a
 * value may sit inside, do not count. A Patchright page (`patchright`) evaluates locators in its
 * isolated world itself, so its calls run on it as they are.
 */
export const hostPage = async (
  page: Page,
  configured: readonly string[] = [],
  { patchright = false } = {},
): Promise<AutofillPage & { readonly calls: readonly HostCall[] }> => {
  const session = await page.context().newCDPSession(page);
  const { targetInfo } = await session.send("Target.getTargetInfo");
  await session.detach();
  const calls: HostCall[] = [];
  return {
    targetId: targetInfo.targetId,
    calls,
    execute: (code) =>
      Effect.tryPromise({
        try: async () => {
          const checked = configured.reduce(
            (script, origin) => script.replaceAll(JSON.stringify(origin), ""),
            withoutIds(code),
          );
          // One character turns up in any script by chance. A test checks a value typed one
          // character per field, such as a code in boxes, whole with `expectNotCarried`.
          for (const value of typed.get(page) ?? [])
            if (value.length > 1)
              expect
                .soft(
                  holds(checked, value),
                  "A typed value reached a Kernel call's script",
                )
                .toBe(false);
          const run: unknown = runInThisContext(
            `(async (page, context, browser) => {\n${code}\n})`,
          );
          if (typeof run !== "function")
            throw new Error("Call code unavailable");
          const kernel = patchright
            ? { page, close: () => Promise.resolve() }
            : await isolatedLocatorPage(page);
          let value: unknown;
          try {
            value = await Reflect.apply(run, undefined, [
              kernel.page,
              kernel.page.context(),
              page.context().browser(),
            ]);
          } finally {
            await kernel.close();
          }
          const result: unknown =
            value === undefined ? undefined : JSON.parse(JSON.stringify(value));
          calls.push({ script: code, answer: result });
          return result;
        },
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      }),
  };
};

const FrameTree = Schema.Struct({
  frameTree: Schema.Struct({ frame: Schema.Struct({ id: Schema.String }) }),
});
const World = Schema.Struct({ executionContextId: Schema.Number });
const fixtureCall = (run: () => Promise<unknown>, failure: string) =>
  Effect.tryPromise({ try: run, catch: (cause) => new Error(failure, { cause }) });

/**
 * The isolated world `isolatedLocatorPage` evaluates locators in, so the keyboard resolves the
 * field where the host's focus call bound it.
 */
const fixtureBindingWorld: CredentialBindingWorld = (cdp, { sessionId, frameId }) =>
  Effect.gen(function* () {
    const frame =
      frameId ??
      (yield* fixtureCall(
        () => cdp.send("Page.getFrameTree", {}, sessionId),
        "Fixture frame unavailable",
      ).pipe(
        Effect.flatMap(Schema.decodeUnknown(FrameTree)),
        Effect.map(({ frameTree }) => frameTree.frame.id),
        Effect.mapError((cause) => new Error("Fixture frame unavailable", { cause })),
      ));
    const world = yield* fixtureCall(
      () =>
        cdp.send(
          "Page.createIsolatedWorld",
          { frameId: frame, worldName: isolatedWorldName },
          sessionId,
        ),
      "Fixture world unavailable",
    ).pipe(
      Effect.flatMap(Schema.decodeUnknown(World)),
      Effect.mapError((cause) => new Error("Fixture world unavailable", { cause })),
    );
    return world.executionContextId;
  });

/**
 * The host's typing on a local page, over a DevTools session of its own, as the recorder's socket
 * types on a worker. Each value it is given to type counts as typed on the page from then on.
 * `beforeInsert` runs once the binding resolved, just before the atomic insertion's own call.
 */
export const hostKeyboard = async (
  page: Page,
  beforeInsert: () => Promise<void> = () => Promise.resolve(),
) => {
  const candidates = [
    page.mainFrame(),
    ...page.frames().filter((frame) => {
      const url = frame.url();
      return (
        frame !== page.mainFrame() &&
        url.startsWith("https:") &&
        new URL(url).origin !== new URL(page.url()).origin
      );
    }),
  ];
  const sessions = new Map<string, CDPSession>();
  for (const [index, frame] of candidates.entries()) {
    try {
      sessions.set(`local-${index}`, await page.context().newCDPSession(frame));
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("does not have a separate CDP session")
      )
        throw error;
    }
  }
  const native = makeCredentialKeyboard(
    {
      sessions: () => [...sessions.keys()],
      send: async (method, params, id) => {
        const session = sessions.get(id);
        if (session === undefined)
          throw new Error("Fixture CDP session missing");
        if (method === "Runtime.callFunctionOn") await beforeInsert();
        const send = session.send.bind(session);
        const result: unknown = await Reflect.apply(send, undefined, [
          method,
          params,
        ]);
        return result;
      },
    },
    undefined,
    fixtureBindingWorld,
  );
  const keyboard: typeof native = {
    insertText: (target, text, options) =>
      Effect.suspend(() => {
        const values = typed.get(page) ?? new Set<string>();
        if (text !== "") typed.set(page, values.add(text));
        return native.insertText(target, text, options);
      }),
  };
  return { keyboard };
};
