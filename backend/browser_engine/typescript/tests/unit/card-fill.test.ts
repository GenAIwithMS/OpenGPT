import { Effect, Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { inspectAutofillStep, untrustedTarget } from "../../src/destinations/autofill-step.js";
import type { AutofillStep, FillSlot } from "../../src/destinations/autofill-step.js";
import { makeRunCardHandles, runCardFill, scriptAnswers } from "../../src/destinations/card-fill.js";
import type { CardFillReview } from "../../src/destinations/card-fill.js";
import {
  isCardSlot,
  onPaymentFrameOrigin,
  paymentFrameOrigins,
} from "../../src/destinations/payment-frames.js";
import {
  guardianExecutionPolicy,
  nativeExecutionEnvironment,
} from "../../src/guardian/execution-policy.js";
import { ExecutionRequest } from "../../src/mint/contracts.js";
import { makeSecretHandles } from "../../src/mint/secret-handles.js";
import { makeRunSecrets, registerSecretAnswer } from "../../src/inputs/secrets.js";

const site = "https://www.restaurant.example";
const checkout = `${site}/reservations/checkout/?party_size=3`;
const stripeFrame =
  "https://js.stripe.com/v3/elements-inner-accessory-target-0000.html#__shared_params__[version]=v3";

/** A control as the page reports it before typing. */
const target = (ownerUrl: string) => ({
  ownerUrl,
  documentOrigin: new URL(ownerUrl).origin,
  actions: [],
  methods: [],
  editable: true,
  control: "text" as const,
  empty: true,
});
const described = (id: string, label: string, name: string, placeholder: string) => ({
  tag: "INPUT",
  role: null,
  formMethod: null,
  type: "text",
  name,
  id,
  autocomplete: null,
  inputmode: "numeric",
  label,
  placeholder,
  ariaLabel: null,
  text: null,
});
// Stripe's Payment Element as a restaurant checkout shows it: four fields in one js.stripe.com frame.
const stripeFields = [
  { selector: "#payment-numberInput", described: described("payment-numberInput", "Card number", "number", "1234 1234 1234 1234") },
  { selector: "#payment-expiryInput", described: described("payment-expiryInput", "Expiration date", "expiry", "MM / YY") },
  { selector: "#payment-cvcInput", described: described("payment-cvcInput", "Security code", "cvc", "CVC") },
  { selector: "#payment-postalCodeInput", described: described("payment-postalCodeInput", "ZIP code", "postalCode", "12345") },
];

/**
 * A primary tab whose first call answers the inspection, then each field's focus, then the read.
 * `swappedAt`, a call's number, answers that call with every field moved into `swappedTo`'s frame.
 */
const scriptedPage = (
  options: {
    readonly frameUrl?: string;
    readonly topUrl?: string;
    readonly ancestors?: readonly string[];
    readonly methods?: readonly string[];
    readonly explicitGet?: boolean;
    readonly swappedAt?: number;
    readonly swappedTo?: string;
    readonly swappedActions?: readonly string[];
  } = {},
) => {
  const calls: string[] = [];
  const frameUrl = options.frameUrl ?? stripeFrame;
  const topUrl = options.topUrl ?? checkout;
  const targets = (url: string) =>
    stripeFields.map((field) => ({
      target: {
        ...target(url),
        ...(options.ancestors === undefined ? {} : { ancestors: options.ancestors }),
        ...(options.methods === undefined ? {} : { methods: options.methods }),
        ...(options.explicitGet === undefined ? {} : { explicitGet: options.explicitGet }),
      },
      described: field.described,
    }));
  return {
    calls,
    page: {
      targetId: "primary",
      execute: (code: string) =>
        Effect.sync(() => {
          calls.push(code);
          if (calls.length === options.swappedAt)
            return {
              changed: {
                fields: targets(options.swappedTo ?? frameUrl).map(({ target: moved }) => ({
                  ...moved,
                  ...(options.swappedActions === undefined ? {} : { actions: options.swappedActions }),
                })),
                submit: null,
              },
              url: topUrl,
            };
          if (calls.length === 1)
            return { fields: targets(frameUrl), submit: null, buttons: [], url: topUrl };
          return calls.length <= 1 + stripeFields.length
            ? { focused: true, url: topUrl }
            : { submit: "none", url: topUrl };
        }),
    },
  };
};

const cardAnswers = {
  number: { type: "secret" as const, value: "4242 4242 4242 4242" },
  expiry: { type: "secret" as const, value: "12/34" },
  cvc: { type: "secret" as const, value: "123" },
  zip: { type: "secret" as const, value: "94110" },
  code: { type: "secret" as const, value: "551234" },
};
const cardKinds = {
  number: "card_number",
  expiry: "card_expiry",
  cvc: "card_cvc",
  zip: "billing_postal_code",
  code: "one_time_code",
} as const;
const issued = () => {
  const handles = makeSecretHandles();
  const answers = handles.issue(cardAnswers, cardKinds);
  const handle = (id: keyof typeof cardAnswers) => {
    const answer = answers[id];
    if (answer?.type !== "secret") throw new Error("Not a secret");
    return answer.value;
  };
  return { handles, handle };
};
const stripeStep = (handle: (id: keyof typeof cardAnswers) => string) => ({
  fields: [
    { selector: "#payment-numberInput", handle: handle("number") },
    { selector: "#payment-expiryInput", handle: handle("expiry") },
    { selector: "#payment-cvcInput", handle: handle("cvc") },
    { selector: "#payment-postalCodeInput", handle: handle("zip") },
  ],
});

const run = (
  options: {
    readonly frameUrl?: string;
    readonly topUrl?: string;
    readonly ancestors?: readonly string[];
    readonly methods?: readonly string[];
    readonly explicitGet?: boolean;
    readonly swappedAt?: number;
    readonly swappedTo?: string;
    readonly swappedActions?: readonly string[];
    readonly step?: (handle: (id: keyof typeof cardAnswers) => string) => {
      readonly fields: readonly { readonly selector: string; readonly handle: string }[];
    };
  } = {},
) => {
  const { handles, handle } = issued();
  const { page, calls } = scriptedPage(options);
  const typed: string[] = [];
  const reviews: CardFillReview[] = [];
  const fenced: string[] = [];
  const outcome = Effect.runPromise(
    runCardFill({
      step: (options.step ?? stripeStep)(handle),
      handles,
      page,
      keyboard: {
        insertText: (_target, text) =>
          Effect.sync(() => {
            typed.push(text);
            return "inserted" as const;
          }),
      },
      siteOrigin: site,
      review: (source) =>
        Effect.sync(() => {
          reviews.push(source);
        }),
      beforeTyping: () =>
        Effect.sync(() => {
          fenced.push("before typing");
        }),
    }),
  );
  return { outcome, typed, reviews, calls, fenced };
};

describe("payment frame origins", () => {
  it("lists exact https origins only", () => {
    for (const origin of paymentFrameOrigins) {
      const url = new URL(origin);
      expect(url.protocol).toBe("https:");
      expect(url.origin).toBe(origin);
      expect(origin).not.toContain("*");
    }
    expect(paymentFrameOrigins).toContain("https://js.stripe.com");
  });

  it.each([
    [stripeFrame, true],
    ["https://web.squarecdn.com/1.0/card.html", true],
    ["https://m.stripe.network/inner.html", false],
    ["https://pay.google.com/gp/p/ui/pay", false],
    ["https://evil.js.stripe.com/v3/elements.html", false],
    ["http://js.stripe.com/v3/elements.html", false],
    ["https://js.stripe.com:8443/v3/elements.html", false],
    ["https://user:pass@js.stripe.com/v3/elements.html", false],
  ])("judges %s on the list: %s", (url, listed) => {
    expect(onPaymentFrameOrigin(url)).toBe(listed);
  });

  it("names the four parts of a card", () => {
    expect(["card_number", "card_expiry", "card_cvc", "billing_postal_code"].every(isCardSlot)).toBe(
      true,
    );
    expect(isCardSlot("password")).toBe(false);
    expect(isCardSlot("zip")).toBe(false);
  });
});

describe("the card branch of the typing guard", () => {
  const trust = { siteOrigin: site, authenticationOrigins: [], paymentFrameOrigins };
  const step = (slot: FillSlot): AutofillStep<FillSlot> => ({
    fields: [{ selector: "#payment-numberInput", slot }],
  });

  it("trusts a card field in a listed payment frame", () => {
    expect(
      untrustedTarget({ fields: [target(stripeFrame)], submit: null }, step("card_number"), trust, 0),
    ).toBeUndefined();
  });

  it("never trusts a password field in a payment frame", () => {
    expect(
      untrustedTarget({ fields: [target(stripeFrame)], submit: null }, step("password"), trust, 0),
    ).toMatchObject({ outcome: "refused", reason: "credential_target_refused" });
  });

  it("refuses a card field in a frame off the list", () => {
    expect(
      untrustedTarget(
        { fields: [target("https://m.stripe.network/inner.html")], submit: null },
        step("card_number"),
        trust,
        0,
      ),
    ).toMatchObject({ outcome: "refused", reason: "credential_target_refused" });
  });

  it("refuses a card step whose page's top document is off the site", async () => {
    const { page } = scriptedPage({ topUrl: "https://checkout.stripe.com/c/pay/cs_test" });
    const inspected = await Effect.runPromise(
      inspectAutofillStep({
        step: step("card_number"),
        page,
        siteOrigin: site,
        authenticationOrigins: [],
        paymentFrameOrigins,
      }),
    );
    expect(inspected).toMatchObject({ outcome: "refused", reason: "credential_target_refused" });
    expect("failureDetail" in inspected ? inspected.failureDetail?.phase : undefined).toBe(
      "top_document",
    );
  });
});

describe("a card-fill step", () => {
  it("types each card answer into Stripe's fields, with only handles in the review and result", async () => {
    const { outcome, typed, reviews, fenced } = run();
    const result = await outcome;
    expect(result.status).toBe("filled");
    expect(typed).toEqual(["4242 4242 4242 4242", "12/34", "123", "94110"]);
    expect(fenced).toEqual(["before typing"]);
    expect(reviews).toHaveLength(1);
    const reviewed = JSON.stringify(reviews);
    expect(reviewed).toContain("{{secret.s1}}");
    expect(reviewed).toContain("card_number");
    expect(reviewed).toContain("Card number");
    for (const value of ["4242", "12/34", "94110"]) {
      expect(reviewed).not.toContain(value);
      expect(result.observations).not.toContain(value);
    }
  });

  it("refuses a handle that is not a card answer before any review", async () => {
    const { outcome, typed, reviews, calls } = run({
      step: (handle) => ({ fields: [{ selector: "#payment-numberInput", handle: handle("code") }] }),
    });
    const result = await outcome;
    expect(result.status).toBe("refused");
    expect(result.observations).toContain("{{secret.s5}} is not a card answer");
    expect(typed).toEqual([]);
    expect(reviews).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("refuses a selector that reaches into another frame", async () => {
    const { outcome, typed, reviews } = run({
      step: (handle) => ({
        fields: [{ selector: "iframe >> internal:control=enter-frame >> #number", handle: handle("number") }],
      }),
    });
    const result = await outcome;
    expect(result.status).toBe("refused");
    expect(result.observations).toContain("reaches into another frame");
    expect(typed).toEqual([]);
    expect(reviews).toEqual([]);
  });

  it("refuses card fields in a frame that is not a listed payment origin", async () => {
    const { outcome, typed, reviews } = run({ frameUrl: "https://evil-pay.example/card.html" });
    const result = await outcome;
    expect(result.status).toBe("refused");
    expect(result.observations).toContain("https://evil-pay.example");
    expect(typed).toEqual([]);
    expect(reviews).toEqual([]);
  });

  it("refuses a payment frame that a frame off the site wraps, naming that frame", async () => {
    const { outcome, typed, reviews } = run({ ancestors: ["https://wrapper.example"] });
    const result = await outcome;
    expect(result.status).toBe("refused");
    expect(JSON.parse(result.observations)).toEqual({
      cardFill: "refused",
      message: `The host typed nothing: field 1 is in a frame on https://wrapper.example. Card answers go only into this site's own page or a payment frame on ${paymentFrameOrigins.join(", ")}.`,
    });
    expect(typed).toEqual([]);
    expect(reviews).toEqual([]);
    // A frame on the site, or on the payment frame's own origin, may hold it.
    const nested = await run({ ancestors: ["https://js.stripe.com", site] }).outcome;
    expect(nested.status).toBe("filled");
  });

  it("refuses card fields on the site's own page in a form whose attribute says GET", async () => {
    const { outcome, typed } = run({ frameUrl: checkout, methods: ["get"], explicitGet: true });
    const result = await outcome;
    expect(result.status).toBe("refused");
    expect(result.observations).toContain("field 1's form sends by GET");
    expect(typed).toEqual([]);
    // A bare form reads as GET too, but nothing says so: a page submits it with its own code.
    expect((await run({ frameUrl: checkout, methods: ["get"] }).outcome).status).toBe("filled");
    expect(
      (await run({ frameUrl: checkout, methods: ["post"], explicitGet: false }).outcome).status,
    ).toBe("filled");
    // A payment frame's own form is the processor's, which posts nothing itself.
    expect((await run({ methods: ["get"], explicitGet: true }).outcome).status).toBe("filled");
  });

  it("keeps the reason of a change that moved no frame, such as where a form sends", async () => {
    const { outcome, typed } = run({
      swappedAt: 2,
      swappedActions: [`${site}/reservations/pay`],
    });
    const result = await outcome;
    expect(typed).toEqual([]);
    expect(result.status).toBe("refused");
    const refusal = JSON.parse(result.observations);
    expect(refusal).toMatchObject({ cardFill: "refused", field: 1 });
    expect(refusal.message).toBeUndefined();
  });

  it("types nothing more once a frame off the list is swapped in after the first field", async () => {
    // Call 1 inspects, call 2 types field 1, call 3 finds every field moved to another frame.
    const { outcome, typed } = run({ swappedAt: 3, swappedTo: "https://evil-pay.example/card.html" });
    const result = await outcome;
    expect(typed).toEqual(["4242 4242 4242 4242"]);
    expect(result).toMatchObject({ status: "failed", typed: true });
    expect(JSON.parse(result.observations)).toEqual({
      cardFill: "failed",
      fields: [
        { slot: "card_number", status: "filled" },
        { slot: "card_expiry", status: "failed" },
        { slot: "card_cvc", status: "not_attempted" },
        { slot: "billing_postal_code", status: "not_attempted" },
      ],
    });
  });

  it("names the listed origins when a field moves off the list before anything is typed", async () => {
    // Call 2, the first field's own call, finds every field moved to another frame.
    const { outcome, typed } = run({ swappedAt: 2, swappedTo: "https://evil-pay.example/card.html" });
    const result = await outcome;
    expect(typed).toEqual([]);
    expect(result.status).toBe("refused");
    expect(JSON.parse(result.observations).message).toBe(
      `The host typed nothing: field 1 is in a frame on https://evil-pay.example. Card answers go only into this site's own page or a payment frame on ${paymentFrameOrigins.join(", ")}.`,
    );
  });

  it("refuses when the page's top document is not on the site", async () => {
    const { outcome, typed, reviews } = run({ topUrl: "https://checkout.stripe.com/c/pay/x" });
    const result = await outcome;
    expect(result.status).toBe("refused");
    expect(result.observations).toContain("top document is not on this site");
    expect(typed).toEqual([]);
    expect(reviews).toEqual([]);
  });
});

describe("the execute request", () => {
  const request = {
    purpose: "card_fill",
    target: "liveBrowser",
    entrypoint: "operation/card-fill-step.json",
    fixtureRefs: [],
    caseFilter: [],
    maxWorkers: 1,
    timeoutSeconds: 60,
  };

  it("takes a card-fill step", () => {
    const decoded = Schema.decodeUnknownEither(ExecutionRequest)({
      ...request,
      cardFillStep: {
        fields: [
          { selector: "#payment-numberInput", handle: "{{secret.s1}}" },
          { selector: "#payment-cvcInput", handle: "{{secret.s3}}" },
        ],
      },
    });
    expect(Either.isRight(decoded)).toBe(true);
  });

  it("refuses a step that names one handle twice", () => {
    const decoded = Schema.decodeUnknownEither(ExecutionRequest)({
      ...request,
      cardFillStep: {
        fields: [
          { selector: "#payment-numberInput", handle: "{{secret.s1}}" },
          { selector: "#payment-cvcInput", handle: "{{secret.s1}}" },
        ],
      },
    });
    expect(Either.isLeft(decoded)).toBe(true);
  });
});

describe("Guardian's card-fill rule", () => {
  const policy = guardianExecutionPolicy(nativeExecutionEnvironment);

  it("lets a host card-fill step carry card data off the site", () => {
    expect(policy).toContain(
      "or account data), except the data-vendor read above and a host card-fill step the card-fill rule below allows.",
    );
  });

  it("keeps card handles out of source", () => {
    expect(policy).toContain(
      "or a field of a request to the authorized site. A card number, expiry, security code or billing postal code handle never goes into source: only a host card-fill step types one.",
    );
  });

  it("judges a host card-fill step against the host's own checks", () => {
    expect(policy).toContain(
      "\nA host card-fill step (currentExecution purpose card_fill, entrypoint operation/card-fill-step.json) is not source: the host types the caller's card answers, which you never see, into the fields the step names on the authorized site's page or inside one frame on it, and clicks nothing.",
    );
    expect(policy).toContain(
      "Typing the card is not the business write: the submit that books or buys still needs its declared write, commit mark, readback and a single submit under the write rules.\n",
    );
  });
});

describe("masking a card answer", () => {
  const masked = (kind: string, value: string) => {
    const secrets = makeRunSecrets();
    registerSecretAnswer(secrets, kind, value);
    return secrets;
  };

  it("masks a card number's digits whatever their grouping", () => {
    // Diners Club (14 digits, 4-6-4) and American Express (15 digits, 4-6-5).
    const diners = masked("card_number", "30569309025904");
    for (const shown of ["3056 930902 5904", "3056-930902-5904", "30569309025904", "3056 9309 0259 04", "305 693 090 259 04", "3056.930902.5904", "3056\u00a0930902\u00a05904"])
      expect(diners.redact(`Card ${shown} on file`)).toBe("Card [private] on file");
    const amex = masked("card_number", "3782 822463 10005");
    for (const shown of ["378282246310005", "3782-822463-10005", "3782 8224 6310 005"])
      expect(amex.redact(`Card ${shown}.`)).toBe("Card [private].");
  });

  it("masks a short card part only as a whole token, and never checks it in source", async () => {
    const secrets = makeRunSecrets();
    registerSecretAnswer(secrets, "card_cvc", "123");
    registerSecretAnswer(secrets, "billing_postal_code", "94110");
    registerSecretAnswer(secrets, "card_expiry", "12/34");
    expect(secrets.redact("Booking ZX1239 confirmed, CVC 123, ZIP 94110, expires 12/34.")).toBe(
      "Booking ZX1239 confirmed, CVC [private], ZIP [private], expires [private].",
    );
    expect(secrets.redact("Order 9411012 at 112/345")).toBe("Order 9411012 at 112/345");
    await Effect.runPromise(secrets.assertAbsent("await page.waitForTimeout(123);"));
  });

  it("still keeps a card number out of source", async () => {
    const secrets = masked("card_number", "4242424242424242");
    const result = await Effect.runPromise(
      Effect.either(secrets.assertAbsent('const shown = "4242 4242 4242 4242";')),
    );
    expect(Either.isLeft(result)).toBe(true);
  });
});

describe("a script's answers", () => {
  const asked = {
    id: "c0000000-0000-4000-8000-000000000001",
    source: "script" as const,
    questions: [
      {
        id: "card",
        type: "secret" as const,
        secretKind: "card_number" as const,
        prompt: "Card number",
      },
      { id: "code", type: "secret" as const, secretKind: "one_time_code" as const, prompt: "Code" },
      { id: "note", type: "text" as const, prompt: "Note" },
    ],
  };

  it("hands the script a handle for each card answer and every other answer as given", () => {
    const handles = makeRunCardHandles();
    const answers = scriptAnswers(
      asked,
      {
        card: { type: "secret", value: "4242424242424242" },
        code: { type: "secret", value: "123456" },
        note: { type: "text", value: "Leave at the door" },
      },
      handles,
    );
    expect(answers).toEqual({ card: "{{card.c1}}", code: "123456", note: "Leave at the door" });
    expect(handles.kindOf("{{card.c1}}")).toBe("card_number");
    expect(handles.cardValues(["{{card.c1}}"])).toEqual(["4242424242424242"]);
  });

  it("passes on an answer to a question the request does not hold", () => {
    expect(
      scriptAnswers(asked, { other: { type: "text", value: "kept" } }, makeRunCardHandles()),
    ).toEqual({ other: "kept" });
  });
});
