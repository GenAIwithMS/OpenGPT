import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { Effect } from "effect";
import { runCardFill, type CardFillReview } from "../../src/destinations/card-fill.js";
import { makeSecretHandles } from "../../src/mint/secret-handles.js";
import { expectNotCarried, hostKeyboard, hostPage } from "./autofill-host-page.js";

const site = "https://shop.example.test";
const card = {
  number: "4242 4242 4242 4242",
  expiry: "12 / 34",
  cvc: "123",
  zip: "94110",
};
// The fields of a processor's card frame, as Stripe's Payment Element names them.
const cardForm = `<label for="payment-numberInput">Card number</label><input id="payment-numberInput" name="number" autocomplete="cc-number" inputmode="numeric" placeholder="1234 1234 1234 1234">
<label for="payment-expiryInput">Expiration date</label><input id="payment-expiryInput" name="expiry" autocomplete="cc-exp" placeholder="MM / YY">
<label for="payment-cvcInput">Security code</label><input id="payment-cvcInput" name="cvc" autocomplete="cc-csc" placeholder="CVC">
<label for="payment-postalCodeInput">ZIP code</label><input id="payment-postalCodeInput" name="postalCode" autocomplete="billing postal-code" placeholder="12345">`;
const selectors = [
  "#payment-numberInput",
  "#payment-expiryInput",
  "#payment-cvcInput",
  "#payment-postalCodeInput",
];

// A separate process is essential here: Chromium must scope the resolved native node to its OOPIF.
test.use({ launchOptions: { args: ["--site-per-process"] } });

/** A checkout at `top` whose card fields sit in a frame served from `frameOrigin`. */
const checkout = async (page: Page, top: string, frameOrigin: string) => {
  await page.route(`${new URL(top).origin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<h1>Checkout</h1><iframe title="Secure payment input frame" src="${frameOrigin}/v3/elements-inner.html"></iframe>`,
    }),
  );
  await page.route(`${frameOrigin}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: cardForm }),
  );
  await page.goto(top);
  const frame = page.frames().find((candidate) => candidate.url().startsWith(frameOrigin));
  if (!frame) throw new Error("Fixture frame missing");
  await frame.locator("#payment-numberInput").waitFor();
  return frame;
};

const fill = async (page: Page) => {
  const handles = makeSecretHandles();
  const answers = handles.issue(
    {
      number: { type: "secret", value: card.number },
      expiry: { type: "secret", value: card.expiry },
      cvc: { type: "secret", value: card.cvc },
      zip: { type: "secret", value: card.zip },
    },
    { number: "card_number", expiry: "card_expiry", cvc: "card_cvc", zip: "billing_postal_code" },
  );
  const handleFor = (id: string) => {
    const answer = answers[id];
    if (answer?.type !== "secret") throw new Error("Not a secret");
    return answer.value;
  };
  const host = await hostPage(page);
  const { keyboard } = await hostKeyboard(page);
  const reviews: CardFillReview[] = [];
  const outcome = await Effect.runPromise(
    runCardFill({
      step: {
        fields: ["number", "expiry", "cvc", "zip"].map((id, index) => ({
          selector: selectors[index] ?? "",
          handle: handleFor(id),
        })),
      },
      handles,
      page: host,
      keyboard,
      siteOrigin: site,
      review: (source) =>
        Effect.sync(() => {
          reviews.push(source);
        }),
      beforeTyping: () => Effect.void,
    }),
  );
  return { outcome, reviews, calls: host.calls };
};

test("types a card into a payment processor's frame on the site's checkout", async ({ page }) => {
  const frame = await checkout(page, `${site}/checkout`, "https://js.stripe.com");
  const { outcome, reviews, calls } = await fill(page);
  expect(outcome.status).toBe("filled");
  expect(await Promise.all(selectors.map((selector) => frame.locator(selector).inputValue()))).toEqual(
    Object.values(card),
  );
  // Guardian saw the frame's labels and handles; no value reached a page call, Guardian or the result.
  expect(reviews).toHaveLength(1);
  expect(reviews[0]?.screen.origin).toBe("https://js.stripe.com");
  expect(reviews[0]?.screen.fields.map((field) => field.label)).toEqual([
    "Card number",
    "Expiration date",
    "Security code",
    "ZIP code",
  ]);
  for (const value of [card.number, card.expiry, card.zip]) {
    expectNotCarried(calls, value);
    expect(JSON.stringify(reviews)).not.toContain(value);
    expect(outcome.observations).not.toContain(value);
  }
});

test("types nothing into a frame on an origin off the list", async ({ page }) => {
  const frame = await checkout(page, `${site}/checkout`, "https://pay.example.org");
  const { outcome, reviews } = await fill(page);
  expect(outcome.status).toBe("refused");
  expect(outcome.observations).toContain("https://pay.example.org");
  expect(reviews).toEqual([]);
  expect(await frame.locator("#payment-numberInput").inputValue()).toBe("");
});

test("types nothing when the page's top document left the site", async ({ page }) => {
  const frame = await checkout(page, "https://checkout.example.org/pay", "https://js.stripe.com");
  const { outcome, reviews } = await fill(page);
  expect(outcome.status).toBe("refused");
  expect(outcome.observations).toContain("top document is not on this site");
  expect(reviews).toEqual([]);
  expect(await frame.locator("#payment-numberInput").inputValue()).toBe("");
});

test("types nothing into a payment frame that a frame off the site wraps", async ({ page }) => {
  const wrapper = "https://wrapper.example.org";
  await page.route(`${site}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<h1>Checkout</h1><iframe title="Checkout widget" src="${wrapper}/widget.html"></iframe>`,
    }),
  );
  await page.route(`${wrapper}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<iframe title="Secure payment input frame" src="https://js.stripe.com/v3/elements-inner.html"></iframe>`,
    }),
  );
  await page.route("https://js.stripe.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: cardForm }),
  );
  await page.goto(`${site}/checkout`);
  const frame = page.frames().find((candidate) => candidate.url().startsWith("https://js.stripe.com"));
  if (!frame) throw new Error("Fixture frame missing");
  await frame.locator("#payment-numberInput").waitFor();
  const { outcome, reviews } = await fill(page);
  expect(outcome.status).toBe("refused");
  expect(outcome.observations).toContain("field 1 is in a frame on https://wrapper.example.org");
  expect(reviews).toEqual([]);
  expect(await frame.locator("#payment-numberInput").inputValue()).toBe("");
});

/** A checkout whose card fields sit on the site's own page, inside `form`. */
const ownPage = async (page: Page, form: string) => {
  await page.route(`${site}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: `<h1>Checkout</h1>${form}${cardForm}</form>` }),
  );
  await page.goto(`${site}/checkout`);
  await page.locator("#payment-numberInput").waitFor();
};

test("types into card fields on the site's own page in a form that names no method", async ({ page }) => {
  await ownPage(page, "<form>");
  const { outcome } = await fill(page);
  expect(outcome.status).toBe("filled");
});

test("types nothing into card fields on the site's own page in a form that says GET", async ({ page }) => {
  await ownPage(page, '<form method="GET" action="/pay">');
  const { outcome, reviews } = await fill(page);
  expect(outcome.status).toBe("refused");
  expect(outcome.observations).toContain("field 1's form sends by GET");
  expect(reviews).toEqual([]);
  expect(await page.locator("#payment-numberInput").inputValue()).toBe("");
});
