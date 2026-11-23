import { Effect } from "effect";
import { expect, it } from "vitest";
import { withDialogAction } from "../../src/browser/dialogs/action.js";
import { DialogFailure } from "../../src/browser/dialogs/contracts.js";

it("retains native action failure when the independent cleanup channel also fails", async () => {
  const observed: string[] = [];
  const result = await Effect.runPromise(
    Effect.either(
      withDialogAction(
        {
          begin: () => Effect.void,
          end: (_page, _action, outcome) =>
            Effect.sync(() => {
              observed.push(outcome);
            }).pipe(Effect.zipRight(Effect.fail(new DialogFailure({ reason: "unauthorized" })))),
        },
        { pageId: "page", actionId: "action" },
        () => Promise.reject(new Error("private native error")),
      ),
    ),
  );
  expect(result).toMatchObject({ left: { reason: "unavailable" } });
  expect(observed).toEqual(["failed"]);
  expect(JSON.stringify(result)).not.toContain("private native error");
});
it("a completed native action with failed channel finalization is not reported as success", async () => {
  const result = await Effect.runPromise(
    Effect.either(
      withDialogAction(
        {
          begin: () => Effect.void,
          end: () => Effect.fail(new DialogFailure({ reason: "unavailable" })),
        },
        { pageId: "page", actionId: "action" },
        () => Promise.resolve("completed"),
      ),
    ),
  );
  expect(result).toMatchObject({ left: { reason: "unavailable" } });
});
