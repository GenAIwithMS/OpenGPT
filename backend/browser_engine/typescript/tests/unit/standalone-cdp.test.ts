import { Effect } from "effect";
import { expect, it } from "vitest";
import * as engine from "../../src/standalone/index.js";

it("the local host refuses to attach over CDP, since its runs reset a browser's tabs and site data", async () => {
  const created = await Effect.runPromise(
    Effect.scoped(
      Effect.either(
        engine.createBrowserEngine({
          ask: () => Effect.die(new Error("never asked")),
          browser: { cdp: { url: "ws://127.0.0.1:9/never" } },
        } as Parameters<typeof engine.createBrowserEngine>[0]),
      ),
    ),
  );
  expect(created).toMatchObject({
    _tag: "Left",
    left: { message: expect.stringContaining("doesn't attach over CDP") },
  });
});
