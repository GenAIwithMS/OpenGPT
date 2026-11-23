import { createHash } from "node:crypto";
import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  acceptedConfirmsKept,
  confirmActionUnmatched,
  expectedConfirmDigest,
  expectedConfirmLimit,
  keepAcceptedConfirm,
  makeExpectedConfirms,
  observedConfirmOf,
  recordConfirmSteps,
  type ObservedConfirm,
} from "../../src/browser/dialogs/expected.js";
import type { ExpectedConfirm } from "../../src/browser/dialogs/contracts.js";

const confirm = { type: "confirm" as const, candidateActionId: "place-order" };
const facts = { message: "Place this order?", pageUrl: "https://shop.example/cart?step=2" };

describe("observedConfirmOf", () => {
  it("keeps a confirm's normalized message, page origin and step", () => {
    expect(
      observedConfirmOf(confirm, { ...facts, message: "  Place\n this  order? " }),
    ).toEqual({ message: "Place this order?", origin: "https://shop.example", step: "place-order" });
  });

  it("never observes a popup a run could not expect", () => {
    const cases = [
      [{ ...confirm, type: "alert" as const }, facts],
      [{ ...confirm, type: "prompt" as const }, facts],
      [{ ...confirm, candidateActionId: null }, facts],
      [{ ...confirm, candidateActionId: "place order" }, facts],
      [{ ...confirm, candidateActionId: "x".repeat(101) }, facts],
      [confirm, { ...facts, pageUrl: "http://shop.example/cart" }],
      [confirm, { ...facts, pageUrl: "not a url" }],
      [confirm, { ...facts, message: " \n " }],
      [confirm, { ...facts, message: "x".repeat(2_001) }],
    ] as const;
    for (const [event, shown] of cases) expect(observedConfirmOf(event, shown)).toBeUndefined();
    expect(observedConfirmOf(confirm, { ...facts, message: "x".repeat(2_000) })).toBeDefined();
  });
});

describe("expectedConfirmDigest", () => {
  it("is the SHA-256 of the versioned message, origin and step, never the text itself", () => {
    const popup = { message: "Place this order?", origin: "https://shop.example", step: "s" };
    expect(expectedConfirmDigest(popup)).toEqual({
      digest: createHash("sha256")
        .update(JSON.stringify(["opengpt.expected_confirm.v1", popup.message, popup.origin, "s"]))
        .digest("hex"),
    });
    expect(JSON.stringify(expectedConfirmDigest(popup))).not.toContain("Place");
  });

  it("keeps the digest every published record stores, byte for byte", () => {
    // Records already published hold this value. A change to the tuple or its version would
    // stop every one of them from matching, so it must be a deliberate new version.
    expect(
      expectedConfirmDigest({
        message: "Place this order?",
        origin: "https://shop.example",
        step: "place-order",
      }),
    ).toEqual({ digest: "b3738440fab6186a8eb0c75a13ef8d8be5c289b629adb79da7fa5063920f3500" });
  });
});

describe("makeExpectedConfirms", () => {
  const record = expectedConfirmDigest({
    message: "Place this order?",
    origin: "https://shop.example",
    step: "place-order",
  });

  it("takes a matching popup once per record, whatever its whitespace", () => {
    const pool = makeExpectedConfirms([record]);
    expect(pool.take(confirm, { ...facts, message: "Place  this order?" })).toEqual(record);
    expect(pool.take(confirm, facts)).toBeUndefined();
    const twice = makeExpectedConfirms([record, record]);
    expect(twice.take(confirm, facts)).toEqual(record);
    expect(twice.take(confirm, facts)).toEqual(record);
  });

  it("matches no other message, case, origin, step or type", () => {
    const pool = makeExpectedConfirms([record]);
    expect(pool.take(confirm, { ...facts, message: "place this order?" })).toBeUndefined();
    expect(pool.take(confirm, { ...facts, message: "Place this order now?" })).toBeUndefined();
    expect(pool.take(confirm, { ...facts, pageUrl: "https://other.example/cart" })).toBeUndefined();
    expect(pool.take({ ...confirm, candidateActionId: "remove-item" }, facts)).toBeUndefined();
    expect(pool.take({ ...confirm, type: "alert" }, facts)).toBeUndefined();
    expect(pool.take(confirm, facts)).toEqual(record);
  });
});

describe("recording accepted confirms", () => {
  it("keeps only accepted confirms a run could expect, up to the limit", () => {
    const live: ObservedConfirm[] = [];
    keepAcceptedConfirm(live, { event: confirm, facts, decision: { choice: "dismiss" } });
    keepAcceptedConfirm(live, {
      event: { ...confirm, type: "alert" },
      facts,
      decision: { choice: "accept" },
    });
    keepAcceptedConfirm(live, { event: confirm, facts, decision: { choice: "accept" } });
    expect(live).toEqual([
      { message: "Place this order?", origin: "https://shop.example", step: "place-order" },
    ]);
    for (let index = 0; index < expectedConfirmLimit + 5; index += 1)
      keepAcceptedConfirm(live, { event: confirm, facts, decision: { choice: "accept" } });
    expect(live).toHaveLength(expectedConfirmLimit);
  });

  it("keeps a write's confirms unless screening finds a registered secret or fails", async () => {
    const accepted = [
      { message: "Place this order?", origin: "https://shop.example", step: "a" },
      { message: "Charge card 4242?", origin: "https://shop.example", step: "b" },
      { message: "Unscreened?", origin: "https://shop.example", step: "c" },
    ];
    const unscreened: string[] = [];
    const kept = (write: boolean) =>
      Effect.runPromise(
        acceptedConfirmsKept({
          write,
          accepted,
          screen: (message) =>
            message.includes("4242")
              ? Effect.fail("invalid_text")
              : message.startsWith("Unscreened")
                ? Effect.fail("closed_scope")
                : Effect.void,
          unscreened: (error) =>
            Effect.sync(() => {
              unscreened.push(error);
            }),
        }),
      );
    expect(await kept(false)).toEqual([]);
    expect(unscreened).toEqual([]);
    expect(await kept(true)).toEqual([accepted[0]]);
    expect(unscreened.toSorted()).toEqual(["closed_scope", "invalid_text"]);
  });

  it("adds a step's kept confirms to its write session as digests and step names", () => {
    const session = { acceptedConfirms: [] as ExpectedConfirm[], confirmSteps: new Set<string>() };
    const confirms = [
      { message: "Place this order?", origin: "https://shop.example", step: "place-order" },
      { message: "Really place it?", origin: "https://shop.example", step: "place-order" },
    ];
    recordConfirmSteps(session, confirms);
    expect(session.acceptedConfirms).toEqual(confirms.map(expectedConfirmDigest));
    expect([...session.confirmSteps]).toEqual(["place-order"]);
  });
});

describe("confirmActionUnmatched", () => {
  const check = (steps: readonly string[], sources: readonly string[]) =>
    Effect.runPromise(Effect.either(confirmActionUnmatched(steps, sources)));

  it("passes a composed write that names each confirm step as a quoted literal", async () => {
    expect(await check([], [])).toEqual(Either.right(undefined));
    expect(
      await check(
        ["place-order", "pay", "confirm_gift"],
        [`decideDialog({ step: "place-order" })`, "const step = 'pay';", "`confirm_gift`"],
      ),
    ).toEqual(Either.right(undefined));
  });

  it("refuses a composed write that does not, naming each missing step", async () => {
    const refused = await check(["place-order", "pay"], ["decideDialog({ step: placeOrder })"]);
    expect(Either.isLeft(refused) && refused.left).toMatchObject({
      _tag: "MintFailure",
      code: "PublicationUnavailable",
      reason: "confirm_action_unmatched",
      confirmActionIds: ["place-order", "pay"],
    });
  });
});

describe("confirms that name the run's record", () => {
  const step = {
    type: "confirm" as const,
    candidateActionId: "submit-document",
  };
  const page = "https://records.example/orders";
  interface Shown {
    readonly message: string;
    readonly input?: unknown;
    readonly url?: string;
    readonly step?: string;
  }
  const observed = (shown: Shown) => {
    const popup = observedConfirmOf(
      { ...step, candidateActionId: shown.step ?? step.candidateActionId },
      { message: shown.message, pageUrl: shown.url ?? page },
      shown.input,
    );
    if (popup === undefined) throw new Error("not observed");
    return popup;
  };
  /** The record a build keeps of a confirm it accepted while running with `input`. */
  const built = (shown: Shown) => expectedConfirmDigest(observed(shown));
  /** Whether a run with `input` accepts the popup from the build's record without asking. */
  const accepted = (record: ExpectedConfirm, shown: Shown) =>
    makeExpectedConfirms([record], shown.input).take(
      { ...step, candidateActionId: shown.step ?? step.candidateActionId },
      { message: shown.message, pageUrl: shown.url ?? page },
    ) !== undefined;

  const matching: readonly {
    readonly case: string;
    readonly build: Shown;
    readonly run: Shown;
  }[] = [
    {
      case: "a record named by the input",
      build: {
        message: "Finalize Spring Order 1001?",
        input: { name: "Spring Order 1001" },
      },
      run: {
        message: "Finalize Summer Order 2002?",
        input: { name: "Summer Order 2002" },
      },
    },
    {
      case: "the record named more than once",
      build: {
        message: "Delete Q-1001? Q-1001 and its lines cannot be restored.",
        input: { quote: "Q-1001" },
      },
      run: {
        message: "Delete Q-2002? Q-2002 and its lines cannot be restored.",
        input: { quote: "Q-2002" },
      },
    },
    {
      case: "several input values",
      build: {
        message: "Move 12 seats from Team Alpha to Team Beta?",
        input: { seats: 12, from: "Team Alpha", to: "Team Beta" },
      },
      run: {
        message: "Move 30 seats from Ops Crew to Field Crew?",
        input: { seats: 30, from: "Ops Crew", to: "Field Crew" },
      },
    },
    {
      case: "a value the site shows in another case",
      build: {
        message: "Archive ACME CORP?",
        input: { customer: "Acme Corp" },
      },
      run: {
        message: "Archive GLOBEX INC?",
        input: { customer: "globex inc" },
      },
    },
    {
      case: "a value with other whitespace than the message",
      build: {
        message: "Archive Acme Corp?",
        input: { customer: "  Acme\n  Corp " },
      },
      run: {
        message: "Archive  Globex\tInc?",
        input: { customer: "Globex Inc" },
      },
    },
    {
      case: "a value nested in the input",
      build: {
        message: "Ship SKU-1001 to Dock 4?",
        input: { order: { lines: [{ sku: "SKU-1001" }] } },
      },
      run: {
        message: "Ship SKU-2002 to Dock 4?",
        input: { order: { lines: [{ sku: "SKU-2002" }] } },
      },
    },
    {
      case: "a number in the input",
      build: { message: "Pay 125.5 now?", input: { amount: 125.5 } },
      run: { message: "Pay 340 now?", input: { amount: 340 } },
    },
    {
      case: "the record's identifier in the page path",
      build: {
        message: "Finalize ORD-2026-1001?",
        url: "https://records.example/orders/ORD-2026-1001",
      },
      run: {
        message: "Finalize ORD-2026-2002?",
        url: "https://records.example/orders/ORD-2026-2002",
      },
    },
    {
      case: "the record's identifier in the page query",
      build: {
        message: "Void invoice 4471?",
        url: "https://records.example/invoice?id=4471",
      },
      run: {
        message: "Void invoice 90210?",
        url: "https://records.example/invoice?id=90210",
      },
    },
    {
      case: "overlapping values",
      build: {
        message: "Close Acme Corp for Acme?",
        input: { account: "Acme Corp", group: "Acme" },
      },
      run: {
        message: "Close Globex Inc for Globex?",
        input: { account: "Globex Inc", group: "Globex" },
      },
    },
    {
      case: "a value with pattern characters",
      build: {
        message: "Delete (Acme) [Corp]*?",
        input: { name: "(Acme) [Corp]*" },
      },
      run: { message: "Delete a.b+c|d?", input: { name: "a.b+c|d" } },
    },
    {
      case: "a value that starts or ends the message",
      build: {
        message: "Spring Order 1001: submit it?",
        input: { name: "Spring Order 1001" },
      },
      run: {
        message: "Summer Order 2002: submit it?",
        input: { name: "Summer Order 2002" },
      },
    },
    {
      case: "a value in another Unicode form",
      build: {
        message: "Close Café Müller?",
        input: { name: "Cafe\u0301 Mu\u0308ller" },
      },
      run: { message: "Close Ölbar Zürich?", input: { name: "Ölbar Zürich" } },
    },
    {
      case: "a record named by both the input and the page",
      build: {
        message: "Submit SO-1001?",
        input: { name: "SO-1001" },
        url: "https://records.example/orders/SO-1001",
      },
      run: {
        message: "Submit SO-2002?",
        input: { name: "SO-2002" },
        url: "https://records.example/orders/SO-2002",
      },
    },
    {
      case: "a two-letter code the message only spells as words",
      build: {
        message: "Save changes in this form? Press OK to continue.",
        input: { state: "IN" },
      },
      run: { message: "Save changes in this form? Press OK to continue.", input: { state: "OK" } },
    },
    {
      case: "a three-letter code the message also spells in another case",
      build: { message: "Ship to CAN? You can change it later.", input: { country: "CAN" } },
      run: { message: "Ship to USA? You can change it later.", input: { country: "USA" } },
    },
    {
      case: "the same value in two fields",
      build: {
        message: "Merge Ann Lee into Ann Lee?",
        input: { from: "Ann Lee", into: "Ann Lee" },
      },
      run: {
        message: "Merge Bo Chen into Bo Chen?",
        input: { from: "Bo Chen", into: "Bo Chen" },
      },
    },
  ];

  it.each(matching)("accepts the same confirm about another record: $case", (scenario) => {
    const record = built(scenario.build);
    expect(accepted(record, scenario.run)).toBe(true);
    // The build's own popup matches too, and the record holds no page or input text.
    expect(accepted(record, scenario.build)).toBe(true);
    expect(JSON.stringify(record)).toMatch(/^\{"digest":"[0-9a-f]{64}"\}$/u);
  });

  const differing: readonly {
    readonly case: string;
    readonly build: Shown;
    readonly run: Shown;
  }[] = [
    {
      case: "other wording",
      build: {
        message: "Finalize Spring Order 1001?",
        input: { name: "Spring Order 1001" },
      },
      run: {
        message: "Void Summer Order 2002?",
        input: { name: "Summer Order 2002" },
      },
    },
    {
      case: "other wording beside the value",
      build: {
        message: "Submit Spring Order 1001?",
        input: { name: "Spring Order 1001" },
      },
      run: {
        message: "Submit Summer Order 2002 and email the customer?",
        input: { name: "Summer Order 2002" },
      },
    },
    {
      case: "a record the run was not asked about",
      build: {
        message: "Finalize Spring Order 1001?",
        input: { name: "Spring Order 1001" },
      },
      run: {
        message: "Finalize Winter Order 3003?",
        input: { name: "Summer Order 2002" },
      },
    },
    {
      case: "values in swapped roles",
      build: {
        message: "Move seats from Team Alpha to Team Beta?",
        input: { from: "Team Alpha", to: "Team Beta" },
      },
      run: {
        message: "Move seats from Team Alpha to Team Beta?",
        input: { from: "Team Beta", to: "Team Alpha" },
      },
    },
    {
      case: "a value under another field",
      build: {
        message: "Delete Spring Order 1001?",
        input: { name: "Spring Order 1001" },
      },
      run: {
        message: "Delete Summer Order 2002?",
        input: { title: "Summer Order 2002" },
      },
    },
    {
      case: "a one-character value, kept as page text",
      build: { message: "Add 1 seat to plan B?", input: { seats: "1" } },
      run: { message: "Add 2 seat to plan B?", input: { seats: "2" } },
    },
    {
      case: "wording a two-letter code would have spelled",
      build: { message: "Cancel or keep the plan?", input: { state: "OR" } },
      run: { message: "Cancel and keep the plan?", input: { state: "AND" } },
    },
    {
      case: "wording a three-letter code spells in another case",
      build: { message: "You can undo it?", input: { country: "CAN" } },
      run: { message: "You may undo it?", input: { country: "may" } },
    },
    {
      case: "an amount in the page query",
      build: { message: "Approve $50.00?", url: "https://records.example/pay?amount=50.00" },
      run: { message: "Approve $75.00?", url: "https://records.example/pay?amount=75.00" },
    },
    {
      case: "a value inside a longer word or number",
      build: { message: "Apply code 12 to order 120?", input: { code: "12" } },
      run: { message: "Apply code 34 to order 340?", input: { code: "34" } },
    },
    {
      case: "a page identifier the message does not name",
      build: {
        message: "Finalize ORD-2026-1001?",
        url: "https://records.example/orders/ORD-2026-1001",
      },
      run: {
        message: "Finalize ORD-2026-3003?",
        url: "https://records.example/orders/ORD-2026-2002",
      },
    },
    {
      case: "a page word that is no identifier",
      build: {
        message: "Delete this order?",
        url: "https://records.example/order/1001",
      },
      run: {
        message: "Delete this invoice?",
        url: "https://records.example/invoice/1001",
      },
    },
    {
      case: "a record the page does not show",
      build: {
        message: "Submit SO-1001?",
        input: { name: "SO-1001" },
        url: "https://records.example/orders/SO-1001",
      },
      run: {
        message: "Submit SO-2002?",
        input: { name: "SO-2002" },
        url: "https://records.example/orders/SO-3003",
      },
    },
    {
      case: "a value only a true or null field could explain",
      build: {
        message: "Mark Spring Order 1001 as true?",
        input: { name: "Spring Order 1001", rush: true },
      },
      run: {
        message: "Mark Summer Order 2002 as null?",
        input: { name: "Summer Order 2002", rush: null },
      },
    },
    {
      case: "another step",
      build: {
        message: "Submit Spring Order 1001?",
        input: { name: "Spring Order 1001" },
      },
      run: {
        message: "Submit Summer Order 2002?",
        input: { name: "Summer Order 2002" },
        step: "cancel-document",
      },
    },
    {
      case: "another origin",
      build: {
        message: "Submit Spring Order 1001?",
        input: { name: "Spring Order 1001" },
      },
      run: {
        message: "Submit Summer Order 2002?",
        input: { name: "Summer Order 2002" },
        url: "https://elsewhere.example/orders",
      },
    },
  ];

  it.each(differing)("asks about a confirm that differs: $case", (scenario) => {
    expect(accepted(built(scenario.build), scenario.run)).toBe(false);
  });

  it("keeps the exact digest for a confirm that names no value, and still matches it", () => {
    const exact = expectedConfirmDigest({
      message: "Place this order?",
      origin: "https://shop.example",
      step: "place-order",
    });
    const shown = {
      message: "Place this order?",
      pageUrl: "https://shop.example/cart?step=2",
    };
    const popup = observedConfirmOf(confirm, shown, { note: "gift" });
    expect(popup === undefined ? undefined : expectedConfirmDigest(popup)).toEqual(exact);
    expect(makeExpectedConfirms([exact], { note: "gift" }).take(confirm, shown)).toEqual(exact);
  });

  it("still matches a record published before, the same message naming the same value", () => {
    const shown = {
      message: "Delete Acme Corp?",
      pageUrl: "https://shop.example/customers",
    };
    const published = expectedConfirmDigest({
      message: "Delete Acme Corp?",
      origin: "https://shop.example",
      step: "place-order",
    });
    expect(
      makeExpectedConfirms([published], { customer: "Acme Corp" }).take(confirm, shown),
    ).toEqual(published);
    expect(
      makeExpectedConfirms([published], { customer: "Globex Inc" }).take(confirm, {
        ...shown,
        message: "Delete Globex Inc?",
      }),
    ).toBeUndefined();
  });

  it("keeps the build's input with each accepted confirm it records", () => {
    const live: ObservedConfirm[] = [];
    const shown = { message: "Submit Spring Order 1001?", pageUrl: page };
    keepAcceptedConfirm(live, {
      event: step,
      facts: shown,
      decision: { choice: "accept" },
      input: { name: "Spring Order 1001" },
    });
    expect(live.map(expectedConfirmDigest)).toEqual([
      built({
        message: "Submit Spring Order 1001?",
        input: { name: "Spring Order 1001" },
      }),
    ]);
    expect(live.map(expectedConfirmDigest)).not.toEqual([
      built({ message: "Submit Spring Order 1001?" }),
    ]);
  });

  it("reads a bounded number of input values and stays exact with a large input", () => {
    const many = Object.fromEntries(
      Array.from({ length: 1_000 }, (_, index) => [`field${index}`, `value ${index}`]),
    );
    const record = built({ message: "Submit value 3?", input: many });
    expect(accepted(record, { message: "Submit value 3?", input: many })).toBe(true);
    expect(accepted(record, { message: "Submit value 4?", input: many })).toBe(false);
    // A value past the bound stays page text.
    expect(built({ message: "Submit value 900?", input: many })).toEqual(
      built({ message: "Submit value 900?" }),
    );
  });

  it("takes each record once, whichever digest it holds", () => {
    const name = {
      message: "Submit Spring Order 1001?",
      input: { name: "Spring Order 1001" },
    };
    const records = [built(name), built({ message: "Submit it?" })];
    const pool = makeExpectedConfirms(records, { name: "Summer Order 2002" });
    const shown = (message: string) => pool.take(step, { message, pageUrl: page });
    expect(shown("Submit Summer Order 2002?")).toEqual(records[0]);
    expect(shown("Submit Summer Order 2002?")).toBeUndefined();
    expect(shown("Submit it?")).toEqual(records[1]);
    expect(shown("Submit it?")).toBeUndefined();
  });
});
