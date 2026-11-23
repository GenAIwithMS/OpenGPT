// Failure modes covered: a rejection marker read sends a selector that chains into other content,
// reads a screen off the site and its sign-in origins, reads a frame of another origin or a tab
// that left the screen's origin, checks unbounded matches, or reads a missing popup it never
// recorded, or an answer that is not one, as no marker.
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { autofillMarkerVisible } from "../../src/destinations/autofill-marker.js";
import { autofillPageCode } from "../../src/destinations/autofill-page-code.js";

type AsyncFunctionConstructor = new (
  ...parameters: string[]
) => (...values: unknown[]) => Promise<unknown>;
const isAsyncFunctionConstructor = (value: unknown): value is AsyncFunctionConstructor =>
  typeof value === "function";
/** The constructor of async functions, which a host's execute call builds each call's code with. */
const AsyncFunction = (() => {
  const prototype: unknown = Object.getPrototypeOf(async () => undefined);
  const found: unknown =
    typeof prototype === "object" && prototype !== null
      ? Reflect.get(prototype, "constructor")
      : undefined;
  if (!isAsyncFunctionConstructor(found)) throw new Error("AsyncFunction is unavailable");
  return found;
})();

const site = "https://shop.example";
const login = "https://login.idp.example";
const popup = { opener: "primary", origin: login } as const;

/** A page that records each host call and answers it with `answer`. */
const recordingPage = (answer: unknown = true) => {
  const calls: { readonly code: string }[] = [];
  return {
    calls,
    page: {
      targetId: "target-1",
      execute: (code: string) =>
        Effect.sync(() => {
          calls.push({ code });
          return answer;
        }),
    },
  };
};

const read = (
  input: Partial<Parameters<typeof autofillMarkerVisible>[0]> & {
    readonly page: Parameters<typeof autofillMarkerVisible>[0]["page"];
  },
) =>
  Effect.runPromiseExit(
    autofillMarkerVisible({
      selector: "#error",
      screenPage: `${site}/login`,
      siteOrigin: site,
      authenticationOrigins: [login],
      ...input,
    }),
  );

type Frame = { readonly url: string; readonly visible: readonly boolean[] };
/** Runs a recorded call's own code, after its tab binding, on a primary tab with these frames. */
const runOnFrames = async (code: string, url: string, frames: readonly Frame[]) => {
  const prefix = `${autofillPageCode("target-1", undefined)}\n`;
  expect(code.startsWith(prefix)).toBe(true);
  const located: string[] = [];
  const primary = {
    url: () => url,
    frames: () =>
      frames.map((frame) => ({
        url: () => frame.url,
        locator: (selector: string) => {
          located.push(`${frame.url} ${selector}`);
          return {
            count: async () => frame.visible.length,
            nth: (index: number) => ({ isVisible: async () => frame.visible[index] === true }),
          };
        },
      })),
  };
  const visible = await new AsyncFunction("primary", code.slice(prefix.length))(primary);
  return { visible, located };
};

describe("autofillMarkerVisible", () => {
  it("answers false without a host call for a Playwright-only selector", async () => {
    for (const selector of ["#form >> text=Wrong", "internal:role=alert"]) {
      const { page, calls } = recordingPage();
      expect(await read({ selector, page })).toEqual(Exit.succeed(false));
      expect(calls).toEqual([]);
    }
  });

  it("answers false without a host call for a screen off the site and its sign-in origins", async () => {
    for (const screenPage of ["https://elsewhere.example/login", "not a url"]) {
      const { page, calls } = recordingPage();
      expect(await read({ screenPage, page })).toEqual(Exit.succeed(false));
      expect(calls).toEqual([]);
    }
  });

  it("reads a same-site or sign-in screen's frames in one host call, on that screen's origin", async () => {
    for (const screenPage of ["https://www.shop.example/account/login", `${login}/authorize`]) {
      const { page, calls } = recordingPage(true);
      expect(await read({ screenPage, page })).toEqual(Exit.succeed(true));
      expect(calls).toHaveLength(1);
      const code = calls[0]?.code ?? "";
      const frames: Frame[] = [{ url: screenPage, visible: [true] }];
      expect(await runOnFrames(code, screenPage, frames)).toEqual({
        visible: true,
        located: [`${screenPage} #error`],
      });
      // The marker belongs to the recorded screen's own origin, not just its site.
      expect(await runOnFrames(code, `${site}/`, frames)).toEqual({ visible: false, located: [] });
    }
  });

  it("finds a visible marker only in a frame of an allowed origin", async () => {
    const { page, calls } = recordingPage(true);
    await read({ page });
    const code = calls[0]?.code ?? "";
    const frames: Frame[] = [
      { url: "https://ads.example/frame", visible: [true] },
      { url: "about:blank", visible: [true] },
      { url: "not a url", visible: [true] },
      { url: `${site}/login`, visible: [false, false] },
    ];
    const hidden = await runOnFrames(code, `${site}/login`, frames);
    expect(hidden.visible).toBe(false);
    expect(hidden.located).toEqual([`${site}/login #error`]);
    const shown = await runOnFrames(code, `${site}/login`, [
      ...frames,
      { url: `${login}/widget`, visible: [false, true] },
    ]);
    expect(shown).toEqual({
      visible: true,
      located: [`${site}/login #error`, `${login}/widget #error`],
    });
    // A primary tab that left the screen's origin has no marker of that screen.
    expect((await runOnFrames(code, "https://elsewhere.example/", frames)).located).toEqual([]);
  });

  it("checks at most 100 matches of a frame", async () => {
    const { page, calls } = recordingPage(true);
    await read({ page });
    const late = Array.from({ length: 150 }, (_, index) => index === 120);
    const { visible } = await runOnFrames(calls[0]?.code ?? "", `${site}/login`, [
      { url: `${site}/login`, visible: late },
    ]);
    expect(visible).toBe(false);
  });

  it("reads a missing recorded popup as no marker, and anything else as a failure", async () => {
    const missing = recordingPage({ error: "popup_missing", target: "popup" });
    expect(await read({ page: missing.page, popup })).toEqual(Exit.succeed(false));
    expect(missing.calls[0]?.code.startsWith(autofillPageCode("target-1", popup))).toBe(true);
    expect(await read({ page: recordingPage(true).page, popup })).toEqual(Exit.succeed(true));
    expect(Exit.isFailure(await read({ page: missing.page }))).toBe(true);
    expect(Exit.isFailure(await read({ page: recordingPage("yes").page }))).toBe(true);
  });
});
